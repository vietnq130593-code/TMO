/**
 * Query API — Self-contained hybrid knowledge base query engine
 *
 * All query logic runs directly in this route (no proxying to mini-services)
 * so it works on Vercel serverless.
 *
 * POST /api/query — hybrid query (vector + graph + LLM answer + meta-cognitive reasoning)
 * GET  /api/query — service status / embed-status / stats / graph-explore / graph-path
 *
 * Architecture: SQLite (buffer) → Qdrant (vector+document) + Neo4j (graph)
 *
 * Uses shared lib modules:
 *   @/lib/llm        — callLLM()
 *   @/lib/embeddings — generateQueryEmbedding(), generateEmbedding()
 *   @/lib/qdrant     — searchSimilar(), hybridSearch(), getDocument(), listDocuments(), etc.
 *   @/lib/neo4j      — getNeo4jDriver(), readCypher(), executeCypher()
 *   @/lib/db         — PrismaClient for SQLite buffer
 */

import { NextRequest, NextResponse } from 'next/server'
import { callLLM, callLLMForAgent, callUtilityLLM, getDailyTokenUsage, LLMCallOptions } from '@/lib/llm'
import { generateQueryEmbedding, generateEmbedding } from '@/lib/embeddings'
import { getNeo4jDriver, safeSession, readCypher, executeCypher } from '@/lib/neo4j'
import {
  searchSimilar,
  hybridSearch,
  getDocument,
  listDocuments,
  updateDocumentStatus,
  getChunksByDocument,
  upsertChunks,
  getQdrantStats,
  setChunkPayloadByDocument,
  qdrant,
  COLLECTION_CHUNKS,
} from '@/lib/qdrant'
import type { ChunkPayload } from '@/lib/qdrant'
import { db } from '@/lib/db'

export const maxDuration = 60
export const dynamic = 'force-dynamic'

// ==================== HELPERS ====================

/** Convert a Neo4j Integer or other value to a JS number */
function toNum(val: unknown): number {
  if (typeof val === 'number') return val
  if (val && typeof val === 'object' && typeof (val as Record<string, unknown>).toNumber === 'function') {
    return (val as { toNumber: () => number }).toNumber()
  }
  return Number(val) || 0
}

/** Fetch document metadata (title, domain) for multiple document IDs */
async function fetchDocMetadata(docIds: string[]): Promise<Map<string, { title: string; domain: string }>> {
  const docMap = new Map<string, { title: string; domain: string }>()
  if (docIds.length === 0) return docMap
  for (const docId of docIds) {
    try {
      const doc = await getDocument(docId)
      if (doc) docMap.set(docId, { title: doc.title, domain: doc.domain })
    } catch { /* skip missing docs */ }
  }
  return docMap
}

// ==================== STATS CACHE ====================

interface StatsCacheEntry {
  data: Record<string, unknown>
  timestamp: number
}
const STATS_CACHE_TTL = (() => {
  // VÒNG 10 FIX (restart-loop RAM): graph 176k entities / 205k rels ổn định suốt mission,
  // nhưng dashboard poll mỗi 10s + TTL 30s → full recompute 2 lần/phút, mỗi lần materialize
  // ~40-60MB vào JS heap → GC churn → RSS ratchet 2.3GB trên box 4GB → watchdog self-exit →
  // mission RESUME lặp vô hạn (39 lần ở chu kỳ 7). Mặc định 5 phút; env STATS_CACHE_TTL_MS
  // override được; force=true vẫn recompute ngay khi cần.
  const raw = Number(process.env.STATS_CACHE_TTL_MS)
  if (Number.isFinite(raw) && raw > 0) return raw
  return 300 * 1000
})()

function getStatsCache(): StatsCacheEntry | null {
  const cache = globalThis.__statsCache as StatsCacheEntry | undefined
  if (!cache) return null
  if (Date.now() - cache.timestamp > STATS_CACHE_TTL) return null
  return cache
}

function setStatsCache(data: Record<string, unknown>) {
  globalThis.__statsCache = { data, timestamp: Date.now() }
}

// ==================== TYPES ====================

type QueryType = 'factual' | 'relational' | 'analytical' | 'exploratory'

interface QueryClassification {
  queryType: QueryType
  domain: string
  keyTerms: string[]
  needsVector: boolean
  needsGraph: boolean
  reasoning: string
}

interface VectorSearchResult {
  chunkId: string
  content: string
  documentId: string
  documentTitle: string
  domain: string
  similarity: number
  headingPath: string
}

interface GraphSearchResult {
  entities: Array<{ name: string; type: string; domain: string; description: string }>
  relationships: Array<{ source: string; type: string; target: string }>
  paths: Array<{ nodes: string[]; edges: Array<{ source: string; type: string; target: string }>; length: number }>
}

interface RRFResult {
  content: string
  source: 'vector' | 'graph' | 'both'
  vectorScore?: number
  graphScore?: number
  rrfScore: number
  metadata: Record<string, unknown>
}

// ==================== QUERY CLASSIFICATION ====================

async function classifyQuery(query: string, llmOptions?: LLMCallOptions): Promise<QueryClassification> {
  const systemPrompt = `You are a query classifier for a GraphRAG knowledge base.
Analyze the user's question and classify it. Output ONLY valid JSON.

Classification types:
- "factual": Direct factual question (needs vector search for relevant chunks)
- "relational": Question about relationships between entities (needs graph traversal)
- "analytical": Requires reasoning across multiple sources (needs both vector + graph)
- "exploratory": Broad exploration of a topic (needs graph neighborhood + vector)

Domains: programming, algorithm, ml, meta_cognitive, linux, security, mixed

Output format:
{
  "queryType": "factual|relational|analytical|exploratory",
  "domain": "algorithm",
  "keyTerms": ["term1", "term2"],
  "needsVector": true,
  "needsGraph": true,
  "reasoning": "Brief explanation"
}`

  // UTILITY CORE: classification là tiền xử lý — dùng lõi utility (zen
  // space-bunny-free) để query module không bị treo khi lõi agent bận/block.
  const result = await callUtilityLLM(query, systemPrompt, 'classification', llmOptions)

  try {
    const jsonMatch = result.content.match(/\{[\s\S]*\}/)
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0])
      return {
        queryType: ['factual', 'relational', 'analytical', 'exploratory'].includes(parsed.queryType) ? parsed.queryType : 'factual',
        domain: parsed.domain || 'mixed',
        keyTerms: Array.isArray(parsed.keyTerms) ? parsed.keyTerms : [query],
        needsVector: parsed.needsVector !== false,
        needsGraph: parsed.needsGraph !== false,
        reasoning: parsed.reasoning || '',
      }
    }
  } catch (err) { console.error('[Query] Classification parse error:', err instanceof Error ? err.message : String(err)) }

  return {
    queryType: 'analytical',
    domain: 'mixed',
    keyTerms: query.split(/\s+/).filter(w => w.length > 3).slice(0, 5),
    needsVector: true,
    needsGraph: true,
    reasoning: 'Default: both sources needed',
  }
}

// ==================== VECTOR SEARCH (Qdrant) ====================

async function vectorSearch(queryEmbedding: number[], limit = 10, threshold = 0.3): Promise<VectorSearchResult[]> {
  try {
    // Use Qdrant searchSimilar for vector search — all vectors in Qdrant are real
    const results = await searchSimilar(queryEmbedding, { limit, minScore: threshold })

    if (results.length === 0) return []

    // Collect unique document IDs to fetch titles
    const docIds = [...new Set(results.map(r => r.payload.document_id))]
    const docMap = await fetchDocMetadata(docIds)

    return results.map(r => ({
      chunkId: r.id,
      content: r.payload.content,
      documentId: r.payload.document_id,
      documentTitle: docMap.get(r.payload.document_id)?.title || 'Unknown',
      domain: r.payload.domain || docMap.get(r.payload.document_id)?.domain || 'mixed',
      similarity: r.score,
      headingPath: r.payload.heading_path || '',
    }))
  } catch (err) {
    console.error('[VectorSearch] Error:', err instanceof Error ? err.message : String(err))
    return []
  }
}

// ==================== TEXT SEARCH (Qdrant hybridSearch fallback) ====================

async function textSearch(query: string, queryEmbedding: number[], limit = 5): Promise<VectorSearchResult[]> {
  const results: VectorSearchResult[] = []
  const terms = query.split(/\s+/).filter(w => w.length > 2).slice(0, 5)
  if (terms.length === 0) return results

  try {
    // Use Qdrant hybridSearch combining vector similarity with keyword filtering
    const searchResults = await hybridSearch(queryEmbedding, {
      limit,
      keywords: terms,
      minScore: 0.1, // Lower threshold for text fallback
    })

    if (searchResults.length === 0) return results

    // Collect unique document IDs
    const docIds = [...new Set(searchResults.map(r => r.payload.document_id))]
    const docMap = await fetchDocMetadata(docIds)

    for (const r of searchResults) {
      const doc = docMap.get(r.payload.document_id)
      results.push({
        chunkId: r.id,
        content: r.payload.content,
        documentId: r.payload.document_id,
        documentTitle: doc?.title || 'Unknown',
        domain: r.payload.domain || doc?.domain || 'mixed',
        similarity: r.score,
        headingPath: r.payload.heading_path || '',
      })
    }
  } catch (err) {
    console.error('[TextSearch] Error:', err instanceof Error ? err.message : String(err))
  }

  return results
}

// ==================== GRAPH SEARCH (Neo4j) ====================

