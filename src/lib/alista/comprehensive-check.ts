/**
 * ALISTA — Comprehensive Check Pipeline (v1.1)
 * ===============================================
 * Pipeline TUẦN TỰ 7 bước (KHÔNG song song):
 *   Mỗi bước = collect → rules → LLM proposal → TaskExecution step → re-check deadline
 *
 * Deadline 6h cứng (cron-nightly truyền 05:30 hôm sau, manual truyền now+10'):
 *   - Re-check deadline trước mỗi bước (sau bước trước)
 *   - Re-check deadline SAU collect (collector có thể chậm)
 *   - Re-check deadline SAU LLM (trong proposals.ts)
 *   - Trượt → graceful: trạng thái bước hiện tại = 'partial', các bước sau = 'skipped'
 *
 * State: globalThis.__alistaChecks Map<checkId, CheckResult> — chống HMR double.
 * UI poll route GET /api/alista/check?checkId=X đọc Map.
 */

import { db } from '@/lib/db'
import { randomUUID } from 'crypto'
import type {
  CheckResult, CheckTrigger, StepEntry, CheckId,
} from './types'
import { STEP_LABELS, STEP_ICONS } from './types'
import {
  collectToolsHealth, collectAgentRuns, collectEscalations,
  collectDomainCoverage, collect3Layers, collectSelfAssessment,
  collectDatabaseSystem, getPreviousSnapshot,
  type ThreeLayersData,
} from './collectors'
import { evaluateRules } from './rules'
import { createProposalsForCheck } from './proposals'
import type { CollectorResult } from './types'

// ==================== GLOBAL STATE (chống HMR double) ====================

const GLOBAL_KEY = '__alistaChecks'

function getGlobalMap(): Map<string, CheckResult> {
  const g = globalThis as unknown as { [key: string]: unknown }
  if (!g[GLOBAL_KEY] || !(g[GLOBAL_KEY] instanceof Map)) {
    g[GLOBAL_KEY] = new Map<string, CheckResult>()
  }
  return g[GLOBAL_KEY] as Map<string, CheckResult>
}

/** Route GET /api/alista/check?checkId=X đọc state */
export function getCheckState(checkId: string): CheckResult | undefined {
  return getGlobalMap().get(checkId)
}

/** Route GET /api/alista/checks đọc danh sách */
export function listChecks(limit = 20): CheckResult[] {
  const all = Array.from(getGlobalMap().values())
  return all.sort((a, b) => b.startedAt - a.startedAt).slice(0, limit)
}

// ==================== MAIN PIPELINE ====================

const CHECK_IDS: CheckId[] = [1, 2, 3, 4, 5, 6, 7]

const DEFAULT_BUDGET_MS = 6 * 3600_000 // 6h — fallback nếu cron không truyền deadlineMs
const MANUAL_SOFT_BUDGET_MS = 10 * 60_000 // 10' mềm cho UI poll
const MAX_PROPOSALS_PER_RUN = 6 // cap tổng ca trực

/**
 * Pipeline kiểm tra toàn diện 7 bước tuần tự.
 *
 * @param opts.trigger 'manual' (nút UI) | 'cron-nightly' (23h30)
 * @param opts.checkId UUID do route POST sinh trước (để route trả về ngay cho
 *        client poll); nếu không truyền thì tự sinh.
 * @param opts.deadlineMs epoch ms — cron truyền 05:30 hôm sau, manual truyền now+10'
 * @param opts.force bỏ qua dedupe tuần (chỉ cron dùng, manual luôn force=true)
 */
