/**
 * SELF-DIRECTION DEPLOY API
 * ====================================
 * POST /api/self-direction/proposals/[id]/deploy — Kích hoạt Omega orchestration
 * Ngay lập tức (deploy sớm trước scheduleAt) hoặc thử lại sau thất bại.
 * Fire-and-forget: orchestration chạy nền, UI poll để xem tiến độ.
 *
 * Body (tùy chọn): { "dryRun": true } — FIX 2026-09-02 (Omega audit #2): chạy
 * pipeline kiểm định code-workflow đầy đủ (lint→typecheck→tests→smoke→secret
 * scan) nhưng KHÔNG commit/push. Mặc định (không gửi / dryRun=false): pipeline
 * verify_and_push commit + push THẬT lên remote — theo yêu cầu Mr. Architect,
 * chức năng push code từ workspace phải hoạt động thật.
 */

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { triggerOrchestration, isOrchestrating } from '@/lib/self-direction/orchestrator'

export const dynamic = 'force-dynamic'

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    // Body tùy chọn — lỗi parse/empty → {} (deploy thật như cũ)
    const body = (await req.json().catch(() => ({}))) as { dryRun?: unknown }
    const dryRun = body.dryRun === true
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

    const started = await triggerOrchestration(id, dryRun ? { dryRun: true } : undefined)
    if (!started) {
      return NextResponse.json({ error: 'Không kích hoạt được orchestration (thử lại sau)' }, { status: 500 })
    }

    const earlyDeploy = proposal.status === 'approved' && proposal.scheduleAt !== null && proposal.scheduleAt.getTime() > Date.now()
    console.log(`[SelfDirection] Deploy thủ công "${proposal.title}"${dryRun ? ' [DRY-RUN — không commit/push]' : ''}${earlyDeploy ? ` (sớm hơn lịch ${proposal.scheduleAt?.toISOString()})` : ''}`)

    const fresh = await db.selfDirectionProposal.findUnique({ where: { id } })
    return NextResponse.json({ ok: true, proposal: fresh ?? proposal })
  } catch (err) {
    console.error('[SelfDirection] POST deploy error:', err)
    return NextResponse.json({ error: 'Không kích hoạt được triển khai' }, { status: 500 })
  }
}
