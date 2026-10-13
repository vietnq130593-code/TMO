/**
 * BRAIN-P2 · BRAIN-A "V3" — CALIBRATION MLP THAY LOGISTIC (blueprint §4.2)
 * ============================================================================
 *
 * Não thứ nhất của panel "Não vận hành": mạng MLP 10→16(tanh)→1(sigmoid)+BCE
 * (nền toán BRAIN-P1 — src/lib/brain/mlp.ts) thay logistic V2 cho KB
 * retrieval confidence. KẾ THỪA NGUYÊN VẸN pattern thăng cấp của V2
 * (calibration-multifeature.ts — P3-M2):
 *
 *   5-fold CV stratified → V3 CHỈ thắng khi cvBrier(V3) < cvBrier(V2)
 *   (NGẶT — bằng nhau không tính); V2 đối chứng ĐƯỢC TRAIN LẠI trên cùng
 *   4 fold mỗi lượt (đúng hyperparam production V2 qua crossValidate
 *   Multifeature); dưới 30 mẫu usable → không train (ngủ); fail-open tuyệt
 *   đối — runtime KHÔNG BAO GIỜ tệ hơn tín hiệu thô (V2/V1/raw giữ chuỗi cũ).
 *
 * Đầu vào phase này: inputMode 'features-10' — ĐÚNG 10 đặc trưng của V2
 * (buildFeatureVector + FEATURE_NAMES tái dùng nguyên vẹn) → so sánh sạch
 * cùng input, không thay đổi nguồn nhãn (EvalResult ⨯ EvalCase,
 * Y = faithfulnessMedian > 0.7). Các mode vector 'pca-128'/'mrl-512' phụ
 * thuộc quyết định mở Q2 (blueprint §3.2 — chưa chốt) → từ chối rõ ràng
 * tới khi có đối chứng CV riêng.
 *
 * Runtime (chuỗi V1→V2→V3 — src/lib/calibration.ts): V3 chỉ được thử
 * TRƯỚC V2 khi cờ `calibration_v3` (STORE > ENV > DEFAULT=off — tuning
 * store) bật VÀ có bản BrainModel active (chính là kết luận "thắng CV")
 * VÀ nSamples ≥ 20. Mọi nhánh không áp được → caller rơi đúng chuỗi cũ
 * — không có đường nào V3 làm runtime tệ hơn.
 *
 * Ghi DB: bảng BrainModel (P1-UI, model 99 — không migration mới):
 *   brain='calibration_v3' · version tăng dần · inputMode='features-10'
 *   · specJson = MlpSpec (nạp lại bằng `new MLP(spec)`)
 *   · weightsJson = envelope serialize numpy-đọc-được (nạp lại bằng
 *     MLP.deserialize — audit A6)
 *   · trainMetaJson = {nSamples, cvScore+CI, brierV2, improved,
 *     standardization{means,stds}, fit, dataLineage} (blueprint §5.3)
 * Bất biến A1 (chỉ 1 bản active mỗi brain) giữ ở tầng ứng dụng: trước khi
 * insert bản active mới → updateMany tắt mọi bản active cũ. KHÔNG dùng
 * $transaction (bài học BUG2-119 — SQLite giữ lock); thứ tự ghi chọn theo
 * hướng fail-open: gãy giữa chừng → không còn bản active → runtime rơi V2.
 *
 * Prune (blueprint A2): sau mỗi lần train thành công giữ bản active +
 * BRAIN_VERSIONS_KEEP bản mới nhất (tiền lệ TUNING_CHANGE_LOG_CAP).
 *
 * Determinism: fold assignment + trainLogisticL2 + MLP.fit đều tất định
 * theo seed → cùng dữ liệu luôn ra cùng model (test r85 pin).
 */

