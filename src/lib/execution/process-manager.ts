/**
 * Layer 3.4: Process Manager
 *
 * Quản lý vòng đời process: spawn, timeout, kill-tree, output streaming.
 * Thay thế execSync — mọi command đều chạy async, có timeout, RingBuffer output.
 * Cross-platform: Windows (powershell.exe) / Unix (bash).
 *
 * @module ProcessManager
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import * as path from 'node:path'
import { detectError } from '@/lib/error-handling'

// ==================== TYPES ====================

export interface RunCommandOptions {
  command: string
  cwd?: string
  env?: Record<string, string>
  timeoutMs?: number // default 60_000
  maxOutputBytes?: number // default 16_384 (16KB)
  /** Streaming callback — gọi mỗi khi có chunk stdout/stderr mới.
   *  Dùng cho SSE streaming terminal output real-time. */
  onChunk?: (chunk: string) => void
}

export interface RunCommandResult {
  success: boolean
  exitCode: number | null
  output: string
  error?: string
  durationMs: number
  killed: boolean
}

export interface StartProcessOptions extends RunCommandOptions {
  name: string // human-readable name for registry
  tags?: string[] // e.g. ['dev-server', 'agent-RAMPAGE']
}

export interface ProcessInfo {
  id: string
  name: string
  command: string
  cwd: string
  pid: number | null
  status: 'running' | 'exited' | 'killed'
  startedAt: number
  exitCode: number | null
  tags: string[]
}

export interface ProcessOutput {
  output: string
  bytesRead: number
  totalBytes: number
  ended: boolean
}

// ==================== RING BUFFER ====================

class RingBuffer {
  private buffer: Buffer
  private writePos = 0
  private totalBytes = 0
  private ended = false

  constructor(private capacity: number) {
    this.buffer = Buffer.alloc(capacity)
  }

  write(data: Buffer): void {
    if (this.ended) return
    const len = data.length
    this.totalBytes += len
    if (len >= this.capacity) {
      // data lớn hơn capacity — chỉ giữ đuôi
      const tail = data.subarray(len - this.capacity)
      this.buffer.set(tail, 0)
      this.writePos = this.capacity
      return
    }
    const remaining = this.capacity - this.writePos
    if (len <= remaining) {
      this.buffer.set(data, this.writePos)
      this.writePos += len
    } else {
      this.buffer.set(data.subarray(0, remaining), this.writePos)
      this.buffer.set(data.subarray(remaining), 0)
      this.writePos = len - remaining
    }
  }

  toString(encoding: BufferEncoding = 'utf-8'): string {
    if (this.writePos === 0 && this.totalBytes === 0) return ''
    const readable = Math.min(this.totalBytes, this.capacity)
    // Reconstruct readable content in order
    if (this.totalBytes <= this.capacity) {
      return this.buffer.subarray(0, this.totalBytes).toString(encoding)
    }
    // Wrap-around case
    const preWrap = this.capacity - this.writePos
    return Buffer.concat([
      this.buffer.subarray(this.writePos, this.capacity),
      this.buffer.subarray(0, this.writePos),
    ]).toString(encoding)
  }

  read(fromByte: number): { data: string; bytesRead: number; totalBytes: number; ended: boolean } {
    const full = this.toString()
    const slice = full.slice(fromByte)
    return {
      data: slice,
      bytesRead: Math.min(full.length, fromByte + slice.length),
      totalBytes: this.totalBytes,
      ended: this.ended,
    }
  }

  markEnded(): void {
    this.ended = true
  }
}

// ==================== TREE KILL ====================

/**
 * Kill a process and all its children recursively.
 * Cross-platform: Windows uses taskkill /F /T, Unix uses kill SIGTERM.
 */
async function killTree(pid: number): Promise<void> {
  if (process.platform === 'win32') {
    return new Promise<void>((resolve) => {
      const killer = spawn('taskkill', ['/F', '/T', '/PID', String(pid)], {
        stdio: 'ignore',
      })
      killer.on('exit', () => resolve())
      killer.on('error', () => resolve()) // swallow — process may already be dead
    })
  }

  // Unix: kill the process group
  try {
    process.kill(-pid, 'SIGTERM')
  } catch {
    // Process group may not exist; kill the process directly
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // Already dead
    }
  }
  // Wait briefly then force-kill any survivors
  await new Promise((r) => setTimeout(r, 200))
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    // Already gone
  }
}

// ==================== SHELL ====================

/** Build the shell command for the target platform */
function buildShellCmd(command: string): { shell: string; args: string[] } {
  if (process.platform === 'win32') {
    // Use powershell for reliability + consistent exit codes
    return {
      shell: 'powershell.exe',
      args: ['-NoProfile', '-NoLogo', '-NonInteractive', '-Command', command],
    }
  }
  return {
    shell: '/bin/bash',
    args: ['-c', command],
  }
}

// ==================== PROCESS MANAGER SINGLETON ====================

class ProcessManagerImpl {
  private registry = new Map<string, ProcessInfo>()
  private buffers = new Map<string, RingBuffer>()
  private processes = new Map<string, ChildProcess>()

  // ==================== runCommand ====================

