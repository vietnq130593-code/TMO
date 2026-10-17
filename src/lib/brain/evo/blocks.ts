/**
 * EVO-P2 (BLUEPRINT-EVO-NAO-P1-P5 §4.3) — BLOCK ENGINE THUẦN TS
 * ============================================================================
 *
 * Mỗi block xử lý chuỗi token [L][d] implement forward + backward chuẩn;
 * CPU-first, seq ≤512 (EVO_MAX_SEQ). Loại block (encoding §4.2 slot
 * layer-type [96..113], thứ tự EVO_BLOCK_TYPES pin r105):
 *   identity · mlp · attention-causal-1head · selective-SSM · micro-MoE
 *   (moe.ts — P3) · gated-residual.
 *
 * BẤT BIẾN (blueprint §6): H1 module KHÔNG chạm runtime production;
 * H4 TẤT ĐỊNH bit-đối-bít (không Math.random/Date — mọi ngẫu nhiên qua rng
 * caller truyền; dropout CHỈ metadata spec — benchmark không dropout);
 * H6 weights ứng viên KHÔNG lưu.
 *
 * Mạng EVO (benchmark.ts ghép): input vector → toSequence (L token headDim
 * chiều) → blocks tuần tự → flatten → head MLP (draft.hidden) → output
 * per-unit activation.
 *
 * Thuần — KHÔNG import db/React (client-safe + bun:test trực tiếp).
 * Import một chiều: './dense', './moe', '../init', '../activations'.
 */

import { initWeights } from '../init'
import { EvoDense } from './dense'
import { countMoeParams, MoEBlock, MOE_MIN_SAMPLES } from './moe'
import { EVO_BLOCK_TYPES, type EvoBlockType, type EvoBlockSpec, type EvoBlock } from './block-types'

// Types chung re-export từ block-types (back-compat — search-space/r106 import
// từ './blocks' như cũ; block-types là module 0-import chống vòng — xem đầu file đó)
export { EVO_BLOCK_TYPES }
export type { EvoBlockType, EvoBlockSpec, EvoBlock }

// ==================== CHUỖI TOKEN (quy tắc tất định — r105 pin) ====================

/** Trần seq (§4.3 — attention O(L²) chấp nhận ở L ≤ 512). */
export const EVO_MAX_SEQ = 512

/**
 * Chia input vector thành chuỗi token headDim chiều: L = ceil(dim/headDim)
 * (kẹp [1, EVO_MAX_SEQ]), token cuối đệm 0 khi không chia hết; dim <
 * headDim → 1 token đệm 0 (L=1: attention tự chú ý, SSM 1 bước —退化 an toàn).
 */
export function toSequence(x: readonly number[], headDim: number): Float64Array[] {
  const d = Math.max(1, Math.min(128, Math.round(headDim)))
  const L = Math.max(1, Math.min(EVO_MAX_SEQ, Math.ceil(x.length / d)))
  const seq: Float64Array[] = []
  for (let t = 0; t < L; t++) {
    const tok = new Float64Array(d)
    for (let i = 0; i < d; i++) {
      const idx = t * d + i
      if (idx < x.length) tok[i] = x[idx]
    }
    seq.push(tok)
  }
  return seq
}

/** Ghép chuỗi token về vector phẳng (đảo toSequence — đệm giữ nguyên). */
export function flattenSeq(seq: readonly Float64Array[]): number[] {
  const out: number[] = []
  for (const t of seq) for (let i = 0; i < t.length; i++) out.push(t[i])
  return out
}

// ==================== IDENTITY ====================

class IdentityBlock implements EvoBlock {
  readonly spec: EvoBlockSpec = { type: 'identity' }
  readonly paramCount = 0
  readonly preservesDim = true
  readonly lastAuxLoss = 0
  constructor(readonly tokenDim: number) {}
  attach(): void { /* không tham số */ }
  initParams(): void { /* không tham số */ }
  forwardSeq(seq: readonly Float64Array[]): Float64Array[] {
    return seq.map(t => Float64Array.from(t))
  }
  backwardSeq(gradOut: readonly Float64Array[]): Float64Array[] {
    return gradOut.map(t => Float64Array.from(t))
  }
}

