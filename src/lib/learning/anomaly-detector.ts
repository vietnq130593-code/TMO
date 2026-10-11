/**
 * P1-M3 · IQR ANOMALY DETECTOR trên ToolMetric — phát hiện tool chạy bất
 * thường (thời lượng) mà errorTag không bắt được.
 *
 * Nguồn: BLUEPRINT-STATS-LEARNING-P0-P6.md §P1-M3 (mục #4 — DA.pdf
 * §Outlier Detection IQR/boxplot, Tukey fence).
 *
 * Thuật toán:
 *   - Cửa sổ `lookbackDays` (default 7) theo nhóm (toolName, agentRole):
 *     iqrBounds(durations, 1.5) từ stats/descriptive — bất thường ⇔
 *     durationMs > q3 + 1.5·iqr.
 *   - Điều kiện n ≥ 20 cho TỪNG nhóm — dưới ngưỡng bỏ qua, chống nhiễu mẫu
 *     nhỏ (đúng LLN/CLT — ít mẫu thì quantile không nói được gì).
 *   - "Bất thường MỚI" = điểm ngoài bound có timestamp trong 24h qua (bounds
 *     học từ lịch sử, chỉ điểm mới được ghi — điểm cũ trong 7 ngày chỉ đóng
 *     góp vào bounds).
 *   - score = (value − q3)/iqr; iqr = 0 (cả nhóm cùng duration) → score là
 *     phần vượt tuyệt đối (value − q3) — tránh Infinity làm hỏng cột REAL.
 *
 * Idempotency (kiểm chứng blueprint): khoá trùng = (kind, toolName,
 * agentRole, value, observedAt truncate GIỜ) — scan 2 lần liên tiếp không
 * nhân bản anomaly của cùng 1 tool call.
 *
 * Vệ sinh: sweep xóa anomaly > 30 NGÀY ngay từ đầu (bài học bảng phình
 * ToolMetric ROUND-32 — không để nợ TTL tích luỹ).
 *
 * Fail-open TOÀN PHẦN (blueprint nguyên tắc 3): KHÔNG bao giờ throw — lỗi
 * DB → kết quả { scanned: 0, anomalies: 0, byTool: [], error } để caller
 * (route/overview) trả zero-state thay vì sập response.
 */

import { db } from '@/lib/db'
import { iqrBounds } from '@/lib/stats'
// NEURAL-ARCH (2026-10-11): k (Tukey fence) + n tối thiểu nhóm đọc runtime
// (anomaly_iqr_k / anomaly_min_group_size — STORE > ENV > hằng số) —
// tinh chỉnh trên tab Kiến trúc Neural; hằng số export giữ làm default + test.
import { getTuningNumber } from '@/lib/learning/tuning-store'

export interface AnomalyScanResult {
  /** Tổng số ToolMetric rows đã soát trong cửa sổ */
  scanned: number
  /** Số anomaly MỚI được ghi trong scan này (đã khử trùng) */
  anomalies: number
  /** Thống kê per toolName: số call soát / số anomaly mới */
  byTool: Array<{ toolName: string; n: number; anomalies: number }>
  /** Số anomaly cũ (>30 ngày) đã dọn trong sweep */
  pruned: number
  /** Chỉ có mặt khi scan fail (fail-open — không throw) */
  error?: string
}

/** Ngưỡng mẫu tối thiểu per nhóm (toolName, agentRole) để tính bounds. */
export const ANOMALY_MIN_GROUP_SIZE = 20

/** Tukey fence k. */
export const ANOMALY_IQR_K = 1.5

/** Chỉ điểm trong 24h qua được ghi là "bất thường mới". */
export const ANOMALY_RECENT_HOURS = 24

/** Anomaly cũ hơn này bị dọn mỗi scan. */
export const ANOMALY_RETENTION_DAYS = 30

/** kind của anomaly v1 — duration vượt rìa Tukey. */
export const ANOMALY_KIND_DURATION = 'tool_duration_high'

/** Khoá khử trùng: (kind, toolName, agentRole, value, giờ của observedAt). */
function dedupeKey(kind: string, toolName: string, agentRole: string, value: number, observedAt: Date): string {
  // FB-P1-R1-03: NUL separator — chống collision khi toolName/agentRole chứa '|'
  return [kind, toolName, agentRole, String(value), String(Math.floor(observedAt.getTime() / 3_600_000))].join('\u0000')
}

/**
 * Quét ToolMetric trong `lookbackDays` (default 7, kẹp [1, 30]) — tính IQR
 * bounds per (toolName, agentRole), ghi các điểm bất thường MỚI (ngoài
 * bound, trong 24h qua) vào MetricAnomaly, dọn anomaly >30 ngày.
 * KHÔNG bao giờ throw.
 */
