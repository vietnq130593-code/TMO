/**
 * ALISTA — Follow-up Verification Loop (v1.2)
 * ============================================
 * LUỒNG PHẢN HỒI KÍN (owner request 2026-09-01):
 *   1. ALISTA gửi đề xuất → SELF-DIRECTION (pending)
 *   2. Owner/Opus phê duyệt → orchestrator thực thi → status='completed'
 *   3. NGAY KHI HOÀN TẤT: hook tại orchestrator.ts + automation-proposals.ts
 *      (dynamic import — chống circular) gọi notifyAlistaProposalCompleted()
 *      → thông tin đề xuất đã hoàn thành được chuyển tới ALISTA NGAY.
 *   4. ALISTA re-run đúng collector của đề xuất đó (parse key từ title) →
 *      so findings: vấn đề còn tồn tại không?
 *   5. Vẫn còn (dù là vấn đề khác trong cùng check) hoặc cần nâng cấp →
 *      gửi ĐỀ XUẤT MỚI NGAY (key follow-up `<base>:v<N>` + prefix ⟲ FOLLOW-UP).
 *   6. Đề xuất follow-up lại đi qua luồng 2-5 → vòng lặp tự duy trì đến khi
 *      vấn đề được xử lý triệt để (dedupe LIVE 7 ngày chống spam).
 *
 * An toàn kép:
 *   - Hook in-process (completion-hook): tức thời (cùng process Next.js).
 *   - Sweep 60s trong alistaTick: catch-up nếu hook bị lỡ (restart giữa chừng,
 *     proposal completed lúc app chết...) — window 48h, cap 3 proposal/tick.
 *
 * Trạng thái lưu TaskExecution (không cần schema mới):
 *   type='alista-verify', jobId=<originalProposalId>, result JSON chứa
 *   { resolved, findingsAfter, newProposals, originalKey, ... }.
 */

import { db } from '@/lib/db'
import type { CheckId, CollectorResult } from './types'
import { baseKeyOf, STEP_LABELS } from './types'
import {
  collectToolsHealth, collectAgentRuns, collectEscalations,
  collectDomainCoverage, collect3Layers, collectSelfAssessment,
  collectDatabaseSystem, getPreviousSnapshot,
} from './collectors'
import { evaluateRules } from './rules'
import { createProposalsForCheck, withTimeout, type FollowUpContext } from './proposals'

// ==================== CONSTANTS ====================

const ALISTA_AGENT_NAME = 'ALISTA'
/** Budget 1 lần xác minh — ngắn hơn ca trực (đây là re-check 1 check, không phải 7) */
const VERIFY_BUDGET_MS = 20 * 60_000 // 20 phút
/** Timeout từng collector khi verify (như comprehensive-check) */
const VERIFY_COLLECTOR_TIMEOUT_MS = 5 * 60_000
/** Sweep window — đề xuất hoàn tất trong 48h mà chưa verify sẽ được verify lại */
const SWEEP_WINDOW_MS = 48 * 3600_000
/** Cap số proposal verify mỗi tick sweep (chống burst) */
const SWEEP_NOTIFY_CAP = 3
/** Title của follow-up: đếm số proposal cùng base key để tăng seq `:v<N>` */
const NOTIFIED_MEM_MS = 10 * 60_000 // in-memory dedupe window

/** Map slug (trong key) → check ID cần re-run */
const SLUG_TO_CHECK: Record<string, CheckId> = {
  tool: 1,
  run: 2,
  zombie: 2,
  escalation: 3,
  domain: 4,
  layer: 5,
  self: 6,
  db: 7,
}

// ==================== GLOBAL STATE (chống HMR double + chống chạy kép) ====================

const NOTIFIED_KEY = '__alistaVerifyNotified' // Map<proposalId, ts>
const INFLIGHT_KEY = '__alistaVerifyInFlight' // Map<proposalId, ts>

function getGlobalMapKey(key: string): Map<string, number> {
  const g = globalThis as unknown as { [k: string]: unknown }
  if (!g[key] || !(g[key] instanceof Map)) {
    g[key] = new Map<string, number>()
  }
  return g[key] as Map<string, number>
}

