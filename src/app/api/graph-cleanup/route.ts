/**
 * GRAPH CLEANUP — dọn rác Neo4j Aura (Task 19-a, 2026-09-10).
 *
 * Bối cảnh (audit Task 16 + 17): write path đã chặn nguồn rác MỚI
 * (deterministic ids 17-c, rel-count thật, type-lookup 17-a) nhưng rác CŨ
 * vẫn nằm trong Aura. Route này dọn 4 nhóm:
 *
 *   P1 — Non-det-id normalize: node id KHÔNG deterministic — nhóm UUID (266 node
 *        auto-learn writeback cũ, 17.308 rels bám vào — KHÔNG phải rác đơn thuần
 *        mà là knowledge hub) + nhóm `orphan__<rowId>` (sync path cũ, FIX nguồn
 *        đã áp dụng ở sync-neo4j). Xử lý: merge nhóm trùng + rename id thành
 *        `global__<slug(name)>__<slug(type)>` (đúng format write path mới) →
 *        rels được bảo toàn 100%, node trùng lặp gom lại, writeback tương lai
 *        MERGE vào đúng node (hết đẻ node trùng).
 *
 *   P2 — orphan__ junk (fallback khi thiếu APOC): node `orphan__` 0-rels còn sót
 *        sau P1 → DETACH DELETE. Khi có APOC, P1 đã normalize hết nên P2 = 0.
 *
 *   P3 — Placeholder orphans: node entity 0-rels với description
 *        "Auto-generated entity placeholder from relationship context" → DELETE.
 *
 *   P4 — Empty-anchor Documents: node Document 0-rels (anchor doc cũ mà
 *        rels bị drop do bug MATCH-then-MERGE đã fix) → DELETE (MERGE sẽ
 *        recreate nếu cần).
 *
 *   P5 — Real orphans (mặc định ANCHOR, không xóa): entity 0-rels có
 *        description thật → neo CONTAINS về Document `__auto_learned__`
 *        theo đúng triết lý DATA-LOSS FIX 2026-08-31 của sync-neo4j
 *        (protect unanchored knowledge khỏi cleanup tương lai).
 *        orphanPolicy: 'anchor' (mặc định) | 'delete' | 'keep'.
 *
 * API:
 *   GET  ?action=analyze                       → báo cáo read-only (counts + plan)
 *   POST { dryRun?, orphanPolicy?, backup? }   → dryRun mặc định TRUE (chỉ plan);
 *        dryRun:false mới ghi. backup mặc định TRUE → xuất JSON đầy đủ
 *        node bị xóa + mapping merge/rename vào db/neo4j-cleanup-backup-*.json
 *
 * An toàn:
 *   - Mọi DELETE đều re-verify điều kiện 0-rels NGAY TRONG query xóa
 *     (node nào có rels xuất hiện giữa chừng sẽ được bỏ qua, không xóa nhầm).
 *   - Merge UUID dùng apoc.refactor.mergeNodes (properties:'discard' sau khi
 *     đã enrich props thiếu cho node đích; produceSelfRel:false) — APOC đã
 *     verify có trên Aura (2026.08.0). Thiếu APOC → bỏ P1 với warning, không fail.
 *   - writeback KHÔNG ghi LocalEntity (verify 19-a) → rename id không bị
 *     resurrect từ buffer SQLite/Supabase.
 */

import { NextRequest, NextResponse } from 'next/server'
import { writeFileSync } from 'fs'
import { join } from 'path'
import {
  getNeo4jDriver,
  safeSession,
  readCypher,
  getGraphStats,
  upsertDocumentNode,
  linkDocumentToEntities,
} from '@/lib/neo4j'
import { globalEntityId } from '@/lib/ingestion/entity-resolver'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const PLACEHOLDER_DESC = 'Auto-generated entity placeholder from relationship context'
const ANCHOR_DOC_ID = '__auto_learned__'
const ANCHOR_DOC_TITLE = 'Auto-Learned & Agent Knowledge (legacy anchor)'

type OrphanPolicy = 'anchor' | 'delete' | 'keep'

interface UuidNode {
  id: string
  name: string
  labels: string[]
  props: Record<string, unknown>
}

interface DetGroup {
  detId: string
  type: string
  members: UuidNode[]
  existingGlobalId?: string
}

