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
 *
 * Phase 4 SMOLAB retrieval-quality suite (Task B):
 *   - Prop 3.7: hybrid BM25+RRF fusion in searchChunks (ENABLE_HYBRID_SEARCH)
 *   - Prop 3.8: MMR diversity rerank in searchChunks (ENABLE_MMR)
 *   - Prop 3.6: external cross-encoder rerank in searchChunks (ENABLE_RERANKER)
 *   - Prop 3.11: semantic entity search in searchEntitiesForUser
 *               (ENABLE_SEMANTIC_ENTITY_SEARCH, lexical fallback intact)
 *   - Prop 3.5 apply: calibrated confidence via getCalibratedConfidence()
 *               (sigmoid logistic regression — falls back to raw when untrained)
 *   - Prop 3.9 (Task C): searchUserKB/searchChunks accept an `embeddingOverride`
 *               (HyDE — search dense space with the hypothetical-answer embedding
 *               while hybrid BM25 still uses the rewritten query TEXT)
 */

import { qdrant, COLLECTION_CHUNKS } from '@/lib/qdrant'
import { searchEntities, readCypher, ENTITY_LABELS } from '@/lib/neo4j'
import { recallMemories, ensureAgentMemoryCollection } from '@/lib/agent-memory'
import { generateQueryEmbedding, getCurrentEmbeddingModelVersion } from '@/lib/embeddings'
import { callLLM } from '@/lib/llm'
import { isFlagEnabled } from '@/lib/feature-flags'
import { getCalibratedConfidence } from '@/lib/calibration'
import { mmrSelect } from '@/lib/kb-routing/mmr'
import { hybridFuse } from '@/lib/kb-routing/hybrid'
import { rerankTopK } from '@/lib/kb-routing/reranker'

// ==================== CONFIG ====================

/**
 * Confidence threshold: if Step 1 confidence < this, run Step 2.
 * User-approved value: 0.5 (option b).
 */
export const CONFIDENCE_THRESHOLD = 0.5

// ==================== PHASE 4 SMOLAB RETRIEVAL CONFIG ====================

/**
 * Prop 3.11 — Semantic entity search score threshold.
 *
 * Neo4j vector indexes return NORMALIZED cosine similarity
 * (1 + raw_cosine) / 2 ∈ [0, 1] — NOT the raw cosine Qdrant uses.
 * 0.7 normalized ≈ 0.4 raw cosine. Deliberately looser than the chunk
 * threshold (0.3 raw cosine) because entity matches are name+description
 * level (short texts embed noisier than full chunks) and the lexical search
 * runs in parallel anyway — low-precision semantic hits are harmless.
 */
const ENTITY_SEMANTIC_THRESHOLD = 0.7

/** Prop 3.11 — Vector neighbors to fetch per entity label (8 labels → up to 24 raw hits before merge). */
const ENTITY_SEMANTIC_TOP_PER_LABEL = 3

/** Prop 3.8 — MMR λ (relevance weight). 0.7 = relevance-prioritized with mild diversity penalty. */
const MMR_LAMBDA = 0.7

/** Prop 3.7/3.6 — Dense over-fetch factor: fetch topK×4 candidates so the fusion/rerank stages have a pool to select from. */
const DENSE_CANDIDATE_FACTOR = 4

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
 * Phase 3 SMOLAB Prop 4.1 — Drift check.
 * Samples 10 random Qdrant points + compares their embedding_model_version
 * payload against the current active version. If any mismatch → log warning +
 * return drifted=true so callers can show a "KB needs re-embed" alert.
 *
 * Non-blocking: never throws, never blocks searchUserKB. Drift is for
 * monitoring, not for blocking the query. If Qdrant is down or empty, returns
 * drifted=false (fail-open) so normal search proceeds + logs its own errors.
 *
 * Returns:
 *   - drifted=false, sampledCount=0   → empty KB OR drift check failed (fail-open)
 *   - drifted=false, sampledCount=N    → all sampled chunks match current version (or pre-4.1 chunks missing the field — backfill needed)
 *   - drifted=true, sampledCount=N     → at least one sampled chunk uses an older version (NVIDIA silently updated weights)
 */
