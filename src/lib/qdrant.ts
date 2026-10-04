/**
 * Qdrant Client Module — Vector Database for GraphRAG Knowledge Base
 *
 * Architecture:
 *   SQLite (buffer) → Qdrant (vector + document) + Neo4j (graph)
 *
 * Qdrant handles:
 *   - Document metadata (title, domain, status, processing_steps)
 *   - Chunk text + embeddings (semantic search)
 *   - Vector similarity search (cosine, dot product)
 *   - Hybrid search (vector + keyword filtering)
 *
 * Collections:
 *   1. theopus_documents — Document-level metadata (no vectors, payload only)
 *   2. theopus_chunks — Chunk text + 2048-dim embeddings for semantic search
 */

import { QdrantClient } from '@qdrant/js-client-rest'

// ==================== CLIENT INITIALIZATION ====================

const qdrantUrl = process.env.QDRANT_URL || 'http://localhost:6333'
const qdrantApiKey = process.env.QDRANT_API_KEY || undefined
const COLLECTION_DOCUMENTS = process.env.QDRANT_COLLECTION_DOCUMENTS || 'theopus_documents'
const COLLECTION_CHUNKS = process.env.QDRANT_COLLECTION_CHUNKS || 'theopus_chunks'

/** Embedding dimension — sourced from @/lib/embeddings (single source of truth) */
import { getEmbeddingDimension } from './embeddings'
const EMBEDDING_DIMENSION = getEmbeddingDimension()

const globalForQdrant = globalThis as unknown as {
  qdrant: QdrantClient | undefined
}

/**
 * Qdrant client instance — singleton pattern for hot-reload safety.
 * Connects to Qdrant REST API at QDRANT_URL (default: http://localhost:6333)
 */
export const qdrant =
  globalForQdrant.qdrant ??
  new QdrantClient({
    url: qdrantUrl,
    apiKey: qdrantApiKey || undefined,
    timeout: 60000, // 60s timeout for large batch operations (2500+ chunks need multiple scroll pages)
    checkCompatibility: false, // Skip version check — client may be newer than server
  })

if (process.env.NODE_ENV !== 'production') globalForQdrant.qdrant = qdrant

// ==================== ERROR DETECTION & RETRY ====================

/**
 * Tracks the most recent Qdrant connection error.
 * Callers can check this to distinguish "no data" from "Qdrant is down".
 *
 * Usage:
 *   const docs = await listDocuments()
 *   if (docs.total === 0 && lastQdrantError) {
 *     // Qdrant is down, not just empty
 *     console.error('Qdrant connection issue:', lastQdrantError)
 *   }
 */
export let lastQdrantError: string | null = null

/**
 * Discriminated return type that surfaces connection errors.
 * Use this for new code — existing functions maintain backward-compatible
 * return types but set `lastQdrantError` for error detection.
 */
export interface QdrantResult<T> {
  data: T
  error?: string // Non-empty when Qdrant is down (vs just no results)
}

/**
 * Check if an error is retryable (transient network/timeout issues).
 * Non-retryable errors (auth, validation) are not retried.
 */
function isQdrantRetryableError(error: any): boolean {
  const msg = error?.message?.toLowerCase() || ''
  const code = error?.code?.toLowerCase() || ''
  return (
    msg.includes('econnrefused') ||
    msg.includes('econnreset') ||
    msg.includes('etimedout') ||
    msg.includes('socket hang up') ||
    msg.includes('fetch failed') ||
    msg.includes('network error') ||
    code === 'econnrefused' ||
    code === 'econnreset' ||
    code === 'etimedout' ||
    error?.status === 503 || // Service Unavailable
    error?.status === 429    // Rate limited
  )
}

/**
 * Execute a Qdrant operation with automatic retry on transient errors.
 * Uses exponential backoff: 1s, 2s between retries.
 *
 * @param fn - The operation to execute
 * @param maxRetries - Maximum retry attempts (default: 2)
 * @param baseDelay - Base delay in ms, doubled each retry (default: 1000)
 */
