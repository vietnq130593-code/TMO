/**
 * BRAIN-P1 · OPTIMIZERS — SGD+momentum & Adam (blueprint §4.1)
 * ============================================================================
 * Thuần toán — KHÔNG import gì. Interface thống nhất `step(params, grads)`
 * cập nhật TRỰC TIẾP mảng tham số (in-place) theo gradient đã cộng L2 +
 * đã clip (mlp.ts làm 2 bước đó trước khi gọi).
 *
 *  - SGD + momentum (β = 0.9 — heavy-ball): v = β·v − lr·g ; p += v
 *  - Adam (β₁ = 0.9, β₂ = 0.999, ε = 1e−8 — gốc bài báo):
 *      m = β₁·m + (1−β₁)·g ;  v = β₂·v + (1−β₂)·g²
 *      m̂ = m/(1−β₁ᵗ) ;       v̂ = v/(1−β₂ᵗ)
 *      p −= lr · m̂ / (√v̂ + ε)
 *
 * Mỗi optimizer instance gắn với MỘT tensor tham số (mlp.ts tạo riêng cho
 * từng W/b) — trạng thái m/v/t độc lập, t tăng mỗi lần step() (bias
 * correction đúng even khi tensor có kích thước khác nhau).
 *
 * Test r84 mục 4: Adam hội tụ nhanh hơn GD thuần trên cùng bài toán.
 */

// ==================== TYPES ====================

export type OptimizerName = 'sgd' | 'adam'

export interface Optimizer {
  readonly name: OptimizerName
  /** Cập nhật in-place: params ← params − update(grads). */
  step(params: Float64Array, grads: Float64Array): void
}

export const SGD_MOMENTUM = 0.9
export const ADAM_BETA1 = 0.9
export const ADAM_BETA2 = 0.999
export const ADAM_EPSILON = 1e-8

// ==================== SGD + MOMENTUM ====================

class SgdMomentum implements Optimizer {
  readonly name = 'sgd' as const
  private velocity: Float64Array | null = null

  constructor(private readonly lr: number) {}

  step(params: Float64Array, grads: Float64Array): void {
    if (params.length !== grads.length) {
      throw new Error(`sgd.step: params ${params.length} ≠ grads ${grads.length}`)
    }
    if (this.velocity === null || this.velocity.length !== params.length) {
      this.velocity = new Float64Array(params.length)
    }
    const v = this.velocity
    for (let i = 0; i < params.length; i++) {
      // Heavy-ball: v = β·v − lr·g ; p += v
      v[i] = SGD_MOMENTUM * v[i] - this.lr * grads[i]
      params[i] += v[i]
    }
  }
}

// ==================== ADAM ====================

class Adam implements Optimizer {
  readonly name = 'adam' as const
  private m: Float64Array | null = null
  private v: Float64Array | null = null
  private t = 0

  constructor(private readonly lr: number) {}

  step(params: Float64Array, grads: Float64Array): void {
    if (params.length !== grads.length) {
      throw new Error(`adam.step: params ${params.length} ≠ grads ${grads.length}`)
    }
    if (this.m === null || this.v === null || this.m.length !== params.length) {
      this.m = new Float64Array(params.length)
      this.v = new Float64Array(params.length)
      this.t = 0
    }
    this.t += 1
    const m = this.m
    const v = this.v
    const bc1 = 1 - Math.pow(ADAM_BETA1, this.t)
    const bc2 = 1 - Math.pow(ADAM_BETA2, this.t)
    for (let i = 0; i < params.length; i++) {
      const g = grads[i]
      m[i] = ADAM_BETA1 * m[i] + (1 - ADAM_BETA1) * g
      v[i] = ADAM_BETA2 * v[i] + (1 - ADAM_BETA2) * g * g
      const mHat = m[i] / bc1
      const vHat = v[i] / bc2
      params[i] -= (this.lr * mHat) / (Math.sqrt(vHat) + ADAM_EPSILON)
    }
  }
}

// ==================== FACTORY ====================

export function createOptimizer(name: OptimizerName, lr: number): Optimizer {
  if (!Number.isFinite(lr) || lr <= 0) {
    throw new Error(`createOptimizer: lr không hợp lệ (${lr})`)
  }
  switch (name) {
    case 'sgd':
      return new SgdMomentum(lr)
    case 'adam':
      return new Adam(lr)
  }
}
