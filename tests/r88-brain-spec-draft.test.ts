/**
 * ROUND-88 TESTS — BRAIN-UX §9.2/§9.3 (UX-1/UX-2) · SPEC-DRAFT SCHEMA + API
 * (blueprint v0.10 §9 — user chốt 2026-10-12; spec-schema.ts là single-source
 * cho client editor lẫn PUT /api/brain/spec-draft)
 *
 * Đo lường:
 *   A. validateBrainDraft biên lớp ẩn (§9.2): units 1/256 OK · 0/257 chặn ·
 *      0–6 lớp OK · 7 lớp chặn · 8 hàm hidden OK · softmax ở hidden BỊ TỪ
 *      CHỐI (audit B1) · activation lạ chặn.
 *   B. lossPerHead theo HỢP ĐỒNG pipeline từng brain (§9.1-2): A đúng 1 head
 *      bce khóa (mse chặn) · B 3 head (success bce khóa, tokens/duration
 *      nhận huber⇄mse) · C 1 head crossEntropy khóa · weight ∈ [0,1] (0/1 OK,
 *      -0.1/1.1 chặn).
 *   C. hyper biên §9.3 nhóm A: mọi biên dưới/trên hợp lệ + chặn ngoài phạm vi
 *      + số nguyên (epochs/batch/patience) + seed ≥ 0 + optimizer menu.
 *   D. Bộ đếm tham số (§9.1-3): công thức Σ(unitsₗ·unitsₗ₋₁ + unitsₗ) PIN
 *      TRÙNG mlp.validateSpec (cross-check MLP.paramCount) · trần 250K chặn
 *      khi biết chiều input · inputUnits=null → includesInput=false, KHÔNG
 *      chặn trần (mlp.validateSpec lúc train là điểm chặn thật).
 *   E. defaultDraftFor 3 brain (nút "Phục hồi spec chuẩn") + PIN HỒI QUY:
 *      buildV3Spec()/buildPolicySpec() (import thật) trùng lớp ẩn + hyper
 *      default draft → default draft train ra KẾT QUẢ Y HỆT không draft.
 *   F. ACTIVATION_MENU 9 mục đúng thứ tự bảng §9.2 (metadata đầy đủ).
 *   G. downsampleHistory (quỹ đạo epoch UX-2): bản sao · đúng cap · giữ đầu/
 *      cuối · tất định.
 *   H. diffDraftAgainst (nút "So sánh với bản active"): hàng Kiến trúc đổi
 *      cờ diff đúng · hàng Nguồn.
 *   I. API GET/PUT /api/brain/spec-draft (DB cô lập qua preload): PUT hợp lệ
 *      200 saved:true · upsert 1 row/brain · PUT rác 400 + errors + không
 *      ghi · GET đủ 3 draft + 3 default · spec.brain lệch body.brain được ÉP
 *      về body.brain.
 *   J. BẤT BIẾN §9.1-1 (Draft ≠ runtime): PUT nháp nhiều lần (kể cả rác) →
 *      BrainModel GIỐNG HỆT (count + active + version + spec/weights) —
 *      đường lên runtime duy nhất vẫn là train → thắng CV → thăng cấp (A1).
 *   G-3PHAN. BRAIN-TAB-3PHAN (18-d): activationParams α/β (leakyRelu/elu →
 *      giữ alpha · swish → giữ beta · khác → DROP) + huberDelta (head huber
 *      giữ · mse/bce/CE → DROP) + default KHÔNG thêm key (chống hồi quy r88-E)
 *      + 3 pipeline (buildV3Spec/buildSurrogateSpecs/buildPolicySpec) truyền
 *      α/β/δ vào MlpSpec bằng conditional spread (không key undefined).
 *
 * Nguyên tắc test:
 * - DB-cô-lập (bunfig preload copy DB) — wipe BrainSpecDraft + seed BrainModel
 *   riêng để bất biến J có "bản active" thật để bảo vệ; dọn cả 2 ở afterAll.
 * - Tuning-store KHÔNG đụng (file này thuần schema + route riêng) — không set
 *  /reset key nào → không rò state sang file khác (bài học r83).
 * - Mọi expected DẪN NGUỒN ĐƯỢC (comment công thức) — không test hiển nhiên.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { db } from '@/lib/db'
import { MLP } from '@/lib/brain/mlp'
import {
  validateBrainDraft,
  defaultDraftFor,
  ACTIVATION_MENU,
  BRAIN_DRAFT_RULES,
  downsampleHistory,
  diffDraftAgainst,
  type BrainDraftSpec,
  type DraftHiddenLayer,
  type DraftHyper,
  type DraftValidationErr,
} from '@/lib/brain/spec-schema'
import { buildV3Spec } from '@/lib/brain/calibration-v3'
import { buildPolicySpec } from '@/lib/brain/brains/policy'
import { buildSurrogateSpecs } from '@/lib/brain/brains/surrogate'
import { GET, PUT } from '@/app/api/brain/spec-draft/route'

type BrainKey = 'calibration_v3' | 'surrogate' | 'policy'

/** Draft hợp lệ gốc (default chuẩn) — mọi test biến đổi 1 trường từ đây. */
function validDraft(brain: BrainKey): BrainDraftSpec {
  return defaultDraftFor(brain)
}

/** Chốt lỗi: kết quả phải !ok + có thông điệp nhắc đúng trường đang thăm. */
function expectInvalid(res: ReturnType<typeof validateBrainDraft>, needle: string): string[] {
  expect(res.ok).toBe(false)
  const errors = (res as DraftValidationErr).errors
  expect(Array.isArray(errors)).toBe(true)
  expect(errors.length).toBeGreaterThan(0)
  expect(errors.some(e => e.includes(needle))).toBe(true)
  return errors
}

// ==================== A. BIÊN LỚP ẨN (§9.2) ====================

