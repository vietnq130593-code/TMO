/**
 * RESEARCH TEAM — TOURNAMENT (TB-14 §3 + §6 + §7 — 5 vòng + Council ⑤ + DIRECT-APPLY)
 * ==================================================================================
 * Spec:
 *  - TB-14 §3 — Tournament 5 vòng trần 3 lặp:
 *      ① GENERATE → ② SCORE-A → ③ FALSIFY → ④ EXPERIMENT → ⑤ COUNCIL.
 *      Trần 3 lặp (iterations ≤3); vòng 3 bắt buộc verdict cuối (CONVERGE/DROP).
 *  - TB-14 §6 — Council ⑤ solution council (NEMESIS+SIVIL+BELI+LISMA+HAN):
 *      blocking=true · kind=5 · round=5 · verdict CONTINUE-ITERATE|CONVERGE|PIVOT|DROP.
 *  - TB-14 §7 — DIRECT-APPLY post-converge: 5 điều kiện hội ĐỦ → eligible.
 *  - TB-14 §9 — exit rules: E1 (<3 hypothesis escalate) · E3 (CONFIRMED cần killCriteria)
 *      · E6 (tie-break: gap <0.5 → S3 thắng).
 *  - TB-14 §10 — TC-15/16/17/18 (delegate tới rubric-a/b + context-fit + evaluateDirectApply).
 *
 * DEPENDENCY INJECTION (TB-13 §1 nguyên tắc 7 — không NLP phức tạp, tái dùng hạ tầng):
 *  Tournament.ts KHÔNG import g1/sivil, g2/lisma, hay king/ trực tiếp (chúng build
 *  song song/separate). Caller (NEMESIS ở P5) inject các hàm thật qua TournamentAgents.
 *  Tournament.ts tự testable với mock agents (P7 E2E test cases).
 *
 * Fail-open (TB-13 §4): mỗi vòng catch error → ghi warning, tiếp tục nếu có thể.
 * GENERATE fail → empty hypotheses → DROP với reason 'LLM unavailable'.
 */

import { db } from '@/lib/db'
import { callLLM } from '@/lib/llm'
import { encodeJson, COUNCIL_ROUNDS } from '../types'
import {
  scoreRubricA,
  scoreRubricAWithLlm,
  needsKillCriteria,
  enforceKillCriteriaGate,
  type RubricAResult,
  type RubricArtifactRef,
} from './rubric-a'
import { scoreRubricB, scoreRubricBWithLlm, computeScorecardDelta, type RubricBResult } from './rubric-b'
import { checkContextFit, type ContextFitInput, type ContextFitResult, type MissionContext } from './context-fit'

// ============================================================
// §1. TYPES — DI Agents + Tournament I/O
// ============================================================

/** Callbacks caller (NEMESIS P5) inject — DI pattern. */
export interface TournamentAgents {
  /** Vòng 1: SIVIL sinh ≥3 hypothesis từ problem statement. */
  generateHypotheses: (problemStmt: string) => Promise<{ hypothesis: string; evidence: string[] }[]>
  /** Vòng 3: chạy kill-test cho hypothesis với killCriteria. */
  runKillTest: (hypothesis: string, killCriteria: string) => Promise<{ pass: boolean; evidence: string }>
  /** Vòng 4: chạy POC cho option trong branch workspace (P-POC-<option>). */
  runPoc: (
    optionId: string,
    spec: string,
  ) => Promise<{ branchName: string; metrics: Record<string, unknown>; success: boolean }>
  /** Vòng 2: 2 SA blind chấm D4 reproducibility (§1.3 AC5 — KHÔNG do SIVIL tự chấm). */
  scoreHypothesisBlind: (
    h: { hypothesis: string; evidence: string[] },
    problemStmt: string,
  ) => Promise<{ sa1: number; sa2: number }>
}

export interface TournamentHypothesisRow {
  id: string
  hypothesis: string
  scoreA: RubricAResult
  killCriteria?: string | null
  killTestResult?: { pass: boolean; evidence: string } | null
  status: 'GENERATED' | 'SCORING' | 'FALSIFYING' | 'CONFIRMED' | 'REJECTED' | 'KILLED'
  round: number
}

export interface TournamentExperimentRow {
  optionId: string
  hypothesisRef?: string
  spec?: string
  branchName?: string
  metrics?: Record<string, unknown>
  scoreExpected: RubricBResult
  scoreMeasured?: RubricBResult
  delta?: ReturnType<typeof computeScorecardDelta>
  status: 'DRAFT' | 'SPEC' | 'POC' | 'MEASURED' | 'SCORED'
}

export interface DirectApplyResult {
  eligible: boolean
  conditions: {
    deployModeAuto: boolean
    riskLow: boolean
    reversible: boolean
    tierLe2: boolean
    singleModule: boolean
  }
  reason: string
}

export interface TournamentResult {
  hypotheses: TournamentHypothesisRow[]
  experiments: TournamentExperimentRow[]
  councilVerdict: 'CONTINUE-ITERATE' | 'CONVERGE' | 'PIVOT' | 'DROP'
  winningOptionId?: string
  directApply?: DirectApplyResult
  iterations: number
  warnings: string[]
}

