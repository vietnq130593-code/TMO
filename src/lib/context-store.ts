/**
 * CONTEXT STORE — Kho Context "đọc lại khi cần" (CI-3 B2, Task 13-b)
 * =================================================================
 *
 * Roadmap CI-3 tầng 2 (docs/CODE_EXECUTION_IMPROVEMENT_ROADMAP.md): mỗi lần
 * rolling digest nén context (src/lib/context-compression.ts), digest đầy đủ
 * được lưu vào KHO này — agent BỎ thông tin không cần khỏi context active
 * nhưng KHÔNG MẤT: tool context_recall(query, runId?) truy hồi lại bất cứ
 * lúc nào (đúng yêu cầu Mr. Architect "lưu trữ lại đâu đó để đọc lại khi cần").
 *
 * DUAL-STORAGE (thiết kế cho sandbox — NVIDIA embed key là placeholder):
 *   - Prisma TaskContextArchive = SOURCE OF TRUTH — LUÔN ghi (fail-open:
 *     lỗi chỉ log 1 dòng, KHÔNG BAO GIỜ throw lên caller).
 *   - Qdrant collection "task_context" = best-effort semantic index — chỉ ghi
 *     khi embed thành công; embed hỏng → bỏ qua im lặng (Prisma vẫn đủ dùng).
 *
 * recallContext: (1) Qdrant semantic search (nếu query embed được + collection
 * sống) → map về archive record đầy đủ bằng archiveId; (2) SQL text search
 * fallback/kết hợp trên TaskContextArchive (LIKE theo token của query + rank
 * theo số token khớp + recency) → LUÔN trả được kết quả trong sandbox.
 *
 * STALE-CLIENT BRIDGE (pattern episodic-db.ts / metrics-db.ts): dev server giữ
 * Prisma instance cũ trên globalThis — sau `prisma db push` thêm model mới,
 * instance cũ không có delegate `db.taskContextArchive` → TypeError. Cầu nối:
 *   - Delegate path (type-safe) khi instance fresh
 *   - Raw SQL path ($queryRaw/$executeRaw — parameterized) khi stale
 *     (bảng đã tồn tại sau db:push nên raw SQL chạy được ngay)
 * Mọi path đều fail-open tuyệt đối: lỗi → trả [] / bỏ qua ghi, KHÔNG throw.
 */

import { Prisma } from '@prisma/client'
import { randomUUID } from 'crypto'
import { db } from '@/lib/db'
import { qdrant } from '@/lib/qdrant'
import { generateEmbedding, generateQueryEmbedding, getEmbeddingDimension } from '@/lib/embeddings'

// ==================== CONSTANTS ====================

/** Tên Qdrant collection cho Kho Context (env-thay đổi được như 2 collection KB) */
export const COLLECTION_TASK_CONTEXT = process.env.QDRANT_COLLECTION_TASK_CONTEXT || 'task_context' // ROUND-38 fix V1-3: export cho collections-health route

/** Digest ngắn hơn ngưỡng này thì KHÔNG embed (không đáng tốn 1 API call) */
const ARCHIVE_EMBED_MIN_CHARS = 100

/** Số kết quả mặc định của recallContext */
export const DEFAULT_RECALL_LIMIT = 5
/** Số kết quả tối đa của recallContext (chống phình context agent) */
export const MAX_RECALL_LIMIT = 20

/**
 * TTL Kho Context (ngày) — record cũ hơn bị prune (roadmap CI-3 TTL pattern).
 * Env TASK_CONTEXT_TTL_DAYS override được; prune chạy 1 lần/ngày.
 */
const TASK_CONTEXT_TTL_DAYS = (() => {
  const v = Number(process.env.TASK_CONTEXT_TTL_DAYS)
  return Number.isFinite(v) && v >= 0 ? Math.floor(v) : 90
})()

/** Chu kỳ chạy prune (24h — maybePruneTaskContextArchive kiểm tra timestamp) */
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000

// ==================== TYPES ====================

/** Item do recallContext trả về — 1 bản ghi archive kèm điểm liên quan */
export interface RecallContextItem {
  id: string
  runId: string | null
  sessionId: string | null
  agentName: string | null
  kind: string
  content: string
  /** Cosine similarity (Qdrant path) hoặc tỉ lệ token khớp (SQL path) */
  score?: number
  createdAt: Date
}

