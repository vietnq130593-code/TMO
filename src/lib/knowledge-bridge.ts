/**
 * Knowledge Bridge Library
 *
 * Connects OpenClaw Agents to the local Knowledge Base (Qdrant + Neo4j + SQLite).
 * Provides search, graph query, and write capabilities for agents.
 *
 * Uses NVIDIA nemotron-3-embed-1b (2048-dim) for embedding queries.
 */

import { db } from '@/lib/db'
import { generateQueryEmbedding } from '@/lib/embeddings'
import {
  searchSimilar,
  getDocument,
  qdrant as qdrantClient,
  COLLECTION_CHUNKS,
} from '@/lib/qdrant'

// ==================== KNOWLEDGE SEARCH ====================

export interface KnowledgeSearchResult {
  type: 'chunk' | 'entity' | 'relationship'
  content: string
  source?: string
  entityName?: string
  entityType?: string
  score?: number
  relationshipType?: string
  sourceEntity?: string
  targetEntity?: string
}

/**
 * Chẩn đoán lý do Knowledge Search trả về 0 kết quả — bug fix 2026-09-06
 * (user report: "Agents báo truy vấn knowledge base nhưng kết quả là 0,
 * không nhận được gì"). Trước đây MỌI lỗi kỹ thuật (Qdrant chết / embedding
 * API lỗi / KB rỗng / fetch loopback fail) đều bị nuốt âm thầm trả về
 * {results: []} → agent chỉ biết "0 kết quả" mà không nói được TẠI SAO.
 */
export interface KnowledgeSearchDiagnostics {
  ok: boolean
  /** Lý do 0 kết quả (khi ok=false hoặc results rỗng) */
  reason?: 'embedding_failed' | 'qdrant_unreachable' | 'kb_empty' | 'no_match' | 'error' | 'ok'
  /** Mô tả tiếng Việt — agent đọc trực tiếp để báo cho user */
  message?: string
  embeddingModel?: string
  qdrantReachable?: boolean
  totalChunks?: number
  minScoreUsed?: number
  durationMs?: number
}

/**
 * Tìm kiếm semantic Knowledge Base — ROUND-37 V5: PARITY STACK VỚI CHAT.
 *
 * Rà soát lượt 3 (round-36): agent dùng `knowledge_search` nhận stack YẾU HƠN
 * đường chat — dense-only (threshold 0.2, retry 0.1) trong khi chat (kb-access
 * searchUserKB) chạy full pipeline: dense over-fetch topK×4 + hybrid BM25+RRF
 * fusion (ENABLE_HYBRID_SEARCH) + MMR diversity rerank (ENABLE_MMR) + semantic
 * entity search 8 label Neo4j + Leiden communities. Giờ HAI đường DÙNG CHUNG
 * MỘT pipeline — agent thấy đúng những gì chat thấy:
 *
 *   1. searchUserKB(query, agentId, {topK}) — chunks (hybrid+MMR) + entities
 *      (semantic Neo4j) + memories + communities + confidence
 *   2. expandGraph=true → quan hệ 1-hop của top entities (Neo4j) → kết quả
 *      type 'relationship' (trước đây option khai báo nhưng chết)
 *   3. 0 kết quả → chẩn đoán lý do THẬT (giữ nguyên diagnostics shape —
 *      backward-compatible với tool-executor + openclaw tools route)
 *   4. Fallback: kb-routing lỗi thật sự → rơi về dense-only cũ (defence)
 */
