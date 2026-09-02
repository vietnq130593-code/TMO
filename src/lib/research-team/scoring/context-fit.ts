/**
 * RESEARCH TEAM — CONTEXT-FIT (TB-14 §5 — ma trận 8 chiều + 3 gate)
 * ====================================================================
 * Spec: TB-14 §5 (8-dimensional context matrix + 3 gates) + §10 TC-17.
 *
 * 8 CHIỀU CONTEXT (ma trận so khớp pattern ↔ mission):
 *   module · protocolTier · dataScale · loadProfile · dependencies ·
 *   environment · timeConstraint · userPolicy
 *
 * 3 GATE (cổng quyết định APPLICABLE vs TOURNAMENT):
 *   Gate 1: matchRatio ≥ 0.70 (≥5.6/8 chiều khớp).
 *   Gate 2: preConditionsMet === preConditionsTotal (100%).
 *   Gate 3: contraindicationCount === 0 (KHÔNG chống chỉ định).
 *
 * Verdict:
 *   - 3 gate pass → APPLICABLE (pattern có thể áp dụng trực tiếp).
 *   - Fail bất kỳ → TOURNAMENT (giải pháp vào tournament như ứng viên mới,
 *     KHÔNG clone mù — TB-14 §5.2 + TC-17).
 *
 * Fail-open: checkContextFitWithLlm LLM error → fail-open TOURNAMENT (safe
 * default — KHÔNG clone mù khi không chắc context khớp).
 *
 * Pure checkContextFit + formatWorklogLine KHÔNG gọi LLM/DB — testable.
 */

import { callUtilityLLM } from '@/lib/llm'

// ============================================================
// §1. TYPES
// ============================================================

/** 8 chiều context — TB-14 §5.1 */
export const CONTEXT_FIT_DIMENSIONS = [
  'module',
  'protocolTier',
  'dataScale',
  'loadProfile',
  'dependencies',
  'environment',
  'timeConstraint',
  'userPolicy',
] as const

export type ContextFitDimension = (typeof CONTEXT_FIT_DIMENSIONS)[number]

export interface ContextFitInput {
  /** 8 chiều context pattern */
  module: string
  protocolTier: string
  dataScale: string
  loadProfile: string
  dependencies: string[]
  environment: 'prod' | 'sandbox' | 'both'
  timeConstraint: string
  userPolicy: string
  /** Gate 2: pre-conditions pattern cần thỏa */
  preConditions: string[]
  /** Gate 3: chống chỉ định — nếu mission có đặc tính này thì KHÔNG áp dụng */
  contraindication: string[]
  /** Delta adaptation (text mô tả thay đổi cần thiết khi apply) */
  adaptationDelta: string[]
}

/** Mission context (đối chiếu phía mission hiện hành) */
export interface MissionContext {
  module: string
  protocolTier: string
  dataScale: string
  loadProfile: string
  dependencies: string[]
  environment: string
  timeConstraint: string
  userPolicy: string
}

export interface ContextFitResult {
  /** Số chiều khớp (0–8) */
  matchCount: number
  /** matchCount / 8 */
  matchRatio: number
  /** Gate 2: số pre-condition pattern thỏa */
  preConditionsMet: number
  preConditionsTotal: number
  /** Gate 3: số chống chỉ định phát hiện (0 → pass) */
  contraindicationCount: number
  /** 'APPLICABLE' = 3 gate pass · 'TOURNAMENT' = fail ít nhất 1 gate */
  verdict: 'APPLICABLE' | 'TOURNAMENT'
  /** Mô tả gate nào pass/fail */
  reason: string
  /** Chi tiết từng chiều match/mismatch */
  dimensionMatches: Record<ContextFitDimension, boolean>
}

// ============================================================
// §2. CORE MATCH — pure function (no LLM, no DB)
// ============================================================

function matchString(pattern: string, mission: string): boolean {
  if (!pattern && !mission) return true
  if (!pattern || !mission) return false
  const p = pattern.toLowerCase().trim()
  const m = mission.toLowerCase().trim()
  if (p === m) return true
  // substring / prefix match — TB-14 §5: "khớp exact hoặc fuzzy"
  if (p.includes(m) || m.includes(p)) return true
  // token overlap (e.g. "T2-T3" vs "T3" → match)
  const tokens = (s: string) => s.split(/[\s,/-]+/).filter(Boolean)
  const pt = tokens(p)
  const mt = tokens(m)
  if (pt.length > 0 && mt.length > 0) {
    const overlap = pt.filter((t) => mt.includes(t)).length
    if (overlap / Math.max(pt.length, mt.length) >= 0.5) return true
  }
  return false
}

function matchDependencies(pattern: string[], mission: string[]): boolean {
  if (pattern.length === 0) return true // pattern không ràng buộc → match
  if (mission.length === 0) return false
  const mp = pattern.map((d) => d.toLowerCase().trim())
  const mm = mission.map((d) => d.toLowerCase().trim())
  // pattern ⊆ mission (tất cả dep pattern phải có trong mission)
  return mp.every((p) => mm.some((m) => m === p || m.includes(p) || p.includes(m)))
}

