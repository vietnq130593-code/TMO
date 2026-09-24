/**
 * RESEARCH TEAM — G1 ENGINE (TB-03 §4 orchestration + councils ①② + TC-03/TC-07)
 * =================================================================================
 * Spec:
 *  - TB-03 §4 — G1 Internal Workflow 6 bước:
 *      DECOMPOSE → DISPATCH → SYNTHESIZE → SYNC (council ②) → IMPLEMENT → VERIFY.
 *  - TB-03 §4.4 — council ② pre-code: NEMESIS challenge hypotheses + đối chiếu KB
 *    → chốt specs trước khi BELI code (cổng bắt buộc — TC-07).
 *  - TB-06 §10.1 — council ① post-DECOMPOSE (TL level): verify Success Criteria
 *    → VETO nếu thiếu (gate TC-13 — task .md phải có Success Criteria trước ASSIGN).
 *  - TB-03 §5.3 — dual-interpretation: 2 SA conflict không giải thích được →
 *    ESCALATE NEMESIS kèm 2 interpretation (TC-03 gate).
 *  - TB-03 §8 — feedback loop: REVISE → loop (max 3 vòng TB-03 §8 + §12 Q6).
 *
 * TC-07 ORDER (TB-12 §3.2): Council ① (post-DECOMPOSE) → SIVIL SYNTHESIZE →
 * Council ② (pre-code) → BELI SPEC. KHÔNG đảo thứ tự.
 *
 * Fail-open policy (TB-13 §4 — NIM keys placeholder):
 *  - LLM error trong council → verdict REVISE + transcript 'LLM unavailable —
 *    council deferred, manual review needed', KHÔNG crash.
 *  - CouncilTranscript vẫn persist với blocking=true (council đồng bộ — chặn).
 */

import { db } from '@/lib/db'
import { callLLMForAgent } from '@/lib/llm'
import type { LLMResult } from '@/lib/llm'
import { RESEARCH_ROSTER, AGENT_ID } from '../constants'
import { resolveResearchBrain } from '../agents'
import { encodeJson, type WorklogEntry, type SuccessCriterion } from '../types'
import {
  runSivilExplore,
  type SivilExploreResult,
} from './sivil'
import { runBeliSpec, type BeliSpecResult } from './beli'
import {
  validateArtifactMap,
  validateSuccessCriteria,
  type ArtifactMap,
} from './artifact-map'
import type { SubAgent } from './sub-agents'

// ============================================================
// §1. TYPES — Council I/O + G1 round result
// ============================================================

export type CouncilVerdict = 'PASS' | 'REVISE' | 'VETO'

export interface CouncilInput {
  missionId: string
  round: 1 | 2 // ① post-DECOMPOSE | ② pre-code
  context: {
    synthesis?: string
    spec?: string
    conflicts?: SubAgent[]
    successCriteria?: SuccessCriterion[]
    taskDescription?: string
  }
}

export interface CouncilResult {
  verdict: CouncilVerdict
  transcript: string
  /** Council blocking = true (TB-13 §3 CouncilTranscript.blocking) */
  blocking: boolean
  /** Conditions nếu REVISE — caller loop lại với điều chỉnh */
  conditions?: string[]
  /** Refs persisted — CouncilTranscript row id */
  transcriptId?: string
}

export interface G1RoundResult {
  synthesis: string
  spec: string
  council1: CouncilResult
  council2: CouncilResult
  worklog: Partial<WorklogEntry>
  conflicts: SubAgent[]
  escalated: boolean
  escalateReason?: string
  artifactMap: ArtifactMap
  beliResult?: BeliSpecResult
  sivilResult?: SivilExploreResult
}

// ============================================================
// §2. SYSTEM PROMPT — Council (NEMESIS chủ trì + SIVIL tham vấn)
// ============================================================

