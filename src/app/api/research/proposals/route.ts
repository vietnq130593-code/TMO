/**
 * /api/research/proposals — GET (list) + POST (create/submit) — TB-13 §2.2
 * =====================================================================
 * Spec:
 *  - TB-13 §2.2 — API route proposals lifecycle.
 *  - TB-11 §1 — Proposal schema (code P-YYYYMMDD-NNN, title, summary, changes[], verificationPlan[]).
 *  - TB-11 §3 — Lifecycle: DRAFT → SUBMITTED → APPROVED → APPLIED (+ REJECTED).
 *  - DR-C5 §C5 — SUBMITTED triggers timeoutAt (48h T3 / 24h T2/T1) + deputy on timeout.
 *
 * Behavior:
 *  GET  /api/research/proposals?missionId=&status=&limit=&offset=
 *      → 200 { status:'ok', proposals: DecodedResearchProposal[], total, limit, offset }
 *  POST /api/research/proposals { missionId, title, summary, changes[], verificationPlan[], ... }
 *      → 201 { status:'ok', proposal }
 *      → 400 nếu thiếu required field.
 *  POST /api/research/proposals { action:'submit', id }
 *      → 200 { status:'ok', proposal } (DRAFT → SUBMITTED — tạo branch + timeoutAt)
 *
 * Manual validation (match P3 worklog route style — zod v4 in node_modules but optional).
 * Fail-open: DB error → 500 graceful (KHÔNG crash).
 */

import { NextRequest, NextResponse } from 'next/server'
import {
  createProposal,
  submitProposal,
  listProposals,
  countProposals,
  type ResearchProposalInput,
} from '@/lib/research-team/proposal/store'
import type { ProposalStatusValue } from '@/lib/research-team/types'

export const dynamic = 'force-dynamic'

// ============================================================
// §1. GET — LIST PROPOSALS
// ============================================================

const VALID_STATUSES: ProposalStatusValue[] = [
  'DRAFT',
  'SUBMITTED',
  'APPROVED',
  'REJECTED',
  'APPLIED',
]

export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url)
    const missionId = url.searchParams.get('missionId') || undefined
    const statusRaw = url.searchParams.get('status') || undefined
    const limitRaw = Number(url.searchParams.get('limit') ?? '50')
    const offsetRaw = Number(url.searchParams.get('offset') ?? '0')

    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 200) : 50
    const offset = Number.isFinite(offsetRaw) ? Math.max(offsetRaw, 0) : 0

    // Validate status filter
    const status =
      statusRaw && VALID_STATUSES.includes(statusRaw as ProposalStatusValue)
        ? (statusRaw as ProposalStatusValue)
        : undefined

    const filter = { missionId, status, limit, offset }
    const [proposals, total] = await Promise.all([
      listProposals(filter),
      countProposals(filter),
    ])

    return NextResponse.json({
      status: 'ok',
      proposals,
      total,
      limit,
      offset,
    })
  } catch (err) {
    console.error('[ResearchProposals] GET list error:', err)
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
// §2. POST — CREATE / SUBMIT PROPOSAL
// ============================================================

interface CreateBody {
  missionId: string
  title: string
  summary: string
  changes: string[]
  verificationPlan: string[]
  pocRef?: string
  diffSummary?: string
}

interface SubmitBody {
  action: 'submit'
  id: string
  /** Optional branchName override (else auto-build từ code). */
  branchName?: string
}

interface ListBody {
  action: 'list'
  missionId?: string
  status?: ProposalStatusValue
  limit?: number
  offset?: number
}

type PostBody = Partial<CreateBody> & Partial<SubmitBody> & Partial<ListBody>

export async function POST(req: NextRequest) {
  let body: PostBody
  try {
    body = (await req.json()) as PostBody
  } catch {
    return NextResponse.json(
      { status: 'error', error: 'Body JSON không hợp lệ' },
      { status: 400 },
    )
  }

  // ---------- BRANCH 1: action='submit' (DRAFT → SUBMITTED) ----------
  if (body.action === 'submit') {
    if (!body.id || typeof body.id !== 'string') {
      return NextResponse.json(
        { status: 'error', error: 'action=submit cần trường "id" (proposal id)' },
        { status: 400 },
      )
    }
    try {
      const proposal = await submitProposal(body.id, body.branchName)
      return NextResponse.json({ status: 'ok', proposal })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('không tồn tại')) {
        return NextResponse.json({ status: 'error', error: msg }, { status: 404 })
      }
      // Status không hợp lệ (e.g. SUBMITTED → SUBMITTED) → 400
      if (msg.includes('status=')) {
        return NextResponse.json({ status: 'error', error: msg }, { status: 400 })
      }
      console.error('[ResearchProposals] POST submit error:', err)
      return NextResponse.json({ status: 'error', error: msg }, { status: 500 })
    }
  }

  // ---------- BRANCH 2: action='list' (explicit list via POST — rare) ----------
  if (body.action === 'list') {
    try {
      const filter = {
        missionId: body.missionId,
        status: body.status,
        limit: body.limit,
        offset: body.offset,
      }
      const [proposals, total] = await Promise.all([
        listProposals(filter),
        countProposals(filter),
      ])
      return NextResponse.json({ status: 'ok', proposals, total })
    } catch (err) {
      console.error('[ResearchProposals] POST list error:', err)
      return NextResponse.json(
        { status: 'error', error: err instanceof Error ? err.message : String(err) },
        { status: 500 },
      )
    }
  }

  // ---------- BRANCH 3: CREATE (default — body có missionId + title) ----------
  // Validate required fields
  if (!body.missionId || typeof body.missionId !== 'string') {
    return NextResponse.json(
      { status: 'error', error: 'Trường "missionId" bắt buộc và phải là chuỗi' },
      { status: 400 },
    )
  }
  if (!body.title || typeof body.title !== 'string' || !body.title.trim()) {
    return NextResponse.json(
      { status: 'error', error: 'Trường "title" bắt buộc và không được rỗng' },
      { status: 400 },
    )
  }
  if (!body.summary || typeof body.summary !== 'string' || !body.summary.trim()) {
    return NextResponse.json(
      { status: 'error', error: 'Trường "summary" bắt buộc và không được rỗng' },
      { status: 400 },
    )
  }
  if (!Array.isArray(body.changes) || body.changes.length === 0) {
    return NextResponse.json(
      { status: 'error', error: 'Trường "changes" phải là string[] non-empty (TB-11 §1)' },
      { status: 400 },
    )
  }
  if (!Array.isArray(body.verificationPlan) || body.verificationPlan.length === 0) {
    return NextResponse.json(
      {
        status: 'error',
        error: 'Trường "verificationPlan" phải là string[] non-empty (TB-11 §7 (a)+(b))',
      },
      { status: 400 },
    )
  }

  try {
    const proposal = await createProposal({
      missionId: body.missionId,
      title: body.title,
      summary: body.summary,
      changes: body.changes,
      verificationPlan: body.verificationPlan,
      pocRef: body.pocRef,
      diffSummary: body.diffSummary,
    })
    return NextResponse.json({ status: 'ok', proposal }, { status: 201 })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes('mission') && msg.includes('không tồn tại')) {
      return NextResponse.json({ status: 'error', error: msg }, { status: 404 })
    }
    // Validation errors (missing field, etc.) → 400
    if (msg.startsWith('createProposal:')) {
      return NextResponse.json({ status: 'error', error: msg }, { status: 400 })
    }
    console.error('[ResearchProposals] POST create error:', err)
    return NextResponse.json({ status: 'error', error: msg }, { status: 500 })
  }
}
