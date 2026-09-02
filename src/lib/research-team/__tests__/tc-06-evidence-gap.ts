/**
 * TC-06 — EVIDENCE-GAP FILTER (TB-12 §3.2 + TB-04 §5 + §7 — fail-closed)
 * ==================================================================================
 * Spec:
 *  - LISMA chẩn đoán nhưng claim thiếu evidence (không file:line + log excerpt)
 *    → Claim bị loại khỏi Diagnostic Report (fail-closed).
 *  - filterClaimsWithEvidence pure function: accepted[] (có evidence) + rejected[] (gap).
 *  - API: POST /worklog với evidence gap → 400 (TC-06 invariant enforced).
 *
 * Pure function — KHÔNG cần LLM/DB.
 */

import { filterClaimsWithEvidence, validateEvidence } from '@/lib/research-team/g2/evidence-log'
import type { EvidenceItem } from '@/lib/research-team/types'
import type { TestResult } from './_types'

async function run(): Promise<TestResult> {
  const details: string[] = []

  // ---------- 1. Pure function: 2 claims, 1 có evidence + 1 thiếu ----------
  const claims = ['bug X — retry mù 4xx', 'bug Y — không timeout LLM']
  const evidence: EvidenceItem[] = [
    {
      claim: 'bug X',
      file: 'src/lib/llm/retry.ts',
      line: 42,
      excerpt: 'retry 3 times on 4xx without checking status code',
    },
    // bug Y — KHÔNG có evidence item match
  ]

  const filtered = filterClaimsWithEvidence(claims, evidence)
  const acceptedOk =
    filtered.accepted.length === 1 &&
    filtered.accepted[0].includes('bug X')
  const rejectedOk =
    filtered.rejected.length === 1 && filtered.rejected[0].includes('bug Y')
  details.push(
    `filterClaimsWithEvidence: accepted=${filtered.accepted.length} (expected 1) rejected=${filtered.rejected.length} (expected 1) — ${acceptedOk && rejectedOk ? 'OK' : 'FAIL'}`,
  )
  if (filtered.rejected.length > 0) {
    details.push(`rejected claim="${filtered.rejected[0].slice(0, 60)}"`)
  }

  // ---------- 2. validateEvidence full: valid=false khi có gap ----------
  const validation = validateEvidence(claims, evidence)
  const validFalseOk = validation.valid === false
  const gapsOk = validation.gaps.length === 1
  details.push(
    `validateEvidence: valid=${validation.valid} (expected false) gaps=${validation.gaps.length} (expected 1) — ${validFalseOk && gapsOk ? 'OK' : 'FAIL'}`,
  )

  // ---------- 3. Empty claims → valid=true (no gap by definition) ----------
  const emptyValid = validateEvidence([], evidence)
  const emptyOk = emptyValid.valid === true && emptyValid.gaps.length === 0
  details.push(
    `empty claims case: valid=${emptyValid.valid} gaps=${emptyValid.gaps.length} — ${emptyOk ? 'OK' : 'FAIL'}`,
  )

  // ---------- 4. All claims have evidence → valid=true ----------
  const allHaveEvidence: EvidenceItem[] = [
    { claim: 'bug X', file: 'f1.ts', line: 1, excerpt: 'e1' },
    { claim: 'bug Y', file: 'f2.ts', line: 2, excerpt: 'e2' },
  ]
  const allValid = validateEvidence(claims, allHaveEvidence)
  const allOk = allValid.valid === true && allValid.gaps.length === 0
  details.push(
    `all-have-evidence case: valid=${allValid.valid} gaps=${allValid.gaps.length} — ${allOk ? 'OK' : 'FAIL'}`,
  )

  const passed = acceptedOk && rejectedOk && validFalseOk && gapsOk && emptyOk && allOk
  return {
    name: 'TC-06 evidence-gap filter',
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
      console.error('TC-06 uncaught:', err)
      process.exit(1)
    })
}

export { run }
