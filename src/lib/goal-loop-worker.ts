/**
 * CI-5 (GĐ4, Task 14-a) — DURABLE GOAL LOOP WORKER
 * =================================================
 *
 * Worker nền chạy goal-loop tác vụ nhiều giờ, sống sót qua restart/đóng tab
 * (kiến trúc chốt ở worklog 14-0 — xem contract: goal-loop-durable-types.ts):
 *
 *   POST /api/openclaw/chat → enqueue GoalLoopJob (DB) → trả jobId ngay
 *   → worker này tick mỗi GOAL_LOOP_WORKER_TICK_MS (5s) poll DB
 *   → claim job bằng updateMany conditional (atomic lock)
 *   → chạy tối đa GOAL_LOOP_MAX_CONCURRENT (2) job song song
 *   → checkpoint SAU MỖI VÒNG (throttle 3s + force khi sang chu kỳ mới)
 *   → hoàn thành → mark completed → finalize seam (Task 14-c).
 *
 * DB LÀ QUEUE — không cần in-memory queue riêng. PM2 fork single-instance →
 * Map `running` trong process này là authoritative cho orphan detection:
 * job status='running' trong DB mà KHÔNG nằm trong Map = mồ côi (process cũ
 * chết) → orphan sweep requeue nếu attempts < GOAL_LOOP_MAX_ATTEMPTS, else
 * mark failed. Cơ chế này xử lý CẢ boot-recovery lẫn steady-state crash
 * detection bằng một đường duy nhất (recoverPending() chỉ là sweep chạy ngay
 * lúc boot cho log rõ ràng).
 *
 * Nguyên tắc BẮT BUỘC: mọi DB write trong tick/heartbeat/checkpoint path đều
 * fail-open — worker KHÔNG BAO GIỜ throw làm chết interval. Job đang chạy
 * trong process này KHÔNG bị stall-kill (LLM call hợp lệ tối đa 8' + tool
 * time) — stale heartbeat chỉ cảnh báo UI (GOAL_LOOP_STALL_WARN_MS).
 *
 * NGOẠI LỆ TASK C (starvation preemption): stale heartbeat ≥
 * GOAL_LOOP_STALL_PREEMPT_MS (30' — xa hơn trần LLM 8') VÀ follower queued
 * cùng session đói mutex ≥ GOAL_LOOP_MUTEX_STARVE_WARN_MS → worker XIN PAUSE
 * job wedged: loop thoát ở RANH GIỚI vòng an toàn (không cắt giữa tool),
 * requeue GIỮ checkpoint nhường mutex cho follower — KHÔNG phải kill, KHÔNG
 * phải cancel của user (xem noteSessionMutexBlocked + nhánh preempt-pause
 * trong executeJob).
 */

import type { GoalLoopJob } from '@prisma/client'
import { db } from '@/lib/db'
import { runGoalDrivenLoop, type GoalLoopResult } from '@/lib/agent-goal-loop'
import {
  GOAL_LOOP_CHECKPOINT_MIN_INTERVAL_MS,
  GOAL_LOOP_HEARTBEAT_MIN_INTERVAL_MS,
  GOAL_LOOP_MAX_ATTEMPTS,
  GOAL_LOOP_MAX_CONCURRENT,
  GOAL_LOOP_STALL_WARN_MS,
  GOAL_LOOP_WORKER_TICK_MS,
  GOAL_LOOP_ADAPTIVE_CONCURRENCY,
  GOAL_LOOP_QUEUE_WARN_THRESHOLD,
  GOAL_LOOP_MUTEX_STARVE_WARN_MS,
  GOAL_LOOP_STALL_PREEMPT_MS,
  GOAL_LOOP_MUTEX_MAX_PREEMPTS,
  type GoalLoopCheckpoint,
  type GoalLoopDurableHooks,
  type GoalLoopJobInput,
  type GoalLoopJobStatus,
} from '@/lib/goal-loop-durable-types'
// TASK 43 — Agent Event Bus: sự kiện vòng đời job phát lên bus hợp nhất
// (GET /api/agent-events). Fail-open tuyệt đối bên trong emit.
import { emitAgentEvent, type AgentEventType } from '@/lib/agent-event-bus'

// ==================== TYPES ====================

/** Trạng thái in-memory của 1 job đang chạy trong process này. */
interface RunningJobMeta {
  /** Epoch ms lúc process này claim job */
  startedAt: number
  /** Epoch ms lần ghi heartbeat cuối (throttle onSignal) */
  lastHeartbeatWrite: number
  /** Epoch ms lần ghi checkpoint THÀNH CÔNG cuối (throttle onCheckpoint) */
  lastCheckpointWrite: number
  /** cyclesDone đã ghi DB thành công lần cuối — force-write khi sang chu kỳ mới */
  lastWrittenCyclesDone: number
  /** Flag cancel set bởi cancel()/cancelSessionJobs() — cancelCheck() đọc */
  cancelRequested: boolean
  /** TASK C — flag preempt-pause set bởi noteSessionMutexBlocked() khi job này
   *  giữ mutex session mà follower starvation + heartbeat của job này stale
   *  ≥ GOAL_LOOP_STALL_PREEMPT_MS (wedged). cancelCheck() đọc → loop thoát ở
   *  ranh giới vòng an toàn → terminal block REQUEUE giữ checkpoint (nhường
   *  mutex cho follower) thay vì cancel — KHÔNG phải ý user. */
  pauseRequested: boolean
  /** REVIEW 14-g M2 — sessionId của job đang chạy: mutual-exclusion per-session
   *  (chatHistory snapshot của job sau phải chứa kết quả job trước — 2 job
   *  cùng session chạy song song sẽ đan xen ChatMessage + resolve sai). */
  sessionId: string
}

/**
 * View job cho API /api/goal-loop-jobs (Task 14-c) — KHÔNG trả input/
 * checkpoint raw (quá lớn), chỉ trả metadata + progressHint parse từ
 * checkpoint counters. result (GoalLoopResult đã parse) CHỈ có ở getJobStatus.
 */
export interface GoalLoopJobView {
  id: string
  sessionId: string
  messageId: string | null
  status: GoalLoopJobStatus
  cyclesDone: number
  stopReason: string | null
  error: string | null
  attempts: number
  cancelRequested: boolean
  heartbeatAt: string | null
  createdAt: string
  startedAt: string | null
  completedAt: string | null
  /** Tuổi job tính từ lúc enqueue (ms) */
  ageMs: number
  /** true khi running mà heartbeat stale > GOAL_LOOP_STALL_WARN_MS (UI cảnh báo stall — job vẫn chạy) */
  stallWarning: boolean
  /** vd "chu kỳ 2 · 15 vòng · 42 tool calls" — parse từ checkpoint counters */
  progressHint: string | null
  /** Chỉ có ở getJobStatus — GoalLoopResult đã parse (content final + metadata) */
  result?: GoalLoopResult | null
}

/** Row Prisma sau select — dùng chung cho getJobStatus/listJobs. */
type GoalLoopJobViewRow = Pick<
  GoalLoopJob,
  | 'id'
  | 'sessionId'
  | 'messageId'
  | 'status'
  | 'cyclesDone'
  | 'stopReason'
  | 'error'
  | 'attempts'
  | 'cancelRequestedAt'
  | 'heartbeatAt'
  | 'createdAt'
  | 'startedAt'
  | 'completedAt'
  | 'checkpoint'
> & { result?: string | null }

// ==================== WORKER ====================

class GoalLoopWorker {
  /** Job đang chạy trong process này — key: jobId, value: meta. Authoritative
   * cho orphan detection (PM2 single-instance): job DB-running KHÔNG có trong
   * Map = mồ côi của process cũ. */
  private running: Map<string, RunningJobMeta> = new Map()

  /** Guard chống 2 tick chồng nhau khi DB chậm (claim vẫn an toàn nhờ
   * updateMany conditional — guard này chỉ giảm churn không đổi tính đúng) */
  private tickInFlight = false

