import { NextResponse } from 'next/server'
import { terminalManager } from '@/lib/terminal-session-manager'

export const dynamic = 'force-dynamic'

/**
 * POST /api/opencode/terminal/stop
 * Body: { sessionId: string }
 * Kills the session (stdin EOF + SIGTERM → SIGKILL after 2s).
 */
export async function POST(request: Request) {
  try {
    const body = await request.json()
    const { sessionId } = body

    if (!sessionId) {
      return NextResponse.json({ ok: false, error: 'sessionId is required' }, { status: 400 })
    }

    const stopped = terminalManager.kill(sessionId)
    return NextResponse.json({ ok: true, stopped })
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 },
    )
  }
}