interface CleanupPlan {
  beforeStats: { nodes: number; rels: number }
  uuidNormalize: {
    totalNonDetNodes: number
    uniqueDetIds: number
    mergeIntoExisting: number
    renameSurvivors: number
    groupsWithDuplicates: number
    nodeReduction: number
    apocAvailable: boolean
  }
  orphanPrefixJunk: string[]
  placeholderOrphans: string[]
  emptyAnchorDocs: Array<{ id: string; name: string }>
  realOrphans: { count: number; policy: OrphanPolicy; sample: string[] }
}

// ---------------------------------------------------------------------------
// Read phase — toàn bộ READ-ONLY, dùng chung cho analyze + dryRun + execute
// ---------------------------------------------------------------------------

async function checkApoc(): Promise<boolean> {
  try {
    const rows = await readCypher<{ v: string }>('RETURN apoc.version() AS v')
    return rows.length > 0 && Boolean(rows[0].v)
  } catch {
    return false
  }
}

/** Node id không deterministic: UUID hoặc `orphan__<rowId>` (sync path cũ). */
async function readNonDetNodes(): Promise<UuidNode[]> {
  const rows = await readCypher<{ id: string; name: string; labels: string[]; props: Record<string, unknown> }>(
    `MATCH (u) WHERE u.id =~ $uuidRegex OR u.id STARTS WITH 'orphan__'
     RETURN u.id AS id, u.name AS name, labels(u) AS labels, properties(u) AS props`,
    { uuidRegex: UUID_REGEX.source }
  )
  return rows.filter(r => r.id && r.name)
}

async function readExistingGlobalIds(detIds: string[]): Promise<Set<string>> {
  const existing = new Set<string>()
  for (let i = 0; i < detIds.length; i += 100) {
    const batch = detIds.slice(i, i + 100)
    const rows = await readCypher<{ id: string }>(
      'MATCH (g) WHERE g.id IN $ids RETURN g.id AS id',
      { ids: batch }
    )
    for (const r of rows) if (r.id) existing.add(r.id)
  }
  return existing
}

async function readOrphanPrefixNodes(): Promise<string[]> {
  const rows = await readCypher<{ id: string }>(
    `MATCH (n) WHERE n.id STARTS WITH 'orphan__' AND NOT (n)--()
     RETURN n.id AS id`
  )
  return rows.map(r => r.id).filter(Boolean)
}

async function readPlaceholderOrphans(): Promise<string[]> {
  const rows = await readCypher<{ id: string }>(
    `MATCH (n) WHERE NOT n:Document AND NOT (n)--()
       AND coalesce(n.description, '') = $ph AND n.id IS NOT NULL
     RETURN n.id AS id`,
    { ph: PLACEHOLDER_DESC }
  )
  return rows.map(r => r.id).filter(Boolean)
}

async function readEmptyAnchorDocs(): Promise<Array<{ id: string; name: string }>> {
  return readCypher<{ id: string; name: string }>(
    `MATCH (d:Document) WHERE NOT (d)--() AND d.id IS NOT NULL AND d.id <> $anchorId
     RETURN d.id AS id, d.name AS name`,
    { anchorId: ANCHOR_DOC_ID }
  )
}

async function readRealOrphanIds(): Promise<string[]> {
  const rows = await readCypher<{ id: string }>(
    `MATCH (n) WHERE NOT n:Document AND NOT (n)--()
       AND coalesce(n.description, '') <> $ph AND n.id IS NOT NULL
     RETURN n.id AS id`,
    { ph: PLACEHOLDER_DESC }
  )
  return rows.map(r => r.id).filter(Boolean)
}

function buildDetGroups(uuidNodes: UuidNode[], existingGlobalIds: Set<string>): DetGroup[] {
  const byDet = new Map<string, DetGroup>()
  for (const u of uuidNodes) {
    // type = label đầu tiên khác 'Entity' (match logic mô phỏng 19-a + write path)
    const type = (u.labels || []).find(l => l !== 'Entity') || 'Concept'
    const detId = globalEntityId(u.name, type)
    let g = byDet.get(detId)
    if (!g) {
      g = { detId, type, members: [] }
      byDet.set(detId, g)
    }
    g.members.push(u)
    if (existingGlobalIds.has(detId)) g.existingGlobalId = detId
  }
  return [...byDet.values()]
}

