/**
 * RESEARCH TEAM — G2 LISMA ENGINE (TB-04 §2-§3 + Diagnostic Report + Rubric A)
 * =================================================================================
 * Spec:
 *  - TB-04 §2 — LISMA JD: "Review–tìm–fix lặp đến sạch bug (M1) / System
 *    Diagnostician root cause (M2)". position=G2.
 *  - TB-04 §3.3 — Diagnostic Report M2: LISMA root cause + findings (mỗi finding
 *    BẮT BUỘC evidence — TC-06 fail-closed) + Rubric A score cho mỗi hypothesis.
 *  - TB-04 §5 — Evidence bắt buộc: claim thiếu evidence → bị loại khỏi DR.
 *  - TB-13 §5 P3 gate — TC-04 (regression re-test) + TC-06 (evidence gap) +
 *    TC-10 (workspace read-only) + TC-12 (model switch no reset).
 *
 * Bất biến:
 *  - KHÔNG auto-apply (DR-C1) — mọi fix nằm workspace (caller RWV loop persist).
 *  - Trần G2_MAX_FIX_ROUNDS=3 (constants.ts) — quá → ESCALATE NEMESIS.
 *  - M1: review code → tìm bug → fix bug (≤3 vòng → ESCALATE).
 *  - M2: System Diagnostician — root cause từ logs + code + Diagnostic Report.
 *  - Mọi finding BẮT BUỘC evidence (TC-06 — filterClaimsWithEvidence loại gap).
 *
 * Fail-open policy (TB-13 §4 — NIM keys placeholder):
 *  - LLM error trong runLismaReview → diagnosticReport='(LLM unavailable)',
 *    escalated=true, escalateReason='LLM unavailable — manual review needed'.
 *  - KHÔNG crash pipeline — caller (NEMESIS P5) handle escalate.
 */

import { callLLM } from '@/lib/llm'
import type { LLMResult } from '@/lib/llm'
import { AGENT_ID, RESEARCH_ROSTER, G2_MAX_FIX_ROUNDS } from '../constants'
import type {
  EvidenceItem,
  MissionTypeValue,
  WorklogEntry,
  WorklogFinding,
} from '../types'
import {
  scoreRubricAWithLlm,
  type RubricAResult,
  type RubricAInput,
} from '../scoring/rubric-a'
import {
  validateEvidence,
  filterClaimsWithEvidence,
  formatEvidenceCitation,
  buildEvidenceBackedFindings,
} from './evidence-log'

// ============================================================
// §1. TYPES — LISMA Review Result
// ============================================================

export interface LismaReviewResult {
  /** Markdown Diagnostic Report (TB-04 §3.3) — findings + evidence + rubric */
  diagnosticReport: string
  /** Worklog entry 8 trường (TB-09 §4.2) — partial, caller merge */
  worklog: Partial<WorklogEntry>
  /** Evidence items (TC-06 — claim bắt buộc evidence) */
  evidence: EvidenceItem[]
  /** Concerns cho NEMESIS/TL (issues_found + concerns_for_tl) */
  concerns: string[]
  /** TC-04: nếu fix gây regression → flag true + re-test bug gốc */
  regressionFound: boolean
  /** TC-06: claims bị loại vì thiếu evidence */
  evidenceGapClaims: string[]
  /** Escalate flag — true nếu quá trần fix rounds hoặc LLM unavailable */
  escalated: boolean
  /** Reason nếu escalated */
  escalateReason?: string
  /** Rubric A score cho root cause hypothesis (M2) */
  rubricScore?: RubricAResult
  /** Vòng fix hiện tại (M1) */
  round: number
}

// ============================================================
// §2. SYSTEM PROMPT — LISMA JD (TB-01 §1 + TB-04 §2)
// ============================================================

