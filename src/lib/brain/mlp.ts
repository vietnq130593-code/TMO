/**
 * BRAIN-P1 · MLP — mạng nơ-ron đa lớp thuần TypeScript (blueprint §4.1)
 * ============================================================================
 * Thuần toán — chỉ import sibling activations/losses/init/optimizers
 * (KHÔNG import ngoài — an toàn client bundle lẫn bun:test).
 *
 * Spec: { layers:[{units, activation}], loss, optimizer, lr, l2, seed }
 *   - layers[0]  = lớp INPUT (units = số đặc trưng đầu vào; activation
 *     bị bỏ qua — hợp đồng dữ liệu, UX-1 §9.2 khoá cứng)
 *   - layers[…1…L−2] = lớp ẩn (softmax BỊ CẤM — audit B1)
 *   - layers[L−1] = lớp output:
 *       loss 'bce'          ↔ activation sigmoid
 *       loss 'crossEntropy' ↔ activation softmax (B1: chỉ output)
 *       loss 'mse'/'huber'  ↔ activation tuyến tính/tanh/relu-family
 *
 * Lan truyền:
 *   forward : aₗ = φ(Wₗ·aₗ₋₁ + bₗ)  — W shape [out×in], row-major phẳng
 *   backward: δ_L theo cặp gộp sạch:
 *               sigmoid+bce → δ = ŷ − y ; softmax+CE → δ = p − y
 *             cặp khác: δ_L = (∂L/∂ŷ) ⊙ φ′(z_L)
 *             δₗ = (Wₗ₊₁ᵀ δₗ₊₁) ⊙ φ′(zₗ)
 *             dWₗ[j,i] = δₗ[j]·aₗ₋₁[i] ; dbₗ[j] = δₗ[j]
 *
 * Kỷ luật train (blueprint §4.1 + audit):
 *   - mini-batch shuffle Fisher–Yates TẤT ĐỊNH theo luồng seed riêng
 *     (fit dùng makeRng(seed ^ 0x5bd1e995), tạo lại mỗi lần fit —
 *     cùng seed + cùng dữ liệu → cùng weights bit-đối-bit, test r84-3)
 *   - gradient clip toàn-cục norm 5 (mặc định — cấu hình được)
 *   - early stopping: patience đo trên HOLD-OUT 15% tách từ tập train
 *     (audit B2 — không đụng fold CV của caller); hết patience → trả
 *     weights về epoch tốt nhất
 *   - L2 (λ/2)‖W‖²: chỉ áp W (không áp bias); loss hiển thị là loss
 *     dữ liệu thuần, L2 chỉ có trong bước cập nhật
 *
 * Serialize (audit A6): envelope {dtype:'float64', shape, data} từng
 * tensor — numpy-đọc-được cho sidecar P5 (json.load → np.array).
 */

import {
  ACTIVATIONS,
  softmaxVector,
  type ActivationName,
  type ActivationParams,
} from './activations'
import { LOSSES, sampleLoss, l2WeightGrad, type LossName, type LossParams } from './losses'
import { initWeights, initBias, initFamilyFor, makeRng } from './init'
import { createOptimizer, type Optimizer, type OptimizerName } from './optimizers'

// ==================== TYPES ====================

export interface MlpLayerSpec {
  units: number
  activation: ActivationName
  /** Tham số α/β của Leaky ReLU / ELU / Swish (mặc định activations.ts). */
  activationParams?: ActivationParams
}

export interface MlpSpec {
  layers: MlpLayerSpec[]
  loss: LossName
  optimizer: OptimizerName
  lr: number
  l2: number
  seed: number
  /** Tham số loss (vd Huber delta) — single-source trong spec. */
  lossParams?: LossParams
}

