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
import { searchCommunities, ensureCommunitiesLazy, type CommunityInfo } from '@/lib/kb-routing/communities'
import { logKbConsult } from '@/lib/kb-routing/consult-log'
import { getKbConsultContext } from '@/lib/kb-routing/consult-context'

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
 * Neo4j db.index.vector.queryNodes returns NORMALIZED cosine similarity
 * (1 + raw_cosine) / 2 ∈ [0, 1] — NOT the raw cosine Qdrant uses.
 * (Verified empirically 2026-08-25, Task 13E: the queryNodes score matched
 * (1+cos)/2 computed in JS on the stored embeddings to 4 decimals — e.g.
 * score 0.6249 for raw cosine 0.2498.)
 *
 * Task 13E (2026-08-25): retuned 0.7 → 0.58. Measured score distribution on
 * this KB (nemotron-3-embed-1b, name+description embeddings vs query
 * embedding — different label spaces, so raw cosines run low):
 *   - unrelated queries (e.g. "recipe for chocolate cake"): 0.54–0.55
 *     normalized ≈ raw cosine 0.08–0.10
 *   - genuinely-related entities (Dijkstra query → graph concepts,
 *     Task 13D eval-question max 0.644): 0.61–0.64 ≈ raw 0.22–0.29
 *   - direct topical match (ML query → "Neural networks"): 0.72 ≈ raw 0.43
 * The old 0.7 exceeded every observed related-entity score except the single
 * best-case direct hit → the semantic layer returned 0 rows for ALL queries
 * despite a 1006/1006 embedding backfill. 0.58 sits in the empirical
 * separation gap (unrelated ≤ 0.548 < 0.58 ≤ related ≥ 0.612) ≈ raw cosine
 * 0.16 — it blocks unrelated hits while passing related ones with ~0.03
 * margin on both sides. Deliberately looser than the chunk threshold (raw
 * 0.3) because entity matches are name+description level (short texts embed
 * noisier than full chunks) and the lexical search runs in parallel anyway —
 * low-precision semantic hits are harmless.
 */
