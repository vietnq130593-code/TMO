/**
 * Layer 9: Learning & Adaptation — Types
 *
 * Định nghĩa tất cả TypeScript interfaces cho:
 *   - Historical Feedback (9.1)
 *   - Strategy Adaptation (9.2)
 *
 * Các types này được sử dụng bởi:
 *   - metrics-collector.ts (thu thập metrics real-time)
 *   - historical-feedback.ts (phân tích lịch sử, điều chỉnh tham số)
 *   - strategy-adapter.ts (phát hiện pattern, đề xuất chiến lược)
 *   - master-orchestrator.ts (tích hợp vào execution loop)
 */

import type { ErrorClassification, ErrorRecord } from '@/lib/error-handling'

// ==================== EXECUTION METRICS ====================

/** Metrics tổng hợp từ một workflow run */
export interface ExecutionMetrics {
  id: string
  sessionId: string
  planId: string
  routingMode: string // 'A' | 'B' | 'C'
  tier: number // 1 | 2 | 3
  totalSteps: number
  completedSteps: number
  failedSteps: number
  totalTokensUsed: number
  totalTokensBudgeted: number
  totalTimeSpent: number // milliseconds
  errorsByType: Record<string, number> // e.g. { "type_error": 5, "runtime_error": 2 }
  stepSuccessRate: number // 0.0 - 1.0
  tokenEfficiency: number // actual / budgeted (≤1.0 = good, >1.0 = over)
  createdAt: string // ISO string
}

/** Metrics tổng hợp từ nhiều workflow runs */
export interface AggregatedMetrics {
  byTaskType: Record<
    string,
    {
      avgTokensUsed: number
      avgTokensBudgeted: number
      avgTimeSpent: number
      successRate: number
      sampleSize: number
      /** P2-M2 — Wilson 95% CI cho successRate (n = sampleSize, z=1.96).
       * Consumer quyết định CHỈ tin khi n ≥ 5 ∧ (high−low) ≤ 0.5 — xem
       * isTrustworthySuccessCI (historical-feedback.ts). NaN khi nhóm rỗng. */
      successCI: { low: number; high: number }
    }
  >
  byRoutingMode: Record<
    string,
    {
      avgTokensUsed: number
      avgTokensBudgeted: number
      avgTimeSpent: number
      successRate: number
      sampleSize: number
      /** P2-M2 — Wilson 95% CI cho successRate (n = sampleSize) */
      successCI: { low: number; high: number }
    }
  >
  byErrorType: Record<string, number> // global error frequency
  overallSuccessRate: number
  /** P2-M2 — Wilson 95% CI cho overallSuccessRate (n = totalRuns — đơn vị
   * quan sát là RUN, nhất quán với sampleSize của nhóm theo blueprint §P2-M2). */
  overallSuccessCI: { low: number; high: number }
  totalRuns: number
}

// ==================== FAILURE PATTERN ====================

/** Loại pattern thất bại */
export type FailurePatternType =
  | 'repeated_error'
  | 'approach_exhausted'
  | 'resource_limit'
  | 'timeout'
  // Red Team Engine Phase 4 (2026-08-25): adversarial self-testing breach —
  // failure mode được xác nhận bởi cặp judge đối đầu (không phải lỗi thật
  // gặp user). Nguồn: src/lib/redteam/runner.ts persistRedTeamBreachPattern.
  | 'redteam_breach'

/** Pattern thất bại được phát hiện */
export interface FailurePattern {
  id: string
  type: FailurePatternType
  count: number
  lastOccurrence: string // ISO string
  strategiesTried: string[] // e.g. ["surgical", "refactoring"]
  nextStrategy: string // suggested next strategy
  context: {
    // what was happening when failures occurred
    taskType: string
    routingMode: string
    stepType: string
    // ROUND-38 fix F3 — caller (workflow-engine detectAndPersistFailurePattern)
    // đính kèm thêm errorType từ classifyWorkflowError để rule phân hoá
    // chiến lược preStep (read_api_docs vs check_dev_log vs read_lint_rules).
    errorType?: string
    // session đã ghi pattern (persistFailurePattern upsert theo cặp này)
    sessionId?: string
  }
}