export interface FitOptions {
  /** Số epoch tối đa — nguyên ≥ 1. Mặc định 1000. */
  epochs?: number
  /** Cỡ mini-batch — nguyên ≥ 1, tự kẹp ≤ n (cỡ batch lớn hơn tập dữ liệu vẫn chạy trọn vẹn 1 batch). Mặc định 32. */
  batchSize?: number
  /** Số epoch hết cải thiện → dừng (đo trên hold-out nếu có) — nguyên ≥ 0. Mặc định 100. */
  patience?: number
  /**
   * Tỉ lệ hold-out tách từ tập train (audit B2) — phạm vi [0, 0.5], NGOÀI
   * PHẠM VI NÉM LỖI (FB-BRAIN-P1-R2-01 — không kẹp im lặng: 0.99 gần
   * chắc chắn là bug caller). CHỈ tách hold-out khi n ≥ 4 mẫu (ít hơn:
   * không hold-out, early-stop đo trên train). Mặc định 0.15.
   */
  holdOutRatio?: number
  /** Chuẩn clip gradient toàn cục — ≥ 0; 0 = tắt. Mặc định 5 (blueprint §4.1). */
  clipNorm?: number
}

export interface EpochStat {
  epoch: number
  trainLoss: number
  valLoss: number | null
}

export interface FitResult {
  epochsRun: number
  bestEpoch: number
  bestLoss: number
  finalTrainLoss: number
  finalValLoss: number | null
  stoppedEarly: boolean
  history: EpochStat[]
}

/** Envelope trọng số numpy-đọc-được (audit A6). */
export interface WeightEnvelope {
  dtype: 'float64'
  shape: number[]
  data: number[]
}

export interface MlpSerialized {
  spec: MlpSpec
  tensors: Array<{
    kind: 'W' | 'b'
    /** Chỉ số lớp trọng số 1..L−1 (0 = input). */
    layer: number
    envelope: WeightEnvelope
  }>
}

// Mặc định theo blueprint (§4.1: clip 5, hold-out 15 — audit B2)
export const DEFAULT_EPOCHS = 1000
export const DEFAULT_BATCH_SIZE = 32
export const DEFAULT_PATIENCE = 100
export const DEFAULT_HOLDOUT_RATIO = 0.15
export const DEFAULT_CLIP_NORM = 5
/** Luồng seed riêng cho fit (tách khỏi init — xem init.ts). */
const FIT_SEED_XOR = 0x5bd1e995

// ==================== CLASS ====================

export class MLP {
  private readonly spec: MlpSpec
  /** W[l] shape [units[l] × units[l−1]] row-major; b[l] shape [units[l]] — l = 1..L−1. */
  private readonly W: Float64Array[] = []
  private readonly b: Float64Array[] = []
  private readonly lossParams?: LossParams

  constructor(spec: MlpSpec) {
    validateSpec(spec)
    // Deep-copy spec thuần dữ liệu (chống caller đổi sau khi build)
    this.spec = cloneSpec(spec)
    this.lossParams = this.spec.lossParams
    // Khởi tạo tất định — luồng makeRng(seed) (xem init.ts)
    const rng = makeRng(spec.seed)
    for (let l = 1; l < this.spec.layers.length; l++) {
      const fanIn = this.spec.layers[l - 1].units
      const fanOut = this.spec.layers[l].units
      const act = this.spec.layers[l].activation
      this.W.push(initWeights(fanIn, fanOut, initFamilyFor(act), rng))
      this.b.push(initBias(fanOut))
    }
  }

  // ---------- info ----------

  getSpec(): MlpSpec {
    return cloneSpec(this.spec)
  }

  /** Tổng số tham số (Σ unitsₗ·unitsₗ₋₁ + unitsₗ) — cho bộ đếm UX-1 §9.1-3. */
  paramCount(): number {
    let n = 0
    for (let l = 1; l < this.spec.layers.length; l++) {
      n += this.W[l - 1].length + this.b[l - 1].length
    }
    return n
  }

  // ---------- forward ----------

