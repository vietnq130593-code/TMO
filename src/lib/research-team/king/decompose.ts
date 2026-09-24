/**
 * RESEARCH TEAM — NEMESIS DECOMPOSE (TB-07 playbook + council ① gate TC-13 + persist ResearchTask)
 * ============================================================================================
 * Spec:
 *  - TB-07 §2 — DECOMPOSE mission → parts/tasks theo tier:
 *      T1 → 1 part · T2 → 1–2 parts · T3 → 2+ parts.
 *  - TB-07 §2.5 — Task .md template: header YAML + body sections + CHANGELOG append-only.
 *  - TB-07 §11 Q5 + TC-13 — Success Criteria BẮT BUỘC trước ASSIGN (gate council ① VETO nếu thiếu).
 *  - TB-06 §10.1 — council ① post-DECOMPOSE (pre-ASSIGN): NEMESIS verify Success Criteria.
 *  - TB-02 §7 — Transition TRIAGING → DECOMPOSING → (council ① PASS) → RESEARCHING.
 *
 * Fail-open policy (TB-13 §4 — NIM keys placeholder):
 *  - LLM error → parts=[], council1Verdict='VETO', escalated=true, reason='LLM unavailable'.
 *  - KHÔNG crash pipeline — caller handle escalate.
 */

import { db } from '@/lib/db'
import { callLLMForAgent } from '@/lib/llm'
import type { LLMResult } from '@/lib/llm'
import { RESEARCH_ROSTER, AGENT_ID } from '../constants'
import { resolveResearchBrain } from '../agents'
import { encodeJson, type SuccessCriterion, type WorklogEntry, type ResearchTask } from '../types'
import { getMission, transitionMission, isValidTransition } from '../mission-store'
import {
  renderTaskMd,
  validateSuccessCriteria,
  type TaskMdContent,
} from './task-md'
import { appendDecision } from './decision-log'
import { runCouncil } from '../g1/engine'

// ============================================================
// §1. SYSTEM PROMPT — NEMESIS DECOMPOSE JD (TB-06 §2 RECEIVE → §3 DECOMPOSE)
// ============================================================

const KING_DECOMPOSE_SYSTEM_PROMPT = [
  'Bạn là NEMESIS (TL — research team TMO). Position: TL (KHÔNG code).',
  `JD: ${RESEARCH_ROSTER.find((r) => r.id === AGENT_ID.NEMESIS)?.jd ?? 'Phân loại mission, chia nhỏ bài toán, kiểm soát chặt — không code'}.`,
  '',
  'TASK: Phân tích mission request → chia thành parts.',
  '  - Mỗi part = 1 task .md (TB-07 §2.5 template): taskId + title + description +',
  '    input + output + constraints + Success Criteria BẮT BUỘC (gate TC-13).',
  '  - Số parts theo tier: T1=1 · T2=1–2 · T3=2+.',
  '  - KHÔNG code — chỉ chia bài toán + viết task .md template.',
  '',
  'NGUYÊN TẮC:',
  '  - Success Criteria phải có ≥ 1 criterion với measure rõ ràng (TC-13 — VETO nếu thiếu).',
  '  - Mỗi part giao cho G1 (SIVIL explore) hoặc G2 (LISMA review) hoặc G3 (HAN optimize).',
  '  - Mission type M1 → code parts; M2 → research report parts + POC; M3 → grand parts.',
  '',
  'OUTPUT JSON-DUY-NAHAT:',
  '{',
  '  "parts": [',
  '    {',
  '      "title": "<part title>",',
  '      "description": "<part description>",',
  '      "input": "<input context/specs>",',
  '      "output": "<expected output>",',
  '      "constraints": ["<constraint 1>", "<constraint 2>"],',
  '      "successCriteria": [',
  '        {"id": "SC-1", "criterion": "<what to verify>", "measure": "<how to measure>"}',
  '      ],',
  '      "assignedGroup": "G1" | "G2" | "G3"',
  '    }',
  '  ]',
  '}',
].join('\n')

