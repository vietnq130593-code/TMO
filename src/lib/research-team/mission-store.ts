/**
 * RESEARCH TEAM — MISSION STORE (TB-13 §3 model + TB-02 §7 status flow + DR-C3 append-only)
 * ==============================================================================
 * Spec:
 *  - TB-13 §3 — ResearchMission Prisma model: id/code/title/request/missionType/
 *    tier/status/confidenceJson/decisionLogJson/changelogJson.
 *  - TB-02 §7 — Status flow chính:
 *      CLASSIFY → TRIAGING → DECOMPOSING → RESEARCHING → MONITORING → FINALIZED
 *      (+ branch: ESCALATED, PIVOTED)
 *  - DR-C3 — Append-only: decisionLog + changelog KHÔNG rewrite; mọi thay đổi
 *    push thêm entry.
 *  - IDENTITY_CODE.missionPrefix = 'MS' (constants.ts) → code: MS-YYYYMMDD-NNN.
 *
 * Fail-open: mọi lỗi Prisma throw — caller (API route) catch và trả 500.
 */

import { db } from '@/lib/db'
import { IDENTITY_CODE } from './constants'
import {
  encodeJson,
  decodeMission,
  decodeJsonArray,
} from './types'
import type {
  DecodedResearchMission,
  DecisionLogEntry,
  ChangelogEntry,
  ConfidenceSignals,
} from './types'

// ============================================================
// §1. STATUS FLOW (TB-02 §7 + TB-13 §3)
// ============================================================

/**
 * Trạng thái mission — flow chính TB-02 §7:
 *   CLASSIFY → TRIAGING → DECOMPOSING → RESEARCHING → MONITORING → FINALIZED
 * Branch: ESCALATED (chờ user) · PIVOTED (re-TRIAGE/re-DECOMPOSE).
 *
 * Quy ước: status lưu Prisma là string (TB-13 §3); union dưới đây để type-safe.
 */
export type MissionStatus =
  | 'CLASSIFY'
  | 'TRIAGING'
  | 'DECOMPOSING'
  | 'RESEARCHING'
  | 'MONITORING'
  | 'FINALIZED'
  | 'ESCALATED'
  | 'PIVOTED'
  | (string & {})

/**
 * Bảng transition hợp lệ — KHÔNG cho FINALIZED → RESEARCHING trừ khi qua PIVOTED.
 * Branch ESCALATED có thể quay lại trạng thái trước đó (caller chỉ định).
 */
const VALID_TRANSITIONS: Record<string, string[]> = {
  CLASSIFY: ['TRIAGING', 'ESCALATED', 'PIVOTED'],
  TRIAGING: ['DECOMPOSING', 'ESCALATED', 'PIVOTED', 'FINALIZED'],
  DECOMPOSING: ['RESEARCHING', 'ESCALATED', 'PIVOTED', 'FINALIZED'],
  RESEARCHING: ['MONITORING', 'ESCALATED', 'PIVOTED', 'DECOMPOSING', 'FINALIZED'],
  MONITORING: ['FINALIZED', 'RESEARCHING', 'ESCALATED', 'PIVOTED'],
  FINALIZED: [], // terminal — không có transition ra (trừ khi PIVOTED từ đầu)
  ESCALATED: ['TRIAGING', 'DECOMPOSING', 'RESEARCHING', 'MONITORING', 'FINALIZED', 'PIVOTED'],
  PIVOTED: ['CLASSIFY', 'TRIAGING', 'DECOMPOSING', 'RESEARCHING', 'MONITORING', 'FINALIZED'],
}

export function isValidTransition(from: string, to: string): boolean {
  if (from === to) return true // no-op hợp lệ
  const allowed = VALID_TRANSITIONS[from]
  if (!allowed) return false // trạng thái chưa biết → từ chối
  return allowed.includes(to)
}

// ============================================================
// §2. CREATE MISSION
// ============================================================

export interface CreateMissionParams {
  request: string
  title?: string
  missionType?: 'M1' | 'M2' | 'M3'
  tier?: 'T1' | 'T2' | 'T3'
  confidence: ConfidenceSignals
  initialDecisionLog?: DecisionLogEntry[]
}

/**
 * Tạo mission mới — sinh code MS-YYYYMMDD-NNN (unique):
 *  - Query count rows có code startsWith 'MS-YYYYMMDD-' → +1, pad 3 số.
 *  - Loop nếu trùng (race-condition phòng xa).
 *
 * Status khởi đầu:
 *  - confidence.level === 'LOW' (cần clarification) → 'CLASSIFY' (chờ user trả lời)
 *  - else → 'TRIAGING' (đã classify xong, sẵn sàng DECOMPOSE)
 */
