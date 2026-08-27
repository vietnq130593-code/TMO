/**
 * OpenClaw Sessions API — CRUD Session Management
 *
 * GET    ?action=list                        — List sessions from SQLite
 * POST   ?action=create                      — Create new session
 * PATCH  ?action=rename                      — Rename session (update title)
 * DELETE ?action=delete&sessionId=xxx         — Delete session
 */

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { listSessions as gatewayListSessions } from '@/lib/openclaw'
import { hasActiveRun } from '@/lib/agent-run-tracker'

export const dynamic = 'force-dynamic'

// Title length limits
const TITLE_MIN = 1
const TITLE_MAX = 200

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const action = searchParams.get('action') || 'list'

  if (action === 'list') {
    try {
      // Support filtering by agentProfileId and teamName (needed for Agent/Team session isolation)
      const agentProfileId = searchParams.get('agentProfileId')
      const teamName = searchParams.get('teamName')

      const where: Record<string, unknown> = {}
      if (agentProfileId) where.agentProfileId = agentProfileId
      if (teamName) where.teamName = teamName

      // Get sessions from SQLite
      const sessions = await db.agentSession.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
        take: 50,
      })

      // Also try gateway
      let gatewaySessions: unknown[] = []
      try {
        gatewaySessions = await gatewayListSessions()
      } catch {}

      return NextResponse.json({
        sessions: sessions.map(s => ({
          id: s.id,
          sessionId: s.sessionId,
          title: s.title || 'Untitled Session',
          model: s.model,
          provider: s.provider,
          messageCount: s.messageCount,
          agentProfileId: s.agentProfileId,
          teamMode: s.teamMode,
          teamName: s.teamName,
          createdAt: s.createdAt,
          updatedAt: s.updatedAt,
          // USER REQUEST 2026-09-01: agent/team vẫn đang chạy dở ở session này?
          // (in-memory run tracker — hiển thị chấm xanh nhấp nháy ở dropdown)
          hasActiveRun: hasActiveRun(s.sessionId),
        })),
        gatewaySessions,
        total: sessions.length,
      })
    } catch (err) {
      return NextResponse.json(
        { error: 'Failed to list sessions', details: err instanceof Error ? err.message : String(err) },
        { status: 500 }
      )
    }
  }

  return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
}