// ==================== MLP BLOCK (FFN chuẩn — expand → tanh → project về d) ====================

/**
 * Block FFN kiểu transformer: d → (expansion·d, tanh) → d — GIỮ NGUYÊN chiều
 * token (bảo toàn bất biến flatten L·d của mạng — bug R24-c live-verify:
 * bản 1 lớp d→e·d đổi chiều token khi expansion≠1 làm vỡ gradSeq). Tham số:
 * W1[e·d×d]+b1 + W2[d×e·d]+b2.
 */
class MlpBlock implements EvoBlock {
  readonly spec: EvoBlockSpec
  readonly preservesDim = true
  readonly tokenDim: number
  readonly lastAuxLoss = 0
  readonly up: EvoDense
  readonly down: EvoDense
  private cache: Array<{ x: number[]; h: number[] }> = []

  constructor(spec: EvoBlockSpec, tokenDim: number) {
    this.spec = spec
    this.tokenDim = tokenDim
    const h = Math.max(1, Math.round((spec.expansion ?? 1) * tokenDim))
    this.up = new EvoDense(tokenDim, h, 'tanh', 'xavier')
    this.down = new EvoDense(h, tokenDim, 'none', 'xavier')
  }
  get paramCount(): number {
    return this.up.paramCount + this.down.paramCount
  }
  attach(params: Float64Array, grads: Float64Array, offset: number): void {
    this.up.attach(params, grads, offset)
    this.down.attach(params, grads, offset + this.up.paramCount)
  }
  initParams(rng: () => number): void {
    this.up.initParams(rng)
    this.down.initParams(rng)
  }
  forwardSeq(seq: readonly Float64Array[]): Float64Array[] {
    this.cache = []
    const out: Float64Array[] = []
    for (const tok of seq) {
      const x = Array.from(tok)
      const h = this.up.forward(x)
      const y = this.down.forward(h)
      this.cache.push({ x, h })
      out.push(Float64Array.from(y))
    }
    return out
  }
  backwardSeq(gradOut: readonly Float64Array[]): Float64Array[] {
    const out: Float64Array[] = []
    for (let t = 0; t < gradOut.length; t++) {
      const c = this.cache[t]
      // replay nạp cache Dense đúng token (forward thuần xác định theo x)
      this.up.forward(c.x)
      this.down.forward(c.h)
      const dH = this.down.backward(Array.from(gradOut[t]))
      const dX = this.up.backward(dH)
      out.push(Float64Array.from(dX))
    }
    return out
  }
}

// ==================== ATTENTION CAUSAL 1-HEAD (§4.3) ====================

/**
 * 1 head duy nhất, mask causal (token i chỉ chú ý j ≤ i), O(L²) ở L ≤ 512;
 * KHÔNG multi-head, KHÔNG flash attention. Tham số: Wq/Wk/Wv/Wo [d×d] +
 * bq/bk/bv/bo (4d² + 4d). Backward chuẩn (softmax jacobian + проек).
 */
class AttentionBlock implements EvoBlock {
  readonly spec: EvoBlockSpec
  readonly preservesDim = true
  readonly tokenDim: number
  readonly paramCount: number
  readonly lastAuxLoss = 0
  private W!: Float64Array // [4][d*d] — q,k,v,o
  private b!: Float64Array // [4][d]
  private dW!: Float64Array
  private db!: Float64Array
  private xs: Float64Array[] = []
  private q: Float64Array[] = []
  private k: Float64Array[] = []
  private v: Float64Array[] = []
  private a: number[][] = [] // attention weights [i][j≤i]
  private ctx: Float64Array[] = []

