/**
 * ROUND-78 TESTS — P5-M4 DATA-QUALITY EXPECTATIONS CHO PIPELINE INGESTION
 * (BLUEPRINT-STATS-LEARNING-P0-P6 §P5-M4, mục #12 — DA.pdf §Data Quality,
 * Orchestration & Monitoring — Great Expectations-style)
 *
 * Đo lường (thuần hàm — spec: "đo thuần hàm"):
 *   A. evaluateExpectations — mọi vi phạm đúng mức (warn/fail) đúng phép so
 *      (between đóng 2 đầu, lt ngặt, gt ngặt); metric thiếu/NaN → evaluated=false
 *      KHÔNG tính vi phạm; đủ 5 expectation đúng spec.
 *   B. summarizeExpectationResults — đếm fail/warn đúng; marker máy-đọc-được
 *      khớp regex KPI ingestion_expectation_fails; all-pass + not-measured.
 *   C. stripExpectationMarker — bỏ marker cũ giữ phần detail khác (idempotent
 *      khi pipeline chạy lại).
 *   D. Hợp đồng spec — 5 expectation đúng id/bound/severity khai báo §P5-M4
 *      (chống trôi hằng số: đổi ngưỡng phải ý thức, không lặng lẽ).
 *
 * Live: chạy 1 document thật → expectation kết quả ghi trong processingSteps
 * (nghiệm thu đợt — live probe sau deploy).
 */

import { describe, test, expect } from 'bun:test'
import {
  PIPELINE_EXPECTATIONS,
  evaluateExpectations,
  summarizeExpectationResults,
  stripExpectationMarker,
} from '@/lib/ingestion/pipeline-expectations'

// Bộ số đo SẠCH — mọi expectation trong ngưỡng
const CLEAN: Record<string, number> = {
  chunks_per_page: 2.5,
  entity_rate: 1.8,
  zero_vector_rate: 0,
  relationship_per_entity: 1.2,
  embedding_success_rate: 1,
}

// Regex KPI ingestion_expectation_fails (kpi/registry.ts) — đối chiếu chéo hợp đồng marker
const KPI_MARKER_RE = /expectations\[P5-M4\]: fail=(\d+) warn=(\d+)/

// ==================== A. evaluateExpectations ====================

