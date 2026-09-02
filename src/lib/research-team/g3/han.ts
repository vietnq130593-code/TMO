/**
 * RESEARCH TEAM — G3 HAN ENGINE (TB-05 §2-§4 + §4.3 Options A/B/C + Performance Baselines)
 * =================================================================================
 * Spec:
 *  - TB-05 §1 — HAN JD: Optimizer + self-evolving qua KB (M1) / Architecture
 *    Proposer + tối ưu perf (M2) — kiêm KB Curator. position=G3.
 *  - TB-05 §2 — Vòng 3 phases ANALYZE → OPTIMIZE → EVOLVE (priority P1 Safety
 *    → P2 Performance → P3 Code Quality).
 *  - TB-05 §3 — Self-Evolving Engine: APPLY → EXPERIMENT → MEASURE → LEARN →
 *    REPEAT (+ Bước 4 CURATE — TB-05 §3.4).
 *  - TB-05 §4 — Mode M2: 5 lĩnh vực tối ưu hệ thống (Memory / Execution /
 *    Thinking / Tools / UI-Perf). Sinh Proposal Item kèm Verification Plan (a)/(b).
 *  - TB-05 §4.3 — Options A/B/C: HAN dựng 3 options architecture + scorecard B
 *    kỳ vọng (import scoreRubricB from scoring/rubric-b — pure function với ước lượng HAN).
 *  - TB-05 §5 + Performance Baselines §5.1 — queryPerformanceBaselines cho
 *    scorecard S2 Impact (TB-14 §2.1) đối chiếu baseline.
 *  - TB-05 §9 E3 + DECISION-RECORD v1.3 Q2 — M2 không đo được metric → qualitative
 *    + Verification Plan (b) benchmark spec deferred.
 *
 * Bất biến:
 *  - KHÔNG auto-apply (DR-C1 + TB-05 §8 I4) — POC chỉ trong Workspace, Live read-only.
 *  - Trần 3 vòng Evolution Cycle mỗi task G3 (TB-05 §11 Q7) — quá → ESCALATE KING.
 *  - HAN directKbWrite=true (constants RESEARCH_ROSTER) → ghi KB trực tiếp qua
 *    kb-store.addEntry (category baseline/pattern/lesson).
 *  - M2: mỗi proposal item BẮT BUỘC kèm Verification Plan (a) manual + (b) benchmark.
 *
 * Fail-open policy (TB-13 §4 — NIM keys placeholder):
 *  - LLM error trong runHanOptimize → options=[], worklog.issuesFaced.push('LLM unavailable').
 *  - KHÔNG crash pipeline — caller (KING P5) handle escalate.
 */

import { callLLM } from '@/lib/llm'
import type { LLMResult } from '@/lib/llm'
import { AGENT_ID, RESEARCH_ROSTER } from '../constants'
import type {
  MissionTypeValue,
  WorklogEntry,
  ScorecardB,
  KBEntryCategoryValue,
} from '../types'
import type { ResearchKBEntry } from '../types'
import { scoreRubricB, type RubricBResult } from '../scoring/rubric-b'
import { addEntry, queryKB } from './kb-store'

// ============================================================
// §1. TYPES — HanOption + result
// ============================================================

/**
 * HanOption — TB-05 §4.3 Options A/B/C:
 *  - id: A | B | C (optionId).
 *  - label: short description.
 *  - description: detailed architecture proposal.
 *  - scorecardExpected: ScorecardB ước lượng HAN (pre-experiment — TB-14 §2.3).
 *  - pocRef: workspace path POC nếu có (P6 lo git-branch).
 *  - risks: rủi ro + trade-offs (TB-11 §1 trường 7 "Risk & Rollback").
 *  - verifyPlan: TB-05 §2.5 Verification Plan (a) manual NGAY + (b) benchmark deferred.
 */
export interface HanOption {
  id: string
  label: string
  description: string
  scorecardExpected: ScorecardB
  pocRef?: string
  risks: string[]
  /** TB-05 §2.5 + §11 Q1: (a) manual test NGAY + (b) benchmark spec deferred. */
  verifyPlan: string[]
}

/**
 * Result của runHanOptimize — output contract TB-05 §1.2:
 *  - options: HanOption[] (M1: có thể rỗng nếu no-op / M2: ≥1 option + proposalItems).
 *  - worklog: Partial<WorklogEntry> 8 trường (caller merge).
 *  - proposalItems: M2 — mỗi item kèm Verification Plan (TB-11 §1 schema — KING tổng hợp P6).
 *  - kbEntries: id refs của KB entries HAN đã ghi trực tiếp (directKbWrite=true).
 *  - concerns: cho KING/TL.
 */
