/**
 * Tool Analytics Export API
 *
 * GET /api/tools/analytics/export — Export analytics data as CSV or JSON
 *
 * Same query params as analytics route plus:
 *   format=csv|json  — output format (default: json)
 *   range=24h|7d|30d|all
 *   agentId=...
 *   toolName=...
 *
 * For CSV: returns comma-separated text with headers
 * For JSON: returns same structured data as the analytics route
 */

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'

/** Shape log mong đợi của bảng ToolCallLog — model CHƯA có trong schema.prisma.
 *  Truy vấn qua cast; runtime db.toolCallLog undefined → throw → catch → 500
 *  (giữ nguyên behavior hiện tại, chờ schema thêm model). */
interface ToolCallLogRow {
  id: string
  agentId: string
  agentName: string | null
  toolName: string
  toolSource: string
  success: boolean
  durationMs: number
  errorMessage: string | null
  sessionId: string | null
  iteration: number | null
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

    // Validate format
    if (format !== 'json' && format !== 'csv') {
      return NextResponse.json(
        { error: `Invalid format "${format}". Must be json or csv` },
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

    // Fetch all matching logs for export
    const toolCallLog = (db as unknown as { toolCallLog: ToolCallLogDelegate }).toolCallLog
    const logs = await toolCallLog.findMany({
      where,
      select: {
        id: true,
        agentId: true,
        agentName: true,
        toolName: true,
        toolSource: true,
        success: true,
        durationMs: true,
        errorMessage: true,
        sessionId: true,
        iteration: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 10000, // Safety limit for exports
    })

    if (format === 'csv') {
      // CSV export with all fields
      const headers = [
        'id', 'agentId', 'agentName', 'toolName', 'toolSource',
        'success', 'durationMs', 'errorMessage', 'sessionId',
        'iteration', 'createdAt',
      ]
      const escapeCsv = (val: unknown): string => {
        const str = val === null || val === undefined ? '' : String(val)
        // Escape double quotes and wrap in quotes if contains comma, quote, or newline
        if (str.includes(',') || str.includes('"') || str.includes('\n')) {
          return `"${str.replace(/"/g, '""')}"`
        }
        return str
      }

      const lines: string[] = [headers.join(',')]
      for (const l of logs) {
        const row = [
          escapeCsv(l.id),
          escapeCsv(l.agentId),
          escapeCsv(l.agentName),
          escapeCsv(l.toolName),
          escapeCsv(l.toolSource),
          escapeCsv(l.success),
          escapeCsv(l.durationMs),
          escapeCsv(l.errorMessage),
          escapeCsv(l.sessionId),
          escapeCsv(l.iteration),
          escapeCsv(l.createdAt.toISOString()),
        ]
        lines.push(row.join(','))
      }

      return new NextResponse(lines.join('\n'), {
        headers: {
          'Content-Type': 'text/csv',
          'Content-Disposition': `attachment; filename="tool-analytics-${range}-${Date.now()}.csv"`,
        },
      })
    }

    // JSON export — return raw logs plus computed summary
    const totalCalls = logs.length
    const successCount = logs.filter(l => l.success).length
    const totalDurationMs = logs.reduce((sum, l) => sum + l.durationMs, 0)

    return NextResponse.json({
      exportedAt: new Date().toISOString(),
      range,
      filters: { agentId: agentId || 'all', toolName: toolName || 'all' },
      summary: {
        totalCalls,
        successRate: totalCalls === 0 ? 0 : Math.round((successCount / totalCalls) * 1000) / 1000,
        avgDurationMs: totalCalls === 0 ? 0 : Math.round(totalDurationMs / totalCalls),
      },
      logs,
      total: logs.length,
    })
  } catch (error) {
    console.error('[Tools/Analytics/Export] GET error:', error)
    return NextResponse.json({ error: 'Failed to export analytics' }, { status: 500 })
  }
}
