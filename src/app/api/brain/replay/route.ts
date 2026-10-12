/**
 * BRAIN REPLAY-EVAL API — POST /api/brain/replay (BRAIN-P3, blueprint §4.3)
 * ============================================================================
 *
 * "Chấm một cấu hình (model, agent, delegated) trên surrogate thay vì chạy
 * thật" — bước leo Level 2 của khung thẩm định. Dùng ngay cho:
 * model-comparison (bổ trợ ANOVA P4-M2), Q-advice bootstrap các action chưa
 * thử (giảm chi phí exploration), sweep cấu hình.
 *
 * Body: { model: string, agent?: string|null, delegated?: boolean }
 *   - model bắt buộc (non-empty) — id model cần chấm
 *   - agent: tên agent (proxy "lớp nhiệm vụ") — null/undefined → không nói
 *   - delegated: có phải sub-agent/delegation run không (mặc định false)
 *
 * Hành vi:
 *   - READ-ONLY TUYỆT ĐỐI — chỉ SELECT (r86 pin: không ghi DB gì cả);
 *   - Luôn trả khối `history` — đo lường thuần trên AgentRunRecord của
 *     model: success rate + Wilson CI + median tokens/duration kèm
 *     bootstrap percentile CI (tất định theo seed — tái lập được);
 *   - Khối `surrogate` (ước lượng MLP P(success)/E[tokens]/E[latency]):
 *     CHỈ khi cờ `replay_eval` (STORE > ENV > DEFAULT=off) bật VÀ có bản
 *     BrainModel active VÀ đầu tương ứng thắng baseline CV — cờ off (mặc
 *     định) = "chỉ đo/báo cáo" đúng điểm dừng blueprint;
 *   - model lạ chưa từng chạy (n=0) → history rate/CI null (không bịa số),
 *     ước lượng MLP vẫn có thể tính (one-hot 0 — impute qua chuẩn hóa);
 *   - sai body (thiếu model) → 400; lỗi hệ thống → 500 (fail-open — không
 *     bao giờ làm hỏng gì vì chẳng ghi gì).
 */

import { NextResponse } from 'next/server'
import { buildReplayReport, type SurrogateFeatureCtx } from '@/lib/brain/brains/surrogate'

export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  let body: { model?: unknown; agent?: unknown; delegated?: unknown } = {}
  try {
    body = (await request.json()) as { model?: unknown; agent?: unknown; delegated?: unknown }
  } catch {
    return NextResponse.json({ error: 'Body phải là JSON { model, agent?, delegated? }' }, { status: 400 })
  }

  const model = typeof body.model === 'string' ? body.model.trim() : ''
  if (!model) {
    return NextResponse.json(
      { error: "Thiếu 'model' (string không rỗng) — cấu hình cần chấm replay" },
      { status: 400 },
    )
  }
  const agent =
    typeof body.agent === 'string' && body.agent.trim() !== '' ? body.agent.trim() : null
  const delegated = body.delegated === true

  try {
    const config: SurrogateFeatureCtx = { model, agent, delegated }
    const report = await buildReplayReport(config)
    return NextResponse.json(report)
  } catch (err) {
    console.error('[BrainReplay] POST failed:', err instanceof Error ? err.message : String(err))
    return NextResponse.json(
      {
        error: 'Replay-eval thất bại (read-only — không ảnh hưởng trạng thái gì)',
        details: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    )
  }
}
