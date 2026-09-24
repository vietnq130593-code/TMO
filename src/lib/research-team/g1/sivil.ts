/**
 * RESEARCH TEAM — G1 SIVIL ENGINE (TB-03 §1 JD + §4 workflow + §6 Module Map M2)
 * ==================================================================================
 * Spec:
 *  - TB-03 §1.1 JD SIVIL — "Biến 1 task thành N hướng explore song song (5–300)".
 *  - TB-03 §4.1 DECOMPOSE  — task → N sub-problems → SA specs.
 *  - TB-03 §4.2 DISPATCH  — Parallel/Hybrid → spawn SAs theo batches (≤25/round).
 *  - TB-03 §4.3 SYNTHESIZE — rank top-K + K specs cho BELI.
 *  - TB-03 §5.3 conflict  — detectConflicts → flag (engine.ts ESCALATE).
 *  - TB-03 §6   Module Map M2 — decompose theo module thay vì approach.
 *
 * Output contract (TB-03 §7.2):
 *  - synthesis report (markdown)
 *  - worklog Partial<WorklogEntry> — 8 trường schema TB-09 §4.2
 *  - conflicts: SubAgent[] (TC-03 — flag, KHÔNG tự giải quyết)
 *  - artifactMap: pointer — nội dung map do artifact-map.ts build (TB-10)
 *
 * Fail-open policy (TB-13 §4 — NIM keys placeholder):
 *  - LLM error trong DECOMPOSE/DISPATCH/SYNTHESIZE → synthesis='(LLM unavailable)',
 *    worklog.issuesFaced.push('LLM unavailable — SA dispatch skipped'), KHÔNG throw.
 *  - SA dispatch đã handle fail-open trong sub-agents.ts (status FAILED).
 */

import { callLLMForAgent } from '@/lib/llm'
import type { LLMResult } from '@/lib/llm'
import { RESEARCH_ROSTER, AGENT_ID } from '../constants'
import { resolveResearchBrain } from '../agents'
import type { WorklogEntry } from '../types'
import { buildArtifactMap, type ArtifactMap } from './artifact-map'
import {
  planSubAgents,
  dispatchPlan,
  detectConflicts,
  type SubAgent,
  type DispatchPlan,
  type ConflictDetectionResult,
} from './sub-agents'

// ============================================================
// §1. TYPES — SIVIL explore result
// ============================================================

export interface SivilExploreResult {
  /** Synthesis report (TB-03 §4.3 — rank top-K + lý do loại) */
  synthesis: string
  /** Worklog entry (8 trường TB-09 §4.2) — caller persist qua db.researchWorklog */
  worklog: Partial<WorklogEntry>
  /** SA có status CONFLICT (TC-03 — engine.ts sẽ ESCALATE) */
  conflicts: SubAgent[]
  /** Conflict detection chi tiết (summary cho worklog) */
  conflictReport: ConflictDetectionResult
  /** Plan đã dispatch (registry SA-NN → status/result) */
  plan: DispatchPlan
  /** Artifact Map (TB-10 §3 — 1 map G1 duy nhất) */
  artifactMap: ArtifactMap
  /** N directions explore sinh ra ở DECOMPOSE */
  exploreDirections: string[]
}

// ============================================================
// §2. SYSTEM PROMPT — SIVIL JD (TB-03 §1.1 — 7 trách nhiệm)
// ============================================================

const SIVIL_DECOMPOSE_SYSTEM_PROMPT = [
  'Bạn là SIVIL (G1 Sub-Orchestrator — research team TMO).',
  `JD: ${RESEARCH_ROSTER.find((r) => r.id === AGENT_ID.SIVIL)?.jd ?? 'Biến 1 task thành N hướng explore song song'}.`,
  '',
  'NHIỆM VỤ BƯỚC NÀY — DECOMPOSE (TB-03 §4.1):',
  '- Phân tích task → chia thành N hướng explore ĐỘC LẬP (mỗi hướng = 1 SA spec).',
  '- M1: decompose theo APPROACH (mỗi SA thử 1 approach/khía cạnh).',
  '- M2: decompose theo MODULE MAP (mỗi SA đọc 1 module/lớp hệ thống).',
  '',
  'NGUYÊN TẮC (TB-03 §5.1 + §5.4):',
  '- Số SA đúng theo loại task — KHÔNG dùng max cho mọi task (5–10 cho EDA/audit hẹp, 15–50 cho complex).',
  '- Mỗi hướng PHẢI phân biệt được — không spawn "cho đủ số".',
  '- Cap 20 SA/part, 25/vòng G1 (TB-01 §2 Q1).',
  '',
  'OUTPUT JSON ONLY:',
  '{',
  '  "directions": [',
  '    "hướng 1 (1 câu mô tả phạm vi + công cụ SA cần)",',
  '    "hướng 2 ..."',
  '  ],',
  '  "rationale": "lý do chọn N + trục decompose"',
  '}',
].join('\n')

