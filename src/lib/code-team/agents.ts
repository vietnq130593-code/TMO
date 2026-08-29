/**
 * Code Team — Agent Definitions + Seed Logic
 *
 * 5 Agents hardcoded — thiết lập cứng cho Code Team.
 * Clone GitHub về chạy local → Code Team luôn đầy đủ.
 *
 * Positions: TL (APEX), G1 (CORTEX), G2-A (BOLT), G2-B (SENTINEL), G3 (CATALYST)
 * Dynamic: "Kimi NHÌN & ĐIỀU HƯỚNG, DeepSeek THIẾT KẾ, Qwen XÂY, GLM SỬA, MiniMax TỐI ƯU"
 */

import { db } from '@/lib/db'
import { getAgentPrompt } from './prompts'

// ===== AGENT DEFINITION INTERFACE =====

export interface CodeTeamAgentDef {
  /** Unique key — dùng làm identifier, also AgentProfile.name */
  name: string
  description: string
  /** System prompt — loaded from prompts.ts via getAgentPrompt() */
  instruction: string
  domain: string
  capable: string
  provider: string
  model: string
  temperature: number
  maxTokens: number
  team: string
  /** TL | G1 | G2-A | G2-B | G3 */
  position: string
  avatar: string
  /** Tool permissions — used by workflow engine to define LLM tool calls */
  tools: string[]
}

// ===== 5 AGENTS HARDCODED =====

