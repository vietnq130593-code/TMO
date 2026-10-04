/**
 * Neo4j Enhanced Client Module for GraphRAG Knowledge Base
 *
 * Architecture: SQLite (buffer) → Qdrant (vector+document) + Neo4j (graph)
 *
 * Neo4j handles:
 *   - Entity nodes (Concept, Algorithm, Language, Tool, System, Technique,
 *     Vulnerability, Principle, Domain, Document, Person)
 *   - Typed relationships (PART_OF, IMPLEMENTED_IN, USES, EXPLOITS, etc.)
 *   - Document nodes (link documents to their entities)
 *
 * Key design decisions:
 *   - Properties use BOTH camelCase AND snake_case aliases for backward
 *     compatibility (e.g., `n.name` AND `n.entity_name`, `n.documentId` AND `n.document_id`)
 *   - `entity_type` is stored as both a Neo4j label AND a property
 *   - All nodes get `created_at` and `updated_at` timestamps
 *   - Relationships carry full metadata (description, confidence_score, source)
 *
 * Works with: Neo4j Desktop (neo4j://, bolt://) and AuraDB (neo4j+s://)
 */

import type { Driver, Session } from 'neo4j-driver'
// ROUND-32 P2-c: dim vector index lấy từ đúng NGUỒN DUY NHẤT (embeddings.ts) —
// trước đây hardcode 2048 tại đây nên đổi model embedding sẽ tạo index sai dim
// (entity embedding upsert lỗi im lặng theo). embeddings.ts không import neo4j → không vòng.
import { getEmbeddingDimension } from './embeddings'

// ==================== TYPES ====================

type Neo4jDriver = Driver

/** Supported entity type labels — also used as Neo4j node labels
 *  Redesigned 2026-08-21: 11 → 7 labels (gộp Concept+Algorithm+Technique → Concept,
 *  gộp Tool+System → Technology, tách thêm Framework từ Tool)
 *  LLM extraction prompt sẽ cung cấp mô tả + ví dụ cho mỗi label.
 */
export const ENTITY_LABELS = [
  'Concept', 'Technology', 'Framework', 'Vulnerability',
  'Principle', 'Domain', 'Document', 'Person',
] as const
export type EntityLabel = (typeof ENTITY_LABELS)[number]

// ==================== ROUND-32 P1-b — FULLTEXT INDEX LABEL SET ====================
// Index entity_name_search từng hardcode chuỗi label tại chỗ tạo index và KHÔNG
// bao giờ được đồng bộ lại sau redesign (gộp Tool+System → Technology, tách
// Framework): `CREATE ... IF NOT EXISTS` không cập nhật index sẵn có trên Aura —
// kết quả: 2 label LỚN NHẤT (Technology ~6.450 + Framework ~2.367 nodes) không
// nằm trong fulltext index → resolveEntityByFuzzyName không bao giờ match chúng.
// Từ P1-b: danh sách label dẫn xuất từ ENTITY_LABELS (nguồn duy nhất) + legacy
// (node cũ trên cloud vẫn mang label trước redesign — giữ search được, không mất).
export const LEGACY_ENTITY_LABELS = ['Algorithm', 'Language', 'Tool', 'System', 'Technique'] as const
export const FULLTEXT_INDEX_LABELS = [...ENTITY_LABELS, ...LEGACY_ENTITY_LABELS] as const

/** Supported relationship types
 *  Redesigned 2026-08-21: 14 → 15 rel types
 *  Removed (2): RELATED_TO (catch-all, no semantics), SUPPORTS (too vague)
 *  Added (3): CREATED_BY (Person → Entity), DOCUMENTED_IN (Entity → Document),
 *             ALTERNATIVE_TO (Tech ↔ Tech, positive comparison)
 *  Net: 14 - 2 + 3 = 15 relationship types
 */
export const RELATIONSHIP_TYPES = [
  'PART_OF', 'IMPLEMENTED_IN', 'USES', 'EXPLOITS', 'MITIGATES',
  'RUNS_ON', 'DEPENDS_ON', 'CONTRASTS_WITH',
  'ENABLES', 'CONTAINS', 'EXTENDS', 'APPLIES_TO',
  // New relationships (added 2026-08-21)
  'CREATED_BY', 'DOCUMENTED_IN', 'ALTERNATIVE_TO',
] as const
export type RelationshipType = (typeof RELATIONSHIP_TYPES)[number]

/** Entity node payload — all properties written to Neo4j */
export interface EntityNode {
  id: string
  name: string
  entity_type: EntityLabel
  domain: string
  description: string
  confidence: number
  documentId: string
  source?: string
  chunk_id?: string
  created_at: string
  updated_at: string
  /**
   * Embedding vector for semantic entity resolution (Phase 2 SMOLAB Prop 2.5).
   * Stored on the Neo4j node itself so that subsequent writebacks can find
   * similar entities via vector.similarity.cosine() scalar function or via
   * the db.index.vector.queryNodes procedure (one vector index per label,
   * created by initializeNeo4jSchema). Optional — backfill script fills
   * existing nodes; new entities from writeback carry embeddings in real-time.
   */
  embedding?: number[]
}

/** Relationship edge payload — all properties written to Neo4j */
export interface RelationshipEdge {
  sourceId: string
  targetId: string
  relationship_type: RelationshipType | string
  description?: string
  confidence?: number
  documentId: string
  source?: string
  created_at: string
}

/** Document node payload */
export interface DocumentNode {
  id: string
  title: string
  domain: string
  status: string
  page_count?: number
  created_at: string
  updated_at: string
}

// ==================== LABEL/TYPE SANITIZATION ====================

/**
 * Sanitize a label or relationship type for safe Cypher interpolation.
 * Only allows alphanumeric + underscore characters.
 */
function sanitizeLabel(label: string): string {
  return label.replace(/[^a-zA-Z0-9_]/g, '_')
}

/**
 * Validate that a label is in the allowed set.
 */
function isValidLabel(label: string): label is EntityLabel {
  return ENTITY_LABELS.includes(label as EntityLabel)
}

// ==================== ERROR DETECTION & RETRY ====================

/**
 * Check if an error indicates a transient/recoverable Neo4j connection issue.
 * These errors suggest the driver's connection pool is stale and needs reset.
 */
export function isTransientError(error: any): boolean {
  const msg = error?.message?.toLowerCase() || ''
  return (
    msg.includes('connection refused') ||
    msg.includes('service unavailable') ||
    msg.includes('session expired') ||
    msg.includes('connection pool closed') ||
    msg.includes('broken pipe') ||
    msg.includes('econnreset') ||
    msg.includes('econnrefused') ||
    msg.includes('connection acquisition timed out') ||
    msg.includes('connection timed out') ||
    msg.includes('failed to acquire connection') ||
    msg.includes('no longer available') ||
    msg.includes('transient error') ||
    (msg.includes('neo4jerror') && msg.includes('transient')) ||
    error?.code === 'ServiceUnavailable' ||
    error?.code === 'SessionExpired'
  )
}

/**
 * Check if a Neo4j error is retryable (transient + additional cases).
 * Broader than isTransientError — also includes deadlocks and general timeouts.
 */
export function isNeo4jRetryableError(error: any): boolean {
  if (isTransientError(error)) return true
  const msg = error?.message?.toLowerCase() || ''
  return (
    msg.includes('deadlock') ||
    msg.includes('timeout') ||
    msg.includes('transaction failed')
  )
}

/**
 * Execute a Neo4j operation with automatic retry on transient errors.
 * Resets the driver on connection-level failures before retrying,
 * so zombie drivers (dead connections in pool) are automatically recovered.
 *
 * Usage:
 *   const result = await withNeo4jRetry(async () => {
 *     const session = await getSession()
 *     try { return await session.run('MATCH (n) RETURN n') }
 *     finally { await session.close() }
 *   })
 */
export async function withNeo4jRetry<T>(
  fn: () => Promise<T>,
  maxRetries: number = 3,
  baseDelay: number = 1000
): Promise<T> {
  let lastError: any
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn()
    } catch (error: any) {
      lastError = error
      if (!isNeo4jRetryableError(error) || attempt === maxRetries) throw error

      // Reset driver on transient connection errors — clears zombie connections
      if (isTransientError(error)) {
        console.warn('[Neo4j] Transient connection error detected, resetting driver before retry...')
        await resetNeo4jDriver()
      }

      const delay = baseDelay * Math.pow(2, attempt) // exponential backoff: 1s, 2s, 4s
      console.warn(`[Neo4j] Retry ${attempt + 1}/${maxRetries} after ${delay}ms...`)
      await new Promise(r => setTimeout(r, delay))
    }
  }
  throw lastError
}

// ==================== CONNECT-FAIL LOG THROTTLE (dedup spam) ====================
//
// FIX 2026-09-12 (defer finding GĐ1 — Task 10-f "Neo4j ECONNREFUSED log spam"):
// khi Neo4j không chạy (sandbox giữ key placeholder / AuraDB pause), MỖI lần
// app thử dùng Neo4j (episodic memory, health check, sync route...) đều in FULL
// error dài nhiều dòng → dev.log spam. Chính sách mới — KHÔNG đổi logic kết
// nối/retry, chỉ đổi logging:
//   - FULL error đúng 1 lần ĐẦU TIÊN trong process (console.error).
//   - Các lần fail sau: 1 dòng ngắn
//       `[Neo4j] still unreachable (last full error at <ts>) — retry #N [<context>]`
//     tối đa 1 dòng/60s (nhanh hơn → im lặng hoàn toàn).
//   - Kết nối lại THÀNH CÔNG → reset trạng thái → đợt gián đoạn kế tiếp lại
//     được log full error (lỗi mới có thể khác lỗi cũ).
// State đặt trên globalThis (cùng pattern globalForNeo4j / globalForNeo4jMonitor
// ở dưới) để sống qua Next dev hot-reload — tránh N lần full error khi module
// được reload.

/** Tần suất tối đa của dòng log ngắn "still unreachable" */
const NEO4J_FAIL_LOG_INTERVAL_MS = 60_000

const globalForNeo4jFailLog = globalThis as unknown as {
  __neo4jLastFullErrorLoggedAt?: number
  __neo4jLastFailLineLoggedAt?: number
  __neo4jConsecutiveFailures?: number
  /** Lỗi kết nối gần nhất (message thật) — health endpoint đọc để báo nguyên nhân
   *  thật thay vì đoán mò. FIX 2026-09-03 (user report "Neo4j offline không rõ
   *  lý do"): message cũ "DNS resolution failed" đã che khuất lỗi thật
   *  "Unable to get a routing table for database 'neo4j' because this database
   *  does not exist" — AuraDB đặt tên DB theo instance-id, network + auth OK. */
  __neo4jLastError?: string
}

