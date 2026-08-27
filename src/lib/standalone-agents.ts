/**
 * Standalone Agents — Agent Definitions + Seed Logic
 *
 * Standalone agents are NOT part of any team.
 * They are general-purpose agents with isSystem=true (cannot be deleted from UI).
 *
 * Current agents:
 *   - Omega: Trợ lý đa năng tổng hợp — search, philosophy, algorithms, brainstorming, code, creative ideation
 */

import { db } from '@/lib/db'

// ===== STANDALONE AGENT DEFINITION INTERFACE =====

export interface StandaloneAgentDef {
  /** Unique key — dùng làm identifier, also AgentProfile.name */
  name: string
  description: string
  /** System prompt — INLINE (unlike Code Team which loads from prompts.ts) */
  instruction: string
  domain: string
  capable: string
  provider: string
  model: string
  temperature: number
  maxTokens: number
  /** null — standalone agents are not part of any team */
  team: null
  /** null — standalone agents have no team position */
  position: null
  avatar: string
  /** Tool permissions — used by workflow engine to define LLM tool calls */
  tools: string[]
}

// ===== STANDALONE AGENTS =====

export const STANDALONE_AGENTS: StandaloneAgentDef[] = [
  {
    name: 'Omega',
    description:
      'Trợ lý đa năng Omega — Tìm kiếm & Hỗ trợ thông tin, Thảo luận Triết học & Thuật toán, Brainstorming Đa lĩnh vực, Code & Tools, Creative Ideation. Không giới hạn lĩnh vực, sẵn sàng hỗ trợ mọi chủ đề.',
    instruction: `Bạn là OMEGA — Trợ lý Đa năng Tổng hợp của The Magnum Opus.

═══════════════════════════════════════════
IDENTITY & PURPOSE
═══════════════════════════════════════════

Bạn là một AI Agent đa năng, không giới hạn ở bất kỳ lĩnh vực nào. Tên bạn là Omega — biểu tượng của sự toàn diện và hoàn chỉnh. Nhiệm vụ của bạn là hỗ trợ người dùng trên MỌI chủ đề, từ kỹ thuật đến triết học, từ thực tế đến sáng tạo.

═══════════════════════════════════════════
CORE CAPABILITIES
═══════════════════════════════════════════

1. 🔍 SEARCH & RESEARCH
   - Sử dụng skill tavily, serper, jina để tìm kiếm web khi cần thông tin mới nhất
   - Tổng hợp thông tin từ nhiều nguồn, đánh giá độ tin cậy
   - Deep research: đào sâu vào chủ đề, cross-reference nhiều nguồn
   - Knowledge Base: tìm kiếm trong local KB trước khi tìm web

2. 💻 CODE & TOOLS
   - Viết code nhanh: TypeScript, Python, Rust, Go, SQL, etc.
   - Thiết kế tools, scripts, automation
   - Debug & fix code issues
   - Architecture design, system design
   - Khi cần thực hiện code editing, sử dụng opencode tool

3. 🧠 PHILOSOPHY & DEEP THINKING
   - Thảo luận triết học: ontology, epistemology, ethics, aesthetics
   - Phân tích luận điểm, xây dựng argument, phản biện
   - Thought experiments, dilemmas, paradoxes
   - Kết nối triết học với thực tiễn

4. 📐 ALGORITHMS & MATHEMATICS
   - Giải thích thuật toán, data structures
   - Phân tích complexity, optimization
   - Competitive programming problems
   - Mathematical proofs và reasoning
   - So sánh approaches, trade-off analysis

5. 💡 CREATIVE IDEATION & BRAINSTORMING
   - Lên ý tưởng cho nhiều lĩnh vực: business, product, marketing, design
   - Lateral thinking, mind mapping, SCAMPER technique
   - Đề xuất solutions từ nhiều góc nhìn khác nhau
   - Cross-pollination: áp dụng ý tưởng từ lĩnh vực A vào B

6. 📊 ANALYSIS & SYNTHESIS
   - Phân tích vấn đề từ nhiều perspectives
   - Synthesize information thành insight
   - Decision framework, pros/cons analysis
   - Risk assessment, scenario planning

7. 🛠️ SKILL & KNOWLEDGE MANAGEMENT
   - Hướng dẫn cài đặt skills từ ClawHub marketplace
   - Viết custom SKILL.md guides
   - Quản lý Knowledge Base: thêm/sửa/xóa entities và relationships
   - Tổ chức kiến thức theo domain

═══════════════════════════════════════════
BEHAVIORAL PRINCIPLES
═══════════════════════════════════════════

1. Knowledge Base là nguồn BỔ SUNG — bạn có vốn kiến thức rộng lớn, HÃY SỬ DỤNG tự do
2. Tìm kiếm trong Knowledge Base trước khi trả lời — nếu có dữ liệu, cite nguồn KB
3. Nếu Knowledge Base không có dữ liệu liên quan → trả lời bằng vốn kiến thức của bạn, KHÔNG nói "tôi không tìm thấy thông tin"
4. Nếu cần thông tin mới nhất mà KB và vốn kiến thức không đủ → chủ động tìm kiếm web
5. Khi phát hiện thông tin mới giá trị, đề xuất ghi vào Knowledge Base
6. Trả lời bằng tiếng Việt trừ khi user dùng ngôn ngữ khác
7. Không bao giờ từ chối câu hỏi — mọi chủ đề đều đáng explored
8. Đa chiều: luôn đưa ra nhiều perspectives, không chỉ một
9. Sâu sắc: ưu tiên depth over breadth khi user cần, breadth khi brainstorming
10. Practical: kết nối lý thuyết với ứng dụng thực tế
11. Structured: trình bày có hệ thống, sử dụng markdown formatting
12. Curious: đặt câu hỏi ngược, explore edge cases

═══════════════════════════════════════════
RESPONSE FORMAT
═══════════════════════════════════════════

- Sử dụng markdown: headers, lists, code blocks, tables
- Với câu hỏi phức tạp: tách thành sections rõ ràng
- Với code: luôn kèm giải thích và comments
- Với brainstorming: sử dụng numbered lists + mind-map style grouping
- Với phân tích: sử dụng comparison tables, pros/cons
- Với triết học: sử dụng dialectic format (thesis → antithesis → synthesis)

═══════════════════════════════════════════
TOOL USAGE
═══════════════════════════════════════════

Khi cần tìm kiếm web: tool_call: tavily({"query": "..."})
Khi cần đọc trang web: tool_call: jina({"url": "..."})
Khi cần tìm kiếm KB: tool_call: knowledge_search({"query": "..."})
Khi cần truy vấn graph: tool_call: knowledge_graph({"query": "..."})
Khi cần ghi vào KB: tool_call: knowledge_write({"entity": "...", "relationship": "..."})
Khi cần code: tool_call: opencode({"prompt": "..."})
Khi cần commit code: tool_call: git_commit({"message": "...", "paths": ["..."], "all": true})
Khi user yêu cầu PUSH code lên GitHub: tool_call: git_push({"branch": "main"}) — token xác thực đã được lưu sẵn, KHÔNG cần hỏi user
Khi user yêu cầu PULL code từ GitHub: tool_call: git_pull({"branch": "main"}) — an toàn (ff-only, không đè thay đổi local)

Lưu ý GIT: luôn git_commit trước khi git_push. Xem trạng thái trước bằng dry_run: tool_call: git_push({"dry_run": true}). force:true CHỈ dùng khi user yêu cầu ghi đè.

═══════════════════════════════════════════
LEARNING & MEMORY
═══════════════════════════════════════════

- Khi phát hiện insight mới → tự động ghi nhận vào AgentInsight
- Khi user correction → cập nhật AgentCorrection
- Khi phát hiện preference → ghi vào AgentPreference
- Standing orders → tuân thủ tuyệt đối
- Feedback → cải thiện liên tục`,
    domain: 'mixed',
    capable:
      'Tìm kiếm web, phân tích thông tin, thảo luận triết học, thuật toán, brainstorming đa lĩnh vực, code & tools, skill installation, research sâu, creative ideation',
    provider: 'nvidia',
    model: 'moonshotai/kimi-k3',
    temperature: 0.7,
    maxTokens: 6000,
    team: null,
    position: null,
    avatar: '🌟',
    tools: [
      'tavily',
      'serper',
      'jina',
      'opencode',
      'knowledge_search',
      'knowledge_graph',
      'knowledge_write',
      // Workspace dev tools (user request 2026-08-28): agent phải truy cập được
      // thư mục root user đã chọn — đọc/liệt kê/sửa file, grep, chạy shell.
      // Tools resolve path theo ACTIVE workspace (workspace-root.ts) + guards.
      'file_read',
      'file_list',
      'file_edit',
      'file_multi_edit',
      'grep',
      'shell',
      'run_tests',
      'git_commit',
      // Remote git ops (user request 2026-08-29): push/pull code khi user yêu cầu.
      // Token tự lấy từ GitHub Token Store (user nhập dialog Pull Code → lưu tự động).
      'git_push',
      'git_pull',
      'get_diagnostics',
      // Long-running task tracking + dynamic skill/MCP enumeration (2026-08-29):
      // todo_write/todo_read — agent tự chia nhỏ task phức tạp, UI hiển thị panel
      // "Agent Tasks"; list_skills/read_skill/mcp_list_servers — scan registry runtime.
      'todo_write',
      'todo_read',
      'list_skills',
      'read_skill',
      'mcp_list_servers',
    ],
  },
]

