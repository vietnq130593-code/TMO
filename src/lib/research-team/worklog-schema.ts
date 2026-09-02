/**
 * RESEARCH TEAM — WORKLOG SCHEMA (TB-09 §4.2 — 9 required fields + Confidence 8 trường)
 * =====================================================================================
 * Spec:
 *  - TB-09 §4.2 — Worklog entry 9 trường BẮT BUỘC (types.ts WorklogEntry chuẩn):
 *      1 mission            (M1 | M2 | M3)
 *      2 status              (IN_PROGRESS | COMPLETED | BLOCKED | ESCALATED)
 *      3 currentPhase        (G1 | G2 | G3)
 *      4 overallProgress     (number 0–100)
 *      5 tlReadBack          (VERIFIED | NEEDS-REVIEW | PIVOT-NEEDED)
 *      6 done                (string[])
 *      7 issuesFaced         (string[])
 *      8 suggestionsNextGroup (string[])
 *      9 filesChanged        (string[])
 *
 *    Ghi chú: TB-09 §4.2 liệt kê 8 "logical" fields, nhưng types.ts WorklogEntry
 *    có 9 keys (currentPhase + overallProgress tách rời). File này dùng types.ts
 *    làm chuẩn — match P3 worklog route manual validation style.
 *
 *  - TB-09 §4.2 Confidence — HIGH/MEDIUM/LOW counting:
 *      HIGH:   done.length ≥ 3 AND issuesFaced.length === 0
 *      MEDIUM: issuesFaced.length === 1 (1 conflict, still progressing)
 *      LOW:    issuesFaced.length ≥ 2 (multiple conflicts → pivot risk)
 *
 * Manual validation (zod v4 có trong node_modules nhưng P3 worklog route dùng manual —
 * match style đó, KHÔNG phụ thuộc zod để build).
 *
 * Pure module — KHÔNG side-effect, KHÔNG import db/llm.
 */

import type { WorklogEntry } from './types'

// ============================================================
// §1. REQUIRED FIELDS + ENUMS
// ============================================================

/**
 * 9 trường required (TB-09 §4.2 + types.ts WorklogEntry).
 * WORKLOG_REQUIRED_FIELDS dùng cho: (a) worklog route cross-check, (b) handoff gate,
 * (c) smoke test, (d) P7 E2E assertions.
 */
export const WORKLOG_REQUIRED_FIELDS = [
  'mission',
  'status',
  'currentPhase',
  'overallProgress',
  'tlReadBack',
  'done',
  'issuesFaced',
  'suggestionsNextGroup',
  'filesChanged',
] as const

export const VALID_MISSIONS = ['M1', 'M2', 'M3'] as const
export const VALID_STATUSES = ['IN_PROGRESS', 'COMPLETED', 'BLOCKED', 'ESCALATED'] as const
export const VALID_PHASES = ['G1', 'G2', 'G3'] as const
export const VALID_TL_READBACKS = ['VERIFIED', 'NEEDS-REVIEW', 'PIVOT-NEEDED'] as const

/** Confidence level (TB-09 §4.2) */
export type ConfidenceLevel = 'HIGH' | 'MEDIUM' | 'LOW'

// ============================================================
// §2. VALIDATE WORKLOG ENTRY — pure (manual style match P3 worklog route)
// ============================================================

export interface WorklogValidation {
  valid: boolean
  errors: string[]
  data?: WorklogEntry
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string')
}

/**
 * Validate worklog entry 9 trường required (TB-09 §4.2 — match P3 worklog route).
 * Pure function — không side-effect, không DB.
 *
 * Trả về { valid, errors[], data? }:
 *  - valid=true khi tất cả 9 trường hợp lệ → data populated.
 *  - valid=false khi 1+ trường fail → errors[] liệt kê chi tiết, data undefined.
 *
 * Match P3 worklog route style (manual validation, NOT zod) — SSOT cùng enum.
 */
