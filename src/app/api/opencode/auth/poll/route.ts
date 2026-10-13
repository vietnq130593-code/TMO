/**
 * OpenCode Account OAuth — Poll device token (+ probe free-tier)
 * POST /api/opencode/auth/poll  body {deviceCode}
 *
 * Bước 3 device flow: hỏi console "user phê duyệt chưa?" —
 *   pending → UI tiếp tục poll (~mỗi 5s, hết hạn 600s)
 *   success → session token LƯU store + probe space-bunny-free NGAY:
 *     • probe OK (free tier mở) → xoá block-cache http các model free zen
 *       (clearZenFreeTierBlocks — dropdown bỏ badge ⚠) + ghi session vào
 *       auth.json của opencode CLI (CLI native cũng dùng session).
 *     • probe fail → trả kết quả TRUNG THỰC (freeTierUnlocked=false + detail)
 *       — chuỗi failover cũ (CLI → ZEN FAILOVER → LAST RESORT → NIM RESCUE)
 *       vẫn nguyên vẹn, agents không chết.
 */

import { NextRequest, NextResponse } from 'next/server'
import { pollDeviceToken, writeAuthJsonForCli } from '@/lib/opencode-oauth'
import { clearZenFreeTierBlocks } from '@/lib/llm'
import { PROVIDER_MODELS } from '@/lib/agent-constants'

export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({})) as { deviceCode?: string }
    const deviceCode = (body.deviceCode || '').trim()
    if (!deviceCode) {
      return NextResponse.json({ error: 'Thiếu deviceCode (lấy từ /api/opencode/auth/login)' }, { status: 400 })
    }
    const result = await pollDeviceToken(deviceCode)
    if (result.status === 'success' && result.freeTier.unlocked) {
      // Free tier MỞ với session → dropdown + CLI đồng bộ trạng thái mới
      const zenFreeModelIds = PROVIDER_MODELS.zen.map(m => m.id)
      clearZenFreeTierBlocks('http', zenFreeModelIds)
      writeAuthJsonForCli(result.session)
    }
    // status/error http: poll trả 200 cho MỌI kết quả flow hợp lệ (pending/
    // expired/denied là trạng thái flow, không phải lỗi server) — UI đọc
    // result.status. Lỗi server thật (mạng…) cũng 200 + status:'error' để UI
    // poll loop không chết (console có thể chớp nhoáng).
    return NextResponse.json(result)
  } catch (err) {
    return NextResponse.json(
      { status: 'error' as const, message: `Lỗi poll device-token: ${err instanceof Error ? err.message : String(err)}` },
      { status: 200 },
    )
  }
}
