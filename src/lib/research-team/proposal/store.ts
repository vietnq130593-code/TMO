/**
 * RESEARCH TEAM — PROPOSAL STORE (TB-11 §1 schema + §3 lifecycle + DR-C5 timeout + bridge self-direction)
 * =====================================================================================
 * Spec:
 *  - TB-11 §1 — Proposal schema: code (P-YYYYMMDD-NNN) + title + summary + changes[]
 *    + verificationPlan[] (§7 (a)+(b)) + pocRef? + diffSummary?.
 *  - TB-11 §3 — Lifecycle: DRAFT → SUBMITTED (tạo branch + timeoutAt) → APPROVED
 *    (DR-C5 — KING cấm tự duyệt) → APPLIED (merge branch).
 *      REJECTED (TC-11 — reason BẮT BUỘC, KING re-DECOMPOSE phần liên quan).
 *  - DR-C5 §C5 — Proposal pending timeout 48h (T3) / 24h (T2/T1) + nhắc 12h. Deputy SIVIL/HAN
 *    khi timeout. KING KHÔNG tự duyệt Proposal của mình.
 *  - DR-C3 — Append-only: review decision append vào mission.decisionLogJson.
 *  - Bridge to self-direction (TB-13 §6 — bridge): khi Proposal APPROVED → gọi
 *    triggerOrchestration(proposalId) hoặc createSelfDirectionProposal(...) từ
 *    '@/lib/self-direction/orchestrator'. Wrap try/catch — orchestrator fail KHÔNG block
 *    proposal APPROVED; applied=false nhưng status=APPROVED.
 *
 * Fail-open: LLM/orchestrator/git fail → status giữ nguyên, applied=false, error logged.
 * Constraint violations (KING self-approve, REJECT empty reason) → throw (caller 400).
 */

import { db } from '@/lib/db'
import {
  encodeJson,
  decodeProposal,
} from '../types'
import type {
  DecodedResearchProposal,
  ProposalSchema,
  ProposalStatusValue,
} from '../types'
import { IDENTITY_CODE } from '../constants'
import { getMission, appendDecisionLog } from '../mission-store'
import { computeTimeout, assertNotKingSelfApprove } from '../king/escalation'
import {
  createBranch as gitCreateBranch,
  mergeBranch as gitMergeBranch,
  diffSummary as gitDiffSummary,
  defaultWorkspaceRoot,
  buildBranchName,
} from './git-branch'

// ============================================================
// §1. TYPES — ResearchProposalInput
// ============================================================

export interface ResearchProposalInput {
  missionId: string
  title: string
  summary: string
  changes: string[]
  verificationPlan: string[]
  /** POC reference (M2 — file path hoặc artifact ref). */
  pocRef?: string
  /** Diff summary (git diff stat — set khi SUBMITTED). */
  diffSummary?: string
}

// ============================================================
// §2. CREATE PROPOSAL — sinh code P-YYYYMMDD-NNN unique
// ============================================================

/**
 * Create proposal — TB-11 §1 + §3 (DRAFT):
 *  1. Sinh code `P-YYYYMMDD-NNN` (count startsWith 'P-YYYYMMDD-' + 1, pad 3, unique loop).
 *  2. status='DRAFT' (chưa SUBMITTED, chưa có branch).
 *  3. schemaJson = encodeJson({code, title, summary, changes, verificationPlan, pocRef, diffSummary}).
 *  4. branchName=null (set khi SUBMITTED qua git-branch.createBranch).
 *  5. timeoutAt=null (set khi SUBMITTED qua escalation.computeTimeout).
 *  6. Return decodeProposal.
 *
 * Throw nếu mission không tồn tại (FK constraint).
 */