/**
 * Log lỗi kết nối Neo4j qua helper throttle (mọi console.error/warn connect-fail
 * trong module này đều phải qua đây — xem comment section trên).
 * `context` phân biệt nguồn lỗi: init / safeSession ping / health check ping /
 * background monitor — để dòng ngắn vẫn biết đường truy nguyên nhân.
 */
function logNeo4jConnectFailure(context: string, err: unknown): void {
  const now = Date.now()
  const g = globalForNeo4jFailLog
  const message = err instanceof Error ? err.message : String(err)
  g.__neo4jLastError = message // health endpoint hiển thị nguyên nhân thật
  g.__neo4jConsecutiveFailures = (g.__neo4jConsecutiveFailures ?? 0) + 1

  // Lần đầu tiên trong process (hoặc sau khi đã kết nối lại thành công) → FULL error
  if (!g.__neo4jLastFullErrorLoggedAt) {
    g.__neo4jLastFullErrorLoggedAt = now
    g.__neo4jLastFailLineLoggedAt = now
    console.error(`[Neo4j] Failed to connect (${context}):`, message)
    return
  }

  // Đã log full error trước đó → 1 dòng ngắn, tối đa 1 dòng/60s
  if (now - (g.__neo4jLastFailLineLoggedAt ?? 0) < NEO4J_FAIL_LOG_INTERVAL_MS) return
  g.__neo4jLastFailLineLoggedAt = now
  const ts = new Date(g.__neo4jLastFullErrorLoggedAt).toISOString()
  console.warn(`[Neo4j] still unreachable (last full error at ${ts}) — retry #${g.__neo4jConsecutiveFailures} [${context}]`)
}

/** Kết nối lại thành công → reset throttle để đợt gián đoạn kế tiếp log full error. */
function resetNeo4jFailLogState(): void {
  const g = globalForNeo4jFailLog
  g.__neo4jLastFullErrorLoggedAt = undefined
  g.__neo4jLastFailLineLoggedAt = undefined
  g.__neo4jConsecutiveFailures = undefined
  g.__neo4jLastError = undefined // đã kết nối lại thành công → hết lỗi để báo
}

// ==================== LAZY DRIVER INITIALIZATION ====================

const globalForNeo4j = globalThis as unknown as {
  neo4jDriver: Driver | undefined
}

/** Mutex to prevent race condition: two concurrent getNeo4jDriver() calls
 *  both seeing globalForNeo4j.neo4jDriver === undefined and creating
 *  two drivers — the first driver would be orphaned (never closed, leaking connections).
 */
let driverInitPromise: Promise<Neo4jDriver | null> | null = null

/**
 * Get or lazily create the Neo4j driver.
 * Returns null if env vars are missing or connection fails.
 *
 * Auto-detects: Desktop (bolt://, neo4j://) uses 10s timeout, AuraDB (neo4j+s://) uses 30s.
 *
 * THREAD SAFETY: Uses a mutex promise so that concurrent callers share the
 * same initialization — prevents orphaned driver leak on race conditions.
 */
export async function getNeo4jDriver(): Promise<Neo4jDriver | null> {
  // Fast path: driver already exists
  if (globalForNeo4j.neo4jDriver) return globalForNeo4j.neo4jDriver

  // Slow path: deduplicate concurrent initialization attempts
  if (driverInitPromise) return driverInitPromise

  driverInitPromise = (async () => {
    // Double-check after acquiring "lock" — another caller may have completed
    if (globalForNeo4j.neo4jDriver) return globalForNeo4j.neo4jDriver

    const uri = process.env.NEO4J_URI
    const user = process.env.NEO4J_USER
    const password = process.env.NEO4J_PASSWORD

    if (!uri || !user || !password) {
      logNeo4jConnectFailure('init: missing env', new Error('Missing NEO4J_URI, NEO4J_USER, or NEO4J_PASSWORD env vars'))
      driverInitPromise = null
      return null
    }

    let driver: import('neo4j-driver').Driver | null = null
    try {
      const neo4j = await import('neo4j-driver')

      const isLocalDesktop = uri.startsWith('bolt://') || uri.startsWith('neo4j://')
      const timeout = isLocalDesktop ? 10000 : 30000

      driver = neo4j.default.driver(uri, neo4j.default.auth.basic(user, password), {
        maxConnectionPoolSize: isLocalDesktop ? 10 : 5,
        connectionAcquisitionTimeout: timeout,
        connectionTimeout: timeout,
        maxTransactionRetryTime: timeout,
        connectionLivenessCheckTimeout: 30_000, // Fixed 30s — independent of other timeouts
        maxConnectionLifetime: isLocalDesktop ? 3600_000 : 7200_000, // 1h local, 2h cloud — rotate connections to prevent stale sockets after sleep/hibernate
      })

      // Verify connectivity
      const session = driver.session({ database: process.env.NEO4J_DATABASE || undefined })
      try {
        await session.run('RETURN 1 AS test')
        console.log('[Neo4j] Connected successfully to', uri.replace(/\/\/[^@]+@/, '//***@'))
        resetNeo4jFailLogState() // kết nối lại thành công → đợt fail kế tiếp log full error mới
      } finally {
        await session.close()
      }

      globalForNeo4j.neo4jDriver = driver
      return driver
    } catch (err) {
      // FIX log-spam: full error chỉ in 1 lần đầu trong process — các lần sau
      // qua helper throttle (1 dòng ngắn, tối đa 1 dòng/60s). Logic close driver
      // + return null GIỮ NGUYÊN (không đổi retry/connect semantics).
      logNeo4jConnectFailure('init', err)
      // FIX (resource leak): close the driver when connectivity verification fails.
      // Previously it was abandoned (connection pool + sockets leaked). During an
      // AuraDB outage every request leaked one driver.
      if (driver) {
        await driver.close().catch(() => {})
      }
      return null
    } finally {
      // Clear mutex after completion (success or failure) so future calls can retry
      driverInitPromise = null
    }
  })()

  return driverInitPromise
}

// ==================== HELPER: GET SESSION ====================

/**
 * Get a Neo4j session from the driver.
 *
 * Note: This function creates a session object but does NOT verify connectivity.
 * For automatic reconnection on transient errors, wrap your operations with
 * `withNeo4jRetry()` which will reset the driver and retry if the connection
 * is dead (zombie driver pattern).
 *
 * Pattern:
 *   const result = await withNeo4jRetry(async () => {
 *     const session = await getSession()
 *     try { return await session.run(...) }
 *     finally { await session.close() }
 *   })
 */
async function getSession(): Promise<Session> {
  const driver = await getNeo4jDriver()
  if (!driver) throw new Error('Neo4j driver not available')
  return driver.session({ database: process.env.NEO4J_DATABASE || undefined })
}

/**
 * Safe session helper — creates a Neo4j session with zombie driver recovery.
 *
 * This is the RECOMMENDED way to get a session from outside neo4j.ts.
 * It wraps the raw `driver.session()` pattern with:
 *   1. Automatic driver reset if the session creation fails with a transient error
 *   2. Liveness ping on first use to detect stale connections
 *   3. Proper error propagation with actionable error messages
 *
 * Usage (replaces raw `driver.session()` in API routes):
 *   const session = await safeSession()
 *   try {
 *     const result = await session.executeRead(tx => tx.run(cypher, params))
 *     return result
 *   } finally {
 *     await session.close()
 *   }
 *
 * @param options - Optional session config (e.g., { database: 'neo4j' })
 * @returns Neo4j Session, or throws if Neo4j is unreachable
 */
export async function safeSession(options?: { database?: string }): Promise<Session> {
  const driver = await getNeo4jDriver()
  if (!driver) throw new Error('Neo4j driver not available — check if Neo4j Desktop is running')

  const dbParam = { database: options?.database || process.env.NEO4J_DATABASE || undefined }
  const session = driver.session(dbParam)

  // Quick liveness ping — detect zombie connections immediately
  // instead of letting the first real query fail after potentially long processing
  try {
    await session.run('RETURN 1 AS __ping__')
  } catch (pingError: any) {
    await session.close().catch(() => {})
    // Ping failed — driver pool may have stale connections (e.g., after laptop sleep)
    logNeo4jConnectFailure('safeSession ping — resetting driver', pingError)
    await resetNeo4jDriver()
    const freshDriver = await getNeo4jDriver()
    if (!freshDriver) throw new Error('Neo4j driver not available after reset')
    const freshSession = freshDriver.session(dbParam)
    // Verify the fresh session works
    try {
      await freshSession.run('RETURN 1 AS __ping__')
    } catch (retryPingError: any) {
      await freshSession.close().catch(() => {})
      throw new Error('Neo4j unreachable after driver reset: ' + (retryPingError instanceof Error ? retryPingError.message : String(retryPingError)))
    }
    return freshSession
  }

  return session
}

// ==================== HELPER: CONVERT NEO4J VALUES ====================

/**
 * Convert Neo4j Integer/Node/Path values to plain JS objects.
 * Handles neo4j-driver Integer objects by calling .toNumber() or .toString().
 */
export function toNative(val: unknown): unknown {
  if (val === null || val === undefined) return val
  if (typeof val === 'object' && val !== null) {
    // Neo4j Integer
    if (typeof (val as { toNumber?: unknown }).toNumber === 'function') {
      return (val as { toNumber: () => number }).toNumber()
    }
    // Neo4j Node
    if (typeof (val as { properties?: unknown; labels?: unknown }).properties === 'object') {
      const node = val as { properties: Record<string, unknown>; labels: string[] }
      // toNative trả unknown — cast về record để spread (primitive spread ra {} ở runtime, vô hại)
      return { ...(toNative(node.properties) as Record<string, unknown>), _labels: node.labels }
    }
    // Neo4j Relationship
    if (typeof (val as { properties?: unknown; type?: unknown }).properties === 'object' && typeof (val as { type?: unknown }).type === 'string') {
      const rel = val as { properties: Record<string, unknown>; type: string }
      // toNative trả unknown — cast về record để spread (primitive spread ra {} ở runtime, vô hại)
      return { ...(toNative(rel.properties) as Record<string, unknown>), _type: rel.type }
    }
    // Neo4j Path
    if (typeof (val as { segments?: unknown }).segments === 'object') {
      return val
    }
    // Plain object — recurse
    if (!Array.isArray(val)) {
      const result: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
        result[k] = toNative(v)
      }
      return result
    }
  }
  if (Array.isArray(val)) {
    return val.map(toNative)
  }
  return val
}

// ==================== HEALTH CHECK ====================

/**
 * Health-check result cache (globalThis — survives dev hot reload).
 *
 * The /api/health endpoint is polled every 10s per browser tab, and the health
 * check runs up to 5 sequential Cypher queries against AuraDB (cloud!). At
 * 200-500ms per round trip that was ~30 cloud queries/minute/tab, including a
 * FULL node label scan. This cache cuts that to ~3 re-computes/minute.
 */
const globalForNeo4jHealth = globalThis as unknown as {
  __neo4jHealthCache?: { data: Neo4jHealthResult; ts: number }
}
const NEO4J_HEALTH_CACHE_TTL_MS = 20_000 // 20s — halves Aura load at 10s poll intervals

