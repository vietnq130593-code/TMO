/**
 * AUTOMATION PROPOSALS — Luồng đề xuất automation từ agents
 * ====================================
 * (user request 2026-09-13) — "1 tools cho phép agents tạo cron jobs, thêm
 * webhook, standing orders và mặc định Omega sẽ được phép sử dụng quyền này,
 * các agents khác khi thấy cần thiết có thể đề xuất với Omega để Omega ra
 * quyết định có gửi đề xuất đó tới module Self-direction để chờ tôi hoặc
 * agents được ủy quyền phê duyệt".
 *
 * LUỒNG (2 đường):
 *
 *   1. OMEGA TRỰC TIẾP (tool manage_automation — chỉ Omega có trong whitelist):
 *      tạo/sửa/xóa cron job, webhook, standing order, task flow NGAY
 *      (không cần phê duyệt — đúng "mặc định Omega được phép sử dụng quyền này").
 *
 *   2. AGENTS KHÁC ĐỀ XUẤT (tool propose_automation — mọi agents có):
 *      agent thấy cần automation → propose_automation({kind, payload, reason})
 *      → OMEGA QUYẾT ĐỊNH (LLM, JSON verdict): forward hay từ chối
 *        • forward  → tạo SelfDirectionProposal (category='automation',
 *                     automationJson={kind, payload, proposedBy}, status
 *                     'pending') → hiển thị module Self-direction → chờ
 *                     Mr. Architect duyệt, hoặc Opus duyệt thay khi bật
 *                     ủy quyền (opusDelegated — user decision #3).
 *        • reject   → trả lý do ngay cho agent đề xuất (không tạo proposal)
 *      → ĐƯỢC DUYỆT → executeAutomationProposal() tạo tài nguyên THẬT
 *        (fast-path trong triggerOrchestration — hành động cơ khí, không cần
 *        Omega lập kế hoạch giao agents).
 *
 * Fail-open: mọi lỗi trả {success:false, error} — không crash loop của agent.
 */

import { db } from '@/lib/db'
import { callLLMForAgent } from '@/lib/llm'
import { findBalancedJson } from '@/lib/code-team/find-balanced-json'
import { approximateNextRun, validateAutomationExecutor } from '@/lib/automation-engine'
// CRON BUILDER (user request 2026-09-14): đề xuất cron dùng lịch có cấu trúc
import {
  validateCronSchedule,
  nextRunFromSchedule,
  scheduleToRepresentativeExpression,
  describeSchedule,
  type CronScheduleConfig,
} from '@/lib/cron-schedule'

// ==================== TYPES ====================

export type AutomationProposalKind = 'cron' | 'webhook' | 'standing_order' | 'task_flow'

export interface AutomationCronPayload {
  /** Cron expression (vd "0 9 * * 1-5") — đường legacy, dùng KHI KHÔNG có schedule */
  expression?: string
  /** Nhiệm vụ LLM chạy theo lịch */
  taskPrompt: string
  /** Lịch có cấu trúc (KHUYẾN KHÍCH — user request 2026-09-14):
   * {mode:'day'|'week'|'month', times:['09:30'], daysOfWeek?:[1,3], daysOfMonth?:[1,15], repeat:true} */
  schedule?: CronScheduleConfig
  /** Agent thực thi: '' (mặc định) | tên agent | 'team:xxx' (TL điều phối) */
  executor?: string
}

export interface AutomationWebhookPayload {
  /** URL đích (HTTPS công khai — SSRF guard khi execute) */
  url: string
  /** Danh sách event đăng ký (vd ['document.uploaded','*']) */
  events: string[]
  /** HMAC secret (tùy chọn) */
  secret?: string
}

export interface AutomationStandingOrderPayload {
  /** Nội dung chỉ thị thường trực */
  order: string
  /** 0-100 */
  priority?: number
}

export interface AutomationTaskFlowPayload {
  name: string
  description?: string
  /** Steps theo contract src/lib/task-flows.ts (validate lại khi execute) */
  steps: Array<Record<string, unknown>>
}

export interface AutomationRequest {
  kind: AutomationProposalKind
  payload: AutomationCronPayload | AutomationWebhookPayload | AutomationStandingOrderPayload | AutomationTaskFlowPayload
  /** Agent đề xuất (điền bởi executor từ context) */
  proposedBy: string
  /** Lý do cần automation */
  reason?: string
  /** Bằng chứng/dữ liệu hỗ trợ */
  evidence?: string
}

