/**
 * RESEARCH TEAM — HANDOFF (TB-09 §1.3 handoff protocol + §10 E4 gate TC-14)
 * =====================================================================================
 * Spec:
 *  - TB-09 §1.3 — Handoff protocol giữa groups: G1 → G2 → G3 → KING.
 *    Mỗi handoff cần: (1) artifact map hoàn chỉnh, (2) success criteria met (nếu ASSIGNED),
 *    (3) evidence complete (TC-06 — không gap).
 *  - TB-09 §10 E4 + TB-12 §3.2 TC-14 — Handoff gate: worklog thiếu Artifact Map
 *    → KHÔNG cho group kế nhận. Gate block + persist reason.
 *  - TB-13 §2.1 — Phase gate P6: handoff.ts (this file) implements TC-14.
 *
 * Flow:
 *  1. checkHandoffGate(taskId, fromGroup) — read ResearchWorklog gần nhất của task,
 *     validate 3 conditions:
 *      (a) artifactMapJson không null/empty → validateArtifactMap (g1/artifact-map).
 *      (b) successCriteria met (nếu task đã ASSIGNED — check criterion.met field).
 *      (c) evidence complete (g2/evidence-log.checkEvidenceGap — TC-06 fail-closed).
 *     Trả về HandoffGate { passed, reason }.
 *  2. performHandoff(taskId, fromGroup, toGroup) — gọi checkHandoffGate;
 *     nếu passed=true → update task.assignedGroup=toGroup + persist handoff worklog.
 *     Nếu passed=false → KHÔNG transition, return reason.
 *  3. formatHandoffSummary(gate) — markdown summary (caller API hiển thị).
 *
 * Fail-open: DB error → checkHandoffGate trả passed=false với reason DB-fail
 * (không crash pipeline; caller API handle 200 với passed=false).
 */

import { db } from '@/lib/db'
import { encodeJson, decodeJsonArray, decodeJsonObject, decodeWorklog } from './types'
import type { DecodedResearchWorklog, SuccessCriterion, WorklogEntry } from './types'
import { validateArtifactMap } from './g1/artifact-map'
import { checkEvidenceGap } from './g2/evidence-log'

// ============================================================
// §1. TYPES — HandoffGate
// ============================================================

export type ResearchGroup = 'G1' | 'G2' | 'G3'
export type HandoffTarget = ResearchGroup | 'KING'

export interface HandoffGate {
  taskId: string
  fromGroup: ResearchGroup
  toGroup: HandoffTarget
  /** Worklog ID gần nhất của task (một task có thể có nhiều worklog qua vòng lặp). */
  worklogId: string | null
  /** Artifact Map đã build trong worklog (g1/artifact-map — TC-14 gate E4). */
  artifactMapPresent: boolean
  /** Success Criteria met (nếu task đã ASSIGNED — mỗi criterion có field `met?`). */
  successCriteriaMet: boolean
  /** Evidence complete (TC-06 — không gap claims). */
  evidenceComplete: boolean
  /** passed = true khi cả 3 conditions OK. */
  passed: boolean
  /** Reason nếu passed=false (caller API hiển thị cho user/SIVIL). */
  reason?: string
}

// ============================================================
// §2. CHECK HANDOFF GATE — TC-14 (TB-09 §10 E4)
// ============================================================

/**
 * Check handoff gate TC-14 — TB-09 §10 E4 + §1.3:
 *  - Read ResearchWorklog gần nhất của task (orderBy createdAt desc, take 1).
 *  - Validate 3 conditions:
 *      (1) artifactMapPresent: artifactMapJson không null/empty + validateArtifactMap ok.
 *      (2) successCriteriaMet: nếu task đã ASSIGNED, mỗi criterion phải có met=true.
 *          Nếu task DRAFT/ chưa ASSIGNED → successCriteriaMet=true (gate TC-13 bắt buộc trước).
 *      (3) evidenceComplete: checkEvidenceGap trả hasGap=false (TC-06).
 *
 * passed = (1) && (2) && (3)
 *
 * Fail-open: DB error → passed=false với reason 'DB error' (không crash caller).
 */
