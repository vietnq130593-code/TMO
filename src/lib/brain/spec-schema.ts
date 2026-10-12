/**
 * BRAIN-UX §9.2/§9.3 (blueprint §9, user chốt 2026-10-12) — SPEC-DRAFT SCHEMA
 * ============================================================================
 *
 * Single-source (doctrine #9) cho BẢN NHÁP kiến trúc brain (BrainSpecDraft):
 * client (editor UX-1) và server (PUT /api/brain/spec-draft + train route khi
 * useDraft) cùng import ĐÚNG module này — không nhân bản rule.
 *
 * Nguyên tắc chắn §9.1:
 *  - Draft ≠ runtime (§9.1-1): bản nháp KHÔNG BAO GIỜ chạm BrainModel active —
 *    đường duy nhất lên runtime vẫn là train → thắng đối chứng CV → thăng cấp
 *    (bất biến A1). Module này không ghi DB gì cả (thuần validation/biến đổi).
 *  - Lớp input/output khoá theo vai trò (§9.1-2): draft chỉ chứa LỚP ẨN
 *    (0–6 lớp) — đầu vào/đầu ra do pipeline chốt theo hợp đồng dữ liệu.
 *  - Bộ đếm tham số (§9.1-3): cảnh báo > 100K (overfit khi 20–56 mẫu), chặn
 *    > 250K — điểm chặn thật nằm tại mlp.validateSpec (BRAIN_MAX_PARAMS);
 *    hàm đếm ở đây PHẢI cùng công thức Σ(unitsₗ × unitsₗ₋₁ + unitsₗ).
 *  - BRAIN-TAB-3PHAN (18-d): draft lộ thêm α/β activation (leakyRelu/elu/swish)
 *    từng lớp ẩn + δ Huber từng head huber — engine hỗ trợ sẵn từ BRAIN-P1
 *    (MlpLayerSpec.activationParams / MlpSpec.lossParams), draft trước đó
 *    không có trường. CHUẨN HOÁ chỉ giữ khóa activation DÙNG ĐÚNG (leakyRelu/
 *    elu→alpha · swish→beta · khác→DROP; head≠huber→DROP huberDelta) — không
 *    lưu rác; default KHÔNG thêm key (engine defaults α 0.01/1.0 · β 1.0 ·
 *    δ 1.0 — pin hồi quy r88-E toEqual).
 *
 * Thuần hằng số + toán — KHÔNG import db (an toàn client bundle + bun:test).
 * Import từ mlp.ts mỗi mình hằng BRAIN_MAX_PARAMS (mlp thuần toán, không phụ
 * thuộc db — cùng chuẩn activations.ts đã dùng client từ BRAIN-P1).
 */

import type { ActivationName } from './activations'
import { ACTIVATIONS } from './activations'
import { BRAIN_MAX_PARAMS } from './mlp'
import type { BrainKey } from './registry'

// ==================== TYPES ====================

/**
 * Một lớp ẩn trong bản nháp — chỉnh được (UX-1 editor).
 * BRAIN-TAB-3PHAN (18-d): activationParams α (leakyRelu 0.01/elu 1.0) / β
 * (swish 1.0) — engine MlpLayerSpec.activationParams có sẵn từ BRAIN-P1
 * (activations.ts resolveAlpha/resolveBeta), giờ mới lộ draft/UI. KHÔNG có
 * key = engine defaults (r88-E pin default hidden toEqual {units, activation}).
 */
export interface DraftHiddenLayer {
  units: number
  activation: ActivationName
  /** MỚI (18-d): tham số α (leakyRelu/elu) / β (swish) — normalize DROP khi activation không dùng (không lưu rác) */
  activationParams?: { alpha?: number; beta?: number }
}

/**
 * Loss 1 đầu ra (UX-2 nhóm B). type khóa theo hợp đồng pipeline từng brain.
 * BRAIN-TAB-3PHAN (18-d): huberDelta — engine MlpSpec.lossParams có sẵn từ
 * BRAIN-P1 (losses.ts resolveDelta default 1.0); chỉ có nghĩa khi type='huber'
 * (normalize DROP khi khác — bce/crossEntropy/mse không có δ).
 */
