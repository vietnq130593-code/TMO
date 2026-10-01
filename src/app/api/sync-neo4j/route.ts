/**
 * Neo4j Sync API — SQLite buffer → Neo4j push
 *
 * Architecture:
 *   SQLite (buffer) → Qdrant (vector+document) + Neo4j (graph)
 *
 * Reads unsynced entities/relationships from SQLite buffer,
 * pushes them to Neo4j using enhanced operations (with full property
 * aliases for backward compatibility), and marks them as synced.
 * Document metadata is read from Qdrant when available, or
 * generated from SQLite data for auto-learned entities.
 *
 * Endpoints:
 *   GET /api/sync-neo4j?action=status
 *     → Returns Neo4j stats + buffer counts (synced/unsynced)
 *
 *   GET /api/sync-neo4j?action=sync-all
 *     → Sync ALL unsynced entities + relationships + resolved entities from SQLite to Neo4j
 *     → Groups by documentId, processes each group, marks synced=true
 *     → Also syncs LocalResolvedEntity records as canonical Entity nodes
 *
 *   GET /api/sync-neo4j?action=sync-resolved
 *     → Sync only LocalResolvedEntity records to Neo4j (canonical entities across documents)
 *
 *   GET /api/sync-neo4j?action=merge-global
 *     → Merge all per-document entity nodes into global cross-document nodes
 *     → Groups nodes by (name, type), creates one global node per group
 *     → Re-points relationships, creates CONTAINS links, deletes old nodes
 *
 *   GET /api/sync-neo4j?docId=<id>
 *     → Sync one document's unsynced entities + relationships to Neo4j
 */

import { NextRequest, NextResponse } from 'next/server'
import { getNeo4jDriver, upsertEntitiesBatch, upsertRelationshipsBatch, deleteEntitiesByDocument, upsertDocumentNode, linkDocumentToEntities, readCypher, getGraphStats, mergePerDocumentNodesToGlobal } from '@/lib/neo4j'
import type { EntityNode, RelationshipEdge } from '@/lib/neo4j'
import { globalEntityId } from '@/lib/ingestion/entity-resolver'
import { listDocuments, getDocument } from '@/lib/qdrant'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

// DATA-LOSS FIX 2026-08-31 — synthetic anchor Document nodes.
// Resolved/orphan entities previously had NO CONTAINS edge from any Document node,
// so the ingestion pipeline's orphan cleanup (Step 7) and deleteEntitiesByDocument's
// global sweep DETACH DELETEd them on the next document processing. Anchoring them
// to these synthetic Document nodes makes them legitimate graph citizens.
const RESOLVED_ANCHOR_DOC_ID = '__resolved_entities__'
const ORPHAN_ANCHOR_DOC_ID = '__orphan_entities__'
const LEGACY_ANCHOR_DOC_ID = '__auto_learned__'

/**
 * DATA-LOSS FIX 2026-08-31 (step 3): re-anchor legacy unanchored entities.
 *
 * Entities written by the OLD writeback/auto-learn code (before the anchoring fix)
 * have NO CONTAINS edge from any Document — they were exactly the nodes the old
 * global orphan-cleanup DETACH DELETEd on the next document ingestion. This step
 * links every still-unanchored entity node to a synthetic anchor Document so all
 * pre-existing chat-learned/agent knowledge is permanently protected. Idempotent:
 * nodes that already have a CONTAINS edge are skipped by the query itself.
 */
async function anchorLegacyEntities(): Promise<{ anchored: number }> {
  const driver = await getNeo4jDriver()
  if (!driver) throw new Error('Neo4j not connected')

  const rows = await readCypher<{ id: string }>(
    `MATCH (n)
     WHERE n.entity_type IS NOT NULL AND NOT (n:Document)
       AND n.entity_type <> 'Document'
       AND NOT (n)<-[:CONTAINS]-(:Document)
       AND n.id IS NOT NULL
     RETURN n.id AS id`
  )
  const ids = rows.map(r => r.id).filter(Boolean) as string[]
  if (ids.length === 0) return { anchored: 0 }

  const now = new Date().toISOString()
  await upsertDocumentNode({
    id: LEGACY_ANCHOR_DOC_ID,
    title: 'Auto-Learned & Agent Knowledge (legacy anchor)',
    domain: 'auto-learned',
    status: 'extracted',
    page_count: undefined,
    created_at: now,
    updated_at: now,
  })
  const linked = await linkDocumentToEntities(LEGACY_ANCHOR_DOC_ID, ids)
  console.log(`[Sync-Neo4j] Re-anchored ${linked} legacy entities (no CONTAINS edge) to ${LEGACY_ANCHOR_DOC_ID}`)
  return { anchored: linked }
}

