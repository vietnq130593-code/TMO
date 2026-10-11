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

// Q-Table (P6-M2 — FB-P6-R1-B-08: đưa vào barrel cho C7 "barrel đủ"; các
// call-site hiện import trực tiếp '@/lib/learning/q-table' — re-export thuần,
// không vòng import: q-table chỉ phụ thuộc @/lib/db)
export {
  qLearningUpdate,
  softmaxPolicy,
  deterministicSeed,
  pickIndexBySeed,
  qStateKey,
  agentRuntimeStateKey,
  updateQ,
  getQAdvice,
  getTopQAdvice,
  qEntryCount,
  Q_LEARNING_ALPHA,
  Q_LEARNING_GAMMA,
  RUNTIME_MODEL_TAU_DEFAULT,
  RUNTIME_MODEL_TAU_FLOOR,
  parseRuntimeModelTau,
  type QAdviceEntry,
} from './q-table'