/**
 * r79-softmax-policy — ĐỢT 8 (BLUEPRINT-STATS-LEARNING-P0-P6 §P6: RL-LITE)
 *
 * P6-M2 · Tabular Q-learning (q-table.ts):
 *   A. qLearningUpdate thuần (chấm tay công thức Q ← Q + α[r + γ·maxQ' − Q])
 *   B. updateQ/getQAdvice/getTopQAdvice vòng DB thật (bảng QEntry — preload
 *      isolation copy DB thật, schema đã db:push)
 *   C. resolveArbiterVerdictsDetailed — breakdown confirmed/refuted (W2 tiền đề)
 *   D. markSessionAdaptationOutcome trả recorded=false khi không có state
 *      (contract mới P6-M1 — W1 chỉ updateQ khi recorded=true)
 *
 * P6-M3 · Softmax(τ) stochastic model-selection (spec: "test r79-softmax-policy
 * .test.ts (pure: distribution π hợp lệ, blocked model weight 0, seed
 * deterministic)"):
 *   E. softmaxPolicy — phân bố hợp lệ + blocked weight 0 + ổn định số trị
 *   F. deterministicSeed/pickIndexBySeed — chạy lại được + PHÂN BỐ ≥2 MODEL
 *      (ngưỡng nghiệm thu đợt 8) qua nhiều seed
 *   G. state key quy ước mode-${routingMode}-tier-${tier} (tái dùng format
 *      historical-feedback)
 *
 * P6-M4 · getTopQAdvice ordering (advisory dropdown/PLAN hint tiền đề) — gộp
 * trong B.
 */

import { describe, expect, test } from 'bun:test'
import { randomUUID } from 'crypto'

import {
  qLearningUpdate,
  softmaxPolicy,
  deterministicSeed,
  pickIndexBySeed,
  qStateKey,
  agentRuntimeStateKey,
  updateQ,
  getQAdvice,
  getTopQAdvice,
  qEntryCount,
  Q_LEARNING_ALPHA,
  Q_LEARNING_GAMMA,
  parseRuntimeModelTau,
} from '@/lib/learning/q-table'
import { resolveArbiterVerdictsDetailed } from '@/lib/metrics-db'
import { markSessionAdaptationOutcome } from '@/lib/learning/adaptation-engine'
import { db } from '@/lib/db'

// ==================== A. qLearningUpdate (thuần) ====================

describe('A. qLearningUpdate — công thức Q-learning chấm tay', () => {
  test('Q=0.5, r=1, maxNext=0.3, α=0.1, γ=0.9 → 0.577 (tính tay)', () => {
    // 0.5 + 0.1 × (1 + 0.9×0.3 − 0.5) = 0.5 + 0.1×0.77 = 0.577
    expect(qLearningUpdate(0.5, 1, 0.3, 0.1, 0.9)).toBeCloseTo(0.577, 12)
  })

  test('khởi điểm 0: r=+1, maxNext=0 → α×1 = 0.1', () => {
    expect(qLearningUpdate(0, 1, 0, 0.1, 0.9)).toBeCloseTo(0.1, 12)
  })

  test('r=−1 kéo xuống: Q=0, maxNext=0 → −0.1', () => {
    expect(qLearningUpdate(0, -1, 0, 0.1, 0.9)).toBeCloseTo(-0.1, 12)
  })

  test('γ·maxNext rút ra từ tương lai: Q=0, r=0, maxNext=1 → γ = 0.09... (α·γ)', () => {
    expect(qLearningUpdate(0, 0, 1, 0.1, 0.9)).toBeCloseTo(0.09, 12)
  })

  test('kẹp [−1, 1] — reward lặp nhiều không trôi vô hạn', () => {
    let q = 0
    for (let i = 0; i < 1000; i++) q = qLearningUpdate(q, 1, 1, 0.5, 0.99) // α lớn đẩy nhanh
    expect(q).toBeLessThanOrEqual(1)
    let q2 = 0
    for (let i = 0; i < 1000; i++) q2 = qLearningUpdate(q2, -1, -1, 0.5, 0.99)
    expect(q2).toBeGreaterThanOrEqual(-1)
  })

  test('NaN/∞ phòng thủ — trả giá trị hữu hạn (hoặc 0 khi currentQ hỏng)', () => {
    expect(qLearningUpdate(Number.NaN, 1, 0)).toBe(0)
    expect(qLearningUpdate(0.4, Number.NaN, 0)).toBe(0.4)
    expect(qLearningUpdate(0.4, 1, Number.POSITIVE_INFINITY)).toBe(0.4)
  })

  test('hằng số mặc định spec: α=0.1, γ=0.9', () => {
    expect(Q_LEARNING_ALPHA).toBe(0.1)
    expect(Q_LEARNING_GAMMA).toBe(0.9)
  })
})