const COUNCIL_SYSTEM_PROMPT = [
  'Bạn là NEMESIS (Team Lead — research team TMO), chủ trì Research Council.',
  `JD: ${RESEARCH_ROSTER.find((r) => r.id === AGENT_ID.NEMESIS)?.jd ?? 'Phân loại mission, chia nhỏ bài toán, kiểm soát chặt — không code'}.`,
  '',
  'RESEARCH COUNCIL (TB-08 + TB-03 §4.4):',
  '- ① post-DECOMPOSE: verify Success Criteria → VETO nếu thiếu (gate TC-13).',
  '- ② pre-code: challenge hypotheses của synthesis + đối chiếu KB → PASS/REVISE/VETO.',
  '',
  'QUYỀN VETO (TB-03 §12 Q3):',
  '- VETO → spec quay lại SIVIL revise; ≥2 vòng veto cùng spec → escalate council ③.',
  '- REVISE → loop lại G1 với conditions.',
  '- PASS → chốt specs → BELI code.',
  '',
  'NGUYÊN TẮC (TB-06 + TB-08):',
  '- NEMESIS KHÔNG code — chỉ challenge + chốt.',
  '- Mọi insight mới → ghi KB NGAY (KB Write Protocol — SIVIL thực thi).',
  '- Challenge hypotheses bằng findings, KHÔNG đoán.',
  '',
  'OUTPUT JSON ONLY:',
  '{',
  '  "verdict": "PASS" | "REVISE" | "VETO",',
  '  "transcript": "discussion summary — challenge gì, chốt gì",',
  '  "conditions": ["điều kiện nếu REVISE — SIVIL cần điều chỉnh gì"]',
  '}',
].join('\n')

// ============================================================
// §3. RUN COUNCIL — async (LLM call + persist CouncilTranscript)
// ============================================================

/**
 * Run council ① or ② (TB-03 §4.4 + TB-06 §10.1):
 *  - ① post-DECOMPOSE: verify Success Criteria (gate TC-13). Nếu thiếu → VETO.
 *  - ② pre-code: challenge synthesis → PASS/REVISE/VETO.
 *
 * Council blocking = true (TB-13 §3 — đồng bộ, chặn pipeline).
 *
 * LLM error → fail-open: verdict REVISE + transcript 'LLM unavailable —
 * council deferred, manual review needed', KHÔNG crash. CouncilTranscript vẫn
 * persist để audit trail.
 */
export async function runCouncil(input: CouncilInput): Promise<CouncilResult> {
  const { missionId, round, context } = input

  // ① post-DECOMPOSE: gate TC-13 — verify Success Criteria FIRST (no LLM needed)
  if (round === 1) {
    const scValidation = validateSuccessCriteria(context.successCriteria)
    if (!scValidation.valid) {
      // VETO — gate TC-13 fail
      const transcript =
        `COUNCIL ① VETO (gate TC-13): ${scValidation.reason}\n` +
        `NEMESIS yêu cầu bổ sung Success Criteria trước khi ASSIGN (TB-07 §11 Q5).`
      const result: CouncilResult = {
        verdict: 'VETO',
        transcript,
        blocking: true,
        conditions: ['Bổ sung Success Criteria (≥ 1 criterion với measure rõ ràng) theo DR-C3 append-only'],
      }
      const persisted = await persistTranscript(missionId, 1, 1, result)
      return { ...result, transcriptId: persisted?.id }
    }
  }

  // Build context cho LLM council
  const userPrompt = buildCouncilPrompt(input)

  let llm: LLMResult
  try {
    // Task 4 — route NEMESIS qua Zen khi DB provider='zen' (fail-open → NIM).
    const nemesisBrain = await resolveResearchBrain('NEMESIS')
    llm = await callLLMForAgent(userPrompt, nemesisBrain, COUNCIL_SYSTEM_PROMPT, {
      temperature: 0.2,
      maxTokens: 2000,
      agentId: 'NEMESIS',
      agentName: 'NEMESIS (Team Lead)',
    })
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    console.warn(`[ResearchTeam/g1/engine] Council ${round} LLM threw:`, reason)
    return failOpenCouncil(missionId, round, `LLM call threw: ${reason}`)
  }

  if (llm.error) {
    console.warn(`[ResearchTeam/g1/engine] Council ${round} LLM error:`, llm.error)
    return failOpenCouncil(missionId, round, llm.error)
  }

  // Parse JSON verdict
  const parsed = extractJsonFromContent(llm.content)
  const verdict = parseVerdict(parsed?.verdict)
  const transcript =
    (typeof parsed?.transcript === 'string' && parsed.transcript) ||
    llm.content ||
    '(council transcript empty)'
  const conditions = toStringArray(parsed?.conditions)

  const result: CouncilResult = {
    verdict,
    transcript,
    blocking: true, // Council ① ② blocking (TB-13 §3)
    conditions: verdict === 'REVISE' ? conditions : undefined,
  }

  const persisted = await persistTranscript(missionId, round, round, result)
  return { ...result, transcriptId: persisted?.id }
}