  private started = false
  private intervalHandle: ReturnType<typeof setInterval> | null = null

  // -------------------- TASK 43 — ADAPTIVE CONCURRENCY (AUTO-SCALING) --------------------

  /** Cap hiện hành ∈ [1, GOAL_LOOP_MAX_CONCURRENT] — adapt theo queue depth + stall */
  private adaptiveCap = GOAL_LOOP_MAX_CONCURRENT
  /** Throttle đổi capacity (≥60s giữa 2 lần đổi — tránh dao động) */
  private lastCapacityChangeAt = 0
  /** Queue depth lần đo gần nhất (GET /api/agent-events expose) */
  private lastQueuedCount = 0
  /** Throttle cảnh báo backpressure (≥60s/lần) */
  private lastBackpressureWarnAt = 0

  // -------------------- TASK C — STARVATION PREEMPTION (per-session mutex) --------------------

  /** session → mốc bị chờ mutex ĐẦU TIÊN của episode blockage hiện tại
   *  (blockerKey = jobId:lúcClaim — blocker đổi = episode mới → tự reset mốc
   *  sau mọi lần claim lại). In-memory, reset khi worker restart. */
  private mutexBlockedSince: Map<string, { since: number; blockerKey: string }> = new Map()

  /** Throttle log mutex-skip 60s/session — chống spam (sự cố 2026-10-27:
   *  3.258 dòng "giữ queued" khi blocker wedged giữ mutex 9.5h, tick 5s/lần). */
  private mutexSkipLogAt: Map<string, number> = new Map()

  /** Anti-thrash: jobId → số lần preempt-requeue đã thực hiện. Vượt
   *  GOAL_LOOP_MUTEX_MAX_PREEMPTS → mark failed thay vì requeue. In-memory
   *  (reset khi restart — bảo hiểm: attempts vẫn chặn requeue vô hạn sau crash). */
  private preemptCounts: Map<string, number> = new Map()

  /**
   * TASK 43 — điều chỉnh capacity mỗi tick (fail-open — lỗi thì giữ nguyên):
   *   - BACKPRESSURE: queued ≥ ngưỡng → warn + event (KHÔNG reject — job vẫn queued)
   *   - SCALE DOWN: có job stall-heartbeat → giảm cap (bảo vệ tải, không kill)
   *   - SCALE UP: queued > running và còn slot trần → tăng cap
   */
  private async adjustCapacity(): Promise<void> {
    try {
      const queued = await db.goalLoopJob.count({ where: { status: 'queued' } })
      this.lastQueuedCount = queued
      const now = Date.now()

      if (queued >= GOAL_LOOP_QUEUE_WARN_THRESHOLD && now - this.lastBackpressureWarnAt > 60_000) {
        this.lastBackpressureWarnAt = now
        console.warn(`[GoalLoopWorker] BACKPRESSURE: ${queued} job đang queued (≥ ${GOAL_LOOP_QUEUE_WARN_THRESHOLD}) — worker chạy ${this.running.size}/${this.adaptiveCap}`)
        emitAgentEvent('queue_backpressure', {
          data: { queued, running: this.running.size, capacity: this.adaptiveCap, threshold: GOAL_LOOP_QUEUE_WARN_THRESHOLD },
        })
      }

      if (!GOAL_LOOP_ADAPTIVE_CONCURRENCY) return

      // SCALE DOWN — job đang stall (heartbeat stale > ngưỡng, đã từng ghi)
      const stalledRunning = Array.from(this.running.values())
        .filter(m => m.lastHeartbeatWrite > 0 && now - m.lastHeartbeatWrite > GOAL_LOOP_STALL_WARN_MS)
        .length
      if (stalledRunning > 0 && this.adaptiveCap > 1 && now - this.lastCapacityChangeAt > 60_000) {
        const from = this.adaptiveCap
        this.adaptiveCap--
        this.lastCapacityChangeAt = now
        console.warn(`[GoalLoopWorker] AUTO-SCALE DOWN: ${from}→${this.adaptiveCap} (${stalledRunning} job stall-heartbeat — tạm giảm job mới song song, KHÔNG kill job đang chạy)`)
        emitAgentEvent('capacity_changed', { data: { from, to: this.adaptiveCap, reason: 'stall-heartbeat', stalledRunning } })
        return
      }

      // SCALE UP — hàng đợi sâu hơn số job đang chạy, còn slot trần
      if (queued > this.running.size && this.adaptiveCap < GOAL_LOOP_MAX_CONCURRENT && now - this.lastCapacityChangeAt > 60_000) {
        const from = this.adaptiveCap
        this.adaptiveCap++
        this.lastCapacityChangeAt = now
        console.log(`[GoalLoopWorker] AUTO-SCALE UP: ${from}→${this.adaptiveCap} (queued=${queued} > running=${this.running.size})`)
        emitAgentEvent('capacity_changed', { data: { from, to: this.adaptiveCap, reason: 'queue-depth', queued } })
      }
    } catch { /* fail-open — capacity tuning không được phép chết tick */ }
  }

  /** TASK 43 — observability: capacity hiện tại của worker (/api/agent-events). */
  getCapacityInfo(): Record<string, unknown> {
    return {
      maxConcurrent: GOAL_LOOP_MAX_CONCURRENT,
      adaptiveCap: this.adaptiveCap,
      adaptiveEnabled: GOAL_LOOP_ADAPTIVE_CONCURRENCY,
      running: this.running.size,
      queuedLastSeen: this.lastQueuedCount,
      tickMs: GOAL_LOOP_WORKER_TICK_MS,
      queueWarnThreshold: GOAL_LOOP_QUEUE_WARN_THRESHOLD,
    }
  }

  // -------------------- ENQUEUE --------------------

  /**
   * Enqueue 1 job goal-loop mới — tạo row status='queued' và trả jobId NGAY
   * (route chat 14-c dùng cho response durable). KHÔNG đánh thức worker thủ
   * công — tick kế tiếp (≤5s) tự claim — đơn giản, không race.
   */
  async enqueue(input: {
    sessionId: string
    messageId?: string | null
    jobInput: GoalLoopJobInput
  }): Promise<string> {
    const job = await db.goalLoopJob.create({
      data: {
        sessionId: input.sessionId,
        messageId: input.messageId ?? null,
        status: 'queued',
        input: JSON.stringify(input.jobInput),
      },
    })
    console.log(`[GoalLoopWorker] enqueue job ${job.id} — session ${input.sessionId} — goal: "${input.jobInput.userMessage.slice(0, 80)}"`)
    emitAgentEvent('job_enqueued', {
      jobId: job.id,
      sessionId: input.sessionId,
      agentName: input.jobInput.agentName,
      data: { goal: input.jobInput.userMessage.slice(0, 160), model: input.jobInput.agentModel },
    })
    return job.id
  }

  // -------------------- LIFECYCLE --------------------

  /** Bật worker — idempotent (đã start thì return). TICK=0 → không start. */
  start(): void {
    if (this.started) return
    this.started = true
    if (GOAL_LOOP_WORKER_TICK_MS <= 0) {
      console.log('[GoalLoopWorker] GOAL_LOOP_WORKER_TICK_MS=0 — worker tắt hẳn (không tick)')
      return
    }
    console.log(
      `[GoalLoopWorker] start — tick mỗi ${GOAL_LOOP_WORKER_TICK_MS}ms, tối đa ${GOAL_LOOP_MAX_CONCURRENT} job song song (${GOAL_LOOP_ADAPTIVE_CONCURRENCY ? 'adaptive auto-scale BẬT' : 'cố định'}), stall-warn ${GOAL_LOOP_STALL_WARN_MS}ms, max-attempts ${GOAL_LOOP_MAX_ATTEMPTS}, starve-warn ${GOAL_LOOP_MUTEX_STARVE_WARN_MS}ms, preempt ${GOAL_LOOP_STALL_PREEMPT_MS}ms ×${GOAL_LOOP_MUTEX_MAX_PREEMPTS}`
    )
    // Tick handler KHÔNG throw (tick wrap try/catch toàn bộ bên trong) —
    // interval không bao giờ chết vì lỗi 1 tick.
    this.intervalHandle = setInterval(() => void this.tick(), GOAL_LOOP_WORKER_TICK_MS)
    // Tick đầu tiên chạy NGAY (instrumentation đã đợi DB ready trước start)
    void this.tick()
  }

