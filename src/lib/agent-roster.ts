/**
 * AGENT ROSTER — Danh bạ kỹ năng chuyên môn của các Agents
 * ====================================
 * (user request 2026-09-08: "các Agents đều có Instruction đầy đủ phân vai trò
 * rõ ràng. Vấn đề cần một giải pháp để các Agents nắm được kỹ năng chuyên môn
 * của nhau, xác định được khi cần thiết có thể gọi Agents có kỹ năng chuyên
 * môn tốt hơn")
 *
 * Kiến trúc: 1 prompt block compact (cache 60s) inject vào system prompt của
 * MỌI agents:
 *   - /api/openclaw/chat (standalone + custom agents — goal loop)
 *   - code-team/workflow-engine (5 agents Code Team)
 *
 * Block gồm:
 *   1. STANDALONE (Omega — orchestrator, nhận escalate_problem)
 *   2. CODE TEAM (APEX/CORTEX/BOLT/SENTINEL/CATALYST — delegate_task)
 *   3. CUSTOM/RESEARCH (bất kỳ agent nào khác — dispatch_agent)
 *   4. Kỷ luật nhận diện vấn đề SỚM → escalate trước khi kẹt hẳn
 *
 * Sau khi Omega create_agent / dispatch long_term → invalidateRosterCache()
 * để danh bạ cập nhật ngay ở request kế tiếp.
 */

import { db } from '@/lib/db'

// ==================== TYPES ====================

export interface RosterEntry {
  id: string
  name: string
  avatar: string
  description: string
  capable: string
  team: string | null
  position: string | null
  domain: string
  isSystem: boolean
}

export interface AgentRoster {
  standalone: RosterEntry[]
  codeTeam: RosterEntry[]
  research: RosterEntry[]
  custom: RosterEntry[]
  probedAt: string
}

// ==================== CACHE ====================

const ROSTER_CACHE_TTL_MS = 60_000
const globalForRoster = globalThis as unknown as {
  __tmoAgentRosterCache?: { roster: AgentRoster; at: number }
}

/** Invalidate roster cache — gọi sau create_agent/dispatch_long_term/agents CRUD */
export function invalidateRosterCache(): void {
  globalForRoster.__tmoAgentRosterCache = undefined
}

// ==================== FETCH ====================

export async function getAgentRoster(): Promise<AgentRoster> {
  const cached = globalForRoster.__tmoAgentRosterCache
  if (cached && Date.now() - cached.at < ROSTER_CACHE_TTL_MS) {
    return cached.roster
  }

  const roster: AgentRoster = {
    standalone: [],
    codeTeam: [],
    research: [],
    custom: [],
    probedAt: new Date().toISOString(),
  }

  try {
    const profiles = await db.agentProfile.findMany({
      where: { enabled: true },
      select: {
        id: true, name: true, avatar: true, description: true, capable: true,
        team: true, position: true, domain: true, isSystem: true,
      },
      orderBy: [{ team: 'asc' }, { position: 'asc' }, { createdAt: 'asc' }],
      take: 100,
    })

    for (const p of profiles) {
      const entry: RosterEntry = {
        id: p.id,
        name: p.name,
        avatar: p.avatar || '🤖',
        description: p.description || '',
        capable: p.capable || '',
        team: p.team,
        position: p.position,
        domain: p.domain,
        isSystem: p.isSystem,
      }
      if (!p.team) {
        roster.standalone.push(entry)
      } else if (p.team === 'code') {
        roster.codeTeam.push(entry)
      } else if (p.team === 'research') {
        roster.research.push(entry)
      } else {
        roster.custom.push(entry)
      }
    }
  } catch (err) {
    // Fail-open: DB lỗi → roster rỗng (block rút gọn vẫn inject được)
    console.warn('[AgentRoster] DB fetch failed (fail-open):', err instanceof Error ? err.message : String(err))
  }

  globalForRoster.__tmoAgentRosterCache = { roster, at: Date.now() }
  return roster
}

// ==================== PROMPT BLOCK ====================

function entryLine(e: RosterEntry, maxLen = 170): string {
  const skills = (e.capable || e.description || '').replace(/\s+/g, ' ').trim()
  const trimmed = skills.length > maxLen ? skills.slice(0, maxLen) + '…' : skills
  const pos = e.position ? ` [${e.position}]` : ''
  return `- ${e.name} ${e.avatar}${pos}: ${trimmed}`
}

/**
 * Prompt block inject vào system prompt — cho agent BIẾT đồng nghiệp nào giỏi
 * gì và cách gọi đúng. excludeName: bỏ chính agent đang chạy (tự giới thiệu
 * lại chính mình chỉ tốn token).
 */
export async function buildAgentRosterPromptBlock(excludeName?: string): Promise<string> {
  const roster = await getAgentRoster()
  const ex = (e: RosterEntry) => e.name !== excludeName

  const parts: string[] = []
  parts.push('--- Agent Roster (ĐỒNG NGHIỆP — kỹ năng chuyên môn của các agents khác) ---')
  parts.push('Bạn KHÔNG làm việc một mình. Khi tác vụ vượt chuyên môn của bạn hoặc bạn gặp vấn đề → gọi agent có kỹ năng tốt hơn:')

  const standalone = roster.standalone.filter(ex)
  const codeTeam = roster.codeTeam.filter(ex)
  const research = roster.research.filter(ex)
  const custom = roster.custom.filter(ex)

  if (standalone.length > 0) {
    parts.push('■ STANDALONE (trợ lý đa năng):')
    for (const e of standalone) parts.push(entryLine(e))
  }

  if (codeTeam.length > 0) {
    parts.push('■ CODE TEAM (gọi qua delegate_task):')
    for (const e of codeTeam) parts.push(entryLine(e))
  }

  if (research.length > 0) {
    parts.push('■ RESEARCH TEAM:')
    for (const e of research) parts.push(entryLine(e))
  }

  if (custom.length > 0) {
    parts.push('■ AGENTS KHÁC (gọi qua dispatch_agent):')
    for (const e of custom) parts.push(entryLine(e))
  }

  parts.push('')
  parts.push('CƠ CHẾ PHỐI HỢP:')
  parts.push('• Gặp vấn đề / kẹt / lặp lỗi / không rõ hướng giải → tool_call: escalate_problem({"problem": " mô tả vấn đề", "context": "...", "attempted": "đã thử gì"}) → OMEGA (orchestrator) phân tích và đề xuất giải pháp tốt nhất (điều agent nào xử lý, cần agent mới nào, đổi cách tiếp cận...).')
  parts.push('• NHẬN DIỆN SỚM: tool fail 2 lần cùng lỗi / cùng hành động lặp lại / task cần chuyên môn ngoài vòng của bạn → escalate NGAY, đừng chờ kẹt hẳn. Vấn đề được giải từ trước rẻ hơn chữa sau.')
  parts.push('• Task code lớn tự chứa → delegate_task cho Code Team chuyên trách. Task phù hợp agent khác trong roster → dispatch_agent({"agent": "TÊN", "task": "..."}) — sub-agent chạy tự chủ, trả báo cáo nén (context của bạn không phình).')

  return '\n' + parts.join('\n')
}
