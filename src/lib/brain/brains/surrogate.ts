/**
 * BRAIN-P3 · BRAIN-B "Vọng" — SURROGATE PREDICTOR + REPLAY-EVAL (blueprint §4.3)
 * ============================================================================
 *
 * Não thứ hai của panel "Não vận hành": dự đoán kết quả của một CẤU HÌNH
 * (model, agent, delegated) KHÔNG CẦN CHẠY THẬT — bước leo Level 2 của khung
 * thẩm định ("từ 'mỗi ứng viên phải thực thi trực tiếp' sang 'đánh giá hàng
 * nghìn cấu hình trên replay'").
 *
 * KIẾN TRÚC — 3 MLP ĐẦU RA RIÊNG (quyết định triển khai theo phương án
 * "3 model riêng" mà blueprint §4.3 cho phép — mỗi đầu ra 1 spec riêng):
 *   - success   : D→16(tanh)→1(sigmoid) + BCE   — P(run complete)
 *   - tokens    : D→16(tanh)→1(linear)  + Huber — E[tokens] (log1p space)
 *   - durationMs: D→16(tanh)→1(linear)  + Huber — E[durationMs] (log1p space)
 * Lý do tách (không gộp 1 mạng 3 đầu ra): nền toán BRAIN-P1 (mlp.ts) gắn
 * MỘT loss cho cả mạng — gộp sẽ ép đồng nhất BCE/Huber hoặc phải sửa mlp.ts
 * (đụng nền toán đã fixbug). Tokens/latency lệch mạnh (đo live 2026-10-11:
 * tokensUsed median 0 / max 169.567) → hồi quy trong log1p space + Huber
 * chống văng outlier; đầu ra back-transform expm1() khi báo cáo.
 *
 * ĐẶC TRƯNG (inputMode 'runs-features' — phase này; mode vector pca-128/
 * mrl-512/full-2048 chờ quyết định mở Q2 blueprint §3.2, từ chối rõ ràng):
 *   [model one-hot K chiều] + [agent one-hot A chiều] + [delegated 1 chiều]
 * MỌI đặc trưng có sẵn TRƯỚC khi run bắt đầu (model cấu hình, agent chạy,
 * có phải delegation) — KỶ LUẬT CHỐNG RÒ NHÃN tuyệt đối: cycles/tokensUsed/
 * toolCalls/toolFailures/durationMs là KẾT QUẢ (đầu ra cần dự đoán), không
 * bao giờ được làm đầu vào. Vocab model/agent học từ dữ liệu train, lưu trong
 * specJson; model lạ lúc replay → one-hot toàn 0 (impute qua chuẩn hóa).
 *
 * GATE THĂNG CẤP (kỷ luật kế thừa nguyên vẹn V2/V3 — "đo trước đổi sau"):
 * 5-fold CV stratified (fold gán theo nhãn success, CHIA CHUNG 3 đầu để so
 * sánh sạch từng cặp hold-out) → đầu ra success phải thắng NGẶT baseline
 * base-rate (cvBrier < brierBaseline) mới được active=true. Baseline đối
 * chứng từng fold: success = base-rate tập train-fold; tokens/duration =
 * median log1p tập train-fold — mọi baseline tính CHỈ trên 4 fold train
 * (không rò rỉ hold-out). Đầu ra thua CV → KHÔNG báo cáo ước lượng MLP của
 * đầu đó trong replay (per-head fail-open — consumer đọc nhánh history).
 *
 * RUNTIME/REPLAY (POST /api/brain/replay — blueprint §4.3): READ-ONLY tuyệt
 * đối (chỉ SELECT; r86 pin). Cờ `replay_eval` (STORE > ENV > DEFAULT=off —
 * tuning store) chỉ mở phần ước lượng MLP trong BÁO CÁO replay; cờ off =
 * báo cáo thuần đo lường lịch sử (bootstrap CI). Replay KHÔNG bao giờ ghi
 * DB, không tự thay quyết định — Consumer quyết định (model-comparison,
 * Q-advice bootstrap, sweep) là việc P4.
 *
 * Ghi DB: bảng BrainModel (brain='surrogate' — không migration mới):
 *   - specJson  : SurrogateSpecDoc { inputMode, vocab{models,agents},
 *                  heads{success,tokens,durationMs: MlpSpec} }
 *   - weightsJson: { heads: { success/tokens/durationMs: MlpSerialized } }
 *                  (envelope numpy-đọc-được audit A6 giữ NGUYÊN từng head)
 *   - trainMetaJson: nSamples, heads CV (Brier/AUC/MAE + CI), standardization
 *                  (stds FULL precision — bài học FB-BRAIN-P2-R1-01),
 *                  targetStats, baselines, dataLineage §5.3
 *
 * Bất biến giữ nguyên từ P2: A1 (1 active mỗi brain — updateMany tắt cũ trước
 * khi ghi active mới, không $transaction BUG2-119) · A2 prune (active + 5 bản
 * mới nhất) · A7 single-flight lock (train-lock.ts — từ P3 có thêm nguồn
 * trigger auto-train sau agent run) · tất định theo seed (cùng dữ liệu →
 * cùng weights bit-đối-bit — r86 pin) · orderBy createdAt asc TIE-BREAK id
 * asc (bài học flaky FB-BRAIN-P2-R2-02).
 */

import { createHash } from 'node:crypto'
import { db } from '@/lib/db'
import { MLP, type MlpSerialized, type MlpSpec, type FitResult, type FitOptions, type EpochStat } from '../mlp'
import { lossScalePerHead, type BrainDraftSpec } from '../spec-schema'
import { makeRng } from '../init'
import { acquireTrainLock, releaseTrainLock } from '../train-lock'
import { BRAIN_VERSIONS_KEEP } from '../registry'
import {
  computeColumnStats,
  stratifiedFoldAssignments,
} from '@/lib/calibration-multifeature'
import { meanCI, quantile, wilsonCI, sweepThresholds, aucRoc } from '@/lib/stats'
import { getTuningEnum } from '@/lib/learning/tuning-store'

// ==================== CONFIG ====================

/**
 * Số mẫu usable tối thiểu để train Brain-B — blueprint §2: "Brain-B cần
 * ≥ 60 (đối chứng bootstrap CI)" (đo live 2026-10-11: AgentRunRecord = 20
 * → đang NGỦ — đúng thiết kế thức tỉnh theo ngưỡng).
 */
export const SURROGATE_MIN_TRAIN_SAMPLES = 60

/**
 * Số mẫu để replay TIN ước lượng MLP của bản active (2/3 ngưỡng train —
 * cùng tỉ lệ MIN_RUNTIME_SAMPLES_V3/MIN_TRAIN_SAMPLES_V3 = 20/30 của P2).
 */
export const SURROGATE_MIN_RUNTIME_SAMPLES = 40

/** Mode đầu vào duy nhất của phase này (mode vector chờ Q2 — xem header) */
export const SURROGATE_INPUT_MODE = 'runs-features'

/** Kiểm tra inputMode hợp lệ của Brain-B (mode lạ → lỗi rõ ràng, không im lặng) */
export function isSupportedSurrogateInputMode(mode: string): boolean {
  return mode === SURROGATE_INPUT_MODE
}

/** Seed tất định Brain-B — cùng dữ liệu → cùng weights bit-đối-bit (r86) */
export const SURROGATE_SEED = 42

/** Seed bootstrap CI của replay report (tất định — tái lập được) */
export const SURROGATE_BOOTSTRAP_SEED = 42

/** Số vòng bootstrap percentile CI (blueprint §4.3 "khoảng tin cậy bootstrap") */
export const SURROGATE_BOOTSTRAP_REPLICATES = 500

const SURROGATE_LR = 0.01
const SURROGATE_L2 = 0.01
const SURROGATE_EPOCHS = 500
const SURROGATE_PATIENCE = 50
const SURROGATE_BATCH = 32
/** Số fold CV — trùng CV_FOLDS V2/V3 (5-fold stratified) */
const SURROGATE_FOLDS = 5