  async runCommand(opts: RunCommandOptions): Promise<RunCommandResult> {
    const {
      command,
      cwd = process.cwd(),
      env = process.env as Record<string, string>,
      timeoutMs = 60_000,
      maxOutputBytes = 16_384,
    } = opts

    const startTime = Date.now()
    const ringBuffer = new RingBuffer(maxOutputBytes)
    let killed = false
    let exitCode: number | null = null

    const { shell, args } = buildShellCmd(command)

    return new Promise<RunCommandResult>((resolve) => {
      const child = spawn(shell, args, {
        cwd,
        // Next.js augment ProcessEnv yêu cầu NODE_ENV bắt buộc → cast (giá trị runtime vẫn là env dict hợp lệ)
        env: { ...env, FORCE_COLOR: '0' } as unknown as NodeJS.ProcessEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false,
      })

      const stdout: Buffer[] = []
      const stderr: Buffer[] = []

      child.stdout?.on('data', (chunk: Buffer) => {
        stdout.push(chunk)
        ringBuffer.write(chunk)
        opts.onChunk?.(chunk.toString('utf-8'))
      })

      child.stderr?.on('data', (chunk: Buffer) => {
        stderr.push(chunk)
        ringBuffer.write(chunk)
        opts.onChunk?.(chunk.toString('utf-8'))
      })

      // Timeout
      const timer = setTimeout(async () => {
        killed = true
        if (child.pid) {
          await killTree(child.pid)
        }
      }, timeoutMs)

      child.on('exit', (code: number | null, signal: string | null) => {
        clearTimeout(timer)
        exitCode = code
        ringBuffer.markEnded()

        const combined = Buffer.concat([...stdout, ...stderr]).toString('utf-8')
        const durationMs = Date.now() - startTime

        resolve({
          success: !killed && code === 0,
          exitCode: killed ? null : code,
          output: ringBuffer.toString() || combined,
          error: killed
            ? `Command timed out after ${timeoutMs}ms`
            : code !== 0 && signal
              ? `Killed by signal ${signal}`
              : undefined,
          durationMs,
          killed,
        })
      })

      child.on('error', (err: Error) => {
        clearTimeout(timer)
        ringBuffer.markEnded()
        const durationMs = Date.now() - startTime
        resolve({
          success: false,
          exitCode: null,
          output: '',
          error: `Failed to spawn: ${err.message}`,
          durationMs,
          killed: false,
        })
      })
    })
  }

  // ==================== startProcess ====================

  async startProcess(opts: StartProcessOptions): Promise<ProcessInfo> {
    const {
      command,
      name,
      tags = [],
      cwd = process.cwd(),
      env = process.env as Record<string, string>,
      maxOutputBytes = 16_384,
    } = opts

    const id = `proc_${crypto.randomUUID()}`
    const { shell, args } = buildShellCmd(command)

    return new Promise<ProcessInfo>((resolve, reject) => {
      const child = spawn(shell, args, {
        cwd,
        // Next.js augment ProcessEnv yêu cầu NODE_ENV bắt buộc → cast (giá trị runtime vẫn là env dict hợp lệ)
        env: { ...env, FORCE_COLOR: '0' } as unknown as NodeJS.ProcessEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false,
      })

      const ringBuffer = new RingBuffer(maxOutputBytes)
      this.buffers.set(id, ringBuffer)
      this.processes.set(id, child)

      const info: ProcessInfo = {
        id,
        name,
        command,
        cwd,
        pid: child.pid ?? null,
        status: 'running',
        startedAt: Date.now(),
        exitCode: null,
        tags,
      }

      child.stdout?.on('data', (chunk: Buffer) => {
        ringBuffer.write(chunk)
        opts.onChunk?.(chunk.toString('utf-8'))
      })
      child.stderr?.on('data', (chunk: Buffer) => {
        ringBuffer.write(chunk)
        opts.onChunk?.(chunk.toString('utf-8'))
      })

      child.on('spawn', () => {
        // update pid
        info.pid = child.pid ?? null
        this.registry.set(id, info)
        resolve(info)
      })

      child.on('exit', (code: number | null) => {
        ringBuffer.markEnded()
        info.status = code === 0 ? 'exited' : 'exited'
        info.exitCode = code
        this.registry.set(id, { ...info, status: 'exited' })
      })

      child.on('error', (err: Error) => {
        ringBuffer.markEnded()
        info.status = 'exited'
        info.exitCode = -1
        this.registry.set(id, info)
        // If spawn not yet fired, reject
        if (!this.registry.has(id)) {
          reject(new Error(`Failed to start process ${name}: ${err.message}`))
        }
      })

      // Timeout 2s for spawn confirmation
      setTimeout(() => {
        if (!this.registry.has(id)) {
          info.status = 'running'
          info.pid = child.pid ?? null
          this.registry.set(id, info)
          resolve(info)
        }
      }, 2000)
    })
  }

  // ==================== killProcess ====================

  async killProcess(processId: string): Promise<boolean> {
    const info = this.registry.get(processId)
    if (!info || info.status !== 'running') return false

    const child = this.processes.get(processId)
    if (child?.pid) {
      await killTree(child.pid)
      info.status = 'killed'
      this.registry.set(processId, info)
      this.buffers.get(processId)?.markEnded()
      return true
    }

    return false
  }

  // ==================== listProcesses ====================

  async listProcesses(): Promise<ProcessInfo[]> {
    return Array.from(this.registry.values())
  }

  // ==================== readProcessOutput ====================

  async readProcessOutput(processId: string, fromByte?: number): Promise<ProcessOutput> {
    const buffer = this.buffers.get(processId)
    if (!buffer) {
      const info = this.registry.get(processId)
      return {
        output: info ? `Process ${info.name}: no output buffer (status=${info.status})` : '',
        bytesRead: 0,
        totalBytes: 0,
        ended: true,
      }
    }
    const { data, bytesRead, totalBytes, ended } = buffer.read(fromByte ?? 0)
    return { output: data, bytesRead, totalBytes, ended }
  }

  // ==================== getProcess ====================

  async getProcess(processId: string): Promise<ProcessInfo | null> {
    return this.registry.get(processId) ?? null
  }
}

// Singleton export
export const processManager = new ProcessManagerImpl()