/**
 * Layer 7.1: Master Orchestration — Main Loop Controller
 *
 * Đây là vòng lặp chính — "main loop" — kết nối tất cả layers lại với nhau.
 *
 * Vòng lặp chính:
 *   RECEIVE → UNDERSTAND → PLAN → EXECUTE LOOP → FINAL VERIFY → REPORT
 *
 * Decision points:
 *   - Sau mỗi step: Continue? Re-verify? Re-plan? Ask user?
 *   - Sau mỗi error: Fix and continue? Re-plan? Rollback? Escalate?
 *   - Sau final verify: All pass? Partial pass? Need more work?
 */

import type {
  MasterOrchestrator,
  OrchestrationState,
  OrchestrationConfig,
  OrchestrationRequest,
  OrchestrationResult,
  OrchestrationPhase,
  OrchestrationDecision,
  DecisionPoint,
  DecisionContext,
} from './types'
import type { PipelineStep, StepStatus } from '@/lib/code-team/types'
import { createMetricsCollector } from '@/lib/learning'
import type { MetricsCollector } from '@/lib/learning'
import {
  analyzeHistoricalFeedback,
  getAdjustedBudget,
  getSuccessProbability,
  detectFailurePattern,
  recommendAdaptation,
  applyAdaptation,
  persistFailurePattern,
  persistAdaptationLog,
} from '@/lib/learning'
import type { AggregatedMetrics, FailurePattern } from '@/lib/learning'
import { isFlagEnabled } from '@/lib/feature-flags'

// ==================== DEFAULT CONFIGURATION ====================

const DEFAULT_CONFIG: OrchestrationConfig = {
  mode: 'sequential',
  maxRetries: 3,
  maxParallelAgents: 3,
  autoEscalateAfterFailures: 3,
  checkpointFrequency: 'every_phase',
  toolSelectionStrategy: 'strict',
  delegationStrategy: 'none',
  learning: {
    enabled: true,
    minRunsForFeedback: 5,
    maxHistoricalRuns: 100,
    adaptationThreshold: 0.3,
    autoApplyStrategies: true,
  },
}

// ==================== MASTER ORCHESTRATOR IMPLEMENTATION ====================

/**
 * Create a new Master Orchestrator.
 */
export function createMasterOrchestrator(
  config: Partial<OrchestrationConfig> = {}
): MasterOrchestrator {
  const fullConfig = { ...DEFAULT_CONFIG, ...config }
  let state: OrchestrationState | null = null
  let isPaused = false
  let isAborted = false

  return {
    getState(): OrchestrationState {
      if (!state) {
        throw new Error('Orchestrator not started yet')
      }
      return state
    },

    async start(request: OrchestrationRequest): Promise<OrchestrationResult> {
      return startOrchestration(request, fullConfig)
    },

    pause(): void {
      isPaused = true
    },

    async resume(): Promise<void> {
      isPaused = false
      // Resume logic would continue from current state
    },

    abort(): void {
      isAborted = true
    },

    getDecision(point: DecisionPoint, context: DecisionContext): OrchestrationDecision {
      return makeDecision(point, context, fullConfig)
    },
  }
}

// ==================== MAIN ORCHESTRATION LOOP ====================

/**
 * Start the main orchestration loop.
 *
 * v2.1 Phase 5.1 — gated by ENABLE_MASTER_ORCHESTRATOR feature flag:
 *   - flag=false (default): return early with status='skipped' — the legacy
 *     placeholder loop is preserved so existing orchestrations/tests don't
 *     break (callers can treat skipped as a no-op).
 *   - flag=true: run the real loop, dispatching each pipeline step to
 *     runAgentStep() in code-team/workflow-engine.ts (see executeStep below).
 */
