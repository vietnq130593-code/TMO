import { NextResponse } from 'next/server'
import { terminalManager } from '@/lib/terminal-session-manager'

export const dynamic = 'force-dynamic'

/**
 * POST /api/opencode/terminal/input
 * Body: { sessionId: string, data: string }
 * Writes raw data (usually "command\n") to the session's stdin.
 */
export async function POST(request: Request) {
  try {
    const body = await request.json()
    const { sessionId, data } = body

    if (!sessionId) {
      return NextResponse.json({ ok: false, error: 'sessionId is required' }, { status: 400 })
    }
    if (typeof data !== 'string') {
      return NextResponse.json({ ok: false, error: 'data (string) is required' }, { status: 400 })
    }

    if (!terminalManager.exists(sessionId)) {
      return NextResponse.json({ ok: false, error: 'session not found' }, { status: 404 })
    }

    const written = terminalManager.write(sessionId, data)
    return NextResponse.json({ ok: written })
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 },
    )
  }
}
