/**
 * R24-a — D0 BƯỚC 4: ĐO ĐỒ THỊ NEO4J TRƯỚC/SAU TRIAL INGESTION
 * ============================================================================
 * Chạy (bun tự nạp .env từ cwd — precedent r22-room-verify):
 *   bun scratch/r24-d0-graph-stats.ts before
 *   bun scratch/r24-d0-graph-stats.ts after <documentId>
 *
 * BEFORE: getGraphStats() (src/lib/neo4j) → ghi { phase, stats, measuredAt }
 *         vào scratch/r24-d0-graph-stats.json (merge key 'before').
 * AFTER:  getGraphStats() → key 'after' + queries theo documentId:
 *         - CONTAINS: số node entity doc này trỏ tới
 *         - rels của doc (r.documentId = $doc, non-CONTAINS) theo type
 *         - MERGE SPLIT: node doc chạm lần này chia theo occurrence_count
 *           (=1 → node tạo MỚI bởi run này; >1 → merge vào node CŨ có sẵn —
 *           upsertEntitiesBatch viết mỗi global id đúng 1 lần/run nên phân
 *           đôi theo occurrence_count là xác định với tập node bị chạm)
 *           + created_at window để đối chứng chéo.
 *         + SQLite: LocalEntity/LocalRelationship count của doc.
 */
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import { getGraphStats, readCypher } from '../src/lib/neo4j'
import { db } from '../src/lib/db'

const OUT_JSON = join(process.cwd(), 'scratch', 'r24-d0-graph-stats.json')

type Phase = 'before' | 'after'
const phase = (process.argv[2] as Phase) || 'before'
const documentId = process.argv[3] || ''
if (phase !== 'before' && phase !== 'after') {
  console.error('Usage: bun scratch/r24-d0-graph-stats.ts before | after <documentId>')
  process.exit(1)
}
if (phase === 'after' && !documentId) {
  console.error('after cần documentId: bun scratch/r24-d0-graph-stats.ts after <documentId>')
  process.exit(1)
}

const measuredAt = new Date().toISOString()
const stats = await getGraphStats()

const entry: Record<string, unknown> = {
  phase,
  measuredAt,
  totalNodes: stats.totalNodes,
  totalRelationships: stats.totalRelationships,
  labelCounts: stats.nodesByLabel,
  relsByType: stats.relsByType,
  avgDegree: stats.avgDegree,
}