export async function scanToolMetricAnomalies(lookbackDays = 7): Promise<AnomalyScanResult> {
  const days = Math.max(1, Math.min(lookbackDays, 30))
  const now = Date.now()
  const since = new Date(now - days * 24 * 3600 * 1000)
  const sinceRecent = new Date(now - ANOMALY_RECENT_HOURS * 3600 * 1000)

  try {
    // 0) Vệ sinh — dọn anomaly quá hạn ngay từ đầu (chống bảng phình)
    let pruned = 0
    try {
      const sweep = await db.metricAnomaly.deleteMany({
        where: { observedAt: { lt: new Date(now - ANOMALY_RETENTION_DAYS * 24 * 3600 * 1000) } },
      })
      pruned = sweep.count
    } catch (err) {
      console.warn('[AnomalyDetector] prune failed (fail-open):', err instanceof Error ? err.message : String(err))
    }

    // 1) Đọc cửa sổ ToolMetric
    const rows = await db.toolMetric.findMany({
      where: { timestamp: { gte: since } },
      select: { toolName: true, agentRole: true, durationMs: true, sessionId: true, timestamp: true },
      orderBy: { timestamp: 'asc' },
    })

    // 2) Group per (toolName, agentRole)
    const groups = new Map<string, Array<{ toolName: string; agentRole: string; durationMs: number; sessionId: string; timestamp: Date }>>()
    for (const r of rows) {
      const key = `${r.toolName}\u0000${r.agentRole}` // FB-P1-R1-03: NUL separator chống collision (space cũ: tool "a b"+role "c" trùng khoá tool "a"+role "b c")
      const list = groups.get(key)
      if (list) list.push(r)
      else groups.set(key, [r])
    }

    // 3) Tập khoá trùng của các anomaly ĐÃ có trong 24h qua
    const existing = await db.metricAnomaly.findMany({
      where: { observedAt: { gte: sinceRecent } },
      select: { kind: true, toolName: true, agentRole: true, value: true, observedAt: true },
    })
    const seen = new Set<string>(
      existing.map((e) => dedupeKey(e.kind, e.toolName, e.agentRole, e.value, e.observedAt)),
    )

    // 4) Quét từng nhóm
    const byTool = new Map<string, { toolName: string; n: number; anomalies: number }>()
    const toCreate: Array<{
      kind: string
      toolName: string
      agentRole: string
      value: number
      bound: number
      score: number
      sessionId: string | null
      observedAt: Date
    }> = []

    for (const group of groups.values()) {
      const { toolName, agentRole } = group[0]
      const toolAgg = byTool.get(toolName) ?? { toolName, n: 0, anomalies: 0 }
      toolAgg.n += group.length
      byTool.set(toolName, toolAgg)

      // Nhóm nhỏ bỏ qua — n < ngưỡng thì quantile chỉ là nhiễu (LLN/CLT).
      // NEURAL-ARCH: ngưỡng đọc runtime (anomaly_min_group_size).
      if (group.length < getTuningNumber('anomaly_min_group_size')) continue

      const durations = group.map((r) => r.durationMs)
      // NEURAL-ARCH: k đọc runtime (anomaly_iqr_k) — rìa Tukey co giãn theo tuning.
      const { low, high, q1, q3 } = iqrBounds(durations, getTuningNumber('anomaly_iqr_k'))
      if (!Number.isFinite(high) || !Number.isFinite(q3)) continue // defensive — không xảy ra với n≥20

      const iqr = q3 - q1
      for (const r of group) {
        if (r.durationMs > high && r.timestamp >= sinceRecent) {
          const key = dedupeKey(ANOMALY_KIND_DURATION, toolName, agentRole, r.durationMs, r.timestamp)
          if (seen.has(key)) continue
          seen.add(key)
          // iqr = 0 (cả nhóm cùng duration) → score = phần vượt tuyệt đối
          const score = iqr > 0 ? (r.durationMs - q3) / iqr : r.durationMs - q3
          toCreate.push({
            kind: ANOMALY_KIND_DURATION,
            toolName,
            agentRole,
            value: r.durationMs,
            bound: high,
            score,
            sessionId: r.sessionId,
            observedAt: r.timestamp,
          })
          toolAgg.anomalies++
        }
      }
    }

    // 5) Ghi các anomaly mới (từng row riêng — MetricAnomaly không có bulk
    //    unique; khử trùng đã ở bước 4 qua tập `seen`)
    for (const a of toCreate) {
      try {
        await db.metricAnomaly.create({ data: a })
      } catch (err) {
        console.warn('[AnomalyDetector] create failed (fail-open):', err instanceof Error ? err.message : String(err))
      }
    }

    return {
      scanned: rows.length,
      anomalies: toCreate.length,
      byTool: Array.from(byTool.values()).sort((a, b) => b.anomalies - a.anomalies || b.n - a.n),
      pruned,
    }
  } catch (err) {
    console.warn('[AnomalyDetector] scanToolMetricAnomalies failed (fail-open):', err instanceof Error ? err.message : String(err))
    return {
      scanned: 0,
      anomalies: 0,
      byTool: [],
      pruned: 0,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}
