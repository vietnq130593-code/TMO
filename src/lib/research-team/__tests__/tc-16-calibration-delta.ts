/**
 * TC-16 — CALIBRATION DELTA (TB-12 §3.2 + TB-14 §2.3 scorecard kép + §10)
 * ==================================================================================
 * Spec:
 *  - Scorecard kỳ vọng 4.2 (pre-experiment) — thực đo 2.1 (post-experiment).
 *  - Delta >1.0 → lesson calibration ghi KB (KB category 'calibration').
 *  - Council ⑤ verdict = CONTINUE-ITERATE (KHÔNG CONVERGE).
 *  - computeScorecardDelta pure: deltas[] has entries with abs(delta)>1.0 + lessons[] non-empty.
 *
 * Pure function — KHÔNG cần LLM/DB.
 */

import { scoreRubricB, computeScorecardDelta, type RubricBInput } from '@/lib/research-team/scoring/rubric-b'
import type { TestResult } from './_types'

async function run(): Promise<TestResult> {
  const details: string[] = []

  // ---------- 1. Build expected scorecard (pre-experiment) total ~4.2 ----------
  // Expected high across all dims — total = 4.2
  // Try s1=5, s2=4, s3=4, s4=5, s5=4, s6=4 → total = 5*0.25 + 4*0.15 + 4*0.20 + 5*0.10 + 4*0.20 + 4*0.10
  // = 1.25 + 0.60 + 0.80 + 0.50 + 0.80 + 0.40 = 4.35 (≈4.2 — close enough)
  const expectedInput: RubricBInput = {
    s1_coverage: 5,
    s2_impact: 4,
    s3_risk: 4,
    s4_effort: 5,
    s5_contextFit: 4,
    s6_verify: 4,
  }
  const expected = scoreRubricB(expectedInput)
  const expectedOk = expected.total > 3.0 && (expected.grade === 'STRONG' || expected.grade === 'RECOMMENDED')
  details.push(
    `expected scorecard: total=${expected.total.toFixed(2)} grade=${expected.grade} — ${expectedOk ? 'OK' : 'FAIL'}`,
  )

  // ---------- 2. Build measured scorecard (post-experiment) total ~2.1 ----------
  // Measured low — total ~2.1 → CONDITIONAL
  // Try s1=3, s2=1, s3=2, s4=4, s5=2, s6=2 → total = 3*0.25 + 1*0.15 + 2*0.20 + 4*0.10 + 2*0.20 + 2*0.10
  // = 0.75 + 0.15 + 0.40 + 0.40 + 0.40 + 0.20 = 2.30 (≈2.1)
  const measuredInput: RubricBInput = {
    s1_coverage: 3,
    s2_impact: 1,
    s3_risk: 2,
    s4_effort: 4,
    s5_contextFit: 2,
    s6_verify: 2,
  }
  const measured = scoreRubricB(measuredInput)
  const measuredOk = measured.total < 3.0
  details.push(
    `measured scorecard: total=${measured.total.toFixed(2)} grade=${measured.grade} — ${measuredOk ? 'OK' : 'FAIL'}`,
  )

  // ---------- 3. computeScorecardDelta → deltas with abs(delta)>1.0 ----------
  const { deltas, lessons } = computeScorecardDelta(expected, measured)
  const flaggedDeltas = deltas.filter((d) => d.flag)
  const deltasOk = flaggedDeltas.length >= 1
  details.push(
    `computeScorecardDelta: deltas=${deltas.length} flagged(|delta|>1.0)=${flaggedDeltas.length} (≥1 expected) — ${deltasOk ? 'OK' : 'FAIL'}`,
  )
  if (flaggedDeltas.length > 0) {
    const sample = flaggedDeltas[0]
    details.push(
      `sample flagged delta: dim=${sample.dimension} expected=${sample.expected.toFixed(2)} measured=${sample.measured.toFixed(2)} delta=${sample.delta.toFixed(2)}`,
    )
  }

  // ---------- 4. lessons[] non-empty (calibration lesson refs) ----------
  const lessonsOk = lessons.length >= 1
  details.push(
    `lessons (calibration refs): count=${lessons.length} (≥1 expected) — ${lessonsOk ? 'OK' : 'FAIL'}`,
  )
  if (lessons.length > 0) {
    details.push(`sample lessonRef: ${lessons[0]}`)
  }

  // ---------- 5. S2 (Impact) delta >1.0 → optimism bias lesson (anti-pattern §2.3) ----------
  const s2Delta = deltas.find((d) => d.dimension === 'S2')
  // expected S2=4, measured S2=1 → delta = -3 < -1.0 → flag + optimism bias
  const s2Ok = !!s2Delta && s2Delta.flag && s2Delta.delta < -1.0
  details.push(
    `S2 delta: expected=${s2Delta?.expected.toFixed(2)} measured=${s2Delta?.measured.toFixed(2)} delta=${s2Delta?.delta.toFixed(2)} flagged=${s2Delta?.flag} (expected delta<-1.0 + flag) — ${s2Ok ? 'OK' : 'FAIL'}`,
  )

  // ---------- 6. No-delta case (expected===measured) → no flags ----------
  const same = scoreRubricB({ s1_coverage: 3, s2_impact: 3, s3_risk: 3, s4_effort: 3, s5_contextFit: 3, s6_verify: 3 })
  const { deltas: zeroDeltas, lessons: zeroLessons } = computeScorecardDelta(same, same)
  const zeroOk = zeroDeltas.every((d) => !d.flag) && zeroLessons.length === 0
  details.push(
    `zero-delta case: flagged=${zeroDeltas.filter((d) => d.flag).length} lessons=${zeroLessons.length} (both expected 0) — ${zeroOk ? 'OK' : 'FAIL'}`,
  )

  const passed =
    expectedOk && measuredOk && deltasOk && lessonsOk && s2Ok && zeroOk
  return {
    name: 'TC-16 calibration delta',
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
      console.error('TC-16 uncaught:', err)
      process.exit(1)
    })
}

export { run }
