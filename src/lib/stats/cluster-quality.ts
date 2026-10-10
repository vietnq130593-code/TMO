/**
 * Đo lường chất lượng cụm (cluster quality) — module thuần toán, không side-effect.
 *
 * Nguồn: BLUEPRINT-STATS-LEARNING-P0-P6.md mục P0-1 (ML.pdf §5 — Silhouette,
 * Davies–Bouldin, Calinski–Harabasz). Nhà tiêu thụ chính: P1-M5 silhouette
 * Leiden communities.
 *
 * Convention:
 * - `silhouetteScore` nhận hàm khoảng cách tuỳ chọn (mặc định 1 − cosine).
 * - `silhouetteFromGraph` nhận trọng số ĐỘ TƯƠNG TỰ (càng cao càng gần) —
 *   xem JSDoc adjudication dấu bên dưới (erratum BUG2-037).
 * - vectors.length khác labels.length → throw (lỗi lập trình của lời gọi).
 * - Cấu hình degenerate (1 cụm, rỗng, singleton...) → 0 (qui ước sklearn).
 */

/** Cạnh đồ thị có trọng số (bất đối xứng ở đầu vào, xử lý như vô hướng). */
export interface GraphEdge {
  source: number;
  target: number;
  weight: number;
}

/**
 * Khoảng cách mặc định 1 − cosine cho vector cùng chiều:
 * vector 0 (độ dài 0) → khoảng cách 1 (không tương đồng — qui ước sklearn);
 * cosine bị kẹp vào [−1, 1] chống tràn dấu phẩy động → khoảng cách ∈ [0, 2].
 */
function cosineDistance(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(`cosineDistance: hai vector khác chiều dài (${a.length} vs ${b.length})`);
  }
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  if (denom === 0) return 1;
  const cos = Math.min(1, Math.max(-1, dot / denom));
  return 1 - cos;
}

/** Nhóm chỉ số theo nhãn: Map<label, chỉ số các phần tử>. */
function groupByLabel(labels: number[]): Map<number, number[]> {
  const clusters = new Map<number, number[]>();
  for (let i = 0; i < labels.length; i++) {
    const arr = clusters.get(labels[i]);
    if (arr === undefined) clusters.set(labels[i], [i]);
    else arr.push(i);
  }
  return clusters;
}

/**
 * Silhouette trên vector:
 *   s(i) = (b − a)/max(a, b)
 * với a = mean khoảng cách tới CÁC PHẦN TỬ KHÁC trong cùng cụm,
 *     b = min theo cụm khác của mean khoảng cách tới cụm đó.
 * Cụm singleton (kích thước 1) → s(i) = 0; cả dữ liệu chỉ có 1 cụm → 0;
 * max(a, b) = 0 → 0 (defensive). Kết quả = mean các s(i) trên TOÀN BỘ điểm
 * (singleton cộng sẵn 0).
 */
export function silhouetteScore(
  vectors: number[][],
  labels: number[],
  dist: (a: number[], b: number[]) => number = cosineDistance,
): number {
  const n = vectors.length;
  if (n !== labels.length) {
    throw new Error(`silhouetteScore: vectors (${n}) và labels (${labels.length}) khác độ dài`);
  }
  if (n === 0) return 0;
  const clusters = groupByLabel(labels);
  if (clusters.size < 2) return 0; // chỉ 1 cụm — không có cấu trúc để chấm điểm
  let total = 0;
  for (let i = 0; i < n; i++) {
    const own = clusters.get(labels[i]);
    if (own === undefined) continue; // không xảy ra (labels chính là khoá)
    if (own.length === 1) continue; // singleton → s(i) = 0
    let aSum = 0;
    for (const j of own) {
      if (j !== i) aSum += dist(vectors[i], vectors[j]);
    }
    const a = aSum / (own.length - 1);
    let b = Number.POSITIVE_INFINITY;
    for (const [lbl, members] of clusters) {
      if (lbl === labels[i]) continue;
      let s = 0;
      for (const j of members) s += dist(vectors[i], vectors[j]);
      const meanDist = s / members.length;
      if (meanDist < b) b = meanDist;
    }
    const denom = Math.max(a, b);
    if (denom > 0) total += (b - a) / denom;
  }
  return total / n;
}

