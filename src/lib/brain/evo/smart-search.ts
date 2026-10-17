/**
 * EVO-P4.1 — SMART SEARCH (R26): cơ chế TÍNH TOÁN kích thước kiến trúc
 * ============================================================================
 *
 * Trước R26 vòng evolve sinh ứng viên THIÊN VỀ NGẪU NHIÊN: #0 sample thuần,
 * các ứng viên sau mutate/crossover với CHA CHỌN ĐỒNG DẪN (uniform) — không
 * có cơ chế nào "tính" ra số lớp/số nơ-ron từ đặc điểm dữ liệu. User hỏi
 * (2026-10-17): "hệ thống có cơ chế nào hay NAS có cơ chế tính toán để xác
 * định ra số lớp và số nơ ron hiệu quả hơn, tối ưu hơn chưa?" — mô-đun này
 * là câu trả lời, 3 mảnh THUẦN + TẤT ĐỊNH (H4):
 *
 *  1. `suggestArch` — bộ ước lượng giải tích (analytical sizer) tính kích
 *     thước khởi điểm TỪ DỮ LIỆU THẬT của fixture (nSamples · inputDim ·
 *     outputDim · ngân sách tham số):
 *       - Số lớp ẩn L theo độ giàu dữ liệu:  <100 mẫu → 1 · <1000 → 2 · else 3
 *         (dữ liệu ít mà mạng sâu = overfit chắc chắn; DRAFT_LIMITS cho phép
 *         tới 6 nhưng heuristic chỉ đề xuất 1–3).
 *       - Chiều rộng mỗi lớp: kim tự thAP hình học — nội suy luỹ thừa từ
 *         inputDim (lớp vào) co dần về outputDim (lớp ra):
 *         w_j = inputDim · (outputDim/inputDim)^((j+1)/(L+1)).
 *       - Hệ số co giãn theo dữ liệu dataScale = √(n / (in+out)) kẹp
 *         [0,5 .. 2] — nhiều mẫu tương đối → mạng rộng hơn, ít mẫu → thắt.
 *       - Trần dung lượng theo dữ liệu cap = min(paramsBudget, max(1500,
 *         50·n)) — vượt thì co toàn bộ chiều rộng theo √(cap/P) (giảm bình
 *         phương vì P ~ w²). Rule-of-thumb ~50 tham số/mẫu: quá mức này
 *         mạng ghi nhớ thay vì khái quát.
 *  2. `pickTournamentParent` — chọn cha theo GIẢI ĐẤU (tournament k=3):
 *     bốc k ứng viên ngẫu nhiên, cha = điểm CV cao nhất. Thay uniform cũ —
 *     vòng sau khai thác (exploit) vùng điểm cao thay vì quay lại ngẫu nhiên.
 *  3. `adaptiveMutationRate` — cường độ mutation giảm tuyến tính 0,15 → 0,06
 *     theo tiến độ vòng: đầu vòng thăm dò rộng (explore), cuối vòng tinh
 *     chỉnh quanh ứng viên tốt (exploit).
 *
 * Tích hợp (evolve.ts): ứng viên #0 = HẠT GIỐNG từ suggestArch (thay sample
 * ngẫu nhiên) — mọi vòng tiến hoá khởi đầu bằng kiến trúc ĐÃ TÍNH TOÁN; các
 * ứng viên sau tournament + adaptive. UI (evolve-tab) hiển thị suggestion +
 * rationale ngay trong form E2 để user thấy cơ chế tính.
 *
 * BẤT BIẾN giữ nguyên: H1/H2 (chỉ đề xuất) · H3 (ngân sách 24/10') · H4
 * (tất định — mọi hàm thuần hoặc nhận rng seeded; lưu ý trung thực: cùng
 * seed cho CÙNG chuỗi trong cùng phiên bản — chuỗi R26 khác R24-c vì thuật
 * toán sinh đổi) · H5 (DB additive) · H7 (cổng p95).
 */

import type { BrainKey } from '@/lib/brain/registry'
import type { EvoCandidateSpec } from '@/lib/brain/evo/benchmark'
import { defaultDraftFor } from '@/lib/brain/spec-schema'
import { encodeEvoCandidate } from '@/lib/brain/search-space'

// ==================== HẰNG SỐ (pin — r116) ====================