export interface DraftLossHead {
  /** 'bce' | 'crossEntropy' | 'mse' | 'huber' — menu mlp.ts losses */
  type: 'bce' | 'crossEntropy' | 'mse' | 'huber'
  /** Trọng số thô ∈ [0,1] — chuẩn hoá Σλ=1 lúc APPLY (hiển thị %) */
  weight: number
  /** MỚI (18-d): δ Huber (chỉ type='huber' — normalize DROP khi khác) */
  huberDelta?: number
}

/** Siêu tham số khối train (UX-2 nhóm A) — phạm vi §9.3. */
export interface DraftHyper {
  optimizer: 'sgd' | 'adam'
  lr: number
  epochs: number
  batch: number
  l2: number
  patience: number
  holdout: number
  clip: number
  seed: number
}

/** Bản nháp đầy đủ của 1 brain — lưu tại bảng BrainSpecDraft.specJson. */
export interface BrainDraftSpec {
  brain: BrainKey
  hidden: DraftHiddenLayer[]
  lossPerHead: DraftLossHead[]
  hyper: DraftHyper
  /** Lý do chỉnh sửa — hiển thị trong diff (schema §9.7 note) */
  note?: string
}

// ==================== LIMITS (§9.2/§9.3 — hardcode kèm nguồn, doctrine #1) ====================

export const DRAFT_LIMITS = {
  /** Số lớp ẩn tối đa (§9.2 editor: 0–6) */
  hiddenLayersMax: 6,
  /** Nơ-ron/lớp (§9.2 stepper 1–256) */
  unitsMin: 1,
  unitsMax: 256,
  /** Cảnh báo overfit (§9.1-3) */
  paramsWarn: 100_000,
  /** Trần ngân sách CPU — trùng BRAIN_MAX_PARAMS mlp.ts (điểm chặn thật) */
  paramsMax: BRAIN_MAX_PARAMS,
  /** Siêu tham số (§9.3 nhóm A) */
  lrMin: 1e-4,
  lrMax: 1,
  epochsMin: 50,
  epochsMax: 5000,
  batchMin: 8,
  batchMax: 256,
  l2Min: 0,
  l2Max: 0.1,
  patienceMin: 10,
  patienceMax: 200,
  holdoutMin: 0.1,
  holdoutMax: 0.3,
  clipMin: 1,
  clipMax: 10,
  /** Trọng số loss từng đầu (§9.3 nhóm B) */
  weightMin: 0,
  weightMax: 1,
  /**
   * BRAIN-TAB-3PHAN (18-d) — tham số hàm kích hoạt + δ Huber (audit "đủ thông
   * số" user 2026-10-12). Hàm ý: engine hỗ trợ từ BRAIN-P1, draft giờ mới lộ;
   * [0.001, 10]/[0.01, 10] hẹp hơn engine (>0 hữu hạn — mlp.validateSpec) để
   * editor không nhận giá trị vô nghĩa; default KHÔNG lưu key (engine defaults
   * α 0.01/1.0, β 1.0, δ 1.0 — xem activations.ts/losses.ts).
   */
  alphaMin: 0.001,
  alphaMax: 10,
  betaMin: 0.01,
  betaMax: 10,
  huberDeltaMin: 0.01,
  huberDeltaMax: 10,
} as const

// ==================== MENU 9 ACTIVATION (§9.2 bảng — metadata hiển thị) ====================

export interface ActivationMenuEntry {
  name: ActivationName
  /** Công thức hiển thị (đúng cột blueprint §9.2) */
  formula: string
  derivative: string
  init: 'He' | 'Xavier' | '—'
  /** Chỗ hợp lệ: 'hidden' | 'output' | 'output-multiclass' */
  where: 'hidden' | 'output' | 'output-multiclass'
  note: string
}

/**
 * Menu 9 hàm cho dropdown UX-1 — metadata ĐÚNG bảng blueprint §9.2; bản thân
 * hàm + đạo hàm sống ở activations.ts (đã đủ 9 từ BRAIN-P1 — test r84).
 * softmax: CHỈ lớp output đa lớp (audit B1) — where='output-multiclass'.
 */