const LISMA_SYSTEM_PROMPT = [
  `Bạn là LISMA (research team TMO). Position: G2.`,
  `JD: ${RESEARCH_ROSTER.find((r) => r.id === AGENT_ID.LISMA)?.jd ?? 'Review–tìm–fix lặp đến sạch bug (M1) / System Diagnostician root cause (M2)'}.`,
  '',
  'MODE OPERATION:',
  '- M1 (verify): review code → tìm bug → fix bug. Trần 3 vòng fix → ESCALATE NEMESIS.',
  '- M2 (change): System Diagnostician — root cause từ logs + code + Diagnostic Report.',
  '',
  'EVIDENCE POLICY (TB-04 §5 + TC-06):',
  '- MỌI claim/finding PHẢI có evidence cụ thể: file:line / log excerpt / metric.',
  '- Claim thiếu evidence → KHÔNG được chấp nhận, bị loại khỏi Diagnostic Report.',
  '',
  'WORKSPACE POLICY (TC-10):',
  '- KHÔNG ghi ngoài workspace path = workspace/research/${missionId}/.',
  '- Live code KHÔNG bao giờ bị sửa — chỉ workspace.',
  '',
  'REGRESSION POLICY (TC-04):',
  '- Nếu fix mới phá tính năng khác → flag regression + re-test bug gốc.',
  '- Bug gốc bị phá → phải sửa lại trước khi pass.',
  '',
  'OUTPUT FORMAT:',
  '## Diagnostic Report',
  '### Root Cause',
  '<one-paragraph root cause hypothesis>',
  '',
  '### Findings',
  '- [F1] <finding text> | evidence: <file:line — excerpt>',
  '- [F2] ...',
  '',
  '### Fix Proposal',
  '<one-paragraph fix proposal — within workspace>',
  '',
  '### Regression Check',
  'PASS / FAIL / REGRESSION',
].join('\n')

// ============================================================
// §3. RUN LISMA REVIEW — main entry point
// ============================================================

/**
 * Run LISMA review (M1: review+fix bug / M2: System Diagnostician root cause).
 *
 * TB-04 §2-§3 + §3.3 Diagnostic Report:
 *  - Gọi callLLM với system prompt LISMA JD.
 *  - M1: review code, tìm bug, fix bug (≤G2_MAX_FIX_ROUNDS=3 vòng → ESCALATE).
 *  - M2: System Diagnostician — root cause từ logs + code, sinh Diagnostic Report
 *    với findings (mỗi finding BẮT BUỘC evidence — TC-06).
 *  - Chấm Rubric A (scoreRubricAWithLlm) cho mỗi root cause hypothesis.
 *  - TC-04: nếu fix gây regression → regressionFound=true, re-test bug gốc.
 *  - TC-06: claim thiếu evidence → filterClaimsWithEvidence loại, gap list trả về.
 *  - KHÔNG auto-apply (DR-C1) — mọi fix nằm workspace.
 *
 * Fail-open: LLM error → diagnosticReport='(LLM unavailable)', escalated=true,
 * escalateReason='LLM unavailable — manual review needed'. KHÔNG crash.
 */
