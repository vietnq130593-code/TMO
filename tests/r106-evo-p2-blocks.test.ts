/**
 * r106 — EVO-P2 (BLUEPRINT-EVO-NAO-P1-P5 §4.3 — R24-c) — BLOCK ENGINE
 * ============================================================================
 *
 * Kiểm định then chốt: NUMERICAL GRADIENT CHECK từng loại block (attention /
 * SSM / gated / mlp / moe) — đạo hàm viết tay phải khớp sai phân hữu hạn
 * (relative error < 1e-3). Đây là bằng nghiệm cho toàn bộ backward của block
 * engine — sai ở đây = train block ứng viên học SAI.
 *
 * Kèm: quy tắc toSequence/flatten (r105 pin), tính CAUSAL của attention
 * (token tương lai KHÔNG ảnh hưởng output quá khứ), SSM phụ thuộc quá khứ,
 * tất định H4, đếm tham số, formatArchSummary single-source.
 */

import { describe, expect, test } from 'bun:test'
import {
  toSequence,
  flattenSeq,
  buildEvoBlock,
  countBlockParams,
  formatArchSummary,
  EVO_BLOCK_TYPES,
  type EvoBlock,
} from '../src/lib/brain/evo/blocks'
import { MoEBlock, countMoeParams, moeExpertCount, MOE_MIN_SAMPLES, MOE_AUX_WEIGHT } from '../src/lib/brain/evo/moe'
import { makeRng } from '../src/lib/brain/init'

// ==================== HELPERS ====================

/** Dựng block + buffer + init tất định. */
function setupBlock(
  build: () => { block: EvoBlock; moeSkipped: boolean },
): { block: EvoBlock; params: Float64Array; grads: Float64Array } {
  const { block } = build()
  const params = new Float64Array(block.paramCount)
  const grads = new Float64Array(block.paramCount)
  block.attach(params, grads, 0)
  block.initParams(makeRng(42))
  return { block, params, grads }
}

/** Chuỗi đầu vào cố định (seeded — tất định). */
function fixedSeq(L: number, d: number, seed = 7): Float64Array[] {
  const rng = makeRng(seed)
  return Array.from({ length: L }, () => {
    const t = new Float64Array(d)
    for (let i = 0; i < d; i++) t[i] = rng() * 2 - 1
    return t
  })
}

/**
 * NUMERICAL GRADIENT CHECK: loss = Σ_t Σ_z coef[t][z]·out[t][z] (+ aux nếu
 * block moe). Analytic qua backwardSeq(coef); numerical qua sai phân trung
 * tâm eps. Trả relative error lớn nhất.
 */
function maxRelGradErr(
  block: EvoBlock,
  params: Float64Array,
  grads: Float64Array,
  seq: Float64Array[],
  eps = 1e-5,
): number {
  const L = seq.length
  const d = block.tokenDim
  const rng = makeRng(99)
  const coef = Array.from({ length: L }, () => {
    const c = new Float64Array(d)
    for (let i = 0; i < d; i++) c[i] = rng() * 2 - 1
    return c
  })
  const lossOf = (): number => {
    const out = block.forwardSeq(seq)
    let s = 0
    for (let t = 0; t < L; t++) for (let z = 0; z < d; z++) s += coef[t][z] * out[t][z]
    const aux = (block as { lastAuxLoss?: number }).lastAuxLoss ?? 0
    return s + aux
  }
  // analytic
  grads.fill(0)
  block.forwardSeq(seq)
  block.backwardSeq(coef)
  let maxErr = 0
  for (let i = 0; i < params.length; i++) {
    const saved = params[i]
    params[i] = saved + eps
    const lp = lossOf()
    params[i] = saved - eps
    const lm = lossOf()
    params[i] = saved
    const num = (lp - lm) / (2 * eps)
    const ana = grads[i]
    const denom = Math.max(1e-8, Math.abs(num) + Math.abs(ana))
    const rel = Math.abs(num - ana) / denom
    if (rel > maxErr) maxErr = rel
  }
  return maxErr
}

// ==================== CHUỖI TOKEN ====================

