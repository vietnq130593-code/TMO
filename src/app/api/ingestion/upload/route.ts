/**
 * PDF Upload + Document Management API
 *
 * POST   /api/ingestion/upload           — upload PDF file(s), save to UPLOAD_DIR, create Qdrant metadata
 * GET    /api/ingestion/upload            — list documents (paginated)
 * GET    /api/ingestion/upload?documentId=xxx — get single document
 * DELETE /api/ingestion/upload?documentId=xxx — delete document + chunks + file
 *
 * Storage:
 *   - Filesystem: UPLOAD_DIR (default /tmp/theopus-uploads) — PDF binary saved here
 *   - Qdrant theopus_documents collection — document metadata (title, domain, status)
 *   - SQLite Document table — local buffer for fast access
 *
 * Returns:
 *   - POST: { documents: DocumentRecord[], errors: [{ file, error }] }
 *   - GET:  { documents: DocumentRecord[], total, page, pageSize }
 *   - DELETE: { success: boolean }
 */

import { NextRequest, NextResponse } from 'next/server'
import { promises as fs } from 'fs'
import path from 'path'
import crypto from 'crypto'
import { qdrant, COLLECTION_DOCUMENTS, COLLECTION_CHUNKS, deleteChunksByDocument, deleteDocument } from '@/lib/qdrant'
import { db } from '@/lib/db'
import { uploadPdfToR2, deleteFromR2, r2KeyForPdf, isR2Configured, listR2Objects } from '@/lib/r2-storage'
import { sha256Hex, findExactDuplicate, exactDupResponseStatus } from '@/lib/ingestion/doc-dedup'

export const dynamic = 'force-dynamic'

const UPLOAD_DIR = process.env.UPLOAD_DIR || '/tmp/theopus-uploads'

// ==================== DOC LIST CACHE (perf — 2026-08-25) ====================
// The GET list is polled every 3s while documents are processing. Each uncached
// call hits 3 stores: R2 list (network → Cloudflare), Qdrant scroll (empty
// collection after restores), SQLite findMany. The doc LIST identity (which
// files exist) only changes on upload/delete — so the expensive parts (R2 +
// Qdrant) are cached 10s, while STATUSES are re-read from SQLite on every
// request (cheap: ~17 rows) so processing progress never looks stale.
// Bust: POST (upload) + DELETE invalidate immediately.
interface CachedDocList {
  documents: Array<Record<string, unknown>> // WITHOUT live statuses (overlaid per request)
  total: number
  expiresAt: number
}
let docListCache: CachedDocList | null = null
const DOC_LIST_CACHE_TTL_MS = 10_000

function invalidateDocListCache(): void {
  docListCache = null
}

/** Overlay fresh SQLite statuses onto the cached doc list + recompute breakdown. */
async function overlaySqliteStatuses(
  docs: Array<Record<string, unknown>>
): Promise<{ documents: Array<Record<string, unknown>>; statusBreakdown: Record<string, number> }> {
  const statusBreakdown: Record<string, number> = {}
  try {
    // P5-M2 — thêm duplicateOfId để UI gắn badge "trùng với …" (đối chiếu tiêu đề
    // gốc qua 1 query findMany riêng — ánh xạ id→title cho mọi bản trùng)
    const rows = await db.document.findMany({ select: { id: true, title: true, status: true, processingPercent: true, errorMessage: true, duplicateOfId: true } })
    const byId = new Map(rows.map(r => [r.id, r]))
    const byTitle = new Map(rows.filter(r => r.title).map(r => [r.title as string, r]))
    for (const doc of docs) {
      const row = byId.get(String(doc.id)) || byTitle.get(String(doc.title))
      if (row) {
        doc.status = row.status
        doc.processing_percent = row.processingPercent
        doc.error_message = row.errorMessage
        // P5-M2 — badge trùng lặp: duplicate_of = id gốc, duplicate_of_title =
        // tiêu đề gốc (undefined khi không phải bản trùng — UI check status='duplicate').
        // R5 (P4 #6): xoá trường cũ khi row hết duplicateOfId — chống badge stale
        // nếu tương lai có đường un-duplicate (hôm nay bất biến "không bao giờ
        // clear" đang chặn, nhưng overlay từng SET thì phải biết UN-SET đối xứng).
        if (row.duplicateOfId) {
          doc.duplicate_of = row.duplicateOfId
          const origin = byId.get(row.duplicateOfId)
          doc.duplicate_of_title = origin ? origin.title : null
        } else {
          delete doc.duplicate_of
          delete doc.duplicate_of_title
        }
      }
      const s = String(doc.status || 'uploaded')
      statusBreakdown[s] = (statusBreakdown[s] || 0) + 1
    }
  } catch {
    // DB read failed — use cached statuses as-is
    for (const doc of docs) {
      const s = String(doc.status || 'uploaded')
      statusBreakdown[s] = (statusBreakdown[s] || 0) + 1
    }
  }
  return { documents: docs, statusBreakdown }
}

