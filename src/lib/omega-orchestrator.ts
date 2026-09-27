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
/** Timeout 1 consult LLM call
 *  Task 20 (2026-09-03): 180s cũ giết chuỗi fallback TRƯỚC khi tới lượt
 *  minimax-m3 khi 3 lõi đầu hang NIM (chuỗi cần ~460s). 600s ≥ worst-case;
 *  prober (llm.ts) trip breaker cho lõi hang nên consult thường ~giây. */
const CONSULT_TIMEOUT_MS = Math.max(30_000, parseInt(process.env.OMEGA_CONSULT_TIMEOUT_MS || '600000', 10) || 600_000)

/** Omega fallback khi DB không có profile (fail-open, vẫn tư vấn được)
 *  TASK 37 (2026-10-28 — PHIÊN 7): TẤT CẢ agents dùng space-bunny-free — model
 *  free DUY NHẤT còn mở cho oc_sk API key sau policy Zen ~25-26/09. */
const OMEGA_FALLBACK = { provider: 'zen', model: 'space-bunny-free' }

/**
 * FIX (review 2026-09-08 — directive 2026-09-05): 2 model dưới là lõi extraction
 * NIM cũ — CẤM dùng làm model chat cho agent do Omega tạo (agent chat bằng
 * extraction core = chất lượng tệ + sai directive). Task 33: NIM đã gỡ khỏi
 * agents — giữ Set này để chặn cả giá trị sót từ DB/instruction cũ.
 */
const EXTRACTION_ONLY_MODELS = new Set(['nvidia/nemotron-3-ultra-550b-a55b', 'openai/gpt-oss-120b'])
const CHAT_MODEL_HINT = 'space-bunny-free (TẤT CẢ agents — phiên 7, Task 37; model free duy nhất mở cho oc_sk key) — provider zen'

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

/** 5 vị trí chuẩn của team code — RESERVED cho MEGATRON/SHOCWAVE/RAMPAGE/SENTINEL/
 *  CATALYST (Code Team agents seed isSystem=false nên không check được qua
 *  flag — hard-reserve theo tên vị trí). Agent mới/Omega điều động dùng G4/G5. */
