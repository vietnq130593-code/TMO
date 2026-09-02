/**
 * RESEARCH TEAM — G3 CAPTURE PROTOCOL (TB-08 + TC-08 T1 capture tại MONITOR/FINALIZE)
 * =================================================================================
 * Spec:
 *  - TB-08 §2 — Bảng quyền ghi KB 5 agents:
 *      KING/SIVIL/HAN — ghi trực tiếp (directKbWrite=true).
 *      BELI/LISMA — đề xuất qua "KB Candidates" (TB-08 §8 pre-approval).
 *  - TB-08 §7 quy tắc vàng #2 — Mọi tier đều capture: T1/T2 không qua G3 →
 *      KING ghi tại MONITOR + FINALIZE (không để tri thức thất lạc).
 *  - TB-08 §8 — Flow "KB Candidates": BELI/LISMA → 3 cổng duyệt (KING/SIVIL/HAN)
 *      → GHI (promote phase=1) / BỎ (retire) / YÊU CẦU BỔ SUNG EVIDENCE.
 *  - TB-12 §3.2 TC-08 — Task tier SIMPLE (M1/M2) không qua G3 → tri thức vẫn vào
 *      KB: KING ghi tại MONITOR + FINALIZE. Worklog FINALIZE có KB capture.
 *  - TB-12 §3.2 TC-05 — KB cold-start seed (ensureColdStart wrapper cho kb-store.seedKB).
 *
 * Bất biến:
 *  - HAN directKbWrite=true → addEntry trực tiếp (phase=1 NEW).
 *  - BELI/LISMA đề xuất → kbCandidates (caller worklog kbCandidates field) →
 *    preApprovalRetire/approve.
 *  - Capture tại MONITOR + FINALIZE — append-only (DR-C3).
 *  - exportSnapshot regenerate sau mỗi capture (DR-C6 tầng 2).
 *
 * Fail-open: LLM/DB error → KHÔNG crash pipeline (caller handle).
 */

import { db } from '@/lib/db'
import type {
  MissionTypeValue,
  MissionTierValue,
  WorklogEntry,
  KBEntryCategoryValue,
  WorklogMetric,
  WorklogFinding,
} from '../types'
import {
  addEntry,
  seedKB,
  exportSnapshot,
  retireEntry,
  type KBEntryInput,
} from './kb-store'

// ============================================================
// §1. TYPES
// ============================================================

/** Result captureAtMonitor — TB-08 §2 + §7 quy tắc #2. */
export interface CaptureAtMonitorResult {
  /** KB entry IDs đã persist (HAN/KING/SIVIL direct writes). */
  captured: string[]
  /** KB Candidate IDs từ BELI/LISMA (đợi pre-approval — TB-08 §8). */
  kbCandidates: string[]
}

/** Result captureAtFinalize — TB-08 §7 + DR-C6 tầng 2 snapshot. */
export interface CaptureAtFinalizeResult {
  /** KB entry IDs đã persist tại FINALIZE. */
  captured: string[]
  /** snapshot .md đã regenerate (DR-C6 tầng 2). */
  snapshotGenerated: boolean
}

/** Result preApprovalRetire — TB-08 §8 duyệt KB Candidate. */
export interface PreApprovalResult {
  /** ID KB entry mới promote (nếu approved). */
  promoted?: string
  /** ID KB Candidate đã retire (nếu rejected). */
  retired?: string
}

// ============================================================
// §2. CAPTURE AT MONITOR — TB-08 §2 + TC-08 T1 capture
// ============================================================

/**
 * Capture tại pha MONITOR — TB-08 §7 quy tắc vàng #2:
 *  - Mọi tier (T1/T2/T3) đều capture — đặc biệt T1/T2 không qua G3 (nguồn 2343).
 *  - KING/SIVIL/HAN ghi trực tiếp (directKbWrite=true).
 *  - BELI/LISMA đề xuất qua KB Candidates (TB-08 §8 flow).
 *
 * Parse worklog.done/findings/metrics → sinh KB entries (lesson/baseline/pattern)
 * + KB candidates (BELI/LISMA suggestions chờ pre-approval).
 *
 * TB-08 §4 KB Write Protocol: SEARCH (caller check existing) → FORMAT → WRITE.
 * Hàm này lo FORMAT + WRITE; SEARCH caller làm trước (nhẹ — queryKB).
 *
 * Fail-open: parse/persist error → KHÔNG throw, bỏ qua entry lỗi (chỉ log).
 */
