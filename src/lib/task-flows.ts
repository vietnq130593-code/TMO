/**
 * TASK FLOW — Quy trình tự động hóa THIẾT KẾ ĐƯỢC
 * ====================================
 * (user request 2026-09-13) — trước đây section "Task Flow" của module
 * Smolab > Automation chỉ là minh họa tĩnh (Trigger → Action → Condition →
 * Result). Giờ là hệ thống THẬT:
 *
 *   • Flow = chuỗi bước có thứ tự, mỗi bước 1 trong 4 loại:
 *       - trigger   : cron (expression) | webhook (events) | manual
 *       - action    : agent_task (LLM thực thi taskPrompt) | webhook (HTTP POST)
 *       - condition : cổng logic — LLM đánh giá mô tả điều kiện dựa trên kết quả
 *                     các bước trước → đúng mới chạy tiếp, sai thì DỪNG flow
 *       - result    : log (ghi tóm tắt) | notify (bắn event tới webhooks đăng
 *                     ký sự kiện task_flow.result)
 *
 *   • Ai thiết kế/tinh chỉnh: USER (UI designer trong Smolab > Automation)
 *     + OMEGA (tool manage_automation action create_flow/update_flow) — đúng
 *     yêu cầu "Task Flow có thể thiết kế để can thiệp tinh chỉnh được, ngoài
 *     tôi ra thì Omega cũng có thể làm được điều này".
 *
 *   • Thực thi:
 *       - Trigger cron đến hạn → scheduler poll (/api/openclaw/automation/
 *         scheduler, client gọi mỗi 30s) → runDueTaskFlows()
 *       - Chạy tay → POST /api/task-flows/[id]?action=run (UI nút "Chạy ngay")
 *       - Mỗi lần chạy ghi TaskExecution (type='task_flow') — hiện trong
 *         "Lịch sử thực thi" của module Automation như cron/webhook.
 *
 *   • Mọi bước fail-open theo cấp flow: 1 action lỗi → flow đánh dấu failed
 *     kèm lỗi cụ thể (KHÔNG ném exception ra caller — caller trả response).
 */

import { db } from '@/lib/db'
import { callLLMForAgent } from '@/lib/llm'
import { buildStandingOrdersContext, approximateNextRun, validateWebhookUrl } from '@/lib/automation-engine'

// ==================== TYPES ====================

export type TaskFlowStepType = 'trigger' | 'action' | 'condition' | 'result'

export interface TaskFlowStepConfig {
  // ===== trigger =====
  /** trigger.kind: 'cron' | 'webhook' | 'manual' */
  kind?: string
  /** trigger kind='cron': cron expression (vd "0 9 * * 1-5" hoặc "5-59/5 * * * *") */
  expression?: string
  /** trigger kind='webhook': danh sách event cần lắng nghe */
  events?: string[]
  // ===== action =====
  /** action.kind: 'agent_task' | 'webhook' */
  /** action kind='agent_task': mô tả nhiệm vụ LLM thực thi */
  taskPrompt?: string
  /** action kind='webhook': URL đích HTTP POST */
  url?: string
  /** action kind='webhook': payload JSON đính kèm (tùy chọn) */
  payload?: string
  // ===== condition =====
  /** condition: mô tả điều kiện tiếp tục (LLM đánh giá true/false) */
  description?: string
  // ===== result =====
  /** result.kind: 'log' | 'notify' */
  resultKind?: string
  /** result: ghi chú hiển thị trong tóm tắt */
  note?: string
}

export interface TaskFlowStep {
  id: string
  type: TaskFlowStepType
  title: string
  config: TaskFlowStepConfig
}

export interface TaskFlowRecord {
  id: string
  name: string
  description: string
  steps: TaskFlowStep[]
  enabled: boolean
  createdBy: string
  lastRunAt: Date | null
  nextRunAt: Date | null
  createdAt: Date
  updatedAt: Date
}