export async function createProposal(
  input: ResearchProposalInput,
): Promise<DecodedResearchProposal> {
  // Validate required fields
  if (!input.missionId || typeof input.missionId !== 'string') {
    throw new Error('createProposal: missionId required (non-empty string)')
  }
  if (!input.title || !input.title.trim()) {
    throw new Error('createProposal: title required (non-empty string)')
  }
  if (!input.summary || !input.summary.trim()) {
    throw new Error('createProposal: summary required (non-empty string)')
  }
  if (!Array.isArray(input.changes) || input.changes.length === 0) {
    throw new Error('createProposal: changes[] required (non-empty array)')
  }
  if (!Array.isArray(input.verificationPlan) || input.verificationPlan.length === 0) {
    throw new Error('createProposal: verificationPlan[] required (non-empty array — TB-11 §7)')
  }

  // Verify mission exists (FK constraint)
  const mission = await getMission(input.missionId)
  if (!mission) {
    throw new Error(`createProposal: mission ${input.missionId} không tồn tại`)
  }

  // Sinh code P-YYYYMMDD-NNN unique
  const code = await generateUniqueProposalCode()

  // Build schema
  const schema: ProposalSchema = {
    code,
    title: input.title.trim(),
    summary: input.summary.trim(),
    changes: input.changes.filter((c) => typeof c === 'string' && c.trim().length > 0),
    verificationPlan: input.verificationPlan.filter(
      (v) => typeof v === 'string' && v.trim().length > 0,
    ),
    pocRef: input.pocRef || undefined,
    diffSummary: input.diffSummary || undefined,
  }

  // Persist (status='DRAFT', branchName=null, timeoutAt=null)
  const row = await db.researchProposal.create({
    data: {
      code,
      missionId: input.missionId,
      status: 'DRAFT',
      schemaJson: encodeJson(schema),
      branchName: null,
      diffSummary: input.diffSummary || null,
      reviewedBy: null,
      timeoutAt: null,
      decidedAt: null,
    },
  })

  // Append decision log to mission (audit trail)
  try {
    await appendDecisionLog(input.missionId, {
      at: new Date().toISOString(),
      agent: 'KING',
      decision: 'RESEARCH',
      reason: `[PROPOSAL DRAFT] ${code} — "${schema.title}" (${schema.changes.length} changes, ${schema.verificationPlan.length} verification steps)`,
      ref: code,
    })
  } catch (err) {
    console.warn(
      '[Proposal] appendDecisionLog DRAFT failed (non-blocking):',
      err instanceof Error ? err.message : String(err),
    )
  }

  return decodeProposal(row)
}

/**
 * Sinh P-YYYYMMDD-NNN unique. Dùng count startsWith + 1, pad 3 số. Loop tối đa
 * 5 lần phòng race-condition.
 */
async function generateUniqueProposalCode(): Promise<string> {
  const yyyymmdd = formatYyyyMmDd(new Date())
  const prefix = `${IDENTITY_CODE.proposalPrefix}-${yyyymmdd}-`

  for (let attempt = 0; attempt < 5; attempt++) {
    const count = await db.researchProposal.count({
      where: { code: { startsWith: prefix } },
    })
    const next = count + 1 + attempt
    const candidate = `${prefix}${String(next).padStart(3, '0')}`

    const exists = await db.researchProposal.findUnique({
      where: { code: candidate },
      select: { id: true },
    })
    if (!exists) return candidate
  }

  // Fallback: timestamp seconds làm NNN — đảm bảo unique
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
// §3. GET / LIST PROPOSALS
// ============================================================

export async function getProposal(
  id: string,
): Promise<DecodedResearchProposal | null> {
  const row = await db.researchProposal.findUnique({ where: { id } })
  return row ? decodeProposal(row) : null
}

export async function getProposalByCode(
  code: string,
): Promise<DecodedResearchProposal | null> {
  const row = await db.researchProposal.findUnique({ where: { code } })
  return row ? decodeProposal(row) : null
}

export interface ListProposalsFilter {
  missionId?: string
  status?: ProposalStatusValue
  limit?: number
  offset?: number
}

export async function listProposals(
  filter?: ListProposalsFilter,
): Promise<DecodedResearchProposal[]> {
  const limit = Math.min(Math.max(filter?.limit ?? 50, 1), 200)
  const offset = Math.max(filter?.offset ?? 0, 0)

  const where: Record<string, unknown> = {}
  if (filter?.missionId) where.missionId = filter.missionId
  if (filter?.status) where.status = filter.status

  const rows = await db.researchProposal.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: limit,
    skip: offset,
  })

  return rows.map(decodeProposal)
}

export async function countProposals(
  filter?: ListProposalsFilter,
): Promise<number> {
  const where: Record<string, unknown> = {}
  if (filter?.missionId) where.missionId = filter.missionId
  if (filter?.status) where.status = filter.status
  return db.researchProposal.count({ where })
}

// ============================================================
// §4. SUBMIT PROPOSAL — DRAFT → SUBMITTED (create branch + set timeout)
// ============================================================

