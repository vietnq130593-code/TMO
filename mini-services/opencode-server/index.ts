/**
 * OpenCode Server Manager — Magnum Opus
 *
 * Spawns the OpenCode Hono server as a child process and keeps it alive.
 * Uses stdio: 'pipe' to prevent terminal inheritance issues.
 *
 * Port: 18790 (default)
 *
 * FIX 2026-10-15 (user report local Windows — EADDRINUSE crash loop):
 *   "error: Failed to start server. Is port 18790 in use?" → server exit 1 →
 *   manager restart 3s → lặp vô hạn.
 *   Root cause: killPortHolders() dùng `lsof` — lệnh LINUX. Windows không có
 *   lsof → try/catch nuốt lỗi → port mồ côi (bun.exe cũ SIGKILL kịp, socket
 *   chưa release, hoặc process mồ côi PID không còn trong .pid file) KHÔNG
 *   BAO GIỜ được dọn → mọi lần spawn đều EADDRINUSE.
 *   Fix tổng thể:
 *   (1) findPortHolderPids() cross-platform: Windows `netstat -ano` +
 *       `taskkill /F /T`, Unix giữ lsof + fallback `ss -ltnp`.
 *   (2) server.ts bắt lỗi Bun.serve → exit code 47 (marker EADDRINUSE) →
 *       manager biết chắc là port-conflict để dọn đúng hướng.
 *   (3) MULTI-INSTANCE GUARD: TMO-main (E:\APP\TMO-main) và TMO-clone
 *       (E:\APP\TMO-clone) chạy song song đều mặc định 18790. Nếu manager này
 *       kill server của thư mục kia thì manager kia lại kill lại của mình —
 *       ping-pong vô hạn (đã từng xảy ra với 407 SIGTERM kills). Giờ manager
 *       PROBE /health của port-holder: server trả kèm root (thư mục app) +
 *       pid → cùng thư mục = orphan cũ của chính mình (kill được), khác thư
 *       mục = instance khác (KHÔNG kill — log hướng dẫn đặt
 *       OPENCODE_SERVER_PORT riêng, chờ 15s thử lại).
 *   (4) Crash backoff: restart 3s → 6s → 12s → 24s → 30s (reset khi server
 *       sống ≥ 60s) — hết vòng lặp nóng 3s spam log.
 */

import { spawn, execSync, ChildProcess } from 'child_process'
import { createServer } from 'net'
import { resolve } from 'path'
import { writeFileSync, readFileSync, unlinkSync, existsSync } from 'fs'

// FIX 2026-09-15: port từ env (mặc định 18790 như cũ). Trước đây HARDCODE
// 18790 → mọi app instance (production + clone kiểm định) tranh nhau 1 port,
// manager killPortHolders ping-pong SIGKILL server của nhau. Multi-instance
// đặt OPENCODE_SERVER_PORT riêng (vd clone chạy app để kiểm định: 18791).
const PORT = parseInt(process.env.OPENCODE_SERVER_PORT || '18790', 10)
const PID_FILE = resolve(__dirname, '.pid')
const MANAGER_PID_FILE = resolve(__dirname, '.manager.pid')
const SERVER_SCRIPT = resolve(__dirname, 'server.ts')

// FIX 2026-10-15: identity của instance này (thư mục app — VD E:\APP\TMO-main
// hay E:\APP\TMO-clone) — dùng so với /health.root của server đang giữ port.
const IS_WIN = process.platform === 'win32'
const APP_ROOT = resolve(__dirname, '..', '..')
// server.ts exit 47 = marker "port bận" (EADDRINUSE) — manager dọn port trước khi restart
const EXIT_PORT_BUSY = 47

let serverProcess: ChildProcess | null = null
let isShuttingDown = false
// Crash-loop backoff: reset khi server sống ổn ≥ 60s
let crashCount = 0
let serverStartedAt = 0
// Anti-spam: log cảnh báo "port bị instance khác giữ" tối đa 1 lần/phút
let lastForeignWarningAt = 0

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Audit fix 2026-08-25: EADDRINUSE crash loop on every PM2 restart.
 *  killExisting() kills the old PID, but the OS may hold port 18790 a beat
 *  longer (SIGTERM teardown + TIME_WAIT). Probe the port and WAIT until it is
 *  actually free (max 10s — tăng từ 5s cho Windows chậm release) before
 *  spawning the replacement server. */