  /** Dừng worker (dọn interval) — dùng cho shutdown/test. */
  stop(): void {
    if (this.intervalHandle) clearInterval(this.intervalHandle)
    this.intervalHandle = null
    this.started = false
    this.tickInFlight = false
  }

  /**
   * 1 chu kỳ poll: (a) orphan sweep — job DB-running không thuộc process này
   * → requeue/failed; (b) claim + chạy job queued theo slot trống.
   * KHÔNG throw — mọi lỗi được bắt và log, chờ tick sau.
   */
  async tick(): Promise<void> {
    if (this.tickInFlight) return
    this.tickInFlight = true
    try {
      await this.sweepOrphans()
      await this.claimQueued()
      // TASK 43 — auto-scale capacity + backpressure warn (fail-open)
      await this.adjustCapacity()
      // OPUS RECONCILIATION SWEEP (REVIEW 13-f): lưới an toàn cho auto loop —
      // bắt mọi stall mà hook sự kiện bỏ sót (job nhanh < 45s dedupe, PM2
      // restart giữa review, dispatch chết, verdict rơi rớt…). Throttle nội
      // bộ ~30s (sweepOpusAutoSessions tự đo), fail-open tuyệt đối.
      try {
        const { sweepOpusAutoSessions } = await import('@/lib/opus/pipeline')
        void sweepOpusAutoSessions()
      } catch (opusSweepErr) {
        console.warn(
          '[GoalLoopWorker] Opus reconciliation sweep lỗi (fail-open — tick sau thử lại):',
          opusSweepErr instanceof Error ? opusSweepErr.message : String(opusSweepErr)
        )
      }
    } catch (err) {
      // Fail-open tuyệt đối — tick lỗi thì tick sau thử lại
      console.warn(
        '[GoalLoopWorker] tick lỗi (bỏ qua, chờ tick sau):',
        err instanceof Error ? err.message : String(err)
      )
    } finally {
      this.tickInFlight = false
    }
  }

  // -------------------- ORPHAN SWEEP --------------------

  /**
   * Sweep job mồ côi: status='running' trong DB mà KHÔNG nằm trong Map
   * `running` của process này (process cũ chết/crash). Xử lý CẢ boot-recovery
   * lẫn steady-state crash detection:
   *   - attempts < GOAL_LOOP_MAX_ATTEMPTS → requeue (attempts+1, conditional
   *     updateMany tránh đè race) — checkpoint còn nguyên nên job RESUME từ
   *     vòng gần nhất, không chạy lại từ đầu.
   *   - else → mark failed (không retry vô hạn).
   * Job ĐANG chạy trong process này (có trong Map) → KHÔNG đụng — LLM call
   * tối đa 8' là hợp lệ, stale heartbeat KHÔNG phải lý do kill.
   */
  private async sweepOrphans(): Promise<{ requeued: number; markedFailed: number }> {
    let requeued = 0
    let markedFailed = 0
    const runningRows = await db.goalLoopJob.findMany({ where: { status: 'running' } })
    const now = Date.now()
    for (const row of runningRows) {
      // Job của process này — Map là authoritative (PM2 single-instance)
      if (this.running.has(row.id)) continue
      const heartbeatAgeMs = row.heartbeatAt ? now - row.heartbeatAt.getTime() : null
      try {
        if (row.attempts < GOAL_LOOP_MAX_ATTEMPTS) {
          // Conditional updateMany: chỉ requeue khi VẪN còn running — tránh
          // đè nếu có race với process khác claim/cancel trong chốc lát vừa rồi
          const res = await db.goalLoopJob.updateMany({
            where: { id: row.id, status: 'running' },
            data: { status: 'queued', attempts: row.attempts + 1, error: null, workerPid: null },
          })
          if (res.count === 1) {
            requeued++
            console.log(
              `[GoalLoopWorker] orphan sweep: requeue job ${row.id} (attempts ${row.attempts}→${row.attempts + 1}/${GOAL_LOOP_MAX_ATTEMPTS}, pid cũ ${row.workerPid ?? '?'}) — ` +
                `heartbeat ${heartbeatAgeMs !== null ? `${Math.round(heartbeatAgeMs / 1000)}s trước` : 'chưa có'} — process cũ đã chết, tick kế sẽ claim + RESUME từ checkpoint`
            )
          }
        } else {
          const res = await db.goalLoopJob.updateMany({
            where: { id: row.id, status: 'running' },
            data: {
              status: 'failed',
              error: `job mồ côi sau crash — vượt số lần thử tối đa (${GOAL_LOOP_MAX_ATTEMPTS})`,
              completedAt: new Date(),
              workerPid: null,
            },
          })
          if (res.count === 1) {
            markedFailed++
            console.log(
              `[GoalLoopWorker] orphan sweep: mark FAILED job ${row.id} — attempts ${row.attempts} ≥ max ${GOAL_LOOP_MAX_ATTEMPTS} (không retry vô hạn)`
            )
            // OPUS AUTO-REVIEW HOOK (REVIEW 13-f BUG #3): orphan sweep đánh
            // failed TRỰC TIẾP bằng updateMany (không qua markFailed) → trước
            // đây KHÔNG fire hook → auto loop stall khi directive job crash
            // vượt max attempts. Gate nhận job failed làm tín hiệu B (review
            // run crash). Import động chống circular; fail-open.
            try {
              const { maybeAutoOpusReview } = await import('@/lib/opus/pipeline')
              void maybeAutoOpusReview(row.sessionId, { runRef: null, messageId: row.messageId ?? null })
            } catch (opusErr) {
              console.warn(
                `[GoalLoopWorker] orphan sweep: Opus hook (mark-failed path) lỗi (fail-open):`,
                opusErr instanceof Error ? opusErr.message : String(opusErr)
              )
            }
          }
        }
      } catch (err) {
        // Fail-open theo-từng-row: 1 row lỗi không chặn sweep các row còn lại
        console.warn(
          `[GoalLoopWorker] orphan sweep lỗi ở job ${row.id} (bỏ qua, tick sau thử lại):`,
          err instanceof Error ? err.message : String(err)
        )
      }
    }
    return { requeued, markedFailed }
  }

  // -------------------- CLAIM + EXECUTE --------------------

