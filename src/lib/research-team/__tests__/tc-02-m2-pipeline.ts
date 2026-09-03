/**
 * TC-02 — M2/T2 PIPELINE → PROPOSAL 1-MODULE (TB-12 §3.2 + TB-02 §5 routing matrix)
 * ==================================================================================
 * Spec:
 *  - Mission M2 tier T2 (vd "chẩn đoán chat latency cao") → pipeline NEMESIS → G1 →
 *    LISMA → NEMESIS; output = Proposal 1-module (KHÔNG final report user).
 *  - TB-02 §5 routing matrix 9 ô — M2/T2 → Proposal (không User-report như M1).
 *  - TB-11 §1 — Proposal schema 8 trường; lifecycle DRAFT → SUBMITTED → APPROVED.
 *
 * Môi trường: NIM placeholder → KHÔNG require LLM success. Verify CODE STRUCTURE:
 *  1. mission-store.createMission với missionType='M2', tier='T2', confidence HIGH
 *     → status TRIAGING, tier='T2'.
 *  2. proposal/store.createProposal chấp nhận mission này → Proposal DRAFT (1-module).
 *  3. Proposal có changes[] + verificationPlan[] (TB-11 §1 schema 1-module).
 */

import { createMission } from '@/lib/research-team/mission-store'
import { createProposal } from '@/lib/research-team/proposal/store'
import { db } from '@/lib/db'
import type { TestResult } from './_types'

async function run(): Promise<TestResult> {
  const details: string[] = []
  let missionId: string | undefined
  let proposalId: string | undefined

  try {
    // ---------- 1. Create M2/T2 mission (HIGH confidence → TRIAGING + tier set) ----------
    const mission = await createMission({
      request: 'Chẩn đoán chat latency 121s khi LLM key fail (TC-02)',
      title: 'TC-02 M2/T2 pipeline test',
      missionType: 'M2',
      tier: 'T2',
      confidence: {
        signals: ['logs mention 121s', 'system config', 'LLM key rotation issue'],
        conflicts: [],
        level: 'HIGH',
      },
      initialDecisionLog: [
        {
          at: new Date().toISOString(),
          agent: 'NEMESIS',
          decision: 'RESEARCH',
          reason: 'TC-02: M2/T2 HIGH confidence — chẩn đoán chat latency',
        },
      ],
    })
    missionId = mission.id
    const m2Ok = mission.missionType === 'M2'
    const t2Ok = mission.tier === 'T2'
    const triagingOk = mission.status === 'TRIAGING'
    details.push(
      `mission code=${mission.code} missionType=${mission.missionType} tier=${mission.tier} status=${mission.status} — ${m2Ok && t2Ok && triagingOk ? 'OK' : 'FAIL'}`,
    )

    // ---------- 2. Create Proposal 1-module (TB-11 §1 schema) ----------
    const proposal = await createProposal({
      missionId: mission.id,
      title: 'Fail-fast + key health check (1-module proposal)',
      summary:
        'Option A+B: fail-fast trên 4xx + key health check. Expected impact 121s → <10s.',
      changes: [
        'src/lib/llm/key-pool.ts — thêm health check + fail-fast trên 4xx',
        'src/lib/llm/retry.ts — bỏ retry mù cho 4xx, thêm timeout 30s',
      ],
      verificationPlan: [
        '(a) NGAY: so sánh latency log trước/sau + manual test với 1 key cố tình sai',
        '(b) DEFERRED: benchmark A/B p50/p95 chat latency khi hệ A/B được xây',
      ],
      pocRef: 'workspace/research/poc-fail-fast.ts',
    })
    proposalId = proposal.id
    const draftOk = proposal.status === 'DRAFT'
    const schemaOk =
      !!proposal.schema &&
      Array.isArray(proposal.schema.changes) &&
      proposal.schema.changes.length >= 1 &&
      Array.isArray(proposal.schema.verificationPlan) &&
      proposal.schema.verificationPlan.length >= 1
    const codeOk = /^P-\d{8}-\d{3}$/.test(proposal.code)
    details.push(
      `proposal code=${proposal.code} status=${proposal.status} changes=${proposal.schema.changes?.length ?? 0} verificationPlan=${proposal.schema.verificationPlan?.length ?? 0} — ${draftOk && schemaOk && codeOk ? 'OK' : 'FAIL'}`,
    )

    const passed = m2Ok && t2Ok && triagingOk && draftOk && schemaOk && codeOk
    return {
      name: 'TC-02 M2/T2 pipeline → Proposal 1-module',
      passed,
      details: details.join(' | '),
    }
  } catch (err) {
    return {
      name: 'TC-02 M2/T2 pipeline → Proposal 1-module',
      passed: false,
      details: [...details, `THREW: ${err instanceof Error ? err.message : String(err)}`].join(' | '),
    }
  } finally {
    // Cleanup: delete proposal + mission (best-effort, không crash)
    try {
      if (proposalId) await db.researchProposal.delete({ where: { id: proposalId } })
      if (missionId) await db.researchMission.delete({ where: { id: missionId } })
    } catch {
      // ignore — test artifacts left in DB
    }
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
      console.error('TC-02 uncaught:', err)
      process.exit(1)
    })
}

export { run }
