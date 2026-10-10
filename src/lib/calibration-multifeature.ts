/**
 * P3-M1 + P3-M2 (BLUEPRINT-STATS-LEARNING-P0-P6 §P3-M1/§P3-M2, mục #9 + #13
 * — MATH.pdf §Logistic Prediction with Multiple Features, Interpreting
 * Coefficients — Odds Ratio, Regularization L2; ML.pdf §Tips "luôn kiểm định
 * lại kết quả bằng cross-validation").
 *
 * Calibration model THỨC HAI (đa biến) cho KB retrieval confidence:
 *   V1 (calibration-train.ts): X = rawConfidence duy nhất — bỏ qua mọi tín
 *   hiệu khác (coverage, hallucination, difficulty...).
 *   V2 (file này): X = 10 đặc trưng chuẩn hóa theo mean/std tập train:
 *     x1 rawConfidence          (thành phần V1 — giữ tương thích so sánh)
 *     x2 coverage               (0-1)
 *     x3 answered               (0/1)
 *     x4 log1p(retrievedChunks)
 *     x5 extractionF1           (0-1)
 *     x6 hallucinationDetected  (0/1)
 *     x7 difficulty             (easy=0 / medium=0.5 / hard=1)
 *     x8 category one-hot gộp   (programming|ml|security|other → 3 nhị phân)
 *   Y giữ NGUYÊN semantics V1: faithfulnessMedian > 0.7 (= 1 answer faithful).
 *   Huấn luyện: gradient descent mini-batch + điều chuẩn L2 λ=0.01 (chống quá
 *   khớp khi đặc trưng tương quan — MATH.pdf §Regularization). Odds ratio
 *   OR_j = e^β_j trên đặc trưng chuẩn hóa, với Y=1 = FAITHFUL: "x_j tăng 1σ →
 *   odds FAITHFUL ×OR_j" — OR < 1 là đặc trưng đẩy nguy cơ phán quyết SAI
 *   (vd hallucinationDetected kỳ vọng OR < 1).
 *
 * P3-M2 — V2 CHỈ được runtime tin (active=true) khi thắng V1 qua 5-fold
 * cross-validation STRATIFIED (giữ tỉ lệ Y mỗi fold): mỗi fold train V2 trên
 * 4 fold còn lại (chuẩn hóa bằng mean/std TẬP TRAIN fold đó — không rò rỉ
 * hold-out), đo Brier trên fold hold-out; cvBrier = mean các fold,
 * cvBrierCi = meanCI 95% (P0 stats). Đối chứng brierV1 = V1 (đúng hyperparam
 * calibration-train.ts: lr 0.01 × 1000 epoch, 1 biến raw) ĐƯỢC TRAIN LẠI
 * trên cùng 4 fold mỗi lượt — so sánh sạch hai bên, không bên nào thấy
 * hold-out. improved = cvBrier < brierV1 (ngặt — bằng nhau không算 thắng).
 *
 * Fail-open toàn bộ (đúng doctrine "calibration must never make the system
 * worse than its raw signal"): thiếu dữ liệu / lệch lớp / lỗi DB → trained
 * false, runtime V1 giữ nguyên. Rollback = set active=false.
 *
 * Determinism: GD duyệt batch theo thứ tự index (không shuffle) → cùng dữ
 * liệu luôn ra cùng model — test đối chứng được.
 */

import { db } from '@/lib/db'
import { meanCI } from '@/lib/stats'

// ==================== CONFIG ====================

/**
 * Số mẫu usable tối thiểu để train V2. V1 cần 10 (calibration-train.ts);
 * V2 có 10 đặc trưng + 5-fold stratified (mỗi lớp ≥5 mẫu/fold đều có mặt)
 * → 30 là mốc ít nhất hợp lý. Dưới đây abort trained=false (fail-open).
 */
export const MIN_TRAIN_SAMPLES_V2 = 30

/** Số mẫu để runtime TIN V2 (bằng MIN_RUNTIME_SAMPLES của V1 — calibration-train.ts) */
export const MIN_RUNTIME_SAMPLES_V2 = 20

/** Số fold CV (P3-M2 spec: 5-fold stratified) */
export const CV_FOLDS = 5