/**
 * FIX 17-a: resolve entity endpoint cho relationship NAME-ONLY (legacy auto-learn
 * lưu rel chỉ có tên, không có resolved entity ids).
 * Code cũ hardcode type 'concept' → id `global__name__concept`; nếu entity thật có type
 * khác (Framework, Tool...) thì MATCH trong upsertRelationshipsBatch fail → rel bị DROP lặng lẽ.
 *
 * Thứ tự lookup trước khi fallback 'concept':
 *   1. SQLite LocalEntity theo name (LIKE — case-insensitive ASCII) → type thật
 *   2. Neo4j theo name (case-insensitive) → DÙNG LUÔN node id sẵn có (không tạo node mới)
 * Nhiều node trùng name → chọn 1 đại diện duy nhất (ORDER BY id LIMIT 1).
 * Fail-open: mọi lỗi lookup → trả null (caller giữ fallback 'concept' như cũ).
 */
async function resolveNameOnlyEndpoint(
  name: string,
  cache: Map<string, { id?: string; type?: string } | null>
): Promise<{ id?: string; type?: string } | null> {
  const key = name.toLowerCase().trim()
  if (cache.has(key)) return cache.get(key) ?? null

  let resolved: { id?: string; type?: string } | null = null

  // 1) SQLite LocalEntity — lấy type thật (đại diện duy nhất: ORDER BY id LIMIT 1)
  try {
    // LIKE của SQLite case-insensitive với ASCII; escape wildcard % _ \ trong name
    const pattern = key.replace(/[\\%_]/g, (ch) => '\\' + ch)
    const rows = await db.$queryRaw<Array<{ entityType: string }>>`SELECT entityType FROM LocalEntity WHERE entityName LIKE ${pattern} ESCAPE '\\' ORDER BY id LIMIT 1`
    const realType = rows[0]?.entityType?.toLowerCase().trim()
    if (realType) {
      resolved = { type: realType }
    }
  } catch { /* fail-open */ }

  // 2) Neo4j — node trùng name đã tồn tại → dùng luôn id (không tạo node trùng lặp mới)
  if (!resolved) {
    try {
      const nodes = await readCypher<{ type: string | null; id: string | null }>(
        `MATCH (n)
         WHERE n.id IS NOT NULL AND n.name IS NOT NULL
           AND toLower(n.name) = toLower($name)
           AND NOT (n:Document)
         RETURN labels(n)[0] AS type, n.id AS id
         ORDER BY n.id
         LIMIT 1`,
        { name: key }
      )
      if (nodes.length > 0 && nodes[0].id) {
        resolved = { id: nodes[0].id, type: nodes[0].type?.toLowerCase().trim() || undefined }
      }
    } catch { /* fail-open */ }
  }

  cache.set(key, resolved)
  return resolved
}

// ==================== SHARED SYNC HELPERS ====================

/**
 * Sync unsynced entities and relationships for a single document to Neo4j.
 * Works for both Qdrant-backed documents and auto-learn documents.
 */
