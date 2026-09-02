/**
 * RESEARCH TEAM — RUBRIC B (TB-14 §2 — scorecard giải pháp 6 chiều)
 * ===================================================================
 * Spec: TB-14 §2 (Rubric B — Solution 6 dims) + §2.3 (scorecard kép) + §10 TC-16.
 *
 * 6 chiều đánh giá giải pháp (weights 25/15/20/10/20/10):
 *  S1 Coverage   (0.25) — bao phủ hết Success Criteria?
 *  S2 Impact     (0.15) — tác động đến metric root-cause?
 *  S3 Risk       (0.20) — rủi ro ảnh hưởng phụ (reversible / blast radius)?
 *  S4 Effort     (0.10) — chi phí thực hiện (LOC / giờ / deps mới)?
 *  S5 ContextFit (0.20) — khớp context mission (ma trận 8 chiều §5)?
 *  S6 Verify     (0.10) — đo lường được (có metric rõ)?
 *
 * Score = Σ(dim × weight) — mỗi dim 0–5, weight tổng 1.0 → score 0.0–5.0.
 *
 * Grade: ≥4.0 STRONG · 3.0–3.9 RECOMMENDED · 2.0–2.9 CONDITIONAL · <2.0 REJECTED.
 *
 * Scorecard kép (§2.3 — TC-16): pre-experiment (scoreExpected) và
 * post-experiment (scoreMeasured). computeScorecardDelta tính delta từng dim:
 *  - delta >1.0 → calibration lesson (KB category 'calibration').
 *  - delta S2 (Impact) >1.0 lặp 2 mission cùng HAN → anti-pattern 'optimism bias'.
 *
 * Fail-open: scoreRubricBWithLlm LLM error → REJECTED + warning. Pure
 * scoreRubricB + computeScorecardDelta KHÔNG gọi LLM/DB — testable standalone.
 */

import { callLLM } from '@/lib/llm'
import type { ScorecardB } from '../types'

// ============================================================
// §1. TYPES
// ============================================================

export type RubricBDimension = 'S1' | 'S2' | 'S3' | 'S4' | 'S5' | 'S6'

export interface RubricBInput {
  /** S1 Coverage (0–5) */
  s1_coverage: number
  /** S2 Impact (0–5) */
  s2_impact: number
  /** S3 Risk (0–5 — higher = safer/lower risk) */
  s3_risk: number
  /** S4 Effort (0–5 — higher = less effort) */
  s4_effort: number
  /** S5 ContextFit (0–5) */
  s5_contextFit: number
  /** S6 Verify (0–5) */
  s6_verify: number
}

export interface RubricBPerDim {
  score: number
  weight: number
  weighted: number
}

export interface CalibrationDelta {
  dimension: string
  expected: number
  measured: number
  /** delta = measured - expected (âm = đo thấp hơn kỳ vọng) */
  delta: number
  /** abs(delta) > 1.0 → flag calibration lesson */
  flag: boolean
  /** Ref đến KB lesson nếu có */
  lessonRef?: string
}

export interface RubricBResult extends ScorecardB {
  grade: 'STRONG' | 'RECOMMENDED' | 'CONDITIONAL' | 'REJECTED'
  perDimension: Record<RubricBDimension, RubricBPerDim>
  calibrationDelta?: CalibrationDelta[]
  warnings?: string[]
}

// ============================================================
// §2. WEIGHTS (SSOT — TB-14 §2.1 — 25/15/20/10/20/10)
// ============================================================

export const RUBRIC_B_WEIGHTS = {
  S1: 0.25, // Coverage
  S2: 0.15, // Impact
  S3: 0.20, // Risk
  S4: 0.10, // Effort
  S5: 0.20, // ContextFit
  S6: 0.10, // Verify
} as const

const _WEIGHT_SUM =
  RUBRIC_B_WEIGHTS.S1 +
  RUBRIC_B_WEIGHTS.S2 +
  RUBRIC_B_WEIGHTS.S3 +
  RUBRIC_B_WEIGHTS.S4 +
  RUBRIC_B_WEIGHTS.S5 +
  RUBRIC_B_WEIGHTS.S6