/**
 * Silhouette trên ĐỒ THỊ có trọng số (biến thể cho cụm cộng đồng Leiden —
 * không có tọa độ vector, chỉ có cạnh).
 *
 * ADJUDICATION DẤU (erratum BUG2-037 — làm đúng chuẩn, khác công thức nguyên
 * văn blueprint): trọng số cạnh của Leiden là ĐỘ TƯƠNG TỰ (càng cao càng
 * gần). Nếu áp nguyên văn s = (b − a)/max(a, b) với a = mean trọng số nội cụm,
 * b = max mean trọng số liên cụm thì kết quả DƯƠNG khi gán cụm SAI (cạnh liên
 * mạnh làm b lớn) và ÂM khi gán đúng — ngược hoàn toàn ý nghĩa silhouette. Do
 * đó bản này ĐẢO DẤU:
 *   s(i) = (a − b)/max(a, b)   — dương = gán đúng cụm, âm = gán sai.
 *
 * Cơ chế:
 * - Chuẩn hoá trọng số về (0, 1): w' = w/(1+w) (đơn điệu tăng, w ≥ 0;
 *   w < 0 coi như 0 — không tương đồng).
 * - a(i) = mean w' các cạnh nội cụm của i (không có cạnh nội → a = 0 → nếu
 *   cụm > 1 phần tử thì s = −1 khi b > 0: gán tệ — cụm của i rời rạc).
 * - b(i) = MAX theo cụm khác của mean w' các cạnh từ i tới cụm đó
 *   (cụm "gần nhất" = tương tự nhất = mean w' cao nhất; không có cạnh liên
 *   cụm nào → b = 0).
 * - Cụm singleton → s(i) = 0; max(a, b) = 0 → 0; kết quả = mean toàn bộ.
 * Cạnh ngoài phạm vi node [0, n), tự-cạnh (source = target) bị bỏ qua;
 * cạnh được xử lý VÔ HƯỚNG (cộng cho cả 2 đầu mút).
 */
export function silhouetteFromGraph(
  n: number,
  edges: GraphEdge[],
  labels: number[],
): number {
  if (n !== labels.length) {
    throw new Error(`silhouetteFromGraph: n (${n}) và labels (${labels.length}) khác độ dài`);
  }
  if (n === 0) return 0;
  const clusters = groupByLabel(labels);
  if (clusters.size < 2) return 0; // 1 cụm duy nhất → 0
  // Tích luỹ theo node: (nhãn đối diện, w') cho mọi cạnh chạm node
  const adjacency: Array<Array<{ other: number; w: number }>> = Array.from(
    { length: n },
    () => [],
  );
  for (const e of edges) {
    if (e.source === e.target) continue; // tự-cạnh không mang thông tin cấu trúc
    if (e.source < 0 || e.source >= n || e.target < 0 || e.target >= n) continue;
    const w = e.weight < 0 ? 0 : e.weight / (1 + e.weight); // chuẩn hoá về [0, 1)
    adjacency[e.source].push({ other: e.target, w });
    adjacency[e.target].push({ other: e.source, w });
  }
  const clusterSize = new Map<number, number>();
  for (const [lbl, members] of clusters) clusterSize.set(lbl, members.length);
  let total = 0;
  for (let i = 0; i < n; i++) {
    const ownLbl = labels[i];
    if ((clusterSize.get(ownLbl) ?? 0) === 1) continue; // singleton → s(i) = 0
    // a(i): mean w' cạnh nội cụm
    let aSum = 0;
    let aCount = 0;
    // b(i): theo cụm khác — tổng w' và số cạnh
    const crossSum = new Map<number, number>();
    const crossCount = new Map<number, number>();
    for (const { other, w } of adjacency[i]) {
      const otherLbl = labels[other];
      if (otherLbl === ownLbl) {
        aSum += w;
        aCount++;
      } else {
        crossSum.set(otherLbl, (crossSum.get(otherLbl) ?? 0) + w);
        crossCount.set(otherLbl, (crossCount.get(otherLbl) ?? 0) + 1);
      }
    }
    const a = aCount === 0 ? 0 : aSum / aCount;
    let b = 0; // không có cạnh liên cụm nào → b = 0
    for (const [lbl, cnt] of crossCount) {
      const mean = (crossSum.get(lbl) ?? 0) / cnt;
      if (mean > b) b = mean;
    }
    const denom = Math.max(a, b);
    if (denom > 0) total += (a - b) / denom;
  }
  return total / n;
}

