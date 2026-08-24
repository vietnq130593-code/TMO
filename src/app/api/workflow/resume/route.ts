/**
 * Workflow Session Resume API — Phase 5.6 (spec Appendix C)
 *
 * Spec: docs/FULLSTACK_CAPABILITY_PLAN_V2.md lines 723-779 (Appendix C)
 *
 * POST /api/workflow/resume?sessionId=X   — acquire session lock + return resume context
 * GET  /api/workflow/resume?sessionId=X   — return session metadata (no `state` field)
 *
 * Authorization: Bearer <token> header is optional in sandbox mode (any bearer
 * accepted). Production would need real auth middleware — flagged as P3 deferred.
 *
 * Response shapes:
 *   200 — ready to resume:
 *     { sessionId, taskDescription, todoList, lastToolReceipts, currentStep, ready: true }
 *   200 — flag disabled (spec acceptance — be consistent across flag states):
 *     { sessionId, ready: false, reason: 'flag disabled' }
 *   404 — session not found:
 *     { error: 'Session not found' }
 *   409 — concurrent lock conflict:
 *     { error: 'Session locked by another agent' }
 *   400 — sessionId missing:
 *     { error: 'sessionId query param required' }
 */

import { NextRequest, NextResponse } from 'next/server'
import {
  resumeWorkflowSession,
  buildResumeContext,
  getSessionMetadata,
} from '@/lib/orchestration/session-resume'

export const dynamic = 'force-dynamic'

/**
 * Sandbox-only auth check — accepts any Bearer token.
 * Production would verify JWT + check session ownership — P3 deferred per spec.
 */
function sandboxAuthOk(request: NextRequest): boolean {
  const auth = request.headers.get('authorization') || request.headers.get('Authorization')
  if (!auth) return true // sandbox: allow anonymous callers
  if (!auth.toLowerCase().startsWith('bearer ')) return false
  const token = auth.slice(7).trim()
  return token.length > 0
}

export async function POST(request: NextRequest) {
  // Optional auth — sandbox allows anonymous callers
  if (!sandboxAuthOk(request)) {
    return NextResponse.json(
      { error: 'Invalid Authorization header (expected Bearer <token>)' },
      { status: 401 },
    )
  }

  const url = new URL(request.url)
  const sessionId = url.searchParams.get('sessionId')?.trim()
  if (!sessionId) {
    return NextResponse.json(
      { error: 'sessionId query param required' },
      { status: 400 },
    )
  }

  // 1. Atomic check-and-resume (Appendix C.3)
  const resumeResult = await resumeWorkflowSession(sessionId)

  if (resumeResult.flagDisabled) {
    // Flag is off — return ready=false consistently so the caller can decide
    // whether to fall back to a fresh workflow (per spec acceptance).
    return NextResponse.json(
      { sessionId, ready: false, reason: 'flag disabled' },
      { status: 200 },
    )
  }

  if (resumeResult.conflict) {
    // Appendix C.3 line 764: "409 Conflict { error: 'Session locked by another agent' }"
    return NextResponse.json(
      { error: 'Session locked by another agent' },
      { status: 409 },
    )
  }

  if (!resumeResult.ready || !resumeResult.session) {
    // Row not found OR DB error
    return NextResponse.json(
      { error: 'Session not found' },
      { status: 404 },
    )
  }

  // 2. Build resume context (Appendix C.2 / C.4 step 5)
  const ctx = await buildResumeContext(sessionId)

  return NextResponse.json(
    {
      sessionId,
      taskDescription: ctx.taskDescription,
      todoList: ctx.todoList,
      lastToolReceipts: ctx.lastToolReceipts,
      currentStep: ctx.currentStep,
      ready: true,
      // Helpful echo fields for the caller (not strictly in spec but harmless)
      agentRole: resumeResult.session.agentRole,
      status: resumeResult.session.status,
      contextOverflowCount: resumeResult.session.contextOverflowCount,
    },
    { status: 200 },
  )
}

/**
 * GET — return session metadata without the (potentially large) state blob.
 * Appendix C.2 only requires the resume payload for POST; GET is convenience
 * for status polling / debugging / the eventual UI panel.
 */
export async function GET(request: NextRequest) {
  if (!sandboxAuthOk(request)) {
    return NextResponse.json(
      { error: 'Invalid Authorization header (expected Bearer <token>)' },
      { status: 401 },
    )
  }

  const url = new URL(request.url)
  const sessionId = url.searchParams.get('sessionId')?.trim()
  if (!sessionId) {
    return NextResponse.json(
      { error: 'sessionId query param required' },
      { status: 400 },
    )
  }

  const meta = await getSessionMetadata(sessionId)
  if (!meta) {
    return NextResponse.json(
      { error: 'Session not found' },
      { status: 404 },
    )
  }

  return NextResponse.json({ ok: true, session: meta }, { status: 200 })
}
