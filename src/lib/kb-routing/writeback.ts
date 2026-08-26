/**
 * Smart KB Routing — Layer 3: Writeback (Auto-Learning Loop)
 *
 * When Step 2 (Model Knowledge) provides information that Step 1 (User KB) lacked,
 * extract entities/relationships from the answer and write them back to:
 *   1. Qdrant (theopus_chunks — as new vector chunks)
 *   2. Neo4j (graph nodes + edges)
 *   3. AgentMemory (episodic memory)
 *
 * Writeback policy: ONLY writeback when extracted entity confidence > 0.5
 * (user-approved option c — filters out LLM hallucinations).
 *
 * Phase 4 of design doc.
 */

import { db } from '@/lib/db'
import { qdrant, COLLECTION_CHUNKS } from '@/lib/qdrant'
import { upsertChunks } from '@/lib/qdrant'
import { upsertEntitiesBatch, upsertRelationshipsBatch, type EntityNode, type RelationshipEdge } from '@/lib/neo4j'
import { storeMemory } from '@/lib/agent-memory'
import { generateEmbedding, getCurrentEmbeddingModelVersion } from '@/lib/embeddings'
import { callLLM } from '@/lib/llm'
import { resolveEntityByNameAndEmbedding } from '@/lib/ingestion/entity-resolver'
import type { UserKBResult, ModelKnowledgeResult } from './kb-access'

// ==================== CONFIG ====================

/**
 * Writeback confidence threshold — only extract + write entities/relationships
 * that the LLM marks with confidence > this value.
 * User-approved value: 0.5 (option c — filters hallucinations).
 */
export const WRITEBACK_CONFIDENCE_THRESHOLD = 0.5

/**
 * Gray-zone lower bound (user request 2026-08-27: "chỉ khi không chắc chắn nên
 * hay không thì mới phải cần hỏi tôi"). Items with confidence in
 * (ASK_MIN, WRITEBACK_CONFIDENCE_THRESHOLD] là những tri thức Agent KHÔNG CHẮC
 * — thay vì bỏ mặc như trước đây, chúng được xếp vào hàng chờ PHÊ DUYỆT để
 * user quyết định (tab Auto-Learn → "Kiến thức chờ phê duyệt").
 * Mặc định mọi tri thức thiếu (conf > 0.5) vẫn tự ghi vào KB.
 */
export const WRITEBACK_ASK_MIN_CONFIDENCE = 0.3

/**
 * Maximum entities to writeback per query (safety cap to avoid KB bloat).
 */
const MAX_WRITEBACK_ENTITIES = 10
const MAX_WRITEBACK_RELATIONSHIPS = 15

// ==================== TYPES ====================

export interface ExtractedEntityWithConfidence {
  name: string
  type: string
  description: string
  confidence: number  // 0-1 — LLM's confidence this is a real entity
  source: string  // 'model-knowledge'
}

export interface ExtractedRelationshipWithConfidence {
  source: string
  target: string
  type: string
  description: string
  confidence: number  // 0-1 — LLM's confidence this relationship is real
}

export interface WritebackResult {
  skipped: boolean
  reason?: string
  entitiesWritten: number
  relationshipsWritten: number
  chunksWritten: number
  memoryStored: boolean
  /** Tri thức vùng xám (0.3 < conf ≤ 0.5) — chờ user phê duyệt, KHÔNG tự ghi */
  grayZone?: {
    entities: ExtractedEntityWithConfidence[]
    relationships: ExtractedRelationshipWithConfidence[]
  }
}

// ==================== EXTRACTION PROMPT ====================

