/**
 * EVO-P3 (BLUEPRINT-EVO-NAO-P1-P5 §4.4) — MICRO-MoE
 * ============================================================================
 *
 * k=2–4 expert MLP nhỏ (dense d→d tanh), router linear top-k (softmax
 * renormalized trên k expert trọng cao nhất); **aux loss 0.01 chống sập
 * router** — chỉ thật sự train khi tập ≥ MOE_MIN_SAMPLES = 2000 mẫu (Q4 chốt
 * "động": dưới ngưỡng block decode vẫn hợp lệ nhưng buildEvoBlock THAY bằng
 * identity — evolve ghi cờ `moeSkipped`, corpus thấy "đã từng thử gì").
 *
 * Aux loss (load-balance, kiểu Switch-Transformer đơn giản hoá, tính TRÊN
 * 1 chuỗi forward):  aux = W_aux · E · Σ_i f_i · P_i
 *   f_i = 1/|top-k| nếu expert i ∈ top-k của token (0 nếu ngoài) — "tải"
 *   P_i = xác suất softmax ĐẦY ĐỦ của router cho expert i
 * Router đều tải (P đều & f khớp P) → aux nhỏ; sập về 1 expert → aux lớn.
 *
 * Backward (chuẩn, r105/r107 pin bằng numerical gradient check):
 *   gate softmax renormalized trên top-k T:
 *     dz_i = g_i·(dL/dg_i − Σ_{b∈T} g_b·dL/dg_b)  (i ∈ T; ngoài T = 0)
 *   aux (softmax đầy đủ P):
 *     dz_j += W_aux·E·(f_j·P_j − P_j·Σ_i f_i·P_i)
 *
 * H4: tất định — không random; top-k tie-break theo CHỈ SỐ (ổn định).
 * Thuần — không db/React. Import một chiều './dense' + '../init' (không vòng).
 */

import { initWeights } from '../init'
import { EvoDense } from './dense'
import type { EvoBlock, EvoBlockSpec } from './block-types'

/** Q4/§4.4 — MoE chỉ thật sự train khi tập ≥ 2K mẫu. */
export const MOE_MIN_SAMPLES = 2000
/** §4.4 — trọng số aux loss chống sập router. */
export const MOE_AUX_WEIGHT = 0.01

/**
 * Số expert: E = k + 1 (k expert được route + 1 dự phòng — router LUÔN còn
 * lựa chọn ngoài top-k để aux loss có nghĩa khi tải lệch). k ∈ [2..4] → E ∈ [3..5].
 */
export function moeExpertCount(spec: EvoBlockSpec): number {
  return Math.max(3, Math.min(5, Math.round(spec.moeK ?? 2) + 1))
}

/** Đếm tham số MoE: E expert (d·d + d) + router (E·d + E) — single-source. */
export function countMoeParams(spec: EvoBlockSpec, tokenDim: number): number {
  const E = moeExpertCount(spec)
  return E * (tokenDim * tokenDim + tokenDim) + E * tokenDim + E
}

/** Block micro-MoE — MỖI token route độc lập (per-token routing). */
export class MoEBlock implements EvoBlock {
  readonly spec: EvoBlockSpec
  readonly preservesDim = true
  readonly tokenDim: number
  readonly k: number
  readonly experts: EvoDense[]
  readonly router: EvoDense
  /** Aux loss chuỗi forward gần nhất (ĐÃ × MOE_AUX_WEIGHT, trung bình/token) — trainer cộng vào loss. */
  lastAuxLoss = 0
  private cache: Array<{
    x: number[]
    topIdx: number[]
    gate: number[]
    expertOut: number[][]
    probs: number[]
  }> = []

  constructor(spec: EvoBlockSpec, tokenDim: number) {
    this.spec = spec
    this.tokenDim = tokenDim
    this.k = Math.max(2, Math.min(4, Math.round(spec.moeK ?? 2)))
    const E = moeExpertCount(spec)
    this.experts = Array.from({ length: E }, () => new EvoDense(tokenDim, tokenDim, 'tanh', 'xavier'))
    this.router = new EvoDense(tokenDim, E, 'none', 'xavier')
  }

  get paramCount(): number {
    return this.experts.reduce((s, e) => s + e.paramCount, 0) + this.router.paramCount
  }

  attach(params: Float64Array, grads: Float64Array, offset: number): void {
    let o = offset
    for (const e of this.experts) {
      e.attach(params, grads, o)
      o += e.paramCount
    }
    this.router.attach(params, grads, o)
  }

  initParams(rng: () => number): void {
    for (const e of this.experts) e.initParams(rng)
    this.router.initParams(rng)
  }