async function checkModelDrift(): Promise<{
  drifted: boolean
  sampledCount: number
  oldestVersion?: string
  currentVersion?: string
}> {
  try {
    const currentVersion = await getCurrentEmbeddingModelVersion()

    // Use scroll (NOT search — Phase 6 Prop 4 migrated search→query, but
    // scroll is separate and is the correct API for "give me N random points
    // with payload, no vector similarity required").
    const sample = await qdrant.scroll(COLLECTION_CHUNKS, {
      limit: 10,
      with_payload: true,
      with_vector: false,
    })

    if (!sample?.points || sample.points.length === 0) {
      return { drifted: false, sampledCount: 0 } // empty KB
    }

    const versions = sample.points
      .map(p => (p.payload as Record<string, unknown> | null)?.embedding_model_version as string | undefined)
      .filter((v): v is string => Boolean(v))

    if (versions.length === 0) {
      // Pre-Prop 4.1 chunks (no version field) → not drift but flag for backfill
      console.warn(
        '[KB-Access] Sampled chunks have no embedding_model_version field — run scripts/reembed-all.ts to backfill'
      )
      return { drifted: false, sampledCount: sample.points.length, currentVersion }
    }

    const hasOldVersion = versions.some(v => v !== currentVersion)
    if (hasOldVersion) {
      const oldest = versions.find(v => v !== currentVersion)
      console.warn(
        `[KB-Access] Embedding model drift detected — some vectors use old version (oldest: ${oldest}, current: ${currentVersion})`
      )
      return {
        drifted: true,
        sampledCount: sample.points.length,
        oldestVersion: oldest,
        currentVersion,
      }
    }

    return { drifted: false, sampledCount: sample.points.length, currentVersion }
  } catch (err) {
    console.warn('[KB-Access] Drift check failed:', err instanceof Error ? err.message : String(err))
    return { drifted: false, sampledCount: 0 } // fail-open
  }
}

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
  options: {
    topK?: number
    minImportance?: number
    /** Prop 3.9 — HyDE: search with a pre-computed embedding (of a hypothetical
     *  answer) instead of embedding the raw query text. The TEXT query is still
     *  used for hybrid BM25 + reranking — only the dense VECTOR is overridden. */
    embeddingOverride?: number[]
  } = {}
): Promise<UserKBResult> {
  const topK = options.topK ?? 5
  const minImportance = options.minImportance ?? 0.3
  const startTime = Date.now()

  // Phase 3 SMOLAB Prop 4.1 — drift check (fire-and-forget before the parallel
  // searches, but we don't await it — we don't want to block the query on the
  // drift check. If drift is detected, it logs a warning + the sampled chunks
  // info appears in dev.log. The query proceeds against the (possibly degraded)
  // vectors. Callers can read dev.log to discover drift, or a future endpoint
  // can expose drift status to the UI.)
  checkModelDrift().catch((err) => {
    console.warn(
      '[KB-Access] checkModelDrift() threw uncaught error (non-blocking):',
      err instanceof Error ? err.message : String(err)
    )
  })

  // Run 3 searches in parallel for speed
  const [chunksResult, entitiesResult, memoriesResult] = await Promise.allSettled([
    searchChunks(query, topK, options.embeddingOverride),
    agentId ? searchEntitiesForUser(agentId, query, topK) : Promise.resolve([]),
    agentId ? recallAgentMemories(agentId, query, topK, minImportance) : Promise.resolve([]),
  ])

  const chunks = chunksResult.status === 'fulfilled' ? chunksResult.value : []
  const entities = entitiesResult.status === 'fulfilled' ? entitiesResult.value : []
  const memories = memoriesResult.status === 'fulfilled' ? memoriesResult.value : []

  // Phase 4 SMOLAB Prop 3.5 apply — calibrate the raw heuristic confidence with
  // the trained logistic-regression model (scripts/train-calibration.ts →
  // CalibrationModel row). Falls back to the raw value when no model is trained
  // or sampleSize < 20 → zero behavior change until the user trains.
  const rawConfidence = calculateRawConfidence(chunks, entities, memories)
  const confidence = await getCalibratedConfidence(rawConfidence)
  const durationMs = Date.now() - startTime
  const calibratedNote = confidence !== rawConfidence ? ` (calibrated from raw: ${rawConfidence.toFixed(2)})` : ''
  console.log(`[KB-Access] Step 1 user KB: ${chunks.length} chunks, ${entities.length} entities, ${memories.length} memories, confidence=${confidence.toFixed(2)}${calibratedNote} (${durationMs}ms)`)

  return {
    chunks,
    entities,
    memories,
    confidence,
    source: 'user-kb',
  }
}

