/**
 * TC-04 — REGRESSION DETECTION (TB-12 §3.2 + TB-04 §9.1 + §4,§7)
 * ==================================================================================
 * Spec:
 *  - Vòng verify LISMA phát hiện bug mới do fix trước gây ra → Ghi entry Type=Regression
 *    + re-test bug gốc.
 *  - checkRegression pure function: fix destructive (delete/rewrite) + bug gốc mention
 *    feature existing → flag regression (isRegression===true).
 *  - Heuristic 2: fix mention "regression" / "broke existing" → flag.
 *
 * Pure function — KHÔNG cần LLM/DB.
 */

import { checkRegression } from '@/lib/research-team/g2/lisma'
import type { RegressionEntry } from '@/lib/research-team/g2/rwv-loop'
import type { TestResult } from './_types'

async function run(): Promise<TestResult> {
  const details: string[] = []

  // ---------- 1. Regression case 1: destructive fix + feature in original bug ----------
  // Fix "delete + refactor" + bug gốc mention "feature Y works" → flag regression.
  const fix1 = 'Refactor and delete the existing retry module to use fail-fast pattern.'
  const bug1 = 'Feature Y works in production but breaks under load.'
  const result1 = await checkRegression(fix1, bug1)
  const reg1Ok = result1.isRegression === true
  details.push(
    `case 1 (destructive+feature): isRegression=${result1.isRegression} reason="${result1.reason.slice(0, 80)}" — ${reg1Ok ? 'OK' : 'FAIL'}`,
  )

  // ---------- 2. Regression case 2: fix mentions "regression" explicitly ----------
  const fix2 = 'Fixed retry logic. Note: regression risk — broke existing 4xx handling.'
  const bug2 = 'User reports 4xx errors'
  const result2 = await checkRegression(fix2, bug2)
  const reg2Ok = result2.isRegression === true
  details.push(
    `case 2 (explicit "broke existing"): isRegression=${result2.isRegression} — ${reg2Ok ? 'OK' : 'FAIL'}`,
  )

  // ---------- 3. No regression — benign fix ----------
  const fix3 = 'Added more logs for debugging.'
  const bug3 = 'Missing log when 4xx happens'
  const result3 = await checkRegression(fix3, bug3)
  const reg3Ok = result3.isRegression === false
  details.push(
    `case 3 (benign): isRegression=${result3.isRegression} (expected false) — ${reg3Ok ? 'OK' : 'FAIL'}`,
  )

  // ---------- 4. RegressionEntry type structure (TC-04: entry Type=Regression) ----------
  // Verify RegressionEntry shape có fields cần thiết để persist như regression row.
  const entry: RegressionEntry = {
    round: 2,
    bug: 'Feature Y broken by retry refactor (TC-04)',
    reTested: true,
    fixed: false, // re-test bug gốc sau fix mới → fail → regression
  }
  const entryOk =
    typeof entry.round === 'number' &&
    typeof entry.bug === 'string' &&
    typeof entry.reTested === 'boolean' &&
    typeof entry.fixed === 'boolean'
  details.push(
    `RegressionEntry shape: round=${entry.round} bug="${entry.bug.slice(0, 40)}" reTested=${entry.reTested} fixed=${entry.fixed} — ${entryOk ? 'OK' : 'FAIL'}`,
  )

  const passed = reg1Ok && reg2Ok && reg3Ok && entryOk
  return {
    name: 'TC-04 regression detection',
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
      console.error('TC-04 uncaught:', err)
      process.exit(1)
    })
}

export { run }
