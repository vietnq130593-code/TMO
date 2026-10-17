/**
 * EVO-P4 (§5.7) — CANCEL VÒNG EVOLVE (cooperative — precedent HN §4.2-2c)
 * ============================================================================
 *
 * POST /api/brain/evolve/cancel { runId } → { ok: true, message }
 * Idempotent: runId không tồn tại / đã kết thúc → vẫn 200 no-op (không lỗi).
 * Vòng dừng ở ứng viên KẾ TIẾP (cooperative — không giết giữa chừng; ứng
 * viên đã chấm được GIỮ NGUYÊN — E4 "đã dừng lúc i/N, giữ N' ứng viên").
 */

import { NextRequest, NextResponse } from 'next/server'
import { cancelEvoRun } from '@/lib/brain/evolve'

export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => ({}))) as { runId?: unknown }
    if (typeof body.runId !== 'string' || body.runId.length === 0) {
      return NextResponse.json({ error: "thiếu 'runId'" }, { status: 400 })
    }
    const result = await cancelEvoRun(body.runId)
    return NextResponse.json({ ok: true, message: result.message })
  } catch (err) {
    console.error('[Evolve API] cancel failed:', err instanceof Error ? err.message : String(err))
    return NextResponse.json(
      { error: 'Không hủy được vòng evolve', details: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    )
  }
}
