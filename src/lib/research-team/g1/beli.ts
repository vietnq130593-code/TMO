/**
 * RESEARCH TEAM — G1 BELI ENGINE (TB-03 §2 JD + §4.5 IMPLEMENT + §2.3 Live/Workspace)
 * ==================================================================================
 * Spec:
 *  - TB-03 §2.1 JD BELI — "Code lượt đầu đúng spec (M1) / research report + POC
 *    trong Workspace (M2)".
 *  - TB-03 §2.3 Phân quyền M2 — Live System READ-ONLY; Workspace mới được
 *    viết/chỉnh. POC chỉ trong Workspace (D5 TB-10 §4).
 *  - TB-03 §4.5 IMPLEMENT — BELI nhận K specs → draft + notes + suggestions.
 *  - TB-03 §7.3 SPEC template — id/nhiệm vụ/priority/approach/acceptance/files/
 *    ràng buộc/deadline nội bộ.
 *
 * Mission types:
 *  - M1: BELI sinh code draft (markdown code block) — repo competition.
 *  - M2: BELI sinh research report + POC reference (path Workspace).
 *  - M3: BELI sinh literature review / research paper sections.
 *
 * Fail-open policy (TB-13 §4 — NIM keys placeholder):
 *  - LLM error → spec='(LLM unavailable — spec deferred)', KHÔNG throw.
 *  - BELI không được tự đổi approach (Instructions §2.2) — LLM error chỉ hoãn,
 *    KHÔNG tự sinh spec thay thế.
 */

import { callLLMForAgent } from '@/lib/llm'
import type { LLMResult } from '@/lib/llm'
import { RESEARCH_ROSTER, AGENT_ID } from '../constants'
import { resolveResearchBrain } from '../agents'
import type { WorklogEntry } from '../types'

// ============================================================
// §1. TYPES — BELI spec result
// ============================================================

export interface BeliSpecResult {
  /** Spec / code draft / report — output của BELI theo missionType */
  spec: string
  /** Worklog entry (8 trường TB-09 §4.2) — caller persist qua db.researchWorklog */
  worklog: Partial<WorklogEntry>
  /** M2: POC reference path trong Workspace (vd: workspace/research/<mission>/poc/...) */
  pocRef?: string
  /** Notes edge cases BELI gặp phải (Instructions BELI §2.2 — kèm mỗi draft) */
  notes?: string[]
  /** Suggestions cho G2 (LISMA) — ý tưởng cải tiến không tự thực thi */
  suggestions?: string[]
}

// ============================================================
// §2. SYSTEM PROMPT — BELI JD (TB-03 §2.1)
// ============================================================

const BELI_M1_SYSTEM_PROMPT = [
  'Bạn là BELI (G1 Coder — research team TMO).',
  `JD: ${RESEARCH_ROSTER.find((r) => r.id === AGENT_ID.BELI)?.jd ?? 'Code lượt đầu đúng spec (M1)'}.`,
  '',
  'NHIỆM VỤ BƯỚC NÀY — IMPLEMENT M1 (TB-03 §4.5):',
  '- Nhận spec từ SIVIL → code lượt đầu ĐÚNG SPEC.',
  '- Follow spec chính xác: approach, file path, expected output.',
  '- Ghi notes mọi edge case gặp phải.',
  '- KHÔNG tự đổi approach — chỉ đề xuất ngược SIVIL (feedback loop §8).',
  '',
  'OUTPUT — markdown code draft + notes + suggestions:',
  '```python',
  '// code lượt đầu theo spec',
  '```',
  '## Notes (edge cases)',
  '- ...',
  '## Suggestions for G2 (LISMA)',
  '- ...',
].join('\n')

