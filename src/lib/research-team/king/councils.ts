/**
 * RESEARCH TEAM — NEMESIS COUNCILS (TB-06 councils ①②③④⑤ + TB-14 council ⑤ agenda 5 mục)
 * ============================================================================================
 * Spec:
 *  - TB-06 §10.1 — council ① post-DECOMPOSE (verify Success Criteria gate TC-13).
 *  - TB-06 §10.2 — council ② pre-code (challenge synthesis — gate TC-07).
 *  - TB-06 §8 — council ③ escalation (G1/G2/G3 ESCALATE → NEMESIS chủ trì + agent liên quan).
 *  - TB-06 §9.8 — council ④ final (FINALIZE — NEMESIS + all agents, verify proposal Verification Plan).
 *  - TB-14 §6.2 — council ⑤ solution council (5 mục agenda: hypothesis/experiment/calibration/
 *    context-fit/verdict) — CONTINUE-ITERATE|CONVERGE|PIVOT|DROP.
 *
 * Wiring (TB-13 §1 nguyên tắc 7 — tái dùng hạ tầng, KHÔNG NLP phức tạp):
 *  - ① ② delegate to g1/engine.runCouncil (P2 đã code — round=1 / round=2).
 *  - ⑤ delegate to scoring/tournament.runCouncil5 (P2b đã code — wrapper, KHÔNG double-persist
 *      vì tournament đã persist CouncilTranscript round=5 kind=5).
 *  - ③ ④ new — implemented here (LLM-assisted council, persist CouncilTranscript round=3/4).
 *
 * Fail-open: LLM error → fail-open verdict REVISE + 'council deferred'. KHÔNG crash.
 */

import { db } from '@/lib/db'
import { callLLMForAgent } from '@/lib/llm'
import type { LLMResult } from '@/lib/llm'
import { RESEARCH_ROSTER, AGENT_ID } from '../constants'
import { resolveResearchBrain } from '../agents'
import { COUNCIL_ROUNDS } from '../types'
import { runCouncil } from '../g1/engine'
import { runCouncil5 as runTournamentCouncil5 } from '../scoring/tournament'

// ============================================================
// §1. COUNCIL AGENDAS — TB-06 + TB-14 §6.2 (5 mục agenda council ⑤)
// ============================================================

export const COUNCIL_AGENDAS = {
  council1: '① post-DECOMPOSE — verify Success Criteria (gate TC-13). VETO nếu thiếu.',
  council2: '② pre-code — challenge synthesis + đối chiếu KB → PASS/REVISE/VETO (gate TC-07).',
  council3: '③ escalation — NEMESIS chủ trì + agent liên quan quyết: revise / hủy task / pivot.',
  council4: '④ final — NEMESIS + all agents. Verify proposal Verification Plan (TB-11 §7) → PASS/REVISE/VETO.',
  council5:
    '⑤ solution — TB-14 §6.2 5 mục agenda: (1) hypothesis status; (2) experiment scorecard B; (3) calibration delta TC-16; (4) context-fit TC-17; (5) verdict cuối CONTINUE-ITERATE|CONVERGE|PIVOT|DROP.',
} as const

// ============================================================
// §2. SYSTEM PROMPT — Council ③ (TB-06 §8 escalation) + Council ④ (§9.8 final)
// ============================================================

const COUNCIL_3_SYSTEM_PROMPT = [
  'Bạn là NEMESIS (TL — research team TMO), chủ trì Council ③ escalation.',
  `JD: ${RESEARCH_ROSTER.find((r) => r.id === AGENT_ID.NEMESIS)?.jd ?? 'Phân loại mission, chia nhỏ bài toán, kiểm soát chặt — không code'}.`,
  '',
  'COUNCIL ③ (TB-06 §8 — escalation): G1/G2/G3 ESCALATE → NEMESIS chủ trì + agent liên quan.',
  '  - Quyết: revise approach / hủy task / pivot / escalate USER.',
  '  - VETO → escalate USER (block). REVISE → loop lại G1/G2/G3 với conditions.',
  '  - PASS → tiếp tục pipeline (escalate resolved).',
  '',
  'NGUYÊN TẮC:',
  '  - NEMESIS KHÔNG code — chỉ quyết định hướng.',
  '  - Mọi quyết định ghi Decision Log (TC-09 — PIVOT BẮT BUỘC lý do).',
  '  - Deputy SIVIL/HAN có thể được chỉ định khi NEMESIS recuse (DR-C5 §C5).',
  '',
  'OUTPUT JSON-DUY-NAHAT:',
  '{"verdict": "PASS"|"REVISE"|"VETO", "transcript": "<tóm tắt lý do>", "deputy": "SIVIL"|"HAN"|null}',
].join('\n')

