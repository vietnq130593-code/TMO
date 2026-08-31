/**
 * OPUS DISPATCH API (Task 13-b)
 * POST /api/opus/dispatch  body { reviewId }
 *   → { ok: true, message } | 400 khi review đã ban hành | 404 khi không tìm thấy
 *
 * MANUAL mode: user bấm "Ban hành chỉ đạo" sau khi đọc verdict — chèn directive
 * message vào chat + tự enqueue goal-loop job (autoDispatch=true — user đã chủ
 * động phê duyệt). Review đã từng dispatch → 400 "đã ban hành".
 */

import { NextRequest, NextResponse } from 'next/server'
import { OpusDispatchError, dispatchDirectiveForReview, serializeChatMessage } from '@/lib/opus/pipeline'

export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => ({}))) as { reviewId?: unknown }
    const reviewId = typeof body.reviewId === 'string' ? body.reviewId.trim() : ''

    if (!reviewId) {
      return NextResponse.json({ error: 'Thiếu reviewId' }, { status: 400 })
    }

    const message = await dispatchDirectiveForReview(reviewId)
    return NextResponse.json({ ok: true, message: serializeChatMessage(message) })
  } catch (err) {
    if (err instanceof OpusDispatchError) {
      console.warn(`[Opus] POST dispatch: ${err.status} — ${err.message}`)
      return NextResponse.json({ error: err.message }, { status: err.status })
    }
    console.error('[Opus] POST dispatch error:', err)
    return NextResponse.json({ error: 'Không ban hành được chỉ đạo của Opus' }, { status: 500 })
  }
}
