/**
 * P2-M2 · THRESHOLD SWEEP — ROC/PR quét ngưỡng trên dữ liệu thật (mục #6).
 *
 * Nguồn: BLUEPRINT-STATS-LEARNING-P0-P6.md §P2-M1 (ML.pdf §Evaluation Curves).
 * Mọi ngưỡng hardcode hiện nay chưa từng được sweep trên dữ liệu:
 *   - evaluator confidence (clamp 0.3 tại agent-goal-loop — ROUND-8 AUDIT)
 *   - KB CONFIDENCE_THRESHOLD = 0.5 (kb-access.ts:44)
 *   (SHR PROMOTE/DEMOTE_POSTERIOR cần HypothesisRecord verdict đã đối chứng
 *   đủ nhiều — v1 ghi "chờ dữ liệu" trong báo cáo, KHÔNG sweep.)
 *
 * NGUYÊN TẮC SỐ 1 (blueprint §P2-M1): KHÔNG TỰ ĐỔI HẰNG SỐ. Kết quả sweep
 * → bảng trình USER DUYỆT (tiền lệ option-b của CONFIDENCE_THRESHOLD).
 * Khi user duyệt: đổi hằng số kèm comment `swept YYYY-MM-DD, n=…,
 * precision/recall đạt` — vẫn hardcode nhưng có nguồn gốc dữ liệu.
 *
 * Thiết kế:
 *   - buildSweepReport(target, scores, actuals) — PHẦN THUẦN (không DB, test
 *     độc lập được): sweepThresholds (P0) → bảng (threshold, precision,
 *     recall, F1, TPR/FPR) + AUC-ROC/AUC-PR + 3 khuyến nghị theo tiêu chí
 *     (max_f1 / precision ≥ 0.9 / recall ≥ 0.9) + mốc cố định 0.05..0.95
 *     (bảo đảm bảng có đủ mốc 0.1..0.9 cho người đọc — kiểm chứng §P2-M1).
 *   - sweepEvaluatorThresholds(windowDays=60) — ArbiterVerdict resolved:
 *     score = verdict.confidence, actual = runComplete (CÙNG NGUỒN P1-M1
 *     findResolvedVerdictsForScorecard → AUC khớp scorecard khi cùng cửa sổ).
 *   - sweepKbConfidence() — EvalResult.rawConfidence × faithfulnessMedian>0.7
 *     (đúng Y calibration hiện tại — calibration-train.ts:71).
 *
 * Fail-open TOÀN PHẦN (nguyên tắc 3): lỗi DB → zero-state { n: 0, note },
 * KHÔNG throw. Read-only — không ghi gì vào DB.
 */

import { sweepThresholds, aucRoc, aucPr, type CurvePoint } from '@/lib/stats'
import { db } from '@/lib/db'
import { findResolvedVerdictsForScorecard } from '@/lib/metrics-db'

/** Mục tiêu sweep — ánh xạ từng hằng số hardcode đang chờ duyệt. */
export type SweepTarget = 'evaluator_confidence' | 'kb_confidence'

/** Một điểm đường cong kèm F1 (CurvePoint của stats + f1 tính sẵn). */
export interface SweepPoint extends CurvePoint {
  f1: number
}

/** Khuyến nghị ngưỡng theo 1 tiêu chí — chỉ xuất hiện khi thỏa mãn được. */
export interface SweepRecommendation {
  criterion: 'max_f1' | 'precision_gte_0.9' | 'recall_gte_0.9'
  threshold: number
  precision: number
  recall: number
  f1: number
}

export interface SweepReport {
  target: SweepTarget
  /** Số cặp (score, actual) dùng được */
  n: number
  /** Số actual=true — 0 thì precision/f1/AUC-PR vô nghĩa */
  positives: number
  /** AUC-PR step-wise (stats) — null khi không có positive thật (không định nghĩa) */
  aucPr: number | null
  /** AUC-ROC hình thang có neo gốc (stats) — null khi không có dữ liệu */
  aucRoc: number | null
  /** Đường cong tại MỖI score quan sát được (nguồn AUC — khớp P1-M1 cùng nguồn) */
  points: SweepPoint[]
  /** Bảng mốc cố định 0.05..0.95 bước 0.05 (chứa đủ 0.1..0.9 — để đọc nhanh) */
  fixedMarks: SweepPoint[]
  recommended: SweepRecommendation[]
  /** Ghi chú zero-state / dữ liệu bị loại — undefined khi có dữ liệu lành */
  note?: string
}

