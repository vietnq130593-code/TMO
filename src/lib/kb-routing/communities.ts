/**
 * Community Layer — Leiden-based GraphRAG retrieval cho lõi embed
 *
 * Kiến trúc thuật toán truy vấn dữ liệu cho lõi embed (user request 2026-09-05:
 * "Có thể xây dựng kiến trúc thuật toán truy vấn dữ liệu cho lõi embed không?")
 *
 * ┌────────────────────────── OFFLINE (detect) ───────────────────────────┐
 * │ Neo4j entity graph (TASK 52: 175k nodes / 204k rels — domain layer   │
 * │   → fetch nodes + edges                                               │
 * │   → Leiden community detection (src/lib/leiden.ts — pure TS,          │
 * │     local moving + refine + aggregate, best-of-3 restarts)            │
 * │   → mỗi community: top members theo degree → summary text             │
 * │     (KHÔNG tốn LLM call — deterministic từ tên/loại/mô tả entity)     │
 * │   → write communityId về Neo4j node property                          │
 * │   → embed summary bằng lõi embed (nemotron-3-embed-1b)                │
 * │   → upsert vào Qdrant collection theopus_communities                  │
 * └───────────────────────────────────────────────────────────────────────┘
 * ┌────────────────────────── ONLINE (query) ─────────────────────────────┐
 * │ Query user → generateQueryEmbedding (lõi embed)                       │
 * │   → vector search song song:                                          │
 * │       (1) theopus_chunks        — chunks văn bản (hiện có)            │
 * │       (2) theopus_communities   — community summaries (MỚI)           │
 * │   → community hits → top member entities + domain context             │
 * │   → chat route build "--- Knowledge Communities ---" context section  │
 * │   → Agent nhận cả chi tiết (chunks) LẪN bức tranh lớn (communities)   │
 * └───────────────────────────────────────────────────────────────────────┘
 *
 * Đây là mô hình "global search" của Microsoft GraphRAG (Leiden → community
 * summaries → vector search) kết hợp "local search" (chunks + entities)
 * sẵn có — Agents trả lời được cả câu hỏi chi tiết lẫn câu hỏi tổng quan
 * ("tài liệu này nói về chủ đề gì liên quan tới X").
 *
 * Flag: ENABLE_COMMUNITY_SEARCH (default true — nhưng search trả [] cho tới
 * khi detection chạy lần đầu, nên zero-impact cho đến khi bật bằng API).
 */

import { qdrant } from '@/lib/qdrant'
import { safeSession, toNative } from '@/lib/neo4j'
import { generateEmbeddingBatch } from '@/lib/embeddings'
import { leidenCommunityDetection, type LeidenEdge } from '@/lib/leiden'
import { isFlagEnabled } from '@/lib/feature-flags'
import { createHash } from 'crypto'

// ==================== CONFIG ====================

export const COLLECTION_COMMUNITIES = 'theopus_communities'

/** Số node tối đa fetch từ Neo4j cho 1 lần detect.
 *  TASK 52: 50k → 250k — graph KB hiện 175,823 entity nodes (domain layer
 *  đầy đủ, audit Task 50b); limit cũ 50k cắt cụt đồ thị → Leiden chạy trên
 *  ~28% graph đầu tiên (thứ tự tùy Cypher) → community layer lệch chuẩn.
 *  250k chừa dư room cho tăng trưởng. */
const MAX_GRAPH_NODES = 250000
/** Số cạnh tối đa fetch. TASK 52: 100k → 300k — graph hiện 204,629 rels;
 *  limit cũ cắt mất ~50% cạnh. */
