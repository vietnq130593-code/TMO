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
//
// R65 (AUDIT LƯỢT 7 — H1) ĐÍNH CHÍNH LẬP LUẬN CŨ:
// Comment cũ claim "Cross-site attacker KHÔNG đọc được body này (no CORS)" —
// SAI về căn bản: CORS chỉ là hướng dẫn cho BROWSER-JS, KHÔNG ràng buộc
// client HTTP trực tiếp. Bằng chứng máy (r65): `curl http://<app>/api/auth/setup`
// không kèm xác thực gì → nhận token 48 ký tự full-quyền. Gateway Caddy không
// có tầng auth phía trên → mọi ai tới được app đều lấy được token → gọi được
// mọi API x-tmo-api-token. Chuỗi hoàn chỉnh: token công khai + execute
// chunked-bypass (H3, đã fix) = DoS công khai; token + /api/opencode/* NOAUTH
// family (P0-2) = RCE công khai.
// Mitigation r65 (KHÔNG đổi response shape — giữ preview panel + mission-dispatch
// sống): rate-limit per-IP + audit-log mọi lượt phát token (dấu vết quan sát).
// Giải pháp TRIỆT ĐỂ (origin-bind / scoped token / SameSite=None-cookie) cần
// cân bằng với iframe preview → đề bài mission P0-2 "auth matrix" (đã có
// inventory 202 route từ mission #18).

import { NextResponse } from 'next/server'
import { ensureTmoApiToken } from '@/lib/tmo-token'

export const dynamic = 'force-dynamic'

// ---- r65 (H1) rate-limit: 60 lượt / phút / IP ----
// User thật: page mount gọi ~1 lần/reload; mission-dispatch 1 lần/chạy từ
// loopback. Bot quét/churn > 1 req/s duy trì bị chặn. In-memory (đơn process
// PM2 — nhất quán với các rate-limiter khác của app).
const RATE_LIMIT = 60
const RATE_WINDOW_MS = 60_000
const rateMap = new Map<string, { count: number; resetAt: number }>()

function clientIp(request: Request): string {
  // Caddy gateway set x-real-ip / x-forwarded-for = remote_host thật.
  const forwarded = request.headers.get('x-forwarded-for')
  return (
    request.headers.get('x-real-ip') ??
    (forwarded ? forwarded.split(',')[0]?.trim() : undefined) ??
    'local'
  )
}

/** true = được phép xử lý; false = vượt ngưỡng cửa sổ hiện tại. */
function takeRateSlot(ip: string): boolean {
  const now = Date.now()
  // Sweep định kỳ — chống Map phình theo lượng IP lạ (chỉ khi vượt kích thước an toàn).
  if (rateMap.size > 4096) {
    for (const [key, entry] of rateMap) {
      if (entry.resetAt <= now) rateMap.delete(key)
    }
  }
  const entry = rateMap.get(ip)
  if (!entry || entry.resetAt <= now) {
    rateMap.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS })
    return true
  }
  entry.count += 1
  return entry.count <= RATE_LIMIT
}

export async function GET(request: Request) {
  const ip = clientIp(request)
  if (!takeRateSlot(ip)) {
    console.warn(
      `[auth/setup] RATE-LIMIT ip=${ip} — vượt ${RATE_LIMIT} lượt/${RATE_WINDOW_MS / 1000}s, từ chối`
    )
    return NextResponse.json(
      { ok: false, error: 'Too many setup requests — thử lại sau 60 giây' },
      { status: 429 },
    )
  }

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

  // r65 (H1): audit-log MỌI lượt phát token — dấu vết cho mission-watch/quan
  // sát vận hành. KHÔNG log token/cookie (chỉ IP + UA cắt ngắn).
  console.log(
    `[auth/setup] ISSUE ip=${ip} ua="${(request.headers.get('user-agent') ?? '?').slice(0, 80)}"`
  )

  // FIX 2026-09-25 (preview iframe 401): trả token trong body để client lưu
  // localStorage (x-tmo-api-token header qua authedFetch). Cookie SameSite=Lax
  // bị browser chặn trong cross-site iframe (preview panel) → mọi request
  // /api/opencode/* bị 401 mãi dù route này trả 200. Header không bị luật
  // SameSite ràng buộc → đường localStorage hoạt động ở MỌI context.
  // ⚠ r65: "no CORS" KHÔNG bảo vệ endpoint này khỏi client HTTP trực tiếp —
  // xem đính chính đầu file; mitigation = rate-limit + audit-log ở trên.
  const res = NextResponse.json({ ok: true, token, expiry: '30d' })
  res.cookies.set('tmo_api_token', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 60 * 60 * 24 * 30, // 30 days
  })
  return res
}