async function graphSearch(queryTerms: string[], maxHops = 2, limit = 20): Promise<GraphSearchResult> {
  const intLimit = Math.floor(limit)
  let session: import('neo4j-driver').Session | null = null
  try {
    session = await safeSession()
  } catch {
    return { entities: [], relationships: [], paths: [] }
  }
  const entities: GraphSearchResult['entities'] = []
  const relationships: GraphSearchResult['relationships'] = []
  const paths: GraphSearchResult['paths'] = []

  try {
    for (const term of queryTerms.slice(0, 5)) {
      try {
        const result = await session.executeRead(tx =>
          tx.run(
            `MATCH (n) WHERE n.name CONTAINS $term OR n.name CONTAINS toLower($term)
             RETURN n.name AS name, labels(n) AS types, n.domain AS domain, n.description AS description
             LIMIT ${intLimit}`,
            { term }
          )
        )
        for (const record of result.records) {
          const types = record.get('types') as string[]
          const type = types.find(t => t !== 'Entity') || types[0] || 'Concept'
          entities.push({
            name: record.get('name'),
            type,
            domain: record.get('domain') || '',
            description: record.get('description') || '',
          })
        }
      } catch (err) {
        console.error(`[GraphSearch] Entity search for "${term}" failed:`, err instanceof Error ? err.message : String(err))
      }
    }

    // Deduplicate entities
    const seenEntities = new Set<string>()
    const uniqueEntities = entities.filter(e => {
      const key = e.name.toLowerCase()
      if (seenEntities.has(key)) return false
      seenEntities.add(key)
      return true
    })

    // Find relationships
    if (uniqueEntities.length > 0) {
      const entityNames = uniqueEntities.map(e => e.name).slice(0, 10)
      try {
        const relResult = await session.executeRead(tx =>
          tx.run(
            `MATCH (a)-[r]->(b) WHERE a.name IN $names OR b.name IN $names
             RETURN a.name AS source, type(r) AS relType, b.name AS target
             LIMIT ${intLimit}`,
            { names: entityNames }
          )
        )
        for (const record of relResult.records) {
          relationships.push({
            source: record.get('source'),
            type: record.get('relType'),
            target: record.get('target'),
          })
        }
      } catch (err) {
        console.error('[GraphSearch] Relationship search failed:', err instanceof Error ? err.message : String(err))
      }

      // Find paths between pairs
      if (uniqueEntities.length >= 2) {
        const pairs = [
          [uniqueEntities[0].name, uniqueEntities[1].name],
          ...(uniqueEntities.length > 2 ? [[uniqueEntities[0].name, uniqueEntities[2].name]] : []),
        ]
        for (const [from, to] of pairs) {
          try {
            const pathResult = await session.executeRead(tx =>
              tx.run(
                `MATCH path = shortestPath((a {name: $from})-[*..${maxHops * 2}]-(b {name: $to}))
                 RETURN [n IN nodes(path) | n.name] AS nodeNames,
                        [r IN relationships(path) | {source: startNode(r).name, type: type(r), target: endNode(r).name}] AS edges,
                        length(path) AS pathLength
                 LIMIT 3`,
                { from, to }
              )
            )
            for (const record of pathResult.records) {
              paths.push({
                nodes: record.get('nodeNames') as string[],
                edges: record.get('edges') as Array<{ source: string; type: string; target: string }>,
                length: Number(record.get('pathLength')),
              })
            }
          } catch (err) { console.error(`[GraphSearch] Path search failed:`, err instanceof Error ? err.message : String(err)) }
        }
      }
    }

    return { entities: uniqueEntities, relationships, paths }
  } finally {
    await session?.close().catch(() => {})
  }
}

async function exploreEntity(entityName: string, opts?: {
  /** P5-M1 — tăng số láng giềng cho bản đồ tri thức (default 30 — giữ hành vi cũ) */
  maxNeighbors?: number
  /** P5-M1 — trả kèm embedding Neo4j của node (nếu có) để vẽ bản đồ PCA */
  withEmbeddings?: boolean
}): Promise<{
  entity: GraphSearchResult['entities'][0] | null
  neighbors: GraphSearchResult['entities']
  relationships: GraphSearchResult['relationships']
  /** P5-M1 — embedding node theo tên (chỉ khi withEmbeddings; thiếu = node không có) */
  embeddingsByName?: Map<string, number[]>
}> {
  const maxNeighbors = opts?.maxNeighbors ?? 30
  const withEmbeddings = opts?.withEmbeddings ?? false
  let session: import('neo4j-driver').Session | null = null
  try {
    session = await safeSession()
  } catch {
    return { entity: null, neighbors: [], relationships: [] }
  }
  try {
    let entity: GraphSearchResult['entities'][0] | null = null
    let entityEmbedding: number[] | null = null
    try {
      const entityResult = await session.executeRead(tx =>
        tx.run(
          `MATCH (n {name: $name}) RETURN n.name AS name, labels(n) AS types, n.domain AS domain, n.description AS description${withEmbeddings ? ', n.embedding AS embedding' : ''} LIMIT 1`,
          { name: entityName }
        )
      )
      if (entityResult.records.length > 0) {
        const record = entityResult.records[0]
        const types = record.get('types') as string[]
        entity = {
          name: record.get('name'),
          type: types.find(t => t !== 'Entity') || types[0] || 'Concept',
          domain: record.get('domain') || '',
          description: record.get('description') || '',
        }
        if (withEmbeddings) {
          const emb = record.get('embedding') as number[] | null | undefined
          if (Array.isArray(emb) && emb.length >= 2) entityEmbedding = emb
        }
      }
    } catch (err) { console.error('[GraphSearch] Entity lookup failed:', err instanceof Error ? err.message : String(err)) }

    const neighbors: GraphSearchResult['entities'] = []
    const relationships: GraphSearchResult['relationships'] = []
    const embeddingsByName = new Map<string, number[]>()

    try {
      const neighborResult = await session.executeRead(tx =>
        tx.run(
          `MATCH (center {name: $name})-[r]-(neighbor)
           RETURN neighbor.name AS name, labels(neighbor) AS types, neighbor.domain AS domain,
                  CASE WHEN startNode(r).name = $name THEN 'outgoing' ELSE 'incoming' END AS direction,
                  type(r) AS relType,
                  CASE WHEN startNode(r).name = $name THEN neighbor.name ELSE $name END AS relTarget,
                  CASE WHEN startNode(r).name = $name THEN $name ELSE startNode(r).name END AS relSource${withEmbeddings ? ', neighbor.embedding AS embedding' : ''}
           LIMIT toInteger($limit)`,
          { name: entityName, limit: maxNeighbors }
        )
      )

      const seenNeighbors = new Set<string>()
      for (const record of neighborResult.records) {
        const nName = record.get('name') as string
        if (!seenNeighbors.has(nName.toLowerCase())) {
          seenNeighbors.add(nName.toLowerCase())
          const types = record.get('types') as string[]
          neighbors.push({
            name: nName,
            type: types.find(t => t !== 'Entity') || types[0] || 'Concept',
            domain: record.get('domain') || '',
            description: '',
          })
          if (withEmbeddings) {
            const emb = record.get('embedding') as number[] | null | undefined
            if (Array.isArray(emb) && emb.length >= 2) embeddingsByName.set(nName, emb)
          }
        }
        const direction = record.get('direction') as string
        const relType = record.get('relType') as string
        if (direction === 'outgoing') {
          relationships.push({ source: entityName, type: relType, target: record.get('relTarget') as string })
        } else {
          relationships.push({ source: record.get('relSource') as string, type: relType, target: entityName })
        }
      }
    } catch (err) { console.error('[GraphSearch] Neighbor search failed:', err instanceof Error ? err.message : String(err)) }

    if (withEmbeddings && entity && entityEmbedding) {
      embeddingsByName.set(entity.name, entityEmbedding)
    }

    return withEmbeddings
      ? { entity, neighbors, relationships, embeddingsByName }
      : { entity, neighbors, relationships }
  } finally {
    await session.close()
  }
}

// ==================== P5-M1 — GRAPH-EXPLORE + PCA BẢN ĐỒ TRI THỨC ====================
//
// Cache 1h theo tên entity (spec §P5-M1: "cap 500 node, cache 1h") — đồ hình
// chỉ đổi khi ingestion/resolve chạy tiếp, còn PCA top-2 trên ≤500 vector
// 2048-dim có chi phí đáng kể (power iteration trên ma trận hiệp phương sai
// d×d). Cap số entry cache 64 — nội dung nhỏ (xy + metadata), LRU thô: đầy
// thì xoá sạch (đơn giản, đủ cho traffic thăm dò đồ thị).

const GRAPH_MAP_MAX_NODES = 500
const GRAPH_MAP_CACHE_MS = 60 * 60 * 1000 // 1h
const GRAPH_MAP_CACHE_MAX_ENTRIES = 64

interface GraphExploreMapResult {
  entity: Awaited<ReturnType<typeof exploreEntity>>['entity']
  neighbors: Awaited<ReturnType<typeof exploreEntity>>['neighbors']
  relationships: Awaited<ReturnType<typeof exploreEntity>>['relationships']
  map: {
    /** tên node → toạ độ 2D [x, y] trên 2 thành phần chính (PC1/PC2) */
    xy: Record<string, [number, number]>
    /** tỉ lệ phương sai PC1/PC2 giải thích được [r1, r2] */
    explainedVariances: [number, number] | null
    /** số node có embedding (tham gia PCA) / tổng node */
    nWithEmbedding: number
    nNodes: number
    /** false khi không đủ node có embedding (PCA không tính được) */
    pcaAvailable: boolean
  }
  fromCache: boolean
}

const graphExploreCache = new Map<string, { result: Omit<GraphExploreMapResult, 'fromCache'>; expiresAt: number }>()

/** exploreEntity + PCA map — có cache 1h. Fail-open: Neo4j/PCA lỗi vẫn trả đồ thị. */
async function exploreEntityWithMap(entityName: string): Promise<GraphExploreMapResult> {
  // FB-Đợt7-R4 (B4): cache key GIỮ nguyên hoa/thường — Neo4j `MATCH {name:$name}`
  // phân biệt hoa/thường nên "neural network" và "Neural Network" là 2 truy vấn
  // KHÁC nhau (bản cũ lowercased key → truy vấn thường ăn nhầm đồ thị của bản
  // hoa — đã tái lập live: "neural network" nhận fromCache=true của "Neural
  // Network"). Trim vẫn giữ (khoảng trắng thừa là cùng một ý định truy vấn).
  const cacheKey = entityName.trim()
  const cached = graphExploreCache.get(cacheKey)
  if (cached && Date.now() < cached.expiresAt) {
    return { ...cached.result, fromCache: true }
  }

  const explored = await exploreEntity(entityName, {
    maxNeighbors: GRAPH_MAP_MAX_NODES - 1, // cap 500 node tính cả entity (spec §P5-M1)
    withEmbeddings: true,
  })

  // PCA top-2 trên các node CÓ embedding (node không có → xy null, UI tự xử)
  const namesWithEmbedding: string[] = []
  const vectors: number[][] = []
  if (explored.embeddingsByName) {
    for (const [name, emb] of explored.embeddingsByName) {
      if (vectors.length >= GRAPH_MAP_MAX_NODES) break
      namesWithEmbedding.push(name)
      vectors.push(emb)
    }
  }

  let xy: Record<string, [number, number]> = {}
  let explainedVariances: [number, number] | null = null
  let pcaAvailable = false
  if (vectors.length >= 2) {
    try {
      const { pcaTop2 } = await import('@/lib/stats/pca')
      const pca = pcaTop2(vectors)
      if (pca) {
        xy = Object.fromEntries(namesWithEmbedding.map((name, i) => [name, pca.xy[i]]))
        explainedVariances = pca.explainedVariances
        pcaAvailable = true
      }
    } catch (err) {
      console.warn('[GraphExplore] P5-M1 PCA failed (non-fatal — trả không map):', err instanceof Error ? err.message : String(err))
    }
  }

  const nNodes = (explored.entity ? 1 : 0) + explored.neighbors.length
  const result: Omit<GraphExploreMapResult, 'fromCache'> = {
    entity: explored.entity,
    neighbors: explored.neighbors,
    relationships: explored.relationships,
    map: {
      xy,
      explainedVariances,
      nWithEmbedding: vectors.length,
      nNodes,
      pcaAvailable,
    },
  }

  if (graphExploreCache.size >= GRAPH_MAP_CACHE_MAX_ENTRIES) graphExploreCache.clear()
  graphExploreCache.set(cacheKey, { result, expiresAt: Date.now() + GRAPH_MAP_CACHE_MS })

  return { ...result, fromCache: false }
}

