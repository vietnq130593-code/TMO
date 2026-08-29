/**
 * SELF-DIRECTION PROPOSAL DETAIL API
 * ====================================
 * GET   /api/self-direction/proposals/[id] — Chi tiết 1 đề xuất + các bước
 * PATCH /api/self-direction/proposals/[id] — Hành động của Mr. Architect:
 *      {action: "approve"}                    — Đồng ý (đến hạn → triển khai ngay)
 *      {action: "reject",  reason?}           — Hủy (không phê duyệt)
 *      {action: "notes",   notes}             — Lưu ghi chú/yêu cầu bổ sung
 *      {action: "reschedule", scheduleAt}     — Đổi thời điểm triển khai
 */

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { triggerOrchestration, isOrchestrating } from '@/lib/self-direction/orchestrator'

export const dynamic = 'force-dynamic'

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const proposal = await db.selfDirectionProposal.findUnique({ where: { id } })
    if (!proposal) {
      return NextResponse.json({ error: 'Không tìm thấy đề xuất' }, { status: 404 })
    }
    const steps = await db.proposalStep.findMany({
      where: { proposalId: id },
      orderBy: { stepOrder: 'asc' },
    })
    return NextResponse.json({
      proposal: { ...proposal, orchestrating: isOrchestrating(id) },
      steps,
    })
  } catch (err) {
    console.error(`[SelfDirection] GET proposal detail error:`, err)
    return NextResponse.json({ error: 'Không tải được chi tiết đề xuất' }, { status: 500 })
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
    const action = String(body.action || '')

    const proposal = await db.selfDirectionProposal.findUnique({ where: { id } })
    if (!proposal) {
      return NextResponse.json({ error: 'Không tìm thấy đề xuất' }, { status: 404 })
    }

    const now = new Date()

    if (action === 'approve') {
      if (proposal.status !== 'pending') {
        return NextResponse.json({ error: `Chỉ duyệt được đề xuất đang chờ (hiện: ${proposal.status})` }, { status: 400 })
      }
      // Đến hạn (hoặc không hẹn lịch) → ready + orchestrate ngay; còn hạn → approved chờ
      const dueNow = !proposal.scheduleAt || proposal.scheduleAt.getTime() <= now.getTime()
      const updated = await db.selfDirectionProposal.update({
        where: { id },
        data: {
          status: dueNow ? 'ready' : 'approved',
          reviewer: 'mr-architect',
          decisionReason: null,
          reviewedAt: now,
        },
      })
      if (dueNow) void triggerOrchestration(id)
      console.log(`[SelfDirection] Mr. Architect DUYỆT "${proposal.title}"${dueNow ? ' → kích hoạt triển khai' : ` (hẹn lịch ${proposal.scheduleAt?.toISOString()})`}`)
      return NextResponse.json({ proposal: updated })
    }

    if (action === 'reject') {
      if (proposal.status !== 'pending') {
        return NextResponse.json({ error: `Chỉ hủy được đề xuất đang chờ (hiện: ${proposal.status})` }, { status: 400 })
      }
      const reason = body.reason ? String(body.reason).slice(0, 600) : null
      const updated = await db.selfDirectionProposal.update({
        where: { id },
        data: {
          status: 'rejected',
          reviewer: 'mr-architect',
          decisionReason: reason ? `Mr. Architect không duyệt: ${reason}` : 'Mr. Architect không duyệt',
          reviewedAt: now,
        },
      })
      console.log(`[SelfDirection] Mr. Architect HỦY "${proposal.title}"${reason ? ` — lý do: ${reason}` : ''}`)
      return NextResponse.json({ proposal: updated })
    }

    if (action === 'notes') {
      const notes = typeof body.notes === 'string' ? body.notes.slice(0, 3000) : ''
      const updated = await db.selfDirectionProposal.update({
        where: { id },
        data: { userNotes: notes },
      })
      return NextResponse.json({ proposal: updated })
    }

    if (action === 'reschedule') {
      if (!['pending', 'approved'].includes(proposal.status)) {
        return NextResponse.json({ error: 'Chỉ đổi lịch được đề xuất đang chờ hoặc đã duyệt' }, { status: 400 })
      }
      let scheduleAt: Date | null = null
      if (body.scheduleAt !== undefined && body.scheduleAt !== null && String(body.scheduleAt) !== '') {
        const d = new Date(String(body.scheduleAt))
        if (Number.isNaN(d.getTime())) {
          return NextResponse.json({ error: 'Thời điểm triển khai không hợp lệ' }, { status: 400 })
        }
        scheduleAt = d
      }
      const updated = await db.selfDirectionProposal.update({
        where: { id },
        data: { scheduleAt },
      })
      return NextResponse.json({ proposal: updated })
    }

    return NextResponse.json({ error: `Action không hợp lệ: ${action || '(trống)'}` }, { status: 400 })
  } catch (err) {
    console.error('[SelfDirection] PATCH proposal error:', err)
    return NextResponse.json({ error: 'Không xử lý được yêu cầu' }, { status: 500 })
  }
}
