/**
 * Layer 9.2: Strategy Adapter
 *
 * Phát hiện pattern thất bại và đề xuất/áp dụng chiến lược thích ứng.
 * Khi approach hiện tại không hiệu quả, tự động chuyển sang approach khác
 * dựa trên historical data và predefined rules.
 */

import { db } from '@/lib/db'
import type {
  AdaptationDecision,
  AdaptationRule,
  AdaptationStrategy,
  AggregatedMetrics,
  FailurePattern,
  FailurePatternType,
} from './types'

// ==================== DEFAULT ADAPTATION RULES ====================

/**
 * Rules mặc định — được áp dụng khi không có historical data
 * hoặc khi historical data không đủ để đưa ra quyết định.
 */
const DEFAULT_RULES: AdaptationRule[] = [
  // Red Team Engine Phase 4 (2026-08-25): adversarial breach beats operational
  // rules in priority — security before performance. Fires when the SAME attack
  // vector breaches >= 2 times (count from FailurePattern rows of type
  // 'redteam_breach' with the same taskType prefix 'redteam:<vector>').
  // Recommend tightening the KB confidence/refusal threshold for 24h —
  // defense in depth while humans review the disputed queue.
  {
    condition: (pattern) => pattern.type === 'redteam_breach' && pattern.count >= 2,
    strategy: 'tighten_refusal_threshold',
    priority: 110,
  },
  {
    condition: (pattern) => pattern.type === 'repeated_error' && pattern.count >= 3,
    strategy: 'change_fix_approach',
    priority: 100,
  },
  {
    condition: (pattern) => pattern.type === 'approach_exhausted',
    strategy: 'escalate_to_user',
    priority: 90,
  },
  {
    condition: (pattern, metrics) =>
      pattern.type === 'resource_limit' &&
      metrics !== null &&
      metrics.overallSuccessRate < 0.3,
    strategy: 'reduce_scope',
    priority: 80,
  },
  {
    condition: (pattern) => pattern.type === 'repeated_error' && pattern.count >= 2,
    strategy: 'read_lint_rules_first',
    priority: 70,
  },
  {
    condition: (pattern) => pattern.type === 'timeout',
    strategy: 'compress_context',
    priority: 60,
  },
]

// ==================== PATTERN DETECTION ====================

/**
 * Phát hiện pattern thất bại từ lỗi hiện tại và lịch sử
 */
export function detectFailurePattern(
  currentError: { type: string; message: string },
  previousErrors: Array<{ type: string; message: string }>,
  currentMetrics: { totalTokensUsed: number; totalTokensBudgeted: number; totalTimeSpent: number },
  historicalMetrics: AggregatedMetrics | null
): FailurePattern | null {
  const allErrors = [...previousErrors, currentError]

  // Check for repeated_error
  const errorCounts = new Map<string, number>()
  for (const err of allErrors) {
    errorCounts.set(err.type, (errorCounts.get(err.type) || 0) + 1)
  }

  for (const [errorType, count] of errorCounts.entries()) {
    if (count >= 2) {
      return {
        id: `pattern-${Date.now()}`,
        type: 'repeated_error',
        count,
        lastOccurrence: new Date().toISOString(),
        strategiesTried: [],
        nextStrategy: 'change_fix_approach',
        context: {
          taskType: 'unknown',
          routingMode: 'unknown',
          stepType: 'unknown',
        },
      }
    }
  }

  // Check for resource_limit
  const tokenEfficiency =
    currentMetrics.totalTokensBudgeted > 0
      ? currentMetrics.totalTokensUsed / currentMetrics.totalTokensBudgeted
      : 0

  if (tokenEfficiency > 1.5) {
    return {
      id: `pattern-${Date.now()}`,
      type: 'resource_limit',
      count: 1,
      lastOccurrence: new Date().toISOString(),
      strategiesTried: [],
      nextStrategy: 'reduce_scope',
      context: {
        taskType: 'unknown',
        routingMode: 'unknown',
        stepType: 'unknown',
      },
    }
  }

  // Check for approach_exhausted (3+ different strategies tried)
  if (historicalMetrics && historicalMetrics.totalRuns > 0) {
    // This would need more context about strategies tried
    // For now, simplified check
  }

  return null
}

// ==================== ADAPTATION RECOMMENDATION ====================

/**
 * Đề xuất chiến lược thích ứng dựa trên pattern và historical data
 */
