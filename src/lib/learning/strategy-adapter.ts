/**
 * Layer 9.2: Strategy Adapter
 *
 * Phát hiện pattern thất bại và đề xuất/áp dụng chiến lược thích ứng.
 * Khi approach hiện tại không hiệu quả, tự động chuyển sang approach khác
 * dựa trên historical data và predefined rules.
 *
 * Task 17-b — auto-apply CONSERVATIVE: getFailureHintsForAgent() chưng cất
 * FailurePattern lịch sử thành hints ngắn để inject vào system prompt của
 * Code Team agents (KHÔNG tự đổi model/tools/config — chỉ nhắc nhở bằng prompt).
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
  // ━━━ ROUND-38 fix F3 — 3 rule mới: trước đây chỉ 3/8 chiến lược productions
  // -reachable (read_api_docs/check_dev_log không có rule nào; compress_context
  // cần pattern.type='timeout' mà detect KHÔNG BAO GIỜ emit). Giờ phân hoá theo
  // errorType (classifyWorkflowError taxonomy) do caller đính kèm vào context:
  //   • systematic_parse (JSON/syntax/format sai) → đoán interface → read_api_docs
  //   • transient_network (timeout/network — context phình làm chậm) → compress_context
  //   • runtime (không phân loại được — chẩn đoán thiếu log đầy đủ) → check_dev_log
  {
    condition: (pattern) =>
      pattern.type === 'repeated_error' &&
      pattern.count >= 2 &&
      pattern.context?.errorType === 'systematic_parse',
    strategy: 'read_api_docs',
    priority: 78,
  },
  {
    condition: (pattern) =>
      pattern.type === 'repeated_error' &&
      pattern.count >= 2 &&
      pattern.context?.errorType === 'transient_network',
    strategy: 'compress_context',
    priority: 75,
  },
  {
    condition: (pattern) =>
      pattern.type === 'repeated_error' &&
      pattern.count >= 2 &&
      pattern.context?.errorType === 'runtime',
    strategy: 'check_dev_log',
    priority: 72,
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
 * Lưu failure pattern vào DB.
 *
 * FIX (Layer 9.2 dead-end): trước đây LUÔN `create` row mới với count cố định
 * (workflow-engine detect với previousErrors=[] → luôn null → không persist;
 * redteam breach create count=1 mỗi lần) — FailurePattern không bao giờ có
 * row nào đạt ngưỡng count>=2 của getFailureHintsForAgent → hints "bài học
 * từ thất bại" LUÔN rỗng, rule tighten_refusal_threshold không bao giờ fire.
 *
 * Giờ: UPSERT theo (type + sessionId + stepType) unresolved — mỗi lần gọi
 * = 1 occurrence event → count cộng dồn 1. Trả về count mới sau persist
 * (0 khi lỗi — caller fail-open).
 */
export async function persistFailurePattern(pattern: FailurePattern): Promise<number> {
  try {
    const ctx = pattern.context as { sessionId?: string; stepType?: string } | null
    const sessionId =
      typeof ctx?.sessionId === 'string' && ctx.sessionId ? ctx.sessionId : 'unknown'
    const stepType =
      typeof ctx?.stepType === 'string' && ctx.stepType ? ctx.stepType : 'unknown'

    const existing = await db.failurePattern.findFirst({
      where: {
        type: pattern.type,
        sessionId,
        resolved: false,
        ...(stepType !== 'unknown' ? { context: { contains: `"stepType":"${stepType}"` } } : {}),
      },
      orderBy: { count: 'desc' },
    })

    if (existing) {
      // Cộng dồn — row cũ giữ id, count tăng (pattern lặp = càng nghiêm trọng)
      const previousStrategies = safeParseJsonArray(existing.strategiesTried)
      const updated = await db.failurePattern.update({
        where: { id: existing.id },
        data: {
          count: existing.count + 1,
          strategiesTried: JSON.stringify(
            Array.from(new Set([...previousStrategies, ...(pattern.strategiesTried ?? [])]))
          ),
          nextStrategy: pattern.nextStrategy,
          context: JSON.stringify(pattern.context),
        },
      })
      return updated.count
    }

    await db.failurePattern.create({
      data: {
        id: pattern.id,
        sessionId,
        type: pattern.type,
        count: Math.max(1, pattern.count || 1),
        strategiesTried: JSON.stringify(pattern.strategiesTried ?? []),
        nextStrategy: pattern.nextStrategy,
        context: JSON.stringify(pattern.context),
        resolved: false,
      },
    })
    return Math.max(1, pattern.count || 1)
  } catch (err) {
    console.error('[StrategyAdapter] Failed to persist failure pattern:', err)
    return 0
  }
}

