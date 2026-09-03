/**
 * Automation Engine — Real execution engine for Magnum Opus Automation
 *
 * Provides:
 * 1. Cron Scheduler — checks due jobs, executes via LLM, records results
 * 2. Webhook Dispatcher — sends HTTP POST to webhook URLs with HMAC signing
 * 3. Heartbeat Runner — periodic health checks via LLM
 * 4. Standing Orders — builds system prompt context from active orders
 *
 * The scheduler is triggered by a polling endpoint (/api/openclaw/automation/scheduler)
 * which should be called periodically (e.g., every 30 seconds) from the client.
 */

import { db } from '@/lib/db'
import { callLLM, callLLMForAgent } from '@/lib/llm'
import { createHmac } from 'crypto'
// CRON BUILDER (user request 2026-09-14): lịch có cấu trúc + executor
import {
  parseScheduleJson,
  nextRunFromSchedule,
  describeSchedule,
  parseExecutor,
  type CronScheduleConfig,
} from '@/lib/cron-schedule'

const AGENT_ID = 'default'

// ─── Concurrency Guard ────────────────────────────────────────────────────────
// Prevents the same job from being executed concurrently by multiple scheduler calls.
const runningJobs = new Set<string>()

// ─── Types ─────────────────────────────────────────────────────────────────────

interface CronJobResult {
  success: boolean
  content: string
  provider?: string
  model?: string
  tokensUsed?: number
  error?: string
  durationMs: number
}

interface WebhookDispatchResult {
  success: boolean
  httpStatus: number
  responseBody: string
  durationMs: number
  error?: string
}

// ─── Cron Expression Parser (shared) ──────────────────────────────────────────

/**
 * Approximate the next run time from a cron expression.
 * Handles common patterns; falls back to +1 hour for unknown expressions.
 * Exported so route.ts can reuse it instead of duplicating.
 */
export function approximateNextRun(expression: string): Date {
  const now = new Date()

  // Heartbeat-style expressions: heartbeat:5m, heartbeat:1h, etc.
  if (expression.startsWith('heartbeat:')) {
    const interval = expression.replace('heartbeat:', '')
    const map: Record<string, number> = { '1m': 60, '5m': 300, '15m': 900, '30m': 1800, '1h': 3600 }
    const seconds = map[interval] ?? 300
    return new Date(now.getTime() + seconds * 1000)
  }

  // Every N minutes: */5 * * * *
  const everyMinMatch = expression.match(/^\*\/(\d+)\s+\*\s+\*\s+\*\s+\*$/)
  if (everyMinMatch) {
    const mins = parseInt(everyMinMatch[1], 10)
    return new Date(now.getTime() + mins * 60 * 1000)
  }

  // Hourly at minute M: M * * * *
  const hourlyMatch = expression.match(/^(\d+)\s+\*\s+\*\s+\*\s+\*$/)
  if (hourlyMatch) {
    const minute = parseInt(hourlyMatch[1], 10)
    const next = new Date(now)
    next.setHours(next.getHours() + 1, minute, 0, 0)
    return next
  }

  // Daily at HH:MM: M H * * *
  const dailyMatch = expression.match(/^(\d+)\s+(\d+)\s+\*\s+\*\s+\*$/)
  if (dailyMatch) {
    const minute = parseInt(dailyMatch[1], 10)
    const hour = parseInt(dailyMatch[2], 10)
    const next = new Date(now)
    next.setHours(hour, minute, 0, 0)
    if (next <= now) next.setDate(next.getDate() + 1)
    return next
  }

  // Weekly at HH:MM on DOW: M H * * DOW
  const weeklyMatch = expression.match(/^(\d+)\s+(\d+)\s+\*\s+\*\s+(\d+)$/)
  if (weeklyMatch) {
    const minute = parseInt(weeklyMatch[1], 10)
    const hour = parseInt(weeklyMatch[2], 10)
    const dow = parseInt(weeklyMatch[3], 10)
    const next = new Date(now)
    next.setHours(hour, minute, 0, 0)
    const daysAhead = (dow - next.getDay() + 7) % 7 || 7
    next.setDate(next.getDate() + daysAhead)
    return next
  }

  // Monthly on day D at HH:MM: M H D * *
  const monthlyMatch = expression.match(/^(\d+)\s+(\d+)\s+(\d+)\s+\*\s+\*$/)
  if (monthlyMatch) {
    const minute = parseInt(monthlyMatch[1], 10)
    const hour = parseInt(monthlyMatch[2], 10)
    const day = parseInt(monthlyMatch[3], 10)
    const next = new Date(now)
    next.setDate(day)
    next.setHours(hour, minute, 0, 0)
    if (next <= now) next.setMonth(next.getMonth() + 1)
    return next
  }

  // Fallback: +1 hour
  return new Date(now.getTime() + 3600 * 1000)
}