export const ACTIVATION_MENU: readonly ActivationMenuEntry[] = [
  { name: 'sigmoid', formula: 'σ(x)=1/(1+e⁻ˣ)', derivative: 'σ(1−σ)', init: 'Xavier', where: 'output', note: 'đầu ra xác suất 0–1 (Brain-A output)' },
  { name: 'linear', formula: 'f(x)=x', derivative: '1', init: '—', where: 'output', note: 'hồi quy giá trị thô (E[tokens], E[latency] Brain-B)' },
  { name: 'tanh', formula: '(eˣ−e⁻ˣ)/(eˣ+e⁻ˣ)', derivative: '1−f²', init: 'Xavier', where: 'hidden', note: 'mặc định lớp ẩn các spec hiện tại' },
  { name: 'relu', formula: 'max(0, x)', derivative: 'x>0 ? 1 : 0', init: 'He', where: 'hidden', note: 'nhanh, chống bão hoà gradient; có thể chết đơn vị khi lr lớn' },
  { name: 'leakyRelu', formula: 'max(αx, x) · α=0.01', derivative: 'x>0 ? 1 : α', init: 'He', where: 'hidden', note: 'chống "chết đơn vị" của ReLU' },
  { name: 'elu', formula: 'x>0 ? x : α(eˣ−1) · α=1.0', derivative: 'x>0 ? 1 : f+α', init: 'He', where: 'hidden', note: 'nhánh âm trơn, trung bình đầu ra ≈ 0' },
  { name: 'swish', formula: 'x·σ(βx) · β=1.0', derivative: 'σ(βx)·(1+βx·(1−σ(βx)))', init: 'He', where: 'hidden', note: 'mượt, mạnh trên mạng sâu' },
  { name: 'gelu', formula: 'x·Φ(x) (xấp xỉ tanh)', derivative: 'x·φ(x)+Φ(x)', init: 'He', where: 'hidden', note: 'chuẩn transformer' },
  { name: 'softmax', formula: 'eˣⁱ/Σⱼeˣʲ', derivative: 'đi kèm cross-entropy', init: '—', where: 'output-multiclass', note: 'CHỈ lớp output đa lớp (audit B1)' },
]

// ==================== QUY TẮC TỪNG BRAIN (hợp đồng pipeline — khóa) ====================

export interface BrainDraftRule {
  brain: BrainKey
  /** Số unit lớp đầu vào khi biết chiều (null = động/chưa đo được) */
  inputUnits: number | null
  /**
   * Số unit lớp OUTPUT khi biết trước theo hợp đồng (FB-BRAIN-UX-R1-02):
   * A: 1 (sigmoid nhị phân) · B: 1 (mỗi head 1 MLP riêng) · C: null (×|A|
   * động — đo lúc train; override qua outputUnitsOverride khi biết |A|).
   */
  outputUnits: number | null
  /** Nhãn lớp input khi động (vd '1-hot cfg') */
  inputLabel: string
  /** Đầu ra: mô tả khóa (units + activation theo hợp đồng pipeline) */
  outputLabel: string
  /** Loss mỗi đầu ra — type KHÔA (hợp đồng); weight chỉnh được chỉ khi editableWeights */
  lossPerHead: readonly DraftLossHead[]
  /** weight chỉnh được? (B: 3 đầu — §9.3 nhóm B; A/C: đơn đầu ra, chỉ hiển thị) */
  editableWeights: boolean
  /**
   * Loại loss cho phép đổi mỗi vị trí head (rỗng = khóa hoàn toàn). Chỉ LOẠI
   * loss khóa/đổi được tại đây — huberDelta (18-d) là THAM SỐ của head huber,
   * chỉnh được riêng qua DraftLossHead.huberDelta (không phải loại loss mới —
   * không đổi giá trị rule này).
   */
  editableLossTypes: ReadonlyArray<readonly ('bce' | 'crossEntropy' | 'mse' | 'huber')[]>
}

/**
 * Hợp đồng pipeline từng brain — nguồn: code thật (calibration-v3.ts,
 * brains/surrogate.ts, brains/policy.ts tại commit UX-1). A: BCE khóa
 * (output sigmoid nhị phân); B: success BCE khóa, tokens/duration
 * huber⇄mse đổi được (đều hồi quy log1p space); C: CE khóa (softmax đa lớp).
 */