  /**
   * Lan truyền tiến, trả về activations từng lớp a[0..L−1]
   * (a[0] = input). Không đổi state — thuần.
   *
   * Hợp đồng input (FB-BRAIN-P1-R1-01): ném lỗi khi x sai chiều dài —
   * mọi đường inference công khai (predict/predictProba/lossOf/backward)
   * đều đi qua đây, rác im lặng không còn lối chui.
   */
  private forwardAll(x: readonly number[]): Float64Array[] {
    const L = this.spec.layers.length
    const inDim = this.spec.layers[0].units
    if (x.length !== inDim) {
      throw new Error(`forwardAll: input ${x.length} ≠ ${inDim} unit lớp input (spec.layers[0])`)
    }
    const acts: Float64Array[] = []
    const a0 = Float64Array.from(x)
    acts.push(a0)
    for (let l = 1; l < L; l++) {
      const prev = acts[l - 1]
      const units = this.spec.layers[l].units
      const fanIn = prev.length
      const Wl = this.W[l - 1]
      const bl = this.b[l - 1]
      const z = new Float64Array(units)
      for (let j = 0; j < units; j++) {
        let s = bl[j]
        const row = j * fanIn
        for (let i = 0; i < fanIn; i++) s += Wl[row + i] * prev[i]
        z[j] = s
      }
      const a = new Float64Array(units)
      const actName = this.spec.layers[l].activation
      if (actName === 'softmax') {
        const p = softmaxVector(Array.from(z))
        a.set(p)
      } else {
        const fn = ACTIVATIONS[actName]
        const ap = this.spec.layers[l].activationParams
        for (let j = 0; j < units; j++) a[j] = fn.forward(z[j], ap)
      }
      acts.push(a)
    }
    return acts
  }

  /**
   * Đầu ra mạng cho 1 mẫu (vector activation lớp cuối). Ném lỗi nếu
   * x.length ≠ units lớp input (không rác im lặng — FB-BRAIN-P1-R1-01).
   */
  predict(x: readonly number[]): number[] {
    const acts = this.forwardAll(x)
    return Array.from(acts[acts.length - 1])
  }

  /**
   * Convenience cho output 1 unit (sigmoid — Brain-A).
   * Ném lỗi nếu lớp cuối có nhiều unit (dùng predict() cho đa lớp).
   */
  predictProba(x: readonly number[]): number {
    const out = this.predict(x)
    if (out.length !== 1) {
      throw new Error(`predictProba: lớp output có ${out.length} unit — dùng predict()`)
    }
    return out[0]
  }

  /**
   * Loss dữ liệu (không L2) của 1 mẫu — tiện gradient-check & logging.
   * Ném lỗi nếu x/y sai chiều dài (FB-BRAIN-P1-R1-01).
   */
  lossOf(x: readonly number[], y: readonly number[]): number {
    const outDim = this.spec.layers[this.spec.layers.length - 1].units
    if (y.length !== outDim) {
      throw new Error(`lossOf: y ${y.length} ≠ output ${outDim}`)
    }
    return sampleLoss(this.spec.loss, this.predict(x), y, this.lossParams)
  }

  /**
   * View trọng số hiện tại (KHÔNG copy — read-only theo kiểu, caller không
   * được đột biến). Dùng cho gradient-check r84 và UX-3 §9.4 (xem |w|
   * từng nơ-ron/cạnh sau train).
   */
  inspectWeights(): { W: readonly Float64Array[]; b: readonly Float64Array[] } {
    return { W: this.W, b: this.b }
  }

  // ---------- backward (public cho gradient-check & UX-3 xem |grad|) ----------

