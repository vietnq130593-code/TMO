/**
 * RESEARCH TEAM — NEMESIS DECISION LOG (TB-06 §13 Decision Log + D-NNN ID format TB-00 §1.4 + TC-09 PIVOT)
 * ============================================================================================
 * Spec:
 *  - TB-06 §13 — Decision Log: append-only audit trail mọi quyết định NEMESIS (CONTINUE/PIVOT/
 *    ESCALATE/DECOMPOSE/REJECT/RESEARCH/FINALIZE).
 *  - D-NNN format (TB-00 §1.4): D-001, D-002... đếm theo mission (1-based).
 *  - TC-09 (TB-12 §3.2) — PIVOT bắt buộc lý do (non-empty) — recordPivot throw nếu reason empty.
 *  - TB-06 §8.6/8.7 PIVOT — trigger 🔴 (fundamental) → PIVOT về G1; trigger 🟡 (scope creep)
 *    → thu hẹp scope (KHÔNG pivot full). Decision Log ghi rõ trigger.
 *  - DR-C3 — append-only: KHÔNG rewrite, push thêm entry. Tái dùng mission-store.appendDecisionLog.
 *
 * Fail-open: throw khi constraint violated (TC-09 empty reason) — caller catch + 400 graceful.
 */

import { getMission, appendDecisionLog } from '../mission-store'
import { decodeJsonArray } from '../types'
import type {
  DecodedResearchMission,
  DecisionLogEntry,
} from '../types'

// ============================================================
// §1. APPEND DECISION — auto-sinh D-NNN ref (TB-00 §1.4)
// ============================================================

export interface AppendDecisionParams {
  agent?: 'NEMESIS' | 'SIVIL' | 'BELI' | 'LISMA' | 'HAN' | string
  decision:
    | 'CONTINUE'
    | 'PIVOT'
    | 'ESCALATE'
    | 'DECOMPOSE'
    | 'REJECT'
    | 'RESEARCH'
    | 'FINALIZE'
    | string
  reason: string
  /** Ref evidence/trigger — D-NNN auto-sinh nếu thiếu (TB-00 §1.4). */
  ref?: string
}

/**
 * Append DecisionLogEntry vào mission.decisionLogJson (decode → push → encode).
 * Tự sinh D-NNN ref nếu thiếu (D-001, D-002... đếm theo mission — TB-00 §1.4).
 * Tái dùng mission-store.appendDecisionLog (DR-C3 — KHÔNG rewrite).
 *
 * Throw nếu mission không tồn tại (caller API handle 404/500).
 */
export async function appendDecision(
  missionId: string,
  entry: AppendDecisionParams,
): Promise<DecodedResearchMission> {
  const mission = await getMission(missionId)
  if (!mission) {
    throw new Error(`appendDecision: mission ${missionId} không tồn tại`)
  }

  // Auto-sinh D-NNN ref nếu thiếu — đếm theo mission (1-based)
  const existing = mission.decisionLog || []
  const ref = entry.ref && entry.ref.trim().length > 0 ? entry.ref : `D-${String(existing.length + 1).padStart(3, '0')}`

  const newEntry: DecisionLogEntry = {
    at: new Date().toISOString(),
    agent: entry.agent || 'NEMESIS',
    decision: entry.decision,
    reason: entry.reason,
    ref,
  }

  return appendDecisionLog(missionId, newEntry)
}

// ============================================================
// §2. READ DECISION LOG
// ============================================================

/** Get decision log — decode + return entries (DR-C3 — KHÔNG modify). */
export async function getDecisionLog(missionId: string): Promise<DecisionLogEntry[]> {
  const mission = await getMission(missionId)
  if (!mission) return []
  return mission.decisionLog || []
}

/** Filter decisions theo decision type — pure filter. */
export async function findDecisionsByType(
  missionId: string,
  decisionType: string,
): Promise<DecisionLogEntry[]> {
  const all = await getDecisionLog(missionId)
  return all.filter((d) => d.decision === decisionType)
}