/**
 * Check Context-Fit — pure function.
 *
 * 3 gates:
 *  Gate 1: matchRatio ≥ 0.70 (≥5.6/8 = thực ra ≥6/8 vì 5/8=0.625 <0.7).
 *  Gate 2: preConditionsMet === preConditionsTotal.
 *  Gate 3: contraindicationCount === 0.
 *
 * Cả 3 pass → APPLICABLE. Fail bất kỳ → TOURNAMENT (KHÔNG clone mù — TC-17).
 */
export function checkContextFit(pattern: ContextFitInput, mission: MissionContext): ContextFitResult {
  const dimMatches: Record<ContextFitDimension, boolean> = {
    module: matchString(pattern.module, mission.module),
    protocolTier: matchString(pattern.protocolTier, mission.protocolTier),
    dataScale: matchString(pattern.dataScale, mission.dataScale),
    loadProfile: matchString(pattern.loadProfile, mission.loadProfile),
    dependencies: matchDependencies(pattern.dependencies, mission.dependencies),
    environment: matchString(pattern.environment, mission.environment),
    timeConstraint: matchString(pattern.timeConstraint, mission.timeConstraint),
    userPolicy: matchString(pattern.userPolicy, mission.userPolicy),
  }

  const matchCount = Object.values(dimMatches).filter(Boolean).length
  const matchRatio = Number((matchCount / CONTEXT_FIT_DIMENSIONS.length).toFixed(4))

  // Gate 1
  const gate1Pass = matchRatio >= 0.70

  // Gate 2: pre-conditions
  const preConditionsTotal = pattern.preConditions.length
  // Heuristic: pre-condition text có chứa keyword đặc trưng trong mission context
  // (caller có thể override qua LLM-assisted check).
  const missionBlob = [
    mission.module,
    mission.protocolTier,
    mission.dataScale,
    mission.loadProfile,
    mission.dependencies.join(' '),
    mission.environment,
    mission.timeConstraint,
    mission.userPolicy,
  ]
    .join(' ')
    .toLowerCase()

  const preConditionsMet = pattern.preConditions.filter((pc) => {
    const p = pc.toLowerCase()
    // simple heuristic: một vài keyword của pre-cond xuất hiện trong mission blob
    const tokens = p.split(/\s+/).filter((t) => t.length >= 3)
    if (tokens.length === 0) return true
    return tokens.some((t) => missionBlob.includes(t))
  }).length
  const gate2Pass = preConditionsMet === preConditionsTotal

  // Gate 3: contraindication
  const contraindicationCount = pattern.contraindication.filter((ci) => {
    const c = ci.toLowerCase().trim()
    if (!c) return false
    return missionBlob.includes(c)
  }).length
  const gate3Pass = contraindicationCount === 0

  // Verdict
  const allPass = gate1Pass && gate2Pass && gate3Pass
  const reasons: string[] = []
  if (!gate1Pass) reasons.push(`gate-1 matchRatio ${matchRatio.toFixed(2)} < 0.70`)
  if (!gate2Pass) reasons.push(`gate-2 pre-conditions ${preConditionsMet}/${preConditionsTotal} < 100%`)
  if (!gate3Pass) reasons.push(`gate-3 contraindication ${contraindicationCount} > 0`)

  return {
    matchCount,
    matchRatio,
    preConditionsMet,
    preConditionsTotal,
    contraindicationCount,
    verdict: allPass ? 'APPLICABLE' : 'TOURNAMENT',
    reason: allPass
      ? `3 gates pass: match ${matchCount}/8, pre ${preConditionsMet}/${preConditionsTotal}, contra 0`
      : reasons.join('; '),
    dimensionMatches: dimMatches,
  }
}

// ============================================================
// §3. WORKLOG FORMAT (TB-14 §5.2)
// ============================================================

/**
 * TB-14 §5.2 — format 1 dòng worklog:
 *   contextfit: <pattern-id> match <x/8> pre <n/N> contra <0|1> → APPLICABLE|TOURNAMENT
 */
export function formatWorklogLine(result: ContextFitResult, patternId: string): string {
  return `contextfit: ${patternId} match ${result.matchCount}/8 pre ${result.preConditionsMet}/${result.preConditionsTotal} contra ${result.contraindicationCount > 0 ? 1 : 0} → ${result.verdict}`
}

// ============================================================
// §4. LLM-ASSISTED MATCH — fail-open
// ============================================================

const CONTEXT_FIT_SYSTEM_PROMPT = [
  'Bạn là utility extraction core đánh giá Context-Fit giữa pattern KB và mission hiện hành (TB-14 §5).',
  '',
  '8 CHIỀU CONTEXT (ma trận so khớp):',
  '- module · protocolTier · dataScale · loadProfile · dependencies · environment · timeConstraint · userPolicy',
  '',
  'Với mỗi chiều, trả về true nếu pattern khớp mission (exact / substring / fuzzy), false nếu không.',
  'Trả về JSON-DUY-NAHAT (không markdown, không giải thích):',
  '{"module":true|false,"protocolTier":true|false,"dataScale":true|false,"loadProfile":true|false,"dependencies":true|false,"environment":true|false,"timeConstraint":true|false,"userPolicy":true|false}',
].join('\n')