/** Kết quả recallContext — `source` cho biết đường nào đã đóng góp item */
export interface RecallContextResult {
  items: RecallContextItem[]
  source: 'qdrant' | 'sql' | 'mixed'
}

/** Payload lưu kèm vector trong Qdrant task_context (KHÔNG chứa content —
 *  content đầy đủ luôn lấy từ Prisma theo archiveId để tránh drift) */
interface TaskContextPayload {
  archiveId: string
  runId: string | null
  sessionId: string | null
  agentName: string | null
  kind: string
  createdAt: string
}

/** Row thô từ raw SQL SELECT — createdAt có thể là Date (Prisma map) hoặc string */
interface TaskContextArchiveRow {
  id: string
  runId: string | null
  sessionId: string | null
  agentName: string | null
  kind: string
  content: string
  tags: string | null
  createdAt: Date | string
}

// ==================== STALE-CLIENT BRIDGE (pattern episodic-db.ts) ====================

/**
 * Dev server cache Prisma instance cũ trên globalThis — sau `prisma db push`
 * instance cũ không có delegate taskContextArchive. Detect để chọn path:
 * delegate (type-safe) hoặc raw SQL (bảng đã tồn tại sau push).
 */
function hasTaskContextArchiveDelegate(): boolean {
  try {
    return typeof (db as unknown as Record<string, unknown>).taskContextArchive !== 'undefined'
  } catch {
    return false
  }
}

/** Ép kiểu row thô (createdAt Date|string) về RecallContextItem */
function toRecallItem(row: TaskContextArchiveRow, score?: number): RecallContextItem {
  const createdAt = row.createdAt instanceof Date
    ? row.createdAt
    : new Date(String(row.createdAt))
  return {
    id: row.id,
    runId: row.runId ?? null,
    sessionId: row.sessionId ?? null,
    agentName: row.agentName ?? null,
    kind: row.kind,
    content: typeof row.content === 'string' ? row.content : String(row.content ?? ''),
    ...(score !== undefined ? { score } : {}),
    createdAt,
  }
}

// ==================== COLLECTION MANAGEMENT ====================

/**
 * Đảm bảo Qdrant collection task_context tồn tại (tạo nếu chưa có).
 * Pattern ensureAgentMemoryCollection: check tồn tại → create (vector size =
 * đúng dimension embed hiện tại từ @/lib/embeddings — single source of truth)
 * + payload index cho filter runId/sessionId/kind. globalThis guard chống lặp
 * check mỗi call (HMR-safe). Fail-open: lỗi → return false (caller bỏ qua
 * Qdrant, SQL fallback vẫn hoạt động).
 */
export async function initTaskContextCollection(): Promise<boolean> {
  const g = globalThis as unknown as { __tmoTaskContextCollectionOk?: boolean }
  try {
    if (g.__tmoTaskContextCollectionOk) return true

    const collections = await qdrant.getCollections()
    const existingNames = new Set(collections.collections.map(c => c.name))

    if (!existingNames.has(COLLECTION_TASK_CONTEXT)) {
      await qdrant.createCollection(COLLECTION_TASK_CONTEXT, {
        vectors: {
          size: getEmbeddingDimension(),
          distance: 'Cosine',
        },
        // Cùng config agent_memory: quantization INT8 (volume digest nhỏ nhưng
        // đồng bộ pattern; <1% mất chính xác, 4x tiết kiệm RAM)
        quantization_config: {
          scalar: {
            type: 'int8' as const,
            quantile: 0.99,
            always_ram: true,
          },
        },
        hnsw_config: {
          ef_construct: 128,
          m: 16,
          full_scan_threshold: 10_000,
        },
        optimizers_config: {
          indexing_threshold: 20_000,
        },
      })
      console.log(`[ContextStore] Created Qdrant collection: ${COLLECTION_TASK_CONTEXT} (${getEmbeddingDimension()}-dim vectors)`)
    }

    // Payload index cho filter nhanh (runId/sessionId khi recall theo scope)
    try {
      await qdrant.createPayloadIndex(COLLECTION_TASK_CONTEXT, {
        field_name: 'runId',
        field_schema: 'keyword',
      })
      await qdrant.createPayloadIndex(COLLECTION_TASK_CONTEXT, {
        field_name: 'sessionId',
        field_schema: 'keyword',
      })
      await qdrant.createPayloadIndex(COLLECTION_TASK_CONTEXT, {
        field_name: 'kind',
        field_schema: 'keyword',
      })
      await qdrant.createPayloadIndex(COLLECTION_TASK_CONTEXT, {
        field_name: 'createdAt',
        field_schema: 'datetime',
      })
    } catch (indexErr) {
      // Index có thể tồn tại sẵn — chỉ warn khi lỗi khác
      const msg = indexErr instanceof Error ? indexErr.message : String(indexErr)
      if (!msg.includes('already exists') && !msg.includes('already has')) {
        console.warn('[ContextStore] Payload index warning:', msg)
      }
    }

    g.__tmoTaskContextCollectionOk = true
    return true
  } catch (err) {
    // Fail-open — Qdrant layer là best-effort, SQL fallback vẫn hoạt động
    console.warn('[ContextStore] initTaskContextCollection failed (fail-open, bỏ qua Qdrant layer):', err instanceof Error ? err.message : String(err))
    return false
  }
}