  /**
   * Gradient của loss dữ liệu (không L2, chưa clip) theo W/b tại MỘT mẫu.
   * Trả về mảng song song với this.W / this.b.
   */
  backward(x: readonly number[], y: readonly number[]): { dW: Float64Array[]; db: Float64Array[] } {
    const L = this.spec.layers.length
    const acts = this.forwardAll(x)
    const out = acts[L - 1]
    if (y.length !== out.length) {
      throw new Error(`backward: y ${y.length} ≠ output ${out.length}`)
    }

    // δ lớp cuối theo cặp gộp sạch (xem losses.ts) hoặc đường tổng quát.
    // QUY ƯỚC SCALE (losses.ts): bce/mse/huber là loss TRUNG BÌNH theo unit
    // → đạo hàm nhân 1/out.length; crossEntropy là TỔNG → giữ nguyên
    // (δ = p − y chính là đạo hàm của CE-dạng-tổng). Không có bước này thì
    // gradient-check r84 lệch hệ số out.length.
    const lastAct = this.spec.layers[L - 1].activation
    const invOut = this.spec.loss === 'crossEntropy' ? 1 : 1 / out.length
    const paired =
      (this.spec.loss === 'bce' && lastAct === 'sigmoid') ||
      (this.spec.loss === 'crossEntropy' && lastAct === 'softmax')
    let delta = new Float64Array(out.length)
    if (paired) {
      for (let j = 0; j < out.length; j++) delta[j] = (out[j] - y[j]) * invOut
    } else {
      const lossFn = LOSSES[this.spec.loss]
      // φ′(z) cần z — tính lại z_L từ W,b,a (forwardAll đã cache a; z = φ⁻¹
      // không tổng quát → tính z trực tiếp tại đây)
      const prev = acts[L - 2]
      const fanIn = prev.length
      const Wl = this.W[L - 2]
      const bl = this.b[L - 2]
      const actFn = ACTIVATIONS[lastAct]
      const ap = this.spec.layers[L - 1].activationParams
      for (let j = 0; j < out.length; j++) {
        let z = bl[j]
        const row = j * fanIn
        for (let i = 0; i < fanIn; i++) z += Wl[row + i] * prev[i]
        delta[j] = lossFn.deriv(out[j], y[j], this.lossParams) * actFn.backward(z, ap) * invOut
      }
    }

    const dW: Float64Array[] = []
    const db: Float64Array[] = []
    // Lan truyền ngược từ lớp trọng số cuối về lớp 1
    for (let l = L - 1; l >= 1; l--) {
      const prev = acts[l - 1]
      const fanIn = prev.length
      const units = delta.length
      const dWl = new Float64Array(units * fanIn)
      const dbl = new Float64Array(units)
      for (let j = 0; j < units; j++) {
        dbl[j] = delta[j]
        const row = j * fanIn
        for (let i = 0; i < fanIn; i++) dWl[row + i] = delta[j] * prev[i]
      }
      dW.unshift(dWl)
      db.unshift(dbl)
      if (l > 1) {
        // δₗ₋₁ = (Wₗᵀ δₗ) ⊙ φ′(zₗ₋₁) — đúng units[l−1] phần tử
        const actName = this.spec.layers[l - 1].activation
        const actFn = ACTIVATIONS[actName]
        const ap = this.spec.layers[l - 1].activationParams
        const prevPrev = acts[l - 2]          // aₗ₋₂
        const fanInPrev = prevPrev.length     // units[l−2] — stride hàng Wₗ₋₁
        const Wcur = this.W[l - 1]            // Wₗ  — [units[l] × units[l−1]]
        const Wprev = this.W[l - 2]           // Wₗ₋₁ — [units[l−1] × units[l−2]]
        const bprev = this.b[l - 2]           // bₗ₋₁
        // SỐ UNIT của lớp l−1 chính là FANIN của Wₗ (chiều input) —
        // dùng nhầm fanInPrev ở đây sẽ đọc lệch hàng → NaN (bug đã bắt
        // bằng gradient-check r84 khi 2 lớp ẩn khác số unit).
        const next = new Float64Array(fanIn)
        for (let i = 0; i < fanIn; i++) {
          let s = 0
          for (let j = 0; j < units; j++) s += Wcur[j * fanIn + i] * delta[j]
          let z = bprev[i]
          const row = i * fanInPrev
          for (let k = 0; k < fanInPrev; k++) z += Wprev[row + k] * prevPrev[k]
          next[i] = s * actFn.backward(z, ap)
        }
        delta = next
      }
    }
    return { dW, db }
  }

  // ---------- fit ----------

