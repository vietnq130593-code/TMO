/**
 * Layer 3.4: Process Manager
 *
 * Quản lý vòng đời process: spawn, timeout, kill-tree, output streaming.
 * Thay thế execSync — mọi command đều chạy async, có timeout, RingBuffer output.
 * Cross-platform: Windows (powershell.exe) / Unix (bash).
 *
 * VÒNG ĐỜI ENTRY (R7-M2 — memory leak fix, tham chiếu audit Task R7-M1 [S1]):
 *   spawn → ghi entry vào registry+buffers+processes (kiểm cap cứng
 *   MAX_TRACKED_PROCESSES=50: vượt → sweep NGAY các entry đã exit cũ nhất,
 *   running không bao giờ bị evict) → child exit/error → ghi exitedAt + hẹn
 *   reap sau REAP_DELAY_MS (5 phút — read_output vẫn đọc được trong cửa sổ
 *   này, lý do delay-reap thay vì delete ngay) → entry bị xóa khỏi CẢ 3 Map
 *   kèm hủy timer hẹn. Mọi đường reap/sweep fail-open — không được phép
 *   làm hỏng flow chạy shell của agents.
 *
 * @module ProcessManager
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import * as path from 'node:path'
// TASK 43 cleanup — bỏ import chết `detectError` (không dùng trong file này)

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
  /** R7-M2 (S1): mốc child exit/error — dùng cho delay-reap + FIFO sweep.
 * JSON-safe (number) để listProcesses serialize ra API không lộ handle. */
  exitedAt?: number
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

/**
 * R7-M2 (S1, audit R7-M1): delay dọn entry sau exit — read_output vẫn đọc
 * được trong cửa sổ này (agent poll kết quả process vừa xong). Tham số hóa
 * qua env TMO_PROC_REAP_DELAY_MS cho test; fail-open khi giá trị không hợp lệ.
 */
const REAP_DELAY_MS = (() => {
  const v = Number(process.env.TMO_PROC_REAP_DELAY_MS)
  return Number.isFinite(v) && v > 0 ? v : 5 * 60_000
})()

/**
 * R7-M2 (S1, audit R7-M1): cap cứng số entry được track (running + đã exit
 * chờ reap). Vượt → sweep ngay các entry đã exit cũ nhất. Tham số hóa qua
 * env TMO_PROC_MAX_TRACKED cho test; fail-open khi giá trị không hợp lệ.
 */
const MAX_TRACKED_PROCESSES = (() => {
  const v = Number(process.env.TMO_PROC_MAX_TRACKED)
  return Number.isFinite(v) && v > 0 ? v : 50
})()

class ProcessManagerImpl {
  private registry = new Map<string, ProcessInfo>()
  private buffers = new Map<string, RingBuffer>()
  private processes = new Map<string, ChildProcess>()
  /** R7-M2 (S1): timer dọn trễ per processId — tách Map riêng (không nhét
   *  handle timer vào ProcessInfo để tránh serialize ra API JSON). */
  private pendingReaps = new Map<string, ReturnType<typeof setTimeout>>()

  // ==================== R7-M2 (S1): ENTRY REAPER (fail-open) ====================

  /** Đánh dấu entry đã chết + hẹn dọn sau REAP_DELAY_MS (idempotent — exit
   *  handler + error handler + killProcess đều gọi được an toàn). */
  private scheduleReap(processId: string): void {
    try {
      if (this.pendingReaps.has(processId)) return
      const info = this.registry.get(processId)
      if (!info || info.status === 'running') return // chỉ dọn entry đã chết
      info.exitedAt = info.exitedAt ?? Date.now()
      const timer = setTimeout(() => {
        this.pendingReaps.delete(processId)
        this.reapEntry(processId)
      }, REAP_DELAY_MS)
      timer.unref?.() // không giữ event loop chặn shutdown
      this.pendingReaps.set(processId, timer)
    } catch {
      // fail-open: lỗi hẹn dọn không được phép ảnh hưởng exit flow
    }
  }

  /** Xóa 1 entry khỏi cả 3 Map + hủy timer dọn đang hẹn (nếu có). */
  private reapEntry(processId: string): void {
    try {
      const timer = this.pendingReaps.get(processId)
      if (timer) {
        clearTimeout(timer)
        this.pendingReaps.delete(processId)
      }
      this.registry.delete(processId)
      this.buffers.delete(processId)
      this.processes.delete(processId)
    } catch {
      // fail-open
    }
  }

  /** Cap cứng: vượt MAX_TRACKED_PROCESSES → dọn ngay các entry ĐÃ EXIT cũ nhất
   *  (Map giữ insertion order = thứ tự spawn). Running KHÔNG bao giờ bị evict. */
  private sweepExited(): void {
    try {
      if (this.registry.size <= MAX_TRACKED_PROCESSES) return
      let excess = this.registry.size - MAX_TRACKED_PROCESSES
      let swept = 0
      for (const [id, info] of this.registry) {
        if (excess <= 0) break
        if (info.status === 'running') continue
        this.reapEntry(id)
        excess--
        swept++
      }
      if (swept > 0) {
        console.log(
          `[ProcessManager] R7-M2 sweep: dọn ${swept} entry đã exit (vượt cap ${MAX_TRACKED_PROCESSES}, còn ${this.registry.size} entry)`
        )
      }
    } catch {
      // fail-open
    }
  }

