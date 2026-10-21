/**
 * CI-5 (GĐ4) — Durable Goal Loop: SHARED CONTRACT TYPES
 * =====================================================
 *
 * File này là HỢP ĐỒNG (contract) dùng chung giữa 3 mảnh của kiến trúc
 * durable goal loop — được tách thành module riêng CHỈ chứa types + hằng số
 * env (0 side-effect, 0 import) để tránh circular dependency:
 *
 *   1. `agent-goal-loop.ts`   — thêm hooks (resumeState / onCheckpoint /
 *                               onSignal / cancelCheck) consume các type này.
 *   2. `goal-loop-worker.ts`  — worker nền produce checkpoint + đọc lại làm
 *                               resumeState sau restart (recoverPending).
 *   3. `api/openclaw/chat` + `api/goal-loop-jobs` — enqueue input + poll.
 *
 * Nguyên tắc thiết kế (roadmap CI-5):
 *   - Checkpoint KHÔNG lưu full raw messages vô hạn — messages đã được CI-3
 *     rolling compression nén @50k chars → checkpoint tự bounded.
 *   - Checkpoint ghi SAU MỖI VÒNG LẶP (iteration), không chỉ mỗi chu kỳ —
 *     resume có granularity đúng 1 vòng: kill -9 giữa chừng chỉ replay tối đa
 *     1 vòng LLM, file đã sửa ở vòng trước KHÔNG lặp lại (transcript trong
 *     messages ghi rõ việc đã làm).
 *   - Cancel qua DB flag (cancelRequestedAt) — nút Dừng hoạt động kể cả sau
 *     khi tab đóng / app restart (không phụ thuộc RAM).
 *   - Heartbeat (onSignal) — gọi mỗi vòng + mỗi tool batch → worker ghi
 *     heartbeatAt; stall-kill thích ứng chỉ kill khi KHÔNG có tín hiệu sống.
 */

// ==================== MESSAGE SNAPSHOT ====================

/**
 * Snapshot 1 message trong transcript goal-loop lúc checkpoint.
 * GoalMessage nội bộ của agent-goal-loop có field mở rộng (tool_calls, name…)
 * — snapshot chỉ giữ 2 field cốt lõi để checkpoint nhẹ + schema ổn định qua
 * các lần refactor nội bộ loop. Role 'tool' giữ nguyên content tool-result.
 */
export interface GoalLoopMessageSnapshot {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  /**
   * Giữ nguyên tool_call_id khi snapshot message tool — nếu bỏ, resume sẽ tạo
   * orphan tool reply (không có tool_call_id khớp) và CI-3 pairing-splice sẽ
   * không nhận diện được cặp assistant↔tool khi nén tiếp.
   */
  tool_call_id?: string
}

// ==================== CHECKPOINT ====================

/** Verdict trọng tài (EvalVerdict) dạng serializable — bỏ field `raw` (lớn). */
export interface GoalLoopVerdictSnapshot {
  complete: boolean
  confidence: number
  verified: boolean
  missing: string[]
  rootCause: string
  nextPlan: string[]
  /** FIX 2026-09-14 #9 — side issues + debt decision của trọng tài (resume
   * giữa debt cycle vẫn khôi phục được ngữ cảnh lỗi phát sinh). */
  sideIssues?: string[]
  debtDecision?: 'none' | 'record' | 'continue'
  /** 2026-10-27 (phiên 4) — GĐ3 readiness: nợ có thể xử lý ở chu kỳ kế không
   * (resume giữa run vẫn giữ phán quyết readiness của trọng tài). */
  debtReadiness?: 'ready' | 'blocked'
  debtBlockedReason?: string
  /** TASK 48 — needs-input: mục tiêu bị chặn bởi thông tin CHỈ user cung cấp
   * được (resume giữa run vẫn giữ phán quyết — không mất trạng thái chờ input). */
  needsInput?: boolean
}

/**
 * Evidence entry snapshot — giữ NGUYÊN shape EvidenceEntry nội bộ (preview
 * ~200 chars/entry) nhưng serialize an toàn: cap 120 entry cuối (mới nhất)
 * để checkpoint không phình khi tác vụ chạy nhiều giờ.
 */
