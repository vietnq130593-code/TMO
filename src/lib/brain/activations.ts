/**
 * BRAIN-P1 · ACTIVATIONS — menu 9 hàm kích hoạt + đạo hàm (blueprint §4.1)
 * ============================================================================
 * Thuần toán — KHÔNG import gì (an toàn client bundle lẫn bun:test).
 *
 * Menu theo chỉ thị user (2026-10-12, mở rộng từ 4 lên 9 hàm — blueprint
 * §4.1 + §9.2 UX-1): sigmoid · linear · tanh · ReLU · Leaky ReLU · ELU ·
 * Swish · GELU · softmax.
 *
 * Quy ước đạo hàm: `backward(z)` trả về φ′(z) — đạo hàm theo ĐẦU VÀO z
 * (pre-activation), để mlp.ts tính δₗ = (Wᵀδₗ₊₁) ⊙ φ′(zₗ) bằng cache z.
 *
 * Ghi chú audit B1 (blueprint v0.2): softmax KHÔNG phải hàm từng phần tử —
 * chỉ hợp lệ ở lớp output đa lớp (đi kèm cross-entropy, đạo hàm gộp
 * δ = p − y — xem mlp.ts); spec có softmax ở lớp ẩn bị từ chối.
 *
 * Ổn định số (audit B3): sigmoid dạng hai nhánh tránh tràn exp(−z);
 * softmax trừ max (log-sum-exp) — xem `softmaxVector`.
 */

// ==================== TYPES ====================

export type ActivationName =
  | 'sigmoid'
  | 'linear'
  | 'tanh'
  | 'relu'
  | 'leakyRelu'
  | 'elu'
  | 'swish'
  | 'gelu'
  | 'softmax'

/** Tham số mở rộng của một số hàm (mặc định theo blueprint §9.2). */
export interface ActivationParams {
  /** Leaky ReLU / ELU — hệ số dốc / đơm âm. Mặc định 0.01 / 1.0 */
  alpha?: number
  /** Swish — hệ số β. Mặc định 1.0 */
  beta?: number
}

/** Họ khởi tạo trọng số khuyến nghị (init.ts đọc trường này). */
export type InitFamily = 'he' | 'xavier'

export interface ActivationFn {
  /** φ(z) — lan truyền tiến (từng phần tử). */
  forward(z: number, p?: ActivationParams): number
  /** φ′(z) — đạo hàm tại pre-activation z (từng phần tử). */
  backward(z: number, p?: ActivationParams): number
  /** Họ khởi tạo khuyến nghị: relu-family → He; còn lại → Xavier. */
  init: InitFamily
}

// ==================== HELPERS ====================

/** Sigmoid ổn định hai nhánh (audit B3): tránh exp(−z) tràn khi z rất âm. */
function sigmoidStable(z: number): number {
  return z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z))
}

function resolveAlpha(p?: ActivationParams, fallback = 1): number {
  const a = p?.alpha
  return typeof a === 'number' && Number.isFinite(a) && a > 0 ? a : fallback
}

function resolveBeta(p?: ActivationParams): number {
  const b = p?.beta
  return typeof b === 'number' && Number.isFinite(b) && b > 0 ? b : 1
}

// ==================== MENU 9 HÀM ====================

export const ACTIVATIONS: Readonly<Record<ActivationName, ActivationFn>> = {
  sigmoid: {
    forward: z => sigmoidStable(z),
    backward: z => {
      const s = sigmoidStable(z)
      return s * (1 - s)
    },
    init: 'xavier',
  },

  linear: {
    forward: z => z,
    backward: () => 1,
    init: 'xavier',
  },

  tanh: {
    forward: z => Math.tanh(z),
    backward: z => {
      const t = Math.tanh(z)
      return 1 - t * t
    },
    init: 'xavier',
  },

  relu: {
    forward: z => (z > 0 ? z : 0),
    backward: z => (z > 0 ? 1 : 0),
    init: 'he',
  },

  leakyRelu: {
    forward: (z, p) => (z > 0 ? z : resolveAlpha(p, 0.01) * z),
    backward: (z, p) => (z > 0 ? 1 : resolveAlpha(p, 0.01)),
    init: 'he',
  },

  elu: {
    forward: (z, p) => {
      if (z > 0) return z
      const alpha = resolveAlpha(p, 1)
      return alpha * (Math.exp(z) - 1)
    },
    backward: (z, p) => {
      if (z > 0) return 1
      const alpha = resolveAlpha(p, 1)
      // φ(z) + α với nhánh âm: α(e^z − 1) + α = α·e^z
      return alpha * Math.exp(z)
    },
    init: 'he',
  },

  swish: {
    forward: (z, p) => {
      const beta = resolveBeta(p)
      return z * sigmoidStable(beta * z)
    },
    backward: (z, p) => {
      const beta = resolveBeta(p)
      const s = sigmoidStable(beta * z)
      // φ′ = σ(βz) · (1 + βz·(1 − σ(βz)))
      return s * (1 + beta * z * (1 - s))
    },
    init: 'he',
  },

  gelu: {
    // Xấp xỉ tanh (chuẩn transformer — GELU paper §2): dùng dạng đóng
    // trơn để gradient-check bằng sai phân hữu hạn ổn định.
    forward: z => {
      const u = 0.7978845608028654 * (z + 0.044715 * z * z * z) // √(2/π)
      return 0.5 * z * (1 + Math.tanh(u))
    },
    backward: z => {
      const c = 0.7978845608028654 // √(2/π)
      const u = c * (z + 0.044715 * z * z * z)
      const t = Math.tanh(u)
      const du = c * (1 + 3 * 0.044715 * z * z)
      return 0.5 * (1 + t) + 0.5 * z * (1 - t * t) * du
    },
    init: 'he',
  },

  softmax: {
    // Điểm danh trong menu cho VALIDATION; tính trên vector xem
    // `softmaxVector`. backward của softmax KHÔNG phải từng phần tử —
    // mlp.ts dùng cặp gộp softmax + cross-entropy: δ = p − y (audit B1).
    forward: z => sigmoidStable(z),
    backward: () => 0,
    init: 'xavier',
  },
}

/** Danh sách tên hợp lệ (đầy đủ 9 hàm — test r84). */
export const ACTIVATION_NAMES: readonly ActivationName[] = Object.keys(
  ACTIVATIONS,
) as ActivationName[]

/**
 * Softmax vector ổn định số (audit B3): trừ max trước mũ (log-sum-exp
 * dạng trừ) — tổng luôn 1 dù z lớn. CHỈ dùng cho lớp output đa lớp.
 */
export function softmaxVector(z: readonly number[]): number[] {
  if (z.length === 0) return []
  let max = -Infinity
  for (const v of z) if (v > max) max = v
  let sum = 0
  const exps = z.map(v => {
    const e = Math.exp(v - max)
    sum += e
    return e
  })
  return exps.map(e => e / sum)
}