  /** Claim job queued theo số slot trống (atomic qua updateMany conditional). */
  private async claimQueued(): Promise<void> {
    const freeSlots = this.adaptiveCap - this.running.size
    if (freeSlots <= 0) return
    const queuedJobs = await db.goalLoopJob.findMany({
      where: { status: 'queued' },
      orderBy: { createdAt: 'asc' },
      take: freeSlots,
    })
    for (const job of queuedJobs) {
      try {
        // REVIEW 14-g M2 — MUTUAL-EXCLUSION PER-SESSION: session đã có job
        // đang chạy trong process này → SKIP job (để queued, tick sau claim
        // khi job trước xong). Chat dòng là hội thoại tuần tự: chatHistory
        // snapshot của job sau cần kết quả job trước; chạy song song cùng
        // session → ChatMessage đan xen + AgentRunRecord updateMany đụng row
        // nhau. KHÔNG tính vào take ở query vì kiểm tra sau findMany an toàn
        // hơn (slot có thể thay đổi giữa query và claim).
        const blockerEntry = Array.from(this.running.entries()).find(([, m]) => m.sessionId === job.sessionId)
        if (blockerEntry) {
          // TASK C — starvation tracking + quyết định preempt-pause (log
          // throttle 60s/session, preempt chỉ khi blocker wedged — xem helper)
          this.noteSessionMutexBlocked(job.id, job.sessionId, blockerEntry[0], blockerEntry[1])
          continue
        }
        // Job requeue sau crash mà user đã bấm Dừng (cancelRequestedAt còn
        // nguyên trong DB) → hủy ngay lúc claim, không chạy lại
        if (job.cancelRequestedAt) {
          await db.goalLoopJob
            .updateMany({
              where: { id: job.id, status: 'queued' },
              data: { status: 'cancelled', completedAt: new Date() },
            })
            .catch(() => {})
          console.log(
            `[GoalLoopWorker] job ${job.id}: cancelRequestedAt đã set từ trước (requeue sau crash) → cancelled ngay lúc claim`
          )
          continue
        }
        // Claim = atomic lock: chỉ process nào đổi status queued→running TRƯỚC
        // được chạy job (bảo vệ multi-process tương lai). startedAt giữ nguyên
        // nếu job từng chạy (requeue sau crash) — reflect lần start ĐẦU TIÊN.
        const claimed = await db.goalLoopJob.updateMany({
          where: { id: job.id, status: 'queued' },
          data: {
            status: 'running',
            startedAt: job.startedAt ?? new Date(),
            heartbeatAt: new Date(),
            workerPid: process.pid,
          },
        })
        if (claimed.count === 1) {
          console.log(
            `[GoalLoopWorker] claim job ${job.id} — session ${job.sessionId} (slot ${this.running.size + 1}/${this.adaptiveCap}${this.adaptiveCap < GOAL_LOOP_MAX_CONCURRENT ? ` của trần ${GOAL_LOOP_MAX_CONCURRENT}` : ''}, attempts ${job.attempts})`
          )
          emitAgentEvent('job_claimed', {
            jobId: job.id,
            sessionId: job.sessionId,
            data: { slot: this.running.size + 1, capacity: this.adaptiveCap, attempts: job.attempts },
          })
          // Fire-and-forget — executeJob tự xử lý mọi outcome; phần chạy đồng
          // bộ đầu hàm (running.set) chạy NGAY trước cả await kế tiếp nên slot
          // accounting không bị race với tick khác.
          void this.executeJob(job).catch((err) => {
            // executeJob đã try/catch toàn bộ bên trong — đây là hàng rào cuối
            console.error(
              `[GoalLoopWorker] executeJob ${job.id} throw ra ngoài (bất thường — kiểm tra bug):`,
              err instanceof Error ? err.message : String(err)
            )
          })
        }
        // count === 0 → job bị process khác claim trước → skip bình thường
      } catch (err) {
        // Fail-open theo-từng-job: 1 job claim lỗi không chặn các job sau
        console.warn(
          `[GoalLoopWorker] claim job ${job.id} lỗi (bỏ qua, tick sau thử lại):`,
          err instanceof Error ? err.message : String(err)
        )
      }
    }
  }

  /**
   * TASK C — STARVATION DETECTION + PREEMPT cho nhánh mutex-skip của claimQueued
   * (follower queued bị job cùng session đang chạy giữ mutex — mutual-exclusion
   * 14-g M2 theo thiết kế KHÔNG có max-wait → sự cố 2026-10-27: 2 job đói mutex
   * 4.5h + 3.258 dòng spam log trong khi blocker wedged giữ mutex 9.5h):
   *   1. Track mốc bị chờ đầu tiên mỗi episode (blocker đổi = episode mới).
   *   2. Log throttle 60s/session (chống spam); ≥ GOAL_LOOP_MUTEX_STARVE_WARN_MS
   *      → warn ⚠ + event 'session_mutex_starvation' lên agent-event-bus.
   *   3. Follower starvation VÀ blocker heartbeat stale ≥
   *      GOAL_LOOP_STALL_PREEMPT_MS (xa hơn trần LLM 8' — chỉ wedged mới chạm)
   *      → set flag pauseRequested trên meta in-Map của blocker (mirror pattern
   *      cancelRequested): cancelCheck() của blocker trả true → loop thoát ở
   *      RANH GIỚI vòng an toàn (giữa các vòng / trước tool call — không bao
   *      giờ cắt giữa tool đang chạy) → terminal block requeue giữ checkpoint.
   * Blocker đang có yêu cầu cancel của user → không đề phòng (user tự xử).
   */
  private noteSessionMutexBlocked(
    jobId: string,
    sessionId: string,
    blockerJobId: string,
    blockerMeta: RunningJobMeta
  ): void {
    const now = Date.now()
    // Heartbeat ref: lần onSignal ghi DB cuối; chưa từng ghi (=0) thì tính từ
    // lúc claim — job mới claim không bị oan là stale (guard giống adjustCapacity)
    const heartbeatRef = blockerMeta.lastHeartbeatWrite > 0 ? blockerMeta.lastHeartbeatWrite : blockerMeta.startedAt
    const heartbeatAgeMs = now - heartbeatRef
    // Episode: blockerKey đổi (job khác / re-claim sau preempt) → mốc mới
    const blockerKey = `${blockerJobId}:${blockerMeta.startedAt}`
    const prev = this.mutexBlockedSince.get(sessionId)
    const since = prev && prev.blockerKey === blockerKey ? prev.since : now
    this.mutexBlockedSince.set(sessionId, { since, blockerKey })
    const blockedMs = now - since
    const starving = GOAL_LOOP_MUTEX_STARVE_WARN_MS > 0 && blockedMs >= GOAL_LOOP_MUTEX_STARVE_WARN_MS

    // 1+2. Log throttle 60s/session — starving thì warn thay thế log thường
    const lastLogAt = this.mutexSkipLogAt.get(sessionId) ?? 0
    if (now - lastLogAt >= 60_000) {
      this.mutexSkipLogAt.set(sessionId, now)
      if (starving) {
        console.warn(
          `[GoalLoopWorker] ⚠ session ${sessionId}: job ${jobId} bị chờ mutex ≥ ${Math.round(GOAL_LOOP_MUTEX_STARVE_WARN_MS / 60000)} phút (đã chờ ${Math.round(blockedMs / 1000)}s — blocker=${blockerJobId}, heartbeat blocker cách ${Math.round(heartbeatAgeMs / 1000)}s)`
        )
        // Task C nối tiếp: 'session_mutex_starvation' ĐÃ được khai báo chính thức
        // trong union AgentEventType (agent-event-bus.ts) — không cần cast nữa.
        emitAgentEvent('session_mutex_starvation', {
          sessionId,
          jobId,
          data: {
            blockerJobId,
            blockedMs,
            blockerHeartbeatAgeMs: heartbeatAgeMs,
            starveWarnMs: GOAL_LOOP_MUTEX_STARVE_WARN_MS,
          },
        })
      } else {
        console.log(
          `[GoalLoopWorker] job ${jobId}: session ${sessionId} đang có job khác chạy — giữ queued (mutual-exclusion per-session, tick sau claim lại)`
        )
      }
    }

    // 3. Preempt an toàn (kiểm MỖI tick, không phụ thuộc cửa sổ log 60s)
    if (
      starving &&
      GOAL_LOOP_STALL_PREEMPT_MS > 0 &&
      heartbeatAgeMs >= GOAL_LOOP_STALL_PREEMPT_MS &&
      !blockerMeta.pauseRequested &&
      !blockerMeta.cancelRequested
    ) {
      blockerMeta.pauseRequested = true
      console.warn(
        `[GoalLoopWorker] 🛑 session ${sessionId}: PREEMPT — blocker ${blockerJobId} giữ mutex với heartbeat stale ${Math.round(heartbeatAgeMs / 60000)} phút (≥ ${Math.round(GOAL_LOOP_STALL_PREEMPT_MS / 60000)} phút) trong khi follower ${jobId} bị chờ ${Math.round(blockedMs / 60000)} phút → xin PAUSE blocker: loop thoát ở ranh giới vòng an toàn, requeue giữ checkpoint nhường mutex cho follower`
      )
      emitAgentEvent('session_mutex_starvation', {
        sessionId,
        jobId,
        data: {
          blockerJobId,
          blockedMs,
          blockerHeartbeatAgeMs: heartbeatAgeMs,
          starveWarnMs: GOAL_LOOP_MUTEX_STARVE_WARN_MS,
          preemptRequested: true,
          stallPreemptMs: GOAL_LOOP_STALL_PREEMPT_MS,
        },
      })
    }
  }

