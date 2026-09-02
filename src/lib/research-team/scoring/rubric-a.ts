/**
 * RESEARCH TEAM — RUBRIC A (TB-14 §1 — chẩn đoán giả thuyết 5 chiều)
 * ===================================================================
 * Spec: TB-14 §1 (Rubric A — Diagnosis 5 dims) + §1.3 anti-gaming (AC3/AC5)
 *       + §3 vòng 2 (SCORE-A) + §10 TC-15 (kill-criteria mandatory for CONFIRMED).
 *
 * 5 chiều chẩn đoán giả thuyết (Z2.1 — weights 30/25/15/15/15):
 *  D1 Evidence   (0.30) — có bằng chứng cụ thể (file:line / log / metric)?
 *  D2 Causal     (0.25) — giải thích cơ-nếu-thì, KHÔNG chỉ tương quan?
 *  D3 Consistent (0.15) — nhất trí với dữ liệu / KB / quan sát khác?
 *  D4 Reproducible (0.15) — chạy lại ra cùng kết quả? (do 2 SA BLIND chấm — §1.3 AC5,
 *                  KHÔNG do SIVIL tự chấm — anti self-praise)
 *  D5 Depth      (0.15) — đào sâu tận root-cause, không dừng triệu chứng?
 *
 * Score = Σ(dim × weight) — mỗi dim 0–5, weight tổng 1.0 → score 0.0–5.0.
 *
 * Anti-gaming (§1.3 AC3): mọi dim ≥3 PHẢI có artifact trong artifacts[] —
 * thiếu → dim tự về 1 + anchorWarning. Cấm cộng dồn chứng cứ trùng (cùng
 * file:line cho 2 dim) → anchorWarning (heuristic check duplicate ref).
 *
 * Grade: ≥4.0 CONFIRMED · 3.0–3.9 PROBABLE · <3.0 WEAK.
 *
 * TC-15 (TB-14 §10 + §3 vòng 3): CONFIRMED bắt buộc killCriteria — thiếu →
 * tối đa PROBABLE (KHÔNG CONFIRMED). needsKillCriteria() trả true nếu cần.
 *
 * Fail-open: scoreRubricAWithLlm LLM error → trả WEAK + warning 'LLM unavailable'.
 * Pure scoreRubricA KHÔNG gọi LLM/DB — testable standalone.
 */

import { callUtilityLLM } from '@/lib/llm'
import type { ScoreAResult } from '../types'

// ============================================================
// §1. TYPES
// ============================================================

export type RubricADimension = 'D1' | 'D2' | 'D3' | 'D4' | 'D5'

export interface RubricArtifactRef {
  dimension: RubricADimension
  /** ref đến evidence — file:line / log-excerpt-id / metric-id / kb-id */
  ref: string
}

export interface RubricAInput {
  /** D1 Evidence (0–5) */
  d1_evidence: number
  /** D2 Causal (0–5) */
  d2_causal: number
  /** D3 Consistent (0–5) */
  d3_consistent: number
  /** D4 Reproducible (0–5) — thường do blind SA chấm, KHÔNG tự chấm */
  d4_reproducible: number
  /** D5 Depth (0–5) */
  d5_depth: number
  /** Artifacts anchoring từng dim (anti-gaming — TB-14 §1.3 AC3) */
  artifacts?: RubricArtifactRef[]
  /** 2 SA blind chấm D4 (§1.3 AC5) — nếu provided → D4 = avg(sa1, sa2) override input */
  blindSas?: { sa1: number; sa2: number }
}

export interface RubricAPerDimension {
  D1: { score: number; weight: number; weighted: number; artifact?: string }
  D2: { score: number; weight: number; weighted: number; artifact?: string }
  D3: { score: number; weight: number; weighted: number; artifact?: string }
  D4: { score: number; weight: number; weighted: number; artifact?: string }
  D5: { score: number; weight: number; weighted: number; artifact?: string }
}

