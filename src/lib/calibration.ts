// Phase 4 SMOLAB Proposal 3.5 — Confidence calibration.
//
// Logistic regression: calibrated = sigmoid(intercept + coef * rawConfidence).
// Trained offline by scripts/train-calibration.ts from EvalResult data
// (X = rawConfidence, Y = faithfulnessMedian > 0.7). Applied in
// kb-access.ts calculateConfidence in a LATER task — until that wiring lands,
// this module is consumed by future retrieval-pipeline code.
//
// Fail-open semantics: no CalibrationModel row / not enough training samples /
// DB error → return the raw confidence unchanged (calibration must never make
// the system worse than its raw signal).

import { db } from '@/lib/db'

/** Minimum training samples before the calibration model is trusted. */
const MIN_CALIBRATION_SAMPLES = 20

/**
 * Get the calibrated confidence for a raw Step-1 KB confidence score.
 * Falls back to the raw confidence when no CalibrationModel row exists or the
 * model was trained on too few samples.
 */
export async function getCalibratedConfidence(rawConfidence: number): Promise<number> {
  try {
    const model = await db.calibrationModel.findUnique({ where: { id: 'default' } })
    if (!model || model.sampleSize < MIN_CALIBRATION_SAMPLES) return rawConfidence // not enough training data
    return 1 / (1 + Math.exp(-(model.intercept + model.coef * rawConfidence)))
  } catch {
    return rawConfidence // fail-open
  }
}