async function syncDocumentToNeo4j(docId: string): Promise<{
  docId: string
  title: string
  nodesCreated: number
  relsCreated: number
  relsDropped: number
  uniqueEntities: number
  documentNodeCreated: boolean
  entitiesSynced: number
  relsSynced: number
}> {
  const driver = await getNeo4jDriver()
  if (!driver) throw new Error('Neo4j not connected')

  // Try to get document from Qdrant, but fall back to SQLite for auto-learn docs
  let docTitle = docId
  let docDomain = 'mixed'
  let docStatus = 'extracted'
  let docPageCount: number | undefined
  let docCreatedAt: string | undefined
  let docUpdatedAt: string | undefined

  try {
    const doc = await getDocument(docId)
    if (doc) {
      docTitle = doc.title
      docDomain = doc.domain || 'mixed'
      docStatus = doc.status
      docPageCount = doc.page_count
      docCreatedAt = doc.created_at
      docUpdatedAt = doc.updated_at
    }
  } catch {
    // Document may not exist in Qdrant (e.g., auto-learn documents)
    // Use SQLite Document table as fallback
    try {
      const sqliteDoc = await db.document.findUnique({ where: { id: docId } })
      if (sqliteDoc) {
        docTitle = sqliteDoc.title
        docDomain = sqliteDoc.domain || 'mixed'
        docStatus = sqliteDoc.status
        docPageCount = sqliteDoc.pageCount ?? undefined
        docCreatedAt = sqliteDoc.createdAt.toISOString()
        docUpdatedAt = sqliteDoc.updatedAt.toISOString()
      }
    } catch {
      // SQLite Document table may not have this doc either (auto-learn)
      // Use the docId as title
    }
  }

  // Delete existing Neo4j nodes for this document (fresh sync)
  await deleteEntitiesByDocument(docId)

  // Create Document node in graph
  const now = new Date().toISOString()
  await upsertDocumentNode({
    id: docId,
    title: docTitle,
    domain: docDomain,
    status: docStatus,
    page_count: docPageCount,
    created_at: docCreatedAt || now,
    updated_at: docUpdatedAt || now,
  })

  // Load UNSYNCED entities from SQLite buffer for this document
  const entities = await db.localEntity.findMany({ where: { documentId: docId, synced: false } })

  if (entities.length === 0) {
    // No unsynced entities — still mark relationships as synced
    await db.localRelationship.updateMany({ where: { documentId: docId, synced: false }, data: { synced: true } })
    return {
      docId,
      title: docTitle,
      nodesCreated: 0,
      relsCreated: 0,
      relsDropped: 0,
      uniqueEntities: 0,
      documentNodeCreated: true,
      entitiesSynced: 0,
      relsSynced: 0,
    }
  }

  // Deduplicate entities by (name, type) — keep longest description
  const entityByKey = new Map<string, { name: string; type: string; domain: string; desc: string; conf: number; source: string; chunkId: string; originalIds: string[] }>()
  for (const e of entities) {
    const key = `${e.entityName.toLowerCase().trim()}__${(e.entityType || 'Concept').toLowerCase().trim()}`
    const existing = entityByKey.get(key)
    if (existing) {
      if ((e.description || '').length > existing.desc.length) existing.desc = e.description || ''
      if (e.confidenceScore > existing.conf) existing.conf = e.confidenceScore
      existing.originalIds.push(e.id)
    } else {
      entityByKey.set(key, {
        name: e.entityName.trim(),
        type: e.entityType || 'Concept',
        domain: e.domain || docDomain || 'mixed',
        desc: e.description || '',
        conf: e.confidenceScore || 0.5,
        source: e.source || 'llm',
        chunkId: e.chunkId || '',
        originalIds: [e.id],
      })
    }
  }

  // Build EntityNode array for batch upsert
  // CROSS-DOCUMENT DEDUP: Use global entity IDs (`global__name__type`) instead of
  // per-document IDs (`docId__name__type`). Same entity across documents → same node.
  const entityNodes: EntityNode[] = Array.from(entityByKey.entries()).map(([key, e]) => ({
    id: `global__${key.replace(/[^a-z0-9_]/g, '_')}`,
    name: e.name,
    entity_type: e.type as EntityNode['entity_type'],
    domain: e.domain,
    description: e.desc,
    confidence: e.conf,
    documentId: docId,
    source: e.source,
    chunk_id: e.chunkId,
    created_at: now,
    updated_at: now,
  }))

  // Build a map from original entity IDs → deduplicated entity IDs
  const originalToDedupedId = new Map<string, string>()
  for (const [key, e] of entityByKey.entries()) {
    const dedupedId = `global__${key.replace(/[^a-z0-9_]/g, '_')}`
    for (const origId of e.originalIds) {
      originalToDedupedId.set(origId, dedupedId)
    }
  }

  // Batch upsert entities using enhanced operations (sets both camelCase + snake_case properties)
  const nodesCreated = await upsertEntitiesBatch(entityNodes, docId)

  // Link Document node to entities
  await linkDocumentToEntities(docId, entityNodes.map(e => e.id))

  // Load UNSYNCED relationships from SQLite buffer
  const rels = await db.localRelationship.findMany({ where: { documentId: docId, synced: false } })

  // Build name → type maps for entity resolution
  const eName = new Map(entities.map(e => [e.id, e.entityName.toLowerCase().trim()]))
  const eType = new Map(entities.map(e => [e.id, (e.entityType || 'Concept').toLowerCase().trim()]))

  // FIX 17-a: cache lookup name-only endpoint + tập hợp name phải fallback 'concept' (log nhóm 1 dòng)
  const nameOnlyCache = new Map<string, { id?: string; type?: string } | null>()
  const conceptFallbackNames = new Set<string>()

  // Deduplicate relationships by (source, target, relType)
  const relByKey = new Map<string, { sId: string; tId: string; rt: string; desc: string; conf: number; source: string }>()
  for (const r of rels) {
    // Resolve source/target entity IDs: prefer deduplicated IDs from entityNameToIdMap,
    // fall back to name-based ID construction using GLOBAL IDs
    let sId: string | undefined
    let tId: string | undefined

    if (r.sourceEntityId && originalToDedupedId.has(r.sourceEntityId)) {
      sId = originalToDedupedId.get(r.sourceEntityId)
    } else if (r.sourceEntityName) {
      const sn = r.sourceEntityName.toLowerCase().trim()
      // Ưu tiên type từ entity-id của chính row (nếu entity còn trong buffer chưa sync của doc)
      let st = eType.get(r.sourceEntityId || '') || ''
      if (!st) {
        // FIX 17-a: rel name-only — lookup type thật (SQLite) / node sẵn có (Neo4j)
        // thay vì hardcode 'concept' làm MATCH fail → rel bị drop lặng lẽ
        const resolved = await resolveNameOnlyEndpoint(r.sourceEntityName, nameOnlyCache)
        if (resolved?.id) sId = resolved.id
        else if (resolved?.type) st = resolved.type
        else conceptFallbackNames.add(sn)
      }
      if (!sId) sId = `global__${sn.replace(/[^a-z0-9]/g, '_')}__${st || 'concept'}`
    }

    if (r.targetEntityId && originalToDedupedId.has(r.targetEntityId)) {
      tId = originalToDedupedId.get(r.targetEntityId)
    } else if (r.targetEntityName) {
      const tn = r.targetEntityName.toLowerCase().trim()
      // Ưu tiên type từ entity-id của chính row (nếu entity còn trong buffer chưa sync của doc)
      let tt = eType.get(r.targetEntityId || '') || ''
      if (!tt) {
        // FIX 17-a: rel name-only — lookup type thật (SQLite) / node sẵn có (Neo4j)
        const resolved = await resolveNameOnlyEndpoint(r.targetEntityName, nameOnlyCache)
        if (resolved?.id) tId = resolved.id
        else if (resolved?.type) tt = resolved.type
        else conceptFallbackNames.add(tn)
      }
      if (!tId) tId = `global__${tn.replace(/[^a-z0-9]/g, '_')}__${tt || 'concept'}`
    }

    // If we still don't have IDs, try to find them by name in the entity map
    if (!sId && r.sourceEntityName) {
      const sn = r.sourceEntityName.toLowerCase().trim()
      for (const [key] of entityByKey.entries()) {
        if (key.startsWith(sn + '__')) {
          sId = `global__${key.replace(/[^a-z0-9_]/g, '_')}`
          break
        }
      }
    }
    if (!tId && r.targetEntityName) {
      const tn = r.targetEntityName.toLowerCase().trim()
      for (const [key] of entityByKey.entries()) {
        if (key.startsWith(tn + '__')) {
          tId = `global__${key.replace(/[^a-z0-9_]/g, '_')}`
          break
        }
      }
    }

    if (!sId || !tId) continue
    // Skip self-relationships
    if (sId === tId) continue

    const rt = (r.relationshipType || 'RELATED_TO').replace(/[^a-zA-Z0-9_]/g, '_').toUpperCase()
    const relKey = `${sId}__${tId}__${rt}`
    relByKey.set(relKey, {
      sId, tId, rt,
      desc: r.description || '',
      conf: r.confidenceScore || 0,
      source: r.source || 'llm',
    })
  }

  // FIX 17-a: cảnh báo nhóm 1 dòng — các rel endpoint name-only không tìm thấy entity thật
  // (cả SQLite lẫn Neo4j) nên phải fallback type 'concept'
  if (conceptFallbackNames.size > 0) {
    const sample = Array.from(conceptFallbackNames).slice(0, 10).join(', ')
    console.log(`[Sync-Neo4j] ${conceptFallbackNames.size} name-only rel endpoint(s) fell back to type 'concept' (not found in SQLite/Neo4j): ${sample}${conceptFallbackNames.size > 10 ? ' …' : ''}`)
  }

  // Build RelationshipEdge array for batch upsert
  const relEdges: RelationshipEdge[] = Array.from(relByKey.values()).map(r => ({
    sourceId: r.sId,
    targetId: r.tId,
    relationship_type: r.rt,
    description: r.desc,
    confidence: r.conf,
    documentId: docId,
    source: r.source,
    created_at: now,
  }))

  // Batch upsert relationships using enhanced operations (sets full metadata)
  // FIX kg-arch-a (task 17-c): upsertRelationshipsBatch giờ trả
  // {upserted, dropped, failed, total} — relsCreated giữ số MERGE THẬT
  // cho UI, relsDropped minh bạch rel bị drop vì thiếu endpoint
  const relsResult = await upsertRelationshipsBatch(relEdges, docId)
  const relsCreated = relsResult.upserted

  // Mark entities and relationships as synced in SQLite buffer
  const entityIds = entities.map(e => e.id)
  const syncedEntities = await db.localEntity.updateMany({
    where: { id: { in: entityIds } },
    data: { synced: true },
  })

  const syncedRels = await db.localRelationship.updateMany({
    where: { documentId: docId, synced: false },
    data: { synced: true },
  })

  return {
    docId,
    title: docTitle,
    nodesCreated,
    relsCreated,
    relsDropped: relsResult.dropped,
    uniqueEntities: entityByKey.size,
    documentNodeCreated: true,
    entitiesSynced: syncedEntities.count,
    relsSynced: syncedRels.count,
  }
}

