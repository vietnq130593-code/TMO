/**
 * EPISODIC MEMORY — Types (A6 · phần A)
 *
 * Episodic memory ≠ semantic memory:
 *   - KB hiện tại (Neo4j entities/relationships + Qdrant chunks) = TRI THỨC
 *     ("biết cái gì" — Concept, Technology, quan hệ...)
 *   - Episodic memory = TRẢI NGHIỆM ("đã xảy ra gì, tôi làm gì, kết quả
 *     ra sao, rút ra bài học gì")
 *
 * Nguyên tắc lõi (A.1):
 *   1. Mọi episode đều có outcome — không lưu hành động vô nghĩa
 *   2. Lesson là node riêng — bài học phải tái sử dụng được, độc lập với
 *      episode sinh ra nó
 *   3. Episode liên kết semantic KB — episode về "Neo4j query fail" nối
 *      node `Neo4j` trong KB → hỏi về Neo4j, tri thức LẪN kinh nghiệm cùng hiện ra
 *   4. Decay có chủ đích — episode cũ ít liên quan dần, Lesson thì bất tử
 *
 * Storage topology:
 *   - Neo4j (graph primary): Episode/Action/ErrorOccurrence/Lesson/Strategy
 *     nodes + quan hệ CONTAINS/YIELDED/TAUGHT/SIMILAR_TO/INVOLVES/ABOUT...
 *   - Qdrant collection `theopus_episodes` (semantic index): embed summary
 *     episode → tìm episode giống (cosine ≥ 0.8 → [:SIMILAR_TO])
 *   - SQLite mirror (EpisodeRecord/LessonRecord): fallback bền khi Neo4j
 *     drift/reset + dashboard đọc nhanh (raw-SQL bridge — client stale-safe)
 */

// ==================== ROOT CAUSE TAXONOMY (phần B) ====================

/**
 * Tầng 1 — ROOT CAUSE (tại sao sai), 6 loại (B.1).
 * Tầng 2 — MANIFESTATION (biểu hiện ra sao) → dùng ErrorType 17 loại hiện
 * có của TMO (error-handling/types.ts) làm category — 2 tầng ghép nhau.
 */
export const ROOT_CAUSES = [
  'INPUT_INVALID',      // R1 — đầu vào sai
  'ASSUMPTION_WRONG',   // R2 — giả định sai về thế giới
  'KNOWLEDGE_GAP',      // R3 — thiếu tri thức
  'TOOL_FAILURE',       // R4 — công cụ lỗi (không phải lỗi agent)
  'REASONING_ERROR',    // R5 — lỗi suy luận
  'ENV_DRIFT',          // R6 — môi trường thay đổi
] as const
export type RootCauseCode = (typeof ROOT_CAUSES)[number]

/** Mã manifestation tầng 2 (M1.1…M6.3) — mô tả chi tiết trong taxonomy.ts */
export interface Manifestation {
  code: string        // "M2.1"
  description: string // "đoán sai nội dung file/schema (chưa đọc đã sửa)"
  /** Regex markers nhận diện raw error message (lowercase-match) */
  markers: RegExp[]
}

/** 1 entry bảng B.2 — phản ứng ĐÚNG vs anti-pattern */
export interface RootCausePlaybook {
  code: RootCauseCode
  label: string
  /** Phản ứng ĐÚNG — agent tra bảng, không cần "sáng tạo" */
  correctResponse: string
  /** Phản ứng SAI — anti-pattern cần né */
  antiPattern: string
}

// ==================== NODE SHAPES (A.2 → TS interfaces) ====================

/** Outcome của 1 episode (A.2 Node 1) */
export type EpisodeOutcome = 'SUCCESS' | 'FAILURE' | 'PARTIAL' | 'ABANDONED'

/** Episode — đơn vị trải nghiệm hoàn chỉnh (Neo4j :Episode + mirror SQLite) */
export interface EpisodeNode {
  id: string                 // "ep_<ts>_<rand>"
  title: string
  goal: string
  contextSummary: string
  startedAt: Date
  endedAt: Date
  outcome: EpisodeOutcome
  /** Độ tin của việc đánh giá outcome (evaluator confidence) */
  confidence: number
  agent: string              // OMEGA | RAMPAGE | SENTINEL...
  sessionId?: string | null
  /** 0-1 — decay & retrieval ranking */
  importance: number
  accessCount: number
  lastAccessed: Date
  /** Qdrant point id (collection theopus_episodes) */
  embeddingId?: string | null
  /** Metadata run (từ goal-loop) — không nằm trong schema A.2 nhưng có sẵn */
  cycles?: number
  tokensUsed?: number
  toolCalls?: number
  toolFailures?: number
  stopReason?: string
}

/** Action — một hành động cụ thể trong episode (Neo4j :Action) */
export interface ActionNode {
  id: string                 // "act_<rand>"
  sequence: number
  tool: string               // file_edit | shell | delegate_task...
  inputSummary: string
  reasoning?: string
  result: 'SUCCESS' | 'FAIL'
  /** link tới ErrorOccurrence id nếu fail */
  errorRef?: string | null
}