/** Build user prompt cho council theo round */
function buildCouncilPrompt(input: CouncilInput): string {
  const { missionId, round, context } = input
  const lines: string[] = [
    `MISSION: ${missionId}`,
    `COUNCIL ROUND: ${round} ${round === 1 ? '(① post-DECOMPOSE)' : '(② pre-code)'}`,
    '',
  ]

  if (round === 1) {
    lines.push('TASK: ' + (context.taskDescription || '(no task description)'))
    lines.push('SUCCESS CRITERIA:')
    if (context.successCriteria && context.successCriteria.length > 0) {
      for (const c of context.successCriteria) {
        lines.push(`- ${c.id}: ${c.criterion} (measure: ${c.measure})`)
      }
    } else {
      lines.push('(empty — should have been VETO at gate TC-13)')
    }
    lines.push('')
    lines.push('Council ①: verify Success Criteria đủ + challenge hypotheses decompose. Verdict PASS/REVISE/VETO.')
  } else {
    // ② pre-code
    lines.push('SYNTHESIS REPORT TỪ SIVIL:')
    lines.push(context.synthesis || '(synthesis trống)')
    if (context.conflicts && context.conflicts.length > 0) {
      lines.push('')
      lines.push(`⚠️ CONFLICT SA (TC-03 — ${context.conflicts.length} SA flagged):`)
      for (const c of context.conflicts.slice(0, 5)) {
        lines.push(`- ${c.id}: ${(c.result || '').slice(0, 120)}`)
      }
    }
    lines.push('')
    lines.push('Council ②: challenge hypotheses synthesis + đối chiếu KB → PASS/REVISE/VETO trước khi BELI code.')
  }

  return lines.join('\n')
}

/** Persist CouncilTranscript row (TB-13 §3 — round/kind/verdict/transcript/blocking) */
async function persistTranscript(
  missionId: string,
  round: number,
  kind: number,
  result: CouncilResult,
): Promise<{ id: string } | null> {
  try {
    const row = await db.councilTranscript.create({
      data: {
        missionId,
        round,
        kind,
        verdict: result.verdict,
        blocking: result.blocking,
        transcript: result.transcript,
      },
    })
    return { id: row.id }
  } catch (err) {
    console.warn(
      '[ResearchTeam/g1/engine] Persist CouncilTranscript failed (non-blocking):',
      err instanceof Error ? err.message : String(err),
    )
    return null
  }
}

/** Fail-open council — LLM error → REVISE + manual review needed */
function failOpenCouncil(missionId: string, round: number, reason: string): CouncilResult {
  const transcript =
    `Council ${round} ${round === 1 ? '①' : '②'} DEFERRED (LLM unavailable):\n` +
    `${reason}\n` +
    `KHÔNG crash — verdict REVISE (cần manual review). Pipeline chặn (blocking=true) cho tới khi user/NEMESIS xác nhận.`
  // Persist trong background — fire-and-forget (caller nhận result đồng bộ)
  const result: CouncilResult = {
    verdict: 'REVISE',
    transcript,
    blocking: true,
    conditions: ['Manual review needed — LLM unavailable', 'Retry council khi NIM keys available'],
  }
  // Persist transcript (best-effort, non-blocking)
  persistTranscript(missionId, round, round, result).catch((err) => {
    console.warn('[ResearchTeam/g1/engine] failOpenCouncil persist failed:', err)
  })
  return result
}

// ============================================================
// §4. RUN G1 ROUND — TC-07 order enforced (① → SYNTHESIZE → ② → SPEC)
// ============================================================