/**
 * Sync all unsynced LocalResolvedEntity records to Neo4j as canonical Entity nodes.
 * These are cross-document deduplicated entities that serve as the "global" knowledge graph.
 */
async function syncResolvedEntities(): Promise<{
  synced: number
  failed: number
  total: number
}> {
  const driver = await getNeo4jDriver()
  if (!driver) throw new Error('Neo4j not connected')

  const unsyncedResolved = await db.localResolvedEntity.findMany({ where: { synced: false } })

  if (unsyncedResolved.length === 0) {
    return { synced: 0, failed: 0, total: 0 }
  }

  const now = new Date().toISOString()
  const entityNodes: EntityNode[] = unsyncedResolved.map(re => ({
    id: `global__${re.canonicalName.toLowerCase().replace(/[^a-z0-9]/g, '_')}__${re.entityType.toLowerCase()}`,
    name: re.canonicalName,
    entity_type: re.entityType as EntityNode['entity_type'],
    domain: (() => {
      try {
        const domains = JSON.parse(re.domains || '[]')
        return Array.isArray(domains) && domains.length > 0 ? domains[0] : 'mixed'
      } catch { return 'mixed' }
    })(),
    description: re.description || '',
    confidence: re.avgConfidence || 0.5,
    documentId: 'resolved', // Cross-document canonical entity
    source: 'resolution',
    chunk_id: '',
    created_at: now,
    updated_at: now,
  }))

  // Batch upsert resolved entities
  let nodesCreated = 0
  let failedCount = 0
  try {
    nodesCreated = await upsertEntitiesBatch(entityNodes, 'resolved')
  } catch (err) {
    console.error('[Sync-Neo4j] Resolved entities batch upsert failed, trying one-by-one:', err instanceof Error ? err.message : String(err))
    // Fall back to one-by-one upsert
    for (const node of entityNodes) {
      try {
        await upsertEntitiesBatch([node], 'resolved')
        nodesCreated++
      } catch {
        failedCount++
      }
    }
  }

  // Mark synced
  const syncedIds = unsyncedResolved.map(re => re.id)
  await db.localResolvedEntity.updateMany({
    where: { id: { in: syncedIds } },
    data: { synced: true },
  })

  // DATA-LOSS FIX 2026-08-31: anchor resolved entities to a synthetic Document node.
  // Without CONTAINS edges these canonical entities were "orphans" and got deleted
  // by the ingestion pipeline's orphan cleanup. (Existing nodes are re-anchored too
  // — MERGE makes this idempotent, so previously-synced entities get protected.)
  if (entityNodes.length > 0) {
    try {
      await upsertDocumentNode({
        id: RESOLVED_ANCHOR_DOC_ID,
        title: 'Resolved Entities (cross-document canonical)',
        domain: 'mixed',
        status: 'extracted',
        page_count: undefined,
        created_at: now,
        updated_at: now,
      })
      const linked = await linkDocumentToEntities(RESOLVED_ANCHOR_DOC_ID, entityNodes.map(n => n.id))
      console.log(`[Sync-Neo4j] Anchored ${linked} resolved entities to ${RESOLVED_ANCHOR_DOC_ID}`)
    } catch (err) {
      console.warn('[Sync-Neo4j] Resolved-entity anchoring failed (entities still synced):', err instanceof Error ? err.message : String(err))
    }
  }

  return {
    synced: nodesCreated,
    failed: failedCount,
    total: unsyncedResolved.length,
  }
}