  /**
   * Huấn luyện mini-batch. TẤT ĐỊNH: cùng spec (seed) + cùng dữ liệu +
   * cùng options → cùng weights kết thúc (test r84-3). Optimizer state
   * khởi tạo lại MỖI lần fit (fit lần 2 không kế thừa momentum lần 1).
   */
  fit(X: readonly (readonly number[])[], y: readonly (readonly number[])[], opts?: FitOptions): FitResult {
    const n = X.length
    if (n === 0) throw new Error('fit: dữ liệu rỗng')
    if (y.length !== n) throw new Error(`fit: X ${n} ≠ y ${y.length}`)
    const inDim = this.spec.layers[0].units
    const outDim = this.spec.layers[this.spec.layers.length - 1].units
    for (let i = 0; i < n; i++) {
      if (X[i].length !== inDim) throw new Error(`fit: X[${i}] có ${X[i].length} ≠ input ${inDim}`)
      if (y[i].length !== outDim) throw new Error(`fit: y[${i}] có ${y[i].length} ≠ output ${outDim}`)
    }

    // Hợp đồng options (FB-BRAIN-P1-R1-02): NaN trước đây rơi im lặng qua
    // mọi nhánh so sánh (batchSize NaN → batch rỗng → 1/0 = ∞ → NaN lan vào
    // weights; epochs/patience NaN → vòng lặp tắt ngóm; clipNorm NaN → tắt
    // clip). Rác vào phải NÉM to, không nuốt.
    const epochs = opts?.epochs ?? DEFAULT_EPOCHS
    const rawBatchSize = opts?.batchSize ?? DEFAULT_BATCH_SIZE
    const patience = opts?.patience ?? DEFAULT_PATIENCE
    const rawHoldOut = opts?.holdOutRatio ?? DEFAULT_HOLDOUT_RATIO
    const clipNorm = opts?.clipNorm ?? DEFAULT_CLIP_NORM
    if (!Number.isFinite(epochs) || !Number.isInteger(epochs) || epochs < 1) {
      throw new Error(`fit: epochs ${epochs} không hợp lệ (nguyên ≥ 1)`)
    }
    if (!Number.isFinite(rawBatchSize) || !Number.isInteger(rawBatchSize) || rawBatchSize < 1) {
      throw new Error(`fit: batchSize ${rawBatchSize} không hợp lệ (nguyên ≥ 1, tự kẹp ≤ n)`)
    }
    if (!Number.isFinite(patience) || !Number.isInteger(patience) || patience < 0) {
      throw new Error(`fit: patience ${patience} không hợp lệ (nguyên ≥ 0)`)
    }
    if (!Number.isFinite(rawHoldOut) || rawHoldOut < 0 || rawHoldOut > 0.5) {
      throw new Error(`fit: holdOutRatio ${rawHoldOut} không hợp lệ (phạm vi [0, 0.5])`)
    }
    if (!Number.isFinite(clipNorm) || clipNorm < 0) {
      throw new Error(`fit: clipNorm ${clipNorm} không hợp lệ (≥ 0; 0 = tắt)`)
    }
    const batchSize = Math.min(rawBatchSize, n) // rawBatchSize đã validate ≥ 1 — chỉ kẹp ≤ n
    const holdOutRatio = rawHoldOut // đã validate ∈ [0, 0.5] — không còn kẹp (FB-BRAIN-P1-R2-01 dọn mã chết)

    // Luồng seed riêng cho fit — tạo lại mỗi lần (tất định, xem init.ts)
    const rng = makeRng((this.spec.seed ^ FIT_SEED_XOR) >>> 0)

    // Tách hold-out (audit B2): chỉ khi đủ mẫu để chia (≥4), tỉ lệ ∈ (0, 0.5]
    let trainIdx: number[] = []
    let valIdx: number[] = []
    if (holdOutRatio > 0 && n >= 4) {
      const idx = Array.from({ length: n }, (_, i) => i)
      fisherYates(idx, rng)
      const valCount = Math.max(1, Math.min(Math.floor(n * holdOutRatio), n - 1))
      valIdx = idx.slice(0, valCount)
      trainIdx = idx.slice(valCount)
    } else {
      trainIdx = Array.from({ length: n }, (_, i) => i)
    }

    // Optimizer TƯƠI MỖI LẦN FIT — một instance cho từng tensor
    const optimizers: Optimizer[] = []
    for (let l = 1; l < this.spec.layers.length; l++) {
      optimizers.push(createOptimizer(this.spec.optimizer, this.spec.lr))
      optimizers.push(createOptimizer(this.spec.optimizer, this.spec.lr))
    }

    const history: EpochStat[] = []
    let bestLoss = Infinity
    let bestEpoch = 0
    let bestW: Float64Array[] | null = null
    let bestB: Float64Array[] | null = null
    let stoppedEarly = false

    for (let epoch = 1; epoch <= epochs; epoch++) {
      // Trộn tập train (Fisher–Yates tất định theo luồng rng)
      const order = [...trainIdx]
      fisherYates(order, rng)

      for (let start = 0; start < order.length; start += batchSize) {
        const batch = order.slice(start, start + batchSize)
        // Cộng dồn gradient mẫu, rồi chia trung bình batch
        const accW = this.W.map(w => new Float64Array(w.length))
        const accB = this.b.map(b => new Float64Array(b.length))
        for (const si of batch) {
          const { dW, db } = this.backward(X[si], y[si])
          for (let l = 0; l < dW.length; l++) {
            for (let k = 0; k < dW[l].length; k++) accW[l][k] += dW[l][k]
            for (let k = 0; k < db[l].length; k++) accB[l][k] += db[l][k]
          }
        }
        const inv = 1 / batch.length
        // Hoàn thiện gradient: trung bình + L2 (chỉ W — losses.ts)
        const l2 = this.spec.l2
        for (let l = 0; l < accW.length; l++) {
          for (let k = 0; k < accW[l].length; k++) {
            accW[l][k] = accW[l][k] * inv + l2WeightGrad(l2, this.W[l][k])
          }
          for (let k = 0; k < accB[l].length; k++) accB[l][k] = accB[l][k] * inv
        }
        // Clip norm toàn cục (blueprint: mặc định 5)
        if (clipNorm > 0) clipGlobalNorm(accW, accB, clipNorm)
        // Bước cập nhật từng tensor
        for (let l = 0; l < this.W.length; l++) {
          optimizers[2 * l].step(this.W[l], accW[l])
          optimizers[2 * l + 1].step(this.b[l], accB[l])
        }
      }

      // Loss hiển thị = loss dữ liệu thuần (không L2 — losses.ts)
      const trainLoss = meanLoss(this, X, y, trainIdx)
      const valLoss = valIdx.length > 0 ? meanLoss(this, X, y, valIdx) : null
      history.push({ epoch, trainLoss, valLoss })

      const monitor = valLoss ?? trainLoss
      if (monitor < bestLoss) {
        bestLoss = monitor
        bestEpoch = epoch
        bestW = this.W.map(w => Float64Array.from(w))
        bestB = this.b.map(b => Float64Array.from(b))
      } else if (epoch - bestEpoch >= patience) {
        stoppedEarly = true
        break
      }
    }

    // Hết patience → trả weights về epoch tốt nhất (early stopping chuẩn)
    if (stoppedEarly && bestW && bestB) {
      for (let l = 0; l < this.W.length; l++) {
        this.W[l].set(bestW[l])
        this.b[l].set(bestB[l])
      }
    }

    const last = history[history.length - 1]
    return {
      epochsRun: last?.epoch ?? 0,
      bestEpoch,
      bestLoss: Number.isFinite(bestLoss) ? bestLoss : NaN,
      finalTrainLoss: last?.trainLoss ?? NaN,
      finalValLoss: last?.valLoss ?? null,
      stoppedEarly,
      history,
    }
  }

