/**
 * Shared Embedding Module for GraphRAG
 *
 * Extracts embedding generation logic from mini-services into a shared module
 * that works in both local development (Bun) and Vercel (Node.js) environments.
 *
 * Provider fallback chain: NVIDIA (llama-nemotron-embed-1b-v2, 2048-dim) → OpenRouter (text-embedding-3-small, 2048-dim) → Pseudo-hash
 *
 * NVIDIA is PRIMARY — uses same API keys as LLM, 4 keys rotated, ~40 RPM/key = 160 RPM.
 * Supports input_type: "query" (for search) / "passage" (for indexing) via Matryoshka Representation Learning.
 *
 * HuggingFace (multilingual-e5-small, 384-dim) has been REMOVED — incompatible with 2048-dim.
 * Previous model nvidia/embed-qa-4 is DEPRECATED (returns 404).
 *
 * Caching strategy (Phase 6):
 *   L1: In-memory Map (1h TTL, 500 entries, instant lookup)
 *   L2: SQLite EmbeddingCache (7d TTL, max 5000 entries, survives server restarts)
 *   Flow: L1 miss → L2 lookup → API call → save to both L1 + L2
 *   IMPORTANT: Same text has SEPARATE cache entries for "query" vs "passage" inputType
 *   because NVIDIA generates different embeddings for each input_type.
 */

import { createHash } from 'crypto'

// ==================== TYPES ====================

export interface EmbeddingResult {
  vector: number[]
  model: string
}

// ==================== CONSTANTS ====================

const EMBEDDING_DIMENSION = 2048

// NVIDIA Embedding — PRIMARY
const NVIDIA_EMBED_MODEL = process.env.NVIDIA_EMBED_MODEL || 'nvidia/llama-nemotron-embed-1b-v2'
const NVIDIA_EMBED_DIMENSIONS = parseInt(process.env.NVIDIA_EMBED_DIMENSIONS || '2048', 10)
const NVIDIA_EMBED_ENDPOINT = 'https://integrate.api.nvidia.com/v1/embeddings'

// OpenRouter Embedding — FALLBACK
const OPENROUTER_EMBEDDING_MODEL = 'text-embedding-3-small'

// ==================== EMBEDDING CACHE — L1 (IN-MEMORY) ====================

/** In-memory embedding cache (L1) — fast lookup, lost on restart */
const embeddingCache = new Map<string, { vector: number[]; model: string; timestamp: number }>()
const EMBEDDING_CACHE_TTL = 3600000 // 1 hour

function getCachedEmbedding(cacheKey: string): { vector: number[]; model: string } | null {
  const cached = embeddingCache.get(cacheKey)
  if (cached && Date.now() - cached.timestamp < EMBEDDING_CACHE_TTL) {
    return { vector: cached.vector, model: cached.model }
  }
  if (cached) embeddingCache.delete(cacheKey) // Expired
  return null
}

function setCachedEmbedding(cacheKey: string, vector: number[], model: string): void {
  // Limit cache size to prevent memory bloat
  if (embeddingCache.size > 500) {
    const oldestKey = embeddingCache.keys().next().value
    if (oldestKey) embeddingCache.delete(oldestKey)
  }
  embeddingCache.set(cacheKey, { vector, model, timestamp: Date.now() })
}

// ==================== EMBEDDING CACHE — L2 (SQLITE) ====================

/** SQLite-backed embedding cache (L2) — survives server restarts
 *
 *  Lazy-loaded db reference to avoid circular imports at module init time.
 */
let cachedDb: ReturnType<typeof import('@/lib/db')['db']> | null = null

async function getDb() {
  if (!cachedDb) {
    const { db } = await import('@/lib/db')
    cachedDb = db
  }
  return cachedDb as typeof import('@/lib/db')['db']
}

/** TTL for SQLite cache entries — 7 days (much longer than L1's 1 hour) */
const SQLITE_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000

/** Maximum SQLite cache entries — LRU eviction when exceeded */
const SQLITE_CACHE_MAX_ENTRIES = 5000

