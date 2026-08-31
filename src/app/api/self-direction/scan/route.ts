/**
 * SELF-DIRECTION SCAN API
 * ====================================
 * POST /api/self-direction/scan — Chạy quét tự phân tích hệ thống
 * ("mình thiếu gì? cần thêm gì? học gì? KB mâu thuẫn? tool hay fail?
 *  skill nào thiếu? test nào chưa có?") → tạo đề xuất mới chờ phê duyệt.
 *
 * Có thể mất 10-60s (nhiều nguồn dữ liệu + LLM) — client cần timeout dài.
 */

import { NextResponse } from 'next/server'
import { runSelfDirectionScan } from '@/lib/self-direction/scan'
import { getSelfDirectionSettings, kickOmegaReviewsSerially } from '@/lib/self-direction/orchestrator'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

export async function POST() {
  try {
    const result = await runSelfDirectionScan()

    // Ủy quyền đang bật → Opus review ngay các đề xuất mới — tuần tự chống
    // 429 storm (fire-and-forget; user decision #3: duyệt chuyển Omega → Opus)
    const settings = await getSelfDirectionSettings()
    if (settings.opusDelegated && result.proposals.length > 0) {
      kickOmegaReviewsSerially(result.proposals.map(p => p.id))
    }

    return NextResponse.json(result)
  } catch (err) {
    console.error('[SelfDirection] POST scan error:', err)
    return NextResponse.json({ error: 'Quét hệ thống thất bại' }, { status: 500 })
  }
}
