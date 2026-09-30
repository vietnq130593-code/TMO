/**
 * Todos API — Agent Tasks progress (user request 2026-08-29)
 *
 * GET  /api/todos                     — Tổng quan: các session có todo (gần nhất
 *                                        trước), mỗi session kèm summary + todos.
 * GET  /api/todos?sessionId=xxx       — Chi tiết 1 session: todos ordered +
 *                                        byStatus + progress %.
 * GET  /api/todos?runId=xxx           — CI-2 (Task 11-a): todo của ĐÚNG 1 run
 *                                        (orderBy position asc) — panel của
 *                                        task hiện tại chỉ thấy todo run này,
 *                                        không trộn task cũ. Kết hợp thêm
 *                                        &sessionId= để scope chặt hơn.
 * DELETE /api/todos?sessionId=xxx     — Xóa toàn bộ todo của 1 session.
 *
 * Dữ liệu do agent ghi qua tool todo_write (Team Code workflow tự động
 * upsert todo mỗi agent step; independent agents gọi tay trong ReAct loop).
 * UI (panel "Agent Tasks" trong tab Code) poll endpoint này 3s/lần.
 *
 * DB SELF-HEAL (fix user report 2026-09-12 "The column main.Todo.runId does
 * not exist" → GET /api/todos 500): DB local cũ hơn schema sau git pull →
 * query P2021/P2022 → tự ensureDbReady({force:true}) (prisma db push) rồi
 * THỬ LẠI 1 lần — chữa không cần restart app (pattern /api/agents 2026-09-09).
 */

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { ensureDbReady } from '@/lib/db-setup'
import { withPollCache } from '@/lib/poll-microcache'

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
  runId: string | null; archivedAt: Date | null;
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
    // CI-2 (Task 11-a) — run scope + thời điểm lưu trữ (UI 11-b lọc/ẩn archived)
    runId: t.runId,
    archivedAt: t.archivedAt,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  }
}

/** DB error là schema drift? (P2021/P2022 "column/table does not exist" —
 * DB local cũ sau git pull, thiếu cột mới như Todo.runId CI-2). */
function isDriftDbError(err: unknown): boolean {
  const code = (err as { code?: string }).code
  if (code === 'P2021' || code === 'P2022') return true
  const msg = err instanceof Error ? err.message : String(err)
  return /does not exist in the current database/i.test(msg) ||
    /no such (table|column)/i.test(msg)
}

export async function GET(request: NextRequest) {
  // VÒNG 10 — micro-cache + in-flight dedup: UI poll mỗi ~3s nhưng response có
  // thể 131KB; khi DB bận (mission checkpoint ghi WAL) query chậm → request
  // chồng đống giữ buffer → góp phần RSS ratchet cạn MemAvailable. TTL 2.5s
  // đủ tươi cho progress UI, cắt ~50% tải serialize + query.
  const sessionId = request.nextUrl.searchParams.get('sessionId')
  const runId = request.nextUrl.searchParams.get('runId')
  const cacheKey = `td|${sessionId ?? ''}|${runId ?? ''}`
  return withPollCache(cacheKey, 2500, () => getTodosHandler(request, 0))
}

/** Handler nội bộ với attempt-count: gặp drift → tự heal rồi retry 1 lần. */
async function getTodosHandler(request: NextRequest, attempt: number): Promise<Response> {
  try {
    const sessionId = request.nextUrl.searchParams.get('sessionId')
    // CI-2 (Task 11-a) — filter theo run: todo của ĐÚNG 1 agent run (per-task
    // isolation). Dùng riêng hoặc kèm sessionId. Không có runId → giữ nguyên
    // hành vi cũ (toàn bộ theo session).
    const runId = request.nextUrl.searchParams.get('runId')

    // ===== CI-2 — Chi tiết 1 run (orderBy position asc) =====
    if (runId) {
      const todos = await db.todo.findMany({
        where: sessionId ? { sessionId, runId } : { runId },
        orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
      })
      return NextResponse.json({
        ok: true,
        ...(sessionId ? { sessionId } : {}),
        runId,
        summary: summarize(todos),
        todos: todos.map(serializeTodo),
      })
    }

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
    // SELF-HEAL (2026-09-12): DB drift (DB cũ thiếu Todo.runId...) → tự
    // prisma db push qua ensureDbReady rồi THỬ LẠI ngay trong cùng request.
    if (isDriftDbError(err) && attempt === 0) {
      const healed = await ensureDbReady({ force: true })
      if (healed.ok) {
        console.log('[Todos API] DB đã tự đồng bộ schema — retry GET todos')
        return getTodosHandler(request, 1)
      }
      console.error('[Todos API] Self-heal thất bại:', healed.reason)
      return NextResponse.json({
        ok: false,
        error: `DB schema chưa khớp và không tự sửa được (${healed.reason}). Chạy thủ công: bun run db:push (hoặc npx prisma db push) rồi tải lại trang.`,
      }, { status: 500 })
    }
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