  constructor(spec: EvoBlockSpec, tokenDim: number) {
    this.spec = spec
    this.tokenDim = tokenDim
    this.paramCount = 4 * tokenDim * tokenDim + 4 * tokenDim
  }

  attach(params: Float64Array, grads: Float64Array, offset: number): void {
    const d = this.tokenDim
    this.W = params.subarray(offset, offset + 4 * d * d)
    this.b = params.subarray(offset + 4 * d * d, offset + this.paramCount)
    this.dW = grads.subarray(offset, offset + 4 * d * d)
    this.db = grads.subarray(offset + 4 * d * d, offset + this.paramCount)
  }

  initParams(rng: () => number): void {
    const d = this.tokenDim
    const w = initWeights(d, d, 'xavier', rng)
    for (let m = 0; m < 4; m++) this.W.set(w, m * d * d)
    this.b.fill(0)
  }

  private proj(m: number, t: Float64Array): Float64Array {
    const d = this.tokenDim
    const out = new Float64Array(d)
    const base = m * d * d
    for (let j = 0; j < d; j++) {
      let z = this.b[m * d + j]
      const row = base + j * d
      for (let i = 0; i < d; i++) z += this.W[row + i] * t[i]
      out[j] = z
    }
    return out
  }

  forwardSeq(seq: readonly Float64Array[]): Float64Array[] {
    const d = this.tokenDim
    const L = seq.length
    const scale = 1 / Math.sqrt(d)
    this.xs = seq.slice()
    this.q = []
    this.k = []
    this.v = []
    this.a = []
    this.ctx = []
    for (let t = 0; t < L; t++) {
      this.q.push(this.proj(0, seq[t]))
      this.k.push(this.proj(1, seq[t]))
      this.v.push(this.proj(2, seq[t]))
    }
    const out: Float64Array[] = []
    for (let i = 0; i < L; i++) {
      const scores = new Array<number>(i + 1)
      let maxS = -Infinity
      for (let j = 0; j <= i; j++) {
        let s = 0
        for (let z = 0; z < d; z++) s += this.q[i][z] * this.k[j][z]
        s *= scale
        scores[j] = s
        if (s > maxS) maxS = s
      }
      let denom = 0
      const aRow = new Array<number>(i + 1)
      for (let j = 0; j <= i; j++) {
        const e = Math.exp(scores[j] - maxS)
        aRow[j] = e
        denom += e
      }
      for (let j = 0; j <= i; j++) aRow[j] /= denom
      this.a.push(aRow)
      const ctxTok = new Float64Array(d)
      for (let j = 0; j <= i; j++) {
        const aj = aRow[j]
        if (aj === 0) continue
        for (let z = 0; z < d; z++) ctxTok[z] += aj * this.v[j][z]
      }
      this.ctx.push(ctxTok)
      const outTok = new Float64Array(d)
      for (let j = 0; j < d; j++) {
        let z = this.b[3 * d + j]
        const row = 3 * d * d + j * d
        for (let i2 = 0; i2 < d; i2++) z += this.W[row + i2] * ctxTok[i2]
        outTok[j] = z
      }
      out.push(outTok)
    }
    return out
  }

