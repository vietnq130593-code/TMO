/**
 * ROUND-77 TESTS — P4-M1 WELCH-T / χ² / FISHER GATE CHO ADAPTATION
 * (BLUEPRINT-STATS-LEARNING-P0-P6 §P4-M1, mục #8 — MATH.pdf §Hypothesis Testing)
 *
 * Đo lường:
 *   A. evaluateAdaptationEvidence (thuần) — kịch bản kiểm chứng spec:
 *      trước=[T,T,F,F] sau=[T,T,T,T] n=4 → insufficient (giữ cũ); n=30 mỗi
 *      nhóm sau tốt hơn rõ → chi2 p<0.05 pass; sau tệ hơn → block; tỉ lệ
 *      bằng nhau → p=1 block; nhánh Fisher khi expected < 5 (đặt tên +
 *      p đúng hướng one-sided); suy biến 100%-vs-100% → p=1 block (không có
 *      bằng chứng cải thiện). Đối chiếu chéo p với stats/inference (χ²:
 *      one-sided = two-sided/2; fisher: dùng thẳng).
 *   B. isAdaptationStatsGateBlocking — env parse (default OFF log-only;
 *      on/1/true/ON/'  on  ' → true; rỗng/off/garbage → false — quy ước
 *      FB-Đợt5-R2-01: env rỗng = unset).
 *   C. applyAdaptationToSession + statsGate — gate OFF (mặc định): pass=false
 *      vẫn apply (log-only); gate ON + pass=false → chặn (null + store
 *      trống); gate ON + pass=true / insufficient → apply; không truyền
 *      gate → hành vi cũ.
 *   D. evaluateAdaptationGateForPair (DB cô lập) — gom before/after từ
 *      StrategyAdaptationLog (successful != null) theo toStrategy; row
 *      successful=null không đếm; chưa có tiền sử → insufficient nA=0
 *      nB=0; Welch-t bổ trợ cycles từ AgentRunRecord (mới nhất mỗi
 *      session); persistAdaptationStatsJson round-trip statsJson.
 *   E. evaluateContinuousEvidence — n<2 → null; lọc không-hữu-hạn; hai
 *      nhóm hằng bằng nhau → t=0 p=1.
 *
 * DB-cô-lập (bunfig preload copy DB) — beforeAll wipe 2 bảng liên quan.
 */

import { describe, test, expect, beforeAll, afterEach } from 'bun:test'
import { db } from '@/lib/db'
import {
  evaluateAdaptationEvidence,
  evaluateContinuousEvidence,
  isAdaptationStatsGateBlocking,
  evaluateAdaptationGateForPair,
  persistAdaptationStatsJson,
  ADAPTATION_STATS_MIN_SAMPLE,
} from '@/lib/learning/adaptation-stats'
import { chiSquare2x2 } from '@/lib/stats'
import {
  applyAdaptationToSession,
  __resetAdaptationStoreForTest,
  __peekSessionAdaptation,
} from '@/lib/learning/adaptation-engine'
import type { AdaptationDecision } from '@/lib/learning/types'

// ==================== HELPERS ====================

/** Bộ boolean từ số lần true/false (thứ tự không đổi kết quả — đếm) */
function bools(nTrue: number, nFalse: number): boolean[] {
  return [...Array(nTrue).fill(true), ...Array(nFalse).fill(false)]
}

function decision(strategy: string): AdaptationDecision {
  return {
    shouldAdapt: true,
    currentStrategy: 'previous',
    recommendedStrategy: strategy as AdaptationDecision['recommendedStrategy'],
    reason: `test ${strategy}`,
    confidence: 0.8,
  }
}

const PREV_GATE_ENV = process.env.ADAPTATION_STATS_GATE

afterEach(() => {
  if (PREV_GATE_ENV === undefined) delete process.env.ADAPTATION_STATS_GATE
  else process.env.ADAPTATION_STATS_GATE = PREV_GATE_ENV
  __resetAdaptationStoreForTest()
})

beforeAll(async () => {
  await db.strategyAdaptationLog.deleteMany({})
  await db.agentRunRecord.deleteMany({})
})

// ==================== A. evaluateAdaptationEvidence (thuần) ====================