/**
 * Run 1 G1 round với thứ tự TC-07 ENFORCED:
 *   Council ① (post-DECOMPOSE, verify Success Criteria)
 *     → nếu VETO → return escalated=true (KHÔNG chạy SIVIL)
 *   SIVIL SYNTHESIZE (runSivilExplore — DECOMPOSE/DISPATCH/SYNTHESIZE)
 *     → nếu conflicts (TC-03) → return escalated=true (KHÔNG tự giải quyết)
 *   Council ② (pre-code, challenge synthesis)
 *     → nếu VETO → return escalated=true (KHÔNG chạy BELI)
 *     → nếu REVISE → return escalated=true (caller loop lại G1)
 *   BELI SPEC (runBeliSpec — M1 code / M2 report+POC)
 *
 * TB-03 §9.4 Invariant I3: KHÔNG có spec nào đến tay BELI trước khi COUNCIL_DONE.
 * TB-03 §9.4 Invariant I2: BELI KHÔNG tự đổi approach (Instructions §2.2).
 *
 * Persist CouncilTranscript cho ① và ② (runCouncil đã persist).
 * Persist ResearchWorklog row cho round này (caller hoặc hàm này — defer ra
 * runG1Pipeline để gom 1 lần write).
 */
export async function runG1Round(
  missionId: string,
  taskId: string,
  partDescription: string,
  missionType: 'M1' | 'M2' | 'M3',
  round: number,
  successCriteria?: SuccessCriterion[],
): Promise<G1RoundResult> {
  const startedAt = new Date().toISOString()
  const orderLog: string[] = [
    `[${startedAt}] G1 round ${round} START — missionType=${missionType}`,
    'Order enforced (TC-07): ① → SYNTHESIZE → ② → SPEC',
  ]

  // ---------- STEP 1: Council ① (post-DECOMPOSE, gate TC-13) ----------
  const council1 = await runCouncil({
    missionId,
    round: 1,
    context: {
      successCriteria: successCriteria || [],
      taskDescription: partDescription,
    },
  })
  orderLog.push(`① council verdict: ${council1.verdict} (transcriptId=${council1.transcriptId || 'n/a'})`)

  if (council1.verdict === 'VETO') {
    // Gate TC-13 fail → KHÔNG chạy SIVIL → escalate NEMESIS
    const worklog: Partial<WorklogEntry> = {
      mission: missionType,
      status: 'ESCALATED',
      currentPhase: 'G1',
      overallProgress: 5, // council ① chặn sớm → progress thấp
      tlReadBack: 'PIVOT-NEEDED',
      done: [
        `Council ① VETO — Success Criteria thiếu (gate TC-13)`,
        'KHÔNG chạy SIVIL — escalate NEMESIS bổ sung Success Criteria (DR-C3 append-only)',
      ],
      issuesFaced: [council1.transcript],
      suggestionsNextGroup: ['Bổ sung Success Criteria theo TB-07 §3 task .md template'],
      filesChanged: [],
      header: orderLog.join('\n'),
      taskId,
    }
    return {
      synthesis: '',
      spec: '',
      council1,
      council2: {
        verdict: 'VETO',
        transcript: 'Council ② skipped — ① VETO (gate TC-13)',
        blocking: true,
      },
      worklog,
      conflicts: [],
      escalated: true,
      escalateReason: `Council ① VETO (gate TC-13): ${council1.transcript}`,
      artifactMap: emptyArtifactMap(missionId, taskId),
    }
  }

  // ---------- STEP 2: SIVIL SYNTHESIZE (DECOMPOSE/DISPATCH/SYNTHESIZE) ----------
  const sivilResult = await runSivilExplore(missionId, taskId, partDescription, round)
  orderLog.push(`② SIVIL SYNTHESIZE done: ${sivilResult.exploreDirections.length} directions, ${sivilResult.conflicts.length} conflicts`)

  // TC-03 — dual-interpretation escalation (TB-03 §5.3 3B):
  // engine.ts chỉ FLAG; NEMESIS xử lý ở P5 (council ③). KHÔNG tự giải quyết.
  if (sivilResult.conflicts.length > 0) {
    const conflictSummaries = sivilResult.conflictReport.conflictPairs
      .map((p) => p.summary)
      .join('\n')
    const worklog: Partial<WorklogEntry> = {
      mission: missionType,
      status: 'ESCALATED',
      currentPhase: 'G1',
      overallProgress: 40, // SIVIL done ~40% nhưng escalate
      tlReadBack: 'PIVOT-NEEDED',
      done: [
        `SIVIL round ${round}: ${sivilResult.plan.saCount} SA dispatched (${sivilResult.plan.tasks.filter((t) => t.status === 'DONE').length} DONE)`,
        `${sivilResult.conflicts.length} SA flag CONFLICT — KHÔNG tự giải quyết (TB-03 §5.3 3B)`,
      ],
      issuesFaced: [
        `TC-03 dual-interpretation escalation: ${sivilResult.conflicts.length} SA conflict`,
        conflictSummaries,
      ],
      suggestionsNextGroup: [
        'NEMESIS council ③ quyết: 2 interpretation → tách claim điều kiện / đổi approach / hủy task',
        'KHÔNG tiếp tục BELI code với synthesis chưa chốt',
      ],
      filesChanged: sivilResult.worklog.filesChanged || [],
      header: orderLog.join('\n'),
      taskId,
    }
    return {
      synthesis: sivilResult.synthesis,
      spec: '',
      council1,
      council2: {
        verdict: 'VETO',
        transcript: `Council ② skipped — ${sivilResult.conflicts.length} SA conflict (TC-03)`,
        blocking: true,
      },
      worklog,
      conflicts: sivilResult.conflicts,
      escalated: true,
      escalateReason: `TC-03 dual-interpretation escalation: ${sivilResult.conflicts.length} SA conflict — NEMESIS xử lý ở council ③ (P5)`,
      artifactMap: sivilResult.artifactMap,
      sivilResult,
    }
  }

  // ---------- STEP 3: Council ② (pre-code, challenge synthesis) ----------
  const council2 = await runCouncil({
    missionId,
    round: 2,
    context: {
      synthesis: sivilResult.synthesis,
      conflicts: sivilResult.conflicts,
    },
  })
  orderLog.push(`③ council ② verdict: ${council2.verdict}`)

  if (council2.verdict === 'VETO' || council2.verdict === 'REVISE') {
    // Council ② VETO/REVISE → KHÔNG chạy BELI → escalate hoặc loop lại
    const worklog: Partial<WorklogEntry> = {
      mission: missionType,
      status: council2.verdict === 'VETO' ? 'ESCALATED' : 'IN_PROGRESS',
      currentPhase: 'G1',
      overallProgress: 50,
      tlReadBack: council2.verdict === 'VETO' ? 'PIVOT-NEEDED' : 'NEEDS-REVIEW',
      done: [
        `SIVIL SYNTHESIZE: ${sivilResult.exploreDirections.length} directions → synthesis report`,
        `Council ② ${council2.verdict}: ${council2.transcript.slice(0, 200)}`,
      ],
      issuesFaced:
        council2.verdict === 'VETO'
          ? [`Council ② VETO — escalate council ③ (TB-03 §12 Q3: ≥2 vòng veto → ③)`]
          : [`Council ② REVISE — conditions: ${(council2.conditions || []).join('; ')}`],
      suggestionsNextGroup:
        council2.verdict === 'VETO'
          ? ['NEMESIS council ③ quyết: revise approach / hủy task / pivot']
          : [`Loop G1 round ${round + 1} với conditions: ${council2.conditions?.join('; ')}`],
      filesChanged: sivilResult.worklog.filesChanged || [],
      header: orderLog.join('\n'),
      taskId,
    }
    return {
      synthesis: sivilResult.synthesis,
      spec: '',
      council1,
      council2,
      worklog,
      conflicts: [],
      escalated: council2.verdict === 'VETO',
      escalateReason:
        council2.verdict === 'VETO'
          ? `Council ② VETO: ${council2.transcript}`
          : undefined, // REVISE → caller (runG1Pipeline) loop lại
      artifactMap: sivilResult.artifactMap,
      sivilResult,
    }
  }

  // ---------- STEP 4: BELI SPEC (M1 code / M2 report+POC) ----------
  const beliResult = await runBeliSpec(missionId, taskId, sivilResult.synthesis, missionType)
  orderLog.push(`④ BELI SPEC done: spec ${beliResult.spec === '(LLM unavailable — spec deferred)' ? 'DEFERRED' : 'ready'}`)

  // Merge worklog: SIVIL + BELI + order log
  const mergedWorklog = mergeWorklogs(
    sivilResult.worklog,
    beliResult.worklog,
    missionType,
    taskId,
    orderLog,
  )

  return {
    synthesis: sivilResult.synthesis,
    spec: beliResult.spec,
    council1,
    council2,
    worklog: mergedWorklog,
    conflicts: [],
    escalated: beliResult.spec === '(LLM unavailable — spec deferred)',
    escalateReason:
      beliResult.spec === '(LLM unavailable — spec deferred)'
        ? 'BELI spec deferred — LLM unavailable (TB-13 §4 fail-open)'
        : undefined,
    artifactMap: sivilResult.artifactMap,
    beliResult,
    sivilResult,
  }
}