const WRITEBACK_EXTRACTION_PROMPT = `You are a knowledge extraction system. Analyze the following LLM answer and extract entities + relationships that should be written back to the knowledge base.

ANSWER TO ANALYZE:
{answer}

CONTEXT (what the user KB already had — DO NOT re-extract these):
{context}

Extract in JSON format:
{
  "entities": [
    {
      "name": "Entity Name",
      "type": "Concept|Technology|Framework|Vulnerability|Principle|Domain|Document|Person",
      "description": "Brief description (1-2 sentences)",
      "confidence": 0.0-1.0
    }
  ],
  "relationships": [
    {
      "source": "Entity A name",
      "target": "Entity B name",
      "type": "PART_OF|IMPLEMENTED_IN|USES|EXPLOITS|MITIGATES|RUNS_ON|DEPENDS_ON|CONTRASTS_WITH|ENABLES|CONTAINS|EXTENDS|APPLIES_TO|CREATED_BY|DOCUMENTED_IN|ALTERNATIVE_TO",
      "description": "Brief description",
      "confidence": 0.0-1.0
    }
  ]
}

ENTITY TYPES (with examples):
- Concept: abstract idea OR algorithm/technique — "Encapsulation", "Quick Sort", "TDD"
- Technology: tool/platform/runtime — "Docker", "Linux", "AWS"
- Framework: software framework/library — "Next.js", "React", "PyTorch"
- Vulnerability: security flaw — "SQL Injection", "XSS"
- Principle: rule/practice — "DRY", "SOLID"
- Domain: knowledge area — "Cybersecurity", "DevOps"
- Document: source PDF
- Person: human author/creator — "Linus Torvalds"

RULES:
1. ONLY extract entities/relationships that are NEW (not already in the context above)
2. Confidence: 0.9+ = explicitly stated as fact, 0.7-0.9 = strongly implied, 0.5-0.7 = inferred, <0.5 = speculation
3. DO NOT extract speculative or uncertain information (confidence < 0.5)
4. Extract at most 10 entities + 15 relationships (most important first)
5. Return ONLY valid JSON, no markdown, no explanation`

// ==================== MAIN ENTRY ====================

/**
 * Decide whether to writeback, extract knowledge from Step 2 answer,
 * and write to all 3 KB stores (Qdrant + Neo4j + AgentMemory).
 *
 * Writeback policy (user-approved option c):
 *   - Skip if Step 2 was not invoked
 *   - Skip if no entities extracted
 *   - Filter: only write entities/relationships with confidence > 0.5
 */