export interface RunTournamentParams {
  missionId: string
  problemStmt: string
  missionType: 'M1' | 'M2' | 'M3'
  tier: 'T1' | 'T2' | 'T3'
  successCriteria: string[]
  agents: TournamentAgents
  /** 'auto' = DIRECT-APPLY eligible nếu 5 điều kiện pass; 'proposal' = luôn Proposal */
  deployMode?: 'auto' | 'proposal'
  maxIterations?: number // default 3 (TB-14 §3 trần)
  /** Mission context — để check Context-Fit cho winning option post-converge */
  missionContext?: MissionContext
  /** Pattern Context-Fit input (nếu caller muốn check 1 KB pattern thay vì pure experiment) */
  patternContext?: ContextFitInput
}

// ============================================================
// §2. CONSTANTS
// ============================================================

const DEFAULT_MAX_ITERATIONS = 3 // TB-14 §3 trần 3 lặp
const OPTION_IDS = ['A', 'B', 'C'] as const // TB-14 §3 vòng 4: A/B/C options
const MIN_HYPOTHESES = 3 // §9 E1: <3 → escalate
const GAP_THRESHOLD = 0.5 // tie-break: gap top-2 <0.5 → cả 2; tie-break cuối gap <0.5 → S3 thắng

// ============================================================
// §3. HELPERS — LLM-generated sub-artifacts
// ============================================================

/**
 * Sinh killCriteria cho hypothesis qua LLM (TB-14 §3 vòng 3).
 * Caller persist HypothesisRecord.killCriteria. LLM error → null.
 */
async function generateKillCriteria(problemStmt: string, hypothesis: string): Promise<string | null> {
  const systemPrompt = [
    'Bạn là NEMESIS (Team Lead — research team TMO), nhiệm vụ: sinh killCriteria cho hypothesis.',
    '',
    'TB-14 §3 vòng 3 FALSIFY: mỗi hypothesis cần killCriteria — evidence nào nếu quan sát được',
    'sẽ BÁC BỎ (falsify) hypothesis. CONFIRMED bắt buộc killCriteria (TC-15).',
    '',
    'Ví dụ: hypothesis "API chậm do DB query N+1" → killCriteria "profile query count',
    '= 1 (không N+1) → hypothesis bị bác".',
    '',
    'OUTPUT: 1 câu killCriteria ngắn (≤200 ký tự), không markdown, không giải thích.',
  ].join('\n')
  const prompt = `PROBLEM: ${problemStmt}\n\nHYPOTHESIS: ${hypothesis}\n\nSinh killCriteria:`
  try {
    const result = await callLLM(prompt, systemPrompt, 'tournament-killcriteria', { temperature: 0.3, maxTokens: 200 })
    if (result.error || !result.content || result.content.trim().length === 0) return null
    const out = result.content.trim().slice(0, 500)
    return out
  } catch (err) {
    console.warn(
      '[Tournament] generateKillCriteria threw (non-blocking — null):',
      err instanceof Error ? err.message : String(err),
    )
    return null
  }
}

/**
 * Sinh 3 option specs (A/B/C) cho hypothesis qua LLM (HAN role — TB-14 §3 vòng 4).
 * Caller persist ExperimentRecord rows. LLM error → empty array.
 */
async function generateOptions(
  problemStmt: string,
  hypothesis: string,
  successCriteria: string[],
): Promise<{ optionId: string; spec: string }[]> {
  const systemPrompt = [
    'Bạn là HAN (G3 — Architecture Proposer), nhiệm vụ: đề xuất 3 option giải pháp A/B/C.',
    '',
    'TB-14 §3 vòng 4 EXPERIMENT: mỗi option phải khác approach (không phải variant của nhau).',
    '- A: approach đơn giản nhất / ít risk.',
    '- B: approach cân bằng (trade-off).',
    '- C: approach phức tạp hơn nhưng potentially cao impact.',
    '',
    'OUTPUT: JSON array 3 phần tử, mỗi phần tử {optionId, spec}.',
    'spec ≤500 ký tự. Không markdown fence, không giải thích thêm.',
  ].join('\n')
  const prompt = [
    `PROBLEM: ${problemStmt}`,
    `CONFIRMED HYPOTHESIS: ${hypothesis}`,
    `SUCCESS CRITERIA: ${successCriteria.join('; ') || '(none)'}`,
    '',
    'Sinh 3 option specs (A/B/C):',
  ].join('\n')
  try {
    const result = await callLLM(prompt, systemPrompt, 'tournament-options', { temperature: 0.4, maxTokens: 800 })
    if (result.error || !result.content || result.content.trim().length === 0) return []
    // parse JSON array
    const content = result.content.trim()
    const tryParse = (s: string): unknown => {
      try {
        return JSON.parse(s)
      } catch {
        return null
      }
    }
    let parsed = tryParse(content)
    if (!parsed) {
      const fence = content.match(/```(?:json)?\s*([\s\S]*?)\s*```/)
      if (fence) parsed = tryParse(fence[1])
    }
    if (!parsed) {
      const arr = content.match(/\[[\s\S]*\]/)
      if (arr) parsed = tryParse(arr[0])
    }
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((p): p is { optionId: string; spec: string } => {
        if (!p || typeof p !== 'object') return false
        const o = p as Record<string, unknown>
        return typeof o.optionId === 'string' && typeof o.spec === 'string'
      })
      .slice(0, 3)
      .map((p) => ({ optionId: p.optionId, spec: p.spec.slice(0, 500) }))
  } catch (err) {
    console.warn(
      '[Tournament] generateOptions threw (non-blocking — empty):',
      err instanceof Error ? err.message : String(err),
    )
    return []
  }
}

