/**
 * Leiden Community Detection — pure TypeScript implementation
 *
 * Trả lời câu hỏi user 2026-09-05: "lõi embed có đang dùng thuật toán Leiden
 * trong việc truy vấn dữ liệu không? Có thể xây dựng kiến trúc thuật toán
 * truy vấn dữ liệu cho lõi embed không?"
 *
 * TRƯỚC ĐÂY: KHÔNG — toàn bộ src/ không có Leiden (section COMMUNITY DETECTION
 * trong neo4j.ts chỉ là header rỗng). Neo4j AuraDB Free cũng KHÔNG có plugin
 * GDS (Graph Data Science) để chạy gds.leiden.write trực tiếp trên server.
 * → Giải pháp: implement Leiden thuần TS chạy trên subgraph fetch từ Neo4j.
 *
 * THUẬT TOÁN (Traag, Waltman & van Eck 2019 — "From Louvain to Leiden"):
 *   1. LOCAL MOVING: mỗi node chuyển sang community có điểm modularity gain
 *      cao nhất (hàng đợi ngẫu nhiên, re-queue láng giềng khi có thay đổi).
 *      Score khi thả node v (đã rút khỏi community cũ) vào community C:
 *        score(C) = w_v→C − γ·k_v·K_C/(2m)
 *      Chọn C tối đa score (kể cả community cũ) — chỉ chuyển khi tốt hơn hẳn.
 *   2. REFINEMENT: bảo đảm community "well-connected" — cải tiến then chốt
 *      so với Louvain (Louvain có thể tạo community ngắt kết nối nội bộ).
 *      Đơn giản hoá: BFS trong mỗi community, tách thành phần ngắt kết nối
 *      thành community riêng (giữ thành phần lớn nhất).
 *   3. AGGREGATION: co rút mỗi community thành 1 super-node, cạnh giữa
 *      community cộng dồn weight. Lặp lại cho tới khi không đổi.
 *
 * Độ phức tạp: O(m) mỗi pass (m = số cạnh) — 18k nodes / 25k edges chạy
 * dưới ~1 giây trên JS thuần.
 *
 * Modularity: Q = (1/2m) Σ_ij [ A_ij − γ·(k_i·k_j)/(2m) ] δ(c_i, c_j)
 */

// ==================== TYPES ====================

export interface LeidenEdge {
  /** Index của node nguồn (0..nodeCount-1) — cạnh vô hướng */
  source: number
  /** Index của node đích */
  target: number
  /** Trọng số cạnh (mặc định 1) */
  weight?: number
}

export interface LeidenOptions {
  /** Resolution γ — cao hơn → community nhỏ hơn, mịn hơn (mặc định 1.0) */
  resolution?: number
  /** Số pass tối đa của vòng local-moving→refine→aggregate (mặc định 10) */
  maxIterations?: number
  /** Seed cho PRNG — deterministic khi cố định (mặc định 42) */
  seed?: number
  /** Ngưỡng score gain để chấp nhận di chuyển node (mặc định 1e-7) */
  gammaThreshold?: number
  /** Số lần chạy lại với seed khác nhau, giữ phân hoạch có modularity cao
   *  nhất (mặc định 1). Leiden là heuristic — multi-restart nâng chất lượng
   *  ổn định (đo trên planted-partition 20×50: best-of-3 đạt Q 0.498 ≈ planted
   *  0.496, trong khi seed xấu nhất chỉ 0.474). */
  restarts?: number
}

export interface LeidenResult {
  /** node index → community id (0..communityCount-1, liên tục) */
  nodeCommunity: number[]
  /** Số community sau khi liên tục hoá id */
  communityCount: number
  /** Modularity Q của phân hoạch cuối (−0.5..1) */
  modularity: number
  /** Số pass đã chạy */
  iterations: number
  /** Thời gian chạy (ms) */
  durationMs: number
  /** Kích thước từng community (theo community id đã liên tục hoá) */
  communitySizes: number[]
}

