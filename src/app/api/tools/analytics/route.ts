/**
 * Tool Usage Analytics API
 *
 * GET /api/tools/analytics — Return analytics data for tool usage
 *
 * Query params:
 *   range=24h|7d|30d|all  — time range (default: 24h)
 *   agentId=default        — filter by agent (default: all)
 *   toolName=...           — filter by tool name
 *   format=json|csv        — output format (default: json)
 *
 * Returns:
 *   - summary: aggregate stats (total calls, success rate, avg duration, unique tools/agents)
 *   - topTools: per-tool breakdown
 *   - topAgents: per-agent breakdown
 *   - timeline: hourly time series
 *   - failures: top error messages
 *   - bySource: breakdown by tool source (local, gateway-http, gateway-bridge, custom)
 *   - alerts: automatically detected anomalies (e.g. high failure rate)
 */

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'

/** Shape log mong đợi của bảng ToolCallLog — model CHƯA có trong schema.prisma.
 *  Truy vấn qua cast; runtime db.toolCallLog undefined → throw → catch → 500
 *  (giữ nguyên behavior hiện tại, chờ schema thêm model). */
interface ToolCallLogRow {
  agentId: string
  agentName: string | null
  toolName: string
  toolSource: string
  success: boolean
  durationMs: number
  errorMessage: string | null
  createdAt: Date
}

/** Delegate mô tả các method đang dùng — cast từ PrismaClient (model thiếu trong schema) */
interface ToolCallLogDelegate {
  findMany(args: {
    where?: Record<string, unknown>
    select?: Record<string, boolean>
    orderBy?: Record<string, string>
    take?: number
  }): Promise<ToolCallLogRow[]>
}

export const dynamic = 'force-dynamic'

/** Valid time ranges */
const VALID_RANGES = ['24h', '7d', '30d', 'all'] as const
type ValidRange = (typeof VALID_RANGES)[number]

/** Compute the start date for a given time range */
function getStartDate(range: ValidRange): Date | null {
  if (range === 'all') return null
  const now = new Date()
  switch (range) {
    case '24h': return new Date(now.getTime() - 24 * 60 * 60 * 1000)
    case '7d': return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
    case '30d': return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
  }
}

/** Format a date as ISO hour string: "2024-01-15T10:00" */
function formatHour(date: Date): string {
  return date.toISOString().slice(0, 13) + ':00'
}

/** Compute success rate safely (returns 0 if no calls) */
function successRate(successCount: number, total: number): number {
  return total === 0 ? 0 : Math.round((successCount / total) * 1000) / 1000
}

