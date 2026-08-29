/**
 * SELF-DIRECTION DELEGATION API
 * ====================================
 * POST /api/self-direction/delegation — Bật/tắt ủy quyền duyệt cho Omega
 * body: {enabled: boolean}
 *
 * BẬT  → Omega phê duyệt/không duyệt các đề xuất THAY Mr. Architect
 *        (mọi proposal pending được kick review ngay lập tức — fire-and-forget)
 * TẮT  → Mr. Architect tự duyệt lại như bình thường
 */

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { setDelegation, getSelfDirectionSettings, kickOmegaReviewsSerially } from '@/lib/self-direction/orchestrator'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
    const enabled = body.enabled === true || body.enabled === 'true'

    await setDelegation(enabled)
    const settings = await getSelfDirectionSettings()

    if (enabled) {
      // Kick Omega review mọi proposal pending ngay — TUẦN TỰ (chống 429 storm
      // khi hàng chục review đổ dồn vào LLM cùng lúc), fire-and-forget
      const pending = await db.selfDirectionProposal.findMany({
        where: { status: 'pending' },
        select: { id: true },
        orderBy: { createdAt: 'asc' },
        take: 10,
      })
      const queued = kickOmegaReviewsSerially(pending.map(p => p.id))
      console.log(`[SelfDirection] ỦY QUYỀN DUYỆT BẬT — Omega sẽ duyệt ${queued} đề xuất đang chờ thay Mr. Architect (xếp hàng tuần tự)`)
    } else {
      console.log('[SelfDirection] ỦY QUYỀN DUYỆT TẮT — Mr. Architect tự duyệt lại')
    }

    return NextResponse.json({ settings })
  } catch (err) {
    console.error('[SelfDirection] POST delegation error:', err)
    return NextResponse.json({ error: 'Không đổi được chế độ ủy quyền' }, { status: 500 })
  }
}
