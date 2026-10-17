/**
 * HN-P1 (BLUEPRINT-HYPERNAS-P1-P5 §3.1/§4.1 — Task 26-c) — SEARCH SPACE
 * ============================================================================
 *
 * Nền search space HyperNAS: encoding 96 chiều TẤT ĐỊNH, bijective trong biên
 * DRAFT_LIMITS (xem các LỚP TƯƠNG ĐƯƠNG NGỮ NGHĨA dưới) + sampler ứng viên
 * ngẫu nhiên trong biên. Bất biến H1–H6 (blueprint §1.1):
 *  - H1/H2: module này KHÔNG BAO GIỜ đụng BrainModel/active — search chỉ đề
 *    xuất; đường lên runtime vẫn là train → thắng CV → thăng cấp (A1).
 *  - H3: ngân sách theo hằng số SEARCH_* dưới đây (caller HN-P2 tuân thủ).
 *  - H4: TẤT ĐỊNH — module KHÔNG dùng Math.random/Date; mọi ngẫu nhiên chảy
 *    qua tham số `rng: () => number` do caller truyền (makeRng(seed) sống ở
 *    init.ts — module này KHÔNG import init.ts để giữ thuần client-safe;
 *    cùng seed + cùng inputUnits → cùng dãy ứng viên bit-đối-bit).
 *  - H5: prune giữ SEARCH_SESSIONS_KEEP session + SEARCH_CANDIDATES_KEEP ứng
 *    viên (triển khai ở HN-P2).
 *  - H6: candidate KHÔNG lưu weights — chỉ spec + encoding + metrics.
 *
 * Thuần hằng số + toán — KHÔNG import db (an toàn client bundle + bun:test,
 * doctrine #9 single-source: DRAFT_LIMITS/ACTIVATION_MENU/BRAIN_DRAFT_RULES/
 * validateBrainDraft/defaultDraftFor/normalizeLossWeights từ './spec-schema',
 * BrainKey/BRAIN_TRAINABLE_KEYS từ './registry').
 *
 * BẢN VẼ SLOT 96 CHIỀU (§3.1 — tổng 1+6+54+6+12+3+1+9+1+3 = 96; pin r100):
 * ```
 * [0]      nLayers/6                                        (0–1)
 * [1..6]   units từng lớp /256 (pad 0 khi thiếu lớp)        (0–1)
 * [7..60]  activation one-hot 9 × 6 vị trí lớp (pad 0-vector khi thiếu lớp)
 *          — thứ tự lấy từ ACT_ORDER (9 mục ACTIVATION_MENU §9.2)
 * [61..66] α hoặc β từng lớp: log-scale chuẩn hoá [0,1]; activation không
 *          dùng α/β → 0. leakyRelu/elu dùng alpha (alphaMin..alphaMax),
 *          swish dùng beta (betaMin..betaMax); KHÔNG có key trong spec →
 *          dùng default engine (leakyRelu α 0.01 · elu α 1.0 · swish β 1.0)
 * [67..78] lossPerHead type one-hot 4 × 3 đầu = 12 slot — thứ tự
 *          LOSS_ORDER ['bce','crossEntropy','mse','huber']; đầu KHÔNG tồn
 *          tại (brain < 3 đầu) → toàn 0; phần KHÓA vẫn encode ĐÚNG loại rule
 * [79..81] trọng số từng head (Σλ=1 — normalizeLossWeights; brain 1 đầu = [1,0,0])
 * [82]     δ Huber log-scale [0,1]; head không huber → 0
 * [83..91] hyper 9 slot chuẩn hoá [0,1] theo min/max DRAFT_LIMITS, THỨ TỰ
 *          CỐ ĐỊNH: [83] optimizer (sgd=0, adam=1) · [84] lr · [85] epochs ·
 *          [86] batch · [87] l2 · [88] patience · [89] holdout · [90] clip ·
 *          [91] seed/SEED_MAX
 * [92]     inputDim/2048 (0 khi chưa biết — inputUnits null)
 * [93..95] brainKey one-hot 3 theo thứ tự BRAIN_TRAINABLE_KEYS
 *          (calibration_v3, surrogate, policy — R24-b: knowledge ghost §8.5
 *          CHƯA vào search space, vào khi D3/EVO mở encoding §8.4)
 * ```
 *
 * QUYẾT ĐỊNH THIẾT KẾ (hiệu đính blueprint sẽ ghi ở nơi khác — mọi cái đều
 * để predictor + round-trip ổn định, mỗi cái nêu lý do):
 *  1. δ slot [82] = δ của head huber ĐẦU TIÊN (default engine 1.0 khi không
 *     có key); decode áp dụng δ đó cho MỌI head huber → bijective trên không
 *     gian con "mọi head huber cùng δ" (Brain-B là brain duy nhất nhiều head
 *     huber; sampler + sweep dùng δ cùng nhau cho mọi head huber). Spec có
 *     các head huber δ KHÁC nhau nằm NGOÀI không gian con — encode/decode
 *     collapse về δ head đầu (hành động có chủ đích, pin r100-H).
 *  2. α/β/δ "KHÔNG có key" ≡ "key = default engine" (engine chạy y hệt —
 *     activations.ts resolveAlpha/resolveBeta, losses.ts resolveDelta):
 *     encode đọc spec.activationParams/huberDelta nếu có, không thì default;
 *     decode bỏ key khi slot ĐÚNG BẰNG slot default (so sánh bit — cùng biểu
 *     thức logNorm cho cùng kết quả). Bijective trên lớp tương đương ngữ
 *     nghĩa "default ≡ key=default-value".
 *  3. Trọng số [79..81]: encode viết normalizeLossWeights(Σλ=1) — spec thô
 *     Σ≠1 encode về lớp tương đương Σ=1 (train dùng lossScalePerHead chuẩn
 *     hoá anyway nên hành vi engine giống hệt). Brain KHÔNG editableWeights
 *     (A/C) encode GIÁ TRỊ KHÓA theo rule (§3.1 "không tạo ảo tưởng tìm
 *     được phần hợp đồng khóa"); decode ép lại weight rule cho A/C.
 *  4. SEED_MAX = 2^31−1 chuẩn hoá slot seed (DRAFT_LIMITS không có trần seed
 *     — validate chỉ cần nguyên ≥ 0); sampler sinh ∈ [0, SEED_MAX]; encode
 *     seed > SEED_MAX kẹp về 1 (spec hợp lệ từ sampler/UI không bao giờ vượt).
 *  5. inputUnits là THAM SỐ (đo lúc runtime, lưu slot [92] cho predictor);
 *     decode KHÔNG dùng [92] — validate với rule.inputUnits (A: 10 cố định;
 *     B/C: null → không chặn trần, mlp.validateSpec lúc train chặn thật).
 *  6. decode TỐT ĐỌNG rule (loại loss + trọng số khóa luôn về rule kể cả
 *     khi vector đòi khác); ngược lại CHẶN SAI dạng: vector sai chiều / giá
 *     trị ngoài [0,1] / NaN / one-hot activation rỗng / one-hot brain không
 *     khớp brain truyền vào → throw Error('vector rác: <lý do>') — HN-P3
 *     predictor phải snap one-hot trước khi decode (hợp đồng ảnh của encode).
 *  7. `note` KHÔNG thuộc encoding (metadata hiển thị, không phải kiến trúc)
 *     — decode luôn trả spec không note.
 *  8. Chuẩn hoá log/linear KHÔNG đảo bit-đối-bit của số thực (~1 ulp) —
 *     r100 so sánh round-trip bằng deep-compare có dung sai 1e-9 cho trường
 *     số thực (units/epochs/batch/patience/seed là nguyên nên luôn ĐÚNG bit).
 */