export interface TaskFlowRunStepResult {
  stepId: string
  title: string
  type: TaskFlowStepType
  success: boolean
  /** 'executed' | 'skipped' | 'stopped' | 'failed' */
  outcome: 'executed' | 'skipped' | 'stopped' | 'failed'
  summary: string
  durationMs: number
}

export interface TaskFlowRunResult {
  success: boolean
  flowId: string
  flowName: string
  trigger: string
  steps: TaskFlowRunStepResult[]
  stoppedAtStep: string | null
  stopReason: string | null
  durationMs: number
  error?: string
}

// ==================== VALIDATION ====================

const STEP_TYPES: TaskFlowStepType[] = ['trigger', 'action', 'condition', 'result']
const TRIGGER_KINDS = ['cron', 'webhook', 'manual']
const ACTION_KINDS = ['agent_task', 'webhook']
const RESULT_KINDS = ['log', 'notify']
const MAX_STEPS = 20

function genStepId(): string {
  return `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

/** Chuẩn hóa 1 bước thô (từ UI/LLM) → TaskFlowStep hợp lệ; trả null nếu rác */
function normalizeStep(raw: unknown): TaskFlowStep | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const type = String(r.type || '') as TaskFlowStepType
  if (!STEP_TYPES.includes(type)) return null
  const title = String(r.title || '').trim().slice(0, 200) || `${type} step`
  const rawConfig = (r.config && typeof r.config === 'object' ? r.config : {}) as Record<string, unknown>
  const config: TaskFlowStepConfig = {}
  if (type === 'trigger') {
    const kind = String(rawConfig.kind || 'manual')
    config.kind = TRIGGER_KINDS.includes(kind) ? kind : 'manual'
    if (config.kind === 'cron') {
      const expr = String(rawConfig.expression || '').trim()
      if (!expr) return null
      config.expression = expr.slice(0, 100)
    }
    if (config.kind === 'webhook') {
      const events = Array.isArray(rawConfig.events) ? rawConfig.events.map(e => String(e).trim()).filter(Boolean) : []
      config.events = events.slice(0, 10)
    }
  } else if (type === 'action') {
    const kind = String(rawConfig.kind || 'agent_task')
    config.kind = ACTION_KINDS.includes(kind) ? kind : 'agent_task'
    if (config.kind === 'agent_task') {
      const tp = String(rawConfig.taskPrompt || '').trim()
      if (!tp) return null
      config.taskPrompt = tp.slice(0, 4000)
    } else {
      const url = String(rawConfig.url || '').trim()
      if (!url) return null
      config.url = url.slice(0, 1000)
      if (rawConfig.payload) config.payload = String(rawConfig.payload).slice(0, 2000)
    }
  } else if (type === 'condition') {
    const desc = String(rawConfig.description || '').trim()
    if (!desc) return null
    config.description = desc.slice(0, 1000)
  } else {
    const rk = String(rawConfig.resultKind || 'log')
    config.resultKind = RESULT_KINDS.includes(rk) ? rk : 'log'
    if (rawConfig.note) config.note = String(rawConfig.note).slice(0, 500)
  }
  const id = typeof r.id === 'string' && r.id.trim() ? r.id.trim().slice(0, 40) : genStepId()
  return { id, type, title, config }
}

/** Validate + chuẩn hóa input flow (UI POST/PUT hoặc tool manage_automation) */
export function validateTaskFlowInput(input: {
  name?: unknown
  description?: unknown
  steps?: unknown
  enabled?: unknown
  createdBy?: unknown
}): { ok: true; data: { name: string; description: string; steps: TaskFlowStep[]; enabled: boolean; createdBy: string } } | { ok: false; error: string } {
  const name = String(input.name || '').trim()
  if (!name) return { ok: false, error: 'Thiếu tên flow (name)' }
  if (!Array.isArray(input.steps) || input.steps.length === 0) {
    return { ok: false, error: 'Flow cần ít nhất 1 bước (steps)' }
  }
  if (input.steps.length > MAX_STEPS) {
    return { ok: false, error: `Tối đa ${MAX_STEPS} bước/flow` }
  }
  const steps: TaskFlowStep[] = []
  for (const [i, raw] of input.steps.entries()) {
    const s = normalizeStep(raw)
    if (!s) return { ok: false, error: `Bước #${i + 1} không hợp lệ (thiếu config theo loại ${String((raw as Record<string, unknown>)?.type || '?')})` }
    steps.push(s)
  }
  // Flow phải có ít nhất 1 action — trigger/condition/result đơn thuần không làm việc gì
  if (!steps.some(s => s.type === 'action')) {
    return { ok: false, error: 'Flow cần ít nhất 1 bước action (agent_task hoặc webhook)' }
  }
  // Chỉ 1 trigger duy nhất, phải ở đầu nếu có
  const triggerCount = steps.filter(s => s.type === 'trigger').length
  if (triggerCount > 1) return { ok: false, error: 'Flow chỉ được có 1 bước trigger' }
  if (triggerCount === 1 && steps[0].type !== 'trigger') {
    return { ok: false, error: 'Bước trigger phải là bước ĐẦU TIÊN của flow' }
  }
  return {
    ok: true,
    data: {
      name: name.slice(0, 150),
      description: input.description ? String(input.description).slice(0, 1000) : '',
      steps,
      enabled: input.enabled === undefined ? true : Boolean(input.enabled),
      createdBy: input.createdBy ? String(input.createdBy).slice(0, 100) : 'user',
    },
  }
}

