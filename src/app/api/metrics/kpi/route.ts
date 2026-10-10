/**
 * P1-M4 · KPI endpoint — lớp chỉ số có tên/mục tiêu/trạng thái.
 *
 * GET /api/metrics/kpi — tính toàn bộ KPI hôm nay (computeAllKpis — upsert
 * snapshot idempotent theo unique date+kpi, mỗi KPI fail-open độc lập) +
 * lịch sử 7 ngày gần nhất từ KpiSnapshot + status so target (on_target |
 * near | off | no_target — dải ±10%).
 *
 * Response:
 *   today    — KpiComputed[] (key/label/goal/target/value/sampleSize/status/meta/ok)
 *   history  — [{ kpi, points: [{ date, value, sampleSize }] }] (7 ngày, asc)
 *
 * Ghi chú vận hành: GET có upsert snapshot (idempotent — an toàn gọi lặp).
 * Muốn thêm KPI → sửa KPI_REGISTRY (single source) — route tự theo.
 */

import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { computeAllKpis, todayUtcDate } from '@/lib/kpi/compute'

export const dynamic = 'force-dynamic'

const HISTORY_DAYS = 7

export async function GET() {
  // today — compute + upsert (fail-open per KPI, không throw)
  const today = await computeAllKpis()

  // history — 7 ngày gần nhất từ snapshot (fail-open zero-state)
  let history: Array<{ kpi: string; points: Array<{ date: string; value: number; sampleSize: number }> }> = []
  try {
    const sinceDate = new Date(Date.now() - (HISTORY_DAYS - 1) * 24 * 3600 * 1000)
      .toISOString()
      .slice(0, 10)
    const rows = await db.kpiSnapshot.findMany({
      where: { date: { gte: sinceDate } },
      orderBy: { date: 'asc' },
      select: { kpi: true, date: true, value: true, sampleSize: true },
    })
    const byKpi = new Map<string, Array<{ date: string; value: number; sampleSize: number }>>()
    for (const r of rows) {
      const points = byKpi.get(r.kpi) ?? []
      points.push({ date: r.date, value: r.value, sampleSize: r.sampleSize })
      byKpi.set(r.kpi, points)
    }
    history = Array.from(byKpi.entries()).map(([kpi, points]) => ({ kpi, points }))
  } catch (err) {
    console.warn('[KPI] history read failed (fail-open):', err instanceof Error ? err.message : String(err))
    history = []
  }

  return NextResponse.json({
    date: todayUtcDate(),
    today,
    history,
    generatedAt: new Date().toISOString(),
  })
}
