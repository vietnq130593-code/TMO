import { NextResponse } from 'next/server'
import { readFileContent } from '@/lib/opencode'
import { readFile, stat } from 'fs/promises'
import { join, resolve, extname, isAbsolute } from 'path'
import { existsSync } from 'fs'

export const dynamic = 'force-dynamic'

/**
 * GET /api/opencode/files/read?path=xxx&root=yyy
 * Read file content from OpenCode server, fallback to local read
 *
 * If root param is provided, path is treated as relative to root (or absolute if path starts with /)
 * If root param is not provided, original workspace mode is used
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const filePath = searchParams.get('path')
  const customRoot = searchParams.get('root') || undefined

  if (!filePath) {
    return NextResponse.json({ error: 'path query parameter is required' }, { status: 400 })
  }

  // Custom root mode — read from any local path
  if (customRoot) {
    // FIX 2026-08-28 (Windows): file tree trên Windows trả về path kiểu "C:\\Users\\...\\file.ts"
    // (backslash + drive letter). Kiểm tra `startsWith('/')` là Unix-only → luôn FALSE trên
    // Windows → rơi vào join(customRoot, <absolute-path>) → path kép sai ("C:\\proj\\C:\\proj\\f.ts")
    // → 404 → editor KHÔNG HIỆN nội dung file (symptom user báo). isAbsolute() xử lý cả 2 OS.
    const resolvedPath = isAbsolute(filePath) ? resolve(filePath) : resolve(join(customRoot, filePath))

    // Security: prevent reading critical system files
    const BLOCKED_PATHS = ['/etc/shadow', '/etc/passwd', '/root/.ssh', '/root/.gnupg']
    for (const blocked of BLOCKED_PATHS) {
      if (resolvedPath.startsWith(blocked)) {
        return NextResponse.json({ error: 'Access denied' }, { status: 403 })
      }
    }

    if (!existsSync(resolvedPath)) {
      return NextResponse.json({ error: 'File not found', path: filePath, source: 'local-fs' }, { status: 404 })
    }

    try {
      const stats = await stat(resolvedPath)
      if (stats.isDirectory()) {
        return NextResponse.json({ error: 'Path is a directory' }, { status: 400 })
      }
      if (stats.size > 1024 * 1024) {
        return NextResponse.json({ error: 'File too large (>1MB)' }, { status: 413 })
      }

      const content = await readFile(resolvedPath, 'utf-8')
      const lines = content.split('\n').length
      const ext = extname(resolvedPath)

      const langMap: Record<string, string> = {
        '.ts': 'typescript', '.tsx': 'typescript', '.js': 'javascript', '.jsx': 'javascript',
        '.json': 'json', '.css': 'css', '.html': 'html', '.md': 'markdown',
        '.prisma': 'prisma', '.yaml': 'yaml', '.yml': 'yaml',
        '.py': 'python', '.rs': 'rust', '.go': 'go', '.java': 'java',
        '.sh': 'bash', '.bash': 'bash', '.sql': 'sql',
        '.vue': 'vue', '.svelte': 'svelte', '.toml': 'toml',
        '.env': 'env', '.gitignore': 'gitignore',
      }

      return NextResponse.json({
        path: resolvedPath,
        content,
        language: langMap[ext] || 'plaintext',
        lines,
        size: stats.size,
        extension: ext,
        source: 'local-fs',
      })
    } catch (error) {
      return NextResponse.json({
        error: 'Failed to read file',
        details: error instanceof Error ? error.message : 'Unknown error',
      }, { status: 500 })
    }
  }

  // Original workspace mode — try OpenCode server first
  try {
    const content = await readFileContent(filePath)
    if (content) {
      return NextResponse.json({ ...content, source: 'opencode-server' })
    }
  } catch {
    // Server offline, fallback to local
  }

  // Fallback: read file locally
  const WORKSPACE = resolve(process.cwd(), process.env.OPENCODE_WORKSPACE || '.')
  const fullPath = join(WORKSPACE, filePath)

  // Security: prevent path traversal
  if (!fullPath.startsWith(WORKSPACE)) {
    return NextResponse.json({ error: 'Access denied: path outside workspace' }, { status: 403 })
  }

  if (!existsSync(fullPath)) {
    return NextResponse.json({ error: 'File not found', path: filePath, source: 'local-fallback' }, { status: 404 })
  }

  try {
    const stats = await stat(fullPath)
    if (stats.isDirectory()) {
      return NextResponse.json({ error: 'Path is a directory' }, { status: 400 })
    }
    if (stats.size > 500 * 1024) {
      return NextResponse.json({ error: 'File too large (>500KB)' }, { status: 413 })
    }

    const content = await readFile(fullPath, 'utf-8')
    const lines = content.split('\n').length
    const ext = extname(fullPath)

    const langMap: Record<string, string> = {
      '.ts': 'typescript', '.tsx': 'typescript', '.js': 'javascript', '.jsx': 'javascript',
      '.json': 'json', '.css': 'css', '.html': 'html', '.md': 'markdown',
      '.prisma': 'prisma', '.yaml': 'yaml', '.yml': 'yaml',
    }

    return NextResponse.json({
      path: filePath,
      content,
      language: langMap[ext] || 'plaintext',
      lines,
      size: stats.size,
      extension: ext,
      source: 'local-fallback',
    })
  } catch (error) {
    return NextResponse.json({
      error: 'Failed to read file',
      details: error instanceof Error ? error.message : 'Unknown error',
    }, { status: 500 })
  }
}
