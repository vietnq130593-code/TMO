/**
 * Smolab Background Task Worker — Singleton
 * 
 * Architecture:
 *   - Max 3 concurrent tasks chạy song song
 *   - Mỗi task có AbortController riêng → cancel được
 *   - Khi user switch session → task VẪN CHẠY (không abort)
 *   - Task hoàn thành → update DB → frontend poll để lấy kết quả
 *   - Pending tasks xếp hàng, tự chạy khi có key trống
 * 
 * FIXES (từ lưu ý Phase 3):
 *   - QueuedTask wrapper với taskId → cancel() filter đúng
 *   - startTask nhận taskId trực tiếp → không bị findFirst trả sai task
 */

import { db } from '@/lib/db'

// ==================== TYPES ====================

export type SmolabTaskType = 'agent_chat' | 'team_workflow' | 'agent_react' | 'memory_extraction'

export interface TaskInput {
  type: SmolabTaskType
  sessionId: string
  agentProfileId?: string
  teamName?: string
  inputSummary: string
  execute: (signal: AbortSignal) => Promise<string> // Hàm thực thi, return result JSON
}

/** Wrapper cho queue items — lưu taskId để cancel/filter chính xác */
interface QueuedTask {
  taskId: string
  input: TaskInput
}

interface RunningTask {
  id: string
  input: TaskInput
  controller: AbortController
  startedAt: Date
}

// ==================== SINGLETON WORKER ====================

const MAX_CONCURRENT = 3

class SmolabTaskWorker {
  private running: Map<string, RunningTask> = new Map()
  private queue: QueuedTask[] = []
  private processing = false

  /** Enqueue a new task — tạo DB record, thêm vào queue, bắt đầu processing */
  async enqueue(input: TaskInput): Promise<string> {
    // 1. Tạo DB record
    const task = await db.smolabTask.create({
      data: {
        type: input.type,
        status: 'pending',
        sessionId: input.sessionId,
        agentProfileId: input.agentProfileId || null,
        teamName: input.teamName || null,
        inputSummary: input.inputSummary,
      },
    })

    // 2. Thêm vào queue VỚI taskId (FIX: dùng QueuedTask thay vì TaskInput)
    // ROUND-23 P4 — backpressure cap: queue chờ từng KHÔNG giới hạn (RAM phình
    // khi consumer chậm/đứng). Vượt trần → mark failed ngay (task vẫn có DB
    // record + lý do rõ ràng — caller đọc được và thử lại sau).
    if (this.queue.length >= 100) {
      await db.smolabTask.update({
        where: { id: task.id },
        data: {
          status: 'failed',
          error: 'Queue đầy (100 task chờ) — từ chối task mới để bảo vệ RAM. Thử lại sau khi queue thoát bớt.',
          completedAt: new Date(),
        },
      }).catch(() => { /* fail-open — task DB có thể đã bị xoá */ })
      throw new Error('Smolab background queue đầy (100 task chờ) — backpressure, thử lại sau')
    }
    this.queue.push({ taskId: task.id, input })

    // 3. Thử bắt đầu processing
    this.processQueue()

    return task.id
  }

  /** Cancel a running/pending task */
  async cancel(taskId: string): Promise<boolean> {
    // Cancel nếu đang chạy
    const running = this.running.get(taskId)
    if (running) {
      running.controller.abort()
      this.running.delete(taskId)
    }

    // FIX: Remove khỏi queue bằng taskId (trước đó filter luôn return true)
    this.queue = this.queue.filter(t => t.taskId !== taskId)

    // Update DB
    await db.smolabTask.update({
      where: { id: taskId },
      data: { status: 'cancelled', completedAt: new Date() },
    }).catch(() => {})

    return true
  }

  /** Cancel tất cả tasks của 1 session */
  async cancelSessionTasks(sessionId: string): Promise<number> {
    let count = 0

    // Cancel running tasks
    for (const [id, running] of this.running) {
      if (running.input.sessionId === sessionId) {
        running.controller.abort()
        this.running.delete(id)
        count++
      }
    }

    // Remove queued tasks
    const beforeQueueLen = this.queue.length
    this.queue = this.queue.filter(t => t.input.sessionId !== sessionId)
    count += beforeQueueLen - this.queue.length

    // Update DB
    const result = await db.smolabTask.updateMany({
      where: { sessionId, status: { in: ['pending', 'running'] } },
      data: { status: 'cancelled', completedAt: new Date() },
    })
    return count + result.count
  }

