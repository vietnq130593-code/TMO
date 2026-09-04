/**
 * Supabase Cloud Sync — ephemeral data backup/restore
 *
 * Architecture:
 *   SQLite (local, ephemeral) ←→ Supabase (cloud, persistent)
 *
 * When sandbox resets: pull from Supabase → restore all data
 * On every write: push to Supabase (non-blocking)
 *
 * FIX 17-a (buffer prune): backup tables buffer (LocalEntity / LocalRelationship /
 *   LocalResolvedEntity) là append-only (upsert-by-id) → re-extract tạo UUID mới khiến
 *   row cũ tích lũy vĩnh viễn (Windows phình 66k rows). Giờ:
 *   - PUSH: sau upsert, delete-orphan các row backup mà id KHÔNG còn tồn tại local
 *   - PULL: chỉ pull row của Document còn sống trong DB local (+ row không có documentId)
 *
 * Tables synced (24 total = 23 backup + sync_log):
 *   Non-learning (18): AgentProfile, AgentSkill, AgentMemory, MemoryArchive,
 *     MemoryAccessLog, AgentSession, ChatMessage, DailyTokenByProviderModel,
 *     MCPBridgeConfig, KnowledgeAccessPolicy, UserProfile, AgentPreference,
 *     AgentCorrection, Document, LocalEntity, LocalRelationship, LocalResolvedEntity
 *   Learning (8):
 *     - AgentInsight, LocalEntity, LocalRelationship, LocalResolvedEntity
 *       (synced before Phase 3 SMOLAB Prop 10)
 *     - LearningLog, AutoLearnRecord (Phase 3 SMOLAB Prop 10 — original Prisma models)
 *     - ExecutionMetrics, FailurePattern, StrategyAdaptationLog
 *       (Phase 3 SMOLAB Prop 10 — Prisma models added by Phase 6 Prop 2)
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { db } from '@/lib/db'

// ==================== CONFIG ====================

const SUPABASE_URL = process.env.SUPABASE_URL || ''
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || ''

// ==================== CLIENT (singleton) ====================

let supabaseClient: SupabaseClient | null = null

function getSupabase(): SupabaseClient | null {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return null
  if (supabaseClient) return supabaseClient
  supabaseClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
  return supabaseClient
}

export function isSupabaseConfigured(): boolean {
  return !!(SUPABASE_URL && SUPABASE_SERVICE_KEY)
}

// ==================== TYPES ====================

export interface SyncResult {
  table: string
  pushed: number
  pulled: number
  errors: string[]
  /** FIX 17-a: số row backup đã bị xóa khi push (delete-orphan prune) */
  pruned?: number
  /** FIX 17-a: số row pull bị skip vì documentId thuộc document đã xóa khỏi DB local */
  skipped?: number
}

export interface FullSyncResult {
  results: SyncResult[]
  totalPushed: number
  totalPulled: number
  durationMs: number
  /** FIX 17-a: tổng số row backup đã prune trong lần push này */
  totalPruned?: number
  /** FIX 17-a: cảnh báo cho caller/logs (vd: pull buffer > 200k rows) */
  warnings?: string[]
}

// ==================== PAGINATED PUSH HELPERS ====================

/**
 * FIX (silent backup data loss): the three big buffer tables
 * (LocalEntity / LocalRelationship / LocalResolvedEntity) previously used
 * `findMany({ take: 5000 })` with NO pagination loop — with 55k+ entities an
 * arbitrary 5000-row subset was pushed and a restore would silently resurrect
 * only that subset. This helper walks ALL rows with cursor pagination and
 * chunks the upserts (large single POSTs risk Supabase gateway 413s).
 */
const PUSH_PAGE_SIZE = 2000
const UPSERT_CHUNK_SIZE = 1000

async function pushTablePaginated<T extends { id: string }>(
  client: SupabaseClient,
  tableName: string,
  fetchPage: (cursorId: string | null) => Promise<T[]>,
  mapRow: (row: T) => Record<string, unknown>,
  errors: string[]
): Promise<number> {
  let pushed = 0
  let cursorId: string | null = null
  // Safety cap: 500 pages × 2000 rows = 1M rows max per table
  for (let page = 0; page < 500; page++) {
    const rows = await fetchPage(cursorId)
    if (rows.length === 0) break
    for (let i = 0; i < rows.length; i += UPSERT_CHUNK_SIZE) {
      const chunk = rows.slice(i, i + UPSERT_CHUNK_SIZE)
      const { error } = await client
        .from(tableName)
        .upsert(chunk.map(mapRow), { onConflict: 'id' })
      if (error) {
        errors.push(`${tableName} (chunk @${cursorId ?? 'start'}+${i}): ${error.message}`)
      } else {
        pushed += chunk.length
      }
    }
    if (rows.length < PUSH_PAGE_SIZE) break
    cursorId = rows[rows.length - 1].id
  }
  return pushed
}

/**
 * Pull a Supabase table → SQLite with cursor-based pagination + batch createMany.
 * Supabase PostgREST caps responses at 1000 rows/request, so we paginate
 * using id.gt(cursor) + order('id') to fetch ALL rows (up to 500K per table).
 * Uses createMany({ skipDuplicates: true }) for ~100x speedup vs per-row upsert.
 */
async function pullTablePaginated(
  client: SupabaseClient,
  tableName: string,
  createBatch: (rows: any[]) => Promise<number>,
  errors: string[]
): Promise<number> {
  let pulled = 0
  let lastId: string | null = null
  for (let page = 0; page < 500; page++) {
    let query = client.from(tableName).select('*').order('id').limit(1000)
    if (lastId) query = query.gt('id', lastId)
    const { data, error } = await query
    if (error) { errors.push(`${tableName} (page ${page}): ${error.message}`); break }
    if (!data || data.length === 0) break
    try {
      const created = await createBatch(data)
      pulled += created
    } catch (e: any) {
      errors.push(`${tableName} (page ${page}): ${e.message}`)
    }
    lastId = data[data.length - 1].id
    if (data.length < 1000) break
  }
  return pulled
}

// ==================== BUFFER PRUNE HELPERS (FIX 17-a) ====================

/** Ngưỡng cảnh báo buffer backup quá lớn khi pull — vẫn pull, chỉ log + trả stats */
const LARGE_BUFFER_PULL_THRESHOLD = 200_000

/** Spec 17-a: delete-orphan theo batch ≤500 ids/lần — chọn 150 để URL REST an toàn
 *  (id UUID 36 ký tự × ~45 chars URL-encoded ≈ 6.8KB < gateway limit ~8KB) */
const DELETE_BATCH_SIZE = 150

/**
 * FIX 17-a: cảnh báo trước khi pull nếu backup table buffer có > 200k rows.
 * Fail-open hoàn toàn — lỗi count chỉ bị bỏ qua, pull vẫn chạy bình thường.
 */
async function warnLargeBackupPull(
  client: SupabaseClient,
  tableName: string,
  warnings: string[]
): Promise<void> {
  try {
    const { count, error } = await client.from(tableName).select('*', { count: 'exact', head: true })
    if (!error && typeof count === 'number' && count > LARGE_BUFFER_PULL_THRESHOLD) {
      const msg = `${tableName}: ${count} rows to pull (> ${LARGE_BUFFER_PULL_THRESHOLD}) — pulling anyway`
      console.warn(`[Supabase] Large buffer warning: ${msg}`)
      warnings.push(msg)
    }
  } catch { /* chỉ là cảnh báo — fail-open */ }
}

/**
 * FIX 17-a (pull theo document còn sống): giữ row KHÔNG có documentId
 * (auto-learn / knowledge_write writes) + row thuộc Document còn tồn tại trong DB local.
 * liveDocIds = null → không filter (fail-open, giữ behavior cũ).
 */
function filterRowsByLiveDocuments<T>(
  rows: T[],
  liveDocIds: Set<string> | null,
  getDocId: (row: T) => string | null | undefined
): T[] {
  if (liveDocIds === null) return rows
  return rows.filter(row => {
    const did = getDocId(row)
    return !did || liveDocIds.has(did)
  })
}

/**
 * FIX 17-a (push delete-orphan): sau khi push upsert xong, xóa các row trong backup
 * table mà id KHÔNG còn tồn tại local — backup mirror local, ngừng tích lũy vĩnh viễn.
 *
 * Safety:
 *  - Local trống hoàn toàn (0 row) → SKIP prune + warn (tránh wipe toàn bộ backup khi
 *    local trống do lỗi)
 *  - Fetch id backup lỗi / pagination chưa xong → SKIP prune (không delete mù)
 *  - Mọi lỗi fail-open (log + trả error, KHÔNG throw làm crash push)
 */