export interface AutomationDecision {
  /** true = gửi đề xuất vào Self-direction chờ duyệt; false = từ chối */
  forward: boolean
  reason: string
  tokensUsed: number
}

export interface SubmitAutomationResult {
  success: boolean
  forwarded: boolean
  proposalId?: string
  proposalTitle?: string
  omegaReason?: string
  error?: string
  tokensUsed: number
}

// ==================== VALIDATION ====================

const VALID_KINDS: AutomationProposalKind[] = ['cron', 'webhook', 'standing_order', 'task_flow']
const DECISION_TIMEOUT_MS = 3 * 60_000
const DECISION_MAX_TOKENS = 700
const OMEGA_FALLBACK_BRAIN = { provider: 'zen', model: 'space-bunny-free' } // 2026-11-30: minimax-m3 EOL 410 → production core zen

/** Validate + chuẩn hóa đề xuất automation (từ tool args — dữ liệu LLM, KHÔNG tin) */
export function validateAutomationRequest(
  kind: unknown,
  payload: unknown,
): { ok: true; data: { kind: AutomationProposalKind; payload: Record<string, unknown> } } | { ok: false; error: string } {
  const k = String(kind || '')
  if (!VALID_KINDS.includes(k as AutomationProposalKind)) {
    return { ok: false, error: `kind không hợp lệ ("${k}") — phải là 1 trong: ${VALID_KINDS.join(' | ')}` }
  }
  if (!payload || typeof payload !== 'object') {
    return { ok: false, error: 'Thiếu payload (object)' }
  }
  const p = payload as Record<string, unknown>
  if (k === 'cron') {
    const taskPrompt = String(p.taskPrompt || '').trim()
    if (!taskPrompt) return { ok: false, error: 'cron payload thiếu "taskPrompt" (nhiệm vụ chạy theo lịch)' }
    // CRON BUILDER: schedule có cấu trúc (ưu tiên) HOẶC expression thô (legacy)
    let schedule: CronScheduleConfig | undefined
    if (p.schedule !== undefined && p.schedule !== null) {
      const v = validateCronSchedule(p.schedule)
      if (!v.ok) return { ok: false, error: `cron payload schedule không hợp lệ: ${v.error}` }
      schedule = v.data
    }
    let expression = String(p.expression || '').trim()
    if (schedule) {
      // expression đại diện (deterministic — dùng cho dedup + hiển thị)
      expression = scheduleToRepresentativeExpression(schedule)
    }
    if (!expression) {
      return { ok: false, error: 'cron payload cần "schedule" {mode:"day"|"week"|"month", times:["09:30"], ...} HOẶC "expression" (vd "0 9 * * 1-5")' }
    }
    const executor = String(p.executor || '').trim()
    const out: Record<string, unknown> = {
      expression: expression.slice(0, 100),
      taskPrompt: taskPrompt.slice(0, 3000),
    }
    if (schedule) out.schedule = schedule
    if (executor) out.executor = executor.slice(0, 100)
    return { ok: true, data: { kind: 'cron', payload: out } }
  }
  if (k === 'webhook') {
    const url = String(p.url || '').trim()
    const events = Array.isArray(p.events) ? p.events.map(e => String(e).trim()).filter(Boolean) : []
    if (!url) return { ok: false, error: 'webhook payload thiếu "url"' }
    if (events.length === 0) return { ok: false, error: 'webhook payload thiếu "events" (ít nhất 1 event, vd ["document.uploaded"] hoặc ["*"])' }
    return {
      ok: true,
      data: {
        kind: 'webhook',
        payload: {
          url: url.slice(0, 1000),
          events: events.slice(0, 10),
          ...(p.secret ? { secret: String(p.secret).slice(0, 200) } : {}),
        },
      },
    }
  }
  if (k === 'standing_order') {
    const order = String(p.order || '').trim()
    if (!order) return { ok: false, error: 'standing_order payload thiếu "order" (nội dung chỉ thị)' }
    const priorityRaw = typeof p.priority === 'number' ? p.priority : parseInt(String(p.priority ?? '0'), 10)
    const priority = Number.isFinite(priorityRaw) ? Math.min(100, Math.max(0, Math.round(priorityRaw))) : 0
    return { ok: true, data: { kind: 'standing_order', payload: { order: order.slice(0, 2000), priority } } }
  }
  // task_flow — validate chi tiết qua validateTaskFlowInput lúc execute; đây chỉ check tối thiểu
  const name = String(p.name || '').trim()
  if (!name) return { ok: false, error: 'task_flow payload thiếu "name"' }
  if (!Array.isArray(p.steps) || p.steps.length === 0) {
    return { ok: false, error: 'task_flow payload thiếu "steps" (chuỗi bước Trigger→Action→Condition→Result)' }
  }
  return { ok: true, data: { kind: 'task_flow', payload: { name: name.slice(0, 150), description: String(p.description || '').slice(0, 1000), steps: p.steps.slice(0, 20) } } }
}