const MAX_GRAPH_EDGES = 300000
/** Số member hiển thị trong community summary */
const SUMMARY_TOP_MEMBERS = 12
/** Community tối thiểu để tạo summary (đơn chiếc lẻ không có giá trị retrieval) */
const MIN_COMMUNITY_SIZE = 3
/** Score threshold cho community vector search (cosine).
 *  ĐO THỰC NGHIỆM trên KB hiện tại (llama-nemotron-embed-vl-1b-v2, 139
 *  communities): query TIẾNG ANH liên quan (graph/ML) top-1 = 0.25–0.37;
 *  query TIẾNG VIỆT liên quan (thuật toán đồ thị / mạng nơ-ron) = 0.20–0.23
 *  (cross-lingual penalty ~0.07); query KHÔNG liên quan (recipe/Paris/bicycle/
 *  thời tiết) = 0.03–0.16. Ngưỡng 0.20 nằm giữa nhiễu (0.164 max) và hit
 *  Việt liên quan (0.20) — chặn nhiễu, giữ hit liên quan đa ngôn ngữ.
 *  (Threshold 0.3 của chunks không áp dụng được — community summary là text
 *  template ngắn, cosine chạy thấp hơn chunks văn bản đầy đủ.) */
const COMMUNITY_SCORE_THRESHOLD = 0.20
/** Số lần chạy lại Leiden với seed khác — giữ kết quả modularity cao nhất */
const LEIDEN_RESTARTS = 3

// ==================== TYPES ====================

export interface CommunityInfo {
  communityId: string
  summary: string
  memberCount: number
  topEntities: Array<{ name: string; type: string; description: string }>
  domains: string[]
  /** Cosine similarity từ query (chỉ có ở kết quả search) */
  score?: number
}

export interface CommunityDetectStats {
  nodesProcessed: number
  edgesProcessed: number
  /** TASK 52 — số node degree-0 bị compact bỏ khỏi input Leiden (không tham
   *  gia community nào — singleton < MIN_COMMUNITY_SIZE bị skip ở bước build
   *  dù có đưa vào Leiden) → tiết kiệm ~50% CPU/RAM trên graph lớn. */
  isolatedNodesSkipped: number
  communitiesFound: number
  communitiesStored: number
  modularity: number
  leidenMs: number
  totalMs: number
}

// ==================== CONCURRENCY GUARD (globalThis — survive hot reload) ====================

const globalForCommunities = globalThis as unknown as {
  __communityDetectionRunning?: boolean
  __communityDetectionStartedAt?: number
}

// ==================== DETECTION ====================

/**
 * Fetch entity graph từ Neo4j → chạy Leiden → lưu communityId về Neo4j
 * → embed community summaries → upsert Qdrant.
 *
 * Idempotent: chạy lại bất cứ lúc nào sau khi KB thay đổi (tài liệu mới
 * trích xuất thêm entity/relationship mới) — kết quả cũ bị REPLACE toàn bộ
 * (collection xóa rồi tạo lại point mới; Neo4j communityId được SET lại).
 */
