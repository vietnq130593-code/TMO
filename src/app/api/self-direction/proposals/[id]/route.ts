/**
 * SELF-DIRECTION PROPOSAL DETAIL API
 * ====================================
 * GET    /api/self-direction/proposals/[id] — Chi tiết 1 đề xuất + các bước
 * PATCH  /api/self-direction/proposals/[id] — Hành động của Mr. Architect:
 *      {action: "approve"}                    — Đồng ý (đến hạn → triển khai ngay)
 *      {action: "reject",  reason?}           — Hủy (không phê duyệt)
 *      {action: "notes",   notes}             — Lưu ghi chú/yêu cầu bổ sung
 *      {action: "reschedule", scheduleAt}     — Đổi thời điểm triển khai
 * DELETE /api/self-direction/proposals/[id] — Xóa hẳn đề xuất khỏi Lịch sử
 *      (user request 2026-10-15; steps cascade theo Prisma onDelete: Cascade;
 *       khóa khi orchestration đang chạy trong process — 409)
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
    // CI-6 B5: proposal row (spread) tự chứa executionMode; steps tự chứa
    // workspaceReceipt (pipeline pre-push / tool-call receipts của code-workflow)
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
      // Lượt quan sát 4 (user directive 2026-09-04): trigger nền mặc định DRY-RUN —
      // chỉ user chủ động qua deploy API mới push thật (chỉ thị chỉ push TMO-backup).
      if (dueNow) void triggerOrchestration(id, { dryRun: true })
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

/**
 * DELETE /api/self-direction/proposals/[id] — Xóa hẳn đề xuất (user request
 * 2026-10-15: các đề xuất trong Lịch sử cần nút xóa).
 *
 * Guard an toàn:
 *   - 404: đề xuất không tồn tại (hoặc đã bị xóa ở tab khác)
 *   - 409: orchestration ĐANG CHẠY trong process cho proposal này — xóa lúc
 *     này sẽ làm pipeline Omega đứt giữa chừng; chờ hoàn tất rồi xóa.
 *     (status planning/executing nhưng KHÔNG orchestrating = row kẹt sau
 *     restart — vẫn cho xóa để user dọn rác.)
 *   - ProposalStep.relation có onDelete: Cascade → steps tự bị xóa theo.
 */
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const proposal = await db.selfDirectionProposal.findUnique({
      where: { id },
      select: { title: true, status: true, executionMode: true },
    })
    if (!proposal) {
      return NextResponse.json({ error: 'Không tìm thấy đề xuất' }, { status: 404 })
    }
    if (isOrchestrating(id)) {
      return NextResponse.json(
        { error: 'Đề xuất đang được triển khai — chờ hoàn tất rồi mới xóa được' },
        { status: 409 },
      )
    }
    // Cascade: proposal_steps xoá theo (onDelete: Cascade trong schema)
    await db.selfDirectionProposal.delete({ where: { id } })
    console.log(
      `[SelfDirection] ĐÃ XÓA đề xuất "${proposal.title}" (status=${proposal.status}` +
        `${proposal.executionMode ? `, mode=${proposal.executionMode}` : ''}) + toàn bộ steps`
    )
    return NextResponse.json({ ok: true, deletedId: id })
  } catch (err) {
    console.error('[SelfDirection] DELETE proposal error:', err)
    return NextResponse.json({ error: 'Không xóa được đề xuất' }, { status: 500 })
  }
}
