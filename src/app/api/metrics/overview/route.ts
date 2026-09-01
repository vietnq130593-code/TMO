/**
 * Centralized Runtime Metrics Overview — Task 20-b
 *
 * GET /api/metrics/overview?hours=24 — 1 endpoint tập trung metrics runtime
 * của toàn bộ agent platform (trước đây 3 silo: Token tab / in-memory activity
 * / Layer 9 Learning).
 *
 * Sections (MỖI section độc lập try/catch fail-open — section lỗi → zero-state,
 * KHÔNG làm fail cả response):
 *   tokens — DailyTokenByAgent HÔM NAY (merge in-memory llm.ts + SQLite, pattern
 *            giống /api/token-usage/agents) group by agentName, top 5
 *   tools  — ToolMetric trong `hours` gần nhất: total/successRate/avgDuration +
 *            topFailures (tool tệ nhất kèm topErrorTag)
 *   runs   — AgentRunRecord trong `hours` gần nhất: total/active/completed/
 *            failed/noProgress + byStopReason + 10 runs gần nhất
 *           (LƯU Ý v1: AgentRunRecord chỉ ghi khi run KẾT THÚC nên active luôn 0
 *            — task 20-c sẽ wire ghi row lúc run start)
 *   alerts — (a) no_progress >= 3 → high; (b) tool successRate < 50% với
 *            >= 10 calls → medium
 *
 * Query params: hours=24 (default 24, max 168)
 */

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { findAgentRunRecordsSince } from '@/lib/metrics-db'
import { getDailyTokensByAgent } from '@/lib/llm'

export const dynamic = 'force-dynamic'

const DEFAULT_HOURS = 24
const MAX_HOURS = 168
const TOP_AGENTS = 5
const TOP_FAILURES = 5
const RECENT_RUNS = 10
const MAX_RANGE_DAYS = 90 // cap khoảng lịch sử

/** Hôm nay theo timezone user (Asia/Ho_Chi_Minh) — cùng chuẩn token-usage routes */
function getTodayUserTz(): string {
  const now = new Date()
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Ho_Chi_Minh',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now)
  const year = parts.find(p => p.type === 'year')!.value
  const month = parts.find(p => p.type === 'month')!.value
  const day = parts.find(p => p.type === 'day')!.value
  return `${year}-${month}-${day}`
}

/**
 * Parse ?from=YYYY-MM-DD & ?to=YYYY-MM-DD (v1.1 — ALISTA UI range picker).
 * Validate: from≤to, to≤hôm nay, span≤MAX_RANGE_DAYS. Trả null nếu không hợp lệ.
 * Khi hợp lệ, trả {from, to, fromT00z, toT23z} cho filter (timestamp + date string).
 */
function parseRangeParams(searchParams: URLSearchParams): {
  from: string
  to: string
  /** Từ 00:00:00+07:00 của ngày from (timestamp filter lower bound) */
  fromTzMs: number
  /** Đến 23:59:59+07:00 của ngày to (timestamp filter upper bound) */
  toTzMs: number
} | null {
  const from = searchParams.get('from')
  const to = searchParams.get('to')
  if (!from || !to) return null
  // Validate format YYYY-MM-DD
  const dateRe = /^\d{4}-\d{2}-\d{2}$/
  if (!dateRe.test(from) || !dateRe.test(to)) return null
  // Parse thành epoch ms (tz HN)
  const fromTzMs = new Date(`${from}T00:00:00+07:00`).getTime()
  const toTzMs = new Date(`${to}T23:59:59+07:00`).getTime()
  if (!Number.isFinite(fromTzMs) || !Number.isFinite(toTzMs)) return null
  // from ≤ to ≤ hôm nay
  const todayMs = new Date(`${getTodayUserTz()}T23:59:59+07:00`).getTime()
  if (fromTzMs > toTzMs) return null
  if (toTzMs > todayMs) return null
  // span ≤ MAX_RANGE_DAYS
  const spanDays = (toTzMs - fromTzMs) / (24 * 3600_000)
  if (spanDays > MAX_RANGE_DAYS) return null
  return { from, to, fromTzMs, toTzMs }
}

/** Lấy danh sách date string YYYY-MM-DD trong khoảng [from..to] (cho DailyTokenByAgent query) */
function dateStringsInRange(from: string, to: string): string[] {
  const out: string[] = []
  const startMs = new Date(`${from}T00:00:00+07:00`).getTime()
  const endMs = new Date(`${to}T00:00:00+07:00`).getTime()
  for (let t = startMs; t <= endMs; t += 24 * 3600_000) {
    out.push(new Date(t).toISOString().slice(0, 10))
  }
  return out
}

function rate(success: number, total: number): number {
  return total === 0 ? 0 : Math.round((success / total) * 1000) / 1000
}

function avgMs(total: number, count: number): number {
  return count === 0 ? 0 : Math.round(total / count)
}

// ---- Zero-states ----

function zeroTokens() {
  return {
    total: 0,
    input: 0,
    output: 0,
    byAgent: [] as Array<{ agentName: string; tokens: number; input: number; output: number }>,
  }
}

