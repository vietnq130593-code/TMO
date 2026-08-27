import { NextRequest, NextResponse } from 'next/server'
import { getSessionsForAgent, getSessionsForTeam, createIsolatedSession, deleteIsolatedSession } from '@/lib/smolab/session-manager'
import { hasActiveRun } from '@/lib/agent-run-tracker'

export const dynamic = 'force-dynamic'

/** GET /api/smolab/sessions — Lấy sessions theo agent/team */
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const mode = searchParams.get('mode') as 'single' | 'multi' | null
  const agentProfileId = searchParams.get('agentProfileId')
  const teamName = searchParams.get('teamName')

  try {
    if (mode === 'single' && agentProfileId) {
      const sessions = await getSessionsForAgent(agentProfileId)
      // USER REQUEST 2026-09-01: flag "agents đang chạy dở" cho dropdown session
      return NextResponse.json({ sessions: sessions.map(s => ({ ...s, hasActiveRun: hasActiveRun(s.sessionId) })) })
    }
    if (mode === 'multi' && teamName) {
      const sessions = await getSessionsForTeam(teamName)
      return NextResponse.json({ sessions: sessions.map(s => ({ ...s, hasActiveRun: hasActiveRun(s.sessionId) })) })
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
