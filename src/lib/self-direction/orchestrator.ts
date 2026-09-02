/**
 * SELF-DIRECTION ORCHESTRATOR — Bộ não Omega của module Self-direction
 * ====================================
 * (2026-09-12) Module Self-direction: agents tự phát hiện khoảng trống hệ
 * thống → tạo đề xuất chờ Mr. Architect phê duyệt (hoặc ủy quyền Opus duyệt
 * — user decision #3, 2026-09-30: quyền duyệt chuyển từ Omega sang OPUS).
 * Đề xuất được duyệt → ORCHESTRATION:
 *   1. Omega lập kế hoạch (bao nhiêu bước? agent nào làm gì?)
 *   2. Từng bước giao agent thực hiện (persona từ AgentProfile)
 *   3. Người đánh giá output từng bước — đạt mới bàn giao bước kế tiếp,
 *      không đạt → phản hồi + thử lại (max 3 lần). Khi ủy quyền bật
 *      (opusDelegated=true) → OPUS đánh giá thay Omega (user decision #3);
 *      khi tắt → Omega như cũ.
 *   4. Hoàn tất → người đánh giá viết báo cáo hoàn thiện (Opus khi ủy quyền
 *      bật, Omega khi tắt): đã làm gì, làm thế nào, kết quả từng bước,
 *      kết quả sau cùng, đề xuất thêm.
 *
 * USER DECISION #3 (2026-09-30, PHÊ DUYỆT — KHÔNG THAY ĐỔI) — PHÂN QUYỀN:
 *   - Ủy quyền phê duyệt (SelfDirectionSettings.opusDelegated): OPUS (CTO)
 *     duyệt/không duyệt đề xuất thay Mr. Architect + nhận các công việc sau
 *     ủy quyền vốn của Omega: ĐÁNH GIÁ bước & VIẾT BÁO CÁO hoàn thiện.
 *   - TRIỂN KHAI (generateWorkPlan / executeStep / code-workflow / verify_
 *     and_push) VẪN CỦA OMEGA mọi lúc — việc nội tại orchestration, không
 *     phải ủy quyền.
 *
 * BẢO VỆ TƯƠNG LAI (user decision #3 — ràng buộc kiến trúc cho developer):
 *   Opus/Omega muốn sửa CHÍNH MÌNH hoặc NHAU (instruction, quyền, định nghĩa
 *   agent) → PHẢI tạo SelfDirectionProposal đi qua module SELF-DIRECTION này
 *   (Mr. Architect phê duyệt, hoặc Opus duyệt thay khi được ủy quyền). Các
 *   agent KHÔNG ĐƯỢC sửa trực tiếp. (Ràng buộc prompt-level đã nằm trong
 *   OPUS_INSTRUCTION §II.2 — comment này ghi nhận cho developer.)
 *
 * Fire-and-forget: các route gọi triggerOrchestration()/opusReviewPending()
 * và trả response ngay — UI poll GET /api/self-direction/proposals để xem
 * tiến độ (status: planning → executing → completed/failed).
 *
 * CI-6 B5 (SELF-DIRECTION ↔ workspace): proposal có executionMode
 * 'code-workflow' → bước GIỮA thực thi bằng TOOL THẬT (executeTool trên
 * workspace active — file tools, git_status, lint...), bước CUỐI
 * verify_and_push (Omega) chạy pipeline kiểm định 9 bước THẬT trước khi
 * commit+push (runPrePushVerification: lint→typecheck→tests→smoke→
 * secret-scan→commit→push→pull). Receipts lưu ProposalStep.workspaceReceipt;
 * báo cáo hoàn thiện đan thêm section "Kết quả kiểm định & triển khai code".
 * Mặc định 'llm' giữ nguyên hành vi thuần hội thoại (tương thích ngược).
 */

import { db } from '@/lib/db'
import { callLLMForAgent } from '@/lib/llm'
import { findBalancedJson } from '@/lib/code-team/find-balanced-json'
import { getAgentRoster } from '@/lib/agent-roster'
// CI-5 B6 (Task 14-d) — stall-kill thích ứng: đọc tín hiệu sống của execution
// (sd-<proposalId>) từ agent-run-tracker (in-memory globalThis — events có ts).
// KHÔNG circular: agent-run-tracker chỉ phụ thuộc metrics-db.
import { getAgentRuns } from '@/lib/agent-run-tracker'
// CI-6 B5 (SELF-DIRECTION ↔ workspace): bước code-workflow thực thi THẬT qua
// tool executor + pipeline pre-push — import tĩnh an toàn (code-team modules đã
// nằm trong module graph của app qua chat routes; không có vòng import).
import { executeTool } from '@/lib/code-team/tool-executor'
import { runPrePushVerification, type PrePushResult } from '@/lib/code-team/pre-push-verify'
import { parseToolCallsFromOutput, formatMessagesForLLM } from '@/lib/tool-calls'
import { Prisma } from '@prisma/client'
// USER DECISION #3 (2026-09-30): ủy quyền phê duyệt SELF-DIRECTION chuyển từ
// Omega sang OPUS (CTO). Import persona Opus cho 3 vai trò ủy quyền: duyệt đề
// xuất / đánh giá bước / viết báo cáo hoàn thiện. (opus-agent chỉ phụ thuộc
// @/lib/db — không có vòng import; KHÔNG sửa src/lib/opus/**.)
import { OPUS_AGENT_NAME, OPUS_INSTRUCTION } from '@/lib/opus/opus-agent'

// ==================== TYPES ====================

export interface SdPlanStep {
  title: string
  description: string
  assignee: string
  /** CI-6 B5: kế thừa executionMode từ proposal — 'code-workflow' = thực thi tool thật */
  executionMode?: string
}

export interface SdWorkPlan {
  planSummary: string
  steps: SdPlanStep[]
}

export interface SdReviewVerdict {
  decision: 'approve' | 'reject'
  reason: string
}

export interface SdStepEvaluation {
  complete: boolean
  evaluation: string
}

// ==================== CONSTANTS ====================

const OMEGA_FALLBACK_BRAIN = { provider: 'nvidia', model: 'moonshotai/kimi-k3' }
const LLM_TIMEOUT_MS = 120_000
const MAX_PLAN_STEPS = 12
const MAX_STEP_ATTEMPTS = 3

// ==================== CI-6 B5 — CODE-WORKFLOW (thực thi code THẬT trong workspace) ====================

/**
 * Proposal executionMode='code-workflow': agents CHỈNH SỬA CODE THẬT qua tool
 * executor (executeTool — file tools, git tools, lint... chạy trên workspace
 * active) và bước CUỐI chạy pipeline kiểm định 9 bước thật
 * (runPrePushVerification: lint→typecheck→tests→smoke→secret-scan→commit→
 * push→pull). Mọi biên lai (receipts) lưu vào ProposalStep.workspaceReceipt.
 */

/** Bước cuối code-workflow: marker trong title (giao Omega) */
const VERIFY_AND_PUSH_TITLE_RE = /verify_and_push|pipeline|kiểm định/i
/** Trần an toàn cho ReAct loop 1 bước code-workflow (guard chống loop vô hạn) */
const SD_CODE_STEP_MAX_TOOL_CALLS = 8
const SD_CODE_STEP_MAX_TURNS = 6
/** Cap ký tự tool-result đẩy vào conversation (chống context nổ) */
const SD_CODE_TOOL_RESULT_CAP = 4000
/**
 * Tools cho phép ở bước GIỮA code-workflow: edit code thật + khảo sát + kiểm
 * định cục bộ. CHỈ TRỪ commit/push/pull/verify_and_push — pipeline ở bước cuối
 * là đường DUY NHẤT đẩy code lên remote (bảo đảm mọi thay đổi qua kiểm định).
 */
const SD_CODE_TOOL_ALLOWLIST = new Set([
  'file_read', 'file_write', 'file_edit', 'file_multi_edit', 'file_list', 'file_delete',
  'grep', 'shell', 'run_tests', 'lint', 'type_check', 'lsp_diagnostics',
  'git_status', 'git_diff', 'git_log', 'todo_write',
])

/**
 * FIX review GĐ2 #3 (MEDIUM): shell nằm trong allowlist nhưng KHÔNG được dùng
 * để commit/push thủ công — chặn bằng denylist substring trong lệnh shell
 * (giữ invariant "pipeline bước cuối là đường DUY NHẤT đẩy code").
 * Chỉ áp dụng cho SD code-workflow steps — không đụng shell tool của agents
 * thường (mô hình tin tưởng đã có từ trước).
 */
const SD_SHELL_DENY_PATTERNS: RegExp[] = [
  /\bgit\s+(commit|push|pull|merge|rebase|reset|checkout\s+--\s*\.|restore|clean)\b/i,
  /\bgit\s+remote\s+(add|set-url)\b/i,
]
function sdShellCommandAllowed(command: unknown): boolean {
  if (typeof command !== 'string') return true
  return !SD_SHELL_DENY_PATTERNS.some(re => re.test(command))
}

/** Receipt 1 bước GIỮA code-workflow — log tool calls đã THỰC THI thật */
export interface SdToolBatchReceipt {
  kind: 'tool-batch'
  toolCalls: Array<{ tool: string; success: boolean }>
  executedAt: string
}

/** Receipt bước CUỐI code-workflow — kết quả pipeline pre-push (verify_and_push) */
export interface SdPipelineReceipt extends PrePushResult {
  kind: 'pre-push-pipeline'
  executedAt: string
  dryRun?: boolean
}

/** Dữ liệu receipt pipeline rút gọn đan vào báo cáo hoàn thiện của Omega */
export interface SdPipelineReceiptSummary {
  success: boolean
  commitHash?: string
  pushed?: boolean
  pulled?: boolean
  error?: string
  steps: Array<{ name: string; status: string; detail?: string }>
}

/** Proposal đang planning/executing mà updatedAt đứng yên quá lâu → coi là gián đoạn (PM2 restart/OOM) */
const STALLED_AFTER_MS = 10 * 60_000

const VALID_CATEGORIES = ['gap', 'kb_contradiction', 'tool_failure', 'missing_skill', 'missing_test', 'improvement', 'long_term', 'automation']
const VALID_PRIORITIES = ['low', 'medium', 'high', 'critical']

// ==================== IN-PROCESS LOCKS (chống double-run) ====================

const globalForSd = globalThis as unknown as {
  __tmoSdRunningOrchestrations?: Set<string>
  __tmoSdReviewingProposals?: Set<string>
}
const runningOrchestrations: Set<string> = (globalForSd.__tmoSdRunningOrchestrations ??= new Set())
const reviewingProposals: Set<string> = (globalForSd.__tmoSdReviewingProposals ??= new Set())

// ==================== Z-AI SDK FALLBACK — ĐÃ GỠ TOÀN BỘ (2026-10-15) ====================
// (1) 2026-09-02 (audit Omega #5): gỡ bản copy getZaiSdk/tryZaiSdk tại file
//     này + scan.ts — mọi LLM call chỉ qua callLLMForAgent (llm.ts).
// (2) 2026-10-15 (user directive): gỡ NỐT cả fallback z-ai-sdk bên trong
//     llm.ts (callLLMForAgent + callLLM) — SDK chỉ tồn tại trong sandbox
//     triển khai, KHÔNG có trên máy local của user. Chuỗi LLM giờ thuần
//     NVIDIA NIM (kimi-k3 → deepseek-v4-pro → v4-flash → minimax-m3, xoay
//     4 key + timeout-breaker) — lỗi hiện diện thẳng trong LLMResult.error.

// ==================== CORE LLM HELPER ====================

async function callBrain(params: {
  prompt: string
  systemPrompt?: string
  temperature?: number
  maxTokens?: number
  label: string
}): Promise<string> {
  const { prompt, systemPrompt, temperature = 0.3, maxTokens = 1200, label } = params
  try {
    // callLLMForAgent: NVIDIA chain (kimi-k3 → fallback chain model-first,
    // xoay 4 key) — z-ai-sdk fallback đã gỡ (2026-10-15).
    const result = await withTimeout(
      callLLMForAgent(prompt, OMEGA_FALLBACK_BRAIN, systemPrompt, {
        agentName: 'SelfDirection',
        temperature,
        maxTokens,
      }),
      LLM_TIMEOUT_MS,
      `${label} (NVIDIA chain)`,
    )
    if (result.content && result.content.trim()) return result.content.trim()
    console.warn(`[SelfDirection] ${label}: chuỗi NVIDIA không trả content — error: ${(result.error || '(không có error detail)').slice(0, 200)}`)
  } catch (err) {
    console.warn(`[SelfDirection] ${label}: chuỗi LLM lỗi (timeout/backend):`, err instanceof Error ? err.message : String(err))
  }
  throw new Error(`${label}: mọi LLM backend đều thất bại (chuỗi NVIDIA kimi-k3 → fallback chain — kiểm tra NVIDIA_API_KEY_1..4 trong .env)`)
}

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

// ==================== SETTINGS ====================

/**
 * USER DECISION #3 (2026-09-30): cột ủy quyền cũ (thời Omega) đã ĐỔI TÊN
 * opusDelegated (Prisma db push xong — xem prisma/schema.prisma). true = Opus
 * (CTO) duyệt/không duyệt đề xuất thay Mr. Architect + nhận đánh giá bước &
 * báo cáo hoàn thiện. Triển khai vẫn của Omega mọi lúc. Fail-open: DB lỗi →
 * coi như chưa ủy quyền.
 */
