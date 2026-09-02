/**
 * TC-13 — DECOMPOSE GATE (TB-12 §3.2 + TB-07 §3 task template + §11 Q5 + DECISION-RECORD v1.3)
 * ==================================================================================
 * Spec:
 *  - task .md thiếu Success Criteria → council ① (post-DECOMPOSE, mandatory mọi mission)
 *    phát hiện thiếu → part KHÔNG được ASSIGN cho tới khi KING bổ đủ Success Criteria
 *    (append amendment theo DR-C3, có CHANGELOG entry).
 *  - validateSuccessCriteria pure: empty array → invalid, reason mentions 'Success Criteria'.
 *
 * Pure function — KHÔNG cần LLM/DB.
 */

import { validateSuccessCriteria, type TaskMdContent } from '@/lib/research-team/king/task-md'
import type { SuccessCriterion } from '@/lib/research-team/types'
import type { TestResult } from './_types'

/** Helper — build a base TaskMdContent with optional successCriteria override. */
function buildTaskMd(overrides: Partial<TaskMdContent> = {}): TaskMdContent {
  return {
    version: 1,
    taskId: 'T-MS-20260902-001-001',
    mission: 'MS-20260902-001',
    tier: 'T2',
    partIdx: 1,
    title: 'Audit key pool health check',
    description: 'Audit service-key-pool.ts health check logic',
    input: 'Existing key-pool.ts file + dev.log 121s',
    output: 'Diagnostic Report + root cause list',
    constraints: ['KHÔNG sửa Live System'],
    successCriteria: [],
    changelog: [],
    ...overrides,
  }
}

async function run(): Promise<TestResult> {
  const details: string[] = []

  // ---------- 1. Empty successCriteria → invalid ----------
  const empty = buildTaskMd({ successCriteria: [] })
  const result1 = validateSuccessCriteria(empty)
  const emptyInvalidOk = result1.valid === false
  const emptyReasonMentionsSc =
    !!result1.reason && result1.reason.includes('Success Criteria')
  details.push(
    `empty case: valid=${result1.valid} reason="${result1.reason ?? ''}" — ${emptyInvalidOk && emptyReasonMentionsSc ? 'OK' : 'FAIL'}`,
  )

  // ---------- 2. Criterion thiếu 'criterion' text → invalid ----------
  const missingText: SuccessCriterion[] = [
    { id: 'SC-1', criterion: '', measure: 'manual test' },
  ]
  const result2 = validateSuccessCriteria(buildTaskMd({ successCriteria: missingText }))
  const missingTextOk = result2.valid === false
  details.push(
    `missing-criterion case: valid=${result2.valid} reason="${result2.reason ?? ''}" — ${missingTextOk ? 'OK' : 'FAIL'}`,
  )

  // ---------- 3. Criterion thiếu 'measure' → invalid ----------
  const missingMeasure: SuccessCriterion[] = [
    { id: 'SC-1', criterion: 'Latency <10s', measure: '' },
  ]
  const result3 = validateSuccessCriteria(buildTaskMd({ successCriteria: missingMeasure }))
  const missingMeasureOk = result3.valid === false
  details.push(
    `missing-measure case: valid=${result3.valid} — ${missingMeasureOk ? 'OK' : 'FAIL'}`,
  )

  // ---------- 4. Valid successCriteria → valid=true ----------
  const validCriteria: SuccessCriterion[] = [
    {
      id: 'SC-1',
      criterion: 'Chat latency <10s (p95) khi 1 key fail',
      measure: 'Manual test "gửi 1 câu hỏi khi 1 key cố tình sai" + so sánh latency log trước/sau',
    },
    {
      id: 'SC-2',
      criterion: 'Key pool health check block 4xx',
      measure: 'Read key-pool.ts:42 + verify fail-fast branch exists',
    },
  ]
  const result4 = validateSuccessCriteria(buildTaskMd({ successCriteria: validCriteria }))
  const validOk = result4.valid === true
  details.push(
    `valid case: valid=${result4.valid} (expected true) reason="${result4.reason ?? '(none)'}" — ${validOk ? 'OK' : 'FAIL'}`,
  )

  // ---------- 5. null/undefined successCriteria → invalid ----------
  const result5 = validateSuccessCriteria(buildTaskMd({ successCriteria: undefined as unknown as SuccessCriterion[] }))
  const nullOk = result5.valid === false
  details.push(
    `null/undefined case: valid=${result5.valid} (expected false) — ${nullOk ? 'OK' : 'FAIL'}`,
  )

  const passed =
    emptyInvalidOk &&
    emptyReasonMentionsSc &&
    missingTextOk &&
    missingMeasureOk &&
    validOk &&
    nullOk
  return {
    name: 'TC-13 decompose gate (Success Criteria)',
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
      console.error('TC-13 uncaught:', err)
      process.exit(1)
    })
}

export { run }
