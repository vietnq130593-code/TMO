/**
 * EVO-P0 (BLUEPRINT-EVO-NAO-P1-P5 §0.1/§4/§10 Q1) — BENCHMARK TẤT ĐỊNH
 * ============================================================================
 *
 * "Sân đo chung" của mọi ứng viên EVO trên CÙNG dữ liệu fixture — Q1 chốt
 * "fixtures tất định tái lập từ snapshot dữ liệu thật từng não + báo cáo
 * kèm dataFingerprint (đúng convention HN) — không phát sinh dữ liệu fake".
 *
 * Fixture commit sẵn (build bởi scratch/r24c-build-fixtures.ts từ backup R2
 * — DỮ LIỆU THẬT trước reset, feature builder THẬT của từng pipeline):
 *   fixtures/calibration_v3.json (n=4) · fixtures/surrogate.json (n=13) ·
 *   fixtures/policy.json (n=31). Refresh trên máy user: chạy lại script.
 *
 * GIAO THỨC CHẤM (thống nhất mọi ứng viên + baseline — công bằng §0.1):
 *   - CV folds = min(5, n) — gán fold tất định i % folds (không shuffle).
 *   - MỖI fold: chuẩn hóa X theo stats fold TRAIN (null → 0 = impute mean,
 *     đúng kỷ luật V2/V3 — không rò hold-out) → train → loss hold-out.
 *   - meanLoss = trung bình loss các fold; **cvScore = 1/(1+meanLoss) —
 *     higher-better** (UI §5.3 sort desc, Pareto max — loãng nghịch lý
 *     Brier-lower-better giữa các brain).
 *   - CI 95%: bootstrap fold-loss (seeded, 200 replicate — percentile).
 *   - p95LatencyMs: đo wall-clock forward từng mẫu fold hold-out của fold
 *     CUỐI (đo VẬN HÀNH, không tất định bit — H4 áp cho train/seed).
 *
 * Mạng EVO (ghép block engine §4.3 + head MLP từ draft HN-P1):
 *   input → toSequence(headDim) → blocks tuần tự → flatten → hidden dense
 *   (draft.hidden) → output per-unit activation (bce→sigmoid · CE head →
 *   softmax nhóm · huber/mse → linear).
 *
 * BẤT BIẾN: H1 (không đụng runtime) · H4 (makeRng — không Math.random) ·
 * H6 (không lưu weights). Thuần — KHÔNG import db (client-safe + bun:test).
 */

import { readFileSync } from 'fs'
import path from 'path'
import { makeRng } from '../init'
import { LOSSES, sampleLoss, l2WeightGrad, type LossName } from '../losses'
import { createOptimizer } from '../optimizers'
import { EvoDense } from './dense'
import {
  buildEvoBlock,
  toSequence,
  flattenSeq,
  type EvoBlock,
  type EvoBlockSpec,
} from './blocks'

// ==================== FIXTURE ====================

export interface EvoFixture {
  brain: string
  version: 1
  nSamples: number
  inputDim: number
  outputDim: number
  featureNames: string[]
  outputNames: string[]
  lossHeads: Array<{ type: LossName; weight: number }>
  /** Số unit mỗi loss head chiếm (tổng = outputDim; CE head = softmax nhóm). */
  headSpans: number[]
  X: (number | null)[][]
  y: number[][]
  dataFingerprint: string
  sourceLabel: string
  builtFrom: string
  builtAt: string
}

/** Cache fixture theo brain (đọc đĩa 1 lần/process). */
const fixtureCache = new Map<string, EvoFixture>()

/** Đọc fixture commit — throw lỗi rõ ràng khi thiếu/hỏng (caller fail-open). */
export function loadEvoFixture(brain: string): EvoFixture {
  const hit = fixtureCache.get(brain)
  if (hit) return hit
  const file = path.join(process.cwd(), 'src', 'lib', 'brain', 'evo', 'fixtures', `${brain}.json`)
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    throw new Error(`loadEvoFixture: không đọc được fixture '${brain}' (${file}) — chạy scratch/r24c-build-fixtures.ts để tạo`)
  }
  const fx = JSON.parse(raw) as EvoFixture
  if (!fx || fx.brain !== brain || !Array.isArray(fx.X) || fx.X.length !== fx.nSamples) {
    throw new Error(`loadEvoFixture: fixture '${brain}' hỏng cấu trúc`)
  }
  fixtureCache.set(brain, fx)
  return fx
}