export async function getSelfDirectionSettings(): Promise<{ opusDelegated: boolean; delegatedAt: Date | null }> {
  try {
    const row = await db.selfDirectionSettings.findUnique({ where: { id: 'singleton' } })
    return { opusDelegated: row?.opusDelegated ?? false, delegatedAt: row?.delegatedAt ?? null }
  } catch {
    return { opusDelegated: false, delegatedAt: null }
  }
}

export async function setDelegation(enabled: boolean): Promise<void> {
  await db.selfDirectionSettings.upsert({
    where: { id: 'singleton' },
    create: { id: 'singleton', opusDelegated: enabled, delegatedAt: enabled ? new Date() : null },
    update: { opusDelegated: enabled, delegatedAt: enabled ? new Date() : null },
  })
}

// ==================== ROSTER / AGENT PERSONA ====================

/** Danh sách tên agent hợp lệ có thể nhận việc + text roster cho prompt */
async function rosterInfo(): Promise<{ names: string[]; text: string }> {
  try {
    const roster = await getAgentRoster()
    const names: string[] = []
    const lines: string[] = []
    const push = (label: string, entries: typeof roster.standalone) => {
      if (entries.length === 0) return
      lines.push(`${label}:`)
      for (const e of entries) {
        names.push(e.name)
        const skills = (e.capable || e.description || '').replace(/\s+/g, ' ').slice(0, 120)
        lines.push(`- ${e.name}${e.team ? ` [${e.team}${e.position ? '/' + e.position : ''}]` : ''}: ${skills}`)
      }
    }
    push('STANDALONE (orchestrator)', roster.standalone)
    push('CODE TEAM', roster.codeTeam)
    push('RESEARCH TEAM', roster.research)
    push('AGENTS KHÁC', roster.custom)
    if (!names.includes('Omega')) names.push('Omega')
    return { names, text: lines.join('\n').slice(0, 3500) || '(roster trống — chỉ có Omega)' }
  } catch {
    return { names: ['Omega'], text: '- Omega [standalone]: orchestrator tổng hợp' }
  }
}

/** Chuẩn hóa assignee LLM trả về → tên agent có thật trong roster */
function normalizeAssignee(assignee: string | undefined | null, validNames: string[]): string {
  if (!assignee) return 'Omega'
  const a = assignee.trim()
  if (!a) return 'Omega'
  const lower = a.toLowerCase()
  // Match chính xác (case-insensitive)
  const exact = validNames.find(n => n.toLowerCase() === lower)
  if (exact) return exact
  // Alias thường gặp
  if (lower.includes('team code') || lower.includes('code team') || lower === 'code' || lower.includes('team lead')) {
    return validNames.find(n => n === 'APEX') ?? 'Omega'
  }
  if (lower.includes('verif') || lower.includes('g3') || lower.includes('kiểm định')) {
    return validNames.find(n => n === 'CATALYST') ?? 'Omega'
  }
  if (lower.includes('generat') || lower.includes('g1')) {
    return validNames.find(n => n === 'CORTEX') ?? 'Omega'
  }
  if (lower.includes('g2')) {
    return validNames.find(n => n === 'BOLT') ?? 'Omega'
  }
  if (lower.includes('omega') || lower.includes('orchestrat')) return 'Omega'
  // Fuzzy: chứa tên agent
  const partial = validNames.find(n => lower.includes(n.toLowerCase()))
  if (partial) return partial
  return 'Omega'
}

/** Lấy persona (system prompt) của 1 agent theo tên */
async function agentPersona(name: string): Promise<{ systemPrompt: string; brain: { provider: string; model: string } }> {
  try {
    const p = await db.agentProfile.findFirst({
      where: { name, enabled: true },
      select: { instruction: true, provider: true, model: true, description: true, position: true, team: true },
    })
    if (p) {
      const base = p.instruction || `Bạn là ${name}${p.position ? ` (${p.position})` : ''}. ${p.description || ''}`
      return { systemPrompt: base, brain: { provider: p.provider || 'nvidia', model: p.model || 'moonshotai/kimi-k3' } }
    }
  } catch { /* fail-open */ }
  return {
    systemPrompt: `Bạn là ${name}, một agent trong hệ thống multi-agent TMO. Hoàn thành phần việc được giao một cách chuyên nghiệp, cụ thể và có kết quả rõ ràng.`,
    brain: OMEGA_FALLBACK_BRAIN,
  }
}

// ==================== PERSONA ỦY QUYỀN (USER DECISION #3) ====================

/**
 * USER DECISION #3 (2026-09-30, phê duyệt): ủy quyền phê duyệt SELF-DIRECTION
 * chuyển từ Omega sang OPUS (CTO). Helper chọn persona hệ thống cho các vai
 * trò nhận ủy quyền (đánh giá bước / viết báo cáo hoàn thiện):
 *   - opusDelegated=true  → OPUS: system prompt = OPUS_INSTRUCTION + vai trò
 *     hiện tại (ghi đè output format §X bằng format riêng của nhiệm vụ).
 *   - opusDelegated=false → giữ nguyên persona Omega cũ (đánh giá bước +
 *     báo cáo là việc NỘI TẠC orchestration của Omega — không phải ủy quyền).
 * Lập kế hoạch + triển khai + verify_and_push LUÔN của Omega (không đổi).
 *
 * 'evaluate' → systemPrompt là prompt HOÀN CHỈNH (persona + tiêu chí + output
 *   format JSON {"complete","evaluation"} — giữ nguyên format để logic rework
 *   của runOrchestrationInner không đổi).
 * 'report'   → systemPrompt CHỈ là phần persona mở đầu; writeFinalReport ghép
 *   tiếp khung báo cáo (khung cũ giữ nguyên).
 */
async function getReviewerSystemPrompt(kind: 'evaluate' | 'report'): Promise<{ systemPrompt: string; reviewerName: string }> {
  const { opusDelegated } = await getSelfDirectionSettings()
  if (opusDelegated) {
    const role =
      kind === 'evaluate'
        ? `Bạn là ${OPUS_AGENT_NAME} — CTO của TMO, đang được ủy quyền ĐÁNH GIÁ chất lượng công việc các agent bàn giao trong module Self-direction (thay Mr. Architect — user decision #3; Omega vẫn phụ trách triển khai).
Đánh giá THỰC TẾ, không khắt khe quá mức: output CHẤP NHẬN ĐƯỢC nếu agent đã làm phần việc chính của bước (kể cả chưa hoàn hảo mọi chi tiết). CHỈ đánh giá chưa đạt khi output (a) bỏ sót phần việc chính, (b) sai hướng với mô tả công việc, hoặc (c) quá chung chung/khung suông không có kết quả cụ thể nào. Phán quyết bằng bằng chứng — đối chiếu output với mô tả công việc (§II.1).

Output DUY NHẤT một JSON hợp lệ (KHÔNG markdown fence, KHÔNG giải thích ngoài — GHI ĐÈ format §X cho nhiệm vụ này):
{"complete": true|false, "evaluation": "nhận xét ngắn (1-3 câu, tiếng Việt): điểm đạt; nếu chưa đạt — nêu rõ CẦN BỔ SUNG GÌ cụ thể"}`
        : `Bạn là ${OPUS_AGENT_NAME} — CTO của TMO, đang được ủy quyền viết BÁO CÁO HOÀN THIỆN cho đề xuất Self-direction sau khi orchestration của Omega chạy xong (thay Mr. Architect — user decision #3). Viết bằng tiếng Việt, markdown đơn giản (chỉ dùng ## và **, KHÔNG bảng) — BÁO CÁO VĂN BẢN, KHÔNG phải JSON (GHI ĐÈ format §X cho nhiệm vụ này).`
    return {
      systemPrompt: `${OPUS_INSTRUCTION}

━━━ VAI TRÒ HIỆN TẠI (USER DECISION #3 — GHI ĐÈ FORMAT §X CHO NHIỆM VỤ NÀY) ━━━
${role}`,
      reviewerName: OPUS_AGENT_NAME,
    }
  }
  // KHÔNG ủy quyền → persona Omega cũ giữ nguyên (việc nội tại orchestration)
  return {
    systemPrompt:
      kind === 'evaluate'
        ? `Bạn là OMEGA — orchestrator, phụ trách ĐÁNH GIÁ chất lượng công việc các agent bàn giao trong module Self-direction.
Đánh giá THỰC TẾ, không khắt khe quá mức: output CHẤP NHẬN ĐƯỢC nếu agent đã làm phần việc chính của bước (kể cả chưa hoàn hảo mọi chi tiết). CHỈ đánh giá chưa đạt khi output (a) bỏ sót phần việc chính, (b) sai hướng với mô tả công việc, hoặc (c) quá chung chung/khung suông không có kết quả cụ thể nào.

Output DUY NHẤT một JSON hợp lệ (KHÔNG markdown fence):
{"complete": true|false, "evaluation": "nhận xét ngắn (1-3 câu, tiếng Việt): điểm đạt; nếu chưa đạt — nêu rõ CẦN BỔ SUNG GÌ cụ thể"}`
        : 'Bạn là OMEGA — orchestrator.',
    reviewerName: 'Omega',
  }
}

// ==================== 1. OPUS REVIEW — duyệt thay Mr. Architect ====================
// USER DECISION #3 (2026-09-30): duyệt chuyển từ Omega sang Opus (CTO) —
// khi ủy quyền (opusDelegated) bật, OPUS duyệt thay Mr. Architect.

/**
 * Opus review 1 đề xuất đang pending (khi được ủy quyền) → approve/reject.
 * Persona = OPUS_INSTRUCTION (CTO) + vai trò duyệt; quyết định ghi danh nghĩa
 * Opus (reviewer='opus', decisionReason "Opus duyệt/không duyệt: ...").
 * Fire-and-forget friendly: caller dùng void opusReviewPending(id).
 */
