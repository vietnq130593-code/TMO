/**
 * Qdrant Setup API — Collection initialization and management
 *
 * Architecture:
 *   SQLite (buffer) → Qdrant (vector+document) + Neo4j (graph)
 *
 * - POST: Initialize Qdrant collections (theopus_documents + theopus_chunks)
 * - GET:  Check Qdrant connection status and collection info
 * - DELETE ?action=clean: Delete all points from collections (keeps collection structure)
 */

import { NextRequest, NextResponse } from 'next/server'
import { checkQdrantHealth, initializeCollections, qdrant, COLLECTION_DOCUMENTS, COLLECTION_CHUNKS } from '@/lib/qdrant'

export const dynamic = 'force-dynamic'

/**
 * POST /api/setup/qdrant
 * Initialize Qdrant collections and payload indexes.
 * Safe to call multiple times — checks existence first.
 */
export async function POST() {
  try {
    const health = await checkQdrantHealth()

    if (!health.connected) {
      return NextResponse.json(
        { success: false, error: 'Cannot connect to Qdrant. Check if the service is running at ' + (process.env.QDRANT_URL || 'http://localhost:6333') },
        { status: 500 }
      )
    }

    const result = await initializeCollections()

    // ROUND-35 (B3): success phải phản ánh kết quả THẬT — bản cũ trả
    // success:true dù chunks=false + error='dim-mismatch...' (error chỉ nằm
    // trong collections.error chôn sâu) → gọi setup xong tưởng đã fix mà
    // collection vẫn lệch dim. Giờ fail thật → 500 + message lộ nguyên nhân.
    if (!result.documents || !result.chunks) {
      return NextResponse.json(
        {
          success: false,
          error:
            result.error ??
            `Initialization incomplete (documents=${result.documents}, chunks=${result.chunks}) — kiểm tra dim embedding (health sẽ báo degraded khi dimMismatch)`,
          health,
          collections: result,
        },
        { status: 500 }
      )
    }

    return NextResponse.json({
      success: true,
      message: `Qdrant initialized: documents=${result.documents}, chunks=${result.chunks}`,
      health,
      collections: result,
    })
  } catch (err) {
    return NextResponse.json(
      { success: false, error: String(err) },
      { status: 500 }
    )
  }
}

/**
 * GET /api/setup/qdrant
 * Check Qdrant connection status and collection details.
 */
export async function GET() {
  const health = await checkQdrantHealth()

  // Get detailed collection info if connected
  let collections: Record<string, unknown> = {}
  if (health.connected) {
    try {
      const docInfo = await qdrant.getCollection(COLLECTION_DOCUMENTS)
      collections.documents = {
        exists: true,
        pointCount: docInfo.points_count,
        status: docInfo.status,
        optimizerStatus: docInfo.optimizer_status,
      }
    } catch {
      collections.documents = { exists: false }
    }

    try {
      const chunkInfo = await qdrant.getCollection(COLLECTION_CHUNKS)
      collections.chunks = {
        exists: true,
        pointCount: chunkInfo.points_count,
        // vectors_count không có trong type CollectionInfo của client v1.x —
        // đọc qua cast để giữ nguyên runtime (field có thể undefined)
        vectorCount: (chunkInfo as { vectors_count?: number | null }).vectors_count,
        status: chunkInfo.status,
        optimizerStatus: chunkInfo.optimizer_status,
        vectorConfig: {
          size: chunkInfo.config?.params?.vectors?.size,
          distance: chunkInfo.config?.params?.vectors?.distance,
        },
      }
    } catch {
      collections.chunks = { exists: false }
    }
  }

  return NextResponse.json({ health, collections })
}

/**
 * DELETE /api/setup/qdrant?action=clean
 * Delete all points from Qdrant collections (keeps collection structure + indexes).
 * Use this to reset Qdrant data without recreating collections.
 */
export async function DELETE(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const action = searchParams.get('action')

    if (action !== 'clean') {
      return NextResponse.json({ error: 'Use ?action=clean to clear Qdrant data' }, { status: 400 })
    }

    const health = await checkQdrantHealth()
    if (!health.connected) {
      return NextResponse.json({ error: 'Qdrant not connected' }, { status: 500 })
    }

    // Count points before cleanup
    let beforeDocuments = 0
    let beforeChunks = 0

    try {
      const docCount = await qdrant.count(COLLECTION_DOCUMENTS, { exact: true })
      beforeDocuments = docCount.count
    } catch {
      // Collection may not exist
    }

    try {
      const chunkCount = await qdrant.count(COLLECTION_CHUNKS, { exact: true })
      beforeChunks = chunkCount.count
    } catch {
      // Collection may not exist
    }

    // Delete all points from both collections (keeps collection structure + indexes)
    // Use filter: {} (match all) — NOT points: [] (which deletes nothing)
    // NOTE (type-only): client v1.x delete() chỉ nhận (collection, selector) —
    // đối số { wait: true } thứ 3 hiện bị runtime BỎ QUA. Giữ nguyên 3 đối số
    // runtime như call gốc (spread mảng 2 phần tử), chỉ đánh type mảng là
    // 1-tuple để tsc thấy đúng số tham số.
    type QdrantDeleteSelector = Parameters<typeof qdrant.delete>[1]
    const deleteDocArgs = [{ filter: {} }, { wait: true }] as unknown as [QdrantDeleteSelector]
    try {
      await qdrant.delete(COLLECTION_DOCUMENTS, ...deleteDocArgs)
    } catch {
      // Collection may not exist — skip
    }

    const deleteChunkArgs = [{ filter: {} }, { wait: true }] as unknown as [QdrantDeleteSelector]
    try {
      await qdrant.delete(COLLECTION_CHUNKS, ...deleteChunkArgs)
    } catch {
      // Collection may not exist — skip
    }

    console.log(`[Qdrant Clean] Cleared: ${beforeDocuments} documents, ${beforeChunks} chunks`)

    return NextResponse.json({
      success: true,
      message: `Qdrant data cleared: ${beforeDocuments} documents, ${beforeChunks} chunks deleted. Collection structure and indexes preserved.`,
      before: { documents: beforeDocuments, chunks: beforeChunks },
    })
  } catch (err) {
    console.error('[Qdrant Clean] Error:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Qdrant cleanup failed' },
      { status: 500 }
    )
  }
}