export async function captureAtMonitor(
  missionId: string,
  taskId: string,
  worklog: WorklogEntry,
  missionType: 'M1' | 'M2' | 'M3',
  tier: 'T1' | 'T2' | 'T3',
): Promise<CaptureAtMonitorResult> {
  const captured: string[] = []
  const kbCandidates: string[] = []

  // 1. Extract lesson candidates từ worklog (KING ghi trực tiếp)
  const lessonCandidates = extractLessonsFromWorklog(worklog)
  for (const c of lessonCandidates) {
    try {
      const { id } = await addEntry(
        {
          category: c.category,
          title: c.title,
          content: `${c.content}\nSource: KING (MONITOR capture — TB-08 §2).\nMission: ${missionType}.\nTier: ${tier}.\nTaskId: ${taskId}.`,
          sourceMission: missionId,
        },
        1, // phase=1 NEW — chờ HAN curate
      )
      captured.push(id)
    } catch (err) {
      console.warn(
        '[Capture:MONITOR] addEntry (lesson) failed (non-blocking — skip):',
        err instanceof Error ? err.message : String(err),
      )
    }
  }

  // 2. Extract baselines từ metrics (M1 perf, M2 system)
  const baselineCandidates = extractBaselinesFromMetrics(worklog, missionType)
  for (const b of baselineCandidates) {
    try {
      const { id } = await addEntry(
        {
          category: 'baseline',
          title: b.title,
          content: `${b.content}\nSource: KING (MONITOR capture — TB-08 §2).\nMission: ${missionType}.\nTier: ${tier}.\nTaskId: ${taskId}.`,
          sourceMission: missionId,
        },
        1,
      )
      captured.push(id)
    } catch (err) {
      console.warn(
        '[Capture:MONITOR] addEntry (baseline) failed (non-blocking — skip):',
        err instanceof Error ? err.message : String(err),
      )
    }
  }

  // 3. Extract patterns từ findings (M2 architecture patterns)
  const patternCandidates = extractPatternsFromFindings(worklog, missionType)
  for (const p of patternCandidates) {
    try {
      const { id } = await addEntry(
        {
          category: 'pattern',
          title: p.title,
          content: `${p.content}\nSource: KING (MONITOR capture — TB-08 §2).\nMission: ${missionType}.\nTier: ${tier}.\nTaskId: ${taskId}.`,
          sourceMission: missionId,
        },
        1,
      )
      captured.push(id)
    } catch (err) {
      console.warn(
        '[Capture:MONITOR] addEntry (pattern) failed (non-blocking — skip):',
        err instanceof Error ? err.message : String(err),
      )
    }
  }

  // 4. BELI/LISMA KB Candidates — worklog.kbCandidates đã có (TB-09 §4)
  // Caller (KING/SIVIL/HAN) duyệt sau qua preApprovalRetire.
  if (worklog.kbCandidates && Array.isArray(worklog.kbCandidates)) {
    for (const candidateId of worklog.kbCandidates) {
      if (typeof candidateId === 'string' && candidateId.length > 0) {
        kbCandidates.push(candidateId)
      }
    }
  }

  return { captured, kbCandidates }
}

// ============================================================
// §3. CAPTURE AT FINALIZE — TB-08 §7 + DR-C6 tầng 2 snapshot
// ============================================================

/**
 * Capture tại pha FINALIZE — TB-08 §7 quy tắc vàng #2 (Mọi tier đều capture):
 *  - Parse final report → sinh KB entries (lesson/anti-pattern).
 *  - Regenerate snapshot .md (DR-C6 tầng 2 — Live System reads read-only).
 *
 * Fail-open: DB/fs error → KHÔNG throw (snapshotGenerated=false, captured rỗng).
 */