  /** Process queue — start pending tasks up to MAX_CONCURRENT */
  private async processQueue() {
    if (this.processing) return
    this.processing = true

    try {
      while (this.running.size < MAX_CONCURRENT && this.queue.length > 0) {
        const queued = this.queue.shift()!
        await this.startTask(queued)
      }
    } finally {
      this.processing = false
    }
  }

  /** Start a single task — FIX: nhận QueuedTask với taskId sẵn, không tìm lại DB */
  private async startTask(queued: QueuedTask) {
    const { taskId, input } = queued

    // Verify task vẫn còn pending (có thể đã bị cancel)
    const task = await db.smolabTask.findUnique({ where: { id: taskId } })
    if (!task || task.status !== 'pending') {
      // Task đã bị cancel hoặc không còn pending — bỏ qua
      return
    }

    const controller = new AbortController()
    const runningTask: RunningTask = {
      id: taskId,
      input,
      controller,
      startedAt: new Date(),
    }

    this.running.set(taskId, runningTask)

    // Update DB → running
    await db.smolabTask.update({
      where: { id: taskId },
      data: { status: 'running', startedAt: new Date() },
    })

    // Execute task (KHÔNG await — chạy nền)
    this.executeTask(taskId, input, controller.signal)
  }

  /** Execute a task — runs in background, updates DB on completion */
  private async executeTask(taskId: string, input: TaskInput, signal: AbortSignal) {
    try {
      const result = await input.execute(signal)

      if (signal.aborted) {
        // cancel() already updated DB — silently ignore if record not found
        await db.smolabTask.update({
          where: { id: taskId },
          data: { status: 'cancelled', completedAt: new Date() },
        }).catch(() => {})
      } else {
        await db.smolabTask.update({
          where: { id: taskId },
          data: {
            status: 'completed',
            progress: 100,
            result,
            completedAt: new Date(),
          },
        })
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)

      // Don't update if already cancelled
      if (signal.aborted) {
        await db.smolabTask.update({
          where: { id: taskId },
          data: { status: 'cancelled', completedAt: new Date() },
        }).catch(() => {})
      } else {
        await db.smolabTask.update({
          where: { id: taskId },
          data: { status: 'failed', error: errorMsg, completedAt: new Date() },
        })
      }
    } finally {
      this.running.delete(taskId)
      // Process next in queue
      this.processQueue()
    }
  }

  /** Get running task count */
  getRunningCount(): number {
    return this.running.size
  }

  /** Get pending task count */
  getPendingCount(): number {
    return this.queue.length
  }

