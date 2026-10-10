/**
 * Layer 9.1: Historical Feedback
 *
 * Phân tích lịch sử execution metrics để:
 *   1. Điều chỉnh token budget cho các task tương tự trong tương lai
 *   2. Ước tính xác suất thành công dựa trên historical data
 *   3. Tổng hợp aggregated metrics từ nhiều workflow runs
 */

import { db } from '@/lib/db'
import { wilsonCI } from '@/lib/stats'
import type { AggregatedMetrics, ExecutionMetrics } from './types'

// ==================== P2-M2 · WILSON CI — HẰNG SỐ TIN CẬY ====================

/**
 * P2-M2 — ngưỡng tin cậy cho MỌI xác suất rút từ mẫu (blueprint §P2-M2):
 * consumer quyết định chỉ được tin nhóm khi n ≥ 5 ∧ (high−low) ≤ 0.5.
 * n < 5 hoặc CI rộng hơn 0.5 → phải rơi về nhánh fallback (chain fallback
 * sẵn có / base budget / neutral) — cấm act trên mẫu mỏng (vd n=5, p=0.8
 * cho CI [0.38, 0.96] — rộng gần hết dải [0,1], vô nghĩa cho quyết định).
 * Single-source: mọi consumer (getAdjustedBudget, getSuccessProbabilityWithCI,
 * rule resource_limit của strategy-adapter) đều qua 2 hằng số này.
 */
export const TRUST_MIN_N = 5
export const TRUST_MAX_CI_WIDTH = 0.5

/**
 * Nhóm xác suất có đủ bằng chứng để RA QUYẾT ĐỊNH không?
 * NaN (nhóm rỗng / dữ liệu bẩn lan toả từ wilsonCI) → false (fail-closed:
 * thiếu bằng chứng = KHÔNG act, khác với thiếu dữ liệu hoàn toàn).
 */
export function isTrustworthySuccessCI(n: number, low: number, high: number): boolean {
  return (
    Number.isFinite(n) &&
    n >= TRUST_MIN_N &&
    Number.isFinite(low) &&
    Number.isFinite(high) &&
    high - low <= TRUST_MAX_CI_WIDTH
  )
}

/**
 * P2-M2 — xác suất thành công kèm Wilson 95% CI + nguồn chuỗi fallback:
 *   taskType → routingMode → overall → neutral(0.5).
 * MỖI BẬC chỉ được dùng khi ĐỦ TIN CẬY (n ≥ 5 ∧ CI width ≤ 0.5) — bậc
 * thiếu bằng chứng bị BỎ QUA rơi tiếp xuống (khác getSuccessProbability cũ
 * trả thẳng số thô bất kể n — giữ nguyên cho 5 caller hiển thị/đối chứng).
 */
export interface SuccessProbabilityWithCI {
  p: number
  low: number
  high: number
  n: number
  source: 'taskType' | 'routingMode' | 'overall' | 'neutral'
}

/**
 * Phân tích tất cả ExecutionMetrics từ DB để tạo AggregatedMetrics
 */
