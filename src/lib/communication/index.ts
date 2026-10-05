/**
 * Layer 8: Communication System — Public API
 *
 * ROUND-37 V4: clarification-engine đã XÓA — dead scaffolding (0 caller sản
 * xuất; clarify flow chỉ tiêu thụ ClarificationResponse type ở phía trả lời).
 * progress-reporter GIỜ SỐNG: workflow-engine emit SSE `progress_report` +
 * `final_report` qua formatStepReport/formatFinalReport.
 */

// ==================== TYPES ====================

export type {
  // Configuration
  CommunicationConfig,
  ReportFormat,
  ReportLanguage,

  // Progress Reporter (LIVE — workflow-engine V4)
  ProgressReporter,
  ProgressReportInput,
  StepProgressInput,
  WorklogStats,

  // Clarification shapes (type-only — clarify route + resumeWorkflow)
  ClarificationGap,
  clarificationGapType,
  ClarificationDecision,
  ClarificationRequest,
  ClarificationResponse,
  ClarificationContext,

  // Communication State
  CommunicationState,

  // SSE Events
  ExtendedWorkflowEventType,
  ClarificationNeededPayload,
  ClarificationResolvedPayload,
  ClarificationTimeoutPayload,
  ProgressReportPayload,
  FinalReportPayload,

  // Workflow Pause/Resume
  PausedWorkflowState,
  WorkflowResumeContext,
} from './types'

// ==================== FACTORIES ====================

export { createProgressReporter } from './progress-reporter'