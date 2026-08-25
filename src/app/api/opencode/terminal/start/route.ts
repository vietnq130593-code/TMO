import { NextResponse } from 'next/server'
import { randomUUID } from 'crypto'
import { terminalManager } from '@/lib/terminal-session-manager'
import { getWorkspaceManager } from '@/lib/workspace/workspace-manager'

export const dynamic = 'force-dynamic'

/**
 * POST /api/opencode/terminal/start
 * Body: { sessionId?: string, cwd?: string }
 *
 * Spawns a persistent interactive shell (bash -i). cwd defaults to the
 * ACTIVE workspace root (workspace-manager), falling back to process.cwd().
 */
export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}))
    const sessionId: string | undefined = body?.sessionId
    let cwd: string | undefined = body?.cwd

    // Default cwd = active workspace root
    if (!cwd) {
      try {
        const ws = await getWorkspaceManager().getActiveWorkspace()
        if (ws?.rootPath) cwd = ws.rootPath
      } catch {
        // fall through to process.cwd()
      }
    }

    const id = sessionId || randomUUID()

    try {
      terminalManager.create(id, { cwd })
    } catch (err) {
      return NextResponse.json(
        { ok: false, error: err instanceof Error ? err.message : 'Failed to spawn shell' },
        { status: 500 },
      )
    }

    return NextResponse.json({
      ok: true,
      sessionId: id,
      cwd: cwd || process.cwd(),
    })
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 },
    )
  }
}
