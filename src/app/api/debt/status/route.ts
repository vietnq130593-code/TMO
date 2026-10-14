/**
 * DEBT LEDGER STATUS API — R13 (vòng đời nợ khép kín xuyên session)
 * ============================================================================
 *
 * GET /api/debt/status
 *   Trả hiện trạng SỔ NỢ KỸ THUẬT THỐNG NHẤT (DebtLedger):
 *   - counts: { open, in_progress, resolved, parked }
 *   - open[]: nợ đang mở (attempts, recurrenceCount, nguồn session) — xếp
 *     lastSeenAt mới→cũ, tối đa 20
 *   - parked[]: nợ đã dừng thử (parkReason — chờ điều kiện/thầy quyết định)
 *   - recentResolved[]: 10 nợ đã giải quyết gần nhất (đối chiếu hiệu quả)
 *   - config: ngưỡng park / giới hạn pickup global / kill-switch
 *
 * PATCH /api/debt/status  { id: string, action: 'resolve'|'reopen'|'park' }
 *   Can thiệp thủ công của THẦY/USER (giám sát có giám sát — user directive R13):
 *   - resolve: đóng nợ (resolvedBy='user') — khi người thấy nợ đã hết thật
 *   - reopen : mở lại nợ parked/open (attempts=0 — cấp điều kiện thử lại)
 *   - park   : dừng thử 1 nợ đang mở (không đốt thêm chu kỳ agent)
 *   Trả row sau cập nhật. Fail-open 400 khi id/action thiếu.
 */

import { NextResponse, NextRequest } from 'next/server'
import { getDebtLedgerSummary, DEBT_LEDGER_ENABLED, DEBT_MAX_PICKUP_ATTEMPTS, DEBT_GLOBAL_PICKUP_LIMIT, DEBT_GLOBAL_MIN_AGE_MIN, DEBT_SWEEP_STALE_DAYS } from '@/lib/execution/debt-ledger'

export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const summary = await getDebtLedgerSummary()
    return NextResponse.json({
      ok: true,
      enabled: DEBT_LEDGER_ENABLED,
      config: {
        maxPickupAttempts: DEBT_MAX_PICKUP_ATTEMPTS,
        globalPickupLimit: DEBT_GLOBAL_PICKUP_LIMIT,
        globalMinAgeMin: DEBT_GLOBAL_MIN_AGE_MIN,
        sweepStaleDays: DEBT_SWEEP_STALE_DAYS,
      },
      ...summary,
    })
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message.slice(0, 200) : 'unknown' }, { status: 500 })
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => null)) as { id?: string; action?: string; reason?: string } | null
    const id = body?.id?.trim()
    const action = body?.action?.trim()
    if (!id || !action || !['resolve', 'reopen', 'park'].includes(action)) {
      return NextResponse.json({ ok: false, error: 'Cần { id, action: "resolve"|"reopen"|"park" } (tùy chọn reason)' }, { status: 400 })
    }
    const { db } = await import('@/lib/db')
    const row = await db.debtLedger.findUnique({ where: { id } })
    if (!row) return NextResponse.json({ ok: false, error: `Không tìm thấy DebtLedger ${id}` }, { status: 404 })
    const now = new Date()
    if (action === 'resolve') {
      const updated = await db.debtLedger.update({
        where: { id },
        data: { status: 'resolved', resolvedAt: now, resolvedByRunId: 'user', resolutionEvidence: `User/thầy đóng thủ công qua PATCH /api/debt/status${body?.reason ? ` — ${body.reason.slice(0, 200)}` : ''}` },
      })
      return NextResponse.json({ ok: true, debt: updated })
    }
    if (action === 'reopen') {
      const updated = await db.debtLedger.update({
        where: { id },
        data: { status: 'open', attempts: 0, lastAttemptRunId: null, lastAttemptAt: null, resolvedAt: null, resolvedByRunId: null, parkReason: null, lastSeenAt: now },
      })
      return NextResponse.json({ ok: true, debt: updated })
    }
    // park
    const updated = await db.debtLedger.update({
      where: { id },
      data: { status: 'parked', parkReason: `User/thầy park thủ công${body?.reason ? ` — ${body.reason.slice(0, 200)}` : ' — dừng thử'}` },
    })
    return NextResponse.json({ ok: true, debt: updated })
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message.slice(0, 200) : 'unknown' }, { status: 500 })
  }
}