/** Merge SIVIL + BELI worklog → 1 entry cho round (TB-09 §4.2) */
function mergeWorklogs(
  sivil: Partial<WorklogEntry>,
  beli: Partial<WorklogEntry>,
  missionType: 'M1' | 'M2' | 'M3',
  taskId: string,
  orderLog: string[],
): Partial<WorklogEntry> {
  const filesChanged = Array.from(
    new Set([...(sivil.filesChanged || []), ...(beli.filesChanged || [])]),
  )
  return {
    mission: missionType,
    status: beli.status || sivil.status || 'IN_PROGRESS',
    currentPhase: 'G1',
    overallProgress: Math.max(sivil.overallProgress || 0, beli.overallProgress || 0),
    tlReadBack: beli.tlReadBack || sivil.tlReadBack || 'NEEDS-REVIEW',
    done: [...(sivil.done || []), ...(beli.done || [])],
    issuesFaced: [...(sivil.issuesFaced || []), ...(beli.issuesFaced || [])],
    suggestionsNextGroup: [
      ...(sivil.suggestionsNextGroup || []),
      ...(beli.suggestionsNextGroup || []),
    ],
    filesChanged,
    header: orderLog.join('\n'),
    taskId,
  }
}

/** Empty ArtifactMap fallback (khi council ① VETO — SIVIL chưa chạy) */
function emptyArtifactMap(missionId: string, taskId: string): ArtifactMap {
  return {
    missionId,
    taskId,
    entries: [],
    generatedAt: new Date().toISOString(),
    complete: false,
  }
}