// ─── Stuck Execution Cleanup ──────────────────────────────────────────────────

/**
 * Clean up "running" execution records that are stuck (older than 10 minutes).
 * This handles cases where the process crashed during LLM execution.
 */
export async function cleanupStuckExecutions(): Promise<number> {
  try {
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000)
    const stuck = await db.taskExecution.findMany({
      where: {
        status: 'running',
        startedAt: { lt: tenMinutesAgo },
      },
    })

    if (stuck.length === 0) return 0

    await db.taskExecution.updateMany({
      where: {
        id: { in: stuck.map(s => s.id) },
      },
      data: {
        status: 'failed',
        errorMessage: 'Execution timed out (process may have crashed)',
        completedAt: new Date(),
      },
    })

    return stuck.length
  } catch {
    return 0
  }
}

// ─── Old Execution Cleanup ────────────────────────────────────────────────────

/**
 * Delete old TaskExecution records to prevent unbounded database growth.
 * Keeps records from the last 90 days, deletes older ones.
 */
export async function cleanupOldExecutions(): Promise<number> {
  try {
    const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)
    const result = await db.taskExecution.deleteMany({
      where: {
        startedAt: { lt: ninetyDaysAgo },
      },
    })
    return result.count
  } catch {
    return 0
  }
}

// ─── Standing Orders → System Prompt ──────────────────────────────────────────

/**
 * Build a system prompt section from active standing orders.
 * This context is injected into cron/heartbeat LLM calls so the agent
 * respects persistent instructions.
 */
export async function buildStandingOrdersContext(): Promise<string> {
  try {
    const orders = await db.standingOrder.findMany({
      where: { agentId: AGENT_ID, enabled: true },
      orderBy: [{ priority: 'desc' }, { createdAt: 'desc' }],
    })

    if (orders.length === 0) return ''

    const lines = orders.map((o, i) => `${i + 1}. [Priority ${o.priority}] ${o.order}`)
    return `\n\n## Standing Orders (luôn tuân theo)\n${lines.join('\n')}`
  } catch {
    return ''
  }
}

/**
 * Get all active standing orders as an array
 */
export async function getActiveStandingOrders(): Promise<Array<{ order: string; priority: number }>> {
  try {
    const orders = await db.standingOrder.findMany({
      where: { agentId: AGENT_ID, enabled: true },
      orderBy: [{ priority: 'desc' }, { createdAt: 'desc' }],
    })
    return orders.map(o => ({ order: o.order, priority: o.priority }))
  } catch {
    return []
  }
}

// ─── Cron Job Execution ───────────────────────────────────────────────────────

/**
 * Execute a single cron job by calling LLM with the task prompt.
 * Records the execution in TaskExecution with real results.
 * Uses concurrency guard to prevent double execution.
 */
// ─── Executor Resolution (user request 2026-09-14) ────────────────────────────
// CronJob.executor: '' (Automation Agent mặc định) | 'RAMPAGE' (agent cụ thể) |
// 'team:code' (TEAM — TL là agent điều phối triển khai toàn bộ tác vụ)

interface ExecutorContext {
  /** Nhãn hiển thị trong TaskExecution/kết quả */
  label: string
  /** null → chạy bằng callLLM generic ( Automation Agent mặc định) */
  brain: { provider: string; model: string } | null
  systemPrompt: string
  temperature?: number
  maxTokens?: number
  /** Ghi chú khi executor không resolve được → fallback generic */
  fallbackNote?: string
}

const AUTOMATION_EXECUTOR_MAX_TOKENS = 2500

