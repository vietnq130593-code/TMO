/**
 * TC-03 — CONFLICT DETECTION (TB-12 §3.2 + TB-03 §5.3 — dual-interpretation escalation)
 * ==================================================================================
 * Spec:
 *  - 2 sub-agents trả kết quả trái ngược về cùng chủ đề → SIVIL flag conflict.
 *  - detectConflicts pure function: hasConflict===true + conflictPairs.length>=1.
 *  - engine.ts runG1Round sẽ ESCALATE khi conflicts.length > 0 (KHÔNG tự giải quyết).
 *
 * Pure function — KHÔNG cần LLM/DB.
 */

import { detectConflicts, type SubAgent } from '@/lib/research-team/g1/sub-agents'
import { readFileSync } from 'fs'
import { join } from 'path'
import type { TestResult } from './_types'

async function run(): Promise<TestResult> {
  const details: string[] = []

  // ---------- 1. Pure function: 2 SA conflicting results ----------
  // SA-1 (positive — keep existing retry + add health check)
  const sa1: SubAgent = {
    id: 'SA-07',
    label: 'Audit key pool',
    task: 'Audit service-key-pool.ts',
    status: 'DONE',
    result:
      'Audit key pool retry mù 4xx — keep existing retry, add health check before next retry.',
    evidence: ['src/lib/llm/key-pool.ts:42'],
  }
  // SA-2 (negative — drop retry entirely, replace with fail-fast)
  const sa2: SubAgent = {
    id: 'SA-09',
    label: 'Audit retry logic',
    task: 'Audit retry.ts',
    status: 'DONE',
    result:
      'Audit key pool retry mù 4xx — drop retry, remove entirely and replace with fail-fast pattern.',
    evidence: ['src/lib/llm/retry.ts:18'],
  }

  const conflict = detectConflicts([sa1, sa2])
  const hasConflictOk = conflict.hasConflict === true
  const pairsOk = conflict.conflictPairs.length >= 1
  details.push(
    `detectConflicts: hasConflict=${conflict.hasConflict} pairs=${conflict.conflictPairs.length} — ${hasConflictOk && pairsOk ? 'OK' : 'FAIL'}`,
  )
  if (conflict.conflictPairs.length > 0) {
    const summary = conflict.conflictPairs[0].summary.slice(0, 100)
    details.push(`conflict summary="${summary}..."`)
  }

  // ---------- 2. No conflict — 2 SA cùng chiều ----------
  const sa3: SubAgent = {
    id: 'SA-10',
    label: 'Audit cache layer',
    task: 'Audit response cache',
    status: 'DONE',
    result: 'Cache layer hiện tại OK — không phát hiện vấn đề gì cần sửa.',
  }
  const sa4: SubAgent = {
    id: 'SA-11',
    label: 'Audit timeout config',
    task: 'Audit timeout',
    status: 'DONE',
    result: 'Timeout config hiện tại ổn — không phát hiện vấn đề cần sửa.',
  }
  const noConflict = detectConflicts([sa3, sa4])
  const noConflictOk = noConflict.hasConflict === false
  details.push(
    `noConflict case: hasConflict=${noConflict.hasConflict} (expected false) — ${noConflictOk ? 'OK' : 'FAIL'}`,
  )

  // ---------- 3. Code structure: runG1Round escalates on conflict ----------
  // Inspect g1/engine.ts source — verify "conflicts.length > 0" branch returns escalated=true.
  let codeInspectionOk = false
  try {
    const enginePath = join(
      process.cwd(),
      'src/lib/research-team/g1/engine.ts',
    )
    const src = readFileSync(enginePath, 'utf-8')
    const hasConflictsCheck = src.includes('sivilResult.conflicts.length > 0')
    const hasEscalatedReturn = src.includes('escalated: true')
    codeInspectionOk = hasConflictsCheck && hasEscalatedReturn
    details.push(
      `g1/engine.ts has "conflicts.length > 0" check (${hasConflictsCheck}) + "escalated: true" return (${hasEscalatedReturn}) — ${codeInspectionOk ? 'OK' : 'FAIL'}`,
    )
  } catch (err) {
    details.push(
      `code inspection failed: ${err instanceof Error ? err.message : String(err)} — FAIL`,
    )
  }

  const passed = hasConflictOk && pairsOk && noConflictOk && codeInspectionOk
  return {
    name: 'TC-03 conflict detection',
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
      console.error('TC-03 uncaught:', err)
      process.exit(1)
    })
}

export { run }