/** Làm tròn 4 chữ số thập phân (cùng chuẩn verdict-scorecard). */
function round4(x: number): number {
  return Math.round(x * 10000) / 10000
}

/** F1 từ precision/recall (mẫu số 0 → 0 — cùng convention safeDiv của stats). */
function f1Of(precision: number, recall: number): number {
  return precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall)
}

/** Mốc cố định 0.05..0.95 bước 0.05 (19 mốc — bảo đảm đủ 0.1..0.9). */
function fixedMarkThresholds(): number[] {
  const marks: number[] = []
  for (let i = 1; i <= 19; i++) marks.push(Math.round(i * 0.05 * 100) / 100)
  return marks
}

/**
 * Điểm tại ngưỡng TUỲ Ý (không cần là score quan sát được) — predicted
 * positive ⇔ score ≥ threshold (cùng quy ước sweepThresholds của stats).
 */
function pointAt(scores: number[], actuals: boolean[], threshold: number, totalPos: number, totalNeg: number): SweepPoint {
  let tp = 0
  let fp = 0
  for (let i = 0; i < scores.length; i++) {
    if (scores[i] >= threshold) {
      if (actuals[i]) tp++
      else fp++
    }
  }
  const precision = tp + fp === 0 ? 0 : tp / (tp + fp)
  const recall = totalPos === 0 ? 0 : tp / totalPos
  return {
    threshold,
    tpr: recall,
    fpr: totalNeg === 0 ? 0 : fp / totalNeg,
    precision,
    recall,
    f1: f1Of(precision, recall),
  }
}

/** Zero-state fail-open — mọi target cùng shape. */
function zeroState(target: SweepTarget, note: string): SweepReport {
  return {
    target,
    n: 0,
    positives: 0,
    aucPr: null,
    aucRoc: null,
    points: [],
    fixedMarks: [],
    recommended: [],
    note,
  }
}

/**
 * PHẦN THUẦN — dựng toàn bộ báo cáo sweep từ cặp (scores, actuals).
 * Length mismatch → throw (lỗi lời gọi, không phải dữ liệu — cùng quy ước
 * stats/classification). Score không hữu hạn (NaN/±Infinity) → throw tường
 * minh (FB-Đợt4-R1-01: không throw sẽ âm thầm tạo dòng ngưỡng NaN trong bảng
 * + mẫu đó không bao giờ được dự đoán dương mà vẫn đếm vào n — cả 2 DB
 * caller đã lọc Number.isFinite trước khi gọi). Rỗng → zero-state + note.
 */
