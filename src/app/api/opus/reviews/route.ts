/**
 * OPUS REVIEWS API (Task 13-b)
 * GET /api/opus/reviews?sessionId=<sessionId>&limit=20
 *   → { reviews: [...serialize], ledger: getLedger(sessionId) }
 *
 * serialize review: parse verdict JSON thành object (UI 13-c đọc trực tiếp).
 * ledger: sổ issue đầy đủ (open + resolved + counts theo severity + clean flag).
 */

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getLedger } from '@/lib/opus/ledger'
import { serializeOpusReview } from '@/lib/opus/pipeline'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  try {
    const sessionId = request.nextUrl.searchParams.get('sessionId')
    if (!sessionId) {
      return NextResponse.json({ error: 'Thiếu tham số sessionId' }, { status: 400 })
    }
    const limitRaw = parseInt(request.nextUrl.searchParams.get('limit') ?? '20', 10)
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(1, limitRaw), 100) : 20

    const [rows, ledger] = await Promise.all([
      db.opusReview.findMany({
        where: { sessionId },
        orderBy: { createdAt: 'desc' },
        take: limit,
      }),
      getLedger(sessionId),
    ])

    return NextResponse.json({
      reviews: rows.map(serializeOpusReview),
      ledger,
    })
  } catch (err) {
    console.error('[Opus] GET reviews error:', err)
    return NextResponse.json({ error: 'Không tải được danh sách review của Opus' }, { status: 500 })
  }
}
