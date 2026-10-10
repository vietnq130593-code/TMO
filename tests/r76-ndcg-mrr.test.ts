/**
 * ROUND-76 TESTS — P1-M2 nDCG@5 + MRR CHO RETRIEVAL EVAL
 * (BLUEPRINT-STATS-LEARNING-P0-P6 §P1-M2, mục #2)
 *
 * Đo lường: buildRelevanceVector (src/lib/eval/relevance.ts — MỚI tách khỏi
 * runner.ts) — vector relevance nhị phân first-occurrence per entity trên
 * danh sách chunk ĐÃ XẾP HẠNG, cùng bộ khớp normalized-substring của
 * recall@5 (Task 13E). Kèm tích hợp ndcgAtK/mrr từ stats/ranking (đã kiểm
 * chứng độc lập ở r76-stats-core — đây kiểm chứng ĐƯỜNG DỮ LIỆU vào hàm).
 *
 * Case chuẩn blueprint ("mock 5 chunk: relevant ở vị trí 2,5"):
 *   rel = [0,1,0,0,1] (0-based: 1 và 4)
 *   DCG@5  = 0/log2(2) + 1/log2(3) + 0 + 0 + 1/log2(6)
 *   IDCG@5 (2 relevant, vị trí tốt nhất 1,2) = 1/log2(2) + 1/log2(3)
 *   nDCG@5 = DCG/IDCG ≈ 0.624050…
 *   MRR    = 1/2 (relevant đầu tiên ở vị trí 2)
 *
 * Nguyên tắc: expected DẪN TỪ CÔNG THỨC ngay trong test (không hardcode số
 * dễ gõ nhầm); mọi tính chất first-occurrence/consistency với recall cũ
 * được đối chếu bằng cách đếm CŨ (filter + some) trên cùng dữ liệu.
 */

import { describe, test, expect } from 'bun:test'
import {
  normalizeForEntityMatch,
  buildRelevanceVector,
  type ExpectedEntity,
} from '@/lib/eval/relevance'
import { ndcgAtK, mrr } from '@/lib/stats'

function expectClose(actual: number, expected: number, tol: number, label = ''): void {
  expect(Math.abs(actual - expected), `${label} | actual=${actual} expected=${expected}`).toBeLessThan(tol)
}

describe('r76 · P1-M2 buildRelevanceVector — relevance nhị phân first-occurrence', () => {
  test('case chuẩn blueprint: 5 chunk, relevant ở vị trí 2 & 5 → rel [0,1,0,0,1]', () => {
    const expected: ExpectedEntity[] = [{ name: 'Dijkstra' }, { name: 'shortest path' }]
    const chunks = [
      { text: 'irrelevant intro about graphs in general' },
      { text: 'Dijkstra proposed his algorithm in 1956' },
      { text: 'other routing protocols discussion' },
      { text: 'background section' },
      { text: 'the shortest path problem is solved by Dijkstra' },
    ]
    const { rel, retrievedCount } = buildRelevanceVector(expected, chunks)
    expect(rel).toEqual([0, 1, 0, 0, 1])
    expect(retrievedCount).toBe(2)
  })

  test('first-occurrence: entity xuất hiện ở NHIỀU chunk chỉ đánh dấu chunk ĐẦU', () => {
    const expected: ExpectedEntity[] = [{ name: 'alpha' }]
    const chunks = [
      { text: 'alpha here' },
      { text: 'alpha again' },
      { text: 'alpha once more' },
    ]
    const { rel, retrievedCount } = buildRelevanceVector(expected, chunks)
    expect(rel).toEqual([1, 0, 0])
    expect(retrievedCount).toBe(1) // 1 entity — không phình theo số chunk chứa nó
  })

  test('nhiều entity trong CÙNG 1 chunk: chunk relevant, các chunk sau sạch', () => {
    const expected: ExpectedEntity[] = [{ name: 'alpha' }, { name: 'beta' }]
    const chunks = [
      { text: 'alpha and beta together' },
      { text: 'gamma only' },
      { text: 'beta alone' }, // beta đã khớp ở chunk 0 → chunk này KHÔNG relevant
    ]
    const { rel, retrievedCount } = buildRelevanceVector(expected, chunks)
    expect(rel).toEqual([1, 0, 0])
    expect(retrievedCount).toBe(2)
  })

  test('không có entity kì vọng → rel toàn 0, retrievedCount 0 (case âm tính)', () => {
    const chunks = [{ text: 'a' }, { text: 'b' }]
    const { rel, retrievedCount } = buildRelevanceVector([], chunks)
    expect(rel).toEqual([0, 0])
    expect(retrievedCount).toBe(0)
  })

  test('ít chunk hơn K: rel dài theo số chunk, không pad', () => {
    const expected: ExpectedEntity[] = [{ name: 'x' }]
    const { rel, retrievedCount } = buildRelevanceVector(expected, [{ text: 'nothing' }])
    expect(rel).toEqual([0])
    expect(retrievedCount).toBe(0)
  })

  test('normalize giữ nguyên semantics Task 13E: curly quote/dash khớp straight-quote', () => {
    const expected: ExpectedEntity[] = [{ name: "L'Hôpital's rule" }, { name: 'Naive—Bayes' }]
    const chunks = [
      { text: 'the “L’Hôpital’s rule” applies to limits' }, // curly “ ” ’
      { text: 'we combine Naive–Bayes with logistic regression' }, // en-dash –
    ]
    const { rel, retrievedCount } = buildRelevanceVector(expected, chunks)
    expect(rel).toEqual([1, 1])
    expect(retrievedCount).toBe(2)
    // Bộ chuẩn hoá hoạt động độc lập: “ ” ’ — → " " ' -
    expect(normalizeForEntityMatch('“x’—y”')).toBe('"x\'-y"')
  })

  test('consistency với recall cũ: retrievedCount === filter+some trên cùng dữ liệu', () => {
    const expected: ExpectedEntity[] = [
      { name: 'alpha' }, { name: 'beta' }, { name: 'gamma' }, { name: 'delta' },
    ]
    const chunks = [
      { text: 'delta appears first oddly' },
      { text: 'alpha and gamma share a chunk' },
      { text: 'nothing here' },
      { text: 'beta shows late' },
      { text: 'alpha repeated' },
      { text: 'gamma repeated too' },
    ]
    const { rel, retrievedCount } = buildRelevanceVector(expected, chunks)
    // Cách đếm CŨ của runner (recall@5 semantics — không phụ thuộc vị trí)
    const oldCount = expected.filter((e) =>
      chunks.some((c) => normalizeForEntityMatch(c.text).includes(normalizeForEntityMatch(e.name))),
    ).length
    expect(retrievedCount).toBe(oldCount) // 4 — hai chỉ số không thể lệch nhau
    expect(rel).toEqual([1, 1, 0, 1, 0, 0])
  })
})