export async function detectAndStoreCommunities(): Promise<CommunityDetectStats> {
  const startedAt = Date.now()
  if (globalForCommunities.__communityDetectionRunning) {
    // TASK 52b STALE GUARD: flag kẹt do transaction Neo4j treo không timeout
    // (đã xảy ra 2026-09-28: batch write khổng lồ trên AuraDB 0.5-CPU kẹt
    // 'Running' >10 phút, flag kẹt theo — detection mới nào cũng bị chặn).
    // Sau 30 phút không xong → coi là stale: reset flag, cho phép chạy lại.
    const prevStartedAt = globalForCommunities.__communityDetectionStartedAt || 0
    if (Date.now() - prevStartedAt < 30 * 60_000) {
      throw new Error('Community detection đang chạy (bắt đầu lúc ' + new Date(prevStartedAt || 0).toISOString() + ') — thử lại sau')
    }
    console.warn(`[Communities] STALE GUARD: flag detection kẹt >30 phút (bắt đầu ${new Date(prevStartedAt).toISOString()}) — reset và chạy lại`)
  }
  globalForCommunities.__communityDetectionRunning = true
  globalForCommunities.__communityDetectionStartedAt = Date.now()

  try {
    // ===== 1. Fetch graph từ Neo4j =====
    const nodes = await fetchEntityNodes()
    if (nodes.length === 0) {
      throw new Error('Neo4j không trả về entity node nào — không thể detect community')
    }
    const nodeIndexByName = new Map<string, number>()
    nodes.forEach((n, i) => {
      if (!nodeIndexByName.has(n.name)) nodeIndexByName.set(n.name, i)
    })

    const rels = await fetchEntityEdges()
    const edges: LeidenEdge[] = []
    let degree = new Array(nodes.length).fill(0)
    for (const r of rels) {
      const s = nodeIndexByName.get(r.source)
      const t = nodeIndexByName.get(r.target)
      if (s === undefined || t === undefined || s === t) continue
      edges.push({ source: s, target: t, weight: 1 })
      degree[s]++
      degree[t]++
    }

    // ===== 1b. TASK 52 — COMPACT: bỏ isolated nodes (degree 0) khỏi input Leiden =====
    // Audit Task 50b (dry-run read-only toàn graph 175,823 nodes): ~90k node
    // KHÔNG có cạnh nào (entity trích xuất standalone / relationship chưa
    // ghép). Chúng tạo singleton community < MIN_COMMUNITY_SIZE (bị loại ở
    // bước build) nhưng Leiden vẫn quét full — dry-run 143s phàn lớn là xử lý
    // các node rỗng này. Compact bỏ trước: kết quả community ≥3 members
    // KHÔNG ĐỔI (Q=0.8321, ~346 phân vùng) nhưng CPU/RAM giảm ~50%.
    let graphNodes = nodes
    let graphEdges = edges
    let graphDegree = degree
    let isolatedNodesSkipped = 0
    {
      let isolated = 0
      for (let i = 0; i < degree.length; i++) if (degree[i] === 0) isolated++
      if (isolated > 0 && isolated < nodes.length) {
        isolatedNodesSkipped = isolated
        const remap = new Int32Array(nodes.length).fill(-1)
        const activeNodes: EntityNodeInfo[] = []
        const activeDegree: number[] = []
        for (let i = 0; i < nodes.length; i++) {
          if (degree[i] > 0) {
            remap[i] = activeNodes.length
            activeNodes.push(nodes[i])
            activeDegree.push(degree[i])
          }
        }
        graphNodes = activeNodes
        graphDegree = activeDegree
        graphEdges = edges.map(e => ({ source: remap[e.source], target: remap[e.target], weight: e.weight }))
        console.log(`[Communities] TASK 52 compact: bỏ ${isolated} isolated nodes (degree 0) — input Leiden còn ${activeNodes.length} nodes / ${graphEdges.length} edges`)
      }
    }
    console.log(`[Communities] Graph: ${graphNodes.length} nodes (+${isolatedNodesSkipped} isolated skipped), ${graphEdges.length} edges (từ ${rels.length} rels)`)

    // ===== 2. Leiden community detection (best-of-3) =====
    const leidenResult = leidenCommunityDetection(graphNodes.length, graphEdges, {
      restarts: LEIDEN_RESTARTS,
      resolution: 1.0,
    })
    console.log(`[Communities] Leiden: ${leidenResult.communityCount} communities, Q=${leidenResult.modularity.toFixed(4)}, ${leidenResult.durationMs}ms`)

    // ===== 3. Build community objects =====
    const membersByCommunity = new Map<number, number[]>()
    for (let v = 0; v < graphNodes.length; v++) {
      const c = leidenResult.nodeCommunity[v]
      if (!membersByCommunity.has(c)) membersByCommunity.set(c, [])
      membersByCommunity.get(c)!.push(v)
    }

    const communities: Array<{
      communityId: string
      summary: string
      memberCount: number
      topEntities: Array<{ name: string; type: string; description: string }>
      domains: string[]
      nodeIds: string[]
      /** TASK 52b — elementId nội bộ Neo4j của members (write communityId theo
       *  đường này — match property id label-less KHÔNG ăn index trên AuraDB) */
      nodeElementIds: string[]
    }> = []

    for (const [c, memberIdxs] of membersByCommunity) {
      if (memberIdxs.length < MIN_COMMUNITY_SIZE) continue

      // Top members theo degree (đại diện tốt nhất cho community)
      const sorted = [...memberIdxs].sort((a, b) => graphDegree[b] - graphDegree[a])
      const topIdxs = sorted.slice(0, SUMMARY_TOP_MEMBERS)
      const topEntities = topIdxs.map(i => ({
        name: graphNodes[i].name,
        type: graphNodes[i].entityType || 'Concept',
        description: (graphNodes[i].description || '').slice(0, 200),
      }))

      // Domains (unique, top 3)
      const domainCounts = new Map<string, number>()
      for (const i of memberIdxs) {
        const d = graphNodes[i].domain || 'mixed'
        domainCounts.set(d, (domainCounts.get(d) || 0) + 1)
      }
      const domains = [...domainCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([d]) => d)

      // Summary text — deterministic từ entity metadata (KHÔNG tốn LLM call)
      const summary =
        `Knowledge community (${memberIdxs.length} entities, domains: ${domains.join(', ')}). ` +
        `Key entities: ` +
        topEntities.map(e => `${e.name} (${e.type})${e.description ? ` — ${e.description.slice(0, 120)}` : ''}`).join('; ')

      communities.push({
        communityId: `leiden-${createHash('sha1').update(c + '|' + memberIdxs.length + '|' + topEntities.map(e => e.name).join(',')).digest('hex').slice(0, 12)}`,
        summary,
        memberCount: memberIdxs.length,
        topEntities,
        domains,
        nodeIds: memberIdxs.map(i => graphNodes[i].id).filter(Boolean),
        nodeElementIds: memberIdxs.map(i => graphNodes[i].elementId).filter(Boolean),
      })
    }
    console.log(`[Communities] ${communities.length} communities đạt ngưỡng ≥${MIN_COMMUNITY_SIZE} members (trong ${leidenResult.communityCount} tổng)`)

    // ===== 4. Write communityId về Neo4j (bulk chunked theo elementId — TASK 52b) =====
    await writeCommunityIdsToNeo4j(communities)

    // ===== 5. Embed summaries + upsert Qdrant =====
    const stored = await storeCommunityEmbeddings(communities)

    return {
      nodesProcessed: graphNodes.length,
      edgesProcessed: graphEdges.length,
      isolatedNodesSkipped,
      communitiesFound: leidenResult.communityCount,
      communitiesStored: stored,
      modularity: leidenResult.modularity,
      leidenMs: leidenResult.durationMs,
      totalMs: Date.now() - startedAt,
    }
  } finally {
    globalForCommunities.__communityDetectionRunning = false
    globalForCommunities.__communityDetectionStartedAt = undefined
  }
}

