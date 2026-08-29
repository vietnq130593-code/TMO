/**
 * Task 20-c — Calibration status + retrain endpoint.
 *
 * GET  /api/eval/calibration — trạng thái calibration HIỆN TẠI (mỗi section
 *        độc lập try/catch fail-open — lỗi section → zero-state, response 200):
 *   model     — CalibrationModel row (id='default') | null (chưa train)
 *   retrieval — Brier/ECE của KB retrieval confidence trên EvalResult:
 *               score = rawConfidence (giá trị TRƯỚC calibration — 20-c fix),
 *               outcome = faithfulnessMedian > 0.7 ? 1 : 0 (chỉ rows đủ cả 2 số)
 *   arbiter   — Brier/ECE của TRỌNG TÀI độc lập trên ArbiterVerdict ĐÃ resolve:
 *               score = confidence, outcome = complete ? 1 : 0, kèm avgConfidence
 *               + baseRate (đối chiếu trực quan độ over/under-confident)
 *
 * POST /api/eval/calibration — retrain CalibrationModel từ EvalResult
 *   (logistic regression — src/lib/calibration-train.ts). Usable < 10 → 400
 *   {error, usable, need: 10} (đúng behavior scripts/train-calibration.ts).
 *
 * Lưu ý vận hành: DB hiện 0 EvalResult rows → GET trả zero-state, POST 400
 * "insufficient data". Chạy `bun scripts/seed-eval.ts` + POST /api/eval/run
 * (tự auto-retrain sau run) hoặc POST endpoint này để train thủ công.
 */

import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { brierScore, ece, type CalibrationBin } from '@/lib/calibration-metrics'
import { trainCalibrationModel, MIN_TRAIN_SAMPLES } from '@/lib/calibration-train'
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
  const [model, retrieval, arbiter] = await Promise.all([
    getModel(),
    getRetrievalMetrics(),
    getArbiterMetrics(),
  ])

  return NextResponse.json({
    model,
    retrieval,
    arbiter,
    generatedAt: new Date().toISOString(),
  })
}

export async function POST() {
  try {
    const result = await trainCalibrationModel()

    if (!result.trained) {
      // Đúng behavior scripts/train-calibration.ts: dưới 10 usable rows → abort
      return NextResponse.json(
        {
          error: result.error || 'insufficient data to train calibration model',
          usable: result.usable,
          need: MIN_TRAIN_SAMPLES,
        },
        { status: 400 },
      )
    }

    // Train xong → trả model mới + metrics tươi (GET shape + trained flag)
    const [model, retrieval, arbiter] = await Promise.all([
      getModel(),
      getRetrievalMetrics(),
      getArbiterMetrics(),
    ])
    return NextResponse.json({
      trained: true,
      usable: result.usable,
      total: result.total,
      model,
      retrieval,
      arbiter,
      generatedAt: new Date().toISOString(),
    })
  } catch (err) {
    console.error('[EvalCalibration] POST retrain failed:', err instanceof Error ? err.message : String(err))
    return NextResponse.json({ error: 'Failed to retrain calibration model' }, { status: 500 })
  }
}
