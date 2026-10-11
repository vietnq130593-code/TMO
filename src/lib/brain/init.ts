/**
 * BRAIN-P1 · INIT — khởi tạo He/Xavier với PRNG tất định (blueprint §4.1)
 * ============================================================================
 * Thuần toán — KHÔNG import gì.
 *
 * Tất định (blueprint test r84 mục 3: cùng seed + cùng dữ liệu → cùng
 * weights bit-đối-bit): PRNG mulberry32 — pattern tái sử dụng tinh thần
 * `deterministicSeed` của q-table (FNV-1a + fmix32): mọi nguồn ngẫu nhiên
 * của brain đều chảy từ MỘT seed số, không dùng Math.random().
 *
 * Hai luồng seed TÁCH BIỆT (không ăn chung trạng thái):
 *  - Khởi tạo trọng số: makeRng(spec.seed)
 *  - Trộn dữ liệu fit():  makeRng(spec.seed ^ 0x5bd1e995) — tạo lại MỖI
 *    lần fit() → train lại bao nhiêu lần cũng ra cùng kết quả.
 *
 * Sơ đồ khởi tạo:
 *  - He     (relu/leakyRelu/elu/swish/gelu): W ~ N(0, √(2/fanIn))
 *  - Xavier (tanh/sigmoid/linear):          W ~ N(0, √(2/(fanIn+fanOut)))
 *  - Bias khởi tạo 0 (chuẩn).
 */

import type { ActivationName, InitFamily } from './activations'
import { ACTIVATIONS } from './activations'

// ==================== PRNG (mulberry32) ====================

/**
 * PRNG mulberry32 — uniform [0,1). Tất định từ seed uint32; seed 0 được
 * trộn thành hằng khác để tránh stream suy biến (mulberry32(0) vẫn tốt
 * nhưng đồng bộ hai luồng seed khác nhau cần tránh trùng đầu ra).
 */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0
  if (a === 0) a = 0x9e3779b9
  return function next(): number {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Chuẩn Gaussian N(0,1) bằng Box–Muller (dùng 2 lượt uniform). */
export function randn(rng: () => number): number {
  let u = rng()
  if (u < 1e-12) u = 1e-12 // tránh log(0)
  const v = rng()
  const r = Math.sqrt(-2 * Math.log(u))
  const theta = 2 * Math.PI * v
  return r * Math.cos(theta)
}

// ==================== SƠ ĐỒ THEO ACTIVATION ====================

/** Họ khởi tạo khuyến nghị cho activation (đọc từ ACTIVATIONS). */
export function initFamilyFor(activation: ActivationName): InitFamily {
  return ACTIVATIONS[activation].init
}

// ==================== KHỞI TẠO TRỌNG SỐ ====================

/**
 * Ma trận trọng số W shape [out × in] (row-major phẳng — quy ước mlp.ts:
 * W[j·in + i] nối input i → unit j). Trả về Float64Array độ dài out×in.
 *
 * - scheme 'he':     std = √(2 / fanIn)
 * - scheme 'xavier': std = √(2 / (fanIn + fanOut))  (Glorot)
 */
export function initWeights(
  fanIn: number,
  fanOut: number,
  scheme: InitFamily,
  rng: () => number,
): Float64Array {
  if (fanIn <= 0 || fanOut <= 0) {
    throw new Error(`initWeights: kích thước không hợp lệ (${fanIn}×${fanOut})`)
  }
  const std =
    scheme === 'he'
      ? Math.sqrt(2 / fanIn)
      : Math.sqrt(2 / (fanIn + fanOut))
  const W = new Float64Array(fanOut * fanIn)
  for (let j = 0; j < fanOut; j++) {
    for (let i = 0; i < fanIn; i++) {
      W[j * fanIn + i] = randn(rng) * std
    }
  }
  return W
}

/** Vector bias khởi tạo 0 (chuẩn He/Xavier). */
export function initBias(fanOut: number): Float64Array {
  if (fanOut <= 0) throw new Error(`initBias: kích thước không hợp lệ (${fanOut})`)
  return new Float64Array(fanOut)
}