export interface HanOptimizeResult {
  options: HanOption[]
  worklog: Partial<WorklogEntry>
  proposalItems: string[]
  kbEntries: string[]
  concerns: string[]
}

// ============================================================
// §2. SYSTEM PROMPT — HAN JD (TB-01 §1 + TB-05 §1.2)
// ============================================================

const HAN_SYSTEM_PROMPT = [
  `Bạn là HAN (research team TMO). Position: G3.`,
  `JD: ${RESEARCH_ROSTER.find((r) => r.id === AGENT_ID.HAN)?.jd ?? 'Tối ưu + self-evolving qua KB (M1) / Architecture Proposer + tối ưu perf (M2) — kiêm KB Curator'}.`,
  '',
  'MODE OPERATION:',
  '- M1 (Kaggle): Optimizer + Learner. Tuning, ensemble, feature engineering. Priority: Data Safety → Performance → Code Quality.',
  '- M2 (System Research TMO): Architecture Proposer. Sinh proposal items + Verification Plan (a) + (b).',
  '',
  'PRIORITY (TB-05 §2.1 — GUARD):',
  '- P1 Data/System Safety: VERIFY G2 fixes trước. P1 FAIL → STOP optimize, ESCALATE.',
  '- P2 Performance: tuning/ensemble (M1) / proposal items memory/exec/perf (M2).',
  '- P3 Code/Architecture Quality: simplification, remove redundancy.',
  '',
  'KB POLICY (TB-05 §3 + TB-08):',
  '- LUÔN load Knowledge Base trước khi optimize.',
  '- Ghi lesson mới sau mỗi vòng (EVOLVE). HAN có directKbWrite=true.',
  '- Curate (consolidate/dedup/retire) entries NEW mỗi chu trình G3.',
  '',
  'M2 OUTPUT — OPTIONS A/B/C (TB-05 §4.3):',
  '- Sinh 3 options (A/B/C) — mỗi option kèm scorecard B kỳ vọng 6 dims (S1-S6).',
  '- Mỗi option kèm Verification Plan (a) manual NGAY + (b) benchmark deferred.',
  '- Recommendation: xếp hạng theo effort × tác động.',
  '',
  'OUTPUT FORMAT (markdown):',
  '## HAN Optimize Report',
  '### Mission',
  '<M1 | M2 | M3>',
  '',
  '### Options (M2)',
  '#### Option A — <label>',
  '- Description: <đề xuất kiến trúc>',
  '- Scorecard Expected (S1-S6, mỗi dim 0-5):',
  '  S1=<n>, S2=<n>, S3=<n>, S4=<n>, S5=<n>, S6=<n>',
  '- Risks: <rủi ro + trade-offs>',
  '- Verification Plan:',
  '  (a) Manual test NGAY: <log check / manual test cụ thể>',
  '  (b) Benchmark deferred: <metric + method + ngưỡng>',
  '',
  '#### Option B — <label>',
  '<...>',
  '',
  '#### Option C — <label>',
  '<...>',
  '',
  '### KB Entries (HAN ghi trực tiếp)',
  '- <category>: <title> — <evidence>',
  '',
  '### Concerns for KING',
  '- <concern>',
].join('\n')

// ============================================================
// §3. RUN HAN OPTIMIZE — main entry point
// ============================================================

/**
 * Run HAN optimize — TB-05 §2-§4:
 *  - M1: tuning, ensemble, feature engineering → optimized code.
 *  - M2: Architecture Proposer — sinh Options A/B/C với scorecard B kỳ vọng.
 *    Mỗi option kèm Verification Plan (a) + (b) — TB-05 §2.5.
 *  - Sinh worklog 8 trường (TB-09 §4.2) — partial, caller merge.
 *  - HAN directKbWrite=true → ghi KB trực tiếp qua kb-store addEntry:
 *      category 'baseline' (perf baselines) + 'pattern' (architecture) + 'lesson'.
 *  - Trần 3 vòng Evolution Cycle mỗi task G3 (TB-05 §11 Q7) — caller enforce.
 *
 * Fail-open (TB-13 §4 — NIM keys placeholder):
 *  - LLM error → options=[], worklog.issuesFaced.push('LLM unavailable'). KHÔNG crash.
 */