import { createHash } from 'node:crypto'
import { db } from '@/lib/db'
import { MLP, type MlpSerialized, type MlpSpec, type FitResult, type FitOptions, type EpochStat } from './mlp'
import type { BrainDraftSpec } from './spec-schema'
import {
  BRAIN_VERSIONS_KEEP,
} from './registry'
import { acquireTrainLock, releaseTrainLock } from './train-lock'
// OBS-P1 hook (§C.3 đợt 1) — brain.train start/end; static import an toàn
// (ledger KHÔNG import ngược pipeline — check-imports sạch)
import { observeBrainTrain } from '@/lib/observation/ledger'
import { trainProgressStart, trainProgressEnd } from './train-progress'
// OBS-P2 hook (§C.3 đợt 2) — vết suy diễn organ calibrate
import { traceInference } from '@/lib/observation/trace'
import {
  FEATURE_NAMES,
  FAITHFULNESS_THRESHOLD,
  CV_FOLDS,
  MIN_TRAIN_SAMPLES_V2,
  buildFeatureVector,
  computeColumnStats,
  crossValidateMultifeature,
  stratifiedFoldAssignments,
  type FeatureCtx,
} from '@/lib/calibration-multifeature'
import { meanCI } from '@/lib/stats'
import { getTuningEnum } from '@/lib/learning/tuning-store'

// ==================== CONFIG ====================

/**
 * Số mẫu usable tối thiểu để train V3 — blueprint §4.2 "dưới 30 mẫu →
 * không train (ngủ)" (trùng MIN_TRAIN_SAMPLES_V2: cùng nguồn nhãn, cùng
 * ngưỡng thức tỉnh signal EvalResult=30 trong BRAIN_REGISTRY).
 */
export const MIN_TRAIN_SAMPLES_V3 = 30

/** Số mẫu để runtime TIN V3 (bằng MIN_RUNTIME_SAMPLES V1/V2 — calibration.ts / calibration-multifeature.ts) */
export const MIN_RUNTIME_SAMPLES_V3 = 20

/** Mode đầu vào duy nhất của phase này (mode vector chờ Q2 — xem header) */
export const V3_INPUT_MODE = 'features-10'

/** Kiểm tra inputMode hợp lệ của V3 (mode lạ → lỗi rõ ràng, không im lặng) */
export function isSupportedV3InputMode(mode: string): boolean {
  return mode === V3_INPUT_MODE
}

// ---- Kiến trúc khởi điểm (blueprint §4.2: features-10: 10→16(tanh)→1(sigmoid)+BCE) ----

/** Seed tất định V3 — cùng dữ liệu → cùng weights bit-đối-bit (test r85) */
export const V3_SEED = 42
const V3_LR = 0.01
const V3_L2 = 0.01
const V3_EPOCHS = 500
const V3_PATIENCE = 50
const V3_BATCH = 32

/**
 * Xây MlpSpec V3 — thuần, xuất cho test pin kiến trúc (r85-A).
 * BRAIN-UX §9.2 — override (tùy chọn, từ BrainSpecDraft qua useDraft): thay
 * LỚP ẨN + optimizer/lr/l2/seed; input/output + loss KHÓA theo hợp đồng
 * pipeline (§9.1-2). Không truyền = ĐÚNG spec gốc (hồi quy r88/r89 pin).
 */
export function buildV3Spec(override?: BrainDraftSpec): MlpSpec {
  const base = buildV3SpecDefault()
  if (!override) return base
  return {
    ...base,
    layers: [
      base.layers[0], // input khóa features-10
      // BRAIN-TAB-3PHAN (18-d): truyền α/β + δ Huber từ draft — engine hỗ trợ
      // sẵn từ BRAIN-P1 (activations.ts/losses.ts), giờ mới lộ UI. Conditional
      // spread để KHÔNG tạo key undefined (pin r88-E: layers[1] toEqual
      // {units, activation} khi draft mặc định không có params). Loss bce →
      // không lossParams.
      ...override.hidden.map(h => ({ units: h.units, activation: h.activation, ...(h.activationParams ? { activationParams: h.activationParams } : {}) })),
      base.layers[base.layers.length - 1], // output khóa 1·sigmoid (hợp đồng BCE)
    ],
    optimizer: override.hyper.optimizer,
    lr: override.hyper.lr,
    l2: override.hyper.l2,
    seed: override.hyper.seed,
  }
}

function buildV3SpecDefault(): MlpSpec {
  return {
    layers: [
      // Lớp input: activation bị bỏ qua ở forward (hợp đồng dữ liệu — UX-1
      // §9.2 khoá cứng) nhưng validateSpec yêu cầu tên hợp lệ → 'linear'
      // (tiền lệ test r84).
      { units: FEATURE_NAMES.length, activation: 'linear' },
      { units: 16, activation: 'tanh' },
      { units: 1, activation: 'sigmoid' },
    ],
    loss: 'bce',
    optimizer: 'adam',
    lr: V3_LR,
    l2: V3_L2,
    seed: V3_SEED,
  }
}