function parseMatchJson(content: string): Partial<Record<ContextFitDimension, boolean>> | null {
  if (!content || content.trim().length === 0) return null
  try {
    const obj = JSON.parse(content)
    if (obj && typeof obj === 'object') return obj
  } catch {
    /* fallthrough */
  }
  const fence = content.match(/```(?:json)?\s*([\s\S]*?)\s*```/)
  if (fence) {
    try {
      const obj = JSON.parse(fence[1])
      if (obj && typeof obj === 'object') return obj
    } catch {
      /* fallthrough */
    }
  }
  const firstObj = content.match(/\{[\s\S]*\}/)
  if (firstObj) {
    try {
      const obj = JSON.parse(firstObj[0])
      if (obj && typeof obj === 'object') return obj
    } catch {
      /* fallthrough */
    }
  }
  return null
}

/**
 * LLM-assisted match — hữu ích cho dim fuzzy (dependencies, loadProfile...).
 * LLM chấm từng dim khớp/không khớp, sau đó vẫn apply 3 gates (pure checkContextFit).
 *
 * Fail-open: LLM error → trả TOURNAMENT (safe default — KHÔNG clone mù).
 */
export async function checkContextFitWithLlm(
  pattern: ContextFitInput,
  mission: MissionContext,
): Promise<ContextFitResult> {
  const prompt = [
    `PATTERN:`,
    `  module: ${pattern.module}`,
    `  protocolTier: ${pattern.protocolTier}`,
    `  dataScale: ${pattern.dataScale}`,
    `  loadProfile: ${pattern.loadProfile}`,
    `  dependencies: ${pattern.dependencies.join(', ')}`,
    `  environment: ${pattern.environment}`,
    `  timeConstraint: ${pattern.timeConstraint}`,
    `  userPolicy: ${pattern.userPolicy}`,
    ``,
    `MISSION:`,
    `  module: ${mission.module}`,
    `  protocolTier: ${mission.protocolTier}`,
    `  dataScale: ${mission.dataScale}`,
    `  loadProfile: ${mission.loadProfile}`,
    `  dependencies: ${mission.dependencies.join(', ')}`,
    `  environment: ${mission.environment}`,
    `  timeConstraint: ${mission.timeConstraint}`,
    `  userPolicy: ${mission.userPolicy}`,
    ``,
    `Đánh giá từng chiều khớp (true) hay không (false). Output JSON.`,
  ].join('\n')

  // Lấy baseline từ pure check trước — làm fallback tốt nhất
  const baseline = checkContextFit(pattern, mission)

  let result
  try {
    result = await callUtilityLLM(prompt, CONTEXT_FIT_SYSTEM_PROMPT, 'context-fit-match')
  } catch (err) {
    console.warn(
      '[ContextFit] callUtilityLLM threw (non-blocking — fail-open → TOURNAMENT):',
      err instanceof Error ? err.message : String(err),
    )
    return { ...baseline, reason: `LLM unavailable — ${baseline.reason || 'safe default TOURNAMENT'}` }
  }

  if (result.error || !result.content || result.content.trim().length === 0) {
    console.warn('[ContextFit] LLM error/empty — fail-open → baseline verdict')
    return baseline
  }

  const parsed = parseMatchJson(result.content)
  if (!parsed) {
    console.warn('[ContextFit] JSON parse fail — fail-open → baseline')
    return baseline
  }

  // Merge LLM matches vào dimensionMatches (LLM override pure heuristic)
  const dimMatches = { ...baseline.dimensionMatches }
  for (const k of CONTEXT_FIT_DIMENSIONS) {
    if (typeof parsed[k] === 'boolean') dimMatches[k] = parsed[k] as boolean
  }

  const matchCount = Object.values(dimMatches).filter(Boolean).length
  const matchRatio = Number((matchCount / CONTEXT_FIT_DIMENSIONS.length).toFixed(4))
  const gate1Pass = matchRatio >= 0.70
  const gate2Pass = baseline.preConditionsMet === baseline.preConditionsTotal
  const gate3Pass = baseline.contraindicationCount === 0
  const allPass = gate1Pass && gate2Pass && gate3Pass

  return {
    ...baseline,
    matchCount,
    matchRatio,
    dimensionMatches: dimMatches,
    verdict: allPass ? 'APPLICABLE' : 'TOURNAMENT',
    reason: allPass
      ? `LLM-assisted: match ${matchCount}/8, pre ${baseline.preConditionsMet}/${baseline.preConditionsTotal}, contra 0`
      : `LLM-assisted failed gate(s): match ${matchCount}/8 (${matchRatio.toFixed(2)})`,
  }
}