// ==================== PRNG (mulberry32 — deterministic, nhanh) ====================

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ==================== CSR ADJACENCY ====================

/** Adjacency dạng CSR (Compressed Sparse Row) — cache-friendly, không Map per node */
interface CsrGraph {
  nodeCount: number
  /** offset[v]..offset[v+1] = khoảng trong neighbors[]/weights[] của node v */
  offsets: Int32Array
  /** Cạnh láng giềng (đã gộp cạnh song song) */
  neighbors: Int32Array
  /** Trọng số tương ứng với neighbors[] */
  weights: Float64Array
  /** Bậc có trọng số của mỗi node k[v] = Σ w */
  nodeWeights: Float64Array
  /** 2m = tổng trọng số mọi cạnh (cạnh vô hướng đếm 2 lần) */
  totalEdgeWeight: number
}

/** Build CSR từ edge list — gộp cạnh song song; self-loop GIỮ LẠI
 *  (self-loop của super-node trong aggregation mang trọng số 2×intra-weight —
 *  bắt buộc cho Louvain/Leiden đúng: không có nó, graph thô dần mất thông tin
 *  gắn kết nội bộ → community bị merge nhầm ở pass sau). */
function buildCsr(nodeCount: number, edges: LeidenEdge[]): CsrGraph {
  // Gộp cạnh song song — key = min*nodeCount+max (self-loop: s===t)
  const edgeMap = new Map<number, number>()
  for (const e of edges) {
    const s = e.source
    const t = e.target
    if (s < 0 || s >= nodeCount || t < 0 || t >= nodeCount) continue // bỏ cạnh ngoài phạm vi
    const key = s <= t ? s * nodeCount + t : t * nodeCount + s
    edgeMap.set(key, (edgeMap.get(key) || 0) + (e.weight ?? 1))
  }

  // Đếm bậc (self-loop +1)
  const degree = new Int32Array(nodeCount)
  for (const [key] of edgeMap) {
    degree[Math.floor(key / nodeCount)]++
    degree[key % nodeCount]++
  }

  // Build offsets
  const offsets = new Int32Array(nodeCount + 1)
  for (let v = 0; v < nodeCount; v++) offsets[v + 1] = offsets[v] + degree[v]

  // Fill neighbors + weights
  const neighbors = new Int32Array(offsets[nodeCount])
  const weights = new Float64Array(offsets[nodeCount])
  const cursor = new Int32Array(nodeCount)
  for (const [key, w] of edgeMap) {
    const s = Math.floor(key / nodeCount)
    const t = key % nodeCount
    if (s === t) {
      // Self-loop: 1 entry adjacency, nodeWeights nhận đủ w (bậc = w)
      neighbors[offsets[s] + cursor[s]] = s
      weights[offsets[s] + cursor[s]] = w
      cursor[s]++
    } else {
      // Cạnh vô hướng: 2 chiều
      neighbors[offsets[s] + cursor[s]] = t
      weights[offsets[s] + cursor[s]] = w
      cursor[s]++
      neighbors[offsets[t] + cursor[t]] = s
      weights[offsets[t] + cursor[t]] = w
      cursor[t]++
    }
  }

  // Node weights + total (2m) — self-loop contributes w (không nhân 2)
  const nodeWeights = new Float64Array(nodeCount)
  let totalEdgeWeight = 0
  for (let v = 0; v < nodeCount; v++) {
    let k = 0
    for (let i = offsets[v]; i < offsets[v + 1]; i++) k += weights[i]
    nodeWeights[v] = k
    totalEdgeWeight += k
  }

  return { nodeCount, offsets, neighbors, weights, nodeWeights, totalEdgeWeight }
}

// ==================== MODULARITY ====================