// ==================== CHUẨN HÓA (kế thừa semantics V2) ====================

/**
 * Chuẩn hóa 1 hàng đặc trưng theo stats tập train: null/không hữu hạn → 0
 * (= mean tập train — impute trung bình, đúng standardizeRow của V2).
 */
function standardizeRow(row: (number | null)[], means: number[], stds: number[]): number[] {
  return row.map((v, j) =>
    typeof v === 'number' && Number.isFinite(v) ? (v - means[j]) / stds[j] : 0,
  )
}

// ==================== 5-FOLD CV — V3 vs V2 ĐỐI CHỨNG ====================

export interface V3CvOutcome {
  /** Brier hold-out trung bình của V3 qua các fold */
  cvBrier: number
  /** 95% CI của fold Brier V3 (meanCI — P0 stats) */
  cvBrierCiLo: number
  cvBrierCiHi: number
  /** Brier hold-out trung bình của V2 đối chứng (train lại từng fold) */
  brierV2: number
  /** cvBrier < brierV2 (NGẶT) — điều kiện DUY NHẤT set active=true */
  improved: boolean
  foldBriers: number[]
}

/**
 * 5-fold stratified CV so V3 (MLP) vs V2 (logistic đối chứng):
 *   - Gán fold bằng ĐÚNG stratifiedFoldAssignments của V2 → 2 mô hình chia
 *     ĐỦNG CÙNG các fold (so sánh sạch hold-out đựng từng cặp).
 *   - Mỗi fold V3: stats chuẩn hóa tính trên 4 fold TRAIN (không rò rỉ
 *     hold-out — đúng kỷ luật V2) → MLP fit → Brier trên fold hold-out.
 *   - V2 đối chứng: crossValidateMultifeature(X, y) — đúng hyperparam
 *     production V2 (train lại từng fold), single-source không copy công
 *     thức (doctrine #9).
 * Trả null khi không gán fold được (lệch lớp HOẶC folds không hợp lệ —
 * phải là số nguyên ≥ 2) — caller abort, KHÔNG fallback.
 *
 * Hợp đồng ném lỗi (FB-BRAIN-P2-R1-03): X.length ≠ y.length là lỗi lập
 * trình caller → throw Error rõ ràng (trước đây: X dài hơn bị cắt âm
 * thầm / X ngắn hơn TypeError mù 'X[i][j]').
 */
export function crossValidateV3(
  X: (number | null)[][],
  y: number[],
  opts: { folds?: number; override?: BrainDraftSpec } = {},
): V3CvOutcome | null {
  if (X.length !== y.length) {
    throw new Error(
      `crossValidateV3: X.length (${X.length}) phải bằng y.length (${y.length}) — lỗi lập trình caller`,
    )
  }
  const folds = opts.folds ?? CV_FOLDS
  // folds phải nguyên ≥ 2 — 5.5 từng chạy 6 fold, NaN từng trả outcome NaN
  // (FB-BRAIN-P2-R1-04)
  if (!Number.isInteger(folds) || folds < 2) return null
  const assign = stratifiedFoldAssignments(y, folds)
  if (!assign) return null

  const foldBriers: number[] = []
  for (let f = 0; f < folds; f++) {
    const trainIdx: number[] = []
    const holdIdx: number[] = []
    for (let i = 0; i < y.length; i++) (assign[i] === f ? holdIdx : trainIdx).push(i)

    // Stats chuẩn hóa TẬP TRAIN fold (chống rò rỉ hold-out)
    const { means, stds } = computeColumnStats(trainIdx.map(i => X[i]))
    const trainStd = trainIdx.map(i => standardizeRow(X[i], means, stds))
    const holdStd = holdIdx.map(i => standardizeRow(X[i], means, stds))

    // BRAIN-UX §9.2 — CV đánh giá ĐÚNG kiến trúc draft (không phải spec gốc)
    const mlp = new MLP(buildV3Spec(opts.override))
    mlp.fit(
      trainStd,
      trainIdx.map(i => [y[i]]), // output 1 unit — y bao [[0]] / [[1]]
      draftFitOptions(opts.override, { epochs: V3_EPOCHS, batchSize: V3_BATCH, patience: V3_PATIENCE }),
    )
    const preds = holdStd.map(row => mlp.predictProba(row))
    let s = 0
    for (let k = 0; k < preds.length; k++) s += (preds[k] - y[holdIdx[k]]) * (preds[k] - y[holdIdx[k]])
    foldBriers.push(s / preds.length)
  }

  // V2 đối chứng — cùng stratified folds (hàm gán tất định, cùng y/folds
  // → cùng chia; null chỉ khi lệch lớp, đã guard phía trên)
  const cv2 = crossValidateMultifeature(X, y, { folds })
  if (!cv2) return null

  const cvBrier = foldBriers.reduce((s, v) => s + v, 0) / foldBriers.length
  const ci = meanCI(foldBriers)
  return {
    cvBrier,
    cvBrierCiLo: ci.low,
    cvBrierCiHi: ci.high,
    brierV2: cv2.cvBrier,
    improved: cvBrier < cv2.cvBrier, // NGẶT — bằng nhau không tính (pattern V2)
    foldBriers,
  }
}