function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const tester = createServer()
    tester.once('error', () => resolvePromise(false))
    tester.once('listening', () => {
      tester.close(() => resolvePromise(true))
    })
    tester.listen({ port, host: '127.0.0.1' })
  })
}

async function waitForPortFree(port: number, maxWaitMs = 10_000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < maxWaitMs) {
    if (await isPortFree(port)) return
    await new Promise(r => setTimeout(r, 200))
  }
  console.warn(`[opencode-manager] Port ${port} still busy after ${maxWaitMs}ms — spawning anyway`)
}

/**
 * FIX 2026-10-15 (Windows): liệt kê PID đang LISTEN trên port — CROSS-PLATFORM.
 *   Windows : `netstat -ano -p tcp` (lsof không tồn tại) → parse cột.
 *   Unix    : `lsof -ti :PORT`, fallback `ss -ltnp` (máy không cài lsof).
 * Trả về [] nếu không tìm thấy / lệnh không khả dụng (non-fatal).
 */
function findPortHolderPids(port: number): number[] {
  const pids = new Set<number>()
  try {
    if (IS_WIN) {
      // Dạng dòng:  TCP    127.0.0.1:18790    0.0.0.0:0    LISTENING    4716
      //              TCP    [::1]:18790       [::]:0       LISTENING    4716
      const out = execSync('netstat -ano -p tcp', {
        encoding: 'utf8',
        timeout: 5000,
        windowsHide: true,
      })
      for (const line of out.split('\n')) {
        const cols = line.trim().split(/\s+/)
        if (cols.length < 5 || !/^tcp$/i.test(cols[0])) continue
        const localAddr = cols[1] || ''
        const state = cols[3] || ''
        const pidStr = cols[cols.length - 1]
        const portMatch = localAddr.match(/:(\d+)$/)
        if (
          portMatch &&
          parseInt(portMatch[1], 10) === port &&
          /^LISTENING$/i.test(state) &&
          /^\d+$/.test(pidStr)
        ) {
          pids.add(parseInt(pidStr, 10))
        }
      }
    } else {
      try {
        const out = execSync(`lsof -ti :${port} 2>/dev/null || true`, { encoding: 'utf-8', timeout: 3000 })
        for (const s of out.split('\n')) {
          const v = s.trim()
          if (/^\d+$/.test(v)) pids.add(parseInt(v, 10))
        }
      } catch { /* lsof unavailable — thử ss */ }
      if (pids.size === 0) {
        try {
          // LISTEN 0 5 127.0.0.1:18790 0.0.0.0:* users:(("bun",pid=1234,fd=20))
          const out = execSync(`ss -ltnp 2>/dev/null || true`, { encoding: 'utf-8', timeout: 3000 })
          for (const line of out.split('\n')) {
            if (!line.includes(`:${port} `)) continue
            const pidMatch = line.match(/pid=(\d+)/)
            if (pidMatch) pids.add(parseInt(pidMatch[1], 10))
          }
        } catch { /* ss unavailable — non-fatal */ }
      }
    }
  } catch { /* non-fatal */ }
  return [...pids]
}

/**
 * FIX 2026-10-15 (Windows): kill PID — CROSS-PLATFORM.
 *   Windows : `taskkill /F /T /PID` (SIGKILL không terminate process tree Bun).
 *   Unix    : process.kill(pid, 'SIGKILL') như cũ.
 */
function killPid(pid: number): void {
  if (pid === process.pid) return // never kill ourselves
  try {
    if (IS_WIN) {
      execSync(`taskkill /F /T /PID ${pid}`, { timeout: 5000, windowsHide: true, stdio: 'ignore' })
    } else {
      process.kill(pid, 'SIGKILL')
    }
  } catch { /* already dead — non-fatal */ }
}

/** Chuẩn hóa đường dẫn để so sánh root giữa manager và /health của server:
 *  same-separator (/), bỏ / cuối; Windows case-insensitive. */
function normRoot(p: string): string {
  let norm = p.replace(/\\/g, '/')
  if (norm.endsWith('/')) norm = norm.slice(0, -1)
  return IS_WIN ? norm.toLowerCase() : norm
}

