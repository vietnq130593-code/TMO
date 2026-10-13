/**
 * ROUND-100 TESTS — HN-P1 (BLUEPRINT-HYPERNAS-P1-P5 §4.1-5 — Task 26-c)
 * SEARCH SPACE: encoding 96 chiều tất định + bijective + sampler trong biên
 * ============================================================================
 *
 * Đo lường (§4.1-5):
 *   A. Hằng số pin: 96 chiều (bắt lỗi đếm slot kiểu v0.1 "87 chiều" — hiệu
 *      đính §3.1) · ngân sách H3 (24 ứng viên / 600_000 ms) · prune H5
 *      (5 session / 60 ứng viên) · SAMPLER_RETRY_MAX 20 · SEED_MAX 2^31−1 ·
 *      menu đơn ACT_ORDER/LOSS_ORDER/BRAIN_KEY_ORDER + công thức logNorm.
 *   B. Pin slot layout bằng SỐ CHÍNH XÁC ([0] nLayers/6 · [1..6] units/256 ·
 *      [7..60] one-hot · [61..66] α/β · [67..78] loss · [79..81] weight ·
 *      [82] δ · [83..91] hyper · [92] inputDim · [93..95] brain).
 *   C. Bijective sweep ≥ 40 case: 3 brain × biên DRAFT_LIMITS (0 lớp · 1/256
 *      unit · 6 lớp trộn · 8 activation hidden — softmax bỏ (audit B1) ·
 *      α/β có/không key · hyper 2 biên · B heads 2/3 đổi huber⇄mse + δ cùng
 *      nhau + weight Σ=1) → encode → decode → deep-compare normalized spec.
 *   D. Mọi thành phần encode ∈ [0,1] — quét min/max từng slot trên toàn bộ
 *      vector của sweep + 3000 mẫu sampler.
 *   E. Tất định H4: makeRng cùng seed → sampleCandidate 1000 mẫu × 3 brain
 *      ra CÙNG dãy spec (JSON) · mọi spec encode đủ 96 chiều · decode(encode)
 *      khớp · attempts ≥ 1.
 *   F. Sampler trong biên: 1000 mẫu/brain qua validateBrainDraft hết ok;
 *      fallback default < 5%.
 *   G. Decode vector rác → throw 'vector rác: <lý do>' (ngắn 10 / dài 97 /
 *      NaN / âm / > 1 / one-hot brain lệch / one-hot activation rỗng /
 *      softmax ở hidden).
 *   H. Quyết định thiết kế: δ slot = δ head huber ĐẦU (cùng δ round-trip
 *      đúng; khác δ collapse — có chủ đích) · α/β "không key" ≡ "key =
 *      default engine" (2 spec encode ra CÙNG vector) · weight A/C khóa rule.
 *
 * Nguyên tắc test:
 * - THUẦN — KHÔNG import db (search-space là lib thuần; bunfig preload
 *   db-isolation vẫn chạy nhưng file này không đụng bảng nào).
 * - Mọi expected DẪN NGUỒN ĐƯỢC (comment công thức / số slot từ §3.1).
 * - So sánh round-trip bằng deep-compare có dung sai 1e-9 cho số thực
 *   (đảo log/linear không bit-đối-xác-bit ~1 ulp — quyết định thiết kế #8
 *   search-space.ts); cấu trúc (key presence/activation/loại loss) so SÁT.
 */

import { describe, test, expect } from 'bun:test'
import { makeRng } from '@/lib/brain/init'
import {
  ACT_ORDER,
  BRAIN_KEY_ORDER,
  HIDDEN_ACT_ORDER,
  LOSS_ORDER,
  SAMPLER_RETRY_MAX,
  SEARCH_CANDIDATES_KEEP,
  SEARCH_ENCODING_DIM,
  SEARCH_MAX_CANDIDATES,
  SEARCH_MAX_WALL_MS,
  SEARCH_SESSIONS_KEEP,
  SEED_MAX,
  decodeDraft,
  encodeDraft,
  logDenorm,
  logNorm,
  sampleCandidate,
} from '@/lib/brain/search-space'
import {
  BRAIN_DRAFT_RULES,
  DRAFT_LIMITS,
  defaultDraftFor,
  validateBrainDraft,
  type BrainDraftSpec,
} from '@/lib/brain/spec-schema'
import type { BrainKey } from '@/lib/brain/registry'

// ==================== HELPERS ====================

const BRAINS: readonly BrainKey[] = ['calibration_v3', 'surrogate', 'policy']

/** inputUnits theo rule từng brain (A: 10 cố định features-10; B/C: null động) — single-source. */
function inputUnitsFor(brain: BrainKey): number | null {
  return BRAIN_DRAFT_RULES[brain].inputUnits
}

/** Bản sao sâu default draft (base mọi case biến đổi). */
function baseSpec(brain: BrainKey): BrainDraftSpec {
  return JSON.parse(JSON.stringify(defaultDraftFor(brain))) as BrainDraftSpec
}

/**
 * Deep-compare 2 spec: cấu trúc (key presence — bỏ qua undefined, activation,
 * loại loss, optimizer, độ dài mảng) so SÁT; số thực dung sai 1e-9 tương đối
 * (log/linear denorm lệch ~1 ulp; nguyên lệch ≥ 1 vẫn bốc lỗi).
 */