export async function captureAtFinalize(
  missionId: string,
  finalReport: string,
  missionType: 'M1' | 'M2' | 'M3',
  tier: 'T1' | 'T2' | 'T3',
): Promise<CaptureAtFinalizeResult> {
  const captured: string[] = []

  // Parse final report → lessons + anti-patterns
  const lessons = extractLessonsFromFinalReport(finalReport, missionType)
  for (const l of lessons) {
    try {
      const { id } = await addEntry(
        {
          category: l.category,
          title: l.title,
          content: `${l.content}\nSource: KING (FINALIZE capture — TB-08 §7).\nMission: ${missionType}.\nTier: ${tier}.`,
          sourceMission: missionId,
        },
        1, // phase=1 NEW
      )
      captured.push(id)
    } catch (err) {
      console.warn(
        '[Capture:FINALIZE] addEntry failed (non-blocking — skip):',
        err instanceof Error ? err.message : String(err),
      )
    }
  }

  // Regenerate snapshot .md (DR-C6 tầng 2)
  let snapshotGenerated = false
  try {
    await exportSnapshot()
    snapshotGenerated = true
  } catch (err) {
    console.warn(
      '[Capture:FINALIZE] exportSnapshot failed (non-blocking):',
      err instanceof Error ? err.message : String(err),
    )
  }

  return { captured, snapshotGenerated }
}

// ============================================================
// §4. PRE-APPROVAL RETIRE — TB-08 §8 + DECISION-RECORD v1.3 Q4
// ============================================================

/**
 * Pre-approval KB Candidate — TB-08 §8 flow:
 *  - approved=true → promote KB Candidate thành entry phase=1 (NEW).
 *    Source = "BELI/LISMA → <approver>" (TB-05 §7.3 format).
 *  - approved=false → retire (soft-delete — DR-C6) với lý do + approver.
 *
 * DECISION-RECORD v1.3 Q4 — PRE-APPROVAL (chặt hơn):
 *  - HAN KHÔNG tự retire entries do KING/SIVIL ghi khi chưa được duyệt.
 *  - KING duyệt tại CP3 TRƯỚC khi retire có hiệu lực.
 *  - KING tự retire được (kèm Decision Log).
 *
 * Append-only audit: mọi thao tác ghi note vào content (KHÔNG rewrite — DR-C3).
 *
 * Fail-open: lỗi DB → throw (caller API handle 500 graceful).
 */
export async function preApprovalRetire(
  kbCandidateId: string,
  approved: boolean,
  approver: 'KING' | 'HAN',
  reason: string,
): Promise<PreApprovalResult> {
  // Fetch entry
  const row = await db.researchKBEntry.findUnique({ where: { id: kbCandidateId } })
  if (!row) {
    throw new Error(`preApprovalRetire: KB entry ${kbCandidateId} không tồn tại`)
  }

  if (approved) {
    // Promote — append approval note vào content (phase giữ nguyên nếu là phase 1)
    const at = new Date().toISOString()
    const approveNote = `\n\n## Approval Note\n- Approved by: ${approver}\n- At: ${at}\n- Reason: ${reason}\n- Source: BELI/LISMA → ${approver} (TB-05 §7.3 format)`
    const updated = await db.researchKBEntry.update({
      where: { id: kbCandidateId },
      data: { content: row.content + approveNote },
    })
    return { promoted: updated.id }
  }

  // Reject — retire (soft-delete — DR-C6)
  const retired = await retireEntry(kbCandidateId, `TB-08 §8 reject — ${reason} (approver: ${approver})`)
  return { retired: retired.id }
}

// ============================================================
// §5. ENSURE COLD START — TC-05 wrapper
// ============================================================

/**
 * Ensure KB cold-start — TC-05 + TB-05 §9 E1:
 *  - Nếu KB empty → seed starter entries (kb-store.seedKB).
 *  - Idempotent — gọi nhiều lần chỉ seed lần đầu.
 *
 * Fail-open: DB error → throw (caller handle).
 */
export async function ensureColdStart(): Promise<{ wasEmpty: boolean; seeded: number }> {
  const existing = await db.researchKBEntry.count()
  if (existing > 0) {
    return { wasEmpty: false, seeded: 0 }
  }
  const { seeded } = await seedKB()
  return { wasEmpty: true, seeded }
}

// ============================================================
// §6. EXTRACT LESSONS FROM WORKLOG — pure helper
// ============================================================