import type { ActivationName } from './activations'
import {
  ACTIVATION_MENU,
  BRAIN_DRAFT_RULES,
  DRAFT_LIMITS,
  defaultDraftFor,
  normalizeLossWeights,
  validateBrainDraft,
  type BrainDraftRule,
  type BrainDraftSpec,
  type DraftHiddenLayer,
  type DraftHyper,
  type DraftLossHead,
} from './spec-schema'
import { BRAIN_TRAINABLE_KEYS, type BrainKey } from './registry'

// ==================== HẰNG SỐ (hardcode kèm nguồn — doctrine #1: §0 bảng phase + H3/H5/§4.1) ====================

/** H3 — ngân sách ứng viên tối đa / session search (Q2 §8 chốt 24 × 10 phút). */
export const SEARCH_MAX_CANDIDATES = 24
/** H3 — ngân sách thời gian treo tường tối đa / session (10 phút = 600_000 ms). */
export const SEARCH_MAX_WALL_MS = 600_000
/** H5 — prune giữ N session search mới nhất / brain (tiền lệ BRAIN_VERSIONS_KEEP=5). */
export const SEARCH_SESSIONS_KEEP = 5
/** H5 — prune giữ N ứng viên / session (top-N + best; triển khai HN-P2). */
export const SEARCH_CANDIDATES_KEEP = 60
/** §3.1 — chiều cố định vector encoding ứng viên (pin r100 bắt lỗi đếm slot kiểu v0.1 "87 chiều"). */
export const SEARCH_ENCODING_DIM = 96
/** Chuẩn hoá slot seed [91] — DRAFT_LIMITS không có trần seed nên chốt 2^31−1 (nguyên dương int32). */
export const SEED_MAX = 2_147_483_647
/** §4.1-2 — sampler sinh lại tối đa 20 lần khi validate loại (hết → fallback defaultDraftFor). */
export const SAMPLER_RETRY_MAX = 20

/**
 * Thứ tự activation cho one-hot [7..60] — single-source ACTIVATION_MENU
 * (9 mục §9.2). softmax ở CUỐI menu; hidden hợp lệ = 8 hàm còn lại
 * (softmax cấm hidden — audit B1).
 */
export const ACT_ORDER: readonly ActivationName[] = ACTIVATION_MENU.map(e => e.name)

/** Thứ tự loss type cho one-hot [67..78] (menu mlp.ts losses). */
export const LOSS_ORDER: readonly DraftLossHead['type'][] = ['bce', 'crossEntropy', 'mse', 'huber']

/**
 * Thứ tự brain cho one-hot [93..95] — R24-b: nguồn chuyển từ BRAIN_REGISTRY
 * sang BRAIN_TRAINABLE_KEYS (vẫn 3 não theo đúng thứ tự cũ — r100 pin). Lý
 * do: BRAIN_REGISTRY giờ có 4 não (thêm 'knowledge' ghost §8.5 R24-b) nhưng
 * encoding 96-dim chỉ có 3 slot [93..95] — knowledge vào search space khi
 * D3/EVO mở rộng encoding (§8.4 vùng [144..) — chưa tới). Nếu map nguyên
 * registry, encodeDraft viết vec[96] = 1 (out-of-bounds, dài 97) vỡ hợp
 * đồng SEARCH_ENCODING_DIM + r100.
 */
export const BRAIN_KEY_ORDER: readonly BrainKey[] = BRAIN_TRAINABLE_KEYS.map(k => k)

/** 8 hàm activation hợp lệ ở LỚP ẨN (softmax cấm — audit B1; validateBrainDraft từ chối). */
export const HIDDEN_ACT_ORDER: readonly ActivationName[] = ACT_ORDER.filter(a => a !== 'softmax')

// ==================== CHỈ MỤC SLOT (nội bộ — test r100 pin bằng số_literal để bắt trôi layout) ====================

const SLOT = {
  nLayers: 0,
  units: 1, // [1..6] từng lớp /256
  actOneHot: 7, // [7..60] = 6 vị trí lớp × 9 activation
  alphaBeta: 61, // [61..66] từng lớp
  lossOneHot: 67, // [67..78] = 3 đầu × 4 loss
  headWeight: 79, // [79..81]
  huberDelta: 82,
  optimizer: 83,
  lr: 84,
  epochs: 85,
  batch: 86,
  l2: 87,
  patience: 88,
  holdout: 89,
  clip: 90,
  seed: 91,
  inputDim: 92,
  brainOneHot: 93, // [93..95]
} as const

/** Trần slot inputDim [92] (chế độ input rộng nhất: full-2048 — registry inputModes). */
const INPUT_DIM_MAX = 2048

// Default engine cho α/β/δ (activations.ts resolveAlpha(p, 0.01|1) /
// resolveBeta(p) → 1, losses.ts resolveDelta → 1) — dùng khi spec KHÔNG có key.
const ENGINE_ALPHA_DEFAULT: Readonly<Record<'leakyRelu' | 'elu', number>> = { leakyRelu: 0.01, elu: 1.0 }
const ENGINE_BETA_DEFAULT = 1.0
const ENGINE_DELTA_DEFAULT = 1.0

// Slot mã hoá của default engine — decode SO SÁNH BẰNG BIT với các slot này
// để quyết định omit key (bijective trên lớp tương đương "default ≡ key=default").
const ALPHA_DEFAULT_SLOT: Readonly<Record<'leakyRelu' | 'elu', number>> = {
  leakyRelu: logNorm(ENGINE_ALPHA_DEFAULT.leakyRelu, DRAFT_LIMITS.alphaMin, DRAFT_LIMITS.alphaMax),
  elu: logNorm(ENGINE_ALPHA_DEFAULT.elu, DRAFT_LIMITS.alphaMin, DRAFT_LIMITS.alphaMax),
}
const BETA_DEFAULT_SLOT = logNorm(ENGINE_BETA_DEFAULT, DRAFT_LIMITS.betaMin, DRAFT_LIMITS.betaMax)
const DELTA_DEFAULT_SLOT = logNorm(ENGINE_DELTA_DEFAULT, DRAFT_LIMITS.huberDeltaMin, DRAFT_LIMITS.huberDeltaMax)

// ==================== CHUẨN HOÁ (log/linear — dùng chung encode/decode/sampler) ====================