// ==================== NEO4J FETCH / WRITE HELPERS ====================

interface EntityNodeInfo {
  id: string
  /** TASK 52b — elementId nội bộ Neo4j (vd "4:abc:12") — O(1) lookup qua
   *  NodeByIdSeek khi match, KHÔNG cần index. Dùng cho write communityId
   *  (benchmark 2026-09-28: property-id match 126ms/node vs elementId
   *  1.6ms/node — nhanh hơn ~80 lần trên AuraDB). */
  elementId: string
  name: string
  entityType: string
  domain: string
  description: string
}

async function fetchEntityNodes(): Promise<EntityNodeInfo[]> {
  const session = await safeSession()
  try {
    const result = await session.executeRead((tx) =>
      tx.run(
        `MATCH (n) WHERE n.entity_type IS NOT NULL AND n.name IS NOT NULL
         RETURN n.id AS id, elementId(n) AS elementId, n.name AS name,
                n.entity_type AS entityType,
                n.domain AS domain, n.description AS description
         LIMIT toInteger($limit)`,
        { limit: MAX_GRAPH_NODES }
      )
    )
    return result.records.map(r => ({
      id: String(toNative(r.get('id')) ?? ''),
      elementId: String(toNative(r.get('elementId')) ?? ''),
      name: String(toNative(r.get('name')) ?? ''),
      entityType: String(toNative(r.get('entityType')) ?? ''),
      domain: String(toNative(r.get('domain')) ?? ''),
      description: String(toNative(r.get('description')) ?? ''),
    })).filter(n => n.name)
  } finally {
    await session.close()
  }
}