async function startOrchestration(
  request: OrchestrationRequest,
  config: OrchestrationConfig
): Promise<OrchestrationResult> {
  const startTime = Date.now()

  // Phase 5.1 — short-circuit when the flag is off (preserves placeholder behavior).
  if (!isFlagEnabled('ENABLE_MASTER_ORCHESTRATOR')) {
    console.log(`[Orchestrator] ENABLE_MASTER_ORCHESTRATOR=false — skipping orchestration for session ${request.sessionId}`)
    return {
      status: 'skipped',
      totalDuration: 0,
      stepsCompleted: 0,
      stepsTotal: 0,
      errors: [],
      summary: 'master-orchestrator disabled (ENABLE_MASTER_ORCHESTRATOR=false)',
    }
  }

  // Initialize state
  const state: OrchestrationState = {
    phase: 'receive',
    currentStepIndex: 0,
    pipeline: [],
    routingDecision: request.routing || {
      mode: 'B',
      tier: 2,
      score: 5,
      reasoning: 'Default routing',
      parts: [],
    },
    progress: {
      planId: request.sessionId,
      totalSteps: 0,
      completedSteps: 0,
      failedSteps: 0,
      currentStep: 0,
      steps: {},
      totalTokensUsed: 0,
      totalTokensBudgeted: 0,
      totalTimeSpent: 0,
      errors: [],
      startedAt: new Date().toISOString(),
      lastUpdatedAt: new Date().toISOString(),
    },
    context: {
      maxTokens: 100000,
      currentTokens: 0,
      entries: [],
      summarizationCache: {},
      priorityScores: {},
    },
    errors: [],
    decisions: [],
    learning: {
      metrics: null,
      historicalMetrics: null,
      currentPattern: null,
      lastAdaptation: null,
      adaptationCount: 0,
      isEnabled: config.learning.enabled,
    },
    startedAt: new Date().toISOString(),
    lastUpdatedAt: new Date().toISOString(),
  }

  // Initialize MetricsCollector (Layer 9)
  const metricsCollector = createMetricsCollector(
    request.sessionId,
    request.sessionId, // planId = sessionId for now
    state.routingDecision.mode,
    state.routingDecision.tier,
    100000 // Default token budget
  )

  try {
    // Phase 1: RECEIVE
    state.phase = 'receive'
    logPhase('receive', request.sessionId)

    // Phase 2: UNDERSTAND (Layer 1)
    state.phase = 'understand'
    logPhase('understand', request.sessionId)
    // TODO: Integrate with intake layer

    // Phase 3: PLAN (Layer 2)
    state.phase = 'plan'
    logPhase('plan', request.sessionId)
    // TODO: Integrate with thinking layer

    // Phase 4: EXECUTE (Layers 3-6)
    state.phase = 'execute'
    logPhase('execute', request.sessionId)

    // Build pipeline from routing decision
    const pipeline = buildPipeline(state.routingDecision.mode, state.routingDecision.tier)
    state.pipeline = pipeline
    state.progress.totalSteps = pipeline.length

    // Execute each step
    for (let i = 0; i < pipeline.length; i++) {
      const step = pipeline[i]
      state.currentStepIndex = i

      // Decision point: before step
      const beforeDecision = makeDecision(
        { type: 'after_step', stepIndex: i - 1 },
        { state, pipeline, currentStepIndex: i },
        config
      )

      if (beforeDecision.decision === 'escalate') {
        state.phase = 'escalated'
        return buildResult(state, 'escalated', Date.now() - startTime)
      }

      if (beforeDecision.decision === 'rollback') {
        // TODO: Implement rollback
        continue
      }

      // Record step start (Layer 9)
      metricsCollector.recordStepStart(`${step.position}-${step.step}`, step.step, step.position)

      // Execute step (placeholder)
      const stepResult = await executeStep(step, request.sessionId)

      // Record step complete (Layer 9)
      metricsCollector.recordStepComplete(
        `${step.position}-${step.step}`,
        {
          success: stepResult.success,
          filesCreated: [],
          filesModified: [],
          summary: `Step ${step.position}/${step.step} executed`,
          outputForNext: '',
        },
        0, // tokensUsed - would come from actual execution
        50 // timeSpent - would come from actual execution
      )

      // Update progress
      state.progress.steps[step.position] = {
        id: `${step.position}-${step.step}`,
        type: step.step,
        status: stepResult.success ? 'completed' : 'failed',
        agentPosition: step.position,
        description: step.description,
        result: stepResult.success ? {
          success: true,
          filesCreated: [],
          filesModified: [],
          summary: `Step ${step.position}/${step.step} executed`,
          outputForNext: '',
        } : undefined,
        tokensUsed: 0,
        tokensBudgeted: 0,
        timeSpent: 0,
        errors: stepResult.success ? [] : [{
          id: `err-${Date.now()}`,
          timestamp: new Date(),
          errorType: 'runtime',
          severity: 'high',
          message: stepResult.error || 'Step failed',
          rootCause: 'Execution failed',
          fixStrategy: 'surgical',
          fixApplied: false,
          fixDescription: '',
          loopDetected: false,
          loopCount: 0,
        }],
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      }

      state.progress.completedSteps += stepResult.success ? 1 : 0
      state.progress.lastUpdatedAt = new Date().toISOString()

      // ROUND-37 V2a — APPLY adaptation config (trước đây applyAdaptation chỉ
      // được import mà không gọi — dead import). Khi makeDecision trả về
      // 'adapt_strategy' (đã set state.learning.currentPattern), config thật
      // của applyAdaptation được merge vào state.learning.pendingConfig để
      // executeStep kế tiếp tiêu thụ (preStep/maxTokens/contextAction/escalate).
      if (
        state.learning.currentPattern &&
        state.learning.adaptationCount > 0 &&
        state.learning.pendingConfig === undefined
      ) {
        const decision = recommendAdaptation(state.learning.currentPattern, state.learning.historicalMetrics)
        if (decision.shouldAdapt) {
          const { updatedConfig } = applyAdaptation(decision)
          state.learning.pendingConfig = updatedConfig
          state.learning.pendingStrategy = decision.recommendedStrategy
        }
      }

      // Decision point: after step
      const afterDecision = makeDecision(
        { type: 'after_step', stepIndex: i, stepResult },
        { state, pipeline, currentStepIndex: i },
        config
      )

      // Adaptation đã sinh config → áp vào context budget ngay (reduce_scope
      // hạ maxTokens của các step sau; escalate được makeDecision xử lý ở trên)
      if (state.learning.pendingConfig && typeof state.learning.pendingConfig['maxTokens'] === 'number') {
        state.context.maxTokens = Math.min(
          state.context.maxTokens,
          state.learning.pendingConfig['maxTokens'] as number,
        )
      }

      if (afterDecision.decision === 'escalate') {
        state.phase = 'escalated'
        return buildResult(state, 'escalated', Date.now() - startTime)
      }
    }

    // Phase 5: VERIFY (Layer 4)
    state.phase = 'verify'
    logPhase('verify', request.sessionId)
    // TODO: Integrate with verification layer

    // Phase 6: REPORT (Layer 8)
    state.phase = 'report'
    logPhase('report', request.sessionId)
    // TODO: Integrate with communication layer

    // Flush metrics (Layer 9) — fire-and-forget
    metricsCollector.flush().catch((err) => {
      console.error('[Orchestrator] Failed to flush metrics:', err)
    })

    state.phase = 'completed'
    return buildResult(state, 'completed', Date.now() - startTime)

  } catch (error) {
    // Flush metrics even on error (Layer 9) — fire-and-forget
    metricsCollector.flush().catch((err) => {
      console.error('[Orchestrator] Failed to flush metrics:', err)
    })
    const errorMsg = error instanceof Error ? error.message : String(error)
    console.error(`[Orchestrator] Fatal error:`, errorMsg)

    state.errors.push({
      id: `err-${Date.now()}`,
      timestamp: new Date(),
      errorType: 'runtime',
      severity: 'critical',
      message: errorMsg,
      rootCause: 'Orchestration failed',
      fixStrategy: 'surgical',
      fixApplied: false,
      fixDescription: '',
      loopDetected: false,
      loopCount: 0,
    })

    return buildResult(state, 'failed', Date.now() - startTime)
  }
}

