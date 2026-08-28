/**
 * Storage Sync API — restore PDFs from R2 to local after sandbox reset
 *
 * POST /api/storage/sync           — restore all missing local PDFs from R2
 * POST /api/storage/sync?doc=xxx   — restore a specific document by Qdrant ID
 *
 * Use case: sandbox reset cleared /tmp/theopus-uploads/. This endpoint pulls
 * all PDFs back from R2 cloud backup so user can re-process them.
 *
 * Returns:
 *   { restored: number, skipped: number, errors: string[], durationMs: number }
 */

import { NextRequest, NextResponse } from 'next/server'
import { promises as fs } from 'fs'
import path from 'path'
import { qdrant, COLLECTION_DOCUMENTS } from '@/lib/qdrant'
import { downloadFileFromR2, isR2Configured, listR2Objects } from '@/lib/r2-storage'

export const dynamic = 'force-dynamic'

const UPLOAD_DIR = process.env.UPLOAD_DIR || '/tmp/theopus-uploads'

// ==================== POST — RESTORE FROM R2 ====================

export async function POST(request: NextRequest) {
  try {
    if (!isR2Configured()) {
      return NextResponse.json(
        { error: 'R2 is not configured. Set R2_ACCESS_KEY_ID + R2_SECRET_ACCESS_KEY in .env' },
        { status: 503 }
      )
    }

    const { searchParams } = new URL(request.url)
    const specificDocId = searchParams.get('doc')
    const startTime = Date.now()

    // Ensure upload dir exists
    await fs.mkdir(UPLOAD_DIR, { recursive: true })

    let restored = 0
    let skipped = 0
    const errors: string[] = []

    if (specificDocId) {
      // Restore a single document by Qdrant ID
      console.log(`[Sync] Restoring single document: ${specificDocId}`)
      const result = await restoreSingleDocument(specificDocId)
      if (result.restored) restored++
      else if (result.skipped) skipped++
      if (result.error) errors.push(result.error)
    } else {
      // Restore all — list R2 objects + restore each
      console.log('[Sync] Restoring all documents from R2...')
      const r2List = await listR2Objects('pdfs/', 500)
      if (!r2List.success) {
        return NextResponse.json(
          { error: `R2 list failed: ${r2List.error}` },
          { status: 500 }
        )
      }

      console.log(`[Sync] Found ${r2List.objects.length} PDFs in R2`)

      // Also fetch Qdrant documents to get mapping (r2_key → local file_path)
      const qdrantDocs = await fetchAllQdrantDocuments()
      const r2KeyToQdrant = new Map<string, { docId: string; filePath: string; title: string }>()
      for (const doc of qdrantDocs) {
        const r2Key = (doc.payload?.r2_key as string) || null
        if (r2Key) {
          r2KeyToQdrant.set(r2Key, {
            docId: String(doc.id),
            filePath: (doc.payload?.file_path as string) || '',
            title: (doc.payload?.title as string) || 'unknown',
          })
        }
      }

      for (const r2Obj of r2List.objects) {
        const mapping = r2KeyToQdrant.get(r2Obj.key)
        if (!mapping) {
          console.warn(`[Sync] No Qdrant mapping for R2 key: ${r2Obj.key} — skipping`)
          skipped++
          continue
        }

        // Check if local file already exists
        if (mapping.filePath) {
          try {
            await fs.access(mapping.filePath)
            // File exists locally — skip
            skipped++
            continue
          } catch {
            // File missing — need to restore
          }
        }

        const result = await restoreSingleDocument(mapping.docId)
        if (result.restored) restored++
        else if (result.skipped) skipped++
        if (result.error) errors.push(result.error)
      }
    }

    const durationMs = Date.now() - startTime
    console.log(`[Sync] Complete: restored=${restored}, skipped=${skipped}, errors=${errors.length} (${durationMs}ms)`)

    return NextResponse.json({
      success: true,
      restored,
      skipped,
      errors: errors.length > 0 ? errors : undefined,
      durationMs,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[Sync] POST error:', msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

// ==================== GET — SYNC STATUS ====================

export async function GET(request: NextRequest) {
  try {
    if (!isR2Configured()) {
      return NextResponse.json({
        configured: false,
        message: 'R2 not configured',
      })
    }

    // List R2 objects + local files
    const r2List = await listR2Objects('pdfs/', 500)
    const localFiles = await listLocalFiles()

    const r2Keys = new Set(r2List.success ? r2List.objects.map(o => o.key) : [])
    const localPaths = new Set(localFiles)

    // Find missing local files (have R2 backup but no local)
    const missingLocal = r2List.success
      ? r2List.objects.filter(o => {
          // Extract filename from R2 key: "pdfs/<docId>_<filename>"
          const filename = path.basename(o.key)
          return !localPaths.has(path.join(UPLOAD_DIR, filename))
        })
      : []

    return NextResponse.json({
      configured: true,
      r2: {
        connected: r2List.success,
        objectCount: r2List.success ? r2List.objects.length : 0,
        totalSizeBytes: r2List.success ? r2List.objects.reduce((sum, o) => sum + o.size, 0) : 0,
      },
      local: {
        fileCount: localFiles.length,
        uploadDir: UPLOAD_DIR,
      },
      missingLocal: missingLocal.map(o => ({
        key: o.key,
        size: o.size,
        lastModified: o.lastModified.toISOString(),
      })),
      canRestore: missingLocal.length,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

// ==================== HELPERS ====================

// Point trả về từ qdrant.scroll — dùng type suy ra từ client để khớp shape thật
// (payload có thể null, next_page_offset có thể là object shard-key)
type QdrantScrolledPoint = (Awaited<ReturnType<typeof qdrant.scroll>>)['points'][number]

async function restoreSingleDocument(docId: string): Promise<{ restored: boolean; skipped: boolean; error?: string }> {
  try {
    // Get document metadata from Qdrant
    const points = await qdrant.retrieve(COLLECTION_DOCUMENTS, {
      ids: [docId],
      with_payload: true,
      with_vector: false,
    })

    if (points.length === 0) {
      return { restored: false, skipped: false, error: `Document ${docId} not found in Qdrant` }
    }

    const payload = points[0].payload as Record<string, unknown> | undefined
    const r2Key = (payload?.r2_key as string) || null
    const filePath = (payload?.file_path as string) || null

    if (!r2Key) {
      return { restored: false, skipped: false, error: `Document ${docId} has no r2_key in Qdrant` }
    }

    if (!filePath) {
      return { restored: false, skipped: false, error: `Document ${docId} has no file_path in Qdrant` }
    }

    // Check if local file already exists
    try {
      await fs.access(filePath)
      console.log(`[Sync] File exists locally: ${filePath} — skipping`)
      return { restored: false, skipped: true }
    } catch {
      // File missing — proceed with download
    }

    // Download from R2 to local
    const downloadResult = await downloadFileFromR2(r2Key, filePath)
    if (!downloadResult.success) {
      return { restored: false, skipped: false, error: `R2 download failed: ${downloadResult.error}` }
    }

    console.log(`[Sync] Restored: ${r2Key} → ${filePath} (${downloadResult.size} bytes)`)
    return { restored: true, skipped: false }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { restored: false, skipped: false, error: msg }
  }
}

async function fetchAllQdrantDocuments(): Promise<QdrantScrolledPoint[]> {
  try {
    // Use scroll API to get all documents
    const allPoints: QdrantScrolledPoint[] = []
    let offset: (Awaited<ReturnType<typeof qdrant.scroll>>)['next_page_offset'] = undefined

    do {
      const result = await qdrant.scroll(COLLECTION_DOCUMENTS, {
        limit: 100,
        offset,
        with_payload: true,
        with_vector: false,
      })
      allPoints.push(...result.points)
      offset = result.next_page_offset
    } while (offset)

    return allPoints
  } catch (err) {
    console.error('[Sync] Failed to fetch Qdrant documents:', err instanceof Error ? err.message : String(err))
    return []
  }
}

async function listLocalFiles(): Promise<string[]> {
  try {
    const entries = await fs.readdir(UPLOAD_DIR, { withFileTypes: true })
    return entries
      .filter(e => e.isFile())
      .map(e => path.join(UPLOAD_DIR, e.name))
  } catch {
    return []
  }
}