// ==================== STRATEGY ADAPTATION ====================

/** Chiến lược thích ứng */
export type AdaptationStrategy =
  | 'read_lint_rules_first' // Đọc kỹ lint rules trước khi sửa
  | 'read_api_docs' // Đọc API docs thay vì guess
  | 'check_dev_log' // Kiểm tra dev.log thay vì chỉ đọc error
  | 'change_fix_approach' // Đổi surgical → refactoring → redesign
  | 'compress_context' // Compress/summarize thay vì đọc thêm
  | 'reduce_scope' // Giảm scope khi token/time vượt budget
  | 'escalate_to_user' // Hỏi user khi đã thử ≥3 cách
  // Red Team Phase 4 (2026-08-25): siết ngưỡng từ chối tạm 24h khi 1 attack
  // vector breach >= 2 lần — defense in depth chờ human review disputed queue
  | 'tighten_refusal_threshold'

/** Rule để quyết định khi nào áp dụng strategy nào */
export interface AdaptationRule {
  condition: (pattern: FailurePattern, metrics: AggregatedMetrics | null) => boolean
  strategy: AdaptationStrategy
  priority: number
}

/** Quyết định thích ứng */
export interface AdaptationDecision {
  shouldAdapt: boolean
  currentStrategy: string
  recommendedStrategy: AdaptationStrategy
  reason: string
  confidence: number // 0.0 - 1.0, dựa trên historical data
}

// ==================== LEARNING STATE ====================

/** Trạng thái học tập trong một orchestration run */
export interface LearningState {
  metrics: ExecutionMetrics | null // metrics của run hiện tại (in-progress)
  historicalMetrics: AggregatedMetrics | null // tổng hợp từ tất cả run trước
  currentPattern: FailurePattern | null // pattern đang active trong run hiện tại
  lastAdaptation: string | null // ISO timestamp lần adapt cuối
  adaptationCount: number // số lần đã adapt trong run này
  isEnabled: boolean // shortcut check — mirror của config.learning.enabled
  /** ROUND-37 V2a — config thật từ applyAdaptation chờ step kế tiêu thụ */
  pendingConfig?: Record<string, unknown>
  /** ROUND-37 V2a — chiến lược sinh ra pendingConfig */
  pendingStrategy?: string
}

/** Cấu hình cho learning module */
export interface LearningConfig {
  enabled: boolean
  minRunsForFeedback: number // cần ít nhất N runs để feedback có ý nghĩa (default: 5)
  maxHistoricalRuns: number // tối đa số lần lưu historical runs (default: 100)
  adaptationThreshold: number // ngưỡng để trigger adaptation (default: 0.3)
  autoApplyStrategies: boolean // tự động áp dụng strategy adaptation (default: true)
}

// ==================== METRICS COLLECTOR ====================

/** Interface cho MetricsCollector */
export interface MetricsCollector {
  recordStepStart(stepId: string, stepType: string, agentPosition: string): void
  recordStepComplete(
    stepId: string,
    result: { success: boolean; filesCreated: string[]; filesModified: string[]; summary: string; outputForNext: string },
    tokensUsed: number,
    timeSpent: number
  ): void
  recordStepError(stepId: string, error: ErrorRecord): void
  recordTokenUsage(tokens: number): void
  getCurrentMetrics(): ExecutionMetrics
  flush(): Promise<ExecutionMetrics>
}

// ==================== STRATEGY ADAPTATION LOG ====================

/** Log mỗi lần system tự động đổi strategy */
export interface StrategyAdaptationLog {
  id: string
  sessionId: string
  patternId: string | null
  fromStrategy: string
  toStrategy: string
  reason: string
  confidence: number
  successful: boolean | null // Kết quả sau khi adapt (null = chưa biết)
  createdAt: string
}