describe('r88 · A validateBrainDraft — biên lớp ẩn (§9.2 editor)', () => {
  test('units 1 và 256 hợp lệ; 0 và 257 bị chặn ngoài [1, 256]', () => {
    // Biên dưới/trên của stepper §9.2 — normalized giữ nguyên giá trị
    for (const units of [1, 256]) {
      const d = { ...validDraft('calibration_v3'), hidden: [{ units, activation: 'tanh' }] }
      const res = validateBrainDraft(d, 10)
      expect(res.ok).toBe(true)
      if (res.ok) expect(res.normalized.hidden[0].units).toBe(units)
    }
    for (const units of [0, 257]) {
      const d = { ...validDraft('calibration_v3'), hidden: [{ units, activation: 'tanh' }] }
      expectInvalid(validateBrainDraft(d, 10), `units ${units} ngoài [1, 256]`)
    }
  })

  test('0 → 6 lớp ẩn đều hợp lệ; 7 lớp bị chặn (§9.2 editor 0–6)', () => {
    // draft A (input 10): 0 lớp = thẳng input→output (11 tham số) vẫn hợp lệ
    for (const n of [0, 1, 2, 3, 4, 5, 6]) {
      const d = {
        ...validDraft('calibration_v3'),
        hidden: Array.from({ length: n }, () => ({ units: 4, activation: 'tanh' as const })),
      }
      const res = validateBrainDraft(d, 10)
      expect(res.ok).toBe(true)
      if (res.ok) expect(res.normalized.hidden).toHaveLength(n)
    }
    const d7 = {
      ...validDraft('calibration_v3'),
      hidden: Array.from({ length: 7 }, () => ({ units: 4, activation: 'tanh' as const })),
    }
    expectInvalid(validateBrainDraft(d7, 10), 'Số lớp ẩn 7 > 6')
  })

  test('8 hàm hidden đều hợp lệ (sigmoid/linear/tanh/relu/leakyRelu/elu/swish/gelu)', () => {
    // Menu 9 hàm trừ softmax — 8 hàm còn lại dùng được ở vị trí lớp ẩn
    const fns = ['sigmoid', 'linear', 'tanh', 'relu', 'leakyRelu', 'elu', 'swish', 'gelu'] as const
    for (const activation of fns) {
      const d = { ...validDraft('calibration_v3'), hidden: [{ units: 16, activation }] }
      const res = validateBrainDraft(d, 10)
      expect(res.ok).toBe(true)
      if (res.ok) expect(res.normalized.hidden[0].activation).toBe(activation)
    }
  })

  test('softmax ở lớp ẩn BỊ TỪ CHỐI (audit B1 — §9.2); activation lạ lỗi', () => {
    const dSoft = { ...validDraft('calibration_v3'), hidden: [{ units: 16, activation: 'softmax' as never }] }
    // Thông điệp phải nhắc audit B1 (softmax CHỈ output đa lớp)
    expectInvalid(validateBrainDraft(dSoft, 10), 'audit B1')
    const dWeird = { ...validDraft('calibration_v3'), hidden: [{ units: 16, activation: 'gelu2' as never }] }
    expectInvalid(validateBrainDraft(dWeird, 10), 'không có trong menu 9 hàm')
  })
})

// ==================== B. lossPerHead THEO HỢP ĐỒNG PIPELINE (§9.1-2) ====================

describe('r88 · B lossPerHead — loss khóa theo hợp đồng pipeline từng brain', () => {
  test('calibration_v3: đúng 1 head bce; mse bị chặn; sai số lượng head lỗi', () => {
    // Default (bce) hợp lệ
    expect(validateBrainDraft(validDraft('calibration_v3'), 10).ok).toBe(true)
    // mse thay bce → khóa theo hợp đồng (output sigmoid nhị phân)
    const dMse = {
      ...validDraft('calibration_v3'),
      lossPerHead: [{ type: 'mse' as never, weight: 1 }],
    }
    expectInvalid(validateBrainDraft(dMse, 10), 'khóa theo hợp đồng pipeline')
    // 3 head cho brain 1 đầu ra → lỗi số lượng
    const d3 = {
      ...validDraft('calibration_v3'),
      lossPerHead: [
        { type: 'bce', weight: 1 },
        { type: 'huber', weight: 1 },
        { type: 'huber', weight: 1 },
      ],
    }
    expectInvalid(validateBrainDraft(d3, 10), 'đúng 1 đầu ra')
  })

  test('surrogate: 3 head — success bce KHÓA (mse chặn); tokens/duration nhận huber + mse', () => {
    // Default (bce/huber/huber) hợp lệ
    expect(validateBrainDraft(validDraft('surrogate'), null).ok).toBe(true)
    //mse đè head success → chặn
    const dBad = {
      ...validDraft('surrogate'),
      lossPerHead: [
        { type: 'mse' as never, weight: 1 / 3 },
        { type: 'huber', weight: 1 / 3 },
        { type: 'huber', weight: 1 / 3 },
      ],
    }
    expectInvalid(validateBrainDraft(dBad, null), "Đầu ra 1: loss 'mse' khóa")
    // 2 đầu hồi quy đổi được huber⇄mse (§9.3 nhóm B — cùng log1p space)
    for (const t of ['huber', 'mse'] as const) {
      const d = {
        ...validDraft('surrogate'),
        lossPerHead: [
          { type: 'bce', weight: 0.4 },
          { type: t, weight: 0.3 },
          { type: t, weight: 0.3 },
        ],
      }
      const res = validateBrainDraft(d, null)
      expect(res.ok).toBe(true)
      if (res.ok) {
        expect(res.normalized.lossPerHead[1].type).toBe(t)
        expect(res.normalized.lossPerHead[2].type).toBe(t)
      }
    }
    // crossEntropy không thuộc menu cho phép của đầu hồi quy → chặn
    const dCe = {
      ...validDraft('surrogate'),
      lossPerHead: [
        { type: 'bce', weight: 1 / 3 },
        { type: 'crossEntropy' as never, weight: 1 / 3 },
        { type: 'huber', weight: 1 / 3 },
      ],
    }
    expectInvalid(validateBrainDraft(dCe, null), "Đầu ra 2: loss 'crossEntropy' khóa")
  })

  test('policy: 1 head crossEntropy KHÓA (softmax đa lớp — mse chặn)', () => {
    expect(validateBrainDraft(validDraft('policy'), null).ok).toBe(true)
    const dMse = {
      ...validDraft('policy'),
      lossPerHead: [{ type: 'mse' as never, weight: 1 }],
    }
    expectInvalid(validateBrainDraft(dMse, null), 'khóa theo hợp đồng pipeline')
  })

  test('trọng số từng head: 0 và 1 hợp lệ; -0.1 và 1.1 chặn ngoài [0, 1]', () => {
    for (const w of [0, 1]) {
      const d = {
        ...validDraft('surrogate'),
        lossPerHead: [
          { type: 'bce', weight: w },
          { type: 'huber', weight: 1 },
          { type: 'huber', weight: 1 },
        ],
      }
      // w=0 = head bị loại khỏi Σλ lúc APPLY — vẫn hợp lệ schema (§9.3 nhóm B)
      expect(validateBrainDraft(d, null).ok).toBe(true)
    }
    for (const w of [-0.1, 1.1]) {
      const d = {
        ...validDraft('surrogate'),
        lossPerHead: [
          { type: 'bce', weight: w },
          { type: 'huber', weight: 1 },
          { type: 'huber', weight: 1 },
        ],
      }
      expectInvalid(validateBrainDraft(d, null), `trọng số ${w} ngoài [0, 1]`)
    }
  })
})