const SIVIL_SYNTHESIZE_SYSTEM_PROMPT = [
  'Bạn là SIVIL (G1 Sub-Orchestrator).',
  `JD: ${RESEARCH_ROSTER.find((r) => r.id === AGENT_ID.SIVIL)?.jd ?? ''}.`,
  '',
  'NHIỆM VỤ BƯỚC NÀY — SYNTHESIZE (TB-03 §4.3):',
  '- Tổng hợp N kết quả sub-agent → top-K approaches có rank (K = 3–5).',
  '- Loại approaches yếu/trùng lặp/overfit (kèm lý do).',
  '- Mọi claim BẮT BUỘC kèm evidence/metric (TB-04 §5 — không evidence = bị loại).',
  '- KHÔNG quyết "ai win" khi thiếu data (Instructions SIVIL).',
  '',
  'OUTPUT — markdown synthesis report:',
  '## Synthesis Report',
  '### Top-K Approaches (rank theo priority)',
  '1. **Approach X** — evidence: ... · metric: ...',
  '2. ...',
  '### Approaches đã loại',
  '- Approach Y — lý do: trùng lặp / overfit / yếu',
  '### Specs cho BELI (draft — council ② sẽ xác nhận)',
  '- SPEC 1: ...',
  '- SPEC 2: ...',
  '### Notes cho LISMA (G2)',
  '- Issue/edge case phát hiện trong SA',
].join('\n')

// ============================================================
// §3. RUN SIVIL EXPLORE — full DECOMPOSE → DISPATCH → SYNTHESIZE
// ============================================================

/**
 * Run SIVIL explore round (TB-03 §4.1→§4.3):
 *  1. DECOMPOSE  — callLLM sinh N explore directions (N ≤ 20).
 *  2. DISPATCH   — planSubAgents + dispatchPlan (parallel waves).
 *  3. CONFLICT   — detectConflicts (TB-03 §5.3) → flag cho engine.ts ESCALATE.
 *  4. SYNTHESIZE — callLLM tổng hợp SA results → synthesis report.
 *  5. Worklog + ArtifactMap.
 *
 * Council ① (post-DECOMPOSE) và council ② (pre-code) KHÔNG nằm đây — engine.ts
 * lo thứ tự (TC-07: ① → SYNTHESIZE → ② → SPEC). File này chỉ làm DECOMPOSE→
 * DISPATCH→SYNTHESIZE + flag conflict.
 */