/** Cỡ mini-batch GD (đặc trưng chuẩn hóa nên hội tụ nhanh) */
const DEFAULT_BATCH_SIZE = 32

/** Learning rate GD trên đặc trưng CHUẨN HÓA (V1 lr 0.01 trên raw → V2 dùng 0.05) */
const DEFAULT_LR = 0.05

/** Số epoch GD */
const DEFAULT_EPOCHS = 1500

/** Hệ số điều chuẩn L2 (MATH.pdf §Regularization; spec P3-M1 λ=0.01) */
export const DEFAULT_L2 = 0.01

/** Hyperparam V1 đối chứng — PHẢI khớp calibration-train.ts (lr 0.01 × 1000) */
const V1_LR = 0.01
const V1_EPOCHS = 1000

// ==================== FEATURE DEFINITION ====================

/** Thứ tự đặc trưng — KHỞI TẠO MỘT LẦN, mọi JSON trong DB khớp theo thứ tự này */
export const FEATURE_NAMES: readonly string[] = [
  'rawConfidence',
  'coverage',
  'answered',
  'retrievedChunksLog1p',
  'extractionF1',
  'hallucinationDetected',
  'difficulty',
  'categoryProgramming',
  'categoryMl',
  'categorySecurity',
] as const

/** Ngưỡng Y của V2 — giữ NGUYÊN semantics V1 (faithfulnessMedian > 0.7) */
export const FAITHFULNESS_THRESHOLD = 0.7

/**
 * Context đặc trưng cho V2. Training: mọi trường lấy từ EvalResult (+ join
 * EvalCase). Runtime: caller chỉ có rawConfidence → truyền partial, đặc trưng
 * thiếu được thay bằng mean tập train (chuẩn hóa = 0) — không bắt caller đo lại.
 */
export interface FeatureCtx {
  rawConfidence: number
  coverage?: number
  answered?: boolean
  retrievedChunks?: number
  extractionF1?: number
  hallucinationDetected?: boolean
  /** easy | medium | hard (khác/h_thiếu → medium 0.5) */
  difficulty?: string
  /** programming | algorithm | ml | security | linux | negative | mixed */
  category?: string
}

/** map difficulty → 0 / 0.5 / 1 (không nhận diện được → medium 0.5) */
function difficultyScore(d: string | null | undefined): number {
  if (d === 'easy') return 0
  if (d === 'hard') return 1
  return 0.5 // medium + unknown
}

/** One-hot gộp: programming|ml|security|other → 3 nhị phân (other = 0,0,0).
 *  Category thiếu (undefined) → null (mean impute) — phân biệt "đã biết là
 *  other" với "không biết". */
function oneHotCategory(
  ctx: Partial<FeatureCtx>,
  which: 'programming' | 'ml' | 'security',
): number | null {
  if (ctx.category === undefined) return null
  return (ctx.category as string).toLowerCase() === which ? 1 : 0
}

/**
 * Xây vector đặc trưng THÔ (chưa chuẩn hóa) theo FEATURE_NAMES.
 * Trường thiếu → null (bên chuẩn hóa thay bằng mean — impute trung bình).
 * Export riêng để test độc lập (spec P3-M1 bước 2: "feature builder test
 * độc lập trước").
 */
export function buildFeatureVector(ctx: Partial<FeatureCtx>): (number | null)[] {
  return [
    typeof ctx.rawConfidence === 'number' && Number.isFinite(ctx.rawConfidence)
      ? ctx.rawConfidence
      : null,
    typeof ctx.coverage === 'number' && Number.isFinite(ctx.coverage) ? ctx.coverage : null,
    typeof ctx.answered === 'boolean' ? (ctx.answered ? 1 : 0) : null,
    typeof ctx.retrievedChunks === 'number' && Number.isFinite(ctx.retrievedChunks)
      ? Math.log1p(Math.max(0, ctx.retrievedChunks))
      : null,
    typeof ctx.extractionF1 === 'number' && Number.isFinite(ctx.extractionF1)
      ? ctx.extractionF1
      : null,
    typeof ctx.hallucinationDetected === 'boolean'
      ? ctx.hallucinationDetected ? 1 : 0
      : null,
    ctx.difficulty === undefined || ctx.difficulty === null ? null : difficultyScore(ctx.difficulty),
    oneHotCategory(ctx, 'programming'),
    oneHotCategory(ctx, 'ml'),
    oneHotCategory(ctx, 'security'),
  ]
}

