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
 *   days=7     — số ngày nhìn lại (default 7, max 90)
 *   window=24h | 48h — R7-M3 (round-7 observation): chế độ SO SÁNH CỬA SỔ —
 *                trả current window vs previous window (cùng độ dài) group
 *                theo CATEGORY (read/modify/execute/verify/plan/delegate/other)
 *                + byTool kèm category + chỉ số cân bằng. Dùng quan sát tool
 *                usage imbalance theo thời gian (đánh giá hiệu quả các fix
 *                tool-economy qua từng cửa sổ).
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

// ==================== R7-M3 — TOOL CATEGORY CLASSIFIER ====================
// Phân loại tool theo NHÓM HÀNH ĐỘNG để đo cân bằng usage (điều tra Task 12:
// read-ish 2.240 vs sửa/ghi 329 = 7:1 — imbalance lộ rõ khi group theo nhóm
// thay vì đếm từng tool rời rạc). ToolMetric không lưu args nên shell không
// tách được read/write bên trong → nhóm 'execute' riêng (trung lập).
const TOOL_CATEGORY_MAP: Record<string, string> = {}
const CATEGORY_DEFS: Array<{ category: string; label: string; tools: string[] }> = [
  {
    category: 'read', label: 'Đọc',
    tools: ['file_read', 'file_list', 'grep', 'knowledge_search', 'list_skills', 'read_skill', 'list_custom_tools', 'web_fetch', 'lsp_diagnostics', 'get_diagnostics', 'browser_screenshot', 'read_output', 'sessions_list', 'list_sessions', 'gateway_status'],
  },
  {
    category: 'modify', label: 'Sửa/ghi',
    tools: ['file_edit', 'file_multi_edit', 'file_write', 'file_delete', 'mkdir', 'git_commit', 'gateway_edit', 'gateway_write', 'gateway_apply_patch', 'knowledge_write', 'create_custom_tool', 'todo_write'],
  },
  {
    category: 'execute', label: 'Thực thi',
    tools: ['shell', 'run_bg', 'kill_process', 'run_tests', 'manage_packages', 'opencode'],
  },
  {
    category: 'verify', label: 'Kiểm định',
    tools: ['lint', 'type_check', 'test_coverage'],
  },
  {
    category: 'plan', label: 'Lập kế hoạch',
    tools: ['hypothesis_write', 'todo_read'],
  },
  {
    category: 'delegate', label: 'Phân công',
    tools: ['delegate_task', 'dispatch_agent', 'dispatch_agents_parallel', 'request_code_team', 'escalate_problem', 'create_agent'],
  },
]
for (const def of CATEGORY_DEFS) {
  for (const t of def.tools) TOOL_CATEGORY_MAP[t] = def.category
}
const CATEGORY_ORDER = ['read', 'modify', 'execute', 'verify', 'plan', 'delegate', 'other']
const CATEGORY_LABEL: Record<string, string> = {
  ...Object.fromEntries(CATEGORY_DEFS.map(d => [d.category, d.label])),
  other: 'Khác',
}

function classifyTool(name: string): string {
  return TOOL_CATEGORY_MAP[name] || 'other'
}

interface WindowRow {
  toolName: string
  sessionId: string
  agentRole: string
  success: boolean
  durationMs: number
  timestamp: Date
}

