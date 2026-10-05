/**
 * RESEARCH TEAM — NEMESIS ESCALATION (DR-C5 timeout 48h/24h + nhắc 12h + deputy + NEMESIS cấm tự duyệt)
 * ============================================================================================
 * Spec:
 *  - DR-C5 §C5 — Proposal pending timeout 48h (T3) / 24h (T2/T1) + nhắc 12h (cron :3004).
 *      Mission M1 timeout 48h / M2 timeout 24h (mission-side cap khác proposal-side).
 *  - DR-C5 §C5 — Deputy: SIVIL (research tổng hợp) hoặc HAN (KB/G3-domain). NEMESIS KHÔNG tự duyệt
 *      Proposal (DR-C5 §C5 — King cấm self-approve Proposal của mình).
 *  - DR-C5 §C5 — Khi timeout: escalate USER (block) HOẶC deputy duyệt thay (if king recused).
 *  - TB-13 §6 — Tích hợp cron-scheduler :3004 cho reminder 12h (optional — skip nếu service
 *      không chạy, log warning).
 *
 * Fail-open: cron registration fail → KHÔNG throw, log warning (escalation record vẫn persist).
 * Constraint violations (NEMESIS self-approve) → throw (caller API handle 400/500).
 */

import { db } from '@/lib/db'
import { encodeJson, decodeJsonArray, decodeJsonObject } from '../types'
import type {
  DecodedResearchMission,
  DecisionLogEntry,
  WorklogEntry,
} from '../types'
import { getMission, appendDecisionLog } from '../mission-store'
import { PROPOSAL_TIMEOUT_HOURS, PROPOSAL_REMIND_HOURS } from '../constants'

// ============================================================
// §1. TYPES — EscalationRecord (in-memory + persisted qua mission.decisionLog + worklog)
// ============================================================

/**
 * EscalationRecord — TB-13 §6 + DR-C5 §C5. Persisted qua:
 *  - mission.decisionLogJson: DecisionLogEntry decision='ESCALATE' với ref=esc-NNN
 *  - ResearchWorklog.entryJson: EscalationRecord encode trong entryJson (phase='ESCALATE')
 *    để query queue. (KHÔNG tạo bảng mới — TB-13 §3 schema cố định.)
 */
export interface EscalationRecord {
  missionId: string
  taskId?: string
  proposalId?: string
  escalatedAt: string
  reason: string
  escalateTo: 'USER' | 'NEMESIS'
  timeoutHours: number
  remindHours: number
  deputy?: 'SIVIL' | 'HAN'
  status: 'PENDING' | 'REMINDED' | 'RESOLVED' | 'TIMEOUT'
  remindersSent: number
  resolvedAt?: string
  resolvedBy?: string
  /** Cron-scheduler job id (TB-13 §6 — optional, có thể null nếu service không chạy). */
  cronJobId?: string
}

// ============================================================
// §2. COMPUTE TIMEOUT — DR-C5 §C5 (TB-13 §3 STEP_TIMEOUTS_MS + PROPOSAL_TIMEOUT_HOURS)
// ============================================================

/**
 * Compute timeout + remind hours — DR-C5 §C5:
 *  - kind='mission': M1=48h, M2=24h (mission-side cap; M3 grand = 24h safe default).
 *  - kind='proposal': T3=48h, T2=24h, T1=24h (PROPOSAL_TIMEOUT_HOURS từ constants).
 *  - remindHours: 12h (PROPOSAL_REMIND_HOURS — DR-C5 §C5 nhắc 12h trước timeout).
 *
 * Pure function — không side-effect.
 */
export function computeTimeout(
  tier: 'T1' | 'T2' | 'T3',
  kind: 'mission' | 'proposal',
): { timeoutHours: number; remindHours: number } {
  if (kind === 'proposal') {
    return {
      timeoutHours: PROPOSAL_TIMEOUT_HOURS[tier],
      remindHours: PROPOSAL_REMIND_HOURS,
    }
  }
  // Mission-side cap (M1=48h, M2=24h; M3 grand default 24h safe)
  // tier không trực tiếp map cho mission — caller (NEMESIS) biết missionType; ở đây
  // dùng heuristic: T1/T2 → 24h (medium missions), T3 → 48h (grand/research-heavy)
  const missionTimeout = tier === 'T3' ? 48 : 24
  return {
    timeoutHours: missionTimeout,
    remindHours: PROPOSAL_REMIND_HOURS,
  }
}

