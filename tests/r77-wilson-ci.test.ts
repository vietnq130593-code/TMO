/**
 * ROUND-77 TESTS — P2-M2 WILSON CI CHO MỌI XÁC SUẤT RÚT TỪ MẪU
 * (BLUEPRINT-STATS-LEARNING-P0-P6 §P2-M2, mục #10)
 *
 * Đo lường:
 *   - wilsonCI (P0, neo gốc đã test r76) qua lăng kính consumer: n=5, p=0.8
 *     → CI [0.3755, 0.9638] — RỘNG GẦN HẾT DẢI → chứng minh cấm act trên
 *     5 mẫu (ví dụ chính của blueprint).
 *   - isTrustworthySuccessCI: n ≥ 5 ∧ (high−low) ≤ 0.5 — mọi tổ hợp biên.
 *   - getSuccessProbabilityWithCI: chuỗi fallback taskType → routingMode →
 *     overall → neutral, MỖI bậc có guard bằng chứng (bậc mỏng bị bỏ qua).
 *   - getAdjustedBudget: lịch sử chỉ dùng khi nhóm tin cậy được — ngược lại
 *     rơi về base×complexity (kiểm chứng blueprint "consumer cũ không đổi
 *     kết quả khi n lớn": CI hẹp + n lớn → giữ đúng 5000×1.1).
 *   - analyzeHistoricalFeedback: successCI/overallSuccessCI được tính đúng
 *     công thức Wilson trên seed DB.
 *   - recommendAdaptation rule resource_limit: chỉ fire khi overall đủ
 *     bằng chứng (P2-M2 guard).
 *
 * Nguyên tắc test:
 * - DB-cô-lập (bunfig preload copy DB): WIPE ExecutionMetrics trong bản copy
 *   trước khi seed — production copy không được phép làm bẩn nhóm.
 * - Mọi expected DẪN NGUỒN ĐƯỢC (comment công thức) — tính tay độc lập.
 *
 * Số liệuWilson tính tay (z=1.96, công thức (p̂+z²/2n ± z·√(p̂(1−p̂)/n+z²/4n²))/(1+z²/n)):
 *   wilsonCI(0.8, 5):  denom = 1+3.8416/5 = 1.76832
 *     center = (0.8+3.8416/10)/1.76832 = 1.18416/1.76832 = 0.669658…
 *     half   = 1.96·√(0.8·0.2/5 + 3.8416/100)/1.76832
 *            = 1.96·√(0.032+0.038416)/1.76832 = 1.96·0.265362…/1.76832 = 0.294168…
 *     → [0.375528, 0.963777] (width 0.588 > 0.5 → KHÔNG tin cậy)
 *   wilsonCI(0.8, 10): denom = 1.38416; center = 0.99208/1.38416 = 0.716738…
 *     half = 1.96·√(0.016+0.009604)/1.38416 = 0.313625/1.38416 = 0.226581…
 *     → [0.490157, 0.943319] (width 0.4532 ≤ 0.5 → TIN CẬY)
 *     (đối chiếu script công thức độc lập + tính tay — không import module)
 */

import { describe, test, expect, beforeAll } from 'bun:test'
import { db } from '@/lib/db'
import { wilsonCI } from '@/lib/stats'
import {
  analyzeHistoricalFeedback,
  getAdjustedBudget,
  getSuccessProbability,
  getSuccessProbabilityWithCI,
  isTrustworthySuccessCI,
  TRUST_MIN_N,
  TRUST_MAX_CI_WIDTH,
} from '@/lib/learning/historical-feedback'
import { recommendAdaptation } from '@/lib/learning/strategy-adapter'
import type { AggregatedMetrics, FailurePattern } from '@/lib/learning/types'

// ==================== wilsonCI + guard (thuần) ====================

