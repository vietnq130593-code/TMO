/**
 * Document State Reconciliation API
 *
 * POST /api/ingestion/reconcile          — execute reconciliation (writes)
 * GET  /api/ingestion/reconcile          — dry-run preview (no writes)
 * GET  /api/ingestion/reconcile?execute=1 — same as POST (convenience for browser)
 *
 * PROBLEM THIS SOLVES
 * --------------------
 * The app stores document processing state across 4 systems, but they are NOT
 * equally durable:
 *   - Cloudflare R2 ........ PDF files (cloud, survives resets)
 *   - Neo4j Aura ........... Document nodes + entities + relationships (cloud)
 *   - Qdrant ............... document metadata + chunk embeddings (LOCAL — wiped on fresh setup)
 *   - SQLite/Prisma ........ Document rows + LocalEntity buffer (LOCAL — wiped on fresh setup)
 *   - Supabase ............. backs up chat/agent tables only (NOT Document/LocalEntity)
 *
 * The document list (GET /api/ingestion/upload) reads from R2 (primary) +
 * Qdrant (enrichment). When Qdrant is empty, every R2 PDF shows with the
 * synthesized default status='uploaded' (chưa xử lý) — even if Neo4j still
 * holds the full extraction result from a prior session.
 *
 * This endpoint repairs that fragmentation by rebuilding the LOCAL stores
 * (SQLite Document rows + Qdrant document metadata points) FROM the durable
 * cloud stores (R2 + Neo4j). No re-extraction / LLM calls — it just relinks
 * the existing state so the UI shows the correct processing status.
 *
 * WHAT IT DOES (per document found in R2):
 *   1. Parse docId from the R2 key (pdfs/<docId>_<filename>).
 *   2. Look up a matching Document node in Neo4j (by id).
 *   3. If found: upsert a Qdrant document metadata point + a SQLite Document
 *      row, with status/percent derived from Neo4j. Steps 1–6 marked
 *      completed (download→neo4j). Step 7 (embeddings) is marked pending when
 *      Qdrant has no chunks for that doc (embeddings were lost on reset and
 *      need re-running via the normal Process button — but the EXPENSIVE LLM
 *      extraction is already done and will NOT be repeated thanks to MERGE).
 *   4. If not found: leave as 'uploaded' (genuinely never processed).
 *
 * Idempotent: safe to run multiple times (uses upsert / MERGE semantics).
 */
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { qdrant, COLLECTION_DOCUMENTS, COLLECTION_CHUNKS, upsertDocument } from '@/lib/qdrant'
import type { DocumentPayload } from '@/lib/qdrant'
import { listR2Objects, isR2Configured } from '@/lib/r2-storage'
import { getProcessedDocumentsFromNeo4j } from '@/lib/neo4j'

export const dynamic = 'force-dynamic'

const UPLOAD_DIR = process.env.UPLOAD_DIR || '/tmp/theopus-uploads'

/** The 7 pipeline steps, in order. Must match process/route.ts PIPELINE_STEPS. */
const PIPELINE_STEPS = [
  { name: 'download', label: 'Tải PDF', weight: 5 },
  { name: 'parse', label: 'Phân tích PDF', weight: 10 },
  { name: 'chunk', label: 'Chia chunks', weight: 5 },
  { name: 'extract', label: 'Trích xuất entities', weight: 50 },
  { name: 'resolve', label: 'Hợp nhất entities', weight: 10 },
  { name: 'neo4j', label: 'Ghi Neo4j', weight: 10 },
  { name: 'embeddings', label: 'Tạo embeddings', weight: 10 },
] as const

type StepStatus = 'pending' | 'running' | 'completed' | 'error'

interface ProcessingStepRecord {
  name: string
  label: string
  status: StepStatus
  startedAt: string | null
  completedAt: string | null
  detail: string | null
}

/** Build the processing_steps array, marking steps 1..doneCount as completed. */
function buildSteps(doneCount: number, embeddingsDone: boolean): ProcessingStepRecord[] {
  return PIPELINE_STEPS.map((s, i) => {
    const isEmbeddings = s.name === 'embeddings'
    const completed = i < doneCount || (isEmbeddings && embeddingsDone)
    return {
      name: s.name,
      label: s.label,
      status: completed ? ('completed' as StepStatus) : ('pending' as StepStatus),
      startedAt: completed ? 'reconciled' : null,
      completedAt: completed ? 'reconciled' : null,
      detail: completed
        ? isEmbeddings
          ? 'Verified present in Qdrant'
          : 'Restored from Neo4j during reconcile'
        : null,
    }
  })
}