describe('A. evaluateAdaptationEvidence — cổng thuần', () => {
  test('kiểm chứng spec 1: n=4 mỗi nhóm → insufficient giữ hành vi cũ', () => {
    const d = evaluateAdaptationEvidence([true, true, false, false], [true, true, true, true])
    expect(d.pass).toBe(true)
    expect(d.test).toBe('insufficient')
    expect(d.p).toBeNull()
    expect(d.nA).toBe(4)
    expect(d.nB).toBe(4)
    expect(d.reason).toContain('n chưa đủ')
  })

  test('một nhóm dưới minSample (10) → insufficient', () => {
    const d = evaluateAdaptationEvidence(bools(10, 0), bools(3, 1))
    expect(d.test).toBe('insufficient')
    expect(d.pass).toBe(true)
    expect(ADAPTATION_STATS_MIN_SAMPLE).toBe(10)
  })

  test('kiểm chứng spec 2: n=30 mỗi nhóm, sau tốt hơn rõ → chi2 pass (p one-sided ≈ 0.015)', () => {
    // trước 15/30, sau 24/30 — tay: χ²Yates = 60·(270−30)²/(30·30·39·21) ≈ 4.688
    // → z=√χ²≈2.165 → one-sided = 1−Φ(2.165) ≈ 0.0152 < 0.05
    const d = evaluateAdaptationEvidence(bools(15, 15), bools(24, 6))
    expect(d.test).toBe('chi2')
    expect(d.pass).toBe(true)
    expect(d.p).not.toBeNull()
    expect(d.p!).toBeGreaterThan(0.014)
    expect(d.p!).toBeLessThan(0.016)
    // Đối chiếu chéo: one-sided = two-sided/2 từ chính lib stats
    // (làm tròn 1e-12 trong decision cho phép lệch tới ~5e-13)
    const { p: pTwo } = chiSquare2x2(15, 15, 24, 6)
    expect(Math.abs(d.p! - pTwo / 2)).toBeLessThan(1e-9)
    expect(d.nA).toBe(30)
    expect(d.nB).toBe(30)
  })

  test('kiểm chứng spec 3: n=30 mỗi nhóm, sau TỆ hơn rõ → block (p=1 — không cải thiện)', () => {
    const d = evaluateAdaptationEvidence(bools(24, 6), bools(15, 15))
    expect(d.test).toBe('chi2')
    expect(d.pass).toBe(false)
    expect(d.p).toBe(1)
  })

  test('tỉ lệ bằng nhau (15/30 vs 15/30) → không có cải thiện → p=1 block', () => {
    const d = evaluateAdaptationEvidence(bools(15, 15), bools(15, 15))
    expect(d.pass).toBe(false)
    expect(d.p).toBe(1)
    expect(d.test).toBe('chi2')
  })

  test('Fisher khi expected < 5: trước 10/10 hỏng 0, sau 2/10 — đặt tên fisher, hướng xấu → p=1 block', () => {
    // minExpected = (row1·col2)/N = 10·8/20 = 4 < 5 → Fisher
    const d = evaluateAdaptationEvidence(bools(10, 0), bools(2, 8))
    expect(d.test).toBe('fisher')
    expect(d.pass).toBe(false)
    expect(d.p).toBe(1)
  })

  test('Fisher hướng cải thiện: trước 2/10, sau 10/10 → p = P(X≤2) ≈ 0.000357 → pass', () => {
    // Tay: P(X=2) = C(12,2)·C(8,8)/C(20,10) = 66/184756 ≈ 3.57e-4
    const d = evaluateAdaptationEvidence(bools(2, 8), bools(10, 0))
    expect(d.test).toBe('fisher')
    expect(d.pass).toBe(true)
    expect(d.p!).toBeGreaterThan(3.5e-4)
    expect(d.p!).toBeLessThan(3.6e-4)
    // Đối chiếu chéo: fisher branch dùng THẲNG p lib (đã one-sided theo OR quan sát)
    // — sai số làm tròn 1e-12 của decision cho phép lệch tới ~5e-13
    const { p } = chiSquare2x2(2, 8, 10, 0) // lib tự fallback Fisher (expected 4 < 5)
    expect(Math.abs(d.p! - p)).toBeLessThan(1e-9)
  })

  test('suy biến 100% vs 100% (n=10) → p=1 block — không có bằng chứng cải thiện', () => {
    const d = evaluateAdaptationEvidence(bools(10, 0), bools(10, 0))
    expect(d.pass).toBe(false)
    expect(d.p).toBe(1)
  })
})

// ==================== B. env ADAPTATION_STATS_GATE ====================

