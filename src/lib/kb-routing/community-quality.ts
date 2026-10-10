/**
 * COMMUNITY QUALITY — P1-M5 (BLUEPRINT-STATS-LEARNING-P0-P6 §P1-M5, mục #3 —
 * ML.pdf §Clustering Metrics): đo chất lượng phân cụm Leiden + auto-tune γ.
 *
 * Module THUẦN TOÁN (không I/O) — tách khỏi communities.ts để:
 * - test được không cần Neo4j/Qdrant/DB (r76-leiden-quality.test.ts);
 * - communities.ts giữ vai trò orchestration (fetch → detect → write-back).
 *
 * Chỉ số:
 * - Silhouette biến thể đồ thị (CHÍNH — xem silhouetteFromGraph trong
 *   stats/cluster-quality: trọng số cạnh là độ tương tự nên dấu bị ĐẢO theo
 *   adjudication BUG2-037, dương = gán đúng cụm). KHÔNG cần embedding node.
 * - Davies–Bouldin / Calinski–Harabasz (PHỤ — chỉ informative): cần vector,
 *   chạy trên embedding summary các cụm. NHÃN để nhóm điểm: domain chính của
 *   từng community (mỗi community = 1 điểm; đo mức tách biệt của các community
 *   cùng-domain vs khác-domain trong không gian embedding — cách duy nhất có
 *   nghĩa khi mỗi cụm chỉ có 1 vector đại diện, ghi chú minh bạch cách đọc).
 * - Auto-tune γ: grid {0.5, 0.8, 1.0, 1.2, 1.5} × restarts=3, chọn γ maximizing
 *   silhouette (tie-break modularity). Env LEIDEN_AUTO_TUNE (default OFF) —
 *   bật sau khi quan sát 2-3 lần chạy so sánh (blueprint khuyến nghị).
 */

import {
  silhouetteFromGraph,
  daviesBouldin,
  calinskiHarabasz,
  type GraphEdge,
} from '@/lib/stats/cluster-quality'
import { leidenCommunityDetection, type LeidenEdge } from '@/lib/leiden'

/** Lưới γ mặc định cho sweep (blueprint P1-M5: {0.5, 0.8, 1.0, 1.2, 1.5}). */
export const LEIDEN_GAMMA_GRID: readonly number[] = [0.5, 0.8, 1.0, 1.2, 1.5]

/** γ mặc định khi auto-tune TẮT (hành vi cũ — communities.ts:193 resolution 1.0). */
export const LEIDEN_DEFAULT_GAMMA = 1.0

/**
 * Env gate LEIDEN_AUTO_TUNE (default OFF — 'on' | '1' | 'true' để bật).
 * Blueprint: "Env LEIDEN_AUTO_TUNE=on mặc định OFF — bật sau khi quan sát
 * 2-3 lần chạy so sánh". OFF → KHÔNG đổi hành vi detect (γ=1.0, write-back
 * y hệt cũ — chỉ thêm đo silhouette).
 */
export function isLeidenAutoTuneEnabled(): boolean {
  const v = (process.env.LEIDEN_AUTO_TUNE ?? '').trim().toLowerCase()
  return v === 'on' || v === '1' || v === 'true'
}

// ==================== SILHOUETTE (ĐỒ THỊ) ====================

/**
 * Đo chất lượng phân hoạch Leiden bằng silhouette biến thể đồ thị.
 * LeidenEdge ({source, target, weight}) đẳng cấu trúc GraphEdge — map trực tiếp.
 *
 * @param n       số node của graph (labels.length === n)
 * @param edges   cạnh có trọng số (độ tương tự — càng cao càng gần)
 * @param labels  nodeCommunity từ LeidenResult (node index → community id)
 * @returns silhouette ∈ [−1, 1] (dương = gán đúng cụm); 0 cho degenerate
 *          (0 node / 1 cụm duy nhất) — quy ước sklearn như stats module.
 */
export function evaluateCommunityQuality(
  n: number,
  edges: LeidenEdge[],
  labels: number[] | ArrayLike<number>,
): number {
  const labelsArr = Array.from(labels as ArrayLike<number>)
  return silhouetteFromGraph(
    n,
    edges as GraphEdge[],
    labelsArr,
  )
}

// ==================== AUTO-TUNE γ (SWEEP) ====================

export interface GammaCandidate {
  /** Giá trị γ đã chạy. */
  gamma: number
  /** Silhouette của phân hoạch tìm được tại γ này. */
  silhouette: number
  /** Modularity Q của phân hoạch (tie-break + informative). */
  modularity: number
  /** Số community Leiden sinh ra tại γ này. */
  communityCount: number
  /** nodeCommunity của phân hoạch (chỉ có ở candidate tốt nhất cần dùng lại). */
  nodeCommunity?: number[]
}

