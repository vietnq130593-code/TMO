import { NextResponse } from 'next/server'
import { terminalManager } from '@/lib/terminal-session-manager'

export const dynamic = 'force-dynamic'

/**
 * GET /api/opencode/terminal/sessions
 *
 * Liệt kê các persistent interactive shell session đang sống (multi-terminal
 * UI 2026-09-25). Client dùng route này khi Code tab mount lại (sau khi rời
 * tab) để dựng lại danh sách terminal tabs + reattach SSE stream từng session
 * (stream init frame replay toàn bộ cumulative output nên không mất lịch sử).
 *
 * Response: { ok: true, sessions: Array<{ id, cwd, createdAt, lastActivity, killed }> }
 */
export async function GET() {
  try {
    const sessions = terminalManager.list()
    // oldest first — tab order ổn định theo thứ tự tạo
    sessions.sort((a, b) => a.createdAt - b.createdAt)
    return NextResponse.json({ ok: true, sessions })
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 },
    )
  }
}
