/**
 * P1-M1 · Verdict Scorecard endpoint.
 *
 * GET /api/eval/verdict-scorecard?windowDays=30 — confusion matrix + P/R/F1/
 * Specificity/AUC-PR/Brier/ECE của phán quyết "complete" của trọng tài độc
 * lập, phân tầng theo agent + nhóm forcedDowngrade (verify-guard).
 *
 * Read-only hoàn toàn — KHÔNG thể hỏng runtime (blueprint §P1-M1 rủi ro:
 * "read-only — rollback = xoá 2 file"). Fail-open: computeVerdictScorecard
 * không bao giờ throw; DB ít/không có verdict resolved → 200 với n=0 +
 * note "chờ dữ liệu" (KHÔNG lỗi).
 *
 * Query: windowDays — default 30, kẹp [1, 365].
 */

import { NextRequest, NextResponse } from 'next/server'
import { computeVerdictScorecard } from '@/lib/eval/verdict-scorecard'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const raw = parseInt(searchParams.get('windowDays') || '', 10)
  const windowDays = Number.isFinite(raw) && raw > 0 ? Math.min(raw, 365) : 30

  const scorecard = await computeVerdictScorecard(windowDays)
  return NextResponse.json({
    scorecard,
    generatedAt: new Date().toISOString(),
  })
}