// ==================== VOCAB + FEATURE (thuần — test trực tiếp được) ====================

/** Vocab đặc trưng học từ dữ liệu train — lưu trong specJson (tất định: sorted) */
export interface SurrogateVocab {
  models: string[]
  agents: string[]
}

/** Bối cảnh cấu hình — MỌI trường có sẵn TRƯỚC khi run bắt đầu (chống rò nhãn) */
export interface SurrogateFeatureCtx {
  /** id model thực chạy chính của run (AgentRunRecord.model) */
  model: string
  /** tên agent (Omega / FORGE / …) — proxy "lớp nhiệm vụ" của replay config */
  agent: string | null
  /** true khi là delegation (parentRunId ≠ null) — biết ngay lúc spawn */
  delegated: boolean
}

/** Danh sách tên đặc trưng (thứ tự CHÍNH XÁC bằng buildSurrogateFeatureRow) */
export function surrogateFeatureNames(vocab: SurrogateVocab): string[] {
  return [
    ...vocab.models.map(m => `model:${m}`),
    ...vocab.agents.map(a => `agent:${a}`),
    'delegated',
  ]
}

/** Dựng vocab từ danh sách ctx (sorted unique — tất định) */
export function buildSurrogateVocab(ctxs: readonly SurrogateFeatureCtx[]): SurrogateVocab {
  return {
    models: [...new Set(ctxs.map(c => c.model))].sort(),
    agents: [...new Set(ctxs.map(c => c.agent).filter((a): a is string => typeof a === 'string'))].sort(),
  }
}

/**
 * Dựng 1 hàng đặc trưng: model one-hot + agent one-hot + delegated.
 * Model/agent không có trong vocab (lạ) → khối one-hot toàn 0 — giá trị 0
 * là NUMBER nên chuẩn hóa thành (0−mean)/std, KHÔNG phải "impute về mean"
 * (nhánh về-mean chỉ dành cho null/không-hữu-hạn — FB-BRAIN-P3-R1-10 sửa
 * doc cũ mô tả sai cơ chế). Hợp đồng rõ ràng, không throw.
 * Thuần — không đụng DB.
 */
export function buildSurrogateFeatureRow(
  ctx: SurrogateFeatureCtx,
  vocab: SurrogateVocab,
): (number | null)[] {
  const row: (number | null)[] = []
  for (const m of vocab.models) row.push(ctx.model === m ? 1 : 0)
  for (const a of vocab.agents) row.push(ctx.agent === a ? 1 : 0)
  row.push(ctx.delegated ? 1 : 0)
  return row
}

// ==================== TARGET (log1p space) ====================

/** log1p cho tokens/duration (đơn vị gốc có thể 0 → log1p(0)=0 hợp lệ) */
export function toLogSpace(v: number): number {
  return Math.log1p(Math.max(0, v))
}

/** Back-transform về đơn vị gốc (kẹp ≥ 0 — expm1(x<0) ∈ (−1,0) vô nghĩa) */
export function fromLogSpace(v: number): number {
  return Math.max(0, Math.expm1(v))
}

/** Stats chuẩn hóa target hồi quy (tập train): std suy biến → 1 (giữ mean) */
function targetStats(values: number[]): { mean: number; std: number } {
  if (values.length === 0) return { mean: 0, std: 1 }
  const m = values.reduce((s, v) => s + v, 0) / values.length
  let acc = 0
  for (const v of values) acc += (v - m) * (v - m)
  const sd = Math.sqrt(acc / values.length)
  return { mean: m, std: sd < 1e-12 ? 1 : sd }
}

// ==================== SPECS (3 đầu ra riêng) ====================

/**
 * Xây 3 MlpSpec của Brain-B theo D = vocab.models + vocab.agents + 1.
 * Thuần, xuất cho test pin kiến trúc (r86-A).
 * BRAIN-UX §9.2/§9.3 — override (tùy chọn từ BrainSpecDraft): lớp ẩn dùng
 * chung cho cả 3 head + optimizer/lr/l2/seed + LOẠI LOSS 2 đầu hồi quy
 * (huber⇄mse — success khóa BCE theo hợp đồng sigmoid). Không truyền =
 * ĐÚNG spec gốc (hồi quy r88/r89 pin).
 */
export function buildSurrogateSpecs(
  vocab: SurrogateVocab,
  override?: BrainDraftSpec,
): {
  success: MlpSpec
  tokens: MlpSpec
  durationMs: MlpSpec
} {
  const d = surrogateFeatureNames(vocab).length
  const hiddenLayers: MlpSpec['layers'] = override
    ? override.hidden.map(h => ({ units: h.units, activation: h.activation }))
    : [{ units: 16, activation: 'tanh' }]
  const base = override
    ? { optimizer: override.hyper.optimizer, lr: override.hyper.lr, l2: override.hyper.l2, seed: override.hyper.seed }
    : { optimizer: 'adam' as const, lr: SURROGATE_LR, l2: SURROGATE_L2, seed: SURROGATE_SEED }
  // Loại loss 2 đầu hồi quy từ draft (đã validate ∈ {huber, mse} tại PUT
  // spec-draft); success khóa 'bce' (hợp đồng output sigmoid — §9.1-2)
  const lossTokens = override?.lossPerHead[1]?.type === 'mse' ? 'mse' : 'huber'
  const lossDur = override?.lossPerHead[2]?.type === 'mse' ? 'mse' : 'huber'
  return {
    // Lớp input: activation bị bỏ qua ở forward (hợp đồng dữ liệu) nhưng
    // validateSpec yêu cầu tên hợp lệ → 'linear' (tiền lệ V3/r84).
    success: {
      layers: [{ units: d, activation: 'linear' }, ...hiddenLayers, { units: 1, activation: 'sigmoid' }],
      loss: 'bce',
      ...base,
    },
    tokens: {
      layers: [{ units: d, activation: 'linear' }, ...hiddenLayers, { units: 1, activation: 'linear' }],
      loss: lossTokens,
      ...base,
    },
    durationMs: {
      layers: [{ units: d, activation: 'linear' }, ...hiddenLayers, { units: 1, activation: 'linear' }],
      loss: lossDur,
      ...base,
    },
  }
}

/**
 * BRAIN-UX §9.3 — FitOptions từng head từ draft. headIdx: 0=success ·
 * 1=tokens · 2=durationMs. λ chuẩn hoá Σ=1 → lossScale = λᵢ×3 (chia đều
 * cho 1.0/head = ĐÚNG hành vi trước UX-2; xem spec-schema.lossScalePerHead).
 * Không override → options gốc (holdout/clip/lossScale rơi mặc định mlp.ts).
 */
export function surrogateDraftFitOpts(
  override: BrainDraftSpec | undefined,
  headIdx: 0 | 1 | 2,
): FitOptions {
  const defaults = { epochs: SURROGATE_EPOCHS, batchSize: SURROGATE_BATCH, patience: SURROGATE_PATIENCE }
  if (!override) return { ...defaults }
  const scales = lossScalePerHead(override.lossPerHead.map(h => h.weight))
  return {
    epochs: override.hyper.epochs,
    batchSize: override.hyper.batch,
    patience: override.hyper.patience,
    holdOutRatio: override.hyper.holdout,
    clipNorm: override.hyper.clip,
    lossScale: scales[headIdx] ?? 1,
  }
}

// ==================== HANLEY–McNEIL CI CHO AUC ====================

/**
 * CI 95% xấp xỉ Hanley–McNeil cho AUC (thống kê chuẩn, không phụ thuộc):
 *   SE = √[ (A(1−A) + (n₁−1)(Q₁−A²) + (n₂−1)(Q₂−A²)) / (n₁n₂) ]
 *   Q₁ = A/(2−A) · Q₂ = A²/(1−A) · CI = A ± z·SE
 * A ngoài [0,1] hoặc n ≤ 0 → NaN cả hai (fail-open — cùng tinh thần wilsonCI).
 * Kẹp biên [0,1] sau khi tính: khoảng chuẩn A±z·SE với mẫu nhỏ chạm ra
 * ngoài [0,1] (AUC không thể > 1) — trình bày thô gây hiểu sai.
 * BIÊN DEGENERATE (FB-BRAIN-P3-R1-11 — công thức vẫn chạy, người đọc cần
 * biết): A=1 → Q₂=∞ → SE=∞ → CI toàn khoảng [0,1] (không chặt); A=0 →
 * SE=0 → CI [0,0] zero-width (đừng đọc là "chắc chắn tuyệt đối" — AUC 0
 * reachable khi mô hình đảo hết lớp).
 */