// ==================== TRAIN (DB) ====================

export interface V3TrainResult {
  /** true khi model đã được ghi BrainModel (kể cả bản thua CV — lưu vết audit) */
  trained: boolean
  /** Version vừa ghi (null khi không train) */
  version: number | null
  /** Trạng thái active của bản vừa ghi — CHỈ true khi CV thắng V2 */
  active: boolean
  sampleSize: number
  cvBrier: number | null
  cvBrierCi: [number, number] | null
  /** Brier CV của V2 đối chứng (train lại từng fold) */
  brierV2: number | null
  improved: boolean
  usable: number
  total: number
  error?: string
  /** BRAIN-UX §9.3 — quỹ đạo epoch (hiển thị sau khi train xong). */
  history?: EpochStat[]
  /** BRAIN-UX §9.4 — |gradient| trung bình từng lớp. */
  gradAbsMean?: number[]
  /** BRAIN-UX — train từ bản nháp UX-2 (provenance). */
  draftUsed?: boolean
}

/** Làm tròn 5 chữ số lẻ cho JSON lưu DB (đủ đọc, gọn — cùng V2) */
function round5(v: number): number {
  return Math.round(v * 100000) / 100000
}

/**
 * BRAIN-UX §9.3 nhóm A — FitOptions từ draft (override) hoặc hằng số gốc.
 * Không override → ĐÚNG options cũ {epochs, batchSize, patience} (holdout/
 * clip rơi mặc định mlp.ts 0.15/5) — pin hồi quy r88. Có override → đủ 5
 * trường từ hyper draft (đã validate phạm vi §9.3 tại PUT spec-draft).
 */
function draftFitOptions(
  override: BrainDraftSpec | undefined,
  defaults: { epochs: number; batchSize: number; patience: number },
): FitOptions {
  if (!override) return { ...defaults }
  return {
    epochs: override.hyper.epochs,
    batchSize: override.hyper.batch,
    patience: override.hyper.patience,
    holdOutRatio: override.hyper.holdout,
    clipNorm: override.hyper.clip,
  }
}

/**
 * Đọc EvalResult (+ join thủ công EvalCase) → 5-fold CV so V2 → train model
 * cuối trên toàn dữ liệu → ghi BrainModel. active=true CHỈ khi CV thắng
 * (cvBrier < brierV2 ngặt). KHÔNG throw khi thiếu dữ liệu (trả trained=false
 * + error — caller surface); chỉ lỗi DB/ghi DB thật sự mới throw (caller
 * bọc fail-open). Kế thừa toàn bộ quy trình đọc dữ liệu của
 * trainCalibrationModelV2 (cùng nguồn, cùng bộ lọc usable).
 *
 * BRAIN-P3 — single-flight lock A7 (train-lock.ts): từ P3 nguồn trigger
 * nhân lên (nút UI + auto-train sau eval run) → lệnh train trùng nhịp của
 * CÙNG brain trả trained=false (không xếp hàng, không đua version).
 */
