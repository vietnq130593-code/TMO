import { NextRequest, NextResponse } from 'next/server'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { readFile } from 'fs/promises'
import { resolve, relative, sep } from 'path'
import { getActiveWorkspaceRoot } from '@/lib/workspace/workspace-manager'
import { getDiffManager } from '@/lib/workspace/diff-manager'

const execFileAsync = promisify(execFile)

export const dynamic = 'force-dynamic'

/**
 * GET /api/opencode/files/diff?path=&root=&staged=
 *
 * Compute a real git diff between the committed (HEAD) or staged version of a
 * file and the current working-tree content, using DiffManager.computeDiff
 * (structured hunks + unified string).
 *
 * Returns:
 *   { ok, diff: { hunks, unified }, originalContent, currentContent,
 *     hasOriginal, addedLines, removedLines }
 *
 * hasOriginal=false when the file is untracked / not in HEAD (git show fails)
 * or the repo has no commits yet — originalContent is then ''.
 */
export async function GET(request: NextRequest) {
  try {
    const url = new URL(request.url)
    const relPath = url.searchParams.get('path')
    const rootParam = url.searchParams.get('root')
    const staged = url.searchParams.get('staged') === '1' || url.searchParams.get('staged') === 'true'

    if (!relPath) {
      return NextResponse.json({ ok: false, error: 'path is required' }, { status: 400 })
    }

    const root = resolve(rootParam || (await getActiveWorkspaceRoot()) || process.cwd())
    const absPath = resolve(root, relPath)

    // Path-escape guard: the target file must live inside the workspace root
    const rel = relative(root, absPath)
    if (rel.startsWith('..') || resolve(rel) === rel) {
      return NextResponse.json({ ok: false, error: 'Access denied: path escapes workspace root' }, { status: 403 })
    }
    const relFromRoot = rel.split(sep).join('/')

    // Current working-tree content (missing file → treat as deleted → '')
    let currentContent = ''
    try {
      currentContent = await readFile(absPath, 'utf-8')
    } catch {
      currentContent = ''
    }

    // Original content: git show HEAD:<rel> (or :<rel> for staged)
    let originalContent = ''
    let hasOriginal = false
    try {
      const { stdout } = await execFileAsync(
        'git',
        ['show', staged ? `:${relFromRoot}` : `HEAD:${relFromRoot}`],
        { cwd: root, timeout: 5000, maxBuffer: 10 * 1024 * 1024 },
      )
      originalContent = stdout
      hasOriginal = true
    } catch {
      // Untracked file, no commits, or not in git — diff against empty
      originalContent = ''
      hasOriginal = false
    }

    // Structured diff via the shared DiffManager
    const diff = getDiffManager().computeDiff(originalContent, currentContent, relFromRoot)

    // Count added/removed from REAL DiffHunk shape: lines[] with +/-/space prefixes
    let addedLines = 0
    let removedLines = 0
    for (const hunk of diff.hunks) {
      for (const line of hunk.lines || []) {
        if (line.startsWith('+')) addedLines++
        else if (line.startsWith('-')) removedLines++
      }
    }

    return NextResponse.json({
      ok: true,
      diff,
      originalContent,
      currentContent,
      hasOriginal,
      addedLines,
      removedLines,
    })
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 },
    )
  }
}