export function validateWorklogEntry(entry: unknown): WorklogValidation {
  const errors: string[] = []

  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return {
      valid: false,
      errors: ['Entry phải là object (TB-09 §4.2 — 9 trường required)'],
    }
  }

  const e = entry as Record<string, unknown>

  // 1. mission
  if (
    typeof e.mission !== 'string' ||
    !VALID_MISSIONS.includes(e.mission as (typeof VALID_MISSIONS)[number])
  ) {
    errors.push(`entry.mission phải là 1 trong ${VALID_MISSIONS.join('|')}`)
  }

  // 2. status
  if (
    typeof e.status !== 'string' ||
    !VALID_STATUSES.includes(e.status as (typeof VALID_STATUSES)[number])
  ) {
    errors.push(`entry.status phải là 1 trong ${VALID_STATUSES.join('|')}`)
  }

  // 3. currentPhase
  if (
    typeof e.currentPhase !== 'string' ||
    !VALID_PHASES.includes(e.currentPhase as (typeof VALID_PHASES)[number])
  ) {
    errors.push(`entry.currentPhase phải là 1 trong ${VALID_PHASES.join('|')}`)
  }

  // 4. overallProgress (number 0-100)
  if (
    typeof e.overallProgress !== 'number' ||
    !Number.isFinite(e.overallProgress) ||
    e.overallProgress < 0 ||
    e.overallProgress > 100
  ) {
    errors.push('entry.overallProgress phải là số trong [0, 100]')
  }

  // 5. tlReadBack
  if (
    typeof e.tlReadBack !== 'string' ||
    !VALID_TL_READBACKS.includes(e.tlReadBack as (typeof VALID_TL_READBACKS)[number])
  ) {
    errors.push(`entry.tlReadBack phải là 1 trong ${VALID_TL_READBACKS.join('|')}`)
  }

  // 6. done
  if (!isStringArray(e.done)) {
    errors.push('entry.done phải là string[]')
  }

  // 7. issuesFaced
  if (!isStringArray(e.issuesFaced)) {
    errors.push('entry.issuesFaced phải là string[]')
  }

  // 8. suggestionsNextGroup
  if (!isStringArray(e.suggestionsNextGroup)) {
    errors.push('entry.suggestionsNextGroup phải là string[]')
  }

  // 9. filesChanged
  if (!isStringArray(e.filesChanged)) {
    errors.push('entry.filesChanged phải là string[]')
  }

  if (errors.length > 0) {
    return { valid: false, errors }
  }

  // Safe cast — all 9 fields validated above
  return {
    valid: true,
    errors: [],
    data: e as unknown as WorklogEntry,
  }
}

// ============================================================
// §3. CONFIDENCE COUNTING — TB-09 §4.2 (pure)
// ============================================================

/**
 * Compute confidence level từ WorklogEntry (TB-09 §4.2):
 *  - HIGH:   done.length ≥ 3 AND issuesFaced.length === 0
 *  - MEDIUM: issuesFaced.length === 1 (1 conflict, still progressing)
 *  - LOW:    issuesFaced.length ≥ 2 (multiple conflicts → pivot risk)
 *
 * Signals collected (TB-09 §4.2 — "đếm signals + conflicts"):
 *  - +1 signal cho mỗi entry in done[] (non-empty)
 *  - +1 signal cho mỗi finding in findings[] (optional M2 — extra signal)
 *  - +1 conflict cho mỗi entry in issuesFaced[] (non-empty)
 *
 * Pure function — không side-effect.
 */