// ==================== C. HYPER BIÊN (§9.3 NHÓM A) ====================

describe('r88 · C validateBrainDraft — hyper biên §9.3 nhóm A', () => {
  // [trường, biên dưới, biên trên] — nguồn DRAFT_LIMITS (§9.3)
  const BOUNDS: ReadonlyArray<[keyof DraftHyper, number, number]> = [
    ['lr', 1e-4, 1],
    ['epochs', 50, 5000],
    ['batch', 8, 256],
    ['l2', 0, 0.1],
    ['patience', 10, 200],
    ['holdout', 0.1, 0.3],
    ['clip', 1, 10],
  ]

  test('biên dưới/trên MỌI trường đều hợp lệ (chạm mép không bị chặn)', () => {
    for (const [k, lo, hi] of BOUNDS) {
      for (const v of [lo, hi]) {
        const d = { ...validDraft('calibration_v3'), hyper: { ...validDraft('calibration_v3').hyper, [k]: v } }
        const res = validateBrainDraft(d, 10)
        expect(res.ok).toBe(true)
        if (res.ok) expect(res.normalized.hyper[k]).toBe(v)
      }
    }
  })

  test('vượt biên dưới/trên bị chặn + thông điệp nhắc đúng tên trường (§9.3)', () => {
    // Cặp giá trị sai lệch 1 bước ra khỏi biên — mỗi lần chỉ SAI 1 trường
    const cases: ReadonlyArray<[keyof DraftHyper, number]> = [
      ['lr', 1e-5], ['lr', 1.01],
      ['epochs', 49], ['epochs', 5001],
      ['batch', 7], ['batch', 257],
      ['l2', -0.01], ['l2', 0.11],
      ['patience', 9], ['patience', 201],
      ['holdout', 0.09], ['holdout', 0.31],
      ['clip', 0.9], ['clip', 10.1],
    ]
    for (const [k, v] of cases) {
      const d = { ...validDraft('calibration_v3'), hyper: { ...validDraft('calibration_v3').hyper, [k]: v } }
      // Thông điệp lỗi có tiền tố "<trường>: <giá trị> ngoài [...]" (xem num())
      expectInvalid(validateBrainDraft(d, 10), `${String(k)}: ${v} ngoài`)
    }
  })

  test('epochs/batch/patience phải là SỐ NGUYÊN (100.5 lỗi); seed 0 OK, -1/1.5 lỗi', () => {
    const base = validDraft('calibration_v3').hyper
    for (const k of ['epochs', 'batch', 'patience'] as const) {
      const d = { ...validDraft('calibration_v3'), hyper: { ...base, [k]: 100.5 } }
      expectInvalid(validateBrainDraft(d, 10), 'phải là số nguyên')
    }
    // seed 0 hợp lệ (biên dưới — LCG seed 0 vẫn tất định)
    const d0 = { ...validDraft('calibration_v3'), hyper: { ...base, seed: 0 } }
    expect(validateBrainDraft(d0, 10).ok).toBe(true)
    for (const seed of [-1, 1.5]) {
      const d = { ...validDraft('calibration_v3'), hyper: { ...base, seed } }
      expectInvalid(validateBrainDraft(d, 10), 'số nguyên ≥ 0')
    }
  })

  test("optimizer chỉ 'sgd' | 'adam' (menu §9.3) — giá trị lạ chặn", () => {
    const base = validDraft('calibration_v3').hyper
    const d = { ...validDraft('calibration_v3'), hyper: { ...base, optimizer: 'adagrad' as never } }
    expectInvalid(validateBrainDraft(d, 10), "optimizer 'adagrad' phải là 'sgd' | 'adam'")
    const dSgd = { ...validDraft('calibration_v3'), hyper: { ...base, optimizer: 'sgd' as const } }
    expect(validateBrainDraft(dSgd, 10).ok).toBe(true)
  })
})

// ==================== D. BỘ ĐẾM THAM SỐ (§9.1-3) ====================

