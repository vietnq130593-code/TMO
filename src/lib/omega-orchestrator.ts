/**
 * OMEGA ORCHESTRATOR — Tổng chỉ huy của hệ thống Agents
 * ====================================
 * (user request 2026-09-08: "Hãy thêm nhiệm vụ cho Omega là agents có thể tiếp
 * nhận vấn đề từ các agents và tính toán để đưa ra giải pháp tốt nhất cho
 * agents gặp vấn đề. Hãy thiết kế để Omega có thể tự tạo ra thêm agents trong
 * module Agents, thiết lập bao gồm Avatar, Tên, Mô tả vai trò, Hướng dẫn chi
 * tiết, chọn model, team, vị trí, Temperature và lương token. Omega có thể
 * điều động bất kỳ agents nào tham gia tạm thời hoặc lâu dài trong việc xử lý
 * tác vụ của một agents hoặc một team")
 *
 * 3 NĂNG LỰC:
 *
 * 1. consultOmega() — TIẾP NHẬN VẤN ĐỀ:
 *    Agent bất kỳ gọi tool escalate_problem → bộ não OMEGA-on-demand được kích
 *    hoạt (1 LLM call, persona từ AgentProfile Omega + roster đầy đủ) → phân
 *    tích căn nguyên, cân nhắc phương án (tự sửa / đổi cách / điều agent khác /
 *    tạo agent mới) → trả ADVISORY NÉN cho agent gặp vấn đề.
 *    · Context isolation: Omega không cần "đang chạy" — brain invoked on-demand
 *    · Omega thấy AGENT ROSTER nên đề xuất đúng người, không đoán mò
 *    ·也被 goal loop dùng cho AUTO-ESCALATE (trước khi agent kẹt hẳn)
 *
 * 2. createAgentByOmega() — AGENT FACTORY:
 *    Omega tự tạo agent mới trong module Agents (AgentProfile DB — hiện ngay
 *    trong UI). Đủ trường hợp user yêu cầu: Avatar, Tên, Mô tả vai trò,
 *    Hướng dẫn chi tiết (instruction), model, team, vị trí, Temperature,
 *    lương token (maxTokens) + toolset riêng (field tools JSON — schema
 *    2026-09-08). Validation dùng lại agent-constants (single source of truth).
 *
 * 3. dispatchAgentByOmega() — ĐIỀU ĐỘNG:
 *    · duration="task" (TẠM THỜI): agent X chạy task tự chủ như sub-agent
 *      (runSubAgentForProfile) — báo cáo nén quay về, context Omega không phình.
 *    · duration="long_term" (LÂU DÀI): cập nhật team/position của agent trong
 *      DB (biên chế vào team — kiểm tra position reservation như Agents API).
 *      Nếu kèm task → chạy task đó ngay sau khi điều động.
 *
 * Fail-open toàn bộ: lỗi resolve/LLM/DB → trả { success: false, error } —
 * agent gọi thấy lỗi và tự quyết định (không bao giờ crash loop cha).
 */

import { db } from '@/lib/db'
import { callLLMForAgent } from '@/lib/llm'
import { findBalancedJson } from '@/lib/code-team/find-balanced-json'
import {
  PROVIDER_MODELS,
  VALID_PROVIDERS,
  VALID_DOMAINS,
  TEAM_POSITIONS,
  AGENT_NAME_MIN,
  AGENT_NAME_MAX,
  AGENT_DESCRIPTION_MAX,
  AGENT_INSTRUCTION_MAX,
} from '@/lib/agent-constants'
import { getAgentRoster, invalidateRosterCache } from '@/lib/agent-roster'

// ==================== CONFIG ====================

/** Cap ký tự advisory trả về agent gọi (chống phình context) */
const ADVISORY_MAX_CHARS = 2600
/** maxTokens cho 1 lần consult Omega */
const CONSULT_MAX_TOKENS = 1100
/** Timeout 1 consult LLM call */
const CONSULT_TIMEOUT_MS = 3 * 60_000

/** Omega fallback khi DB không có profile (fail-open, vẫn tư vấn được) */
const OMEGA_FALLBACK = { provider: 'nvidia', model: 'moonshotai/kimi-k3' }

