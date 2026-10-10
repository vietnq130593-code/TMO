/**
 * Layer 9: Learning & Adaptation — Barrel Export
 *
 * Export tất cả public APIs của Layer 9.
 */

// Types
export type {
  ExecutionMetrics,
  AggregatedMetrics,
  FailurePattern,
  FailurePatternType,
  AdaptationStrategy,
  AdaptationRule,
  AdaptationDecision,
  LearningState,
  LearningConfig,
  MetricsCollector,
  StrategyAdaptationLog,
} from './types'

// Metrics Collector
export { createMetricsCollector } from './metrics-collector'

// Historical Feedback
export {
  analyzeHistoricalFeedback,
  getAdjustedBudget,
  getSuccessProbability,
  // P2-M2 — Wilson CI cho mọi xác suất rút từ mẫu
  getSuccessProbabilityWithCI,
  isTrustworthySuccessCI,
  TRUST_MIN_N,
  TRUST_MAX_CI_WIDTH,
  type SuccessProbabilityWithCI,
} from './historical-feedback'

// Strategy Adapter
export {
  detectFailurePattern,
  recommendAdaptation,
  applyAdaptation,
  persistFailurePattern,
  persistAdaptationLog,
} from './strategy-adapter'