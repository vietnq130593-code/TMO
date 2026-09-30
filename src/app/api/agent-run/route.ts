/**
 * Agent Run API — Thought Process + Todos + Progress realtime trong chat.
 *
 * GET /api/agent-run?sessionId=<sid>&limit=12
 *   → { ok: true, runs: AgentRun[], hasActive: boolean }
 *   CI-2 (Task 11-a): mỗi run item gains `todos` — Todo[] của ĐÚNG runId đó
 *   (DB-backed, orderBy position asc, cap 50/run) → panel Thought Process hiển
 *   thị todo CỦA RUN NÀY (per-task isolation — không trộn task cũ). Run mode
 *   team (runId per-step) thường có todos=[] vì step-todo gắn runId=session.
 *
 * POST /api/agent-run { sessionId } — USER REQUEST 2026-08-31 (bấm nút Gửi
 * trong khung chat để DỪNG tác vụ Agents đang chạy):
 *   → { ok: true, cancelled: <số run đang chạy đã bị dừng> }
 *   - Mọi run 'running' của session → status 'cancelled'
 *   - Đặt flag cancel → ReAct loops (chat route + workflow-engine) và chuỗi
 *     xoay vòng key LLM (llm.ts callModelWithKeyRotation) cắt ngang sớm.
 *   - Request GỬI TIẬP THEO của user không bị ảnh hưởng (startAgentRun xóa flag).
 *   - CI-5 (Task 14-c): đồng thời hủy mọi durable goal-loop job của session
 *     (fail-open — response shape không đổi).
 *
 * Nguồn: src/lib/agent-run-tracker.ts (in-memory registry trên globalThis,
 * được ghi bởi ReAct loops — chat route + workflow-engine — và executeTool).
 *
 * Frontend (SmolabModule chat) poll endpoint này mỗi ~1.2s trong lúc agent
 * đang chạy (single chat là stream:false → poll là cơ chế live) và render
 * khối "Thought Process" (mặc định đóng) trong cửa sổ chat:
 *   - Thought của từng vòng ReAct
 *   - Todos list (✓ xong / ◐ đang làm / ○ chờ)
 *   - Timeline tool calls kèm KẾT QUẢ THẬT
 *   - Counters (file đọc, lệnh chạy...) + trạng thái Done
 *
 * User request 2026-08-31 — mọi agents (độc lập + team) đều như vậy.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getAgentRuns, hasActiveRun, cancelSessionRuns } from '@/lib/agent-run-tracker'
import { db } from '@/lib/db'
import { withPollCache } from '@/lib/poll-microcache'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const sessionId = request.nextUrl.searchParams.get('sessionId')
  const limitRaw = request.nextUrl.searchParams.get('limit')
  const limit = limitRaw ? Math.min(Math.max(1, Number(limitRaw) || 12), 30) : 12

  if (!sessionId) {
    return NextResponse.json({ ok: false, error: 'missing `sessionId`' }, { status: 400 })
  }

  // VÒNG 10 — micro-cache + in-flight dedup: UI poll mỗi ~1.2s; khi DB bận
  // (mission checkpoint) query có khi 7.5s → request chồng đống → RSS ratchet.
  return withPollCache(`ar|${sessionId}|${limit}`, 2500, () => getAgentRunData(sessionId, limit))
}

async function getAgentRunData(sessionId: string, limit: number): Promise<Response> {
  try {

    const runs = getAgentRuns(sessionId, limit)

    // CI-2 (Task 11-a) — gắn todo DB cho từng run theo runId (orderBy position
    // asc, cap 50/run — đủ cho mọi kế hoạch thực tế). Fail-open: lỗi DB →
    // todos=[] từng run, response vẫn trả bình thường (không break API cũ).
    // SELF-HEAL (2026-09-12): lỗi drift (DB cũ thiếu Todo.runId — user report
    // P2022) → tự prisma db push rồi THỬ LẠI 1 lần; vẫn lỗi → todos=[].
    const runIds = runs.map(r => r.runId).filter((id): id is string => typeof id === 'string' && id.length > 0)
    const todosByRun = new Map<string, Array<Record<string, unknown>>>()
    if (runIds.length > 0) {
      const loadRunTodos = async (): Promise<void> => {
        const rows = await db.todo.findMany({
          where: { runId: { in: runIds } },
          orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
        })
        for (const row of rows) {
          const arr = todosByRun.get(row.runId as string) || []
          if (arr.length < 50) {
            arr.push({
              id: row.id,
              sessionId: row.sessionId,
              runId: row.runId,
              agentRole: row.agentRole,
              content: row.content,
              status: row.status,
              priority: row.priority,
              parentId: row.parentId,
              position: row.position,
              archivedAt: row.archivedAt,
              createdAt: row.createdAt,
              updatedAt: row.updatedAt,
            })
            todosByRun.set(row.runId as string, arr)
          }
        }
      }
      try {
        await loadRunTodos()
      } catch (todoErr) {
        // Drift (P2021/P2022 "column/table does not exist")? → tự heal schema
        // (prisma db push) rồi load lại 1 lần — vẫn lỗi thì fail-open todos=[].
        const tErr = todoErr as { code?: string }
        const tMsg = todoErr instanceof Error ? todoErr.message : String(todoErr)
        const isDrift = tErr.code === 'P2021' || tErr.code === 'P2022' ||
          /does not exist in the current database/i.test(tMsg) || /no such (table|column)/i.test(tMsg)
        if (isDrift) {
          try {
            const { ensureDbReady } = await import('@/lib/db-setup')
            const healed = await ensureDbReady({ force: true })
            if (healed.ok) {
              todosByRun.clear()
              await loadRunTodos()
              console.log('[AgentRun API] DB đã tự đồng bộ schema — todos của run đã load lại')
            }
          } catch { /* fail-open — todos=[] cho mọi run */ }
        }
      }
    }
    const runsWithTodos = runs.map(r => ({
      ...r,
      todos: todosByRun.get(r.runId) || [],
    }))

    return NextResponse.json({
      ok: true,
      runs: runsWithTodos,
      hasActive: hasActiveRun(sessionId),
      serverTs: Date.now(),
      count: runsWithTodos.length,
    })
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : 'Internal server error' },
      { status: 500 },
    )
  }
}