/**
 * FIX (review 2026-09-08 — directive 2026-09-05): 2 model dưới là LÕI EXTRACTION
 * (chỉ phục vụ trích xuất tài liệu KB) — CẤM dùng làm model chat cho agent do
 * Omega tạo (agent chat bằng extraction core = chất lượng tệ + sai directive).
 */
const EXTRACTION_ONLY_MODELS = new Set(['nvidia/nemotron-3-ultra-550b-a55b', 'openai/gpt-oss-120b'])
const CHAT_MODEL_HINT = 'moonshotai/kimi-k3 (mạnh, khuyến nghị) | deepseek-ai/deepseek-v4-pro-0813 | deepseek-ai/deepseek-v4-flash-0731 (nhanh) | minimaxai/minimax-m3'

/** Toolset mặc định cho agent mới nếu Omega không chỉ định — luôn kèm
 *  escalate_problem (agent mới được hỏi Omega khi kẹt — đúng cơ chế
 *  "agents nắm kỹ năng nhau" user yêu cầu).
 *  Task 19-b: thêm get_app_runtime_status — agent mới cũng phải NHÌN THẤY
 *  preview/dev-server user đang chạy (tránh kill nhầm process của user). */
export const DEFAULT_NEW_AGENT_TOOLS = [
  'tavily', 'serper', 'jina',
  'knowledge_search', 'knowledge_graph',
  'file_read', 'file_list', 'grep', 'file_edit', 'file_multi_edit', 'file_write',
  'shell', 'run_tests', 'lint', 'type_check', 'get_diagnostics',
  'todo_write', 'todo_read', 'list_skills', 'read_skill',
  'create_custom_tool', 'list_custom_tools',
  'get_app_runtime_status',
  'escalate_problem',
  // AUTOMATION PROPOSAL (user request 2026-09-13): agent mới thấy cần cron
  // job / webhook / standing order / task flow → đề xuất với Omega
  // (propose_automation) — Omega quyết định forward vào Self-direction chờ
  // phê duyệt. Không có quyền tạo trực tiếp (chỉ Omega có manage_automation).
  'propose_automation',
]

/** 5 vị trí chuẩn của team code — RESERVED cho APEX/CORTEX/BOLT/SENTINEL/
 *  CATALYST (Code Team agents seed isSystem=false nên không check được qua
 *  flag — hard-reserve theo tên vị trí). Agent mới/Omega điều động dùng G4/G5. */
const CODE_TEAM_RESERVED_POSITIONS = ['TL', 'G1', 'G2-A', 'G2-B', 'G3']
const CODE_TEAM_STANDARD_NAMES = ['APEX', 'CORTEX', 'BOLT', 'SENTINEL', 'CATALYST']

