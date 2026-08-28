/**
 * DB SETUP — tự động đồng bộ SQLite schema với Prisma schema (self-healing)
 * =====================================================================
 * (fix user report 2026-09-09: "chạy app trên local thì app không load ra
 * các agents")
 *
 * ROOT CAUSE: user `git pull` code mới có thay đổi schema (cột
 * `AgentProfile.tools`, bảng `DeletedSession`...) nhưng KHÔNG chạy
 * `bun run db:push` trên máy local. Prisma client (đã regenerate qua
 * postinstall) query DB cũ → lỗi P2021/P2022 ("column/table does not
 * exist") → GET /api/agents rơi vào fallback trả `{agents: []}` với
 * HTTP 200 → UI hiển thị danh sách agents TRỐNG mà không có lỗi nào.
 *
 * GIẢI PHÁP — 3 lớp:
 *   1. BOOT: instrumentation gọi ensureDbReady() ngay khi server khởi
 *      động — probe schema drift, nếu lệch thì tự chạy
 *      `prisma db push --skip-generate` (spawn CLI, không đợi chặn boot).
 *   2. REQUEST-TIME SELF-HEAL: GET /api/agents khi gặp DB error sẽ gọi
 *      ensureDbReady({force:true}) rồi THỬ LẠI query — chữa mà không cần
 *      restart app.
 *   3. UI: khi vẫn rơi vào fallback (CLI thiếu/hỏi), API trả `warning`
 *      để UI hiển thị rõ nguyên nhân thay vì danh sách trống câm lặng.
 *
 * LOẠI DRIFT:
 *   - 'db-drift'     : client mới + DB cũ (phổ biến nhất sau git pull +
 *                      bun install) → `db push` xong là query chạy được
 *                      NGAY trong cùng process (client trong bộ nhớ đã
 *                      hiểu schema mới — chỉ thiếu DDL trong file DB).
 *   - 'client-drift' : Prisma client trong bộ nhớ cũ (user pull code mà
 *                      không chạy bun install) → chạy `prisma generate`
 *                      + `db push` cho lần khởi động sau; process hiện tại
 *                      cần restart (module đã load không thể hoán đổi).
 *                      Các call site `deletedSession` có guard chống crash.
 *
 * CẬP NHẬT TƯƠNG LAI: khi thêm field/model mới vào schema.prisma, THÊM
 * probe tương ứng vào probeSchema() bên dưới để drift đó cũng được tự chữa.
 */

import { spawn, spawnSync } from 'child_process'
import { join } from 'path'
import { db } from './db'

export type DbSetupResult = {
  ok: boolean
  migrated: boolean
  reason?: string
}

type DriftKind = 'ok' | 'db-drift' | 'client-drift'

const globalForDbSetup = globalThis as unknown as {
  __tmoDbSetupInFlight?: Promise<DbSetupResult> | null
  __tmoDbSetupLastResult?: DbSetupResult | null
}

// ==================== PROBE — phát hiện schema drift ====================

/**
 * Query chạm các phần schema MỚI NHẤT — DB cũ sẽ throw P2021/P2022.
 * Mỗi lần thêm field/model mới vào schema.prisma → thêm 1 dòng probe ở đây.
 */
async function probeSchema(): Promise<DriftKind> {
  // Model mới nhất: DeletedSession (tombstone persist — 2026-09-08).
  // Client cũ (chưa generate) sẽ không có model này → 'client-drift'.
  const ds = (db as unknown as Record<string, unknown>).deletedSession
  if (!ds) return 'client-drift'

  try {
    // Bảng mới nhất: DeletedSession
    await db.deletedSession.count()
    // Cột mới nhất: AgentProfile.tools (Agent Factory — 2026-09-08)
    await db.agentProfile.findFirst({ select: { tools: true } })
    return 'ok'
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const code = (err as { code?: string }).code
    if (
      code === 'P2021' || // table does not exist
      code === 'P2022' || // column does not exist
      /does not exist in the current database/i.test(msg) ||
      /no such (table|column)/i.test(msg)
    ) {
      return 'db-drift'
    }
    throw err // lỗi khác (lock, file hỏng...) — không phải drift
  }
}

// ==================== PRISMA CLI RUNNER ====================

let cachedRunner: { command: string; prefix: string[] } | null = null

/**
 * Chọn runner cho prisma CLI. Ưu tiên `node` (CLI chạy ổn định nhất),
 * fallback `process.execPath` (bun khi `bun run dev`).
 */
function pickRunner(): { command: string; prefix: string[] } {
  if (cachedRunner) return cachedRunner
  try {
    const probe = spawnSync('node', ['--version'], { timeout: 5000, windowsHide: true })
    if (probe.status === 0 && probe.stdout?.toString().startsWith('v')) {
      cachedRunner = { command: 'node', prefix: [] }
      return cachedRunner
    }
  } catch { /* node không có — dùng execPath */}
  cachedRunner = { command: process.execPath, prefix: [] }
  return cachedRunner
}