export function recommendAdaptation(
  pattern: FailurePattern,
  historicalMetrics: AggregatedMetrics | null,
  customRules: AdaptationRule[] = []
): AdaptationDecision {
  const rules = [...customRules, ...DEFAULT_RULES].sort((a, b) => b.priority - a.priority)

  for (const rule of rules) {
    if (rule.condition(pattern, historicalMetrics)) {
      const confidence = calculateConfidence(rule.strategy, historicalMetrics)

      return {
        shouldAdapt: true,
        currentStrategy: pattern.nextStrategy,
        recommendedStrategy: rule.strategy,
        reason: `Pattern '${pattern.type}' detected with count=${pattern.count}. Switching to '${rule.strategy}' strategy.`,
        confidence,
      }
    }
  }

  // Default: escalate to user
  return {
    shouldAdapt: true,
    currentStrategy: pattern.nextStrategy,
    recommendedStrategy: 'escalate_to_user',
    reason: `No matching adaptation rule for pattern '${pattern.type}'. Escalating to user.`,
    confidence: 0.3,
  }
}

/**
 * Tính toán confidence dựa trên historical data
 */
function calculateConfidence(
  strategy: AdaptationStrategy,
  historicalMetrics: AggregatedMetrics | null
): number {
  if (!historicalMetrics) {
    return 0.5 // Neutral when no data
  }

  // In a real implementation, this would check how often this strategy
  // succeeded in the past. For now, return a reasonable default.
  return 0.6
}

// ==================== ADAPTATION APPLICATION ====================

/**
 * Áp dụng chiến lược thích ứng — trả về config changes
 */
export function applyAdaptation(
  decision: AdaptationDecision
): { updatedConfig: Record<string, unknown>; logEntry: unknown } {
  const updatedConfig: Record<string, unknown> = {}

  switch (decision.recommendedStrategy) {
    case 'read_lint_rules_first':
      updatedConfig['preStep'] = 'read_lint_rules'
      break
    case 'read_api_docs':
      updatedConfig['preStep'] = 'read_api_docs'
      break
    case 'check_dev_log':
      updatedConfig['preStep'] = 'check_dev_log'
      break
    case 'change_fix_approach':
      updatedConfig['fixStrategy'] = 'refactoring' // or next in sequence
      break
    case 'compress_context':
      updatedConfig['contextAction'] = 'summarize_old'
      break
    case 'reduce_scope':
      updatedConfig['maxTokens'] = 2048 // Reduced from default
      updatedConfig['skipOptionalSteps'] = true
      break
    case 'escalate_to_user':
      updatedConfig['escalate'] = true
      updatedConfig['escalationReason'] = decision.reason
      break
    // Red Team Phase 4: siết ngưỡng từ chối KB (CONFIDENCE_THRESHOLD +0.1
    // trong 24h — tự hoàn tác). Defense in depth cho vector đang bị breach.
    case 'tighten_refusal_threshold':
      updatedConfig['confidenceThresholdDelta'] = 0.1
      updatedConfig['confidenceThresholdTtlHours'] = 24
      updatedConfig['reason'] = decision.reason
      break
  }

  const logEntry = {
    id: `adapt-${Date.now()}`,
    sessionId: 'unknown', // Will be set by caller
    patternId: null,
    fromStrategy: decision.currentStrategy,
    toStrategy: decision.recommendedStrategy,
    reason: decision.reason,
    confidence: decision.confidence,
    successful: null,
    createdAt: new Date().toISOString(),
  }

  return { updatedConfig, logEntry }
}

// ==================== PERSISTENCE ====================

/**
 * Lưu failure pattern vào DB
 */
export async function persistFailurePattern(pattern: FailurePattern): Promise<void> {
  try {
    await db.failurePattern.create({
      data: {
        id: pattern.id,
        sessionId: 'unknown', // Will be set by caller
        type: pattern.type,
        count: pattern.count,
        strategiesTried: JSON.stringify(pattern.strategiesTried),
        nextStrategy: pattern.nextStrategy,
        context: JSON.stringify(pattern.context),
        resolved: false,
      },
    })
  } catch (err) {
    console.error('[StrategyAdapter] Failed to persist failure pattern:', err)
  }
}

/**
 * Lưu strategy adaptation log vào DB
 */
export async function persistAdaptationLog(logEntry: unknown): Promise<void> {
  try {
    const entry = logEntry as {
      id: string
      sessionId: string
      patternId: string | null
      fromStrategy: string
      toStrategy: string
      reason: string
      confidence: number
      successful: boolean | null
      createdAt: string
    }

    await db.strategyAdaptationLog.create({
      data: {
        id: entry.id,
        sessionId: entry.sessionId,
        patternId: entry.patternId,
        fromStrategy: entry.fromStrategy,
        toStrategy: entry.toStrategy,
        reason: entry.reason,
        confidence: entry.confidence,
        successful: entry.successful,
        createdAt: new Date(entry.createdAt),
      },
    })
  } catch (err) {
    console.error('[StrategyAdapter] Failed to persist adaptation log:', err)
  }
}