async function withQdrantRetry<T>(
  fn: () => Promise<T>,
  maxRetries: number = 2,
  baseDelay: number = 1000
): Promise<T> {
  let lastError: any
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = await fn()
      return result
    } catch (error: any) {
      lastError = error
      lastQdrantError = error instanceof Error ? error.message : String(error)

      if (!isQdrantRetryableError(error) || attempt === maxRetries) throw error

      const delay = baseDelay * Math.pow(2, attempt) // 1s, 2s
      console.warn(`[Qdrant] Transient error, retry ${attempt + 1}/${maxRetries} after ${delay}ms...`)
      await new Promise(r => setTimeout(r, delay))
    }
  }
  throw lastError
}

// ==================== COLLECTION MANAGEMENT ====================

/**
 * Initialize both Qdrant collections if they don't exist.
 * Safe to call multiple times — checks existence first.
 *
 * Collections:
 *   - theopus_documents: Document metadata (no vectors, fast filtering)
 *   - theopus_chunks: Chunk text + 2048-dim embeddings (vector search)
 */
export async function initializeCollections(): Promise<{
  documents: boolean
  chunks: boolean
  error?: string
}> {
  try {
    const result = { documents: false, chunks: false }

    // Check existing collections
    const collections = await qdrant.getCollections()
    const existingNames = new Set(collections.collections.map(c => c.name))

    // Create documents collection (no vectors — payload filtering only)
    if (!existingNames.has(COLLECTION_DOCUMENTS)) {
      await qdrant.createCollection(COLLECTION_DOCUMENTS, {
        vectors: { size: 1, distance: 'Cosine' }, // Minimal vector (not used for search)
      })
      console.log(`[Qdrant] Created collection: ${COLLECTION_DOCUMENTS}`)
    }
    result.documents = true

    // Create chunks collection (2048-dim embeddings for semantic search)
    if (!existingNames.has(COLLECTION_CHUNKS)) {
      await qdrant.createCollection(COLLECTION_CHUNKS, {
        vectors: {
          size: EMBEDDING_DIMENSION,
          distance: 'Cosine',
        },
        // Phase 3: Scalar Quantization (INT8) — 4x memory savings, <1% accuracy loss.
        // Quantized vectors kept in RAM (always_ram=true) for fast search.
        // Original float32 vectors stay on disk for fallback when high accuracy needed.
        quantization_config: {
          scalar: {
            type: 'int8' as const,
            quantile: 0.99,
            always_ram: true,
          },
        },
        hnsw_config: {
          ef_construct: 128,     // Better recall at index time
          m: 16,                 // Standard connectivity
          full_scan_threshold: 10000, // Use HNSW for collections > 10K points
        },
        optimizers_config: {
          indexing_threshold: 20000, // Start indexing after 20K points
        },
      })
      console.log(`[Qdrant] Created collection: ${COLLECTION_CHUNKS} (${EMBEDDING_DIMENSION}-dim vectors, scalar-quantized INT8)`)
    }
    result.chunks = true

    // CI-3 B2 (Task 13-b) — Kho Context: tạo thêm collection task_context
    // (embedding digest để truy hồi ngữ nghĩa qua context_recall). Dynamic
    // import tránh circular import lúc load module (context-store import qdrant
    // client từ đây). Fail-open toàn bộ — layer này là best-effort: SQL fallback
    // trên Prisma TaskContextArchive vẫn hoạt động khi Qdrant/embed hỏng.
    try {
      const { initTaskContextCollection } = await import('@/lib/context-store')
      await initTaskContextCollection()
    } catch { /* fail-open — task_context là best-effort layer */ }

    // Create payload indexes for fast filtering
    await createPayloadIndexes()

    return result
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err)
    console.error('[Qdrant] Collection initialization error:', errorMsg)
    return { documents: false, chunks: false, error: errorMsg }
  }
}