async function resolveExecutorContext(
  executor: string,
  ctx: { taskPrompt: string; scheduleDesc: string; standingOrdersCtx: string },
): Promise<ExecutorContext> {
  const parsed = parseExecutor(executor)

  // Mặc định — Automation Agent generic (giữ nguyên hành vi cũ)
  if (parsed.type === 'default') {
    return { label: 'Automation Agent (mặc định)', brain: null, systemPrompt: '' }
  }

  // Agent cụ thể thực thi — persona từ AgentProfile
  if (parsed.type === 'agent') {
    const profile = await db.agentProfile.findUnique({ where: { name: parsed.value } })
    if (!profile || !profile.enabled) {
      return {
        label: 'Automation Agent (mặc định)',
        brain: null,
        systemPrompt: '',
        fallbackNote: `(Lưu ý: executor agent "${parsed.value}" không tồn tại hoặc đã tắt — fallback về Automation Agent mặc định. Nên kiểm tra lại danh sách agents.)`,
      }
    }
    const instruction = profile.instruction.slice(0, 3000)
    const systemPrompt = `Bạn là ${profile.name} — agent thực thi tác vụ định kỳ của hệ thống Magnum Opus.
Vai trò: ${profile.description}
Khả năng: ${profile.capable}
${instruction ? `Hướng dẫn vận hành (trích):\n${instruction}\n` : ''}
TÁC VỤ ĐỊNH KỲ PHÂN CÔNG CHO BẠN: "${ctx.taskPrompt}"
Lịch: ${ctx.scheduleDesc}
Thời điểm: ${new Date().toISOString()}
${ctx.standingOrdersCtx}

Thực thi tác vụ TRONG PHẠM VI chuyên môn của bạn. Báo cáo ngắn gọn những gì bạn đã kiểm tra, tìm thấy hoặc làm. Trung thực và cụ thể.`
    return {
      label: profile.name,
      brain: { provider: profile.provider, model: profile.model },
      systemPrompt,
      temperature: Math.min(Math.max(profile.temperature, 0), 2),
      maxTokens: Math.min(profile.maxTokens || 4096, AUTOMATION_EXECUTOR_MAX_TOKENS),
    }
  }

  // TEAM thực thi — TL (Team Leader) là agent điều phối triển khai TOÀN BỘ tác vụ
  const teamName = parsed.value
  const members = await db.agentProfile.findMany({
    where: { team: teamName, enabled: true },
    orderBy: [{ position: 'asc' }],
  })
  const tl = members.find(m => m.position === 'TL')
  if (!tl || members.length === 0) {
    return {
      label: 'Automation Agent (mặc định)',
      brain: null,
      systemPrompt: '',
      fallbackNote: `(Lưu ý: team "${teamName}" không có Team Leader (TL) đang bật — fallback về Automation Agent mặc định. Team cần ít nhất 1 agent vị trí TL để điều phối.)`,
    }
  }
  const roster = members
    .map(m => `- ${m.name} (${m.position || 'member'}): ${m.capable.slice(0, 120)}`)
    .join('\n')
  const instruction = tl.instruction.slice(0, 3000)
  const systemPrompt = `Bạn là ${tl.name} — Team Leader (TL) của Team "${teamName}" trong hệ thống Magnum Opus.
Vai trò: ${tl.description}
${instruction ? `Hướng dẫn vận hành (trích):\n${instruction}\n` : ''}
TÁC VỤ ĐỊNH KỲ NÀY ĐƯỢC GIAO CHO TOÀN TEAM CỦA BẠN: "${ctx.taskPrompt}"
Lịch: ${ctx.scheduleDesc}
Thời điểm: ${new Date().toISOString()}

THÀNH VIÊN TEAM:
${roster}
${ctx.standingOrdersCtx}

BẠN (TL) LÀ AGENT ĐIỀU PHỐI TRIỂN KHAI TOÀN BỘ TÁC VỤ:
1. Phân tích tác vụ và xác định những việc cần làm.
2. Lên kế hoạch phân công cho từng thành viên team phù hợp chuyên môn (nêu rõ ai làm gì).
3. Với mỗi phần việc, mô tả cách triển khai và kết quả mong đợi (giả lập việc giao — không gọi tools ngoài lệnh này).
4. Tổng hợp KẾT QUẢ CUỐI CÙNG của tác vụ (như báo cáo điều phối viên nộp về hệ thống).

Trả lời ngắn gọn theo cấu trúc: Kế hoạch → Phân công → Triển khai → Kết quả cuối cùng.`
  return {
    label: `Team ${teamName} · ${tl.name} (TL điều phối)`,
    brain: { provider: tl.provider, model: tl.model },
    systemPrompt,
    temperature: Math.min(Math.max(tl.temperature, 0), 2),
    maxTokens: Math.min(tl.maxTokens || 4096, AUTOMATION_EXECUTOR_MAX_TOKENS),
  }
}