export async function analyzeHistoricalFeedback(): Promise<AggregatedMetrics> {
  const allMetrics = await db.executionMetrics.findMany()

  const byTaskType: AggregatedMetrics['byTaskType'] = {}
  const byRoutingMode: AggregatedMetrics['byRoutingMode'] = {}
  const byErrorType: Record<string, number> = {}

  let totalCompletedSteps = 0
  let totalFailedSteps = 0
  let totalSteps = 0

  for (const metric of allMetrics) {
    // FIX (Layer 9.1 loop chết): điền byTaskType với key đúng format caller
    // dùng — workflow-engine.ts gọi getAdjustedBudget/getSuccessProbability
    // với taskType = `mode-${routingMode}-tier-${tier}` (vd 'mode-A-tier-1').
    // Trước đây vòng lặp này chỉ điền byRoutingMode → byTaskType LUÔN trống →
    // getAdjustedBudget rơi nhánh default base×complexity, lịch sử 100% không
    // được dùng (vòng [5] history → budget đứt hoàn toàn dù code trông đúng).
    const taskTypeKey = `mode-${metric.routingMode}-tier-${metric.tier}`
    if (!byTaskType[taskTypeKey]) {
      byTaskType[taskTypeKey] = {
        avgTokensUsed: 0,
        avgTokensBudgeted: 0,
        avgTimeSpent: 0,
        successRate: 0,
        sampleSize: 0,
        // P2-M2 — chỗ giữ; vòng Wilson post-pass ở cuối sẽ điền giá trị thật
        successCI: { low: Number.NaN, high: Number.NaN },
      }
    }
    const taskStats = byTaskType[taskTypeKey]
    taskStats.avgTokensUsed =
      (taskStats.avgTokensUsed * taskStats.sampleSize + metric.totalTokensUsed) /
      (taskStats.sampleSize + 1)
    taskStats.avgTokensBudgeted =
      (taskStats.avgTokensBudgeted * taskStats.sampleSize + metric.totalTokensBudgeted) /
      (taskStats.sampleSize + 1)
    taskStats.avgTimeSpent =
      (taskStats.avgTimeSpent * taskStats.sampleSize + metric.totalTimeSpent) /
      (taskStats.sampleSize + 1)
    taskStats.successRate =
      (taskStats.successRate * taskStats.sampleSize + metric.stepSuccessRate) /
      (taskStats.sampleSize + 1)
    taskStats.sampleSize++

    // Group by routingMode (used as proxy for task type complexity)
    const mode = metric.routingMode
    if (!byRoutingMode[mode]) {
      byRoutingMode[mode] = {
        avgTokensUsed: 0,
        avgTokensBudgeted: 0,
        avgTimeSpent: 0,
        successRate: 0,
        sampleSize: 0,
        // P2-M2 — chỗ giữ; vòng Wilson post-pass ở cuối sẽ điền giá trị thật
        successCI: { low: Number.NaN, high: Number.NaN },
      }
    }

    const modeStats = byRoutingMode[mode]
    modeStats.avgTokensUsed =
      (modeStats.avgTokensUsed * modeStats.sampleSize + metric.totalTokensUsed) /
      (modeStats.sampleSize + 1)
    modeStats.avgTokensBudgeted =
      (modeStats.avgTokensBudgeted * modeStats.sampleSize + metric.totalTokensBudgeted) /
      (modeStats.sampleSize + 1)
    modeStats.avgTimeSpent =
      (modeStats.avgTimeSpent * modeStats.sampleSize + metric.totalTimeSpent) /
      (modeStats.sampleSize + 1)
    modeStats.successRate =
      (modeStats.successRate * modeStats.sampleSize + metric.stepSuccessRate) /
      (modeStats.sampleSize + 1)
    modeStats.sampleSize++

    // Aggregate error types
    try {
      const errors = JSON.parse(metric.errorsByType) as Record<string, number>
      for (const [errorType, count] of Object.entries(errors)) {
        byErrorType[errorType] = (byErrorType[errorType] || 0) + count
      }
    } catch {
      // Ignore parse errors
    }

    totalCompletedSteps += metric.completedSteps
    totalFailedSteps += metric.failedSteps
    totalSteps += metric.totalSteps
  }

  const overallSuccessRate = totalSteps > 0 ? totalCompletedSteps / totalSteps : 0

  // P2-M2 — Wilson 95% CI cho từng nhóm + overall, tính sau khi đã có n đầy
  // đủ (một vòng duy nhất, không đụng vòng tích luỹ ở trên). Quy ước blueprint
  // §P2-M2: n của CI = sampleSize sẵn có (đơn vị quan sát = run — successRate
  // là mean stepSuccessRate/run, CI dùng xấp xỉ nhị thức trên n run).
  for (const group of [byTaskType, byRoutingMode]) {
    for (const stats of Object.values(group)) {
      stats.successCI = wilsonCI(stats.successRate, stats.sampleSize)
    }
  }
  const overallSuccessCI = wilsonCI(overallSuccessRate, allMetrics.length)

  return {
    byTaskType,
    byRoutingMode,
    byErrorType,
    overallSuccessRate,
    overallSuccessCI,
    totalRuns: allMetrics.length,
  }
}

/** Một nhóm aggregate — dạng lỏng cho guard (JS caller có thể thiếu successCI). */
interface GroupLike {
  successRate: number
  sampleSize: number
  successCI?: { low: number; high: number }
}

/** Nhóm có đủ tin cậy để RA QUYẾT ĐỊNH? (minN ≥ TRUST_MIN_N — P2-M2) */
function groupTrusted(g: GroupLike, minN: number): boolean {
  if (g.sampleSize < minN || g.sampleSize < TRUST_MIN_N) return false
  const ci = g.successCI
  if (!ci) return false // hand-built metrics thiếu CI → coi như không tin được
  return isTrustworthySuccessCI(g.sampleSize, ci.low, ci.high)
}

