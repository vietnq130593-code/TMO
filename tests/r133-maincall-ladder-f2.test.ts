/**
 * r133 — F2 MAIN-CALL LADDER "explicit-but-blocked" (OBS P2)
 * =====================================================================================
 * User duyệt fix F1-F6 theo biên bản quan sát OBSERVE-PROTOCOL-1 (FINAL)
 * 2026-10-20. F2 (P0/P2): goal-loop main call pin model job
 * (explicitModelChoice) bị circuit-breaker block / hang NIM → callLLMForAgent
 * fail-fast R19 (0 bytes) → "chu kỳ N kết thúc (error, 0 tool calls)" — chu kỳ
 * bị ĐỐT TRẮNG (bằng chứng job Omega cmvghpzbv…kn6dj1: chu kỳ 2-3 mất trắng
 * khi glm-5.3-flash breaker mở; evaluator S3.2 + final-report S3.3 đều CÓ
 * ladder, RIÊNG main call thì không).
 *
 * Fix: ladder 1 lần tại main call (mirror S3.2/S3.3) — attempt 1 = model job
 * (explicit — indicator honesty); fail (throw/error-result) → attempt 2 =
 * model khoẻ KHÁC HỌ (nemotron-550b / deepseek-v4.1-flash khi agent là
 * nemotron). result.model luôn là model THỰC phục vụ.
 * Phong cách: source-scan (tiền lệ r124-r131).
 */

import { test, expect, describe } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const TMO = join(import.meta.dir, '..')
const read = (p: string) => readFileSync(join(TMO, p), 'utf-8')
const goalLoop = read('src/lib/agent-goal-loop.ts')
const llm = read('src/lib/llm.ts')

describe('r133 A — ladder tại main call mỗi chu kỳ (mirror S3.2/S3.3)', () => {
  test('A1. attemptMainCall gói callLLMForAgent — giữ nguyên heartbeat + timeout chu kỳ', () => {
    expect(goalLoop).toContain('const attemptMainCall = (provider: string, model: string) => runWithBatchHeartbeat(() => withTimeout(')
    expect(goalLoop).toContain('`Agent LLM (chu kỳ ${cycle})`')
  })

  test('A2. Ladder model khoẻ KHÁC HỌ — mirror công thức S3.2 evaluator', () => {
    expect(goalLoop).toContain('const mainCallLadderModel = agentModel === NEMOTRON_550B_NIM_ID ? DEEPSEEK_V41_FLASH_NIM_ID : NEMOTRON_550B_NIM_ID')
  })

  test('A3. Error-result (breaker mở = fail-fast 0 bytes) → 1 ladder retry, log explicit-but-blocked', () => {
    expect(goalLoop).toContain('F2 ladder explicit-but-blocked')
    expect(goalLoop).toContain("const ladderResult = await attemptMainCall('nvidia', mainCallLadderModel)")
  })

  test('A4. Throw (timeout-hang) → 1 ladder retry TRƯỚC khi tuyên error chu kỳ', () => {
    expect(goalLoop).toContain('F2 ladder thử model khoẻ')
    expect(goalLoop).toContain('mainCallUsable(result)')
  })

  test('A5. Ladder fail → error path gốc giữ nguyên (lastLlmError + cycleHadLlmError + endedBy error)', () => {
    expect(goalLoop).toContain('cycleHadLlmError = true')
    expect(goalLoop).toContain("endedBy = 'error'")
  })

  test('A6. Ladder chỉ chạy khi provider nvidia + chưa cancel (2 guard: nhánh result + nhánh throw)', () => {
    const n = (goalLoop.match(/agentProvider === 'nvidia' && !isCancelled\(\)/g) || []).length
    expect(n).toBeGreaterThanOrEqual(2)
  })

  test('A7. mainCallUsable công nhận partial (executed_tool_calls) — không phá PARTIAL-ON-TIMEOUT TASK 20', () => {
    expect(goalLoop).toContain('r.executed_tool_calls && r.executed_tool_calls.length > 0')
  })
})

describe('r133 B — không phá chỉ-thị-không-nói-dối (indicator honesty)', () => {
  test('B1. attemptMainCall vẫn đánh dấu explicitModelChoice (softmax không re-pick model job)', () => {
    const i = goalLoop.indexOf('const attemptMainCall')
    expect(i).toBeGreaterThan(0)
    const slice = goalLoop.slice(i, i + 2200)
    expect(slice).toContain('explicitModelChoice: true')
  })

  test('B2. result.model vẫn là model THỰC phục vụ — credit assignment W2 giữ nguyên', () => {
    expect(goalLoop).toContain('modelsUsedThisRun.set(result.model,')
  })

  test('B3. llm.ts KHÔNG thêm fallback ngầm trong callLLMForAgent (ladder nằm ở caller — tường minh + log)', () => {
    expect(llm).toContain('KHÔNG fallback (R19)')
  })
})
