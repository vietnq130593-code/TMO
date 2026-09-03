/**
 * /api/research/missions/[id]/monitor — POST NEMESIS MONITOR — TB-13 §2.2
 * =====================================================================
 * Spec:
 *  - TB-13 §2.2 — API route NEMESIS MONITOR vòng: đọc worklog G1/G2/G3 + KB capture + PIVOT check.
 *  - TB-06 §5 — MONITOR phase: PIVOT triggers 🔴/🟡 (TC-09 reason BẮT BUỘC).
 *  - TB-08 §7 quy tắc vàng #2 — TC-08: mọi tier đều capture tại MONITOR.
 *
 * Behavior:
 *  POST /api/research/missions/[id]/monitor
 *    → 200 { status:'ok', worklog, captured, pivotTriggered, pivotReason }
 *    → 404 if mission null
 *    → 400 if mission status không hợp lệ
 *
 * Fail-open: wrap try/catch — LLM/DB error → 200 với captured=[], pivotTriggered=false.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getMission } from '@/lib/research-team/mission-store'
import { kingMonitor } from '@/lib/research-team/king/engine'

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

    // 2. Validate status — MONITOR hợp lệ từ RESEARCHING/MONITORING/DECOMPOSING
    const validStatuses = ['RESEARCHING', 'MONITORING', 'DECOMPOSING', 'ESCALATED']
    if (!validStatuses.includes(existing.status)) {
      return NextResponse.json(
        {
          status: 'error',
          error: `Mission ${id} status '${existing.status}' không hợp lệ — MONITOR chỉ áp dụng cho ${validStatuses.join(' / ')}`,
        },
        { status: 400 },
      )
    }

    // 3. Run NEMESIS MONITOR
    const result = await kingMonitor(id)

    return NextResponse.json({
      status: 'ok',
      worklog: result.worklog,
      captured: result.captured,
      pivotTriggered: result.pivotTriggered,
      pivotReason: result.pivotReason,
    })
  } catch (err) {
    console.error('[ResearchMissions:id:monitor] POST error:', err)
    return NextResponse.json(
      {
        status: 'error',
        error: err instanceof Error ? err.message : 'Lỗi không xác định',
      },
      { status: 500 },
    )
  }
}
