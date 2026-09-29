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
 *
 * TASK 22 (user directive 2026-09-30 #4): "phần Agents - tools khả dụng khi có
 * thêm agent hoặc agents được setup thêm tools, skills thì phần này có cập
 * real time luôn không" → NÂNG CẤP:
 *   - TRƯỚC: agentMatrix chỉ liệt kê 1 standalone (Omega) + 5 team positions
 *     hardcode — agents do Omega create_agent + Opus KHÔNG BAO GIỜ hiển thị.
 *   - GIỜ: liệt kê TOÀN BỘ AgentProfile trong DB (Opus, agents động, agents
 *     user tự tạo...) + effective tools TÍNH TẠI THỜI ĐIỂM MỖI REQUEST:
 *     profile.tools (JSON) → standalone/team default → ToolAssignment override
 *     (Tools Manager) — mọi thay đổi (agent mới / gán tool mới / tắt tool)
 *     hiện đúng NGAY ở request kế tiếp (route force-dynamic, không cache).
 *   - Agents "open-access" (whelist rỗng = MỌI tool đều được phép) hiển thị
 *     full bộ builtin qua cờ openAccess + toolCount = toàn bộ.
 */

import { NextResponse } from 'next/server'
import { readdirSync, existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { getAllBuiltinToolSummaries, getAllBuiltinToolNames } from '@/lib/code-team/tool-executor'
import { getAgentTools, getAgentName } from '@/lib/code-team/agents'
import { getStandaloneAgentTools, getStandaloneAgentNames } from '@/lib/standalone-agents'
import { getEffectiveToolNames, getAllAssignments, resolveAgentKey } from '@/lib/tool-access'
import { db } from '@/lib/db'
import { ensureCustomToolsLoaded, getAllCustomTools } from '@/lib/custom-tool-registry'

export const dynamic = 'force-dynamic'

// FIX (review R2-c #6, 2026-08-31): cache 60s cho filesystem skills — trước đây
// readdirSync + readFileSync ~68 SKILL.md SYNC trên event loop MỌI request (UI
// poll 30s → 2 lần/phút). Skill files hiếm khi đổi giữa 2 poll → cache 60s đủ
// real-time, hết block event loop.
let fsSkillsCache: { at: number; data: Array<{ slug: string; hasSkillMd: boolean; description: string }> } | null = null
const FS_SKILLS_CACHE_MS = 60_000

// Team agents theo position (code-team/agents.ts)
const TEAM_POSITIONS = ['TL', 'G1', 'G2-A', 'G2-B', 'G3']

interface AgentRow {
  name: string
  short: string
  avatar: string | null
  isSystem: boolean
  team: string | null
  position: string | null
  /** effective tools TẠI THỜI ĐIỂM request (default + ToolAssignment override) */
  tools: string[]
  /** whitelist rỗng = open-access (MỌI tool builtin đều được phép — goal-loop) */
  openAccess: boolean
  source: 'standalone' | 'opus' | 'team' | 'db' | 'db-open'
}

/** Whitelist mặc định theo DB row (TASK 22 — DB-first như chat route) */
function resolveDefaultTools(profile: { name: string; tools: string | null; position: string | null }): string[] {
  // 1. AgentProfile.tools (JSON) — agent do Omega create_agent / Opus (full list)
  if (profile.tools) {
    try {
      const parsed = JSON.parse(profile.tools)
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed.map(t => String(t))
      }
      // [] rõ ràng → open-access (chat route: length===0 → không filter)
      if (Array.isArray(parsed)) return []
    } catch { /* fallthrough */ }
  }
  // 2. Standalone definition (Omega hardcoded whitelist)
  const standalone = getStandaloneAgentTools(profile.name)
  if (standalone.length > 0) return standalone
  // 3. Team definition (theo position)
  if (profile.position && TEAM_POSITIONS.includes(profile.position)) {
    return getAgentTools(profile.position)
  }
  // 4. Open-access — agent custom không khai báo tools → MỌI tool đều được phép
  return []
}

export async function GET() {
  try {
    const builtinNames = getAllBuiltinToolNames()

    // ===== 1. Built-in tools + agent access matrix =====
    const builtinSummaries = getAllBuiltinToolSummaries()

    // 21-c: ToolConfig description override THẮNG mô tả mặc định (quản trị viên
    // chỉnh trong Tools Manager) — hiển thị đúng cái agent sẽ thấy trong prompt.
    try {
      const { getAllToolConfigs } = await import('@/lib/tool-access')
      const configs = await getAllToolConfigs()
      if (configs.length > 0) {
        const overrideMap = new Map(configs.map(c => [c.toolName, c.description]))
        for (const s of builtinSummaries) {
          const ov = overrideMap.get(s.name)
          if (ov !== undefined && ov !== null && ov !== '') s.description = ov
        }
      }
    } catch { /* fail-open — mô tả mặc định */ }

    // ===== TASK 22: Agent rows — DB-FIRST (mọi AgentProfile sống) =====
    // Bao gồm: Omega + Opus + Code Team + agents do Omega create_agent tạo +
    // agents user tự tạo trong UI. Effective tools = default (DB tools JSON →
    // standalone → team) + ToolAssignment override (Tools Manager) — phản ánh
    // CHÍNH XÁC những gì goal-loop sẽ cho agent dùng ở request chat kế tiếp.
    const agentRows: AgentRow[] = []
    const seen = new Set<string>()
    // Assignments 1 lần cho cả batch (hiển thị open-access chính xác: tool bị
    // disable qua Tools Manager bị executor hard-gate chặn → không hiển thị)
    const allAssignments = await getAllAssignments().catch(() => [])
    try {
      const profiles = await db.agentProfile.findMany({
        orderBy: [{ isSystem: 'desc' }, { createdAt: 'asc' }],
        select: {
          id: true, name: true, avatar: true, isSystem: true,
          team: true, position: true, tools: true, enabled: true,
        },
      })
      for (const p of profiles) {
        // FIX (review R2-c #6): agent bị TẮT (enabled=false) không hiện trong
        // matrix + không đếm vào agentCount — registry phản ánh agents ĐANG
        // hoạt động (agent tắt không chat được → hiển thị gây hiểu nhầm).
        if (!p.enabled) continue
        seen.add(p.name)
        const defaults = resolveDefaultTools(p)
        // ToolAssignment override (Tools Manager / Omega manage_tools) — live
        let effective = defaults
        try {
          effective = await getEffectiveToolNames(p.name, defaults)
        } catch { /* fail-open giữ defaults */ }
        let openAccess = effective.length === 0
        let displayTools = effective
        if (openAccess) {
          // Open-access (whitelist rỗng = MỌI tool được phép ở prompt-side) —
          // hiển thị full bộ builtin TRỪ tool bị hard-gate disable tường minh
          const key = resolveAgentKey(p.name)
          const disabled = new Set(
            allAssignments.filter(a => a.agentKey === key && a.enabled === false).map(a => a.toolName)
          )
          displayTools = builtinNames.filter(t => !disabled.has(t))
          // Mọi tool đều bị chặn (edge hiếm) → coi như không còn open-access
          if (disabled.size > 0 && displayTools.length === 0) openAccess = false
        }
        agentRows.push({
          name: p.name,
          short: (p.position && TEAM_POSITIONS.includes(p.position)) ? p.position : (p.name.slice(0, 2).toUpperCase()),
          avatar: p.avatar,
          isSystem: p.isSystem,
          team: p.team,
          position: p.position,
          tools: displayTools,
          openAccess,
          source: p.name === 'Opus' ? 'opus'
            : getStandaloneAgentNames().includes(p.name) ? 'standalone'
            : openAccess ? 'db-open' : 'db',
        })
      }
    } catch (dbErr) {
      // Fail-open: DB lỗi → dùng bộ hardcode cũ (standalone + 5 team)
      console.warn('[ToolsRegistry] DB agentProfile enumerate failed (fail-open hardcode):', dbErr instanceof Error ? dbErr.message : String(dbErr))
    }

    // Bổ sung agents hardcode mà DB CHƯA có (seed chưa chạy / DB trống) —
    // hiển thị vẫn đầy đủ với default whitelist từ code definitions.
    for (const saName of getStandaloneAgentNames()) {
      if (seen.has(saName)) continue
      seen.add(saName)
      agentRows.push({
        name: saName, short: 'OM', avatar: null, isSystem: true, team: null, position: null,
        tools: getStandaloneAgentTools(saName), openAccess: false, source: 'standalone',
      })
    }
    // Opus (meta-agent — ensureOpusAgent có thể chưa chạy trong process này)
    if (!seen.has('Opus')) {
      seen.add('Opus')
      agentRows.push({
        name: 'Opus', short: '⚖', avatar: null, isSystem: true, team: null, position: null,
        tools: builtinNames, openAccess: false, source: 'opus',
      })
    }
    for (const pos of TEAM_POSITIONS) {
      const agentName = getAgentName(pos)
      if (seen.has(agentName)) continue
      seen.add(agentName)
      agentRows.push({
        name: agentName, short: pos, avatar: null, isSystem: false, team: 'code', position: pos,
        tools: getAgentTools(pos), openAccess: false, source: 'team',
      })
    }

    // Custom tool names (mọi agents đều dùng được — whitelist exception)
    await ensureCustomToolsLoaded()
    const customToolsLive = getAllCustomTools()
    const customToolNames = new Set(customToolsLive.map(t => t.name))

    // Per-tool: agents nào có quyền (built-in); open-access agents có MỌI tool
    const builtinTools = builtinSummaries.map(t => {
      const agents = agentRows
        .filter(a => a.tools.includes(t.name))
        .map(a => ({ name: a.name, short: a.short }))
      return {
        name: t.name,
        description: t.description,
        category: t.category,
        paramNames: t.paramNames,
        agents,
        agentCount: agents.length,
        totalAgents: agentRows.length,
        accessibleByAll: agents.length === agentRows.length,
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

    // ===== 3. Filesystem skills (skills/<slug>/SKILL.md) — cache 60s =====
    let filesystemSkills: Array<{ slug: string; hasSkillMd: boolean; description: string }>
    if (fsSkillsCache && Date.now() - fsSkillsCache.at < FS_SKILLS_CACHE_MS) {
      filesystemSkills = fsSkillsCache.data
    } else {
      filesystemSkills = []
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
                // Ưu tiên description trong YAML front matter; nếu không có thì
                // lấy dòng đầu tiên KHÔNG nằm trong front matter và không phải
                // heading (trước đây dòng `---` mở front matter bị chọn → hiển thị sai)
                const fm = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
                if (fm) {
                  const fmDesc = fm[1]
                    .split('\n')
                    .find(l => /^description\s*:/.test(l.trim()))
                    ?.replace(/^description\s*:\s*/, '')
                    .replace(/^["']|["']$/g, '')
                    .trim()
                  if (fmDesc) description = fmDesc.slice(0, 150)
                }
                if (!description) {
                  const body = fm ? content.slice(fm[0].length) : content
                  const line = body
                    .split('\n')
                    .find(l => l.trim() && !l.trim().startsWith('#') && l.trim() !== '---')
                  description = (line || '').trim().slice(0, 150)
                }
              } catch { /* ignore */ }
            }
            filesystemSkills.push({ slug: slug.name, hasSkillMd, description })
          }
        }
      } catch { /* non-fatal */ }
      fsSkillsCache = { at: Date.now(), data: filesystemSkills }
    }

    // ===== 4. DB skills (AgentSkill — ô SKILL.md Guides) =====
    let dbSkills: Array<{ slug: string; name: string; source: string; enabled: boolean; version: string }> = []
    try {
      const rows = await db.agentSkill.findMany({ orderBy: { installedAt: 'desc' } })
      dbSkills = rows.map(r => ({ slug: r.slug, name: r.name, source: r.source, enabled: r.enabled, version: r.version }))
    } catch { /* non-fatal */ }

    // ===== 5. Agent matrix (TASK 22: TOÀN BỘ agents trong DB + effective live) =====
    const agentMatrix = agentRows.map(a => {
      const canSelfWrite = a.tools.includes('create_custom_tool')
      const customCount = canSelfWrite || a.openAccess ? customToolNames.size : 0
      return {
        name: a.name,
        short: a.short,
        avatar: a.avatar,
        isSystem: a.isSystem,
        team: a.team,
        openAccess: a.openAccess,
        builtinToolCount: a.tools.length,
        canSelfWriteTools: canSelfWrite,
        customToolCount: customCount, // custom tools dùng được (nếu có quyền self-write / open-access)
        totalUsable: a.tools.length + customCount,
      }
    })

    return NextResponse.json({
      ok: true,
      // TASK 22: dấu thời gian + số agent để UI detect thay đổi (real-time)
      generatedAt: new Date().toISOString(),
      summary: {
        builtinToolCount: builtinTools.length,
        customToolCount: customTools.length,
        filesystemSkillCount: filesystemSkills.length,
        dbSkillCount: dbSkills.length,
        agentCount: agentRows.length,
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