export async function runHanOptimize(
  missionId: string,
  taskId: string,
  cleanCode: string,
  diagnosticReport: string,
  missionType: 'M1' | 'M2' | 'M3',
  successCriteria: string[],
): Promise<HanOptimizeResult> {
  const { system, user } = buildOptionsPrompt(diagnosticReport, cleanCode, successCriteria)

  let llm: LLMResult
  try {
    llm = await callLLM(user, system, `han-optimize-${missionType.toLowerCase()}`, {
      temperature: 0.2,
      maxTokens: 4000,
      agentId: AGENT_ID.HAN,
      agentName: 'HAN (G3 Architecture Proposer)',
    })
  } catch (err) {
    console.warn(
      '[HAN] callLLM threw (non-blocking — fail-open):',
      err instanceof Error ? err.message : String(err),
    )
    return failOpenHan(missionId, taskId, missionType, `LLM call threw: ${err instanceof Error ? err.message : String(err)}`)
  }

  if (llm.error || !llm.content || llm.content.trim().length === 0) {
    console.warn('[HAN] LLM error/empty content — fail-open:', llm.error ?? 'empty content')
    return failOpenHan(missionId, taskId, missionType, llm.error ?? 'LLM unavailable — empty content')
  }

  // Parse options + KB entries + concerns từ LLM output
  const parsed = parseHanOutput(llm.content, missionType)

  // HAN directKbWrite=true → persist KB entries vào SQLite canonical
  const kbEntries: string[] = []
  for (const kbCandidate of parsed.kbCandidates) {
    try {
      const { id } = await addEntry(
        {
          category: kbCandidate.category,
          title: kbCandidate.title,
          content: kbCandidate.content,
          sourceMission: missionId,
        },
        1, // phase=1 NEW — HAN ghi trực tiếp, chờ curate promote
      )
      kbEntries.push(id)
    } catch (err) {
      console.warn(
        '[HAN] addEntry failed (non-blocking — skip):',
        err instanceof Error ? err.message : String(err),
      )
    }
  }

  // Build worklog 8 trường (partial — caller merge)
  const worklog: Partial<WorklogEntry> = {
    mission: missionType as MissionTypeValue,
    status: 'IN_PROGRESS',
    currentPhase: 'G3',
    overallProgress: missionType === 'M2' ? 70 : 80,
    tlReadBack: 'NEEDS-REVIEW',
    done: [
      `HAN optimize — mission ${missionId} / task ${taskId}`,
      `Options generated: ${parsed.options.length} (M2 Architecture Proposer)`,
      `KB entries written: ${kbEntries.length} (directKbWrite=true)`,
    ],
    issuesFaced: parsed.concerns.length > 0 ? parsed.concerns.slice(0, 3) : [],
    suggestionsNextGroup: [
      ...(missionType === 'M2'
        ? ['KING verify CP3 — mỗi option có Verification Plan (a)+(b)?']
        : []),
      'Curate KB entries NEW — HAN consolidate trong chu trình G3 gần nhất',
    ],
    filesChanged: [],
    kbEntries,
    concernsForTl: parsed.concerns,
  }

  return {
    options: parsed.options,
    worklog,
    proposalItems: parsed.proposalItems,
    kbEntries,
    concerns: parsed.concerns,
  }
}

// ============================================================
// §4. QUERY PERFORMANCE BASELINES — TB-05 §5.1 + TB-14 §2.1 S2 Impact
// ============================================================

/**
 * Query KB category='baseline' liên quan mission context.
 * TB-05 §5.1 Performance Baselines (121s → 6.2s, 39,615 nodes, 52 PDFs) — HAN load
 * Phase 1 ANALYZE để đối chiếu scorecard S2 Impact (TB-14 §2.1).
 *
 * Fail-open: KB error → empty array (KHÔNG crash).
 */
export async function queryPerformanceBaselines(
  missionContext: string,
): Promise<ResearchKBEntry[]> {
  try {
    // Query theo context keyword nếu có, fallback toàn category='baseline'
    if (missionContext && missionContext.trim().length > 0) {
      const kw = missionContext.trim()
      const rows = await queryKB({ category: 'baseline', search: kw, limit: 20 })
      if (rows.length > 0) return rows
    }
    return await queryKB({ category: 'baseline', limit: 20 })
  } catch (err) {
    console.warn(
      '[HAN] queryPerformanceBaselines failed (non-blocking — empty):',
      err instanceof Error ? err.message : String(err),
    )
    return []
  }
}

// ============================================================
// §5. BUILD OPTIONS PROMPT — pure helper
// ============================================================

