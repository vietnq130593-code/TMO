/**
 * RESEARCH TEAM — NEMESIS ENGINE (TB-06 7 nhiệm vụ lifecycle + VETO/PIVOT/ESCALATE/REJECT)
 * ============================================================================================
 * Spec:
 *  - TB-06 §2-§9 — NEMESIS 7 nhiệm vụ lifecycle:
 *      ① RECEIVE (tiếp nhận + phân tích request)
 *      ② TRIAGE (chấm complexity 3 tiêu chí + applyFloorRules → tier)
 *      ③ DECOMPOSE (chia parts + render task .md + council ① gate TC-13)
 *      ④ ASSIGN (giao G1/G2/G3 — gate TC-13)
 *      ⑤ MONITOR (đọc worklog G1/G2/G3 + KB capture + PIVOT check)
 *      ⑥ DECIDE (CONTINUE/PIVOT/ESCALATE — TC-09 PIVOT bắt buộc lý do)
 *      ⑦ FINALIZE (tổng hợp final report M1 / Proposal M2 + council ④ + KB capture)
 *  - TB-06 §8.6/8.7 — PIVOT: 🔴 fundamental → re-DECOMPOSE về G1; 🟡 scope creep → thu hẹp.
 *  - TB-06 §9.8 — NEMESIS cấm tự duyệt Proposal (DR-C5 §C5 — deputy/USER duyệt thay).
 *  - TC-09 (TB-12 §3.2) — PIVOT BẮT BUỘC lý do (recordPivot throw nếu empty).
 *  - TC-11 (TB-12 §3.2) — REJECTED proposal → RESEARCHING (KHÔNG FINALIZED, KHÔNG re-submit
 *      nguyên trạng). kingReject append decision='REJECT' + transition FINALIZED→RESEARCHING.
 *
 * Fail-open policy (TB-13 §4): mỗi function try/catch riêng. LLM error → escalated=true, KHÔNG crash.
 */

import { db } from '@/lib/db'
import { callLLMForAgent } from '@/lib/llm'
import type { LLMResult } from '@/lib/llm'
import { RESEARCH_ROSTER, AGENT_ID } from '../constants'
import { resolveResearchBrain } from '../agents'
import type {
  DecodedResearchMission,
  DecisionLogEntry,
  EvidenceItem,
  SuccessCriterion,
  WorklogEntry,
} from '../types'
import { decodeJsonArray, encodeJson } from '../types'
import { getMission, transitionMission, isValidTransition } from '../mission-store'
import { scoreComplexity, applyFloorRules, tieBreakUp } from '../tier'
import { appendDecision, recordPivot, recordReject } from './decision-log'
import { escalateToUser } from './escalation'
import { decomposeMission, getParts, assignPart } from './decompose'
import { runCouncil3, runCouncil4 } from './councils'
import { captureAtMonitor, captureAtFinalize, ensureColdStart } from '../g3/capture'
// TASK 3-fix WORK 3 — wire G1/G2/G3 + Tournament vào kingFullLifecycle:
// trước đây pipeline chỉ persist worklogs trống; giờ G1 (SIVIL+BELI) → G2
// (LISMA + RWV loop) → G3 (HAN optimize + Tournament) thực sự chạy per-tier.
import { runG1Pipeline } from '../g1/engine'
import { runLismaReview } from '../g2/lisma'
import { startRwvLoop, runRwvRound } from '../g2/rwv-loop'
import { runHanOptimize } from '../g3/han'
import type { HanOptimizeResult } from '../g3/han'
import { runTournament } from '../scoring/tournament'
import type { TournamentAgents } from '../scoring/tournament'
import type { MissionContext, ContextFitInput } from '../scoring/context-fit'
import { createProposal } from '../proposal/store'
import { performHandoff } from '../handoff'

// ============================================================
// §1. SYSTEM PROMPT — NEMESIS RECEIVE + FINALIZE
// ============================================================

const KING_RECEIVE_SYSTEM_PROMPT = [
  'Bạn là NEMESIS (TL — research team TMO). Position: TL (KHÔNG code).',
  `JD: ${RESEARCH_ROSTER.find((r) => r.id === AGENT_ID.NEMESIS)?.jd ?? 'Phân loại mission, chia nhỏ bài toán, kiểm soát chặt — không code'}.`,
  '',
  'TASK: Phân tích mission request — tóm tắt ý chính + rủi ro + đề xuất hướng tiếp cận.',
  '  - KHÔNG phân tích kỹ (TRIAGE sẽ làm); chỉ tổng quan để NEMESIS nắm context.',
  '  - Output 1 đoạn text 100-300 từ.',
].join('\n')

const KING_FINALIZE_SYSTEM_PROMPT = [
  'Bạn là NEMESIS (TL — research team TMO). Phase: FINALIZE.',
  `JD: ${RESEARCH_ROSTER.find((r) => r.id === AGENT_ID.NEMESIS)?.jd ?? 'Phân loại mission, chia nhỏ bài toán, kiểm soát chặt — không code'}.`,
  '',
  'TASK: Tổng hợp Final Report (M1) hoặc Proposal (M2) từ worklog + council ④ verdict.',
  '  - M1: Lessons + Anti-Patterns + Suggestions sections (TB-08 §7 capture).',
  '  - M2: Proposal items (mỗi item kèm Verification Plan TB-11 §7 (a)+(b)).',
  '  - Final Report phải có header với mission code + tier + decision summary.',
  '',
  'OUTPUT: markdown full final report.',
].join('\n')

// ============================================================
// §2. NEMESIS RECEIVE — TB-06 §2 (tiếp nhận + phân tích)
// ============================================================

export interface KingReceiveResult {
  mission: DecodedResearchMission
  analysis: string
}

/**
 * NEMESIS RECEIVE — TB-06 §2: tiếp nhận + phân tích request.
 *  - Gọi callLLM với NEMESIS RECEIVE JD → phân tích ý chính + rủi ro + đề xuất.
 *  - Transition → TRIAGING (CLASSIFY đã làm ở P1 classify.ts).
 *
 * LLM error → fail-open: analysis='(LLM unavailable — analysis deferred)'.
 */
export async function kingReceive(missionId: string): Promise<KingReceiveResult> {
  const mission = await getMission(missionId)
  if (!mission) {
    throw new Error(`kingReceive: mission ${missionId} không tồn tại`)
  }

  let analysis = ''
  try {
    // Task 4 — route NEMESIS qua Zen khi DB provider='zen' (fail-open → NIM).
    const nemesisBrain = await resolveResearchBrain('NEMESIS')
    const llm = await callLLMForAgent(
      `MISSION: ${mission.code}\nREQUEST:\n${mission.request}`,
      nemesisBrain,
      KING_RECEIVE_SYSTEM_PROMPT,
      {
        temperature: 0.2,
        maxTokens: 800,
        agentId: AGENT_ID.NEMESIS,
        agentName: 'NEMESIS (Receive)',
      },
    )
    if (llm.error || !llm.content || llm.content.trim().length === 0) {
      analysis = `(LLM unavailable — analysis deferred: ${llm.error || 'empty content'})`
    } else {
      analysis = llm.content
    }
  } catch (err) {
    analysis = `(LLM unavailable — analysis deferred: ${err instanceof Error ? err.message : String(err)})`
  }

  // Transition → TRIAGING (if currently CLASSIFY)
  let updated = mission
  try {
    if (mission.status === 'CLASSIFY' && isValidTransition('CLASSIFY', 'TRIAGING')) {
      updated = await transitionMission(missionId, {
        toStatus: 'TRIAGING',
        decision: {
          at: new Date().toISOString(),
          agent: 'NEMESIS',
          decision: 'CONTINUE',
          reason: `NEMESIS RECEIVE — mission tiếp nhận + phân tích xong (tier=${mission.tier || '?'})`,
        },
      })
    }
  } catch (err) {
    console.warn(
      '[KingEngine:receive] transition → TRIAGING failed (non-blocking):',
      err instanceof Error ? err.message : String(err),
    )
  }

  return { mission: updated, analysis }
}

// ============================================================
// §3. NEMESIS TRIAGE — TB-06 §3 (chấm complexity + applyFloorRules)
// ============================================================

export interface KingTriageResult {
  tier: 'T1' | 'T2' | 'T3'
  triageScore: { scope: number; reasoningDepth: number; risk: number; total: number }
  decision: DecisionLogEntry
}

