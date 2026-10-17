/**
 * r117 — BRAIN-D2 (BLUEPRINT-EVO-NAO-P1-P5 §8.2 — task 31-d) — PURE STATS
 * ============================================================================
 *
 * Pin logic thuần của src/lib/kb-routing/d2-stats.ts (0 import db/server —
 * doctrine #9, precedent r115 pin evo/ui-helpers):
 *  - percentile: nội suy tuyến tính (p50/p95 mảng chẵn/lẻ + case nội suy đúng
 *    vị trí lẻ 94.05), biên p0/p100, input rỗng/p không hợp lệ → null,
 *    KHÔNG tự sort (tiền điều kiện caller — pin hành vi để ai gọi sai sẽ thấy).
 *  - mean/median (median sort bản copy — không đổi mảng gốc).
 *  - summarizeLatency: mảng cố định + lọc non-finite + mảng rỗng → n=0/null.
 *  - parseSourcesJson / parseRetrievalConfig: JSON hợp lệ / garbage / null /
 *    JSON-primitive / object lạ không key quen thuộc → fail-open typed null;
 *    object truncate {truncated:true} vẫn parse được.
 *  - classifySourceOutcome: đủ 4 nhánh chuẩn + bất thường 'hit-while-disabled'
 *    + thứ tự ưu tiên (error thắng mọi nhánh) + enabled undefined → coi bật.
 *  - correlateOutcome: +1 hoàn hảo, −1 hoàn hảo, giá trị biết trước 2/√5,
 *    n<3 → null, variance 0 (metric phẳng / Outcome toàn một loại) → null,
 *    lọc metric non-finite trước khi đếm n.
 *
 * Không đụng DB (bunfig preload db-isolation không liên quan — module thuần).
 */

import { describe, expect, test } from 'bun:test'
import {
  classifySourceOutcome,
  correlateOutcome,
  mean,
  median,
  parseRetrievalConfig,
  parseSourcesJson,
  percentile,
  summarizeLatency,
  type OutcomePair,
} from '../src/lib/kb-routing/d2-stats'

// ==================== PERCENTILE (nội suy tuyến tính) ====================

describe('r117 · percentile — nội suy tuyến tính trên mảng ĐÃ sort', () => {
  test('p50 mảng lẻ [1..5] → đúng phần tử giữa (3)', () => {
    expect(percentile([1, 2, 3, 4, 5], 50)).toBe(3)
  })

  test('p50 mảng chẵn [1,2,3,4] → nội suy giữa 2 và 3 (2.5)', () => {
    expect(percentile([1, 2, 3, 4], 50)).toBe(2.5)
  })

  test('p95 [1..100] → 95.05 (rank 94.05 — nội suy giữa 95 và 96)', () => {
    expect(percentile(Array.from({ length: 100 }, (_, i) => i + 1), 95)).toBeCloseTo(95.05, 10)
  })

  test('biên p0 = min, p100 = max; mảng 1 phần tử mọi p → chính nó', () => {
    expect(percentile([7, 9, 20], 0)).toBe(7)
    expect(percentile([7, 9, 20], 100)).toBe(20)
    expect(percentile([42], 95)).toBe(42)
  })

  test('fail-open: mảng rỗng / p NaN / p ngoài [0,100] → null', () => {
    expect(percentile([], 50)).toBeNull()
    expect(percentile([1, 2, 3], Number.NaN)).toBeNull()
    expect(percentile([1, 2, 3], -1)).toBeNull()
    expect(percentile([1, 2, 3], 101)).toBeNull()
  })

  test('KHÔNG tự sort — pin tiền điều kiện "mảng đã sort" (gọi sai sẽ thấy ngay)', () => {
    // [3,1,2] p50 trả phần tử giữa NGUYÊN BẢN (1) chứ không phải median thật (2)
    // — caller (summarizeLatency/median) chịu trách nhiệm sort.
    expect(percentile([3, 1, 2], 50)).toBe(1)
  })
})

// ==================== MEAN / MEDIAN ====================