/**
 * Log-scale chuẩn hoá [0,1]: (ln v − ln min)/(ln max − ln min), kẹp [0,1]
 * (NaN/∞ → 0 — hàm tổng, không văng). Ngược lại: `logDenorm`.
 */
export function logNorm(v: number, min: number, max: number): number {
  const t = (Math.log(v) - Math.log(min)) / (Math.log(max) - Math.log(min))
  return Number.isFinite(t) ? Math.min(1, Math.max(0, t)) : 0
}

/** Đảo của logNorm: exp(ln min + t·(ln max − ln min)) — t ∈ [0,1]. */
export function logDenorm(t: number, min: number, max: number): number {
  return Math.exp(Math.log(min) + t * (Math.log(max) - Math.log(min)))
}

/** Linear chuẩn hoá [0,1]: (v − min)/(max − min), kẹp [0,1] (NaN → 0). */
function linNorm(v: number, min: number, max: number): number {
  const t = (v - min) / (max - min)
  return Number.isFinite(t) ? Math.min(1, Math.max(0, t)) : 0
}

/** Kẹp [0,1] an toàn NaN (hàm tổng — spec rác không văng, NaN → 0). */
function clamp01(v: number): number {
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0
}

/** Kẹp về [min, max] (đảo linear — decode dùng kẹp để biên slot 0/1 ra ĐÚNG min/max). */
function clampRange(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v))
}

/** Đảo linear cho trường nguyên: round + kẹp [min, max] (sai số float ~1e-13 — round luôn phục hồi đúng). */
function intDenorm(t: number, min: number, max: number): number {
  return clampRange(Math.round(min + t * (max - min)), min, max)
}

// ==================== ENCODE (spec → vector 96) ====================

/**
 * Mã hoá 1 BrainDraftSpec thành vector 96 chiều — TẤT ĐỊNH, mọi giá trị
 * ∈ [0,1]. Hợp đồng đầu vào: spec NÊN đã qua validateBrainDraft (như mọi
 * caller thật — draft đã normalize / sampler / candidate DB); hàm vẫn tổng
 * (spec rác → kẹp biên, không văng) nhưng slot có thể mất thông tin.
 * `note` không được encode (quyết định thiết kế #7).
 */
export function encodeDraft(spec: BrainDraftSpec, inputUnits: number | null): number[] {
  const vec = new Array<number>(SEARCH_ENCODING_DIM).fill(0)
  // rule null chỉ khi spec rác (brain lạ — vượt type); encode vẫn tổng, slot loss/weight bỏ 0
  const rule: BrainDraftRule | null = BRAIN_DRAFT_RULES[spec.brain] ?? null

  // ── hidden [0] nLayers · [1..6] units · [7..60] activation · [61..66] α/β ──
  const hidden = Array.isArray(spec.hidden) ? spec.hidden : []
  const nLayers = Math.min(hidden.length, DRAFT_LIMITS.hiddenLayersMax)
  vec[SLOT.nLayers] = clamp01(nLayers / DRAFT_LIMITS.hiddenLayersMax)
  for (let i = 0; i < nLayers; i++) {
    const layer = hidden[i] as DraftHiddenLayer
    vec[SLOT.units + i] = clamp01(layer.units / DRAFT_LIMITS.unitsMax)
    const ai = ACT_ORDER.indexOf(layer.activation)
    if (ai >= 0) vec[SLOT.actOneHot + i * ACT_ORDER.length + ai] = 1
    // α/β — KHÔNG có key → default engine (quyết định thiết kế #2)
    if (layer.activation === 'leakyRelu' || layer.activation === 'elu') {
      vec[SLOT.alphaBeta + i] = logNorm(
        layer.activationParams?.alpha ?? ENGINE_ALPHA_DEFAULT[layer.activation],
        DRAFT_LIMITS.alphaMin,
        DRAFT_LIMITS.alphaMax,
      )
    } else if (layer.activation === 'swish') {
      vec[SLOT.alphaBeta + i] = logNorm(
        layer.activationParams?.beta ?? ENGINE_BETA_DEFAULT,
        DRAFT_LIMITS.betaMin,
        DRAFT_LIMITS.betaMax,
      )
    }
    // activation khác → 0 (slot đã fill 0 sẵn)
  }

  // ── lossPerHead [67..78] one-hot (phần KHÓA vẫn encode đúng loại rule) ·
  //    [79..81] trọng số Σλ=1 · [82] δ head huber đầu tiên ──
  const heads = Array.isArray(spec.lossPerHead) ? spec.lossPerHead : []
  const ruleHeads = rule?.lossPerHead ?? []
  const nHeads = Math.min(heads.length, ruleHeads.length)
  for (let i = 0; i < nHeads; i++) {
    const li = LOSS_ORDER.indexOf(heads[i].type)
    if (li >= 0) vec[SLOT.lossOneHot + i * LOSS_ORDER.length + li] = 1
  }
  // Trọng số: A/C (editableWeights=false) encode GIÁ TRỊ KHÓA theo rule —
  // không tạo ảo tưởng "tìm được" phần hợp đồng khóa (§3.1); B → Σλ=1.
  const rawWeights = (rule?.editableWeights ? heads.slice(0, nHeads) : ruleHeads.slice(0, nHeads)).map(h => h.weight)
  const normWeights = normalizeLossWeights(rawWeights)
  for (let i = 0; i < normWeights.length; i++) vec[SLOT.headWeight + i] = clampRange(normWeights[i], DRAFT_LIMITS.weightMin, DRAFT_LIMITS.weightMax)
  const firstHuber = heads.slice(0, nHeads).find(h => h.type === 'huber')
  vec[SLOT.huberDelta] = firstHuber
    ? logNorm(firstHuber.huberDelta ?? ENGINE_DELTA_DEFAULT, DRAFT_LIMITS.huberDeltaMin, DRAFT_LIMITS.huberDeltaMax)
    : 0

  // ── hyper [83..91] (thứ tự cố định — optimizer, lr, epochs, batch, l2,
  //    patience, holdout, clip, seed) ──
  const h = (spec.hyper ?? {}) as Partial<DraftHyper>
  vec[SLOT.optimizer] = h.optimizer === 'adam' ? 1 : 0
  vec[SLOT.lr] = linNorm(h.lr ?? 0, DRAFT_LIMITS.lrMin, DRAFT_LIMITS.lrMax)
  vec[SLOT.epochs] = linNorm(h.epochs ?? 0, DRAFT_LIMITS.epochsMin, DRAFT_LIMITS.epochsMax)
  vec[SLOT.batch] = linNorm(h.batch ?? 0, DRAFT_LIMITS.batchMin, DRAFT_LIMITS.batchMax)
  vec[SLOT.l2] = linNorm(h.l2 ?? 0, DRAFT_LIMITS.l2Min, DRAFT_LIMITS.l2Max)
  vec[SLOT.patience] = linNorm(h.patience ?? 0, DRAFT_LIMITS.patienceMin, DRAFT_LIMITS.patienceMax)
  vec[SLOT.holdout] = linNorm(h.holdout ?? 0, DRAFT_LIMITS.holdoutMin, DRAFT_LIMITS.holdoutMax)
  vec[SLOT.clip] = linNorm(h.clip ?? 0, DRAFT_LIMITS.clipMin, DRAFT_LIMITS.clipMax)
  vec[SLOT.seed] = clamp01((h.seed ?? 0) / SEED_MAX)

  // ── [92] inputDim (tham số runtime — 0 khi chưa biết) · [93..95] brain ──
  vec[SLOT.inputDim] = inputUnits !== null && Number.isFinite(inputUnits)
    ? clampRange(inputUnits / INPUT_DIM_MAX, 0, 1)
    : 0
  const bi = BRAIN_KEY_ORDER.indexOf(spec.brain)
  if (bi >= 0) vec[SLOT.brainOneHot + bi] = 1

  return vec
}