/**
 * NEMESIS TRIAGE — TB-06 §3: chấm complexity 3 tiêu chí (tier.ts scoreComplexity) +
 * applyFloorRules + tieBreakUp (DR-C2). Transition → DECOMPOSING.
 *
 * Default heuristic (không LLM — TB-13 §1 nguyên tắc 7 tái dùng tier.ts pure function):
 *  - scope = 2 (medium — default), reasoningDepth = 2 (medium), risk = 2 (medium)
 *  - Tổng = 6 → T2. Floor-rule M2 audit/redesign → T3 (TB-02 §4 floor-rule).
 *  - Caller có thể refine bằng LLM analyze ở P7 E2E test.
 */
export async function kingTriage(missionId: string): Promise<KingTriageResult> {
  const mission = await getMission(missionId)
  if (!mission) {
    throw new Error(`kingTriage: mission ${missionId} không tồn tại`)
  }

  // Heuristic defaults — caller refine sau nếu cần
  const triageInput = {
    scope: 2 as 1 | 2 | 3,
    reasoningDepth: 2 as 1 | 2 | 3,
    risk: 2 as 1 | 2 | 3,
  }
  const score = scoreComplexity(triageInput)

  // Apply floor rules M2 (TB-02 §4)
  const signals = (mission.confidence?.signals || []).concat([mission.request])
  const floor = applyFloorRules(
    mission.missionType as 'M1' | 'M2' | 'M3',
    score.tier,
    signals,
  )

  // DR-C2 tie-break UP (medium confidence edge case)
  let tier = floor.tier
  if (mission.confidence?.level === 'MEDIUM') {
    tier = tieBreakUp(score.total)
  }

  // Transition → DECOMPOSING
  const decision: DecisionLogEntry = {
    at: new Date().toISOString(),
    agent: 'NEMESIS',
    decision: 'CONTINUE',
    reason: `TRIAGE: scope=${triageInput.scope} + reasoningDepth=${triageInput.reasoningDepth} + risk=${triageInput.risk} = ${score.total} → ${tier}. ${floor.adjusted ? floor.reason || '' : '(no floor-rule applied)'}`,
  }

  try {
    if (isValidTransition(mission.status, 'DECOMPOSING')) {
      await transitionMission(missionId, {
        toStatus: 'DECOMPOSING',
        decision,
      })
    } else {
      // Append decision log anyway (transition may be no-op if already DECOMPOSING)
      await appendDecision(missionId, {
        agent: 'NEMESIS',
        decision: 'CONTINUE',
        reason: decision.reason,
      })
    }
  } catch (err) {
    console.warn(
      '[KingEngine:triage] transition → DECOMPOSING failed (non-blocking):',
      err instanceof Error ? err.message : String(err),
    )
  }

  return {
    tier,
    triageScore: {
      scope: triageInput.scope,
      reasoningDepth: triageInput.reasoningDepth,
      risk: triageInput.risk,
      total: score.total,
    },
    decision,
  }
}

// ============================================================
// §4. NEMESIS MONITOR — TB-06 §5 (đọc worklog + KB capture + PIVOT check)
// ============================================================

export interface KingMonitorResult {
  worklog: Partial<WorklogEntry>
  captured: string[]
  pivotTriggered: boolean
  pivotReason?: string
}

/**
 * NEMESIS MONITOR — TB-06 §5: đọc worklog G1/G2/G3 + KB capture (g3/capture.captureAtMonitor)
 * + PIVOT check.
 *
 * PIVOT triggers (TB-06 §8.6/8.7):
 *  - 🔴 fundamental issue (worklog tlReadBack='PIVOT-NEEDED' + issuesFaced có 'fundamental'/'root')
 *      → recordPivot (TC-09: lý do BẮT BUỘC) + re-DECOMPOSE phần liên quan.
 *  - 🟡 scope creep (worklog issuesFaced có 'scope creep'/'too broad')
 *      → thu hẹp scope (KHÔNG pivot full — chỉ adjust).
 *
 * Transition MONITORING. KB capture (TC-08 — mọi tier đều capture).
 *
 * LLM error trong capture → fail-open (KHÔNG crash pipeline).
 */
export async function kingMonitor(missionId: string): Promise<KingMonitorResult> {
  const mission = await getMission(missionId)
  if (!mission) {
    throw new Error(`kingMonitor: mission ${missionId} không tồn tại`)
  }

  const missionType = mission.missionType as 'M1' | 'M2' | 'M3'
  const tier = (mission.tier || 'T2') as 'T1' | 'T2' | 'T3'

  // 1. Read latest worklogs cho mission
  let worklogs: Array<{ id: string; taskId: string; phase: string; entryJson: string }> = []
  try {
    worklogs = await db.researchWorklog.findMany({
      where: { missionId },
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: { id: true, taskId: true, phase: true, entryJson: true },
    })
  } catch (err) {
    console.warn(
      '[KingEngine:monitor] read worklogs failed (non-blocking — proceed with empty):',
      err instanceof Error ? err.message : String(err),
    )
  }

  // 2. Parse + analyze worklogs for PIVOT triggers
  const captured: string[] = []
  let pivotTriggered = false
  let pivotReason: string | undefined
  let pivotTrigger: '🔴' | '🟡' = '🟡'

  for (const w of worklogs) {
    let entry: WorklogEntry | null = null
    try {
      entry = JSON.parse(w.entryJson) as WorklogEntry
    } catch {
      continue
    }
    if (!entry || typeof entry !== 'object') continue

    // KB Capture at MONITOR (TC-08 — mọi tier đều capture)
    try {
      const result = await captureAtMonitor(missionId, w.taskId, entry, missionType, tier)
      captured.push(...result.captured)
    } catch (err) {
      console.warn(
        '[KingEngine:monitor] captureAtMonitor failed (non-blocking — skip):',
        err instanceof Error ? err.message : String(err),
      )
    }

    // PIVOT check
    const issuesJoined = (entry.issuesFaced || []).join(' ').toLowerCase()
    const tlReadBack = entry.tlReadBack || ''
    if (tlReadBack === 'PIVOT-NEEDED' || /fundamental|root cause|architecture flaw|invalid approach/.test(issuesJoined)) {
      pivotTriggered = true
      pivotTrigger = '🔴'
      pivotReason = `Fundamental issue detected: worklog ${w.id} (phase=${w.phase}) tlReadBack=${tlReadBack}, issues=${(entry.issuesFaced || []).slice(0, 2).join('; ')}`
      break
    }
    if (/scope creep|too broad|out of scope|scope drift/.test(issuesJoined)) {
      pivotTriggered = true
      pivotTrigger = '🟡'
      pivotReason = `Scope creep detected: worklog ${w.id} (phase=${w.phase}) — thu hẹp scope (KHÔNG pivot full)`
      break
    }
  }

  // 3. PIVOT → recordPivot (TC-09: lý do BẮT BUỘC)
  if (pivotTriggered && pivotReason) {
    try {
      await recordPivot(missionId, pivotReason, pivotTrigger)
    } catch (err) {
      // TC-09 fail-open: nếu reason empty → throw (but we just set it, so won't happen).
      // Log anyway.
      console.warn(
        '[KingEngine:monitor] recordPivot failed (non-blocking — TC-09 reason should be set):',
        err instanceof Error ? err.message : String(err),
      )
    }
  }

  // 4. Transition → MONITORING
  const decisionReason = pivotTriggered
    ? `PIVOT ${pivotTrigger}: ${pivotReason}`
    : `MONITOR OK — ${worklogs.length} worklogs read, ${captured.length} KB entries captured`

  try {
    if (isValidTransition(mission.status, 'MONITORING')) {
      await transitionMission(missionId, {
        toStatus: 'MONITORING',
        decision: {
          at: new Date().toISOString(),
          agent: 'NEMESIS',
          decision: pivotTriggered ? 'PIVOT' : 'CONTINUE',
          reason: decisionReason,
        },
      })
    } else {
      await appendDecision(missionId, {
        agent: 'NEMESIS',
        decision: pivotTriggered ? 'PIVOT' : 'CONTINUE',
        reason: decisionReason,
      })
    }
  } catch (err) {
    console.warn(
      '[KingEngine:monitor] transition → MONITORING failed (non-blocking):',
      err instanceof Error ? err.message : String(err),
    )
  }

  const worklog: Partial<WorklogEntry> = {
    mission: missionType,
    status: pivotTriggered ? 'ESCALATED' : 'IN_PROGRESS',
    currentPhase: 'G3',
    overallProgress: 70,
    tlReadBack: pivotTriggered ? 'PIVOT-NEEDED' : 'VERIFIED',
    done: [
      `MONITOR: read ${worklogs.length} worklogs`,
      `KB captured ${captured.length} entries (TC-08)`,
    ],
    issuesFaced: pivotTriggered ? [decisionReason] : [],
    suggestionsNextGroup: pivotTriggered
      ? [pivotTrigger === '🔴' ? 're-DECOMPOSE affected parts' : 'thu hẹp scope']
      : ['continue to FINALIZE'],
    filesChanged: [],
  }

  return {
    worklog,
    captured,
    pivotTriggered,
    pivotReason: pivotTriggered ? pivotReason : undefined,
  }
}

