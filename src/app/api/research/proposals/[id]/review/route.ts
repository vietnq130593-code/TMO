/**
 * /api/research/proposals/[id]/review — POST ESCALATED_USER review (kèm deputy khi timeout) — TB-13 §2.2
 * ====================================================================================================
 * Spec:
 *  - TB-13 §2.2 — API route review (POST APPROVE/REJECT) — DR-C5 §C5 (NEMESIS cấm tự duyệt).
 *  - TB-11 §3 — Lifecycle: SUBMITTED → APPROVED (bridge self-direction) | REJECTED (TC-11).
 *  - DR-C5 §C5 — Proposal pending timeout 48h/24h + deputy SIVIL/HAN khi timeout.
 *      NEMESIS cấm tự duyệt Proposal (assertNotKingSelfApprove).
 *  - TB-12 §3.2 TC-11 — REJECT reason BẮT BUỘC non-empty.
 *
 * Behavior:
 *  POST /api/research/proposals/[id]/review { decision:'APPROVE'|'REJECT', reviewedBy, reason? }
 *    → 200 { status:'ok', proposal, applied?, applyError? }  (APPROVE — applied có thể false do orchestrator/git)
 *    → 200 { status:'ok', proposal }                          (REJECT)
 *    → 400 nếu NEMESIS self-approve (DR-C5 §C5)
 *    → 400 nếu REJECT mà thiếu reason (TC-11)
 *    → 400 nếu deputy khi chưa timeout (chỉ USER/NEMESIS-approved deputy được)
 *    → 404 nếu proposal null
 *    → 400 nếu status không phải SUBMITTED
 *
 * Deputy on timeout (DR-C5 §C5): nếu proposal.timeoutAt < now (expired) + reviewedBy
 * startsWith 'deputy:' → allow (deputy SIVIL/HAN được ủy quyền). Validate deputy via
 * escalation.assignDeputy domain (research → SIVIL; kb → HAN).
 *
 * Next.js 16 App Router: params là Promise (await bắt buộc).
 */

import { NextRequest, NextResponse } from 'next/server'
import {
  approveProposal,
  rejectProposal,
  getProposal,
  checkProposalTimeout,
} from '@/lib/research-team/proposal/store'
import { assertNotKingSelfApprove, assignDeputy } from '@/lib/research-team/king/escalation'

export const dynamic = 'force-dynamic'

interface RouteContext {
  params: Promise<{ id: string }>
}

interface ReviewBody {
  decision?: 'APPROVE' | 'REJECT'
  reviewedBy?: string
  reason?: string
}

// ============================================================
// POST — REVIEW (APPROVE / REJECT)
// ============================================================