  /** INSERT entry mới vào registry + chạy cap sweep (mọi điểm insert đều
   *  qua helper này để cap được kiểm nhất quán). */
  private registerEntry(id: string, info: ProcessInfo): void {
    this.registry.set(id, info)
    this.sweepExited()
  }

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

      // R7-M2 (S1d, audit R7-M1): bỏ tích lũy Buffer thô vô hạn — giữ tối đa
      // 8 chunk cuối mỗi stream (tổng ≤256KB/stream), đủ error message cho
      // fallback `output` khi ring rỗng; ringBuffer vẫn là nguồn hiển thị chính
      // nên hành vi output KHÔNG đổi (fallback chỉ reachable khi không có bytes).
      const MAX_ACCUM_CHUNKS = 8
      const MAX_ACCUM_BYTES = 256 * 1024
      const stdout: Buffer[] = []
      const stderr: Buffer[] = []
      let stdoutBytes = 0
      let stderrBytes = 0

      child.stdout?.on('data', (chunk: Buffer) => {
        stdout.push(chunk)
        stdoutBytes += chunk.length
        while (stdout.length > 0 && (stdout.length > MAX_ACCUM_CHUNKS || stdoutBytes > MAX_ACCUM_BYTES)) {
          const dropped = stdout.shift()
          stdoutBytes -= dropped?.length ?? 0
        }
        ringBuffer.write(chunk)
        opts.onChunk?.(chunk.toString('utf-8'))
      })

      child.stderr?.on('data', (chunk: Buffer) => {
        stderr.push(chunk)
        stderrBytes += chunk.length
        while (stderr.length > 0 && (stderr.length > MAX_ACCUM_CHUNKS || stderrBytes > MAX_ACCUM_BYTES)) {
          const dropped = stderr.shift()
          stderrBytes -= dropped?.length ?? 0
        }
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

        // R7-M2 (S1d): lazy concat — chỉ build fallback khi ring rỗng (không
        // còn nhân đôi peak RSS bằng Buffer.concat toàn bộ output lúc exit).
        const durationMs = Date.now() - startTime

        resolve({
          success: !killed && code === 0,
          exitCode: killed ? null : code,
          output: ringBuffer.toString() || Buffer.concat([...stdout, ...stderr]).toString('utf-8'),
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

      // Timeout 2s for spawn confirmation (chỉ còn tác dụng khi 'spawn' event
      // không bao giờ fire và child vẫn sống). R7-M2 (S1): phải clearTimeout
      // ở spawn/exit/error — nếu entry bị reap/sweep trước 2s (exit nhanh +
      // cap overflow), điều kiện has(id) quay về false → fallback TÁI CHÈN
      // zombie status='running' không bao giờ bị dọn (sim R7-M2 bắt được).
      const spawnConfirmTimer = setTimeout(() => {
        if (!this.registry.has(id)) {
          info.status = 'running'
          info.pid = child.pid ?? null
          this.registerEntry(id, info)
          resolve(info)
        }
      }, 2000)

      child.on('spawn', () => {
        // update pid
        clearTimeout(spawnConfirmTimer) // R7-M2: spawn đã confirm — bỏ fallback
        info.pid = child.pid ?? null
        this.registerEntry(id, info)
        resolve(info)
      })

      child.on('exit', (code: number | null) => {
        clearTimeout(spawnConfirmTimer) // R7-M2: child chết — fallback vô nghĩa
        ringBuffer.markEnded()
        info.status = code === 0 ? 'exited' : 'exited'
        info.exitCode = code
        this.registry.set(id, { ...info, status: 'exited' })
        // R7-M2 (S1): entry đã chết → hẹn dọn sau REAP_DELAY_MS (read_output
        // vẫn đọc được trong cửa sổ grace — đây là lý do không delete ngay).
        this.scheduleReap(id)
      })

      child.on('error', (err: Error) => {
        clearTimeout(spawnConfirmTimer) // R7-M2: spawn error — fallback vô nghĩa
        ringBuffer.markEnded()
        info.status = 'exited'
        info.exitCode = -1
        this.registerEntry(id, info)
        // R7-M2 (S1): spawn error → child đã chết, hẹn dọn như exit.
        this.scheduleReap(id)
        // If spawn not yet fired, reject
        if (!this.registry.has(id)) {
          reject(new Error(`Failed to start process ${name}: ${err.message}`))
        }
      })
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
      // R7-M2 (S1): kill xong coi như đã chết — hẹn dọn (exit handler cũng sẽ
      // gọi nhưng scheduleReap idempotent; đường này đề phòng exit event lạc).
      this.scheduleReap(processId)
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