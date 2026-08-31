/**
 * OPUS REVIEW API (Task 13-b)
 * POST /api/opus/review  body { sessionId, messageId? }
 *   → { ok: true, review: serializeReview, message: <directive message nếu đã auto-dispatch> }
 *
 * Chạy 1 vòng review Opus (30-120s — route chấp nhận chạy dài). In-process
 * lock per-session: đang có review chạy → 409 { ok:false, error:'opus-review-running' }.
 *
 * Hành vi theo chế độ hiện tại của session:
 *   - manual → CHỈ review (verdict trả về UI; user bấm "Ban hành chỉ đạo" qua
 *     /api/opus/dispatch để chèn directive + chạy agent)
 *   - auto   → review + applyOpusVerdict(autoDispatch=true): directive message
 *     vào chat + tự enqueue goal-loop job kế (loop tự vận hành)
 */

import { NextRequest, NextResponse } from 'next/server'
import type { ChatMessage } from '@prisma/client'
import { db } from '@/lib/db'
import { runOpusReview, markReviewRunning, markReviewDone } from '@/lib/opus/reviewer'
import { applyOpusVerdict, serializeOpusReview, serializeChatMessage } from '@/lib/opus/pipeline'

export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => ({}))) as {
      sessionId?: unknown
      messageId?: unknown
    }
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : ''
    const messageId = typeof body.messageId === 'string' && body.messageId.trim() ? body.messageId.trim() : null

    if (!sessionId) {
      return NextResponse.json({ error: 'Thiếu sessionId' }, { status: 400 })
    }

    const session = await db.agentSession.findUnique({
      where: { sessionId },
      select: { opusReviewMode: true },
    })
    if (!session) {
      return NextResponse.json({ error: 'Không tìm thấy session này' }, { status: 404 })
    }
    const mode = session.opusReviewMode === 'auto' ? 'auto' : 'manual'

    // In-process lock per-session — chống 2 review chồng nhau của cùng session
    if (!markReviewRunning(sessionId)) {
      console.warn(`[Opus] POST review: session=${sessionId} đang có review chạy — 409`)
      return NextResponse.json({ ok: false, error: 'opus-review-running' }, { status: 409 })
    }

    try {
      const { review, verdict } = await runOpusReview(sessionId, messageId, mode)

      let message: ChatMessage | null = null
      if (mode === 'auto') {
        // Auto mode: tự ban hành + auto-dispatch (ESCALATE/STOP → chỉ chèn
        // message, KHÔNG dispatch — applyOpusVerdict tự phân biệt theo decision)
        message = await applyOpusVerdict(review, verdict, { autoDispatch: true })
      }

      return NextResponse.json({
        ok: true,
        review: serializeOpusReview(review),
        message: message ? serializeChatMessage(message) : null,
      })
    } finally {
      markReviewDone(sessionId)
    }
  } catch (err) {
    console.error('[Opus] POST review error:', err)
    return NextResponse.json({ error: 'Không chạy được vòng review của Opus' }, { status: 500 })
  }
}
