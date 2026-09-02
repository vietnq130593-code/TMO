/**
 * GOLDEN-RUN — P7 E2E pipeline (TB-12 §3.2 + TB-13 §10 DoD mục 3)
 * ==================================================================================
 * Spec:
 *  - Run tất cả 18 TC tuần tự, collect results.
 *  - Add 1 E2E mission mẫu qua API:
 *      POST /missions (ambiguous) → GET /missions/[id] → PATCH clarify →
 *      POST /decompose → POST /monitor → POST /finalize → POST /proposals →
 *      POST /proposals/[id]/review (APPROVE by user) → verify pipeline structure
 *      (KHÔNG require LLM success — verify fail-open graceful + DB persistence +
 *       status transitions).
 *  - Output: { total: 18, passed: N, failed: M, results[], e2eMission }
 *  - Save JSON to /home/z/my-project/tool-results/golden-run-v1.json
 *  - Exit 0 if all pass, 1 if any fail.
 *
 * Fail-open policy: nếu API endpoint 500/timeout (LLM unavailable) → mark TC fail
 * với details "LLM unavailable — fail-open path verified, full flow needs real NIM key".
 */

import { writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import type { TestResult } from './_types'

import { run as tc01 } from './tc-01-classify'
import { run as tc02 } from './tc-02-m2-pipeline'
import { run as tc03 } from './tc-03-conflict'
import { run as tc04 } from './tc-04-regression'
import { run as tc05 } from './tc-05-kb-coldstart'
import { run as tc06 } from './tc-06-evidence-gap'
import { run as tc07 } from './tc-07-council2-order'
import { run as tc08 } from './tc-08-t1-capture'
import { run as tc09 } from './tc-09-pivot'
import { run as tc10 } from './tc-10-workspace'
import { run as tc11 } from './tc-11-rejected'
import { run as tc12 } from './tc-12-model-switch'
import { run as tc13 } from './tc-13-decompose-gate'
import { run as tc14 } from './tc-14-handoff-gate'
import { run as tc15 } from './tc-15-kill-criteria'
import { run as tc16 } from './tc-16-calibration-delta'
import { run as tc17 } from './tc-17-context-fit'
import { run as tc18 } from './tc-18-deploy-route'

const TC_RUNNERS: Array<() => Promise<TestResult>> = [
  tc01, tc02, tc03, tc04, tc05, tc06, tc07, tc08, tc09,
  tc10, tc11, tc12, tc13, tc14, tc15, tc16, tc17, tc18,
]

// ============================================================
// §1. E2E MISSION SAMPLE (fail-open aware)
// ============================================================

interface E2EMissionResult {
  id: string | null
  code: string | null
  status: string | null
  tier: string | null
  proposalCode: string | null
  proposalStatus: string | null
  pipelineStepsCompleted: string[]
  errors: string[]
  note: string
}

/**
 * E2E mission sample — chạy pipeline mission qua API.
 * Mỗi step wrap try/catch — KHÔNG crash nếu 1 step fail. Verify status transitions
 * + DB persistence (KHÔNG require LLM success).
 */
async function runE2EMission(): Promise<E2EMissionResult> {
  const result: E2EMissionResult = {
    id: null,
    code: null,
    status: null,
    tier: null,
    proposalCode: null,
    proposalStatus: null,
    pipelineStepsCompleted: [],
    errors: [],
    note: '',
  }

  const BASE = 'http://localhost:3000'
  const steps = result.pipelineStepsCompleted

  // ---------- Step 1: POST /missions (ambiguous) ----------
  try {
    const resp = await fetch(`${BASE}/api/research/missions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        request: 'cải thiện mọi thứ trong hệ thống chat',
        title: 'Golden-run E2E mission',
      }),
    })
    if (resp.status === 201) {
      const body = (await resp.json()) as {
        status: string
        mission?: { id: string; code: string; status: string; tier?: string }
      }
      if (body.mission) {
        result.id = body.mission.id
        result.code = body.mission.code
        result.status = body.mission.status
        result.tier = body.mission.tier ?? ''
        steps.push(`POST /missions → ${body.status} (id=${body.mission.id.slice(-6)})`)
      }
    } else {
      result.errors.push(`POST /missions → ${resp.status}`)
    }
  } catch (err) {
    result.errors.push(`POST /missions threw: ${err instanceof Error ? err.message : String(err)}`)
  }

  if (!result.id) {
    result.note = 'E2E aborted: POST /missions failed (LLM unavailable or server error).'
    return result
  }

  // ---------- Step 2: GET /missions/[id] ----------
  try {
    const resp = await fetch(`${BASE}/api/research/missions/${result.id}`)
    if (resp.status === 200) {
      const body = (await resp.json()) as { mission?: { status: string; tier?: string } }
      result.status = body.mission?.status ?? result.status
      result.tier = body.mission?.tier ?? result.tier
      steps.push(`GET /missions/[id] → status=${result.status}`)
    }
  } catch (err) {
    result.errors.push(`GET /missions/[id] threw: ${err instanceof Error ? err.message : String(err)}`)
  }

  // ---------- Step 3: PATCH /missions/[id] — force transition to TRIAGING ----------
  try {
    const resp = await fetch(`${BASE}/api/research/missions/${result.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        status: 'TRIAGING',
        tier: 'T2',
        decision: {
          agent: 'KING',
          decision: 'CONTINUE',
          reason: 'Golden-run: user clarify — chẩn đoán chat latency 121s',
        },
      }),
    })
    if (resp.status === 200) {
      const body = (await resp.json()) as { mission?: { status: string; tier?: string } }
      result.status = body.mission?.status ?? result.status
      result.tier = body.mission?.tier ?? result.tier
      steps.push(`PATCH clarify → TRIAGING/T2`)
    } else {
      const errBody = await resp.text().catch(() => '')
      result.errors.push(`PATCH /missions/[id] TRIAGING → ${resp.status}: ${errBody.slice(0, 80)}`)
    }
  } catch (err) {
    result.errors.push(`PATCH clarify threw: ${err instanceof Error ? err.message : String(err)}`)
  }

  // ---------- Step 4: PATCH → DECOMPOSING → RESEARCHING ----------
  for (const target of ['DECOMPOSING', 'RESEARCHING']) {
    try {
      const resp = await fetch(`${BASE}/api/research/missions/${result.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status: target,
          decision: {
            agent: 'KING',
            decision: 'CONTINUE',
            reason: `Golden-run: transition to ${target}`,
          },
        }),
      })
      if (resp.status === 200) {
        const body = (await resp.json()) as { mission?: { status: string } }
        result.status = body.mission?.status ?? result.status
        steps.push(`PATCH → ${target}`)
      } else {
        result.errors.push(`PATCH ${target} → ${resp.status}`)
      }
    } catch (err) {
      result.errors.push(`PATCH ${target} threw: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // ---------- Step 5: POST /missions/[id]/decompose ----------
  try {
    const resp = await fetch(`${BASE}/api/research/missions/${result.id}/decompose`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parts: 1 }),
    })
    if (resp.status === 200 || resp.status === 201) {
      steps.push(`POST /decompose → ${resp.status}`)
    } else {
      const errBody = await resp.text().catch(() => '')
      result.errors.push(`POST /decompose → ${resp.status}: ${errBody.slice(0, 80)}`)
    }
  } catch (err) {
    result.errors.push(`POST /decompose threw: ${err instanceof Error ? err.message : String(err)}`)
  }

  // ---------- Step 6: POST /missions/[id]/monitor ----------
  try {
    const resp = await fetch(`${BASE}/api/research/missions/${result.id}/monitor`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    if (resp.status === 200 || resp.status === 201) {
      steps.push(`POST /monitor → ${resp.status}`)
    } else {
      const errBody = await resp.text().catch(() => '')
      result.errors.push(`POST /monitor → ${resp.status}: ${errBody.slice(0, 80)}`)
    }
  } catch (err) {
    result.errors.push(`POST /monitor threw: ${err instanceof Error ? err.message : String(err)}`)
  }

  // ---------- Step 7: POST /missions/[id]/finalize ----------
  try {
    const resp = await fetch(`${BASE}/api/research/missions/${result.id}/finalize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    if (resp.status === 200 || resp.status === 201) {
      steps.push(`POST /finalize → ${resp.status}`)
      // Read final status
      const body = (await resp.json()) as { mission?: { status: string } }
      if (body.mission?.status) result.status = body.mission.status
    } else {
      const errBody = await resp.text().catch(() => '')
      result.errors.push(`POST /finalize → ${resp.status}: ${errBody.slice(0, 80)}`)
    }
  } catch (err) {
    result.errors.push(`POST /finalize threw: ${err instanceof Error ? err.message : String(err)}`)
  }

  // ---------- Step 8: POST /proposals (create DRAFT) ----------
  try {
    const resp = await fetch(`${BASE}/api/research/proposals`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        missionId: result.id,
        title: 'Golden-run proposal — fail-fast + key health check',
        summary: 'Option A+B: fail-fast 4xx + key health check — 121s → <10s',
        changes: [
          'src/lib/llm/key-pool.ts — add health check + fail-fast on 4xx',
          'src/lib/llm/retry.ts — remove retry mù for 4xx, add timeout 30s',
        ],
        verificationPlan: [
          '(a) NGAY: so sánh latency log trước/sau + manual test',
          '(b) DEFERRED: benchmark A/B p50/p95 chat latency',
        ],
      }),
    })
    if (resp.status === 201) {
      const body = (await resp.json()) as {
        proposal?: { id: string; code: string; status: string }
      }
      result.proposalCode = body.proposal?.code ?? null
      result.proposalStatus = body.proposal?.status ?? null
      steps.push(`POST /proposals → ${body.proposal?.code} status=${body.proposal?.status}`)

      // ---------- Step 9: Submit + Approve proposal (by user — DR-C5 §C5) ----------
      if (body.proposal?.id) {
        // Submit
        const submitResp = await fetch(`${BASE}/api/research/proposals`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'submit', id: body.proposal.id }),
        })
        if (submitResp.status === 200) {
          const submitBody = (await submitResp.json()) as { proposal?: { status: string } }
          result.proposalStatus = submitBody.proposal?.status ?? result.proposalStatus
          steps.push(`POST /proposals submit → ${result.proposalStatus}`)

          // Approve by user (NOT KING — DR-C5 §C5)
          const reviewResp = await fetch(
            `${BASE}/api/research/proposals/${body.proposal.id}/review`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                decision: 'APPROVE',
                reviewedBy: 'user',
              }),
            },
          )
          if (reviewResp.status === 200) {
            const reviewBody = (await reviewResp.json()) as {
              proposal?: { status: string }
            }
            result.proposalStatus = reviewBody.proposal?.status ?? result.proposalStatus
            steps.push(`POST /review APPROVE → ${result.proposalStatus}`)
          } else {
            const errBody = await reviewResp.text().catch(() => '')
            result.errors.push(`POST /review APPROVE → ${reviewResp.status}: ${errBody.slice(0, 80)}`)
          }
        } else {
          result.errors.push(`POST /proposals submit → ${submitResp.status}`)
        }
      }
    } else {
      const errBody = await resp.text().catch(() => '')
      result.errors.push(`POST /proposals create → ${resp.status}: ${errBody.slice(0, 80)}`)
    }
  } catch (err) {
    result.errors.push(`POST /proposals threw: ${err instanceof Error ? err.message : String(err)}`)
  }

  // ---------- Note về LLM availability ----------
  if (result.errors.length > 0) {
    result.note = `LLM unavailable (NIM placeholder) — pipeline ran with fail-open paths; ${result.errors.length} step(s) returned non-2xx. Full E2E needs real NIM key.`
  } else {
    result.note = 'Pipeline completed all steps successfully (fail-open paths verified).'
  }

  return result
}

// ============================================================
// §2. MAIN — run 18 TC + E2E + write JSON
// ============================================================

async function main(): Promise<void> {
  console.log('=== Golden-run P7 E2E — 18 TC + 1 mission sample ===\n')

  // ---------- 1. Run 18 TC tuần tự ----------
  const results: TestResult[] = []
  for (let i = 0; i < TC_RUNNERS.length; i++) {
    const runner = TC_RUNNERS[i]
    const tcId = `TC-${String(i + 1).padStart(2, '0')}`
    process.stdout.write(`[${tcId}] running... `)
    try {
      const r = await runner()
      results.push(r)
      console.log(`${r.passed ? 'PASS' : 'FAIL'} — ${r.name}`)
      if (!r.passed) {
        console.log(`    details: ${r.details.slice(0, 200)}`)
      }
    } catch (err) {
      // Uncaught — fail gracefully
      const r: TestResult = {
        name: `${tcId} (uncaught)`,
        passed: false,
        details: `UNCAUGHT: ${err instanceof Error ? err.message : String(err)}`,
      }
      results.push(r)
      console.log(`FAIL — ${r.name}: ${r.details.slice(0, 200)}`)
    }
  }

  // ---------- 2. Run E2E mission sample ----------
  console.log('\n[E2E] running mission sample pipeline...')
  const e2eMission = await runE2EMission()
  console.log(`[E2E] mission id=${e2eMission.id ?? '(none)'} status=${e2eMission.status}`)
  console.log(`[E2E] steps completed: ${e2eMission.pipelineStepsCompleted.length}`)
  e2eMission.pipelineStepsCompleted.forEach((s) => console.log(`     ✓ ${s}`))
  if (e2eMission.errors.length > 0) {
    console.log(`[E2E] ${e2eMission.errors.length} step(s) failed (LLM unavailable expected):`)
    e2eMission.errors.forEach((e) => console.log(`     ✗ ${e.slice(0, 120)}`))
  }
  console.log(`[E2E] note: ${e2eMission.note}`)

  // ---------- 3. Compute summary ----------
  const passed = results.filter((r) => r.passed).length
  const failed = results.length - passed

  const summary = {
    timestamp: new Date().toISOString(),
    total: results.length,
    passed,
    failed,
    passRate: `${((passed / results.length) * 100).toFixed(1)}%`,
    results: results.map((r) => ({
      name: r.name,
      passed: r.passed,
      details: r.details,
    })),
    e2eMission: {
      id: e2eMission.id,
      code: e2eMission.code,
      status: e2eMission.status,
      tier: e2eMission.tier,
      proposalCode: e2eMission.proposalCode,
      proposalStatus: e2eMission.proposalStatus,
      pipelineStepsCompleted: e2eMission.pipelineStepsCompleted,
      stepErrors: e2eMission.errors,
      note: e2eMission.note,
    },
  }

  // ---------- 4. Write JSON to /home/z/my-project/tool-results/golden-run-v1.json ----------
  const outputDir = '/home/z/my-project/tool-results'
  const outputPath = join(outputDir, 'golden-run-v1.json')
  try {
    mkdirSync(outputDir, { recursive: true })
    writeFileSync(outputPath, JSON.stringify(summary, null, 2))
    console.log(`\n[OUTPUT] JSON written to ${outputPath}`)
  } catch (err) {
    console.error(`\n[OUTPUT] Failed to write JSON: ${err instanceof Error ? err.message : String(err)}`)
  }

  // ---------- 5. Summary print ----------
  console.log('\n=== SUMMARY ===')
  console.log(`TCs: ${passed}/${results.length} passed (${summary.passRate})`)
  console.log(`E2E mission: id=${e2eMission.id ?? '(none)'} status=${e2eMission.status} proposalCode=${e2eMission.proposalCode ?? '(none)'}`)
  if (failed > 0) {
    console.log('\nFailed TCs:')
    results.filter((r) => !r.passed).forEach((r) => {
      console.log(`  ✗ ${r.name}`)
      console.log(`    ${r.details.slice(0, 250)}`)
    })
  }

  // Exit code: 0 if all pass, 1 if any fail
  process.exit(failed === 0 ? 0 : 1)
}

if (import.meta.main) {
  main().catch((err) => {
    console.error('Golden-run uncaught:', err)
    process.exit(1)
  })
}

export { main }