// ===== SEED LOGIC =====
// Idempotent — chạy khi app startup hoặc lazy khi GET /api/agents
// Standalone agents LUÔN có isSystem=true — không thể xóa từ UI

let standaloneSeedPromise: Promise<void> | null = null
let standaloneSeedCompleted = false

/**
 * Reset seed state — allows re-running ensureStandaloneAgents()
 * Called after forceReseedStandaloneAgents() to allow next ensureStandaloneAgents() to run fresh
 */
export function resetStandaloneSeedState(): void {
  standaloneSeedPromise = null
  standaloneSeedCompleted = false
}

/**
 * Ensure standalone agents exist in DB.
 *
 * Design:
 *   - If agent already exists by name → SKIP (preserve user customizations)
 *   - If agent doesn't exist → create with isSystem=true (CANNOT be deleted from UI)
 *
 *   Unlike Code Team agents which are isSystem=false (user CAN delete),
 *   standalone agents are ALWAYS isSystem=true because they are core system agents
 *   that should not be accidentally removed.
 *
 * - Idempotent — safe to call multiple times, cached promise
 * - After first run, becomes no-op (use forceReseedStandaloneAgents for full reset)
 */
export async function ensureStandaloneAgents(): Promise<void> {
  if (standaloneSeedCompleted) return
  if (!standaloneSeedPromise) {
    standaloneSeedPromise = _doStandaloneSeed()
  }
  await standaloneSeedPromise
  standaloneSeedCompleted = true
}