export function aucHanleyMcNeilCI(
  auc: number,
  nPos: number,
  nNeg: number,
  z = 1.96,
): { low: number; high: number } {
  if (!Number.isFinite(auc) || auc < 0 || auc > 1 || nPos <= 0 || nNeg <= 0 || !(z > 0)) {
    return { low: Number.NaN, high: Number.NaN }
  }
  const q1 = auc / (2 - auc)
  const q2 = (auc * auc) / (1 - auc)
  const se = Math.sqrt(
    (auc * (1 - auc) + (nPos - 1) * (q1 - auc * auc) + (nNeg - 1) * (q2 - auc * auc))
    / (nPos * nNeg),
  )
  return {
    low: Math.max(0, auc - z * se),
    high: Math.min(1, auc + z * se),
  }
}

// ==================== 5-FOLD CV — 3 ĐẦU vs BASELINE ĐỐI CHỨNG ====================

export interface HeadCvSuccess {
  /** Brier hold-out trung bình của đầu success qua các fold */
  cvBrier: number
  cvBrierCiLo: number
  cvBrierCiHi: number
  /** Brier baseline base-rate (tính từng fold trên tập train-fold) */
  brierBaseline: number
  improved: boolean
  /** AUC pooled hold-out (null khi thiếu 1 lớp — không tính được đường ROC) */
  auc: number | null
  aucCiLo: number | null
  aucCiHi: number | null
  nPos: number
  nNeg: number
  foldBriers: number[]
}

export interface HeadCvRegression {
  /** MAE hold-out trung bình trong log1p space */
  cvMae: number
  cvMaeCiLo: number
  cvMaeCiHi: number
  /** MAE baseline median (tập train-fold) — cùng đơn vị log1p */
  maeBaseline: number
  improved: boolean
  foldMaes: number[]
}

export interface SurrogateCvOutcome {
  success: HeadCvSuccess
  tokens: HeadCvRegression
  durationMs: HeadCvRegression
  /**
   * Cổng active (điều kiện DUY NHẤT) = success.improved — P(success) là đầu
   * ra quyết định của replay (model-comparison, Q-advice); 2 đầu hồi quy thua
   * chỉ làm đầu đó ẩn khỏi báo cáo (per-head fail-open), không chặn active.
   */
  improved: boolean
  folds: number
}

/**
 * 5-fold CV so 3 đầu surrogate với baseline đối chứng (thuần, không DB).
 *
 * Hợp đồng ném lỗi (kế thừa FB-BRAIN-P2-R1-03): X.length phải bằng chiều dài
 * cả 3 mảng y — lệch là lỗi lập trình caller → throw rõ ràng.
 * Trả null khi: folds không nguyên ≥ 2 (R1-04) hoặc không gán fold
 * stratified được (một lớp < folds mẫu — caller abort, KHÔNG fallback).
 *
 * Mỗi fold: input stats + target stats tính CHỈ trên 4 fold train (chống rò
 * rỉ hold-out) → fit 3 MLP → chấm trên hold-out. Baseline cùng fold: success
 * base-rate / tokens+duration median log1p — tính trên tập train-fold.
 */
export function crossValidateSurrogate(
  X: (number | null)[][],
  ySuccess: number[],
  yTokens: number[],
  yDuration: number[],
  vocab: SurrogateVocab,
  opts: { folds?: number; override?: BrainDraftSpec } = {},
): SurrogateCvOutcome | null {
  const n = X.length
  if (ySuccess.length !== n || yTokens.length !== n || yDuration.length !== n) {
    throw new Error(
      `crossValidateSurrogate: X.length (${n}) phải bằng ySuccess (${ySuccess.length}) / yTokens (${yTokens.length}) / yDuration (${yDuration.length}) — lỗi lập trình caller`,
    )
  }
  const folds = opts.folds ?? SURROGATE_FOLDS
  if (!Number.isInteger(folds) || folds < 2) return null
  const assign = stratifiedFoldAssignments(ySuccess, folds)
  if (!assign) return null

  const specs = buildSurrogateSpecs(vocab, opts.override)
  const fitSuccOpts = surrogateDraftFitOpts(opts.override, 0)
  const fitTokensOpts = surrogateDraftFitOpts(opts.override, 1)
  const fitDurOpts = surrogateDraftFitOpts(opts.override, 2)

  const foldBriers: number[] = []
  const foldBriersBase: number[] = []
  const foldTokensMae: number[] = []
  const foldTokensMaeBase: number[] = []
  const foldDurMae: number[] = []
  const foldDurMaeBase: number[] = []
  // Pooled hold-out cho AUC (score, actual) — gom đủ fold rồi chấm 1 lần
  const pooledScores: number[] = []
  const pooledActuals: boolean[] = []

  for (let f = 0; f < folds; f++) {
    const trainIdx: number[] = []
    const holdIdx: number[] = []
    for (let i = 0; i < n; i++) (assign[i] === f ? holdIdx : trainIdx).push(i)

    // ── Stats TẬP TRAIN fold (chống rò rỉ hold-out) ──
    const { means, stds } = computeColumnStats(trainIdx.map(i => X[i]))
    const stdRow = (row: (number | null)[]) =>
      row.map((v, j) => (typeof v === 'number' && Number.isFinite(v) ? (v - means[j]) / stds[j] : 0))
    const trainStd = trainIdx.map(i => stdRow(X[i]))
    const holdStd = holdIdx.map(i => stdRow(X[i]))

    // ── Đầu success: MLP vs base-rate ──
    const yTrSucc = trainIdx.map(i => ySuccess[i])
    const mlpSucc = new MLP(specs.success)
    mlpSucc.fit(trainStd, yTrSucc.map(v => [v]), fitSuccOpts)
    const predsSucc = holdStd.map(row => mlpSucc.predictProba(row))
    let brier = 0
    for (let k = 0; k < holdIdx.length; k++) {
      const d = predsSucc[k] - ySuccess[holdIdx[k]]
      brier += d * d
      pooledScores.push(predsSucc[k])
      pooledActuals.push(ySuccess[holdIdx[k]] > 0.5)
    }
    foldBriers.push(brier / holdIdx.length)
    const pBase = yTrSucc.length > 0 ? yTrSucc.reduce((s, v) => s + v, 0) / yTrSucc.length : 0.5
    let brierBase = 0
    for (const i of holdIdx) {
      const d = pBase - ySuccess[i]
      brierBase += d * d
    }
    foldBriersBase.push(brierBase / holdIdx.length)

    // ── 2 đầu hồi quy (log1p space): MLP (target chuẩn hóa) vs median ──
    for (const head of ['tokens', 'durationMs'] as const) {
      const yTr = trainIdx.map(i => (head === 'tokens' ? yTokens : yDuration)[i])
      const yHo = holdIdx.map(i => (head === 'tokens' ? yTokens : yDuration)[i])
      const t = targetStats(yTr)
      const mlp = new MLP(head === 'tokens' ? specs.tokens : specs.durationMs)
      mlp.fit(trainStd, yTr.map(v => [(v - t.mean) / t.std]), head === 'tokens' ? fitTokensOpts : fitDurOpts)
      // MAE tính trên log1p GỐC (de-standardize dự đoán) — đơn vị đọc được
      const preds = holdStd.map(row => mlp.predict(row)[0] * t.std + t.mean)
      let mae = 0
      for (let k = 0; k < yHo.length; k++) mae += Math.abs(preds[k] - yHo[k])
      const med = quantile(yTr, 0.5)
      let maeBase = 0
      for (const v of yHo) maeBase += Math.abs(med - v)
      if (head === 'tokens') {
        foldTokensMae.push(mae / yHo.length)
        foldTokensMaeBase.push(maeBase / yHo.length)
      } else {
        foldDurMae.push(mae / yHo.length)
        foldDurMaeBase.push(maeBase / yHo.length)
      }
    }
  }

  const avg = (xs: number[]) => xs.reduce((s, v) => s + v, 0) / xs.length
  const nPos = ySuccess.filter(v => v > 0.5).length
  const nNeg = ySuccess.length - nPos

  // AUC pooled hold-out — chỉ có nghĩa khi đủ 2 lớp
  let auc: number | null = null
  let aucCiLo: number | null = null
  let aucCiHi: number | null = null
  if (nPos > 0 && nNeg > 0 && pooledScores.length > 0) {
    const points = sweepThresholds(pooledScores, pooledActuals)
    const a = aucRoc(points)
    if (Number.isFinite(a)) {
      const ci = aucHanleyMcNeilCI(a, nPos, nNeg)
      auc = a
      aucCiLo = Number.isFinite(ci.low) ? ci.low : null
      aucCiHi = Number.isFinite(ci.high) ? ci.high : null
    }
  }

  const brierCi = meanCI(foldBriers)
  const tokensCi = meanCI(foldTokensMae)
  const durCi = meanCI(foldDurMae)

  const success: HeadCvSuccess = {
    cvBrier: avg(foldBriers),
    cvBrierCiLo: brierCi.low,
    cvBrierCiHi: brierCi.high,
    brierBaseline: avg(foldBriersBase),
    improved: avg(foldBriers) < avg(foldBriersBase), // NGẶT — bằng nhau không tính
    auc, aucCiLo, aucCiHi, nPos, nNeg, foldBriers,
  }
  const tokens: HeadCvRegression = {
    cvMae: avg(foldTokensMae),
    cvMaeCiLo: tokensCi.low,
    cvMaeCiHi: tokensCi.high,
    maeBaseline: avg(foldTokensMaeBase),
    improved: avg(foldTokensMae) < avg(foldTokensMaeBase),
    foldMaes: foldTokensMae,
  }
  const durationMs: HeadCvRegression = {
    cvMae: avg(foldDurMae),
    cvMaeCiLo: durCi.low,
    cvMaeCiHi: durCi.high,
    maeBaseline: avg(foldDurMaeBase),
    improved: avg(foldDurMae) < avg(foldDurMaeBase),
    foldMaes: foldDurMae,
  }

  return { success, tokens, durationMs, improved: success.improved, folds }
}

