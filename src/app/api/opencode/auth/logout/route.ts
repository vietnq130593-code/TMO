/**
 * OpenCode Account OAuth — Logout
 * POST /api/opencode/auth/logout
 *
 * Xoá session (memory + db/opencode-oauth.json) + khôi phục auth.json của
 * opencode CLI về oc_sk key từ ZEN_API_KEY_1. Block-cache zen giữ nguyên
 * (sẽ tự hết hạn theo TTL — không cần đập: model free có thể vẫn bị chặn
 * với oc_sk, badge ⚠ nói thật trạng thái đó sau logout).
 */

import { NextResponse } from 'next/server'
import { logoutOpenCode } from '@/lib/opencode-oauth'

export const dynamic = 'force-dynamic'

export async function POST() {
  try {
    const status = logoutOpenCode()
    return NextResponse.json({ ok: true, ...status })
  } catch (err) {
    return NextResponse.json(
      { error: 'Logout thất bại', details: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    )
  }
}