if (Math.abs(_WEIGHT_SUM - 1.0) > 0.001) {
  console.warn(`[RubricB] RUBRIC_B_WEIGHTS sum = ${_WEIGHT_SUM} (expected 1.0) — verify spec TB-14 §2.1`)
}

// ============================================================
// §3. CORE SCORING — pure function
// ============================================================

const SDIM_KEYS = ['S1', 'S2', 'S3', 'S4', 'S5', 'S6'] as const

function clampDim(n: number): number {
  if (typeof n !== 'number' || Number.isNaN(n)) return 0
  if (n < 0) return 0
  if (n > 5) return 5
  return n
}

export function scoreRubricB(input: RubricBInput): RubricBResult {
  const dims: Record<RubricBDimension, number> = {
    S1: clampDim(input.s1_coverage),
    S2: clampDim(input.s2_impact),
    S3: clampDim(input.s3_risk),
    S4: clampDim(input.s4_effort),
    S5: clampDim(input.s5_contextFit),
    S6: clampDim(input.s6_verify),
  }

  const perDimension = {} as Record<RubricBDimension, RubricBPerDim>
  let total = 0
  for (const k of SDIM_KEYS) {
    const s = dims[k]
    const w = RUBRIC_B_WEIGHTS[k]
    perDimension[k] = { score: s, weight: w, weighted: Number((s * w).toFixed(4)) }
    total += s * w
  }
  total = Number(total.toFixed(4))

  let grade: RubricBResult['grade']
  if (total >= 4.0) grade = 'STRONG'
  else if (total >= 3.0) grade = 'RECOMMENDED'
  else if (total >= 2.0) grade = 'CONDITIONAL'
  else grade = 'REJECTED'

  return {
    dimensions: dims as unknown as Record<string, number>,
    total,
    grade,
    perDimension,
  }
}

// ============================================================
// §4. TC-16 — CALIBRATION DELTA (scorecard kép)
// ============================================================

/**
 * TC-16 (TB-14 §2.3 + §10): tính delta giữa scoreExpected (pre-experiment) và
 * scoreMeasured (post-experiment). Mỗi dim có abs(delta) > 1.0 → flag calibration
 * lesson (KB category 'calibration').
 *
 * Anti-pattern (§2.3 + §10): delta S2 (Impact) > 1.0 lặp 2 mission cùng HAN →
 * 'optimism bias' warning (HAN dự đoán impact quá cao lặp lại).
 *
 * Trả:
 *  - deltas[]: chi tiết từng dim (kèm flag + lessonRef nếu có)
 *  - lessons[]: list lesson refs để ghi KB (caller persist ResearchKBEntry)
 */
export function computeScorecardDelta(
  expected: RubricBResult,
  measured: RubricBResult,
): { deltas: CalibrationDelta[]; lessons: string[] } {
  const deltas: CalibrationDelta[] = []
  const lessons: string[] = []

  for (const k of SDIM_KEYS) {
    const e = expected.perDimension[k]?.score ?? 0
    const m = measured.perDimension[k]?.score ?? 0
    const delta = Number((m - e).toFixed(4))
    const flag = Math.abs(delta) > 1.0
    const entry: CalibrationDelta = {
      dimension: k,
      expected: e,
      measured: m,
      delta,
      flag,
    }
    if (flag) {
      const lessonRef = `KB-CAL-${k}-${Date.now()}`
      entry.lessonRef = lessonRef
      lessons.push(lessonRef)
    }
    deltas.push(entry)
  }

  // Anti-pattern optimism bias — S2 lặp (caller check cross-mission; ở đây
  // chỉ emit warning khi |delta S2| > 1.0 — cross-mission tracking là việc
  // của KING layer P5 khi tổng hợp KB search).
  const s2Delta = deltas.find((d) => d.dimension === 'S2')
  if (s2Delta && s2Delta.flag && s2Delta.delta < -1.0) {
    lessons.push(`KB-ANTIPATTERN-optimism-bias-S2-${Date.now()}`)
  }

  return { deltas, lessons }
}

// ============================================================
// §5. LLM-ASSISTED SCORING — fail-open
// ============================================================