// ==================== DECODE (vector 96 → spec) ====================

/**
 * Đảo của encodeDraft — trả spec ĐÃ QUA validateBrainDraft({...spec, brain},
 * rule.inputUnits ?? null).normalized (brain truyền vào quyết định rule;
 * slot [93..95] chỉ khớp-kiểm-tra). Tốt động rule: loại loss khóa + trọng số
 * khóa của A/C luôn về rule (bỏ qua vector). Vector rác (sai chiều / giá trị
 * ngoài [0,1] / NaN / one-hot activation rỗng / one-hot brain lệch / decode
 * ra spec không vượt validate) → throw Error('vector rác: <lý do>').
 */
export function decodeDraft(vec: readonly number[], brain: BrainKey): BrainDraftSpec {
  if (!Array.isArray(vec) || vec.length !== SEARCH_ENCODING_DIM) {
    throw new Error(`vector rác: cần đúng ${SEARCH_ENCODING_DIM} chiều, nhận ${Array.isArray(vec) ? vec.length : typeof vec}`)
  }
  for (let i = 0; i < vec.length; i++) {
    const v = vec[i]
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) {
      throw new Error(`vector rác: slot [${i}] = ${String(v)} không phải số hữu hạn trong [0, 1]`)
    }
  }
  const rule = BRAIN_DRAFT_RULES[brain]

  // one-hot [93..95] phải chỉ đúng brain truyền vào (chống lẫn ứng viên chéo brain — H4)
  const bi = BRAIN_KEY_ORDER.indexOf(brain)
  let bestBrain = -1
  let bestBrainV = 0
  for (let j = 0; j < BRAIN_KEY_ORDER.length; j++) {
    const v = vec[SLOT.brainOneHot + j]
    if (v > bestBrainV) {
      bestBrainV = v
      bestBrain = j
    }
  }
  if (bestBrain < 0 || bestBrain !== bi) {
    throw new Error(
      `vector rác: one-hot [${SLOT.brainOneHot}..${SLOT.brainOneHot + 2}] ${bestBrain < 0 ? 'toàn 0' : `chỉ '${BRAIN_KEY_ORDER[bestBrain]}'`} không khớp brain '${brain}'`,
    )
  }

  // ── hidden: [0] số lớp · [1..6] units · [7..60] activation argmax · [61..66] α/β ──
  const nLayers = intDenorm(vec[SLOT.nLayers], 0, DRAFT_LIMITS.hiddenLayersMax)
  const hidden: DraftHiddenLayer[] = []
  for (let i = 0; i < nLayers; i++) {
    // units = round(t·256) kẹp [1,256] — đảo CHÍNH XÁC bit mọi units nguyên
    // (units/256 rồi ·256 đều là phép luỹ thừa 2, không mất round-trip)
    const units = clampRange(Math.round(vec[SLOT.units + i] * DRAFT_LIMITS.unitsMax), DRAFT_LIMITS.unitsMin, DRAFT_LIMITS.unitsMax)
    let bestAct = -1
    let bestActV = 0
    for (let j = 0; j < ACT_ORDER.length; j++) {
      const v = vec[SLOT.actOneHot + i * ACT_ORDER.length + j]
      if (v > bestActV) {
        bestActV = v
        bestAct = j
      }
    }
    if (bestAct < 0) {
      throw new Error(`vector rác: lớp ẩn ${i + 1} không có activation one-hot (block [${SLOT.actOneHot + i * ACT_ORDER.length}..${SLOT.actOneHot + i * ACT_ORDER.length + ACT_ORDER.length - 1}] toàn 0)`)
    }
    const activation = ACT_ORDER[bestAct]
    // α/β — slot đúng slot default engine → KHÔNG key (như spec gốc không key)
    const ab = vec[SLOT.alphaBeta + i]
    let activationParams: DraftHiddenLayer['activationParams'] | undefined
    if (activation === 'leakyRelu' || activation === 'elu') {
      if (ab !== ALPHA_DEFAULT_SLOT[activation]) {
        activationParams = { alpha: clampRange(logDenorm(ab, DRAFT_LIMITS.alphaMin, DRAFT_LIMITS.alphaMax), DRAFT_LIMITS.alphaMin, DRAFT_LIMITS.alphaMax) }
      }
    } else if (activation === 'swish') {
      if (ab !== BETA_DEFAULT_SLOT) {
        activationParams = { beta: clampRange(logDenorm(ab, DRAFT_LIMITS.betaMin, DRAFT_LIMITS.betaMax), DRAFT_LIMITS.betaMin, DRAFT_LIMITS.betaMax) }
      }
    }
    hidden.push(activationParams ? { units, activation, activationParams } : { units, activation })
  }

  // ── lossPerHead: loại (tốt động rule — vector đòi loại ngoài rule → dùng loại khóa) ·
  //    trọng số (A/C ép rule) · δ áp cho MỌI head huber (quyết định thiết kế #1) ──
  const heads: DraftLossHead[] = []
  for (let i = 0; i < rule.lossPerHead.length; i++) {
    const locked = rule.lossPerHead[i]
    const allowed = rule.editableLossTypes[i] ?? []
    let type = locked.type
    if (allowed.length > 0) {
      let bestLoss = -1
      let bestLossV = 0
      for (let j = 0; j < LOSS_ORDER.length; j++) {
        const v = vec[SLOT.lossOneHot + i * LOSS_ORDER.length + j]
        if (v > bestLossV) {
          bestLossV = v
          bestLoss = j
        }
      }
      const want = bestLoss >= 0 ? LOSS_ORDER[bestLoss] : null
      if (want && (want === locked.type || (allowed as readonly string[]).includes(want))) type = want
    }
    const weight = rule.editableWeights ? vec[SLOT.headWeight + i] : locked.weight
    if (type === 'huber') {
      const d = vec[SLOT.huberDelta]
      if (d !== DELTA_DEFAULT_SLOT) {
        heads.push({ type, weight, huberDelta: clampRange(logDenorm(d, DRAFT_LIMITS.huberDeltaMin, DRAFT_LIMITS.huberDeltaMax), DRAFT_LIMITS.huberDeltaMin, DRAFT_LIMITS.huberDeltaMax) })
        continue
      }
    }
    heads.push({ type, weight })
  }

  // ── hyper [83..91] (đảo linear + kẹp biên — slot 0/1 ra ĐÚNG min/max) ──
  const hyper: DraftHyper = {
    optimizer: vec[SLOT.optimizer] >= 0.5 ? 'adam' : 'sgd',
    lr: linDenorm(vec[SLOT.lr], DRAFT_LIMITS.lrMin, DRAFT_LIMITS.lrMax),
    epochs: intDenorm(vec[SLOT.epochs], DRAFT_LIMITS.epochsMin, DRAFT_LIMITS.epochsMax),
    batch: intDenorm(vec[SLOT.batch], DRAFT_LIMITS.batchMin, DRAFT_LIMITS.batchMax),
    l2: linDenorm(vec[SLOT.l2], DRAFT_LIMITS.l2Min, DRAFT_LIMITS.l2Max),
    patience: intDenorm(vec[SLOT.patience], DRAFT_LIMITS.patienceMin, DRAFT_LIMITS.patienceMax),
    holdout: linDenorm(vec[SLOT.holdout], DRAFT_LIMITS.holdoutMin, DRAFT_LIMITS.holdoutMax),
    clip: linDenorm(vec[SLOT.clip], DRAFT_LIMITS.clipMin, DRAFT_LIMITS.clipMax),
    seed: Math.min(SEED_MAX, Math.max(0, Math.round(vec[SLOT.seed] * SEED_MAX))),
  }

  const spec: BrainDraftSpec = { brain, hidden, lossPerHead: heads, hyper }
  const res = validateBrainDraft(spec, rule.inputUnits ?? null)
  if (!res.ok) throw new Error(`vector rác: ${res.errors.join('; ')}`)
  return res.normalized
}