/** Sum the weights of all completed steps → processing_percent. */
function percentFor(steps: ProcessingStepRecord[]): number {
  let sum = 0
  for (const step of steps) {
    if (step.status === 'completed') {
      sum += PIPELINE_STEPS.find((s) => s.name === step.name)?.weight ?? 0
    }
  }
  return sum
}

/** Build a map docId → chunkCount by scrolling the Qdrant chunks collection. */
async function buildChunkCountMap(): Promise<Map<string, number>> {
  const map = new Map<string, number>()
  try {
    // next_page_offset của qdrant client ≥1.19 có thể là Record (extended format) —
    // kiểu khai báo phải khớp client, chỉ dùng lại làm offset cho scroll kế tiếp
    let scrollOffset: string | number | Record<string, unknown> | null | undefined = undefined
    do {
      const result = await qdrant.scroll(COLLECTION_CHUNKS, {
        limit: 256,
        offset: scrollOffset,
        with_payload: true,
        with_vector: false,
      })
      for (const p of result.points) {
        const payload = (p.payload as Record<string, unknown>) || {}
        const docId = String(payload.document_id ?? payload.documentId ?? '')
        if (docId) map.set(docId, (map.get(docId) ?? 0) + 1)
      }
      scrollOffset = result.next_page_offset
    } while (scrollOffset)
  } catch (err) {
    console.warn(
      '[Reconcile] Qdrant chunks scroll failed (non-fatal):',
      err instanceof Error ? err.message : String(err)
    )
  }
  return map
}

interface ReconcileReport {
  r2Documents: number
  neo4jDocuments: number
  matched: number
  reconciled: number
  alreadyUpToDate: number
  notInNeo4j: number
  neo4jOrphans: number
  details: Array<{
    docId: string
    title: string
    r2Key: string
    action: 'reconciled' | 'up-to-date' | 'no-neo4j-match'
    status: string
    processingPercent: number
    chunkCount: number
  }>
  neo4jOrphanIds: string[]
}