// ==================== TRAIN (DB) ====================

export interface SurrogateTrainResult {
  /** true khi đã ghi BrainModel (kể cả bản thua CV — vết audit) */
  trained: boolean
  version: number | null
  /** CHỈ true khi đầu success thắng baseline CV (ngặt) */
  active: boolean
  sampleSize: number
  improved: boolean
  /** CV chi tiết từng đầu — null khi không train */
  heads: SurrogateCvOutcome | null
  usable: number
  total: number
  error?: string
  /** BRAIN-UX §9.3 — quỹ đạo epoch từng head (hiển thị sau khi train xong). */
  history?: { success: EpochStat[]; tokens: EpochStat[]; durationMs: EpochStat[] }
  /** BRAIN-UX §9.4 — |gradient| trung bình từng lớp từng head. */
  gradAbsMean?: { success: number[]; tokens: number[]; durationMs: number[] }
  /** BRAIN-UX — train từ bản nháp UX-2 (provenance). */
  draftUsed?: boolean
}

/** Làm tròn 5 chữ số lẻ cho JSON lưu DB (đủ đọc, gọn — cùng V3) */
function round5(v: number): number {
  return Math.round(v * 100000) / 100000
}

/** Chuẩn hóa 1 hàng theo stats tập train: null/không hữu hạn → 0 (= mean) */
function standardizeRow(row: (number | null)[], means: number[], stds: number[]): number[] {
  return row.map((v, j) =>
    typeof v === 'number' && Number.isFinite(v) ? (v - means[j]) / stds[j] : 0,
  )
}

/**
 * Đọc AgentRunRecord (trạng thái CHỐT — complete boolean) → 5-fold CV so
 * baseline → train 3 MLP cuối trên toàn dữ liệu → ghi BrainModel brain=
 * 'surrogate'. KHÔNG throw khi thiếu dữ liệu (trained=false + error);
 * lỗi DB thật sự → throw (caller bọc fail-open). Single-flight A7: train
 * trùng nhịp của cùng brain → trả trained=false (không xếp hàng).
 */
export async function trainBrainSurrogate(
  inputMode: string = SURROGATE_INPUT_MODE,
  override?: BrainDraftSpec,
): Promise<SurrogateTrainResult> {
  if (!acquireTrainLock('surrogate')) {
    return {
      trained: false, version: null, active: false, sampleSize: 0, improved: false,
      heads: null, usable: 0, total: 0,
      error: 'single-flight (A7): train khác của brain surrogate đang chạy — bỏ lệnh trùng',
    }
  }
  try {
    return await trainBrainSurrogateLocked(inputMode, override)
  } finally {
    releaseTrainLock('surrogate')
  }
}