export const BRAIN_DRAFT_RULES: Readonly<Record<BrainKey, BrainDraftRule>> = {
  calibration_v3: {
    brain: 'calibration_v3',
    inputUnits: 10, // features-10 (V3_INPUT_MODE — calibration-v3.ts)
    outputUnits: 1, // output sigmoid nhị phân (khóa)
    inputLabel: 'features-10 (khóa)',
    outputLabel: '1 · sigmoid (khóa)',
    lossPerHead: [{ type: 'bce', weight: 1 }],
    editableWeights: false,
    editableLossTypes: [],
  },
  surrogate: {
    brain: 'surrogate',
    inputUnits: null, // D = vocab.models + vocab.agents + 1 (động — đo lúc train)
    outputUnits: 1, // mỗi head MỘT MLP riêng 1 unit output (khóa)
    inputLabel: '1-hot cấu hình (D động)',
    outputLabel: '3 đầu riêng: 1·sigmoid · 1·linear · 1·linear (khóa)',
    lossPerHead: [
      { type: 'bce', weight: 1 / 3 },
      { type: 'huber', weight: 1 / 3 },
      { type: 'huber', weight: 1 / 3 },
    ],
    editableWeights: true,
    editableLossTypes: [[], ['huber', 'mse'], ['huber', 'mse']],
  },
  policy: {
    brain: 'policy',
    inputUnits: null, // task-features động (buildTaskFeatures — policy.ts)
    outputUnits: null, // ×|A| động — không biết trước (buildPolicySpec đo lúc train)
    inputLabel: 'đặc trưng nhiệm vụ (động)',
    outputLabel: '×|A| model · softmax (khóa)',
    lossPerHead: [{ type: 'crossEntropy', weight: 1 }],
    editableWeights: false,
    editableLossTypes: [],
  },
}

// ==================== VALIDATE ====================

export interface DraftValidationOk {
  ok: true
  /** Draft đã chuẩn hoá (sắp xếp/kẹp theo rule — lưu ĐÚNG bản này) */
  normalized: BrainDraftSpec
  /** Bộ đếm tham số (không gồm lớp input khi inputUnits chưa biết) */
  params: { total: number | null; includesInput: boolean; warn: boolean; blocked: boolean; note?: string }
}
export interface DraftValidationErr {
  ok: false
  errors: string[]
}

/**
 * Kiểm tra bản nháp — trả DANH SÁCH lỗi (không văng ở lỗi đầu) để editor
 * hiển thị hết một lượt. inputUnits: chiều đầu vào HIỆN TẠI đo được (từ
 * /api/brain) hoặc null nếu chưa đo — khi đó bỏ kiểm trần tham số (vì thiếu
 * số chiều input) nhưng vẫn giữ mọi rule còn lại; mlp.validateSpec lúc train
 * là điểm chặn thật (§9.1-3). outputUnitsOverride (FB-BRAIN-UX-R1-02): số
 * unit lớp output HIỆN TẠI (vd |A| của policy từ bản active — /api/brain
 * outputDim) — không truyền/null thì dùng rule.outputUnits, cuối cùng 1.
 */