export async function writebackToKB(params: {
  query: string
  step2Result: ModelKnowledgeResult
  step1Result: UserKBResult
  agentId?: string
  agentName?: string
  sessionId?: string
}): Promise<WritebackResult> {
  const { query, step2Result, step1Result, agentId, agentName, sessionId } = params

  // Gate 1: Step 2 must have been invoked
  if (!step2Result.used || !step2Result.content.trim()) {
    return {
      skipped: true,
      reason: 'Step 2 not invoked or empty answer',
      entitiesWritten: 0,
      relationshipsWritten: 0,
      chunksWritten: 0,
      memoryStored: false,
    }
  }

  // Gate 2: Step 2 must have supplemented Step 1
  if (!step2Result.supplemented) {
    return {
      skipped: true,
      reason: 'Step 2 did not supplement Step 1',
      entitiesWritten: 0,
      relationshipsWritten: 0,
      chunksWritten: 0,
      memoryStored: false,
    }
  }

  console.log(`[Writeback] Step 2 supplemented Step 1 — extracting new knowledge for writeback`)

  // Extract entities/relationships with confidence scores
  const extracted = await extractWithConfidence(step2Result.content, step1Result)

  if (!extracted) {
    return {
      skipped: true,
      reason: 'Extraction failed or returned nothing',
      entitiesWritten: 0,
      relationshipsWritten: 0,
      chunksWritten: 0,
      memoryStored: false,
    }
  }

  // Partition (user request 2026-08-27):
  //   conf > 0.5               → auto-write vào KB (mặc định: tri thức thiếu thì cập nhật)
  //   0.3 < conf ≤ 0.5         → gray-zone: xếp hàng chờ PHÊ DUYỆT (Agent không chắc → hỏi user)
  //   conf ≤ 0.3               → speculation → bỏ (không học rác)
  const filteredEntities = extracted.entities
    .filter(e => e.confidence > WRITEBACK_CONFIDENCE_THRESHOLD)
    .slice(0, MAX_WRITEBACK_ENTITIES)

  const filteredRelationships = extracted.relationships
    .filter(r => r.confidence > WRITEBACK_CONFIDENCE_THRESHOLD)
    .slice(0, MAX_WRITEBACK_RELATIONSHIPS)

  const grayEntities = extracted.entities
    .filter(e => e.confidence > WRITEBACK_ASK_MIN_CONFIDENCE && e.confidence <= WRITEBACK_CONFIDENCE_THRESHOLD)
    .slice(0, MAX_WRITEBACK_ENTITIES)

  const grayRelationships = extracted.relationships
    .filter(r => r.confidence > WRITEBACK_ASK_MIN_CONFIDENCE && r.confidence <= WRITEBACK_CONFIDENCE_THRESHOLD)
    .slice(0, MAX_WRITEBACK_RELATIONSHIPS)

  console.log(`[Writeback] Extracted: ${extracted.entities.length} entities, ${extracted.relationships.length} relationships. Auto-write (> ${WRITEBACK_CONFIDENCE_THRESHOLD}): ${filteredEntities.length} entities, ${filteredRelationships.length} relationships. Gray-zone (${WRITEBACK_ASK_MIN_CONFIDENCE}-${WRITEBACK_CONFIDENCE_THRESHOLD}] cần phê duyệt: ${grayEntities.length} entities, ${grayRelationships.length} relationships.`)

  if (filteredEntities.length === 0 && filteredRelationships.length === 0) {
    // Không có gì auto-write — nhưng gray-zone items VẪN trả về để wrapper queue phê duyệt
    return {
      skipped: true,
      reason: `No entities/relationships passed confidence threshold ${WRITEBACK_CONFIDENCE_THRESHOLD}`,
      entitiesWritten: 0,
      relationshipsWritten: 0,
      chunksWritten: 0,
      memoryStored: false,
      grayZone: (grayEntities.length > 0 || grayRelationships.length > 0)
        ? { entities: grayEntities, relationships: grayRelationships }
        : undefined,
    }
  }

  // Generate synthetic document ID for this writeback batch
  const documentId = `auto-learn:${Date.now()}`

  // WRITE 1 + 2 + 4 (Qdrant chunks + Neo4j entities/rels + Learning records)
  const writeCounts = await writeKnowledgeToStores(documentId, query, filteredEntities, filteredRelationships, {
    agentId,
    agentName,
    sessionId,
    sourceTag: 'auto-learn',
  })

  let memoryStored = false

  // === WRITE 3: AgentMemory (episodic) ===
  if (agentId && step2Result.content) {
    try {
      await storeMemory({
        agentId,
        agentName: agentName || 'unknown',
        sessionId,
        category: 'insight',
        content: `[Auto-learned from model knowledge] ${step2Result.content.slice(0, 500)}`,
        context: query,
        importance: 0.5,  // Medium — auto-learned, not user-confirmed
        source: 'auto-learn',
        tags: ['writeback', 'model-knowledge'],
      })
      memoryStored = true
      console.log(`[Writeback] Stored AgentMemory`)
    } catch (err) {
      console.warn('[Writeback] AgentMemory write failed:', err instanceof Error ? err.message : String(err))
    }
  }

  // === WRITE 4: moved into writeKnowledgeToStores (shared with review-approve path) ===

  return {
    skipped: false,
    entitiesWritten: writeCounts.entitiesWritten,
    relationshipsWritten: writeCounts.relationshipsWritten,
    chunksWritten: writeCounts.chunksWritten,
    memoryStored,
    grayZone: (grayEntities.length > 0 || grayRelationships.length > 0)
      ? { entities: grayEntities, relationships: grayRelationships }
      : undefined,
  }
}

// ==================== SHARED STORE WRITES (WRITE 1 + 2 + 4) ====================