/**
 * Create payload indexes for fast filtering on both collections.
 * These enable efficient WHERE-like queries on payload fields.
 */
async function createPayloadIndexes(): Promise<void> {
  try {
    // Documents collection indexes
    await qdrant.createPayloadIndex(COLLECTION_DOCUMENTS, {
      field_name: 'status',
      field_schema: 'keyword',
    })
    await qdrant.createPayloadIndex(COLLECTION_DOCUMENTS, {
      field_name: 'domain',
      field_schema: 'keyword',
    })
    await qdrant.createPayloadIndex(COLLECTION_DOCUMENTS, {
      field_name: 'created_at',
      field_schema: 'datetime',
    })
    await qdrant.createPayloadIndex(COLLECTION_DOCUMENTS, {
      field_name: 'updated_at',
      field_schema: 'datetime',
    })

    // Chunks collection indexes
    await qdrant.createPayloadIndex(COLLECTION_CHUNKS, {
      field_name: 'document_id',
      field_schema: 'keyword',
    })
    await qdrant.createPayloadIndex(COLLECTION_CHUNKS, {
      field_name: 'domain',
      field_schema: 'keyword',
    })
    await qdrant.createPayloadIndex(COLLECTION_CHUNKS, {
      field_name: 'chunk_index',
      field_schema: 'integer',
    })

    console.log('[Qdrant] Payload indexes created/verified')
  } catch (err) {
    // Indexes may already exist — that's fine
    const msg = err instanceof Error ? err.message : String(err)
    if (!msg.includes('already exists') && !msg.includes('already has')) {
      console.warn('[Qdrant] Index creation warning:', msg)
    }
  }
}

// ==================== HEALTH CHECK ====================

/**
 * Check Qdrant connectivity and collection status.
 * Returns detailed health info for monitoring.
 */
