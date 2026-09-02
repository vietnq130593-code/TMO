/**
 * /api/research/escalations — GET queue + POST create — TB-13 §2.2
 * =====================================================================
 * Spec:
 *  - TB-13 §2.2 — API route escalations: query timeout + nhắc (cron :3004 register).
 *  - DR-C5 §C5 — Proposal pending timeout 48h/24h + nhắc 12h + deputy SIVIL/HAN.
 *  - KING cấm tự duyệt Proposal (DR-C5 §C5 — assertNotKingSelfApprove).
 *
 * Behavior:
 *  GET /api/research/escalations?status=&missionId=
 *    → 200 { status:'ok', escalations, total }
 *  POST /api/research/escalations { missionId, reason, kind, tier, taskId?, proposalId? }
 *    → 201 { status:'ok', escalation }
 *
 * Fail-open: wrap try/catch — DB error → 200 với empty list / 500 graceful.
 */

import { NextRequest, NextResponse } from 'next/server'
import {
  escalateToUser,
  queryEscalations,
  resolveEscalation,
  assertNotKingSelfApprove,
} from '@/lib/research-team/king/escalation'

export const dynamic = 'force-dynamic'

// ============================================================
// GET — query escalation queue
// ============================================================

export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url)
    const status = url.searchParams.get('status') || undefined
    const missionId = url.searchParams.get('missionId') || undefined

    const { escalations, total } = await queryEscalations({ status, missionId })

    return NextResponse.json({
      status: 'ok',
      escalations,
      total,
      filter: { status: status || null, missionId: missionId || null },
    })
  } catch (err) {
    console.error('[ResearchEscalations] GET error:', err)
    return NextResponse.json(
      {
        status: 'error',
        error: err instanceof Error ? err.message : 'Lỗi không xác định',
      },
      { status: 500 },
    )
  }
}

// ============================================================
// POST — create escalation
// ============================================================

interface EscalateBody {
  missionId?: string
  reason?: string
  kind?: 'mission' | 'proposal'
  tier?: 'T1' | 'T2' | 'T3'
  taskId?: string
  proposalId?: string
  /** Optional: resolve an existing escalation (action='resolve'). */
  action?: 'create' | 'resolve'
  resolvedBy?: string
  decision?: string
}

export async function POST(req: NextRequest) {
  let body: EscalateBody
  try {
    body = (await req.json()) as EscalateBody
  } catch {
    return NextResponse.json(
      { status: 'error', error: 'Body JSON không hợp lệ' },
      { status: 400 },
    )
  }

  try {
    // Action: resolve (alternative endpoint — caller explicit)
    if (body.action === 'resolve') {
      if (!body.missionId || !body.resolvedBy || !body.decision) {
        return NextResponse.json(
          {
            status: 'error',
            error: 'action=resolve cần missionId + resolvedBy + decision',
          },
          { status: 400 },
        )
      }
      // DR-C5 §C5 — KING cấm tự duyệt Proposal (assertNotKingSelfApprove)
      try {
        assertNotKingSelfApprove(
          body.resolvedBy,
          body.proposalId ? 'KING' : 'USER',
          body.proposalId,
        )
      } catch (err) {
        return NextResponse.json(
          {
            status: 'error',
            error: err instanceof Error ? err.message : String(err),
          },
          { status: 400 },
        )
      }
      await resolveEscalation(body.missionId, body.resolvedBy, body.decision)
      return NextResponse.json(
        { status: 'ok', resolved: { missionId: body.missionId, resolvedBy: body.resolvedBy } },
        { status: 200 },
      )
    }

    // Action: create (default)
    if (!body.missionId || !body.reason || !body.kind || !body.tier) {
      return NextResponse.json(
        {
          status: 'error',
          error: 'Body cần có missionId + reason + kind (mission|proposal) + tier (T1|T2|T3)',
        },
        { status: 400 },
      )
    }

    const escalation = await escalateToUser(body.missionId, body.reason, {
      tier: body.tier,
      kind: body.kind,
      taskId: body.taskId,
      proposalId: body.proposalId,
    })

    return NextResponse.json(
      {
        status: 'ok',
        escalation,
      },
      { status: 201 },
    )
  } catch (err) {
    console.error('[ResearchEscalations] POST error:', err)
    const msg = err instanceof Error ? err.message : String(err)
    // Mission not exist → 404
    if (msg.includes('không tồn tại')) {
      return NextResponse.json({ status: 'error', error: msg }, { status: 404 })
    }
    return NextResponse.json(
      { status: 'error', error: msg },
      { status: 500 },
    )
  }
}
