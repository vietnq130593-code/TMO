/**
 * OpenClaw Automation API — Manage cron jobs and webhooks (full SQLite CRUD + REAL execution)
 *
 * GET  /api/openclaw/automation?type=cron|webhook|all
 * POST /api/openclaw/automation  { action, ...data }
 *
 * Actions:
 *   create-cron, update-cron, delete-cron, run-cron, toggle-cron
 *   create-webhook, update-webhook, delete-webhook, toggle-webhook, test-webhook
 *
 * run-cron: Executes the task via LLM and records real results
 * test-webhook: Sends a real HTTP POST to the webhook URL
 */

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import {
  executeCronJob,
  testWebhookDispatch,
  approximateNextRun,
  validateAutomationExecutor,
} from '@/lib/automation-engine'
// CRON BUILDER (user request 2026-09-14): lịch có cấu trúc Ngày/Tuần/Tháng
import {
  validateCronSchedule,
  nextRunFromSchedule,
  scheduleToRepresentativeExpression,
  type CronScheduleConfig,
} from '@/lib/cron-schedule'

export const dynamic = 'force-dynamic'

const AGENT_ID = 'default'

// ─── GET ────────────────────────────────────────────────────────────────────────

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const type = searchParams.get('type') || 'cron'

    if (type === 'cron') {
      const jobs = await db.cronJob.findMany({
        where: { agentId: AGENT_ID },
        orderBy: { createdAt: 'desc' },
      })
      return NextResponse.json({ jobs, total: jobs.length })
    }

    if (type === 'webhook') {
      const webhooks = await db.webhook.findMany({
        where: { agentId: AGENT_ID },
        orderBy: { createdAt: 'desc' },
      })
      return NextResponse.json({ webhooks, total: webhooks.length })
    }

    if (type === 'all') {
      const [jobs, webhooks] = await Promise.all([
        db.cronJob.findMany({ where: { agentId: AGENT_ID }, orderBy: { createdAt: 'desc' } }),
        db.webhook.findMany({ where: { agentId: AGENT_ID }, orderBy: { createdAt: 'desc' } }),
      ])
      return NextResponse.json({ jobs, webhooks })
    }

    return NextResponse.json({ error: 'Invalid type parameter. Use cron, webhook, or all.' }, { status: 400 })
  } catch (error) {
    console.error('[Automation GET] Error:', error)
    return NextResponse.json({ error: 'Failed to fetch automation data' }, { status: 500 })
  }
}