export async function checkQdrantHealth(): Promise<{
  connected: boolean
  version?: string
  documentsCollection?: { exists: boolean; pointCount?: number }
  chunksCollection?: { exists: boolean; pointCount?: number; vectorCount?: number }
  error?: string
}> {
  try {
    // Basic connectivity check — try to list collections (proves Qdrant is reachable)
    const collections = await qdrant.getCollections()
    if (!collections) {
      return { connected: false, error: 'Qdrant returned empty response' }
    }

    // Get version info if available
    let version: string | undefined
    try {
      const versionInfo = await qdrant.versionInfo()
      version = versionInfo.version
    } catch {
      // versionInfo may not be available on older servers
    }

    const result: Awaited<ReturnType<typeof checkQdrantHealth>> = {
      connected: true,
      version,
    }

    // Check collections
    try {
      const docInfo = await qdrant.getCollection(COLLECTION_DOCUMENTS)
      result.documentsCollection = {
        exists: true,
        // points_count có thể null/undefined theo type của client → chuẩn hoá về undefined
        pointCount: docInfo.points_count ?? undefined,
      }
    } catch {
      result.documentsCollection = { exists: false }
    }

    try {
      const chunkInfo = await qdrant.getCollection(COLLECTION_CHUNKS)
      result.chunksCollection = {
        exists: true,
        pointCount: chunkInfo.points_count ?? undefined,
        // vectors_count đã bị bỏ khỏi type @qdrant client ≥1.19 (deprecated) —
        // đọc qua cast để giữ nguyên runtime value (server cũ vẫn trả field này)
        vectorCount: (chunkInfo as { vectors_count?: number | null }).vectors_count ?? undefined,
      }
    } catch {
      result.chunksCollection = { exists: false }
    }

    return result
  } catch (err) {
    return {
      connected: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

// ==================== DOCUMENT OPERATIONS ====================

/** Document payload stored in Qdrant */
export interface DocumentPayload {
  // Index signature: Qdrant payload là open map — cho phép gán vào Record<string, unknown>
  [key: string]: unknown
  title: string
  file_path?: string
  domain: string
  page_count?: number
  status: 'uploaded' | 'parsing' | 'chunked' | 'extracted' | 'indexed' | 'error' | 'partial' | 'extracting'
  // (2026-09-09) `| null`: pipeline dùng error_message: null để XÓA lỗi trong Qdrant
  // payload (nhiều call site updateDocumentStatus) — null là giá trị thật của dữ liệu.
  error_message?: string | null
  // (2026-09-09) Union 2 format cùng tồn tại thật trong payload:
  //   - rich format (ProcessingStepRecord) do pipeline chính ghi
  //   - legacy format {step,status,timestamp} do stepsToQdrantFormat() ghi
  // Qdrant lưu JSON as-is nên cả 2 đều đọc lại được — code đọc luôn cast sang
  // format cần dùng (xem các call site `as ProcessingStepRecord[]`).
  processing_steps: Array<
    | { name: string; label: string; status: string; startedAt: string | null; completedAt: string | null; detail: string | null }
    | { step: string; status: string; timestamp: string }
  >
  processing_percent: number
  created_at: string
  updated_at: string
}

/**
 * Create or update a document in Qdrant.
 * Uses UUID as the point ID for stable references.
 */
export async function upsertDocument(
  id: string,
  payload: DocumentPayload
): Promise<boolean> {
  try {
    await withQdrantRetry(async () => {
      await qdrant.upsert(COLLECTION_DOCUMENTS, {
        wait: true, // Ensure write is committed before returning — prevents "Document not found" on immediate read
        points: [
          {
            id,
            vector: [0], // Dummy vector (documents collection doesn't use vector search)
            payload,
          },
        ],
      })
    })
    lastQdrantError = null
    return true
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[Qdrant] Document upsert error:', msg)
    lastQdrantError = msg
    return false
  }
}

/**
 * Get a single document by ID.
 */
export async function getDocument(id: string): Promise<DocumentPayload | null> {
  try {
    const result = await withQdrantRetry(async () => {
      return await qdrant.retrieve(COLLECTION_DOCUMENTS, {
        ids: [id],
        with_payload: true,
      })
    })
    lastQdrantError = null
    if (result.length === 0) return null
    return result[0].payload as unknown as DocumentPayload
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[Qdrant] Document get error:', msg)
    lastQdrantError = msg
    return null
  }
}

/**
 * List documents with filtering and pagination.
 * Supports filtering by status, domain, and date range.
 */
export async function listDocuments(options?: {
  status?: string
  domain?: string
  limit?: number
  offset?: string
  orderBy?: 'created_at' | 'updated_at'
  orderDir?: 'asc' | 'desc'
}): Promise<{
  documents: Array<{ id: string; payload: DocumentPayload }>
  total: number
}> {
  try {
    const must: Array<Record<string, unknown>> = []

    if (options?.status) {
      must.push({
        key: 'status',
        match: { value: options.status },
      })
    }
    if (options?.domain) {
      must.push({
        key: 'domain',
        match: { value: options.domain },
      })
    }

    const filter = must.length > 0 ? { must } : undefined
    const requestedLimit = options?.limit || 25

    // Use scroll API for pagination (more reliable than search for listing)
    // NOTE: order_by must be an object { key, direction } to support descending order.
    // Passing a plain string always defaults to ascending — this was a bug that caused
    // newly uploaded documents to appear on the last page instead of the first.
    //
    // PAGINATION FIX: The Qdrant scroll API returns up to `limit` points per call.
    // If the requested limit exceeds the Qdrant page size (default batch), we need
    // to make multiple scroll calls using `next_page_offset` from the previous result.
    // This ensures ALL documents are returned even with 300+ docs in the collection.
    const PAGE_SIZE = Math.min(requestedLimit, 500) // Max per Qdrant scroll call
    let allDocuments: Array<{ id: string; payload: DocumentPayload }> = []
    let nextOffset: string | undefined = options?.offset
    let remaining = requestedLimit

    while (remaining > 0) {
      const batchSize = Math.min(PAGE_SIZE, remaining)
      const result = await withQdrantRetry(async () =>
        qdrant.scroll(COLLECTION_DOCUMENTS, {
          filter,
          limit: batchSize,
          offset: nextOffset as any,
          with_payload: true,
          order_by: {
            key: options?.orderBy || 'updated_at',
            direction: options?.orderDir || 'desc',
          },
        })
      )

      const batch = result.points.map(p => ({
        id: String(p.id),
        payload: p.payload as unknown as DocumentPayload,
      }))

      allDocuments.push(...batch)
      remaining -= batch.length

      // If we got fewer results than requested, or there's no next page, we're done
      if (batch.length < batchSize || !result.next_page_offset) {
        break
      }
      nextOffset = result.next_page_offset as string
    }

    // Get total count
    const countResult = await withQdrantRetry(async () =>
      qdrant.count(COLLECTION_DOCUMENTS, {
        filter,
        exact: false,
      })
    )

    lastQdrantError = null
    return {
      documents: allDocuments,
      total: countResult.count,
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[Qdrant] Document list error:', msg)
    lastQdrantError = msg
    return { documents: [], total: 0 }
  }
}

/**
 * Update document status and processing info.
 * Uses Qdrant setPayload() for atomic partial updates — no Read→Merge→Write race condition.
 * setPayload() merges new fields into existing payload without overwriting unchanged fields.
 */
export async function updateDocumentStatus(
  id: string,
  updates: Partial<Pick<DocumentPayload, 'status' | 'error_message' | 'processing_steps' | 'processing_percent' | 'domain' | 'page_count'>>
): Promise<boolean> {
  try {
    await withQdrantRetry(async () => {
      await qdrant.setPayload(COLLECTION_DOCUMENTS, {
        payload: { ...updates, updated_at: new Date().toISOString() },
        points: [id],
        wait: true, // Ensure update is committed before returning
      })
    })
    lastQdrantError = null
    return true
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[Qdrant] updateDocumentStatus failed for ${id}:`, msg)
    lastQdrantError = msg
    return false
  }
}

/**
 * Delete a document and all its chunks from Qdrant.
 */
export async function deleteDocument(id: string): Promise<boolean> {
  try {
    // Delete document
    await withQdrantRetry(async () => {
      await qdrant.delete(COLLECTION_DOCUMENTS, {
        points: [id],
      })
    })

    // Delete all chunks for this document
    await withQdrantRetry(async () => {
      await qdrant.delete(COLLECTION_CHUNKS, {
        filter: {
          must: [
            {
              key: 'document_id',
              match: { value: id },
            },
          ],
        },
      })
    })

    lastQdrantError = null
    return true
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[Qdrant] Document delete error:', msg)
    lastQdrantError = msg
    return false
  }
}

// ==================== CHUNK OPERATIONS ====================

/** Chunk payload stored in Qdrant (alongside embedding vector) */
export interface ChunkPayload {
  // Index signature: Qdrant payload là open map — cho phép gán vào Record<string, unknown>
  [key: string]: unknown
  document_id: string
  chunk_index: number
  content: string
  heading_path?: string
  token_count?: number
  domain?: string
  created_at: string
  // Auto-learn metadata (optional — only present on auto-learned chunks)
  auto_learned?: boolean
  agent_name?: string
  original_query?: string
  confidence?: number
  llm_provider?: string
  llm_model?: string
  /** Phase 3 SMOLAB Prop 4.1 — embedding model version tag (e.g. 'nvidia/nemotron-3-embed-1b@2025-08-24').
   *  Set on every chunk insert. Used by checkModelDrift() in kb-access.ts to detect
   *  silent model updates that invalidate existing vectors. */
  embedding_model_version?: string
}

/**
 * Upsert chunks with embeddings in batch.
 * Each chunk gets its embedding vector + metadata payload.
 */
export async function upsertChunks(
  chunks: Array<{
    id: string
    vector: number[]
    payload: ChunkPayload
  }>
): Promise<boolean> {
  try {
    // Batch upsert in chunks of 100 (Qdrant recommended batch size)
    const BATCH_SIZE = 100
    for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
      const batch = chunks.slice(i, i + BATCH_SIZE)
      await withQdrantRetry(async () => {
        await qdrant.upsert(COLLECTION_CHUNKS, {
          wait: true, // Ensure upsert is applied before returning — prevents stale zero-vector reads
          points: batch.map(c => ({
            id: c.id,
            vector: c.vector,
            payload: c.payload,
          })),
        })
      })
    }
    lastQdrantError = null
    return true
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    // ROUND-32 P0-3: kèm sample point id bị reject — lớp lỗi "point id không phải
    // UUID/unsigned int → 400" từng chết im lặng nhiều tháng ở auto-learn.
    console.error(`[Qdrant] Chunks upsert error: ${msg} (sample id: ${chunks[0]?.id ?? 'n/a'}, count: ${chunks.length})`)
    lastQdrantError = msg
    return false
  }
}

/**
 * ROUND-32 P0-4 — Cập nhật CHỈ vector của các chunk point, payload giữ nguyên
 * tuyệt đối.
 *
 * Vì sao phải có helper này: Qdrant UPSERT với payload kèm theo sẽ REPLACE toàn
 * bộ point (mọi field payload không nhắc đến đều MẤT) — generateAndSaveEmbeddings
 * cũ dựa trên niềm tin sai "upsert preserves payload not explicitly overwritten"
 * nên đã wipe heading_path/token_count/domain ghi ở Step 4 + renumber chunk_index
 * sai trên resume. updateVectors là API đúng semantics: chỉ chạm vector.
 *
 * Yêu cầu: point phải ĐÃ tồn tại (được upsert sẵn ở Step 4 với payload đầy đủ —
 * mọi đường đến đây trong pipeline đều đi qua Step 4 trước). Với point chưa tồn
 * tại, Qdrant bỏ qua ID đó (không tạo point mới, không lỗi) — P0-5 guard cuối
 * pipeline sẽ bắt trường hợp chunk thiếu vector còn sót.
 */
export async function updateChunkVectors(
  points: Array<{ id: string; vector: number[] }>
): Promise<boolean> {
  try {
    // Batch 100 — cùng chuẩn batch size với upsertChunks (khuyến nghị Qdrant)
    const BATCH_SIZE = 100
    for (let i = 0; i < points.length; i += BATCH_SIZE) {
      const batch = points.slice(i, i + BATCH_SIZE)
      await withQdrantRetry(async () => {
        await qdrant.updateVectors(COLLECTION_CHUNKS, {
          wait: true, // áp dụng xong mới trả về — chống stale zero-vector reads
          points: batch.map(p => ({ id: p.id, vector: p.vector })),
        })
      })
    }
    lastQdrantError = null
    return true
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[Qdrant] updateChunkVectors error: ${msg} (sample id: ${points[0]?.id ?? 'n/a'}, count: ${points.length})`)
    lastQdrantError = msg
    return false
  }
}

/**
 * Get all chunks for a document (for extraction pipeline).
 * Uses scroll API with filtering by document_id.
 * PAGINATED: Automatically fetches ALL pages when limit > max page size.
 * Qdrant's scroll API returns at most ~1000 points per page,
 * so for documents with 1000+ chunks, we must paginate using the offset cursor.
 *
 * ROUND-32 P0-5: option withVector — scroll với with_vector: true để caller
 * kiểm tra vector THẬT hay zero-vector placeholder (Step 4 upsert chunk với
 * vector 0 rồi mới embed thật ở Step 11 — resume cũ tin "chunk tồn tại = đã
 * embed" nên stranded zero-vector docs vĩnh viễn 'indexed'). Mặc định false
 * (không đổi hành vi caller cũ — response nặng hơn nhiều khi kèm vector 2048d).
 */
export async function getChunksByDocument(
  documentId: string,
  options?: { limit?: number; withVector?: boolean }
): Promise<Array<{ id: string; payload: ChunkPayload; vector?: number[] }>> {
  try {
    const requestedLimit = options?.limit || 1000
    const PAGE_SIZE = 1000 // Qdrant scroll max per page
    const allPoints: Array<{ id: string; payload: ChunkPayload; vector?: number[] }> = []
    let offset: string | undefined = undefined
    let hasMore = true

    while (hasMore) {
      const result = await withQdrantRetry(async () =>
        qdrant.scroll(COLLECTION_CHUNKS, {
          filter: {
            must: [
              {
                key: 'document_id',
                match: { value: documentId },
              },
            ],
          },
          limit: Math.min(PAGE_SIZE, requestedLimit - allPoints.length),
          with_payload: true,
          with_vector: options?.withVector ?? false,
          offset,
        })
      )

      for (const p of result.points) {
        allPoints.push({
          id: String(p.id),
          payload: p.payload as unknown as ChunkPayload,
          // Chỉ có giá trị khi withVector: true (Qdrant trả theo dạng mảng cho
          // unnamed vector) — undefined khi không yêu cầu, caller cũ không thấy.
          vector: (p as { vector?: number[] }).vector,
        })
      }

      // Check if there are more pages
      offset = result.next_page_offset as string | undefined
      hasMore = !!offset && allPoints.length < requestedLimit

      if (result.points.length === 0) break // No more results
    }

    // Sort by chunk_index since we can't use order_by with pagination
    allPoints.sort((a, b) => (a.payload.chunk_index ?? 0) - (b.payload.chunk_index ?? 0))

    lastQdrantError = null
    return allPoints
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[Qdrant] Chunks get error:', msg)
    lastQdrantError = msg
    return []
  }
}

/**
 * Get chunk count for a specific document.
 */
export async function getChunkCount(documentId: string): Promise<number> {
  try {
    const result = await withQdrantRetry(async () =>
      qdrant.count(COLLECTION_CHUNKS, {
        filter: {
          must: [
            {
              key: 'document_id',
              match: { value: documentId },
            },
          ],
        },
        exact: true,
      })
    )
    lastQdrantError = null
    return result.count
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[Qdrant] Chunk count error:', msg)
    lastQdrantError = msg
    return 0
  }
}

/**
 * Delete all chunks for a document (used before re-indexing).
 */
export async function deleteChunksByDocument(documentId: string): Promise<boolean> {
  try {
    await withQdrantRetry(async () => {
      await qdrant.delete(COLLECTION_CHUNKS, {
        filter: {
          must: [
            {
              key: 'document_id',
              match: { value: documentId },
            },
          ],
        },
      })
    })
    lastQdrantError = null
    return true
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[Qdrant] Chunks delete error:', msg)
    lastQdrantError = msg
    return false
  }
}

// ==================== VECTOR SEARCH ====================

export interface SearchResult {
  id: string
  score: number
  payload: ChunkPayload
}

/**
 * Semantic search — find chunks most similar to a query embedding.
 * This is the core vector search for the RAG pipeline.
 */
export async function searchSimilar(
  queryVector: number[],
  options?: {
    limit?: number
    domain?: string
    documentId?: string
    minScore?: number
  }
): Promise<SearchResult[]> {
  try {
    const must: Array<Record<string, unknown>> = []

    if (options?.domain) {
      must.push({
        key: 'domain',
        match: { value: options.domain },
      })
    }

    if (options?.documentId) {
      must.push({
        key: 'document_id',
        match: { value: options.documentId },
      })
    }

    const filter = must.length > 0 ? { must } : undefined
    const limit = options?.limit || 20
    const minScore = options?.minScore || 0.5

    // Phase 6 SMOLAB Prop 4 — qdrant.search() removed in @qdrant/js-client-rest v1.19.0.
    // Migrated to qdrant.query() (Universally Query API). Response shape: { points: ScoredPoint[] }.
    const results = await withQdrantRetry(async () =>
      qdrant.query(COLLECTION_CHUNKS, {
        query: queryVector,
        filter,
        limit,
        with_payload: true,
        score_threshold: minScore,
      })
    )

    lastQdrantError = null
    return results.points.map(r => ({
      id: String(r.id),
      score: r.score,
      payload: r.payload as unknown as ChunkPayload,
    }))
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[Qdrant] Search error:', msg)
    lastQdrantError = msg
    return []
  }
}

/**
 * Hybrid search — combine vector similarity with keyword filtering.
 * Supports filtering by entity names, domain, or any payload field.
 */
export async function hybridSearch(
  queryVector: number[],
  options?: {
    limit?: number
    domain?: string
    entityNames?: string[]
    keywords?: string[]
    minScore?: number
  }
): Promise<SearchResult[]> {
  try {
    const must: Array<Record<string, unknown>> = []

    if (options?.domain) {
      must.push({
        key: 'domain',
        match: { value: options.domain },
      })
    }

    // Filter by entity names mentioned in chunks (if tracked in payload)
    if (options?.entityNames && options.entityNames.length > 0) {
      const should = options.entityNames.map(name => ({
        key: 'content',
        match: { text: name },
      }))
      must.push({ should })
    }

    const filter = must.length > 0 ? { must } : undefined

    // Phase 6 SMOLAB Prop 4 — qdrant.search() → qdrant.query() migration.
    const results = await withQdrantRetry(async () =>
      qdrant.query(COLLECTION_CHUNKS, {
        query: queryVector,
        filter,
        limit: options?.limit || 20,
        with_payload: true,
        score_threshold: options?.minScore || 0.5,
      })
    )

    lastQdrantError = null
    return results.points.map(r => ({
      id: String(r.id),
      score: r.score,
      payload: r.payload as unknown as ChunkPayload,
    }))
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[Qdrant] Hybrid search error:', msg)
    lastQdrantError = msg
    return []
  }
}

// ==================== STATS ====================

/**
 * Get aggregate stats from Qdrant.
 */
export async function getQdrantStats(): Promise<{
  totalDocuments: number
  totalChunks: number
  vectorsIndexed: number
  collections: string[]
}> {
  try {
    const collections = await qdrant.getCollections()
    const names = collections.collections.map(c => c.name)

    let totalDocuments = 0
    let totalChunks = 0
    let vectorsIndexed = 0

    if (names.includes(COLLECTION_DOCUMENTS)) {
      const info = await qdrant.getCollection(COLLECTION_DOCUMENTS)
      totalDocuments = info.points_count ?? 0
    }

    if (names.includes(COLLECTION_CHUNKS)) {
      const info = await qdrant.getCollection(COLLECTION_CHUNKS)
      totalChunks = info.points_count ?? 0
      // vectors_count can be null for some Qdrant versions/configs (scalar-quantized
      // single-vector collections). Every chunk point always carries a real vector
      // (the pipeline refuses to upsert zero-vector placeholders since the pseudo
      // fallback was removed), so points_count is the accurate embedding count.
      // Fall back to points_count when vectors_count is null/undefined.
      // (Field đã bị bỏ khỏi type @qdrant client ≥1.19 — đọc qua cast giữ nguyên runtime.)
      vectorsIndexed = (info as { vectors_count?: number | null }).vectors_count ?? info.points_count ?? 0
    }

    return {
      totalDocuments,
      totalChunks,
      vectorsIndexed,
      collections: names,
    }
  } catch (err) {
    console.error('[Qdrant] Stats error:', err instanceof Error ? err.message : String(err))
    return { totalDocuments: 0, totalChunks: 0, vectorsIndexed: 0, collections: [] }
  }
}

// Export collection names for use in other modules
export { COLLECTION_DOCUMENTS, COLLECTION_CHUNKS, EMBEDDING_DIMENSION }
