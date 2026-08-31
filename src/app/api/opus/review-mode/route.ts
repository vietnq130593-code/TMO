/**
 * OPUS REVIEW-MODE API (Task 13-b)
 * PATCH /api/opus/review-mode  body { sessionId, mode: 'manual'|'auto' }
 *   → { ok: true, mode, killed }
 *
 * mode='auto' → tự reset OpusSettings.killed=false (user ý định rõ ràng chạy
 * lại auto mode — kill switch chỉ giữ khi user chưa chủ động bật lại).
 */

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getOpusSettings, setOpusKilled } from '@/lib/opus/pipeline'

export const dynamic = 'force-dynamic'

export async function PATCH(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => ({}))) as {
      sessionId?: unknown
      mode?: unknown
    }
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : ''
    const mode = typeof body.mode === 'string' ? body.mode.trim().toLowerCase() : ''

    if (!sessionId) {
      return NextResponse.json({ error: 'Thiếu sessionId' }, { status: 400 })
    }
    if (mode !== 'manual' && mode !== 'auto') {
      return NextResponse.json({ error: "mode phải là 'manual' hoặc 'auto'" }, { status: 400 })
    }

    const updated = await db.agentSession.updateMany({
      where: { sessionId },
      data: { opusReviewMode: mode, updatedAt: new Date() },
    })
    if (updated.count === 0) {
      return NextResponse.json({ error: 'Không tìm thấy session này' }, { status: 404 })
    }

    // auto → reset kill switch (ý định rõ ràng của user); manual → giữ nguyên
    if (mode === 'auto') {
      const settings = await getOpusSettings()
      if (settings.killed) {
        await setOpusKilled(false)
        console.log('[Opus] PATCH review-mode → auto: kill switch đã được reset theo ý định user')
      }
    }

    const settings = await getOpusSettings()
    console.log(`[Opus] PATCH review-mode: session=${sessionId} → mode=${mode}, killed=${settings.killed}`)
    return NextResponse.json({ ok: true, mode, killed: settings.killed })
  } catch (err) {
    console.error('[Opus] PATCH review-mode error:', err)
    return NextResponse.json({ error: 'Không đổi được chế độ review của Opus' }, { status: 500 })
  }
}
