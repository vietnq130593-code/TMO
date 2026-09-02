/**
 * /api/research/missions/[id]/finalize — POST KING FINALIZE — TB-13 §2.2
 * ======================================================================
 * Spec:
 *  - TB-13 §2.2 — API route KING FINALIZE: tổng hợp final report + council ④ + KB capture.
 *  - TB-06 §9 — FINALIZE phase: M1 final report / M2 Proposal.
 *  - TB-08 §7 quy tắc vàng #2 — TC-08: mọi tier đều capture tại FINALIZE.
 *  - DR-C5 §C5 — KING cấm tự duyệt Proposal (council ④ verify nhưng USER/deputy duyệt).
 *
 * Behavior:
 *  POST /api/research/missions/[id]/finalize
 *    → 200 { status:'ok', finalReport, proposalItems, council4Verdict, captured }
 *    → 404 if mission null
 *    → 400 if mission status không hợp lệ
 *  Transition → FINALIZED (if council ④ PASS).
 *
 * Fail-open: wrap try/catch — LLM error → 200 với finalReport='(LLM unavailable...)'.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getMission } from '@/lib/research-team/mission-store'
import { kingFinalize } from '@/lib/research-team/king/engine'

export const dynamic = 'force-dynamic'

interface RouteContext {
  params: Promise<{ id: string }>
}

export async function POST(_req: NextRequest, { params }: RouteContext) {
  const { id } = await params

  try {
    // 1. Check mission tồn tại (404 friendly)
    const existing = await getMission(id)
    if (!existing) {
      return NextResponse.json(
        { status: 'error', error: `Mission ${id} không tồn tại` },
        { status: 404 },
      )
    }

    // 2. Validate status — FINALIZE hợp lệ từ RESEARCHING/MONITORING/ESCALATED
    const validStatuses = ['RESEARCHING', 'MONITORING', 'ESCALATED', 'FINALIZED']
    if (!validStatuses.includes(existing.status)) {
      return NextResponse.json(
        {
          status: 'error',
          error: `Mission ${id} status '${existing.status}' không hợp lệ — FINALIZE chỉ áp dụng cho ${validStatuses.join(' / ')}`,
        },
        { status: 400 },
      )
    }

    // 3. Run KING FINALIZE
    const result = await kingFinalize(id)

    return NextResponse.json({
      status: 'ok',
      finalReport: result.finalReport,
      proposalItems: result.proposalItems,
      council4Verdict: result.council4Verdict,
      captured: result.captured,
    })
  } catch (err) {
    console.error('[ResearchMissions:id:finalize] POST error:', err)
    return NextResponse.json(
      {
        status: 'error',
        error: err instanceof Error ? err.message : 'Lỗi không xác định',
      },
      { status: 500 },
    )
  }
}
