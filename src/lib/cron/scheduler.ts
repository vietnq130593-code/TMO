// ============================================
// Cron Scheduler — Phase 4.6 (Z.ai Code parity)
// ============================================
//
// Spec: docs/FULLSTACK_CAPABILITY_PLAN_V2.md Phase 4.6 (lines 263-281)
//
// Provides the implementation backing the `cron` tool surface in tool-executor.ts.
// The mini-service (mini-services/cron-scheduler/index.ts) runs a separate tick
// loop that periodically queries the DB for due jobs and executes them via
// /api/agents or /api/code-team/assess endpoints.
//
// Schedule kinds:
//   one_time   — expr is epoch-ms (e.g. "1735689600000"); runs once then marks 'completed'
//   cron       — expr is a 5-field cron expression (e.g. "0 9 * * *"); standard semantics
//   fixed_rate — expr is an interval string (e.g. "30s", "5m", "1h"); runs on a fixed cadence
//
// Dedup:
//   jobId hash = sha256(JSON.stringify({ schedule, task, sessionId }))
//   When createCronJob is called with the same hash → refuse duplicate.
//
// Retries:
//   On execution failure: retryCount++, nextRun = now + 2^retryCount seconds (max 3 retries)
//   On maxRetries exceeded → status='failed'
//   On one_time completion → status='completed'
//
// @module CronScheduler

import { db } from '@/lib/db'
import * as crypto from 'node:crypto'

// ============================================
// Types
// ============================================

export interface CronSchedule {
  /** 'one_time' (epoch-ms) | 'cron' (cron expr) | 'fixed_rate' (interval) */
  kind: 'one_time' | 'cron' | 'fixed_rate'
  /** epoch-ms (one_time) | cron expr (cron) | interval string (fixed_rate) */
  expr: string
  /** IANA timezone, e.g. 'Etc/GMT-7'. Optional. */
  tz?: string
}

export interface CreateCronJobInput {
  schedule: CronSchedule
  /** Agent task description (for create action) */
  task: string
  /** Resume existing session (optional) */
  sessionId?: string
  /** Agent ID — defaults to 'default' if omitted */
  agentId?: string
  /** Optional explicit jobId; auto-generated if omitted */
  jobId?: string
}

export interface CreateCronJobResult {
  jobId: string
  nextRun: Date | null
  dryRun: boolean
  jobHash: string
  duplicate: boolean
}

export interface ListCronJobsInput {
  status?: 'active' | 'paused' | 'completed' | 'failed'
  sessionId?: string
  agentId?: string
}

export interface CronJobRecord {
  id: string
  agentId: string
  kind: string
  expr: string
  tz: string | null
  task: string
  sessionId: string | null
  retryCount: number
  maxRetries: number
  lastError: string | null
  jobHash: string | null
  status: string
  lastRunAt: Date | null
  nextRunAt: Date | null
  createdAt: Date
  updatedAt: Date
}

// ============================================
// Helpers
// ============================================

/**
 * Compute a deterministic hash for a schedule+task+sessionId triple.
 * Used to detect duplicates: two createCronJob calls with the same schedule,
 * task and sessionId produce the same hash → second call is refused.
 */
export function cronJobHash(input: {
  schedule: CronSchedule
  task: string
  sessionId?: string
}): string {
  const canonical = JSON.stringify({
    kind: input.schedule.kind,
    expr: input.schedule.expr,
    tz: input.schedule.tz || null,
    task: input.task,
    sessionId: input.sessionId || null,
  })
  return crypto.createHash('sha256').update(canonical).digest('hex')
}

/**
 * Parse an interval string like '30s', '5m', '2h', '1d' into milliseconds.
 * Returns null if the string is not a recognized interval.
 */