export async function opusReviewPending(proposalId: string): Promise<void> {
  if (reviewingProposals.has(proposalId)) return
  reviewingProposals.add(proposalId)
  try {
    const proposal = await db.selfDirectionProposal.findUnique({ where: { id: proposalId } })
    if (!proposal || proposal.status !== 'pending') return

    const systemPrompt = `${OPUS_INSTRUCTION}

━━━ VAI TRÒ HIỆN TẠI (USER DECISION #3 — GHI ĐÈ FORMAT §X CHO NHIỆM VỤ NÀY) ━━━
Bạn là ${OPUS_AGENT_NAME} — CTO của TMO, đang duyệt đề xuất SELF-DIRECTION thay Mr. Architect (được ủy quyền — user decision #3).
Quyết định của bạn có giá trị như quyết định của Mr. Architect. Hãy cân nhắc kỹ lưỡng:
- Đề xuất có giải quyết vấn đề thật không? Kế hoạch triển khai khả thi không?
- Ưu tiên càng cao càng cần triển khai sớm; đề xuất mơ hồ/lợi ích không rõ → từ chối kèm lý do để agent đề xuất lại.
- Sau khi duyệt, việc TRIỂN KHAI vẫn do orchestration của Omega đảm nhận — bạn chỉ quyết định duyệt hay không duyệt.

Output DUY NHẤT một JSON hợp lệ (KHÔNG markdown fence, KHÔNG giải thích ngoài — GHI ĐÈ format §X cho nhiệm vụ này):
{"decision": "approve" | "reject", "reason": "lý do ngắn gọn (1-3 câu, tiếng Việt)"}`

    const userPrompt = `ĐỀ XUẤT CẦN DUYỆT:
Tiêu đề: ${proposal.title}
Danh mục: ${proposal.category} | Ưu tiên: ${proposal.priority}

VẤN ĐỀ:
${proposal.problem.slice(0, 1200)}

GIẢI PHÁP ĐỀ XUẤT:
${proposal.solution.slice(0, 1200)}

CÁCH TRIỂN KHAI:
${proposal.implementation.slice(0, 1200)}

THỜI ĐIỂM ĐỀ XUẤT: ${proposal.scheduleAt ? new Date(proposal.scheduleAt).toLocaleString('vi-VN') : 'Ngay khi được duyệt'}
TÁC ĐỘNG KỲ VỌNG: ${(proposal.impact || '(không nêu)').slice(0, 500)}

GHI CHÚ CỦA MR. ARCHITECT (nếu có):
${(proposal.userNotes || '(không có)').slice(0, 800)}

Quyết định duyệt hay không duyệt (JSON).`

    const raw = await callBrain({ prompt: userPrompt, systemPrompt, maxTokens: 400, label: `OpusReview ${proposal.id.slice(0, 8)}` })
    const jsonStr = findBalancedJson(raw.replace(/```(?:json)?/g, ''), 'decision')
    if (!jsonStr) throw new Error('Không parse được verdict JSON')
    const obj = JSON.parse(jsonStr) as Record<string, unknown>
    const verdict: SdReviewVerdict = {
      decision: obj.decision === 'approve' ? 'approve' : 'reject',
      reason: typeof obj.reason === 'string' ? obj.reason.slice(0, 600) : '',
    }

    const now = new Date()
    const dueNow = !proposal.scheduleAt || proposal.scheduleAt.getTime() <= now.getTime()
    if (verdict.decision === 'approve') {
      await db.selfDirectionProposal.update({
        where: { id: proposalId },
        data: {
          status: dueNow ? 'ready' : 'approved',
          // USER DECISION #3: duyệt chuyển từ Omega sang Opus — danh nghĩa Opus
          reviewer: 'opus',
          decisionReason: `Opus duyệt: ${verdict.reason}`,
          reviewedAt: now,
        },
      })
      if (dueNow) void triggerOrchestration(proposalId)
      console.log(`[SelfDirection] Opus DUYỆT "${proposal.title}"${dueNow ? ' → kích hoạt triển khai' : ` (hẹn lịch ${proposal.scheduleAt?.toISOString()})`}: ${verdict.reason}`)
    } else {
      await db.selfDirectionProposal.update({
        where: { id: proposalId },
        data: {
          status: 'rejected',
          reviewer: 'opus',
          decisionReason: `Opus không duyệt: ${verdict.reason}`,
          reviewedAt: now,
        },
      })
      console.log(`[SelfDirection] Opus TỪ CHỐI "${proposal.title}": ${verdict.reason}`)
    }
  } catch (err) {
    // Review fail → giữ pending (Mr. Architect vẫn duyệt thủ công được)
    console.warn(`[SelfDirection] OpusReview ${proposalId} lỗi (giữ pending):`, err instanceof Error ? err.message : String(err))
  } finally {
    reviewingProposals.delete(proposalId)
  }
}

/**
 * @deprecated Alias cũ (thời Omega duyệt). USER DECISION #3 (2026-09-30): duyệt
 * chuyển sang Opus — gọi opusReviewPending(). Giữ alias cho các import hiện có
 * / agents song song (13-b/c) đang phát triển song song.
 */
export const omegaReviewPending = opusReviewPending

// ==================== 2. PLAN — Omega lập kế hoạch triển khai ====================

/**
 * CI-6 B5 — bước này có phải bước CUỐI verify_and_push (pipeline kiểm định
 * thật) không? Chỉ xét ở vị trí cuối kế hoạch: marker "verify_and_push" trong
 * title, hoặc bước cuối giao Omega với title chỉ dấu pipeline/kiểm định.
 */
export function isVerifyAndPushStep(step: Pick<SdPlanStep, 'title' | 'assignee'>, isLastStep: boolean): boolean {
  if (!isLastStep) return false
  if (/verify_and_push/i.test(step.title)) return true
  return step.assignee === 'Omega' && VERIFY_AND_PUSH_TITLE_RE.test(step.title)
}

/**
 * CI-6 B5 — bảo đảm kế hoạch code-workflow LUÔN kết thúc bằng bước verify_and_push
 * giao Omega (LLM có thể quên/sai tên marker). Bước cuối hợp lệ giữ nguyên;
 * ngược lại chèn bước chuẩn (giữ tổng ≤ MAX_PLAN_STEPS).
 */
function ensureFinalVerifyStep(steps: SdPlanStep[]): SdPlanStep[] {
  if (steps.length === 0) return steps
  if (isVerifyAndPushStep(steps[steps.length - 1], true)) return steps
  const capped = steps.slice(0, MAX_PLAN_STEPS - 1)
  capped.push({
    title: 'Kiểm định & đẩy code (verify_and_push)',
    description: 'Omega chạy pipeline kiểm định 9 bước THẬT trên workspace active: lint → type_check → run_tests → smoke → secret_scan → git_preflight → commit (scoped paths) → push → pull verify. Bước CHỈ ĐẠT khi pipeline PASS. Cây làm việc sạch → pipeline trả "không có gì để commit" và bước vẫn đạt (đề xuất có thể chỉ mang tính phân tích).',
    assignee: 'Omega',
  })
  return capped
}

async function generateWorkPlan(proposal: {
  title: string; problem: string; solution: string; implementation: string
  impact: string | null; userNotes: string | null; executionMode: string
}): Promise<SdWorkPlan> {
  const { names, text } = await rosterInfo()
  const isCodeWorkflow = proposal.executionMode === 'code-workflow'

  const codeWorkflowBlock = isCodeWorkflow ? `

⚡ CHẾ ĐỘ CODE-WORKFLOW (CI-6 B5 — đề xuất này THAY ĐỔI CODE THẬT trong workspace):
- Các bước triển khai giao agents chỉnh sửa code THẬT qua tool executor (BOLT implement, SENTINEL review/bug, CORTEX thiết kế API/schema, CATALYST tối ưu/hiệu năng...).
- Bước CUỐI CÙNG PHẢI là "Kiểm định & đẩy code" giao cho CHÍNH BẠN (Omega), tiêu đề CHỨA "verify_and_push" — bước này chạy pipeline kiểm định 9 bước thật (lint → type_check → tests → smoke → secret_scan → commit scoped → push → pull verify). KHÔNG giao bước commit/push cho agent khác, KHÔNG thêm bước kiểm định khác sau nó.` : ''

  const systemPrompt = `Bạn là OMEGA — orchestrator của hệ thống multi-agent TMO. Một đề xuất cải tiến hệ thống VỪA ĐƯỢC Mr. Architect phê duyệt. Nhiệm vụ của bạn: lập KẾ HOẠCH TRIỂN KHAI chi tiết.

Nguyên tắc lập kế hoạch:
- Chia công việc thành 3-6 bước tuần tự hợp lý (tối đa ${MAX_PLAN_STEPS}), mỗi bước 1 việc rõ ràng có kết quả kiểm chứng được.
- Giao đúng người: xem AGENT ROSTER bên dưới — chọn agent có chuyên môn phù hợp nhất từng bước.
- Bước cuối cùng LUÔN là kiểm định/nghiệm thu (giao verifier hoặc chính bạn).
- Mô tả từng bước đủ cụ thể để agent thực hiện không cần hỏi lại.${codeWorkflowBlock}

Output DUY NHẤT một JSON hợp lệ (KHÔNG markdown fence):
{"planSummary": "tóm tắt kế hoạch 1-2 câu", "steps": [{"title": "tên bước ngắn", "description": "mô tả cụ thể cần làm gì, tiêu chí hoàn thành", "assignee": "TÊN agent trong roster"}]}`

  const userPrompt = `ĐỀ XUẤT ĐÃ DUYỆT: ${proposal.title}

VẤN ĐỀ:
${proposal.problem.slice(0, 1500)}

GIẢI PHÁP:
${proposal.solution.slice(0, 1500)}

CÁCH TRIỂN KHAI:
${proposal.implementation.slice(0, 1500)}

TÁC ĐỘNG KỲ VỌNG: ${(proposal.impact || '(không nêu)').slice(0, 500)}
GHI CHÚ CỦA MR. ARCHITECT (bắt buộc tôn trọng nếu có):
${(proposal.userNotes || '(không có)').slice(0, 800)}

AGENT ROSTER:
${text}

Lập kế hoạch triển khai (JSON).`

  try {
    const raw = await callBrain({ prompt: userPrompt, systemPrompt, maxTokens: 1600, temperature: 0.4, label: 'OmegaPlan' })
    const jsonStr = findBalancedJson(raw.replace(/```(?:json)?/g, ''), 'steps')
    if (jsonStr) {
      const obj = JSON.parse(jsonStr) as Record<string, unknown>
      const rawSteps = Array.isArray(obj.steps) ? obj.steps : []
      let steps: SdPlanStep[] = rawSteps
        .filter((s): s is Record<string, unknown> => !!s && typeof s === 'object')
        .slice(0, MAX_PLAN_STEPS)
        .map(s => ({
          title: String(s.title || 'Bước').slice(0, 150),
          description: String(s.description || '').slice(0, 800),
          assignee: normalizeAssignee(typeof s.assignee === 'string' ? s.assignee : null, names),
        }))
      if (steps.length > 0) {
        // CI-6 B5: kế hoạch code-workflow PHẢI kết thúc bằng verify_and_push (Omega)
        if (isCodeWorkflow) steps = ensureFinalVerifyStep(steps)
        // Mọi step kế thừa executionMode của proposal (per-step flag)
        steps = steps.map(s => ({ ...s, executionMode: proposal.executionMode }))
        return {
          planSummary: String(obj.planSummary || `Kế hoạch ${steps.length} bước do Omega lập`).slice(0, 500),
          steps,
        }
      }
    }
    throw new Error('Plan JSON rỗng/sai shape')
  } catch (err) {
    console.warn('[SelfDirection] OmegaPlan lỗi — dùng kế hoạch mặc định:', err instanceof Error ? err.message : String(err))
    return defaultPlan(proposal.title, names, proposal.executionMode)
  }
}

function defaultPlan(title: string, validNames: string[], executionMode = 'llm'): SdWorkPlan {
  const pick = (n: string) => (validNames.includes(n) ? n : 'Omega')
  const steps: SdPlanStep[] = [
    { title: 'Phân tích & thiết kế giải pháp chi tiết', description: `Phân tích vấn đề của đề xuất "${title.slice(0, 80)}", xác định yêu cầu, rủi ro, thiết kế giải pháp cụ thể trước khi triển khai. Kết quả: bản thiết kế rõ ràng các việc cần làm.`, assignee: pick('APEX'), executionMode },
    { title: 'Triển khai phần lõi của giải pháp', description: 'Thực hiện phần việc chính theo thiết kế ở bước 1. Kết quả: phần lõi hoàn thành kèm mô tả cụ thể đã làm gì.', assignee: pick('CORTEX'), executionMode },
    { title: 'Triển khai phần bổ trợ & tích hợp', description: 'Hoàn thiện các phần phụ thuộc, tích hợp phần lõi vào tổng thể hệ thống. Kết quả: hệ thống đồng bộ, không bỏ sót.', assignee: pick('BOLT'), executionMode },
    { title: 'Kiểm định chất lượng & nghiệm thu', description: 'Kiểm tra kết quả triển khai theo tiêu chí đề xuất, xác nhận vấn đề gốc đã được giải quyết. Kết quả: verdict đạt/không đạt kèm bằng chứng.', assignee: pick('CATALYST'), executionMode },
  ]
  // CI-6 B5: fallback plan cho code-workflow cũng phải có bước cuối verify_and_push
  if (executionMode === 'code-workflow') {
    steps.push({
      title: 'Kiểm định & đẩy code (verify_and_push)',
      description: 'Omega chạy pipeline kiểm định 9 bước THẬT trên workspace active (lint → type_check → run_tests → smoke → secret_scan → commit scoped → push → pull verify). Bước CHỈ ĐẠT khi pipeline PASS; cây sạch → "không có gì để commit" vẫn đạt.',
      assignee: 'Omega',
      executionMode,
    })
  }
  return {
    planSummary: `Kế hoạch mặc định ${steps.length} bước (LLM không phản hồi — fallback): phân tích → triển khai lõi → tích hợp → kiểm định${executionMode === 'code-workflow' ? ' + pipeline verify_and_push' : ''}, cho đề xuất "${title.slice(0, 80)}".`,
    steps,
  }
}

// ==================== 3. EXECUTE — agent thực hiện 1 bước ====================

async function executeStep(params: {
  proposal: { title: string; problem: string; solution: string; implementation: string; userNotes: string | null }
  step: { stepOrder: number; title: string; description: string; assignee: string }
  previousOutputs: Array<{ title: string; output: string }>
  reworkFeedback?: string | null
}): Promise<string> {
  const { proposal, step, previousOutputs, reworkFeedback } = params
  const persona = await agentPersona(step.assignee)

  const systemPrompt = `${persona.systemPrompt}

═══════════════════════════════════════════
 CHẾ ĐỘ THỰC THI BƯỚC KẾ HOẠCH (SELF-DIRECTION)
═══════════════════════════════════════════
Bạn đang thực hiện 1 bước trong kế hoạch triển khai đề xuất đã được Mr. Architect phê duyệt. Viết báo cáo output NGẮN GỌN, CỤ THỂ (tối đa ~250 từ): đã làm gì, kết quả gì, còn vấn đề gì. KHÔNG markdown heading lớn, KHÔNG tool_call — chỉ text báo cáo.`

  const handover = previousOutputs.length > 0
    ? previousOutputs.map(p => `• [Bước "${p.title}"]: ${p.output.slice(0, 500)}`).join('\n')
    : '(bước đầu tiên — chưa có bàn giao)'

  const userPrompt = `ĐỀ XUẤT ĐANG TRIỂN KHAI: ${proposal.title}
VẤN ĐỀ GỐC: ${proposal.problem.slice(0, 600)}
GIẢI PHÁP ĐÃ DUYỆT: ${proposal.solution.slice(0, 600)}
${proposal.userNotes ? `GHI CHÚ MR. ARCHITECT (bắt buộc tuân thủ): ${proposal.userNotes.slice(0, 400)}` : ''}

KẾT QUẢ BÀN GIAO TỪ CÁC BƯỚC TRƯỚC:
${handover}

BẠN (${step.assignee}) THỰC HIỆN BƯỚC ${step.stepOrder}: ${step.title}
MÔ TẢ CÔNG VIỆC: ${step.description}
${reworkFeedback ? `\n⚠️ PHẢN HỒI TỪ OMEGA VỀ LẦN THỬ TRƯỚC (chưa đạt — phải khắc phục): ${reworkFeedback.slice(0, 600)}` : ''}

Viết báo cáo output của bạn.`

  try {
    // callLLMForAgent: chuỗi NVIDIA (kimi-k3 → fallback chain) — z-ai-sdk
    // fallback đã gỡ (2026-10-15)
    const result = await withTimeout(
      callLLMForAgent(userPrompt, persona.brain, systemPrompt, {
        agentName: step.assignee,
        temperature: 0.5,
        maxTokens: 900,
      }),
      LLM_TIMEOUT_MS,
      `StepExec ${step.assignee} (NVIDIA chain)`,
    )
    if (result.content && result.content.trim()) return result.content.trim().slice(0, 3000)
  } catch (err) {
    console.warn(`[SelfDirection] executeStep ${step.assignee} callLLMForAgent lỗi:`, err instanceof Error ? err.message : String(err))
  }
  // ━━ USER REQUEST (2026-09-02): KHÔNG throw làm sập pipeline ━━
  // Trước đây: cả 2 LLM call fail → throw Error → runOrchestration catch →
  // proposal.status='failed' → pipeline DỪNG hoàn toàn. Điều này khiến các
  // đề xuất được duyệt nhưng KHÔNG thể hoàn thành khi NIM keys placeholder.
  // Fix: trả output cảnh báo (KHÔNG phải output thật) — evaluateStep sẽ thấy
  // output "chưa đạt" → retry (MAX_STEP_ATTEMPTS). Nếu retry vẫn fail → step
  // failed nhưng proposal có thể tiếp tục bước khác (KHÔNG sập toàn pipeline).
  return `[${step.assignee} chưa tạo được output do LLM unavailable — cần retry]`
}