/** Internal pipeline candidate — carries the pre-fetched Qdrant vector between stages (stripped before return). */
interface PipelineCandidate {
  id: string
  text: string
  score: number
  documentId?: string
  source?: string
  vector?: number[]
}

async function searchChunks(
  query: string,
  topK: number,
  /** Prop 3.9 — HyDE: pre-computed query vector (e.g. embedding of the hypothetical
   *  answer). When provided + non-empty, generateQueryEmbedding() is skipped and
   *  this vector is used for the dense search. The TEXT query still drives hybrid
   *  BM25 + reranking (unchanged) — only the vector comes from the override. */
  embeddingOverride?: number[]
): Promise<UserKBResult['chunks']> {
  const pipelineStart = Date.now()
  try {
    // Prop 3.9 — HyDE vector override: prefer the caller-supplied embedding
    // (hypothetical answer) over embedding the raw query text here.
    const vector: number[] =
      embeddingOverride && embeddingOverride.length > 0
        ? embeddingOverride
        : (await generateQueryEmbedding(query)).vector
    // Phase 6 SMOLAB P0.1: empty vector = all providers failed, no pseudo-hash.
    // Skip Qdrant search entirely → falls back to entity/memory search only.
    if (!vector || vector.length === 0) {
      console.warn('[KB-Access] Query embedding unavailable — skipping vector search (no pseudo-hash fallback)')
      return []
    }
    // Phase 6 SMOLAB Prop 4 — qdrant.search() removed in v1.19.0. Use qdrant.query().
    // Phase 4 SMOLAB Task B — retrieval pipeline:
    //   1. Dense over-fetch (topK×4 candidates, WITH vectors for MMR — no re-embed).
    //   2. Prop 3.7 hybrid BM25+RRF fusion (flag: ENABLE_HYBRID_SEARCH).
    //   3. Prop 3.8 MMR diversity rerank   (flag: ENABLE_MMR).
    //   4. Prop 3.6 cross-encoder rerank   (flag: ENABLE_RERANKER — external service).
    //   5. Slice topK + strip vectors (UserKBResult['chunks'] shape unchanged).
    const results = await qdrant.query(COLLECTION_CHUNKS, {
      query: vector,
      limit: topK * DENSE_CANDIDATE_FACTOR,
      with_payload: true,
      with_vector: true, // Prop 3.8 — MMR consumes pre-fetched vectors (avoids re-embedding every candidate)
      score_threshold: 0.3,
    })

    let candidates: PipelineCandidate[] = results.points.map(r => {
      // Point.vector is number[] | number[][] | Record<string, number[]> | SparseVector
      // (named-vector collections return objects). Only a plain number[] is usable
      // for MMR — anything else degrades gracefully to vector-less candidates.
      const raw = r.vector
      const vec = Array.isArray(raw) && raw.length > 0 && typeof raw[0] === 'number'
        ? (raw as number[])
        : undefined
      return {
        id: String(r.id),
        text: (r.payload?.text as string) || (r.payload?.content as string) || '',
        score: r.score,
        documentId: r.payload?.documentId as string | undefined || r.payload?.document_id as string | undefined,
        source: r.payload?.source as string | undefined,
        vector: vec,
      }
    })

    const denseCount = candidates.length
    let hybridApplied = false
    let mmrApplied = false
    let rerankApplied = false

    // ---- Prop 3.7: hybrid BM25+RRF fusion (order + normalized fused score) ----
    if (denseCount > 1 && isFlagEnabled('ENABLE_HYBRID_SEARCH')) {
      const fused = hybridFuse(query, candidates.map(c => ({ id: c.id, text: c.text, score: c.score })))
      // hybridFuse returns fresh objects (fused order + normalized rrf score) —
      // merge back so documentId/source/vector metadata survives.
      const byId = new Map(candidates.map(c => [c.id, c]))
      candidates = fused
        .map(f => {
          const orig = byId.get(f.id)
          return orig ? { ...orig, score: f.score } : null
        })
        .filter((c): c is PipelineCandidate => c !== null)
      hybridApplied = true
    }

    // ---- Prop 3.8: MMR diversity rerank (uses pre-fetched vectors, no re-embed) ----
    if (candidates.length > 1 && isFlagEnabled('ENABLE_MMR')) {
      candidates = mmrSelect(vector, candidates, topK, MMR_LAMBDA)
      mmrApplied = true
    }

    // ---- Prop 3.6: external cross-encoder rerank (null on ANY failure → keep order) ----
    if (candidates.length > 1 && isFlagEnabled('ENABLE_RERANKER')) {
      const order = await rerankTopK(query, candidates.map(c => c.text))
      if (order) {
        const pool = [...candidates]
        const reranked = order.map(i => pool[i]).filter((c): c is PipelineCandidate => Boolean(c))
        if (reranked.length > 0) {
          candidates = reranked
          rerankApplied = true
        }
      }
    }

    // ---- Slice topK + strip vectors (no vector field leak in the public shape) ----
    const final = candidates.slice(0, topK)
    console.log(
      `[KB-Access] Chunk pipeline: dense=${denseCount} → hybrid=${hybridApplied ? 'Y' : 'N'} → mmr=${mmrApplied ? 'Y' : 'N'} → rerank=${rerankApplied ? 'Y' : 'N'} → final=${final.length} (${Date.now() - pipelineStart}ms)`
    )
    return final.map(({ id, text, score, documentId, source }) => ({
      id,
      text,
      score,
      documentId,
      source,
    }))
  } catch (err) {
    console.warn('[KB-Access] Chunk search failed:', err instanceof Error ? err.message : String(err))
    return []
  }
}