export function validateBrainDraft(input: unknown, inputUnits: number | null, outputUnitsOverride?: number | null): DraftValidationOk | DraftValidationErr {
  const errors: string[] = []
  const d = input as Partial<BrainDraftSpec> | null
  if (!d || typeof d !== 'object') return { ok: false, errors: ['Draft phải là object'] }
  const brain = d.brain
  const rule = brain !== undefined && brain !== null && brain in BRAIN_DRAFT_RULES
    ? BRAIN_DRAFT_RULES[brain as BrainKey]
    : null
  if (!rule) return { ok: false, errors: [`brain '${String(brain)}' không có trong menu (calibration_v3 | surrogate | policy)`] }

  // ── hidden layers ──
  const hiddenIn = d.hidden
  if (!Array.isArray(hiddenIn)) return { ok: false, errors: ['hidden phải là mảng lớp ẩn'] }
  if (hiddenIn.length > DRAFT_LIMITS.hiddenLayersMax) {
    errors.push(`Số lớp ẩn ${hiddenIn.length} > ${DRAFT_LIMITS.hiddenLayersMax} (§9.2 editor)`)
  }
  const hidden: DraftHiddenLayer[] = []
  for (let i = 0; i < Math.min(hiddenIn.length, DRAFT_LIMITS.hiddenLayersMax); i++) {
    const l = hiddenIn[i] as Partial<DraftHiddenLayer> | null
    const u = l?.units
    if (typeof u !== 'number' || !Number.isInteger(u) || u < DRAFT_LIMITS.unitsMin || u > DRAFT_LIMITS.unitsMax) {
      errors.push(`Lớp ẩn ${i + 1}: units ${String(u)} ngoài [${DRAFT_LIMITS.unitsMin}, ${DRAFT_LIMITS.unitsMax}]`)
      continue
    }
    const a = l?.activation as ActivationName | undefined
    if (!a || !ACTIVATIONS[a]) {
      errors.push(`Lớp ẩn ${i + 1}: activation '${String(a)}' không có trong menu 9 hàm`)
      continue
    }
    if (a === 'softmax') {
      errors.push(`Lớp ẩn ${i + 1}: softmax CHỈ dùng cho lớp output đa lớp (audit B1 — §9.2)`)
      continue
    }
    // BRAIN-TAB-3PHAN (18-d): α/β từng lớp ẩn — validate MỌI khóa có mặt
    // (hữu hạn + trong DRAFT_LIMITS — hẹp hơn engine >0 để editor không nhận
    // giá trị vô nghĩa), rồi CHUẨN HOÁ chỉ giữ khóa activation DÙNG ĐÚNG:
    // leakyRelu/elu → alpha · swish → beta · activation khác → DROP cả (không
    // lưu rác); sau lọc rỗng → omit key (KHÔNG lưu {}).
    // FB-BRAIN-TAB-R1-04: activationParams CÓ MẶT nhưng sai shape (mảng /
    // chuỗi / null — trước đây rơi qua guard `typeof === 'object'` của mảng
    // hoặc bị bỏ im lặng) → BÁO LỖI như mọi shape violation khác (hidden
    // không mảng, hyper không object, units không số) — client lỗi nhận 400
    // đúng hợp đồng, không 200 giả.
    const apIn = (l as { activationParams?: unknown }).activationParams
    let activationParams: DraftHiddenLayer['activationParams'] | undefined
    if (apIn !== undefined && (apIn === null || typeof apIn !== 'object' || Array.isArray(apIn))) {
      errors.push(`Lớp ẩn ${i + 1}: activationParams phải là object { alpha?, beta? }`)
    } else if (apIn) {
      const alpha = (apIn as { alpha?: unknown }).alpha
      const beta = (apIn as { beta?: unknown }).beta
      if (alpha !== undefined) {
        if (typeof alpha !== 'number' || !Number.isFinite(alpha) || alpha < DRAFT_LIMITS.alphaMin || alpha > DRAFT_LIMITS.alphaMax) {
          errors.push(`Lớp ẩn ${i + 1}: alpha ${String(alpha)} ngoài [${DRAFT_LIMITS.alphaMin}, ${DRAFT_LIMITS.alphaMax}]`)
        } else if (a === 'leakyRelu' || a === 'elu') {
          activationParams = { ...activationParams, alpha }
        }
      }
      if (beta !== undefined) {
        if (typeof beta !== 'number' || !Number.isFinite(beta) || beta < DRAFT_LIMITS.betaMin || beta > DRAFT_LIMITS.betaMax) {
          errors.push(`Lớp ẩn ${i + 1}: beta ${String(beta)} ngoài [${DRAFT_LIMITS.betaMin}, ${DRAFT_LIMITS.betaMax}]`)
        } else if (a === 'swish') {
          activationParams = { ...activationParams, beta }
        }
      }
    }
    hidden.push(activationParams ? { units: u, activation: a, activationParams } : { units: u, activation: a })
  }

  // ── lossPerHead ──
  const headsIn = d.lossPerHead
  if (!Array.isArray(headsIn) || headsIn.length !== rule.lossPerHead.length) {
    errors.push(`lossPerHead phải có đúng ${rule.lossPerHead.length} đầu ra cho brain '${rule.brain}'`)
  }
  const heads: DraftLossHead[] = []
  const headsArr = Array.isArray(headsIn) ? headsIn : []
  for (let i = 0; i < rule.lossPerHead.length; i++) {
    const h = headsArr[i] as Partial<DraftLossHead> | undefined
    const lockedType = rule.lossPerHead[i].type
    const allowed = rule.editableLossTypes[i]
    const t = h?.type
    if (typeof t !== 'string' || !['bce', 'crossEntropy', 'mse', 'huber'].includes(t)) {
      errors.push(`Đầu ra ${i + 1}: loại loss '${String(t)}' không hợp lệ`)
      continue
    }
    if (t !== lockedType && !(allowed as readonly string[] | undefined)?.includes(t)) {
      errors.push(`Đầu ra ${i + 1}: loss '${t}' khóa theo hợp đồng pipeline (chỉ '${lockedType}'${allowed?.length ? ` hoặc ${allowed.join('/')}` : ''})`)
      continue
    }
    const w = h?.weight
    if (typeof w !== 'number' || !Number.isFinite(w) || w < DRAFT_LIMITS.weightMin || w > DRAFT_LIMITS.weightMax) {
      errors.push(`Đầu ra ${i + 1}: trọng số ${String(w)} ngoài [0, 1]`)
      continue
    }
    // BRAIN-TAB-3PHAN (18-d): δ Huber — chỉ có nghĩa khi type='huber' (bce/
    // crossEntropy/mse không có δ → normalize DROP, không lưu rác). Hữu hạn
    // trong [0.01, 10] — hẹp hơn engine (>0 — mlp.validateSpec lossParams).
    // Không đặt key = engine default resolveDelta 1.0 (losses.ts).
    let huberDelta: number | undefined
    if (t === 'huber' && h?.huberDelta !== undefined) {
      const hd = h.huberDelta
      if (typeof hd !== 'number' || !Number.isFinite(hd) || hd < DRAFT_LIMITS.huberDeltaMin || hd > DRAFT_LIMITS.huberDeltaMax) {
        errors.push(`Đầu ra ${i + 1}: huberDelta ${String(hd)} ngoài [${DRAFT_LIMITS.huberDeltaMin}, ${DRAFT_LIMITS.huberDeltaMax}]`)
      } else {
        huberDelta = hd
      }
    }
    heads.push(huberDelta !== undefined ? { type: t as DraftLossHead['type'], weight: w, huberDelta } : { type: t as DraftLossHead['type'], weight: w })
  }

  // ── hyper ──
  const hIn = d.hyper as Partial<DraftHyper> | null | undefined
  if (!hIn || typeof hIn !== 'object') {
    errors.push('hyper phải là object siêu tham số')
  }
  const h = hIn ?? ({} as Partial<DraftHyper>)
  if (h.optimizer !== 'sgd' && h.optimizer !== 'adam') errors.push(`optimizer '${String(h.optimizer)}' phải là 'sgd' | 'adam'`)
  const num = (v: unknown, lo: number, hi: number, label: string, int = false): number | null => {
    if (typeof v !== 'number' || !Number.isFinite(v)) { errors.push(`${label}: không phải số hợp lệ`); return null }
    if (int && !Number.isInteger(v)) { errors.push(`${label}: phải là số nguyên`); return null }
    if (v < lo || v > hi) { errors.push(`${label}: ${v} ngoài [${lo}, ${hi}] (§9.3)`); return null }
    return v
  }
  const lr = num(h.lr, DRAFT_LIMITS.lrMin, DRAFT_LIMITS.lrMax, 'lr')
  const epochs = num(h.epochs, DRAFT_LIMITS.epochsMin, DRAFT_LIMITS.epochsMax, 'epochs', true)
  const batch = num(h.batch, DRAFT_LIMITS.batchMin, DRAFT_LIMITS.batchMax, 'batch', true)
  const l2 = num(h.l2, DRAFT_LIMITS.l2Min, DRAFT_LIMITS.l2Max, 'l2')
  const patience = num(h.patience, DRAFT_LIMITS.patienceMin, DRAFT_LIMITS.patienceMax, 'patience', true)
  const holdout = num(h.holdout, DRAFT_LIMITS.holdoutMin, DRAFT_LIMITS.holdoutMax, 'holdout')
  const clip = num(h.clip, DRAFT_LIMITS.clipMin, DRAFT_LIMITS.clipMax, 'clip')
  const seedOk = typeof h.seed === 'number' && Number.isInteger(h.seed) && h.seed >= 0
  if (!seedOk) errors.push(`seed ${String(h.seed)} phải là số nguyên ≥ 0`)

  // ── bộ đếm tham số (§9.1-3) ──
  // Công thức PHẢI trùng mlp.validateSpec: Σ(unitsₗ × unitsₗ₋₁ + unitsₗ).
  // Với brain động (surrogate/policy) khi inputUnits null: đếm không gồm
  // lớp input (includesInput=false) — không chặn trần (thiếu chiều input),
  // mlp.validateSpec lúc train chặn thật.
  const units = (u: number | null): number => (u === null ? 0 : u)
  // FB-BRAIN-UX-R1-02: thay dead ternary '? 1 : 1' — output thật từng brain:
  // A 1 · B 1 (mỗi head 1 MLP) · C ×|A| động (rule null → tạm 1 khi chưa biết,
  // kèm params.note nhắc chưa gồm đủ ×|A| — chặn thật tại mlp.validateSpec).
  const outUnits = outputUnitsOverride ?? rule.outputUnits ?? 1
  const dims: number[] = []
  const inU = units(inputUnits)
  if (inputUnits !== null) dims.push(inU)
  for (const l of hidden) dims.push(l.units)
  dims.push(outUnits)
  let total = 0
  for (let i = 1; i < dims.length; i++) total += dims[i] * dims[i - 1] + dims[i]
  const includesInput = inputUnits !== null
  const blocked = includesInput && total > DRAFT_LIMITS.paramsMax
  if (blocked) errors.push(`Tổng tham số ${total} vượt trần ${DRAFT_LIMITS.paramsMax} (§9.1-3 — ngân sách CPU)`)

  if (errors.length > 0) return { ok: false, errors }

  const hyper: DraftHyper = {
    optimizer: h.optimizer as 'sgd' | 'adam',
    lr: lr as number,
    epochs: epochs as number,
    batch: batch as number,
    l2: l2 as number,
    patience: patience as number,
    holdout: holdout as number,
    clip: clip as number,
    seed: h.seed as number,
  }
  return {
    ok: true,
    normalized: {
      brain: rule.brain,
      hidden,
      lossPerHead: heads,
      hyper,
      note: typeof d.note === 'string' && d.note.trim() ? d.note.trim().slice(0, 500) : undefined,
    },
    params: {
      total: includesInput ? total : total > 0 ? total : null,
      includesInput,
      warn: includesInput && total > DRAFT_LIMITS.paramsWarn,
      blocked,
      // FB-BRAIN-UX-R1-02: policy chưa biết ×|A| (không override số) → đếm
      // tạm theo 1 unit output — nói rõ để không tưởng là đủ (chặn thật tại
      // mlp.validateSpec lúc train khi biết |A| thật).
      note: rule.brain === 'policy' && outputUnitsOverride == null
        ? 'policy: chưa gồm đủ ×|A| (động — chặn thật tại mlp.validateSpec lúc train)'
        : undefined,
    },
  }
}

