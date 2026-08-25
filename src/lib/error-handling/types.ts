/**
 * Layer 5: Error Handling — Type Definitions
 *
 * Định nghĩa tất cả TypeScript interfaces cho hệ thống xử lý lỗi.
 * Dựa trên docs/fullstack-agent-architecture-v2.md — Layer 5.
 */

// ==================== ENUMS ====================

/** Loại lỗi có thể xảy ra trong quá trình thực thi */
export type ErrorType =
  | 'compile'      // Syntax error, missing import
  | 'type'         // TypeScript type mismatch
  | 'lint'         // ESLint warning/error
  | 'runtime'      // Cannot read property of undefined, etc.
  | 'logic'        // Wrong calculation, wrong condition
  | 'hydration'    // Server/client mismatch
  | 'api'          // 404, 500, timeout
  | 'network'      // CORS, connection refused
  | 'unknown'      // Không thể phân loại
  // ━━━ Layer 9 P1.2 (2026-08-25) — fine-grained workflow error taxonomy ━━━
  // Phân biệt transient (tự hồi — retry là đúng) vs systematic (cần đổi
  // approach). Cho detectFailurePattern đếm repeated_error CHÍNH XÁC: 2 lỗi
  // network khác nguyên nhân không còn bị gộp chung 'runtime'.
  | 'transient_network'      // timeout / econnreset / fetch failed — retry-able
  | 'transient_ratelimit'   // 429 / rate limit / quota — retry sau cooldown
  | 'transient_server'      // 5xx / service unavailable — retry-able
  | 'systematic_tool_rejected' // tool từ chối/không tồn tại — đổi approach
  | 'systematic_parse'      // JSON/syntax/format — đổi prompt hoặc parser
  | 'systematic_permission' // 401/403/denied — đổi config
  | 'systematic_notfound'   // file/resource không tồn tại — đổi path/logic

/** Mức độ nghiêm trọng của lỗi */
export type ErrorSeverity = 'critical' | 'high' | 'medium' | 'low'

/** Chiến lược sửa lỗi */
export type FixStrategy = 'surgical' | 'refactoring' | 'redesign' | 'rollback'

/** Hành động cuối cùng sau khi xử lý lỗi */
export type ErrorAction = 'FIXED' | 'RETRY' | 'PIVOT' | 'ESCALATE' | 'CONTINUE'

// ==================== ERROR CLASSIFICATION ====================

/** Kết quả phân loại lỗi từ Error Detector */
export interface ErrorClassification {
  /** Loại lỗi */
  errorType: ErrorType
  /** Mức độ nghiêm trọng */
  severity: ErrorSeverity
  /** Message gốc của lỗi */
  message: string
  /** File chứa lỗi (nếu trích xuất được) */
  file?: string
  /** Dòng chứa lỗi (nếu trích xuất được) */
  line?: number
  /** Cột chứa lỗi (nếu trích xuất được) */
  column?: number
  /** Stack trace (nếu có) */
  stack?: string
  /** Thời gian phát hiện */
  timestamp: Date
}

// ==================== ROOT CAUSE ANALYSIS ====================

/** Kết quả phân tích nguyên nhân gốc */
export interface RootCauseAnalysis {
  /** Giả thuyết ban đầu */
  hypothesis: string
  /** Quá trình verify giả thuyết */
  verification: string
  /** Nguyên nhân gốc xác định */
  rootCause: string
  /** Độ tin cậy (0-1) */
  confidence: number
  /** Các file liên quan */
  relatedFiles: string[]
  /** Thời gian phân tích */
  duration: number
}

// ==================== ERROR RECOVERY ====================

/** Kết quả sửa lỗi */
export interface ErrorRecoveryResult {
  /** Chiến lược đã chọn */
  strategy: FixStrategy
  /** Mô tả fix đã apply */
  fixDescription: string
  /** Kết quả re-verification */
  reVerification: {
    /** Có pass không */
    passed: boolean
    /** Chi tiết */
    details: string
  }
  /** Có thành công không */
  success: boolean
  /** Lý do nếu thất bại */
  failureReason?: string
}

// ==================== LOOP DETECTION ====================

/** Kết quả phát hiện fix loop */
export interface LoopDetectionResult {
  /** Có phải loop không */
  isLoop: boolean
  /** Số lần cùng lỗi xuất hiện */
  loopCount: number
  /** Các lần thử trước đó */
  previousAttempts: {
    timestamp: Date
    fixStrategy: FixStrategy
    fixDescription: string
    result: 'success' | 'failure'
  }[]
  /** Chiến lược pivot đề xuất */
  pivotStrategy?: FixStrategy
  /** Có nên escalate không */
  shouldEscalate: boolean
  /** Lý do escalate */
  escalateReason?: string
}

// ==================== ERROR RECORD ====================