async function findPath(fromName: string, toName: string, maxHops = 4): Promise<GraphSearchResult['paths']> {
  let session: import('neo4j-driver').Session | null = null
  try {
    session = await safeSession()
  } catch {
    return []
  }
  try {
    const result = await session.executeRead(tx =>
      tx.run(
        `MATCH path = shortestPath((a {name: $from})-[*..${maxHops}]-(b {name: $to}))
         RETURN [n IN nodes(path) | n.name] AS nodeNames,
                [r IN relationships(path) | {source: startNode(r).name, type: type(r), target: endNode(r).name}] AS edges,
                length(path) AS pathLength
         LIMIT 5`,
        { from: fromName, to: toName }
      )
    )
    return result.records.map(record => ({
      nodes: record.get('nodeNames') as string[],
      edges: record.get('edges') as Array<{ source: string; type: string; target: string }>,
      length: Number(record.get('pathLength')),
    }))
  } catch {
    return []
  } finally {
    await session.close().catch(() => {})
  }
}

// ==================== RRF FUSION ====================

function reciprocalRankFusion(
  vectorResults: VectorSearchResult[],
  graphResults: GraphSearchResult,
  k = 60
): RRFResult[] {
  const scores = new Map<string, RRFResult>()

  vectorResults.forEach((result, rank) => {
    const key = `vec_${result.chunkId}`
    const rrf = 1 / (k + rank + 1)
    scores.set(key, {
      content: result.content,
      source: 'vector',
      vectorScore: result.similarity,
      rrfScore: rrf,
      metadata: {
        chunkId: result.chunkId,
        documentTitle: result.documentTitle,
        domain: result.domain,
        headingPath: result.headingPath,
      },
    })
  })

  graphResults.entities.forEach((entity, rank) => {
    const key = `graph_ent_${entity.name}`
    const rrf = 1 / (k + rank + 1)
    const existing = scores.get(key)
    if (existing) {
      existing.source = 'both'
      existing.graphScore = 1 - rank * 0.05
      existing.rrfScore += rrf
    } else {
      scores.set(key, {
        content: `${entity.name} (${entity.type}): ${entity.description}`,
        source: 'graph',
        graphScore: 1 - rank * 0.05,
        rrfScore: rrf,
        metadata: { entityName: entity.name, entityType: entity.type, domain: entity.domain },
      })
    }
  })

  return Array.from(scores.values()).sort((a, b) => b.rrfScore - a.rrfScore)
}

// ==================== KEY TERM EXTRACTION ====================

function extractKeyTerms(query: string): string[] {
  const terms: string[] = []
  const quotedMatch = query.match(/"([^"]+)"/g)
  if (quotedMatch) for (const q of quotedMatch) terms.push(q.replace(/"/g, ''))
  const capWords = query.match(/\b[A-Z][a-zA-Z]+\b/g)
  if (capWords) terms.push(...capWords)
  const capSequences = query.match(/\b[A-Z][a-z]+(?:\s+(?:and|of|the|in|for|to|with)\s+[A-Z][a-z]+|\s+[A-Z][a-z]+)*\b/g)
  if (capSequences) terms.push(...capSequences)
  const techTerms = query.match(/\b(?:algorithm|sorting|search|graph|tree|hash|machine\s+learning|neural|network|deep\s+learning|recursion|divide\s+and\s+conquer|quicksort|mergesort|bubblesort|binary|linear|python|java|c\+\+|linux|security|exploit|vulnerability|penetration|nmap|metasploit|cognitive|reasoning|meta)\b/gi)
  if (techTerms) terms.push(...techTerms.map(t => t.charAt(0).toUpperCase() + t.slice(1)))
  if (terms.length < 2) {
    const words = query.split(/\s+/).filter(w => w.length > 4 && !/^(what|how|why|when|where|who|which|that|this|about|between|related)\b/i.test(w))
    terms.push(...words)
  }
  return [...new Set(terms.map(t => t.trim()).filter(t => t.length > 1))].slice(0, 8)
}

// ==================== ANSWER GENERATION ====================

async function generateAnswer(
  query: string,
  classification: QueryClassification,
  _rrfResults: RRFResult[],
  graphResults: GraphSearchResult,
  vectorResults: VectorSearchResult[],
  chatHistory?: Array<{ role: 'user' | 'assistant'; content: string }>,
  llmOptions?: LLMCallOptions,
  agentConfig?: { provider: string; model: string },
): Promise<{ answer: string; reasoning: string; confidence: number; provider: string; model: string }> {
  const contextParts: string[] = []

  const topChunks = vectorResults.slice(0, 5)
  if (topChunks.length > 0) {
    contextParts.push('=== RELEVANT DOCUMENT CHUNKS ===')
    topChunks.forEach((chunk, i) => {
      contextParts.push(`[Source ${i + 1}: ${chunk.documentTitle} (${chunk.domain}) - Similarity: ${(chunk.similarity * 100).toFixed(1)}%]`)
      contextParts.push(chunk.content.slice(0, 800))
      contextParts.push('')
    })
  }

  if (graphResults.entities.length > 0) {
    contextParts.push('=== KNOWLEDGE GRAPH ENTITIES ===')
    graphResults.entities.slice(0, 10).forEach(entity => {
      contextParts.push(`- ${entity.name} (${entity.type}, domain: ${entity.domain}): ${entity.description}`)
    })
    contextParts.push('')
  }

  if (graphResults.relationships.length > 0) {
    contextParts.push('=== KNOWLEDGE GRAPH RELATIONSHIPS ===')
    graphResults.relationships.slice(0, 15).forEach(rel => {
      contextParts.push(`- ${rel.source} → [${rel.type}] → ${rel.target}`)
    })
    contextParts.push('')
  }

  if (graphResults.paths.length > 0) {
    contextParts.push('=== REASONING PATHS ===')
    graphResults.paths.forEach((path, i) => {
      contextParts.push(`Path ${i + 1}: ${path.nodes.join(' → ')} (length: ${path.length})`)
      path.edges.forEach(e => contextParts.push(`  ${e.source} -[${e.type}]-> ${e.target}`))
    })
    contextParts.push('')
  }

  const context = contextParts.join('\n')
  const hasKBContext = context.trim().length > 0

  // If KB has no data AND there's no agent with own provider/model → return "no data" message
  // If KB has no data BUT agent has own provider/model → let the agent use its own knowledge
  if (!hasKBContext && !agentConfig) {
    // FIX RESET-2026-08-30: câu hỏi về NĂNG LỰC bản thân agent (skill/tool/mcp/
    // todo/filesystem...) KHÔNG nằm trong KB — trước đây trả "Xin lỗi, tôi không
    // tìm thấy thông tin...". Giờ probe năng lực runtime THẬT và trả báo cáo ngắn.
    if (/(skill|kỹ năng|công cụ|tool|mcp|todo|năng lực|capabilit)/i.test(query)) {
      try {
        const { probeCapabilities } = await import('@/lib/agent-capabilities')
        const report = await probeCapabilities()
        const lines = report.capabilities.map(c =>
          `- ${c.group}: ${c.status === 'ok' ? '✅' : c.status === 'degraded' ? '⚠️' : '❌'} ${c.tools.join(', ')}${c.detail ? ` (${c.detail.slice(0, 100)})` : ''}`
        )
        const skillsLine = report.skills.filesystem > 0 ? `\n- Skills: ${report.skills.filesystem} trên đĩa + ${report.skills.dbEnabled} trong DB — gọi list_skills để liệt kê đầy đủ` : ''
        const mcpLine = report.mcp.servers > 0 ? `\n- MCP: ${report.mcp.servers} server — gọi mcp_list_servers để xem chi tiết` : ''
        return {
          answer: `Đây là năng lực runtime thực tế của tôi (đã xác nhận lúc ${new Date(report.probedAt).toLocaleTimeString('vi-VN')}):\n${lines.join('\n')}${skillsLine}${mcpLine}\n\nGợi ý: chat với agent có provider riêng (Omega) để tôi tự gọi list_skills / mcp_list_servers / todo_read trả lời chi tiết.`,
          reasoning: 'Self-capability question answered by runtime probe (KB has no such data).',
          confidence: 0.95,
          provider: 'capability-probe',
          model: 'runtime-verified',
        }
      } catch {
        // probe fail → fall through to default "no data" message
      }
    }
    return { answer: 'Xin lỗi, tôi không tìm thấy thông tin liên quan trong Knowledge Base để trả lời câu hỏi này.', reasoning: 'No relevant context found and no agent LLM configured.', confidence: 0.1, provider: 'none', model: 'none' }
  }

  const chatHistoryContext = chatHistory && chatHistory.length > 0
    ? `\n=== CONVERSATION HISTORY ===\n${chatHistory.slice(-5).map(msg => `${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.content.slice(0, 300)}`).join('\n')}\n=== END HISTORY ===\n`
    : ''

  // When agent has own provider/model: KB is SUPPLEMENTARY, agent can use its own knowledge
  // When no agent config (pure KB query): KB is PRIMARY, answer only from context
  const systemPrompt = agentConfig
    ? `You are an intelligent AI assistant with access to a GraphRAG Knowledge Base as a supplementary information source.
${chatHistoryContext}
RULES:
1. Answer in Vietnamese if the question is in Vietnamese, otherwise in English
2. You have your own general knowledge — USE IT freely to answer questions
3. If the Knowledge Base context contains relevant information, cite it using [Source N] references and PRIORITIZE it over your general knowledge
4. If the Knowledge Base context is empty or doesn't contain relevant information, answer from your own knowledge — do NOT say "I can't find information" or "I don't have data"
5. When using KB data, if you find information from both document chunks and knowledge graph, prioritize information that appears in BOTH sources
6. Provide a confidence score (0.0-1.0): higher when KB data confirms your knowledge, moderate when answering from your own knowledge
7. Provide a brief reasoning chain explaining how you arrived at the answer
8. Be helpful, thorough, and natural — greet users warmly, answer questions fully

Output format (JSON):
{
  "answer": "Your detailed answer here (with [Source N] citations if KB data was used)",
  "reasoning": "Brief reasoning chain (mention whether answer used KB data or own knowledge)",
  "confidence": 0.85
}`
    : `You are an AI assistant for a GraphRAG Knowledge Base. Answer the user's question based on the provided context from the knowledge base.
${chatHistoryContext}
RULES:
1. Answer in Vietnamese if the question is in Vietnamese, otherwise in English
2. Always cite your sources using [Source N] references
3. If you find information from both document chunks and knowledge graph, prioritize information that appears in BOTH sources
4. If the context doesn't contain enough information to answer, say so clearly and suggest what the user could add to the Knowledge Base
5. Provide a confidence score (0.0-1.0) based on how many sources confirm the information
6. Provide a brief reasoning chain explaining how you arrived at the answer

Output format (JSON):
{
  "answer": "Your detailed answer here with [Source N] citations",
  "reasoning": "Brief reasoning chain",
  "confidence": 0.85
}`

  const userPrompt = hasKBContext
    ? `Question: ${query}\n\nContext from Knowledge Base:\n${context}`
    : `Question: ${query}\n\nNo relevant context found in Knowledge Base. Answer from your own knowledge.`

  // Phase 3: Use agent's configured provider/model if available, otherwise global pool
  const result = agentConfig
    ? await callLLMForAgent(userPrompt, agentConfig, systemPrompt, llmOptions)
    : await callLLM(userPrompt, systemPrompt, 'query', llmOptions)

  try {
    const jsonMatch = result.content.match(/\{[\s\S]*\}/)
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0])
      return {
        answer: parsed.answer || result.content,
        reasoning: parsed.reasoning || '',
        confidence: Math.min(1, Math.max(0, parsed.confidence || 0.5)),
        provider: result.provider,
        model: result.model,
      }
    }
  } catch (err) { console.error('[Query] Answer JSON parse error:', err instanceof Error ? err.message : String(err)) }

  return { answer: result.content || 'Không thể tạo câu trả lời.', reasoning: 'Raw LLM response', confidence: 0.3, provider: result.provider, model: result.model }
}

