/**
 * Automation Scheduler API — Polling endpoint to trigger cron checks
 *
 * GET /api/openclaw/automation/scheduler
 *   - Cleans up stuck/old execution records
 *   - Checks for due cron jobs and heartbeat
 *   - Executes them via LLM
 *   - TASK FLOW (2026-09-13): runs due task flows (trigger cron đến hạn)
 *   - Returns execution summary
 *
 * This endpoint should be called periodically from the client (every 30s)
 * to simulate a background scheduler in a serverless environment.
 */

import { NextResponse } from 'next/server'
import { runSchedulerCheck, runHeartbeatCheck, cleanupStuckExecutions, cleanupOldExecutions } from '@/lib/automation-engine'
import { runDueTaskFlows } from '@/lib/task-flows'

export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    // Maintenance: clean up stuck "running" records (older than 10 min)
    const stuckCleaned = await cleanupStuckExecutions()

    // Maintenance: clean up old execution records (older than 90 days)
    const oldCleaned = await cleanupOldExecutions()

    // Run scheduler check for due cron jobs (excludes heartbeat)
    const cronResult = await runSchedulerCheck()

    // Run heartbeat check (separate from scheduler to avoid double execution)
    const heartbeatResult = await runHeartbeatCheck()

    // TASK FLOW (user request 2026-09-13): chạy flow có trigger cron đến hạn
    // (fail-open — flow lỗi không được làm hỏng cron/heartbeat kết quả)
    let taskFlows: Awaited<ReturnType<typeof runDueTaskFlows>> | null = null
    try {
      taskFlows = await runDueTaskFlows()
    } catch (flowErr) {
      console.warn('[Scheduler] Task flows check lỗi (fail-open):', flowErr instanceof Error ? flowErr.message : String(flowErr))
    }

    return NextResponse.json({
      success: true,
      timestamp: new Date().toISOString(),
      maintenance: {
        stuckExecutionsCleaned: stuckCleaned,
        oldExecutionsCleaned: oldCleaned,
      },
      cron: cronResult,
      heartbeat: heartbeatResult ? {
        executed: true,
        success: heartbeatResult.success,
        content: heartbeatResult.content.slice(0, 500),
        durationMs: heartbeatResult.durationMs,
      } : {
        executed: false,
        reason: 'Not due or disabled',
      },
      taskFlows: taskFlows ? {
        checked: taskFlows.checked,
        executed: taskFlows.executed,
        failed: taskFlows.failed,
      } : {
        checked: 0,
        executed: 0,
        failed: 0,
        reason: 'Task flow check failed (fail-open)',
      },
    })
  } catch (error) {
    console.error('[Scheduler] Error:', error)
    return NextResponse.json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    }, { status: 500 })
  }
}