type Neo4jHealthResult = {
  connected: boolean
  uri?: string
  nodeCount?: number
  relationshipCount?: number
  labels?: string[]
  entityCounts?: Record<string, number>
  error?: string
}

// FIX #8 (display bug): accept optional `force` flag to bypass the 20s cache.
// Without this, the dashboard's Neo4j info panel stays stale for up to 20s
// after a "Tiếp tục" completes — even when fetchHealth() is called in the
// .finally() block, the server returns the cached count from before the
// pipeline ran, so the user sees "no change" in nodes/rels counts.
export async function checkNeo4jHealth(force: boolean = false): Promise<Neo4jHealthResult> {
  // Cache hit? (both success and failure results — prevents hammering Aura
  // during an outage too). Force-refresh happens naturally after TTL expiry
  // OR when the caller passes force=true (e.g. right after a pipeline run).
  if (!force) {
    const cached = globalForNeo4jHealth.__neo4jHealthCache
    if (cached && Date.now() - cached.ts < NEO4J_HEALTH_CACHE_TTL_MS) {
      return cached.data
    }
  }

  const data = await checkNeo4jHealthUncached()
  globalForNeo4jHealth.__neo4jHealthCache = { data, ts: Date.now() }
  return data
}

async function checkNeo4jHealthUncached(): Promise<Neo4jHealthResult> {
  try {
    const uri = process.env.NEO4J_URI
    const user = process.env.NEO4J_USER
    const password = process.env.NEO4J_PASSWORD

    if (!uri || !user || !password) {
      return {
        connected: false,
        error: 'Missing NEO4J_URI, NEO4J_USER, or NEO4J_PASSWORD env vars',
      }
    }

    let driver = await getNeo4jDriver()
    if (!driver) {
      await resetNeo4jDriver()
      driver = await getNeo4jDriver()
    }
    if (!driver) {
      // FIX 2026-09-03: báo nguyên nhân THẬT (logNeo4jConnectFailure lưu) thay vì
      // đoán mò "DNS resolution failed" — đoán này từng che khuất lỗi thật
      // "database 'neo4j' does not exist" (AuraDB đặt tên DB theo instance-id)
      // trong khi DNS + port Bolt + auth đều bình thường.
      const realErr = globalForNeo4jFailLog.__neo4jLastError
      const dbHint = realErr && /database .*does not exist/i.test(realErr)
        ? ' (Kiểm tra NEO4J_DATABASE trong .env — AuraDB thường đặt tên DB theo instance-id, KHÔNG phải "neo4j")'
        : ''
      return {
        connected: false,
        error: realErr
          ? `Neo4j unreachable — lỗi thật: ${realErr}${dbHint}`
          : 'Neo4j unreachable (DNS resolution failed or connection refused). Check if instance is running — AuraDB may be paused, or Desktop may not be started.',
      }
    }

    // 1. Basic connectivity test — with zombie driver recovery
    // If ping fails but driver object exists (non-null), the driver's
    // connection pool is stale. Reset the driver and retry once.
    // OPTIMIZATION (Phase 5.1): Use a SINGLE session for all health check queries
    // instead of creating 5 separate sessions (ping + node count + rel count + labels + entity counts).
    // This reduces pool consumption from 50% to ~10% of the max pool size.
    const dbParam = { database: process.env.NEO4J_DATABASE || undefined }
    let session = driver.session(dbParam)
    try {
      await session.run('RETURN 1 AS test')
    } catch (pingError: any) {
      await session.close().catch(() => {})
      // Driver object exists but connections are dead — RESET DRIVER
      logNeo4jConnectFailure('health check ping (driver may be zombie) — resetting driver', pingError)
      await resetNeo4jDriver()
      driver = await getNeo4jDriver()
      if (!driver) {
        return {
          connected: false,
          error: 'Neo4j unreachable after driver reset: ' + (pingError instanceof Error ? pingError.message : String(pingError)),
        }
      }
      // Retry ping with fresh driver
      try {
        session = driver.session(dbParam)
        await session.run('RETURN 1 AS test')
        console.log('[Neo4j] Driver reset successful — reconnected')
        resetNeo4jFailLogState() // kết nối lại thành công → reset throttle
      } catch (retryError: any) {
        await session.close().catch(() => {})
        return {
          connected: false,
          error: 'Neo4j unreachable after driver reset: ' + (retryError instanceof Error ? retryError.message : String(retryError)),
        }
      }
    }

    const maskedUri = (process.env.NEO4J_URI || '').replace(/\/\/[^@]+@/, '//***@')
    const result: {
      connected: boolean
      uri: string
      nodeCount: number
      relationshipCount: number
      labels: string[]
      entityCounts: Record<string, number>
    } = {
      connected: true,
      uri: maskedUri,
      nodeCount: 0,
      relationshipCount: 0,
      labels: [],
      entityCounts: {},
    }

    // All remaining queries reuse the same session — avoids creating 4 extra sessions
    try {
      // 2. Node count
      const nodeResult = await session.executeRead((tx) =>
        tx.run('MATCH (n) RETURN count(n) AS nodeCount')
      )
      const nodeVal = nodeResult.records[0]?.get('nodeCount')
      result.nodeCount = typeof nodeVal?.toNumber === 'function' ? nodeVal.toNumber() : (nodeVal ?? 0)
    } catch (err) {
      console.warn('[Neo4j] Node count query failed:', err instanceof Error ? err.message : String(err))
    }

    try {
      // 3. Relationship count
      const relResult = await session.executeRead((tx) =>
        tx.run('MATCH ()-[r]->() RETURN count(r) AS relCount')
      )
      const relVal = relResult.records[0]?.get('relCount')
      result.relationshipCount = typeof relVal?.toNumber === 'function' ? relVal.toNumber() : (relVal ?? 0)
    } catch (err) {
      console.warn('[Neo4j] Relationship count query failed:', err instanceof Error ? err.message : String(err))
    }

    try {
      // 4. Labels
      const labelResult = await session.executeRead((tx) =>
        tx.run('CALL db.labels() YIELD label RETURN collect(label) AS labels')
      )
      result.labels = labelResult.records[0]?.get('labels') ?? []
    } catch (err) {
      console.warn('[Neo4j] Labels query failed (non-critical):', err instanceof Error ? err.message : String(err))
    }

    try {
      // 5. Per-label entity counts (enhanced health info)
      const countResult = await session.executeRead((tx) =>
        tx.run(
          `MATCH (n) WHERE size(labels(n)) > 0
           WITH labels(n) AS lbls UNWIND lbls AS lbl
           RETURN lbl AS label, count(*) AS cnt
           ORDER BY cnt DESC`
        )
      )
      for (const record of countResult.records) {
        const label = record.get('label')
        const cnt = record.get('cnt')
        result.entityCounts[label] = typeof cnt?.toNumber === 'function' ? cnt.toNumber() : (cnt ?? 0)
      }
    } catch (err) {
      console.warn('[Neo4j] Entity count query failed (non-critical):', err instanceof Error ? err.message : String(err))
    }

    // Close the single shared session
    await session.close()

    return result
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err)
    return { connected: false, error: errorMessage }
  }
}

// ==================== SCHEMA INITIALIZATION ====================

/**
 * Initialize Neo4j constraints and indexes for the GraphRAG schema.
 *
 * Enhanced schema includes:
 *   - UNIQUE constraint on `id` for all entity labels + Document
 *   - Indexes on `name` for ALL entity labels (not just some)
 *   - Indexes on `domain` for ALL entity labels
 *   - Index on `documentId` for fast document-scoped queries
 *   - Index on `entity_type` for filtering by type (redundant with labels but useful for queries)
 *   - Full-text index on entity names for CONTAINS searches
 *
 * @returns Object with count of constraints and indexes created
 */
export async function initializeNeo4jSchema(): Promise<{
  constraints: number
  indexes: number
}> {
  const constraintQueries = ENTITY_LABELS.map(
    (label) => `CREATE CONSTRAINT IF NOT EXISTS FOR (n:${label}) REQUIRE n.id IS UNIQUE`
  )

  const indexQueries: string[] = []

  // Name indexes for ALL entity labels (previously missing for Language, System, Principle, Document, Person)
  for (const label of ENTITY_LABELS) {
    indexQueries.push(`CREATE INDEX IF NOT EXISTS FOR (n:${label}) ON (n.name)`)
  }

  // Domain indexes for ALL entity labels
  for (const label of ENTITY_LABELS) {
    indexQueries.push(`CREATE INDEX IF NOT EXISTS FOR (n:${label}) ON (n.domain)`)
  }

  // documentId index for fast document-scoped deletion/querying
  for (const label of ENTITY_LABELS) {
    indexQueries.push(`CREATE INDEX IF NOT EXISTS FOR (n:${label}) ON (n.documentId)`)
  }

  // entity_type index on generic base (useful for mixed-label queries)
  indexQueries.push(`CREATE INDEX IF NOT EXISTS FOR (n:Concept) ON (n.entity_type)`)
  indexQueries.push(`CREATE INDEX IF NOT EXISTS FOR (n:Document) ON (n.status)`)

  // Full-text index on entity names for CONTAINS / fuzzy search
  // This is MUCH faster than per-label CONTAINS scans
  //
  // ROUND-32 P1-b: index này giờ do migrateFulltextIndex() quản lý trọn đời
  // (tạo + TỰ CHỮA khi định nghĩa lệch chuẩn — xem cuối initializeNeo4jSchema).
  // Chỉ tạo khi CHƯA TỒN TẠI ở đây; nhánh index cũ sai label sẽ bị migration
  // DROP+CREATE lại với FULLTEXT_INDEX_LABELS (8 label mới + 5 legacy).
  indexQueries.push(
    `CREATE FULLTEXT INDEX entity_name_search IF NOT EXISTS FOR (n:${FULLTEXT_INDEX_LABELS.join('|')}) ON EACH [n.name]`
  )

  // Phase 2 SMOLAB Prop 2.5 — Vector indexes for embedding-based entity resolution.
  // One per label (Neo4j 5.x vector indexes are per-label, not multi-label).
  // Aura tier confirmed supports VECTOR indexes (Neo4j 5.27-aura Enterprise),
  // CREATE VECTOR INDEX succeeds, db.index.vector.queryNodes procedure registered,
  // vector.similarity.cosine scalar function registered.
  //
  // NOTE: Aura 5.27-aura rejects `CREATE VECTOR INDEX IF NOT EXISTS name ...`
  // with SyntaxError ("expected 'FOR'"). The `IF NOT EXISTS` clause is parsed
  // differently on Aura — workaround is to use plain `CREATE VECTOR INDEX name`
  // and rely on the existing catch block's "already exists" substring match to
  // treat duplicate-create as success (idempotent behavior).
  // Vector dim sourced from EMBEDDING_DIMENSION (embeddings.ts — nguồn duy nhất, P2-c).
  for (const label of ENTITY_LABELS) {
    indexQueries.push(
      `CREATE VECTOR INDEX entity_embedding_${label.toLowerCase()}
       FOR (n:${label}) ON (n.embedding)
       OPTIONS { indexConfig: { \`vector.dimensions\`: ${getEmbeddingDimension()}, \`vector.similarity_function\`: 'cosine' } }`
    )
  }

  let constraints = 0
  let indexes = 0

  // Run constraint queries
  for (const query of constraintQueries) {
    try {
      const session = await getSession()
      try {
        await session.executeWrite((tx) => tx.run(query))
        constraints++
      } finally {
        await session.close()
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('already exists')) {
        constraints++
      } else {
        console.error(`[Neo4j] Constraint failed: ${msg}`)
      }
    }
    await new Promise((r) => setTimeout(r, 100))
  }

  // Run index queries
  for (const query of indexQueries) {
    try {
      const session = await getSession()
      try {
        await session.executeWrite((tx) => tx.run(query))
        indexes++
      } finally {
        await session.close()
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('already exists') || msg.includes('EquivalentIndex')) {
        indexes++
      } else {
        console.warn(`[Neo4j] Index warning: ${msg}`)
      }
    }
    await new Promise((r) => setTimeout(r, 100))
  }

  // ROUND-32 P1-b — tự chữa định nghĩa fulltext index nếu đang lệch chuẩn.
  // Chạy SAU vòng indexQueries phía trên: trường hợp index chưa tồn tại thì
  // CREATE ở trên đã lo; trường hợp tồn tại với ĐỊNH NGHĨA CŨ (thiếu
  // Technology/Framework, thừa label đã bỏ) thì chỉ DROP+CREATE mới sửa được.
  await migrateFulltextIndex()

  console.log(`[Neo4j] Schema initialized: ${constraints} constraints, ${indexes} indexes — fulltext labels = ${FULLTEXT_INDEX_LABELS.join('|')}`)
  return { constraints, indexes }
}