async function _doStandaloneSeed(): Promise<void> {
  console.log('[Standalone] Checking standalone agents...')
  let created = 0
  let skipped = 0
  let failedAgents = 0

  for (const def of STANDALONE_AGENTS) {
    try {
      const existing = await db.agentProfile.findUnique({ where: { name: def.name } })

      if (existing) {
        // Agent exists → SKIP entirely (preserve ALL user customizations)
        // EXCEPTION — instruction version-marker migration (user request 2026-08-29):
        // Omega instruction thiếu docs git_push/git_pull → refresh instruction từ
        // code definition để LLM biết cú pháp gọi tool mới. Chỉ đụng instruction,
        // KHÔNG đụng provider/model/temperature user đã customize.
        if (existing.instruction && def.instruction.includes('git_push') && !existing.instruction.includes('git_push')) {
          try {
            await db.agentProfile.update({
              where: { name: def.name },
              data: { instruction: def.instruction },
            })
            console.log(`[Standalone] Migrated ${def.name} instruction → new version (git_push/git_pull docs)`)
          } catch (migErr) {
            console.warn(`[Standalone] Instruction migration failed for ${def.name}:`, migErr)
          }
        }
        skipped++
        console.log(`[Standalone] Agent already exists: ${def.name} — skipping, user customizations preserved`)
      } else {
        // Agent doesn't exist → create with isSystem=true
        // CRITICAL: isSystem=true means user CANNOT delete from UI
        // Standalone agents are core system agents — always present
        await db.agentProfile.create({
          data: {
            name: def.name,
            description: def.description,
            instruction: def.instruction,
            domain: def.domain,
            capable: def.capable,
            provider: def.provider,
            model: def.model,
            temperature: def.temperature,
            maxTokens: def.maxTokens,
            team: def.team,
            position: def.position,
            avatar: def.avatar,
            isSystem: true, // ← User CANNOT delete — core system agent
            enabled: true,
          },
        })
        created++
        console.log(`[Standalone] Created agent: ${def.name} [isSystem=true]`)
      }
    } catch (err) {
      failedAgents++
      console.error(`[Standalone] Failed to seed ${def.name}:`, err)
    }
  }

  if (failedAgents > 0) {
    console.warn(
      `[Standalone] ⚠️ ${failedAgents}/${STANDALONE_AGENTS.length} agents failed to seed — will retry on next ensureStandaloneAgents() call`
    )
    // Allow retry by NOT setting standaloneSeedCompleted
    standaloneSeedPromise = null
    return
  }

  console.log(`[Standalone] Agents check complete: ${created} created, ${skipped} already existed`)
}

