/**
 * Task 20-c — Calibration metrics (toán thuần, KHÔNG side-effect).
 *
 * Đo lường chất lượng calibration của một bộ điểm số xác suất:
 *   - Brier score: mean((p - y)^2) — 0 hoàn hảo, 0.25 = random guess 50/50,
 *     < 0.25 tốt hơn đoán ngẫu nhiên, > 0.25 tệ hơn đoán mò.
 *   - ECE (Expected Calibration Error): trung bình có trọng số |avgScore -
 *     baseRate| trên `bins` bucket [0,1] — 0 hoàn hảo; kèm bảng reliability
 *     (bins) để vẽ reliability diagram.
 *
 * Input: scores ∈ [0,1] (xác suất dự đoán) + outcomes ∈ {0,1} (kết quả thật).
 * Empty input → brierScore = 0, ece = null (an toàn cho zero-state API).
 * Pairs không hợp lệ (NaN/Infinity/sai độ dài) bị lọc bỏ trước khi tính.
 */

export interface CalibrationBin {
  /** Cận dưới của bucket (inclusive) — 0, 0.1, 0.2... */
  binStart: number
  /** Cận trên của bucket (exclusive, bucket cuối inclusive) */
  binEnd: number
  /** Số điểm rơi vào bucket */
  n: number
  /** Trung bình score của bucket (null khi bucket rỗng) */
  avgScore: number | null
  /** Tỷ lệ outcome=1 của bucket (null khi bucket rỗng) */
  baseRate: number | null
}

export interface EceResult {
  /** Expected Calibration Error ∈ [0,1] — 0 hoàn hảo */
  ece: number
  /** Bảng reliability theo bucket */
  bins: CalibrationBin[]
}

/** Lọc cặp (score, outcome) hợp lệ: score số hữu hạn, outcome 0/1 */
function validPairs(scores: number[], outcomes: number[]): Array<{ score: number; outcome: number }> {
  const pairs: Array<{ score: number; outcome: number }> = []
  const n = Math.min(scores.length, outcomes.length)
  for (let i = 0; i < n; i++) {
    const s = scores[i]
    const o = outcomes[i]
    if (typeof s === 'number' && Number.isFinite(s) && typeof o === 'number' && (o === 0 || o === 1)) {
      pairs.push({ score: Math.min(1, Math.max(0, s)), outcome: o })
    }
  }
  return pairs
}

/**
 * Brier score = mean((p - y)^2). Empty/invalid input → 0 (zero-state an toàn).
 */
export function brierScore(scores: number[], outcomes: number[]): number {
  const pairs = validPairs(scores, outcomes)
  if (pairs.length === 0) return 0
  let sum = 0
  for (const p of pairs) {
    const d = p.score - p.outcome
    sum += d * d
  }
  return sum / pairs.length
}

/**
 * Expected Calibration Error + bảng reliability bins.
 * Empty/invalid input → null (caller hiển thị zero-state).
 * Bucket i = [i/bins, (i+1)/bins) — bucket cuối = [(bins-1)/bins, 1] inclusive.
 */
export function ece(scores: number[], outcomes: number[], bins = 10): EceResult | null {
  if (!Number.isFinite(bins) || bins < 1) return null
  const pairCount = Math.floor(bins)
  const pairs = validPairs(scores, outcomes)
  if (pairs.length === 0) return null

  const total = pairs.length
  const bucketScoreSums = new Array<number>(pairCount).fill(0)
  const bucketOutcomeSums = new Array<number>(pairCount).fill(0)
  const bucketCounts = new Array<number>(pairCount).fill(0)

  for (const p of pairs) {
    // score=1 phải rơi bucket cuối (inclusive); các score < 1: floor bình thường
    const idx = p.score >= 1 ? pairCount - 1 : Math.min(pairCount - 1, Math.floor(p.score * pairCount))
    bucketScoreSums[idx] += p.score
    bucketOutcomeSums[idx] += p.outcome
    bucketCounts[idx]++
  }

  let eceSum = 0
  const outBins: CalibrationBin[] = []
  for (let i = 0; i < pairCount; i++) {
    const n = bucketCounts[i]
    const avgScore = n > 0 ? bucketScoreSums[i] / n : null
    const baseRate = n > 0 ? bucketOutcomeSums[i] / n : null
    if (n > 0 && avgScore !== null && baseRate !== null) {
      eceSum += (n / total) * Math.abs(avgScore - baseRate)
    }
    outBins.push({
      binStart: i / pairCount,
      binEnd: (i + 1) / pairCount,
      n,
      avgScore: avgScore === null ? null : Math.round(avgScore * 10000) / 10000,
      baseRate: baseRate === null ? null : Math.round(baseRate * 10000) / 10000,
    })
  }

  return { ece: Math.round(eceSum * 10000) / 10000, bins: outBins }
}
