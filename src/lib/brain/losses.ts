/**
 * BRAIN-P1 · LOSSES — hàm mất mát + đạo hàm + L2 (blueprint §4.1)
 * ============================================================================
 * Thuần toán — KHÔNG import gì. Menu: BCE (log-loss) · MSE · Huber ·
 * cross-entropy (đi kèm softmax).
 *
 * Ổn định số (audit B3 — blueprint v0.2):
 *  - BCE kẹp ŷ vào [ε, 1−ε] với ε = 1e−7 hai đầu TRƯỚC khi log.
 *  - Cross-entropy kẹp p ≥ ε trước log (softmax đã log-sum-exp ở
 *    activations.ts nhưng kẹp thêm một lớp ở biên).
 *  - Chính sách NaN (FB-BRAIN-P1-R1-13): NaN LAN TIẾP (prediction NaN phải
 *    hiện thành loss NaN — không thể "loss đẹp" che mất); ±∞ kẹp về biên
 *    an toàn (bão hoà là trạng thái hợp lệ).
 *
 * Cặp gộp đạo hàm sạch (numerically-stable shortcut — cùng tư duy
 * BCEWithLogitsLoss của thư viện chuẩn):
 *  - output sigmoid + loss BCE          → δ_L = ŷ − y   (mlp.ts dùng trực tiếp)
 *  - output softmax + loss crossEntropy → δ_L = p − y   (audit B1)
 *  Cặp khác (linear/tanh/… + MSE/Huber) đi đường tổng quát:
 *  δ_L = (∂L/∂ŷ) ⊙ φ′(z_L).
 *
 * Quy ước scale: loss MẪU = TRUNG BÌNH theo số unit đầu ra với
 * BCE/MSE/Huber (lr ổn định khi đổi số unit); crossEntropy = TỔNG
 * theo unit (chuẩn đa lớp — chỉ dùng với softmax).
 */

// ==================== TYPES ====================

export type LossName = 'bce' | 'mse' | 'huber' | 'crossEntropy'

export interface LossFn {
  /** L(ŷ, y) cho 1 cặp vô hướng (unit đơn). */
  fn(yHat: number, y: number, p?: LossParams): number
  /** ∂L/∂ŷ cho 1 cặp vô hướng (unit đơn — không dùng cho cặp gộp). */
  deriv(yHat: number, y: number, p?: LossParams): number
}

export interface LossParams {
  /** Ngưỡng Huber δ. Mặc định 1.0. */
  delta?: number
}

export const BCE_EPSILON = 1e-7

// ==================== HELPERS ====================

function resolveDelta(p?: LossParams): number {
  const d = p?.delta
  return typeof d === 'number' && Number.isFinite(d) && d > 0 ? d : 1
}

function clipProb(v: number): number {
  // Kẹp ε hai đầu (audit B3). NaN LAN TIẾP — không che mất (prediction
  // NaN mà bce trả loss ~0 là "dự đoán hoàn hảo" giả — nguy hiểm hơn crash;
  // FB-BRAIN-P1-R1-13); ±∞ rơi về biên an toàn.
  if (Number.isNaN(v)) return NaN
  if (!Number.isFinite(v)) return v < 0 ? BCE_EPSILON : 1 - BCE_EPSILON
  return Math.min(1 - BCE_EPSILON, Math.max(BCE_EPSILON, v))
}

// ==================== MENU 4 LOSS ====================

export const LOSSES: Readonly<Record<LossName, LossFn>> = {
  /** Binary cross-entropy (log-loss) — yêu cầu ŷ ∈ (0,1) (output sigmoid). */
  bce: {
    fn: (yHat, y) => {
      const p = clipProb(yHat)
      return -(y * Math.log(p) + (1 - y) * Math.log(1 - p))
    },
    deriv: (yHat, y) => {
      const p = clipProb(yHat)
      return -(y / p - (1 - y) / (1 - p))
    },
  },

  /** Mean squared error — hồi quy giá trị thô (output linear/tanh). */
  mse: {
    fn: (yHat, y) => {
      const e = yHat - y
      return e * e
    },
    deriv: (yHat, y) => 2 * (yHat - y),
  },

  /** Huber (δ mặc định 1.0) — mượt với outlier (E[tokens], E[latency]). */
  huber: {
    fn: (yHat, y, p) => {
      const d = resolveDelta(p)
      const e = Math.abs(yHat - y)
      return e <= d ? 0.5 * e * e : d * (e - 0.5 * d)
    },
    deriv: (yHat, y, p) => {
      const d = resolveDelta(p)
      const e = yHat - y
      return Math.abs(e) <= d ? e : d * Math.sign(e)
    },
  },

  /**
   * Cross-entropy cho softmax output đa lớp. Đạo hàm vô hướng KHÔNG có
   * nghĩa (softmax ràng buộc tổng) — mlp.ts dùng cặp gộp δ = p − y.
   * `deriv` vẫn trả về xấp xỉ −y/p cho mục đích kiểm thử/ký gỡ.
   */
  crossEntropy: {
    fn: (yHat, y) => {
      const p = clipProb(yHat)
      return -y * Math.log(p)
    },
    deriv: (yHat, y) => {
      const p = clipProb(yHat)
      return -y / p
    },
  },
}

export const LOSS_NAMES: readonly LossName[] = Object.keys(LOSSES) as LossName[]

// ==================== VECTOR-LEVEL (mlp.ts gọi) ====================

/**
 * Loss 1 mẫu trên vector đầu ra (đúng quy ước scale ở đầu file).
 * Trả về số (NaN nếu chiều dài lệch — caller validate trước).
 */
export function sampleLoss(
  loss: LossName,
  yHat: readonly number[],
  y: readonly number[],
  p?: LossParams,
): number {
  const n = yHat.length
  if (n === 0 || y.length !== n) return NaN
  let sum = 0
  for (let i = 0; i < n; i++) sum += LOSSES[loss].fn(yHat[i], y[i], p)
  return loss === 'crossEntropy' ? sum : sum / n
}

// ==================== L2 REGULARIZER (audit §4.1) ====================

/**
 * Phần L2: L_reg = (λ/2)·Σw² — CHỈ áp trọng số W, KHÔNG áp bias
 * (chuẩn thực hành; bias không làm overfit theo hướng đặc trưng).
 *
 * `l2WeightGrad(w) = λ·w` — mlp.ts cộng vào gradient W trước optimizer
 * step. Loss HIỂN THỊ (train/val history) là loss dữ liệu thuần — phần
 * L2 chỉ có mặt trong bước cập nhật (ghi rõ để tránh so sánh lệch).
 */
export function l2Penalty(l2: number, weights: readonly Float64Array[]): number {
  let s = 0
  for (const w of weights) for (let i = 0; i < w.length; i++) s += w[i] * w[i]
  return (l2 / 2) * s
}

export function l2WeightGrad(l2: number, w: number): number {
  return l2 * w
}
