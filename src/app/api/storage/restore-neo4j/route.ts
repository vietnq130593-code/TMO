/**
 * POST /api/storage/restore-neo4j
 * GET  /api/storage/restore-neo4j?action=status
 *
 * Restore the Neo4j Aura graph database from the SQLite extraction buffer
 * (LocalEntity + LocalRelationship + LocalResolvedEntity tables).
 *
 * Typical scenario: the user's Neo4j Aura instance lost its data, but the
 * SQLite buffer (which is the source of truth for the extraction pipeline)
 * still has every entity/relationship that was extracted. This endpoint
 * rebuilds the graph by:
 *
 *   1. (optionally) resetting the `synced=false` flag on every row so the
 *      existing /api/sync-neo4j?action=sync-all logic will process them
 *      (sync-all skips rows already marked synced=true).
 *   2. recreating the Neo4j schema (constraints, indexes, vector indexes)
 *      on the fresh Aura instance via initializeNeo4jSchema().
 *   3. calling the EXISTING /api/sync-neo4j endpoint (sync-all + sync-resolved)
 *      via internal server-side fetch — reuses the exact idempotent MERGE
 *      sync logic so we don't duplicate any business code.
 *   4. (optionally) re-embedding chunks in Qdrant for each document by calling
 *      /api/query?action=embed-regenerate — only if Qdrant chunks still exist.
 *
 * NOTE: This route is server-side only (no 'use client'). It uses internal
 * fetch to /api/sync-neo4j instead of importing the helper functions, because
 * those helpers are private (not exported) from the sync-neo4j route module.
 * Re-fetching keeps the restore path identical to normal sync semantics and
 * avoids code duplication.
 */

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import {
  getNeo4jDriver,
  initializeNeo4jSchema,
  resetNeo4jDriver,
  getGraphStats,
} from '@/lib/neo4j'
import { getChunkCount, getQdrantStats } from '@/lib/qdrant'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 600 // 10 min — restore of 40K+ entities is slow

// ==================== HELPERS ====================

/**
 * Check whether NEO4J_URI looks like a configured AuraDB URI (not the
 * placeholder from .env.example).
 */
