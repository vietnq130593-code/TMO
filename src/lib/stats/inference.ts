/**
 * Thống kê suy luận (inferential statistics) — module thuần toán, không side-effect.
 *
 * Nguồn: BLUEPRINT-STATS-LEARNING-P0-P6.md mục P0-1 (MATH.pdf §Thống kê suy luận
 * — Wilson CI, Welch-t, Mann-Whitney U, χ²/Fisher, ANOVA; DA.pdf §Hypothesis
 * Testing, §CLT).
 *
 * CDF machinery PORT NGUYÊN VẸN từ scaffold đã kiểm chứng 37/37 (git 9f85be5
 * src/lib/stats/distributions.ts — nguồn gốc Numerical Recipes 3rd ed. §6.2-6.4
 * + Abramowitz–Stegun 7.1.26): logGamma Lanczos g=7, regularizedIncompleteBeta
 * (modified Lentz), erf A&S 7.1.26, Student-t/χ²/F CDF. Theo spec P0-1, các CDF
 * này là HELPER NỘI BỘ — chỉ `normalCdf` là public.
 *
 * Duy nhất 1 điều chỉnh so với scaffold: studentTCdf nhận df > 0 THỰC (không
 * còn ép nguyên) — Welch–Satterthwaite df là số hữu tỷ (vd 8.73) và công thức
 * I_x(df/2, 1/2) đúng cho mọi df > 0; bản cũ ép nguyên chỉ là ràng buộc API
 * công khai, không phải của toán học.
 *
 * Convention:
 * - meanCI: z-based CLT THUẦN (x̄ ± z·s/√n) — KHÔNG t-distribution như scaffold
 *   cũ (spec P0-1 của repo này; khác biệt đã ghi worklog).
 * - wilsonCI: công thức Wilson chuẩn, z mặc định 1.96.
 * - Nhóm quá nhỏ (n < 2...) → NaN các trường tính được (fail-open, không throw).
 */

import { mean, stddev } from "./descriptive";

// ---------------------------------------------------------------------------
// CDF machinery nội bộ (port từ scaffold 9f85be5 — đã kiểm chứng 37/37)
// ---------------------------------------------------------------------------

/** Hệ số Lanczos g = 7, 9 hệ số (chuẩn Numerical Recipes; sai số < 2e-10). */
const LANCZOS_G7: readonly number[] = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028,
  771.32342877765313, -176.61502916214059, 12.507343278686905,
  -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
];

/**
 * logΓ(z) — logarit tự nhiên của hàm gamma, tính trong log-space để tránh
 * overflow. z ≤ 0 → throw.
 * - z < 0.5: reflection logΓ(z) = ln(π) − ln(sin(πz)) − logΓ(1−z).
 * - z ≥ 0.5: Lanczos với z' = z−1, t = z'+7.5,
 *   x̂ = C[0] + Σ_{i=1..8} C[i]/(z'+i),
 *   logΓ(z) = 0.5·ln(2π) + (z'+0.5)·ln(t) − t + ln(x̂).
 * z ∈ {1, 2} trả đúng 0 (Γ(1) = Γ(2) = 1) — giá trị giải tích chính xác.
 */
function logGamma(z: number): number {
  if (!Number.isFinite(z) || z <= 0) {
    throw new Error(`logGamma: yêu cầu z > 0 (nhận ${z})`);
  }
  if (z === 1 || z === 2) return 0; // Γ(1) = Γ(2) = 1 → ln = 0 chính xác
  if (z < 0.5) {
    return Math.log(Math.PI) - Math.log(Math.sin(Math.PI * z)) - logGamma(1 - z);
  }
  const z0 = z - 1;
  const t = z0 + 7.5;
  let xHat = LANCZOS_G7[0];
  for (let i = 1; i <= 8; i++) {
    xHat += LANCZOS_G7[i] / (z0 + i);
  }
  return 0.5 * Math.log(2 * Math.PI) + (z0 + 0.5) * Math.log(t) - t + Math.log(xHat);
}

/** ln C(n, k) — tổ hợp trong log-space (dùng cho Fisher exact). */
function logChoose(n: number, k: number): number {
  return logGamma(n + 1) - logGamma(k + 1) - logGamma(n - k + 1);
}

