import { NextResponse } from 'next/server'
import { db } from '@/lib/db'

// Phase 4 SMOLAB Proposal 11' — Eval results endpoint (read-only).
//
// GET ?runId=<id> → that run + its EvalResult rows joined with the EvalCase
//   question/category (limit 100 rows).
// GET (no param)  → latest COMPLETED run + its results (the UI default view —
//   while a run is in progress, /api/eval/run is the live-status endpoint).
//
// Each result row includes faithfulnessScores (JSON array of the 3 judge
// scores — -1 = that judge failed and was excluded from the median).

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  try {
    const url = new URL(req.url)
    const runIdParam = url.searchParams.get('runId')

    let run: { id: string } | null = null
    if (runIdParam) {
      run = await db.evalRun.findUnique({
        where: { id: runIdParam },
        select: { id: true },
      })
      if (!run) {
        return NextResponse.json({ error: 'Run not found' }, { status: 404 })
      }
    } else {
      run = await db.evalRun.findFirst({
        where: { status: 'completed' },
        orderBy: { startedAt: 'desc' },
        select: { id: true },
      })
    }

    if (!run) {
      // No completed run yet — the UI shows the empty state.
      return NextResponse.json({ run: null, results: [] })
    }

    const fullRun = await db.evalRun.findUnique({ where: { id: run.id } })
    const results = await db.evalResult.findMany({
      where: { runId: run.id },
      orderBy: { createdAt: 'asc' },
      take: 100,
    })

    // Join with EvalCase for the question text + category.
    const caseIds = Array.from(new Set(results.map((r) => r.caseId)))
    const cases = caseIds.length > 0 ? await db.evalCase.findMany({ where: { id: { in: caseIds } } }) : []
    const caseMap = new Map(cases.map((c) => [c.id, c]))

    return NextResponse.json({
      run: fullRun,
      results: results.map((r) => ({
        id: r.id,
        runId: r.runId,
        caseId: r.caseId,
        question: caseMap.get(r.caseId)?.question ?? '(deleted case)',
        category: caseMap.get(r.caseId)?.category ?? 'unknown',
        answer: r.answer,
        retrievedChunks: r.retrievedChunks,
        expectedEntitiesInAnswer: r.expectedEntitiesInAnswer,
        expectedEntitiesRetrieved: r.expectedEntitiesRetrieved,
        recallAt5: r.recallAt5,
        faithfulnessMedian: r.faithfulnessMedian,
        faithfulnessScores: JSON.parse(r.faithfulnessScores || '[]') as number[],
        extractionF1: r.extractionF1,
        hallucinationDetected: r.hallucinationDetected,
        rawConfidence: r.rawConfidence,
        latencyMs: r.latencyMs,
        createdAt: r.createdAt.toISOString(),
      })),
    })
  } catch (err) {
    console.error('[EvalResults] GET failed:', err instanceof Error ? err.message : String(err))
    return NextResponse.json({ error: 'Failed to fetch eval results' }, { status: 500 })
  }
}