async function buildPlan(orphanPolicy: OrphanPolicy): Promise<CleanupPlan> {
  const stats = await getGraphStats()
  const [apocAvailable, nonDetNodes, orphanPrefix, placeholders, emptyAnchors, realOrphanIds] =
    await Promise.all([
      checkApoc(),
      readNonDetNodes(),
      readOrphanPrefixNodes(),
      readPlaceholderOrphans(),
      readEmptyAnchorDocs(),
      readRealOrphanIds(),
    ])

  const detIds = nonDetNodes.map(u => {
    const type = (u.labels || []).find(l => l !== 'Entity') || 'Concept'
    return globalEntityId(u.name, type)
  })
  const existingGlobalIds = await readExistingGlobalIds([...new Set(detIds)])
  const groups = buildDetGroups(nonDetNodes, existingGlobalIds)

  const mergeGroups = groups.filter(g => g.existingGlobalId)
  const renameGroups = groups.filter(g => !g.existingGlobalId)

  return {
    beforeStats: { nodes: stats.totalNodes, rels: stats.totalRelationships },
    uuidNormalize: {
      totalNonDetNodes: nonDetNodes.length,
      uniqueDetIds: groups.length,
      mergeIntoExisting: mergeGroups.reduce((s, g) => s + g.members.length, 0),
      renameSurvivors: renameGroups.length,
      groupsWithDuplicates: groups.filter(g => g.members.length > 1).length,
      nodeReduction: nonDetNodes.length - groups.length,
      apocAvailable,
    },
    orphanPrefixJunk: orphanPrefix,
    placeholderOrphans: placeholders,
    emptyAnchorDocs: emptyAnchors,
    realOrphans: {
      count: realOrphanIds.length,
      policy: orphanPolicy,
      sample: realOrphanIds.slice(0, 5),
    },
  }
}

// ---------------------------------------------------------------------------
// Execute phase
// ---------------------------------------------------------------------------

/** Enrich props thiếu của node đích (t) từ node nguồn (o) — chạy per-row trước khi merge. */
const PROP_ENRICH = `
  SET t.description = CASE WHEN coalesce(t.description, '') = '' THEN coalesce(o.description, '') ELSE t.description END,
      t.embedding = CASE WHEN t.embedding IS NULL THEN o.embedding ELSE t.embedding END,
      t.domain = CASE WHEN coalesce(t.domain, '') = '' OR t.domain = 'mixed' THEN coalesce(o.domain, t.domain) ELSE t.domain END,
      t.source = CASE WHEN coalesce(t.source, '') = '' THEN coalesce(o.source, t.source) ELSE t.source END,
      t.entity_type = coalesce(t.entity_type, o.entity_type),
      t.entity_name = coalesce(t.entity_name, o.entity_name)`

/** P1a — merge nhóm UUID vào node global__ đã tồn tại (target giữ props, đã enrich thiếu). */
async function mergeGroupIntoExisting(g: DetGroup): Promise<void> {
  const session = await safeSession()
  try {
    await session.executeWrite(tx =>
      tx.run(
        `MATCH (t {id: $targetId})
         MATCH (o) WHERE o.id IN $uuidIds
         WITH t, o ${PROP_ENRICH}
         WITH t, collect(o) AS others
         CALL apoc.refactor.mergeNodes([t] + others, {properties: 'discard', produceSelfRel: false}) YIELD node
         RETURN node.id AS mergedId`,
        { targetId: g.existingGlobalId, uuidIds: g.members.map(m => m.id) }
      )
    )
  } finally {
    await session.close()
  }
}

