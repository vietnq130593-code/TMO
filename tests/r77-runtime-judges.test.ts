/**
 * ROUND-77 TESTS — P3-M3 3-JUDGE MEDIAN VÀO RUNTIME CHO PHÁN QUYẾT CRITICAL
 * (BLUEPRINT-STATS-LEARNING-P0-P6 §P3-M3, mục #11 — ML.pdf §Random Forest +
 * §GPT-4 as Judge)
 *
 * Đo lường:
 *   A. parseRuntimeJudgesMode — off mặc định/undefined/giá trị lạ; critical
 *      (kể cả 'on'); all ('1'/'true'/'ALL').
 *   B. isCriticalRuntimeJudgeRun — đủ 2 trục điều kiện (complete ∧ (tools≥20
 *      ∨ cycle ≥ 0.8·max)); tính tay 0.8×4=3.2 → cycle 4 là critical, cycle 3
 *      không (∞ mode chỉ trục tool).
 *   C. evaluateRuntimeJudgeGate (judge inject — KHÔNG đụng LLM thật):
 *      - 2/3 judge chấm fail (median 0.33 < 0.5) → verdict bị hạ đúng 1 lần,
 *        rootCause có tag '[3judge-downgrade]', forcedDowngrade语义 qua
 *        downgraded=true;
 *      - judge lỗi HẾT (throw) → verdict gốc GIỮ NGUYÊN (fail-open);
 *      - all-fail theo semantics judges.ts (median 0.5 neutral) → KHÔNG hạ;
 *      - mode off → không gọi judge; alreadyFired → không gọi (tối đa 1/run);
 *      - mode critical + run KHÔNG critical → không gọi;
 *      - median ≥ 0.5 → giữ nguyên verdict (kể cả complete);
 *      - median < 0.5 NHƯNG verdict đã incomplete → KHÔNG đổi gì (chỉ hạ
 *        complete→false, không nâng chiều ngược lại);
 *      - contextSummary có goal + verdict + evidence (prompt đầy đủ).
 *   D. RUNTIME_JUDGE_CRITERIA — 5 tiêu chí lõi đúng nội dung spec
 *      (evidence-verified/E2E-passed/todo-closed/no-derived-number/debt-ready).
 *
 * Nguyên tắc: judgeFn inject — đúng điểm cắm production (goal-loop truyền
 * runtimeJudgeVerdict mặc định) nhưng test không đốt LLM thật; không DB.
 */

import { describe, test, expect } from 'bun:test'
import {
  parseRuntimeJudgesMode,
  isCriticalRuntimeJudgeRun,
  evaluateRuntimeJudgeGate,
  RUNTIME_JUDGE_CRITERIA,
  type RuntimeJudgeGateInput,
} from '@/lib/agent-goal-loop'
import { RUNTIME_JUDGE_TIMEOUT_MS } from '@/lib/eval/judges'
import type { EvalVerdict } from '@/lib/agent-goal-loop'

/** Verdict complete chuẩn của evaluator */
function completeVerdict(): EvalVerdict {
  return {
    complete: true,
    confidence: 0.9,
    verified: true,
    missing: [],
    rootCause: '',
    nextPlan: [],
    sideIssues: [],
    debtDecision: 'none',
    debtReadiness: 'ready',
    debtBlockedReason: '',
    needsInput: false,
    raw: '{"complete": true}',
  }
}

function incompleteVerdict(): EvalVerdict {
  return { ...completeVerdict(), complete: false, confidence: 0.3, verified: false }
}

/** Input chuẩn: run critical (complete + 25 tools), mode critical */
function criticalInput(overrides?: Partial<RuntimeJudgeGateInput>): RuntimeJudgeGateInput {
  return {
    mode: 'critical',
    verdict: completeVerdict(),
    runToolCalls: 25,
    cycle: 2,
    effectiveMaxCycles: 4,
    alreadyFired: false,
    goal: 'Nâng cấp module X với tiêu chí nghiệm thu Y',
    evidence: [
      { kind: 'tool', tool: 'run_tests', success: true, text: '722/722 pass' },
      { kind: 'tool', tool: 'file_read', success: true, text: 'đọc src/lib/db' },
    ],
    ...overrides,
  }
}