describe('B. isAdaptationStatsGateBlocking — env parse', () => {
  test('không đặt → OFF (log-only mặc định)', () => {
    delete process.env.ADAPTATION_STATS_GATE
    expect(isAdaptationStatsGateBlocking()).toBe(false)
  })

  test('chuỗi RỖNG = unset → OFF (quy ước FB-Đợt5-R2-01)', () => {
    process.env.ADAPTATION_STATS_GATE = ''
    expect(isAdaptationStatsGateBlocking()).toBe(false)
  })

  test('on / 1 / true (kể cả HOA + whitespace) → ON', () => {
    for (const v of ['on', 'ON', '  on  ', '1', 'true', 'TRUE']) {
      process.env.ADAPTATION_STATS_GATE = v
      expect(isAdaptationStatsGateBlocking()).toBe(true)
    }
  })

  test('off / garbage → OFF', () => {
    for (const v of ['off', 'OFF', '0', 'false', 'garbage', ' ']) {
      process.env.ADAPTATION_STATS_GATE = v
      expect(isAdaptationStatsGateBlocking()).toBe(false)
    }
  })
})

// ==================== C. applyAdaptationToSession + statsGate ====================

describe('C. applyAdaptationToSession — cổng stats (điểm đổi hành vi duy nhất)', () => {
  const blockGate = { pass: false, test: 'chi2' as const, p: 0.9, nA: 30, nB: 30, reason: 'sau tệ hơn rõ' }

  test('gate OFF (mặc định) + pass=false → VẪN APPLY (log-only)', () => {
    delete process.env.ADAPTATION_STATS_GATE
    const state = applyAdaptationToSession('sess-gate-1', decision('compress_context'), '1-1', blockGate)
    expect(state).not.toBeNull()
    expect(__peekSessionAdaptation('sess-gate-1')).not.toBeNull()
  })

  test('gate ON + pass=false → CHẶN: null + store trống', () => {
    process.env.ADAPTATION_STATS_GATE = 'on'
    const state = applyAdaptationToSession('sess-gate-2', decision('compress_context'), '1-1', blockGate)
    expect(state).toBeNull()
    expect(__peekSessionAdaptation('sess-gate-2')).toBeNull()
  })

  test('gate ON + pass=true → apply bình thường', () => {
    process.env.ADAPTATION_STATS_GATE = 'on'
    const passGate = { pass: true, test: 'chi2' as const, p: 0.01, nA: 30, nB: 30, reason: 'cải thiện rõ' }
    const state = applyAdaptationToSession('sess-gate-3', decision('compress_context'), '1-1', passGate)
    expect(state).not.toBeNull()
  })

  test('gate ON + insufficient (pass=true) → apply (khởi động lạnh giữ cũ)', () => {
    process.env.ADAPTATION_STATS_GATE = 'on'
    const insuff = { pass: true, test: 'insufficient' as const, p: null, nA: 2, nB: 3, reason: 'n chưa đủ' }
    const state = applyAdaptationToSession('sess-gate-4', decision('compress_context'), '1-1', insuff)
    expect(state).not.toBeNull()
  })

  test('không truyền gate → hành vi cũ nguyên vẹn', () => {
    process.env.ADAPTATION_STATS_GATE = 'on'
    const state = applyAdaptationToSession('sess-gate-5', decision('compress_context'), '1-1')
    expect(state).not.toBeNull()
  })
})

// ==================== D. evaluateAdaptationGateForPair (DB) ====================

