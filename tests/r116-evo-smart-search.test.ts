/**
 * r116 — EVO-P4.1 SMART SEARCH (R26): cơ chế TÍNH TOÁN kích thước kiến trúc
 * ============================================================================
 *
 * Trả lời user 2026-10-17: "NAS có cơ chế tính toán để xác định ra số lớp và
 * số nơ ron hiệu quả hơn chưa?" — 3 mảnh: suggestArch (bộ ước lượng giải
 * tích từ dữ liệu fixture) + pickTournamentParent (cha theo giải đấu k=3,
 * thay uniform) + adaptiveMutationRate (0,15 → 0,06). Pin:
 *  - Bảng ngưỡng số lớp (n<100→1 · n<1000→2 · else 3) + kẹp chiều rộng [8..256]
 *  - Kim tự tháp hình học: chiều rộng KHÔNG TĂNG dần khi in ≥ out
 *  - Trần dung lượng theo dữ liệu: paramsEstimate ≤ paramsCap mọi trường hợp
 *  - Tournament: luôn trả 1 thành viên; xác suất chọn cha điểm cao > uniform
 *  - Rate thích ứng: đơn điệu giảm, biên pin 0,15/0,06, clamp ngoài biên
 *  - Hạt giống #0: suggestionToEncoding → 144-dim hợp lệ, decode ra thuần
 *    MLP (blocks toàn identity) + hidden khớp số lớp đề xuất
 *  - GET suggestion (getEvoRunState) có đủ trường cho não có fixture
 */

import { describe, expect, test } from 'bun:test'
import {
  adaptiveMutationRate,
  estimateMlpParams,
  pickTournamentParent,
  suggestArch,
  suggestLayerCount,
  suggestionToEncoding,
  MUTATION_RATE_END,
  MUTATION_RATE_START,
  SUGGEST_UNITS_MAX,
  SUGGEST_UNITS_MIN,
  TOURNAMENT_K,
} from '../src/lib/brain/evo/smart-search'
import { makeRng } from '../src/lib/brain/init'
import { decodeEvoCandidate, EVO_ENCODING_DIM, repairEvoEncoding } from '../src/lib/brain/search-space'
import { loadEvoFixture } from '../src/lib/brain/evo/benchmark'
import { getEvoRunState } from '../src/lib/brain/evolve'

