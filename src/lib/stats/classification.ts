/**
 * Đo lường phân loại (classification metrics) — module thuần toán, không side-effect.
 *
 * Nguồn: BLUEPRINT-STATS-LEARNING-P0-P6.md mục P0-1 (ML.pdf §1 Confusion Matrix,
 * §3 Precision/Recall/F1, §4 Log Loss, §8 ROC/PR Curves).
 * Nhà tiêu thụ chính: P1-M1 verdict-scorecard, P2-M1 threshold-sweep, P3 k-fold CV.
 *
 * Convention:
 * - Mẫu số 0 → 0 (defensive — lớp vắng mặt không sinh NaN/Infinity làm gãy
 *   scorecard; fail-open theo nguyên tắc 3 blueprint).
 * - length mismatch → throw (lỗi lập trình của lời gọi, không phải dữ liệu).
 */

/** Ma trận nhầm lẫn: tp/fp/fn/tn. */
export interface ConfusionMatrix {
  tp: number;
  fp: number;
  fn: number;
  tn: number;
}

/** Chia an toàn: mẫu số 0 → 0. */
function safeDiv(num: number, den: number): number {
  return den === 0 ? 0 : num / den;
}

/**
 * Dựng ma trận nhầm lẫn từ cặp chuỗi dự đoán/ground-truth.
 * predicted = true được tính là "dương". Length mismatch → throw.
 */
export function confusionMatrix(predicted: boolean[], actual: boolean[]): ConfusionMatrix {
  if (predicted.length !== actual.length) {
    throw new Error(
      `confusionMatrix: predicted (${predicted.length}) và actual (${actual.length}) khác độ dài`,
    );
  }
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;
  for (let i = 0; i < predicted.length; i++) {
    if (predicted[i]) {
      if (actual[i]) tp++;
      else fp++;
    } else {
      if (actual[i]) fn++;
      else tn++;
    }
  }
  return { tp, fp, fn, tn };
}

/**
 * Precision / Recall / F1 / Specificity / Balanced Accuracy từ ma trận nhầm lẫn:
 *   precision = tp/(tp+fp); recall = tp/(tp+fn); f1 = 2PR/(P+R);
 *   specificity = tn/(tn+fp); balancedAccuracy = (recall + specificity)/2.
 * Mẫu số 0 → 0 (vd không có dự đoán dương → precision 0).
 */
export function prf1(m: ConfusionMatrix): {
  precision: number;
  recall: number;
  f1: number;
  specificity: number;
  balancedAccuracy: number;
} {
  const precision = safeDiv(m.tp, m.tp + m.fp);
  const recall = safeDiv(m.tp, m.tp + m.fn);
  const f1 = safeDiv(2 * precision * recall, precision + recall);
  const specificity = safeDiv(m.tn, m.tn + m.fp);
  return { precision, recall, f1, specificity, balancedAccuracy: (recall + specificity) / 2 };
}

/**
 * Log loss (cross-entropy nhị phân): −mean(y·ln p + (1−y)·ln(1−p)),
 * p được kẹp vào [1e−9, 1−1e−9] tránh ln(0) = −Infinity.
 * Mảng rỗng → NaN; length mismatch → throw.
 */
export function logLoss(ps: number[], ys: number[]): number {
  if (ps.length !== ys.length) {
    throw new Error(`logLoss: ps (${ps.length}) và ys (${ys.length}) khác độ dài`);
  }
  if (ps.length === 0) return Number.NaN;
  const EPS = 1e-9;
  let acc = 0;
  for (let i = 0; i < ps.length; i++) {
    const p = Math.min(Math.max(ps[i], EPS), 1 - EPS);
    acc += ys[i] * Math.log(p) + (1 - ys[i]) * Math.log(1 - p);
  }
  return -acc / ps.length;
}

/** Một điểm trên đường ROC/PR tại một ngưỡng. */
export interface CurvePoint {
  threshold: number;
  tpr: number;
  fpr: number;
  precision: number;
  recall: number;
}