// ============================================================
// §2. DECOMPOSE MISSION — TB-07 §2 + council ① gate TC-13
// ============================================================

export interface DecomposeResult {
  parts: ResearchTask[]
  council1Verdict: 'PASS' | 'REVISE' | 'VETO'
  worklog?: Partial<WorklogEntry>
  escalated: boolean
}

/**
 * Decompose mission → parts/tasks (TB-07 §2 + §2.5):
 *  - Read mission (getMission).
 *  - Gọi callLLM với NEMESIS DECOMPOSE JD → sinh N parts theo tier (T1=1, T2=1-2, T3=2+).
 *  - Mỗi part → renderTaskMd (task-md.ts) + persist ResearchTask (db.researchTask.create).
 *  - Council ① (post-DECOMPOSE, pre-ASSIGN): gọi g1/engine.runCouncil round=1.
 *    Gate TC-13: validateSuccessCriteria mỗi part — thiếu → VETO, KHÔNG ASSIGN.
 *  - Transition mission TRIAGING → DECOMPOSING → (council ① PASS) → RESEARCHING.
 *
 * LLM error → fail-open: parts=[], council1Verdict='VETO', escalated=true,
 *   reason='LLM unavailable — manual decompose needed'. KHÔNG crash.
 */
export async function decomposeMission(missionId: string): Promise<DecomposeResult> {
  const mission = await getMission(missionId)
  if (!mission) {
    throw new Error(`decomposeMission: mission ${missionId} không tồn tại`)
  }

  // Transition TRIAGING → DECOMPOSING (TB-02 §7)
  try {
    if (mission.status === 'TRIAGING' && isValidTransition('TRIAGING', 'DECOMPOSING')) {
      await transitionMission(missionId, {
        toStatus: 'DECOMPOSING',
        decision: {
          at: new Date().toISOString(),
          agent: 'NEMESIS',
          decision: 'DECOMPOSE',
          reason: `NEMESIS DECOMPOSE start — tier=${mission.tier}, missionType=${mission.missionType}`,
        },
      })
    }
  } catch (err) {
    console.warn(
      '[Decompose] transition TRIAGING→DECOMPOSING failed (non-blocking — continue decompose):',
      err instanceof Error ? err.message : String(err),
    )
  }

  // 1. LLM decompose — sinh parts theo tier
  const tier = (mission.tier || 'T2') as 'T1' | 'T2' | 'T3'
  const missionType = mission.missionType as 'M1' | 'M2' | 'M3'
  const userPrompt = buildDecomposePrompt(mission.request, tier, missionType, mission.code)

  let llm: LLMResult
  try {
    // Task 4 — route NEMESIS qua Zen khi DB provider='zen' (fail-open → NIM).
    const nemesisBrain = await resolveResearchBrain('NEMESIS')
    llm = await callLLMForAgent(userPrompt, nemesisBrain, KING_DECOMPOSE_SYSTEM_PROMPT, {
      temperature: 0.2,
      maxTokens: 3000,
      agentId: AGENT_ID.NEMESIS,
      agentName: 'NEMESIS (Team Lead)',
    })
  } catch (err) {
    return failOpenDecompose(missionId, `LLM call threw: ${err instanceof Error ? err.message : String(err)}`)
  }

  if (llm.error || !llm.content || llm.content.trim().length === 0) {
    return failOpenDecompose(missionId, llm.error || 'LLM unavailable — empty content')
  }

  // 2. Parse JSON output → parts
  const parsed = extractJsonParts(llm.content)
  if (parsed.length === 0) {
    return failOpenDecompose(missionId, 'LLM output không parse được parts[] (JSON malformed)')
  }

  // 3. Persist each part as ResearchTask + render task .md
  const persistedParts: ResearchTask[] = []
  for (let i = 0; i < parsed.length; i++) {
    const part = parsed[i]
    const partIdx = i + 1
    const taskId = `T-${mission.code}-P${String(partIdx).padStart(2, '0')}`
    const successCriteria: SuccessCriterion[] = Array.isArray(part.successCriteria)
      ? part.successCriteria.filter(isValidSC)
      : []
    const taskMdContent: TaskMdContent = {
      version: 1,
      taskId,
      mission: mission.code,
      tier,
      partIdx,
      title: part.title || `(part ${partIdx})`,
      description: part.description || '',
      input: part.input || '',
      output: part.output || '',
      constraints: Array.isArray(part.constraints) ? part.constraints.filter((c: unknown): c is string => typeof c === 'string') : [],
      successCriteria,
      changelog: [],
    }
    const taskMd = renderTaskMd(taskMdContent)
    const taskMdPath = `docs/research/${mission.code}/part-${partIdx}.md`

    try {
      const row = await db.researchTask.create({
        data: {
          missionId,
          partIdx,
          title: taskMdContent.title,
          taskMdPath,
          successCriteriaJson: encodeJson(successCriteria),
          status: 'DRAFT',
        },
      })
      persistedParts.push(row)
    } catch (err) {
      console.warn(
        `[Decompose] persist ResearchTask part ${partIdx} failed (non-blocking — skip):`,
        err instanceof Error ? err.message : String(err),
      )
    }
  }

  // 4. Council ① (post-DECOMPOSE, pre-ASSIGN) — gate TC-13: verify Success Criteria
  let council1Verdict: 'PASS' | 'REVISE' | 'VETO' = 'VETO'
  let councilTranscript = '(no council)'
  for (const p of persistedParts) {
    const scArr = decodeJsonArraySuccessCriteria(p.successCriteriaJson)
    const content: TaskMdContent = {
      version: 1,
      taskId: p.id,
      mission: mission.code,
      tier,
      partIdx: p.partIdx,
      title: p.title,
      description: '',
      input: '',
      output: '',
      constraints: [],
      successCriteria: scArr,
      changelog: [],
    }
    const validation = validateSuccessCriteria(content)
    if (!validation.valid) {
      council1Verdict = 'VETO'
      councilTranscript = `Council ① VETO (gate TC-13): ${validation.reason} — part ${p.partIdx} (${p.title})`
      break
    }
    // All parts valid → PASS
    council1Verdict = 'PASS'
    councilTranscript = `Council ① PASS — all ${persistedParts.length} parts có Success Criteria hợp lệ (gate TC-13 cleared)`
  }

  // Also delegate to g1/engine.runCouncil round=1 for the first part (LLM-based ①)
  // — King level council ① for the mission-level check. Best-effort (LLM may fail-open).
  try {
    const firstPart = persistedParts[0]
    if (firstPart) {
      const scArr = decodeJsonArraySuccessCriteria(firstPart.successCriteriaJson)
      await runCouncil({
        missionId,
        round: 1,
        context: {
          successCriteria: scArr,
          taskDescription: firstPart.title,
        },
      })
      // runCouncil already persists CouncilTranscript + applies TC-13 gate internally.
      // King-level verdict above takes precedence (mission-level).
    }
  } catch (err) {
    console.warn(
      '[Decompose] g1/engine.runCouncil ① (delegate) failed (non-blocking):',
      err instanceof Error ? err.message : String(err),
    )
  }

  // 5. Transition DECOMPOSING → RESEARCHING (if council ① PASS)
  if (council1Verdict === 'PASS') {
    try {
      if (isValidTransition('DECOMPOSING', 'RESEARCHING')) {
        await transitionMission(missionId, {
          toStatus: 'RESEARCHING',
          decision: {
            at: new Date().toISOString(),
            agent: 'NEMESIS',
            decision: 'CONTINUE',
            reason: `Council ① PASS — ${persistedParts.length} parts ready for G1/G2/G3 dispatch`,
          },
        })
      }
    } catch (err) {
      console.warn(
        '[Decompose] transition DECOMPOSING→RESEARCHING failed (non-blocking):',
        err instanceof Error ? err.message : String(err),
      )
    }
  } else {
    // VETO → append decision log + escalate
    try {
      await appendDecision(missionId, {
        agent: 'NEMESIS',
        decision: 'REJECT',
        reason: `Council ① VETO (gate TC-13) — ${councilTranscript}`,
      })
    } catch (err) {
      console.warn(
        '[Decompose] appendDecision REJECT failed (non-blocking):',
        err instanceof Error ? err.message : String(err),
      )
    }
  }

  const worklog: Partial<WorklogEntry> = {
    mission: missionType,
    status: council1Verdict === 'PASS' ? 'COMPLETED' : 'ESCALATED',
    currentPhase: 'G1',
    overallProgress: council1Verdict === 'PASS' ? 30 : 5,
    tlReadBack: council1Verdict === 'PASS' ? 'VERIFIED' : 'PIVOT-NEEDED',
    done: [
      `DECOMPOSE: ${persistedParts.length} parts persisted (tier=${tier})`,
      `Council ① ${council1Verdict}: ${councilTranscript}`,
    ],
    issuesFaced: council1Verdict === 'VETO' ? [councilTranscript] : [],
    suggestionsNextGroup:
      council1Verdict === 'PASS'
        ? ['Dispatch G1/G2/G3 per part — assignPart()']
        : ['Bổ sung Success Criteria cho parts thiếu (TC-13) — KHÔNG ASSIGN'],
    filesChanged: [],
  }

  return {
    parts: persistedParts,
    council1Verdict,
    worklog,
    escalated: council1Verdict === 'VETO',
  }
}