/**
 * Submit proposal — TB-11 §3 (DRAFT → SUBMITTED):
 *  1. Validate status === 'DRAFT' (caller có thể pre-validate).
 *  2. Create git branch trong workspace (git-branch.createBranch — fail-open).
 *  3. Set timeoutAt = computeTimeout(mission tier, 'proposal') (DR-C5 §C5).
 *  4. status='SUBMITTED', branchName set (nếu git succeeded).
 *  5. Append mission decision log 'SUBMIT Proposal'.
 *
 * Fail-open: git createBranch fail → branchName=null, status vẫn SUBMITTED, error logged.
 * Caller (API) hiển thị warning cho user "branch creation failed — manual setup needed".
 *
 * Throw nếu proposal null / không ở DRAFT.
 */
export async function submitProposal(
  id: string,
  branchNameOverride?: string,
): Promise<DecodedResearchProposal> {
  const proposal = await getProposal(id)
  if (!proposal) {
    throw new Error(`submitProposal: proposal ${id} không tồn tại`)
  }
  if (proposal.status !== 'DRAFT') {
    throw new Error(
      `submitProposal: proposal ${id} status=${proposal.status} — chỉ DRAFT mới submit được (TB-11 §3)`,
    )
  }

  // Get mission for tier + workspace path
  const mission = await getMission(proposal.missionId)
  if (!mission) {
    throw new Error(`submitProposal: mission ${proposal.missionId} không tồn tại (orphan proposal)`)
  }

  // Create branch trong workspace (fail-open — git có thể không có)
  const workspaceRoot = defaultWorkspaceRoot(proposal.missionId)
  let branchName: string | null = null
  let branchError: string | undefined
  try {
    const branchResult = await gitCreateBranch(proposal.code, workspaceRoot)
    if (branchResult.created) {
      branchName = branchResult.branchName
    } else {
      branchError = branchResult.error || 'unknown git error'
      // Fallback: dùng buildBranchName (không thực sự tạo branch)
      branchName = buildBranchName(proposal.code)
    }
  } catch (err) {
    branchError = err instanceof Error ? err.message : String(err)
    branchName = buildBranchName(proposal.code) // fallback synthetic name
  }

  // Compute timeout (DR-C5 §C5 — proposal T1/T2=24h, T3=48h)
  const tier = (mission.tier || 'T2') as 'T1' | 'T2' | 'T3'
  const { timeoutHours } = computeTimeout(tier, 'proposal')
  const timeoutAt = new Date(Date.now() + timeoutHours * 60 * 60 * 1000)

  // Update proposal
  const updated = await db.researchProposal.update({
    where: { id },
    data: {
      status: 'SUBMITTED',
      branchName,
      timeoutAt,
    },
  })

  // Append mission decision log
  try {
    await appendDecisionLog(proposal.missionId, {
      at: new Date().toISOString(),
      agent: 'KING',
      decision: 'RESEARCH',
      reason: `[PROPOSAL SUBMITTED] ${proposal.code} — branch=${branchName || '(git failed — synthetic)'} timeout=${timeoutHours}h${branchError ? ` (branch error: ${branchError.slice(0, 100)})` : ''}`,
      ref: proposal.code,
    })
  } catch (err) {
    console.warn(
      '[Proposal] appendDecisionLog SUBMITTED failed (non-blocking):',
      err instanceof Error ? err.message : String(err),
    )
  }

  return decodeProposal(updated)
}

// ============================================================
// §5. APPROVE PROPOSAL — SUBMITTED → APPROVED + bridge self-direction (DR-C5 §C5)
// ============================================================

/**
 * Approve proposal — TB-11 §3 (SUBMITTED → APPROVED) + DR-C5 §C5 (KING cấm tự duyệt):
 *  1. assertNotKingSelfApprove(reviewedBy, escalateTo, proposalId) — DR-C5 §C5 throw
 *      nếu KING self-approve Proposal.
 *  2. Set decidedAt, reviewedBy, status='APPROVED'.
 *  3. Bridge to self-direction (TB-13 §6): gọi triggerOrchestration(id) từ
 *      '@/lib/self-direction/orchestrator'. Wrap try/catch — orchestrator fail
 *      → applied=false nhưng proposal vẫn APPROVED.
 *  4. Append mission decision log 'APPROVE Proposal'.
 *
 * Throw nếu proposal null / không ở SUBMITTED / KING self-approve.
 */