  /**
   * Chạy 1 job đã claim: parse input/checkpoint → gọi runGoalDrivenLoop với
   * durable hooks (Task 14-b) → mark terminal → finalize seam (Task 14-c).
   * Mọi DB write trong heartbeat/checkpoint path đều fail-open.
   */
  private async executeJob(job: GoalLoopJob): Promise<void> {
    const meta: RunningJobMeta = {
      startedAt: Date.now(),
      lastHeartbeatWrite: 0,
      lastCheckpointWrite: 0,
      lastWrittenCyclesDone: job.cyclesDone ?? 0,
      cancelRequested: false,
      pauseRequested: false,
      sessionId: job.sessionId,
    }
    // Set Map NGAY (phần đồng bộ — trước mọi await) để cancel()/sweep thấy job
    this.running.set(job.id, meta)
    // REVIEW 14-g H2 — crash context cho markFailed honest-close: khai báo
    // NGOÀI try để catch cũng thấy (TS scope). runId cập nhật sau khi parse
    // checkpoint; sessionId luôn có (job.sessionId NOT NULL).
    let jobInputCrashContext: { sessionId: string; runId: string | null } = {
      sessionId: job.sessionId,
      runId: null,
    }
    try {
      // 1. Parse input đầy đủ để re-run (GoalLoopJobInput)
      let jobInput: GoalLoopJobInput
      try {
        jobInput = JSON.parse(job.input) as GoalLoopJobInput
      } catch (parseErr) {
        await this.markFailed(job.id, `input JSON không parse được: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`, {
          sessionId: job.sessionId,
          runId: null,
        })
        return
      }

      // 2. Parse checkpoint → resume state (job requeue sau crash). Checkpoint
      // hỏng → chạy từ đầu (fail-open) — không giết job.
      let resumeState: GoalLoopCheckpoint | undefined
      if (job.checkpoint) {
        try {
          const cp = JSON.parse(job.checkpoint) as GoalLoopCheckpoint
          if (cp && cp.version === 1 && Array.isArray(cp.messages)) resumeState = cp
        } catch {
          console.warn(`[GoalLoopWorker] job ${job.id}: checkpoint cũ không parse được — chạy từ đầu (fail-open)`)
        }
      }

      // REVIEW 14-g H2 — cập nhật runId cho crash context khi đã parse được
      // checkpoint (run tracker của loop này); checkpoint chưa từng ghi → null
      // → todo scope legacy của session (đúng behavior crash của đường inline).
      jobInputCrashContext = {
        sessionId: job.sessionId,
        runId: resumeState?.runId ?? null,
      }

      // 3. Re-fetch row fresh — đóng race cancel-xảy-ra-giữa-claim-và-execute
      //    (cancel() đánh dấu khi job KHÔNG có trong Map — cửa sổ ms này)
      const fresh = await db.goalLoopJob.findUnique({ where: { id: job.id } })
      if (!fresh || fresh.status !== 'running') {
        console.log(
          `[GoalLoopWorker] job ${job.id}: status đã đổi (${fresh?.status ?? 'đã bị xóa'}) giữa lúc claim và execute — bỏ qua`
        )
        return
      }
      if (fresh.cancelRequestedAt) meta.cancelRequested = true

      console.log(
        `[GoalLoopWorker] chạy job ${job.id} — session ${job.sessionId} — goal: "${jobInput.userMessage.slice(0, 80)}"` +
          (resumeState
            ? ` — RESUME từ checkpoint (chu kỳ ${resumeState.counters.cyclesDone}, ${resumeState.counters.totalIterations} vòng, ${resumeState.messages.length} messages, runId ${resumeState.runId ?? 'n/a'})`
            : ' — chạy từ đầu')
      )

      // 4. Checkpoint writer — single-writer + latest-wins + throttle:
      //    - throttle GOAL_LOOP_CHECKPOINT_MIN_INTERVAL_MS SO VỚI lần ghi thành công cuối
      //    - LUÔN ghi khi cp.counters.cyclesDone thay đổi (ranh giới chu kỳ không bỏ sót)
      //    - chỉ 1 write in-flight tại 1 thời điểm (chống write cũ đè write mới)
      //    - fail-open: lỗi ghi → reset throttle để checkpoint sau ghi lại ngay
      let cpPending: GoalLoopCheckpoint | null = null
      let cpWriting = false
      let lastCp: GoalLoopCheckpoint | null = null
      const flushCheckpoint = async (): Promise<void> => {
        if (cpWriting || !cpPending) return
        cpWriting = true
        const cp = cpPending
        cpPending = null
        try {
          await db.goalLoopJob.update({
            where: { id: job.id },
            data: {
              checkpoint: JSON.stringify(cp),
              cyclesDone: cp.counters.cyclesDone,
              heartbeatAt: new Date(),
            },
          })
          meta.lastCheckpointWrite = Date.now()
          meta.lastWrittenCyclesDone = cp.counters.cyclesDone
        } catch (err) {
          // Fail-open: lỗi checkpoint KHÔNG BAO GIỜ làm hỏng loop — reset
          // throttle để checkpoint kế tiếp ghi lại ngay
          meta.lastCheckpointWrite = 0
          console.warn(
            `[GoalLoopWorker] job ${job.id}: ghi checkpoint lỗi (fail-open):`,
            err instanceof Error ? err.message : String(err)
          )
        } finally {
          cpWriting = false
          // Checkpoint mới đến trong lúc ghi → nối dây ghi tiếp (luôn latest-wins)
          if (cpPending) void flushCheckpoint()
        }
      }
      const onCheckpoint = (cp: GoalLoopCheckpoint): void => {
        lastCp = cp
        cpPending = cp
        const cyclesChanged = cp.counters.cyclesDone !== meta.lastWrittenCyclesDone
        if (cyclesChanged || Date.now() - meta.lastCheckpointWrite >= GOAL_LOOP_CHECKPOINT_MIN_INTERVAL_MS) {
          void flushCheckpoint()
        }
      }

      // 5. Heartbeat — throttle GOAL_LOOP_HEARTBEAT_MIN_INTERVAL_MS, chỉ update
      //    heartbeatAt. Fail-open im lặng (heartbeat là tín hiệu phụ cho stall
      //    warning UI — KHÔNG dùng làm phán quyết sống/chết của job).
      const onSignal = (): void => {
        const now = Date.now()
        if (now - meta.lastHeartbeatWrite < GOAL_LOOP_HEARTBEAT_MIN_INTERVAL_MS) return
        meta.lastHeartbeatWrite = now
        void db.goalLoopJob
          .update({ where: { id: job.id }, data: { heartbeatAt: new Date() } })
          .catch(() => {})
      }

      // 6. Cancel check — đọc flag in-memory (set bởi cancel()/cancelSession-
      //    Jobs() qua Map). KHÔNG query DB mỗi vòng (đắt) — cancel() đã update
      //    DB flag + set flag Map; job requeue sau crash đọc cancelRequestedAt
      //    ngay lúc claim (bước claimQueued phía trên).
      //    TASK C — pauseRequested (blocker wedged giữ mutex, follower đói)
      //    cũng thoát loop qua ĐÚNG các điểm check an toàn này (giữa các vòng /
      //    trước tool call) — nhánh preempt-pause ở bước 9 phân biệt với cancel.
      const cancelCheck = (): boolean => meta.cancelRequested || meta.pauseRequested

      // 7. Chạy goal loop với durable hooks (param `durable` do Task 14-b thêm
      //    vào runGoalDrivenLoop — chạy song song với 14-a). Nếu tsc complain
      //    param này chưa tồn tại → transient race giữa 2 wave, KHÔNG tự sửa
      //    agent-goal-loop.ts — parent verify tổng sau khi cả 2 land. Flag off
      //    (inline cũ) thì worker này không chạy nên call-site vô hại.
      const result: GoalLoopResult = await runGoalDrivenLoop({
        systemPrompt: jobInput.systemPrompt,
        userMessage: jobInput.userMessage,
        chatHistory: jobInput.chatHistory,
        agentProvider: jobInput.agentProvider,
        agentModel: jobInput.agentModel,
        agentId: jobInput.agentId,
        agentName: jobInput.agentName,
        agentTemperature: jobInput.agentTemperature,
        agentMaxTokens: jobInput.agentMaxTokens,
        agentTools: jobInput.agentTools ?? [],
        agentSessionId: jobInput.agentSessionId ?? null,
        // 2026-10-27 — trần prompt theo tác vụ (user directive): -1 = unlimited
        promptBudgetChars: jobInput.promptBudgetChars,
        durable: {
          resumeState,
          onCheckpoint,
          onSignal,
          cancelCheck,
        } satisfies GoalLoopDurableHooks,
      })

      // 8. Final checkpoint — buộc ghi KHÔNG throttle (ranh giới cuối trước
      //    return của loop, chỉ còn giá trị observability sau khi completed)
      if (lastCp) {
        cpPending = lastCp
        await flushCheckpoint()
      }

      // 9. Terminal mark — conditional (status vẫn 'running') để không đè
      //    trạng thái nếu có ai đó đổi giữa chừng (vd cancel/failed)
      //
      // TASK C — PREEMPT-PAUSE (trước nhánh cancel): pauseRequested do
      // noteSessionMutexBlocked() set (job này giữ mutex session mà follower
      // starvation + heartbeat của job này stale ≥ STALL_PREEMPT — wedged).
      // Loop đã thoát qua cancelCheck ở ranh giới vòng an toàn → REQUEUE giữ
      // checkpoint (bước 8 vừa force-flush xong — KHÔNG set completedAt,
      // KHÔNG set result, error=null): follower claim tick sau, job này
      // RESUME từ checkpoint khi session rảnh. User cancel (cancelRequested)
      // vẫn THẮNG pause; loop tự kết thúc tự nhiên (stopReason ≠ 'cancelled')
      // thì pause vô hiệu — không vứt work đã xong.
      const pausedForPreempt =
        meta.pauseRequested && !meta.cancelRequested && result.goalLoop?.stopReason === 'cancelled'
      if (pausedForPreempt) {
        // Anti-thrash: đếm in-memory mỗi job — vượt trần thì job này "thối"
        // (heartbeat stale ngay cả sau khi đã preempt + chạy lại) → mark
        // failed dứt điểm thay vì requeue tiếp (chống lặp preempt↔requeue).
        const preemptCount = (this.preemptCounts.get(job.id) ?? 0) + 1
        this.preemptCounts.set(job.id, preemptCount)
        if (preemptCount > GOAL_LOOP_MUTEX_MAX_PREEMPTS) {
          console.error(
            `[GoalLoopWorker] job ${job.id}: preempt lần ${preemptCount} vượt trần ${GOAL_LOOP_MUTEX_MAX_PREEMPTS} (anti-thrash — heartbeat vẫn stale sau mỗi lần chạy lại) → mark FAILED`
          )
          await this.markFailed(
            job.id,
            `stale-heartbeat preempt limit — đã preempt ${GOAL_LOOP_MUTEX_MAX_PREEMPTS} lần mà heartbeat vẫn stale mỗi lần chạy lại (job wedged)`,
            jobInputCrashContext
          )
          return
        }
        const requeued = await db.goalLoopJob.updateMany({
          where: { id: job.id, status: 'running' },
          data: {
            status: 'queued',
            error: null,
            workerPid: null,
            // Đẩy về CUỐI hàng đợi FIFO (claimQueued orderBy createdAt asc):
            // follower đang đói mutex được claim tick sau; job này xếp lại chờ
            // session rảnh. KHÔNG đụng attempts (preempt là pause có chủ đích,
            // không phải crash) — checkpoint/cyclesDone giữ nguyên (bước 8).
            createdAt: new Date(),
          },
        })
        if (requeued.count === 1) {
          console.log(
            `[GoalLoopWorker] job ${job.id} PREEMPT-PAUSE → requeue giữ checkpoint (chu kỳ ${result.goalLoop?.cycles ?? job.cyclesDone}, ${result.iterations} vòng đã chạy, preempt ${preemptCount}/${GOAL_LOOP_MUTEX_MAX_PREEMPTS}) — nhường mutex session ${job.sessionId} cho follower đang chờ; tick sau claim lại + RESUME từ checkpoint khi rảnh`
          )
          emitAgentEvent('job_terminal', {
            jobId: job.id,
            sessionId: job.sessionId,
            data: {
              status: 'preempted_requeued',
              preemptCount,
              cycles: result.goalLoop?.cycles ?? job.cyclesDone,
              iterations: result.iterations,
            },
          })
        } else {
          // Status đã bị đổi giữa chừng (vd user cancel / đường khác đánh dấu)
          // — để nguyên trạng thái hiện tại, không đè
          console.warn(
            `[GoalLoopWorker] job ${job.id}: preempt-requeue không khớp (status đã đổi giữa chừng — giữ nguyên trạng thái hiện tại)`
          )
        }
        return
      }
      const cancelled = meta.cancelRequested || result.goalLoop?.stopReason === 'cancelled'
      if (cancelled) {
        await db.goalLoopJob
          .updateMany({
            where: { id: job.id, status: 'running' },
            data: { status: 'cancelled', stopReason: 'cancelled', completedAt: new Date(), heartbeatAt: new Date() },
          })
          .catch(() => {})
        console.log(
          `[GoalLoopWorker] job ${job.id} CANCELLED — nút Dừng qua DB flag (chu kỳ ${result.goalLoop?.cycles ?? job.cyclesDone}, ${result.iterations} vòng đã chạy)`
        )
        emitAgentEvent('job_terminal', {
          jobId: job.id,
          sessionId: job.sessionId,
          data: { status: 'cancelled', iterations: result.iterations, cycles: result.goalLoop?.cycles ?? job.cyclesDone },
        })
        // REVIEW 14-g H2 — CANCELLED cũng được finalize (mirror đường inline:
        // user bấm Dừng vẫn có todo honest-close CI-2 + partial answer lưu DB).
        // Trước đây return ngay → todo treo in_progress + phiên reload mất
        // partial answer (vi phạm tiêu chí CI-2 trên đường durable).
        // Finalize tự guard theo content (isLlmErrorContent/isTrivialExchange
        // chặn writeback rác; WM/message vẫn lưu như inline).
        try {
          const mod = await import('@/lib/goal-loop-finalize')
          if (typeof mod.finalizeGoalLoopRun === 'function') {
            const freshJob = await db.goalLoopJob.findUnique({ where: { id: job.id } })
            if (freshJob) await mod.finalizeGoalLoopRun({ job: freshJob, result })
          }
        } catch (finalizeErr) {
          console.warn(
            `[GoalLoopWorker] job ${job.id}: finalize sau cancel lỗi (fail-open — job vẫn cancelled):`,
            finalizeErr instanceof Error ? finalizeErr.message : String(finalizeErr)
          )
        }
        return
      }
      const completed = await db.goalLoopJob.updateMany({
        where: { id: job.id, status: 'running' },
        data: {
          status: 'completed',
          result: JSON.stringify(result),
          stopReason: result.goalLoop?.stopReason ?? null,
          completedAt: new Date(),
          heartbeatAt: new Date(),
        },
      })
      if (completed.count === 0) {
        console.warn(
          `[GoalLoopWorker] job ${job.id}: KHÔNG mark completed được — status đã bị đổi giữa chừng (để nguyên trạng thái hiện tại)`
        )
        return
      }
      console.log(
        `[GoalLoopWorker] job ${job.id} COMPLETED — ${result.iterations} vòng, ${result.toolCallsExecuted} tool calls, stopReason=${result.goalLoop?.stopReason ?? 'n/a'}`
      )
      emitAgentEvent('job_terminal', {
        jobId: job.id,
        sessionId: job.sessionId,
        data: { status: 'completed', iterations: result.iterations, toolCalls: result.toolCallsExecuted, stopReason: result.goalLoop?.stopReason ?? null },
      })

      // 10. FINALIZE SEAM (Task 14-c implement goal-loop-finalize.ts): lưu
      //     ChatMessage assistant vào phiên chat gốc SAU KHI job đã completed.
      //     Fail-open tuyệt đối — mọi lỗi (module vắng mặt/chưa implement/
      //     runtime lỗi) KHÔNG làm ảnh hưởng job đã completed.
      try {
        const mod = await import('@/lib/goal-loop-finalize')
        if (typeof mod.finalizeGoalLoopRun === 'function') {
          const freshJob = await db.goalLoopJob.findUnique({ where: { id: job.id } })
          if (freshJob) await mod.finalizeGoalLoopRun({ job: freshJob, result })
        }
      } catch (finalizeErr) {
        console.warn(
          `[GoalLoopWorker] job ${job.id}: finalize chưa sẵn sàng hoặc lỗi (fail-open — job vẫn completed):`,
          finalizeErr instanceof Error ? finalizeErr.message : String(finalizeErr)
        )
      }

      // 11. OPUS AUTO-REVIEW HOOK (Task 13-b): job hoàn thành (status=
      //     'completed', assistant message đã finalize vào phiên) → kích hoạt
      //     cổng auto review của Opus CTO. Import ĐỘNG để tránh circular import
      //     (pipeline.ts import tĩnh goalLoopWorker của file này). Fire-and-
      //     forget `void` — maybeAutoOpusReview tự gate (mode auto + kill
      //     switch + dedupe 45s + có assistant message mới) và KHÔNG throw.
      try {
        const { maybeAutoOpusReview } = await import('@/lib/opus/pipeline')
        void maybeAutoOpusReview(job.sessionId, {
          runRef: result.runId ?? null,
          messageId: job.messageId ?? null,
        })
      } catch (opusErr) {
        console.warn(
          `[GoalLoopWorker] job ${job.id}: Opus auto-review hook lỗi (fail-open — job vẫn completed):`,
          opusErr instanceof Error ? opusErr.message : String(opusErr)
        )
      }
    } catch (err) {
      // Loop throw (bug thật / LLM chết hẳn) → mark failed. Conditional để
      // không đè status nếu job đã bị đánh dấu terminal từ đường khác.
      const msg = err instanceof Error ? err.message : String(err)
      await this.markFailed(job.id, msg, jobInputCrashContext)
    } finally {
      this.running.delete(job.id)
    }
  }