describe('r76 · P1-M2 nDCG@5 + MRR tích hợp trên rel vector', () => {
  test('case chuẩn blueprint: nDCG + MRR tính bằng công thức (không hardcode)', () => {
    const rel = [0, 1, 0, 0, 1]
    // DCG@5 = 1/log2(3) + 1/log2(6); IDCG@5 = 1/log2(2) + 1/log2(3)
    const dcg = 1 / Math.log2(3) + 1 / Math.log2(6)
    const idcg = 1 / Math.log2(2) + 1 / Math.log2(3)
    expectClose(ndcgAtK(rel, 5), dcg / idcg, 1e-12, 'nDCG@5 [0,1,0,0,1]')
    expectClose(mrr(rel), 1 / 2, 1e-12, 'MRR relevant đầu ở vị trí 2')
  })

  test('rel toàn 0 (case âm tính / không entity) → nDCG = MRR = 0', () => {
    expect(ndcgAtK([0, 0, 0, 0, 0], 5)).toBe(0)
    expect(mrr([0, 0, 0, 0, 0])).toBe(0)
  })

  test('relevant đầu tiên ở vị trí 1 → nDCG = MRR = 1 (hoàn hảo)', () => {
    const rel = [1, 0, 0, 0, 0]
    expect(ndcgAtK(rel, 5)).toBe(1)
    expect(mrr(rel)).toBe(1)
  })

  test('thứ tự ảnh hưởng nDCG/MRR nhưng KHÔNG ảnh hưởng recall (đó là lý do thêm chỉ số)', () => {
    const early = [1, 1, 0, 0, 0] // 2 relevant sớm
    const late = [0, 0, 0, 1, 1] // 2 relevant muộn — cùng recall
    const ndcgEarly = ndcgAtK(early, 5)
    const ndcgLate = ndcgAtK(late, 5)
    expect(ndcgEarly).toBe(1) // đúng thứ tự tối ưu
    expect(ndcgLate).toBeLessThan(ndcgEarly) // 0.4512… — thứ tự tệ bị phạt
    expect(mrr(early)).toBe(1)
    expect(mrr(late)).toBe(1 / 4)
    // Recall như nhau: đếm 1 ở cả 2 vector
    expect(early.reduce((s, x) => s + x, 0)).toBe(late.reduce((s, x) => s + x, 0))
  })
})