  /** Softmax renormalized trên top-k + softmax đầy đủ (cho aux). */
  private route(logits: readonly number[]): { topIdx: number[]; gate: number[]; probs: number[] } {
    const E = logits.length
    // top-k theo (logit, index) — tie-break chỉ số ổn định (H4)
    const order = Array.from({ length: E }, (_, i) => i).sort((a, b) => logits[b] - logits[a] || a - b)
    const topIdx = order.slice(0, Math.min(this.k, E))
    let maxT = -Infinity
    for (const i of topIdx) if (logits[i] > maxT) maxT = logits[i]
    let den = 0
    const gate = topIdx.map(i => {
      const e = Math.exp(logits[i] - maxT)
      den += e
      return e
    }).map(e => e / den)
    // softmax đầy đủ
    let maxA = -Infinity
    for (let i = 0; i < E; i++) if (logits[i] > maxA) maxA = logits[i]
    let denA = 0
    const ex = Array.from({ length: E }, (_, i) => {
      const e = Math.exp(logits[i] - maxA)
      denA += e
      return e
    })
    const probs = ex.map(e => e / denA)
    return { topIdx, gate, probs }
  }

  forwardSeq(seq: readonly Float64Array[]): Float64Array[] {
    this.cache = []
    const E = this.experts.length
    const out: Float64Array[] = []
    let auxAccum = 0
    for (const tok of seq) {
      const x = Array.from(tok)
      const logits = this.router.forward(x)
      const { topIdx, gate, probs } = this.route(logits)
      const expertOut = topIdx.map(ei => this.experts[ei].forward(x))
      const y = new Float64Array(this.tokenDim)
      for (let gi = 0; gi < topIdx.length; gi++) {
        const g = gate[gi]
        for (let z = 0; z < this.tokenDim; z++) y[z] += g * expertOut[gi][z]
      }
      let aux = 0
      for (let i = 0; i < E; i++) {
        const f = topIdx.includes(i) ? 1 / topIdx.length : 0
        aux += f * probs[i]
      }
      auxAccum += E * aux
      this.cache.push({ x, topIdx, gate, expertOut, probs })
      out.push(y)
    }
    this.lastAuxLoss = seq.length > 0 ? (MOE_AUX_WEIGHT * auxAccum) / seq.length : 0
    return out
  }

  backwardSeq(gradOut: readonly Float64Array[]): Float64Array[] {
    const E = this.experts.length
    const nTok = gradOut.length
    const dIn: Float64Array[] = []
    for (let t = 0; t < nTok; t++) {
      const c = this.cache[t]
      const g = gradOut[t]
      const dx = new Float64Array(this.tokenDim)
      const dLogits = new Array<number>(E).fill(0)
      // 1) dL/dg_a = Σ_z dy_z · E_a(x)_z
      const dGate = c.topIdx.map((_, gi) => {
        let s = 0
        for (let z = 0; z < this.tokenDim; z++) s += g[z] * c.expertOut[gi][z]
        return s
      })
      // 2) softmax renormalized backward (chỉ top-k)
      let dot = 0
      for (let gi = 0; gi < c.topIdx.length; gi++) dot += c.gate[gi] * dGate[gi]
      for (let gi = 0; gi < c.topIdx.length; gi++) {
        dLogits[c.topIdx[gi]] += c.gate[gi] * (dGate[gi] - dot)
      }
      // 3) aux backward (softmax đầy đủ): dz_j += W·E·(f_j·P_j − P_j·Σf_i·P_i)
      let sumFP = 0
      for (let i = 0; i < E; i++) {
        const f = c.topIdx.includes(i) ? 1 / c.topIdx.length : 0
        sumFP += f * c.probs[i]
      }
      for (let j = 0; j < E; j++) {
        const f = c.topIdx.includes(j) ? 1 / c.topIdx.length : 0
        dLogits[j] += (MOE_AUX_WEIGHT * E * (f * c.probs[j] - c.probs[j] * sumFP)) / nTok
      }
      // 4) expert backward + input grad — REPLAY forward với x của token t
      // (cache EvoDense bị ghi đè qua các token — replay nạp đúng trước backward)
      for (let gi = 0; gi < c.topIdx.length; gi++) {
        const dExpert = new Array<number>(this.tokenDim)
        for (let z = 0; z < this.tokenDim; z++) dExpert[z] = g[z] * c.gate[gi]
        this.experts[c.topIdx[gi]].forward(c.x)
        const dxi = this.experts[c.topIdx[gi]].backward(dExpert)
        for (let z = 0; z < this.tokenDim; z++) dx[z] += dxi[z]
      }
      // 5) router linear backward → input grad (replay tương tự)
      this.router.forward(c.x)
      const dxr = this.router.backward(dLogits)
      for (let z = 0; z < this.tokenDim; z++) dx[z] += dxr[z]
      dIn.push(dx)
    }
    return dIn
  }
}