  // ---------- serialize (audit A6 — numpy-đọc-được) ----------

  serialize(): MlpSerialized {
    const tensors: MlpSerialized['tensors'] = []
    for (let l = 1; l < this.spec.layers.length; l++) {
      const fanIn = this.spec.layers[l - 1].units
      const fanOut = this.spec.layers[l].units
      tensors.push({
        kind: 'W',
        layer: l,
        envelope: { dtype: 'float64', shape: [fanOut, fanIn], data: Array.from(this.W[l - 1]) },
      })
      tensors.push({
        kind: 'b',
        layer: l,
        envelope: { dtype: 'float64', shape: [fanOut], data: Array.from(this.b[l - 1]) },
      })
    }
    return { spec: cloneSpec(this.spec), tensors }
  }

  static deserialize(data: MlpSerialized): MLP {
    if (!data || !Array.isArray(data.spec?.layers) || !Array.isArray(data.tensors)) {
      throw new Error('deserialize: dữ liệu không đúng shape MlpSerialized')
    }
    const mlp = new MLP(data.spec)
    // Hợp đồng tensor (FB-BRAIN-P1-R1-03): trước đây (a) kind lạ rơi nhánh
    // else bị coi là bias, (b) tensor trùng khi đủ số lượng làm tensor thật
    // mất trắng — mạng "load được" mà sai âm thầm. Chặn 4 lớp thay cho
    // count-check đơn thuần: kind hợp lệ + layer nguyên trong phạm vi +
    // không trùng cặp (kind, layer) + đủ MỌI cặp W/b của mọi lớp (nhánh
    // thiếu thay cho count — mọi đường sai đều chạm 1 trong 4).
    const seen = new Set<string>()
    for (const t of data.tensors) {
      if (t.kind !== 'W' && t.kind !== 'b') {
        throw new Error(`deserialize: kind '${String(t.kind)}' không hợp lệ (W|b)`)
      }
      const l = t.layer
      if (!Number.isInteger(l) || l < 1 || l >= data.spec.layers.length) {
        throw new Error(`deserialize: layer ${String(l)} ngoài phạm vi`)
      }
      const sig = `${t.kind}${l}`
      if (seen.has(sig)) throw new Error(`deserialize: tensor trùng lặp ${sig}`)
      seen.add(sig)
      const fanIn = data.spec.layers[l - 1].units
      const fanOut = data.spec.layers[l].units
      const expectLen = t.kind === 'W' ? fanOut * fanIn : fanOut
      const expectShape = t.kind === 'W' ? [fanOut, fanIn] : [fanOut]
      if (t.envelope.dtype !== 'float64') throw new Error(`deserialize: dtype ${t.envelope.dtype}`)
      if (t.envelope.data.length !== expectLen) {
        throw new Error(`deserialize: ${t.kind}${l} cần ${expectLen} phần tử, nhận ${t.envelope.data.length}`)
      }
      if (t.envelope.shape.length !== expectShape.length || t.envelope.shape.some((s, i) => s !== expectShape[i])) {
        throw new Error(`deserialize: ${t.kind}${l} shape ${t.envelope.shape} ≠ ${expectShape}`)
      }
      const target = t.kind === 'W' ? mlp.W[l - 1] : mlp.b[l - 1]
      target.set(Float64Array.from(t.envelope.data))
    }
    for (let l = 1; l < data.spec.layers.length; l++) {
      if (!seen.has(`W${l}`)) throw new Error(`deserialize: thiếu tensor W${l}`)
      if (!seen.has(`b${l}`)) throw new Error(`deserialize: thiếu tensor b${l}`)
    }
    return mlp
  }
}

