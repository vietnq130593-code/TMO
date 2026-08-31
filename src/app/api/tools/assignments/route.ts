/**
 * Tools Assignments API — Task 21-c
 *
 * GET  /api/tools/assignments — toàn bộ ToolAssignment overrides + whitelist
 *        MẶC ĐỊNH theo agent key (cùng nguồn với Tools Registry) + ToolConfig
 *        description overrides. Cho UI Tools Manager.
 *
 * POST /api/tools/assignments — body { agentKey, toolName, enabled: boolean|null, updatedBy? }
 *        enabled=false → vô hiệu hóa tool cho agent (enforce prompt + executor)
 *        enabled=true  → bật thêm tool ngoài whitelist mặc định
 *        enabled=null  → XÓA override (reset về mặc định hardcoded)
 *
 * Validate: agentKey ∈ APEX|CORTEX|BOLT|SENTINEL|CATALYST|OMEGA|NEW_AGENT
 *           toolName ∈ builtin (ALL_TOOL_DEFINITIONS) ∪ custom tools registry
 */

import { NextRequest, NextResponse } from 'next/server'
import { getAllAssignments, getAllToolConfigs, setAssignment, normalizeAgentKeyStrict, AGENT_KEYS } from '@/lib/tool-access'
import { getAgentTools } from '@/lib/code-team/agents'
import { getStandaloneAgentTools } from '@/lib/standalone-agents'
import { DEFAULT_NEW_AGENT_TOOLS } from '@/lib/omega-orchestrator'
import { isBuiltinTool, getAllBuiltinToolNames } from '@/lib/code-team/tool-executor'

export const dynamic = 'force-dynamic'

/** Whitelist mặc định theo agent key — cùng nguồn với Tools Registry agentMatrix */
function buildDefaults(): Record<string, string[]> {
  const defaults: Record<string, string[]> = {}
  try {
    defaults.OMEGA = getStandaloneAgentTools('Omega')
  } catch {
    defaults.OMEGA = []
  }
  // TASK 22: Opus = full builtin list (đồng bộ ensureOpusAgent — mọi tool)
  defaults.OPUS = getBuiltinToolNamesSafe()
  const positions: Array<[string, string]> = [
    ['TL', 'APEX'],
    ['G1', 'CORTEX'],
    ['G2-A', 'BOLT'],
    ['G2-B', 'SENTINEL'],
    ['G3', 'CATALYST'],
  ]
  for (const [pos, key] of positions) {
    try {
      defaults[key] = getAgentTools(pos)
    } catch {
      defaults[key] = []
    }
  }
  defaults.NEW_AGENT = [...DEFAULT_NEW_AGENT_TOOLS]
  return defaults
}

/** TASK 22 — full builtin tool names (fail-open []) — dùng cho default OPUS */
function getBuiltinToolNamesSafe(): string[] {
  try {
    return getAllBuiltinToolNames()
  } catch {
    return []
  }
}

export async function GET() {
  try {
    const [assignments, configs, defaults] = await Promise.all([
      getAllAssignments(),
      getAllToolConfigs(),
      Promise.resolve(buildDefaults()),
    ])
    return NextResponse.json({
      ok: true,
      agentKeys: AGENT_KEYS,
      assignments,
      configs,
      defaults,
    })
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    )
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { agentKey, toolName, enabled, updatedBy } = body ?? {}

    if (typeof agentKey !== 'string' || typeof toolName !== 'string') {
      return NextResponse.json(
        { ok: false, error: 'Thiếu agentKey hoặc toolName' },
        { status: 400 },
      )
    }
    if (enabled !== null && enabled !== undefined && typeof enabled !== 'boolean') {
      return NextResponse.json(
        { ok: false, error: 'enabled phải là boolean hoặc null (reset)' },
        { status: 400 },
      )
    }
    const key = normalizeAgentKeyStrict(agentKey)
    if (!key) {
      return NextResponse.json(
        { ok: false, error: `agentKey không hợp lệ: "${agentKey}" — hợp lệ: ${AGENT_KEYS.join('|')}` },
        { status: 400 },
      )
    }
    if (!isBuiltinTool(toolName)) {
      // Custom tool? (agent TỰ VIẾT qua create_custom_tool — cũng cho phép gán)
      let isCustom = false
      try {
        const { ensureCustomToolsLoaded, isCustomToolRegistered } = await import('@/lib/custom-tool-registry')
        await ensureCustomToolsLoaded()
        isCustom = isCustomToolRegistered(toolName)
      } catch { /* fail-open */ }
      if (!isCustom) {
        return NextResponse.json(
          { ok: false, error: `Tool "${toolName}" không tồn tại (builtin hoặc custom)` },
          { status: 404 },
        )
      }
    }

    const row = await setAssignment(key, toolName, enabled ?? null, updatedBy === 'omega' ? 'omega' : 'user')
    return NextResponse.json({
      ok: true,
      agentKey: key,
      toolName,
      enabled: enabled ?? null,
      assignment: row,
      message: enabled == null
        ? `Đã reset tool "${toolName}" về mặc định cho ${key}`
        : enabled
          ? `Đã BẬT tool "${toolName}" cho ${key}`
          : `Đã VÔ HIỆU HÓA tool "${toolName}" cho ${key} (chặn cả prompt lẫn executor)`,
    })
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    )
  }
}