export interface GoalLoopEvidenceSnapshot {
  cycle: number
  kind: 'tool' | 'directive'
  tool?: string
  success?: boolean
  text: string
}

/** Điểm khôi phục đầy đủ của 1 goal-loop run — ghi mỗi vòng, đọc khi resume. */
export interface GoalLoopCheckpoint {
  version: 1
  /** runId của agent-run-tracker — resume dùng LẠI runId này để todos (CI-2
   *  keyed theo runId) + AgentRunRecord + panel Thought Process liền mạch. */
  runId: string | null
  /** Toàn bộ transcript hiện tại (đã qua CI-3 compression → bounded ~50k chars) */
  messages: GoalLoopMessageSnapshot[]
  /** Bằng chứng chu kỳ — cap 120 entry cuối */
  evidence: GoalLoopEvidenceSnapshot[]
  counters: {
    cyclesDone: number
    cyclesAttempted: number
    totalIterations: number
    totalToolCalls: number
    tokensUsed: number
    compressions: number
    delegations: number
    subagentTokens: number
    escalations: number
    parseFailNudges: number
    /** ROUND-26 FIX A — nudge prose-only đã dùng (max 2/run). Optional: checkpoint cũ không có → hiểu 0. */
    proseNudges?: number
    /** r66 (V2b) — thống kê phân công run: thao tác tự triển khai (modify
     * tools) / lượt delegation / nudge phân công đã dùng. Optional: checkpoint
     * cũ không có → hiểu 0. */
    selfModifyOps?: number
    delegationOps?: number
    delegationNudges?: number
    /** r67 (F7) — số lần CỔNG PHÂN CÔNG cắt chu kỳ (trần 2/run).
     * r67 (F9) — số lần cảnh báo ngôn ngữ tiếng Việt đã dùng (trần 2/run). */
    delegationGateCuts?: number
    viNudges?: number
    /** r68 (BUG-005 — quan sát mission cmuznvkl…6b136k): vi phạm ngôn ngữ
     * SAU khi cạn trần nudge 2/2 — không nudge nữa nhưng VẪN ĐẾM và ghi
     * evidence cho trọng tài chu kỳ thấy (trước đây sau trần là im lặng
     * tuyệt đối → vi phạm "miễn phí"). Optional: checkpoint cũ không có → 0. */
    viLateCount?: number
  }
  /** Verdict chu kỳ gần nhất (null nếu chưa có evaluate nào) */
  verdict: GoalLoopVerdictSnapshot | null
  /** ROUND-27 FIX V2 — tư vấn Omega orchestrator + báo cáo AUTO-APPLY sub-agent
   *  đang chờ inject vào continuation directive của chu kỳ kế tiếp (set ở cuối
   *  chu kỳ N, consume đầu chu kỳ N+1). Persist qua checkpoint: restart giữa 2
   *  chu kỳ không còn mất trắng (escalations>0 đã chặn consult lại). Optional:
   *  checkpoint cũ không có → hiểu ''. */
  omegaAdvisory?: string
  /** Fingerprint chống no-progress (prevFingerprint trong loop) */
  fingerprint: string
  noProgressCount: number
  stallCycles: number
  cutMidWorkPrev: boolean
  lastContent: string
  lastLlmError: string
  /** REVIEW 9-fix (2026-08-30) #9 — state debt cycle: resume giữa debt cycle
   *  vẫn inject đúng debt directive + không lặp debt cycle thứ 2 sau restart.
   *  (Optional — checkpoint cũ không có → hiểu là false.)
   *  TASK 21: debtCycleUsed DEPRECATED — thay bằng debtCyclesRun (counter). */
  debtMode?: boolean
  debtCycleUsed?: boolean
  /** TASK 21 (2026-09-30) — số đợt debt cycle đã chạy (nhiều đợt liên tiếp
   *  thay vì 1/run). Checkpoint cũ chỉ có debtCycleUsed boolean → đọc là 1. */
  debtCyclesRun?: number
  /** TASK 21 — số lần TÁI LẬP CỬA SỔ CHU KỲ đã dùng khi hết trần mà việc chưa
   *  xong triệt để (trần hiệu dụng = MAX_CYCLES × (1 + cycleRenewals)). */
  cycleRenewals?: number
  /** FIX (review R2-b #2, 2026-08-31) — danh sách debt issues còn TREO (side
   *  issues đã quyết định chạy debt cycle nhưng debt cycle dở dang). Persist để
   *  resume giữa debt cycle: evaluateCompletion nhận lại debtIssues → rule 10
   *  DEBT CHECK kích hoạt đúng, nợ không bị phán complete xóa chìm.
   *  (Optional — checkpoint cũ không có → hiểu là [].) */
  pendingDebtIssues?: string[]
  /** ROUND-12c (2026-09-30 — user report "kẹt lặp todo_write + tra cứu
   *  registry chu kỳ 54-67, không chuyển sang triển khai"): toolSignatureCounts
   *  là in-memory run-scoped — process chết bởi RSS self-exit mỗi ~2 phút →
   *  map reset → ngưỡng đọc-lặp 3/4/8 KHÔNG BAO GIỜ đạt trong 1 đời sống.
   *  Persist signature counter (chỉ entry count ≥2, cap 200) qua checkpoint
   *  để phát hiện lặp tích lũy QUA restart. (Optional — cũ → hiểu [].) */
  toolSignatures?: Array<[string, number]>
  /** ROUND-12c — số chu kỳ LIÊN TIẾP chỉ có tool quan sát/lập kế hoạch
   *  (todo_write, list registry, read) KHÔNG có tool triển khai nào.
   *  Streak ≥2 → chu kỳ kế bị ép chuyển sang GĐ2 (triển khai) ngay.
   *  (Optional → 0.) */
  planningOnlyStreak?: number
  /** P6-M1 W2 (FB-P6-R1-B-03): bảng đếm model THỰC TẾ của CẢ run (model → số
   *  call chính) — persist qua checkpoint để run resumed tính dominantModel
   *  trên đủ chu kỳ (bản trước Map mới sau restart → reward chỉ theo đoạn cuối).
   *  (Optional → Map rỗng như cũ.) */
  modelsUsed?: Array<[string, number]>
  /** Epoch ms lúc checkpoint được ghi */
  savedAt: number
}