/** Modularity Q của phân hoạch trên CSR graph (γ = resolution) */
function computeModularity(g: CsrGraph, membership: ArrayLike<number>, resolution: number): number {
  const { nodeCount, offsets, neighbors, weights, nodeWeights, totalEdgeWeight } = g
  const twoM = totalEdgeWeight
  if (twoM === 0) return 0

  const intraEdgeWeight = new Map<number, number>() // community → Σ A_ij (mỗi cạnh 1 lần)
  const degreeSums = new Map<number, number>() // community → Σ k_i

  for (let v = 0; v < nodeCount; v++) {
    const c = membership[v]
    degreeSums.set(c, (degreeSums.get(c) || 0) + nodeWeights[v])
    for (let i = offsets[v]; i < offsets[v + 1]; i++) {
      const u = neighbors[i]
      if (v < u && membership[u] === c) {
        intraEdgeWeight.set(c, (intraEdgeWeight.get(c) || 0) + weights[i])
      }
    }
  }

  let q = 0
  for (const [c, intra] of intraEdgeWeight) {
    const degSum = degreeSums.get(c) || 0
    // Q = Σ_c [ 2e_c/(2m) − γ·d_c²/(2m)² ] — single community ⇒ Q = 1−γ ( = 0 khi γ=1)
    q += (2 * intra - resolution * (degSum * degSum) / twoM) / twoM
  }
  return q
}

// ==================== LOCAL MOVING (Phase 1) ====================

/**
 * Local moving với hàng đợi ngẫu nhiên. Mỗi node v (được rút tạm khỏi community
 * cũ) chấm điểm từng community láng giềng:
 *   score(C) = w_v→C − γ·k_v·K_C/(2m)
 * Chọn C có score cao nhất (kể cả community cũ) — chỉ chuyển khi score tốt hơn
 * score(cOld) + threshold. Chuẩn python-louvain / networkx formulation.
 */
function localMoving(
  g: CsrGraph,
  membership: Int32Array,
  resolution: number,
  rand: () => number,
  gammaThreshold: number
): boolean {
  const { nodeCount, offsets, neighbors, weights, nodeWeights, totalEdgeWeight } = g
  const twoM = totalEdgeWeight
  if (twoM === 0) return false

  // K_C per community + size — dùng Map (community id có thể thưa sau refine)
  const communityDegree = new Map<number, number>()
  const communitySize = new Map<number, number>()
  const bump = (c: number, dk: number, ds: number) => {
    communityDegree.set(c, (communityDegree.get(c) || 0) + dk)
    communitySize.set(c, (communitySize.get(c) || 0) + ds)
    if (communitySize.get(c) === 0) {
      communityDegree.delete(c)
      communitySize.delete(c)
    }
  }
  for (let v = 0; v < nodeCount; v++) bump(membership[v], nodeWeights[v], 1)

  // Hàng đợi chứa mọi node, thứ tự ngẫu nhiên (Fisher-Yates)
  const queue: number[] = new Array(nodeCount)
  for (let v = 0; v < nodeCount; v++) queue[v] = v
  for (let i = queue.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[queue[i], queue[j]] = [queue[j], queue[i]]
  }
  const inQueue = new Uint8Array(nodeCount).fill(1)

  let changed = false

  while (queue.length > 0) {
    const v = queue.pop()!
    inQueue[v] = 0

    const kV = nodeWeights[v]
    const cOld = membership[v]

    // Σ weight từ v tới từng community láng giềng — BỎ self-loop
    // (self-loop của super-node = gắn kết NỘI BỘ của chính nó, không phải
    // kết nối tới community khác — tính vào neighborCommWeights sẽ sai gain)
    const neighborCommWeights = new Map<number, number>()
    for (let i = offsets[v]; i < offsets[v + 1]; i++) {
      const u = neighbors[i]
      if (u === v) continue
      const c = membership[u]
      neighborCommWeights.set(c, (neighborCommWeights.get(c) || 0) + weights[i])
    }
    if (neighborCommWeights.size === 0) continue // node cô lập

    // Rút v khỏi community cũ
    bump(cOld, -kV, -1)
    const kCOld = communityDegree.get(cOld) || 0
    const wToOld = neighborCommWeights.get(cOld) || 0
    const stayScore = wToOld - (resolution * kV * kCOld) / twoM

    // Chọn community tốt nhất
    let bestComm = cOld
    let bestScore = stayScore
    for (const [c, w] of neighborCommWeights) {
      if (c === cOld) continue
      const score = w - (resolution * kV * (communityDegree.get(c) || 0)) / twoM
      if (score > bestScore + gammaThreshold) {
        bestScore = score
        bestComm = c
      }
    }

    // Thả v vào community tốt nhất
    membership[v] = bestComm
    bump(bestComm, kV, 1)

    if (bestComm !== cOld) {
      changed = true
      // Re-queue MỌI láng giềng của v (chuẩn Louvain/Leiden): láng giềng
      // community CŨ mất 1 thành viên (có thể giờ muốn rời đi), láng giềng
      // community MỚI nhận thêm (có thể muốn hợp nhất) — cả hai đều cần
      // được xem xét lại để pass này hội tụ đúng (chỉ re-queue 1 phía sẽ
      // kẹt ở local optimum nông — đo trên planted-partition 20×50: Q 0.464
      // thay vì ~0.51 của planted). Modularity tăng đơn điệu mỗi move được
      // chấp nhận (gain > threshold) → queue hội tụ, không lo vòng lặp vô hạn.
      for (let i = offsets[v]; i < offsets[v + 1]; i++) {
        const u = neighbors[i]
        if (!inQueue[u]) {
          queue.push(u)
          inQueue[u] = 1
        }
      }
    }
  }

  return changed
}

