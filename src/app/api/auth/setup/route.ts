// ============================================
// /api/auth/setup — Phase 2 fix: set HttpOnly cookie for same-origin auth
// Flow: client gọi GET /api/auth/setup một lần khi mount → cookie được set
//       → mọi request /api/workspace + /api/opencode/* tự mang cookie
//       → middleware chấp nhận cookie (Phase 1 đã hỗ trợ).
// Route này PUBLIC (không nằm dưới /api/opencode hay /api/workspace).
// ============================================
// FIX 2026-08-28: dùng ensureTmoApiToken() thay vì đọc process.env trực tiếp —
// nếu TMO_API_TOKEN thiếu trong .env (máy local pull code nhưng .env gitignored),
// token được tự sinh + persist ra file .tmo-api-token (xem src/lib/tmo-token.ts)
// thay vì fail 503 làm chết toàn bộ module Code.

import { NextResponse } from 'next/server'
import { ensureTmoApiToken } from '@/lib/tmo-token'

export const dynamic = 'force-dynamic'

export async function GET() {
  const token = ensureTmoApiToken() ?? process.env.TMO_API_TOKEN
  if (!token) {
    return NextResponse.json(
      {
        ok: false,
        error:
          'TMO_API_TOKEN not configured — auto-provision failed. ' +
          'Thêm TMO_API_TOKEN=<random hex> vào .env rồi restart app ' +
          '(hoặc kiểm tra quyền ghi file .tmo-api-token ở project root).',
      },
      { status: 503 },
    )
  }
  const res = NextResponse.json({ ok: true, expiry: '30d' })
  res.cookies.set('tmo_api_token', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 60 * 60 * 24 * 30, // 30 days
  })
  return res
}
