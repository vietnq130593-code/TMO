/**
 * Agent Activity API — cho Terminal UI poll hoạt động tool của agents.
 *
 * GET /api/agent-activity?since=<epochMs>&limit=50
 *   → { ok: true, entries: AgentActivityEntry[], latestTs: number }
 *
 * Nguồn: src/lib/agent-activity-log.ts (ring buffer in-memory được ghi bởi
 * executeTool() — MỌI tool call của MỌI agent ở mọi chế độ: single chat,
 * team workflow, cron...).
 *
 * User request 2026-08-27: ô Terminal phải thấy rõ agent đang chạy lệnh gì
 * (trước đây chỉ có SSE echo ở chế độ Team — single-agent chat (stream:false)
 * thì Terminal trống rỗng dù agent đã chạy shell thật).
 */

import { NextRequest, NextResponse } from 'next/server'
import { getAgentActivity } from '@/lib/agent-activity-log'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  try {
    const sinceRaw = request.nextUrl.searchParams.get('since')
    const limitRaw = request.nextUrl.searchParams.get('limit')
    const since = sinceRaw ? Number(sinceRaw) : 0
    const limit = limitRaw ? Math.min(Math.max(1, Number(limitRaw) || 50), 100) : 50

    if (Number.isNaN(since) || since < 0) {
      return NextResponse.json({ ok: false, error: 'invalid `since` (epoch ms)' }, { status: 400 })
    }

    const entries = getAgentActivity(since, limit)
    const latestTs = entries.length > 0 ? entries[entries.length - 1].ts : since

    return NextResponse.json({
      ok: true,
      entries,
      latestTs,
      count: entries.length,
    })
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : 'Internal server error' },
      { status: 500 },
    )
  }
}