// ==================== JOB INPUT ====================

/**
 * Input đầy đủ để (re)chạy 1 goal-loop job sau restart — MỌI thứ
 * runGoalDrivenLoop cần phải nằm trong đây (closure không sống qua restart).
 */
export interface GoalLoopJobInput {
  systemPrompt: string
  userMessage: string
  chatHistory: Array<{ role: string; content: string }>
  agentProvider: string
  agentModel: string
  agentId: string
  agentName: string
  agentTemperature?: number
  agentMaxTokens?: number
  agentTools: string[]
  agentSessionId: string | null
}

// ==================== HOOKS (loop ↔ worker) ====================

/**
 * Bundle hooks durable truyền vào runGoalDrivenLoop. TẤT CẢ optional —
 * không truyền = hành vi inline cũ 100% (feature flag off path).
 */
export interface GoalLoopDurableHooks {
  /**
   * Khôi phục từ checkpoint (sau kill -9 / restart). Có resumeState:
   * - messages KHÔNG build lại từ chatHistory + userMessage (dùng snapshot)
   * - counters/verdict/fingerprint… khôi phục đúng giá trị
   * - runId tracker DÙNG LẠI (startAgentRun(runId override))
   * - priorTaskSummariesBlock/pagination… không inject lại (đã trong messages)
   */
  resumeState?: GoalLoopCheckpoint
  /**
   * Ghi sau MỖI vòng lặp (iteration) + ngay trước khi loop return (final).
   * Worker implement: UPDATE GoalLoopJob SET checkpoint, cyclesDone,
   * heartbeatAt — throttle bên trong worker (không phải việc của loop).
   * Fail-open bắt buộc: lỗi checkpoint KHÔNG BAO GIỜ làm hỏng loop.
   */
  onCheckpoint?: (checkpoint: GoalLoopCheckpoint) => void | Promise<void>
  /**
   * Heartbeat tín hiệu sống — gọi mỗi vòng + mỗi tool batch + mỗi lần nén
   * context. Worker throttle ghi DB (default ≥15s/lần) — loop gọi thoải mái.
   */
  onSignal?: (signal: 'iteration' | 'tool_batch' | 'compression' | 'cycle') => void | Promise<void>
  /**
   * Override hàm cancel check mặc định (isSessionCancelled in-memory).
   * Worker truyền: () => sessionCancelled || job.cancelRequestedAt !== null
   * → nút Dừng qua DB flag cắt ngang loop giữa các vòng / trước tool call.
   */
  cancelCheck?: () => boolean
}