// ==================== 3b. EXECUTE CODE-WORKFLOW — ReAct với TOOL THẬT (CI-6 B5) ====================

/**
 * LLM call cho ReAct loop code-workflow: callLLMForAgent (persona brain) —
 * chuỗi NVIDIA model-first (kimi-k3 → fallback chain). z-ai-sdk fallback
 * đã gỡ (2026-10-15) — LLM fail trả null, caller tổng hợp output trung thực.
 */
async function callStepBrain(params: {
  prompt: string
  systemPrompt: string
  brain: { provider: string; model: string }
  agentName: string
  label: string
}): Promise<string | null> {
  const { prompt, systemPrompt, brain, agentName, label } = params
  try {
    const result = await withTimeout(
      callLLMForAgent(prompt, brain, systemPrompt, {
        agentName,
        temperature: 0.4,
        maxTokens: 1400,
      }),
      LLM_TIMEOUT_MS,
      `${label} (${agentName}) (NVIDIA chain)`,
    )
    if (result.content && result.content.trim()) return result.content.trim()
    // FIX 2026-10-15 (user report "output trống lần cuối"): content rỗng là LỖI
    // thật — log rõ error của chuỗi để truy nguyên nhân (key/timeout/model)
    // thay vì im lặng trả null khiến evaluateStep đánh giá output trống mù.
    console.warn(
      `[SelfDirection] ${label} (${agentName}): LLM trả content rỗng — error: ${(result.error || '(không có error detail)').slice(0, 200)}`,
    )
  } catch (err) {
    console.warn(`[SelfDirection] ${label} (${agentName}): LLM call lỗi:`, err instanceof Error ? err.message : String(err))
  }
  return null
}

/** Tool-result → message string cap ký tự (chống context nổ trong ReAct loop) */
function sdToolResultToMessage(tool: string, success: boolean, result: unknown): string {
  let content: string
  try {
    content = JSON.stringify({ tool, success, result })
  } catch {
    content = JSON.stringify({ tool, success, result: String(result).slice(0, 2000) })
  }
  return content.length > SD_CODE_TOOL_RESULT_CAP ? `${content.slice(0, SD_CODE_TOOL_RESULT_CAP)}…(cắt)` : content
}

/**
 * CI-6 B5 — thực thi 1 bước GIỮA của proposal code-workflow: agent persona
 * ReAct qua TOOL THẬT (executeTool chạy file tools, git_status, lint... trên
 * workspace active). LLM đề xuất tool_call → thực thi thật → đẩy kết quả
 * vào conversation → lặp tới khi agent kết luận (hoặc chạm trần guard:
 * ${SD_CODE_STEP_MAX_TOOL_CALLS} tool call / ${SD_CODE_STEP_MAX_TURNS} lượt LLM).
 * Context shape executeTool mirror agent-goal-loop.ts: { agentName, sessionId }.
 */
async function executeCodeStepWithTools(params: {
  proposal: { id: string; title: string; problem: string; solution: string; implementation: string; userNotes: string | null }
  step: { stepOrder: number; title: string; description: string; assignee: string }
  previousOutputs: Array<{ title: string; output: string }>
  reworkFeedback?: string | null
}): Promise<{ output: string; receipt: SdToolBatchReceipt }> {
  const { proposal, step, previousOutputs, reworkFeedback } = params
  const persona = await agentPersona(step.assignee)
  const sessionId = `sd-${proposal.id}`

  const systemPrompt = `${persona.systemPrompt}

═══════════════════════════════════════════
 CHẾ ĐỘ CODE-WORKFLOW — THỰC THI WORKSPACE THẬT (SELF-DIRECTION)
═══════════════════════════════════════════
Bạn đang thực hiện 1 bước kế hoạch cần THAY ĐỔI CODE THẬT trong workspace active. Bạn có TOOL THẬT — mọi tool call thực thi thật trên hệ thống file và git của workspace.

Cú pháp tool call (1 hoặc nhiều trong 1 lượt, mỗi call 1 dòng):
tool_call: tên_tool({"tham_số": "giá trị"})

Tools khả dụng: ${[...SD_CODE_TOOL_ALLOWLIST].join(', ')}.

Quy tắc:
- Đọc file trước khi sửa (file_read). Tạo file mới/file lớn: file_write chia phần (~200-400 dòng/lần, lần đầu mode "overwrite", các lần sau "append").
- KHÔNG commit/push/pull (bị chặn ở bước này) — pipeline kiểm định ở bước CUỐI sẽ commit + push mọi thay đổi.
- Giới hạn ${SD_CODE_STEP_MAX_TOOL_CALLS} tool call cho bước này — làm phần việc CHÍNH, gọn.
- Xong (hoặc hết ngân sách): viết báo cáo output text thuần (KHÔNG tool_call, ~150 từ): đã làm gì, file nào đã sửa/tạo (đường dẫn), bằng chứng kiểm chứng (lint/type_check/file_read), còn vấn đề gì.`

  const handover = previousOutputs.length > 0
    ? previousOutputs.map(p => `• [Bước "${p.title}"]: ${p.output.slice(0, 400)}`).join('\n')
    : '(bước đầu tiên — chưa có bàn giao)'

  const userPrompt = `ĐỀ XUẤT ĐANG TRIỂN KHAI (code-workflow): ${proposal.title}
VẤN ĐỀ GỐC: ${proposal.problem.slice(0, 600)}
GIẢI PHÁP ĐÃ DUYỆT: ${proposal.solution.slice(0, 600)}
${proposal.userNotes ? `GHI CHÚ MR. ARCHITECT (bắt buộc tuân thủ): ${proposal.userNotes.slice(0, 400)}` : ''}

KẾT QUẢ BÀN GIAO TỪ CÁC BƯỚC TRƯỚC:
${handover}

BẠN (${step.assignee}) THỰC HIỆN BƯỚC ${step.stepOrder}: ${step.title}
MÔ TẢ CÔNG VIỆC: ${step.description}
${reworkFeedback ? `\n⚠️ PHẢN HỒI TỪ OMEGA VỀ LẦN THỬ TRƯỚC (chưa đạt — phải khắc phục): ${reworkFeedback.slice(0, 600)}` : ''}

Bắt đầu: khảo sát bằng tool (git_status/file_list/file_read) rồi sửa code thật. Kết thúc bằng báo cáo text thuần.`

  const messages: Array<{ role: 'user' | 'assistant' | 'tool'; content: string }> = [
    { role: 'user', content: userPrompt },
  ]
  const toolCallsLog: Array<{ tool: string; success: boolean }> = []
  let lastAssistant = ''
  let output = ''
  // FIX 2026-10-15: đếm lượt LLM fail — tổng hợp vào output trung thực khi cả
  // ReAct loop chết vì LLM (không còn output rỗng → evaluateStep không rơi vào
  // fail-open mù "output trống lần cuối, chấp nhận để mở kẹt pipeline").
  let llmFailTurns = 0

  for (let turn = 1; turn <= SD_CODE_STEP_MAX_TURNS; turn++) {
    const formatted = formatMessagesForLLM(messages)
    const content = await callStepBrain({
      prompt: formatted,
      systemPrompt,
      brain: persona.brain,
      agentName: step.assignee,
      label: `CodeStep ${step.stepOrder}`,
    })
    if (!content) {
      llmFailTurns++
      break
    }
    lastAssistant = content
    messages.push({ role: 'assistant', content })

    const toolCalls = parseToolCallsFromOutput(content)
    if (toolCalls.length === 0) {
      output = content // agent đã kết luận — báo cáo text thuần
      break
    }

    for (const tc of toolCalls) {
      const budgetLeft = SD_CODE_STEP_MAX_TOOL_CALLS - toolCallsLog.length
      if (budgetLeft <= 0) {
        messages.push({
          role: 'tool',
          content: sdToolResultToMessage(tc.name, false, 'Đã đạt giới hạn tool call của bước — KHÔNG thực thi. Hãy viết báo cáo output cuối (text thuần).'),
        })
        continue
      }
      if (!SD_CODE_TOOL_ALLOWLIST.has(tc.name)) {
        messages.push({
          role: 'tool',
          content: sdToolResultToMessage(tc.name, false, `Tool không khả dụng ở bước này. Cho phép: ${[...SD_CODE_TOOL_ALLOWLIST].join(', ')}. KHÔNG tự commit/push — pipeline bước cuối sẽ làm.`),
        })
        continue
      }
      // FIX review GĐ2 #3: shell bị chặn lệnh git commit/push/pull... — pipeline
      // bước cuối là đường DUY NHẤT đẩy code (invariant thực thi, không chỉ prompt)
      if (tc.name === 'shell' && !sdShellCommandAllowed((tc.args as { command?: unknown } | undefined)?.command)) {
        toolCallsLog.push({ tool: tc.name, success: false })
        messages.push({
          role: 'tool',
          content: sdToolResultToMessage(tc.name, false, 'Lệnh shell chứa git commit/push/pull/merge/rebase/reset/remote — BỊ CHẶN ở bước code-workflow. Pipeline verify_and_push ở bước CUỐI sẽ commit + push sau khi qua kiểm định đầy đủ. Hãy tiếp tục phần việc code.'),
        })
        continue
      }
      // THỰC THI THẬT trong workspace active — executeTool của tool-executor
      // (context mirror agent-goal-loop: agentName + sessionId sd-<proposalId>)
      const res = await executeTool(tc.name, tc.args, { agentName: step.assignee, sessionId })
      toolCallsLog.push({ tool: tc.name, success: res.success })
      messages.push({ role: 'tool', content: sdToolResultToMessage(tc.name, res.success, res.result) })
    }

    if (toolCallsLog.length >= SD_CODE_STEP_MAX_TOOL_CALLS) {
      messages.push({
        role: 'user',
        content: '⚠️ Đã dùng hết ngân sách tool call của bước. Viết báo cáo output cuối NGAY (text thuần, KHÔNG tool_call): đã làm gì, file đã sửa, bằng chứng, còn thiếu gì.',
      })
    }
  }

  if (!output) {
    // Loop kết thúc không có báo cáo text thuần (hết lượt/kẹt): nếu có tool call
    // thì tổng hợp TRUNG THỰC từ tool log (lastAssistant lúc này chứa tool_call
    // thô — không phải báo cáo); không có tool call thì giữ text LLM cuối.
    // FIX 2026-10-15 (user report "output trống lần cuối"): khi LLM fail ngay
    // lượt đầu (toolCallsLog rỗng + lastAssistant rỗng) → output TRƯỚC ĐÂY là
    // chuỗi rỗng → evaluateStep đánh giá mù → sau 3 lần thử fail-open
    // "chấp nhận để mở kẹt pipeline" với evaluation rỗng. Giờ trả cảnh báo
    // trung thực (mirror executeStep llm-mode) — evaluateStep thấy output KHÔNG
    // trống + rõ nguyên nhân → step failed đúng nghĩa, KHÔNG đánh lừa completed.
    output = toolCallsLog.length > 0
      ? `Đã thực thi ${toolCallsLog.length} tool call trong workspace thật (${toolCallsLog.filter(t => t.success).length} thành công): ${toolCallsLog.map(t => `${t.tool}${t.success ? '✓' : '✗'}`).join(', ')}. Agent không viết báo cáo tổng kết (hết lượt LLM) — xem chi tiết tool receipts trong workspaceReceipt.`
      : lastAssistant || `[${step.assignee} chưa tạo được output do LLM call thất bại${llmFailTurns > 0 ? ` (${llmFailTurns} lượt fail — chuỗi NVIDIA kimi-k3 → fallback chain đều lỗi, kiểm tra NVIDIA_API_KEY_1..4 trong .env / timeout / model)` : ''} — cần retry]`
  }
  console.log(`[SelfDirection] CodeStep ${step.stepOrder} [${step.assignee}] thực thi THẬT ${toolCallsLog.length} tool call (${toolCallsLog.filter(t => t.success).length} ok)${llmFailTurns > 0 ? ` — ${llmFailTurns} lượt LLM fail` : ''}`)
  return {
    output: output.slice(0, 3000),
    receipt: { kind: 'tool-batch', toolCalls: toolCallsLog, executedAt: new Date().toISOString() },
  }
}

// ==================== 3c. FINAL STEP — verify_and_push PIPELINE THẬT (CI-6 B5) ====================

/** Slug hóa tiêu đề đề xuất cho commit message (bỏ dấu tiếng Việt) */
function slugifyTitle(title: string): string {
  return title
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 72)
}