// ==================== META-COGNITIVE REASONING ====================

interface ReasoningChainStep { step: string; claim: string; evidence: string; sourceType: 'vector' | 'graph' | 'both' }
interface CrossValidationResult { validatedFacts: string[]; contradictions: string[]; score: number }
interface MetaCognitiveResult {
  sufficient: boolean; missingAspects: string[]; crossValidation: CrossValidationResult
  reasoningChain: ReasoningChainStep[]; confidence: number; used: boolean
}

function buildContextSummary(vectorResults: VectorSearchResult[], graphResults: GraphSearchResult, maxChunks = 5, maxEntities = 8): string {
  const parts: string[] = []
  if (vectorResults.length > 0) {
    parts.push('=== DOCUMENT CHUNKS ===')
    vectorResults.slice(0, maxChunks).forEach((chunk, i) => {
      parts.push(`[Chunk ${i + 1}: ${chunk.documentTitle} - Similarity: ${(chunk.similarity * 100).toFixed(1)}%]`)
      parts.push(chunk.content.slice(0, 600))
    })
  }
  if (graphResults.entities.length > 0) {
    parts.push('=== GRAPH ENTITIES ===')
    graphResults.entities.slice(0, maxEntities).forEach(e => parts.push(`- ${e.name} (${e.type}): ${e.description}`))
  }
  if (graphResults.relationships.length > 0) {
    parts.push('=== GRAPH RELATIONSHIPS ===')
    graphResults.relationships.slice(0, 10).forEach(r => parts.push(`- ${r.source} → [${r.type}] → ${r.target}`))
  }
  return parts.join('\n')
}

async function sufficiencyCheck(query: string, vectorResults: VectorSearchResult[], graphResults: GraphSearchResult, llmOptions?: LLMCallOptions): Promise<{ sufficient: boolean; missingAspects: string[] }> {
  const context = buildContextSummary(vectorResults, graphResults)
  if (!context.trim()) return { sufficient: false, missingAspects: ['No search results available'] }

  // UTILITY CORE: meta-cognitive checks là tác vụ đánh giá nền — lõi utility.
  const result = await callUtilityLLM(
    `Question: ${query}\n\nSearch Results:\n${context}`,
    'You are evaluating whether the provided search results contain enough information to fully answer the given question. Output ONLY valid JSON: { "sufficient": true/false, "missingAspects": ["aspect1"] }',
    'sufficiency-check',
    llmOptions
  )
  try {
    const jsonMatch = result.content.match(/\{[\s\S]*\}/)
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0])
      return { sufficient: parsed.sufficient === true, missingAspects: Array.isArray(parsed.missingAspects) ? parsed.missingAspects.slice(0, 5) : [] }
    }
  } catch (err) { console.error('[MetaCog] Sufficiency check parse error:', err instanceof Error ? err.message : String(err)) }
  return { sufficient: vectorResults.length > 0 || graphResults.entities.length > 0, missingAspects: [] }
}

async function crossValidation(query: string, vectorResults: VectorSearchResult[], graphResults: GraphSearchResult, llmOptions?: LLMCallOptions): Promise<CrossValidationResult> {
  const context = buildContextSummary(vectorResults, graphResults)
  if (!context.trim()) return { validatedFacts: [], contradictions: [], score: 0 }
  const hasBoth = vectorResults.length > 0 && graphResults.entities.length > 0
  // UTILITY CORE: cross-validation là tác vụ kiểm chứng nền — lõi utility.
  const result = await callUtilityLLM(
    `Question: ${query}\nAvailable Sources: Document chunks: ${vectorResults.length}, Graph entities: ${graphResults.entities.length}, Both: ${hasBoth}\n\nSearch Results:\n${context}`,
    'You are verifying facts by cross-referencing information from multiple sources. Output ONLY valid JSON: { "validatedFacts": ["fact1"], "contradictions": ["contradiction1"], "score": 0.85 }',
    'cross-validation',
    llmOptions
  )
  try {
    const jsonMatch = result.content.match(/\{[\s\S]*\}/)
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0])
      return { validatedFacts: Array.isArray(parsed.validatedFacts) ? parsed.validatedFacts.slice(0, 10) : [], contradictions: Array.isArray(parsed.contradictions) ? parsed.contradictions.slice(0, 5) : [], score: Math.min(1, Math.max(0, typeof parsed.score === 'number' ? parsed.score : 0.5)) }
    }
  } catch (err) { console.error('[MetaCog] Cross-validation parse error:', err instanceof Error ? err.message : String(err)) }
  return { validatedFacts: [], contradictions: [], score: hasBoth ? 0.6 : 0.4 }
}

async function reasoningChainGeneration(query: string, vectorResults: VectorSearchResult[], graphResults: GraphSearchResult, llmOptions?: LLMCallOptions): Promise<ReasoningChainStep[]> {
  const context = buildContextSummary(vectorResults, graphResults)
  if (!context.trim()) return []
  // UTILITY CORE: reasoning chain là tác vụ diễn giải nền — lõi utility.
  const result = await callUtilityLLM(
    `Question: ${query}\n\nSearch Results:\n${context}`,
    'Generate a step-by-step reasoning chain showing how an answer can be derived from the search results. Output ONLY valid JSON: { "steps": [{ "step": "1", "claim": "conclusion", "evidence": "source quote", "sourceType": "vector|graph|both" }] }',
    'reasoning-chain',
    llmOptions
  )
  try {
    const jsonMatch = result.content.match(/\{[\s\S]*\}/)
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0])
      if (Array.isArray(parsed.steps)) {
        return parsed.steps
          .filter((s: Record<string, unknown>) => s.claim && s.evidence)
          .slice(0, 8)
          .map((s: Record<string, unknown>, i: number) => ({
            step: String(s.step || i + 1), claim: String(s.claim), evidence: String(s.evidence),
            sourceType: ['vector', 'graph', 'both'].includes(s.sourceType as string) ? (s.sourceType as 'vector' | 'graph' | 'both') : 'vector',
          }))
      }
    }
  } catch (err) { console.error('[MetaCog] Reasoning chain parse error:', err instanceof Error ? err.message : String(err)) }
  return []
}

function calculateConfidence(vectorResults: VectorSearchResult[], graphResults: GraphSearchResult, crossValidationScore: number, reasoningSteps: ReasoningChainStep[]): number {
  const sourceCount = vectorResults.length + graphResults.entities.length
  const avgRelevance = vectorResults.length > 0 ? vectorResults.reduce((sum, v) => sum + v.similarity, 0) / vectorResults.length : 0.5
  const hasMultipleSources = vectorResults.length > 0 && graphResults.entities.length > 0
  const sourceMultiplier = hasMultipleSources ? 1.2 : 0.8
  const normalizedSourceCount = Math.min(sourceCount, 10) / 10
  let confidence = normalizedSourceCount * avgRelevance * crossValidationScore * sourceMultiplier
  const bothSourceSteps = reasoningSteps.filter(s => s.sourceType === 'both').length
  if (bothSourceSteps > 0) confidence *= (1 + bothSourceSteps * 0.05)
  return Math.min(1, Math.max(0, confidence))
}

async function metaCognitiveReasoning(query: string, vectorResults: VectorSearchResult[], graphResults: GraphSearchResult, llmOptions?: LLMCallOptions): Promise<MetaCognitiveResult> {
  if (vectorResults.length === 0 && graphResults.entities.length === 0) return { sufficient: true, missingAspects: [], crossValidation: { validatedFacts: [], contradictions: [], score: 0.5 }, reasoningChain: [], confidence: 0.5, used: false }

  const step1 = await sufficiencyCheck(query, vectorResults, graphResults, llmOptions)
  const step2 = await crossValidation(query, vectorResults, graphResults, llmOptions)
  const step3 = await reasoningChainGeneration(query, vectorResults, graphResults, llmOptions)
  const step4Confidence = calculateConfidence(vectorResults, graphResults, step2.score, step3)

  return { sufficient: step1.sufficient, missingAspects: step1.missingAspects, crossValidation: step2, reasoningChain: step3, confidence: step4Confidence, used: true }
}

// ==================== MAIN QUERY PIPELINE ====================

