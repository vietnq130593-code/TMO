/**
 * r134 — F3 VERDICT BUDGET ×6 + STRIP REASONING + ANTI-STARVATION (OBS P3)
 * =====================================================================================
 * User duyệt fix F1-F6 theo biên bản quan sát OBSERVE-PROTOCOL-1 (FINAL)
 * 2026-10-20. F3 (P1): trọng tài/consult trả JSON verdict NULL dù call ✓ —
 * 2 biến thể:
 *   (a) Budget reasoning quá nhỏ: 1.200→4.800 VẪN cạn ("reasoning 15K chars
 *       chưa kịp viết trả lời"); consult Omega tính verdictBudget theo model
 *       CẤU HÌNH (brain=nemotron → 1.100) nhưng softmax re-pick glm-5.3
 *       (reasoning) → 1.100→2.200 (R25 retry ×2) vẫn cụt — MISMATCH budget
 *       theo model cấu hình vs model thực phục vụ.
 *   (b) Reasoning lồng trong content quanh JSON → findBalancedJson nhặt
 *       nhầm vùng mở (nháp JSON trong khối think có '"complete"' TRƯỚC JSON
 *       thật → nháp thắng → verdict SAI, tệ hơn null).
 *
 * Fix: (1) verdictBudget multiplier 4× → 6× (r103 PIN UPDATE); (2) guard
 * anti-starvation tại tầng phục vụ llm.ts (model reasoning + maxTokens nhỏ
 * → nâng sàn 6.000); (3) stripReasoningBlocks cắt khối think/reasoning đóng
 * trước parse — áp cho cả 3 parser (goal-loop / delegation / omega).
 * Unit thật (verdictBudget + stripReasoningBlocks + parseEvalVerdict đều
 * export) + source-scan cho guard.
 */

import { test, expect, describe } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { verdictBudget } from '@/lib/llm'
import { stripReasoningBlocks } from '@/lib/code-team/find-balanced-json'
import { parseEvalVerdict } from '@/lib/agent-goal-loop'

const TMO = join(import.meta.dir, '..')
const read = (p: string) => readFileSync(join(TMO, p), 'utf-8')
const llm = read('src/lib/llm.ts')
const omega = read('src/lib/omega-orchestrator.ts')
const delegationEvaluator = read('src/lib/delegation-evaluator.ts')

describe('r134 A — verdictBudget reasoning 6× (PIN UPDATE từ r103 ×4)', () => {
  test('A1. Reasoning model → 6× base: delegation 1200 → 7200; evaluator 2000 → 12000', () => {
    expect(verdictBudget('z-ai/glm-5.3-flash', 1200)).toBe(7200)
    expect(verdictBudget('z-ai/glm-5.3', 2000)).toBe(12000)
  })

  test('A2. Model thường → base nguyên (không đổi hành vi)', () => {
    expect(verdictBudget('nvidia/nemotron-3-ultra-550b-a55b', 1200)).toBe(1200)
    expect(verdictBudget(null, 1200)).toBe(1200)
  })

  test('A3. Override dương thắng multiplier (consult 1100 → 6000)', () => {
    expect(verdictBudget('z-ai/glm-5.3-flash', 1100, 6000)).toBe(6000)
  })

  test('A4. Guard cũ giữ: override 0 bị bỏ (rơi 6× = 6600); NaN → 0', () => {
    expect(verdictBudget('z-ai/glm-5.3-flash', 1100, 0)).toBe(6600)
    expect(verdictBudget('z-ai/glm-5.3-flash', Number.NaN)).toBe(0)
  })
})