// ==================== VALIDATION ====================

const OUTPUT_OK_REGRESSION: readonly ActivationName[] = [
  'linear', 'tanh', 'relu', 'leakyRelu', 'elu', 'swish', 'gelu',
]

/**
 * Trần tổng tham số (nguyên tắc §9.1-3 blueprint: cảnh báo > 100K, CHẶN
 * > 250K — ngân sách CPU của brain MLP). Thực thi tại validateSpec — mọi
 * lối xây MLP (constructor lẫn deserialize) đều qua đây.
 */
export const BRAIN_MAX_PARAMS = 250_000

export function validateSpec(spec: MlpSpec): void {
  if (!spec || !Array.isArray(spec.layers) || spec.layers.length < 2) {
    throw new Error('validateSpec: cần ≥ 2 lớp (input + output)')
  }
  for (const l of spec.layers) {
    if (!Number.isInteger(l.units) || l.units < 1 || l.units > 4096) {
      throw new Error(`validateSpec: units ${l.units} ngoài [1, 4096]`)
    }
    if (!ACTIVATIONS[l.activation]) {
      throw new Error(`validateSpec: activation '${l.activation}' không có trong menu`)
    }
    // Tham số activation (FB-BRAIN-P1-R1-04): trước đây rác (α = −5, β = 0)
    // được constructor nhận nhưng runtime thay bằng fallback im lặng —
    // bất đối xứng với lossParams.delta vốn có kiểm. Hợp lệ = hữu hạn > 0
    // (khớp resolveAlpha/resolveBeta trong activations.ts).
    if (l.activationParams?.alpha !== undefined) {
      const a = l.activationParams.alpha
      if (!Number.isFinite(a) || a <= 0) {
        throw new Error(`validateSpec: activationParams.alpha ${a} không hợp lệ (> 0)`)
      }
    }
    if (l.activationParams?.beta !== undefined) {
      const b = l.activationParams.beta
      if (!Number.isFinite(b) || b <= 0) {
        throw new Error(`validateSpec: activationParams.beta ${b} không hợp lệ (> 0)`)
      }
    }
  }
  // Trần tổng tham số (FB-BRAIN-P1-R1-08 — §9.1-3): 2048→300→2 (615K)
  // trước đây ĐẠT validateSpec vì chỉ cản units ≤ 4096/lớp.
  let totalParams = 0
  for (let l = 1; l < spec.layers.length; l++) {
    totalParams += spec.layers[l].units * spec.layers[l - 1].units + spec.layers[l].units
  }
  if (totalParams > BRAIN_MAX_PARAMS) {
    throw new Error(
      `validateSpec: tổng tham số ${totalParams} vượt trần ${BRAIN_MAX_PARAMS} (nguyên tắc §9.1-3 — ngân sách CPU)`,
    )
  }
  const hidden = spec.layers.slice(1, -1)
  for (const h of hidden) {
    if (h.activation === 'softmax') {
      // Audit B1 — softmax không giữ tổng xác suất ở lớp ẩn, gradient lệch
      throw new Error('validateSpec: softmax CHỈ dùng cho lớp output đa lớp (audit B1)')
    }
  }
  const out = spec.layers[spec.layers.length - 1]
  const inL = spec.layers[0]
  if (inL.activation === 'softmax') {
    throw new Error('validateSpec: lớp input không có activation (softmax vô nghĩa)')
  }
  switch (spec.loss) {
    case 'bce':
      if (out.activation !== 'sigmoid') {
        throw new Error("validateSpec: loss 'bce' yêu cầu output activation 'sigmoid'")
      }
      break
    case 'crossEntropy':
      if (out.activation !== 'softmax' || out.units < 2) {
        throw new Error("validateSpec: loss 'crossEntropy' yêu cầu output 'softmax' ≥ 2 unit (audit B1)")
      }
      break
    case 'mse':
    case 'huber':
      if (!OUTPUT_OK_REGRESSION.includes(out.activation)) {
        throw new Error(`validateSpec: loss '${spec.loss}' yêu cầu output tuyến tính/relu-family (nhận '${out.activation}')`)
      }
      break
    default:
      throw new Error(`validateSpec: loss '${String(spec.loss)}' không có trong menu`)
  }
  if (!['sgd', 'adam'].includes(spec.optimizer)) {
    throw new Error(`validateSpec: optimizer '${String(spec.optimizer)}' không hợp lệ`)
  }
  if (!Number.isFinite(spec.lr) || spec.lr <= 0) throw new Error(`validateSpec: lr ${spec.lr} không hợp lệ`)
  if (!Number.isFinite(spec.l2) || spec.l2 < 0) throw new Error(`validateSpec: l2 ${spec.l2} không hợp lệ`)
  if (spec.lossParams?.delta !== undefined) {
    const d = spec.lossParams.delta
    if (!Number.isFinite(d) || d <= 0) throw new Error(`validateSpec: lossParams.delta ${d} không hợp lệ`)
  }
  if (!Number.isInteger(spec.seed)) throw new Error(`validateSpec: seed ${spec.seed} phải là số nguyên`)
}