const ENTITY_SEMANTIC_THRESHOLD = 0.58

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
    /** Task 6 (2026-08-25): original dense cosine from Qdrant, preserved
     *  through hybrid/MMM fusion. The .score field is the normalized fused
     *  RANK score (top-1 = 1.000 by construction) — use denseScore when you
     *  need true semantic similarity. */
    denseScore?: number
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
  /** Leiden community hits (user request 2026-09-05) — bức tranh lớn từ
   *  entity graph: community summary + top member entities. [] khi chưa
   *  chạy detection hoặc flag tắt. */
  communities: CommunityInfo[]
  confidence: number  // 0-1 — how relevant the KB content is
  /** Task 20-c — confidence TRƯỚC calibration (giá trị heuristic gốc).
   *  Giữ để train calibration trên input THẬT (EvalResult.rawConfidence) —
   *  tránh feedback-loop fit trên output của chính model calibration. */
  rawConfidence?: number
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

  // Leiden community layer (user request 2026-09-05): nếu collection chưa tồn
  // tại → lazy auto-detect nền (fire-and-forget, đúng 1 lần/process) — query
  // hiện tại vẫn chạy bình thường (communities=[]), query sau hưởng kết quả.
  // TASK 50b: ensureCommunitiesLazy giờ CHECK Qdrant trước khi bắn detection —
  // đã có embeddings (user build tay / lần trước thành công) → skip, KHÔNG
  // chạy lại full detection 6-12 phút mỗi restart như trước.
  ensureCommunitiesLazy()

  // Query embedding dùng chung cho chunks + communities (1 lần embed —
  // generateQueryEmbedding có L1/L2 cache nên không tốn thêm call khi trùng)
  const queryEmbedding =
    options.embeddingOverride && options.embeddingOverride.length > 0
      ? options.embeddingOverride
      : (await generateQueryEmbedding(query)).vector

  // BRAIN-D1 (FB-D1-R1-04) — resolve dense threshold 1 LẦN trước allSettled:
  // searchChunks dùng (precomputed) + KbConsultLog ghi đúng giá trị đã dùng
  // (denseThreshold là tham số truy xuất DUY NHẤT biến thiên theo thời gian —
  // red-team delta — D2 cần để tái hiện hành vi retrieval theo mốc thời gian).
  const consultThresholds = await resolveDenseThreshold()

  // Run 4 searches in parallel for speed
  // (4) community search — vector search trên Leiden community summaries
  const [chunksResult, entitiesResult, memoriesResult, communitiesResult] = await Promise.allSettled([
    searchChunks(query, topK, options.embeddingOverride, consultThresholds),
    agentId ? searchEntitiesForUser(agentId, query, topK) : Promise.resolve([]),
    agentId ? recallAgentMemories(agentId, query, topK, minImportance) : Promise.resolve([]),
    searchCommunities(queryEmbedding, 3),
  ])

  const chunks = chunksResult.status === 'fulfilled' ? chunksResult.value : []
  const entities = entitiesResult.status === 'fulfilled' ? entitiesResult.value : []
  const memories = memoriesResult.status === 'fulfilled' ? memoriesResult.value : []
  const communities = communitiesResult.status === 'fulfilled' ? communitiesResult.value : []

  // BRAIN-D1 (task R20) — LOG-ONLY: nguồn nào hỏng vẫn ghi vào log (fail-open
  // từng nguồn — D2 cần thấy cả lượt "1 nguồn chết" để học phân phối lỗi)
  const consultSourceErrors: Record<string, string> = {}
  if (chunksResult.status === 'rejected') consultSourceErrors.chunks = String(chunksResult.reason).slice(0, 200)
  if (entitiesResult.status === 'rejected') consultSourceErrors.entities = String(entitiesResult.reason).slice(0, 200)
  if (memoriesResult.status === 'rejected') consultSourceErrors.memories = String(memoriesResult.reason).slice(0, 200)
  if (communitiesResult.status === 'rejected') consultSourceErrors.communities = String(communitiesResult.reason).slice(0, 200)

  // Phase 4 SMOLAB Prop 3.5 apply — calibrate the raw heuristic confidence with
  // the trained logistic-regression model (calibration-train.ts →
  // CalibrationModel row). Falls back to the raw value when no model is trained
  // or sampleSize < 20 → zero behavior change until the user trains.
  // Task 20-c: rawConfidence (giá trị TRƯỚC calibration) cũng được trả về —
  // EvalResult.rawConfidence phải lấy TỪ ĐÂY, không lấy `confidence` (đã
  // calibrate) — tránh feedback-loop trainer fit trên output của chính nó.
  const rawConfidence = calculateRawConfidence(chunks, entities, memories)
  const confidence = await getCalibratedConfidence(rawConfidence)
  const durationMs = Date.now() - startTime
  const calibratedNote = confidence !== rawConfidence ? ` (calibrated from raw: ${rawConfidence.toFixed(2)})` : ''
  console.log(`[KB-Access] Step 1 user KB: ${chunks.length} chunks, ${entities.length} entities, ${memories.length} memories, ${communities.length} communities, confidence=${confidence.toFixed(2)}${calibratedNote} (${durationMs}ms)`)

  // BRAIN-D1 (BLUEPRINT-EVO-NAO §8.1 — task R20) — LOG-ONLY ghi KbConsultLog.
  // Fire-and-forget: logKbConsult KHÔNG BAO GIỜ throw (fail-open tuyệt đối —
  // lỗi DB/cờ off không chạm kết quả trả về); ngữ cảnh (taskType/intent/
  // runId/sessionId) đến từ AsyncLocalStorage consult-context — caller bọc
  // bằng runWithKbConsultContext, không bọc thì field ngữ cảnh null.
  const consultCtx = getKbConsultContext()
  void logKbConsult({
    taskType: consultCtx.taskType,
    intent: consultCtx.intent,
    queryText: query,
    retrievalConfig: {
      topK,
      minImportance,
      embeddingOverride: Boolean(options.embeddingOverride && options.embeddingOverride.length > 0),
      hybrid: isFlagEnabled('ENABLE_HYBRID_SEARCH'),
      mmr: isFlagEnabled('ENABLE_MMR'),
      rerank: isFlagEnabled('ENABLE_RERANKER'),
      // FB-D1-R1-04 — 2 mục D2 cần để tái hiện hành vi retrieval:
      denseThreshold: consultThresholds.denseThreshold,
      sourcesEnabled: {
        chunks: true,
        communities: true,
        entities: Boolean(agentId),
        memories: Boolean(agentId),
      },
    },
    sources: {
      chunks: chunks.length,
      entities: entities.length,
      memories: memories.length,
      communities: communities.length,
      ...(Object.keys(consultSourceErrors).length > 0 ? { errors: consultSourceErrors } : {}),
    },
    topResults: chunks.map(c => ({
      id: c.id,
      source: c.source ?? 'chunk',
      score: Number(c.score.toFixed(4)),
      ...(c.denseScore !== undefined ? { denseScore: Number(c.denseScore.toFixed(4)) } : {}),
    })),
    confidence,
    rawConfidence,
    latencyMs: durationMs,
    runId: consultCtx.runId,
    sessionId: consultCtx.sessionId,
    agentId: consultCtx.agentId ?? agentId,
  })

  return {
    chunks,
    entities,
    memories,
    communities,
    confidence,
    rawConfidence,
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
  /** Task 6: original dense cosine, threaded through hybrid fusion. */
  denseScore?: number
}