export async function approveProposal(
  id: string,
  reviewedBy: string,
): Promise<{
  proposal: DecodedResearchProposal
  applied: boolean
  applyError?: string
}> {
  const proposal = await getProposal(id)
  if (!proposal) {
    throw new Error(`approveProposal: proposal ${id} không tồn tại`)
  }
  if (proposal.status !== 'SUBMITTED') {
    throw new Error(
      `approveProposal: proposal ${id} status=${proposal.status} — chỉ SUBMITTED mới approve được (TB-11 §3)`,
    )
  }

  // DR-C5 §C5 — KING cấm tự duyệt Proposal
  // escalateTo='KING' khi reviewedBy='KING' và proposal được duyệt bởi chính KING (author)
  assertNotKingSelfApprove(reviewedBy, 'KING', id)

  const now = new Date()

  // Update proposal: status='APPROVED', decidedAt, reviewedBy
  const updated = await db.researchProposal.update({
    where: { id },
    data: {
      status: 'APPROVED',
      decidedAt: now,
      reviewedBy,
    },
  })

  // Append mission decision log
  try {
    await appendDecisionLog(proposal.missionId, {
      at: now.toISOString(),
      agent: reviewedBy,
      decision: 'CONTINUE',
      reason: `[PROPOSAL APPROVED] ${proposal.code} — reviewed by ${reviewedBy}`,
      ref: proposal.code,
    })
  } catch (err) {
    console.warn(
      '[Proposal] appendDecisionLog APPROVED failed (non-blocking):',
      err instanceof Error ? err.message : String(err),
    )
  }

  // Bridge to self-direction — TB-13 §6 (orchestrator có thể fail → applied=false)
  // TASK 3-fix WORK 4 (audit B.9 fix): trước đây gọi triggerOrchestration(proposal.code)
  // dùng sai ID type (code P-YYYYMMDD-NNN thay vì SD proposal cuid) → orchestrator
  // luôn return false nhưng code lại set applied=true (misleading UI toast).
  // Giờ: tạo SelfDirectionProposal thật từ research proposal schema → trigger
  // orchestration(sdProposalId). Nếu createSelfDirectionProposal fail hoặc
  // schema không match → fallback applied=false + applyError tường minh
  // (KHÔNG fake applied=true). Caller UI toast sẽ hiển thị đúng state.
  let applied = false
  let applyError: string | undefined
  try {
    // Lazy import — orchestrator module có thể phức tạp / circular
    const orchestrator = await import('@/lib/self-direction/orchestrator')

    // Build SD proposal data từ research proposal schema (TB-11 §1 + SD §1.3)
    // Defensive: schema fields có thể empty nếu schemaJson bị lỗi decode.
    const schema = proposal.schema || ({} as Record<string, unknown>)
    const sdTitle = String(schema.title ?? proposal.code).slice(0, 200)
    const sdProblem = String(schema.summary ?? '(no summary)').slice(0, 4000)
    const sdSolution = (Array.isArray(schema.changes) ? schema.changes : [])
      .join('\n')
      .slice(0, 4000)
    const sdImpl = (Array.isArray(schema.verificationPlan) ? schema.verificationPlan : [])
      .join('\n')
      .slice(0, 4000)

    const sdProposalData = {
      title: `[Research] ${sdTitle}`.slice(0, 200),
      category: 'improvement' as const, // research proposals default 'improvement'
      priority: 'medium' as const,
      problem: sdProblem || `(no summary — research proposal ${proposal.code})`,
      solution: sdSolution || '(no changes listed)',
      implementation: sdImpl || '(no verification plan)',
      scheduleAt: null,
      impact: `Research proposal ${proposal.code} (missionId=${proposal.missionId}) — branch ${proposal.branchName || '(none)'}`,
      source: 'agent' as const,
      createdBy: reviewedBy,
      executionMode: 'llm' as const, // research proposals không auto code-workflow
    }

    // Create SD proposal row (returns object with .id — the cuid)
    const sdProposal = await orchestrator.createSelfDirectionProposal(sdProposalData)
    const sdProposalId = (sdProposal as { id?: string }).id

    if (!sdProposalId) {
      applyError = 'SD bridge: createSelfDirectionProposal returned no id — manual apply required'
    } else if (typeof orchestrator.triggerOrchestration === 'function') {
      // Trigger orchestration (fire-and-forget best-effort — internal already async).
      // triggerOrchestration returns boolean: true nếu started, false nếu proposal
      // không ở trạng thái ready/approved. SD proposal mới tạo → status='pending'
      // → orchestrator sẽ return false (chưa approved). Đó là behavior đúng —
      // caller (UI / Mr. Architect review) sẽ duyệt SD proposal riêng.
      // Bridge ở đây là "đã đề xuất SD proposal" — applied=false cho đến khi SD
      // proposal được duyệt + orchestration chạy xong.
      const started = await orchestrator.triggerOrchestration(sdProposalId)
      if (started) {
        applied = true
      } else {
        // SD proposal created but orchestration not started (status=pending — awaiting approval)
        applied = false
        applyError = `SD proposal ${sdProposalId} created — awaiting approval (orchestration not started yet)`
      }
    } else {
      applyError = 'orchestrator.triggerOrchestration not available — SD bridge cannot start'
    }
  } catch (err) {
    applyError = err instanceof Error ? err.message : String(err)
    console.warn(
      '[Proposal] bridge self-direction failed (non-blocking — proposal still APPROVED):',
      applyError,
    )
    // applied=false — proposal vẫn APPROVED, caller có thể retry applyProposal
  }

  return {
    proposal: decodeProposal(updated),
    applied,
    applyError,
  }
}

