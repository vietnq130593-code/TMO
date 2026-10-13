/**
 * OpenCode Account OAuth — Bắt đầu device login
 * POST /api/opencode/auth/login
 *
 * Bước 1 device flow (RFC 8628): xin device_code + user_code từ OpenCode
 * Console. UI hiển thị verificationUrl cho user mở TRÊN MÁY MÌNH (đăng nhập
 * tài khoản OpenCode → phê duyệt). Sau đó UI poll /api/opencode/auth/poll
 * mỗi ~5s với deviceCode trả về đây.
 *
 * Máy app KHÔNG cần mở browser — flow thiết kế sẵn cho thiết bị không GUI
 * (đúng hoàn cảnh sandbox/preview panel).
 */

import { NextResponse } from 'next/server'
import { startDeviceLogin } from '@/lib/opencode-oauth'

export const dynamic = 'force-dynamic'

export async function POST() {
  try {
    const start = await startDeviceLogin()
    return NextResponse.json(start)
  } catch (err) {
    return NextResponse.json(
      { error: 'Không bắt đầu được đăng nhập OpenCode (device-code)', details: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    )
  }
}
