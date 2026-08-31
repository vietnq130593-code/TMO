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
import { applyOpusVerdict, serializeOpusReview, serializeChatMessage, isKilled } from '@/lib/opus/pipeline'

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
      let { review, verdict } = await runOpusReview(sessionId, messageId, mode)

      let message: ChatMessage | null = null
      if (mode === 'auto') {
        // FIX (bypass guard): nhánh auto TRƯỚC ĐÂY gọi thẳng applyOpusVerdict —
        // bypass cả 2 hàng rào mà đường auto chính (runAutoReviewInner) có:
        // (1) kill switch + (2) STOP GUARD TASK 21. Hậu quả cũ: verdict STOP
        // mâu thuẫn được chèn thẳng → loop chết vĩnh viễn; kill switch bật
        // vẫn dispatch job. Giờ route này có cùng hàng rào.

        // (1) Kill switch re-check trước khi hành động — tôn trọng "phanh
        // duy nhất" của auto mode (user có thể bấm Kill giữa lúc review chạy)
        if (await isKilled()) {
          console.log(`[Opus] POST review auto: session=${sessionId} KILL SWITCH bật — verdict được lưu nhưng KHÔNG ban hành directive`)
          return NextResponse.json({
            ok: true,
            review: serializeOpusReview(review),
            message: null,
            note: 'KILL SWITCH đang bật — verdict được lưu nhưng không ban hành directive',
          })
        }

        // (2) TASK 21 — STOP GUARD: verdict STOP mà predicate 4 điều kiện
        // §VII chưa thỏa (allMet=false) → review lại 1 lần kèm đính chính
        // (mirror logic runAutoReviewInner) thay vì chèn STOP gây loop chết
        if (verdict.decision === 'STOP' && !verdict.stopAssessment.allMet) {
          console.warn(
            `[Opus] POST review auto: session=${sessionId} STOP GUARD — verdict STOP nhưng allMet=false, review lại theo §VII`
          )
          const retried = await runOpusReview(sessionId, messageId, 'auto', {
            correctiveHint:
              'Verdict vòng trước của bạn là STOP nhưng stopAssessment.allMet=false — predicate 4 điều kiện §VII CHƯA thỏa. ' +
              'Theo §VII bạn KHÔNG được STOP khi chưa đủ 4 điều kiện: hãy tiếp tục vòng mới (FIX/REDIRECT/CONTINUE kèm directive đầy đủ 6 trường). ' +
              'Chỉ STOP nếu (a) đủ cả 4 điều kiện với bằng chứng (allMet=true) hoặc (b) tác vụ độc hại/vô nghĩa — nêu rõ trong rationale.',
          })
          review = retried.review
          verdict = retried.verdict
        }

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