/**
 * ROUND-32 P1-b — Migrate fulltext index entity_name_search (idempotent).
 *
 * SHOW INDEXES so sánh labelsOrTypes với FULLTEXT_INDEX_LABELS:
 *   - khớp → no-op (boot hàng ngày không tốn gì thêm)
 *   - lệch → DROP INDEX + CREATE lại với label chuẩn
 *   - chưa có → CREATE (lớp phòng thủ 2, CREATE ở indexQueries đã phủ)
 *
 * Fail-open: lỗi Aura/timeout không được làm chết boot — chỉ warn (các query
 * dùng index sẽ cảnh báo theo đường riêng của chúng).
 */
async function migrateFulltextIndex(): Promise<void> {
  try {
    const session = await getSession()
    try {
      const info = await session.executeRead((tx) => tx.run(
        `SHOW INDEXES YIELD name, labelsOrTypes WHERE name = 'entity_name_search' RETURN labelsOrTypes`
      ))
      const current = (info.records[0]?.get('labelsOrTypes') as string[] | undefined) ?? null
      const wanted = [...FULLTEXT_INDEX_LABELS].sort()
      const currentSorted = current ? [...current].sort() : null

      if (currentSorted && JSON.stringify(currentSorted) === JSON.stringify(wanted)) {
        return // định nghĩa đã đúng — idempotent
      }

      if (currentSorted) {
        // Index tồn tại với định nghĩa cũ — CREATE IF NOT EXISTS không bao giờ
        // sửa được index sẵn có; buộc DROP rồi tạo lại đúng chuẩn.
        await session.executeWrite((tx) => tx.run(`DROP INDEX entity_name_search IF EXISTS`))
        console.log(`[Neo4j] P1-b migrate fulltext: DROP index cũ (labels lệch chuẩn: [${currentSorted.join(', ')}] → kỳ vọng [${wanted.join(', ')}])`)
      }

      await session.executeWrite((tx) => tx.run(
        `CREATE FULLTEXT INDEX entity_name_search IF NOT EXISTS FOR (n:${FULLTEXT_INDEX_LABELS.join('|')}) ON EACH [n.name]`
      ))
      console.log(`[Neo4j] P1-b: fulltext entity_name_search tạo với ${FULLTEXT_INDEX_LABELS.length} label (8 mới + 5 legacy)`)
    } finally {
      await session.close()
    }
  } catch (err) {
    console.warn('[Neo4j] P1-b fulltext migration failed (non-fatal):', err instanceof Error ? err.message : String(err))
  }
}

// ==================== DRIVER CLEANUP ====================

export async function resetNeo4jDriver(): Promise<void> {
  if (globalForNeo4j.neo4jDriver) {
    try {
      await globalForNeo4j.neo4jDriver.close()
    } catch {
      // Ignore close errors
    }
    globalForNeo4j.neo4jDriver = undefined
    console.log('[Neo4j] Driver reset — next operation will create a fresh connection')
  }
}


// ==================== CYPHER EXECUTION (backward compat) ====================

/**
 * Execute a write Cypher query and return results
 */
export async function executeCypher<T = Record<string, unknown>>(
  query: string,
  params: Record<string, unknown> = {}
): Promise<T[]> {
  return withNeo4jRetry(async () => {
    const session = await getSession()
    try {
      const result = await session.executeWrite((tx) => tx.run(query, params))
      return result.records.map((record) => {
        const obj: Record<string, unknown> = {}
        for (const key of record.keys as string[]) {
          obj[key] = toNative(record.get(key))
        }
        return obj as T
      })
    } finally {
      await session.close()
    }
  })
}

/**
 * Execute a read-only Cypher query
 */
export async function readCypher<T = Record<string, unknown>>(
  query: string,
  params: Record<string, unknown> = {}
): Promise<T[]> {
  return withNeo4jRetry(async () => {
    const session = await getSession()
    try {
      const result = await session.executeRead((tx) => tx.run(query, params))
      return result.records.map((record) => {
        const obj: Record<string, unknown> = {}
        for (const key of record.keys as string[]) {
          obj[key] = toNative(record.get(key))
        }
        return obj as T
      })
    } finally {
      await session.close()
    }
  })
}

// ==================== ENTITY OPERATIONS ====================

/**
 * Upsert a single entity node into Neo4j.
 *
 * Sets BOTH camelCase and snake_case property aliases for backward compatibility:
 *   - n.name AND n.entity_name
 *   - n.documentId AND n.document_id
 *   - n.confidence AND n.confidence_score
 *   - n.entity_type (as property, redundant with label but needed for API reads)
 */
export async function upsertEntity(entity: EntityNode): Promise<boolean> {
  return withNeo4jRetry(async () => {
    const label = sanitizeLabel(entity.entity_type)
    const now = new Date().toISOString()

    const session = await getSession()
    try {
      await session.executeWrite((tx) =>
        tx.run(
          `MERGE (n:${label} {id: $id})
           ON CREATE SET n.name = $name, n.entity_name = $name, n.entity_type = $entityType,
                         n.domain = $domain, n.description = $description,
                         n.confidence = $confidence, n.confidence_score = $confidence,
                         n.source = $source, n.occurrence_count = 1,
                         n.created_at = $createdAt, n.updated_at = $updatedAt
           ON MATCH SET  n.name = $name, n.entity_name = $name, n.entity_type = $entityType,
                         n.domain = CASE WHEN $domain <> '' THEN $domain ELSE n.domain END,
                         n.description = CASE WHEN $description <> '' AND size($description) > size(COALESCE(n.description, '')) THEN $description ELSE n.description END,
                         n.confidence = CASE WHEN $confidence > COALESCE(n.confidence, 0) THEN $confidence ELSE n.confidence END,
                         n.confidence_score = CASE WHEN $confidence > COALESCE(n.confidence_score, 0) THEN $confidence ELSE n.confidence_score END,
                         n.occurrence_count = COALESCE(n.occurrence_count, 1) + 1,
                         n.updated_at = $updatedAt`,
          {
            id: entity.id,
            name: entity.name,
            entityType: entity.entity_type,
            domain: entity.domain,
            description: entity.description,
            confidence: entity.confidence,
            documentId: entity.documentId,
            source: entity.source || 'llm',
            createdAt: entity.created_at || now,
            updatedAt: now,
          }
        )
      )
      return true
    } finally {
      await session.close()
    }
  }).catch((err) => {
    console.error('[Neo4j] Entity upsert error:', err instanceof Error ? err.message : String(err))
    return false
  })
}

/**
 * Batch upsert entities by label.
 * Groups entities by their label for efficient UNWIND batching.
 *
 * @param entities Array of entity nodes to upsert
 * @param documentId Document ID for batch operations
 * @returns Number of entities successfully upserted
 */
export async function upsertEntitiesBatch(
  entities: EntityNode[],
  documentId: string
): Promise<number> {
  if (entities.length === 0) return 0

  let upserted = 0
  const now = new Date().toISOString()

  // Group by label for efficient batching
  const byLabel = new Map<string, EntityNode[]>()
  for (const entity of entities) {
    const label = sanitizeLabel(entity.entity_type)
    if (!byLabel.has(label)) byLabel.set(label, [])
    byLabel.get(label)!.push(entity)
  }

  // Batch upsert per label (500 per batch)
  // Each batch is wrapped with withNeo4jRetry for transient error recovery
  const BATCH_SIZE = 500
  for (const [label, labelEntities] of byLabel) {
    for (let i = 0; i < labelEntities.length; i += BATCH_SIZE) {
      const batch = labelEntities.slice(i, i + BATCH_SIZE)
      try {
        await withNeo4jRetry(async () => {
          const session = await getSession()
          try {
            await session.executeWrite((tx) =>
              tx.run(
                `UNWIND $entities AS e
                 MERGE (n:${label} {id: e.id})
                 ON CREATE SET n.name = e.name, n.entity_name = e.name, n.entity_type = e.entityType,
                               n.domain = e.domain, n.description = e.description,
                               n.confidence = e.confidence, n.confidence_score = e.confidence,
                               n.source = e.source, n.occurrence_count = 1,
                               n.created_at = e.createdAt, n.updated_at = $updatedAt,
                               n.embedding = CASE WHEN e.embedding IS NOT NULL THEN e.embedding ELSE n.embedding END
                 ON MATCH SET  n.name = e.name, n.entity_name = e.name, n.entity_type = e.entityType,
                               n.domain = CASE WHEN e.domain <> '' THEN e.domain ELSE n.domain END,
                               n.description = CASE WHEN e.description <> '' AND size(e.description) > size(COALESCE(n.description, '')) THEN e.description ELSE n.description END,
                               n.confidence = CASE WHEN e.confidence > COALESCE(n.confidence, 0) THEN e.confidence ELSE n.confidence END,
                               n.confidence_score = CASE WHEN e.confidence > COALESCE(n.confidence_score, 0) THEN e.confidence ELSE n.confidence_score END,
                               n.occurrence_count = COALESCE(n.occurrence_count, 1) + 1,
                               n.updated_at = $updatedAt,
                               n.embedding = CASE WHEN e.embedding IS NOT NULL THEN e.embedding ELSE n.embedding END`,
                {
                  entities: batch.map(e => ({
                    id: e.id,
                    name: e.name,
                    entityType: e.entity_type,
                    domain: e.domain,
                    description: e.description,
                    confidence: e.confidence,
                    documentId: e.documentId,
                    source: e.source || 'llm',
                    createdAt: e.created_at || now,
                    // Phase 2 SMOLAB Prop 2.5 — pass embedding through to Neo4j
                    // for embedding-based entity resolution. Undefined/null is OK —
                    // the CASE WHEN guard skips the assignment (preserves existing).
                    embedding: e.embedding ?? null,
                  })),
                  updatedAt: now,
                }
              )
            )
          } finally {
            await session.close()
          }
        })
        upserted += batch.length
      } catch (err) {
        console.error(`[Neo4j] Batch entity upsert error (${label}):`, err instanceof Error ? err.message : String(err))
        // Fallback: try individual upserts for this batch
        for (const entity of batch) {
          const success = await upsertEntity(entity)
          if (success) upserted++
        }
      }
    }
  }

  // Ghi chú (audit kg-arch-a): MERGE (label, id) KHÔNG có MATCH precondition
  // như relationships → không tồn tại drop lặng lẽ; count hiện tại ĐÚNG
  // (batch thành công = batch.length node được MERGE, fallback đếm từng node).
  console.log(`[Neo4j] upsertEntitiesBatch: ${upserted} upserted, ${entities.length - upserted} failed`)

  return upserted
}