describe('D. evaluateAdaptationGateForPair — DB wiring (fail-open)', () => {
  test('chưa có tiền sử → insufficient nA=0 nB=0 pass=true', async () => {
    const r = await evaluateAdaptationGateForPair('from-x', 'to-y')
    expect(r).not.toBeNull()
    expect(r!.decision.test).toBe('insufficient')
    expect(r!.decision.nA).toBe(0)
    expect(r!.decision.nB).toBe(0)
    expect(r!.decision.pass).toBe(true)
    expect(r!.continuous).toBeNull()
  })

  test('gom before/after theo toStrategy + Welch-t cycles + persist statsJson', async () => {
    // Seed tiền sử: toStrategy=compress_context 12 outcomes (11T/1F — sau),
    // toStrategy=change_fix_approach 12 outcomes (2T/10F — before)
    for (let i = 0; i < 11; i++) {
      await db.strategyAdaptationLog.create({
        data: {
          sessionId: `asg-cc-${i}`,
          fromStrategy: 'change_fix_approach',
          toStrategy: 'compress_context',
          reason: 'seed test',
          confidence: 0.8,
          successful: true,
        },
      })
    }
    await db.strategyAdaptationLog.create({
      data: {
        sessionId: 'asg-cc-11',
        fromStrategy: 'change_fix_approach',
        toStrategy: 'compress_context',
        reason: 'seed test',
        confidence: 0.8,
        successful: false,
      },
    })
    for (let i = 0; i < 2; i++) {
      await db.strategyAdaptationLog.create({
        data: {
          sessionId: `asg-cf-${i}`,
          fromStrategy: 'reduce_scope',
          toStrategy: 'change_fix_approach',
          reason: 'seed test',
          confidence: 0.8,
          successful: true,
        },
      })
    }
    for (let i = 2; i < 12; i++) {
      await db.strategyAdaptationLog.create({
        data: {
          sessionId: `asg-cf-${i}`,
          fromStrategy: 'reduce_scope',
          toStrategy: 'change_fix_approach',
          reason: 'seed test',
          confidence: 0.8,
          successful: false,
        },
      })
    }
    // Row pending (successful=null) — KHÔNG được đếm
    await db.strategyAdaptationLog.create({
      data: {
        sessionId: 'asg-pending',
        fromStrategy: 'x',
        toStrategy: 'compress_context',
        reason: 'pending row',
        confidence: 0.5,
        successful: null,
      },
    })
    // AgentRunRecord cycles cho các session 2 nhóm (Welch-t bổ trợ — cycles
    // ĐA DẠNG để 2 nhóm không hằng số: welch cần phương sai > 0, nhóm hằng
    // cho t=±∞ → continuous null theo thiết kế)
    for (let i = 0; i < 12; i++) {
      await db.agentRunRecord.create({
        data: { sessionId: `asg-cc-${i}`, cycles: 4 + (i % 4), status: 'completed' },
      })
      await db.agentRunRecord.create({
        data: { sessionId: `asg-cf-${i}`, cycles: 10 + (i % 5), status: 'completed' },
      })
    }

    const r = await evaluateAdaptationGateForPair('change_fix_approach', 'compress_context')
    expect(r).not.toBeNull()
    // Tay: a=2 b=10 c=11 d=1 → minExpected 5.5 ≥ 5 → chi2 Yates
    // χ² = 24·(108−12)²/(12·12·13·11) ≈ 10.74 → one-sided ≈ 5.2e-4
    expect(r!.decision.test).toBe('chi2')
    expect(r!.decision.nA).toBe(12)
    expect(r!.decision.nB).toBe(12)
    expect(r!.decision.pass).toBe(true)
    expect(r!.decision.p!).toBeLessThan(0.001)
    // Welch-t bổ trợ: before-cycles (n=12, mean 12) vs after-cycles (n=12, mean 5.5)
    // — t = (12 − 5.5)/√(var/12 + var/12) hữu hạn (nhóm đa dạng)
    expect(r!.continuous).not.toBeNull()
    expect(r!.continuous!.test).toBe('welch_t')
    expect(r!.continuous!.nA).toBe(12)
    expect(r!.continuous!.nB).toBe(12)
    expect(Number.isFinite(r!.continuous!.t)).toBe(true)
    expect(r!.continuous!.t).toBeGreaterThan(0) // before > after → t dương

    // persist statsJson round-trip
    const row = await db.strategyAdaptationLog.create({
      data: {
        sessionId: 'asg-statsjson',
        fromStrategy: 'change_fix_approach',
        toStrategy: 'compress_context',
        reason: 'statsjson test',
        confidence: 0.8,
        successful: null,
      },
    })
    await persistAdaptationStatsJson(row.id, r!)
    const reloaded = await db.strategyAdaptationLog.findUnique({ where: { id: row.id } })
    expect(reloaded?.statsJson).not.toBeNull()
    const parsed = JSON.parse(reloaded!.statsJson!) as {
      test: string; p: number; nA: number; nB: number; decision: string
      continuous?: { test: string; nA: number; nB: number }
    }
    expect(parsed.test).toBe('chi2')
    expect(parsed.nA).toBe(12)
    expect(parsed.nB).toBe(12)
    expect(parsed.decision).toBe('pass')
    expect(parsed.continuous?.test).toBe('welch_t')

    // Dọn seed của test này (giữ sạch cho file khác trong cùng process)
    await db.strategyAdaptationLog.deleteMany({ where: { sessionId: { startsWith: 'asg-' } } })
    await db.agentRunRecord.deleteMany({ where: { sessionId: { startsWith: 'asg-' } } })
  })

  test('cycles MỚI NHẤT mỗi session được dùng (row cũ không đè — bẫy bằng dấu t)', async () => {
    // 2 session nhóm after (toStrategy='b') + 2 session nhóm before (toStrategy='c')
    for (const [sid, ok] of [['asg-latest-1', true], ['asg-latest-2', true]] as const) {
      await db.strategyAdaptationLog.create({
        data: { sessionId: sid, fromStrategy: 'a', toStrategy: 'b', reason: 'seed', confidence: 0.8, successful: ok },
      })
    }
    for (const [sid, ok] of [['asg-latest-3', false], ['asg-latest-4', false]] as const) {
      await db.strategyAdaptationLog.create({
        data: { sessionId: sid, fromStrategy: 'a', toStrategy: 'c', reason: 'seed', confidence: 0.8, successful: ok },
      })
    }
    // After-sessions: row CŨ cycles khổng lồ (100/200 — ngày hôm qua) + row MỚI nhỏ (7/8)
    await db.agentRunRecord.create({
      data: { sessionId: 'asg-latest-1', cycles: 100, status: 'completed', createdAt: new Date(Date.now() - 86_400_000) },
    })
    await db.agentRunRecord.create({ data: { sessionId: 'asg-latest-1', cycles: 7, status: 'completed' } })
    await db.agentRunRecord.create({
      data: { sessionId: 'asg-latest-2', cycles: 200, status: 'completed', createdAt: new Date(Date.now() - 86_400_000) },
    })
    await db.agentRunRecord.create({ data: { sessionId: 'asg-latest-2', cycles: 8, status: 'completed' } })
    // Before-sessions: 1 row mỗi session (50/55)
    await db.agentRunRecord.create({ data: { sessionId: 'asg-latest-3', cycles: 50, status: 'completed' } })
    await db.agentRunRecord.create({ data: { sessionId: 'asg-latest-4', cycles: 55, status: 'completed' } })

    const r = await evaluateAdaptationGateForPair('c', 'b')
    expect(r).not.toBeNull()
    // n=2 mỗi nhóm → binary gate insufficient (giữ hành vi cũ)
    expect(r!.decision.test).toBe('insufficient')
    // Welch-t bổ trợ: đúng dùng row MỚI NHẤT → before (50,55) vs after (7,8)
    // → t = (meanBefore − meanAfter)/se > 0. Nếu lỡ dùng row CŨ của after
    // (100,200 → mean 150) thì t < 0 — dấu t là bẫy hành vi.
    expect(r!.continuous).not.toBeNull()
    expect(r!.continuous!.nA).toBe(2)
    expect(r!.continuous!.nB).toBe(2)
    expect(r!.continuous!.t).toBeGreaterThan(0)
    await db.strategyAdaptationLog.deleteMany({ where: { sessionId: { startsWith: 'asg-latest-' } } })
    await db.agentRunRecord.deleteMany({ where: { sessionId: { startsWith: 'asg-latest-' } } })
  })
})

