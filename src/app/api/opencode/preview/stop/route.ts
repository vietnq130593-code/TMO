import { NextResponse } from 'next/server'
import { resolve } from 'path'
// Task 19-b: đọc registry shared (globalThis) thay vì import Map từ start route
import { getPreview, unregisterPreview } from '@/lib/preview-registry'

export const dynamic = 'force-dynamic'

/**
 * POST /api/opencode/preview/stop
 * Body: { root: string }
 * Kill the detached dev-server process GROUP for this workspace root.
 */
export async function POST(request: Request) {
  try {
    const body = await request.json()
    const root = body?.root

    if (!root || typeof root !== 'string') {
      return NextResponse.json({ error: 'root parameter is required' }, { status: 400 })
    }

    const resolvedRoot = resolve(root)
    const entry = getPreview(resolvedRoot)

    if (!entry) {
      return NextResponse.json({ ok: true, message: 'no running process' })
    }

    const pid = entry.child?.pid
    // Remove from registry first (idempotent stop)
    unregisterPreview(resolvedRoot)

    if (pid) {
      // Spawned detached → child is a process-group leader → -pid kills the
      // whole tree (npm/pnpm wrapper + actual dev server).
      try {
        process.kill(-pid, 'SIGTERM')
      } catch {
        // Process (group) already gone — nothing to do
      }
      // Escalate to SIGKILL after 3s if SIGTERM was ignored
      const killer = setTimeout(() => {
        try {
          process.kill(-pid, 'SIGKILL')
        } catch {
          // already dead
        }
      }, 3000)
      killer.unref?.()
    }

    return NextResponse.json({ ok: true, stopped: true, pid })
  } catch (error) {
    return NextResponse.json({
      error: 'Failed to stop dev server',
      details: error instanceof Error ? error.message : 'Unknown error',
    }, { status: 500 })
  }
}