/**
 * Get all entities for a document.
 * Uses CONTAINS relationships (Document→Entity) for cross-document entity dedup.
 * With global entity IDs, entities are shared across documents, so we find them
 * via the CONTAINS relationship rather than by documentId property on the entity.
 * Returns entities ordered by name.
 */
export async function getEntitiesByDocument(documentId: string): Promise<EntityNode[]> {
  return withNeo4jRetry(async () => {
    const session = await getSession()
    try {
      const result = await session.executeRead((tx) =>
        tx.run(
          `MATCH (d:Document {id: $documentId})-[:CONTAINS]->(n)
           WHERE n.entity_type IS NOT NULL
           RETURN n ORDER BY n.name`,
          { documentId }
        )
      )
      return result.records.map((record) => {
        const node = record.get('n')
        const props = toNative(node.properties) as Record<string, unknown>
        const labels = node.labels as string[]
        return {
          id: props.id as string,
          name: (props.entity_name as string) || (props.name as string) || '',
          entity_type: (props.entity_type as EntityLabel) || labels.find(l => isValidLabel(l)) as EntityLabel || 'Concept',
          domain: (props.domain as string) || '',
          description: (props.description as string) || '',
          confidence: (props.confidence_score as number) ?? (props.confidence as number) ?? 0,
          documentId: (props.document_id as string) || (props.documentId as string) || '',
          source: props.source as string | undefined,
          chunk_id: props.chunk_id as string | undefined,
          created_at: (props.created_at as string) || '',
          updated_at: (props.updated_at as string) || '',
        }
      })
    } finally {
      await session.close()
    }
  }).catch((err) => {
    console.error('[Neo4j] Get entities by document error:', err instanceof Error ? err.message : String(err))
    return []
  })
}

/**
 * Search entities by name (text search).
 * Uses the full-text index `entity_name_search` for fast fuzzy matching,
 * falls back to CONTAINS scan if the fulltext index is unavailable.
 */
export async function searchEntities(
  query: string,
  options?: {
    limit?: number
    domain?: string
    entityType?: string
  }
): Promise<Array<{ name: string; type: string; domain: string; description: string }>> {
  const limit = Math.floor(options?.limit || 20)
  return withNeo4jRetry(async () => {
    const session = await getSession()
    try {
      // Try fulltext index first — much faster than CONTAINS scan
      try {
        const ftParams: Record<string, unknown> = { term: `${query}*`, limit }
        let ftCypher = `CALL db.index.fulltext.queryNodes('entity_name_search', $term) YIELD node AS n, score
                        WHERE n.entity_type IS NOT NULL`
        if (options?.domain) {
          ftCypher += ` AND n.domain = $domain`
          ftParams.domain = options.domain
        }
        if (options?.entityType && isValidLabel(options.entityType)) {
          ftCypher += ` AND $entityType IN labels(n)`
          ftParams.entityType = options.entityType
        }
        ftCypher += ` RETURN n.name AS name, n.entity_type AS type, n.domain AS domain, n.description AS description
                      ORDER BY score DESC LIMIT toInteger($limit)`

        const ftResult = await session.executeRead((tx) => tx.run(ftCypher, ftParams))
        if (ftResult.records.length > 0) {
          return ftResult.records.map((record) => ({
            name: (toNative(record.get('name')) as string) || '',
            type: (toNative(record.get('type')) as string) || '',
            domain: (toNative(record.get('domain')) as string) || '',
            description: (toNative(record.get('description')) as string) || '',
          }))
        }
      } catch (ftErr) {
        // Fulltext index not available — fall through to CONTAINS scan
        const msg = ftErr instanceof Error ? ftErr.message : String(ftErr)
        if (!msg.includes('index does not exist') && !msg.includes('Unknown index')) {
          console.warn('[Neo4j] Fulltext search failed, falling back to CONTAINS:', msg)
        }
      }

      // Fallback: CONTAINS scan (slower but always works)
      let cypher: string
      let params: Record<string, unknown>

      if (options?.entityType && isValidLabel(options.entityType)) {
        const label = sanitizeLabel(options.entityType)
        if (options.domain) {
          cypher = `MATCH (n:${label}) WHERE n.name CONTAINS $term AND n.domain = $domain
                    RETURN n.name AS name, n.entity_type AS type, n.domain AS domain, n.description AS description
                    ORDER BY n.name LIMIT toInteger($limit)`
          params = { term: query, domain: options.domain, limit }
        } else {
          cypher = `MATCH (n:${label}) WHERE n.name CONTAINS $term
                    RETURN n.name AS name, n.entity_type AS type, n.domain AS domain, n.description AS description
                    ORDER BY n.name LIMIT toInteger($limit)`
          params = { term: query, limit }
        }
      } else if (options?.domain) {
        cypher = `MATCH (n) WHERE n.name CONTAINS $term AND n.domain = $domain AND n.entity_type IS NOT NULL
                  RETURN n.name AS name, n.entity_type AS type, n.domain AS domain, n.description AS description
                  ORDER BY n.name LIMIT toInteger($limit)`
        params = { term: query, domain: options.domain, limit }
      } else {
        cypher = `MATCH (n) WHERE n.name CONTAINS $term AND n.entity_type IS NOT NULL
                  RETURN n.name AS name, n.entity_type AS type, n.domain AS domain, n.description AS description
                  ORDER BY n.name LIMIT toInteger($limit)`
        params = { term: query, limit }
      }

      const result = await session.executeRead((tx) => tx.run(cypher, params))
      return result.records.map((record) => ({
        name: (toNative(record.get('name')) as string) || '',
        type: (toNative(record.get('type')) as string) || '',
        domain: (toNative(record.get('domain')) as string) || '',
        description: (toNative(record.get('description')) as string) || '',
      }))
    } finally {
      await session.close()
    }
  }).catch((err) => {
    console.error('[Neo4j] Search entities error:', err instanceof Error ? err.message : String(err))
    return []
  })
}

/**
 * Delete entities associated with a document — cross-document safe.
 *
 * With global entity IDs, entities are shared across documents. We CANNOT
 * simply delete all nodes with a documentId property. Instead:
 * 1. Delete CONTAINS relationships from this Document to its entities
 * 2. Delete entity-to-entity relationships that originated from this document
 * 3. Delete orphaned entity nodes (no CONTAINS from ANY document)
 *
 * This preserves entities that are also referenced by other documents.
 */
export async function deleteEntitiesByDocument(documentId: string): Promise<number> {
  return withNeo4jRetry(async () => {
    let totalDeleted = 0
    const session = await getSession()
    try {
      // Step 0 (DATA-LOSS FIX 2026-08-31): capture the entity IDs that THIS document
      // currently references via CONTAINS. The orphan cleanup in Step 4 is restricted
      // to this set. Previously Step 4 ran a GLOBAL sweep
      // (`MATCH (n) WHERE n.entity_type IS NOT NULL AND NOT (n)<-[:CONTAINS]-(:Document)
      //   DETACH DELETE n` × 10 batches × 5000) which deleted ANY unlinked entity in
      // the whole graph — including resolved/orphan entities from sync-neo4j and
      // auto-learn/writeback entities from chat (they had no CONTAINS edges).
      // That global sweep was the root cause of losing nodes + rels in Neo4j Aura.
      let affectedEntityIds: string[] = []
      try {
        const preRead = await session.executeRead(tx =>
          tx.run(
            `MATCH (d:Document {id: $documentId})-[:CONTAINS]->(e)
             WHERE e.id IS NOT NULL
             RETURN collect(e.id) AS ids`,
            { documentId }
          )
        )
        const rawIds = (preRead.records[0]?.get('ids') ?? []) as Array<unknown>
        affectedEntityIds = rawIds.filter((v): v is string => typeof v === 'string')
      } catch (err) {
        // Read failure → safest is to skip orphan cleanup entirely (keep data)
        console.warn(`[Neo4j] deleteEntitiesByDocument: failed to capture referenced entities, skipping orphan cleanup:`, err instanceof Error ? err.message : String(err))
        affectedEntityIds = []
      }

      // Step 1: Delete CONTAINS relationships for this document
      await session.executeWrite((tx) =>
        tx.run(
          `MATCH (d:Document {id: $documentId})-[r:CONTAINS]->(e) DELETE r`,
          { documentId }
        )
      )

      // Step 2: Delete entity-to-entity relationships from this document
      const relResult = await session.executeWrite((tx) =>
        tx.run(
          `MATCH ()-[r]->() WHERE (r.documentId = $documentId OR r.document_id = $documentId) AND NOT type(r) = 'CONTAINS' DELETE r RETURN count(r) AS deleted`,
          { documentId }
        )
      )
      const relsDeleted = relResult.records[0]?.get('deleted')
      totalDeleted += typeof relsDeleted?.toNumber === 'function' ? relsDeleted.toNumber() : (relsDeleted ?? 0) as number

      // Step 3: Delete legacy per-document nodes (old `docId__name__type` ID scheme)
      const idPrefix = `${documentId}__`
      let hasMore = true
      let maxBatches = 50
      while (hasMore && maxBatches > 0) {
        const result = await session.executeWrite((tx) =>
          tx.run(
            `MATCH (n) WHERE n.id STARTS WITH $idPrefix WITH n LIMIT 5000 DETACH DELETE n RETURN count(n) AS deleted`,
            { idPrefix }
          )
        )
        const deleted = result.records[0]?.get('deleted')
        const num = typeof deleted?.toNumber === 'function' ? deleted.toNumber() : (deleted ?? 0) as number
        totalDeleted += num
        hasMore = num >= 5000
        maxBatches--
      }

      // Step 4 (DATA-LOSS FIX 2026-08-31): delete orphaned entity nodes — SCOPED to
      // entities this document previously referenced (captured in Step 0). Only those
      // that are now unreferenced by ANY document are deleted. Entities from other
      // sources (resolved/orphan/auto-learn/writeback) are never touched here.
      let orphanBatches = Math.ceil(affectedEntityIds.length / 1000)
      while (orphanBatches > 0) {
        const batch = affectedEntityIds.splice(0, 1000)
        if (batch.length === 0) break
        const orphanResult = await session.executeWrite((tx) =>
          tx.run(
            `UNWIND $ids AS eid
             MATCH (n {id: eid})
             WHERE n.entity_type IS NOT NULL AND NOT (n)<-[:CONTAINS]-(:Document)
             DETACH DELETE n
             RETURN count(n) AS deleted`,
            { ids: batch }
          )
        )
        const orphanDeleted = orphanResult.records[0]?.get('deleted')
        const orphanNum = typeof orphanDeleted?.toNumber === 'function' ? orphanDeleted.toNumber() : (orphanDeleted ?? 0) as number
        totalDeleted += orphanNum
        orphanBatches--
      }

      console.log(`[Neo4j] deleteEntitiesByDocument(${documentId.slice(0, 8)}...): deleted ${totalDeleted} total (rels + legacy nodes + orphans)`)
    } finally {
      await session.close()
    }
    return totalDeleted
  }).catch((err) => {
    console.error('[Neo4j] Delete entities by document error:', err instanceof Error ? err.message : String(err))
    return 0
  })
}

