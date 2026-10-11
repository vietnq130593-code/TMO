// Phase 4 SMOLAB Proposal 3.5 — Confidence calibration.
//
// Logistic regression: calibrated = sigmoid(intercept + coef * rawConfidence).
// Trained offline by scripts/train-calibration.ts from EvalResult data
// (X = rawConfidence, Y = faithfulnessMedian > 0.7). Applied in
// kb-access.ts calculateConfidence in a LATER task — until that wiring lands,
// this module is consumed by future retrieval-pipeline code.
//
// P3-M1 (blueprint stats §P3-M1) — V2 ĐA BIẾN dẫn đường: khi có
// CalibrationModelV2 active (V2 đã thắng V1 qua 5-fold CV — P3-M2) thì
// getCalibratedConfidence áp V2 với rawConfidence làm đặc trưng duy nhất có
// (9 đặc trưng còn lại impute mean train = chuẩn hóa 0). KHÔNG đổi chữ ký —
// caller kb-access.ts không cần sửa; caller có context đầy đủ dùng
// getCalibratedConfidenceV2 (calibration-multifeature.ts) để hưởng đủ 10 đặc
// trưng.
//
// Fail-open semantics: no model row / not enough training samples /
// V2 parse lỗi / DB error → return the raw confidence unchanged (calibration
// must never make the system worse than its raw signal).

// BRAIN-P2 (blueprint §4.2) — V3 (Brain-A MLP) dẫn đường khi cờ
// CALIBRATION_V3 (STORE > ENV > DEFAULT=off — tuning store, key
// 'calibration_v3') bật VÀ có bản BrainModel active (thắng V2 qua 5-fold
// CV Brier). Mọi nhánh không áp được → rơi đúng chuỗi V2 → V1 → raw cũ.

import { db } from '@/lib/db'
import { applyV2Model, parseV2ModelJson } from '@/lib/calibration-multifeature'
import { tryCalibrationV3 } from '@/lib/brain/calibration-v3'

/** Minimum training samples before the calibration model is trusted. */
const MIN_CALIBRATION_SAMPLES = 20

/**
 * Get the calibrated confidence for a raw Step-1 KB confidence score.
 * Chuỗi hiệu lực: V3 (Brain-A MLP — cờ CALIBRATION_V3 + active) → V2-active
 * (đa biến, thắng CV V1) → V1 (1 biến) → fallback raw khi không có model
 * nào tin được. Từng tầng fail-open độc lập — V3 lỗi/không áp được thì V2
 * vẫn chạy đúng như trước khi V3 tồn tại.
 */
export async function getCalibratedConfidence(rawConfidence: number): Promise<number> {
  try {
    // BRAIN-P2 — V3 (Brain-A MLP) được thử TRƯỚC khi cờ bật; trả null ở
    // MỌI nhánh không áp được (cờ off / chưa active / parse lỗi / thiếu
    // mẫu) → rơi tiếp V2. V3 KHÔNG bao giờ làm runtime tệ hơn chuỗi cũ.
    const v3 = await tryCalibrationV3(rawConfidence)
    if (v3 !== null) return v3
    // P3-M1 — V2 active dẫn đường (không có features caller → mọi đặc trưng
    // trừ rawConfidence lấy mean tập train — chuẩn hóa = 0)
    const v2 = await db.calibrationModelV2.findUnique({ where: { id: 'default' } })
    if (v2?.active && v2.sampleSize >= MIN_CALIBRATION_SAMPLES) {
      const parsed = parseV2ModelJson(v2)
      if (parsed) return applyV2Model(parsed, { rawConfidence })
      // parse lỗi (JSON rách/model cũ) → rơi xuống V1 — fail-open
    }
    return await getCalibratedConfidenceV1(rawConfidence)
  } catch {
    return rawConfidence // fail-open
  }
}

/**
 * Đường V1 THUẦN (1 biến) — KHÔNG đụng V2. Export để calibration-multifeature
 * fallback theo spec P3-M1 ("getCalibratedConfidenceV2 thiếu features → fallback
 * v1" — gọi thẳng V1 chứ không quay lại getCalibratedConfidence vốn ưu tiên
 * V2-active, tránh đệ quy vòng).
 */
export async function getCalibratedConfidenceV1(rawConfidence: number): Promise<number> {
  try {
    const model = await db.calibrationModel.findUnique({ where: { id: 'default' } })
    if (!model || model.sampleSize < MIN_CALIBRATION_SAMPLES) return rawConfidence // not enough training data
    return 1 / (1 + Math.exp(-(model.intercept + model.coef * rawConfidence)))
  } catch {
    return rawConfidence // fail-open
  }
}
