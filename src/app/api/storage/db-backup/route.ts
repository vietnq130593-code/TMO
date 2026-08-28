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
 * This endpoint performs a full binary snapshot of the SQLite .db file:
 *   1. PRAGMA wal_checkpoint(TRUNCATE) — flushes WAL into the main .db file
 *   2. Read /home/z/my-project/db/custom.db into a Buffer
 *   3. Upload to R2 at backups/sqlite/custom-<ISO-timestamp>.db (history)
 *      AND backups/sqlite/custom.db (latest — overwritten each time)
 *
 * Restore reverses the process: download from R2 → overwrite the .db file.
 * The app must be restarted after restore so Prisma re-opens the new file.
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
import path from 'path'
import { uploadToR2, downloadFileFromR2, listR2Objects, isR2Configured } from '@/lib/r2-storage'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

/** SQLite DB path — must match the one used by Prisma (DATABASE_URL in .env). */
const DB_PATH = process.env.DATABASE_URL
  ? process.env.DATABASE_URL.replace(/^file:/, '').replace(/^\.\.\//, '/home/z/my-project/db/')
  : '/home/z/my-project/db/custom.db'

const DB_DIR = path.dirname(DB_PATH)

const R2_LATEST_KEY = 'backups/sqlite/custom.db'
const R2_PREFIX = 'backups/sqlite/'

/**
 * Flush the SQLite WAL into the main .db file so the binary snapshot is
 * complete. Prisma opens the DB in WAL mode (see src/lib/db.ts), which means
 * recent writes can be in custom.db-wal and not yet in custom.db.
 */
async function checkpointWal(): Promise<void> {
  try {
    // Prisma's $executeRawUnsafe runs the PRAGMA inside the same connection
    // pool that holds the DB open — TRUNCATE forces a full checkpoint.
    // NOTE (type-only): gọi dạng tagged-template nên runtime nhận
    // TemplateStringsArray (Prisma sẽ throw → catch bên dưới, giữ behavior
    // gốc). Cast chữ ký để tsc chấp nhận, không đổi call.
    await (db.$executeRawUnsafe as unknown as (strings: TemplateStringsArray) => Promise<number>)`PRAGMA wal_checkpoint(TRUNCATE)`
    console.log('[DB-Backup] WAL checkpointed')
  } catch (err) {
    console.warn(
      '[DB-Backup] WAL checkpoint failed (non-fatal — snapshot may be slightly stale):',
      err instanceof Error ? err.message : String(err)
    )
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
    // === BACKUP ===
    if (action === 'backup') {
      // 1. Flush WAL into main .db
      await checkpointWal()

      // 2. Ensure DB directory exists (it always should, but be safe)
      await fs.mkdir(DB_DIR, { recursive: true })

      // 3. Read the .db file into a buffer
      let buffer: Buffer
      try {
        buffer = await fs.readFile(DB_PATH)
      } catch {
        return NextResponse.json(
          { error: `SQLite DB file not found at ${DB_PATH}` },
          { status: 404 }
        )
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
      const versionedKey = `${R2_PREFIX}custom-${timestamp}.db`
      const sizeLabel = `${(buffer.length / 1024 / 1024).toFixed(2)} MB`

      // 4. Upload timestamped version (history — never overwritten)
      const versionedResult = await uploadToR2(
        versionedKey,
        buffer,
        'application/octet-stream'
      )

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
        `[DB-Backup] Snapshot saved: ${versionedKey} (${sizeLabel}) + latest pointer`
      )

      return NextResponse.json({
        success: true,
        action: 'backup',
        timestamp,
        versionedKey,
        latestKey: R2_LATEST_KEY,
        sizeBytes: buffer.length,
        sizeLabel,
        dbPath: DB_PATH,
      })
    }

    // === RESTORE ===
    if (action === 'restore') {
      const keyToRestore = versionKey || R2_LATEST_KEY

      // 1. Download from R2 → local path. downloadFileFromR2 writes to a
      //    target path; we restore directly to DB_PATH so Prisma picks up
      //    the new file on next restart.
      const result = await downloadFileFromR2(keyToRestore, DB_PATH)
      if (!result.success) {
        return NextResponse.json(
          { error: 'R2 download failed', detail: result.error, key: keyToRestore },
          { status: 500 }
        )
      }

      // 2. Delete the stale WAL/SHM files — they belong to the OLD database
      //    and would corrupt the restored one if left in place.
      for (const ext of ['-wal', '-shm']) {
        try {
          await fs.unlink(DB_PATH + ext)
          console.log(`[DB-Backup] Deleted stale ${ext} file`)
        } catch {
          // ignore — file may not exist
        }
      }

      console.log(
        `[DB-Backup] Restored ${keyToRestore} → ${DB_PATH} (${result.size} bytes)`
      )

      return NextResponse.json({
        success: true,
        action: 'restore',
        key: keyToRestore,
        sizeBytes: result.size,
        dbPath: DB_PATH,
        warning:
          'SQLite DB restored. The Next.js dev server MUST be restarted (PM2: pm2 restart theopusflashlite) so Prisma re-opens the new database file. In-memory caches and the Qdrant/Neo4j clients are unaffected.',
      })
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
      dbPath: DB_PATH,
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