// ==================== ARCHIVE (WRITE) ====================

/**
 * Lưu 1 bản ghi context vào Kho (source of truth = Prisma TaskContextArchive).
 *
 * - kind='digest' + content đủ dài (≥ ARCHIVE_EMBED_MIN_CHARS) → best-effort
 *   embed (generateEmbedding — đúng hàm knowledge base đang dùng) + upsert
 *   Qdrant point vào task_context; embed hỏng (vector rỗng trong sandbox) →
 *   bỏ qua im lặng, KHÔNG bao giờ fail caller.
 * - Fail-open tuyệt đối: lỗi Prisma/Qdrant chỉ log 1 dòng → { archived: false }.
 *
 * @returns { archived, archiveId?, embedded? } — embedded=true nghĩa là đã
 *          upsert Qdrant thành công (best-effort semantic index sống).
 */
export async function archiveContext(params: {
  runId?: string | null
  sessionId?: string | null
  agentName?: string | null
  /** 'digest' | 'raw' | 'task_summary' */
  kind: string
  content: string
  tags?: string
}): Promise<{ archived: boolean; archiveId?: string; embedded?: boolean }> {
  const runId = params.runId?.trim() || null
  const sessionId = params.sessionId?.trim() || null
  const agentName = params.agentName?.trim() || null
  const kind = params.kind?.trim() || ''
  const content = typeof params.content === 'string' ? params.content : ''
  const tags = params.tags?.trim() || null

  if (!kind || !content.trim()) {
    return { archived: false }
  }

  // ===== 1. GHI PRISMA (source of truth — luôn thử, fail-open) =====
  let archiveId: string
  try {
    if (hasTaskContextArchiveDelegate()) {
      const row = await db.taskContextArchive.create({
        data: { runId, sessionId, agentName, kind, content, tags },
      })
      archiveId = row.id
    } else {
      // Stale client (dev server giữ instance cũ sau db:push) → raw INSERT
      // (bảng đã tồn tại sau push — $executeRaw parameterized chạy được ngay)
      archiveId = randomUUID()
      await db.$executeRaw`
        INSERT INTO TaskContextArchive (id, runId, sessionId, agentName, kind, content, tags, createdAt)
        VALUES (${archiveId}, ${runId}, ${sessionId}, ${agentName}, ${kind}, ${content}, ${tags}, ${new Date()})
      `
    }
  } catch (err) {
    // Fail-open — archive là tối ưu, KHÔNG bao giờ throw lên caller (goal-loop /
    // workflow-engine gọi sau mỗi lần nén; lỗi ở đây không được phá vòng lặp)
    console.warn('[ContextStore] archiveContext: ghi Prisma thất bại (fail-open):', err instanceof Error ? err.message : String(err))
    return { archived: false }
  }

  // ===== 2. BEST-EFFORT QDRANT (chỉ digest đủ dài; embed hỏng → im lặng) =====
  let embedded = false
  if (kind === 'digest' && content.length >= ARCHIVE_EMBED_MIN_CHARS) {
    try {
      const collectionOk = await initTaskContextCollection()
      if (collectionOk) {
        const { vector } = await generateEmbedding(content)
        // Phase 6 SMOLAB P0.1: provider chết → vector rỗng → BỎ Qdrant write
        // (không pollute index bằng hash giả) — đúng hành vi sandbox hiện tại.
        if (vector && vector.length === getEmbeddingDimension()) {
          const payload: TaskContextPayload = {
            archiveId,
            runId,
            sessionId,
            agentName,
            kind,
            createdAt: new Date().toISOString(),
          }
          await qdrant.upsert(COLLECTION_TASK_CONTEXT, {
            wait: true,
            points: [
              {
                id: randomUUID(), // point id mới cho mỗi archive record (id UUID — Qdrant chỉ nhận UUID/int)
                vector,
                payload: payload as unknown as Record<string, unknown>,
              },
            ],
          })
          embedded = true
        }
      }
    } catch {
      // Embed hỏng / Qdrant down → bỏ qua im lặng (SQL fallback đủ dùng;
      // generateEmbedding đã tự log lỗi provider bên trong)
    }
  }

  // ===== 3. TTL PRUNE (fire-and-forget, tối đa 1 lần/ngày) =====
  maybePruneTaskContextArchive()

  return { archived: true, archiveId, embedded }
}