  backwardSeq(gradOut: readonly Float64Array[]): Float64Array[] {
    const d = this.tokenDim
    const L = gradOut.length
    const scale = 1 / Math.sqrt(d)
    const dQ = Array.from({ length: L }, () => new Float64Array(d))
    const dK = Array.from({ length: L }, () => new Float64Array(d))
    const dV = Array.from({ length: L }, () => new Float64Array(d))
    const dIn = Array.from({ length: L }, () => new Float64Array(d))
    for (let i = 0; i < L; i++) {
      const dCtx = new Float64Array(d)
      for (let j = 0; j < d; j++) {
        const g = gradOut[i][j]
        this.db[3 * d + j] += g
        const row = 3 * d * d + j * d
        for (let z = 0; z < d; z++) {
          this.dW[row + z] += g * this.ctx[i][z]
          dCtx[z] += this.W[row + z] * g
        }
      }
      const aRow = this.a[i]
      const dA = new Array<number>(i + 1).fill(0)
      for (let j = 0; j <= i; j++) {
        for (let z = 0; z < d; z++) {
          dA[j] += dCtx[z] * this.v[j][z]
          dV[j][z] += aRow[j] * dCtx[z]
        }
      }
      let dot = 0
      for (let j = 0; j <= i; j++) dot += aRow[j] * dA[j]
      for (let j = 0; j <= i; j++) {
        const s = aRow[j] * (dA[j] - dot) * scale
        if (s === 0) continue
        for (let z = 0; z < d; z++) {
          dQ[i][z] += s * this.k[j][z]
          dK[j][z] += s * this.q[i][z]
        }
      }
    }
    for (let t = 0; t < L; t++) {
      const x = this.xs[t]
      const acc = (m: number, g: Float64Array): Float64Array => {
        const dX = new Float64Array(d)
        for (let j = 0; j < d; j++) {
          const gj = g[j]
          this.db[m * d + j] += gj
          const row = m * d * d + j * d
          for (let i = 0; i < d; i++) {
            this.dW[row + i] += gj * x[i]
            dX[i] += this.W[row + i] * gj
          }
        }
        return dX
      }
      const d1 = acc(0, dQ[t])
      const d2 = acc(1, dK[t])
      const d3 = acc(2, dV[t])
      for (let z = 0; z < d; z++) dIn[t][z] = d1[z] + d2[z] + d3[z]
    }
    return dIn
  }
}

// ==================== SELECTIVE SSM (Mamba-lite — §4.3) ====================

/**
 * SSM chọn lọc state N (8|16) — selective gate theo input, scan tuần tự
 * O(L·N). Token x_t (dim d):
 *   gate_t = σ(Wg·x_t + bg) ∈ (0,1)^N   — cổng chọn lọc
 *   sig_t  = tanh(Wb·x_t + bb) ∈ R^N    — tín hiệu vào
 *   S_t    = (1−gate_t) ⊙ S_{t−1} + gate_t ⊙ sig_t
 *   y_t[z] = tanh(Wc·S_t + bc)[z] · x_t[z] — đọc state (giữ chiều d)
 * Tham số: 3·(N·d) + 3N + d.
 */
class SsmBlock implements EvoBlock {
  readonly spec: EvoBlockSpec
  readonly preservesDim = true
  readonly tokenDim: number
  readonly n: number
  readonly paramCount: number
  readonly lastAuxLoss = 0
  private Wg!: Float64Array
  private Wb!: Float64Array
  private Wc!: Float64Array
  private bg!: Float64Array
  private bb!: Float64Array
  private bc!: Float64Array
  private dWg!: Float64Array
  private dWb!: Float64Array
  private dWc!: Float64Array
  private dbg!: Float64Array
  private dbb!: Float64Array
  private dbc!: Float64Array
  private xs: Float64Array[] = []
  private gates: Float64Array[] = []
  private sigs: Float64Array[] = []
  private states: Float64Array[] = []

  constructor(spec: EvoBlockSpec, tokenDim: number) {
    this.spec = spec
    this.tokenDim = tokenDim
    this.n = Math.max(4, Math.round(spec.ssmN ?? 8))
    const d = tokenDim
    this.paramCount = 3 * this.n * d + 3 * this.n + d
  }

  attach(params: Float64Array, grads: Float64Array, offset: number): void {
    const { n } = this
    const d = this.tokenDim
    let o = offset
    const seg = (len: number): Float64Array => {
      const s = params.subarray(o, o + len)
      o += len
      return s
    }
    this.Wg = seg(n * d)
    this.Wb = seg(n * d)
    this.bg = seg(n)
    this.bb = seg(n)
    this.Wc = seg(d * n)
    this.bc = seg(d)
    o = offset
    const segG = (len: number): Float64Array => {
      const s = grads.subarray(o, o + len)
      o += len
      return s
    }
    this.dWg = segG(n * d)
    this.dWb = segG(n * d)
    this.dbg = segG(n)
    this.dbb = segG(n)
    this.dWc = segG(d * n)
    this.dbc = segG(d)
  }

