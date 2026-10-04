/**
 * SQLite Database Backup / Restore via Cloudflare R2
 *
 * POST /api/storage/db-backup           — snapshot SQLite → R2 (backup)
 * POST /api/storage/db-backup?action=restore — R2 → SQLite (restore)
 * GET  /api/storage/db-backup           — list available backups
 *
 * WHY THIS EXISTS
 * ---------------
 * The app's local SQLite database holds document processing state (Document,
 * LocalEntity, LocalRelationship, LocalResolvedEntity, JobQueue) that is NOT
 * covered by the Supabase sync (which only backs up chat/agent tables).
 * When the sandbox resets, the SQLite file is wiped, and — short of re-running
 * the expensive LLM extraction — there is no way to restore that state.
 *
 * This endpoint performs a full binary snapshot of the SQLite DB that Prisma
 * has OPEN (resolved live via `PRAGMA database_list` — never guessed):
 *   1. Preferred: `VACUUM INTO /tmp/tmo-backup-<ts>.db` — SQLite's canonical
 *      online-backup: consistent standalone file that already includes any
 *      WAL frames, no torn reads, no dependency on checkpoint success.
 *   2. Fallback (VACUUM INTO unavailable): `PRAGMA wal_checkpoint(TRUNCATE)`
 *      via $queryRawUnsafe + read the main .db file directly.
 *   3. Upload buffer to R2 at backups/sqlite/custom-<ISO-timestamp>.db
 *      (history) AND backups/sqlite/custom.db (latest — overwritten each time)
 *
 * Restore reverses the process: download from R2 → overwrite the live DB path.
 * The app must be restarted after restore so Prisma re-opens the new file.
 *
 * ROUND-32 P0-1/P0-2 — what was broken before (do not reintroduce):
 *   - DB_PATH was GUESSED by regex-rewriting process.env.DATABASE_URL with a
 *     stale hardcode `/home/z/my-project/db/` (era when the app lived there):
 *     raw relative URLs produced a nonexistent `db/db/custom.db`, the fallback
 *     pointed at the SCAFFOLD project's DB, and an env-leak (shell exporting a
 *     DATABASE_URL that exists) made the app + this route operate on the
 *     scaffold DB silently. Now the path is ASKED from SQLite itself.
 *   - checkpointWal called $executeRawUnsafe as a TAGGED TEMPLATE — Prisma
 *     threw every single time (caught + logged "non-fatal") so the WAL was
 *     NEVER checkpointed and snapshots were silently stale.
 *
 * Use cases:
 *   - Before a sandbox reset: POST to snapshot the DB.
 *   - After a fresh setup: POST ?action=restore to bring the DB back.
 *   - Periodic safety: cron POST once a day.
 *
 * Idempotent: re-running backup overwrites the "latest" pointer and adds a
 * new timestamped version. Restore always pulls the "latest" pointer unless
 * a specific version key is supplied via ?key=backups/sqlite/custom-<ts>.db.
 */
import { NextRequest, NextResponse } from 'next/server'
import { promises as fs } from 'fs'
import fsSync from 'fs'
import path from 'path'
import os from 'os'
import { createHash } from 'crypto'
import { uploadToR2, downloadFileFromR2, listR2Objects, isR2Configured } from '@/lib/r2-storage'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

const R2_LATEST_KEY = 'backups/sqlite/custom.db'
const R2_PREFIX = 'backups/sqlite/'

// ==================== P0-1: PATH RESOLUTION — HỎI SQLITE, KHÔNG ĐOÁN ====================

/**
 * Hỏi chính SQLite file nào connection đang mở (row 'main', cột 'file').
 * PRAGMA database_list trả path tuyệt đối đúng 100% với file Prisma đang
 * giữ — không phụ thuộc env, CWD, regex hay hardcode.
 */