/** Re-score RubricA với blind SA override D4 + tạo artifacts từ evidence (heuristic). */
function rescoreWithBlindSa(llmResult: RubricAResult, blindSas: { sa1: number; sa2: number }): RubricAResult {
  const artifacts: RubricArtifactRef[] = []
  const dimKeys = ['D1', 'D2', 'D3', 'D4', 'D5'] as const
  for (const dim of dimKeys) {
    const art = llmResult.perDimension[dim].artifact
    if (art) artifacts.push({ dimension: dim, ref: art })
  }
  return scoreRubricA({
    d1_evidence: llmResult.D1,
    d2_causal: llmResult.D2,
    d3_consistent: llmResult.D3,
    d4_reproducible: llmResult.D4,
    d5_depth: llmResult.D5,
    artifacts,
    blindSas,
  })
}

/** Re-score RubricA với D2=5 (pass kill-test → causal confirmed). */
function rescoreD2Confirmed(prev: RubricAResult): RubricAResult {
  const artifacts: RubricArtifactRef[] = []
  const dimKeys = ['D1', 'D2', 'D3', 'D4', 'D5'] as const
  for (const dim of dimKeys) {
    const art = prev.perDimension[dim].artifact
    if (art) artifacts.push({ dimension: dim, ref: art })
  }
  return scoreRubricA({
    d1_evidence: prev.D1,
    d2_causal: 5, // kill-test pass → D2 causal = 5 (CONFIRMED)
    d3_consistent: prev.D3,
    d4_reproducible: prev.D4,
    d5_depth: prev.D5,
    artifacts,
    blindSas: { sa1: prev.D4, sa2: prev.D4 }, // preserve D4 từ blind SA
  })
}

// ============================================================
// §4. DIRECT-APPLY (TB-14 §7 + TC-18) — pure function
// ============================================================

/**
 * TB-14 §7 + §10 TC-18: 5 điều kiện hội ĐỦ để DIRECT-APPLY (KHÔNG cần Proposal):
 *  (1) deployMode === 'auto'
 *  (2) riskLevel === 'LOW'
 *  (3) reversibleUnder15min === true (reversible dưới 15 phút)
 *  (4) tier ≤ 'T2' (T1 hoặc T2 — T3 bắt buộc Proposal)
 *  (5) blastRadiusSingleModule === true (ảnh hưởng 1 module duy nhất)
 *
 * Thiếu 1 → Proposal (default — cần user approval).
 */
export function evaluateDirectApply(params: {
  winningOption: { score: RubricBResult; contextFit: ContextFitResult }
  deployMode: 'auto' | 'proposal'
  tier: 'T1' | 'T2' | 'T3'
  riskLevel: 'LOW' | 'MED' | 'HIGH'
  reversibleUnder15min: boolean
  blastRadiusSingleModule: boolean
}): DirectApplyResult {
  const conditions = {
    deployModeAuto: params.deployMode === 'auto',
    riskLow: params.riskLevel === 'LOW',
    reversible: params.reversibleUnder15min === true,
    tierLe2: params.tier === 'T1' || params.tier === 'T2',
    singleModule: params.blastRadiusSingleModule === true,
  }
  // Bonus check: winning option phải STRONG (≥4.0) — TB-14 §7
  const isStrong = params.winningOption.score.grade === 'STRONG' || params.winningOption.score.total >= 4.0
  // Bonus check: context-fit APPLICABLE (TB-14 §7 + §5)
  const contextApplicable = params.winningOption.contextFit.verdict === 'APPLICABLE'

  const allMet = Object.values(conditions).every(Boolean) && isStrong && contextApplicable
  const failed: string[] = []
  if (!conditions.deployModeAuto) failed.push('deployMode != auto')
  if (!conditions.riskLow) failed.push('riskLevel != LOW')
  if (!conditions.reversible) failed.push('not reversible under 15min')
  if (!conditions.tierLe2) failed.push(`tier ${params.tier} > T2`)
  if (!conditions.singleModule) failed.push('blast radius > 1 module')
  if (!isStrong) failed.push('winning option not STRONG (total<4.0)')
  if (!contextApplicable) failed.push('context-fit not APPLICABLE')

  return {
    eligible: allMet,
    conditions,
    reason: allMet
      ? 'DIRECT-APPLY eligible: 5 conditions met + STRONG + APPLICABLE'
      : `Proposal required: ${failed.join('; ')}`,
  }
}

// ============================================================
// §5. COUNCIL ⑤ (TB-14 §6) — LLM-assisted + persist CouncilTranscript
// ============================================================