const BELI_M2_SYSTEM_PROMPT = [
  'Bạn là BELI (G1 Coder — research team TMO).',
  `JD: ${RESEARCH_ROSTER.find((r) => r.id === AGENT_ID.BELI)?.jd ?? 'Research report + POC trong Workspace (M2)'}.`,
  '',
  'NHIỆM VỤ BƯỚC NÀY — IMPLEMENT M2 (TB-03 §4.5 + §2.3):',
  '- Nhận synthesis/spec từ SIVIL → viết research report + POC trong WORKSPACE.',
  '- Live System (TMO app đang chạy): CHỈ ĐỌC làm evidence (file:line + log excerpt).',
  '- Workspace (thư mục clone): được viết report/POC/chỉnh file clone/chạy thử.',
  '- Mọi claim BẮT BUỘC kèm evidence (file:line / log excerpt) — TB-04 §5.',
  '',
  'QUY TẮC VÀNG M2 (TB-01 §3, TB-10 D5):',
  '- KHÔNG BAO GIỜ đụng Live System — không sửa file, không restart PM2, không ghi .env.',
  '- POC chỉ nằm trong Workspace (path bắt đầu bằng `workspace/research/<mission>/`).',
  '- Áp thay đổi lên Live chỉ sau khi Proposal APPROVED (TB-11) — KHÔNG tự apply.',
  '',
  'OUTPUT — markdown research report + POC reference:',
  '## Research Report',
  '### Findings',
  '- Finding 1 — evidence: src/lib/xxx.ts:123',
  '- ...',
  '## POC Reference',
  '- Path: workspace/research/<mission>/poc/<poc-name>',
  '- Mô tả: ...',
  '## Notes (edge cases)',
  '## Suggestions for G2 (LISMA)',
].join('\n')

const BELI_M3_SYSTEM_PROMPT = [
  'Bạn là BELI (G1 Coder — research team TMO).',
  `JD: ${RESEARCH_ROSTER.find((r) => r.id === AGENT_ID.BELI)?.jd ?? 'Code lượt đầu đúng spec'}.`,
  '',
  'NHIỆM VỤ BƯỚC NÀY — IMPLEMENT M3 (literature review / paper):',
  '- Nhận spec → viết literature review section / research paper draft.',
  '- Mọi claim BẮT BUỘC kèm citation (paper ref / source link).',
  '',
  'OUTPUT — markdown draft với citation đầy đủ.',
].join('\n')

// ============================================================
// §3. BUILD SPEC PROMPT — pure helper (testable)
// ============================================================

export interface SpecPrompt {
  system: string
  user: string
}

/**
 * Pure helper — build prompt cho BELI dựa trên synthesis + missionType.
 * Trả về {system, user} để caller dùng với callLLM.
 */
export function buildSpecPrompt(
  synthesis: string,
  missionType: 'M1' | 'M2' | 'M3',
): SpecPrompt {
  const system =
    missionType === 'M1'
      ? BELI_M1_SYSTEM_PROMPT
      : missionType === 'M3'
        ? BELI_M3_SYSTEM_PROMPT
        : BELI_M2_SYSTEM_PROMPT

  const user = [
    `MISSION TYPE: ${missionType}`,
    '',
    'SYNTHESIS REPORT TỪ SIVIL (council ② đã xác nhận):',
    synthesis || '(synthesis trống — fallback BELI tự đề xuất minimal scope)',
    '',
    missionType === 'M1'
      ? 'Code lượt đầu theo top-K approaches đã SYNTHESIZE. 1 file/spec — KHÔNG gộp nhiều file không liên quan.'
      : missionType === 'M2'
        ? 'Viết research report + POC trong Workspace. Mọi claim kèm evidence từ Live System (read-only).'
        : 'Viết literature review section / paper draft với citation đầy đủ.',
  ].join('\n')

  return { system, user }
}

// ============================================================
// §4. RUN BELI SPEC — main entry (TB-03 §4.5)
// ============================================================

/**
 * Run BELI spec: gọi callLLM với system prompt BELI JD theo missionType.
 *  - M1: output = code draft (markdown code block).
 *  - M2: output = research report + POC reference path trong Workspace.
 *  - M3: output = literature review / paper draft.
 *
 * TB-03 §2.2 Instructions — BELI KHÔNG tự đổi approach. LLM error → fail-open
 * (spec deferred), KHÔNG tự sinh spec thay thế.
 */
