/**
 * INTERACTIVE-TX STATS — KPI #2 (BLUEPRINT-R17BC v0.2 §6)
 * =====================================================
 * KPI #2: "Interactive tx p95 (ledger + trace) < 2s" — baseline 5s expired
 * bị kéo 15s (ledger writeOne, OBS-1). W1 đã đưa 4 nhóm write vào batcher;
 * interactive tx còn lại (ledger writeOne cấp seq + trace writeOne) vẫn đi
 * TRỰC — cần đo p95 trên RUN THẬT để nghiệm thu (nguyên tắc §3.7: chỉ công
 * nhận khi có run thật đầy đủ).
 *
 * Thiết kế:
 *   - Histogram IN-MEMORY THEO PROCESS (globalThis — sống qua HMR, tiền lệ
 *     gLlmBreakerState/db-write-batcher): mỗi label 1 entry {count, totalMs,
 *     maxMs, samples ring 512}. noteInteractiveTxMs() rẻ (push mảng + 3 phép
 *     gán) — an toàn gọi trên MỖI write.
 *   - Ring 512 mẫu cuối (không phải toàn lịch sử): p95 phản ánh GẦN ĐÂY —
 *     đúng cho vận hành; "tích lũy dài hạn" dựa trên snapshot kpi.tx định
 *     kỳ vào ObservationEvent (ledger drain phát, 1 event / 1000 write).
 *   - READ-ONLY ops route /api/observation/interactive-tx (mirror write-queue
 *     precedent): khi GOAL_LOOP_WORKER_MODE=split, route chỉ thấy process API
 *     — stats worker lộ qua log chu kỳ + snapshot event (processRole phân
 *     biệt 2 process — cùng convention S4).
 *   - Fail-open tuyệt đối: stats là side-channel đo lường, KHÔNG bao giờ
 *     làm hỏng write chính (caller bọc try/catch ở call-site chính, nhưng
 *     chính module cũng guard NaN/âm).
 */

/** Ring mẫu mỗi label — 512 đủ mượt cho p95, nhỏ để rẻ khi push. */
export const TX_STATS_RING_MAX = 512

export interface TxLabelStats {
  label: string
  count: number
  totalMs: number
  maxMs: number
  avgMs: number
  p50Ms: number
  p95Ms: number
  p99Ms: number
  ringSamples: number
}

export interface InteractiveTxStatsSnapshot {
  processRole: string
  labels: TxLabelStats[]
}

type LabelState = { count: number; totalMs: number; maxMs: number; samples: number[] }

const gTxStats = globalThis as unknown as {
  __tmoInteractiveTxStats?: Map<string, LabelState>
}

function state(): Map<string, LabelState> {
  if (!gTxStats.__tmoInteractiveTxStats) {
    gTxStats.__tmoInteractiveTxStats = new Map<string, LabelState>()
  }
  return gTxStats.__tmoInteractiveTxStats
}

/** Ghi 1 mẫu duration (ms) cho label. NaN/âm/∞ bị bỏ (guard — không throw). */
export function noteInteractiveTxMs(label: string, ms: number): void {
  if (!label || !Number.isFinite(ms) || ms < 0) return
  const st = state()
  let entry = st.get(label)
  if (!entry) {
    entry = { count: 0, totalMs: 0, maxMs: 0, samples: [] }
    st.set(label, entry)
  }
  entry.count++
  entry.totalMs += ms
  if (ms > entry.maxMs) entry.maxMs = ms
  // Ring: đẩy hết → cắt đầu (FIFO ring bằng slice — 512 phần tử, rẻ)
  entry.samples.push(ms)
  if (entry.samples.length > TX_STATS_RING_MAX) {
    entry.samples = entry.samples.slice(entry.samples.length - TX_STATS_RING_MAX)
  }
}

/**
 * Percentile từ mảng ĐÃ SẮP XẾP TĂNG DẦN (thuần — test trực tiếp).
 * Nearest-rank: p ∈ [0,100]; mảng rỗng → 0. p95 của [1..100] = 95 (rank
 * ceil(0.95×100)=95 → phần tử thứ 95).
 */
export function percentileFromSorted(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0
  const clamped = Math.min(100, Math.max(0, p))
  const rank = Math.ceil((clamped / 100) * sorted.length)
  const idx = Math.min(sorted.length, Math.max(1, rank)) - 1
  return Math.round(sorted[idx])
}

/** Snapshot stats hiện tại (mọi label, sắp count giảm dần — dễ đọc ops). */
export function getInteractiveTxStats(): InteractiveTxStatsSnapshot {
  const labels: TxLabelStats[] = []
  for (const [label, entry] of state()) {
    const sorted = [...entry.samples].sort((a, b) => a - b)
    labels.push({
      label,
      count: entry.count,
      totalMs: entry.totalMs,
      maxMs: entry.maxMs,
      avgMs: entry.count > 0 ? Math.round(entry.totalMs / entry.count) : 0,
      p50Ms: percentileFromSorted(sorted, 50),
      p95Ms: percentileFromSorted(sorted, 95),
      p99Ms: percentileFromSorted(sorted, 99),
      ringSamples: entry.samples.length,
    })
  }
  labels.sort((a, b) => b.count - a.count)
  return {
    processRole: process.env.TMO_PROCESS_ROLE ?? 'api',
    labels,
  }
}

/** Chỉ cho test — xoá toàn bộ state. */
export function resetInteractiveTxStats(): void {
  gTxStats.__tmoInteractiveTxStats = new Map<string, LabelState>()
}