// ==================== REFINE (Phase 2 — well-connected guarantee) ====================

/**
 * Refinement chuẩn Leiden: local moving GIỮA CÁC SUB-COMMUNITY trong nội bộ
 * từng community (node khởi tạo singleton, chỉ được gộp với sub-community mà
 * nó CÓ CẠNH nối tới — bảo đảm sub-community liên kết). Đây là cải tiến then
 * chốt so với Louvain: tách community "trộn" (vd {nhóm 1 + nhóm 2} gộp nhầm
 * ở pass trước) trở lại các phần thuần, TRƯỚC khi aggregation khóa lại.
 *
 * Objective giống local moving (modularity với 2m TOÀN CỤC) nhưng bị giới
 * hạn trong community — sub-community chỉ có thể tách ra, không thể hút
 * node từ community khác.
 */
function refineCommunities(
  g: CsrGraph,
  membership: Int32Array,
  resolution: number,
  rand: () => number,
  gammaThreshold: number
): boolean {
  const { nodeCount, offsets, neighbors, weights, nodeWeights, totalEdgeWeight } = g
  const twoM = totalEdgeWeight
  if (twoM === 0) return false

  // Gom node theo community
  const members = new Map<number, number[]>()
  for (let v = 0; v < nodeCount; v++) {
    const c = membership[v]
    if (!members.has(c)) members.set(c, [])
    members.get(c)!.push(v)
  }

  let nextId = 0
  for (let v = 0; v < nodeCount; v++) if (membership[v] >= nextId) nextId = membership[v] + 1

  let changed = false

  for (const [c, nodes] of members) {
    if (nodes.length < 2) continue
    const inC = new Set(nodes)

    // Sub-community state: node → subCommId (khởi tạo: chính nó — singleton)
    const sub = new Map<number, number>()
    const subDeg = new Map<number, number>()
    const subSize = new Map<number, number>()
    for (const v of nodes) {
      sub.set(v, v)
      subDeg.set(v, nodeWeights[v])
      subSize.set(v, 1)
    }

    // Hàng đợi ngẫu nhiên các node của community
    const queue: number[] = [...nodes]
    for (let i = queue.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1))
      ;[queue[i], queue[j]] = [queue[j], queue[i]]
    }
    const inQueue = new Map<number, boolean>()
    for (const v of nodes) inQueue.set(v, true)

    while (queue.length > 0) {
      const v = queue.pop()!
      inQueue.set(v, false)
      const kV = nodeWeights[v]
      const cOld = sub.get(v)!

      // Σ weight tới sub-community láng giềng (chỉ node trong C, bỏ self-loop)
      const ncw = new Map<number, number>()
      for (let i = offsets[v]; i < offsets[v + 1]; i++) {
        const u = neighbors[i]
        if (u === v || !inC.has(u)) continue
        const sc = sub.get(u)!
        ncw.set(sc, (ncw.get(sc) || 0) + weights[i])
      }
      if (ncw.size === 0) continue // node cô lập trong C → giữ singleton

      // Rút v khỏi sub-community cũ
      subDeg.set(cOld, (subDeg.get(cOld) || 0) - kV)
      subSize.set(cOld, (subSize.get(cOld) || 0) - 1)
      if ((subSize.get(cOld) || 0) === 0) {
        subDeg.delete(cOld)
        subSize.delete(cOld)
      }
      const kCOld = subDeg.get(cOld) || 0
      const wToOld = ncw.get(cOld) || 0
      const stayScore = wToOld - (resolution * kV * kCOld) / twoM

      let bestComm = cOld
      let bestScore = stayScore
      for (const [sc, w] of ncw) {
        if (sc === cOld) continue
        const score = w - (resolution * kV * (subDeg.get(sc) || 0)) / twoM
        if (score > bestScore + gammaThreshold) {
          bestScore = score
          bestComm = sc
        }
      }

      sub.set(v, bestComm)
      subDeg.set(bestComm, (subDeg.get(bestComm) || 0) + kV)
      subSize.set(bestComm, (subSize.get(bestComm) || 0) + 1)

      if (bestComm !== cOld) {
        for (let i = offsets[v]; i < offsets[v + 1]; i++) {
          const u = neighbors[i]
          if (inC.has(u) && !inQueue.get(u)) {
            queue.push(u)
            inQueue.set(u, true)
          }
        }
      }
    }

    // Sub-community kết quả > 1 → tách: sub đầu (theo thứ tự node) giữ id cũ,
    // các sub còn lại nhận id mới
    const distinct = new Set<number>()
    for (const v of nodes) distinct.add(sub.get(v)!)
    if (distinct.size > 1) {
      const kept = sub.get(nodes[0])!
      const newId = new Map<number, number>()
      for (const d of distinct) {
        newId.set(d, d === kept ? c : nextId++)
      }
      for (const v of nodes) membership[v] = newId.get(sub.get(v)!)!
      changed = true
      if (nodes.length > 100) {
        console.log(`[Leiden] Refine: community ${c} (${nodes.length} nodes) tách thành ${distinct.size} sub-community`)
      }
    }
  }

  return changed
}