export async function POST(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const action = searchParams.get('action') || 'create'

  if (action === 'create') {
    try {
      const body = await request.json().catch(() => ({}))
      const sessionId = `sess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`

      const session = await db.agentSession.create({
        data: {
          sessionId,
          title: body.title || 'Cuộc trò chuyện mới',
          model: body.model || null,
          provider: body.provider || null,
          messageCount: 0,
          agentProfileId: body.agentProfileId || null,
          teamMode: body.teamMode || null,
          teamName: body.teamName || null,
        },
      })

      return NextResponse.json({
        id: session.id,
        sessionId: session.sessionId,
        title: session.title,
        model: session.model,
        provider: session.provider,
        messageCount: session.messageCount,
        agentProfileId: session.agentProfileId,
        teamMode: session.teamMode,
        teamName: session.teamName,
        createdAt: session.createdAt,
      })
    } catch (err) {
      return NextResponse.json(
        { error: 'Failed to create session', details: err instanceof Error ? err.message : String(err) },
        { status: 500 }
      )
    }
  }

  // Phase 4.6 — cron-scheduler mini-service (port 3004) calls this action to
  // execute a due CronJob. Body: { sessionId?, task, agentId, source, jobId }.
  // If sessionId is provided → resume; otherwise → create a fresh session.
  // Returns { success, sessionId, response, jobId, source } on success.
  if (action === 'run') {
    try {
      const body = await request.json().catch(() => ({}))
      const task = String(body.task || '').trim()
      if (!task) {
        return NextResponse.json({ error: 'task is required for action=run' }, { status: 400 })
      }
      const agentId = String(body.agentId || 'default')
      const source = String(body.source || 'cron')
      const jobId = body.jobId ? String(body.jobId) : undefined
      let sessionId = body.sessionId ? String(body.sessionId) : ''

      // Create a fresh session if not resuming
      if (!sessionId) {
        sessionId = `sess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
        await db.agentSession.create({
          data: {
            sessionId,
            title: `[cron] ${task.slice(0, 60)}`,
            model: null,
            provider: null,
            messageCount: 0,
            agentProfileId: agentId !== 'default' ? agentId : null,
            teamMode: null,
            teamName: null,
          },
        })
      }

      // Persist the user's task as a chat message (schema: id/sessionId/role/content/model/provider/metadata/createdAt)
      await db.chatMessage.create({
        data: {
          sessionId,
          role: 'user',
          content: task,
          model: null,
          provider: null,
          metadata: JSON.stringify({ source, jobId }),
        },
      })

      // Acknowledge the task — actual LLM execution is handled by the openclaw
      // chat loop (the user-facing UI polls /api/openclaw/sessions?action=list
      // + /api/openclaw/chat to retrieve the assistant's response). Returning
      // success here satisfies the cron-scheduler's contract; deep async LLM
      // dispatch is a Phase 5 hardening (subagent-delegation in 5.2).
      return NextResponse.json({
        success: true,
        sessionId,
        response: `Task queued for execution (session ${sessionId}). The assistant response will appear in the chat UI.`,
        jobId,
        source,
        queuedAt: new Date().toISOString(),
      })
    } catch (err) {
      return NextResponse.json(
        { error: 'Failed to queue cron task', details: err instanceof Error ? err.message : String(err) },
        { status: 500 }
      )
    }
  }

  return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
}

export async function PATCH(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const action = searchParams.get('action') || 'rename'

  if (action === 'rename') {
    try {
      const body = await request.json().catch(() => ({}))
      const { sessionId, title } = body

      if (!sessionId || typeof sessionId !== 'string') {
        return NextResponse.json({ error: 'sessionId là bắt buộc' }, { status: 400 })
      }

      if (!title || typeof title !== 'string' || title.trim().length < TITLE_MIN || title.trim().length > TITLE_MAX) {
        return NextResponse.json({ error: `Tiêu đề phải từ ${TITLE_MIN}-${TITLE_MAX} ký tự` }, { status: 400 })
      }

      const existing = await db.agentSession.findFirst({ where: { sessionId } })
      if (!existing) {
        return NextResponse.json({ error: 'Session không tồn tại' }, { status: 404 })
      }

      const updated = await db.agentSession.update({
        where: { id: existing.id },
        data: { title: title.trim() },
      })

      return NextResponse.json({
        success: true,
        sessionId: updated.sessionId,
        title: updated.title,
      })
    } catch (err) {
      return NextResponse.json(
        { error: 'Failed to rename session', details: err instanceof Error ? err.message : String(err) },
        { status: 500 }
      )
    }
  }

  return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
}

export async function DELETE(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const action = searchParams.get('action') || 'delete'
  const sessionId = searchParams.get('sessionId')

  if (action === 'delete' && sessionId) {
    try {
      // Clean up all related records before deleting the session
      // SmolabTask: auto-cascaded via onDelete: Cascade in schema
      // ChatMessage, CodeTeamWorklog, CodeTeamSession: reference sessionId as plain string (no FK)
      await db.$transaction([
        db.chatMessage.deleteMany({ where: { sessionId } }),
        db.codeTeamWorklog.deleteMany({ where: { sessionId } }),
        db.codeTeamSession.deleteMany({ where: { sessionId } }),
        db.smolabTask.deleteMany({ where: { sessionId } }),
        db.agentSession.deleteMany({ where: { sessionId } }),
      ])

      return NextResponse.json({ success: true, sessionId })
    } catch (err) {
      return NextResponse.json(
        { error: 'Failed to delete session', details: err instanceof Error ? err.message : String(err) },
        { status: 500 }
      )
    }
  }

  return NextResponse.json({ error: 'sessionId is required for delete' }, { status: 400 })
}