export async function agentKnowledgeSearch(query: string, options?: {
  topK?: number
  expandGraph?: boolean
  domain?: string
}): Promise<{ results: KnowledgeSearchResult[]; answer?: string; diagnostics?: KnowledgeSearchDiagnostics }> {
  const startTime = Date.now()
  const topK = Math.min(Math.max(options?.topK ?? 5, 1), 20)

  try {
    // ── STACK CHAT (parity V5): searchUserKB = hybrid + MMR + entity + communities ──
    try {
      const { searchUserKB } = await import('@/lib/kb-routing/kb-access')
      const kb = await searchUserKB(query, undefined, { topK })

      // Map kết quả về shape KnowledgeSearchResult (giữ nguyên contract)
      const results: KnowledgeSearchResult[] = []
      for (const chunk of kb.chunks) {
        results.push({
          type: 'chunk',
          content: chunk.text,
          source: chunk.source,
          score: chunk.denseScore ?? chunk.score, // denseScore = cosine thật (score là fused rank)
        })
      }
      for (const entity of kb.entities) {
        results.push({
          type: 'entity',
          content: entity.description || entity.name,
          entityName: entity.name,
          entityType: entity.type,
          score: undefined,
        })
      }

      // expandGraph (V5 — sống lại): 1-hop relationships của top entities
      if (options?.expandGraph && kb.entities.length > 0) {
        try {
          const topEntityNames = kb.entities.slice(0, 3).map(e => e.name)
          const { agentGraphQuery } = await import('@/lib/knowledge-bridge')
          const cypher = `MATCH (a)-[r]->(b) WHERE a.name IN $names RETURN type(r) AS relType, a.name AS source, b.name AS target LIMIT 15`
          const graph = await agentGraphQuery(cypher, { names: topEntityNames })
          for (const rec of (graph.records ?? []).slice(0, 10)) {
            const r = rec as Record<string, unknown>
            results.push({
              type: 'relationship',
              content: `${String(r.source)} —[${String(r.relType)}]→ ${String(r.target)}`,
              relationshipType: String(r.relType ?? ''),
              sourceEntity: String(r.source ?? ''),
              targetEntity: String(r.target ?? ''),
            })
          }
        } catch { /* fail-open — expandGraph bổ trợ, không bắt buộc */ }
      }

      if (results.length > 0) {
        return {
          results,
          diagnostics: {
            ok: true, reason: 'ok', qdrantReachable: true,
            totalChunks: kb.chunks.length,
            durationMs: Date.now() - startTime,
          },
        }
      }
      // searchUserKB trả rỗng → chẩn đoán tiếp phía dưới (embedding/qdrant/kb_empty)
    } catch (kbErr) {
      // kb-routing lỗi (Qdrant chết chưa kịp bắt...) → fallback dense-only cũ
      console.warn('[Knowledge Bridge] searchUserKB pipeline failed — fallback dense-only:', kbErr instanceof Error ? kbErr.message : String(kbErr))
    }

    // ── FALLBACK: dense-only cũ (defence-in-depth khi kb-routing không chạy được) ──
    // 1. Query embedding — trực tiếp, không qua HTTP loopback
    const { vector, model } = await generateQueryEmbedding(query)
    if (!vector || vector.length === 0) {
      return {
        results: [],
        diagnostics: {
          ok: false,
          reason: 'embedding_failed',
          embeddingModel: model,
          durationMs: Date.now() - startTime,
          message: 'Không tạo được vector embedding cho truy vấn (NVIDIA/OpenRouter embedding API đều lỗi — kiểm tra NVIDIA_API_KEY_*, mạng, hoặc rate-limit).',
        },
      }
    }

    // 2. Vector search Qdrant — threshold 0.2, retry 0.1
    let hits = await searchSimilar(vector, { limit: topK, minScore: 0.2, domain: options?.domain })
    let minScoreUsed = 0.2
    if (hits.length === 0) {
      hits = await searchSimilar(vector, { limit: topK, minScore: 0.1, domain: options?.domain })
      minScoreUsed = 0.1
    }

    // 3. 0 kết quả → chẩn đoán lý do THẬT (không còn nuốt âm thầm)
    if (hits.length === 0) {
      try {
        await qdrantClient.getCollections() // reachable?
        const info = await qdrantClient.getCollection(COLLECTION_CHUNKS)
        const totalChunks = info.points_count ?? 0
        if (totalChunks === 0) {
          return {
            results: [],
            diagnostics: {
              ok: false, reason: 'kb_empty', qdrantReachable: true, totalChunks: 0,
              embeddingModel: model, minScoreUsed, durationMs: Date.now() - startTime,
              message: 'Knowledge Base đang RỖNG (0 chunks trong Qdrant). Hãy upload tài liệu vào Knowledge Base rồi thử lại.',
            },
          }
        }
        return {
          results: [],
          diagnostics: {
            ok: true, reason: 'no_match', qdrantReachable: true, totalChunks,
            embeddingModel: model, minScoreUsed, durationMs: Date.now() - startTime,
            message: `Đã tìm trong ${totalChunks} chunks của Knowledge Base nhưng không nội dung nào khớp truy vấn (score < ${minScoreUsed}).`,
          },
        }
      } catch (qErr) {
        return {
          results: [],
          diagnostics: {
            ok: false, reason: 'qdrant_unreachable', qdrantReachable: false,
            embeddingModel: model, minScoreUsed, durationMs: Date.now() - startTime,
            message: `Không kết nối được Qdrant server (${qErr instanceof Error ? qErr.message : String(qErr)}). Kiểm tra Qdrant đang chạy (mặc định port 6333) và QDRANT_URL trong .env.`,
          },
        }
      }
    }

    // 4. Kết quả có sẵn → kèm tiêu đề tài liệu
    const docIds = [...new Set(hits.map(h => h.payload?.document_id).filter((x): x is string => !!x))]
    const docMap = new Map<string, { title: string; domain: string }>()
    for (const docId of docIds) {
      try {
        const doc = await getDocument(docId)
        if (doc) docMap.set(docId, { title: doc.title, domain: doc.domain })
      } catch { /* skip missing docs */ }
    }

    const results: KnowledgeSearchResult[] = hits.map(h => ({
      type: 'chunk' as const,
      content: String(h.payload?.content || ''),
      source: docMap.get(String(h.payload?.document_id))?.title || 'Unknown',
      score: h.score,
    }))

    return {
      results,
      diagnostics: {
        ok: true, reason: 'ok', qdrantReachable: true,
        embeddingModel: model, minScoreUsed,
        durationMs: Date.now() - startTime,
      },
    }
  } catch (err) {
    console.error('[Knowledge Bridge] Search error:', err)
    return {
      results: [],
      diagnostics: {
        ok: false, reason: 'error', durationMs: Date.now() - startTime,
        message: `Knowledge search lỗi: ${err instanceof Error ? err.message : String(err)}`,
      },
    }
  }
}