// ==================== DECISION ENGINE ====================

/**
 * Make a decision at a decision point.
 */
function makeDecision(
  point: DecisionPoint,
  context: DecisionContext,
  config: OrchestrationConfig
): OrchestrationDecision {
  const { state, pipeline, currentStepIndex } = context

  // Default: continue
  let decision: OrchestrationDecision['decision'] = 'continue'
  let reasoning = 'Default: continue execution'

  // After step decisions
  if (point.type === 'after_step') {
    const hasErrors = state.errors.length > 0
    const recentErrors = state.errors.filter(
      (e) => Date.now() - e.timestamp.getTime() < 60000 // Last minute
    )

    if (hasErrors && recentErrors.length >= config.autoEscalateAfterFailures) {
      decision = 'escalate'
      reasoning = `Too many errors (${recentErrors.length}) in short time, escalating to user`
    } else if (hasErrors) {
      decision = 'reverify'
      reasoning = 'Errors detected, re-verify before continuing'
    }
  }

  // After error decisions
  if (point.type === 'after_error') {
    const errorCount = state.errors.length

    if (errorCount >= config.autoEscalateAfterFailures) {
      decision = 'escalate'
      reasoning = `Error threshold reached (${errorCount}), escalating to user`
    } else if (errorCount >= config.maxRetries) {
      decision = 'replan'
      reasoning = `Max retries exceeded, re-planning approach`
    } else {
      decision = 'continue'
      reasoning = `Retrying after error (${errorCount}/${config.maxRetries})`
    }

    // Layer 9: Check for failure patterns and recommend adaptation
    if (config.learning.enabled && state.learning.isEnabled) {
      const currentMetrics = state.learning.metrics || {
        totalTokensUsed: 0,
        totalTokensBudgeted: 0,
        totalTimeSpent: 0,
      }

      const pattern = detectFailurePattern(
        { type: state.errors[state.errors.length - 1]?.errorType || 'unknown', message: state.errors[state.errors.length - 1]?.message || '' },
        state.errors.map((e) => ({ type: e.errorType, message: e.message })),
        currentMetrics,
        state.learning.historicalMetrics
      )

      if (pattern) {
        state.learning.currentPattern = pattern
        const adaptationDecision = recommendAdaptation(pattern, state.learning.historicalMetrics)

        if (adaptationDecision.shouldAdapt && config.learning.autoApplyStrategies) {
          decision = 'adapt_strategy'
          reasoning = adaptationDecision.reason
          state.learning.lastAdaptation = new Date().toISOString()
          state.learning.adaptationCount++
        }
      }
    }
  }

  // After verify decisions
  if (point.type === 'after_verify') {
    decision = 'continue'
    reasoning = 'Verification passed, continuing'
  }

  // Context overflow
  if (point.type === 'context_overflow') {
    decision = 'continue'
    reasoning = 'Context pruned, continuing with reduced context'
  }

  return {
    timestamp: new Date().toISOString(),
    point: point.type,
    decision,
    reasoning,
    context: {
      stepIndex: currentStepIndex,
      pipelineLength: pipeline.length,
      errorCount: state.errors.length,
    },
  }
}