export function validateConfidence(entry: WorklogEntry): {
  confidence: ConfidenceLevel
  signals: string[]
} {
  const signals: string[] = []

  // Positive signals
  const doneCount = Array.isArray(entry?.done) ? entry.done.filter((d) => typeof d === 'string' && d.trim().length > 0).length : 0
  if (doneCount > 0) {
    signals.push(`done[${doneCount}]`)
  }

  // Findings (M2 optional) — extra positive signal
  const findingsCount = Array.isArray(entry?.findings)
    ? (entry.findings as unknown[]).filter((f) => f && typeof (f as { finding?: unknown }).finding === 'string').length
    : 0
  if (findingsCount > 0) {
    signals.push(`findings[${findingsCount}]`)
  }

  // Confidence (TB-09 §4.2 counting)
  const issuesCount = Array.isArray(entry?.issuesFaced)
    ? entry.issuesFaced.filter((i) => typeof i === 'string' && i.trim().length > 0).length
    : 0

  let confidence: ConfidenceLevel
  if (doneCount >= 3 && issuesCount === 0) {
    confidence = 'HIGH'
  } else if (issuesCount >= 2) {
    confidence = 'LOW'
  } else if (issuesCount === 1) {
    confidence = 'MEDIUM'
  } else {
    // issuesCount === 0 nhưng doneCount < 3 — chưa đủ signal → MEDIUM (still progressing)
    confidence = doneCount > 0 ? 'MEDIUM' : 'LOW'
  }

  // Add conflict signal if any
  if (issuesCount > 0) {
    signals.push(`issues[${issuesCount}]`)
  }

  return { confidence, signals }
}

// ============================================================
// §4. FORMAT WORKLOG ENTRY SUMMARY — pure markdown (caller dùng cho handoff)
// ============================================================

/**
 * Format markdown summary của WorklogEntry (TB-09 §4.2).
 * Pure helper — không side-effect. Caller (handoff.ts) dùng để render handoff summary.
 */
export function formatWorklogSummary(entry: WorklogEntry): string {
  if (!entry) return '(empty worklog)'
  const lines: string[] = []
  lines.push('## Worklog Entry Summary')
  lines.push(`- Mission: ${entry.mission}`)
  lines.push(`- Status: ${entry.status}`)
  lines.push(`- Current Phase: ${entry.currentPhase}`)
  lines.push(`- Overall Progress: ${entry.overallProgress}%`)
  lines.push(`- TL Read-Back: ${entry.tlReadBack}`)
  lines.push('')
  lines.push(`### Done (${entry.done?.length || 0})`)
  for (const d of entry.done || []) lines.push(`- ${d}`)
  lines.push('')
  lines.push(`### Issues Faced (${entry.issuesFaced?.length || 0})`)
  for (const i of entry.issuesFaced || []) lines.push(`- ${i}`)
  lines.push('')
  lines.push(`### Suggestions for Next Group (${entry.suggestionsNextGroup?.length || 0})`)
  for (const s of entry.suggestionsNextGroup || []) lines.push(`- ${s}`)
  lines.push('')
  lines.push(`### Files Changed (${entry.filesChanged?.length || 0})`)
  for (const f of entry.filesChanged || []) lines.push(`- ${f}`)

  // Confidence
  const { confidence, signals } = validateConfidence(entry)
  lines.push('')
  lines.push(`### Confidence: ${confidence}`)
  lines.push(`- Signals: ${signals.length > 0 ? signals.join(', ') : '(none)'}`)

  return lines.join('\n')
}

// ============================================================
// §5. SCHEMA EXPORT — optional (zod v4 in node_modules; not required for build)
// ============================================================
//
// P3 worklog route dùng manual validation (match style). zod schema dưới đây là
// optional helper cho caller nào đã import zod (vd: src/app/api/agents/model-config).
// Lazy import trong caller để tránh phụ thuộc build-time nếu zod bị remove.
//
//   import { z } from 'zod'
//
//   export const WorklogEntrySchema = z.object({
//     mission: z.enum(VALID_MISSIONS),
//     status: z.enum(VALID_STATUSES),
//     currentPhase: z.enum(VALID_PHASES),
//     overallProgress: z.number().min(0).max(100),
//     tlReadBack: z.enum(VALID_TL_READBACKS),
//     done: z.array(z.string()),
//     issuesFaced: z.array(z.string()),
//     suggestionsNextGroup: z.array(z.string()),
//     filesChanged: z.array(z.string()),
//   })
//
// Export types for callers that prefer explicit schema typing:
export type { WorklogEntry }