// ==================== A. parseRuntimeJudgesMode ====================

describe('r77 · P3-M3 parseRuntimeJudgesMode — env RUNTIME_JUDGES', () => {
  test('mặc định OFF: undefined/rỗng/giá trị lạ → off (hành vi cũ 100%)', () => {
    expect(parseRuntimeJudgesMode(undefined)).toBe('off')
    expect(parseRuntimeJudgesMode('')).toBe('off')
    expect(parseRuntimeJudgesMode('off')).toBe('off')
    expect(parseRuntimeJudgesMode('0')).toBe('off')
    expect(parseRuntimeJudgesMode('false')).toBe('off')
    expect(parseRuntimeJudgesMode('giá-trị-lạ')).toBe('off')
  })

  test('critical: "critical"/"on" (on đọc bảo thủ) — case-insensitive', () => {
    expect(parseRuntimeJudgesMode('critical')).toBe('critical')
    expect(parseRuntimeJudgesMode('on')).toBe('critical')
    expect(parseRuntimeJudgesMode('CRITICAL')).toBe('critical')
  })

  test('all: "all"/"1"/"true"', () => {
    expect(parseRuntimeJudgesMode('all')).toBe('all')
    expect(parseRuntimeJudgesMode('1')).toBe('all')
    expect(parseRuntimeJudgesMode('true')).toBe('all')
    expect(parseRuntimeJudgesMode('ALL')).toBe('all')
  })
})

// ==================== B. isCriticalRuntimeJudgeRun ====================

describe('r77 · P3-M3 isCriticalRuntimeJudgeRun — lớp run đắt tiền', () => {
  test('complete ∧ toolCalls ≥ 20 → critical (kể cả cycle sớm)', () => {
    expect(isCriticalRuntimeJudgeRun({ verdictComplete: true, runToolCalls: 20, cycle: 1, effectiveMaxCycles: 10 })).toBe(true)
    expect(isCriticalRuntimeJudgeRun({ verdictComplete: true, runToolCalls: 99, cycle: 1, effectiveMaxCycles: 4 })).toBe(true)
  })

  test('complete ∧ cycle ≥ 0.8·max → critical (tính tay: 0.8×4 = 3.2 → cycle 4 đạt)', () => {
    expect(isCriticalRuntimeJudgeRun({ verdictComplete: true, runToolCalls: 3, cycle: 4, effectiveMaxCycles: 4 })).toBe(true)
    expect(isCriticalRuntimeJudgeRun({ verdictComplete: true, runToolCalls: 3, cycle: 3, effectiveMaxCycles: 4 })).toBe(false) // 3 < 3.2
    expect(isCriticalRuntimeJudgeRun({ verdictComplete: true, runToolCalls: 3, cycle: 8, effectiveMaxCycles: 10 })).toBe(true) // 8 ≥ 8.0
  })

  test('incomplete → KHÔNG critical (stopReason dự kiến ≠ complete)', () => {
    expect(isCriticalRuntimeJudgeRun({ verdictComplete: false, runToolCalls: 50, cycle: 4, effectiveMaxCycles: 4 })).toBe(false)
  })

  test('mode ∞ (max=0) → chỉ trục toolCalls còn hiệu lực', () => {
    expect(isCriticalRuntimeJudgeRun({ verdictComplete: true, runToolCalls: 500, cycle: 100, effectiveMaxCycles: 0 })).toBe(true)
    expect(isCriticalRuntimeJudgeRun({ verdictComplete: true, runToolCalls: 5, cycle: 100, effectiveMaxCycles: 0 })).toBe(false)
  })
})