async function processQuery(query: string, options?: { skipClassify?: boolean; vectorOnly?: boolean; graphOnly?: boolean; skipMetaCog?: boolean; chatHistory?: Array<{ role: 'user' | 'assistant'; content: string }>; temperature?: number; maxTokens?: number; agentId?: string; agentName?: string; agentProvider?: string; agentModel?: string }) {
  const startTime = Date.now()

  // Build LLM options from agent temperature/maxTokens — only used for final answer generation
  const llmOptions: LLMCallOptions | undefined = (options?.temperature !== undefined || options?.maxTokens !== undefined || options?.agentId !== undefined)
    ? { temperature: options.temperature, maxTokens: options.maxTokens, agentId: options.agentId, agentName: options.agentName }
    : undefined

  // Step 1: Classify query
  const classification = options?.skipClassify ? {
    queryType: 'analytical' as QueryType, domain: 'mixed',
    keyTerms: extractKeyTerms(query), needsVector: !options?.graphOnly, needsGraph: !options?.vectorOnly, reasoning: 'Skipped classification',
  } : await classifyQuery(query, llmOptions)

  const rawTerms = extractKeyTerms(query)
  const allKeyTerms = [...new Set([...classification.keyTerms, ...rawTerms])].slice(0, 8)

  // Step 2: Vector search
  let vectorResults: VectorSearchResult[] = []
  let queryEmb: number[] = []
  if (classification.needsVector) {
    const { vector, model: embModel } = await generateQueryEmbedding(query)
    queryEmb = vector
    console.log(`[Query] Generated query embedding (model: ${embModel})`)
    vectorResults = await vectorSearch(queryEmb, 10, 0.2)
    if (vectorResults.length === 0) {
      console.log('[Query] Vector search empty, trying text search fallback')
      vectorResults = await textSearch(query, queryEmb, 5)
    }
  }

  // Step 3: Graph search
  let graphResults: GraphSearchResult = { entities: [], relationships: [], paths: [] }
  if (classification.needsGraph && allKeyTerms.length > 0) {
    graphResults = await graphSearch(allKeyTerms, 2, 20)
    if (graphResults.entities.length === 0) {
      for (const term of allKeyTerms.slice(0, 3)) {
        const explored = await exploreEntity(term)
        if (explored.entity) {
          graphResults.entities.push(explored.entity, ...explored.neighbors.slice(0, 5))
          graphResults.relationships.push(...explored.relationships)
        }
      }
      const seen = new Set<string>()
      graphResults.entities = graphResults.entities.filter(e => { const k = e.name.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true })
    }
  }

  // Step 3.5: Meta-cognitive reasoning
  let metaResult: MetaCognitiveResult = { sufficient: true, missingAspects: [], crossValidation: { validatedFacts: [], contradictions: [], score: 0.5 }, reasoningChain: [], confidence: 0.5, used: false }
  if (!options?.skipMetaCog) {
    try {
      metaResult = await metaCognitiveReasoning(query, vectorResults, graphResults, llmOptions)
    } catch (err) {
      console.error('[Query] Meta-cognitive reasoning failed:', err instanceof Error ? err.message : String(err))
    }

    // Wider search if insufficient
    if (metaResult.used && !metaResult.sufficient && metaResult.missingAspects.length > 0) {
      if (classification.needsVector && vectorResults.length < 3) {
        const widerEmb = queryEmb.length > 0 ? queryEmb : (await generateQueryEmbedding(query)).vector
        const widerVectorResults = await vectorSearch(widerEmb, 15, 0.1)
        const existingIds = new Set(vectorResults.map(v => v.chunkId))
        for (const vr of widerVectorResults) if (!existingIds.has(vr.chunkId)) vectorResults.push(vr)
      }
      if (classification.needsGraph) {
        const widerTerms = [...allKeyTerms, ...metaResult.missingAspects.map(a => a.split(' ').slice(-2).join(' '))].slice(0, 8)
        const widerGraphResults = await graphSearch(widerTerms, 3, 30)
        const existingEntityNames = new Set(graphResults.entities.map(e => e.name.toLowerCase()))
        for (const entity of widerGraphResults.entities) if (!existingEntityNames.has(entity.name.toLowerCase())) { graphResults.entities.push(entity); existingEntityNames.add(entity.name.toLowerCase()) }
        const existingRels = new Set(graphResults.relationships.map(r => `${r.source}|${r.type}|${r.target}`))
        for (const rel of widerGraphResults.relationships) { const key = `${rel.source}|${rel.type}|${rel.target}`; if (!existingRels.has(key)) { graphResults.relationships.push(rel); existingRels.add(key) } }
      }
      try {
        metaResult.crossValidation = await crossValidation(query, vectorResults, graphResults, llmOptions)
        metaResult.confidence = calculateConfidence(vectorResults, graphResults, metaResult.crossValidation.score, metaResult.reasoningChain)
      } catch (err) { console.error('[Query] Wider search cross-validation error:', err instanceof Error ? err.message : String(err)) }
    }
  }

  // Step 4: RRF Fusion
  const rrfResults = reciprocalRankFusion(vectorResults, graphResults)

  // Step 5: Generate answer
  let answerResult: { answer: string; reasoning: string; confidence: number; provider: string; model: string }
  try {
    // Phase 3: Pass agentConfig to generateAnswer if agent has provider+model configured
    const agentConfig = (options?.agentProvider && options?.agentModel)
      ? { provider: options.agentProvider, model: options.agentModel }
      : undefined
    answerResult = await generateAnswer(query, classification, rrfResults, graphResults, vectorResults, options?.chatHistory, llmOptions, agentConfig)
  } catch {
    answerResult = { answer: 'Xin lỗi, đã xảy ra lỗi khi tạo câu trả lời.', reasoning: 'Answer generation failed', confidence: 0.1, provider: 'none', model: 'none' }
  }

  const finalConfidence = metaResult.used ? metaResult.confidence : answerResult.confidence
  let reasoningSummary = answerResult.reasoning
  if (metaResult.used) {
    const parts: string[] = [answerResult.reasoning]
    if (!metaResult.sufficient) parts.push(`Note: Results may be insufficient (missing: ${metaResult.missingAspects.slice(0, 3).join(', ')})`)
    if (metaResult.crossValidation.contradictions.length > 0) parts.push(`Contradictions found: ${metaResult.crossValidation.contradictions.length}`)
    if (metaResult.crossValidation.validatedFacts.length > 0) parts.push(`Validated facts: ${metaResult.crossValidation.validatedFacts.length}`)
    if (metaResult.reasoningChain.length > 0) parts.push(`Reasoning chain: ${metaResult.reasoningChain.length} steps`)
    reasoningSummary = parts.join('. ')
  }

  const sources = [
    ...vectorResults.slice(0, 5).map(v => ({ type: 'chunk' as const, content: v.content.slice(0, 200), documentTitle: v.documentTitle, similarity: v.similarity })),
    ...graphResults.entities.slice(0, 5).map(e => ({ type: 'entity' as const, content: `${e.name} (${e.type}): ${e.description}`, entityName: e.name })),
    ...graphResults.relationships.slice(0, 5).map(r => ({ type: 'relationship' as const, content: `${r.source} → [${r.type}] → ${r.target}` })),
  ]

  // Follow-up questions
  let followUpQuestions: string[] = []
  try {
    // UTILITY CORE: follow-up questions là gợi ý phụ — lõi utility.
    const followUpResult = await callUtilityLLM(
      `Based on the following Q&A, suggest 2-3 follow-up questions.\nQuestion: ${query}\nAnswer: ${answerResult.answer.slice(0, 500)}\n\nOutput ONLY a JSON array of strings.`,
      'You generate concise follow-up questions. Output ONLY valid JSON array of strings.',
      'follow-up',
      llmOptions
    )
    const jsonMatch = followUpResult.content.match(/\[[\s\S]*\]/)
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0])
      if (Array.isArray(parsed)) followUpQuestions = parsed.filter((q: unknown) => typeof q === 'string' && String(q).trim()).slice(0, 3).map((q: string) => q.trim())
    }
  } catch (err) { console.error('[Query] Follow-up questions parse error:', err instanceof Error ? err.message : String(err)) }

  const durationMs = Date.now() - startTime
  return {
    answer: answerResult.answer, sources, reasoning: reasoningSummary,
    reasoningChain: metaResult.used && metaResult.reasoningChain.length > 0 ? metaResult.reasoningChain : undefined,
    crossValidation: metaResult.used ? metaResult.crossValidation : undefined,
    confidence: finalConfidence, queryType: classification.queryType,
    provider: answerResult.provider, model: answerResult.model,
    vectorResultsCount: vectorResults.length, graphResultsCount: graphResults.entities.length,
    durationMs, metaCognitiveUsed: metaResult.used, followUpQuestions,
  }
}

// ==================== EMBEDDING REGENERATION ====================

async function regenerateEmbeddings(documentId?: string): Promise<{ total: number; updated: number; errors: number }> {
  try {
    if (!documentId) {
      // Without a documentId, iterate all documents
      const { documents } = await listDocuments({ limit: 1000 })
      let total = 0
      let updated = 0
      let errors = 0
      for (const doc of documents) {
        const result = await regenerateEmbeddings(doc.id)
        total += result.total
        updated += result.updated
        errors += result.errors
      }
      return { total, updated, errors }
    }

    // Get chunks for the specified document from Qdrant
    const chunks = await getChunksByDocument(documentId)
    let updated = 0
    let errors = 0

    for (const chunk of chunks) {
      try {
        const { vector, model } = await generateEmbedding(chunk.payload.content)
        if (model === 'pseudo-hash-2048') { errors++; continue }
        await upsertChunks([{ id: chunk.id, vector, payload: chunk.payload }])
        updated++
      } catch {
        errors++
      }
    }

    return { total: chunks.length, updated, errors }
  } catch (err) {
    console.error('[RegenerateEmbeddings] Error:', err instanceof Error ? err.message : String(err))
    return { total: 0, updated: 0, errors: 1 }
  }
}

// ==================== POST HANDLER ====================

export async function POST(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const action = searchParams.get('action')

    // Handle embed-regenerate via POST
    if (action === 'embed-regenerate') {
      const body = await request.json().catch(() => ({}))
      const docId = body.documentId || searchParams.get('documentId')
      const result = await regenerateEmbeddings(docId || undefined)
      return NextResponse.json(result)
    }

    const body = await request.json()
    if (!body.query) {
      return NextResponse.json({ error: 'Missing query' }, { status: 400 })
    }

    const temperature = body.options?.temperature
    const maxTokens = body.options?.maxTokens
    const agentId = body.options?.agentId
    const agentName = body.options?.agentName
    const agentProvider = body.options?.agentProvider
    const agentModel = body.options?.agentModel
    const result = await processQuery(body.query, {
      skipClassify: body.options?.skipClassify,
      vectorOnly: body.options?.vectorOnly,
      graphOnly: body.options?.graphOnly,
      skipMetaCog: body.options?.skipMetaCog,
      chatHistory: body.chatHistory,
      ...(temperature !== undefined ? { temperature } : {}),
      ...(maxTokens !== undefined ? { maxTokens } : {}),
      ...(agentId ? { agentId } : {}),
      ...(agentName ? { agentName } : {}),
      ...(agentProvider ? { agentProvider } : {}),
      ...(agentModel ? { agentModel } : {}),
    })

    return NextResponse.json(result)
  } catch (error) {
    console.error('[Query] Error:', error)
    return NextResponse.json(
      { error: 'Query processing failed', details: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    )
  }
}