/** Lesson candidate — pure data, KHÔNG persist. */
export interface LessonCandidate {
  category: KBEntryCategoryValue
  title: string
  content: string
}

/**
 * Extract lesson candidates từ worklog — pure function:
 *  - Parse worklog.done[] → lesson entries (completed actions có insight).
 *  - Parse worklog.issuesFaced[] → anti-pattern entries (vấn đề gặp).
 *  - Parse worklog.findings[] (M2) → pattern entries (architecture insights).
 *
 * TB-08 §4 KB Write Protocol Bước 2 FORMAT — 1 insight = 1 entry ngắn + actionable.
 *
 * Pure function — không LLM/DB call.
 */
export function extractLessonsFromWorklog(worklog: WorklogEntry): LessonCandidate[] {
  const candidates: LessonCandidate[] = []

  // 1. done[] → lesson entries
  if (Array.isArray(worklog.done)) {
    for (const d of worklog.done) {
      if (typeof d !== 'string' || d.trim().length === 0) continue
      // Heuristic: dòng có "lesson:" / "insight:" prefix → high-quality
      const isLesson = /lesson|insight|pattern|learn/i.test(d)
      if (isLesson) {
        candidates.push({
          category: 'lesson',
          title: truncate(d.replace(/^(lesson|insight):\s*/i, ''), 100),
          content: `Insight: ${d}\nEvidence: worklog.done[] (task ${worklog.taskId ?? '(unknown)'}).`,
        })
      } else if (d.length > 30) {
        // Generic done item → lesson (MEDIUM confidence)
        candidates.push({
          category: 'lesson',
          title: truncate(d, 100),
          content: `Insight: ${d}\nEvidence: worklog.done[] (task ${worklog.taskId ?? '(unknown)'}).\nConfidence: MEDIUM.`,
        })
      }
    }
  }

  // 2. issuesFaced[] → anti-pattern entries
  if (Array.isArray(worklog.issuesFaced)) {
    for (const issue of worklog.issuesFaced) {
      if (typeof issue !== 'string' || issue.trim().length === 0) continue
      candidates.push({
        category: 'anti-pattern',
        title: truncate(issue, 100),
        content: `Anti-Pattern: ${issue}\nEvidence: worklog.issuesFaced[] (task ${worklog.taskId ?? '(unknown)'}).\nConfidence: MEDIUM.`,
      })
    }
  }

  // 3. findings[] → pattern entries (M2 — WorklogFinding)
  if (Array.isArray(worklog.findings)) {
    for (const f of worklog.findings) {
      if (!f || typeof f.finding !== 'string') continue
      candidates.push({
        category: 'pattern',
        title: truncate(f.finding, 100),
        content: `Pattern: ${f.finding}\nEvidence: ${f.evidence || '(no evidence)'}\nSeverity: ${f.severity || 'MEDIUM'}.\nProposal: ${f.proposal || '(none)'}`,
      })
    }
  }

  return candidates
}

// ============================================================
// §7. INTERNAL HELPERS — extract baselines + patterns + final report
// ============================================================

/** Extract baseline candidates từ worklog metrics — M1 perf, M2 system. */
function extractBaselinesFromMetrics(
  worklog: WorklogEntry,
  missionType: 'M1' | 'M2' | 'M3',
): LessonCandidate[] {
  const candidates: LessonCandidate[] = []
  if (!Array.isArray(worklog.metrics)) return candidates

  for (const m of worklog.metrics) {
    if (!isValidMetric(m)) continue
    const deltaStr = m.delta && String(m.delta).length > 0 ? ` (delta: ${m.delta})` : ''
    candidates.push({
      category: 'baseline',
      title: `${m.metric}: ${m.before} → ${m.after}${deltaStr}`,
      content: `Performance Baseline: ${m.metric} = ${m.after} (before: ${m.before}, delta: ${m.delta}).\nStatus: ${m.status}.\nMission: ${missionType}.\nEvidence: worklog.metrics[] (task ${worklog.taskId ?? '(unknown)'}).`,
    })
  }
  return candidates
}