describe('r134 B — anti-starvation mismatch budget tại tầng phục vụ (llm.ts)', () => {
  test('B1. Sàn NIM_REASONING_MIN_OUTPUT_TOKENS mặc định 6000 (env override, floor 1000)', () => {
    expect(llm).toContain("parseInt(process.env.NIM_REASONING_MIN_OUTPUT_TOKENS || '6000', 10) || 6_000")
  })

  test('B2. Guard: model phục vụ là reasoning + maxTokens dương nhỏ hơn sàn → nâng + log anti-starvation', () => {
    expect(llm).toContain('isReasoningModel(nimModel) && options?.maxTokens && options.maxTokens > 0 && options.maxTokens < NIM_REASONING_MIN_OUTPUT_TOKENS')
    expect(llm).toContain('anti-starvation (F3)')
  })

  test('B3. Call dùng nimOptions đã nâng (không phải options gốc) — Q feedback vẫn ghi', () => {
    expect(llm).toContain('nimOptions,')
    expect(llm).toContain('{ taskLabel: `agent-nim:${nimModel}` }')
  })

  test('B4. Consult Omega override nâng 4000 → 6000', () => {
    expect(omega).toContain('verdictBudget(brain.model, CONSULT_MAX_TOKENS, 6_000)')
  })
})

describe('r134 C — stripReasoningBlocks (pure) + 3 parser áp dụng', () => {
  test('C1. Khối think đóng bị cắt; JSON phía sau GIỮ NGUYÊN', () => {
    const raw = 'phân tích... {"complete": true, "confidence": 0.9}'
    const out = stripReasoningBlocks(raw)
    expect(out).not.toContain('suy luận rác')
    expect(out).toContain('{"complete": true, "confidence": 0.9}')
  })

  test('C2. Khối <reasoning> đóng bị cắt; text không khối reasoning → nguyên vẹn', () => {
    // Bài học r134 (fixbug đợt F1-F6 vòng R1): tag literal trong chuỗi test bị
    // layer ghi file ĂN MẤT (bản trước input mất cặp tag reasoning → so sánh
    // 2 chuỗi khác nhau vô nghĩa → FAIL 2 test) — dựng tag bằng nối chuỗi,
    // miễn nhiễm mọi layer ăn tag.
    const RAO = '<' + 'reasoning' + '>'
    const RAC = '<' + '/reasoning' + '>'
    expect(stripReasoningBlocks(RAO + 'bỏ đoạn suy luận' + RAC + 'đánh giá{"pass": true}')).toBe('đánh giá{"pass": true}')
    expect(stripReasoningBlocks('thường {"complete": false}')).toBe('thường {"complete": false}')
    expect(stripReasoningBlocks('')).toBe('')
  })

  test('C3. parseEvalVerdict: nháp JSON "complete" trong khối think bị cắt — verdict ĐÚNG thay vì nháp (bản trước: nháp đứng TRƯỚC thắng → verdict sai)', () => {
    // Dựng tag bằng nối chuỗi — miễn nhiễm layer ăn tag (xem C2)
    const THO = '<' + 'think' + '>'
    const THC = '<' + '/think' + '>'
    const raw = THO + 'nháp thử xem: {"complete": false, "confidence": 0.2} suy luận chưa chốt' + THC + ' chốt cuối cùng: {"complete": true, "confidence": 0.9, "verified": true}'
    const v = parseEvalVerdict(raw)
    expect(v).toBeTruthy()
    expect(v!.complete).toBe(true)
    expect(v!.confidence).toBe(0.9)
    expect(v!.verified).toBe(true)
  })

  test('C4. parseEvalVerdict JSON sạch (không think) vẫn parse như cũ — không hồi quy', () => {
    const v = parseEvalVerdict('{"complete": false, "confidence": 0.25, "missing": ["thiếu A"]}')
    expect(v).toBeTruthy()
    expect(v!.complete).toBe(false)
    expect(v!.missing).toContain('thiếu A')
  })

  test('C5. Cả 3 parser đều gọi stripReasoningBlocks (goal-loop + delegation + omega)', () => {
    expect(read('src/lib/agent-goal-loop.ts')).toContain("stripReasoningBlocks(raw.replace(/```(?:json)?/g, ''))")
    expect(delegationEvaluator).toContain("stripReasoningBlocks(raw.replace(/```(?:json)?/g, ''))")
    expect(omega).toContain("stripReasoningBlocks(result.content.replace(/```(?:json)?/g, ''))")
  })
})