export interface GammaSweepResult {
  /** Tất cả candidate theo thứ tự grid (KHÔNG kèm nodeCommunity — chỉ best giữ). */
  candidates: Array<Omit<GammaCandidate, 'nodeCommunity'>>
  /** Candidate tốt nhất: silhouette max (tie-break modularity max, rồi γ nhỏ
   *  cho ổn định). Kèm nodeCommunity để caller dùng lại KHÔNG chạy lại Leiden. */
  best: GammaCandidate & { nodeCommunity: number[] }
}

/**
 * Sweep γ qua grid — mỗi γ chạy leidenCommunityDetection restarts lần
 * (best-of-restarts theo modularity như đường chính), đo silhouette từng phân
 * hoạch, chọn γ maximizing silhouette (tie-break: modularity cao hơn; tiếp
 * theo γ nhỏ hơn — ít community hơn ổn định hơn).
 *
 * THUẦN: không I/O — trả đủ nodeCommunity của best để caller khỏi chạy lại.
 */
export function sweepGamma(
  n: number,
  edges: LeidenEdge[],
  opts?: { grid?: readonly number[]; restarts?: number },
): GammaSweepResult {
  const grid = opts?.grid && opts.grid.length > 0 ? [...opts.grid] : [...LEIDEN_GAMMA_GRID]
  const restarts = opts?.restarts && opts.restarts >= 1 ? opts.restarts : 3
  const candidates: Array<Omit<GammaCandidate, 'nodeCommunity'>> = []
  let best: (GammaCandidate & { nodeCommunity: number[] }) | null = null
  for (const gamma of grid) {
    const result = leidenCommunityDetection(n, edges, { restarts, resolution: gamma })
    const silhouette = evaluateCommunityQuality(n, edges, result.nodeCommunity)
    candidates.push({ gamma, silhouette, modularity: result.modularity, communityCount: result.communityCount })
    if (
      best === null
      || silhouette > best.silhouette
      || (silhouette === best.silhouette && result.modularity > best.modularity)
    ) {
      best = {
        gamma,
        silhouette,
        modularity: result.modularity,
        communityCount: result.communityCount,
        nodeCommunity: result.nodeCommunity,
      }
    }
  }
  // best luôn khác null: grid không rỗng (guard ở trên)
  return { candidates, best: best as GammaCandidate & { nodeCommunity: number[] } }
}

// ==================== DBI / CH (PHỤ — INFORMATIVE) ====================

export interface VectorQualityIndices {
  /** Davies–Bouldin (càng THẤP càng tốt) — null khi không đủ cấu trúc. */
  dbi: number | null
  /** Calinski–Harabasz (càng CAO càng tốt) — null khi không đủ cấu trúc. */
  calinskiHarabasz: number | null
  /** Số điểm đủ điều kiện tính (log/đối chiếu). */
  n: number
  /** Số nhãn khác nhau thực sự dùng. */
  labels: number
}

/**
 * DBI/CH trên embedding summary các cụm (CHỈ SỐ PHỤ — informative, blueprint
 * P1-M5: "chạy trên embedding summary các cụm... như chỉ số phụ"). Mỗi community
 * đóng góp 1 điểm (vector summary); NHÃN = domain chính của community (map từ
 * chuỗi sang số). Cách đọc: đo mức community cùng domain cô đọng lại gần nhau
 * và tách khỏi community khác domain trong không gian embedding.
 *
 * Null-guard: < 2 điểm, < 2 nhãn khác nhau, hoặc vector rỗng → null cả hai
 * (không đủ cấu trúc để kết luận — không bịa số).
 */
export function computeVectorQualityIndices(
  points: Array<{ vector: number[]; label: string }>,
): VectorQualityIndices {
  const valid = points.filter(p => p.vector.length > 0)
  if (valid.length < 2) {
    return { dbi: null, calinskiHarabasz: null, n: valid.length, labels: 0 }
  }
  const labelIds = new Map<string, number>()
  for (const p of valid) {
    if (!labelIds.has(p.label)) labelIds.set(p.label, labelIds.size)
  }
  if (labelIds.size < 2) {
    return { dbi: null, calinskiHarabasz: null, n: valid.length, labels: labelIds.size }
  }
  const vectors = valid.map(p => p.vector)
  const labels = valid.map(p => labelIds.get(p.label) as number)
  return {
    dbi: daviesBouldin(vectors, labels),
    calinskiHarabasz: calinskiHarabasz(vectors, labels),
    n: valid.length,
    labels: labelIds.size,
  }
}
