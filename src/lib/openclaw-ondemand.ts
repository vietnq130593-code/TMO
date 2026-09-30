/**
 * OpenClaw Gateway — ON-DEMAND MODE (lazy start + idle shutdown)
 * ==============================================================
 * (user request 2026-09-07: "Agent cần dùng đến tools nào thì tự gọi lúc đấy
 * mới khởi động Gateway — chỉ dùng phần cần đến")
 *
 * Trước đây instrumentation tự spawn openclaw-gateway (18789) + gateway-bridge
 * (18791) ngay khi app khởi động — tốn ~340MB RAM khi idle (manager 28MB +
 * gateway binary ~275MB + bridge 38MB; khi có session hoạt động gateway spawn
 * thêm 5-10 process con ~350MB mỗi cái → có thể lên tới GB). Trong khi đó:
 *   - Chat agents có provider/model riêng KHÔNG đi qua gateway
 *   - 36 tools bridge hiện chưa có UI caller nào
 *   - Trên Windows local gateway không chạy được (binary symlink POSIX)
 *
 * Chế độ ON-DEMAND (mặc định; OPENCLAW_ON_DEMAND=false để tắt):
 *   - KHÔNG spawn gateway khi app khởi động
 *   - Lần ĐẦU TIÊN một tính năng thật sự cần gateway (chat fallback cho agent
 *     không có provider/model, Channels UI, skills/sessions listing...) →
 *     ensureGatewayRunning() spawn manager + bridge, đợi health OK
 *   - Badge Gateway (/api/openclaw/status) vẫn là health check THỤ ĐỘNG —
 *     chỉ hiện online khi gateway thật sự đang chạy
 *   - Sau OPENCLAW_IDLE_SHUTDOWN_MS (mặc định 10 phút) không dùng đến →
 *     tự tắt gateway + bridge (RAM về 0)
 *   - Spawn fail (vd Windows không chạy được binary) → cooldown 2 phút,
 *     fast-fail cho các call sau (app fallback path khác như cũ)
 *   - App restart khi gateway đang chạy (orphan) → health probe "nhận nuôi"
 *     (adopt) thay vì spawn trùng — manager takeover trong mini-service tự
 *     xử lý trùng lặp nếu có
 */

import { spawn, ChildProcess, execSync } from 'child_process'
import { resolve } from 'path'
import { existsSync, readFileSync, writeFileSync, statSync } from 'fs'

const GATEWAY_PORT = 18789
const BRIDGE_PORT = 18791
const GATEWAY_HEALTH_URL = process.env.OPENCLAW_GATEWAY_URL || 'http://127.0.0.1:18789'

/** Cooldown sau 1 lần spawn thất bại — tránh thử lại liên tục mỗi request */
const SPAWN_FAIL_COOLDOWN_MS = intEnv('OPENCLAW_SPAWN_FAIL_COOLDOWN_MS', 120_000)
/** Thời gian chờ gateway health OK sau khi spawn (gateway boot ~5-15s) */
const SPAWN_TIMEOUT_MS = intEnv('OPENCLAW_SPAWN_TIMEOUT_MS', 45_000)
/** Tự tắt gateway sau N ms không dùng đến (0 = không tự tắt) */
const IDLE_SHUTDOWN_MS = intEnv('OPENCLAW_IDLE_SHUTDOWN_MS', 600_000)
/** Interval check idle */
const IDLE_CHECK_INTERVAL_MS = 30_000
/** TTL cache "đang chạy" — tránh probe health mỗi call */
const RUNNING_CACHE_TTL_MS = 20_000
/** Poll bridge mỗi 500ms khi chờ bridge boot (bridge ~1-3s) */
const BRIDGE_POLL_INTERVAL_MS = 500
/** Tổng thời gian chờ bridge boot — 12s */
const BRIDGE_STARTUP_TIMEOUT_MS = 12_000