// ==================== HELPERS ====================

/** Fisher–Yates tất định (blueprint §4.1) — đảo chỗ trong-place theo rng. */
function fisherYates(arr: number[], rng: () => number): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    const t = arr[i]
    arr[i] = arr[j]
    arr[j] = t
  }
}

/** Clip chuẩn toàn cục: chuẩn L2 gộp mọi tensor vượt ngưỡng → co tỉ lệ. */
function clipGlobalNorm(dW: Float64Array[], db: Float64Array[], clipNorm: number): void {
  let sq = 0
  for (const t of dW) for (let i = 0; i < t.length; i++) sq += t[i] * t[i]
  for (const t of db) for (let i = 0; i < t.length; i++) sq += t[i] * t[i]
  const norm = Math.sqrt(sq)
  if (norm > clipNorm && norm > 0) {
    const scale = clipNorm / norm
    for (const t of dW) for (let i = 0; i < t.length; i++) t[i] *= scale
    for (const t of db) for (let i = 0; i < t.length; i++) t[i] *= scale
  }
}

function meanLoss(
  mlp: MLP,
  X: readonly (readonly number[])[],
  y: readonly (readonly number[])[],
  idx: readonly number[],
): number {
  let s = 0
  for (const i of idx) s += mlp.lossOf(X[i], y[i])
  return s / idx.length
}

function cloneSpec(spec: MlpSpec): MlpSpec {
  return JSON.parse(JSON.stringify(spec)) as MlpSpec
}