export async function checkHandoffGate(
  taskId: string,
  fromGroup: ResearchGroup,
  toGroup: HandoffTarget = 'KING',
): Promise<HandoffGate> {
  const gate: HandoffGate = {
    taskId,
    fromGroup,
    toGroup,
    worklogId: null,
    artifactMapPresent: false,
    successCriteriaMet: false,
    evidenceComplete: false,
    passed: false,
  }

  try {
    // 1. Read ResearchWorklog gần nhất của task
    const latest = await db.researchWorklog.findFirst({
      where: { taskId },
      orderBy: { createdAt: 'desc' },
    })

    if (!latest) {
      gate.reason = `Handoff blocked (TC-14): no worklog found for task ${taskId} — SIVIL phải tạo worklog trước khi handoff.`
      return gate
    }

    gate.worklogId = latest.id
    const decoded = decodeWorklog(latest)

    // 2. (a) Artifact Map present + valid (TC-14 gate E4)
    const mapValidation = validateArtifactMap(
      decoded.artifactMap as Parameters<typeof validateArtifactMap>[0],
    )
    gate.artifactMapPresent = mapValidation.valid
    if (!mapValidation.valid) {
      gate.reason = `Artifact Map missing — handoff blocked (TC-14): ${mapValidation.reason || 'map null/empty'}`
      // Continue checking other conditions but mark not passed
    }

    // 3. (b) Success Criteria met — check task.status + criteria[]
    const task = await db.researchTask.findUnique({
      where: { id: taskId },
      select: { status: true, successCriteriaJson: true },
    })

    if (!task) {
      gate.reason = `Handoff blocked (TC-14): task ${taskId} không tồn tại`
      return gate
    }

    // If task ASSIGNED → check every criterion has met=true
    if (task.status === 'ASSIGNED') {
      const criteria = decodeJsonArray<SuccessCriterion>(task.successCriteriaJson)
      if (criteria.length === 0) {
        // No success criteria — TC-13 would have blocked at ASSIGN; safe to pass here
        gate.successCriteriaMet = true
      } else {
        gate.successCriteriaMet = criteria.every((c) => c.met === true)
        if (!gate.successCriteriaMet && !gate.reason) {
          const unmet = criteria.filter((c) => c.met !== true).map((c) => c.id || c.criterion.slice(0, 30))
          gate.reason = `Handoff blocked (TC-14): success criteria chưa met — ${unmet.join(', ')}`
        }
      }
    } else {
      // DRAFT / not yet ASSIGNED → TC-13 gate has not run; skip criterion check
      gate.successCriteriaMet = true
    }

    // 4. (c) Evidence complete (TC-06 — no gap)
    const gapCheck = await checkEvidenceGap(latest.id)
    gate.evidenceComplete = !gapCheck.hasGap
    if (!gate.evidenceComplete && !gate.reason) {
      gate.reason = `Handoff blocked (TC-14): evidence gap (TC-06) — ${gapCheck.gapClaims.length} claim(s) thiếu evidence: ${gapCheck.gapClaims.slice(0, 3).join('; ')}`
    }

    // 5. Final passed
    gate.passed = gate.artifactMapPresent && gate.successCriteriaMet && gate.evidenceComplete
    if (gate.passed) {
      gate.reason = undefined
    }

    return gate
  } catch (err) {
    console.error(
      '[Handoff] checkHandoffGate failed (non-blocking):',
      err instanceof Error ? err.message : String(err),
    )
    gate.reason = `Handoff blocked (TC-14): DB error — ${err instanceof Error ? err.message : String(err)}`
    return gate
  }
}

// ============================================================
// §3. PERFORM HANDOFF — transition assignedGroup + persist handoff worklog
// ============================================================

export interface HandoffResult {
  handoff: HandoffGate
  /** true khi transition đã apply (task.assignedGroup=toGroup). */
  transitioned: boolean
}

/**
 * Perform handoff — TB-09 §1.3:
 *  1. checkHandoffGate(taskId, fromGroup, toGroup).
 *  2. Nếu passed=true:
 *     - Update task.assignedGroup=toGroup (status='ASSIGNED' nếu trước đó DRAFT).
 *     - Persist handoff ResearchWorklog (phase='VERIFY' hoặc 'FINALIZE' với handoff info).
 *  3. Nếu passed=false → KHÔNG transition, return reason.
 *
 * Fail-open: DB error → transitioned=false, reason trong handoff (không crash caller).
 */