async function deleteOrphanBackupRows(
  client: SupabaseClient,
  tableName: string,
  tableLabel: string,
  fetchLocalIds: () => Promise<Array<{ id: string }>>
): Promise<{ pruned: number; error?: string }> {
  try {
    const localRows = await fetchLocalIds()
    if (localRows.length === 0) {
      console.warn(`[Supabase] Prune skipped for ${tableName}: local ${tableLabel} is EMPTY — not wiping backup (fail-open)`)
      return { pruned: 0 }
    }
    const localIds = new Set(localRows.map(r => r.id))

    // Fetch TOÀN BỘ id hiện có trong backup — phải fetch xong mới được delete
    const backupIds: string[] = []
    let lastId: string | null = null
    let fetchComplete = false
    for (let page = 0; page < 1000; page++) {
      let query = client.from(tableName).select('id').order('id').limit(1000)
      if (lastId) query = query.gt('id', lastId)
      const { data, error } = await query
      if (error) return { pruned: 0, error: `fetch ids: ${error.message}` }
      if (!data || data.length === 0) { fetchComplete = true; break }
      for (const row of data) {
        if (row?.id) backupIds.push(row.id)
      }
      lastId = data[data.length - 1].id
      if (data.length < 1000) { fetchComplete = true; break }
    }
    if (!fetchComplete) return { pruned: 0, error: 'fetch ids: pagination cap reached (backup > 1M rows?)' }

    const orphans = backupIds.filter(id => !localIds.has(id))
    if (orphans.length === 0) return { pruned: 0 }

    // Delete theo batch ≤ DELETE_BATCH_SIZE ids/lần qua Supabase REST
    let pruned = 0
    let firstError: string | undefined
    for (let i = 0; i < orphans.length; i += DELETE_BATCH_SIZE) {
      const batch = orphans.slice(i, i + DELETE_BATCH_SIZE)
      const { error } = await client.from(tableName).delete().in('id', batch)
      if (error) {
        if (!firstError) firstError = error.message
      } else {
        pruned += batch.length
      }
    }
    if (pruned > 0) {
      console.log(`[Supabase] Pruned ${pruned}/${orphans.length} orphan rows from ${tableName} (local ${tableLabel}: ${localIds.size} rows)`)
    }
    return { pruned, error: firstError }
  } catch (e) {
    return { pruned: 0, error: String(e) }
  }
}

// ==================== PUSH (SQLite → Supabase) ====================

/**
 * Push all SQLite data to Supabase (backup).
 * Called periodically or on demand.
 */