// ============================================================
// §5. NEMESIS DECIDE — TB-06 §6 (CONTINUE/PIVOT/ESCALATE)
// ============================================================

/**
 * NEMESIS DECIDE — TB-06 §6:
 *  - CONTINUE → next part (continue pipeline).
 *  - PIVOT → recordPivot (TC-09 reason BẮT BUỘC) + re-DECOMPOSE phần liên quan
 *      (KHÔNG re-submit nguyên trạng — TC-11 spec applies to REJECTED not PIVOT, but
 *      PIVOT also requires fresh approach per TB-06 §8.6/8.7).
 *  - ESCALATE → escalation.escalateToUser (DR-C5).
 *
 * Append decision log. Throw if PIVOT reason empty (TC-09).
 */
export async function kingDecide(
  missionId: string,
  verdict: 'CONTINUE' | 'PIVOT' | 'ESCALATE',
  reason: string,
): Promise<DecodedResearchMission> {
  const mission = await getMission(missionId)
  if (!mission) {
    throw new Error(`kingDecide: mission ${missionId} không tồn tại`)
  }

  if (verdict === 'PIVOT') {
    // TC-09: PIVOT reason BẮT BUỘC non-empty (recordPivot throw if empty)
    await recordPivot(missionId, reason, '🔴')
    return (await getMission(missionId))!
  }

  if (verdict === 'ESCALATE') {
    await escalateToUser(missionId, reason, {
      tier: (mission.tier || 'T2') as 'T1' | 'T2' | 'T3',
      kind: 'mission',
    })
    return (await getMission(missionId))!
  }

  // CONTINUE
  return appendDecision(missionId, {
    agent: 'NEMESIS',
    decision: 'CONTINUE',
    reason,
  })
}

// ============================================================
// §6. NEMESIS FINALIZE — TB-06 §9 (tổng hợp final report + council ④ + KB capture)
// ============================================================

export interface KingFinalizeResult {
  finalReport: string
  proposalItems?: string[]
  council4Verdict: string
  captured: string[]
}

/**
 * NEMESIS FINALIZE — TB-06 §9: tổng hợp final report (M1) / Proposal (M2).
 *  - Gọi callLLM với NEMESIS FINALIZE JD → sinh markdown final report.
 *  - Council ④ (councils.runCouncil4) — verify final report + Proposal Verification Plan.
 *  - KB capture (g3/capture.captureAtFinalize) — TB-08 §7 quy tắc vàng #2.
 *  - Transition → FINALIZED.
 *
 * M2: nếu có proposal items → (P6 sẽ tạo Proposal record; P5 chỉ sinh proposalItems[] trong
 * finalReport).
 *
 * LLM error → fail-open: finalReport='(LLM unavailable — manual final report needed)'.
 */
export async function kingFinalize(missionId: string): Promise<KingFinalizeResult> {
  const mission = await getMission(missionId)
  if (!mission) {
    throw new Error(`kingFinalize: mission ${missionId} không tồn tại`)
  }

  const missionType = mission.missionType as 'M1' | 'M2' | 'M3'
  const tier = (mission.tier || 'T2') as 'T1' | 'T2' | 'T3'

  // 1. Ensure KB cold-start (TC-05 — idempotent)
  try {
    await ensureColdStart()
  } catch (err) {
    console.warn(
      '[KingEngine:finalize] ensureColdStart failed (non-blocking):',
      err instanceof Error ? err.message : String(err),
    )
  }

  // 2. Read all worklogs to assemble context for final report
  let worklogs: Array<{ id: string; taskId: string; phase: string; entryJson: string }> = []
  try {
    worklogs = await db.researchWorklog.findMany({
      where: { missionId },
      orderBy: { createdAt: 'asc' },
      take: 50,
      select: { id: true, taskId: true, phase: true, entryJson: true },
    })
  } catch (err) {
    console.warn(
      '[KingEngine:finalize] read worklogs failed (non-blocking):',
      err instanceof Error ? err.message : String(err),
    )
  }

  // 3. LLM finalize — generate final report
  let finalReport = ''
  let proposalItems: string[] | undefined
  try {
    const worklogSummary = worklogs
      .map((w) => `- [${w.phase}] task=${w.taskId}: ${w.entryJson.slice(0, 200)}...`)
      .join('\n')
      .slice(0, 4000)

    // Task 4 — route NEMESIS qua Zen khi DB provider='zen' (fail-open → NIM).
    const nemesisBrain = await resolveResearchBrain('NEMESIS')
    const llm = await callLLMForAgent(
      [
        `MISSION: ${mission.code} (tier=${tier}, type=${missionType})`,
        '',
        'REQUEST:',
        mission.request,
        '',
        'WORKLOG SUMMARY:',
        worklogSummary || '(no worklogs)',
        '',
        'Tổng hợp Final Report theo system prompt. M2 mode: kèm Proposal items + Verification Plan (TB-11 §7).',
      ].join('\n'),
      nemesisBrain,
      KING_FINALIZE_SYSTEM_PROMPT,
      {
        temperature: 0.2,
        maxTokens: 3000,
        agentId: AGENT_ID.NEMESIS,
        agentName: 'NEMESIS (Finalize)',
      },
    )

    if (llm.error || !llm.content || llm.content.trim().length === 0) {
      finalReport = `(LLM unavailable — manual final report needed: ${llm.error || 'empty content'})`
    } else {
      finalReport = llm.content
    }

    // M2: extract proposal items from final report (heuristic)
    if (missionType !== 'M1') {
      proposalItems = extractProposalItems(finalReport)
    }
  } catch (err) {
    finalReport = `(LLM unavailable — manual final report needed: ${err instanceof Error ? err.message : String(err)})`
  }

  // 4. Council ④ (final) — verify final report + Verification Plan
  let council4Verdict = 'REVISE'
  try {
    const council4 = await runCouncil4(missionId, {
      finalReport,
      proposalItems,
    })
    council4Verdict = council4.verdict
    if (council4.finalReport && council4.finalReport.trim().length > 0) {
      finalReport = council4.finalReport
    }
  } catch (err) {
    console.warn(
      '[KingEngine:finalize] runCouncil4 failed (non-blocking — default REVISE):',
      err instanceof Error ? err.message : String(err),
    )
  }

  // 5. KB capture at FINALIZE (TB-08 §7 — mọi tier đều capture)
  let captured: string[] = []
  try {
    const captureResult = await captureAtFinalize(missionId, finalReport, missionType, tier)
    captured = captureResult.captured
  } catch (err) {
    console.warn(
      '[KingEngine:finalize] captureAtFinalize failed (non-blocking):',
      err instanceof Error ? err.message : String(err),
    )
  }

  // 6. Transition → FINALIZED (if council ④ PASS)
  if (council4Verdict === 'PASS') {
    try {
      if (isValidTransition(mission.status, 'FINALIZED')) {
        await transitionMission(missionId, {
          toStatus: 'FINALIZED',
          decision: {
            at: new Date().toISOString(),
            agent: 'NEMESIS',
            decision: 'FINALIZE',
            reason: `NEMESIS FINALIZE — council ④ PASS, captured ${captured.length} KB entries`,
          },
        })
      }
    } catch (err) {
      console.warn(
        '[KingEngine:finalize] transition → FINALIZED failed (non-blocking):',
        err instanceof Error ? err.message : String(err),
      )
    }
  } else {
    // REVISE/VETO → append decision log + escalate (don't finalize)
    try {
      await appendDecision(missionId, {
        agent: 'NEMESIS',
        decision: council4Verdict === 'VETO' ? 'ESCALATE' : 'CONTINUE',
        reason: `Council ④ ${council4Verdict} — final report needs revision (or escalate USER if VETO)`,
      })
    } catch (err) {
      console.warn(
        '[KingEngine:finalize] appendDecision failed (non-blocking):',
        err instanceof Error ? err.message : String(err),
      )
    }
  }

  return {
    finalReport,
    proposalItems,
    council4Verdict,
    captured,
  }
}