export interface RubricAResult extends ScoreAResult {
  /** Override grade type (narrow union) — TS cho phép narrowing trong extends */
  grade: 'CONFIRMED' | 'PROBABLE' | 'WEAK'
  /** Phân rã điểm từng chiều (kèm weight + weighted contribution) */
  perDimension: RubricAPerDimension
  /** Anti-gaming warnings (dim ≥3 thiếu artifact / duplicate ref / etc.) */
  anchorWarnings: string[]
}

// ============================================================
// §2. WEIGHTS (SSOT — TB-14 §1.1 — 30/25/15/15/15)
// ============================================================

export const RUBRIC_A_WEIGHTS = {
  D1: 0.30, // Evidence
  D2: 0.25, // Causal
  D3: 0.15, // Consistent
  D4: 0.15, // Reproducible
  D5: 0.15, // Depth
} as const

/** Tổng weight phải = 1.0 (invariant — runtime check 1 lần khi module load) */
const _WEIGHT_SUM =
  RUBRIC_A_WEIGHTS.D1 + RUBRIC_A_WEIGHTS.D2 + RUBRIC_A_WEIGHTS.D3 + RUBRIC_A_WEIGHTS.D4 + RUBRIC_A_WEIGHTS.D5
if (Math.abs(_WEIGHT_SUM - 1.0) > 0.001) {
  // KHÔNG throw — chỉ warn (module load không được crash app). Build-time sẽ catch.
  console.warn(`[RubricA] RUBRIC_A_WEIGHTS sum = ${_WEIGHT_SUM} (expected 1.0) — verify spec TB-14 §1.1`)
}

// ============================================================
// §3. CORE SCORING — pure function (no LLM, no DB)
// ============================================================

const DIM_KEYS = ['D1', 'D2', 'D3', 'D4', 'D5'] as const

function clampDim(n: number): number {
  if (typeof n !== 'number' || Number.isNaN(n)) return 0
  if (n < 0) return 0
  if (n > 5) return 5
  return n
}

/**
 * Tính Rubric A — pure function.
 *
 * Bước:
 * 1. D4 override từ blindSas nếu provided (§1.3 AC5 — 2 SA blind avg).
 * 2. Anti-gaming: mọi dim ≥3 PHẢI có artifact trong artifacts[] — thiếu → dim=1.
 * 3. Anti-duplicate: cùng ref không được dùng cho 2 dim → warning (heuristic).
 * 4. score = Σ(dim × weight) → 0–5.0.
 * 5. grade: ≥4.0 CONFIRMED · 3.0–3.9 PROBABLE · <3.0 WEAK.
 */
export function scoreRubricA(input: RubricAInput): RubricAResult {
  const artifacts = input.artifacts ?? []
  const anchorWarnings: string[] = []

  // ---- map raw dim input ----
  const rawDims: Record<RubricADimension, number> = {
    D1: clampDim(input.d1_evidence),
    D2: clampDim(input.d2_causal),
    D3: clampDim(input.d3_consistent),
    D4: clampDim(input.d4_reproducible),
    D5: clampDim(input.d5_depth),
  }

  // ---- D4 override từ blindSas (2 SA blind — §1.3 AC5) ----
  if (input.blindSas && typeof input.blindSas.sa1 === 'number' && typeof input.blindSas.sa2 === 'number') {
    const avg = (clampDim(input.blindSas.sa1) + clampDim(input.blindSas.sa2)) / 2
    rawDims.D4 = avg
  }

  // ---- artifacts map theo dim (lấy 1 ref đầu cho mỗi dim) ----
  const artByDim: Partial<Record<RubricADimension, string>> = {}
  for (const a of artifacts) {
    if (!artByDim[a.dimension]) artByDim[a.dimension] = a.ref
  }

  // ---- anti-gaming (§1.3 AC3): dim ≥3 PHẢI có artifact ----
  const finalDims: Record<RubricADimension, number> = { ...rawDims }
  for (const dim of DIM_KEYS) {
    if (rawDims[dim] >= 3 && !artByDim[dim]) {
      anchorWarnings.push(
        `D ${dim}: dim=${rawDims[dim]} ≥3 nhưng thiếu artifact anchor — auto downgrade về 1 (anti-gaming TB-14 §1.3 AC3)`,
      )
      finalDims[dim] = 1
    }
  }

  // ---- anti-duplicate: cùng ref không dùng cho 2 dim ----
  const refCount = new Map<string, RubricADimension[]>()
  for (const a of artifacts) {
    const key = a.ref
    if (!refCount.has(key)) refCount.set(key, [])
    refCount.get(key)!.push(a.dimension)
  }
  for (const [ref, dims] of refCount) {
    if (dims.length > 1) {
      anchorWarnings.push(
        `ref "${ref}" dùng cho ${dims.length} dim (${dims.join(',')}) — cấm cộng dồn chứng cứ trùng (TB-14 §1.3)`,
      )
    }
  }

  // ---- weighted score ----
  const perDimension = {} as RubricAPerDimension
  let score = 0
  for (const dim of DIM_KEYS) {
    const s = finalDims[dim]
    const w = RUBRIC_A_WEIGHTS[dim]
    perDimension[dim] = {
      score: s,
      weight: w,
      weighted: Number((s * w).toFixed(4)),
      artifact: artByDim[dim],
    }
    score += s * w
  }
  score = Number(score.toFixed(4))

  // ---- grade ----
  let grade: RubricAResult['grade']
  if (score >= 4.0) grade = 'CONFIRMED'
  else if (score >= 3.0) grade = 'PROBABLE'
  else grade = 'WEAK'

  return {
    D1: finalDims.D1,
    D2: finalDims.D2,
    D3: finalDims.D3,
    D4: finalDims.D4,
    D5: finalDims.D5,
    score,
    grade,
    perDimension,
    anchorWarnings,
  }
}

