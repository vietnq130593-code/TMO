/**
 * OPUS KILL SWITCH API (Task 13-b)
 * POST /api/opus/kill  body { action: 'kill'|'reset' }
 *   → { ok: true, killed }
 *
 * action='kill'   → OpusSettings.killed=true + killedAt=now — PHANH DUY NHẤT
 *                   của auto mode (user decision #2: auto không giới hạn
 *                   vòng/budget → kill switch là điểm dừng khẩn cấp toàn hệ thống)
 * action='reset'  → killed=false + clear killedAt
 */

import { NextRequest, NextResponse } from 'next/server'
import { setOpusKilled } from '@/lib/opus/pipeline'

export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => ({}))) as { action?: unknown }
    const action = typeof body.action === 'string' ? body.action.trim().toLowerCase() : ''

    if (action !== 'kill' && action !== 'reset') {
      return NextResponse.json({ error: "action phải là 'kill' hoặc 'reset'" }, { status: 400 })
    }

    const killed = action === 'kill'
    const settings = await setOpusKilled(killed)
    console.log(`[Opus] POST kill: action=${action} → killed=${settings.killed}${killed ? ' — auto mode ngưng toàn hệ thống' : ' — auto mode được phép chạy lại'}`)
    return NextResponse.json({ ok: true, killed: settings.killed })
  } catch (err) {
    console.error('[Opus] POST kill error:', err)
    return NextResponse.json({ error: 'Không đổi được kill switch của Opus' }, { status: 500 })
  }
}