describe('r106 · EVO-P2 — toSequence/flattenSeq (quy tắc tất định r105-pin)', () => {
  test('A chia đều: dim 12, headDim 4 → 3 token nguyên vẹn', () => {
    const seq = toSequence([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], 4)
    expect(seq.length).toBe(3)
    expect(Array.from(seq[0]!)).toEqual([1, 2, 3, 4])
    expect(Array.from(seq[2]!)).toEqual([9, 10, 11, 12])
  })

  test('B dư ra: dim 10, headDim 4 → 3 token, token cuối đệm 0', () => {
    const seq = toSequence([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 4)
    expect(seq.length).toBe(3)
    expect(Array.from(seq[2]!)).toEqual([9, 10, 0, 0])
  })

  test('C dim < headDim → 1 token đệm 0 (L=1退化 an toàn)', () => {
    const seq = toSequence([1, 2, 3], 8)
    expect(seq.length).toBe(1)
    expect(Array.from(seq[0]!)).toEqual([1, 2, 3, 0, 0, 0, 0, 0])
  })

  test('D flattenSeq đảo toSequence (đệm giữ nguyên)', () => {
    const x = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
    const flat = flattenSeq(toSequence(x, 4))
    expect(flat.length).toBe(12) // 3 token × 4
    expect(flat.slice(0, 10)).toEqual(x)
    expect(flat[10]).toBe(0)
  })
})

// ==================== NUMERICAL GRADIENT CHECK (then chốt) ====================

describe('r106 · EVO-P2 — numerical gradient check (backward viết tay ĐÚNG)', () => {
  test('E EvoDense (mlp block) — grad khớp sai phân < 1e-3', () => {
    const { block, params, grads } = setupBlock(() =>
      buildEvoBlock({ type: 'mlp', expansion: 2 }, 4),
    )
    expect(maxRelGradErr(block, params, grads, fixedSeq(3, 4))).toBeLessThan(1e-3)
  })

  test('F attention-causal-1head — grad khớp sai phân < 1e-3', () => {
    const { block, params, grads } = setupBlock(() =>
      buildEvoBlock({ type: 'attention', headDim: 4 }, 4),
    )
    expect(maxRelGradErr(block, params, grads, fixedSeq(4, 4))).toBeLessThan(1e-3)
  })

  test('G selective-SSM (N=8) — grad khớp sai phân < 1e-3 (BPTT qua scan)', () => {
    const { block, params, grads } = setupBlock(() =>
      buildEvoBlock({ type: 'ssm', ssmN: 8 }, 4),
    )
    expect(maxRelGradErr(block, params, grads, fixedSeq(4, 4))).toBeLessThan(1e-3)
  })

  test('H gated-residual — grad khớp sai phân < 1e-3', () => {
    const { block, params, grads } = setupBlock(() =>
      buildEvoBlock({ type: 'gated', residualScale: 1.2 }, 4),
    )
    expect(maxRelGradErr(block, params, grads, fixedSeq(3, 4))).toBeLessThan(1e-3)
  })

  test('I micro-MoE (k=2) — grad khớp sai phân < 1e-3 (kể cả aux loss)', () => {
    const { block, params, grads } = setupBlock(() =>
      buildEvoBlock({ type: 'moe', moeK: 2 }, 4, { nSamples: MOE_MIN_SAMPLES }),
    )
    expect(maxRelGradErr(block, params, grads, fixedSeq(3, 4))).toBeLessThan(1e-3)
  })
})

// ==================== TÍNH CHẤT CẤU TRÚC ====================

describe('r106 · EVO-P2 — tính chất cấu trúc (causal · quá khứ · tất định)', () => {
  test('J attention CAUSAL: đổi token tương lai KHÔNG đổi output quá khứ', () => {
    const { block } = setupBlock(() => buildEvoBlock({ type: 'attention', headDim: 4 }, 4))
    const seq = fixedSeq(4, 4)
    const out1 = block.forwardSeq(seq)
    const mutated = seq.slice()
    mutated[3] = Float64Array.from([9, 9, 9, 9]) // đổi token CUỐI
    const out2 = block.forwardSeq(mutated)
    // output token 0..2 phải GIỐNG HỆT (causal mask)
    for (let t = 0; t < 3; t++) {
      expect(Array.from(out2[t]!)).toEqual(Array.from(out1[t]!))
    }
    // output token cuối phải KHÁC (token 3 tự chú ý)
    expect(Array.from(out2[3]!)).not.toEqual(Array.from(out1[3]!))
  })

  test('K SSM: đổi token ĐẦU làm đổi output CUỐI (state lan truyền quá khứ)', () => {
    const { block } = setupBlock(() => buildEvoBlock({ type: 'ssm', ssmN: 8 }, 4))
    const seq = fixedSeq(4, 4)
    const out1 = block.forwardSeq(seq)
    const mutated = seq.slice()
    mutated[0] = Float64Array.from([5, 5, 5, 5])
    const out2 = block.forwardSeq(mutated)
    expect(Array.from(out2[3]!)).not.toEqual(Array.from(out1[3]!))
  })

  test('L tất định: cùng input + cùng params → cùng output (H4)', () => {
    for (const type of ['mlp', 'attention', 'ssm', 'gated'] as const) {
      const { block } = setupBlock(() => buildEvoBlock({ type, headDim: 4, ssmN: 8 }, 4))
      const seq = fixedSeq(3, 4)
      const o1 = block.forwardSeq(seq)
      const o2 = block.forwardSeq(seq)
      expect(o2.map(t => Array.from(t))).toEqual(o1.map(t => Array.from(t)))
    }
  })

  test('M đếm tham số từng block đúng công thức (single-source)', () => {
    expect(countBlockParams({ type: 'identity' }, 4)).toBe(0)
    expect(countBlockParams({ type: 'mlp', expansion: 2 }, 4)).toBe((8 * 4 + 8) + (4 * 8 + 4)) // FFN 2 lớp: up(h·d+h) + down(d·h+d) — R24-c fix giữ chiều token
    expect(countBlockParams({ type: 'attention' }, 4)).toBe(4 * 16 + 16)
    expect(countBlockParams({ type: 'ssm', ssmN: 8 }, 4)).toBe(3 * 8 * 4 + 3 * 8 + 4)
    expect(countBlockParams({ type: 'gated' }, 4)).toBe(2 * 16 + 8)
    // khớp buffer thật
    for (const spec of [
      { type: 'attention', headDim: 6 },
      { type: 'ssm', ssmN: 16 },
      { type: 'gated', residualScale: 1 },
    ] as const) {
      const { block } = setupBlock(() => buildEvoBlock(spec, 6))
      expect(block.paramCount).toBe(countBlockParams(spec, 6))
    }
  })

  test('N EVO_BLOCK_TYPES đúng thứ tự pin encoding (§4.2)', () => {
    expect(EVO_BLOCK_TYPES).toEqual(['identity', 'mlp', 'attention', 'ssm', 'moe', 'gated'])
  })
})

// ==================== MoE (P3 — chi tiết ở r107, đây chỉ khớp engine) ====================

describe('r106 · EVO-P2↔P3 — buildEvoBlock moe gate Q4', () => {
  test('O moe dưới MOE_MIN_SAMPLES → identity + moeSkipped (Q4 động)', () => {
    const { block, moeSkipped } = buildEvoBlock({ type: 'moe', moeK: 2 }, 4, { nSamples: 100 })
    expect(moeSkipped).toBe(true)
    expect(block.spec.type).toBe('identity')
    expect(block.paramCount).toBe(0)
  })

  test('P moe đủ mẫu → MoEBlock thật + expert count', () => {
    const { block, moeSkipped } = buildEvoBlock({ type: 'moe', moeK: 3 }, 4, { nSamples: MOE_MIN_SAMPLES })
    expect(moeSkipped).toBe(false)
    expect(block).toBeInstanceOf(MoEBlock)
    expect((block as MoEBlock).experts.length).toBe(moeExpertCount({ type: 'moe', moeK: 3 }))
    expect(block.paramCount).toBe(countMoeParams({ type: 'moe', moeK: 3 }, 4))
  })
})

// ==================== FORMAT ARCH SUMMARY ====================

describe('r106 · EVO-P2 — formatArchSummary (single-source server/UI §5.3)', () => {
  test('Q thuần MLP → MLP[units]; có block → chuỗi compact đúng định dạng', () => {
    expect(formatArchSummary([{ type: 'identity' }, { type: 'identity' }, { type: 'identity' }], [16])).toBe('MLP[16]')
    expect(
      formatArchSummary(
        [
          { type: 'identity' },
          { type: 'attention', headDim: 64 },
          { type: 'ssm', ssmN: 16 },
        ],
        [128, 64],
      ),
    ).toBe('[attn1h·64] → [ssm·N16] → MLP[128,64]')
    expect(
      formatArchSummary([{ type: 'gated', residualScale: 1.5 }, { type: 'identity' }, { type: 'moe', moeK: 2 }], [32]),
    ).toBe('[gated·1.5] → [moe·k2] → MLP[32]')
  })
})