const COUNCIL_4_SYSTEM_PROMPT = [
  'Bạn là NEMESIS (TL — research team TMO), chủ trì Council ④ final.',
  `JD: ${RESEARCH_ROSTER.find((r) => r.id === AGENT_ID.NEMESIS)?.jd ?? 'Phân loại mission, chia nhỏ bài toán, kiểm soát chặt — không code'}.`,
  '',
  'COUNCIL ④ (TB-06 §9.8 FINALIZE): NEMESIS + SIVIL + BELI + LISMA + HAN.',
  '  - Verify final report (M1) / Proposal (M2) đầy đủ + chính xác.',
  '  - Verify Proposal items có Verification Plan (TB-11 §7 — (a) manual + (b) benchmark).',
  '  - PASS → FINALIZE. REVISE → loop lại (M1: G2 fix bug; M2: G3 revise options).',
  '  - VETO → escalate USER (proposal không đạt — TC-11 REJECTED).',
  '',
  'NGUYÊN TẮC:',
  '  - NEMESIS KHÔNG tự duyệt Proposal (DR-C5 §C5 — recused; deputy/USER duyệt thay).',
  '  - Mọi claim BẮT BUỘC evidence (TC-06).',
  '  - Final report phải có: Lessons + Anti-Patterns + Suggestions sections (TB-08 §7 capture).',
  '',
  'OUTPUT JSON-DUY-NAHAT:',
  '{"verdict": "PASS"|"REVISE"|"VETO", "transcript": "<tóm tắt>", "finalReport": "<full markdown final report>"}',
].join('\n')

// ============================================================
// §3. COUNCIL ③ — TB-06 §8 ESCALATION (new — King-level)
// ============================================================

export interface Council3Input {
  reason: string
  conflicts?: unknown[]
  group?: 'G1' | 'G2' | 'G3'
}

export interface Council3Result {
  verdict: 'PASS' | 'REVISE' | 'VETO'
  transcript: string
  deputy?: 'SIVIL' | 'HAN'
}

/**
 * Council ③ escalation (TB-06 §8) — NEMESIS chủ trì + agent liên quan:
 *  - Gọi callLLM với Council ③ system prompt + escalation context.
 *  - Persist CouncilTranscript round=3 kind=3 blocking=true.
 *  - Verdict VETO → ESCALATE USER. REVISE → loop lại. PASS → tiếp tục.
 *  - Deputy có thể được chỉ định (SIVIL/HAN) nếu NEMESIS recuse.
 *
 * LLM error → fail-open REVISE + transcript 'council deferred — LLM unavailable'.
 */
export async function runCouncil3(
  missionId: string,
  escalationContext: Council3Input,
): Promise<Council3Result> {
  const prompt = [
    `MISSION: ${missionId}`,
    `ESCALATION FROM: ${escalationContext.group || '(unknown group)'}`,
    '',
    'REASON:',
    escalationContext.reason,
    '',
    'CONFLICTS (nếu có):',
    Array.isArray(escalationContext.conflicts) && escalationContext.conflicts.length > 0
      ? JSON.stringify(escalationContext.conflicts.slice(0, 5), null, 2)
      : '(none)',
    '',
    'Quyết verdict cuối. Output JSON theo system prompt.',
  ].join('\n')

  let llm: LLMResult
  try {
    // Task 4 — route NEMESIS qua Zen khi DB provider='zen' (fail-open → NIM).
    const nemesisBrain = await resolveResearchBrain('NEMESIS')
    llm = await callLLMForAgent(prompt, nemesisBrain, COUNCIL_3_SYSTEM_PROMPT, {
      temperature: 0.2,
      maxTokens: 1500,
      agentId: AGENT_ID.NEMESIS,
      agentName: 'NEMESIS (Council ③)',
    })
  } catch (err) {
    return failOpenCouncil3(missionId, `LLM call threw: ${err instanceof Error ? err.message : String(err)}`)
  }

  if (llm.error || !llm.content || llm.content.trim().length === 0) {
    return failOpenCouncil3(missionId, llm.error || 'LLM unavailable — empty content')
  }

  const parsed = extractJson(llm.content)
  const verdict = parseVerdict3(parsed?.verdict)
  const transcript =
    (typeof parsed?.transcript === 'string' && parsed.transcript) ||
    llm.content ||
    '(council transcript empty)'
  const deputy = parseDeputy(parsed?.deputy)

  await persistTranscript(missionId, COUNCIL_ROUNDS.escalation, 3, verdict, transcript)

  return { verdict, transcript, deputy }
}