export async function runComprehensiveCheck(opts: {
  trigger: CheckTrigger
  checkId?: string
  force?: boolean
  deadlineMs?: number
}): Promise<CheckResult> {
  const startedAt = Date.now()
  const deadlineMs = opts.deadlineMs ?? (startedAt + (opts.trigger === 'manual' ? MANUAL_SOFT_BUDGET_MS : DEFAULT_BUDGET_MS))
  const checkId = opts.checkId || randomUUID()

  // Init state
  const result: CheckResult = {
    checkId, trigger: opts.trigger, startedAt,
    deadlineMs, deadlineMet: false, status: 'running',
    steps: [], proposalsCreated: [], partialSteps: [],
    reason: 'all_checks_done',
  }
  getGlobalMap().set(checkId, result)

  // Tạo TaskExecution row (status='running') — lịch sử hiện hình dần
  let taskExecutionId: string | null = null
  try {
    const taskRow = await db.taskExecution.create({
      data: {
        type: 'alista-check',
        status: 'running',
        startedAt: new Date(startedAt),
        result: JSON.stringify({ checkId, trigger: opts.trigger, deadlineMs, force: !!opts.force }),
      },
    })
    taskExecutionId = taskRow.id
  } catch (err) {
    console.warn('[ALISTA][check] TaskExecution create fail (không chặn pipeline):', err instanceof Error ? err.message : String(err))
  }

  const allProposals: Array<{ id: string; title: string }> = []
  const perCheckResults: Array<{ checkId: CheckId; label: string; result: CollectorResult }> = []
  let threeLayersData: ThreeLayersData | undefined = undefined
  let capReached = false

  // Pre-fetch previousSnapshot cho ⑤ — không chặn (fail-open)
  const previousSnapshot = await getPreviousSnapshot().catch(() => undefined)

  try {
    for (let idx = 0; idx < CHECK_IDS.length; idx++) {
      const checkIdNum = CHECK_IDS[idx]

      // (0) Re-check deadline TRƯỚC bước
      if (Date.now() >= deadlineMs) {
        for (let j = idx; j < CHECK_IDS.length; j++) {
          const rem = CHECK_IDS[j]
          result.steps.push({
            id: rem, label: STEP_LABELS[rem], icon: STEP_ICONS[rem],
            status: 'skipped', startedAt: Date.now(),
            skipReason: 'budget_exhausted (pre-check)',
          })
          result.partialSteps.push({ step: rem, label: STEP_LABELS[rem], reason: 'budget_exhausted' })
        }
        result.reason = 'budget_exhausted'
        break
      }

      const stepStart = Date.now()
      const stepEntry: StepEntry = {
        id: checkIdNum, label: STEP_LABELS[checkIdNum], icon: STEP_ICONS[checkIdNum],
        status: 'running', startedAt: stepStart,
      }
      result.steps.push(stepEntry)

      try {
        // (a) Collect — 1 collector tại 1 thời điểm (tuần tự)
        let collected: CollectorResult
        switch (checkIdNum) {
          case 1: collected = await collectToolsHealth(); break
          case 2: collected = await collectAgentRuns(); break
          case 3: collected = await collectEscalations(); break
          case 4: collected = await collectDomainCoverage(); break
          case 5: collected = await collect3Layers(previousSnapshot); break
          case 6: collected = await collectSelfAssessment(perCheckResults); break
          case 7: collected = await collectDatabaseSystem(); break
          default: collected = { ok: false, error: 'unknown check' }
        }
        stepEntry.collectMs = collected.collectMs
        stepEntry.collected = { ok: collected.ok, error: collected.error, data: collected.data }

        if (checkIdNum === 5 && collected.ok && collected.data) {
          threeLayersData = collected.data as ThreeLayersData
        }

        perCheckResults.push({ checkId: checkIdNum, label: STEP_LABELS[checkIdNum], result: collected })

        if (!collected.ok) {
          stepEntry.status = 'failed'
          stepEntry.error = collected.error
          stepEntry.durationMs = Date.now() - stepStart
          await updateRunningTaskExecution(taskExecutionId, result)
          continue
        }

        // (1) Re-check deadline SAU collect
        if (Date.now() >= deadlineMs) {
          stepEntry.status = 'partial'
          stepEntry.skipReason = 'budget_exhausted (sau collect)'
          stepEntry.durationMs = Date.now() - stepStart
          for (let j = idx + 1; j < CHECK_IDS.length; j++) {
            const rem = CHECK_IDS[j]
            result.steps.push({
              id: rem, label: STEP_LABELS[rem], icon: STEP_ICONS[rem],
              status: 'skipped', startedAt: Date.now(),
              skipReason: 'budget_exhausted',
            })
            result.partialSteps.push({ step: rem, label: STEP_LABELS[rem], reason: 'budget_exhausted' })
          }
          result.reason = 'budget_exhausted'
          break
        }

        // (b) Rules → findings deterministic
        const findings = evaluateRules(checkIdNum, collected.data, threeLayersData)
        stepEntry.findings = findings

        if (findings.length === 0) {
          stepEntry.status = 'completed'
          stepEntry.proposalCount = 0
          stepEntry.durationMs = Date.now() - stepStart
          await updateRunningTaskExecution(taskExecutionId, result)
          continue
        }

        // (c) Proposals — LLM viết 4 phần + dedupe + createSelfDirectionProposal
        // (chỉ tạo nếu chưa đạt cap 6 ca trực)
        if (capReached) {
          // Đã đạt cap — vẫn ghi findings để owner xem, không tạo proposal mới
          stepEntry.status = 'completed'
          stepEntry.proposalCount = 0
          stepEntry.durationMs = Date.now() - stepStart
          stepEntry.skipReason = 'cap_6_proposals_da_dat'
          await updateRunningTaskExecution(taskExecutionId, result)
          continue
        }

        const created = await createProposalsForCheck(checkIdNum, findings, { deadlineMs })
        const newProposals = created.filter(c => c.created).map(c => ({ id: c.id, title: c.title }))
        stepEntry.proposalsCreated = newProposals
        stepEntry.proposalCount = newProposals.length
        allProposals.push(...newProposals)

        if (allProposals.length >= MAX_PROPOSALS_PER_RUN) {
          capReached = true
          console.log(`[ALISTA][check] đã đạt cap ${MAX_PROPOSALS_PER_RUN} proposals — các bước còn lại chỉ collect, không tạo proposal mới`)
        }

        // (2) Re-check deadline SAU LLM
        if (Date.now() >= deadlineMs) {
          stepEntry.status = 'partial'
          stepEntry.skipReason = 'budget_exhausted (sau LLM)'
          stepEntry.durationMs = Date.now() - stepStart
          for (let j = idx + 1; j < CHECK_IDS.length; j++) {
            const rem = CHECK_IDS[j]
            result.steps.push({
              id: rem, label: STEP_LABELS[rem], icon: STEP_ICONS[rem],
              status: 'skipped', startedAt: Date.now(),
              skipReason: 'budget_exhausted',
            })
            result.partialSteps.push({ step: rem, label: STEP_LABELS[rem], reason: 'budget_exhausted' })
          }
          result.reason = 'budget_exhausted'
          break
        }

        stepEntry.status = 'completed'
      } catch (err) {
        // Fail-open — bước lỗi không die cả pipeline
        stepEntry.status = 'failed'
        stepEntry.error = err instanceof Error ? err.message : String(err)
        console.warn(`[ALISTA][check] bước ${checkIdNum} fail-open:`, stepEntry.error)
      }

      stepEntry.durationMs = Date.now() - stepStart
      // Update TaskExecution ngay tại bước (lịch sử hiện hình dần)
      await updateRunningTaskExecution(taskExecutionId, result)
    }

    // Finalize
    result.completedAt = Date.now()
    result.durationMs = result.completedAt - startedAt
    result.deadlineMet = Date.now() < deadlineMs
    result.status = 'completed'
    result.proposalsCreated = allProposals
    if (result.reason !== 'budget_exhausted') {
      result.reason = result.steps.some(s => s.status === 'failed') ? 'partial_failures' : 'all_checks_done'
    }

    // Cập nhật globalState (replace object trong Map)
    getGlobalMap().set(checkId, { ...result })

    // Finalize TaskExecution
    if (taskExecutionId) {
      try {
        await db.taskExecution.update({
          where: { id: taskExecutionId },
          data: {
            status: 'completed',
            completedAt: new Date(),
            result: JSON.stringify({
              checkId, trigger: opts.trigger,
              startedAt, completedAt: result.completedAt,
              durationMs: result.durationMs,
              deadlineMs, deadlineMet: result.deadlineMet,
              reason: result.reason, force: !!opts.force,
              perCheck: result.steps.map(s => ({
                id: s.id, label: s.label, status: s.status,
                collectMs: s.collectMs, durationMs: s.durationMs,
                findingsCount: s.findings?.length ?? 0,
                proposalsCreated: s.proposalCount ?? 0,
                error: s.error, skipReason: s.skipReason,
              })),
              proposalsCreated: result.proposalsCreated,
              partialSteps: result.partialSteps,
            }),
          },
        })
      } catch (err) {
        console.warn('[ALISTA][check] TaskExecution finalize fail:', err instanceof Error ? err.message : String(err))
      }
    }

    console.log(
      `[ALISTA][check] Hoàn tất: ${result.proposalsCreated.length} proposal mới, ${result.durationMs}ms, ` +
      `deadlineMet=${result.deadlineMet}, trigger=${opts.trigger}, reason=${result.reason}`,
    )

    return result
  } catch (err) {
    // Top-level catch — pipeline chết
    result.status = 'failed'
    result.error = err instanceof Error ? err.message : String(err)
    result.completedAt = Date.now()
    result.durationMs = result.completedAt - startedAt
    result.reason = 'error'
    getGlobalMap().set(checkId, { ...result })

    if (taskExecutionId) {
      try {
        await db.taskExecution.update({
          where: { id: taskExecutionId },
          data: {
            status: 'failed',
            completedAt: new Date(),
            errorMessage: result.error,
            result: JSON.stringify({
              checkId, trigger: opts.trigger, error: result.error,
              partialSteps: result.partialSteps,
              completedSteps: result.steps.filter(s => s.status === 'completed').length,
            }),
          },
        })
      } catch { /* fail-open */ }
    }

    console.error(`[ALISTA][check] Pipeline FAILED:`, result.error)
    return result
  }
}

// ==================== HELPERS ====================

/** Cập nhật TaskExecution row đang 'running' với partial state sau mỗi bước */
async function updateRunningTaskExecution(id: string | null, result: CheckResult): Promise<void> {
  if (!id) return
  try {
    await db.taskExecution.update({
      where: { id },
      data: {
        result: JSON.stringify({
          checkId: result.checkId, trigger: result.trigger,
          status: 'running',
          deadlineMs: result.deadlineMs,
          partialSteps: result.partialSteps,
          perCheck: result.steps.map(s => ({
            id: s.id, label: s.label, status: s.status,
            collectMs: s.collectMs, durationMs: s.durationMs,
            findingsCount: s.findings?.length ?? 0,
            proposalsCreated: s.proposalCount ?? 0,
            error: s.error, skipReason: s.skipReason,
          })),
          proposalsCreatedSoFar: result.proposalsCreated.length,
        }),
      },
    })
  } catch { /* fail-open */ }
}