/** Look up embedding in SQLite cache (L2).
 *  Returns { vector, model } on hit, null on miss.
 *  Also updates hitCount and lastHitAt for LRU tracking. */
async function getSqliteCachedEmbedding(
  textHash: string,
  inputType: 'query' | 'passage'
): Promise<{ vector: number[]; model: string } | null> {
  try {
    const db = await getDb()
    // Use composite unique key (hash + inputType) — same text has separate query & passage embeddings
    const record = await db.embeddingCache.findUnique({
      where: { hash_inputType: { hash: textHash, inputType } },
    })

    if (!record) return null

    // Check if expired
    if (new Date(record.expiresAt) < new Date()) {
      // Expired — delete and return miss
      await db.embeddingCache.delete({ where: { hash_inputType: { hash: textHash, inputType } } }).catch(() => {})
      return null
    }

    // Parse vector from JSON
    try {
      const vector = JSON.parse(record.vector) as number[]
      if (!Array.isArray(vector) || vector.length !== EMBEDDING_DIMENSION) return null

      // Update hit stats (non-blocking)
      db.embeddingCache.update({
        where: { hash_inputType: { hash: textHash, inputType } },
        data: {
          hitCount: { increment: 1 },
          lastHitAt: new Date(),
        },
      }).catch(() => {})

      return { vector, model: record.model }
    } catch {
      return null // Corrupt JSON — treat as miss
    }
  } catch (err) {
    // SQLite errors should not break embedding generation
    console.warn('[Embedding] SQLite L2 cache read error:', err instanceof Error ? err.message : String(err))
    return null
  }
}

/** Save embedding to SQLite cache (L2).
 *  Called after a successful API call, in addition to L1.
 *  Non-blocking — errors are logged but don't affect the result. */
async function setSqliteCachedEmbedding(
  textHash: string,
  inputType: 'query' | 'passage',
  vector: number[],
  model: string
): Promise<void> {
  try {
    const db = await getDb()
    const now = new Date()
    const expiresAt = new Date(Date.now() + SQLITE_CACHE_TTL_MS)

    // Use composite unique key (hash + inputType) — same text has separate query & passage embeddings
    await db.embeddingCache.upsert({
      where: { hash_inputType: { hash: textHash, inputType } },
      update: {
        model,
        vector: JSON.stringify(vector),
        hitCount: { increment: 1 },
        lastHitAt: now,
        expiresAt,
      },
      create: {
        hash: textHash,
        inputType,
        model,
        vector: JSON.stringify(vector),
        hitCount: 1,
        lastHitAt: now,
        expiresAt,
      },
    })
  } catch (err) {
    // SQLite errors should not break embedding generation
    console.warn('[Embedding] SQLite L2 cache write error:', err instanceof Error ? err.message : String(err))
  }
}

/** Evict expired and least-recently-used entries from SQLite cache.
 *  Called periodically to prevent unbounded growth. */
async function evictSqliteCache(): Promise<void> {
  try {
    const db = await getDb()
    const now = new Date()

    // 1. Delete all expired entries
    const expired = await db.embeddingCache.deleteMany({
      where: { expiresAt: { lt: now } },
    })
    if (expired.count > 0) {
      console.log(`[Embedding] SQLite L2 cache: evicted ${expired.count} expired entries`)
    }

    // 2. If still over limit, delete least-recently-used entries
    const remaining = await db.embeddingCache.count()
    if (remaining > SQLITE_CACHE_MAX_ENTRIES) {
      const toDelete = remaining - SQLITE_CACHE_MAX_ENTRIES
      // Find the LRU entries and delete them
      const lruEntries = await db.embeddingCache.findMany({
        orderBy: { lastHitAt: 'asc' },
        take: toDelete,
        select: { hash: true },
      })
      if (lruEntries.length > 0) {
        await db.embeddingCache.deleteMany({
          where: { hash: { in: lruEntries.map(e => e.hash) } },
        })
        console.log(`[Embedding] SQLite L2 cache: evicted ${lruEntries.length} LRU entries (${remaining} → ${remaining - lruEntries.length})`)
      }
    }
  } catch (err) {
    console.warn('[Embedding] SQLite L2 cache eviction error:', err instanceof Error ? err.message : String(err))
  }
}