/**
 * Ghi entities/relationships vào 3 store (Qdrant chunks + Neo4j graph +
 * AgentInsight/LearningLog audit). Được dùng bởi:
 *   1. writebackToKB — auto-write các item conf > 0.5 (mặc định)
 *   2. applyReviewedWriteback — ghi các item gray-zone SAU KHI user phê duyệt
 * (user request 2026-08-27)
 */
async function writeKnowledgeToStores(
  documentId: string,
  query: string,
  entities: ExtractedEntityWithConfidence[],
  relationships: ExtractedRelationshipWithConfidence[],
  ctx: { agentId?: string; agentName?: string; sessionId?: string; sourceTag: string }
): Promise<{ chunksWritten: number; entitiesWritten: number; relationshipsWritten: number }> {
  const now = new Date().toISOString()
  const { agentId, agentName, sessionId, sourceTag } = ctx
  let entitiesWritten = 0
  let relationshipsWritten = 0
  let chunksWritten = 0

  // === WRITE 1: Qdrant chunks (embed entity descriptions) ===
  if (entities.length > 0) {
    try {
      // Phase 3 SMOLAB Prop 4.1 — query the active embedding model version ONCE
      // before the Promise.all map (so it's 1 DB query, not N). The helper
      // caches the result for 5 min in embeddings.ts, so subsequent writeback
      // calls within 5 min don't re-query the DB at all.
      const embeddingModelVersion = await getCurrentEmbeddingModelVersion()

      const chunksToWrite = entities.map((e, i) => {
        const text = `${e.name} (${e.type}): ${e.description}`
        // Phase 6 SMOLAB Prop 3 — construct payload matching ChunkPayload interface
        // (qdrant.ts:587-606). Old code used camelCase keys (documentId, text, etc.)
        // which failed the type check at upsertChunks(). Now uses snake_case keys.
        return {
          id: '',
          vector: [] as number[],
          payload: {
            document_id: documentId,
            chunk_index: i,
            content: text,
            domain: 'auto-learn',
            created_at: now,
            // Auto-learn metadata (optional fields on ChunkPayload)
            auto_learned: true,
            agent_name: agentName || 'unknown',
            original_query: query.slice(0, 200),
            confidence: e.confidence,
            llm_provider: sourceTag,
            llm_model: sourceTag,
            // Phase 3 SMOLAB Prop 4.1 — model version tag for drift detection
            embedding_model_version: embeddingModelVersion,
          } as import('@/lib/qdrant').ChunkPayload,
        }
      })

      // Generate embeddings for all chunks
      const embeddedChunks = await Promise.all(
        chunksToWrite.map(async (c) => {
          const { vector } = await generateEmbedding(c.payload.content)
          return {
            id: crypto.randomUUID(),
            vector,
            payload: c.payload,
          }
        })
      )

      // Phase 6 SMOLAB P0.1 — filter out chunks with empty vectors (all providers failed)
      const validChunks = embeddedChunks.filter(c => c.vector.length > 0)
      if (validChunks.length === 0) {
        console.warn('[Writeback] All chunk embeddings failed — skipping Qdrant write (no pseudo-hash fallback)')
      } else {
        const success = await upsertChunks(validChunks)
        if (success) {
          chunksWritten = validChunks.length
          console.log(`[Writeback] Wrote ${chunksWritten} chunks to Qdrant`)
        }
      }
    } catch (err) {
      console.warn('[Writeback] Qdrant write failed:', err instanceof Error ? err.message : String(err))
    }
  }

  // === WRITE 2: Neo4j entities + relationships ===
  if (entities.length > 0) {
    try {
      const entityNodes: EntityNode[] = entities.map((e, i) => ({
        id: `${sourceTag}-${Date.now()}-${i}`,
        name: e.name,
        entity_type: e.type as EntityNode['entity_type'],
        domain: 'mixed',
        description: e.description,
        confidence: e.confidence,  // Lower confidence for auto-learned
        documentId,
        source: sourceTag,
        chunk_id: '',
        created_at: now,
        updated_at: now,
      }))

      // Phase 2 SMOLAB Prop 2.5 — Embedding-based entity resolution BEFORE the
      // Neo4j upsert. For each entity, generate embedding + query Neo4j for
      // nearest same-label entity via vector.similarity.cosine(). If match
      // found (raw cosine > 0.85 → Neo4j normalized score > 0.925): replace
      // the auto-generated id with the existing Neo4j node id so MERGE in
      // upsertEntitiesBatch increments occurrence_count instead of duplicating
      // the node. New entities are persisted with the embedding attached so
      // subsequent writebacks can find them via vector search.
      // Fail-safe: per-entity try/catch inside the helper — if embedding
      // resolution fails (NVIDIA down, Neo4j unreachable), the entity is
      // persisted as-is (no embedding) and the next writeback can still find
      // it via the existing Levenshtein fuzzy match path during PDF ingest.
      const resolvedEntityNodes = await resolveEntitiesForWriteback(entityNodes)

      await upsertEntitiesBatch(resolvedEntityNodes, documentId)
      entitiesWritten = resolvedEntityNodes.length
      console.log(`[Writeback] Wrote ${entitiesWritten} entities to Neo4j (after embedding resolution)`)
    } catch (err) {
      console.warn('[Writeback] Neo4j entity write failed:', err instanceof Error ? err.message : String(err))
    }
  }

  if (relationships.length > 0) {
    try {
      // Build edge payloads — note: sourceId/targetId must match existing entity IDs
      // For writeback, we link by entity name (Neo4j MERGE on name)
      const edges: RelationshipEdge[] = relationships.map((r) => ({
        sourceId: `${sourceTag}-by-name:${r.source}`,
        targetId: `${sourceTag}-by-name:${r.target}`,
        relationship_type: r.type,
        description: r.description,
        confidence: r.confidence,
        documentId,
        source: sourceTag,
        created_at: now,
      }))

      await upsertRelationshipsBatch(edges, documentId)
      relationshipsWritten = edges.length
      console.log(`[Writeback] Wrote ${relationshipsWritten} relationships to Neo4j`)
    } catch (err) {
      console.warn('[Writeback] Neo4j relationship write failed:', err instanceof Error ? err.message : String(err))
    }
  }

  // === WRITE 4: AgentInsight + LearningLog (Learning tab visibility) ===
  // FIX (empty Learning tab): writeback replaced autoLearnFromAnswer, but nothing
  // wrote to AgentInsight/LearningLog anymore — the Learning tab timeline only
  // got data from manual teaching and 👍/👎 feedback. Record each successful
  // writeback as an insight + log so the Learning timeline reflects real chat
  // activity. Two cheap SQLite writes — NO extra LLM call.
  if (entities.length > 0 || relationships.length > 0) {
    try {
      const insightContent = `[KB writeback] ${entities.length} entities, ${relationships.length} relationships — query: "${query.slice(0, 120)}"`
      await db.agentInsight.create({
        data: {
          agentId: agentId || 'default',
          content: insightContent,
          source: 'auto',
          type: 'factual',
          confidence: 0.6,
        },
      })
      await db.learningLog.create({
        data: {
          agentId: agentId || 'default',
          sessionId: sessionId || null,
          eventType: 'pattern',
          content: JSON.stringify({
            kind: 'kb-writeback',
            entitiesWritten: entities.length,
            relationshipsWritten: relationships.length,
            chunksWritten,
            query: query.slice(0, 300),
            agentName: agentName || 'unknown',
          }),
          metadata: JSON.stringify({ source: 'writeback' }),
        },
      })
      console.log(`[Writeback] Recorded AgentInsight + LearningLog (Learning tab)`)
    } catch (err) {
      console.warn('[Writeback] Learning record failed:', err instanceof Error ? err.message : String(err))
    }
  }

  return { chunksWritten, entitiesWritten, relationshipsWritten }
}

