/**
 * r105 — EVO-P0 + EVO-P1 (BLUEPRINT-EVO-NAO-P1-P5 §0.1 hàng P0/P1 — R24-c)
 * ============================================================================
 *
 * P0 (benchmark): fixture THẬT load đúng shape + fingerprint ổn định + chấm
 * điểm TẤT ĐỊNH bit-đối-bit theo (spec, seed) + baseline heuristic hữu hạn.
 * P1 (encoding 144): pad 96→144 (F4) + repair one-hot (F8) + decode thuần
 * MLP từ vùng [0..95] + roundtrip encode∘decode + sampler/mutation/crossover
 * luôn ra vector hợp lệ.
 */

import { describe, expect, test } from 'bun:test'
import {
  EVO_ENCODING_DIM,
  SEARCH_ENCODING_DIM,
  padEvo96to144,
  encodeDraft,
  sampleCandidate,
  repairEvoEncoding,
  decodeEvoCandidate,
  encodeEvoCandidate,
  sampleEvoCandidate,
  mutateEvo,
  crossoverEvo,
} from '../src/lib/brain/search-space'
import {
  loadEvoFixture,
  scoreEvoCandidate,
  scoreEvoBaseline,
  evoFolds,
  type EvoCandidateSpec,
} from '../src/lib/brain/evo/benchmark'
import { EVO_BLOCK_TYPES } from '../src/lib/brain/evo/blocks'
import { makeRng } from '../src/lib/brain/init'
import { defaultDraftFor } from '../src/lib/brain/spec-schema'

// ==================== P0 — FIXTURES (dữ liệu thật — Q1) ====================

describe('r105 · EVO-P0 benchmark — fixtures từ dữ liệu thật (Q1)', () => {
  test('A fixture load đủ 3 brain + shape khớp contract', () => {
    for (const brain of ['calibration_v3', 'surrogate', 'policy'] as const) {
      const fx = loadEvoFixture(brain)
      expect(fx.brain).toBe(brain)
      expect(fx.nSamples).toBeGreaterThan(0)
      expect(fx.X.length).toBe(fx.nSamples)
      expect(fx.inputDim).toBe(fx.X[0]!.length)
      expect(fx.outputDim).toBe(fx.y[0]!.length)
      expect(fx.headSpans.reduce((a, b) => a + b, 0)).toBe(fx.outputDim)
      expect(fx.lossHeads.length).toBe(fx.headSpans.length)
      // dữ liệu thật: fingerprint + nguồn ghi rõ (không fake)
      expect(fx.dataFingerprint).toMatch(/^[0-9a-f]{16}$/)
      expect(fx.sourceLabel).toContain('THẬT')
      expect(fx.builtFrom).toContain('R2 backups/sqlite/')
      // reload → cùng fingerprint (cache đĩa ổn định)
      expect(loadEvoFixture(brain).dataFingerprint).toBe(fx.dataFingerprint)
    }
  })

  test('B shape đặc thù từng brain (A features-10 · B 3 đầu · C softmax nhóm)', () => {
    const a = loadEvoFixture('calibration_v3')
    expect(a.inputDim).toBe(10) // FEATURE_NAMES features-10 (V2/V3)
    expect(a.outputDim).toBe(1)
    const b = loadEvoFixture('surrogate')
    expect(b.outputDim).toBe(3) // success + tokens + duration
    expect(b.headSpans).toEqual([1, 1, 1])
    const c = loadEvoFixture('policy')
    expect(c.outputDim).toBeGreaterThanOrEqual(2) // one-hot model actions
    expect(c.headSpans).toEqual([c.outputDim]) // CE head span toàn bộ
  })

  test('C evoFolds = min(5, n) — fixture mỏng vẫn chấm được', () => {
    expect(evoFolds(4)).toBe(4)
    expect(evoFolds(13)).toBe(5)
    expect(evoFolds(1)).toBe(1)
  })
})

// ==================== P0 — SCORING tất định ====================

function mlpOnlySpec(): EvoCandidateSpec {
  const d = defaultDraftFor('calibration_v3')
  return {
    head: {
      hidden: d.hidden.map(h => ({ units: h.units, activation: h.activation })),
      hyper: { lr: d.hyper.lr, l2: d.hyper.l2, epochs: 40, batch: 4, patience: 10 },
    },
    blocks: [{ type: 'identity' }, { type: 'identity' }, { type: 'identity' }],
    headDim: 64,
  }
}