/**
 * Phase 4 SMOLAB Prop 3.11 — semantic entity search via the per-label Neo4j
 * vector indexes (entity_embedding_<label>, created by initializeNeo4jSchema
 * in Phase 2 Prop 2.5; HNSW-accelerated via db.index.vector.queryNodes).
 *
 * Queries the query embedding against all 8 entity labels (top 3 each), keeps
 * hits ≥ ENTITY_SEMANTIC_THRESHOLD (normalized cosine), sorts by score desc.
 *
 * Graceful degradation:
 *   - Query embedding unavailable → [] (caller keeps lexical-only results).
 *   - Per-label vector query throws (index missing/not yet ONLINE) → warn once
 *     for that label, continue with the remaining labels.
 *   - Most entities have NO embedding yet (backfill script not run) → 0 rows,
 *     which is the designed cold-start state until backfill runs.
 *
 * Never throws — returns [] on total failure.
 */
async function semanticEntitySearch(
  query: string,
  topK: number
): Promise<Array<{ id: string; name: string; type: string; description: string; domain: string; score: number }>> {
  try {
    const { vector } = await generateQueryEmbedding(query)
    // P0.1 — no pseudo-hash fallback: no embedding → no semantic search.
    if (!vector || vector.length === 0) return []

    const hits: Array<{ id: string; name: string; type: string; description: string; domain: string; score: number }> = []

    // Query all 8 per-label vector indexes in PARALLEL (each readCypher opens
    // its own Neo4j session — independent, Aura connection pool handles it).
    // Sequential would cost 8× round-trips (~2.4s+ on Aura); parallel is one.
    const labelResults = await Promise.allSettled(
      ENTITY_LABELS.map(async (label) => {
        const indexName = `entity_embedding_${label.toLowerCase()}`
        const rows = await readCypher<{
          id: unknown
          name: unknown
          entity_type: unknown
          description: unknown
          domain: unknown
          score: unknown
        }>(
          `CALL db.index.vector.queryNodes($indexName, toInteger($limit), $vec) YIELD node AS n, score
           WHERE score >= $threshold
           RETURN n.id AS id, n.name AS name, n.entity_type AS entity_type,
                  n.description AS description, n.domain AS domain, score`,
          {
            indexName,
            limit: ENTITY_SEMANTIC_TOP_PER_LABEL,
            vec: vector,
            threshold: ENTITY_SEMANTIC_THRESHOLD,
          }
        )
        return rows.map((row) => ({
          id: String(row.id ?? ''),
          name: String(row.name ?? ''),
          type: String(row.entity_type ?? label),
          description: String(row.description ?? ''),
          domain: String(row.domain ?? ''),
          score: typeof row.score === 'number' ? row.score : 0,
        }))
      })
    )

    let labelsFailed = 0
    for (let i = 0; i < labelResults.length; i++) {
      const res = labelResults[i]
      if (res.status === 'fulfilled') {
        hits.push(...res.value)
        continue
      }
      // Index missing / not ONLINE / transient — this label degrades to nothing,
      // other labels (and the lexical path) still run.
      labelsFailed++
      const indexName = `entity_embedding_${ENTITY_LABELS[i].toLowerCase()}`
      console.warn(
        `[KB-Access] Semantic entity search failed for ${indexName} (falling back to lexical for this label):`,
        res.reason instanceof Error ? res.reason.message : String(res.reason)
      )
    }

    hits.sort((a, b) => b.score - a.score)
    console.log(
      `[KB-Access] Semantic entity search: ${hits.length} hits across ${labelResults.length} labels (${labelsFailed} label queries failed, embedding backfill may be pending)`
    )
    return hits.slice(0, topK)
  } catch (err) {
    console.warn('[KB-Access] Semantic entity search failed (falling back to lexical):', err instanceof Error ? err.message : String(err))
    return []
  }
}