describe('r77 · P2-M2 wilsonCI qua lăng kính consumer', () => {
  test('ví dụ blueprint: n=5, p=0.8 → CI rộng ~[0.38, 0.96] — cấm act', () => {
    const ci = wilsonCI(0.8, 5)
    // [0.375490, 0.963826] — làm tròn 2 số lẻ: [0.38, 0.96] đúng blueprint
    expect(ci.low).toBeGreaterThan(0.37)
    expect(ci.low).toBeLessThan(0.39)
    expect(ci.high).toBeGreaterThan(0.95)
    expect(ci.high).toBeLessThan(0.97)
    // width 0.588… > 0.5 → guard PHẢI chặn
    expect(ci.high - ci.low).toBeGreaterThan(0.5)
    expect(isTrustworthySuccessCI(5, ci.low, ci.high)).toBe(false)
  })

  test('n=10, p=0.8 → CI [0.490, 0.943] width 0.453 ≤ 0.5 → tin cậy được', () => {
    const ci = wilsonCI(0.8, 10)
    expect(ci.low).toBeCloseTo(0.490157, 5)
    expect(ci.high).toBeCloseTo(0.943319, 5)
    expect(ci.high - ci.low).toBeLessThanOrEqual(0.5)
    expect(isTrustworthySuccessCI(10, ci.low, ci.high)).toBe(true)
  })

  test('isTrustworthySuccessCI — mọi biên: n, width, NaN', () => {
    // hằng số đúng blueprint: n ≥ 5 ∧ width ≤ 0.5
    expect(TRUST_MIN_N).toBe(5)
    expect(TRUST_MAX_CI_WIDTH).toBe(0.5)
    // n đủ nhưng width rộng → chặn
    expect(isTrustworthySuccessCI(10, 0.1, 0.95)).toBe(false)
    // width hẹp nhưng n < 5 → chặn
    expect(isTrustworthySuccessCI(4, 0.7, 0.9)).toBe(false)
    // biên đúng ngưỡng: n=5, width đúng 0.5 → ĐẠT (≥ và ≤)
    expect(isTrustworthySuccessCI(5, 0.25, 0.75)).toBe(true)
    // NaN (nhóm rỗng / dữ liệu bẩn) → fail-closed
    expect(isTrustworthySuccessCI(10, Number.NaN, 0.9)).toBe(false)
    expect(isTrustworthySuccessCI(10, 0.6, Number.NaN)).toBe(false)
    expect(isTrustworthySuccessCI(Number.NaN, 0.6, 0.9)).toBe(false)
  })
})

// ==================== getSuccessProbabilityWithCI — chuỗi fallback có guard ====================

/** Dựng AggregatedMetrics tay — mọi CI hẹp (width 0.3) trừ khi ghi đè. */
function makeMetrics(overrides?: {
  taskType?: { n: number; ci?: { low: number; high: number } }
  routingMode?: { n: number; ci?: { low: number; high: number } }
  overall?: { n: number; ci?: { low: number; high: number } }
}): AggregatedMetrics {
  const t = overrides?.taskType
  const m = overrides?.routingMode
  const o = overrides?.overall
  return {
    byTaskType: {
      'mode-A-tier-1': {
        avgTokensUsed: 5000,
        avgTokensBudgeted: 10000,
        avgTimeSpent: 10000,
        successRate: 0.8,
        sampleSize: t?.n ?? 10,
        successCI: t?.ci ?? { low: 0.65, high: 0.95 },
      },
    },
    byRoutingMode: {
      A: {
        avgTokensUsed: 6000,
        avgTokensBudgeted: 10000,
        avgTimeSpent: 10000,
        successRate: 0.7,
        sampleSize: m?.n ?? 10,
        successCI: m?.ci ?? { low: 0.55, high: 0.85 },
      },
    },
    byErrorType: {},
    overallSuccessRate: 0.6,
    overallSuccessCI: o?.ci ?? { low: 0.45, high: 0.75 },
    totalRuns: o?.n ?? 10,
  }
}