/**
 * Dữ liệu cập nhật CronJob sau mỗi lần chạy:
 * - Lịch có cấu trúc + Lặp BẬT → nextRunAt = lần khớp lịch kế tiếp
 * - Lịch có cấu trúc + Lặp TẮT (one-time) → job HOÀN TẤT: tắt + status completed
 *   (nextRunAt=null → scheduler không chạy lại; chạy cả khi LLM fail để không
 *   retry mãi một tác vụ một-lần)
 * - Legacy (expression thô) → approximateNextRun như cũ
 */
function cronJobPostRunData(
  _jobId: string,
  schedule: CronScheduleConfig | null,
  expression: string,
): { lastRunAt: Date; nextRunAt: Date | null; enabled?: boolean; status?: string } {
  const now = new Date()
  if (schedule) {
    if (schedule.repeat) {
      return { lastRunAt: now, nextRunAt: nextRunFromSchedule(schedule, now) ?? null }
    }
    return { lastRunAt: now, nextRunAt: null, enabled: false, status: 'completed' }
  }
  return { lastRunAt: now, nextRunAt: approximateNextRun(expression) }
}

/**
 * Validate executor của CronJob (dùng chung cho API route + tool manage_automation
 * + automation proposals — dữ liệu đầu vào KHÔNG tin, kiểm tra DB thật):
 *   ''            → Automation Agent mặc định (luôn hợp lệ)
 *   'RAMPAGE'        → phải là AgentProfile đang bật
 *   'team:code'   → team phải có agent vị trí TL đang bật (TL điều phối)
 */
export async function validateAutomationExecutor(
  executor: string,
): Promise<{ ok: true; value: string } | { ok: false; error: string }> {
  const parsed = parseExecutor(executor)
  if (parsed.type === 'default') return { ok: true, value: '' }
  if (parsed.type === 'agent') {
    const profile = await db.agentProfile.findUnique({ where: { name: parsed.value } })
    if (!profile || !profile.enabled) {
      return { ok: false, error: `Executor agent "${parsed.value}" không tồn tại hoặc đã tắt` }
    }
    return { ok: true, value: parsed.value }
  }
  const tl = await db.agentProfile.findFirst({
    where: { team: parsed.value, position: 'TL', enabled: true },
  })
  if (!tl) {
    return { ok: false, error: `Team "${parsed.value}" không có Team Leader (TL) đang bật — cần TL để điều phối tác vụ` }
  }
  return { ok: true, value: `team:${parsed.value}` }
}