const RUBRIC_B_SYSTEM_PROMPT = [
  'Bạn là utility extraction core chấm Rubric B cho solution option research team TMO.',
  '',
  'RUBRIC B — 6 CHIỀU ĐÁNH GIÁ GIẢI PHÁP (TB-14 §2.1):',
  '- S1 Coverage   (0.25): bao phủ hết Success Criteria?',
  '- S2 Impact     (0.15): tác động đến metric root-cause?',
  '- S3 Risk       (0.20): rủi ro ảnh hưởng phụ? (5 = rủi ro thấp, an toàn)',
  '- S4 Effort     (0.10): chi phí thực hiện? (5 = ít effort)',
  '- S5 ContextFit (0.20): khớp context mission?',
  '- S6 Verify     (0.10): đo lường được (metric rõ)?',
  '',
  'Mỗi dim điểm 0–5 (số thực, 1 chữ số thập phân).',
  'OUTPUT JSON-DUY-NAHAT, không markdown fence, không giải thích:',
  '{"s1_coverage":<0-5>,"s2_impact":<0-5>,"s3_risk":<0-5>,"s4_effort":<0-5>,"s5_contextFit":<0-5>,"s6_verify":<0-5>}',
].join('\n')

function parseRubricBJson(content: string): RubricBInput | null {
  if (!content || content.trim().length === 0) return null
  try {
    const obj = JSON.parse(content)
    if (obj && typeof obj.s1_coverage === 'number') return obj
  } catch {
    /* fallthrough */
  }
  const fenceMatch = content.match(/```(?:json)?\s*([\s\S]*?)\s*```/)
  if (fenceMatch) {
    try {
      const obj = JSON.parse(fenceMatch[1])
      if (obj && typeof obj.s1_coverage === 'number') return obj
    } catch {
      /* fallthrough */
    }
  }
  const firstObj = content.match(/\{[\s\S]*\}/)
  if (firstObj) {
    try {
      const obj = JSON.parse(firstObj[0])
      if (obj && typeof obj.s1_coverage === 'number') return obj
    } catch {
      /* fallthrough */
    }
  }
  return null
}

export async function scoreRubricBWithLlm(
  optionSpec: string,
  successCriteria: string[],
  contextFitScore: number,
): Promise<RubricBResult> {
  const prompt = [
    `OPTION SPEC: ${optionSpec}`,
    `SUCCESS CRITERIA:`,
    ...(successCriteria.length > 0 ? successCriteria.map((c, i) => `[${i + 1}] ${c}`) : ['(none)']),
    `CONTEXT-FIT SCORE (0-5): ${contextFitScore}`,
    '',
    'Chấm 6 dim theo Rubric B — output JSON duy nhất.',
  ].join('\n')

  let result
  try {
    result = await callLLM(prompt, RUBRIC_B_SYSTEM_PROMPT, 'rubric-b-score', { temperature: 0.2, maxTokens: 800 })
  } catch (err) {
    console.warn(
      '[RubricB] callLLM threw (non-blocking — fail-open):',
      err instanceof Error ? err.message : String(err),
    )
    return failOpenRubricB('LLM call threw')
  }

  if (result.error || !result.content || result.content.trim().length === 0) {
    console.warn('[RubricB] LLM error/empty content — fail-open:', result.error ?? 'empty content')
    return failOpenRubricB(result.error ?? 'LLM unavailable')
  }

  const parsed = parseRubricBJson(result.content)
  if (!parsed) {
    console.warn('[RubricB] JSON parse fail — fail-open. Raw (first 200 chars):', result.content.slice(0, 200))
    return failOpenRubricB('LLM output unparseable')
  }

  return scoreRubricB(parsed)
}

function failOpenRubricB(reason: string): RubricBResult {
  const scored = scoreRubricB({
    s1_coverage: 0,
    s2_impact: 0,
    s3_risk: 0,
    s4_effort: 0,
    s5_contextFit: 0,
    s6_verify: 0,
  })
  return {
    ...scored,
    grade: 'REJECTED',
    warnings: [`LLM unavailable — ${reason}`],
  }
}