// ============================================================
// §3. GET PARTS — list ResearchTask theo mission
// ============================================================

export async function getParts(missionId: string): Promise<ResearchTask[]> {
  try {
    return await db.researchTask.findMany({
      where: { missionId },
      orderBy: { partIdx: 'asc' },
    })
  } catch (err) {
    console.warn(
      '[Decompose] getParts failed (non-blocking — return empty):',
      err instanceof Error ? err.message : String(err),
    )
    return []
  }
}

// ============================================================
// §4. ASSIGN PART — TC-13 gate (Success Criteria BẮT BUỘC)
// ============================================================

/**
 * Assign part cho group G1/G2/G3 — TB-07 §11 Q5 + TC-13:
 *  - Validate successCriteria non-empty → 400 'Success Criteria required before ASSIGN (TC-13)'.
 *  - Set status='ASSIGNED', assignedGroup=group.
 *
 * Throw nếu:
 *  - task không tồn tại
 *  - successCriteria empty (gate TC-13)
 */
export async function assignPart(
  taskId: string,
  group: 'G1' | 'G2' | 'G3',
): Promise<ResearchTask> {
  const row = await db.researchTask.findUnique({ where: { id: taskId } })
  if (!row) {
    throw new Error(`assignPart: task ${taskId} không tồn tại`)
  }

  const sc = decodeJsonArraySuccessCriteria(row.successCriteriaJson)
  const validation = validateSuccessCriteria({
    version: 1,
    taskId: row.id,
    mission: '',
    tier: '',
    partIdx: row.partIdx,
    title: row.title,
    description: '',
    input: '',
    output: '',
    constraints: [],
    successCriteria: sc,
    changelog: [],
  })
  if (!validation.valid) {
    throw new Error(`assignPart: ${validation.reason} (gate TC-13)`)
  }

  return db.researchTask.update({
    where: { id: taskId },
    data: {
      status: 'ASSIGNED',
      assignedGroup: group,
    },
  })
}