export async function executeCronJob(jobId: string): Promise<CronJobResult> {
  const startTime = Date.now()

  // Concurrency guard: skip if already running
  if (runningJobs.has(jobId)) {
    return { success: false, content: '', error: 'Job already running (concurrency guard)', durationMs: 0 }
  }
  runningJobs.add(jobId)

  try {
    const job = await db.cronJob.findUnique({ where: { id: jobId } })
    if (!job) {
      return { success: false, content: '', error: 'Job not found', durationMs: Date.now() - startTime }
    }

    // Skip if job is disabled
    if (!job.enabled) {
      return { success: false, content: '', error: 'Job is disabled', durationMs: Date.now() - startTime }
    }

    // Create a "running" execution record
    const execution = await db.taskExecution.create({
      data: {
        jobId: job.id,
        type: job.expression.startsWith('heartbeat:') ? 'heartbeat' : 'cron',
        status: 'running',
        startedAt: new Date(),
      },
    })

    // Lịch có cấu trúc (cron builder) — nếu có thì dùng thay vì expression thô
    const schedule: CronScheduleConfig | null = parseScheduleJson(job.scheduleJson)
    const scheduleDesc = schedule ? describeSchedule(schedule) : job.expression

    // Build context with standing orders
    const standingOrdersCtx = await buildStandingOrdersContext()

    // Resolve executor (user request 2026-09-14: chọn Agent hoặc team — team thì
    // TL (Team Leader) là agent điều phối triển khai toàn bộ tác vụ)
    const executorCtx = await resolveExecutorContext(job.executor, {
      taskPrompt: job.taskPrompt,
      scheduleDesc,
      standingOrdersCtx,
    })

    // Build system prompt for the automation agent
    const genericSystemPrompt = `You are the Magnum Opus Automation Agent. You execute scheduled tasks autonomously.

Current task: "${job.taskPrompt}"
Schedule: ${scheduleDesc}
Time: ${new Date().toISOString()}
${standingOrdersCtx}

Execute this task concisely. Report what you checked, found, or did. Be factual and brief.`

    // Call LLM to execute the task
    // - executor mặc định ('') → callLLM generic (như cũ)
    // - agent cụ thể / team (TL điều phối) → callLLMForAgent với persona của
    //   agent đó (kimi-k3 + fallback chain + z-ai-sdk self-heal)
    let llmResult: Awaited<ReturnType<typeof callLLM>>
    if (executorCtx.brain) {
      llmResult = await callLLMForAgent(job.taskPrompt, executorCtx.brain, executorCtx.systemPrompt, {
        agentId: 'automation-cron',
        agentName: executorCtx.label,
        temperature: executorCtx.temperature ?? 0.5,
        maxTokens: executorCtx.maxTokens ?? 2000,
      })
    } else {
      llmResult = await callLLM(job.taskPrompt, executorCtx.fallbackNote ? `${genericSystemPrompt}\n\n${executorCtx.fallbackNote}` : genericSystemPrompt, 'automation-cron')
    }

    const durationMs = Date.now() - startTime

    if (llmResult.content) {
      // Success — update execution record
      await db.taskExecution.update({
        where: { id: execution.id },
        data: {
          status: 'completed',
          result: JSON.stringify({
            taskPrompt: job.taskPrompt,
            expression: job.expression,
            schedule: schedule ? describeSchedule(schedule) : undefined,
            executor: executorCtx.label,
            llmResponse: llmResult.content,
            provider: llmResult.provider,
            model: llmResult.model,
            tokensUsed: llmResult.tokensUsed,
          }),
          completedAt: new Date(),
        },
      })

      // Update the job's lastRunAt and nextRunAt
      await db.cronJob.update({
        where: { id: jobId },
        data: cronJobPostRunData(job.id, schedule, job.expression),
      })

      return {
        success: true,
        content: llmResult.content,
        provider: llmResult.provider,
        model: llmResult.model,
        tokensUsed: llmResult.tokensUsed,
        durationMs,
      }
    } else {
      // LLM failed
      await db.taskExecution.update({
        where: { id: execution.id },
        data: {
          status: 'failed',
          result: JSON.stringify({
            taskPrompt: job.taskPrompt,
            expression: job.expression,
            schedule: schedule ? describeSchedule(schedule) : undefined,
            executor: executorCtx.label,
            error: llmResult.error || 'LLM returned empty response',
          }),
          errorMessage: llmResult.error || 'LLM returned empty response',
          completedAt: new Date(),
        },
      })

      // Still update lastRunAt even on failure
      await db.cronJob.update({
        where: { id: jobId },
        data: cronJobPostRunData(job.id, schedule, job.expression),
      })

      return {
        success: false,
        content: '',
        error: llmResult.error || 'LLM returned empty response',
        durationMs,
      }
    }
  } catch (error) {
    const durationMs = Date.now() - startTime
    return {
      success: false,
      content: '',
      error: error instanceof Error ? error.message : 'Unknown error',
      durationMs,
    }
  } finally {
    // Always release the concurrency guard
    runningJobs.delete(jobId)
  }
}

// ─── Webhook Dispatcher ───────────────────────────────────────────────────────

