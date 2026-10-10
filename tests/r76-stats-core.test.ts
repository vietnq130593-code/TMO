/**
 * ROUND-76 TESTS — P0-1 THƯ VIỆN THỐNG KÊ NỀN (BLUEPRINT-STATS-LEARNING-P0-P6)
 *
 * Bối cảnh: blueprint P0-1 (đợt triển khai 1) tạo src/lib/stats/ — 7 module
 * thuần toán (descriptive · classification · ranking · text · cluster-quality
 * · inference + barrel index) làm nền cho 21 hạng mục P1-P6 (scorecard, nDCG/
 * MRR, IQR anomaly, KPI, silhouette Leiden, threshold sweep, Wilson CI,
 * logistic V2, 3-judge, ROUGE-L gate, Welch-t/χ², ANOVA, Matryoshka, dedup,
 * Naive Bayes, Q-table, softmax). Đợt FB-P0 (giao thức fixbug.md) bổ sung
 * 7 test regression cho fix vòng R1: aucRoc neo gốc (0,0) — tie đỉnh không
 * mất diện tích; zScore σ âm; iqrBounds k âm; meanCI z âm; wilsonCI p ngoài
 * [0,1] (kể cả vi phạm bé lọt sqrt); chiSquare2x2 ô âm; mannWhitneyU NaN.
 *
 * Nguyên tắc test:
 * - MỖI hàm >= 2 case, mọi expected value DẪN NGUỒN ĐƯỢC (comment công thức
 *   với các giá trị không hiển nhiên) — đối chiếu độc lập bởi orchestrator.
 * - 3 erratum blueprint đã tính lại theo CÔNG THỨC (không theo số ví dụ sai):
 *   BUG2-035 wilsonCI(0.8,25) z=1.96 -> [0.6087, 0.9114] (ví dụ [0.616,0.910]
 *   ứng z~=1.9); BUG2-036 rougeL("the cat sat","the cat") precision=1.0 (ví dụ
 *   ghi "recall 1.0"); BUG2-037 silhouetteFromGraph đảo dấu (a-b) cho trọng số
 *   tương tự (chi tiết JSDoc cluster-quality.ts).
 * - THUẦN TOÁN — không DB, không LLM, không side-effect (đúng nguyên tắc 6:
 *   test Stats chạy trong DB-test-cô-lập của gate như mọi test khác).
 * - Import smoke: barrel `@/lib/stats` + import trực tiếp 2 module con
 *   (`@/lib/stats/descriptive`, `@/lib/stats/inference`) — tiêu chí "import
 *   từ 2 module khác nhau chạy được" của blueprint P0-1.
 */

import { describe, test, expect } from 'bun:test'

// Import smoke — barrel (đường P1+ sẽ dùng)
import {
  mean, median, quantile, iqrBounds, stddev, zScore,
  confusionMatrix, prf1, logLoss, sweepThresholds, aucRoc, aucPr,
  ndcgAtK, mrr, hitAtK, averagePrecision,
  rougeL, tokenSetF1,
  silhouetteScore, silhouetteFromGraph, daviesBouldin, calinskiHarabasz,
  wilsonCI, meanCI, welchTTest, mannWhitneyU, chiSquare2x2, fisherExact2x2, anovaF, normalCdf,
} from '@/lib/stats'
// Import smoke — 2 module trực tiếp
import { iqrBounds as iqrBoundsDirect } from '@/lib/stats/descriptive'
import { wilsonCI as wilsonCIDirect } from '@/lib/stats/inference'
// Loại được dùng qua type
import type { ConfusionMatrix } from '@/lib/stats/classification'

/** So sánh khoảng tuyệt đối tường minh (tol do caller chỉ định theo nguồn số). */
function expectClose(actual: number, expected: number, tol: number, label = ''): void {
  expect(Math.abs(actual - expected), `${label} | actual=${actual} expected=${expected}`).toBeLessThan(tol)
}