export async function trainBrainCalibrationV3(
  inputMode: string = V3_INPUT_MODE,
  override?: BrainDraftSpec,
): Promise<V3TrainResult> {
  if (!acquireTrainLock('calibration_v3')) {
    return {
      trained: false, version: null, active: false, sampleSize: 0,
      cvBrier: null, cvBrierCi: null, brierV2: null, improved: false,
      usable: 0, total: 0,
      error: 'single-flight (A7): train khác của brain calibration_v3 đang chạy — bỏ lệnh trùng',
    }
  }
  // OBS-P1 hook (§C.3 đợt 1 — brain.train start/end; bỏ lệnh trùng A7 không phát)
  observeBrainTrain('calibration_v3', 'start', { inputMode, useDraft: override != null })
  // Task 26-BE — train-progress bus (đài quan sát v2): start SAU lock (bỏ lệnh
  // trùng A7 — cùng tiền lệ observeBrainTrain), TRƯỚC mọi query của hàm
  // Locked; end ở mọi lối ra (done/failed). Additive — không đụng logic train.
  trainProgressStart('calibration_v3', null)
  const t0 = Date.now()
  try {
    const result = await trainBrainCalibrationV3Locked(inputMode, override)
    observeBrainTrain('calibration_v3', 'end', {
      inputMode, useDraft: override != null, durationMs: Date.now() - t0, result,
    })
    // 26-BE: trained=false là "ngủ an toàn" (thiếu dữ liệu/lệch lớp) — done +
    // reason, KHÔNG phải failed; summary điền gì có sẵn (history/gradAbsMean
    // chỉ tồn tại khi trained — không chế tạo). finalLoss = trainLoss epoch
    // CUỐI của history (V3TrainResult không mang finalTrainLoss riêng).
    trainProgressEnd(
      'calibration_v3',
      true,
      {
        epochsRun: result.history?.length ?? null,
        finalLoss: result.history && result.history.length > 0
          ? result.history[result.history.length - 1].trainLoss
          : null,
        gradAbsMean: result.gradAbsMean ?? null,
      },
      result.trained ? null : result.error ?? 'ngủ an toàn (không đủ dữ liệu)',
    )
    return result
  } catch (err) {
    observeBrainTrain('calibration_v3', 'end', {
      inputMode, useDraft: override != null, durationMs: Date.now() - t0, error: err,
    })
    trainProgressEnd('calibration_v3', false) // throw → failed (bus fail-open)
    throw err
  } finally {
    releaseTrainLock('calibration_v3')
  }
}

