/**
 * Phase 4 SMOLAB Proposal 3.5 — Train the confidence calibration model.
 *
 * Trains a logistic regression on (rawConfidence → faithfulnessMedian > 0.7)
 * from all EvalResult rows. Upserts the CalibrationModel row (id='default').
 *
 * Run only after 50+ EvalResult rows exist (getCalibratedConfidence falls
 * back to raw below sampleSize 20; 50+ gives a stable fit).
 *
 * Usage: cd /home/z/tmo-app && set -a && source .env && set +a && bunx tsx scripts/train-calibration.ts
 */

import { db } from '../src/lib/db'

async function main() {
  const results = await db.evalResult.findMany({
    select: { rawConfidence: true, faithfulnessMedian: true },
  })

  const usable = results.filter(r => typeof r.rawConfidence === 'number' && typeof r.faithfulnessMedian === 'number')
  console.log(`[TrainCalibration] ${usable.length}/${results.length} EvalResults usable (have rawConfidence + faithfulnessMedian)`)

  if (usable.length < 50) {
    console.warn(`[TrainCalibration] Only ${usable.length} rows — need 50+ for a stable fit. Run more evals first (POST /api/eval/run).`)
  }
  if (usable.length < 10) {
    console.error('[TrainCalibration] Aborting: fewer than 10 usable rows.')
    process.exit(1)
  }

  // X = raw retrieval confidence; Y = 1 when the answer was faithful (median > 0.7)
  const X = usable.map(r => r.rawConfidence as number)
  const Y = usable.map(r => (r.faithfulnessMedian > 0.7 ? 1 : 0))

  // Logistic regression via gradient descent
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

  console.log(`[TrainCalibration] Trained: intercept=${intercept.toFixed(4)}, coef=${coef.toFixed(4)} on ${X.length} samples`)

  await db.calibrationModel.upsert({
    where: { id: 'default' },
    create: { id: 'default', intercept, coef, sampleSize: X.length },
    update: { intercept, coef, sampleSize: X.length },
  })

  console.log('[TrainCalibration] CalibrationModel row (id=default) upserted. kb-access.ts now returns calibrated confidence.')

  await db.$disconnect().catch(() => {})
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[TrainCalibration] FAILED:', err)
    process.exit(1)
  })