// ==================== REVIEW-APPROVED WRITEBACK (gray-zone) ====================

/**
 * Ghi các tri thức gray-zone (0.3 < conf ≤ 0.5) mà user đã PHÊ DUYỆT vào KB.
 * Dùng cùng writeKnowledgeToStores như auto-write — ghi Qdrant + Neo4j + audit.
 * (user request 2026-08-27: "chỉ khi không chắc chắn nên hay không thì mới
 * phải cần hỏi tôi" — phê duyệt xong là ghi như thường.)
 */
export async function applyReviewedWriteback(params: {
  batchId: string
  query: string
  entities: ExtractedEntityWithConfidence[]
  relationships: ExtractedRelationshipWithConfidence[]
  agentId?: string
  agentName?: string
  sessionId?: string
}): Promise<{ entitiesWritten: number; relationshipsWritten: number; chunksWritten: number }> {
  const documentId = `review-approved:${params.batchId.slice(0, 8)}:${Date.now()}`
  console.log(`[Writeback-Review] Applying approved batch ${params.batchId.slice(0, 8)}: ${params.entities.length} entities, ${params.relationships.length} relationships`)
  const counts = await writeKnowledgeToStores(documentId, params.query, params.entities, params.relationships, {
    agentId: params.agentId,
    agentName: params.agentName,
    sessionId: params.sessionId,
    sourceTag: 'review-approved',
  })
  return counts
}

