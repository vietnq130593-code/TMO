/**
 * Đo lường xếp hạng (ranking metrics) — module thuần toán, không side-effect.
 *
 * Nguồn: BLUEPRINT-STATS-LEARNING-P0-P6.md mục P0-1 (ML.pdf §6 — nDCG, MRR,
 * Hit Ratio, MAP). Nhà tiêu thụ chính: P1-M2 nDCG@5/MRR cho retrieval eval.
 *
 * Convention: `relevance` là danh sách ĐÃ XẾP HẠNG theo thứ tự trả về của
 * hệ thống (index 0 = hạng 1) — giá trị > 0 là relevant (binary hoặc graded).
 * Đầu vào rỗng/không hợp lệ → 0 (fail-open, không throw).
 */

/**
 * nDCG@k: DCG = Σ_{i=1..min(k,n)} rel_i/log2(i+1) trên thứ tự ĐẦU VÀO,
 * chia IDCG tính trên top-k của mảng sorted giảm dần (chuẩn hoá về [0, 1]).
 * rỗng, k ≤ 0, hoặc IDCG = 0 (toàn 0) → 0.
 */
export function ndcgAtK(relevance: number[], k: number): number {
  if (relevance.length === 0 || k <= 0) return 0;
  const kk = Math.min(k, relevance.length);
  let dcg = 0;
  for (let i = 0; i < kk; i++) dcg += relevance[i] / Math.log2(i + 2); // log2(hạng i+1)
  const ideal = [...relevance].sort((a, b) => b - a); // bản sao — không mutate đầu vào
  let idcg = 0;
  for (let i = 0; i < kk; i++) idcg += ideal[i] / Math.log2(i + 2);
  if (idcg === 0) return 0;
  return dcg / idcg;
}

/**
 * MRR (Mean Reciprocal Rank): 1/hạng của phần tử relevant ĐẦU TIÊN (hạng tính
 * từ 1). Không có phần tử relevant nào → 0.
 */
export function mrr(relevance: number[]): number {
  for (let i = 0; i < relevance.length; i++) {
    if (relevance[i] > 0) return 1 / (i + 1);
  }
  return 0;
}

/**
 * Hit@K: đúng nếu TỒN TẠI phần tử relevant trong top-k (∃ rel_i > 0 với
 * chỉ số 0-based i < k). k ≤ 0 → false.
 */
export function hitAtK(relevance: number[], k: number): boolean {
  const kk = Math.min(k, relevance.length);
  for (let i = 0; i < kk; i++) {
    if (relevance[i] > 0) return true;
  }
  return false;
}

/**
 * Average Precision (AP): trung bình precision@i trên các vị trí relevant,
 * chia cho TỔNG SỐ phần tử relevant:
 *   AP = (Σ_{rel_i > 0} precision@i) / (số relevant),  precision@i = (số
 *   relevant trong i phần tử đầu)/i. Không có relevant nào → 0.
 */
export function averagePrecision(relevance: number[]): number {
  let totalRelevant = 0;
  let hits = 0;
  let sumPrecision = 0;
  for (let i = 0; i < relevance.length; i++) {
    if (relevance[i] > 0) {
      totalRelevant++;
      hits++;
      sumPrecision += hits / (i + 1);
    }
  }
  if (totalRelevant === 0) return 0;
  return sumPrecision / totalRelevant;
}
