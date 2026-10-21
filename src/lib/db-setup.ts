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
 * FIX (user report 2026-08-31 "Unknown argument `opusReviewMode`" —
 * sweepOpusAutoSessions spam lỗi mỗi tick):
 *   Probe cũ có LỖ HỔNG: CLI `migrate diff` chỉ so DB ↔ schema.prisma trên
 *   đĩa — nếu CẢ HAI đều mới (user pull code mới + từng db:push) nhưng
 *   CLIENT trong bộ nhớ cũ (node_modules/@prisma/client generate từ schema
 *   trước f3d97be — vd copy node_modules từ bản cũ / postinstall không
 *   re-run khi lockfile không đổi) → probe trả 'ok' SAI, sweep quăng
 *   PrismaClientValidationError "Unknown argument" mãi mà không ai tự chữa.
 *   Giờ thêm CANARY client-side trong probeSchema(): 1 query nhẹ chạm field
 *   mới nhất (AgentSession.opusReviewMode) — client cũ → validation error
 *   NGAY (chưa chạm DB) → 'client-drift' → generate + push + hướng dẫn
 *   restart. P2021/P2022 (DB cũ, client mới) → KHÔNG khớp canary → CLI
 *   probe quyết 'db-drift' như cũ.
 *
 * FIX (user report 2026-09-12 "The column main.Todo.runId does not exist"):
 * probe thủ công cũ CHỈ đếm 2 điểm (DeletedSession + AgentProfile.tools) —
 * Todo.runId (CI-2 Task 11-a) + archivedAt + các bảng GĐ3/GĐ4 (TaskContext,
 * TaskContextArchive, GoalLoopJob…) KHÔNG được probe → probeSchema() trả
 * 'ok' sai, db push không chạy, API P2022 lỗi runtime. Giờ probe bằng
 * `prisma migrate diff --from-schema-datasource --to-schema-datamodel
 * --exit-code`: so sánh TOÀN BỘ schema DB thật vs schema.prisma (bảng +
 * cột + index + FK) → phát hiện MỌI drift, KHÔNG cần duy trì probe thủ công
 * khi thêm field/model mới. Probe thủ công chỉ còn là fallback khi CLI lỗi.
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
 * Probe TOÀN DIỆN bằng Prisma CLI: `migrate diff` so sánh schema của DB thật
 * (datasource — DATABASE_URL từ env, inherit xuống CLI) với schema.prisma.
 *   - exit 0 → 'ok'      (DB khớp schema 100%)
 *   - exit 2 → 'db-drift' (DB thiếu/khác bảng-cột-index bất kỳ)
 *   - exit 1/other → CLI lỗi → gọi fallback probe thủ công bên dưới.
 *
 * Ưu điểm so với probe thủ công: phát hiện MỌI drift (cột mới, bảng mới,
 * index, FK, kiểu cột) — kể cả những field/model thêm SAU này mà không cần
 * cập nhật code. Chi phí: 1 lần spawn CLI (~1-2s) mỗi lần runSetup (dedup
 * + cache qua ensureDbReady).
 */
async function probeSchemaViaCli(): Promise<DriftKind | 'cli-error'> {
  const res = await runPrismaCli([
    'migrate', 'diff',
    '--from-schema-datasource', 'prisma/schema.prisma',
    '--to-schema-datamodel', 'prisma/schema.prisma',
    '--exit-code',
  ], 90_000)
  if (res.code === 0) return 'ok'
  if (res.code === 2) return 'db-drift'
  return 'cli-error'
}

/**
 * Fallback probe thủ công (chỉ dùng khi Prisma CLI lỗi — spawn fail, thiếu
 * node/bun...). Query chạm các phần schema MỚI NHẤT — DB cũ sẽ throw
 * P2021/P2022; client cũ (chưa generate) sẽ throw validation error.
 */
async function probeSchemaManual(): Promise<DriftKind> {
  const dbAny = db as unknown as Record<string, { count?: () => Promise<number> }>
  // Model mới nhất: DeletedSession (tombstone persist — 2026-09-08).
  // Client cũ (chưa generate) sẽ không có model này → 'client-drift'.
  if (!dbAny.deletedSession) return 'client-drift'
  // Client có DeletedSession nhưng thiếu model GĐ3/GĐ4 → client cũ hơn schema
  if (typeof dbAny.goalLoopJob?.count !== 'function' || typeof dbAny.taskContextArchive?.count !== 'function') {
    return 'client-drift'
  }

  try {
    // Bảng mới nhất: DeletedSession
    await db.deletedSession.count()
    // Cột mới nhất: AgentProfile.tools (Agent Factory — 2026-09-08)
    await db.agentProfile.findFirst({ select: { tools: true } })
    // Cột GĐ2 CI-2 (Task 11-a) — chính là cột user report 2026-09-12 thiếu:
    // Todo.runId (run scope) + Todo.archivedAt (lưu trữ trung thực).
    await db.todo.findFirst({ select: { runId: true, archivedAt: true } })
    // Bảng GĐ4 CI-5 (Task 14-a): GoalLoopJob (durable job queue) +
    // TaskContextArchive GĐ3 CI-3 (Task 13-a) — Kho Context.
    await db.goalLoopJob.count()
    await db.taskContextArchive.count()
    // Field mới nhất (fix 2026-08-31): AgentSession.opusReviewMode
    // (Opus auto-review sweep — f3d97be). Client cũ → "Unknown argument"
    // NGAY (validate client-side); DB cũ → P2022 (client mới).
    await db.agentSession.findFirst({ select: { opusReviewMode: true } })
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
    // Client trong bộ nhớ không biết field/model mới (select runId → validation
    // error "Unknown field") → client-drift: generate + push cho lần restart sau.
    // FIX 2026-08-31: mở rộng match "Unknown argument" (Prisma gọi argument
    // trong where/select — lỗi user report gốc là "Unknown argument `opusReviewMode`").
    if (code === 'P2009' || code === 'P2007' || /unknown (field|argument)/i.test(msg)) {
      return 'client-drift'
    }
    throw err // lỗi khác (lock, file hỏng...) — không phải drift
  }
}