// ==================== RECALL (READ) ====================

/** Tách query thành token tìm kiếm (lowercase, bỏ stop-word 1 ký tự, cap 8) */
export function tokenizeQuery(query: string): string[] {
  const tokens = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter(t => t.length >= 2)
  return [...new Set(tokens)].slice(0, 8)
}

/** Escape ký tự wildcard của LIKE (% _ \) — token chứa '_' rất phổ biến (snake_case) */
function escapeLike(token: string): string {
  return token.replace(/[\\%_]/g, ch => '\\' + ch)
}

/**
 * Qdrant semantic search — best-effort (fail-open trả []):
 * embed query → query task_context (filter runId/sessionId/kind nếu truyền) →
 * map archiveId về record ĐẦY ĐỦ từ Prisma (content luôn lấy từ source of
 * truth, point mồ côi do prune bị bỏ qua).
 */
async function qdrantSemanticRecall(
  query: string,
  runId: string | null,
  sessionId: string | null,
  kind: string | null,
  limit: number,
): Promise<RecallContextItem[]> {
  try {
    const collectionOk = await initTaskContextCollection()
    if (!collectionOk) return []

    const { vector } = await generateQueryEmbedding(query)
    // Vector rỗng = mọi embedding provider chết (sandbox placeholder key) →
    // không thể semantic search → nhường hoàn toàn cho SQL fallback
    if (!vector || vector.length === 0) return []

    const must: Array<Record<string, unknown>> = []
    if (runId) must.push({ key: 'runId', match: { value: runId } })
    if (sessionId) must.push({ key: 'sessionId', match: { value: sessionId } })
    // CI-3 B4 (Task 13-c): filter theo kind (payload index 'kind' đã tạo sẵn)
    if (kind) must.push({ key: 'kind', match: { value: kind } })

    const res = await qdrant.query(COLLECTION_TASK_CONTEXT, {
      query: vector,
      ...(must.length > 0 ? { filter: { must } } : {}),
      limit,
      with_payload: true,
    })

    const hits: Array<{ archiveId: string; score?: number }> = []
    for (const p of res?.points ?? []) {
      const payload = p.payload as unknown as TaskContextPayload | undefined
      if (payload && typeof payload.archiveId === 'string' && payload.archiveId !== '') {
        hits.push({
          archiveId: payload.archiveId,
          ...(typeof p.score === 'number' ? { score: p.score } : {}),
        })
      }
    }
    if (hits.length === 0) return []

    // Lấy content đầy đủ từ Prisma bằng archiveId (source of truth)
    const ids = [...new Set(hits.map(h => h.archiveId))]
    const rows: TaskContextArchiveRow[] = await db.$queryRaw<TaskContextArchiveRow[]>(
      Prisma.sql`SELECT * FROM TaskContextArchive WHERE id IN (${Prisma.join(ids)})`,
    )
    const byId = new Map(rows.map(r => [r.id, r]))

    const items: RecallContextItem[] = []
    for (const hit of hits) {
      const row = byId.get(hit.archiveId)
      if (!row) continue // record đã bị prune → point mồ côi, bỏ qua
      items.push(toRecallItem(row, hit.score))
    }
    return items
  } catch {
    return [] // fail-open — nhường cho SQL fallback
  }
}

