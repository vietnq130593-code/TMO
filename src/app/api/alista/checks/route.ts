/**
 * ALISTA — GET /api/alista/checks?limit=20
 * =====================================================
 * Lịch sử các lần chạy pipeline 'alista-check' từ TaskExecution (mới nhất trước).
 * Trả { rows: [{ id, startedAt, completedAt, status, durationMs, proposalsCreated,
 *   deadlineMet, reason, perCheck[] }] }.
 *
 * Source: SQLite TaskExecution (persistent qua restart) — KHÔNG đọc globalState
 * Map (chỉ sống trong process) để đảm bảo owner thấy lịch sử đầy đủ kể cả khi
 * app restart.
 */

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

interface CheckHistoryRow {
  id: string
  startedAt: string
  completedAt: string | null
  status: string
  durationMs: number | null
  proposalsCreated: number
  deadlineMet: boolean
  reason: string
  perCheck: Array<{
    id: number
    label: string
    status: string
    collectMs?: number
    durationMs?: number
    findingsCount: number
    proposalsCreated: number
    error?: string
    skipReason?: string
  }>
  partialSteps: Array<{ step: number; label: string; reason: string }>
  error: string | null
}

export async function GET(request: NextRequest) {
  const limitParam = request.nextUrl.searchParams.get('limit')
  const limit = Math.min(Math.max(parseInt(limitParam || '20', 10) || 20, 1), 100)

  try {
    const rows = await db.taskExecution.findMany({
      where: { type: 'alista-check' },
      orderBy: { startedAt: 'desc' },
      take: limit,
      select: { id: true, status: true, startedAt: true, completedAt: true, result: true, errorMessage: true },
    })

    const out: CheckHistoryRow[] = []
    for (const r of rows) {
      let parsed: Record<string, unknown> = {}
      try {
        parsed = r.result ? JSON.parse(r.result) as Record<string, unknown> : {}
      } catch { /* ignore parse error */ }

      const perCheck = (Array.isArray(parsed.perCheck) ? parsed.perCheck : []) as CheckHistoryRow['perCheck']
      const partialSteps = (Array.isArray(parsed.partialSteps) ? parsed.partialSteps : []) as CheckHistoryRow['partialSteps']
      const proposalsCreated = Array.isArray(parsed.proposalsCreated) ? parsed.proposalsCreated : []

      out.push({
        id: r.id,
        startedAt: r.startedAt.toISOString(),
        completedAt: r.completedAt?.toISOString() ?? null,
        status: r.status,
        durationMs: typeof parsed.durationMs === 'number' ? parsed.durationMs : null,
        proposalsCreated: proposalsCreated.length,
        deadlineMet: parsed.deadlineMet === true,
        reason: typeof parsed.reason === 'string' ? parsed.reason : (r.status === 'completed' ? 'all_checks_done' : 'unknown'),
        perCheck,
        partialSteps,
        error: r.errorMessage,
      })
    }

    return NextResponse.json({ rows: out, count: out.length })
  } catch (err) {
    console.error('[ALISTA][route:checks] GET fail:', err instanceof Error ? err.message : String(err))
    return NextResponse.json(
      { error: 'Không đọc được lịch sử alista-check', detail: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    )
  }
}
