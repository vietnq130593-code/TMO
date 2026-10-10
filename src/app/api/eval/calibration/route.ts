/**
 * Task 20-c — Calibration status + retrain endpoint.
 *
 * GET  /api/eval/calibration — trạng thái calibration HIỆN TẠI (mỗi section
 *        độc lập try/catch fail-open — lỗi section → zero-state, response 200):
 *   model     — CalibrationModel row (id='default') | null (chưa train)
 *   modelV2   — CalibrationModelV2 row (P3-M1: đa biến + odds ratio + CV
 *               Brier; active=true chỉ khi V2 thắng V1 qua 5-fold CV)
 *   retrieval — Brier/ECE của KB retrieval confidence trên EvalResult:
 *               score = rawConfidence (giá trị TRƯỚC calibration — 20-c fix),
 *               outcome = faithfulnessMedian > 0.7 ? 1 : 0 (chỉ rows đủ cả 2 số)
 *   arbiter   — Brier/ECE của TRỌNG TÀI độc lập trên ArbiterVerdict ĐÃ resolve:
 *               score = confidence, outcome = complete ? 1 : 0, kèm avgConfidence
 *               + baseRate (đối chiếu trực quan độ over/under-confident)
 *
 * POST /api/eval/calibration — retrain CalibrationModel (V1 — 1 biến) VÀ
 *        CalibrationModelV2 (đa biến + 5-fold CV so V1) từ EvalResult. V1
 *        usable < 10 → 400 {error, usable, need: 10} (đúng behavior cũ — kèm
 *        payload v2 độc lập: V2 cần ≥30 usable nên thường skipped ở giai đoạn
 *        đầu). V2 active=true chỉ khi cvBrier < brierV1 (P3-M2).
 *
 * Lưu ý vận hành: DB hiện 0 EvalResult rows → GET trả zero-state, POST 400
 * "insufficient data". Chạy `bun scripts/seed-eval.ts` + POST /api/eval/run
 * (tự auto-retrain sau run) hoặc POST endpoint này để train thủ công.
 */

import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { brierScore, ece, type CalibrationBin } from '@/lib/calibration-metrics'
import { trainCalibrationModel, MIN_TRAIN_SAMPLES } from '@/lib/calibration-train'
import { trainCalibrationModelV2, MIN_TRAIN_SAMPLES_V2, type MultiFeatureTrainResult } from '@/lib/calibration-multifeature'
import { findArbiterVerdictsForCalibration } from '@/lib/metrics-db'

export const dynamic = 'force-dynamic'

interface CalibrationSection {
  n: number
  brier: number
  ece: number | null
  bins: CalibrationBin[]
}

function zeroSection(): CalibrationSection {
  return { n: 0, brier: 0, ece: null, bins: [] }
}

/** Đọc CalibrationModelV2 row — fail-open null (P3-M1: V2 đa biến, active chỉ khi thắng CV) */
async function getModelV2() {
  try {
    const row = await db.calibrationModelV2.findUnique({ where: { id: 'default' } })
    if (!row) return null
    return {
      ...row,
      featureNames: JSON.parse(row.featureNames) as string[],
      oddsRatios: JSON.parse(row.oddsRatios) as Record<string, number>,
      coefficients: JSON.parse(row.coefficients) as number[],
      cvBrierCi: row.cvBrierCi ? (JSON.parse(row.cvBrierCi) as number[]) : null,
    }
  } catch (err) {
    console.warn('[EvalCalibration] getModelV2 failed (fail-open):', err instanceof Error ? err.message : String(err))
    return null
  }
}

/** Section metrics cho arbiter — thêm avgConfidence + baseRate (đối chiếu trực quan) */
function arbiterMetrics(scores: number[], outcomes: number[]): {
  n: number
  brier: number
  ece: number | null
  bins: CalibrationBin[]
  avgConfidence: number | null
  baseRate: number | null
} {
  if (scores.length === 0) {
    return { n: 0, brier: 0, ece: null, bins: [], avgConfidence: null, baseRate: null }
  }
  const e = ece(scores, outcomes)
  const n = scores.length
  const avgConfidence = scores.reduce((s, v) => s + v, 0) / n
  const baseRate = outcomes.reduce((s, v) => s + v, 0) / n
  return {
    n,
    brier: Math.round(brierScore(scores, outcomes) * 10000) / 10000,
    ece: e ? e.ece : null,
    bins: e ? e.bins : [],
    avgConfidence: Math.round(avgConfidence * 10000) / 10000,
    baseRate: Math.round(baseRate * 10000) / 10000,
  }
}

/** Đọc CalibrationModel row — fail-open null (DB lỗi/chưa train) */
async function getModel(): Promise<{
  id: string
  intercept: number
  coef: number
  trainedAt: Date
  sampleSize: number
} | null> {
  try {
    const row = await db.calibrationModel.findUnique({ where: { id: 'default' } })
    return row ?? null
  } catch (err) {
    console.warn('[EvalCalibration] getModel failed (fail-open):', err instanceof Error ? err.message : String(err))
    return null
  }
}

