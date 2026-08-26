import { NextResponse } from 'next/server'
import { mkdir, stat, realpath } from 'fs/promises'
import { resolve, dirname } from 'path'
import { existsSync } from 'fs'

export const dynamic = 'force-dynamic'

/**
 * POST /api/opencode/files/mkdir
 * Create a new directory on the local filesystem
 * Body: { path: string, recursive?: boolean }
 */
export async function POST(request: Request) {
  try {
    const body = await request.json()
    const { path: dirPath, recursive = true } = body

    if (!dirPath) {
      return NextResponse.json({ error: 'path is required' }, { status: 400 })
    }

    const resolvedPath = resolve(dirPath)

    // FIX 2026-08-29: gỡ BLOCKED_PREFIXES (/usr, /etc...) — shell tool đã không còn
    // chặn lệnh nào (user yêu cầu bỏ hạn chế) nên chặn riêng route tạo thư mục là
    // vô nghĩa (mkdir /x qua shell vẫn chạy được). Nhất quán: không chặn đường dẫn.

    if (existsSync(resolvedPath)) {
      const stats = await stat(resolvedPath)
      if (stats.isDirectory()) {
        return NextResponse.json({
          success: true,
          path: resolvedPath,
          message: 'Directory already exists',
          existed: true,
        })
      } else {
        return NextResponse.json({ error: 'A file with that name already exists', path: resolvedPath }, { status: 409 })
      }
    }

    await mkdir(resolvedPath, { recursive })

    // Verify creation
    const realPath = await realpath(resolvedPath)
    const parentDir = dirname(resolvedPath)

    return NextResponse.json({
      success: true,
      path: realPath,
      parentPath: parentDir,
      existed: false,
    })
  } catch (error) {
    return NextResponse.json({
      error: 'Failed to create directory',
      details: error instanceof Error ? error.message : 'Unknown error',
    }, { status: 500 })
  }
}