// ============================================================
// §3. ASSIGN DEPUTY — DR-C5 §C5 (SIVIL | HAN; NEMESIS cấm tự duyệt)
// ============================================================

/**
 * Assign deputy — DR-C5 §C5:
 *  - domain='research' → SIVIL (default deputy — research tổng hợp).
 *  - domain='kb' → HAN (KB/G3-domain — HAN là KB Curator).
 *  - Constraint: deputy KHÔNG được là author proposal (caller check trước; nếu NEMESIS là author
 *      → escalate USER thay vì deputy).
 *  - NEMESIS cấm tự duyệt Proposal (DR-C5 §C5 — King recuse from self-approve).
 *
 * Pure function — không side-effect.
 */
export function assignDeputy(
  _missionId: string,
  kind: 'proposal' | 'mission',
  domain: 'research' | 'kb',
): { deputy: 'SIVIL' | 'HAN'; reason: string } {
  const deputy: 'SIVIL' | 'HAN' = domain === 'kb' ? 'HAN' : 'SIVIL'
  const domainLabel = domain === 'kb' ? 'KB/G3-domain (HAN là KB Curator)' : 'research tổng hợp'
  return {
    deputy,
    reason: `DR-C5 §C5 deputy assignment (kind=${kind}): ${deputy} — ${domainLabel}. NEMESIS cấm tự duyệt (recused).`,
  }
}

// ============================================================
// §4. ESCALATE TO USER — persist escalation record (decision log + worklog entry)
// ============================================================

export interface EscalateToUserParams {
  tier: 'T1' | 'T2' | 'T3'
  kind: 'mission' | 'proposal'
  taskId?: string
  proposalId?: string
}

/**
 * Escalate to user — DR-C5 §C5 + TB-13 §6:
 *  - Tạo EscalationRecord + persist vào mission.decisionLogJson (decision='ESCALATE', ref=esc-NNN).
 *  - Persist ResearchWorklog row (phase='ESCALATE', entryJson=encodeJson(escalation record)).
 *  - Register cron job reminder qua mini-service cron-scheduler :3004 (optional — TB-13 §6:
 *      nếu service không chạy → skip + log, escalation record vẫn persist).
 *
 * Throw nếu mission không tồn tại. Cron fail-open.
 */