const COUNCIL_5_SYSTEM_PROMPT = [
  'Bạn là NEMESIS (TL — research team TMO), chủ trì Council ⑤ solution council.',
  '',
  'Council ⑤ (TB-14 §6.2) — 5 thành viên: NEMESIS + SIVIL + BELI + LISMA + HAN.',
  'Agenda 5 mục:',
  '  1. Hypothesis CONFIRMED/REJECTED/KILLED (D2 causal — kill-test pass?).',
  '  2. Experiment scorecard B: STRONG/RECOMMENDED/CONDITIONAL/REJECTED?',
  '  3. Calibration delta (TC-16): |delta| >1.0 → lesson? Optimism bias (S2)?',
  '  4. Context-fit (TC-17): APPLICABLE hay TOURNAMENT?',
  '  5. Verdict cuối: CONTINUE-ITERATE | CONVERGE | PIVOT | DROP.',
  '',
  'Verdict rules:',
  '  - CONTINUE-ITERATE: điểm tăng + còn lặp (iteration < max).',
  '  - CONVERGE: option STRONG (≥4.0) + gap ≥0.5 với option kế + context-fit APPLICABLE.',
  '  - PIVOT: 2 vòng liên tiếp điểm đi ngang/giảm.',
  '  - DROP: 3 vòng không ra ≥PROBABLE, hoặc hypothesis kill-test fail + không còn phương án.',
  '',
  'OUTPUT JSON-DUY-NAHAT: {"verdict":"CONTINUE-ITERATE|CONVERGE|PIVOT|DROP","winningOptionId":"<A|B|C|null>","transcript":"<tóm tắt lý do, ≤500 ký tự>"}',
].join('\n')

export async function runCouncil5(params: {
  missionId: string
  hypotheses: TournamentHypothesisRow[]
  experiments: TournamentExperimentRow[]
  contextFit: ContextFitResult | null
  iteration: number
  maxIterations: number
}): Promise<{
  verdict: 'CONTINUE-ITERATE' | 'CONVERGE' | 'PIVOT' | 'DROP'
  winningOptionId?: string
  transcript: string
}> {
  const hSummary = params.hypotheses
    .map((h) => `${h.id}: status=${h.status} scoreA=${h.scoreA.score.toFixed(2)}(${h.scoreA.grade})`)
    .join('\n')
  const eSummary = params.experiments
    .map(
      (e) =>
        `${e.optionId}: expected=${e.scoreExpected.total.toFixed(2)}(${e.scoreExpected.grade}) measured=${e.scoreMeasured?.total.toFixed(2) ?? '?'}(${e.scoreMeasured?.grade ?? '?'})`,
    )
    .join('\n')
  const cfSummary = params.contextFit
    ? `match ${params.contextFit.matchCount}/8 verdict=${params.contextFit.verdict}`
    : '(no context-fit)'

  const prompt = [
    `MISSION: ${params.missionId}`,
    `ITERATION: ${params.iteration}/${params.maxIterations}`,
    '',
    'HYPOTHESES:',
    hSummary || '(none)',
    '',
    'EXPERIMENTS:',
    eSummary || '(none)',
    '',
    `CONTEXT-FIT: ${cfSummary}`,
    '',
    'Ra verdict cuối theo Council ⑤ agenda. Output JSON.',
  ].join('\n')

  let result
  try {
    result = await callLLM(prompt, COUNCIL_5_SYSTEM_PROMPT, 'council-5-solution', { temperature: 0.2, maxTokens: 800 })
  } catch (err) {
    console.warn(
      '[Council5] callLLM threw (non-blocking — fail-open DROP):',
      err instanceof Error ? err.message : String(err),
    )
    return await persistCouncil5(params.missionId, 'DROP', undefined, 'council deferred — LLM unavailable')
  }

  if (result.error || !result.content || result.content.trim().length === 0) {
    console.warn('[Council5] LLM error/empty — fail-open DROP')
    return await persistCouncil5(params.missionId, 'DROP', undefined, 'council deferred — LLM unavailable')
  }

  // parse JSON verdict
  const parsed = parseCouncil5Json(result.content)
  if (!parsed) {
    console.warn('[Council5] JSON parse fail — fail-open DROP. Raw:', result.content.slice(0, 200))
    return await persistCouncil5(params.missionId, 'DROP', undefined, 'council deferred — output unparseable')
  }

  return await persistCouncil5(params.missionId, parsed.verdict, parsed.winningOptionId, parsed.transcript)
}