// ==================== CROSS-DOCUMENT MERGE UTILITY ====================

/**
 * Merge existing per-document entity nodes into global entity nodes.
 *
 * This is a MIGRATION UTILITY for converting the old per-document ID scheme
 * (`docId__name__type`) to the new global ID scheme (`global__name__type`).
 *
 * Process:
 * 1. Find all nodes with per-document IDs (matching `___` pattern or `documentId__` prefix)
 * 2. Group them by (name, type) across all documents
 * 3. For each group, create ONE global node with merged properties
 * 4. Re-point all relationships from old node IDs to the new global node ID
 * 5. Create CONTAINS relationships from Document nodes to the global entity
 * 6. Delete the old per-document nodes
 *
 * Returns merge statistics.
 */
export async function mergePerDocumentNodesToGlobal(): Promise<{
  totalScanned: number
  groupsMerged: number
  globalNodesCreated: number
  relationshipsRepointed: number
  oldNodesDeleted: number
  errors: string[]
}> {
  const errors: string[] = []
  let totalScanned = 0
  let groupsMerged = 0
  let globalNodesCreated = 0
  let relationshipsRepointed = 0
  let oldNodesDeleted = 0

  const driver = await getNeo4jDriver()
  if (!driver) {
    errors.push('Neo4j driver not available')
    return { totalScanned, groupsMerged, globalNodesCreated, relationshipsRepointed, oldNodesDeleted, errors }
  }

  const session = driver.session({ database: process.env.NEO4J_DATABASE || undefined })
  try {
    // Step 1: Find all per-document entity nodes (old ID scheme)
    // These have IDs matching the pattern: `docId__name__type` (at least 2 double underscores)
    // but NOT `global__name__type` (new scheme) or `resolved__name__type`
    const scanResult = await session.executeRead(tx =>
      tx.run(
        `MATCH (n) WHERE n.entity_type IS NOT NULL AND n.id IS NOT NULL
         AND NOT n.id STARTS WITH 'global__'
         AND NOT n.id STARTS WITH 'resolved__'
         AND NOT n.id STARTS WITH 'orphan__'
         AND NOT n.entity_type = 'Document'
         RETURN n.id AS id, n.name AS name, n.entity_name AS entityName, n.entity_type AS entityType,
                n.domain AS domain, n.description AS description,
                n.confidence AS confidence, n.confidence_score AS confidenceScore,
                n.documentId AS documentId, n.document_id AS documentId2,
                n.occurrence_count AS occurrenceCount,
                n.created_at AS createdAt, n.updated_at AS updatedAt,
                labels(n) AS labels`
      )
    )

    const oldNodes = scanResult.records.map(r => ({
      id: r.get('id') as string,
      name: (r.get('entityName') as string) || (r.get('name') as string) || '',
      entityType: (r.get('entityType') as string) || 'Concept',
      domain: (r.get('domain') as string) || '',
      description: (r.get('description') as string) || '',
      confidence: (r.get('confidenceScore') as number) ?? (r.get('confidence') as number) ?? 0,
      documentId: (r.get('documentId') as string) || (r.get('documentId2') as string) || '',
      occurrenceCount: (r.get('occurrenceCount') as number) || 1,
      createdAt: (r.get('createdAt') as string) || '',
      updatedAt: (r.get('updatedAt') as string) || '',
      labels: r.get('labels') as string[],
    }))

    totalScanned = oldNodes.length
    if (totalScanned === 0) {
      console.log('[Neo4j Merge] No per-document nodes found — already migrated or empty database')
      return { totalScanned, groupsMerged, globalNodesCreated, relationshipsRepointed, oldNodesDeleted, errors }
    }

    console.log(`[Neo4j Merge] Found ${totalScanned} per-document entity nodes to merge`)

    // Step 2: Group by (name, type) — case-insensitive
    const groups = new Map<string, Array<typeof oldNodes[0]>>()
    for (const node of oldNodes) {
      const key = `${node.name.toLowerCase().trim()}||${node.entityType.toLowerCase().trim()}`
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key)!.push(node)
    }

    console.log(`[Neo4j Merge] ${totalScanned} nodes → ${groups.size} unique entity groups`)

    // Step 3: For each group, create a global node and re-point relationships
    let batchCount = 0
    for (const [key, group] of groups) {
      const [normalizedName, normalizedType] = key.split('||')
      const globalId = `global__${normalizedName.replace(/[^a-z0-9]/g, '_')}__${normalizedType}`

      // Pick best properties from the group
      const bestName = group.reduce((best, n) => n.name.length > best.name.length ? n : best, group[0]).name
      const bestDesc = group.reduce((best, n) => (n.description || '').length > (best.description || '').length ? n : best, group[0]).description || ''
      const bestConf = Math.max(...group.map(n => n.confidence || 0))
      const bestDomain = group.find(n => n.domain && n.domain !== 'mixed')?.domain || group[0].domain || 'mixed'
      const totalOccurrence = group.reduce((sum, n) => sum + (n.occurrenceCount || 1), 0)
      const safeLabel = normalizedType.replace(/[^a-zA-Z0-9_]/g, '_') || 'Concept'

      try {
        // Create/update the global node
        await session.executeWrite(tx =>
          tx.run(
            `MERGE (n:${safeLabel} {id: $id})
             ON CREATE SET n.name = $name, n.entity_name = $name, n.entity_type = $entityType,
                           n.domain = $domain, n.description = $description,
                           n.confidence = $confidence, n.confidence_score = $confidence,
                           n.source = 'merge', n.occurrence_count = $occurrenceCount,
                           n.created_at = $createdAt, n.updated_at = $updatedAt
             ON MATCH SET  n.name = $name, n.entity_name = $name, n.entity_type = $entityType,
                           n.domain = CASE WHEN $domain <> '' AND $domain <> 'mixed' THEN $domain ELSE n.domain END,
                           n.description = CASE WHEN $description <> '' AND size($description) > size(COALESCE(n.description, '')) THEN $description ELSE n.description END,
                           n.confidence = CASE WHEN $confidence > COALESCE(n.confidence, 0) THEN $confidence ELSE n.confidence END,
                           n.confidence_score = CASE WHEN $confidence > COALESCE(n.confidence_score, 0) THEN $confidence ELSE n.confidence_score END,
                           n.occurrence_count = COALESCE(n.occurrence_count, 1) + $occurrenceCount,
                           n.updated_at = $updatedAt`,
            {
              id: globalId,
              name: bestName,
              entityType: normalizedType,
              domain: bestDomain,
              description: bestDesc,
              confidence: bestConf,
              occurrenceCount: totalOccurrence,
              createdAt: group[0].createdAt || new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            }
          )
        )
        globalNodesCreated++
      } catch (err) {
        errors.push(`Failed to create global node "${globalId}": ${err instanceof Error ? err.message : String(err)}`)
        continue
      }

      // Re-point relationships and create CONTAINS for each old node
      for (const oldNode of group) {
        try {
          // Create CONTAINS relationship from Document to global entity
          if (oldNode.documentId) {
            await session.executeWrite(tx =>
              tx.run(
                `MATCH (d:Document {id: $documentId}), (e {id: $globalId})
                 MERGE (d)-[r:CONTAINS]->(e)
                 SET r.documentId = $documentId, r.document_id = $documentId`,
                { documentId: oldNode.documentId, globalId }
              )
            )
          }

          // Re-point incoming relationships to the global node
          const inResult = await session.executeWrite(tx =>
            tx.run(
              `MATCH (src)-[r]->(old {id: $oldId})
               WHERE NOT type(r) = 'CONTAINS'
               WITH src, r, old, type(r) AS relType, properties(r) AS relProps
               MATCH (target:${safeLabel} {id: $globalId})
               MERGE (src)-[newR:RELATED_TO]->(target)
               SET newR += relProps, newR.merged_from = $oldId
               DELETE r
               RETURN count(newR) AS repointed`,
              { oldId: oldNode.id, globalId }
            )
          )
          const inRepointed = inResult.records[0]?.get('repointed')?.toNumber?.() || 0
          relationshipsRepointed += inRepointed

          // Re-point outgoing relationships
          const outResult = await session.executeWrite(tx =>
            tx.run(
              `MATCH (old {id: $oldId})-[r]->(tgt)
               WHERE NOT type(r) = 'CONTAINS'
               WITH old, r, tgt, type(r) AS relType, properties(r) AS relProps
               MATCH (source:${safeLabel} {id: $globalId})
               MERGE (source)-[newR:RELATED_TO]->(tgt)
               SET newR += relProps, newR.merged_from = $oldId
               DELETE r
               RETURN count(newR) AS repointed`,
              { oldId: oldNode.id, globalId }
            )
          )
          const outRepointed = outResult.records[0]?.get('repointed')?.toNumber?.() || 0
          relationshipsRepointed += outRepointed

          // Delete the old node
          await session.executeWrite(tx =>
            tx.run(
              `MATCH (old {id: $oldId}) DETACH DELETE old RETURN count(old) AS deleted`,
              { oldId: oldNode.id }
            )
          )
          oldNodesDeleted++
        } catch (err) {
          errors.push(`Failed to merge old node "${oldNode.id}": ${err instanceof Error ? err.message : String(err)}`)
        }
      }

      groupsMerged++
      batchCount++
      if (batchCount % 100 === 0) {
        console.log(`[Neo4j Merge] Progress: ${batchCount}/${groups.size} groups processed, ${globalNodesCreated} global nodes, ${oldNodesDeleted} old nodes deleted`)
      }
    }

    console.log(`[Neo4j Merge] Complete: ${groupsMerged} groups merged, ${globalNodesCreated} global nodes, ${relationshipsRepointed} rels repointed, ${oldNodesDeleted} old nodes deleted`)
  } catch (err) {
    errors.push(`Fatal merge error: ${err instanceof Error ? err.message : String(err)}`)
  } finally {
    await session.close()
  }

  return { totalScanned, groupsMerged, globalNodesCreated, relationshipsRepointed, oldNodesDeleted, errors }
}

