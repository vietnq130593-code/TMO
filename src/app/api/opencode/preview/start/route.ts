import { NextResponse } from 'next/server'
import { spawn } from 'child_process'
import net from 'net'
import { createWriteStream, existsSync, readFileSync } from 'fs'
import { allowPreviewPort } from '@/lib/preview-ports'
import { resolve, join } from 'path'

export const dynamic = 'force-dynamic'

// Phase 3: shared registry — /preview/stop and /preview/stream import this map
// to kill the process group and tail the log file.
export const runningProcesses: Map<
  string,
  { child: ReturnType<typeof spawn>; startedAt: number; port?: number; logFile?: string }
> = new Map()

// TMO itself runs on PORT (default 3000) — reserve 3000..3004 so preview dev
// servers NEVER collide with the TMO UI (the old bug: preview on 3000 killed
// or shadowed the app).
const TMO_PORT = parseInt(process.env.PORT || '3000', 10)
const TMO_RESERVED = [TMO_PORT, TMO_PORT + 1, TMO_PORT + 2, TMO_PORT + 3, TMO_PORT + 4]

function isReserved(port: number): boolean {
  return TMO_RESERVED.includes(port)
}

/**
 * Probe for a free port in [start, end] by binding 127.0.0.1:port with a
 * throwaway net server (no connections, no lingering sockets).
 */
function findFreePort(start: number, end: number): Promise<number> {
  return new Promise((resolvePort) => {
    const tryPort = (port: number): void => {
      if (port > end) {
        resolvePort(start) // fallback: reuse start rather than failing hard
        return
      }
      const server = net.createServer()
      server.once('error', () => {
        server.close(() => { tryPort(port + 1) })
      })
      server.listen(port, '127.0.0.1', () => {
        server.close(() => { resolvePort(port) })
      })
    }
    tryPort(start)
  })
}

/**
 * Detect whether the project is a Next.js app (needs `-- -p PORT` style flag
 * instead of the generic `-- --port PORT`).
 */
function detectIsNextProject(root: string): boolean {
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8')) as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    }
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) }
    return Boolean(deps['next'])
  } catch {
    return false
  }
}

/**
 * POST /api/opencode/preview/start
 * Auto-start dev server for the workspace project on a FREE port >= 3005
 * Body: { root: string, command?: string, script?: string }
 */
export async function POST(request: Request) {
  try {
    const body = await request.json()
    const { root, command, script } = body

    if (!root) {
      return NextResponse.json({ error: 'root parameter is required' }, { status: 400 })
    }

    const resolvedRoot = resolve(root)
    if (!existsSync(resolvedRoot)) {
      return NextResponse.json({ error: 'Directory not found' }, { status: 404 })
    }

    // Check if already running for this root
    const existingProcess = runningProcesses.get(resolvedRoot)
    if (existingProcess) {
      return NextResponse.json({
        status: 'already_running',
        message: 'Dev server already started for this workspace',
        pid: existingProcess.child.pid,
        port: existingProcess.port ?? null,
        startedAt: existingProcess.startedAt,
      })
    }

    // Determine the package manager (same resolution logic as before)
    const pkgManager = existsSync(join(resolvedRoot, 'bun.lockb')) || existsSync(join(resolvedRoot, 'bun.lock'))
      ? 'bun'
      : existsSync(join(resolvedRoot, 'pnpm-lock.yaml'))
        ? 'pnpm'
        : existsSync(join(resolvedRoot, 'yarn.lock'))
          ? 'yarn'
          : 'npm'

    // Determine the command to run
    let cmd: string
    if (command) {
      cmd = command
    } else if (script) {
      cmd = `${pkgManager} run ${script}`
    } else {
      cmd = `${pkgManager} run dev`
    }

    // Phase 3: pick a free port OUTSIDE TMO's reserved range (3000-3004)
    const port = await findFreePort(Math.max(3005, TMO_PORT + 5), 3099)
    if (isReserved(port)) {
      return NextResponse.json(
        { error: 'No free preview port available in 3005-3099' },
        { status: 500 },
      )
    }

    // Next.js uses `-- -p PORT`; everything else gets `-- --port PORT`
    const isNext = detectIsNextProject(resolvedRoot)
    const fullCmd = isNext ? `${cmd} -- -p ${port}` : `${cmd} -- --port ${port}`

    // Per-root log file (hex of root path keeps it unique + filename-safe)
    const logFile = `/tmp/opencode-preview-${Buffer.from(resolvedRoot).toString('hex').slice(-40)}.log`
    const logStream = createWriteStream(logFile, { flags: 'w' })
    logStream.write(`$ ${fullCmd}\n`)

    // Spawn detached (own process group) so it survives the API call and can
    // be killed as a whole group via process.kill(-pid) in /preview/stop.
    const childProcess = spawn(fullCmd, [], {
      cwd: resolvedRoot,
      shell: true,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, FORCE_COLOR: '0', PORT: String(port) },
    })

    // Pipe stdout + stderr into the log file (SSE stream tails this file)
    childProcess.stdout?.pipe(logStream)
    childProcess.stderr?.pipe(logStream)

    // Detach so it keeps running after the API call
    childProcess.unref()

    const pid = childProcess.pid
    const startedAt = Date.now()

    runningProcesses.set(resolvedRoot, { child: childProcess, port, logFile, startedAt })

    // Preview proxy allowlist (user request 2026-09-10) — port này được phép
    // forward qua /api/opencode/preview/proxy/<port>/...
    allowPreviewPort(port)

    // Clean up on process exit
    childProcess.on('exit', () => {
      runningProcesses.delete(resolvedRoot)
    })

    return NextResponse.json({
      status: 'started',
      message: `Dev server started: ${fullCmd}`,
      command: fullCmd,
      port,
      logFile,
      pid,
      startedAt,
    })
  } catch (error) {
    return NextResponse.json({
      error: 'Failed to start dev server',
      details: error instanceof Error ? error.message : 'Unknown error',
    }, { status: 500 })
  }
}

/**
 * GET /api/opencode/preview/start?root=xxx
 * Check if dev server is already running for workspace
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const root = searchParams.get('root')

  if (!root) {
    return NextResponse.json({ error: 'root parameter is required' }, { status: 400 })
  }

  const resolvedRoot = resolve(root)
  const existingProcess = runningProcesses.get(resolvedRoot)

  if (existingProcess) {
    return NextResponse.json({
      running: true,
      pid: existingProcess.child.pid,
      port: existingProcess.port ?? null,
      startedAt: existingProcess.startedAt,
    })
  }

  return NextResponse.json({ running: false })
}
