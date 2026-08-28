import { EventEmitter } from 'events'
import { spawn, type ChildProcess } from 'child_process'
import { existsSync } from 'fs'

/**
 * Phase 4 — persistent interactive terminal sessions.
 *
 * Each session is a long-lived interactive shell child process whose
 * stdout+stderr are buffered (512KB tail) and streamed to clients over SSE
 * (/api/opencode/terminal/stream). Clients write to stdin via
 * /api/opencode/terminal/input, so cwd / env vars / background jobs SURVIVE
 * between commands — unlike the old one-shot /api/opencode/execute.
 *
 * BUG FIX 2026-09-06 (user report Windows local: "nhập lệnh mà không thấy
 * chạy lệnh gì hết"): shell detection giờ theo platform —
 *   - Windows: Git Bash (C:\Program Files\Git\bin\bash.exe) nếu có,
 *     không thì cmd.exe (ComSpec) — trước đây hardcode '/bin/bash' → spawn
 *     ENOENT → shell chết ngay từ đầu + child 'error' không có handler.
 *   - Unix: $SHELL → /bin/bash (như cũ).
 * Đồng thời thêm child.on('error') — trước đây spawn fail phát 'error' không
 * có listener → uncaught exception; giờ dọn session + emit exit để SSE client
 * nhận frame exit thay vì treo vô hạn.
 */

/** Detect interactive shell + args theo platform (bug fix 2026-09-06) */
function detectInteractiveShell(): { shell: string; args: string[] } {
  if (process.platform === 'win32') {
    // Ưu tiên bash của Git for Windows (lệnh Unix quen thuộc: ls, grep, cat…)
    const bashCandidates = [
      process.env.SHELL, // user tự cấu hình
      `${process.env.ProgramFiles || 'C:\\Program Files'}\\Git\\bin\\bash.exe`,
      `${process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'}\\Git\\bin\\bash.exe`,
    ].filter((p): p is string => !!p)
    for (const c of bashCandidates) {
      try { if (existsSync(c)) return { shell: c, args: ['-i'] } } catch { /* ignore */ }
    }
    // Fallback: cmd.exe — LUÔN có trên Windows. Không dùng flag '-i' (không
    // hợp lệ với cmd.exe); cmd đọc lệnh từ stdin pipe một cách tự nhiên.
    return { shell: process.env.ComSpec || 'cmd.exe', args: [] }
  }
  return { shell: process.env.SHELL || '/bin/bash', args: ['-i'] }
}

export interface TerminalSession {
  id: string
  child: ChildProcess
  /** Cumulative output (tail-capped at MAX_OUTPUT_CHARS) */
  output: string
  cwd: string
  createdAt: number
  lastActivity: number
  /** Set by kill() — guards late 'close' events from emitting a second exit */
  killed: boolean
}

export interface TerminalSessionInfo {
  id: string
  cwd: string
  createdAt: number
  lastActivity: number
  killed: boolean
}

const MAX_OUTPUT_CHARS = 512 * 1024 // keep the tail of cumulative output
const IDLE_TIMEOUT_MS = 30 * 60 * 1000 // reap sessions idle for 30 minutes

export class TerminalSessionManager extends EventEmitter {
  private sessions = new Map<string, TerminalSession>()

  /**
   * Create (or replace) an interactive shell session.
   * An existing session under the same id is killed first.
   */
  create(id: string, options: { cwd?: string; shell?: string } = {}): TerminalSession {
    if (this.sessions.has(id)) {
      this.kill(id)
    }

    const cwd = options.cwd || process.cwd()
    // BUG FIX 2026-09-06: shell theo platform (Windows: Git Bash → cmd.exe)
    const detected = detectInteractiveShell()
    const shell = options.shell || detected.shell
    const shellArgs = options.shell ? ['-i'] : detected.args

    const child = spawn(shell, shellArgs, {
      cwd,
      env: { ...process.env, TERM: 'xterm-256color' },
      stdio: ['pipe', 'pipe', 'pipe'],
      // Windows: chặn cửa sổ console bật lên riêng khi spawn cmd/bash
      windowsHide: true,
    })

    const session: TerminalSession = {
      id,
      child,
      output: '',
      cwd,
      createdAt: Date.now(),
      lastActivity: Date.now(),
      killed: false,
    }

    const appendOutput = (chunk: Buffer): void => {
      const text = chunk.toString('utf-8')
      session.output += text
      if (session.output.length > MAX_OUTPUT_CHARS) {
        session.output = session.output.slice(-MAX_OUTPUT_CHARS)
      }
      session.lastActivity = Date.now()
      this.emit(`output:${id}`, text)
    }

    // Never let stream errors on a dead child crash the server.
    child.stdout?.on('error', () => {})
    child.stderr?.on('error', () => {})
    child.stdin?.on('error', () => {})

    // BUG FIX 2026-09-06: child 'error' (spawn ENOENT / binary crash) trước đây
    // KHÔNG có handler → uncaught exception. Giờ: log + dọn session + emit
    // exit để SSE client nhận lifecycle xác định thay vì treo.
    child.on('error', (err) => {
      console.error(`[Terminal] Shell error (${shell}):`, err instanceof Error ? err.message : String(err))
      if (this.sessions.get(id) === session) {
        this.sessions.delete(id)
        this.emit(`exit:${id}`, session.child.exitCode)
      }
    })

    child.stdout?.on('data', appendOutput)
    child.stderr?.on('data', appendOutput)

    // 'close' (NOT 'exit') so pending stdio is flushed before we report exit.
    // Identity check: if this session was replaced by a newer one under the
    // same id, its late 'close' must NOT delete the new session or emit exit.
    child.on('close', (code) => {
      if (session.killed && this.sessions.get(id) !== session) return
      const current = this.sessions.get(id)
      if (current !== session) return
      this.sessions.delete(id)
      this.emit(`exit:${id}`, code)
    })

    this.sessions.set(id, session)
    return session
  }