/** Chiều rộng tối thiểu đề xuất (DRAFT_LIMITS.unitsMin=1 nhưng <8 là suy biến). */
export const SUGGEST_UNITS_MIN = 8
/** Chiều rộng tối đa (DRAFT_LIMITS.unitsMax). */
export const SUGGEST_UNITS_MAX = 256
/** Trần dung lượng sàn — nhỏ hơn thế này mạng thiếu sức biểu diễn kể cả với 4 mẫu. */
export const SUGGEST_PARAMS_FLOOR = 1_500
/** Rule-of-thumb ~50 tham số/mẫu (trần dung lượng theo dữ liệu). */
export const SUGGEST_PARAMS_PER_SAMPLE = 50
/** dataScale kẹp [0,5 .. 2]. */
export const SUGGEST_SCALE_MIN = 0.5
export const SUGGEST_SCALE_MAX = 2
/** Tournament size (số bốc mỗi lần chọn cha). */
export const TOURNAMENT_K = 3
/** Mutation rate đầu vòng (khám phá) — trùng mặc định mutateEvo cũ. */
export const MUTATION_RATE_START = 0.15
/** Mutation rate cuối vòng (khai thác). */
export const MUTATION_RATE_END = 0.06

// ==================== 1) BỘ ƯỚC LƯỢNG GIẢI TÍCH ====================

export interface ArchSuggestion {
  brain: string
  /** Kích thước đề xuất (đã kẹp + làm tròn) — kích thước HIỂN THỊ == hạt giống #0. */
  hidden: Array<{ units: number; activation: string }>
  nLayers: number
  inputDim: number
  outputDim: number
  nSamples: number
  /** Hệ số co giãn theo dữ liệu (trước kẹp). */
  dataScale: number
  /** Ước lượng tham số của kiến trúc đề xuất (kèm bias). */
  paramsEstimate: number
  /** Trần dung lượng theo dữ liệu đã áp dụng. */
  paramsCap: number
  /** Giải thích từng bước bằng tiếng Việt — hiển thị trong UI (E2). */
  rationale: string
}

/** Số lớp ẩn theo độ giàu dữ liệu (bảng ngưỡng pin — r116). */
export function suggestLayerCount(nSamples: number): number {
  if (!Number.isFinite(nSamples) || nSamples < 100) return 1
  if (nSamples < 1_000) return 2
  return 3
}

/** Ước lượng tham số MLP chuỗi (kèm bias) — dùng cho cả cap check + hiển thị. */
export function estimateMlpParams(
  inputDim: number,
  hidden: readonly number[],
  outputDim: number,
): number {
  let p = 0
  let prev = inputDim
  for (const w of hidden) {
    p += prev * w + w
    prev = w
  }
  p += prev * outputDim + outputDim
  return p
}

/**
 * Tính kiến trúc khởi điểm từ dữ liệu — THUẦN + TẤT ĐỊNH (không rng).
 * Activation lấy theo default draft của brain (thường tanh) — heuristic chỉ
 * quyết định KÍCH THƯỚC; activation tối ưu vẫn là việc của vòng tiến hoá.
 */
export function suggestArch(input: {
  brain: BrainKey
  inputDim: number
  outputDim: number
  nSamples: number
  /** Mặc định 250K (EVO_MAX_PARAMS / BRAIN_MAX_PARAMS). */
  paramsBudget?: number
}): ArchSuggestion {
  const { brain, inputDim, outputDim, nSamples } = input
  const budget = input.paramsBudget ?? 250_000
  if (!Number.isFinite(inputDim) || inputDim < 1 || !Number.isFinite(outputDim) || outputDim < 1) {
    throw new Error(`suggestArch: inputDim/outputDim phải ≥ 1, nhận ${inputDim}×${outputDim}`)
  }
  const n = Number.isFinite(nSamples) ? Math.max(1, nSamples) : 1

  // 1) Số lớp theo dữ liệu
  const L = suggestLayerCount(n)

  // 2) Kim tự tháp hình học in → out, co giãn theo dữ liệu
  const ratio = outputDim / inputDim
  const dataScale = Math.min(
    SUGGEST_SCALE_MAX,
    Math.max(SUGGEST_SCALE_MIN, Math.sqrt(n / (inputDim + outputDim))),
  )
  const widths: number[] = []
  for (let j = 0; j < L; j++) {
    const base = inputDim * Math.pow(ratio, (j + 1) / (L + 1))
    widths.push(Math.min(SUGGEST_UNITS_MAX, Math.max(SUGGEST_UNITS_MIN, Math.round(base * dataScale))))
  }

  // 3) Trần dung lượng theo dữ liệu — vượt thì LẶP co theo √(cap/P) (tối đa 8
  //    vòng; P ~ w² khi nhiều lớp nhưng ~ w·(in+out) khi 1 lớp nên một lần √
  //    không đủ). Dừng khi đạt cap hoặc mọi chiều rộng chạm sàn. Trung thực:
  //    dims I/O lớn (vd in 512) có thể buộc params > cap kể cả width sàn 8 —
  //    khi đó co tới sàn và THÔNG BÁO (paramsEstimate > cap), không tự hạ sàn
  //    dưới 8 (suy biến) để "đạt" cap giả.
  const paramsCap = Math.min(budget, Math.max(SUGGEST_PARAMS_FLOOR, n * SUGGEST_PARAMS_PER_SAMPLE))
  let params = estimateMlpParams(inputDim, widths, outputDim)
  for (let iter = 0; iter < 8 && params > paramsCap; iter++) {
    const shrink = Math.sqrt(paramsCap / params)
    let anyShrunk = false
    for (let j = 0; j < widths.length; j++) {
      const next = Math.min(SUGGEST_UNITS_MAX, Math.max(SUGGEST_UNITS_MIN, Math.floor(widths[j] * shrink)))
      if (next < widths[j]) anyShrunk = true
      widths[j] = next
    }
    if (!anyShrunk) break // mọi chiều rộng đã chạm sàn — không co được nữa
    params = estimateMlpParams(inputDim, widths, outputDim)
  }

  const activation = defaultDraftFor(brain).hidden[0]?.activation ?? 'tanh'
  const rationale =
    `${n} mẫu → ${L} lớp ẩn · kim tự tháp hình học từ in ${inputDim} co về out ${outputDim}` +
    ` × hệ số dữ liệu ${dataScale.toFixed(2)} (= √(n/(in+out)) kẹp [0,5..2]) → ` +
    `${widths.join(' → ')} nơ-ron · ước lượng ${params.toLocaleString('vi-VN')} tham số` +
    (params >= paramsCap ? ` (chạm trần dữ liệu ${paramsCap.toLocaleString('vi-VN')})` : ` < trần dữ liệu ${paramsCap.toLocaleString('vi-VN')} (~50 tham số/mẫu)`)

  return {
    brain,
    hidden: widths.map(units => ({ units, activation })),
    nLayers: L,
    inputDim,
    outputDim,
    nSamples: n,
    dataScale,
    paramsEstimate: params,
    paramsCap,
    rationale,
  }
}