async function resolveLiveDbPath(): Promise<string | null> {
  try {
    const rows = await db.$queryRawUnsafe<Array<{ name: string; file: string | null }>>(
      'PRAGMA database_list'
    )
    const main = rows.find(r => r.name === 'main')
    const file = main?.file?.trim()
    return file || null // :memory: DB trả chuỗi rỗng → null
  } catch (err) {
    console.warn(
      '[DB-Backup] PRAGMA database_list failed:',
      err instanceof Error ? err.message : String(err)
    )
    return null
  }
}

/**
 * ROUND-35 (A-2 — rà soát lượt 2): trích findProjectRoot dùng chung.
 * Bản cũ lồng logic này trong fallbackDbPath nên caller khác không dùng lại được.
 */
function findProjectRoot(): string | null {
  let root = process.cwd()
  for (let i = 0; i < 6 && !fsSync.existsSync(path.join(root, 'prisma', 'schema.prisma')); i++) {
    root = path.dirname(root)
  }
  return fsSync.existsSync(path.join(root, 'prisma', 'schema.prisma')) ? root : null
}

/**
 * Fallback: suy ra path theo đúng chuẩn hoá của src/lib/db.ts (schema-relative
 * `file:../db/custom.db` → <projectRoot>/db/custom.db). Chỉ chấp nhận khi file
 * TỒN TẠI và NẰM TRONG project root — chống mọi biến thể trỏ ra ngoài (scaffold
 * của project khác, trap DATABASE_URL từ shell...).
 */
