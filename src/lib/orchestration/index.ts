/**
 * Layer 7: Orchestration System — Public API
 *
 * ROUND-37 V4: tool-selector đã XÓA — dead scaffolding (0 caller ngoài
 * barrel). Đường SỐNG: session-resume (workflow/resume + workflow-engine,
 * import trực tiếp), agent-delegator (delegate tool — flag ENABLE_REAL_DELEGATE),
 * master-orchestrator (flag ENABLE_MASTER_ORCHESTRATOR, mặc định TẮT — vòng
 * lặp giờ wire THẬT end-to-end: decision 'after_error' → detect pattern →
 * applyAdaptation → pendingConfig render vào prompt step kế + giảm maxIterations
 * [ROUND-38 fix F2]; bật flag để dùng).
 */

// ==================== FACTORY FUNCTIONS ====================

export { createMasterOrchestrator } from './master-orchestrator'
export { createAgentDelegator } from './agent-delegator'

// ==================== TYPES ====================

export type {
  // Master Orchestration (7.1)
  OrchestrationState,
  OrchestrationPhase,
  OrchestrationDecision,
  OrchestrationConfig,
  MasterOrchestrator,
  OrchestrationRequest,
  OrchestrationResult,
  DecisionPoint,
  DecisionContext,

  // Agent Delegation (7.3)
  DelegatedTask,
  DelegatedTaskResult,
  DelegationDecision,
  DelegationRequest,
  AgentDelegator,
} from './types'

// Re-export shared types from orchestration types (single source of truth)
export type {
  OrchestrationMode,
  DelegationStrategy,
  ToolCategory,
} from './types'
