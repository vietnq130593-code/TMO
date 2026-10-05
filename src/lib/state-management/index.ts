/**
 * Layer 6: State Management System — Barrel Export
 *
 * Export tất cả types, interfaces, và factory functions
 * để các module khác import dễ dàng.
 */

// ==================== TYPES ====================

export type {
  // Progress Tracking
  ProgressState,
  StepState,
  StepResult,
  ProgressReport,
  ProgressTracker,

  // Context Management — CI-3 B6 (Task 13-a): stub context-manager đã XÓA,
  // thay bằng module thống nhất @/lib/context-compression. Chỉ giữ các type
  // còn được dùng thật (ContextState → orchestration, ContextEntry/
  // SummarizationResult → checkpoint + ContextState).
  ContextState,
  ContextEntry,
  SummarizationResult,

  // Checkpoint & Recovery
  Checkpoint,
  CheckpointState,
  CheckpointPhase,
  CheckpointManager,

  // Pipeline Context
  PipelineContext,
} from './types'

// ==================== FACTORY FUNCTIONS ====================

// ROUND-37 V4: progress-tracker đã XÓA — dead scaffolding (0 caller ngoài
// barrel; runPipeline build StepState trực tiếp cho progress-reporter).
// createCheckpointManager BỘ SỐNG: workflow-engine saveCheckpoint durable.
export { createCheckpointManager } from './checkpoint-manager'