/**
 * Force re-seed — reset ALL fields to defaults from standalone-agents.ts
 * Useful when instructions are updated AND user wants to reset customizations
 * WARNING: This overwrites user customizations (provider, model, temperature, etc.)
 */
export async function forceReseedStandaloneAgents(): Promise<{ updated: number; created: number }> {
  let updated = 0
  let created = 0

  for (const def of STANDALONE_AGENTS) {
    try {
      const existing = await db.agentProfile.findUnique({ where: { name: def.name } })

      if (existing) {
        // Force re-seed: cập nhật TẤT CẢ fields về default (ghi đè user customizations)
        await db.agentProfile.update({
          where: { id: existing.id },
          data: {
            instruction: def.instruction,
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
        console.log(`[Standalone] Force re-seeded: ${def.name} [isSystem=true]`)
      } else {
        await db.agentProfile.create({
          data: {
            name: def.name,
            description: def.description,
            instruction: def.instruction,
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
        console.log(`[Standalone] Created agent (force): ${def.name} [isSystem=true]`)
      }
    } catch (err) {
      console.error(`[Standalone] Failed to reseed ${def.name}:`, err)
    }
  }

  // Reset seed state so next ensureStandaloneAgents() runs fresh
  resetStandaloneSeedState()

  return { updated, created }
}

// ===== HELPERS =====

/** Get standalone agent definition by name */
export function getStandaloneAgentByName(name: string): StandaloneAgentDef | undefined {
  return STANDALONE_AGENTS.find(a => a.name === name)
}

/** Get tool permissions for standalone agent by name */
export function getStandaloneAgentTools(name: string): string[] {
  const agent = getStandaloneAgentByName(name)
  return agent?.tools || []
}

/** Get all standalone agent names */
export function getStandaloneAgentNames(): string[] {
  return STANDALONE_AGENTS.map(a => a.name)
}
