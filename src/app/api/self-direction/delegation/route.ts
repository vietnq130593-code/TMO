/**
 * SELF-DIRECTION DELEGATION API
 * ====================================
 * POST /api/self-direction/delegation — Bật/tắt ủy quyền duyệt cho Opus
 * body: {enabled: boolean}
 *
 * USER DECISION #3 (2026-09-30): ủy quyền phê duyệt chuyển từ Omega sang
 * OPUS (CTO). Response payload đổi field ủy quyền cũ → opusDelegated
 * (theo cột SelfDirectionSettings.opusDelegated đã db push).
 *
 * USER REQUEST (2026-09-02): khi bật ủy quyền, Opus duyệt TUẦN TỰ:
 *  - Kiểm tra có đề xuất đang tiến hành (orchestration running) không → KHÔNG duyệt thêm
 *  - Chỉ duyệt khi tất cả đề xuất đã duyệt được xử lý xong (completed/failed)
 *  - Duyệt từng đề xuất, chờ xử lý xong mới duyệt cái tiếp
 *  - Ưu tiên đề xuất nào nên duyệt (priority desc + createdAt asc)
 *
 * BẬT  → Opus phê duyệt/không duyệt các đề xuất THAY Mr. Architect (tuần tự)
 * TẮT  → Mr. Architect tự duyệt lại như bình thường
 */

import { NextRequest, NextResponse } from 'next/server'
import { setDelegation, getSelfDirectionSettings, autoReviewPendingIfDelegated } from '@/lib/self-direction/orchestrator'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
    const enabled = body.enabled === true || body.enabled === 'true'

    await setDelegation(enabled)
    const settings = await getSelfDirectionSettings()

    if (enabled) {
      // USER REQUEST (2026-09-02): KHÔNG kick ngay lập tức — gọi
      // autoReviewPendingIfDelegated sẽ (a) kiểm tra có orchestration đang chạy
      // không → skip nếu có, (b) duyệt tuần tự + chờ orchestration hoàn thành
      // trước khi duyệt cái kế. Fire-and-forget (void) — API return ngay.
      void autoReviewPendingIfDelegated()
      console.log('[SelfDirection] ỦY QUYỀN DUYỆT BẬT — Opus sẽ duyệt tuần tự (chờ orchestration xong mới duyệt cái kế)')
    } else {
      console.log('[SelfDirection] ỦY QUYỀN DUYỆT TẮT — Mr. Architect tự duyệt lại')
    }

    return NextResponse.json({ settings })
  } catch (err) {
    console.error('[SelfDirection] POST delegation error:', err)
    return NextResponse.json({ error: 'Không đổi được chế độ ủy quyền' }, { status: 500 })
  }
}
