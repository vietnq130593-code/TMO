/**
 * OpenCode Account OAuth — Status
 * GET /api/opencode/auth/status
 *
 * USER REQUEST 2026-10-14 ("opencode auth login bằng account OpenCode để dùng
 * các lõi free"): UI gọi route này (mount + mỗi lần mở dropdown model) để
 * biết: đã đăng nhập tài khoản OpenCode chưa / session còn hạn không / probe
 * free-tier gần nhất nói gì (unlocked hay không). Khi chưa đăng nhập mà user
 * chọn lõi free đang bị chặn → dropdown hiện panel đăng nhập (device flow).
 *
 * Device flow + cơ chế: xem src/lib/opencode-oauth.ts (đảo ngược-engineering
 * console OpenCode 2026-10-14 — /console/auth/device/code → user phê duyệt →
 * /console/auth/device/token → session Bearer cho Zen).
 */

import { NextResponse } from 'next/server'
import { getOAuthStatus, isSessionRecentlyRejected, sessionRejectReason } from '@/lib/opencode-oauth'

export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const status = getOAuthStatus()
    return NextResponse.json({
      ...status,
      // Cooldown do server từ chối session gần đây (401/403) — UI hiển thị
      // trạng thái "session bị từ chối, thử lại sau" thay vì im lặng.
      sessionRejectedRecently: isSessionRecentlyRejected(),
      sessionRejectReason: sessionRejectReason() || undefined,
    })
  } catch (err) {
    return NextResponse.json(
      { error: 'Failed to get OpenCode auth status', details: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    )
  }
}