  /** Write raw bytes to the session's stdin (usually a command + '\n'). */
  write(id: string, data: string): boolean {
    const session = this.sessions.get(id)
    if (!session || session.killed) return false
    const stdin = session.child.stdin
    if (!stdin || stdin.destroyed || !stdin.writable) return false
    session.lastActivity = Date.now()
    stdin.write(data)
    return true
  }

  /** Cumulative output (tail-capped), or null when the session is gone. */
  getOutput(id: string): string | null {
    const session = this.sessions.get(id)
    if (!session) return null
    return session.output
  }

  exists(id: string): boolean {
    return this.sessions.has(id)
  }

  /**
   * Graceful kill: stdin EOF + SIGTERM, escalating to SIGKILL after 2s.
   * The session entry is reaped by the child's 'close' handler which also
   * emits `exit:${id}` for any live SSE listeners.
   */
  kill(id: string): boolean {
    const session = this.sessions.get(id)
    if (!session) return false
    if (session.killed) return true
    session.killed = true
    try { session.child.stdin?.end() } catch { /* already gone */ }
    try { session.child.kill('SIGTERM') } catch { /* already gone */ }
    const killer = setTimeout(() => {
      try {
        if (session.child.exitCode === null && !session.child.killed) {
          session.child.kill('SIGKILL')
        }
      } catch { /* already gone */ }
      // Belt-and-braces: reap if 'close' somehow never fired
      if (this.sessions.get(id) === session) {
        this.sessions.delete(id)
        this.emit(`exit:${id}`, session.child.exitCode)
      }
    }, 2000)
    killer.unref?.()
    return true
  }

  list(): TerminalSessionInfo[] {
    return Array.from(this.sessions.values()).map((s) => ({
      id: s.id,
      cwd: s.cwd,
      createdAt: s.createdAt,
      lastActivity: s.lastActivity,
      killed: s.killed,
    }))
  }

  /** Kill sessions idle for longer than maxIdleMs. Returns number reaped. */
  cleanupIdle(maxIdleMs: number = IDLE_TIMEOUT_MS): number {
    const now = Date.now()
    let cleaned = 0
    for (const id of Array.from(this.sessions.keys())) {
      const session = this.sessions.get(id)
      if (session && now - session.lastActivity > maxIdleMs) {
        this.kill(id)
        cleaned++
      }
    }
    return cleaned
  }
}

// Singleton on globalThis so Next.js dev-mode module reloads (and the four
// route modules) always share the SAME live child processes.
const globalForTerminal = globalThis as unknown as {
  __tmoTerminalManager?: TerminalSessionManager
  __tmoTerminalCleanupTimer?: boolean
}

export const terminalManager: TerminalSessionManager =
  globalForTerminal.__tmoTerminalManager ?? new TerminalSessionManager()

if (!globalForTerminal.__tmoTerminalManager) {
  globalForTerminal.__tmoTerminalManager = terminalManager
}

// Reap idle sessions every 5 minutes; unref'd so it never blocks shutdown.
if (!globalForTerminal.__tmoTerminalCleanupTimer) {
  const timer = setInterval(() => terminalManager.cleanupIdle(), 5 * 60 * 1000)
  timer.unref?.()
  globalForTerminal.__tmoTerminalCleanupTimer = true
}