type PortOwner =
  /** Không ai giữ (probe /health không cần) */
  | { kind: 'free' }
  /** OpenCode server của THƯ MỤC KHÁC (TMO-clone chạy song song...) — KHÔNG kill */
  | { kind: 'foreign'; root?: string; pid?: number }
  /** OpenCode server orphan cũ của CHÍNH thư mục này — kill được, an toàn */
  | { kind: 'own'; root?: string; pid?: number }
  /** Port bị giữ nhưng KHÔNG phải OpenCode server sống (process lạ / half-dead) */
  | { kind: 'stranger' }

/**
 * MULTI-INSTANCE GUARD (fix 2026-10-15): trước khi kill ai đang giữ port,
 * probe /health của holder đó. server.ts (bản mới) trả kèm { root, pid } —
 * root là thư mục app của server (vd E:\APP\TMO-main vs E:\APP\TMO-clone):
 *   - cùng root  → orphan của chính mình (PID file mất sau crash) → kill.
 *   - khác root  → instance khác đang chạy → KHÔNG KILL (tránh 2 manager
 *                  SIGKILL server của nhau qua lại vô hạn) — chờ + hướng dẫn.
 *   - 401/403    → OpenCode server KHÁC TOKEN → chắc chắn thư mục khác →foreign.
 *   - không đáp ứng HTTP / không phải JSON health → stranger (process lạ,
 *     half-open socket) → dọn như cũ.
 */
async function probePortOwner(port: number): Promise<PortOwner> {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), 1500)
  try {
    const headers: Record<string, string> = {}
    if (process.env.TMO_API_TOKEN) headers['X-TMO-API-Token'] = process.env.TMO_API_TOKEN
    const res = await fetch(`http://127.0.0.1:${port}/health`, { headers, signal: ctl.signal })
    if (res.status === 401 || res.status === 403) {
      // OpenCode server sống nhưng token khác (TMO_API_TOKEN per-instance)
      return { kind: 'foreign' }
    }
    const data = (await res.json().catch(() => null)) as
      | { ok?: boolean; root?: string; pid?: number }
      | null
    if (data && data.ok === true && typeof data.root === 'string') {
      const same = normRoot(data.root) === normRoot(APP_ROOT)
      return {
        kind: same ? 'own' : 'foreign',
        root: data.root,
        pid: typeof data.pid === 'number' ? data.pid : undefined,
      }
    }
    return { kind: 'stranger' } // HTTP nhưng không phải OpenCode server
  } catch {
    // Connect refused/reset — port bị giữ bởi process không phải HTTP server
    // (hoặc server đã chết giữa chừng) → dọn được
    return { kind: 'stranger' }
  } finally {
    clearTimeout(timer)
  }
}

/** Root-cause fix (2026-08-25 post-deploy audit): MANAGER TAKEOVER.
 *  Symptom: 407 SIGTERM kills / endless respawn ping-pong. Two manager
 *  instances (old orphan + new) both ran startServer(); each killed the
 *  OTHER manager's server child via the shared .pid file, and the victim's
 *  manager respawned it — forever.
 *  Fix: before touching the server, a new manager SIGTERMs the OLD MANAGER
 *  process itself (which gracefully reaps its own server child), waits for
 *  it to die, then proceeds. Exactly one manager survives — the newest. */
function killExistingManager(): void {
  if (!existsSync(MANAGER_PID_FILE)) return
  try {
    const pid = parseInt(readFileSync(MANAGER_PID_FILE, 'utf-8').trim(), 10)
    if (!isNaN(pid) && pid !== process.pid && isProcessRunning(pid)) {
      console.log(`[opencode-manager] Takeover: stopping previous manager (PID ${pid})...`)
      try { process.kill(pid, 'SIGTERM') } catch { /* already dead */ }
      const start = Date.now()
      while (isProcessRunning(pid) && Date.now() - start < 8000) { /* busy wait */ }
      if (isProcessRunning(pid)) {
        console.log(`[opencode-manager] Takeover: force killing previous manager (PID ${pid})`)
        try { process.kill(pid, 'SIGKILL') } catch { /* already dead */ }
        // also reap any server child it left behind via port holders below
      }
    }
    unlinkSync(MANAGER_PID_FILE)
  } catch { /* ignore */ }
}