/**
 * Sync orphan entities (those without a documentId) directly to Neo4j.
 * These are typically test entities or codebase-scanned entities that
 * weren't associated with a specific document during extraction.
 */
async function syncOrphanEntities(): Promise<{
  synced: number
  relsSynced: number
}> {
  const driver = await getNeo4jDriver()
  if (!driver) throw new Error('Neo4j not connected')

  // ROUND-23 P4 — phân trang bảo vệ RAM: trước đây findMany TOÀN BỘ orphan chưa
  // sync (có lúc ~90k row full-field) một lần. Giới hạn 5k entity + 10k rel mỗi
  // lần chạy — hàm đánh dấu synced:true cho phần đã xử lý nên các lần gọi sau
  // tự drain phần còn lại (orderBy id để duy trình tự ổn định).
  const orphanEntities = await db.localEntity.findMany({
    where: { documentId: null, synced: false },
    take: 5000,
    orderBy: { id: 'asc' },
  })
  const orphanRels = await db.localRelationship.findMany({
    where: { documentId: null, synced: false },
    take: 10000,
    orderBy: { id: 'asc' },
  })

  if (orphanEntities.length === 0 && orphanRels.length === 0) {
    return { synced: 0, relsSynced: 0 }
  }

  const now = new Date().toISOString()

  // FIX 19-a (2026-09-10): entity id DETERMINISTIC `global__<name>__<type>` — hết đẻ
  // node `orphan__<rowId>` không dedup được (cùng entity tái sinh node mới mỗi lần sync,
  // id khác nhau giữa các máy). Giờ cùng format với mọi write path khác (17-c/17-a)
  // → MERGE idempotent vào đúng node sẵn có.
  const rowIdToDetId = new Map<string, string>()
  for (const e of orphanEntities) {
    rowIdToDetId.set(e.id, globalEntityId(e.entityName.trim(), e.entityType || 'Concept'))
  }

  // Build entity nodes with deterministic IDs
  const entityNodes: EntityNode[] = orphanEntities.map(e => ({
    id: rowIdToDetId.get(e.id)!,
    name: e.entityName.trim(),
    entity_type: (e.entityType || 'Concept') as EntityNode['entity_type'],
    domain: e.domain || 'mixed',
    description: e.description || '',
    confidence: e.confidenceScore || 0.5,
    documentId: 'orphan',
    source: e.source || 'unknown',
    chunk_id: e.chunkId || '',
    created_at: now,
    updated_at: now,
  }))

  let nodesCreated = 0
  if (entityNodes.length > 0) {
    nodesCreated = await upsertEntitiesBatch(entityNodes, 'orphan')
  }

  // Build name → deduped ID map for relationship resolution
  const nameToId = new Map<string, string>()
  for (const e of orphanEntities) {
    nameToId.set(e.entityName.toLowerCase().trim(), rowIdToDetId.get(e.id)!)
  }

  // Build relationship edges
  const relEdges: RelationshipEdge[] = []
  for (const r of orphanRels) {
    const sName = r.sourceEntityName?.toLowerCase().trim()
    const tName = r.targetEntityName?.toLowerCase().trim()
    // FIX 19-a: endpoint map qua row-id → det-id (ưu tiên) rồi name → det-id (fallback)
    const sId = (r.sourceEntityId ? rowIdToDetId.get(r.sourceEntityId) : undefined) ?? (sName ? nameToId.get(sName) : undefined)
    const tId = (r.targetEntityId ? rowIdToDetId.get(r.targetEntityId) : undefined) ?? (tName ? nameToId.get(tName) : undefined)
    if (!sId || !tId || sId === tId) continue

    const rt = (r.relationshipType || 'RELATED_TO').replace(/[^a-zA-Z0-9_]/g, '_').toUpperCase()
    relEdges.push({
      sourceId: sId,
      targetId: tId,
      relationship_type: rt,
      description: r.description || '',
      confidence: r.confidenceScore || 0,
      documentId: 'orphan',
      source: r.source || 'unknown',
      created_at: now,
    })
  }

  let relsCreated = 0
  if (relEdges.length > 0) {
    // FIX kg-arch-a (task 17-c): return type mới — lấy count MERGE thật
    relsCreated = (await upsertRelationshipsBatch(relEdges, 'orphan')).upserted
  }

  // Mark as synced
  await db.localEntity.updateMany({
    where: { id: { in: orphanEntities.map(e => e.id) } },
    data: { synced: true },
  })
  await db.localRelationship.updateMany({
    where: { id: { in: orphanRels.map(r => r.id) } },
    data: { synced: true },
  })

  // DATA-LOSS FIX 2026-08-31: anchor orphan entities to a synthetic Document node.
  // Without CONTAINS edges these entities were "orphans" and got deleted by the
  // ingestion pipeline's orphan cleanup on the next document processing.
  if (entityNodes.length > 0) {
    try {
      await upsertDocumentNode({
        id: ORPHAN_ANCHOR_DOC_ID,
        title: 'Orphan Entities (codebase-scan / test / unattributed)',
        domain: 'mixed',
        status: 'extracted',
        page_count: undefined,
        created_at: now,
        updated_at: now,
      })
      const linked = await linkDocumentToEntities(ORPHAN_ANCHOR_DOC_ID, entityNodes.map(n => n.id))
      console.log(`[Sync-Neo4j] Anchored ${linked} orphan entities to ${ORPHAN_ANCHOR_DOC_ID}`)
    } catch (err) {
      console.warn('[Sync-Neo4j] Orphan-entity anchoring failed (entities still synced):', err instanceof Error ? err.message : String(err))
    }
  }

  return { synced: nodesCreated, relsSynced: relsCreated }
}