  initParams(rng: () => number): void {
    const { n } = this
    const d = this.tokenDim
    this.Wg.set(initWeights(d, n, 'xavier', rng))
    this.Wb.set(initWeights(d, n, 'xavier', rng))
    this.Wc.set(initWeights(n, d, 'xavier', rng))
    this.bg.fill(0)
    this.bb.fill(0)
    this.bc.fill(0)
  }

  forwardSeq(seq: readonly Float64Array[]): Float64Array[] {
    const { n } = this
    const d = this.tokenDim
    const L = seq.length
    this.xs = seq.slice()
    this.gates = []
    this.sigs = []
    this.states = []
    let S = new Float64Array(n)
    const out: Float64Array[] = []
    for (let t = 0; t < L; t++) {
      const x = seq[t]
      const gate = new Float64Array(n)
      const sig = new Float64Array(n)
      for (let j = 0; j < n; j++) {
        let zg = this.bg[j]
        let zb = this.bb[j]
        const row = j * d
        for (let i = 0; i < d; i++) {
          zg += this.Wg[row + i] * x[i]
          zb += this.Wb[row + i] * x[i]
        }
        gate[j] = 1 / (1 + Math.exp(-zg))
        sig[j] = Math.tanh(zb)
      }
      const Snext = new Float64Array(n)
      for (let j = 0; j < n; j++) Snext[j] = (1 - gate[j]) * S[j] + gate[j] * sig[j]
      S = Snext
      this.gates.push(gate)
      this.sigs.push(sig)
      this.states.push(S)
      const y = new Float64Array(d)
      for (let z = 0; z < d; z++) {
        let zc = this.bc[z]
        const row = z * n
        for (let j = 0; j < n; j++) zc += this.Wc[row + j] * S[j]
        y[z] = Math.tanh(zc) * x[z]
      }
      out.push(y)
    }
    return out
  }

  backwardSeq(gradOut: readonly Float64Array[]): Float64Array[] {
    const { n } = this
    const d = this.tokenDim
    const L = gradOut.length
    const dIn = Array.from({ length: L }, () => new Float64Array(d))
    const dS = new Float64Array(n)
    for (let t = L - 1; t >= 0; t--) {
      const x = this.xs[t]
      const gate = this.gates[t]
      const sig = this.sigs[t]
      const S = this.states[t]
      const Sprev = t > 0 ? this.states[t - 1] : new Float64Array(n)
      const g = gradOut[t]
      // y[z] = tanh(zc_z)·x_z → dWc/dbc + dS (softmax đọc state)
      const dzc = new Float64Array(d)
      for (let z = 0; z < d; z++) {
        let zc = this.bc[z]
        const row = z * n
        for (let j = 0; j < n; j++) zc += this.Wc[row + j] * S[j]
        const ty = Math.tanh(zc)
        dzc[z] = g[z] * (1 - ty * ty) * x[z]
        dIn[t][z] += g[z] * ty
        this.dbc[z] += dzc[z]
        for (let j = 0; j < n; j++) this.dWc[row + j] += dzc[z] * S[j]
      }
      for (let j = 0; j < n; j++) {
        let acc = 0
        for (let z = 0; z < d; z++) acc += dzc[z] * this.Wc[z * n + j]
        dS[j] += acc
      }
      // S_t = (1−gate)⊙S_{t−1} + gate⊙sig
      const dgate = new Float64Array(n)
      const dsig = new Float64Array(n)
      for (let j = 0; j < n; j++) {
        dgate[j] = dS[j] * (sig[j] - Sprev[j])
        dsig[j] = dS[j] * gate[j]
      }
      for (let j = 0; j < n; j++) {
        const dzg = dgate[j] * gate[j] * (1 - gate[j])
        const dzb = dsig[j] * (1 - sig[j] * sig[j])
        this.dbg[j] += dzg
        this.dbb[j] += dzb
        const row = j * d
        for (let i = 0; i < d; i++) {
          this.dWg[row + i] += dzg * x[i]
          this.dWb[row + i] += dzb * x[i]
          dIn[t][i] += this.Wg[row + i] * dzg + this.Wb[row + i] * dzb
        }
      }
      const dSprev = new Float64Array(n)
      for (let j = 0; j < n; j++) dSprev[j] = dS[j] * (1 - gate[j])
      dS.set(dSprev)
    }
    return dIn
  }
}