// ============================================================
// §6. REJECT PROPOSAL — TC-11 reason BẮT BUỘC (KING re-DECOMPOSE)
// ============================================================

/**
 * Reject proposal — TB-11 §3 + TC-11 (REJECTED — reason BẮT BUỘC non-empty):
 *  1. Validate reason non-empty (TC-11 pattern).
 *  2. assertNotKingSelfApprove (DR-C5 §C5 — KING cũng cấm tự reject? Spec nói cấm
 *      approve; reject thì KING được — nhưng pass qua để giữ consistency).
 *  3. status='REJECTED', decidedAt, reviewedBy.
 *  4. Append mission decision log 'REJECT Proposal' + reason.
 *
 * Caller (P5 kingReject) sẽ re-DECOMPOSE phần liên quan khi mission REJECTED.
 *
 * Throw nếu proposal null / không ở SUBMITTED / reason empty (TC-11).
 */
export async function rejectProposal(
  id: string,
  reviewedBy: string,
  reason: string,
): Promise<DecodedResearchProposal> {
  // TC-11 — REJECT reason BẮT BUỘC non-empty
  if (!reason || !reason.trim()) {
    throw new Error(
      'rejectProposal: REJECT reason BẮT BUỘC non-empty (TC-11 — TB-12 §3.2 + TB-06 §8.6/8.7)',
    )
  }

  const proposal = await getProposal(id)
  if (!proposal) {
    throw new Error(`rejectProposal: proposal ${id} không tồn tại`)
  }
  if (proposal.status !== 'SUBMITTED') {
    throw new Error(
      `rejectProposal: proposal ${id} status=${proposal.status} — chỉ SUBMITTED mới reject được (TB-11 §3)`,
    )
  }

  // DR-C5 §C5 — KING cũng cấm tự reject (consistent with approve — KING recused)
  assertNotKingSelfApprove(reviewedBy, 'KING', id)

  const now = new Date()

  // Update proposal
  const updated = await db.researchProposal.update({
    where: { id },
    data: {
      status: 'REJECTED',
      decidedAt: now,
      reviewedBy,
      diffSummary: `REJECTED: ${reason.trim().slice(0, 500)}`,
    },
  })

  // Append mission decision log
  try {
    await appendDecisionLog(proposal.missionId, {
      at: now.toISOString(),
      agent: reviewedBy,
      decision: 'REJECT',
      reason: `[PROPOSAL REJECTED] ${proposal.code} — ${reason.trim()}`,
      ref: proposal.code,
    })
  } catch (err) {
    console.warn(
      '[Proposal] appendDecisionLog REJECTED failed (non-blocking):',
      err instanceof Error ? err.message : String(err),
    )
  }

  return decodeProposal(updated)
}

// ============================================================
// §7. APPLY PROPOSAL — APPROVED → APPLIED (merge branch)
// ============================================================