export const CODE_TEAM_AGENTS: CodeTeamAgentDef[] = [
  // ===== MODEL POLICY (updated 2026-08-27) =====
  // TẤT CẢ agents (kể cả agents độc lập) mặc định kimi-k3 (moonshotai/kimi-k3).
  // Các lõi khác (deepseek-v4-flash → minimax-m3) là BACKUP — tự kích hoạt qua
  // callLLMForAgent global-pool fallback khi kimi-k3 fail/rate-limit (xem llm.ts
  // callLLMForAgent Step 2). gpt-oss-120b đã bị bỏ khỏi Agent/Chat (user
  // directive 2026-08-27); GLM 5.2/5.3 không dùng được trên NIM (410/404).
  {
    name: 'APEX',
    description: 'TL — Nhìn & Điều hướng. Phân tích yêu cầu, chọn routing, code UI (Fast Track), verify kết quả.',
    instruction: '', // Loaded dynamically from getAgentPrompt('TL')
    domain: 'programming',
    capable: 'Phân tích thị giác, routing decision, code UI/UX, verify kết quả, điều phối team',
    provider: 'nvidia',
    model: 'moonshotai/kimi-k3',
    temperature: 0.5,
    maxTokens: 32768, // 21-d: nâng cap để agent viết file lớn (file_write append) — cap không phải target
    team: 'code',
    position: 'TL',
    avatar: '👑',
    tools: ['opencode', 'knowledge_search', 'tavily', 'serper', 'jina', 'file_read', 'file_edit', 'file_multi_edit', 'file_write', 'file_delete', 'file_list', 'grep', 'run_tests', 'git_commit', 'git_push', 'git_pull', 'get_diagnostics', 'decompose_task', 'create_task', 'update_task', 'get_plan', 'summarize', 'synthesize', 'run_bg', 'read_output', 'kill_process', 'manage_packages', 'gateway_tool', 'shell', 'todo_write', 'todo_read', 'web_search', 'web_fetch', 'lsp_diagnostics', 'lint', 'type_check', 'db_query', 'exit_plan_mode', 'cron', 'start_preview', 'stop_preview', 'get_app_runtime_status', 'open_workspace', 'verify_and_push', 'create_custom_tool', 'delete_custom_tool', 'list_custom_tools', 'escalate_problem'],
  },
  {
    name: 'CORTEX',
    description: 'G1 — Thiết kế kiến trúc. TL mô tả WHAT → G1 thiết kế HOW. DB Schema, API Design, Component Tree.',
    instruction: '',
    domain: 'programming',
    capable: 'Thiết kế kiến trúc, DB schema, API design, component tree, state management, security architecture',
    provider: 'nvidia',
    model: 'moonshotai/kimi-k3',
    temperature: 0.4,
    maxTokens: 32768, // 21-d: nâng cap để agent viết file lớn (file_write append) — cap không phải target
    team: 'code',
    position: 'G1',
    avatar: '🧠',
    tools: ['knowledge_search', 'knowledge_graph', 'tavily', 'serper', 'jina', 'file_read', 'file_list', 'grep', 'get_diagnostics', 'decompose_task', 'create_task', 'update_task', 'get_plan', 'summarize', 'synthesize', 'gateway_tool', 'shell', 'todo_write', 'todo_read', 'web_search', 'web_fetch', 'lsp_diagnostics', 'lint', 'type_check', 'test_coverage', 'db_query', 'create_custom_tool', 'delete_custom_tool', 'list_custom_tools', 'escalate_problem'],
  },
  {
    name: 'BOLT',
    description: 'G2-A — Code Execution. Nhận arch spec → Code → Notes → Báo cáo.',
    instruction: '',
    domain: 'programming',
    capable: 'Code TypeScript/React/Next.js, implement API, database operations, error handling',
    provider: 'nvidia',
    model: 'moonshotai/kimi-k3',
    temperature: 0.3,
    maxTokens: 32768, // 21-d: nâng cap để agent viết file lớn (file_write append) — cap không phải target
    team: 'code',
    position: 'G2-A',
    avatar: '⚡',
    tools: ['opencode', 'knowledge_search', 'file_read', 'file_edit', 'file_multi_edit', 'file_write', 'file_delete', 'file_list', 'grep', 'run_tests', 'git_commit', 'git_push', 'git_pull', 'get_diagnostics', 'run_bg', 'read_output', 'kill_process', 'manage_packages', 'gateway_tool', 'shell', 'todo_write', 'todo_read', 'web_search', 'web_fetch', 'gateway_exec', 'gateway_read', 'gateway_write', 'gateway_edit', 'gateway_apply_patch', 'lsp_diagnostics', 'lint', 'type_check', 'test_coverage', 'browser_screenshot', 'mcp_call', 'start_preview', 'stop_preview', 'get_app_runtime_status', 'create_custom_tool', 'delete_custom_tool', 'list_custom_tools', 'escalate_problem'],
  },
  {
    name: 'SENTINEL',
    description: 'G2-B — Review & Bug Fix. 5 loại bug (Security #1), max 3 vòng iteration, ESCALATE khi cần.',
    instruction: '',
    domain: 'security',
    capable: 'Code review, tìm bugs, kiểm tra security, fix bugs, iterative refinement',
    provider: 'nvidia',
    model: 'moonshotai/kimi-k3',
    temperature: 0.2,
    maxTokens: 32768, // 21-d: nâng cap để agent viết file lớn (file_write append) — cap không phải target
    team: 'code',
    position: 'G2-B',
    avatar: '🛡️',
    tools: ['opencode', 'knowledge_search', 'file_read', 'file_edit', 'file_write', 'file_list', 'grep', 'get_diagnostics', 'run_tests', 'gateway_tool', 'shell', 'todo_write', 'todo_read', 'web_search', 'web_fetch', 'gateway_exec', 'gateway_read', 'gateway_edit', 'lsp_diagnostics', 'lint', 'type_check', 'browser_screenshot', 'create_custom_tool', 'delete_custom_tool', 'list_custom_tools', 'escalate_problem'],
  },
  {
    name: 'CATALYST',
    description: 'G3 — Optimization. 5 lĩnh vực tối ưu, Self-evolving KB, kết nối UI+Backend (Hybrid).',
    instruction: '',
    domain: 'programming',
    capable: 'Tối ưu performance, refactor code, scalability, best practices, UI+Backend integration',
    provider: 'nvidia',
    model: 'moonshotai/kimi-k3',
    temperature: 0.3,
    maxTokens: 32768, // 21-d: nâng cap để agent viết file lớn (file_write append) — cap không phải target
    team: 'code',
    position: 'G3',
    avatar: '🔧',
    tools: ['opencode', 'knowledge_search', 'knowledge_graph', 'knowledge_write', 'file_read', 'file_edit', 'file_multi_edit', 'file_write', 'file_delete', 'file_list', 'grep', 'run_tests', 'git_commit', 'git_push', 'git_pull', 'get_diagnostics', 'summarize', 'synthesize', 'run_bg', 'read_output', 'kill_process', 'gateway_tool', 'shell', 'todo_write', 'todo_read', 'web_search', 'web_fetch', 'gateway_exec', 'gateway_read', 'gateway_write', 'gateway_edit', 'gateway_apply_patch', 'lsp_diagnostics', 'lint', 'type_check', 'test_coverage', 'db_query', 'mcp_call', 'exit_plan_mode', 'cron', 'start_preview', 'stop_preview', 'get_app_runtime_status', 'verify_and_push', 'create_custom_tool', 'delete_custom_tool', 'list_custom_tools', 'escalate_problem'],
  },
]