// ============================================================
// §5. RUN G1 PIPELINE — full orchestration (TB-03 §4 + §8 feedback loop)
// ============================================================

/** Max REVISE rounds (TB-03 §8 + §12 Q6 — 2 vòng MEDIUM / 3 vòng COMPLEX+) */
const MAX_REVISE_ROUNDS = 3

/**
 * Run full G1 pipeline: loop runG1Round tối đa MAX_REVISE_ROUNDS lần.
 *  - Council ② REVISE → loop lại với conditions.
 *  - Council ① VETO / TC-03 conflict / Council ② VETO → return sớm (escalated).
 *  - PASS → return BELI spec.
 *
 * Persist ResearchWorklog row mỗi round (entryJson=encodeJson(worklog)).
 * Gate E4 TC-14: nếu artifactMap empty → log warning (KHÔNG chặn — gate
 * thực sự chặn ở NEMESIS MONITOR P5).
 */
export async function runG1Pipeline(
  missionId: string,
  taskId: string,
  partDescription: string,
  missionType: 'M1' | 'M2' | 'M3',
  successCriteria?: SuccessCriterion[],
): Promise<G1RoundResult> {
  let lastResult: G1RoundResult | null = null

  for (let round = 1; round <= MAX_REVISE_ROUNDS; round++) {
    const result = await runG1Round(
      missionId,
      taskId,
      partDescription,
      missionType,
      round,
      successCriteria,
    )

    // Persist ResearchWorklog row (TB-13 §3 — entryJson=encodeJson(worklog))
    await persistWorklog(missionId, taskId, round, result.worklog, result.artifactMap)

    lastResult = result

    // Escalated (VETO/TC-03/conflict) → return sớm (KHÔNG loop)
    if (result.escalated) {
      console.log(
        `[ResearchTeam/g1/engine] G1 pipeline round ${round} ESCALATED: ${result.escalateReason || '(unknown)'}`,
      )
      return result
    }

    // Council ② REVISE → loop lại với conditions (TB-03 §8 feedback loop)
    if (result.council2.verdict === 'REVISE') {
      console.log(
        `[ResearchTeam/g1/engine] G1 round ${round} REVISE — loop ${round + 1}/${MAX_REVISE_ROUNDS}`,
      )
      continue
    }

    // PASS → BELI spec ready
    console.log(
      `[ResearchTeam/g1/engine] G1 pipeline round ${round} PASS — BELI spec ready`,
    )
    return result
  }

  // Exhausted rounds → return last result with escalate (council ② still REVISE)
  if (lastResult) {
    return {
      ...lastResult,
      escalated: true,
      escalateReason: `G1 pipeline exhausted ${MAX_REVISE_ROUNDS} REVISE rounds — escalate council ③ (TB-03 §12 Q6)`,
    }
  }

  // Fallback (shouldn't reach here)
  return {
    synthesis: '',
    spec: '',
    council1: { verdict: 'VETO', transcript: 'G1 pipeline failed to start', blocking: true },
    council2: { verdict: 'VETO', transcript: 'G1 pipeline failed to start', blocking: true },
    worklog: { mission: missionType, status: 'BLOCKED', currentPhase: 'G1', overallProgress: 0, tlReadBack: 'NEEDS-REVIEW', done: [], issuesFaced: ['G1 pipeline failed'], suggestionsNextGroup: [], filesChanged: [], taskId },
    conflicts: [],
    escalated: true,
    escalateReason: 'G1 pipeline failed to start (should not reach here)',
    artifactMap: emptyArtifactMap(missionId, taskId),
  }
}

