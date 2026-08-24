import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { runEval } from '@/lib/eval/runner'

// Phase 4 SMOLAB Proposal 11' — Eval run endpoint.
//
// POST: starts a NEW eval run. Creates the EvalRun row, then fires runEval()
// WITHOUT await (fire-and-forget background — an eval is 1 retrieval + 1
// generation + 3 judge LLM calls per case, ~15-30s per case; running it in the
// HTTP request would timeout). Returns immediately with 202-style semantics.
//
//   Body: { caseLimit?: number (default 10, max 50), categories?: string[] }
//   Returns: { runId, status: 'running', caseCount }
//
// GET ?runId=<id> → single run status + aggregates.
// GET (no param)  → latest 10 runs summary (for the UI "Recent runs" list).

export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as {
      caseLimit?: unknown
      categories?: unknown
    }

    // caseLimit: default 10, clamp to [1, 50].
    const rawLimit = typeof body.caseLimit === 'number' ? body.caseLimit : parseInt(String(body.caseLimit ?? '10'), 10)
    const caseLimit = Math.max(1, Math.min(50, Number.isFinite(rawLimit) ? rawLimit : 10))

    // categories: optional string array filter.
    const categories = Array.isArray(body.categories)
      ? body.categories.filter((c): c is string => typeof c === 'string' && c.length > 0)
      : undefined

    // Select the cases this run will process (same filter/order as runner.ts)
    // so caseCount is accurate before the background work starts.
    const where = {
      active: true,
      ...(categories && categories.length > 0 ? { category: { in: categories } } : {}),
    }
    const selected = await db.evalCase.findMany({
      where,
      orderBy: { createdAt: 'asc' },
      take: caseLimit,
      select: { id: true },
    })

    if (selected.length === 0) {
      return NextResponse.json(
        { error: 'No active eval cases matched — run scripts/seed-eval.ts first or adjust the category filter.' },
        { status: 400 }
      )
    }

    const run = await db.evalRun.create({
      data: { status: 'running', caseCount: selected.length },
    })

    // Fire-and-forget — NEVER await this in the HTTP request.
    runEval({ runId: run.id, caseLimit, categories }).catch((err) => {
      console.error(
        `[EvalRun] Background runEval crashed for run ${run.id}:`,
        err instanceof Error ? err.message : String(err)
      )
    })

    return NextResponse.json({ runId: run.id, status: 'running', caseCount: selected.length })
  } catch (err) {
    console.error('[EvalRun] POST failed:', err instanceof Error ? err.message : String(err))
    return NextResponse.json({ error: 'Failed to start eval run' }, { status: 500 })
  }
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url)
    const runId = url.searchParams.get('runId')

    if (runId) {
      const run = await db.evalRun.findUnique({ where: { id: runId } })
      if (!run) {
        return NextResponse.json({ error: 'Run not found' }, { status: 404 })
      }
      return NextResponse.json({ run })
    }

    // No runId → latest 10 runs summary.
    const runs = await db.evalRun.findMany({
      orderBy: { startedAt: 'desc' },
      take: 10,
    })
    return NextResponse.json({ runs })
  } catch (err) {
    console.error('[EvalRun] GET failed:', err instanceof Error ? err.message : String(err))
    return NextResponse.json({ error: 'Failed to fetch eval runs' }, { status: 500 })
  }
}
