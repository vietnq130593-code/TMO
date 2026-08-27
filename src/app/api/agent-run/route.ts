/**
 * Agent Run API — Thought Process + Todos + Progress realtime trong chat.
 *
 * GET /api/agent-run?sessionId=<sid>&limit=12
 *   → { ok: true, runs: AgentRun[], hasActive: boolean }
 *
 * POST /api/agent-run { sessionId } — USER REQUEST 2026-08-31 (bấm nút Gửi
 * trong khung chat để DỪNG tác vụ Agents đang chạy):
 *   → { ok: true, cancelled: <số run đang chạy đã bị dừng> }
 *   - Mọi run 'running' của session → status 'cancelled'
 *   - Đặt flag cancel → ReAct loops (chat route + workflow-engine) và chuỗi
 *     xoay vòng key LLM (llm.ts callModelWithKeyRotation) cắt ngang sớm.
 *   - Request GỬI TIẾP THEO của user không bị ảnh hưởng (startAgentRun xóa flag).
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

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  try {
    const sessionId = request.nextUrl.searchParams.get('sessionId')
    const limitRaw = request.nextUrl.searchParams.get('limit')
    const limit = limitRaw ? Math.min(Math.max(1, Number(limitRaw) || 12), 30) : 12

    if (!sessionId) {
      return NextResponse.json({ ok: false, error: 'missing `sessionId`' }, { status: 400 })
    }

    const runs = getAgentRuns(sessionId, limit)

    return NextResponse.json({
      ok: true,
      runs,
      hasActive: hasActiveRun(sessionId),
      serverTs: Date.now(),
      count: runs.length,
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
    return NextResponse.json({ ok: true, cancelled, serverTs: Date.now() })
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : 'Internal server error' },
      { status: 500 },
    )
  }
}