const FLOAT_TOL = 1e-9
function specEquals(a: unknown, b: unknown, path: string, problems: string[]): boolean {
  if (a === undefined && b === undefined) return true
  if (typeof a === 'number' && typeof b === 'number') {
    if (a === b) return true
    if (Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= FLOAT_TOL * Math.max(1, Math.abs(a), Math.abs(b))) return true
    problems.push(`${path}: ${a} ≠ ${b}`)
    return false
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) {
      problems.push(`${path}: length ${a.length} ≠ ${b.length}`)
      return false
    }
    let ok = true
    for (let i = 0; i < a.length; i++) if (!specEquals(a[i], b[i], `${path}[${i}]`, problems)) ok = false
    return ok
  }
  if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a as Record<string, unknown>).filter(k => (a as Record<string, unknown>)[k] !== undefined)
    const kb = Object.keys(b as Record<string, unknown>).filter(k => (b as Record<string, unknown>)[k] !== undefined)
    if (ka.length !== kb.length || !ka.every(k => kb.includes(k))) {
      problems.push(`${path}: keys [${ka.join(',')}] ≠ [${kb.join(',')}]`)
      return false
    }
    let ok = true
    for (const k of ka) if (!specEquals((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${path}.${k}`, problems)) ok = false
    return ok
  }
  if (a !== b) {
    problems.push(`${path}: ${String(a)} ≠ ${String(b)}`)
    return false
  }
  return true
}

/** Chốt round-trip: normalize gốc → encode → decode → deep-compare (2 bên đều đã qua validateBrainDraft). */
function expectRoundTrip(spec: BrainDraftSpec, brain: BrainKey): number[] {
  const iu = inputUnitsFor(brain)
  const v = validateBrainDraft(spec, iu)
  expect(v.ok, `sweep spec phải hợp lệ: ${v.ok ? '' : ((v as { errors: string[] }).errors.join('; '))}`).toBe(true)
  if (!v.ok) throw new Error('unreachable')
  const vec = encodeDraft(v.normalized, iu)
  expect(vec).toHaveLength(SEARCH_ENCODING_DIM)
  const back = decodeDraft(vec, brain)
  const problems: string[] = []
  const ok = specEquals(back, v.normalized, 'spec', problems)
  expect(ok, problems.join(' | ')).toBe(true)
  return vec
}

// ==================== A. HẰNG SỐ + MENU ĐƠN ====================

describe('r100 · A hằng số pin (H3/H5/§3.1/§4.1-2 — doctrine #1 hardcode kèm nguồn)', () => {
  test('SEARCH_ENCODING_DIM = 96 — đúng §3.1 (1+6+54+6+12+3+1+9+1+3; v0.1 "87 chiều" là SAI SỐ HỌC)', () => {
    expect(SEARCH_ENCODING_DIM).toBe(96)
  })

  test('ngân sách H3 + prune H5 + sampler', () => {
    expect(SEARCH_MAX_CANDIDATES).toBe(24)
    expect(SEARCH_MAX_WALL_MS).toBe(600_000)
    expect(SEARCH_SESSIONS_KEEP).toBe(5)
    expect(SEARCH_CANDIDATES_KEEP).toBe(60)
    expect(SAMPLER_RETRY_MAX).toBe(20)
    expect(SEED_MAX).toBe(2_147_483_647) // 2^31 − 1
  })

  test('ACT_ORDER 9 mục đúng thứ tự ACTIVATION_MENU (§9.2); HIDDEN_ACT_ORDER bỏ softmax (audit B1)', () => {
    expect(ACT_ORDER).toEqual(['sigmoid', 'linear', 'tanh', 'relu', 'leakyRelu', 'elu', 'swish', 'gelu', 'softmax'])
    expect(HIDDEN_ACT_ORDER).toEqual(['sigmoid', 'linear', 'tanh', 'relu', 'leakyRelu', 'elu', 'swish', 'gelu'])
    expect(HIDDEN_ACT_ORDER).not.toContain('softmax')
  })

  test('LOSS_ORDER + BRAIN_KEY_ORDER (thứ tự one-hot [67..78] / [93..95])', () => {
    expect(LOSS_ORDER).toEqual(['bce', 'crossEntropy', 'mse', 'huber'])
    expect(BRAIN_KEY_ORDER).toEqual(['calibration_v3', 'surrogate', 'policy']) // thứ tự BRAIN_REGISTRY
  })

  test('logNorm/logDenorm — công thức §3.1 + kẹp biên + NaN-safe', () => {
    // logNorm(0.05, 0.001, 10) = (ln 50)/(ln 10⁴) — dẫn nguồn công thức
    expect(logNorm(0.05, 0.001, 10)).toBeCloseTo((Math.log(0.05) - Math.log(0.001)) / (Math.log(10) - Math.log(0.001)), 15)
    // biên: v=min → 0 · v=max → 1 (đúng bằng bit — tử = mẫu)
    expect(logNorm(0.001, 0.001, 10)).toBe(0)
    expect(logNorm(10, 0.001, 10)).toBe(1)
    // đảo: logDenorm(logNorm(v)) ≈ v (1 ulp — dùng toBeCloseTo)
    expect(logDenorm(logNorm(0.05, 0.001, 10), 0.001, 10)).toBeCloseTo(0.05, 12)
    expect(logDenorm(0, 0.001, 10)).toBeCloseTo(0.001, 12)
    expect(logDenorm(1, 0.001, 10)).toBeCloseTo(10, 12)
    // NaN-safe (hàm tổng)
    expect(logNorm(Number.NaN, 0.001, 10)).toBe(0)
    expect(logNorm(0, 0.001, 10)).toBe(0) // log(0) = −∞ → kẹp 0
  })
})

// ==================== B. PIN SLOT LAYOUT (số chính xác — chống trôi layout) ====================

describe('r100 · B pin slot layout §3.1 — số CHÍNH XÁC từng khối', () => {
  test('[0] = nLayers/6 — 0 lớp → 0 · 1 lớp → 1/6 · 3 lớp → 0.5 · 6 lớp → 1', () => {
    const zero = baseSpec('calibration_v3'); zero.hidden = []
    expect(encodeDraft(zero, 10)[0]).toBe(0)
    expect(encodeDraft(baseSpec('calibration_v3'), 10)[0]).toBeCloseTo(1 / 6, 15) // default 1 lớp ẩn
    const three = baseSpec('calibration_v3'); three.hidden = [4, 8, 12].map(units => ({ units, activation: 'tanh' as const }))
    expect(encodeDraft(three, 10)[0]).toBe(0.5)
    const six = baseSpec('calibration_v3'); six.hidden = Array.from({ length: 6 }, () => ({ units: 4, activation: 'tanh' as const }))
    expect(encodeDraft(six, 10)[0]).toBe(1)
  })

  test('[1..6] = units/256 (pad 0 khi thiếu lớp) — round-trip bit chính xác (luỹ thừa 2)', () => {
    const s = baseSpec('calibration_v3')
    s.hidden = [{ units: 1, activation: 'tanh' }, { units: 256, activation: 'relu' }]
    const vec = encodeDraft(s, 10)
    expect(vec[1]).toBe(1 / 256) // 0.00390625
    expect(vec[2]).toBe(1)
    expect(vec[3]).toBe(0)
    expect(vec[4]).toBe(0)
    expect(vec[5]).toBe(0)
    expect(vec[6]).toBe(0)
    // decode lấy lại ĐÚNG nguyên
    const back = decodeDraft(vec, 'calibration_v3')
    expect(back.hidden[0].units).toBe(1)
    expect(back.hidden[1].units).toBe(256)
  })

  test('[7..60] activation one-hot 9×6 — tanh (index 2) lớp 0 → slot [9] = 1, còn lại 0', () => {
    const vec = encodeDraft(baseSpec('calibration_v3'), 10) // hidden [16 tanh]
    expect(vec[7 + 2]).toBe(1) // 7 + 0×9 + index(tanh)=2
    for (let j = 0; j < 9; j++) if (j !== 2) expect(vec[7 + j]).toBe(0)
    // lớp 2 trở đi chưa tồn tại → block [16..60] toàn 0
    for (let i = 1; i < 6; i++) for (let j = 0; j < 9; j++) expect(vec[7 + i * 9 + j]).toBe(0)
  })

  test('[61..66] α/β log-scale — leakyRelu α 0.05 · no-key default 0.01 · tanh → 0 · swish β 1.5', () => {
    const lr = baseSpec('calibration_v3'); lr.hidden = [{ units: 8, activation: 'leakyRelu', activationParams: { alpha: 0.05 } }]
    expect(encodeDraft(lr, 10)[61]).toBeCloseTo((Math.log(0.05) - Math.log(0.001)) / (Math.log(10) - Math.log(0.001)), 15)
    const lrNoKey = baseSpec('calibration_v3'); lrNoKey.hidden = [{ units: 8, activation: 'leakyRelu' }]
    expect(encodeDraft(lrNoKey, 10)[61]).toBeCloseTo((Math.log(0.01) - Math.log(0.001)) / (Math.log(10) - Math.log(0.001)), 15) // default engine α 0.01
    expect(encodeDraft(baseSpec('calibration_v3'), 10)[61]).toBe(0) // tanh không dùng α/β
    const sw = baseSpec('surrogate'); sw.hidden = [{ units: 8, activation: 'swish', activationParams: { beta: 1.5 } }]
    expect(encodeDraft(sw, null)[61]).toBeCloseTo((Math.log(1.5) - Math.log(0.01)) / (Math.log(10) - Math.log(0.01)), 15) // betaMin 0.01
  })

  test('[67..78] loss one-hot 4×3 — A 1 đầu: bce [67] = 1, [71..78] toàn 0; B default: bce[67] huber[74] huber[78]', () => {
    const a = encodeDraft(baseSpec('calibration_v3'), 10)
    expect(a[67]).toBe(1) // head 0 · index(bce)=0
    for (let i = 0; i < 12; i++) if (i !== 0) expect(a[67 + i]).toBe(0)
    const b = encodeDraft(baseSpec('surrogate'), null)
    expect(b[67]).toBe(1) // head 0 bce
    expect(b[67 + 4 + 3]).toBe(1) // head 1 huber → 67 + 1×4 + index(huber)=3 = 74
    expect(b[67 + 2 * 4 + 3]).toBe(1) // head 2 huber → 78
    for (let i = 0; i < 12; i++) if (i !== 0 && i !== 7 && i !== 11) expect(b[67 + i]).toBe(0)
  })

  test('[79..81] trọng số Σλ=1 — brain 1 đầu = [1,0,0]; B default = [1/3,1/3,1/3]', () => {
    const a = encodeDraft(baseSpec('calibration_v3'), 10)
    expect(a[79]).toBe(1)
    expect(a[80]).toBe(0)
    expect(a[81]).toBe(0)
    const b = encodeDraft(baseSpec('surrogate'), null)
    expect(b[79]).toBeCloseTo(1 / 3, 12)
    expect(b[80]).toBeCloseTo(1 / 3, 12)
    expect(b[81]).toBeCloseTo(1 / 3, 12)
  })

  test('[82] δ Huber — A (không head huber) → 0; B huber no-key → logNorm(1.0); B δ 2.5', () => {
    expect(encodeDraft(baseSpec('calibration_v3'), 10)[82]).toBe(0)
    expect(encodeDraft(baseSpec('surrogate'), null)[82]).toBeCloseTo((Math.log(1) - Math.log(0.01)) / (Math.log(10) - Math.log(0.01)), 15) // default engine δ 1.0
    const b = baseSpec('surrogate')
    b.lossPerHead = [
      { type: 'bce', weight: 1 / 3 },
      { type: 'huber', weight: 1 / 3, huberDelta: 2.5 },
      { type: 'huber', weight: 1 / 3, huberDelta: 2.5 },
    ]
    expect(encodeDraft(b, null)[82]).toBeCloseTo((Math.log(2.5) - Math.log(0.01)) / (Math.log(10) - Math.log(0.01)), 15)
  })

  test('[83] optimizer — adam = 1 (default draft) · sgd = 0', () => {
    expect(encodeDraft(baseSpec('calibration_v3'), 10)[83]).toBe(1)
    const s = baseSpec('calibration_v3'); s.hyper.optimizer = 'sgd'
    expect(encodeDraft(s, 10)[83]).toBe(0)
  })

  test('[84..91] hyper chuẩn hoá linear theo DRAFT_LIMITS (default A draft: adam lr .01 epochs 500 batch 32 l2 .01 patience 50 holdout .15 clip 5 seed 42)', () => {
    const vec = encodeDraft(baseSpec('calibration_v3'), 10)
    // công thức: (v − min)/(max − min) — dẫn nguồn DRAFT_LIMITS
    expect(vec[84]).toBeCloseTo((0.01 - DRAFT_LIMITS.lrMin) / (DRAFT_LIMITS.lrMax - DRAFT_LIMITS.lrMin), 15)
    expect(vec[85]).toBeCloseTo((500 - DRAFT_LIMITS.epochsMin) / (DRAFT_LIMITS.epochsMax - DRAFT_LIMITS.epochsMin), 15)
    expect(vec[86]).toBeCloseTo((32 - DRAFT_LIMITS.batchMin) / (DRAFT_LIMITS.batchMax - DRAFT_LIMITS.batchMin), 15)
    expect(vec[87]).toBeCloseTo((0.01 - DRAFT_LIMITS.l2Min) / (DRAFT_LIMITS.l2Max - DRAFT_LIMITS.l2Min), 15)
    expect(vec[88]).toBeCloseTo((50 - DRAFT_LIMITS.patienceMin) / (DRAFT_LIMITS.patienceMax - DRAFT_LIMITS.patienceMin), 15)
    expect(vec[89]).toBeCloseTo((0.15 - DRAFT_LIMITS.holdoutMin) / (DRAFT_LIMITS.holdoutMax - DRAFT_LIMITS.holdoutMin), 15)
    expect(vec[90]).toBeCloseTo((5 - DRAFT_LIMITS.clipMin) / (DRAFT_LIMITS.clipMax - DRAFT_LIMITS.clipMin), 15)
    expect(vec[91]).toBeCloseTo(42 / SEED_MAX, 15)
  })

  test('[91] seed/SEED_MAX — seed 0 → 0 · seed SEED_MAX → 1 (round-trip nguyên chính xác)', () => {
    const zero = baseSpec('calibration_v3'); zero.hyper.seed = 0
    expect(encodeDraft(zero, 10)[91]).toBe(0)
    const max = baseSpec('calibration_v3'); max.hyper.seed = SEED_MAX
    const vec = encodeDraft(max, 10)
    expect(vec[91]).toBe(1)
    expect(decodeDraft(vec, 'calibration_v3').hyper.seed).toBe(SEED_MAX)
  })

  test('[92] inputDim/2048 — A (features-10) → 10/2048 · inputUnits null → 0 · 2048 → 1', () => {
    expect(encodeDraft(baseSpec('calibration_v3'), 10)[92]).toBe(10 / 2048)
    expect(encodeDraft(baseSpec('surrogate'), null)[92]).toBe(0)
    expect(encodeDraft(baseSpec('surrogate'), 2048)[92]).toBe(1)
  })

  test('[93..95] brain one-hot đúng thứ tự BRAIN_REGISTRY (A [1,0,0] · B [0,1,0] · C [0,0,1])', () => {
    expect(encodeDraft(baseSpec('calibration_v3'), 10).slice(93)).toEqual([1, 0, 0])
    expect(encodeDraft(baseSpec('surrogate'), null).slice(93)).toEqual([0, 1, 0])
    expect(encodeDraft(baseSpec('policy'), null).slice(93)).toEqual([0, 0, 1])
  })
})

// ==================== C. BIJECTIVE SWEEP (≥ 40 case) ====================

interface SweepCase {
  name: string
  spec: BrainDraftSpec
}

/** Danh sách case biên cho 1 brain (§4.1-5: mỗi brain × biên DRAFT_LIMITS × activation × loss hợp lệ). */
function sweepCases(brain: BrainKey): SweepCase[] {
  const cases: SweepCase[] = []
  const push = (name: string, mutate: (s: BrainDraftSpec) => void) => {
    const s = baseSpec(brain)
    mutate(s)
    cases.push({ name, spec: s })
  }

  // default nguyên bản
  cases.push({ name: 'default draft', spec: baseSpec(brain) })
  // hidden biên số lớp / units
  push('hidden 0 lớp (input→output thẳng)', s => { s.hidden = [] })
  push('1 lớp · 1 unit · tanh', s => { s.hidden = [{ units: 1, activation: 'tanh' }] })
  push('1 lớp · 256 unit · tanh', s => { s.hidden = [{ units: 256, activation: 'tanh' }] })
  push('6 lớp units trộn 1/256/7/64/3/128', s => {
    const acts = ['sigmoid', 'linear', 'tanh', 'relu', 'gelu', 'leakyRelu'] as const
    s.hidden = [1, 256, 7, 64, 3, 128].map((units, i) => ({ units, activation: acts[i] }))
  })
  push('6 lớp toàn 64 unit', s => { s.hidden = Array.from({ length: 6 }, () => ({ units: 64, activation: 'tanh' as const })) })
  // 6×256 = ~330K tham số — chỉ hợp lệ khi inputUnits null (B/C không chặn trần;
  // A input 10 sẽ bị validate chặn 250K nên A không có case này)
  if (brain !== 'calibration_v3') {
    push('6 lớp toàn 256 unit (trần units)', s => { s.hidden = Array.from({ length: 6 }, () => ({ units: 256, activation: 'tanh' as const })) })
  }
  // 8 activation hidden — softmax BỎ (audit B1: cấm lớp ẩn)
  for (const act of HIDDEN_ACT_ORDER) {
    push(`1 lớp 32 · ${act}`, s => { s.hidden = [{ units: 32, activation: act }] })
  }
  // α/β CÓ key (giá trị ≠ default để round-trip giữ key)
  push('leakyRelu α 0.05 (có key)', s => { s.hidden = [{ units: 32, activation: 'leakyRelu', activationParams: { alpha: 0.05 } }] })
  push('elu α 2.0 (có key)', s => { s.hidden = [{ units: 32, activation: 'elu', activationParams: { alpha: 2.0 } }] })
  push('swish β 1.5 (có key)', s => { s.hidden = [{ units: 32, activation: 'swish', activationParams: { beta: 1.5 } }] })
  // α/β KHÔNG key (default engine)
  push('leakyRelu không key (α default engine)', s => { s.hidden = [{ units: 32, activation: 'leakyRelu' }] })
  push('swish không key (β default engine)', s => { s.hidden = [{ units: 32, activation: 'swish' }] })
  // hyper 2 biên
  push('hyper biên dưới (sgd 1e-4/50/8/0/10/0.1/1/seed 0)', s => {
    s.hyper = { optimizer: 'sgd', lr: 1e-4, epochs: 50, batch: 8, l2: 0, patience: 10, holdout: 0.1, clip: 1, seed: 0 }
  })
  push('hyper biên trên (adam 1/5000/256/0.1/200/0.3/10/seed SEED_MAX)', s => {
    s.hyper = { optimizer: 'adam', lr: 1, epochs: 5000, batch: 256, l2: 0.1, patience: 200, holdout: 0.3, clip: 10, seed: SEED_MAX }
  })
  // 3 lớp trộn α/β + seed lớn
  push('3 lớp swish β 2.2 / elu α 0.7 / relu + seed 123456789', s => {
    s.hidden = [
      { units: 128, activation: 'swish', activationParams: { beta: 2.2 } },
      { units: 64, activation: 'elu', activationParams: { alpha: 0.7 } },
      { units: 16, activation: 'relu' },
    ]
    s.hyper.seed = 123_456_789
  })
  // loss/weight/δ theo rule từng brain
  if (brain === 'surrogate') {
    push('B heads 2/3 → mse/mse · weights [0.5,0.25,0.25]', s => {
      s.lossPerHead = [
        { type: 'bce', weight: 0.5 },
        { type: 'mse', weight: 0.25 },
        { type: 'mse', weight: 0.25 },
      ]
    })
    push('B heads 2/3 → mse/huber δ 0.5 · weights [0.2,0.3,0.5]', s => {
      s.lossPerHead = [
        { type: 'bce', weight: 0.2 },
        { type: 'mse', weight: 0.3 },
        { type: 'huber', weight: 0.5, huberDelta: 0.5 },
      ]
    })
    push('B heads huber/huber CÙNG δ 2.5 · weights [1,0,0]', s => {
      s.lossPerHead = [
        { type: 'bce', weight: 1 },
        { type: 'huber', weight: 0, huberDelta: 2.5 },
        { type: 'huber', weight: 0, huberDelta: 2.5 },
      ]
    })
    push('B huber no-key δ + 2 lớp gelu/sigmoid', s => {
      s.hidden = [{ units: 24, activation: 'gelu' }, { units: 8, activation: 'sigmoid' }]
    })
  }
  if (brain === 'calibration_v3') {
    push('A 2 lớp 128 relu + 5 linear + sgd + seed 0', s => {
      s.hidden = [{ units: 128, activation: 'relu' }, { units: 5, activation: 'linear' }]
      s.hyper.optimizer = 'sgd'
      s.hyper.seed = 0
    })
  }
  if (brain === 'policy') {
    push('C 0 lớp + adam + seed SEED_MAX', s => {
      s.hidden = []
      s.hyper.seed = SEED_MAX
    })
  }
  return cases
}

/** Thu mọi vector của sweep cho phần D (min/max slot) — lấp trong callback test C. */
const SWEEP_VECS: number[][] = []

describe('r100 · C bijective sweep — encode → decode → khớp normalized spec (§4.1-5)', () => {
  for (const brain of BRAINS) {
    for (const c of sweepCases(brain)) {
      test(`${brain} · ${c.name}`, () => {
        SWEEP_VECS.push(expectRoundTrip(c.spec, brain))
      })
    }
  }

  test('tổng số case sweep ≥ 40 (§4.1-5: mỗi brain × biên DRAFT_LIMITS)', () => {
    expect(BRAINS.reduce((n, b) => n + sweepCases(b).length, 0)).toBeGreaterThanOrEqual(40)
  })
})

// ==================== D. MỌI SLOT ∈ [0,1] — QUÉT MIN/MAX ====================

describe('r100 · D mọi thành phần encode ∈ [0,1] — quét min/max từng slot', () => {
  test('96 slot đều min ≥ 0, max ≤ 1 trên sweep + 3000 mẫu sampler', () => {
    const vecs = [...SWEEP_VECS]
    for (const brain of BRAINS) {
      const rng = makeRng(555_001)
      for (let i = 0; i < 1000; i++) {
        const { spec } = sampleCandidate(rng, brain, inputUnitsFor(brain))
        vecs.push(encodeDraft(spec, inputUnitsFor(brain)))
      }
    }
    expect(vecs.length).toBeGreaterThanOrEqual(3000)
    const mins = new Array<number>(SEARCH_ENCODING_DIM).fill(Infinity)
    const maxs = new Array<number>(SEARCH_ENCODING_DIM).fill(-Infinity)
    for (const v of vecs) {
      for (let i = 0; i < SEARCH_ENCODING_DIM; i++) {
        if (v[i] < mins[i]) mins[i] = v[i]
        if (v[i] > maxs[i]) maxs[i] = v[i]
      }
    }
    for (let i = 0; i < SEARCH_ENCODING_DIM; i++) {
      expect(mins[i], `slot [${i}] min`).toBeGreaterThanOrEqual(0)
      expect(maxs[i], `slot [${i}] max`).toBeLessThanOrEqual(1)
    }
    // coverage: slot nLayers chạm 0 (0 lớp) và 1 (6 lớp); brain one-hot đủ 3 vị trí
    expect(mins[0]).toBe(0)
    expect(maxs[0]).toBe(1)
    expect(maxs[93]).toBe(1)
    expect(maxs[94]).toBe(1)
    expect(maxs[95]).toBe(1)
    expect(maxs[79]).toBe(1) // brain 1 đầu weight 1
    expect(mins[82]).toBe(0) // A/C không head huber
  })
})

// ==================== E. TẤT ĐỊNH H4 (same seed same output) ====================

describe('r100 · E sampler tất định H4 — makeRng cùng seed → cùng dãy spec', () => {
  const N = 1000
  const SEED = 2026_1013 // seed cố định — same seed same output (H4)

  function runSeries(brain: BrainKey): { json: string[]; specs: BrainDraftSpec[]; attempts: number[] } {
    const rng = makeRng(SEED)
    const json: string[] = []
    const specs: BrainDraftSpec[] = []
    const attempts: number[] = []
    for (let i = 0; i < N; i++) {
      const r = sampleCandidate(rng, brain, inputUnitsFor(brain))
      json.push(JSON.stringify(r.spec))
      specs.push(r.spec)
      attempts.push(r.attempts)
    }
    return { json, specs, attempts }
  }

  for (const brain of BRAINS) {
    test(`${brain} — 1000 mẫu: cùng seed 2 lần ra CÙNG dãy (JSON) · attempts ≥ 1 · encode 96 chiều · decode(encode) khớp`, () => {
      const r1 = runSeries(brain)
      const r2 = runSeries(brain)
      expect(r1.json.length).toBe(N)
      expect(r2.json).toEqual(r1.json) // same seed → same series bit-đối-bit (H4)
      for (let i = 0; i < N; i++) {
        expect(r1.attempts[i]).toBeGreaterThanOrEqual(1)
        expect(r1.attempts[i]).toBeLessThanOrEqual(SAMPLER_RETRY_MAX)
        const vec = encodeDraft(r1.specs[i], inputUnitsFor(brain))
        expect(vec).toHaveLength(SEARCH_ENCODING_DIM)
        const back = decodeDraft(vec, brain)
        const problems: string[] = []
        const ok = specEquals(back, r1.specs[i], 'spec', problems)
        expect(ok, `mẫu ${i}: ${problems.join(' | ')}`).toBe(true)
      }
    })
  }
})

// ==================== F. SAMPLER TRONG BIÊN (validate hết ok) ====================

describe('r100 · F sampler trong biên — 1000 mẫu/brain qua validateBrainDraft', () => {
  const N = 1000

  test('mọi mẫu hợp lệ · attempts ≤ SAMPLER_RETRY_MAX · fallback default < 5%', () => {
    let fallback = 0
    let total = 0
    for (const brain of BRAINS) {
      const rng = makeRng(777_654_321)
      const defaultJson = JSON.stringify(defaultDraftFor(brain))
      for (let i = 0; i < N; i++) {
        const { spec, attempts } = sampleCandidate(rng, brain, inputUnitsFor(brain))
        total++
        const res = validateBrainDraft(spec, inputUnitsFor(brain))
        expect(res.ok, `mẫu ${i} brain ${brain} phải hợp lệ trong biên`).toBe(true)
        expect(attempts).toBeLessThanOrEqual(SAMPLER_RETRY_MAX)
        if (JSON.stringify(spec) === defaultJson) fallback++ // cạn retry → default draft
      }
    }
    expect(total).toBe(N * 3)
    // §4.1-2: tỷ lệ bị loại (fallback) phải hiếm — < 5%
    expect(fallback).toBeLessThan(Math.ceil(total * 0.05))
  })

  test('sampler KHÔNG đụng Math.random — thuần rng (nguồn: code-scan search-space.ts)', () => {
    // pin behavioral: cùng rng seed chạy 2 lần trong CÙNG process vẫn ra cùng kết quả
    // (đã bao bởi E); ở đây pin thêm rằng series thay đổi khi ĐỔI seed (chống
    // sampler vô tình bỏ qua rng — nếu bỏ qua, 2 seed khác nhau ra cùng dãy)
    const a = runWithSeed(1)
    const b = runWithSeed(2)
    expect(a).not.toEqual(b)
  })

  test('cạn retry → fallback defaultDraftFor + attempts = SAMPLER_RETRY_MAX (fail-open §4.1-2)', () => {
    // inputUnits khổng lồ → MỌI cấu hình đều vượt trần 250K (kể cả 0 lớp:
    // 1×300000+1 > 250K) → 20 lần sinh đều bị validate loại → fallback
    const rng = makeRng(42)
    const r = sampleCandidate(rng, 'calibration_v3', 300_000)
    expect(r.attempts).toBe(SAMPLER_RETRY_MAX)
    const res = validateBrainDraft(r.spec, 10)
    expect(res.ok).toBe(true) // default draft hợp lệ theo rule thật (input 10)
    expect(JSON.stringify(r.spec)).toBe(JSON.stringify(defaultDraftFor('calibration_v3')))
  })
})

function runWithSeed(seed: number): string[] {
  const out: string[] = []
  for (const brain of BRAINS) {
    const rng = makeRng(seed)
    for (let i = 0; i < 5; i++) out.push(JSON.stringify(sampleCandidate(rng, brain, inputUnitsFor(brain)).spec))
  }
  return out
}

// ==================== G. DECODE VECTOR RÁC → throw 'vector rác' ====================

describe('r100 · G decode vector rác → throw Error có "vector rác" (§4.1-5)', () => {
  test('ngắn 10 phần tử', () => {
    expect(() => decodeDraft(new Array<number>(10).fill(0.5), 'surrogate')).toThrow('vector rác')
  })

  test('dài 97 phần tử', () => {
    const long = [...encodeDraft(baseSpec('surrogate'), null), 0]
    expect(() => decodeDraft(long, 'surrogate')).toThrow('vector rác')
  })

  test('NaN ở 1 slot', () => {
    const vec = encodeDraft(baseSpec('surrogate'), null)
    vec[42] = Number.NaN
    expect(() => decodeDraft(vec, 'surrogate')).toThrow('vector rác')
  })

  test('giá trị âm', () => {
    const vec = encodeDraft(baseSpec('surrogate'), null)
    vec[5] = -0.01
    expect(() => decodeDraft(vec, 'surrogate')).toThrow('vector rác')
  })

  test('giá trị > 1', () => {
    const vec = encodeDraft(baseSpec('surrogate'), null)
    vec[84] = 1.5
    expect(() => decodeDraft(vec, 'surrogate')).toThrow('vector rác')
  })

  test('one-hot brain [93..95] lệch brain truyền vào (chống lẫn ứng viên chéo brain)', () => {
    expect(() => decodeDraft(encodeDraft(baseSpec('surrogate'), null), 'policy')).toThrow('vector rác')
    expect(() => decodeDraft(encodeDraft(baseSpec('calibration_v3'), 10), 'surrogate')).toThrow('vector rác')
  })

  test('one-hot activation rỗng ở lớp tồn tại', () => {
    const vec = encodeDraft(baseSpec('calibration_v3'), 10) // 1 lớp tanh → slot [9] = 1
    for (let j = 0; j < 9; j++) vec[7 + j] = 0 // xoá sạch block lớp 0
    expect(() => decodeDraft(vec, 'calibration_v3')).toThrow('vector rác')
  })

  test('softmax one-hot ở hidden → validate từ chối (audit B1)', () => {
    const vec = encodeDraft(baseSpec('calibration_v3'), 10)
    vec[9] = 0 // tanh
    vec[7 + 8] = 1 // softmax = index 8 trong ACT_ORDER → slot [15]
    expect(() => decodeDraft(vec, 'calibration_v3')).toThrow('vector rác')
  })
})

// ==================== H. QUYẾT ĐỊNH THIẾT KẾ (δ slot · α/β default · weight khóa) ====================

describe('r100 · H quyết định thiết kế pin (search-space.ts JSDoc #1-#3)', () => {
  test('δ slot = δ head huber ĐẦU TIÊN — B 2 head huber CÙNG δ 2.5 round-trip đúng', () => {
    const b = baseSpec('surrogate')
    b.lossPerHead = [
      { type: 'bce', weight: 1 / 3 },
      { type: 'huber', weight: 1 / 3, huberDelta: 2.5 },
      { type: 'huber', weight: 1 / 3, huberDelta: 2.5 },
    ]
    const back = decodeDraft(encodeDraft(b, null), 'surrogate')
    expect(back.lossPerHead[1].type).toBe('huber')
    expect(back.lossPerHead[2].type).toBe('huber')
    expect(back.lossPerHead[1].huberDelta).toBeCloseTo(2.5, 9)
    expect(back.lossPerHead[2].huberDelta).toBeCloseTo(2.5, 9)
  })

  test('δ KHÁC nhau giữa các head huber → decode collapse về δ head đầu (ngoài subspace — có chủ đích)', () => {
    const b = baseSpec('surrogate')
    b.lossPerHead = [
      { type: 'bce', weight: 1 / 3 },
      { type: 'huber', weight: 1 / 3, huberDelta: 2.5 },
      { type: 'huber', weight: 1 / 3, huberDelta: 0.5 },
    ]
    const back = decodeDraft(encodeDraft(b, null), 'surrogate')
    expect(back.lossPerHead[1].huberDelta).toBeCloseTo(2.5, 9) // δ head đầu
    expect(back.lossPerHead[2].huberDelta).toBeCloseTo(2.5, 9) // collapse — KHÔNG phải 0.5
  })

  test('δ no-key ≡ key = 1.0 (default engine) — encode ra CÙNG slot, decode bỏ key', () => {
    const withKey = baseSpec('surrogate')
    withKey.lossPerHead = [
      { type: 'bce', weight: 1 / 3 },
      { type: 'huber', weight: 1 / 3, huberDelta: 1.0 },
      { type: 'huber', weight: 1 / 3 },
    ]
    expect(encodeDraft(withKey, null)[82]).toBe(encodeDraft(baseSpec('surrogate'), null)[82])
    expect(decodeDraft(encodeDraft(baseSpec('surrogate'), null), 'surrogate').lossPerHead.every(h => h.huberDelta === undefined)).toBe(true)
  })

  test('α/β "không key" ≡ "key = default engine" — 2 spec encode ra CÙNG vector; decode không key', () => {
    const withKey = baseSpec('calibration_v3')
    withKey.hidden = [{ units: 32, activation: 'leakyRelu', activationParams: { alpha: 0.01 } }]
    const noKey = baseSpec('calibration_v3')
    noKey.hidden = [{ units: 32, activation: 'leakyRelu' }]
    expect(encodeDraft(withKey, 10)).toEqual(encodeDraft(noKey, 10))
    const back = decodeDraft(encodeDraft(noKey, 10), 'calibration_v3')
    expect(back.hidden[0].activation).toBe('leakyRelu')
    expect('activationParams' in back.hidden[0]).toBe(false)
  })

  test('weight A/C KHÓA theo rule — encode ghi GIÁ TRỊ KHÓA (spec weight 0.7 vẫn slot [79] = 1), decode ép lại rule (§3.1 không ảo tưởng)', () => {
    const s = baseSpec('calibration_v3')
    s.lossPerHead = [{ type: 'bce', weight: 0.7 }] // hợp lệ validate nhưng ngoài hợp đồng
    const vec = encodeDraft(s, 10)
    expect(vec[79]).toBe(1) // encode giá trị KHÓA — không tạo ảo tưởng tìm được
    vec[79] = 0.3 // vector "đòi" weight 0.3
    const back = decodeDraft(vec, 'calibration_v3')
    expect(back.lossPerHead[0].type).toBe('bce')
    expect(back.lossPerHead[0].weight).toBe(1) // ép về rule
  })

  test('loại loss KHÓA luôn về rule — vector one-hot bce cho B head 1 (chỉ huber/mse) bị bỏ qua', () => {
    const vec = encodeDraft(baseSpec('surrogate'), null)
    // head 1 (huber) block [71..74]: xoá huber, bật bce (index 0)
    vec[67 + 4 + 3] = 0
    vec[67 + 4 + 0] = 1
    const back = decodeDraft(vec, 'surrogate')
    expect(back.lossPerHead[0].type).toBe('bce')
    expect(back.lossPerHead[1].type).toBe('huber') // loại khóa — bỏ qua vector
  })

  test('B weight từ vector (editableWeights) — round-trip giữ nguyên Σλ=1', () => {
    const b = baseSpec('surrogate')
    b.lossPerHead = [
      { type: 'bce', weight: 0.5 },
      { type: 'mse', weight: 0.25 },
      { type: 'mse', weight: 0.25 },
    ]
    const back = decodeDraft(encodeDraft(b, null), 'surrogate')
    expect(back.lossPerHead.map(h => h.weight)).toEqual([0.5, 0.25, 0.25])
  })
})
