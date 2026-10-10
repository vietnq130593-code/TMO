/**
 * P5-M1 · PCA/SVD TOP-2 — power iteration trên ma trận hiệp phương sai
 * (BLUEPRINT-STATS-LEARNING-P0-P6 §P5-M1, mục #14 — MATH.pdf §PCA/§SVD/
 * §Eigenvalues)
 *
 * Chuẩn hóa về tâm (trừ mean từng chiều) → C = XᵀX/(n−1) (d×d) → power
 * iteration tìm vector riêng trội λ1 (thành phần chính 1) → deflation
 * C ← C − λ1·v1·v1ᵀ → power iteration lần nữa cho λ2. Trả về phép chiếu
 * 2 chiều (xy) cho TỪNG vector đầu vào + tỉ lệ phương sai giải thích
 * (λ/trace) — đầu vào cho /api/query?action=graph-explore vẽ bản đồ tri thức.
 *
 * Vì sao power iteration thay vì giải đặc trưng đầy đủ: d có thể tới 2048
 * (embedding) — thuật toán đặc trưng tổng quát O(d³) tốn; chỉ cần TOP-2 thì
 * power iteration O(iter·d²) là đủ và là chính bài toán trong MATH.pdf
 * §Eigenvalues (spectralNorm = |λ| lớn nhất qua lặp C·v / ‖C·v‖).
 *
 * Thuần, deterministic (không RNG — vector khởi tạo từ diag(C)), không I/O.
 */

export interface PcaTop2Result {
  /** [x, y] cho từng vector đầu vào (CÙNG thứ tự) — chiếu lên PC1/PC2 */
  xy: Array<[number, number]>
  /** (λ1/trace, λ2/trace) — tổng phương sai 2 thành phần giải thích được */
  explainedVariances: [number, number]
  /** vector riêng đơn vị theo từng chiều gốc (d chiều) */
  component1: number[]
  component2: number[]
}

export interface PcaOptions {
  /** Số vòng lặp tối đa mỗi thành phần (default 100) */
  maxIter?: number
  /** Dừng khi |λt − λt−1| < tol·λt (default 1e-10) */
  tol?: number
}

/** Tích vô hướng 2 vector cùng chiều. */
function dot(a: number[], b: number[]): number {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i] * b[i]
  return s
}

/** Chuẩn hóa về đơn vị (norm-2). Vector 0 → trả nguyên (caller kiểm λ>0). */
function normalize(v: number[]): number[] {
  const n = Math.sqrt(dot(v, v))
  if (n === 0 || !Number.isFinite(n)) return v.slice()
  return v.map(x => x / n)
}

/**
 * PCA top-2 bằng power iteration + deflation.
 * Trả null khi không tính được: <2 vector, <2 chiều, phương sai suy biến
 * (mọi điểm trùng nhau → không có "bản đồ" để vẽ).
 */
export function pcaTop2(vectors: number[][], opts: PcaOptions = {}): PcaTop2Result | null {
  const maxIter = opts.maxIter ?? 100
  const tol = opts.tol ?? 1e-10

  const n = vectors.length
  if (n < 2) return null
  const d = vectors[0].length
  if (d < 2) return null
  for (const v of vectors) if (v.length !== d) return null // ma trận lệch — từ chối

  // 1) Chuẩn hóa về tâm: mean từng chiều
  const mean = new Array<number>(d).fill(0)
  for (const v of vectors) for (let j = 0; j < d; j++) mean[j] += v[j] / n
  const centered = vectors.map(v => v.map((x, j) => x - mean[j]))

  // 2) Hiệp phương sai C = XᵀX/(n−1) — chỉ cần C·v nên lưu dạng ma trận d×d
  //    (d ≤ 2048 → 4.2M phần tử ~33MB float — trong budget route cap 500 điểm)
  const denom = n > 1 ? n - 1 : 1
  const C: number[][] = Array.from({ length: d }, () => new Array<number>(d).fill(0))
  for (let i = 0; i < n; i++) {
    const x = centered[i]
    for (let j = 0; j < d; j++) {
      const xj = x[j]
      if (xj === 0) continue // nhỏ nhanh cho vector thưa
      const row = C[j]
      for (let k = 0; k < d; k++) row[k] += (xj * x[k]) / denom
    }
  }

  // trace(C) = tổng phương sai theo chiều (không âm) — mẫu số tỉ lệ giải thích
  let trace = 0
  for (let j = 0; j < d; j++) trace += C[j][j]
  if (!(trace > 0) || !Number.isFinite(trace)) return null // suy biến: mọi điểm trùng tâm

  /** Power iteration 1 thành phần — trả {v, λ} hay null khi suy biến */
  const powerIterate = (matrix: number[][]): { v: number[]; lambda: number } | null => {
    // Khởi tạo DETERMINISTIC từ diag(C) — dương với mọi chiều có phương sai,
    // không trực giao với vector trội trừ khi cấu trúc đặc biệt (không xảy ra
    // trên dữ liệu thật; nếu có, λ hội tụ 0 → null → caller xử suy biến)
    let v = normalize(matrix.map((row, j) => row[j]))
    if (dot(v, v) === 0) return null
    let lambda = 0
    for (let iter = 0; iter < maxIter; iter++) {
      // w = C·v
      const w = new Array<number>(d).fill(0)
      for (let j = 0; j < d; j++) {
        const row = matrix[j]
        let s = 0
        for (let k = 0; k < d; k++) s += row[k] * v[k]
        w[j] = s
      }
      const wNorm = Math.sqrt(dot(w, w))
      if (!(wNorm > 0) || !Number.isFinite(wNorm)) return null // vector trực giao/suy biến
      const vNext = w.map(x => x / wNorm)
      const lambdaNext = dot(vNext, w) // λ = vᵀ·(C·v) với v đơn vị
      const converged = iter > 0 && Math.abs(lambdaNext - lambda) <= tol * Math.max(Math.abs(lambda), 1e-30)
      v = vNext
      lambda = lambdaNext
      if (converged) break
    }
    return { v, lambda }
  }

  const first = powerIterate(C)
  if (!first || !(first.lambda > 0)) return null
  const component1 = first.v
  const lambda1 = first.lambda

  // 3) Deflation: C' = C − λ1·v1·v1ᵀ (chỉ cần C'·v cho vòng 2)
  const C2: number[][] = C.map((row, j) =>
    row.map((c, k) => c - lambda1 * component1[j] * component1[k])
  )

  const second = powerIterate(C2)
  // λ2 = 0 hợp lệ (dữ liệu thật sự 1 chiều) — vẫn cho bản đồ 1D dẹt dần theo trục 2 = 0
  const component2 = second ? second.v : new Array<number>(d).fill(0)
  const lambda2 = second ? Math.max(0, second.lambda) : 0

  // 4) Chiếu từng điểm (dùng điểm ĐÃ chuẩn hóa tâm — đúng nghĩa PCA)
  const xy: Array<[number, number]> = centered.map(x => [dot(x, component1), dot(x, component2)])

  return {
    xy,
    explainedVariances: [lambda1 / trace, lambda2 / trace],
    component1,
    component2,
  }
}