async function fetchEntityEdges(): Promise<Array<{ source: string; target: string }>> {
  const session = await safeSession()
  try {
    const result = await session.executeRead((tx) =>
      tx.run(
        `MATCH (a)-[r]->(b)
         WHERE a.entity_type IS NOT NULL AND b.entity_type IS NOT NULL
           AND a.name IS NOT NULL AND b.name IS NOT NULL
         RETURN a.name AS source, b.name AS target
         LIMIT toInteger($limit)`,
        { limit: MAX_GRAPH_EDGES }
      )
    )
    return result.records.map(r => ({
      source: String(toNative(r.get('source')) ?? ''),
      target: String(toNative(r.get('target')) ?? ''),
    })).filter(r => r.source && r.target)
  } finally {
    await session.close()
  }
}

/** SET n.communityId cho mọi node thuộc community.
 *  CLEAR toàn bộ communityId cũ TRƯỚC — node không còn thuộc community nào
 *  sau lần detect này không giữ id thừa.
 *
 *  TASK 52b — FIX SAU TREO THẬT (2026-09-28): bản cũ viết THEO TỪNG COMMUNITY
 *  — 345 transaction tuần tự, mỗi cái UNWIND TOÀN BỘ nodeIds của community
 *  đó. Trên graph 84k nodes, community lớn nhất có HÀNG CHỤC NGHÌN nodes →
 *  1 transaction khổng lồ trên AuraDB 0.5-CPU chạy >10 phút không xong (bắt
 *  quả tang qua SHOW TRANSACTIONS: transaction "UNWIND ... SET communityId"
 *  kẹt 'Running' vô hạn, flag __communityDetectionRunning kẹt theo).
 *
 *  Bản mới:
 *    (1) BULK — gom toàn bộ cặp rồi UNWIND theo CHUNK 2000 nodes/transaction
 *        (~42 chunk cho 84k nodes — mỗi chunk bounded);
 *    (2) MATCH THEO elementId(n) — benchmark 2026-09-28 trên AuraDB: match
 *        property id label-less `MATCH (n {id: $id})` KHÔNG dùng được 8 index
 *        unique theo label (planner quét) = 126ms/node → chunk 2000 nodes
 *        timeout 60s; match `WHERE elementId(n) = $eid` = NodeByIdSeek O(1)
 *        = 1.6ms/node (~80x nhanh hơn) → chunk 2000 nodes ≈ 3s;
 *    (3) transaction TIMEOUT 60s (TransactionConfig) — chunk kẹt bị server
 *        hủy và BỎ QUA (đếm skipped) thay vì treo cả detection;
 *    (4) progress log mỗi 10 chunk để theo dõi qua dev.log. */