describe('r117 · mean / median', () => {
  test('mean [1,2,3,4] = 2.5; mảng rỗng → null (không bịa 0)', () => {
    expect(mean([1, 2, 3, 4])).toBe(2.5)
    expect(mean([])).toBeNull()
  })

  test('median sort bản copy: median([5,1,3]) = 3 và mảng gốc KHÔNG đổi', () => {
    const original = [5, 1, 3]
    expect(median(original)).toBe(3)
    expect(original).toEqual([5, 1, 3])
    expect(median([1, 2, 3, 4])).toBe(2.5)
    expect(median([])).toBeNull()
  })
})

// ==================== SUMMARIZE LATENCY ====================

describe('r117 · summarizeLatency — {n, p50, p95, mean, max}', () => {
  test('mảng cố định [10,20,30,40,100]: n=5, p50=30, p95=88 (nội suy 40+0.8×60), mean=40, max=100', () => {
    const s = summarizeLatency([10, 20, 30, 40, 100])
    expect(s.n).toBe(5)
    expect(s.p50).toBe(30)
    // p95 nội suy 40 + 0.8×(100−40) — dùng toBeCloseTo (floating: 88.000…01)
    expect(s.p95).toBeCloseTo(88, 10)
    expect(s.mean).toBe(40)
    expect(s.max).toBe(100)
  })

  test('lọc non-finite TRƯỚC thống kê — n đếm sau lọc (trung thực cỡ mẫu)', () => {
    const s = summarizeLatency([10, Number.NaN, Number.POSITIVE_INFINITY, 20])
    expect(s.n).toBe(2)
    expect(s.p50).toBe(15)
    expect(s.mean).toBe(15)
    expect(s.max).toBe(20)
  })

  test('mảng rỗng / toàn non-finite → n=0, mọi số null', () => {
    expect(summarizeLatency([])).toEqual({ n: 0, p50: null, p95: null, mean: null, max: null })
    expect(summarizeLatency([Number.NaN])).toEqual({ n: 0, p50: null, p95: null, mean: null, max: null })
  })
})

// ==================== PARSERS (fail-open typed null) ====================

describe('r117 · parseSourcesJson — fail-open trên mọi dạng rác', () => {
  test('JSON hợp lệ đầy đủ: 4 nguồn + errors', () => {
    const p = parseSourcesJson('{"chunks":3,"entities":0,"memories":1,"communities":2,"errors":{"memories":"Qdrant down"}}')
    expect(p).not.toBeNull()
    expect(p?.chunks).toBe(3)
    expect(p?.entities).toBe(0)
    expect(p?.memories).toBe(1)
    expect(p?.communities).toBe(2)
    expect(p?.errors).toEqual({ memories: 'Qdrant down' })
  })

  test('row graph-query {graphRecords, graphError} parse đúng', () => {
    const p = parseSourcesJson('{"graphRecords":25,"graphError":"Neo4j driver not available"}')
    expect(p?.graphRecords).toBe(25)
    expect(p?.graphError).toBe('Neo4j driver not available')
  })

  test('garbage / null / JSON-primitive / array / object lạ → null', () => {
    expect(parseSourcesJson('{oops')).toBeNull()
    expect(parseSourcesJson(null)).toBeNull()
    expect(parseSourcesJson(undefined)).toBeNull()
    expect(parseSourcesJson('')).toBeNull()
    expect(parseSourcesJson('42')).toBeNull()
    expect(parseSourcesJson('"text"')).toBeNull()
    expect(parseSourcesJson('[1,2]')).toBeNull()
    expect(parseSourcesJson('{"unknownKey":true}')).toBeNull()
  })

  test('object truncate {truncated:true} của serializeCapped vẫn parse được', () => {
    const p = parseSourcesJson('{"truncated":true}')
    expect(p).not.toBeNull()
    expect(p?.truncated).toBe(true)
    expect(p?.chunks).toBeUndefined()
  })
})