describe('r116 · suggestArch — bộ ước lượng giải tích từ dữ liệu', () => {
  test('A tất định: cùng input → cùng output bit-đối-bit (H4)', () => {
    const a = suggestArch({ brain: 'policy', inputDim: 7, outputDim: 6, nSamples: 31 })
    const b = suggestArch({ brain: 'policy', inputDim: 7, outputDim: 6, nSamples: 31 })
    expect(a).toEqual(b)
  })

  test('B bảng ngưỡng số lớp pin: <100→1 · <1000→2 · ≥1000→3', () => {
    expect(suggestLayerCount(1)).toBe(1)
    expect(suggestLayerCount(4)).toBe(1)
    expect(suggestLayerCount(99)).toBe(1)
    expect(suggestLayerCount(100)).toBe(2)
    expect(suggestLayerCount(999)).toBe(2)
    expect(suggestLayerCount(1000)).toBe(3)
    expect(suggestLayerCount(100_000)).toBe(3)
  })

  test('C kim tự tháp hình học: chiều rộng không tăng dần khi in ≥ out (2+ lớp)', () => {
    // n=500 → 2 lớp; in 64 ≥ out 4
    const s = suggestArch({ brain: 'surrogate', inputDim: 64, outputDim: 4, nSamples: 500 })
    expect(s.nLayers).toBe(2)
    expect(s.hidden.length).toBe(2)
    for (let j = 1; j < s.hidden.length; j++) {
      expect(s.hidden[j].units).toBeLessThanOrEqual(s.hidden[j - 1].units)
    }
    // n=5000 → 3 lớp, bất biến tương tự
    const s3 = suggestArch({ brain: 'policy', inputDim: 128, outputDim: 8, nSamples: 5_000 })
    expect(s3.nLayers).toBe(3)
    for (let j = 1; j < s3.hidden.length; j++) {
      expect(s3.hidden[j].units).toBeLessThanOrEqual(s3.hidden[j - 1].units)
    }
  })

  test('D trần dung lượng: paramsEstimate ≤ paramsCap, NẾU KHÔNG thì mọi chiều rộng đã chạm sàn 8', () => {
    // dữ liệu ít + dims lớn → pyramid có thể vượt cap → co theo √(cap/P);
    // dims I/O KHỔNG LỒ (vd 512×256) thì trọng số vào/ra tự vượt cap dù width
    // tối thiểu — bất biến trung thực: hoặc đạt cap, hoặc đã co tới sàn.
    const check = (s: ReturnType<typeof suggestArch>) => {
      if (s.paramsEstimate > s.paramsCap) {
        for (const h of s.hidden) expect(h.units).toBe(SUGGEST_UNITS_MIN)
      } else {
        expect(s.paramsEstimate).toBeLessThanOrEqual(s.paramsCap)
      }
    }
    check(suggestArch({ brain: 'surrogate', inputDim: 512, outputDim: 256, nSamples: 30 }))
    // cap không vượt ngân sách
    expect(suggestArch({ brain: 'surrogate', inputDim: 512, outputDim: 256, nSamples: 30 }).paramsCap).toBeLessThanOrEqual(250_000)
    // trường hợp cực đoan: 10K mẫu, in 1024, out 512, budget nhỏ
    check(suggestArch({ brain: 'policy', inputDim: 1_024, outputDim: 512, nSamples: 10_000, paramsBudget: 50_000 }))
    expect(suggestArch({ brain: 'policy', inputDim: 1_024, outputDim: 512, nSamples: 10_000, paramsBudget: 50_000 }).paramsCap).toBeLessThanOrEqual(50_000)
    // trường hợp thường (dims nhỏ): cap luôn đạt được
    const ok = suggestArch({ brain: 'policy', inputDim: 64, outputDim: 8, nSamples: 40 })
    expect(ok.paramsEstimate).toBeLessThanOrEqual(ok.paramsCap)
  })

  test('E kẹp chiều rộng [8..256] + activation theo default draft', () => {
    // dataScale max 2 + dims lớn → không vượt 256
    const big = suggestArch({ brain: 'surrogate', inputDim: 256, outputDim: 256, nSamples: 10_000 })
    for (const h of big.hidden) {
      expect(h.units).toBeGreaterThanOrEqual(SUGGEST_UNITS_MIN)
      expect(h.units).toBeLessThanOrEqual(SUGGEST_UNITS_MAX)
      expect(typeof h.activation).toBe('string')
      expect(h.activation.length).toBeGreaterThan(0)
    }
    // dữ liệu siêu ít + dims nhỏ → sàn 8 (không suy biến về 1-2)
    const tiny = suggestArch({ brain: 'calibration_v3', inputDim: 3, outputDim: 1, nSamples: 2 })
    for (const h of tiny.hidden) {
      expect(h.units).toBeGreaterThanOrEqual(SUGGEST_UNITS_MIN)
    }
  })

  test('F fixture THẬT 3 não: kích thước hợp lệ + rationale tiếng Việt đủ ý', () => {
    for (const brain of ['calibration_v3', 'surrogate', 'policy'] as const) {
      const fx = loadEvoFixture(brain)
      const s = suggestArch({ brain, inputDim: fx.inputDim, outputDim: fx.outputDim, nSamples: fx.nSamples })
      expect(s.nSamples).toBe(fx.nSamples)
      expect(s.hidden.length).toBe(s.nLayers)
      expect(s.hidden.length).toBeGreaterThanOrEqual(1)
      expect(s.paramsEstimate).toBeGreaterThan(0)
      // rationale nêu đủ: số mẫu, số lớp, rationale có "lớp ẩn" + "tham số"
      expect(s.rationale).toContain(`${fx.nSamples} mẫu`)
      expect(s.rationale).toContain('lớp ẩn')
      expect(s.rationale).toContain('tham số')
    }
  })

  test('G input vô lý → throw rõ ràng', () => {
    expect(() => suggestArch({ brain: 'policy', inputDim: 0, outputDim: 3, nSamples: 10 })).toThrow()
    expect(() => suggestArch({ brain: 'policy', inputDim: 5, outputDim: -1, nSamples: 10 })).toThrow()
  })

  test('H estimateMlpParams khớp công thức (kèm bias) — tay chấm', () => {
    // in 10 → [8] → out 1: 10·8+8 + 8·1+1 = 97
    expect(estimateMlpParams(10, [8], 1)).toBe(97)
    // in 7 → [10, 6] → out 3: 7·10+10 + 10·6+6 + 6·3+3 = 80+66+21 = 167
    expect(estimateMlpParams(7, [10, 6], 3)).toBe(167)
  })
})