describe('r88 · D bộ đếm tham số — công thức §9.1-3 trùng mlp.validateSpec', () => {
  test('hidden [16], inputDim=10 → total = (10·16+16) + (16·1+1) = 193 (pin trùng MLP.paramCount)', () => {
    const res = validateBrainDraft(validDraft('calibration_v3'), 10)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    // §9.1-3: Σ(unitsₗ × unitsₗ₋₁ + unitsₗ) — input 10 → 16 → out 1:
    //   (16×10 + 16) + (1×16 + 1) = 176 + 17 = 193
    expect(res.params.total).toBe(193)
    expect(res.params.includesInput).toBe(true)
    expect(res.params.warn).toBe(false) // 193 << 100K
    expect(res.params.blocked).toBe(false)
    // CROSS-PIN: dựng MlpSpec tương đương → MLP.paramCount() cùng công thức
    // (bằng chứng đếm ở spec-schema KHÔNG lệch mlp.validateSpec)
    const spec = {
      layers: [
        { units: 10, activation: 'linear' as const },
        { units: 16, activation: 'tanh' as const },
        { units: 1, activation: 'sigmoid' as const },
      ],
      loss: 'bce' as const,
      optimizer: 'adam' as const,
      lr: 0.01,
      l2: 0.01,
      seed: 42,
    }
    expect(new MLP(spec).paramCount()).toBe(193)
  })

  test('inputDim=2048 + hidden [256,256] → blocked=true + lỗi trần 250K (§9.1-3 ngân sách CPU)', () => {
    const d = {
      ...validDraft('calibration_v3'),
      hidden: [
        { units: 256, activation: 'tanh' as const },
        { units: 256, activation: 'tanh' as const },
      ],
    }
    const res = validateBrainDraft(d, 2048)
    // (256×2048+256) + (256×256+256) + (1×256+1) = 524544+65792+257 = 590593
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.errors.some(e => e.includes('590593') && e.includes('250000'))).toBe(true)
  })

  test('inputUnits=null (surrogate/policy động) → includesInput=false + KHÔNG chặn trần', () => {
    // Hidden khổng lồ [256,256] nhưng chưa biết chiều input → đếm không gồm
    // lớp input (66049), không chặn — mlp.validateSpec lúc train chặn thật
    const d = {
      ...validDraft('surrogate'),
      hidden: [
        { units: 256, activation: 'tanh' as const },
        { units: 256, activation: 'tanh' as const },
      ],
    }
    const res = validateBrainDraft(d, null)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.params.includesInput).toBe(false)
    // (256×256+256) + (1×256+1) = 65792 + 257 = 66049 (không gồm input)
    expect(res.params.total).toBe(66049)
    expect(res.params.blocked).toBe(false)
  })
})

// ==================== E. defaultDraftFor + PIN HỒI QUY buildV3Spec/buildPolicySpec ====================

describe('r88 · E defaultDraftFor — spec chuẩn 3 brain + PIN HỒI QUY với pipeline thật', () => {
  test('3 brain: hidden [16·tanh]×2 + [32·tanh] policy; hyper chuẩn; lossPerHead đúng rule', () => {
    for (const brain of ['calibration_v3', 'surrogate'] as const) {
      const d = defaultDraftFor(brain)
      expect(d.hidden).toEqual([{ units: 16, activation: 'tanh' }])
    }
    expect(defaultDraftFor('policy').hidden).toEqual([{ units: 32, activation: 'tanh' }])
    // Hyper chuẩn dùng chung 3 brain (calibration-v3.ts:92-97 · surrogate.ts:100-113
    // · policy.ts:124-145 · holdout/clip = mặc định mlp.ts)
    for (const brain of ['calibration_v3', 'surrogate', 'policy'] as const) {
      expect(defaultDraftFor(brain).hyper).toEqual({
        optimizer: 'adam',
        lr: 0.01,
        epochs: 500,
        batch: 32,
        l2: 0.01,
        patience: 50,
        holdout: 0.15,
        clip: 5,
        seed: 42,
      })
      // lossPerHead = ĐÚNG rule hợp đồng (không tự chế) — rule là readonly array
      expect(defaultDraftFor(brain).lossPerHead).toEqual([...BRAIN_DRAFT_RULES[brain].lossPerHead])
    }
  })

  test("PIN HỒI QUY: buildV3Spec() trùng lớp ẩn + hyper defaultDraftFor('calibration_v3')", () => {
    // Chứng minh "default draft train ra KẾT QUẢ Y HỆT không draft" (§9.3):
    // spec pipeline thật so từng trường với draft mặc định
    const draft = defaultDraftFor('calibration_v3')
    const spec = buildV3Spec()
    expect(spec.layers[0]).toEqual({ units: 10, activation: 'linear' }) // input khóa features-10
    expect(spec.layers[1]).toEqual({
      units: draft.hidden[0].units,
      activation: draft.hidden[0].activation,
    })
    expect(spec.layers[2]).toEqual({ units: 1, activation: 'sigmoid' }) // output khóa
    expect(spec.loss).toBe(draft.lossPerHead[0].type)
    expect(spec.optimizer).toBe(draft.hyper.optimizer)
    expect(spec.lr).toBe(draft.hyper.lr)
    expect(spec.l2).toBe(draft.hyper.l2)
    expect(spec.seed).toBe(draft.hyper.seed)
  })

  test("PIN HỒI QUY: buildPolicySpec(7, 4) trùng lớp ẩn + hyper defaultDraftFor('policy')", () => {
    const draft = defaultDraftFor('policy')
    const spec = buildPolicySpec(7, 4) // D=7 đặc trưng, |A|=4 model
    expect(spec.layers[0]).toEqual({ units: 7, activation: 'linear' })
    expect(spec.layers[1]).toEqual({
      units: draft.hidden[0].units,
      activation: draft.hidden[0].activation,
    })
    expect(spec.layers[2]).toEqual({ units: 4, activation: 'softmax' }) // output khóa đa lớp
    expect(spec.loss).toBe(draft.lossPerHead[0].type) // crossEntropy
    expect(spec.optimizer).toBe(draft.hyper.optimizer)
    expect(spec.lr).toBe(draft.hyper.lr)
    expect(spec.l2).toBe(draft.hyper.l2)
    expect(spec.seed).toBe(draft.hyper.seed)
  })
})