function parseIntervalToMs(expr: string): number | null {
  const m = expr.trim().match(/^(\d+)\s*(s|m|h|d|w)$/i)
  if (!m) return null
  const n = parseInt(m[1], 10)
  if (!Number.isFinite(n) || n <= 0) return null
  switch (m[2].toLowerCase()) {
    case 's': return n * 1000
    case 'm': return n * 60 * 1000
    case 'h': return n * 60 * 60 * 1000
    case 'd': return n * 24 * 60 * 60 * 1000
    case 'w': return n * 7 * 24 * 60 * 60 * 1000
    default: return null
  }
}

/**
 * Parse a 5-field cron expression and compute the next run after `from`.
 *
 * Supports standard fields: minute, hour, day-of-month, month, day-of-week.
 * Supports: numeric, wildcard, commas, ranges (1-5), step values (see parseCronNextRun).
 * Does NOT support: names (JAN, MON), L, W, #, special @ strings (@daily).
 *
 * Returns null if the cron expression is invalid or no next run within ~1 year
 * (to avoid spinning forever on impossible expressions like "0 30 Feb 31 *").
 */
function parseCronNextRun(expr: string, from: Date, tz?: string): Date | null {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) return null

  const fieldOpts = (field: string, min: number, max: number): number[] => {
    if (field === '*') return Array.from({ length: max - min + 1 }, (_, i) => min + i)
    const out = new Set<number>()
    for (const part of field.split(',')) {
      // step value: e.g. wildcard/5 or range/2 (regex below uses wildcards only as stand-in)
      const stepMatch = part.match(/^(\*|\d+-\d+)\/(\d+)$/)
      if (stepMatch) {
        const range = stepMatch[1]
        const step = parseInt(stepMatch[2], 10)
        let lo = min, hi = max
        if (range !== '*') {
          const [a, b] = range.split('-').map(n => parseInt(n, 10))
          if (Number.isFinite(a) && Number.isFinite(b)) { lo = a; hi = b }
        }
        for (let v = lo; v <= hi; v += step) out.add(v)
        continue
      }
      const rangeMatch = part.match(/^(\d+)-(\d+)$/)
      if (rangeMatch) {
        const a = parseInt(rangeMatch[1], 10)
        const b = parseInt(rangeMatch[2], 10)
        for (let v = a; v <= b; v++) out.add(v)
        continue
      }
      const num = parseInt(part, 10)
      if (Number.isFinite(num)) out.add(num)
    }
    return [...out].filter(v => v >= min && v <= max).sort((a, b) => a - b)
  }

  const minutes = fieldOpts(parts[0], 0, 59)
  const hours = fieldOpts(parts[1], 0, 23)
  const doms = fieldOpts(parts[2], 1, 31)
  const months = fieldOpts(parts[3], 1, 12)
  const dows = fieldOpts(parts[4], 0, 6) // 0 = Sunday
  if (!minutes.length || !hours.length || !doms.length || !months.length || !dows.length) return null

  // Try each minute starting from `from`, up to ~366 days = 527040 minutes
  const cursor = new Date(from.getTime())
  // Move to next minute boundary to avoid immediate re-fire on the same minute
  cursor.setSeconds(0, 0)
  cursor.setMinutes(cursor.getMinutes() + 1)

  const maxIters = 527040 // ~1 year
  for (let i = 0; i < maxIters; i++) {
    const min = cursor.getMinutes()
    const hr = cursor.getHours()
    const dom = cursor.getDate()
    const mon = cursor.getMonth() + 1
    const dow = cursor.getDay()
    if (minutes.includes(min) && hours.includes(hr) && doms.includes(dom) && months.includes(mon) && dows.includes(dow)) {
      // tz handling: we just return the local time (server tz). True IANA tz support
      // would require a tz library; for the sandbox the server tz is the reference.
      void tz
      return new Date(cursor.getTime())
    }
    cursor.setMinutes(cursor.getMinutes() + 1)
  }
  return null
}

/**
 * Compute the next run timestamp based on schedule kind.
 * Returns null if the schedule is invalid or expired (e.g. one_time in the past).
 */