  /**
   * Mark job failed (conditional status='running') + log. Fail-open về DB.
   *
   * REVIEW 14-g H2 — CRASH-PATH HONEST CLOSE (mirror inline catch của chat
   * route): job exception → todo của run đang dở phải được đóng trung thực
   * NGAY (in_progress → 'failed', pending → 'archived') — không để stale
   * in_progress treo tới run sau. Fail-open lồng: crash-close lỗi không được
   * phép che lỗi gốc đã log.
   */
  private async markFailed(jobId: string, error: string, crashContext?: { sessionId: string; runId: string | null }): Promise<void> {
    console.error(`[GoalLoopWorker] job ${jobId} FAILED: ${error.slice(0, 300)}`)
    emitAgentEvent('job_terminal', {
      jobId,
      sessionId: crashContext?.sessionId,
      runId: crashContext?.runId,
      data: { status: 'failed', error: error.slice(0, 300) },
    })
    await db.goalLoopJob
      .updateMany({
        where: { id: jobId, status: 'running' },
        data: { status: 'failed', error: error.slice(0, 2000), completedAt: new Date(), heartbeatAt: new Date() },
      })
      .catch(() => {})
    // REVIEW 14-g H2 — crash honest-close CI-2 (mirror route catch L1230+)
    if (crashContext?.sessionId) {
      try {
        const { closeRunTodosAtEnd } = await import('@/lib/code-team/dev-tools')
        const closed = await closeRunTodosAtEnd({
          sessionId: crashContext.sessionId,
          runId: crashContext.runId,
          goalComplete: false,
          crash: true,
        })
        const closedTotal = closed.inProgressClosed + closed.pendingCompleted + closed.pendingArchived
        if (closedTotal > 0) {
          console.log(`[Todo CI-2][durable] Job ${jobId} crash → đóng ${closed.inProgressClosed} in_progress→failed, ${closed.pendingArchived} pending→archived trong session ${crashContext.sessionId}`)
        }
      } catch (closeErr) {
        console.warn(`[GoalLoopWorker] job ${jobId}: crash-close todos lỗi (fail-open):`, closeErr instanceof Error ? closeErr.message : String(closeErr))
      }

      // OPUS AUTO-REVIEW HOOK (Task 13-b): job FAIL (status='failed') → Opus
      // cần biết run fail để FIX. Import động chống circular; fire-and-forget
      // — maybeAutoOpusReview tự gate (mode auto + kill switch + dedupe 45s +
      // assistant message mới) và KHÔNG throw. Fail-open tuyệt đối.
      try {
        const { maybeAutoOpusReview } = await import('@/lib/opus/pipeline')
        void maybeAutoOpusReview(crashContext.sessionId, {
          runRef: crashContext.runId ?? null,
          messageId: null,
        })
      } catch (opusErr) {
        console.warn(
          `[GoalLoopWorker] job ${jobId}: Opus auto-review hook (fail path) lỗi (fail-open):`,
          opusErr instanceof Error ? opusErr.message : String(opusErr)
        )
      }
    }
  }

