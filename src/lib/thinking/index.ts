/**
 * Layer 2: Thinking & Planning — Public API
 *
 * ROUND-37 V4: solution-designer + token-monitor đã XÓA — dead scaffolding
 * (0 caller ngoài barrel). Đường SỐNG còn lại: decomposeTask (dev-tools
 * decomposeTaskViaThinkingLayer) + resolveCircularDependencies (decomposer).
 * Types giữ nguyên trong ./types (SolutionDesign dùng bởi communication/types).
 */

// Types
export type {
  // Core types
  SubTask,
  SubTaskType,
  Complexity,
  DependencyGraph,
  DecompositionPlan,
  SolutionDesign,
  ArchitectureDecision,
  ComponentDesign,
  SchemaDesign,
  APIDesign,
  StateDesign,
  // Workflow thinking context
  WorkflowThinkingContext,
  SubTaskSolutionMap,
  // Options
  DecomposerOptions,
} from './types'

// Functions
export { decomposeTask } from './decomposer'

// Circular resolver
export { resolveCircularDependencies } from './circular-resolver'
