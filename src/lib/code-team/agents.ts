/**
 * Code Team — Agent Definitions + Seed Logic
 *
 * 5 Agents hardcoded — thiết lập cứng cho Code Team.
 * Clone GitHub về chạy local → Code Team luôn đầy đủ.
 *
 * Positions: TL (MEGATRON), G1 (SHOCWAVE), G2-A (RAMPAGE), G2-B (SENTINEL), G3 (CATALYST)
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
  // ===== MODEL POLICY (updated 2026-10-16 — USER DIRECTIVE: minimax-m3 tạm
  // làm lõi chính cho TẤT CẢ agents — duy nhất khả dụng) =====
  // Matrix test 09:11 UTC 2026-10-16 (HTTP trực tiếp NIM, 4 key): kimi-k3 +
  // ds-v4-pro + ds-v4-flash đều HANG (60s, 0 bytes) — 0/4 key; minimax-m3
  // 4/4 key OK (6-44s). Toàn bộ agents (MEGATRON, SHOCWAVE, RAMPAGE, SENTINEL,
  // CATALYST) mặc định minimax-m3; 3 lõi cũ xuống chuỗi fallback
  // (kimi-k3 → ds-pro → ds-flash) — NIM hồi thì fallback tự dùng lại.
  // Runtime callLLMForAgent enforce AGENT_PRIMARY_MODEL (llm.ts) — model ở
  // đây giữ đồng bộ hiển thị UI + legacy path.
  // gpt-oss-120b đã bị bỏ khỏi Agent/Chat (user directive 2026-08-27); GLM
  // 5.2/5.3 không dùng được trên NIM (410/404).
  {
    name: 'MEGATRON',
    description: 'TL — Nhìn & Điều hướng. Phân tích yêu cầu, chọn routing, code UI (Fast Track), verify kết quả.',
    instruction: '', // Loaded dynamically from getAgentPrompt('TL')
    domain: 'programming',
    capable: 'Phân tích thị giác, routing decision, code UI/UX, verify kết quả, điều phối team',
    provider: 'zen',
    // PHIÊN 7 (Task 37 — 2026-10-28, user directive): TẤT CẢ agents dùng
    // space-bunny-free — model free DUY NHẤT còn mở cho oc_sk API key sau
    // policy Zen ~25-26/09 (nemotron-ultra/muse-spark → 403 FreeTierError).
    model: 'space-bunny-free',
    temperature: 0.5,
    // TASK 39 (phiên 8) — maxTokens = -1 = KHÔNG GIỚI HẠN (callZenProvider omit
    // max_tokens → model output tối đa 512k) — user directive "agents dùng lượng
    // token tùy ý"; reasoning max + file lớn không còn bị cắt cụt giữa JSON.
    maxTokens: -1,
    team: 'code',
    position: 'TL',
    avatar: '👑',
    tools: ['opencode', 'knowledge_search', 'tavily', 'serper', 'jina', 'file_read', 'file_edit', 'file_multi_edit', 'file_write', 'file_delete', 'file_list', 'grep', 'run_tests', 'git_commit', 'git_push', 'git_pull', 'get_diagnostics', 'decompose_task', 'create_task', 'update_task', 'get_plan', 'summarize', 'synthesize', 'run_bg', 'read_output', 'kill_process', 'manage_packages', 'gateway_tool', 'shell', 'todo_write', 'todo_read', 'web_search', 'web_fetch', 'lsp_diagnostics', 'lint', 'type_check', 'db_query', 'exit_plan_mode', 'cron', 'start_preview', 'stop_preview', 'get_app_runtime_status', 'open_workspace', 'verify_and_push', 'create_custom_tool', 'delete_custom_tool', 'list_custom_tools', 'escalate_problem',
      // Task 42 (user audit Playwright): TL cần browser_screenshot để verify UI
      // tại checkpoint (start_preview → chụp http://127.0.0.1:<port>) thay vì
      // chỉ đọc worklog — evidence trực quan cho quyết định CONTINUE/PIVOT.
      'browser_screenshot',
      // CI-4 B3-B5 (Task 11-c) — structured git tools: khảo sát repo + branch/clone.
      // MEGATRON (TL) có đủ 5 tool — điều phối và tự verify.
      'git_status', 'git_diff', 'git_log', 'git_branch', 'git_clone',
      // CI-3 B3 (Task 13-b) — Kho Context: truy hồi digest đã nén của run trước.
      'context_recall',
      // DELEGATION CONTRACT (fix 2026-09-12 — gap so với quy trình orchestrator:
      // Code Team pipeline không có delegation động): TL (MEGATRON) được cấp
      // delegate_task — giữa pipeline step, khi nhận thấy 1 phần việc phức tạp
      // cần chuyên trách, TL giao cho SHOCWAVE/RAMPAGE/SENTINEL/CATALYST (sub-agent
      // chạy mini-loop có plan-first + acceptance criteria + self-verify, trả
      // báo cáo nén). Depth-guard strip tool này khỏi sub-agent → không đệ quy.
      // Chỉ TL có (orchestrator role) — G1-G3 dùng escalate_problem khi cần giúp.
      'delegate_task',
      // SKILL ACCESS (fix 2026-09-12 — user report "71 tools + 68 skills nhưng
      // agents không dùng được"): mọi Code Team agents tự liệt kê/đọc 68
      // filesystem skills qua list_skills/read_skill (trước đây CHỈ Omega có —
      // 5 agents này không tài nguyên nào dùng được skill registry).
      'list_skills', 'read_skill',
      // AUTOMATION PROPOSAL (user request 2026-09-13): MEGATRON thấy cần cron job /
      // webhook / standing order / task flow → đề xuất với Omega qua
      // propose_automation — Omega quyết định forward vào Self-direction chờ
      // Mr. Architect / agent được ủy quyền phê duyệt. (MEGATRON có tool `cron` nhưng
      // đó là mini-service riêng flag-gated; propose_automation là luồng chuẩn.)
      'propose_automation'],
  },
  {
    name: 'SHOCWAVE',
    description: 'G1 — Thiết kế kiến trúc. TL mô tả WHAT → G1 thiết kế HOW. DB Schema, API Design, Component Tree.',
    instruction: '',
    domain: 'programming',
    capable: 'Thiết kế kiến trúc, DB schema, API design, component tree, state management, security architecture',
    provider: 'zen',
    // PHIÊN 7 (Task 37): TẤT CẢ agents = space-bunny-free (xem note MEGATRON).
    model: 'space-bunny-free',
    temperature: 0.4,
    // TASK 39 (phiên 8) — -1 = unlimited (xem note MEGATRON).
    maxTokens: -1,
    team: 'code',
    position: 'G1',
    avatar: '🧠',
    tools: ['knowledge_search', 'knowledge_graph', 'tavily', 'serper', 'jina', 'file_read', 'file_list', 'grep', 'get_diagnostics', 'decompose_task', 'create_task', 'update_task', 'get_plan', 'summarize', 'synthesize', 'gateway_tool', 'shell', 'todo_write', 'todo_read', 'web_search', 'web_fetch', 'lsp_diagnostics', 'lint', 'type_check', 'test_coverage', 'db_query', 'create_custom_tool', 'delete_custom_tool', 'list_custom_tools', 'escalate_problem',
      // SKILL ACCESS (fix 2026-09-12) — xem note MEGATRON phía trên.
      'list_skills', 'read_skill',
      // AUTOMATION PROPOSAL (2026-09-13) — xem note MEGATRON phía trên.
      'propose_automation'],
  },
  {
    name: 'RAMPAGE',
    description: 'G2-A — Code Execution. Nhận arch spec → Code → Notes → Báo cáo.',
    instruction: '',
    domain: 'programming',
    capable: 'Code TypeScript/React/Next.js, implement API, database operations, error handling',
    provider: 'zen',
    // PHIÊN 7 (Task 37): TẤT CẢ agents = space-bunny-free (xem note MEGATRON).
    model: 'space-bunny-free',
    temperature: 0.3,
    // TASK 39 (phiên 8) — -1 = unlimited (xem note MEGATRON).
    maxTokens: -1,
    team: 'code',
    position: 'G2-A',
    avatar: '⚡',
    tools: ['opencode', 'knowledge_search', 'file_read', 'file_edit', 'file_multi_edit', 'file_write', 'file_delete', 'file_list', 'grep', 'run_tests', 'git_commit', 'git_push', 'git_pull', 'git_status', 'git_diff', 'git_log', 'git_branch', 'get_diagnostics', 'run_bg', 'read_output', 'kill_process', 'manage_packages', 'gateway_tool', 'shell', 'todo_write', 'todo_read', 'web_search', 'web_fetch', 'gateway_exec', 'gateway_read', 'gateway_write', 'gateway_edit', 'gateway_apply_patch', 'lsp_diagnostics', 'lint', 'type_check', 'test_coverage', 'browser_screenshot', 'mcp_call', 'start_preview', 'stop_preview', 'get_app_runtime_status', 'create_custom_tool', 'delete_custom_tool', 'list_custom_tools', 'escalate_problem',
      // CI-3 B3 (Task 13-b) — Kho Context: truy hồi digest đã nén của run trước.
      'context_recall',
      // SKILL ACCESS (fix 2026-09-12) — xem note MEGATRON phía trên.
      'list_skills', 'read_skill',
      // AUTOMATION PROPOSAL (2026-09-13) — xem note MEGATRON phía trên.
      'propose_automation'],
  },
  {
    name: 'SENTINEL',
    description: 'G2-B — Review & Bug Fix. 5 loại bug (Security #1), max 5 vòng iteration (engine cap — audit 2026-09-15 #10: đồng bộ text với runtime thực tế), ESCALATE khi cần.',
    instruction: '',
    domain: 'security',
    capable: 'Code review, tìm bugs, kiểm tra security, fix bugs, iterative refinement',
    provider: 'zen',
    // TASK 33 (2026-09-27 — user directive): SENTINEL là 1 trong 2 agent CHUYÊN
    // DEBUG (cùng LISMA của research team) → dùng space-bunny-free (stealth
    // reasoning model, ctx 1M/out 512k, effort max) thay vì muse-spark.
    model: 'space-bunny-free',
    temperature: 0.2,
    // TASK 39 (phiên 8) — -1 = unlimited (xem note MEGATRON).
    maxTokens: -1,
    team: 'code',
    position: 'G2-B',
    avatar: '🛡️',
    tools: ['opencode', 'knowledge_search', 'file_read', 'file_edit', 'file_write', 'file_list', 'grep', 'get_diagnostics', 'run_tests',
      // CI-4 B3-B5 (Task 11-c) — SENTINEL (review) chỉ cần read-only git tools
      // để khảo sát repo trước khi review/fix — KHÔNG có branch/clone/commit.
      'git_status', 'git_diff', 'git_log',
      // CI-3 B3 (Task 13-b) — Kho Context: đọc lại digest run trước khi review.
      'context_recall',
      'gateway_tool', 'shell', 'todo_write', 'todo_read', 'web_search', 'web_fetch', 'gateway_exec', 'gateway_read', 'gateway_edit', 'lsp_diagnostics', 'lint', 'type_check', 'browser_screenshot', 'create_custom_tool', 'delete_custom_tool', 'list_custom_tools', 'escalate_problem',
      // SKILL ACCESS (fix 2026-09-12) — xem note MEGATRON phía trên.
      'list_skills', 'read_skill',
      // AUTOMATION PROPOSAL (2026-09-13) — xem note MEGATRON phía trên.
      'propose_automation'],
  },
  {
    name: 'CATALYST',
    description: 'G3 — Optimization. 5 lĩnh vực tối ưu, Self-evolving KB, kết nối UI+Backend (Hybrid).',
    instruction: '',
    domain: 'programming',
    capable: 'Tối ưu performance, refactor code, scalability, best practices, UI+Backend integration',
    provider: 'zen',
    // PHIÊN 7 (Task 37): TẤT CẢ agents = space-bunny-free (xem note MEGATRON).
    model: 'space-bunny-free',
    temperature: 0.3,
    // TASK 39 (phiên 8) — -1 = unlimited (xem note MEGATRON).
    maxTokens: -1,
    team: 'code',
    position: 'G3',
    avatar: '🔧',
    tools: ['opencode', 'knowledge_search', 'knowledge_graph', 'knowledge_write', 'file_read', 'file_edit', 'file_multi_edit', 'file_write', 'file_delete', 'file_list', 'grep', 'run_tests', 'git_commit', 'git_push', 'git_pull', 'git_status', 'git_diff', 'git_log', 'git_branch', 'get_diagnostics', 'summarize', 'synthesize', 'run_bg', 'read_output', 'kill_process', 'gateway_tool', 'shell', 'todo_write', 'todo_read', 'web_search', 'web_fetch', 'gateway_exec', 'gateway_read', 'gateway_write', 'gateway_edit', 'gateway_apply_patch', 'lsp_diagnostics', 'lint', 'type_check', 'test_coverage', 'db_query', 'mcp_call', 'exit_plan_mode', 'cron', 'start_preview', 'stop_preview', 'get_app_runtime_status', 'verify_and_push', 'create_custom_tool', 'delete_custom_tool', 'list_custom_tools', 'escalate_problem',
      // CI-3 B3 (Task 13-b) — Kho Context: truy hồi digest đã nén của run trước.
      'context_recall',
      // SKILL ACCESS (fix 2026-09-12) — xem note MEGATRON phía trên.
      'list_skills', 'read_skill',
      // AUTOMATION PROPOSAL (2026-09-13) — xem note MEGATRON phía trên.
      'propose_automation'],
  },
  {
    // TASK 43 (user audit "launch full-stack-developer subagent") — FORGE là
    // builder tổng lực FULL-STACK: nhận spec trọn gói → tự chủ triển khai
    // END-TO-END (UI + API + DB + kiểm định + preview), khác RAMPAGE (G2-A
    // thuần implement theo arch spec của G1). Vị trí 'FS' KHÔNG nằm trong
    // getPositionsInOrder()/pipeline tier-mode → workflow SOP giữ nguyên 5
    // vị trí cũ; FORGE chỉ được gọi qua delegate_task/dispatch_agent (sub-agent
    // mini-loop) — đúng semantics "launch full-stack-developer subagent".
    name: 'FORGE',
    description: 'FS — Full-Stack Developer. Builder tổng lực: nhận spec trọn gói → tự chủ triển khai end-to-end (UI + API + DB + kiểm định + preview verify).',
    instruction: '', // Loaded dynamically from getAgentPrompt('FS')
    domain: 'programming',
    capable: 'Full-stack Next.js/React/UI components, API routes, Prisma database schema, end-to-end feature delivery, tự kiểm định (lint/type_check/run_tests), chạy preview + browser verify',
    provider: 'zen',
    // PHIÊN 7 (Task 37): TẤT CẢ agents = space-bunny-free (xem note MEGATRON).
    model: 'space-bunny-free',
    temperature: 0.3,
    // TASK 39 (phiên 8) — -1 = unlimited (xem note MEGATRON).
    maxTokens: -1,
    team: 'code',
    position: 'FS',
    avatar: '🦾',
    // Toolset = RAMPAGE (builder) + mở rộng full-stack: knowledge_graph, summarize/
    // synthesize (tổng hợp spec), db_query (Prisma), open_workspace + verify_and_push
    // (clone-first workflow), git đầy đủ. KHÔNG có delegate/dispatch (depth guard).
    tools: ['opencode', 'knowledge_search', 'knowledge_graph', 'file_read', 'file_edit', 'file_multi_edit', 'file_write', 'file_delete', 'file_list', 'grep', 'run_tests', 'git_commit', 'git_push', 'git_pull', 'git_status', 'git_diff', 'git_log', 'git_branch', 'get_diagnostics', 'summarize', 'synthesize', 'run_bg', 'read_output', 'kill_process', 'manage_packages', 'gateway_tool', 'shell', 'todo_write', 'todo_read', 'web_search', 'web_fetch', 'gateway_exec', 'gateway_read', 'gateway_write', 'gateway_edit', 'gateway_apply_patch', 'lsp_diagnostics', 'lint', 'type_check', 'test_coverage', 'db_query', 'browser_screenshot', 'mcp_call', 'start_preview', 'stop_preview', 'get_app_runtime_status', 'open_workspace', 'verify_and_push', 'create_custom_tool', 'delete_custom_tool', 'list_custom_tools', 'escalate_problem', 'context_recall', 'list_skills', 'read_skill', 'propose_automation'],
  },
]

// ===== AGENT RENAME MIGRATION (2026-10-16 — user directive) =====
// APEX → MEGATRON, CORTEX → SHOCWAVE, BOLT → RAMPAGE.
// TASK 48 (2026-11): RAVAGE → "Linh Sickyx" — ĐẶC BIỆT: ngoài rename, agent
// này còn TÁCH KHỎI Code Team (def đã xóa khỏi CODE_TEAM_AGENTS ở trên, định
// nghĩa mới sống ở standalone-agents.ts — team=null, position=null). Cặp đặt
// ở ĐÂY để rename + 4 bảng satellite chạy đúng cả khi code-team seed chạy
// trước standalone seed; normalization field (team/position/instruction) do
// _migrateRavageToLinhSickyx + safety-net sync của standalone seed đảm nhiệm
// (2 đường idempotent, hội tụ cùng kết quả).
//
// DB local đã seed tên CŨ từ commit trước → cần rename row (giữ nguyên toàn bộ
// customization: instruction/model/temperature/tools override...) + kéo theo
// các row keyed theo tên agent:
//   - ToolAssignment.agentKey        (tool-access override)
//   - SkillAssignment.agentKey       (skill gate — raw SQL, table không có Prisma model)
//   - AgentModelOverride.agentName   (override model per-agent)
//   - CronJob.executor               (cron job gán executor = tên agent)
// Các bảng HISTORY (CodeTeamWorklog/AutoLearnRecord/AgentMemory/...) KHÔNG đổi
// — đó là ghi chép quá khứ, giữ nguyên tên agent tại thời điểm chạy.
// Idempotent: chạy nhiều lần an toàn (lần 2 trở đi old-row không còn → no-op).

export const AGENT_RENAMES: Array<[oldName: string, newName: string]> = [
  ['APEX', 'MEGATRON'],
  ['CORTEX', 'SHOCWAVE'],
  ['BOLT', 'RAMPAGE'],
  // TASK 48 — RAVAGE (Task 47, code-team 'SEC') → "Linh Sickyx" (standalone
  // độc lập — xem standalone-agents.ts). Giữ ở đây để ToolAssignment/
  // SkillAssignment/AgentModelOverride/CronJob keyed 'RAVAGE' không mồ côi.
  ['RAVAGE', 'Linh Sickyx'],
]

let renameMigrated = false

async function _migrateAgentRenames(): Promise<void> {
  if (renameMigrated) return
  renameMigrated = true // chạy 1 lần/process — idempotent tại DB level
  for (const [oldName, newName] of AGENT_RENAMES) {
    try {
      const oldRow = await db.agentProfile.findUnique({ where: { name: oldName } })
      if (!oldRow) continue
      const newRow = await db.agentProfile.findUnique({ where: { name: newName } })
      if (newRow) {
        console.warn(`[CodeTeam] Rename migration SKIP: cả "${oldName}" lẫn "${newName}" đều tồn tại — giữ nguyên cả 2 (user tự tạo "${newName}"?)`)
        continue
      }
      // 1. AgentProfile — đổi tên, giữ mọi field khác (customization preserved)
      await db.agentProfile.update({ where: { id: oldRow.id }, data: { name: newName } })
      // 2. ToolAssignment (tool-access override keyed theo agentKey)
      try {
        await db.toolAssignment.updateMany({ where: { agentKey: oldName }, data: { agentKey: newName } })
      } catch (e) {
        console.warn(`[CodeTeam] ToolAssignment migration ${oldName}→${newName} lỗi (không chặn):`, e instanceof Error ? e.message : String(e))
      }
      // 3. SkillAssignment — raw SQL (pattern skill-access.ts: table không có Prisma model, schema-drift safe)
      try {
        await db.$executeRaw`UPDATE SkillAssignment SET agentKey = ${newName} WHERE agentKey = ${oldName}`
      } catch (e) {
        console.warn(`[CodeTeam] SkillAssignment migration ${oldName}→${newName} lỗi (không chặn — table có thể chưa tồn tại):`, e instanceof Error ? e.message : String(e))
      }
      // 4. AgentModelOverride (override model per-agent)
      try {
        await db.agentModelOverride.updateMany({ where: { agentName: oldName }, data: { agentName: newName } })
      } catch (e) {
        console.warn(`[CodeTeam] AgentModelOverride migration ${oldName}→${newName} lỗi (không chặn):`, e instanceof Error ? e.message : String(e))
      }
      // 5. CronJob.executor (cron gán executor = tên agent)
      try {
        await db.cronJob.updateMany({ where: { executor: oldName }, data: { executor: newName } })
      } catch (e) {
        console.warn(`[CodeTeam] CronJob executor migration ${oldName}→${newName} lỗi (không chặn):`, e instanceof Error ? e.message : String(e))
      }
      console.log(`[CodeTeam] Rename migration ✓ ${oldName} → ${newName} (AgentProfile + ToolAssignment + SkillAssignment + AgentModelOverride + CronJob.executor)`)
    } catch (err) {
      renameMigrated = false // lỗi → cho phép retry lần ensure sau
      console.warn(`[CodeTeam] Rename migration ${oldName} → ${newName} lỗi (sẽ retry):`, err instanceof Error ? err.message : String(err))
    }
  }
}

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
  // RENAME MIGRATION trước seed — DB cũ có tên APEX/CORTEX/BOLT → đổi sang
  // MEGATRON/SHOCWAVE/RAMPAGE trước khi vòng findUnique-by-name chạy (nếu
  // không, seed sẽ tạo row MỚI tên mới trong khi row cũ tên cũ còn nằm đó).
  await _migrateAgentRenames()
  let created = 0
  let skipped = 0
  let failedAgents = 0

  for (const def of CODE_TEAM_AGENTS) {
    try {
      const existing = await db.agentProfile.findUnique({ where: { name: def.name } })

      if (existing) {
        // TASK 33 (2026-09-27) — NIM→ZEN MIGRATION (chạy mỗi boot, idempotent):
        // rows còn sót provider NIM hoặc model NIM (kimi-k3/minimax-m3/deepseek/
        // nemotron-550b/gpt-oss — id NIM luôn chứa '/') là giá trị do CODE sync
        // hoặc DB cũ từ thời NIM, KHÔNG phải lựa chọn của user (user directive
        // 2026-09-27: NIM bỏ hoàn toàn khỏi tác vụ agents) → normalize về def
        // (provider zen + model zen theo vai trò). Model zen KHÁC user tự chọn →
        // GIỮ NGUYÊN (tôn trọng customization — chỉ sửa giá trị NIM sót).
        const isNimModelId = (m: string) => m.includes('/')
        if ((existing.provider !== 'zen' || isNimModelId(existing.model)) && (existing.provider !== def.provider || existing.model !== def.model)) {
          try {
            await db.agentProfile.update({
              where: { id: existing.id },
              data: { provider: def.provider, model: def.model },
            })
            console.log(`[CodeTeam] NIM→Zen sync: ${def.name} ${existing.provider}/${existing.model} → ${def.provider}/${def.model} (Task 33 — NIM removed khỏi agents)`)
          } catch (syncErr) {
            console.warn(`[CodeTeam] NIM→Zen sync ${def.name} thất bại (không chặn boot):`, syncErr)
          }
        }
        // TASK 33 — debug specialist sync: SENTINEL đổi model chính sang
        // space-bunny-free (user directive). Row còn model mặc định cũ
        // muse-spark (do CODE seed Task 28, không phải user chọn) → sync lên
        // def.model. Model zen khác do user cấu hình → giữ nguyên.
        if (def.name === 'SENTINEL' && existing.model === 'muse-spark-1.3-contributor-free' && def.model !== existing.model) {
          try {
            await db.agentProfile.update({
              where: { id: existing.id },
              data: { model: def.model },
            })
            console.log(`[CodeTeam] Debug specialist sync: SENTINEL muse-spark → ${def.model} (Task 33 — agent chuyên debug dùng space-bunny)`)
          } catch (syncErr) {
            console.warn(`[CodeTeam] SENTINEL debug sync thất bại (không chặn boot):`, syncErr)
          }
        }
        // PHIÊN 7 (2026-10-28 — TASK 37, user directive "TẤT CẢ agent dùng
        // space-bunny-free"): row còn model mặc định cũ của CODE (phiên 6
        // nemotron-3-ultra-free / phiên 5 muse-spark — do seed sync, KHÔNG phải
        // user chọn) → sync lên def.model (space-bunny-free). Model KHÁC do
        // user tự chọn (vd sau 'opencode auth login' quay lại nemotron) →
        // GIỮ NGUYÊN (tôn trọng customization).
        if ((existing.model === 'nemotron-3-ultra-free' || existing.model === 'muse-spark-1.3-contributor-free') && def.model !== existing.model) {
          try {
            await db.agentProfile.update({
              where: { id: existing.id },
              data: { model: def.model },
            })
            console.log(`[CodeTeam] Phiên-7 sync: ${def.name} ${existing.model} → ${def.model} (Task 37 — tất cả agents dùng space-bunny-free)`)
          } catch (syncErr) {
            console.warn(`[CodeTeam] Phiên-7 sync ${def.name} thất bại (không chặn boot):`, syncErr)
          }
        }
        // PHIÊN 8 (2026-09-28 — TASK 39, user directive "agents dùng lượng token
        // TÙY Ý"): row còn maxTokens mặc định cũ của CODE (4096/8192/16384/32768/
        // 65536 — do seed sync các thời kỳ, KHÔNG phải user tự đặt) → sync -1
        // (unlimited). Giá trị user TỰ CHỌN khác các default cũ → GIỮ NGUYÊN.
        const OLD_MAXTOKENS_DEFAULTS = new Set([4096, 8192, 16384, 32768, 65536])
        if (OLD_MAXTOKENS_DEFAULTS.has(existing.maxTokens) && def.maxTokens !== existing.maxTokens) {
          try {
            await db.agentProfile.update({
              where: { id: existing.id },
              data: { maxTokens: def.maxTokens },
            })
            console.log(`[CodeTeam] Phiên-8 sync: ${def.name} maxTokens ${existing.maxTokens} → ${def.maxTokens} (Task 39 — unlimited tokens, user directive)`)
          } catch (syncErr) {
            console.warn(`[CodeTeam] Phiên-8 sync ${def.name} thất bại (không chặn boot):`, syncErr)
          }
        }
        // PHIÊN 8 (2026-09-28 — TASK 39): refresh instruction từ CODE khi row
        // còn prompt mặc định cũ — nhận diện qua marker branding model lỗi thời
        // (Kimi/DeepSeek/Qwen/GLM/MiniMax — các model này đã không còn dùng từ
        // Task 33). Row user đã customize (không chứa marker) → GIỮ NGUYÊN.
        // Prompt mới: dạy ƯU TIÊN native function calling (tools truyền qua API)
        // + bỏ branding cũ.
        const OLD_PROMPT_MARKERS: Record<string, string> = {
          MEGATRON: 'Kimi NHÌN',
          SHOCWAVE: 'DeepSeek THIẾT KẾ',
          RAMPAGE: 'Qwen XÂY',
          SENTINEL: 'GLM SỬA',
          CATALYST: 'MiniMax TỐI ƯU',
        }
        const promptMarker = OLD_PROMPT_MARKERS[def.name]
        if (promptMarker && existing.instruction && existing.instruction.includes(promptMarker)) {
          try {
            const freshPrompt = getAgentPrompt(def.position)
            await db.agentProfile.update({
              where: { id: existing.id },
              data: { instruction: freshPrompt },
            })
            console.log(`[CodeTeam] Phiên-8 prompt refresh: ${def.name} (bỏ branding model cũ + dạy native function calling — Task 39)`)
          } catch (migErr) {
            console.warn(`[CodeTeam] Phiên-8 prompt refresh ${def.name} thất bại (không chặn boot):`, migErr)
          }
        }
        // TASK 42 (user audit "agents có biết gọi Playwright không") — BROWSER
        // TOOL sync: def có browser_screenshot nhưng row DB có whitelist riêng
        // (JSON) mà thiếu tool → ADD-IF-MISSING (union — KHÔNG xóa tool khác
        // user đã cấu hình; rows tools=null tự fallback def nên không cần).
        if (def.tools.includes('browser_screenshot') && existing.tools) {
          try {
            const parsedTools = JSON.parse(existing.tools)
            if (Array.isArray(parsedTools) && !parsedTools.includes('browser_screenshot')) {
              await db.agentProfile.update({
                where: { id: existing.id },
                data: { tools: JSON.stringify([...parsedTools, 'browser_screenshot']) },
              })
              console.log(`[CodeTeam] Task-42 sync: ${def.name} +browser_screenshot (verify UI tại checkpoint — audit Playwright)`)
            }
          } catch (syncErr) {
            console.warn(`[CodeTeam] Task-42 browser sync ${def.name} thất bại (không chặn boot):`, syncErr)
          }
        }
        // FIX 2026-09-15 #10 (P4 — audit Team Code): marker-migration cho
        // instruction/description lỗi thời — SENTINEL prompt nói "Max 3 vòng"
        // trong khi workflow-engine cap thực tế = 5 (comment engine: "was 3 —
        // too few"). Row còn mang default cũ (chứa marker "Max 3 vòng iteration")
        // → refresh instruction/description từ định nghĩa MỚI trong code; row
        // user đã customize khác hẳn (không chứa marker) → GiỮ NGUYÊN.
        if (def.name === 'SENTINEL' && existing.instruction && existing.instruction.includes('Max 3 vòng iteration')) {
          try {
            const freshPrompt = getAgentPrompt('G2-B')
            await db.agentProfile.update({
              where: { id: existing.id },
              data: {
                instruction: freshPrompt,
                ...(existing.description && existing.description.includes('max 3 vòng') ? { description: def.description } : {}),
              },
            })
            console.log('[CodeTeam] Migrated SENTINEL instruction → new version (max 5 vòng — đồng bộ engine cap thực tế)')
          } catch (migErr) {
            console.warn(`[CodeTeam] Instruction migration SENTINEL thất bại (không chặn boot):`, migErr)
          }
        }

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