describe('r77 · P2-M2 getSuccessProbabilityWithCI — chuỗi fallback', () => {
  test('null metrics → neutral 0.5, n=0, KHÔNG có CI', () => {
    const r = getSuccessProbabilityWithCI('mode-A-tier-1', 'A', null)
    expect(r).toEqual({ p: 0.5, low: Number.NaN, high: Number.NaN, n: 0, source: 'neutral' })
  })

  test('taskType tin cậy được → dùng thẳng bậc 1 (giá trị GIỐNG hàm cũ)', () => {
    const metrics = makeMetrics()
    const r = getSuccessProbabilityWithCI('mode-A-tier-1', 'A', metrics)
    expect(r.source).toBe('taskType')
    expect(r.p).toBe(0.8)
    expect(r.n).toBe(10)
    expect(r.low).toBe(0.65)
    expect(r.high).toBe(0.95)
    // Kiểm chứng blueprint: hàm cũ KHÔNG đổi kết quả khi n lớn
    expect(getSuccessProbability('mode-A-tier-1', 'A', metrics)).toBe(r.p)
  })

  test('taskType n=4 (mỏng) → bỏ qua, dùng routingMode', () => {
    const r = getSuccessProbabilityWithCI(
      'mode-A-tier-1',
      'A',
      makeMetrics({ taskType: { n: 4 }, routingMode: { n: 10 } }),
    )
    expect(r.source).toBe('routingMode')
    expect(r.p).toBe(0.7)
    expect(r.n).toBe(10)
  })

  test('taskType CI rộng (width 0.86 > 0.5) → bỏ qua dù n=10, dùng routingMode', () => {
    const r = getSuccessProbabilityWithCI(
      'mode-A-tier-1',
      'A',
      makeMetrics({ taskType: { n: 10, ci: { low: 0.05, high: 0.91 } }, routingMode: { n: 10 } }),
    )
    expect(r.source).toBe('routingMode')
  })

  test('taskType + routingMode đều mỏng → overall (n đủ, CI hẹp)', () => {
    const r = getSuccessProbabilityWithCI(
      'mode-A-tier-1',
      'A',
      makeMetrics({ taskType: { n: 3 }, routingMode: { n: 3 }, overall: { n: 20 } }),
    )
    expect(r.source).toBe('overall')
    expect(r.p).toBe(0.6)
    expect(r.n).toBe(20)
  })

  test('CẢ 3 bậc thiếu bằng chứng → neutral 0.5 (không được act)', () => {
    const r = getSuccessProbabilityWithCI(
      'mode-A-tier-1',
      'A',
      makeMetrics({
        taskType: { n: 3 },
        routingMode: { n: 3 },
        overall: { n: 3, ci: { low: 0.1, high: 0.9 } },
      }),
    )
    expect(r).toEqual({ p: 0.5, low: Number.NaN, high: Number.NaN, n: 0, source: 'neutral' })
  })

  test('taskType vắng mặt (key lạ) → routingMode → đúng bậc 2', () => {
    const r = getSuccessProbabilityWithCI('mode-Z-tier-9', 'A', makeMetrics())
    expect(r.source).toBe('routingMode')
  })
})

// ==================== getAdjustedBudget — guard CI ====================

