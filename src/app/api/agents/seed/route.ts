/**
 * Agent Seed API — Code Team + Standalone Agents
 *
 * Manages agent seeding (both Code Team and Standalone).
 * GET  /api/agents/seed — Check seed status
 * POST /api/agents/seed — Force re-seed (update prompts/instructions)
 */

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { CODE_TEAM_AGENTS, forceReseedCodeTeam, resetSeedState } from '@/lib/code-team/agents'
import { STANDALONE_AGENTS, forceReseedStandaloneAgents, resetStandaloneSeedState } from '@/lib/standalone-agents'
import {
  RESEARCH_TEAM_AGENTS,
  forceReseedResearchTeam,
  resetResearchTeamSeedState,
} from '@/lib/research-team/agents'

export const dynamic = 'force-dynamic'

// GET — Seed status: check which system agents exist
export async function GET() {
  try {
    const [codeAgents, standaloneAgents, researchAgents] = await Promise.all([
      db.agentProfile.findMany({ where: { team: 'code', isSystem: true } }),
      db.agentProfile.findMany({ where: { team: null, isSystem: true } }),
      db.agentProfile.findMany({ where: { team: 'research', isSystem: true } }),
    ])

    const codeExistingNames = codeAgents.map(a => a.name)
    const codeMissing = CODE_TEAM_AGENTS
      .map(def => def.name)
      .filter(name => !codeExistingNames.includes(name))

    const standaloneExistingNames = standaloneAgents.map(a => a.name)
    const standaloneMissing = STANDALONE_AGENTS
      .map(def => def.name)
      .filter(name => !standaloneExistingNames.includes(name))

    const researchExistingNames = researchAgents.map(a => a.name)
    const researchMissing = RESEARCH_TEAM_AGENTS
      .map(def => def.name)
      .filter(name => !researchExistingNames.includes(name))

    return NextResponse.json({
      codeTeam: {
        message: codeMissing.length === 0
          ? 'Code Team đầy đủ 5 agents'
          : `Thiếu ${codeMissing.length} agents: ${codeMissing.join(', ')}`,
        total: CODE_TEAM_AGENTS.length,
        existing: codeAgents.length,
        missing: codeMissing.length,
        agents: codeAgents.map(a => ({
          name: a.name,
          position: a.position,
          provider: a.provider,
          model: a.model,
          isSystem: a.isSystem,
        })),
      },
      standalone: {
        message: standaloneMissing.length === 0
          ? 'Standalone agents đầy đủ'
          : `Thiếu ${standaloneMissing.length} agents: ${standaloneMissing.join(', ')}`,
        total: STANDALONE_AGENTS.length,
        existing: standaloneAgents.length,
        missing: standaloneMissing.length,
        agents: standaloneAgents.map(a => ({
          name: a.name,
          provider: a.provider,
          model: a.model,
          isSystem: a.isSystem,
        })),
      },
      research: {
        message: researchMissing.length === 0
          ? 'Research Team đầy đủ 5 agents (NEMESIS/SIVIL/BELI/LISMA/HAN)'
          : `Thiếu ${researchMissing.length} agents: ${researchMissing.join(', ')}`,
        total: RESEARCH_TEAM_AGENTS.length,
        existing: researchAgents.length,
        missing: researchMissing.length,
        agents: researchAgents.map(a => ({
          name: a.name,
          position: a.position,
          provider: a.provider,
          model: a.model,
          isSystem: a.isSystem,
        })),
      },
    })
  } catch (err) {
    return NextResponse.json(
      { error: 'Failed to check seed status', details: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    )
  }
}

// POST — Force re-seed all system agents (Code Team + Standalone)
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}))
    const force = body.force === true
    const scope = body.scope || 'all' // 'all' | 'code' | 'standalone' | 'research'

    if (force) {
      const results: Record<string, { updated: number; created: number }> = {}

      if (scope === 'all' || scope === 'code') {
        results.codeTeam = await forceReseedCodeTeam()
        resetSeedState()
      }

      if (scope === 'all' || scope === 'standalone') {
        results.standalone = await forceReseedStandaloneAgents()
        resetStandaloneSeedState()
      }

      if (scope === 'all' || scope === 'research') {
        results.research = await forceReseedResearchTeam()
        resetResearchTeamSeedState()
      }

      return NextResponse.json({
        message: `Re-seeded: ${Object.keys(results).join(', ')}`,
        warning: 'Force re-seed overwrites ALL user customizations (provider, model, temperature, etc.)',
        results,
      })
    }

    // Default: just ensure agents exist (idempotent)
    const { ensureCodeTeamAgents } = await import('@/lib/code-team/agents')
    const { ensureStandaloneAgents } = await import('@/lib/standalone-agents')
    const { ensureOpusAgent } = await import('@/lib/opus/opus-agent')
    const { ensureResearchTeamAgents } = await import('@/lib/research-team/agents')

    if (scope === 'all' || scope === 'code') {
      await ensureCodeTeamAgents()
    }
    if (scope === 'all' || scope === 'standalone') {
      await ensureStandaloneAgents()
    }
    if (scope === 'all' || scope === 'research') {
      await ensureResearchTeamAgents()
    }
    // OPUS CTO meta-agent (user request 2026-09-30) — luôn ensure
    await ensureOpusAgent()

    const [codeAgents, standaloneAgents, researchAgents] = await Promise.all([
      db.agentProfile.findMany({ where: { team: 'code', isSystem: true } }),
      db.agentProfile.findMany({ where: { team: null, isSystem: true } }),
      db.agentProfile.findMany({ where: { team: 'research', isSystem: true } }),
    ])

    return NextResponse.json({
      message: `System agents ensured: Code Team ${codeAgents.length}, Standalone ${standaloneAgents.length}, Research ${researchAgents.length}`,
      codeTeam: codeAgents.length,
      standalone: standaloneAgents.length,
      research: researchAgents.length,
    })
  } catch (err) {
    return NextResponse.json(
      { error: 'Failed to seed', details: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    )
  }
}