function zeroTools() {
  return {
    totalCalls: 0,
    successRate: 0,
    avgDurationMs: 0,
    topFailures: [] as Array<{ toolName: string; errors: number; topErrorTag: string | null }>,
  }
}

function zeroRuns() {
  return {
    total: 0,
    active: 0,
    completed: 0,
    failed: 0,
    noProgress: 0,
    byStopReason: {} as Record<string, number>,
    recentRuns: [] as Array<Record<string, unknown>>,
  }
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const parsedHours = parseInt(searchParams.get('hours') || '', 10)
  const hours =
    Number.isFinite(parsedHours) && parsedHours > 0
      ? Math.min(parsedHours, MAX_HOURS)
      : DEFAULT_HOURS
  const since = new Date(Date.now() - hours * 60 * 60 * 1000)

  // v1.1 — ALISTA UI range picker: ?from=YYYY-MM-DD&to=YYYY-MM-DD
  // Khi có range hợp lệ, dùng range thay cho hours (chế độ lịch sử).
  const range = parseRangeParams(searchParams)

  // ==================== tokens (DailyTokenByAgent hôm nay, hoặc list date trong range) ====================
  let tokens = zeroTokens()
  try {
    // Range mode: query nhiều ngày + group by agent
    // Live mode: query hôm nay như cũ
    const dates = range ? dateStringsInRange(range.from, range.to) : [getTodayUserTz()]
    const dbRecords = await db.dailyTokenByAgent.findMany({ where: { date: { in: dates } } })

    // Merge in-memory + DB (MAX per key) — pattern của /api/token-usage/agents
    const merged = new Map<
      string,
      { agentId: string; agentName: string; tokens: number; inputTokens: number; outputTokens: number }
    >()
    for (const r of dbRecords) {
      merged.set(`${r.agentId}:${r.provider}:${r.model}`, {
        agentId: r.agentId,
        agentName: r.agentName,
        tokens: r.tokens,
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
      })
    }
    for (const item of getDailyTokensByAgent()) {
      const key = `${item.agentId}:${item.provider}:${item.model}`
      const existing = merged.get(key)
      if (existing) {
        existing.tokens = Math.max(existing.tokens, item.tokens)
        existing.inputTokens = Math.max(existing.inputTokens, item.inputTokens)
        existing.outputTokens = Math.max(existing.outputTokens, item.outputTokens)
      } else {
        merged.set(key, {
          agentId: item.agentId,
          agentName: item.agentName,
          tokens: item.tokens,
          inputTokens: item.inputTokens,
          outputTokens: item.outputTokens,
        })
      }
    }

    // Group by agentName
    const byAgentMap = new Map<string, { tokens: number; input: number; output: number }>()
    for (const rec of merged.values()) {
      const agg = byAgentMap.get(rec.agentName) || { tokens: 0, input: 0, output: 0 }
      agg.tokens += rec.tokens
      agg.input += rec.inputTokens
      agg.output += rec.outputTokens
      byAgentMap.set(rec.agentName, agg)
    }
    const byAgent = Array.from(byAgentMap.entries())
      .map(([agentName, agg]) => ({ agentName, ...agg }))
      .sort((a, b) => b.tokens - a.tokens)
      .slice(0, TOP_AGENTS)

    tokens = {
      total: Array.from(byAgentMap.values()).reduce((s, a) => s + a.tokens, 0),
      input: Array.from(byAgentMap.values()).reduce((s, a) => s + a.input, 0),
      output: Array.from(byAgentMap.values()).reduce((s, a) => s + a.output, 0),
      byAgent,
    }
  } catch (error) {
    console.error('[Metrics/Overview] tokens section error (fail-open):', error)
    tokens = zeroTokens()
  }

  // ==================== tools (ToolMetric trong `hours` hoặc [from..to]) ====================
  let tools = zeroTools()
  let toolRows: Array<{ toolName: string; success: boolean; durationMs: number; errorTag: string | null }> = []
  try {
    // v1.1: range mode — filter theo [fromTzMs..toTzMs]
    const toolWhere = range
      ? { timestamp: { gte: new Date(range.fromTzMs), lte: new Date(range.toTzMs) } }
      : { timestamp: { gte: since } }
    toolRows = await db.toolMetric.findMany({
      where: toolWhere,
      select: { toolName: true, success: true, durationMs: true, errorTag: true },
    })
    const totalCalls = toolRows.length
    const successCount = toolRows.filter(t => t.success).length
    const totalDuration = toolRows.reduce((s, t) => s + t.durationMs, 0)

    // Top failures: group toolName → errors + errorTag phổ biến nhất
    const failMap = new Map<string, { errors: number; errorTags: Map<string, number> }>()
    for (const t of toolRows) {
      if (t.success) continue
      const agg = failMap.get(t.toolName) || { errors: 0, errorTags: new Map<string, number>() }
      agg.errors++
      if (t.errorTag) agg.errorTags.set(t.errorTag, (agg.errorTags.get(t.errorTag) || 0) + 1)
      failMap.set(t.toolName, agg)
    }
    const topFailures = Array.from(failMap.entries())
      .map(([toolName, agg]) => {
        let topErrorTag: string | null = null
        let topCount = 0
        for (const [tag, count] of agg.errorTags) {
          if (count > topCount) {
            topCount = count
            topErrorTag = tag
          }
        }
        return { toolName, errors: agg.errors, topErrorTag }
      })
      .sort((a, b) => b.errors - a.errors)
      .slice(0, TOP_FAILURES)

    tools = {
      totalCalls,
      successRate: rate(successCount, totalCalls),
      avgDurationMs: avgMs(totalDuration, totalCalls),
      topFailures,
    }
  } catch (error) {
    console.error('[Metrics/Overview] tools section error (fail-open):', error)
    tools = zeroTools()
    toolRows = []
  }

  // ==================== runs (AgentRunRecord trong `hours` hoặc [from..to]) ====================
  let runs = zeroRuns()
  let noProgressCount = 0
  try {
    // v1.1: range mode — query since from, rồi filter in-memory theo upper bound
    // (findAgentRunRecordsSince delegate/raw không có overload Between — an toàn dùng since+filter)
    const runSince = range ? new Date(range.fromTzMs) : since
    const runUpperMs = range ? range.toTzMs : Date.now()
    const allRunRows = await findAgentRunRecordsSince(runSince)
    // Filter theo upper bound (createdAt ≤ toTzMs)
    const runRows = allRunRows.filter(r => (r.createdAt ?? new Date(0)).getTime() <= runUpperMs)
    noProgressCount = runRows.filter(r => r.stopReason === 'no_progress').length
    const byStopReason: Record<string, number> = {}
    for (const r of runRows) {
      if (r.stopReason) byStopReason[r.stopReason] = (byStopReason[r.stopReason] || 0) + 1
    }
    runs = {
      total: runRows.length,
      // v1: AgentRunRecord chỉ ghi khi run KẾT THÚC → active luôn 0 (20-c wire)
      active: runRows.filter(r => r.status === 'running').length,
      completed: runRows.filter(r => r.status === 'completed').length,
      failed: runRows.filter(r => r.status === 'failed').length,
      noProgress: noProgressCount,
      byStopReason,
      recentRuns: runRows.slice(0, RECENT_RUNS).map(r => ({
        id: r.id,
        sessionId: r.sessionId,
        agentName: r.agentName,
        status: r.status,
        stopReason: r.stopReason,
        cycles: r.cycles,
        tokensUsed: r.tokensUsed,
        toolCalls: r.toolCalls,
        toolFailures: r.toolFailures,
        durationMs: r.durationMs,
        evaluatorConfidence: r.evaluatorConfidence,
        complete: r.complete,
        startedAt: r.startedAt,
        completedAt: r.completedAt,
        createdAt: r.createdAt,
      })),
    }
  } catch (error) {
    console.error('[Metrics/Overview] runs section error (fail-open):', error)
    runs = zeroRuns()
  }

  // ==================== alerts ====================
  const alerts: Array<{ severity: 'high' | 'medium'; type: string; message: string }> = []
  try {
    // (a) Stuck loops: >= 3 run no_progress trong khoảng
    const periodLabel = range ? `khoảng ${range.from} → ${range.to}` : `${hours}h gần nhất`
    if (noProgressCount >= 3) {
      alerts.push({
        severity: 'high',
        type: 'stuck_loops',
        message: `${noProgressCount} vòng lặp kẹt (no_progress) trong ${periodLabel}`,
      })
    }
    // (b) Tool fail: successRate < 50% với >= 10 calls
    const toolAgg = new Map<string, { calls: number; success: number }>()
    for (const t of toolRows) {
      const agg = toolAgg.get(t.toolName) || { calls: 0, success: 0 }
      agg.calls++
      if (t.success) agg.success++
      toolAgg.set(t.toolName, agg)
    }
    const badTools = Array.from(toolAgg.entries())
      .filter(([, agg]) => agg.calls >= 10 && rate(agg.success, agg.calls) < 0.5)
      .sort((a, b) => rate(a[1].success, a[1].calls) - rate(b[1].success, b[1].calls))
    if (badTools.length > 0) {
      alerts.push({
        severity: 'medium',
        type: 'tool_failures',
        message: `Tool success rate < 50%: ${badTools
          .slice(0, 5)
          .map(([name, agg]) => `${name} (${Math.round(rate(agg.success, agg.calls) * 100)}%, ${agg.calls} calls)`)
          .join(', ')}`,
      })
    }
  } catch (error) {
    console.error('[Metrics/Overview] alerts section error (fail-open):', error)
  }

  return NextResponse.json({
    generatedAt: new Date().toISOString(),
    // v1.1: range mode trả {from, to}; live mode trả {hours} như cũ
    period: range ? { from: range.from, to: range.to, hours } : { hours },
    tokens,
    tools,
    runs,
    alerts,
  })
}