// Run eviction every 30 minutes
// FIX (timer leak on hot reload): guard was module-scope — every re-evaluation of
// this module started a NEW 30-min interval while the old one kept running.
// globalThis guard keeps exactly one interval across reloads.
const globalForEmbeddings = globalThis as unknown as {
  __embeddingEvictionTimer?: ReturnType<typeof setInterval>
}
function startEvictionTimer(): void {
  if (globalForEmbeddings.__embeddingEvictionTimer) return
  const timer = setInterval(() => {
    evictSqliteCache().catch(() => {})
  }, 30 * 60 * 1000) // 30 minutes
  globalForEmbeddings.__embeddingEvictionTimer = timer
  // Don't prevent process exit
  if (timer.unref) timer.unref()
}
startEvictionTimer()

/**
 * Normalize text before hashing for cache key — improves cache hit rate by
 * treating "Hello World", "hello  world", " Hello world " as the same key.
 * Phase 6 SMOLAB P0.4 — cache key normalization.
 */
function normalizeKey(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ')
}

/** Compute the SHA-256 hash for a text string — used as cache key.
 *  Applies normalizeKey() first so case/whitespace variations hit the same cache entry. */
function hashText(text: string): string {
  return createHash('sha256').update(normalizeKey(text)).digest('hex')
}

// ==================== NVIDIA EMBEDDING AVAILABILITY CACHE ====================

let nvidiaEmbedAvailable = true
let nvidiaEmbedFailCount = 0
let nvidiaEmbedRetryAfter = 0

function isNVIDIAEmbedAvailable(): boolean {
  if (!nvidiaEmbedAvailable && nvidiaEmbedRetryAfter > 0 && Date.now() < nvidiaEmbedRetryAfter) return false
  if (nvidiaEmbedRetryAfter > 0 && Date.now() >= nvidiaEmbedRetryAfter) {
    nvidiaEmbedAvailable = true
    nvidiaEmbedFailCount = 0
    nvidiaEmbedRetryAfter = 0
  }
  return nvidiaEmbedAvailable
}

function markNVIDIAEmbedFailed(): void {
  nvidiaEmbedFailCount++
  if (nvidiaEmbedFailCount >= 3) {
    nvidiaEmbedAvailable = false
    nvidiaEmbedRetryAfter = Date.now() + 2 * 60 * 1000 // Retry after 2 minutes
    console.log(`[Embedding] NVIDIA marked unavailable, retry after ${new Date(nvidiaEmbedRetryAfter).toISOString()}`)
  }
}

function markNVIDIAEmbedSuccess(): void {
  nvidiaEmbedFailCount = 0
}

// ==================== OPENROUTER AVAILABILITY CACHE ====================

let openRouterEmbedAvailable = true
let openRouterEmbedFailCount = 0
let openRouterEmbedRetryAfter = 0

function isOpenRouterEmbedAvailable(): boolean {
  if (!openRouterEmbedAvailable && openRouterEmbedRetryAfter > 0 && Date.now() < openRouterEmbedRetryAfter) return false
  if (openRouterEmbedRetryAfter > 0 && Date.now() >= openRouterEmbedRetryAfter) {
    openRouterEmbedAvailable = true
    openRouterEmbedFailCount = 0
    openRouterEmbedRetryAfter = 0
  }
  return openRouterEmbedAvailable
}

function markOpenRouterEmbedFailed(): void {
  openRouterEmbedFailCount++
  if (openRouterEmbedFailCount >= 3) {
    openRouterEmbedAvailable = false
    openRouterEmbedRetryAfter = Date.now() + 2 * 60 * 1000 // Retry after 2 minutes
    console.log(`[Embedding] OpenRouter marked unavailable, retry after ${new Date(openRouterEmbedRetryAfter).toISOString()}`)
  }
}

function markOpenRouterEmbedSuccess(): void {
  openRouterEmbedFailCount = 0
}

// ==================== NVIDIA EMBEDDING (PRIMARY) ====================

