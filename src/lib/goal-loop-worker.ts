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
// R36-ACT (§0b kích hoạt giao thức quan sát 2026-10-18): withSqliteRetry cho
// mọi ghi terminal-status của job — bằng chứng 6 run Omega failed cùng họ
// "Socket timeout" tại completed-marking (2 hôm nay 07:32/08:45 + 4 hôm 17
// 12:26-12:30, tok=0) khi bùng nổ ghi đè nhau >15s busy_timeout; transient
// lock PHẢI retry (Task 33 doctrine) thay vì để throw → catch → markFailed.
// firstErrLine cho log FAILED (message Prisma bắt đầu \n → "FAILED:" trống).
import { db, withSqliteRetry, firstErrLine } from '@/lib/db'
// R12 (P-NEW-2 lượt 5): user-chat priority flag — job durable chạy thay user
import { markUserChatRunActive, markUserChatRunDone } from '@/lib/execution/user-run-priority'
// ROUND-28 W1 — TYPE-ONLY import (erased lúc build): giá trị runGoalDrivenLoop
// chuyển sang DYNAMIC IMPORT tại chỗ chạy job (xem bước 7) — singleton worker
// sống sót qua HMR (globalThis pattern dòng dưới) giữ binding tĩnh MÃI MÃI
// pointing về module SINH LÚC BOOT: mọi sửa agent-goal-loop sau đó (HMR) KHÔNG
// bao giờ tới được job đang chạy → "verify giả" khi agent tự sửa code rồi chạy
// mission kiểm chứng (bằng chứng sống job r28v2proof: checkpoint có
// omegaAdvisory nhưng code cũ bỏ qua restore + checkpoint live không có key).
// ⚠️ KIỂM CHỨNG LIVE ROUND-28 (job r28w1hmr): dynamic import từ closure cũ
// vẫn resolve module graph CŨ (bump rev r28w1→r28w2 không restart → job kế
// vẫn nạp r28w1) — HMR không tới được worker KỂ CẢ qua dynamic import. Vì
// vậy W1b bổ sung đối chiếu rev TRÊN ĐĨA (readGoalLoopDiskRev) để PHÁT HIỆN
// stale code thay vì im lặng — cảnh báo hiện thị trên log mỗi job claim.
import type { GoalLoopResult } from '@/lib/agent-goal-loop'
// ROUND-28 W1b — đọc rev TRÊN ĐĨA để đối chiếu stale code (helper bên dưới)
import { readFile, stat } from 'node:fs/promises'
import {
  GOAL_LOOP_CHECKPOINT_MIN_INTERVAL_MS,
  GOAL_LOOP_HEARTBEAT_MIN_INTERVAL_MS,
  GOAL_LOOP_CANCEL_POLL_MIN_INTERVAL_MS,
  GOAL_LOOP_MAX_ATTEMPTS,
  GOAL_LOOP_MAX_CONCURRENT,
  GOAL_LOOP_STALL_WARN_MS,
  GOAL_LOOP_WORKER_TICK_MS,
  GOAL_LOOP_ADAPTIVE_CONCURRENCY,
  GOAL_LOOP_QUEUE_WARN_THRESHOLD,
  GOAL_LOOP_MUTEX_STARVE_WARN_MS,
  GOAL_LOOP_STALL_PREEMPT_MS,
  GOAL_LOOP_MUTEX_MAX_PREEMPTS,
  GOAL_LOOP_RESUME_MAX_AGE_MS,
  isPidRecycleSuspect,
  type GoalLoopCheckpoint,
  type GoalLoopDurableHooks,
  type GoalLoopJobInput,
  type GoalLoopJobStatus,
} from '@/lib/goal-loop-durable-types'
// TASK 43 — Agent Event Bus: sự kiện vòng đời job phát lên bus hợp nhất
// (GET /api/agent-events). Fail-open tuyệt đối bên trong emit.
import { emitAgentEvent, type AgentEventType } from '@/lib/agent-event-bus'

// ==================== ROUND-28 W1b — STALE CODE DETECTION ====================

/**
 * Đọc GOAL_LOOP_CODE_REV ghi TRÊN ĐĨA (regex src/lib/agent-goal-loop.ts).
 * Không phụ thuộc module resolution — đã kiểm chứng live round-28 (job
 * r28w1hmr): dynamic import từ closure của worker singleton vẫn resolve
 * module graph CŨ, nên cách duy nhất biết code trên đĩa đã đổi là đọc file.
 * Dùng async readFile (không chặn event loop — bài học G1 round-25).
 * Fail-open: mọi lỗi (thiếu file trong prod build, quyền đọc...) → null.
 */
export async function readGoalLoopDiskRev(): Promise<string | null> {
  try {
    const src = await readFile('src/lib/agent-goal-loop.ts', 'utf8')
    const m = src.match(/GOAL_LOOP_CODE_REV = '([^']+)'/)
    return m ? m[1] : null
  } catch {
    return null
  }
}

