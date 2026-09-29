import { NextRequest, NextResponse } from 'next/server'
import { getSessionsForAgent, getSessionsForTeam, createIsolatedSession, deleteIsolatedSession } from '@/lib/smolab/session-manager'
import { hasActiveRun } from '@/lib/agent-run-tracker'
// FIX 2026-09-29 — cùng nguồn sự thật hoạt động với /api/openclaw/sessions
// (GoalLoopJob DB queued/running + run tracker) — 2 endpoint phải trả cùng
// một truth nếu không dropdown nhấp nháy sai lệch nhau.
import { getActiveSessionsContext } from '@/lib/active-sessions'

export const dynamic = 'force-dynamic'

/** GET /api/smolab/sessions — Lấy sessions theo agent/team */
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const mode = searchParams.get('mode') as 'single' | 'multi' | null
  const agentProfileId = searchParams.get('agentProfileId')
  const teamName = searchParams.get('teamName')

  try {
    // FIX 2026-09-29: tính song song với session list — flag hasActiveRun giờ
    // tính cả durable GoalLoopJob (queued/running), trả kèm activeSessions
    // (cross agent/team) cho section ghim "Đang vận hành" của dropdown.
    const activeCtx = await getActiveSessionsContext()
    if (mode === 'single' && agentProfileId) {
      const sessions = await getSessionsForAgent(agentProfileId)
      // USER REQUEST 2026-09-01: flag "agents đang chạy dở" cho dropdown session
      return NextResponse.json({
        sessions: sessions.map(s => ({
          ...s,
          hasActiveRun: activeCtx.isSessionActive(s.sessionId) || hasActiveRun(s.sessionId),
          activeJobCount: activeCtx.activeJobCount(s.sessionId),
        })),
        activeSessions: activeCtx.activeSessions,
      })
    }
    if (mode === 'multi' && teamName) {
      const sessions = await getSessionsForTeam(teamName)
      return NextResponse.json({
        sessions: sessions.map(s => ({
          ...s,
          hasActiveRun: activeCtx.isSessionActive(s.sessionId) || hasActiveRun(s.sessionId),
          activeJobCount: activeCtx.activeJobCount(s.sessionId),
        })),
        activeSessions: activeCtx.activeSessions,
      })
    }
    return NextResponse.json({ error: 'Thiếu mode + agentProfileId hoặc teamName' }, { status: 400 })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Lỗi' }, { status: 500 })
  }
}

/** POST /api/smolab/sessions — Tạo session mới */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const session = await createIsolatedSession(body)
    return NextResponse.json({ session })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Lỗi' }, { status: 400 })
  }
}

/** DELETE /api/smolab/sessions — Xóa session */
export async function DELETE(req: NextRequest) {
  try {
    const body = await req.json()
    await deleteIsolatedSession(body)
    return NextResponse.json({ success: true })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Lỗi' }, { status: 400 })
  }
}