/** ErrorOccurrence — một lần lỗi cụ thể (Neo4j :ErrorOccurrence) */
export interface ErrorOccurrenceNode {
  id: string                 // "err_<rand>"
  rawMessage: string
  /** Manifestation — ErrorType 17 loại hiện có của TMO */
  category: string
  rootCause: RootCauseCode
  /** Mã manifestation M*.n nếu nhận diện được */
  manifestation?: string | null
  /** Tool sinh ra lỗi (field runtime — không ghi Neo4j, dùng cho heuristic resolve) */
  tool?: string
  occurredAt: Date
  resolved: boolean
  fixSummary?: string | null
}

/** Lesson — bài học rút ra, TỒN TẠI VĨNH VIỄN (Neo4j :Lesson + mirror) */
export interface LessonNode {
  id: string                 // "lesson_<rand>"
  statement: string          // "Khi [trigger], nên [fix] vì [root_cause]"
  triggerCondition?: string | null
  appliesTo: string[]        // ["refactor","typescript","interface-change"]
  rootCause?: RootCauseCode | null
  confidence: number         // tăng mỗi lần validate đúng
  timesApplied: number
  timesValidated: number     // áp dụng và đúng
  timesFailed: number        // áp dụng mà vẫn fail → giảm confidence
  createdAt: Date
  source: 'SELF_DERIVED' | 'USER_TAUGHT' | 'SUBAGENT_REPORT'
  needsReview?: boolean      // confidence < 0.4 → user xem lại
  embeddingId?: string | null
}

/** Strategy — cách tiếp cận đã thử cho một loại vấn đề (Neo4j :Strategy) */
export interface StrategyNode {
  id: string                 // "strat_<rand>"
  problemType: string        // "debug_type_error"
  approach: string
  successRate: number
  avgSteps: number
  lastUsed: Date
}

// ==================== NGƯỠNG VẬN HÀNH (C.2) ====================

export const EPISODIC_THRESHOLDS = {
  /** Lesson auto-apply: confidence ≥ 0.7 — tin đủ để dùng không hỏi */
  lessonAutoApply: 0.7,
  /** Lesson cần review: confidence < 0.4 → danh sách user xem */
  lessonNeedsReview: 0.4,
  /** Episode similarity link: cosine ≥ 0.8 → nối [:SIMILAR_TO] */
  episodeSimilarity: 0.8,
  /** Lesson merge khi sinh trùng: embedding similarity > 0.85 */
  lessonMergeSimilarity: 0.85,
  /** Pattern escalation: ≥ 3 lần cùng root_cause → lỗi hệ thống */
  patternEscalation: 3,
  /** Episode decay: ×0.9 mỗi 30 ngày không đụng */
  episodeDecayFactor: 0.9,
  episodeDecayDays: 30,
  /** Lesson KHÔNG BAO GIỜ decay — bài học là vĩnh viễn */
  lessonNeverDecays: true,
  /** Lesson khởi đầu khi tự sinh từ ErrorOccurrence đã resolve */
  lessonInitialConfidence: 0.6,
  /** Bước confidence khi validate thành công / thất bại */
  lessonValidateBoost: 0.05,
  lessonValidatePenalty: 0.1,
} as const

// ==================== PRE-ACT / CONSOLIDATE SHAPES ====================

/** Kết quả PRE-ACT retrieval (nhịp 1 — C.1) — inject vào system prompt */
export interface PreActContext {
  /** Block text hoàn chỉnh để append vào system prompt ('' nếu không có gì) */
  promptBlock: string
  lessons: Array<Pick<LessonNode, 'id' | 'statement' | 'triggerCondition' | 'confidence'>>
  similarErrors: Array<{
    rawMessage: string
    fixSummary?: string | null
    lessonStatement?: string | null
    lessonConfidence?: number | null
  }>
  unresolvedWarnings: string[]
  /** Lesson ids đã inject → goal-loop dùng để VALIDATE sau run (EVALUATE) */
  appliedLessonIds: string[]
}

/** Input cho recorder pipeline A.5 — mọi field goal-loop đã có sẵn trong scope */
export interface RecordEpisodeInput {
  agentName: string
  goal: string               // userMessage
  sessionId?: string | null
  outcome: EpisodeOutcome
  confidence: number         // evaluator confidence
  stopReason: string
  cycles: number
  tokensUsed: number
  toolCalls: number
  startedAt: Date
  endedAt: Date
  /** Evidence từ goal-loop: [{cycle, kind:'tool', tool, success, text}] */
  toolEvidence: Array<{
    cycle: number
    tool: string
    success: boolean
    text: string
  }>
  /** Lesson ids PRE-ACT đã áp dụng cho run này (để validate) */
  appliedLessonIds: string[]
}

/** Kết quả pipeline A.5 */
export interface RecordEpisodeResult {
  episodeId: string
  lessonsCreated: number
  lessonsMerged: number
  lessonsValidated: number
  lessonsFailed: number
  similarEpisodesLinked: number
  errorsRecorded: number
  error?: string
}