/** Trung bình các phần tử vector (centroid) — vector rỗng trả mảng rỗng. */
function centroidOf(vectors: number[][]): number[] {
  const dim = vectors[0]?.length ?? 0;
  const c = new Array<number>(dim).fill(0);
  for (const v of vectors) {
    for (let j = 0; j < dim; j++) c[j] += v[j];
  }
  for (let j = 0; j < dim; j++) c[j] /= vectors.length;
  return c;
}

/** Khoảng cách Euclid. */
function euclid(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    s += d * d;
  }
  return Math.sqrt(s);
}

/**
 * Davies–Bouldin (càng THẤP càng tốt):
 *   DB = (1/k)·Σ_i max_{j≠i} (S_i + S_j)/d(c_i, c_j)
 * với S_i = mean khoảng cách Euclid phần tử tới centroid cụm i. Hai centroid
 * trùng nhau (d = 0) → R_ij = Infinity (không tách được — xấu nhất).
 * 1 cụm / rỗng → 0 (không có cặp cụm nào để phạt).
 */
export function daviesBouldin(vectors: number[][], labels: number[]): number {
  const n = vectors.length;
  if (n !== labels.length) {
    throw new Error(`daviesBouldin: vectors (${n}) và labels (${labels.length}) khác độ dài`);
  }
  if (n === 0) return 0;
  const clusters = groupByLabel(labels);
  if (clusters.size < 2) return 0;
  // centroid + scatter từng cụm
  const centroids = new Map<number, number[]>();
  const scatters = new Map<number, number>();
  for (const [lbl, members] of clusters) {
    const pts = members.map((i) => vectors[i]);
    const c = centroidOf(pts);
    let s = 0;
    for (const p of pts) s += euclid(p, c);
    centroids.set(lbl, c);
    scatters.set(lbl, s / pts.length);
  }
  const labelsList = [...clusters.keys()];
  let dbSum = 0;
  for (const i of labelsList) {
    let worst = 0;
    for (const j of labelsList) {
      if (i === j) continue;
      const d = euclid(centroids.get(i) as number[], centroids.get(j) as number[]);
      const r = d === 0 ? Number.POSITIVE_INFINITY : ((scatters.get(i) as number) + (scatters.get(j) as number)) / d;
      if (r > worst) worst = r;
    }
    dbSum += worst;
  }
  return dbSum / labelsList.length;
}

/**
 * Calinski–Harabasz (càng CAO càng tốt — variance ratio criterion):
 *   CH = [SSB/(k−1)] / [SSW/(n−k)]
 * với SSB = Σ n_i·||c_i − c||² (bình phương Euclid tới centroid toàn cục),
 *     SSW = Σ trong cụm ||x − c_i||².
 * k < 2 hoặc n − k ≤ 0 → 0. SSW = 0 (mọi điểm trùng centroid): SSB = 0 → 0,
 * SSB > 0 → +Infinity (tách tuyệt đối).
 */
export function calinskiHarabasz(vectors: number[][], labels: number[]): number {
  const n = vectors.length;
  if (n !== labels.length) {
    throw new Error(`calinskiHarabasz: vectors (${n}) và labels (${labels.length}) khác độ dài`);
  }
  if (n === 0) return 0;
  const clusters = groupByLabel(labels);
  const k = clusters.size;
  if (k < 2 || n - k <= 0) return 0;
  const grand = centroidOf(vectors);
  let ssb = 0;
  let ssw = 0;
  for (const [, members] of clusters) {
    const pts = members.map((i) => vectors[i]);
    const c = centroidOf(pts);
    for (let j = 0; j < c.length; j++) {
      const d = c[j] - grand[j];
      ssb += pts.length * d * d;
    }
    for (const p of pts) {
      for (let j = 0; j < p.length; j++) {
        const d = p[j] - c[j];
        ssw += d * d;
      }
    }
  }
  if (ssw === 0) return ssb === 0 ? 0 : Number.POSITIVE_INFINITY;
  return ssb / (k - 1) / (ssw / (n - k));
}