/**
 * Tính toán adjusted budget dựa trên historical data
 *
 * P2-M2: lịch sử chỉ được DÙNG khi nhóm đủ tin cậy (n ≥ minRunsForFeedback ∧
 * n ≥ 5 ∧ Wilson CI width ≤ 0.5) — ngược lại rơi về base×complexity (fallback
 * tổng thể sẵn có). Kiểm chứng blueprint: "mọi consumer cũ không đổi kết quả
 * khi n lớn" — nhóm n lớn có CI hẹp → giữ đúng hành vi cũ.
 */
export function getAdjustedBudget(
  taskType: string,
  complexity: number,
  historicalMetrics: AggregatedMetrics | null,
  baseBudget: number,
  minRunsForFeedback: number = 5
): number {
  // Default: use base budget with complexity multiplier
  let adjustedBudget = baseBudget * complexity

  // If we have historical data for this task type
  if (historicalMetrics?.byTaskType[taskType]) {
    const taskStats = historicalMetrics.byTaskType[taskType]

    // Need minimum sample size AND trustworthy CI for reliable feedback
    if (groupTrusted(taskStats, minRunsForFeedback)) {
      // Add 10% buffer to historical average
      adjustedBudget = taskStats.avgTokensUsed * 1.1 * complexity
    }
  }

  return Math.round(adjustedBudget)
}

/**
 * Ước tính xác suất thành công dựa trên historical data
 */
export function getSuccessProbability(
  taskType: string,
  routingMode: string,
  historicalMetrics: AggregatedMetrics | null
): number {
  if (!historicalMetrics) {
    return 0.5 // Neutral when no data
  }

  // Check specific (taskType, routingMode) combination
  if (historicalMetrics.byTaskType[taskType]) {
    return historicalMetrics.byTaskType[taskType].successRate
  }

  // Fall back to routingMode average
  if (historicalMetrics.byRoutingMode[routingMode]) {
    return historicalMetrics.byRoutingMode[routingMode].successRate
  }

  // Fall back to overall average
  if (historicalMetrics.totalRuns > 0) {
    return historicalMetrics.overallSuccessRate
  }

  return 0.5 // Neutral when no specific data
}

/**
 * P2-M2 — Ước tính xác suất thành công KÈM Wilson 95% CI, có guard bằng
 * chứng ở mỗi bậc chuỗi fallback (xây cùng nguồn dữ liệu với
 * getSuccessProbability — kết quả p GIỐNG HỆT khi nhóm đạt ngưỡng tin cậy).
 *
 * Chuỗi: (taskType) → (routingMode) → overall → neutral — bậc nào thiếu n
 * hoặc CI rộng (> 0.5) bị bỏ qua, rơi tiếp xuống bậc tổng quát hơn.
 */
export function getSuccessProbabilityWithCI(
  taskType: string,
  routingMode: string,
  historicalMetrics: AggregatedMetrics | null
): SuccessProbabilityWithCI {
  if (!historicalMetrics) {
    return { p: 0.5, low: Number.NaN, high: Number.NaN, n: 0, source: 'neutral' }
  }

  // Check specific (taskType, routingMode) combination
  const taskStats = historicalMetrics.byTaskType[taskType]
  if (taskStats && groupTrusted(taskStats, TRUST_MIN_N)) {
    return {
      p: taskStats.successRate,
      low: taskStats.successCI.low,
      high: taskStats.successCI.high,
      n: taskStats.sampleSize,
      source: 'taskType',
    }
  }

  // Fall back to routingMode average
  const modeStats = historicalMetrics.byRoutingMode[routingMode]
  if (modeStats && groupTrusted(modeStats, TRUST_MIN_N)) {
    return {
      p: modeStats.successRate,
      low: modeStats.successCI.low,
      high: modeStats.successCI.high,
      n: modeStats.sampleSize,
      source: 'routingMode',
    }
  }

  // Fall back to overall average
  if (
    historicalMetrics.totalRuns > 0 &&
    isTrustworthySuccessCI(
      historicalMetrics.totalRuns,
      historicalMetrics.overallSuccessCI?.low ?? Number.NaN,
      historicalMetrics.overallSuccessCI?.high ?? Number.NaN,
    )
  ) {
    return {
      p: historicalMetrics.overallSuccessRate,
      low: historicalMetrics.overallSuccessCI.low,
      high: historicalMetrics.overallSuccessCI.high,
      n: historicalMetrics.totalRuns,
      source: 'overall',
    }
  }

  // Không bậc nào đủ bằng chứng → trung tính (consumer không được act trên số này)
  return { p: 0.5, low: Number.NaN, high: Number.NaN, n: 0, source: 'neutral' }
}