/**
 * Safety net: BFS từng community — nếu vẫn còn thành phần ngắt kết nối
 * (không thể xảy ra sau refineCommunities chuẩn, nhưng phòng bug), tách
 * thành phần lớn nhất giữ id, phần còn lại id mới.
 */
function refineDisconnected(g: CsrGraph, membership: Int32Array): boolean {
  const { nodeCount, offsets, neighbors } = g
  let nextId = 0
  for (let v = 0; v < nodeCount; v++) if (membership[v] + 1 > nextId) nextId = membership[v] + 1

  const members = new Map<number, number[]>()
  for (let v = 0; v < nodeCount; v++) {
    const c = membership[v]
    if (!members.has(c)) members.set(c, [])
    members.get(c)!.push(v)
  }

  let changed = false
  for (const [c, nodes] of members) {
    if (nodes.length <= 1) continue
    const nodeSet = new Set(nodes)
    const visited = new Uint8Array(nodeCount)
    const components: number[][] = []

    for (const start of nodes) {
      if (visited[start]) continue
      const comp: number[] = []
      const stack = [start]
      visited[start] = 1
      while (stack.length > 0) {
        const v = stack.pop()!
        comp.push(v)
        for (let i = offsets[v]; i < offsets[v + 1]; i++) {
          const u = neighbors[i]
          if (!visited[u] && nodeSet.has(u)) {
            visited[u] = 1
            stack.push(u)
          }
        }
      }
      components.push(comp)
    }

    if (components.length > 1) {
      components.sort((a, b) => b.length - a.length)
      for (let i = 1; i < components.length; i++) {
        const newC = nextId++
        for (const v of components[i]) membership[v] = newC
        changed = true
      }
      if (nodes.length > 100) {
        console.log(`[Leiden] Refine: community ${c} (${nodes.length} nodes) ngắt kết nối nội bộ → tách ${components.length - 1} thành phần`)
      }
    }
  }

  return changed
}