async function writeCommunityIdsToNeo4j(
  communities: Array<{ communityId: string; nodeElementIds: string[] }>
): Promise<number> {
  const session = await safeSession()
  try {
    // Clear communityId cũ (REPLACE semantics) — cũng có timeout 60s
    try {
      await session.executeWrite(
        (tx) => tx.run(`MATCH (n) WHERE n.communityId IS NOT NULL REMOVE n.communityId`),
        { timeout: 60_000 }
      )
    } catch (err) {
      console.warn('[Communities] Clear old communityId failed (tiếp tục):', err instanceof Error ? err.message : String(err))
    }

    // Bulk pairs — 1 dòng / 1 node: {eid (elementId), communityId}
    const pairs: Array<{ eid: string; communityId: string }> = []
    for (const c of communities) {
      for (const eid of c.nodeElementIds) pairs.push({ eid, communityId: c.communityId })
    }
    if (pairs.length === 0) return 0

    const CHUNK = 2000
    let written = 0
    let skipped = 0
    for (let i = 0; i < pairs.length; i += CHUNK) {
      const chunk = pairs.slice(i, i + CHUNK)
      try {
        await session.executeWrite(
          (tx) =>
            tx.run(
              `UNWIND $pairs AS p
               MATCH (n) WHERE elementId(n) = p.eid
               SET n.communityId = p.communityId`,
              { pairs: chunk }
            ),
          { timeout: 60_000 }
        )
        written += chunk.length
      } catch (err) {
        skipped += chunk.length
        console.warn(`[Communities] Chunk ${Math.floor(i / CHUNK)} (${chunk.length} nodes) write thất bại (timeout/lỗi) — bỏ qua:`, err instanceof Error ? err.message : String(err))
      }
      if ((i / CHUNK) % 10 === 0) {
        console.log(`[Communities] Neo4j write progress: ${written}/${pairs.length} nodes (skipped ${skipped})`)
      }
    }
    console.log(`[Communities] Neo4j: communityId written cho ${written}/${pairs.length} nodes${skipped > 0 ? ` (skipped ${skipped})` : ''}`)
    return written
  } finally {
    await session.close()
  }
}

// ==================== QDRANT COMMUNITY COLLECTION ====================

async function ensureCommunityCollection(): Promise<void> {
  const collections = await qdrant.getCollections()
  const existing = new Set(collections.collections.map(c => c.name))
  if (!existing.has(COLLECTION_COMMUNITIES)) {
    await qdrant.createCollection(COLLECTION_COMMUNITIES, {
      vectors: { size: 2048, distance: 'Cosine' },
    })
    console.log(`[Communities] Created Qdrant collection: ${COLLECTION_COMMUNITIES}`)
  }
}

async function storeCommunityEmbeddings(
  communities: Array<{
    communityId: string
    summary: string
    memberCount: number
    topEntities: Array<{ name: string; type: string; description: string }>
    domains: string[]
  }>
): Promise<number> {
  if (communities.length === 0) return 0

  await ensureCommunityCollection()

  // REPLACE semantics: xóa collection cũ rồi tạo mới với points mới
  // (đơn giản + đúng — community id là hash theo nội dung nên upsert đè
  // không đủ khi community bị xóa/sáp nhập sau lần detect sau)
  try {
    await qdrant.deleteCollection(COLLECTION_COMMUNITIES)
    await qdrant.createCollection(COLLECTION_COMMUNITIES, {
      vectors: { size: 2048, distance: 'Cosine' },
    })
  } catch (err) {
    console.warn('[Communities] Collection recreate failed (thử upsert đè):', err instanceof Error ? err.message : String(err))
    await ensureCommunityCollection()
  }

  // Embed summaries theo batch (generateEmbeddingBatch đã xoay vòng key NVIDIA)
  const BATCH = 16
  let stored = 0
  for (let i = 0; i < communities.length; i += BATCH) {
    const batch = communities.slice(i, i + BATCH)
    try {
      const embeddings = await generateEmbeddingBatch(batch.map(c => c.summary))
      const points = batch.map((c, j) => ({
        id: uuidFromSeed(c.communityId),
        vector: embeddings[j]?.vector ?? [],
        payload: {
          communityId: c.communityId,
          summary: c.summary,
          memberCount: c.memberCount,
          topEntities: c.topEntities,
          domains: c.domains,
          type: 'community',
          storedAt: new Date().toISOString(),
        },
      })).filter(p => p.vector.length > 0)
      if (points.length > 0) {
        await qdrant.upsert(COLLECTION_COMMUNITIES, { wait: true, points })
        stored += points.length
      }
    } catch (err) {
      console.warn(`[Communities] Embed batch ${Math.floor(i / BATCH)} failed:`, err instanceof Error ? err.message : String(err))
    }
  }
  console.log(`[Communities] Qdrant: ${stored}/${communities.length} community summaries embedded`)
  return stored
}

