/**
 * TC-07 — COUNCIL ② ORDER (TB-12 §3.2 + TB-03 §4 §4.4)
 * ==================================================================================
 * Spec:
 *  - Thứ tự log: SYNTHESIZE → council ② → SPEC → BELI code.
 *  - runG1Round trong g1/engine.ts ENFORCE thứ tự: council ① → SIVIL SYNTHESIZE →
 *    council ② → BELI SPEC (KHÔNG có spec nào đến tay BELI trước khi COUNCIL_DONE).
 *
 * Code inspection test — verify engine.ts source có thứ tự đúng. KHÔNG cần LLM/DB.
 */

import { readFileSync } from 'fs'
import { join } from 'path'
import type { TestResult } from './_types'

async function run(): Promise<TestResult> {
  const details: string[] = []

  const enginePath = join(process.cwd(), 'src/lib/research-team/g1/engine.ts')
  const src = readFileSync(enginePath, 'utf-8')

  // ---------- 1. Verify "TC-07" marker in orderLog ----------
  const hasTc07Marker = src.includes('Order enforced (TC-07):')
  details.push(`orderLog has "Order enforced (TC-07):" marker — ${hasTc07Marker ? 'OK' : 'FAIL'}`)

  // ---------- 2. Verify sequential step comments ----------
  const hasStep1 = src.includes('STEP 1: Council ①')
  const hasStep2 = src.includes('STEP 2: SIVIL SYNTHESIZE')
  const hasStep3 = src.includes('STEP 3: Council ②')
  const hasStep4 = src.includes('STEP 4: BELI SPEC')
  const stepsOk = hasStep1 && hasStep2 && hasStep3 && hasStep4
  details.push(
    `sequential STEP markers: ①=${hasStep1} SYNTHESIZE=${hasStep2} ②=${hasStep3} SPEC=${hasStep4} — ${stepsOk ? 'OK' : 'FAIL'}`,
  )

  // ---------- 3. Verify order in source (line positions) ----------
  const line1Idx = src.indexOf('STEP 1: Council ①')
  const line2Idx = src.indexOf('STEP 2: SIVIL SYNTHESIZE')
  const line3Idx = src.indexOf('STEP 3: Council ②')
  const line4Idx = src.indexOf('STEP 4: BELI SPEC')
  const orderOk =
    line1Idx >= 0 &&
    line2Idx > line1Idx &&
    line3Idx > line2Idx &&
    line4Idx > line3Idx
  details.push(
    `order positions: ①@${line1Idx} SYNTH@${line2Idx} ②@${line3Idx} SPEC@${line4Idx} (ascending) — ${orderOk ? 'OK' : 'FAIL'}`,
  )

  // ---------- 4. Verify "① → SYNTHESIZE → ② → SPEC" string in orderLog ----------
  const orderStringOk = src.includes('① → SYNTHESIZE → ② → SPEC')
  details.push(
    `orderLog string "① → SYNTHESIZE → ② → SPEC" present — ${orderStringOk ? 'OK' : 'FAIL'}`,
  )

  // ---------- 5. Verify council ① VETO returns early (gate TC-13) ----------
  const vetoEarlyReturn = src.includes("verdict === 'VETO'") && src.includes('escalated: true')
  details.push(
    `council ① VETO returns escalated=true (early return) — ${vetoEarlyReturn ? 'OK' : 'FAIL'}`,
  )

  // ---------- 6. Verify council ② has REVISE + VETO branches ----------
  const council2Revise = src.includes("council2.verdict === 'REVISE'")
  const council2Veto = src.includes("council2.verdict === 'VETO'")
  const council2BranchesOk = council2Revise || council2Veto
  details.push(
    `council ② branches: REVISE check=${council2Revise} VETO check=${council2Veto} — ${council2BranchesOk ? 'OK' : 'FAIL'}`,
  )

  const passed =
    hasTc07Marker &&
    stepsOk &&
    orderOk &&
    orderStringOk &&
    vetoEarlyReturn &&
    council2BranchesOk
  return {
    name: 'TC-07 council ② order',
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
      console.error('TC-07 uncaught:', err)
      process.exit(1)
    })
}

export { run }