// ==================== GET HANDLER ====================

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const action = searchParams.get('action')

    if (action === 'embed-status') {
      // Use Qdrant stats — all vectors in Qdrant are real embeddings
      const stats = await getQdrantStats()
      const total = stats.totalChunks
      const real = stats.vectorsIndexed
      const pseudo = 0 // No pseudo vectors in Qdrant architecture
      const realRatio = total > 0 ? real / total : 0
      return NextResponse.json({ total, real, pseudo, realRatio, hasRealEmbeddings: real > 0, dimension: 2048 })
    }

    if (action === 'stats') {
      const force = searchParams.get('force') === 'true'

      // Return cached result if available and not forced
      if (!force) {
        const cached = getStatsCache()
        if (cached) {
          console.log('[Stats] Returning cached result (age: ' + (Date.now() - cached.timestamp) + 'ms)')
          return NextResponse.json({ ...cached.data, fromCache: true })
        }
      }

      const statsStart = Date.now()

      try {
        // Phase 1: Get counts from all sources in parallel
        //
        // FIX 2026-09-10 (unit-mixing bug): Neo4j nodes and SQLite LocalEntity rows are
        // DIFFERENT units — Neo4j = deduplicated knowledge-graph nodes (1 row per concept),
        // SQLite buffer = raw per-chunk extraction mentions (1 entity mentioned in 50 chunks
        // = 50 rows). Taking Math.max() of the two mixed units made the UI display the raw
        // buffer count (e.g. 66,205 "entities" on machines restoring an append-only Supabase
        // backup) while the real graph holds ~25.9k nodes / ~49.8k relationships (healthy 1.9:1).
        // Now: Neo4j is the source of truth when reachable; SQLite buffer is a FALLBACK only
        // (fresh install before first sync) and is also exposed separately as buffer* fields.
        const [qdrantStats, neo4jEntityCount, neo4jRelCount, sqliteEntityCount, sqliteRelCount, resolvedCountResult] = await Promise.all([
          getQdrantStats(),
          // Entity count from Neo4j (-1 sentinel = Neo4j unreachable)
          (async () => {
            try {
              const result = await readCypher<{ totalEntities: unknown }>(
                'MATCH (e) RETURN count(e) AS totalEntities'
              )
              return toNum(result[0]?.totalEntities)
            } catch {
              return -1 // Neo4j unavailable — fallback to SQLite buffer below
            }
          })(),
          // Relationship count from Neo4j (-1 sentinel = Neo4j unreachable)
          (async () => {
            try {
              const result = await readCypher<{ totalRelationships: unknown }>(
                'MATCH ()-[r]->() RETURN count(r) AS totalRelationships'
              )
              return toNum(result[0]?.totalRelationships)
            } catch {
              return -1 // Neo4j unavailable — fallback to SQLite buffer below
            }
          })(),
          // Raw extraction buffer counts (pre-dedup, per-chunk mentions — NOT graph nodes)
          db.localEntity.count().catch(() => 0),
          db.localRelationship.count().catch(() => 0),
          // Resolved entities: SQLite only (local buffer)
          db.localResolvedEntity.count().catch(() => 0),
        ])

        // Neo4j is the source of truth when at least one count query succeeded.
        const neo4jReachable = neo4jEntityCount >= 0 || neo4jRelCount >= 0
        const graphEntities = neo4jReachable ? Math.max(neo4jEntityCount, 0) : sqliteEntityCount
        const graphRelationships = neo4jReachable ? Math.max(neo4jRelCount, 0) : sqliteRelCount

        const totalEntities = graphEntities
        const totalRelationships = graphRelationships
        const totalResolvedEntities = resolvedCountResult

        // Document status distribution from Qdrant
        const { documents: allDocs } = await listDocuments({ limit: 1000 })
        const documentsByStatus: Record<string, number> = {}
        for (const doc of allDocs) {
          const status = doc.payload.status
          documentsByStatus[status] = (documentsByStatus[status] || 0) + 1
        }

        // Phase 2: Distributions — Neo4j (real graph) is the source of truth when
        // reachable; SQLite buffer distribution is a fallback for fresh installs
        // before the first sync. (Old per-type Math.max mixed the two units —
        // see Phase 1 comment.)
        const [entityTypeDistribution, domainDistribution, relTypeDistribution] = await Promise.all([
          // Entity type distribution
          (async () => {
            const dist: Record<string, number> = {}
            if (neo4jReachable) {
              try {
                const result = await readCypher<{ type: string; count: unknown }>(
                  `MATCH (e)
                   WITH CASE WHEN size(labels(e)) > 1 THEN [l IN labels(e) WHERE l <> 'Entity'][0] ELSE labels(e)[0] END AS type
                   RETURN type, count(*) AS count
                   ORDER BY count DESC`
                )
                for (const r of result) dist[r.type] = toNum(r.count)
              } catch { /* fall through to SQLite */ }
            }
            if (Object.keys(dist).length === 0) {
              try {
                // groupBy computes the distribution inside SQLite (perf).
                const groups = await db.localEntity.groupBy({ by: ['entityType'], _count: { _all: true } })
                for (const g of groups) dist[g.entityType] = g._count._all
              } catch { /* ignore */ }
            }
            return dist
          })(),
          // Domain distribution
          (async () => {
            const dist: Record<string, number> = {}
            if (neo4jReachable) {
              try {
                const result = await readCypher<{ domain: string; count: unknown }>(
                  `MATCH (e) WHERE e.domain IS NOT NULL
                   RETURN e.domain AS domain, count(*) AS count
                   ORDER BY count DESC`
                )
                for (const r of result) dist[r.domain] = toNum(r.count)
              } catch { /* fall through to SQLite */ }
            }
            if (Object.keys(dist).length === 0) {
              try {
                const groups = await db.localEntity.groupBy({ by: ['domain'], _count: { _all: true } })
                for (const g of groups) {
                  if (g.domain) dist[g.domain] = g._count._all
                }
              } catch { /* ignore */ }
            }
            return dist
          })(),
          // Relationship type distribution
          (async () => {
            const dist: Record<string, number> = {}
            if (neo4jReachable) {
              try {
                const result = await readCypher<{ relType: string; count: unknown }>(
                  `MATCH ()-[r]->()
                   RETURN type(r) AS relType, count(*) AS count
                   ORDER BY count DESC`
                )
                for (const r of result) dist[r.relType] = toNum(r.count)
              } catch { /* fall through to SQLite */ }
            }
            if (Object.keys(dist).length === 0) {
              try {
                const groups = await db.localRelationship.groupBy({ by: ['relationshipType'], _count: { _all: true } })
                for (const g of groups) dist[g.relationshipType] = g._count._all
              } catch { /* ignore */ }
            }
            return dist
          })(),
        ])

        // Resolved count from SQLite (entities with resolvedEntityId)
        const resolvedCount = await db.localEntity.count({
          where: { resolvedEntityId: { not: null } },
        })

        // Orphan entity count: entities not in any relationship
        let orphanEntityCount = 0
        let entitiesInRelationships = totalEntities
        try {
          // Neo4j: count entities that have no relationships
          const orphanResult = await readCypher<{ orphanCount: unknown }>(
            'MATCH (e) WHERE NOT (e)-[]-() RETURN count(e) AS orphanCount'
          )
          orphanEntityCount = toNum(orphanResult[0]?.orphanCount)
          entitiesInRelationships = totalEntities - orphanEntityCount
        } catch {
          // Fallback: estimate from SQLite
          // VÒNG 10 FIX: trước đây findMany ALL 205k rows rồi đếm distinct bằng JS Set —
          // materialize toàn bảng vào heap mỗi lần recompute. Giờ aggregate hoàn toàn
          // trong SQLite (CTE + COUNT, index trên source/target sẵn có) — JS chỉ nhận 2 scalar.
          try {
            const rows = await db.$queryRaw<{ entitiesInRels: number | bigint; totalEntities: number | bigint }[]>`
              WITH rel_ids AS (
                SELECT sourceEntityId AS id FROM LocalRelationship WHERE sourceEntityId IS NOT NULL
                UNION
                SELECT targetEntityId FROM LocalRelationship WHERE targetEntityId IS NOT NULL
              )
              SELECT
                (SELECT COUNT(*) FROM rel_ids) AS entitiesInRels,
                (SELECT COUNT(*) FROM LocalEntity) AS totalEntities
            `
            const entitiesInRels = Number(rows[0]?.entitiesInRels ?? 0)
            const localEntityCount = Number(rows[0]?.totalEntities ?? 0)
            orphanEntityCount = Math.max(0, localEntityCount - entitiesInRels)
            entitiesInRelationships = entitiesInRels
          } catch { /* use defaults */ }
        }

        // Orphan resolved entities
        let orphanResolvedCount = 0
        try {
          const resolvedWithRels = await readCypher<{ orphanResolved: unknown }>(
            `MATCH (e) WHERE e.resolvedId IS NOT NULL AND NOT (e)-[]-()
             RETURN count(e) AS orphanResolved`
          )
          orphanResolvedCount = toNum(resolvedWithRels[0]?.orphanResolved)
        } catch {
          // Estimate: ~30% of orphans are resolved
          orphanResolvedCount = Math.round(orphanEntityCount * 0.3)
        }

        // Average confidence
        let avgConfidence = 0
        try {
          const confResult = await readCypher<{ avgConf: unknown }>(
            'MATCH (e) WHERE e.confidence IS NOT NULL RETURN avg(e.confidence) AS avgConf'
          )
          avgConfidence = toNum(confResult[0]?.avgConf)
        } catch {
          // Fallback: SQLite sample
          try {
            const sampleEntities = await db.localEntity.findMany({
              select: { confidenceScore: true },
              take: 500,
              orderBy: { createdAt: 'desc' },
            })
            if (sampleEntities.length > 0) {
              avgConfidence = sampleEntities.reduce((sum, e) => sum + e.confidenceScore, 0) / sampleEntities.length
            }
          } catch { /* use default 0 */ }
        }

        const maxPossibleRels = totalEntities > 1 ? (totalEntities * (totalEntities - 1)) / 2 : 1
        const graphDensity = totalRelationships / maxPossibleRels

        const statsDurationMs = Date.now() - statsStart
        console.log(`[Stats] Completed in ${statsDurationMs}ms — docs:${qdrantStats.totalDocuments}, entities:${totalEntities}, rels:${totalRelationships}, orphans:${orphanEntityCount}`)

        // Get daily token usage
        const dailyTokens = await getDailyTokenUsage()

        const statsResult = {
          totalDocuments: qdrantStats.totalDocuments, totalEntities, totalRelationships,
          totalResolvedEntities,
          // FIX 2026-09-10: expose the two sources separately so the UI (and the
          // owner) can distinguish real graph size from the raw extraction buffer.
          graphEntities,
          graphRelationships,
          bufferEntities: sqliteEntityCount,
          bufferRelationships: sqliteRelCount,
          knowledgeSource: neo4jReachable ? 'neo4j' : 'sqlite-buffer',
          documentsByStatus,
          entityTypeDistribution,
          domainDistribution,
          relTypeDistribution,
          avgConfidence,
          graphDensity,
          resolvedCount,
          orphanEntityCount,
          orphanResolvedCount,
          entitiesInRelationships,
          dailyTokens,
          timestamp: new Date().toISOString(),
        }

        setStatsCache(statsResult)
        return NextResponse.json({ ...statsResult, fromCache: false })
      } catch (err) {
        console.error('[Stats] Error:', err instanceof Error ? err.message : String(err))

        // Return minimal stats on error
        const dailyTokens = await getDailyTokenUsage()
        const minimalResponse = {
          totalDocuments: 0, totalEntities: 0, totalRelationships: 0,
          totalResolvedEntities: 0, documentsByStatus: {},
          entityTypeDistribution: {}, domainDistribution: {}, relTypeDistribution: {},
          avgConfidence: 0, graphDensity: 0,
          resolvedCount: 0,
          orphanEntityCount: 0,
          orphanResolvedCount: 0,
          entitiesInRelationships: 0,
          dailyTokens,
          timestamp: new Date().toISOString(),
          error: err instanceof Error ? err.message : 'Stats computation failed',
        }
        setStatsCache(minimalResponse)
        return NextResponse.json(minimalResponse)
      }
    }

    if (action === 'graph-explore') {
      const entity = searchParams.get('entity')
      if (!entity) return NextResponse.json({ error: 'Missing entity' }, { status: 400 })
      // P5-M1 (blueprint stats §P5-M1, mục #14 — MATH.pdf §PCA/§SVD): bản đồ
      // tri thức 2D — PCA top-2 (power iteration) trên embedding Neo4j của
      // entity + láng giềng (cap 500 node), cache 1h (đồ hình đổi chậm, PCA
      // trên 2048-dim × 500 node không rẻ).
      const result = await exploreEntityWithMap(entity)
      return NextResponse.json(result)
    }

    if (action === 'graph-path') {
      const from = searchParams.get('from')
      const to = searchParams.get('to')
      if (!from || !to) return NextResponse.json({ error: 'Missing from/to' }, { status: 400 })
      const paths = await findPath(from, to)
      return NextResponse.json({ paths })
    }

    // ===== Leiden community layer (user request 2026-09-05) =====
    // GET /api/query?action=community-status — trạng thái community layer
    if (action === 'community-status') {
      const { getCommunityStatus } = await import('@/lib/kb-routing/communities')
      const status = await getCommunityStatus()
      return NextResponse.json(status)
    }

    // GET /api/query?action=community-detect[&sweep=1] — chạy Leiden detection NGAY
    // (fetch entity graph Neo4j → Leiden → write communityId → embed summaries
    //  → upsert Qdrant theopus_communities). Chạy ~10-60s tùy cỡ graph.
    // Sau khi xong, mọi query Agent tự động có community context (flag
    // ENABLE_COMMUNITY_SEARCH, default true).
    // P1-M5: stats giờ kèm silhouette/gammaSwept/dbi/ch; ?sweep=1 ép γ-sweep
    // {0.5, 0.8, 1.0, 1.2, 1.5} chọn theo silhouette (bất chấp env
    // LEIDEN_AUTO_TUNE — dùng để quan sát so sánh; mặc định vẫn γ=1.0).
    if (action === 'community-detect') {
      const { detectAndStoreCommunities, detectAndStoreCommunitiesWithSweep } = await import('@/lib/kb-routing/communities')
      const forceSweep = searchParams.get('sweep') === '1'
      try {
        const stats = forceSweep
          ? await detectAndStoreCommunitiesWithSweep()
          : await detectAndStoreCommunities()
        return NextResponse.json({ ok: true, ...stats })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return NextResponse.json({ ok: false, error: msg }, { status: 500 })
      }
    }

    // GET /api/query?action=community-search&q=... — test community retrieval
    // (embed query → vector search community summaries — KHÔNG đụng LLM)
    if (action === 'community-search') {
      const q = searchParams.get('q')
      if (!q) return NextResponse.json({ error: 'Missing q' }, { status: 400 })
      const { searchCommunities } = await import('@/lib/kb-routing/communities')
      const { generateQueryEmbedding } = await import('@/lib/embeddings')
      const emb = await generateQueryEmbedding(q)
      const hits = await searchCommunities(emb.vector, 5)
      return NextResponse.json({ query: q, hits })
    }

    if (action === 'embed-regenerate') {
      const docId = searchParams.get('documentId')
      const result = await regenerateEmbeddings(docId || undefined)
      return NextResponse.json(result)
    }

    if (action === 'reconcile-orphans') {
      // ORPHAN ENTITY CLEANUP: Delete entities that have no relationships.
      // Uses Neo4j for graph-based orphan detection + SQLite for local buffer cleanup.
      console.log(`[Reconcile] Starting orphan cleanup...`)
      const reconcileStart = Date.now()

      let orphansDeleted = 0
      let selfRefsDeleted = 0
      // ROUND-23 P4 — chỉ cần SỐ LƯỢNG entity (không cần mảng id: trước đây
      // materialize toàn bộ ~176k id vào mảng chỉ để .length 2 lần ở response)
      let totalEntitiesBefore = 0
      // ROUND-24 review fix — orphan SQLite xoá ở Step 3 phải đếm RIÊNG: trước
      // đây orphansDeleted gộp cả Neo4j + SQLite rồi trừ thẳng vào
      // totalEntitiesBefore (chỉ đếm LocalEntity) → total_entities_after sai
      // sem khi 2 domain có số orphan lệch nhau.
      let localOrphansDeleted = 0

      try {
        // Step 1: Find orphan entities in Neo4j (entities with no relationships)
        // DATA-LOSS FIX 2026-08-31: previously `MATCH (e) WHERE NOT (e)-[]-()` matched
        // EVERY unconnected node — including Document nodes whose extraction found no
        // entities, and isolated entities freshly written by chat auto-learn (their
        // relationships arrive in a later step). Deleting a Document node orphaned all
        // its CONTAINS-linked entities, which then fed the ingestion pipeline's orphan
        // cleanup → cascading data loss. Now: only entity nodes, never Documents.
        const orphans = await readCypher<{ id: string; name: string }>(
          'MATCH (e) WHERE NOT (e)-[]-() AND NOT (e:Document) AND e.entity_type IS NOT NULL RETURN e.id AS id, e.name AS name'
        )
        console.log(`[Reconcile] Found ${orphans.length} orphan entities in Neo4j`)

        // Delete orphans from Neo4j in batches
        if (orphans.length > 0) {
          for (let i = 0; i < orphans.length; i += 100) {
            const batch = orphans.slice(i, i + 100)
            const ids = batch.map(o => o.id).filter(Boolean) as string[]
            if (ids.length > 0) {
              await executeCypher(
                'MATCH (e) WHERE e.id IN $ids DETACH DELETE e',
                { ids }
              )
              orphansDeleted += ids.length
            }
          }
        }

        // Step 2: Find and delete self-referencing relationships in Neo4j
        const selfRefs = await readCypher<{ id: unknown }>(
          'MATCH (a)-[r]->(a) RETURN id(r) AS id'
        )

        if (selfRefs.length > 0) {
          for (const sr of selfRefs) {
            try {
              await executeCypher(
                'MATCH ()-[r]->() WHERE id(r) = $id DELETE r',
                { id: sr.id }
              )
              selfRefsDeleted++
            } catch { /* skip individual errors */ }
          }
        }
        console.log(`[Reconcile] Neo4j: deleted ${orphansDeleted} orphans, ${selfRefsDeleted} self-refs`)

        // Step 3: Also clean up SQLite buffer
        // ROUND-23 P4 — bỏ full-table materialization: trước đây findMany TOÀN
        // BỘ ~206k relationship + ~176k entity id vào JS Set/Array → spike RAM
        // hàng chục MB mỗi lần reconcile. Giờ 2 câu SQL duy nhất: đếm tổng +
        // truy vấn thẳng id orphan (NOT EXISTS — SQLite tự xử lý trên đĩa, JS
        // chỉ giữ kết quả orphan thường nhỏ).
        const countRows = await db.$queryRaw<{ total: number | bigint }[]>`SELECT COUNT(*) AS total FROM LocalEntity`
        totalEntitiesBefore = Number((countRows as { total: number | bigint }[])[0]?.total ?? 0)

        // ROUND-24 review fix — LIMIT 50k: phòng kịch bản tồn đống orphan (sau
        // đợt sync lỗi) query trả về bảng hàng trăm nghìn id làm spike RAM đúng
        // kiểu P4 cố tránh; phần dư sẽ drain ở lần reconcile kế (mirror cách
        // sync-neo4j phân trang).
        const orphanRows = (await db.$queryRaw`SELECT e.id FROM LocalEntity e
           WHERE NOT EXISTS (
             SELECT 1 FROM LocalRelationship r
             WHERE r.sourceEntityId = e.id OR r.targetEntityId = e.id
           )
           LIMIT 50000`.catch(() => [])) as { id: string }[]
        const localOrphanIds = orphanRows.map((row: { id: string }) => row.id)

        if (localOrphanIds.length > 0) {
          const deleteResult = await db.localEntity.deleteMany({
            where: { id: { in: localOrphanIds } },
          })
          localOrphansDeleted = deleteResult.count
          orphansDeleted += deleteResult.count
          console.log(`[Reconcile] SQLite: deleted ${deleteResult.count} local orphan entities`)
        }

        // Delete self-referencing relationships in SQLite
        // ROUND-24 review fix — trước đây findMany TOÀN BỘ LocalRelationship
        // (~206k row × 3 cột) rồi lọc self-ref bằng JS — đúng kiểu materialize
        // full-table mà P4 muốn bỏ nhưng bỏ sót. Giờ 1 câu SQL duy nhất chỉ trả
        // id self-ref (thường số ít).
        const selfRefRows = (await db.$queryRaw`SELECT id FROM LocalRelationship
           WHERE sourceEntityId IS NOT NULL AND targetEntityId IS NOT NULL
             AND sourceEntityId = targetEntityId`.catch(() => [])) as { id: string }[]
        const selfRefIds = selfRefRows.map((row: { id: string }) => row.id)

        if (selfRefIds.length > 0) {
          const deleteResult = await db.localRelationship.deleteMany({
            where: { id: { in: selfRefIds } },
          })
          selfRefsDeleted += deleteResult.count
          console.log(`[Reconcile] SQLite: deleted ${deleteResult.count} self-ref relationships`)
        }
      } catch (err) {
        console.error('[Reconcile] Error:', err instanceof Error ? err.message : String(err))
      }

      const reconcileMs = Date.now() - reconcileStart
      console.log(`[Reconcile] Complete in ${reconcileMs}ms: deleted ${orphansDeleted} orphans, ${selfRefsDeleted} self-refs`)

      return NextResponse.json({
        success: true,
        duration_ms: reconcileMs,
        orphans_deleted: orphansDeleted,
        selfrefs_deleted: selfRefsDeleted,
        total_entities_before: totalEntitiesBefore,
        // ROUND-24 review fix — chỉ trừ số orphan xoá KHỎI SQLite (cùng domain
        // với totalEntitiesBefore); orphansDeleted gộp cả Neo4j không dùng ở đây.
        total_entities_after: totalEntitiesBefore - localOrphansDeleted,
      })
    }

    if (action === 'reclassify-docs') {
      // RECLASSIFY documents that are currently "mixed" domain.
      // Loads each document's text sample, runs keyword-based classification,
      // and updates the domain if a more specific domain is found.
      console.log(`[Reclassify] Starting document reclassification...`)
      const reclassifyStart = Date.now()

      // Find all documents with domain = "mixed" from Qdrant
      const { documents: mixedDocs } = await listDocuments({ domain: 'mixed', limit: 1000 })

      let reclassified = 0
      let unchanged = 0

      for (const doc of mixedDocs) {
        // Use document title as additional classification signal
        const titleLower = (doc.payload.title || '').toLowerCase()
        let titleDomain: string | null = null
        if (titleLower.includes('metacogn') || titleLower.includes('meta-cogn') || titleLower.includes('critical thinking') || titleLower.includes('clear thinking') || titleLower.includes('reasoning') || titleLower.includes('cognitive science') || titleLower.includes('philosophy')) {
          titleDomain = 'meta_cognitive'
        } else if (titleLower.includes('reinforcement learning') || titleLower.includes('neural network') || titleLower.includes('deep learning') || titleLower.includes('machine learning') || titleLower.includes('ml ') || titleLower.includes('nlp') || titleLower.includes('computer vision')) {
          titleDomain = 'ml'
        } else if (titleLower.includes('algorithm') || titleLower.includes('data structure') || titleLower.includes('sorting') || titleLower.includes('graph theor') || titleLower.includes('combinatoric') || titleLower.includes('complexity')) {
          titleDomain = 'algorithm'
        } else if (titleLower.includes('python') || titleLower.includes('javascript') || titleLower.includes('typescript') || titleLower.includes('java ') || titleLower.includes('c++') || titleLower.includes('react') || titleLower.includes('node') || titleLower.includes('web dev') || titleLower.includes('html') || titleLower.includes('graphql') || titleLower.includes('rest api') || titleLower.includes('programming') || titleLower.includes('eloquent') || titleLower.includes('sicp') || titleLower.includes('c book') || titleLower.includes('html5 game') || titleLower.includes('c_') || titleLower.includes('designing data') || titleLower.includes('designing-data') || titleLower.includes('brand identity') || titleLower.includes('interaction design') || titleLower.includes('human-computer')) {
          titleDomain = 'programming'
        } else if (titleLower.includes('linux') || titleLower.includes('docker') || titleLower.includes('kubernetes') || titleLower.includes('devops') || titleLower.includes('shell') || titleLower.includes('ubuntu') || titleLower.includes('nginx') || titleLower.includes('ansible') || titleLower.includes('site reliability') || titleLower.includes('istio') || titleLower.includes('distributed system') || titleLower.includes('microservice')) {
          titleDomain = 'linux'
        } else if (titleLower.includes('security') || titleLower.includes('hack') || titleLower.includes('penetration') || titleLower.includes('black hat') || titleLower.includes('cryptography') || titleLower.includes('cyber') || titleLower.includes('owasp') || titleLower.includes('exploit') || titleLower.includes('vulnerability') || titleLower.includes('rtfm') || titleLower.includes('red team') || titleLower.includes('boneh') || titleLower.includes('shoup') || titleLower.includes('encryption')) {
          titleDomain = 'security'
        } else if (titleLower.includes('parallel') || titleLower.includes('algoritma') || titleLower.includes('combinatoric')) {
          titleDomain = 'algorithm'
        } else if (titleLower.includes('recommender') || titleLower.includes('personalization') || titleLower.includes('handbook of jdm') || titleLower.includes('judgment') || titleLower.includes('decision making')) {
          titleDomain = 'ml'
        }

        // Title-based override — if the title clearly indicates a domain, use it
        if (titleDomain) {
          await updateDocumentStatus(doc.id, { domain: titleDomain })
          // Update chunk domains in Qdrant (fetch with vectors, then re-upsert)
          await updateChunkDomains(doc.id, titleDomain)
          // Update entity domains in SQLite
          await db.localEntity.updateMany({
            where: { documentId: doc.id },
            data: { domain: titleDomain },
          })
          console.log(`[Reclassify] "${doc.payload.title}": mixed → ${titleDomain} (title-based)`)
          reclassified++
          continue
        }

        // Get a text sample from the document's chunks
        const chunks = await getChunksByDocument(doc.id, { limit: 5 })

        if (!chunks || chunks.length === 0) {
          unchanged++
          continue
        }

        const sampleText = chunks.map(c => c.payload.content).join('\n\n').slice(0, 4000)

        // Simple keyword-based classification (same as the fallback in process route)
        const lower = sampleText.toLowerCase()
        const scores: Record<string, number> = {
          programming: 0, algorithm: 0, ml: 0, meta_cognitive: 0, linux: 0, security: 0,
        }

        // Quick keyword scoring
        const domainKeywords: Record<string, Array<[string, number]>> = {
          programming: [['function', 1], ['class ', 1], ['import ', 1], ['typescript', 2], ['javascript', 2], ['python', 1], ['react', 2], ['api', 1], ['framework', 1], ['component', 1], ['endpoint', 1.5], ['middleware', 1.5], ['rest api', 2], ['graphql', 2]],
          algorithm: [['algorithm', 2], ['complexity', 1.5], ['big o', 2], ['sorting', 1.5], ['binary tree', 2], ['dynamic programming', 2], ['greedy', 1.5], ['recursion', 1], ['hash table', 1.5], ['linked list', 2], ['dijkstra', 2], ['data structure', 2]],
          ml: [['neural network', 2], ['machine learning', 2], ['deep learning', 2], ['training', 1], ['gradient', 1.5], ['transformer', 2], ['bert', 2], ['gpt', 2], ['classification', 1], ['regression', 1.5], ['clustering', 1.5], ['overfitting', 2], ['embedding', 1], ['fine-tuning', 2], ['dataset', 1]],
          meta_cognitive: [['meta-cogni', 2], ['cognitive', 1], ['reasoning', 1], ['philosophy', 1], ['critical thinking', 2], ['epistemology', 2], ['consciousness', 1.5], ['introspection', 2], ['mental model', 2]],
          linux: [['sudo ', 2], ['systemctl', 2], ['shell script', 2], ['bash', 1], ['docker', 1], ['kubernetes', 1.5], ['nginx', 1.5], ['ssh', 1.5], ['linux', 1.5], ['ubuntu', 1.5], ['devops', 1.5], ['ci/cd', 2]],
          security: [['vulnerability', 2], ['exploit', 2], ['cve-', 2], ['cryptography', 2], ['encryption', 1.5], ['firewall', 1.5], ['malware', 2], ['phishing', 2], ['sql injection', 2], ['xss', 2], ['owasp', 2], ['penetration', 2]],
        }

        for (const [domain, keywords] of Object.entries(domainKeywords)) {
          for (const [kw, weight] of keywords) {
            if (lower.includes(kw)) scores[domain] += weight
          }
        }

        const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1])
        const [bestDomain, bestScore] = sorted[0]
        const secondBest = sorted[1]?.[1] ?? 0

        if (bestScore >= 2 && bestScore >= secondBest * 1.2) {
          await updateDocumentStatus(doc.id, { domain: bestDomain })
          // Update chunk domains in Qdrant
          await updateChunkDomains(doc.id, bestDomain)
          // Update entity domains in SQLite
          await db.localEntity.updateMany({
            where: { documentId: doc.id },
            data: { domain: bestDomain },
          })
          console.log(`[Reclassify] "${doc.payload.title}": mixed → ${bestDomain} (score: ${bestScore})`)
          reclassified++
        } else {
          unchanged++
        }
      }

      const reclassifyMs = Date.now() - reclassifyStart
      console.log(`[Reclassify] Complete in ${reclassifyMs}ms: ${reclassified} reclassified, ${unchanged} unchanged`)

      return NextResponse.json({
        success: true,
        duration_ms: reclassifyMs,
        reclassified,
        unchanged,
        total_mixed: mixedDocs.length,
      })
    }

    // Default: service status
    return NextResponse.json({
      service: 'query-api',
      status: 'running',
      architecture: 'SQLite (buffer) → Qdrant (vector+document) + Neo4j (graph)',
      endpoints: {
        query: 'POST /api/query',
        embedStatus: 'GET /api/query?action=embed-status',
        stats: 'GET /api/query?action=stats',
        graphExplore: 'GET /api/query?action=graph-explore&entity=...',
        graphPath: 'GET /api/query?action=graph-path&from=...&to=...',
      },
    })
  } catch (error) {
    console.error('[Query] GET error:', error)
    return NextResponse.json({ error: 'Query service error' }, { status: 500 })
  }
}

// ==================== HELPER: UPDATE CHUNK DOMAINS IN QDRANT ====================

/**
 * Update the domain field in all chunks for a document.
 *
 * ROUND-32 P2-b: setPayload THEO FILTER (atomic server-side) — thay thế bản
 * cũ scroll 1 trang limit:1000 (doc >1000 chunk bị bỏ sót im lặng) + đọc toàn
 * vector 2048-d về RAM rồi re-upsert (read-modify-write + cửa sổ race).
 * Server tự áp cho mọi point khớp filter document_id, không giới hạn trang,
 * không chạm vector, merge field (các payload khác giữ nguyên).
 */
async function updateChunkDomains(documentId: string, newDomain: string): Promise<void> {
  try {
    const ok = await setChunkPayloadByDocument(documentId, { domain: newDomain })
    if (!ok) console.error(`[UpdateChunkDomains] setChunkPayloadByDocument failed cho doc ${documentId.slice(0, 8)}...`)
  } catch (err) {
    console.error('[UpdateChunkDomains] Error:', err instanceof Error ? err.message : String(err))
  }
}