export async function POST(req: NextRequest, { params }: RouteContext) {
  const { id } = await params

  let body: ReviewBody
  try {
    body = (await req.json()) as ReviewBody
  } catch {
    return NextResponse.json(
      { status: 'error', error: 'Body JSON không hợp lệ' },
      { status: 400 },
    )
  }

  // 1. Validate body required fields
  if (!body.decision || !['APPROVE', 'REJECT'].includes(body.decision)) {
    return NextResponse.json(
      { status: 'error', error: 'Trường "decision" phải là "APPROVE" hoặc "REJECT"' },
      { status: 400 },
    )
  }
  if (!body.reviewedBy || typeof body.reviewedBy !== 'string' || !body.reviewedBy.trim()) {
    return NextResponse.json(
      { status: 'error', error: 'Trường "reviewedBy" bắt buộc và không được rỗng' },
      { status: 400 },
    )
  }

  const reviewedBy = body.reviewedBy.trim()
  const reason = (body.reason || '').trim()

  try {
    // 2. Check proposal exists
    const proposal = await getProposal(id)
    if (!proposal) {
      return NextResponse.json(
        { status: 'error', error: `Proposal ${id} không tồn tại` },
        { status: 404 },
      )
    }

    // 3. Validate status === 'SUBMITTED' (only SUBMITTED proposals can be reviewed)
    if (proposal.status !== 'SUBMITTED') {
      return NextResponse.json(
        {
          status: 'error',
          error: `Proposal ${id} status=${proposal.status} — chỉ SUBMITTED mới review được (TB-11 §3)`,
        },
        { status: 400 },
      )
    }

    // 4. DR-C5 §C5 — NEMESIS cấm tự duyệt Proposal
    if (reviewedBy === 'NEMESIS') {
      return NextResponse.json(
        {
          status: 'error',
          error:
            'DR-C5 §C5: NEMESIS cấm tự duyệt Proposal (recused). Deputy SIVIL/HAN hoặc USER phải duyệt thay.',
        },
        { status: 400 },
      )
    }

    // 5. Deputy on timeout (DR-C5 §C5): reviewedBy startsWith 'deputy:' chỉ allow khi expired
    if (reviewedBy.startsWith('deputy:')) {
      const deputyName = reviewedBy.slice('deputy:'.length).trim()
      if (!['SIVIL', 'HAN'].includes(deputyName)) {
        return NextResponse.json(
          {
            status: 'error',
            error: `Deputy "${deputyName}" không hợp lệ — chỉ SIVIL hoặc HAN (DR-C5 §C5)`,
          },
          { status: 400 },
        )
      }

      const { expired } = await checkProposalTimeout(id)
      if (!expired) {
        return NextResponse.json(
          {
            status: 'error',
            error:
              `Deputy ${deputyName} chỉ được duyệt khi proposal timeout (DR-C5 §C5). ` +
              `Proposal ${proposal.code} chưa timeout — USER phải duyệt.`,
          },
          { status: 400 },
        )
      }

      // Validate deputy assigned đúng domain (research → SIVIL; kb → HAN)
      // Proposal default = research domain → SIVIL
      const assigned = assignDeputy(proposal.missionId, 'proposal', 'research')
      if (assigned.deputy !== deputyName) {
        return NextResponse.json(
          {
            status: 'error',
            error:
              `Deputy mismatch: proposal domain=research → assigned=${assigned.deputy}, ` +
              `got=${deputyName} (DR-C5 §C5)`,
          },
          { status: 400 },
        )
      }
    }

    // 6. APPROVE / REJECT
    if (body.decision === 'APPROVE') {
      try {
        // assertNotKingSelfApprove đã check ở bước 4 (reviewedBy === 'NEMESIS' trả 400)
        // Pass 'USER' as escalateTo (deputy / user is approving — NOT NEMESIS self-approve)
        assertNotKingSelfApprove(reviewedBy, 'USER', id)
      } catch (err) {
        return NextResponse.json(
          { status: 'error', error: err instanceof Error ? err.message : String(err) },
          { status: 400 },
        )
      }

      const result = await approveProposal(id, reviewedBy)
      return NextResponse.json({
        status: 'ok',
        proposal: result.proposal,
        applied: result.applied,
        applyError: result.applyError,
      })
    } else {
      // REJECT — reason BẮT BUỘC non-empty (TC-11)
      if (!reason) {
        return NextResponse.json(
          {
            status: 'error',
            error:
              'REJECT reason BẮT BUỘC non-empty (TC-11 — TB-12 §3.2 + TB-06 §8.6/8.7)',
          },
          { status: 400 },
        )
      }

      try {
        assertNotKingSelfApprove(reviewedBy, 'USER', id)
      } catch (err) {
        return NextResponse.json(
          { status: 'error', error: err instanceof Error ? err.message : String(err) },
          { status: 400 },
        )
      }

      const rejected = await rejectProposal(id, reviewedBy, reason)

      // TASK 3-fix WORK 5 (audit B.12 fix): sau khi rejectProposal thành công,
      // gọi kingReject(proposal.missionId, reason) để transition mission status
      // FINALIZED → RESEARCHING (TC-11 — TB-12 §3.2). Trước đây REJECT chỉ update
      // Proposal status, mission status KHÔNG chuyển về RESEARCHING → user không
      // biết mission cần re-RESEARCH. Giờ wire đúng spec.
      //
      // Wrap try/catch — kingReject throw nếu mission status ≠ FINALIZED (có thể
      // mission chưa finalize). Catch → log warning, KHÔNG block REJECT response.
      // Mission status transition best-effort.
      try {
        const { kingReject } = await import('@/lib/research-team/king/engine')
        await kingReject(proposal.missionId, reason)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.warn(
          `[ResearchProposals:review] kingReject failed (non-blocking — proposal REJECTED, mission transition best-effort):`,
          msg,
        )
        // Don't fail the REJECT response — proposal đã REJECTED thành công.
        // Caller UI sẽ thấy mission status chưa chuyển (nếu mission chưa FINALIZED)
        // — đó là behavior đúng (TC-11 chỉ apply khi mission FINALIZED).
      }

      return NextResponse.json({
        status: 'ok',
        proposal: rejected,
      })
    }
  } catch (err) {
    console.error('[ResearchProposals:review] POST error:', err)
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes('không tồn tại')) {
      return NextResponse.json({ status: 'error', error: msg }, { status: 404 })
    }
    if (msg.includes('status=') || msg.includes('BẮT BUỘC') || msg.includes('DR-C5')) {
      return NextResponse.json({ status: 'error', error: msg }, { status: 400 })
    }
    return NextResponse.json({ status: 'error', error: msg }, { status: 500 })
  }
}