// ==================== HELPER FUNCTIONS ====================

/**
 * Build pipeline steps from routing decision.
 */
function buildPipeline(mode: string, tier: number): PipelineStep[] {
  // Simplified pipeline builder
  // In production, this would use the full pipeline logic from workflow-engine.ts
  const steps: PipelineStep[] = []

  if (mode === 'A') {
    steps.push(
      { position: 'TL', step: 'analyze', isCheckpoint: false, description: 'Analyze visual request' },
      { position: 'TL', step: 'code', isCheckpoint: false, description: 'Code UI' },
      { position: 'G2-B', step: 'review', isCheckpoint: true, description: 'Review code' },
      { position: 'TL', step: 'verify', isCheckpoint: false, description: 'Final verify' }
    )
  } else if (mode === 'C') {
    steps.push(
      { position: 'TL', step: 'analyze', isCheckpoint: false, description: 'Analyze request' },
      { position: 'TL', step: 'code', isCheckpoint: false, description: 'Code UI' },
      { position: 'G1', step: 'design', isCheckpoint: true, description: 'Design backend' },
      { position: 'G2-A', step: 'code', isCheckpoint: true, description: 'Code backend' },
      { position: 'G2-B', step: 'review', isCheckpoint: true, description: 'Review' },
      { position: 'G3', step: 'optimize', isCheckpoint: true, description: 'Optimize' },
      { position: 'TL', step: 'verify', isCheckpoint: false, description: 'Final verify' }
    )
  } else {
    // Mode B
    steps.push(
      { position: 'TL', step: 'analyze', isCheckpoint: false, description: 'Analyze request' },
      { position: 'G1', step: 'design', isCheckpoint: true, description: 'Design architecture' },
      { position: 'G2-A', step: 'code', isCheckpoint: true, description: 'Code implementation' },
      { position: 'G2-B', step: 'review', isCheckpoint: true, description: 'Review code' },
      { position: 'G3', step: 'optimize', isCheckpoint: true, description: 'Optimize' },
      { position: 'TL', step: 'verify', isCheckpoint: false, description: 'Final verify' }
    )
  }

  return steps
}

