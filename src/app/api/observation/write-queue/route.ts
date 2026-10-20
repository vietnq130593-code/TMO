/**
 * W1+W2 (BLUEPRINT-R17BC v0.2) — WRITE-QUEUE OPS API (đo KPI #3/#9 live)
 * ============================================================================
 * GET /api/observation/write-queue
 *   → getWriteQueueStats() nguyên vẹn 16 số: enabled / queueDepth /
 *     retainedBatches / flushing / lastBatchSize / lastFlushMs / lastHoldMs /
 *     chunkSize / flushP95Ms / flushedBatches / flushedOps / coalescedOps /
 *     dropCount / retryCount / salvageSplits / poisonCount.
 *
 * Phục vụ đối KPI pilot live: #3 (flushP95 <1s, drop=0) + #9 (ops-mất/crash)
 * — không cần mở port mới, không side-effect.
 *
 * HẠN CHẾ minh thị: stats là IN-MEMORY THEO PROCESS — route này chỉ thấy
 * PROCESS API. Khi GOAL_LOOP_WORKER_MODE=split, job chạy trong process
 * theopus-worker (0 port — nguyên tắc 0 IPC giữ nguyên) → stats worker lộ
 * qua dòng log chu kỳ "[theopus-worker] write-queue stats"
 * (WORKER_STATS_LOG_MS, default 5 phút) trong dev.log — không thêm kênh
 * IPC chỉ để đo.
 *
 * Hợp đồng:
 *   - READ-ONLY TUYỆT ĐỐI — thuần getter in-memory, không chạm DB, không
 *     ghi gì (pin r96 precedent các route observation);
 *   - Flag DB_WRITE_QUEUE=off → vẫn 200 (enabled:false — trạng thái trung
 *     thực, không giả "không có hàng đợi");
 *   - Fail-open: lỗi ngoài dự kiến → 500 + error message, không throw sập.
 */
import { NextResponse } from 'next/server'
import { getWriteQueueStats } from '@/lib/db-write-batcher'

export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    return NextResponse.json(getWriteQueueStats())
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    )
  }
}