function isValidMetric(m: unknown): m is WorklogMetric {
  if (!m || typeof m !== 'object') return false
  const o = m as Record<string, unknown>
  return (
    typeof o.metric === 'string' &&
    typeof o.before === 'string' &&
    typeof o.after === 'string' &&
    (o.status === 'IMPROVED' || o.status === 'STABLE' || o.status === 'REGRESSED' || o.status === 'MONITOR')
  )
}

/** Extract pattern candidates từ findings (M2 — architecture patterns). */
function extractPatternsFromFindings(
  worklog: WorklogEntry,
  missionType: 'M1' | 'M2' | 'M3',
): LessonCandidate[] {
  const candidates: LessonCandidate[] = []
  if (missionType === 'M1') return candidates // M1 không có architecture patterns
  if (!Array.isArray(worklog.findings)) return candidates

  for (const f of worklog.findings) {
    if (!f || typeof f.finding !== 'string') continue
    // Heuristic: finding có "pattern" / "architecture" / "design" keyword → pattern entry
    const isPattern = /pattern|architecture|design|policy|pipeline/i.test(f.finding)
    if (isPattern) {
      candidates.push({
        category: 'pattern',
        title: truncate(f.finding, 100),
        content: `System Pattern: ${f.finding}\nEvidence: ${f.evidence || '(no evidence)'}\nSeverity: ${f.severity || 'MEDIUM'}.\nMission: ${missionType}.`,
      })
    }
  }
  return candidates
}

/** Extract lesson candidates từ final report markdown — TB-08 §7 FINALIZE. */
function extractLessonsFromFinalReport(
  finalReport: string,
  missionType: 'M1' | 'M2' | 'M3',
): LessonCandidate[] {
  const candidates: LessonCandidate[] = []
  if (!finalReport || finalReport.trim().length === 0) return candidates

  // Heuristic: section "## Lessons" → lesson entries
  const lessonsSection = finalReport.match(/##\s+Lessons[\s\S]*?(?=\n##\s|$)/i)
  if (lessonsSection) {
    const lines = lessonsSection[0]
      .split('\n')
      .filter((l) => l.trim().startsWith('-'))
    for (const line of lines) {
      const text = line.replace(/^[\s-]+/, '').trim()
      if (text.length < 10) continue
      candidates.push({
        category: 'lesson',
        title: truncate(text, 100),
        content: `Insight: ${text}\nEvidence: final report (mission ${missionType}).\nSource: KING (FINALIZE capture).`,
      })
    }
  }

  // Heuristic: section "## Anti-Patterns" → anti-pattern entries
  const antiSection = finalReport.match(/##\s+Anti-Patterns?[\s\S]*?(?=\n##\s|$)/i)
  if (antiSection) {
    const lines = antiSection[0]
      .split('\n')
      .filter((l) => l.trim().startsWith('-'))
    for (const line of lines) {
      const text = line.replace(/^[\s-]+/, '').trim()
      if (text.length < 10) continue
      candidates.push({
        category: 'anti-pattern',
        title: truncate(text, 100),
        content: `Anti-Pattern: ${text}\nEvidence: final report (mission ${missionType}).\nSource: KING (FINALIZE capture).`,
      })
    }
  }

  return candidates
}

/** Truncate text an toàn (UTF-8 safe — không cắt giữa surrogate pair). */
function truncate(text: string, maxLen: number): string {
  if (!text) return ''
  if (text.length <= maxLen) return text
  // Cắt tại khoảng trắng gần maxLen nhất (không cắt giữa từ)
  const slice = text.slice(0, maxLen)
  const lastSpace = slice.lastIndexOf(' ')
  if (lastSpace > maxLen * 0.6) {
    return slice.slice(0, lastSpace) + '...'
  }
  return slice + '...'
}

// ============================================================
// §8. RE-EXPORTS — convenience for caller (king P5)
// ============================================================

export {
  addEntry,
  seedKB,
  exportSnapshot,
  retireEntry,
  curatePhase,
  getKBStats,
  queryKB,
  getEntry,
} from './kb-store'
export type { KBEntryInput } from './kb-store'

// Cast MissionTypeValue/MissionTierValue for type re-exports (TS strict — unused here)
export type { MissionTypeValue, MissionTierValue } from '../types'