/** Core reconciliation. Returns a report. `execute`=false → read-only preview. */
async function runReconcile(execute: boolean): Promise<ReconcileReport> {
  // 1. R2 PDF listing
  const r2List = isR2Configured()
    ? await listR2Objects('pdfs/', 500)
    : { success: false as const, objects: [], error: 'R2 not configured' }

  const r2Docs = r2List.success ? r2List.objects : []

  // 2. Neo4j processed-document map (keyed by PDF UUID, from relationship
  //    documentId properties — the reliable signal that a PDF was extracted).
  const processedDocs = await getProcessedDocumentsFromNeo4j()
  const processedIds = new Set(Object.keys(processedDocs))

  // 3. Qdrant chunk counts (detect whether embeddings survived)
  const chunkCounts = await buildChunkCountMap()

  const details: ReconcileReport['details'] = []
  const matchedIds = new Set<string>()
  let reconciled = 0
  let alreadyUpToDate = 0
  let notInNeo4j = 0

  for (const obj of r2Docs) {
    const basename = obj.key.split('/').pop() || obj.key
    const underscoreIdx = basename.indexOf('_')
    const docId =
      underscoreIdx > 0 ? basename.substring(0, underscoreIdx) : basename.replace(/\.pdf$/i, '')
    const filename =
      underscoreIdx > 0 ? basename.substring(underscoreIdx + 1) : basename
    const r2Key = obj.key

    const proc = processedDocs[docId]
    if (!proc) {
      notInNeo4j += 1
      details.push({
        docId,
        title: filename.replace(/\.pdf$/i, ''),
        r2Key,
        action: 'no-neo4j-match',
        status: 'uploaded',
        processingPercent: 0,
        chunkCount: chunkCounts.get(docId) ?? 0,
      })
      continue
    }

    matchedIds.add(docId)

    const chunkCount = chunkCounts.get(docId) ?? 0
    const embeddingsDone = chunkCount > 0
    // Steps 1–6 completed (download, parse, chunk, extract, resolve, neo4j).
    const steps = buildSteps(6, embeddingsDone)
    const processingPercent = percentFor(steps)
    // 'indexed' only when embeddings survive; else 'extracted' (extraction
    // done, embeddings pending re-run). Both are "processed" in the UI sense.
    const status: DocumentPayload['status'] = embeddingsDone ? 'indexed' : 'extracted'

    // Check if Qdrant already has an up-to-date metadata point for this doc.
    let existing: DocumentPayload | null = null
    try {
      const res = await qdrant.retrieve(COLLECTION_DOCUMENTS, {
        ids: [docId],
        with_payload: true,
      })
      if (res.length > 0) existing = res[0].payload as unknown as DocumentPayload
    } catch {
      // ignore — treat as missing
    }

    const upToDate =
      existing != null &&
      existing.status === status &&
      (existing.processing_percent ?? 0) >= processingPercent

    if (upToDate) {
      alreadyUpToDate += 1
      details.push({
        docId,
        title: existing!.title || filename.replace(/\.pdf$/i, ''),
        r2Key,
        action: 'up-to-date',
        status: existing!.status,
        processingPercent: existing!.processing_percent ?? 0,
        chunkCount,
      })
      continue
    }

    if (!execute) {
      reconciled += 1
      details.push({
        docId,
        title: filename.replace(/\.pdf$/i, ''),
        r2Key,
        action: 'reconciled',
        status,
        processingPercent,
        chunkCount,
      })
      continue
    }

    // Build payload and write to Qdrant + SQLite.
    // createdAt = R2 upload time; updatedAt = NOW (so autoRecoverStuckDocs
    // doesn't immediately flag the doc as stale after a reconcile).
    const createdAt = obj.lastModified.toISOString()
    const updatedAt = new Date().toISOString()
    const payload: DocumentPayload = {
      title: filename.replace(/\.pdf$/i, ''),
      file_path: `${UPLOAD_DIR}/${basename}`,
      domain: 'mixed',
      page_count: undefined,
      status,
      error_message: undefined,
      processing_steps: steps,
      processing_percent: processingPercent,
      created_at: createdAt,
      updated_at: updatedAt,
    }

    // Qdrant document metadata
    await upsertDocument(docId, payload)

    // SQLite Document row (upsert). processingSteps is a TEXT column storing
    // JSON-stringified steps (matches existing process/route.ts convention).
    try {
      await db.document.upsert({
        where: { id: docId },
        create: {
          id: docId,
          title: payload.title,
          filePath: payload.file_path ?? '',
          domain: payload.domain,
          pageCount: payload.page_count ?? null,
          status: payload.status,
          errorMessage: null,
          userPaused: false,
          processingSteps: JSON.stringify(steps),
          processingPercent: processingPercent,
          createdAt: new Date(createdAt),
          updatedAt: new Date(updatedAt),
        },
        update: {
          title: payload.title,
          filePath: payload.file_path ?? '',
          domain: payload.domain,
          pageCount: payload.page_count ?? null,
          status: payload.status,
          processingSteps: JSON.stringify(steps),
          processingPercent: processingPercent,
          updatedAt: new Date(),
        },
      })
    } catch (dbErr) {
      console.error(
        `[Reconcile] SQLite upsert failed for ${docId}:`,
        dbErr instanceof Error ? dbErr.message : String(dbErr)
      )
    }

    reconciled += 1
    details.push({
      docId,
      title: payload.title,
      r2Key,
      action: 'reconciled',
      status,
      processingPercent,
      chunkCount,
    })
  }

  // Processed documents in Neo4j with NO matching R2 PDF (orphan — PDF removed).
  const neo4jOrphanIds = [...processedIds].filter((id) => !matchedIds.has(id))

  return {
    r2Documents: r2Docs.length,
    neo4jDocuments: processedIds.size,
    matched: matchedIds.size,
    reconciled,
    alreadyUpToDate,
    notInNeo4j,
    neo4jOrphans: neo4jOrphanIds.length,
    details,
    neo4jOrphanIds: neo4jOrphanIds.slice(0, 50),
  }
}

export async function GET(req: NextRequest) {
  const execute = req.nextUrl.searchParams.get('execute') === '1'
  try {
    const report = await runReconcile(execute)
    return NextResponse.json({ executed: execute, ...report })
  } catch (err) {
    console.error(
      '[Reconcile] GET error:',
      err instanceof Error ? err.message : String(err)
    )
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    )
  }
}

export async function POST(_req: NextRequest) {
  try {
    const report = await runReconcile(true)
    return NextResponse.json({ executed: true, ...report })
  } catch (err) {
    console.error(
      '[Reconcile] POST error:',
      err instanceof Error ? err.message : String(err)
    )
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    )
  }
}