/**
 * ROUND-54 FIX B — HỌ FILE goal-loop family cho detector stale-code mtime.
 * Bằng chứng r54: commit audit 0802a25 (06:38:51Z) đổi 4 file (agent-goal-loop,
 * subagent-delegate, context-compression, code-team/dev-tools) sau lần restart
 * 06:35:40Z nhưng KHÔNG bump GOAL_LOOP_CODE_REV → detector rev-string MÙ HOÀN
 * TOÀN (module nạp r28w4, đĩa cũng r28w4 — không cảnh báo dù nội dung khác
 * nhau), 5 fix audit chưa từng sống trên mission nào. Rev-string vẫn là tín
 * hiệu chính, mtime là LƯỚI AN TOÀN: file nào trong họ sửa SAU lúc process
 * boot → cảnh báo STALE (chống cả class bug "quên bump rev").
 */
const GOAL_LOOP_FAMILY_FILES = [
  'agent-goal-loop.ts',
  'subagent-delegate.ts',
  'context-compression.ts',
  'tool-calls.ts',
  'llm.ts',
  'code-team/dev-tools.ts',
  'code-team/tool-executor.ts',
]
/** Mốc boot của process này (module load) — so mtime file family chống stale. */
const WORKER_BOOT_AT = Date.now()

/**
 * ROUND-54 FIX B — quét mtime họ file goal-loop: trả về danh sách file đã bị
 * sửa SAU lúc process boot (tức module graph singleton đang chạy bản CŨ).
 * Fail-open tuyệt đối: lỗi stat (prod build không có src, quyền...) → [].
 * Grace 2s chống cảnh báo giả cho file ghi cùng giây boot.
 */
