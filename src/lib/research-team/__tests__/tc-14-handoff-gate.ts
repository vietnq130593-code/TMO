/**
 * TC-14 — HANDOFF GATE (TB-12 §3.2 + TB-09 §10 E4 + TB-10 §13 Q6 + DECISION-RECORD v1.3)
 * ==================================================================================
 * Spec:
 *  - Worklog thiếu Artifact Map → gate handoff chặn — KHÔNG giao group kế.
 *  - SIVIL phải bổ sung map (1 map G1 duy nhất — TB-10 §13 Q6) trước khi KING
 *    MONITOR pass.
 *  - validateArtifactMap pure: null/undefined → invalid, reason mentions 'Artifact Map'.
 *  - checkHandoffGate with task having no worklog → passed=false, reason mentions 'worklog'.
 *
 * Pure function (validateArtifactMap) + DB-backed (checkHandoffGate).
 */

import { validateArtifactMap } from '@/lib/research-team/g1/artifact-map'
import { checkHandoffGate } from '@/lib/research-team/handoff'
import type { TestResult } from './_types'

async function run(): Promise<TestResult> {
  const details: string[] = []

  // ---------- 1. validateArtifactMap(null) → invalid ----------
  const nullResult = validateArtifactMap(null)
  const nullInvalidOk = nullResult.valid === false
  const nullReasonOk =
    !!nullResult.reason && nullResult.reason.includes('Artifact Map')
  details.push(
    `validateArtifactMap(null): valid=${nullResult.valid} reason="${nullResult.reason ?? ''}" — ${nullInvalidOk && nullReasonOk ? 'OK' : 'FAIL'}`,
  )

  // ---------- 2. validateArtifactMap(undefined) → invalid ----------
  const undefinedResult = validateArtifactMap(undefined)
  const undefInvalidOk = undefinedResult.valid === false
  details.push(
    `validateArtifactMap(undefined): valid=${undefinedResult.valid} — ${undefInvalidOk ? 'OK' : 'FAIL'}`,
  )

  // ---------- 3. validateArtifactMap(empty entries) → invalid ----------
  const emptyMap = {
    missionId: 'MS-001',
    taskId: 'T-001',
    generatedAt: new Date().toISOString(),
    complete: false,
    entries: [],
  }
  const emptyMapResult = validateArtifactMap(emptyMap)
  const emptyMapOk = emptyMapResult.valid === false
  details.push(
    `validateArtifactMap(empty entries): valid=${emptyMapResult.valid} reason="${emptyMapResult.reason ?? ''}" — ${emptyMapOk ? 'OK' : 'FAIL'}`,
  )

  // ---------- 4. checkHandoffGate with non-existent task → passed=false ----------
  // Should return gate with passed=false + reason mentioning worklog/task không tồn tại.
  const gateResult = await checkHandoffGate(
    'nonexistent-task-tc14-xxxx',
    'G1',
    'G2',
  )
  const gatePassedOk = gateResult.passed === false
  const gateReasonMentionsWorklog =
    !!gateResult.reason && (gateResult.reason.includes('worklog') || gateResult.reason.includes('không tồn tại'))
  details.push(
    `checkHandoffGate(nonexistent task): passed=${gateResult.passed} reason="${gateResult.reason?.slice(0, 100) ?? ''}" — ${gatePassedOk && gateReasonMentionsWorklog ? 'OK' : 'FAIL'}`,
  )

  // ---------- 5. checkHandoffGate fields present ----------
  const fieldsOk =
    typeof gateResult.taskId === 'string' &&
    typeof gateResult.fromGroup === 'string' &&
    typeof gateResult.toGroup === 'string' &&
    typeof gateResult.artifactMapPresent === 'boolean' &&
    typeof gateResult.successCriteriaMet === 'boolean' &&
    typeof gateResult.evidenceComplete === 'boolean'
  details.push(
    `HandoffGate fields present (taskId/fromGroup/toGroup/artifactMapPresent/...) — ${fieldsOk ? 'OK' : 'FAIL'}`,
  )

  // ---------- 6. validateArtifactMap valid map → valid=true ----------
  const validMap = {
    missionId: 'MS-001',
    taskId: 'T-001',
    generatedAt: new Date().toISOString(),
    complete: true,
    entries: [
      {
        id: 'A1',
        type: 'code' as const,
        relevance: 'core-target' as const,
        status: 'audited' as const,
        path: 'src/lib/llm/key-pool.ts',
        note: 'key pool health check',
      },
    ],
  }
  const validMapResult = validateArtifactMap(validMap)
  const validMapOk = validMapResult.valid === true
  details.push(
    `validateArtifactMap(valid map): valid=${validMapResult.valid} — ${validMapOk ? 'OK' : 'FAIL'}`,
  )

  const passed =
    nullInvalidOk &&
    nullReasonOk &&
    undefInvalidOk &&
    emptyMapOk &&
    gatePassedOk &&
    gateReasonMentionsWorklog &&
    fieldsOk &&
    validMapOk
  return {
    name: 'TC-14 handoff gate (Artifact Map)',
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
      console.error('TC-14 uncaught:', err)
      process.exit(1)
    })
}

export { run }
