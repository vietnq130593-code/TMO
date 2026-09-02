/**
 * TC-17 — CONTEXT-FIT (TB-12 §3.2 + TB-14 §5 — 8-dim matrix + 3 gates)
 * ==================================================================================
 * Spec:
 *  - Reuse pattern KB sai bối cảnh → chặn APPLICABLE → tournament (KHÔNG clone mù).
 *  - Pattern có pre-condition "4 key active" nhưng mission single-key → chặn.
 *  - Gate 3: contraindicationCount > 0 → TOURNAMENT (vd pattern có contraindication
 *    "single-key" + mission dependencies có "single-key" → fail).
 *  - Pattern match 100% no contra → APPLICABLE.
 *
 * Pure function — KHÔNG cần LLM/DB.
 */

import {
  checkContextFit,
  type ContextFitInput,
  type MissionContext,
} from '@/lib/research-team/scoring/context-fit'
import type { TestResult } from './_types'

async function run(): Promise<TestResult> {
  const details: string[] = []

  // ---------- 1. Pattern có contraindication=['single-key'] + mission single-key ----------
  // → Gate 3 fail → verdict TOURNAMENT.
  const patternContra: ContextFitInput = {
    module: 'llm-key-pool',
    protocolTier: 'T2-T3',
    dataScale: 'high-volume',
    loadProfile: 'concurrent',
    dependencies: ['multi-key-active'],
    environment: 'prod',
    timeConstraint: 'realtime',
    userPolicy: 'fail-fast',
    preConditions: ['multi-key-active'],
    contraindication: ['single-key', 'no-health-check'],
    adaptationDelta: ['add multi-key rotation if mission has only 1 key'],
  }
  const missionSingleKey: MissionContext = {
    module: 'llm-key-pool',
    protocolTier: 'T2',
    dataScale: 'high-volume',
    loadProfile: 'concurrent',
    dependencies: ['single-key'], // ← mission single-key → contraindication match
    environment: 'prod',
    timeConstraint: 'realtime',
    userPolicy: 'fail-fast',
  }
  const contraResult = checkContextFit(patternContra, missionSingleKey)
  const contraOk = contraResult.verdict === 'TOURNAMENT'
  const contraReasonOk = contraResult.reason.includes('gate-3')
  details.push(
    `contra case: verdict=${contraResult.verdict} (expected TOURNAMENT) contra=${contraResult.contraindicationCount} (expected ≥1) reason="${contraResult.reason.slice(0, 80)}" — ${contraOk && contraReasonOk ? 'OK' : 'FAIL'}`,
  )

  // ---------- 2. Pattern match 100% no contra → APPLICABLE ----------
  const patternGood: ContextFitInput = {
    module: 'llm-key-pool',
    protocolTier: 'T2-T3',
    dataScale: 'high-volume',
    loadProfile: 'concurrent',
    dependencies: ['multi-key-active'],
    environment: 'prod',
    timeConstraint: 'realtime',
    userPolicy: 'fail-fast',
    preConditions: [], // no pre-conditions to check → gate 2 trivially passes
    contraindication: [], // no contraindication → gate 3 trivially passes
    adaptationDelta: [],
  }
  const missionGood: MissionContext = {
    module: 'llm-key-pool',
    protocolTier: 'T2',
    dataScale: 'high-volume',
    loadProfile: 'concurrent',
    dependencies: ['multi-key-active'],
    environment: 'prod',
    timeConstraint: 'realtime',
    userPolicy: 'fail-fast',
  }
  const goodResult = checkContextFit(patternGood, missionGood)
  const goodOk = goodResult.verdict === 'APPLICABLE'
  details.push(
    `match-all-no-contra case: verdict=${goodResult.verdict} (expected APPLICABLE) match=${goodResult.matchCount}/8 — ${goodOk ? 'OK' : 'FAIL'}`,
  )

  // ---------- 3. Mismatch nhiều dims → Gate 1 fail → TOURNAMENT ----------
  const patternMismatch: ContextFitInput = {
    module: 'llm-key-pool',
    protocolTier: 'T1', // mismatch (mission T2)
    dataScale: 'small', // mismatch (mission high-volume)
    loadProfile: 'batch', // mismatch (mission concurrent)
    dependencies: ['multi-key-active'],
    environment: 'sandbox', // mismatch (mission prod)
    timeConstraint: 'offline', // mismatch (mission realtime)
    userPolicy: 'fail-fast',
    preConditions: [],
    contraindication: [],
    adaptationDelta: [],
  }
  const mismatchResult = checkContextFit(patternMismatch, missionGood)
  const mismatchOk =
    mismatchResult.verdict === 'TOURNAMENT' &&
    mismatchResult.matchRatio < 0.70
  details.push(
    `mismatch case: verdict=${mismatchResult.verdict} matchRatio=${mismatchResult.matchRatio.toFixed(2)} (<0.70 expected) — ${mismatchOk ? 'OK' : 'FAIL'}`,
  )

  // ---------- 4. Pre-condition not met → Gate 2 fail → TOURNAMENT ----------
  const patternPreCond: ContextFitInput = {
    module: 'llm-key-pool',
    protocolTier: 'T2-T3',
    dataScale: 'high-volume',
    loadProfile: 'concurrent',
    dependencies: ['multi-key-active'],
    environment: 'prod',
    timeConstraint: 'realtime',
    userPolicy: 'fail-fast',
    preConditions: ['circuit-breaker-installed'], // not in mission context
    contraindication: [],
    adaptationDelta: [],
  }
  const preCondResult = checkContextFit(patternPreCond, missionGood)
  const preCondOk =
    preCondResult.verdict === 'TOURNAMENT' &&
    preCondResult.preConditionsMet < preCondResult.preConditionsTotal
  details.push(
    `pre-condition case: verdict=${preCondResult.verdict} pre=${preCondResult.preConditionsMet}/${preCondResult.preConditionsTotal} — ${preCondOk ? 'OK' : 'FAIL'}`,
  )

  // ---------- 5. dimensionMatches present for all 8 dims ----------
  const dimsOk = Object.keys(goodResult.dimensionMatches).length === 8
  details.push(
    `dimensionMatches count=${Object.keys(goodResult.dimensionMatches).length} (expected 8) — ${dimsOk ? 'OK' : 'FAIL'}`,
  )

  const passed =
    contraOk &&
    contraReasonOk &&
    goodOk &&
    mismatchOk &&
    preCondOk &&
    dimsOk
  return {
    name: 'TC-17 context-fit',
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
      console.error('TC-17 uncaught:', err)
      process.exit(1)
    })
}

export { run }