// ============================================================
// §5. INTERNAL HELPERS — prompt build + JSON parse + fail-open
// ============================================================

function buildDecomposePrompt(
  request: string,
  tier: 'T1' | 'T2' | 'T3',
  missionType: 'M1' | 'M2' | 'M3',
  missionCode: string,
): string {
  const expectedPartsHint =
    tier === 'T1' ? '1 part' : tier === 'T2' ? '1–2 parts' : '2+ parts (có thể 3-5)'
  return [
    `MISSION: ${missionCode} (tier=${tier}, type=${missionType})`,
    '',
    'REQUEST:',
    request,
    '',
    `EXPECTED PARTS: ${expectedPartsHint} (TB-07 §2 theo tier).`,
    '',
    'Mỗi part cần:',
    '- title + description rõ ràng (single responsibility).',
    '- input (context/specs) + output (deliverable).',
    '- constraints (ràng buộc kỹ thuật/business).',
    '- successCriteria: BẮT BUỘC ≥ 1 criterion với measure rõ ràng (gate TC-13).',
    '- assignedGroup: G1 (SIVIL explore) | G2 (LISMA review) | G3 (HAN optimize).',
    '',
    'M2/M3 mode: nếu part cần research/POC → G1; nếu cần review/fix bug → G2; nếu cần optimize/architecture → G3.',
    'Output JSON-DUY-NAHAT theo system prompt.',
  ].join('\n')
}