function isVerifyInFlight(proposalId: string): boolean {
  const m = getGlobalMapKey(INFLIGHT_KEY)
  const ts = m.get(proposalId)
  // Guard kẹt (process crash giữa verify) → coi như hết hạn sau budget + 5'
  return ts != null && Date.now() - ts < VERIFY_BUDGET_MS + 5 * 60_000
}

// ==================== KEY PARSING ====================

interface ParsedKey {
  slug: string
  target: string
  yyyymm: string
  seq: number | null
  baseKey: string
  checkId: CheckId | null
}

/** Parse key `[ALISTA] <slug>:<target>:<yyyymm>[:vN]` từ title proposal */
export function parseAlistaKey(title: string): ParsedKey | null {
  const m = title.match(/^\[ALISTA\]\s+([a-z_]+):([^:]+):(\d{6})(?::v(\d+))?/i)
  if (!m) return null
  const slug = m[1].toLowerCase()
  const target = m[2]
  const yyyymm = m[3]
  const seq = m[4] ? parseInt(m[4], 10) : null
  const baseKey = `[ALISTA] ${slug}:${target}:${yyyymm}`
  return { slug, target, yyyymm, seq, baseKey, checkId: SLUG_TO_CHECK[slug] ?? null }
}

// ==================== NOTIFY (entry point — gọi từ hook) ====================

/**
 * Điểm vào của luồng follow-up — gọi NGAY khi 1 proposal Self-Direction hoàn tất
 * (2 site: orchestrator.ts runOrchestrationInner + automation-proposals.ts fast-path).
 * Fail-open tuyệt đối: mọi lỗi chỉ log, không ảnh hưởng luồng chính.
 *
 * @param proposalId id SelfDirectionProposal vừa completed
 * @param trigger 'completion-hook' (tức thời) | 'sweep' (an toàn 60s)
 */
export async function notifyAlistaProposalCompleted(
  proposalId: string,
  trigger: 'completion-hook' | 'sweep' = 'completion-hook',
): Promise<void> {
  try {
    // (1) Lọc proposal của ALISTA (createdBy) + đã completed
    const proposal = await db.selfDirectionProposal.findUnique({
      where: { id: proposalId },
      select: { id: true, title: true, status: true, createdBy: true, completedAt: true },
    })
    if (!proposal || proposal.status !== 'completed') return
    if (proposal.createdBy !== ALISTA_AGENT_NAME) return

    // (2) In-memory dedupe — đã notify trong 10' thì bỏ (anti-hook-spam)
    const notified = getGlobalMapKey(NOTIFIED_KEY)
    const lastTs = notified.get(proposalId)
    if (lastTs != null && Date.now() - lastTs < NOTIFIED_MEM_MS) return

    // (3) Durable dedupe — đã có TaskExecution verify completed cho proposal này
    const existingVerify = await db.taskExecution.findFirst({
      where: { type: 'alista-verify', jobId: proposalId, status: 'completed' },
      select: { id: true },
    })
    if (existingVerify) return

    // (4) Đang verify (in-flight) → bỏ
    if (isVerifyInFlight(proposalId)) return

    // (5) Notify + khởi động verify (fire-and-forget)
    notified.set(proposalId, Date.now())
    console.log(
      `[ALISTA][verify] Nhận thông tin: đề xuất #${proposalId} "${proposal.title.slice(0, 100)}" ` +
      `đã HOÀN TẤT (${trigger}) — bắt đầu xác minh lại vấn đề đã được xử lý triệt để chưa`,
    )
    void runFollowUpVerification(proposalId, trigger).catch((err) => {
      console.error(
        `[ALISTA][verify] verification #${proposalId} crash:`,
        err instanceof Error ? err.message : String(err),
      )
    })
  } catch (err) {
    console.warn(
      '[ALISTA][verify] notifyAlistaProposalCompleted fail (fail-open — sweep 60s sẽ bắt lại):',
      err instanceof Error ? err.message : String(err),
    )
  }
}

// ==================== MAIN: FOLLOW-UP VERIFICATION ====================

interface VerifyOutcome {
  ok: boolean
  resolved: boolean | null
  newProposalIds: Array<{ id: string; title: string }>
  error?: string
}

/**
 * Xác minh 1 đề xuất đã hoàn tất: re-run đúng collector → rules → so findings.
 * - Không còn finding → resolved=true (vấn đề đã xử lý triệt để).
 * - Còn finding (cùng vấn đề hoặc phát hiện mới) → resolved=false → gửi đề xuất
 *   follow-up NGAY qua createProposalsForCheck({followUpFor}).
 * - Collector fail / key không parse được →保守 (resolved=null) — ca trực 23h30
 *   sẽ xử lý, KHÔNG tạo proposal mù.
 */