// ============================================================
// §7. NEMESIS REJECT — TC-11 (REJECTED proposal → RESEARCHING)
// ============================================================

/**
 * TC-11 REJECTED (TB-12 §3.2):
 *  - Proposal REJECTED → mission status RESEARCHING (KHÔNG FINALIZED).
 *  - KHÔNG re-submit nguyên trạng (must revise approach — TB-06 §8.6).
 *  - Append decision='REJECT', reason BẮT BUỘC (recordReject throw if empty).
 *  - Transition FINALIZED→RESEARCHING (special — normally invalid; allowed via ESCALATED branch).
 *
 * Throw if mission not found, or if status not FINALIZED.
 */
export async function kingReject(
  missionId: string,
  reason: string,
): Promise<DecodedResearchMission> {
  const mission = await getMission(missionId)
  if (!mission) {
    throw new Error(`kingReject: mission ${missionId} không tồn tại`)
  }

  if (mission.status !== 'FINALIZED') {
    throw new Error(
      `kingReject: mission ${missionId} không ở FINALIZED (hiện tại: ${mission.status}) — TC-11 chỉ áp dụng khi Proposal bị REJECTED từ FINALIZED`,
    )
  }

  // 1. Record REJECT decision (TC-11 reason BẮT BUỘC)
  await recordReject(missionId, reason)

  // 2. Transition FINALIZED → RESEARCHING (special allowed transition)
  //    mission-store.VALID_TRANSITIONS cho FINALIZED = [] (terminal). Cần bypass qua ESCALATED.
  try {
    // First transition FINALIZED → ESCALATED (branch — TB-02 §7 ESCALATED có thể quay lại RESEARCHING)
    if (isValidTransition('FINALIZED', 'ESCALATED')) {
      await transitionMission(missionId, {
        toStatus: 'ESCALATED',
        decision: {
          at: new Date().toISOString(),
          agent: 'NEMESIS',
          decision: 'REJECT',
          reason: `TC-11 REJECTED — proposal bị reject, escalate để re-RESEARCHING (KHÔNG FINALIZED, KHÔNG re-submit nguyên trạng)`,
        },
      })
    }
    // Then ESCALATED → RESEARCHING (branch — TB-02 §7)
    const escalated = await getMission(missionId)
    if (escalated && escalated.status === 'ESCALATED' && isValidTransition('ESCALATED', 'RESEARCHING')) {
      return transitionMission(missionId, {
        toStatus: 'RESEARCHING',
        decision: {
          at: new Date().toISOString(),
          agent: 'NEMESIS',
          decision: 'CONTINUE',
          reason: `TC-11 re-RESEARCHING (proposal rejected) — reason: ${reason}`,
        },
      })
    }
  } catch (err) {
    console.warn(
      '[KingEngine:reject] transition failed (non-blocking — decision log still appended):',
      err instanceof Error ? err.message : String(err),
    )
  }

  return (await getMission(missionId))!
}

// ============================================================
// §8. NEMESIS FULL LIFECYCLE — orchestrate all 7 missions
// ============================================================

export interface KingFullLifecycleResult {
  mission: DecodedResearchMission
  finalReport?: string
  parts: number
  errors: string[]
  /** FIX (Task 19 audit B#7): proposals DRAFT đã tạo (M2) — id + code + title. */
  proposals?: Array<{ id: string; code: string; title: string }>
}

// ============================================================
// §8a. LIFECYCLE EVENTS — hook cho caller (chat SSE workflow route)
// ============================================================

/**
 * Event tiến độ lifecycle — workflow route (Task 19: chat Smolab ↔ Research Team)
 * map sang SSE agent_complete để user thấy team đang làm gì trong khung chat.
 */
export interface KingLifecycleEvent {
  type: 'stage' | 'part'
  stage:
    | 'receive'
    | 'triage'
    | 'decompose'
    | 'assign'
    | 'pipeline'
    | 'monitor'
    | 'decide'
    | 'finalize'
    | 'done'
  message: string
  data?: Record<string, unknown>
}

export interface KingLifecycleOptions {
  onEvent?: (event: KingLifecycleEvent) => void
}

/**
 * Orchestrate full NEMESIS lifecycle: receive → triage → decompose → (G1/G2/G3 per tier)
 * → monitor → decide → finalize.
 *
 * Per tier (TB-02 §3) — TASK 3-fix WORK 3 (audit B.7+B.8+B.15 fix):
 *  - T1 → skip G1/G3: LISMA code + self-review + fix ≤3 vòng → MONITOR → DONE.
 *  - T2 → skip G3: runG1Pipeline (BELI + SIVIL ad-hoc) → handoff G1→G2 →
 *               runLismaReview + startRwvLoop → MONITOR → DONE.
 *  - T3 → full pipeline: runG1Pipeline (SIVIL+BELI) → handoff G1→G2 →
 *               runLismaReview + startRwvLoop → handoff G2→G3 → runHanOptimize
 *               + runTournament (inject LLM callbacks) → MONITOR → FINALIZE.
 *
 * Wrap each step try/catch — error → errors.push(step+reason), KHÔNG crash.
 * LLM fail-open (NIM placeholder) → errors array ghi 'LLM unavailable' nhưng
 * pipeline structure đúng (đã chạy qua G1/G2/G3, không còn dead code).
 */