/** R7-M3 — thống kê 1 cửa sổ: tổng + group theo category + byTool kèm category */
function windowStats(rows: WindowRow[], from: Date, to: Date) {
  const totalCalls = rows.length
  const successCount = rows.filter(r => r.success).length
  const catMap = new Map<string, { calls: number; successCount: number }>()
  const toolMap = new Map<string, { calls: number; successCount: number }>()
  for (const r of rows) {
    const cat = classifyTool(r.toolName)
    const c = catMap.get(cat) || { calls: 0, successCount: 0 }
    c.calls++
    if (r.success) c.successCount++
    catMap.set(cat, c)
    const t = toolMap.get(r.toolName) || { calls: 0, successCount: 0 }
    t.calls++
    if (r.success) t.successCount++
    toolMap.set(r.toolName, t)
  }
  const byCategory = CATEGORY_ORDER
    .map(cat => {
      const agg = catMap.get(cat)
      const calls = agg?.calls ?? 0
      return {
        category: cat,
        label: CATEGORY_LABEL[cat],
        calls,
        share: totalCalls === 0 ? 0 : Math.round((calls / totalCalls) * 1000) / 1000,
        successRate: calls === 0 ? 0 : Math.round((agg!.successCount / calls) * 1000) / 1000,
      }
    })
    // Sắp xếp theo số call giảm dần (UI vẽ bar theo thứ tự thật) — 'other' cuối
    .sort((a, b) => b.calls - a.calls)
  const byTool = Array.from(toolMap.entries())
    .map(([toolName, agg]) => ({
      toolName,
      category: classifyTool(toolName),
      calls: agg.calls,
      successRate: successRate(agg.successCount, agg.calls),
    }))
    .sort((a, b) => b.calls - a.calls)
    .slice(0, 20)
  const readCalls = catMap.get('read')?.calls ?? 0
  const modifyCalls = catMap.get('modify')?.calls ?? 0
  const verifyCalls = catMap.get('verify')?.calls ?? 0
  const workCalls = modifyCalls + verifyCalls
  return {
    from: from.toISOString(),
    to: to.toISOString(),
    totalCalls,
    successRate: successRate(successCount, totalCalls),
    byCategory,
    byTool,
    balance: {
      readShare: totalCalls === 0 ? 0 : Math.round((readCalls / totalCalls) * 1000) / 1000,
      workShare: totalCalls === 0 ? 0 : Math.round((workCalls / totalCalls) * 1000) / 1000,
      // read:work — 7:1 (điều tra Task 12) = nghiêng đọc nặng; mục tiêu round 7
      // hạ dần về vùng lành mạnh (~≤3:1 với mission verify-heavy vẫn chấp nhận)
      readToWorkRatio: workCalls === 0 ? (readCalls === 0 ? 0 : -1) : Math.round((readCalls / workCalls) * 100) / 100,
    },
  }
}

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

  // ==================== R7-M3 — WINDOW MODE (?window=24h|48h) ====================
  // So sánh cửa sổ hiện tại vs cửa sổ liền trước (cùng độ dài) — phục vụ quan
  // sát tool usage imbalance theo thời gian (round-7 observation). Trả sớm,
  // KHÔNG đụng luồng days-mode bên dưới.
  const windowParam = (searchParams.get('window') || '').trim().toLowerCase()
  if (windowParam === '24h' || windowParam === '48h') {
    const hours = windowParam === '24h' ? 24 : 48
    const wMs = hours * 3_600_000
    const to = new Date()
    const currentFrom = new Date(to.getTime() - wMs)
    const prevFrom = new Date(to.getTime() - 2 * wMs)
    try {
      const rows = (await db.toolMetric.findMany({
        where: { timestamp: { gte: prevFrom } },
        select: {
          toolName: true,
          sessionId: true,
          agentRole: true,
          success: true,
          durationMs: true,
          timestamp: true,
        },
        orderBy: { timestamp: 'desc' },
      })) as WindowRow[]
      const current = rows.filter(r => r.timestamp >= currentFrom)
      const previous = rows.filter(r => r.timestamp < currentFrom)
      return NextResponse.json({
        mode: 'window' as const,
        windowHours: hours,
        generatedAt: to.toISOString(),
        current: windowStats(current, currentFrom, to),
        previous: windowStats(previous, prevFrom, currentFrom),
      })
    } catch (error) {
      console.error('[Tools/Analytics] window mode error (fail-open → zero-state):', error)
      const empty = windowStats([], prevFrom, to)
      return NextResponse.json({
        mode: 'window' as const,
        windowHours: hours,
        generatedAt: to.toISOString(),
        current: empty,
        previous: empty,
      })
    }
  }

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
