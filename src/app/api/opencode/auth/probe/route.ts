/**
 * OpenCode Account OAuth — Re-probe free tier
 * POST /api/opencode/auth/probe
 *
 * Đăng nhập rồi nhưng probe trước đó fail (policy Zen lật ngược nhiều lần —
 * xem worklog r72/r74/Task 28)? UI cho nút "Thử lại" gọi route này: probe
 * lại space-bunny-free với session (cả 2 endpoint /zen/v1 + /inference/v1),
 * cập nhật kết quả vào session store. Probe OK → xoá block-cache http model
 * free + ghi auth.json CLI (giống poll route).
 */

import { NextResponse } from 'next/server'
import { getValidZenSession, probeFreeTier, updateSessionFreeTier, writeAuthJsonForCli } from '@/lib/opencode-oauth'
import { clearZenFreeTierBlocks } from '@/lib/llm'
import { PROVIDER_MODELS } from '@/lib/agent-constants'

export const dynamic = 'force-dynamic'

export async function POST() {
  try {
    const session = await getValidZenSession()
    if (!session) {
      return NextResponse.json({ error: 'Chưa đăng nhập OpenCode account (hoặc session hết hạn + refresh fail) — POST /api/opencode/auth/login trước' }, { status: 400 })
    }
    const freeTier = await probeFreeTier(session.accessToken)
    // Cập nhật kết quả probe mới nhất vào session store (status route đọc từ đó)
    updateSessionFreeTier({ probedAt: Date.now(), ...freeTier })
    if (freeTier.unlocked) {
      const zenFreeModelIds = PROVIDER_MODELS.zen.map(m => m.id)
      clearZenFreeTierBlocks('http', zenFreeModelIds)
      writeAuthJsonForCli(session)
    }
    return NextResponse.json({ freeTier })
  } catch (err) {
    return NextResponse.json(
      { error: 'Probe thất bại', details: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    )
  }
}