// ==================== GATED RESIDUAL ====================

/**
 * out = x + residualScale · g ⊙ tanh(W·x + b), g = σ(V·x + c).
 * Tham số: 2·(d·d + d). Cache PER-TOKEN (main/gate từng token — backward
 * đúng token tương ứng, không phụ thuộc thứ tự gọi).
 */
class GatedBlock implements EvoBlock {
  readonly spec: EvoBlockSpec
  readonly preservesDim = true
  readonly tokenDim: number
  readonly lastAuxLoss = 0
  readonly main: EvoDense
  readonly gateDense: EvoDense
  private cache: Array<{ x: number[]; h: number[]; g: number[] }> = []

  constructor(spec: EvoBlockSpec, tokenDim: number) {
    this.spec = spec
    this.tokenDim = tokenDim
    this.main = new EvoDense(tokenDim, tokenDim, 'tanh', 'xavier')
    this.gateDense = new EvoDense(tokenDim, tokenDim, 'sigmoid', 'xavier')
  }

  get paramCount(): number {
    return this.main.paramCount + this.gateDense.paramCount
  }

  attach(params: Float64Array, grads: Float64Array, offset: number): void {
    this.main.attach(params, grads, offset)
    this.gateDense.attach(params, grads, offset + this.main.paramCount)
  }

  initParams(rng: () => number): void {
    this.main.initParams(rng)
    this.gateDense.initParams(rng)
  }

  forwardSeq(seq: readonly Float64Array[]): Float64Array[] {
    const scale = this.spec.residualScale ?? 1
    this.cache = []
    const out: Float64Array[] = []
    for (const tok of seq) {
      const x = Array.from(tok)
      const h = this.main.forward(x)
      const g = this.gateDense.forward(x)
      const y = new Float64Array(this.tokenDim)
      for (let i = 0; i < this.tokenDim; i++) y[i] = x[i] + scale * g[i] * h[i]
      this.cache.push({ x, h, g })
      out.push(y)
    }
    return out
  }

  backwardSeq(gradOut: readonly Float64Array[]): Float64Array[] {
    const scale = this.spec.residualScale ?? 1
    const dIn: Float64Array[] = []
    for (let t = 0; t < gradOut.length; t++) {
      const c = this.cache[t]
      const g = gradOut[t]
      const dMain = new Array<number>(this.tokenDim)
      const dGate = new Array<number>(this.tokenDim)
      const dRes = new Float64Array(this.tokenDim)
      for (let i = 0; i < this.tokenDim; i++) {
        dMain[i] = g[i] * scale * c.g[i]
        dGate[i] = g[i] * scale * c.h[i]
        dRes[i] = g[i]
      }
      // replay forward để nạp cache Dense đúng token (giá trị ĐÚNG — Dense
      // forward thuần xác định theo x, không đổi trạng thái ngoài cache)
      this.main.forward(c.x)
      this.gateDense.forward(c.x)
      const d1 = this.main.backward(dMain)
      const d2 = this.gateDense.backward(dGate)
      for (let i = 0; i < this.tokenDim; i++) dRes[i] += d1[i] + d2[i]
      dIn.push(dRes)
    }
    return dIn
  }
}

