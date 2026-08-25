import { EventEmitter } from 'events'
import { spawn, type ChildProcess } from 'child_process'

/**
 * Phase 4 — persistent interactive terminal sessions.
 *
 * Each session is a long-lived `bash -i` (or $SHELL) child process whose
 * stdout+stderr are buffered (512KB tail) and streamed to clients over SSE
 * (/api/opencode/terminal/stream). Clients write to stdin via
 * /api/opencode/terminal/input, so cwd / env vars / background jobs SURVIVE
 * between commands — unlike the old one-shot /api/opencode/execute.
 */

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
    const shell = options.shell || process.env.SHELL || '/bin/bash'

    const child = spawn(shell, ['-i'], {
      cwd,
      env: { ...process.env, TERM: 'xterm-256color' },
      stdio: ['pipe', 'pipe', 'pipe'],
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