export async function runBeliSpec(
  missionId: string,
  taskId: string,
  synthesis: string,
  missionType: 'M1' | 'M2' | 'M3',
): Promise<BeliSpecResult> {
  const startedAt = new Date().toISOString()
  const { system, user } = buildSpecPrompt(synthesis, missionType)

  let llm: LLMResult
  try {
    // Task 4 — route BELI qua Zen khi DB provider='zen' (fail-open → NIM).
    const beliBrain = await resolveResearchBrain('BELI')
    llm = await callLLMForAgent(user, beliBrain, system, {
      temperature: 0.3, // first-pass accuracy — thấp temperature cho deterministic
      maxTokens: 4000,
      agentId: 'BELI',
      agentName: 'BELI (Coder)',
    })
  } catch (err) {
    // LLM throw → fail-open (spec deferred, KHÔNG crash)
    const errorMsg = err instanceof Error ? err.message : String(err)
    console.warn('[ResearchTeam/g1/beli] callLLM threw:', errorMsg)
    return failOpenBeliSpec(missionId, taskId, missionType, startedAt, `LLM call threw: ${errorMsg}`)
  }

  if (llm.error) {
    console.warn('[ResearchTeam/g1/beli] LLM error field:', llm.error)
    return failOpenBeliSpec(missionId, taskId, missionType, startedAt, llm.error)
  }

  const spec = (llm.content || '').trim() || '(LLM returned empty spec)'
  const notes = extractSection(spec, ['## Notes', '## Notes (edge cases)', '### Notes'])
  const suggestions = extractSection(spec, [
    '## Suggestions',
    '## Suggestions for G2 (LISMA)',
    '### Suggestions for G2',
  ])
  const pocRef = missionType === 'M2' ? extractPocRef(spec, missionId) : undefined

  const worklog: Partial<WorklogEntry> = {
    mission: missionType,
    status: spec === '(LLM returned empty spec)' ? 'BLOCKED' : 'IN_PROGRESS',
    currentPhase: 'G1',
    overallProgress: 80, // BELI IMPLEMENT ~80% of G1 round
    tlReadBack: 'NEEDS-REVIEW', // SIVIL sẽ VERIFY bước 6 (TB-03 §4.6)
    done: [
      `BELI IMPLEMENT (${missionType}): spec draft ${spec === '(LLM returned empty spec)' ? '(empty — deferred)' : 'ready'}`,
      ...(pocRef ? [`POC ref: ${pocRef}`] : []),
    ],
    issuesFaced: spec === '(LLM returned empty spec)' ? ['LLM returned empty spec — BELI blocked'] : [],
    suggestionsNextGroup: [
      'SIVIL VERIFY (TB-03 §4.6): khớp spec? completeness? ghi issues cho G2 (LISMA)',
      'G2 sẽ review theo Leakage/Suspect Locations (TB-10 §5.1)',
    ],
    filesChanged: extractFileMentions(spec, missionId, missionType),
    header: `[${startedAt}] — G1/BELI — Task ${taskId} (${missionType})`,
    taskId,
  }

  return {
    spec,
    worklog,
    pocRef,
    notes: notes.length > 0 ? notes : undefined,
    suggestions: suggestions.length > 0 ? suggestions : undefined,
  }
}

/** Fail-open builder — LLM error → spec='(LLM unavailable — spec deferred)' */
function failOpenBeliSpec(
  _missionId: string,
  taskId: string,
  missionType: 'M1' | 'M2' | 'M3',
  startedAt: string,
  error: string,
): BeliSpecResult {
  return {
    spec: '(LLM unavailable — spec deferred)',
    worklog: {
      mission: missionType,
      status: 'BLOCKED',
      currentPhase: 'G1',
      overallProgress: 80,
      tlReadBack: 'NEEDS-REVIEW',
      done: [`BELI IMPLEMENT (${missionType}): deferred — LLM unavailable`],
      issuesFaced: [
        `LLM unavailable — spec deferred (TB-13 §4 fail-open): ${error}`,
        'Spec sẽ cần retry khi LLM available — KHÔNG tự sinh spec thay thế (Instructions BELI §2.2)',
      ],
      suggestionsNextGroup: [
        'Retry BELI khi NIM keys available',
        'SIVIL KHÔNG tự code thay BELI (TB-03 §3 ranh giới cứng)',
      ],
      filesChanged: [],
      header: `[${startedAt}] — G1/BELI — Task ${taskId} (${missionType}) [FAIL-OPEN]`,
      taskId,
    },
  }
}

// ============================================================
// §5. HELPERS — extract sections + POC ref + file mentions
// ============================================================