export async function detectStaleGoalLoopFamily(): Promise<string[]> {
  const stale: string[] = []
  for (const f of GOAL_LOOP_FAMILY_FILES) {
    try {
      const st = await stat(`src/lib/${f}`)
      if (st.mtimeMs > WORKER_BOOT_AT + 2_000) stale.push(f)
    } catch {
      // thiếu file (prod build) — bỏ qua
    }
  }
  return stale
}

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
  /** R42 FIX-STOP-2 — epoch ms lần poll cancelRequestedAt từ DB cuối
   * (split-mode: cancel() chạy ở process API khác không với được flag
   * in-memory của process này — onSignal poll DB theo nhịp heartbeat). */
  lastCancelPollAt: number
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
   * R18 — check pid còn sống hay không (multi-process an toàn). process.kill
   * (pid, 0) không gửi tín hiệu — chỉ probe: throw ESRCH nếu pid chết; EPERM nếu
   * sống nhưng khác quyền (Windows/Unix đều đúng semantics này — coi EPERM = sống).
   */
  private isWorkerPidAlive(pid: number | null | undefined): boolean {
    if (!pid || !Number.isFinite(pid)) return false
    if (pid === process.pid) return true
    try {
      process.kill(pid, 0)
      return true
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === 'EPERM'
    }
  }

  /** R18 — throttle log skip theo pid-sống (sweep chạy mỗi 5s — tránh spam cùng dòng) */
  private pidSkipLogAt = new Map<string, number>()

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
   *
   * R18 — 2 GATE MỚI (user bug report "request định kỳ mặc dù không động vào app"):
   *   - PID-ALIVE: row.workerPid còn sống và KHÔNG phải process này → process
   *     khác (dev + pm2, 2 terminal next dev...) ĐANG CHẠY job đó → KHÔNG
   *     requeue-đè (double-run thật: 2 bản cùng goal = 2 agent làm cùng lúc —
   *     đúng symptom "Omega gọi nhiều agent cùng lúc" trên máy đa process).
   *   - STALE-AGE: job mồ côi quá GOAL_LOOP_RESUME_MAX_AGE_MS (default 12h) →
   *     mark failed 'stale' thay vì requeue — chống "tác vụ ma" tự sống lại mỗi
   *     lần boot, mỗi lần đốt nguyên chuỗi failover LLM (5 spawn CLI × 400-590MB).
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
        // ━━━ R18 GATE 1 — PID-ALIVE: process khác (pid sống) đang giữ job ━━━
        // Máy chạy >1 instance (dev + pm2 / 2 terminal) → mỗi process có Map
        // running riêng; sweep của process này KHÔNG được requeue job process
        // kia đang chạy (double-run thật). Chỉ tiếp tục khi pid chủ đã CHẾT.
        // ━━━ DEBT-R17BC — PID-RECYCLING GATE (nợ follow-up pilot W2
        // 2026-10-20, trả 2026-10-21): pid "sống" CHƯA đủ tin — Linux tái chế
        // pid (bằng chứng pilot: probe chết → pid 32463 được process khác tái
        // sử dụng → isWorkerPidAlive true nhầm → sweep SKIP → job mồ côi kẹt
        // 'running' tới trần STALE-AGE 12h, không bao giờ RESUME). Heartbeat
        // DB được ghi MỖI VÒNG/tool batch (throttle 15s) nên pid sống mà
        // heartbeat stale ≥ GOAL_LOOP_STALL_PREEMPT_MS (30' > trần LLM 8')
        // thì hoặc pid bị tái chế hoặc job wedged — cả hai đã nằm trong
        // semantics preempt (requeue giữ checkpoint, updateMany conditional
        // chống đè race). Nhánh SKIP giờ chỉ chạy khi pid sống VÀ heartbeat
        // đủ tươi; heartbeat null → vẫn tin pid (bảo thủ — xem helper).
        const pidAlive = Boolean(
          row.workerPid && row.workerPid !== process.pid && this.isWorkerPidAlive(row.workerPid)
        )
        const pidSuspectRecycled = isPidRecycleSuspect(pidAlive, heartbeatAgeMs)
        if (pidAlive && !pidSuspectRecycled) {
          const lastLog = this.pidSkipLogAt.get(row.id) ?? 0
          if (now - lastLog > 60_000) {
            this.pidSkipLogAt.set(row.id, now)
            if (this.pidSkipLogAt.size > 200) this.pidSkipLogAt.clear() // bound
            console.log(
              `[GoalLoopWorker] orphan sweep: SKIP job ${row.id} — workerPid ${row.workerPid} còn sống (process khác đang chạy — không requeue-đè, R18 gate)`
            )
          }
          continue
        }
        if (pidSuspectRecycled) {
          // pid "sống" nhưng heartbeat stale — KHÔNG continue: rơi xuống
          // requeue/mark-failed như thể pid đã chết (checkpoint còn nguyên)
          const lastLog = this.pidSkipLogAt.get(row.id) ?? 0
          if (now - lastLog > 60_000) {
            this.pidSkipLogAt.set(row.id, now)
            if (this.pidSkipLogAt.size > 200) this.pidSkipLogAt.clear() // bound
            console.warn(
              `[GoalLoopWorker] orphan sweep: job ${row.id} — workerPid ${row.workerPid} "còn sống" nhưng heartbeat stale ` +
                `${heartbeatAgeMs !== null ? `${Math.round(heartbeatAgeMs / 60000)} phút` : '?'} (≥ ${Math.round(GOAL_LOOP_STALL_PREEMPT_MS / 60000)} phút) — ` +
                `pid nghi bị Linux tái chế (DEBT-R17BC) → requeue giữ checkpoint thay vì SKIP kẹt tới trần 12h`
            )
          }
        }
        // ━━━ R18 GATE 2 — STALE-AGE: job mồ côi quá tuổi không resume nữa ━━━
        const jobAgeMs = row.createdAt ? now - row.createdAt.getTime() : 0
        if (GOAL_LOOP_RESUME_MAX_AGE_MS > 0 && jobAgeMs > GOAL_LOOP_RESUME_MAX_AGE_MS) {
          const res = await db.goalLoopJob.updateMany({
            where: { id: row.id, status: 'running' },
            data: {
              status: 'failed',
              error: `job mồ côi quá cũ (${Math.round(jobAgeMs / 3_600_000)}h > trần resume ${Math.round(GOAL_LOOP_RESUME_MAX_AGE_MS / 3_600_000)}h — R18: không resume tác vụ ma, user không yêu cầu lại thì thôi)`,
              completedAt: new Date(),
              workerPid: null,
            },
          })
          if (res.count === 1) {
            markedFailed++
            console.log(
              `[GoalLoopWorker] orphan sweep: mark FAILED (stale ${Math.round(jobAgeMs / 3_600_000)}h) job ${row.id} — quá trần resume, không tự sống lại (R18)`
            )
            // Opus hook giữ nguyên semantics mark-failed path (REVIEW 13-f BUG #3)
            try {
              const { maybeAutoOpusReview } = await import('@/lib/opus/pipeline')
              void maybeAutoOpusReview(row.sessionId, { runRef: null, messageId: row.messageId ?? null })
            } catch { /* fail-open */ }
            // R17 (QUAN-SAT lượt 7 · 6.1b) — orphan sweep đánh FAIL job phải
            // GHI NỢ infra NGAY (trước đây im lặng — sổ nợ trắng dù job user bị
            // hủy vĩnh viễn; bằng chứng R16 V1.5). Ghi tại nơi phát hiện, không
            // đợi arbiter/finalize. Fail-open theo từng job.
            try {
              const { recordDebtIssue } = await import('@/lib/execution/debt-ledger')
              await recordDebtIssue({
                issue: `Goal-loop job failed vĩnh viễn (orphan sweep stale): mồ côi quá trần resume, không finalize được — server mất ổn định giữa chừng`,
                kind: 'infra',
                sessionId: row.sessionId,
                evidence: `job ${row.id} stale ${Math.round(jobAgeMs / 3_600_000)}h > trần ${Math.round(GOAL_LOOP_RESUME_MAX_AGE_MS / 3_600_000)}h (R18) · error=${row.error?.slice(0, 200) ?? '(trống)'}`,
              })
            } catch { /* fail-open — ghi nợ không được phép chặn sweep */ }
          }
          continue
        }
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
            // R17 (QUAN-SAT lượt 7 · 6.1b) — đường ghi nợ thứ 4: attempts cạn
            // sau crash là sự cố hạ tầng (server chết giữa job), không phải
            // lỗi agent — ghi nợ infra NGAY tại nơi phát hiện. Bằng chứng R16
            // V1.5: job user 'Tiếp tục công việc bạn làm thiếu' hủy 2 lần →
            // failed vĩnh viễn → DebtLedger vẫn 0 dòng. Fail-open.
            try {
              const { recordDebtIssue } = await import('@/lib/execution/debt-ledger')
              await recordDebtIssue({
                issue: `Goal-loop job failed vĩnh viễn (orphan sweep): attempts cạn sau crash server — công việc dở bị hủy, không finalize được`,
                kind: 'infra',
                sessionId: row.sessionId,
                evidence: `job ${row.id} attempts ${row.attempts}/${GOAL_LOOP_MAX_ATTEMPTS} · error=${row.error?.slice(0, 200) ?? '(trống)'}`,
              })
            } catch { /* fail-open — ghi nợ không được phép chặn sweep */ }
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
          // R7-M2 (S4, audit R7-M1): session hết bị mutex-block — job này được
          // claim thành công → dọn tracker blockage của session (fail-open,
          // noteSessionMutexBlocked tự set lại nếu session bị block lần nữa).
          this.mutexBlockedSince.delete(job.sessionId)
          this.mutexSkipLogAt.delete(job.sessionId)
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
      lastCancelPollAt: 0,
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
    // R42 FIX-STOP-2b — timer poll cancel cross-process (khai báo NGOÀI try
    // để finally dọn được — return sớm trong try sẽ bỏ qua đoạn khai báo gốc)
    let cancelPollTimer: ReturnType<typeof setInterval> | null = null
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
          // R36-ACT: checkpoint write cũng dính họ Socket timeout (log "ghi
          // checkpoint lỗi" 2 job failed hôm 18/10) — retry transient, fail-open
          // giữ nguyên (lỗi KHÔNG transient vẫn ném cho catch ngoài reset throttle).
          await withSqliteRetry(
            () => db.goalLoopJob.update({
              where: { id: job.id },
              data: {
                checkpoint: JSON.stringify(cp),
                cyclesDone: cp.counters.cyclesDone,
                heartbeatAt: new Date(),
              },
            }),
            { label: `goal-loop checkpoint job ${job.id}` },
          )
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
        // R42 FIX-STOP-2 — SPLIT-MODE CANCEL POLL: cancel() từ process khác
        // (API pm2 riêng — GOAL_LOOP_WORKER_MODE=split) không thể set flag
        // in-memory của process này; nó set cancelRequestedAt trong DB. Poll
        // theo nhịp heartbeat (cùng throttle 15s — SELECT rẻ, fail-open im
        // lặng) đọc lại flag → meta.cancelRequested → cancelCheck() cho loop
        // thoát ở ranh giới an toàn kế tiếp (bằng chứng gốc: user bấm Dừng ×2
        // đều 500 socket-timeout, và kể cả khi write thành công thì nhánh
        // orphan cũ flip status 'cancelled' mà worker vẫn chạy tiếp).
        void db.goalLoopJob
          .findUnique({ where: { id: job.id }, select: { cancelRequestedAt: true } })
          .then((fresh) => {
            if (fresh?.cancelRequestedAt && !meta.cancelRequested) {
              meta.cancelRequested = true
              console.log(
                `[GoalLoopWorker] job ${job.id}: bắt được cancelRequestedAt từ DB (cancel cross-process split-mode) → loop sẽ thoát ở ranh giới an toàn kế`
              )
            }
          })
          .catch(() => {})
      }

      // R42 FIX-STOP-2b — TIMER POLL ĐỘC LẬP 5s/lỗi-cancel: onSignal chỉ bắn
      // ở ranh giới iteration/tool_batch/compression/cycle — LLM call dài
      // 60-120s không bắn signal nào → poll bám onSignal (15s throttle) có
      // thể trễ tới HẾT vòng hiện tại mới thấy flag. Timer này chạy nền suốt
      // đời job, độc lập nhịp loop → độ trễ phát hiện cancel tối đa 5s kể cả
      // giữa LLM call. Khi flag bật: cancelCheck() (đọc meta.cancelRequested)
      // sẽ cắt loop ở ranh giới an toàn kế tiếp; vòng LLM đang bay tiếp tục
      // bay (không abort giữa dòng — giữ nguyên chính sách an toàn cũ).
      // Fail-open tuyệt đối; GOAL_LOOP_CANCEL_POLL_MIN_INTERVAL_MS=0 tắt.
      cancelPollTimer = GOAL_LOOP_CANCEL_POLL_MIN_INTERVAL_MS > 0
          ? setInterval(() => {
              meta.lastCancelPollAt = Date.now()
              void db.goalLoopJob
                .findUnique({ where: { id: job.id }, select: { cancelRequestedAt: true } })
                .then((fresh) => {
                  if (fresh?.cancelRequestedAt && !meta.cancelRequested) {
                    meta.cancelRequested = true
                    console.log(
                      `[GoalLoopWorker] job ${job.id}: timer poll bắt được cancelRequestedAt từ DB (split-mode cross-process) → loop thoát ở ranh giới an toàn kế`
                    )
                  }
                })
                .catch(() => {}) // fail-open — DB bận không được phép giết timer
            }, GOAL_LOOP_CANCEL_POLL_MIN_INTERVAL_MS)
          : null

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
      // ROUND-28 W1 — DYNAMIC IMPORT mỗi job (không dùng binding tĩnh đã import
      //    lúc boot): worker singleton sống qua HMR sẽ KHÔNG BAO GIỜ thấy code
      // mới nếu giữ binding cũ. Log GOAL_LOOP_CODE_REV ngay tại đây để đối
      // chiếu trên dev.log rằng job chạy đúng revision mong muốn.
      const { runGoalDrivenLoop, GOAL_LOOP_CODE_REV } = await import('@/lib/agent-goal-loop')
      console.log(`[GoalLoopWorker] job ${job.id}: agent-goal-loop rev=${GOAL_LOOP_CODE_REV} (dynamic import)`)
      // ROUND-28 W1b — STALE CODE GUARD: so module-đã-nạp vs rev trên đĩa.
      // Lệch = code đã sửa nhưng HMR không tới được worker → cảnh báo to +
      // hành động rõ (job này vẫn chạy tiếp code cũ — trung thực, không giết).
      // Fail-open tuyệt đối: đọc đĩa lỗi (vd prod build không có source) → bỏ qua.
      try {
        const diskRev = await readGoalLoopDiskRev()
        if (diskRev && diskRev !== GOAL_LOOP_CODE_REV) {
          console.warn(`[GoalLoopWorker] ⚠️ job ${job.id}: STALE CODE — src/lib/agent-goal-loop.ts trên đĩa rev=${diskRev} ≠ module đã nạp rev=${GOAL_LOOP_CODE_REV} (HMR không thay được module trong singleton worker — đã kiểm chứng live round-28). Job này tiếp tục chạy CODE CŨ; RESTART app (pm2 restart theopusflashlite) để các job sau chạy code mới.`)
        }
      } catch { /* fail-open — guard không được phép làm hỏng claim */ }
      // ROUND-54 FIX B — LƯỚI AN TOÀN MTIME: rev-string khớp KHÔNG đủ (bằng
      // chứng r54: commit audit đổi file mà quên bump rev → detector mù). Quét
      // mtime cả HỌ goal-loop family — file nào sửa sau boot → cảnh báo STALE
      // kèm tên file cụ thể (chống cả class "quên bump rev" triệt để).
      try {
        const staleFamily = await detectStaleGoalLoopFamily()
        if (staleFamily.length > 0) {
          console.warn(`[GoalLoopWorker] ⚠️ job ${job.id}: STALE CODE (mtime) — ${staleFamily.length} file của goal-loop family sửa SAU lúc process boot (dynamic import vẫn resolve module graph CŨ — round-28): ${staleFamily.join(', ')}. RESTART app (pm2 restart theopusflashlite) để nạp code mới.`)
        }
      } catch { /* fail-open — guard không được phép làm hỏng claim */ }
      // R12 (P-NEW-2 lượt 5): job durable chạy THAY user (user vẫn chờ kết quả qua
      // polling) — đánh dấu user-chat priority để SelfDirection orchestration tự
      // nhường chỗ, đối xứng đường inline trong chat route.
      markUserChatRunActive()
      let result: GoalLoopResult
      try {
        result = await runGoalDrivenLoop({
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
          durable: {
            resumeState,
            onCheckpoint,
            onSignal,
            cancelCheck,
          } satisfies GoalLoopDurableHooks,
        })
      } finally {
        markUserChatRunDone()
      }

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
        // R36-ACT: transient lock ở preempt-requeue từng ném → catch → markFailed
        // (job pause bị tính thành chết) — retry theo họ lỗi tạm thời.
        const requeued = await withSqliteRetry(
          () => db.goalLoopJob.updateMany({
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
          }),
          { label: `goal-loop preempt-requeue job ${job.id}` },
        )
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
        // R36-ACT: retry transient rồi mới .catch — hỏng ghi cancel để job kẹt
        // 'running' sẽ bị orphan-sweep requeue (chạy lại tác vụ user đã dừng).
        await withSqliteRetry(
          () => db.goalLoopJob.updateMany({
            where: { id: job.id, status: 'running' },
            data: { status: 'cancelled', stopReason: 'cancelled', completedAt: new Date(), heartbeatAt: new Date() },
          }),
          { label: `goal-loop mark-cancelled job ${job.id}` },
        ).catch(() => {})
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
      // R36-ACT (fix gốc rễ 6 run Omega failed): completed-marking dính
      // "Socket timeout (the database failed to respond…)" khi DB bận >15s
      // (bằng chứng 07:32:41 + 08:45:04 — job chạy xong việc, đánh dấu hoàn
      // thành lại ném timeout → catch 1107 đổi thành FAILED, toàn bộ kết quả
      // của agent bị đích danh thành lỗi). Retry transient 3 lần (Task 33).
      const completed = await withSqliteRetry(
        () => db.goalLoopJob.updateMany({
          where: { id: job.id, status: 'running' },
          data: {
            status: 'completed',
            result: JSON.stringify(result),
            stopReason: result.goalLoop?.stopReason ?? null,
            completedAt: new Date(),
            heartbeatAt: new Date(),
          },
        }),
        { label: `goal-loop mark-completed job ${job.id}` },
      )
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
      // R42 FIX-STOP-2b — dọn timer poll cancel (không dọn = leak timer mỗi
      // job + giữ event loop khỏi exit sạch)
      if (cancelPollTimer) clearInterval(cancelPollTimer)
      this.running.delete(job.id)
      // R7-M2 (S4, audit R7-M1): job terminal → dọn counter preempt của job
      // (Map keyed jobId không bao giờ bị delete trước đây — mọc chậm).
      this.preemptCounts.delete(job.id)
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
    // R36-ACT: message Prisma bắt đầu bằng \n — log trước đây in "FAILED: "
    // trống (chẩn đoán khó); firstErrLine lấy dòng đầu thực (tiền lệ Task 33).
    console.error(`[GoalLoopWorker] job ${jobId} FAILED: ${firstErrLine(error).slice(0, 300)}`)
    emitAgentEvent('job_terminal', {
      jobId,
      sessionId: crashContext?.sessionId,
      runId: crashContext?.runId,
      data: { status: 'failed', error: error.slice(0, 300) },
    })
    // R36-ACT: chính lúc DB kẹt (nguyên nhân khiến job vào đây) thì mark-failed
    // cũng dễ fail — nếu không ghi được, job treo 'running' tới orphan-sweep.
    // Retry transient rồi .catch — fail-open giữ nguyên.
    await withSqliteRetry(
      () => db.goalLoopJob.updateMany({
        where: { id: jobId, status: 'running' },
        data: { status: 'failed', error: error.slice(0, 2000), completedAt: new Date(), heartbeatAt: new Date() },
      }),
      { label: `goal-loop mark-failed job ${jobId}` },
    ).catch(() => {})
    // REVIEW 14-g H2 — crash honest-close CI-2 (mirror route catch L1230+)
    // P-E (2026-10-06): crash cũng là gián đoạn — snapshot việc dở TRƯỚC khi
    // close (in_progress→failed, pending→archived) để run kế hồi quy tiếp.
    if (crashContext?.sessionId) {
      // R7 (user report "timer vẫn chạy sau khi agent lỗi bước cuối"):
      // markFailed TRƯỚC ĐÂY chỉ đánh dấu job DB + đóng todos — KHÔNG đóng
      // run in-memory của tracker → run kẹt 'running' vĩnh viễn (đồng hồ
      // Thought Process cứ tăng dù agent đã dừng thật). Đóng tracker NGAY
      // (fail-open — không được phép che lỗi gốc đã log).
      try {
        const { endAgentRun } = await import('@/lib/agent-run-tracker')
        if (crashContext.runId) {
          endAgentRun(crashContext.sessionId, crashContext.runId, 'error', `Job ${jobId} crash: ${error.slice(0, 160)}`)
        } else {
          // runId không có (đường parse-input lỗi) — đóng run ACTIVE của session
          const { getActiveRunId } = await import('@/lib/agent-run-tracker')
          const activeId = getActiveRunId(crashContext.sessionId)
          if (activeId) endAgentRun(crashContext.sessionId, activeId, 'error', `Job ${jobId} crash (active run): ${error.slice(0, 160)}`)
        }
        // Row AgentRunRecord 'running' của run này (dbPersistBy='caller' —
        // goal-loop chết trước lúc tự update) → lật failed NGAY thay vì đợi
        // orphan-sweep 30'. Idempotent — update theo (sessionId, runId).
        const { updateLatestAgentRunRecord } = await import('@/lib/metrics-db')
        if (crashContext.runId) {
          await updateLatestAgentRunRecord(
            crashContext.sessionId,
            {
              status: 'failed',
              stopReason: 'crashed',
              completedAt: new Date(),
            },
            crashContext.runId,
          ).catch(() => { /* fail-open — sweeper vẫn là lưới sau */ })
        }
      } catch (endErr) {
        console.warn(`[GoalLoopWorker] job ${jobId}: endAgentRun (crash-close tracker) lỗi (fail-open):`, endErr instanceof Error ? endErr.message : String(endErr))
      }
      try {
        const { recordRegressionSnapshot } = await import('@/lib/goal-loop-finalize')
        await recordRegressionSnapshot({
          sessionId: crashContext.sessionId,
          runId: crashContext.runId,
          stopReason: 'crashed',
        })
      } catch (snapErr) {
        console.warn(`[GoalLoopWorker] job ${jobId}: regression snapshot lỗi (fail-open):`, snapErr instanceof Error ? snapErr.message : String(snapErr))
      }
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
   *   - running ở process KHÁC còn sống (split-mode R42 FIX-STOP-2) → CHỈ set
   *     cancelRequestedAt (KHÔNG flip status — flip là láo: worker vẫn đang
   *     chạy) — worker poll flag này ở onSignal (nhịp heartbeat) rồi tự thoát
   *     + tự mark cancelled ở terminal mark
   *   - running KHÔNG trong Map + pid chủ đã chết (orphan thật) → cancelled thẳng
   *
   * R42 FIX-STOP-1 — mọi DB write/read trong đường cancel bọc withSqliteRetry
   * (mirror pattern checkpoint R36-ACT). Bằng chứng gốc: 2 lần user bấm Dừng
   * đều POST 500 sau 15.1s "Socket timeout" — write cancel không retry kẹt
   * lock SQLite dưới contention (worker đang ghi heartbeat/checkpoint/obs).
   */
  async cancel(jobId: string): Promise<boolean> {
    // 0. Read fresh (retry) — mọi quyết định nhánh dựa row HIỆN TẠI: trạng
    //    thái + workerPid. Bản cũ updateMany mù + chỉ nhìn Map local process
    //    này — split-mode đi nhánh orphan SAI cho job worker đang chạy.
    let row: { status: string; workerPid: number | null; cancelRequestedAt: Date | null } | null = null
    try {
      row = await withSqliteRetry(
        () => db.goalLoopJob.findUnique({
          where: { id: jobId },
          select: { status: true, workerPid: true, cancelRequestedAt: true },
        }),
        { label: `goal-loop cancel-read job ${jobId}` },
      )
    } catch (err) {
      console.warn(
        `[GoalLoopWorker] cancel job ${jobId}: đọc row lỗi sau retry:`,
        firstErrLine(err)
      )
      throw err // route → 500 — UI (FIX-STOP-3) giờ rollback + toast lỗi rõ ràng
    }
    if (!row) return false // không tồn tại
    if (row.status !== 'queued' && row.status !== 'running') return false // đã terminal
    if (row.cancelRequestedAt) return true // idempotent — flag đã bật từ lần bấm trước

    // 1. Job còn queued → cancelled ngay
    if (row.status === 'queued') {
      const queuedCancel = await withSqliteRetry(
        () => db.goalLoopJob.updateMany({
          where: { id: jobId, status: 'queued' },
          data: { status: 'cancelled', completedAt: new Date() },
        }),
        { label: `goal-loop cancel-queued job ${jobId}` },
      )
      if (queuedCancel.count === 1) {
        console.log(`[GoalLoopWorker] cancel job ${jobId} — queued → cancelled`)
        return true
      }
      // Status đổi giữa chừng (vd worker vừa claim → running) — lần bấm kế
      // xử lý nhánh running; không coi là lỗi
      return false
    }

    // 2. Job đang chạy trong process này → DB flag + in-memory flag
    const meta = this.running.get(jobId)
    if (meta) {
      meta.cancelRequested = true
      await withSqliteRetry(
        () => db.goalLoopJob.update({ where: { id: jobId }, data: { cancelRequestedAt: new Date() } }),
        { label: `goal-loop cancel-flag job ${jobId}` },
      ).catch((err) => {
        // Flag in-memory đã set — loop vẫn sẽ thoát; DB flag chỉ để bền qua
        // restart (nếu process chết ngay sau đó, job requeue rồi bị hủy lúc claim)
        console.warn(
          `[GoalLoopWorker] cancel job ${jobId}: set cancelRequestedAt lỗi (flag in-memory vẫn đã bật):`,
          firstErrLine(err)
        )
      })
      console.log(`[GoalLoopWorker] cancel job ${jobId} — running (process này): đã bật cancelRequestedAt, loop thoát ở vòng check kế`)
      return true
    }

    // 3. R42 FIX-STOP-2 — running KHÔNG trong Map process này, split-mode:
    //    workerPid còn sống (process khác đang chạy job) → CHỈ set
    //    cancelRequestedAt. Worker process poll flag (onSignal) rồi tự thoát
    //    + tự mark cancelled. Flip status 'cancelled' ở đây sẽ LÁO (agent vẫn
    //    chạy tiếp ở worker — đúng bệnh "bấm dừng không dừng được").
    const pidAlive = Boolean(
      row.workerPid && row.workerPid !== process.pid && this.isWorkerPidAlive(row.workerPid)
    )
    if (pidAlive) {
      await withSqliteRetry(
        () => db.goalLoopJob.updateMany({
          where: { id: jobId, status: 'running' },
          data: { cancelRequestedAt: new Date() },
        }),
        { label: `goal-loop cancel-cross-process job ${jobId}` },
      )
      console.log(
        `[GoalLoopWorker] cancel job ${jobId} — running ở process ${row.workerPid} (split-mode): đã set cancelRequestedAt — worker poll sẽ thoát loop ở ranh giới an toàn`
      )
      return true
    }

    // 4. Orphan thật (pid chủ đã chết / null — process cũ chết giữa chừng,
    //    không ai chạy job này) → cancelled thẳng
    const orphanCancel = await withSqliteRetry(
      () => db.goalLoopJob.updateMany({
        where: { id: jobId, status: 'running' },
        data: { status: 'cancelled', completedAt: new Date() },
      }),
      { label: `goal-loop cancel-orphan job ${jobId}` },
    )
    if (orphanCancel.count === 1) {
      console.log(
        `[GoalLoopWorker] cancel job ${jobId} — running mồ côi (pid ${row.workerPid ?? 'null'} đã chết) → cancelled`
      )
      return true
    }
    return false // status đổi giữa chừng — lần bấm kế xử lý
  }

  /**
   * Nút Dừng mọi job của 1 session (dùng bởi 14-c ở agent-run cancel route):
   * queued → cancelled; running trong Map → flag + cancelRequestedAt; running
   * ở process khác còn sống (split-mode R42) → chỉ cancelRequestedAt (worker
   * tự thoát qua poll); running mồ côi (pid chết) → cancelled thẳng.
   * Return số job affected. Mọi write bọc withSqliteRetry (FIX-STOP-1).
   */
  async cancelSessionJobs(sessionId: string): Promise<number> {
    // Mọi job queued của session → cancelled
    const queuedCancel = await withSqliteRetry(
      () => db.goalLoopJob.updateMany({
        where: { sessionId, status: 'queued' },
        data: { status: 'cancelled', completedAt: new Date() },
      }),
      { label: `goal-loop cancel-session-queued ${sessionId}` },
    )
    // Job running của session — tách 3 nhóm: trong Map (bật flag, loop tự
    // thoát) / process khác còn sống (chỉ cancelRequestedAt — worker poll)
    // / mồ côi pid chết (cancel thẳng)
    const runningRows = await withSqliteRetry(
      () => db.goalLoopJob.findMany({
        where: { sessionId, status: 'running' },
        select: { id: true, workerPid: true },
      }),
      { label: `goal-loop cancel-session-read ${sessionId}` },
    )
    const inMapIds: string[] = []
    const crossProcessIds: string[] = []
    const orphanIds: string[] = []
    for (const row of runningRows) {
      const meta = this.running.get(row.id)
      if (meta) {
        meta.cancelRequested = true
        inMapIds.push(row.id)
      } else if (
        row.workerPid &&
        row.workerPid !== process.pid &&
        this.isWorkerPidAlive(row.workerPid)
      ) {
        crossProcessIds.push(row.id) // R42 — worker khác đang chạy, không flip status
      } else {
        orphanIds.push(row.id)
      }
    }
    if (inMapIds.length > 0) {
      await withSqliteRetry(
        () => db.goalLoopJob.updateMany({
          where: { id: { in: inMapIds } },
          data: { cancelRequestedAt: new Date() },
        }),
        { label: `goal-loop cancel-session-flag ${sessionId}` },
      ).catch(() => {})
    }
    if (crossProcessIds.length > 0) {
      await withSqliteRetry(
        () => db.goalLoopJob.updateMany({
          where: { id: { in: crossProcessIds } },
          data: { cancelRequestedAt: new Date() },
        }),
        { label: `goal-loop cancel-session-cross ${sessionId}` },
      ).catch(() => {})
    }
    if (orphanIds.length > 0) {
      await withSqliteRetry(
        () => db.goalLoopJob.updateMany({
          where: { id: { in: orphanIds } },
          data: { status: 'cancelled', completedAt: new Date() },
        }),
        { label: `goal-loop cancel-session-orphan ${sessionId}` },
      ).catch(() => {})
    }
    const affected = queuedCancel.count + inMapIds.length + crossProcessIds.length + orphanIds.length
    console.log(
      `[GoalLoopWorker] cancelSessionJobs ${sessionId}: ${queuedCancel.count} queued → cancelled, ${inMapIds.length} running bật flag cancel, ${crossProcessIds.length} running cross-process set cancelRequestedAt (split), ${orphanIds.length} running mồ côi → cancelled`
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