/**
 * Generate embedding using NVIDIA NIM API (PRIMARY provider)
 * Model: nvidia/llama-nemotron-embed-1b-v2, supports dynamic dimensions via Matryoshka
 *
 * @param text - The text to embed
 * @param inputType - "query" for search queries, "passage" for indexing documents
 * @returns 2048-dim embedding vector or null on failure
 */
async function generateEmbeddingNVIDIA(text: string, inputType: 'query' | 'passage' = 'passage'): Promise<number[] | null> {
  if (!isNVIDIAEmbedAvailable()) {
    console.log('[Embedding] NVIDIA skipped (marked unavailable)')
    return null
  }

  const keys = [
    process.env.NVIDIA_API_KEY_1,
    process.env.NVIDIA_API_KEY_2,
    process.env.NVIDIA_API_KEY_3,
    process.env.NVIDIA_API_KEY_4,
  ].filter(Boolean) as string[]

  if (keys.length === 0) {
    console.log('[Embedding] NVIDIA: no API keys configured')
    return null
  }

  // Truncate text to 8000 chars (~2000 tokens) for NVIDIA 8K context limit
  const truncatedText = text.length > 8000 ? text.slice(0, 8000) : text

  let rateLimited = false
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i]
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 15000) // 15s timeout

      const response = await fetch(NVIDIA_EMBED_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({
          model: NVIDIA_EMBED_MODEL,
          input: [truncatedText],
          input_type: inputType, // Required for asymmetric embedding models
          dimensions: NVIDIA_EMBED_DIMENSIONS, // 2048 — Matryoshka dynamic dimension
          encoding_format: 'float',
        }),
        signal: controller.signal,
      })
      clearTimeout(timer)

      if (response.status === 429) {
        console.log(`[Embedding] NVIDIA rate limited (429) key#${i + 1}, trying next key...`)
        rateLimited = true
        continue
      }

      if (!response.ok) {
        const errText = await response.text().catch(() => '')
        console.error(`[Embedding] NVIDIA HTTP ${response.status} key#${i + 1}: ${errText.slice(0, 200)}`)
        markNVIDIAEmbedFailed()
        continue
      }

      const data = await response.json() as {
        data: Array<{ embedding: number[] }>
        model: string
        usage: { prompt_tokens: number; total_tokens: number }
      }
      const embedding = data.data?.[0]?.embedding

      if (embedding && embedding.length === EMBEDDING_DIMENSION) {
        console.log(`[Embedding] NVIDIA ${NVIDIA_EMBED_MODEL} ${inputType} ✓ (${embedding.length}d, tokens: ${data.usage?.total_tokens || 'unknown'}, key#${i + 1})`)
        markNVIDIAEmbedSuccess()
        return embedding
      }

      console.error(`[Embedding] NVIDIA returned unexpected format (length: ${embedding?.length || 'undefined'}, expected: ${EMBEDDING_DIMENSION})`)
      markNVIDIAEmbedFailed()
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        console.error(`[Embedding] NVIDIA request timed out (15s) key#${i + 1}`)
      } else {
        console.error(`[Embedding] NVIDIA error key#${i + 1}:`, err instanceof Error ? err.message : String(err))
      }
      markNVIDIAEmbedFailed()
    }
  }

  // All keys exhausted — if all were rate-limited, count as failure for backoff
  if (rateLimited) {
    console.log('[Embedding] NVIDIA: all keys rate limited (429), marking as failed')
    markNVIDIAEmbedFailed()
  }

  return null
}

// ==================== OPENROUTER EMBEDDING (FALLBACK) ====================

/**
 * Generate real embedding using OpenRouter API (FALLBACK provider)
 * Model: text-embedding-3-small, 2048 dimensions (Matryoshka dynamic)
 */