export function computeNextRun(schedule: CronSchedule, from: Date = new Date()): Date | null {
  if (schedule.kind === 'one_time') {
    const ts = parseInt(schedule.expr, 10)
    if (!Number.isFinite(ts)) return null
    const d = new Date(ts)
    // Allow scheduling slightly in the future (1s tolerance)
    return d.getTime() > from.getTime() - 1000 ? d : null
  }
  if (schedule.kind === 'fixed_rate') {
    const intervalMs = parseIntervalToMs(schedule.expr)
    if (intervalMs === null) return null
    return new Date(from.getTime() + intervalMs)
  }
  if (schedule.kind === 'cron') {
    return parseCronNextRun(schedule.expr, from, schedule.tz)
  }
  return null
}

// ============================================
// Create cron job
// ============================================

/**
 * Register a new cron job. Refuses duplicates (same schedule+task+sessionId hash).
 *
 * @returns jobId, nextRun, dryRun flag, jobHash, duplicate flag.
 *          If duplicate=true, the existing job's ID is returned + dryRun=true
 *          (caller should not re-execute the schedule).
 */
export async function createCronJob(input: CreateCronJobInput): Promise<CreateCronJobResult> {
  // Compute hash for dedup
  const hash = cronJobHash({
    schedule: input.schedule,
    task: input.task,
    sessionId: input.sessionId,
  })

  // Check for existing job with the same hash that's still active
  const existing = await db.cronJob.findFirst({
    where: {
      jobHash: hash,
      status: { in: ['active', 'paused'] },
    },
  })
  if (existing) {
    return {
      jobId: existing.id,
      nextRun: existing.nextRunAt,
      dryRun: true,
      jobHash: hash,
      duplicate: true,
    }
  }

  // Phase 4 audit fix (Task 11, P2-2): tz is accepted but parseCronNextRun
  // uses the server's local tz (it `void tz`s the parameter). Surface a
  // console.warn so users know their cron expr fires at server-local time,
  // not their specified IANA tz. A proper fix needs a tz library (Phase 5).
  if (input.schedule.tz) {
    console.warn(
      `[CronScheduler] schedule specifies tz="${input.schedule.tz}" but the current implementation uses server-local time. The tz field is stored for future use (Phase 5 will wire a real IANA tz library). Verify the cron expression fires at the intended time.`,
    )
  }

  // Compute next run
  const nextRun = computeNextRun(input.schedule)
  if (!nextRun) {
    throw new Error(
      `Invalid or expired schedule: ${JSON.stringify(input.schedule)} — computeNextRun returned null`,
    )
  }

  // Persist
  const record = await db.cronJob.create({
    data: {
      agentId: input.agentId || 'default',
      expression: input.schedule.expr, // legacy v1 field (still in DB)
      taskPrompt: input.task, // legacy v1 field
      enabled: true,
      nextRunAt: nextRun,
      // Phase 4.6 fields:
      kind: input.schedule.kind,
      expr: input.schedule.expr,
      tz: input.schedule.tz || null,
      task: input.task,
      sessionId: input.sessionId || null,
      maxRetries: 3,
      retryCount: 0,
      jobHash: hash,
      status: 'active',
    },
  })

  return {
    jobId: record.id,
    nextRun,
    dryRun: false,
    jobHash: hash,
    duplicate: false,
  }
}

// ============================================
// List cron jobs
// ============================================

export async function listCronJobs(input: ListCronJobsInput = {}): Promise<CronJobRecord[]> {
  const where: Record<string, unknown> = {}
  if (input.status) where.status = input.status
  if (input.sessionId) where.sessionId = input.sessionId
  if (input.agentId) where.agentId = input.agentId

  const records = await db.cronJob.findMany({
    where,
    orderBy: { nextRunAt: 'asc' },
    take: 200,
  })

  return records.map(r => ({
    id: r.id,
    agentId: r.agentId,
    kind: r.kind,
    expr: r.expr,
    tz: r.tz,
    task: r.task,
    sessionId: r.sessionId,
    retryCount: r.retryCount,
    maxRetries: r.maxRetries,
    lastError: r.lastError,
    jobHash: r.jobHash,
    status: r.status,
    lastRunAt: r.lastRunAt,
    nextRunAt: r.nextRunAt,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }))
}