// ==================== ỨNG VIÊN (spec decode từ encoding 144 — search-space.ts) ====================

/** Spec MLP head (từ draft HN-P1 [0..95] — hidden của BrainDraftSpec). */
export interface EvoHeadSpec {
  hidden: Array<{ units: number; activation: string }>
  hyper: { lr: number; l2: number; epochs: number; batch: number; patience: number }
}

/** Ứng viên EVO đầy đủ — decodeEvoCandidate (search-space.ts) trả shape này. */
export interface EvoCandidateSpec {
  head: EvoHeadSpec
  blocks: EvoBlockSpec[]
  /** headDim MẠNG (chuẩn hoá repair — mọi block dùng chung). */
  headDim: number
  moeGlobal?: { kExperts: number; routerTemp: number; auxWeight: number }
}

// ==================== MẠNG EVO ====================

/** Phạm vi bias trong buffer phẳng (L2 bỏ qua bias — chuẩn mlp.ts §4.1). */
interface BiasRange { start: number; end: number }

export class EvoNet {
  readonly blocks: EvoBlock[]
  readonly headDenses: EvoDense[]
  readonly outDense: EvoDense
  readonly params: Float64Array
  readonly grads: Float64Array
  readonly biasRanges: BiasRange[] = []
  readonly headDim: number
  readonly moeSkipped: boolean
  private readonly headSpecs: Array<{ type: LossName; weight: number; offset: number; size: number }>
  private lastFlat: number[] | null = null
  private lastPred: number[] | null = null

  constructor(
    spec: EvoCandidateSpec,
    inputDim: number,
    outputDim: number,
    lossHeads: Array<{ type: LossName; weight: number }>,
    headSpans: number[],
    seed: number,
    ctx?: { nSamples?: number },
  ) {
    this.headDim = Math.max(1, Math.min(128, Math.round(spec.headDim || 64)))
    // Build blocks (moe < MOE_MIN_SAMPLES → identity + moeSkipped — Q4)
    const built = spec.blocks.map(b => buildEvoBlock(b, this.headDim, ctx))
    this.blocks = built.map(b => b.block)
    this.moeSkipped = built.some(b => b.moeSkipped)
    // Head MLP: hidden theo draft → output (activation per-unit — xem forward)
    let inDim: number
    if (this.blocks.length > 0) {
      // flatten sau blocks: chiều = L·d với L = ceil(inputDim / headDim)
      const L = Math.max(1, Math.ceil(inputDim / this.headDim))
      inDim = L * this.headDim
    } else {
      inDim = inputDim
    }
    this.headDenses = spec.head.hidden.map(h => {
      const d = new EvoDense(inDim, h.units, (h.activation as never) || 'tanh', 'xavier')
      inDim = h.units
      return d
    })
    this.outDense = new EvoDense(inDim, outputDim, 'none', 'xavier')
    // Buffer phẳng duy nhất
    let total = 0
    for (const b of this.blocks) total += b.paramCount
    for (const d of this.headDenses) total += d.paramCount
    total += this.outDense.paramCount
    this.params = new Float64Array(total)
    this.grads = new Float64Array(total)
    // Attach + init tất định
    const rng = makeRng(seed)
    let off = 0
    for (let i = 0; i < this.blocks.length; i++) {
      this.blocks[i].attach(this.params, this.grads, off)
      this.blocks[i].initParams(rng)
      off += this.blocks[i].paramCount
    }
    for (const d of this.headDenses) {
      d.attach(this.params, this.grads, off)
      d.initParams(rng)
      this.biasRanges.push({ start: off + d.paramCount - d.outDim, end: off + d.paramCount })
      off += d.paramCount
    }
    this.outDense.attach(this.params, this.grads, off)
    this.outDense.initParams(rng)
    this.biasRanges.push({ start: off + this.outDense.paramCount - this.outDense.outDim, end: off + this.outDense.paramCount })
    // Map head loss → offset/size
    this.headSpecs = lossHeads.map((h, i) => ({
      type: h.type,
      weight: h.weight,
      offset: headSpans.slice(0, i).reduce((s, v) => s + v, 0),
      size: headSpans[i],
    }))
  }

  get paramCount(): number {
    return this.params.length
  }

