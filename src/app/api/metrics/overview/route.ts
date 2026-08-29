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

  // ==================== tokens (DailyTokenByAgent hôm nay) ====================
  let tokens = zeroTokens()
  try {
    const date = getTodayUserTz()
    const dbRecords = await db.dailyTokenByAgent.findMany({ where: { date } })

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

  // ==================== tools (ToolMetric trong `hours`) ====================
  let tools = zeroTools()
  let toolRows: Array<{ toolName: string; success: boolean; durationMs: number; errorTag: string | null }> = []
  try {
    toolRows = await db.toolMetric.findMany({
      where: { timestamp: { gte: since } },
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

  // ==================== runs (AgentRunRecord trong `hours`) ====================
  let runs = zeroRuns()
  let noProgressCount = 0
  try {
    // findAgentRunRecordsSince: delegate path nếu Prisma instance fresh,
    // raw-SQL bridge nếu stale (Task 20-b — dev server chạy trước db:push)
    const runRows = await findAgentRunRecordsSince(since)
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
    if (noProgressCount >= 3) {
      alerts.push({
        severity: 'high',
        type: 'stuck_loops',
        message: `${noProgressCount} vòng lặp kẹt (no_progress) trong ${hours}h gần nhất`,
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
    period: { hours },
    tokens,
    tools,
    runs,
    alerts,
  })
}