/** Brier/ECE của KB retrieval confidence trên EvalResult — fail-open zero-state */
async function getRetrievalMetrics(): Promise<CalibrationSection> {
  try {
    const rows = await db.evalResult.findMany({
      select: { rawConfidence: true, faithfulnessMedian: true },
      take: 5000,
      orderBy: { createdAt: 'desc' },
    })
    const scores: number[] = []
    const outcomes: number[] = []
    for (const r of rows) {
      if (typeof r.rawConfidence === 'number' && Number.isFinite(r.rawConfidence)
        && typeof r.faithfulnessMedian === 'number' && Number.isFinite(r.faithfulnessMedian)) {
        scores.push(r.rawConfidence)
        outcomes.push(r.faithfulnessMedian > 0.7 ? 1 : 0)
      }
    }
    if (scores.length === 0) return zeroSection()
    const e = ece(scores, outcomes)
    return {
      n: scores.length,
      brier: Math.round(brierScore(scores, outcomes) * 10000) / 10000,
      ece: e ? e.ece : null,
      bins: e ? e.bins : [],
    }
  } catch (err) {
    console.warn('[EvalCalibration] retrieval section failed (fail-open):', err instanceof Error ? err.message : String(err))
    return zeroSection()
  }
}

/** Brier/ECE của trọng tài trên ArbiterVerdict ĐÃ resolve — fail-open zero-state */
async function getArbiterMetrics(): Promise<ReturnType<typeof arbiterMetrics>> {
  try {
    // findArbiterVerdictsForCalibration: delegate path nếu Prisma instance
    // fresh, raw-SQL bridge nếu stale (Task 20-c — model mới sau db:push)
    const verdicts = await findArbiterVerdictsForCalibration()
    const scores = verdicts.map(v => v.confidence)
    const outcomes = verdicts.map(v => (v.complete ? 1 : 0))
    return arbiterMetrics(scores, outcomes)
  } catch (err) {
    console.warn('[EvalCalibration] arbiter section failed (fail-open):', err instanceof Error ? err.message : String(err))
    return arbiterMetrics([], [])
  }
}

export async function GET() {
  const [model, modelV2, retrieval, arbiter] = await Promise.all([
    getModel(),
    getModelV2(),
    getRetrievalMetrics(),
    getArbiterMetrics(),
  ])

  return NextResponse.json({
    model,
    modelV2,
    retrieval,
    arbiter,
    generatedAt: new Date().toISOString(),
  })
}

/** Viết gọn kết quả V2 cho response (bỏ phần lặp) */
function v2Payload(v2: MultiFeatureTrainResult) {
  return {
    trained: v2.trained,
    sampleSize: v2.sampleSize,
    cvBrier: v2.cvBrier,
    brierV1: v2.brierV1,
    improved: v2.improved,
    active: v2.trained ? v2.improved : false,
    oddsRatios: v2.oddsRatios,
    ...(v2.error ? { error: v2.error } : {}),
  }
}

export async function POST() {
  try {
    const result = await trainCalibrationModel()

    // P3-M1/M2 — train V2 đa biến độc lập với V1 (V2 cần ≥30 usable + đủ 2
    // lớp cho 5-fold stratified; V1 có thể đủ trong khi V2 chưa và ngược lại).
    let v2: MultiFeatureTrainResult
    try {
      v2 = await trainCalibrationModelV2()
    } catch (v2Err) {
      console.warn('[EvalCalibration] V2 retrain failed (fail-open):', v2Err instanceof Error ? v2Err.message : String(v2Err))
      v2 = {
        trained: false, sampleSize: 0, cvBrier: null, brierV1: null, improved: false,
        oddsRatios: {}, usable: 0, total: 0, error: 'internal error',
      }
    }

    if (!result.trained) {
      // Đúng behavior scripts/train-calibration.ts: dưới 10 usable rows → abort
      return NextResponse.json(
        {
          error: result.error || 'insufficient data to train calibration model',
          usable: result.usable,
          need: MIN_TRAIN_SAMPLES,
          v2: v2Payload(v2),
          v2Need: MIN_TRAIN_SAMPLES_V2,
        },
        { status: 400 },
      )
    }

    // Train xong → trả model mới + metrics tươi (GET shape + trained flag)
    const [model, modelV2, retrieval, arbiter] = await Promise.all([
      getModel(),
      getModelV2(),
      getRetrievalMetrics(),
      getArbiterMetrics(),
    ])
    return NextResponse.json({
      trained: true,
      usable: result.usable,
      total: result.total,
      model,
      modelV2,
      v2: v2Payload(v2),
      retrieval,
      arbiter,
      generatedAt: new Date().toISOString(),
    })
  } catch (err) {
    console.error('[EvalCalibration] POST retrain failed:', err instanceof Error ? err.message : String(err))
    return NextResponse.json({ error: 'Failed to retrain calibration model' }, { status: 500 })
  }
}