// ==================== GRAPH QUERY ====================

export async function agentGraphQuery(cypher: string, params?: Record<string, unknown>) {
  // Safety: only allow read queries
  const normalized = cypher.trim().toUpperCase()
  if (normalized.startsWith('CREATE') || normalized.startsWith('DELETE') || normalized.startsWith('DROP') || normalized.startsWith('REMOVE') || normalized.startsWith('SET')) {
    throw new Error('Only MATCH queries are allowed for agent graph queries')
  }

  try {
    const { safeSession, toNative } = await import('@/lib/neo4j')
    let session: import('neo4j-driver').Session | null = null
    try {
      session = await safeSession()
    } catch {
      return { records: [], count: 0, error: 'Neo4j driver not available' }
    }
    try {
      const result = await session.run(cypher, params || {})
      const records = result.records.slice(0, 100).map(record => {
        const obj: Record<string, unknown> = {}
        for (const key of record.keys as string[]) {
          obj[key] = toNative(record.get(key))
        }
        return obj
      })
      return { records, count: records.length }
    } finally {
      await session?.close().catch(() => {})
    }
  } catch (err) {
    console.error('[Knowledge Bridge] Graph query error:', err)
    return { records: [], count: 0, error: err instanceof Error ? err.message : String(err) }
  }
}

// ==================== KNOWLEDGE WRITE ====================

export async function agentWriteEntity(data: {
  entityName: string
  entityType: string
  description: string
  domain: string
  properties?: Record<string, unknown>
}) {
  // Write to SQLite buffer (LocalEntity) — will be synced to Neo4j later
  const entity = await db.localEntity.create({
    data: {
      entityName: data.entityName,
      entityType: data.entityType,
      description: data.description,
      domain: data.domain,
      properties: data.properties ? JSON.stringify(data.properties) : null,
      source: 'agent',
      synced: false,
    },
  })
  return { id: entity.id, entityName: entity.entityName }
}

export async function agentWriteRelationship(data: {
  sourceEntityName: string
  targetEntityName: string
  relationshipType: string
  description: string
}) {
  // Find source and target entities
  const source = await db.localEntity.findFirst({ where: { entityName: data.sourceEntityName } })
  const target = await db.localEntity.findFirst({ where: { entityName: data.targetEntityName } })

  const relationship = await db.localRelationship.create({
    data: {
      sourceEntityId: source?.id || null,
      targetEntityId: target?.id || null,
      sourceEntityName: data.sourceEntityName,
      targetEntityName: data.targetEntityName,
      relationshipType: data.relationshipType,
      description: data.description,
      source: 'agent',
      synced: false,
    },
  })
  return { id: relationship.id, type: relationship.relationshipType }
}

// ==================== SYSTEM PROMPT GENERATION ====================