// ==================== ROW ↔ RECORD ====================

function rowToRecord(row: {
  id: string; name: string; description: string; stepsJson: string
  enabled: boolean; createdBy: string
  lastRunAt: Date | null; nextRunAt: Date | null; createdAt: Date; updatedAt: Date
}): TaskFlowRecord {
  let steps: TaskFlowStep[] = []
  try {
    const parsed = JSON.parse(row.stepsJson)
    if (Array.isArray(parsed)) {
      steps = parsed.map(normalizeStep).filter((s): s is TaskFlowStep => s !== null)
    }
  } catch { /* stepsJson rác → flow rỗng — UI hiển thị cảnh báo */ }
  return {
    id: row.id, name: row.name, description: row.description, steps,
    enabled: row.enabled, createdBy: row.createdBy,
    lastRunAt: row.lastRunAt, nextRunAt: row.nextRunAt,
    createdAt: row.createdAt, updatedAt: row.updatedAt,
  }
}

// ==================== CRUD ====================

export async function listTaskFlows(): Promise<TaskFlowRecord[]> {
  const rows = await db.taskFlow.findMany({ orderBy: { createdAt: 'desc' } })
  return rows.map(rowToRecord)
}

export async function getTaskFlow(id: string): Promise<TaskFlowRecord | null> {
  const row = await db.taskFlow.findUnique({ where: { id } })
  return row ? rowToRecord(row) : null
}

export async function createTaskFlow(input: {
  name: string; description: string; steps: TaskFlowStep[]; enabled: boolean; createdBy: string
}): Promise<TaskFlowRecord> {
  // Cron trigger → nextRunAt ngay (scheduler sẽ tự pick khi đến hạn)
  const first = input.steps.find(s => s.type === 'trigger')
  const nextRunAt = input.enabled && first?.config.kind === 'cron' && first.config.expression
    ? approximateNextRun(first.config.expression)
    : null
  const row = await db.taskFlow.create({
    data: {
      name: input.name,
      description: input.description,
      stepsJson: JSON.stringify(input.steps),
      enabled: input.enabled,
      createdBy: input.createdBy,
      nextRunAt,
    },
  })
  console.log(`[TaskFlow] Tạo flow "${input.name}" (${input.steps.length} bước, trigger=${first?.config.kind || 'manual'}, createdBy=${input.createdBy})`)
  return rowToRecord(row)
}