export function buildSweepReport(target: SweepTarget, scores: number[], actuals: boolean[]): SweepReport {
  if (scores.length !== actuals.length) {
    throw new Error(
      `buildSweepReport: scores (${scores.length}) và actuals (${actuals.length}) khác độ dài`,
    )
  }
  for (let i = 0; i < scores.length; i++) {
    if (!Number.isFinite(scores[i])) {
      throw new Error(
        `buildSweepReport: scores[${i}] = ${scores[i]} không hữu hạn — lọc Number.isFinite trước khi sweep (caller DB đã lọc)`,
      )
    }
  }
  const n = scores.length
  if (n === 0) {
    return zeroState(target, 'chờ dữ liệu — chưa có cặp (score, actual) nào dùng được')
  }

  let positives = 0
  for (const a of actuals) if (a) positives++
  const totalNeg = n - positives

  // Đường cong tại từng score quan sát được — NGUỒN AUC (khớp P1-M1 cùng dữ liệu)
  const rawPoints = sweepThresholds(scores, actuals)
  const points: SweepPoint[] = rawPoints.map((p) => ({
    threshold: p.threshold,
    tpr: round4(p.tpr),
    fpr: round4(p.fpr),
    precision: round4(p.precision),
    recall: round4(p.recall),
    f1: round4(f1Of(p.precision, p.recall)),
  }))

  // AUC trên điểm GỐC của stats (chưa round — giữ chính xác diện tích).
  // FB-Đợt4-R2-01: thiếu MỘT TRONG HAI LỚP (positives=0 hoặc negatives=0) thì
  // AUC-ROC KHÔNG định nghĩa được (không có cặp T/F để xếp hạng) → null —
  // đối xứng với precedent P1-M1 (aucPr null khi không có positive thật).
  // Trả 0 đằng ấy sẽ bị đọc nhầm "đường cong tệ nhất".
  const aucRocValue =
    positives > 0 && totalNeg > 0 ? round4(aucRoc(rawPoints)) : null
  const aucPrValue = positives > 0 ? round4(aucPr(rawPoints)) : null

  // Mốc cố định 0.05..0.95 — đọc nhanh không cần nội suy
  const fixedMarks = fixedMarkThresholds().map((m) => {
    const p = pointAt(scores, actuals, m, positives, totalNeg)
    return {
      threshold: m,
      tpr: round4(p.tpr),
      fpr: round4(p.fpr),
      precision: round4(p.precision),
      recall: round4(p.recall),
      f1: round4(p.f1),
    }
  })

  // Không có positive thật → precision/f1 vô nghĩa ở mọi ngưỡng → không khuyến nghị
  if (positives === 0) {
    return {
      target,
      n,
      positives,
      aucPr: null,
      aucRoc: aucRocValue,
      points,
      fixedMarks,
      recommended: [],
      note: `chờ dữ liệu — 0/${n} mẫu có actual=true (precision/f1 không định nghĩa được)`,
    }
  }

  // ── 3 khuyến nghị theo tiêu chí (chỉ xuất hiện khi thỏa mãn được) ──
  // FB-Đợt4-R1-02: chọn/lọc trên giá trị THÔ (rawPoints + f1Of) — KHÔNG dùng
  // points đã round4 (làm tròn có thể nạp ứng viên có precision thô < 0.9
  // chênh ≤ 5e-5, hoặc ghi tie giả giữa 2 f1 lệch < 5e-5). Chỉ round khi xuất.
  // Tie f1 so với epsilon 1e-12: 2 f1 bằng nhau toán học nhưng lệch nhau 1
  // ULP float (vd cùng 2/3 tính qua tử/mẫu khác nhau) vẫn phải được coi là
  // TIE để bậc tie-break (precision) quyết định — không để noise ULP thắng.
  const raw: Array<{ threshold: number; precision: number; recall: number; f1: number }> =
    rawPoints.map((p) => ({
      threshold: p.threshold,
      precision: p.precision,
      recall: p.recall,
      f1: f1Of(p.precision, p.recall),
    }))
  const recommended: SweepRecommendation[] = []
  const F1_EPS = 1e-12

  // max_f1: điểm f1 cao nhất; đồng điểm (≤ ε) → precision cao hơn; vẫn đồng
  // → ngưỡng CAO hơn (kén chọn hơn — an toàn cho precision).
  let best: (typeof raw)[number] | null = null
  for (const p of raw) {
    if (best === null) {
      best = p
      continue
    }
    if (p.f1 > best.f1 + F1_EPS) {
      best = p
    } else if (Math.abs(p.f1 - best.f1) <= F1_EPS) {
      if (p.precision > best.precision || (p.precision === best.precision && p.threshold > best.threshold)) {
        best = p
      }
    }
  }
  if (best) {
    recommended.push({
      criterion: 'max_f1',
      threshold: best.threshold,
      precision: round4(best.precision),
      recall: round4(best.recall),
      f1: round4(best.f1),
    })
  }

  // precision ≥ 0.9: ngưỡng THẤP NHẤT đạt precision (max recall trong ràng buộc)
  const precOk = raw.filter((p) => p.precision >= 0.9)
  if (precOk.length > 0) {
    const pick = precOk.reduce((a, b) => (b.threshold < a.threshold ? b : a))
    recommended.push({
      criterion: 'precision_gte_0.9',
      threshold: pick.threshold,
      precision: round4(pick.precision),
      recall: round4(pick.recall),
      f1: round4(pick.f1),
    })
  }

  // recall ≥ 0.9: ngưỡng CAO NHẤT còn đạt recall (max precision trong ràng buộc)
  const recOk = raw.filter((p) => p.recall >= 0.9)
  if (recOk.length > 0) {
    const pick = recOk.reduce((a, b) => (b.threshold > a.threshold ? b : a))
    recommended.push({
      criterion: 'recall_gte_0.9',
      threshold: pick.threshold,
      precision: round4(pick.precision),
      recall: round4(pick.recall),
      f1: round4(pick.f1),
    })
  }

  return { target, n, positives, aucPr: aucPrValue, aucRoc: aucRocValue, points, fixedMarks, recommended }
}