async function trainBrainSurrogateLocked(
  inputMode: string,
  override?: BrainDraftSpec,
): Promise<SurrogateTrainResult> {
  const rows = await db.agentRunRecord.findMany({
    select: {
      id: true, runId: true, model: true, agentName: true, parentRunId: true,
      complete: true, tokensUsed: true, durationMs: true, createdAt: true,
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], // tie-break id — bài học R2-02
    take: 5000,
  })

  // Usable = trạng thái CHỐT (complete boolean) + model biết + tokens/duration
  // hữu hạn ≥ 0. Row 'running' (complete null) tự rơi ra — không phải label.
  const usable = rows.filter(
    r => typeof r.model === 'string' && r.model !== ''
      && typeof r.complete === 'boolean'
      && typeof r.tokensUsed === 'number' && Number.isFinite(r.tokensUsed) && r.tokensUsed >= 0
      && typeof r.durationMs === 'number' && Number.isFinite(r.durationMs) && r.durationMs >= 0,
  )

  const notTrained = (error: string): SurrogateTrainResult => ({
    trained: false, version: null, active: false, sampleSize: 0, improved: false,
    heads: null, usable: usable.length, total: rows.length, error,
  })

  // Từ chối mode chưa hỗ trợ — kiểm SAU khi đếm usable/total để telemetry
  // trung thực (FB-BRAIN-P2-R1-08)
  if (!isSupportedSurrogateInputMode(inputMode)) {
    return notTrained(
      `inputMode '${inputMode}' chưa hỗ trợ phase BRAIN-P3 (chỉ '${SURROGATE_INPUT_MODE}' — mode vector pca-128/mrl-512/full-2048 chờ quyết định Q2 blueprint §3.2)`,
    )
  }

  if (usable.length < SURROGATE_MIN_TRAIN_SAMPLES) {
    return notTrained(
      `insufficient data: only ${usable.length} usable AgentRunRecord rows (need ${SURROGATE_MIN_TRAIN_SAMPLES}+) — ngủ an toàn, chạy thêm agent run trước`,
    )
  }

  // Vocab + đặc trưng + nhãn
  const ctxs: SurrogateFeatureCtx[] = usable.map(r => ({
    model: r.model as string,
    agent: r.agentName,
    delegated: r.parentRunId !== null,
  }))
  const vocab = buildSurrogateVocab(ctxs)
  const featureNames = surrogateFeatureNames(vocab)
  const X = ctxs.map(c => buildSurrogateFeatureRow(c, vocab))
  const ySuccess: number[] = usable.map(r => (r.complete === true ? 1 : 0))
  const yTokens = usable.map(r => toLogSpace(r.tokensUsed as number))
  const yDuration = usable.map(r => toLogSpace(r.durationMs as number))

  // CV TRƯỚC khi tin model (kỷ luật V2/V3): lệch lớp → abort không fallback
  // BRAIN-UX §9.2 — CV đánh giá kiến trúc + λ + loại loss của draft khi có
  const cv = crossValidateSurrogate(X, ySuccess, yTokens, yDuration, vocab, override ? { override } : {})
  if (!cv) {
    return notTrained(
      `class imbalance: cần ≥${SURROGATE_FOLDS} mẫu MỖI lớp success cho ${SURROGATE_FOLDS}-fold stratified CV — complete=${ySuccess.filter(v => v === 1).length}/incomplete=${ySuccess.filter(v => v === 0).length}`,
    )
  }

  // ── Model cuối trên TOÀN BỘ dữ liệu (stats full-data — đúng V3) ──
  const specs = buildSurrogateSpecs(vocab, override)
  const fitSuccOpts = surrogateDraftFitOpts(override, 0)
  const fitTokensOpts = surrogateDraftFitOpts(override, 1)
  const fitDurOpts = surrogateDraftFitOpts(override, 2)
  const { means, stds } = computeColumnStats(X)
  const Xstd = X.map(row => standardizeRow(row, means, stds))

  const mlpSucc = new MLP(specs.success)
  const fitSucc: FitResult = mlpSucc.fit(Xstd, ySuccess.map(v => [v]), fitSuccOpts)
  const tTokens = targetStats(yTokens)
  const mlpTokens = new MLP(specs.tokens)
  const fitTokens: FitResult = mlpTokens.fit(
    Xstd, yTokens.map(v => [(v - tTokens.mean) / tTokens.std]), fitTokensOpts,
  )
  const tDur = targetStats(yDuration)
  const mlpDur = new MLP(specs.durationMs)
  const fitDur: FitResult = mlpDur.fit(
    Xstd, yDuration.map(v => [(v - tDur.mean) / tDur.std]), fitDurOpts,
  )

  // Version mới = max + 1
  const maxRow = await db.brainModel.aggregate({
    where: { brain: 'surrogate' },
    _max: { version: true },
  })
  const version = (maxRow._max.version ?? 0) + 1

  // Bất biến A1: tắt active cũ TRƯỚC khi ghi bản active mới (không
  // $transaction BUG2-119; gãy giữa chừng → không còn active → replay rơi
  // nhánh đo lường thuần — hướng an toàn)
  if (cv.improved) {
    await db.brainModel.updateMany({
      where: { brain: 'surrogate', active: true },
      data: { active: false },
    })
  }

  // Provenance chain §5.3 (kế thừa pattern V3 + FB-BRAIN-P2-R1-06)
  const dateFrom = usable.length > 0
    ? usable.reduce((m, r) => (r.createdAt < m ? r.createdAt : m), usable[0].createdAt)
    : null
  const dateTo = usable.length > 0
    ? usable.reduce((m, r) => (r.createdAt > m ? r.createdAt : m), usable[0].createdAt)
    : null
  const runIdList = Array.from(
    new Set(usable.map(r => (typeof r.runId === 'string' && r.runId !== '' ? r.runId : r.id))),
  ).sort()
  const RUN_IDS_MAX = 50
  const lineageRunIds: string[] | string = runIdList.length <= RUN_IDS_MAX
    ? runIdList
    : `sha256:${createHash('sha256').update(runIdList.join('\n')).digest('hex').slice(0, 16)} (${runIdList.length} runs)`

  const trainMeta = {
    nSamples: ySuccess.length,
    inputMode: SURROGATE_INPUT_MODE,
    metric: 'brier(success)',
    // Trường tiêu chuẩn của panel /api/brain (parseTrainMeta) — success gate
    cvScore: round5(cv.success.cvBrier),
    cvScoreCiLow: round5(cv.success.cvBrierCiLo),
    cvScoreCiHigh: round5(cv.success.cvBrierCiHi),
    brierBaseline: round5(cv.success.brierBaseline),
    improved: cv.improved,
    heads: {
      success: {
        cvBrier: round5(cv.success.cvBrier),
        cvBrierCi: [round5(cv.success.cvBrierCiLo), round5(cv.success.cvBrierCiHi)] as [number, number],
        brierBaseline: round5(cv.success.brierBaseline),
        improved: cv.success.improved,
        auc: cv.success.auc === null ? null : round5(cv.success.auc),
        aucCi: (cv.success.aucCiLo !== null && cv.success.aucCiHi !== null)
          ? ([round5(cv.success.aucCiLo), round5(cv.success.aucCiHi)] as [number, number])
          : null,
        nPos: cv.success.nPos,
        nNeg: cv.success.nNeg,
      },
      tokens: {
        cvMaeLog: round5(cv.tokens.cvMae),
        cvMaeCi: [round5(cv.tokens.cvMaeCiLo), round5(cv.tokens.cvMaeCiHi)] as [number, number],
        maeBaselineLog: round5(cv.tokens.maeBaseline),
        improved: cv.tokens.improved,
      },
      durationMs: {
        cvMaeLog: round5(cv.durationMs.cvMae),
        cvMaeCi: [round5(cv.durationMs.cvMaeCiLo), round5(cv.durationMs.cvMaeCiHi)] as [number, number],
        maeBaselineLog: round5(cv.durationMs.maeBaseline),
        improved: cv.durationMs.improved,
      },
    },
    vocab,
    featureNames,
    // stds/targetStats GIỮ FULL precision — KHÔNG round5 (bài học
    // FB-BRAIN-P2-R1-01: round5 từng ép std cột near-constant về 0 → NaN)
    standardization: { means: means.map(round5), stds: stds.slice() },
    targetStats: {
      tokens: { mean: tTokens.mean, std: tTokens.std },
      durationMs: { mean: tDur.mean, std: tDur.std },
    },
    baselines: {
      successPrior: round5(ySuccess.reduce((s, v) => s + v, 0) / ySuccess.length),
      tokensMedianLog: round5(quantile(yTokens, 0.5)),
      durationMedianLog: round5(quantile(yDuration, 0.5)),
    },
    fit: {
      success: {
        epochsRun: fitSucc.epochsRun, bestEpoch: fitSucc.bestEpoch,
        stoppedEarly: fitSucc.stoppedEarly,
        finalTrainLoss: Number.isFinite(fitSucc.finalTrainLoss) ? round5(fitSucc.finalTrainLoss) : null,
      },
      tokens: {
        epochsRun: fitTokens.epochsRun, bestEpoch: fitTokens.bestEpoch,
        stoppedEarly: fitTokens.stoppedEarly,
        finalTrainLoss: Number.isFinite(fitTokens.finalTrainLoss) ? round5(fitTokens.finalTrainLoss) : null,
      },
      durationMs: {
        epochsRun: fitDur.epochsRun, bestEpoch: fitDur.bestEpoch,
        stoppedEarly: fitDur.stoppedEarly,
        finalTrainLoss: Number.isFinite(fitDur.finalTrainLoss) ? round5(fitDur.finalTrainLoss) : null,
      },
    },
    // BRAIN-UX §9.3/§9.4 — λ hiệu lực từng head (sau chuẩn hoá Σ=1 — audit;
    // null = không draft, chia đều mặc định) + |gradient| trung bình từng
    // lớp MỖI head (chế độ lan truyền ngược UX-3 — dữ liệu thật) + draft UX-2
    lossWeights: override
      ? lossScalePerHead(override.lossPerHead.map(h => h.weight)).map(v => round5(v / 3))
      : null,
    gradAbsMean: {
      success: fitSucc.gradAbsMean.map(round5),
      tokens: fitTokens.gradAbsMean.map(round5),
      durationMs: fitDur.gradAbsMean.map(round5),
    },
    draftUsed: Boolean(override),
    dataLineage: {
      tables: { AgentRunRecord: usable.length },
      runs: runIdList.length,
      runIds: lineageRunIds,
      dateRange: dateFrom && dateTo ? [dateFrom.toISOString(), dateTo.toISOString()] : null,
      labelRule: 'complete === true (trạng thái chốt) · tokens/duration log1p space',
      inputMode: SURROGATE_INPUT_MODE,
      baseline: 'success base-rate + tokens/duration median (tính từng fold trên tập train-fold)',
      flagKey: 'replay_eval',
    },
  }

  // specJson: document vocab + 3 spec (single-source dựng lại đặc trưng)
  const specDoc = { inputMode: SURROGATE_INPUT_MODE, vocab, heads: specs }
  // weightsJson: 3 envelope numpy-đọc-được (audit A6 giữ NGUYÊN từng head)
  const weightsDoc = {
    heads: {
      success: mlpSucc.serialize(),
      tokens: mlpTokens.serialize(),
      durationMs: mlpDur.serialize(),
    } satisfies Record<string, MlpSerialized>,
  }

  await db.brainModel.create({
    data: {
      brain: 'surrogate',
      version,
      inputMode: SURROGATE_INPUT_MODE,
      specJson: JSON.stringify(specDoc),
      weightsJson: JSON.stringify(weightsDoc),
      trainMetaJson: JSON.stringify(trainMeta),
      active: cv.improved,
    },
  })

  // Prune A2: giữ active + N bản mới nhất (fail-open — lỗi prune không làm
  // fail phép train đã ghi xong)
  await pruneSurrogateVersions()

  return {
    trained: true,
    version,
    active: cv.improved,
    sampleSize: ySuccess.length,
    improved: cv.improved,
    heads: cv,
    usable: usable.length,
    total: rows.length,
    // BRAIN-UX §9.3/§9.4 — quỹ đạo epoch + |gradient| từng head + draft
    history: { success: fitSucc.history, tokens: fitTokens.history, durationMs: fitDur.history },
    gradAbsMean: {
      success: fitSucc.gradAbsMean.map(round5),
      tokens: fitTokens.gradAbsMean.map(round5),
      durationMs: fitDur.gradAbsMean.map(round5),
    },
    draftUsed: Boolean(override),
  }
}

