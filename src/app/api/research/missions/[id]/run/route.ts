/**
 * /api/research/missions/[id]/run — POST kingFullLifecycle (Task 3-fix WORK 7d)
 * =================================================================================
 * Spec:
 *  - TASK 3-fix WORK 7d (audit B.11 fix): trước đây không có endpoint run
 *    lifecycle → UI không thể trigger kingFullLifecycle. Giờ POST /run gọi
 *    kingFullLifecycle — wired G1/G2/G3 + Tournament (WORK 3).
 *
 * Behavior:
 *  POST /api/research/missions/[id]/run
 *    → 200 { status:'ok', mission, finalReport, parts, errors }
 *    → 404 nếu mission null
 *    → 400 nếu status FINALIZED (đã terminal — không re-run)
 *    → 500 nếu kingFullLifecycle throw (KHÔNG crash app — LLM fail-open)
 *
 * LLM fail-open (NIM placeholder): errors array ghi 'LLM unavailable' nhưng
 * pipeline structure đúng (G1/G2/G3 đã chạy, không còn dead code).
 *
 * Next.js 16 App Router: params là Promise (await bắt buộc).
 */

import { NextRequest, NextResponse } from 'next/server'
import { getMission } from '@/lib/research-team/mission-store'
import { kingFullLifecycle } from '@/lib/research-team/king/engine'

export const dynamic = 'force-dynamic'

interface RouteContext {
  params: Promise<{ id: string }>
}

export async function POST(_req: NextRequest, { params }: RouteContext) {
  const { id } = await params

  try {
    // 1. Check mission exists
    const existing = await getMission(id)
    if (!existing) {
      return NextResponse.json(
        { status: 'error', error: `Mission ${id} không tồn tại` },
        { status: 404 },
      )
    }

    // 2. Validate status — không re-run nếu FINALIZED (terminal)
    if (existing.status === 'FINALIZED') {
      return NextResponse.json(
        {
          status: 'error',
          error: `Mission ${id} đã FINALIZED (terminal) — không re-run. Tạo mission mới hoặc PATCH status='RESEARCHING' để re-RESEARCHING.`,
        },
        { status: 400 },
      )
    }

    // 3. Run kingFullLifecycle — wired G1/G2/G3 + Tournament (WORK 3).
    //    Wrap try/catch — LLM fail-open (NIM placeholder) → errors array
    //    ghi 'LLM unavailable' nhưng KHÔNG crash app.
    const result = await kingFullLifecycle(id)

    return NextResponse.json({
      status: 'ok',
      mission: result.mission,
      finalReport: result.finalReport,
      parts: result.parts,
      errors: result.errors,
    })
  } catch (err) {
    console.error('[ResearchMissions:run] POST error:', err)
    return NextResponse.json(
      {
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    )
  }
}