// ==================== RELATIONSHIP OPERATIONS ====================

/**
 * Upsert a single relationship with full metadata.
 *
 * Sets BOTH camelCase and snake_case property aliases:
 *   - rel.documentId AND rel.document_id
 *   - rel.confidence AND rel.confidence_score
 *   - rel.relationship_type (as property, redundant with Neo4j type but needed for API reads)
 */
export async function upsertRelationship(rel: RelationshipEdge): Promise<boolean> {
  return withNeo4jRetry(async () => {
    const relType = sanitizeLabel(rel.relationship_type)
    const now = new Date().toISOString()

    const session = await getSession()
    try {
      await session.executeWrite((tx) =>
        tx.run(
          `MATCH (a {id: $sourceId}), (b {id: $targetId})
           MERGE (a)-[r:${relType}]->(b)
           SET r.documentId = $documentId,
               r.document_id = $documentId,
               r.description = $description,
               r.confidence = $confidence,
               r.confidence_score = $confidence,
               r.source = $source,
               r.relationship_type = $relType,
               r.source_entity_id = $sourceId,
               r.target_entity_id = $targetId,
               r.created_at = $createdAt`,
          {
            sourceId: rel.sourceId,
            targetId: rel.targetId,
            documentId: rel.documentId,
            description: rel.description || '',
            confidence: rel.confidence || 0,
            source: rel.source || 'llm',
            relType: rel.relationship_type,
            createdAt: rel.created_at || now,
          }
        )
      )
      return true
    } finally {
      await session.close()
    }
  }).catch((err) => {
    console.error('[Neo4j] Relationship upsert error:', err instanceof Error ? err.message : String(err))
    return false
  })
}

/**
 * Kết quả batch upsert relationships — count THẬT (fix kg-arch-a: trước đây
 * luôn tính batch.length vào "upserted" dù rel thiếu endpoint bị MATCH
 * drop lặng lẽ → số liệu/log/UI ảo tưởng "đã ghi").
 */
export interface RelationshipBatchResult {
  /** MERGE thành công (đủ 2 endpoint) */
  upserted: number
  /** Bị drop — 1 trong 2 endpoint MATCH không thấy node */
  dropped: number
  /** Lỗi query (batch fail sau retry + fallback từng rel cũng fail) */
  failed: number
  /** Tổng rel đầu vào */
  total: number
}

/**
 * Batch upsert relationships by type.
 * Groups relationships by their type for efficient UNWIND batching.
 *
 * MATCH-then-MERGE: rel nào thiếu endpoint sẽ bị Neo4j drop khỏi kết quả MATCH
 * (không tạo rel) — được đếm vào `dropped`, KHÔNG tựu vào `upserted` như cũ.
 *
 * @param relationships Array of relationship edges to upsert
 * @param documentId Document ID for batch operations
 * @returns Count thật: { upserted, dropped (thiếu endpoint), failed, total }
 */
export async function upsertRelationshipsBatch(
  relationships: RelationshipEdge[],
  documentId: string
): Promise<RelationshipBatchResult> {
  const counts: RelationshipBatchResult = {
    upserted: 0,
    dropped: 0,
    failed: 0,
    total: relationships.length,
  }
  if (relationships.length === 0) return counts

  const now = new Date().toISOString()

  // Group by relationship type for efficient batching
  const byType = new Map<string, RelationshipEdge[]>()
  for (const rel of relationships) {
    const relType = sanitizeLabel(rel.relationship_type)
    if (!byType.has(relType)) byType.set(relType, [])
    byType.get(relType)!.push(rel)
  }

  // Batch upsert per type (500 per batch)
  // Each batch is wrapped with withNeo4jRetry for transient error recovery
  const BATCH_SIZE = 500
  for (const [relType, typeRels] of byType) {
    for (let i = 0; i < typeRels.length; i += BATCH_SIZE) {
      const batch = typeRels.slice(i, i + BATCH_SIZE)
      try {
        let upsertedCount = 0
        await withNeo4jRetry(async () => {
          const session = await getSession()
          try {
            const result = await session.executeWrite((tx) =>
              tx.run(
                `UNWIND $rels AS r
                 MATCH (a {id: r.sourceId}), (b {id: r.targetId})
                 MERGE (a)-[rel:${relType}]->(b)
                 SET rel.documentId = $documentId,
                     rel.document_id = $documentId,
                     rel.description = r.description,
                     rel.confidence = r.confidence,
                     rel.confidence_score = r.confidence,
                     rel.source = r.source,
                     rel.relationship_type = $relType,
                     rel.source_entity_id = r.sourceId,
                     rel.target_entity_id = r.targetId,
                     rel.created_at = $createdAt
                 RETURN count(rel) AS upsertedCount`,
                {
                  rels: batch.map(r => ({
                    sourceId: r.sourceId,
                    targetId: r.targetId,
                    description: r.description || '',
                    confidence: r.confidence || 0,
                    source: r.source || 'llm',
                  })),
                  documentId,
                  relType,
                  createdAt: now,
                }
              )
            )
            // count THẬT: rel thiếu endpoint bị MATCH loại bỏ trước khi MERGE
            upsertedCount = Number(result.records[0]?.get('upsertedCount') ?? 0)
          } finally {
            await session.close()
          }
        })
        counts.upserted += upsertedCount
        counts.dropped += batch.length - upsertedCount
      } catch (err) {
        console.error(`[Neo4j] Batch relationship upsert error (${relType}):`, err instanceof Error ? err.message : String(err))
        // Fallback: try individual upserts — phân loại từng rel
        // (dropped = thiếu endpoint check trước, failed = query lỗi)
        for (const rel of batch) {
          try {
            const hits = await readCypher<{ ok: number }>(
              `MATCH (a {id: $sid}), (b {id: $tid}) RETURN count(a) AS ok`,
              { sid: rel.sourceId, tid: rel.targetId }
            )
            if (!hits.length || Number(hits[0].ok) === 0) {
              counts.dropped++
              continue
            }
          } catch {
            /* endpoint check fail → vẫn thử upsert, phân loại theo kết quả */
          }
          const success = await upsertRelationship(rel)
          if (success) counts.upserted++
          else counts.failed++
        }
      }
    }
  }

  // Tổng kết 1 dòng — chống ảo tưởng "đã ghi" khi rel bị drop lặng lẽ
  console.log(`[Neo4j] upsertRelationshipsBatch: ${counts.upserted} upserted, ${counts.dropped} dropped (thiếu endpoint), ${counts.failed} failed`)

  return counts
}


// ==================== DOCUMENT GRAPH OPERATIONS ====================

/**
 * List ALL Document nodes in the graph.
 *
 * NOTE: In this app's data model, `:Document`-labeled nodes come from TWO
 * sources that share the same label but use DIFFERENT id schemes:
 *   (a) Entity nodes created during extraction — id = `global__<title>__document`
 *       (these are entities the LLM typed as "Document", e.g. a paper title).
 *   (b) UUID-based Document nodes created by `upsertDocumentNode` — id = the
 *       PDF's upload UUID. These are ONLY created via /api/sync-neo4j, not the
 *       normal process pipeline, so they may not exist at all.
 *
 * Because of (a), this function is NOT reliable for matching R2 PDF UUIDs.
 * For that, use `getProcessedDocumentsFromNeo4j()` below, which keys off the
 * `documentId` property stored on RELATIONSHIP edges (always set during
 * extraction, line ~1568 of process/route.ts).
 */
export async function listAllDocumentNodesFromNeo4j(): Promise<
  Record<string, {
    id: string
    title: string
    domain: string
    status: string
    page_count: number
    created_at: string
    updated_at: string
  }>
> {
  try {
    const rows = await readCypher<{
      id: string
      title: string
      domain: string
      status: string
      page_count: number
      created_at: string
      updated_at: string
    }>(`MATCH (d:Document)
         RETURN d.id AS id,
                d.title AS title,
                d.domain AS domain,
                d.status AS status,
                d.page_count AS page_count,
                d.created_at AS created_at,
                d.updated_at AS updated_at`)
    const map: Record<string, (typeof rows)[number]> = {}
    for (const r of rows) {
      if (r.id) map[r.id] = r
    }
    return map
  } catch (err) {
    console.error(
      '[Neo4j] listAllDocumentNodesFromNeo4j error:',
      err instanceof Error ? err.message : String(err)
    )
    return {}
  }
}

/**
 * Build the authoritative map of PDF UUIDs that were processed in a prior
 * session, keyed by document UUID.
 *
 * Entity nodes do NOT carry a `documentId` property, and `:Document`-labeled
 * nodes may be entity-style (`global__…__document`) rather than UUID-based.
 * The RELIABLE signal that a PDF was processed is the `documentId` property
 * on RELATIONSHIP edges, which the extraction pipeline always sets
 * (process/route.ts ~line 1568: `SET rel.documentId = $documentId`).
 *
 * Returns, per processed document UUID:
 *   - entityCount: entities linked via CONTAINS (0 if no UUID Document node)
 *   - relCount:    relationships whose documentId matches
 *   - relTypes:    distinct relationship types (USES, APPLIES_TO, ...)
 *
 * Used by /api/ingestion/reconcile to rebuild SQLite + Qdrant status.
 */
export async function getProcessedDocumentsFromNeo4j(): Promise<
  Record<string, { entityCount: number; relCount: number; relTypes: string[] }>