// ============================================================
// §4. COUNCIL ④ — TB-06 §9.8 FINALIZE (new — King-level)
// ============================================================

export interface Council4Input {
  finalReport?: string
  proposalItems?: string[]
  metrics?: unknown
}

export interface Council4Result {
  verdict: 'PASS' | 'REVISE' | 'VETO'
  transcript: string
  finalReport: string
}

/**
 * Council ④ final (TB-06 §9.8 FINALIZE) — NEMESIS + all agents:
 *  - Verify final report (M1) / Proposal (M2) đầy đủ + chính xác.
 *  - Verify Proposal items có Verification Plan (TB-11 §7).
 *  - Persist CouncilTranscript round=4 kind=4 blocking=true.
 *  - Verdict PASS → FINALIZE. REVISE → loop lại. VETO → escalate USER (TC-11).
 *
 * LLM error → fail-open REVISE + transcript 'council deferred — LLM unavailable'.
 */
export async function runCouncil4(
  missionId: string,
  finalizeContext: Council4Input,
): Promise<Council4Result> {
  const prompt = [
    `MISSION: ${missionId}`,
    '',
    'FINAL REPORT (draft):',
    finalizeContext.finalReport || '(no final report draft)',
    '',
    'PROPOSAL ITEMS (nếu có — M2):',
    Array.isArray(finalizeContext.proposalItems) && finalizeContext.proposalItems.length > 0
      ? finalizeContext.proposalItems.map((p, i) => `[${i + 1}] ${p}`).join('\n')
      : '(none — M1 mode hoặc chưa sinh Proposal)',
    '',
    'METRICS:',
    finalizeContext.metrics
      ? JSON.stringify(finalizeContext.metrics, null, 2)
      : '(none)',
    '',
    'Council ④: verify final report + proposal Verification Plan (TB-11 §7). Output JSON.',
  ].join('\n')

  let llm: LLMResult
  try {
    // Task 4 — route NEMESIS qua Zen khi DB provider='zen' (fail-open → NIM).
    const nemesisBrain = await resolveResearchBrain('NEMESIS')
    llm = await callLLMForAgent(prompt, nemesisBrain, COUNCIL_4_SYSTEM_PROMPT, {
      temperature: 0.2,
      maxTokens: 3000,
      agentId: AGENT_ID.NEMESIS,
      agentName: 'NEMESIS (Council ④)',
    })
  } catch (err) {
    return failOpenCouncil4(missionId, `LLM call threw: ${err instanceof Error ? err.message : String(err)}`, finalizeContext.finalReport)
  }

  if (llm.error || !llm.content || llm.content.trim().length === 0) {
    return failOpenCouncil4(missionId, llm.error || 'LLM unavailable — empty content', finalizeContext.finalReport)
  }

  const parsed = extractJson(llm.content)
  const verdict = parseVerdict4(parsed?.verdict)
  const transcript =
    (typeof parsed?.transcript === 'string' && parsed.transcript) ||
    llm.content ||
    '(council transcript empty)'
  const finalReport =
    (typeof parsed?.finalReport === 'string' && parsed.finalReport) ||
    finalizeContext.finalReport ||
    '(no final report)'

  await persistTranscript(missionId, COUNCIL_ROUNDS.final, 4, verdict, transcript)

  return { verdict, transcript, finalReport }
}

// ============================================================
// §5. COUNCIL ⑤ — TB-14 §6.2 SOLUTION (delegate to scoring/tournament)
// ============================================================

export interface Council5Result {
  verdict: 'CONTINUE-ITERATE' | 'CONVERGE' | 'PIVOT' | 'DROP'
  winningOptionId?: string
  transcript: string
}

/**
 * Council ⑤ solution (TB-14 §6.2) — Wrapper cho NEMESIS gọi:
 *  - Delegate to scoring/tournament.runCouncil5 (P2b đã code — đã persist CouncilTranscript
 *      round=5 kind=5). KHÔNG double-persist.
 *  - Extract hypotheses/experiments/contextFit từ tournamentResult (defensive cast).
 *
 * LLM error trong tournament.runCouncil5 → fail-open DROP + transcript 'council deferred'.
 */