async function probeSchema(): Promise<DriftKind> {
  // 1. Fast-path in-memory: client quá cũ (không có model mới nhất) →
  //    client-drift NGAY không cần CLI.
  const ds = (db as unknown as Record<string, unknown>).deletedSession
  if (!ds) return 'client-drift'

  // 1.5. CANARY client-side (fix 2026-08-31 "Unknown argument
  //      `opusReviewMode`"): client có model cũ nhưng thiếu FIELD mới nhất
  //      → PrismaClientValidationError client-side NGAY (chưa chạm DB).
  //      DB-cũ-lỗi (P2021/P2022 — client mới, DB cũ) KHÔNG khớp nhánh này:
  //      query validate OK client-side rồi mới lỗi phía server → rơi tiếp
  //      xuống CLI probe quyết 'db-drift' như cũ. Lỗi khác lạ cũng nhường
  //      cho CLI probe (an toàn — CLI độc lập client trong bộ nhớ).
  try {
    await db.agentSession.findFirst({ select: { opusReviewMode: true } })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const code = (err as { code?: string }).code
    if (
      /unknown (argument|field)/i.test(msg) ||
      code === 'P2007' || code === 'P2009'
    ) {
      return 'client-drift'
    }
    // P2021/P2022/lỗi khác → fall-through xuống CLI probe
  }

  // 2. Toàn diện qua CLI migrate diff (phát hiện MỌI drift bảng/cột/index).
  try {
    const cli = await probeSchemaViaCli()
    if (cli !== 'cli-error') return cli
    console.warn('[DbSetup] migrate diff CLI lỗi — fallback probe thủ công')
  } catch (cliErr) {
    console.warn(
      '[DbSetup] migrate diff CLI exception — fallback probe thủ công:',
      cliErr instanceof Error ? cliErr.message : String(cliErr)
    )
  }

  // 3. Fallback thủ công khi CLI không chạy được.
  return probeSchemaManual()
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
    console.error(
      '[DbSetup] prisma db push thất bại:', out,
      '\n[DbSetup] ⛔ DB local đang cũ hơn schema.prisma — API sẽ lỗi P2021/P2022 ("column/table does not exist").' +
      '\n[DbSetup] 👉 CHẠY THỦ CÔNG trên terminal của bạn (chọn 1):' +
      '\n           bun run db:push      (hoặc)      npx prisma db push' +
      '\n[DbSetup]    (nếu CLI hỏi xác nhận mất dữ liệu bảng đã bị xóa khỏi schema — gõ y; dữ liệu app chính không bị ảnh hưởng)'
    )
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
 *
 * BUG2-316 (2026-10-21 — hermetic test suite, round trả nợ user duyệt):
 * Dưới test runner, TOÀN BỘ tầng self-heal (probe CLI + prisma db push /
 * generate spawn) bị TẮT. Bằng chứng gốc (A/B 9-run matrix, §7.10 phiên):
 * request-time self-heal spawn `prisma db push` trên DB test GIỮA CHỪNG
 * 111-112 file chạy song song → DDL đụng bảng đang được test dùng (bảng
 * "biến mất thoáng" — TuningChangeLog) + cascade SQLITE_BUSY/P2024 5s →
 * đúng tập "20 failures, 10 unique" OBS-2 N4 + gate đỏ/xanh thất thường.
 * DB test đã được chuẩn bị TRƯỚC bởi preload (bunfig.toml copy bản riêng
 * /tmp) hoặc quality-gate (db/.quality-gate-test.db) — self-heal giữa chừng
 * chỉ gây race, không có kịch bản hợp lệ nào cần nó dưới test.
 *
 * Marker test — TRIPLE-CHECK (đo live bun 1.3.14: `BUN_TEST` KHÔNG được set
 * trong process.env; bản này r143-verify tái hiện ngay guard đơn BUN_TEST
 * cho phép probe spawn 1.2s giữa test = đúng lỗi BUG2-316):
 *   1. NODE_ENV === 'test'  — bun test tự set (đã đo live; marker CHÍNH);
 *   2. BUN_TEST truthy       — phòng tương lai bun đặt lại / runner khác;
 *   3. TMO_TEST_DB_ISOLATED === '1' — preload cách ly DB đã kích hoạt
 *      (tests/db-isolation-preload.ts set khi copy DB xong — dấu chắc chắn
 *      nhất đang chạy dưới bộ test có cách ly).
 * App runtime (next dev NODE_ENV=development · worker development · build
 * production) KHÔNG bao giờ khớp marker nào — self-heal hoạt động đầy đủ.
 */
function isTestRunnerContext(): boolean {
  return (
    process.env.NODE_ENV === 'test'
    || Boolean(process.env.BUN_TEST)
    || process.env.TMO_TEST_DB_ISOLATED === '1'
  )
}

export async function ensureDbReady(opts: { force?: boolean } = {}): Promise<DbSetupResult> {
  if (isTestRunnerContext()) {
    return {
      ok: true,
      migrated: false,
      reason: 'TEST-RUNNER guard (BUG2-316) — self-heal TẮT dưới test runner (NODE_ENV=test | BUN_TEST | TMO_TEST_DB_ISOLATED): DB test do preload/quality-gate chuẩn bị sẵn; spawn prisma db push giữa chừng gây race biến mất bảng + SQLITE_BUSY',
    }
  }
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