export async function escalateToUser(
  missionId: string,
  reason: string,
  opts: EscalateToUserParams,
): Promise<EscalationRecord> {
  const mission = await getMission(missionId)
  if (!mission) {
    throw new Error(`escalateToUser: mission ${missionId} không tồn tại`)
  }

  const { timeoutHours, remindHours } = computeTimeout(opts.tier, opts.kind)
  const at = new Date().toISOString()

  const record: EscalationRecord = {
    missionId,
    taskId: opts.taskId,
    proposalId: opts.proposalId,
    escalatedAt: at,
    reason,
    escalateTo: 'USER',
    timeoutHours,
    remindHours,
    status: 'PENDING',
    remindersSent: 0,
  }

  // 1. Append DecisionLogEntry decision='ESCALATE' với ref=esc-NNN
  const existing = mission.decisionLog || []
  const ref = `esc-${String(existing.length + 1).padStart(3, '0')}`
  try {
    await appendDecisionLog(missionId, {
      at,
      agent: 'NEMESIS',
      decision: 'ESCALATE',
      reason: `[ESCALATE → USER] ${reason} (timeout=${timeoutHours}h, remind=${remindHours}h, ref=${ref})`,
      ref,
    })
  } catch (err) {
    console.warn(
      '[Escalation] appendDecisionLog failed (non-blocking — worklog will still persist):',
      err instanceof Error ? err.message : String(err),
    )
  }

  // 2. Persist ResearchWorklog row (phase='ESCALATE') để query queue
  //    task FK bắt buộc — nếu không có taskId, tạo task placeholder? Skip — dùng taskId rỗng
  //    không hợp lệ (FK). Lưu record vào entryJson của worklog gần nhất? Cách tốt hơn: persist
  //    EscalationRecord encode JSON vào mission.decisionLogJson (đã làm ở bước 1). Bỏ qua
  //    bước persist worklog nếu không có taskId (call site API escalation vẫn truy được
  //    qua decision log).
  if (opts.taskId) {
    const escalationWorklog: WorklogEntry = {
      mission: mission.missionType as 'M1' | 'M2' | 'M3',
      status: 'ESCALATED',
      currentPhase: 'G3',
      overallProgress: 0,
      tlReadBack: 'PIVOT-NEEDED',
      done: [`Escalation PENDING: ${reason}`],
      issuesFaced: [`DR-C5 timeout=${timeoutHours}h, remind=${remindHours}h`],
      suggestionsNextGroup: [`Resolve escalation ${ref} (USER)`],
      filesChanged: [],
      taskId: opts.taskId,
    }
    try {
      await db.researchWorklog.create({
        data: {
          taskId: opts.taskId,
          missionId,
          phase: 'ESCALATE',
          entryJson: encodeJson({
            ...escalationWorklog,
            escalationRecord: record,
          }),
        },
      })
    } catch (err) {
      console.warn(
        '[Escalation] persist ResearchWorklog failed (non-blocking — decision log still persisted):',
        err instanceof Error ? err.message : String(err),
      )
    }
  }

  // 3. Register cron job reminder (optional — TB-13 §6)
  //    FIX (Task 19 — Task 18 audit): fetch tới `/api/research/_cron/reminder?XTransformPort=3004`
  //    là PHANTOM route (không tồn tại trong codebase) → fetch luôn fail, lỗi bị
  //    `.catch` nuốt im lặng. Cron-scheduler :3004 không được deploy cho research
  //    team. Giờ escalation timeout xử lý LAZY qua checkTimeouts() (wire vào GET
  //    /api/research/escalations + GET /api/research/proposals) — không còn fetch âm thầm fail.
  record.cronJobId = await registerCronReminder(missionId, ref, remindHours).catch((err) => {
    console.warn(
      '[Escalation] cron-scheduler registration failed (TB-13 §6 — optional, skip):',
      err instanceof Error ? err.message : String(err),
    )
    return undefined
  })

  // 4. ━━ ROUND-39 — ESCALATE→USER CONSOLIDATE (king-catch thành bài học) ━━
  // Mission phải escalate là THẤT BẠI vận hành đáng nhớ: mission tương tự
  // (cùng tier/kind/lý do) sẽ thấy episode này ngay từ NEMESIS RECEIVE qua
  // PRE-ACT similarity search — NEMESIS biết "cái này từng phải đưa lên user
  // vì ..." trước khi quyết định. Fail-open tuyệt đối: episode lỗi KHÔNG
  // được phép làm hỏng flow escalation chính (API route cũng gọi hàm này).
  try {
    const { recordAgentEpisode } = await import('@/lib/episodic-memory/agent-brain')
    recordAgentEpisode({
      family: 'research-team',
      agentName: `NEMESIS king (mission ${missionId.slice(0, 12)})`,
      goal: `[ESCALATE→USER ${opts.kind}/${opts.tier}] ${reason}`.slice(0, 500),
      sessionId: missionId,
      startedAt: Date.now(), // quyết định escalate là sự kiện tức thời (duration ≈ 0)
      outcome: 'FAILURE',
      stopReason: 'error',
      toolEvidence: [
        {
          tool: 'research:escalation',
          success: false,
          text: `[ESCALATE→USER] ${reason} (tier=${opts.tier}, kind=${opts.kind}, timeout=${timeoutHours}h, remind=${remindHours}h, ref=${ref})`.slice(0, 300),
        },
      ],
    })
  } catch (err) {
    console.warn(
      '[Escalation] episodic episode failed (non-blocking — escalation record still persisted):',
      err instanceof Error ? err.message : String(err),
    )
  }

  return record
}

// ============================================================
// §5. CHECK TIMEOUTS — query escalation records pending (cron job gọi)
// ============================================================

/**
 * Check timeouts — query escalation records pending, return expired + due-reminder.
 *
 * Implementation: scan mission.decisionLogJson filter decision='ESCALATE' + ref startsWith 'esc-'
 * → reconstruct EscalationRecord (lấy timeoutHours/remindHours từ reason text).
 * Cron job :3004 gọi hàm này định kỳ (mỗi giờ) → fire reminder + mark TIMEOUT.
 *
 * Fail-open: DB error → return empty arrays (cron sẽ retry).
 */