/**
 * Build system + user prompt cho HAN optimize — TB-05 §1.2 + §4.3.
 * Pure function — không LLM/DB call. Caller (runHanOptimize) gọi callLLM.
 */
export function buildOptionsPrompt(
  diagnosticReport: string,
  cleanCode: string,
  successCriteria: string[],
): { system: string; user: string } {
  const criteriaBlock =
    successCriteria.length > 0
      ? successCriteria.map((c, i) => `[${i + 1}] ${c}`).join('\n')
      : '(none)'

  const user = [
    `# HAN OPTIMIZE — Mission context`,
    '',
    '## Diagnostic Report (G2 LISMA output)',
    diagnosticReport || '(no diagnostic report provided)',
    '',
    '## Clean Code (G2 verified)',
    cleanCode || '(no code provided)',
    '',
    '## Success Criteria',
    criteriaBlock,
    '',
    '## Instruction',
    'M1 mode: optimize theo priority P1 Safety → P2 Performance → P3 Quality.',
    'M2 mode: Architecture Proposer — sinh 3 options A/B/C với scorecard B kỳ vọng (S1-S6, mỗi dim 0-5) + Verification Plan (a)+(b) cho mỗi option.',
    'Ghi KB entries nếu có insight mới (category baseline/pattern/lesson) — HAN directKbWrite=true.',
    'Output theo format markdown trong system prompt.',
  ].join('\n')

  return { system: HAN_SYSTEM_PROMPT, user }
}

// ============================================================
// §6. INTERNAL HELPERS — parse + fail-open
// ============================================================

interface ParsedHanOutput {
  options: HanOption[]
  proposalItems: string[]
  kbCandidates: Array<{
    category: KBEntryCategoryValue
    title: string
    content: string
  }>
  concerns: string[]
}

/**
 * Parse HAN output markdown → ParsedHanOutput.
 * Heuristic regex-based — section "#### Option X" → HanOption với scorecard B.
 *
 * Pure function — không LLM/DB call.
 */