// ==================== F. ACTIVATION MENU (§9.2 bảng) ====================

describe('r88 · F ACTIVATION_MENU — 9 mục metadata đúng bảng blueprint §9.2', () => {
  test('đủ 9 mục đúng thứ tự; metadata không rỗng; softmax where=output-multiclass', () => {
    expect(ACTIVATION_MENU.map(m => m.name)).toEqual([
      'sigmoid', 'linear', 'tanh', 'relu', 'leakyRelu', 'elu', 'swish', 'gelu', 'softmax',
    ])
    for (const m of ACTIVATION_MENU) {
      expect(m.formula.length).toBeGreaterThan(0)
      expect(m.derivative.length).toBeGreaterThan(0)
      expect(['He', 'Xavier', '—']).toContain(m.init)
      expect(m.note.length).toBeGreaterThan(0)
    }
    // softmax: CHỈ lớp output đa lớp (audit B1)
    const softmax = ACTIVATION_MENU.find(m => m.name === 'softmax')!
    expect(softmax.where).toBe('output-multiclass')
    // Phân vai where đúng bảng: 6 hàm hidden + sigmoid/linear output
    const where = Object.fromEntries(ACTIVATION_MENU.map(m => [m.name, m.where]))
    expect(where.tanh).toBe('hidden')
    expect(where.relu).toBe('hidden')
    expect(where.sigmoid).toBe('output')
    expect(where.linear).toBe('output')
  })
})

// ==================== G. DOWNSAMPLE HISTORY (quỹ đạo epoch UX-2) ====================

describe('r88 · G downsampleHistory — quỹ đạo epoch xuống mẫu', () => {
  test('mảng ngắn (≤ maxPoints) trả BẢN SAO giữ nguyên (không cùng tham chiếu)', () => {
    const short = [10, 20, 30]
    const out = downsampleHistory(short, 200)
    expect(out).toEqual([10, 20, 30])
    expect(out).not.toBe(short) // bản sao — sửa out không ảnh hưởng nguồn
    expect(downsampleHistory([], 200)).toEqual([])
  })

  test('1000 điểm → 200: đúng 200 · giữ điểm đầu + cuối · tất định chạy lại', () => {
    const src = Array.from({ length: 1000 }, (_, i) => i)
    const out = downsampleHistory(src, 200)
    expect(out).toHaveLength(200)
    expect(out[0]).toBe(src[0]) // 0 — giữ điểm đầu
    expect(out[out.length - 1]).toBe(src[999]) // 999 — giữ điểm cuối
    // Tất định: 2 lần chạy ra đúng như hệt (MLP loss history reproducible)
    expect(downsampleHistory(src, 200)).toEqual(out)
  })
})

// ==================== H. DIFF (nút "So sánh với bản active") ====================

describe('r88 · H diffDraftAgainst — hàng Kiến trúc + Nguồn', () => {
  const draft = defaultDraftFor('calibration_v3')
  const target = {
    source: 'active' as const,
    layersText: 'features-10 (khóa) → 12·tanh → 1 · sigmoid (khóa)',
    params: 149,
    nSamples: 40,
    cvScore: 0.21,
  }

  test('khác kiến trúc → hàng Kiến trúc diff=true; trùng → diff=false', () => {
    const rows = diffDraftAgainst(draft, target)
    const arch = rows.find(r => r.label === 'Kiến trúc')!
    // Draft 16·tanh vs active 12·tanh → khác
    expect(arch.diff).toBe(true)
    expect(arch.draft).toContain('16·tanh')
    expect(arch.active).toContain('12·tanh')
    // Trùng kiến trúc → diff=false (không highlight giả) — draftLayers có format
    // riêng 'in(khóa) → … → out(khóa)': trùng = cùng chuỗi ĐÚNG format đó
    const same = diffDraftAgainst(draft, { ...target, layersText: 'in(khóa) → 16·tanh → out(khóa)' })
    expect(same.find(r => r.label === 'Kiến trúc')!.diff).toBe(false)
  })

  test("có hàng Nguồn phân biệt draft vs bản active / spec planned", () => {
    const rows = diffDraftAgainst(draft, target)
    const src = rows.find(r => r.label === 'Nguồn')!
    expect(src.draft).toContain('draft (BrainSpecDraft)')
    expect(src.active).toContain('bản active (thắng CV)')
    // Chưa có bản nào → so với spec planned
    const planned = diffDraftAgainst(draft, { ...target, source: 'planned' })
    expect(planned.find(r => r.label === 'Nguồn')!.active).toContain('spec planned (chưa train)')
    // Đủ 5 hàng trình bày (Kiến trúc · Tham số · Số mẫu train · CV score · Nguồn)
    expect(rows.map(r => r.label)).toEqual(['Kiến trúc', 'Tham số', 'Số mẫu train', 'CV score', 'Nguồn'])
  })
})

// ==================== I/J. API SPEC-DRAFT (DB CÔ LẬP) + BẤT BIẾN §9.1-1 ====================

/** Gọi PUT trực tiếp route handler (pattern r81/r86 — không cần server). */
function putSpec(brain: string, spec: unknown): Promise<Response> {
  return PUT(new Request('http://t/api/brain/spec-draft', {
    method: 'PUT',
    body: JSON.stringify({ brain, spec }),
  }))
}