describe('r105 · EVO-P0 scoring — tất định bit-đối-bit (H4)', () => {
  test('D cùng (spec, seed) → cùng cvScore bit-đối-bit; khác seed → khác', () => {
    const fx = loadEvoFixture('calibration_v3')
    const s1 = scoreEvoCandidate(mlpOnlySpec(), fx, 42)
    const s2 = scoreEvoCandidate(mlpOnlySpec(), fx, 42)
    expect(s1.cvScore).toBe(s2.cvScore)
    expect(s1.foldLosses).toEqual(s2.foldLosses)
    expect(s1.ciLow).toBe(s2.ciLow)
    const s3 = scoreEvoCandidate(mlpOnlySpec(), fx, 7)
    // seed khác → chuỗi khác (xác suất trùng ~0)
    expect(
      s1.cvScore === s3.cvScore && s1.foldLosses.join(',') === s3.foldLosses.join(','),
    ).toBe(false)
  })

  test('E kết quả hữu hạn + params đúng + cvScore ∈ (0,1] (higher-better)', () => {
    const fx = loadEvoFixture('calibration_v3')
    const r = scoreEvoCandidate(mlpOnlySpec(), fx, 42)
    expect(Number.isFinite(r.cvScore)).toBe(true)
    expect(r.cvScore).toBeGreaterThan(0)
    expect(r.cvScore).toBeLessThanOrEqual(1)
    expect(r.ciLow).toBeLessThanOrEqual(r.cvScore)
    expect(r.cvScore).toBeLessThanOrEqual(r.ciHigh)
    expect(r.params).toBeGreaterThan(0)
    expect(r.trainMs).toBeGreaterThanOrEqual(0)
    expect(r.p95LatencyMs).toBeGreaterThanOrEqual(0)
  })

  test('F baseline heuristic hữu hạn + cùng chuẩn cvScore', () => {
    for (const brain of ['calibration_v3', 'surrogate', 'policy'] as const) {
      const bl = scoreEvoBaseline(loadEvoFixture(brain))
      expect(bl.kind).toBe('heuristic')
      expect(Number.isFinite(bl.cvScore)).toBe(true)
      expect(bl.cvScore).toBeGreaterThan(0)
      expect(bl.cvScore).toBeLessThanOrEqual(1)
    }
  })
})

// ==================== P1 — ENCODING 144 (additive §4.2) ====================