async function runFollowUpVerification(
  proposalId: string,
  trigger: 'completion-hook' | 'sweep',
): Promise<VerifyOutcome> {
  const startedAt = Date.now()
  const deadlineMs = startedAt + VERIFY_BUDGET_MS
  const inFlight = getGlobalMapKey(INFLIGHT_KEY)
  inFlight.set(proposalId, startedAt)

  let taskExecutionId: string | null = null
  const outcome: VerifyOutcome = { ok: false, resolved: null, newProposalIds: [] }

  try {
    const proposal = await db.selfDirectionProposal.findUnique({
      where: { id: proposalId },
      select: { id: true, title: true, problem: true, completedAt: true, status: true },
    })
    if (!proposal || proposal.status !== 'completed') {
      // Status đổi giữa notify và verify (hiếm) — bỏ
      return { ...outcome, ok: true, error: 'proposal không còn status=completed' }
    }

    const parsedKey = parseAlistaKey(proposal.title)

    // TaskExecution row — jobId=proposalId làm marker durable cho sweep
    const initResult = {
      kind: 'alista-verify',
      originalProposalId: proposalId,
      originalTitle: proposal.title,
      originalKey: parsedKey?.baseKey ?? null,
      checkId: parsedKey?.checkId ?? null,
      trigger,
      status: 'running',
      startedAt,
      budgetMs: VERIFY_BUDGET_MS,
    }
    try {
      const row = await db.taskExecution.create({
        data: {
          type: 'alista-verify',
          jobId: proposalId,
          status: 'running',
          startedAt: new Date(startedAt),
          result: JSON.stringify(initResult),
        },
      })
      taskExecutionId = row.id
    } catch (err) {
      console.warn('[ALISTA][verify] TaskExecution create fail (không chặn verify):', err instanceof Error ? err.message : String(err))
    }

    // (A) Key không parse được / slug không map → ghi nhận, không re-check
    if (!parsedKey || parsedKey.checkId == null) {
      const reason = !parsedKey
        ? 'title không parse được key [ALISTA] <slug>:<target>:<yyyymm>'
        : `slug "${parsedKey.slug}" không map được check nào`
      await finalizeVerify(taskExecutionId, proposalId, {
        ...initResult,
        ok: true,
        resolved: null,
        notVerifiable: true,
        note: reason,
        verifiedAt: Date.now(),
        durationMs: Date.now() - startedAt,
      })
      console.warn(`[ALISTA][verify] #${proposalId}: bỏ qua — ${reason}`)
      return { ...outcome, ok: true, error: reason }
    }

    const checkId = parsedKey.checkId

    // (B) Check ⑥ (self-assessment) gắn với ca trực cụ thể — không re-check được
    if (checkId === 6) {
      await finalizeVerify(taskExecutionId, proposalId, {
        ...initResult,
        ok: true,
        resolved: null,
        notRecheckable: true,
        note: 'check ⑥ (tự-đánh-giá) gắn với ca trực cụ thể — không xác minh lại được; ca trực kế tiếp sẽ tự đánh giá',
        verifiedAt: Date.now(),
        durationMs: Date.now() - startedAt,
      })
      return { ...outcome, ok: true }
    }

    // (C) Re-run ĐÚNG collector của check — dữ liệu tươi
    const collected = await collectForVerify(checkId)
    if (!collected.ok) {
      // Collector fail → conservative: KHÔNG kết luận, KHÔNG tạo proposal mù
      await finalizeVerify(taskExecutionId, proposalId, {
        ...initResult,
        ok: true,
        resolved: null,
        collectionError: collected.error ?? 'unknown',
        note: 'collector fail khi xác minh — ca trực 23h30 sẽ tự kiểm tra lại',
        verifiedAt: Date.now(),
        durationMs: Date.now() - startedAt,
      })
      console.warn(`[ALISTA][verify] #${proposalId}: collector ${checkId} fail — ${collected.error}`)
      return { ...outcome, ok: true, error: collected.error }
    }

    // (D) Re-evaluate rules deterministic — findings tươi
    const data = collected.data
    let threeLayers: Awaited<ReturnType<typeof collect3Layers>>['data'] | undefined
    if (checkId === 5 && collected.data) threeLayers = collected.data as NonNullable<typeof threeLayers>
    const findings = evaluateRules(checkId, data, threeLayers)

    // (E) Không còn finding → ĐÃ XỬ LÝ TRIỆT ĐỂ
    if (findings.length === 0) {
      await finalizeVerify(taskExecutionId, proposalId, {
        ...initResult,
        ok: true,
        resolved: true,
        findingsAfter: [],
        newProposals: [],
        verifiedAt: Date.now(),
        durationMs: Date.now() - startedAt,
      })
      console.log(
        `[ALISTA][verify] ✅ #${proposalId} "${proposal.title.slice(0, 80)}" — vấn đề đã được XỬ LÝ TRIỆT ĐỂ ` +
        `(${STEP_LABELS[checkId]} sạch findings, ${(Date.now() - startedAt) / 1000 | 0}s)`,
      )
      return { ok: true, resolved: true, newProposalIds: [] }
    }

    // (F) Còn findings → CHƯA triệt để (hoặc phát hiện mới) → gửi đề xuất mới NGAY
    if (Date.now() >= deadlineMs) {
      await finalizeVerify(taskExecutionId, proposalId, {
        ...initResult,
        ok: true,
        resolved: false,
        deadlineBreached: true,
        findingsAfter: findings.map(f => ({ key: f.key, target: f.target, priority: f.priority })),
        newProposals: [],
        note: 'trượt budget 20' + ' trước khi kịp tạo proposal follow-up — ca trực 23h30 sẽ đề xuất lại',
        verifiedAt: Date.now(),
        durationMs: Date.now() - startedAt,
      })
      return { ok: true, resolved: false, newProposalIds: [] }
    }

    const followUpFor: FollowUpContext = {
      proposalId,
      proposalTitle: proposal.title,
      completedAt: proposal.completedAt ?? new Date(),
      baseKey: parsedKey.baseKey,
      trigger,
    }
    const created = await createProposalsForCheck(checkId, findings, {
      deadlineMs,
      followUpFor,
    })
    const newProposals = created.filter(c => c.created).map(c => ({ id: c.id, title: c.title }))

    await finalizeVerify(taskExecutionId, proposalId, {
      ...initResult,
      ok: true,
      resolved: false,
      findingsAfter: findings.map(f => ({ key: f.key, target: f.target, priority: f.priority })),
      stillOriginalIssue: findings.some(f => {
        const fBase = baseKeyOf(f.key)
        const fNorm = fBase.replace(/^\[ALISTA\]\s+([a-z_]+):([^:]+):\d{6}/i, (_s, a, b) => `${String(a).toLowerCase()}:${String(b).toLowerCase()}`)
        const oNorm = parsedKey.baseKey.replace(/^\[ALISTA\]\s+([a-z_]+):([^:]+):\d{6}/i, (_s, a, b) => `${String(a).toLowerCase()}:${String(b).toLowerCase()}`)
        return fNorm === oNorm
      }),
      newProposals,
      skippedProposals: created.filter(c => !c.created).map(c => ({ title: c.title, reason: c.skipReason ?? 'unknown' })),
      verifiedAt: Date.now(),
      durationMs: Date.now() - startedAt,
    })

    console.log(
      `[ALISTA][verify] ⟲ #${proposalId} "${proposal.title.slice(0, 80)}" — vấn đề CHƯA triệt để ` +
      `(${findings.length} findings sau khi xử lý) → đã gửi ${newProposals.length} đề xuất follow-up NGAY ` +
      `(${newProposals.map(p => p.title.slice(0, 60)).join(' | ') || 'dedupe chặn — đã có proposal sống'})`,
    )
    return { ok: true, resolved: false, newProposalIds: newProposals }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    console.error(`[ALISTA][verify] verification #${proposalId} LỖI:`, errMsg)
    if (taskExecutionId) {
      await finalizeVerify(taskExecutionId, proposalId, {
        kind: 'alista-verify',
        originalProposalId: proposalId,
        trigger,
        ok: false,
        error: errMsg,
        verifiedAt: Date.now(),
        durationMs: Date.now() - startedAt,
      }).catch(() => { /* fail-open */ })
    }
    return { ...outcome, ok: false, error: errMsg }
  } finally {
    inFlight.delete(proposalId)
  }
}

