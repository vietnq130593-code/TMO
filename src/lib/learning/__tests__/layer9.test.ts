/// <reference types="bun-types" />
/**
 * Layer 9: Learning & Adaptation — Unit Tests
 *
 * Test coverage cho:
 *   - MetricsCollector (9.1)
 *   - HistoricalFeedback (9.1)
 *   - StrategyAdapter (9.2)
 *   - Integration với Orchestration types
 */

import { describe, it, expect, beforeEach, mock } from 'bun:test'
import { createMetricsCollector } from '../metrics-collector'
import {
  analyzeHistoricalFeedback,
  getAdjustedBudget,
  getSuccessProbability,
} from '../historical-feedback'
import {
  detectFailurePattern,
  recommendAdaptation,
  applyAdaptation,
} from '../strategy-adapter'
import type { AggregatedMetrics, FailurePattern } from '../types'

// ==================== MOCK PRISMA ====================

mock.module('@/lib/db', () => ({
  db: {
    executionMetrics: {
      findMany: mock(() => Promise.resolve([])),
      create: mock(() => Promise.resolve({})),
    },
    failurePattern: {
      create: mock(() => Promise.resolve({})),
    },
    strategyAdaptationLog: {
      create: mock(() => Promise.resolve({})),
    },
  },
}))

// ==================== METRICS COLLECTOR TESTS ====================

describe('MetricsCollector', () => {
  let metricsCollector: ReturnType<typeof createMetricsCollector>

  beforeEach(() => {
    metricsCollector = createMetricsCollector('session-1', 'plan-1', 'B', 2, 100000)
  })

  it('should record step start', () => {
    metricsCollector.recordStepStart('step-1', 'analyze', 'TL')
    const metrics = metricsCollector.getCurrentMetrics()
    expect(metrics.totalSteps).toBe(1)
  })

  it('should record step complete', () => {
    metricsCollector.recordStepStart('step-1', 'analyze', 'TL')
    metricsCollector.recordStepComplete(
      'step-1',
      {
        success: true,
        filesCreated: ['file.ts'],
        filesModified: [],
        summary: 'Step completed',
        outputForNext: '',
      },
      1000,
      5000
    )
    const metrics = metricsCollector.getCurrentMetrics()
    expect(metrics.completedSteps).toBe(1)
    expect(metrics.totalTokensUsed).toBe(1000)
  })

  it('should record step error', () => {
    metricsCollector.recordStepStart('step-1', 'analyze', 'TL')
    metricsCollector.recordStepError('step-1', {
      id: 'err-1',
      timestamp: new Date(),
      errorType: 'type',
      severity: 'high',
      message: 'Type error',
      fixApplied: false,
      loopDetected: false,
      loopCount: 0,
    })
    const metrics = metricsCollector.getCurrentMetrics()
    expect(metrics.errorsByType['type']).toBe(1)
  })

  it('should calculate step success rate', () => {
    metricsCollector.recordStepStart('step-1', 'analyze', 'TL')
    metricsCollector.recordStepComplete(
      'step-1',
      { success: true, filesCreated: [], filesModified: [], summary: '', outputForNext: '' },
      100,
      1000
    )
    metricsCollector.recordStepStart('step-2', 'code', 'G1')
    metricsCollector.recordStepComplete(
      'step-2',
      { success: false, filesCreated: [], filesModified: [], summary: '', outputForNext: '' },
      200,
      2000
    )
    const metrics = metricsCollector.getCurrentMetrics()
    expect(metrics.stepSuccessRate).toBe(0.5)
  })

  it('should flush metrics to DB', async () => {
    metricsCollector.recordStepStart('step-1', 'analyze', 'TL')
    metricsCollector.recordStepComplete(
      'step-1',
      { success: true, filesCreated: [], filesModified: [], summary: '', outputForNext: '' },
      100,
      1000
    )
    const metrics = await metricsCollector.flush()
    expect(metrics.sessionId).toBe('session-1')
    expect(metrics.totalSteps).toBe(1)
  })
})

// ==================== HISTORICAL FEEDBACK TESTS ====================

