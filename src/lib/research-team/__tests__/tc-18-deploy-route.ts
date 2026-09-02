/**
 * TC-18 — DEPLOY ROUTE: CONVERGE → DIRECT-APPLY vs Proposal (TB-12 §3.2 + TB-14 §7 + §10)
 * ==================================================================================
 * Spec:
 *  - CONVERGE winner — 5 điều kiện hội ĐỦ → DIRECT-APPLY (KHÔNG cần Proposal):
 *      (1) deployMode === 'auto'
 *      (2) riskLevel === 'LOW'
 *      (3) reversibleUnder15min === true
 *      (4) tier ≤ 'T2' (T1 or T2)
 *      (5) blastRadiusSingleModule === true
 *  - Bonus: winning option phải STRONG (≥4.0) + context-fit APPLICABLE.
 *  - Flip riskLevel='HIGH' → eligible=false (Proposal required).
 *
 * Pure function — KHÔNG cần LLM/DB.
 */

import { evaluateDirectApply } from '@/lib/research-team/scoring/tournament'
import { scoreRubricB, type RubricBInput } from '@/lib/research-team/scoring/rubric-b'
import {
  checkContextFit,
  type ContextFitInput,
  type MissionContext,
} from '@/lib/research-team/scoring/context-fit'
import type { TestResult } from './_types'

/** Helper — build a STRONG winning option (total ≥4.0) + APPLICABLE context-fit. */
function buildWinningOption() {
  const strongInput: RubricBInput = {
    s1_coverage: 5,
    s2_impact: 5,
    s3_risk: 5,
    s4_effort: 5,
    s5_contextFit: 5,
    s6_verify: 5,
  }
  const score = scoreRubricB(strongInput)
  // total = 5 * (0.25+0.15+0.20+0.10+0.20+0.10) = 5 * 1.0 = 5.0 → STRONG

  const pattern: ContextFitInput = {
    module: 'llm-key-pool',
    protocolTier: 'T2-T3',
    dataScale: 'high-volume',
    loadProfile: 'concurrent',
    dependencies: ['multi-key-active'],
    environment: 'prod',
    timeConstraint: 'realtime',
    userPolicy: 'fail-fast',
    preConditions: [],
    contraindication: [],
    adaptationDelta: [],
  }
  const mission: MissionContext = {
    module: 'llm-key-pool',
    protocolTier: 'T2',
    dataScale: 'high-volume',
    loadProfile: 'concurrent',
    dependencies: ['multi-key-active'],
    environment: 'prod',
    timeConstraint: 'realtime',
    userPolicy: 'fail-fast',
  }
  const contextFit = checkContextFit(pattern, mission)
  return { score, contextFit }
}