/** Mô tả đề xuất dạng text đọc được (problem/solution cho Self-direction) */
export function describeAutomationRequest(req: AutomationRequest): { title: string; problem: string; solution: string; implementation: string } {
  const by = req.proposedBy || 'agent'
  if (req.kind === 'cron') {
    const p = req.payload as AutomationCronPayload
    const scheduleDesc = p.schedule ? describeSchedule(p.schedule) : `expression ${p.expression}`
    const executorDesc = p.executor
      ? (p.executor.startsWith('team:') ? `Team "${p.executor.slice(5)}" (TL điều phối toàn bộ tác vụ)` : `Agent ${p.executor}`)
      : 'Automation Agent (mặc định)'
    return {
      title: `Cron job: ${p.taskPrompt.slice(0, 80)}`,
      problem: `Agent ${by} nhận thấy tác vụ cần chạy định kỳ nhưng chưa có lịch tự động: ${req.reason || '(agent không nêu lý do)'}`,
      solution: `Tạo cron job chạy theo lịch "${scheduleDesc}" — thực thi bởi ${executorDesc} — với nhiệm vụ: ${p.taskPrompt}`,
      implementation: `Thêm CronJob (lịch \`${scheduleDesc}\`, executor=${p.executor || 'mặc định'}) vào module Smolab > Automation — scheduler tự thực thi qua LLM theo chu kỳ. ${req.evidence ? `Bằng chứng: ${req.evidence}` : ''}`,
    }
  }
  if (req.kind === 'webhook') {
    const p = req.payload as AutomationWebhookPayload
    return {
      title: `Webhook: ${p.url.slice(0, 80)}`,
      problem: `Agent ${by} cần hệ thống gửi thông báo/sự kiện tới endpoint ngoài: ${req.reason || '(agent không nêu lý do)'}`,
      solution: `Đăng ký webhook ${p.url} nhận sự kiện: ${p.events.join(', ')}`,
      implementation: `Thêm Webhook (url=${p.url}, events=${p.events.join(',')}${p.secret ? ', có HMAC secret' : ''}) vào module Smolab > Automation — các sự kiện khớp sẽ được POST kèm chữ ký HMAC-SHA256. ${req.evidence ? `Bằng chứng: ${req.evidence}` : ''}`,
    }
  }
  if (req.kind === 'standing_order') {
    const p = req.payload as AutomationStandingOrderPayload
    return {
      title: `Standing order: ${p.order.slice(0, 80)}`,
      problem: `Agent ${by} đề xuất thêm chỉ thị thường trực cho mọi automation runs: ${req.reason || '(agent không nêu lý do)'}`,
      solution: `Thêm standing order (priority ${p.priority ?? 0}): "${p.order}"`,
      implementation: `Thêm StandingOrder vào module Smolab > Automation — nội dung được inject vào system prompt của cron/heartbeat/task-flow runs. ${req.evidence ? `Bằng chứng: ${req.evidence}` : ''}`,
    }
  }
  const p = req.payload as AutomationTaskFlowPayload
  return {
    title: `Task flow: ${p.name}`,
    problem: `Agent ${by} đề xuất quy trình tự động hóa nhiều bước: ${req.reason || '(agent không nêu lý do)'}`,
    solution: `Tạo task flow "${p.name}" (${p.steps.length} bước): ${p.steps.map(s => String((s as Record<string, unknown>).title || (s as Record<string, unknown>).type || '?')).join(' → ')}`,
    implementation: `Thêm TaskFlow vào module Smolab > Automation (thiết kế được, tinh chỉnh được) — trigger tự chạy theo lịch hoặc chạy tay. ${req.evidence ? `Bằng chứng: ${req.evidence}` : ''}`,
  }
}