// ==================== B. updateQ/getQAdvice DB vòng thật ====================

describe('B. QEntry DB — updateQ/getQAdvice/getTopQAdvice', () => {
  const stateKey = `test-q-${randomUUID().slice(0, 8)}`

  test('updateQ tạo entry mới từ 0 + visits tăng + getQAdvice đọc đúng', async () => {
    await updateQ(stateKey, 'model-x', 1, stateKey) // r=+1, maxNext ban đầu 0
    let advice = await getQAdvice(stateKey, ['model-x', 'model-y'])
    const x = advice.find(a => a.action === 'model-x')!
    expect(x.q).toBeCloseTo(0.1, 10) // 0 + 0.1×(1+0−0)
    expect(x.visits).toBe(1)
    // Ứng viên chưa học → q=0, visits=0 (uniform prior)
    const y = advice.find(a => a.action === 'model-y')!
    expect(y.q).toBe(0)
    expect(y.visits).toBe(0)

    // Update lần 2 — maxNext giờ = Q(model-x) hiện có → công thức đầy đủ
    await updateQ(stateKey, 'model-x', 1, stateKey)
    advice = await getQAdvice(stateKey, ['model-x', 'model-y'])
    const x2 = advice.find(a => a.action === 'model-x')!
    // Q1 = 0.1; maxNext = 0.1 → Q2 = 0.1 + 0.1×(1 + 0.9×0.1 − 0.1) = 0.1 + 0.099 = 0.199
    expect(x2.q).toBeCloseTo(0.199, 10)
    expect(x2.visits).toBe(2)
  })

  test('reward −1 kéo Q xuống; getTopQAdvice sắp theo Q giảm dần chỉ visits>0', async () => {
    // FB-P6-R1-A-05 (sửa comment sai): maxNext gồm model-x Q=0.199 (đã học ở test
    // trên) → Q(model-bad) = 0 + 0.1×(−1 + 0.9×0.199 − 0) = −0.08209 (KHÔNG phải
    // −0.1 như comment cũ) — comment cũ sai sẽ dẫn người sửa test sau này nhầm.
    await updateQ(stateKey, 'model-bad', -1, stateKey) // → −0.08209 (maxNext=0.199)
    const top = await getTopQAdvice(stateKey, 5)
    expect(top.length).toBeGreaterThanOrEqual(2)
    expect(top[0].action).toBe('model-x') // Q≈0.199 > model-bad −0.08209
    expect(top[top.length - 1].action).toBe('model-bad')
    // sắp giảm dần
    for (let i = 1; i < top.length; i++) expect(top[i - 1].q).toBeGreaterThanOrEqual(top[i].q)
  })

  test('nextStateKey khác — max_a\' Q(s\') ảnh hưởng update (khớp công thức spec)', async () => {
    const s1 = `${stateKey}-s1`
    const s2 = `${stateKey}-s2`
    // Gieo Q cao ở s2
    await updateQ(s2, 'future-best', 1, s2)   // 0.1
    await updateQ(s2, 'future-best', 1, s2)   // 0.199
    // Update s1 với nextState s2 → maxNext = 0.199
    await updateQ(s1, 'act-a', 0, s2)
    const advice = await getQAdvice(s1, ['act-a'])
    // 0 + 0.1×(0 + 0.9×0.199 − 0) = 0.01791
    expect(advice[0].q).toBeCloseTo(0.1 * 0.9 * 0.199, 10)
  })

  test('getQAdvice dedup candidate + bỏ chuỗi rỗng', async () => {
    const advice = await getQAdvice(stateKey, ['model-x', 'model-x', ''])
    expect(advice.length).toBe(1)
    expect(advice[0].action).toBe('model-x')
  })
})

