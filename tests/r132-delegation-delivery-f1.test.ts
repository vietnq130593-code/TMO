/**
 * r132 — F1 DELEGATION DELIVERY SEMANTICS CHO token_budget (OBS P1)
 * =====================================================================================
 * User duyệt fix F1-F6 theo biên bản quan sát OBSERVE-PROTOCOL-1 (FINAL)
 * 2026-10-20. F1 (P1): sub-agent kết thúc endedBy='token_budget' tuy ĐÃ trả
 * report PARTIAL (conf 0.70) + evidence đầy đủ nhưng outcome.success=false
 * → parent (Omega) nhận ✗ kèm generic "Delegate thất bại — bạn có thể tự
 * làm trực tiếp" → đổ lỗi delegation + không truy hồi 6 findings ALISTA
 * (84K tokens công sức bị coi là thất bại) — vòng reinforcement chống-
 * delegate Task G LẶP LẠI cho token_budget.
 *
 * Fix 3 mảnh (commit này):
 *   1. subagent-delegate.ts — 'token_budget' gia nhập nhóm delivery-success
 *      (concluded/iteration_limit/stall_brake) — mirror Task G; chất lượng
 *      vẫn do evaluation.pass/gaps phán (tách bạch).
 *   2. Wrap-up grace: cũ budget+5K (ALISTA 83,865 ≥ 45,000+5,000 → SKIP
 *      wrap-up, report không nén) → thêm +40% budget VÀ bypass khi CÓ
 *      evidence/lastContent.
 *   3. tool-executor hint: nêu endedBy THẬT + đường đọc report/gaps thay vì
 *      generic "tự làm trực tiếp".
 * Phong cách: source-scan (tiền lệ r124-r131).
 */

import { test, expect, describe } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const TMO = join(import.meta.dir, '..')
const read = (p: string) => readFileSync(join(TMO, p), 'utf-8')
const subagent = read('src/lib/subagent-delegate.ts')
const toolExecutor = read('src/lib/code-team/tool-executor.ts')

describe('r132 A — token_budget vào nhóm delivery-success (mirror iteration_limit)', () => {
  test('A1. success group gồm đủ 4 endedBy delivery + chốt bởi deliveredUsableResults', () => {
    expect(subagent).toContain("success: (state.endedBy === 'concluded' || state.endedBy === 'iteration_limit' || state.endedBy === 'stall_brake' || state.endedBy === 'token_budget') && deliveredUsableResults")
  })

  test('A2. deliveredUsableResults chặn success khi KHÔNG có gì trả về (0 tool + report rỗng)', () => {
    expect(subagent).toContain('const deliveredUsableResults = successfulToolCalls > 0 || report.trim().length > 0')
  })

  test('A3. timeout/error/cancelled KHÔNG nằm trong nhóm delivery-success (run không trọn vẹn giữ false)', () => {
    const m = subagent.match(/success: \(state\.endedBy === 'concluded'[\s\S]*?deliveredUsableResults,/)
    expect(m).toBeTruthy()
    expect(m![0]).not.toContain("'timeout'")
    expect(m![0]).not.toContain("'error'")
    expect(m![0]).not.toContain("'cancelled'")
  })
})

describe('r132 B — wrap-up grace nới (chống skip khi sub-agent có bằng chứng trong tay)', () => {
  test('B1. Grace +40% budget + bypass khi có evidence/lastContent', () => {
    expect(subagent).toContain('tokensUsed < SUBAGENT_TOKEN_BUDGET * 1.4')
    expect(subagent).toContain('|| evidence.length > 0')
    expect(subagent).toContain("|| !!(state.lastContent || '').trim()")
  })

  test('B2. Chuỗi grace đầy đủ: unlimited(0) → +5K (cũ) → +40% → evidence → lastContent', () => {
    expect(subagent).toContain('const wrapUpWorthIt = SUBAGENT_TOKEN_BUDGET === 0')
    expect(subagent).toContain('tokensUsed < SUBAGENT_TOKEN_BUDGET + 5_000')
  })

  test('B3. Guard cũ giữ: isCancelled + timedOut vẫn chặn wrap-up (không phá r60/CI-1)', () => {
    expect(subagent).toContain('if (needWrapUp && !isCancelled() && !timedOut && wrapUpWorthIt) {')
  })

  test('B4. needWrapUp đã gồm token_budget từ r60 — không hồi quy', () => {
    expect(subagent).toContain("state.endedBy === 'token_budget' || state.endedBy === 'timeout'")
  })
})

describe('r132 C — hint về parent nêu endedBy thật (bỏ generic)', () => {
  test('C1. Hint chứa endedBy + lỗi thật + chỉ đường đọc report/gaps rồi giao lại ĐÚNG phần còn thiếu', () => {
    expect(toolExecutor).toContain('`Delegate kết thúc bởi "${outcome.endedBy}"')
    expect(toolExecutor).toContain('xem "evaluation.gaps"')
  })

  test('C2. Generic cũ ĐÃ XÓA (chống hồi quy "tự làm trực tiếp" che endedBy)', () => {
    expect(toolExecutor).not.toContain("'Delegate thất bại — bạn có thể tự làm trực tiếp bằng tools của mình, hoặc delegate lại agent khác.'")
  })

  test('C3. Success vẫn KHÔNG hint (không nhiễu parent khi delivery đủ)', () => {
    expect(toolExecutor).toContain('hint: outcome.success')
  })
})
