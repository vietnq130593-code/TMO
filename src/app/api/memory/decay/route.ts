/**
 * Phase 4 SMOLAB Proposal 3.10 — Memory Decay API.
 *
 * POST /api/memory/decay — run memory decay NOW.
 *   Body: { agentId?: string }
 *     - agentId omitted or 'all' → decay ALL agents (sequential: one
 *       decayMemories() call per agentId found in AgentMemory).
 *     - agentId provided → decay that single agent.
 *   Returns: { ok, agentsProcessed, totals: { decayed, deactivated }, perAgent }
 *
 * GET /api/memory/decay — decay status PREVIEW (never mutates anything).
 *   Cheap aggregate queries per agent: active memory count, average importance,
 *   oldest lastAccessedAt. Use this to eyebrow whether a POST is warranted.
 *
 * The decay math lives in decayMemories() (src/lib/agent-memory.ts):
 * exponential decay `importance * (1 - rate * daysSinceLastAccess)` with
 * domain-aware multipliers (user 0.5x / work 1.0x / meta 0x) + deactivation
 * below the threshold. This endpoint is pure orchestration — no decay logic
 * is duplicated here.
 *
 * No auth, consistent with the other storage endpoints (/api/memory, /api/storage/*).
 */

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { decayMemories } from '@/lib/agent-memory'

export const dynamic = 'force-dynamic'

// ==================== POST — RUN DECAY NOW ====================

export async function POST(request: NextRequest) {
  try {
    let body: { agentId?: string } = {}
    try {
      body = await request.json()
    } catch {
      // No body / invalid JSON → decay all agents
    }

    const { agentId } = body
    if (agentId !== undefined && (typeof agentId !== 'string' || agentId.trim().length === 0)) {
      return NextResponse.json({ error: 'agentId must be a non-empty string' }, { status: 400 })
    }

    // Resolve the agent list: single agent OR every agentId present in AgentMemory.
    const targetAgentId = typeof agentId === 'string' ? agentId.trim() : undefined
    const decayAll = !targetAgentId || targetAgentId.toLowerCase() === 'all'
    const agentIds: string[] = decayAll
      ? (await db.agentMemory.groupBy({ by: ['agentId'] })).map(g => g.agentId)
      : targetAgentId
        ? [targetAgentId]
        : []

    // Sequential decay (per-agent writes — avoid hammering SQLite with
    // concurrent write transactions across agents).
    const totals = { decayed: 0, deactivated: 0 }
    const perAgent: Array<{ agentId: string; decayed: number; deactivated: number }> = []
    for (const id of agentIds) {
      const result = await decayMemories(id)
      totals.decayed += result.decayed
      totals.deactivated += result.deactivated
      perAgent.push({ agentId: id, decayed: result.decayed, deactivated: result.deactivated })
    }

    console.log(
      `[MemoryDecayAPI] POST: agentsProcessed=${agentIds.length}, decayed=${totals.decayed}, deactivated=${totals.deactivated}`
    )

    return NextResponse.json({
      ok: true,
      agentsProcessed: agentIds.length,
      totals,
      perAgent,
    })
  } catch (err) {
    console.error('[MemoryDecayAPI] POST error:', err instanceof Error ? err.message : String(err))
    return NextResponse.json(
      { error: 'Failed to decay memories', details: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    )
  }
}

// ==================== GET — DECAY STATUS PREVIEW ====================

export async function GET() {
  try {
    // Aggregates over ACTIVE memories only — decay only ever touches those.
    // Prisma primitives (groupBy + _count/_avg/_min), no raw queries, no lists.
    const grouped = await db.agentMemory.groupBy({
      by: ['agentId'],
      where: { isActive: true },
      _count: { _all: true },
      _avg: { importance: true },
      _min: { lastAccessedAt: true },
    })

    const agents = grouped
      .map(g => ({
        agentId: g.agentId,
        activeMemories: g._count._all,
        avgImportance: g._avg.importance !== null ? Number(g._avg.importance.toFixed(4)) : null,
        // null when no active memory for this agent was ever accessed
        // (lastAccessedAt is nullable — falls back to createdAt inside decayMemories).
        oldestLastAccessedAt: g._min.lastAccessedAt ?? null,
      }))
      .sort((a, b) => b.activeMemories - a.activeMemories)

    const totalActive = agents.reduce((sum, a) => sum + a.activeMemories, 0)
    const globalAvgImportance =
      totalActive > 0
        ? Number((agents.reduce((sum, a) => sum + (a.avgImportance ?? 0) * a.activeMemories, 0) / totalActive).toFixed(4))
        : null

    return NextResponse.json({
      ok: true,
      agentsWithActiveMemories: agents.length,
      totalActiveMemories: totalActive,
      avgImportance: globalAvgImportance,
      agents,
    })
  } catch (err) {
    console.error('[MemoryDecayAPI] GET error:', err instanceof Error ? err.message : String(err))
    return NextResponse.json(
      { error: 'Failed to preview decay status', details: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    )
  }
}