// ==================== PURE MATH — LOGISTIC L2 ====================

/** Sigmoid ổn định số học (tràn exp khi |z| lớn) */
function sigmoid(z: number): number {
  if (z >= 0) return 1 / (1 + Math.exp(-z))
  const e = Math.exp(z)
  return e / (1 + e)
}

export interface LogisticModel {
  intercept: number
  coefficients: number[]
}

export interface LogisticL2Options {
  lr?: number
  epochs?: number
  l2?: number
  batchSize?: number
}

/**
 * Logistic regression đa biến — gradient descent mini-batch + L2.
 * X đã chuẩn hóa (caller tự chuẩn hóa bằng stats tập train). L2 áp lên
 * COEFFICIENTS (không phạt intercept — chuẩn Regularization). Duyệt batch
 * theo thứ tự index — deterministic.
 * Throw khi dữ liệu rỗng/kích thước lệch (caller đã guard ở tầng trên).
 */
export function trainLogisticL2(X: number[][], y: number[], opts: LogisticL2Options = {}): LogisticModel {
  const n = X.length
  if (n === 0) throw new Error('trainLogisticL2: tập rỗng')
  const d = X[0].length
  if (d === 0) throw new Error('trainLogisticL2: không có đặc trưng')
  if (y.length !== n) throw new Error(`trainLogisticL2: X (${n}) lệch y (${y.length})`)
  for (let i = 0; i < n; i++) {
    if (X[i].length !== d) throw new Error(`trainLogisticL2: hàng ${i} có ${X[i].length} đặc trưng (cần ${d})`)
  }

  const lr = opts.lr ?? DEFAULT_LR
  const epochs = opts.epochs ?? DEFAULT_EPOCHS
  const l2 = opts.l2 ?? DEFAULT_L2
  const batch = Math.max(1, Math.min(opts.batchSize ?? DEFAULT_BATCH_SIZE, n))

  const intercept = 0
  const coefficients = new Array<number>(d).fill(0)
  const model: LogisticModel = { intercept, coefficients }

  for (let e = 0; e < epochs; e++) {
    for (let start = 0; start < n; start += batch) {
      const end = Math.min(start + batch, n)
      const m = end - start
      let gradIntercept = 0
      const gradCoef = new Array<number>(d).fill(0)
      for (let i = start; i < end; i++) {
        const xi = X[i]
        let z = model.intercept
        for (let j = 0; j < d; j++) z += model.coefficients[j] * xi[j]
        const err = sigmoid(z) - y[i]
        gradIntercept += err
        for (let j = 0; j < d; j++) gradCoef[j] += err * xi[j]
      }
      model.intercept -= (lr * gradIntercept) / m
      for (let j = 0; j < d; j++) {
        // L2: β ← β − lr·(grad/m + λ·β) — phạt trọng số lớn, chống quá khớp
        model.coefficients[j] -= lr * (gradCoef[j] / m + l2 * model.coefficients[j])
      }
    }
  }
  return model
}

/** P(complete) = σ(intercept + Σβ·x) — x đã chuẩn hóa cùng stats tập train */
export function predictLogistic(model: LogisticModel, x: number[]): number {
  let z = model.intercept
  for (let j = 0; j < model.coefficients.length; j++) z += model.coefficients[j] * (x[j] ?? 0)
  return sigmoid(z)
}

/** Brier score thuần: mean((p − y)²) — của fold hold-out */
export function brier(preds: number[], ys: number[]): number {
  if (preds.length === 0) return Number.NaN
  let s = 0
  for (let i = 0; i < preds.length; i++) s += (preds[i] - ys[i]) * (preds[i] - ys[i])
  return s / preds.length
}

// ==================== STANDARDIZATION ====================

/** mean/std theo CỘT trên các giá trị khác null. std < 1e-12 → 1 (chống chia 0
 *  — đặc trưng hằng trong tập train thì giá trị chuẩn hóa luôn 0). Cột toàn
 *  null → mean 0/std 1 (impute = 0 sau chuẩn hóa). */
