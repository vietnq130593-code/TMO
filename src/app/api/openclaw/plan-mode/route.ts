/**
 * Plan Mode API — Phase 4.5
 *
 * Spec: docs/FULLSTACK_CAPABILITY_PLAN_V2.md Phase 4.5 (lines 252-263)
 *
 * GET  /api/openclaw/plan-mode                          — list all pending plans
 * GET  /api/openclaw/plan-mode?planId=<planId>          — get a specific plan
 * POST /api/openclaw/plan-mode?action=approve            — approve (body: {planId, sessionId}) → status='approved'
 * POST /api/openclaw/plan-mode?action=reject             — reject  (body: {planId, sessionId}) → status='rejected'
 * POST /api/openclaw/plan-mode?action=modify             — modify  (body: {planId, sessionId, modifications}) → status='approved' with modifications applied
 *
 * Plans are stored in CodeTeamSession.partsDefinition (JSON array carrier
 * field) — each plan is one entry tagged with type='pending_plan'. This avoids
 * introducing a new Prisma model just for plan-mode (we already have
 * CodeTeamSession + partsDefinition carrying JSON metadata).
 */

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

interface PendingPlanEntry {
  planId: string
  type: 'pending_plan'
  plan: string
  filesToModify: string[]
  riskLevel: 'low' | 'medium' | 'high'
  status: 'pending' | 'approved' | 'rejected'
  modifications?: string
  createdAt: string
  resolvedAt?: string
}

/**
 * Load the partsDefinition array from a CodeTeamSession row, parse it, and
 * return only the pending_plan entries.
 */
async function loadPendingPlans(sessionId?: string): Promise<{ session: string; parts: PendingPlanEntry[] }[]> {
  const sessions = sessionId
    ? await db.codeTeamSession.findMany({ where: { sessionId } })
    : await db.codeTeamSession.findMany({ take: 200 })
  return sessions.map(s => {
    let parts: unknown[]
    try { parts = JSON.parse(s.partsDefinition || '[]') } catch { parts = [] }
    if (!Array.isArray(parts)) parts = []
    const plans = parts.filter((p): p is PendingPlanEntry =>
      typeof p === 'object' && p !== null && (p as PendingPlanEntry).type === 'pending_plan')
    return { session: s.sessionId, parts: plans }
  }).filter(s => s.parts.length > 0)
}

/**
 * Update a single pending plan entry's status. The planId identifies which
 * entry in the partsDefinition array to mutate.
 */
async function updatePlanStatus(
  sessionId: string,
  planId: string,
  update: Partial<PendingPlanEntry>,
): Promise<PendingPlanEntry | null> {
  const session = await db.codeTeamSession.findUnique({ where: { sessionId } })
  if (!session) return null
  let parts: unknown[]
  try { parts = JSON.parse(session.partsDefinition || '[]') } catch { parts = [] }
  if (!Array.isArray(parts)) parts = []

  let updated: PendingPlanEntry | null = null
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i] as PendingPlanEntry
    if (p && typeof p === 'object' && p.type === 'pending_plan' && p.planId === planId) {
      parts[i] = { ...p, ...update, resolvedAt: new Date().toISOString() }
      updated = parts[i] as PendingPlanEntry
      break
    }
  }

  if (!updated) return null
  await db.codeTeamSession.update({
    where: { sessionId },
    data: { partsDefinition: JSON.stringify(parts) },
  })
  return updated
}

export async function GET(request: NextRequest) {
  try {
    const url = new URL(request.url)
    const sessionId = url.searchParams.get('sessionId') || undefined
    const planId = url.searchParams.get('planId')

    const grouped = await loadPendingPlans(sessionId)
    if (planId) {
      // Filter down to just that plan
      const all = grouped.flatMap(g => g.parts)
      const plan = all.find(p => p.planId === planId)
      if (!plan) {
        return NextResponse.json({ ok: false, error: `Plan not found: ${planId}` }, { status: 404 })
      }
      return NextResponse.json({ ok: true, plan })
    }
    return NextResponse.json({ ok: true, groups: grouped })
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
    const action = url.searchParams.get('action') // 'approve' | 'reject' | 'modify'
    const body = await request.json().catch(() => ({}))
    const { planId, sessionId, modifications } = body

    if (!planId || !sessionId) {
      return NextResponse.json(
        { ok: false, error: 'Required body fields: planId, sessionId' },
        { status: 400 },
      )
    }

    if (action === 'approve') {
      const updated = await updatePlanStatus(String(sessionId), String(planId), { status: 'approved' })
      if (!updated) {
        return NextResponse.json({ ok: false, error: `Plan not found: ${planId} in session ${sessionId}` }, { status: 404 })
      }
      return NextResponse.json({ ok: true, plan: updated })
    }

    if (action === 'reject') {
      const updated = await updatePlanStatus(String(sessionId), String(planId), { status: 'rejected' })
      if (!updated) {
        return NextResponse.json({ ok: false, error: `Plan not found: ${planId} in session ${sessionId}` }, { status: 404 })
      }
      return NextResponse.json({ ok: true, plan: updated })
    }

    if (action === 'modify') {
      if (!modifications) {
        return NextResponse.json(
          { ok: false, error: 'modify requires { planId, sessionId, modifications }' },
          { status: 400 },
        )
      }
      const updated = await updatePlanStatus(String(sessionId), String(planId), {
        status: 'approved',
        modifications: String(modifications),
      })
      if (!updated) {
        return NextResponse.json({ ok: false, error: `Plan not found: ${planId} in session ${sessionId}` }, { status: 404 })
      }
      return NextResponse.json({ ok: true, plan: updated })
    }

    return NextResponse.json(
      { ok: false, error: `Unknown action: ${action}. Valid: approve, reject, modify` },
      { status: 400 },
    )
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 },
    )
  }
}
