/**
 * Layer 7: Orchestration System — Public API
 *
 * ROUND-37 V4: tool-selector đã XÓA — dead scaffolding (0 caller ngoài
 * barrel). Đường SỐNG: session-resume (workflow/resume + workflow-engine,
 * import trực tiếp), agent-delegator (delegate tool — flag ENABLE_REAL_DELEGATE),
 * master-orchestrator (flag ENABLE_MASTER_ORCHESTRATOR, ROUND-39 mặc định
 * BẬT — vòng lặp wire THẬT end-to-end từ round-38 fix F2: decision
 * 'after_error' → detect pattern → applyAdaptation → pendingConfig render vào
 * prompt step kế + giảm maxIterations; kill-switch: .env
 * ENABLE_MASTER_ORCHESTRATOR=false).
 *
 * ROUND-40 (soát V2-SCOPE — ghi chú trung thực): flag BẬT có 2 tác động sống:
 * (1) decompose_task chạy full thinking layer (decomposer.ts — parseIntent +
 * mentalModel + DAG persist — consumer thật trong dev-tools); (2) các state
 * 'skipped' của orchestrator giờ là đường chạy được. NHƯNG startOrchestration()
 * hiện CHƯA có production caller — vòng lặp orchestrator đầy đủ (retry sau
 * error + adaptation) vẫn là scaffolding chờ caller (nợ vận hành đã ghi
 * worklog round-40). Đừng đọc "flag bật" = "orchestrator loop đang chạy".
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
