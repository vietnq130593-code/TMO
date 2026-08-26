import { NextResponse } from 'next/server'
import { writeFile, mkdir, stat } from 'fs/promises'
import { join, resolve, dirname, extname } from 'path'
import { existsSync } from 'fs'

export const dynamic = 'force-dynamic'

/**
 * POST /api/opencode/files/write
 * Write content to a file on the local filesystem
 * Body: { path: string, content: string, createDirs?: boolean }
 *
 * POST /api/opencode/files/write?action=create-file
 * Create a new empty file: { path: string, content?: string }
 */
export async function POST(request: Request) {
  try {
    const body = await request.json()
    const { path: filePath, content, createDirs = true } = body

    if (!filePath) {
      return NextResponse.json({ error: 'path is required' }, { status: 400 })
    }

    const resolvedPath = resolve(filePath)

    // FIX 2026-08-29: gỡ BLOCKED_PREFIXES (/usr, /etc...) — shell tool đã không còn
    // chặn lệnh nào (user yêu cầu bỏ hạn chế) nên chặn riêng route ghi file là vô nghĩa
    // (echo ... > /etc/x qua shell vẫn chạy được). Unix-only prefixes này cũng không bao
    // giờ match trên Windows. Nhất quán: không chặn đường dẫn.

    // Create parent directories if needed
    if (createDirs) {
      const dir = dirname(resolvedPath)
      if (!existsSync(dir)) {
        await mkdir(dir, { recursive: true })
      }
    }

    // Write file
    const fileContent = content ?? ''
    await writeFile(resolvedPath, fileContent, 'utf-8')

    // Get file stats after write
    const stats = await stat(resolvedPath)
    const ext = extname(resolvedPath)

    const langMap: Record<string, string> = {
      '.ts': 'typescript', '.tsx': 'typescript', '.js': 'javascript', '.jsx': 'javascript',
      '.json': 'json', '.css': 'css', '.html': 'html', '.md': 'markdown',
      '.prisma': 'prisma', '.yaml': 'yaml', '.yml': 'yaml',
      '.py': 'python', '.rs': 'rust', '.go': 'go', '.java': 'java',
      '.sh': 'bash', '.bash': 'bash', '.zsh': 'zsh',
      '.sql': 'sql', '.graphql': 'graphql',
      '.vue': 'vue', '.svelte': 'svelte',
    }

    return NextResponse.json({
      success: true,
      path: resolvedPath,
      size: stats.size,
      extension: ext,
      language: langMap[ext] || 'plaintext',
      lines: fileContent.split('\n').length,
      created: !body.existing,
    })
  } catch (error) {
    return NextResponse.json({
      error: 'Failed to write file',
      details: error instanceof Error ? error.message : 'Unknown error',
    }, { status: 500 })
  }
}