function runPrismaCli(args: string[], timeoutMs = 120_000): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise) => {
    const cliEntry = join('node_modules', 'prisma', 'build', 'index.js')
    const { command, prefix } = pickRunner()
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(command, [...prefix, cliEntry, ...args], {
        cwd: process.cwd(),
        env: { ...process.env }, // DATABASE_URL inherit — CLI và app dùng CHUNG một DB
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (err) {
      resolvePromise({ code: -1, stdout: '', stderr: `spawn failed: ${err instanceof Error ? err.message : String(err)}` })
      return
    }

    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (code: number | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolvePromise({ code, stdout, stderr })
    }
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* đã thoát */ }
      finish(null)
    }, timeoutMs)

    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString().slice(0, 8000) })
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString().slice(0, 8000) })
    child.on('error', (err) => {
      stderr += `\n${err.message}`
      finish(-1)
    })
    child.on('close', (code) => finish(code))
  })
}

// ==================== SETUP CHÍNH ====================

async function runSetup(): Promise<DbSetupResult> {
  let probe: DriftKind
  try {
    probe = await probeSchema()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[DbSetup] Probe schema thất bại (không phải drift):', msg)
    return { ok: false, migrated: false, reason: `probe failed: ${msg.slice(0, 200)}` }
  }

  if (probe === 'ok') return { ok: true, migrated: false }

  console.warn(
    `[DbSetup] ⚠️ Phát hiện schema drift (${probe}) — DB local chưa khớp schema.prisma. ` +
    'Tự động chạy prisma db push (không mất dữ liệu — chỉ thêm cột/bảng còn thiếu)...'
  )

  // client-drift: generate client mới cho lần khởi động sau (process hiện tại
  // giữ client cũ trong bộ nhớ — không thể hoán đổi nóng).
  if (probe === 'client-drift') {
    const gen = await runPrismaCli(['generate'])
    if (gen.code !== 0) {
      console.error('[DbSetup] prisma generate thất bại:', (gen.stderr || gen.stdout).slice(0, 500))
    }
  }

  const push = await runPrismaCli(['db', 'push', '--skip-generate'])
  if (push.code !== 0) {
    const out = (push.stderr || push.stdout).slice(0, 500)
    console.error('[DbSetup] prisma db push thất bại:', out)
    return { ok: false, migrated: false, reason: `db push failed: ${out}` }
  }

  // Xác nhận lại bằng probe (trừ client-drift — client trong bộ nhớ vẫn cũ
  // tới khi restart; DDL đã chạy nên DB sẵn sàng cho lần sau).
  if (probe === 'client-drift') {
    console.warn(
      '[DbSetup] ✅ Đã generate client + db push. Prisma client trong process hiện tại còn cũ — ' +
      'HÃY RESTART app (bun run dev) để dùng schema mới. Các call site đã có guard nên app không crash.'
    )
    return { ok: true, migrated: true, reason: 'client-drift đã sửa trên đĩa — cần restart app' }
  }

  try {
    const probe2 = await probeSchema()
    if (probe2 === 'ok') {
      console.log('[DbSetup] ✅ Schema đã được đồng bộ tự động — query tiếp theo chạy bình thường (không cần restart)')
      return { ok: true, migrated: true }
    }
    if (probe2 === 'client-drift') {
      return { ok: true, migrated: true, reason: 'client-drift — cần restart app' }
    }
    return { ok: false, migrated: false, reason: 'drift vẫn còn sau db push' }
  } catch (err) {
    return { ok: false, migrated: false, reason: `re-probe failed: ${err instanceof Error ? err.message : String(err)}` }
  }
}

/**
 * Đảm bảo DB schema sẵn sàng. Dedup qua in-flight promise (nhiều route gọi
 * đồng thời chỉ chạy 1 lần); `force` bỏ qua kết quả cache OK trước đó (dùng
 * khi gặp DB error bất ngờ lúc runtime — vd file DB bị thay lúc app chạy).
 */
export async function ensureDbReady(opts: { force?: boolean } = {}): Promise<DbSetupResult> {
  if (globalForDbSetup.__tmoDbSetupInFlight) return globalForDbSetup.__tmoDbSetupInFlight
  if (!opts.force && globalForDbSetup.__tmoDbSetupLastResult?.ok) {
    return globalForDbSetup.__tmoDbSetupLastResult
  }
  const p = runSetup()
  globalForDbSetup.__tmoDbSetupInFlight = p
  try {
    const result = await p
    globalForDbSetup.__tmoDbSetupLastResult = result
    return result
  } finally {
    globalForDbSetup.__tmoDbSetupInFlight = null
  }
}