// ============================================================
// §4. TC-15 GATE — needsKillCriteria
// ============================================================

/**
 * TC-15 (TB-14 §10 + §3 vòng 3): nếu hypothesis CONFIRMED mà killCriteria
 * chưa set → KHÔNG được CONFIRMED, tối đa PROBABLE (§9 E3).
 *
 * Caller (tournament vòng 3 FALSIFY) gọi hàm này để check sau khi score.
 * Trả true nếu cần kill-criteria trước khi có thể CONFIRM.
 */
export function needsKillCriteria(result: RubricAResult, killCriteria?: string | null): boolean {
  if (result.grade !== 'CONFIRMED') return false
  if (killCriteria && killCriteria.trim().length > 0) return false
  return true
}

/**
 * Helper cho caller: nếu needsKillCriteria → downgrade grade từ CONFIRMED
 * xuống PROBABLE + thêm warning vào result. Trả bản sao mới (immutable).
 */
export function enforceKillCriteriaGate(result: RubricAResult, killCriteria?: string | null): RubricAResult {
  if (!needsKillCriteria(result, killCriteria)) return result
  return {
    ...result,
    grade: 'PROBABLE',
    anchorWarnings: [
      ...result.anchorWarnings,
      'TC-15: grade sẽ hạ CONFIRMED → PROBABLE vì thiếu killCriteria (TB-14 §10 + §9 E3)',
    ],
  }
}

// ============================================================
// §5. LLM-ASSISTED SCORING — fail-open
// ============================================================

const RUBRIC_A_SYSTEM_PROMPT = [
  'Bạn là utility extraction core (nemotron-3-ultra-550b) chấm Rubric A cho hypothesis research team TMO.',
  '',
  'RUBRIC A — 5 CHIỀU CHẨN ĐOÁN GIẢ THUYẾT (TB-14 §1.1):',
  '- D1 Evidence   (0.30): có bằng chứng cụ thể (file:line / log / metric)?',
  '- D2 Causal     (0.25): giải thích cơ-NẾU-THÌ, không chỉ tương quan?',
  '- D3 Consistent (0.15): nhất trí với dữ liệu / KB / quan sát khác?',
  '- D4 Reproducible (0.15): chạy lại ra cùng kết quả?',
  '- D5 Depth      (0.15): đào sâu tận root-cause, không dừng triệu chứng?',
  '',
  'Mỗi dim điểm 0–5 (số thực, 1 chữ số thập phân):',
  '  0 = không có / sai · 1 = rất yếu · 2 = yếu · 3 = khá · 4 = tốt · 5 = xuất sắc',
  '',
  'OUTPUT JSON-DUY-NAHAT, không markdown fence, không giải thích:',
  '{"d1_evidence":<0-5>,"d2_causal":<0-5>,"d3_consistent":<0-5>,"d4_reproducible":<0-5>,"d5_depth":<0-5>}',
].join('\n')

