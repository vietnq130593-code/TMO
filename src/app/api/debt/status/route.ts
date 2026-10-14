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
 *   - slotPool (R15 — BUG2-239 production consumer): trạng thái PHANH TUẦN TỰ
 *     sub-agent (maxConcurrent, busy/waiting, phân phối waitedMs p50/p95) —
 *     đài quan sát đọc trực tiếp từ singleton pool (globalThis — không parse
 *     log). Dynamic import: route không phải nạp tĩnh cả llm.ts/tool-executor.
 *     Fail-open: import lỗi → slotPool:null (nợ ledger vẫn trả đủ).
 *
 * PATCH /api/debt/status  { id: string, action: 'resolve'|'reopen'|'park' }
 *   Can thiệp thủ công của THẦY/USER (giám sát có giám sát — user directive R13):
 *   - resolve: đóng nợ (resolvedBy='user') — khi người thấy nợ đã hết thật
 *   - reopen : mở lại nợ parked/open (attempts=0 — cấp điều kiện thử lại)
 *   - park   : dừng thử 1 nợ đang mở (không đốt thêm chu kỳ agent)
 *   Trả row sau cập nhật. Fail-open 400 khi id/action thiếu.
 *   R15 (P2023 debt fix — fixbug.md "Ngoài phạm vi" R14): id sai-format
 *   ("abc", "123", chuỗi tấn công) trước đây rơi Prisma P2023 "Inconsistent
 *   column data" → 500 không rõ nghĩa. Giờ validate format cuid TRƯỚC query →
 *   400; catch vẫn hứng P2023 làm lớp 2 (belt-and-suspenders — nếu tương lai
 *   Prisma đổi format thì không mở lại lỗ 500).
 */

import { NextResponse, NextRequest } from 'next/server'
import { getDebtLedgerSummary, DEBT_LEDGER_ENABLED, DEBT_MAX_PICKUP_ATTEMPTS, DEBT_GLOBAL_PICKUP_LIMIT, DEBT_GLOBAL_MIN_AGE_MIN, DEBT_SWEEP_STALE_DAYS } from '@/lib/execution/debt-ledger'

export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const summary = await getDebtLedgerSummary()
    // R15 (BUG2-239): production consumer đầu tiên cho getSubAgentSlotPoolInfo
    // — "đài quan sát" phanh tuần tự. Dynamic import (pattern import db phía
    // PATCH): tránh nạp tĩnh chu trình llm/tool-executor vào route bundle.
    let slotPool: ReturnType<typeof import('@/lib/subagent-delegate')['getSubAgentSlotPoolInfo']> | null = null
    try {
      const { getSubAgentSlotPoolInfo } = await import('@/lib/subagent-delegate')
      slotPool = getSubAgentSlotPoolInfo()
    } catch {
      slotPool = null // fail-open — ledger vẫn trả; UI hiển thị "—"
    }
    return NextResponse.json({
      ok: true,
      enabled: DEBT_LEDGER_ENABLED,
      config: {
        maxPickupAttempts: DEBT_MAX_PICKUP_ATTEMPTS,
        globalPickupLimit: DEBT_GLOBAL_PICKUP_LIMIT,
        globalMinAgeMin: DEBT_GLOBAL_MIN_AGE_MIN,
        sweepStaleDays: DEBT_SWEEP_STALE_DAYS,
      },
      slotPool,
      ...summary,
    })
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message.slice(0, 200) : 'unknown' }, { status: 500 })
  }
}