async function searchEntitiesForUser(agentId: string, query: string, topK: number): Promise<UserKBResult['entities']> {
  try {
    // searchEntities from neo4j.ts — lexical name search (fulltext index with
    // CONTAINS fallback). Always runs: it is the graceful fallback for Prop 3.11.
    const lexicalPromise = searchEntities(query, { limit: Math.floor(topK) })

    // Phase 4 SMOLAB Prop 3.11 — semantic (vector) entity search, flag-gated.
    const semantic = isFlagEnabled('ENABLE_SEMANTIC_ENTITY_SEARCH')
      ? await semanticEntitySearch(query, topK)
      : []

    const lexical = await lexicalPromise.catch(() => [] as Array<{ name: string; type: string; domain: string; description: string }>)

    // Merge: semantic results first (already score-sorted), then lexical results
    // not already included (fixed score 0.5 — below every semantic hit above the
    // 0.7 threshold, above nothing; ordering-only signal). Dedupe by lowercased
    // name. Cap at topK.
    const merged: UserKBResult['entities'] = []
    const seen = new Set<string>()
    for (const e of semantic) {
      if (merged.length >= topK) break
      const key = e.name.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      merged.push({ id: e.id, name: e.name, type: e.type, description: e.description, domain: e.domain })
    }
    for (const e of lexical) {
      if (merged.length >= topK) break
      const key = (e.name || '').toLowerCase()
      if (!key || seen.has(key)) continue
      seen.add(key)
      // Lexical hits carry no Neo4j id (searchEntities returns name/type/domain/
      // description only) — use the name as a stable identifier.
      merged.push({ id: e.name, name: e.name, type: e.type, description: e.description, domain: e.domain })
    }
    if (semantic.length > 0 || isFlagEnabled('ENABLE_SEMANTIC_ENTITY_SEARCH')) {
      console.log(`[KB-Access] Entity search: semantic=${semantic.length}, lexical=${lexical.length}, merged=${merged.length}`)
    }
    return merged
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
 * Calculate RAW (uncalibrated) confidence score (0-1) from KB search results.
 *
 * Heuristics:
 *   - Chunks: weight by avg score (cosine sim 0-1, normalized)
 *   - Entities: count × 0.1 (capped at 0.4)
 *   - Memories: count × 0.1 (capped at 0.3)
 *   - Total capped at 1.0
 *
 * Renamed from calculateConfidence in Phase 4 Task B (Prop 3.5): this is the
 * raw signal; searchUserKB passes it through getCalibratedConfidence() before
 * exposing it. The eval runner (src/lib/eval/runner.ts) persists this raw value
 * as EvalResult.rawConfidence — the training input for the calibration model.
 */
function calculateRawConfidence(
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
