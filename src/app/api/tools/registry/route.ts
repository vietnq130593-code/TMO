/**
 * Tools Registry API — tổng quan TOÀN BỘ skills/tools của app
 * (user request 2026-08-30: "ô Skill.md guides chưa hiện hết tất cả các
 * skill/tools hiện có của app... không biết agents có sử dụng được tất cả không")
 *
 * GET /api/tools/registry — trả về:
 *   - builtinTools:    mọi tool built-in (tool-executor.ts) + agents nào được dùng
 *   - customTools:     tools do agents/user TỰ VIẾT (CustomTool DB — hot-register)
 *   - filesystemSkills: skills/<slug>/SKILL.md trên đĩa (agents đọc qua read_skill)
 *   - dbSkills:        AgentSkill DB rows (inject system prompt + ô SKILL.md Guides)
 *   - agentMatrix:     agent → số tool có thể dùng
 *
 * Câu trả lời câu hỏi "agents có dùng được TẤT CẢ không" nằm trong agentMatrix +
 * builtinTools[].agents của từng tool.
 */

import { NextResponse } from 'next/server'
import { readdirSync, existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { getAllBuiltinToolSummaries } from '@/lib/code-team/tool-executor'
import { getAgentTools, getAgentName } from '@/lib/code-team/agents'
import { getStandaloneAgentTools, getStandaloneAgentNames } from '@/lib/standalone-agents'
import { db } from '@/lib/db'
import { ensureCustomToolsLoaded, getAllCustomTools } from '@/lib/custom-tool-registry'

export const dynamic = 'force-dynamic'

// Team agents theo position (code-team/agents.ts)
const TEAM_POSITIONS = ['TL', 'G1', 'G2-A', 'G2-B', 'G3']

export async function GET() {
  try {
    // ===== 1. Built-in tools + agent access matrix =====
    const builtinSummaries = getAllBuiltinToolSummaries()

    // Agent tool lists: Omega (standalone) + 5 team agents
    const agentToolLists: Array<{ name: string; short: string; tools: string[] }> = []
    for (const saName of getStandaloneAgentNames()) {
      agentToolLists.push({
        name: saName,
        short: saName.slice(0, 2).toUpperCase(),
        tools: getStandaloneAgentTools(saName),
      })
    }
    for (const pos of TEAM_POSITIONS) {
      const agentName = getAgentName(pos)
      agentToolLists.push({
        name: agentName,
        short: pos,
        tools: getAgentTools(pos),
      })
    }

    // Custom tool names (mọi agents đều dùng được — whitelist exception)
    await ensureCustomToolsLoaded()
    const customToolsLive = getAllCustomTools()
    const customToolNames = new Set(customToolsLive.map(t => t.name))

    // Per-tool: agents nào có quyền (built-in) hoặc "ALL" (custom)
    const builtinTools = builtinSummaries.map(t => {
      const agents = agentToolLists
        .filter(a => a.tools.includes(t.name))
        .map(a => ({ name: a.name, short: a.short }))
      return {
        name: t.name,
        description: t.description,
        category: t.category,
        paramNames: t.paramNames,
        agents,
        agentCount: agents.length,
        totalAgents: agentToolLists.length,
        accessibleByAll: agents.length === agentToolLists.length,
      }
    })

    // ===== 2. Custom tools (DB + registry) =====
    const customTools: Array<{
      name: string
      description: string
      parameters: unknown
      version: string
      source: string
      enabled: boolean
      callCount: number
      skillSlug: string | null
      createdAt: Date
    }> = customToolsLive.map(t => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
      version: t.version,
      source: t.source,
      enabled: t.enabled,
      callCount: t.callCount,
      skillSlug: t.skillSlug,
      createdAt: t.createdAt,
    }))
    try {
      // Đối chiếu DB (registry in-memory có thể thiếu row mới từ process khác)
      const dbRows = await db.customTool.findMany({ orderBy: { createdAt: 'desc' } })
      const known = new Set(customTools.map(t => t.name))
      for (const row of dbRows) {
        if (known.has(row.name)) continue
        let parameters: unknown = {}
        try { parameters = JSON.parse(row.parameters) } catch { /* keep {} */ }
        customTools.push({
          name: row.name,
          description: row.description,
          parameters,
          version: row.version,
          source: row.source,
          enabled: row.enabled,
          callCount: row.callCount,
          skillSlug: row.skillSlug,
          createdAt: row.createdAt,
        })
        customToolNames.add(row.name)
      }
    } catch { /* non-fatal */ }

    // ===== 3. Filesystem skills (skills/<slug>/SKILL.md) =====
    const filesystemSkills: Array<{ slug: string; hasSkillMd: boolean; description: string }> = []
    try {
      const skillsRoot = join(process.cwd(), 'skills')
      if (existsSync(skillsRoot)) {
        for (const slug of readdirSync(skillsRoot, { withFileTypes: true })) {
          if (!slug.isDirectory()) continue
          const skillMdPath = join(skillsRoot, slug.name, 'SKILL.md')
          const hasSkillMd = existsSync(skillMdPath)
          let description = ''
          if (hasSkillMd) {
            try {
              const content = readFileSync(skillMdPath, 'utf-8')
              // Lấy mô tả ngắn: dòng đầu không phải heading
              const line = content.split('\n').find(l => l.trim() && !l.trim().startsWith('#'))
              description = (line || '').trim().slice(0, 150)
            } catch { /* ignore */ }
          }
          filesystemSkills.push({ slug: slug.name, hasSkillMd, description })
        }
      }
    } catch { /* non-fatal */ }

    // ===== 4. DB skills (AgentSkill — ô SKILL.md Guides) =====
    let dbSkills: Array<{ slug: string; name: string; source: string; enabled: boolean; version: string }> = []
    try {
      const rows = await db.agentSkill.findMany({ orderBy: { installedAt: 'desc' } })
      dbSkills = rows.map(r => ({ slug: r.slug, name: r.name, source: r.source, enabled: r.enabled, version: r.version }))
    } catch { /* non-fatal */ }

    // ===== 5. Agent matrix =====
    const agentMatrix = agentToolLists.map(a => {
      const customCount = a.tools.includes('create_custom_tool') ? customToolNames.size : 0
      return {
        name: a.name,
        short: a.short,
        builtinToolCount: a.tools.length,
        canSelfWriteTools: a.tools.includes('create_custom_tool'),
        customToolCount: customCount, // custom tools dùng được (nếu có quyền self-write)
        totalUsable: a.tools.length + customCount,
      }
    })

    return NextResponse.json({
      ok: true,
      summary: {
        builtinToolCount: builtinTools.length,
        customToolCount: customTools.length,
        filesystemSkillCount: filesystemSkills.length,
        dbSkillCount: dbSkills.length,
        agentCount: agentToolLists.length,
        // Tools mà CHƯA agent nào dùng được (định nghĩa nhưng chưa cấp quyền)
        orphanToolCount: builtinTools.filter(t => t.agentCount === 0).length,
      },
      builtinTools,
      customTools,
      filesystemSkills,
      dbSkills,
      agentMatrix,
    })
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    )
  }
}