/** Persist ResearchWorklog row (TB-13 §3) */
async function persistWorklog(
  missionId: string,
  taskId: string,
  round: number,
  worklog: Partial<WorklogEntry>,
  artifactMap: ArtifactMap,
): Promise<void> {
  try {
    // Validate artifact map (gate E4 TC-14 — log warning, KHÔNG chặn ở P2;
    // gate thực sự chặn ở NEMESIS MONITOR P5)
    const validation = validateArtifactMap(artifactMap)
    if (!validation.valid) {
      console.warn(
        `[ResearchTeam/g1/engine] Gate E4 TC-14 WARNING (round ${round}): ${validation.reason}`,
      )
    }

    await db.researchWorklog.create({
      data: {
        taskId,
        missionId,
        phase: 'RESEARCH', // TB-09 §4.2 phase — G1 = RESEARCH phase
        entryJson: encodeJson(worklog),
        artifactMapJson: encodeJson(artifactMap),
      },
    })
  } catch (err) {
    console.warn(
      '[ResearchTeam/g1/engine] Persist ResearchWorklog failed (non-blocking):',
      err instanceof Error ? err.message : String(err),
    )
  }
}

// ============================================================
// §6. HELPERS — JSON parse + verdict parse
// ============================================================

function extractJsonFromContent(content: string): Record<string, unknown> | null {
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

function parseVerdict(v: unknown): CouncilVerdict {
  if (typeof v !== 'string') return 'REVISE' // default safe
  const upper = v.toUpperCase().trim()
  if (upper === 'PASS') return 'PASS'
  if (upper === 'VETO') return 'VETO'
  return 'REVISE' // mọi giá trị lạ → REVISE (safe — loop lại)
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
}

// ============================================================
// §7. RE-EXPORTS — convenience for callers (P5 NEMESIS engine)
// ============================================================

export { COUNCIL_ROUNDS } from '../types'
export type { SuccessCriterion, WorklogEntry } from '../types'