/** Blocked URL patterns to prevent SSRF attacks */
const BLOCKED_URL_PATTERNS = [
  /^127\./,                          // localhost IPv4
  /^10\./,                           // private class A
  /^172\.(1[6-9]|2\d|3[01])\./,     // private class B
  /^192\.168\./,                     // private class C
  /^0\./,                            // loopback
  /^169\.254\./,                     // link-local
  /\[::1\]/,                         // localhost IPv6
  /\[fe80:/,                         // link-local IPv6
  /\[fc00:/,                         // unique-local IPv6
  /^localhost/i,                     // localhost hostname
  /^metadata/i,                      // cloud metadata
  /^169\.254\.169\.254/,             // cloud metadata endpoint
]

/**
 * Validate a webhook URL to prevent SSRF attacks.
 * Only allows HTTPS URLs to public internet addresses.
 * Exported (2026-09-13) cho task-flows.ts tái dùng (action webhook outbound).
 */
export function validateWebhookUrl(url: string): { valid: boolean; reason?: string } {
  try {
    const parsed = new URL(url)

    // Only allow HTTPS (or HTTP for localhost in development)
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return { valid: false, reason: 'Only HTTP/HTTPS URLs are allowed' }
    }

    // Check for blocked patterns in hostname
    const hostname = parsed.hostname
    for (const pattern of BLOCKED_URL_PATTERNS) {
      if (pattern.test(hostname)) {
        return { valid: false, reason: 'Private/internal network addresses are not allowed' }
      }
    }

    return { valid: true }
  } catch {
    return { valid: false, reason: 'Invalid URL format' }
  }
}

/**
 * Dispatch a webhook — actually sends an HTTP POST to the webhook URL.
 * Signs the payload with HMAC-SHA256 if a secret is configured.
 * Validates URL to prevent SSRF attacks.
 */
export async function dispatchWebhook(
  webhookId: string,
  eventPayload: Record<string, unknown>
): Promise<WebhookDispatchResult> {
  const startTime = Date.now()

  try {
    const webhook = await db.webhook.findUnique({ where: { id: webhookId } })
    if (!webhook) {
      return { success: false, httpStatus: 0, responseBody: '', durationMs: Date.now() - startTime, error: 'Webhook not found' }
    }

    // SSRF protection: validate URL
    const urlValidation = validateWebhookUrl(webhook.url)
    if (!urlValidation.valid) {
      return { success: false, httpStatus: 0, responseBody: '', durationMs: Date.now() - startTime, error: `URL blocked: ${urlValidation.reason}` }
    }

    const payload = JSON.stringify(eventPayload)
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': 'MagnumOpus-Automation/1.0',
      'X-Webhook-Event': eventPayload.event as string || 'unknown',
      'X-Webhook-Delivery': `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    }

    // Sign with HMAC if secret is configured
    if (webhook.secret) {
      const signature = createHmac('sha256', webhook.secret).update(payload).digest('hex')
      headers['X-Webhook-Signature'] = `sha256=${signature}`
    }

    const startTimeFetch = Date.now()
    let httpStatus = 0
    let responseBody = ''

    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 15000) // 15s timeout
      const res = await fetch(webhook.url, {
        method: 'POST',
        headers,
        body: payload,
        signal: controller.signal,
      })
      clearTimeout(timeout)
      httpStatus = res.status
      responseBody = await res.text().catch(() => '')
    } catch (fetchError) {
      httpStatus = 0
      responseBody = fetchError instanceof Error ? fetchError.message : 'Fetch failed'
    }

    const durationMs = Date.now() - startTime
    const success = httpStatus >= 200 && httpStatus < 300

    // Record the dispatch in TaskExecution
    await db.taskExecution.create({
      data: {
        jobId: webhook.id,
        type: 'webhook',
        status: success ? 'completed' : 'failed',
        result: JSON.stringify({
          url: webhook.url,
          events: webhook.events,
          httpStatus,
          responseBody: responseBody.slice(0, 2000), // Truncate large responses
          payload: payload.slice(0, 2000),
          test: eventPayload.test || false,
        }),
        errorMessage: success ? null : `HTTP ${httpStatus}: ${responseBody.slice(0, 500)}`,
        startedAt: new Date(startTimeFetch),
        completedAt: new Date(),
      },
    })

    return { success, httpStatus, responseBody, durationMs }
  } catch (error) {
    const durationMs = Date.now() - startTime
    return {
      success: false,
      httpStatus: 0,
      responseBody: '',
      durationMs,
      error: error instanceof Error ? error.message : 'Unknown error',
    }
  }
}

/**
 * Test a webhook — sends a test payload to the webhook URL
 */
export async function testWebhookDispatch(webhookId: string): Promise<WebhookDispatchResult> {
  const webhook = await db.webhook.findUnique({ where: { id: webhookId } })
  if (!webhook) {
    return { success: false, httpStatus: 0, responseBody: '', durationMs: 0, error: 'Webhook not found' }
  }

  return dispatchWebhook(webhookId, {
    event: 'webhook.test',
    test: true,
    timestamp: new Date().toISOString(),
    message: 'Test webhook from Magnum Opus Automation',
    webhookId: webhook.id,
  })
}

/**
 * Dispatch event to all matching webhooks
 */
export async function dispatchEventToWebhooks(
  eventType: string,
  eventData: Record<string, unknown>
): Promise<Array<{ webhookId: string; result: WebhookDispatchResult }>> {
  const webhooks = await db.webhook.findMany({
    where: { agentId: AGENT_ID, enabled: true },
  })

  const results: Array<{ webhookId: string; result: WebhookDispatchResult }> = []

  for (const webhook of webhooks) {
    try {
      // Check if webhook subscribes to this event
      const events = JSON.parse(webhook.events || '[]')
      const subscribed = events.includes('*') || events.includes(eventType)
      if (!subscribed) continue

      const payload = {
        event: eventType,
        timestamp: new Date().toISOString(),
        ...eventData,
      }

      const result = await dispatchWebhook(webhook.id, payload)
      results.push({ webhookId: webhook.id, result })
    } catch {
      // Skip this webhook on error
    }
  }

  return results
}

// ─── Scheduler ────────────────────────────────────────────────────────────────

/**
 * Check and execute all due cron jobs (EXCLUDING heartbeat jobs).
 * Heartbeat is handled separately by runHeartbeatCheck().
 * Called periodically by the scheduler API endpoint.
 * Returns a summary of what was executed.
 */
export async function runSchedulerCheck(): Promise<{
  checked: number
  executed: number
  failed: number
  results: Array<{ jobId: string; taskPrompt: string; success: boolean; content?: string; error?: string; durationMs: number }>
}> {
  const now = new Date()

  // Find all enabled cron jobs that are due, EXCLUDING heartbeat-prefixed ones
  const dueJobs = await db.cronJob.findMany({
    where: {
      agentId: AGENT_ID,
      enabled: true,
      nextRunAt: { lte: now },
      expression: { not: { startsWith: 'heartbeat:' } },
    },
  })

  const results: Array<{ jobId: string; taskPrompt: string; success: boolean; content?: string; error?: string; durationMs: number }> = []
  let executed = 0
  let failed = 0

  for (const job of dueJobs) {
    try {
      const result = await executeCronJob(job.id)
      results.push({
        jobId: job.id,
        taskPrompt: job.taskPrompt,
        success: result.success,
        content: result.content.slice(0, 500),
        error: result.error,
        durationMs: result.durationMs,
      })
      if (result.success) executed++
      else failed++
    } catch (error) {
      results.push({
        jobId: job.id,
        taskPrompt: job.taskPrompt,
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        durationMs: 0,
      })
      failed++
    }
  }

  return { checked: dueJobs.length, executed, failed, results }
}

/**
 * Run heartbeat check if due.
 * Returns the result if heartbeat was executed, null if not due.
 * This is separate from runSchedulerCheck to avoid double execution.
 */
export async function runHeartbeatCheck(): Promise<CronJobResult | null> {
  try {
    const heartbeatJobs = await db.cronJob.findMany({
      where: {
        agentId: AGENT_ID,
        expression: { startsWith: 'heartbeat:' },
        enabled: true,
      },
    })

    if (heartbeatJobs.length === 0) return null

    const job = heartbeatJobs[0]
    const now = new Date()

    // Check if heartbeat is due
    if (!job.nextRunAt || new Date(job.nextRunAt) > now) {
      return null
    }

    return await executeCronJob(job.id)
  } catch {
    return null
  }
}