// ==================== C. resolveArbiterVerdictsDetailed (W2 tiền đề) ====================

describe('C. resolveArbiterVerdictsDetailed — breakdown confirmed/refuted', () => {
  test('2 verdict complete=true + 1 complete=false, run hoàn thành → 2 confirmed / 1 refuted', async () => {
    const sessionId = `test-av-${randomUUID().slice(0, 8)}`
    const mk = async (complete: boolean) => {
      await db.arbiterVerdict.create({
        data: { sessionId, cycle: 1, complete, confidence: 0.8, verified: true },
      })
    }
    await mk(true)
    await mk(true)
    await mk(false)

    const { total, confirmed, refuted } = await resolveArbiterVerdictsDetailed(sessionId, true, 'max_cycles')
    expect(total).toBe(3)
    expect(confirmed).toBe(2) // complete === runComplete(true)
    expect(refuted).toBe(1)

    // Idempotent: resolve lần 2 không còn pending
    const again = await resolveArbiterVerdictsDetailed(sessionId, true, 'max_cycles')
    expect(again.total).toBe(0)
  })

  test('run KHÔNG hoàn thành → verdict complete=true bị refuted (ngược chiều)', async () => {
    const sessionId = `test-av-${randomUUID().slice(0, 8)}`
    await db.arbiterVerdict.create({
      data: { sessionId, cycle: 1, complete: true, confidence: 0.8, verified: true },
    })
    const { confirmed, refuted } = await resolveArbiterVerdictsDetailed(sessionId, false, 'error')
    expect(confirmed).toBe(0)
    expect(refuted).toBe(1)
  })
})

// ==================== D. markSessionAdaptationOutcome contract (W1 tiền đề) ====================

describe('D. markSessionAdaptationOutcome — contract recorded (P6-M1)', () => {
  test('session KHÔNG có adaptation state → recorded=false (W1 không updateQ bằng chứng rác)', async () => {
    const outcome = await markSessionAdaptationOutcome(`no-state-${randomUUID().slice(0, 8)}`, true, 'step-1')
    expect(outcome.recorded).toBe(false)
    expect(outcome.toStrategy).toBeUndefined()
  })
})

// ==================== E. softmaxPolicy (pure — spec §P6-M3) ====================

describe('E. softmaxPolicy — phân bố π hợp lệ + blocked weight 0', () => {
  test('tổng xác suất = 1 (điểm đồng nhất → uniform)', () => {
    const probs = softmaxPolicy([0, 0, 0, 0], 0.5)
    expect(probs.reduce((s, p) => s + p, 0)).toBeCloseTo(1, 12)
    for (const p of probs) expect(p).toBeCloseTo(0.25, 12)
  })

  test('điểm cao hơn → xác suất cao hơn (đơn điệu theo score)', () => {
    const probs = softmaxPolicy([0.8, 0.2, 0], 0.5)
    expect(probs[0]).toBeGreaterThan(probs[1])
    expect(probs[1]).toBeGreaterThan(probs[2])
    expect(probs.reduce((s, p) => s + p, 0)).toBeCloseTo(1, 12)
  })

  test('blocked model weight 0 → p = 0 (spec: health weight 0)', () => {
    const probs = softmaxPolicy([0.9, 0.5, 0.1], 0.5, [1, 0, 1])
    expect(probs[1]).toBe(0)
    expect(probs.reduce((s, p) => s + p, 0)).toBeCloseTo(1, 12)
    expect(probs[0]).toBeGreaterThan(0)
    expect(probs[2]).toBeGreaterThan(0)
  })

  test('τ nhỏ → tập trung argmax; τ lớn → dàn đều (chống cascade cần τ vừa)', () => {
    const scores = [1, 0, 0, 0]
    const cold = softmaxPolicy(scores, 0.05)
    const hot = softmaxPolicy(scores, 50)
    expect(cold[0]).toBeGreaterThan(0.95) // τ→0 tiệm cận argmax
    expect(hot[0] - hot[1]).toBeLessThan(cold[0] - cold[1]) // τ lớn dẹt chênh lệch
  })

  test('ổn định số trị: score lớn không tràn NaN (trừ max trước exp)', () => {
    const probs = softmaxPolicy([1e6, 5e5, 0], 0.5)
    expect(probs.every(p => Number.isFinite(p) && p >= 0 && p <= 1)).toBe(true)
    expect(probs.reduce((s, p) => s + p, 0)).toBeCloseTo(1, 9)
  })

  test('mảng rỗng / toàn weight-0 → trả toàn 0; τ vô hiệu (NaN) → sanitize về default 0.5', () => {
    expect(softmaxPolicy([], 0.5)).toEqual([])
    expect(softmaxPolicy([1, 2], 0.5, [0, 0])).toEqual([0, 0])
    // Sai-kỳ-vọng người-rà lần 14 (FB-Đợt8): lần đầu kỳ vọng NaN-τ → [0,0] —
    // thực tế code sanitize τ vô hiệu về RUNTIME_MODEL_TAU_DEFAULT (0.5) —
    // HỢP LÝ HƠN (τ từ env parse; parse hỏng → default, không giết chính sách).
    const sanitized = softmaxPolicy([1, 2], Number.NaN)
    expect(sanitized.reduce((s, p) => s + p, 0)).toBeCloseTo(1, 12)
    expect(sanitized.every(p => p > 0)).toBe(true)
  })
})