export function computeColumnStats(X: (number | null)[][]): { means: number[]; stds: number[] } {
  const d = X[0]?.length ?? 0
  const means = new Array<number>(d).fill(0)
  const stds = new Array<number>(d).fill(1)
  for (let j = 0; j < d; j++) {
    const vals: number[] = []
    for (let i = 0; i < X.length; i++) {
      const v = X[i][j]
      if (typeof v === 'number' && Number.isFinite(v)) vals.push(v)
    }
    if (vals.length === 0) continue // mean 0 / std 1 — impute an toàn
    const m = vals.reduce((s, v) => s + v, 0) / vals.length
    let acc = 0
    for (const v of vals) acc += (v - m) * (v - m)
    const sd = Math.sqrt(acc / vals.length) // std tổng thể (population) — chuẩn hóa z
    means[j] = m
    stds[j] = sd < 1e-12 ? 1 : sd
  }
  return { means, stds }
}

/** Chuẩn hóa 1 hàng: null → 0 (= mean tập train — impute trung bình) */
function standardizeRow(row: (number | null)[], means: number[], stds: number[]): number[] {
  return row.map((v, j) => (typeof v === 'number' && Number.isFinite(v) ? (v - means[j]) / stds[j] : 0))
}

// ==================== P3-M2 — k-FOLD CROSS-VALIDATION ====================

/**
 * Gán fold stratified: positive/negative chia đều round-robin vào `folds`
 * fold (giữ tỉ lệ Y mỗi fold). Lớp nào ít hơn `folds` mẫu → null (không
 * stratified được — caller abort, KHÔNG fall back về CV thường vì fold có
 * thể mất hẳn 1 lớp làm Brier vô nghĩa).
 */
export function stratifiedFoldAssignments(y: number[], folds: number): number[] | null {
  if (folds < 2) return null
  const pos: number[] = []
  const neg: number[] = []
  for (let i = 0; i < y.length; i++) (y[i] > 0.5 ? pos : neg).push(i)
  if (pos.length < folds || neg.length < folds) return null
  const assign = new Array<number>(y.length).fill(-1)
  pos.forEach((idx, k) => { assign[idx] = k % folds })
  neg.forEach((idx, k) => { assign[idx] = k % folds })
  return assign
}

export interface CvOutcome {
  /** Brier hold-out trung bình của V2 qua các fold */
  cvBrier: number
  /** 95% CI của fold Brier (meanCI P0 stats) — NaN khi <2 fold */
  cvBrierCiLo: number
  cvBrierCiHi: number
  /** Brier hold-out trung bình của V1 (train lại từng fold — đối chứng sạch) */
  brierV1: number
  /** cvBrier < brierV1 (ngặt) — điều kiện DUY NHẤT set active=true */
  improved: boolean
  foldBriers: number[]
  foldBriersV1: number[]
}

/**
 * V1 đối chứng — tái tạo ĐÚNG hyperparam calibration-train.ts (lr 0.01 ×
 * 1000 epoch, init intercept=0/coef=1, 1 biến raw không chuẩn hóa). Copy
 * có chủ đích (không import calibration-train để giữ module này thuần toán
 * không phụ thuộc db).
 */
function trainLogisticV1(x: number[], y: number[]): { intercept: number; coef: number } {
  let intercept = 0
  let coef = 1
  for (let e = 0; e < V1_EPOCHS; e++) {
    let gradIntercept = 0
    let gradCoef = 0
    for (let i = 0; i < x.length; i++) {
      const pred = sigmoid(intercept + coef * x[i])
      gradIntercept += pred - y[i]
      gradCoef += (pred - y[i]) * x[i]
    }
    intercept -= (V1_LR * gradIntercept) / x.length
    coef -= (V1_LR * gradCoef) / x.length
  }
  return { intercept, coef }
}

/**
 * 5-fold stratified CV so V2 vs V1 (P3-M2). Mỗi fold:
 *   - stats chuẩn hóa tính trên 4 fold TRAIN (không nhìn hold-out);
 *   - V2: train logistic L2 trên train đã chuẩn hóa → Brier trên hold-out;
 *   - V1: train lại đúng quy trình V1 trên raw x1 của train → Brier hold-out.
 * Trả null khi không gán fold được (lệch lớp) — caller abort.
 */