export async function pushToSupabase(): Promise<FullSyncResult> {
  const startTime = Date.now()
  const client = getSupabase()
  if (!client) {
    return { results: [], totalPushed: 0, totalPulled: 0, durationMs: 0 }
  }

  const results: SyncResult[] = []
  let totalPushed = 0
  // FIX 17-a: tổng số row backup đã prune (delete-orphan)
  let totalPruned = 0

  // 1. AgentProfile
  try {
    const agents = await db.agentProfile.findMany()
    const { error } = await client.from('agent_profiles_backup').upsert(
      agents.map(a => ({
        id: a.id,
        name: a.name,
        description: a.description,
        instruction: a.instruction,
        capable: a.capable,
        domain: a.domain,
        provider: a.provider,
        model: a.model,
        team: a.team || null,
        position: a.position || null,
        avatar: a.avatar,
        temperature: String(a.temperature),
        maxTokens: String(a.maxTokens),
        enabled: a.enabled,
        isSystem: a.isSystem,
        updated_at: new Date().toISOString(),
      })),
      { onConflict: 'id' }
    )
    results.push({ table: 'AgentProfile', pushed: agents.length, pulled: 0, errors: error ? [error.message] : [] })
    totalPushed += agents.length
  } catch (e) { results.push({ table: 'AgentProfile', pushed: 0, pulled: 0, errors: [String(e)] }) }

  // 2. AgentSkill
  try {
    const skills = await db.agentSkill.findMany()
    const { error } = await client.from('agent_skills_backup').upsert(
      skills.map(s => ({
        id: s.id,
        agent_id: s.agentId,
        slug: s.slug,
        name: s.name,
        content: s.content,
        source: s.source,
        enabled: s.enabled,
        version: s.version,
        installed_at: s.installedAt?.toISOString(),
        updated_at: s.updatedAt?.toISOString(),
      })),
      { onConflict: 'id' }
    )
    results.push({ table: 'AgentSkill', pushed: skills.length, pulled: 0, errors: error ? [error.message] : [] })
    totalPushed += skills.length
  } catch (e) { results.push({ table: 'AgentSkill', pushed: 0, pulled: 0, errors: [String(e)] }) }

  // 3. AgentMemory — FULL backup including qdrantPointId, embeddingModel, tags, domain, tier, expiresAt
  //    (Previous version omitted these — memory would lose vector linkage on restore)
  try {
    const memories = await db.agentMemory.findMany({ take: 1000 })
    const { error } = await client.from('agent_memory_backup').upsert(
      memories.map(m => ({
        id: m.id,
        agent_id: m.agentId,
        agent_name: m.agentName,
        session_id: m.sessionId,
        category: m.category,
        content: m.content,
        context: m.context,
        importance: m.importance,
        access_count: m.accessCount,
        last_accessed_at: m.lastAccessedAt?.toISOString(),
        qdrant_point_id: m.qdrantPointId,
        embedding_model: m.embeddingModel,
        source: m.source,
        tags: m.tags,
        domain: (m as { domain?: string }).domain || 'work',
        tier: (m as { tier?: string }).tier || 'warm',
        is_active: m.isActive,
        expires_at: (m as { expiresAt?: Date | null }).expiresAt?.toISOString(),
        created_at: m.createdAt?.toISOString(),
        updated_at: m.updatedAt?.toISOString(),
      })),
      { onConflict: 'id' }
    )
    results.push({ table: 'AgentMemory', pushed: memories.length, pulled: 0, errors: error ? [error.message] : [] })
    totalPushed += memories.length
  } catch (e) { results.push({ table: 'AgentMemory', pushed: 0, pulled: 0, errors: [String(e)] }) }

  // 3b. MemoryArchive — COLD tier summaries (NEW backup target)
  try {
    const archives = await db.memoryArchive.findMany({ take: 1000 })
    const { error } = await client.from('memory_archive_backup').upsert(
      archives.map(a => ({
        id: a.id,
        agent_id: a.agentId,
        original_ids: a.originalIds,
        summary_content: a.summaryContent,
        domain: a.domain,
        importance: a.importance,
        source_count: a.sourceCount,
        qdrant_point_id: a.qdrantPointId,
        embedding_model: a.embeddingModel,
        expires_at: a.expiresAt?.toISOString(),
        created_at: a.createdAt?.toISOString(),
      })),
      { onConflict: 'id' }
    )
    results.push({ table: 'MemoryArchive', pushed: archives.length, pulled: 0, errors: error ? [error.message] : [] })
    totalPushed += archives.length
  } catch (e) { results.push({ table: 'MemoryArchive', pushed: 0, pulled: 0, errors: [String(e)] }) }

  // 3c. MemoryAccessLog — access history for recall analytics (NEW backup target)
  try {
    const logs = await db.memoryAccessLog.findMany({ take: 1000, orderBy: { createdAt: 'desc' } })
    const { error } = await client.from('memory_access_log_backup').upsert(
      logs.map(l => ({
        id: l.id,
        memory_id: l.memoryId,
        agent_id: l.agentId,
        session_id: l.sessionId,
        query: l.query,
        relevance: l.relevance,
        created_at: l.createdAt?.toISOString(),
      })),
      { onConflict: 'id' }
    )
    results.push({ table: 'MemoryAccessLog', pushed: logs.length, pulled: 0, errors: error ? [error.message] : [] })
    totalPushed += logs.length
  } catch (e) { results.push({ table: 'MemoryAccessLog', pushed: 0, pulled: 0, errors: [String(e)] }) }

  // 4. AgentSession
  try {
    const sessions = await db.agentSession.findMany({ take: 200 })
    const { error } = await client.from('agent_sessions_backup').upsert(
      sessions.map(s => ({
        session_id: s.sessionId,
        model: s.model,
        provider: s.provider,
        title: s.title,
        message_count: s.messageCount,
        agent_profile_id: s.agentProfileId,
        team_mode: s.teamMode,
        team_name: s.teamName,
        updated_at: new Date().toISOString(),
      })),
      { onConflict: 'session_id' }
    )
    results.push({ table: 'AgentSession', pushed: sessions.length, pulled: 0, errors: error ? [error.message] : [] })
    totalPushed += sessions.length
  } catch (e) { results.push({ table: 'AgentSession', pushed: 0, pulled: 0, errors: [String(e)] }) }

  // 5. ChatMessage
  try {
    const messages = await db.chatMessage.findMany({ take: 500, orderBy: { createdAt: 'desc' } })
    const { error } = await client.from('chat_messages_backup').upsert(
      messages.map(m => ({
        id: m.id,
        session_id: m.sessionId,
        role: m.role,
        content: m.content,
        model: (m as { model?: string }).model || null,
        provider: (m as { provider?: string }).provider || null,
        created_at: m.createdAt?.toISOString(),
      })),
      { onConflict: 'id' }
    )
    results.push({ table: 'ChatMessage', pushed: messages.length, pulled: 0, errors: error ? [error.message] : [] })
    totalPushed += messages.length
  } catch (e) { results.push({ table: 'ChatMessage', pushed: 0, pulled: 0, errors: [String(e)] }) }

  // 6. TokenUsage
  try {
    const tokens = await db.dailyTokenByProviderModel.findMany()
    const { error } = await client.from('token_usage_backup').upsert(
      tokens.map(t => ({
        id: t.id,
        date: t.date,
        provider: t.provider,
        model: t.model,
        tokens: t.tokens,
        updated_at: t.updatedAt?.toISOString(),
      })),
      { onConflict: 'id' }
    )
    results.push({ table: 'TokenUsage', pushed: tokens.length, pulled: 0, errors: error ? [error.message] : [] })
    totalPushed += tokens.length
  } catch (e) { results.push({ table: 'TokenUsage', pushed: 0, pulled: 0, errors: [String(e)] }) }

  // 7. MCPBridgeConfig
  try {
    const configs = await db.mCPBridgeConfig.findMany()
    const { error } = await client.from('mcp_bridge_config_backup').upsert(
      configs.map(c => ({
        id: c.id,
        direction: c.direction,
        tool_name: c.toolName,
        enabled: c.enabled,
        config: c.config as unknown as Record<string, unknown>,
        updated_at: c.updatedAt?.toISOString(),
      })),
      { onConflict: 'id' }
    )
    results.push({ table: 'MCPBridgeConfig', pushed: configs.length, pulled: 0, errors: error ? [error.message] : [] })
    totalPushed += configs.length
  } catch (e) { results.push({ table: 'MCPBridgeConfig', pushed: 0, pulled: 0, errors: [String(e)] }) }

  // 8. KnowledgeAccessPolicy
  try {
    const policies = await db.knowledgeAccessPolicy.findMany()
    const { error } = await client.from('knowledge_access_policy_backup').upsert(
      policies.map(p => ({
        id: p.id,
        agent_id: p.agentId,
        allow_read: p.allowRead,
        allow_write: p.allowWrite,
        allow_delete: p.allowDelete,
        allowed_collections: p.allowedCollections,
        allowed_labels: p.allowedLabels,
      })),
      { onConflict: 'id' }
    )
    results.push({ table: 'KnowledgeAccessPolicy', pushed: policies.length, pulled: 0, errors: error ? [error.message] : [] })
    totalPushed += policies.length
  } catch (e) { results.push({ table: 'KnowledgeAccessPolicy', pushed: 0, pulled: 0, errors: [String(e)] }) }

  // 9. UserProfile — personal data (name, language, preferences, expertise)
  try {
    const profiles = await db.userProfile.findMany()
    const { error } = await client.from('user_profile_backup').upsert(
      profiles.map(p => ({
        id: p.id,
        user_id: p.userId,
        key: p.key,
        value: p.value,
        source: p.source,
        confidence: p.confidence,
        access_count: p.accessCount,
        is_active: p.isActive,
        created_at: p.createdAt?.toISOString(),
        updated_at: p.updatedAt?.toISOString(),
      })),
      { onConflict: 'id' }
    )
    results.push({ table: 'UserProfile', pushed: profiles.length, pulled: 0, errors: error ? [error.message] : [] })
    totalPushed += profiles.length
  } catch (e) { results.push({ table: 'UserProfile', pushed: 0, pulled: 0, errors: [String(e)] }) }

  // 10. AgentInsight — auto-learned insights (factual/procedural/preference/pattern)
  try {
    const insights = await db.agentInsight.findMany({ take: 1000 })
    const { error } = await client.from('agent_insight_backup').upsert(
      insights.map(i => ({
        id: i.id,
        agent_id: i.agentId,
        content: i.content,
        source: i.source,
        type: i.type,
        confidence: i.confidence,
        created_at: i.createdAt?.toISOString(),
      })),
      { onConflict: 'id' }
    )
    results.push({ table: 'AgentInsight', pushed: insights.length, pulled: 0, errors: error ? [error.message] : [] })
    totalPushed += insights.length
  } catch (e) { results.push({ table: 'AgentInsight', pushed: 0, pulled: 0, errors: [String(e)] }) }

  // 11. AgentPreference — agent-specific preferences
  try {
    const prefs = await db.agentPreference.findMany()
    const { error } = await client.from('agent_preference_backup').upsert(
      prefs.map(p => ({
        id: p.id,
        agent_id: p.agentId,
        preference_key: p.preferenceKey,
        preference_value: p.preferenceValue,
        source: p.source,
        created_at: p.createdAt?.toISOString(),
      })),
      { onConflict: 'id' }
    )
    results.push({ table: 'AgentPreference', pushed: prefs.length, pulled: 0, errors: error ? [error.message] : [] })
    totalPushed += prefs.length
  } catch (e) { results.push({ table: 'AgentPreference', pushed: 0, pulled: 0, errors: [String(e)] }) }

  // 12. AgentCorrection — corrections from feedback
  try {
    const corrections = await db.agentCorrection.findMany({ take: 1000 })
    const { error } = await client.from('agent_correction_backup').upsert(
      corrections.map(c => ({
        id: c.id,
        agent_id: c.agentId,
        wrong_answer: c.wrongAnswer,
        correct_answer: c.correctAnswer,
        reason: c.reason,
        applied: c.applied,
        created_at: c.createdAt?.toISOString(),
      })),
      { onConflict: 'id' }
    )
    results.push({ table: 'AgentCorrection', pushed: corrections.length, pulled: 0, errors: error ? [error.message] : [] })
    totalPushed += corrections.length
  } catch (e) { results.push({ table: 'AgentCorrection', pushed: 0, pulled: 0, errors: [String(e)] }) }

  // 15. Document — document processing state (CRITICAL for surviving sandbox resets)
  //     Requires the documents_backup table created by migration
  //     supabase/migrations/20260822110000_add_document_extraction_backup_tables.sql
  try {
    const docs = await db.document.findMany()
    const { error } = await client.from('documents_backup').upsert(
      docs.map(d => ({
        id: d.id,
        title: d.title,
        file_path: d.filePath,
        domain: d.domain,
        page_count: d.pageCount,
        status: d.status,
        error_message: d.errorMessage,
        user_paused: d.userPaused,
        processing_steps: d.processingSteps,
        processing_percent: d.processingPercent,
        created_at: d.createdAt?.toISOString(),
        updated_at: d.updatedAt?.toISOString(),
      })),
      { onConflict: 'id' }
    )
    results.push({ table: 'Document', pushed: docs.length, pulled: 0, errors: error ? [error.message] : [] })
    totalPushed += docs.length
  } catch (e) { results.push({ table: 'Document', pushed: 0, pulled: 0, errors: [String(e)] }) }

  // 16. LocalEntity — extracted entities buffer (mirrors Neo4j after sync)
  try {
    const pushErrors: string[] = []
    const pushed = await pushTablePaginated(
      client,
      'local_entities_backup',
      (cursorId) => db.localEntity.findMany({
        take: PUSH_PAGE_SIZE,
        orderBy: { id: 'asc' },
        ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
      }),
      (e) => ({
        id: e.id,
        document_id: e.documentId,
        chunk_id: e.chunkId,
        entity_name: e.entityName,
        entity_type: e.entityType,
        description: e.description,
        properties: e.properties,
        confidence_score: e.confidenceScore,
        source: e.source,
        domain: e.domain,
        resolved_entity_id: e.resolvedEntityId,
        synced: e.synced,
        created_at: e.createdAt?.toISOString(),
        updated_at: e.updatedAt?.toISOString(),
      }),
      pushErrors
    )
    // FIX 17-a: prune backup append-only — xóa row backup mà id KHÔNG còn tồn tại local
    const prune = await deleteOrphanBackupRows(client, 'local_entities_backup', 'LocalEntity',
      () => db.localEntity.findMany({ select: { id: true } }))
    if (prune.error) pushErrors.push(`prune: ${prune.error}`)
    results.push({ table: 'LocalEntity', pushed, pulled: 0, errors: pushErrors.slice(-3), pruned: prune.pruned })
    totalPushed += pushed
    totalPruned += prune.pruned
  } catch (e) { results.push({ table: 'LocalEntity', pushed: 0, pulled: 0, errors: [String(e)] }) }

  // 17. LocalRelationship — extracted relationships buffer
  try {
    const relErrors: string[] = []
    const pushed = await pushTablePaginated(
      client,
      'local_relationships_backup',
      (cursorId) => db.localRelationship.findMany({
        take: PUSH_PAGE_SIZE,
        orderBy: { id: 'asc' },
        ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
      }),
      (r) => ({
        id: r.id,
        document_id: r.documentId,
        source_entity_id: r.sourceEntityId,
        target_entity_id: r.targetEntityId,
        source_entity_name: r.sourceEntityName,
        target_entity_name: r.targetEntityName,
        relationship_type: r.relationshipType,
        description: r.description,
        confidence_score: r.confidenceScore,
        source: r.source,
        synced: r.synced,
        created_at: r.createdAt?.toISOString(),
        updated_at: r.updatedAt?.toISOString(),
      }),
      relErrors
    )
    // FIX 17-a: prune backup append-only — xóa row backup mà id KHÔNG còn tồn tại local
    const prune = await deleteOrphanBackupRows(client, 'local_relationships_backup', 'LocalRelationship',
      () => db.localRelationship.findMany({ select: { id: true } }))
    if (prune.error) relErrors.push(`prune: ${prune.error}`)
    results.push({ table: 'LocalRelationship', pushed, pulled: 0, errors: relErrors.slice(-3), pruned: prune.pruned })
    totalPushed += pushed
    totalPruned += prune.pruned
  } catch (e) { results.push({ table: 'LocalRelationship', pushed: 0, pulled: 0, errors: [String(e)] }) }

  // 18. LocalResolvedEntity — canonical merged entities (post-resolution)
  try {
    const resErrors: string[] = []
    const pushed = await pushTablePaginated(
      client,
      'local_resolved_entities_backup',
      (cursorId) => db.localResolvedEntity.findMany({
        take: PUSH_PAGE_SIZE,
        orderBy: { id: 'asc' },
        ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
      }),
      (r) => ({
        id: r.id,
        document_id: r.documentId,
        canonical_name: r.canonicalName,
        entity_type: r.entityType,
        description: r.description,
        properties: r.properties,
        avg_confidence: r.avgConfidence,
        occurrence_count: r.occurrenceCount,
        domains: r.domains,
        synced: r.synced,
        created_at: r.createdAt?.toISOString(),
        updated_at: r.updatedAt?.toISOString(),
      }),
      resErrors
    )
    // FIX 17-a: prune backup append-only — xóa row backup mà id KHÔNG còn tồn tại local
    const prune = await deleteOrphanBackupRows(client, 'local_resolved_entities_backup', 'LocalResolvedEntity',
      () => db.localResolvedEntity.findMany({ select: { id: true } }))
    if (prune.error) resErrors.push(`prune: ${prune.error}`)
    results.push({ table: 'LocalResolvedEntity', pushed, pulled: 0, errors: resErrors.slice(-3), pruned: prune.pruned })
    totalPushed += pushed
    totalPruned += prune.pruned
  } catch (e) { results.push({ table: 'LocalResolvedEntity', pushed: 0, pulled: 0, errors: [String(e)] }) }

  // 19. LearningLog — learning event log (Phase 3 SMOLAB Prop 10 — sync 5 missing learning tables)
  try {
    const logs = await db.learningLog.findMany({ take: 5000, orderBy: { createdAt: 'desc' } })
    const { error } = await client.from('learning_log_backup').upsert(
      logs.map(l => ({
        id: l.id,
        session_id: l.sessionId,
        agent_id: l.agentId,
        event_type: l.eventType,
        content: l.content,
        metadata: l.metadata,
        created_at: l.createdAt?.toISOString(),
      })),
      { onConflict: 'id' }
    )
    results.push({ table: 'LearningLog', pushed: logs.length, pulled: 0, errors: error ? [error.message] : [] })
    totalPushed += logs.length
  } catch (e) { results.push({ table: 'LearningLog', pushed: 0, pulled: 0, errors: [String(e)] }) }

  // 20. AutoLearnRecord — auto-learned knowledge audits (Phase 3 SMOLAB Prop 10)
  try {
    const records = await db.autoLearnRecord.findMany({ take: 5000, orderBy: { createdAt: 'desc' } })
    const { error } = await client.from('auto_learn_record_backup').upsert(
      records.map(r => ({
        id: r.id,
        agent_id: r.agentId,
        agent_name: r.agentName,
        query: r.query,
        answer_preview: r.answerPreview,
        confidence: r.confidence,
        provider: r.provider,
        model: r.model,
        entities_count: r.entitiesCount,
        relationships_count: r.relationshipsCount,
        chunk_saved: r.chunkSaved,
        neo4j_synced: r.neo4jSynced,
        qdrant_point_id: r.qdrantPointId,
        document_id: r.documentId,
        status: r.status,
        error_message: r.errorMessage,
        created_at: r.createdAt?.toISOString(),
      })),
      { onConflict: 'id' }
    )
    results.push({ table: 'AutoLearnRecord', pushed: records.length, pulled: 0, errors: error ? [error.message] : [] })
    totalPushed += records.length
  } catch (e) { results.push({ table: 'AutoLearnRecord', pushed: 0, pulled: 0, errors: [String(e)] }) }

  // 21. ExecutionMetrics — Layer 9 workflow run metrics (Phase 3 SMOLAB Prop 10; Phase 6 Prop 2 added model)
  try {
    const metrics = await db.executionMetrics.findMany({ take: 5000, orderBy: { createdAt: 'desc' } })
    const { error } = await client.from('execution_metrics_backup').upsert(
      metrics.map(m => ({
        id: m.id,
        session_id: m.sessionId,
        plan_id: m.planId,
        routing_mode: m.routingMode,
        tier: m.tier,
        total_steps: m.totalSteps,
        completed_steps: m.completedSteps,
        failed_steps: m.failedSteps,
        total_tokens_used: m.totalTokensUsed,
        total_tokens_budgeted: m.totalTokensBudgeted,
        total_time_spent: m.totalTimeSpent,
        errors_by_type: m.errorsByType,
        step_success_rate: m.stepSuccessRate,
        token_efficiency: m.tokenEfficiency,
        created_at: m.createdAt?.toISOString(),
      })),
      { onConflict: 'id' }
    )
    results.push({ table: 'ExecutionMetrics', pushed: metrics.length, pulled: 0, errors: error ? [error.message] : [] })
    totalPushed += metrics.length
  } catch (e) { results.push({ table: 'ExecutionMetrics', pushed: 0, pulled: 0, errors: [String(e)] }) }

  // 22. FailurePattern — Layer 9.2 failure pattern detection (Phase 3 SMOLAB Prop 10; Phase 6 Prop 2 added model)
  //     NOTE: FailurePattern has NO createdAt field — push does not serialize a timestamp.
  try {
    const patterns = await db.failurePattern.findMany({ take: 5000 })
    const { error } = await client.from('failure_pattern_backup').upsert(
      patterns.map(p => ({
        id: p.id,
        session_id: p.sessionId,
        type: p.type,
        count: p.count,
        strategies_tried: p.strategiesTried,
        next_strategy: p.nextStrategy,
        context: p.context,
        resolved: p.resolved,
      })),
      { onConflict: 'id' }
    )
    results.push({ table: 'FailurePattern', pushed: patterns.length, pulled: 0, errors: error ? [error.message] : [] })
    totalPushed += patterns.length
  } catch (e) { results.push({ table: 'FailurePattern', pushed: 0, pulled: 0, errors: [String(e)] }) }

  // 23. StrategyAdaptationLog — Layer 9.2 adaptation audit (Phase 3 SMOLAB Prop 10; Phase 6 Prop 2 added model)
  try {
    const adaptations = await db.strategyAdaptationLog.findMany({ take: 5000, orderBy: { createdAt: 'desc' } })
    const { error } = await client.from('strategy_adaptation_log_backup').upsert(
      adaptations.map(a => ({
        id: a.id,
        session_id: a.sessionId,
        pattern_id: a.patternId,
        from_strategy: a.fromStrategy,
        to_strategy: a.toStrategy,
        reason: a.reason,
        confidence: a.confidence,
        successful: a.successful,
        created_at: a.createdAt?.toISOString(),
      })),
      { onConflict: 'id' }
    )
    results.push({ table: 'StrategyAdaptationLog', pushed: adaptations.length, pulled: 0, errors: error ? [error.message] : [] })
    totalPushed += adaptations.length
  } catch (e) { results.push({ table: 'StrategyAdaptationLog', pushed: 0, pulled: 0, errors: [String(e)] }) }

  const durationMs = Date.now() - startTime
  console.log(`[Supabase] Push complete: ${totalPushed} records pushed, ${totalPruned} pruned in ${durationMs}ms`)
  return { results, totalPushed, totalPulled: 0, durationMs, totalPruned }
}

