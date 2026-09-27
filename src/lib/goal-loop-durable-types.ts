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
  }
  /** Verdict chu kỳ gần nhất (null nếu chưa có evaluate nào) */
  verdict: GoalLoopVerdictSnapshot | null
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
  /**
   * 2026-10-27 (user directive — trần prompt THEO TÁC VỤ): -1 = không giới
   * hạn; undefined = mặc định hệ thống. Phải nằm trong job input để re-run
   * sau restart dùng ĐÚNG trần của tác vụ gốc (closure không sống qua restart).
   */
  promptBudgetChars?: number
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
/** Số job chạy đồng thời tối đa — Mr. Architect chốt: 2 */
export const GOAL_LOOP_MAX_CONCURRENT = Math.max(1, intEnvWithDefault('GOAL_LOOP_MAX_CONCURRENT', 2))
/**
 * Job 'running' trong DB mà KHÔNG nằm trong running-map của process này
 * (orphan do restart/crash) được requeue nếu attempts < maxAttempts.
 * Heartbeat stale quá ngưỡng này → stall warning (UI) — KHÔNG kill job đang
 * chạy trong process (LLM call tối đa 8' + tool timeout → chọn 15' an toàn).
 */
export const GOAL_LOOP_STALL_WARN_MS = intEnvWithDefault('GOAL_LOOP_STALL_WARN_MS', 900000)
/** Số lần requeue tối đa cho 1 job sau crash (chết vĩnh viễn → failed) */
export const GOAL_LOOP_MAX_ATTEMPTS = Math.max(1, intEnvWithDefault('GOAL_LOOP_MAX_ATTEMPTS', 2))
/** Throttle ghi checkpoint vào DB (ms) — tránh ghi 50k chars mỗi vòng liên tục */
export const GOAL_LOOP_CHECKPOINT_MIN_INTERVAL_MS = Math.max(0, intEnvWithDefault('GOAL_LOOP_CHECKPOINT_MIN_INTERVAL_MS', 3000))
/** Throttle ghi heartbeat (ms) */
export const GOAL_LOOP_HEARTBEAT_MIN_INTERVAL_MS = Math.max(0, intEnvWithDefault('GOAL_LOOP_HEARTBEAT_MIN_INTERVAL_MS', 15000))

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