// ─── POST ───────────────────────────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { action } = body

    // ── Cron Actions ──────────────────────────────────────────────────────

    if (action === 'create-cron') {
      const { expression, taskPrompt, enabled, schedule, executor } = body
      if (!taskPrompt) {
        return NextResponse.json({ error: 'taskPrompt is required' }, { status: 400 })
      }

      // CRON BUILDER: schedule có cấu trúc (Ngày/Tuần/Tháng + times + Lặp)
      // được ưu tiên; expression thô (legacy) vẫn chấp nhận khi không có schedule
      let validatedSchedule: CronScheduleConfig | null = null
      if (schedule !== undefined && schedule !== null) {
        const v = validateCronSchedule(schedule)
        if (!v.ok) return NextResponse.json({ error: `Lịch không hợp lệ: ${v.error}` }, { status: 400 })
        validatedSchedule = v.data
      }
      if (!validatedSchedule && !expression) {
        return NextResponse.json({ error: 'Cần chọn lịch (schedule) hoặc nhập cron expression' }, { status: 400 })
      }

      // Executor: '' (mặc định) | agent name | 'team:xxx' (TL điều phối)
      const executorRaw = typeof executor === 'string' ? executor.trim() : ''
      const executorCheck = await validateAutomationExecutor(executorRaw)
      if (!executorCheck.ok) {
        return NextResponse.json({ error: `Executor không hợp lệ: ${executorCheck.error}` }, { status: 400 })
      }

      const finalExpression = validatedSchedule
        ? scheduleToRepresentativeExpression(validatedSchedule)
        : String(expression)
      const nextRunAt = validatedSchedule
        ? nextRunFromSchedule(validatedSchedule)
        : approximateNextRun(finalExpression)

      const job = await db.cronJob.create({
        data: {
          agentId: AGENT_ID,
          expression: finalExpression,
          taskPrompt,
          enabled: enabled ?? true,
          nextRunAt,
          scheduleJson: validatedSchedule ? JSON.stringify(validatedSchedule) : null,
          executor: executorCheck.value,
        },
      })
      return NextResponse.json({ success: true, job })
    }

    if (action === 'update-cron') {
      const { id, expression, taskPrompt, enabled, schedule, executor } = body
      if (!id) {
        return NextResponse.json({ error: 'id is required' }, { status: 400 })
      }
      const existing = await db.cronJob.findUnique({ where: { id } })
      if (!existing) {
        return NextResponse.json({ error: 'Cron job not found' }, { status: 404 })
      }
      const data: Record<string, unknown> = {}

      // Schedule có cấu trúc (nếu có) — ghi đè expression thô
      let validatedSchedule: CronScheduleConfig | null = null
      if (schedule !== undefined && schedule !== null) {
        const v = validateCronSchedule(schedule)
        if (!v.ok) return NextResponse.json({ error: `Lịch không hợp lệ: ${v.error}` }, { status: 400 })
        validatedSchedule = v.data
        data.scheduleJson = JSON.stringify(validatedSchedule)
        data.expression = scheduleToRepresentativeExpression(validatedSchedule)
        data.nextRunAt = nextRunFromSchedule(validatedSchedule)
        // Sửa lịch của job một-lần đã hoàn tất → kích hoạt lại (status về active)
        if (!existing.enabled || existing.status === 'completed') {
          data.status = 'active'
        }
      } else if (expression !== undefined) {
        // Expression thô → quay về chế độ legacy (bỏ scheduleJson)
        data.expression = String(expression)
        data.scheduleJson = null
        data.nextRunAt = approximateNextRun(String(expression))
      }

      // Executor
      if (executor !== undefined) {
        const executorRaw = typeof executor === 'string' ? executor.trim() : ''
        const executorCheck = await validateAutomationExecutor(executorRaw)
        if (!executorCheck.ok) {
          return NextResponse.json({ error: `Executor không hợp lệ: ${executorCheck.error}` }, { status: 400 })
        }
        data.executor = executorCheck.value
      }

      if (taskPrompt !== undefined) data.taskPrompt = taskPrompt
      if (enabled !== undefined) data.enabled = enabled

      // Bật lại job đã hoàn tất (one-time) → re-arm nextRunAt từ lịch hiện có
      if (enabled === true) {
        if (validatedSchedule) {
          data.nextRunAt = nextRunFromSchedule(validatedSchedule)
        } else if (data.scheduleJson === undefined && existing.scheduleJson) {
          const parsed = (await import('@/lib/cron-schedule')).parseScheduleJson(existing.scheduleJson)
          if (parsed) {
            data.nextRunAt = nextRunFromSchedule(parsed)
            if (existing.status === 'completed') data.status = 'active'
          }
        } else if (data.expression !== undefined) {
          data.nextRunAt = approximateNextRun(String(data.expression))
        } else if (existing.expression) {
          data.nextRunAt = approximateNextRun(existing.expression)
        }
      }

      const job = await db.cronJob.update({ where: { id }, data })
      return NextResponse.json({ success: true, job })
    }

    if (action === 'delete-cron') {
      const { id } = body
      if (!id) {
        return NextResponse.json({ error: 'id is required' }, { status: 400 })
      }
      const existing = await db.cronJob.findUnique({ where: { id } })
      if (!existing) {
        return NextResponse.json({ error: 'Cron job not found' }, { status: 404 })
      }
      await db.cronJob.delete({ where: { id } })
      return NextResponse.json({ success: true, message: 'Cron job deleted' })
    }

    if (action === 'run-cron') {
      const { id } = body
      if (!id) {
        return NextResponse.json({ error: 'id is required' }, { status: 400 })
      }

      // Verify job exists first
      const job = await db.cronJob.findUnique({ where: { id } })
      if (!job) {
        return NextResponse.json({ error: 'Cron job not found' }, { status: 404 })
      }

      // Real execution — calls LLM and records actual results
      const result = await executeCronJob(id)

      return NextResponse.json({
        success: result.success,
        execution: {
          type: job.expression.startsWith('heartbeat:') ? 'heartbeat' : 'cron',
          taskPrompt: job.taskPrompt,
          expression: job.expression,
          llmResponse: result.content ? result.content.slice(0, 2000) : undefined,
          provider: result.provider,
          model: result.model,
          tokensUsed: result.tokensUsed,
          durationMs: result.durationMs,
          error: result.error,
        },
      })
    }

    if (action === 'toggle-cron') {
      const { id } = body
      if (!id) {
        return NextResponse.json({ error: 'id is required' }, { status: 400 })
      }
      const existing = await db.cronJob.findUnique({ where: { id } })
      if (!existing) {
        return NextResponse.json({ error: 'Cron job not found' }, { status: 404 })
      }
      const data: Record<string, unknown> = { enabled: !existing.enabled }
      if (!existing.enabled) {
        // Re-enabling: set nextRunAt
        data.nextRunAt = approximateNextRun(existing.expression)
      }
      const job = await db.cronJob.update({ where: { id }, data })
      return NextResponse.json({ success: true, job })
    }

    // ── Webhook Actions ───────────────────────────────────────────────────

    if (action === 'create-webhook') {
      const { url, events, secret, enabled } = body
      if (!url || !events) {
        return NextResponse.json({ error: 'url and events are required' }, { status: 400 })
      }
      const eventsStr = typeof events === 'string' ? events : JSON.stringify(events)
      const webhook = await db.webhook.create({
        data: {
          agentId: AGENT_ID,
          url,
          events: eventsStr,
          secret: secret ?? null,
          enabled: enabled ?? true,
        },
      })
      return NextResponse.json({ success: true, webhook })
    }

    if (action === 'update-webhook') {
      const { id, url, events, secret, enabled } = body
      if (!id) {
        return NextResponse.json({ error: 'id is required' }, { status: 400 })
      }
      const existing = await db.webhook.findUnique({ where: { id } })
      if (!existing) {
        return NextResponse.json({ error: 'Webhook not found' }, { status: 404 })
      }
      const data: Record<string, unknown> = {}
      if (url !== undefined) data.url = url
      if (events !== undefined) data.events = typeof events === 'string' ? events : JSON.stringify(events)
      if (secret !== undefined) data.secret = secret
      if (enabled !== undefined) data.enabled = enabled
      const webhook = await db.webhook.update({ where: { id }, data })
      return NextResponse.json({ success: true, webhook })
    }

    if (action === 'delete-webhook') {
      const { id } = body
      if (!id) {
        return NextResponse.json({ error: 'id is required' }, { status: 400 })
      }
      const existing = await db.webhook.findUnique({ where: { id } })
      if (!existing) {
        return NextResponse.json({ error: 'Webhook not found' }, { status: 404 })
      }
      await db.webhook.delete({ where: { id } })
      return NextResponse.json({ success: true, message: 'Webhook deleted' })
    }

    if (action === 'toggle-webhook') {
      const { id } = body
      if (!id) {
        return NextResponse.json({ error: 'id is required' }, { status: 400 })
      }
      const existing = await db.webhook.findUnique({ where: { id } })
      if (!existing) {
        return NextResponse.json({ error: 'Webhook not found' }, { status: 404 })
      }
      const webhook = await db.webhook.update({
        where: { id },
        data: { enabled: !existing.enabled },
      })
      return NextResponse.json({ success: true, webhook })
    }

    if (action === 'test-webhook') {
      const { id } = body
      if (!id) {
        return NextResponse.json({ error: 'id is required' }, { status: 400 })
      }

      // Real dispatch — actually sends HTTP POST to the webhook URL
      const result = await testWebhookDispatch(id)

      return NextResponse.json({
        success: result.success,
        dispatch: {
          httpStatus: result.httpStatus,
          responseBody: result.responseBody.slice(0, 2000),
          durationMs: result.durationMs,
          error: result.error,
        },
      })
    }

    return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 })
  } catch (error) {
    console.error('[Automation POST] Error:', error)
    return NextResponse.json({ error: 'Failed to process automation action' }, { status: 500 })
  }
}