  /** Aux loss MoE chuỗi forward gần nhất (tổng các block moe). */
  private moeAuxLoss(): number {
    let s = 0
    for (const b of this.blocks) if (b.spec.type === 'moe') s += (b as { lastAuxLoss?: number }).lastAuxLoss ?? 0
    return s
  }

  /** Forward 1 mẫu → vector outputDim (SAU activation per-unit). */
  forward(x: readonly number[]): number[] {
    let seq = toSequence(x, this.headDim)
    for (const b of this.blocks) seq = b.forwardSeq(seq)
    const flat = flattenSeq(seq)
    this.lastFlat = flat
    let h: number[] = flat
    for (const d of this.headDenses) h = d.forward(h)
    const z = this.outDense.forward(h)
    return this.applyOutputActs(z)
  }

  /** Activation per-unit theo head: bce→sigmoid · CE→softmax nhóm · khác → linear. */
  private applyOutputActs(z: readonly number[]): number[] {
    const out = new Array<number>(z.length).fill(0)
    for (const hs of this.headSpecs) {
      if (hs.type === 'crossEntropy') {
        // softmax nhóm
        let maxZ = -Infinity
        for (let j = hs.offset; j < hs.offset + hs.size; j++) if (z[j] > maxZ) maxZ = z[j]
        let den = 0
        for (let j = hs.offset; j < hs.offset + hs.size; j++) {
          const e = Math.exp(z[j] - maxZ)
          out[j] = e
          den += e
        }
        for (let j = hs.offset; j < hs.offset + hs.size; j++) out[j] /= den
      } else if (hs.type === 'bce') {
        for (let j = hs.offset; j < hs.offset + hs.size; j++) out[j] = 1 / (1 + Math.exp(-z[j]))
      } else {
        for (let j = hs.offset; j < hs.offset + hs.size; j++) out[j] = z[j]
      }
    }
    return out
  }

  /** Forward + loss (cache pred cho backward). */
  forwardLoss(x: readonly number[], y: readonly number[]): { pred: number[]; loss: number } {
    const pred = this.forward(x)
    this.lastPred = pred
    let loss = 0
    for (const hs of this.headSpecs) {
      const p = pred.slice(hs.offset, hs.offset + hs.size)
      const t = Array.from(y.slice(hs.offset, hs.offset + hs.size))
      loss += hs.weight * sampleLoss(hs.type, p, t)
    }
    loss += this.moeAuxLoss()
    return { pred, loss }
  }

  /** Backward từ (pred, y) — dZ analytic theo cặp activation+loss chuẩn. */
  backwardFromLoss(y: readonly number[]): void {
    const pred = this.lastPred as number[]
    const dZ = new Array<number>(pred.length).fill(0)
    for (const hs of this.headSpecs) {
      for (let j = hs.offset; j < hs.offset + hs.size; j++) {
        const p = pred[j]
        const t = y[j]
        if (hs.type === 'crossEntropy') {
          // softmax + CE: δ = w·(p − y) (mlp.ts precedent — losses.ts ghi chú)
          dZ[j] += hs.weight * (p - t)
        } else if (hs.type === 'bce') {
          // sigmoid + BCE: δ = w·(p − y) / size (sampleLoss mean theo size)
          dZ[j] += (hs.weight * (p - t)) / hs.size
        } else {
          // linear + huber/mse: δ = w·deriv(p,y) / size
          dZ[j] += (hs.weight * LOSSES[hs.type].deriv(p, t)) / hs.size
        }
      }
    }
    // Backward head: outDense (cache từ replayForwardChain) → headDenses ngược → flatten
    this.replayForwardChain()
    const dFlat = this.outDense.backward(dZ)
    let d: number[] = dFlat
    for (let i = this.headDenses.length - 1; i >= 0; i--) {
      d = this.headDenses[i].backward(d)
    }
    // d → sequence grads → blocks ngược
    const L = Math.max(1, Math.ceil(this.lastFlat!.length / this.headDim))
    const gradSeq: Float64Array[] = []
    for (let t = 0; t < L; t++) {
      const tok = new Float64Array(this.headDim)
      for (let i = 0; i < this.headDim; i++) {
        const idx = t * this.headDim + i
        if (idx < d.length) tok[i] = d[idx]
      }
      gradSeq.push(tok)
    }
    let gs: Float64Array[] = gradSeq
    for (let i = this.blocks.length - 1; i >= 0; i--) {
      gs = this.blocks[i].backwardSeq(gs)
    }
  }

