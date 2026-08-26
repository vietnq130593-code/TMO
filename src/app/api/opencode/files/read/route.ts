import { NextResponse } from 'next/server'
import { readFileContent } from '@/lib/opencode'
import { readFile, stat, open } from 'fs/promises'
import { join, resolve, extname, isAbsolute, basename } from 'path'
import { existsSync } from 'fs'

export const dynamic = 'force-dynamic'

/**
 * GET /api/opencode/files/read?path=xxx&root=yyy
 * Read file content from OpenCode server, fallback to local read
 *
 * If root param is provided, path is treated as relative to root (or absolute if path is absolute)
 * If root param is not provided, original workspace mode is used
 */

/** Max bytes of a TEXT file returned in full. Larger text files are truncated (client opens them read-only). */
const MAX_TEXT_BYTES = 2 * 1024 * 1024 // 2MB
/** How many leading bytes are sniffed for binary detection */
const BINARY_SNIFF_BYTES = 8192
/** How many leading bytes are formatted into the hex preview for binary files */
const HEX_PREVIEW_BYTES = 512

/**
 * Sniff whether a file looks binary: standard heuristic — a NUL byte in the
 * first chunk means it is not text (PE/ELF executables, images, sqlite, zip,
 * ...). UTF-8 text never contains 0x00.
 */
async function isBinaryFile(filePath: string): Promise<boolean> {
  const handle = await open(filePath, 'r')
  try {
    const buf = Buffer.alloc(BINARY_SNIFF_BYTES)
    const { bytesRead } = await handle.read(buf, 0, BINARY_SNIFF_BYTES, 0)
    return buf.subarray(0, bytesRead).includes(0)
  } finally {
    await handle.close()
  }
}

/** Format the first HEX_PREVIEW_BYTES as a hexdump (offset | hex | ascii), xxd-style. */
async function buildHexPreview(filePath: string): Promise<string> {
  const handle = await open(filePath, 'r')
  try {
    const buf = Buffer.alloc(HEX_PREVIEW_BYTES)
    const { bytesRead } = await handle.read(buf, 0, HEX_PREVIEW_BYTES, 0)
    const lines: string[] = []
    for (let off = 0; off < bytesRead; off += 16) {
      const chunk = buf.subarray(off, Math.min(off + 16, bytesRead))
      const hex = [...chunk].map((b) => b.toString(16).padStart(2, '0')).join(' ').padEnd(47, ' ')
      const ascii = [...chunk].map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.')).join('')
      lines.push(`${off.toString(16).padStart(8, '0')}  ${hex}  |${ascii}|`)
    }
    return lines.join('\n')
  } finally {
    await handle.close()
  }
}

/**
 * Read only the first `maxBytes` of a text file WITHOUT loading the whole file
 * into memory (file có thể hàng trăm MB). Bỏ 4 byte cuối dự phòng để không cắt
 * giữa một ký tự UTF-8 multi-byte.
 */
async function readTextHead(filePath: string, maxBytes: number): Promise<string> {
  const handle = await open(filePath, 'r')
  try {
    const buf = Buffer.alloc(maxBytes + 4)
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0)
    return buf.subarray(0, Math.max(bytesRead - 4, 0)).toString('utf-8')
  } finally {
    await handle.close()
  }
}

function humanSize(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${bytes} B`
}

const LANG_MAP: Record<string, string> = {
  '.ts': 'typescript', '.tsx': 'typescript', '.js': 'javascript', '.jsx': 'javascript',
  '.json': 'json', '.css': 'css', '.html': 'html', '.md': 'markdown',
  '.prisma': 'prisma', '.yaml': 'yaml', '.yml': 'yaml',
  '.py': 'python', '.rs': 'rust', '.go': 'go', '.java': 'java',
  '.sh': 'bash', '.bash': 'bash', '.sql': 'sql',
  '.vue': 'vue', '.svelte': 'svelte', '.toml': 'toml',
  '.env': 'env', '.gitignore': 'gitignore',
}

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

    // FIX 2026-08-29: gỡ BLOCKED_PATHS (/etc/shadow...) — shell tool đã không còn chặn
    // lệnh nào (user yêu cầu bỏ hạn chế) nên block riêng route đọc file là vô nghĩa
    // (cat /etc/shadow qua shell vẫn chạy được). Nhất quán: không chặn đường dẫn.

    if (!existsSync(resolvedPath)) {
      return NextResponse.json({ error: 'File not found', path: filePath, source: 'local-fs' }, { status: 404 })
    }

    try {
      const stats = await stat(resolvedPath)
      if (stats.isDirectory()) {
        return NextResponse.json({ error: 'Path is a directory' }, { status: 400 })
      }

      // FIX 2026-08-29 (binary files — VD qdrant.exe): trước đây mọi file >1MB đều
      // bị 413 "File too large" → click file nhị phân trong cây thư mục = toast lỗi
      // đỏ (symptom user báo trên Windows với E:\...\qdrant.exe). Giờ sniff binary:
      // trả 200 kèm metadata + hex preview (xxd-style) — frontend render placeholder
      // "file nhị phân" kiểu VSCode thay vì lỗi. Không phụ thuộc kích thước file.
      if (await isBinaryFile(resolvedPath)) {
        return NextResponse.json({
          path: resolvedPath,
          isBinary: true,
          content: '',
          hexPreview: await buildHexPreview(resolvedPath),
          language: 'plaintext',
          lines: 0,
          size: stats.size,
          sizeHuman: humanSize(stats.size),
          name: basename(resolvedPath),
          extension: extname(resolvedPath),
          source: 'local-fs',
        })
      }

      // Text file: đọc full nếu ≤2MB (tăng từ 1MB). File lớn hơn: trả đúng 2MB
      // đầu + truncated:true → frontend mở tab READ-ONLY (tránh ghi đè mất phần còn lại).
      const truncated = stats.size > MAX_TEXT_BYTES
      const content = truncated
        ? await readTextHead(resolvedPath, MAX_TEXT_BYTES)
        : await readFile(resolvedPath, 'utf-8')
      const lines = content.split('\n').length
      const ext = extname(resolvedPath)

      return NextResponse.json({
        path: resolvedPath,
        content,
        truncated: truncated || undefined,
        totalSize: truncated ? stats.size : undefined,
        sizeHuman: humanSize(stats.size),
        language: LANG_MAP[ext] || 'plaintext',
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