describe('r88 · I/J API spec-draft + bất biến Draft ≠ runtime (§9.1-1) — DB cô lập', () => {
  // Seed 2 bản BrainModel (1 active) để bất biến J có "bản active" thật cần bảo vệ
  const SEED_IDS: string[] = []

  beforeAll(async () => {
    await db.brainSpecDraft.deleteMany({})
    const a = await db.brainModel.create({
      data: {
        brain: 'calibration_v3',
        version: 2,
        inputMode: 'features-10',
        specJson: '{"layers":[]}',
        weightsJson: '{"dtype":"float64","shape":[1],"data":[0]}',
        trainMetaJson: '{"nSamples":40}',
        active: true,
      },
    })
    const b = await db.brainModel.create({
      data: {
        brain: 'surrogate',
        version: 1,
        inputMode: 'full-2048',
        specJson: '{"layers":[]}',
        weightsJson: '{"dtype":"float64","shape":[1],"data":[0]}',
        trainMetaJson: '{"nSamples":56}',
        active: false,
      },
    })
    SEED_IDS.push(a.id, b.id)
  })

  afterAll(async () => {
    // Dọn đúng phần seed của file (không quét đại trà — DB copy dùng chung file khác)
    await db.brainSpecDraft.deleteMany({})
    if (SEED_IDS.length > 0) await db.brainModel.deleteMany({ where: { id: { in: SEED_IDS } } })
  })

  test('PUT hợp lệ → 200 saved:true + đúng 1 row; PUT lần 2 vẫn 1 row (upsert @unique(brain))', async () => {
    const spec = defaultDraftFor('surrogate')
    const res1 = await putSpec('surrogate', spec)
    expect(res1.status).toBe(200)
    const json1 = await res1.json()
    expect(json1.saved).toBe(true)
    expect(json1.brain).toBe('surrogate')
    expect(json1.spec.hidden).toEqual([{ units: 16, activation: 'tanh' }])
    expect(await db.brainSpecDraft.count({ where: { brain: 'surrogate' } })).toBe(1)

    // Lần 2 (note khác) — upsert theo @unique(brain), KHÔNG sinh row thứ 2
    const res2 = await putSpec('surrogate', { ...spec, note: 'r88 lần 2' })
    expect(res2.status).toBe(200)
    expect(await db.brainSpecDraft.count({ where: { brain: 'surrogate' } })).toBe(1)
    const row = await db.brainSpecDraft.findFirst({ where: { brain: 'surrogate' } })
    expect(row?.note).toBe('r88 lần 2')
  })

  test('PUT rác (units 9999) → 400 + DANH SÁCH lỗi + KHÔNG ghi row mới', async () => {
    const before = await db.brainSpecDraft.count()
    const bad = await putSpec('surrogate', {
      ...defaultDraftFor('surrogate'),
      hidden: [{ units: 9999, activation: 'tanh' }],
    })
    expect(bad.status).toBe(400)
    const json = await bad.json()
    expect(Array.isArray(json.errors)).toBe(true)
    expect(json.errors.some((e: string) => e.includes('9999'))).toBe(true)
    expect(await db.brainSpecDraft.count()).toBe(before) // không ghi bậy
  })

  test('GET → drafts đủ 3 brain + defaults đủ 3 (default cho UI fallback)', async () => {
    const res = await GET()
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.drafts).toHaveLength(3)
    expect(json.drafts.map((d: { brain: string }) => d.brain).sort()).toEqual(
      ['calibration_v3', 'policy', 'surrogate'],
    )
    // Brain đã PUT (surrogate) có nháp; 2 brain kia null (UI fallback default)
    const s = json.drafts.find((d: { brain: string }) => d.brain === 'surrogate')
    expect(s.spec).not.toBeNull()
    const a = json.drafts.find((d: { brain: string }) => d.brain === 'calibration_v3')
    expect(a.spec).toBeNull()
    // Defaults đủ 3 brain — đúng defaultDraftFor (single-source)
    expect(Object.keys(json.defaults).sort()).toEqual(['calibration_v3', 'policy', 'surrogate'])
    expect(json.defaults.surrogate).toEqual(defaultDraftFor('surrogate'))
  })

  test("PUT với spec.brain ≠ body.brain → normalized.brain = body.brain (ép khớp)", async () => {
    // spec nội dung hợp lệ cho calibration_v3 nhưng trường brain ghi 'surrogate'
    const spec = { ...defaultDraftFor('calibration_v3'), brain: 'surrogate' }
    const res = await putSpec('calibration_v3', spec)
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.spec.brain).toBe('calibration_v3') // ép theo body — tránh lệch nguồn
    expect(await db.brainSpecDraft.count({ where: { brain: 'calibration_v3' } })).toBe(1)
  })

  test('PUT brain lạ → 400 (chỉ 3 brain trong menu)', async () => {
    const res = await putSpec('brain_x', defaultDraftFor('surrogate'))
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error).toContain('không hợp lệ')
  })

  test('BẤT BIẾN §9.1-1: PUT nháp nhiều lần (kể cả 400) → BrainModel GIỐNG HỆT', async () => {
    // Chụp toàn bộ trạng thái BrainModel (id · brain · version · active · nội dung)
    const snap = (rows: Awaited<ReturnType<typeof db.brainModel.findMany>>) =>
      JSON.stringify(rows.map(r => [r.id, r.brain, r.version, r.active, r.specJson, r.weightsJson, r.trainMetaJson]))
    const before = await db.brainModel.findMany()
    expect(before.length).toBeGreaterThanOrEqual(2) // có bản active để bảo vệ

    // PUT hợp lệ 2 brain + PUT rác 1 lần — route CHỈ đụng BrainSpecDraft
    expect((await putSpec('policy', defaultDraftFor('policy'))).status).toBe(200)
    expect((await putSpec('calibration_v3', { ...defaultDraftFor('calibration_v3'), hidden: [{ units: 24, activation: 'relu' }] })).status).toBe(200)
    expect((await putSpec('surrogate', { ...defaultDraftFor('surrogate'), hyper: { ...defaultDraftFor('surrogate').hyper, lr: 99 } })).status).toBe(400)

    const after = await db.brainModel.findMany()
    // DANH SÁCH GIỐNG HỆT: count + active flags + version + spec/weights
    expect(snap(after)).toBe(snap(before))
    expect(after.filter(r => r.active)).toHaveLength(before.filter(r => r.active).length)
  })
})