// ==================== COLLECTOR CHO VERIFY ====================

async function collectForVerify(checkId: CheckId): Promise<CollectorResult> {
  const label = `verify collector ${checkId} (${STEP_LABELS[checkId]})`
  try {
    return await withTimeout(
      (async (): Promise<CollectorResult> => {
        switch (checkId) {
          case 1: return collectToolsHealth()
          case 2: return collectAgentRuns()
          case 3: return collectEscalations()
          case 4: return collectDomainCoverage()
          case 5: return collect3Layers(await getPreviousSnapshot().catch(() => undefined))
          case 6: return collectSelfAssessment([]) // unreachable — guard ở trên
          case 7: return collectDatabaseSystem()
          default: return { ok: false, error: 'unknown check' }
        }
      })(),
      VERIFY_COLLECTOR_TIMEOUT_MS,
      `ALISTA ${label}`,
    )
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

// ==================== FINALIZE ====================

async function finalizeVerify(
  taskExecutionId: string | null,
  proposalId: string,
  result: Record<string, unknown>,
): Promise<void> {
  if (!taskExecutionId) return
  try {
    await db.taskExecution.update({
      where: { id: taskExecutionId },
      data: {
        status: 'completed',
        completedAt: new Date(),
        result: JSON.stringify({ ...result, status: 'completed' }),
      },
    })
  } catch (err) {
    console.warn(
      `[ALISTA][verify] finalize TaskExecution #${proposalId} fail:`,
      err instanceof Error ? err.message : String(err),
    )
  }
}

// ==================== SWEEP (an toàn kép — chạy mỗi tick 60s của alistaTick) ====================

/**
 * Quét các đề xuất ALISTA đã completed trong 48h mà CHƯA được verify → notify.
 * Bắt các trường hợp hook bị lỡ: process restart giữa lúc proposal hoàn tất,
 * dynamic import fail, lỗi tạm thời... Delay tối đa: 60s (1 tick).
 */
export async function sweepCompletedAlistaProposals(): Promise<number> {
  try {
    // (0) Dọn verify row kẹt 'running' (process chết giữa verify) → 'failed'
    // để sweep có thể verify lại thay vì bỏ qua vĩnh viễn
    const staleBefore = new Date(Date.now() - (VERIFY_BUDGET_MS + 5 * 60_000))
    const stale = await db.taskExecution.findMany({
      where: { type: 'alista-verify', status: 'running', startedAt: { lt: staleBefore } },
      select: { id: true, jobId: true },
      take: 10,
    })
    for (const s of stale) {
      if (s.jobId && isVerifyInFlight(s.jobId)) continue // in-flight hợp lệ
      await db.taskExecution.update({
        where: { id: s.id },
        data: {
          status: 'failed',
          completedAt: new Date(),
          errorMessage: 'orphaned — process restart giữa chừng (sweep sẽ verify lại)',
        },
      }).catch(() => { /* fail-open */ })
    }

    // (1) Đề xuất completed trong 48h chưa có verify row completed
    const since = new Date(Date.now() - SWEEP_WINDOW_MS)
    const proposals = await db.selfDirectionProposal.findMany({
      where: {
        createdBy: ALISTA_AGENT_NAME,
        status: 'completed',
        completedAt: { gte: since },
      },
      select: { id: true },
      orderBy: { completedAt: 'desc' },
      take: 20,
    })
    if (proposals.length === 0) return 0

    const ids = proposals.map(p => p.id)
    const existing = await db.taskExecution.findMany({
      where: { type: 'alista-verify', jobId: { in: ids }, status: 'completed' },
      select: { jobId: true },
    })
    const verified = new Set(existing.map(e => e.jobId))

    let notified = 0
    for (const p of proposals) {
      if (notified >= SWEEP_NOTIFY_CAP) break
      if (verified.has(p.id)) continue
      if (isVerifyInFlight(p.id)) continue
      await notifyAlistaProposalCompleted(p.id, 'sweep')
      notified++
    }
    return notified
  } catch (err) {
    console.warn(
      '[ALISTA][verify] sweep fail (fail-open — tick sau thử lại):',
      err instanceof Error ? err.message : String(err),
    )
    return 0
  }
}