/** Record lỗi để persist trong worklog */
export interface ErrorRecord {
  /** ID duy nhất */
  id: string
  /** Thời gian xảy ra */
  timestamp: Date
  /** Loại lỗi */
  errorType: ErrorType
  /** Mức độ nghiêm trọng */
  severity: ErrorSeverity
  /** Message lỗi */
  message: string
  /** File chứa lỗi (nếu trích xuất được) */
  file?: string
  /** Dòng chứa lỗi (nếu trích xuất được) */
  line?: number
  /** Nguyên nhân gốc (nếu đã phân tích) */
  rootCause?: string
  /** Chiến lược sửa (nếu đã thử) */
  fixStrategy?: FixStrategy
  /** Có sửa thành công không */
  fixApplied: boolean
  /** Mô tả fix */
  fixDescription?: string
  /** Có phát hiện loop không */
  loopDetected: boolean
  /** Số lần lặp lại */
  loopCount: number
}

// ==================== ERROR CONTEXT ====================

/** Context xung quanh lỗi */
export interface ErrorContext {
  /** Vị trí agent bị lỗi */
  agentPosition: string
  /** Loại step bị lỗi */
  step: string
  /** Files vừa bị thay đổi */
  filesModified: string[]
  /** Log các tool calls gần nhất */
  toolCallsLog: ToolCallLog[]
  /** Kết quả verification nếu có */
  verificationReport?: VerificationReport
}

/** Log của một tool call */
export interface ToolCallLog {
  tool: string
  args: Record<string, unknown>
  result: string
  duration: number
  success: boolean
}

// ==================== VERIFICATION (reused from Layer 4) ====================

/** Re-export từ Layer 4 để tránh circular dependency */
export interface VerificationReport {
  sessionId: string
  stepId: string
  overallPassed: boolean
  totalDuration: number
  verifiers: VerificationResult[]
  summary: string
  timestamp: Date
}

export interface VerificationResult {
  type: string
  passed: boolean
  errors: string[]
  warnings: string[]
  duration: number
  summary: string
}

// ==================== ERROR HANDLING INPUT/OUTPUT ====================

/** Input cho error handling pipeline */
export interface ErrorHandlingInput {
  /** ID của workflow session */
  sessionId: string
  /** ID của bước bị lỗi */
  stepId: string
  /** Raw error từ agent step */
  error: Error | string
  /** Context xung quanh lỗi */
  context: ErrorContext
  /** Lịch sử lỗi của session (cho loop detection) */
  previousErrors: ErrorRecord[]
  /** Toàn bộ worklog để trace nguyên nhân */
  worklog: WorklogEntry[]
  /** Options */
  options?: ErrorHandlingOptions
}

/** Options cho error handling */
export interface ErrorHandlingOptions {
  /** Số lần retry tối đa trước khi escalate */
  maxRetries?: number
  /** Tự động apply fix hay chỉ analyze */
  autoFix?: boolean
  /** Tự động escalate khi phát hiện loop */
  escalateOnLoop?: boolean
}

/** Worklog entry (simplified, từ worklog.ts) */
export interface WorklogEntry {
  sessionId: string
  agentName: string
  position: string
  step: string
  timestamp: Date
  summary: string
  completed: string[]
  inProgress: string[]
  issues: WorklogIssue[]
  suggestions: string[]
  concerns: string[]
  codeLocationMap: CodeLocationMap
  nextSteps: string[]
  outputForNext: string
  errorRecords?: ErrorRecord[]
}

/** Worklog issue (simplified, từ worklog.ts) */
export interface WorklogIssue {
  severity: 'critical' | 'high' | 'medium' | 'low'
  type: string
  description: string
  location?: string
  fixApplied?: boolean
  fixDescription?: string
}

/** Code location map (simplified, từ worklog.ts) */
export interface CodeLocationMap {
  filesToRead: Array<{
    path: string
    priority: 'critical' | 'high' | 'medium' | 'low'
    reason: string
    lines?: string
  }>
  filesToSkip: Array<{ path: string; reason: string }>
  dependencies: Array<{ from: string; to: string; type: string }>
  readingStrategy: string
}

// ==================== ERROR HANDLING REPORT ====================

/** Báo cáo tổng hợp sau khi xử lý lỗi */
export interface ErrorHandlingReport {
  /** ID của session */
  sessionId: string
  /** ID của bước bị lỗi */
  stepId: string
  /** Kết quả phân loại lỗi */
  detected: ErrorClassification
  /** Kết quả phân tích nguyên nhân gốc */
  rootCause: RootCauseAnalysis
  /** Kết quả sửa lỗi */
  recovery: ErrorRecoveryResult
  /** Kết quả phát hiện loop */
  loopStatus: LoopDetectionResult
  /** Hành động cuối cùng */
  finalAction: ErrorAction
  /** Tóm tắt */
  summary: string
  /** Thời gian xử lý */
  timestamp: Date
  /** Thời gian xử lý (ms) */
  duration: number
}