// ==================== CHUẨN HOÁ TRỌNG SỐ LOSS (§9.3 nhóm B) ====================

/**
 * Chuẩn hoá Σλ=1 tự động (hiển thị %). Đầu vào bất hợp lệ (Σ=0, NaN, âm)
 * → chia đều (fail-open về default 1/n). Trả về CŨNG độ dài input.
 */
export function normalizeLossWeights(weights: readonly number[]): number[] {
  const n = weights.length
  if (n === 0) return []
  const clean = weights.map(w => (typeof w === 'number' && Number.isFinite(w) && w > 0 ? w : 0))
  const sum = clean.reduce((a, b) => a + b, 0)
  if (sum <= 0) return new Array<number>(n).fill(1 / n)
  return clean.map(w => w / sum)
}

/**
 * Hệ số scale mỗi đầu ra khi train (Brain-B 3 MLP riêng): scaleᵢ = λᵢ × n —
 * default chia đều (1/n mỗi đầu) cho scale 1.0 mỗi đầu = ĐÚNG hành vi trước
 * UX-2 (bằng chứng hồi quy: default draft phải train ra kết quả y hệt không
 * draft). mlp.ts FitOptions.lossScale nhân vào loss trước khi backprop.
 */
export function lossScalePerHead(weights: readonly number[]): number[] {
  const n = weights.length
  if (n === 0) return []
  return normalizeLossWeights(weights).map(w => w * n)
}

