/**
 * OpenCode Server Manager — Magnum Opus
 * 
 * Spawns the OpenCode Hono server as a child process and keeps it alive.
 * Uses stdio: 'pipe' to prevent terminal inheritance issues.
 * 
 * Port: 18790
 */

import { spawn, execSync, ChildProcess } from 'child_process'
import { createServer } from 'net'
import { resolve } from 'path'
import { writeFileSync, readFileSync, unlinkSync, existsSync } from 'fs'

const PORT = 18790
const PID_FILE = resolve(__dirname, '.pid')
const MANAGER_PID_FILE = resolve(__dirname, '.manager.pid')
const SERVER_SCRIPT = resolve(__dirname, 'server.ts')

let serverProcess: ChildProcess | null = null
let isShuttingDown = false

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
 *  actually free (max 5s) before spawning the replacement server. */
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

async function waitForPortFree(port: number, maxWaitMs = 5000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < maxWaitMs) {
    if (await isPortFree(port)) return
    await new Promise(r => setTimeout(r, 200))
  }
  console.warn(`[opencode-manager] Port ${port} still busy after ${maxWaitMs}ms — spawning anyway`)
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
          process.kill(pid, 'SIGKILL')
        }
      }
      unlinkSync(PID_FILE)
    } catch { /* ignore */ }
  }
}

/** Audit fix 2026-08-25 (part 2): orphaned server may hold port 18790 with a
 *  PID that is NOT in the PID file (e.g. PM2 SIGKILL'd the previous manager
 *  before its shutdown hook unlinked the file). Kill by PORT via lsof. */
function killPortHolders(port: number): void {
  try {
    const out = execSync(`lsof -ti :${port} 2>/dev/null || true`, { encoding: 'utf-8', timeout: 3000 })
    const pids = out.split('\n').map(s => s.trim()).filter(s => /^\d+$/.test(s))
    for (const pidStr of pids) {
      const pid = parseInt(pidStr, 10)
      if (pid === process.pid) continue // never kill ourselves
      try {
        console.log(`[opencode-manager] Killing port ${port} holder PID ${pid}...`)
        process.kill(pid, 'SIGKILL')
      } catch { /* already dead */ }
    }
    if (pids.length > 0) {
      // give the OS a beat to release the sockets
      const start = Date.now()
      while (Date.now() - start < 1000) { /* brief settle */ }
    }
  } catch { /* lsof unavailable or failed — non-fatal */ }
}

async function startServer(): Promise<void> {
  killExistingManager()
  killExisting()
  // Audit fix part 2: kill orphaned port holders (PID not in PID file)
  if (!(await isPortFree(PORT))) {
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
  
  serverProcess.on('error', (err) => {
    console.error('[opencode-manager] Failed to start server:', err)
    cleanup()
    if (!isShuttingDown) {
      setTimeout(() => { if (!isShuttingDown) startServer() }, 3000)
    }
  })
  
  serverProcess.on('exit', (code, signal) => {
    if (code !== null) {
      console.log(`[opencode-manager] Server exited with code ${code}`)
    } else if (signal !== null) {
      console.log(`[opencode-manager] Server killed by signal ${signal}`)
    }
    cleanup()
    if (!isShuttingDown) {
      console.log('[opencode-manager] Server crashed, restarting in 3s...')
      setTimeout(() => { if (!isShuttingDown) startServer() }, 3000)
    }
  })
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
