/**
 * Tool Usage Analytics API — Task 20-b rewrite
 *
 * GET /api/tools/analytics?days=7 — analytics tool usage từ bảng ToolMetric THẬT.
 *
 * Trước đây route này cast `db.toolCallLog` — model KHÔNG tồn tại trong
 * schema.prisma → runtime luôn 500 (dead code). Từ 20-b, executeTool() ghi
 * MỖI tool call vào ToolMetric (qua recordAgentActivity choke-point) → route
 * này đọc dữ liệu thật: success rate per tool/agent, timeline theo ngày,
 * alerts tool tệ.
 *
 * Query params:
 *   days=7   — số ngày nhìn lại (default 7, max 90)
 *
 * Fail-open: lỗi DB → vẫn trả 200 với zero-state (đúng tinh thần các route
 * khác của app — analytics không được phép 500).
 */

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

const DEFAULT_DAYS = 7
const MAX_DAYS = 90
const BY_TOOL_LIMIT = 50
const BY_AGENT_LIMIT = 20
const ALERTS_LIMIT = 10

/** Tính success rate an toàn (0 nếu không có call) — làm tròn 3 chữ số */
function successRate(successCount: number, total: number): number {
  return total === 0 ? 0 : Math.round((successCount / total) * 1000) / 1000
}

/** Tính avg duration an toàn */
function avgDuration(totalDurationMs: number, count: number): number {
  return count === 0 ? 0 : Math.round(totalDurationMs / count)
}

function zeroState(days: number, from: Date, to: Date) {
  return {
    period: { days, from: from.toISOString(), to: to.toISOString() },
    summary: {
      totalCalls: 0,
      successRate: 0,
      avgDurationMs: 0,
      uniqueTools: 0,
      uniqueAgents: 0,
    },
    byTool: [] as Array<{
      toolName: string
      calls: number
      successRate: number
      avgDurationMs: number
      errors: number
      topErrorTag: string | null
    }>,
    byAgent: [] as Array<{
      agentRole: string
      calls: number
      successRate: number
      avgDurationMs: number
    }>,
    timeline: [] as Array<{ date: string; calls: number; successRate: number }>,
    alerts: [] as Array<{
      toolName: string
      calls: number
      successRate: number
      reason: string
    }>,
  }
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const parsedDays = parseInt(searchParams.get('days') || '', 10)
  const days =
    Number.isFinite(parsedDays) && parsedDays > 0
      ? Math.min(parsedDays, MAX_DAYS)
      : DEFAULT_DAYS
  const to = new Date()
  const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000)

  try {
    const logs = await db.toolMetric.findMany({
      where: { timestamp: { gte: from } },
      select: {
        toolName: true,
        sessionId: true,
        agentRole: true,
        success: true,
        durationMs: true,
        errorTag: true,
        timestamp: true,
      },
      orderBy: { timestamp: 'desc' },
    })

    // ---- Summary ----
    const totalCalls = logs.length
    const successCount = logs.filter(l => l.success).length
    const totalDurationMs = logs.reduce((sum, l) => sum + l.durationMs, 0)
    const uniqueTools = new Set(logs.map(l => l.toolName)).size
    const uniqueAgents = new Set(logs.map(l => l.agentRole)).size

    const summary = {
      totalCalls,
      successRate: successRate(successCount, totalCalls),
      avgDurationMs: avgDuration(totalDurationMs, totalCalls),
      uniqueTools,
      uniqueAgents,
    }

    // ---- By tool (calls desc, limit 50) ----
    interface ToolAgg {
      calls: number
      successCount: number
      totalDuration: number
      errors: number
      errorTags: Map<string, number>
    }
    const toolMap = new Map<string, ToolAgg>()
    for (const l of logs) {
      const agg =
        toolMap.get(l.toolName) ||
        { calls: 0, successCount: 0, totalDuration: 0, errors: 0, errorTags: new Map<string, number>() }
      agg.calls++
      if (l.success) {
        agg.successCount++
      } else {
        agg.errors++
        if (l.errorTag) {
          agg.errorTags.set(l.errorTag, (agg.errorTags.get(l.errorTag) || 0) + 1)
        }
      }
      agg.totalDuration += l.durationMs
      toolMap.set(l.toolName, agg)
    }
    const byTool = Array.from(toolMap.entries())
      .map(([toolName, agg]) => {
        let topErrorTag: string | null = null
        let topCount = 0
        for (const [tag, count] of agg.errorTags) {
          if (count > topCount) {
            topCount = count
            topErrorTag = tag
          }
        }
        return {
          toolName,
          calls: agg.calls,
          successRate: successRate(agg.successCount, agg.calls),
          avgDurationMs: avgDuration(agg.totalDuration, agg.calls),
          errors: agg.errors,
          topErrorTag,
        }
      })
      .sort((a, b) => b.calls - a.calls)
      .slice(0, BY_TOOL_LIMIT)

    // ---- By agent (limit 20) ----
    const agentMap = new Map<string, { calls: number; successCount: number; totalDuration: number }>()
    for (const l of logs) {
      const agg = agentMap.get(l.agentRole) || { calls: 0, successCount: 0, totalDuration: 0 }
      agg.calls++
      if (l.success) agg.successCount++
      agg.totalDuration += l.durationMs
      agentMap.set(l.agentRole, agg)
    }
    const byAgent = Array.from(agentMap.entries())
      .map(([agentRole, agg]) => ({
        agentRole,
        calls: agg.calls,
        successRate: successRate(agg.successCount, agg.calls),
        avgDurationMs: avgDuration(agg.totalDuration, agg.calls),
      }))
      .sort((a, b) => b.calls - a.calls)
      .slice(0, BY_AGENT_LIMIT)

    // ---- Timeline (bucket theo ngày YYYY-MM-DD, UTC) ----
    const dayMap = new Map<string, { calls: number; successCount: number }>()
    for (const l of logs) {
      const date = l.timestamp.toISOString().slice(0, 10)
      const agg = dayMap.get(date) || { calls: 0, successCount: 0 }
      agg.calls++
      if (l.success) agg.successCount++
      dayMap.set(date, agg)
    }
    const timeline = Array.from(dayMap.entries())
      .map(([date, agg]) => ({
        date,
        calls: agg.calls,
        successRate: successRate(agg.successCount, agg.calls),
      }))
      .sort((a, b) => a.date.localeCompare(b.date))

    // ---- Alerts: successRate < 50% và >= 5 calls, tệ nhất trước, limit 10 ----
    const alerts = Array.from(toolMap.entries())
      .filter(([, agg]) => agg.calls >= 5 && successRate(agg.successCount, agg.calls) < 0.5)
      .map(([toolName, agg]) => ({
        toolName,
        calls: agg.calls,
        successRate: successRate(agg.successCount, agg.calls),
        reason: `success rate < 50% (>= 5 calls)`,
      }))
      .sort((a, b) => a.successRate - b.successRate || b.calls - a.calls)
      .slice(0, ALERTS_LIMIT)

    return NextResponse.json({
      period: { days, from: from.toISOString(), to: to.toISOString() },
      summary,
      byTool,
      byAgent,
      timeline,
      alerts,
    })
  } catch (error) {
    // Fail-open — zero-state 200 (analytics không được phép 500)
    console.error('[Tools/Analytics] GET error (fail-open → zero-state):', error)
    return NextResponse.json(zeroState(days, from, to))
  }
}
