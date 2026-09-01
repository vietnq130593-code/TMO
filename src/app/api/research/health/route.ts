/**
 * /api/research/health — RESEARCH TEAM HEALTH (TB-13 §2.2)
 * ========================================================
 * Gate P0 (TB-13 §5): trả 200 + các bảng research xuất hiện trong DB
 * + "báo đủ module" (DoD #1) qua module registry (constants.ts).
 *
 * Checks (chạy song song, mỗi check độc lập — 1 check fail KHÔNG làm sập
 * response; vẫn 200 với status từng phần, vì đây là health của scaffold):
 * 1. DB: 9 bảng research tồn tại trong SQLite (sqlite_master)
 * 2. KB: số entry hiện tại (cold-start seed là việc của P4 — 0 là hợp lệ ở P0)
 * 3. NIM pool: provider diagnostics (SSOT: src/lib/llm.ts) + model stack
 * 4. Modules: registry theo phase — BUILT (fs tồn tại) / PLANNED (phase sau)
 */

import { NextResponse } from 'next/server'
import { existsSync } from 'fs'
import { join } from 'path'
import { db } from '@/lib/db'
import {
  AGENT_PRIMARY_MODEL,
  AGENT_FALLBACK_CHAIN,
  getProviderDiagnostics,
  isKimiK3Enforced,
} from '@/lib/llm'
import {
  RESEARCH_MODULE_REGISTRY,
  RESEARCH_ROSTER,
  PROPOSAL_TIMEOUT_HOURS,
  PROPOSAL_REMIND_HOURS,
  SUB_AGENT_LIMITS,
  G2_MAX_FIX_ROUNDS,
} from '@/lib/research-team/constants'
import { getModelStack } from '@/lib/research-team/model-switch'

export const dynamic = 'force-dynamic'

/** 9 bảng research (TB-13 §3) — thứ tự khai báo trong schema */
const RESEARCH_TABLES = [
  'ResearchMission',
  'ResearchTask',
  'ResearchWorklog',
  'ResearchKBEntry',
  'ResearchProposal',
  'ModelSwitchEvent',
  'CouncilTranscript',
  'HypothesisRecord',
  'ExperimentRecord',
] as const

async function checkResearchTables(): Promise<{
  ok: boolean
  expected: number
  found: string[]
  missing: string[]
}> {
  try {
    const rows = (await db.$queryRawUnsafe<Array<{ name: string }>>(
      `SELECT name FROM sqlite_master WHERE type='table' AND name IN (${RESEARCH_TABLES.map(() => '?').join(',')})`,
      ...RESEARCH_TABLES,
    )) as Array<{ name: string }>
    const found = rows.map((r) => r.name).sort()
    const missing = RESEARCH_TABLES.filter((t) => !found.includes(t))
    return { ok: missing.length === 0, expected: RESEARCH_TABLES.length, found, missing }
  } catch (err) {
    console.error('[ResearchHealth] Table check failed:', err instanceof Error ? err.message : String(err))
    return { ok: false, expected: RESEARCH_TABLES.length, found: [], missing: [...RESEARCH_TABLES] }
  }
}

async function checkKb(): Promise<{ ok: boolean; entries: number; note: string }> {
  try {
    const entries = await db.researchKBEntry.count()
    return { ok: true, entries, note: entries === 0 ? 'empty — cold-start seed là việc của P4 (TC-05)' : 'seeded' }
  } catch (err) {
    console.error('[ResearchHealth] KB check failed:', err instanceof Error ? err.message : String(err))
    return { ok: false, entries: -1, note: 'query failed' }
  }
}

function checkNimPool() {
  try {
    const diag = getProviderDiagnostics()
    const nvidia = diag['NVIDIA'] ?? Object.values(diag)[0]
    return {
      ok: !!nvidia && nvidia.availableCount > 0,
      provider: 'NVIDIA (NIM)',
      keys: nvidia
        ? { total: nvidia.keyCount, available: nvidia.availableCount, quotaExhausted: nvidia.dailyQuotaExhaustedCount }
        : null,
      modelStack: getModelStack(),
      primaryModel: AGENT_PRIMARY_MODEL,
      fallbackChain: AGENT_FALLBACK_CHAIN,
      kimiK3Enforced: isKimiK3Enforced(),
    }
  } catch (err) {
    console.error('[ResearchHealth] NIM check failed:', err instanceof Error ? err.message : String(err))
    return { ok: false, provider: 'NVIDIA (NIM)', keys: null, modelStack: getModelStack(), error: 'diagnostics unavailable' }
  }
}

/** BUILT/PLANNED theo filesystem thật — trung thực, không hard-code */
function checkModules(): Array<{ path: string; phase: string; spec: string; status: 'BUILT' | 'PLANNED' }> {
  const root = process.cwd()
  return RESEARCH_MODULE_REGISTRY.map((m) => {
    const abs = join(root, m.path)
    const built = existsSync(abs)
    return { path: m.path, phase: m.phase, spec: m.spec, status: built ? 'BUILT' : 'PLANNED' }
  })
}

export async function GET() {
  const [tables, kb] = await Promise.all([checkResearchTables(), checkKb()])
  const nim = checkNimPool()
  const modules = checkModules()
  const builtCount = modules.filter((m) => m.status === 'BUILT').length

  const body = {
    status: 'ok' as const,
    service: 'research-team',
    phase: 'P0 (Scaffold) — TB-13 §5',
    gate: {
      p0Passed: tables.ok,
      description: 'P0 gate: health 200 + 9 bảng research trong DB',
    },
    db: {
      ok: tables.ok,
      researchTables: tables,
      kb,
    },
    nim,
    roster: RESEARCH_ROSTER.map((a) => ({ id: a.id, position: a.position, jd: a.jd })),
    operationalConstants: {
      proposalTimeoutHours: PROPOSAL_TIMEOUT_HOURS,
      proposalRemindHours: PROPOSAL_REMIND_HOURS,
      subAgentLimits: SUB_AGENT_LIMITS,
      g2MaxFixRounds: G2_MAX_FIX_ROUNDS,
    },
    modules: {
      total: modules.length,
      built: builtCount,
      planned: modules.length - builtCount,
      registry: modules,
    },
    timestamp: new Date().toISOString(),
  }

  return NextResponse.json(body, { status: 200 })
}