/** POST — dừng tác vụ Agents đang chạy của session (user bấm nút Gửi/Dừng) */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => null) as { sessionId?: string } | null
    const sessionId = body?.sessionId
    if (!sessionId) {
      return NextResponse.json({ ok: false, error: 'missing `sessionId`' }, { status: 400 })
    }
    const cancelled = cancelSessionRuns(sessionId)

    // CI-5 (GĐ4, Task 14-c) — FAIL-OPEN: hủy luôn mọi durable goal-loop job
    // của session (queued → cancelled; running → DB flag cancelRequestedAt —
    // loop worker tự thoát ở vòng check kế, sống sót qua restart). Nút Dừng
    // hiện có tự hủy durable job — KHÔNG đổi response shape: `cancelled` vẫn
    // là số run in-memory như cũ, số job durable chỉ log. Dynamic import để
    // GET poll (mỗi ~1.2s) không phải nạp module worker nặng.
    try {
      const { goalLoopWorker } = await import('@/lib/goal-loop-worker')
      const cancelledJobs = await goalLoopWorker.cancelSessionJobs(sessionId)
      if (cancelledJobs > 0) {
        console.log(`[AgentRun] Nút Dừng: đã hủy ${cancelledJobs} durable goal-loop job của session ${sessionId}`)
      }
    } catch (glErr) {
      console.warn(
        '[AgentRun] cancelSessionJobs lỗi (fail-open — run in-memory vẫn đã hủy):',
        glErr instanceof Error ? glErr.message : String(glErr)
      )
    }

    return NextResponse.json({ ok: true, cancelled, serverTs: Date.now() })
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : 'Internal server error' },
      { status: 500 },
    )
  }
}