export async function runSivilExplore(
  missionId: string,
  taskId: string,
  partDescription: string,
  round: number,
): Promise<SivilExploreResult> {
  const startedAt = new Date().toISOString()
  const issues: string[] = []

  // ---------- 1. DECOMPOSE: sinh N explore directions ----------
  const decomposeResult = await callSivilDecompose(partDescription, round)
  let exploreDirections = decomposeResult.directions
  if (exploreDirections.length === 0) {
    // LLM fail-open → 1 hướng fallback (không spawn trống)
    exploreDirections = [`Khảo sát tổng quan: ${partDescription.slice(0, 120)}`]
    issues.push('LLM unavailable — DECOMPOSE sinh 1 hướng fallback thay vì N')
  }

  // ---------- 2. DISPATCH: planSubAgents + dispatchPlan ----------
  const plan = planSubAgents(taskId, exploreDirections, round)
  const dispatchedPlan = await dispatchPlan(plan)

  // ---------- 3. CONFLICT detection (TC-03 gate) ----------
  const conflictReport = detectConflicts(dispatchedPlan.tasks)
  const conflicts = dispatchedPlan.tasks.filter((s) => s.status === 'CONFLICT')
  if (conflictReport.hasConflict) {
    issues.push(
      `${conflictReport.conflictPairs.length} conflict pair(s) detected — TC-03 dual-interpretation (TB-03 §5.3)`,
    )
  }

  // ---------- 4. SYNTHESIZE: callLLM tổng hợp SA results ----------
  const saResultsText = formatSAResultsForSynthesis(dispatchedPlan.tasks)
  const synthesisResult = await callSivilSynthesize(partDescription, saResultsText, round)
  const synthesis = synthesisResult.synthesis
  if (synthesisResult.error) {
    issues.push(`LLM unavailable — SYNTHESIZE deferred: ${synthesisResult.error}`)
  }

  // ---------- 5. WORKLOG entry (8 trường TB-09 §4.2) ----------
  const doneCount = dispatchedPlan.tasks.filter((s) => s.status === 'DONE').length
  const failedCount = dispatchedPlan.tasks.filter((s) => s.status === 'FAILED').length
  const filesChanged = collectFilesChanged(dispatchedPlan.tasks)

  const worklog: Partial<WorklogEntry> = {
    mission: 'M2', // default — engine.ts có thể override theo missionType
    status: conflicts.length > 0 ? 'ESCALATED' : failedCount === dispatchedPlan.saCount ? 'BLOCKED' : 'IN_PROGRESS',
    currentPhase: 'G1',
    overallProgress: clampProgress(Math.round((doneCount / Math.max(dispatchedPlan.saCount, 1)) * 60)), // G1 ~60% of pipeline
    tlReadBack: conflicts.length > 0 ? 'PIVOT-NEEDED' : 'NEEDS-REVIEW', // NEMESIS review sau council ②
    done: [
      `SIVIL round ${round}: DECOMPOSE ${exploreDirections.length} directions → DISPATCH ${dispatchedPlan.saCount} SA (${doneCount} DONE, ${failedCount} FAILED)`,
      `SYNTHESIZE: ${synthesisResult.error ? '(deferred — LLM unavailable)' : 'top-K synthesis report ready'}`,
      ...(conflictReport.hasConflict
        ? [`${conflicts.length} SA flag CONFLICT — engine.ts sẽ ESCALATE`]
        : []),
    ],
    issuesFaced: issues,
    suggestionsNextGroup: [
      'Council ② phải xác nhận specs trước khi BELI code (TC-07 order)',
      conflicts.length > 0
        ? 'KHÔNG tự giải quyết conflict — đẩy NEMESIS qua council ③ (TB-03 §5.3 3B)'
        : 'Specs draft sẵn sàng cho BELI sau council ②',
    ],
    filesChanged,
    header: `[${startedAt}] — G1/SIVIL — Task ${taskId} — Round ${round}`,
    taskId,
  }

  // ---------- 6. ARTIFACT MAP (TB-10 §3 — 1 map G1 duy nhất) ----------
  const artifactMap = buildArtifactMap(missionId, taskId, synthesis, filesChanged)

  return {
    synthesis,
    worklog,
    conflicts,
    conflictReport,
    plan: dispatchedPlan,
    artifactMap,
    exploreDirections,
  }
}

// ============================================================
// §4. HELPERS — LLM calls
// ============================================================

interface DecomposeLLMResult {
  directions: string[]
  rationale: string
  error?: string
}

/** Call LLM để decompose task → N explore directions (TB-03 §4.1) */
async function callSivilDecompose(
  partDescription: string,
  round: number,
): Promise<DecomposeLLMResult> {
  const userPrompt = [
    `TASK: ${partDescription}`,
    `ROUND: ${round}`,
    '',
    'Decompose task thành N hướng explore độc lập (5–15 SA typical, ≤ 20 cap).',
    'Mỗi hướng = 1 câu mô tả phạm vi + công cụ SA cần (code exec / file read / web).',
  ].join('\n')

  let llm: LLMResult
  try {
    // Task 4 — route SIVIL qua Zen khi DB provider='zen' (fail-open → NIM).
    const sivilBrain = await resolveResearchBrain('SIVIL')
    llm = await callLLMForAgent(userPrompt, sivilBrain, SIVIL_DECOMPOSE_SYSTEM_PROMPT, {
      temperature: 0.3,
      maxTokens: 1500,
      agentId: 'SIVIL',
      agentName: 'SIVIL (Sub-Orchestrator)',
    })
  } catch (err) {
    return {
      directions: [],
      rationale: '',
      error: err instanceof Error ? err.message : String(err),
    }
  }

  if (llm.error) {
    return { directions: [], rationale: '', error: llm.error }
  }

  // Parse JSON (LLM có thể bọc markdown fence)
  const parsed = extractJsonFromContent(llm.content)
  if (!parsed) {
    return {
      directions: [],
      rationale: '',
      error: 'JSON parse failed — LLM output không hợp lệ',
    }
  }

  const directions = toStringArray(parsed.directions)
  const rationale = typeof parsed.rationale === 'string' ? parsed.rationale : ''

  return { directions, rationale }
}