/**
 * Apply proposal — TB-11 §3 (APPROVED → APPLIED) + TB-01 §3 Quy tắc vàng (merge):
 *  1. Validate status === 'APPROVED'.
 *  2. Merge branch (git-branch.mergeBranch — fail-open).
 *  3. status='APPLIED'.
 *  4. Bridge orchestrator (nếu chưa trigger ở approve).
 *
 * Fail-open: git merge fail → merged=false, proposal vẫn APPROVED.
 * Caller (API) hiển thị error cho user.
 *
 * Throw nếu proposal null / không ở APPROVED.
 */
export async function applyProposal(
  id: string,
): Promise<{
  proposal: DecodedResearchProposal
  merged: boolean
  mergeError?: string
}> {
  const proposal = await getProposal(id)
  if (!proposal) {
    throw new Error(`applyProposal: proposal ${id} không tồn tại`)
  }
  if (proposal.status !== 'APPROVED') {
    throw new Error(
      `applyProposal: proposal ${id} status=${proposal.status} — chỉ APPROVED mới apply được (TB-11 §3)`,
    )
  }

  // Merge branch (fail-open — git có thể không có)
  let merged = false
  let mergeError: string | undefined
  let diffSummaryStr = proposal.diffSummary || undefined

  if (proposal.branchName) {
    try {
      const workspaceRoot = defaultWorkspaceRoot(proposal.missionId)
      const mergeResult = await gitMergeBranch(proposal.branchName, workspaceRoot)

      if (mergeResult.merged) {
        merged = true
        // Try to compute diff summary post-merge (DR-C3 Q3 — diff artifact)
        try {
          const diffResult = await gitDiffSummary(proposal.branchName, workspaceRoot)
          if (diffResult.summary) {
            diffSummaryStr = diffResult.summary
          }
        } catch {
          // Ignore diff summary error — merge succeeded
        }
      } else {
        mergeError = mergeResult.error || 'unknown git merge error'
      }
    } catch (err) {
      mergeError = err instanceof Error ? err.message : String(err)
    }
  } else {
    mergeError = 'no branchName set (proposal was submitted without git branch creation)'
  }

  // Update proposal status (mark APPLIED only if merge succeeded — TB-01 §3 Quy tắc vàng)
  const newStatus: ProposalStatusValue = merged ? 'APPLIED' : 'APPROVED'
  const updated = await db.researchProposal.update({
    where: { id },
    data: {
      status: newStatus,
      diffSummary: diffSummaryStr,
    },
  })

  // Append mission decision log
  try {
    await appendDecisionLog(proposal.missionId, {
      at: new Date().toISOString(),
      agent: 'KING',
      decision: merged ? 'FINALIZE' : 'CONTINUE',
      reason: merged
        ? `[PROPOSAL APPLIED] ${proposal.code} — merged branch ${proposal.branchName}`
        : `[PROPOSAL APPLY FAILED] ${proposal.code} — ${mergeError || 'unknown error'}`,
      ref: proposal.code,
    })
  } catch (err) {
    console.warn(
      '[Proposal] appendDecisionLog APPLIED failed (non-blocking):',
      err instanceof Error ? err.message : String(err),
    )
  }

  return {
    proposal: decodeProposal(updated),
    merged,
    mergeError,
  }
}

// ============================================================
// §8. HELPERS — check timeout expired (caller API deputy flow)
// ============================================================

/**
 * Check if proposal timeout expired — DR-C5 §C5 (caller API deputy flow):
 *  - If proposal.timeoutAt < now → expired → deputy SIVIL/HAN được ủy quyền duyệt.
 *  - Return { expired, deputy } (deputy assigned qua escalation.assignDeputy).
 *
 * Pure (no mutation); caller check before approving with deputy role.
 */
export async function checkProposalTimeout(
  id: string,
): Promise<{ expired: boolean; timeoutAt: Date | null; now: Date }> {
  const proposal = await getProposal(id)
  if (!proposal || !proposal.timeoutAt) {
    return { expired: false, timeoutAt: null, now: new Date() }
  }
  const now = new Date()
  return {
    expired: proposal.timeoutAt.getTime() < now.getTime(),
    timeoutAt: proposal.timeoutAt,
    now,
  }
}

// ============================================================
// §9. RE-EXPORTS — types
// ============================================================

export type { DecodedResearchProposal, ProposalSchema, ProposalStatusValue }
export { decodeProposal, buildBranchName, defaultWorkspaceRoot }