// ==================== E. evaluateContinuousEvidence (thuần) ====================

describe('E. evaluateContinuousEvidence — Welch-t bổ trợ', () => {
  test('nhóm < 2 mẫu → null', () => {
    expect(evaluateContinuousEvidence([5], [1, 2, 3])).toBeNull()
    expect(evaluateContinuousEvidence([], [])).toBeNull()
  })

  test('lọc giá trị không hữu hạn trước khi thử', () => {
    const r = evaluateContinuousEvidence([1, Number.NaN, 3], [4, 5, 6])
    expect(r).not.toBeNull()
    expect(r!.nA).toBe(2)
    expect(r!.nB).toBe(3)
  })

  test('hai nhóm hằng bằng nhau → t=0, p=1 (welchTTest suy biến an toàn)', () => {
    const r = evaluateContinuousEvidence([5, 5, 5], [5, 5, 5])
    expect(r).not.toBeNull()
    expect(r!.t).toBe(0)
    expect(r!.p).toBe(1)
  })

  test('hai nhóm khác rõ → t/p hữu hạn (two-sided — chỉ bổ trợ log)', () => {
    const r = evaluateContinuousEvidence([10, 12, 14, 16, 18], [30, 32, 34, 36, 38])
    expect(r).not.toBeNull()
    expect(Number.isFinite(r!.t)).toBe(true)
    expect(r!.p).toBeGreaterThanOrEqual(0)
    expect(r!.p).toBeLessThanOrEqual(1)
    expect(r!.test).toBe('welch_t')
  })
})