if (phase === 'after') {
  // 1) CONTAINS: node entity doc này trỏ tới
  const contains = await readCypher<{ cnt: number }>(
    'MATCH (d:Document {id: $docId})-[:CONTAINS]->(e) RETURN count(e) AS cnt',
    { docId: documentId },
  )
  // 2) rels của doc (non-CONTAINS) theo type
  const relsByTypeDoc = await readCypher<{ relType: string; cnt: number }>(
    `MATCH ()-[r]->() WHERE (r.documentId = $docId OR r.document_id = $docId) AND NOT type(r) = 'CONTAINS'
     RETURN type(r) AS relType, count(r) AS cnt ORDER BY cnt DESC`,
    { docId: documentId },
  )
  // 3) MERGE SPLIT theo occurrence_count (node bị chạm bởi run này)
  const occSplit = await readCypher<{ isNew: boolean; cnt: number; minCreatedAt: string; maxCreatedAt: string }>(
    `MATCH (d:Document {id: $docId})-[:CONTAINS]->(e)
     WHERE e.occurrence_count IS NOT NULL
     WITH (e.occurrence_count = 1) AS isNew, e.created_at AS ca
     RETURN isNew, count(*) AS cnt, min(ca) AS minCreatedAt, max(ca) AS maxCreatedAt`,
    { docId: documentId },
  )
  // 3b) Đối chứng chéo: created_at window của nhóm occurrence_count=1
  // (cần trùng thời điểm run — nếu lệch xa → occurrence_count=1 là node cũ
  //  chưa từng được nhắc lại, cần xem lại).
  const createdNewWindow = await readCypher<{ cnt: number; minCreatedAt: string; maxCreatedAt: string }>(
    `MATCH (d:Document {id: $docId})-[:CONTAINS]->(e)
     WHERE e.occurrence_count = 1 AND e.created_at IS NOT NULL
     RETURN count(*) AS cnt, min(e.created_at) AS minCreatedAt, max(e.created_at) AS maxCreatedAt`,
    { docId: documentId },
  )
  // 3c) R24-a bổ sung: MERGE SPLIT theo created_at (chuẩn xác hơn occ khi doc
  // chạy NHIỀU lượt reExtract — upsertEntitiesBatch ON MATCH tăng
  // occurrence_count +1 MỖI LƯỢT nên node mới tạo trong trial mà được ghi ở
  // ≥2 lượt sẽ có occ ≥ 2, đánh lừa phép chia occ=1/occ>1). created_at chỉ set
  // 1 lần khi node ĐƯỢC TẠO (ON CREATE) → node có created_at ≥ mốc upload của
  // trial = node MỚI do trial tạo; < mốc = node CŨ có sẵn được merge vào.
  const trialStartIso = (process.argv[4] || '').trim()
  let createdSplit: Array<{ bucket: string; cnt: number }> = []
  if (trialStartIso) {
    createdSplit = await readCypher<{ bucket: string; cnt: number }>(
      `MATCH (d:Document {id: $docId})-[:CONTAINS]->(e)
       WHERE e.created_at IS NOT NULL
       WITH CASE WHEN e.created_at >= $cutoff THEN 'newInTrial' ELSE 'preExisting' END AS bucket
       RETURN bucket, count(*) AS cnt ORDER BY bucket`,
      { docId: documentId, cutoff: trialStartIso },
    )
  }
  // 4) SQLite: buffer extraction của doc
  const localEntityCount = await db.localEntity.count({ where: { documentId } })
  const localRelCount = await db.localRelationship.count({ where: { documentId } })
  const docRow = await db.document.findUnique({ where: { id: documentId } })

  entry.documentId = documentId
  entry.doc = {
    title: docRow?.title ?? null,
    status: docRow?.status ?? null,
    pageCount: docRow?.pageCount ?? null,
    domain: docRow?.domain ?? null,
    contentHash: docRow?.contentHash ? `${docRow.contentHash.slice(0, 12)}…` : null,
  }
  entry.docContains = contains[0]?.cnt ?? 0
  entry.docRelsByType = relsByTypeDoc
  entry.docRelsTotal = relsByTypeDoc.reduce((s, r) => s + (r.cnt ?? 0), 0)
  entry.mergeSplit = occSplit
  entry.createdNewWindow = createdNewWindow
  if (trialStartIso) {
    entry.trialStartCutoff = trialStartIso
    entry.mergeSplitByCreatedAt = createdSplit
  }
  entry.sqlite = { localEntityCount, localRelationshipCount: localRelCount }
}

// Merge vào JSON hiện có (before/after cùng 1 file)
let merged: Record<string, unknown> = {}
if (existsSync(OUT_JSON)) {
  try { merged = JSON.parse(readFileSync(OUT_JSON, 'utf8')) as Record<string, unknown> } catch { merged = {} }
}
merged[phase] = entry
merged.lastUpdatedAt = measuredAt
writeFileSync(OUT_JSON, JSON.stringify(merged, null, 2))

console.log(`[${phase}] ${measuredAt}`)
console.log(`  totalNodes=${stats.totalNodes} · totalRelationships=${stats.totalRelationships} · avgDegree=${stats.avgDegree}`)
console.log(`  labels: ${JSON.stringify(stats.nodesByLabel)}`)
if (phase === 'after') {
  const occ = (entry.mergeSplit as Array<{ isNew: boolean; cnt: number }>)
  const created = occ.find(o => o.isNew === true)?.cnt ?? 0
  const mergedCnt = occ.find(o => o.isNew === false)?.cnt ?? 0
  console.log(`  doc: CONTAINS=${entry.docContains}, rels=${entry.docRelsTotal}, SQLite entity=${(entry.sqlite as { localEntityCount: number }).localEntityCount}, rel=${(entry.sqlite as { localRelationshipCount: number }).localRelationshipCount}`)
  console.log(`  merge split (occ): node MỚI (occ=1)=${created} · merge vào node CŨ (occ>1)=${mergedCnt}`)
  const cutoff = String(entry.trialStartCutoff || '')
  if (cutoff) {
    const cs = (entry.mergeSplitByCreatedAt as Array<{ bucket: string; cnt: number }>)
    const newInTrial = cs.find(o => o.bucket === 'newInTrial')?.cnt ?? 0
    const preExisting = cs.find(o => o.bucket === 'preExisting')?.cnt ?? 0
    console.log(`  merge split (created_at ≥ ${cutoff}): node MỚI=${newInTrial} · merge node CŨ=${preExisting}`)
  }
}
console.log(`[OK] ${OUT_JSON}`)