/**
 * Quét ngưỡng: MỘT điểm cho MỖI giá trị score duy nhất, threshold giảm dần;
 * predicted positive ⇔ score ≥ threshold. Tại mỗi ngưỡng:
 *   tpr = recall = tp/(tp+fn) (0 nếu không có positive thật),
 *   fpr = fp/(fp+tn) (0 nếu không có negative thật),
 *   precision = tp/(tp+fp) (0 nếu không dự đoán positive nào).
 * Length mismatch → throw; rỗng → [].
 */
export function sweepThresholds(scores: number[], actuals: boolean[]): CurvePoint[] {
  if (scores.length !== actuals.length) {
    throw new Error(`sweepThresholds: scores (${scores.length}) và actuals (${actuals.length}) khác độ dài`);
  }
  if (scores.length === 0) return [];
  const thresholds = [...new Set(scores)].sort((a, b) => b - a); // giảm dần
  let totalPos = 0;
  for (const a of actuals) if (a) totalPos++;
  const totalNeg = actuals.length - totalPos;
  return thresholds.map((t) => {
    let tp = 0;
    let fp = 0;
    for (let i = 0; i < scores.length; i++) {
      if (scores[i] >= t) {
        if (actuals[i]) tp++;
        else fp++;
      }
    }
    return {
      threshold: t,
      tpr: safeDiv(tp, totalPos),
      fpr: safeDiv(fp, totalNeg),
      precision: safeDiv(tp, tp + fp),
      recall: safeDiv(tp, totalPos),
    };
  });
}

/**
 * AUC-ROC: tích phân hình thang theo trục FPR (sort điểm theo fpr tăng dần,
 * phụ tpr tăng dần để đoạn fpr trùng không tạo bậc giả). Rỗng → 0.
 *
 * NEO GỐC (0,0) — FB-P0-R1-01: đường cong ROC luôn bắt đầu từ "không dự đoán
 * gì" (threshold = +∞) nhưng sweepThresholds chỉ phát điểm tại score quan sát
 * được nên gốc có thể vắng. Thiếu gốc, bước nhảy chéo đầu tiên (nhóm score
 * cao nhất chứa LẪN cả 2 lớp — tie ở đỉnh) bị co thành đường dọc → mất diện
 * tích tam giác gốc → AUC thấp hơn định nghĩa chuẩn P(T>F) + ½P(T=F)
 * (đối chứng FB-P0: tie đỉnh 0.75→0.5, toàn-tie 0.5→0). Neo (0,0) được chèn
 * nếu điểm fpr nhỏ nhất chưa nằm ở gốc; đã có sẵn thì không chèn trùng.
 */
export function aucRoc(points: CurvePoint[]): number {
  if (points.length === 0) return 0;
  const sorted = [...points].sort((a, b) => a.fpr - b.fpr || a.tpr - b.tpr);
  const first = sorted[0];
  if (first.fpr > 0 || first.tpr > 0) {
    sorted.unshift({ threshold: Number.POSITIVE_INFINITY, tpr: 0, fpr: 0, precision: 0, recall: 0 });
  }
  if (sorted.length < 2) return 0;
  let area = 0;
  for (let i = 1; i < sorted.length; i++) {
    const width = sorted[i].fpr - sorted[i - 1].fpr;
    const height = (sorted[i].tpr + sorted[i - 1].tpr) / 2;
    area += width * height;
  }
  return area;
}

/**
 * AUC-PR STEP-WISE (đúng chuẩn đường PR bậc thang, KHÔNG tích phân hình thang):
 * sort điểm theo threshold GIẢM dần rồi Σ P_i·(R_i − R_{i−1}) với R_0 = 0.
 * (Khi hạ ngưỡng, precision thay đổi trong khi recall giữ nguyên — diện tích
 * là tổng các bậc thang ngang, hình thang sẽ ĐẾCH giá trị ở vùng lõm.)
 * Rỗng → 0.
 */
export function aucPr(points: CurvePoint[]): number {
  if (points.length === 0) return 0;
  const sorted = [...points].sort((a, b) => b.threshold - a.threshold);
  let area = 0;
  let prevRecall = 0;
  for (const p of sorted) {
    area += p.precision * (p.recall - prevRecall);
    prevRecall = p.recall;
  }
  return area;
}
