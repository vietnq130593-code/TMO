/**
 * SELF-DIRECTION PROPOSALS API
 * ====================================
 * GET  /api/self-direction/proposals          — Danh sách đề xuất + settings
 *      (kèm side-effects: promote đề xuất đến hạn, kick Opus auto-review
 *       nếu ủy quyền đang bật — fire-and-forget, không block response)
 * POST /api/self-direction/proposals          — Tạo đề xuất mới (user/agent)
 */

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import {
  getSelfDirectionSettings,
  promoteDueProposals,
  autoReviewPendingIfDelegated,
  validateProposalInput,
  isOrchestrating,
  createSelfDirectionProposal,
} from '@/lib/self-direction/orchestrator'
import { ensureDbReady } from '@/lib/db-setup'

export const dynamic = 'force-dynamic'

/** Proposal row → shape JSON cho UI (kèm step counts) */
async function serializeProposals(rows: Array<{
  id: string; title: string; category: string; priority: string
  problem: string; solution: string; implementation: string
  scheduleAt: Date | null; impact: string | null; status: string
  source: string; createdBy: string; userNotes: string | null
  reviewer: string | null; decisionReason: string | null; reviewedAt: Date | null
  planSummary: string | null; omegaReport: string | null
  executedAt: Date | null; completedAt: Date | null
  createdAt: Date; updatedAt: Date
  /** CI-6 B5: llm | code-workflow (spread ...r truyền đủ field về UI) */
  executionMode?: string
}>) {
  const ids = rows.map(r => r.id)
  const steps = ids.length > 0
    ? await db.proposalStep.groupBy({
        by: ['proposalId', 'status'],
        where: { proposalId: { in: ids } },
        _count: { _all: true },
      }).catch(() => [])
    : []
  const totalByProposal = new Map<string, number>()
  const doneByProposal = new Map<string, number>()
  for (const s of steps as Array<{ proposalId: string; status: string; _count: { _all: number } }>) {
    totalByProposal.set(s.proposalId, (totalByProposal.get(s.proposalId) || 0) + s._count._all)
    if (s.status === 'done') doneByProposal.set(s.proposalId, (doneByProposal.get(s.proposalId) || 0) + s._count._all)
  }
  return rows.map(r => ({
    ...r,
    stepCount: totalByProposal.get(r.id) || 0,
    doneSteps: doneByProposal.get(r.id) || 0,
    orchestrating: isOrchestrating(r.id),
  }))
}

export async function GET() {
  try {
    // Side-effects (fire-and-forget, fail-open): promote đến hạn + Opus auto-review
    // (user decision #3: ủy quyền duyệt chuyển từ Omega sang Opus)
    void promoteDueProposals()
    void autoReviewPendingIfDelegated()

    const rows = await db.selfDirectionProposal.findMany({
      orderBy: [{ createdAt: 'desc' }],
      take: 200,
    })

    const [proposals, settings] = await Promise.all([
      serializeProposals(rows),
      getSelfDirectionSettings(),
    ])

    return NextResponse.json({ proposals, settings })
  } catch (err) {
    // Self-heal: bảng chưa tồn tại (prisma client stale) → ensureDbReady + retry 1 lần
    try {
      await ensureDbReady({ force: true })
      const rows = await db.selfDirectionProposal.findMany({
        orderBy: [{ createdAt: 'desc' }],
        take: 200,
      })
      const [proposals, settings] = await Promise.all([
        serializeProposals(rows),
        getSelfDirectionSettings(),
      ])
      return NextResponse.json({ proposals, settings })
    } catch (retryErr) {
      console.error('[SelfDirection] GET proposals error:', retryErr)
      return NextResponse.json({ error: 'Không tải được danh sách đề xuất' }, { status: 500 })
    }
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
    const validated = validateProposalInput(body)
    if (!validated.ok) {
      return NextResponse.json({ error: validated.error }, { status: 400 })
    }
    // CI-6 B5: validated.data kèm executionMode ('llm' mặc định / 'code-workflow'
    // khi client gửi tường minh) — createSelfDirectionProposal chịu đựng
    // Prisma client cũ (retry không kèm field, fail-open).
    const created = await createSelfDirectionProposal({ ...validated.data, status: 'pending' })

    // Ủy quyền đang bật → Opus review ngay đề xuất mới (fire-and-forget —
    // user decision #3: duyệt chuyển từ Omega sang Opus)
    const settings = await getSelfDirectionSettings()
    if (settings.opusDelegated && created.status === 'pending') {
      const { opusReviewPending } = await import('@/lib/self-direction/orchestrator')
      void opusReviewPending(created.id)
    }

    // scheduleAt đã quá khứ + được duyệt tự động? Không — mới tạo luôn pending, chờ duyệt.
    return NextResponse.json({ proposal: created }, { status: 201 })
  } catch (err) {
    console.error('[SelfDirection] POST proposals error:', err)
    return NextResponse.json({ error: 'Không tạo được đề xuất' }, { status: 500 })
  }
}
