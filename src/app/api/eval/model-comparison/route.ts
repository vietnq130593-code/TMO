/**
 * P4-M2 · Model comparison endpoint.
 *
 * GET /api/eval/model-comparison?windowDays=90
 *
 * Bảng so sánh model trên AgentRunRecord (cột model — P4-M2): per-model
 * (n, status breakdown, success-rate + Wilson CI 95%) + ANOVA one-way trên
 * cycles/tokens khi ≥3 model đủ n≥10 (BLUEPRINT-STATS-LEARNING §P4-M2,
 * mục #8b — MATH.pdf §ANOVA). Read-only, fail-open: DB ít/không dữ liệu →
 * 200 với n=0 + note "chờ dữ liệu" (KHÔNG lỗi — precedent scorecard/sweep).
 *
 * Query:
 *   windowDays — mặc định 90, kẹp [1, 365]
 */

import { NextRequest, NextResponse } from 'next/server'
import { fetchModelComparison } from '@/lib/eval/model-comparison'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const raw = parseInt(searchParams.get('windowDays') || '', 10)
  const windowDays = Number.isFinite(raw) && raw > 0 ? Math.min(raw, 365) : 90

  const report = await fetchModelComparison(windowDays)

  return NextResponse.json({
    report,
    generatedAt: new Date().toISOString(),
  })
}