// ==================== MAIN ENTRY ====================

/**
 * Chạy Leiden community detection trên đồ thị vô hướng có trọng số.
 * Deterministic theo seed (mặc định 42). Với restarts>1, chạy nhiều seed
 * và giữ kết quả modularity cao nhất.
 *
 * @param nodeCount số node (index 0..nodeCount-1)
 * @param edges danh sách cạnh
 * @returns phân hoạch community + modularity + stats
 */
export function leidenCommunityDetection(
  nodeCount: number,
  edges: LeidenEdge[],
  options: LeidenOptions = {}
): LeidenResult {
  const restarts = Math.max(1, options.restarts ?? 1)
  if (restarts === 1) {
    return leidenSingleRun(nodeCount, edges, options)
  }

  const baseSeed = options.seed ?? 42
  let best: LeidenResult | null = null
  for (let r = 0; r < restarts; r++) {
    const result = leidenSingleRun(nodeCount, edges, {
      ...options,
      seed: baseSeed + r * 7919, // lệch seed xa nhau giữa các restart
    })
    if (!best || result.modularity > best.modularity) {
      best = result
    }
  }
  return best!
}

function leidenSingleRun(
  nodeCount: number,
  edges: LeidenEdge[],
  options: LeidenOptions
): LeidenResult {
  const startMs = Date.now()
  const resolution = options.resolution ?? 1.0
  const maxIterations = options.maxIterations ?? 10
  const seed = options.seed ?? 42
  const gammaThreshold = options.gammaThreshold ?? 1e-7
  const rand = mulberry32(seed)

  if (nodeCount <= 0 || edges.length === 0) {
    return {
      nodeCommunity: new Array(Math.max(0, nodeCount)).fill(0),
      communityCount: nodeCount > 0 ? 1 : 0,
      modularity: 0,
      iterations: 0,
      durationMs: Date.now() - startMs,
      communitySizes: nodeCount > 0 ? [nodeCount] : [],
    }
  }

  // Pass đầu chạy trên graph gốc; các pass sau chạy trên super-graph
  let currentGraph: CsrGraph = buildCsr(nodeCount, edges)
  if (currentGraph.totalEdgeWeight === 0) {
    // Không có cạnh hợp lệ → tất cả 1 community (không có cấu trúc để tách)
    return {
      nodeCommunity: new Array(nodeCount).fill(0),
      communityCount: 1,
      modularity: 0,
      iterations: 0,
      durationMs: Date.now() - startMs,
      communitySizes: [nodeCount],
    }
  }

  // Phân hoạch của pass hiện tại (trên currentGraph)
  let membership = new Int32Array(currentGraph.nodeCount)
  for (let v = 0; v < currentGraph.nodeCount; v++) membership[v] = v
  // Map node GỐC → community hiện tại
  let origMembership = new Int32Array(nodeCount)
  for (let v = 0; v < nodeCount; v++) origMembership[v] = v

  let iterations = 0
  let converged = false

  for (let iter = 0; iter < maxIterations && !converged; iter++) {
    iterations++

    // Phase 1: local moving
    const moved = localMoving(currentGraph, membership, resolution, rand, gammaThreshold)

    // Phase 2: refinement (chuẩn Leiden — tách community trộn thành sub thuần;
    // sau đó BFS safety net bảo đảm liên kết nội bộ)
    refineCommunities(currentGraph, membership, resolution, rand, gammaThreshold)
    refineDisconnected(currentGraph, membership)

    // Phase 3: aggregation — co rút community thành super-node
    const commToSuper = new Map<number, number>()
    for (let v = 0; v < membership.length; v++) {
      const c = membership[v]
      if (!commToSuper.has(c)) commToSuper.set(c, commToSuper.size)
    }
    const superCount = commToSuper.size

    if (superCount === currentGraph.nodeCount && !moved) {
      converged = true
      break
    }
    if (superCount === currentGraph.nodeCount) {
      // Local moving không gộp được node nào lần này → hội tụ
      converged = true
      break
    }

    // Cạnh super: cộng dồn weight giữa các community;
    // self-loop super-node = Σ trọng số các entry adjacency cùng community
    // (cạnh nội bộ đếm 2 chiều = 2e_c — đúng chuẩn Louvain/Leiden aggregation).
    // FIX double-count: cạnh NGOÀI (sv≠su) chỉ được cộng MỘT lần (điều kiện
    // v < u) — adjacency đối xứng nên không có điều kiện này thì trọng số
    // super-edge bị nhân 2 mỗi pass aggregation → 2m phình to dần →
    // community merge nhầm ở pass sau (đã thấy 2m 230→996 sau 5 pass).
    const superEdgeMap = new Map<number, number>()
    const selfLoopWeight = new Map<number, number>()
    for (let v = 0; v < currentGraph.nodeCount; v++) {
      const sv = commToSuper.get(membership[v])!
      for (let i = currentGraph.offsets[v]; i < currentGraph.offsets[v + 1]; i++) {
        const u = currentGraph.neighbors[i]
        const su = commToSuper.get(membership[u])!
        if (sv === su) {
          // Nội bộ: self-loop entry (u===v) tự nhiên đếm 1 lần; cạnh nội bộ
          // non-self đếm 2 lần (từ v và từ u) = 2w — đúng chuẩn.
          selfLoopWeight.set(sv, (selfLoopWeight.get(sv) || 0) + currentGraph.weights[i])
        } else if (v < u) {
          // External: mỗi cạnh chỉ đếm 1 lần (entry v<u; entry u>v bị skip)
          const key = sv < su ? sv * superCount + su : su * superCount + sv
          superEdgeMap.set(key, (superEdgeMap.get(key) || 0) + currentGraph.weights[i])
        }
      }
    }
    const superEdges: LeidenEdge[] = []
    for (const [key, w] of superEdgeMap) {
      superEdges.push({ source: Math.floor(key / superCount), target: key % superCount, weight: w })
    }
    for (const [sv, w] of selfLoopWeight) {
      if (w > 0) superEdges.push({ source: sv, target: sv, weight: w })
    }

    // Cập nhật map gốc → community pass này
    const newOrig = new Int32Array(origMembership.length)
    for (let v = 0; v < origMembership.length; v++) {
      newOrig[v] = commToSuper.get(membership[origMembership[v]])!
    }
    origMembership = newOrig

    // Pass sau: super-graph, mỗi super-node 1 community riêng
    currentGraph = buildCsr(superCount, superEdges)
    membership = new Int32Array(superCount)
    for (let s = 0; s < superCount; s++) membership[s] = s
  }

  // === Modularity cuối tính trên graph GỐC (chuẩn) ===
  const originalG = buildCsr(nodeCount, edges)
  const modularity = computeModularity(originalG, origMembership, resolution)

  // Liên tục hoá community id
  const idMap = new Map<number, number>()
  for (let v = 0; v < nodeCount; v++) {
    const c = origMembership[v]
    if (!idMap.has(c)) idMap.set(c, idMap.size)
  }
  const result = new Array<number>(nodeCount)
  const sizes = new Array<number>(idMap.size).fill(0)
  for (let v = 0; v < nodeCount; v++) {
    const c = idMap.get(origMembership[v])!
    result[v] = c
    sizes[c]++
  }

  return {
    nodeCommunity: result,
    communityCount: idMap.size,
    modularity,
    iterations,
    durationMs: Date.now() - startMs,
    communitySizes: sizes,
  }
}
