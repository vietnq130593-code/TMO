/**
 * Phase 4 SMOLAB Proposal 3.5 — Train the confidence calibration model.
 *
 * CLI wrapper (Task 20-c): logic train đã chuyển vào
 * src/lib/calibration-train.ts (trainCalibrationModel) để POST /api/eval/calibration
 * + auto-retrain sau eval run dùng chung. Script này giữ nguyên CLI behavior cũ:
 *
 *   - đọc EvalResult → logistic regression (rawConfidence → faithfulnessMedian > 0.7)
 *   - upsert CalibrationModel row (id='default')
 *   - warn khi < 50 usable (khuyến nghị ổn định), abort exit 1 khi < 10 usable
 *
 * Usage: cd /home/z/tmo-app && set -a && source .env && set +a && bunx tsx scripts/train-calibration.ts
 * (hoặc qua API: POST /api/eval/calibration — chạy ngay trên dev server)
 */

import { trainCalibrationModel, MIN_TRAIN_SAMPLES } from '../src/lib/calibration-train'

async function main() {
  const result = await trainCalibrationModel()

  console.log(`[TrainCalibration] ${result.usable}/${result.total} EvalResults usable (have rawConfidence + faithfulnessMedian)`)

  if (result.usable < 50) {
    console.warn(`[TrainCalibration] Only ${result.usable} rows — need 50+ for a stable fit. Run more evals first (POST /api/eval/run).`)
  }
  if (!result.trained) {
    console.error(`[TrainCalibration] Aborting: fewer than ${MIN_TRAIN_SAMPLES} usable rows — ${result.error}`)
    process.exit(1)
  }

  console.log(`[TrainCalibration] Trained: intercept=${result.intercept.toFixed(4)}, coef=${result.coef.toFixed(4)} on ${result.sampleSize} samples`)

  console.log('[TrainCalibration] CalibrationModel row (id=default) upserted. kb-access.ts now returns calibrated confidence.')

  await db_disconnect()
}

/** Disconnect Prisma của lib (process exit sạch — không treo event loop) */
async function db_disconnect() {
  try {
    const { db } = await import('../src/lib/db')
    await db.$disconnect()
  } catch { /* fail-open */ }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[TrainCalibration] FAILED:', err)
    process.exit(1)
  })