// ===== SEED LOGIC =====
// Idempotent — chạy khi app startup hoặc lazy khi GET /api/agents
// Đảm bảo 5 agents LUÔN tồn tại — clone GitHub về vẫn đủ

let seedPromise: Promise<boolean> | null = null
let seedCompleted = false

/**
 * Reset seed state — allows re-running ensureCodeTeamAgents()
 * Called after forceReseedCodeTeam() to allow next ensureCodeTeamAgents() to run fresh
 */
export function resetSeedState(): void {
  seedPromise = null
  seedCompleted = false
}

/**
 * Ensure Code Team agents exist in DB.
 *
 * CRITICAL DESIGN DECISION (from critical-issues-resolution.md):
 *   This function is called by GET /api/agents — it acts as a "soft ensure" that
 *   ONLY creates agents if they don't exist. It does NOT overwrite user customizations.
 *
 *   - If agent already exists by name → SKIP (preserve ALL user customizations)
 *   - If agent doesn't exist → create with isSystem=false (user CAN delete/customize)
 *
 *   This is DIFFERENT from the old auto-seeding (Task 13) which used isSystem=true
 *   and overwrote instructions. The new design respects user autonomy.
 *
 *   The Agent Resolution Layer (agent-resolver.ts) also creates agents with isSystem=false
 *   when the workflow needs them (lazy seeding). Both paths create deletable agents.
 *
 * - Idempotent — safe to call multiple times, cached promise
 * - After first SUCCESSFUL run, becomes no-op (use forceReseedCodeTeam for full reset)
 * - FIX 2026-09-09 (bug "local không load agents"): trước đây seedCompleted
 *   được set TRUE ngay cả khi _doSeed có agent fail (vd DB schema drift) —
 *   comment nói "cho retry" nhưng code không làm vậy → sau khi DB được heal,
 *   seeds KHÔNG BAO GIỜ chạy lại trong cùng process. Giờ: chỉ đánh dấu hoàn
 *   thành khi KHÔNG có lỗi; có lỗi → lần gọi kế tiếp retry (vd sau self-heal).
 */
export async function ensureCodeTeamAgents(): Promise<void> {
  if (seedCompleted) return
  if (!seedPromise) {
    seedPromise = _doSeed()
  }
  const hadFailures = await seedPromise
  seedPromise = null
  if (hadFailures) return // seedCompleted giữ false → retry ở lần gọi sau
  seedCompleted = true
}

