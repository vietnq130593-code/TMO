/**
 * KPI #2 (BLUEPRINT-R17BC v0.2 §6 — trả nợ 2026-10-21) — INTERACTIVE-TX OPS API
 * ============================================================================
 * GET /api/observation/interactive-tx
 *   → getInteractiveTxStats() nguyên vẹn: processRole + labels[] mỗi label
 *     {label, count, totalMs, maxMs, avgMs, p50Ms, p95Ms, p99Ms, ringSamples}.
 *
 * Phục vụ nghiệm thu KPI #2 "Interactive tx p95 (ledger + trace) < 2s" trên
 * RUN THẬT (nguyên tắc §3.7 — chỉ công nhận khi có run thật đầy đủ):
 *   - p95 tính trên ring 512 mẫu GẦN ĐÂY mỗi process (đúng cho vận hành);
 *   - tích lũy DÀI HẠN xuyên restart qua snapshot kind 'kpi.tx' (ledger drain
 *     phát 1 event / 1000 write — timeline /api/observation/timeline).
 *
 * HẠN CHẾ minh thị (mirror write-queue precedent): stats là IN-MEMORY THEO
 * PROCESS — route này chỉ thấy PROCESS API. Khi GOAL_LOOP_WORKER_MODE=split,
 * job chạy trong process theopus-worker (0 port) → stats worker lộ qua
 * snapshot kpi.tx processRole=worker trong timeline + log chu kỳ worker.
 *
 * Hợp đồng:
 *   - READ-ONLY TUYỆT ĐỐI — thuần getter in-memory, không chạm DB, không ghi;
 *   - Chưa có mẫu nào → vẫn 200 (labels: [] — trung thực, không giả số);
 *   - Fail-open: lỗi ngoài dự kiến → 500 + error message, không throw sập.
 */
import { NextResponse } from 'next/server'
import { getInteractiveTxStats } from '@/lib/observation/tx-stats'

export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    return NextResponse.json(getInteractiveTxStats())
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    )
  }
}
