/**
 * Layer 8: Communication System — Types
 *
 * Định nghĩa tất cả TypeScript interfaces cho:
 *   - Progress Reporting (8.1)
 *   - Clarification Protocol (8.2)
 *
 * Các types này được sử dụng bởi:
 *   - progress-reporter.ts (format báo cáo tiến độ)
 *   - (clarification-engine.ts đã XOÁ round-37 V4 — 0 caller phía hỏi)
 *   - workflow-engine.ts (tích hợp SSE events)
 */

import type { ErrorRecord } from '@/lib/error-handling'
import type { StepState } from '@/lib/state-management/types'
import type { StepStatus } from '@/lib/code-team/types'
import type { IntentResult } from '@/lib/intake'
import type { SolutionDesign } from '@/lib/thinking'

// ==================== CONFIGURATION ====================

/** Định dạng báo cáo */
export type ReportFormat = 'minimal' | 'normal' | 'verbose'

/** Ngôn ngữ báo cáo */
export type ReportLanguage = 'en' | 'vi'

/** Cấu hình cho toàn bộ Layer 8 */
export interface CommunicationConfig {
  language: ReportLanguage
  verbosity: ReportFormat
  emoji: boolean
  maxQuestionsPerSession: number
}

// ==================== PROGRESS REPORTER (8.1) ====================

/** Input cho báo cáo tiến độ từng bước */
export interface StepProgressInput {
  stepId: string
  stepName: string
  status: StepStatus
  progress: number
  message: string
  details?: Record<string, unknown>
}

/** Interface chính của Progress Reporter */
export interface ProgressReporter {
  /** Định dạng báo cáo cho một step */
  formatStepReport(step: StepState, stepIndex: number, totalSteps: number): string

  /** Định dạng báo cáo tổng kết cuối workflow */
  formatFinalReport(progress: ProgressReportInput): string

  /** Định dạng báo cáo lỗi */
  formatErrorReport(error: ErrorRecord, stepContext: string): string

  /** Kiểm tra xem nên báo cáo step này không (tránh spam) */
  shouldReport(step: StepState): boolean

  /** Lấy lịch sử báo cáo */
  getHistory(): string[]

  /** Cập nhật timestamp báo cáo cuối cho một step */
  recordReportTimestamp(stepId: string): void

  /** Tạo báo cáo tiến độ từng bước (cho SSE events) */
  generateReport(input: StepProgressInput): { formattedReport: string; stepIndex: number; totalSteps: number; status: StepStatus } | null
}

/** Input cho báo cáo tổng kết */
export interface ProgressReportInput {
  planId: string
  totalSteps: number
  completedSteps: number
  failedSteps: number
  steps: Record<string, StepState>
  totalTokensUsed: number
  totalTokensBudgeted: number
  totalTimeSpent: number
  startedAt: string
  lastUpdatedAt: string
  errors: ErrorRecord[]
}

/** Thống kê worklog cho báo cáo */
export interface WorklogStats {
  totalEntries: number
  totalIssues: number
  criticalIssues: number
  highIssues: number
  fixedIssues: number
  agentsCompleted: string[]
  lastUpdate: Date | null
}

// ==================== CLARIFICATION ENGINE (8.2) ====================

/** Loại gap cần clarification */
export type clarificationGapType =
  | 'conflicting'
  | 'missing_info'
  | 'multiple_approaches'
  | 'ambiguous'

/** Một gap cần làm rõ */
export interface ClarificationGap {
  type: clarificationGapType
  description: string
  options?: string[]
  defaultOption?: string
  field?: string
}

/** Kết quả phát hiện cần clarification */
export interface ClarificationDecision {
  needsClarification: boolean
  gaps: ClarificationGap[]
  confidence: number
}

/** Yêu cầu clarification từ user */
export interface ClarificationRequest {
  id: string
  gap: ClarificationGap
  formattedQuestion: string
  options: string[]
  defaultOption: string
  timestamp: string
}

/** Phản hồi từ user cho một clarification */
export interface ClarificationResponse {
  requestId: string
  selectedOption: string
  updatedContext: string
  isFollowUp: boolean
}

/** Context để kiểm tra cần clarification */
export interface ClarificationContext {
  intentResult: IntentResult
  solutionDesign?: SolutionDesign
  codebaseConventions: string[]
  askedQuestions: string[]
  questionCount: number
}

/** Interface chính của Clarification Engine */
export interface ClarificationEngine {
  /** Kiểm tra xem có cần clarification không */
  needsClarification(context: ClarificationContext): ClarificationDecision

  /** Định dạng câu hỏi từ gap */
  formatQuestion(gap: ClarificationGap): ClarificationRequest

  /** Validate câu trả lời từ user */
  validateAnswer(request: ClarificationRequest, answer: string): ClarificationResponse

  /** Kiểm tra xem nên suppress câu hỏi không */
  shouldSuppressQuestion(gap: ClarificationGap, context: ClarificationContext): boolean

  /** Lấy trạng thái hiện tại */
  getState(): CommunicationState

  /** Xử lý khi clarification được resolve */
  resolveClarification(request: ClarificationRequest, response: ClarificationResponse): {
    resolved: boolean
    followUpNeeded: boolean
    followUpQuestion?: ClarificationRequest
    updatedContext: string
  }
}

// ==================== COMMUNICATION STATE ====================

/** Trạng thái giao tiếp — theo dõi clarifications và báo cáo */
export interface CommunicationState {
  pendingClarifications: ClarificationRequest[]
  reportHistory: string[]
  questionCount: number
  lastReportTimestamp: Record<string, string>
}

// ==================== SSE EVENT EXTENSIONS ====================

/** Event type mở rộng cho workflow SSE */
export type ExtendedWorkflowEventType =
  | 'workflow_start'
  | 'agent_start'
  | 'agent_chunk'
  | 'agent_complete'
  | 'tool_call'
  | 'tool_result'
  | 'PIP'
  | 'iteration'
  | 'workflow_done'
  | 'error'
  | 'verification_report'
  | 'clarification_needed'
  | 'clarification_resolved'
  | 'clarification_timeout'
  | 'progress_report'
  | 'final_report'

/** Payload cho event clarification_needed */
export interface ClarificationNeededPayload {
  request: ClarificationRequest
  pauseReason: string
}

/** Payload cho event clarification_resolved */
export interface ClarificationResolvedPayload {
  requestId: string
  selectedOption: string
  updatedContext: string
}

/** Payload cho event clarification_timeout */
export interface ClarificationTimeoutPayload {
  requestId: string
  reason: string
}

/** Payload cho event progress_report */
export interface ProgressReportPayload {
  formattedReport: string
  stepIndex: number
  totalSteps: number
  status: StepStatus
}

/** Payload cho event final_report */
export interface FinalReportPayload {
  formattedReport: string
  totalSteps: number
  completedSteps: number
  failedSteps: number
  totalTokensUsed: number
  totalTimeSpent: number
}

// ==================== WORKFLOW PAUSE/RESUME ====================

/** Trạng thái workflow bị pause để chờ clarification */
export interface PausedWorkflowState {
  sessionId: string
  routingDecision: unknown // RoutingDecision — avoid circular import
  userRequest: string
  intentResult: unknown // IntentResult
  assembledContext: unknown // AssembledContext
  thinkingContext?: unknown // WorkflowThinkingContext
  clarificationRequest: ClarificationRequest
  pausedAt: number
}

/** Context để resume workflow */
export interface WorkflowResumeContext {
  sessionId: string
  clarificationResponse: ClarificationResponse
  emit: (event: Record<string, unknown>) => void
  abortSignal?: AbortSignal
}