/** Parse JSON-RubricA từ LLM content — fail-open trả null khi parse lỗi */
function parseRubricAJson(content: string): RubricAInput | null {
  if (!content || content.trim().length === 0) return null
  // Strategy 1: direct parse
  try {
    const obj = JSON.parse(content)
    if (obj && typeof obj.d1_evidence === 'number') return obj
  } catch {
    // fallthrough
  }
  // Strategy 2: markdown fence strip
  const fenceMatch = content.match(/```(?:json)?\s*([\s\S]*?)\s*```/)
  if (fenceMatch) {
    try {
      const obj = JSON.parse(fenceMatch[1])
      if (obj && typeof obj.d1_evidence === 'number') return obj
    } catch {
      // fallthrough
    }
  }
  // Strategy 3: first {...}
  const firstObj = content.match(/\{[\s\S]*\}/)
  if (firstObj) {
    try {
      const obj = JSON.parse(firstObj[0])
      if (obj && typeof obj.d1_evidence === 'number') return obj
    } catch {
      // fallthrough
    }
  }
  return null
}

/**
 * LLM-assisted scoring: gọi callUtilityLLM chấm 5 dim → scoreRubricA.
 * Caller persist HypothesisRecord.scoreAJson (KHÔNG persist ở đây — pure scoring).
 *
 * Fail-open (TB-13 §4 — NIM keys placeholder): LLM error / parse fail →
 * trả WEAK + warning 'LLM unavailable — manual scoring needed', KHÔNG throw.
 */
export async function scoreRubricAWithLlm(
  problemStmt: string,
  hypothesis: string,
  evidence: string[],
): Promise<RubricAResult> {
  const prompt = [
    `PROBLEM: ${problemStmt}`,
    `HYPOTHESIS: ${hypothesis}`,
    `EVIDENCE:`,
    ...(evidence.length > 0 ? evidence.map((e, i) => `[${i + 1}] ${e}`) : ['(no evidence provided)']),
    '',
    'Chấm 5 dim theo Rubric A — output JSON duy nhất.',
  ].join('\n')

  let result
  try {
    result = await callUtilityLLM(prompt, RUBRIC_A_SYSTEM_PROMPT, 'rubric-a-score')
  } catch (err) {
    console.warn(
      '[RubricA] callUtilityLLM threw (non-blocking — fail-open):',
      err instanceof Error ? err.message : String(err),
    )
    return failOpenRubricA('LLM call threw — manual scoring needed')
  }

  if (result.error || !result.content || result.content.trim().length === 0) {
    console.warn('[RubricA] LLM error/empty content — fail-open:', result.error ?? 'empty content')
    return failOpenRubricA(result.error ?? 'LLM unavailable — manual scoring needed')
  }

  const parsed = parseRubricAJson(result.content)
  if (!parsed) {
    console.warn('[RubricA] JSON parse fail — fail-open. Raw (first 200 chars):', result.content.slice(0, 200))
    return failOpenRubricA('LLM output unparseable — manual scoring needed')
  }

  const scored = scoreRubricA(parsed)
  // Nếu LLM không có artifacts[] mà mọi dim ≥3 → scoreRubricA đã auto-downgrade.
  // Thêm warning để caller biết cần artifacts thật.
  return scored
}

function failOpenRubricA(reason: string): RubricAResult {
  const scored = scoreRubricA({
    d1_evidence: 0,
    d2_causal: 0,
    d3_consistent: 0,
    d4_reproducible: 0,
    d5_depth: 0,
  })
  return {
    ...scored,
    grade: 'WEAK',
    anchorWarnings: [`LLM unavailable — ${reason}`],
  }
}