async function _doSeed(): Promise<boolean> {
  console.log('[CodeTeam] Checking Code Team agents...')
  let created = 0
  let skipped = 0
  let failedAgents = 0

  for (const def of CODE_TEAM_AGENTS) {
    try {
      const existing = await db.agentProfile.findUnique({ where: { name: def.name } })

      if (existing) {
        // Agent exists → SKIP entirely (preserve ALL user customizations)
        // This is the key difference from old auto-seeding:
        //   - Old: Overwrote instruction + forced isSystem=true
        //   - New: Skip — user may have customized instruction, provider, model, etc.
        skipped++
        console.log(`[CodeTeam] Agent already exists: ${def.name} (${def.position}) — skipping, user customizations preserved`)
      } else {
        // Agent doesn't exist → create with isSystem=false
        // CRITICAL: isSystem=false means user CAN delete/customize from UI
        // This matches the Agent Resolution Layer design (agent-resolver.ts)
        const prompt = getAgentPrompt(def.position)
        await db.agentProfile.create({
          data: {
            name: def.name,
            description: def.description,
            instruction: prompt,
            domain: def.domain,
            capable: def.capable,
            provider: def.provider,
            model: def.model,
            temperature: def.temperature,
            maxTokens: def.maxTokens,
            team: def.team,
            position: def.position,
            avatar: def.avatar,
            isSystem: false,  // ← User CAN delete — matches Agent Resolution Layer design
            enabled: true,
          },
        })
        created++
        console.log(`[CodeTeam] Created agent: ${def.name} (${def.position}) [isSystem=false]`)
      }
    } catch (err) {
      failedAgents++
      console.error(`[CodeTeam] Failed to seed ${def.name}:`, err)
    }
  }

  if (failedAgents > 0) {
    console.warn(`[CodeTeam] ⚠️ ${failedAgents}/${CODE_TEAM_AGENTS.length} agents failed to seed — will retry on next ensureCodeTeamAgents() call`)
    return true
  }

  console.log(`[CodeTeam] Agents check complete: ${created} created, ${skipped} already existed`)
  return false
}

/**
 * Force re-seed — reset ALL fields to defaults from agents.ts + prompts.ts
 * Useful when prompts are updated AND user wants to reset customizations
 * WARNING: This overwrites user customizations (provider, model, temperature, etc.)
 */
export async function forceReseedCodeTeam(): Promise<{ updated: number; created: number }> {
  let updated = 0
  let created = 0

  for (const def of CODE_TEAM_AGENTS) {
    try {
      const prompt = getAgentPrompt(def.position)
      const existing = await db.agentProfile.findUnique({ where: { name: def.name } })

      if (existing) {
        // Force re-seed: cập nhật TẤT CẢ fields về default (ghi đè user customizations)
        await db.agentProfile.update({
          where: { id: existing.id },
          data: {
            instruction: prompt,
            description: def.description,
            capable: def.capable,
            provider: def.provider,
            model: def.model,
            temperature: def.temperature,
            maxTokens: def.maxTokens,
            position: def.position,
            team: def.team,
            avatar: def.avatar,
            isSystem: true,
            enabled: true,
          },
        })
        updated++
      } else {
        await db.agentProfile.create({
          data: {
            name: def.name,
            description: def.description,
            instruction: prompt,
            domain: def.domain,
            capable: def.capable,
            provider: def.provider,
            model: def.model,
            temperature: def.temperature,
            maxTokens: def.maxTokens,
            team: def.team,
            position: def.position,
            avatar: def.avatar,
            isSystem: true,
            enabled: true,
          },
        })
        created++
      }
    } catch (err) {
      console.error(`[CodeTeam] Failed to reseed ${def.name}:`, err)
    }
  }

  return { updated, created }
}

// ===== HELPERS =====

/** Get agent definition by position (TL, G1, G2-A, G2-B, G3) */
export function getAgentByPosition(position: string): CodeTeamAgentDef | undefined {
  return CODE_TEAM_AGENTS.find(a => a.position === position)
}

/** Get tool permissions for agent by position */
export function getAgentTools(position: string): string[] {
  const agent = getAgentByPosition(position)
  return agent?.tools || []
}

/** Get agent name by position */
export function getAgentName(position: string): string {
  const agent = getAgentByPosition(position)
  return agent?.name || position
}

/** Get all positions in order */
export function getPositionsInOrder(): string[] {
  return ['TL', 'G1', 'G2-A', 'G2-B', 'G3']
}

