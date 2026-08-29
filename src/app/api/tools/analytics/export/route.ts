/**
 * Tool Analytics Export API — Task 20-b rewrite
 *
 * GET /api/tools/analytics/export?days=7&format=csv|json
 *
 * Trước đây route này cast `db.toolCallLog` — model KHÔNG tồn tại trong schema →
 * runtime luôn 500. Từ 20-b export đọc từ bảng ToolMetric THẬT (được ghi bởi
 * recordToolMetric choke-point). KHÔNG có UI consumer (verify bằng grep — chỉ 2
 * route tools/analytics tự tham chiếu nhau) nên interface được chuẩn hóa theo
 * param `days` của route chính.
 *
 * Query params:
 *   days=7       — số ngày nhìn lại (default 7, max 90)
 *   format=json  — csv | json (default json)
 *
 * Fail-open: lỗi DB → CSV trả header-only 200, JSON trả zero-state 200.
 */

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

const DEFAULT_DAYS = 7
const MAX_DAYS = 90
const EXPORT_ROW_LIMIT = 10000 // Safety limit cho export

function parseDays(raw: string | null): number {
  const parsed = parseInt(raw || '', 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_DAYS
  return Math.min(parsed, MAX_DAYS)
}

function escapeCsv(val: unknown): string {
  const str = val === null || val === undefined ? '' : String(val)
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`
  }
  return str
}

const CSV_HEADERS = [
  'id',
  'toolName',
  'sessionId',
  'agentRole',
  'success',
  'exitCode',
  'durationMs',
  'errorTag',
  'timestamp',
]

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const days = parseDays(searchParams.get('days'))
  const format = searchParams.get('format') || 'json'
  const to = new Date()
  const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000)

  if (format !== 'json' && format !== 'csv') {
    return NextResponse.json(
      { error: `Invalid format "${format}". Must be json or csv` },
      { status: 400 },
    )
  }

  let logs: Array<{
    id: string
    toolName: string
    sessionId: string
    agentRole: string
    success: boolean
    exitCode: number | null
    durationMs: number
    errorTag: string | null
    timestamp: Date
  }> = []

  try {
    logs = await db.toolMetric.findMany({
      where: { timestamp: { gte: from } },
      select: {
        id: true,
        toolName: true,
        sessionId: true,
        agentRole: true,
        success: true,
        exitCode: true,
        durationMs: true,
        errorTag: true,
        timestamp: true,
      },
      orderBy: { timestamp: 'desc' },
      take: EXPORT_ROW_LIMIT,
    })
  } catch (error) {
    // Fail-open — export dữ liệu rỗng thay vì 500
    console.error('[Tools/Analytics/Export] GET error (fail-open → empty):', error)
    logs = []
  }

  if (format === 'csv') {
    const lines: string[] = [CSV_HEADERS.join(',')]
    for (const l of logs) {
      lines.push(
        [
          escapeCsv(l.id),
          escapeCsv(l.toolName),
          escapeCsv(l.sessionId),
          escapeCsv(l.agentRole),
          escapeCsv(l.success),
          escapeCsv(l.exitCode),
          escapeCsv(l.durationMs),
          escapeCsv(l.errorTag),
          escapeCsv(l.timestamp.toISOString()),
        ].join(','),
      )
    }
    return new NextResponse(lines.join('\n'), {
      headers: {
        'Content-Type': 'text/csv',
        'Content-Disposition': `attachment; filename="tool-analytics-${days}d-${Date.now()}.csv"`,
      },
    })
  }

  // JSON export — raw logs + summary
  const totalCalls = logs.length
  const successCount = logs.filter(l => l.success).length
  const totalDurationMs = logs.reduce((sum, l) => sum + l.durationMs, 0)

  return NextResponse.json({
    exportedAt: new Date().toISOString(),
    period: { days, from: from.toISOString(), to: to.toISOString() },
    summary: {
      totalCalls,
      successRate:
        totalCalls === 0
          ? 0
          : Math.round((successCount / totalCalls) * 1000) / 1000,
      avgDurationMs: avgDurationSafe(totalDurationMs, totalCalls),
    },
    logs,
    total: logs.length,
  })
}

function avgDurationSafe(totalDurationMs: number, count: number): number {
  return count === 0 ? 0 : Math.round(totalDurationMs / count)
}
