/**
 * Task 20-c — Train confidence calibration model (Phase 4 SMOLAB Prop 3.5).
 *
 * Extract từ scripts/train-calibration.ts thành lib để tái sử dụng:
 *   - POST /api/eval/calibration (retrain qua API)
 *   - auto-retrain sau mỗi eval run hoàn tất (src/lib/eval/runner.ts)
 *   - scripts/train-calibration.ts (CLI wrapper — giữ behavior cũ)
 *
 * Logistic regression (gradient descent, lr 0.01 × 1000 epoch) trên:
 *   X = EvalResult.rawConfidence   (giá trị TRƯỚC calibration — kb-access trả
 *                                   rawConfidence riêng từ 20-c, hết feedback-loop)
 *   Y = faithfulnessMedian > 0.7   (1 = answer faithful)
 * Upsert CalibrationModel (id='default') → getCalibratedConfidence (kb-access)
 * áp sigmoid(intercept + coef * rawConfidence) khi sampleSize ≥ 20.
 *
 * Dùng import RELATIVE './db' (không '@/') để CLI wrapper chạy được bằng
 * bunx tsx không cần alias resolution.
 */

import { db } from './db'

/** Số mẫu usable tối thiểu để train (dưới đây abort — đúng behavior script cũ) */
export const MIN_TRAIN_SAMPLES = 10

/** Số mẫu để runtime TIN model (getCalibratedConfidence — MIN_CALIBRATION_SAMPLES của calibration.ts) */
export const MIN_RUNTIME_SAMPLES = 20

export interface TrainCalibrationResult {
  /** true khi model đã được upsert vào DB */
  trained: boolean
  /** Số EvalResult usable (có cả rawConfidence + faithfulnessMedian hợp lệ) */
  usable: number
  /** Tổng số EvalResult đọc được */
  total: number
  intercept: number
  coef: number
  sampleSize: number
  /** Lý do không train (khi trained=false) */
  error?: string
}

/**
 * Đọc toàn bộ EvalResult → train logistic regression → upsert CalibrationModel.
 * KHÔNG throw khi thiếu dữ liệu (trả trained=false + error) — caller quyết định
 * cách surface (API 400 / console.log). Chỉ throw khi lỗi DB/ghi DB thật sự.
 */
export async function trainCalibrationModel(): Promise<TrainCalibrationResult> {
  const results = await db.evalResult.findMany({
    select: { rawConfidence: true, faithfulnessMedian: true },
  })

  const usable = results.filter(
    r => typeof r.rawConfidence === 'number' && Number.isFinite(r.rawConfidence)
      && typeof r.faithfulnessMedian === 'number' && Number.isFinite(r.faithfulnessMedian),
  )

  if (usable.length < MIN_TRAIN_SAMPLES) {
    return {
      trained: false,
      usable: usable.length,
      total: results.length,
      intercept: 0,
      coef: 1,
      sampleSize: 0,
      error: `insufficient data: only ${usable.length} usable EvalResult rows (need ${MIN_TRAIN_SAMPLES}+) — run more evals first (POST /api/eval/run)`,
    }
  }

  // X = raw retrieval confidence; Y = 1 khi answer faithful (median > 0.7)
  const X = usable.map(r => r.rawConfidence as number)
  const Y = usable.map(r => (r.faithfulnessMedian > 0.7 ? 1 : 0))

  // Logistic regression via gradient descent (giữ nguyên hyperparameter script cũ)
  let intercept = 0
  let coef = 1
  const lr = 0.01
  const epochs = 1000

  for (let e = 0; e < epochs; e++) {
    let gradIntercept = 0
    let gradCoef = 0
    for (let i = 0; i < X.length; i++) {
      const pred = 1 / (1 + Math.exp(-(intercept + coef * X[i])))
      gradIntercept += pred - Y[i]
      gradCoef += (pred - Y[i]) * X[i]
    }
    intercept -= (lr * gradIntercept) / X.length
    coef -= (lr * gradCoef) / X.length
  }

  await db.calibrationModel.upsert({
    where: { id: 'default' },
    create: { id: 'default', intercept, coef, sampleSize: X.length },
    update: { intercept, coef, sampleSize: X.length },
  })

  return {
    trained: true,
    usable: usable.length,
    total: results.length,
    intercept,
    coef,
    sampleSize: X.length,
  }
}