// ==================== PULL (Supabase → SQLite) ====================

/**
 * Pull all data from Supabase to SQLite (restore after sandbox reset).
 * Called on startup or manually via /api/storage/supabase-sync.
 */
export async function pullFromSupabase(): Promise<FullSyncResult> {
  const startTime = Date.now()
  const client = getSupabase()
  if (!client) {
    return { results: [], totalPushed: 0, totalPulled: 0, durationMs: 0 }
  }

  const results: SyncResult[] = []
  let totalPulled = 0

  // 1. AgentProfile — restore agent configs (including correct model = kimi-k3)
  try {
    const { data, error } = await client.from('agent_profiles_backup').select('*')
    if (!error && data && data.length > 0) {
      let pulled = 0
      for (const a of data) {
        try {
          // Check if an agent with this name already exists (avoid unique constraint violation)
          const existing = await db.agentProfile.findFirst({ where: { name: a.name }, select: { id: true } })
          if (existing && existing.id !== a.id) {
            // Name conflict — skip this record (keep existing local agent)
            continue
          }
          // FIX (2026-09-03, Task 23 — E2E quét hệ thống): row local TỒN TẠI
          // (cùng id/name) → upsert với update RỖNG (no-op) — KHÔNG đè field
          // nào. Bản cũ update { model, enabled: a.enabled } từ cloud backup
          // đã re-enable 7 agent trùm cũ (KING/APEX/VIGIL/BOLT/CORTEX/SENTRY/
          // HOWENT) mà Task 21 đã tắt ở SQLite — vì backup cloud là trạng thái
          // CŨ (enabled=true), push trước lúc disable. `enabled` là QUYẾT ĐỊNH
          // VẬN HÀNH LOCAL (user disable agent trong UI/DB) — cloud restore
          // không có quyền bật lại; model/instruction cũng là customization
          // local cần giữ. Giữ upsert (chứ không đổi thành create thường) để
          // branch create vẫn dựng row CÙNG id từ backup — preserve FK links
          // (agent_profile_id trong AgentMemory restore) cho use-case gốc:
          // sandbox reset (local rỗng) → mọi row create mới từ backup.
          // Mirror tinh thần "user customizations preserved" của
          // standalone-agents/code-team seed.
          await db.agentProfile.upsert({
            where: { id: a.id },
            create: {
              id: a.id,
              name: a.name,
              description: a.description || '',
              instruction: a.instruction || '',
              capable: a.capable || '',
              domain: a.domain || 'mixed',
              provider: a.provider || 'nvidia',
              model: a.model || 'minimaxai/minimax-m3',
              team: a.team || null,
              position: a.position || null,
              avatar: a.avatar || '🤖',
              temperature: parseFloat(a.temperature) || 0.5,
              maxTokens: parseInt(a.maxTokens) || 4096,
              enabled: a.enabled ?? true,
              isSystem: a.isSystem ?? false,
            },
            update: {},
          })
          pulled++
        } catch (e) { /* skip individual conflict */ }
      }
      results.push({ table: 'AgentProfile', pushed: 0, pulled, errors: [] })
      totalPulled += pulled
    } else {
      results.push({ table: 'AgentProfile', pushed: 0, pulled: 0, errors: error ? [error.message] : [] })
    }
  } catch (e) { results.push({ table: 'AgentProfile', pushed: 0, pulled: 0, errors: [String(e)] }) }

  // 2. AgentMemory — FULL restore including qdrantPointId + embeddingModel + tags + domain + tier + expiresAt
  try {
    const { data, error } = await client.from('agent_memory_backup').select('*').limit(1000)
    if (!error && data && data.length > 0) {
      for (const m of data) {
        await db.agentMemory.upsert({
          where: { id: m.id },
          create: {
            id: m.id,
            agentId: m.agent_id,
            agentName: m.agent_name || 'unknown',
            sessionId: m.session_id,
            category: m.category,
            content: m.content,
            context: m.context,
            importance: m.importance || 0.5,
            accessCount: m.access_count || 0,
            lastAccessedAt: m.last_accessed_at ? new Date(m.last_accessed_at) : null,
            qdrantPointId: m.qdrant_point_id || null,
            embeddingModel: m.embedding_model || null,
            source: m.source || 'auto',
            tags: m.tags || null,
            domain: m.domain || 'work',
            tier: m.tier || 'warm',
            isActive: m.is_active ?? true,
            expiresAt: m.expires_at ? new Date(m.expires_at) : null,
          },
          update: {
            // Update mutable fields on existing records
            content: m.content,
            importance: m.importance || 0.5,
            accessCount: m.access_count || 0,
            lastAccessedAt: m.last_accessed_at ? new Date(m.last_accessed_at) : undefined,
            qdrantPointId: m.qdrant_point_id || null,
            embeddingModel: m.embedding_model || null,
            tags: m.tags || null,
            domain: m.domain || 'work',
            tier: m.tier || 'warm',
            isActive: m.is_active ?? true,
            expiresAt: m.expires_at ? new Date(m.expires_at) : null,
          },
        })
      }
      results.push({ table: 'AgentMemory', pushed: 0, pulled: data.length, errors: [] })
      totalPulled += data.length
    } else {
      results.push({ table: 'AgentMemory', pushed: 0, pulled: 0, errors: error ? [error.message] : [] })
    }
  } catch (e) { results.push({ table: 'AgentMemory', pushed: 0, pulled: 0, errors: [String(e)] }) }

  // 2b. MemoryArchive — restore COLD tier summaries
  try {
    const { data, error } = await client.from('memory_archive_backup').select('*').limit(1000)
    if (!error && data && data.length > 0) {
      for (const a of data) {
        await db.memoryArchive.upsert({
          where: { id: a.id },
          create: {
            id: a.id,
            agentId: a.agent_id,
            originalIds: a.original_ids,
            summaryContent: a.summary_content,
            domain: a.domain || 'work',
            importance: a.importance || 0.3,
            sourceCount: a.source_count || 1,
            qdrantPointId: a.qdrant_point_id || null,
            embeddingModel: a.embedding_model || null,
            expiresAt: a.expires_at ? new Date(a.expires_at) : null,
            createdAt: a.created_at ? new Date(a.created_at) : new Date(),
          },
          update: {
            summaryContent: a.summary_content,
            importance: a.importance || 0.3,
            qdrantPointId: a.qdrant_point_id || null,
          },
        })
      }
      results.push({ table: 'MemoryArchive', pushed: 0, pulled: data.length, errors: [] })
      totalPulled += data.length
    } else {
      results.push({ table: 'MemoryArchive', pushed: 0, pulled: 0, errors: error ? [error.message] : [] })
    }
  } catch (e) { results.push({ table: 'MemoryArchive', pushed: 0, pulled: 0, errors: [String(e)] }) }

  // 2c. MemoryAccessLog — restore access history (skip conflicts to preserve latest)
  try {
    const { data, error } = await client.from('memory_access_log_backup').select('*').limit(1000)
    if (!error && data && data.length > 0) {
      let pulled = 0
      for (const l of data) {
        try {
          await db.memoryAccessLog.upsert({
            where: { id: l.id },
            create: {
              id: l.id,
              memoryId: l.memory_id,
              agentId: l.agent_id,
              sessionId: l.session_id,
              query: l.query,
              relevance: l.relevance || 0.5,
              createdAt: l.created_at ? new Date(l.created_at) : new Date(),
            },
            update: {},
          })
          pulled++
        } catch { /* skip conflict */ }
      }
      results.push({ table: 'MemoryAccessLog', pushed: 0, pulled, errors: [] })
      totalPulled += pulled
    } else {
      results.push({ table: 'MemoryAccessLog', pushed: 0, pulled: 0, errors: error ? [error.message] : [] })
    }
  } catch (e) { results.push({ table: 'MemoryAccessLog', pushed: 0, pulled: 0, errors: [String(e)] }) }

  // 3. AgentSkill — restore installed skills
  try {
    const { data, error } = await client.from('agent_skills_backup').select('*').limit(500)
    if (!error && data && data.length > 0) {
      let pulled = 0
      for (const s of data) {
        try {
          await db.agentSkill.upsert({
            where: { id: s.id },
            create: {
              id: s.id,
              agentId: s.agent_id || 'default',
              slug: s.slug,
              name: s.name,
              content: s.content,
              source: s.source || 'bundled',
              enabled: s.enabled ?? true,
              version: s.version || '1.0.0',
              installedAt: s.installed_at ? new Date(s.installed_at) : new Date(),
            },
            update: {
              content: s.content,
              enabled: s.enabled ?? true,
              version: s.version,
            },
          })
          pulled++
        } catch { /* skip conflict */ }
      }
      results.push({ table: 'AgentSkill', pushed: 0, pulled, errors: [] })
      totalPulled += pulled
    } else {
      results.push({ table: 'AgentSkill', pushed: 0, pulled: 0, errors: error ? [error.message] : [] })
    }
  } catch (e) { results.push({ table: 'AgentSkill', pushed: 0, pulled: 0, errors: [String(e)] }) }

  // 4. AgentSession — restore chat sessions
  try {
    const { data, error } = await client.from('agent_sessions_backup').select('*').limit(500)
    if (!error && data && data.length > 0) {
      let pulled = 0
      for (const s of data) {
        try {
          await db.agentSession.upsert({
            where: { sessionId: s.session_id },
            create: {
              sessionId: s.session_id,
              model: s.model,
              provider: s.provider,
              title: s.title,
              messageCount: s.message_count || 0,
              agentProfileId: s.agent_profile_id,
              teamMode: s.team_mode,
              teamName: s.team_name,
            },
            update: {
              messageCount: s.message_count || 0,
              title: s.title,
            },
          })
          pulled++
        } catch { /* skip conflict */ }
      }
      results.push({ table: 'AgentSession', pushed: 0, pulled, errors: [] })
      totalPulled += pulled
    } else {
      results.push({ table: 'AgentSession', pushed: 0, pulled: 0, errors: error ? [error.message] : [] })
    }
  } catch (e) { results.push({ table: 'AgentSession', pushed: 0, pulled: 0, errors: [String(e)] }) }

  // 5. ChatMessage — restore chat history
  try {
    const { data, error } = await client.from('chat_messages_backup').select('*').limit(1000)
    if (!error && data && data.length > 0) {
      let pulled = 0
      for (const m of data) {
        try {
          await db.chatMessage.upsert({
            where: { id: m.id },
            create: {
              id: m.id,
              sessionId: m.session_id,
              role: m.role,
              content: m.content,
              model: m.model,
              provider: m.provider,
              createdAt: m.created_at ? new Date(m.created_at) : new Date(),
            },
            update: {},
          })
          pulled++
        } catch { /* skip conflict */ }
      }
      results.push({ table: 'ChatMessage', pushed: 0, pulled, errors: [] })
      totalPulled += pulled
    } else {
      results.push({ table: 'ChatMessage', pushed: 0, pulled: 0, errors: error ? [error.message] : [] })
    }
  } catch (e) { results.push({ table: 'ChatMessage', pushed: 0, pulled: 0, errors: [String(e)] }) }

  // 6. MCPBridgeConfig — restore MCP tool configs
  try {
    const { data, error } = await client.from('mcp_bridge_config_backup').select('*').limit(200)
    if (!error && data && data.length > 0) {
      let pulled = 0
      for (const c of data) {
        try {
          await db.mCPBridgeConfig.upsert({
            where: { id: c.id },
            create: {
              id: c.id,
              direction: c.direction,
              toolName: c.tool_name,
              enabled: c.enabled ?? true,
              config: typeof c.config === 'string' ? c.config : JSON.stringify(c.config || {}),
            },
            update: {
              enabled: c.enabled ?? true,
              config: typeof c.config === 'string' ? c.config : JSON.stringify(c.config || {}),
            },
          })
          pulled++
        } catch { /* skip conflict */ }
      }
      results.push({ table: 'MCPBridgeConfig', pushed: 0, pulled, errors: [] })
      totalPulled += pulled
    } else {
      results.push({ table: 'MCPBridgeConfig', pushed: 0, pulled: 0, errors: error ? [error.message] : [] })
    }
  } catch (e) { results.push({ table: 'MCPBridgeConfig', pushed: 0, pulled: 0, errors: [String(e)] }) }

  // 7. KnowledgeAccessPolicy — restore KB access policies
  try {
    const { data, error } = await client.from('knowledge_access_policy_backup').select('*').limit(100)
    if (!error && data && data.length > 0) {
      let pulled = 0
      for (const p of data) {
        try {
          await db.knowledgeAccessPolicy.upsert({
            where: { id: p.id },
            create: {
              id: p.id,
              agentId: p.agent_id || 'default',
              allowRead: p.allow_read ?? true,
              allowWrite: p.allow_write ?? true,
              allowDelete: p.allow_delete ?? false,
              allowedCollections: p.allowed_collections || 'theopus_documents,theopus_chunks',
              allowedLabels: p.allowed_labels || '*',
            },
            update: {
              allowRead: p.allow_read ?? true,
              allowWrite: p.allow_write ?? true,
              allowDelete: p.allow_delete ?? false,
            },
          })
          pulled++
        } catch { /* skip conflict */ }
      }
      results.push({ table: 'KnowledgeAccessPolicy', pushed: 0, pulled, errors: [] })
      totalPulled += pulled
    } else {
      results.push({ table: 'KnowledgeAccessPolicy', pushed: 0, pulled: 0, errors: error ? [error.message] : [] })
    }
  } catch (e) { results.push({ table: 'KnowledgeAccessPolicy', pushed: 0, pulled: 0, errors: [String(e)] }) }

  // 8. UserProfile — restore personal data (name, language, preferences)
  try {
    const { data, error } = await client.from('user_profile_backup').select('*').limit(500)
    if (!error && data && data.length > 0) {
      let pulled = 0
      for (const p of data) {
        try {
          await db.userProfile.upsert({
            where: { id: p.id },
            create: {
              id: p.id,
              userId: p.user_id || 'default',
              key: p.key,
              value: p.value,
              source: p.source || 'auto',
              confidence: p.confidence || 0.5,
              accessCount: p.access_count || 0,
              isActive: p.is_active ?? true,
            },
            update: {
              value: p.value,
              confidence: p.confidence,
              isActive: p.is_active ?? true,
            },
          })
          pulled++
        } catch { /* skip conflict */ }
      }
      results.push({ table: 'UserProfile', pushed: 0, pulled, errors: [] })
      totalPulled += pulled
    } else {
      results.push({ table: 'UserProfile', pushed: 0, pulled: 0, errors: error ? [error.message] : [] })
    }
  } catch (e) { results.push({ table: 'UserProfile', pushed: 0, pulled: 0, errors: [String(e)] }) }

  // 9. AgentInsight — restore auto-learned insights
  try {
    const { data, error } = await client.from('agent_insight_backup').select('*').limit(1000)
    if (!error && data && data.length > 0) {
      let pulled = 0
      for (const i of data) {
        try {
          await db.agentInsight.upsert({
            where: { id: i.id },
            create: {
              id: i.id,
              agentId: i.agent_id || 'default',
              content: i.content,
              source: i.source,
              type: i.type,
              confidence: i.confidence || 0.5,
              createdAt: i.created_at ? new Date(i.created_at) : new Date(),
            },
            update: {},
          })
          pulled++
        } catch { /* skip conflict */ }
      }
      results.push({ table: 'AgentInsight', pushed: 0, pulled, errors: [] })
      totalPulled += pulled
    } else {
      results.push({ table: 'AgentInsight', pushed: 0, pulled: 0, errors: error ? [error.message] : [] })
    }
  } catch (e) { results.push({ table: 'AgentInsight', pushed: 0, pulled: 0, errors: [String(e)] }) }

  // 10. AgentPreference — restore agent preferences
  try {
    const { data, error } = await client.from('agent_preference_backup').select('*').limit(500)
    if (!error && data && data.length > 0) {
      let pulled = 0
      for (const p of data) {
        try {
          await db.agentPreference.upsert({
            where: { id: p.id },
            create: {
              id: p.id,
              agentId: p.agent_id || 'default',
              preferenceKey: p.preference_key,
              preferenceValue: p.preference_value,
              source: p.source || 'auto',
              createdAt: p.created_at ? new Date(p.created_at) : new Date(),
            },
            update: {
              preferenceValue: p.preference_value,
            },
          })
          pulled++
        } catch { /* skip conflict */ }
      }
      results.push({ table: 'AgentPreference', pushed: 0, pulled, errors: [] })
      totalPulled += pulled
    } else {
      results.push({ table: 'AgentPreference', pushed: 0, pulled: 0, errors: error ? [error.message] : [] })
    }
  } catch (e) { results.push({ table: 'AgentPreference', pushed: 0, pulled: 0, errors: [String(e)] }) }

  // 11. AgentCorrection — restore agent corrections
  try {
    const { data, error } = await client.from('agent_correction_backup').select('*').limit(1000)
    if (!error && data && data.length > 0) {
      let pulled = 0
      for (const c of data) {
        try {
          await db.agentCorrection.upsert({
            where: { id: c.id },
            create: {
              id: c.id,
              agentId: c.agent_id || 'default',
              wrongAnswer: c.wrong_answer,
              correctAnswer: c.correct_answer,
              reason: c.reason,
              applied: c.applied ?? false,
              createdAt: c.created_at ? new Date(c.created_at) : new Date(),
            },
            update: {},
          })
          pulled++
        } catch { /* skip conflict */ }
      }
      results.push({ table: 'AgentCorrection', pushed: 0, pulled, errors: [] })
      totalPulled += pulled
    } else {
      results.push({ table: 'AgentCorrection', pushed: 0, pulled: 0, errors: error ? [error.message] : [] })
    }
  } catch (e) { results.push({ table: 'AgentCorrection', pushed: 0, pulled: 0, errors: [String(e)] }) }

  // 12. Document — restore document processing state
  //     Requires the documents_backup table created by migration
  //     supabase/migrations/20260822110000_add_document_extraction_backup_tables.sql
  //     FIX 17-a: track việc đọc documents_backup — nếu lỗi thì pull buffer sẽ KHÔNG áp
  //     dead-document filter (fail-open, tránh wipe buffer do restore Document thiếu)
  let documentsBackupPullOk = false
  try {
    const { data, error } = await client.from('documents_backup').select('*').limit(5000)
    documentsBackupPullOk = !error
    if (!error && data && data.length > 0) {
      let pulled = 0
      for (const d of data) {
        try {
          await db.document.upsert({
            where: { id: d.id },
            create: {
              id: d.id,
              title: d.title,
              filePath: d.file_path || '',
              domain: d.domain || 'mixed',
              pageCount: d.page_count ?? null,
              status: d.status || 'uploaded',
              errorMessage: d.error_message ?? null,
              userPaused: d.user_paused ?? false,
              processingSteps: d.processing_steps || '[]',
              processingPercent: d.processing_percent ?? 0,
              createdAt: d.created_at ? new Date(d.created_at) : new Date(),
              updatedAt: d.updated_at ? new Date(d.updated_at) : new Date(),
            },
            update: {
              title: d.title,
              filePath: d.file_path || '',
              domain: d.domain || 'mixed',
              pageCount: d.page_count ?? null,
              status: d.status || 'uploaded',
              errorMessage: d.error_message ?? null,
              userPaused: d.user_paused ?? false,
              processingSteps: d.processing_steps || '[]',
              processingPercent: d.processing_percent ?? 0,
              updatedAt: d.updated_at ? new Date(d.updated_at) : new Date(),
            },
          })
          pulled++
        } catch { /* skip conflict */ }
      }
      results.push({ table: 'Document', pushed: 0, pulled, errors: [] })
      totalPulled += pulled
    } else {
      results.push({ table: 'Document', pushed: 0, pulled: 0, errors: error ? [error.message] : [] })
    }
  } catch (e) { results.push({ table: 'Document', pushed: 0, pulled: 0, errors: [String(e)] }) }

  // FIX 17-a (pull theo document còn sống): set id Document hiện có trong DB local
  // (chạy SAU section 12 — Document đã được restore từ backup trước).
  // liveDocIds = null khi không check được (documents_backup đọc lỗi / DB lỗi)
  // → pull buffer KHÔNG filter, giữ behavior cũ (fail-open).
  let liveDocIds: Set<string> | null = null
  if (documentsBackupPullOk) {
    try {
      const liveDocs = await db.document.findMany({ select: { id: true } })
      liveDocIds = new Set(liveDocs.map(d => d.id))
    } catch { liveDocIds = null }
  }
  if (liveDocIds === null) {
    console.warn('[Supabase] Live-document set unavailable — pulling buffer WITHOUT dead-document filter (fail-open)')
  }
  // FIX 17-a: cảnh báo pull buffer quá lớn — stats trả về trong result.warnings
  const warnings: string[] = []

  // 13. LocalEntity — restore extracted entities buffer (PAGINATED + createMany with per-row fallback)
  try {
    await warnLargeBackupPull(client, 'local_entities_backup', warnings)
    // Clear existing rows for a clean insert (avoids skipDuplicates issues on SQLite)
    await db.localEntity.deleteMany()
    const errors: string[] = []
    // FIX 17-a: chỉ pull row của Document còn sống + row KHÔNG có documentId
    // (auto-learn / knowledge_write) — extraction của document đã xóa không kéo về nữa
    let skippedDeadDoc = 0
    const pulled = await pullTablePaginated(client, 'local_entities_backup', async (rows: any[]) => {
      const keep = filterRowsByLiveDocuments(rows, liveDocIds, (r: any) => r.document_id)
      skippedDeadDoc += rows.length - keep.length
      if (keep.length === 0) return 0
      try {
        const result = await db.localEntity.createMany({
          data: keep.map((e: any) => ({
            id: e.id,
            documentId: e.document_id ?? null,
            chunkId: e.chunk_id ?? null,
            entityName: e.entity_name,
            entityType: e.entity_type,
            description: e.description ?? null,
            properties: e.properties ?? null,
            confidenceScore: e.confidence_score ?? 0.5,
            source: e.source || 'unknown',
            domain: e.domain ?? null,
            resolvedEntityId: e.resolved_entity_id ?? null,
            synced: e.synced ?? false,
            createdAt: e.created_at ? new Date(e.created_at) : new Date(),
            updatedAt: e.updated_at ? new Date(e.updated_at) : new Date(),
          })),
        })
        return result.count
      } catch {
        // Batch failed (bad row in batch) — fall back to per-row create, skipping bad rows
        let count = 0
        for (const e of keep) {
          try {
            await db.localEntity.create({ data: {
              id: e.id,
              documentId: e.document_id ?? null,
              chunkId: e.chunk_id ?? null,
              entityName: e.entity_name,
              entityType: e.entity_type,
              description: e.description ?? null,
              properties: e.properties ?? null,
              confidenceScore: e.confidence_score ?? 0.5,
              source: e.source || 'unknown',
              domain: e.domain ?? null,
              resolvedEntityId: e.resolved_entity_id ?? null,
              synced: e.synced ?? false,
              createdAt: e.created_at ? new Date(e.created_at) : new Date(),
              updatedAt: e.updated_at ? new Date(e.updated_at) : new Date(),
            } })
            count++
          } catch { /* skip bad row */ }
        }
        return count
      }
    }, errors)
    if (skippedDeadDoc > 0) {
      console.log(`[Supabase] LocalEntity pull: skipped ${skippedDeadDoc} rows of deleted documents`)
    }
    results.push({ table: 'LocalEntity', pushed: 0, pulled, errors, skipped: skippedDeadDoc })
    totalPulled += pulled
  } catch (e) { results.push({ table: 'LocalEntity', pushed: 0, pulled: 0, errors: [String(e)] }) }

  // 14. LocalRelationship — restore extracted relationships buffer (PAGINATED + createMany with per-row fallback)
  try {
    await warnLargeBackupPull(client, 'local_relationships_backup', warnings)
    await db.localRelationship.deleteMany()
    const errors: string[] = []
    // FIX 17-a: chỉ pull row của Document còn sống + row KHÔNG có documentId
    let skippedDeadDoc = 0
    const pulled = await pullTablePaginated(client, 'local_relationships_backup', async (rows: any[]) => {
      const keep = filterRowsByLiveDocuments(rows, liveDocIds, (r: any) => r.document_id)
      skippedDeadDoc += rows.length - keep.length
      if (keep.length === 0) return 0
      try {
        const result = await db.localRelationship.createMany({
          data: keep.map((r: any) => ({
            id: r.id,
            documentId: r.document_id ?? null,
            sourceEntityId: r.source_entity_id ?? null,
            targetEntityId: r.target_entity_id ?? null,
            sourceEntityName: r.source_entity_name ?? null,
            targetEntityName: r.target_entity_name ?? null,
            relationshipType: r.relationship_type,
            description: r.description ?? null,
            confidenceScore: r.confidence_score ?? 0.5,
            source: r.source || 'unknown',
            synced: r.synced ?? false,
            createdAt: r.created_at ? new Date(r.created_at) : new Date(),
            updatedAt: r.updated_at ? new Date(r.updated_at) : new Date(),
          })),
        })
        return result.count
      } catch {
        let count = 0
        for (const r of keep) {
          try {
            await db.localRelationship.create({ data: {
              id: r.id,
              documentId: r.document_id ?? null,
              sourceEntityId: r.source_entity_id ?? null,
              targetEntityId: r.target_entity_id ?? null,
              sourceEntityName: r.source_entity_name ?? null,
              targetEntityName: r.target_entity_name ?? null,
              relationshipType: r.relationship_type,
              description: r.description ?? null,
              confidenceScore: r.confidence_score ?? 0.5,
              source: r.source || 'unknown',
              synced: r.synced ?? false,
              createdAt: r.created_at ? new Date(r.created_at) : new Date(),
              updatedAt: r.updated_at ? new Date(r.updated_at) : new Date(),
            } })
            count++
          } catch { /* skip bad row */ }
        }
        return count
      }
    }, errors)
    if (skippedDeadDoc > 0) {
      console.log(`[Supabase] LocalRelationship pull: skipped ${skippedDeadDoc} rows of deleted documents`)
    }
    results.push({ table: 'LocalRelationship', pushed: 0, pulled, errors, skipped: skippedDeadDoc })
    totalPulled += pulled
  } catch (e) { results.push({ table: 'LocalRelationship', pushed: 0, pulled: 0, errors: [String(e)] }) }

  // 15. LocalResolvedEntity — restore canonical merged entities (PAGINATED + createMany with per-row fallback)
  try {
    await warnLargeBackupPull(client, 'local_resolved_entities_backup', warnings)
    await db.localResolvedEntity.deleteMany()
    const errors: string[] = []
    // FIX 17-a: chỉ pull row của Document còn sống + row KHÔNG có documentId
    let skippedDeadDoc = 0
    const pulled = await pullTablePaginated(client, 'local_resolved_entities_backup', async (rows: any[]) => {
      const keep = filterRowsByLiveDocuments(rows, liveDocIds, (r: any) => r.document_id)
      skippedDeadDoc += rows.length - keep.length
      if (keep.length === 0) return 0
      try {
        const result = await db.localResolvedEntity.createMany({
          data: keep.map((r: any) => ({
            id: r.id,
            documentId: r.document_id ?? null,
            canonicalName: r.canonical_name,
            entityType: r.entity_type,
            description: r.description ?? null,
            properties: r.properties ?? null,
            avgConfidence: r.avg_confidence ?? 0.5,
            occurrenceCount: r.occurrence_count ?? 1,
            domains: r.domains ?? null,
            synced: r.synced ?? false,
            createdAt: r.created_at ? new Date(r.created_at) : new Date(),
            updatedAt: r.updated_at ? new Date(r.updated_at) : new Date(),
          })),
        })
        return result.count
      } catch {
        let count = 0
        for (const r of keep) {
          try {
            await db.localResolvedEntity.create({ data: {
              id: r.id,
              documentId: r.document_id ?? null,
              canonicalName: r.canonical_name,
              entityType: r.entity_type,
              description: r.description ?? null,
              properties: r.properties ?? null,
              avgConfidence: r.avg_confidence ?? 0.5,
              occurrenceCount: r.occurrence_count ?? 1,
              domains: r.domains ?? null,
              synced: r.synced ?? false,
              createdAt: r.created_at ? new Date(r.created_at) : new Date(),
              updatedAt: r.updated_at ? new Date(r.updated_at) : new Date(),
            } })
            count++
          } catch { /* skip bad row */ }
        }
        return count
      }
    }, errors)
    if (skippedDeadDoc > 0) {
      console.log(`[Supabase] LocalResolvedEntity pull: skipped ${skippedDeadDoc} rows of deleted documents`)
    }
    results.push({ table: 'LocalResolvedEntity', pushed: 0, pulled, errors, skipped: skippedDeadDoc })
    totalPulled += pulled
  } catch (e) { results.push({ table: 'LocalResolvedEntity', pushed: 0, pulled: 0, errors: [String(e)] }) }

  // 16. LearningLog — restore learning event log (Phase 3 SMOLAB Prop 10)
  try {
    const { data, error } = await client.from('learning_log_backup').select('*').limit(5000)
    if (!error && data && data.length > 0) {
      let pulled = 0
      for (const l of data) {
        try {
          await db.learningLog.upsert({
            where: { id: l.id },
            create: {
              id: l.id,
              sessionId: l.session_id ?? null,
              agentId: l.agent_id || 'default',
              eventType: l.event_type,
              content: l.content,
              metadata: l.metadata ?? null,
              createdAt: l.created_at ? new Date(l.created_at) : new Date(),
            },
            update: {},
          })
          pulled++
        } catch { /* skip conflict */ }
      }
      results.push({ table: 'LearningLog', pushed: 0, pulled, errors: [] })
      totalPulled += pulled
    } else {
      results.push({ table: 'LearningLog', pushed: 0, pulled: 0, errors: error ? [error.message] : [] })
    }
  } catch (e) { results.push({ table: 'LearningLog', pushed: 0, pulled: 0, errors: [String(e)] }) }

  // 17. AutoLearnRecord — restore auto-learn audits (Phase 3 SMOLAB Prop 10)
  try {
    const { data, error } = await client.from('auto_learn_record_backup').select('*').limit(5000)
    if (!error && data && data.length > 0) {
      let pulled = 0
      for (const r of data) {
        try {
          await db.autoLearnRecord.upsert({
            where: { id: r.id },
            create: {
              id: r.id,
              agentId: r.agent_id,
              agentName: r.agent_name,
              query: r.query,
              answerPreview: r.answer_preview,
              confidence: r.confidence ?? 0.5,
              provider: r.provider,
              model: r.model,
              entitiesCount: r.entities_count ?? 0,
              relationshipsCount: r.relationships_count ?? 0,
              chunkSaved: r.chunk_saved ?? false,
              neo4jSynced: r.neo4j_synced ?? false,
              qdrantPointId: r.qdrant_point_id ?? null,
              documentId: r.document_id ?? null,
              status: r.status || 'pending',
              errorMessage: r.error_message ?? null,
              createdAt: r.created_at ? new Date(r.created_at) : new Date(),
            },
            update: {},
          })
          pulled++
        } catch { /* skip conflict */ }
      }
      results.push({ table: 'AutoLearnRecord', pushed: 0, pulled, errors: [] })
      totalPulled += pulled
    } else {
      results.push({ table: 'AutoLearnRecord', pushed: 0, pulled: 0, errors: error ? [error.message] : [] })
    }
  } catch (e) { results.push({ table: 'AutoLearnRecord', pushed: 0, pulled: 0, errors: [String(e)] }) }

  // 18. ExecutionMetrics — restore Layer 9 metrics (Phase 3 SMOLAB Prop 10)
  try {
    const { data, error } = await client.from('execution_metrics_backup').select('*').limit(5000)
    if (!error && data && data.length > 0) {
      let pulled = 0
      for (const m of data) {
        try {
          await db.executionMetrics.upsert({
            where: { id: m.id },
            create: {
              id: m.id,
              sessionId: m.session_id,
              planId: m.plan_id,
              routingMode: m.routing_mode,
              tier: m.tier ?? 1,
              totalSteps: m.total_steps ?? 0,
              completedSteps: m.completed_steps ?? 0,
              failedSteps: m.failed_steps ?? 0,
              totalTokensUsed: m.total_tokens_used ?? 0,
              totalTokensBudgeted: m.total_tokens_budgeted ?? 0,
              totalTimeSpent: m.total_time_spent ?? 0,
              errorsByType: m.errors_by_type || '{}',
              stepSuccessRate: m.step_success_rate ?? 0,
              tokenEfficiency: m.token_efficiency ?? 0,
              createdAt: m.created_at ? new Date(m.created_at) : new Date(),
            },
            update: {},
          })
          pulled++
        } catch { /* skip conflict */ }
      }
      results.push({ table: 'ExecutionMetrics', pushed: 0, pulled, errors: [] })
      totalPulled += pulled
    } else {
      results.push({ table: 'ExecutionMetrics', pushed: 0, pulled: 0, errors: error ? [error.message] : [] })
    }
  } catch (e) { results.push({ table: 'ExecutionMetrics', pushed: 0, pulled: 0, errors: [String(e)] }) }

  // 19. FailurePattern — restore Layer 9.2 failure patterns (Phase 3 SMOLAB Prop 10)
  //     NOTE: FailurePattern has NO createdAt field — pull does not set it.
  try {
    const { data, error } = await client.from('failure_pattern_backup').select('*').limit(5000)
    if (!error && data && data.length > 0) {
      let pulled = 0
      for (const p of data) {
        try {
          await db.failurePattern.upsert({
            where: { id: p.id },
            create: {
              id: p.id,
              sessionId: p.session_id,
              type: p.type,
              count: p.count ?? 1,
              strategiesTried: p.strategies_tried || '[]',
              nextStrategy: p.next_strategy,
              context: p.context || '{}',
              resolved: p.resolved ?? false,
            },
            update: {},
          })
          pulled++
        } catch { /* skip conflict */ }
      }
      results.push({ table: 'FailurePattern', pushed: 0, pulled, errors: [] })
      totalPulled += pulled
    } else {
      results.push({ table: 'FailurePattern', pushed: 0, pulled: 0, errors: error ? [error.message] : [] })
    }
  } catch (e) { results.push({ table: 'FailurePattern', pushed: 0, pulled: 0, errors: [String(e)] }) }

  // 20. StrategyAdaptationLog — restore Layer 9.2 adaptation audits (Phase 3 SMOLAB Prop 10)
  try {
    const { data, error } = await client.from('strategy_adaptation_log_backup').select('*').limit(5000)
    if (!error && data && data.length > 0) {
      let pulled = 0
      for (const a of data) {
        try {
          await db.strategyAdaptationLog.upsert({
            where: { id: a.id },
            create: {
              id: a.id,
              sessionId: a.session_id,
              patternId: a.pattern_id ?? null,
              fromStrategy: a.from_strategy,
              toStrategy: a.to_strategy,
              reason: a.reason,
              confidence: a.confidence ?? 0.5,
              successful: a.successful ?? null,
              createdAt: a.created_at ? new Date(a.created_at) : new Date(),
            },
            update: {},
          })
          pulled++
        } catch { /* skip conflict */ }
      }
      results.push({ table: 'StrategyAdaptationLog', pushed: 0, pulled, errors: [] })
      totalPulled += pulled
    } else {
      results.push({ table: 'StrategyAdaptationLog', pushed: 0, pulled: 0, errors: error ? [error.message] : [] })
    }
  } catch (e) { results.push({ table: 'StrategyAdaptationLog', pushed: 0, pulled: 0, errors: [String(e)] }) }

  const durationMs = Date.now() - startTime
  console.log(`[Supabase] Pull complete: ${totalPulled} records in ${durationMs}ms`)
  return { results, totalPushed: 0, totalPulled, durationMs, warnings }
}

// ==================== HEALTH CHECK ====================

export async function checkSupabaseHealth(): Promise<{
  configured: boolean
  connected: boolean
  tableCount: number
  error?: string
}> {
  if (!isSupabaseConfigured()) {
    return { configured: false, connected: false, tableCount: 0 }
  }

  const client = getSupabase()
  if (!client) {
    return { configured: true, connected: false, tableCount: 0 }
  }

  try {
    const { error } = await client.from('sync_log').select('id').limit(1)
    return {
      configured: true,
      connected: !error,
      tableCount: 24, // 18 prior backup tables + 5 learning tables (Phase 3 SMOLAB Prop 10) + sync_log
      error: error?.message,
    }
  } catch (e) {
    return { configured: true, connected: false, tableCount: 0, error: String(e) }
  }
}