/** P1b — gom nhóm UUID (nếu >1 member) rồi rename survivor → deterministic id. */
async function normalizeGroup(g: DetGroup): Promise<void> {
  // survivor = member có description dài nhất (giữ kiến thức tốt nhất)
  const survivor = [...g.members].sort((a, b) =>
    String(b.props.description || '').length - String(a.props.description || '').length
  )[0]
  const others = g.members.filter(m => m.id !== survivor.id)

  const session = await safeSession()
  try {
    if (others.length > 0) {
      await session.executeWrite(tx =>
        tx.run(
          `MATCH (t {id: $survivorId})
           MATCH (o) WHERE o.id IN $otherIds
           WITH t, o ${PROP_ENRICH}
           WITH t, collect(o) AS others
           CALL apoc.refactor.mergeNodes([t] + others, {properties: 'discard', produceSelfRel: false}) YIELD node
           WITH node
           SET node.id = $detId,
               node.entity_type = coalesce(node.entity_type, $type),
               node.entity_name = coalesce(node.entity_name, node.name)
           RETURN node.id AS finalId`,
          { survivorId: survivor.id, otherIds: others.map(o => o.id), detId: g.detId, type: g.type }
        )
      )
    } else {
      await session.executeWrite(tx =>
        tx.run(
          `MATCH (t {id: $survivorId})
           SET t.id = $detId,
               t.entity_type = coalesce(t.entity_type, $type),
               t.entity_name = coalesce(t.entity_name, t.name)
           RETURN t.id AS finalId`,
          { survivorId: survivor.id, detId: g.detId, type: g.type }
        )
      )
    }
  } finally {
    await session.close()
  }
}

/** Re-check: sau đợt merge, det id nào đã bị node non-UUID chiếm (race) → trả về set. */
async function recheckOccupiedDetIds(detIds: string[]): Promise<Set<string>> {
  const occupied = new Set<string>()
  for (let i = 0; i < detIds.length; i += 100) {
    const batch = detIds.slice(i, i + 100)
    const rows = await readCypher<{ id: string }>(
      `MATCH (n) WHERE n.id IN $ids AND NOT n.id =~ $uuidRegex
       RETURN DISTINCT n.id AS id`,
      { ids: batch, uuidRegex: UUID_REGEX.source }
    )
    for (const r of rows) if (r.id) occupied.add(r.id)
  }
  return occupied
}

interface BackupPayload {
  timestamp: string
  beforeStats: { nodes: number; rels: number }
  deleted: {
    orphanPrefix: Array<Record<string, unknown>>
    placeholders: Array<Record<string, unknown>>
    emptyAnchorDocs: Array<Record<string, unknown>>
    realOrphans?: Array<Record<string, unknown>>
  }
  uuidNormalize: {
    merged: Array<{ uuidIds: string[]; targetId: string }>
    renamed: Array<{ fromId: string; toId: string }>
  }
}

