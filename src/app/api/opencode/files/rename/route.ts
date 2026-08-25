import { NextRequest, NextResponse } from 'next/server'
import { rename, mkdir, stat } from 'fs/promises'
import { resolve, dirname } from 'path'
import { getActiveWorkspaceRoot } from '@/lib/workspace/workspace-manager'

export const dynamic = 'force-dynamic'

/**
 * POST /api/opencode/files/rename
 * Body: { oldPath: string, newPath: string, root?: string }
 *
 * Renames/moves a file OR directory. Creates the destination parent directory
 * (recursive) when missing. Returns { ok, oldPath, newPath, type }.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { oldPath, newPath } = body

    if (!oldPath || !newPath) {
      return NextResponse.json({ ok: false, error: 'oldPath and newPath are required' }, { status: 400 })
    }

    const root = resolve(body.root || (await getActiveWorkspaceRoot()) || process.cwd())
    const absOld = resolve(oldPath)
    const absNew = resolve(newPath)

    // Source must exist (404 otherwise) — stat BEFORE touching anything
    let stats
    try {
      stats = await stat(absOld)
    } catch {
      return NextResponse.json({ ok: false, error: `Not found: ${oldPath}` }, { status: 404 })
    }

    // Make sure the destination parent exists
    const parentDir = dirname(absNew)
    await mkdir(parentDir, { recursive: true })

    await rename(absOld, absNew)

    return NextResponse.json({
      ok: true,
      oldPath: absOld,
      newPath: absNew,
      type: stats.isDirectory() ? 'directory' : 'file',
    })
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 },
    )
  }
}
