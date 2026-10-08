// ============================================================================
// TEST SUITE — /api/auth/setup rate-limit + audit-log (r65, audit lượt 7 — H1)
//
// BỐI CẢNH: endpoint PUBLIC phát token toàn quyền trong body. CORS không bảo
// vệ non-browser client (curl nhận thẳng token — bằng chứng máy r65). Mitigation
// r65: 60 lượt/phút/IP + audit-log; KHÔNG đổi response shape (giữ preview
// panel + mission-dispatch sống). Triệt để (origin-bind/scoped-token) = đề bài
// mission P0-2.
//
// Gọi GET handler TRỰC TIẾP (pattern tests/execute-route-security.test.ts).
// Dùng IP TEST-NET (RFC 5737) để không đụng IP thật/loopback của test khác —
// rateMap là module-level state nên tính độc lập theo IP.
// ============================================================================

import { describe, test, expect } from 'bun:test'
import { GET } from '../src/app/api/auth/setup/route'

const ENDPOINT = 'http://localhost:3000/api/auth/setup'

function setupRequest(ip: string): Request {
  return new Request(ENDPOINT, { headers: { 'x-real-ip': ip } })
}

describe('r65 (H1-mitigation) — /api/auth/setup rate-limit per-IP', () => {
  test('60 lượt đầu trong cửa sổ 1 phút → OK; lượt 61 → 429', async () => {
    const ip = '203.0.113.10' // TEST-NET-3 — duy nhất cho test này
    let okCount = 0
    let throttled: number | null = null
    for (let i = 1; i <= 61; i++) {
      const res = await GET(setupRequest(ip))
      if (res.status === 429) {
        throttled = i
        break
      }
      // Endpoint có thể 200 (token) hoặc 503 (token chưa provision) — cả hai
      // đều là "được xử lý", KHÔNG phải bị rate-limit.
      expect([200, 503]).toContain(res.status)
      okCount++
    }
    expect(okCount).toBe(60) // đủ ngưỡng mà không bị chặn sớm (không gãy user thật)
    expect(throttled).toBe(61) // chặn đúng lượt vượt ngưỡng
  })

  test('IP khác KHÔNG bị ảnh hưởng bởi IP đã throttle (isolated buckets)', async () => {
    const blockedIp = '203.0.113.11'
    const freshIp = '203.0.113.12'
    // Làm bão hòa blockedIp
    for (let i = 0; i < 65; i++) {
      await GET(setupRequest(blockedIp))
    }
    const stillBlocked = await GET(setupRequest(blockedIp))
    expect(stillBlocked.status).toBe(429)
    // IP mới vẫn xử lý bình thường
    const fresh = await GET(setupRequest(freshIp))
    expect([200, 503]).toContain(fresh.status)
    expect(fresh.status).not.toBe(429)
  })

  test('thiếu header IP (curl nội bộ / loopback) → bucket "local" vẫn hoạt động', async () => {
    const res = await GET(new Request(ENDPOINT))
    expect([200, 503]).toContain(res.status)
  })

  test('khi được xử lý: response vẫn có shape cũ (ok:true + token) — KHÔNG gãy preview', async () => {
    const ip = '203.0.113.13'
    const res = await GET(setupRequest(ip))
    if (res.status === 200) {
      const data = (await res.json()) as { ok?: boolean; token?: string; expiry?: string }
      expect(data.ok).toBe(true)
      expect(typeof data.token).toBe('string')
      expect(data.token!.length).toBeGreaterThan(16)
      expect(data.expiry).toBe('30d')
      // Cookie vẫn được set (đường same-origin cũ không đổi)
      const setCookie = res.headers.get('set-cookie') ?? ''
      expect(setCookie).toContain('tmo_api_token=')
    } else {
      // 503 = token chưa provision trong môi trường test — chấp nhận (đã phủ
      // bằng test khác); mấu chốt ở đây là KHÔNG bao giờ 429 cho IP tươi.
      expect(res.status).toBe(503)
    }
  })
})
