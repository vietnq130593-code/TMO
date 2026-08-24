/**
 * Smart KB Routing — Layer 2: 2-Step KB Access
 *
 * Step 1: User Knowledge Base (Qdrant vector + Neo4j graph + Agent memory)
 *         Returns chunks + entities + memories + confidence score (0-1)
 *
 * Step 2: Model Training Knowledge (LLM's pre-trained data)
 *         Only invoked when Step 1 confidence < CONFIDENCE_THRESHOLD
 *         (user approved threshold = 0.5)
 *
 * Phase 4 of design doc.
 */

import { qdrant, COLLECTION_CHUNKS } from '@/lib/qdrant'
import { searchEntities, type EntityNode } from '@/lib/neo4j'
import { recallMemories, ensureAgentMemoryCollection } from '@/lib/agent-memory'
import { generateQueryEmbedding } from '@/lib/embeddings'
import { callLLM } from '@/lib/llm'

// ==================== CONFIG ====================

/**
 * Confidence threshold: if Step 1 confidence < this, run Step 2.
 * User-approved value: 0.5 (option b).
 */
export const CONFIDENCE_THRESHOLD = 0.5

// ==================== TYPES ====================

export interface UserKBResult {
  chunks: Array<{
    id: string
    text: string
    score: number
    documentId?: string
    source?: string
  }>
  entities: Array<{
    id: string
    name: string
    type: string
    description: string
    domain: string
  }>
  memories: Array<{
    id: string
    content: string
    category: string
    importance: number
    relevance: number
  }>
  confidence: number  // 0-1 — how relevant the KB content is
  source: 'user-kb'
}

export interface ModelKnowledgeResult {
  used: boolean  // whether Step 2 was invoked
  content: string  // LLM's pre-trained knowledge answer
  supplemented: boolean  // true if Step 2 added info Step 1 lacked
  source: 'model-knowledge'
}

export interface KBAccessResult {
  step1: UserKBResult
  step2: ModelKnowledgeResult
  totalDurationMs: number
}

// ==================== STEP 1: USER KB SEARCH ====================

/**
 * Search all 3 user KB sources:
 *   1. Qdrant vector search (theopus_chunks collection)
 *   2. Neo4j graph entity search
 *   3. AgentMemory recall
 *
 * Returns combined result + confidence score.
 */
export async function searchUserKB(
  query: string,
  agentId?: string,
  options: { topK?: number; minImportance?: number } = {}
): Promise<UserKBResult> {
  const topK = options.topK ?? 5
  const minImportance = options.minImportance ?? 0.3
  const startTime = Date.now()

  // Run 3 searches in parallel for speed
  const [chunksResult, entitiesResult, memoriesResult] = await Promise.allSettled([
    searchChunks(query, topK),
    agentId ? searchEntitiesForUser(agentId, query, topK) : Promise.resolve([]),
    agentId ? recallAgentMemories(agentId, query, topK, minImportance) : Promise.resolve([]),
  ])

  const chunks = chunksResult.status === 'fulfilled' ? chunksResult.value : []
  const entities = entitiesResult.status === 'fulfilled' ? entitiesResult.value : []
  const memories = memoriesResult.status === 'fulfilled' ? memoriesResult.value : []

  const confidence = calculateConfidence(chunks, entities, memories)
  const durationMs = Date.now() - startTime
  console.log(`[KB-Access] Step 1 user KB: ${chunks.length} chunks, ${entities.length} entities, ${memories.length} memories, confidence=${confidence.toFixed(2)} (${durationMs}ms)`)

  return {
    chunks,
    entities,
    memories,
    confidence,
    source: 'user-kb',
  }
}

async function searchChunks(query: string, topK: number): Promise<UserKBResult['chunks']> {
  try {
    const { vector } = await generateQueryEmbedding(query)
    // Phase 6 SMOLAB P0.1: empty vector = all providers failed, no pseudo-hash.
    // Skip Qdrant search entirely → falls back to entity/memory search only.
    if (!vector || vector.length === 0) {
      console.warn('[KB-Access] Query embedding unavailable — skipping vector search (no pseudo-hash fallback)')
      return []
    }
    // Phase 6 SMOLAB Prop 4 — qdrant.search() removed in v1.19.0. Use qdrant.query().
    const results = await qdrant.query(COLLECTION_CHUNKS, {
      query: vector,
      limit: topK,
      with_payload: true,
      score_threshold: 0.3,
    })
    return results.points.map(r => ({
      id: String(r.id),
      text: (r.payload?.text as string) || (r.payload?.content as string) || '',
      score: r.score,
      documentId: r.payload?.documentId as string | undefined || r.payload?.document_id as string | undefined,
      source: r.payload?.source as string | undefined,
    }))
  } catch (err) {
    console.warn('[KB-Access] Chunk search failed:', err instanceof Error ? err.message : String(err))
    return []
  }
}

async function searchEntitiesForUser(agentId: string, query: string, topK: number): Promise<UserKBResult['entities']> {
  try {
    // searchEntities from neo4j.ts — search by name CONTAINS
    const results = await searchEntities(query, { limit: Math.floor(topK) })
    return results.map((e: EntityNode) => ({
      id: e.id,
      name: e.name,
      type: e.entity_type,
      description: e.description,
      domain: e.domain,
    }))
  } catch (err) {
    console.warn('[KB-Access] Entity search failed:', err instanceof Error ? err.message : String(err))
    return []
  }
}