describe('r77 · P2-M2 getAdjustedBudget — chỉ tin lịch sử khi CI hẹp', () => {
  test('n=10 + CI hẹp → dùng lịch sử (hành vi cũ bảo toàn khi n lớn)', () => {
    const budget = getAdjustedBudget('mode-A-tier-1', 1, makeMetrics(), 10000)
    expect(budget).toBe(5500) // 5000 × 1.1 × 1
  })

  test('n=10 nhưng CI rộng 0.86 → KHÔNG dùng lịch sử, rơi base×complexity', () => {
    const metrics = makeMetrics({ taskType: { n: 10, ci: { low: 0.05, high: 0.91 } } })
    const budget = getAdjustedBudget('mode-A-tier-1', 2, metrics, 10000)
    expect(budget).toBe(20000) // 10000 × 2 — fallback tổng thể
  })

  test('n=4 (dưới minRunsForFeedback) → base×complexity (giữ hành vi cũ)', () => {
    const metrics = makeMetrics({ taskType: { n: 4 } })
    const budget = getAdjustedBudget('mode-A-tier-1', 1, metrics, 10000)
    expect(budget).toBe(10000)
  })

  test('thiếu successCI (hand-built JS) → fail-closed về base×complexity', () => {
    const metrics = makeMetrics() as unknown as {
      byTaskType: Record<string, Record<string, unknown>>
    }
    delete metrics.byTaskType['mode-A-tier-1'].successCI
    const budget = getAdjustedBudget('mode-A-tier-1', 1, metrics as unknown as AggregatedMetrics, 10000)
    expect(budget).toBe(10000)
  })
})

// ==================== analyzeHistoricalFeedback — CI trên seed DB ====================

describe('r77 · P2-M2 analyzeHistoricalFeedback — Wilson CI khi aggregate', () => {
  beforeAll(async () => {
    // WIPE trong bản copy cô lập — nhóm phải deterministic theo seed
    await db.executionMetrics.deleteMany({})
  })

  test('successCI/overallSuccessCI khớp công thức Wilson trên seed', async () => {
    // 3 run cùng nhóm mode-A-tier-1 / mode A — stepSuccessRate 1.0, 1.0, 0.5
    // với completedSteps NHẤT QUÁN (4/4, 4/4, 2/4):
    //   group successRate = (1+1+0.5)/3 = 0.8333…, n=3
    //   overall = (4+4+2)/(4+4+4) = 10/12 = 0.8333…, n=totalRuns=3
    const seedRates: Array<[number, number]> = [
      [1.0, 4],
      [1.0, 4],
      [0.5, 2],
    ]
    for (const [i, [stepSuccessRate, completedSteps]] of seedRates.entries()) {
      await db.executionMetrics.create({
        data: {
          sessionId: `r77-wilson-${i}`,
          planId: 'r77-plan',
          routingMode: 'A',
          tier: 1,
          totalSteps: 4,
          completedSteps,
          failedSteps: 4 - completedSteps,
          totalTokensUsed: 5000,
          totalTokensBudgeted: 8000,
          totalTimeSpent: 60000,
          errorsByType: '{}',
          stepSuccessRate,
          tokenEfficiency: 0.625,
        },
      })
    }
    const agg = await analyzeHistoricalFeedback()
    expect(agg.totalRuns).toBe(3)

    const g = agg.byTaskType['mode-A-tier-1']
    expect(g).toBeDefined()
    expect(g.sampleSize).toBe(3)
    expect(g.successRate).toBeCloseTo(0.833333, 4)
    // Wilson(0.8333, 3) — đối chiếu trực tiếp công thức P0 (độc lập phần consumer)
    const expectCI = wilsonCI(0.8333333333333334, 3)
    expect(g.successCI.low).toBeCloseTo(expectCI.low, 10)
    expect(g.successCI.high).toBeCloseTo(expectCI.high, 10)
    // n=3 < 5 → nhóm KHÔNG tin cậy được (đúng chủ đích ví dụ mỏng)
    expect(isTrustworthySuccessCI(g.sampleSize, g.successCI.low, g.successCI.high)).toBe(false)

    const mode = agg.byRoutingMode['A']
    expect(mode.sampleSize).toBe(3)
    expect(mode.successCI.low).toBeCloseTo(expectCI.low, 10)

    // overall = 10/12 = 0.8333, n=totalRuns=3
    expect(agg.overallSuccessRate).toBeCloseTo(0.833333, 4)
    const expectOverall = wilsonCI(0.8333333333333334, 3)
    expect(agg.overallSuccessCI.low).toBeCloseTo(expectOverall.low, 10)
    expect(agg.overallSuccessCI.high).toBeCloseTo(expectOverall.high, 10)
  })

  test('WithCI trên chính seed này: 3 bậc đều n=3 → neutral', async () => {
    const agg = await analyzeHistoricalFeedback()
    const r = getSuccessProbabilityWithCI('mode-A-tier-1', 'A', agg)
    expect(r.source).toBe('neutral')
    expect(r.p).toBe(0.5)
    // Đối chứng: hàm cũ vẫn trả số thô (0.8333) — khác biệt là có chủ đích
    expect(getSuccessProbability('mode-A-tier-1', 'A', agg)).toBeCloseTo(0.833333, 4)
  })

  test('bảng trống → CI NaN, totalRuns=0 (fail-open như cũ)', async () => {
    await db.executionMetrics.deleteMany({})
    const agg = await analyzeHistoricalFeedback()
    expect(agg.totalRuns).toBe(0)
    expect(agg.overallSuccessRate).toBe(0)
    expect(Number.isNaN(agg.overallSuccessCI.low)).toBe(true)
    expect(agg.byTaskType).toEqual({})
  })
})

