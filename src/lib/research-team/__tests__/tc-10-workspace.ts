/**
 * TC-10 — WORKSPACE READ-ONLY (TB-12 §3.2 + TB-01 §3 Live vs Workspace)
 * ==================================================================================
 * Spec:
 *  - BELI viết POC cho Option A trong mission M2 → POC + diff CHỈ trong Workspace
 *    (bản clone); Live System chỉ đọc (evidence).
 *  - Mọi file sửa nằm trong Workspace; log Live System KHÔNG đổi.
 *  - checkWorkspaceReadOnly pure: files nằm ngoài workspaceRoot → violations[].
 *
 * Pure function (path resolution only) — KHÔNG cần LLM/DB.
 */

import { checkWorkspaceReadOnly } from '@/lib/research-team/g2/rwv-loop'
import { defaultWorkspaceRoot } from '@/lib/research-team/proposal/git-branch'
import type { TestResult } from './_types'

async function run(): Promise<TestResult> {
  const details: string[] = []

  // ---------- 1. Mix: file trong workspace + file ngoài Live ----------
  // workspaceRoot chuẩn: workspace/research/<missionId>/ (TB-01 §3)
  const workspaceRoot = '/ws/research/MS-20260902-001'
  const files = [
    // Files trong workspace — clean
    '/ws/research/MS-20260902-001/src/lib/llm/key-pool.ts',
    '/ws/research/MS-20260902-001/poc-fail-fast.ts',
    // File ngoài workspace — Live System violation
    '/home/live/src/app/page.tsx',
    '/etc/config/production.json',
  ]

  const result = await checkWorkspaceReadOnly(files, workspaceRoot)
  const violationsOk =
    result.violations.length === 2 &&
    result.violations.includes('/home/live/src/app/page.tsx') &&
    result.violations.includes('/etc/config/production.json')
  const cleanOk = result.clean === false
  details.push(
    `mix case: violations=${result.violations.length} (expected 2) clean=${result.clean} (expected false) — ${violationsOk && cleanOk ? 'OK' : 'FAIL'}`,
  )
  if (result.violations.length > 0) {
    details.push(`violations: ${result.violations.join('; ')}`)
  }

  // ---------- 2. All files trong workspace → clean=true ----------
  const cleanFiles = [
    '/ws/research/MS-20260902-001/file1.ts',
    '/ws/research/MS-20260902-001/sub/file2.ts',
  ]
  const cleanResult = await checkWorkspaceReadOnly(cleanFiles, workspaceRoot)
  const cleanCaseOk = cleanResult.clean === true && cleanResult.violations.length === 0
  details.push(
    `all-in-workspace case: clean=${cleanResult.clean} violations=${cleanResult.violations.length} — ${cleanCaseOk ? 'OK' : 'FAIL'}`,
  )

  // ---------- 3. Relative paths resolved relative to workspaceRoot ----------
  const relFiles = ['src/lib/llm/key-pool.ts', 'poc.ts']
  const relResult = await checkWorkspaceReadOnly(relFiles, workspaceRoot)
  const relCaseOk = relResult.clean === true
  details.push(
    `relative-paths case: clean=${relResult.clean} (expected true) — ${relCaseOk ? 'OK' : 'FAIL'}`,
  )

  // ---------- 4. Path traversal attempt (../../etc/passwd) → violation ----------
  const traversalFiles = [
    '/ws/research/MS-20260902-001/../../etc/passwd',
    '/ws/research/MS-20260902-001/../../../home/live/secret.ts',
  ]
  const travResult = await checkWorkspaceReadOnly(traversalFiles, workspaceRoot)
  const travOk = travResult.violations.length === 2 && travResult.clean === false
  details.push(
    `path traversal case: violations=${travResult.violations.length} (expected 2) — ${travOk ? 'OK' : 'FAIL'}`,
  )

  // ---------- 5. defaultWorkspaceRoot(missionId) chuẩn TB-01 §3 ----------
  const wsDefault = defaultWorkspaceRoot('MS-20260902-001')
  const wsDefaultOk =
    wsDefault.includes('workspace/research/MS-20260902-001') &&
    !wsDefault.includes('live') &&
    !wsDefault.includes('/etc')
  details.push(
    `defaultWorkspaceRoot: "${wsDefault}" — contains workspace/research/<id> + NOT live — ${wsDefaultOk ? 'OK' : 'FAIL'}`,
  )

  const passed =
    violationsOk && cleanOk && cleanCaseOk && relCaseOk && travOk && wsDefaultOk
  return {
    name: 'TC-10 workspace read-only',
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
      console.error('TC-10 uncaught:', err)
      process.exit(1)
    })
}

export { run }