/** Đảo linear: min + t·(max − min), kẹp [min, max] — biên t=0/1 ra ĐÚNG min/max (hyper slot dùng linear §3.1). */
function linDenorm(t: number, min: number, max: number): number {
  return clampRange(min + t * (max - min), min, max)
}

// ==================== SAMPLER (sinh ứng viên trong biên — §4.1-2) ====================

/** Kết quả sampler: spec hợp lệ (đã normalize) + số lần sinh đã dùng (1-based). */
export interface SampleCandidateResult {
  spec: BrainDraftSpec
  /** 1 = sinh ngay lần đầu; SAMPLER_RETRY_MAX = đã cạn retry, spec là fallback default. */
  attempts: number
}

/**
 * Sinh 1 ứng viên BrainDraftSpec NGẪU NHIÊN TRONG BIÊN DRAFT_LIMITS — chỉ phần
 * TỰ DO: hidden 0–6 lớp × units × activation (8 hàm hidden) × α/β (log-uniform)
 * × hyper (uniform trên cube encoding) × loss type ĐƯỢC PHÉP ĐỔI theo
 * rule.editableLossTypes × weight khi editableWeights (cắt simplex Σλ=1) × δ
 * (log-uniform, CÙNG cho mọi head huber — quyết định thiết kế #1). Phần KHÓA
 * (loại loss khóa, weight khóa của A/C) giữ nguyên rule. Sinh thô →
 * validateBrainDraft(spec, inputUnits) → lỗi (trần tham số…) → sinh lại tối đa
 * SAMPLER_RETRY_MAX lần → hết → fallback defaultDraftFor (fail-open, search
 * không chết vì sampler). TẤT ĐỊNH H4: chỉ tiêu thụ `rng` — same seed same
 * output (caller truyền makeRng(seed) từ init.ts).
 */
export function sampleCandidate(rng: () => number, brain: BrainKey, inputUnits: number | null): SampleCandidateResult {
  const rule = BRAIN_DRAFT_RULES[brain]
  for (let attempt = 1; attempt <= SAMPLER_RETRY_MAX; attempt++) {
    const spec = generateCandidate(rng, brain, rule)
    const res = validateBrainDraft(spec, inputUnits)
    if (res.ok) return { spec: res.normalized, attempts: attempt }
  }
  return { spec: defaultDraftFor(brain), attempts: SAMPLER_RETRY_MAX }
}

/** 1 lượt sinh thô (không validate — sampleCandidate lo vòng retry). */
function generateCandidate(rng: () => number, brain: BrainKey, rule: BrainDraftRule): BrainDraftSpec {
  // hidden — nLayers uniform 0..6, mỗi lớp: units + activation + α/β log-uniform
  const nLayers = intDenorm(rng(), 0, DRAFT_LIMITS.hiddenLayersMax)
  const hidden: DraftHiddenLayer[] = []
  for (let i = 0; i < nLayers; i++) {
    const units = intDenorm(rng(), DRAFT_LIMITS.unitsMin, DRAFT_LIMITS.unitsMax)
    const activation = HIDDEN_ACT_ORDER[Math.floor(rng() * HIDDEN_ACT_ORDER.length)]
    if (activation === 'leakyRelu' || activation === 'elu') {
      hidden.push({
        units,
        activation,
        activationParams: {
          alpha: clampRange(logDenorm(rng(), DRAFT_LIMITS.alphaMin, DRAFT_LIMITS.alphaMax), DRAFT_LIMITS.alphaMin, DRAFT_LIMITS.alphaMax),
        },
      })
    } else if (activation === 'swish') {
      hidden.push({
        units,
        activation,
        activationParams: {
          beta: clampRange(logDenorm(rng(), DRAFT_LIMITS.betaMin, DRAFT_LIMITS.betaMax), DRAFT_LIMITS.betaMin, DRAFT_LIMITS.betaMax),
        },
      })
    } else {
      hidden.push({ units, activation })
    }
  }

  // trọng số editable (B): cắt [0,1] tại n−1 điểm ngẫu nhiên → n đoạn Σλ=1
  // (uniform trên simplex — mỗi đoạn ∈ [0,1] hợp lệ validate; Σ≈1 về float
  // nên round-trip ổn trong dung sai)
  const simplex: number[] = []
  if (rule.editableWeights && rule.lossPerHead.length > 0) {
    const n = rule.lossPerHead.length
    const cuts = Array.from({ length: n - 1 }, () => rng()).sort((a, b) => a - b)
    let prev = 0
    for (const c of cuts) {
      simplex.push(c - prev)
      prev = c
    }
    simplex.push(1 - prev)
  }

  // lossPerHead — loại đổi được chọn ngẫu nhiên trong allowed; δ CHIA SẺ cho
  // mọi head huber (bijective subspace #1); weight khóa giữ rule
  const heads: DraftLossHead[] = []
  let huberDelta: number | null = null
  for (let i = 0; i < rule.lossPerHead.length; i++) {
    const locked = rule.lossPerHead[i]
    const allowed = rule.editableLossTypes[i] ?? []
    const type = allowed.length > 0 ? allowed[Math.floor(rng() * allowed.length)] : locked.type
    const weight = rule.editableWeights ? simplex[i] : locked.weight
    if (type === 'huber') {
      if (huberDelta === null) {
        huberDelta = clampRange(logDenorm(rng(), DRAFT_LIMITS.huberDeltaMin, DRAFT_LIMITS.huberDeltaMax), DRAFT_LIMITS.huberDeltaMin, DRAFT_LIMITS.huberDeltaMax)
      }
      heads.push({ type, weight, huberDelta })
    } else {
      heads.push({ type, weight })
    }
  }

  // hyper — uniform trên cube encoding (từng slot t ∈ [0,1] rồi đảo cùng
  // chuẩn hoá của decode — predictor thấy phân phối đều trên input)
  const hyper: DraftHyper = {
    optimizer: rng() < 0.5 ? 'sgd' : 'adam',
    lr: clampRange(linDenorm(rng(), DRAFT_LIMITS.lrMin, DRAFT_LIMITS.lrMax), DRAFT_LIMITS.lrMin, DRAFT_LIMITS.lrMax),
    epochs: intDenorm(rng(), DRAFT_LIMITS.epochsMin, DRAFT_LIMITS.epochsMax),
    batch: intDenorm(rng(), DRAFT_LIMITS.batchMin, DRAFT_LIMITS.batchMax),
    l2: clampRange(linDenorm(rng(), DRAFT_LIMITS.l2Min, DRAFT_LIMITS.l2Max), DRAFT_LIMITS.l2Min, DRAFT_LIMITS.l2Max),
    patience: intDenorm(rng(), DRAFT_LIMITS.patienceMin, DRAFT_LIMITS.patienceMax),
    holdout: clampRange(linDenorm(rng(), DRAFT_LIMITS.holdoutMin, DRAFT_LIMITS.holdoutMax), DRAFT_LIMITS.holdoutMin, DRAFT_LIMITS.holdoutMax),
    clip: clampRange(linDenorm(rng(), DRAFT_LIMITS.clipMin, DRAFT_LIMITS.clipMax), DRAFT_LIMITS.clipMin, DRAFT_LIMITS.clipMax),
    seed: Math.floor(rng() * (SEED_MAX + 1)),
  }

  return { brain, hidden, lossPerHead: heads, hyper }
}