// ==================== F. Seed deterministic + PHÂN BỐ ≥2 MODEL ====================

describe('F. deterministicSeed/pickIndexBySeed — chạy lại được + phân bố', () => {
  test('cùng input → cùng seed; khác input → seed khác (FNV-1a)', () => {
    expect(deterministicSeed('session-a', '3')).toBe(deterministicSeed('session-a', '3'))
    expect(deterministicSeed('session-a', '3')).not.toBe(deterministicSeed('session-a', '4'))
    expect(deterministicSeed('session-a', '3')).not.toBe(deterministicSeed('session-b', '3'))
  })

  test('cùng seed → cùng lựa chọn (chạy lại được — spec "Deterministic seed")', () => {
    const probs = softmaxPolicy([0.6, 0.3, 0.1], 0.5)
    const seed = deterministicSeed('sess', '7')
    expect(pickIndexBySeed(probs, seed)).toBe(pickIndexBySeed(probs, seed))
  })

  test('NGƯỠNG NGHIỆM THU ĐỢT 8: uniform prior (Q chưa học) qua 20 chu kỳ khác nhau → PHÂN BỐ ≥2 MODEL', () => {
    const models = ['space-bunny-free', 'big-pickle', 'mimo-v2.6-flash-free', 'ling-3.1-flash-free']
    const probs = softmaxPolicy(models.map(() => 0), 0.5) // uniform — chưa có Q
    const picks = new Set<string>()
    for (let cycle = 0; cycle < 20; cycle++) {
      const seed = deterministicSeed('session-e2e', String(cycle))
      const idx = pickIndexBySeed(probs, seed)
      expect(idx).toBeGreaterThanOrEqual(0)
      picks.add(models[idx])
    }
    // Softmax chống 429-cascade: điểm khởi đầu PHẢI dàn ra, không dồn 1 model
    expect(picks.size).toBeGreaterThanOrEqual(2)
  })

  test('phân bố xa kỳ vọng đều → seed "thiên vị" 1 model bị phát hiện (chống kẹt)', () => {
    const probs = [1, 0, 0, 0] // phân bố cực đoan (mock)
    const picks = new Set<number>()
    for (let i = 0; i < 30; i++) picks.add(pickIndexBySeed(probs, deterministicSeed('s', String(i))))
    expect(picks.size).toBe(1) // tôn trọng phân bố — seed không bẻ cong π
  })

  test('prob toàn 0 → −1 (caller fallback đường cũ)', () => {
    expect(pickIndexBySeed([0, 0, 0], 123)).toBe(-1)
  })
})

// ==================== G. State key quy ước (P6-M1) ====================

describe('G. qStateKey — quy ước mode-${routingMode}-tier-${tier}', () => {
  test('đúng format key historical-feedback (mode-A-tier-1, mode-C-tier-3)', () => {
    expect(qStateKey('A', 1)).toBe('mode-A-tier-1')
    expect(qStateKey('C', 3)).toBe('mode-C-tier-3')
    expect(qStateKey('B', 2)).toBe('mode-B-tier-2')
  })

  test('agentRuntimeStateKey ổn định qua lời gọi (goal-loop đọc/ghi cùng key)', () => {
    expect(agentRuntimeStateKey()).toBe('mode-agent-tier-1')
    expect(agentRuntimeStateKey()).toBe(agentRuntimeStateKey())
  })
})