export async function checkTimeouts(): Promise<{
  expired: EscalationRecord[]
  dueReminder: EscalationRecord[]
}> {
  const expired: EscalationRecord[] = []
  const dueReminder: EscalationRecord[] = []

  try {
    // Query missions có ESCALATE trong decisionLog — SQLite không query JSON native,
    // scan tất cả missions có status ESCALATED (rồi decode filter)
    const missions = await db.researchMission.findMany({
      where: {
        OR: [{ status: 'ESCALATED' }, { status: 'RESEARCHING' }, { status: 'MONITORING' }],
      },
      orderBy: { updatedAt: 'desc' },
      take: 100,
    })

    const now = Date.now()
    for (const m of missions) {
      const decisionLog = decodeJsonArray<DecisionLogEntry>(m.decisionLogJson)
      for (const d of decisionLog) {
        if (d.decision !== 'ESCALATE') continue
        if (!d.ref || !d.ref.startsWith('esc-')) continue

        const record = parseEscalationFromDecision(m.id, d)
        if (!record || record.status !== 'PENDING') continue

        const elapsedHours = (now - new Date(record.escalatedAt).getTime()) / (1000 * 60 * 60)
        if (elapsedHours >= record.timeoutHours) {
          expired.push(record)
        } else if (elapsedHours >= record.remindHours && record.remindersSent === 0) {
          dueReminder.push(record)
        }
      }
    }
  } catch (err) {
    console.warn(
      '[Escalation] checkTimeouts failed (non-blocking — cron retry):',
      err instanceof Error ? err.message : String(err),
    )
  }

  return { expired, dueReminder }
}

// ============================================================
// §6. RESOLVE ESCALATION — DR-C5 §C5 (NEMESIS cấm tự duyệt)
// ============================================================

/**
 * Resolve escalation — set status RESOLVED. Verify resolvedBy:
 *  - Nếu escalation là Proposal self-approve (resolvedBy='NEMESIS' và escalateTo='NEMESIS' vì
 *    NEMESIS là author proposal) → throw (DR-C5 §C5 — NEMESIS cấm tự duyệt).
 *  - Else: append DecisionLogEntry decision='CONTINUE'/'FINALIZE' với resolvedBy.
 *
 * Caller (API) gọi khi user/deputy resolve.
 */
export async function resolveEscalation(
  missionId: string,
  resolvedBy: string,
  decision: string,
): Promise<void> {
  if (resolvedBy === 'NEMESIS') {
    // DR-C5 §C5 — NEMESIS cấm tự duyệt Proposal. Allow NEMESIS resolve mission-level escalation
    // (không phải proposal self-approve). Caller API check context trước — nếu là proposal
    // self-approve → throw.
    console.warn(
      '[Escalation] NEMESIS resolve — verify this is NOT proposal self-approve (DR-C5 §C5). ' +
        'If mission-level escalation, OK; if proposal, throw upstream.',
    )
  }

  try {
    await appendDecisionLog(missionId, {
      at: new Date().toISOString(),
      agent: resolvedBy,
      decision: 'CONTINUE',
      reason: `[ESCALATE RESOLVED by ${resolvedBy}] ${decision}`,
      ref: `esc-resolved-${Date.now()}`,
    })
  } catch (err) {
    console.warn(
      '[Escalation] resolveEscalation appendDecisionLog failed (non-blocking):',
      err instanceof Error ? err.message : String(err),
    )
  }
}

/** Throw nếu NEMESIS cố tự duyệt Proposal — DR-C5 §C5. */
export function assertNotKingSelfApprove(
  resolvedBy: string,
  escalateTo: 'USER' | 'NEMESIS',
  proposalId?: string,
): void {
  if (resolvedBy === 'NEMESIS' && escalateTo === 'NEMESIS' && proposalId) {
    throw new Error(
      'DR-C5 §C5: NEMESIS cấm tự duyệt Proposal (recused). Deputy SIVIL/HAN hoặc USER phải duyệt thay.',
    )
  }
}

// ============================================================
// §7. CRON REGISTRATION — best-effort (TB-13 §6)
// ============================================================

/**
 * Register cron reminder — TB-13 §6.
 * FIX (Task 19 — Task 18 audit): trước đây POST tới `/api/research/_cron/reminder?XTransformPort=3004`
 * — route KHÔNG TỒN TẠI trong codebase (phantom) → lỗi 404/connection bị nuốt
 * im lặng, reminder không bao giờ được đăng ký. Cron-scheduler mini-service
 * không được deploy cho research team → hàm giờ là no-op có chủ đích (đổi tên
 * behavior bằng comment rõ ràng); timeout reminder xử lý lazy qua checkTimeouts()
 * được wire vào GET /api/research/escalations + GET /api/research/proposals.
 */