interface SynthesizeLLMResult {
  synthesis: string
  error?: string
}

/** Call LLM tổng hợp SA results → synthesis report (TB-03 §4.3) */
async function callSivilSynthesize(
  partDescription: string,
  saResultsText: string,
  round: number,
): Promise<SynthesizeLLMResult> {
  const userPrompt = [
    `TASK: ${partDescription}`,
    `ROUND: ${round}`,
    '',
    'SUB-AGENT RESULTS:',
    saResultsText,
    '',
    'Tổng hợp → top-K approaches + specs cho BELI (markdown report).',
  ].join('\n')

  let llm: LLMResult
  try {
    // Task 4 — route SIVIL qua Zen khi DB provider='zen' (fail-open → NIM).
    const sivilBrain = await resolveResearchBrain('SIVIL')
    llm = await callLLMForAgent(userPrompt, sivilBrain, SIVIL_SYNTHESIZE_SYSTEM_PROMPT, {
      temperature: 0.3,
      maxTokens: 3000,
      agentId: 'SIVIL',
      agentName: 'SIVIL (Sub-Orchestrator)',
    })
  } catch (err) {
    return {
      synthesis: '(LLM unavailable)',
      error: err instanceof Error ? err.message : String(err),
    }
  }

  if (llm.error) {
    return { synthesis: '(LLM unavailable)', error: llm.error }
  }

  const synthesis = (llm.content || '').trim()
  return {
    synthesis: synthesis || '(LLM returned empty synthesis)',
    error: synthesis ? undefined : 'LLM empty content',
  }
}

/** Format SA results table cho LLM SYNTHESIZE prompt */
function formatSAResultsForSynthesis(tasks: SubAgent[]): string {
  const lines: string[] = []
  for (const sa of tasks) {
    const status = sa.status === 'DONE' ? '✅' : sa.status === 'CONFLICT' ? '⚠️ CONFLICT' : '❌ FAILED'
    const result = sa.result || sa.error || '(no result)'
    const evidence = sa.evidence && sa.evidence.length > 0 ? sa.evidence.join('; ') : '—'
    lines.push(`### ${sa.id} ${sa.label} [${status}]`)
    lines.push(`Task: ${sa.task}`)
    lines.push(`Result: ${result}`)
    lines.push(`Evidence: ${evidence}`)
    lines.push(`Model: ${sa.modelUsed || '—'}`)
    lines.push('')
  }
  return lines.join('\n')
}

/** Collect files changed/referenced từ SA evidence (file:line pattern) */
function collectFilesChanged(tasks: SubAgent[]): string[] {
  const files = new Set<string>()
  for (const sa of tasks) {
    if (sa.evidence) {
      for (const e of sa.evidence) {
        const file = e.split(':')[0]
        if (file) files.add(file)
      }
    }
  }
  return Array.from(files)
}

// ============================================================
// §5. HELPERS — JSON parse + format
// ============================================================

/** Extract JSON object từ LLM content — 3 strategies (như classify.ts) */
function extractJsonFromContent(content: string): Record<string, unknown> | null {
  if (!content || typeof content !== 'string') return null
  const trimmed = content.trim()

  // 1. Parse thẳng
  try {
    const parsed = JSON.parse(trimmed)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
  } catch {
    // fallthrough
  }

  // 2. Markdown fence ```json ... ```
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)
  if (fenceMatch) {
    try {
      const parsed = JSON.parse(fenceMatch[1])
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
    } catch {
      // fallthrough
    }
  }

  // 3. First { ... }
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

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
    .map((s) => s.trim())
}

function clampProgress(v: number): number {
  if (!Number.isFinite(v)) return 0
  if (v < 0) return 0
  if (v > 100) return 100
  return v
}