// ==================== H. REGRESSION FB-P6-R1 (fixbug đợt 8/P6 — vòng R1) ====================
// Mỗi test pin MỘT phát hiện đã fix: lỗi cũ phải HẾT, hành vi mới phải đúng.

describe('H1. FB-P6-R1-A-01 — maxNextQ là MAX THUẦN (không floor tại 0)', () => {
  test('state kế TOÀN entry âm → maxNext âm (bản trước floor 0 → học chậm ~10×)', async () => {
    const s = `test-fbp6-a01-${randomUUID().slice(0, 8)}`
    // Gieo state kế toàn âm: model-bad r=−1 ×2 → bản PURE: −0.1 → −0.199
    await updateQ(s, 'bad', -1, s)
    let advice = await getQAdvice(s, ['bad'])
    expect(advice[0].q).toBeCloseTo(-0.1, 10) // 0 + 0.1×(−1 + 0.9×0 − 0)
    await updateQ(s, 'bad', -1, s)
    advice = await getQAdvice(s, ['bad'])
    // PURE max: maxNext = −0.1 → −0.1 + 0.1×(−1 + 0.9×(−0.1) + 0.1) = −0.199
    // (bản floor-0 cũ: maxNext=0 → −0.19 — sai công thức spec §P6-M2)
    expect(advice[0].q).toBeCloseTo(-0.199, 10)
    // 15 lần −1 liên tiếp → chuẩn thuần tiến về −1 (đã chạm clamp ~lần 10)
    for (let i = 0; i < 13; i++) await updateQ(s, 'bad', -1, s)
    advice = await getQAdvice(s, ['bad'])
    expect(advice[0].q).toBeLessThanOrEqual(-0.99) // floor-0 cũ dừng −0.794
  })

  test('chuỗi 15 update −1 khớp mô phỏng công thức thuần độc lập', async () => {
    const s = `test-fbp6-a01b-${randomUUID().slice(0, 8)}`
    let q = 0
    for (let i = 0; i < 15; i++) {
      // mô phỏng độc lập: max_a' Q(s,·) = q hiện tại (entry duy nhất của s)
      q = qLearningUpdate(q, -1, q)
      await updateQ(s, 'm', -1, s)
    }
    const advice = await getQAdvice(s, ['m'])
    expect(advice[0].q).toBeCloseTo(q, 10) // DB khớp mô phỏng thuần 100%
  })
})

describe('H2. FB-P6-R1-A-02 — seed phân bố đều sau avalanche (chống cluster chu kỳ)', () => {
  test('500 session ngẫu nhiên × 20 chu kỳ uniform-4 → mean distinct model ≥ 3.5 (bản cũ ≈1.99)', async () => {
    const models = ['space-bunny-free', 'big-pickle', 'mimo-v2.6-flash-free', 'ling-3.1-flash-free']
    const probs = softmaxPolicy(models.map(() => 0), 0.5)
    let sumDistinct = 0
    let sessions1Model = 0
    const N = 500
    for (let sess = 0; sess < N; sess++) {
      const sid = `fbp6-sess-${sess}-${randomUUID().slice(0, 8)}`
      const picks = new Set<string>()
      for (let cycle = 0; cycle < 20; cycle++) {
        const idx = pickIndexBySeed(probs, deterministicSeed(sid, String(cycle)))
        picks.add(models[idx])
      }
      sumDistinct += picks.size
      if (picks.size === 1) sessions1Model++
    }
    const mean = sumDistinct / N
    // Uniform thật kỳ vọng ~3.99; FNV-trần cũ đo được ≈1.99. Ngưỡng 3.5 chặt
    // nhưng an toàn với avalanche (xác suất rơi dưới ~0 với 500 mẫu).
    expect(mean).toBeGreaterThanOrEqual(3.5)
    // Bản cũ 16-19% session chỉ đụng 1 model — avalanche phải gần 0 (cho phép
    // tối đa 1/500 ~ nhiễu thống luận của xác suất 4×(1/4)^20≈3.7e-12)
    expect(sessions1Model).toBeLessThanOrEqual(1)
  })

  test('avalanche giữ tính tất định — cùng input vẫn cùng seed/khác input khác seed', () => {
    expect(deterministicSeed('s', '0')).toBe(deterministicSeed('s', '0'))
    expect(deterministicSeed('s', '0')).not.toBe(deterministicSeed('s', '1'))
    // Cấu trúc cấp số cộng ±FNV-prime của bản cũ đã phá vỡ: 2 seed liền kề
    // không còn chênh nhau đúng 16777619
    const d0 = deterministicSeed('s', '0')
    const d1 = deterministicSeed('s', '1')
    const diff = Math.abs(d0 - d1)
    expect(diff).not.toBe(16777619)
  })
})

