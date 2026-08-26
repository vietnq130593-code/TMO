import { NextResponse } from 'next/server'
import { getPendingReviewItems, reviewWriteback } from '@/lib/kb-routing/transactional-writeback'

export const dynamic = 'force-dynamic'

/**
 * Gray-zone Knowledge Review API (user request 2026-08-27)
 *
 * GET  — Liệt kê các tri thức vùng xám (confidence 0.3-0.5) mà Agent KHÔNG CHẮC
 *        → đang chờ user phê duyệt trước khi ghi vào Knowledge Base.
 *        (Tri thức conf > 0.5 đã được auto-write — mặc định theo directive user:
 *        "những gì thuộc về tri thức mà KB thiếu sót thì đều nên cập nhật vào".)
 *
 * POST — { batchId: string, action: 'approve' | 'reject' }
 *        approve → ghi tri thức vào KB (Qdrant + Neo4j + audit records)
 *        reject  → bỏ tri thức, đánh dấu batch 'rejected'
 */

export async function GET(request: Request) {
  try {
    const url = new URL(request.url)
    const limitParam = url.searchParams.get('limit') || '20'
    const limit = Math.min(parseInt(limitParam, 10) || 20, 50)

    const items = await getPendingReviewItems(limit)
    return NextResponse.json({ ok: true, count: items.length, items })
  } catch (err) {
    console.error('[WritebackReview GET] Error:', err)
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : 'Failed to list review items' },
      { status: 500 }
    )
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as { batchId?: string; action?: string }
    const { batchId, action } = body

    if (!batchId || !action || !['approve', 'reject'].includes(action)) {
      return NextResponse.json(
        { ok: false, error: 'batchId và action ("approve" | "reject") là bắt buộc' },
        { status: 400 }
      )
    }

    const result = await reviewWriteback(batchId, action as 'approve' | 'reject')
    if (!result.ok) {
      return NextResponse.json(result, { status: 400 })
    }
    return NextResponse.json(result)
  } catch (err) {
    console.error('[WritebackReview POST] Error:', err)
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : 'Review action failed' },
      { status: 500 }
    )
  }
}
