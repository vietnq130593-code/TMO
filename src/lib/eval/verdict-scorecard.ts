/**
 * P1-M1 · VERDICT SCORECARD — confusion matrix + P/R/F1/Specificity/AUC-PR/
 * Brier/ECE cho phán quyết của TRỌNG TÀI ĐỘC LẬP.
 *
 * Nguồn: BLUEPRINT-STATS-LEARNING-P0-P6.md §P1-M1 (mục #1 — ML.pdf
 * §Classification Metrics + §Evaluation Curves). Đo trực diện độ tin cậy của
 * lời tuyên bố "complete" — chỉ tiêu đánh bẹp lớp bug "model tự nhận hoàn
 * thành" (GHI-NHẬN-d):
 *   predicted = verdict.complete   (verdict HIỆU LỰC sau verify-guard)
 *   actual    = verdict.runComplete (kết quả run do resolveArbiterVerdicts ghi)
 *   TP = tuyên bố xong & thật sự xong; FP = tuyên bố xong nhưng run KHÔNG
 *   complete (nguy hiểm nhất); FN = báo chưa xong nhưng run complete (mất cơ
 *   hội chốt sớm); TN = đúng báo chưa xong.
 *
 * AUC-PR (step-wise, stats/classification) trên cặp (confidence, runComplete)
 * — dữ liệu lệch lớp (complete hiếm) nên AUC-PR đúng hơn AUC-ROC (ML.pdf §3).
 * Brier/ECE TÁI DÙNG từ calibration-metrics (không viết lại — 2 thư viện độc
 * lập theo ghi chú barrel src/lib/stats).
 *
 * Phân tầng: tổng + theo agentName + nhóm forcedDowngrade (đo riêng verdict
 * bị verify-guard hạ cấp — fpWithoutGuard = số verdict nếu KHÔNG có guard sẽ
 * là FP: verdict bị hạ mà run KHÔNG complete).
 *
 * Fail-open TOÀN PHẦN (blueprint nguyên tắc 3): mọi lỗi DB → zero-state
 * { n: 0, note } — KHÔNG throw (route trả 200 với "chờ dữ liệu", không lỗi).
 * Read-only — không ghi gì vào DB.
 */

import { confusionMatrix, prf1, sweepThresholds, aucPr } from '@/lib/stats'
import { brierScore, ece } from '@/lib/calibration-metrics'
import { findResolvedVerdictsForScorecard } from '@/lib/metrics-db'

export interface VerdictScorecard {
  /** Số verdict resolved dùng được (runComplete ≠ null) trong cửa sổ */
  n: number
  tp: number
  fp: number
  fn: number
  tn: number
  precision: number
  recall: number
  f1: number
  specificity: number
  /** AUC-PR theo confidence — null khi không có positive thật nào (không định nghĩa) */
  aucPr: number | null
  brier: number
  ece: number | null
  byAgent: Array<{ agentName: string; n: number; precision: number; f1: number }>
  /** Nhóm verdict bị verify-guard hạ cấp complete true→false */
  forcedDowngrade: { n: number; fpWithoutGuard: number }
  /** Ghi chú zero-state / dữ liệu bị loại — undefined khi có dữ liệu lành */
  note?: string
}

/** Làm tròn 4 chữ số thập phân (cùng chuẩn /api/eval/calibration). */
function round4(x: number): number {
  return Math.round(x * 10000) / 10000
}

function zeroState(windowDays: number, note: string): VerdictScorecard {
  return {
    n: 0,
    tp: 0,
    fp: 0,
    fn: 0,
    tn: 0,
    precision: 0,
    recall: 0,
    f1: 0,
    specificity: 0,
    aucPr: null,
    brier: 0,
    ece: null,
    byAgent: [],
    forcedDowngrade: { n: 0, fpWithoutGuard: 0 },
    note,
  }
}

/**
 * Tính scorecard trên các ArbiterVerdict ĐÃ resolve trong `windowDays` gần
 * nhất (mặc định 30, kẹp [1, 365], cap 5000 rows).
 * KHÔNG bao giờ throw — lỗi DB → zero-state + note.
 */
export async function computeVerdictScorecard(windowDays = 30): Promise<VerdictScorecard> {
  const days = Math.max(1, Math.min(windowDays, 365))
  try {
    const rows = await findResolvedVerdictsForScorecard(days)
    // Ground-truth cần runComplete ≠ null. resolveArbiterVerdicts luôn ghi đủ
    // 2 cột khi resolve, nhưng dữ liệu cũ/lệch có thể thiếu → loại + ghi chú.
    const usable = rows.filter(r => r.runComplete !== null)
    if (usable.length === 0) {
      const note =
        rows.length > 0
          ? `chờ dữ liệu — ${rows.length} verdict resolved trong ${days} ngày nhưng thiếu runComplete (bị loại)`
          : `chờ dữ liệu — chưa có verdict resolved nào trong ${days} ngày gần nhất`
      return zeroState(days, note)
    }

    const predicted = usable.map(v => v.complete)
    const actual = usable.map(v => v.runComplete === true)
    const cm = confusionMatrix(predicted, actual)
    const { precision, recall, f1, specificity } = prf1(cm)

    // AUC-PR trên (confidence, runComplete). Không có positive thật (tp+fn=0)
    // → precision vô nghĩa ở mọi ngưỡng → null (không định nghĩa, KHÔNG 0).
    const positives = cm.tp + cm.fn
    const aucPrValue =
      positives > 0 ? round4(aucPr(sweepThresholds(usable.map(v => v.confidence), actual))) : null

    // Brier/ECE tái dùng calibration-metrics (outcome 0/1 từ actual).
    const scores = usable.map(v => v.confidence)
    const outcomes = actual.map(a => (a ? 1 : 0))
    const eceResult = ece(scores, outcomes)

    // Phân tầng theo agentName (null → 'unknown'), sort n giảm dần.
    const groups = new Map<string, typeof usable>()
    for (const v of usable) {
      const key = v.agentName ?? 'unknown'
      const list = groups.get(key)
      if (list) list.push(v)
      else groups.set(key, [v])
    }
    const byAgent = Array.from(groups.entries())
      .map(([agentName, list]) => {
        const g = prf1(
          confusionMatrix(
            list.map(v => v.complete),
            list.map(v => v.runComplete === true),
          ),
        )
        return { agentName, n: list.length, precision: round4(g.precision), f1: round4(g.f1) }
      })
      .sort((a, b) => b.n - a.n || a.agentName.localeCompare(b.agentName))

    // Nhóm bị verify-guard hạ cấp: verdict đó KHỞI ĐẦU là complete=true — nếu
    // không có guard thì predicted=true → FP khi run KHÔNG complete.
    const downgraded = usable.filter(v => v.forcedDowngrade)
    const fpWithoutGuard = downgraded.filter(v => v.runComplete === false).length

    return {
      n: usable.length,
      tp: cm.tp,
      fp: cm.fp,
      fn: cm.fn,
      tn: cm.tn,
      precision: round4(precision),
      recall: round4(recall),
      f1: round4(f1),
      specificity: round4(specificity),
      aucPr: aucPrValue,
      brier: round4(brierScore(scores, outcomes)),
      ece: eceResult ? eceResult.ece : null,
      byAgent,
      forcedDowngrade: { n: downgraded.length, fpWithoutGuard },
    }
  } catch (err) {
    console.warn(
      '[VerdictScorecard] computeVerdictScorecard failed (fail-open):',
      err instanceof Error ? err.message : String(err),
    )
    return zeroState(days, `lỗi đọc dữ liệu — ${err instanceof Error ? err.message : String(err)}`)
  }
}