describe('r117 · parseRetrievalConfig — fail-open + sourcesEnabled lọc boolean', () => {
  test('JSON hợp lệ: topK/hybrid/rerank/denseThreshold/sourcesEnabled', () => {
    const p = parseRetrievalConfig(
      '{"topK":5,"minImportance":0.3,"embeddingOverride":false,"hybrid":true,"mmr":true,"rerank":false,"denseThreshold":0.3,"sourcesEnabled":{"chunks":true,"communities":true,"entities":false,"memories":false}}',
    )
    expect(p?.topK).toBe(5)
    expect(p?.hybrid).toBe(true)
    expect(p?.rerank).toBe(false)
    expect(p?.denseThreshold).toBe(0.3)
    expect(p?.sourcesEnabled).toEqual({ chunks: true, communities: true, entities: false, memories: false })
  })

  test('garbage → null; row graph {graphCypher} + row fallback {fallbackDenseOnly} hợp lệ', () => {
    expect(parseRetrievalConfig('not json')).toBeNull()
    expect(parseRetrievalConfig('null')).toBeNull()
    expect(parseRetrievalConfig('[]')).toBeNull()
    expect(parseRetrievalConfig('{"whatever":1}')).toBeNull()
    expect(parseRetrievalConfig('{"graphCypher":true}')?.graphCypher).toBe(true)
    expect(parseRetrievalConfig('{"fallbackDenseOnly":true}')?.fallbackDenseOnly).toBe(true)
  })

  test('trường sai kiểu bị bỏ (fail-open từng trường): topK "5" (string) → undefined', () => {
    const p = parseRetrievalConfig('{"topK":"5","hybrid":"yes"}')
    expect(p?.topK).toBeUndefined()
    expect(p?.hybrid).toBeUndefined()
  })
})

// ==================== CLASSIFY SOURCE OUTCOME ====================

describe('r117 · classifySourceOutcome — 4 nhánh + bất thường hit-while-disabled', () => {
  test('hit: nguồn bật + hits>0', () => {
    expect(classifySourceOutcome(true, 5, undefined)).toBe('hit')
  })

  test('empty: nguồn bật + 0 hit + không lỗi (KB trống — KHÔNG phải lỗi)', () => {
    expect(classifySourceOutcome(true, 0, undefined)).toBe('empty')
    expect(classifySourceOutcome(true, undefined, undefined)).toBe('empty')
  })

  test('error: có lỗi → thắng cả nhánh hit (nguồn chết là tín hiệu rõ nhất)', () => {
    expect(classifySourceOutcome(true, 0, 'Qdrant unreachable')).toBe('error')
    expect(classifySourceOutcome(true, 3, 'Qdrant unreachable')).toBe('error')
    // error '' (chuỗi rỗng) → không coi là lỗi
    expect(classifySourceOutcome(true, 0, '')).toBe('empty')
  })

  test('disabled: nguồn TẮT + 0 hit (bỏ chạy chủ đích — vd không truyền agentId)', () => {
    expect(classifySourceOutcome(false, 0, undefined)).toBe('disabled')
    expect(classifySourceOutcome(false, undefined, undefined)).toBe('disabled')
  })

  test('hit-while-disabled: BẤT THƯỜNG — nguồn tắt mà vẫn có hits (regression flag)', () => {
    expect(classifySourceOutcome(false, 2, undefined)).toBe('hit-while-disabled')
  })

  test('enabled undefined (row cũ không sourcesEnabled) → coi như ĐANG BẬT', () => {
    expect(classifySourceOutcome(undefined, 4, undefined)).toBe('hit')
    expect(classifySourceOutcome(undefined, 0, undefined)).toBe('empty')
  })
})

// ==================== CORRELATE OUTCOME (Pearson) ====================