// ============================================
// Delete cron job (soft delete)
// ============================================

/**
 * Soft-delete a cron job — sets status='paused' so historical runs are preserved.
 * Hard-delete is intentionally not provided (audit trail requirement).
 */
export async function deleteCronJob(jobId: string): Promise<{ success: boolean; error?: string }> {
  try {
    const updated = await db.cronJob.updateMany({
      where: { id: jobId },
      data: { status: 'paused', enabled: false },
    })
    if (updated.count === 0) {
      return { success: false, error: `CronJob not found: ${jobId}` }
    }
    return { success: true }
  } catch (err) {
    return {
      success: false,
      error: `Failed to delete cron job ${jobId}: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}

// ============================================
// Run cron job manually (manual trigger for testing)
// ============================================

/**
 * Manually trigger a cron job. Useful for testing + ad-hoc execution.
 * Does NOT touch nextRunAt — the regular tick loop will still run the job
 * at its scheduled time (unless caller deletes the job first).
 */
export async function runCronJob(jobId: string): Promise<{ success: boolean; error?: string; result?: unknown }> {
  const job = await db.cronJob.findUnique({ where: { id: jobId } })
  if (!job) {
    return { success: false, error: `CronJob not found: ${jobId}` }
  }
  const result = await executeCronJob(jobId)
  return result
}

// ============================================
// Execute cron job (actual execution — called by tick loop)
// ============================================

/**
 * Execute a cron job. Spawns the agent task by calling the local API
 * (/api/code-team/assess or /api/agents/run — depending on sessionId).
 *
 * On success: retryCount reset, lastRunAt updated, nextRunAt recomputed.
 * On failure: retryCount++, lastError set, nextRun = now + 2^retryCount seconds.
 *            If retryCount >= maxRetries → status='failed'.
 * On one_time job completion → status='completed'.
 *
 * @returns success/error/result
 */
export async function executeCronJob(jobId: string): Promise<{ success: boolean; error?: string; result?: unknown }> {
  const job = await db.cronJob.findUnique({ where: { id: jobId } })
  if (!job) {
    return { success: false, error: `CronJob not found: ${jobId}` }
  }
  if (job.status === 'paused' || job.status === 'completed' || job.status === 'failed') {
    return { success: false, error: `CronJob ${jobId} is ${job.status} (cannot execute)` }
  }
  // FIX v1.2 (ALISTA audit): row có executor riêng (vd 'ALISTA' — scheduler nền
  // của executor đó tự chạy) KHÔNG được execute qua đường tick/HTTP này.
  // Trước đây task='' bị POST rỗng → 400 → 3 lần retry → row thành 'failed'
  // → ca trực 23h30 của ALISTA bị giết âm thầm.
  if (job.executor && job.executor.trim() !== '') {
    return {
      success: false,
      error: `CronJob ${jobId} owned by executor '${job.executor}' — executor riêng tự chạy row này (tick/HTTP không can thiệp)`,
    }
  }

  const startedAt = Date.now()
  let success = false
  let lastError: string | undefined
  let resultData: unknown = undefined

  try {
    // Determine endpoint: if sessionId is set → resume session; otherwise → start fresh.
    // Phase 4 audit fix: server-side fetch needs an ABSOLUTE URL — relative paths
    // fail with "fetch() URL is invalid" because Node/Bun has no base URL context
    // (unlike browser fetch). Default to localhost:3000 (main app) which is the
    // same host as the cron-scheduler mini-service. Override via CRON_AGENT_ENDPOINT
    // env var if cron needs to target a different host:port.
    const base = process.env.CRON_AGENT_ENDPOINT || 'http://localhost:3000/api/openclaw/sessions'
    const url = `${base}?action=run`
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: job.sessionId,
        task: job.task,
        agentId: job.agentId,
        source: 'cron',
        jobId: job.id,
      }),
      signal: AbortSignal.timeout(120_000),
    })
    if (res.ok) {
      resultData = await res.json().catch(() => null)
      success = true
    } else {
      lastError = `HTTP ${res.status}: ${await res.text().catch(() => '')}`
    }
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err)
  }

  const durationMs = Date.now() - startedAt
  const now = new Date()
  void durationMs

  if (success) {
    // Reset retry + recompute nextRun
    const nextRun = computeNextRun(
      { kind: job.kind as CronSchedule['kind'], expr: job.expr, tz: job.tz || undefined },
      now,
    )
    await db.cronJob.update({
      where: { id: jobId },
      data: {
        lastRunAt: now,
        nextRunAt: nextRun,
        retryCount: 0,
        lastError: null,
        // For one_time jobs: mark as completed (no further runs)
        status: job.kind === 'one_time' ? 'completed' : 'active',
      },
    })
    console.log(`[CronScheduler] executed job ${jobId} (${durationMs}ms, success=true, nextRun=${nextRun?.toISOString()})`)
    return { success: true, result: resultData }
  }

  // Failure path — increment retry count
  const newRetry = job.retryCount + 1
  const backoffSec = Math.pow(2, newRetry) // 2, 4, 8, 16, ...
  const backoffMs = backoffSec * 1000
  const nextRun = new Date(now.getTime() + backoffMs)

  if (newRetry >= job.maxRetries) {
    // Max retries exhausted → fail
    await db.cronJob.update({
      where: { id: jobId },
      data: {
        retryCount: newRetry,
        lastError: lastError || 'unknown error',
        lastRunAt: now,
        nextRunAt: null,
        status: 'failed',
      },
    })
    console.warn(`[CronScheduler] job ${jobId} FAILED (maxRetries=${job.maxRetries} reached): ${lastError}`)
    return { success: false, error: lastError }
  }

  // Retry scheduled
  await db.cronJob.update({
    where: { id: jobId },
    data: {
      retryCount: newRetry,
      lastError: lastError || 'unknown error',
      lastRunAt: now,
      nextRunAt: nextRun,
    },
  })
  console.warn(`[CronScheduler] job ${jobId} failed (attempt ${newRetry}/${job.maxRetries}, will retry in ${backoffSec}s): ${lastError}`)
  return { success: false, error: lastError }
}

// ============================================
// Tick — query for due jobs + execute them
// ============================================

/**
 * Tick function — called by the mini-service every 30s (default).
 * Queries the DB for jobs whose nextRunAt <= now AND status='active', then
 * executes each in parallel (with a concurrency cap to avoid flooding the API).
 *
 * FIX v1.2 (ALISTA audit): chỉ execute các row executor='' (default executor).
 * Row có executor riêng (vd ALISTA scheduler 23h30) được executor đó tự chạy —
 * tick này bỏ qua để không POST task rỗng → 400 → retry → giết row thành 'failed'.
 *
 * @returns number of jobs executed
 */
export async function tickCronScheduler(): Promise<number> {
  const now = new Date()
  const due = await db.cronJob.findMany({
    where: {
      status: 'active',
      nextRunAt: { lte: now },
      enabled: true,
      executor: '', // chỉ row của default executor — row executor-owned bị skip
    },
    take: 10, // cap per tick to avoid runaway
  })

  if (due.length === 0) return 0

  console.log(`[CronScheduler] tick: ${due.length} due job(s) at ${now.toISOString()}`)

  // Execute in parallel (cap 5 concurrent)
  const concurrency = 5
  for (let i = 0; i < due.length; i += concurrency) {
    const batch = due.slice(i, i + concurrency)
    await Promise.allSettled(batch.map(j => executeCronJob(j.id)))
  }

  return due.length
}
