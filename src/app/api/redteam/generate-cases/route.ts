import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { generateRedTeamCases, ATTACK_VECTORS } from '@/lib/redteam/generator'

// RED TEAM ENGINE — Phase 3.2: weapon-factory endpoint (blueprint §3.4).
//
// POST { vectors?: string[] } → generate new attack cases via the generator
//   (space-bunny-free per-vector prompts + quality gate — 2026-11-30). Synchronous — one
//   generator LLM call per vector + one gate call per candidate (~10-60s).
//   Returns { inserted, skipped, byVector }.
//
// GET → list ALL cases (active + retired) with breachCount + status summary —
//   the weapon-inventory view for the UI card.

export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as { vectors?: unknown }

    // vectors: optional string array filter — must match known vectors.
    const known = Object.keys(ATTACK_VECTORS)
    const vectors = Array.isArray(body.vectors)
      ? body.vectors.filter(
          (v): v is string => typeof v === 'string' && known.includes(v)
        )
      : undefined

    const result = await generateRedTeamCases(vectors)

    return NextResponse.json({
      inserted: result.inserted,
      skipped: result.skipped,
      byVector: result.byVector,
    })
  } catch (err) {
    console.error('[RedTeamGenerate] POST failed:', err instanceof Error ? err.message : String(err))
    return NextResponse.json({ error: 'Failed to generate red-team cases' }, { status: 500 })
  }
}

export async function GET() {
  try {
    const cases = await db.redTeamCase.findMany({
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
      take: 200,
      select: {
        id: true,
        question: true,
        attackVector: true,
        origin: true,
        generatedBy: true,
        status: true,
        breachCount: true,
        lastBreachAt: true,
        createdAt: true,
      },
    })

    const activeCount = cases.filter((c) => c.status === 'active').length
    const retiredCount = cases.filter((c) => c.status === 'retired').length

    return NextResponse.json({
      cases,
      counts: { total: cases.length, active: activeCount, retired: retiredCount },
      vectors: Object.entries(ATTACK_VECTORS).map(([key, cfg]) => ({
        key,
        label: cfg.label,
        description: cfg.description,
        plannedCount: cfg.count,
      })),
    })
  } catch (err) {
    console.error('[RedTeamGenerate] GET failed:', err instanceof Error ? err.message : String(err))
    return NextResponse.json({ error: 'Failed to list red-team cases' }, { status: 500 })
  }
}