async function generateEmbeddingOpenRouter(text: string): Promise<number[] | null> {
  if (!isOpenRouterEmbedAvailable()) {
    console.log('[Embedding] OpenRouter skipped (marked unavailable)')
    return null
  }

  const keys = [
    process.env.OPENROUTER_API_KEY_2,
    process.env.OPENROUTER_API_KEY_1,
    process.env.OPENROUTER_API_KEY_3,
    process.env.OPENROUTER_API_KEY_4,
  ].filter(Boolean) as string[]

  if (keys.length === 0) {
    console.log('[Embedding] OpenRouter: no API keys configured')
    return null
  }

  let rateLimited = false
  for (const key of keys) {
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 15000) // 15s timeout

      const response = await fetch('https://openrouter.ai/api/v1/embeddings', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${key}`,
          'HTTP-Referer': process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000',
          'X-Title': 'Theopusflashlite',
        },
        body: JSON.stringify({
          model: OPENROUTER_EMBEDDING_MODEL,
          input: text,
          dimensions: EMBEDDING_DIMENSION, // 2048 — Matryoshka dimension of text-embedding-3-small
        }),
        signal: controller.signal,
      })
      clearTimeout(timer)

      if (response.status === 429) {
        console.log('[Embedding] OpenRouter rate limited (429), trying next key...')
        rateLimited = true
        continue
      }

      if (!response.ok) {
        const errText = await response.text().catch(() => '')
        console.error(`[Embedding] OpenRouter HTTP ${response.status}: ${errText.slice(0, 200)}`)
        markOpenRouterEmbedFailed()
        continue
      }

      const data = await response.json() as {
        data: Array<{ embedding: number[] }>
        model: string
        usage: { prompt_tokens: number; total_tokens: number; cost: number }
      }
      const embedding = data.data?.[0]?.embedding

      if (embedding && embedding.length === EMBEDDING_DIMENSION) {
        console.log(`[Embedding] OpenRouter ${OPENROUTER_EMBEDDING_MODEL} ✓ (${embedding.length}d, tokens: ${data.usage?.total_tokens || 'unknown'})`)
        markOpenRouterEmbedSuccess()
        return embedding
      }

      console.error(`[Embedding] OpenRouter returned unexpected format (length: ${embedding?.length || 'undefined'})`)
      markOpenRouterEmbedFailed()
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        console.error('[Embedding] OpenRouter request timed out (15s)')
      } else {
        console.error('[Embedding] OpenRouter error:', err instanceof Error ? err.message : String(err))
      }
      markOpenRouterEmbedFailed()
    }
  }

  // All keys exhausted — if all were rate-limited, count as failure for backoff
  if (rateLimited) {
    console.log('[Embedding] OpenRouter: all keys rate limited (429), marking as failed')
    markOpenRouterEmbedFailed()
  }

  return null
}

// ==================== PSEUDO-HASH EMBEDDING (LAST RESORT) ====================

/**
 * Fallback: Generate pseudo-embedding (hash-based, deterministic) — LAST RESORT
 * Not semantically meaningful but allows the system to function when all APIs are down.
 */
function generatePseudoEmbedding(text: string, dimension: number = EMBEDDING_DIMENSION): number[] {
  const vector: number[] = []
  for (let i = 0; i < dimension; i++) {
    const hash = createHash('sha256').update(`${text}:${i}`).digest()
    const intVal = hash.readUInt32BE(0)
    vector.push((intVal / 0xFFFFFFFF) * 2 - 1)
  }
  const magnitude = Math.sqrt(vector.reduce((s, v) => s + v * v, 0))
  if (magnitude > 0) {
    for (let i = 0; i < vector.length; i++) vector[i] /= magnitude
  }
  return vector
}

// ==================== PUBLIC API ====================

/**
 * Generate embedding for a text — fallback chain: NVIDIA → OpenRouter → EMPTY VECTOR (NO pseudo-hash)
 *
 * Phase 6 SMOLAB P0.1 — pseudo-hash fallback REMOVED. When all providers fail,
 * returns { vector: [], model: 'none' } so callers can length-check and skip
 * Qdrant writes instead of polluting the vector index with garbage hash vectors.
 *
 * Caching: L1 (memory, 1h TTL) → L2 (SQLite, 7d TTL) → API call → save to both L1 + L2
 *
 * @param text - The text to embed
 * @returns EmbeddingResult with vector (empty if all providers failed) and model name
 */
export async function generateEmbedding(text: string): Promise<EmbeddingResult> {
  const inputType: 'query' | 'passage' = 'passage'
  const textHash = hashText(text)
  const l1CacheKey = `passage:${textHash.slice(0, 32)}`

  // L1 cache check (in-memory, instant)
  const l1Cached = getCachedEmbedding(l1CacheKey)
  if (l1Cached) {
    console.log('[Embedding] L1 cache hit (passage)')
    return { vector: l1Cached.vector, model: l1Cached.model }
  }

  // L2 cache check (SQLite, survives restarts)
  const l2Cached = await getSqliteCachedEmbedding(textHash, inputType)
  if (l2Cached) {
    // Promote to L1 for faster subsequent lookups
    setCachedEmbedding(l1CacheKey, l2Cached.vector, l2Cached.model)
    console.log('[Embedding] L2 cache hit (passage)')
    return { vector: l2Cached.vector, model: l2Cached.model }
  }

  // API call — L1 and L2 both missed
  // Try NVIDIA first (PRIMARY) — input_type: "passage" for indexing
  const nvidiaVector = await generateEmbeddingNVIDIA(text, 'passage')
  if (nvidiaVector && nvidiaVector.length === EMBEDDING_DIMENSION) {
    setCachedEmbedding(l1CacheKey, nvidiaVector, NVIDIA_EMBED_MODEL)
    setSqliteCachedEmbedding(textHash, inputType, nvidiaVector, NVIDIA_EMBED_MODEL).catch(() => {})
    return { vector: nvidiaVector, model: NVIDIA_EMBED_MODEL }
  }

  // Fallback: OpenRouter
  const orVector = await generateEmbeddingOpenRouter(text)
  if (orVector && orVector.length === EMBEDDING_DIMENSION) {
    setCachedEmbedding(l1CacheKey, orVector, OPENROUTER_EMBEDDING_MODEL)
    setSqliteCachedEmbedding(textHash, inputType, orVector, OPENROUTER_EMBEDDING_MODEL).catch(() => {})
    return { vector: orVector, model: OPENROUTER_EMBEDDING_MODEL }
  }

  // Phase 6 SMOLAB P0.1 — NO pseudo-hash fallback. Silent garbage vectors were
  // corrupting Qdrant (cosine ~0 between any two random texts because SHA-256
  // hash spreads bits uniformly). Now: return empty vector + 'none' model so
  // callers can length-check and skip Qdrant write without polluting the index.
  console.error('[Embedding] ALL providers failed — returning empty vector (no pseudo-hash fallback). Caller should skip Qdrant write.')
  return { vector: [] as number[], model: 'none' }
}

/**
 * Generate embedding for a query — fallback chain: NVIDIA → OpenRouter → Pseudo-hash
 *
 * NVIDIA uses input_type: "query" for optimized retrieval.
 * OpenRouter uses "query: " prefix for E5-type retrieval.
 *
 * Caching: L1 (memory, 1h TTL) → L2 (SQLite, 7d TTL) → API call → save to both L1 + L2
 *
 * @param query - The query text to embed
 * @returns EmbeddingResult with vector and model name
 */
export async function generateQueryEmbedding(query: string): Promise<EmbeddingResult> {
  const inputType: 'query' | 'passage' = 'query'
  const textHash = hashText(query)
  const l1CacheKey = `query:${textHash.slice(0, 32)}`

  // L1 cache check (in-memory, instant)
  const l1Cached = getCachedEmbedding(l1CacheKey)
  if (l1Cached) {
    console.log('[Embedding] L1 cache hit (query)')
    return { vector: l1Cached.vector, model: l1Cached.model }
  }

  // L2 cache check (SQLite, survives restarts)
  const l2Cached = await getSqliteCachedEmbedding(textHash, inputType)
  if (l2Cached) {
    // Promote to L1 for faster subsequent lookups
    setCachedEmbedding(l1CacheKey, l2Cached.vector, l2Cached.model)
    console.log('[Embedding] L2 cache hit (query)')
    return { vector: l2Cached.vector, model: l2Cached.model }
  }

  // API call — L1 and L2 both missed
  // Try NVIDIA first with input_type: "query" (PRIMARY)
  const nvidiaVector = await generateEmbeddingNVIDIA(query, 'query')
  if (nvidiaVector && nvidiaVector.length === EMBEDDING_DIMENSION) {
    setCachedEmbedding(l1CacheKey, nvidiaVector, NVIDIA_EMBED_MODEL)
    setSqliteCachedEmbedding(textHash, inputType, nvidiaVector, NVIDIA_EMBED_MODEL).catch(() => {})
    return { vector: nvidiaVector, model: NVIDIA_EMBED_MODEL }
  }

  // Fallback: OpenRouter with "query: " prefix
  const prefixedQuery = `query: ${query}`
  const orVector = await generateEmbeddingOpenRouter(prefixedQuery)
  if (orVector && orVector.length === EMBEDDING_DIMENSION) {
    setCachedEmbedding(l1CacheKey, orVector, OPENROUTER_EMBEDDING_MODEL)
    // Note: For OpenRouter, we cache the query hash → the embedding of "query: {query}"
    // This is correct because the same query will always get the same prefixed treatment
    setSqliteCachedEmbedding(textHash, inputType, orVector, OPENROUTER_EMBEDDING_MODEL).catch(() => {})
    return { vector: orVector, model: OPENROUTER_EMBEDDING_MODEL }
  }

  // Phase 6 SMOLAB P0.1 — NO pseudo-hash fallback for queries either.
  // Empty vector signals caller to skip vector search and fall back to entity/memory search only.
  console.error('[Embedding] ALL providers failed for query — returning empty vector (no pseudo-hash fallback). Caller should skip vector search.')
  return { vector: [] as number[], model: 'none' }
}

/**
 * Generate embeddings for a batch of texts with concurrency control.
 * Processes texts in parallel chunks to improve throughput while staying
 * within rate limits (NVIDIA: 40 RPM/key × 4 keys = 160 RPM).
 *
 * With concurrency=5, we process up to 5 embeddings simultaneously,
 * staying well within the 160 RPM limit.
 *
 * Features:
 *   - Concurrency control: processes up to `concurrency` embeddings at once
 *   - Graceful degradation: individual failures don't block other embeddings
 *   - Progress logging: logs progress for large batches (>10 texts)
 *   - Preserves ordering: results are in the same order as input texts
 *
 * @param texts - Array of texts to embed
 * @param concurrency - Maximum number of parallel embedding requests (default: 5)
 * @returns Array of EmbeddingResults in the same order as input
 */
export async function generateEmbeddingBatch(
  texts: string[],
  concurrency: number = 5
): Promise<EmbeddingResult[]> {
  if (texts.length === 0) return []
  if (texts.length === 1) {
    return [await generateEmbedding(texts[0])]
  }

  const results: EmbeddingResult[] = new Array(texts.length)
  let completed = 0

  // Process in chunks of `concurrency`
  for (let i = 0; i < texts.length; i += concurrency) {
    const chunkIndices: number[] = []
    const chunkTexts: string[] = []
    for (let j = i; j < Math.min(i + concurrency, texts.length); j++) {
      chunkIndices.push(j)
      chunkTexts.push(texts[j])
    }

    const chunkResults = await Promise.all(
      chunkTexts.map(text => generateEmbedding(text))
    )

    for (let k = 0; k < chunkResults.length; k++) {
      results[chunkIndices[k]] = chunkResults[k]
    }

    completed += chunkResults.length
    if (texts.length > 10) {
      console.log(`[Embedding] Batch progress: ${completed}/${texts.length} complete`)
    }
  }

  return results
}

// ==================== UTILITY EXPORTS ====================

/** Get the embedding dimension used by this module */
export function getEmbeddingDimension(): number {
  return EMBEDDING_DIMENSION
}

// ==================== PHASE 3 SMOLAB PROP 4.1 — MODEL VERSION TRACKING ====================

/**
 * Phase 3 SMOLAB Prop 4.1 — current embedding model version tag.
 * Format: `${modelName}@${versionTag}` where versionTag is the active
 * EmbeddingModelVersion row's versionTag (queried lazily + cached for 5 min).
 *
 * Used by:
 *   - auto-learn.ts saveChunkToQdrant() — stamped on every chunk payload.
 *   - kb-routing/writeback.ts WRITE 1 — stamped on every chunk payload.
 *   - kb-routing/kb-access.ts checkModelDrift() — compared against sampled
 *     Qdrant payloads to detect silent NVIDIA model updates that invalidate
 *     existing vectors (same text → different vector → cosine sim drops from
 *     1.0 to ~0.6 → retrieval recall degrades silently with no alert).
 *
 * Fallback: when no EmbeddingModelVersion row exists (DB not seeded yet),
 * returns `${NVIDIA_EMBED_MODEL || 'unknown'}@unknown` so drift check still
 * has a tag to compare against — and will flag all pre-Prop 4.1 chunks (which
 * lack the `embedding_model_version` payload field entirely).
 */
let _cachedVersion: { tag: string; expiresAt: number } | null = null

export async function getCurrentEmbeddingModelVersion(): Promise<string> {
  // Cache for 5 min — avoid hitting DB on every chunk upsert (auto-learn
  // batches can upsert 10+ chunks in one call → 10× DB queries without cache).
  if (_cachedVersion && Date.now() < _cachedVersion.expiresAt) {
    return _cachedVersion.tag
  }

  try {
    const { db } = await import('@/lib/db')
    const active = await db.embeddingModelVersion.findFirst({
      where: { deprecatedAt: null },
      orderBy: { activeSince: 'desc' },
    })

    if (active) {
      _cachedVersion = {
        tag: `${active.modelName}@${active.versionTag}`,
        expiresAt: Date.now() + 5 * 60 * 1000, // 5 min cache
      }
      return _cachedVersion.tag
    }
  } catch (err) {
    console.warn('[Embeddings] Failed to query active model version:', err instanceof Error ? err.message : String(err))
  }

  // Fallback: env vars only (no DB row yet — seed-embedding-model-version.ts not run).
  // Returned tag uses '@unknown' so drift check flags pre-Prop 4.1 chunks.
  const fallback = `${process.env.NVIDIA_EMBED_MODEL || 'unknown'}@unknown`
  return fallback
}

/** Phase 3 SMOLAB Prop 4.1 — invalidate the cached version. Test helper.
 *  Call this in tests after inserting/deprecating EmbeddingModelVersion rows
 *  to force the next getCurrentEmbeddingModelVersion() call to re-query the DB. */
export function _invalidateEmbeddingModelVersionCache(): void {
  _cachedVersion = null
}

/** Get embedding provider availability status */
export function getEmbeddingAvailability(): {
  nvidia: { available: boolean; retryAfter?: string; model: string }
  openRouter: { available: boolean; retryAfter?: string; model: string }
  cache: { l1Size: number; l2Stats: Promise<{ total: number; expired: number }> }
} {
  return {
    nvidia: {
      available: isNVIDIAEmbedAvailable(),
      model: NVIDIA_EMBED_MODEL,
      retryAfter: nvidiaEmbedRetryAfter > 0 && Date.now() < nvidiaEmbedRetryAfter
        ? new Date(nvidiaEmbedRetryAfter).toISOString()
        : undefined,
    },
    openRouter: {
      available: isOpenRouterEmbedAvailable(),
      model: OPENROUTER_EMBEDDING_MODEL,
      retryAfter: openRouterEmbedRetryAfter > 0 && Date.now() < openRouterEmbedRetryAfter
        ? new Date(openRouterEmbedRetryAfter).toISOString()
        : undefined,
    },
    cache: {
      l1Size: embeddingCache.size,
      l2Stats: (async () => {
        try {
          const db = await getDb()
          const now = new Date()
          const total = await db.embeddingCache.count()
          const expired = await db.embeddingCache.count({ where: { expiresAt: { lt: now } } })
          return { total, expired }
        } catch {
          return { total: 0, expired: 0 }
        }
      })(),
    },
  }
}

/** Compute cosine similarity between two vectors */
export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0
  const len = Math.min(a.length, b.length)
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB)
  return denom > 0 ? dot / denom : 0
}
