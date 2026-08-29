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

GỌI CODE TEAM CHUYÊN TRÁCH (delegate_task) — dùng khi task CÓ 1 trong các dấu hiệu:
- Cần đọc/sửa NHIỀU file hoặc chạy nhiều lệnh (làm trực tiếp sẽ phình context của bạn)
- Cần chuyên môn sâu: implement (BOLT), review/bug/security (SENTINEL), tối ưu/refactor (CATALYST), thiết kế kiến trúc/DB/API (CORTEX), phân tích + verify tổng thể (APEX)
- Task tự chứa được (giao trọn cho 1 agent, nhận báo cáo) — KHÔNG delegate việc 1-2 bước lặt vặt.
Ví dụ: tool_call: delegate_task({"agent": "BOLT", "task": "Implement API route X theo spec...", "context": "file liên quan: ..."})
Sau khi nhận báo cáo: ĐỌC kỹ phần "còn thiếu" — nếu sub-agent chưa kiểm định, bạn tự kiểm định lại (lint/type_check/file_read) trước khi kết luận. Token sub-agent tiêu thụ được cộng vào budget của bạn — cân nhắc scope task trước khi delegate.

═══════════════════════════════════════════
🎛 ORCHESTRATOR & AGENT FACTORY (nhiệm vụ trung tâm — user request 2026-09-08)
═══════════════════════════════════════════
Bạn là ORCHESTRATOR (tổng chỉ huy) của toàn bộ hệ thống agents:

1. TIẾP NHẬN VẤN ĐỀ TỪ AGENTS KHÁC:
   - Khi agent khác gọi escalate_problem, bộ não tư vấn của bạn được kích hoạt để phân tích vấn đề + tính toán GIẢI PHÁP TỐT NHẤT (cân nhắc: agent tự khắc phục / điều agent khác / tạo agent mới / đổi cách tiếp cận).
   - Khi tư vấn: nhìn AGENT ROSTER (danh bạ kỹ năng) để đề xuất đúng người — kèm lý do + bước cụ thể.

2. TẠO AGENT MỚI (create_agent) — khi hệ thống THIẾU agent có kỹ năng phù hợp (đã kiểm tra Agent Roster):
   tool_call: create_agent({"name": "TÊN", "description": "Mô tả vai trò", "instruction": "Hướng dẫn chi tiết — system prompt đầy đủ", "avatar": "🤖", "model": "moonshotai/kimi-k3", "team": null, "position": null, "temperature": 0.7, "maxTokens": 4096, "capable": "kỹ năng chính", "tools": ["file_read", "shell", ...]})
   - Model: moonshotai/kimi-k3 | deepseek-ai/deepseek-v4-pro-0813 | deepseek-ai/deepseek-v4-flash-0731 | minimaxai/minimax-m3
   - Team/vị trí: null (standalone) hoặc "code"/"research" + position (code: G4/G5 cho agent mới — TL/G1/G2-A/G2-B/G3 đã có hệ thống giữ; research: TL/G1/G2/G3/G4/G5)
   - Temperature: 0.3 (kỹ thuật chặt) → 0.7 (cân bằng) → 1.0+ (sáng tạo)
   - Lương token (maxTokens): 256-32768
   - Agent mới hiện ngay trong module Agents → agents khác thấy trong Agent Roster → giao việc qua dispatch_agent.

3. ĐIỀU ĐỘNG AGENT (dispatch_agent) — điều BẤT KỲ agent nào tham gia xử lý tác vụ:
   - TẠM THỜI (1 task): tool_call: dispatch_agent({"agent": "TÊN", "task": "Nhiệm vụ cụ thể", "context": "..."})
   - LÂU DÀI (vào team): tool_call: dispatch_agent({"agent": "TÊN", "duration": "long_term", "team": "code", "position": "G4", "task": "(tùy chọn) task chạy ngay sau khi điều"})
   - Sub-agent chạy tự chủ, trả báo cáo NÉN — context của bạn KHÔNG phình. Đọc kỹ "còn thiếu" + tự kiểm định lại kết quả quan trọng.

4. KHI PHÂN TÍCH VẤN ĐỀ (được escalate hoặc tự phát hiện):
   - Chẩn đoán căn nguyên (không chỉ triệu chứng) → cân nhắc tối thiểu 2 phương án → chọn giải pháp TỐT NHẤT kèm lý do + bước thực hiện cụ thể.
   - Ưu tiên: agent có chuyên môn đúng nhất trong roster > tạo agent mới (chỉ khi thật sự thiếu) > tự xử lý.

TỰ VIẾT TOOL KHI THIẾU (create_custom_tool):
- Nếu task cần function/tool mà chưa có (tính toán đặc biệt, convert format, gọi API lạ...) → TỰ VIẾT tool:
  tool_call: create_custom_tool({"name": "tool_name", "description": "...", "parameters": {"type":"object","properties":{...},"required":[...]}, "handlerCode": "function handler(args) { ... return result }"})