function parseHanOutput(
  content: string,
  missionType: 'M1' | 'M2' | 'M3',
): ParsedHanOutput {
  const result: ParsedHanOutput = {
    options: [],
    proposalItems: [],
    kbCandidates: [],
    concerns: [],
  }

  if (!content) return result

  // Parse Options — section "#### Option X — <label>"
  // (ES2017 target: no 's' flag — use [\s\S] for dotAll semantics)
  const optionRegex = /####\s+Option\s+([A-Z])\s*[—-]\s*([\s\S]+?)(?=\n####\s+Option|\n###\s|$)/g
  let om: RegExpExecArray | null
  while ((om = optionRegex.exec(content)) !== null) {
    const id = om[1]
    const label = (om[2] || '').split('\n')[0].trim()
    const body = om[0] || ''

    // Parse scorecard dims S1-S6
    const dims = parseScorecardDims(body)

    // Compute scorecard via pure function scoreRubricB (TB-14 §2)
    const rubricB: RubricBResult = scoreRubricB({
      s1_coverage: dims.S1,
      s2_impact: dims.S2,
      s3_risk: dims.S3,
      s4_effort: dims.S4,
      s5_contextFit: dims.S5,
      s6_verify: dims.S6,
    })

    // Parse description
    const descMatch = body.match(/-\s*Description:\s*([\s\S]+?)(?=\n-\s*(?:Scorecard|Risks|Verification)|\n####|\n###|$)/i)
    const description = descMatch ? descMatch[1].trim() : '(no description)'

    // Parse risks
    const risksMatch = body.match(/-\s*Risks:\s*([\s\S]+?)(?=\n-\s*Verification|\n####|\n###|$)/i)
    const risks = risksMatch
      ? risksMatch[1].split('\n').map((l) => l.replace(/^[\s-]+/, '').trim()).filter((l) => l.length > 0)
      : []

    // Parse Verification Plan (a) + (b)
    const verifyMatch = body.match(/-\s*Verification Plan:\s*([\s\S]*?)(?=\n####|\n###|$)/i)
    const verifyPlan: string[] = []
    if (verifyMatch) {
      const vp = verifyMatch[1]
      const aMatch = vp.match(/\(a\)\s*Manual[^:]*:\s*([\s\S]+?)(?=\n\s*\(b\)|$)/i)
      const bMatch = vp.match(/\(b\)\s*Benchmark[^:]*:\s*([\s\S]+?)(?=\n####|\n###|$)/i)
      if (aMatch) verifyPlan.push(`(a) Manual: ${aMatch[1].trim()}`)
      if (bMatch) verifyPlan.push(`(b) Benchmark: ${bMatch[1].trim()}`)
    }

    result.options.push({
      id,
      label,
      description,
      scorecardExpected: rubricB,
      risks,
      verifyPlan,
    })

    // M2: mỗi option = 1 proposal item (TB-05 §11 Q1: 1 task G3 sinh ≥1 proposal item)
    if (missionType !== 'M1') {
      result.proposalItems.push(`Option ${id} — ${label}`)
    }
  }

  // Parse KB Candidates — section "### KB Entries"
  const kbSection = content.match(/###\s+KB Entries[\s\S]*?(?=\n###\s|$)/i)
  if (kbSection) {
    const kbLines = kbSection[0]
      .split('\n')
      .filter((l) => l.trim().startsWith('-'))
    for (const line of kbLines) {
      // Parse "- <category>: <title> — <evidence>"
      const m = line.match(/^-\s*(\w[\w-]*):\s*(.+?)(?:\s*[—-]\s*(.+))?$/)
      if (m) {
        const category = m[1].toLowerCase()
        const title = (m[2] || '').trim()
        const evidence = (m[3] || '').trim()
        const validCategories: KBEntryCategoryValue[] = [
          'lesson',
          'anti-pattern',
          'baseline',
          'pattern',
          'calibration',
        ]
        if (validCategories.includes(category as KBEntryCategoryValue)) {
          result.kbCandidates.push({
            category: category as KBEntryCategoryValue,
            title,
            content: `Insight: ${title}\nEvidence: ${evidence || '(no evidence — TB-05 §3.3)'}\nSource: HAN (G3 EVOLVE)\nMission: ${missionType}\nConfidence: MEDIUM.`,
          })
        }
      }
    }
  }

  // Parse Concerns — section "### Concerns for KING"
  const concernsSection = content.match(/###\s+Concerns[\s\S]*?(?=\n###\s|$)/i)
  if (concernsSection) {
    const concernLines = concernsSection[0]
      .split('\n')
      .filter((l) => l.trim().startsWith('-'))
      .map((l) => l.replace(/^[\s-]+/, '').trim())
      .filter((l) => l.length > 0)
    result.concerns.push(...concernLines)
  }

  return result
}

/** Parse scorecard dims S1-S6 từ option body — heuristic regex. */
function parseScorecardDims(body: string): {
  S1: number
  S2: number
  S3: number
  S4: number
  S5: number
  S6: number
} {
  const extract = (k: string): number => {
    const re = new RegExp(`\\b${k}\\s*=\\s*([0-5](?:\\.\\d+)?)`, 'i')
    const m = body.match(re)
    if (m && m[1]) {
      const n = parseFloat(m[1])
      if (Number.isFinite(n)) return Math.max(0, Math.min(5, n))
    }
    return 0
  }
  return {
    S1: extract('S1'),
    S2: extract('S2'),
    S3: extract('S3'),
    S4: extract('S4'),
    S5: extract('S5'),
    S6: extract('S6'),
  }
}

/**
 * Fail-open HAN — LLM unavailable (TB-13 §4).
 * TB-05 §8 I7: ESCALATED state — KING điều hướng, KHÔNG tự mở khóa.
 *
 * KHÔNG crash pipeline — caller (KING P5) handle escalate.
 */
function failOpenHan(
  missionId: string,
  taskId: string,
  missionType: 'M1' | 'M2' | 'M3',
  reason: string,
): HanOptimizeResult {
  return {
    options: [],
    worklog: {
      mission: missionType as MissionTypeValue,
      status: 'ESCALATED',
      currentPhase: 'G3',
      overallProgress: 50,
      tlReadBack: 'NEEDS-REVIEW',
      done: [`HAN optimize — fail-open (LLM unavailable) — mission ${missionId}/task ${taskId}`],
      issuesFaced: [reason],
      suggestionsNextGroup: ['Manual review needed — LLM unavailable; HAN defer optimize'],
      filesChanged: [],
      concernsForTl: [`LLM unavailable — ${reason}`],
    },
    proposalItems: [],
    kbEntries: [],
    concerns: [`LLM unavailable — ${reason}`],
  }
}

// ============================================================
// §7. RE-EXPORTS — convenience for caller (king P5)
// ============================================================

export {
  addEntry,
  queryKB,
  retireEntry,
  curatePhase,
  exportSnapshot,
  seedKB,
  getKBStats,
  getEntry,
} from './kb-store'
export type {
  KBEntryInput,
  SnapshotResult,
  KBStats,
  QueryKBParams,
} from './kb-store'