/**
 * Execute a single pipeline step.
 *
 * v2.1 Phase 5.1 — wires to a real agent step via runAgentStep() in
 * code-team/workflow-engine.ts when ENABLE_MASTER_ORCHESTRATOR is true.
 * Falls back to the legacy placeholder behavior (50ms sleep + success) when
 * the flag is false — though startOrchestration short-circuits earlier so
 * executeStep is never reached in that case, we keep the defensive check
 * here in case a caller invokes executeStep directly.
 *
 * Dynamic import is used to avoid a static circular dependency between
 * orchestration ↔ code-team modules.
 */
async function executeStep(
  step: PipelineStep,
  sessionId: string
): Promise<{ success: boolean; error?: string }> {
  console.log(`[Orchestrator] Executing step: ${step.position}/${step.step}`)

  // Defensive: if the flag is off, fall back to placeholder (preserves old behavior).
  if (!isFlagEnabled('ENABLE_MASTER_ORCHESTRATOR')) {
    await new Promise((resolve) => setTimeout(resolve, 50))
    return { success: true }
  }

  try {
    // Dynamic import — avoids loading workflow-engine (and its heavy deps) when
    // the flag is off, and breaks any potential circular static-dep cycle.
    const { runAgentStep, createMinimalWorkflowContext, noopSSEEmitter } =
      await import('@/lib/code-team/workflow-engine')

    const ctx = await createMinimalWorkflowContext()
    const emit = noopSSEEmitter()

    const result = await runAgentStep({
      position: step.position,
      step: step.step,
      // Use the step description as the prompt — the orchestrator's pipeline
      // is intentionally lighter than the full runWorkflow context, so we feed
      // the agent just the step description. (In a future iteration, we can
      // plumb a richer prompt from the orchestration state/context.)
      prompt: step.description || `Execute ${step.position}/${step.step}`,
      sessionId,
      emit,
      ctx,
    })

    if (!result || !result.content) {
      return { success: false, error: 'runAgentStep returned empty content' }
    }
    return { success: true }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err)
    console.error(`[Orchestrator] executeStep failed for ${step.position}/${step.step}:`, errorMsg)
    return { success: false, error: errorMsg }
  }
}

/**
 * Build the final orchestration result.
 */
function buildResult(
  state: OrchestrationState,
  status: 'completed' | 'failed' | 'escalated' | 'aborted' | 'skipped',
  duration: number
): OrchestrationResult {
  return {
    status,
    totalDuration: duration,
    stepsCompleted: state.progress.completedSteps,
    stepsTotal: state.progress.totalSteps,
    errors: state.errors,
    summary: generateSummary(state, status),
  }
}

/**
 * Generate a human-readable summary of the orchestration.
 */
function generateSummary(state: OrchestrationState, status: string): string {
  const parts: string[] = [
    `Orchestration ${status}`,
    `Steps: ${state.progress.completedSteps}/${state.progress.totalSteps}`,
    `Errors: ${state.errors.length}`,
    `Decisions: ${state.decisions.length}`,
  ]

  return parts.join('\n')
}

/**
 * Log phase transition.
 */
function logPhase(phase: OrchestrationPhase, sessionId: string): void {
  console.log(`[Orchestrator] Phase: ${phase} (session: ${sessionId})`)
}