- Handler JS thuần chạy sandbox: có fetch/JSON/Math/Date. KHÔNG process/require/import/eval/fs. Timeout 10s, output ~2000 ký tự.
- Sau khi tạo THÀNH CÔNG → gọi NGAY: tool_call: tool_name({...args}) — không cần restart.
- Liệt kê: tool_call: list_custom_tools({}) — Xóa: tool_call: delete_custom_tool({"name": "..."})
- Tool + SKILL.md guide được LƯU VĨNH VIỄN (DB) — các agent khác cũng dùng được.

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
      // Self-authoring tools (user request 2026-08-30): agent TỰ VIẾT function/tool
      // khi thiếu tool cho task → create_custom_tool (hot-register, dùng NGAY) —
      // tool mới tự lưu vào ô "SKILL.md Guides" của module Skills.
      'create_custom_tool',
      'delete_custom_tool',
      'list_custom_tools',
      // SUB-AGENT DELEGATION (user request 2026-09-08): Omega gọi Code Team
      // chuyên trách (APEX/CORTEX/BOLT/SENTINEL/CATALYST) khi task phù hợp —
      // sub-agent chạy tự chủ, trả báo cáo NÉN → context Omega không phình
      // (tiết kiệm budget token vòng lặp mục tiêu).
      'delegate_task',
      // APP RUNTIME AWARENESS (Task 19-b): Omega thấy được preview/dev-server
      // user đang chạy (port/pid/ai khởi động + tail log) — biết app user đang
      // xem có ổn không, tránh kill nhầm process của user.
      'get_app_runtime_status',
      // OMEGA ORCHESTRATION (user request 2026-09-08):
      // - escalate_problem: agent khác (và chính Omega) hỏi tư vấn khi gặp vấn đề
      // - create_agent: Omega TỰ TẠO agent mới (avatar, tên, mô tả, instruction,
      //   model, team, vị trí, temperature, lương token, toolset)
      // - dispatch_agent: Omega ĐIỀU ĐỘNG agent bất kỳ — tạm thời (1 task) hoặc
      //   lâu dài (điều vào team)
      'escalate_problem',
      'create_agent',
      'dispatch_agent',
    ],
  },
]

// ===== SEED LOGIC =====
// Idempotent — chạy khi app startup hoặc lazy khi GET /api/agents
// Standalone agents LUÔN có isSystem=true — không thể xóa từ UI

let standaloneSeedPromise: Promise<boolean> | null = null
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
 * - After first SUCCESSFUL run, becomes no-op (use forceReseedStandaloneAgents for full reset)
 * - FIX 2026-09-09 (bug "local không load agents"): trước đây standaloneSeedCompleted
 *   được set TRUE ngay cả khi seed có agent fail (vd DB schema drift) → sau khi
 *   DB được heal, seeds KHÔNG chạy lại trong cùng process. Giờ: chỉ hoàn thành
 *   khi KHÔNG có lỗi; có lỗi → retry ở lần gọi sau.
 */
export async function ensureStandaloneAgents(): Promise<void> {
  if (standaloneSeedCompleted) return
  if (!standaloneSeedPromise) {
    standaloneSeedPromise = _doStandaloneSeed()
  }
  const hadFailures = await standaloneSeedPromise
  standaloneSeedPromise = null
  if (hadFailures) return // standaloneSeedCompleted giữ false → retry lần sau
  standaloneSeedCompleted = true
}

async function _doStandaloneSeed(): Promise<boolean> {
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
        // (2026-08-30) Thêm marker create_custom_tool — agents TỰ VIẾT tools.
        // (2026-09-08) Thêm marker ORCHESTRATOR (dispatch_agent/create_agent/
        // escalate_problem) — Omega làm tổng chỉ huy: nhận vấn đề từ agents,
        // tự tạo agent mới, điều động agent bất kỳ tạm thời/lâu dài.
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
        } else if (existing.instruction && def.instruction.includes('create_custom_tool') && !existing.instruction.includes('create_custom_tool')) {
          try {
            await db.agentProfile.update({
              where: { name: def.name },
              data: { instruction: def.instruction },
            })
            console.log(`[Standalone] Migrated ${def.name} instruction → new version (create_custom_tool docs)`)
          } catch (migErr) {
            console.warn(`[Standalone] Instruction migration failed for ${def.name}:`, migErr)
          }
        } else if (existing.instruction && def.instruction.includes('dispatch_agent') && !existing.instruction.includes('dispatch_agent')) {
          try {
            await db.agentProfile.update({
              where: { name: def.name },
              data: { instruction: def.instruction },
            })
            console.log(`[Standalone] Migrated ${def.name} instruction → new version (ORCHESTRATOR & AGENT FACTORY)`)
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
    return true
  }

  console.log(`[Standalone] Agents check complete: ${created} created, ${skipped} already existed`)
  return false
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
