/**
 * /api/research/proposals/[id]/apply — POST applyProposal (Task 3-fix WORK 7e)
 * =================================================================================
 * Spec:
 *  - TASK 3-fix WORK 7e (audit B.13 fix): trước đây không có endpoint apply
 *    → UI không thể trigger applyProposal (APPROVED → APPLIED). Giờ POST
 *    /apply gọi applyProposal — merge branch + bridge self-direction.
 *
 * Behavior:
 *  POST /api/research/proposals/[id]/apply { force?: boolean }
 *    → 200 { status:'ok', proposal, merged, mergeError? }
 *    → 404 nếu proposal null
 *    → 400 nếu status ≠ APPROVED (chỉ APPROVED mới apply được)
 *    → 500 nếu applyProposal throw (KHÔNG crash app)
 *
 * Next.js 16 App Router: params là Promise (await bắt buộc).
 */

import { NextRequest, NextResponse } from 'next/server'
import { applyProposal, getProposal } from '@/lib/research-team/proposal/store'

export const dynamic = 'force-dynamic'

interface RouteContext {
  params: Promise<{ id: string }>
}

interface ApplyBody {
  force?: boolean
}

export async function POST(req: NextRequest, { params }: RouteContext) {
  const { id } = await params

  let body: ApplyBody = {}
  try {
    body = (await req.json()) as ApplyBody
  } catch {
    // Body optional — accept empty
  }
  void body.force // future: bypass merge check (currently no-op)

  try {
    // 1. Check proposal exists
    const existing = await getProposal(id)
    if (!existing) {
      return NextResponse.json(
        { status: 'error', error: `Proposal ${id} không tồn tại` },
        { status: 404 },
      )
    }

    // 2. Validate status === 'APPROVED' (chỉ APPROVED mới apply được)
    if (existing.status !== 'APPROVED') {
      return NextResponse.json(
        {
          status: 'error',
          error: `Proposal ${id} status=${existing.status} — chỉ APPROVED mới apply được (TB-11 §3)`,
        },
        { status: 400 },
      )
    }

    // 3. Apply proposal — merge branch (fail-open) + bridge self-direction
    const result = await applyProposal(id)

    return NextResponse.json({
      status: 'ok',
      proposal: result.proposal,
      merged: result.merged,
      mergeError: result.mergeError,
    })
  } catch (err) {
    console.error('[ResearchProposals:apply] POST error:', err)
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes('không tồn tại')) {
      return NextResponse.json({ status: 'error', error: msg }, { status: 404 })
    }
    if (msg.includes('status=')) {
      return NextResponse.json({ status: 'error', error: msg }, { status: 400 })
    }
    return NextResponse.json({ status: 'error', error: msg }, { status: 500 })
  }
}
