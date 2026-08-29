/**
 * SELF-DIRECTION DEPLOY API
 * ====================================
 * POST /api/self-direction/proposals/[id]/deploy — Kích hoạt Omega orchestration
 * Ngay lập tức (deploy sớm trước scheduleAt) hoặc thử lại sau thất bại.
 * Fire-and-forget: orchestration chạy nền, UI poll để xem tiến độ.
 */

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { triggerOrchestration, isOrchestrating } from '@/lib/self-direction/orchestrator'

export const dynamic = 'force-dynamic'

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const proposal = await db.selfDirectionProposal.findUnique({ where: { id } })
    if (!proposal) {
      return NextResponse.json({ error: 'Không tìm thấy đề xuất' }, { status: 404 })
    }

    if (!['approved', 'ready', 'failed'].includes(proposal.status)) {
      return NextResponse.json(
        { error: `Không thể triển khai từ trạng thái "${proposal.status}" — đề xuất phải được duyệt trước` },
        { status: 400 },
      )
    }

    if (isOrchestrating(id)) {
      return NextResponse.json({ ok: true, alreadyRunning: true, proposal })
    }

    const started = await triggerOrchestration(id)
    if (!started) {
      return NextResponse.json({ error: 'Không kích hoạt được orchestration (thử lại sau)' }, { status: 500 })
    }

    const earlyDeploy = proposal.status === 'approved' && proposal.scheduleAt !== null && proposal.scheduleAt.getTime() > Date.now()
    console.log(`[SelfDirection] Deploy thủ công "${proposal.title}"${earlyDeploy ? ` (sớm hơn lịch ${proposal.scheduleAt?.toISOString()})` : ''}`)

    const fresh = await db.selfDirectionProposal.findUnique({ where: { id } })
    return NextResponse.json({ ok: true, proposal: fresh ?? proposal })
  } catch (err) {
    console.error('[SelfDirection] POST deploy error:', err)
    return NextResponse.json({ error: 'Không kích hoạt được triển khai' }, { status: 500 })
  }
}