// ==================== EVO-P1 — ENCODING ADDITIVE 96 → 144 (§4.2 — R24-c) ====================
//
// Nguyên tắc ADDITIVE — BIJECTIVE TRONG MỖI VÙNG: 96 chiều đầu giữ nguyên
// nghĩa HN-P1 (ứng viên thuần MLP decode y hệt trước — decodeEvoCandidate
// gọi CHÍNH decodeDraft trên [0..95]); vùng mới [96..143] chỉ có nghĩa khi
// slot layer-type ≠ 0. KHÔNG đụng hợp đồng 96-dim (SEARCH_ENCODING_DIM +
// r100 pins giữ nguyên).
//
// BẢN VẼ SLOT VÙNG EVO (§4.2):
//   [96..113]  layer-type one-hot 3 block × 6 loại (thứ tự EVO_BLOCK_TYPES:
//              identity·mlp·attention·ssm·moe·gated) — block toàn 0 = identity
//   [114..131] 6 thông số/block (mỗi block 6 slot, thứ tự:
//              headDim · ssmN · expansion · moeK · dropout · residualScale)
//              — headDim là tham số MẠNG: repair ép 3 slot headDim BẰNG NHAU
//                (canonical) — mọi block dùng chung token dim
//   [132..135] MoE toàn cục: k experts · router temperature · aux weight ·
//              gating top-1/top-2 (block moe kế thừa k khi slot này set)
//   [136..143] dự phòng 0 (recursive hybrid, weight-sharing… — §8.4 mở tiếp)

import { EVO_BLOCK_TYPES, type EvoBlockType, type EvoBlockSpec } from './evo/blocks'
import type { EvoCandidateSpec } from './evo/benchmark'

/** §4.2 — chiều encoding EVO (96 HN-P1 + 48 vùng block). */
export const EVO_ENCODING_DIM = 144
/** §4.2 — 3 slot block. */
export const EVO_BLOCK_COUNT = 3

/** Chỉ số slot vùng EVO (nội bộ — r105 pin bằng số literal). */
const EVO_SLOT = {
  blockType: 96, // [96..113] 3 × 6 one-hot
  blockParam: 114, // [114..131] 3 × 6 tham số
  moeGlobal: 132, // [132..135]
  reserved: 136, // [136..143] — LUÔN 0
} as const

/** Tham số block b slot p (p: 0 headDim · 1 ssmN · 2 expansion · 3 moeK · 4 dropout · 5 residualScale). */
function evoParamSlot(b: number, p: number): number {
  return EVO_SLOT.blockParam + b * 6 + p
}

// ── headDim 32/64/128: t < 1/3 → 32 · t < 2/3 → 64 · else 128 ──
function headDimFromSlot(t: number): number {
  return t < 1 / 3 ? 32 : t < 2 / 3 ? 64 : 128
}
function headDimToSlot(d: number): number {
  return d <= 32 ? 0 : d <= 64 ? 0.5 : 1
}

// ── ssmN 8/16 ──
function ssmNFromSlot(t: number): number {
  return t < 0.5 ? 8 : 16
}
function ssmNToSlot(n: number): number {
  return n <= 8 ? 0 : 1
}

/**
 * Pad encoding HN-P1 96-dim → EVO 144-dim (F4/0.5 — crossover cha legacy ×
 * cha EVO hợp lệ nhờ additive): vùng [96..143] toàn 0 → decode ra ứng viên
 * thuần MLP (mọi block identity).
 */
export function padEvo96to144(vec96: readonly number[]): number[] {
  if (vec96.length !== SEARCH_ENCODING_DIM) {
    throw new Error(`padEvo96to144: cần đúng ${SEARCH_ENCODING_DIM} chiều, nhận ${vec96.length}`)
  }
  return [...vec96, ...new Array<number>(EVO_ENCODING_DIM - SEARCH_ENCODING_DIM).fill(0)]
}

/**
 * REPAIR one-hot + canonical hoá encoding 144 (F8/0.5): sau mutation/
 * crossover, slot one-hot có thể nhiều hot/thiếu hot và 3 slot headDim có
 * thể lệch nhau. Repair: argmax → đúng 1 hot (tie → chỉ số thấp, tất định);
 * ép 3 slot headDim = slot block ĐẦU (canonical); kẹp tham số về miền rời
 * rạc đúng; reserved = 0. THUẦN — decode LUÔN ra ứng viên valid.
 */