function killExisting(): void {
  if (existsSync(PID_FILE)) {
    try {
      const pid = parseInt(readFileSync(PID_FILE, 'utf-8').trim(), 10)
      if (!isNaN(pid) && isProcessRunning(pid)) {
        console.log(`[opencode-manager] Stopping existing server (PID ${pid})...`)
        process.kill(pid, 'SIGTERM')
        const start = Date.now()
        while (isProcessRunning(pid) && Date.now() - start < 5000) { /* busy wait */ }
        if (isProcessRunning(pid)) {
          killPid(pid) // FIX 2026-10-15: taskkill /F /T trên Windows (SIGKILL node không luôn đủ)
        }
      }
      unlinkSync(PID_FILE)
    } catch { /* ignore */ }
  }
}

/** Audit fix 2026-08-25 (part 2) — NÂNG CẤP CROSS-PLATFORM 2026-10-15: kill mọi
 *  process đang LISTEN port (PID không nằm trong PID file — orphan sau crash).
 *  Windows dùng netstat + taskkill (lsof không tồn tại → đây chính là root
 *  cause của crash loop EADDRINUSE trên máy local user). */
function killPortHolders(port: number): void {
  const pids = findPortHolderPids(port)
  for (const pid of pids) {
    if (pid === process.pid) continue // never kill ourselves
    console.log(`[opencode-manager] Killing port ${port} holder PID ${pid}...`)
    killPid(pid)
  }
  if (pids.length > 0) {
    // give the OS a beat to release the sockets
    const start = Date.now()
    while (Date.now() - start < 1000) { /* brief settle */ }
  }
}

async function startServer(): Promise<void> {
  killExistingManager()
  killExisting()

  // ==== PORT OWNERSHIP (fix 2026-10-15) ====
  const holders = findPortHolderPids(PORT)
  if (holders.length > 0 || !(await isPortFree(PORT))) {
    const owner = await probePortOwner(PORT)

    if (owner.kind === 'foreign') {
      // ⛔ KHÔNG kill server của thư mục khác — 2 manager sẽ giành port qua lại
      // vô hạn (ping-pong SIGKILL). Log hướng dẫn + chờ 15s thử lại (không spawn
      // → không crash-loop 3s như cũ).
      if (Date.now() - lastForeignWarningAt > 60_000) {
        lastForeignWarningAt = Date.now()
        console.error(`[opencode-manager] ⚠️ Port ${PORT} đang bị OpenCode server của THƯ MỤC KHÁC giữ${owner.root ? ` (root: ${owner.root})` : ''}${owner.pid ? ` — PID ${owner.pid}` : ''}.`)
        console.error(`[opencode-manager]    Không kill để tránh 2 instance tranh port qua lại (ping-pong vô hạn).`)
        console.error(`[opencode-manager]    → Nếu đang chạy 2 thư mục song song (vd TMO-main + TMO-clone): đặt OPENCODE_SERVER_PORT khác trong .env của thư mục NÀY (vd ${PORT + 1}) rồi restart app.`)
        console.error(`[opencode-manager]    → Nếu thư mục kia đã TẮT mà port vẫn bận: process mồ côi còn sống — kill thủ công PID ${owner.pid ?? '(xem netstat -ano)'} rồi app tự nối lại.`)
        console.error(`[opencode-manager]    Chờ 15s rồi tự thử lại...`)
      }
      setTimeout(() => { if (!isShuttingDown) startServer() }, 15_000)
      return
    }

    if (owner.kind === 'own') {
      // Server orphan cũ của CHÍNH thư mục này (PID file mất sau crash) → dọn
      console.log(`[opencode-manager] Port ${PORT} bị server cũ CÙNG thư mục giữ (PID ${owner.pid ?? '?'}) — killing để takeover...`)
      if (owner.pid && !holders.includes(owner.pid)) killPid(owner.pid)
    } else if (owner.kind === 'stranger') {
      console.log(`[opencode-manager] Port ${PORT} bị process lạ (không phải OpenCode server) giữ (PIDs: ${holders.join(', ') || 'không rõ'}) — killing để giải phóng...`)
    }
    killPortHolders(PORT)
  }
  await waitForPortFree(PORT)

  // Singleton claim: only after the previous manager is dead do we take the lock.
  try { writeFileSync(MANAGER_PID_FILE, String(process.pid)) } catch { /* non-fatal */ }

  console.log(`[opencode-manager] Starting OpenCode server on port ${PORT}...`)

  serverProcess = spawn('bun', [SERVER_SCRIPT], {
    cwd: __dirname,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      OPENCODE_SERVER_PORT: String(PORT),
      OPENCODE_WORKSPACE: process.env.OPENCODE_WORKSPACE || '.',
    },
  })

  // Pipe server output to manager console
  serverProcess.stdout?.on('data', (data: Buffer) => {
    console.log(data.toString().trim())
  })

  serverProcess.stderr?.on('data', (data: Buffer) => {
    console.error(`[server-err] ${data.toString().trim()}`)
  })

  if (serverProcess.pid) {
    writeFileSync(PID_FILE, String(serverProcess.pid))
    console.log(`[opencode-manager] Server PID: ${serverProcess.pid}`)
  }

  serverStartedAt = Date.now()

  serverProcess.on('error', (err) => {
    console.error('[opencode-manager] Failed to start server:', err)
    cleanup()
    if (!isShuttingDown) {
      setTimeout(() => { if (!isShuttingDown) startServer() }, restartDelayMs())
    }
  })

  serverProcess.on('exit', (code, signal) => {
    if (code !== null) {
      console.log(`[opencode-manager] Server exited with code ${code}`)
      if (code === EXIT_PORT_BUSY) {
        console.error(`[opencode-manager] Exit ${EXIT_PORT_BUSY} = PORT BẬN (EADDRINUSE) — sẽ dọn port cross-platform (netstat/taskkill trên Windows) trước khi restart`)
      }
    } else if (signal !== null) {
      console.log(`[opencode-manager] Server killed by signal ${signal}`)
    }
    cleanup()
    if (!isShuttingDown) {
      const delay = restartDelayMs()
      console.log(`[opencode-manager] Server crashed, restarting in ${Math.round(delay / 1000)}s... (chuỗi lỗi liên tiếp #${crashCount})`)
      setTimeout(() => { if (!isShuttingDown) startServer() }, delay)
    }
  })
}