export async function performHandoff(
  taskId: string,
  fromGroup: ResearchGroup,
  toGroup: HandoffTarget,
): Promise<HandoffResult> {
  const handoff = await checkHandoffGate(taskId, fromGroup, toGroup)

  if (!handoff.passed) {
    return { handoff, transitioned: false }
  }

  try {
    // Read task for context
    const task = await db.researchTask.findUnique({
      where: { id: taskId },
      select: { id: true, missionId: true, status: true, assignedGroup: true },
    })
    if (!task) {
      handoff.passed = false
      handoff.reason = `Handoff failed: task ${taskId} không tồn tại`
      return { handoff, transitioned: false }
    }

    // Update task.assignedGroup=toGroup (status='ASSIGNED' if currently DRAFT)
    const newStatus = task.status === 'DRAFT' ? 'ASSIGNED' : task.status
    await db.researchTask.update({
      where: { id: taskId },
      data: {
        assignedGroup: toGroup === 'KING' ? null : toGroup, // KING = no group,finalize
        status: newStatus,
      },
    })

    // Persist handoff ResearchWorklog entry (phase='VERIFY' khi G1→G2/G2→G3;
    // phase='FINALIZE' khi →KING)
    const phase = toGroup === 'KING' ? 'FINALIZE' : 'VERIFY'
    const handoffEntry: WorklogEntry = {
      mission: 'M2', // Handoff entry — caller (engine) biết mission type; safe default M2
      status: 'COMPLETED',
      currentPhase: toGroup === 'KING' ? 'G3' : (toGroup as 'G1' | 'G2' | 'G3'),
      overallProgress: 100,
      tlReadBack: 'VERIFIED',
      done: [
        `Handoff ${fromGroup} → ${toGroup} PASSED (TC-14)`,
        `Task ${taskId} assignedGroup updated to ${toGroup === 'KING' ? '(null — finalize)' : toGroup}`,
      ],
      issuesFaced: [],
      suggestionsNextGroup: [],
      filesChanged: [],
      taskId,
      header: `[${new Date().toISOString()}] — [${fromGroup}] — [${taskId}] Handoff → ${toGroup}`,
    }

    try {
      await db.researchWorklog.create({
        data: {
          taskId,
          missionId: task.missionId,
          phase,
          entryJson: encodeJson({
            ...handoffEntry,
            handoffGate: {
              fromGroup,
              toGroup,
              worklogId: handoff.worklogId,
              artifactMapPresent: handoff.artifactMapPresent,
              successCriteriaMet: handoff.successCriteriaMet,
              evidenceComplete: handoff.evidenceComplete,
            },
          }),
        },
      })
    } catch (err) {
      // Persist worklog fail-open — handoff itself succeeded (task updated)
      console.warn(
        '[Handoff] persist handoff worklog failed (non-blocking — transition succeeded):',
        err instanceof Error ? err.message : String(err),
      )
    }

    return { handoff, transitioned: true }
  } catch (err) {
    console.error(
      '[Handoff] performHandoff transition failed:',
      err instanceof Error ? err.message : String(err),
    )
    handoff.passed = false
    handoff.reason = `Handoff transition DB error: ${err instanceof Error ? err.message : String(err)}`
    return { handoff, transitioned: false }
  }
}

// ============================================================
// §4. FORMAT HANDOFF SUMMARY — pure markdown (caller API display)
// ============================================================

/**
 * Format markdown summary của HandoffGate (caller API display / handoff receipt).
 * Pure function — không side-effect.
 */
export function formatHandoffSummary(gate: HandoffGate): string {
  if (!gate) return '(no handoff)'
  const lines: string[] = []
  lines.push('## Handoff Gate (TC-14 — TB-09 §10 E4)')
  lines.push(`- Task: ${gate.taskId}`)
  lines.push(`- From Group: ${gate.fromGroup}`)
  lines.push(`- To Group: ${gate.toGroup}`)
  lines.push(`- Latest Worklog: ${gate.worklogId || '(none)'}`)
  lines.push('')
  lines.push('### Conditions')
  lines.push(`- Artifact Map Present: ${gate.artifactMapPresent ? '✅' : '❌'}`)
  lines.push(`- Success Criteria Met: ${gate.successCriteriaMet ? '✅' : '❌'}`)
  lines.push(`- Evidence Complete (TC-06): ${gate.evidenceComplete ? '✅' : '❌'}`)
  lines.push('')
  lines.push(`### Result: ${gate.passed ? '✅ PASSED' : '❌ BLOCKED'}`)
  if (gate.reason) {
    lines.push(`> ${gate.reason}`)
  }
  return lines.join('\n')
}

// ============================================================
// §5. HELPERS — get latest worklog (caller dùng cho API display)
// ============================================================

/**
 * Get latest worklog of a task — caller API hiển thị worklog gần nhất + handoff context.
 * Fail-open: DB error → null.
 */
export async function getLatestWorklog(
  taskId: string,
): Promise<DecodedResearchWorklog | null> {
  try {
    const row = await db.researchWorklog.findFirst({
      where: { taskId },
      orderBy: { createdAt: 'desc' },
    })
    return row ? decodeWorklog(row) : null
  } catch (err) {
    console.warn(
      '[Handoff] getLatestWorklog failed (non-blocking):',
      err instanceof Error ? err.message : String(err),
    )
    return null
  }
}

// Re-export for caller convenience
export { decodeJsonObject as _decodeJsonObject }