// ==================== DEFAULT DRAFT (nút "Phục hồi spec chuẩn") ====================

/**
 * Draft mặc định = ĐÚNG spec đang chạy trong pipeline (không đổi hành vi):
 * 3 brain dùng chung adam · lr 0.01 · l2 0.01 · epochs 500 · patience 50 ·
 * batch 32 · seed 42 (calibration-v3.ts:92-97 · surrogate.ts:100-112 ·
 * policy.ts:124-145) · holdout 0.15 / clip 5 (mặc định mlp.ts). Lớp ẩn:
 * A/B: 16 tanh · C: 32 tanh (registry planned).
 */
export function defaultDraftFor(brain: BrainKey): BrainDraftSpec {
  const rule = BRAIN_DRAFT_RULES[brain]
  const hiddenUnits = brain === 'policy' ? 32 : 16
  return {
    brain,
    hidden: [{ units: hiddenUnits, activation: 'tanh' }],
    lossPerHead: rule.lossPerHead.map(h => ({ ...h })),
    hyper: {
      optimizer: 'adam',
      lr: 0.01,
      epochs: 500,
      batch: 32,
      l2: 0.01,
      patience: 50,
      holdout: 0.15,
      clip: 5,
      seed: 42,
    },
  }
}

// ==================== DIFF (nút "So sánh với bản active") ====================