export function repairEvoEncoding(vec: readonly number[]): number[] {
  if (vec.length !== EVO_ENCODING_DIM) {
    throw new Error(`repairEvoEncoding: cần đúng ${EVO_ENCODING_DIM} chiều, nhận ${vec.length}`)
  }
  const out = [...vec]
  // one-hot block-type: argmax → 1 hot (toàn 0 → identity: hot index 0)
  for (let b = 0; b < EVO_BLOCK_COUNT; b++) {
    const base = EVO_SLOT.blockType + b * EVO_BLOCK_TYPES.length
    let best = 0
    let bestV = -1
    for (let j = 0; j < EVO_BLOCK_TYPES.length; j++) {
      const v = out[base + j]
      if (typeof v === 'number' && Number.isFinite(v)) out[base + j] = 0
      if (typeof v === 'number' && Number.isFinite(v) && v > bestV) {
        bestV = v
        best = j
      }
    }
    out[base + (bestV > 0 ? best : 0)] = 1
  }
  // canonical headDim: 3 slot bằng slot block đầu
  const hd = headDimFromSlot(clamp01(out[evoParamSlot(0, 0)]))
  for (let b = 0; b < EVO_BLOCK_COUNT; b++) out[evoParamSlot(b, 0)] = headDimToSlot(hd)
  // kẹp tham số rời rạc + [0,1]
  for (let b = 0; b < EVO_BLOCK_COUNT; b++) {
    out[evoParamSlot(b, 1)] = ssmNToSlot(ssmNFromSlot(clamp01(out[evoParamSlot(b, 1)])))
    out[evoParamSlot(b, 2)] = clamp01(out[evoParamSlot(b, 2)]) // expansion decode round(1+3t)
    out[evoParamSlot(b, 3)] = clamp01(out[evoParamSlot(b, 3)])
    out[evoParamSlot(b, 4)] = clamp01(out[evoParamSlot(b, 4)]) // dropout metadata
    out[evoParamSlot(b, 5)] = clamp01(out[evoParamSlot(b, 5)])
  }
  for (let j = 0; j < 4; j++) out[EVO_SLOT.moeGlobal + j] = clamp01(out[EVO_SLOT.moeGlobal + j])
  for (let j = 0; j < 8; j++) out[EVO_SLOT.reserved + j] = 0
  return out
}

/**
 * Decode vector 144 → EvoCandidateSpec (đầu vào NÊN đã repair — hàm vẫn tổng
 * qua argmax tự canonical). Phần MLP: gọi CHÍNH decodeDraft trên [0..95]
 * (bijective vùng HN-P1 — ứng viên thuần MLP y hệt HN).
 */
export function decodeEvoCandidate(vec: readonly number[], brain: BrainKey): EvoCandidateSpec {
  if (!Array.isArray(vec) || vec.length !== EVO_ENCODING_DIM) {
    throw new Error(`decodeEvoCandidate: cần đúng ${EVO_ENCODING_DIM} chiều, nhận ${Array.isArray(vec) ? vec.length : typeof vec}`)
  }
  const canonical = repairEvoEncoding(vec)
  const draft = decodeDraft(canonical.slice(0, SEARCH_ENCODING_DIM), brain)
  const blocks: EvoCandidateSpec['blocks'] = []
  const headDimSlotVal = canonical[evoParamSlot(0, 0)]
  for (let b = 0; b < EVO_BLOCK_COUNT; b++) {
    const base = EVO_SLOT.blockType + b * EVO_BLOCK_TYPES.length
    let best = 0
    let bestV = -1
    for (let j = 0; j < EVO_BLOCK_TYPES.length; j++) {
      if (canonical[base + j] > bestV) {
        bestV = canonical[base + j]
        best = j
      }
    }
    const type = EVO_BLOCK_TYPES[best] as EvoBlockType
    const spec: EvoBlockSpec = {
      type,
      headDim: headDimFromSlot(headDimSlotVal),
      ssmN: ssmNFromSlot(canonical[evoParamSlot(b, 1)]),
      expansion: Math.round(1 + 3 * clamp01(canonical[evoParamSlot(b, 2)])),
      moeK: Math.round(2 + 2 * clamp01(canonical[evoParamSlot(b, 3)])),
      dropout: Math.round(0.3 * clamp01(canonical[evoParamSlot(b, 4)]) * 1000) / 1000,
      residualScale: Math.round((0.5 + 1.5 * clamp01(canonical[evoParamSlot(b, 5)])) * 100) / 100,
    }
    blocks.push(spec)
  }
  // MoE toàn cục [132..135] — block moe kế thừa k experts (slot top-1 ép k=1)
  const kExperts = Math.round(2 + 2 * clamp01(canonical[EVO_SLOT.moeGlobal]))
  const routerTemp = Math.round((0.5 * Math.exp(Math.log(4) * clamp01(canonical[EVO_SLOT.moeGlobal + 1]))) * 1000) / 1000
  const auxWeight = Math.round((0.005 * Math.exp(Math.log(10) * clamp01(canonical[EVO_SLOT.moeGlobal + 2]))) * 100000) / 100000
  const gatingTop2 = canonical[EVO_SLOT.moeGlobal + 3] >= 0.5
  for (const blk of blocks) {
    if (blk.type === 'moe' && !gatingTop2) {
      blk.moeK = 1 // gating top-1: mỗi token 1 expert (k=1)
    }
  }
  return {
    head: {
      hidden: draft.hidden.map(h => ({ units: h.units, activation: h.activation })),
      hyper: {
        lr: draft.hyper.lr,
        l2: draft.hyper.l2,
        epochs: draft.hyper.epochs,
        batch: draft.hyper.batch,
        patience: draft.hyper.patience,
      },
    },
    blocks,
    headDim: headDimFromSlot(headDimSlotVal),
    moeGlobal: { kExperts, routerTemp, auxWeight },
  }
}

/**
 * Encode EvoCandidateSpec → vector 144 (bijective trên dạng canonical —
 * encode∘repair∘decode = identity). Phần MLP: CHÍNH encodeDraft.
 */
