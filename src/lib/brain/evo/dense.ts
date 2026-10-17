/**
 * EVO-P2 (BLUEPRINT-EVO-NAO-P1-P5 §4.3) — LỚP DENSE CHUNG của block engine.
 * ============================================================================
 *
 * Dense W[out×in] + b[out] + activation — gắn VIEW vào buffer tham số/gradient
 * phẳng CHUNG toàn mạng (optimizer duy nhất — evolve trainer). Quy ước chỉ số
 * TRÙNG mlp.ts/init.ts: W[j·in + i] nối input i → unit j.
 *
 * Tách file riêng để blocks.ts và moe.ts cùng dùng mà KHÔNG import vòng.
 * Thuần — không db/React (client-safe + bun:test).
 */

import { initWeights } from '../init'
import { ACTIVATIONS, type ActivationName } from '../activations'

export class EvoDense {
  /** View buffer mạng — cấp thật trong attach(). */
  W: Float64Array = new Float64Array(0)
  b: Float64Array = new Float64Array(0)
  dW: Float64Array = new Float64Array(0)
  db: Float64Array = new Float64Array(0)
  private lastIn: number[] | null = null
  private lastZ: number[] | null = null
  private readonly wLen: number
  private readonly bLen: number

  constructor(
    readonly inDim: number,
    readonly outDim: number,
    private readonly act: ActivationName | 'none',
    private readonly initScheme: 'he' | 'xavier',
  ) {
    this.wLen = outDim * inDim
    this.bLen = outDim
  }

  get paramCount(): number {
    return this.wLen + this.bLen
  }

  /** Gắn view vào buffer phẳng tại offset — gọi 1 lần trước initParams. */
  attach(params: Float64Array, grads: Float64Array, offset: number): void {
    this.W = params.subarray(offset, offset + this.wLen)
    this.b = params.subarray(offset + this.wLen, offset + this.wLen + this.bLen)
    this.dW = grads.subarray(offset, offset + this.wLen)
    this.db = grads.subarray(offset + this.wLen, offset + this.wLen + this.bLen)
  }

  /** Khởi tạo tất định (He/Xavier theo activation — bias 0 chuẩn init.ts). */
  initParams(rng: () => number): void {
    this.W.set(initWeights(this.inDim, this.outDim, this.initScheme, rng))
    this.b.fill(0)
  }

  forward(x: readonly number[]): number[] {
    const out = new Array<number>(this.outDim)
    const z = new Array<number>(this.outDim)
    for (let j = 0; j < this.outDim; j++) {
      let acc = this.b[j]
      const row = j * this.inDim
      for (let i = 0; i < this.inDim; i++) acc += this.W[row + i] * x[i]
      z[j] = acc
      out[j] = this.act === 'none' ? acc : ACTIVATIONS[this.act].forward(acc, undefined)
    }
    this.lastIn = Array.from(x)
    this.lastZ = z
    return out
  }

  /** dOut → dIn + tích lũy dW/db (dùng cache forward gần NHẤT của CHÍNH dense này). */
  backward(dOut: readonly number[]): number[] {
    const dIn = new Array<number>(this.inDim).fill(0)
    const x = this.lastIn as number[]
    const z = this.lastZ as number[]
    for (let j = 0; j < this.outDim; j++) {
      let dZ = dOut[j]
      if (this.act !== 'none') dZ *= ACTIVATIONS[this.act].backward(z[j], undefined)
      const row = j * this.inDim
      this.db[j] += dZ
      for (let i = 0; i < this.inDim; i++) {
        this.dW[row + i] += dZ * x[i]
        dIn[i] += this.W[row + i] * dZ
      }
    }
    return dIn
  }
}
