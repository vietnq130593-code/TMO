/**
 * Layer 7: Orchestration System — Types
 *
 * Định nghĩa tất cả TypeScript interfaces cho Layer 7: Điều Phối.
 * Orchestration là "đại tướng" — điều phối tất cả các layer khác.
 *
 * 3 quy trình chính:
 *   1. Master Orchestration (7.1) — Main loop controller
 *   2. Tool Selection (7.2) — Decision matrix
 *   3. Agent Delegation (7.3) — Sub-agent dispatch
 */

import type { AgentPosition, PipelineStep } from '@/lib/code-team/types'
import type { ErrorRecord } from '@/lib/error-handling'
import type { ProgressState, ContextState } from '@/lib/state-management'
import type { RoutingDecision } from '@/lib/code-team/worklog'
import type { LearningState, LearningConfig } from '@/lib/learning'

// ==================== SHARED ORCHESTRATION TYPES ====================

/** Chế độ điều phối */
export type OrchestrationMode = 'sequential' | 'parallel' | 'hybrid' | 'adaptive'

/** Chiến lược delegation */
export type DelegationStrategy = 'none' | 'single_agent' | 'multi_agent' | 'smolab'

/** Phân loại tool */
export type ToolCategory = 'read' | 'write' | 'search' | 'execute' | 'browser' | 'image' | 'knowledge' | 'skill'

// ==================== MASTER ORCHESTRATION (7.1) ====================

/** Các phase trong vòng lặp chính */
export type OrchestrationPhase =
  | 'receive'        // Nhận yêu cầu
  | 'understand'     // Phân tích intent, đọc codebase
  | 'plan'           // Phân rã, lập kế hoạch
  | 'execute'        // Đang thực thi steps
  | 'verify'         // Kiểm tra toàn bộ
  | 'report'         // Báo cáo kết quả
  | 'error_recovery' // Đang xử lý lỗi
  | 'escalated'      // Đã escalate lên user
  | 'completed'      // Hoàn thành
  | 'aborted'        // Đã hủy

/** Decision point trong vòng lặp */
export interface OrchestrationDecision {
  timestamp: string
  point: 'after_step' | 'after_error' | 'after_verify' | 'context_overflow' | 'learning_feedback'
  decision: 'continue' | 'reverify' | 'replan' | 'rollback' | 'escalate' | 'ask_user' | 'adapt_strategy'
  reasoning: string
  context: Record<string, unknown>
}

/** Cấu hình cho orchestrator */
export interface OrchestrationConfig {
  mode: OrchestrationMode
  maxRetries: number
  maxParallelAgents: number
  autoEscalateAfterFailures: number
  checkpointFrequency: 'every_step' | 'every_phase' | 'on_error'
  toolSelectionStrategy: 'strict' | 'flexible' | 'hybrid'
  delegationStrategy: DelegationStrategy
  learning: LearningConfig
}

/** Trạng thái của vòng lặp chính */
export interface OrchestrationState {
  phase: OrchestrationPhase
  currentStepIndex: number
  pipeline: PipelineStep[]
  routingDecision: RoutingDecision
  progress: ProgressState
  context: ContextState
  errors: ErrorRecord[]
  decisions: OrchestrationDecision[]
  learning: LearningState
  startedAt: string
  lastUpdatedAt: string
}

/** Request khởi động orchestrator */
export interface OrchestrationRequest {
  sessionId: string
  userRequest: string
  messages: Array<{ role: string; content: string }>
  routing?: RoutingDecision
  config?: Partial<OrchestrationConfig>
}

/** Kết quả từ orchestrator
 *
 *  v2.1 Phase 5.1 — added 'skipped' status: returned by startOrchestration when
 *  ENABLE_MASTER_ORCHESTRATOR is false. Callers can short-circuit without running
 *  any pipeline steps (preserves the legacy placeholder behavior).
 */
export interface OrchestrationResult {
  status: 'completed' | 'failed' | 'escalated' | 'aborted' | 'skipped'
  totalDuration: number
  stepsCompleted: number
  stepsTotal: number
  errors: ErrorRecord[]
  summary: string
}

/** Điểm quyết định */
export interface DecisionPoint {
  type: 'after_step' | 'after_error' | 'after_verify' | 'context_overflow'
  stepIndex: number
  stepResult?: unknown
  error?: ErrorRecord
}

/** Context cho quyết định */
export interface DecisionContext {
  state: OrchestrationState
  pipeline: PipelineStep[]
  currentStepIndex: number
}

/** Interface cho Master Orchestrator */
export interface MasterOrchestrator {
  getState(): OrchestrationState
  start(request: OrchestrationRequest): Promise<OrchestrationResult>
  pause(): void
  resume(): Promise<void>
  abort(): void
  getDecision(point: DecisionPoint, context: DecisionContext): OrchestrationDecision
}

// ==================== TOOL SELECTION (7.2) ====================

/** Tool selection request */
export interface ToolSelectionRequest {
  taskType: string
  need: string
  availableTools: string[]
  context: {
    fileExists?: boolean
    isNewFile?: boolean
    isComplex?: boolean
    needsBrowser?: boolean
    needsSearch?: boolean
  }
}

/** Tool selection result */
export interface ToolSelectionResult {
  selectedTool: string
  confidence: number
  reasoning: string
  alternatives: string[]
  warnings: string[]
}

/** Tool capability mapping */
export interface ToolCapability {
  name: string
  category: ToolCategory
  description: string
  bestFor: string[]
  notFor: string[]
  cost: 'cheap' | 'medium' | 'expensive'
}

/** Interface cho Tool Selector */
export interface ToolSelector {
  selectTool(request: ToolSelectionRequest): ToolSelectionResult
  getToolCapabilities(): ToolCapability[]
  getToolMatrix(): Map<string, ToolCapability>
  validateToolChoice(tool: string, task: string): boolean
}

// ==================== AGENT DELEGATION (7.3) ====================

/** Sub-agent task definition */
export interface DelegatedTask {
  id: string
  parentSessionId: string
  assignedAgent: AgentPosition
  taskType: string
  description: string
  input: string
  expectedOutput: string
  context: string
  timeout: number
  priority: number
}

/** Sub-agent execution result */
export interface DelegatedTaskResult {
  taskId: string
  agentPosition: AgentPosition
  success: boolean
  output: string
  duration: number
  tokensUsed: number
  errors: ErrorRecord[]
  filesCreated: string[]
  filesModified: string[]
}

/** Delegation decision */
export interface DelegationDecision {
  shouldDelegate: boolean
  strategy: DelegationStrategy
  tasks: DelegatedTask[]
  reasoning: string
  estimatedTimeSaved: number
  risks: string[]
}

/** Interface cho Agent Delegator */
export interface AgentDelegator {
  shouldDelegate(task: DelegationRequest): DelegationDecision
  delegate(task: DelegatedTask): Promise<DelegatedTaskResult>
  delegateParallel(tasks: DelegatedTask[]): Promise<DelegatedTaskResult[]>
  collectResults(results: DelegatedTaskResult[]): string
  cancelDelegation(taskId: string): void
}

/** Request delegation */
export interface DelegationRequest {
  complexity: 'simple' | 'medium' | 'complex'
  canParallelize: boolean
  requiresSpecialization: boolean
  estimatedDuration: number
  availableAgents: AgentPosition[]
  currentContext: string
}