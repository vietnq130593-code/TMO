// ============================================
// src/middleware.ts — Phase 1: Auth middleware
// Protects /api/opencode/** + /api/workspace/** with Bearer/X-TMO-API-Token/cookie
// Source: /home/z/my-project/RECOVERY.md (Phase 1)
// ============================================

import { NextRequest, NextResponse } from 'next/server';

const PROTECTED_PREFIXES = ['/api/opencode', '/api/workspace'];
const PUBLIC_PATHS = ['/api/health', '/api/auth'];

function isProtected(pathname: string): boolean {
  if (PUBLIC_PATHS.some((p) => pathname.startsWith(p))) return false;
  return PROTECTED_PREFIXES.some((p) => pathname.startsWith(p));
}

export function middleware(req: NextRequest) {
  if (!isProtected(req.nextUrl.pathname)) return NextResponse.next();

  const token =
    req.headers.get('authorization')?.replace('Bearer ', '') ||
    req.cookies.get('tmo_api_token')?.value ||
    req.headers.get('x-tmo-api-token');

  const expected = process.env.TMO_API_TOKEN;
  if (!expected) {
    // Token chưa config → fail closed (production safe)
    return NextResponse.json(
      { error: 'TMO_API_TOKEN not configured' },
      { status: 503 },
    );
  }
  if (token !== expected) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return NextResponse.next();
}

export const config = {
  matcher: ['/api/opencode/:path*', '/api/workspace/:path*'],
};