describe('r116 · pickTournamentParent — cha theo giải đấu (thay uniform)', () => {
  const enc = (v: number): number[] => [v, 0, 0]
  const encodings = [enc(1), enc(2), enc(3), enc(4)]
  const scores = [0.1, 0.2, 0.9, 0.3] // cha tốt = index 2 (giá trị 3)

  test('I tất định theo rng + luôn trả 1 thành viên (bản sao)', () => {
    const rng1 = makeRng(42)
    const rng2 = makeRng(42)
    for (let t = 0; t < 20; t++) {
      const a = pickTournamentParent(encodings, scores, rng1)
      const b = pickTournamentParent(encodings, scores, rng2)
      expect(a).toEqual(b)
      expect(encodings.some(e => e === a)).toBe(false) // bản SAO, không phải tham chiếu
      expect([1, 2, 3, 4]).toContain(a[0])
    }
  })

  test('J khai thác: cha điểm cao được chọn NHIỀU HƠN uniform (40 lần seeded)', () => {
    const rng = makeRng(7)
    let best = 0
    const N = 40
    for (let t = 0; t < N; t++) {
      const p = pickTournamentParent(encodings, scores, rng)
      if (p[0] === 3) best++
    }
    // uniform kỳ vọng 10/40; tournament k=3 lý thuyết ~1−(3/4)³ ≈ 58%… nhưng
    // chỉ cần > uniform kỳ vọng (25%) là chứng minh có khai thác thật
    expect(best).toBeGreaterThan(N / 4)
  })

  test('K mảng không song song → throw; 1 cha → trả bản sao chính nó', () => {
    expect(() => pickTournamentParent(encodings, [0.1, 0.2], makeRng(1))).toThrow()
    const solo = pickTournamentParent([[9, 9]], [0.5], makeRng(1))
    expect(solo).toEqual([9, 9])
    expect(TOURNAMENT_K).toBe(3)
  })
})

describe('r116 · adaptiveMutationRate — khám phá sớm, khai thác muộn', () => {
  test('L biên pin + đơn điệu giảm + clamp ngoài biên', () => {
    expect(MUTATION_RATE_START).toBe(0.15)
    expect(MUTATION_RATE_END).toBe(0.06)
    expect(adaptiveMutationRate(0, 8)).toBeCloseTo(0.15, 10)
    expect(adaptiveMutationRate(7, 8)).toBeCloseTo(0.06, 10)
    // đơn điệu
    let prev = Infinity
    for (let d = 0; d <= 7; d++) {
      const r = adaptiveMutationRate(d, 8)
      expect(r).toBeLessThanOrEqual(prev)
      expect(r).toBeGreaterThanOrEqual(MUTATION_RATE_END)
      prev = r
    }
    // clamp ngoài biên + total=1
    expect(adaptiveMutationRate(-5, 8)).toBeCloseTo(0.15, 10)
    expect(adaptiveMutationRate(99, 8)).toBeCloseTo(0.06, 10)
    expect(adaptiveMutationRate(0, 1)).toBeCloseTo(0.15, 10)
  })
})

describe('r116 · hạt giống #0 — suggestionToEncoding (vòng evolve khởi đầu bằng kiến trúc ĐÃ TÍNH)', () => {
  test('M encoding 144 hợp lệ + repair idempotent + decode ra thuần MLP đúng số lớp', () => {
    const fx = loadEvoFixture('policy')
    const sug = suggestArch({ brain: 'policy', inputDim: fx.inputDim, outputDim: fx.outputDim, nSamples: fx.nSamples })
    const enc = suggestionToEncoding(sug, 'policy', fx.inputDim)
    expect(enc.length).toBe(EVO_ENCODING_DIM)
    expect(repairEvoEncoding(enc)).toEqual(enc) // đã canonical
    const spec = decodeEvoCandidate(enc, 'policy')
    // thuần MLP: blocks toàn identity (khởi đầu sạch — block là việc của evolve)
    expect(spec.blocks.every(b => b.type === 'identity')).toBe(true)
    // số lớp khớp đề xuất; units trong biên editor; activation hợp lệ menu
    expect(spec.head.hidden.length).toBe(sug.nLayers)
    for (const h of spec.head.hidden) {
      expect(h.units).toBeGreaterThanOrEqual(1)
      expect(h.units).toBeLessThanOrEqual(256)
    }
  })

  test('N 3 não đều dựng được hạt giống (không throw)', () => {
    for (const brain of ['calibration_v3', 'surrogate', 'policy'] as const) {
      const fx = loadEvoFixture(brain)
      const sug = suggestArch({ brain, inputDim: fx.inputDim, outputDim: fx.outputDim, nSamples: fx.nSamples })
      expect(() => suggestionToEncoding(sug, brain, fx.inputDim)).not.toThrow()
    }
  })
})

describe('r116 · GET suggestion — contract response evolve (additive)', () => {
  test('O não có fixture: suggestion đầy đủ trường; knowledge: không có suggestion', async () => {
    const res = await getEvoRunState('policy')
    expect(res.ok).toBe(true)
    expect(res.suggestion).toBeDefined()
    const s = res.suggestion!
    expect(s.brain).toBe('policy')
    expect(s.hidden.length).toBeGreaterThanOrEqual(1)
    expect(s.nLayers).toBe(s.hidden.length)
    expect(s.paramsEstimate).toBeGreaterThan(0)
    expect(s.rationale.length).toBeGreaterThan(20)
    // knowledge chưa vào search space (D4 §8.4) → không suggestion, UI hiện thông báo D4
    const kn = await getEvoRunState('knowledge')
    expect(kn.ok).toBe(true)
    expect(kn.suggestion).toBeUndefined()
  })
})