// ==================== ENV (đọc 1 lần lúc module load) ====================

/**
 * REVIEW 14-g L6 — parseInt + fallback (Number('garbage') = NaN → setInterval
 * (NaN) ≈ 1ms spin CPU; Number('') = 0 có nghĩa hợp lý "tắt" nên giữ 0).
 */
function intEnvWithDefault(name: string, def: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') return def
  const parsed = parseInt(raw, 10)
  return Number.isFinite(parsed) ? parsed : def
}

/** 0 = tắt worker hẳn (không tick) */
export const GOAL_LOOP_WORKER_TICK_MS = intEnvWithDefault('GOAL_LOOP_WORKER_TICK_MS', 5000)
/**
 * Số job goal-loop chạy đồng thời tối đa.
 * R18 (user bug report "Omega gọi nhiều agent khác CÙNG LÚC làm việc — thiết kế
 * yêu cầu 1 agent khác/lượt, các agent sau XẾP LỖT"): default 2 → 1. Bằng chứng
 * điều tra R18: máy user không có override .env (env không track git) → nhận
 * default 2 → worker chạy 2 job song song = 2 agent "đang chạy" cùng lúc ngoài
 * ý muốn. User directive là TUẦN TỰ toàn diện (mirror SUBAGENT_MAX_CONCURRENT=1
 * R14 — 2 tầng cùng 1 quy tắc). Nâng lại: đặt GOAL_LOOP_MAX_CONCURRENT=2 qua
 * env (chỉ khi RAM dư + p95 chờ slotPool cao — xem docs/QUYET-DINH-TUAN-TU-VS-CONCURRENCY-R15.md).
 */
export const GOAL_LOOP_MAX_CONCURRENT = Math.max(1, intEnvWithDefault('GOAL_LOOP_MAX_CONCURRENT', 1))
/**
 * R18 — TRẦN TUỔI RESUME: job mồ côi (running-mà-không-có-chủ sau crash/restart)
 * cũ hơn ngưỡng này KHÔNG được requeue nữa → mark failed 'stale'. Chống "tác vụ
 * ma" định kỳ: job kẹt từ hôm trước được resume MỌI LẦN BOOT, mỗi lần đốt nguyên
 * chuỗi failover LLM (5 spawn CLI × 400-590MB) dù user không yêu cầu gì — đúng
 * symptom user report "request định kỳ mặc dù không động vào app". 0 = tắt trần
 * (resume mọi tuổi — hành vi cũ).
 */
export const GOAL_LOOP_RESUME_MAX_AGE_MS = Math.max(0, intEnvWithDefault('GOAL_LOOP_RESUME_MAX_AGE_MS', 12 * 60 * 60 * 1000))
/**
 * Job 'running' trong DB mà KHÔNG nằm trong running-map của process này
 * (orphan do restart/crash) được requeue nếu attempts < maxAttempts.
 * Heartbeat stale quá ngưỡng này → stall warning (UI) — KHÔNG kill job đang
 * chạy trong process (LLM call tối đa 8' + tool timeout → chọn 15' an toàn).
 */
