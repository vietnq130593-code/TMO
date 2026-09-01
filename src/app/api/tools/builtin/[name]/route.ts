/**
 * Builtin Tool Detail/Config API — Task 21-c
 *
 * GET /api/tools/builtin/[name] — full def 1 tool builtin (description mặc định,
 *   description override hiện tại, parameters JSON, ma trận agent mặc định + override).
 * PUT /api/tools/builtin/[name] — body { description: string|null } → ToolConfig
 *   upsert. description=null → xóa override (reset về mô tả gốc trong code).
 *   Description override được đưa vào prompt LLM (native FC tool defs) + UI.
 *
 * Lưu ý: KHÔNG sửa được executor code/parameters — chỉ description (per spec 21-c).
 */

import { NextRequest, NextResponse } from 'next/server'
import { getBuiltinToolDefinition, getAllBuiltinToolNames } from '@/lib/code-team/tool-executor'
import { getToolDescriptionOverride, setToolConfig, getAllAssignments } from '@/lib/tool-access'
import { getAgentTools } from '@/lib/code-team/agents'
import { getStandaloneAgentTools } from '@/lib/standalone-agents'
import { DEFAULT_NEW_AGENT_TOOLS } from '@/lib/omega-orchestrator'

export const dynamic = 'force-dynamic'

interface RouteContext {
  params: Promise<{ name: string }>
}

/** Ma trận agent mặc định cho 1 tool — cùng nguồn với registry.
 * FIX 2026-09-01: đủ TOÀN BỘ 8 agent thật (Omega + Opus + ALISTA + 5 Code Team)
 * + NEW_AGENT bucket — khớp AgentProfile đang sống trong DB. */
function buildAgentMatrix(toolName: string): Array<{ agentKey: string; label: string; defaultHas: boolean }> {
  const matrix: Array<{ agentKey: string; label: string; defaultHas: boolean }> = []
  // Standalone agents (theo STANDALONE_AGENTS: Omega + ALISTA)
  for (const name of ['Omega', 'ALISTA'] as const) {
    try {
      matrix.push({ agentKey: name === 'Omega' ? 'OMEGA' : 'ALISTA', label: name, defaultHas: getStandaloneAgentTools(name).includes(toolName) })
    } catch { /* fail-open */ }
  }
  // Opus — meta-agent CTO: full builtin list (đồng bộ ensureOpusAgent)
  try {
    matrix.push({ agentKey: 'OPUS', label: 'Opus', defaultHas: getAllBuiltinToolNames().includes(toolName) })
  } catch { /* fail-open */ }
  const positions: Array<[string, string, string]> = [
    ['TL', 'APEX', 'TL'],
    ['G1', 'CORTEX', 'G1'],
    ['G2-A', 'BOLT', 'G2-A'],
    ['G2-B', 'SENTINEL', 'G2-B'],
    ['G3', 'CATALYST', 'G3'],
  ]
  for (const [pos, key, label] of positions) {
    try {
      matrix.push({ agentKey: key, label, defaultHas: getAgentTools(pos).includes(toolName) })
    } catch { /* fail-open */ }
  }
  matrix.push({ agentKey: 'NEW_AGENT', label: 'Agent động', defaultHas: DEFAULT_NEW_AGENT_TOOLS.includes(toolName) })
  return matrix
}

export async function GET(_request: NextRequest, context: RouteContext) {
  try {
    const { name } = await context.params
    const def = getBuiltinToolDefinition(name)
    if (!def) {
      return NextResponse.json({ ok: false, error: `Tool builtin "${name}" không tồn tại` }, { status: 404 })
    }

    const [override, assignments] = await Promise.all([
      getToolDescriptionOverride(name),
      getAllAssignments(),
    ])
    const matrix = buildAgentMatrix(name).map(m => ({
      ...m,
      override: assignments.find(a => a.agentKey === m.agentKey && a.toolName === name)?.enabled ?? null,
    }))

    return NextResponse.json({
      ok: true,
      name,
      defaultDescription: def.function.description,
      description: override ?? def.function.description,
      hasOverride: override !== null,
      parameters: def.function.parameters,
      agents: matrix,
    })
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    )
  }
}

export async function PUT(request: NextRequest, context: RouteContext) {
  try {
    const { name } = await context.params
    const def = getBuiltinToolDefinition(name)
    if (!def) {
      return NextResponse.json({ ok: false, error: `Tool builtin "${name}" không tồn tại` }, { status: 404 })
    }

    const body = await request.json()
    const { description, updatedBy } = body ?? {}
    if (description !== null && description !== undefined && typeof description !== 'string') {
      return NextResponse.json({ ok: false, error: 'description phải là string hoặc null (reset)' }, { status: 400 })
    }
    if (typeof description === 'string' && description.length > 2000) {
      return NextResponse.json({ ok: false, error: `description quá dài (${description.length} > 2000 ký tự)` }, { status: 400 })
    }
    if (typeof description === 'string' && description.trim().length === 0) {
      return NextResponse.json({ ok: false, error: 'description không được rỗng (dùng null để reset)' }, { status: 400 })
    }

    const row = await setToolConfig(name, description ?? null, updatedBy === 'omega' ? 'omega' : 'user')
    return NextResponse.json({
      ok: true,
      name,
      description: description ?? null,
      config: row,
      message: description == null
        ? `Đã reset mô tả tool "${name}" về mặc định`
        : `Đã lưu mô tả mới cho tool "${name}" (áp dụng vào prompt LLM + UI)`,
    })
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    )
  }
}
