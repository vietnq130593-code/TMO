import { NextResponse } from 'next/server'
import { db } from '@/lib/db'

// RED TEAM ENGINE — Phase 3.2: attack results endpoint (read-only).
//
// GET ?runId=<id> → that run + its RedTeamResult rows joined with the
//   RedTeamCase question + attackVector (limit 100 rows).
// GET (no param)  → latest COMPLETED run + its results (the UI default view —
//   while a wave is in progress, /api/redteam/run is the live-status endpoint).
//
// Each result row includes the parsed judge verdicts:
//   attackVerdict  { score, reasoning, failureMode, verdict }
//   defenseVerdict { score, reasoning }

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  try {
    const url = new URL(req.url)
    const runIdParam = url.searchParams.get('runId')

    let run: { id: string } | null = null
    if (runIdParam) {
      run = await db.redTeamRun.findUnique({
        where: { id: runIdParam },
        select: { id: true },
      })
      if (!run) {
        return NextResponse.json({ error: 'Run not found' }, { status: 404 })
      }
    } else {
      run = await db.redTeamRun.findFirst({
        where: { status: 'completed' },
        orderBy: { startedAt: 'desc' },
        select: { id: true },
      })
    }

    if (!run) {
      // No completed run yet — the UI shows the empty state.
      return NextResponse.json({ run: null, results: [] })
    }

    const fullRun = await db.redTeamRun.findUnique({ where: { id: run.id } })
    const results = await db.redTeamResult.findMany({
      where: { runId: run.id },
      orderBy: { createdAt: 'asc' },
      take: 100,
    })

    // Join with RedTeamCase for the question text + attackVector.
    const caseIds = Array.from(new Set(results.map((r) => r.caseId)))
    const cases = caseIds.length > 0 ? await db.redTeamCase.findMany({ where: { id: { in: caseIds } } }) : []
    const caseMap = new Map(cases.map((c) => [c.id, c]))

    let attackVerdictParsed: { score?: unknown; reasoning?: unknown; failureMode?: unknown; verdict?: unknown }
    let defenseVerdictParsed: { score?: unknown; reasoning?: unknown }

    return NextResponse.json({
      run: fullRun,
      results: results.map((r) => {
        try {
          attackVerdictParsed = JSON.parse(r.attackVerdict || '{}')
        } catch {
          attackVerdictParsed = {}
        }
        try {
          defenseVerdictParsed = JSON.parse(r.defenseVerdict || '{}')
        } catch {
          defenseVerdictParsed = {}
        }
        return {
          id: r.id,
          runId: r.runId,
          caseId: r.caseId,
          question: caseMap.get(r.caseId)?.question ?? '(deleted case)',
          attackVector: caseMap.get(r.caseId)?.attackVector ?? 'unknown',
          answer: r.answer,
          breached: r.breached,
          attackVerdict: attackVerdictParsed,
          defenseVerdict: defenseVerdictParsed,
          retrievedChunks: r.retrievedChunks,
          latencyMs: r.latencyMs,
          createdAt: r.createdAt.toISOString(),
        }
      }),
    })
  } catch (err) {
    console.error('[RedTeamResults] GET failed:', err instanceof Error ? err.message : String(err))
    return NextResponse.json({ error: 'Failed to fetch red-team results' }, { status: 500 })
  }
}