export function encodeEvoCandidate(
  spec: EvoCandidateSpec,
  brain: BrainKey,
  inputUnits: number | null,
): number[] {
  const draft: BrainDraftSpec = {
    brain,
    hidden: spec.head.hidden.map(h => ({ units: h.units, activation: h.activation as ActivationName })),
    lossPerHead: [...BRAIN_DRAFT_RULES[brain].lossPerHead],
    hyper: {
      optimizer: 'adam',
      lr: spec.head.hyper.lr,
      epochs: spec.head.hyper.epochs,
      batch: spec.head.hyper.batch,
      l2: spec.head.hyper.l2,
      patience: spec.head.hyper.patience,
      holdout: DRAFT_LIMITS.holdoutMax, // trainer EVO tự dùng 0.15 — slot giữ max trung lập
      clip: DEFAULT_CLIP_SLOT,
      seed: 42,
    },
  }
  const vec96 = encodeDraft(draft, inputUnits)
  const vec = padEvo96to144(vec96) // pad TRƯỚC — viết slot block sau (mảng 96 không tự giãn)
  // blocks — pad lên 3 slot (thiếu = identity)
  for (let b = 0; b < EVO_BLOCK_COUNT; b++) {
    const blk = spec.blocks[b] ?? { type: 'identity' as EvoBlockType }
    const base = EVO_SLOT.blockType + b * EVO_BLOCK_TYPES.length
    const ti = EVO_BLOCK_TYPES.indexOf(blk.type)
    vec[base + (ti >= 0 ? ti : 0)] = 1
    vec[evoParamSlot(b, 0)] = headDimToSlot(spec.headDim)
    vec[evoParamSlot(b, 1)] = ssmNToSlot(blk.ssmN ?? 8)
    vec[evoParamSlot(b, 2)] = clamp01((((blk.expansion ?? 1) - 1) / 3))
    vec[evoParamSlot(b, 3)] = clamp01((((blk.moeK ?? 2) - 2) / 2))
    vec[evoParamSlot(b, 4)] = clamp01((blk.dropout ?? 0) / 0.3)
    vec[evoParamSlot(b, 5)] = clamp01(((blk.residualScale ?? 1) - 0.5) / 1.5)
  }
  const g = spec.moeGlobal ?? { kExperts: 2, routerTemp: 1, auxWeight: 0.01 }
  vec[EVO_SLOT.moeGlobal] = clamp01((g.kExperts - 2) / 2)
  vec[EVO_SLOT.moeGlobal + 1] = clamp01(Math.log(g.routerTemp / 0.5) / Math.log(4))
  vec[EVO_SLOT.moeGlobal + 2] = clamp01(Math.log(g.auxWeight / 0.005) / Math.log(10))
  vec[EVO_SLOT.moeGlobal + 3] = (g.kExperts ?? 2) >= 2 ? 1 : 0
  // reserved đã 0 (padEvo96to144 ở trên)
  return vec
}

/** Slot clip trung lập (DRAFT_LIMITS.clipMax — decode giữ nguyên giá trị max). */
const DEFAULT_CLIP_SLOT = 1

/**
 * Sampler ứng viên EVO 144 — TẤT ĐỊNH theo rng (H4). Phần MLP: CHÍNH
 * sampleCandidate; vùng block: mỗi block 50% identity (CPU tiết kiệm) /
 * 50% uniform 5 loại còn lại + tham số uniform; MoE toàn cục uniform; sau
 * đó REPAIR canonical. Trả ĐÃ REPAIR (decode luôn valid).
 */
export function sampleEvoCandidate(rng: () => number, brain: BrainKey, inputUnits: number | null): number[] {
  const base = sampleCandidate(rng, brain, inputUnits)
  const vec = padEvo96to144(encodeDraft(base.spec, inputUnits))
  for (let b = 0; b < EVO_BLOCK_COUNT; b++) {
    const typeBase = EVO_SLOT.blockType + b * EVO_BLOCK_TYPES.length
    for (let j = 0; j < EVO_BLOCK_TYPES.length; j++) vec[typeBase + j] = 0
    if (rng() < 0.5) {
      vec[typeBase] = 1 // identity
    } else {
      const pick = 1 + Math.floor(rng() * (EVO_BLOCK_TYPES.length - 1)) // 1..5 (không identity)
      vec[typeBase + pick] = 1
    }
    vec[evoParamSlot(b, 0)] = headDimToSlot([32, 64, 128][Math.floor(rng() * 3)])
    vec[evoParamSlot(b, 1)] = ssmNToSlot(rng() < 0.5 ? 8 : 16)
    vec[evoParamSlot(b, 2)] = rng()
    vec[evoParamSlot(b, 3)] = rng()
    vec[evoParamSlot(b, 4)] = rng() * 0.3
    vec[evoParamSlot(b, 5)] = rng()
  }
  vec[EVO_SLOT.moeGlobal] = rng()
  vec[EVO_SLOT.moeGlobal + 1] = rng()
  vec[EVO_SLOT.moeGlobal + 2] = rng()
  vec[EVO_SLOT.moeGlobal + 3] = rng() < 0.5 ? 0 : 1
  return repairEvoEncoding(vec)
}

/**
 * Mutation encoding 144 (toán tử di truyền — evolve.ts §4.5 điều phối): mỗi
 * slot liên tục cộng N(0, 0.15) kẹp [0,1] với xác suất rate; slot one-hot
 * resample nguyên nhóm với xác suất rate/2 (giữ thưa); reserved = 0. Sau
 * đó REPAIR (F8). Thuần + tất định theo rng.
 */
export function mutateEvo(vec: readonly number[], rng: () => number, rate = 0.15): number[] {
  const out = [...vec]
  // one-hot block-type: resample cả nhóm
  for (let b = 0; b < EVO_BLOCK_COUNT; b++) {
    if (rng() < rate / 2) {
      const base = EVO_SLOT.blockType + b * EVO_BLOCK_TYPES.length
      for (let j = 0; j < EVO_BLOCK_TYPES.length; j++) out[base + j] = 0
      if (rng() < 0.5) out[base] = 1
      else out[base + 1 + Math.floor(rng() * (EVO_BLOCK_TYPES.length - 1))] = 1
    }
  }
  // slot liên tục (tham số block + moe global + phần MLP hyper)
  for (let i = 0; i < EVO_ENCODING_DIM; i++) {
    if (i >= EVO_SLOT.reserved) break
    // bỏ qua nhóm one-hot MLP activation/loss/brain + block-type (đã xử lý)
    const inMlpOneHot = (i >= SLOT.actOneHot && i < SLOT.actOneHot + 54) || (i >= SLOT.lossOneHot && i < SLOT.lossOneHot + 12) || (i >= SLOT.brainOneHot)
    const inBlockOneHot = i >= EVO_SLOT.blockType && i < EVO_SLOT.blockType + 18
    if (inMlpOneHot || inBlockOneHot) continue
    if (rng() < rate) {
      // xấp xỉ normal qua Box-Muller thu gọn (tất định theo rng)
      const u1 = Math.max(1e-12, rng())
      const u2 = rng()
      const g = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
      out[i] = clamp01(out[i] + g * 0.15)
    }
  }
  return repairEvoEncoding(out)
}

/**
 * Crossover 2 cha (§4.5 + F4/0.5): mỗi slot lấy từ cha A hoặc B theo đồng
 * xu seeded; cha 96-dim legacy → pad 0 lên 144 TRƯỚC (vùng block toàn 0 =
 * thuần MLP — hợp lệ nhờ additive). Sau đó REPAIR.
 */
export function crossoverEvo(a: readonly number[], b: readonly number[], rng: () => number): number[] {
  const pa = a.length === SEARCH_ENCODING_DIM ? padEvo96to144(a) : a
  const pb = b.length === SEARCH_ENCODING_DIM ? padEvo96to144(b) : b
  if (pa.length !== EVO_ENCODING_DIM || pb.length !== EVO_ENCODING_DIM) {
    throw new Error(`crossoverEvo: cần encoding 96/144, nhận ${pa.length} × ${pb.length}`)
  }
  const out = new Array<number>(EVO_ENCODING_DIM)
  for (let i = 0; i < EVO_ENCODING_DIM; i++) out[i] = rng() < 0.5 ? pa[i] : pb[i]
  return repairEvoEncoding(out)
}