export async function createMission(
  params: CreateMissionParams,
): Promise<DecodedResearchMission> {
  const code = await generateUniqueMissionCode()
  const at = new Date().toISOString()

  // Confidence + Decision Log (initial entry luôn có khi tạo)
  const confidence: ConfidenceSignals = {
    signals: params.confidence.signals || [],
    conflicts: params.confidence.conflicts || [],
    level: params.confidence.level || 'LOW',
  }

  const decisionLog: DecisionLogEntry[] = params.initialDecisionLog
    ? [...params.initialDecisionLog]
    : [
        {
          at,
          agent: 'NEMESIS',
          decision: 'RESEARCH',
          reason: 'Mission created',
        },
      ]

  // Initial status: LOW confidence → CLASSIFY (chờ user); else TRIAGING
  const initialStatus = confidence.level === 'LOW' ? 'CLASSIFY' : 'TRIAGING'

  // tier: LOW confidence → KHÔNG set (chờ user clarify)
  // HIGH/MEDIUM → set từ params.tier (đã qua TRIAGE + floor-rule + tie-break)
  const tier =
    confidence.level === 'LOW' ? '' : params.tier || ''

  const row = await db.researchMission.create({
    data: {
      code,
      title: params.title || '(untitled)',
      request: params.request,
      missionType: params.missionType || 'M2', // default M2 cho TMO app
      tier,
      status: initialStatus,
      confidenceJson: encodeJson(confidence),
      decisionLogJson: encodeJson(decisionLog),
      changelogJson: encodeJson([]),
    },
  })

  return decodeMission(row)
}

/**
 * Sinh MS-YYYYMMDD-NNN unique. Dùng count startsWith + 1, pad 3 số. Loop tối đa
 * 5 lần phòng race-condition (2 request đồng thời có thể cùng count).
 */
async function generateUniqueMissionCode(): Promise<string> {
  const yyyymmdd = formatYyyyMmDd(new Date())
  const prefix = `${IDENTITY_CODE.missionPrefix}-${yyyymmdd}-`

  for (let attempt = 0; attempt < 5; attempt++) {
    const count = await db.researchMission.count({
      where: { code: { startsWith: prefix } },
    })
    const next = count + 1 + attempt // +attempt để tránh trùng nếu race
    const candidate = `${prefix}${String(next).padStart(3, '0')}`

    // Check unique (race-safe)
    const exists = await db.researchMission.findUnique({
      where: { code: candidate },
      select: { id: true },
    })
    if (!exists) return candidate
  }

  // Fallback: dùng timestamp seconds làm NNN — đảm bảo unique
  const ts = Math.floor(Date.now() / 1000) % 100000
  return `${prefix}${String(ts).padStart(5, '0').slice(-3)}`
}