async function fetchNodesBackup(ids: string[]): Promise<Array<Record<string, unknown>>> {
  if (ids.length === 0) return []
  const out: Array<Record<string, unknown>> = []
  for (let i = 0; i < ids.length; i += 100) {
    const batch = ids.slice(i, i + 100)
    const rows = await readCypher<Record<string, unknown>>(
      `MATCH (n) WHERE n.id IN $ids
       RETURN n.id AS id, n.name AS name, labels(n) AS labels, properties(n) AS props`,
      { ids: batch }
    )
    out.push(...rows)
  }
  return out
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export async function GET(req: NextRequest) {
  const action = req.nextUrl.searchParams.get('action') || 'analyze'
  if (action !== 'analyze') {
    return NextResponse.json({ error: `Unknown action '${action}' — chỉ hỗ trợ 'analyze'` }, { status: 400 })
  }
  try {
    const driver = await getNeo4jDriver()
    if (!driver) return NextResponse.json({ error: 'Neo4j not connected' }, { status: 503 })
    const plan = await buildPlan('anchor')
    return NextResponse.json({
      action: 'analyze',
      ...plan,
      hint: 'POST {dryRun:false} để dọn thật. Mặc định dryRun:true. orphanPolicy: anchor|delete|keep (mặc định anchor — bảo vệ kiến thức theo DATA-LOSS FIX).',
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[Graph-Cleanup] Analyze error:', msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  let body: { dryRun?: boolean; orphanPolicy?: string; backup?: boolean } = {}
  try {
    body = await req.json()
  } catch {
    body = {}
  }
  const dryRun = body.dryRun !== false // mặc định TRUE — an toàn tuyệt đối
  const orphanPolicy: OrphanPolicy =
    body.orphanPolicy === 'delete' || body.orphanPolicy === 'keep' || body.orphanPolicy === 'anchor'
      ? body.orphanPolicy
      : 'anchor'
  const wantBackup = body.backup !== false

  try {
    const driver = await getNeo4jDriver()
    if (!driver) return NextResponse.json({ error: 'Neo4j not connected' }, { status: 503 })

    const plan = await buildPlan(orphanPolicy)
    const result: Record<string, unknown> = {
      action: 'cleanup',
      dryRun,
      orphanPolicy,
      beforeStats: plan.beforeStats,
      plan: {
        uuidNormalize: plan.uuidNormalize,
        orphanPrefixJunk: plan.orphanPrefixJunk.length,
        placeholderOrphans: plan.placeholderOrphans.length,
        emptyAnchorDocs: plan.emptyAnchorDocs.length,
        realOrphans: plan.realOrphans,
      },
    }
    if (dryRun) {
      return NextResponse.json({
        ...result,
        hint: 'Đây là DRY-RUN (không ghi gì). POST lại với {"dryRun":false} để thực thi. Backup JSON sẽ lưu ở db/neo4j-cleanup-backup-*.json',
      })
    }

    const backup: BackupPayload = {
      timestamp: new Date().toISOString(),
      beforeStats: plan.beforeStats,
      deleted: { orphanPrefix: [], placeholders: [], emptyAnchorDocs: [] },
      uuidNormalize: { merged: [], renamed: [] },
    }

    // ---- P1: non-det-id normalize (UUID + orphan__) ----
    const p1 = { merged: 0, renamed: 0, skippedNoApoc: 0, errors: [] as string[] }
    if (!plan.uuidNormalize.apocAvailable) {
      p1.skippedNoApoc = plan.uuidNormalize.totalNonDetNodes
      console.warn('[Graph-Cleanup] APOC không khả dụng — bỏ qua P1 (non-det-id normalize)')
    } else {
      const nonDetNodes = await readNonDetNodes()
      const detIds = [...new Set(
        nonDetNodes.map(u => globalEntityId(u.name, (u.labels || []).find(l => l !== 'Entity') || 'Concept'))
      )]
      const existing = await readExistingGlobalIds(detIds)
      const groups = buildDetGroups(nonDetNodes, existing)

      // P1a: merge vào global__ đã tồn tại TRƯỚC (giải phóng det id, tránh race)
      for (const g of groups.filter(g => g.existingGlobalId)) {
        try {
          await mergeGroupIntoExisting(g)
          p1.merged += g.members.length
          backup.uuidNormalize.merged.push({ uuidIds: g.members.map(m => m.id), targetId: g.existingGlobalId! })
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          p1.errors.push(`${g.detId}: ${msg}`)
        }
      }

      // P1b: rename các nhóm còn lại — re-check det id bị chiếm (race an toàn)
      const renameGroups = groups.filter(g => !g.existingGlobalId)
      const occupied = await recheckOccupiedDetIds(renameGroups.map(g => g.detId))
      for (const g of renameGroups) {
        try {
          if (occupied.has(g.detId)) {
            // det id đã có node global__ (xuất hiện sau read phase) → merge thay vì rename
            await mergeGroupIntoExisting({ ...g, existingGlobalId: g.detId })
            p1.merged += g.members.length
            backup.uuidNormalize.merged.push({ uuidIds: g.members.map(m => m.id), targetId: g.detId })
          } else {
            await normalizeGroup(g)
            p1.renamed += 1
            backup.uuidNormalize.renamed.push({
              fromId: g.members.length === 1 ? g.members[0].id : `${g.members.length}-uuid-group`,
              toId: g.detId,
            })
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          p1.errors.push(`${g.detId}: ${msg}`)
        }
      }
    }
    result.p1UuidNormalize = p1

    // ---- P2: orphan__ junk ----
    const p2 = { deleted: 0 }
    {
      const ids = await readOrphanPrefixNodes()
      if (ids.length > 0) {
        backup.deleted.orphanPrefix = await fetchNodesBackup(ids)
        const session = await safeSession()
        try {
          const res = await session.executeWrite(tx =>
            tx.run(
              `MATCH (n) WHERE n.id IN $ids AND n.id STARTS WITH 'orphan__' AND NOT (n)--()
               DETACH DELETE n RETURN count(n) AS c`,
              { ids }
            )
          )
          p2.deleted = Number(res.records[0]?.get('c')?.toString() || 0)
        } finally {
          await session.close()
        }
      }
    }
    result.p2OrphanPrefixJunk = p2

    // ---- P3: placeholder orphans ----
    const p3 = { deleted: 0 }
    {
      const ids = await readPlaceholderOrphans()
      if (ids.length > 0) {
        backup.deleted.placeholders = await fetchNodesBackup(ids)
        for (let i = 0; i < ids.length; i += 250) {
          const batch = ids.slice(i, i + 250)
          const session = await safeSession()
          try {
            const res = await session.executeWrite(tx =>
              tx.run(
                `MATCH (n) WHERE n.id IN $ids AND NOT n:Document AND NOT (n)--()
                   AND coalesce(n.description, '') = $ph
                 DETACH DELETE n RETURN count(n) AS c`,
                { ids: batch, ph: PLACEHOLDER_DESC }
              )
            )
            p3.deleted += Number(res.records[0]?.get('c')?.toString() || 0)
          } finally {
            await session.close()
          }
        }
      }
    }
    result.p3Placeholders = p3

    // ---- P4: empty-anchor Documents ----
    const p4 = { deleted: 0 }
    {
      const docs = await readEmptyAnchorDocs()
      const ids = docs.map(d => d.id).filter(Boolean)
      if (ids.length > 0) {
        backup.deleted.emptyAnchorDocs = await fetchNodesBackup(ids)
        for (let i = 0; i < ids.length; i += 250) {
          const batch = ids.slice(i, i + 250)
          const session = await safeSession()
          try {
            const res = await session.executeWrite(tx =>
              tx.run(
                `MATCH (d:Document) WHERE d.id IN $ids AND NOT (d)--()
                 DETACH DELETE d RETURN count(d) AS c`,
                { ids: batch }
              )
            )
            p4.deleted += Number(res.records[0]?.get('c')?.toString() || 0)
          } finally {
            await session.close()
          }
        }
      }
    }
    result.p4EmptyAnchorDocs = p4

    // ---- P5: real orphans theo policy ----
    const p5 = { policy: orphanPolicy, affected: 0 }
    {
      const ids = await readRealOrphanIds()
      if (ids.length > 0) {
        if (orphanPolicy === 'anchor') {
          // Đúng cơ chế anchorLegacyEntities của sync-neo4j (DATA-LOSS FIX 2026-08-31)
          const now = new Date().toISOString()
          await upsertDocumentNode({
            id: ANCHOR_DOC_ID,
            title: ANCHOR_DOC_TITLE,
            domain: 'auto-learned',
            status: 'extracted',
            page_count: undefined,
            created_at: now,
            updated_at: now,
          })
          const linked = await linkDocumentToEntities(ANCHOR_DOC_ID, ids)
          p5.affected = linked
        } else if (orphanPolicy === 'delete') {
          backup.deleted.realOrphans = await fetchNodesBackup(ids)
          for (let i = 0; i < ids.length; i += 250) {
            const batch = ids.slice(i, i + 250)
            const session = await safeSession()
            try {
              const res = await session.executeWrite(tx =>
                tx.run(
                  `MATCH (n) WHERE n.id IN $ids AND NOT n:Document AND NOT (n)--()
                   DETACH DELETE n RETURN count(n) AS c`,
                  { ids: batch }
                )
              )
              p5.affected += Number(res.records[0]?.get('c')?.toString() || 0)
            } finally {
              await session.close()
            }
          }
        }
        // 'keep' → không đụng
      }
    }
    result.p5RealOrphans = p5

    // ---- Backup + after-stats ----
    let backupFile: string | null = null
    if (wantBackup) {
      const ts = new Date().toISOString().replace(/[:.]/g, '-')
      backupFile = join(process.cwd(), 'db', `neo4j-cleanup-backup-${ts}.json`)
      writeFileSync(backupFile, JSON.stringify(backup), 'utf-8')
    }
    const after = await getGraphStats()
    result.afterStats = { nodes: after.totalNodes, rels: after.totalRelationships, avgDegree: after.avgDegree }
    result.backupFile = backupFile

    console.log(`[Graph-Cleanup] DONE dryRun=false policy=${orphanPolicy}: P1 merged=${p1.merged} renamed=${p1.renamed} errs=${p1.errors.length}; P2=${p2.deleted}; P3=${p3.deleted}; P4=${p4.deleted}; P5=${p5.affected}; nodes ${plan.beforeStats.nodes}→${after.totalNodes}, rels ${plan.beforeStats.rels}→${after.totalRelationships}`)

    return NextResponse.json(result)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[Graph-Cleanup] Execute error:', msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
