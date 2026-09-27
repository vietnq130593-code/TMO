import { NextResponse } from 'next/server'
import { runAgentHarness, getLastHarnessReport, DEFAULT_HARNESS_TASKS } from '@/lib/eval/agent-harness'

/**
 * TASK 43 — AGENT HARNESS ENDPOINT
 * ==================================
 * POST /api/eval/agent-harness   Body: { agent: string }
 *   Chạy task suite (mặc định 3 task: file-write-verify / machine-count /
 *   todo-plan-lifecycle) qua CHÍNH engine delegation production
 *   (runSubAgentForProfile + trọng tài độc lập) — fire-and-forget
 *   background (mỗi task ~1 sub-agent run, tổng thường < 3 phút).
 *   Trả { started: true, agent, taskCount }.
 *
 * GET /api/eval/agent-harness
 *   Report harness gần nhất (đang chạy hoặc xong): passRate từng task,
 *   tool calls, tokens, verdict trọng tài độc lập.
 *
 * GET ?suite=1 — liệt kê task suite mặc định (không chạy gì).
 */
export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  try {
    const url = new URL(req.url)
    if (url.searchParams.get('suite') === '1') {
      return NextResponse.json({ suite: DEFAULT_HARNESS_TASKS })
    }
    const report = getLastHarnessReport()
    if (!report) {
      return NextResponse.json({ report: null, note: 'Chưa có harness run nào — POST { "agent": "RAMPAGE" } để bắt đầu.' })
    }
    return NextResponse.json({ report })
  } catch (err) {
    console.error('[AgentHarness] GET failed:', err instanceof Error ? err.message : String(err))
    return NextResponse.json({ error: 'agent-harness query failed' }, { status: 500 })
  }
}

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as { agent?: unknown; sessionId?: unknown }
    const agent = typeof body.agent === 'string' ? body.agent.trim() : ''
    if (!agent) {
      return NextResponse.json({ error: 'Thiếu "agent" — tên agent cần kiểm định (vd RAMPAGE, FORGE, Omega — xem GET /api/agents).' }, { status: 400 })
    }

    // Đang có harness chạy cho agent khác? Cho phép — report cuối cùng thắng
    // (globalForHarness.__tmoAgentHarnessLast bị đè). 1 harness mỗi lúc là
    // đủ thực dụng; không cần lock chặt.
    const sessionId = typeof body.sessionId === 'string' && body.sessionId ? body.sessionId : null

    void runAgentHarness({ agent, sessionId }).catch(err => {
      console.error('[AgentHarness] background run crashed:', err instanceof Error ? err.message : String(err))
    })

    return NextResponse.json({ started: true, agent, taskCount: DEFAULT_HARNESS_TASKS.length })
  } catch (err) {
    console.error('[AgentHarness] POST failed:', err instanceof Error ? err.message : String(err))
    return NextResponse.json({ error: 'Failed to start agent harness' }, { status: 500 })
  }
}