// ==================== 2) CHA THEO GIẢI ĐẤU (TOURNAMENT) ====================

/**
 * Chọn 1 cha: bốc k=3 index ngẫu nhiên (rng seeded — H4), cha = cvScore cao
 * nhất. encodings[i] ↔ scores[i] phải song song (tiến trình evolve đẩy cả
 * hai theo cùng thứ tự). Thay uniform cũ — vòng sau khai thác vùng điểm cao.
 */
export function pickTournamentParent(
  encodings: readonly (readonly number[])[],
  scores: readonly number[],
  rng: () => number,
  k: number = TOURNAMENT_K,
): number[] {
  if (encodings.length === 0) throw new Error('pickTournamentParent: không có cha')
  if (scores.length !== encodings.length) {
    throw new Error(`pickTournamentParent: encodings (${encodings.length}) và scores (${scores.length}) phải song song`)
  }
  if (encodings.length === 1) return [...encodings[0]]
  const kk = Math.max(2, Math.min(k, encodings.length))
  let bestIdx = 0
  let bestScore = -Infinity
  for (let t = 0; t < kk; t++) {
    const i = Math.floor(rng() * encodings.length)
    if (scores[i] > bestScore) {
      bestScore = scores[i]
      bestIdx = i
    }
  }
  return [...encodings[bestIdx]]
}

// ==================== 3) MUTATION RATE THÍCH ỨNG ====================

/**
 * Cường độ mutation giảm tuyến tính 0,15 → 0,06 theo tiến độ vòng (done/total)
 * — đầu vòng khám phá rộng, cuối vòng tinh chỉnh quanh ứng viên tốt. Thuần.
 */
export function adaptiveMutationRate(done: number, total: number): number {
  if (total <= 1) return MUTATION_RATE_START
  const t = Math.min(1, Math.max(0, done / (total - 1)))
  return MUTATION_RATE_START - (MUTATION_RATE_START - MUTATION_RATE_END) * t
}

// ==================== GLUE: SUGGESTION → ENCODING 144 ====================

/**
 * Hạt giống #0 của vòng evolve: suggestion → EvoCandidateSpec (hyper = default
 * draft của brain, blocks toàn identity — khởi đầu thuần MLP đã tính) →
 * encoding 144 canonical. encodeEvoCandidate lượng tử hoá units về slot —
 * kích thức THẬT của ứng viên #0 là bản decode của encoding này (UI hiển thị
 * cùng nguồn: decode(encode(suggestion))).
 */
export function suggestionToEncoding(
  sug: ArchSuggestion,
  brain: BrainKey,
  inputDim: number | null,
): number[] {
  const d = defaultDraftFor(brain)
  const spec: EvoCandidateSpec = {
    head: {
      hidden: sug.hidden.map(h => ({ units: h.units, activation: h.activation })),
      hyper: {
        lr: d.hyper.lr,
        l2: d.hyper.l2,
        epochs: d.hyper.epochs,
        batch: d.hyper.batch,
        patience: d.hyper.patience,
      },
    },
    blocks: [{ type: 'identity' }, { type: 'identity' }, { type: 'identity' }],
    headDim: 64,
  }
  return encodeEvoCandidate(spec, brain, inputDim)
}