/** Deterministic UUID từ seed string (Qdrant point id cần UUID format) */
function uuidFromSeed(seed: string): string {
  const h = createHash('sha1').update(seed).digest('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`
}

// ==================== SEARCH ====================

/**
 * Vector search community summaries bằng query embedding.
 * Trả về top communities có cosine ≥ COMMUNITY_SCORE_THRESHOLD.
 * KHÔNG throw — trả [] khi collection chưa tồn tại / Qdrant lỗi (fail-open).
 */
export async function searchCommunities(
  queryEmbedding: number[],
  topK = 3
): Promise<CommunityInfo[]> {
  if (!isFlagEnabled('ENABLE_COMMUNITY_SEARCH')) return []
  if (!queryEmbedding || queryEmbedding.length === 0) return []
  try {
    const result = await qdrant.query(COLLECTION_COMMUNITIES, {
      query: queryEmbedding,
      limit: topK,
      with_payload: true,
      score_threshold: COMMUNITY_SCORE_THRESHOLD,
    })
    const hits = result.points.map(p => {
      const pl = (p.payload || {}) as Record<string, unknown>
      return {
        communityId: String(pl.communityId ?? ''),
        summary: String(pl.summary ?? ''),
        memberCount: Number(pl.memberCount ?? 0),
        topEntities: Array.isArray(pl.topEntities)
          ? (pl.topEntities as Array<Record<string, unknown>>).map(e => ({
              name: String(e.name ?? ''),
              type: String(e.type ?? ''),
              description: String(e.description ?? ''),
            }))
          : [],
        domains: Array.isArray(pl.domains) ? (pl.domains as string[]) : [],
        score: p.score,
      }
    })
    if (hits.length > 0) {
      console.log(`[Communities] Search: ${hits.length} community hits (top score ${hits[0].score?.toFixed(3)})`)
    }
    return hits
  } catch (err) {
    // Collection chưa tồn tại (chưa chạy detect) hoặc Qdrant lỗi — fail-open
    const msg = err instanceof Error ? err.message : String(err)
    if (!msg.includes('doesn\'t exist') && !msg.includes('does not exist') && !msg.includes('Collection') && !msg.includes('404')) {
      console.warn('[Communities] Search failed:', msg)
    }
    return []
  }
}

// ==================== STATUS ====================

export async function getCommunityStatus(): Promise<{
  enabled: boolean
  collectionExists: boolean
  communityCount: number
  detectionRunning: boolean
  neo4jNodesWithCommunity: number
}> {
  let collectionExists = false
  let communityCount = 0
  try {
    const collections = await qdrant.getCollections()
    collectionExists = collections.collections.some(c => c.name === COLLECTION_COMMUNITIES)
    if (collectionExists) {
      const info = await qdrant.getCollection(COLLECTION_COMMUNITIES)
      communityCount = info.points_count ?? 0
    }
  } catch {
    // Qdrant chưa sẵn sàng — trả zero-state
  }

  let neo4jNodesWithCommunity = 0
  try {
    const session = await safeSession()
    try {
      const result = await session.executeRead((tx) =>
        tx.run(`MATCH (n) WHERE n.communityId IS NOT NULL RETURN count(n) AS cnt`)
      )
      neo4jNodesWithCommunity = Number(toNative(result.records[0]?.get('cnt')) ?? 0)
    } finally {
      await session.close()
    }
  } catch {
    // fail-open
  }

  return {
    enabled: isFlagEnabled('ENABLE_COMMUNITY_SEARCH'),
    collectionExists,
    communityCount,
    detectionRunning: Boolean(globalForCommunities.__communityDetectionRunning),
    neo4jNodesWithCommunity,
  }
}

/**
 * TASK 50b — check NHẸ (chỉ Qdrant, không đụng Neo4j): community embeddings
 * đã được build chưa? Phân biệt 3 trạng thái:
 *   'ready'       — collection tồn tại + ≥1 point → KHÔNG cần detect lại
 *   'missing'     — collection chưa có / rỗng (chưa từng build hoặc build dở) → detect
 *   'unreachable' — Qdrant không mở/không kết nối được → HOÃN (detection cuối
 *                   chuỗi cũng fail ở bước embed — chạy chỉ tốn CPU/Neo4j read)
 */
async function communityEmbeddingsReady(): Promise<'ready' | 'missing' | 'unreachable'> {
  try {
    const collections = await qdrant.getCollections()
    const exists = collections.collections.some(c => c.name === COLLECTION_COMMUNITIES)
    if (!exists) return 'missing'
    try {
      const info = await qdrant.getCollection(COLLECTION_COMMUNITIES)
      return (info.points_count ?? 0) > 0 ? 'ready' : 'missing'
    } catch {
      // Có collection nhưng không đọc được count (hiếm) — coi như chưa build;
      // detection idempotent nên chạy lại vô hại
      return 'missing'
    }
  } catch {
    return 'unreachable'
  }
}

/**
 * Lazy auto-detect: gọi từ searchUserKB — fire-and-forget (không block query),
 * đúng 1 lần mỗi process.
 *
 * TASK 50b FIX: TRƯỚC ĐÂY hàm này bắn detectAndStoreCommunities() VÔ ĐIỀU
 * KIỆN (comment ghi "khi collection chưa tồn tại" nhưng KHÔNG hề check) →
 * mỗi restart app + query KB đầu tiên đều tự động chạy FULL detection
 * (fetch graph + Leiden CPU nặng + write Neo4j + embed — 6-12 phút trên
 * graph lớn) kể cả khi user đã build xong bằng tay qua
 * /api/query?action=community-detect (sandbox log: 22× auto-trigger lãng phí).
 * Giờ: check Qdrant TRƯỚC — đã có embeddings → skip; Qdrant unreachable →
 * hoãn + reset flag để query sau retry; chỉ chạy detection khi THẬT SỰ thiếu.
 */
export function ensureCommunitiesLazy(): void {
  if (!isFlagEnabled('ENABLE_COMMUNITY_SEARCH')) return
  if (globalForCommunities.__communityDetectionRunning) return
  const g = globalThis as unknown as { __communityAutoDetectTriggered?: boolean }
  if (g.__communityAutoDetectTriggered) return
  g.__communityAutoDetectTriggered = true
  void (async () => {
    try {
      const ready = await communityEmbeddingsReady()
      if (ready === 'ready') {
        console.log('[Communities] Collection theopus_communities đã có embeddings — bỏ qua auto-detect (Task 50b: trước đây chạy lại vô điều kiện mỗi restart)')
        return
      }
      if (ready === 'unreachable') {
        // Qdrant không mở — detection sẽ fail ở bước embed cuối anyway; hoãn
        // lượt này, reset flag để query kế tiếp (sau khi Qdrant mở) thử lại.
        console.warn('[Communities] Không kiểm tra được Qdrant — hoãn auto-detect (thử lại ở query sau)')
        g.__communityAutoDetectTriggered = false
        return
      }
      console.log('[Communities] Chưa có community embeddings — tự động chạy detection nền (một lần duy nhất)')
      await detectAndStoreCommunities()
    } catch (err) {
      console.warn('[Communities] Auto-detect failed:', err instanceof Error ? err.message : String(err))
      // Cho phép retry lần query kế tiếp nếu fail
      g.__communityAutoDetectTriggered = false
    }
  })()
}