function isNeo4jConfigured(): boolean {
  const uri = process.env.NEO4J_URI || ''
  // Placeholder pattern from .env.example: neo4j+s://REPLACE_WITH_YOUR_AURA_INSTANCE_ID.databases.neo4j.io
  if (!uri) return false
  if (uri.includes('REPLACE_WITH') || uri.includes('YOUR_')) return false
  if (!uri.startsWith('neo4j+s://') && !uri.startsWith('neo4j://') && !uri.startsWith('bolt://')) {
    return false
  }
  // Must have a real host (something after the scheme)
  const host = uri.replace(/^[a-z0-9+]+:\/\//, '').split('@').pop() || ''
  return host.includes('.') && host.length > 10
}

/**
 * Internal fetch helper with a 10-minute timeout. Used to call the existing
 * /api/sync-neo4j endpoint server-side so we reuse its MERGE-idempotent sync
 * logic instead of duplicating it here.
 */
async function internalFetch<T = unknown>(
  pathWithQuery: string,
  method: 'GET' | 'POST' = 'GET',
  body?: unknown,
): Promise<{ ok: boolean; status: number; data: T | null; error: string | null }> {
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000'
  const url = pathWithQuery.startsWith('http') ? pathWithQuery : `${baseUrl}${pathWithQuery}`
  console.log(`[restore-neo4j] internal fetch ${method} ${url}`)
  try {
    const init: RequestInit = {
      method,
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(600_000), // 10 min per call
    }
    if (body !== undefined && method !== 'GET') {
      init.body = JSON.stringify(body)
    }
    const res = await fetch(url, init)
    const text = await res.text()
    let data: T | null = null
    try {
      data = text ? (JSON.parse(text) as T) : null
    } catch {
      // Non-JSON response — keep data null, expose raw text in error
      return {
        ok: res.ok,
        status: res.status,
        data: null,
        error: `Non-JSON response (HTTP ${res.status}): ${text.slice(0, 300)}`,
      }
    }
    if (!res.ok) {
      const errMsg =
        data && typeof data === 'object' && 'error' in data
          ? String((data as Record<string, unknown>).error)
          : `HTTP ${res.status}`
      return { ok: false, status: res.status, data, error: errMsg }
    }
    return { ok: true, status: res.status, data, error: null }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[restore-neo4j] internal fetch failed: ${url} → ${msg}`)
    return { ok: false, status: 0, data: null, error: msg }
  }
}

/**
 * Collect all distinct documentIds referenced by LocalEntity + LocalRelationship.
 * Includes the 'null' bucket (orphan entities) as a separate entry for reporting.
 */
async function collectDocumentIds(): Promise<{
  docIds: string[]
  hasOrphans: boolean
}> {
  const [entDocs, relDocs] = await Promise.all([
    db.localEntity.findMany({ where: { documentId: { not: null } }, select: { documentId: true }, distinct: ['documentId'] }),
    db.localRelationship.findMany({ where: { documentId: { not: null } }, select: { documentId: true }, distinct: ['documentId'] }),
  ])
  const set = new Set<string>()
  for (const e of entDocs) if (e.documentId) set.add(e.documentId)
  for (const r of relDocs) if (r.documentId) set.add(r.documentId)

  const orphanCount = await db.localEntity.count({ where: { documentId: null } })
  const orphanRelCount = await db.localRelationship.count({ where: { documentId: null } })

  return {
    docIds: Array.from(set).sort(),
    hasOrphans: orphanCount > 0 || orphanRelCount > 0,
  }
}

/**
 * Resolve a human-readable title for a document (used in the
 * "documentsNeedingReupload" list so the user knows which PDFs to re-upload).
 */
async function resolveDocTitle(docId: string): Promise<string> {
  try {
    const doc = await db.document.findUnique({ where: { id: docId }, select: { title: true } })
    if (doc?.title) return doc.title
  } catch {
    // ignore — fall back to docId
  }
  return docId
}

// ==================== GET: STATUS PREVIEW ====================

/**
 * GET /api/storage/restore-neo4j?action=status
 *
 * Returns counts in SQLite + Neo4j connection + Qdrant chunk count so the UI
 * can show a preview before the user triggers the restore.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const action = searchParams.get('action') || 'status'

  if (action !== 'status') {
    return NextResponse.json(
      {
        error: 'Unknown action. Use ?action=status for a preview, or POST to perform the restore.',
      },
      { status: 400 },
    )
  }

  console.log('[restore-neo4j] status preview requested')

  // --- SQLite buffer counts ---
  const [localEntities, localRelationships, localResolvedEntities, syncedEntities, syncedRels, syncedResolved] =
    await Promise.all([
      db.localEntity.count(),
      db.localRelationship.count(),
      db.localResolvedEntity.count(),
      db.localEntity.count({ where: { synced: true } }),
      db.localRelationship.count({ where: { synced: true } }),
      db.localResolvedEntity.count({ where: { synced: true } }),
    ])

  const { docIds, hasOrphans } = await collectDocumentIds()

  // --- Neo4j connection + graph stats ---
  let neo4jConnected = false
  const neo4jPlaceholder = !isNeo4jConfigured()
  let neo4jStats: { totalNodes: number; totalRelationships: number } | null = null
  let neo4jError: string | null = null

  if (!neo4jPlaceholder) {
    try {
      const driver = await getNeo4jDriver()
      if (driver) {
        neo4jConnected = true
        try {
          const stats = await getGraphStats()
          neo4jStats = { totalNodes: stats.totalNodes, totalRelationships: stats.totalRelationships }
        } catch (err) {
          neo4jError = err instanceof Error ? err.message : String(err)
        }
      } else {
        neo4jError = 'Driver returned null — connection failed (check NEO4J_URI/USER/PASSWORD in .env).'
      }
    } catch (err) {
      neo4jError = err instanceof Error ? err.message : String(err)
    }
  }

  // --- Qdrant chunk count ---
  let qdrantStats: { totalDocuments: number; totalChunks: number; vectorsIndexed: number } | null = null
  let qdrantError: string | null = null
  try {
    qdrantStats = await getQdrantStats()
  } catch (err) {
    qdrantError = err instanceof Error ? err.message : String(err)
  }

  return NextResponse.json({
    action: 'status',
    sqlite: {
      localEntities,
      localRelationships,
      localResolvedEntities,
      documents: docIds.length,
      hasOrphans,
      synced: {
        entities: syncedEntities,
        relationships: syncedRels,
        resolvedEntities: syncedResolved,
      },
      unsynced: {
        entities: localEntities - syncedEntities,
        relationships: localRelationships - syncedRels,
        resolvedEntities: localResolvedEntities - syncedResolved,
      },
    },
    neo4j: {
      configured: !neo4jPlaceholder,
      connected: neo4jConnected,
      stats: neo4jStats,
      error: neo4jError,
    },
    qdrant: {
      stats: qdrantStats,
      error: qdrantError,
    },
    documents: docIds,
    message:
      localEntities === 0
        ? 'SQLite buffer trống — không có dữ liệu để restore. Hãy pull Supabase trước (POST /api/storage/supabase-sync?action=pull).'
        : neo4jPlaceholder
          ? 'Neo4j chưa được cấu hình. Vui lòng đặt NEO4J_URI trong file .env.'
          : !neo4jConnected
            ? 'Neo4j kết nối thất bại — kiểm tra lại credentials trong .env.'
            : `Sẵn sàng restore: ${localEntities} entities, ${localRelationships} relationships, ${localResolvedEntities} resolved entities, ${docIds.length} documents.`,
  })
}

// ==================== POST: PERFORM RESTORE ====================

interface RestoreRequestBody {
  resetSynced?: boolean
  regenerateEmbeddings?: boolean
  dryRun?: boolean
}

export async function POST(request: NextRequest) {
  const startedAt = Date.now()
  console.log('[restore-neo4j] POST invoked')

  // --- Parse options from body OR query params ---
  const opts: RestoreRequestBody = {
    resetSynced: true,
    regenerateEmbeddings: false,
    dryRun: false,
  }

  const contentType = request.headers.get('content-type') || ''
  if (contentType.includes('application/json')) {
    try {
      const body = (await request.json()) as RestoreRequestBody
      if (typeof body.resetSynced === 'boolean') opts.resetSynced = body.resetSynced
      if (typeof body.regenerateEmbeddings === 'boolean') opts.regenerateEmbeddings = body.regenerateEmbeddings
      if (typeof body.dryRun === 'boolean') opts.dryRun = body.dryRun
    } catch {
      // Empty body is fine — fall through to query params / defaults
    }
  }

  // Query params override (lower priority than body)
  const { searchParams } = new URL(request.url)
  if (searchParams.has('resetSynced')) opts.resetSynced = searchParams.get('resetSynced') !== 'false'
  if (searchParams.has('regenerateEmbeddings')) opts.regenerateEmbeddings = searchParams.get('regenerateEmbeddings') === 'true'
  if (searchParams.has('dryRun')) opts.dryRun = searchParams.get('dryRun') === 'true'

  console.log(
    `[restore-neo4j] options: dryRun=${opts.dryRun} resetSynced=${opts.resetSynced} regenerateEmbeddings=${opts.regenerateEmbeddings}`,
  )

  // --- Step 0: pre-flight counts ---
  const [localEntities, localRelationships, localResolvedEntities] = await Promise.all([
    db.localEntity.count(),
    db.localRelationship.count(),
    db.localResolvedEntity.count(),
  ])
  const { docIds, hasOrphans } = await collectDocumentIds()

  const counts = {
    localEntities,
    localRelationships,
    localResolvedEntities,
    documents: docIds.length,
  }

  // --- Dry-run mode: return counts only, no changes ---
  if (opts.dryRun) {
    console.log('[restore-neo4j] dry-run mode — returning preview, no changes made')
    return NextResponse.json({
      success: true,
      dryRun: true,
      resetSynced: opts.resetSynced,
      regenerateEmbeddings: opts.regenerateEmbeddings,
      counts,
      wouldReset: opts.resetSynced
        ? {
            entities: localEntities,
            relationships: localRelationships,
            resolvedEntities: localResolvedEntities,
          }
        : null,
      wouldSync: {
        documents: docIds.length,
        hasOrphans,
        resolvedEntities: localResolvedEntities,
      },
      wouldRegenerateEmbeddings: opts.regenerateEmbeddings,
      durationMs: Date.now() - startedAt,
      message: `Dry-run: sẽ restore ${localEntities} entities, ${localRelationships} relationships, ${localResolvedEntities} resolved entities từ ${docIds.length} documents vào Neo4j.`,
    })
  }

  // --- Step 1: Neo4j config check ---
  if (!isNeo4jConfigured()) {
    console.error('[restore-neo4j] NEO4J_URI is the placeholder — aborting')
    return NextResponse.json(
      {
        success: false,
        error: 'Neo4j chưa được cấu hình. Vui lòng đặt NEO4J_URI trong file .env thành URI AuraDB của bạn (neo4j+s://<instance-id>.databases.neo4j.io).',
        counts,
        durationMs: Date.now() - startedAt,
      },
      { status: 400 },
    )
  }

  // --- Step 2: verify Neo4j connectivity ---
  let driver = await getNeo4jDriver()
  if (!driver) {
    // Try one reset + retry in case the cached driver is a stale failure
    console.warn('[restore-neo4j] driver null on first attempt — resetting and retrying once')
    await resetNeo4jDriver()
    driver = await getNeo4jDriver()
  }
  if (!driver) {
    console.error('[restore-neo4j] Neo4j connection failed after retry — aborting')
    return NextResponse.json(
      {
        success: false,
        error: 'Không thể kết nối tới Neo4j AuraDB. Vui lòng kiểm tra NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD trong file .env và đảm bảo instance AuraDB vẫn đang chạy.',
        counts,
        durationMs: Date.now() - startedAt,
      },
      { status: 400 },
    )
  }

  const neo4jErrors: string[] = []
  let schemaInitialized = false

  // --- Step 3: initialize Neo4j schema (constraints + indexes + vector indexes) ---
  try {
    console.log('[restore-neo4j] initializing Neo4j schema (constraints + indexes + vector indexes)')
    const schemaResult = await initializeNeo4jSchema()
    schemaInitialized = true
    console.log(
      `[restore-neo4j] schema initialized: ${schemaResult.constraints} constraints, ${schemaResult.indexes} indexes`,
    )
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[restore-neo4j] schema initialization FAILED:', msg)
    return NextResponse.json(
      {
        success: false,
        error: `Khởi tạo schema Neo4j thất bại: ${msg}. Vui lòng kiểm tra NEO4J_URI/USER/PASSWORD trong .env và đảm bảo AuraDB instance có quyền tạo constraints/indexes.`,
        counts,
        neo4j: { schemaInitialized: false, errors: [msg] },
        durationMs: Date.now() - startedAt,
      },
      { status: 500 },
    )
  }

  // --- Step 4: reset synced flags (if requested) ---
  if (opts.resetSynced) {
    console.log('[restore-neo4j] resetting synced=false on ALL LocalEntity / LocalRelationship / LocalResolvedEntity rows')
    try {
      const [e, r, re] = await Promise.all([
        db.localEntity.updateMany({ where: {}, data: { synced: false } }),
        db.localRelationship.updateMany({ where: {}, data: { synced: false } }),
        db.localResolvedEntity.updateMany({ where: {}, data: { synced: false } }),
      ])
      console.log(
        `[restore-neo4j] reset synced: ${e.count} entities, ${r.count} relationships, ${re.count} resolved entities`,
      )
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('[restore-neo4j] reset synced failed:', msg)
      neo4jErrors.push(`Reset synced flags failed: ${msg}`)
      // Continue — sync-all may still process whatever rows are unsynced
    }
  }

  // --- Step 5: sync-all via internal fetch (per-document MERGE + orphan + resolved) ---
  // The existing /api/sync-neo4j?action=sync-all already iterates every docId
  // with unsynced entities/relationships, processes orphans, and syncs resolved
  // entities — so a single call covers steps 5+6+7 of the task spec.
  let documentsProcessed = 0
  let totalEntitiesSynced = 0
  let totalRelationshipsSynced = 0
  let totalResolvedEntitiesSynced = 0

  console.log('[restore-neo4j] calling /api/sync-neo4j?action=sync-all (10-min timeout)')
  const syncAllRes = await internalFetch<{
    documentsProcessed?: number
    documents?: Array<{ entitiesSynced?: number; relsSynced?: number; docId?: string }>
    orphanEntities?: { synced?: number; relsSynced?: number }
    summary?: {
      totalNodesCreated?: number
      totalRelsCreated?: number
      totalEntitiesSynced?: number
      totalRelsSynced?: number
    }
    resolvedEntities?: { synced?: number; failed?: number; total?: number }
    errors?: Array<{ docId?: string; error?: string }>
    error?: string
  }>('/api/sync-neo4j?action=sync-all', 'GET')

  if (!syncAllRes.ok || !syncAllRes.data) {
    const msg = syncAllRes.error || `HTTP ${syncAllRes.status}`
    console.error('[restore-neo4j] sync-all internal fetch failed:', msg)
    neo4jErrors.push(`sync-all failed: ${msg}`)
  } else {
    const d = syncAllRes.data
    documentsProcessed = d.documentsProcessed ?? (d.documents?.length ?? 0)
    totalEntitiesSynced =
      d.summary?.totalEntitiesSynced ?? d.documents?.reduce((s, x) => s + (x.entitiesSynced ?? 0), 0) ?? 0
    totalRelationshipsSynced =
      d.summary?.totalRelsSynced ?? d.documents?.reduce((s, x) => s + (x.relsSynced ?? 0), 0) ?? 0
    totalResolvedEntitiesSynced = d.resolvedEntities?.synced ?? 0

    if (Array.isArray(d.errors)) {
      for (const e of d.errors) {
        if (e?.error) neo4jErrors.push(`[${e.docId || 'unknown'}] ${e.error}`)
      }
    }
    console.log(
      `[restore-neo4j] sync-all OK: docs=${documentsProcessed}, entities=${totalEntitiesSynced}, rels=${totalRelationshipsSynced}, resolved=${totalResolvedEntitiesSynced}`,
    )
  }

  // --- Step 6: explicit sync-resolved call (defensive — covers edge cases
  //     where sync-all's resolved step was skipped due to an early error) ---
  console.log('[restore-neo4j] calling /api/sync-neo4j?action=sync-resolved (defensive)')
  const syncResolvedRes = await internalFetch<{ synced?: number; failed?: number; total?: number; error?: string }>(
    '/api/sync-neo4j?action=sync-resolved',
    'GET',
  )
  if (!syncResolvedRes.ok || !syncResolvedRes.data) {
    const msg = syncResolvedRes.error || `HTTP ${syncResolvedRes.status}`
    console.warn('[restore-neo4j] sync-resolved (defensive) failed:', msg)
    // Non-fatal — sync-all already attempted this. Don't add to errors unless zero resolved.
    if (totalResolvedEntitiesSynced === 0 && localResolvedEntities > 0) {
      neo4jErrors.push(`sync-resolved (defensive) failed: ${msg}`)
    }
  } else {
    // If defensive sync-resolved added more, update the count
    const extra = syncResolvedRes.data.synced ?? 0
    if (extra > 0 && totalResolvedEntitiesSynced === 0) {
      totalResolvedEntitiesSynced = extra
    }
  }

  // --- Step 7: embeddings check + optional regeneration ---
  const embeddingsResult = {
    regenerated: false,
    documentsWithChunks: 0,
    documentsWithoutChunks: 0,
    documentsNeedingReupload: [] as string[],
  }

  if (opts.regenerateEmbeddings) {
    console.log('[restore-neo4j] regenerateEmbeddings=true — checking Qdrant chunks per document')
    embeddingsResult.regenerated = true

    for (const docId of docIds) {
      let chunkCount = 0
      try {
        chunkCount = await getChunkCount(docId)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.warn(`[restore-neo4j] getChunkCount(${docId}) failed: ${msg}`)
      }

      if (chunkCount > 0) {
        embeddingsResult.documentsWithChunks++
        // Re-embed this document's chunks (reads from Qdrant payload, regenerates vector, upserts back)
        console.log(`[restore-neo4j] re-embedding doc ${docId} (${chunkCount} chunks)`)
        const embedRes = await internalFetch<{ success?: boolean; error?: string }>(
          `/api/query?action=embed-regenerate&documentId=${encodeURIComponent(docId)}`,
          'POST',
          { documentId: docId },
        )
        if (!embedRes.ok) {
          const msg = embedRes.error || `HTTP ${embedRes.status}`
          console.warn(`[restore-neo4j] embed-regenerate failed for ${docId}: ${msg}`)
          neo4jErrors.push(`embed-regenerate[${docId}]: ${msg}`)
        }
      } else {
        embeddingsResult.documentsWithoutChunks++
        const title = await resolveDocTitle(docId)
        embeddingsResult.documentsNeedingReupload.push(`${title} (${docId})`)
        console.warn(
          `[restore-neo4j] doc ${docId} (${title}) has 0 chunks in Qdrant — cannot re-embed; user must re-upload PDF or restore Qdrant from R2 backup first`,
        )
      }
    }
  } else {
    // Even without regeneration, surface chunk counts so the user knows
    // whether embeddings are still intact in Qdrant.
    console.log('[restore-neo4j] regenerateEmbeddings=false — counting chunks for reporting only')
    for (const docId of docIds) {
      try {
        const c = await getChunkCount(docId)
        if (c > 0) embeddingsResult.documentsWithChunks++
        else {
          embeddingsResult.documentsWithoutChunks++
          const title = await resolveDocTitle(docId)
          embeddingsResult.documentsNeedingReupload.push(`${title} (${docId})`)
        }
      } catch {
        embeddingsResult.documentsWithoutChunks++
        embeddingsResult.documentsNeedingReupload.push(docId)
      }
    }
  }

  const durationMs = Date.now() - startedAt
  const success = neo4jErrors.length === 0 || (documentsProcessed > 0 && totalEntitiesSynced > 0)

  // --- Step 8: build response ---
  const message = success
    ? `Restore Neo4j hoàn tất trong ${Math.round(durationMs / 1000)}s: đã đồng bộ ${totalEntitiesSynced} entities, ${totalRelationshipsSynced} relationships, ${totalResolvedEntitiesSynced} resolved entities từ ${documentsProcessed} documents.` +
      (embeddingsResult.documentsNeedingReupload.length > 0
        ? ` ⚠️ ${embeddingsResult.documentsNeedingReupload.length} document(s) không có chunks trong Qdrant — cần re-upload PDF hoặc restore Qdrant từ R2 backup trước.`
        : '')
    : `Restore Neo4j thất bại hoặc đồng bộ được ít hơn dự kiến. Xem mảng neo4j.errors để biết chi tiết. Đã xử lý ${documentsProcessed} documents, ${totalEntitiesSynced} entities.`

  console.log(`[restore-neo4j] DONE in ${durationMs}ms — success=${success}, errors=${neo4jErrors.length}`)

  return NextResponse.json(
    {
      success,
      dryRun: false,
      resetSynced: opts.resetSynced,
      counts,
      neo4j: {
        schemaInitialized,
        documentsProcessed,
        totalEntitiesSynced,
        totalRelationshipsSynced,
        totalResolvedEntitiesSynced,
        errors: neo4jErrors,
      },
      embeddings: embeddingsResult,
      durationMs,
      message,
    },
    { status: success ? 200 : 500 },
  )
}
