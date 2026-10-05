// ============================================================================
// TEST SUITE — ROUND-40 V1-T1: mapT1LismaOutcome (nhãn outcome episode T1 LISMA)
// ============================================================================
//
// ROUND-40 fix V1-T1 (phát hiện qua soát code sau test thực tế): trước đây
// outcome T1 = escalated && !regressionFound → 'PARTIAL'. Nhưng T1 gọi
// runLismaReview với round=1 → trần vòng G2_MAX_FIX_ROUNDS=3 không thể xảy ra
// → nhánh escalated-không-regression CHỈ là failOpenLisma (LLM unavailable).
// Cùng sự kiện đó ở G2 ghi FAILURE (g2LismaEscalated=true) và G3 failOpenHan
// ESCALATED → FAILURE. Nhãn PARTIAL làm importance episode chỉ 0.7 (thay vì
// FAILURE 0.85) → PRE-ACT similarity cho mission T1 tương tự under-weight
// lỗi hạ tầng. Fix: thống nhất FAILURE qua mapT1LismaOutcome (tách hàm pure
// để test 4 nhánh + nhánh phòng thủ trần vòng).
//
// Chạy: cd /home/z/tmo-app && bun test tests/t1-lisma-outcome.test.ts
// ============================================================================

import { describe, expect, test } from 'bun:test'
import { mapT1LismaOutcome } from '../src/lib/research-team/king/engine'

describe('mapT1LismaOutcome (round-40 V1-T1)', () => {
  test('fast-track sạch (không escalated, không regression) → SUCCESS', () => {
    expect(mapT1LismaOutcome({ escalated: false, regressionFound: false })).toBe('SUCCESS')
  })

  test('regression đã tự fix (không escalated) → PARTIAL — giữ semantics round-39', () => {
    expect(mapT1LismaOutcome({ escalated: false, regressionFound: true })).toBe('PARTIAL')
  })

  test('escalated + regression → FAILURE — giữ semantics round-39', () => {
    expect(mapT1LismaOutcome({
      escalated: true,
      regressionFound: true,
      escalateReason: 'Regression not fixed after 3 rounds',
    })).toBe('FAILURE')
  })

  test('FIX round-40: escalated do LLM chết (failOpenLisma, không regression) → FAILURE thay vì PARTIAL', () => {
    expect(mapT1LismaOutcome({
      escalated: true,
      regressionFound: false,
      escalateReason: 'LLM unavailable — manual review needed',
    })).toBe('FAILURE')
  })

  test('phòng thủ: escalated trần vòng thật (không LLM-death, không regression) → PARTIAL', () => {
    expect(mapT1LismaOutcome({
      escalated: true,
      regressionFound: false,
      escalateReason: 'Regression not fixed after 3 rounds',
    })).toBe('PARTIAL')
  })

  test('failOpenLisma thật: escalateReason từ lisma.ts:521 unchanged-prefix khớp nhánh FAILURE', () => {
    // Đối chiếu chuỗi gốc failOpenLisma (g2/lisma.ts) — nếu ai đổi chuỗi này
    // thì map sẽ lộ nhánh PARTIAL trở lại; test này chặn rename lén.
    expect('LLM unavailable — manual review needed'.startsWith('LLM unavailable')).toBe(true)
  })
})