describe('H3. FB-P6-R1-A-03 — updateQ nguyên atom (10 update song song không mất)', () => {
  test('10 updateQ // cung (state,action) → qValue theo tuần tự (bản cũ chỉ 1/10 ăn nhập)', async () => {
    // Sai-kỳ-vọng người-rà lần 16 (FB-P6): kỳ vọng cũ mô phỏng maxNext=0 —
    // sai, vì chuỗi tuần tự cho mỗi update ĐỌC Q vừa ghi (state có 1 entry
    // → maxNext = Q hiện tại). Công thức đúng: q ← qLearningUpdate(q, 1, q)
    // — giá trị khớp số đo độc lập của auditor (10 lượt = 0.956179).
    const s2 = `test-fbp6-a03b-${randomUUID().slice(0, 8)}`
    await Promise.all(Array.from({ length: 10 }, () => updateQ(s2, 'race-model', 1, s2)))
    const advice = await getQAdvice(s2, ['race-model'])
    expect(advice[0].visits).toBe(10) // KHÔNG mất update nào (bản cũ 10 lượt chỉ 1 ăn nhập qValue)
    let seqQ = 0
    for (let i = 0; i < 10; i++) seqQ = qLearningUpdate(seqQ, 1, seqQ)
    expect(advice[0].q).toBeCloseTo(seqQ, 6) // ≈0.9562 — 10/10 update ăn nhập
  })
})

describe('H4. FB-P6-R1-A-08 — softmax argmax bị chặn không kéo max xuống', () => {
  test('blocked-argmax gap lớn: xác suất sống không underflow về 0', () => {
    // argmax bị chặn (w=0), 2 ứng viên sống cách xa — bản trước max tính trên
    // TOÀN BỘ score (kể cả bị chặn) → exp(0−maxToànBộ) underflow → [0,0,0]
    const probs = softmaxPolicy([1000, 0, 0], 0.5, [0, 1, 1])
    expect(probs[0]).toBe(0) // bị chặn
    // Sai-kỳ-vọng người-rà lần 15 (FB-P6): kỳ vọng cũ ">0.5" — thực tế 2 ứng
    // viên sống đồng điểm nên chính xác 0.5/0.5 (0.5 KHÔNG > 0.5). Chấm tay:
    // scaled [2000,0,0] → alive [-∞,0,0] → max 0 → exps [0,1,1] → [0, .5, .5]
    expect(probs[1]).toBeCloseTo(0.5, 12)
    expect(probs[2]).toBeCloseTo(0.5, 12)
    expect(probs.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12)
  })
})

describe('H5. FB-P6-R1-A-06 — getTopQAdvice clamp limit + filter visits + qEntryCount', () => {
  test('limit 0 → 1 entry; limit 100 → 20; NaN limit → default 5 không throw', async () => {
    const s = `test-fbp6-a06-${randomUUID().slice(0, 8)}`
    // gieo 25 entry visits>0
    for (let i = 0; i < 25; i++) await updateQ(s, `m-${String(i).padStart(2, '0')}`, 1, s)
    const one = await getTopQAdvice(s, 0)
    expect(one.length).toBe(1)
    const twenty = await getTopQAdvice(s, 100)
    expect(twenty.length).toBe(20)
    const nan = await getTopQAdvice(s, Number.NaN)
    expect(nan.length).toBe(5) // default — không Prisma throw (fail-open giữ nguyên)
  })

  test('qEntryCount đếm đúng entries + tổng visits', async () => {
    const s = `test-fbp6-a06b-${randomUUID().slice(0, 8)}`
    await updateQ(s, 'a', 1, s)
    await updateQ(s, 'a', 1, s)
    await updateQ(s, 'b', 1, s)
    const before = await qEntryCount()
    expect(before.entries).toBeGreaterThanOrEqual(2) // toàn bảng (có thể dính test khác)
    // kiểm tra tỉ lệ: state này có đúng 2 entry / 3 visits
    const advice = await getQAdvice(s, ['a', 'b'])
    expect(advice.find(x => x.action === 'a')!.visits).toBe(2)
    expect(advice.find(x => x.action === 'b')!.visits).toBe(1)
  })
})