export const GOAL_LOOP_STALL_WARN_MS = intEnvWithDefault('GOAL_LOOP_STALL_WARN_MS', 900000)
/** Số lần requeue tối đa cho 1 job sau crash (chết vĩnh viễn → failed) */
// F6 (OBS P7 — user duyệt fix F1-F6 2026-10-20): default 2 → 5 — môi trường
// sống có 153 restarts pm2 (MemWatchdog self-exit + reaper sandbox RSS) → 2
// attempts cạn sau 2 lần restart hạ tầng, job user chết "mồ côi" dù việc còn
// đang chạy tốt (bằng chứng 2 job cmvgdo1er…/cmvg25p2a…). 5 cho job đủ hơi
// sống qua chuỗi restart ngắn; .env ghi đè khi cần.
export const GOAL_LOOP_MAX_ATTEMPTS = Math.max(1, intEnvWithDefault('GOAL_LOOP_MAX_ATTEMPTS', 5))
/** Throttle ghi checkpoint vào DB (ms) — tránh ghi 50k chars mỗi vòng liên tục */
export const GOAL_LOOP_CHECKPOINT_MIN_INTERVAL_MS = Math.max(0, intEnvWithDefault('GOAL_LOOP_CHECKPOINT_MIN_INTERVAL_MS', 3000))
/** Throttle ghi heartbeat (ms) */
export const GOAL_LOOP_HEARTBEAT_MIN_INTERVAL_MS = Math.max(0, intEnvWithDefault('GOAL_LOOP_HEARTBEAT_MIN_INTERVAL_MS', 15000))
/** R42 FIX-STOP-2 — nhịp poll cancelRequestedAt từ DB (ms) của timer ĐỘC LẬP
 * mỗi job (không bám onSignal — LLM call dài 60-120s không bắn signal nào,
 * poll bám signal sẽ trễ thêm cả 1 vòng). SELECT 1 row theo PK — rẻ, fail-open.
 * Đặt 0 để tắt timer (poll onSignal 15s vẫn còn làm lưới dự phòng). */
export const GOAL_LOOP_CANCEL_POLL_MIN_INTERVAL_MS = Math.max(0, intEnvWithDefault('GOAL_LOOP_CANCEL_POLL_MIN_INTERVAL_MS', 5000))

// ==================== TASK C — STARVATION PREEMPTION (per-session mutex) ====================

/**
 * TASK C — ngưỡng cảnh báo starvation mutex per-session: job queued bị chờ
 * (session có job khác đang chạy giữ mutex — claimQueued skip mỗi tick) ≥
 * ngưỡng này → warn ⚠ (throttle 60s/session) + event 'session_mutex_starvation'
 * + cho phép preempt blocker khi đủ điều kiện STALL_PREEMPT. 0 = tắt
 * starvation tracking (cả warn lẫn preempt). Sự cố 2026-10-27: 2 job đói
 * mutex 4.5h (3.258 dòng spam log) — trước đây KHÔNG có max-wait/preemption.
 */
export const GOAL_LOOP_MUTEX_STARVE_WARN_MS = Math.max(0, intEnvWithDefault('GOAL_LOOP_MUTEX_STARVE_WARN_MS', 600000))
/**
 * TASK C — điều kiện preempt: blocker trong Map running có heartbeat /
 * last-activity stale ≥ ngưỡng này (mặc định 30' — XA hơn trần LLM call 8' +
 * tool time, chỉ job wedged mới chạm) VÀ follower queued cùng session starvation
 * ≥ GOAL_LOOP_MUTEX_STARVE_WARN_MS → worker xin PAUSE blocker (mirror pattern
 * cancelRequested): loop thoát ở ranh giới vòng an toàn → requeue GIỮ
 * checkpoint, nhường mutex cho follower. 0 = tắt preempt (warn vẫn chạy).
 */
export const GOAL_LOOP_STALL_PREEMPT_MS = Math.max(0, intEnvWithDefault('GOAL_LOOP_STALL_PREEMPT_MS', 1800000))
/**
 * TASK C — anti-thrash: mỗi job được preempt-requeue tối đa ngưỡng này lần
 * (đếm in-memory theo jobId, reset khi worker restart) — preempt tiếp khi đã
 * vượt ngưỡng → mark failed ('stale-heartbeat preempt limit') thay vì requeue.
 */
