/**
 * P1-M3 · Anomaly scan endpoint — kích hoạt IQR anomaly detector thủ công.
 *
 * POST /api/metrics/anomalies/scan — body tuỳ chọn { lookbackDays?: number
 * (default 7, kẹp [1,30]) }. Chạy scanToolMetricAnomalies (fail-open toàn
 * phần — KHÔNG bao giờ 500 vì lỗi scan) và trả:
 *   scan    — { scanned, anomalies, byTool, pruned, error? }
 *   recent  — 100 anomaly mới nhất trong 24h qua (kind/toolName/agentRole/
 *             value/bound/score/observedAt) — cho verification `bound < value`
 *             và cho UI quan sát.
 *
 * Nguồn: BLUEPRINT-STATS-LEARNING-P0-P6.md §P1-M3 hook ① (API thủ công).
 * Hook ②: /api/metrics/overview?scan=1 (cache 10 phút TmoCache).
 * KHÔNG thêm cron mới ở bước này (blueprint nguyên tắc — P1 chỉ đo baseline).
 */

import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { scanToolMetricAnomalies } from '@/lib/learning/anomaly-detector'

export const dynamic = 'force-dynamic'

const MAX_RECENT = 100

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as { lookbackDays?: unknown }
    const raw = typeof body.lookbackDays === 'number' ? body.lookbackDays : parseInt(String(body.lookbackDays ?? '7'), 10)
    const lookbackDays = Math.max(1, Math.min(30, Number.isFinite(raw) ? raw : 7))

    const scan = await scanToolMetricAnomalies(lookbackDays)

    // Danh sách gần đây để kiểm chứng trực quan (fail-open — lỗi đọc chỉ ảnh
    // hưởng trường recent, không ảnh hưởng kết quả scan)
    let recent: Array<Record<string, unknown>> = []
    try {
      const rows = await db.metricAnomaly.findMany({
        where: { observedAt: { gte: new Date(Date.now() - 24 * 3600 * 1000) } },
        orderBy: { observedAt: 'desc' },
        take: MAX_RECENT,
        select: {
          kind: true,
          toolName: true,
          agentRole: true,
          value: true,
          bound: true,
          score: true,
          sessionId: true,
          observedAt: true,
        },
      })
      recent = rows
    } catch (err) {
      console.warn('[Anomalies/Scan] recent list failed (fail-open):', err instanceof Error ? err.message : String(err))
    }

    return NextResponse.json({
      scan,
      recent,
      generatedAt: new Date().toISOString(),
    })
  } catch (err) {
    // Chỉ tới đây khi có lỗi ngoài scan (VD parse JSON tay) — scan tự fail-open
    console.error('[Anomalies/Scan] POST failed:', err instanceof Error ? err.message : String(err))
    return NextResponse.json({ error: 'Failed to scan anomalies' }, { status: 500 })
  }
}