// ==================== ROUTE HANDLERS ====================

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const docId = searchParams.get('docId')
  // If docId is provided without explicit action, default to syncing that document
  const action = searchParams.get('action') || (docId ? 'sync' : 'status')

  // ---- STATUS ----
  if (action === 'status') {
    const driver = await getNeo4jDriver()
    if (!driver) return NextResponse.json({ error: 'Neo4j not connected' }, { status: 503 })

    const stats = await getGraphStats()
    const bufferEnts = await db.localEntity.count()
    const bufferRels = await db.localRelationship.count()
    const bufferUnsyncedEnts = await db.localEntity.count({ where: { synced: false } })
    const bufferUnsyncedRels = await db.localRelationship.count({ where: { synced: false } })
    const bufferResolved = await db.localResolvedEntity.count()
    const bufferUnsyncedResolved = await db.localResolvedEntity.count({ where: { synced: false } })

    // Group unsynced entities by documentId
    const unsyncedByDoc = await db.localEntity.findMany({
      where: { synced: false },
      select: { documentId: true },
    })
    const docCounts: Record<string, number> = {}
    for (const e of unsyncedByDoc) {
      const did = e.documentId || 'unknown'
      docCounts[did] = (docCounts[did] || 0) + 1
    }

    return NextResponse.json({
      neo4j: {
        nodes: stats.totalNodes,
        rels: stats.totalRelationships,
        nodesByLabel: stats.nodesByLabel,
        relsByType: stats.relsByType,
      },
      buffer: {
        entities: bufferEnts,
        rels: bufferRels,
        unsyncedEntities: bufferUnsyncedEnts,
        unsyncedRels: bufferUnsyncedRels,
        resolvedEntities: bufferResolved,
        unsyncedResolvedEntities: bufferUnsyncedResolved,
      },
      unsyncedDocuments: docCounts,
    })
  }

  // ---- SYNC-ALL ----
  if (action === 'sync-all') {
    const driver = await getNeo4jDriver()
    if (!driver) return NextResponse.json({ error: 'Neo4j not connected' }, { status: 503 })

    try {
      // Find all documentIds with unsynced entities
      const unsyncedDocs = await db.localEntity.findMany({
        where: { synced: false },
        select: { documentId: true },
        distinct: ['documentId'],
      })

      const docIds = unsyncedDocs.map(e => e.documentId).filter(Boolean) as string[]
      const hasOrphanEntities = unsyncedDocs.some(e => !e.documentId)

      // Also find documentIds with unsynced relationships (may have entities already synced)
      const unsyncedRelDocs = await db.localRelationship.findMany({
        where: { synced: false },
        select: { documentId: true },
        distinct: ['documentId'],
      })
      const relDocIds = unsyncedRelDocs.map(r => r.documentId).filter(Boolean) as string[]
      const hasOrphanRels = unsyncedRelDocs.some(r => !r.documentId)
      for (const did of relDocIds) {
        if (!docIds.includes(did)) docIds.push(did)
      }

      // Annotation tường minh — tránh never[] (strict + noImplicitAny:false)
      const results: Awaited<ReturnType<typeof syncDocumentToNeo4j>>[] = []
      let totalNodesCreated = 0
      let totalRelsCreated = 0
      let totalEntitiesSynced = 0
      let totalRelsSynced = 0
      const errors: Array<{ docId: string; error: string }> = []

      for (const did of docIds) {
        try {
          const result = await syncDocumentToNeo4j(did)
          results.push(result)
          totalNodesCreated += result.nodesCreated
          totalRelsCreated += result.relsCreated
          totalEntitiesSynced += result.entitiesSynced
          totalRelsSynced += result.relsSynced
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err)
          console.error(`[Sync-Neo4j] Error syncing document ${did}:`, errorMsg)
          errors.push({ docId: did, error: errorMsg })
        }
      }

      // Also sync orphan entities (those without a documentId)
      let orphanResult = { synced: 0, relsSynced: 0 }
      if (hasOrphanEntities || hasOrphanRels) {
        try {
          orphanResult = await syncOrphanEntities()
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err)
          console.error('[Sync-Neo4j] Error syncing orphan entities:', errorMsg)
          errors.push({ docId: 'orphan', error: errorMsg })
        }
      }

      // Also sync resolved entities
      let resolvedResult = { synced: 0, failed: 0, total: 0 }
      try {
        resolvedResult = await syncResolvedEntities()
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err)
        console.error('[Sync-Neo4j] Error syncing resolved entities:', errorMsg)
        errors.push({ docId: 'resolved', error: errorMsg })
      }

      // DATA-LOSS FIX 2026-08-31 (step 3): re-anchor legacy unanchored entities so
      // pre-fix chat-learned/agent knowledge is protected from any future cleanup.
      let legacyAnchorResult = { anchored: 0 }
      try {
        legacyAnchorResult = await anchorLegacyEntities()
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err)
        console.error('[Sync-Neo4j] Error re-anchoring legacy entities:', errorMsg)
        errors.push({ docId: 'legacy-anchor', error: errorMsg })
      }

      return NextResponse.json({
        action: 'sync-all',
        documentsProcessed: docIds.length,
        documents: results,
        orphanEntities: orphanResult,
        summary: {
          totalNodesCreated: totalNodesCreated + orphanResult.synced,
          totalRelsCreated: totalRelsCreated + orphanResult.relsSynced,
          totalEntitiesSynced: totalEntitiesSynced + orphanResult.synced,
          totalRelsSynced: totalRelsSynced + orphanResult.relsSynced,
        },
        resolvedEntities: resolvedResult,
        legacyAnchor: legacyAnchorResult,
        errors: errors.length > 0 ? errors : undefined,
      })
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      console.error('[Sync-Neo4j] Sync-all error:', errorMsg)
      return NextResponse.json({ error: errorMsg }, { status: 500 })
    }
  }

  // ---- SYNC-RESOLVED ----
  if (action === 'sync-resolved') {
    const driver = await getNeo4jDriver()
    if (!driver) return NextResponse.json({ error: 'Neo4j not connected' }, { status: 503 })

    try {
      const result = await syncResolvedEntities()
      return NextResponse.json({
        action: 'sync-resolved',
        ...result,
      })
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      console.error('[Sync-Neo4j] Sync-resolved error:', errorMsg)
      return NextResponse.json({ error: errorMsg }, { status: 500 })
    }
  }

  // ---- MERGE-GLOBAL: Merge per-document nodes into global cross-document nodes ----
  if (action === 'merge-global') {
    const driver = await getNeo4jDriver()
    if (!driver) return NextResponse.json({ error: 'Neo4j not connected' }, { status: 503 })

    try {
      console.log('[Sync-Neo4j] Starting cross-document merge...')
      const result = await mergePerDocumentNodesToGlobal()
      return NextResponse.json({
        action: 'merge-global',
        ...result,
      })
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      console.error('[Sync-Neo4j] Merge-global error:', errorMsg)
      return NextResponse.json({ error: errorMsg }, { status: 500 })
    }
  }

  // ---- SYNC SINGLE DOCUMENT (docId required) ----
  if (!docId) return NextResponse.json({ error: 'Missing docId parameter. Use ?action=status, ?action=sync-all, ?action=sync-resolved, ?action=merge-global, or ?docId=<id>' }, { status: 400 })

  const driver = await getNeo4jDriver()
  if (!driver) return NextResponse.json({ error: 'Neo4j not connected' }, { status: 503 })

  try {
    const result = await syncDocumentToNeo4j(docId)
    return NextResponse.json(result)
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err)
    console.error('[Sync-Neo4j] Error:', errorMsg)
    return NextResponse.json({ error: errorMsg }, { status: 500 })
  }
}
