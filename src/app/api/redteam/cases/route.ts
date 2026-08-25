import { NextResponse } from 'next/server'
import { db } from '@/lib/db'

// RED TEAM ENGINE — Phase 3.2: weapon inventory endpoint (read-only).
//
// GET → all active + retired cases summary: per-case question/attackVector/
//   origin/status/breachCount, plus aggregate counts (active/retired/total)
//   and per-vector breakdown. The UI "ACTIVE WEAPONS / RETIRED" tiles read this.

export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const cases = await db.redTeamCase.findMany({
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
      take: 500,
      select: {
        id: true,
        question: true,
        attackVector: true,
        origin: true,
        status: true,
        breachCount: true,
        lastBreachAt: true,
        createdAt: true,
      },
    })

    const activeCount = cases.filter((c) => c.status === 'active').length
    const retiredCount = cases.filter((c) => c.status === 'retired').length

    const byVector: Record<string, { total: number; breaches: number }> = {}
    for (const c of cases) {
      const entry = byVector[c.attackVector] ?? { total: 0, breaches: 0 }
      entry.total++
      entry.breaches += c.breachCount
      byVector[c.attackVector] = entry
    }

    return NextResponse.json({
      cases,
      counts: { total: cases.length, active: activeCount, retired: retiredCount },
      byVector,
    })
  } catch (err) {
    console.error('[RedTeamCases] GET failed:', err instanceof Error ? err.message : String(err))
    return NextResponse.json({ error: 'Failed to fetch red-team cases' }, { status: 500 })
  }
}