// ==================== ĐẾM THAM SỐ + FACTORY ====================

/** Đếm tham số block KHÔNG dựng (sampler kiểm trần 250K BRAIN_MAX_PARAMS). */
export function countBlockParams(spec: EvoBlockSpec, tokenDim: number): number {
  switch (spec.type) {
    case 'identity':
      return 0
    case 'mlp': {
      // FFN 2 lớp d → e·d → d (R24-c live-verify fix — giữ chiều token)
      const h = Math.max(1, Math.round((spec.expansion ?? 1) * tokenDim))
      return (h * tokenDim + h) + (tokenDim * h + tokenDim)
    }
    case 'attention':
      return 4 * tokenDim * tokenDim + 4 * tokenDim
    case 'ssm': {
      const n = Math.max(4, Math.round(spec.ssmN ?? 8))
      return 3 * n * tokenDim + 3 * n + tokenDim
    }
    case 'gated':
      return 2 * tokenDim * tokenDim + 2 * tokenDim
    case 'moe':
      return countMoeParams(spec, tokenDim)
  }
}

/**
 * Dựng block theo spec — TẤT ĐỊNH. 'moe' khi nSamples < MOE_MIN_SAMPLES
 * (Q4 "động") → THAY bằng identity + moeSkipped=true (slot encoding giữ
 * nguyên — corpus thấy "đã từng thử").
 */
export function buildEvoBlock(
  spec: EvoBlockSpec,
  tokenDim: number,
  ctx?: { nSamples?: number },
): { block: EvoBlock; moeSkipped: boolean } {
  switch (spec.type) {
    case 'identity':
      return { block: new IdentityBlock(tokenDim), moeSkipped: false }
    case 'mlp':
      return { block: new MlpBlock(spec, tokenDim), moeSkipped: false }
    case 'attention':
      return { block: new AttentionBlock(spec, tokenDim), moeSkipped: false }
    case 'ssm':
      return { block: new SsmBlock(spec, tokenDim), moeSkipped: false }
    case 'gated':
      return { block: new GatedBlock(spec, tokenDim), moeSkipped: false }
    case 'moe': {
      if (ctx && typeof ctx.nSamples === 'number' && ctx.nSamples < MOE_MIN_SAMPLES) {
        return { block: new IdentityBlock(tokenDim), moeSkipped: true }
      }
      return { block: new MoEBlock(spec, tokenDim), moeSkipped: false }
    }
  }
}

// ==================== FORMAT ARCH SUMMARY (single-source server/UI — §5.3) ====================

/**
 * Chuỗi kiến trúc compact cho bảng ứng viên U2 — dùng CHUNG server/UI
 * (doctrine #9). vd `[attn1h·64] → [ssm·N16] → MLP[128,64]`; identity
 * không in; thuần MLP → `MLP[16]`.
 */
export function formatArchSummary(
  blocks: readonly EvoBlockSpec[],
  hiddenUnits: readonly number[],
): string {
  const parts: string[] = []
  for (const b of blocks) {
    if (b.type === 'identity') continue
    switch (b.type) {
      case 'mlp':
        parts.push(`[mlp·×${Math.round(b.expansion ?? 1)}]`)
        break
      case 'attention':
        parts.push(`[attn1h·${Math.round(b.headDim ?? 64)}]`)
        break
      case 'ssm':
        parts.push(`[ssm·N${Math.round(b.ssmN ?? 8)}]`)
        break
      case 'gated':
        parts.push(`[gated·${(b.residualScale ?? 1).toFixed(1)}]`)
        break
      case 'moe':
        parts.push(`[moe·k${Math.round(b.moeK ?? 2)}]`)
        break
    }
  }
  const mlpPart = `MLP[${hiddenUnits.join(',')}]`
  return parts.length > 0 ? `${parts.join(' → ')} → ${mlpPart}` : mlpPart
}