export function crossValidateMultifeature(
  X: (number | null)[][],
  y: number[],
  opts: LogisticL2Options & { folds?: number } = {},
): CvOutcome | null {
  const folds = opts.folds ?? CV_FOLDS
  const assign = stratifiedFoldAssignments(y, folds)
  if (!assign) return null

  const foldBriers: number[] = []
  const foldBriersV1: number[] = []
  for (let f = 0; f < folds; f++) {
    const trainIdx: number[] = []
    const holdIdx: number[] = []
    for (let i = 0; i < y.length; i++) (assign[i] === f ? holdIdx : trainIdx).push(i)

    // --- V2: chuẩn hóa bằng stats TẬP TRAIN (chống rò rỉ hold-out) ---
    const trainRows = trainIdx.map(i => X[i])
    const { means, stds } = computeColumnStats(trainRows)
    const trainStd = trainIdx.map(i => standardizeRow(X[i], means, stds))
    const holdStd = holdIdx.map(i => standardizeRow(X[i], means, stds))
    const model = trainLogisticL2(
      trainStd,
      trainIdx.map(i => y[i]),
      opts,
    )
    const predsV2 = holdStd.map(row => predictLogistic(model, row))
    foldBriers.push(brier(predsV2, holdIdx.map(i => y[i])))

    // --- V1 đối chứng: train lại trên raw x1 của cùng tập train ---
    const v1 = trainLogisticV1(
      trainIdx.map(i => (typeof X[i][0] === 'number' ? (X[i][0] as number) : 0)),
      trainIdx.map(i => y[i]),
    )
    const predsV1 = holdIdx.map(i => sigmoid(v1.intercept + v1.coef * (typeof X[i][0] === 'number' ? (X[i][0] as number) : 0)))
    foldBriersV1.push(brier(predsV1, holdIdx.map(i => y[i])))
  }

  const cvBrier = foldBriers.reduce((s, v) => s + v, 0) / foldBriers.length
  const brierV1 = foldBriersV1.reduce((s, v) => s + v, 0) / foldBriersV1.length
  const ci = meanCI(foldBriers)
  return {
    cvBrier,
    cvBrierCiLo: ci.low,
    cvBrierCiHi: ci.high,
    brierV1,
    improved: cvBrier < brierV1,
    foldBriers,
    foldBriersV1,
  }
}

// ==================== TRAIN (DB) ====================

export interface MultiFeatureTrainResult {
  /** true khi model đã được upsert vào CalibrationModelV2 */
  trained: boolean
  /** Số mẫu vào training (bằng usable khi trained) */
  sampleSize: number
  /** P3-M2 — Brier CV của V2 (null khi không train được) */
  cvBrier: number | null
  /** P3-M2 — Brier CV của V1 đối chứng (null khi không train được) */
  brierV1: number | null
  /** cvBrier < brierV1 — flag active được set theo đúng giá trị này */
  improved: boolean
  /** e^β theo tên đặc trưng — diễn giải "tăng 1σ → odds ×OR" */
  oddsRatios: Record<string, number>
  /** Số EvalResult usable (có rawConfidence + faithfulnessMedian hữu hạn) */
  usable: number
  /** Tổng EvalResult đọc được */
  total: number
  /** Lý do không train (khi trained=false) */
  error?: string
}

/**
 * Đọc EvalResult (+ join thủ công EvalCase — schema không có relation) →
 * train V2 đa biến + 5-fold CV so V1 → upsert CalibrationModelV2.
 * active=true CHỈ khi CV thắng. KHÔNG throw khi thiếu dữ liệu (trả
 * trained=false + error — caller surface). Fail-open tuyệt đối.
 */