// ==================== C. evaluateRuntimeJudgeGate ====================

describe('r77 · P3-M3 evaluateRuntimeJudgeGate — hạ cấp verdict runtime', () => {
  test('BLUEPRINT: 2/3 judge chấm fail (median 0.33) → hạ complete→false + tag [3judge-downgrade]', async () => {
    let called = 0
    const res = await evaluateRuntimeJudgeGate(criticalInput({
      judgeFn: async (ctx, crit) => {
        called++
        expect(ctx).toContain('Nâng cấp module X') // context có goal
        expect(ctx).toContain('complete=true') // có verdict evaluator
        expect(ctx).toContain('run_tests') // có evidence
        expect(crit).toHaveLength(5) // 5 tiêu chí lõi
        return { median: 0.33, scores: [0.2, 0.0, 0.8] } // 2/3 fail
      },
    }))
    expect(called).toBe(1)
    expect(res.fired).toBe(true)
    expect(res.downgraded).toBe(true)
    expect(res.verdict.complete).toBe(false)
    expect(res.verdict.verified).toBe(false)
    expect(res.verdict.rootCause).toContain('[3judge-downgrade: median=0.33')
    expect(res.verdict.missing.some(m => m.includes('3-judge runtime gate'))).toBe(true)
    // confidence GIỮ NGUYÊN 0.9 — scorecard đo evaluator nói gì vs thực tế
    expect(res.verdict.confidence).toBe(0.9)
  })

  test('đúng 1 LẦN/run: alreadyFired → KHÔNG gọi judge thêm', async () => {
    let called = 0
    const res = await evaluateRuntimeJudgeGate(criticalInput({
      alreadyFired: true,
      judgeFn: async () => { called++; return { median: 0, scores: [0, 0, 0] } },
    }))
    expect(called).toBe(0)
    expect(res.fired).toBe(false)
    expect(res.downgraded).toBe(false)
    expect(res.verdict.complete).toBe(true) // nguyên vẹn
  })

  test('mode off → KHÔNG gọi judge (default production = hành vi cũ)', async () => {
    let called = 0
    const res = await evaluateRuntimeJudgeGate(criticalInput({
      mode: 'off',
      judgeFn: async () => { called++; return { median: 0, scores: [0, 0, 0] } },
    }))
    expect(called).toBe(0)
    expect(res.fired).toBe(false)
    expect(res.verdict.complete).toBe(true)
  })

  test('mode critical + run KHÔNG critical (incomplete, ít tool) → không gọi', async () => {
    let called = 0
    const res = await evaluateRuntimeJudgeGate(criticalInput({
      mode: 'critical',
      verdict: incompleteVerdict(),
      runToolCalls: 5,
      cycle: 1,
      effectiveMaxCycles: 4,
      judgeFn: async () => { called++; return { median: 0, scores: [0, 0, 0] } },
    }))
    expect(called).toBe(0)
    expect(res.fired).toBe(false)
  })

  test('mode critical + run critical NHƯNG verdict incomplete → không gọi (điều kiện verdictComplete)', async () => {
    let called = 0
    const res = await evaluateRuntimeJudgeGate(criticalInput({
      mode: 'critical',
      verdict: incompleteVerdict(),
      runToolCalls: 30, // đủ trục tool
      judgeFn: async () => { called++; return { median: 0, scores: [0, 0, 0] } },
    }))
    expect(called).toBe(0)
    expect(res.fired).toBe(false)
  })

  test('mode ALL + verdict incomplete → VẪN gọi (quan sát) nhưng KHÔNG hạ chiều ngược', async () => {
    let called = 0
    const res = await evaluateRuntimeJudgeGate(criticalInput({
      mode: 'all',
      verdict: incompleteVerdict(),
      judgeFn: async () => { called++; return { median: 0.1, scores: [0, 0, 0.3] } },
    }))
    expect(called).toBe(1)
    expect(res.fired).toBe(true)
    expect(res.downgraded).toBe(false) // đã incomplete — không có gì để hạ
    expect(res.verdict.complete).toBe(false)
  })

  test('median ≥ 0.5 → giữ nguyên verdict complete', async () => {
    const res = await evaluateRuntimeJudgeGate(criticalInput({
      judgeFn: async () => ({ median: 0.67, scores: [0.6, 0.7, 0.7] }),
    }))
    expect(res.fired).toBe(true)
    expect(res.downgraded).toBe(false)
    expect(res.verdict.complete).toBe(true)
    expect(res.median).toBe(0.67)
  })

  test('BIÊN: median đúng 0.5 → KHÔNG hạ (ngưỡng < 0.5 ngặt)', async () => {
    const res = await evaluateRuntimeJudgeGate(criticalInput({
      judgeFn: async () => ({ median: 0.5, scores: [0.5, 0.5, 0.5] }),
    }))
    expect(res.downgraded).toBe(false)
    expect(res.verdict.complete).toBe(true)
  })

  test('BLUEPRINT: judge lỗi HẾT (throw) → verdict gốc GIỮ NGUYÊN (fail-open)', async () => {
    const res = await evaluateRuntimeJudgeGate(criticalInput({
      judgeFn: async () => { throw new Error('kimi-k3 429 + SBF chết') },
    }))
    expect(res.fired).toBe(true) // đã thử — đốt lượt
    expect(res.downgraded).toBe(false)
    expect(res.verdict.complete).toBe(true) // nguyên vẹn
    expect(res.median).toBeNull()
  })

  test('BLUEPRINT: all-fail theo semantics judges.ts (median 0.5 neutral) → KHÔNG hạ', async () => {
    // judges.ts: toàn bộ judge fail → scores [-1,-1,-1] → median 0.5 neutral
    const res = await evaluateRuntimeJudgeGate(criticalInput({
      judgeFn: async () => ({ median: 0.5, scores: [-1, -1, -1] }),
    }))
    expect(res.fired).toBe(true)
    expect(res.downgraded).toBe(false)
    expect(res.verdict.complete).toBe(true)
  })

  test('rootCause gốc dài → tag vẫn nằm trong cap 400 ký tự', async () => {
    const res = await evaluateRuntimeJudgeGate(criticalInput({
      verdict: { ...completeVerdict(), rootCause: 'R'.repeat(390) },
      judgeFn: async () => ({ median: 0.0, scores: [0, 0, 0] }),
    }))
    expect(res.verdict.rootCause.length).toBeLessThanOrEqual(400)
    expect(res.verdict.rootCause).toContain('[3judge-downgrade')
  })
})

// ==================== D. Tiêu chí + timeout config ====================

describe('r77 · P3-M3 RUNTIME_JUDGE_CRITERIA + timeout guard', () => {
  test('5 tiêu chí lõi đúng tên spec §P3-M3', () => {
    expect(RUNTIME_JUDGE_CRITERIA).toHaveLength(5)
    const joined = RUNTIME_JUDGE_CRITERIA.join(' ')
    expect(joined).toContain('evidence-verified')
    expect(joined).toContain('E2E-passed')
    expect(joined).toContain('todo-closed')
    expect(joined).toContain('no-derived-number')
    expect(joined).toContain('debt-ready')
  })

  test('timeout default 600s bám directive kimi-k3 chậm-hợp-lệ ( KHÔNG 30s blueprint)', () => {
    // User directive 2026-12-01 override blueprint 30s — kimi-k3 thường
    // ~120s/call; 30s sẽ giết oan toàn bộ judge. Floor 5s cho test/env.
    expect(RUNTIME_JUDGE_TIMEOUT_MS).toBe(600_000)
    expect(RUNTIME_JUDGE_TIMEOUT_MS).toBeGreaterThan(120_000)
  })
})