// ============================================================
// §3. FORMAT DECISION LINE — pure
// ============================================================

/**
 * Format 1 DecisionLogEntry → 1 dòng text:
 *   `[D-NNN] (timestamp) NEMESIS: DECISION — reason (ref)`
 *
 * Pure function — không side-effect. Caller dùng cho UI/CLI render.
 */
export function formatDecisionLine(entry: DecisionLogEntry): string {
  const at = entry.at || '(no-time)'
  const agent = entry.agent || 'NEMESIS'
  const decision = entry.decision || 'UNKNOWN'
  const reason = entry.reason || '(no reason)'
  const ref = entry.ref ? ` (${entry.ref})` : ''
  return `[${ref.replace(/[()]/g, '') || 'D-???'}] (${at}) ${agent}: ${decision} — ${reason}${ref}`
}

// ============================================================
// §4. TC-09 PIVOT — reason BẮT BUỘC non-empty
// ============================================================

/**
 * TC-09 PIVOT (TB-12 §3.2 + TB-06 §8.6/8.7) — PIVOT bắt buộc lý do:
 *  - reason EMPTY → throw Error (caller catch → 400 'PIVOT reason required (TC-09)').
 *  - trigger 🔴 (fundamental issue — TB-06 §8.6) → PIVOT về G1 (re-DECOMPOSE).
 *  - trigger 🟡 (scope creep — TB-06 §8.7) → thu hẹp scope (KHÔNG pivot full).
 *
 * Ghi decision='PIVOT', reason=non-empty, ref=auto D-NNN.
 * Append-only (DR-C3 — tái dùng appendDecision).
 */
export async function recordPivot(
  missionId: string,
  reason: string,
  trigger: '🔴' | '🟡' | string,
  ref?: string,
): Promise<DecodedResearchMission> {
  const trimmed = (reason || '').trim()
  if (trimmed.length === 0) {
    throw new Error(
      'recordPivot: PIVOT reason BẮT BUỘC non-empty (TC-09 — TB-12 §3.2 + TB-06 §8.6/8.7)',
    )
  }

  // TB-06 §8.6/8.7 — trigger định hướng PIVOT
  const triggerLabel =
    trigger === '🔴'
      ? 'fundamental (§8.6 — PIVOT về G1, re-DECOMPOSE)'
      : trigger === '🟡'
        ? 'scope creep (§8.7 — thu hẹp scope, KHÔNG pivot full)'
        : `(trigger: ${trigger})`

  return appendDecision(missionId, {
    agent: 'NEMESIS',
    decision: 'PIVOT',
    reason: `[PIVOT ${triggerLabel}] ${trimmed}`,
    ref,
  })
}

// ============================================================
// §5. TC-11 REJECT — reason BẮT BUỘC (TB-12 §3.2)
// ============================================================

/**
 * TC-11 REJECTED (TB-12 §3.2) — proposal REJECTED → mission quay về RESEARCHING
 * (KHÔNG FINALIZED, KHÔNG re-submit nguyên trạng). Reason BẮT BUỘC non-empty.
 *
 * Caller (king/engine.kingReject) chịu trách nhiệm transition FINALIZED→RESEARCHING.
 * Hàm này chỉ append decision log (DR-C3).
 */
export async function recordReject(
  missionId: string,
  reason: string,
  ref?: string,
): Promise<DecodedResearchMission> {
  const trimmed = (reason || '').trim()
  if (trimmed.length === 0) {
    throw new Error(
      'recordReject: REJECT reason BẮT BUỘC non-empty (TC-11 — TB-12 §3.2)',
    )
  }

  return appendDecision(missionId, {
    agent: 'NEMESIS',
    decision: 'REJECT',
    reason: `[TC-11 REJECTED] ${trimmed} — quay về RESEARCHING (KHÔNG FINALIZED, KHÔNG re-submit nguyên trạng)`,
    ref,
  })
}

// ============================================================
// §6. RE-EXPORT — types
// ============================================================

export type { DecodedResearchMission, DecisionLogEntry }
export { decodeJsonArray }