function formatYyyyMmDd(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}${m}${day}`
}

// ============================================================
// §3. GET / LIST MISSIONS
// ============================================================

export async function getMission(id: string): Promise<DecodedResearchMission | null> {
  const row = await db.researchMission.findUnique({ where: { id } })
  return row ? decodeMission(row) : null
}

export interface ListMissionsFilter {
  status?: string
  tier?: string
  limit?: number
  offset?: number
}

export async function listMissions(
  filter?: ListMissionsFilter,
): Promise<DecodedResearchMission[]> {
  const limit = Math.min(Math.max(filter?.limit ?? 50, 1), 200)
  const offset = Math.max(filter?.offset ?? 0, 0)

  const where: Record<string, unknown> = {}
  if (filter?.status) where.status = filter.status
  if (filter?.tier) where.tier = filter.tier

  const rows = await db.researchMission.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: limit,
    skip: offset,
  })

  return rows.map(decodeMission)
}

export async function countMissions(filter?: ListMissionsFilter): Promise<number> {
  const where: Record<string, unknown> = {}
  if (filter?.status) where.status = filter.status
  if (filter?.tier) where.tier = filter.tier
  return db.researchMission.count({ where })
}

// ============================================================
// §4. TRANSITION MISSION (state machine)
// ============================================================

export interface TransitionParams {
  toStatus: string
  decision?: DecisionLogEntry
}

/**
 * Transition mission sang status mới. Validate qua VALID_TRANSITIONS:
 *  - Nếu transition không hợp lệ → throw Error (caller → 400).
 *  - Nếu toStatus === current status → no-op (vẫn ghi decision log nếu có).
 *
 * Append decision vào decisionLogJson (DR-C3 — KHÔNG rewrite).
 */
export async function transitionMission(
  id: string,
  params: TransitionParams,
): Promise<DecodedResearchMission> {
  const row = await db.researchMission.findUnique({ where: { id } })
  if (!row) {
    throw new Error(`transitionMission: mission ${id} không tồn tại`)
  }

  const fromStatus = row.status
  const toStatus = params.toStatus

  if (!isValidTransition(fromStatus, toStatus)) {
    throw new Error(
      `transitionMission: transition ${fromStatus}→${toStatus} không hợp lệ (TB-02 §7)`,
    )
  }

  const decisionLog = decodeJsonArray<DecisionLogEntry>(row.decisionLogJson)
  if (params.decision) {
    decisionLog.push({
      ...params.decision,
      at: params.decision.at || new Date().toISOString(),
    })
  } else {
    // Auto decision log nếu caller không cung cấp
    decisionLog.push({
      at: new Date().toISOString(),
      agent: 'NEMESIS',
      decision: 'CONTINUE',
      reason: `Status transition ${fromStatus}→${toStatus}`,
    })
  }

  const updated = await db.researchMission.update({
    where: { id },
    data: {
      status: toStatus,
      decisionLogJson: encodeJson(decisionLog),
    },
  })

  return decodeMission(updated)
}

// ============================================================
// §5. APPEND-ONLY LOGS (DR-C3)
// ============================================================

export async function appendDecisionLog(
  id: string,
  entry: DecisionLogEntry,
): Promise<DecodedResearchMission> {
  const row = await db.researchMission.findUnique({ where: { id } })
  if (!row) {
    throw new Error(`appendDecisionLog: mission ${id} không tồn tại`)
  }

  const decisionLog = decodeJsonArray<DecisionLogEntry>(row.decisionLogJson)
  decisionLog.push({
    ...entry,
    at: entry.at || new Date().toISOString(),
  })

  const updated = await db.researchMission.update({
    where: { id },
    data: { decisionLogJson: encodeJson(decisionLog) },
  })

  return decodeMission(updated)
}

export async function appendChangelog(
  id: string,
  entry: ChangelogEntry,
): Promise<DecodedResearchMission> {
  const row = await db.researchMission.findUnique({ where: { id } })
  if (!row) {
    throw new Error(`appendChangelog: mission ${id} không tồn tại`)
  }

  const changelog = decodeJsonArray<ChangelogEntry>(row.changelogJson)
  changelog.push({
    ...entry,
    at: entry.at || new Date().toISOString(),
  })

  const updated = await db.researchMission.update({
    where: { id },
    data: { changelogJson: encodeJson(changelog) },
  })

  return decodeMission(updated)
}

// ============================================================
// §6. UPDATE CLARIFICATION (LOW confidence → user answered)
// ============================================================

export interface UpdateClarificationParams {
  missionType: 'M1' | 'M2' | 'M3'
  tier: 'T1' | 'T2' | 'T3'
  confidence: ConfidenceSignals
  decision: DecisionLogEntry
}

/**
 * Update mission sau khi user trả lời clarifyingQuestion (TC-01 path).
 * - Update missionType + tier + confidence
 * - Append decision log (decision='RESEARCH', reason='user clarified mission')
 * - Transition CLASSIFY → TRIAGING (chỉ hợp lệ từ CLASSIFY)
 *
 * Throw nếu mission không tồn tại hoặc không ở CLASSIFY.
 */
export async function updateClarification(
  id: string,
  params: UpdateClarificationParams,
): Promise<DecodedResearchMission> {
  const row = await db.researchMission.findUnique({ where: { id } })
  if (!row) {
    throw new Error(`updateClarification: mission ${id} không tồn tại`)
  }

  if (row.status !== 'CLASSIFY') {
    throw new Error(
      `updateClarification: mission ${id} không ở CLASSIFY (hiện tại: ${row.status})`,
    )
  }

  const at = new Date().toISOString()

  // Append changelog cho 3 field thay đổi (DR-C3)
  const changelog = decodeJsonArray<ChangelogEntry>(row.changelogJson)
  if (row.missionType !== params.missionType) {
    changelog.push({
      at,
      field: 'missionType',
      from: row.missionType,
      to: params.missionType,
      reason: 'user clarified mission',
    })
  }
  if (row.tier !== params.tier) {
    changelog.push({
      at,
      field: 'tier',
      from: row.tier || '(unset)',
      to: params.tier,
      reason: 'user clarified mission',
    })
  }
  changelog.push({
    at,
    field: 'confidence',
    from: row.confidenceJson,
    to: JSON.stringify(params.confidence),
    reason: 'user clarified mission',
  })

  // Append decision log (caller cung cấp hoặc auto)
  const decisionLog = decodeJsonArray<DecisionLogEntry>(row.decisionLogJson)
  decisionLog.push({
    ...params.decision,
    at: params.decision.at || at,
  })

  const updated = await db.researchMission.update({
    where: { id },
    data: {
      missionType: params.missionType,
      tier: params.tier,
      status: 'TRIAGING',
      confidenceJson: encodeJson(params.confidence),
      changelogJson: encodeJson(changelog),
      decisionLogJson: encodeJson(decisionLog),
    },
  })

  return decodeMission(updated)
}