/** Prune phiên bản surrogate (A2) — giữ MỌI bản active + N mới nhất. */
async function pruneSurrogateVersions(): Promise<void> {
  try {
    const rows = await db.brainModel.findMany({
      where: { brain: 'surrogate' },
      orderBy: { version: 'desc' },
      select: { id: true, version: true, active: true },
    })
    const keep = new Set<string>()
    rows.forEach((r, i) => {
      if (r.active || i < BRAIN_VERSIONS_KEEP) keep.add(r.id)
    })
    const drop = rows.filter(r => !keep.has(r.id))
    if (drop.length > 0) {
      await db.brainModel.deleteMany({ where: { id: { in: drop.map(r => r.id) } } })
    }
  } catch (err) {
    console.warn('[Brain-B] prune failed (fail-open):', err instanceof Error ? err.message : String(err))
  }
}

// ==================== RUNTIME LOAD (fail-open) ====================

/** Model Brain-B active đã nạp từ DB (3 MLP + stats + vocab). */
export interface ActiveSurrogate {
  version: number
  nSamples: number
  vocab: SurrogateVocab
  heads: {
    success: MLP
    tokens: MLP
    durationMs: MLP
  }
  /** Đầu nào thắng baseline CV (đầu thua KHÔNG được báo cáo — per-head fail-open) */
  headImproved: { success: boolean; tokens: boolean; durationMs: boolean }
  means: number[]
  stds: number[]
  targetStats: {
    tokens: { mean: number; std: number }
    durationMs: { mean: number; std: number }
  }
  /** Baseline train-set (fallback báo cáo khi đầu thua) */
  baselines: { successPrior: number; tokensMedianLog: number; durationMedianLog: number }
  /** Chất lượng CV từ trainMeta — hiển thị kèm ước lượng replay */
  cv: {
    success: { cvBrier: number; brierBaseline: number; auc: number | null }
    tokens: { cvMaeLog: number; maeBaselineLog: number }
    durationMs: { cvMaeLog: number; maeBaselineLog: number }
  }
}

/**
 * Nạp bản surrogate active từ BrainModel — MỌI nhánh không áp được trả null
 * (không có bản active / trainMeta rách / standardization sai chiều hoặc
 * std ≤ 0 / weightsJson rách / nSamples dưới ngưỡng runtime). stds ≤ 0 →
 * null: chia 0 tạo ±∞/NaN (FB-BRAIN-P2-R1-01 — std 0 từng lọt cửa vì
 * "finite" không chặn 0).
 */
export async function loadActiveSurrogate(): Promise<ActiveSurrogate | null> {
  try {
    const row = await db.brainModel.findFirst({
      where: { brain: 'surrogate', active: true, inputMode: SURROGATE_INPUT_MODE },
      orderBy: { version: 'desc' },
      select: { version: true, specJson: true, weightsJson: true, trainMetaJson: true },
    })
    if (!row) return null

    const meta = JSON.parse(row.trainMetaJson) as Record<string, unknown>
    const nSamples = typeof meta.nSamples === 'number' && Number.isFinite(meta.nSamples)
      ? meta.nSamples
      : null
    if (nSamples === null || nSamples < SURROGATE_MIN_RUNTIME_SAMPLES) return null

    // Vocab (specJson) — đúng dạng: 2 mảng string
    const specDoc = JSON.parse(row.specJson) as { vocab?: unknown }
    const vocabRaw = specDoc.vocab as SurrogateVocab | undefined
    const okVocab =
      vocabRaw
      && Array.isArray(vocabRaw.models) && vocabRaw.models.every(m => typeof m === 'string')
      && Array.isArray(vocabRaw.agents) && vocabRaw.agents.every(a => typeof a === 'string')
    if (!okVocab) return null
    const vocab: SurrogateVocab = { models: vocabRaw.models, agents: vocabRaw.agents }

    // Standardization stats — đúng D chiều, mọi giá trị hữu hạn, stds > 0
    const d = surrogateFeatureNames(vocab).length
    const std = meta.standardization as { means?: unknown; stds?: unknown } | undefined
    const okArr = (v: unknown): v is number[] =>
      Array.isArray(v) && v.length === d && v.every(x => typeof x === 'number' && Number.isFinite(x))
    const okStds =
      Array.isArray(std?.stds) && (std.stds as unknown[]).length === d
      && (std.stds as unknown[]).every(x => typeof x === 'number' && Number.isFinite(x) && x > 0)
    if (!std || !okArr(std.means) || !okArr(std.stds) || !okStds) return null

    // Target stats hồi quy (de-standardize dự đoán)
    const ts = meta.targetStats as
      | { tokens?: { mean?: unknown; std?: unknown }; durationMs?: { mean?: unknown; std?: unknown } }
      | undefined
    const okT = (v: unknown): v is { mean: number; std: number } =>
      typeof v === 'object' && v !== null
      && typeof (v as { mean?: unknown }).mean === 'number' && Number.isFinite((v as { mean: number }).mean)
      && typeof (v as { std?: unknown }).std === 'number' && Number.isFinite((v as { std: number }).std)
      && (v as { std: number }).std > 0
    if (!ts || !okT(ts.tokens) || !okT(ts.durationMs)) return null

    // Head improved flags + baselines (trainMeta)
    const headsMeta = meta.heads as
      | { success?: { improved?: unknown }; tokens?: { improved?: unknown }; durationMs?: { improved?: unknown } }
      | undefined
    const flag = (v: unknown): boolean => v === true
    if (!headsMeta) return null
    const headImproved = {
      success: flag(headsMeta.success?.improved),
      tokens: flag(headsMeta.tokens?.improved),
      durationMs: flag(headsMeta.durationMs?.improved),
    }
    const bl = meta.baselines as
      | { successPrior?: unknown; tokensMedianLog?: unknown; durationMedianLog?: unknown }
      | undefined
    const num = (v: unknown): number | null =>
      typeof v === 'number' && Number.isFinite(v) ? v : null
    if (!bl
      || num(bl.successPrior) === null || num(bl.tokensMedianLog) === null
      || num(bl.durationMedianLog) === null) return null

    // 3 MLP deserialize (throw → catch → null — fail-open)
    const weightsDoc = JSON.parse(row.weightsJson) as {
      heads?: { success?: MlpSerialized; tokens?: MlpSerialized; durationMs?: MlpSerialized }
    }
    if (!weightsDoc.heads?.success || !weightsDoc.heads.tokens || !weightsDoc.heads.durationMs) {
      return null
    }
    // FB-BRAIN-P3-R1-08 (phần storage): JSON KHÔNG lưu được NaN (NaN → null
    // khi stringify) — weights rách qua DB thành null, Float64Array.from
    // ép null→0 = weight-0 ÂM THẦM (dự đoán sai thầm lặng — tệ hơn crash).
    // Chặn ở cửa nạp: MỌI giá trị envelope phải finite — vi phạm → reject
    // cả model (hướng an toàn: replay rơi nhánh đo lường thuần).
    const allWeightsFinite = (m: MlpSerialized): boolean =>
      m.tensors.every(t => Array.isArray(t.envelope?.data) && t.envelope.data.every(v => Number.isFinite(v)))
    if (
      !allWeightsFinite(weightsDoc.heads.success)
      || !allWeightsFinite(weightsDoc.heads.tokens)
      || !allWeightsFinite(weightsDoc.heads.durationMs)
    ) {
      return null
    }
    const mlpSuccess = MLP.deserialize(weightsDoc.heads.success)
    const mlpTokens = MLP.deserialize(weightsDoc.heads.tokens)
    const mlpDur = MLP.deserialize(weightsDoc.heads.durationMs)

    // Kiểm input dim khớp vocab (weightsJson/specJson từ 2 nguồn khác nhau
    // phải cùng kiến trúc — lệch là DB rách)
    if (mlpSuccess.getSpec().layers[0].units !== d) return null

    // Chất lượng CV để hiển thị kèm ước lượng (fail-open từng trường)
    const cvSuccess = (headsMeta.success ?? {}) as Record<string, unknown>
    const cvTokens = (headsMeta.tokens ?? {}) as Record<string, unknown>
    const cvDur = (headsMeta.durationMs ?? {}) as Record<string, unknown>

    return {
      version: row.version,
      nSamples,
      vocab,
      heads: { success: mlpSuccess, tokens: mlpTokens, durationMs: mlpDur },
      headImproved,
      means: std.means,
      stds: std.stds,
      targetStats: { tokens: ts.tokens, durationMs: ts.durationMs },
      baselines: {
        successPrior: bl.successPrior as number,
        tokensMedianLog: bl.tokensMedianLog as number,
        durationMedianLog: bl.durationMedianLog as number,
      },
      cv: {
        success: {
          cvBrier: num(cvSuccess.cvBrier) ?? Number.NaN,
          brierBaseline: num(cvSuccess.brierBaseline) ?? Number.NaN,
          auc: num(cvSuccess.auc),
        },
        tokens: {
          cvMaeLog: num(cvTokens.cvMaeLog) ?? Number.NaN,
          maeBaselineLog: num(cvTokens.maeBaselineLog) ?? Number.NaN,
        },
        durationMs: {
          cvMaeLog: num(cvDur.cvMaeLog) ?? Number.NaN,
          maeBaselineLog: num(cvDur.maeBaselineLog) ?? Number.NaN,
        },
      },
    }
  } catch {
    return null // fail-open — mọi lỗi nạp → replay rơi nhánh đo lường thuần
  }
}