function intEnv(name: string, fallback: number): number {
  const v = Number(process.env[name])
  return Number.isFinite(v) && v >= 0 ? Math.floor(v) : fallback
}

/** On-demand bật mặc định — gateway là fallback-path, không phải dependency chính */
export function isOnDemandEnabled(): boolean {
  const v = process.env.OPENCLAW_ON_DEMAND
  return v === undefined ? true : v === 'true' || v === '1'
}

// ==================== STATE (hot-reload safe) ====================

interface OnDemandState {
  gatewayChild: ChildProcess | null
  bridgeChild: ChildProcess | null
  running: boolean
  lastUsed: number
  lastProbeOk: number
  lastSpawnFailed: number
  spawnPromise: Promise<{ online: boolean; started?: boolean; error?: string }> | null
  /** Dedup ensureBridgeRunning — 2 request cùng lúc chỉ spawn MỘT bridge */
  bridgePromise: Promise<{ online: boolean; started?: boolean; error?: string }> | null
  /** Số tầng ensureBridgeRunning đang chạy (chống đệ quy vòng gateway↔bridge) */
  bridgeEnsureDepth: number
  timerRegistered: boolean
  shuttingDown: boolean
}

const g = globalThis as unknown as { __openclawOnDemandState?: OnDemandState }

function getState(): OnDemandState {
  if (!g.__openclawOnDemandState) {
    g.__openclawOnDemandState = {
      gatewayChild: null,
      bridgeChild: null,
      running: false,
      lastUsed: 0,
      lastProbeOk: 0,
      lastSpawnFailed: 0,
      spawnPromise: null,
      bridgePromise: null,
      bridgeEnsureDepth: 0,
      timerRegistered: false,
      shuttingDown: false,
    }
  }
  return g.__openclawOnDemandState
}

// ==================== HEALTH PROBE ====================

async function probeGateway(timeoutMs = 2500): Promise<boolean> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(`${GATEWAY_HEALTH_URL}/health`, { signal: controller.signal })
    const data = await res.json().catch(() => null)
    return res.ok && data?.ok === true
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

/** Đánh dấu gateway đang được dùng (reset đồng hồ idle-shutdown) */
export function gatewayInUse(): void {
  const s = getState()
  s.lastUsed = Date.now()
  // PERSIST LAST-USE (fix round-11c): app restart trước đây reset đồng hồ idle
  // mỗi lần adopt → gateway orphan 248MB+ không bao giờ bị idle-shutdown trong
  // khi app restart liên tục (death-loop 40-90s/lần). Ghi mtime file (throttle
  // 30s) để lần adopt sau tính idle từ lần DÙNG THẬT cuối, không phải từ boot.
  try {
    const f = lastUseFile()
    if (!existsSync(f) || Date.now() - statSync(f).mtimeMs > 30_000) {
      writeFileSync(f, String(Date.now()), { flag: 'w' })
    }
  } catch { /* best-effort — không làm hỏng call path */ }
}

/** File ghi lại lần dùng gateway CUỐI (mtime = last-use) — sống sót qua restart */
function lastUseFile(): string {
  return resolve(process.cwd(), 'db', '.gateway-lastuse')
}

/**
 * Lần dùng cuối THẬT của gateway (kể cả process app trước): mtime file
 * last-use; fallback mtime PID file gateway (thời điểm spawn) — conservative.
 */
function persistedLastUse(): number {
  try {
    const f = lastUseFile()
    if (existsSync(f)) {
      const t = statSync(f).mtimeMs
      if (Number.isFinite(t) && t > 0) return t
    }
  } catch { /* bỏ qua */ }
  try {
    const pidFile = resolve(process.cwd(), 'mini-services/openclaw-gateway', '.gateway.pid')
    if (existsSync(pidFile)) {
      const t = statSync(pidFile).mtimeMs
      if (Number.isFinite(t) && t > 0) return t
    }
  } catch { /* bỏ qua */ }
  return 0
}

