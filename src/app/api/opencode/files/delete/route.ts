import { NextRequest, NextResponse } from 'next/server'
import { rm, unlink, stat } from 'fs/promises'
import { resolve } from 'path'
import { getActiveWorkspaceRoot } from '@/lib/workspace/workspace-manager'

export const dynamic = 'force-dynamic'

/**
 * POST /api/opencode/files/delete
 * Body: { path: string, recursive?: boolean, root?: string }
 *
 * Deletes a file (unlink) or directory (rm recursive). The resolved path MUST
 * stay inside the workspace root — anything else is a 403 (path-escape guard).
 * Returns { ok, path, type }.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { path: targetPath, recursive = true } = body

    if (!targetPath) {
      return NextResponse.json({ ok: false, error: 'path is required' }, { status: 400 })
    }

    const root = resolve(body.root || (await getActiveWorkspaceRoot()) || process.cwd())
    const absPath = resolve(targetPath)

    // Path-escape guard: must be exactly root or inside root + separator
    if (absPath !== root && !absPath.startsWith(root + '/')) {
      return NextResponse.json({ ok: false, error: 'Access denied: path escapes workspace root' }, { status: 403 })
    }

    // What are we deleting?
    let stats
    try {
      stats = await stat(absPath)
    } catch {
      return NextResponse.json({ ok: false, error: `Not found: ${targetPath}` }, { status: 404 })
    }

    if (stats.isDirectory()) {
      await rm(absPath, { recursive })
    } else {
      await unlink(absPath)
    }

    return NextResponse.json({
      ok: true,
      path: absPath,
      type: stats.isDirectory() ? 'directory' : 'file',
    })
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 },
    )
  }
}