// ==================== G-3PHAN. BRAIN-TAB-3PHAN (18-d) — α/β + δ Huber ====================

describe('r88 · G BRAIN-TAB-3PHAN — activationParams + huberDelta (audit đầy đủ thông số)', () => {
  test('1. leakyRelu/elu giữ alpha (drop beta); swish giữ beta (drop alpha); tanh DROP cả — không lưu rác', () => {
    // leakyRelu + {alpha 0.2, beta 3} → CHỈ alpha (beta không dùng cho leakyRelu)
    const dL = {
      ...validDraft('calibration_v3'),
      hidden: [{ units: 16, activation: 'leakyRelu' as const, activationParams: { alpha: 0.2, beta: 3 } }],
    }
    const rL = validateBrainDraft(dL, 10)
    expect(rL.ok).toBe(true)
    if (rL.ok) expect(rL.normalized.hidden[0].activationParams).toEqual({ alpha: 0.2 })
    // elu + {alpha 0.7} → giữ nguyên
    const dE = {
      ...validDraft('calibration_v3'),
      hidden: [{ units: 16, activation: 'elu' as const, activationParams: { alpha: 0.7 } }],
    }
    const rE = validateBrainDraft(dE, 10)
    expect(rE.ok).toBe(true)
    if (rE.ok) expect(rE.normalized.hidden[0].activationParams).toEqual({ alpha: 0.7 })
    // swish + {alpha 0.5, beta 2} → CHỈ beta
    const dS = {
      ...validDraft('calibration_v3'),
      hidden: [{ units: 16, activation: 'swish' as const, activationParams: { alpha: 0.5, beta: 2 } }],
    }
    const rS = validateBrainDraft(dS, 10)
    expect(rS.ok).toBe(true)
    if (rS.ok) expect(rS.normalized.hidden[0].activationParams).toEqual({ beta: 2 })
    // tanh + {alpha 0.5} (trong phạm vi — hợp lệ) → DROP CẢ: normalized KHÔNG
    // có key activationParams (không lưu {} rác)
    const dT = {
      ...validDraft('calibration_v3'),
      hidden: [{ units: 16, activation: 'tanh' as const, activationParams: { alpha: 0.5 } }],
    }
    const rT = validateBrainDraft(dT, 10)
    expect(rT.ok).toBe(true)
    if (rT.ok) expect('activationParams' in rT.normalized.hidden[0]).toBe(false)
  })

  test('2. alpha 0/-1/100/NaN → lỗi nhắc alpha; beta 0/11 → lỗi nhắc beta (DRAFT_LIMITS)', () => {
    for (const alpha of [0, -1, 100, NaN]) {
      const d = {
        ...validDraft('calibration_v3'),
        hidden: [{ units: 16, activation: 'leakyRelu' as const, activationParams: { alpha } }],
      }
      expectInvalid(validateBrainDraft(d, 10), 'alpha')
    }
    for (const beta of [0, 11]) {
      const d = {
        ...validDraft('calibration_v3'),
        hidden: [{ units: 16, activation: 'swish' as const, activationParams: { beta } }],
      }
      expectInvalid(validateBrainDraft(d, 10), 'beta')
    }
  })

  test('3. head huber + huberDelta 0.5 giữ (head 1 surrogate); head mse DROP key; 0/11 lỗi nhắc huberDelta', () => {
    const dHuber = {
      ...validDraft('surrogate'),
      lossPerHead: [
        { type: 'bce' as const, weight: 1 / 3 },
        { type: 'huber' as const, weight: 1 / 3, huberDelta: 0.5 },
        { type: 'huber' as const, weight: 1 / 3 },
      ],
    }
    const res = validateBrainDraft(dHuber, null)
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.normalized.lossPerHead[1].huberDelta).toBe(0.5)
      // Head 2 không đặt → KHÔNG có key (không lưu undefined)
      expect('huberDelta' in res.normalized.lossPerHead[2]).toBe(false)
    }
    // mse + cùng giá trị huberDelta → DROP (mse không có δ — không lỗi)
    const dMse = {
      ...validDraft('surrogate'),
      lossPerHead: [
        { type: 'bce' as const, weight: 1 / 3 },
        { type: 'mse' as const, weight: 1 / 3, huberDelta: 0.5 },
        { type: 'huber' as const, weight: 1 / 3 },
      ],
    }
    const resMse = validateBrainDraft(dMse, null)
    expect(resMse.ok).toBe(true)
    if (resMse.ok) expect('huberDelta' in resMse.normalized.lossPerHead[1]).toBe(false)
    // Ngoài [0.01, 10] → lỗi nhắc huberDelta
    for (const huberDelta of [0, 11]) {
      const d = {
        ...validDraft('surrogate'),
        lossPerHead: [
          { type: 'bce' as const, weight: 1 / 3 },
          { type: 'huber' as const, weight: 1 / 3, huberDelta },
          { type: 'huber' as const, weight: 1 / 3 },
        ],
      }
      expectInvalid(validateBrainDraft(d, null), 'huberDelta')
    }
  })

  test('4. defaultDraftFor KHÔNG thêm key mới (pin r88-E tiếp tục pass — chống hồi quy)', () => {
    const s = defaultDraftFor('surrogate')
    expect('activationParams' in s.hidden[0]).toBe(false)
    for (const h of s.lossPerHead) expect('huberDelta' in h).toBe(false)
    // Pin r88-E nguyên văn: toEqual FAIL nếu có key activationParams/huberDelta
    expect(s.hidden).toEqual([{ units: 16, activation: 'tanh' }])
    expect(defaultDraftFor('policy').hidden).toEqual([{ units: 32, activation: 'tanh' }])
    // Default = engine defaults (α 0.01/1.0 · β 1.0 · δ 1.0 — activations.ts/
    // losses.ts resolve*) → KHÔNG cần lưu key
    expect(defaultDraftFor('calibration_v3').hidden[0]).toEqual({ units: 16, activation: 'tanh' })
  })

  test('5. buildV3Spec truyền activationParams; draft không params → KHÔNG key (pin hồi quy)', () => {
    const withParams: BrainDraftSpec = {
      ...defaultDraftFor('calibration_v3'),
      hidden: [{ units: 16, activation: 'leakyRelu', activationParams: { alpha: 0.05 } }],
    }
    const spec = buildV3Spec(withParams)
    expect(spec.layers[1].activationParams).toEqual({ alpha: 0.05 })
    expect(spec.layers[1].activation).toBe('leakyRelu')
    // Draft mặc định (không params) → layers[1] CHỈ {units, activation}
    const plain = buildV3Spec(defaultDraftFor('calibration_v3'))
    expect(plain.layers[1]).toEqual({ units: 16, activation: 'tanh' })
    expect('activationParams' in plain.layers[1]).toBe(false)
    // Loss bce → không lossParams (δ chỉ có nghĩa cho huber)
    expect('lossParams' in spec).toBe(false)
  })

  test('6. buildSurrogateSpecs: head huber có huberDelta → lossParams {delta}; không có → KHÔNG key', () => {
    const vocab = { models: ['alpha', 'beta'], agents: ['FORGE', 'Omega'] }
    const d: BrainDraftSpec = {
      ...defaultDraftFor('surrogate'),
      lossPerHead: [
        { type: 'bce', weight: 1 / 3 },
        { type: 'huber', weight: 1 / 3, huberDelta: 2.5 },
        { type: 'huber', weight: 1 / 3 },
      ],
    }
    const specs = buildSurrogateSpecs(vocab, d)
    // Head 1 (tokens) loss huber + huberDelta 2.5 → lossParams {delta: 2.5}
    expect(specs.tokens.lossParams).toEqual({ delta: 2.5 })
    // Head 2 (durationMs) không đặt + success bce → KHÔNG key lossParams
    expect('lossParams' in specs.durationMs).toBe(false)
    expect('lossParams' in specs.success).toBe(false)
    // Draft mặc định → không head nào có lossParams (default engine δ=1.0)
    const specsPlain = buildSurrogateSpecs(vocab, defaultDraftFor('surrogate'))
    for (const s of Object.values(specsPlain)) expect('lossParams' in s).toBe(false)
    // Head mse + huberDelta → KHÔNG lossParams (mse không có δ)
    const dMse: BrainDraftSpec = {
      ...defaultDraftFor('surrogate'),
      lossPerHead: [
        { type: 'bce', weight: 1 / 3 },
        { type: 'mse', weight: 1 / 3, huberDelta: 2.5 },
        { type: 'huber', weight: 1 / 3, huberDelta: 3 },
      ],
    }
    const specsMse = buildSurrogateSpecs(vocab, dMse)
    expect('lossParams' in specsMse.tokens).toBe(false)
    expect(specsMse.durationMs.lossParams).toEqual({ delta: 3 })
  })

  test('7. buildPolicySpec truyền activationParams (swish beta 1.5) — CE không lossParams', () => {
    const d: BrainDraftSpec = {
      ...defaultDraftFor('policy'),
      hidden: [{ units: 32, activation: 'swish', activationParams: { beta: 1.5 } }],
    }
    const spec = buildPolicySpec(7, 4, d)
    expect(spec.layers[1].activationParams).toEqual({ beta: 1.5 })
    expect(spec.layers[1].activation).toBe('swish')
    expect('lossParams' in spec).toBe(false) // crossEntropy → không lossParams
    // Draft không params → pin hồi quy r88-E: layers[1] chỉ {units, activation}
    const plain = buildPolicySpec(7, 4, defaultDraftFor('policy'))
    expect(plain.layers[1]).toEqual({ units: 32, activation: 'tanh' })
    expect('activationParams' in plain.layers[1]).toBe(false)
  })

  test('8. FB-BRAIN-TAB-R1-04: activationParams sai shape (mảng/chuỗi/null) → LỖI validate — không còn bỏ im lặng (hợp đồng validate mọi khóa có mặt + shape như hidden/hyper/units)', () => {
    // Trước-fix: mảng rơi qua `typeof === 'object'` (alpha/beta undefined →
    // DROP im lặng, ok:true); chuỗi/null bị guard bỏ qua cũng im lặng — client
    // lỗi nhận 200 giả. Sau-fix: mọi shape sai → lỗi nhắc đúng trường.
    for (const bad of [[1, 2] as unknown, 'rác' as unknown, null as unknown]) {
      const d = {
        ...validDraft('calibration_v3'),
        hidden: [{ units: 16, activation: 'leakyRelu' as const, activationParams: bad as DraftHiddenLayer['activationParams'] }],
      }
      expectInvalid(validateBrainDraft(d, 10), 'activationParams phải là object')
    }
    // Đối chứng 2 chiều: KHÔNG có key (draft cũ pre-18-d từ DB) vẫn hợp lệ —
    // backward compat (Lớp 3e brief 18-f)
    const oldShape = validDraft('calibration_v3')
    expect(validateBrainDraft(oldShape, 10).ok).toBe(true)
    // Object đúng shape (kể cả rỗng {}) vẫn ok — {} normalize → omit key
    const emptyObj = {
      ...validDraft('calibration_v3'),
      hidden: [{ units: 16, activation: 'tanh' as const, activationParams: {} }],
    }
    const r = validateBrainDraft(emptyObj, 10)
    expect(r.ok).toBe(true)
    if (r.ok) expect('activationParams' in r.normalized.hidden[0]).toBe(false)
  })
})