export async function updateTaskFlow(
  id: string,
  patch: { name?: string; description?: string; steps?: TaskFlowStep[]; enabled?: boolean },
): Promise<TaskFlowRecord | null> {
  const existing = await db.taskFlow.findUnique({ where: { id } })
  if (!existing) return null
  const data: Record<string, unknown> = {}
  if (patch.name !== undefined) data.name = String(patch.name).slice(0, 150)
  if (patch.description !== undefined) data.description = String(patch.description).slice(0, 1000)
  if (patch.steps !== undefined) data.stepsJson = JSON.stringify(patch.steps)
  if (patch.enabled !== undefined) data.enabled = Boolean(patch.enabled)
  // Đổi steps (trigger) hoặc enabled → tính lại nextRunAt
  if (patch.steps !== undefined || patch.enabled !== undefined) {
    const steps = patch.steps ?? rowToRecord(existing).steps
    const first = steps.find(s => s.type === 'trigger')
    const enabled = patch.enabled ?? existing.enabled
    data.nextRunAt = enabled && first?.config.kind === 'cron' && first.config.expression
      ? approximateNextRun(first.config.expression)
      : null
  }
  const row = await db.taskFlow.update({ where: { id }, data })
  console.log(`[TaskFlow] Cập nhật flow "${row.name}" (${Object.keys(data).join(', ')})`)
  return rowToRecord(row)
}

export async function deleteTaskFlow(id: string): Promise<boolean> {
  const existing = await db.taskFlow.findUnique({ where: { id } })
  if (!existing) return false
  await db.taskFlow.delete({ where: { id } })
  console.log(`[TaskFlow] Xóa flow "${existing.name}"`)
  return true
}

// ==================== EXECUTION ====================

/** Não dùng cho các bước flow: callLLMForAgent (kimi-k3 + fallback chain +
 * z-ai-sdk self-heal cuối chuỗi — callLLM thuần thiếu lớp fallback này khi
 * NVIDIA keys 401/cooldown, flow sẽ chết oan — phát hiện E2E 2026-09-13). */
const FLOW_BRAIN = { provider: 'nvidia', model: 'moonshotai/kimi-k3' }

/** LLM gate cho bước condition — trả true nếu flow được phép chạy tiếp */
async function evaluateCondition(description: string, contextSoFar: string): Promise<{ proceed: boolean; reason: string }> {
  try {
    const systemPrompt = `Bạn là CỔNG ĐIỀU KIỆN của 1 task flow tự động hóa. Dựa trên KẾT QUẢ các bước đã chạy, đánh giá điều kiện có ĐẠT hay KHÔNG.
Output DUY NHẤT JSON: {"proceed": true|false, "reason": "lý do ngắn (tiếng Việt)"}`
    const userPrompt = `ĐIỀU KIỆN CẦN ĐÁNH GIÁ:
${description}

KẾT QUẢ CÁC BƯỚC ĐÃ CHẠY:
${contextSoFar.slice(-4000) || '(chưa có bước nào chạy)'}

Điều kiện có đạt không — flow có nên chạy tiếp bước kế tiếp? (JSON)`
    const res = await callLLMForAgent(userPrompt, FLOW_BRAIN, systemPrompt, {
      agentId: 'task-flow-engine',
      agentName: 'Task Flow (condition gate)',
      temperature: 0.2,
      maxTokens: 300,
    })
    const m = res.content.match(/\{[\s\S]*\}/)
    if (m) {
      const obj = JSON.parse(m[0]) as { proceed?: unknown; reason?: unknown }
      return {
        proceed: obj.proceed === true,
        reason: typeof obj.reason === 'string' ? obj.reason.slice(0, 300) : '',
      }
    }
    // Parse fail → mặc định cho chạy tiếp (fail-open — condition không được giết flow vì lỗi parse)
    return { proceed: true, reason: '(đánh giá không parse được — mặc định cho chạy tiếp)' }
  } catch {
    return { proceed: true, reason: '(đánh giá lỗi — fail-open cho chạy tiếp)' }
  }
}