export async function trainCalibrationModelV2(): Promise<MultiFeatureTrainResult> {
  const [results, cases] = await Promise.all([
    db.evalResult.findMany({
      select: {
        rawConfidence: true,
        faithfulnessMedian: true,
        coverage: true,
        answered: true,
        retrievedChunks: true,
        extractionF1: true,
        hallucinationDetected: true,
        caseId: true,
      },
      take: 5000,
      orderBy: { createdAt: 'desc' },
    }),
    db.evalCase.findMany({ select: { id: true, difficulty: true, category: true } }),
  ])
  const caseMap = new Map(cases.map(c => [c.id, c]))

  const usable = results.filter(
    r => typeof r.rawConfidence === 'number' && Number.isFinite(r.rawConfidence)
      && typeof r.faithfulnessMedian === 'number' && Number.isFinite(r.faithfulnessMedian),
  )

  const notTrained = (error: string): MultiFeatureTrainResult => ({
    trained: false,
    sampleSize: 0,
    cvBrier: null,
    brierV1: null,
    improved: false,
    oddsRatios: {},
    usable: usable.length,
    total: results.length,
    error,
  })

  if (usable.length < MIN_TRAIN_SAMPLES_V2) {
    return notTrained(
      `insufficient data: only ${usable.length} usable EvalResult rows (need ${MIN_TRAIN_SAMPLES_V2}+) — run more evals first`,
    )
  }

  const ctxs: FeatureCtx[] = usable.map(r => {
    const c = caseMap.get(r.caseId)
    return {
      rawConfidence: r.rawConfidence as number,
      coverage: r.coverage,
      answered: r.answered,
      retrievedChunks: r.retrievedChunks,
      extractionF1: r.extractionF1,
      hallucinationDetected: r.hallucinationDetected,
      difficulty: c?.difficulty ?? undefined,
      category: c?.category ?? undefined,
    }
  })
  const X = ctxs.map(buildFeatureVector)
  const y = usable.map(r => ((r.faithfulnessMedian as number) > FAITHFULNESS_THRESHOLD ? 1 : 0))

  // P3-M2 — CV TRƯỚC khi tin model: lệch lớp (một lớp < 5 mẫu) → abort
  const cv = crossValidateMultifeature(X, y)
  if (!cv) {
    return notTrained(
      `class imbalance: cần ≥${CV_FOLDS} mẫu MỖI lớp (faithful/unfaithful) cho ${CV_FOLDS}-fold stratified CV — Positive${y.filter(v => v === 1).length}/Negative${y.filter(v => v === 0).length}`,
    )
  }

  // Model cuối trên TOÀN BỘ dữ liệu (stats chuẩn hóa full-data)
  const { means, stds } = computeColumnStats(X)
  const Xstd = X.map(row => standardizeRow(row, means, stds))
  const model = trainLogisticL2(Xstd, y)

  const oddsRatios: Record<string, number> = {}
  FEATURE_NAMES.forEach((name, j) => {
    oddsRatios[name] = Math.exp(model.coefficients[j])
  })

  const active = cv.improved
  const cvBrierCi =
    Number.isFinite(cv.cvBrierCiLo) && Number.isFinite(cv.cvBrierCiHi)
      ? JSON.stringify([round5(cv.cvBrierCiLo), round5(cv.cvBrierCiHi)])
      : null

  await db.calibrationModelV2.upsert({
    where: { id: 'default' },
    create: {
      id: 'default',
      featureNames: JSON.stringify(FEATURE_NAMES),
      means: JSON.stringify(means.map(round5)),
      stds: JSON.stringify(stds.map(round5)),
      coefficients: JSON.stringify(model.coefficients.map(round5)),
      intercept: round5(model.intercept),
      oddsRatios: JSON.stringify(
        Object.fromEntries(Object.entries(oddsRatios).map(([k, v]) => [k, round5(v)])),
      ),
      sampleSize: y.length,
      cvBrier: round5(cv.cvBrier),
      cvBrierCi,
      brierV1: round5(cv.brierV1),
      active,
    },
    update: {
      featureNames: JSON.stringify(FEATURE_NAMES),
      means: JSON.stringify(means.map(round5)),
      stds: JSON.stringify(stds.map(round5)),
      coefficients: JSON.stringify(model.coefficients.map(round5)),
      intercept: round5(model.intercept),
      oddsRatios: JSON.stringify(
        Object.fromEntries(Object.entries(oddsRatios).map(([k, v]) => [k, round5(v)])),
      ),
      sampleSize: y.length,
      cvBrier: round5(cv.cvBrier),
      cvBrierCi,
      brierV1: round5(cv.brierV1),
      active,
    },
  })

  return {
    trained: true,
    sampleSize: y.length,
    cvBrier: round5(cv.cvBrier),
    brierV1: round5(cv.brierV1),
    improved: cv.improved,
    oddsRatios,
    usable: usable.length,
    total: results.length,
  }
}

