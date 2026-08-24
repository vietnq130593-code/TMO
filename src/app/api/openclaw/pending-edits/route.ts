/**
 * Pending Edits API — Phase 4.4
 *
 * Spec: docs/FULLSTACK_CAPABILITY_PLAN_V2.md Phase 4.4 (line 252)
 *
 * GET  /api/openclaw/pending-edits              — list pending edits (optionally filtered by sessionId)
 * POST /api/openclaw/pending-edits              — create a new pending edit
 * POST /api/openclaw/pending-edits?action=approve    — approve (body: {id, reviewerId}) → status='approved'
 * POST /api/openclaw/pending-edits?action=reject     — reject  (body: {id, reviewerId}) → status='rejected'
 * POST /api/openclaw/pending-edits?action=apply      — apply   (body: {id}) → writes to filesystem, status='applied'
 *
 * The approve/reject/apply lifecycle is split per the Phase 4.4 spec so user
 * can review (approve) before the edit touches the filesystem (apply).
 */

import { NextRequest, NextResponse } from 'next/server'
import { getWorkspaceManager } from '@/lib/workspace/workspace-manager'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  try {
    const url = new URL(request.url)
    const sessionId = url.searchParams.get('sessionId')
    const status = url.searchParams.get('status') // 'pending' | 'approved' | 'rejected' | 'applied' | 'all'

    // If status provided, query by status instead of just 'pending'
    if (status && status !== 'all') {
      const records = await db.pendingEdit.findMany({
        where: sessionId ? { sessionId, status } : { status },
        orderBy: { createdAt: 'desc' },
        take: 200,
      })
      return NextResponse.json({ ok: true, edits: records, count: records.length })
    }

    const wm = getWorkspaceManager()
    const edits = sessionId
      ? await wm.getPendingEditsBySession(sessionId)
      : await wm.listPendingEdits()

    return NextResponse.json({ ok: true, edits, count: edits.length })
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 },
    )
  }
}

export async function POST(request: NextRequest) {
  try {
    const url = new URL(request.url)
    const action = url.searchParams.get('action') // 'approve' | 'reject' | 'apply' (or omitted → create)
    const body = await request.json().catch(() => ({}))

    const wm = getWorkspaceManager()

    if (!action) {
      // ===== Create new pending edit (default POST body) =====
      const { sessionId, filePath, newContent, agentName, workspaceRootPath, operation, riskLevel, reviewerId } = body
      if (!sessionId || !filePath || !newContent || !agentName || !workspaceRootPath) {
        return NextResponse.json(
          { ok: false, error: 'Required fields: sessionId, filePath, newContent, agentName, workspaceRootPath' },
          { status: 400 },
        )
      }
      const edit = await wm.createPendingEdit({
        sessionId, filePath, newContent, agentName, workspaceRootPath,
        operation, riskLevel, reviewerId,
      })
      return NextResponse.json({ ok: true, edit })
    }

    if (action === 'approve') {
      const { id, reviewerId } = body
      if (!id || !reviewerId) {
        return NextResponse.json(
          { ok: false, error: 'approve requires { id, reviewerId }' },
          { status: 400 },
        )
      }
      const edit = await wm.approvePendingEditSpec(String(id), String(reviewerId))
      return NextResponse.json({ ok: true, edit })
    }

    if (action === 'reject') {
      const { id, reviewerId } = body
      if (!id || !reviewerId) {
        return NextResponse.json(
          { ok: false, error: 'reject requires { id, reviewerId }' },
          { status: 400 },
        )
      }
      const edit = await wm.rejectPendingEditSpec(String(id), String(reviewerId))
      return NextResponse.json({ ok: true, edit })
    }

    if (action === 'apply') {
      const { id } = body
      if (!id) {
        return NextResponse.json(
          { ok: false, error: 'apply requires { id }' },
          { status: 400 },
        )
      }
      const edit = await wm.applyPendingEdit(String(id))
      return NextResponse.json({ ok: true, edit })
    }

    return NextResponse.json(
      { ok: false, error: `Unknown action: ${action}. Valid: approve, reject, apply, (empty=create)` },
      { status: 400 },
    )
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 },
    )
  }
}