export async function runLismaReview(
  missionId: string,
  taskId: string,
  beliSpec: string,
  codeDrafts: string[],
  missionType: 'M1' | 'M2' | 'M3' = 'M2',
  round = 1,
): Promise<LismaReviewResult> {
  const userPrompt = buildLismaUserPrompt(missionId, taskId, beliSpec, codeDrafts, missionType, round)

  let llm: LLMResult
  try {
    llm = await callLLM(userPrompt, LISMA_SYSTEM_PROMPT, `lisma-review-${missionType.toLowerCase()}`, {
      temperature: 0.2,
      maxTokens: 3000,
      agentId: AGENT_ID.LISMA,
      agentName: 'LISMA (G2 Diagnostician)',
    })
  } catch (err) {
    console.warn(
      '[LISMA] callLLM threw (non-blocking — fail-open):',
      err instanceof Error ? err.message : String(err),
    )
    return failOpenLisma(missionId, taskId, round, `LLM call threw: ${err instanceof Error ? err.message : String(err)}`, missionType)
  }

  if (llm.error || !llm.content || llm.content.trim().length === 0) {
    console.warn('[LISMA] LLM error/empty content — fail-open:', llm.error ?? 'empty content')
    return failOpenLisma(missionId, taskId, round, llm.error ?? 'LLM unavailable — empty content', missionType)
  }

  // Parse Diagnostic Report từ LLM output
  const parsed = parseDiagnosticReport(llm.content)
  const findings = parsed.findings
  const claims = findings.map((f) => f.finding)
  const evidence = parsed.evidence

  // TC-06: filter claims có evidence vs gap (claim thiếu evidence bị loại)
  const { accepted, rejected } = filterClaimsWithEvidence(claims, evidence)
  const acceptedFindings = findings.filter((f) => accepted.includes(f.finding))
  const evidenceGapClaims = rejected

  // TC-04: regression check — FIX (Task 19 audit A#3): parse GIÁ TRỊ section
  // "### Regression Check" thay vì includes('regression') toàn văn — chính
  // system prompt BẮT BUỘC output section header đó nên mọi DR đúng format đều
  // bị flag regressionFound=true (false-positive → mọi review escalated).
  const regressionSection = llm.content.match(
    /###\s*Regression\s*Check\s*\n[\s\S]*?(?=\n###|\n##|$)/i,
  )
  const regressionText = (regressionSection?.[1] || regressionSection?.[0] || '')
    .replace(/^\s*###\s*Regression\s*Check\s*/i, '')
    .trim()
  const isRegressionVerdict =
    /\bREGRESSION\b/i.test(regressionText) ||
    /\bFAIL\b/i.test(regressionText) ||
    /\bbroke\s+(?:existing|the\s+original)\b/i.test(regressionText)
  const regressionFound = isRegressionVerdict

  // Rubric A score cho root cause hypothesis (M2)
  let rubricScore: RubricAResult | undefined
  if (missionType !== 'M1' && parsed.rootCause) {
    try {
      rubricScore = await scoreRubricAWithLlm(
        beliSpec || '(no problem stmt)',
        parsed.rootCause,
        evidence.map((e) => formatEvidenceCitation(e)),
      )
    } catch (err) {
      console.warn(
        '[LISMA] scoreRubricAWithLlm failed (non-blocking):',
        err instanceof Error ? err.message : String(err),
      )
    }
  }

  // Build Diagnostic Report markdown
  const diagnosticReport = buildDiagnosticReport(acceptedFindings, parsed.rootCause, rubricScore)

  // Build worklog entry 8 trường (partial — caller merge)
  const worklog: Partial<WorklogEntry> = {
    mission: missionType as MissionTypeValue,
    status: regressionFound ? 'BLOCKED' : round >= G2_MAX_FIX_ROUNDS ? 'ESCALATED' : 'IN_PROGRESS',
    currentPhase: 'G2',
    overallProgress: round >= G2_MAX_FIX_ROUNDS ? 90 : Math.min(round * 30, 80),
    tlReadBack: regressionFound ? 'PIVOT-NEEDED' : 'NEEDS-REVIEW',
    done: [
      `LISMA round ${round} — ${missionType} review`,
      `Root cause: ${parsed.rootCause ? parsed.rootCause.slice(0, 80) + '...' : '(none)'}`,
      `Findings: ${acceptedFindings.length} accepted, ${evidenceGapClaims.length} gap (TC-06)`,
    ],
    issuesFaced: [
      ...(evidenceGapClaims.length > 0
        ? [`TC-06: ${evidenceGapClaims.length} claims thiếu evidence — bị loại khỏi DR`]
        : []),
      ...(regressionFound ? ['TC-04: regression detected — re-test bug gốc'] : []),
    ],
    suggestionsNextGroup: [
      ...(round >= G2_MAX_FIX_ROUNDS ? ['ESCALATE NEMESIS — trần fix rounds (G2_MAX_FIX_ROUNDS=3)'] : []),
      ...(evidenceGapClaims.length > 0 ? ['Cần bổ sung evidence cho gap claims'] : []),
    ],
    filesChanged: parsed.filesChanged,
  }

  // Concerns cho NEMESIS/TL
  const concerns: string[] = []
  if (evidenceGapClaims.length > 0) {
    concerns.push(`TC-06 evidence gap: ${evidenceGapClaims.length} claims thiếu evidence`)
  }
  if (regressionFound) {
    concerns.push('TC-04 regression: fix mới có thể phá bug gốc — cần re-test')
  }
  if (round >= G2_MAX_FIX_ROUNDS) {
    concerns.push(`Trần fix rounds đạt (${G2_MAX_FIX_ROUNDS}) — ESCALATE NEMESIS`)
  }

  const escalated = round >= G2_MAX_FIX_ROUNDS || regressionFound
  const escalateReason = escalated
    ? regressionFound
      ? 'TC-04 regression detected — manual review needed'
      : `Trần ${G2_MAX_FIX_ROUNDS} fix rounds — ESCALATE NEMESIS (P5)`
    : undefined

  return {
    diagnosticReport,
    worklog,
    evidence,
    concerns,
    regressionFound,
    evidenceGapClaims,
    escalated,
    escalateReason,
    rubricScore,
    round,
  }
}

// ============================================================
// §4. BUILD DIAGNOSTIC REPORT — pure markdown builder
// ============================================================

/**
 * Build Diagnostic Report markdown (TB-04 §3.3):
 *  - Root Cause hypothesis (1 paragraph).
 *  - Findings (mỗi finding kèm evidence citation — TC-06).
 *  - Rubric A score (nếu có).
 *
 * Pure function — không LLM/DB.
 */
export function buildDiagnosticReport(
  findings: WorklogFinding[],
  rootCause: string,
  rubricScore?: RubricAResult,
): string {
  const lines: string[] = []
  lines.push('# Diagnostic Report (TB-04 §3.3)')
  lines.push('')
  lines.push('## Root Cause')
  lines.push(rootCause || '(root cause not identified — manual review needed)')
  lines.push('')
  lines.push('## Findings')
  if (!findings || findings.length === 0) {
    lines.push('(no findings with evidence — TC-06: claims thiếu evidence bị loại)')
  } else {
    for (const f of findings) {
      lines.push(`- [F${f.no || '?'}] ${f.finding}`)
      lines.push(`  - Severity: ${f.severity}`)
      lines.push(`  - Evidence: ${f.evidence || '(no evidence — TC-06 fail)'}`)
      lines.push(`  - Proposal: ${f.proposal || '(no proposal)'}`)
    }
  }
  lines.push('')
  if (rubricScore) {
    lines.push('## Rubric A Score (root cause hypothesis)')
    lines.push(`- D1 Evidence: ${rubricScore.D1}`)
    lines.push(`- D2 Causal: ${rubricScore.D2}`)
    lines.push(`- D3 Consistent: ${rubricScore.D3}`)
    lines.push(`- D4 Reproducible: ${rubricScore.D4}`)
    lines.push(`- D5 Depth: ${rubricScore.D5}`)
    lines.push(`- Total: ${rubricScore.score}`)
    lines.push(`- Grade: ${rubricScore.grade}`)
  } else {
    lines.push('## Rubric A Score')
    lines.push('(not computed — M1 mode or LLM unavailable)')
  }
  lines.push('')
  lines.push('## Workspace Policy (TC-10)')
  lines.push('- Mọi fix nằm trong workspace/research/${missionId}/ — KHÔNG ghi Live.')
  lines.push('- Workspace read-only Live (TC-10 invariant).')

  return lines.join('\n')
}

// ============================================================
// §5. CHECK REGRESSION — TC-04 (heuristic + LLM-assisted optional)
// ============================================================

/**
 * Check regression (TC-04): fix mới có phá tính năng khác không?
 *  - Heuristic: nếu fix mention keywords như "delete", "remove", "rewrite" + bug gốc
 *    mention "feature", "existing" → flag regression.
 *  - LLM-assisted optional (caller có thể truyền pre-computed).
 *
 * Pure heuristic — không LLM call. Caller (runLismaReview) dùng LLM output để
 * set regressionFound field thay vì gọi hàm này.
 */
export async function checkRegression(
  fix: string,
  originalBug: string,
): Promise<{ isRegression: boolean; reason: string }> {
  if (!fix || !originalBug) {
    return { isRegression: false, reason: 'fix hoặc originalBug rỗng — skip check' }
  }

  const fixLower = fix.toLowerCase()
  const bugLower = originalBug.toLowerCase()

  // Heuristic 1: fix xóa/rewrite lớn + bug gốc mention feature
  const destructiveKeywords = ['delete', 'remove', 'rewrite', 'replace', 'refactor']
  const featureKeywords = ['feature', 'existing', 'current', 'working']
  const isDestructive = destructiveKeywords.some((k) => fixLower.includes(k))
  const mentionsFeature = featureKeywords.some((k) => bugLower.includes(k))

  if (isDestructive && mentionsFeature) {
    return {
      isRegression: true,
      reason: 'fix destructive (delete/rewrite) + bug gốc mention feature existing — flag regression (heuristic)',
    }
  }

  // Heuristic 2: fix mention regression explicitly
  if (fixLower.includes('regression') || fixLower.includes('broke existing')) {
    return {
      isRegression: true,
      reason: 'fix output mention "regression" hoặc "broke existing"',
    }
  }

  return { isRegression: false, reason: 'no regression signal detected (heuristic)' }
}

// ============================================================
// §6. INTERNAL HELPERS — prompt builder + parser
// ============================================================

function buildLismaUserPrompt(
  missionId: string,
  taskId: string,
  beliSpec: string,
  codeDrafts: string[],
  missionType: 'M1' | 'M2' | 'M3',
  round: number,
): string {
  const drafts = (codeDrafts || []).filter((c) => typeof c === 'string' && c.trim().length > 0)
  const codeBlock = drafts.length > 0 ? drafts.join('\n\n---\n\n') : '(no code drafts provided)'

  return [
    `# LISMA REVIEW — Mission ${missionId} / Task ${taskId}`,
    `Mission type: ${missionType} | Round: ${round}/${G2_MAX_FIX_ROUNDS}`,
    '',
    '## BELI Spec / Bug description',
    beliSpec || '(no spec provided)',
    '',
    '## Code drafts to review',
    codeBlock,
    '',
    '## Instruction',
    missionType === 'M1'
      ? 'M1 mode: review code → tìm bug → đề xuất fix. Trần 3 vòng → ESCALATE NEMESIS.'
      : 'M2 mode: System Diagnostician — root cause từ logs + code + Diagnostic Report.',
    '',
    'Output theo format Diagnostic Report ở system prompt. MỌI finding PHẢI có evidence (file:line — excerpt).',
  ].join('\n')
}

interface ParsedDiagnosticReport {
  rootCause: string
  findings: WorklogFinding[]
  evidence: EvidenceItem[]
  filesChanged: string[]
  fixProposal: string
}

/**
 * Parse Diagnostic Report từ LLM output (heuristic):
 *  - Section "### Root Cause" → rootCause string.
 *  - Section "### Findings" → findings[] + evidence[].
 *  - Section "### Fix Proposal" → fixProposal string.
 *  - "FILES TOUCHED" / "FILES WRITTEN" → filesChanged[].
 */
function parseDiagnosticReport(content: string): ParsedDiagnosticReport {
  const result: ParsedDiagnosticReport = {
    rootCause: '',
    findings: [],
    evidence: [],
    filesChanged: [],
    fixProposal: '',
  }

  if (!content) return result

  // Root Cause section
  const rootCauseMatch = content.match(/### Root Cause\s*\n([\s\S]*?)(?=\n###|\n##|$)/i)
  if (rootCauseMatch && rootCauseMatch[1]) {
    result.rootCause = rootCauseMatch[1].trim()
  }

  // Findings section
  const findingsMatch = content.match(/### Findings\s*\n([\s\S]*?)(?=\n###|\n##|$)/i)
  if (findingsMatch && findingsMatch[1]) {
    const findingLines = findingsMatch[1].split('\n').filter((l) => l.trim().startsWith('- [F'))
    for (let i = 0; i < findingLines.length; i++) {
      const line = findingLines[i]
      // Parse "- [F1] finding text | evidence: file:line — excerpt"
      const m = line.match(/^-\s*\[F(\d+)\]\s*(.+?)(?:\s*\|\s*evidence:\s*(.+))?$/i)
      if (m) {
        const no = parseInt(m[1], 10) || i + 1
        const finding = (m[2] || '').trim()
        const evidenceStr = (m[3] || '').trim()

        // Parse evidence: file:line — excerpt
        const evParts = evidenceStr.match(/^([^\s:]+):(\d+|[\w-]+)\s*(?:—\s*(.+))?$/)
        if (evParts) {
          result.evidence.push({
            claim: finding,
            file: evParts[1],
            line: evParts[2],
            excerpt: (evParts[3] || '').trim(),
          })
        }

        result.findings.push({
          no,
          finding,
          evidence: evidenceStr || '(no evidence — TC-06 fail)',
          severity: 'MEDIUM', // default — LLM có thể refine
          proposal: '',
        })
      }
    }
  }

  // Fix Proposal section
  const fixMatch = content.match(/### Fix Proposal\s*\n([\s\S]*?)(?=\n###|\n##|$)/i)
  if (fixMatch && fixMatch[1]) {
    result.fixProposal = fixMatch[1].trim()
  }

  // Files touched — heuristic: lines ending with .ts/.js/.py/.md
  const filePattern = /^[\s-]*([A-Za-z0-9_./\-]+\.(?:ts|js|tsx|jsx|py|md|json|txt))$/gm
  let fm
  while ((fm = filePattern.exec(content)) !== null) {
    if (fm[1] && !result.filesChanged.includes(fm[1])) {
      result.filesChanged.push(fm[1])
    }
  }

  return result
}

/**
 * Fail-open LISMA review — LLM unavailable (TB-13 §4).
 * KHÔNG crash pipeline — caller (NEMESIS P5) handle escalate.
 */
function failOpenLisma(
  missionId: string,
  taskId: string,
  round: number,
  reason: string,
  missionType: 'M1' | 'M2' | 'M3' = 'M2',
): LismaReviewResult {
  return {
    diagnosticReport: '(LLM unavailable — Diagnostic Report deferred)',
    worklog: {
      mission: missionType,
      status: 'ESCALATED',
      currentPhase: 'G2',
      overallProgress: Math.min(round * 30, 80),
      tlReadBack: 'NEEDS-REVIEW',
      done: [`LISMA round ${round} — fail-open (LLM unavailable)`],
      issuesFaced: [reason],
      suggestionsNextGroup: ['Manual review needed — LLM unavailable'],
      filesChanged: [],
    },
    evidence: [],
    concerns: [`LLM unavailable — ${reason}`],
    regressionFound: false,
    evidenceGapClaims: [],
    escalated: true,
    escalateReason: 'LLM unavailable — manual review needed',
    round,
  }
}

// ============================================================
// §7. RE-EXPORTS — convenience for caller (rwv-loop, king)
// ============================================================

export {
  validateEvidence,
  filterClaimsWithEvidence,
  formatEvidenceCitation,
  buildEvidenceBackedFindings,
} from './evidence-log'
export type { EvidenceValidation } from './evidence-log'