async function trainBrainCalibrationV3Locked(
  inputMode: string,
  override?: BrainDraftSpec,
): Promise<V3TrainResult> {
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
        runId: true,
        createdAt: true,
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

  const notTrained = (error: string): V3TrainResult => ({
    trained: false, version: null, active: false, sampleSize: 0,
    cvBrier: null, cvBrierCi: null, brierV2: null, improved: false,
    usable: usable.length, total: results.length, error,
  })

  // Từ chối mode chưa hỗ trợ — kiểm SAU khi đếm usable/total để telemetry
  // trung thực (FB-BRAIN-P2-R1-08: trước đây early-return usable=0 cứng)
  if (!isSupportedV3InputMode(inputMode)) {
    return notTrained(
      `inputMode '${inputMode}' chưa hỗ trợ phase BRAIN-P2 (chỉ '${V3_INPUT_MODE}' — mode vector pca-128/mrl-512 chờ quyết định Q2 blueprint §3.2)`,
    )
  }

  if (usable.length < MIN_TRAIN_SAMPLES_V3) {
    return notTrained(
      `insufficient data: only ${usable.length} usable EvalResult rows (need ${MIN_TRAIN_SAMPLES_V3}+) — ngủ an toàn, chạy thêm eval trước`,
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

  // CV TRƯỚC khi tin model (kỷ luật V2): lệch lớp → abort
  // BRAIN-UX §9.2 — CV đánh giá kiến trúc draft khi có override
  const cv = crossValidateV3(X, y, override ? { override } : {})
  if (!cv) {
    return notTrained(
      `class imbalance: cần ≥${CV_FOLDS} mẫu MỖI lớp cho ${CV_FOLDS}-fold stratified CV — Positive=${y.filter(v => v === 1).length}/Negative=${y.filter(v => v === 0).length}`,
    )
  }

  // Model cuối trên TOÀN BỘ dữ liệu (stats chuẩn hóa full-data — đúng V2)
  const { means, stds } = computeColumnStats(X)
  const Xstd = X.map(row => standardizeRow(row, means, stds))
  const mlp = new MLP(buildV3Spec(override))
  const fit: FitResult = mlp.fit(
    Xstd,
    y.map(v => [v]),
    draftFitOptions(override, { epochs: V3_EPOCHS, batchSize: V3_BATCH, patience: V3_PATIENCE }),
  )
  const serialized: MlpSerialized = mlp.serialize()

  // Version mới = max + 1 (duyệt 1 query aggregate)
  const maxRow = await db.brainModel.aggregate({
    where: { brain: 'calibration_v3' },
    _max: { version: true },
  })
  const version = (maxRow._max.version ?? 0) + 1

  // Bất biến A1 (chỉ 1 active mỗi brain): tắt bản active cũ TRƯỚC khi ghi
  // bản active mới. Không $transaction (BUG2-119); gãy giữa chừng → không
  // còn active → runtime fail-open về V2 (hướng an toàn).
  if (cv.improved) {
    await db.brainModel.updateMany({
      where: { brain: 'calibration_v3', active: true },
      data: { active: false },
    })
  }

  // Provenance chain (blueprint §5.3) — truy vết "não học từ nguồn nào"
  const dateFrom = usable.length > 0
    ? usable.reduce((m, r) => (r.createdAt < m ? r.createdAt : m), usable[0].createdAt)
    : null
  const dateTo = usable.length > 0
    ? usable.reduce((m, r) => (r.createdAt > m ? r.createdAt : m), usable[0].createdAt)
    : null
  const runIds = new Set(usable.map(r => r.runId).filter((v): v is string => typeof v === 'string'))
  // §5.3 "danh sách episodeId/evalId/verdictId (hash tổng nếu quá dài)" —
  // FB-BRAIN-P2-R1-06: trước đây chỉ lưu SỐ LƯỢNG run; giờ lưu danh sách
  // (≤ EVAL_RUN_IDS_MAX) hoặc hash sha256 khi quá dài. EvalCase đếm đúng
  // case thật sự góp mẫu (không đếm cả case rác trong DB).
  const caseIdsUsed = new Set(usable.map(r => r.caseId))
  const runIdList = Array.from(runIds).sort()
  const EVAL_RUN_IDS_MAX = 50
  const evalRunIds: string[] | string = runIdList.length <= EVAL_RUN_IDS_MAX
    ? runIdList
    : `sha256:${createHash('sha256').update(runIdList.join('\n')).digest('hex').slice(0, 16)} (${runIdList.length} runs)`

  const trainMeta = {
    nSamples: y.length,
    cvScore: round5(cv.cvBrier),
    cvScoreCiLow: round5(cv.cvBrierCiLo),
    cvScoreCiHigh: round5(cv.cvBrierCiHi),
    metric: 'brier',
    brierV2: round5(cv.brierV2),
    improved: cv.improved,
    featureNames: FEATURE_NAMES,
    // stds GIỮ full precision — KHÔNG round5: cột near-constant (std ∈
    // (1e-12, 5e-6)) bị round5 về 0 → (v−mean)/0 = ±∞/NaN tại runtime
    // (FB-BRAIN-P2-R1-01). means vô hại với round5 (giá trị cấp 0.1–1).
    standardization: { means: means.map(round5), stds: stds.slice() },
    fit: {
      epochsRun: fit.epochsRun,
      bestEpoch: fit.bestEpoch,
      stoppedEarly: fit.stoppedEarly,
      finalTrainLoss: Number.isFinite(fit.finalTrainLoss) ? round5(fit.finalTrainLoss) : null,
    },
    // BRAIN-UX §9.4 — |gradient| trung bình từng lớp (chế độ lan truyền
    // ngược UX-3 — dữ liệu thật, không trang trí) + provenance draft UX-2
    gradAbsMean: fit.gradAbsMean.map(round5),
    draftUsed: Boolean(override),
    dataLineage: {
      tables: { EvalResult: usable.length, EvalCase: caseIdsUsed.size },
      evalRuns: runIds.size,
      evalRunIds,
      dateRange: dateFrom && dateTo ? [dateFrom.toISOString(), dateTo.toISOString()] : null,
      labelRule: `faithfulnessMedian > ${FAITHFULNESS_THRESHOLD}`,
      inputMode: V3_INPUT_MODE,
      baseline: 'V2 logistic (calibration-multifeature — train lại từng fold CV)',
      flagKey: 'calibration_v3',
    },
  }

  await db.brainModel.create({
    data: {
      brain: 'calibration_v3',
      version,
      inputMode: V3_INPUT_MODE,
      specJson: JSON.stringify(serialized.spec),
      weightsJson: JSON.stringify(serialized),
      trainMetaJson: JSON.stringify(trainMeta),
      active: cv.improved,
    },
  })

  // Prune A2: giữ bản active + N bản mới nhất (xóa sau khi ghi — bản vừa
  // tạo luôn nằm trong "N mới nhất" nên không bao giờ tự xóa mình)
  await pruneV3Versions()

  const cvBrierCi: [number, number] | null =
    Number.isFinite(cv.cvBrierCiLo) && Number.isFinite(cv.cvBrierCiHi)
      ? [round5(cv.cvBrierCiLo), round5(cv.cvBrierCiHi)]
      : null

  return {
    trained: true,
    version,
    active: cv.improved,
    sampleSize: y.length,
    cvBrier: round5(cv.cvBrier),
    cvBrierCi,
    brierV2: round5(cv.brierV2),
    improved: cv.improved,
    usable: usable.length,
    total: results.length,
    // BRAIN-UX §9.3 — quỹ đạo epoch (loss train/hold-out) hiển thị sau khi
    // train xong (MLP nhỏ chạy ~giây — stream realtime từng epoch là
    // over-engineering; ghi nhận quyết định blueprint v0.10)
    history: fit.history,
    gradAbsMean: fit.gradAbsMean.map(round5),
    draftUsed: Boolean(override),
  }
}

/**
 * Prune phiên bản V3 (blueprint A2): giữ MỌI bản active + N bản mới nhất
 * theo version. Fail-open — lỗi prune KHÔNG làm fail phép train (đã ghi
 * model xong; prune chỉ dọn rác).
 */
async function pruneV3Versions(): Promise<void> {
  try {
    const rows = await db.brainModel.findMany({
      where: { brain: 'calibration_v3' },
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
    console.warn('[Brain-V3] prune failed (fail-open):', err instanceof Error ? err.message : String(err))
  }
}

// ==================== RUNTIME APPLY (fail-open tuyệt đối) ====================

/** Model V3 active đã nạp từ DB (MLP deserialize + stats chuẩn hóa). */
export interface ActiveV3Model {
  mlp: MLP
  means: number[]
  stds: number[]
  nSamples: number
  version: number
}

/**
 * Nạp bản V3 active từ BrainModel — MỌI nhánh không áp được trả null
 * (không có bản active / trainMeta rách / standardization sai chiều /
 * weightsJson rách / nSamples dưới ngưỡng runtime): caller rơi đúng chuỗi
 * V2→V1 cũ. Không cache (tiền lệ V2: calibration.ts đọc DB mỗi call —
 * 1 row index [brain, active], deserialize 193 tham số là rẻ — r85-A pin).
 * stds=0 (corrupt/rác) → null: chia 0 tạo ±∞/NaN (FB-BRAIN-P2-R1-01).
 */
export async function loadActiveV3(): Promise<ActiveV3Model | null> {
  try {
    const row = await db.brainModel.findFirst({
      where: { brain: 'calibration_v3', active: true, inputMode: V3_INPUT_MODE },
      orderBy: { version: 'desc' },
      select: { version: true, weightsJson: true, trainMetaJson: true },
    })
    if (!row) return null

    const meta = JSON.parse(row.trainMetaJson) as Record<string, unknown>
    const nSamples = typeof meta.nSamples === 'number' && Number.isFinite(meta.nSamples)
      ? meta.nSamples
      : null
    if (nSamples === null || nSamples < MIN_RUNTIME_SAMPLES_V3) return null

    // Standardization stats — đúng 10 chiều, mọi giá trị hữu hạn, stds > 0
    // (stds=0 → (v−mean)/0 = ±∞/NaN lan ra runtime — FB-BRAIN-P2-R1-01;
    // trước đây chỉ kiểm finite, 0 là finite nên lọt cửa)
    const std = meta.standardization as { means?: unknown; stds?: unknown } | undefined
    const d = FEATURE_NAMES.length
    const okArr = (v: unknown): v is number[] =>
      Array.isArray(v) && v.length === d && v.every(x => typeof x === 'number' && Number.isFinite(x))
    const okStds =
      Array.isArray(std?.stds) && (std.stds as unknown[]).length === d
      && (std.stds as unknown[]).every(x => typeof x === 'number' && Number.isFinite(x) && x > 0)
    if (!std || !okArr(std.means) || !okArr(std.stds) || !okStds) return null

    const serialized = JSON.parse(row.weightsJson) as MlpSerialized
    const mlp = MLP.deserialize(serialized) // throw → catch → null (fail-open)
    return { mlp, means: std.means, stds: std.stds, nSamples, version: row.version }
  } catch {
    return null // fail-open — không bao giờ làm runtime tệ hơn chuỗi cũ
  }
}

/**
 * Áp V3 cho 1 context: xây vector đặc trưng (thiếu → 0 = mean train —
 * impute đúng semantics V2) → chuẩn hóa → predictProba → clamp [0,1].
 * Thuần — không đụng DB (test trực tiếp được).
 *
 * Hợp đồng ném lỗi (FB-BRAIN-P2-R1-05): means/stds phải đúng 10 chiều VÀ
 * stds > 0 mọi chiều VÀ kết quả hữu hạn — vi phạm nào → throw Error rõ
 * (trước đây: stats sai chiều → NaN âm thầm — clamp nuốt NaN, KHÔNG báo).
 * Caller (tryCalibrationV3) bọc try/catch → null → rơi chuỗi V2 cũ nên
 * tinh thần fail-open tuyệt đối KHÔNG đổi.
 */
export function applyV3Model(model: ActiveV3Model, ctx: Partial<FeatureCtx>): number {
  const d = FEATURE_NAMES.length
  if (model.means.length !== d || model.stds.length !== d) {
    throw new Error(
      `applyV3Model: means/stds phải đúng ${d} chiều (nhận ${model.means.length}/${model.stds.length}) — ActiveV3Model hỏng`,
    )
  }
  if (!model.stds.every(v => v > 0)) {
    throw new Error('applyV3Model: stds phải > 0 mọi chiều — chia 0 tạo ±∞/NaN (FB-BRAIN-P2-R1-01)')
  }
  const raw = buildFeatureVector(ctx)
  const x = raw.map((v, j) =>
    typeof v === 'number' && Number.isFinite(v) ? (v - model.means[j]) / model.stds[j] : 0,
  )
  const p = model.mlp.predictProba(x)
  if (!Number.isFinite(p)) {
    throw new Error('applyV3Model: V3 dự đoán NaN/Infinity — từ chối áp (caller fail-open về V2)')
  }
  return Math.min(1, Math.max(0, p))
}

/**
 * Cờ CALIBRATION_V3 (STORE > ENV > DEFAULT=off — tuning store, key
 * 'calibration_v3'). Sync + rẻ (snapshot in-process TTL 5s — đúng chuỗi
 * hiệu lực runtime_model_policy đang dùng).
 */
export function isCalibrationV3Enabled(): boolean {
  try {
    return getTuningEnum('calibration_v3') === 'on'
  } catch {
    return false // key lạ/DB lỗi → off (fail-open giữ chuỗi cũ)
  }
}

/**
 * Runtime V3 — áp Brain-A khi: cờ on + có bản active hợp lệ. Trả NULL khi
 * không áp được (cờ off / chưa active / parse lỗi / thiếu mẫu) — caller
 * (calibration.ts getCalibratedConfidence) rơi đúng chuỗi V2→V1→raw.
 * KHÔNG BAO GIỜ throw (fail-open tuyệt đối — doctrine "calibration must
 * never make the system worse than its raw signal").
 */
export async function tryCalibrationV3(
  rawConfidence: number,
  features?: Partial<FeatureCtx>,
): Promise<number | null> {
  try {
    if (!isCalibrationV3Enabled()) return null
    const model = await loadActiveV3()
    if (!model) return null
    const tInfer = Date.now()
    const p = applyV3Model(model, { rawConfidence, ...features })
    // OBS-P2 hook (§C.3 đợt 2 — organ calibrate): vết suy diễn Brain-A khi
    // áp V3 vào chuỗi hiệu lực (fire-and-forget — fail-open không đụng V2)
    traceInference({
      brain: 'calibration_v3',
      organ: 'calibrate',
      modelVersion: model.version,
      input: { rawConfidence, ...features },
      output: [p],
      latencyMs: Date.now() - tInfer,
    })
    return p
  } catch {
    return null
  }
}