/**
 * BRAIN-D1 (FB-D1-R1-04) — dense threshold HIỆU LỰC, nguồn dùng CHUNG:
 * searchChunks (runtime) + instrumentation KbConsultLog (LOG-ONLY) — công
 * thức ROUND-38 fix V5-6 (0.3 + red-team delta, cap 0.9) không nhân bản 2 nơi
 * (nếu nhân bản mà công thức đổi → log ghi sai cấu hình đã dùng → D2 học sai).
 * Fail-open: delta đọc lỗi → 0 (threshold 0.3 — hành vi như trước).
 */
async function resolveDenseThreshold(): Promise<{ denseThreshold: number; kbThresholdDelta: number }> {
  let kbThresholdDelta = 0
  try {
    const { getKbConfidenceThresholdDelta } = await import('@/lib/learning/adaptation-engine')
    kbThresholdDelta = getKbConfidenceThresholdDelta()
  } catch { /* fail-open — delta 0 */ }
  return { denseThreshold: Math.min(0.9, 0.3 + kbThresholdDelta), kbThresholdDelta }
}

async function searchChunks(
  query: string,
  topK: number,
  /** Prop 3.9 — HyDE: pre-computed query vector (e.g. embedding of the hypothetical
   *  answer). When provided + non-empty, generateQueryEmbedding() is skipped and
   *  this vector is used for the dense search. The TEXT query still drives hybrid
   *  BM25 + reranking (unchanged) — only the vector comes from the override. */
  embeddingOverride?: number[],
  /** FB-D1-R1-04 — threshold do searchUserKB resolve 1 LẦN rồi truyền xuống:
   *  KbConsultLog ghi đúng giá trị ĐÃ DÙNG (không phải giá trị đọc lại lần 2
   *  giữa chừng request). Caller khác (tương lai) không truyền → tự resolve. */
  precomputedThresholds?: { denseThreshold: number; kbThresholdDelta: number }
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

    // ━━━ ROUND-38 fix V5-6 — tightened KB threshold ÁP VÀO ĐƯỜNG LIVE ━━━
    // Trước đây delta (tighten_refusal_threshold, Red Team P4) chỉ được đọc ở
    // searchModelKnowledge — một đường KHÔNG có production caller → delta không
    // tác động lên BẤT KỲ truy vấn thật nào. searchUserKB là đường live CHUNG
    // của chat + agent (knowledge-bridge) → áp delta vào dense score_threshold
    // ở đây khiến cả hai đường đều "kén tính" hơn khi KB bị nghi ngờ (defense
    // in depth). Cap 0.9 — không bao giờ siết đến mức chặn toàn bộ KB.
    // FB-D1-R1-04: công thức gom về resolveDenseThreshold (dùng chung với
    // instrumentation KbConsultLog) — hành vi giữ nguyên bit-đối-bit.
    const { denseThreshold, kbThresholdDelta } =
      precomputedThresholds ?? (await resolveDenseThreshold())
    if (kbThresholdDelta > 0) {
      console.log(`[KB-Access] Step 1 dense threshold TIGHTENED: 0.3 → ${denseThreshold.toFixed(2)} (+${kbThresholdDelta} red-team delta)`)
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
      score_threshold: denseThreshold, // ROUND-38 fix V5-6: 0.3 + red-team delta (cap 0.9)
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
      const fused = hybridFuse(query, candidates.map(c => ({ id: c.id, text: c.text, score: c.score, denseScore: c.score })))
      // hybridFuse returns fresh objects (fused order + normalized rrf score) —
      // merge back so documentId/source/vector metadata + denseScore survives.
      const byId = new Map(candidates.map(c => [c.id, c]))
      candidates = fused
        .map(f => {
          const orig = byId.get(f.id)
          if (!orig) return null
          // Conditional spread: exactOptionalPropertyTypes rejects an explicit
          // `denseScore: undefined` on an optional field.
          return {
            ...orig,
            score: f.score,
            ...(f.denseScore !== undefined ? { denseScore: f.denseScore } : {}),
          }
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
    // Task 6 (2026-08-25): log BOTH scores for the top result — the fused rank
    // score (normalized, top-1 pins at 1.000 by construction) AND the original
    // dense cosine. Prevents the "score saturation" misreads observed during
    // the ML evaluation (displayed 1.000 vs true cosine ~0.31).
    const topFused = final[0]?.score
    const topDense = final[0]?.denseScore ?? topFused
    console.log(
      `[KB-Access] Chunk pipeline: dense=${denseCount} → hybrid=${hybridApplied ? 'Y' : 'N'} → mmr=${mmrApplied ? 'Y' : 'N'} → rerank=${rerankApplied ? 'Y' : 'N'} → final=${final.length}` +
      (final.length > 0 ? ` | top-1 fused=${topFused?.toFixed(3)} denseCos=${topDense?.toFixed(3)}` : '') +
      ` (${Date.now() - pipelineStart}ms)`
    )
    return final.map(({ id, text, score, documentId, source, denseScore }) => ({
      id,
      text,
      score,
      documentId,
      source,
      denseScore,
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

/**
 * FB-EE-A-R1-04 (fixbug EE vòng R1) — strip wildcard LIKE ('%', '_', '\') khỏi
 * query trước khi đưa vào Prisma `contains` (SQLite LIKE KHÔNG escape —
 * live-test 19/10: contains '%' match 6/6 entity dù không tên nào chứa '%';
 * contains '_' match 6/6 tương tự). Tên/mô tả entity không dùng wildcard một
 * cách hữu ích → mất khả năng tìm literal '%' là chấp nhận được. Trả về chuỗi
 * ĐÃ TRIM — rỗng nghĩa là query toàn wildcard ('%'/'_') → caller SKIP LIKE
 * layer (không chạy match-mọi-tên-có-space).
 */
export function sanitizeLikeQuery(query: string): string {
  return query.replace(/[%_\\]/g, ' ').replace(/\s+/g, ' ').trim()
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
    // ENTITY_SEMANTIC_THRESHOLD, above nothing; ordering-only signal). Dedupe by lowercased
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

    // ━━ EXECUTION-EFFICIENCY S1.3 — LOCAL ENTITY (SQLite) LIKE LAYER ━━
    // P1 (run bằng chứng run_1792386145100_1): knowledge_write của agent ghi
    // LocalEntity (SQLite) nhưng tầng search chỉ đọc Neo4j/Qdrant → 6 entity
    // ALISTA "vô hình" với knowledge_search dù nằm ĐẦY ĐỦ trong DB. Nguồn thứ 3
    // này LUÔN chạy (kể cả Neo4j chết) — SQL LIKE trên entityName/description,
    // không cần embedding → biến LocalEntity từ "buffer mù" thành "tầng KV chắc
    // chắn tìm được".
    // THỨ TỰ: dưới semantic, ngang lexical (S1). NHƯNG luôn được HIỂN THỊ khi
    // khớp — verify backfill 19/10 cho thấy gate `merged.length < topK` khiến
    // entity cũ Neo4j chiếm hết slot topK che mất entity agent (KPI §6 "100%
    // tìm thấy ≤1 call" fail) → local hits append SAU lexical, được phép vượt
    // topK (cap riêng topK) thay vì chỉ lấp chỗ trống. Chỉ thêm khi CÓ match —
    // query không khớp LocalEntity nào thì hành vi giữ nguyên như cũ.
    // Scope note: LocalEntity không có cột user/agent → kết quả là KB DÙNG CHUNG
    // toàn hệ thống (đúng tinh thần "KB chung" — không scoping theo agent).
    try {
      if (query.trim()) {
        const { db } = await import('@/lib/db')
        // FB-EE-A-R1-04 (fixbug EE vòng R1): Prisma contains → SQLite LIKE
        // KHÔNG escape wildcard — '%'/'_' trong query hoạt động như wildcard
        // (live-test: contains '%' match 6/6 entity dù không tên nào chứa '%').
        // Strip wildcard qua sanitizeLikeQuery + chỉ chạy khi còn nội dung
        // (query '%' → '' → skip; query '50%' → '50' vẫn tìm hợp lệ).
        const q = sanitizeLikeQuery(query)
        if (q) {
          // Prisma `contains` → SQLite LIKE '%q%' (case-insensitive ASCII —
          // đủ cho "tìm theo tên entity" của S1, không cần embedding)
          const localHits = await db.localEntity.findMany({
            where: {
              OR: [
                { entityName: { contains: q } },
                { description: { contains: q } },
              ],
            },
            // SELECT tối thiểu — không kéo properties JSON (có thể dài)
            select: { id: true, entityName: true, entityType: true, description: true, domain: true },
            take: topK,
            orderBy: { createdAt: 'desc' },
          })
          for (const e of localHits) {
            const key = e.entityName.toLowerCase()
            if (!key || seen.has(key)) continue
            seen.add(key)
            merged.push({
              id: e.id,
              name: e.entityName,
              type: e.entityType,
              description: e.description ?? '',
              domain: e.domain ?? '',
            })
          }
        }
      }
    } catch (localErr) {
      // Fail-open — nguồn LIKE là tầng phụ, không được phá search
      console.warn('[KB-Access] LocalEntity LIKE layer failed (fail-open):', localErr instanceof Error ? localErr.message : String(localErr))
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
 *
 * ROUND-37 V2a — tighten_refusal_threshold: khi Red Team phát hiện cùng 1
 * vector tấn công breach ≥2 lần, adaptation-engine đặt ngưỡng này +delta (mặc
 * định +0.1) trong 24h — KB phải TỰ TIN HƠN mới được tin, các câu trả lời
 * yếu chuyển sang đối chiếu model-knowledge (defense in depth).
 */
export async function searchModelKnowledge(
  query: string,
  userKBResult: UserKBResult
): Promise<ModelKnowledgeResult> {
  // Effective threshold = base + adaptation delta (nếu còn hạn)
  let kbThresholdDelta = 0
  try {
    const { getKbConfidenceThresholdDelta } = await import('@/lib/learning/adaptation-engine')
    kbThresholdDelta = getKbConfidenceThresholdDelta()
  } catch { /* fail-open — adaptation-engine không đo được → delta 0 */ }
  const effectiveThreshold = Math.min(0.9, CONFIDENCE_THRESHOLD + kbThresholdDelta)

  // Skip if Step 1 already has enough info
  if (userKBResult.confidence >= effectiveThreshold) {
    console.log(`[KB-Access] Step 2 skipped (Step 1 confidence ${userKBResult.confidence.toFixed(2)} >= ${effectiveThreshold.toFixed(2)}${kbThresholdDelta > 0 ? ' [ tightened +red-team-delta ]' : ''})`)
    return {
      used: false,
      content: '',
      supplemented: false,
      source: 'model-knowledge',
    }
  }

  console.log(`[KB-Access] Step 2 invoked (Step 1 confidence ${userKBResult.confidence.toFixed(2)} < ${effectiveThreshold.toFixed(2)}${kbThresholdDelta > 0 ? ' [ tightened +red-team-delta ]' : ''})`)

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