/** Commit message chuẩn cho đề xuất SELF-DIRECTION (CI-6 B5) */
export function buildSelfDirectionCommitMessage(proposal: { id: string; title: string }, planSummary: string | null): string {
  const slug = slugifyTitle(proposal.title) || 'de-xuat'
  const oneLine = (planSummary || 'Triển khai theo kế hoạch Omega (Self-direction)')
    .split('\n')[0]
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 140)
  return `self-direction: ${slug} (${proposal.id})\n\n${oneLine}\n\nTriển khai từ đề xuất SELF-DIRECTION`
}

/**
 * CI-6 B5 — bước CUỐI của proposal code-workflow: chạy pipeline kiểm định
 * TRƯỚC KHI PUSH thật (runPrePushVerification — 9 bước: lint → typecheck →
 * tests → smoke → secret-scan → git-preflight → commit scoped → push →
 * pull-verify) trên workspace active. Thành công của bước = pipeline PASS.
 * Cây làm việc sạch → pipeline trả "không có gì để commit" (success, không
 * commit/push) → bước vẫn ĐẠT kèm ghi chú (đề xuất có thể chỉ phân tích).
 */
export async function executeVerifyAndPushStep(params: {
  proposal: { id: string; title: string }
  planSummary: string | null
  dryRun?: boolean
}): Promise<{ output: string; receipt: SdPipelineReceipt; success: boolean }> {
  const { proposal, planSummary, dryRun = false } = params
  const commitMessage = buildSelfDirectionCommitMessage(proposal, planSummary)
  const smokeUrl = process.env.TMO_SMOKE_URL || 'http://localhost:3000/'

  let result: PrePushResult
  try {
    result = await runPrePushVerification({ commitMessage, smokeUrl, dryRun })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[SelfDirection] verify_and_push pipeline lỗi ngoài dự kiến:', msg)
    result = { success: false, steps: [], error: `Pipeline lỗi ngoài dự kiến: ${msg}` }
  }

  const receipt: SdPipelineReceipt = {
    ...result,
    kind: 'pre-push-pipeline',
    executedAt: new Date().toISOString(),
    ...(dryRun ? { dryRun: true } : {}),
  }

  const lines = [
    `Bước kiểm định & triển khai code (verify_and_push)${dryRun ? ' [DRY-RUN]' : ''} — pipeline ${result.success ? 'ĐẠT' : 'THẤT BẠI'}.`,
    ...result.steps.map(s => `- ${s.name}: ${s.status}${typeof s.durationMs === 'number' ? ` (${Math.round(s.durationMs / 100) / 10}s)` : ''} — ${(s.detail || '').slice(0, 160)}`),
  ]
  if (result.commitHash) lines.push(`Commit: ${result.commitHash}`)
  else if (result.success) lines.push('Không có commit — cây làm việc sạch, không có gì để commit (đề xuất có thể chỉ mang tính phân tích/tư vấn).')
  lines.push(`Push: ${result.pushed ? 'đã push lên remote' : 'không push (skip/thất bại)'}`)
  lines.push(`Pull verify: ${result.pulled ? 'đã pull ff-only xác nhận đồng bộ' : 'không pull (skip/thất bại)'}`)
  if (result.error) lines.push(`Lỗi pipeline: ${result.error}`)

  return { output: lines.join('\n').slice(0, 3000), receipt, success: result.success }
}

// ==================== 4. EVALUATE — đánh giá bước (Opus khi ủy quyền bật, Omega khi tắt) ====================

/**
 * FIX 2026-09-02 (Omega audit #4): đánh dấu TÊN NGƯỜI CHẤM đầu chuỗi evaluation
 * dạng "[Tên] " — UI (self-direction-module.tsx) đọc marker này để hiển thị đúng
 * "Đánh giá của Opus" / "Đánh giá của Omega" thay vì hardcode Omega. Chỉ đánh
 * marker khi reviewer ≠ Omega (tương thích ngược: dữ liệu cũ không marker =
 * Omega chấm). Đồng bộ convention prefix "**Báo cáo của Opus**" của writeFinalReport.
 */
function tagEvaluation(reviewerName: string, text: string): string {
  return reviewerName !== 'Omega' ? `[${reviewerName}] ${text}` : text
}

/**
 * USER DECISION #3: khi ủy quyền bật (opusDelegated=true) → OPUS (CTO) chấm
 * bước đạt/chưa đạt (system prompt = OPUS_INSTRUCTION + context đánh giá);
 * khi tắt → Omega chấm như cũ (việc nội tại orchestration). Output format
 * {"complete","evaluation"} GIỮ NGUYÊN cả 2 nhánh → logic rework
 * (MAX_STEP_ATTEMPTS + reworkFeedback) không đổi.
 */
