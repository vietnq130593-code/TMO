/**
 * /api/research/missions/[id]/decompose — POST KING DECOMPOSE — TB-13 §2.2
 * ==============================================================================
 * Spec:
 *  - TB-13 §2.2 — API route KING DECOMPOSE mission → parts/tasks.
 *  - TB-07 §2 + §2.5 — decompose playbook + task .md template.
 *  - Gate council ① (TC-13 — Success Criteria BẮT BUỘC trước ASSIGN).
 *
 * Behavior:
 *  POST /api/research/missions/[id]/decompose
 *    → 200 { status:'ok', parts, council1Verdict, escalated }
 *    → 404 if mission null
 *    → 400 if mission status không phải TRIAGING/DECOMPOSING
 *
 * Fail-open: wrap try/catch — LLM error → 200 với parts=[], escalated=true.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getMission } from '@/lib/research-team/mission-store'
import { decomposeMission } from '@/lib/research-team/king/decompose'

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

    // 2. Validate status — chỉ decompose khi TRIAGING hoặc DECOMPOSING (idempotent retry)
    const validStatuses = ['TRIAGING', 'DECOMPOSING']
    if (!validStatuses.includes(existing.status)) {
      return NextResponse.json(
        {
          status: 'error',
          error: `Mission ${id} status '${existing.status}' không hợp lệ — DECOMPOSE chỉ áp dụng cho ${validStatuses.join(' / ')}`,
        },
        { status: 400 },
      )
    }

    // 3. Decompose
    const result = await decomposeMission(id)

    return NextResponse.json({
      status: 'ok',
      parts: result.parts,
      council1Verdict: result.council1Verdict,
      escalated: result.escalated,
      worklog: result.worklog,
    })
  } catch (err) {
    console.error('[ResearchMissions:id:decompose] POST error:', err)
    return NextResponse.json(
      {
        status: 'error',
        error: err instanceof Error ? err.message : 'Lỗi không xác định',
      },
      { status: 500 },
    )
  }
}