  /** Nạp lại cache Dense cho backward (forward thuần xác định — không đổi trạng thái). */
  private replayForwardChain(): void {
    const flat = this.lastFlat as number[]
    let h: number[] = flat
    for (const d of this.headDenses) h = d.forward(h)
    this.outDense.forward(h)
  }
}

// ==================== TRAINER (mini-batch Adam + early-stop + clip) ====================

export interface EvoFitOptions {
  epochs?: number
  batch?: number
  patience?: number
  holdOutRatio?: number
  clipNorm?: number
  lr?: number
  l2?: number
}

export interface EvoFitResult {
  epochsRun: number
  bestEpoch: number
  bestLoss: number
  stoppedEarly: boolean
}

/**
 * Train EvoNet — giao thức gương mlp.ts: mini-batch Adam, hold-out 15%
 * (n ≥ 4), early-stop patience, clip gradient toàn cục, L2 bỏ bias.
 * Tất định: thứ tự batch từ makeRng(seed).
 */
export function fitEvoNet(
  net: EvoNet,
  X: readonly number[][],
  y: readonly number[][],
  opts: EvoFitOptions = {},
  seed = 42,
): EvoFitResult {
  const n = X.length
  if (n === 0) return { epochsRun: 0, bestEpoch: 0, bestLoss: 0, stoppedEarly: false }
  const epochs = Math.max(1, Math.min(2000, Math.round(opts.epochs ?? 300)))
  const batchSize = Math.max(1, Math.min(n, Math.round(opts.batch ?? 32)))
  const patience = Math.max(0, Math.round(opts.patience ?? 30))
  const holdOutRatio = typeof opts.holdOutRatio === 'number' ? Math.min(0.5, Math.max(0, opts.holdOutRatio)) : 0.15
  const clipNorm = opts.clipNorm ?? 5
  const rng = makeRng(seed)

  // Hold-out tất định (shuffle seeded) — n ≥ 4 mới tách
  const idxAll = Array.from({ length: n }, (_, i) => i)
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[idxAll[i], idxAll[j]] = [idxAll[j], idxAll[i]]
  }
  const nHold = n >= 4 ? Math.max(1, Math.round(n * holdOutRatio)) : 0
  const holdIdx = idxAll.slice(0, nHold)
  const trainIdx = idxAll.slice(nHold)

  const evalLoss = (rows: readonly number[]): number => {
    if (rows.length === 0) return 0
    let s = 0
    for (const i of rows) s += net.forwardLoss(X[i], y[i]).loss
    return s / rows.length
  }

  const opt = createOptimizer('adam', opts.lr ?? 0.01)
  let bestLoss = evalLoss(holdIdx.length > 0 ? holdIdx : trainIdx)
  let bestEpoch = 0
  let stale = 0
  let epochsRun = 0
  const snapshotBest = Float64Array.from(net.params)
  for (let ep = 1; ep <= epochs; ep++) {
    epochsRun = ep
    // shuffle train mỗi epoch (seeded)
    const order = [...trainIdx]
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1))
      ;[order[i], order[j]] = [order[j], order[i]]
    }
    for (let bStart = 0; bStart < order.length; bStart += batchSize) {
      const batch = order.slice(bStart, bStart + batchSize)
      if (batch.length === 0) continue
      net.grads.fill(0)
      for (const i of batch) {
        net.forwardLoss(X[i], y[i])
        net.backwardFromLoss(y[i])
      }
      // scale + L2 (bỏ bias) + clip
      const inv = 1 / batch.length
      let sq = 0
      for (let k = 0; k < net.grads.length; k++) net.grads[k] *= inv
      if ((opts.l2 ?? 0) > 0) {
        for (let k = 0; k < net.grads.length; k++) {
          if (!isBias(net.biasRanges, k)) net.grads[k] += l2WeightGrad(opts.l2 as number, net.params[k])
        }
      }
      for (let k = 0; k < net.grads.length; k++) sq += net.grads[k] * net.grads[k]
      const norm = Math.sqrt(sq)
      if (clipNorm > 0 && norm > clipNorm) {
        const s = clipNorm / norm
        for (let k = 0; k < net.grads.length; k++) net.grads[k] *= s
      }
      opt.step(net.params, net.grads)
    }
    const vLoss = evalLoss(holdIdx.length > 0 ? holdIdx : trainIdx)
    if (vLoss < bestLoss) {
      bestLoss = vLoss
      bestEpoch = ep
      stale = 0
      snapshotBest.set(net.params)
    } else {
      stale++
      if (patience > 0 && stale >= patience) break
    }
  }
  net.params.set(snapshotBest) // khôi phục bản tốt nhất (chuẩn early-stop)
  return { epochsRun, bestEpoch, bestLoss, stoppedEarly: stale >= patience }
}