/** Action agent_task: LLM thực thi nhiệm vụ (pattern executeCronJob của automation-engine) */
async function runAgentTask(taskPrompt: string, flowContext: string): Promise<{ success: boolean; content: string; error?: string }> {
  const standingOrdersCtx = await buildStandingOrdersContext()
  const systemPrompt = `You are the Magnum Opus Task Flow Agent. You execute one step of an automated task flow autonomously.

Current step task: "${taskPrompt}"
${flowContext ? `\nKết quả các bước trước trong flow:\n${flowContext.slice(-2000)}\n` : ''}
${standingOrdersCtx}

Execute this step concisely. Report what you checked, found, or did. Be factual and brief.`
  const res = await callLLMForAgent(taskPrompt, FLOW_BRAIN, systemPrompt, {
    agentId: 'task-flow-engine',
    agentName: 'Task Flow (agent task)',
    temperature: 0.5,
    maxTokens: 1500,
  })
  if (res.content) return { success: true, content: res.content }
  return { success: false, content: '', error: res.error || 'LLM trả rỗng' }
}

/** Action webhook: HTTP POST outbound (SSRF-guard + 15s timeout) */
async function runWebhookAction(url: string, payloadStr: string | undefined, flowContext: { flowName: string }): Promise<{ success: boolean; httpStatus: number; body: string; error?: string }> {
  const check = validateWebhookUrl(url)
  if (!check.valid) return { success: false, httpStatus: 0, body: '', error: `URL bị chặn: ${check.reason}` }
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 15000)
    let body = payloadStr ?? ''
    if (!body) {
      body = JSON.stringify({ event: 'task_flow.webhook_action', flow: flowContext.flowName, timestamp: new Date().toISOString() })
    }
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'MagnumOpus-TaskFlow/1.0' },
      body,
      signal: controller.signal,
    })
    clearTimeout(timer)
    const text = await res.text().catch(() => '')
    return { success: res.status >= 200 && res.status < 300, httpStatus: res.status, body: text.slice(0, 500) }
  } catch (err) {
    return { success: false, httpStatus: 0, body: '', error: err instanceof Error ? err.message : String(err) }
  }
}

/** Result step kind='notify': bắn event tới webhooks đăng ký (tái dùng automation-engine) */
async function notifyResult(summary: string): Promise<void> {
  try {
    const { dispatchEventToWebhooks } = await import('@/lib/automation-engine')
    await dispatchEventToWebhooks('task_flow.result', { summary: summary.slice(0, 1000) })
  } catch { /* fail-open — notify không được làm hỏng flow */ }
}

/**
 * Chạy 1 task flow: thực thi tuần tự các bước action/condition/result.
 * Trigger step KHÔNG thực thi (đã fired — cron đến hạn / user bấm chạy).
 * Ghi TaskExecution (type='task_flow') + cập nhật lastRunAt/nextRunAt.
 */