// ==================== recommendAdaptation — guard CI rule resource_limit ====================

/** FailurePattern resource_limit đúng shape types.ts */
function resourceLimitPattern(): FailurePattern {
  return {
    id: 'r77-pattern',
    type: 'resource_limit',
    count: 1,
    lastOccurrence: new Date().toISOString(),
    strategiesTried: [],
    nextStrategy: 'reduce_scope',
    context: { taskType: 'unknown', routingMode: 'unknown', stepType: 'unknown' },
  }
}

describe('r77 · P2-M2 recommendAdaptation — rule resource_limit có guard CI', () => {
  test('overall mỏng (n=3) → KHÔNG reduce_scope, escalate thay thế', () => {
    const metrics = makeMetrics({
      taskType: { n: 3 },
      routingMode: { n: 3 },
      overall: { n: 3, ci: { low: 0.05, high: 0.55 } }, // width 0.5 đạt nhưng n=3
    })
    const d = recommendAdaptation(resourceLimitPattern(), metrics)
    expect(d.recommendedStrategy).not.toBe('reduce_scope')
    expect(d.recommendedStrategy).toBe('escalate_to_user')
  })

  test('overall đủ bằng chứng (n=10, CI hẹp) + rate < 0.3 → reduce_scope fire', () => {
    // rate 0.2 < 0.3, n=10, CI [0.05, 0.45] width 0.4 ≤ 0.5 → đủ tin
    const metrics = makeMetrics({
      taskType: { n: 3 },
      routingMode: { n: 3 },
      overall: { n: 10, ci: { low: 0.05, high: 0.45 } },
    })
    metrics.overallSuccessRate = 0.2
    const d = recommendAdaptation(resourceLimitPattern(), metrics)
    expect(d.recommendedStrategy).toBe('reduce_scope')
  })

  test('rate < 0.3 nhưng CI rộng (width 0.85) → KHÔNG fire (cấm act trên số mỏng)', () => {
    const metrics = makeMetrics({
      taskType: { n: 3 },
      routingMode: { n: 3 },
      overall: { n: 10, ci: { low: 0.05, high: 0.9 } },
    })
    metrics.overallSuccessRate = 0.2
    const d = recommendAdaptation(resourceLimitPattern(), metrics)
    expect(d.recommendedStrategy).not.toBe('reduce_scope')
  })

  test('rate ≥ 0.3 → rule không fire bất kể CI (điều kiện gốc giữ nguyên)', () => {
    const metrics = makeMetrics({ overall: { n: 10, ci: { low: 0.45, high: 0.75 } } })
    metrics.overallSuccessRate = 0.6
    const d = recommendAdaptation(resourceLimitPattern(), metrics)
    expect(d.recommendedStrategy).not.toBe('reduce_scope')
  })
})
