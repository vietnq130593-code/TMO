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
 * FB-Đợt7-R4 (hiệu năng — đo thật máy sandbox): với d lớn (2048) việc build
 * tường minh ma trận C (n·d² phép nhân) chiếm phần lớn thời gian (500×2048
 * ≈ 4.4s). Khi 2n < d ta tính tích C·v NGẪM qua X: C·v = Xᵀ(X·v)/(n−1) —
 * O(n·d) mỗi phép nhân thay vì O(d²), không tốn bộ nhớ d×d (đo lại ≈ 0.3-1s
 * cùng dữ liệu). d nhỏ giữ đường tường minh (rẻ hơn và giữ đường đã đo).
 *
 * FB-Đợt7-R4 (toán học — kẹt trục phụ): khởi tạo từ diag(C) có thể trùng
 * CHÍNH XÁC một vector riêng của C trên dữ liệu đối xứng hoán-trục
 * (diag(C) ∝ trục PHỤ — vd cụm điểm nằm trên y=−x trội + y=x phụ cho
 * var_x = var_y bit-perfect): iteration đứng yên ở trục phụ mãi mãi và
 * trả HƯỚNG SAI (không null như comment cũ tuyên bố — đã tái lập bằng
 * script độc lập: component1 = trục phụ var 0.056 thay vì trội 0.944).
 * Fix: phát hiện "v₀ là vector riêng chính xác" bằng residual của phép
 * nhân đầu (w₀ − (v₀ᵀw₀)v₀ ≈ 0) rồi bứt khỏi thế kẹt bằng nhiễu nhỏ
 * TẤT ĐỊNH — nếu v₀ vốn là trục TRỘI thì iteration kéo về đúng nó (vô
 * hại); nếu là trục phụ thì thoát ra trục trội. Hạn chế còn lại (ghi
 * trung thực): cặp giá trị riêng gần suy biến (λ1/λ2 → 1) thì nhiễu
 * 1e-4 cần >maxIter vòng để chiếm ưu thế — khi đó mọi vector trong
 * mặt phẳng suy biến đều gần-tối ưu về phương sai, kết quả vẫn hợp lệ
 * về giải thích phương sai (test regression pin case đối xứng).
 *
 * Thuần, deterministic (không RNG — vector khởi tạo từ diag(C) + nhiễu
 * tất định theo chỉ số chiều), không I/O.
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
 * Nhiễu TẤT ĐỊNH trực giao với v (pattern xen kẽ ±1, dự phòng pattern 3-chu
 * kỳ) — dùng bứt khỏi thế "v₀ là vector riêng chính xác" (FB-Đợt7-R4 B1).
 * Trả null nếu không dựng được (v song song mọi pattern — cấu trúc bệnh lý).
 */