/** Compute average duration safely */
function avgDuration(totalDuration: number, count: number): number {
  return count === 0 ? 0 : Math.round(totalDuration / count)
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const range = (searchParams.get('range') || '24h') as ValidRange
    const agentId = searchParams.get('agentId') || undefined
    const toolName = searchParams.get('toolName') || undefined
    const format = searchParams.get('format') || 'json'

    // Validate range
    if (!VALID_RANGES.includes(range)) {
      return NextResponse.json(
        { error: `Invalid range "${range}". Must be one of: 24h, 7d, 30d, all` },
        { status: 400 }
      )
    }

    // Build where clause
    const startDate = getStartDate(range)
    const where: Record<string, unknown> = {}
    if (startDate) {
      where.createdAt = { gte: startDate }
    }
    if (agentId && agentId !== 'all') {
      where.agentId = agentId
    }
    if (toolName) {
      where.toolName = toolName
    }

    // Fetch all matching logs
    const toolCallLog = (db as unknown as { toolCallLog: ToolCallLogDelegate }).toolCallLog
    const logs = await toolCallLog.findMany({
      where,
      select: {
        agentId: true,
        agentName: true,
        toolName: true,
        toolSource: true,
        success: true,
        durationMs: true,
        errorMessage: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    })

    // ---- Compute analytics ----

    // Summary
    const totalCalls = logs.length
    const successCount = logs.filter(l => l.success).length
    const totalDurationMs = logs.reduce((sum, l) => sum + l.durationMs, 0)
    const uniqueTools = new Set(logs.map(l => l.toolName)).size
    const uniqueAgents = new Set(logs.map(l => l.agentId)).size

    const summary = {
      totalCalls,
      successRate: successRate(successCount, totalCalls),
      avgDurationMs: avgDuration(totalDurationMs, totalCalls),
      uniqueTools,
      uniqueAgents,
    }

    // Top tools
    const toolMap = new Map<string, { calls: number; successCount: number; totalDuration: number }>()
    for (const l of logs) {
      const existing = toolMap.get(l.toolName) || { calls: 0, successCount: 0, totalDuration: 0 }
      existing.calls++
      if (l.success) existing.successCount++
      existing.totalDuration += l.durationMs
      toolMap.set(l.toolName, existing)
    }
    const topTools = Array.from(toolMap.entries())
      .map(([toolName, data]) => ({
        toolName,
        calls: data.calls,
        successRate: successRate(data.successCount, data.calls),
        avgDurationMs: avgDuration(data.totalDuration, data.calls),
      }))
      .sort((a, b) => b.calls - a.calls)
      .slice(0, 20)

    // Top agents
    const agentMap = new Map<string, { agentName: string; calls: number; successCount: number }>()
    for (const l of logs) {
      const existing = agentMap.get(l.agentId) || { agentName: l.agentName || l.agentId, calls: 0, successCount: 0 }
      existing.calls++
      if (l.success) existing.successCount++
      agentMap.set(l.agentId, existing)
    }
    const topAgents = Array.from(agentMap.entries())
      .map(([id, data]) => ({
        agentId: id,
        agentName: data.agentName,
        calls: data.calls,
        successRate: successRate(data.successCount, data.calls),
      }))
      .sort((a, b) => b.calls - a.calls)
      .slice(0, 10)

    // Timeline (hourly buckets)
    const timelineMap = new Map<string, { calls: number; successCount: number; totalDuration: number }>()
    for (const l of logs) {
      const hour = formatHour(l.createdAt)
      const existing = timelineMap.get(hour) || { calls: 0, successCount: 0, totalDuration: 0 }
      existing.calls++
      if (l.success) existing.successCount++
      existing.totalDuration += l.durationMs
      timelineMap.set(hour, existing)
    }
    const timeline = Array.from(timelineMap.entries())
      .map(([hour, data]) => ({
        hour,
        calls: data.calls,
        successRate: successRate(data.successCount, data.calls),
        avgDurationMs: avgDuration(data.totalDuration, data.calls),
      }))
      .sort((a, b) => a.hour.localeCompare(b.hour))

    // Failures — group by (toolName, errorMessage)
    const failureMap = new Map<string, { toolName: string; errorMessage: string; count: number; lastAt: string }>()
    for (const l of logs) {
      if (!l.success && l.errorMessage) {
        const key = `${l.toolName}::${l.errorMessage}`
        const existing = failureMap.get(key)
        if (existing) {
          existing.count++
          existing.lastAt = l.createdAt.toISOString()
        } else {
          failureMap.set(key, {
            toolName: l.toolName,
            errorMessage: l.errorMessage,
            count: 1,
            lastAt: l.createdAt.toISOString(),
          })
        }
      }
    }
    const failures = Array.from(failureMap.values())
      .sort((a, b) => b.count - a.count)
      .slice(0, 20)

    // By source
    const sourceMap = new Map<string, { calls: number; successCount: number }>()
    for (const l of logs) {
      const existing = sourceMap.get(l.toolSource) || { calls: 0, successCount: 0 }
      existing.calls++
      if (l.success) existing.successCount++
      sourceMap.set(l.toolSource, existing)
    }
    const bySource: Record<string, { calls: number; successRate: number }> = {}
    for (const [source, data] of sourceMap.entries()) {
      bySource[source] = {
        calls: data.calls,
        successRate: successRate(data.successCount, data.calls),
      }
    }

    // Alerts — detect anomalies
    const alerts: Array<{ type: string; toolName: string; rate: number; message: string }> = []
    for (const [toolName, data] of toolMap.entries()) {
      if (data.calls >= 5) {
        const failRate = 1 - successRate(data.successCount, data.calls)
        if (failRate >= 0.25) {
          alerts.push({
            type: 'high_failure_rate',
            toolName,
            rate: Math.round(failRate * 100) / 100,
            message: `${toolName} has ${Math.round(failRate * 100)}% failure rate`,
          })
        }
      }
    }

    const result = { summary, topTools, topAgents, timeline, failures, bySource, alerts }

    // CSV format
    if (format === 'csv') {
      const lines: string[] = ['toolName,calls,successRate,avgDurationMs']
      for (const t of topTools) {
        lines.push(`${t.toolName},${t.calls},${t.successRate},${t.avgDurationMs}`)
      }
      return new NextResponse(lines.join('\n'), {
        headers: {
          'Content-Type': 'text/csv',
          'Content-Disposition': 'attachment; filename="tool-analytics.csv"',
        },
      })
    }

    return NextResponse.json(result)
  } catch (error) {
    console.error('[Tools/Analytics] GET error:', error)
    return NextResponse.json({ error: 'Failed to compute analytics' }, { status: 500 })
  }
}