/**
 * SQL text search fallback/kết hợp trên TaskContextArchive:
 * WHERE content LIKE theo token của query (OR các token, SQLite LIKE
 * case-insensitive với ASCII — file path/identifier khớp tốt) + filter
 * runId/sessionId/kind nếu truyền; fetch rộng (limit×4, cap 100) rồi rank
 * trong JS: ưu tiên record khớp NHIỀU token hơn, cùng số token thì MỚI hơn.
 */
async function sqlTextRecall(
  query: string,
  runId: string | null,
  sessionId: string | null,
  kind: string | null,
  limit: number,
): Promise<RecallContextItem[]> {
  try {
    const tokens = tokenizeQuery(query)
    if (tokens.length === 0) return []

    // Fetch rộng hơn limit để rank trong JS có đủ ứng viên
    const fetchLimit = Math.min(Math.max(limit * 4, limit), 100)

    const likeClauses = tokens.map(
      t => Prisma.sql`content LIKE ${'%' + escapeLike(t) + '%'} ESCAPE '\\'`,
    )
    const conditions: Prisma.Sql[] = [Prisma.sql`(${Prisma.join(likeClauses, ' OR ')})`]
    if (runId) conditions.push(Prisma.sql`runId = ${runId}`)
    if (sessionId) conditions.push(Prisma.sql`sessionId = ${sessionId}`)
    // CI-3 B4 (Task 13-c): filter theo kind — caller (goal-loop) chỉ muốn
    // task_summary của session, không trộn digest/raw
    if (kind) conditions.push(Prisma.sql`kind = ${kind}`)

    const rows = await db.$queryRaw<TaskContextArchiveRow[]>(
      Prisma.sql`
        SELECT * FROM TaskContextArchive
        WHERE ${Prisma.join(conditions, ' AND ')}
        ORDER BY createdAt DESC
        LIMIT ${fetchLimit}
      `,
    )
    if (rows.length === 0) return []

    // Rank: số token khớp (Unicode-case-insensitive trong JS) → recency
    const lowerContents = rows.map(r => (typeof r.content === 'string' ? r.content : '').toLowerCase())
    const ranked = rows
      .map((row, i) => {
        const matchedTokens = tokens.filter(t => lowerContents[i].includes(t)).length
        return { row, matchedTokens }
      })
      .sort((a, b) => {
        if (b.matchedTokens !== a.matchedTokens) return b.matchedTokens - a.matchedTokens
        const ta = toRecallItem(a.row).createdAt.getTime()
        const tb = toRecallItem(b.row).createdAt.getTime()
        return tb - ta
      })
      .slice(0, limit)

    return ranked.map(({ row, matchedTokens }) =>
      toRecallItem(row, tokens.length > 0 ? matchedTokens / tokens.length : undefined),
    )
  } catch {
    return [] // fail-open
  }
}

/**
 * Truy hồi context đã lưu từ Kho (CI-3 B2): Qdrant semantic search kết hợp
 * SQL text search — LUÔN trả được kết quả trong sandbox (embed chết → SQL
 * fallback vẫn chạy trên Prisma TaskContextArchive).
 *
 * @param params.query   từ khóa tìm kiếm (tên file, lệnh, quyết định...)
 * @param params.runId   chỉ tìm trong run này (optional)
 * @param params.sessionId chỉ tìm trong session này (optional)
 * @param params.kind    chỉ tìm kind này ('digest' | 'raw' | 'task_summary' —
 *                       optional; CI-3 B4 goal-loop truyền 'task_summary' để
 *                       nạp tóm tắt các tác vụ trước mà không trộn digest)
 * @param params.limit   số kết quả (default 5, max 20)
 * @returns { items, source } — source cho biết đường nào đóng góp item trong
 *          danh sách cuối: 'qdrant' | 'sql' | 'mixed'.
 */
