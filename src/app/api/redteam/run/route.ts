import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { runRedTeam } from '@/lib/redteam/runner'

// RED TEAM ENGINE — Phase 3.2: attack-run endpoint (blueprint §3.4).
//
// POST: starts a NEW red-team attack wave. Creates the RedTeamRun row, then
// fires runRedTeam() WITHOUT await (fire-and-forget background — each case is
// 1 retrieval + 1 answer + 2 judge LLM calls, ~60-90s per case; running it in
// the HTTP request would timeout). Mirrors /api/eval/run.
//
//   Body: { caseLimit?: number (default 15, max 30), vectors?: string[] }
//   Returns: { runId, status: 'running', caseCount }
//
// GET ?runId=<id> → single run status + aggregates.
// GET (no param)  → latest 10 runs summary (for the UI status badge).

export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as {
      caseLimit?: unknown
      vectors?: unknown
    }

    // caseLimit: default 15, clamp to [1, 30] (blueprint budget cap ~15).
    const rawLimit = typeof body.caseLimit === 'number' ? body.caseLimit : parseInt(String(body.caseLimit ?? '15'), 10)
    const caseLimit = Math.max(1, Math.min(30, Number.isFinite(rawLimit) ? rawLimit : 15))

    // vectors: optional string array filter.
    const vectors = Array.isArray(body.vectors)
      ? body.vectors.filter((v): v is string => typeof v === 'string' && v.length > 0)
      : undefined

    // Select the cases this run will process (same filter + round-robin shape
    // as runner.ts) so caseCount is accurate before the background work starts.
    const where = {
      status: 'active',
      ...(vectors && vectors.length > 0 ? { attackVector: { in: vectors } } : {}),
    }
    const selected = await db.redTeamCase.findMany({
      where,
      orderBy: { createdAt: 'asc' },
      take: caseLimit,
      select: { id: true },
    })

    if (selected.length === 0) {
      return NextResponse.json(
        { error: 'No active red-team cases matched — run scripts/seed-redteam-cases.ts first or POST /api/redteam/generate-cases.' },
        { status: 400 }
      )
    }

    const run = await db.redTeamRun.create({
      data: { status: 'running', caseCount: selected.length },
    })

    // Fire-and-forget — NEVER await this in the HTTP request.
    runRedTeam({ runId: run.id, caseLimit, vectors }).catch((err) => {
      console.error(
        `[RedTeamRun] Background runRedTeam crashed for run ${run.id}:`,
        err instanceof Error ? err.message : String(err)
      )
    })

    return NextResponse.json({ runId: run.id, status: 'running', caseCount: selected.length })
  } catch (err) {
    console.error('[RedTeamRun] POST failed:', err instanceof Error ? err.message : String(err))
    return NextResponse.json({ error: 'Failed to start red-team run' }, { status: 500 })
  }
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url)
    const runId = url.searchParams.get('runId')

    if (runId) {
      const run = await db.redTeamRun.findUnique({ where: { id: runId } })
      if (!run) {
        return NextResponse.json({ error: 'Run not found' }, { status: 404 })
      }
      return NextResponse.json({ run })
    }

    // No runId → latest 10 runs summary.
    const runs = await db.redTeamRun.findMany({
      orderBy: { startedAt: 'desc' },
      take: 10,
    })
    return NextResponse.json({ runs })
  } catch (err) {
    console.error('[RedTeamRun] GET failed:', err instanceof Error ? err.message : String(err))
    return NextResponse.json({ error: 'Failed to fetch red-team runs' }, { status: 500 })
  }
}