function fallbackDbPath(): string | null {
  try {
    // findProjectRoot — cùng logic db.ts: đi lên tối đa 6 cấp tìm prisma/schema.prisma
    const root = findProjectRoot()
    if (!root) return null

    // Đọc DATABASE_URL từ .env của project (nguồn sự thật — không tin env kế thừa)
    let envUrl = ''
    try {
      const envText = fsSync.readFileSync(path.join(root, '.env'), 'utf8')
      const m = envText.match(/^\s*(?:export\s+)?DATABASE_URL\s*=\s*(.+)$/m)
      if (m) envUrl = m[1].trim().replace(/\s+#.*$/, '').replace(/^['"]|['"]$/g, '')
    } catch { /* .env không tồn tại → dùng default chuẩn của project */ }
    const raw = (envUrl || 'file:../db/custom.db').replace(/^file:/, '')

    const p = path.isAbsolute(raw) ? raw : path.resolve(path.join(root, 'prisma'), raw)
    const inProject = p === root || p.startsWith(root + path.sep)
    return inProject && fsSync.existsSync(p) ? p : null
  } catch {
    return null
  }
}

/**
 * Resolve path DB + CHỐT CHẶN P0-1: từ chối thao tác khi live path không khớp
 * path .env của project (kịch bản env-leak: shell xuất DATABASE_URL trỏ DB của
 * project KHÁC có tồn tại → env-leak-guard trong db.ts giữ nguyên → app mở nhầm
 * DB đó — backup/restore lúc này là thao tác trên DB SAI, phải dừng lại rõ ràng
 * thay vì im lặng).
 */
async function resolveAndVerifyDbPath(): Promise<
  { ok: true; dbPath: string } | { ok: false; error: string }
> {
  const livePath = await resolveLiveDbPath()
  const fallbackPath = fallbackDbPath()

  if (livePath && fallbackPath && livePath !== fallbackPath) {
    return {
      ok: false,
      error:
        `DB path mismatch: Prisma đang mở "${livePath}" nhưng .env của project trỏ "${fallbackPath}". ` +
        'Từ chối backup/restore để tránh thao tác trên DB sai (kịch bản env-leak DATABASE_URL — chạy app qua `pm2-start.sh` đã unset DATABASE_URL, hoặc kiểm tra env shell).',
    }
  }

  // ROUND-35 (A-2): lỗ guard khi fallbackPath NULL — mismatch-guard bản cũ chỉ
  // so khớp khi CẢ HAI path sống. Khi DB theo .env CHƯA tồn tại (reset sạch,
  // chưa db:deploy) + shell trap env-leak (DATABASE_URL scaffold) → livePath =
  // DB scaffold, fallback = null → guard im lặng, route thao tác DB ngoài project.
  // Giờ: livePath nằm NGOÀI project root mà .env project không xác nhận được
  // path đó → từ chối thẳng (kịch bản đúng chính là trap — DB thật luôn nằm
  // trong <projectRoot>/db/).
  if (livePath && !fallbackPath) {
    const root = findProjectRoot()
    if (root && livePath !== root && !livePath.startsWith(root + path.sep)) {
      return {
        ok: false,
        error:
          `DB path ngoài project: Prisma đang mở "${livePath}" — nằm ngoài project root "${root}" và .env của project không trỏ tới nó (fallback không xác nhận được). ` +
          'Từ chối backup/restore: khả năng cao app đang mở nhầm DB của project khác qua env-leak DATABASE_URL (chạy qua `pm2-start.sh` đã unset DATABASE_URL).',
      }
    }
  }

  const dbPath = livePath ?? fallbackPath
  if (!dbPath) {
    return {
      ok: false,
      error: 'Không xác định được path SQLite DB (PRAGMA database_list và fallback đều thất bại).',
    }
  }
  return { ok: true, dbPath }
}

// ==================== P0-2: WAL CHECKPOINT — SỐNG LẠI ====================

/**
 * Flush WAL vào file .db chính. Phải gọi qua $queryRawUnsafe với STRING THƯỜNG:
 *   - Bản cũ gọi dạng tagged-template `` db.$executeRawUnsafe`PRAGMA ...` `` —
 *     truyền TemplateStringsArray thay vì string → Prisma throw MỌI lần →
 *     catch "non-fatal" → WAL chưa bao giờ được checkpoint (bug P0-2).
 *   - Dùng $queryRawUnsafe (không phải $executeRawUnsafe) vì PRAGMA này TRẢ
 *     RESULT SET {wal, checkpointed, busy} — executeRaw mong đợi affected-rows.
 */
async function checkpointWal(): Promise<{ checkpointed: boolean; busy: boolean }> {
  try {
    let rows = await db.$queryRawUnsafe<Array<{ wal: number; checkpointed: number; busy: number }>>(
      'PRAGMA wal_checkpoint(TRUNCATE)'
    )
    let busy = !!rows?.[0]?.busy
    if (busy) {
      // Có reader chặn checkpoint toàn phần — thử lại 1 lần sau 500ms
      await new Promise(r => setTimeout(r, 500))
      const retry = await db.$queryRawUnsafe<Array<{ busy: number }>>('PRAGMA wal_checkpoint(TRUNCATE)')
      busy = !!retry?.[0]?.busy
    }
    if (!busy) {
      console.log('[DB-Backup] WAL checkpointed (TRUNCATE)')
    } else {
      console.warn('[DB-Backup] WAL checkpoint busy 2 lần — snapshot direct-read có thể thiếu frame WAL cuối (VACUUM INTO không bị ảnh hưởng)')
    }
    return { checkpointed: !busy, busy }
  } catch (err) {
    console.warn(
      '[DB-Backup] WAL checkpoint failed (non-fatal — VACUUM INTO không phụ thuộc checkpoint):',
      err instanceof Error ? err.message : String(err)
    )
    return { checkpointed: false, busy: false }
  }
}

// ==================== SNAPSHOT (P0-2 nâng cấp: VACUUM INTO) ====================

/**
 * Chụp buffer snapshot nhất quán của DB:
 *  - Ưu tiên VACUUM INTO: file độc lập mới, TỰ GỘP frame WAL, không torn-read,
 *    không khoá DB, không phụ thuộc checkpoint thành công (SQLite ≥ 3.27).
 *  - Fallback: checkpointWal + đọc thẳng file chính (hành vi bản cũ — đã đúng
 *    hơn sau khi P0-2 sửa checkpoint sống lại).
 */
async function snapshotDbToBuffer(dbPath: string): Promise<{
  buffer: Buffer
  method: 'vacuum_into' | 'direct_read'
  walCheckpointed: boolean
}> {
  const tmpSnapshot = path.join(os.tmpdir(), `tmo-backup-${Date.now()}-${process.pid}.db`)
  try {
    // Escape quote theo chuẩn SQL string literal (path /tmp thực tế không có,
    // nhưng escape đúng luật — không bao giờ nối chuỗi SQL thô khi có thể)
    const escaped = tmpSnapshot.replaceAll("'", "''")
    await db.$executeRawUnsafe(`VACUUM INTO '${escaped}'`)
    const buffer = await fs.readFile(tmpSnapshot)
    return { buffer, method: 'vacuum_into', walCheckpointed: true }
  } catch (vacuumErr) {
    console.warn(
      '[DB-Backup] VACUUM INTO failed — fallback checkpoint + direct read:',
      vacuumErr instanceof Error ? vacuumErr.message : String(vacuumErr)
    )
    const wal = await checkpointWal()
    const buffer = await fs.readFile(dbPath)
    return { buffer, method: 'direct_read', walCheckpointed: wal.checkpointed }
  } finally {
    await fs.unlink(tmpSnapshot).catch(() => { /* dọn file tạm best-effort */ })
  }
}

/** POST: backup (default) or restore (?action=restore). */
export async function POST(request: NextRequest) {
  if (!isR2Configured()) {
    return NextResponse.json(
      { error: 'R2 not configured. Set R2_ACCESS_KEY_ID + R2_SECRET_ACCESS_KEY + R2_ENDPOINT in .env' },
      { status: 503 }
    )
  }

  const action = request.nextUrl.searchParams.get('action') || 'backup'
  const versionKey = request.nextUrl.searchParams.get('key')

  try {
    // P0-1: resolve + verify path MỖI lần gọi (route force-dynamic; PRAGMA rẻ)
    const resolved = await resolveAndVerifyDbPath()
    if (!resolved.ok) {
      return NextResponse.json({ error: resolved.error }, { status: 500 })
    }
    const DB_PATH = resolved.dbPath
    const DB_DIR = path.dirname(DB_PATH)

    // === BACKUP ===
    if (action === 'backup') {
      // 1-2. Snapshot nhất quán (VACUUM INTO ưu tiên — xem snapshotDbToBuffer)
      const { buffer, method, walCheckpointed } = await snapshotDbToBuffer(DB_PATH)

      // 3. Ensure DB directory exists (it always should, but be safe)
      await fs.mkdir(DB_DIR, { recursive: true })

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
      const versionedKey = `${R2_PREFIX}custom-${timestamp}.db`
      const sizeLabel = `${(buffer.length / 1024 / 1024).toFixed(2)} MB`

      // 4. Upload timestamped version (history — never overwritten)
      const versionedResult = await uploadToR2(
        versionedKey,
        buffer,
        'application/octet-stream'
      )
      if (!versionedResult.success) {
        return NextResponse.json(
          { error: 'R2 upload failed', detail: versionedResult.error },
          { status: 500 }
        )
      }

      // 5. Upload "latest" pointer (overwritten each time — used by restore)
      const latestResult = await uploadToR2(
        R2_LATEST_KEY,
        buffer,
        'application/octet-stream'
      )

      if (!latestResult.success) {
        return NextResponse.json(
          { error: 'R2 upload failed', detail: latestResult.error },
          { status: 500 }
        )
      }

      console.log(
        `[DB-Backup] Snapshot saved (${method}): ${versionedKey} (${sizeLabel}) + latest pointer`
      )

      // ROUND-32 P3-c — VERIFY NỘI TUYẾN: tải lại bản VỪA upload (latest pointer)
      // rồi so sha256 + kiểm SQLite header magic (16 byte chuẩn "SQLite format 3\0").
      // Backup ĐÃ upload thành công nên verify fail KHÔNG làm request fail — chỉ
      // lộ cảnh báo rõ ràng trong response để vận hành thấy ngay (tin vào backup
      // chưa từng được kiểm chứng là con đường đã từng phí TMO cả giấc ngủ).
      let verify: {
        roundTripOk: boolean
        sha256Match: boolean
        sqliteHeaderOk: boolean
        detail?: string
      } = { roundTripOk: false, sha256Match: false, sqliteHeaderOk: false }
      try {
        const expectedSha = createHash('sha256').update(buffer).digest('hex')
        const tmpVerify = path.join(os.tmpdir(), `tmo-backup-verify-${Date.now()}-${process.pid}.db`)
        try {
          const dl = await downloadFileFromR2(R2_LATEST_KEY, tmpVerify)
          if (dl.success) {
            const downloaded = await fs.readFile(tmpVerify)
            const actualSha = createHash('sha256').update(downloaded).digest('hex')
            const SQLITE_MAGIC = Buffer.from('SQLite format 3\0', 'binary')
            verify = {
              roundTripOk: downloaded.length === buffer.length,
              sha256Match: actualSha === expectedSha,
              sqliteHeaderOk: downloaded.length >= 100 && downloaded.subarray(0, 16).equals(SQLITE_MAGIC),
              detail: `sha256=${actualSha.slice(0, 16)}…, ${downloaded.length} bytes tải về`,
            }
          } else {
            verify = { roundTripOk: false, sha256Match: false, sqliteHeaderOk: false, detail: `tải về thất bại: ${dl.error ?? 'unknown'}` }
          }
        } finally {
          await fs.unlink(tmpVerify).catch(() => { /* dọn file tạm best-effort */ })
        }
        if (verify.sha256Match && verify.sqliteHeaderOk) {
          console.log(`[DB-Backup] Verify PASS: round-trip sha256 khớp + SQLite header hợp lệ (${verify.detail})`)
        } else {
          console.error(`[DB-Backup] ⚠️ VERIFY FAIL — backup có thể hỏng: ${JSON.stringify(verify)}`)
        }
      } catch (verifyErr) {
        verify = { roundTripOk: false, sha256Match: false, sqliteHeaderOk: false, detail: verifyErr instanceof Error ? verifyErr.message : String(verifyErr) }
        console.warn('[DB-Backup] Verify step error (non-fatal):', verify.detail)
      }

      return NextResponse.json({
        success: true,
        action: 'backup',
        timestamp,
        versionedKey,
        latestKey: R2_LATEST_KEY,
        sizeBytes: buffer.length,
        sizeLabel,
        dbPath: DB_PATH,
        snapshotMethod: method,
        walCheckpointed,
        verify,
        ...(verify.sha256Match && verify.sqliteHeaderOk
          ? {}
          : { warning: `Backup verify FAILED: ${JSON.stringify(verify)} — kiểm tra R2/network trước khi tin vào bản này` }),
      })
    }

    // === RESTORE ===
    //
    // ROUND-35 (A-1 — rà soát lượt 2): restore là thao tác DUY NHẤT phá DB chạy
    // thật. Bản cũ có 3 khuyết điểm:
    //   (a) tải về ghi ĐÈ thẳng DB_PATH (truncate in-place cùng inode) trong khi
    //       Prisma vẫn giữ fd + page cache của DB cũ — writer nền (goal-loop
    //       worker tick 5s, sweep 6h, traffic) kịp ghi stale page vào file vừa
    //       restore → hỏng bản restore TỒN TẠI QUA restart;
    //   (b) KHÔNG kiểm buffer là SQLite hợp lệ TRƯỚC KHI PHÁ (backup có verify
    //       sau upload, restore thì không verify trước khi ghi — không đối xứng);
    //   (c) KHÔNG tự backup DB hiện tại trước khi đè — bản R2 hỏng = mất trắng.
    // Trình tự mới: (1) tải về tmp cùng thư mục → (2) verify SQLite magic + size
    // → (3) pre-restore backup DB hiện tại lên R2 (best-effort, cảnh báo khi fail)
    // → (4) fs.rename tmp → DB_PATH (atomic swap inode — process giữ fd cũ đọc
    // dữ liệu cũ tới khi restart, KHÔNG ghi stale page đè bản mới) → (5) xoá
    // WAL/SHM cũ → (6) dọn tmp nếu còn.
    if (action === 'restore') {
      const keyToRestore = versionKey || R2_LATEST_KEY
      const tmpRestore = DB_PATH + '.restore-tmp'
      let preRestoreBackupKey: string | undefined
      let preRestoreWarning: string | undefined

      try {
        // (1) Tải về file tạm cùng thư mục với DB (đảm bảo cùng filesystem cho
        // fs.rename atomic ở bước 4) — KHÔNG chạm DB_PATH nữa.
        const result = await downloadFileFromR2(keyToRestore, tmpRestore)
        if (!result.success) {
          return NextResponse.json(
            { error: 'R2 download failed', detail: result.error, key: keyToRestore },
            { status: 500 }
          )
        }

        // (2) Verify TRƯỚC KHI PHÁ: magic 16 byte "SQLite format 3\0" + size > 0.
        // Bản R2 hỏng/truncated/sai key → DB chạy thật NGUYÊN VẸN (chưa bị chạm).
        const downloaded = await fs.readFile(tmpRestore)
        const SQLITE_MAGIC = Buffer.from('SQLite format 3\0', 'binary')
        const headerOk = downloaded.length >= 100 && downloaded.subarray(0, 16).equals(SQLITE_MAGIC)
        if (!headerOk || downloaded.length === 0) {
          await fs.unlink(tmpRestore).catch(() => { /* dọn best-effort */ })
          return NextResponse.json(
            {
              error: 'Backup verify FAILED trước khi restore',
              detail: `Buffer tải về không phải file SQLite hợp lệ (magic ${headerOk ? 'OK' : 'SAI'}, ${downloaded.length} bytes) — DB hiện tại NGUYÊN VẸN, chưa bị ghi đè. Kiểm tra key/integrity của bản backup này.`,
              key: keyToRestore,
            },
            { status: 500 }
          )
        }

        // (3) Pre-restore backup DB hiện tại (điểm khôi phục nếu bản restore tồi)
        // — best-effort: DB hiện tại có thể đang hỏng (chính là lý do restore),
        // fail thì chỉ cảnh báo, không chặn thao tác có chủ đích của operator.
        try {
          const pre = await snapshotDbToBuffer(DB_PATH)
          const preTimestamp = new Date().toISOString().replace(/[:.]/g, '-')
          preRestoreBackupKey = `${R2_PREFIX}pre-restore-${preTimestamp}.db`
          const preResult = await uploadToR2(preRestoreBackupKey, pre.buffer, 'application/octet-stream')
          if (!preResult.success) {
            preRestoreBackupKey = undefined
            preRestoreWarning = `Pre-restore backup upload failed: ${preResult.error ?? 'unknown'} — tiếp tục restore theo yêu cầu (operator chủ đích).`
          } else {
            console.log(`[DB-Backup] Pre-restore backup saved: ${preRestoreBackupKey} (${(pre.buffer.length / 1024 / 1024).toFixed(2)} MB, ${pre.method})`)
          }
        } catch (preErr) {
          preRestoreWarning = `Pre-restore backup failed: ${preErr instanceof Error ? preErr.message : String(preErr)} — tiếp tục restore theo yêu cầu (operator chủ đích).`
        }

        // (4) Atomic swap: rename tmp → DB_PATH. POSIX rename ghi đè tên bằng
        // inode MỚI trong 1 thao tác — process đang giữ fd của DB cũ tiếp tục
        // đọc inode cũ (dữ liệu cũ) tới khi restart, mọi ghi của chúng bị ghi
        // vào inode cũ đã tách tên (mất theo restart) — KHÔNG BAO GIỜ đè lên
        // nội dung file mới như writeFile truncate-in-place từng làm.
        await fs.rename(tmpRestore, DB_PATH)

        // (5) Xoá WAL/SHM cũ — chúng thuộc DB cũ và sẽ làm hỏng file mới nếu
        // connection sống tái tạo/lưu lại frame.
        for (const ext of ['-wal', '-shm']) {
          try {
            await fs.unlink(DB_PATH + ext)
            console.log(`[DB-Backup] Deleted stale ${ext} file`)
          } catch {
            // ignore — file may not exist
          }
        }

        console.log(
          `[DB-Backup] Restored ${keyToRestore} → ${DB_PATH} (${downloaded.length} bytes, atomic rename${preRestoreBackupKey ? `, pre-restore backup: ${preRestoreBackupKey}` : ''})`
        )

        return NextResponse.json({
          success: true,
          action: 'restore',
          key: keyToRestore,
          sizeBytes: downloaded.length,
          dbPath: DB_PATH,
          verifiedBeforeWrite: true,
          preRestoreBackupKey,
          ...(preRestoreWarning ? { preRestoreWarning } : {}),
          warning:
            'SQLite DB restored (verify magic + pre-restore backup + atomic rename). The Next.js dev server MUST be restarted (PM2: pm2 restart theopusflashlite) so Prisma re-opens the new database file. In-memory caches and the Qdrant/Neo4j clients are unaffected.',
        })
      } catch (restoreErr) {
        // Dọn tmp best-effort rồi rethrow cho handler ngoài
        await fs.unlink(tmpRestore).catch(() => { /* đã rename hoặc không tồn tại */ })
        throw restoreErr
      }
    }

    return NextResponse.json(
      { error: `Unknown action: ${action}. Use 'backup' (default) or 'restore'.` },
      { status: 400 }
    )
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[DB-Backup] POST error:', msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

/** GET: list available R2 backups (timestamped history + latest pointer). */
export async function GET() {
  if (!isR2Configured()) {
    return NextResponse.json(
      { error: 'R2 not configured' },
      { status: 503 }
    )
  }

  try {
    // P0-1: hiển thị path đang sống (best-effort — listing không cần chốt chặn)
    const livePath = (await resolveLiveDbPath()) ?? '(unresolved)'

    const listing = await listR2Objects(R2_PREFIX, 500)
    if (!listing.success) {
      return NextResponse.json(
        { error: 'R2 list failed', detail: listing.error },
        { status: 500 }
      )
    }

    const backups = listing.objects
      .filter((o) => o.key.endsWith('.db'))
      .sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime())
      .map((o) => {
        const isLatest = o.key === R2_LATEST_KEY
        const name = o.key.split('/').pop() || o.key
        return {
          key: o.key,
          name,
          sizeBytes: o.size,
          sizeLabel: `${(o.size / 1024 / 1024).toFixed(2)} MB`,
          lastModified: o.lastModified.toISOString(),
          isLatest,
        }
      })

    const totalSizeBytes = backups.reduce((sum, b) => sum + b.sizeBytes, 0)

    return NextResponse.json({
      configured: true,
      dbPath: livePath,
      totalBackups: backups.length,
      totalSizeBytes,
      totalSizeLabel: `${(totalSizeBytes / 1024 / 1024).toFixed(2)} MB`,
      backups,
      endpoints: {
        'POST ?action=backup': 'Snapshot SQLite → R2 (creates timestamped + latest)',
        'POST ?action=restore': 'Restore latest R2 backup → SQLite (restart app after)',
        'POST ?action=restore&key=<key>': 'Restore a specific timestamped backup',
      },
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