/**
 * Sweep ngưỡng EVALUATOR confidence — score = ArbiterVerdict.confidence,
 * actual = runComplete (resolved). Cùng nguồn P1-M1 verdict-scorecard
 * (findResolvedVerdictsForScorecard) → AUC-PR khớp scorecard cùng cửa sổ.
 * Mặc định 60 ngày, kẹp [1, 365] (rộng hơn scorecard 30 — ngưỡng cần dữ liệu
 * lâu dài để ổn định).
 */
export async function sweepEvaluatorThresholds(windowDays = 60): Promise<SweepReport> {
  const days = Math.max(1, Math.min(windowDays, 365))
  try {
    const rows = await findResolvedVerdictsForScorecard(days)
    // Ground-truth cần runComplete ≠ null (resolveArbiterVerdicts luôn ghi đủ
    // khi resolve; dữ liệu cũ lệch có thể thiếu → loại + ghi chú — giống P1-M1)
    const usable = rows.filter(
      (r) => r.runComplete !== null && typeof r.confidence === 'number' && Number.isFinite(r.confidence),
    )
    if (usable.length === 0) {
      const note =
        rows.length > 0
          ? `chờ dữ liệu — ${rows.length} verdict resolved trong ${days} ngày nhưng thiếu runComplete/confidence hợp lệ (bị loại)`
          : `chờ dữ liệu — chưa có verdict resolved nào trong ${days} ngày gần nhất`
      return zeroState('evaluator_confidence', note)
    }
    return buildSweepReport(
      'evaluator_confidence',
      usable.map((v) => v.confidence),
      usable.map((v) => v.runComplete === true),
    )
  } catch (err) {
    console.warn(
      '[ThresholdSweep] sweepEvaluatorThresholds failed (fail-open):',
      err instanceof Error ? err.message : String(err),
    )
    return zeroState('evaluator_confidence', `lỗi đọc dữ liệu — ${err instanceof Error ? err.message : String(err)}`)
  }
}

/**
 * Sweep ngưỡng KB confidence — score = EvalResult.rawConfidence (giá trị
 * TRƯỚC calibration — đúng thứ tự bước production searchUserKB), actual =
 * faithfulnessMedian > 0.7 (đúng Y calibration hiện tại). Toàn bộ EvalResult
 * mới nhất trước, cap 5000 (cùng cap P1-M1).
 */
export async function sweepKbConfidence(): Promise<SweepReport> {
  try {
    const rows = await db.evalResult.findMany({
      orderBy: { createdAt: 'desc' },
      take: 5000,
      select: { rawConfidence: true, faithfulnessMedian: true },
    })
    const usable = rows.filter(
      (r) =>
        typeof r.rawConfidence === 'number' && Number.isFinite(r.rawConfidence) &&
        typeof r.faithfulnessMedian === 'number' && Number.isFinite(r.faithfulnessMedian),
    )
    if (usable.length === 0) {
      const note =
        rows.length > 0
          ? `chờ dữ liệu — ${rows.length} EvalResult nhưng thiếu rawConfidence/faithfulnessMedian hợp lệ (bị loại)`
          : 'chờ dữ liệu — chưa có EvalResult nào'
      return zeroState('kb_confidence', note)
    }
    return buildSweepReport(
      'kb_confidence',
      usable.map((r) => r.rawConfidence as number),
      usable.map((r) => r.faithfulnessMedian > 0.7),
    )
  } catch (err) {
    console.warn(
      '[ThresholdSweep] sweepKbConfidence failed (fail-open):',
      err instanceof Error ? err.message : String(err),
    )
    return zeroState('kb_confidence', `lỗi đọc dữ liệu — ${err instanceof Error ? err.message : String(err)}`)
  }
}
