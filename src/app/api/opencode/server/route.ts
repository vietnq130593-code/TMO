import { NextResponse } from 'next/server'
import { isOpenCodeOnline, getOpenCodeInfo } from '@/lib/opencode'
import { execSync, spawn } from 'child_process'
import { existsSync, readFileSync } from 'fs'
import { resolve } from 'path'
import { getProjectRoot } from '@/lib/paths'

export const dynamic = 'force-dynamic'

// The actual OpenCode server process runs as "bun server.ts" from the opencode-server directory
// We use PID file for reliable targeting, with pkill as fallback
const OPENCODE_PID_FILE = resolve(getProjectRoot(), 'mini-services', 'opencode-server', '.pid')
const OPENCODE_DIR = resolve(getProjectRoot(), 'mini-services', 'opencode-server')
const IS_WIN = process.platform === 'win32'
const OPENCODE_PORT = parseInt(process.env.OPENCODE_SERVER_PORT || '18790', 10)

/**
 * FIX 2026-10-15 (local Windows): tìm PID đang LISTEN port — CROSS-PLATFORM.
 * Windows: netstat -ano (lsof/fuser không tồn tại). Unix: lsof, fallback ss.
 */
function findPortHolderPids(port: number): number[] {
  const pids = new Set<number>()
  try {
    if (IS_WIN) {
      const out = execSync('netstat -ano -p tcp', { encoding: 'utf8', timeout: 5000, windowsHide: true })
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
      } catch { /* lsof unavailable */ }
      if (pids.size === 0) {
        try {
          const out = execSync('ss -ltnp 2>/dev/null || true', { encoding: 'utf-8', timeout: 3000 })
          for (const line of out.split('\n')) {
            if (!line.includes(`:${port} `)) continue
            const pidMatch = line.match(/pid=(\d+)/)
            if (pidMatch) pids.add(parseInt(pidMatch[1], 10))
          }
        } catch { /* ss unavailable */ }
      }
    }
  } catch { /* non-fatal */ }
  return [...pids]
}

function killPid(pid: number): void {
  if (pid === process.pid) return
  try {
    if (IS_WIN) {
      execSync(`taskkill /F /T /PID ${pid}`, { timeout: 5000, windowsHide: true, stdio: 'ignore' })
    } else {
      process.kill(pid, 'SIGKILL')
    }
  } catch { /* already dead */ }
}

function killOpenCodeServer(): boolean {
  // Strategy 1: Use PID file (most reliable)
  try {
    if (existsSync(OPENCODE_PID_FILE)) {
      const pid = parseInt(readFileSync(OPENCODE_PID_FILE, 'utf-8').trim())
      if (pid && !isNaN(pid)) {
        try {
          killPid(pid) // FIX 2026-10-15: taskkill /F /T trên Windows
          return true
        } catch {
          // Process may have already exited
        }
      }
    }
  } catch { /* ignore */ }

  // Strategy 2: pkill with actual command pattern (Unix)
  if (!IS_WIN) {
    try {
      execSync('pkill -f "bun server.ts" 2>/dev/null || true', { timeout: 5000 })
      return true
    } catch { /* ignore */ }
  }

  // Strategy 3: Kill by port — CROSS-PLATFORM (netstat + taskkill on Windows)
  const pids = findPortHolderPids(OPENCODE_PORT)
  for (const pid of pids) {
    if (pid === process.pid) continue
    killPid(pid)
  }
  return pids.length > 0
}

/**
 * Spawn opencode-server DETACHED (nohup-equivalent cross-platform):
 * Windows không có nohup — dùng spawn detached + stdio ignore + unref.
 */
function startServerDetached(): void {
  const child = spawn('bun', ['server.ts'], {
    cwd: OPENCODE_DIR,
    detached: true,
    stdio: 'ignore',
    shell: IS_WIN,
  })
  child.unref()
}

/**
 * POST /api/opencode/server
 * Manage OpenCode server: restart or stop
 * Body: { action: 'restart' | 'stop' | 'start' }
 */
export async function POST(request: Request) {
  try {
    const body = await request.json()
    const { action } = body

    if (!action || !['restart', 'stop', 'start'].includes(action)) {
      return NextResponse.json({ error: 'action must be "restart", "stop", or "start"' }, { status: 400 })
    }

    const online = await isOpenCodeOnline()

    if (action === 'stop') {
      if (!online) {
        return NextResponse.json({ message: 'Server already offline', wasOnline: false })
      }
      // Kill the opencode-server process using multi-strategy helper
      try {
        killOpenCodeServer()
        // Wait briefly and verify
        await new Promise(r => setTimeout(r, 1500))
        const stillOnline = await isOpenCodeOnline()
        return NextResponse.json({
          message: stillOnline ? 'Server may still be shutting down' : 'Server stopped successfully',
          wasOnline: true,
          stopped: !stillOnline,
        })
      } catch {
        return NextResponse.json({ message: 'Failed to stop server', wasOnline: true }, { status: 500 })
      }
    }

    if (action === 'restart') {
      // Kill existing then start fresh
      try {
        if (online) {
          killOpenCodeServer()
          await new Promise(r => setTimeout(r, 1500))
        }
        // Start the server (cross-platform detached spawn — no nohup on Windows)
        startServerDetached()
        // Wait for startup
        await new Promise(r => setTimeout(r, 3000))
        const nowOnline = await isOpenCodeOnline()
        const serverInfo = nowOnline ? await getOpenCodeInfo() : null
        return NextResponse.json({
          message: nowOnline ? 'Server restarted successfully' : 'Server restart attempted but not yet online',
          online: nowOnline,
          serverInfo,
        })
      } catch (err) {
        return NextResponse.json({
          message: 'Failed to restart server',
          error: err instanceof Error ? err.message : 'Unknown error',
        }, { status: 500 })
      }
    }

    if (action === 'start') {
      if (online) {
        const serverInfo = await getOpenCodeInfo()
        return NextResponse.json({ message: 'Server already running', online: true, serverInfo })
      }
      try {
        startServerDetached()
        await new Promise(r => setTimeout(r, 3000))
        const nowOnline = await isOpenCodeOnline()
        const serverInfo = nowOnline ? await getOpenCodeInfo() : null
        return NextResponse.json({
          message: nowOnline ? 'Server started successfully' : 'Server start attempted but not yet online',
          online: nowOnline,
          serverInfo,
        })
      } catch (err) {
        return NextResponse.json({
          message: 'Failed to start server',
          error: err instanceof Error ? err.message : 'Unknown error',
        }, { status: 500 })
      }
    }

    return NextResponse.json({ error: 'Invalid action' }, { status: 400 })
  } catch (error) {
    return NextResponse.json({
      error: 'Server management failed',
      details: error instanceof Error ? error.message : 'Unknown error',
    }, { status: 500 })
  }
}