function parseCouncil5Json(content: string): {
  verdict: 'CONTINUE-ITERATE' | 'CONVERGE' | 'PIVOT' | 'DROP'
  winningOptionId?: string
  transcript: string
} | null {
  const tryParse = (s: string): unknown => {
    try {
      return JSON.parse(s)
    } catch {
      return null
    }
  }
  let parsed = tryParse(content)
  if (!parsed) {
    const fence = content.match(/```(?:json)?\s*([\s\S]*?)\s*```/)
    if (fence) parsed = tryParse(fence[1])
  }
  if (!parsed) {
    const obj = content.match(/\{[\s\S]*\}/)
    if (obj) parsed = tryParse(obj[0])
  }
  if (!parsed || typeof parsed !== 'object') return null
  const o = parsed as Record<string, unknown>
  const verdict = o.verdict
  if (typeof verdict !== 'string') return null
  const valid = ['CONTINUE-ITERATE', 'CONVERGE', 'PIVOT', 'DROP'] as const
  if (!valid.includes(verdict as (typeof valid)[number])) return null
  const winningOptionId = typeof o.winningOptionId === 'string' && o.winningOptionId !== 'null' ? o.winningOptionId : undefined
  const transcript = typeof o.transcript === 'string' ? o.transcript : ''
  return { verdict: verdict as (typeof valid)[number], winningOptionId, transcript }
}

async function persistCouncil5(
  missionId: string,
  verdict: 'CONTINUE-ITERATE' | 'CONVERGE' | 'PIVOT' | 'DROP',
  winningOptionId: string | undefined,
  transcript: string,
): Promise<{ verdict: typeof verdict; winningOptionId?: string; transcript: string }> {
  try {
    await db.councilTranscript.create({
      data: {
        missionId,
        round: COUNCIL_ROUNDS.solution, // 5
        kind: 5, // ⑤ solution council
        verdict,
        blocking: true,
        transcript,
      },
    })
  } catch (err) {
    console.warn(
      '[Council5] Persist CouncilTranscript failed (non-blocking):',
      err instanceof Error ? err.message : String(err),
    )
  }
  return { verdict, winningOptionId, transcript }
}

// ============================================================
// §6. PERSIST HELPERS — HypothesisRecord + ExperimentRecord
// ============================================================

async function persistHypothesis(params: {
  missionId: string
  problemStmt: string
  hypothesis: string
  scoreA: RubricAResult
  killCriteria?: string | null
  killTestResult?: { pass: boolean; evidence: string } | null
  status: TournamentHypothesisRow['status']
  round: number
}): Promise<string> {
  try {
    const row = await db.hypothesisRecord.create({
      data: {
        missionId: params.missionId,
        problemStmt: params.problemStmt,
        hypothesis: params.hypothesis,
        scoreAJson: encodeJson(params.scoreA),
        killCriteria: params.killCriteria ?? null,
        killTestResult: params.killTestResult ? JSON.stringify(params.killTestResult) : null,
        status: params.status,
        round: params.round,
      },
    })
    return row.id
  } catch (err) {
    console.warn(
      '[Tournament] persistHypothesis failed (non-blocking):',
      err instanceof Error ? err.message : String(err),
    )
    return ''
  }
}

async function updateHypothesis(id: string, data: Partial<{
  scoreAJson: string
  killCriteria: string | null
  killTestResult: string | null
  status: string
  round: number
}>): Promise<void> {
  if (!id) return
  try {
    await db.hypothesisRecord.update({ where: { id }, data })
  } catch (err) {
    console.warn(
      '[Tournament] updateHypothesis failed (non-blocking):',
      err instanceof Error ? err.message : String(err),
    )
  }
}

async function persistExperiment(params: {
  missionId: string
  optionId: string
  hypothesisRef?: string
  spec?: string
  branchName?: string
  metrics?: Record<string, unknown>
  scoreExpected: RubricBResult
  scoreMeasured?: RubricBResult
  delta?: ReturnType<typeof computeScorecardDelta>
  status: TournamentExperimentRow['status']
}): Promise<string> {
  try {
    const row = await db.experimentRecord.create({
      data: {
        missionId: params.missionId,
        optionId: params.optionId,
        hypothesisRef: params.hypothesisRef || null, // FIX (Task 19 audit B#8): '' không phải nullish — `?? null` lưu chuỗi rỗng vào DB
        specPath: params.spec ?? null,
        branchName: params.branchName ?? null,
        metricsJson: params.metrics ? encodeJson(params.metrics) : null,
        scoreExpected: encodeJson(params.scoreExpected),
        scoreMeasured: params.scoreMeasured ? encodeJson(params.scoreMeasured) : null,
        deltaJson: params.delta ? encodeJson(params.delta) : null,
        status: params.status,
      },
    })
    return row.id
  } catch (err) {
    console.warn(
      '[Tournament] persistExperiment failed (non-blocking):',
      err instanceof Error ? err.message : String(err),
    )
    return ''
  }
}

// ============================================================
// §7. TOURNAMENT ORCHESTRATOR — 5 vòng + trần 3 lặp
// ============================================================