/**
 * Áp surrogate cho 1 cấu hình (thuần — không đụng DB, test trực tiếp được).
 * Trả ước lượng CHO MỌI đầu đã thắng CV (thua → null — per-head fail-open,
 * caller/consumer đọc nhánh baseline lịch sử).
 *
 * Hợp đồng ném lỗi (kế thừa FB-BRAIN-P2-R1-05): means/stds phải đúng D chiều
 * VÀ stds > 0 mọi chiều — vi phạm MODEL (ActiveSurrogate hỏng cả khối) →
 * throw rõ ràng. Riêng 1 đầu dự đoán ra NaN/Infinity → CHỈ đầu đó null
 * (per-head fail-open ĐÚNG NHƯ claim — FB-BRAIN-P3-R1-08: bản trước throw
 * khiến buildReplayReport mất CẢ 3 đầu, kể cả đầu lành; giờ mỗi đầu độc lập).
 */
export function applySurrogateHead(
  model: ActiveSurrogate,
  ctx: SurrogateFeatureCtx,
): {
  success: number | null
  tokens: number | null
  durationMs: number | null
} {
  const d = surrogateFeatureNames(model.vocab).length
  if (model.means.length !== d || model.stds.length !== d) {
    throw new Error(
      `applySurrogateHead: means/stds phải đúng ${d} chiều (nhận ${model.means.length}/${model.stds.length}) — ActiveSurrogate hỏng`,
    )
  }
  if (!model.stds.every(v => v > 0)) {
    throw new Error('applySurrogateHead: stds phải > 0 mọi chiều — chia 0 tạo ±∞/NaN (FB-BRAIN-P2-R1-01)')
  }
  const raw = buildSurrogateFeatureRow(ctx, model.vocab)
  const x = raw.map((v, j) =>
    typeof v === 'number' && Number.isFinite(v) ? (v - model.means[j]) / model.stds[j] : 0,
  )

  // Đầu success — sigmoid ∈ (0,1); NaN/Inf → CHỈ đầu này null
  // (FB-BRAIN-P3-R1-08 — per-head fail-open thật, không làm sập đầu khác)
  let success: number | null = null
  if (model.headImproved.success) {
    const p = model.heads.success.predictProba(x)
    if (Number.isFinite(p)) {
      success = Math.min(1, Math.max(0, p))
    }
  }

  // 2 đầu hồi quy — de-standardize + back-transform expm1, kẹp ≥ 0
  let tokens: number | null = null
  if (model.headImproved.tokens) {
    const z = model.heads.tokens.predict(x)[0]
    if (Number.isFinite(z)) {
      tokens = fromLogSpace(z * model.targetStats.tokens.std + model.targetStats.tokens.mean)
    }
  }
  let durationMs: number | null = null
  if (model.headImproved.durationMs) {
    const z = model.heads.durationMs.predict(x)[0]
    if (Number.isFinite(z)) {
      durationMs = fromLogSpace(z * model.targetStats.durationMs.std + model.targetStats.durationMs.mean)
    }
  }

  return { success, tokens, durationMs }
}

/**
 * Cờ REPLAY_EVAL (STORE > ENV > DEFAULT=off — tuning store, key
 * 'replay_eval'). Cờ chỉ mở phần ƯỚC LƯỢNG MLP trong báo cáo replay —
 * nhánh đo lường lịch sử (bootstrap CI) LUÔN chạy kể cả cờ off (thuần
 * quan sát — "chỉ đo/báo cáo" theo điểm dừng blueprint §0).
 */
export function isReplayEvalEnabled(): boolean {
  try {
    return getTuningEnum('replay_eval') === 'on'
  } catch {
    return false // key lạ/DB lỗi → off (fail-open)
  }
}

// ==================== BOOTSTRAP CI (tất định) ====================

/**
 * Bootstrap percentile CI (2.5%–97.5%) của một thống kê — resample có hoàn
 * trả B lượt bằng makeRng(seed) (tất định, tái lập được — không Math.random).
 * Thuần — single-source cho replay report.
 */
export function bootstrapCI<T>(
  samples: readonly T[],
  stat: (resample: T[]) => number,
  replicates: number = SURROGATE_BOOTSTRAP_REPLICATES,
  seed: number = SURROGATE_BOOTSTRAP_SEED,
): { low: number; high: number } | null {
  const n = samples.length
  if (n === 0 || !Number.isInteger(replicates) || replicates < 2) return null
  const rng = makeRng(seed)
  const stats: number[] = []
  for (let b = 0; b < replicates; b++) {
    const resample: T[] = new Array(n)
    for (let i = 0; i < n; i++) resample[i] = samples[Math.floor(rng() * n) % n]
    stats.push(stat(resample))
  }
  return { low: quantile(stats, 0.025), high: quantile(stats, 0.975) }
}