describe('A. evaluateExpectations — kiểm ngưỡng đúng mức + đúng phép so', () => {
  test('số đo sạch → tất cả pass, không vi phạm', () => {
    const results = evaluateExpectations(CLEAN)
    expect(results.length).toBe(5)
    expect(results.every(r => r.passed)).toBe(true)
    const s = summarizeExpectationResults(results)
    expect(s.failCount).toBe(0)
    expect(s.warnCount).toBe(0)
    expect(s.line).toContain('all pass')
  })

  test('chunks_per_page = 0.1 (parse hỏng) → WARN', () => {
    const r = evaluateExpectations({ ...CLEAN, chunks_per_page: 0.1 })
    const e = r.find(x => x.id === 'chunks_per_page')!
    expect(e.evaluated).toBe(true)
    expect(e.passed).toBe(false)
    expect(e.severity).toBe('warn')
  })

  test('chunks_per_page = 10 (chunking lỗi) → WARN', () => {
    const e = evaluateExpectations({ ...CLEAN, chunks_per_page: 10 }).find(x => x.id === 'chunks_per_page')!
    expect(e.passed).toBe(false)
    expect(e.severity).toBe('warn')
  })

  test('entity_rate = 10/chunk (hallucinating) → WARN', () => {
    const e = evaluateExpectations({ ...CLEAN, entity_rate: 10 }).find(x => x.id === 'entity_rate')!
    expect(e.passed).toBe(false)
    expect(e.severity).toBe('warn')
  })

  test('entity_rate = 0.05/chunk (miss) → WARN', () => {
    const e = evaluateExpectations({ ...CLEAN, entity_rate: 0.05 }).find(x => x.id === 'entity_rate')!
    expect(e.passed).toBe(false)
    expect(e.severity).toBe('warn')
  })

  test('zero_vector_rate = 0.05 → FAIL (đã có guard P0-5, nâng thống kê)', () => {
    const e = evaluateExpectations({ ...CLEAN, zero_vector_rate: 0.05 }).find(x => x.id === 'zero_vector_rate')!
    expect(e.passed).toBe(false)
    expect(e.severity).toBe('fail')
  })

  test('embedding_success_rate = 0.99 → FAIL (provider lỗi hàng loạt)', () => {
    const e = evaluateExpectations({ ...CLEAN, embedding_success_rate: 0.99 }).find(x => x.id === 'embedding_success_rate')!
    expect(e.passed).toBe(false)
    expect(e.severity).toBe('fail')
  })

  test('relationship_per_entity = 5 → WARN', () => {
    const e = evaluateExpectations({ ...CLEAN, relationship_per_entity: 5 }).find(x => x.id === 'relationship_per_entity')!
    expect(e.passed).toBe(false)
    expect(e.severity).toBe('warn')
  })

  test('biên between ĐÓNG 2 đầu: 0.3/8 chunks_per_page PASS, 0.2/6 entity_rate PASS', () => {
    const r = evaluateExpectations({ ...CLEAN, chunks_per_page: 0.3, entity_rate: 6 })
    expect(r.find(x => x.id === 'chunks_per_page')!.passed).toBe(true)
    expect(r.find(x => x.id === 'entity_rate')!.passed).toBe(true)
  })

  test('biên lt/gt NGẶT: zero_vector 0.01 FAIL (không ngặt <), embedding 0.999 FAIL (không ngặt >)', () => {
    const r = evaluateExpectations({ ...CLEAN, zero_vector_rate: 0.01, embedding_success_rate: 0.999 })
    expect(r.find(x => x.id === 'zero_vector_rate')!.passed).toBe(false)
    expect(r.find(x => x.id === 'embedding_success_rate')!.passed).toBe(false)
  })

  test('metric thiếu → evaluated=false, KHÔNG tính vi phạm (thiếu đo ≠ hỏng)', () => {
    const results = evaluateExpectations({ chunks_per_page: 2.5 }) // chỉ 1 metric
    const missing = results.filter(r => !r.evaluated)
    expect(missing.length).toBe(4)
    expect(missing.every(r => r.passed)).toBe(true)
    const s = summarizeExpectationResults(results)
    expect(s.failCount).toBe(0)
    expect(s.warnCount).toBe(0)
    expect(s.notMeasured).toBe(4)
    expect(s.line).toContain('chưa đo: 4')
  })

  test('NaN/±∞ → evaluated=false (không cho NaN lọt qua phép so)', () => {
    const r = evaluateExpectations({ ...CLEAN, entity_rate: Number.NaN, zero_vector_rate: Number.POSITIVE_INFINITY })
    expect(r.find(x => x.id === 'entity_rate')!.evaluated).toBe(false)
    expect(r.find(x => x.id === 'zero_vector_rate')!.evaluated).toBe(false)
  })

  test('kịch bản hỗn hợp: 1 fail + 2 warn đếm đúng', () => {
    const results = evaluateExpectations({
      ...CLEAN,
      zero_vector_rate: 0.05,        // fail
      entity_rate: 12,               // warn
      chunks_per_page: 9,            // warn
    })
    const s = summarizeExpectationResults(results)
    expect(s.failCount).toBe(1)
    expect(s.warnCount).toBe(2)
    expect(s.notMeasured).toBe(0)
  })
})

// ==================== B. summarizeExpectationResults — hợp đồng marker ====================

describe('B. summarizeExpectationResults — marker cho KPI', () => {
  test('marker khớp regex KPI ingestion_expectation_fails (đối chiếu chéo)', () => {
    const s = summarizeExpectationResults(evaluateExpectations({ ...CLEAN, entity_rate: 12, zero_vector_rate: 0.05 }))
    const m = s.line.match(KPI_MARKER_RE)
    expect(m).not.toBeNull()
    expect(Number(m![1])).toBe(1) // fail
    expect(Number(m![2])).toBe(1) // warn
    expect(s.marker).toBe(s.line)
  })

  test('dòng vi phạm liệt kê detail người đọc được kèm giá trị + ngưỡng', () => {
    const s = summarizeExpectationResults(evaluateExpectations({ ...CLEAN, entity_rate: 12 }))
    expect(s.line).toContain('entity_rate = 12 NGOÀI')
    expect(s.line).toContain('[0.2, 6]')
  })

  test('all pass: fail=0 warn=0 · all pass', () => {
    const s = summarizeExpectationResults(evaluateExpectations(CLEAN))
    expect(s.line).toBe('expectations[P5-M4]: fail=0 warn=0 · all pass')
  })
})

