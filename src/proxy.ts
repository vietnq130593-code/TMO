// ============================================
// src/proxy.ts — Phase 1: Auth proxy (middleware → proxy, Next 16)
// Protects /api/opencode/** + /api/workspace/** with Bearer/X-TMO-API-Token/cookie
// Source: /home/z/my-project/RECOVERY.md (Phase 1)
// ============================================
// FIX 2026-08-28: trước đây khi TMO_API_TOKEN thiếu trong .env (máy local pull
// code về nhưng .env là gitignored) middleware fail-closed 503 ngay lập tức
// → "Workspace register failed: TMO_API_TOKEN not configured" → module Code
// chết hoàn toàn. Giờ gọi ensureTmoApiToken() (src/lib/tmo-token.ts):
// env ưu tiên → đọc file .tmo-api-token → tự sinh token ngẫu nhiên + persist.
//
// ĐỔI TÊN middleware.ts → proxy.ts (Next 16): middleware.ts mặc định biên dịch
// sang Edge Runtime (không dùng được node:fs/node:crypto → auto-provision
// không thể import). proxy.ts là tên gọi chính thức của Next 16 và LUÔN chạy
// Node.js runtime → import lib Node an toàn.
// https://nextjs.org/docs/messages/middleware-to-proxy

import { NextRequest, NextResponse } from 'next/server'
import { ensureTmoApiToken } from './lib/tmo-token'

const PROTECTED_PREFIXES = ['/api/opencode', '/api/workspace']
const PUBLIC_PATHS = ['/api/health', '/api/auth']

function isProtected(pathname: string): boolean {
  if (PUBLIC_PATHS.some((p) => pathname.startsWith(p))) return false
  return PROTECTED_PREFIXES.some((p) => pathname.startsWith(p))
}

export function proxy(req: NextRequest) {
  if (!isProtected(req.nextUrl.pathname)) return NextResponse.next()

  const token =
    req.headers.get('authorization')?.replace('Bearer ', '') ||
    req.cookies.get('tmo_api_token')?.value ||
    req.headers.get('x-tmo-api-token')

  // Auto-provision (cached trong module — không tốn fs mỗi request).
  // Trả null chỉ khi cả env lẫn file đều không thiết lập được (FS lỗi).
  let expected: string | null = null
  try {
    expected = ensureTmoApiToken()
  } catch (err) {
    console.error('[proxy] ensureTmoApiToken failed:', err)
  }
  if (!expected) {
    // Token chưa config và auto-provision fail → fail closed (production safe)
    return NextResponse.json(
      {
        error:
          'TMO_API_TOKEN not configured — auto-provision failed. ' +
          'Thêm TMO_API_TOKEN=<random hex> vào .env rồi restart app ' +
          '(hoặc kiểm tra quyền ghi file .tmo-api-token ở project root).',
      },
      { status: 503 },
    )
  }
  if (token !== expected) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  return NextResponse.next()
}

export const config = {
  matcher: ['/api/opencode/:path*', '/api/workspace/:path*'],
}