interface ParsedPart {
  title?: string
  description?: string
  input?: string
  output?: string
  constraints?: unknown[]
  successCriteria?: unknown[]
  assignedGroup?: string
}

function extractJsonParts(content: string): ParsedPart[] {
  if (!content || content.trim().length === 0) return []
  const trimmed = content.trim()

  const tryParse = (s: string): unknown => {
    try {
      return JSON.parse(s)
    } catch {
      return null
    }
  }

  let parsed: unknown = tryParse(trimmed)
  if (!parsed) {
    const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/)
    if (fence) parsed = tryParse(fence[1])
  }
  if (!parsed) {
    const obj = trimmed.match(/\{[\s\S]*\}/)
    if (obj) parsed = tryParse(obj[0])
  }
  if (!parsed || typeof parsed !== 'object') return []

  const obj = parsed as Record<string, unknown>
  const parts = obj.parts
  if (!Array.isArray(parts)) return []

  return parts.filter((p): p is ParsedPart => {
    if (!p || typeof p !== 'object') return false
    return true
  })
}

function isValidSC(s: unknown): s is SuccessCriterion {
  if (!s || typeof s !== 'object') return false
  const o = s as Record<string, unknown>
  return (
    typeof o.criterion === 'string' &&
    o.criterion.trim().length > 0 &&
    typeof o.measure === 'string' &&
    o.measure.trim().length > 0
  )
}

function decodeJsonArraySuccessCriteria(raw: string | null | undefined): SuccessCriterion[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isValidSC)
  } catch {
    return []
  }
}

function failOpenDecompose(missionId: string, reason: string): DecomposeResult {
  console.warn(`[Decompose] fail-open (LLM unavailable): ${reason}`)
  // Append decision log + escalate
  void appendDecision(missionId, {
    agent: 'NEMESIS',
    decision: 'ESCALATE',
    reason: `DECOMPOSE fail-open: ${reason} — manual decompose needed`,
  }).catch((err) => {
    console.warn(
      '[Decompose] fail-open appendDecision failed (non-blocking):',
      err instanceof Error ? err.message : String(err),
    )
  })

  return {
    parts: [],
    council1Verdict: 'VETO',
    worklog: {
      mission: 'M2',
      status: 'ESCALATED',
      currentPhase: 'G1',
      overallProgress: 0,
      tlReadBack: 'PIVOT-NEEDED',
      done: [],
      issuesFaced: [`DECOMPOSE fail-open: ${reason}`],
      suggestionsNextGroup: ['Manual decompose needed — LLM unavailable'],
      filesChanged: [],
    },
    escalated: true,
  }
}