function isBias(ranges: readonly BiasRange[], k: number): boolean {
  for (const r of ranges) if (k >= r.start && k < r.end) return true
  return false
}

// ==================== CHUẨN HÓA X (per fold-train — không rò hold-out) ====================

function standardize(
  rows: readonly (number | null)[][],
  stats: { means: number[]; stds: number[] },
): number[][] {
  return rows.map(r => r.map((v, j) => (typeof v === 'number' && Number.isFinite(v) ? (v - stats.means[j]) / stats.stds[j] : 0)))
}

function computeStats(rows: readonly (number | null)[][]): { means: number[]; stds: number[] } {
  const d = rows[0]?.length ?? 0
  const means = new Array<number>(d).fill(0)
  const stds = new Array<number>(d).fill(1)
  if (rows.length === 0) return { means, stds }
  for (let j = 0; j < d; j++) {
    let s = 0
    let c = 0
    for (const r of rows) {
      const v = r[j]
      if (typeof v === 'number' && Number.isFinite(v)) {
        s += v
        c++
      }
    }
    const m = c > 0 ? s / c : 0
    let acc = 0
    for (const r of rows) {
      const v = r[j]
      if (typeof v === 'number' && Number.isFinite(v)) acc += (v - m) * (v - m)
    }
    const sd = c > 1 ? Math.sqrt(acc / c) : 1
    means[j] = m
    stds[j] = sd > 1e-8 ? sd : 1
  }
  return { means, stds }
}

// ==================== SCORING (giao thức thống nhất — mọi ứng viên + baseline) ====================

export interface EvoScoreResult {
  /** 1/(1+meanFoldLoss) — higher-better (§5.3 sort desc). */
  cvScore: number
  ciLow: number
  ciHigh: number
  meanLoss: number
  foldLosses: number[]
  params: number
  trainMs: number
  p95LatencyMs: number
  moeSkipped: boolean
}

/** Số fold CV — min(5, n) (fixture mỏng vẫn chấm được — trung thực số mẫu). */
export function evoFolds(n: number): number {
  return Math.max(1, Math.min(5, n))
}

/** Bootstrap CI fold-loss (seeded — tất định H4). */
function bootstrapCi(foldLosses: number[], seed: number): { lo: number; hi: number } {
  if (foldLosses.length < 2) {
    return { lo: foldLosses[0] ?? 0, hi: foldLosses[0] ?? 0 }
  }
  const rng = makeRng(seed)
  const reps: number[] = []
  for (let r = 0; r < 200; r++) {
    let s = 0
    for (let i = 0; i < foldLosses.length; i++) s += foldLosses[Math.floor(rng() * foldLosses.length)]
    reps.push(s / foldLosses.length)
  }
  reps.sort((a, b) => a - b)
  return { lo: reps[4], hi: reps[195] } // percentile 2.5/97.5
}

/**
 * Chấm 1 ứng viên trên fixture — TẤT ĐỊNH theo (spec, seed): cùng spec +
 * cùng seed → cùng cvScore bit-đối-bít (H4 — r105 pin).
 */