async function run(): Promise<TestResult> {
  const details: string[] = []

  const winningOption = buildWinningOption()

  // Sanity check: winning option is STRONG + APPLICABLE
  const sanityOk =
    winningOption.score.grade === 'STRONG' &&
    winningOption.score.total >= 4.0 &&
    winningOption.contextFit.verdict === 'APPLICABLE'
  details.push(
    `sanity: winning score=${winningOption.score.total.toFixed(2)} grade=${winningOption.score.grade} contextFit=${winningOption.contextFit.verdict} — ${sanityOk ? 'OK' : 'FAIL'}`,
  )

  // ---------- 1. All 5 conditions true → eligible=true (DIRECT-APPLY) ----------
  const allTrue = evaluateDirectApply({
    winningOption,
    deployMode: 'auto',
    tier: 'T2',
    riskLevel: 'LOW',
    reversibleUnder15min: true,
    blastRadiusSingleModule: true,
  })
  const allTrueOk = allTrue.eligible === true
  details.push(
    `all-true case: eligible=${allTrue.eligible} (expected true) conditions: deployModeAuto=${allTrue.conditions.deployModeAuto} riskLow=${allTrue.conditions.riskLow} reversible=${allTrue.conditions.reversible} tierLe2=${allTrue.conditions.tierLe2} singleModule=${allTrue.conditions.singleModule} — ${allTrueOk ? 'OK' : 'FAIL'}`,
  )
  details.push(`all-true reason: "${allTrue.reason.slice(0, 80)}"`)

  // ---------- 2. Flip riskLevel='HIGH' → eligible=false (Proposal required) ----------
  const flipRisk = evaluateDirectApply({
    winningOption,
    deployMode: 'auto',
    tier: 'T2',
    riskLevel: 'HIGH', // ← flip
    reversibleUnder15min: true,
    blastRadiusSingleModule: true,
  })
  const flipRiskOk = flipRisk.eligible === false
  const flipRiskReasonOk = flipRisk.reason.includes('riskLevel')
  details.push(
    `flip-risk case: eligible=${flipRisk.eligible} (expected false) riskLow=${flipRisk.conditions.riskLow} reason="${flipRisk.reason.slice(0, 80)}" — ${flipRiskOk && flipRiskReasonOk ? 'OK' : 'FAIL'}`,
  )

  // ---------- 3. Flip tier='T3' → eligible=false ----------
  const flipTier = evaluateDirectApply({
    winningOption,
    deployMode: 'auto',
    tier: 'T3', // ← T3 requires Proposal
    riskLevel: 'LOW',
    reversibleUnder15min: true,
    blastRadiusSingleModule: true,
  })
  const flipTierOk = flipTier.eligible === false && flipTier.conditions.tierLe2 === false
  details.push(
    `flip-tier case: eligible=${flipTier.eligible} tierLe2=${flipTier.conditions.tierLe2} (expected false) — ${flipTierOk ? 'OK' : 'FAIL'}`,
  )

  // ---------- 4. Flip deployMode='proposal' → eligible=false ----------
  const flipMode = evaluateDirectApply({
    winningOption,
    deployMode: 'proposal',
    tier: 'T2',
    riskLevel: 'LOW',
    reversibleUnder15min: true,
    blastRadiusSingleModule: true,
  })
  const flipModeOk = flipMode.eligible === false && flipMode.conditions.deployModeAuto === false
  details.push(
    `flip-mode case: eligible=${flipMode.eligible} deployModeAuto=${flipMode.conditions.deployModeAuto} — ${flipModeOk ? 'OK' : 'FAIL'}`,
  )

  // ---------- 5. Flip reversible=false → eligible=false ----------
  const flipRev = evaluateDirectApply({
    winningOption,
    deployMode: 'auto',
    tier: 'T2',
    riskLevel: 'LOW',
    reversibleUnder15min: false,
    blastRadiusSingleModule: true,
  })
  const flipRevOk = flipRev.eligible === false && flipRev.conditions.reversible === false
  details.push(
    `flip-reversible case: eligible=${flipRev.eligible} reversible=${flipRev.conditions.reversible} — ${flipRevOk ? 'OK' : 'FAIL'}`,
  )

  // ---------- 6. Flip singleModule=false → eligible=false ----------
  const flipSingle = evaluateDirectApply({
    winningOption,
    deployMode: 'auto',
    tier: 'T2',
    riskLevel: 'LOW',
    reversibleUnder15min: true,
    blastRadiusSingleModule: false,
  })
  const flipSingleOk =
    flipSingle.eligible === false && flipSingle.conditions.singleModule === false
  details.push(
    `flip-singleModule case: eligible=${flipSingle.eligible} singleModule=${flipSingle.conditions.singleModule} — ${flipSingleOk ? 'OK' : 'FAIL'}`,
  )

  // ---------- 7. T1 (lowest tier) all-true → eligible=true ----------
  const t1Case = evaluateDirectApply({
    winningOption,
    deployMode: 'auto',
    tier: 'T1',
    riskLevel: 'LOW',
    reversibleUnder15min: true,
    blastRadiusSingleModule: true,
  })
  const t1Ok = t1Case.eligible === true
  details.push(
    `T1 all-true case: eligible=${t1Case.eligible} tierLe2=${t1Case.conditions.tierLe2} — ${t1Ok ? 'OK' : 'FAIL'}`,
  )

  const passed =
    sanityOk &&
    allTrueOk &&
    flipRiskOk &&
    flipRiskReasonOk &&
    flipTierOk &&
    flipModeOk &&
    flipRevOk &&
    flipSingleOk &&
    t1Ok
  return {
    name: 'TC-18 deploy route (DIRECT-APPLY vs Proposal)',
    passed,
    details: details.join(' | '),
  }
}

if (import.meta.main) {
  run()
    .then((r) => {
      console.log(r.name, r.passed ? 'PASS' : 'FAIL')
      console.log(r.details)
      process.exit(r.passed ? 0 : 1)
    })
    .catch((err) => {
      console.error('TC-18 uncaught:', err)
      process.exit(1)
    })
}

export { run }