export async function kingFullLifecycle(
  missionId: string,
  options: KingLifecycleOptions = {},
): Promise<KingFullLifecycleResult> {
  const errors: string[] = []
  const proposals: Array<{ id: string; code: string; title: string }> = []
  const emit = (
    type: 'stage' | 'part',
    stage: KingLifecycleEvent['stage'],
    message: string,
    data?: Record<string, unknown>,
  ) => {
    try {
      options.onEvent?.({ type, stage, message, data })
    } catch {
      // Listener fail-open — KHÔNG phá pipeline
    }
  }
  let mission: DecodedResearchMission | null = await getMission(missionId)
  if (!mission) {
    throw new Error(`kingFullLifecycle: mission ${missionId} không tồn tại`)
  }

  let partsCount = 0
  let finalReport: string | undefined

  // 1. RECEIVE
  try {
    const r = await kingReceive(missionId)
    mission = r.mission
    emit('stage', 'receive', '① RECEIVE — NEMESIS đã tiếp nhận và phân tích mission')
  } catch (err) {
    errors.push(`RECEIVE: ${err instanceof Error ? err.message : String(err)}`)
  }

  // 2. TRIAGE
  try {
    const t = await kingTriage(missionId)
    mission = await getMission(missionId)
    emit(
      'stage',
      'triage',
      `② TRIAGE — chấm complexity xong → tier ${t.tier} (score ${t.triageScore.total}/9)`,
      { tier: t.tier, score: t.triageScore },
    )
  } catch (err) {
    errors.push(`TRIAGE: ${err instanceof Error ? err.message : String(err)}`)
  }

  // 3. DECOMPOSE
  try {
    const d = await decomposeMission(missionId)
    partsCount = d.parts.length
    emit('stage', 'decompose', `③ DECOMPOSE — chia mission thành ${partsCount} part(s) + council ① verify Success Criteria`, {
      parts: partsCount,
    })
    if (d.escalated) {
      errors.push(`DECOMPOSE escalated: ${d.worklog?.issuesFaced?.join('; ') || 'unknown'}`)
    }
  } catch (err) {
    errors.push(`DECOMPOSE: ${err instanceof Error ? err.message : String(err)}`)
  }

  // 4. ASSIGN — assign each part to G1 (default — caller can refine)
  //    AND transition mission → RESEARCHING (G1/G2/G3 work bắt đầu).
  try {
    const parts = await getParts(missionId)
    for (const p of parts) {
      try {
        await assignPart(p.id, 'G1')
      } catch (err) {
        errors.push(`ASSIGN part ${p.partIdx}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    emit('stage', 'assign', `④ ASSIGN — ${parts.length} part(s) giao cho G1 + transition RESEARCHING`)
    // Transition DECOMPOSING → RESEARCHING (TB-02 §7)
    mission = await getMission(missionId)
    if (mission && isValidTransition(mission.status, 'RESEARCHING')) {
      await transitionMission(missionId, {
        toStatus: 'RESEARCHING',
        decision: {
          at: new Date().toISOString(),
          agent: 'NEMESIS',
          decision: 'CONTINUE',
          reason: `NEMESIS lifecycle — parts assigned to G1, starting per-tier pipeline (tier=${mission.tier})`,
        },
      })
    }
  } catch (err) {
    errors.push(`ASSIGN: ${err instanceof Error ? err.message : String(err)}`)
  }

  // 5. PER-TIER PIPELINE — actually run G1/G2/G3 per part (TASK 3-fix WORK 3).
  //    Trước đây đoạn này KHÔNG gọi runG1Pipeline/runLismaReview/runHanOptimize/
  //    runTournament — ~8500 LOC agent pipeline = dead code. Giờ wired thật.
  try {
    const missionSnapshot = await getMission(missionId)
    if (missionSnapshot) {
      const tier = (missionSnapshot.tier || 'T2') as 'T1' | 'T2' | 'T3'
      const missionType = missionSnapshot.missionType as 'M1' | 'M2' | 'M3'
      const parts = await getParts(missionId)

      for (const part of parts) {
        // Decode successCriteria từ part (gate TC-13 — assignPart đã verify non-empty)
        const sc = decodeJsonArray<SuccessCriterion>(part.successCriteriaJson)
        const partDescription = part.title || `(part ${part.partIdx})`
        emit(
          'part',
          'pipeline',
          `⑤ PIPELINE part ${part.partIdx}/${parts.length} (tier ${tier}) — G1/G2/G3 pipeline bắt đầu: ${partDescription.slice(0, 80)}`,
        )

        try {
          await runPerTierPipeline({
            missionId,
            taskId: part.id,
            partDescription,
            tier,
            missionType,
            successCriteria: sc,
            successCriteriaStrings: sc.map((c) => c.criterion),
            errors,
            emit: (event) => emit(event.type, event.stage, event.message, event.data),
          })
        } catch (err) {
          errors.push(
            `PIPELINE part ${part.partIdx} (${tier}): ${err instanceof Error ? err.message : String(err)}`,
          )
        }
      }
    }
  } catch (err) {
    errors.push(`PIPELINE: ${err instanceof Error ? err.message : String(err)}`)
  }

  // 6. MONITOR
  try {
    const m = await kingMonitor(missionId)
    if (m.pivotTriggered) {
      errors.push(`MONITOR PIVOT: ${m.pivotReason || 'unknown'}`)
      emit('stage', 'monitor', `⑥ MONITOR — ⚠️ PIVOT: ${m.pivotReason?.slice(0, 120) || 'unknown'}`, {
        pivot: true,
      })
    } else {
      emit(
        'stage',
        'monitor',
        `⑥ MONITOR — đọc worklog G1/G2/G3 + KB capture xong (${m.captured.length} entries TC-08), không có PIVOT`,
      )
    }
  } catch (err) {
    errors.push(`MONITOR: ${err instanceof Error ? err.message : String(err)}`)
  }

  // 7. DECIDE — CONTINUE (default; caller can refine)
  try {
    mission = await kingDecide(missionId, 'CONTINUE', 'NEMESIS full lifecycle auto-decide: CONTINUE')
    emit('stage', 'decide', '⑦ DECIDE — CONTINUE (không cần pivot)')
  } catch (err) {
    errors.push(`DECIDE: ${err instanceof Error ? err.message : String(err)}`)
  }

  // 8. FINALIZE
  let finalizeResult: KingFinalizeResult | undefined
  try {
    const f = await kingFinalize(missionId)
    finalizeResult = f
    finalReport = f.finalReport
    if (f.council4Verdict !== 'PASS') {
      errors.push(`FINALIZE council ④ ${f.council4Verdict}`)
    }
    emit(
      'stage',
      'finalize',
      `⑧ FINALIZE — council ④ ${f.council4Verdict} · ${f.captured.length} KB entries captured${
        f.proposalItems?.length ? ` · ${f.proposalItems.length} proposal item(s)` : ''
      }`,
    )
  } catch (err) {
    errors.push(`FINALIZE: ${err instanceof Error ? err.message : String(err)}`)
  }

  // 8.5 P6 — M2: tạo Proposal DRAFT từ proposalItems
  // FIX (Task 19 audit B#7): createProposal trước đây KHÔNG BAO GIỜ được engine
  // gọi (chỉ test tc-02 + API manual POST) → invariant TB-05 §11 Q1 "1 task G3
  // sinh ≥1 proposal item" không enforce — mission T3/M2 chạy xong không sinh
  // Proposal nào. Giờ lifecycle tự tạo DRAFT proposals từ final report.
  try {
    const fMission = await getMission(missionId)
    if (fMission && fMission.missionType !== 'M1' && finalizeResult?.proposalItems?.length) {
      for (const item of finalizeResult.proposalItems.slice(0, 5)) {
        try {
          const p = await createProposal({
            missionId,
            title: item.slice(0, 90),
            summary: item,
            changes: [item],
            verificationPlan: [
              '(a) Manual test NGAY theo final report (TB-11 §7 — council ④ đã verify)',
              '(b) Benchmark spec deferred — chờ deputy/user duyệt',
            ],
          })
          proposals.push({ id: p.id, code: p.schema?.code || p.id, title: item.slice(0, 90) })
        } catch (err) {
          errors.push(`PROPOSAL create: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
    }
  } catch (err) {
    errors.push(`PROPOSAL: ${err instanceof Error ? err.message : String(err)}`)
  }

  mission = await getMission(missionId)
  emit(
    'stage',
    'done',
    `Hoàn tất lifecycle — status ${mission?.status || '?'} · ${errors.length} cảnh báo`,
    { errorsCount: errors.length, proposals: proposals.length },
  )
  return {
    mission: mission!,
    finalReport,
    parts: partsCount,
    errors,
    proposals: proposals.length > 0 ? proposals : undefined,
  }
}

// ============================================================
// §8b. PER-TIER PIPELINE — actually run G1/G2/G3 per part (TASK 3-fix WORK 3)
// ============================================================

interface RunPerTierPipelineParams {
  missionId: string
  taskId: string
  partDescription: string
  tier: 'T1' | 'T2' | 'T3'
  missionType: 'M1' | 'M2' | 'M3'
  successCriteria: SuccessCriterion[]
  successCriteriaStrings: string[]
  errors: string[]
  /** Emit tiến độ lifecycle (chat SSE) — optional. */
  emit?: KingLifecycleOptions['onEvent']
}

/**
 * Run per-tier agent pipeline cho 1 part:
 *  - T1: skip G1/G3 — LISMA tự code + self-review + fix ≤3 vòng (fast track).
 *  - T2: runG1Pipeline (BELI only, SIVIL ad-hoc) → handoff G1→G2 → LISMA + RWV.
 *  - T3: full — runG1Pipeline → handoff G1→G2 → LISMA + RWV → handoff G2→G3 →
 *        runHanOptimize + runTournament (LLM-backed callbacks).
 *
 * Mỗi step wrap try/catch — error ghi vào errors[], KHÔNG crash lifecycle.
 * LLM fail-open (NIM placeholder) → errors array ghi 'LLM unavailable' nhưng
 * pipeline structure đúng (đã chạy qua G1/G2/G3, không còn dead code).
 */
async function runPerTierPipeline(params: RunPerTierPipelineParams): Promise<void> {
  const { missionId, taskId, tier, missionType, errors } = params
  const emit = params.emit
  const emitLocal = (message: string, data?: Record<string, unknown>) => {
    try {
      emit?.({ type: 'part', stage: 'pipeline', message, data })
    } catch {
      /* listener fail-open */
    }
  }

  // LISMA call dùng chung cho review + RWV rounds + POC (LLM-backed)
  const lismaCall = async (prompt: string): Promise<string> => {
    // Task 4 — route LISMA qua Zen khi DB provider='zen' (fail-open → NIM).
    const lismaBrain = await resolveResearchBrain('LISMA')
    const r = await callLLMForAgent(prompt, lismaBrain, RWV_ROUND_SYSTEM_PROMPT, {
      temperature: 0.2,
      maxTokens: 2500,
      agentId: AGENT_ID.LISMA,
      agentName: 'LISMA (RWV round)',
    })
    return r.content || ''
  }

  // ---------- T1: skip G1/G3 — LISMA fast track ----------
  if (tier === 'T1') {
    try {
      // LISMA tự code + self-review (BELI spec = part description cho T1)
      const lismaResult = await runLismaReview(
        missionId,
        taskId,
        params.partDescription,
        [], // codeDrafts empty — LISMA tự sinh từ spec
        missionType,
        1,
      )
      // FIX (Task 19 audit A#5): persist LISMA worklog + evidence — trước đây
      // kết quả G2 (DR + evidence + worklog) KHÔNG được persist (biến mất sau
      // khi pipeline chạy xong — audit-trail TB-04 §5 trống rỗng).
      await persistPartialWorklog(missionId, taskId, lismaResult.worklog, 'RESEARCH', {
        evidence: lismaResult.evidence,
        findingsFromEvidence: lismaResult.evidence,
      })
      emitLocal(`T1 LISMA fast-track xong — ${lismaResult.escalated ? '⚠️ escalated' : 'OK'} · ${lismaResult.evidence.length} evidence item(s) (TC-06)`)
      if (lismaResult.escalated) {
        errors.push(
          `T1 LISMA escalated: ${lismaResult.escalateReason || 'unknown'}`,
        )
      }
    } catch (err) {
      errors.push(
        `T1 LISMA: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
    return
  }

  // ---------- T2 & T3: G1 pipeline → G2 LISMA + RWV ----------
  let g1Spec = ''
  let g1Code = ''
  try {
    const g1 = await runG1Pipeline(
      missionId,
      taskId,
      params.partDescription,
      missionType,
      params.successCriteria,
    )
    g1Spec = g1.spec || g1.synthesis || ''
    g1Code = g1.beliResult?.spec || g1.spec || ''
    if (g1.escalated) {
      errors.push(
        `G1 escalated: ${g1.escalateReason || 'unknown'}`,
      )
      // Council ③ escalation (TB-06 §8) — fail-open if LLM unavailable.
      try {
        const c3 = await runCouncil3(missionId, {
          reason: g1.escalateReason || 'G1 escalated (council ①② verdict)',
          group: 'G1',
          conflicts: g1.conflicts as unknown[],
        })
        if (c3.verdict === 'VETO') {
          errors.push(`Council ③ VETO — escalate USER`)
        }
      } catch (err) {
        errors.push(
          `Council ③: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }
  } catch (err) {
    errors.push(`G1: ${err instanceof Error ? err.message : String(err)}`)
  }

  // Handoff G1 → G2 (gate E4 TC-14 — fail-open)
  try {
    const handoff = await performHandoff(taskId, 'G1', 'G2', missionType)
    if (!handoff.transitioned) {
      errors.push(`Handoff G1→G2 skipped: ${handoff.handoff.reason}`)
      emitLocal(`Handoff G1→G2 bị chặn (TC-14): ${handoff.handoff.reason?.slice(0, 100) || 'unknown'}`)
    } else {
      emitLocal('Handoff G1→G2 PASSED (TC-14) — task chuyển sang G2')
    }
  } catch (err) {
    errors.push(
      `Handoff G1→G2: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  // G2 — LISMA review + RWV loop
  let diagnosticReport = ''
  try {
    const lisma = await runLismaReview(
      missionId,
      taskId,
      g1Spec || params.partDescription,
      g1Code ? [g1Code] : [],
      missionType,
      1,
    )
    diagnosticReport = lisma.diagnosticReport || ''
    // FIX (Task 19 audit A#5): persist LISMA worklog + evidence (DR + rubric
    // score không còn thất lạc sau khi pipeline chạy xong).
    await persistPartialWorklog(missionId, taskId, lisma.worklog, 'RESEARCH', {
      evidence: lisma.evidence,
      findingsFromEvidence: lisma.evidence,
    })
    emitLocal(`G2 LISMA review xong — ${lisma.escalated ? '⚠️ escalated' : 'OK'} · findings ${lisma.evidence.length} evidence (TC-06)${lisma.rubricScore ? ` · Rubric A ${lisma.rubricScore.score.toFixed(2)} (${lisma.rubricScore.grade})` : ''}`)
    if (lisma.escalated) {
      errors.push(
        `LISMA escalated: ${lisma.escalateReason || 'unknown'}`,
      )
    }

    // RWV loop (READ → WRITE → VERIFY) — fail-open: LLM unavailable → ESCALATE
    // FIX (Task 19 audit A#1): runRwvRound trước đây KHÔNG BAO GIỜ được gọi
    // (startRwvLoop chỉ mkdir + return state; comment "state captured in DB via
    // runRwvRound internal persist" sai sự thật — 522 dòng RWV = dead code).
    // Giờ chạy vòng THẬT (lística lismaCall LLM-backed) tới DONE/ESCALATE,
    // trần do state machine nội bộ (maxRounds=2, DR-C5) + safety guard 4.
    try {
      let rwv = await startRwvLoop(missionId, taskId, undefined, g1Spec)
      let safety = 0
      while (safety < 4) {
        rwv = await runRwvRound(rwv, lismaCall)
        safety++
        if (rwv.status === 'DONE' || rwv.status === 'ESCALATE') break
      }
      emitLocal(
        `G2 RWV loop xong (vòng ${rwv.round}) — status ${rwv.status}${
          rwv.filesChanged.length > 0 ? ` · ${rwv.filesChanged.length} file(s) trong workspace (TC-10)` : ''
        }`,
      )
      if (rwv.status === 'ESCALATE') {
        errors.push(`RWV: ${rwv.escalateReason || 'escalated'}`)
      }
    } catch (err) {
      errors.push(
        `RWV: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  } catch (err) {
    errors.push(`LISMA: ${err instanceof Error ? err.message : String(err)}`)
  }

  // ---------- T3 only: G3 HAN optimize + Tournament ----------
  if (tier !== 'T3') {
    return
  }

  // Handoff G2 → G3 (gate E4 TC-14 — fail-open)
  try {
    const handoff = await performHandoff(taskId, 'G2', 'G3', missionType)
    if (!handoff.transitioned) {
      errors.push(`Handoff G2→G3 skipped: ${handoff.handoff.reason}`)
      emitLocal(`Handoff G2→G3 bị chặn (TC-14): ${handoff.handoff.reason?.slice(0, 100) || 'unknown'}`)
    } else {
      emitLocal('Handoff G2→G3 PASSED (TC-14) — task chuyển sang G3')
    }
  } catch (err) {
    errors.push(
      `Handoff G2→G3: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  // G3 — HAN optimize
  let hanOptions = 0
  let hanResult: HanOptimizeResult | null = null
  try {
    hanResult = await runHanOptimize(
      missionId,
      taskId,
      g1Code || '(no code draft)',
      diagnosticReport || '(no diagnostic report)',
      missionType,
      params.successCriteriaStrings,
    )
    hanOptions = hanResult.options.length
    // FIX (Task 19 audit B#7): persist HAN worklog — trước đây chỉ đếm
    // options.length, worklog 8 trường + kbEntries + proposalItems của HAN
    // bị discard (mission T3 không để lại audit-trail G3 nào).
    await persistPartialWorklog(missionId, taskId, hanResult.worklog, 'RESEARCH', {
      kbRefs: hanResult.kbEntries,
    })
    emitLocal(
      `G3 HAN optimize xong — ${hanOptions} option(s) A/B/C${
        hanResult.proposalItems.length > 0 ? ` · ${hanResult.proposalItems.length} proposal item(s)` : ''
      }${hanResult.kbEntries.length > 0 ? ` · ${hanResult.kbEntries.length} KB entries` : ''}`,
    )
    if (hanOptions === 0) {
      errors.push(`HAN: 0 options generated (LLM unavailable or M1 no-op)`)
    }
  } catch (err) {
    errors.push(`HAN: ${err instanceof Error ? err.message : String(err)}`)
  }

  // Tournament (TB-14 §3) — inject LLM-backed callbacks (DI pattern).
  // Mỗi callback wrap try/catch — fail-open (return empty / WEAK).
  try {
    const agents: TournamentAgents = {
      generateHypotheses: async (problemStmt) => {
        try {
          return await llmGenerateHypotheses(problemStmt)
        } catch (err) {
          errors.push(
            `Tournament V1 generateHypotheses: ${err instanceof Error ? err.message : String(err)}`,
          )
          return []
        }
      },
      runKillTest: async (hypothesis, killCriteria) => {
        try {
          return await llmRunKillTest(hypothesis, killCriteria)
        } catch (err) {
          errors.push(
            `Tournament V3 runKillTest: ${err instanceof Error ? err.message : String(err)}`,
          )
          return { pass: false, evidence: 'LLM unavailable' }
        }
      },
      runPoc: async (optionId, spec) => {
        try {
          // FIX (Task 19 audit B#3 + A#11): POC chạy 1 vòng RWV THẬT trên taskId
          // GỐC (taskId ghép `${taskId}-${optionId}` tạo FK ResearchWorklog
          // không hợp lệ → persist fail bị nuốt); metrics thật (trạng thái RWV +
          // số file); success chỉ true khi VERIFY pass — hết "optimistic fictional data".
          const state = await startRwvLoop(missionId, taskId, undefined, spec)
          const after = await runRwvRound(state, lismaCall)
          emitLocal(`Tournament ④ EXPERIMENT — POC option ${optionId}: RWV ${after.status} (round ${after.round})`)
          return {
            branchName: state.branchName || `P-POC-${optionId}`,
            metrics: {
              rwvStatus: after.status,
              rwvRound: after.round,
              filesTouched: after.filesChanged.length,
              regressions: after.regressionEntries.length,
            } as Record<string, unknown>,
            success: after.status === 'DONE',
          }
        } catch (err) {
          errors.push(
            `Tournament V4 runPoc: ${err instanceof Error ? err.message : String(err)}`,
          )
          return {
            branchName: `P-POC-${optionId}`,
            metrics: {} as Record<string, unknown>,
            success: false,
          }
        }
      },
      scoreHypothesisBlind: async (h, problemStmt) => {
        try {
          return await llmScoreHypothesisBlind(h, problemStmt)
        } catch (err) {
          errors.push(
            `Tournament V2 scoreHypothesisBlind: ${err instanceof Error ? err.message : String(err)}`,
          )
          return { sa1: 0, sa2: 0 }
        }
      },
    }

    // FIX (Task 19 audit B#2): truyền missionContext + patternContext cho
    // tournament — trước đây 2 param luôn undefined → checkContextFit (TC-17)
    // + evaluateDirectApply (TB-14 §7) là dead path, council ⑤ luôn "(no context-fit)".
    // patternContext build từ option HAN đầu tiên (verifyPlan → preConditions,
    // risks → contraindication) — dữ liệu thật của mission hiện hành.
    const missionContext: MissionContext = {
      module: missionType === 'M2' ? 'TMO system' : 'research workspace',
      protocolTier: tier,
      dataScale: 'unknown',
      loadProfile: 'local',
      dependencies: [],
      environment: 'sandbox',
      timeConstraint: 'none',
      userPolicy: 'live-read-only (DR-C1)',
    }
    const hanFirst = hanResult?.options?.[0]
    const patternContext: ContextFitInput | undefined = hanFirst
      ? {
          module: missionType === 'M2' ? 'TMO system' : 'research workspace',
          protocolTier: tier,
          dataScale: 'unknown',
          loadProfile: 'local',
          dependencies: [],
          environment: 'both',
          timeConstraint: 'none',
          userPolicy: 'live-read-only (DR-C1)',
          preConditions: (hanFirst.verifyPlan || []).slice(0, 5),
          contraindication: (hanFirst.risks || []).slice(0, 5),
          adaptationDelta: [],
        }
      : undefined

    const tournament = await runTournament({
      missionId,
      problemStmt: params.partDescription,
      missionType,
      tier,
      successCriteria: params.successCriteriaStrings,
      agents,
      missionContext,
      patternContext,
      deployMode: 'proposal', // T3 → luôn Proposal (TB-14 §9 DIRECT-APPLY chỉ T1/T2 eligible)
    })

    if (tournament.councilVerdict === 'DROP') {
      errors.push(`Tournament verdict DROP — no hypothesis converged`)
    }
    emitLocal(
      `Tournament 5 vòng xong (iterations ${tournament.iterations}) — council ⑤ verdict: ${tournament.councilVerdict}${
        tournament.winningOptionId ? ` · winner option ${tournament.winningOptionId}` : ''
      }`,
    )
  } catch (err) {
    errors.push(
      `Tournament: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

// ============================================================
// §8c. INTERNAL HELPERS — LLM-backed callbacks cho Tournament (DI)
// ============================================================

/**
 * System prompt cho các vòng RWV (READ/WRITE/VERIFY) — LISMA thực thi.
 * Ngắn gọn theo phase instruction trong user prompt của rwv-loop.ts.
 */
const RWV_ROUND_SYSTEM_PROMPT = [
  'Bạn là LISMA (G2 — research team TMO). Đang thực hiện 1 phase của RWV loop',
  '(READ → WRITE → VERIFY — TB-09 §1-§3).',
  '- Tuân thủ CHÍNH XÁC instruction của phase trong prompt (output format, path trong workspace).',
  '- TC-10: mọi file path PHẢI nằm trong workspace root — KHÔNG bao giờ đụng file ngoài.',
  '- Output ngắn gọn, đúng format — KHÓNG giải thích thừa.',
].join('\n')

/**
 * FIX (Task 19 audit A#5 + B#7): persist Partial<WorklogEntry> từ G2 LISMA /
 * G3 HAN vào ResearchWorklog — trước đây kết quả review/optimizer KHÔNG được
 * persist (0 dòng trong DB sau khi pipeline chạy xong) → audit-trail TB-04 §5
 * trống rỗng + handoff gate không có evidence để check + NEMESIS MONITOR đọc
 * không thấy gì của G2/G3.
 *
 * - Fill đủ 8 trường TB-09 §4.2 từ partial + default an toàn.
 * - evidence[] persist vào evidenceJson (TC-06 — handoff gate check được).
 * - findings build từ evidence items (claim đã có evidence → không tạo gap ảo).
 *
 * Fail-open: DB error → warn, KHÔNG throw (pipeline không crash).
 */
async function persistPartialWorklog(
  missionId: string,
  taskId: string,
  partial: Partial<WorklogEntry>,
  phase: string,
  extras: {
    evidence?: EvidenceItem[]
    findingsFromEvidence?: EvidenceItem[]
    kbRefs?: string[]
  } = {},
): Promise<void> {
  try {
    const findingsFromEvidence = extras.findingsFromEvidence || []
    const entry: WorklogEntry = {
      mission: (partial.mission as 'M1' | 'M2' | 'M3') || 'M2',
      status: partial.status || 'IN_PROGRESS',
      currentPhase: partial.currentPhase || 'G2',
      overallProgress: typeof partial.overallProgress === 'number' ? partial.overallProgress : 50,
      tlReadBack: partial.tlReadBack || 'NEEDS-REVIEW',
      done: partial.done || [],
      issuesFaced: partial.issuesFaced || [],
      suggestionsNextGroup: partial.suggestionsNextGroup || [],
      filesChanged: partial.filesChanged || [],
      ...(findingsFromEvidence.length > 0
        ? {
            findings: findingsFromEvidence.map((e, i) => ({
              no: i + 1,
              finding: e.claim,
              evidence: `${e.file}:${e.line}${e.excerpt ? ` — ${e.excerpt}` : ''}`,
              severity: 'MEDIUM' as const,
              proposal: '',
            })),
          }
        : {}),
      ...(extras.kbRefs && extras.kbRefs.length > 0 ? { kbEntries: extras.kbRefs } : {}),
    }
    await db.researchWorklog.create({
      data: {
        taskId,
        missionId,
        phase,
        entryJson: encodeJson(entry),
        evidenceJson: encodeJson(extras.evidence || []),
      },
    })
  } catch (err) {
    console.warn(
      '[KingEngine] persistPartialWorklog failed (non-blocking):',
      err instanceof Error ? err.message : String(err),
    )
  }
}

const HYPOTHESIS_GEN_SYSTEM_PROMPT = [
  'Bạn là SIVIL (G1 — Research Team TMO).',
  'Nhiệm vụ: sinh ≥3 hypothesis từ problem statement (TB-14 §3 vòng 1 GENERATE).',
  'Mỗi hypothesis phải khác approach (không phải variant của nhau).',
  '',
  'OUTPUT JSON-DUY-NAHAT: mảng các object { "hypothesis": "...", "evidence": ["..."] }',
  'Tối thiểu 3 hypothesis. KHÔNG markdown fence, KHÔNG giải thích thêm.',
].join('\n')

const KILL_TEST_SYSTEM_PROMPT = [
  'Bạn là LISMA (G2 — Research Team TMO).',
  'Nhiệm vụ: chạy kill-test cho hypothesis với killCriteria (TB-14 §3 vòng 3 FALSIFY).',
  '- Nếu evidence quan sát được thỏa killCriteria → hypothesis bị bác (pass=false).',
  '- Nếu không → hypothesis sống sót (pass=true).',
  '',
  'OUTPUT JSON-DUY-NAHAT: { "pass": true|false, "evidence": "..." }',
].join('\n')

const BLIND_SCORE_SYSTEM_PROMPT = [
  'Bạn là SA blind scorer (TB-14 §1.3 AC5 — KHÔNG do SIVIL tự chấm).',
  'Nhiệm vụ: chấm dim D4 reproducibility (0-5, thang Rubric A) cho hypothesis.',
  '- D4 = reproducibility: hypothesis có thể tái lập qua experiment độc lập không?',
  '- FIX (Task 19 audit B#6): thang 0-5 (khớp RubricAInput.blindSas) — trước đây',
  '  prompt 0-10 mâu thuẫn contract rubric (clamp 5 → SA chấm 6-10 đều thành 5).',
  '',
  'OUTPUT JSON-DUY-NHAT: { "score": <0-5> }',
].join('\n')

/** Generate ≥3 hypotheses via callLLM (SIVIL role). Fail-open: return []. */
async function llmGenerateHypotheses(
  problemStmt: string,
): Promise<{ hypothesis: string; evidence: string[] }[]> {
  const prompt = [
    `PROBLEM: ${problemStmt}`,
    '',
    'Sinh ≥3 hypothesis (mỗi hypothesis kèm ≥1 evidence):',
  ].join('\n')
  // Task 4 — route SIVIL qua Zen khi DB provider='zen' (fail-open → NIM).
  const sivilBrain = await resolveResearchBrain('SIVIL')
  const llm = await callLLMForAgent(prompt, sivilBrain, HYPOTHESIS_GEN_SYSTEM_PROMPT, {
    temperature: 0.5,
    maxTokens: 1200,
    agentId: AGENT_ID.SIVIL,
    agentName: 'SIVIL (Tournament V1)',
  })
  if (llm.error || !llm.content || llm.content.trim().length === 0) {
    return []
  }
  // Parse JSON array (try direct, fence, then array substring)
  const content = llm.content.trim()
  const tryParse = (s: string): unknown => {
    try {
      return JSON.parse(s)
    } catch {
      return null
    }
  }
  let parsed = tryParse(content)
  if (!parsed) {
    const fence = content.match(/```(?:json)?\s*([\s\S]*?)\s*```/)
    if (fence) parsed = tryParse(fence[1])
  }
  if (!parsed) {
    const arr = content.match(/\[[\s\S]*\]/)
    if (arr) parsed = tryParse(arr[0])
  }
  if (!Array.isArray(parsed)) return []
  return parsed
    .filter((p): p is { hypothesis: string; evidence: string[] } => {
      if (!p || typeof p !== 'object') return false
      const o = p as Record<string, unknown>
      return typeof o.hypothesis === 'string' && Array.isArray(o.evidence)
    })
    .slice(0, 10)
}

/** Run kill-test via callLLM (LISMA role). Fail-open: return pass=false. */
async function llmRunKillTest(
  hypothesis: string,
  killCriteria: string,
): Promise<{ pass: boolean; evidence: string }> {
  const prompt = [
    `HYPOTHESIS: ${hypothesis}`,
    `KILL CRITERIA: ${killCriteria}`,
    '',
    'Chạy kill-test — evidence quan sát được thỏa killCriteria không?',
  ].join('\n')
  // Task 4 — route LISMA qua Zen khi DB provider='zen' (fail-open → NIM).
  const lismaBrain = await resolveResearchBrain('LISMA')
  const llm = await callLLMForAgent(prompt, lismaBrain, KILL_TEST_SYSTEM_PROMPT, {
    temperature: 0.2,
    maxTokens: 400,
    agentId: AGENT_ID.LISMA,
    agentName: 'LISMA (Tournament V3)',
  })
  if (llm.error || !llm.content || llm.content.trim().length === 0) {
    return { pass: false, evidence: 'LLM unavailable' }
  }
  const content = llm.content.trim()
  const tryParse = (s: string): unknown => {
    try {
      return JSON.parse(s)
    } catch {
      return null
    }
  }
  let parsed = tryParse(content)
  if (!parsed) {
    const fence = content.match(/```(?:json)?\s*([\s\S]*?)\s*```/)
    if (fence) parsed = tryParse(fence[1])
  }
  if (!parsed) {
    const obj = content.match(/\{[\s\S]*\}/)
    if (obj) parsed = tryParse(obj[0])
  }
  if (!parsed || typeof parsed !== 'object') {
    return { pass: false, evidence: 'parse fail' }
  }
  const o = parsed as Record<string, unknown>
  return {
    pass: o.pass === true,
    evidence: typeof o.evidence === 'string' ? o.evidence : '(no evidence)',
  }
}

/** Score hypothesis blind via 2x callLLM (TB-14 §1.3 AC5). Fail-open: 0. */
async function llmScoreHypothesisBlind(
  h: { hypothesis: string; evidence: string[] },
  problemStmt: string,
): Promise<{ sa1: number; sa2: number }> {
  const prompt = [
    `PROBLEM: ${problemStmt}`,
    `HYPOTHESIS: ${h.hypothesis}`,
    `EVIDENCE: ${h.evidence.join('; ') || '(none)'}`,
    '',
    'Chấm D4 reproducibility (0-5):',
  ].join('\n')
  // 2 SA blind scorers (TB-14 §1.3 AC5 — KHÔNG do SIVIL tự chấm)
  // Task 4 — blind judge → NEMESIS brain (TL chấm điểm default — fail-open → NIM).
  const blindBrain = await resolveResearchBrain('NEMESIS')
  const [r1, r2] = await Promise.all([
    callLLMForAgent(prompt, blindBrain, BLIND_SCORE_SYSTEM_PROMPT, {
      temperature: 0.2,
      maxTokens: 200,
      agentId: AGENT_ID.NEMESIS,
      agentName: 'NEMESIS (Blind SA1)',
    }),
    callLLMForAgent(prompt, blindBrain, BLIND_SCORE_SYSTEM_PROMPT, {
      temperature: 0.2,
      maxTokens: 200,
      agentId: AGENT_ID.NEMESIS,
      agentName: 'NEMESIS (Blind SA2)',
    }),
  ])
  const parseScore = (r: LLMResult): number => {
    if (r.error || !r.content) return 0
    const m = r.content.match(/"score"\s*:\s*(\d+(?:\.\d+)?)/)
    // FIX (Task 19 audit B#6): clamp về thang 0-5 (RubricAInput.blindSas)
    if (m) return Math.min(5, Math.max(0, parseFloat(m[1])))
    return 0
  }
  return { sa1: parseScore(r1), sa2: parseScore(r2) }
}

// ============================================================
// §9. INTERNAL HELPERS
// ============================================================

/** Extract proposal items từ final report markdown — heuristic M2. */
function extractProposalItems(finalReport: string): string[] {
  if (!finalReport) return []
  const items: string[] = []

  // Section "## Proposal Items" → bullet list items
  const section = finalReport.match(/##\s+Proposal\s+Items[\s\S]*?(?=\n##\s|$)/i)
  if (section) {
    const lines = section[0].split('\n').filter((l) => l.trim().startsWith('-'))
    for (const line of lines) {
      const text = line.replace(/^[\s-]+/, '').trim()
      if (text.length > 5) items.push(text)
    }
  }

  // Section "## Proposal" (M2 alt) → bullet items
  if (items.length === 0) {
    const alt = finalReport.match(/##\s+Proposal[\s\S]*?(?=\n##\s|$)/i)
    if (alt) {
      const lines = alt[0].split('\n').filter((l) => l.trim().startsWith('-'))
      for (const line of lines) {
        const text = line.replace(/^[\s-]+/, '').trim()
        if (text.length > 5) items.push(text)
      }
    }
  }

  return items
}