export interface DraftDiffRow {
  label: string
  draft: string
  active: string
  /** true khi 2 bên khác nhau (highlight) */
  diff: boolean
}

/** Tóm tắt 1 bên để so sánh — active lấy từ BrainModel (specJson + meta) hoặc planned registry. */
export interface DraftCompareTarget {
  source: 'active' | 'planned'
  layersText: string
  params: number | null
  nSamples: number | null
  cvScore: number | null
}

/**
 * Diff draft vs bản active (hoặc spec planned khi chưa có bản nào) — hiển thị
 * từng dòng: kiến trúc · tham số · n mẫu · CV score. Thuần trình bày — không
 * phán xét thắng/thua (CV lúc train mới phán xét, §9.1-1). draftParams
 * (FB-BRAIN-UX-R1-05): tổng tham số phía draft (từ validateBrainDraft khi
 * biết chiều input — null/không truyền → '—' trung thực).
 */
export function diffDraftAgainst(draft: BrainDraftSpec, target: DraftCompareTarget, draftParams?: number | null): DraftDiffRow[] {
  const draftLayers = [
    'in(khóa)',
    ...draft.hidden.map(l => `${l.units}·${l.activation}`),
    'out(khóa)',
  ].join(' → ')
  const rows: DraftDiffRow[] = [
    { label: 'Kiến trúc', draft: draftLayers, active: target.layersText, diff: draftLayers !== target.layersText },
    { label: 'Tham số', draft: draftParams != null ? draftParams.toLocaleString('vi-VN') : '—', active: target.params === null ? '—' : target.params.toLocaleString('vi-VN'), diff: false },
    { label: 'Số mẫu train', draft: '(chưa train)', active: target.nSamples === null ? '—' : target.nSamples.toLocaleString('vi-VN'), diff: false },
    {
      label: 'CV score',
      draft: '(chưa train)',
      active: target.cvScore === null ? '—' : target.cvScore.toFixed(3),
      diff: false,
    },
    { label: 'Nguồn', draft: 'draft (BrainSpecDraft)', active: target.source === 'active' ? 'bản active (thắng CV)' : 'spec planned (chưa train)', diff: false },
  ]
  return rows
}

// ==================== DOWN-SAMPLE QUỸ ĐẠO EPOCH (train response UX-2) ====================

/**
 * Lấy tối đa maxPoints điểm từ history epoch (giữ điểm đầu + cuối + chia đều)
 * — quỹ đạo loss hiển thị sau khi train xong (MLP nhỏ chạy ~giây, stream
 * realtime từng epoch là over-engineering — ghi nhận quyết định blueprint
 * v0.10). Tất định, thuần.
 */
export function downsampleHistory<T>(history: readonly T[], maxPoints: number): T[] {
  if (maxPoints < 2) throw new Error('downsampleHistory: maxPoints ≥ 2')
  if (history.length <= maxPoints) return [...history]
  const out: T[] = [history[0]]
  const step = (history.length - 1) / (maxPoints - 1)
  for (let i = 1; i < maxPoints - 1; i++) {
    const idx = Math.round(i * step)
    if (idx > 0 && idx < history.length - 1) out.push(history[idx])
  }
  out.push(history[history.length - 1])
  return out
}

