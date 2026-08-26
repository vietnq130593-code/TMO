/**
 * Todos API — Agent Tasks progress (user request 2026-08-29)
 *
 * GET  /api/todos                     — Tổng quan: các session có todo (gần nhất
 *                                        trước), mỗi session kèm summary + todos.
 * GET  /api/todos?sessionId=xxx       — Chi tiết 1 session: todos ordered +
 *                                        byStatus + progress %.
 * DELETE /api/todos?sessionId=xxx     — Xóa toàn bộ todo của 1 session.
 *
 * Dữ liệu do agent ghi qua tool todo_write (Team Code workflow tự động
 * upsert todo mỗi agent step; independent agents gọi tay trong ReAct loop).
 * UI (panel "Agent Tasks" trong tab Code) poll endpoint này 3s/lần.
 */

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

interface TodoSummary {
  total: number
  byStatus: Record<string, number>
  completedPct: number
}

function summarize(todos: Array<{ status: string }>): TodoSummary {
  const byStatus: Record<string, number> = {}
  for (const t of todos) {
    byStatus[t.status] = (byStatus[t.status] || 0) + 1
  }
  const total = todos.length
  const done = byStatus['completed'] || 0
  return { total, byStatus, completedPct: total === 0 ? 0 : Math.round((done / total) * 100) }
}

function serializeTodo(t: {
  id: string; sessionId: string; agentRole: string | null; content: string;
  status: string; priority: string; parentId: string | null; position: number;
  createdAt: Date; updatedAt: Date;
}) {
  return {
    id: t.id,
    sessionId: t.sessionId,
    agentRole: t.agentRole,
    content: t.content,
    status: t.status,
    priority: t.priority,
    parentId: t.parentId,
    position: t.position,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  }
}

export async function GET(request: NextRequest) {
  try {
    const sessionId = request.nextUrl.searchParams.get('sessionId')

    // ===== Chi tiết 1 session =====
    if (sessionId) {
      const todos = await db.todo.findMany({
        where: { sessionId },
        orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
      })
      return NextResponse.json({
        ok: true,
        sessionId,
        summary: summarize(todos),
        todos: todos.map(serializeTodo),
      })
    }

    // ===== Tổng quan: các session có todo (20 session gần nhất) =====
    const sessions = await db.todo.groupBy({
      by: ['sessionId'],
      _count: { _all: true },
      _max: { updatedAt: true },
      orderBy: { _max: { updatedAt: 'desc' } },
      take: 20,
    })

    // Lấy todos của tối đa 5 session "active" gần nhất để UI render ngay
    // không cần gọi chi tiết từng session (các session còn lại chỉ hiện count).
    const activeIds = sessions.slice(0, 5).map(s => s.sessionId)
    const detailRows = activeIds.length > 0
      ? await db.todo.findMany({
          where: { sessionId: { in: activeIds } },
          orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
        })
      : []

    const bySession = new Map<string, typeof detailRows>()
    for (const row of detailRows) {
      const arr = bySession.get(row.sessionId) || []
      arr.push(row)
      bySession.set(row.sessionId, arr)
    }

    return NextResponse.json({
      ok: true,
      sessionCount: sessions.length,
      sessions: sessions.map(s => {
        const rows = bySession.get(s.sessionId) || []
        return {
          sessionId: s.sessionId,
          total: s._count._all,
          lastUpdatedAt: s._max.updatedAt,
          summary: summarize(rows),
          // Chi tiết cho 5 session active gần nhất; session cũ chỉ có summary
          todos: rows.length > 0 ? rows.map(serializeTodo) : undefined,
        }
      }),
    })
  } catch (err) {
    return NextResponse.json({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    }, { status: 500 })
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const sessionId = request.nextUrl.searchParams.get('sessionId')
    if (!sessionId) {
      return NextResponse.json({ ok: false, error: 'sessionId query parameter is required' }, { status: 400 })
    }
    const deleted = await db.todo.deleteMany({ where: { sessionId } })
    return NextResponse.json({ ok: true, deleted: deleted.count })
  } catch (err) {
    return NextResponse.json({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    }, { status: 500 })
  }
}