// ==================== LLM EXTRACTION WITH CONFIDENCE ====================

async function extractWithConfidence(
  answer: string,
  step1Result: UserKBResult
): Promise<{ entities: ExtractedEntityWithConfidence[]; relationships: ExtractedRelationshipWithConfidence[] } | null> {
  // Build context summary so LLM doesn't re-extract what we already have
  const contextSummary = [
    step1Result.chunks.length > 0 ? `${step1Result.chunks.length} chunks: ${step1Result.chunks.map(c => c.text.slice(0, 100)).join(' | ')}` : '(no chunks)',
    step1Result.entities.length > 0 ? `${step1Result.entities.length} entities: ${step1Result.entities.map(e => e.name).join(', ')}` : '(no entities)',
  ].join('\n')

  const prompt = WRITEBACK_EXTRACTION_PROMPT
    .replace('{answer}', answer.slice(0, 3000))
    .replace('{context}', contextSummary.slice(0, 1000))

  try {
    const result = await callLLM(prompt, undefined, 'writeback-extraction', {
      temperature: 0.1,
      maxTokens: 2000,
    })

    if (!result.content) return null

    // Try multiple extraction strategies — LLMs sometimes return malformed JSON
    let parsed: any = null
    const jsonMatch = result.content.match(/\{[\s\S]*\}/)
    if (jsonMatch) {
      try {
        parsed = JSON.parse(jsonMatch[0])
      } catch {
        // Try fixing common JSON issues (trailing commas, missing brackets)
        try {
          const cleaned = jsonMatch[0]
            .replace(/,\s*}/g, '}')   // trailing comma in object
            .replace(/,\s*\]/g, ']')  // trailing comma in array
          parsed = JSON.parse(cleaned)
        } catch {
          // Last resort: try to extract just the entities array
          const entMatch = result.content.match(/"entities"\s*:\s*\[([\s\S]*?)\]/)
          const relMatch = result.content.match(/"relationships"\s*:\s*\[([\s\S]*?)\]/)
          if (entMatch) {
            try {
              parsed = { entities: JSON.parse(`[${entMatch[1]}]`), relationships: [] }
            } catch {
              console.warn('[Writeback] Could not parse LLM JSON response')
              return null
            }
          }
        }
      }
    }
    if (!parsed) return null

    const entities: ExtractedEntityWithConfidence[] = (Array.isArray(parsed.entities) ? parsed.entities : [])
      .filter((e: any) => e?.name && typeof e.name === 'string')
      .map((e: any) => ({
        name: String(e.name).trim(),
        type: String(e.type || 'Concept').trim(),
        description: String(e.description || '').trim(),
        confidence: Math.min(1, Math.max(0, Number(e.confidence) || 0)),
        source: 'model-knowledge',
      }))

    const relationships: ExtractedRelationshipWithConfidence[] = (Array.isArray(parsed.relationships) ? parsed.relationships : [])
      .filter((r: any) => r?.source && r?.target)
      .map((r: any) => ({
        source: String(r.source).trim(),
        target: String(r.target).trim(),
        type: String(r.type || 'RELATED_TO').trim(),
        description: String(r.description || '').trim(),
        confidence: Math.min(1, Math.max(0, Number(r.confidence) || 0)),
      }))

    return { entities, relationships }
  } catch (err) {
    console.warn('[Writeback] Extraction LLM call failed:', err instanceof Error ? err.message : String(err))
    return null
  }
}