export async function runTournament(params: RunTournamentParams): Promise<TournamentResult> {
  const maxIterations = params.maxIterations ?? DEFAULT_MAX_ITERATIONS
  const warnings: string[] = []
  const allHypotheses: TournamentHypothesisRow[] = []
  const allExperiments: TournamentExperimentRow[] = []
  let councilVerdict: TournamentResult['councilVerdict'] = 'DROP'
  let winningOptionId: string | undefined
  let directApply: DirectApplyResult | undefined
  let iterations = 0

  for (let iter = 1; iter <= maxIterations; iter++) {
    iterations = iter
    const isLast = iter === maxIterations

    // ---------- VÒNG 1: GENERATE ----------
    let hypotheses: { hypothesis: string; evidence: string[] }[]
    try {
      hypotheses = await params.agents.generateHypotheses(params.problemStmt)
    } catch (err) {
      warnings.push(`V1 generateHypotheses threw: ${err instanceof Error ? err.message : String(err)}`)
      hypotheses = []
    }
    if (hypotheses.length < MIN_HYPOTHESES) {
      warnings.push(
        `§9 E1: chỉ có ${hypotheses.length} hypothesis (< ${MIN_HYPOTHESES}) — escalate NEMESIS (LLM unavailable?)`,
      )
      if (isLast) {
        councilVerdict = 'DROP'
        return finalize({ hypotheses: allHypotheses, experiments: allExperiments, councilVerdict, iterations, warnings, directApply })
      }
      continue
    }

    // persist HypothesisRecord GENERATED rows
    const hRows: { raw: { hypothesis: string; evidence: string[] }; id: string }[] = []
    for (const h of hypotheses) {
      const id = await persistHypothesis({
        missionId: params.missionId,
        problemStmt: params.problemStmt,
        hypothesis: h.hypothesis,
        scoreA: scoreRubricA({
          d1_evidence: 0, d2_causal: 0, d3_consistent: 0, d4_reproducible: 0, d5_depth: 0,
        }),
        status: 'GENERATED',
        round: iter,
      })
      hRows.push({ raw: h, id })
    }

    // ---------- VÒNG 2: SCORE-A ----------
    const scored: TournamentHypothesisRow[] = []
    for (const hr of hRows) {
      let scoreA: RubricAResult
      try {
        const llmScore = await scoreRubricAWithLlm(params.problemStmt, hr.raw.hypothesis, hr.raw.evidence)
        // blind SA chấm D4 (§1.3 AC5)
        let blind: { sa1: number; sa2: number } = { sa1: llmScore.D4, sa2: llmScore.D4 }
        try {
          blind = await params.agents.scoreHypothesisBlind(hr.raw, params.problemStmt)
        } catch (err) {
          warnings.push(`V2 scoreHypothesisBlind threw (${hr.id}): ${err instanceof Error ? err.message : String(err)}`)
        }
        scoreA = rescoreWithBlindSa(llmScore, blind)
      } catch (err) {
        warnings.push(`V2 scoreRubricAWithLlm threw (${hr.id}): ${err instanceof Error ? err.message : String(err)}`)
        // fail-open: WEAK result
        scoreA = scoreRubricA({
          d1_evidence: 0, d2_causal: 0, d3_consistent: 0, d4_reproducible: 0, d5_depth: 0,
        })
      }

      const status: TournamentHypothesisRow['status'] = scoreA.grade === 'WEAK' ? 'REJECTED' : 'SCORING'
      await updateHypothesis(hr.id, {
        scoreAJson: encodeJson(scoreA),
        status,
      })
      scored.push({
        id: hr.id,
        hypothesis: hr.raw.hypothesis,
        scoreA,
        status,
        round: iter,
      })
    }

    // Top-2 đi tiếp. Gap top-2 <0.5 → cả 2 cùng đi.
    const ranked = [...scored].sort((a, b) => b.scoreA.score - a.scoreA.score)
    const top = ranked.filter((h) => h.status !== 'REJECTED')
    let topCandidates: TournamentHypothesisRow[]
    if (top.length === 0) {
      topCandidates = []
      warnings.push('V2: tất cả hypothesis REJECTED (WEAK) — không có ứng viên đi vòng 3')
    } else if (top.length === 1) {
      topCandidates = [top[0]]
    } else {
      const gap = top[0].scoreA.score - top[1].scoreA.score
      topCandidates = gap < GAP_THRESHOLD ? [top[0], top[1]] : [top[0]]
    }

    // ---------- VÒNG 3: FALSIFY (TC-15 kill-criteria mandatory for CONFIRMED) ----------
    const afterFalsify: TournamentHypothesisRow[] = []
    for (const h of topCandidates) {
      // Sinh killCriteria qua LLM nếu chưa có
      let killCriteria = h.killCriteria ?? null
      if (!killCriteria) {
        try {
          killCriteria = await generateKillCriteria(params.problemStmt, h.hypothesis)
        } catch {
          killCriteria = null
        }
      }

      // TC-15: nếu cần killCriteria mà null → max PROBABLE (enforceKillCriteriaGate)
      let scoreA = h.scoreA
      if (needsKillCriteria(scoreA, killCriteria)) {
        scoreA = enforceKillCriteriaGate(scoreA, killCriteria)
        warnings.push(`V3 TC-15: hypothesis ${h.id} hạ CONFIRMED → PROBABLE (thiếu killCriteria)`)
      }
      await updateHypothesis(h.id, {
        scoreAJson: encodeJson(scoreA),
        killCriteria: killCriteria ?? null,
        status: 'FALSIFYING',
      })

      // Nếu vẫn CONFIRMED + có killCriteria → chạy kill-test
      if (scoreA.grade === 'CONFIRMED' && killCriteria) {
        let killTestResult: { pass: boolean; evidence: string }
        try {
          killTestResult = await params.agents.runKillTest(h.hypothesis, killCriteria)
        } catch (err) {
          warnings.push(`V3 runKillTest threw (${h.id}): ${err instanceof Error ? err.message : String(err)}`)
          killTestResult = { pass: false, evidence: `kill-test failed to run: ${err instanceof Error ? err.message : String(err)}` }
        }

        if (killTestResult.pass) {
          // Pass → D2=5 → CONFIRMED (re-score)
          scoreA = rescoreD2Confirmed(scoreA)
          await updateHypothesis(h.id, {
            scoreAJson: encodeJson(scoreA),
            killTestResult: JSON.stringify(killTestResult),
            status: 'CONFIRMED',
          })
          afterFalsify.push({ ...h, scoreA, killCriteria, killTestResult, status: 'CONFIRMED' })
        } else {
          // Fail → KILLED + negative-evidence worklog
          await updateHypothesis(h.id, {
            killTestResult: JSON.stringify(killTestResult),
            status: 'KILLED',
          })
          afterFalsify.push({ ...h, scoreA, killCriteria, killTestResult, status: 'KILLED' })
          warnings.push(`V3 §3 negative-evidence: hypothesis ${h.id} KILLED — ${killTestResult.evidence.slice(0, 120)}`)
        }
      } else {
        // PROBABLE → không kill-test, giữ nguyên status SCORING
        afterFalsify.push({ ...h, scoreA, killCriteria, status: 'SCORING' })
      }
    }
    allHypotheses.push(...afterFalsify)

    // Điều kiện sang vòng 4 (§3 EXT): ≥1 CONFIRMED hoặc ≥2 PROBABLE
    const confirmedCount = afterFalsify.filter((h) => h.status === 'CONFIRMED').length
    const probableCount = afterFalsify.filter((h) => h.scoreA.grade === 'PROBABLE').length
    const canExperiment = confirmedCount >= 1 || probableCount >= 2
    if (!canExperiment) {
      warnings.push(`V3: chỉ ${confirmedCount} CONFIRMED + ${probableCount} PROBABLE — không đủ điều kiện sang vòng 4`)
      if (isLast) {
        councilVerdict = 'DROP'
        return finalize({ hypotheses: allHypotheses, experiments: allExperiments, councilVerdict, iterations, warnings, directApply })
      }
      // CONTINUE-ITERATE cho vòng kế
      const council = await runCouncil5({
        missionId: params.missionId,
        hypotheses: allHypotheses,
        experiments: allExperiments,
        contextFit: null,
        iteration: iter,
        maxIterations,
      })
      councilVerdict = council.verdict
      if (council.verdict !== 'CONTINUE-ITERATE' || isLast) {
        return finalize({ hypotheses: allHypotheses, experiments: allExperiments, councilVerdict, iterations, warnings, directApply })
      }
      continue
    }

    // ---------- VÒNG 4: EXPERIMENT ----------
    // Lấy 1 hypothesis (ưu tiên CONFIRMED > PROBABLE) để build options A/B/C
    const chosenH = afterFalsify.find((h) => h.status === 'CONFIRMED') ?? afterFalsify[0]
    let options: { optionId: string; spec: string }[]
    try {
      options = await generateOptions(params.problemStmt, chosenH.hypothesis, params.successCriteria)
    } catch (err) {
      warnings.push(`V4 generateOptions threw: ${err instanceof Error ? err.message : String(err)}`)
      options = []
    }
    if (options.length === 0) {
      warnings.push('V4: không sinh được options (LLM unavailable) — fallback single-option A')
      options = [{ optionId: 'A', spec: '(fallback — spec deferred to BELI/HAN)' }]
    }

    const experimentRows: TournamentExperimentRow[] = []
    for (const opt of options.slice(0, 3)) {
      // scoreExpected (pre-experiment) qua scoreRubricBWithLlm
      let scoreExpected: RubricBResult
      try {
        scoreExpected = await scoreRubricBWithLlm(opt.spec, params.successCriteria, 3.0)
      } catch (err) {
        warnings.push(`V4 scoreRubricBWithLlm expected threw (${opt.optionId}): ${err instanceof Error ? err.message : String(err)}`)
        scoreExpected = scoreRubricB({
          s1_coverage: 0, s2_impact: 0, s3_risk: 0, s4_effort: 0, s5_contextFit: 0, s6_verify: 0,
        })
      }

      // run POC
      let branchName: string | undefined
      let metrics: Record<string, unknown> | undefined
      let pocSuccess = false
      try {
        const poc = await params.agents.runPoc(opt.optionId, opt.spec)
        branchName = poc.branchName
        metrics = poc.metrics
        pocSuccess = poc.success
      } catch (err) {
        warnings.push(`V4 runPoc threw (${opt.optionId}): ${err instanceof Error ? err.message : String(err)}`)
      }

      // scoreMeasured (post-experiment)
      let scoreMeasured: RubricBResult | undefined
      if (pocSuccess) {
        try {
          const metricsStr = metrics ? JSON.stringify(metrics).slice(0, 500) : '(no metrics)'
          scoreMeasured = await scoreRubricBWithLlm(
            `${opt.spec}\n\nMEASURED METRICS: ${metricsStr}`,
            params.successCriteria,
            3.0,
          )
        } catch (err) {
          warnings.push(`V4 scoreRubricBWithLlm measured threw (${opt.optionId}): ${err instanceof Error ? err.message : String(err)}`)
        }
      }

      // TC-16: computeScorecardDelta
      let delta: ReturnType<typeof computeScorecardDelta> | undefined
      if (scoreMeasured) {
        delta = computeScorecardDelta(scoreExpected, scoreMeasured)
      }

      // persist ExperimentRecord
      await persistExperiment({
        missionId: params.missionId,
        optionId: opt.optionId,
        hypothesisRef: chosenH.id,
        spec: opt.spec,
        branchName,
        metrics,
        scoreExpected,
        scoreMeasured,
        delta,
        status: scoreMeasured ? 'SCORED' : pocSuccess ? 'MEASURED' : 'POC',
      })

      experimentRows.push({
        optionId: opt.optionId,
        hypothesisRef: chosenH.id,
        spec: opt.spec,
        branchName,
        metrics,
        scoreExpected,
        scoreMeasured,
        delta,
        status: scoreMeasured ? 'SCORED' : pocSuccess ? 'MEASURED' : 'POC',
      })
    }
    allExperiments.push(...experimentRows)

    // ---------- VÒNG 5: COUNCIL ⑤ ----------
    // Compute context-fit nếu caller cung cấp missionContext + patternContext
    let contextFit: ContextFitResult | null = null
    if (params.missionContext && params.patternContext) {
      try {
        contextFit = checkContextFit(params.patternContext, params.missionContext)
      } catch (err) {
        warnings.push(`V5 checkContextFit threw: ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    const council = await runCouncil5({
      missionId: params.missionId,
      hypotheses: allHypotheses,
      experiments: allExperiments,
      contextFit,
      iteration: iter,
      maxIterations,
    })
    councilVerdict = council.verdict
    winningOptionId = council.winningOptionId

    // Tie-break §9 E6: nếu chưa set winningOptionId, chọn top scoreMeasured; gap <0.5 → S3 thắng
    if (councilVerdict === 'CONVERGE' && !winningOptionId) {
      const measured = experimentRows.filter((e) => e.scoreMeasured)
      if (measured.length >= 1) {
        measured.sort((a, b) => (b.scoreMeasured!.total - a.scoreMeasured!.total))
        if (measured.length >= 2) {
          const gap = measured[0].scoreMeasured!.total - measured[1].scoreMeasured!.total
          if (gap < GAP_THRESHOLD) {
            // tie-break: S3 (risk) thắng — chọn option có S3 cao hơn
            const s3Winner = [...measured].sort(
              (a, b) => (b.scoreMeasured!.perDimension.S3.score - a.scoreMeasured!.perDimension.S3.score),
            )[0]
            winningOptionId = s3Winner.optionId
            warnings.push(`§9 E6 tie-break: gap<${GAP_THRESHOLD} → S3 thắng → option ${s3Winner.optionId}`)
          } else {
            winningOptionId = measured[0].optionId
          }
        } else {
          winningOptionId = measured[0].optionId
        }
      }
    }

    if (councilVerdict !== 'CONTINUE-ITERATE' || isLast) {
      // POST-CONVERGE DIRECT-APPLY (§7 + TC-18)
      if (councilVerdict === 'CONVERGE' && winningOptionId) {
        const winner = experimentRows.find((e) => e.optionId === winningOptionId)
        if (winner && winner.scoreMeasured && contextFit) {
          directApply = evaluateDirectApply({
            winningOption: { score: winner.scoreMeasured, contextFit },
            deployMode: params.deployMode ?? 'proposal',
            tier: params.tier,
            riskLevel: winner.scoreMeasured.perDimension.S3.score >= 4 ? 'LOW' : winner.scoreMeasured.perDimension.S3.score >= 2.5 ? 'MED' : 'HIGH',
            reversibleUnder15min: winner.scoreMeasured.perDimension.S4.score >= 3,
            blastRadiusSingleModule: params.missionType !== 'M3', // M3 grand = multi-module
          })
        }
      }
      return finalize({ hypotheses: allHypotheses, experiments: allExperiments, councilVerdict, winningOptionId, directApply, iterations, warnings })
    }
    // CONTINUE-ITERATE → loop lại
  }

  return finalize({ hypotheses: allHypotheses, experiments: allExperiments, councilVerdict, winningOptionId, directApply, iterations, warnings })
}

function finalize(params: {
  hypotheses: TournamentHypothesisRow[]
  experiments: TournamentExperimentRow[]
  councilVerdict: TournamentResult['councilVerdict']
  winningOptionId?: string
  directApply?: DirectApplyResult
  iterations: number
  warnings: string[]
}): TournamentResult {
  return {
    hypotheses: params.hypotheses,
    experiments: params.experiments,
    councilVerdict: params.councilVerdict,
    winningOptionId: params.winningOptionId,
    directApply: params.directApply,
    iterations: params.iterations,
    warnings: params.warnings,
  }
}