/** Get pipeline for a given tier */
export function getPipelineForTier(tier: number): string[] {
  switch (tier) {
    case 1: return ['TL', 'G2-B', 'TL']
    case 2: return ['TL', 'G1', 'G2-A', 'G2-B', 'TL']
    case 3: return ['TL', 'G1', 'G2-A', 'G2-B', 'G3', 'TL']
    default: return ['TL', 'G1', 'G2-A', 'G2-B', 'G3', 'TL']
  }
}

/** Get pipeline for a given mode + tier combination
 *
 * Mode A (Pure Visual): TL→TL→G2-B→TL — TL codes UI, self-verify, G2-B review, TL final verify
 * Mode B (Pure Backend): Uses tier pipeline directly — TL only analyzes + verifies
 * Mode C (Hybrid): TL codes UI first, then backend pipeline WITH G3 (integration)
 *   → G3 ALWAYS included in Mode C regardless of tier (G3 does UI↔Backend integration)
 */
export function getPipelineForMode(mode: 'A' | 'B' | 'C', tier: number): string[] {
  if (mode === 'A') {
    // Pure Visual: TL→TL→TL→G2-B→TL (ANALYZE, CODE, SELF-VERIFY, G2-B review, TL final verify)
    return ['TL', 'TL', 'TL', 'G2-B', 'TL']
  }

  if (mode === 'C') {
    // Hybrid: TL codes UI → backend pipeline → G3 integration → TL verify
    // G3 LUÔN có mặt vì G3 làm integration UI↔Backend (workflow doc: "G3 kết nối UI+Backend")
    switch (tier) {
      case 1: return ['TL', 'TL', 'G2-B', 'G3', 'TL']
      case 2: return ['TL', 'TL', 'G1', 'G2-A', 'G2-B', 'G3', 'TL']
      case 3: return ['TL', 'TL', 'G1', 'G2-A', 'G2-B', 'G3', 'TL']
      default: return ['TL', 'TL', 'G1', 'G2-A', 'G2-B', 'G3', 'TL']
    }
  }

  // Mode B (Pure Backend): standard tier pipeline — TL only analyzes + verifies
  return getPipelineForTier(tier)
}

/**
 * Auto-seed MCPBridgeConfig + KnowledgeAccessPolicy
 * Called after ensureCodeTeamAgents to ensure these configs exist.
 * Prevents data loss when running locally (no manual setup needed).
 */
export async function ensureMCPBridgeConfig(): Promise<void> {
  try {
    const existing = await db.mCPBridgeConfig.count()
    if (existing > 0) return // already seeded

    const configs = [
      { direction: 'outbound', toolName: 'knowledge_search', enabled: true },
      { direction: 'outbound', toolName: 'knowledge_graph', enabled: true },
      { direction: 'outbound', toolName: 'knowledge_write', enabled: true },
      { direction: 'outbound', toolName: 'web_search', enabled: true },
      { direction: 'inbound', toolName: 'file_read', enabled: true },
      { direction: 'inbound', toolName: 'file_edit', enabled: true },
      { direction: 'inbound', toolName: 'bash_exec', enabled: true },
      { direction: 'inbound', toolName: 'lsp_diag', enabled: true },
      { direction: 'inbound', toolName: 'fetch_url', enabled: true },
    ]

    for (const c of configs) {
      await db.mCPBridgeConfig.create({ data: c })
    }

    // Knowledge Access Policy
    await db.knowledgeAccessPolicy.create({
      data: {
        agentId: 'default',
        allowRead: true,
        allowWrite: true,
        allowDelete: false,
        allowedCollections: 'theopus_documents,theopus_chunks',
        allowedLabels: '*',
      },
    })

    console.log(`[Seed] MCPBridgeConfig: ${configs.length} configs + 1 KnowledgeAccessPolicy created`)
  } catch (err) {
    console.warn('[Seed] MCPBridgeConfig seed failed:', err instanceof Error ? err.message : String(err))
  }
}