  // -------------------- CANCEL --------------------

  /**
   * Nút Dừng của 1 job — sống sót qua restart vì DB flag là tín hiệu bền:
   *   - queued     → cancelled thẳng (chưa chạy thì không cần chạy nữa)
   *   - running trong Map → set cancelRequestedAt (DB) + flag (Map) — loop
   *     tự thoát ở vòng cancelCheck kế tiếp
   *   - running KHÔNG trong Map (orphan) → cancelled thẳng
   */
  async cancel(jobId: string): Promise<boolean> {
    // 1. Job còn queued → cancelled ngay
    const queuedCancel = await db.goalLoopJob.updateMany({
      where: { id: jobId, status: 'queued' },
      data: { status: 'cancelled', completedAt: new Date() },
    })
    if (queuedCancel.count === 1) {
      console.log(`[GoalLoopWorker] cancel job ${jobId} — queued → cancelled`)
      return true
    }
    // 2. Job đang chạy trong process này → DB flag + in-memory flag
    const meta = this.running.get(jobId)
    if (meta) {
      meta.cancelRequested = true
      await db.goalLoopJob
        .update({ where: { id: jobId }, data: { cancelRequestedAt: new Date() } })
        .catch((err) => {
          // Flag in-memory đã set — loop vẫn sẽ thoát; DB flag chỉ để bền qua
          // restart (nếu process chết ngay sau đó, job requeue rồi bị hủy lúc claim)
          console.warn(
            `[GoalLoopWorker] cancel job ${jobId}: set cancelRequestedAt lỗi (flag in-memory vẫn đã bật):`,
            err instanceof Error ? err.message : String(err)
          )
        })
      console.log(`[GoalLoopWorker] cancel job ${jobId} — running: đã bật cancelRequestedAt, loop thoát ở vòng check kế`)
      return true
    }
    // 3. Job running mồ côi (process cũ chết) → cancelled thẳng
    const orphanCancel = await db.goalLoopJob.updateMany({
      where: { id: jobId, status: 'running' },
      data: { status: 'cancelled', completedAt: new Date() },
    })
    if (orphanCancel.count === 1) {
      console.log(`[GoalLoopWorker] cancel job ${jobId} — running mồ côi (không thuộc process này) → cancelled`)
      return true
    }
    return false // job không tồn tại hoặc đã terminal
  }