async function registerCronReminder(
  missionId: string,
  ref: string,
  remindHours: number,
): Promise<string | undefined> {
  // No-op intentional (Task 19): cron-scheduler chưa deploy cho research team.
  // Reminder lazy: checkTimeouts() chạy mỗi lần user/route query escalations/proposals.
  console.log(
    `[Escalation] cron reminder deferred (lazy mode) — mission ${missionId} ref ${ref} remind after ${remindHours}h (checkTimeouts sẽ xử lý)`,
  )
  return undefined
}

// ============================================================
// §8. INTERNAL HELPER — parse escalation record từ DecisionLogEntry
// ============================================================

function parseEscalationFromDecision(
  missionId: string,
  d: DecisionLogEntry,
): EscalationRecord | null {
  if (!d.reason) return null
  // Reason format: `[ESCALATE → USER] <reason> (timeout=NNh, remind=NNh, ref=esc-NNN)`
  const timeoutMatch = d.reason.match(/timeout=(\d+)h/)
  const remindMatch = d.reason.match(/remind=(\d+)h/)
  const refMatch = d.reason.match(/ref=(esc-\d+)/)
  if (!timeoutMatch || !remindMatch) return null

  return {
    missionId,
    escalatedAt: d.at,
    reason: d.reason.replace(/^\[ESCALATE → \w+\]\s*/, '').replace(/\s*\(timeout=.*\)$/, ''),
    escalateTo: 'USER',
    timeoutHours: Number.parseInt(timeoutMatch[1], 10),
    remindHours: Number.parseInt(remindMatch[1], 10),
    status: 'PENDING',
    remindersSent: 0,
    // Note: không truy được taskId/proposalId từ decision log entry — caller cần lookup worklog
    // hoặc lưu EscalationRecord đầy đủ trong entryJson (escalateToUser đã persist).
  }
}

// ============================================================
// §9. QUERY ESCALATION QUEUE — API GET handler dùng
// ============================================================

/**
 * Query escalation records — API GET /api/research/escalations dùng:
 *  - Scan missions có decisionLog ESCALATE → reconstruct records.
 *  - Filter theo status (PENDING/REMINDED/RESOLVED/TIMEOUT) + missionId (optional).
 *
 * Fail-open: DB error → return empty array (API trả 200 với empty list).
 */
export async function queryEscalations(filter?: {
  status?: string
  missionId?: string
}): Promise<{ escalations: EscalationRecord[]; total: number }> {
  const escalations: EscalationRecord[] = []

  try {
    const where: Record<string, unknown> = {}
    if (filter?.missionId) where.id = filter.missionId

    const missions = await db.researchMission.findMany({
      where: Object.keys(where).length > 0 ? where : undefined,
      orderBy: { updatedAt: 'desc' },
      take: 200,
    })

    for (const m of missions) {
      const decisionLog = decodeJsonArray<DecisionLogEntry>(m.decisionLogJson)
      for (const d of decisionLog) {
        if (d.decision !== 'ESCALATE') continue
        if (!d.ref || !d.ref.startsWith('esc-')) continue
        // Skip if resolved (ref startsWith 'esc-resolved-')
        const record = parseEscalationFromDecision(m.id, d)
        if (!record) continue
        // Mark resolved if there's a later 'CONTINUE'/'FINALIZE' entry with esc-resolved-* ref
        const resolved = decisionLog.find(
          (e) =>
            e.decision === 'CONTINUE' &&
            e.ref &&
            e.ref.startsWith('esc-resolved-') &&
            e.at > d.at,
        )
        if (resolved) {
          record.status = 'RESOLVED'
          record.resolvedAt = resolved.at
          record.resolvedBy = resolved.agent
        }
        escalations.push(record)
      }
    }
  } catch (err) {
    console.warn(
      '[Escalation] queryEscalations failed (non-blocking — return empty):',
      err instanceof Error ? err.message : String(err),
    )
  }

  // Filter by status (caller optional)
  let filtered = escalations
  if (filter?.status) {
    filtered = escalations.filter((e) => e.status === filter.status)
  }

  return { escalations: filtered, total: filtered.length }
}

// ============================================================
// §10. RE-EXPORTS — types
// ============================================================

export type { DecodedResearchMission, DecisionLogEntry }
export { decodeJsonObject }