/**
 * Continued fraction cho incomplete beta (modified Lentz — NR 6.4).
 * eps 3e-12, fpmin 1e-300, tối đa 300 vòng.
 */
function betacf(a: number, b: number, x: number): number {
  const EPS = 3e-12;
  const FPMIN = 1e-300;
  const MAX_ITER = 300;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= MAX_ITER; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;
    aa = -((a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

/**
 * Regularized incomplete beta I_x(a, b) — NR 6.4.
 * x ≤ 0 → 0; x ≥ 1 → 1.
 * lnB = logΓ(a) + logΓ(b) − logΓ(a+b); bt = exp(a·ln x + b·ln(1−x) − lnB).
 * x < (a+1)/(a+b+2) → I = bt·betacf(a,b,x)/a; ngược lại I = 1 − bt·betacf(b,a,1−x)/b.
 */
function regularizedIncompleteBeta(a: number, b: number, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const lnB = logGamma(a) + logGamma(b) - logGamma(a + b);
  const bt = Math.exp(a * Math.log(x) + b * Math.log(1 - x) - lnB);
  if (x < (a + 1) / (a + b + 2)) {
    return (bt * betacf(a, b, x)) / a;
  }
  return 1 - (bt * betacf(b, a, 1 - x)) / b;
}

/**
 * erf(x) — xấp xỉ Abramowitz–Stegun 7.1.26 (sai số ≤ 1.5e-7).
 * Horner theo t = 1/(1 + 0.3275911·|x|), giữ dấu bằng sgn.
 */
function erf(x: number): number {
  const sgn = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const u =
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t;
  return sgn * (1 - u * Math.exp(-ax * ax));
}

/**
 * CDF phân phối Student t: P(T ≤ t).
 * t = 0 → 0.5; t > 0 → 1 − 0.5·I_{df/(df+t²)}(df/2, 0.5);
 * t < 0 → 0.5·I_{df/(df+t²)}(df/2, 0.5).
 * df > 0 bất kỳ (kể cả hữu tỷ — Welch–Satterthwaite); df ≤ 0 → throw.
 */
function studentTCdf(t: number, df: number): number {
  if (!Number.isFinite(df) || df <= 0) {
    throw new Error(`studentTCdf: yêu cầu df > 0 (nhận ${df})`);
  }
  if (t === 0) return 0.5;
  const x = df / (df + t * t);
  const ib = regularizedIncompleteBeta(df / 2, 0.5, x);
  return t > 0 ? 1 - 0.5 * ib : 0.5 * ib;
}

/**
 * CDF phân phối chi-square: P(χ²_k ≤ x) = P(k/2, x/2)
 * (lower regularized incomplete gamma).
 * x ≤ 0 → 0. k < 1 → throw.
 * - xx < a+1: chuỗi lũy thừa (NR 6.2).
 * - ngược lại: continued fraction (NR 6.3, modified Lentz) cho Q, rồi P = 1 − Q.
 */
function chiSquareCdf(x: number, k: number): number {
  if (!Number.isFinite(k) || k < 1) {
    throw new Error(`chiSquareCdf: k phải >= 1 (nhận ${k})`);
  }
  if (x <= 0) return 0;
  const a = k / 2;
  const xx = x / 2;
  if (xx < a + 1) {
    // Chuỗi lũy thừa (NR 6.2)
    let ap = a;
    let sum = 1 / a;
    let del = sum;
    for (let n = 1; n <= 300; n++) {
      ap += 1;
      del *= xx / ap;
      sum += del;
      if (Math.abs(del) < Math.abs(sum) * 3e-12) break;
    }
    return sum * Math.exp(-xx + a * Math.log(xx) - logGamma(a));
  }
  // Continued fraction cho Q(a, xx) (NR 6.3 — modified Lentz)
  const FPMIN = 1e-300;
  let b = xx + 1 - a;
  let c = 1e300;
  let d = 1 / b;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  let h = d;
  for (let i = 1; i <= 300; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = b + an / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 3e-12) break;
  }
  const q = Math.exp(-xx + a * Math.log(xx) - logGamma(a)) * h;
  return 1 - q;
}

/**
 * CDF phân phối F: P(F_{d1,d2} ≤ F) = I_{d1F/(d1F+d2)}(d1/2, d2/2).
 * F ≤ 0 → 0. d1, d2 phải là số nguyên dương (vi phạm → throw).
 */
function fCdf(F: number, d1: number, d2: number): number {
  if (!Number.isInteger(d1) || d1 < 1) {
    throw new Error(`fCdf: d1 phải là số nguyên dương (nhận ${d1})`);
  }
  if (!Number.isInteger(d2) || d2 < 1) {
    throw new Error(`fCdf: d2 phải là số nguyên dương (nhận ${d2})`);
  }
  if (F <= 0) return 0;
  const d1f = d1 * F;
  const x = d1f / (d1f + d2);
  return regularizedIncompleteBeta(d1 / 2, d2 / 2, x);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Φ(z) = ½(1 + erf(z/√2)) — erf xấp xỉ Abramowitz–Stegun 7.1.26 (A&S). */
export function normalCdf(z: number): number {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

/**
 * Wilson score interval cho tỷ lệ:
 *   (p̂ + z²/2n ± z·√(p̂(1−p̂)/n + z²/4n²)) / (1 + z²/n)
 * Không đảo chiều khi p̂ gần 0/1 (tốt hơn Wald). z mặc định 1.96 (95%).
 * n ≤ 0 → NaN cả hai (fail-open).
 *
 * Lưu ý erratum BUG2-035: ví dụ blueprint ghi wilsonCI(0.8, 25) → [0.616, 0.910]
 * ứng với z ≈ 1.9; giá trị đúng với z = 1.96 mặc định là [0.6087, 0.9114].
 */
export function wilsonCI(p: number, n: number, z = 1.96): { low: number; high: number } {
  if (n <= 0) return { low: Number.NaN, high: Number.NaN };
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { low: center - half, high: center + half };
}

/**
 * CI cho kỳ vọng theo CLT thuần: x̄ ± z·s/√n (z mặc định 1.96, s là độ lệch
 * mẫu n−1). KHÔNG dùng t-distribution cho n nhỏ (quyết định spec P0-1 — khác
 * scaffold cũ). n < 2 → low/high NaN (mean vẫn trả x̄ khi n = 1; n = 0 → NaN).
 */
export function meanCI(xs: number[], z = 1.96): {
  mean: number;
  low: number;
  high: number;
  n: number;
} {
  const n = xs.length;
  const m = mean(xs);
  if (n < 2) return { mean: m, low: Number.NaN, high: Number.NaN, n };
  const se = stddev(xs) / Math.sqrt(n);
  return { mean: m, low: m - z * se, high: m + z * se, n };
}

/** Phương sai mẫu (chia n−1) — helper nội bộ (stddev đã public ở descriptive). */
function sampleVariance(xs: number[]): number {
  const n = xs.length;
  const m = mean(xs);
  let acc = 0;
  for (const v of xs) {
    const d = v - m;
    acc += d * d;
  }
  return acc / (n - 1);
}

/**
 * Welch's t-test (hai mẫu, phương sai không bằng):
 *   t = (meanA − meanB)/√(sA²/nA + sB²/nB),
 *   df = Welch–Satterthwaite = (sA²/nA + sB²/nB)² / [(sA²/nA)²/(nA−1) + (sB²/nB)²/(nB−1)],
 *   p hai phía = 2·(1 − studentTCdf(|t|, df)).
 * Nhóm nào n < 2 → cả 3 trường NaN. Trường hợp suy biến cả hai nhóm hằng
 * (mẫu số 0): mean bằng nhau → t = 0, p = 1 (không bằng chứng); mean khác
 * → t = ±Infinity, p = 0 (khác biệt tuyệt đối); df luôn NaN (0/0).
 */
export function welchTTest(a: number[], b: number[]): { t: number; df: number; p: number } {
  const nA = a.length;
  const nB = b.length;
  if (nA < 2 || nB < 2) return { t: Number.NaN, df: Number.NaN, p: Number.NaN };
  const mA = mean(a);
  const mB = mean(b);
  const seA = sampleVariance(a) / nA;
  const seB = sampleVariance(b) / nB;
  const denom = seA + seB;
  if (denom === 0) {
    if (mA === mB) return { t: 0, df: Number.NaN, p: 1 };
    return { t: mA > mB ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY, df: Number.NaN, p: 0 };
  }
  const t = (mA - mB) / Math.sqrt(denom);
  const df = (denom * denom) / ((seA * seA) / (nA - 1) + (seB * seB) / (nB - 1));
  const p = 2 * (1 - studentTCdf(Math.abs(t), df));
  return { t, df, p };
}

/**
 * Mann–Whitney U (Wilcoxon rank-sum) kèm hiệu chỉnh tie:
 *   U = min(U1, U2) với U1 = nA·nB + nA(nA+1)/2 − R1 (R1 = tổng hạng nhóm a,
 *   hạng trung bình khi tie);
 *   σU = √(nA·nB/12 · [(N+1) − Σ(t³−t)/(N(N−1))]);
 *   z = (U − nA·nB/2)/σU (z ≤ 0 theo quy ước min);
 *   p hai phía = 2·normalCdf(z).
 * σU = 0 (nhóm rỗng / mọi giá trị bằng nhau) → z = 0, p = 1.
 */
export function mannWhitneyU(a: number[], b: number[]): { u: number; z: number; p: number } {
  const nA = a.length;
  const nB = b.length;
  if (nA === 0 || nB === 0) return { u: 0, z: 0, p: 1 };
  // Gộp + xếp hạng (hạng trung bình khi tie) — dựng mảng MỚI, không mutate đầu vào
  const combined: Array<{ value: number; inA: boolean }> = [
    ...a.map((v) => ({ value: v, inA: true })),
    ...b.map((v) => ({ value: v, inA: false })),
  ];
  combined.sort((x, y) => x.value - y.value);
  const N = combined.length;
  const ranks = new Array<number>(N);
  let tieCorrection = 0; // Σ(t³ − t) trên các nhóm tie
  let i = 0;
  while (i < N) {
    let j = i;
    while (j + 1 < N && combined[j + 1].value === combined[i].value) j++;
    const t = j - i + 1;
    const avgRank = (i + j + 2) / 2; // hạng trung bình 1-based của khối tie
    for (let k = i; k <= j; k++) ranks[k] = avgRank;
    if (t > 1) tieCorrection += t * t * t - t;
    i = j + 1;
  }
  let r1 = 0;
  for (let k = 0; k < N; k++) if (combined[k].inA) r1 += ranks[k];
  const u1 = nA * nB + (nA * (nA + 1)) / 2 - r1;
  const u2 = nA * nB - u1;
  const u = Math.min(u1, u2);
  const sigmaU = Math.sqrt(((nA * nB) / 12) * (N + 1 - tieCorrection / (N * (N - 1))));
  if (sigmaU === 0) return { u, z: 0, p: 1 };
  const z = (u - (nA * nB) / 2) / sigmaU;
  return { u, z, p: 2 * normalCdf(z) };
}

/**
 * Fisher exact một phía cho bảng 2×2, theo HƯỚNG odds ratio quan sát:
 *   ad > bc → P(X ≥ a);  ad < bc → P(X ≤ a);  ad = bc → 1
 * với X ~ Hypergeometric(row1 = a+b, col1 = a+c, N = a+b+c+d):
 *   P(X = x) = C(col1, x)·C(N−col1, row1−x)/C(N, row1)  (tính bằng lgamma).
 * Ô âm → NaN (bảng không hợp lệ).
 */
export function fisherExact2x2(a: number, b: number, c: number, d: number): number {
  if (a < 0 || b < 0 || c < 0 || d < 0) return Number.NaN;
  const row1 = a + b;
  const col1 = a + c;
  const N = a + b + c + d;
  const col2 = N - col1;
  if (a * d === b * c) return 1;
  const xMin = Math.max(0, row1 - col2);
  const xMax = Math.min(row1, col1);
  const lnDenom = logChoose(N, row1);
  const probAt = (x: number): number =>
    Math.exp(logChoose(col1, x) + logChoose(col2, row1 - x) - lnDenom);
  let sum = 0;
  if (a * d > b * c) {
    for (let x = a; x <= xMax; x++) sum += probAt(x);
  } else {
    for (let x = xMin; x <= a; x++) sum += probAt(x);
  }
  return sum;
}

/**
 * Kiểm định χ² cho bảng 2×2 — Yates LUÔN LUÔN áp dụng (không phân biệt cỡ mẫu):
 *   χ² = N·max(0, |ad−bc| − N/2)² / [(a+b)(c+d)(a+c)(b+d)].
 * Expected nhỏ nhất < 5 (hoặc biên bằng 0) → p lấy từ fisherExact2x2 chính xác
 * thay vì xấp xỉ χ² (quy tắc Cochran; cf. DA.pdf §Hypothesis Testing). N ≤ 0 →
 * NaN cả hai.
 */
export function chiSquare2x2(a: number, b: number, c: number, d: number): {
  chi2: number;
  p: number;
} {
  const N = a + b + c + d;
  if (N <= 0) return { chi2: Number.NaN, p: Number.NaN };
  const row1 = a + b;
  const row2 = c + d;
  const col1 = a + c;
  const col2 = b + d;
  const denom = row1 * row2 * col1 * col2;
  const chi2 =
    denom === 0
      ? Number.NaN // biên bằng 0 → không thể định nghĩa χ²
      : (N * Math.pow(Math.max(0, Math.abs(a * d - b * c) - N / 2), 2)) / denom;
  // Expected nhỏ nhất của 4 ô — dưới 5 thì χ² xấp xỉ mất tin cậy
  const minExpected = Math.min((row1 * col1) / N, (row1 * col2) / N, (row2 * col1) / N, (row2 * col2) / N);
  if (denom === 0 || minExpected < 5) {
    return { chi2, p: fisherExact2x2(a, b, c, d) };
  }
  return { chi2, p: 1 - chiSquareCdf(chi2, 1) };
}

/**
 * One-way ANOVA (F-test):
 *   F = [SSB/(k−1)]/[SSW/(n−k)] — nhóm rỗng được bỏ qua trước khi đếm k;
 *   p = 1 − fCdf(F, dfBetween, dfW).
 * k < 2 hoặc dfW ≤ 0 → CẢ 4 TRƯỜNG NaN (không đủ bậc tự do để kiểm định).
 * Trường hợp suy biến SSW = 0 (mọi nhóm hằng): SSB = 0 → F = 0, p = 1;
 * SSB > 0 → F = +Infinity, p = 0.
 */
export function anovaF(groups: number[][]): {
  f: number;
  dfBetween: number;
  dfWithin: number;
  p: number;
} {
  const nonEmpty = groups.filter((g) => g.length > 0);
  const k = nonEmpty.length;
  if (k < 2) {
    return { f: Number.NaN, dfBetween: Number.NaN, dfWithin: Number.NaN, p: Number.NaN };
  }
  let n = 0;
  for (const g of nonEmpty) n += g.length;
  const dfB = k - 1;
  const dfW = n - k;
  if (dfW <= 0) {
    return { f: Number.NaN, dfBetween: Number.NaN, dfWithin: Number.NaN, p: Number.NaN };
  }
  let total = 0;
  for (const g of nonEmpty) {
    for (const v of g) total += v;
  }
  const grand = total / n;
  let ssb = 0;
  let ssw = 0;
  for (const g of nonEmpty) {
    const gm = mean(g);
    ssb += g.length * (gm - grand) * (gm - grand);
    for (const v of g) ssw += (v - gm) * (v - gm);
  }
  if (ssw === 0) {
    if (ssb === 0) return { f: 0, dfBetween: dfB, dfWithin: dfW, p: 1 };
    return { f: Number.POSITIVE_INFINITY, dfBetween: dfB, dfWithin: dfW, p: 0 };
  }
  const f = ssb / dfB / (ssw / dfW);
  return { f, dfBetween: dfB, dfWithin: dfW, p: 1 - fCdf(f, dfB, dfW) };
}
