/**
 * OPUS STATUS API (Task 13-b)
 * GET /api/opus/status?sessionId=<sessionId>
 *   → { mode: 'manual'|'auto', killed: boolean, lastReview: { decision, createdAt } | null }
 *
 * Mode null trên AgentSession.opusReviewMode → 'manual' (mặc định an toàn).
 */

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getOpusSettings } from '@/lib/opus/pipeline'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  try {
    const sessionId = request.nextUrl.searchParams.get('sessionId')
    if (!sessionId) {
      return NextResponse.json({ error: 'Thiếu tham số sessionId' }, { status: 400 })
    }

    const [session, settings, lastReview] = await Promise.all([
      db.agentSession.findUnique({
        where: { sessionId },
        select: { opusReviewMode: true },
      }),
      getOpusSettings(),
      db.opusReview.findFirst({
        where: { sessionId },
        orderBy: { createdAt: 'desc' },
        select: { decision: true, createdAt: true },
      }),
    ])

    return NextResponse.json({
      mode: session?.opusReviewMode === 'auto' ? 'auto' : 'manual',
      killed: settings.killed,
      lastReview: lastReview
        ? { decision: lastReview.decision, createdAt: lastReview.createdAt.toISOString() }
        : null,
    })
  } catch (err) {
    console.error('[Opus] GET status error:', err)
    return NextResponse.json({ error: 'Không tải được trạng thái Opus' }, { status: 500 })
  }
}