function expectNaN(actual: number, label = ''): void {
  expect(Number.isNaN(actual), `${label} | actual=${actual} phải là NaN`).toBe(true)
}

// ---------------------------------------------------------------------------
// descriptive
// ---------------------------------------------------------------------------

describe('r76 · stats/descriptive', () => {
  test('mean: cơ bản + rỗng', () => {
    expectClose(mean([1, 2, 3, 4, 5]), 3, 1e-12)
    expectNaN(mean([]))
  })

  test('median: lẻ + chẵn', () => {
    expectClose(median([1, 3, 2]), 2, 1e-12)
    expectClose(median([1, 2, 3, 4]), 2.5, 1e-12) // (2+3)/2
  })

  test('quantile: type-7 nội suy tuyến tính + biên', () => {
    // [1..10] sorted; h = (n-1)*q = 9*0.25 = 2.25 -> x[2] + 0.25*(x[3]-x[2]) = 3 + 0.25
    expectClose(quantile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.25), 3.25, 1e-12)
    expectClose(quantile([10, 9, 8, 7, 6, 5, 4, 3, 2, 1], 0.75), 7.75, 1e-12) // không mutate, tự sort
    expectClose(quantile([1, 2, 3, 4], 0.5), 2.5, 1e-12) // h = 1.5 -> 2 + 0.5
    expectClose(quantile([3, 1, 2], 0), 1, 1e-12)
    expectClose(quantile([3, 1, 2], 1), 3, 1e-12) // clamp chỉ số trên
    expectNaN(quantile([], 0.5))
    expectNaN(quantile([1, 2, 3], 1.5))
  })

  test('iqrBounds: Tukey fence k=1.5 + rỗng', () => {
    // [1..10]: q1=3.25, q3=7.75, iqr=4.5 -> low = 3.25-6.75 = -3.5, high = 7.75+6.75 = 14.5
    const b = iqrBounds([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    expectClose(b.q1, 3.25, 1e-12)
    expectClose(b.q3, 7.75, 1e-12)
    expectClose(b.low, -3.5, 1e-12)
    expectClose(b.high, 14.5, 1e-12)
    expectClose(b.low, iqrBoundsDirect([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]).low, 1e-12) // import trực tiếp
    // k=1: [1,2,3,4] -> q1=1.75, q3=3.25, iqr=1.5 -> low=1.75-1.5=0.25, high=3.25+1.5=4.75
    const b2 = iqrBounds([1, 2, 3, 4], 1)
    expectClose(b2.low, 0.25, 1e-12)
    expectClose(b2.high, 4.75, 1e-12)
    const b3 = iqrBounds([])
    expectNaN(b3.low)
    expectNaN(b3.high)
  })

  test('iqrBounds: k âm/NaN -> NaN cả 4 trường, không đảo chiều fence (FB-P0-R1-04)', () => {
    const bad = iqrBounds([1, 2, 3, 4], -1)
    expectNaN(bad.low)
    expectNaN(bad.high)
    expectNaN(bad.q1)
    expectNaN(bad.q3)
    const nanK = iqrBounds([1, 2, 3, 4], Number.NaN)
    expectNaN(nanK.low)
    expectNaN(nanK.q1)
  })

  test('stddev: mẫu n-1 + hằng + n<2', () => {
    expectClose(stddev([1, 2, 3, 4, 5]), Math.sqrt(2.5), 1e-12) // ss=10, /4
    expectClose(stddev([5, 5, 5]), 0, 1e-12)
    expectNaN(stddev([1]))
    expectNaN(stddev([]))
  })

  test('zScore: cơ bản + sigma=0/âm/NaN defensive (FB-P0-R1-03)', () => {
    expectClose(zScore(2, 0, 1), 2, 1e-12)
    expectClose(zScore(0, 0, 1), 0, 1e-12)
    expectClose(zScore(7.75, 7.75, 0), 0, 1e-12) // sigma=0 -> 0 (JSDoc)
    expect(zScore(1, 0, -2)).toBe(0) // sigma âm không đảo dấu
    expect(zScore(1, 0, Number.NaN)).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// classification
// ---------------------------------------------------------------------------

describe('r76 · stats/classification', () => {
  test('confusionMatrix: gộp đúng + length mismatch throw', () => {
    // predicted true tại 1-10; actual true tại 1-8 + vị trí 11
    // -> tp=8 (1-8), fp=2 (9-10), fn=1 (11), tn=9 (12-20)
    const m = confusionMatrix(
      [true, true, true, true, true, true, true, true, true, true, false, false, false, false, false, false, false, false, false, false],
      [true, true, true, true, true, true, true, true, false, false, true, false, false, false, false, false, false, false, false, false],
    )
    expect(m.tp).toBe(8)
    expect(m.fp).toBe(2)
    expect(m.fn).toBe(1)
    expect(m.tn).toBe(9)
    expect(() => confusionMatrix([true], [true, false])).toThrow()
  })

  test('prf1: ma trận {8,2,1,9} (ví dụ blueprint, đã đối chiếu)', () => {
    const m: ConfusionMatrix = { tp: 8, fp: 2, fn: 1, tn: 9 }
    const r = prf1(m)
    expectClose(r.precision, 0.8, 1e-12)            // 8/10
    expectClose(r.recall, 0.8888888889, 1e-9)       // 8/9
    expectClose(r.f1, 0.8421052632, 1e-9)           // 2*0.8*0.8889/(0.8+0.8889)
    expectClose(r.specificity, 0.8181818182, 1e-9)  // 9/11
    expectClose(r.balancedAccuracy, 0.8535353535, 1e-9)
  })

  test('prf1: ma trận 0 toàn phần không sinh NaN/Infinity', () => {
    const r = prf1({ tp: 0, fp: 0, fn: 0, tn: 5 })
    expect(r.precision).toBe(0)
    expect(r.recall).toBe(0)
    expect(r.f1).toBe(0)
    expect(r.specificity).toBe(1)
  })

  test('logLoss: đối chiếu tay + clamp hoàn hảo', () => {
    // -(ln0.9 + ln0.9)/2 = 0.1053605
    expectClose(logLoss([0.9, 0.1], [1, 0]), 0.1053605157, 1e-9)
    expectClose(logLoss([0.5], [1]), 0.6931471806, 1e-9) // -ln(0.5)
    // dự đoán hoàn hảo bị kẹp 1e-9 -> loss ~ 1e-9 (không Infinity)
    expect(logLoss([1, 0], [1, 0])).toBeLessThan(1e-8)
    expectNaN(logLoss([], []))
  })

  test('sweepThresholds: 4 điểm quét + throw + rỗng', () => {
    const pts = sweepThresholds([0.9, 0.8, 0.7, 0.3], [true, true, false, true])
    expect(pts.length).toBe(4)
    expectClose(pts[0].threshold, 0.9, 1e-12)
    expectClose(pts[0].tpr, 1 / 3, 1e-12)
    expectClose(pts[0].fpr, 0, 1e-12)
    expectClose(pts[0].precision, 1, 1e-12)
    expectClose(pts[1].tpr, 2 / 3, 1e-12)
    expectClose(pts[1].precision, 1, 1e-12)
    expectClose(pts[2].tpr, 2 / 3, 1e-12)
    expectClose(pts[2].fpr, 1, 1e-12)
    expectClose(pts[2].precision, 2 / 3, 1e-12)
    expectClose(pts[3].tpr, 1, 1e-12)
    expectClose(pts[3].precision, 0.75, 1e-12)
    expect(() => sweepThresholds([0.5], [])).toThrow()
    expect(sweepThresholds([], []).length).toBe(0)
  })

  test('aucRoc: trapz = 2/3 trên bộ 4 điểm ở trên', () => {
    const pts = sweepThresholds([0.9, 0.8, 0.7, 0.3], [true, true, false, true])
    // đoạn fpr 0->1 co giãn tpr 2/3 -> 2/3; 2 đoạn dọc fpr=0/fpr=1 diện tích 0
    expectClose(aucRoc(pts), 2 / 3, 1e-12)
    expect(aucRoc([])).toBe(0)
  })

  test('aucRoc neo gốc (0,0) — tie ở đỉnh không mất diện tích tam giác (FB-P0-R1-01, đối chứng định nghĩa P(T>F)+½P(T=F))', () => {
    // tie đỉnh T/F: cặp (T=0.9, F=0.9) + (T? không) — cặp duy nhất T-F là tie
    // -> AUC = 0.5 + 0.5·(cặp còn lại T=0.9 > F=0.2)/... = (0.5 + 1)/2 = 0.75
    expectClose(aucRoc(sweepThresholds([0.9, 0.9, 0.2], [true, false, false])), 0.75, 1e-12)
    // toàn tie 1 ngưỡng: mọi cặp T-F đều tie -> 0.5
    expectClose(aucRoc(sweepThresholds([0.5, 0.5], [true, false])), 0.5, 1e-12)
    // toàn tie 4 phần tử (2T 2F): 4/4 cặp tie -> 0.5
    expectClose(aucRoc(sweepThresholds([0.5, 0.5, 0.5, 0.5], [true, true, false, false])), 0.5, 1e-12)
    // nhiều tầng tie: 3 T × 2 F = 6 cặp: (0.9T,0.9F)=tie 0.5; (0.9T,0.5F)=1;
    // (0.5T,0.9F)=0; (0.5T,0.5F)=tie 0.5; (0.1T,0.9F)=0; (0.1T,0.5F)=0
    // -> AUC = 2/6 = 1/3 (kì vọng đầu ghi 0.625 là tính thiếu cặp — gate bắt)
    expectClose(aucRoc(sweepThresholds([0.9, 0.9, 0.5, 0.5, 0.1], [true, false, true, false, true])), 1 / 3, 1e-12)
  })

  test('aucPr: step-wise = 11/12 (KHÔNG trapz)', () => {
    const pts = sweepThresholds([0.9, 0.8, 0.7, 0.3], [true, true, false, true])
    // 1*(1/3) + 1*(1/3) + (2/3)*0 + (3/4)*(1/3) = 11/12 = 0.91667
    expectClose(aucPr(pts), 11 / 12, 1e-12)
    expect(aucPr([])).toBe(0)
  })

  test('aucRoc phân tách hoàn hảo = 1', () => {
    const pts = sweepThresholds([0.9, 0.2], [true, false])
    expectClose(aucRoc(pts), 1, 1e-12)
  })
})

// ---------------------------------------------------------------------------
// ranking
// ---------------------------------------------------------------------------

describe('r76 · stats/ranking', () => {
  test('ndcgAtK: [1,0,1]@3 = 0.920 (ví dụ blueprint) + k cắt ngắn', () => {
    // DCG = 1/log2(2) + 0 + 1/log2(4) = 1.5; IDCG = 1 + 1/log2(3) = 1.6309297536
    // nDCG = 1.5/1.6309297536 = 0.9197207891 (blueprint làm tròn "0.920")
    expectClose(ndcgAtK([1, 0, 1], 3), 0.9197207891, 1e-9)
    // @2: DCG = 1/1 + 0 = 1; IDCG top-2 = 1 + 1/log2(3) -> 0.613147
    expectClose(ndcgAtK([1, 0, 1], 2), 0.6131471928, 1e-9)
    expect(ndcgAtK([], 5)).toBe(0)
    expect(ndcgAtK([1, 1], 0)).toBe(0)
    expect(ndcgAtK([0, 0], 3)).toBe(0) // IDCG = 0
  })

  test('mrr: hạng đầu tiên + không có relevant', () => {
    expectClose(mrr([0, 1, 0]), 0.5, 1e-12)
    expectClose(mrr([0, 0, 1]), 1 / 3, 1e-12)
    expect(mrr([1, 0])).toBe(1)
    expect(mrr([0, 0, 0])).toBe(0)
  })

  test('hitAtK: tồn tại relevant trong top-k', () => {
    expect(hitAtK([0, 1], 2)).toBe(true)
    expect(hitAtK([0, 0, 1], 2)).toBe(false)
    expect(hitAtK([1, 0], 1)).toBe(true)
    expect(hitAtK([1, 0], 0)).toBe(false)
  })

  test('averagePrecision: [1,0,1] + degenerate', () => {
    // P@1 = 1, P@3 = 2/3 -> (1 + 2/3)/2 = 0.83333
    expectClose(averagePrecision([1, 0, 1]), 0.8333333333, 1e-9)
    expectClose(averagePrecision([1, 1]), 1, 1e-12)
    expect(averagePrecision([0, 0, 0])).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// text
// ---------------------------------------------------------------------------

describe('r76 · stats/text', () => {
  test('rougeL: LCS = "the cat" (erratum BUG2-036: precision 1.0, KHÔNG phải recall)', () => {
    const r = rougeL('the cat sat', 'the cat')
    expectClose(r.precision, 1, 1e-12)      // LCS 2 / hyp 2
    expectClose(r.recall, 2 / 3, 1e-12)     // LCS 2 / ref 3
    expectClose(r.f1, 0.8, 1e-12)           // 2*1*(2/3)/(1+2/3)
  })

  test('rougeL: thứ tự hoán vị (LCS = 1) + chuỗi rỗng', () => {
    const r = rougeL('a b c', 'c b a') // LCS = 1 token bất kỳ
    expectClose(r.precision, 1 / 3, 1e-12)
    expectClose(r.recall, 1 / 3, 1e-12)
    const e = rougeL('', '')
    expect(e.precision).toBe(0)
    expect(e.recall).toBe(0)
    expect(e.f1).toBe(0)
  })

  test('tokenSetF1: giao/tập-hợp + hai chuỗi rỗng', () => {
    expectClose(tokenSetF1('the cat sat', 'the cat'), 0.8, 1e-12) // 2*2/(3+2)
    expectClose(tokenSetF1('a b', 'b a'), 1, 1e-12)               // tập bằng nhau
    expect(tokenSetF1('a', 'b')).toBe(0)
    expect(tokenSetF1('', '')).toBe(1)                            // khớp hoàn toàn
    expect(tokenSetF1('a', '')).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// cluster-quality
// ---------------------------------------------------------------------------

describe('r76 · stats/cluster-quality', () => {
  const euclid = (a: number[], b: number[]): number => {
    let s = 0
    for (let i = 0; i < a.length; i++) s += (a[i] - b[i]) * (a[i] - b[i])
    return Math.sqrt(s)
  }

  test('silhouetteScore (euclidean): [[0],[1],[10]] labels [0,0,1] = 0.596296', () => {
    // s(0) = (10-1)/10 = 0.9 ; s(1) = (9-1)/9 = 0.888889 ; s(2) singleton -> 0
    expectClose(silhouetteScore([[0], [1], [10]], [0, 0, 1], euclid), 0.5962962963, 1e-9)
  })

  test('silhouetteScore (mặc định 1-cos): 2 cụm cùng hướng -> ~0.993', () => {
    const v = [[1, 0], [0.9, 0.1], [0, 1], [0.1, 0.9]]
    // nội cụm gần như trùng hướng (dist ~0.006), liên cụm ~0.78-1.0 -> s ~ 0.993
    expectClose(silhouetteScore(v, [0, 0, 1, 1]), 0.993, 1e-2)
  })

  test('silhouetteScore: 1 cụm duy nhất -> 0; length mismatch throw', () => {
    expect(silhouetteScore([[0], [1]], [0, 0])).toBe(0)
    expect(() => silhouetteScore([[0]], [0, 1])).toThrow()
  })

  test('silhouetteFromGraph: cấu trúc tốt (nội mạnh, liên yếu) = 0.904762', () => {
    // 4 node, labels [0,0,1,1]; nội w=1 -> w'=0.5; liên w=0.05 -> w'=0.047619
    // s = (0.5 - 0.047619)/0.5 = 0.904762 cho mọi node
    const s = silhouetteFromGraph(
      4,
      [
        { source: 0, target: 1, weight: 1 },
        { source: 2, target: 3, weight: 1 },
        { source: 0, target: 2, weight: 0.05 },
        { source: 1, target: 3, weight: 0.05 },
      ],
      [0, 0, 1, 1],
    )
    expectClose(s, 0.9047619048, 1e-9)
  })

  test('silhouetteFromGraph: cấu trúc gán SAI (nội yếu, liên mạnh) -> âm (erratum BUG2-037)', () => {
    const s = silhouetteFromGraph(
      4,
      [
        { source: 0, target: 1, weight: 0.05 },
        { source: 2, target: 3, weight: 0.05 },
        { source: 0, target: 2, weight: 1 },
        { source: 1, target: 3, weight: 1 },
      ],
      [0, 0, 1, 1],
    )
    // s = (0.047619 - 0.5)/0.5 = -0.904762 — dấu đúng chiều: gán sai cụm
    expectClose(s, -0.9047619048, 1e-9)
  })

  test('silhouetteFromGraph: singleton + node không có cạnh liên cụm', () => {
    // node2 cụm riêng (singleton -> 0); node0/node1: a=0.5, b=0 -> s=1 -> mean 2/3
    const s = silhouetteFromGraph(3, [{ source: 0, target: 1, weight: 1 }], [0, 0, 1])
    expectClose(s, 2 / 3, 1e-12)
  })

  test('daviesBouldin: [[0],[1],[10]] = 0.052632 + 1 cụm -> 0', () => {
    // centroid 0.5/10, S_0 = 0.5, S_1 = 0 -> (0.5+0)/9.5
    expectClose(daviesBouldin([[0], [1], [10]], [0, 0, 1]), 0.0526315789, 1e-9)
    expect(daviesBouldin([[0], [1]], [0, 0])).toBe(0)
  })

  test('calinskiHarabasz: [[0],[1],[10]] = 120.333 + degenerate', () => {
    // SSB = 2*(0.5-11/3)^2 + (10-11/3)^2 = 60.16667 ; SSW = 0.5 ; CH = 60.16667/0.5
    expectClose(calinskiHarabasz([[0], [1], [10]], [0, 0, 1]), 120.3333333, 1e-6)
    expect(calinskiHarabasz([[0], [1]], [0, 0])).toBe(0) // k < 2
    expect(calinskiHarabasz([[0]], [0])).toBe(0) // n - k <= 0
  })
})

// ---------------------------------------------------------------------------
// inference
// ---------------------------------------------------------------------------

describe('r76 · stats/inference', () => {
  test('wilsonCI(0.8, 25) z=1.96 -> [0.6087, 0.9114] (erratum BUG2-035: ví dụ blueprint [0.616, 0.910] ứng z~=1.9)', () => {
    const ci = wilsonCI(0.8, 25)
    expectClose(ci.low, 0.608681, 1e-4)
    expectClose(ci.high, 0.911381, 1e-4)
    expectClose(ci.low, wilsonCIDirect(0.8, 25).low, 1e-12) // import trực tiếp
  })

  test('wilsonCI(0.5, 100) -> [0.4038, 0.5962] + n<=0 -> NaN', () => {
    const ci = wilsonCI(0.5, 100)
    expectClose(ci.low, 0.403830, 1e-4)
    expectClose(ci.high, 0.596172, 1e-4)
    expectNaN(wilsonCI(0.5, 0).low)
  })

  test('wilsonCI: p ngoài [0,1] -> NaN cả hai, kể cả vi phạm bé lọt sqrt (FB-P0-R1-06)', () => {
    // p=1.05, n=10: p(1-p)/n = -0.00525 nhỏ hơn (về dấu) z^2/4n^2 = 0.0096
    // -> sqrt vẫn dương: TRƯỚC fix trả cặp trông hợp lệ; SAU fix NaN
    expectNaN(wilsonCI(1.05, 10).low)
    expectNaN(wilsonCI(1.05, 10).high)
    expectNaN(wilsonCI(-0.2, 10).low)
    expectNaN(wilsonCI(Number.NaN, 10).high)
  })

  test('wilsonCI: z âm/0 -> NaN, không đảo chiều CI (FB-P0-R2-01, đối xứng meanCI)', () => {
    expectNaN(wilsonCI(0.5, 100, -1.96).low)
    expectNaN(wilsonCI(0.5, 100, -1.96).high)
    expectNaN(wilsonCI(0.5, 100, 0).low)
    expectNaN(wilsonCI(0.5, 100, Number.NaN).high)
  })

  test('meanCI: z âm -> low/high NaN, không đảo chiều (FB-P0-R1-05)', () => {
    const ci = meanCI([1, 2], -1.96)
    expectNaN(ci.low)
    expectNaN(ci.high)
    expect(ci.n).toBe(2)
  })

  test('meanCI: [1..5] -> 3 ± 1.96*sqrt(2.5/5) = [1.614070, 4.385930] (CLT z thuần)', () => {
    const ci = meanCI([1, 2, 3, 4, 5])
    expectClose(ci.mean, 3, 1e-12)
    expectClose(ci.low, 1.614070, 1e-6)
    expectClose(ci.high, 4.385930, 1e-6)
    expect(ci.n).toBe(5)
    expectNaN(meanCI([7]).low) // n < 2
  })

  test('welchTTest([1..5], [3..7]): t = -2, df = 8, p hai phia ~ 0.080557 (đối chiếu t-table)', () => {
    const r = welchTTest([1, 2, 3, 4, 5], [3, 4, 5, 6, 7])
    expectClose(r.t, -2, 1e-12)
    expectClose(r.df, 8, 1e-12)
    expectClose(r.p, 0.080557, 1e-4)
  })

  test('welchTTest: hai nhóm trùng nhau -> t=0, p=1; n<2 -> NaN', () => {
    const r = welchTTest([1, 2, 3], [1, 2, 3])
    expectClose(r.t, 0, 1e-12)
    expectClose(r.df, 4, 1e-12) // (2/3)^2 / (1/18 + 1/18) = 4
    expectClose(r.p, 1, 1e-12)
    expectNaN(welchTTest([1], [1, 2]).p)
  })

  test('mannWhitneyU([1,2,3], [4,5,6]): U=0, z=-1.963961, p ~ 0.049527 (khong tie)', () => {
    const r = mannWhitneyU([1, 2, 3], [4, 5, 6])
    expectClose(r.u, 0, 1e-12)
    expectClose(r.z, -1.963961, 1e-6)
    expectClose(r.p, 0.049527, 1e-5)
  })

  test('mannWhitneyU: hai nhóm trùng nhau (tie toàn phần) -> z=0, p=1', () => {
    const r = mannWhitneyU([1, 2], [1, 2])
    expectClose(r.u, 2, 1e-12)
    expectClose(r.z, 0, 1e-9)
    // p = 2*normalCdf(0) — erf A&S có sai số ~2.5e-10 tại 0 (không phải 0 đúng)
    expectClose(r.p, 1, 1e-8)
  })

  test('mannWhitneyU: dữ liệu NaN/Infinity -> NaN cả 3, không kết luận sai âm thầm (FB-P0-R1-02)', () => {
    const r = mannWhitneyU([Number.NaN, 1], [1, 2]) // trước fix: z=-1.22, p=0.22 (rác)
    expectNaN(r.u)
    expectNaN(r.z)
    expectNaN(r.p)
    const r2 = mannWhitneyU([1, 2], [Number.POSITIVE_INFINITY])
    expectNaN(r2.z)
    expectNaN(r2.p)
  })

  test('chiSquare2x2(20,10,10,20): Yates chi2 = 5.4, p ~ 0.020136 (expected 15 >= 5, duong chi-square)', () => {
    const r = chiSquare2x2(20, 10, 10, 20)
    expectClose(r.chi2, 5.4, 1e-9)
    // doi chieu: p = 2*(1 - normalCdf(sqrt(5.4))) voi sqrt(5.4) = 2.323790
    expectClose(r.p, 0.020136, 1e-4)
  })

  test('chiSquare2x2(8,2,1,9): expected 4.5 < 5 -> p lay tu Fisher exact (mot phia)', () => {
    const r = chiSquare2x2(8, 2, 1, 9)
    expectClose(r.chi2, 7.272727, 1e-6) // 20*(70-10)^2/(10*10*9*11)
    // Fisher: P(X>=8), X~Hypergeom(N=20, row1=10, col1=9) = (9*C(11,2)+11)/C(20,10)
    expectClose(r.p, 0.0027386, 1e-5)
  })

  test('chiSquare2x2: ô âm -> NaN CẢ HAI, không còn nửa vời chi2-số-rác (FB-P0-R1-07)', () => {
    const r = chiSquare2x2(-1, 5, 5, 5)
    expectNaN(r.chi2)
    expectNaN(r.p)
    expectNaN(chiSquare2x2(1, -5, 5, 5).chi2)
  })

  test('fisherExact2x2(3,1,1,3) = 17/70 (bai toan tra Fisher kinh dien, mot phia)', () => {
    expectClose(fisherExact2x2(3, 1, 1, 3), 17 / 70, 1e-12) // 16/70 + 1/70
    expectClose(fisherExact2x2(1, 3, 3, 1), 17 / 70, 1e-12) // doi xung huong con lai
    expectClose(fisherExact2x2(2, 2, 2, 2), 1, 1e-12) // ad = bc -> khong lien ket
  })

  test('anovaF([[1,2,3],[3,4,5],[5,6,7]]): F = 12, df 2/6, p = 0.008 CHINH XAC (cong thuc dong df1=2)', () => {
    const r = anovaF([[1, 2, 3], [3, 4, 5], [5, 6, 7]])
    expectClose(r.f, 12, 1e-9)
    expect(r.dfBetween).toBe(2)
    expect(r.dfWithin).toBe(6)
    expectClose(r.p, 0.008, 1e-12) // p = (1 + 2*12/6)^(-3) = 5^(-3)
  })

  test('anovaF: k<2 -> NaN; hai nhom trung khop -> F=0, p=1', () => {
    expectNaN(anovaF([[1, 2]]).f)
    const r = anovaF([[1, 2], [1, 2]])
    expectClose(r.f, 0, 1e-12)
    expectClose(r.p, 1, 1e-12)
  })

  test('normalCdf: 0 = 0.5; 1 = 0.841345; 1.959964 = 0.975; -1.644854 ~ 0.05', () => {
    expectClose(normalCdf(0), 0.5, 1e-8) // erf A&S tại 0 lệch ~2.5e-10 (xấp xỉ, không phải chính xác)
    expectClose(normalCdf(1), 0.841345, 1e-5) // A&S 7.1.26 sai so <= 1.5e-7
    expectClose(normalCdf(1.959964), 0.975, 1e-5)
    expectClose(normalCdf(-1.644854), 0.05, 1e-4)
    expectClose(normalCdf(-1) + normalCdf(1), 1, 1e-9) // doi xung
  })
})