// ==================== EMBEDDING-BASED ENTITY RESOLUTION (Prop 2.5) ====================

/**
 * Resolve entities against the existing Neo4j knowledge graph by embedding similarity
 * BEFORE the upsertEntitiesBatch call. For each input entity node:
 *   - Generate embedding from `${name}: ${description}` (skip if all providers fail).
 *   - Query Neo4j for nearest same-label entity via vector.similarity.cosine().
 *   - If match found (raw cosine > 0.85 → Neo4j normalized score > 0.925):
 *     replace the entity id with the existing Neo4j node id so the MERGE in
 *     upsertEntitiesBatch increments occurrence_count instead of creating a
 *     duplicate node.
 *   - If no match: keep the auto-generated id, attach the embedding to the
 *     EntityNode so upsertEntitiesBatch writes n.embedding on the node.
 *
 * Concurrency-limited to 3 parallel embedding API calls (out of caution for
 * NVIDIA 160 RPM shared budget — writeback batches max at 10 entities, so
 * even fully-parallel would be ~10 calls × 1 writeback per chat = trivial).
 *
 * Failure isolation: per-entity try/catch — one bad apple doesn't poison the
 * whole batch. Failures fall through to "create new node" with no embedding.
 */
export async function resolveEntitiesForWriteback(
  entityNodes: EntityNode[]
): Promise<EntityNode[]> {
  if (entityNodes.length === 0) return entityNodes

  const resolved: EntityNode[] = new Array(entityNodes.length)

  // Process in chunks of 3 to stay well under NVIDIA's 160 RPM budget
  const CONCURRENCY = 3
  for (let i = 0; i < entityNodes.length; i += CONCURRENCY) {
    const chunk = entityNodes.slice(i, i + CONCURRENCY)
    const chunkResults = await Promise.all(
      chunk.map(async (node) => {
        try {
          const result = await resolveEntityByNameAndEmbedding({
            name: node.name,
            description: node.description,
            type: node.entity_type,
          })

          if (result.method === 'embedding' && !result.isNew && result.matched) {
            console.log(
              `[Writeback] Entity "${node.name}" → merged into existing ${node.entity_type} "${result.matched.name}" (id=${result.matched.id.slice(0, 8)}, score=${result.matched.score.toFixed(3)})`
            )
          } else if (result.method === 'embedding' && result.isNew) {
            console.log(
              `[Writeback] Entity "${node.name}" → NEW ${node.entity_type} (id=${result.id.slice(0, 8)}, embedding dim=${result.embedding.length})`
            )
          } else {
            console.warn(
              `[Writeback] Entity "${node.name}" → embedding generation failed, persisting without embedding`
            )
          }

          // Replace the auto-generated id with the resolved id (merge or new)
          // and attach the embedding vector to the EntityNode payload so
          // upsertEntitiesBatch writes n.embedding on the Neo4j node.
          const embedding: number[] | undefined =
            result.embedding.length > 0 ? result.embedding : undefined
          return {
            ...node,
            id: result.id,
            embedding,
          } as EntityNode
        } catch (err) {
          // Per-entity isolation: log + fall through with the original node
          console.warn(
            `[Writeback] Embedding resolution failed for entity "${node.name}":`,
            err instanceof Error ? err.message : String(err)
          )
          return node
        }
      })
    )
    for (let k = 0; k < chunkResults.length; k++) {
      resolved[i + k] = chunkResults[k] as EntityNode
    }
  }

  return resolved
}