const CODE_TEAM_RESERVED_POSITIONS = ['TL', 'G1', 'G2-A', 'G2-B', 'G3']
const CODE_TEAM_STANDARD_NAMES = ['MEGATRON', 'SHOCWAVE', 'RAMPAGE', 'SENTINEL', 'CATALYST']

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
  // FIX 2026-09-02 (Omega audit #6): cap cũ 4000 ký tự cắt roster lớn giữa
  // chừng — Omega consult không thấy agent phù hợp tồn tại → khuyến nghị tạo
  // agent TRÙNG năng lực. Tăng lên 12000 (consult prompt rất gọn ~1-2k, các
  // brain kimi-k3/deepseek/minimax chịu 16k+ context thoải mái) + nếu vượt
  // cap thì cắt từng MỖI dòng cuối (giữ nguyên 4 nhóm đầu đủ nhận diện).
  const full = lines.join('\n')
  if (full.length <= 12_000) return full || '(roster trống)'
  return `${full.slice(0, 12_000)}\n…(roster còn ${lines.length} dòng đã bị cắt bớt — cân nhắc gọi getAgentRoster trực tiếp)`
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

  // FIX 2026-09-25 (E2E tool audit): default provider → zen (13/13 agents đang chạy
  // zen; nvidia keys chết — agent mới tạo với nvidia sẽ không gọi được LLM).
  // Default model theo provider (PHIÊN 7 — Task 37): zen → space-bunny-free
  // (model free duy nhất mở cho oc_sk key; nvidia legacy → minimax-m3).
  const providerValue = provider || 'zen'
  if (!VALID_PROVIDERS.includes(providerValue)) {
    return { success: false, error: `Provider "${providerValue}" không hợp lệ. Chọn: ${VALID_PROVIDERS.join(', ')}` }
  }
  const modelValue = model || (providerValue === 'zen' ? 'space-bunny-free' : 'minimaxai/minimax-m3')
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
    // Position reservation — 5 vị trí chuẩn team code là của MEGATRON/SHOCWAVE/RAMPAGE/
    // SENTINEL/CATALYST (hard-reserve — Code Team agents isSystem=false nên
    // không thể check qua flag isSystem). Agent mới dùng G4/G5.
    if (teamValue === 'code' && CODE_TEAM_RESERVED_POSITIONS.includes(positionValue)) {
      return {
        success: false,
        error: `Position "${positionValue}" của team code là vị trí chuẩn của Code Team (MEGATRON/SHOCWAVE/RAMPAGE/SENTINEL/CATALYST). Agent mới vào team code dùng G4/G5 (vị trí mở rộng).`,
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
  /** FIX 2026-09-14 #2 — verdict của trọng tài delegation độc lập (mode='task') */
  evaluation?: { pass: boolean; confidence: number; gaps: string[]; note: string }
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
  /** REVIEW 9-fix (2026-08-30) #5 — runId của run CHA (goal-loop / pipeline
   * step): persist lên AgentRunRecord.parentRunId để query "mọi delegation
   * của run X" hoạt động ĐỦ đường (trước đây chỉ delegate_task truyền).
   * Truyền từ context.runId của tool-executor / runId của goal-loop. */
  parentRunId?: string | null
  onTokens?: (tokens: number) => void
}): Promise<DispatchResult> {
  const {
    agent, task, context, duration = 'task', team, position,
    parentAgentName = 'Omega', sessionId = null, parentRunId = null, onTokens,
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
        // đang dispatch LÀ agent Code Team chuẩn (điều MEGATRON về TL = no-op hợp lệ)
        if (newTeam === 'code' && CODE_TEAM_RESERVED_POSITIONS.includes(newPosition) && !CODE_TEAM_STANDARD_NAMES.includes(profile.name)) {
          return {
            success: false,
            mode: 'long_term',
            agent: profile.name,
            error: `Position "${newPosition}" của team code là vị trí chuẩn của Code Team (MEGATRON/SHOCWAVE/RAMPAGE/SENTINEL/CATALYST). Agent điều động vào team code dùng G4/G5 (vị trí mở rộng).`,
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
        const run = await runDispatchTask(profile, toolset, taskText, context, parentAgentName, sessionId, parentRunId, onTokens)
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

  const run = await runDispatchTask(profile, toolset, taskText, context, parentAgentName, sessionId, parentRunId, onTokens)
  return {
    success: run.success,
    mode: 'task',
    agent: profile.name,
    report: run.report,
    tokensUsed: run.tokensUsed,
    iterations: run.iterations,
    toolCalls: run.toolCalls,
    endedBy: run.endedBy,
    evaluation: run.evaluation,
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
  parentRunId?: string | null,
  onTokens?: (tokens: number) => void,
): Promise<{ success: boolean; report: string; tokensUsed: number; iterations: number; toolCalls: number; endedBy: string; evaluation?: { pass: boolean; confidence: number; gaps: string[]; note: string }; error?: string }> {
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
    // REVIEW 9-fix (2026-08-30) #5 — delegation rows qua dispatch_agent /
    // auto-apply / fan-out giờ CŨNG gắn parentRunId (như delegate_task).
    parentRunId,
    onTokens,
  })
  return {
    success: outcome.success,
    report: outcome.report,
    tokensUsed: outcome.tokensUsed,
    iterations: outcome.iterations,
    toolCalls: outcome.toolCalls,
    endedBy: outcome.endedBy,
    evaluation: outcome.evaluation,
    error: outcome.error,
  }
}

// ==================== FAN-OUT / FAN-IN (user report 2026-09-14 #1) ====================

/**
 * DISPATCH SONG SONG + HỢP NHẤT — dispatch N sub-agent chạy ĐỒNG THỜI
 * (Promise.allSettled) rồi merge kết quả:
 *   - Mỗi sub-agent độc lập: 1 fail KHÔNG kéo sập cả batch (no-throwError
 *     — lỗi của agent nào báo riêng kết quả của agent đó).
 *   - Xung đột kết quả (2+ agent đụng cùng file / kết luận trái ngược)
 *     KHÔNG throw — liệt kê vào `conflicts` để agent cha tự phân xử.
 *   - Merged summary đếm succeeded/failed + tổng token — parent đọc 1 chỗ.
 *
 * Cap bảo vệ: tối đa 4 task/lần (nhất quán DELEGATE_PRE-FLIGHT của goal-loop —
 * sub-agent có budget riêng 40k token/lần; 4 song song ≈ trần hợp lý).
 */
export async function dispatchAgentsParallel(params: {
  tasks: Array<{ agent: string; task: string; context?: string }>
  parentAgentName?: string
  sessionId?: string | null
  /** REVIEW 9-fix (2026-08-30) #5 — runId cha: mọi sub-agent trong fan-out
   * gắn parentRunId trên AgentRunRecord (query theo run cha hoạt động đủ đường). */
  parentRunId?: string | null
}): Promise<{
  success: boolean
  mode: 'fan_out'
  total: number
  succeeded: number
  failed: number
  tokensUsed: number
  results: Array<{
    agent: string
    success: boolean
    report: string
    tokensUsed: number
    toolCalls: number
    endedBy: string
    error?: string
    evaluation?: { pass: boolean; confidence: number; gaps: string[]; note: string }
  }>
  conflicts: string[]
  merged: string
}> {
  const { tasks, parentAgentName = 'Omega', sessionId = null, parentRunId = null } = params
  const MAX_PARALLEL = 4
  const valid = (Array.isArray(tasks) ? tasks : [])
    .filter(t => t && typeof t.agent === 'string' && t.agent.trim() && typeof t.task === 'string' && t.task.trim())
    .slice(0, MAX_PARALLEL)

  if (valid.length === 0) {
    return {
      success: false, mode: 'fan_out', total: 0, succeeded: 0, failed: 0, tokensUsed: 0,
      results: [], conflicts: [],
      merged: 'Không có task hợp lệ — mỗi task cần {"agent": "TÊN", "task": "nhiệm vụ cụ thể"} (tối đa 4 task/lần).',
    }
  }

  console.log(`[OmegaOrchestrator] FAN-OUT: ${valid.length} sub-agent chạy song song (${valid.map(t => t.agent).join(', ')}) theo yêu cầu của ${parentAgentName}`)

  // FAN-OUT — mọi dispatch chạy đồng thời; allSettled đảm bảo không cái nào
  // throw ra ngoài (reject → đổi thành outcome fail của chính nó).
  // (Token KHÔNG đếm qua callback — tổng tokensUsed trả về trong result để
  // caller đếm đúng 1 lần, tránh double-count ở goal-loop processToolResult.)
  const settled = await Promise.allSettled(
    valid.map(t =>
      dispatchAgentByOmega({
        agent: t.agent,
        task: t.task,
        context: t.context,
        duration: 'task',
        parentAgentName,
        sessionId,
        parentRunId,
      }).then(r => ({ agent: t.agent, r })),
    ),
  )

  // FAN-IN — hợp nhất kết quả, KHÔNG throwError xung đột:
  let tokensUsed = 0
  let succeeded = 0
  const results: Array<{
    agent: string
    success: boolean
    report: string
    tokensUsed: number
    toolCalls: number
    endedBy: string
    error?: string
    evaluation?: { pass: boolean; confidence: number; gaps: string[]; note: string }
  }> = []
  const fileTouch = new Map<string, string[]>() // filePath → [agentName...]

  for (const s of settled) {
    if (s.status === 'rejected') {
      // Exception văng từ dispatch (đã hiếm — dispatchAgentByOmega fail-open)
      // → coi là 1 kết quả fail của agent đó, KHÔNG sập batch.
      const msg = s.reason instanceof Error ? s.reason.message : String(s.reason)
      results.push({ agent: '?', success: false, report: '', tokensUsed: 0, toolCalls: 0, endedBy: 'error', error: msg })
      continue
    }
    const { agent, r } = s.value
    tokensUsed += r.tokensUsed ?? 0
    if (r.success) succeeded++
    results.push({
      agent: r.agent || agent,
      success: r.success,
      report: r.report ?? '',
      tokensUsed: r.tokensUsed ?? 0,
      toolCalls: r.toolCalls ?? 0,
      endedBy: r.endedBy ?? '-',
      error: r.error,
      evaluation: r.evaluation,
    })
    // Heuristic phát hiện xung đột: 2+ sub-agent cùng nhắc 1 đường dẫn file
    // trong report → có thể ghi đè lẫn nhau — cảnh báo cho parent (không throw).
    const paths = (r.report ?? '').match(/[\w./-]+\.(?:ts|tsx|js|jsx|json|md|prisma|css)/g) ?? []
    for (const p of new Set(paths.slice(0, 40))) {
      const list = fileTouch.get(p) ?? []
      if (!list.includes(r.agent || agent)) list.push(r.agent || agent)
      fileTouch.set(p, list)
    }
  }

  const conflicts: string[] = []
  for (const [path, agents] of fileTouch) {
    if (agents.length > 1) {
      conflicts.push(`${agents.join(' + ')} cùng đụng file "${path}" — kiểm tra file cuối cùng có đủ ý đồ của cả 2 không`)
    }
  }

  const failed = results.length - succeeded
  const summaryLines = [
    `FAN-OUT ${results.length} sub-agent song song — ${succeeded} đạt / ${failed} chưa đạt · ${tokensUsed} tokens${conflicts.length > 0 ? ` · ⚠️ ${conflicts.length} xung đột tiềm năng` : ''}`,
    ...results.map(r =>
      `${r.success ? '✅' : '❌'} ${r.agent}: ${(r.error && !r.report ? r.error : (r.report || r.error || '(không có báo cáo)')).slice(0, 600)}${r.report && r.error ? `\n   ⚠️ ${r.error.slice(0, 200)}` : ''}`,
    ),
  ]
  if (conflicts.length > 0) {
    summaryLines.push(`⚠️ XUNG ĐỘT (không chặn — parent tự phân xử): ${conflicts.slice(0, 5).join(' | ')}`)
  }

  console.log(`[OmegaOrchestrator] FAN-IN: ${succeeded}/${results.length} đạt, ${conflicts.length} xung đột tiềm năng, ${tokensUsed} tokens`)

  return {
    success: failed === 0,
    mode: 'fan_out',
    total: results.length,
    succeeded,
    failed,
    tokensUsed,
    results,
    conflicts,
    merged: summaryLines.join('\n\n').slice(0, 6000),
  }
}