// ==================== SPAWN / SHUTDOWN ====================

function spawnService(relDir: string, extraEnv: Record<string, string>): ChildProcess | null {
  try {
    const cwd = resolve(process.cwd(), relDir)
    if (!existsSync(cwd)) {
      console.warn(`[openclaw-ondemand] ${relDir} không tồn tại — bỏ qua spawn`)
      return null
    }
    const child = spawn('bun', ['index.ts'], {
      cwd,
      stdio: 'ignore',
      detached: true, // sống sót qua restart của app — lần sau adopt lại
      env: { ...process.env, ...extraEnv },
    })
    child.on('error', (err) => {
      console.warn(`[openclaw-ondemand] spawn ${relDir} lỗi: ${err.message}`)
    })
    // Không giữ ref trong event loop của app (detached) — nhưng vẫn giữ ChildProcess
    // để kill khi idle-shutdown
    child.unref()
    return child
  } catch (err) {
    console.warn(`[openclaw-ondemand] spawn ${relDir} exception: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}

/** Kill PID an toàn (SIGTERM, đợi, SIGKILL nếu cần)
 *
 * FIX (review 2026-09-08): trước đây vòng đợi là busy-wait ĐỒNG BỘ (while
 * spin 100% CPU tới 6s mỗi kill, shutdown gọi tới 3 lần → Next server bị
 * ĐÓNG BĂNG tới ~18s — mọi request/chat SSE đứng hết). Giờ await sleep
 * giữa các lần check — event loop được nhả.
 */
async function killPidTree(pid: number, label: string): Promise<void> {
  const isAlive = (p: number) => {
    try {
      process.kill(p, 0)
      return true
    } catch {
      return false
    }
  }
  try {
    if (!isAlive(pid)) return
    console.log(`[openclaw-ondemand] SIGTERM ${label} (PID ${pid})`)
    process.kill(pid, 'SIGTERM')
    const start = Date.now()
    while (isAlive(pid) && Date.now() - start < 6000) {
      await new Promise(r => setTimeout(r, 150)) // yield event loop
    }
    if (isAlive(pid)) {
      console.log(`[openclaw-ondemand] SIGKILL ${label} (PID ${pid})`)
      try { process.kill(pid, 'SIGKILL') } catch { /* đã chết */ }
    }
  } catch {
    /* đã chết hoặc không có quyền — không sao */
  }
}

/** Kill mọi process đang giữ port (fallback Unix khi không có PID file/ref) */
function killPortHolders(port: number): void {
  try {
    const out = execSync(`lsof -ti :${port} 2>/dev/null || true`, { encoding: 'utf-8', timeout: 3000 })
    const pids = out.split('\n').map(x => x.trim()).filter(x => /^\d+$/.test(x))
    for (const p of pids) {
      const pid = parseInt(p, 10)
      if (pid === process.pid) continue
      try { process.kill(pid, 'SIGTERM') } catch { /* đã chết */ }
    }
  } catch {
    /* lsof không có (Windows) hoặc lỗi — bỏ qua */
  }
}

/** Đọc PID từ PID file của mini-service (nếu có) */
function readPidFile(relDir: string, file: string): number | null {
  try {
    const p = resolve(process.cwd(), relDir, file)
    if (!existsSync(p)) return null
    const pid = parseInt(readFileSync(p, 'utf-8').trim(), 10)
    return Number.isFinite(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

/** Tắt gateway (manager → gateway binary) + bridge khi idle (hoặc dọn spawn-fail) */
export async function shutdownIdleGateway(reason = 'idle shutdown'): Promise<void> {
  const s = getState()
  if (s.shuttingDown) return
  s.shuttingDown = true
  try {
    // 1) Bridge trước (ws client — không ảnh hưởng gateway)
    if (s.bridgeChild?.pid) await killPidTree(s.bridgeChild.pid, 'gateway-bridge')
    else killPortHolders(BRIDGE_PORT)
    s.bridgeChild = null

    // 2) Gateway MANAGER trước (SIGTERM manager → handler của nó tự SIGTERM
    //    gateway binary child — nếu kill binary trước, manager sẽ respawn!)
    const managerPid = s.gatewayChild?.pid
      ?? readPidFile('mini-services/openclaw-gateway', '.manager.pid')
    if (managerPid) await killPidTree(managerPid, 'openclaw-gateway manager')
    s.gatewayChild = null

    // 3) Gateway binary còn sống (orphan) → dọn bằng PID file / port
    await new Promise(r => setTimeout(r, 1500))
    if (await probeGateway(1500)) {
      const gwPid = readPidFile('mini-services/openclaw-gateway', '.gateway.pid')
      if (gwPid) await killPidTree(gwPid, 'openclaw-gateway binary')
      if (await probeGateway(1500)) killPortHolders(GATEWAY_PORT)
    }

    s.running = false
    s.lastProbeOk = 0
    console.log(`[openclaw-ondemand] Gateway + bridge đã tắt (${reason}) — RAM giải phóng`)
  } finally {
    s.shuttingDown = false
  }
}

// ==================== ENSURE RUNNING ====================

/**
 * Probe boolean gateway-bridge (18791) — true = có process bridge phản hồi
 * /health. Dùng cho call site "gateway OK nhưng bridge có thể chết" (không
 * cần phân biệt connected/disconnected như probeBridgeState()).
 * URL CỐ ĐỊNH theo BRIDGE_PORT — KHÔNG dùng OPENCLAW_GATEWAY_URL (đó là 18789).
 */
async function probeBridge(timeoutMs = 1500): Promise<boolean> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(`http://127.0.0.1:${BRIDGE_PORT}/health`, { signal: controller.signal })
    const data = await res.json().catch(() => null)
    return res.ok && data?.ok === true
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Probe health gateway-bridge (18791) — phân biệt 3 trạng thái:
 *  - 'connected':    bridge chạy VÀ đã kết nối WS gateway (tool dùng được)
 *  - 'disconnected': bridge process sống nhưng mất kết nối gateway (tool 500
 *                    "bridge not available") — cần reconnect, KHÔNG spawn lại
 *  - 'down':         không phản hồi /health — cần spawn
 */
async function probeBridgeState(timeoutMs = 2000): Promise<'connected' | 'disconnected' | 'down'> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(`http://127.0.0.1:${BRIDGE_PORT}/health`, { signal: controller.signal })
    const data = await res.json().catch(() => null) as { ok?: boolean; bridge?: { status?: string } } | null
    if (res.ok && data?.ok === true && data.bridge?.status === 'connected') return 'connected'
    if (res.ok && data?.ok === true) return 'disconnected'
    return 'down'
  } catch {
    return 'down'
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Task 54 FIX: đảm bảo BRIDGE (18791) chạy VÀ kết nối gateway — tự chữa đủ
 * các tình huống gặp khi quan sát agents chạy thật:
 *
 *  (a) Gateway sống + bridge sống nhưng mất WS (gateway restart/crash giữa
 *      chừng) → cũ: tool 500 "bridge not available" vĩnh viễn; giờ: POST
 *      /reconnect của bridge (disconnect + connect ngay — khỏi chờ backoff
 *      5s-120s của bridge tự thân).
 *  (b) Gateway sống (orphan do spawn thủ công) + bridge down → cũ:
 *      ensureGatewayRunning() trả online:true NGAY (chỉ check 18789) mà
 *      bridge vẫn DOWN → tool "unreachable"; giờ: spawn bridge.
 *  (c) Cả hai down (idle-shutdown 10' / app restart) → đi qua
 *      ensureGatewayRunning() đầy đủ (spawn gateway rồi bridge).
 *
 * DEDUP: bridgePromise (pattern giống s.spawnPromise) — nhiều request/agent
 * gọi song song chỉ spawn MỘT bridge, các caller sau await cùng một promise.
 * CHỐNG ĐỆ QUY: ensureBridgeRunning → ensureGatewayRunning(ensureBridge:false)
 * và ngược lại; bridgeEnsureDepth chặn vòng await lẫn nhau (deadlock) khi
 * spawnAndWait của gateway đang chờ bridge trong lúc ensureBridgeRunning đang
 * chờ chính spawnPromise đó.
 */
export async function ensureBridgeRunning(opts?: { timeoutMs?: number }): Promise<{ online: boolean; started?: boolean; error?: string }> {
  const s = getState()
  // Đang Ở TRONG chuỗi ensureBridgeRunning (tầng trên đang chờ chính
  // ensureGatewayRunning này) → bỏ qua, tránh await vòng = deadlock.
  if (s.bridgeEnsureDepth > 0) {
    return { online: false, error: 'đang trong chuỗi ensureBridgeRunning (bỏ qua — chống đệ quy)' }
  }
  if (s.bridgePromise) return s.bridgePromise // đang ensure → dùng chung kết quả
  s.bridgeEnsureDepth++
  const task = ensureBridgeRunningOnce(opts).finally(() => {
    const st = getState()
    st.bridgeEnsureDepth--
    st.bridgePromise = null
  })
  s.bridgePromise = task
  return task
}

/** Thân ensureBridgeRunning thật (bọc ngoài bởi bridgePromise chống spawn trùng) */
async function ensureBridgeRunningOnce(opts?: { timeoutMs?: number }): Promise<{ online: boolean; started?: boolean; error?: string }> {
  const s = getState()
  s.lastUsed = Date.now() // caller có ý định dùng bridge → reset đồng hồ idle
  {

    // 1. Bridge đã usable?
    if ((await probeBridgeState(2000)) === 'connected') {
      s.lastProbeOk = Date.now()
      return { online: true }
    }

    // 2. Gateway phải chạy trước (bridge là ws client của gateway).
    //    ensureBridge=false để KHÔNG đệ quy: các nhánh online của
    //    ensureGatewayRunning sẽ gọi lại ensureBridgeRunning.
    if (!(await probeGateway(2500))) {
      const g = await ensureGatewayRunning({ timeoutMs: opts?.timeoutMs, ensureBridge: false })
      if (!g.online) return { online: false, error: `gateway (18789) down: ${g.error || 'spawn thất bại'}` }
      // spawnAndWait đã spawn bridge kèm gateway — poll health bên dưới xác nhận
    } else {
      // Gateway lên (có thể orphan do spawn thủ công) → adopt cho idle-watchdog
      // quản dọn cả hai khi hết dùng
      s.running = true
      s.lastProbeOk = Date.now()
    }

    // 3. Bridge process sống nhưng mất kết nối → force reconnect; bridge down → spawn
    const st = await probeBridgeState(1500)
    if (st === 'disconnected') {
      try {
        await fetch(`http://127.0.0.1:${BRIDGE_PORT}/reconnect`, { method: 'POST', signal: AbortSignal.timeout(10_000) })
        console.log('[openclaw-ondemand] Bridge mất WS gateway → đã POST /reconnect')
      } catch { /* bridge chết giữa chừng — poll bên dưới sẽ không lên → fail rõ ràng */ }
    } else if (st === 'down') {
      s.bridgeChild = spawnService('mini-services/gateway-bridge', {})
      if (!s.bridgeChild) {
        return { online: false, error: 'spawn gateway-bridge (18791) thất bại' }
      }
    }

    // 4. Poll đến khi bridge CONNECTED (không chỉ /health OK) — 500ms/lần, tối đa 12s
    const budget = opts?.timeoutMs ?? BRIDGE_STARTUP_TIMEOUT_MS
    const deadline = Date.now() + budget
    while (Date.now() < deadline) {
      if ((await probeBridgeState(1500)) === 'connected') {
        console.log('[openclaw-ondemand] Bridge (18791) CONNECTED (ensureBridgeRunning)')
        return { online: true, started: true }
      }
      await new Promise(r => setTimeout(r, BRIDGE_POLL_INTERVAL_MS))
    }
    return { online: false, error: `bridge (18791) không connect-OK sau ${Math.round(budget / 1000)}s` }
  }
}

/**
 * Báo lỗi bridge mà KHÔNG ném exception ra caller — gateway vẫn trả
 * online:true (app dùng được fallback paths), chỉ mất 36 gateway tools.
 * Dùng probeBridge() để nêu rõ bridge chết hẳn hay chỉ chưa connect-OK.
 */
async function warnBridgeFail(reason: string, detail: string): Promise<void> {
  const listening = await probeBridge(1500)
  console.warn(`[openclaw-ondemand] Gateway OK nhưng BRIDGE (18791) không lên [${reason}] → 36 gateway tools không dùng được: ${detail}${listening ? ' (bridge process sống, chưa connect-OK)' : ' (không có process nào lắng nghe 18791)'}`)
}

async function spawnAndWait(timeoutMs: number, ensureBridge = true): Promise<{ online: boolean; started?: boolean; error?: string }> {
  const s = getState()
  // ensureBridge=false: đang được gọi từ chuỗi ensureBridgeRunning → KHÔNG
  // gọi lại ensureBridgeRunning (tránh đệ quy / deadlock vòng await)
  const wantBridge = ensureBridge !== false

  // WINDOWS FAST-FAIL (fix review 2026-09-08): binary openclaw là symlink POSIX
  // (node_modules/.bin/openclaw — không có .cmd) → trên Windows KHÔNG chạy
  // được; poll health đủ 45s chỉ làm request (vd mở tab Channels) treo vô ích
  // lặp lại sau mỗi cooldown. Fast-fail ngay kèm lý do rõ ràng. Set
  // OPENCLAW_FORCE_SPAWN=true để ép thử khi openclaw hỗ trợ Windows.
  if (process.platform === 'win32' && process.env.OPENCLAW_FORCE_SPAWN !== 'true') {
    s.lastSpawnFailed = Date.now()
    const reason = 'openclaw gateway binary không chạy được trên Windows (symlink POSIX) — app dùng fallback paths (chat trực tiếp LLM, Code Studio in-process). Set OPENCLAW_FORCE_SPAWN=true để ép thử.'
    console.warn(`[openclaw-ondemand] ${reason}`)
    return { online: false, error: reason }
  }

  console.log(`[openclaw-ondemand] Gateway offline — spawning on-demand (timeout ${Math.round(timeoutMs / 1000)}s)...`)

  // Manager gateway: spawn node bun index.ts (manager tự spawn binary openclaw
  // + ghi PID files + có logic takeover chống trùng instance)
  s.gatewayChild = spawnService('mini-services/openclaw-gateway', {
    NVIDIA_API_KEY: process.env.NVIDIA_API_KEY_1 || '',
    NVIDIA_API_KEY_1: process.env.NVIDIA_API_KEY_1 || '',
    NVIDIA_API_KEY_2: process.env.NVIDIA_API_KEY_2 || '',
    NVIDIA_API_KEY_3: process.env.NVIDIA_API_KEY_3 || '',
    NVIDIA_API_KEY_4: process.env.NVIDIA_API_KEY_4 || '',
  })

  if (!s.gatewayChild) {
    s.lastSpawnFailed = Date.now()
    return { online: false, error: 'spawn gateway manager failed' }
  }

  // Poll health đến khi OK
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (await probeGateway(2000)) {
      s.running = true
      s.lastProbeOk = Date.now()
      s.lastUsed = Date.now()
      // Bridge theo sau (ws client — kết nối ngay khi gateway sẵn sàng).
      // ensureBridge=false khi chính ensureBridgeRunning đang gọi vào đây →
      // không gọi lại (tránh tự await chính bridgePromise của nó).
      if (wantBridge) {
        try {
          const b = await ensureBridgeRunning()
          if (!b.online) await warnBridgeFail('spawnAndWait gateway health-OK', b.error || 'unknown reason')
        } catch (err) {
          await warnBridgeFail('spawnAndWait gateway health-OK', err instanceof Error ? err.message : String(err))
        }
      }
      const elapsed = Math.round((Date.now() - start) / 1000)
      console.log(`[openclaw-ondemand] Gateway ONLINE sau ${elapsed}s (on-demand) + bridge đã đảm bảo`)
      return { online: true, started: true }
    }
    await new Promise(r => setTimeout(r, 1000))
  }

  s.lastSpawnFailed = Date.now()
  // SPAWN-FAIL CLEANUP (fix review 2026-09-08): health không OK sau timeout
  // → KILL manager + bridge đã spawn. Nếu không, manager (có auto-restart 3s
  // không giới hạn lần) chạy mãi mãi ngầm và idle-watchdog không bao giờ dọn
  // (vì s.running=false) → leak RAM + crash-loop vô tận.
  try {
    await shutdownIdleGateway('spawn-fail cleanup — health không OK sau timeout')
  } catch { /* best-effort */ }
  const reason = `gateway không health-OK sau ${Math.round(timeoutMs / 1000)}s (Windows local: binary openclaw không chạy được — app fallback bình thường)`
  console.warn(`[openclaw-ondemand] ${reason}`)
  return { online: false, error: reason }
}

/**
 * Đảm bảo gateway đang chạy — spawn on-demand nếu cần.
 * * KHÔNG gọi hàm này từ health check / status polling (sẽ tự spawn vô tận) —
 *   chỉ gọi từ các tính năng THẬT SỰ cần gateway (chat fallback, channels,
 *   skills, sessions...).
 */
export async function ensureGatewayRunning(opts?: { timeoutMs?: number; ensureBridge?: boolean }): Promise<{ online: boolean; started?: boolean; error?: string }> {
  const s = getState()
  // ensureBridge=false: đang được gọi từ ensureBridgeRunning → tuyệt đối
  // không spawn bridge ở đây (tránh đệ quy / deadlock vòng).
  const wantBridge = opts?.ensureBridge !== false
  gatewayInUse() // caller có ý định dùng → reset đồng hồ idle

  if (!isOnDemandEnabled()) {
    // Legacy mode: passive probe (giữ behavior cũ — instrumentation đã spawn sẵn)
    const online = await probeGateway(3000)
    if (online) {
      s.running = true
      s.lastProbeOk = Date.now()
      if (wantBridge) {
        try {
          const b = await ensureBridgeRunning()
          if (!b.online) await warnBridgeFail('legacy mode (on-demand off)', b.error || 'unknown reason')
        } catch (err) {
          await warnBridgeFail('legacy mode (on-demand off)', err instanceof Error ? err.message : String(err))
        }
      }
    }
    return { online }
  }

  // Cache ngắn: đang chạy + probe gần đây → trả ngay (không fetch mỗi call)
  if (s.running && Date.now() - s.lastProbeOk < RUNNING_CACHE_TTL_MS) {
    // ĐƯỜNG THOÁT SỚM #1: gateway OK nhưng bridge có thể chết/crash → trước đây
    // nhánh này trả online:true mà KHÔNG spawn bridge → 36 tools chết
    // "gateway-bridge unreachable (port 18791)".
      if (wantBridge) {
        try {
          const b = await ensureBridgeRunning()
          if (!b.online) await warnBridgeFail('cache-hit (gateway OK, bridge chưa kệm chạy)', b.error || 'unknown reason')
        } catch (err) {
          await warnBridgeFail('cache-hit (gateway OK, bridge chưa kệm chạy)', err instanceof Error ? err.message : String(err))
        }
      }
    return { online: true }
  }

  // Đang chạy thật? (orphan từ lần trước / legacy spawn)
  if (await probeGateway(2500)) {
    s.running = true
    s.lastProbeOk = Date.now()
    s.lastUsed = Date.now()
    // ĐƯỜNG THOÁT SỚM #2: adopt gateway orphan (có thể bridge chưa từng
    // được spawn) → phải đảm bảo bridge trước khi trả online.
      if (wantBridge) {
        try {
          const b = await ensureBridgeRunning()
          if (!b.online) await warnBridgeFail('adopt orphan gateway', b.error || 'unknown reason')
        } catch (err) {
          await warnBridgeFail('adopt orphan gateway', err instanceof Error ? err.message : String(err))
        }
      }
    return { online: true } // adopt — không spawn trùng
  }

  // Đang spawn (call khác) → share promise
  if (s.spawnPromise) return s.spawnPromise

  // Cooldown sau fail — fast-fail để không treo mỗi request
  if (Date.now() - s.lastSpawnFailed < SPAWN_FAIL_COOLDOWN_MS) {
    return { online: false, error: 'spawn gần đây thất bại — đang trong cooldown' }
  }

  s.spawnPromise = spawnAndWait(opts?.timeoutMs ?? SPAWN_TIMEOUT_MS, wantBridge).finally(() => {
    s.spawnPromise = null
  })
  return s.spawnPromise
}

// ==================== WATCHDOG (idle shutdown + adopt orphan) ====================

/**
 * Đăng ký watchdog — gọi 1 lần từ instrumentation khi on-demand bật:
 *   - Probe sau boot: gateway orphan còn chạy từ process trước → adopt (để
 *     idle-timer quản được, tránh_gateway chạy mãi không ai tắt)
 *   - Interval: hết IDLE_SHUTDOWN_MS không dùng → tắt gateway + bridge
 */
export function initOnDemandWatchdog(): void {
  const s = getState()
  if (s.timerRegistered) return
  s.timerRegistered = true

  // Adopt orphan sau boot (đợi app đỡ bận)
  setTimeout(async () => {
    try {
      if (await probeGateway(2500)) {
        s.running = true
        s.lastProbeOk = Date.now()
        // FIX round-11c: KHÔNG reset lastUsed = Date.now() khi adopt — mỗi lần
        // app restart đồng hồ idle lại về 0 → gateway orphan không bao giờ bị
        // tắt trong khi app restart liên tục. Dùng lần-dùng-thật cuối (persist
        // qua file) → nếu gateway đã idle quá IDLE_SHUTDOWN_MS, tick 30s kế
        // sẽ shutdownIdleGateway() đúng thiết kế on-demand.
        const persisted = persistedLastUse()
        s.lastUsed = persisted > 0 ? persisted : Date.now()
        const idleMin = persisted > 0 ? Math.round((Date.now() - persisted) / 60000) : 0
        console.log(`[openclaw-ondemand] Phát hiện gateway đang chạy (orphan/legacy) → adopt (last-use ${idleMin}′ trước — sẽ tự tắt sau idle nếu không dùng)`)
      }
    } catch { /* bỏ qua */ }
  }, 8000).unref?.()

  // Idle shutdown timer
  if (IDLE_SHUTDOWN_MS > 0) {
    const timer = setInterval(async () => {
      const st = getState()
      if (!st.running || st.shuttingDown || st.spawnPromise) return
      if (Date.now() - st.lastUsed < IDLE_SHUTDOWN_MS) return
      // Xác nhận lại gateway còn chạy thật không (có thể tự chết)
      if (!(await probeGateway(2000))) {
        st.running = false
        return
      }
      await shutdownIdleGateway()
    }, IDLE_CHECK_INTERVAL_MS)
    timer.unref?.()
    console.log(`[openclaw-ondemand] Watchdog: gateway sẽ tự tắt sau ${Math.round(IDLE_SHUTDOWN_MS / 60000)} phút không dùng`)
  }
}