export async function PATCH(req: NextRequest) {
  try {
    // FB-R13DEBT-R1-06: typeof check — id/action non-string (vd {"id":123})
    // cũ → TypeError → 500; giờ → 400 rõ ràng.
    const body = (await req.json().catch(() => null)) as { id?: string; action?: string; reason?: string } | null
    const id = typeof body?.id === 'string' ? body.id.trim() : ''
    const action = typeof body?.action === 'string' ? body.action.trim() : ''
    const reason = typeof body?.reason === 'string' ? body.reason.slice(0, 200) : ''
    if (!id || !action || !['resolve', 'reopen', 'park'].includes(action)) {
      return NextResponse.json({ ok: false, error: 'Cần { id: string, action: "resolve"|"reopen"|"park" } (tùy chọn reason: string)' }, { status: 400 })
    }
    // R15 (P2023): DebtLedger.id là cuid (c + 24 ký tự [a-z0-9], tổng 25 —
    // prisma @default(cuid())). Chuỗi ngoài charset/độ dài này khiến Prisma
    // throw P2023 → 500. Chặn trước: 400 kèm thông điệp rõ.
    if (!/^c[a-z0-9]{8,40}$/i.test(id)) {
      return NextResponse.json({ ok: false, error: `id "${id.slice(0, 40)}" không đúng format cuid của DebtLedger (c + [a-z0-9]) — kiểm tra lại id từ GET /api/debt/status` }, { status: 400 })
    }
    const { db } = await import('@/lib/db')
    const row = await db.debtLedger.findUnique({ where: { id } })
    if (!row) return NextResponse.json({ ok: false, error: `Không tìm thấy DebtLedger ${id}` }, { status: 404 })
    const now = new Date()
    // FB-R13DEBT-R1-06: bảng chuyển trạng thái hợp lệ — tránh (a) resolve
    // parked để resolvedAt stale (giờ được phép nhưng CLEAR parkReason đối
    // xứng), (b) park debt đã resolved (mâu thuẫn — 400), (c) reopen khi đang
    // open/in_progress (reset lastAttemptRunId làm finalize run đang chạy mất
    // attempt — 400).
    if (action === 'resolve') {
      if (row.status === 'resolved') return NextResponse.json({ ok: false, error: `Debt đã resolved từ trước (lúc ${row.resolvedAt?.toISOString().slice(0, 16) ?? '?'})` }, { status: 400 })
      const updated = await db.debtLedger.update({
        where: { id },
        // resolve từ parked → xóa parkReason (đối xứng clear-field)
        data: { status: 'resolved', resolvedAt: now, resolvedByRunId: 'user', parkReason: null, resolutionEvidence: `User/thầy đóng thủ công qua PATCH /api/debt/status${reason ? ` — ${reason}` : ''}` },
      })
      return NextResponse.json({ ok: true, debt: updated })
    }
    if (action === 'reopen') {
      if (row.status === 'open' || row.status === 'in_progress') {
        return NextResponse.json({ ok: false, error: `Debt đang ${row.status} — reopen chỉ dành cho parked/resolved (tránh mất attempt của run đang chạy)` }, { status: 400 })
      }
      const updated = await db.debtLedger.update({
        where: { id },
        data: { status: 'open', attempts: 0, lastAttemptRunId: null, lastAttemptAt: null, resolvedAt: null, resolvedByRunId: null, parkReason: null, lastSeenAt: now },
      })
      return NextResponse.json({ ok: true, debt: updated })
    }
    // park
    if (row.status === 'resolved') {
      return NextResponse.json({ ok: false, error: 'Không park debt đã resolved — dùng reopen trước nếu muốn thử lại' }, { status: 400 })
    }
    if (row.status === 'parked') {
      return NextResponse.json({ ok: false, error: `Debt đã parked từ trước: ${row.parkReason ?? '?'}` }, { status: 400 })
    }
    const updated = await db.debtLedger.update({
      where: { id },
      data: { status: 'parked', parkReason: `User/thầy park thủ công${reason ? ` — ${reason}` : ' — dừng thử'}` },
    })
    return NextResponse.json({ ok: true, debt: updated })
  } catch (err) {
    // R15 (P2023 lớp 2): nếu Prisma vẫn nổ inconsistent-column (format cuid
    // đổi ở tương lai) → 400 thay vì 500 — PATCH là can thiệp thủ công,
    // người gọi cần thông điệp sửa được chứ không phải server-error.
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes('P2023') || /inconsistent column data/i.test(msg)) {
      return NextResponse.json({ ok: false, error: 'id không khớp format lưu trữ của DebtLedger (P2023) — lấy lại id từ GET /api/debt/status' }, { status: 400 })
    }
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message.slice(0, 200) : 'unknown' }, { status: 500 })
  }
}