/**
 * FIX 2026-10-15 — BACKOFF: restart 3s → 6s → 12s → 24s → 30s (mũ 2, cap 30s).
 * Reset khi server sống ổn định ≥ 60s — lỗi lẻ tắc không bị phạt, chuỗi lỗi
 * thật sự (port kẹt, OOM...) thì thưa dần thay vì spam log 3s/lần vô hạn.
 */
function restartDelayMs(): number {
  const stableMs = serverStartedAt > 0 ? Date.now() - serverStartedAt : 0
  crashCount = stableMs > 60_000 ? 0 : crashCount + 1
  return Math.min(3_000 * 2 ** Math.min(crashCount - 1, 4), 30_000)
}

function cleanup(): void {
  try { if (existsSync(PID_FILE)) unlinkSync(PID_FILE) } catch { /* ignore */ }
  serverProcess = null
}

function cleanupManagerLock(): void {
  // Only remove the lock if WE own it (a newer manager may have claimed it).
  try {
    if (existsSync(MANAGER_PID_FILE)) {
      const pid = parseInt(readFileSync(MANAGER_PID_FILE, 'utf-8').trim(), 10)
      if (isNaN(pid) || pid === process.pid) unlinkSync(MANAGER_PID_FILE)
    }
  } catch { /* ignore */ }
}

function shutdown(): void {
  if (isShuttingDown) return
  isShuttingDown = true

  if (serverProcess && !serverProcess.killed) {
    console.log('[opencode-manager] Shutting down server...')
    serverProcess.kill('SIGTERM')
    setTimeout(() => {
      if (serverProcess && !serverProcess.killed) {
        serverProcess.kill('SIGKILL')
      }
      cleanup()
      process.exit(0)
    }, 5000)
  } else {
    cleanup()
    process.exit(0)
  }
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

// Final safety net: never leave a stale manager lock behind on exit.
process.on('exit', cleanupManagerLock)

startServer()