/** Làm tròn 5 chữ số lẻ cho JSON lưu DB (đủ đọc, gọn log) */
function round5(v: number): number {
  return Math.round(v * 100000) / 100000
}

// ==================== RUNTIME APPLY ====================

/** Model V2 đã parse từ row DB (thuần toán — applyV2Model không đụng db) */
export interface ParsedV2Model {
  means: number[]
  stds: number[]
  coefficients: number[]
  intercept: number
}

/**
 * Parse CalibrationModelV2 row → ParsedV2Model. Kiểm tra kích thước JSON khớp
 * FEATURE_NAMES — sai cấu trúc (model cũ/DB hỏng) → null (caller fallback V1).
 */
export function parseV2ModelJson(row: {
  featureNames: string
  means: string
  stds: string
  coefficients: string
  intercept: number
}): ParsedV2Model | null {
  try {
    const names = JSON.parse(row.featureNames) as unknown
    const means = JSON.parse(row.means) as unknown
    const stds = JSON.parse(row.stds) as unknown
    const coefficients = JSON.parse(row.coefficients) as unknown
    if (!Array.isArray(names) || !Array.isArray(means) || !Array.isArray(stds) || !Array.isArray(coefficients)) return null
    const d = FEATURE_NAMES.length
    if (names.length !== d || means.length !== d || stds.length !== d || coefficients.length !== d) return null
    const ok = (arr: unknown[]): arr is number[] =>
      arr.length === d && arr.every(v => typeof v === 'number' && Number.isFinite(v))
    if (!ok(means) || !ok(stds) || !ok(coefficients) || !Number.isFinite(row.intercept)) return null
    return { means, stds, coefficients, intercept: row.intercept }
  } catch {
    return null
  }
}

/**
 * Áp V2 cho 1 context: chuẩn hóa từng đặc trưng (thiếu → 0 = mean train) →
 * σ(intercept + Σβ·ẑ). Kết quả clamp [0,1] — confidence đầu ra hợp lệ mọi khi.
 */
export function applyV2Model(model: ParsedV2Model, ctx: Partial<FeatureCtx>): number {
  const raw = buildFeatureVector(ctx)
  let z = model.intercept
  for (let j = 0; j < model.coefficients.length; j++) {
    const v = raw[j]
    const zj = typeof v === 'number' && Number.isFinite(v) ? (v - model.means[j]) / model.stds[j] : 0
    z += model.coefficients[j] * zj
  }
  return Math.min(1, Math.max(0, sigmoid(z)))
}

/**
 * Runtime V2 (API đầy đủ — caller có context đặc trưng truyền vào để hưởng
 * đủ 10 đặc trưng). V2 không active/chưa đủ mẫu/parse lỗi → fallback V1
 * getCalibratedConfidence (dynamic import tránh vòng import tĩnh:
 * calibration.ts cũng import parseV2ModelJson/applyV2Model từ file này).
 * Thiếu features hoàn toàn → fallback V1 luôn (spec P3-M1: "thiếu features
 * → fallback v1").
 */
export async function getCalibratedConfidenceV2(
  rawConfidence: number,
  features?: Partial<FeatureCtx>,
): Promise<number> {
  try {
    if (features === undefined) {
      // Spec P3-M1: "thiếu features → fallback v1" — gọi THẲNG đường V1 thuần
      // (getCalibratedConfidenceV1), không qua getCalibratedConfidence (vốn
      // ưu tiên V2-active — sẽ mâu thuẫn với semantics hàm này).
      const { getCalibratedConfidenceV1 } = await import('./calibration')
      return await getCalibratedConfidenceV1(rawConfidence)
    }
    const row = await db.calibrationModelV2.findUnique({ where: { id: 'default' } })
    if (!row || !row.active || row.sampleSize < MIN_RUNTIME_SAMPLES_V2) {
      const { getCalibratedConfidenceV1 } = await import('./calibration')
      return await getCalibratedConfidenceV1(rawConfidence)
    }
    const parsed = parseV2ModelJson(row)
    if (!parsed) {
      const { getCalibratedConfidenceV1 } = await import('./calibration')
      return await getCalibratedConfidenceV1(rawConfidence)
    }
    return applyV2Model(parsed, { rawConfidence, ...features })
  } catch {
    return rawConfidence // fail-open tuyệt đối — không tệ hơn raw signal
  }
}