describe('r117 · correlateOutcome — Pearson r + n, fail-open null', () => {
  test('tương quan hoàn hảo +1 (outcome nhị phân tuyến tính theo metric)', () => {
    const pairs: OutcomePair[] = [
      { metric: 1, outcomeSuccess: false },
      { metric: 1, outcomeSuccess: false },
      { metric: 2, outcomeSuccess: true },
      { metric: 2, outcomeSuccess: true },
    ]
    const r = correlateOutcome(pairs)
    expect(r).not.toBeNull()
    expect(r?.n).toBe(4)
    expect(r?.pearsonR).toBeCloseTo(1, 12)
  })

  test('tương quan hoàn hảo −1 (metric cao = thất bại)', () => {
    const pairs: OutcomePair[] = [
      { metric: 1, outcomeSuccess: true },
      { metric: 1, outcomeSuccess: true },
      { metric: 2, outcomeSuccess: false },
      { metric: 2, outcomeSuccess: false },
    ]
    expect(correlateOutcome(pairs)?.pearsonR).toBeCloseTo(-1, 12)
  })

  test('giá trị biết trước: [(1,F),(2,F),(3,T),(4,T)] → r = 2/√5 ≈ 0.8944', () => {
    const pairs: OutcomePair[] = [
      { metric: 1, outcomeSuccess: false },
      { metric: 2, outcomeSuccess: false },
      { metric: 3, outcomeSuccess: true },
      { metric: 4, outcomeSuccess: true },
    ]
    const r = correlateOutcome(pairs)
    expect(r?.n).toBe(4)
    expect(r?.pearsonR).toBeCloseTo(2 / Math.sqrt(5), 12)
  })

  test('n<3 → null (quá mỏng — không nói được gì)', () => {
    expect(correlateOutcome([])).toBeNull()
    expect(correlateOutcome([{ metric: 1, outcomeSuccess: true }])).toBeNull()
    expect(
      correlateOutcome([
        { metric: 1, outcomeSuccess: true },
        { metric: 2, outcomeSuccess: false },
      ]),
    ).toBeNull()
  })

  test('variance 0 → null: metric phẳng, hoặc Outcome toàn một loại', () => {
    // Metric phẳng
    expect(
      correlateOutcome([
        { metric: 5, outcomeSuccess: false },
        { metric: 5, outcomeSuccess: true },
        { metric: 5, outcomeSuccess: false },
      ]),
    ).toBeNull()
    // Outcome toàn fail (vy=0)
    expect(
      correlateOutcome([
        { metric: 1, outcomeSuccess: false },
        { metric: 2, outcomeSuccess: false },
        { metric: 3, outcomeSuccess: false },
      ]),
    ).toBeNull()
  })

  test('metric non-finite bị LỌC trước khi đếm n (NaN/∞ không phá report)', () => {
    const pairs: OutcomePair[] = [
      { metric: Number.NaN, outcomeSuccess: true },
      { metric: Number.POSITIVE_INFINITY, outcomeSuccess: false },
      { metric: 1, outcomeSuccess: false },
      { metric: 2, outcomeSuccess: true },
    ]
    // Sau lọc chỉ còn 2 cặp hợp lệ → n<3 → null
    expect(correlateOutcome(pairs)).toBeNull()
    // Thêm 1 cặp hợp lệ nữa → n=3, tính được: xs=[1,2,3], ys=[0,1,1]
    // → r = 1/√(varX×varY) = √3/2 ≈ 0.866 (không phải 1 — ys không tuyến tính theo xs)
    const r = correlateOutcome([...pairs, { metric: 3, outcomeSuccess: true }])
    expect(r?.n).toBe(3)
    expect(r?.pearsonR).toBeCloseTo(Math.sqrt(3) / 2, 12)
  })

  test('r luôn trong [−1,1] (kẹp floating-point trên dữ liệu perfectly-correlated lớn)', () => {
    const pairs: OutcomePair[] = Array.from({ length: 50 }, (_, i) => ({
      metric: i % 2, // 0,1,0,1…
      outcomeSuccess: i % 2 === 1,
    }))
    const r = correlateOutcome(pairs)
    expect(r).not.toBeNull()
    expect(r?.pearsonR).toBeLessThanOrEqual(1)
    expect(r?.pearsonR).toBeGreaterThanOrEqual(-1)
  })
})