  /**
   * Nút Dừng mọi job của 1 session (dùng bởi 14-c ở agent-run cancel route):
   * queued → cancelled; running trong Map → flag + cancelRequestedAt; running
   * mồ côi → cancelled thẳng. Return số job affected.
   */
  async cancelSessionJobs(sessionId: string): Promise<number> {
    // Mọi job queued của session → cancelled
    const queuedCancel = await db.goalLoopJob.updateMany({
      where: { sessionId, status: 'queued' },
      data: { status: 'cancelled', completedAt: new Date() },
    })
    // Job running của session — tách 2 nhóm: trong Map (bật flag, loop tự thoát)
    // vs mồ côi process cũ (không ai chạy → cancel thẳng)
    const runningRows = await db.goalLoopJob.findMany({
      where: { sessionId, status: 'running' },
      select: { id: true },
    })
    const inMapIds: string[] = []
    const orphanIds: string[] = []
    for (const row of runningRows) {
      const meta = this.running.get(row.id)
      if (meta) {
        meta.cancelRequested = true
        inMapIds.push(row.id)
      } else {
        orphanIds.push(row.id)
      }
    }
    if (inMapIds.length > 0) {
      await db.goalLoopJob
        .updateMany({ where: { id: { in: inMapIds } }, data: { cancelRequestedAt: new Date() } })
        .catch(() => {})
    }
    if (orphanIds.length > 0) {
      await db.goalLoopJob
        .updateMany({
          where: { id: { in: orphanIds } },
          data: { status: 'cancelled', completedAt: new Date() },
        })
        .catch(() => {})
    }
    const affected = queuedCancel.count + inMapIds.length + orphanIds.length
    console.log(
      `[GoalLoopWorker] cancelSessionJobs ${sessionId}: ${queuedCancel.count} queued → cancelled, ${inMapIds.length} running bật flag cancel, ${orphanIds.length} running mồ côi → cancelled`
    )
    return affected
  }

  // -------------------- QUERIES (cho API 14-c) --------------------

  /** Chi tiết 1 job (kèm GoalLoopResult đã parse). Null nếu không tồn tại. */
  async getJobStatus(jobId: string): Promise<GoalLoopJobView | null> {
    const row = await db.goalLoopJob.findUnique({
      where: { id: jobId },
      select: {
        id: true, sessionId: true, messageId: true, status: true, cyclesDone: true,
        stopReason: true, error: true, attempts: true, cancelRequestedAt: true,
        heartbeatAt: true, createdAt: true, startedAt: true, completedAt: true,
        checkpoint: true, result: true,
      },
    })
    if (!row) return null
    return this.toView(row, { withResult: true })
  }

  /** Danh sách job (mới nhất trước) — KHÔNG trả result/checkpoint raw. */
  async listJobs(opts: { sessionId?: string; statuses?: GoalLoopJobStatus[]; limit?: number } = {}): Promise<GoalLoopJobView[]> {
    const limit = Math.min(Math.max(1, opts.limit ?? 50), 200)
    const rows = await db.goalLoopJob.findMany({
      where: {
        ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
        ...(opts.statuses && opts.statuses.length > 0 ? { status: { in: opts.statuses } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: {
        id: true, sessionId: true, messageId: true, status: true, cyclesDone: true,
        stopReason: true, error: true, attempts: true, cancelRequestedAt: true,
        heartbeatAt: true, createdAt: true, startedAt: true, completedAt: true,
        checkpoint: true,
      },
    })
    return rows.map(r => this.toView(r))
  }

  /** Row Prisma → view API — parse checkpoint counters cho progressHint. */
  private toView(row: GoalLoopJobViewRow, opts: { withResult?: boolean } = {}): GoalLoopJobView {
    const now = Date.now()
    // Heartbeat fallback: job vừa claim (chưa kịp onSignal) dùng startedAt/
    // createdAt làm mốc staleness — không cảnh báo stall oan lúc mới start
    const heartbeatRef = row.heartbeatAt ?? row.startedAt ?? row.createdAt
    const stallWarning = row.status === 'running' && now - heartbeatRef.getTime() > GOAL_LOOP_STALL_WARN_MS
    let progressHint: string | null = null
    if (row.checkpoint) {
      try {
        const cp = JSON.parse(row.checkpoint) as GoalLoopCheckpoint
        if (cp && typeof cp.counters?.cyclesDone === 'number') {
          progressHint =
            `chu kỳ ${cp.counters.cyclesDone} · ${cp.counters.totalIterations} vòng · ${cp.counters.totalToolCalls} tool calls`
        }
      } catch { /* checkpoint hỏng — bỏ qua hint (fail-open) */ }
    }
    const view: GoalLoopJobView = {
      id: row.id,
      sessionId: row.sessionId,
      messageId: row.messageId,
      status: row.status as GoalLoopJobStatus,
      cyclesDone: row.cyclesDone,
      stopReason: row.stopReason,
      error: row.error,
      attempts: row.attempts,
      cancelRequested: row.cancelRequestedAt != null,
      heartbeatAt: row.heartbeatAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      startedAt: row.startedAt?.toISOString() ?? null,
      completedAt: row.completedAt?.toISOString() ?? null,
      ageMs: now - row.createdAt.getTime(),
      stallWarning,
      progressHint,
    }
    if (opts.withResult && row.result) {
      try {
        view.result = JSON.parse(row.result) as GoalLoopResult
      } catch { /* result hỏng — bỏ qua (fail-open) */ }
    }
    return view
  }

  // -------------------- RECOVERY --------------------

  /**
   * Boot recovery — chạy orphan sweep NGAY 1 lần lúc boot cho log rõ ràng
   * (tick a của kiến trúc chốt 14-0). Steady-state crash detection do tick
   * định kỳ đảm nhiệm — cùng một cơ chế sweepOrphans().
   */
  async recoverPending(): Promise<{ requeued: number; markedFailed: number }> {
    try {
      const { requeued, markedFailed } = await this.sweepOrphans()
      console.log(
        `[GoalLoopWorker] recoverPending (boot): requeue ${requeued} job mồ côi, mark failed ${markedFailed} job vượt max-attempts — tick kế sẽ claim + RESUME từ checkpoint`
      )
      return { requeued, markedFailed }
    } catch (err) {
      console.error(
        '[GoalLoopWorker] recoverPending lỗi (bỏ qua — tick định kỳ sẽ tự sweep lại):',
        err instanceof Error ? err.message : String(err)
      )
      return { requeued: 0, markedFailed: 0 }
    }
  }

  // -------------------- OBSERVABILITY --------------------

  /** Số job đang chạy trong process này (debug/status). */
  getRunningCount(): number {
    return this.running.size
  }
}

// ==================== SINGLETON ====================

// Singleton sống sót qua Next dev HMR reload qua globalThis (pattern
// smolabWorker / self-direction scheduler). PM2 fork single-instance → một
// process duy nhất sở hữu Map running → orphan detection đúng.
// REVIEW 14-g M4 — cache globalThis LUÔN LUÔN (bỏ điều kiện NODE_ENV !==
// 'production'): next build/start có thể duplicate module giữa
// instrumentation và routes → 2 instance khác nhau → cancel() rơi nhánh
// orphan-cancel (hủy DB thẳng trong khi loop vẫn chạy) + sweep instance này
// requeue job instance kia đang chạy = double-run thật. globalThis là duy
// nhất theo process → cache vô điều kiện an toàn cả dev lẫn production
// (mirror fix áp cùng cho smolabWorker).
const globalForWorker = globalThis as unknown as { __goalLoopWorker?: GoalLoopWorker }

export const goalLoopWorker = globalForWorker.__goalLoopWorker ?? new GoalLoopWorker()
globalForWorker.__goalLoopWorker = goalLoopWorker
