// ============================================
// /api/auth/setup — Phase 2 fix: set HttpOnly cookie for same-origin auth
// Flow: client gọi GET /api/auth/setup một lần khi mount → cookie được set
//       → mọi request /api/workspace + /api/opencode/* tự mang cookie
//       → middleware chấp nhận cookie (Phase 1 đã hỗ trợ).
// Route này PUBLIC (không nằm dưới /api/opencode hay /api/workspace).
// ============================================

import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export async function GET() {
  const token = process.env.TMO_API_TOKEN;
  if (!token) {
    return NextResponse.json(
      { ok: false, error: 'TMO_API_TOKEN not configured' },
      { status: 503 },
    );
  }
  const res = NextResponse.json({ ok: true, expiry: '30d' });
  res.cookies.set('tmo_api_token', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 60 * 60 * 24 * 30, // 30 days
  });
  return res;
}