// ==================== ENSURE UPLOAD DIR EXISTS ====================

async function ensureUploadDir(): Promise<void> {
  try {
    await fs.mkdir(UPLOAD_DIR, { recursive: true })
  } catch {
    // ignore — dir may already exist
  }
}

// ==================== POST — UPLOAD PDF ====================

export async function POST(request: NextRequest) {
  try {
    await ensureUploadDir()

    const formData = await request.formData()
    const files = formData.getAll('files')
    const domain = (formData.get('domain') as string) || 'mixed'

    if (!files || files.length === 0) {
      return NextResponse.json(
        { error: 'No files provided. Use field name "files" in FormData.' },
        { status: 400 }
      )
    }

    const uploadedDocs: Array<Record<string, unknown>> = []
    const errors: Array<{ file: string; error: string }> = []
    // P5-M2 (blueprint stats §P5-M2, mục #17 — DA.pdf §Duplicate Rows): bản ghi
    // exact-dup theo content-hash. Nếu MỌI file trong request đều trùng hash (không
    // có file mới nào được lưu) → trả 409 Conflict kèm existingDocumentId + tiêu
    // đề; request hỗn hợp → 200 kèm mảng duplicates cho từng file (tiền lệ per-file
    // error của route này).
    const duplicates: Array<{ file: string; existingDocumentId: string; existingTitle: string }> = []

    for (const file of files) {
      if (!(file instanceof File)) {
        errors.push({ file: 'unknown', error: 'Invalid file object' })
        continue
      }

      // Validate file type
      if (!file.name.toLowerCase().endsWith('.pdf')) {
        errors.push({ file: file.name, error: 'Only PDF files are supported' })
        continue
      }

      // Validate file size (50 MB max — generous for textbooks)
      const MAX_FILE_SIZE = 50 * 1024 * 1024
      if (file.size > MAX_FILE_SIZE) {
        errors.push({ file: file.name, error: `File too large (${(file.size / 1024 / 1024).toFixed(1)} MB). Max: 50 MB` })
        continue
      }

      try {
        // P5-M2 — exact-dup gate: sha256(bytes) TRƯỚC khi đụng đĩa/R2/Qdrant/SQLite
        // (không lưu bản mới — DA.pdf §Duplicate Rows). Lưu ý: check qua SQLite
        // Document (contentHash có index); Document xóa rồi thì hash "hết hiệu lực"
        // theo đúng nghĩa muốn — tái tải lại sau khi xóa là hợp lệ.
        const buffer = Buffer.from(await file.arrayBuffer())
        const contentHash = sha256Hex(buffer)
        const existing = await findExactDuplicate(contentHash)
        if (existing) {
          console.log(`[Upload] Exact-dup (P5-M2): ${file.name} trùng hash với "${existing.title}" (id=${existing.id.slice(0, 8)}..., status=${existing.status}) — KHÔNG lưu bản mới`)
          duplicates.push({ file: file.name, existingDocumentId: existing.id, existingTitle: existing.title })
          continue
        }

        // Generate document ID (UUID)
        const documentId = crypto.randomUUID()

        // Generate safe filename: <documentId>_<original-name>
        const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_')
        const filename = `${documentId}_${safeName}`
        const filePath = path.join(UPLOAD_DIR, filename)

        // Save PDF to filesystem
        await fs.writeFile(filePath, buffer)

        // Phase 6: Upload to Cloudflare R2 (cloud backup — survives sandbox reset)
        // Non-blocking: if R2 fails, local file is still saved, user can retry sync later
        let r2Uploaded = false
        let r2Key: string | null = null
        if (isR2Configured()) {
          try {
            const r2Result = await uploadPdfToR2(documentId, file.name, buffer)
            if (r2Result.success) {
              r2Uploaded = true
              r2Key = r2Result.key
              console.log(`[Upload] R2 backup saved: ${r2Key} (${r2Result.size} bytes)`)
            } else {
              console.warn('[Upload] R2 backup failed (non-critical):', r2Result.error)
            }
          } catch (r2Err) {
            console.warn('[Upload] R2 upload error (non-critical):', r2Err instanceof Error ? r2Err.message : String(r2Err))
          }
        }

        // Create Qdrant document metadata (payload-only, no vector)
        const now = new Date().toISOString()
        const documentPayload = {
          title: file.name,
          file_path: filePath,
          // Phase 6: store R2 key so we can restore from cloud if local file is lost
          r2_key: r2Key,
          r2_uploaded: r2Uploaded,
          domain,
          status: 'uploaded',
          error_message: null,
          page_count: null,
          processing_steps: [],
          processing_percent: 0,
          created_at: now,
          updated_at: now,
        }

        // Use documentId as the Qdrant point ID (UUID)
        try {
          await qdrant.upsert(COLLECTION_DOCUMENTS, {
            wait: true,
            points: [
              {
                id: documentId,
                vector: [0.1], // theopus_documents uses size=1 placeholder vector (payload-only)
                payload: documentPayload,
              },
            ],
          })
        } catch (qdrantErr) {
          // If Qdrant fails, still keep the file on disk so user can retry
          console.error('[Upload] Qdrant upsert failed:', qdrantErr instanceof Error ? qdrantErr.message : String(qdrantErr))
          errors.push({
            file: file.name,
            error: `File saved to disk but Qdrant metadata failed: ${qdrantErr instanceof Error ? qdrantErr.message : 'unknown'}`,
          })
          continue
        }

        // Also create SQLite Document record (buffer for fast local access)
        try {
          await db.document.create({
            data: {
              id: documentId,
              title: file.name,
              filePath: filePath,
              domain,
              status: 'uploaded',
              pageCount: null,
              // P5-M2 — ghi hash để lần upload sau trúng cổng 409
              contentHash,
            },
          })
        } catch (dbErr) {
          // Non-critical — Qdrant is source of truth for documents
          console.warn('[Upload] SQLite Document create failed (non-critical):', dbErr instanceof Error ? dbErr.message : String(dbErr))
        }

        uploadedDocs.push({
          id: documentId,
          title: file.name,
          file_path: filePath,
          domain,
          page_count: null,
          status: 'uploaded',
          error_message: null,
          processing_steps: [],
          processing_percent: 0,
          created_at: now,
          updated_at: now,
        })

        console.log(`[Upload] Saved: ${file.name} → ${filePath} (id=${documentId})`)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error(`[Upload] Failed to save ${file.name}:`, msg)
        errors.push({ file: file.name, error: msg })
      }
    }

    // Upload changed the doc list — invalidate the GET cache so the new file
    // appears immediately (perf 2026-08-25).
    invalidateDocListCache()

    // P5-M2 — mọi file đều exact-dup (không file nào được lưu) → 409 Conflict
    // kèm chi tiết; hỗn hợp → 200 như cũ + mảng duplicates. (Quyết định qua
    // exactDupResponseStatus — test được ở lib.)
    if (exactDupResponseStatus(duplicates.length, uploadedDocs.length) === 409) {
      // FB-Đợt7-R4 (A7): kèm mảng errors khi có — request hỗn hợp (file trùng
      // + file lỗi) bản cũ chỉ trả totalErrors số học, client API trực tiếp
      // không biết file kia lỗi gì (body 200 có errors, body 409 thì không).
      return NextResponse.json(
        {
          error: `Duplicate upload: ${duplicates.map(d => d.file).join(', ')} đã tồn tại (trùng nội dung, sha256)`,
          duplicates,
          documents: [],
          totalUploaded: 0,
          ...(errors.length > 0 ? { errors } : {}),
          totalErrors: errors.length,
          totalDuplicates: duplicates.length,
        },
        { status: 409 }
      )
    }

    return NextResponse.json({
      documents: uploadedDocs,
      errors: errors.length > 0 ? errors : undefined,
      duplicates: duplicates.length > 0 ? duplicates : undefined,
      totalUploaded: uploadedDocs.length,
      totalErrors: errors.length,
      totalDuplicates: duplicates.length,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[Upload] POST error:', msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

// ==================== GET — LIST DOCUMENTS ====================

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const documentId = searchParams.get('documentId')
    const page = parseInt(searchParams.get('page') || '1', 10)
    const pageSize = parseInt(searchParams.get('pageSize') || '20', 10)
    const lite = searchParams.get('lite') === 'true'

    // Single document lookup
    if (documentId) {
      try {
        const points = await qdrant.retrieve(COLLECTION_DOCUMENTS, {
          ids: [documentId],
          with_payload: true,
          with_vector: false,
        })
        if (points.length === 0) {
          return NextResponse.json({ error: 'Document not found' }, { status: 404 })
        }
        const payload = points[0].payload as Record<string, unknown>
        return NextResponse.json({
          document: {
            id: points[0].id,
            ...payload,
          },
        })
      } catch (err) {
        return NextResponse.json(
          { error: `Failed to fetch document: ${err instanceof Error ? err.message : 'unknown'}` },
          { status: 500 }
        )
      }
    }

    // List documents — R2 is the PRIMARY source.
    // Strategy: list all R2 PDFs (canonical), then enrich with SQLite Document
    // rows (AUTHORITATIVE status — the extraction pipeline writes here and it
    // survives Qdrant metadata loss, e.g. after a chunks-only R2 restore) +
    // Qdrant metadata where available. Docs present in SQLite but missing from
    // R2 are appended so the list never hides processed documents.
    // Fallback: if R2 not configured, fall back to Qdrant-only scroll (legacy).
    try {
      const limit = Math.min(pageSize, 100) // cap at 100 per page
      const offset = (page - 1) * limit

      // --- Load SQLite Document rows (authoritative statuses) ---
      // Doc-count fix (2026-08-25): the UI's "Hoàn thành" tile reads
      // statusBreakdown from this endpoint, but the response never included
      // it → processedCount always 0 ("0/N" tile). SQLite is now the primary
      // status source; Qdrant metadata (often lost on restore) is fallback.
      const sqliteDocs = new Map<string, {
        title: string
        status: string
        domain: string
        pageCount: number | null
        processingPercent: number
        errorMessage: string | null
        filePath: string
        createdAt: Date
        updatedAt: Date
        // FB-Đợt7-R4 (A6): duplicateOfId cho badge "trùng với …" trên đường
        // FRESH (không qua cache) — trước đây chỉ đường cache 10s (overlay)
        // phát được 2 trường duplicate_of → badge nhấp nháy mỗi lần cache hết hạn
        duplicateOfId: string | null
      }>()
      const sqliteByTitle = new Map<string, string>() // title → id (for R2 filename matching)
      try {
        const rows = await db.document.findMany()
        for (const r of rows) {
          sqliteDocs.set(r.id, {
            title: r.title,
            status: r.status,
            domain: r.domain,
            pageCount: r.pageCount,
            processingPercent: r.processingPercent,
            errorMessage: r.errorMessage,
            filePath: r.filePath,
            createdAt: r.createdAt,
            updatedAt: r.updatedAt,
            duplicateOfId: r.duplicateOfId,
          })
          if (r.title) sqliteByTitle.set(r.title, r.id)
        }
      } catch (dbErr) {
        console.warn('[Upload] SQLite document load failed (non-fatal):', dbErr instanceof Error ? dbErr.message : String(dbErr))
      }

      // --- PRIMARY: list from R2 ---
      if (isR2Configured()) {
        // Cache check (perf 2026-08-25): the 3s processing poll hits this route
        // repeatedly; serve the 10s-TTL cached LIST (R2+Qdrant parts) when fresh,
        // with live SQLite statuses overlaid so progress never looks stale.
        if (docListCache && Date.now() < docListCache.expiresAt) {
          const fresh = await overlaySqliteStatuses([...docListCache.documents])
          const hasMore = docListCache.total > offset + limit
          return NextResponse.json({
            documents: fresh.documents.slice(offset, offset + limit),
            total: docListCache.total,
            page,
            pageSize: limit,
            hasMore,
            lite,
            source: 'r2-cache',
            statusBreakdown: fresh.statusBreakdown,
          })
        }
        const r2List = await listR2Objects('pdfs/', 500)
        if (!r2List.success) {
          console.error('[Upload] R2 list failed:', r2List.error)
          // Fall through to Qdrant fallback below
        } else {
          // Build Qdrant metadata map (id → payload) for enrichment
          const qdrantMeta = new Map<string, Record<string, unknown>>()
          try {
            // next_page_offset có thể là Record (qdrant client >=1.19) — khớp kiểu client
            let scrollOffset: string | number | Record<string, unknown> | null | undefined = undefined
            do {
              const result = await qdrant.scroll(COLLECTION_DOCUMENTS, {
                limit: 100,
                offset: scrollOffset,
                with_payload: true,
                with_vector: false,
              })
              for (const p of result.points) {
                qdrantMeta.set(String(p.id), (p.payload as Record<string, unknown>) || {})
              }
              scrollOffset = result.next_page_offset
            } while (scrollOffset)
          } catch (qErr) {
            console.warn('[Upload] Qdrant enrichment scroll failed (non-fatal):', qErr instanceof Error ? qErr.message : String(qErr))
            // Continue — R2 docs still show, just without enrichment
          }

          // Parse docId from R2 key: "pdfs/<docId>_<filename>"
          // FIX (perf): was O(N²) — for each R2 object it linearly scanned ALL Qdrant
          // metadata entries ([...qdrantMeta.values()].find(...)). With 500 PDFs that's
          // up to 250k comparisons per request, and this route is polled every 3-5s
          // during processing. A key→meta lookup Map makes it O(N).
          const qdrantMetaByR2Key = new Map<string, Record<string, unknown>>()
          for (const m of qdrantMeta.values()) {
            if (m.r2_key) qdrantMetaByR2Key.set(String(m.r2_key), m)
          }
          const matchedSqliteIds = new Set<string>()
          const allDocs: Array<Record<string, unknown>> = r2List.objects.map(obj => {
            const basename = obj.key.split('/').pop() || obj.key
            const underscoreIdx = basename.indexOf('_')
            const docId = underscoreIdx > 0 ? basename.substring(0, underscoreIdx) : basename.replace(/\.pdf$/i, '')
            const filename = underscoreIdx > 0 ? basename.substring(underscoreIdx + 1) : basename
            const r2Key = obj.key
            // Enrichment precedence: SQLite (authoritative) → Qdrant → defaults.
            // Try id match first; fall back to title match (R2 filename → SQLite title).
            let matchedSqliteId: string | undefined
            if (sqliteDocs.has(docId)) {
              matchedSqliteId = docId
            } else if (sqliteByTitle.has(filename)) {
              matchedSqliteId = sqliteByTitle.get(filename)!
            }
            const sqlDoc = matchedSqliteId ? sqliteDocs.get(matchedSqliteId) : undefined
            if (matchedSqliteId) matchedSqliteIds.add(matchedSqliteId)
            const qMeta = qdrantMeta.get(docId) || qdrantMetaByR2Key.get(r2Key) || {}

            return {
              id: docId,
              title: sqlDoc?.title || (qMeta.title as string) || filename.replace(/\.pdf$/i, ''),
              file_path: sqlDoc?.filePath || (qMeta.file_path as string) || `${UPLOAD_DIR}/${basename}`,
              domain: sqlDoc?.domain || (qMeta.domain as string) || 'mixed',
              page_count: sqlDoc?.pageCount ?? (qMeta.page_count as number | undefined) ?? null,
              status: sqlDoc?.status || (qMeta.status as string) || 'uploaded',
              error_message: sqlDoc?.errorMessage ?? (qMeta.error_message as string | undefined) ?? null,
              processing_steps: (qMeta.processing_steps as unknown[]) || [],
              processing_percent: sqlDoc?.processingPercent ?? (qMeta.processing_percent as number | undefined) ?? 0,
              created_at: sqlDoc?.createdAt?.toISOString() || (qMeta.created_at as string) || obj.lastModified.toISOString(),
              updated_at: sqlDoc?.updatedAt?.toISOString() || (qMeta.updated_at as string) || obj.lastModified.toISOString(),
              r2_key: r2Key as string | null,
              r2_size: (obj.size ?? null) as number | null,
              // FB-Đợt7-R4 (A6): phát duplicate_of trên đường fresh — cùng
              // dạng trường với overlaySqliteStatuses (đường cache) để UI badge
              // không nhấp nháy theo hạn cache
              ...(sqlDoc?.duplicateOfId ? {
                duplicate_of: sqlDoc.duplicateOfId,
                duplicate_of_title: sqliteDocs.get(sqlDoc.duplicateOfId)?.title ?? null,
              } : {}),
              // chunk_coverage intentionally omitted (lite mode)
            }
          })

          // Append SQLite docs that have NO R2 object (processed locally but
          // R2 upload failed / was skipped) — otherwise completed work is invisible.
          for (const [id, d] of sqliteDocs) {
            if (matchedSqliteIds.has(id)) continue
            allDocs.push({
              id,
              title: d.title,
              file_path: d.filePath,
              domain: d.domain,
              page_count: d.pageCount,
              status: d.status,
              error_message: d.errorMessage,
              processing_steps: [],
              processing_percent: d.processingPercent,
              created_at: d.createdAt.toISOString(),
              updated_at: d.updatedAt.toISOString(),
              r2_key: null as string | null,
              r2_size: null as number | null,
              // FB-Đợt7-R4 (A6): đường fresh — cùng trường duplicate_of như 2 đường kia
              ...(d.duplicateOfId ? {
                duplicate_of: d.duplicateOfId,
                duplicate_of_title: sqliteDocs.get(d.duplicateOfId)?.title ?? null,
              } : {}),
            })
          }

          // Sort newest-first (R2 docs use lastModified; SQLite-appended use createdAt)
          allDocs.sort((a, b) => new Date(b.created_at as string).getTime() - new Date(a.created_at as string).getTime())

          // Status breakdown across ALL docs (not just the current page) —
          // the UI's "Hoàn thành N" line + the Tài liệu tile (completed/total)
          // read this. Doc-count fix 2026-08-25.
          const statusBreakdown: Record<string, number> = {}
          for (const doc of allDocs) {
            const s = String(doc.status || 'uploaded')
            statusBreakdown[s] = (statusBreakdown[s] || 0) + 1
          }

          // Cache the full list (TTL) — the 3s processing poll then serves from
          // memory (R2+Qdrant parts) with fresh SQLite statuses overlaid.
          docListCache = {
            documents: [...allDocs] as Array<Record<string, unknown>>,
            total: allDocs.length,
            expiresAt: Date.now() + DOC_LIST_CACHE_TTL_MS,
          }

          // Pagination
          const hasMore = allDocs.length > offset + limit
          const documents = allDocs.slice(offset, offset + limit)

          return NextResponse.json({
            documents,
            total: allDocs.length,
            page,
            pageSize: limit,
            hasMore,
            lite,
            source: 'r2',
            statusBreakdown,
          })
        }
      }

      // --- FALLBACK: Qdrant-only scroll (when R2 not configured) ---
      const scrollResult = await qdrant.scroll(COLLECTION_DOCUMENTS, {
        limit: limit + 1, // fetch 1 extra to know if there's a next page
        offset: offset > 0 ? offset : undefined,
        with_payload: true,
        with_vector: false,
      })

      const hasMore = scrollResult.points.length > limit
      const points = scrollResult.points.slice(0, limit)

      const documents = points.map(p => ({
        id: p.id,
        ...(p.payload as Record<string, unknown>),
      }))

      return NextResponse.json({
        documents,
        total: documents.length, // approximate — Qdrant scroll doesn't return total
        page,
        pageSize: limit,
        hasMore,
        lite,
        source: 'qdrant',
      })
    } catch (err) {
      console.error('[Upload] GET list error:', err instanceof Error ? err.message : String(err))
      return NextResponse.json(
        { error: `Failed to list documents: ${err instanceof Error ? err.message : 'unknown'}` },
        { status: 500 }
      )
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

// ==================== DELETE — REMOVE DOCUMENT ====================

export async function DELETE(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const documentId = searchParams.get('documentId')

    if (!documentId) {
      return NextResponse.json({ error: 'documentId parameter is required' }, { status: 400 })
    }

    let deletedFromFs = false
    let deletedFromQdrant = false
    let deletedFromSqlite = false
    let deletedFromR2 = false
    let filePath: string | null = null
    let r2Key: string | null = null

    // Step 1: Get document metadata (need file_path + r2_key before deleting)
    try {
      const points = await qdrant.retrieve(COLLECTION_DOCUMENTS, {
        ids: [documentId],
        with_payload: true,
        with_vector: false,
      })
      if (points.length > 0) {
        filePath = (points[0].payload?.file_path as string) || null
        r2Key = (points[0].payload?.r2_key as string) || null
      }
    } catch {
      // proceed anyway
    }

    // Step 2: Delete file from filesystem
    if (filePath) {
      try {
        await fs.unlink(filePath)
        deletedFromFs = true
        console.log(`[Upload] Deleted file: ${filePath}`)
      } catch (err) {
        // File may already be gone — non-critical
        console.warn(`[Upload] File delete failed (non-critical):`, err instanceof Error ? err.message : String(err))
      }
    }

    // Step 2b: Delete from R2 (cloud backup)
    if (r2Key) {
      try {
        const r2Result = await deleteFromR2(r2Key)
        deletedFromR2 = r2Result.success
        if (deletedFromR2) {
          console.log(`[Upload] Deleted R2 backup: ${r2Key}`)
        } else {
          console.warn(`[Upload] R2 delete failed (non-critical):`, r2Result.error)
        }
      } catch (err) {
        console.warn(`[Upload] R2 delete error (non-critical):`, err instanceof Error ? err.message : String(err))
      }
    }

    // Step 3: Delete chunks from Qdrant
    try {
      await deleteChunksByDocument(documentId)
      console.log(`[Upload] Deleted chunks for document ${documentId}`)
    } catch (err) {
      console.warn(`[Upload] Chunks delete failed:`, err instanceof Error ? err.message : String(err))
    }

    // Step 4: Delete document metadata from Qdrant
    try {
      await deleteDocument(documentId)
      deletedFromQdrant = true
      console.log(`[Upload] Deleted Qdrant document ${documentId}`)
    } catch (err) {
      console.warn(`[Upload] Qdrant document delete failed:`, err instanceof Error ? err.message : String(err))
    }

    // Step 5: Delete SQLite Document record (if exists)
    try {
      await db.document.deleteMany({ where: { id: documentId } })
      deletedFromSqlite = true
    } catch {
      // non-critical
    }

    // FIX (ghost entities): also clean up the knowledge graph + SQLite entity
    // buffers for this document. Previously deletion left: (a) the Neo4j Document
    // node + its CONTAINS edges + doc-specific relationships (the purpose-built
    // deleteDocumentGraph was dead code with zero callers), and (b) all
    // LocalEntity/LocalRelationship/LocalResolvedEntity rows in SQLite — which
    // then kept being re-pushed to Supabase backups. Deleted documents kept
    // matching graph queries. deleteDocumentGraph is cross-document safe (only
    // removes orphaned global nodes not referenced by other docs).
    let deletedFromNeo4j = false
    let graphCleanup = { nodesDeleted: 0, relsDeleted: 0 }
    try {
      const { deleteDocumentGraph } = await import('@/lib/neo4j')
      graphCleanup = await deleteDocumentGraph(documentId)
      deletedFromNeo4j = graphCleanup.nodesDeleted > 0 || graphCleanup.relsDeleted > 0
      console.log(`[Upload] Neo4j graph cleanup for ${documentId.slice(0, 8)}...: ${graphCleanup.nodesDeleted} nodes, ${graphCleanup.relsDeleted} rels`)
    } catch (err) {
      console.warn(`[Upload] Neo4j cleanup failed (non-critical):`, err instanceof Error ? err.message : String(err))
    }

    // SQLite entity buffers for this document
    let deletedSqliteEntities = 0
    try {
      const delRels = await db.localRelationship.deleteMany({ where: { documentId } })
      const delEnts = await db.localEntity.deleteMany({ where: { documentId } })
      const delResolved = await db.localResolvedEntity.deleteMany({ where: { documentId } })
      deletedSqliteEntities = delRels.count + delEnts.count + delResolved.count
      if (deletedSqliteEntities > 0) {
        console.log(`[Upload] SQLite buffer cleanup for ${documentId.slice(0, 8)}...: ${deletedSqliteEntities} rows`)
      }
    } catch (err) {
      console.warn(`[Upload] SQLite entity cleanup failed (non-critical):`, err instanceof Error ? err.message : String(err))
    }

    return NextResponse.json({
      success: deletedFromQdrant || deletedFromSqlite,
      deletedFromFs,
      deletedFromQdrant,
      deletedFromSqlite,
      deletedFromR2,
      deletedFromNeo4j,
      graphCleanup,
      deletedSqliteEntities,
      documentId,
      // Deletion changed the doc list — invalidate the GET cache (perf 2026-08-25)
      cacheInvalidated: (invalidateDocListCache(), true),
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[Upload] DELETE error:', msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