describe('r105 · EVO-P1 encoding 144 — pad/repair/decode/roundtrip', () => {
  test('G EVO_ENCODING_DIM = 144 = 96 + 48 (additive — hợp đồng 96 giữ nguyên)', () => {
    expect(EVO_ENCODING_DIM).toBe(144)
    expect(SEARCH_ENCODING_DIM).toBe(96)
  })

  test('H padEvo96to144 — vùng [96..143] toàn 0 (F4: cha legacy hợp lệ)', () => {
    const vec96 = sampleEvoCandidate(makeRng(1), 'calibration_v3', 10).slice(0, SEARCH_ENCODING_DIM)
    const padded = padEvo96to144(vec96)
    expect(padded.length).toBe(144)
    for (let i = 96; i < 144; i++) expect(padded[i]).toBe(0)
    expect(padded.slice(0, 96)).toEqual(vec96)
  })

  test('I repairEvoEncoding — one-hot đa hot → đúng 1 hot; headDim canonical; reserved = 0', () => {
    const raw = new Array<number>(144).fill(0)
    // block 1: 2 hot (mlp + attention) — repair phải giữ 1 (argmax, tie → index thấp)
    raw[96 + 1] = 1 // mlp
    raw[96 + 2] = 1 // attention
    // block 2: toàn 0 → identity (hot index 0)
    // block 3: moe
    raw[96 + 12 + 4] = 1
    // headDim lệch: block1 = 1 (128), block2 = 0 (32), block3 = 0.5 (64) → canonical = block1
    raw[114] = 1
    raw[120] = 0
    raw[126] = 0.5
    raw[136] = 0.5 // reserved phải bị zero
    const fixed = repairEvoEncoding(raw)
    let hotCount = 0
    for (let j = 0; j < 6; j++) if (fixed[96 + j] === 1) hotCount++
    expect(hotCount).toBe(1)
    expect(fixed[96 + 1]).toBe(1) // argmax tie → mlp (index thấp hơn attention)
    expect(fixed[102]).toBe(1) // block THỨ HAI (b=1, slot [102..107]) → identity tự gán
    expect(fixed[112]).toBe(1) // block THỨ BA (b=2, slot [108..113]) moe giữ
    // headDim 3 slot bằng nhau = 128 (từ block 1)
    expect(fixed[114]).toBe(fixed[120])
    expect(fixed[120]).toBe(fixed[126])
    expect(fixed[136]).toBe(0)
    for (let j = 136; j < 144; j++) expect(fixed[j]).toBe(0)
  })

  test('J decode pad-96 → THUẦN MLP (mọi block identity — F4 "vùng block toàn 0")', () => {
    const d = defaultDraftFor('calibration_v3')
    // encode draft thật qua encodeDraft (96) rồi pad
    const vec96 = encodeDraft(d, 10)
    const spec = decodeEvoCandidate(padEvo96to144(vec96), 'calibration_v3')
    for (const b of spec.blocks) expect(b.type).toBe('identity')
    expect(spec.head.hidden.length).toBe(d.hidden.length)
    expect(spec.head.hidden[0]!.units).toBe(d.hidden[0]!.units)
  })

  test('K decodeEvoCandidate với block thật → spec đầy đủ tham số hợp lệ', () => {
    // base HN hợp lệ cho surrogate (one-hot brain [93..95] phải đúng — decodeDraft chặn)
    const base96 = encodeDraft(sampleCandidate(makeRng(3), 'surrogate', 9).spec, 9)
    const raw = padEvo96to144(base96)
    raw[96 + 2] = 1 // block ĐẦU (b=0, slot [96..101]) attention
    raw[96 + 12 + 3] = 1 // block THỨ BA (b=2, slot [108..113]) ssm
    raw[114] = 0.5 // headDim 64 (slot headDim block 0 — canonical cho cả mạng)
    raw[127] = 1 // ssmN 16 — slot của block THỨ BA (114 + 2·6 + 1)
    raw[116] = 0.5 // expansion block 0 → round(1+3·0.5)=3
    raw[132] = 1 // kExperts 4
    const spec = decodeEvoCandidate(raw, 'surrogate')
    expect(spec.blocks[0]!.type).toBe('attention')
    expect(spec.blocks[0]!.headDim).toBe(64)
    expect(spec.blocks[1]!.type).toBe('identity')
    expect(spec.blocks[2]!.type).toBe('ssm')
    expect(spec.blocks[2]!.ssmN).toBe(16)
    expect(spec.headDim).toBe(64)
    expect(spec.moeGlobal!.kExperts).toBe(4)
  })

  test('L sampler + repair: 50 lần sinh → decode LUÔN hợp lệ (không ứng viên hỏng — F8)', () => {
    const rng = makeRng(2026)
    for (let i = 0; i < 50; i++) {
      const vec = sampleEvoCandidate(rng, 'surrogate', 9)
      expect(vec.length).toBe(144)
      for (const v of vec) {
        expect(Number.isFinite(v)).toBe(true)
        expect(v).toBeGreaterThanOrEqual(0)
        expect(v).toBeLessThanOrEqual(1)
      }
      // mọi block: đúng 1 hot trong 6
      for (let b = 0; b < 3; b++) {
        let hot = 0
        for (let j = 0; j < 6; j++) if (vec[96 + b * 6 + j] === 1) hot++
        expect(hot).toBe(1)
      }
      const spec = decodeEvoCandidate(vec, 'surrogate') // không throw
      for (const blk of spec.blocks) {
        expect(EVO_BLOCK_TYPES.includes(blk.type)).toBe(true)
      }
    }
  })

  test('M roundtrip: one-hot block GIỮ NGUYÊN + điểm cố định sau 1 vòng (canonical lượng tử hoá)', () => {
    const rng = makeRng(77)
    for (let i = 0; i < 10; i++) {
      const vec = sampleEvoCandidate(rng, 'policy', 7)
      const spec = decodeEvoCandidate(vec, 'policy')
      const re = encodeEvoCandidate(spec, 'policy', 7)
      // (a) one-hot block-type [96..113] khớp CHÍNH XÁC
      for (let j = 96; j < 114; j++) expect(re[j]).toBe(vec[j])
      // (b) slot rời rạc chốt về giá trị canonical: vòng 2 không đổi nữa
      const spec2 = decodeEvoCandidate(re, 'policy')
      const re2 = encodeEvoCandidate(spec2, 'policy', 7)
      expect(re2).toEqual(re)
    }
  })

  test('N mutate + crossover → vector 144 hợp lệ + repair áp', () => {
    const rng = makeRng(9)
    const a = sampleEvoCandidate(rng, 'calibration_v3', 10)
    const b = sampleEvoCandidate(rng, 'calibration_v3', 10)
    const m = mutateEvo(a, rng)
    expect(m.length).toBe(144)
    for (const blk of decodeEvoCandidate(m, 'calibration_v3').blocks) {
      expect(EVO_BLOCK_TYPES.includes(blk.type)).toBe(true)
    }
    // crossover với cha 96-dim legacy (F4)
    const legacy96 = a.slice(0, 96)
    const c = crossoverEvo(legacy96, b, rng)
    expect(c.length).toBe(144)
    expect(() => decodeEvoCandidate(c, 'calibration_v3')).not.toThrow()
    // crossover 2 cha 144
    const c2 = crossoverEvo(a, b, rng)
    expect(c2.length).toBe(144)
  })

  test('O tất định sampler: cùng seed → cùng chuỗi 50 vector', () => {
    const r1 = makeRng(555)
    const r2 = makeRng(555)
    for (let i = 0; i < 5; i++) {
      expect(sampleEvoCandidate(r1, 'policy', 7)).toEqual(sampleEvoCandidate(r2, 'policy', 7))
    }
  })
})
