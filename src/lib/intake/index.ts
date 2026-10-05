/**
 * Layer 1: Intake & Comprehension — Public API
 *
 * Export tất cả public functions và types cho Layer 1.
 *
 * ROUND-37 V4: context-assembler (1.3) đã XÓA — dead scaffolding (0 caller
 * ngoài barrel; assembleContext chưa từng được tiêu thụ). Chỉ còn những
 * đường SỐNG: parseIntent + buildMentalModel (dev-tools decomposeTaskViaThinkingLayer).
 */

// Types
export type {
  TaskType,
  TechnicalConstraints,
  IntentResult,
  MentalModel,
  ProjectStructure,
  DependencyGraph,
  DetectedPattern,
  CodeConventions,
  SelectedFile,
  AssembledContext,
  Message,
  IntentParserOptions,
  CodeReaderOptions,
} from './types'

// Intent Parsing (1.1)
export { parseIntent } from './intent-parser'

// Code Reading (1.2)
export { buildMentalModel, invalidateMentalModelCache } from './code-reader'