function deterministicOrthogonalTo(v: number[]): number[] | null {
  const patterns: Array<(j: number) => number> = [
    j => (j % 2 === 0 ? 1 : -1),
    j => ((j % 3) - 1) || 1,
  ]
  for (const pattern of patterns) {
    const u = v.map((_, j) => pattern(j))
    const c = dot(u, v)
    const orth = u.map((x, j) => x - c * v[j])
    const nrm = Math.sqrt(dot(orth, orth))
    if (nrm > 1e-8) return orth.map(x => x / nrm)
  }
  return null
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
  const X = vectors.map(v => v.map((x, j) => x - mean[j]))

  // 2) Chiến lược nhân ma trận (FB-Đợt7-R4 hiệu năng):
  //    - IMPLICIT khi 2n < d: C·v = Xᵀ(X·v)/(n−1) — O(n·d)/lần, khỏi build C
  //      (đường tốn kém nhất cũ: n·d² chỉ để build). Đây là đường thật của
  //      embedding 2048-dim (n ≤ 500 < 1024).
  //    - EXPLICIT khi d nhỏ: build C d×d một lần, mỗi phép nhân O(d²) — rẻ
  //      hơn implicit khi 2n ≥ d và giữ nguyên đường đã đo cho test hiện có.
  const useImplicit = 2 * n < d
  let C: number[][] | null = null
  if (!useImplicit) {
    const denom = n > 1 ? n - 1 : 1
    C = Array.from({ length: d }, () => new Array<number>(d).fill(0))
    for (let i = 0; i < n; i++) {
      const x = X[i]
      for (let j = 0; j < d; j++) {
        const xj = x[j]
        if (xj === 0) continue // nhỏ nhanh cho vector thưa
        const row = C[j]
        for (let k = 0; k < d; k++) row[k] += (xj * x[k]) / denom
      }
    }
  }

  /** C·v (đúng nghĩa toán — hai đường triển khai cho cùng kết quả). */
  const mulA = (v: number[]): number[] => {
    if (C) {
      const out = new Array<number>(d).fill(0)
      for (let j = 0; j < d; j++) {
        const row = C[j]
        let s = 0
        for (let k = 0; k < d; k++) s += row[k] * v[k]
        out[j] = s
      }
      return out
    }
    // Xᵀ(X·v)/(n−1)
    const denom = n > 1 ? n - 1 : 1
    const Xv = new Array<number>(n).fill(0)
    for (let i = 0; i < n; i++) {
      let s = 0
      const xi = X[i]
      for (let j = 0; j < d; j++) s += xi[j] * v[j]
      Xv[i] = s
    }
    const out = new Array<number>(d).fill(0)
    for (let j = 0; j < d; j++) {
      let s = 0
      for (let i = 0; i < n; i++) s += X[i][j] * Xv[i]
      out[j] = s / denom
    }
    return out
  }

  /** diag(C) — vector khởi tạo tất định (phương sai từng chiều). */
  const diagVec = (): number[] => {
    if (C) return C.map((row, j) => row[j])
    const denom = n > 1 ? n - 1 : 1
    const out = new Array<number>(d).fill(0)
    for (let i = 0; i < n; i++) {
      const xi = X[i]
      for (let j = 0; j < d; j++) out[j] += (xi[j] * xi[j]) / denom
    }
    return out
  }

  // trace(C) = tổng phương sai theo chiều (không âm) — mẫu số tỉ lệ giải thích
  let trace = 0
  for (const t of diagVec()) trace += t
  if (!(trace > 0) || !Number.isFinite(trace)) return null // suy biến: mọi điểm trùng tâm

  /**
   * Power iteration 1 thành phần — trả {v, λ} hay null khi suy biến.
   * FB-Đợt7-R4 B1: kiểm residual phép nhân ĐẦU — v₀ là vector riêng chính
   * xác (w₀ song song v₀, hoặc w₀ = 0 ở C₂ sau deflation) → bứt bằng nhiễu
   * tất định 1e-4: trục trội thì iteration tự quay về đúng nó, trục phụ thì
   * thoát ra (tái lập bằng test đối xứng regression).
   * R5: `initDiag` tiêm riêng — thành phần 2 khởi tạo từ diag(C₂) (bản gốc)
   * thay vì diag(C) — khớp lại ngữ nghĩa cũ 100% (R4 viết lại nhầm 1 nguồn).
   */
  const powerIterate = (mul: (v: number[]) => number[], initDiag: number[]): { v: number[]; lambda: number } | null => {
    let v = normalize(initDiag)
    if (dot(v, v) === 0) return null

    // B1-fix: phát hiện thế kẹt "vector khởi tạo là vector riêng chính xác"
    {
      const w0 = mul(v)
      const w0n = Math.sqrt(dot(w0, w0))
      const lam0 = w0n > 0 ? dot(v, w0) : 0
      const residual = w0.map((x, j) => x - lam0 * v[j])
      const resNorm = Math.sqrt(dot(residual, residual))
      const stuck = !(w0n > 0) || (Number.isFinite(w0n) && resNorm <= 1e-12 * w0n)
      if (stuck) {
        const u = deterministicOrthogonalTo(v)
        if (u) v = normalize(v.map((x, j) => x + 1e-4 * u[j]))
      }
    }

    let lambda = 0
    for (let iter = 0; iter < maxIter; iter++) {
      // w = A·v
      const w = mul(v)
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

  const first = powerIterate(mulA, diagVec())
  if (!first || !(first.lambda > 0)) return null
  const component1 = first.v
  const lambda1 = first.lambda

  // 3) Deflation: C'·v = C·v − λ1·v1·(v1ᵀv) (chỉ cần phép nhân cho vòng 2)
  const mulA2 = (v: number[]): number[] => {
    const w = mulA(v)
    const c = lambda1 * dot(component1, v)
    return w.map((x, j) => x - c * component1[j])
  }
  // init cho vòng 2 = diag(C₂) = diag(C) − λ1·v1[j]² (R5: đúng bản gốc)
  const diagC2 = diagVec().map((t, j) => t - lambda1 * component1[j] * component1[j])

  const second = powerIterate(mulA2, diagC2)
  // λ2 = 0 hợp lệ (dữ liệu thật sự 1 chiều) — vẫn cho bản đồ 1D dẹt dần theo trục 2 = 0
  const component2 = second ? second.v : new Array<number>(d).fill(0)
  const lambda2 = second ? Math.max(0, second.lambda) : 0

  // 4) Chiếu từng điểm (dùng điểm ĐÃ chuẩn hóa tâm — đúng nghĩa PCA)
  const xy: Array<[number, number]> = X.map(x => [dot(x, component1), dot(x, component2)])

  // R5 (live probe): λ/trace có thể vượt 1 cỡ epsilon float (đo thật
  // 1.0000000000000027 khi λ1≈trace — 2 điểm trên 1 đường) — clamp [0,1]
  // để consumer (UI % variance, tổng 2 thành phần) không bao giờ thấy >100%.
  const ratio = (x: number): number => Math.min(1, Math.max(0, x))

  return {
    xy,
    explainedVariances: [ratio(lambda1 / trace), ratio(lambda2 / trace)],
    component1,
    component2,
  }
}