export async function recallContext(params: {
  query: string
  runId?: string
  sessionId?: string
  kind?: string
  limit?: number
}): Promise<RecallContextResult> {
  const query = typeof params.query === 'string' ? params.query.trim() : ''
  const runId = params.runId?.trim() || null
  const sessionId = params.sessionId?.trim() || null
  const kind = params.kind?.trim() || null
  const limit = Math.max(1, Math.min(
    MAX_RECALL_LIMIT,
    Number.isFinite(params.limit) && (params.limit as number) > 0
      ? Math.floor(params.limit as number)
      : DEFAULT_RECALL_LIMIT,
  ))

  if (!query) return { items: [], source: 'sql' }

  // (1) Qdrant semantic — best-effort ([] khi embed/collection hỏng)
  const qdrantItems = await qdrantSemanticRecall(query, runId, sessionId, kind, limit)

  // (2) SQL text search — luôn chạy (fallback khi Qdrant rỗng + kết hợp
  // recency ranking bổ sung cho kết quả semantic)
  const sqlItems = await sqlTextRecall(query, runId, sessionId, kind, limit)

  // (3) Gộp: qdrant đứng trước (semantic relevance), dedupe theo id, cap limit.
  // Nguồn đóng góp được xác định SAU khi gộp bằng id (Qdrant path đã fetch
  // trước → item trùng id được tính cho Qdrant).
  const qdrantIds = new Set(qdrantItems.map(i => i.id))
  const seen = new Set<string>()
  const items: RecallContextItem[] = []
  for (const item of [...qdrantItems, ...sqlItems]) {
    if (items.length >= limit) break
    if (seen.has(item.id)) continue
    seen.add(item.id)
    items.push(item)
  }
  const fromQdrant = items.filter(i => qdrantIds.has(i.id)).length
  const fromSql = items.length - fromQdrant
  const source: RecallContextResult['source'] =
    fromQdrant > 0 && fromSql > 0 ? 'mixed' : fromQdrant > 0 ? 'qdrant' : 'sql'

  return { items, source }
}

// ==================== TTL PRUNE ====================

/**
 * Xóa record cũ hơn N ngày khỏi TaskContextArchive (TTL pattern roadmap CI-3).
 * days=0 → xóa toàn bộ (dùng cho smoke test / reset). Fail-open → 0.
 *
 * LƯU Ý: Qdrant points tương ứng KHÔNG được dọn trong hàm này — point mồ
 * côi vô hại (recallContext bỏ qua point không map được record Prisma) và
 * collection nhỏ; dọn point theo id phức tạp hơn giá trị nó mang lại.
 */
export async function pruneTaskContextArchive(days: number = TASK_CONTEXT_TTL_DAYS): Promise<number> {
  try {
    const safeDays = Number.isFinite(days) && days >= 0 ? days : TASK_CONTEXT_TTL_DAYS
    const cutoff = new Date(Date.now() - safeDays * 86_400_000)
    if (hasTaskContextArchiveDelegate()) {
      const res = await db.taskContextArchive.deleteMany({ where: { createdAt: { lt: cutoff } } })
      return res.count
    }
    // Stale client → raw DELETE (parameterized)
    const res = await db.$executeRaw`DELETE FROM TaskContextArchive WHERE createdAt < ${cutoff}`
    return res
  } catch (err) {
    console.warn('[ContextStore] pruneTaskContextArchive failed (fail-open):', err instanceof Error ? err.message : String(err))
    return 0
  }
}

/**
 * TTL prune throttle — chạy pruneTaskContextArchive tối đa 1 lần/24h, kiểm tra
 * timestamp trong module state trên globalThis (HMR-safe). Được gọi
 * fire-and-forget sau mỗi archiveContext thành công (bảng chỉ lớn lên qua
 * archive → đủ đảm bảo prune chạy đúng nhịp; không cần chỉnh scheduler).
 */
export function maybePruneTaskContextArchive(): void {
  try {
    const g = globalThis as unknown as { __tmoTaskContextPruneAt?: number }
    const now = Date.now()
    if (g.__tmoTaskContextPruneAt && now - g.__tmoTaskContextPruneAt < PRUNE_INTERVAL_MS) return
    g.__tmoTaskContextPruneAt = now
    void pruneTaskContextArchive()
      .then(count => {
        if (count > 0) console.log(`[ContextStore] TTL prune: đã xóa ${count} record cũ hơn ${TASK_CONTEXT_TTL_DAYS} ngày`)
      })
      .catch(() => { /* fail-open */ })
  } catch { /* fail-open */ }
}
