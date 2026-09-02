/**
 * TC-15 — KILL-CRITERIA GATE (TB-12 §3.2 + TB-14 §1.2 + §3 + §10)
 * ==================================================================================
 * Spec:
 *  - Giả thiết KHÔNG thiết kế được kill-criteria → tối đa PROBABLE, KHÔNG thể CONFIRMED.
 *  - D2 tối đa 3 (không 5) khi thiếu killCriteria — caller phải downgrade.
 *  - DB HypothesisRecord.killCriteria NOT NULL khi status=CONFIRMED.
 *  - needsKillCriteria(result, killCriteria): CONFIRMED + null/empty killCriteria → true.
 *  - enforceKillCriteriaGate → grade hạ CONFIRMED → PROBABLE + thêm warning.
 *
 * Pure function — KHÔNG cần LLM/DB.
 */

import {
  scoreRubricA,
  needsKillCriteria,
  enforceKillCriteriaGate,
  type RubricAInput,
  type RubricArtifactRef,
} from '@/lib/research-team/scoring/rubric-a'
import type { TestResult } from './_types'

/** Helper — build artifacts cho tất cả 5 dim (≥3 dim cần artifact — anti-gaming AC3). */
function buildArtifacts(): RubricArtifactRef[] {
  return [
    { dimension: 'D1', ref: 'src/lib/llm/retry.ts:42' },
    { dimension: 'D2', ref: 'src/lib/llm/key-pool.ts:18' },
    { dimension: 'D3', ref: 'dev.log:121s-pattern' },
    { dimension: 'D4', ref: 'benchmark:rerun-stable' },
    { dimension: 'D5', ref: 'audit-report:root-cause' },
  ]
}

async function run(): Promise<TestResult> {
  const details: string[] = []

  // ---------- 1. scoreRubricA với D2=5 (causal confirmed) → grade CONFIRMED ----------
  // High scores cho mọi dim + artifacts → CONFIRMED.
  const input: RubricAInput = {
    d1_evidence: 5,
    d2_causal: 5,
    d3_consistent: 5,
    d4_reproducible: 5,
    d5_depth: 5,
    artifacts: buildArtifacts(),
  }
  const result = scoreRubricA(input)
  const confirmedOk = result.grade === 'CONFIRMED'
  details.push(
    `scoreRubricA(D2=5, all=5): score=${result.score.toFixed(2)} grade=${result.grade} — ${confirmedOk ? 'OK' : 'FAIL'}`,
  )

  // ---------- 2. needsKillCriteria(CONFIRMED, null) === true ----------
  const needsNull = needsKillCriteria(result, null)
  const needsNullOk = needsNull === true
  details.push(
    `needsKillCriteria(CONFIRMED, null): ${needsNull} (expected true) — ${needsNullOk ? 'OK' : 'FAIL'}`,
  )

  // ---------- 3. needsKillCriteria(CONFIRMED, "") === true (empty string) ----------
  const needsEmpty = needsKillCriteria(result, '')
  const needsEmptyOk = needsEmpty === true
  details.push(
    `needsKillCriteria(CONFIRMED, ""): ${needsEmpty} (expected true) — ${needsEmptyOk ? 'OK' : 'FAIL'}`,
  )

  // ---------- 4. needsKillCriteria(CONFIRMED, "evidence X") === false ----------
  const needsValid = needsKillCriteria(result, 'profile query count = 1 → hypothesis bị bác')
  const needsValidOk = needsValid === false
  details.push(
    `needsKillCriteria(CONFIRMED, "evidence X"): ${needsValid} (expected false) — ${needsValidOk ? 'OK' : 'FAIL'}`,
  )

  // ---------- 5. enforceKillCriteriaGate → grade hạ CONFIRMED → PROBABLE ----------
  const downgraded = enforceKillCriteriaGate(result, null)
  const downgradedOk =
    downgraded.grade === 'PROBABLE' &&
    downgraded.anchorWarnings.some((w) => w.includes('TC-15'))
  details.push(
    `enforceKillCriteriaGate(CONFIRMED, null): grade=${downgraded.grade} (expected PROBABLE) warnings include TC-15=${downgraded.anchorWarnings.some((w) => w.includes('TC-15'))} — ${downgradedOk ? 'OK' : 'FAIL'}`,
  )

  // ---------- 6. PROBABLE result → needsKillCriteria === false (no kill-criteria needed) ----------
  const probableInput: RubricAInput = {
    d1_evidence: 4,
    d2_causal: 4,
    d3_consistent: 3,
    d4_reproducible: 3,
    d5_depth: 3,
    artifacts: buildArtifacts(), // full 5 artifacts → no anti-gaming downgrade
  }
  const probableResult = scoreRubricA(probableInput)
  // Total = 4*0.30 + 4*0.25 + 3*0.15 + 3*0.15 + 3*0.15 = 1.2 + 1.0 + 0.45 + 0.45 + 0.45 = 3.55 → PROBABLE
  const probableOk = probableResult.grade === 'PROBABLE'
  const needsForProbable = needsKillCriteria(probableResult, null)
  const needsForProbableOk = needsForProbable === false
  details.push(
    `PROBABLE result: grade=${probableResult.grade} (score=${probableResult.score.toFixed(2)}) needsKillCriteria=${needsForProbable} (expected false — only CONFIRMED requires) — ${probableOk && needsForProbableOk ? 'OK' : 'FAIL'}`,
  )

  const passed =
    confirmedOk &&
    needsNullOk &&
    needsEmptyOk &&
    needsValidOk &&
    downgradedOk &&
    probableOk &&
    needsForProbableOk
  return {
    name: 'TC-15 kill-criteria gate',
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
      console.error('TC-15 uncaught:', err)
      process.exit(1)
    })
}

export { run }