describe('HistoricalFeedback', () => {
  it('should return empty aggregated metrics when no data', async () => {
    const result = await analyzeHistoricalFeedback()
    expect(result.totalRuns).toBe(0)
    expect(result.overallSuccessRate).toBe(0)
  })

  it('should calculate adjusted budget with no historical data', () => {
    const budget = getAdjustedBudget('task-1', 2, null, 10000)
    expect(budget).toBe(20000) // baseBudget * complexity
  })

  it('should calculate adjusted budget with historical data', () => {
    const historicalMetrics: AggregatedMetrics = {
      byTaskType: {
        'task-1': {
          avgTokensUsed: 5000,
          avgTokensBudgeted: 10000,
          avgTimeSpent: 10000,
          successRate: 0.8,
          sampleSize: 10,
        },
      },
      byRoutingMode: {},
      byErrorType: {},
      overallSuccessRate: 0.8,
      totalRuns: 10,
    }
    const budget = getAdjustedBudget('task-1', 1, historicalMetrics, 10000)
    expect(budget).toBe(5500) // 5000 * 1.1 * 1
  })

  it('should return neutral success probability with no data', () => {
    const probability = getSuccessProbability('task-1', 'B', null)
    expect(probability).toBe(0.5)
  })

  it('should return success probability from historical data', () => {
    const historicalMetrics: AggregatedMetrics = {
      byTaskType: {
        'task-1': {
          avgTokensUsed: 5000,
          avgTokensBudgeted: 10000,
          avgTimeSpent: 10000,
          successRate: 0.8,
          sampleSize: 10,
        },
      },
      byRoutingMode: {},
      byErrorType: {},
      overallSuccessRate: 0.8,
      totalRuns: 10,
    }
    const probability = getSuccessProbability('task-1', 'B', historicalMetrics)
    expect(probability).toBe(0.8)
  })
})

// ==================== STRATEGY ADAPTER TESTS ====================

describe('StrategyAdapter', () => {
  it('should detect repeated error pattern', () => {
    const pattern = detectFailurePattern(
      { type: 'type', message: 'Type error' },
      [
        { type: 'type', message: 'Type error' },
        { type: 'type', message: 'Type error' },
      ],
      { totalTokensUsed: 1000, totalTokensBudgeted: 10000, totalTimeSpent: 5000 },
      null
    )
    expect(pattern).not.toBeNull()
    expect(pattern?.type).toBe('repeated_error')
    expect(pattern?.count).toBe(3)
  })

  it('should detect resource limit pattern', () => {
    const pattern = detectFailurePattern(
      { type: 'timeout', message: 'Timeout' },
      [],
      { totalTokensUsed: 20000, totalTokensBudgeted: 10000, totalTimeSpent: 10000 },
      null
    )
    expect(pattern).not.toBeNull()
    expect(pattern?.type).toBe('resource_limit')
  })

  it('should recommend adaptation for repeated error', () => {
    const pattern: FailurePattern = {
      id: 'pattern-1',
      type: 'repeated_error',
      count: 3,
      lastOccurrence: new Date().toISOString(),
      strategiesTried: [],
      nextStrategy: 'change_fix_approach',
      context: { taskType: 'test', routingMode: 'B', stepType: 'analyze' },
    }
    const decision = recommendAdaptation(pattern, null)
    expect(decision.shouldAdapt).toBe(true)
    expect(decision.recommendedStrategy).toBe('change_fix_approach')
  })

  it('should apply adaptation and return config changes', () => {
    const decision = {
      shouldAdapt: true,
      currentStrategy: 'change_fix_approach' as const,
      recommendedStrategy: 'reduce_scope' as const,
      reason: 'Resource limit detected',
      confidence: 0.8,
    }
    const result = applyAdaptation(decision)
    expect(result.updatedConfig['maxTokens']).toBe(2048)
    expect(result.updatedConfig['skipOptionalSteps']).toBe(true)
  })

  it('should default to escalate when no rule matches', () => {
    // 'resource_limit' with null metrics matches no DEFAULT_RULE
    // (the resource_limit rule requires metrics !== null) → falls through to escalate
    const pattern: FailurePattern = {
      id: 'pattern-1',
      type: 'resource_limit',
      count: 1,
      lastOccurrence: new Date().toISOString(),
      strategiesTried: [],
      nextStrategy: 'compress_context',
      context: { taskType: 'test', routingMode: 'B', stepType: 'analyze' },
    }
    const decision = recommendAdaptation(pattern, null)
    expect(decision.shouldAdapt).toBe(true)
    expect(decision.recommendedStrategy).toBe('escalate_to_user')
  })
})

// ==================== INTEGRATION TESTS ====================

describe('Layer 9 Integration', () => {
  it('should integrate metrics collector with orchestration state', () => {
    const metricsCollector = createMetricsCollector('session-1', 'plan-1', 'B', 2, 100000)
    metricsCollector.recordStepStart('step-1', 'analyze', 'TL')
    metricsCollector.recordStepComplete(
      'step-1',
      { success: true, filesCreated: [], filesModified: [], summary: '', outputForNext: '' },
      1000,
      5000
    )
    const metrics = metricsCollector.getCurrentMetrics()
    expect(metrics.sessionId).toBe('session-1')
    expect(metrics.routingMode).toBe('B')
    expect(metrics.tier).toBe(2)
  })

  it('should calculate token efficiency', () => {
    const metricsCollector = createMetricsCollector('session-1', 'plan-1', 'B', 2, 100000)
    metricsCollector.recordStepStart('step-1', 'analyze', 'TL')
    metricsCollector.recordStepComplete(
      'step-1',
      { success: true, filesCreated: [], filesModified: [], summary: '', outputForNext: '' },
      50000,
      5000
    )
    const metrics = metricsCollector.getCurrentMetrics()
    expect(metrics.tokenEfficiency).toBe(0.5) // 50000 / 100000
  })
})