// ==================== REPLAY REPORT (READ-ONLY tuyệt đối) ====================

export interface ReplayHistoryBlock {
  /** Số row usable của CHÍNH model này (bằng chứng cho ước lượng) */
  nModelRuns: number
  nModelSuccess: number
  successRate: number | null
  /** bootstrap percentile CI 95% của success rate (n=0 → null) */
  successCi: { low: number; high: number } | null
  /** median tokens (đơn vị gốc) + CI bootstrap của median */
  tokensMedian: number | null
  tokensCi: { low: number; high: number } | null
  durationMedianMs: number | null
  durationCi: { low: number; high: number } | null
}

export interface ReplaySurrogateHeadSuccess {
  pSuccess: number
  cvBrier: number
  brierBaseline: number
  auc: number | null
}

export interface ReplaySurrogateHeadRegression {
  /** đơn vị gốc — back-transform expm1 từ log1p space */
  estimate: number
  cvMaeLog: number
  maeBaselineLog: number
}

export interface ReplayReport {
  config: { model: string; agent: string | null; delegated: boolean }
  flag: { key: 'replay_eval'; value: 'on' | 'off' }
  /** Đo lường lịch sử — LUÔN có (kể cả cờ off): đây là phần "chỉ đo/báo cáo" */
  history: ReplayHistoryBlock
  /**
   * Surrogate — TRẠNG THÁI active luôn báo cáo trung thực (đo rẻ);
   * ƯỚC LƯỢNG (heads) chỉ khi cờ on VÀ bản active VÀ đầu tương ứng thắng
   * CV; mỗi đầu độc lập (per-head fail-open). heads toàn null = chưa được
   * phép nói (cờ off) hoặc không có gì để nói.
   */
  surrogate: {
    active: boolean
    version: number | null
    nSamples: number | null
    heads: {
      success: ReplaySurrogateHeadSuccess | null
      tokens: ReplaySurrogateHeadRegression | null
      durationMs: ReplaySurrogateHeadRegression | null
    }
  }
  bootstrap: { replicates: number; seed: number }
  /** Wilson CI 95% của successRate lịch sử (n>0) — cho người đọc nhanh */
  successWilson: { low: number; high: number } | null
  disclaimer: string
  generatedAt: string
}

/**
 * Dựng báo cáo replay-eval cho 1 cấu hình — READ-ONLY tuyệt đối (chỉ
 * findMany/findFirst; r86 pin không ghi DB). Hai khối tách bạch:
 *  (1) history — đo lường thuần trên AgentRunRecord của model: tỉ lệ
 *      success + median tokens/duration kèm bootstrap CI (đối chứng
 *      bootstrap CI đúng bản chất ngưỡng thức tỉnh §2);
 *  (2) surrogate — ước lượng MLP (chỉ khi cờ on + active + đầu thắng CV;
 *      mỗi đầu fail-open độc lập, lỗi 1 đầu không làm sập các đầu khác).
 */
export async function buildReplayReport(config: SurrogateFeatureCtx): Promise<ReplayReport> {
  // ── (1) History — đo lường thuần (luôn chạy) ──
  const rows = await db.agentRunRecord.findMany({
    where: { model: config.model },
    select: { complete: true, tokensUsed: true, durationMs: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: 2000,
  })
  const usableHist = rows.filter(
    r => typeof r.complete === 'boolean'
      && typeof r.tokensUsed === 'number' && Number.isFinite(r.tokensUsed) && r.tokensUsed >= 0
      && typeof r.durationMs === 'number' && Number.isFinite(r.durationMs) && r.durationMs >= 0,
  )
  const n = usableHist.length
  const outcomes: number[] = usableHist.map(r => (r.complete === true ? 1 : 0))
  const tokenLogs = usableHist.map(r => toLogSpace(r.tokensUsed as number))
  const durLogs = usableHist.map(r => toLogSpace(r.durationMs as number))

  const successRate = n > 0 ? outcomes.reduce((s, v) => s + v, 0) / n : null
  const successCi = successRate !== null
    ? bootstrapCI(outcomes, rs => rs.reduce((s, v) => s + v, 0) / rs.length)
    : null
  const tokensCi = n > 0
    ? (() => {
        const ci = bootstrapCI(tokenLogs, rs => quantile(rs, 0.5))
        return ci ? { low: fromLogSpace(ci.low), high: fromLogSpace(ci.high) } : null
      })()
    : null
  const durationCi = n > 0
    ? (() => {
        const ci = bootstrapCI(durLogs, rs => quantile(rs, 0.5))
        return ci ? { low: fromLogSpace(ci.low), high: fromLogSpace(ci.high) } : null
      })()
    : null

  const history: ReplayHistoryBlock = {
    nModelRuns: n,
    nModelSuccess: outcomes.reduce((s, v) => s + v, 0),
    successRate,
    successCi,
    tokensMedian: n > 0 ? fromLogSpace(quantile(tokenLogs, 0.5)) : null,
    tokensCi,
    durationMedianMs: n > 0 ? fromLogSpace(quantile(durLogs, 0.5)) : null,
    durationCi,
  }
  const successWilson = successRate !== null && n > 0 ? wilsonCI(successRate, n) : null

  // ── (2) Surrogate — trạng thái active LUÔN báo cáo trung thực (đo rẻ:
  // 1 findFirst trên index [brain, active]); ước lượng MLP (heads) chỉ khi
  // cờ on + active + đầu thắng CV — per-head fail-open ──
  const flagOn = isReplayEvalEnabled()
  let surrogateBlock: ReplayReport['surrogate'] = {
    active: false, version: null, nSamples: null,
    heads: { success: null, tokens: null, durationMs: null },
  }
  const active = await loadActiveSurrogate()
  if (active) {
    surrogateBlock = {
      active: true, version: active.version, nSamples: active.nSamples,
      heads: { success: null, tokens: null, durationMs: null },
    }
    if (flagOn) {
      // Ba đầu độc lập — per-head NaN tự null (R1-08); try/catch chỉ còn
      // bắt model-level throw (means/stds hỏng) → mọi đầu null đúng nghĩa
      try {
        const est = applySurrogateHead(active, config)
        if (est.success !== null) {
          surrogateBlock.heads.success = {
            pSuccess: est.success,
            cvBrier: active.cv.success.cvBrier,
            brierBaseline: active.cv.success.brierBaseline,
            auc: active.cv.success.auc,
          }
        }
        if (est.tokens !== null) {
          surrogateBlock.heads.tokens = {
            estimate: est.tokens,
            cvMaeLog: active.cv.tokens.cvMaeLog,
            maeBaselineLog: active.cv.tokens.maeBaselineLog,
          }
        }
        if (est.durationMs !== null) {
          surrogateBlock.heads.durationMs = {
            estimate: est.durationMs,
            cvMaeLog: active.cv.durationMs.cvMaeLog,
            maeBaselineLog: active.cv.durationMs.maeBaselineLog,
          }
        }
      } catch { /* fail-open — replay rơi nhánh đo lường thuần */ }
    }
  }

  return {
    config: { model: config.model, agent: config.agent ?? null, delegated: config.delegated },
    flag: { key: 'replay_eval', value: flagOn ? 'on' : 'off' },
    history,
    surrogate: surrogateBlock,
    bootstrap: { replicates: SURROGATE_BOOTSTRAP_REPLICATES, seed: SURROGATE_BOOTSTRAP_SEED },
    successWilson: successWilson && Number.isFinite(successWilson.low)
      ? { low: successWilson.low, high: successWilson.high }
      : null,
    disclaimer:
      'Replay-eval đo/báo cáo — KHÔNG tự chạy thật, KHÔNG ghi DB, KHÔNG tự thay quyết định (consumer model-comparison/Q-advice/sweep là việc BRAIN-P4). Ước lượng MLP chỉ hiện khi cờ replay_eval bật VÀ đầu đó thắng baseline CV.',
    generatedAt: new Date().toISOString(),
  }
}
