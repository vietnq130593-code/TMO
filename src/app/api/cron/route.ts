/**
 * Cron API — Phase 4.6
 *
 * Spec: docs/FULLSTACK_CAPABILITY_PLAN_V2.md Phase 4.6 (lines 263-281)
 *
 * This route is a thin HTTP wrapper around src/lib/cron/scheduler.ts CRUD
 * operations. The actual execution (tick loop querying for due jobs) runs in
 * a SEPARATE mini-service: mini-services/cron-scheduler/index.ts on port 3004
 * (auto-spawned by instrumentation-node.ts).
 *
 * GET    /api/cron                          — list jobs (optional ?status=active)
 * POST   /api/cron                          — create a new job (body: {schedule, task, sessionId?})
 * DELETE /api/cron?jobId=<id>               — soft-delete (sets status='paused')
 * POST   /api/cron?action=run&jobId=<id>    — manual trigger (for testing)
 */

import { NextRequest, NextResponse } from 'next/server'
import {
  createCronJob,
  listCronJobs,
  deleteCronJob,
  runCronJob,
  type CronSchedule,
} from '@/lib/cron/scheduler'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  try {
    const url = new URL(request.url)
    const status = url.searchParams.get('status') as 'active' | 'paused' | 'completed' | 'failed' | null
    const sessionId = url.searchParams.get('sessionId') || undefined

    const jobs = await listCronJobs({
      status: status || undefined,
      sessionId,
    })
    return NextResponse.json({ ok: true, jobs, count: jobs.length })
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 },
    )
  }
}

export async function POST(request: NextRequest) {
  try {
    const url = new URL(request.url)
    const action = url.searchParams.get('action')

    if (action === 'run') {
      const jobId = url.searchParams.get('jobId')
      if (!jobId) {
        return NextResponse.json({ ok: false, error: 'run requires ?jobId=' }, { status: 400 })
      }
      const result = await runCronJob(jobId)
      return NextResponse.json({ ok: result.success, jobId, result })
    }

    // Default: create a new cron job
    const body = await request.json().catch(() => ({}))
    const { schedule, task, sessionId, agentId } = body

    if (!schedule || !schedule.kind || !schedule.expr) {
      return NextResponse.json(
        { ok: false, error: 'create requires { schedule: { kind, expr }, task }' },
        { status: 400 },
      )
    }
    if (!task) {
      return NextResponse.json(
        { ok: false, error: 'create requires non-empty task description' },
        { status: 400 },
      )
    }

    const created = await createCronJob({
      schedule: schedule as CronSchedule,
      task: String(task),
      sessionId: sessionId ? String(sessionId) : undefined,
      agentId: agentId ? String(agentId) : undefined,
    })

    return NextResponse.json({
      ok: true,
      jobId: created.jobId,
      nextRun: created.nextRun?.toISOString() ?? null,
      dryRun: created.dryRun,
      jobHash: created.jobHash,
      duplicate: created.duplicate,
      _hint: created.duplicate
        ? 'Duplicate schedule (jobHash already exists) — returned existing jobId.'
        : 'Job registered. cron-scheduler mini-service (port 3004) will execute on nextRunAt.',
    })
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 },
    )
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const url = new URL(request.url)
    const jobId = url.searchParams.get('jobId')
    if (!jobId) {
      return NextResponse.json({ ok: false, error: 'DELETE requires ?jobId=' }, { status: 400 })
    }
    const result = await deleteCronJob(jobId)
    return NextResponse.json({
      ok: result.success,
      jobId,
      error: result.error,
    })
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 },
    )
  }
}
