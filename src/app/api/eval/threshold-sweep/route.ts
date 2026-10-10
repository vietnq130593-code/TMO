/**
 * P2-M1 · Threshold Sweep endpoint.
 *
 * GET /api/eval/threshold-sweep?target=evaluator_confidence|kb_confidence&windowDays=60
 *
 * Quét ngưỡng ROC/PR trên dữ liệu thật → bảng (threshold, precision, recall,
 * F1, TPR/FPR) + AUC + 3 khuyến nghị (max_f1 / precision ≥ 0.9 / recall ≥ 0.9)
 * + mốc cố định 0.05..0.95. Bảng này nộp USER DUYỆT trước khi đổi bất kỳ hằng
 * số nào (blueprint §P2-M1: "KHÔNG tự đổi hằng số" — rủi ro gần 0, read-only).
 *
 * Fail-open: sweep functions không bao giờ throw; DB ít/không có dữ liệu →
 * 200 với n=0 + note "chờ dữ liệu" (KHÔNG lỗi — cùng pattern verdict-scorecard).
 *
 * Query:
 *   target     — evaluator_confidence (mặc định) | kb_confidence
 *   windowDays — chỉ dùng cho evaluator (mặc định 60, kẹp [1, 365])
 */

import { NextRequest, NextResponse } from 'next/server'
import { sweepEvaluatorThresholds, sweepKbConfidence, type SweepTarget } from '@/lib/eval/threshold-sweep'

export const dynamic = 'force-dynamic'

const TARGETS: SweepTarget[] = ['evaluator_confidence', 'kb_confidence']

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const targetParam = searchParams.get('target') || 'evaluator_confidence'
  if (!TARGETS.includes(targetParam as SweepTarget)) {
    return NextResponse.json(
      { error: `target không hợp lệ '${targetParam}' — nhận một trong: ${TARGETS.join(', ')}` },
      { status: 400 },
    )
  }
  const target = targetParam as SweepTarget

  const raw = parseInt(searchParams.get('windowDays') || '', 10)
  const windowDays = Number.isFinite(raw) && raw > 0 ? Math.min(raw, 365) : 60

  const report =
    target === 'kb_confidence'
      ? await sweepKbConfidence()
      : await sweepEvaluatorThresholds(windowDays)

  return NextResponse.json({
    report,
    generatedAt: new Date().toISOString(),
  })
}