export const GOAL_LOOP_MUTEX_MAX_PREEMPTS = Math.max(1, intEnvWithDefault('GOAL_LOOP_MUTEX_MAX_PREEMPTS', 3))

// ==================== DEBT-R17BC — PID-RECYCLING GATE (orphan sweep) ====================

/**
 * DEBT-R17BC (nợ follow-up pilot W2 2026-10-20 — trả 2026-10-21) —
 * PID-RECYCLING GATE cho orphan sweep: Linux tái chế pid nên "pid còn sống"
 * qua process.kill(pid, 0) CHƯA đủ tin rằng chủ cũ của job còn chạy (bằng
 * chứng pilot: probe chết → pid 32463 được process khác tái sử dụng →
 * isWorkerPidAlive true nhầm → sweep SKIP requeue → job mồ côi kẹt 'running'
 * tới trần STALE-AGE 12h mới bị mark failed, không bao giờ RESUME).
 * Quyết định THUẦN (dễ unit test — không đụng DB/process):
 *   - pid chết → không nghi (đường requeue thường đã xử).
 *   - pid sống + heartbeat chưa từng ghi (null/undefined) → TIN pid (bảo thủ:
 *     claim ghi heartbeatAt ngay khi đổi status sang running nên đây chỉ là
 *     row legacy — thiếu tín hiệu thì không phạt).
 *   - pid sống + heartbeat stale ≥ threshold (default GOAL_LOOP_STALL_PREEMPT_MS
 *     30' — xa hơn trần LLM 8'; heartbeat DB ghi MỖI VÒNG/tool batch, throttle
 *     15s) → NGHI tái chế: hoặc pid bị process khác tái sử dụng, hoặc job đã
 *     wedged — cả hai đều đã nằm trong semantics preempt (requeue GIỮ
 *     checkpoint qua updateMany conditional chống đè race) nên an toàn tương
 *     đương đường stall-preempt hiện có.
 *   - threshold ≤ 0 → tắt gate (đồng bộ ngữ nghĩa "0 = tắt" của họ GOAL_LOOP_
 *     preempt/starve — fail-safe về hành vi cũ).
 */
export function isPidRecycleSuspect(
  pidAlive: boolean,
  heartbeatAgeMs: number | null | undefined,
  thresholdMs: number = GOAL_LOOP_STALL_PREEMPT_MS
): boolean {
  if (!pidAlive) return false
  if (thresholdMs <= 0) return false
  if (heartbeatAgeMs === null || heartbeatAgeMs === undefined || !Number.isFinite(heartbeatAgeMs)) return false
  return heartbeatAgeMs >= thresholdMs
}

// ==================== TASK 43 — ADAPTIVE CONCURRENCY (AUTO-SCALING) ====================

/**
 * Auto-scale số job chạy song song trong khoảng [1, GOAL_LOOP_MAX_CONCURRENT]:
 *   - SCALE UP khi queue depth > số job đang chạy (còn slot trần, không stall)
 *   - SCALE DOWN khi có job stall-heartbeat (bảo vệ tải — KHÔNG kill job)
 * 'off' → cố định GOAL_LOOP_MAX_CONCURRENT (hành vi cũ tĩnh).
 */
export const GOAL_LOOP_ADAPTIVE_CONCURRENCY = process.env.GOAL_LOOP_ADAPTIVE_CONCURRENCY !== 'off'
/** Ngưỡng hàng đợi cảnh báo backpressure (số job queued — KHÔNG reject, chỉ warn + event) */
export const GOAL_LOOP_QUEUE_WARN_THRESHOLD = Math.max(1, intEnvWithDefault('GOAL_LOOP_QUEUE_WARN_THRESHOLD', 25))

// ==================== JOB STATUS (DB string constants) ====================

export type GoalLoopJobStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'

export const GOAL_LOOP_JOB_STATUSES: readonly GoalLoopJobStatus[] = [
  'queued',
  'running',
  'completed',
  'failed',
  'cancelled',
] as const