/**
 * Extract section items từ markdown spec (## Notes, ## Suggestions...).
 * Trả về mảng bullet items dưới section đó (cho đến section kế tiếp).
 */
function extractSection(markdown: string, headers: string[]): string[] {
  if (!markdown) return []
  const lines = markdown.split('\n')
  const items: string[] = []
  let inSection = false

  for (const line of lines) {
    const trimmed = line.trim()
    const isHeader = /^#{1,6}\s/.test(trimmed)
    if (isHeader) {
      const headerText = trimmed.replace(/^#{1,6}\s+/, '').toLowerCase()
      inSection = headers.some((h) => headerText.includes(h.toLowerCase().replace(/^#{1,6}\s+/, '')))
      continue
    }
    if (inSection && trimmed.startsWith('-')) {
      items.push(trimmed.slice(1).trim())
    } else if (inSection && trimmed.length > 0 && !trimmed.startsWith('-')) {
      // Section content không phải bullet → vẫn lấy nếu có text
      if (items.length === 0 || items[items.length - 1] !== trimmed) {
        items.push(trimmed)
      }
    }
  }
  return items
}

/**
 * Extract POC reference path từ M2 spec (TB-03 §2.3 + TB-10 D5).
 * Pattern: "Path: workspace/research/<mission>/poc/<name>"
 */
function extractPocRef(spec: string, missionId: string): string | undefined {
  if (!spec) return undefined
  const patterns = [
    /(?:POC\s*(?:Reference|Ref|Path)?[:\s]+)(workspace\/[^\s)]+)/i,
    /Path:\s*(workspace\/[^\s)]+)/i,
    /workspace\/research\/[^\s)]+\/poc\/[^\s)]+/i,
  ]
  for (const p of patterns) {
    const m = spec.match(p)
    if (m) {
      // Ưu tiên group 1 nếu có, ngược lại lấy full match
      const path = m[1] || m[0]
      return path.replace(/[)`*]+$/, '').trim()
    }
  }
  // Fallback: nếu spec có nhắc POC nhưng không có path rõ → sinh path mặc định
  if (/POC/i.test(spec)) {
    return `workspace/research/${missionId}/poc/poc-draft.md`
  }
  return undefined
}

/**
 * Extract file mentions từ spec — M1: code file paths; M2: LIVE:/WS: prefixes.
 * TB-10 §3.2 — M2 phân biệt `LIVE:` (read từ Live System) vs `WS:` (Workspace).
 */
function extractFileMentions(
  spec: string,
  missionId: string,
  missionType: 'M1' | 'M2' | 'M3',
): string[] {
  if (!spec) return []
  const files = new Set<string>()

  if (missionType === 'M1') {
    // M1: Python file paths (src/..., *.py)
    const pyPattern = /(?:src\/|scripts\/|notebooks\/)?[\w-]+\.(?:py|ipynb|csv|md)/g
    const matches = spec.match(pyPattern) || []
    for (const m of matches) files.add(m)
  } else if (missionType === 'M2') {
    // M2: LIVE:/WS: prefixes (TB-10 §3.2)
    const livePattern = /LIVE:\s*([^\s)]+)/g
    const wsPattern = /WS:\s*([^\s)]+)/g
    let m: RegExpExecArray | null
    while ((m = livePattern.exec(spec)) !== null) files.add(`LIVE:${m[1]}`)
    while ((m = wsPattern.exec(spec)) !== null) files.add(`WS:${m[1]}`)

    // Fallback: cũng scan src/lib/*.ts paths
    const tsPattern = /src\/lib\/[\w/-]+\.(?:ts|tsx|js|md)/g
    const tsMatches = spec.match(tsPattern) || []
    for (const m of tsMatches) files.add(`LIVE:${m}`)
  } else {
    // M3: paper refs / citations
    const refPattern = /\[[\w-]+(?:,\s*\d{4})?\]/g
    const matches = spec.match(refPattern) || []
    for (const m of matches) files.add(m)
  }

  // M2: thêm POC path mặc định nếu có POC ref
  if (missionType === 'M2' && /POC/i.test(spec)) {
    files.add(`WS:workspace/research/${missionId}/poc/poc-draft.md`)
  }

  return Array.from(files)
}