describe('H6. FB-P6-R2 — regression vòng R2 (fix R1 sinh lỗi mới đã sửa)', () => {
  test('FB-P6-R1-A-09: seed âm/NaN/∞ → -1 (caller fallback đường cũ)', () => {
    const probs = [0.5, 0.5]
    expect(pickIndexBySeed(probs, -1)).toBe(-1)
    expect(pickIndexBySeed(probs, Number.NaN)).toBe(-1)
    expect(pickIndexBySeed(probs, Number.POSITIVE_INFINITY)).toBe(-1)
    expect(pickIndexBySeed(probs, 12345)).toBeGreaterThanOrEqual(0) // seed hợp lệ vẫn chạy
  })

  test('FB-P6-R1-B-05 (catalog invariant): mọi model zen khai báo caps coding=true ∧ reasoning=true — model thiếu caps sẽ bị whitelist loại (không lọt âm thầm)', async () => {
    const { PROVIDER_MODELS } = await import('@/lib/agent-constants')
    const zen = PROVIDER_MODELS.zen ?? []
    expect(zen.length).toBeGreaterThanOrEqual(5) // catalog hiện có đủ model để softmax có nghĩa
    // Invariant whitelist llm.ts dựa vào: thiếu caps = LOẠI — test chặn catalog
    // thêm model thiếu caps mà không ai nhận ra (đổi âm thầm tập ứng viên softmax)
    const withCaps = zen.filter(m => m.caps?.coding === true && m.caps?.reasoning === true)
    expect(withCaps.length).toBe(zen.length)
  })

  test('FB-P6-R1-B-03 (contract checkpoint): Map modelsUsed ↔ Array<[string, number>] round-trip qua JSON', () => {
    // Hình dạng persist của buildCheckpoint + restore `new Map(resumeState?.modelsUsed ?? [])`
    const m = new Map<string, number>([['space-bunny-free', 5], ['big-pickle', 2]])
    const serialized = JSON.parse(JSON.stringify(Array.from(m.entries()))) // qua JSON như checkpoint DB
    const restored = new Map<string, number>(serialized as Array<[string, number]>)
    expect(restored.get('space-bunny-free')).toBe(5)
    expect(restored.get('big-pickle')).toBe(2)
    expect(restored.size).toBe(2)
    // Checkpoint cũ không có field (optional) → Map rỗng (hành vi cũ nguyên vẹn)
    const oldCheckpoint: { modelsUsed?: Array<[string, number]> } = {}
    const fromOld = new Map<string, number>(oldCheckpoint.modelsUsed ?? [])
    expect(fromOld.size).toBe(0)
  })

  test('FB-P6-R1-B-07: parseRuntimeModelTau — "0" là giá trị hợp lệ qua floor 0.05 (bản cũ rơi default 0.5)', () => {
    expect(parseRuntimeModelTau('0')).toBeCloseTo(0.05, 12) // τ=0 chủ ý → floor
    expect(parseRuntimeModelTau('0.01')).toBeCloseTo(0.05, 12)
    expect(parseRuntimeModelTau('0.5')).toBeCloseTo(0.5, 12)
    expect(parseRuntimeModelTau('2')).toBeCloseTo(2, 12)
    expect(parseRuntimeModelTau('')).toBeCloseTo(0.5, 12) // rỗng → default
    expect(parseRuntimeModelTau(undefined)).toBeCloseTo(0.5, 12)
    expect(parseRuntimeModelTau('abc')).toBeCloseTo(0.5, 12) // NaN → default
    expect(parseRuntimeModelTau('-3')).toBeCloseTo(0.05, 12) // âm → floor
  })
})