export async function runCouncil5(
  missionId: string,
  tournamentResult: unknown,
): Promise<Council5Result> {
  // Defensive extract từ tournamentResult (TournamentResult shape — P2b)
  const t = (tournamentResult || {}) as Record<string, unknown>
  const hypotheses = Array.isArray(t.hypotheses) ? t.hypotheses : []
  const experiments = Array.isArray(t.experiments) ? t.experiments : []
  const contextFit = t.contextFit ?? null
  const iterations = typeof t.iterations === 'number' ? t.iterations : 1
  const maxIterations = typeof t.maxIterations === 'number' ? t.maxIterations : 3

  // Delegate to tournament.runCouncil5 — PERSIST sẽ do tournament lo (no double-persist here)
  const result = await runTournamentCouncil5({
    missionId,
    hypotheses: hypotheses as Parameters<typeof runTournamentCouncil5>[0]['hypotheses'],
    experiments: experiments as Parameters<typeof runTournamentCouncil5>[0]['experiments'],
    contextFit: contextFit as Parameters<typeof runTournamentCouncil5>[0]['contextFit'],
    iteration: iterations,
    maxIterations,
  })

  return {
    verdict: result.verdict,
    winningOptionId: result.winningOptionId,
    transcript: result.transcript,
  }
}

// ============================================================
// §6. RE-EXPORT — g1 council ① ② (caller P5 NEMESIS engine dùng)
// ============================================================

export { runCouncil } from '../g1/engine'

// ============================================================
// §7. INTERNAL HELPERS — JSON parse + verdict parse + persist
// ============================================================

function extractJson(content: string): Record<string, unknown> | null {
  if (!content || typeof content !== 'string') return null
  const trimmed = content.trim()

  try {
    const parsed = JSON.parse(trimmed)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
  } catch {
    // fallthrough
  }

  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)
  if (fenceMatch) {
    try {
      const parsed = JSON.parse(fenceMatch[1])
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
    } catch {
      // fallthrough
    }
  }

  const braceMatch = trimmed.match(/\{[\s\S]*\}/)
  if (braceMatch) {
    try {
      const parsed = JSON.parse(braceMatch[0])
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
    } catch {
      // fallthrough
    }
  }

  return null
}

function parseVerdict3(v: unknown): 'PASS' | 'REVISE' | 'VETO' {
  if (typeof v !== 'string') return 'REVISE' // safe default
  const upper = v.toUpperCase().trim()
  if (upper === 'PASS') return 'PASS'
  if (upper === 'VETO') return 'VETO'
  return 'REVISE'
}

function parseVerdict4(v: unknown): 'PASS' | 'REVISE' | 'VETO' {
  return parseVerdict3(v)
}

function parseDeputy(v: unknown): 'SIVIL' | 'HAN' | undefined {
  if (typeof v !== 'string') return undefined
  const upper = v.toUpperCase().trim()
  if (upper === 'SIVIL') return 'SIVIL'
  if (upper === 'HAN') return 'HAN'
  return undefined
}

async function persistTranscript(
  missionId: string,
  round: number,
  kind: number,
  verdict: string,
  transcript: string,
): Promise<void> {
  try {
    await db.councilTranscript.create({
      data: {
        missionId,
        round,
        kind,
        verdict,
        blocking: true,
        transcript,
      },
    })
  } catch (err) {
    console.warn(
      `[Council ${kind}] persist CouncilTranscript failed (non-blocking):`,
      err instanceof Error ? err.message : String(err),
    )
  }
}

function failOpenCouncil3(missionId: string, reason: string): Council3Result {
  const transcript = `Council ③ DEFERRED (LLM unavailable): ${reason}\nKHÔNG crash — verdict REVISE (cần manual review).`
  void persistTranscript(missionId, COUNCIL_ROUNDS.escalation, 3, 'REVISE', transcript)
  return { verdict: 'REVISE', transcript }
}

function failOpenCouncil4(
  missionId: string,
  reason: string,
  finalReportDraft: string | undefined,
): Council4Result {
  const transcript = `Council ④ DEFERRED (LLM unavailable): ${reason}\nKHÔNG crash — verdict REVISE (cần manual review).`
  void persistTranscript(missionId, COUNCIL_ROUNDS.final, 4, 'REVISE', transcript)
  return {
    verdict: 'REVISE',
    transcript,
    finalReport: finalReportDraft || '(no final report — LLM unavailable)',
  }
}