> {
  const map: Record<string, { entityCount: number; relCount: number; relTypes: string[] }> = {}
  try {
    // Relationship counts + types per documentId
    const rows = await readCypher<{
      docId: string
      relCount: number
      relTypes: string[]
    }>(`MATCH ()-[r]->()
         WHERE r.documentId IS NOT NULL
         RETURN r.documentId AS docId,
                count(r) AS relCount,
                collect(DISTINCT type(r)) AS relTypes`)
    for (const r of rows) {
      if (r.docId) {
        map[r.docId] = {
          entityCount: 0,
          relCount: r.relCount ?? 0,
          relTypes: r.relTypes ?? [],
        }
      }
    }

    // Entity counts per documentId via CONTAINS relationships (if UUID Document
    // nodes exist). This is best-effort — if upsertDocumentNode was never
    // called, there are no CONTAINS edges and entityCount stays 0.
    try {
      const entityRows = await readCypher<{ docId: string; entityCount: number }>(
        `MATCH (d:Document)-[:CONTAINS]->(e)
         WHERE d.id IS NOT NULL
         RETURN d.id AS docId, count(e) AS entityCount`
      )
      for (const r of entityRows) {
        if (r.docId && map[r.docId]) {
          map[r.docId].entityCount = r.entityCount ?? 0
        } else if (r.docId) {
          map[r.docId] = { entityCount: r.entityCount ?? 0, relCount: 0, relTypes: [] }
        }
      }
    } catch {
      // CONTAINS query is best-effort — ignore failures
    }
  } catch (err) {
    console.error(
      '[Neo4j] getProcessedDocumentsFromNeo4j error:',
      err instanceof Error ? err.message : String(err)
    )
  }
  return map
}

/**
 * Create or update a Document node in the graph.
 * This represents the document itself as a node that can be linked to entities.
 */
export async function upsertDocumentNode(doc: DocumentNode): Promise<boolean> {
  return withNeo4jRetry(async () => {
    const now = new Date().toISOString()
    const session = await getSession()
    try {
      await session.executeWrite((tx) =>
        tx.run(
          `MERGE (d:Document {id: $id})
           SET d.title = $title,
               d.domain = $domain,
               d.entity_type = 'Document',
               d.name = $title,
               d.entity_name = $title,
               d.status = $status,
               d.page_count = $pageCount,
               d.documentId = $id,
               d.document_id = $id,
               d.created_at = $createdAt,
               d.updated_at = $updatedAt`,
          {
            id: doc.id,
            title: doc.title,
            domain: doc.domain,
            status: doc.status,
            pageCount: doc.page_count || 0,
            createdAt: doc.created_at || now,
            updatedAt: now,
          }
        )
      )
      return true
    } finally {
      await session.close()
    }
  }).catch((err) => {
    console.error('[Neo4j] Document node upsert error:', err instanceof Error ? err.message : String(err))
    return false
  })
}

/**
 * Link a Document node to all entities extracted from it.
 * Creates CONTAINS relationships from Document → Entity.
 */
export async function linkDocumentToEntities(
  documentId: string,
  entityIds: string[]
): Promise<number> {
  if (entityIds.length === 0) return 0

  let linked = 0
  const BATCH_SIZE = 500

  for (let i = 0; i < entityIds.length; i += BATCH_SIZE) {
    const batch = entityIds.slice(i, i + BATCH_SIZE)
    try {
      const session = await getSession()
      try {
        await session.executeWrite((tx) =>
          tx.run(
            `UNWIND $entityIds AS eid
             MATCH (d:Document {id: $documentId}), (e {id: eid})
             MERGE (d)-[r:CONTAINS]->(e)
             SET r.documentId = $documentId, r.document_id = $documentId`,
            { documentId, entityIds: batch }
          )
        )
        linked += batch.length
      } finally {
        await session.close()
      }
    } catch (err) {
      console.error('[Neo4j] Link document to entities error:', err instanceof Error ? err.message : String(err))
    }
  }

  return linked
}


/**
 * Delete a Document node and all its connected entities from the graph.
 * Uses DETACH DELETE to remove relationships.
 */
export async function deleteDocumentGraph(documentId: string): Promise<{
  nodesDeleted: number
  relsDeleted: number
}> {
  return withNeo4jRetry(async () => {
    const result = { nodesDeleted: 0, relsDeleted: 0 }

    // Delete document node
    const docSession = await getSession()
    try {
      const docResult = await docSession.executeWrite((tx) =>
        tx.run(
          `MATCH (d:Document {id: $documentId})
           DETACH DELETE d
           RETURN count(d) AS deleted`,
          { documentId }
        )
      )
      const val = docResult.records[0]?.get('deleted')
      result.nodesDeleted += typeof val?.toNumber === 'function' ? val.toNumber() : (val ?? 0) as number
    } finally {
      await docSession.close()
    }

    // Delete all entities for this document
    const entityResult = await deleteEntitiesByDocument(documentId)
    result.nodesDeleted += entityResult

    return result
  }).catch((err) => {
    console.error('[Neo4j] Delete document graph error:', err instanceof Error ? err.message : String(err))
    return { nodesDeleted: 0, relsDeleted: 0 }
  })
}

// ==================== COMMUNITY DETECTION ====================


// ==================== GRAPH TRAVERSAL ====================


/**
 * Get aggregate graph statistics.
 */
export async function getGraphStats(): Promise<{
  totalNodes: number
  totalRelationships: number
  nodesByLabel: Record<string, number>
  relsByType: Record<string, number>
  nodesByDomain: Record<string, number>
  avgDegree: number
}> {
  try {
    const stats = {
      totalNodes: 0,
      totalRelationships: 0,
      nodesByLabel: {} as Record<string, number>,
      relsByType: {} as Record<string, number>,
      nodesByDomain: {} as Record<string, number>,
      avgDegree: 0,
    }

    const session = await getSession()
    try {
      // Total nodes
      const nodeResult = await session.executeRead((tx) =>
        tx.run('MATCH (n) RETURN count(n) AS cnt')
      )
      stats.totalNodes = toNative(nodeResult.records[0]?.get('cnt')) as number || 0

      // Total relationships
      const relResult = await session.executeRead((tx) =>
        tx.run('MATCH ()-[r]->() RETURN count(r) AS cnt')
      )
      stats.totalRelationships = toNative(relResult.records[0]?.get('cnt')) as number || 0

      // Nodes by label
      const labelResult = await session.executeRead((tx) =>
        tx.run(
          `MATCH (n) WHERE size(labels(n)) > 0
           WITH labels(n) AS lbls UNWIND lbls AS lbl
           RETURN lbl AS label, count(*) AS cnt ORDER BY cnt DESC`
        )
      )
      for (const record of labelResult.records) {
        stats.nodesByLabel[toNative(record.get('label')) as string] = toNative(record.get('cnt')) as number
      }

      // Relationships by type
      const typeResult = await session.executeRead((tx) =>
        tx.run(
          `MATCH ()-[r]->() RETURN type(r) AS relType, count(r) AS cnt ORDER BY cnt DESC`
        )
      )
      for (const record of typeResult.records) {
        stats.relsByType[toNative(record.get('relType')) as string] = toNative(record.get('cnt')) as number
      }

      // Nodes by domain
      const domainResult = await session.executeRead((tx) =>
        tx.run(
          `MATCH (n) WHERE n.domain IS NOT NULL RETURN n.domain AS domain, count(n) AS cnt ORDER BY cnt DESC`
        )
      )
      for (const record of domainResult.records) {
        stats.nodesByDomain[toNative(record.get('domain')) as string] = toNative(record.get('cnt')) as number
      }

      // Average degree
      if (stats.totalNodes > 0) {
        const degreeResult = await session.executeRead((tx) =>
          tx.run(
            `MATCH (n)-[r]-() WITH n, count(r) AS degree RETURN avg(degree) AS avgDeg`
          )
        )
        stats.avgDegree = Math.round((toNative(degreeResult.records[0]?.get('avgDeg')) as number || 0) * 100) / 100
      }
    } finally {
      await session.close()
    }

    return stats
  } catch (err) {
    console.error('[Neo4j] Get graph stats error:', err instanceof Error ? err.message : String(err))
    return { totalNodes: 0, totalRelationships: 0, nodesByLabel: {}, relsByType: {}, nodesByDomain: {}, avgDegree: 0 }
  }
}

// ==================== BACKGROUND HEALTH MONITOR ====================

/**
 * Periodic background health check for Neo4j.
 *
 * Problem: When running locally with Neo4j Desktop, the laptop may go to
 * sleep/hibernate. When it wakes up, the Neo4j driver's connection pool
 * contains stale/dead connections. The first request after wake-up will
 * fail with "connection refused" or "session expired" errors.
 *
 * Solution: A background timer pings Neo4j every 60 seconds. If the ping
 * fails, it proactively resets the driver so that the next real request
 * gets a fresh connection immediately — instead of failing and retrying.
 *
 * This timer is only started when:
 *   1. The app is NOT in test mode
 *   2. NEO4J_URI is configured
 *   3. A driver has been successfully created at least once
 */
// FIX (timer leak on hot reload): the guard variables were module-scope, so every
// re-evaluation of neo4j.ts during dev hot-reload started a NEW 60s interval while
// the old one kept running forever (N reloads → N timers each pinging AuraDB every
// 60s). Storing the guard on globalThis keeps a single interval across reloads.
const globalForNeo4jMonitor = globalThis as unknown as {
  __neo4jHealthCheckInterval?: ReturnType<typeof setInterval>
  __neo4jHealthCheckStarted?: boolean
  __neo4jMonitorStarted?: boolean
}
const HEALTH_CHECK_INTERVAL_MS = 60_000 // 60 seconds

export function startNeo4jHealthMonitor(): void {
  if (globalForNeo4jMonitor.__neo4jHealthCheckStarted) return
  globalForNeo4jMonitor.__neo4jHealthCheckStarted = true

  // Lazy start: only begin the interval after the driver is first created
  const tryStart = () => {
    if (globalForNeo4jMonitor.__neo4jMonitorStarted) return
    if (!process.env.NEO4J_URI) return

    globalForNeo4jMonitor.__neo4jMonitorStarted = true
    console.log('[Neo4j] Background health monitor started (60s interval)')

    const interval = setInterval(async () => {
      if (!globalForNeo4j.neo4jDriver) return // No driver to check

      try {
        const session = globalForNeo4j.neo4jDriver.session({ database: process.env.NEO4J_DATABASE || undefined })
        try {
          await session.run('RETURN 1 AS __health_ping__')
          // Connection is alive — no action needed
        } finally {
          await session.close()
        }
      } catch (err: any) {
        logNeo4jConnectFailure('background health check — resetting driver', err)
        // Proactively reset the driver so the next real request succeeds immediately
        await resetNeo4jDriver()
      }
    }, HEALTH_CHECK_INTERVAL_MS)

    globalForNeo4jMonitor.__neo4jHealthCheckInterval = interval

    // Don't let the interval prevent process exit
    if (typeof interval === 'object' && 'unref' in interval) {
      interval.unref()
    }
  }

  // Start on next tick (after env vars are loaded)
  process.nextTick(() => {
    if (process.env.NEO4J_URI) {
      tryStart()
    }
  })
}

// Auto-start the health monitor when this module is imported (non-test only)
if (process.env.NODE_ENV !== 'test' && typeof process.env.NEO4J_URI === 'string' && process.env.NEO4J_URI) {
  startNeo4jHealthMonitor()
}