/** Parse JSON array string an toàn (fallback [] — cột strategiesTried) */
function safeParseJsonArray(json: string): string[] {
  try {
    const v = JSON.parse(json)
    return Array.isArray(v) ? v.map(String) : []
  } catch {
    return []
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

// ==================== CONSERVATIVE AUTO-APPLY — PROMPT HINTS (Task 17-b) ====================

/** Cache in-memory cho hints (per agent) — chống spam DB mỗi agent step (60s) */
const HINTS_CACHE_TTL_MS = 60_000

/** Timeout guard cho DB query — vượt ngưỡng thì fail-open trả [] */
const HINTS_QUERY_TIMEOUT_MS = 3_000

/** Số hints tối đa trả về cho 1 agent */
const MAX_HINTS = 3

/** Độ dài tối đa 1 hint (ký tự) */
const MAX_HINT_CHARS = 200

const PATTERN_TYPE_LABELS: Record<string, string> = {
  repeated_error: 'Lỗi lặp lại',
  approach_exhausted: 'Đã cạn kiệt cách làm hiện tại',
  resource_limit: 'Vượt giới hạn tài nguyên (token/time)',
  timeout: 'Timeout kéo dài',
  redteam_breach: 'Vector tấn công bị breach (red team)',
}

const STRATEGY_LABELS: Record<string, string> = {
  read_lint_rules_first: 'đọc kỹ lint rules/cấu hình dự án TRƯỚC khi sửa',
  read_api_docs: 'đọc API docs thật thay vì đoán interface',
  check_dev_log: 'kiểm tra dev.log thay vì chỉ đọc error message',
  change_fix_approach: 'đổi cách fix (surgical → refactoring → redesign)',
  compress_context: 'nén/tóm tắt context thay vì đọc thêm dữ liệu',
  reduce_scope: 'giảm scope, chia nhỏ task',
  escalate_to_user: 'hỏi user khi đã thử ≥3 cách',
  tighten_refusal_threshold: 'siết ngưỡng từ chối tạm thời',
}

/** Cache sống qua dev hot-reload (pattern globalThis của codebase) */
const globalForHints = globalThis as unknown as {
  __layer9HintsCache?: Map<string, { hints: string[]; expiresAt: number }>
}

/**
 * Task 17-b — Lấy "bài học từ thất bại trước" cho agent, dùng để inject vào
 * system prompt của Code Team (workflow-engine.ts runAgentStep).
 *
 * Lưu ý schema: FailurePattern KHÔNG có field agent (chỉ sessionId) và KHÔNG có
 * createdAt (schema có sẵn — không được sửa) → hints là bài học CHUNG, ưu tiên
 * theo count (pattern lặp nhiều nhất), không lọc recency trong SQL được.
 *
 * Lọc: pattern chưa resolved, lặp ≥2 lần (count).
 * Trả về tối đa 3 hints tiếng Việt ≤200 ký tự, dạng:
 *   "⚠ Bài học: <pattern> → khuyến nghị: <recommendation>"
 *
 * Fail-open tuyệt đối: lỗi DB/timeout → trả [] (workflow chạy như thường).
 */
export async function getFailureHintsForAgent(agentName: string): Promise<string[]> {
  try {
    // 1) Cache check — cache CẢ kết quả rỗng (bảng 0 rows không spam DB)
    const cache = (globalForHints.__layer9HintsCache ??= new Map())
    const cached = cache.get(agentName)
    if (cached && cached.expiresAt > Date.now()) {
      return cached.hints
    }

    // 2) Query unresolved patterns — timeout guard (Promise.race).
    // Model FailurePattern KHÔNG có createdAt → không lọc recency trong SQL;
    // order by count desc để ưu tiên pattern lặp nhiều nhất (nghiêm trọng nhất).
    let timer: ReturnType<typeof setTimeout> | undefined
    const patterns = await Promise.race([
      db.failurePattern.findMany({
        where: {
          resolved: false,
          count: { gte: 2 }, // lặp ≥2 lần mới đáng làm "bài học"
        },
        orderBy: [{ count: 'desc' }],
        take: 20,
        select: { type: true, count: true, nextStrategy: true, context: true },
      }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Layer 9 hints query timed out after ${HINTS_QUERY_TIMEOUT_MS}ms`)),
          HINTS_QUERY_TIMEOUT_MS,
        )
      }),
    ]).finally(() => {
      if (timer) clearTimeout(timer)
    })

    // 3) Dedupe theo type (giữ count cao nhất) — tránh các hint trùng nội dung
    const byType = new Map<string, { count: number; nextStrategy: string; stepType: string }>()
    for (const p of patterns) {
      let stepType = ''
      try {
        const ctx = JSON.parse(p.context || '{}') as { stepType?: unknown }
        stepType = typeof ctx.stepType === 'string' ? ctx.stepType : ''
      } catch {
        // context JSON hỏng — bỏ qua stepType (hint vẫn dùng được)
      }
      const existing = byType.get(p.type)
      if (!existing || p.count > existing.count) {
        byType.set(p.type, { count: p.count, nextStrategy: p.nextStrategy, stepType })
      }
    }

    // 4) Build hints — ưu tiên pattern lặp nhiều nhất, ≤3 hints, ≤200 ký tự
    const hints = [...byType.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, MAX_HINTS)
      .map(([type, info]) => {
        const patternLabel = PATTERN_TYPE_LABELS[type] || `Pattern thất bại (${type})`
        const strategyLabel = STRATEGY_LABELS[info.nextStrategy] || info.nextStrategy || 'đổi cách tiếp cận'
        const stepLabel = info.stepType ? ` ở bước ${formatStepLabel(info.stepType)}` : ''
        return `⚠ Bài học: ${patternLabel}${stepLabel} (x${info.count} lần gần đây) → khuyến nghị: ${strategyLabel}`.slice(
          0,
          MAX_HINT_CHARS,
        )
      })

    // 5) Cache (TTL 60s) + trả về
    cache.set(agentName, { hints, expiresAt: Date.now() + HINTS_CACHE_TTL_MS })
    return hints
  } catch {
    // Fail-open tuyệt đối — không hints, workflow chạy như thường
    return []
  }
}

/** "G2-B-review" → "G2-B/review" (stepType có format `${position}-${step}`) */
function formatStepLabel(stepType: string): string {
  const dashIdx = stepType.indexOf('-')
  return dashIdx > 0 ? `${stepType.slice(0, dashIdx)}/${stepType.slice(dashIdx + 1)}` : stepType
}