async function evaluateStep(params: {
  step: { stepOrder: number; title: string; description: string; assignee: string }
  output: string
  attempt: number
}): Promise<SdStepEvaluation> {
  const { systemPrompt, reviewerName } = await getReviewerSystemPrompt('evaluate')

  const userPrompt = `BƯỚC ${params.step.stepOrder}: ${params.step.title} (agent thực hiện: ${params.step.assignee})
MÔ TẢ CÔNG VIỆC: ${params.step.description}

OUTPUT AGENT BÀN GIAO (lần thử ${params.attempt}/${MAX_STEP_ATTEMPTS}):
${params.output.slice(0, 2000)}

Đánh giá (JSON).`

  try {
    const raw = await callBrain({ prompt: userPrompt, systemPrompt, maxTokens: 350, temperature: 0.2, label: `StepEval ${params.step.stepOrder}` })
    const jsonStr = findBalancedJson(raw.replace(/```(?:json)?/g, ''), 'complete')
    if (jsonStr) {
      const obj = JSON.parse(jsonStr) as Record<string, unknown>
      return {
        complete: obj.complete === true || obj.complete === 'true',
        evaluation: tagEvaluation(
          reviewerName,
          typeof obj.evaluation === 'string' ? obj.evaluation.slice(0, 600) : '',
        ),
      }
    }
  } catch (err) {
    console.warn('[SelfDirection] StepEval lỗi — KHÔNG auto-accept mù:', err instanceof Error ? err.message : String(err))
  }
  // ━━ USER REQUEST (2026-09-02): KHÔNG fail-open auto-accept mù ━━
  // Trước đây: Opus/Omega không đánh giá được → complete:true (accept output mù)
  // → pipeline chấp nhận output rỗng/sai → proposal "hoàn thành" nhưng code lỗi.
  // Fix: nếu không đánh giá được → complete:false + evaluation cảnh báo, cho
  // phép retry (MAX_STEP_ATTEMPTS). CHỈ khi output thực sự trống/rõ ràng fail
  // mới được fail-open (tránh kẹt pipeline hoàn toàn khi attempt cuối).
  //
  // FIX 2026-10-15: callers giờ KHÔNG còn sinh output rỗng (executeStep +
  // executeCodeStepWithTools đều có fallback text trung thực) → nhánh fail-open
  // dưới chỉ còn là lưới an toàn; evaluation message nêu nguyên nhân LLM lỗi để
  // user biết phải fix gì (không còn câu chung chung "output trống").
  const outputEmpty = !params.output || params.output.trim().length === 0
  if (outputEmpty && params.attempt >= MAX_STEP_ATTEMPTS) {
    // Lần cuối + output trống → fail-open để pipeline tiếp tục (tránh kẹt vĩnh viễn)
    return { complete: true, evaluation: tagEvaluation(reviewerName, `(không đánh giá được — output trống lần cuối + LLM đánh giá lỗi chuỗi NVIDIA, chấp nhận để mở kẹt pipeline — xem log [SelfDirection] StepEval để truy nguyên nhân)`) }
  }
  // Còn lại: KHÔNG accept — retry với feedback cảnh báo
  return {
    complete: false,
    evaluation: tagEvaluation(reviewerName, `(không đánh giá được — KHÔNG chấp nhận mù, cần agent làm lại output chất lượng hơn)`),
  }
}

// ==================== 5. REPORT — báo cáo hoàn thiện (Opus khi ủy quyền bật, Omega khi tắt) ====================

/** Rút gọn receipt pipeline thành text đan vào prompt báo cáo (CI-6 B5) */
function pipelineReceiptToText(r: SdPipelineReceiptSummary): string {
  const stepLines = r.steps.map(s => `  - ${s.name}: ${s.status}${s.detail ? ` — ${s.detail.slice(0, 120)}` : ''}`).join('\n')
  return [
    `- Tổng quan pipeline: ${r.success ? 'PASS' : 'FAIL'}${r.error ? ` — ${r.error.slice(0, 200)}` : ''}`,
    `- Các bước kiểm định:\n${stepLines}`,
    `- Commit: ${r.commitHash || '(không có — cây làm việc sạch, không có gì để commit)'}`,
    `- Push: ${r.pushed ? 'đã push lên remote' : 'chưa/không push'} | Pull verify: ${r.pulled ? 'đã pull ff-only xác nhận' : 'chưa/không pull'}`,
  ].join('\n')
}

async function writeFinalReport(params: {
  proposal: { title: string; problem: string; solution: string; implementation: string }
  steps: Array<{ stepOrder: number; title: string; assignee: string; status: string; output: string | null; evaluation: string | null }>
  failed: boolean
  /** CI-6 B5: receipt pipeline verify_and_push (tồn tại khi có bước chạy workspace thật) */
  pipelineReceipt?: SdPipelineReceiptSummary | null
}): Promise<string> {
  // USER DECISION #3: ủy quyền bật → OPUS (CTO) viết báo cáo hoàn thiện (kèm
  // prefix "Báo cáo của Opus"); tắt → Omega như cũ. Triển khai vẫn của Omega —
  // các chỗ hardcode "Omega" trong template cũ dùng biến reviewerName.
  const { systemPrompt: reviewerPersona, reviewerName } = await getReviewerSystemPrompt('report')
  const stepsText = params.steps.map(s =>
    `Bước ${s.stepOrder} — ${s.title} [${s.assignee}] (${s.status === 'done' ? 'đạt' : s.status}):\n  Output: ${(s.output || '(trống)').slice(0, 600)}\n  Đánh giá ${reviewerName}: ${s.evaluation || '(không có)'}`
  ).join('\n\n')

  // CI-6 B5 — section pipeline khi proposal chạy code-workflow (có workspaceReceipt)
  const hasPipeline = !!params.pipelineReceipt
  const pipelineSection = hasPipeline ? `

## Kết quả kiểm định & triển khai code
(pipeline verify_and_push — dữ liệu THẬT từ receipt: tổng quan pass/fail, trạng thái từng bước kiểm định, commit hash, đã push/pull chưa; chỉ dựa trên dữ liệu được cung cấp, không bịa bổ sung)
` : ''

  const systemPrompt = `${reviewerPersona}
Kế hoạch triển khai đề xuất "${params.proposal.title}" ${params.failed ? 'đã THẤT BẠI ở 1 bước' : 'đã HOÀN TẤT'}. Viết BÁO CÁO HOÀN THIỆN gửi Mr. Architect bằng tiếng Việt, markdown đơn giản (chỉ dùng ## và **, KHÔNG bảng), theo đúng khung:

## Tổng quan
(1-2 câu: đề xuất gì, kết quả sau cùng)

## Đã triển khai những gì & triển khai như thế nào
(tóm tắt cách tiếp cận tổng thể)

## Kết quả các bước triển khai
(mỗi bước 2-4 câu: agent nào làm gì, kết quả ra sao${params.failed ? ' — nêu rõ bước nào THẤT BẠI và tại sao' : ''})${pipelineSection}
## Kết quả sau cùng
(vấn đề gốc đã được giải quyết chưa? còn tồn đọng gì?)

## Ý kiến & đề xuất khác
(đề xuất tiếp theo cho hệ thống, nếu có)

Giữ báo cáo dưới 600 từ.`

  const userPrompt = `ĐỀ XUẤT: ${params.proposal.title}
VẤN ĐỀ GỐC: ${params.proposal.problem.slice(0, 800)}
GIẢI PHÁP ĐÃ DUYỆT: ${params.proposal.solution.slice(0, 800)}

KẾT QUẢ TỪNG BƯỚC:
${stepsText.slice(0, 4000)}
${params.pipelineReceipt ? `\nKẾT QUẢ PIPELINE KIỂM ĐỊNH & TRIỂN KHAI CODE (bước verify_and_push — dữ liệu THẬT):\n${pipelineReceiptToText(params.pipelineReceipt)}\n` : ''}
Viết báo cáo hoàn thiện.`

  // USER DECISION #3: Opus viết báo cáo khi ủy quyền bật → prefix danh nghĩa
  const reportPrefix = reviewerName === OPUS_AGENT_NAME ? `**Báo cáo của ${reviewerName}**\n\n` : ''

  try {
    const raw = await callBrain({ prompt: userPrompt, systemPrompt, maxTokens: 1400, temperature: 0.4, label: `${reviewerName}Report` })
    return `${reportPrefix}${raw.slice(0, 6000)}`
  } catch (err) {
    console.warn(`[SelfDirection] ${reviewerName}Report lỗi — dùng báo cáo deterministic:`, err instanceof Error ? err.message : String(err))
    // Fallback deterministic
    const lines = [
      `## Tổng quan`,
      params.failed
        ? `Đề xuất "${params.proposal.title}" đã được triển khai nhưng THẤT BẠI ở 1 bước (báo cáo dự phòng — LLM không phản hồi).`
        : `Đề xuất "${params.proposal.title}" đã được triển khai hoàn tất qua ${params.steps.length} bước (báo cáo dự phòng — LLM không phản hồi).`,
      ``,
      `## Kết quả các bước triển khai`,
      ...params.steps.map(s => `Bước ${s.stepOrder} — ${s.title} [${s.assignee}]: ${s.status === 'done' ? 'Hoàn tất' : 'THẤT BẠI'}. ${(s.output || '').slice(0, 300)}`),
      ``,
      ...(params.pipelineReceipt ? [
        `## Kết quả kiểm định & triển khai code`,
        pipelineReceiptToText(params.pipelineReceipt),
        ``,
      ] : []),
      `## Kết quả sau cùng`,
      params.failed ? `Chưa hoàn thành — cần xem xét thử lại (bấm "Thử lại" trong Lịch sử).` : `Hoàn thành theo kế hoạch.`,
      ``,
      `## Ý kiến & đề xuất khác`,
      `Kiểm tra lại chất lượng output từng bước trong tab Chi tiết để đánh giá độc lập.`,
    ]
    return `${reportPrefix}${lines.join('\n')}`
  }
}

// ==================== 6. ORCHESTRATION — điều phối toàn bộ ====================

/**
 * Kick-off orchestration (fire-and-forget). Trả true nếu bắt đầu thành công.
 * Chấp nhận: status ready/approved (deploy sớm)/failed (retry).
 *
 * FIX 2026-08-29 (race condition): lock phải được đặt TRƯỚC mọi await. Bản cũ
 * đặt lock sau `await findUnique` → 2 lời gọi đồng thời (poll promoteDue +
 * user bấm "Triển khai ngay") cùng vượt check has() rồi cùng add + cùng kick
 * runOrchestration → steps bị deleteMany/createMany đan xen (nhân đôi stepOrder,
 * xung đột status). Check-and-add đồng bộ (không await xen giữa) là atomic
 * trong event loop JS → đảm bảo đúng 1 orchestration chạy mỗi proposal.
 */
export async function triggerOrchestration(
  proposalId: string,
  /** FIX 2026-09-02 (Omega audit #2): lever dryRun TÙY CHỌN — mặc định
   *  *KHÔNG* dry-run (push thật theo yêu cầu Mr. Architect). Caller (route
   *  deploy) có thể truyền body {dryRun:true} để chạy pipeline kiểm định mà
   *  không commit/push — dùng thử an toàn trước khi triển khai thật. */
  opts?: { dryRun?: boolean },
): Promise<boolean> {
  if (runningOrchestrations.has(proposalId)) return false
  runningOrchestrations.add(proposalId) // reserve NGAY (atomic với check phía trên)
  let started = false
  try {
    const proposal = await db.selfDirectionProposal.findUnique({
      where: { id: proposalId },
      select: { status: true, title: true, category: true, automationJson: true },
    })
    if (!proposal) return false
    if (!['ready', 'approved', 'failed'].includes(proposal.status)) return false

    // ━━━ AUTOMATION FAST-PATH (user request 2026-09-13) ━━━
    // Proposal category='automation' (agent đề xuất qua propose_automation,
    // Omega forward) là hành động CƠ KHÍ — tạo cron job / webhook / standing
    // order / task flow. KHÔNG cần Omega lập kế hoạch giao agents (orchestration
    // 6 bước cho 1 lệnh INSERT là lãng phí) → thực thi trực tiếp qua
    // executeAutomationProposal (idempotent-guard: completed bỏ qua).
    if (proposal.category === 'automation' && proposal.automationJson) {
      console.log(`[SelfDirection] Automation fast-path cho "${proposal.title}" — thực thi trực tiếp (không orchestration)`)
      void runAutomationFastPath(proposalId)
      started = true
      return true
    }

    console.log(`[SelfDirection] Trigger orchestration cho "${proposal.title}" (status=${proposal.status})${opts?.dryRun ? ' [DRY-RUN]' : ''}`)
    // Fire-and-forget — mọi lỗi được xử lý trong catch bên dưới
    void runOrchestration(proposalId, opts).catch(async err => {
      console.error(`[SelfDirection] Orchestration ${proposalId} crash:`, err instanceof Error ? err.message : String(err))
      try {
        await db.selfDirectionProposal.update({
          where: { id: proposalId },
          data: {
            status: 'failed',
            decisionReason: `Lỗi orchestration: ${err instanceof Error ? err.message : String(err)}`,
          },
        })
      } catch { /* best-effort */ }
    }).finally(() => {
      runningOrchestrations.delete(proposalId)
    })
    started = true
    return true
  } catch (err) {
    console.warn(`[SelfDirection] Trigger orchestration ${proposalId} lỗi:`, err instanceof Error ? err.message : String(err))
    return false
  } finally {
    // Không kick được orchestration (early-return/exception) → nhả lock reservation
    if (!started) runningOrchestrations.delete(proposalId)
  }
}

/**
 * AUTOMATION FAST-PATH runner (2026-09-13): thực thi proposal automation trực
 * tiếp (dynamic import chống module-load-order issue), lỗi → đánh dấu failed
 * (đúng pattern catch của runOrchestration), luôn nhả lock reservation.
 */
async function runAutomationFastPath(proposalId: string): Promise<void> {
  try {
    const { executeAutomationProposal } = await import('@/lib/automation-proposals')
    const result = await executeAutomationProposal(proposalId)
    console.log(`[SelfDirection] Automation fast-path ${proposalId}: ${result.success ? 'THÀNH CÔNG' : 'THẤT BẠI'} — ${result.detail.slice(0, 150)}`)
  } catch (err) {
    console.error(`[SelfDirection] Automation fast-path ${proposalId} crash:`, err instanceof Error ? err.message : String(err))
    try {
      await db.selfDirectionProposal.update({
        where: { id: proposalId },
        data: {
          status: 'failed',
          decisionReason: `Lỗi thực thi automation: ${err instanceof Error ? err.message : String(err)}`,
        },
      })
    } catch { /* best-effort */ }
  } finally {
    runningOrchestrations.delete(proposalId)
  }
}

/**
 * FIX review GĐ2 #2 (MEDIUM): MUTEX workspace cho code-workflow — các
 * orchestration code-workflow dùng CHUNG 1 workspace active nên phải chạy
 * TUẦN TỰ: (a) tránh git index.lock contention khi 2 pipeline cùng commit;
 * (b) tránh pipeline proposal A commit dính file nửa vời của proposal B
 * (cross-contamination). Chuỗi promise nối tiếp — mỗi orchestration chờ
 * orchestration code-workflow trước xong hẳn mới bắt đầu.
 * (llm-mode proposals KHÔNG qua mutex — chúng không đụng workspace file/git.)
 */
let sdCodeWorkflowChain: Promise<unknown> = Promise.resolve()
function serializeCodeWorkflow<T>(fn: () => Promise<T>): Promise<T> {
  const next = sdCodeWorkflowChain.then(fn, fn) // chạy kể cả khi cái trước fail
  // giữ chain sống dù fn throw — nhưng không nuốt lỗi của next
  sdCodeWorkflowChain = next.catch(() => undefined)
  return next
}

/** Kiểm tra orchestration có đang chạy cho proposal này không (in-process) */
export function isOrchestrating(proposalId: string): boolean {
  return runningOrchestrations.has(proposalId)
}

async function runOrchestration(proposalId: string, opts?: { dryRun?: boolean }): Promise<void> {
  // FIX review GĐ2 #2: code-workflow → serialize qua mutex workspace (XEM
  // serializeCodeWorkflow). Đọc executionMode TRƯỚC để quyết định có cần mutex.
  const pre = await db.selfDirectionProposal.findUnique({ where: { id: proposalId }, select: { executionMode: true } })
  if (pre?.executionMode === 'code-workflow') {
    await serializeCodeWorkflow(() => runOrchestrationInner(proposalId, opts))
    return
  }
  await runOrchestrationInner(proposalId, opts)
}

async function runOrchestrationInner(proposalId: string, opts?: { dryRun?: boolean }): Promise<void> {
  // === Phase 1: PLAN ===
  await db.selfDirectionProposal.update({ where: { id: proposalId }, data: { status: 'planning' } })
  const proposal = await db.selfDirectionProposal.findUnique({ where: { id: proposalId } })
  if (!proposal) throw new Error('Proposal biến mất')

  // Retry → xóa steps cũ
  await db.proposalStep.deleteMany({ where: { proposalId } })

  const plan = await generateWorkPlan(proposal)
  await db.proposalStep.createMany({
    data: plan.steps.map((s, i) => ({
      proposalId,
      stepOrder: i + 1,
      title: s.title,
      description: s.description,
      assignee: s.assignee,
      status: 'pending',
    })),
  })
  await db.selfDirectionProposal.update({
    where: { id: proposalId },
    data: { status: 'executing', planSummary: plan.planSummary, executedAt: new Date() },
  })
  console.log(`[SelfDirection] Bắt đầu triển khai "${proposal.title}": ${plan.steps.length} bước [${plan.steps.map(s => s.assignee).join(' → ')}]`)

  // === Phase 2: EXECUTE từng bước (tuần tự + đánh giá + rework) ===
  // CI-6 B5: proposal code-workflow → bước GIỮA chạy ReAct bằng TOOL THẬT
  // (executeCodeStepWithTools), bước CUỐI verify_and_push chạy pipeline
  // kiểm định 9 bước THẬT (executeVerifyAndPushStep) — receipts lưu vào
  // ProposalStep.workspaceReceipt.
  const isCodeWorkflow = proposal.executionMode === 'code-workflow'
  let failed = false
  let failReason = ''
  const totalSteps = plan.steps.length
  const doneOutputs: Array<{ title: string; output: string }> = []

  for (let i = 0; i < totalSteps; i++) {
    const stepDef = plan.steps[i]
    const stepRow = await db.proposalStep.findFirst({ where: { proposalId, stepOrder: i + 1 } })
    if (!stepRow) continue

    await db.proposalStep.update({
      where: { id: stepRow.id },
      data: { status: 'in_progress', startedAt: new Date(), attempts: { increment: 1 } },
    })

    // ── CI-6 B5: bước CUỐI code-workflow → pipeline verify_and_push THẬT ──
    // Single-shot (KHÔNG rework loop): mỗi lần chạy pipeline = lint + typecheck
    // + tests (~40s+) + có thể commit/push thật. Thành công của bước = pipeline
    // PASS (đánh giá deterministic — không cần Omega chấm lại); cây sạch →
    // "không có gì để commit" vẫn ĐẠT (đề xuất có thể chỉ phân tích).
    if (isCodeWorkflow && isVerifyAndPushStep(stepDef, i === totalSteps - 1)) {
      const result = await executeVerifyAndPushStep({
        proposal: { id: proposal.id, title: proposal.title },
        planSummary: plan.planSummary,
        // FIX 2026-09-02 (audit #2): dryRun tùy chọn từ caller (route deploy đọc
        // body) — mặc định KHÔNG dry-run: pipeline commit + push THẬT lên remote
        // (yêu cầu Mr. Architect: chức năng push code từ workspace phải hoạt động thật).
        dryRun: opts?.dryRun === true,
      })
      if (result.success) {
        await db.proposalStep.update({
          where: { id: stepRow.id },
          data: {
            status: 'done',
            output: result.output,
            evaluation: `Pipeline kiểm định ${result.receipt.steps.length} bước PASS${result.receipt.commitHash ? ` — commit ${result.receipt.commitHash.slice(0, 7)}` : ' — cây làm việc sạch, không có gì để commit'}`,
            workspaceReceipt: result.receipt as unknown as Prisma.InputJsonValue,
            finishedAt: new Date(),
          },
        })
        doneOutputs.push({ title: stepDef.title, output: result.output })
        console.log(`[SelfDirection] Bước ${i + 1}/${totalSteps} verify_and_push [Omega] ĐẠT — pipeline PASS${result.receipt.commitHash ? ` (commit ${result.receipt.commitHash.slice(0, 7)}, pushed=${result.receipt.pushed === true})` : ' (cây sạch — không có gì để commit)'}`)
        continue
      }
      await db.proposalStep.update({
        where: { id: stepRow.id },
        data: {
          status: 'failed',
          output: result.output,
          evaluation: `Pipeline kiểm định THẤT BẠI: ${result.receipt.error || 'có bước kiểm định không đạt — xem chi tiết trong output'}`,
          workspaceReceipt: result.receipt as unknown as Prisma.InputJsonValue,
          finishedAt: new Date(),
        },
      })
      failed = true
      failReason = `Bước ${i + 1} "${stepDef.title}" (verify_and_push pipeline) THẤT BẠI: ${result.receipt.error || 'có bước kiểm định không đạt'}`
      console.warn(`[SelfDirection] Bước ${i + 1}/${totalSteps} verify_and_push THẤT BẠI: ${result.receipt.error || 'xem steps trong workspaceReceipt'}`)
      break // dừng cả pipeline — KHÔNG push code chưa qua kiểm định
    }

    let stepDone = false
    let lastOutput = ''
    let lastEvaluation = ''
    let lastReceipt: SdToolBatchReceipt | null = null
    for (let attempt = 1; attempt <= MAX_STEP_ATTEMPTS && !stepDone; attempt++) {
      if (attempt > 1) {
        await db.proposalStep.update({ where: { id: stepRow.id }, data: { attempts: { increment: 1 } } })
      }
      if (isCodeWorkflow) {
        // CI-6 B5 — bước GIỮA: agent persona ReAct qua TOOL THẬT trong workspace
        const r = await executeCodeStepWithTools({
          proposal,
          step: { ...stepDef, stepOrder: i + 1 },
          previousOutputs: doneOutputs.slice(-3),
          reworkFeedback: attempt > 1 ? lastEvaluation : null,
        })
        lastOutput = r.output
        lastReceipt = r.receipt
      } else {
        lastOutput = await executeStep({
          proposal,
          step: { ...stepDef, stepOrder: i + 1 },
          previousOutputs: doneOutputs.slice(-3), // bàn giao 3 bước gần nhất (anti context-bloat)
          reworkFeedback: attempt > 1 ? lastEvaluation : null,
        })
      }
      const evaluation = await evaluateStep({
        step: { ...stepDef, stepOrder: i + 1 },
        output: lastOutput,
        attempt,
      })
      lastEvaluation = evaluation.evaluation
      if (evaluation.complete) {
        await db.proposalStep.update({
          where: { id: stepRow.id },
          data: {
            status: 'done',
            output: lastOutput,
            evaluation: lastEvaluation,
            finishedAt: new Date(),
            ...(lastReceipt ? { workspaceReceipt: lastReceipt as unknown as Prisma.InputJsonValue } : {}),
          },
        })
        doneOutputs.push({ title: stepDef.title, output: lastOutput })
        stepDone = true
        console.log(`[SelfDirection] Bước ${i + 1}/${totalSteps} "${stepDef.title}" [${stepDef.assignee}] ĐẠT (lần ${attempt})`)
      } else {
        console.warn(`[SelfDirection] Bước ${i + 1}/${totalSteps} [${stepDef.assignee}] CHƯA ĐẠT (lần ${attempt}): ${lastEvaluation.slice(0, 150)}`)
        if (attempt < MAX_STEP_ATTEMPTS) {
          await db.proposalStep.update({
            where: { id: stepRow.id },
            data: {
              output: lastOutput,
              evaluation: `Chưa đạt (lần ${attempt}): ${lastEvaluation} — sẽ thử lại`,
              ...(lastReceipt ? { workspaceReceipt: lastReceipt as unknown as Prisma.InputJsonValue } : {}),
            },
          })
        }
      }
    }

    if (!stepDone) {
      await db.proposalStep.update({
        where: { id: stepRow.id },
        data: {
          status: 'failed',
          output: lastOutput,
          evaluation: `THẤT BẠI sau ${MAX_STEP_ATTEMPTS} lần: ${lastEvaluation}`,
          ...(lastReceipt ? { workspaceReceipt: lastReceipt as unknown as Prisma.InputJsonValue } : {}),
        },
      })
      failed = true
      failReason = `Bước ${i + 1} "${stepDef.title}" (agent ${stepDef.assignee}) không đạt sau ${MAX_STEP_ATTEMPTS} lần thử`
      break // dừng cả pipeline
    }
  }

  // === Phase 3: REPORT ===
  const finalSteps = await db.proposalStep.findMany({ where: { proposalId }, orderBy: { stepOrder: 'asc' } })
  // CI-6 B5: receipt pipeline từ bước verify_and_push (nếu có) → đan vào báo cáo
  // hoàn thiện phần "Kết quả kiểm định & triển khai code".
  const pipelineStepRow = finalSteps.find(s => {
    const r = s.workspaceReceipt as { kind?: string } | null
    return !!r && typeof r === 'object' && r.kind === 'pre-push-pipeline'
  })
  const pipelineReceipt = pipelineStepRow
    ? (pipelineStepRow.workspaceReceipt as unknown as SdPipelineReceiptSummary)
    : null
  const report = await writeFinalReport({ proposal, steps: finalSteps, failed, pipelineReceipt })
  const completedProposal = await db.selfDirectionProposal.update({
    where: { id: proposalId },
    data: {
      status: failed ? 'failed' : 'completed',
      // Hoàn tất thành công → xóa reason cũ của lần fail trước (nếu retry),
      // báo cáo Omega là nguồn thông tin duy nhất cho kết quả cuối.
      decisionReason: failed ? failReason : null,
      omegaReport: report,
      completedAt: new Date(),
    },
  })
  // v1.2 — ALISTA follow-up loop: proposal của ALISTA hoàn tất → thông tin
  // được chuyển tới ALISTA NGAY để xác minh lại (re-check collector tương ứng,
  // gửi đề xuất mới nếu vấn đề chưa triệt để). Dynamic import chống circular
  // (alista/proposals.ts đã import orchestrator tĩnh). Fail-open tuyệt đối —
  // lưới an toàn sweep 60s trong alistaTick sẽ bắt lại nếu hook lỡ.
  if (completedProposal.status === 'completed' && completedProposal.createdBy === 'ALISTA') {
    void import('@/lib/alista/proposal-verify')
      .then(m => m.notifyAlistaProposalCompleted(proposalId, 'completion-hook'))
      .catch(err => {
        console.warn('[SelfDirection] ALISTA follow-up hook fail (sweep 60s sẽ bắt lại):', err instanceof Error ? err.message : String(err))
      })
  }
  console.log(`[SelfDirection] "${proposal.title}" ${failed ? `THẤT BẠI: ${failReason}` : `HOÀN TẤT ${finalSteps.length} bước — báo cáo hoàn thiện đã lưu`}`)
}

// ==================== 7b. CI-5 B6 (Task 14-d) — STALL-KILL THÍCH ỨNG ====================
// Roadmap CI-5 sơ hở #5: "Stall-kill self-direction 10 phút có thể giết step
// LLM chậm hợp lệ". Trong lúc 1 step đang chạy LLM dài (kimi-k3 trên context
// 30K + timeout 8' + tool time), KHÔNG có ghi nào vào proposal/steps → lastSignal
// (updatedAt/startedAt của steps) già đi > 10' dù orchestration ĐANG SỐNG.
// Stall-kill thích ứng: trước khi đánh dấu failed, kiểm tra CÁC NGUỒN HEARTBEAT
// của execution (session sd-<proposalId>) — có tín hiệu tươi trong cửa sổ 10'
// thì KHÔNG giết lần tick này (tick sau lại check: heartbeat vẫn tươi → vẫn
// không giết — đúng nghĩa thích ứng; hết tín hiệu 10' → giết như hành vi cũ,
// KHÔNG có vòng vô hạn vì heartbeat chỉ tươi khi execution THẬT SỰ hoạt động).

/** 1 tín hiệu sống thu thập được từ nguồn heartbeat của execution */
export interface SdHeartbeatSignal {
  /** Tên nguồn ('tool-metric' | 'goal-loop-job' | 'agent-run-tracker') */
  source: string
  /** Thời điểm tín hiệu (epoch ms) — null/undefined = nguồn không có dữ liệu */
  ts: number | null | undefined
}

/** Kết quả tìm thấy tín hiệu sống tươi */
export interface SdFreshHeartbeat {
  source: string
  ts: number
  ageMs: number
}

/**
 * Tìm tín hiệu sống TƯƠI NHẤT trong cửa sổ windowMs — PURE FUNCTION (test
 * được không cần DB). Trả về tín hiệu tươi nhất (ts lớn nhất thỏa cửa sổ),
 * hoặc null khi KHÔNG có tín hiệu nào trong cửa sổ (→ stall-kill giữ hành vi
 * cũ). Ts trong tương lai xa (> 60s — clock skew giữa nguồn) bị loại; skew
 * nhỏ được chặn về ageMs=0.
 */
export function findFreshHeartbeat(
  signals: Array<SdHeartbeatSignal | null | undefined>,
  nowMs: number,
  windowMs: number,
): SdFreshHeartbeat | null {
  let best: SdFreshHeartbeat | null = null
  for (const s of signals) {
    if (!s || typeof s.ts !== 'number' || !Number.isFinite(s.ts)) continue
    const rawAge = nowMs - s.ts
    if (rawAge > windowMs) continue // quá cũ — không phải tín hiệu sống
    if (rawAge < -60_000) continue // lệch đồng hồ lớn (tương lai xa) — bỏ
    if (!best || s.ts > best.ts) {
      best = { source: s.source, ts: s.ts, ageMs: Math.max(0, rawAge) }
    }
  }
  return best
}

/**
 * Thu thập MỌI nguồn heartbeat của execution của proposal (session sd-<id>),
 * mỗi nguồn fail-open RIÊNG (try/catch + delegate guard — nguồn lỗi/không map
 * được → không đóng góp tín hiệu, KHÔNG throw):
 *   (a) ToolMetric (DB) — TOOL RECEIPT GẦN: mọi executeTool của code-workflow
 *       step chảy qua recordAgentActivity → recordToolMetric (choke-point duy
 *       nhất từ Task 20-b, có @@index([sessionId]); delegate an toàn với cả
 *       stale Prisma client vì model có từ Phase 3). Tool receipts chỉ land
 *       khi agent THẬT SỰ đang gọi tool → tín hiệu sống đáng tin nhất hôm nay.
 *   (b) GoalLoopJob.heartbeatAt (DB, GĐ4 14-a) — nếu execution chạy qua
 *       goal-loop worker (ghi mỗi vòng/tool batch, throttle 15s). Self-direction
 *       hôm nay chạy inline (không spawn job) → nguồn thường rỗng — giữ cho
 *       future-proof CI-5. Guard delegate: process giữ Prisma client cũ (chưa
 *       có model GoalLoopJob sau db:push của 14-a) → bỏ nguồn im lặng.
 *   (c) agent-run-tracker (in-memory globalThis) — events có ts của run thuộc
 *       session sd-<id> (startAgentRun/recordAgentRunTool của execution khác
 *       nếu có). Hôm nay self-direction không startAgentRun → nguồn thường
 *       rỗng — vô hại.
 * Chi phí: chỉ gọi khi stall-kill ĐỊNH giết (hiếm) — 2 query DB nhẹ + 1 đọc map.
 */
async function collectProposalHeartbeats(proposalId: string): Promise<SdHeartbeatSignal[]> {
  const sessionId = `sd-${proposalId}`
  const cutoff = new Date(Date.now() - STALLED_AFTER_MS)
  const signals: SdHeartbeatSignal[] = []

  // (a) ToolMetric — tool receipt gần nhất của session sd-<id>
  try {
    const latest = await db.toolMetric.findFirst({
      where: { sessionId, timestamp: { gte: cutoff } },
      orderBy: { timestamp: 'desc' },
      select: { timestamp: true },
    })
    if (latest) signals.push({ source: 'tool-metric', ts: latest.timestamp.getTime() })
  } catch (tmErr) {
    console.warn(`[SelfDirection] stall-kill heartbeat ToolMetric lỗi (fail-open — bỏ nguồn này): ${tmErr instanceof Error ? tmErr.message : String(tmErr)}`)
  }

  // (b) GoalLoopJob.heartbeatAt (14-a ghi mỗi vòng/tool batch)
  try {
    // Guard stale Prisma client: process chạy trước db:push của 14-a chưa có
    // delegate goalLoopJob → TypeError nếu gọi thẳng; check tồn tại trước.
    const dbAny = db as unknown as { goalLoopJob?: { findFirst: (args: Record<string, unknown>) => Promise<{ heartbeatAt: Date | null } | null> } }
    if (dbAny.goalLoopJob?.findFirst) {
      const job = await dbAny.goalLoopJob.findFirst({
        where: { sessionId, heartbeatAt: { gte: cutoff } },
        orderBy: { heartbeatAt: 'desc' },
        select: { heartbeatAt: true },
      })
      if (job?.heartbeatAt) signals.push({ source: 'goal-loop-job', ts: job.heartbeatAt.getTime() })
    }
  } catch (glErr) {
    console.warn(`[SelfDirection] stall-kill heartbeat GoalLoopJob lỗi (fail-open — bỏ nguồn này): ${glErr instanceof Error ? glErr.message : String(glErr)}`)
  }

  // (c) agent-run-tracker (in-memory) — event ts gần nhất mỗi run của session
  try {
    for (const run of getAgentRuns(sessionId, 10)) {
      const lastTs = run.events.length > 0 ? run.events[run.events.length - 1].ts : run.startedAt
      signals.push({ source: 'agent-run-tracker', ts: lastTs })
    }
  } catch (arErr) {
    console.warn(`[SelfDirection] stall-kill heartbeat agent-run-tracker lỗi (fail-open — bỏ nguồn này): ${arErr instanceof Error ? arErr.message : String(arErr)}`)
  }

  return signals
}

/**
 * Tín hiệu sống tươi nhất của execution proposal, hoặc null khi KHÔNG có
 * (stall-kill giữ hành vi cũ). Exported cho smoke test (14-d).
 */
export async function latestExecutionHeartbeat(proposalId: string): Promise<SdFreshHeartbeat | null> {
  const signals = await collectProposalHeartbeats(proposalId)
  return findFreshHeartbeat(signals, Date.now(), STALLED_AFTER_MS)
}

// ==================== 7. AUTO-PROMOTION (gọi từ GET proposals) ====================

/**
 * Đến hạn triển khai (scheduleAt <= now) → approved chuyển ready + trigger.
 * Đồng thời recover orchestration bị gián đoạn (PM2 restart/OOM).
 * TRẢ VỀ: danh sách id đã kích hoạt (để log).
 */
export async function promoteDueProposals(): Promise<string[]> {
  const triggered: string[] = []
  try {
    const now = new Date()
    // 1) Đến hạn → ready + orchestrate
    const due = await db.selfDirectionProposal.findMany({
      where: { status: 'approved', OR: [{ scheduleAt: null }, { scheduleAt: { lte: now } }] },
      select: { id: true },
    })
    for (const p of due) {
      await db.selfDirectionProposal.update({ where: { id: p.id }, data: { status: 'ready' } })
      if (await triggerOrchestration(p.id)) triggered.push(p.id)
    }
    // 2) Ready nhưng chưa chạy (vd server restart ngay sau promote) → trigger lại
    const ready = await db.selfDirectionProposal.findMany({ where: { status: 'ready' }, select: { id: true } })
    for (const p of ready) {
      if (await triggerOrchestration(p.id)) triggered.push(p.id)
    }
    // 3) Orchestration gián đoạn (PM2 restart/OOM) → failed + recoverable.
    //    TÍN HIỆU SỐNG: (a) in-process lock đang giữ = chắc chắn đang chạy;
    //    (b) step gần nhất có startedAt/finishedAt mới = pipeline đang tiến triển.
    //    (Lưu ý: proposal.updatedAt KHÔNG cập nhật khi steps tiến triển —
    //    không được chỉ dựa vào nó kẻo giết nhầm orchestration đang chạy.)
    const stalledCutoff = new Date(Date.now() - STALLED_AFTER_MS)
    const candidates = await db.selfDirectionProposal.findMany({
      where: { status: { in: ['planning', 'executing'] } },
      select: { id: true, updatedAt: true, status: true },
    })
    for (const p of candidates) {
      if (isOrchestrating(p.id)) continue // đang chạy trong process này
      // FIX 2026-08-29: tính tín hiệu sống từ TẤT CẢ steps thay vì chỉ 1 row
      // findFirst(orderBy finishedAt/startedAt desc) — bản cũ hay pick nhầm
      // step đã done (finishedAt mới nhất) mà bỏ sót step đang in_progress
      // (finishedAt=null xếp cuối trong DESC của SQLite). Ngoài ra step.updatedAt
      // (Prisma tự update ở MỌI lần ghi: attempts/output/evaluation giữa các
      // lần thử lại) là tín hiệu sống chính xác nhất trong lúc rework.
      let lastSignal = p.updatedAt.getTime()
      const steps = await db.proposalStep.findMany({
        where: { proposalId: p.id },
        select: { startedAt: true, finishedAt: true, updatedAt: true },
      })
      for (const s of steps) {
        lastSignal = Math.max(
          lastSignal,
          s.startedAt?.getTime() ?? 0,
          s.finishedAt?.getTime() ?? 0,
          s.updatedAt.getTime(),
        )
      }
      if (lastSignal >= stalledCutoff.getTime()) continue // còn tín hiệu sống
      // ━━━ CI-5 B6 (Task 14-d) — STALL-KILL THÍCH ỨNG ━━━
      // Trước khi giết: kiểm tra heartbeat của EXECUTION (tool receipt
      // ToolMetric / GoalLoopJob.heartbeatAt / agent-run-tracker events — xem
      // collectProposalHeartbeats). Step LLM chậm hợp lệ (sơ hở #5 roadmap)
      // không ghi gì vào proposal/steps trong lúc LLM/tool đang chạy, nhưng tool
      // receipts vẫn land DB → heartbeat tươi = execution đang sống → KHÔNG
      // giết lần tick này (tick sau lại check — không giữ deadline state, không
      // vòng vô hạn). Nguồn lỗi / không map được → không tín hiệu → hành vi cũ.
      // Fail-open: heartbeat check throw bất kỳ → coi như không có tín hiệu.
      let freshHeartbeat: SdFreshHeartbeat | null = null
      try {
        freshHeartbeat = await latestExecutionHeartbeat(p.id)
      } catch (hbErr) {
        console.warn(`[SelfDirection] stall-kill heartbeat check lỗi (fail-open — coi như không có tín hiệu): ${hbErr instanceof Error ? hbErr.message : String(hbErr)}`)
      }
      if (freshHeartbeat) {
        console.log(`[SelfDirection] stall-kill bỏ qua proposal ${p.id} — có tín hiệu sống (${freshHeartbeat.source}, ${Math.round(freshHeartbeat.ageMs / 1000)}s trước ≤ ${STALLED_AFTER_MS / 60_000}')`)
        continue
      }
      await db.selfDirectionProposal.update({
        where: { id: p.id },
        data: { status: 'failed', decisionReason: 'Triển khai bị gián đoạn (server restart?) — bấm "Thử lại" để Omega tiếp tục' },
      })
      console.warn(`[SelfDirection] Proposal ${p.id} đánh dấu failed (stalled > 10 phút, không còn tín hiệu sống)`)
    }
  } catch (err) {
    console.warn('[SelfDirection] promoteDueProposals lỗi (fail-open):', err instanceof Error ? err.message : String(err))
  }
  return triggered
}

/** Ủy quyền đang bật → Opus tự review mọi proposal pending (gọi từ GET proposals) — user decision #3 */
export async function autoReviewPendingIfDelegated(): Promise<number> {
  try {
    const settings = await getSelfDirectionSettings()
    if (!settings.opusDelegated) return 0

    // ━━ USER REQUEST (2026-09-02): duyệt tuần tự, chờ orchestration xong ━━
    // Nếu có ĐANG TỚI HẠN đang chạy orchestration (status=ready/running or
    // in-process runningOrchestrations) → KHÔNG kick thêm, chờ hoàn thành.
    // Lý do: workspace code-workflow dùng chung 1 git index → KHÔNG chạy song
    // song (serializeCodeWorkflow mutex). Nếu Opus duyệt proposal B khi proposal
    // A đang chạy → proposal B vào hàng chờ mutex, nhưng user không thấy → tưởng
    // Opus bỏ qua. Fix: chỉ duyệt khi KHÔNG có orchestration nào đang chạy.
    const activeOrchestrations = await db.selfDirectionProposal.findMany({
      where: { status: { in: ['ready', 'planning', 'executing'] } },
      select: { id: true },
    })
    const inProcess = activeOrchestrations.filter(p => runningOrchestrations.has(p.id))
    if (inProcess.length > 0) {
      console.log(`[SelfDirection] Opus KHÔNG duyệt thêm — ${inProcess.length} đề xuất đang tiến hành orchestration (chờ xong mới duyệt cái kế)`)
      return 0
    }

    const pending = await db.selfDirectionProposal.findMany({
      where: { status: 'pending' },
      select: { id: true, priority: true, createdAt: true },
      orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
      take: 10,
    })
    if (pending.length === 0) return 0

    // Sắp xếp đề xuất theo ưu tiên Opus đánh giá (priority desc + createdAt asc
    // = ưu tiên cao + sớm trước). Opus sẽ duyệt TỪNG cái, chờ orchestration xong
    // mới duyệt cái kế (kickOmegaReviewsSerially đã sửa await orchestration).
    return kickOmegaReviewsSerially(pending.map(p => p.id))
  } catch {
    return 0
  }
}

/**
 * FIX 2026-08-29 (429 rate-limit storm): kick nhiều review TUẦN TỰ thay vì song
 * song. Bản cũ void-kick tới 10 review cùng lúc → tất cả đổ dồn vào z-ai-sdk
 * cùng lúc → 429 "Too many requests" (thấy trong log E2E), review fail hàng
 * loạt rồi phải chờ poll heal lại. Chuỗi tuần tự mỗi lần 1 review
 * (reviewingProposals guard vẫn chống double-kick từ poll 4s của UI).
 * Fire-and-forget: trả về số review đã xếp hàng ngay lập tức.
 *
 * (Tên hàm giữ nguyên từ thời Omega — USER DECISION #3: review bên trong giờ
 * là opusReviewPending của Opus; đổi tên export sẽ đụng callers không cần.)
 */
export function kickOmegaReviewsSerially(proposalIds: string[]): number {
  let queued = 0
  const todo: string[] = []
  for (const id of proposalIds) {
    if (reviewingProposals.has(id)) continue // đang review — bỏ qua
    todo.push(id)
    reviewingProposals.add(id) // reserve ngay chống double-queue từ poll xen giữa
    queued++
  }
  if (todo.length === 0) return 0
  void (async () => {
    for (const id of todo) {
      // opusReviewPending tự check+add lock; vì ta đã reserve ở trên nên gọi
      // inner logic qua wrapper: nhả reservation rồi gọi hàm chính (nó sẽ tự
      // add lại lock của nó) — giữ nguyên 1 đường vào duy nhất.
      reviewingProposals.delete(id)
      try {
        await opusReviewPending(id)
      } catch { /* đã được xử lý bên trong — fail-open giữ pending */ }

      // ━━ USER REQUEST (2026-09-02): chờ orchestration HOÀN THÀNH ━━
      // Sau khi Opus duyệt (approve → status ready → triggerOrchestration),
      // KHÔNG duyệt đề xuất kế ngay. Chờ orchestration hoàn thành (proposal
      // status chuyển completed/failed, hoặc runningOrchestrations nhả lock).
      // Lý do: workspace code-workflow dùng chung 1 git index → KHÔNG chạy
      // song song (serializeCodeWorkflow mutex). Duyệt liên tiếp sẽ xếp hàng
      // chờ mutex, user không thấy tiến trình, dễ tưởng Opus bỏ qua/kẹt.
      // Timeout 10 phút (orchestration code-workflow có thể dài — nhiều bước).
      const startedAt = Date.now()
      const TIMEOUT_MS = 10 * 60 * 1000
      while (runningOrchestrations.has(id)) {
        if (Date.now() - startedAt > TIMEOUT_MS) {
          console.warn(`[SelfDirection] Opus chờ orchestration ${id} quá 10 phút — timeout, duyệt đề xuất kế`)
          break
        }
        // Kiểm tra xem proposal còn ở status active không (có thể đã completed/failed)
        try {
          const cur = await db.selfDirectionProposal.findUnique({ where: { id }, select: { status: true } })
          if (!cur || !['ready', 'planning', 'executing'].includes(cur.status)) break // orchestration đã xong
        } catch { break }
        await new Promise(r => setTimeout(r, 3000)) // poll mỗi 3s
      }
    }
  })()
  return queued
}

// ==================== 8. VALIDATION HELPERS (dùng cho API routes) ====================

/**
 * CI-6 B5 — tạo proposal kèm executionMode, CHỊU ĐỰNG Prisma client cũ:
 * dev server đang giữ client generate TRƯỚC db:push (không biết cột mới) sẽ
 * throw PrismaClientValidationError "Unknown argument executionMode" → retry
 * KHÔNG kèm field (DB default 'llm' áp dụng — fail-open, app vẫn tạo đề xuất
 * bình thường tới khi restart app nạp client mới; pattern known từ Task 11-a).
 * Message-match thay vì instanceof (class identity có thể khác nhau giữa 2
 * bản generate của @prisma/client trong cùng process).
 */
function isStaleClientExecutionModeError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  const msg = err.message || ''
  return /Unknown argument [`]?executionMode/i.test(msg) || (err.name === 'PrismaClientValidationError' && /executionMode/i.test(msg))
}

export async function createSelfDirectionProposal(
  data: Omit<Prisma.SelfDirectionProposalUncheckedCreateInput, 'executionMode'> & { executionMode?: string },
) {
  try {
    return await db.selfDirectionProposal.create({ data })
  } catch (err) {
    if (data.executionMode !== undefined && isStaleClientExecutionModeError(err)) {
      console.warn('[SelfDirection] Prisma client cũ chưa biết cột executionMode — tạo proposal KHÔNG kèm executionMode (DB default llm). Restart app để dùng đầy đủ CI-6 B5.')
      const { executionMode: _stale, ...rest } = data
      return await db.selfDirectionProposal.create({ data: rest })
    }
    throw err
  }
}

export function validateProposalInput(input: Record<string, unknown>): { ok: true; data: {
  title: string; category: string; priority: string; problem: string; solution: string; implementation: string
  scheduleAt: Date | null; impact: string | null; source: string; createdBy: string; executionMode: string
} } | { ok: false; error: string } {
  const title = String(input.title || '').trim()
  const problem = String(input.problem || '').trim()
  const solution = String(input.solution || '').trim()
  const implementation = String(input.implementation || '').trim()
  if (!title) return { ok: false, error: 'Thiếu tiêu đề' }
  if (!problem) return { ok: false, error: 'Thiếu phần "Vấn đề là gì?"' }
  if (!solution) return { ok: false, error: 'Thiếu phần "Giải quyết như thế nào?"' }
  if (!implementation) return { ok: false, error: 'Thiếu phần "Triển khai như thế nào?"' }
  const category = VALID_CATEGORIES.includes(String(input.category)) ? String(input.category) : 'improvement'
  const priority = VALID_PRIORITIES.includes(String(input.priority)) ? String(input.priority) : 'medium'
  let scheduleAt: Date | null = null
  if (input.scheduleAt !== undefined && input.scheduleAt !== null && String(input.scheduleAt) !== '') {
    const d = new Date(String(input.scheduleAt))
    if (!Number.isNaN(d.getTime())) scheduleAt = d
  }
  return {
    ok: true,
    data: {
      title: title.slice(0, 200),
      category,
      priority,
      problem: problem.slice(0, 4000),
      solution: solution.slice(0, 4000),
      implementation: implementation.slice(0, 4000),
      scheduleAt,
      impact: input.impact ? String(input.impact).slice(0, 1000) : null,
      source: ['scan', 'agent', 'user', 'omega'].includes(String(input.source)) ? String(input.source) : 'user',
      createdBy: String(input.createdBy || 'user').slice(0, 100),
      // CI-6 B5: chỉ nhận 'code-workflow' tường minh — ngoài ra mặc định 'llm'
      // (bảo thủ, tương thích ngược client cũ không gửi field này)
      executionMode: input.executionMode === 'code-workflow' ? 'code-workflow' : 'llm',
    },
  }
}