// ==================== C. stripExpectationMarker — idempotent khi pipeline chạy lại ====================

describe('C. stripExpectationMarker — ghi đè idempotent', () => {
  test('bỏ marker cũ, giữ phần detail gốc', () => {
    const detail = '447/447 embeddings · expectations[P5-M4]: fail=1 warn=0 · entity_rate = 12 NGOÀI ∈ [0.2, 6] (WARN: hallucinating)'
    expect(stripExpectationMarker(detail)).toBe('447/447 embeddings')
  })

  test('strip 2 lần = strip 1 lần (idempotent)', () => {
    const detail = 'X · expectations[P5-M4]: fail=0 warn=1 · chunks_per_page = 9 NGOÀI ∈ [0.3, 8] (WARN: chunking lỗi)'
    const once = stripExpectationMarker(detail)
    expect(stripExpectationMarker(once)).toBe(once)
  })

  test('detail không có marker → giữ nguyên; null/rỗng → chuỗi rỗng', () => {
    expect(stripExpectationMarker('447/447 embeddings')).toBe('447/447 embeddings')
    expect(stripExpectationMarker(null)).toBe('')
    expect(stripExpectationMarker('')).toBe('')
  })

  test('attach-đè mô phỏng đường pipeline: detail cũ + marker mới không nhân đôi', () => {
    // (mô phỏng attachExpectationDetail trong process route)
    const attach = (detail: string | null, line: string) =>
      `${stripExpectationMarker(detail)}${stripExpectationMarker(detail) ? ' · ' : ''}${line}`
    const run1 = attach('447/447 embeddings', 'expectations[P5-M4]: fail=1 warn=0 · entity_rate = 12 NGOÀI ∈ [0.2, 6] (WARN: extraction hallucinating hoặc miss)')
    const run2 = attach(run1, 'expectations[P5-M4]: fail=0 warn=0 · all pass')
    expect(run2.match(KPI_MARKER_RE)!.length).toBeGreaterThan(0)
    expect((run2.match(/expectations\[P5-M4\]/g) || []).length).toBe(1) // không nhân đôi marker
    expect(run2).toContain('447/447 embeddings') // detail gốc sống sót
  })
})

// ==================== D. Hợp đồng spec §P5-M4 — chống trôi hằng số ====================

describe('D. PIPELINE_EXPECTATIONS — đúng khai báo spec §P5-M4', () => {
  test('đủ 5 expectation đúng id', () => {
    expect(PIPELINE_EXPECTATIONS.map(e => e.id)).toEqual([
      'chunks_per_page',
      'entity_rate',
      'zero_vector_rate',
      'relationship_per_entity',
      'embedding_success_rate',
    ])
  })

  test('đúng bound + severity theo spec (đổi ngưỡng phải ý thức — sửa test này cùng lúc)', () => {
    const byId = new Map(PIPELINE_EXPECTATIONS.map(e => [e.id, e]))
    expect(byId.get('chunks_per_page')!.bound).toEqual([0.3, 8])
    expect(byId.get('chunks_per_page')!.severity).toBe('warn')
    expect(byId.get('entity_rate')!.bound).toEqual([0.2, 6])
    expect(byId.get('entity_rate')!.severity).toBe('warn')
    expect(byId.get('zero_vector_rate')!.bound).toBe(0.01)
    expect(byId.get('zero_vector_rate')!.severity).toBe('fail')
    expect(byId.get('relationship_per_entity')!.bound).toEqual([0.2, 4])
    expect(byId.get('relationship_per_entity')!.severity).toBe('warn')
    expect(byId.get('embedding_success_rate')!.bound).toBe(0.999)
    expect(byId.get('embedding_success_rate')!.severity).toBe('fail')
  })
})
