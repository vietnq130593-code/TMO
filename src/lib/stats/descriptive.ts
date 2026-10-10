/**
 * Thống kê mô tả (descriptive statistics) — module thuần toán, không side-effect.
 *
 * Nguồn: BLUEPRINT-STATS-LEARNING-P0-P6.md mục P0-1 (DA.pdf §Pandas/§EDA —
 * quantile type-7, outlier IQR bounds; MATH.pdf §2 — kỳ vọng/độ lệch mẫu n−1).
 * Đối chiếu scaffold đã kiểm chứng: git 9f85be5 src/lib/stats/descriptive.ts.
 *
 * Convention:
 * - `quantile`: type-7 (linear interpolation — chuẩn Hyndman–Fan, R default).
 * - `stddev`: độ lệch chuẩn MẪU (chia n−1, unbiased) — khớp MATH.pdf §2.
 * - Mảng rỗng / n quá nhỏ → NaN (fail-open cho đo lường, KHÔNG throw —
 *   blueprint nguyên tắc 3; khác scaffold cũ vốn throw).
 * - Không hàm nào mutate mảng đầu vào (sort trên bản sao).
 */

/** Kỳ vọng số học. Mảng rỗng → NaN (0/0, trung thực công thức). */
export function mean(xs: number[]): number {
  const n = xs.length;
  if (n === 0) return Number.NaN;
  let sum = 0;
  for (const v of xs) sum += v;
  return sum / n;
}

/**
 * Phân vị type-7 (linear interpolation): sắp xếp tăng dần trên BẢN SAO,
 * h = (n−1)·q, kết quả = x[⌊h⌋] + (h − ⌊h⌋)·(x[⌊h⌋+1] − x[⌊h⌋]) (0-based,
 * clamp chỉ số trên cho q = 1). Mảng rỗng hoặc q ngoài [0, 1] / không hữu hạn
 * → NaN (đầu vào sai không làm gãy đường đo — fail-open).
 */
export function quantile(xs: number[], q: number): number {
  const n = xs.length;
  if (n === 0) return Number.NaN;
  if (!Number.isFinite(q) || q < 0 || q > 1) return Number.NaN;
  const sorted = [...xs].sort((a, b) => a - b);
  const h = (n - 1) * q;
  const lo = Math.floor(h);
  const hi = Math.min(lo + 1, n - 1); // clamp cho q = 1 (h = n−1 nguyên)
  return sorted[lo] + (h - lo) * (sorted[hi] - sorted[lo]);
}

/** Trung vị = quantile(x, 0.5). Mảng rỗng → NaN. */
export function median(xs: number[]): number {
  return quantile(xs, 0.5);
}

/**
 * Rìa phát hiện outlier theo IQR (DA.pdf §Outlier IQR — Tukey fence):
 *   low  = q1 − k·(q3 − q1),  high = q3 + k·(q3 − q1)  (k mặc định 1.5).
 * Mảng rỗng HOẶC k không hữu hạn/khiêm (k < 0) → cả 4 trường NaN
 * (k âm sẽ làm low/high đảo chiều — fence vô nghĩa; FB-P0-R1-04).
 */
export function iqrBounds(xs: number[], k = 1.5): {
  low: number;
  high: number;
  q1: number;
  q3: number;
} {
  if (xs.length === 0 || !Number.isFinite(k) || k < 0) {
    return { low: Number.NaN, high: Number.NaN, q1: Number.NaN, q3: Number.NaN };
  }
  const q1 = quantile(xs, 0.25);
  const q3 = quantile(xs, 0.75);
  const iqr = q3 - q1;
  return { low: q1 - k * iqr, high: q3 + k * iqr, q1, q3 };
}

/** Độ lệch chuẩn MẪU (chia n−1). n < 2 → NaN (không đủ bậc tự do). */
export function stddev(xs: number[]): number {
  const n = xs.length;
  if (n < 2) return Number.NaN;
  const m = mean(xs);
  let acc = 0;
  for (const v of xs) {
    const d = v - m;
    acc += d * d;
  }
  return Math.sqrt(acc / (n - 1));
}

/**
 * Chuẩn hoá z = (x − μ)/σ. Defensive: σ ≤ 0 hoặc σ không hữu hạn → 0
 * (không có độ phân tán hữu ích thì không phân biệt được độ lệch thường —
 * trả 0 thay vì ±Infinity/NaN/đảo dấu để đường anomaly-detector P1-M3
 * không bị một điểm dữ liệu hằng giết cả cụm; σ âm thuần tuý là lỗi lời
 * gọi — đảo dấu kết quả còn nguy hơn NaN — FB-P0-R1-03).
 */
export function zScore(x: number, mu: number, sigma: number): number {
  if (!(sigma > 0)) return 0;
  return (x - mu) / sigma;
}