export function scoreEvoCandidate(
  spec: EvoCandidateSpec,
  fixture: EvoFixture,
  seed = 42,
): EvoScoreResult {
  const n = fixture.nSamples
  const folds = evoFolds(n)
  const foldLosses: number[] = []
  const t0 = Date.now()
  let net: EvoNet | null = null
  let moeSkipped = false
  const latencies: number[] = []
  for (let f = 0; f < folds; f++) {
    const trainRows: number[] = []
    const holdRows: number[] = []
    for (let i = 0; i < n; i++) (i % folds === f ? holdRows : trainRows).push(i)
    // fold cuối giữ nguyên khi trống (n=1) — train trên chính nó (thông báo qua folds)
    const trRows = trainRows.length > 0 ? trainRows : holdRows
    const stats = computeStats(trRows.map(i => fixture.X[i]))
    const Xtr = standardize(trRows.map(i => fixture.X[i]), stats)
    const ytr = trRows.map(i => fixture.y[i])
    const Xho = standardize(holdRows.map(i => fixture.X[i]), stats)
    const yho = holdRows.map(i => fixture.y[i])
    net = new EvoNet(
      spec, fixture.inputDim, fixture.outputDim,
      fixture.lossHeads, fixture.headSpans,
      seed + f, { nSamples: n },
    )
    moeSkipped = moeSkipped || net.moeSkipped
    fitEvoNet(net, Xtr, ytr, {
      epochs: spec.head.hyper.epochs,
      batch: spec.head.hyper.batch,
      patience: spec.head.hyper.patience,
      lr: spec.head.hyper.lr,
      l2: spec.head.hyper.l2,
    }, seed + f)
    let s = 0
    for (let k = 0; k < Xho.length; k++) {
      const t1 = performance.now()
      const { loss } = net.forwardLoss(Xho[k], yho[k])
      latencies.push(performance.now() - t1)
      s += loss
    }
    foldLosses.push(Xho.length > 0 ? s / Xho.length : 0)
  }
  const trainMs = Date.now() - t0
  const meanLoss = foldLosses.reduce((a, b) => a + b, 0) / foldLosses.length
  const ci = bootstrapCi(foldLosses, seed)
  latencies.sort((a, b) => a - b)
  const p95 = latencies.length > 0 ? latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * 0.95))] : 0
  return {
    cvScore: 1 / (1 + Math.max(0, meanLoss)),
    ciLow: 1 / (1 + Math.max(0, ci.hi)), // loss cao ↔ score thấp — đảo CI
    ciHigh: 1 / (1 + Math.max(0, ci.lo)),
    meanLoss,
    foldLosses,
    params: net?.paramCount ?? 0,
    trainMs,
    p95LatencyMs: p95,
    moeSkipped,
  }
}

// ==================== BASELINE ĐỐI CHỨNG (A1 — "heuristic majority cho bản đầu") ====================

export interface EvoBaselineResult {
  kind: 'heuristic'
  cvScore: number
  meanLoss: number
  description: string
}

/**
 * Baseline heuristic CỨNG trên CÙNG fixture + CÙNG giao thức fold:
 *  - bce: dự đoán tỷ lệ lớp dương fold-train (base-rate).
 *  - huber/mse: dự đoán trung bình fold-train.
 *  - crossEntropy: phân bố đều 1/E.
 * Không học gì — "heuristic majority" đúng tinh thần A1 bản đầu.
 */
export function scoreEvoBaseline(fixture: EvoFixture): EvoBaselineResult {
  const n = fixture.nSamples
  const folds = evoFolds(n)
  const foldLosses: number[] = []
  for (let f = 0; f < folds; f++) {
    const trainRows: number[] = []
    const holdRows: number[] = []
    for (let i = 0; i < n; i++) (i % folds === f ? holdRows : trainRows).push(i)
    const tr = trainRows.length > 0 ? trainRows : holdRows
    let s = 0
    for (const i of holdRows) {
      let loss = 0
      for (const hs of fixture.lossHeads.map((h, hi) => ({
        ...h,
        offset: fixture.headSpans.slice(0, hi).reduce((a, b) => a + b, 0),
        size: fixture.headSpans[hi],
      }))) {
        const p: number[] = []
        for (let j = 0; j < hs.size; j++) {
          if (hs.type === 'bce') {
            let pos = 0
            for (const t of tr) pos += fixture.y[t][hs.offset + j]
            p.push(Math.min(1 - 1e-7, Math.max(1e-7, pos / tr.length)))
          } else if (hs.type === 'crossEntropy') {
            p.push(1 / hs.size)
          } else {
            let m = 0
            for (const t of tr) m += fixture.y[t][hs.offset + j]
            p.push(m / tr.length)
          }
        }
        loss += hs.weight * sampleLoss(hs.type, p, fixture.y[i].slice(hs.offset, hs.offset + hs.size))
      }
      s += loss
    }
    foldLosses.push(holdRows.length > 0 ? s / holdRows.length : 0)
  }
  const meanLoss = foldLosses.reduce((a, b) => a + b, 0) / foldLosses.length
  return {
    kind: 'heuristic',
    cvScore: 1 / (1 + Math.max(0, meanLoss)),
    meanLoss,
    description: 'Heuristic CỨNG (base-rate/mean/uniform — không học) trên cùng fixture + cùng fold',
  }
}