// ==================== HELPERS ====================

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
  })
  try {
    return await Promise.race([promise, timeoutPromise])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** Resolve Omega profile từ DB (provider/model/instruction) — fail-open fallback */
async function resolveOmegaBrain(): Promise<{
  provider: string
  model: string
  instruction: string
  id: string | null
}> {
  try {
    const omega = await db.agentProfile.findFirst({
      where: { name: 'Omega', enabled: true },
      select: { id: true, provider: true, model: true, instruction: true },
    })
    if (omega && omega.provider && omega.model) {
      return { provider: omega.provider, model: omega.model, instruction: omega.instruction || '', id: omega.id }
    }
  } catch { /* fail-open */ }
  return { provider: OMEGA_FALLBACK.provider, model: OMEGA_FALLBACK.model, instruction: '', id: null }
}

/** Dựng roster text compact cho prompt consult (Omega cần biết ai giỏi gì) */
async function rosterTextForConsult(): Promise<string> {
  const roster = await getAgentRoster()
  const lines: string[] = []
  const push = (label: string, entries: typeof roster.standalone) => {
    if (entries.length === 0) return
    lines.push(`${label}:`)
    for (const e of entries) {
      const skills = (e.capable || e.description || '').replace(/\s+/g, ' ').slice(0, 140)
      lines.push(`- ${e.name}${e.team ? ` [${e.team}${e.position ? '/' + e.position : ''}]` : ''}: ${skills}`)
    }
  }
  push('STANDALONE', roster.standalone)
  push('CODE TEAM', roster.codeTeam)
  push('RESEARCH TEAM', roster.research)
  push('AGENTS KHÁC', roster.custom)
  return lines.join('\n').slice(0, 4000) || '(roster trống)'
}

// ==================== 1. CONSULT — tiếp nhận vấn đề từ agents ====================

export interface OmegaAdvisory {
  diagnosis: string
  options: string[]
  recommendation: string
  /** Agent trong roster nên được điều động xử lý (nếu có) */
  dispatchAgent: string | null
  /** Đề xuất tạo agent mới (nếu roster không ai phù hợp) */
  createAgent: { name: string; description: string } | null
  severity: 'low' | 'medium' | 'high'
}

export interface ConsultResult {
  success: boolean
  advisory: OmegaAdvisory | null
  /** Advisory dạng text đọc được (dựng từ structured hoặc raw) */
  text: string
  tokensUsed: number
  error?: string
}

/**
 * OMEGA-ON-DEMAND — agent gặp vấn đề (hoặc goal-loop auto-escalate) gọi hàm
 * này. 1 LLM call với persona Omega + roster → advisory nén.
 */
export async function consultOmega(params: {
  problem: string
  context?: string
  attempted?: string
  callingAgent?: string
  severity?: string
  autoTriggered?: boolean
  abortCheck?: () => boolean
  onTokens?: (tokens: number) => void
}): Promise<ConsultResult> {
  const {
    problem, context, attempted, callingAgent = 'unknown-agent',
    severity = 'medium', autoTriggered = false, abortCheck, onTokens,
  } = params

  try {
    const brain = await resolveOmegaBrain()
    const rosterText = await rosterTextForConsult()

    const systemPrompt = (brain.instruction ? brain.instruction + '\n\n' : '') + `

═══════════════════════════════════════════
 CHẾ ĐỘ TƯ VẤN ORCHESTRATOR (tạm thời)
═══════════════════════════════════════════
Bạn đang nhận yêu cầu TƯ VẤN từ agent "${callingAgent}"${autoTriggered ? ' (tự động kích hoạt vì agent này đang bế tắc)' : ''}.
Nhiệm vụ: phân tích vấn đề của agent này và ĐƯA RA GIẢI PHÁP TỐT NHẤT. Bạn thấy đầy đủ AGENT ROSTER bên dưới — hãy cân nhắc:
(a) agent tự khắc phục bằng cách nào (đổi cách tiếp cận, tool nào chưa dùng đúng),
(b) điều động agent nào trong roster xử lý phần việc đó tốt hơn (kèm lý do),
(c) nếu không ai trong roster phù hợp → đề xuất tạo agent mới (tên + mô tả vai trò + kỹ năng).

Output DUY NHẤT một JSON hợp lệ (KHÔNG markdown fence, KHÔNG giải thích ngoài):
{"diagnosis": "căn nguyên vấn đề (1-3 câu)", "options": ["phương án 1", "phương án 2"], "recommendation": "giải pháp TỐT NHẤT + lý do + bước cụ thể cho agent", "dispatchAgent": "TÊN agent trong roster hoặc null", "createAgent": {"name": "...", "description": "..."} hoặc null, "severity": "low|medium|high"}`

    const userPrompt = `AGENT GỌI: ${callingAgent}
MỨC ĐỘ: ${severity}

VẤN ĐỀ:
${problem.slice(0, 2500)}

CONTEXT:
${(context || '(không có)').slice(0, 2000)}

ĐÃ THỬ:
${(attempted || '(chưa thử gì)').slice(0, 1500)}

AGENT ROSTER HIỆN CÓ:
${rosterText}

Phân tích và đưa ra giải pháp tốt nhất (JSON).`

    const result = await withTimeout(
      callLLMForAgent(userPrompt, { provider: brain.provider, model: brain.model }, systemPrompt, {
        agentId: brain.id || 'omega-orchestrator',
        agentName: 'Omega (orchestrator consult)',
        temperature: 0.3,
        maxTokens: CONSULT_MAX_TOKENS,
        abortCheck,
      }),
      CONSULT_TIMEOUT_MS,
      'Omega consult',
    )

    if (!result || (!result.content && !result.tool_calls)) {
      return { success: false, advisory: null, text: '', tokensUsed: 0, error: result?.error || 'Omega LLM call failed' }
    }
    const tokens = typeof result.tokensUsed === 'number' ? result.tokensUsed : 0
    onTokens?.(tokens)

    // Parse JSON verdict (chống markdown fence)
    let advisory: OmegaAdvisory | null = null
    try {
      const text = result.content.replace(/```(?:json)?/g, '')
      const jsonStr = findBalancedJson(text, 'diagnosis') || findBalancedJson(text, 'recommendation')
      if (jsonStr) {
        const obj = JSON.parse(jsonStr) as Record<string, unknown>
        advisory = {
          diagnosis: typeof obj.diagnosis === 'string' ? obj.diagnosis.slice(0, 600) : '',
          options: Array.isArray(obj.options) ? obj.options.map(o => String(o).slice(0, 250)).slice(0, 4) : [],
          recommendation: typeof obj.recommendation === 'string' ? obj.recommendation.slice(0, 1200) : '',
          dispatchAgent: typeof obj.dispatchAgent === 'string' && obj.dispatchAgent ? obj.dispatchAgent.slice(0, 60) : null,
          createAgent:
            obj.createAgent && typeof obj.createAgent === 'object'
              ? {
                  name: String((obj.createAgent as Record<string, unknown>).name || '').slice(0, 60),
                  description: String((obj.createAgent as Record<string, unknown>).description || '').slice(0, 400),
                }
              : null,
          severity: obj.severity === 'high' || obj.severity === 'low' ? obj.severity : 'medium',
        }
      }
    } catch { /* advisory=null → dùng raw */ }

    // Dựng text đọc được
    let text: string
    if (advisory) {
      const lines = [
        `🧠 TƯ VẤN TỪ OMEGA (orchestrator) — cho ${callingAgent}:`,
        `📋 Chẩn đoán: ${advisory.diagnosis || '(không rõ)'}`,
      ]
      if (advisory.options.length > 0) lines.push(`⚖️ Phương án: ${advisory.options.map(o => `- ${o}`).join(' ')}`)
      lines.push(`✅ Khuyến nghị: ${advisory.recommendation}`)
      if (advisory.dispatchAgent) lines.push(`👤 Agent nên điều động: ${advisory.dispatchAgent} (dùng dispatch_agent/delegate_task)`)
      if (advisory.createAgent?.name) lines.push(`🆕 Đề xuất tạo agent mới: ${advisory.createAgent.name} — ${advisory.createAgent.description} (dùng create_agent)`)
      text = lines.join('\n')
    } else {
      text = `🧠 TƯ VẤN TỪ OMEGA (orchestrator) — cho ${callingAgent}:\n${result.content.slice(0, ADVISORY_MAX_CHARS)}`
    }

    if (text.length > ADVISORY_MAX_CHARS) {
      text = text.slice(0, ADVISORY_MAX_CHARS) + '\n…(advisory đã nén)'
    }

    console.log(`[OmegaOrchestrator] Consult cho ${callingAgent} (${autoTriggered ? 'auto' : 'agent-called'}, severity=${severity}): ${advisory?.dispatchAgent ? `đề xuất điều ${advisory.dispatchAgent}` : advisory?.createAgent?.name ? `đề xuất tạo ${advisory.createAgent.name}` : 'tự khắc phục'} — ${tokens} tokens`)
    return { success: true, advisory, text, tokensUsed: tokens }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn(`[OmegaOrchestrator] Consult failed: ${msg}`)
    return { success: false, advisory: null, text: '', tokensUsed: 0, error: msg }
  }
}

// ==================== 2. AGENT FACTORY — Omega tự tạo agents ====================

export interface CreateAgentResult {
  success: boolean
  agent?: {
    id: string
    name: string
    description: string
    avatar: string
    model: string
    provider: string
    team: string | null
    position: string | null
    temperature: number
    maxTokens: number
    tools: string[]
  }
  error?: string
}

/**
 * OMEGA AGENT FACTORY — tạo agent mới trong module Agents (AgentProfile DB).
 * Agent mới hiện ngay trong UI module Agents, có toolset riêng (field tools).
 */
export async function createAgentByOmega(params: {
  name: string
  description: string
  instruction: string
  avatar?: string
  provider?: string
  model?: string
  team?: string | null
  position?: string | null
  temperature?: number
  maxTokens?: number
  domain?: string
  capable?: string
  tools?: string[]
}): Promise<CreateAgentResult> {
  const {
    name, description, instruction,
    avatar, provider, model, team, position, temperature, maxTokens, domain, capable, tools,
  } = params

  // ===== Validation (dùng lại agent-constants — single source of truth) =====
  const nameTrim = String(name || '').trim()
  if (nameTrim.length < AGENT_NAME_MIN || nameTrim.length > AGENT_NAME_MAX) {
    return { success: false, error: `Tên Agent phải từ ${AGENT_NAME_MIN}-${AGENT_NAME_MAX} ký tự (nhận: "${nameTrim}")` }
  }
  const descTrim = String(description || '').trim()
  if (!descTrim) return { success: false, error: 'Thiếu "description" — mô tả vai trò của agent mới.' }
  if (descTrim.length > AGENT_DESCRIPTION_MAX) {
    return { success: false, error: `Mô tả vai trò quá dài (>${AGENT_DESCRIPTION_MAX} ký tự).` }
  }
  const instrTrim = String(instruction || '').trim()
  if (!instrTrim) return { success: false, error: 'Thiếu "instruction" — hướng dẫn chi tiết (system prompt) cho agent mới.' }
  if (instrTrim.length > AGENT_INSTRUCTION_MAX) {
    return { success: false, error: `Hướng dẫn chi tiết quá dài (>${AGENT_INSTRUCTION_MAX} ký tự).` }
  }

  const providerValue = provider || 'nvidia'
  if (!VALID_PROVIDERS.includes(providerValue)) {
    return { success: false, error: `Provider "${providerValue}" không hợp lệ. Chọn: ${VALID_PROVIDERS.join(', ')}` }
  }
  const modelValue = model || 'moonshotai/kimi-k3'
  const models = PROVIDER_MODELS[providerValue] || []
  if (!models.some(m => m.id === modelValue)) {
    return { success: false, error: `Model "${modelValue}" không thuộc provider "${providerValue}". Models khả dụng: ${models.map(m => m.id).join(', ')}` }
  }
  // EXTRACTION CORE GUARD (fix review 2026-09-08): lõi extraction không được
  // làm model chat cho agent mới (directive 2026-09-05).
  if (EXTRACTION_ONLY_MODELS.has(modelValue)) {
    return { success: false, error: `Model "${modelValue}" là LÕI EXTRACTION (chỉ dùng trích xuất tài liệu KB — directive 2026-09-05), không được làm model chat cho agent. Chat models khả dụng: ${CHAT_MODEL_HINT}` }
  }

  const domainValue = domain || 'mixed'
  if (!VALID_DOMAINS.includes(domainValue)) {
    return { success: false, error: `Domain "${domainValue}" không hợp lệ. Chọn: ${VALID_DOMAINS.join(', ')}` }
  }

  // Team + position
  const teamValue = team ? String(team) : null
  const positionValue = position ? String(position) : null
  if (teamValue) {
    if (teamValue !== 'code' && teamValue !== 'research') {
      return { success: false, error: `Team "${teamValue}" không hợp lệ. Chọn: code, research (hoặc null = standalone).` }
    }
    if (!positionValue) {
      return { success: false, error: `Vào team "${teamValue}" cần "position". Vị trí hợp lệ: ${(TEAM_POSITIONS[teamValue] || []).join(', ')}` }
    }
    const validPositions = TEAM_POSITIONS[teamValue] || []
    if (!validPositions.includes(positionValue)) {
      return { success: false, error: `Position "${positionValue}" không hợp lệ cho team "${teamValue}". Chọn: ${validPositions.join(', ')}` }
    }
    // Position reservation — 5 vị trí chuẩn team code là của APEX/CORTEX/BOLT/
    // SENTINEL/CATALYST (hard-reserve — Code Team agents isSystem=false nên
    // không thể check qua flag isSystem). Agent mới dùng G4/G5.
    if (teamValue === 'code' && CODE_TEAM_RESERVED_POSITIONS.includes(positionValue)) {
      return {
        success: false,
        error: `Position "${positionValue}" của team code là vị trí chuẩn của Code Team (APEX/CORTEX/BOLT/SENTINEL/CATALYST). Agent mới vào team code dùng G4/G5 (vị trí mở rộng).`,
      }
    }
  } else if (positionValue) {
    return { success: false, error: 'Không thể có position khi agent là standalone (team=null).' }
  }

  const tempValue = typeof temperature === 'number' ? temperature : 0.7
  if (tempValue < 0 || tempValue > 2) return { success: false, error: 'Temperature phải từ 0.0 đến 2.0' }
  // 21-d: default 4096 → 16384 — agent mới cũng viết được file vừa/lớn qua
  // file_write append (cap không phải target; giữ range 256-32768)
  const tokensValue = typeof maxTokens === 'number' ? Math.floor(maxTokens) : 16384
  if (tokensValue < 256 || tokensValue > 32768) return { success: false, error: 'Lương token (maxTokens) phải từ 256 đến 32768' }

  // Toolset — mặc định generalist + LUÔN có escalate_problem (agent mới có thể
  // hỏi Omega khi kẹt — đúng cơ chế "agents nắm kỹ năng nhau" user yêu cầu)
  let toolsValue = Array.isArray(tools) && tools.length > 0
    ? tools.map(t => String(t)).filter(Boolean)
    : [...DEFAULT_NEW_AGENT_TOOLS]
  if (!toolsValue.includes('escalate_problem')) toolsValue = [...toolsValue, 'escalate_problem']

  // Unique name
  try {
    const existing = await db.agentProfile.findUnique({ where: { name: nameTrim } })
    if (existing) {
      return { success: false, error: `Tên Agent "${nameTrim}" đã tồn tại — chọn tên khác.` }
    }

    const created = await db.agentProfile.create({
      data: {
        name: nameTrim,
        description: descTrim,
        instruction: instrTrim,
        domain: domainValue,
        capable: capable ? String(capable).trim() : descTrim.slice(0, 300),
        provider: providerValue,
        model: modelValue,
        temperature: tempValue,
        maxTokens: tokensValue,
        team: teamValue,
        position: positionValue,
        avatar: avatar ? String(avatar).slice(0, 8) : '🤖',
        tools: JSON.stringify(toolsValue),
        isSystem: false, // user có thể xóa/sửa trong UI
        enabled: true,
      },
    })

    invalidateRosterCache()
    console.log(`[OmegaOrchestrator] Agent Factory: tạo agent "${nameTrim}" (model=${modelValue}, team=${teamValue || 'standalone'}, ${toolsValue.length} tools, temp=${tempValue}, lương=${tokensValue} tokens)`)

    return {
      success: true,
      agent: {
        id: created.id,
        name: created.name,
        description: created.description,
        avatar: created.avatar || '🤖',
        model: created.model,
        provider: created.provider,
        team: created.team,
        position: created.position,
        temperature: created.temperature,
        maxTokens: created.maxTokens,
        tools: toolsValue,
      },
    }
  } catch (err) {
    return { success: false, error: `DB error: ${err instanceof Error ? err.message : String(err)}` }
  }
}

// ==================== 3. DISPATCH — điều động agents ====================

export interface DispatchResult {
  success: boolean
  mode: 'task' | 'long_term'
  agent: string
  /** Báo cáo nén từ sub-agent (mode='task') */
  report?: string
  tokensUsed?: number
  iterations?: number
  toolCalls?: number
  endedBy?: string
  /** Kết quả điều động lâu dài (mode='long_term') */
  assignment?: { team: string | null; position: string | null }
  error?: string
}

/**
 * OMEGA DISPATCHER — điều động BẤT KỲ agent nào trong roster:
 *   · duration="task"      → tham gia TẠM THỜI: chạy 1 task tự chủ (sub-agent,
 *                            báo cáo nén, context isolation)
 *   · duration="long_term" → tham gia LÂU DÀI: điều vào team (update
 *                            team/position trong DB) + có thể kèm task chạy luôn
 */
export async function dispatchAgentByOmega(params: {
  agent: string
  task?: string
  context?: string
  duration?: string
  team?: string | null
  position?: string | null
  parentAgentName?: string
  sessionId?: string | null
  onTokens?: (tokens: number) => void
}): Promise<DispatchResult> {
  const {
    agent, task, context, duration = 'task', team, position,
    parentAgentName = 'Omega', sessionId = null, onTokens,
  } = params

  const agentName = String(agent || '').trim()
  if (!agentName) {
    return { success: false, mode: 'task', agent: '', error: 'Thiếu "agent" — tên agent cần điều động (xem Agent Roster).' }
  }

  // ===== Resolve agent theo TÊN (mọi agent trong hệ thống, không chỉ Code Team) =====
  let profile: DispatchableProfile | null = null
  try {
    profile = await db.agentProfile.findFirst({
      where: { name: agentName, enabled: true },
      select: {
        id: true, name: true, instruction: true, provider: true, model: true,
        temperature: true, maxTokens: true, team: true, position: true, tools: true,
      },
    })
  } catch { /* fail-open */ }

  if (!profile) {
    // Gợi ý tên đúng từ roster
    let available = ''
    try {
      const roster = await getAgentRoster()
      available = [...roster.standalone, ...roster.codeTeam, ...roster.research, ...roster.custom]
        .map(e => e.name).join(', ')
    } catch { /* ignore */ }
    return { success: false, mode: 'task', agent: agentName, error: `Agent "${agentName}" không tồn tại hoặc đang tắt.${available ? ` Agents khả dụng: ${available}` : ''}` }
  }

  if (!profile.provider || !profile.model) {
    return { success: false, mode: 'task', agent: profile.name, error: `Agent "${profile.name}" chưa cấu hình provider/model — không điều động được.` }
  }

  // ===== Toolset: DB tools JSON → mặc định dispatch toolset =====
  let toolset: string[] = []
  if (profile.tools) {
    try {
      const parsed = JSON.parse(profile.tools)
      if (Array.isArray(parsed)) toolset = parsed.map(t => String(t))
    } catch { /* ignore — dùng default */ }
  }

  // ===== Mode 1: long_term — điều động lâu dài vào team =====
  if (duration === 'long_term') {
    try {
      const newTeam = team !== undefined ? (team ? String(team) : null) : profile.team
      const newPosition = position !== undefined ? (position ? String(position) : null) : profile.position

      if (!newTeam && newPosition) {
        return { success: false, mode: 'long_term', agent: profile.name, error: 'Không thể có position khi agent là standalone (team=null).' }
      }
      if (newTeam) {
        if (newTeam !== 'code' && newTeam !== 'research') {
          return { success: false, mode: 'long_term', agent: profile.name, error: `Team "${newTeam}" không hợp lệ. Chọn: code, research (hoặc null = standalone).` }
        }
        const validPositions = TEAM_POSITIONS[newTeam] || []
        if (!newPosition) {
          return { success: false, mode: 'long_term', agent: profile.name, error: `Điều vào team "${newTeam}" cần "position". Vị trí hợp lệ: ${validPositions.join(', ')}` }
        }
        if (!validPositions.includes(newPosition)) {
          return { success: false, mode: 'long_term', agent: profile.name, error: `Position "${newPosition}" không hợp lệ cho team "${newTeam}". Chọn: ${validPositions.join(', ')}` }
        }
        // 5 vị trí chuẩn team code là của Code Team chuẩn — trừ khi chính agent
        // đang dispatch LÀ agent Code Team chuẩn (điều APEX về TL = no-op hợp lệ)
        if (newTeam === 'code' && CODE_TEAM_RESERVED_POSITIONS.includes(newPosition) && !CODE_TEAM_STANDARD_NAMES.includes(profile.name)) {
          return {
            success: false,
            mode: 'long_term',
            agent: profile.name,
            error: `Position "${newPosition}" của team code là vị trí chuẩn của Code Team (APEX/CORTEX/BOLT/SENTINEL/CATALYST). Agent điều động vào team code dùng G4/G5 (vị trí mở rộng).`,
          }
        }
      }

      await db.agentProfile.update({
        where: { id: profile.id },
        data: { team: newTeam, position: newPosition },
      })
      invalidateRosterCache()
      console.log(`[OmegaOrchestrator] Dispatch long_term: "${profile.name}" → team=${newTeam || 'standalone'}/${newPosition || '-'} (theo yêu cầu của ${parentAgentName})`)

      const result: DispatchResult = {
        success: true,
        mode: 'long_term',
        agent: profile.name,
        assignment: { team: newTeam, position: newPosition },
      }

      // Kèm task → agent mới điều động tham gia NGAY công việc
      const taskText = String(task || '').trim()
      if (taskText) {
        const run = await runDispatchTask(profile, toolset, taskText, context, parentAgentName, sessionId, onTokens)
        result.report = run.report
        result.tokensUsed = run.tokensUsed
        result.iterations = run.iterations
        result.toolCalls = run.toolCalls
        result.endedBy = run.endedBy
        // FIX (review 2026-09-08): assignment đã COMMIT ở trên (update DB) —
        // task kèm theo fail KHÔNG rollback assignment. Giữ success=true cho
        // assignment (roster/UI đã thấy agent ở team mới) và báo task-fail qua
        // error để LLM không tưởng điều động thất bại rồi retry/thôi bỏ.
        if (!run.success) {
          result.error = `⚠️ Điều động vào ${newTeam || 'standalone'}/${newPosition || '-'} ĐÃ ÁP DỤNG thành công, nhưng task kèm theo thất bại (${run.error || run.endedBy}) — xem report để tự làm phần việc đó.`
        }
      }
      return result
    } catch (err) {
      return { success: false, mode: 'long_term', agent: profile.name, error: `DB error: ${err instanceof Error ? err.message : String(err)}` }
    }
  }

  // ===== Mode 2: task (mặc định) — tham gia tạm thời, chạy 1 task =====
  const taskText = String(task || '').trim()
  if (!taskText) {
    return { success: false, mode: 'task', agent: profile.name, error: 'Thiếu "task" — mô tả nhiệm vụ cụ thể cho agent được điều động.' }
  }

  const run = await runDispatchTask(profile, toolset, taskText, context, parentAgentName, sessionId, onTokens)
  return {
    success: run.success,
    mode: 'task',
    agent: profile.name,
    report: run.report,
    tokensUsed: run.tokensUsed,
    iterations: run.iterations,
    toolCalls: run.toolCalls,
    endedBy: run.endedBy,
    error: run.error,
  }
}

/** Shape profile agent dùng cho dispatch (resolve từ DB theo tên) */
interface DispatchableProfile {
  id: string
  name: string
  instruction: string
  provider: string
  model: string
  temperature: number
  maxTokens: number
  team: string | null
  position: string | null
  tools: string | null
}

/** Chạy task bằng sub-agent generic (context isolation, depth guard bên trong) */
async function runDispatchTask(
  profile: DispatchableProfile,
  toolset: string[],
  task: string,
  context: string | undefined,
  parentAgentName: string,
  sessionId: string | null,
  onTokens?: (tokens: number) => void,
): Promise<{ success: boolean; report: string; tokensUsed: number; iterations: number; toolCalls: number; endedBy: string; error?: string }> {
  const { runSubAgentForProfile } = await import('@/lib/subagent-delegate')
  const outcome = await runSubAgentForProfile({
    profile: {
      id: profile.id,
      name: profile.name,
      instruction: profile.instruction,
      provider: profile.provider,
      model: profile.model,
      temperature: profile.temperature,
      maxTokens: profile.maxTokens,
      tools: toolset,
    },
    task,
    context,
    parentAgentName,
    sessionId,
    onTokens,
  })
  return {
    success: outcome.success,
    report: outcome.report,
    tokensUsed: outcome.tokensUsed,
    iterations: outcome.iterations,
    toolCalls: outcome.toolCalls,
    endedBy: outcome.endedBy,
    error: outcome.error,
  }
}