export async function runTaskFlow(id: string, opts?: { trigger?: string }): Promise<TaskFlowRunResult> {
  const t0 = Date.now()
  const flow = await getTaskFlow(id)
  if (!flow) {
    return { success: false, flowId: id, flowName: '(không tìm thấy)', trigger: opts?.trigger || 'manual', steps: [], stoppedAtStep: null, stopReason: null, durationMs: 0, error: 'Flow không tồn tại' }
  }
  if (!flow.enabled) {
    return { success: false, flowId: id, flowName: flow.name, trigger: opts?.trigger || 'manual', steps: [], stoppedAtStep: null, stopReason: null, durationMs: Date.now() - t0, error: 'Flow đang TẮT (enabled=false)' }
  }

  const triggerLabel = opts?.trigger
    || (flow.steps.find(s => s.type === 'trigger')?.config.kind === 'cron' ? 'cron' : 'manual')
  const execution = await db.taskExecution.create({
    data: { jobId: flow.id, type: 'task_flow', status: 'running', startedAt: new Date() },
  })

  const stepResults: TaskFlowRunStepResult[] = []
  let contextSoFar = ''
  let stopped: { stepId: string; reason: string } | null = null
  let flowError: string | null = null

  console.log(`[TaskFlow] Chạy flow "${flow.name}" (${flow.steps.length} bước, trigger=${triggerLabel})`)

  for (const step of flow.steps) {
    const stepT0 = Date.now()
    try {
      if (step.type === 'trigger') {
        // Trigger đã fired — ghi nhận rồi bỏ qua
        stepResults.push({ stepId: step.id, title: step.title, type: step.type, success: true, outcome: 'skipped', summary: `Trigger ${step.config.kind || 'manual'} đã kích hoạt flow`, durationMs: 0 })
        continue
      }
      if (step.type === 'action') {
        if (step.config.kind === 'webhook' && step.config.url) {
          const r = await runWebhookAction(step.config.url, step.config.payload, { flowName: flow.name })
          stepResults.push({
            stepId: step.id, title: step.title, type: step.type,
            success: r.success, outcome: r.success ? 'executed' : 'failed',
            summary: r.success ? `HTTP ${r.httpStatus}: ${r.body.slice(0, 150)}` : (r.error || `HTTP ${r.httpStatus}`),
            durationMs: Date.now() - stepT0,
          })
          if (!r.success) {
            flowError = `Action "${step.title}" fail: ${r.error || `HTTP ${r.httpStatus}`}`
            break
          }
          contextSoFar += `\n[${step.title}] Webhook POST → HTTP ${r.httpStatus}`
        } else if (step.config.taskPrompt) {
          const r = await runAgentTask(step.config.taskPrompt, contextSoFar)
          stepResults.push({
            stepId: step.id, title: step.title, type: step.type,
            success: r.success, outcome: r.success ? 'executed' : 'failed',
            summary: r.success ? r.content.slice(0, 300) : (r.error || 'LLM lỗi'),
            durationMs: Date.now() - stepT0,
          })
          if (!r.success) {
            flowError = `Action "${step.title}" fail: ${r.error}`
            break
          }
          contextSoFar += `\n[${step.title}]\n${r.content.slice(0, 1500)}`
        }
        continue
      }
      if (step.type === 'condition') {
        const c = await evaluateCondition(step.config.description || '', contextSoFar)
        stepResults.push({
          stepId: step.id, title: step.title, type: step.type,
          success: true, outcome: c.proceed ? 'executed' : 'stopped',
          summary: c.proceed ? `Điều kiện ĐẠT — chạy tiếp (${c.reason || 'đạt'})` : `Điều kiện KHÔNG đạt — dừng flow (${c.reason || 'không đạt'})`,
          durationMs: Date.now() - stepT0,
        })
        if (!c.proceed) {
          stopped = { stepId: step.id, reason: c.reason || 'Điều kiện không đạt' }
          break
        }
        continue
      }
      // result
      const doneSteps = stepResults.filter(s => s.outcome === 'executed')
      const summary = `${step.config.note ? step.config.note + ' — ' : ''}Flow "${flow.name}" ${stopped ? 'dừng ở condition' : 'hoàn tất'}: ${doneSteps.length}/${flow.steps.filter(s => s.type === 'action').length} action đã chạy` +
        (doneSteps.length > 0 ? `. Kết quả cuối: ${doneSteps[doneSteps.length - 1].summary.slice(0, 300)}` : '')
      if (step.config.resultKind === 'notify') {
        await notifyResult(summary)
      }
      stepResults.push({ stepId: step.id, title: step.title, type: step.type, success: true, outcome: 'executed', summary, durationMs: Date.now() - stepT0 })
      continue
    } catch (err) {
      stepResults.push({
        stepId: step.id, title: step.title, type: step.type,
        success: false, outcome: 'failed',
        summary: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - stepT0,
      })
      flowError = `Bước "${step.title}" lỗi: ${err instanceof Error ? err.message : String(err)}`
      break
    }
  }

  // Nếu flow có result step nhưng bị break giữa chừng (action fail / condition dừng)
  // và CHƯA qua result step → vẫn ghi tóm tắt gọn cho context
  const success = !flowError && !stopped
  const durationMs = Date.now() - t0
  const triggerStep = flow.steps.find(s => s.type === 'trigger')
  const nextRunAt = triggerStep?.config.kind === 'cron' && triggerStep.config.expression
    ? approximateNextRun(triggerStep.config.expression)
    : null

  try {
    await db.taskExecution.update({
      where: { id: execution.id },
      data: {
        status: success ? 'completed' : (stopped ? 'completed' : 'failed'), // condition-dừng là kết thúc HỢP LỆ, không phải lỗi
        result: JSON.stringify({
          flowId: flow.id, flowName: flow.name, trigger: triggerLabel,
          steps: stepResults.map(s => ({ title: s.title, type: s.type, outcome: s.outcome, summary: s.summary.slice(0, 500) })),
          stoppedAtStep: stopped?.stepId ?? null, stopReason: stopped?.reason ?? null,
        }),
        errorMessage: flowError,
        completedAt: new Date(),
      },
    })
    await db.taskFlow.update({
      where: { id: flow.id },
      data: { lastRunAt: new Date(), nextRunAt },
    })
  } catch { /* fail-open — ghi lịch sử lỗi không làm hỏng kết quả trả về */ }

  console.log(`[TaskFlow] Flow "${flow.name}" ${success ? 'HOÀN TẤT' : stopped ? `DỪNG ở condition (${stopped.reason})` : `THẤT BẠI (${flowError})`} — ${stepResults.filter(s => s.outcome === 'executed').length}/${stepResults.length} bước chạy, ${Math.round(durationMs / 1000)}s`)

  return {
    success,
    flowId: flow.id,
    flowName: flow.name,
    trigger: triggerLabel,
    steps: stepResults,
    stoppedAtStep: stopped?.stepId ?? null,
    stopReason: stopped?.reason ?? null,
    durationMs,
    error: flowError ?? undefined,
  }
}