async function recallAgentMemories(agentId: string, query: string, topK: number, minImportance: number) {
  try {
    await ensureAgentMemoryCollection().catch(() => {})
    return await recallMemories({
      agentId,
      query,
      topK,
      minImportance,
    })
  } catch (err) {
    console.warn('[KB-Access] Memory recall failed:', err instanceof Error ? err.message : String(err))
    return []
  }
}

/**
 * Calculate confidence score (0-1) based on KB search results.
 *
 * Heuristics:
 *   - Chunks: weight by avg score (cosine sim 0-1, normalized)
 *   - Entities: count × 0.1 (capped at 0.4)
 *   - Memories: count × 0.1 (capped at 0.3)
 *   - Total capped at 1.0
 */
function calculateConfidence(
  chunks: UserKBResult['chunks'],
  entities: UserKBResult['entities'],
  memories: UserKBResult['memories']
): number {
  let score = 0

  // Chunks: avg cosine similarity (0.3-1.0 range, normalize to 0-1)
  if (chunks.length > 0) {
    const avgScore = chunks.reduce((sum, c) => sum + c.score, 0) / chunks.length
    const normalizedScore = Math.max(0, (avgScore - 0.3) / 0.7) // 0.3→0, 1.0→1
    score += normalizedScore * 0.5 // chunks weight: 50%
  }

  // Entities: 0.1 each, capped at 0.3
  score += Math.min(0.3, entities.length * 0.1)

  // Memories: 0.1 each, capped at 0.2
  score += Math.min(0.2, memories.length * 0.1)

  return Math.min(1.0, score)
}

// ==================== STEP 2: MODEL KNOWLEDGE ====================

/**
 * Ask the LLM to answer using ONLY its pre-trained training knowledge.
 * Used when Step 1 confidence < CONFIDENCE_THRESHOLD (0.5).
 *
 * The prompt explicitly tells the model NOT to use any user documents,
 * and to mark facts as coming from training knowledge.
 */
export async function searchModelKnowledge(
  query: string,
  userKBResult: UserKBResult
): Promise<ModelKnowledgeResult> {
  // Skip if Step 1 already has enough info
  if (userKBResult.confidence >= CONFIDENCE_THRESHOLD) {
    console.log(`[KB-Access] Step 2 skipped (Step 1 confidence ${userKBResult.confidence.toFixed(2)} >= ${CONFIDENCE_THRESHOLD})`)
    return {
      used: false,
      content: '',
      supplemented: false,
      source: 'model-knowledge',
    }
  }

  console.log(`[KB-Access] Step 2 invoked (Step 1 confidence ${userKBResult.confidence.toFixed(2)} < ${CONFIDENCE_THRESHOLD})`)

  const userKBContext = formatUserKBForPrompt(userKBResult)

  const prompt = `You are answering a question using ONLY your pre-trained training knowledge.
Do NOT invent information from "user documents" — those are listed below for context but may be incomplete or empty.

USER KNOWLEDGE BASE (Step 1 — may be incomplete):
${userKBContext || '(no relevant user KB content found)'}

USER QUERY:
${query}

INSTRUCTIONS:
1. Answer the query based on YOUR TRAINING KNOWLEDGE only.
2. If user KB already contains the answer, acknowledge it and ADD complementary details from your training.
3. If user KB is empty or insufficient, answer fully from your training knowledge.
4. Be factual. If you don't know, say so.
5. Mark facts with [Training] so we know the source.
6. If user KB contradicts your training, prefer user KB (domain-specific) and note the discrepancy.`

  try {
    const result = await callLLM(prompt, undefined, 'model-knowledge', {
      temperature: 0.3,
      maxTokens: 2000,
    })

    return {
      used: true,
      content: result.content || '',
      supplemented: true, // Step 2 always supplements when invoked
      source: 'model-knowledge',
    }
  } catch (err) {
    console.error('[KB-Access] Step 2 LLM call failed:', err instanceof Error ? err.message : String(err))
    return {
      used: false,
      content: '',
      supplemented: false,
      source: 'model-knowledge',
    }
  }
}

function formatUserKBForPrompt(result: UserKBResult): string {
  const parts: string[] = []

  if (result.chunks.length > 0) {
    parts.push('--- Document chunks ---')
    parts.push(result.chunks.map(c => `[score=${c.score.toFixed(2)}] ${c.text.slice(0, 500)}`).join('\n'))
  }

  if (result.entities.length > 0) {
    parts.push('--- Known entities ---')
    parts.push(result.entities.map(e => `- ${e.name} (${e.type}): ${e.description.slice(0, 200)}`).join('\n'))
  }

  if (result.memories.length > 0) {
    parts.push('--- Past memories ---')
    parts.push(result.memories.map(m => `- ${m.content.slice(0, 200)}`).join('\n'))
  }

  return parts.join('\n\n')
}

// ==================== MAIN ENTRY ====================

/**
 * Run the full 2-step KB access flow.
 * Returns combined result from both steps + timing.
 */
export async function accessKnowledgeBase(
  query: string,
  agentId?: string,
  options: { topK?: number; minImportance?: number } = {}
): Promise<KBAccessResult> {
  const startTime = Date.now()

  // Step 1: User KB
  const step1 = await searchUserKB(query, agentId, options)

  // Step 2: Model knowledge (only if Step 1 confidence < threshold)
  const step2 = await searchModelKnowledge(query, step1)

  const totalDurationMs = Date.now() - startTime
  console.log(`[KB-Access] Total: ${totalDurationMs}ms (Step 1 confidence=${step1.confidence.toFixed(2)}, Step 2 used=${step2.used})`)

  return {
    step1,
    step2,
    totalDurationMs,
  }
}