// ==================== OMEGA DECISION ====================

/** Resolve Omega brain (pattern omega-orchestrator — fail-open fallback) */
async function resolveOmegaBrain(): Promise<{ provider: string; model: string; id: string | null }> {
  try {
    const omega = await db.agentProfile.findFirst({
      where: { name: 'Omega', enabled: true },
      select: { id: true, provider: true, model: true },
    })
    if (omega?.provider && omega?.model) return { provider: omega.provider, model: omega.model, id: omega.id }
  } catch { /* fail-open */ }
  return { provider: OMEGA_FALLBACK_BRAIN.provider, model: OMEGA_FALLBACK_BRAIN.model, id: null }
}

/**
 * OMEGA QUYẾT ĐỊNH: có gửi đề xuất automation này tới module Self-direction
 * (chờ Mr. Architect / agent được ủy quyền phê duyệt) hay từ chối ngay.
 */
export async function decideAutomationProposal(req: AutomationRequest): Promise<AutomationDecision> {
  try {
    const brain = await resolveOmegaBrain()
    const desc = describeAutomationRequest(req)
    // Đếm tài nguyên hiện có để Omega có bối cảnh (tránh trùng lặp)
    let existingNote = ''
    try {
      const [cronCount, webhookCount, orderCount, flowCount] = await Promise.all([
        db.cronJob.count({ where: { agentId: 'default', enabled: true } }),
        db.webhook.count({ where: { agentId: 'default', enabled: true } }),
        db.standingOrder.count({ where: { agentId: 'default', enabled: true } }),
        db.taskFlow.count({ where: { enabled: true } }),
      ])
      existingNote = `Hiện có: ${cronCount} cron jobs, ${webhookCount} webhooks, ${orderCount} standing orders, ${flowCount} task flows.`
    } catch { /* fail-open */ }

    const systemPrompt = `Bạn là OMEGA — orchestrator tổng chỉ huy của hệ thống multi-agent TMO.
Một agent dưới quyền vừa ĐỀ XUẤT tạo tài nguyên automation (cron job / webhook / standing order / task flow).
Bạn là người RA QUYẾT ĐỊNH: đề xuất này có đáng được gửi tới module Self-direction (chờ Mr. Architect hoặc agent được ủy quyền phê duyệt) không?

Tiêu chí cân nhắc:
- Đề xuất giải quyết nhu cầu THẬT, cụ thể, có lợi cho hệ thống/user?
- Lịch/endpoint/chỉ thị hợp lý, an toàn (không spam, không gọi endpoint lạ lùng, không chỉ thị mâu thuẫn)?
- Có trùng lặp với tài nguyên hiện có không?
- Đề xuất mơ hồ, lợi ích không rõ, rủi ro cao → TỪ CHỐI kèm lý do để agent đề xuất lại rõ hơn.

Output DUY NHẤT một JSON hợp lệ (KHÔNG markdown fence, KHÔNG giải thích ngoài):
{"forward": true|false, "reason": "lý do ngắn gọn (1-3 câu, tiếng Việt)"}`

    const userPrompt = `ĐỀ XUẤT AUTOMATION TỪ AGENT: ${req.proposedBy || 'unknown'}

LOẠI: ${req.kind}

NỘI DUNG:
${JSON.stringify(req.payload, null, 2).slice(0, 2500)}

LÝ DO AGENT NÊU:
${(req.reason || '(agent không nêu lý do)').slice(0, 1000)}

BẰNG CHỨNG/DỮ LIỆU HỖ TRỢ:
${(req.evidence || '(không có)').slice(0, 1000)}

BỐI CẢNH HỆ THỐNG: ${existingNote}

MÔ TẢ TÓM TẮT: ${desc.title}

Quyết định forward hay từ chối (JSON).`

    const result = await callLLMForAgent(userPrompt, { provider: brain.provider, model: brain.model }, systemPrompt, {
      agentId: brain.id || 'omega-orchestrator',
      agentName: 'Omega (automation decision)',
      temperature: 0.2,
      maxTokens: DECISION_MAX_TOKENS,
    })
    if (!result || !result.content) {
      // LLM fail → fail-open: VẪN forward (đề xuất vào hàng chờ duyệt — an toàn
      // hơn là làm mất đề xuất của agent; Mr. Architect duyệt ở Self-direction)
      return { forward: true, reason: '(Omega quyết định lỗi LLM — mặc định chuyển tiếp cho Mr. Architect duyệt)', tokensUsed: 0 }
    }
    const tokens = typeof result.tokensUsed === 'number' ? result.tokensUsed : 0
    const text = result.content.replace(/```(?:json)?/g, '')
    const jsonStr = findBalancedJson(text, 'forward')
    if (!jsonStr) {
      return { forward: true, reason: '(Omega verdict không parse được — mặc định chuyển tiếp cho Mr. Architect duyệt)', tokensUsed: tokens }
    }
    const obj = JSON.parse(jsonStr) as { forward?: unknown; reason?: unknown }
    return {
      forward: obj.forward === true,
      reason: typeof obj.reason === 'string' ? obj.reason.slice(0, 600) : '',
      tokensUsed: tokens,
    }
  } catch (err) {
    // Fail-open: quyết định lỗi → vẫn forward (không mất đề xuất của agent)
    return { forward: true, reason: `(Omega quyết định lỗi: ${err instanceof Error ? err.message : String(err)} — chuyển tiếp cho Mr. Architect duyệt)`, tokensUsed: 0 }
  }
}

// ==================== SUBMIT (tool propose_automation) ====================

/**
 * Agent đề xuất → Omega quyết định → (forward) tạo SelfDirectionProposal
 * category='automation' chờ duyệt. Trả kết quả đọc được cho agent.
 */
export async function submitAutomationProposal(req: AutomationRequest): Promise<SubmitAutomationResult> {
  try {
    // CRON BUILDER: validate executor NGAY lúc đề xuất (DB check) — agent đề xuất
    // executor không tồn tại → báo lỗi về agent thay vì để lỗi nổ lúc phê duyệt
    if (req.kind === 'cron') {
      const executorRaw = String(((req.payload as unknown as Record<string, unknown>).executor) || '').trim()
      const executorCheck = await validateAutomationExecutor(executorRaw)
      if (!executorCheck.ok) {
        return { success: false, forwarded: false, error: `executor không hợp lệ: ${executorCheck.error}`, tokensUsed: 0 }
      }
    }
    const desc = describeAutomationRequest(req)
    const decision = await decideAutomationProposal(req)
    if (!decision.forward) {
      return {
        success: true,
        forwarded: false,
        omegaReason: decision.reason || 'Omega từ chối (không nêu lý do)',
        tokensUsed: decision.tokensUsed,
      }
    }
    const automationJson = JSON.stringify({
      kind: req.kind,
      payload: req.payload,
      proposedBy: req.proposedBy,
      omegaReason: decision.reason,
      proposedAt: new Date().toISOString(),
    })
    const proposal = await db.selfDirectionProposal.create({
      data: {
        title: `[Automation] ${desc.title}`.slice(0, 200),
        category: 'automation',
        priority: 'medium',
        problem: `${desc.problem}\n\n🔐 LÝ do Omega chuyển tiếp: ${decision.reason || '(không nêu)'}`,
        solution: desc.solution,
        implementation: desc.implementation,
        status: 'pending',
        source: 'agent',
        createdBy: (req.proposedBy || 'agent').slice(0, 100),
        executionMode: 'llm',
        automationJson,
      },
    })
    console.log(`[AutomationProposal] Agent "${req.proposedBy}" đề xuất ${req.kind} → Omega FORWARD → Self-direction proposal ${proposal.id} (chờ phê duyệt)`)
    return {
      success: true,
      forwarded: true,
      proposalId: proposal.id,
      proposalTitle: proposal.title,
      omegaReason: decision.reason,
      tokensUsed: decision.tokensUsed,
    }
  } catch (err) {
    return { success: false, forwarded: false, error: err instanceof Error ? err.message : String(err), tokensUsed: 0 }
  }
}

// ==================== EXECUTE (khi được duyệt) ====================

/**
 * Được duyệt → tạo tài nguyên automation THẬT từ automationJson.
 * Gọi từ fast-path của triggerOrchestration (self-direction orchestrator).
 * Idempotent-guard: proposal đã completed → bỏ qua (chống double-run khi
 * promoteDueProposals trigger lại).
 */
export async function executeAutomationProposal(proposalId: string): Promise<{ success: boolean; detail: string }> {
  try {
    const proposal = await db.selfDirectionProposal.findUnique({ where: { id: proposalId } })
    if (!proposal) return { success: false, detail: 'Proposal không tồn tại' }
    if (proposal.status === 'completed') {
      return { success: true, detail: 'Proposal đã thực thi (completed) — bỏ qua' }
    }
    if (!proposal.automationJson) {
      return { success: false, detail: 'Proposal không có automationJson — không phải automation proposal' }
    }

    let parsed: { kind?: string; payload?: Record<string, unknown>; proposedBy?: string }
    try {
      parsed = JSON.parse(proposal.automationJson)
    } catch {
      await db.selfDirectionProposal.update({
        where: { id: proposalId },
        data: {
          status: 'failed',
          decisionReason: 'automationJson không parse được',
          executedAt: new Date(),
        },
      })
      return { success: false, detail: 'automationJson không parse được' }
    }

    const kind = String(parsed.kind || '')
    const payload = (parsed.payload || {}) as Record<string, unknown>
    const proposedBy = String(parsed.proposedBy || proposal.createdBy || 'unknown')
    const now = new Date()
    let resultDetail = ''

    if (kind === 'cron') {
      const expression = String(payload.expression || '').trim()
      const taskPrompt = String(payload.taskPrompt || '').trim()
      if (!expression || !taskPrompt) throw new Error('Payload cron thiếu expression/taskPrompt')
      // CRON BUILDER: lịch có cấu trúc (ưu tiên) + executor
      const schedule = payload.schedule
        ? validateCronSchedule(payload.schedule)
        : null
      if (payload.schedule && !schedule?.ok) {
        throw new Error(`Payload cron schedule không hợp lệ: ${schedule && !schedule.ok ? schedule.error : 'unknown'}`)
      }
      const scheduleCfg = schedule?.ok ? schedule.data : null
      const executorRaw = String(payload.executor || '').trim()
      const executorCheck = await validateAutomationExecutor(executorRaw)
      if (!executorCheck.ok) throw new Error(`Executor không hợp lệ: ${executorCheck.error}`)
      // IDEMPOTENT DEDUP GUARD (fix E2E 2026-09-13): proposal bị trigger lại
      // (promoteDueProposals / double-click approve) KHÔNG tạo cron trùng lặp —
      // cùng expression + taskPrompt → trả về job cũ.
      const existing = await db.cronJob.findFirst({
        where: { agentId: 'default', expression, taskPrompt },
        select: { id: true, nextRunAt: true },
      })
      if (existing) {
        resultDetail = `ℹ️ CronJob này đã tồn tại từ trước (id ${existing.id}) — không tạo trùng lặp.`
      } else {
        const job = await db.cronJob.create({
          data: {
            agentId: 'default',
            expression,
            taskPrompt,
            enabled: true,
            nextRunAt: scheduleCfg ? nextRunFromSchedule(scheduleCfg) : approximateNextRun(expression),
            scheduleJson: scheduleCfg ? JSON.stringify(scheduleCfg) : null,
            executor: executorCheck.value,
          },
        })
        const schedDesc = scheduleCfg ? describeSchedule(scheduleCfg) : `expression \`${expression}\``
        const execDesc = executorCheck.value
          ? (executorCheck.value.startsWith('team:') ? `Team "${executorCheck.value.slice(5)}" (TL điều phối)` : `Agent ${executorCheck.value}`)
          : 'Automation Agent (mặc định)'
        resultDetail = `✅ Đã tạo CronJob "${taskPrompt.slice(0, 100)}" (lịch ${schedDesc}, thực thi bởi ${execDesc}, chạy kế tiếp ${job.nextRunAt?.toISOString()}) — hiển thị trong module Smolab > Automation.`
      }
    } else if (kind === 'webhook') {
      const url = String(payload.url || '').trim()
      const events = Array.isArray(payload.events) ? payload.events.map(e => String(e)) : []
      if (!url || events.length === 0) throw new Error('Payload webhook thiếu url/events')
      const existing = await db.webhook.findFirst({ where: { agentId: 'default', url }, select: { id: true } })
      if (existing) {
        resultDetail = `ℹ️ Webhook \`${url}\` đã tồn tại từ trước (id ${existing.id}) — không tạo trùng lặp.`
      } else {
        await db.webhook.create({
          data: {
            agentId: 'default',
            url,
            events: JSON.stringify(events),
            secret: payload.secret ? String(payload.secret) : null,
            enabled: true,
          },
        })
        resultDetail = `✅ Đã đăng ký Webhook \`${url}\` (events: ${events.join(', ')}) — tự POST kèm HMAC-SHA256 khi sự kiện khớp.`
      }
    } else if (kind === 'standing_order') {
      const order = String(payload.order || '').trim()
      if (!order) throw new Error('Payload standing_order thiếu order')
      const priority = typeof payload.priority === 'number' ? payload.priority : 0
      const existing = await db.standingOrder.findFirst({ where: { agentId: 'default', order }, select: { id: true } })
      if (existing) {
        resultDetail = `ℹ️ Standing Order này đã tồn tại từ trước (id ${existing.id}) — không tạo trùng lặp.`
      } else {
        await db.standingOrder.create({
          data: { agentId: 'default', order, priority, enabled: true },
        })
        resultDetail = `✅ Đã thêm Standing Order (priority ${priority}): "${order.slice(0, 150)}" — inject vào mọi automation runs.`
      }
    } else if (kind === 'task_flow') {
      const { validateTaskFlowInput, createTaskFlow } = await import('@/lib/task-flows')
      const validated = validateTaskFlowInput({
        name: payload.name,
        description: payload.description,
        steps: payload.steps,
        enabled: true,
      })
      if (!validated.ok) throw new Error(`Task flow không hợp lệ: ${validated.error}`)
      const existing = await db.taskFlow.findFirst({ where: { name: validated.data.name }, select: { id: true } })
      if (existing) {
        resultDetail = `ℹ️ Task Flow "${validated.data.name}" đã tồn tại từ trước (id ${existing.id}) — không tạo trùng lặp.`
      } else {
        const flow = await createTaskFlow({ ...validated.data, createdBy: `self-direction (${proposedBy})` })
        resultDetail = `✅ Đã tạo Task Flow "${flow.name}" (${flow.steps.length} bước, trigger=${flow.steps.find(s => s.type === 'trigger')?.config.kind || 'manual'}) — thiết kế/tinh chỉnh trong module Smolab > Automation.`
      }
    } else {
      throw new Error(`kind automation không hợp lệ: "${kind}"`)
    }

    const omegaReport = [
      `## Kết quả triển khai automation`,
      ``,
      `- **Loại**: ${kind}`,
      `- **Người đề xuất**: ${proposedBy}`,
      `- **Kết quả**: ${resultDetail}`,
      ``,
      `Đề xuất đã được phê duyệt và thực thi tự động (fast-path — hành động cơ khí, không cần giao agents). Tài nguyên hiện diện trong module Smolab > Automation và bắt đầu hoạt động ngay.`,
    ].join('\n')

    const completedProposal = await db.selfDirectionProposal.update({
      where: { id: proposalId },
      data: {
        status: 'completed',
        executedAt: now,
        completedAt: now,
        planSummary: `Fast-path automation (${kind}) — thực thi trực tiếp không qua orchestration`,
        omegaReport,
      },
    })
    // v1.2 — ALISTA follow-up loop: proposal của ALISTA hoàn tất → notify ALISTA
    // xác minh lại NGAY (dynamic import chống circular; fail-open — sweep 60s
    // trong alistaTick là lưới an toàn).
    if (completedProposal.createdBy === 'ALISTA') {
      void import('@/lib/alista/proposal-verify')
        .then(m => m.notifyAlistaProposalCompleted(proposalId, 'completion-hook'))
        .catch(err => {
          console.warn('[AutomationProposal] ALISTA follow-up hook fail (sweep sẽ bắt lại):', err instanceof Error ? err.message : String(err))
        })
    }
    console.log(`[AutomationProposal] Proposal ${proposalId} (${kind}) ĐƯỢC DUYỆT + THỰC THI: ${resultDetail.slice(0, 150)}`)
    return { success: true, detail: resultDetail }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    try {
      await db.selfDirectionProposal.update({
        where: { id: proposalId },
        data: { status: 'failed', decisionReason: `Lỗi thực thi automation: ${errMsg}`, executedAt: new Date() },
      })
    } catch { /* best-effort */ }
    return { success: false, detail: `Lỗi thực thi automation: ${errMsg}` }
  }
}