/**
 * Scheduler hook: chạy mọi flow enabled có trigger cron đến hạn.
 * Được gọi từ /api/openclaw/automation/scheduler (poll 30s từ UI).
 */
export async function runDueTaskFlows(): Promise<{ checked: number; executed: number; failed: number; results: Array<{ flowId: string; flowName: string; success: boolean; error?: string }> }> {
  const now = new Date()
  const due = await db.taskFlow.findMany({
    where: { enabled: true, nextRunAt: { lte: now } },
    select: { id: true },
  })
  // Lọc chỉ flow có trigger cron THẬT (nextRunAt chỉ set với cron trigger)
  const dueCronFlows: TaskFlowRecord[] = []
  for (const row of due) {
    const f = await getTaskFlow(row.id)
    if (f && f.steps.find(s => s.type === 'trigger')?.config.kind === 'cron') {
      dueCronFlows.push(f)
    }
  }
  const results: Array<{ flowId: string; flowName: string; success: boolean; error?: string }> = []
  let executed = 0
  let failed = 0
  for (const f of dueCronFlows) {
    const r = await runTaskFlow(f.id, { trigger: 'cron' })
    results.push({ flowId: f.id, flowName: f.name, success: r.success, error: r.error })
    if (r.success) executed++
    else failed++
  }
  return { checked: dueCronFlows.length, executed, failed, results }
}