  /**
   * Phase 3 SMOLAB Proposal 9 — Crash recovery.
   *
   * Called on worker startup (via src/instrumentation-node.ts). Queries DB for
   * tasks orphaned in 'pending' or 'running' status (likely from a previous
   * process crash / PM2 restart). Re-enqueues each into the in-memory queue and
   * bumps the `attempts` counter; tasks past `maxAttempts` are marked as
   * 'failed' instead of being re-enqueued (no infinite-retry).
   *
   * IMPORTANT — Architectural limitation:
   * The worker's TaskInput.execute is a closure (function reference captured at
   * enqueue time — see /api/smolab/chat/route.ts lines 110-195). When the
   * process crashes, that closure is lost — only the SmolabTask DB row (with
   * metadata fields type/sessionId/agentProfileId/teamName/inputSummary)
   * survives. A recovered task therefore cannot truly resume its original
   * work. Each recovered task is re-enqueued with a stub `execute` that
   * immediately throws an informative error; executeTask catches that error
   * and marks the task as 'failed' via the normal failure path. This prevents
   * orphaned 'pending' rows from piling up across restarts while being honest
   * about what recovery can achieve. A future task-handler-registry refactor
   * (Phase 4+ roadmap) could lift this limitation by serializing a handler id
   * + payload instead of a closure.
   *
   * @returns {{ recovered: number; markedFailed: number }} counts for logging.
   */
  async recoverPending(): Promise<{ recovered: number; markedFailed: number }> {
    let recovered = 0
    let markedFailed = 0

    try {
      const pendingTasks = await db.smolabTask.findMany({
        where: {
          // 'pending' = enqueued but never started; 'running' = crashed mid-execution
          status: { in: ['pending', 'running'] },
        },
        orderBy: { createdAt: 'asc' },
        take: 100, // Safety cap — don't re-enqueue 10k tasks at once
      })

      if (pendingTasks.length === 0) {
        console.log('[SmolabTaskWorker] Crash recovery: no pending/running tasks to recover')
        return { recovered: 0, markedFailed: 0 }
      }

      for (const task of pendingTasks) {
        const attempts = task.attempts ?? 0
        const maxAttempts = task.maxAttempts ?? 3

        // Safety ceiling — don't infinite-retry crashed tasks
        if (attempts >= maxAttempts) {
          await db.smolabTask.update({
            where: { id: task.id },
            data: {
              status: 'failed',
              error: `[Crash Recovery] Exceeded maxAttempts (${maxAttempts}) — task was pending/running across ${attempts} process restarts and could not complete. Marked failed to prevent infinite retry.`,
              completedAt: new Date(),
            },
          }).catch((e) => {
            console.error(
              `[SmolabTaskWorker] Failed to mark task ${task.id} as failed during recovery:`,
              e instanceof Error ? e.message : String(e)
            )
          })
          markedFailed++
          continue
        }

        // Bump attempts + reset to 'pending' (in case it was 'running' at crash time)
        await db.smolabTask.update({
          where: { id: task.id },
          data: {
            status: 'pending',
            attempts: attempts + 1,
          },
        }).catch((e) => {
          console.error(
            `[SmolabTaskWorker] Failed to bump attempts for ${task.id}:`,
            e instanceof Error ? e.message : String(e)
          )
        })

        // Re-enqueue into in-memory queue with stub execute (closure lost — see method JSDoc)
        const stubInput: TaskInput = {
          type: task.type as SmolabTaskType,
          sessionId: task.sessionId,
          agentProfileId: task.agentProfileId || undefined,
          teamName: task.teamName || undefined,
          inputSummary: task.inputSummary || '',
          execute: async (_signal: AbortSignal) => {
            throw new Error(
              `[Crash Recovery] Task ${task.id} (type=${task.type}) recovered from process restart, but the original execute closure is unavailable — closure-based tasks cannot be resumed across process restarts. Input summary: "${task.inputSummary || '(none)'}". To make this task resumable, refactor the worker to use a task-handler-registry pattern (Phase 4+ roadmap).`
            )
          },
        }
        this.queue.push({ taskId: task.id, input: stubInput })
        recovered++
      }

      // Kick off processing so the re-enqueued stub tasks fail-fast
      if (recovered > 0) {
        this.processQueue()
      }

      console.log(
        `[SmolabTaskWorker] Crash recovery complete: ${recovered} tasks re-enqueued (will fail-fast: closure unavailable), ${markedFailed} marked failed (exceeded maxAttempts)`
      )
      return { recovered, markedFailed }
    } catch (err) {
      console.error('[SmolabTaskWorker] Crash recovery failed:', err instanceof Error ? err.message : String(err))
      return { recovered: 0, markedFailed: 0 }
    }
  }

  /** Get all running tasks info (for debug/status) */
  getRunningTasks(): Array<{ id: string; sessionId: string; type: string; startedAt: Date }> {
    return Array.from(this.running.values()).map(t => ({
      id: t.id,
      sessionId: t.input.sessionId,
      type: t.input.type,
      startedAt: t.startedAt,
    }))
  }

  /** Shutdown — cancel all running tasks */
  async shutdown() {
    for (const [id, running] of this.running) {
      running.controller.abort()
      await db.smolabTask.update({
        where: { id },
        data: { status: 'cancelled', completedAt: new Date() },
      }).catch(() => {})
    }
    this.running.clear()
    this.queue = []
  }
}

// Singleton instance — survives hot-reload via globalThis
// REVIEW 14-g M4 (GĐ4) — cache globalThis LUÔN LUÔN (bỏ điều kiện NODE_ENV
// !== 'production', mirror goal-loop-worker.ts): next build/start có thể
// duplicate module giữa instrumentation và routes → 2 instance khác nhau →
// enqueue vào queue instance này nhưng recoverPending chạy trên instance
// kia. globalThis duy nhất theo process → cache vô điều kiện an toàn.
const globalForWorker = globalThis as unknown as {
  smolabWorker: SmolabTaskWorker | undefined
}

export const smolabWorker = globalForWorker.smolabWorker ?? new SmolabTaskWorker()
globalForWorker.smolabWorker = smolabWorker