export async function generateSystemPromptContext(): Promise<string> {
  const parts: string[] = []

  // Prisma schema summary
  const modelNames = ['JobQueue', 'DailyTokenUsage', 'DailyTokenByProvider', 'DailyTokenByProviderSlot', 'DailyTokenByProviderModel', 'LocalEntity', 'LocalRelationship', 'LocalResolvedEntity', 'AgentProfile', 'AgentSession', 'LearningLog', 'AgentInsight', 'AgentCorrection', 'AgentPreference', 'AgentSkill', 'ToolPermission', 'KnowledgeAccessPolicy', 'CronJob', 'Webhook', 'StandingOrder', 'TaskExecution', 'ChannelConfig', 'OpenCodeSession', 'MCPBridgeConfig']
  parts.push(`SQLite Models: ${modelNames.join(', ')}`)

  // Neo4j info
  try {
    const { safeSession } = await import('@/lib/neo4j')
    let session: import('neo4j-driver').Session | null = null
    try {
      session = await safeSession()
    } catch {
      parts.push('Neo4j: Not connected')
      parts.push(`Qdrant Collections: theopus_documents, theopus_chunks (2048-dim vectors)`)
      parts.push(`Embedding Model: nvidia/nemotron-3-embed-1b (2048-dim)`)
      return parts.join('\n')
    }
    try {
      const labelsResult = await session.run('CALL db.labels()')
      const labels = labelsResult.records.map(r => r.get(0))
      parts.push(`Neo4j Node Labels: ${labels.join(', ')}`)

      const relResult = await session.run('CALL db.relationshipTypes()')
      const relTypes = relResult.records.map(r => r.get(0))
      parts.push(`Neo4j Relationship Types: ${relTypes.join(', ')}`)

      const countResult = await session.run('MATCH (n) RETURN count(n) as count')
      const nodeCount = countResult.records[0]?.get('count')?.toNumber() || 0
      parts.push(`Neo4j Total Nodes: ${nodeCount}`)
    } finally {
      await session?.close().catch(() => {})
    }
  } catch {
    parts.push('Neo4j: Not connected')
  }

  // Qdrant info
  parts.push(`Qdrant Collections: theopus_documents, theopus_chunks (2048-dim vectors)`)
  parts.push(`Embedding Model: nvidia/nemotron-3-embed-1b (2048-dim)`)

  return parts.join('\n')
}

// ==================== SCHEMA INFO ====================

export async function getSchemaInfo() {
  const schema: {
    prisma: { models: string[] }
    neo4j: { labels: string[]; relationshipTypes: string[]; nodeCount: number; relationshipCount: number }
    qdrant: { collections: Array<{ name: string; vectorSize: number }>; embeddingModel: string }
  } = {
    prisma: { models: ['JobQueue', 'DailyTokenUsage', 'DailyTokenByProvider', 'DailyTokenByProviderSlot', 'DailyTokenByProviderModel', 'LocalEntity', 'LocalRelationship', 'LocalResolvedEntity', 'AgentProfile', 'AgentSession', 'LearningLog', 'AgentInsight', 'AgentCorrection', 'AgentPreference', 'AgentSkill', 'ToolPermission', 'KnowledgeAccessPolicy', 'CronJob', 'Webhook', 'StandingOrder', 'TaskExecution', 'ChannelConfig', 'OpenCodeSession', 'MCPBridgeConfig'] },
    neo4j: { labels: [], relationshipTypes: [], nodeCount: 0, relationshipCount: 0 },
    qdrant: { collections: [{ name: 'theopus_documents', vectorSize: 2048 }, { name: 'theopus_chunks', vectorSize: 2048 }], embeddingModel: 'nvidia/nemotron-3-embed-1b' },
  }

  try {
    const { safeSession } = await import('@/lib/neo4j')
    let session: import('neo4j-driver').Session | null = null
    try {
      session = await safeSession()
    } catch {
      return schema
    }
    try {
      const labelsResult = await session.run('CALL db.labels()')
      schema.neo4j.labels = labelsResult.records.map(r => r.get(0) as string)

      const relResult = await session.run('CALL db.relationshipTypes()')
      schema.neo4j.relationshipTypes = relResult.records.map(r => r.get(0) as string)

      const countResult = await session.run('MATCH (n) RETURN count(n) as nodes, 0 as rels')
      schema.neo4j.nodeCount = countResult.records[0]?.get('nodes')?.toNumber() || 0

      const relCountResult = await session.run('MATCH ()-[r]->() RETURN count(r) as rels')
      schema.neo4j.relationshipCount = relCountResult.records[0]?.get('rels')?.toNumber() || 0
    } finally {
      await session?.close().catch(() => {})
    }
  } catch {}

  return schema
}
