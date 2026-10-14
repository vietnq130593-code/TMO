/**
 * SELF-DIRECTION ORCHESTRATOR — Bộ não Omega của module Self-direction
 * ====================================
 * (2026-09-12) Module Self-direction: agents tự phát hiện khoảng trống hệ
 * thống → tạo đề xuất chờ Mr. Architect phê duyệt (hoặc ủy quyền Opus duyệt
 * — user decision #3, 2026-09-30: quyền duyệt chuyển từ Omega sang OPUS).
 * Đề xuất được duyệt → ORCHESTRATION:
 *   1. Omega lập kế hoạch (bao nhiêu bước? agent nào làm gì?)
 *   2. Từng bước giao agent thực hiện (persona từ AgentProfile)
 *   3. OMEGA đánh giá output từng bước — đạt mới bàn giao bước kế tiếp,
 *      không đạt → phản hồi + thử lại (max 4 lần).
 *   4. Hoàn tất → OMEGA viết báo cáo hoàn thiện: đã làm gì, làm thế nào,
 *      kết quả từng bước, kết quả sau cùng, đề xuất thêm.
 *
 * USER DIRECTIVE 2026-09-04 (PHÂN CÔNG MỚI — GHI ĐÈ phần đánh giá/báo cáo
 * của user decision #3): OPUS KHÔNG tham gia đánh giá từng bước — OMEGA là
 * agent đánh giá từng bước VÀ thực hiện BÁO CÁO HOÀN THIỆN, kể cả khi ủy
 * quyền bật. Opus giữ 2 vai trò:
 *   - DUYỆT đề xuất thay Mr. Architect khi ủy quyền (opusDelegated=true)
 *     bật — KỂ CẢ đề xuất do chính Opus tạo (tự phê duyệt, user cho phép
 *     tường minh 2026-09-04).
 *   - XEM XÉT phần "## Ý kiến & đề xuất khác" trong BÁO CÁO HOÀN THIỆN do
 *     Omega viết (opusReviewReportSuggestions): tự quyết định có tạo thêm
 *     ĐỀ XUẤT PHÁI SINH tới SELF-DIRECTION hay không. Đề xuất phái sinh ở
 *     status pending — nếu ủy quyền bật, Opus được phê duyệt ngay chính
 *     đề xuất của mình; nếu tắt, chờ Mr. Architect duyệt như đề xuất thường.
 *
 * USER DECISION #3 (2026-09-30, PHÊ DUYỆT — KHÔNG THAY ĐỔI) — PHÂN QUYỀN:
 *   - Ủy quyền phê duyệt (SelfDirectionSettings.opusDelegated): OPUS (CTO)
 *     duyệt/không duyệt đề xuất thay Mr. Architect (kể cả đề xuất của Opus).
 *   - TRIỂN KHAI (generateWorkPlan / executeStep / code-workflow / verify_
 *     and_push) VẪN CỦA OMEGA mọi lúc — việc nội tại orchestration, không
 *     phải ủy quyền.
 *
 * USER REQUEST (2026-10-07) — HÀNH VI ỦY QUYỀN OPUS (GHI ĐÈ cơ chế 2026-09-02):
 *   1. Opus duyệt đề xuất nào → đề xuất ĐẤY được TRIỂN KHAI NGAY LẬP TỨC
 *      (status 'ready' + triggerOrchestration tức thì) — KHÔNG hẹn scheduleAt
 *      một thời điểm khác nữa. (scheduleAt giờ chỉ còn tác dụng trên đường
 *      Mr. Architect TỰ duyệt qua PATCH /api/self-direction/proposals/{id}.)
 *   2. Chỉ SAU khi đề xuất đó được xử lý XONG HẲN — dù hoàn thành hay thất
 *      bại — Opus mới duyệt đề xuất kế (kickOmegaReviewsSerially chờ tới
 *      trạng thái terminal; chống kẹt: stall-kill + sweep re-trigger của
 *      promoteDueProposals bảo đảm mọi proposal active rồi cũng về terminal).
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
 *
 * TASK 32 (2026-09-27) — 2 CƠ CHẾ MỚI (user directive):
 *   (1) OPUS DUYỆT 3 MỨC (khi ủy quyền bật — thay phán quyết nhị phân):
 *       - approve         : vấn đề cần thiết TOÀN BỘ → duyệt nguyên bản
 *       - approve_partial : vấn đề có thật nhưng chỉ MỘT PHẦN đáng làm → Opus
 *                           TỰ CHỈNH SỬA 4 phần nội dung đề xuất (thu hẹp về
 *                           đúng phần cần thiết, kèm scopeNote giữ/bỏ) rồi duyệt
 *                           BẢN ĐÃ CHỈNH — ghi đè proposal + lưu audit
 *                           before/after vào reviewEdits (UI hiển thị)
 *       - reject          : không cần thiết → từ chối kèm lý do
 *       Triển khai sau khi duyệt chạy trên BẢN ĐÃ CHỈNH (nếu partial).
 *   (2) OMEGA RE-PLAN GIỮA CHỪNG: sau khi MỖI bước hoàn thành (đạt), Omega
 *       đánh giá lại các bước CÒN LẠI — keep / adjust (đổi nội dung công việc
 *       HOẶC đổi agent) / drop (bước thừa) / newSteps (việc mới phát sinh).
 *       Thay đổi áp dụng lên ProposalStep trong DB (renumber tuần tự) + lưu
 *       replanHistory (UI hiển thị). Bước verify_and_push cuối được bảo vệ
 *       tuyệt đối. Fail-open: lỗi → giữ kế hoạch cũ, không giết pipeline.
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
// FIX (2026-09-03, Task 23 — E2E quét hệ thống): code-workflow agents đi lạc
// path vì không biết workspace root — import resolver (active workspace qua
// WorkspaceManager, fallback OPENCODE_WORKSPACE/cwd, 5s cache) để chèn hint
// định hướng vào system prompt của bước code-workflow.
import { resolveWorkspaceRoot } from '@/lib/code-team/workspace-root'
import { readdir } from 'fs/promises'
import { parseToolCallsFromOutput, formatMessagesForLLM, extractToolCallsWithDiagnostics, detectBrokenToolCallHint } from '@/lib/tool-calls'
import { Prisma } from '@prisma/client'
// USER DECISION #3 (2026-09-30): ủy quyền phê duyệt SELF-DIRECTION chuyển từ
// Omega sang OPUS (CTO). Import persona Opus cho 3 vai trò ủy quyền: duyệt đề
// xuất / đánh giá bước / viết báo cáo hoàn thiện. (opus-agent chỉ phụ thuộc
// @/lib/db — không có vòng import; KHÔNG sửa src/lib/opus/**.)
import { OPUS_AGENT_NAME, OPUS_INSTRUCTION } from '@/lib/opus/opus-agent'
// R12 (fix P-NEW-2 lượt quan sát 5): user-chat priority — mỗi bước orchestration
// tự nhường chỗ khi request chat của user đang chờ phản hồi.
import { waitForUserChatPriority } from '@/lib/execution/user-run-priority'

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
  /** TASK 32 (mechanism 1): 3 mức — approve (cần thiết toàn bộ) |
   * approve_partial (Opus TỰ CHỈNH SỬA nội dung thu hẹp phạm vi rồi duyệt) |
   * reject */
  decision: 'approve' | 'approve_partial' | 'reject'
  reason: string
  /** approve_partial: phần nào GIỮ, phần nào BỎ (bắt buộc khi approve_partial) */
  scopeNote?: string
  /** approve_partial: nội dung 4 phần đã được Opus chỉnh sửa */
  edited?: {
    title: string
    problem: string
    solution: string
    implementation: string
    impact?: string
  }
}

export interface SdStepEvaluation {
  complete: boolean
  evaluation: string
}

// ==================== CONSTANTS ====================

const OMEGA_FALLBACK_BRAIN = { provider: 'zen', model: 'space-bunny-free' } // 2026-11-30: minimax-m3 EOL 410 → production core zen
// 2026-09-24 (USER DIRECTIVE): Self-Direction review/eval/report path dùng Opus
// (CTO) brain từ DB → zen/nemotron-3-ultra-free. Fail-open: DB error → NIM fallback.
async function resolveOpusBrainForSelfDirection(): Promise<{ provider: string; model: string }> {
  try {
    const opus = await db.agentProfile.findFirst({
      where: { name: 'Opus', enabled: true },
      select: { provider: true, model: true },
    })
    if (opus && opus.provider && opus.model) {
      return { provider: opus.provider, model: opus.model }
    }
  } catch { /* fail-open */ }
  return OMEGA_FALLBACK_BRAIN
}
// Task 20 (2026-09-03): 120s cũ giết chuỗi fallback TRƯỚC khi tới lượt
// (lịch sử: chuỗi fallback NIM cần ~460s khi 3 lõi đầu hang — giờ kimi-k3
// NIM chậm ~120s/call nên trần cao vẫn hợp lý). 600s ≥ worst-case chuỗi;
// trip breaker cho lõi hang nên phần lớn call trở lại tốc độ ~giây.
const LLM_TIMEOUT_MS = Math.max(30_000, parseInt(process.env.SD_LLM_TIMEOUT_MS || '600000', 10) || 600_000)
const MAX_PLAN_STEPS = 12
// FIX (2026-09-03, Task 24 — run#3 E2E): 3 attempts là MỖI attempt tích lũy file
// thật vào workspace (RAMPAGE bước 4 đạt ở lần 2 nhờ file lần 1 giữ lại) — thêm
// attempt 4 tăng xác suất hoàn tất bước implementation lớn mà không tăng rủi ro
// (mỗi attempt có evaluator gate riêng, không phóng tự do).
const MAX_STEP_ATTEMPTS = 4

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
/** Trần an toàn cho ReAct loop 1 bước code-workflow (guard chống loop vô hạn).
 * FIX (2026-09-03, Task 24 — quan sát E2E): 8 calls / 6 turns quá chặt — agent
 * tốn 2-4 call khảo sát (file_list/file_read) + cần 2-4 call ghi file; hết
 * ngân sách giữa chừng → bỏ dở implementation → evaluator fail (3 attempts
 * đều thế). Nới lên 12 calls / 8 turns (mỗi turn ~5-25s ZAI — chấp nhận được).
 * FIX (2026-09-03, lượt quan sát 2 — Run 4 E2E): 12 calls VẪN bị cạn vì agent
 * đốt ngân sách vào khảo sát (thực đo 54/72 call là file_read/file_list, chỉ
 * 7 call ghi file) — các bước implementation lớn (3-4 file) hết budget trước
 * khi ghi xong → 2-3 attempts mới đạt. Nới 18 calls / 10 turns + thêm nudge
 * mid-loop khi agent chỉ đọc không ghi (xem SD_MUTATING_TOOLS dưới đây). */
const SD_CODE_STEP_MAX_TOOL_CALLS = 18
const SD_CODE_STEP_MAX_TURNS = 10
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
 * FIX (2026-09-03, lượt quan sát 2 — Run 4 E2E): tool SỬA workspace — dùng cho
 * nudge mid-loop: nếu agent đã dùng ≥8 tool call mà CHƯA có call sửa file nào
 * (toàn file_read/file_list) → nhắc chuyển sang ghi file NGAY (không đợi hết
 * 18 calls mới kết luận "chưa làm gì").
 */
const SD_MUTATING_TOOLS = new Set(['file_write', 'file_edit', 'file_multi_edit', 'file_delete', 'shell'])

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

/** Receipt 1 bước GIỮA code-workflow — log tool calls đã THỰC THI thật.
 * FIX (2026-09-03, lượt quan sát 2 — Run 4 E2E): thêm `detail` (path file +
 * size/số edit) cho tool sửa/đọc file — evaluator trước đây chỉ thấy
 * "file_write✓" KHÔNG biết file NÀO → không đối chiếu được claim của agent
 * ("đã tạo skills/csv.py") với bằng chứng thật. */
export interface SdToolBatchReceipt {
  kind: 'tool-batch'
  toolCalls: Array<{ tool: string; success: boolean; detail?: string }>
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
//     OpenCode Zen space-bunny-free (chuỗi fallback NIM cũ đã EOL, xoay
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
    // 2026-09-24: resolve Opus brain từ DB → zen/nemotron-3-ultra-free (fail-open NIM).
    // callLLMForAgent: Zen fail → fallback NIM kimi-k3 chain (safety net).
    const brain = await resolveOpusBrainForSelfDirection()
    const result = await withTimeout(
      callLLMForAgent(prompt, brain, systemPrompt, {
        agentName: 'SelfDirection',
        temperature,
        maxTokens,
      }),
      LLM_TIMEOUT_MS,
      `${label} (${brain.provider}/${brain.model})`,
    )
    if (result.content && result.content.trim()) return result.content.trim()
    console.warn(`[SelfDirection] ${label}: chuỗi LLM không trả content — error: ${(result.error || '(không có error detail)').slice(0, 200)}`)
  } catch (err) {
    console.warn(`[SelfDirection] ${label}: chuỗi LLM lỗi (timeout/backend):`, err instanceof Error ? err.message : String(err))
  }
  throw new Error(`${label}: mọi LLM backend đều thất bại (provider hiện tại: ${isZaiEnabledText()} — kiểm tra 429 rate limit / key / timeout)`)
}

/** Lượt quan sát 3: nhánh text lỗi nêu đúng provider đang dùng (zai vs NIM) —
 *  tránh mổ xẻ log lại "chuỗi NVIDIA" khi thực chất ZAI 429. */
function isZaiEnabledText(): string {
  const v = (process.env.LLM_PROVIDER || '').trim().toLowerCase()
  return v === 'zai' || v === 'zai-sdk' || v === 'z-ai'
    ? 'z-ai-sdk (LLM_PROVIDER=zai — GLM gateway, có 429 backoff retry)'
    : 'chuỗi NVIDIA kimi-k3 → fallback chain (kiểm tra NVIDIA_API_KEY_1..4 trong .env)'
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
 * (CTO) duyệt/không duyệt đề xuất thay Mr. Architect (kể cả đề xuất do chính
 * Opus tạo — user directive 2026-09-04). USER DIRECTIVE 2026-09-04: đánh giá
 * bước + báo cáo hoàn thiện LUÔN của Omega (không còn chuyển cho Opus khi ủy
 * quyền). Triển khai vẫn của Omega mọi lúc. Fail-open: DB lỗi → coi như chưa
 * ủy quyền.
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
    return validNames.find(n => n === 'MEGATRON') ?? 'Omega'
  }
  if (lower.includes('verif') || lower.includes('g3') || lower.includes('kiểm định')) {
    return validNames.find(n => n === 'CATALYST') ?? 'Omega'
  }
  if (lower.includes('generat') || lower.includes('g1')) {
    return validNames.find(n => n === 'SHOCWAVE') ?? 'Omega'
  }
  if (lower.includes('g2')) {
    return validNames.find(n => n === 'RAMPAGE') ?? 'Omega'
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
      return { systemPrompt: base, brain: { provider: p.provider || 'zen', model: p.model || 'space-bunny-free' } }
    }
  } catch { /* fail-open */ }
  return {
    systemPrompt: `Bạn là ${name}, một agent trong hệ thống multi-agent TMO. Hoàn thành phần việc được giao một cách chuyên nghiệp, cụ thể và có kết quả rõ ràng.`,
    brain: OMEGA_FALLBACK_BRAIN,
  }
}

// ==================== PERSONA ỦY QUYỀN (USER DECISION #3) ====================

/**
 * USER DIRECTIVE 2026-09-04: persona ĐÁNH GIÁ BƯỚC + VIẾT BÁO CÁO HOÀN THIỆN
 * LUÔN LÀ OMEGA — Opus không tham gia 2 việc này kể cả khi ủy quyền bật
 * (ghi đè phần "chuyển vai trò khi ủy quyền" của user decision #3 — ủy quyền
 * giờ chỉ điều khiển quyền DUYỆT đề xuất). Lập kế hoạch + triển khai +
 * verify_and_push cũng LUÔN của Omega (không đổi).
 *
 * 'evaluate' → systemPrompt là prompt HOÀN CHỈNH (persona + tiêu chí + output
 *   format JSON {"complete","evaluation"} — giữ nguyên format để logic rework
 *   của runOrchestrationInner không đổi).
 * 'report'   → systemPrompt CHỈ là phần persona mở đầu; writeFinalReport ghép
 *   tiếp khung báo cáo (khung cũ giữ nguyên).
 */
async function getReviewerSystemPrompt(kind: 'evaluate' | 'report'): Promise<{ systemPrompt: string; reviewerName: string }> {
  // USER DIRECTIVE 2026-09-04: Omega là người đánh giá từng bước + viết báo
  // cáo hoàn thiện — KHÔNG phân nhánh opusDelegated nữa (Opus chỉ duyệt đề
  // xuất khi ủy quyền + xem "Ý kiến & đề xuất khác" — opusReviewReportSuggestions).
  // FIX 2026-09-04 (rà soát sau triển khai — regression Task 31): khôi phục
  // nhánh kind — nhánh 'report' phải trả persona NGẮN để writeFinalReport ghép
  // khung báo cáo markdown. Bản gộp trước trả nhầm prompt JSON đánh giá bước
  // cho 'report' → system prompt báo cáo chứa 2 chỉ thị mâu thuẫn ("output
  // DUY NHẤT JSON" + khung markdown) → báo cáo có thể ra JSON, phá trích
  // section "Ý kiến & đề xuất khác" cho Opus follow-up.
  return {
    systemPrompt:
      kind === 'evaluate'
        ? 'Bạn là OMEGA — orchestrator, phụ trách ĐÁNH GIÁ chất lượng công việc các agent bàn giao trong module Self-direction.\nĐánh giá THỰC TẾ, không khắt khe quá mức: output CHẤP NHẬN ĐƯỢC nếu agent đã làm phần việc chính của bước (kể cả chưa hoàn hảo mọi chi tiết). CHỈ đánh giá chưa đạt khi output (a) bỏ sót phần việc chính, (b) sai hướng với mô tả công việc, hoặc (c) quá chung chung/khung suông không có kết quả cụ thể nào.\n\nOutput DUY NHẤT một JSON hợp lệ (KHÔNG markdown fence):\n{"complete": true|false, "evaluation": "nhận xét ngắn (1-3 câu, tiếng Việt): điểm đạt; nếu chưa đạt — nêu rõ CẦN BỔ SUNG GÌ cụ thể"}'
        : 'Bạn là OMEGA — orchestrator.',
    reviewerName: 'Omega',
  }
}

// ==================== 1. OPUS REVIEW — duyệt thay Mr. Architect ====================
// USER DECISION #3 (2026-09-30): duyệt chuyển từ Omega sang Opus (CTO) —
// khi ủy quyền (opusDelegated) bật, OPUS duyệt thay Mr. Architect.

/**
 * Opus review 1 đề xuất đang pending (khi được ủy quyền) → approve /
 * approve_partial (TỰ CHỈNH SỬA thu hẹp phạm vi rồi duyệt — Task 32) / reject.
 * Persona = OPUS_INSTRUCTION (CTO) + vai trò duyệt; quyết định ghi danh nghĩa
 * Opus (reviewer='opus', decisionReason "Opus duyệt/không duyệt: ...").
 * Fire-and-forget friendly: caller dùng void opusReviewPending(id).
 */

/** TASK 32 (mechanism 1): parse verdict 3 mức từ output LLM — null khi không
 * parse được JSON (caller quyết định throw/retry). Chịu đựng decision lạ
 * (coi như reject) và object edited thiếu trường (caller validate tiếp). */
function parseOpusReviewVerdict(raw: string): SdReviewVerdict | null {
  try {
    const jsonStr = findBalancedJson(raw.replace(/```(?:json)?/g, ''), 'decision')
    if (!jsonStr) return null
    const obj = JSON.parse(jsonStr) as Record<string, unknown>
    const d = String(obj.decision || '')
    const decision: SdReviewVerdict['decision'] =
      d === 'approve' ? 'approve' : d === 'approve_partial' ? 'approve_partial' : 'reject'
    let edited: SdReviewVerdict['edited'] | undefined
    if (obj.edited && typeof obj.edited === 'object') {
      const e = obj.edited as Record<string, unknown>
      edited = {
        title: String(e.title || '').trim().slice(0, 200),
        problem: String(e.problem || '').trim().slice(0, 4000),
        solution: String(e.solution || '').trim().slice(0, 4000),
        implementation: String(e.implementation || '').trim().slice(0, 4000),
        impact: typeof e.impact === 'string' ? e.impact.trim().slice(0, 1000) : undefined,
      }
    }
    return {
      decision,
      reason: typeof obj.reason === 'string' ? obj.reason.slice(0, 600) : '',
      scopeNote: typeof obj.scopeNote === 'string' ? obj.scopeNote.slice(0, 800) : undefined,
      edited,
    }
  } catch {
    return null
  }
}

/** TASK 32 (mechanism 1): object edited hợp lệ = 4 phần đều có nội dung */
function isValidEditedProposal(e: SdReviewVerdict['edited'] | undefined): boolean {
  if (!e) return false
  return !!(e.title && e.problem && e.solution && e.implementation)
}

export async function opusReviewPending(proposalId: string): Promise<void> {
  if (reviewingProposals.has(proposalId)) return
  reviewingProposals.add(proposalId)
  try {
    const proposal = await db.selfDirectionProposal.findUnique({ where: { id: proposalId } })
    if (!proposal || proposal.status !== 'pending') return

    // TASK 32 (mechanism 1 — 2026-09-27): duyệt 3 MỨC thay vì nhị phân —
    //   approve         : vấn đề CẦN THIẾT TOÀN BỘ → duyệt nguyên bản
    //   approve_partial : vấn đề CÓ THẬT nhưng chỉ MỘT PHẦN đáng làm → Opus
    //                     TỰ CHỈNH SỬA 4 phần nội dung (thu hẹp về đúng phần
    //                     cần thiết, kèm scopeNote giữ/bỏ) rồi duyệt BẢN ĐÃ CHỈNH
    //   reject          : không cần thiết → từ chối kèm lý do
    const systemPrompt = `${OPUS_INSTRUCTION}

━━━ VAI TRÒ HIỆN TẠI (USER DECISION #3 — GHI ĐÈ FORMAT §X CHO NHIỆM VỤ NÀY) ━━━
Bạn là ${OPUS_AGENT_NAME} — CTO của TMO, đang duyệt đề xuất SELF-DIRECTION thay Mr. Architect (được ủy quyền — user decision #3).
Quyết định của bạn có giá trị như quyết định của Mr. Architect. Hãy cân nhắc kỹ lưỡng và chọn 1 trong 3 mức:

1. "approve" — Vấn đề CẦN THIẾT và đáng làm TOÀN BỘ: giải quyết vấn đề thật, cách triển khai khả thi, phạm vi hợp lý → duyệt nguyên bản.

2. "approve_partial" — Vấn đề CÓ THẬT nhưng chỉ MỘT PHẦN đáng làm (phần còn lại chưa cần thiết / vượt phạm vi hợp lý / rủi ro cao chưa đáng). Khi đó bạn PHẢI TỰ CHỈNH SỬA đề xuất cho phù hợp rồi duyệt BẢN ĐÃ CHỈNH:
   - Viết lại ĐỦ 4 phần title/problem/solution/implementation thu hẹp về ĐÚNG phần cần làm — cụ thể, hành động được, KHÔNG tham chiếu "như trên/bên trên".
   - Bắt buộc "scopeNote": nêu rõ phần nào GIỮ, phần nào BỎ, vì sao.
   - KHÔNG dùng approve_partial khi phần cần làm quá nhỏ, không đáng thành đề xuất riêng → khi đó dùng reject.

3. "reject" — KHÔNG cần thiết / mơ hồ / lợi ích không rõ / không khả thi → từ chối kèm lý do để agent đề xuất lại.

Ưu tiên càng cao càng cần triển khai sớm. Sau khi duyệt, việc TRIỂN KHAI vẫn do orchestration của Omega đảm nhận — bạn chỉ quyết định duyệt hay không duyệt.

Output DUY NHẤT một JSON hợp lệ (KHÔNG markdown fence, KHÔNG giải thích ngoài — GHI ĐÈ format §X cho nhiệm vụ này):
{"decision": "approve" | "approve_partial" | "reject", "reason": "lý do ngắn gọn (1-3 câu, tiếng Việt)",
 "scopeNote": "phần giữ/bỏ (BẮT BUỘC khi approve_partial)",
 "edited": {"title": "...", "problem": "...", "solution": "...", "implementation": "...", "impact": "..."}}
("edited" chỉ cần khi approve_partial — 4 phần title/problem/solution/implementation mỗi phần tối thiểu 1 câu cụ thể.)`

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

    // maxTokens 3000 (Task 32 — từ 400): nhánh approve_partial kèm nguyên object
    // edited (4 phần nội dung ~2200+ ký tự) QUA REASONING MODEL (space-bunny
    // failover) — model tiêu token reasoning nội bộ trước khi trả JSON; 1800
    // làm JSON bị cắt giữa chừng → parse fail (quan sát E2E: raw sạch 2233 ký
    // tự ở prompt ngắn OK, prompt thật dài hơn thì cắt). 3000 đủ dư chỗ.
    const raw = await callBrain({ prompt: userPrompt, systemPrompt, maxTokens: 3000, label: `OpusReview ${proposal.id.slice(0, 8)}` })
    let parsed = parseOpusReviewVerdict(raw)
    // JSON parse fail (bị cắt/lạc format) → thử lại 1 lần với nhắc chặt + temp
    // thấp (pattern giống generateWorkPlan); vẫn hỏng → throw (fail-open giữ
    // pending — Mr. Architect vẫn duyệt thủ công được).
    if (!parsed) {
      console.warn('[SelfDirection] OpusReview: verdict JSON không parse được — thử lại lần 2 (temp thấp + nhắc JSON-only)')
      const retryRaw = await callBrain({
        prompt: `${userPrompt}\n\n⚠️ LẦN THỬ LẠI: lần trước output KHÔNG phải JSON hợp lệ (bị cắt/lạc format). Lần này output CHỈ gồm JSON DUY NHẤT ở dòng đầu tiên, không giải thích trước/sau, các chuỗi văn bản giữ NGẮN GỌN (mỗi phần tối đa 3 câu), đảm bảo đóng đủ mọi ngoặc.`,
        systemPrompt,
        maxTokens: 3000,
        temperature: 0.2,
        label: `OpusReview-jsonretry ${proposal.id.slice(0, 8)}`,
      })
      parsed = parseOpusReviewVerdict(retryRaw)
      if (!parsed) throw new Error('Không parse được verdict JSON sau 2 lần thử')
    }
    let verdict: SdReviewVerdict = parsed
    // approve_partial mà edited thiếu nội dung hợp lệ → thử lại 1 lần (nhắc
    // chặt); vẫn hỏng → HẠ XUỐNG reject (an toàn hơn duyệt toàn bộ thứ Opus
    // vừa kết luận chỉ đáng làm 1 phần) — agent nhận lý do rõ để đề xuất lại bản thu hẹp.
    if (verdict.decision === 'approve_partial' && !isValidEditedProposal(verdict.edited)) {
      console.warn('[SelfDirection] OpusReview: approve_partial thiếu object edited hợp lệ — thử lại lần 2 (nhắc chặt)')
      const retryRaw = await callBrain({
        prompt: `${userPrompt}\n\n⚠️ LẦN THỬ LẠI: lần trước trả "approve_partial" nhưng object "edited" thiếu/thiếu nội dung (title/problem/solution/implementation đều BẮT BUỘC, mỗi phần ≥ 1 câu cụ thể). Trả lại JSON đầy đủ.`,
        systemPrompt,
        maxTokens: 3000,
        temperature: 0.2,
        label: `OpusReview-retry ${proposal.id.slice(0, 8)}`,
      })
      const retryParsed = parseOpusReviewVerdict(retryRaw)
      if (retryParsed) verdict = retryParsed
      if (verdict.decision === 'approve_partial' && !isValidEditedProposal(verdict.edited)) {
        verdict = {
          decision: 'reject',
          reason: `${verdict.reason} — Opus định thu hẹp phạm vi nhưng bản chỉnh sửa không hợp lệ; agent đề xuất lại BẢN THU HẸP phần cần thiết`.slice(0, 600),
        }
      }
    }

    const now = new Date()
    // ━━ USER REQUEST (2026-10-07): Ủy quyền Opus duyệt → TRIỂN KHAI NGAY ━━
    // Trước đây: scheduleAt tương lai → status 'approved' + hẹn promoteDueProposals
    // chạy đúng hạn (giữ cho đường Mr. Architect tự duyệt — route PATCH [id]).
    // User chỉ đạo mới: Opus duyệt đề xuất nào thì đề xuất ĐẤY phải được triển
    // khai NGAY LẬP TỨC chứ không hẹn một thời điểm khác. → Đường Opus LUÔN
    // 'ready' + trigger orchestration ngay, bỏ hẳn nhánh dueNow.
    const immediateDeployNote = proposal.scheduleAt && proposal.scheduleAt.getTime() > now.getTime()
      ? ` (triển khai ngay — bỏ hẹn lịch ${proposal.scheduleAt.toISOString()} theo chỉ thị ủy quyền)`
      : ''
    if (verdict.decision === 'approve' || verdict.decision === 'approve_partial') {
      const isPartial = verdict.decision === 'approve_partial'
      // TASK 32 (mechanism 1): approve_partial → GHI ĐÈ nội dung đề xuất bằng
      // bản Opus đã chỉnh + lưu audit before/after vào reviewEdits (Mr.
      // Architect đối chiếu trong UI). Triển khai chạy trên BẢN ĐÃ THU HẸP.
      if (isPartial && verdict.edited) {
        const before = {
          title: proposal.title, problem: proposal.problem, solution: proposal.solution,
          implementation: proposal.implementation, impact: proposal.impact,
        }
        const after = {
          title: verdict.edited.title, problem: verdict.edited.problem, solution: verdict.edited.solution,
          implementation: verdict.edited.implementation,
          impact: [verdict.edited.impact, verdict.scopeNote ? `Phạm vi đã thu hẹp khi duyệt: ${verdict.scopeNote}` : null]
            .filter(Boolean).join(' — ') || null,
        }
        const existingEdits = Array.isArray(proposal.reviewEdits) ? (proposal.reviewEdits as unknown[]) : []
        const editRecord = {
          at: now.toISOString(), reason: verdict.reason, scopeNote: verdict.scopeNote ?? null, before, after,
        }
        await db.selfDirectionProposal.update({
          where: { id: proposalId },
          data: {
            status: 'ready',
            reviewer: 'opus',
            decisionReason: `Opus duyệt (đã thu hẹp phạm vi): ${verdict.reason}${verdict.scopeNote ? ` — Phạm vi: ${verdict.scopeNote}` : ''}`,
            reviewedAt: now,
            title: after.title,
            problem: after.problem,
            solution: after.solution,
            implementation: after.implementation,
            impact: after.impact,
            reviewEdits: [...existingEdits, editRecord] as unknown as Prisma.InputJsonValue,
          },
        })
        console.log(`[SelfDirection] Opus DUYỆT (THU HẸP PHẠM VI) "${proposal.title}" → "${after.title}" → kích hoạt triển khai NGAY${immediateDeployNote}: ${verdict.reason}${verdict.scopeNote ? ` | Phạm vi: ${verdict.scopeNote}` : ''}`)
      } else {
        await db.selfDirectionProposal.update({
          where: { id: proposalId },
          data: {
            status: 'ready',
            // USER DECISION #3: duyệt chuyển từ Omega sang Opus — danh nghĩa Opus
            reviewer: 'opus',
            decisionReason: `Opus duyệt: ${verdict.reason}`,
            reviewedAt: now,
          },
        })
        console.log(`[SelfDirection] Opus DUYỆT "${proposal.title}" → kích hoạt triển khai NGAY${immediateDeployNote}: ${verdict.reason}`)
      }
      // USER REQUEST (2026-10-07): duyệt là triển khai NGAY — trigger ngay tại đây.
      // kickOmegaReviewsSerially sẽ chờ đề xuất này CHẠY XONG HẲN (completed/
      // failed) mới duyệt đề xuất kế.
      //
      // ROUND-52 (user directive 2026-10-07 — "kích hoạt tự động Opus để agent
      // thực thi công việc LIÊN HOÀN, fix để agent triển khai tiếp luôn"): bỏ
      // dry-run nền ở ĐƯỜNG OPUS DUYỆT. Hai lý do:
      // (1) Chuỗi tự động chạy dry-run KHÔNG SHIP gì — proposal "completed" nhưng
      //     thay đổi nằm im trong working tree; user phải tay bấm deploy từng cái
      //     = đứt chuỗi liên hoàn.
      // (2) Workspace active là CHUNG cho mọi proposal — dry-run để lại thay đổi
      //     chưa commit của proposal N, proposal N+1 làm việc đè lên (git_status
      //     trộn lẫn), và lần deploy thật sau đó commit TOÀN BỘ thay đổi tích lũy
      //     của nhiều proposal vào 1 commit (nhiễm chéo phạm vi).
      // Opus duyệt = đã được USER ỦY QUYỀN phê duyệt (user decision #3) → coi
      // như deploy có chủ. Cổng chất lượng KHÔNG đổi: pipeline 9 bước
      // (lint→typecheck→tests→smoke→secret-scan→git-preflight→commit scoped→
      // push→pull-verify) vẫn chạy đầy đủ trước khi commit/push — fail là fail
      // proposal, chuỗi sang đề xuất kế. Đường Mr. Architect hẹn lịch
      // (promoteDueProposals) GIỮ dry-run như quan sát 4.
      void triggerOrchestration(proposalId)
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

// ==================== 1b. OPUS FOLLOW-UP — xem "Ý kiến & đề xuất khác" trong BÁO CÁO HOÀN THIỆN (user directive 2026-09-04) ====================

/**
 * USER DIRECTIVE 2026-09-04: sau khi orchestration kết thúc (completed/failed)
 * và OMEGA viết BÁO CÁO HOÀN THIỆN (đánh giá từng bước + báo cáo đều của Omega
 * — Opus KHÔNG tham gia 2 việc đó), OPUS (CTO) phải xem phần "## Ý kiến & đề
 * xuất khác" trong báo cáo → TỰ QUYẾT ĐỊNH có tạo thêm ĐỀ XUẤT PHÁI SINH tới
 * SELF-DIRECTION hay không:
 *   - Đề xuất phái sinh: status pending, source 'agent', createdBy 'Opus',
 *     followUpParentId = đề xuất cha, followUpDepth = depth cha + 1.
 *   - Ủy quyền (opusDelegated) ĐANG BẬT → Opus được PHÊ DUYỆT CHÍNH ĐỀ XUẤT
 *     CỦA MÌNH ngay (user cho phép tường minh — opusReviewPending, quyền như
 *     Mr. Architect). Ủy quyền TẮT → chờ Mr. Architect duyệt tab "Chờ phê duyệt".
 *
 * Chống lặp/vòng lặp: (1) marker opusFollowUpAt — mỗi báo cáo Opus chỉ xem 1
 * lần (user bấm "Thử lại" → triggerOrchestration reset marker → báo cáo MỚI
 * được xem lại); (2) cap độ sâu chuỗi MAX_FOLLOW_UP_DEPTH; (3) in-process lock
 * reviewingFollowUps; (4) sweep rate-limit 60s/lần kick.
 * LLM lỗi → KHÔNG đánh dấu đã xem (fail-open như OpusReview — sweep thử lại).
 */

/** Trần độ sâu chuỗi phái sinh: gốc(0) → phái sinh(1) → phái sinh²(2) — dừng. */
const MAX_FOLLOW_UP_DEPTH = 2
/** Sweep chỉ kick 1 review mỗi 60s (poll UI 4s gọi liên tục — tránh LLM storm) */
const FOLLOW_UP_SWEEP_MIN_INTERVAL_MS = 60_000

const globalForFollowUp = globalThis as unknown as {
  __tmoSdReviewingFollowUps?: Set<string>
  __tmoSdFollowUpSweepAt?: number
}
const reviewingFollowUps: Set<string> = (globalForFollowUp.__tmoSdReviewingFollowUps ??= new Set())

/** Trích 1 section "## <tiêu đề chứa re>" từ báo cáo markdown (đến ## kế hoặc hết). Trả null nếu không có/rỗng. */
function extractReportSection(report: string, headingRe: RegExp): string | null {
  const lines = report.split('\n')
  let startIdx = -1
  for (let i = 0; i < lines.length; i++) {
    if (/^##\s/.test(lines[i]) && headingRe.test(lines[i])) {
      startIdx = i + 1
      break
    }
  }
  if (startIdx === -1) return null
  const body: string[] = []
  for (let i = startIdx; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) break
    body.push(lines[i])
  }
  const text = body.join('\n').trim()
  return text || null
}

/**
 * OPUS xem xét "Ý kiến & đề xuất khác" trong báo cáo hoàn thiện của 1 đề xuất
 * đã kết thúc → quyết định tạo/không tạo đề xuất phái sinh. Fire-and-forget
 * friendly: caller dùng void opusReviewReportSuggestions(id).
 */
export async function opusReviewReportSuggestions(proposalId: string): Promise<void> {
  if (reviewingFollowUps.has(proposalId)) return
  reviewingFollowUps.add(proposalId)
  try {
    const proposal = await db.selfDirectionProposal.findUnique({
      where: { id: proposalId },
      select: {
        id: true, title: true, status: true, omegaReport: true, executionMode: true,
        followUpDepth: true, opusFollowUpAt: true,
      },
    })
    if (!proposal) return
    if (!['completed', 'failed'].includes(proposal.status)) return
    if (proposal.opusFollowUpAt) return // đã xem xét (Thử lại sẽ reset marker)
    if (!proposal.omegaReport) {
      // Không có báo cáo (stall-kill chưa kịp viết...) — đánh dấu rỗng, không retry
      await db.selfDirectionProposal.update({
        where: { id: proposalId },
        data: { opusFollowUpAt: new Date(), opusFollowUpResult: 'Đề xuất kết thúc không kịp có báo cáo hoàn thiện — không có gì để Opus xem xét' },
      })
      return
    }
    if (proposal.followUpDepth >= MAX_FOLLOW_UP_DEPTH) {
      await db.selfDirectionProposal.update({
        where: { id: proposalId },
        data: {
          opusFollowUpAt: new Date(),
          opusFollowUpResult: `Không xem xét thêm — chuỗi phái sinh đã đạt độ sâu tối đa (${proposal.followUpDepth}/${MAX_FOLLOW_UP_DEPTH}, chống vòng lặp)`,
        },
      })
      return
    }

    // Lưu ý regex: "đề" = U+1EC1 (ề), KHÔNG phải U+1EC7 (ệ) — mở lớp ký tự
    // đủ biến thể để chống sai dấu (đã từng bug: match ệ → MISS oan).
    const opinions = extractReportSection(proposal.omegaReport, /đ[ềệe]\s*xu[ấậa]t\s*kh[áa]c/i)
    const finalOutcome = extractReportSection(proposal.omegaReport, /k[ếệe]t\s*qu[ảa]\s*sau\s*c[ùu]ng/i)
    if (!opinions) {
      await db.selfDirectionProposal.update({
        where: { id: proposalId },
        data: {
          opusFollowUpAt: new Date(),
          opusFollowUpResult: 'Báo cáo không có phần "Ý kiến & đề xuất khác" — không có gì để xem xét',
        },
      })
      console.log(`[SelfDirection] OpusFollowUp "${proposal.title}": báo cáo không có phần ý kiến — bỏ qua`)
      return
    }

    // Danh sách đề xuất đang chờ duyệt — cho Opus tránh tạo trùng lặp
    const pendingTitles = await db.selfDirectionProposal.findMany({
      where: { status: 'pending' },
      select: { title: true },
      orderBy: { createdAt: 'desc' },
      take: 10,
    }).catch(() => [] as Array<{ title: string }>)

    const systemPrompt = `${OPUS_INSTRUCTION}

━━━ VAI TRÒ HIỆN TẠI (USER DIRECTIVE 2026-09-04 — GHI ĐÈ FORMAT §X CHO NHIỆM VỤ NÀY) ━━━
Bạn là ${OPUS_AGENT_NAME} — CTO của TMO. Agent OMEGA vừa kết thúc orchestration đề xuất Self-direction và viết BÁO CÁO HOÀN THIỆN. Phần "Ý kiến & đề xuất khác" trong báo cáo DO OMEGA TẠO RA — bạn phải xem và TỰ QUYẾT ĐỊNH: có đáng tạo thêm MỘT ĐỀ XUẤT KHÁC tới SELF-DIRECTION dựa trên ý kiến đó không.
Nguyên tắc quyết định:
- CHỈ tạo khi ý kiến CỤ THỂ, HÀNH ĐỘNG ĐƯỢC, có giá trị thật cho hệ thống (vấn đề thật + hướng giải rõ ràng).
- KHÔNG tạo khi: ý kiến chung chung/khung suông, đã có đề xuất tương tự đang chờ duyệt (đối chiếu danh sách bên dưới), hoặc việc đã được đề xuất gốc giải quyết xong.
- Ý kiến trong BÁO CÁO THẤT BẠI (khắc phục nguyên nhân thất bại) vẫn có giá trị — cân nhắc nếu nguyên nhân nằm trong kiểm soát hệ thống.
- Đề xuất mới phải ĐỘC LẬP, đầy đủ rõ 4 phần, KHÔNG tham chiếu "như trên / bên trên / thấy ở báo cáo".

Output DUY NHẤT một JSON hợp lệ (KHÔNG markdown fence, KHÔNG giải thích ngoài):
{"create": true|false, "reason": "lý do ngắn gọn (1-2 câu, tiếng Việt)",
 "proposal": {"title": "tiêu đề ngắn", "category": "gap|kb_contradiction|tool_failure|missing_skill|missing_test|improvement|long_term", "priority": "low|medium|high|critical",
 "problem": "Vấn đề là gì? (2-4 câu cụ thể)", "solution": "Giải quyết như thế nào? (2-4 câu)", "implementation": "Triển khai như thế nào? (từng việc cụ thể, agent làm được)",
 "impact": "Tác động kỳ vọng (1 câu)", "executionMode": "llm" }}
("proposal" chỉ cần khi create=true; executionMode "code-workflow" nếu việc cần agents sửa CODE THẬT trong workspace; create=true mà proposal thiếu/sai format → hệ thống coi như create=false)`

    const userPrompt = `ĐỀ XUẤT VỪA KẾT THÚC: ${proposal.title} (kết quả: ${proposal.status === 'completed' ? 'HOÀN TẤT' : 'THẤT BẠI'}, chế độ: ${proposal.executionMode})

PHẦN "KẾT QUẢ SAU CÙNG" TRONG BÁO CÁO (ngữ cảnh, do Omega viết):
${(finalOutcome || '(không có)').slice(0, 600)}

PHẦN "Ý KIẾN & ĐỀ XUẤT KHÁC" DO OMEGA TẠO RA (bạn đang xem xét):
${opinions.slice(0, 1600)}

CÁC ĐỀ XUẤT ĐANG CHỜ DUYỆT (tránh tạo trùng lặp):
${pendingTitles.length > 0 ? pendingTitles.map(p => `- ${p.title}`).join('\n') : '(không có)'}

Quyết định (JSON).`

    // maxTokens 1400 (FIX 2026-09-04 — nâng từ 900): JSON create=true chứa
    // nguyên đề xuất 4 trường (implementation "từng việc cụ thể" dễ dài) —
    // 900 làm JSON bị cắt giữa chừng → parse fail → sweep retry 60s vô hạn
    // với kết quả gần như xác định (temp thấp). 1400 = ngang writeFinalReport.
    // FIX Task 32 (E2E 2026-09-27): 1400 → 2800 — ZEN FAILOVER space-bunny là
    // reasoning model đốt 1400-4000 token nội bộ trước khi trả JSON; 1400 làm
    // JSON đề xuất phái sinh bị cắt → sweep retry 60s vô hạn.
    const raw = await callBrain({ prompt: userPrompt, systemPrompt, maxTokens: 2800, temperature: 0.3, label: `OpusFollowUp ${proposal.id.slice(0, 8)}` })
    const jsonStr = findBalancedJson(raw.replace(/```(?:json)?/g, ''), 'create')
    if (!jsonStr) throw new Error('Không parse được verdict JSON')
    const obj = JSON.parse(jsonStr) as Record<string, unknown>
    const create = obj.create === true
    const reason = typeof obj.reason === 'string' ? obj.reason.slice(0, 500) : ''

    let childId: string | null = null
    if (create && obj.proposal && typeof obj.proposal === 'object') {
      const p = obj.proposal as Record<string, unknown>
      const validated = validateProposalInput({
        title: p.title, problem: p.problem, solution: p.solution, implementation: p.implementation,
        category: p.category, priority: p.priority, impact: p.impact, executionMode: p.executionMode,
        scheduleAt: null, source: 'agent', createdBy: 'Opus',
      })
      if (validated.ok) {
        const originNote = `Đề xuất phái sinh do Opus (CTO) xem xét "Ý kiến & đề xuất khác" trong BÁO CÁO HOÀN THIỆN của đề xuất "${proposal.title}" (${proposal.id}) do Omega viết.`
        const child = await createSelfDirectionProposal({
          ...validated.data,
          status: 'pending',
          followUpParentId: proposal.id,
          followUpDepth: proposal.followUpDepth + 1,
          impact: validated.data.impact ? `${originNote} ${validated.data.impact}` : originNote,
        })
        childId = child.id
        console.log(`[SelfDirection] OpusFollowUp: Opus TẠO ĐỀ XUẤT PHÁI SINH "${child.title}" (${child.id.slice(0, 10)}, depth ${proposal.followUpDepth + 1}) từ báo cáo "${proposal.title}" — ${reason}`)
      } else {
        console.warn(`[SelfDirection] OpusFollowUp: đề xuất phái sinh của Opus không hợp lệ (${validated.error}) — coi như không tạo`)
      }
    }

    // Ủy quyền đang bật → Opus PHÊ DUYỆT CHÍNH ĐỀ XUẤT CỦA MÌNH (user directive
    // 2026-09-04 cho phép tường minh). USER REQUEST (2026-10-07): KHÔNG duyệt
    // trực tiếp ngay tại đây nữa — gọi qua cổng autoReviewPendingIfDelegated()
    // để tôn trọng TUẦN TỰ: chỉ duyệt khi không còn đề xuất active, duyệt xong
    // 1 cái chờ xử lý xong hẳn mới duyệt cái kế (trước đây void opusReviewPending
    // trực tiếp có thể duyệt phái sinh ĐỒNG THỜI với đề xuất serial-queue đang
    // chạy — 2 orchestration chồng nhau, sai chỉ thị "xử lý xong mới duyệt cái
    // kế"). autoReview đã phủ "mọi proposal pending kể cả của chính Opus" —
    // phái sinh sẽ được duyệt ngay khi hàng đợi rảnh.
    if (childId) {
      const settings = await getSelfDirectionSettings()
      if (settings.opusDelegated) {
        console.log(`[SelfDirection] OpusFollowUp: ủy quyền ĐANG BẬT → xếp đề xuất của chính Opus (${childId.slice(0, 10)}) vào hàng duyệt tuần tự`)
        void autoReviewPendingIfDelegated()
      }
    }

    await db.selfDirectionProposal.update({
      where: { id: proposalId },
      data: {
        opusFollowUpAt: new Date(),
        opusFollowUpResult: childId
          ? `Opus đã tạo đề xuất phái sinh ${childId.slice(0, 10)} từ "Ý kiến & đề xuất khác" — ${reason}`
          : `Opus xem xét "Ý kiến & đề xuất khác" — KHÔNG tạo đề xuất mới: ${reason || '(không nêu lý do)'}`,
      },
    })
    console.log(`[SelfDirection] OpusFollowUp "${proposal.title}": ${childId ? 'đã tạo đề xuất phái sinh' : 'không tạo đề xuất mới'} — ${reason.slice(0, 160)}`)
  } catch (err) {
    // LLM/parse lỗi → KHÔNG đánh dấu đã xem (opusFollowUpAt giữ null) — sweep
    // GET proposals sẽ thử lại khi LLM hồi phục (fail-open như OpusReview).
    console.warn(`[SelfDirection] OpusFollowUp ${proposalId} lỗi (sẽ thử lại qua sweep):`, err instanceof Error ? err.message : String(err))
  } finally {
    reviewingFollowUps.delete(proposalId)
  }
}

/**
 * Sweep Opus Follow-up (gọi từ GET /api/self-direction/proposals — poll UI):
 * tìm đề xuất completed/failed CÓ báo cáo CHƯA được Opus xem xét ý kiến → kick
 * review (1 cái/lần, tối thiểu 60s giữa 2 lần kick). Restart-resilient: hook
 * hoàn thiện có thể bị PM2 restart giết giữa chừng → sweep bắt lại; đồng thời
 * phủ HỒI TỐ các báo cáo hoàn thành trước khi tính năng ra đời.
 */
export function sweepOpusFollowUpReviews(): void {
  const g = globalForFollowUp
  const nowMs = Date.now()
  if (g.__tmoSdFollowUpSweepAt && nowMs - g.__tmoSdFollowUpSweepAt < FOLLOW_UP_SWEEP_MIN_INTERVAL_MS) return
  g.__tmoSdFollowUpSweepAt = nowMs
  void (async () => {
    try {
      // FIX 2026-09-04 (rà soát): KHÔNG lọc followUpDepth ở đây — đề xuất
      // depth-2 hoàn tất mà hook bị restart giết cũng phải được sweep tới để
      // opusReviewReportSuggestions đánh dấu "đã đạt độ sâu tối đa" (không
      // tốn LLM) — tránh kẹt opusFollowUpAt null vĩnh viễn (UI hiện "Opus sẽ
      // xem..." mãi cho đề xuất sẽ không bao giờ được review).
      const candidates = await db.selfDirectionProposal.findMany({
        where: {
          status: { in: ['completed', 'failed'] },
          omegaReport: { not: null },
          opusFollowUpAt: null,
        },
        select: { id: true },
        orderBy: { completedAt: 'asc' }, // cũ nhất trước — hồi tố trước, mới sau
        take: 1,
      })
      if (candidates.length === 0) return
      const target = candidates[0]
      if (reviewingFollowUps.has(target.id) || runningOrchestrations.has(target.id)) return
      void opusReviewReportSuggestions(target.id)
    } catch { /* fail-open — poll kế thử lại */ }
  })()
}

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
- Các bước triển khai giao agents chỉnh sửa code THẬT qua tool executor (RAMPAGE implement, SENTINEL review/bug, SHOCWAVE thiết kế API/schema, CATALYST tối ưu/hiệu năng...).
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
    // FIX (2026-09-03, Task 23 — E2E quét hệ thống): LLM (glm-4-plus qua ZAI)
    // trả plan JSON malformed giữa chừng ("Expected ',' or ']' after array
    // element at position 1938") → rơi kế hoạch generic 5 bước, mất chi tiết
    // phân công của Omega. 2 cải thiện: (1) maxTokens 1600 → 2400 — plan 5-6
    // bước × description dài dễ vượt ngân sách; (2) thử tối đa 2 LẦN — lần 2
    // nhiệt độ thấp (0.2) + lưu ý cú pháp chặt, LLM models thường trả JSON
    // sạch ở lần retry. Vẫn fail → default plan như cũ (fail-open).
    let plan: SdWorkPlan | null = null
    for (let attempt = 1; attempt <= 2 && !plan; attempt++) {
      const raw = await callBrain({
        prompt: userPrompt,
        systemPrompt:
          attempt === 2
            ? `${systemPrompt}\n\n⚠️ LẦN THỬ LẠI: lần trước JSON bị lỗi cú pháp (thiếu dấu phẩy/ngoặc). Lần này output CHỈ gồm JSON hợp lệ, mô tả mỗi bước ≤400 ký tự, kiểm tra kỹ dấu phẩy giữa các phần tử và đóng đủ ngoặc "}]}.`
            : systemPrompt,
        maxTokens: 2400,
        temperature: attempt === 2 ? 0.2 : 0.4,
        label: 'OmegaPlan',
      })
      plan = parsePlanJson(raw, names, isCodeWorkflow, proposal.executionMode)
    }
    if (plan) return plan
    throw new Error('Plan JSON rỗng/sai shape sau 2 lần thử')
  } catch (err) {
    console.warn('[SelfDirection] OmegaPlan lỗi — dùng kế hoạch mặc định:', err instanceof Error ? err.message : String(err))
    return defaultPlan(proposal.title, names, proposal.executionMode)
  }
}

/**
 * FIX (2026-09-03, Task 23): tách parse plan JSON ra helper riêng để retry được
 * (trước đây parse inline trong generateWorkPlan — fail là bỏ luôn, không thử
 * lại). Trả null khi JSON rỗng/sai shape (caller quyết retry hay default).
 */
function parsePlanJson(
  raw: string,
  names: string[],
  isCodeWorkflow: boolean,
  executionMode: string,
): SdWorkPlan | null {
  try {
    const jsonStr = findBalancedJson(raw.replace(/```(?:json)?/g, ''), 'steps')
    if (!jsonStr) return null
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
    if (steps.length === 0) return null
    // CI-6 B5: kế hoạch code-workflow PHẢI kết thúc bằng verify_and_push (Omega)
    if (isCodeWorkflow) steps = ensureFinalVerifyStep(steps)
    // Mọi step kế thừa executionMode của proposal (per-step flag)
    steps = steps.map(s => ({ ...s, executionMode }))
    return {
      planSummary: String(obj.planSummary || `Kế hoạch ${steps.length} bước do Omega lập`).slice(0, 500),
      steps,
    }
  } catch {
    return null
  }
}

function defaultPlan(title: string, validNames: string[], executionMode = 'llm'): SdWorkPlan {
  const pick = (n: string) => (validNames.includes(n) ? n : 'Omega')
  const steps: SdPlanStep[] = [
    { title: 'Phân tích & thiết kế giải pháp chi tiết', description: `Phân tích vấn đề của đề xuất "${title.slice(0, 80)}", xác định yêu cầu, rủi ro, thiết kế giải pháp cụ thể trước khi triển khai. Kết quả: bản thiết kế rõ ràng các việc cần làm.`, assignee: pick('MEGATRON'), executionMode },
    { title: 'Triển khai phần lõi của giải pháp', description: 'Thực hiện phần việc chính theo thiết kế ở bước 1. Kết quả: phần lõi hoàn thành kèm mô tả cụ thể đã làm gì.', assignee: pick('SHOCWAVE'), executionMode },
    { title: 'Triển khai phần bổ trợ & tích hợp', description: 'Hoàn thiện các phần phụ thuộc, tích hợp phần lõi vào tổng thể hệ thống. Kết quả: hệ thống đồng bộ, không bỏ sót.', assignee: pick('RAMPAGE'), executionMode },
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

// ==================== 2b. RE-PLAN — Omega đánh giá lại các bước còn lại sau mỗi bước hoàn thành (TASK 32 — mechanism 2) ====================

/**
 * TASK 32 (2026-09-27, user directive): sau khi MỖI bước hoàn thành (đạt),
 * OMEGA check lại các bước CÒN LẠI của kế hoạch có còn phù hợp với kết quả
 * thực tế vừa có không — đúng yêu cầu "thay đổi nội dung công việc, thay đổi
 * agent, thậm chí thay đổi lại công việc khác phù hợp hơn":
 *   - keep    : bước còn đúng → giữ nguyên (mặc định an toàn)
 *   - adjust  : đổi nội dung công việc (title/description) HOẶC đổi agent
 *               (assignee) cho khớp kết quả bước vừa xong
 *   - drop    : bước đã bị kết quả bước trước giải quyết trọn / thừa → bỏ
 *   - newSteps: việc MỚI phát sinh → chèn TRƯỚC bước verify_and_push cuối
 * Bước verify_and_push cuối (code-workflow) được BẢO VỆ tuyệt đối (force keep
 * — pipeline kiểm định là đường duy nhất đẩy code). Mọi thay đổi áp dụng lên
 * ProposalStep trong DB (renumber tuần tự tiếp sau các bước đã xong) + lưu
 * proposal.replanHistory (UI hiển thị) + console log.
 *
 * Fail-open tuyệt đối: LLM/parse/DB lỗi → trả null (giữ nguyên kế hoạch cũ) —
 * re-plan là CẢI THIỆN, không bao giờ được phép giết pipeline.
 *
 * Trả về: hàng đợi MỚI (toàn bộ — gồm cả prefix các bước đã xong) khi có ít
 * nhất 1 thay đổi thật; null khi không còn bước nào / không đổi gì / lỗi.
 */
export async function maybeReplanAfterStepCompletion(params: {
  proposal: { id: string; title: string; problem: string; solution: string; executionMode: string }
  currentQueue: SdPlanStep[]
  doneIndex: number
  doneOutputs: Array<{ title: string; output: string }>
  isCodeWorkflow: boolean
}): Promise<SdPlanStep[] | null> {
  const { proposal, currentQueue, doneIndex, doneOutputs, isCodeWorkflow } = params
  try {
    // Nguồn chân lý các bước còn lại: DB (status pending) — mang stepOrder thật
    // (đã renumber qua các lần re-plan trước nếu có).
    const pendingRows = await db.proposalStep.findMany({
      where: { proposalId: proposal.id, status: 'pending' },
      orderBy: { stepOrder: 'asc' },
    })
    if (pendingRows.length === 0) return null

    // Tối ưu chi phí: bước còn lại DUY NHẤT là verify_and_push (pipeline cố
    // định của Omega — không có gì để đánh giá lại) → bỏ qua LLM call.
    const lastPending = pendingRows[pendingRows.length - 1]
    if (isCodeWorkflow && pendingRows.length === 1 && isVerifyAndPushStep({ title: lastPending.title, assignee: lastPending.assignee }, true)) {
      return null
    }

    const justDone = currentQueue[doneIndex]
    if (!justDone) return null
    const justDoneOutput = doneOutputs[doneOutputs.length - 1]?.output || '(trống)'
    const { names } = await rosterInfo()

    const systemPrompt = `Bạn là OMEGA — orchestrator của hệ thống multi-agent TMO. Một bước trong kế hoạch triển khai VỪA HOÀN THÀNH với kết quả cụ thể. Nhiệm vụ: ĐÁNH GIÁ LẠI các bước CÒN LẠI cho khớp với kết quả thực tế vừa có.

Nguyên tắc:
- keep: bước còn phù hợp → giữ nguyên (mặc định an toàn).
- adjust: bước còn cần nhưng nội dung công việc HOẶC agent được giao không còn phù hợp với kết quả vừa có → cung cấp ĐẦY ĐỦ title + description + assignee MỚI.
- drop: bước đã bị kết quả bước vừa xong giải quyết trọn / trở nên thừa → bỏ, kèm rationale.
- newSteps: việc MỚI phát sinh từ kết quả bước vừa xong mà kế hoạch chưa đề cập (mảng rỗng nếu không có).
- Bước verify_and_push / pipeline kiểm định cuối KHÔNG bao giờ drop hay adjust.
- KHÔNG bịa việc vô ích để "cho có thay đổi" — kế hoạch đã ổn thì replanNeeded=false.

Output DUY NHẤT một JSON hợp lệ (KHÔNG markdown fence):
{"replanNeeded": true|false, "reason": "tóm tắt 1-3 câu (tiếng Việt)",
 "steps": [{"stepOrder": <số bước còn lại>, "action": "keep"|"adjust"|"drop", "title": "(khi adjust)", "description": "(khi adjust)", "assignee": "(khi adjust)", "rationale": "(khi adjust/drop)"}],
 "newSteps": [{"title": "...", "description": "...", "assignee": "TÊN agent", "rationale": "..."}]}
(steps chỉ gồm các bước CÒN LẠI; keep chỉ cần stepOrder; replanNeeded=false khi giữ nguyên tất cả.)`

    const remainingText = pendingRows
      .map(r => `Bước ${r.stepOrder}. [${r.assignee}] ${r.title} — ${r.description.slice(0, 250)}`)
      .join('\n')
    const doneContext = doneOutputs.slice(-3)
      .map(p => `• [${p.title}]: ${p.output.slice(0, 300)}`)
      .join('\n') || '(chưa có)'

    const userPrompt = `ĐỀ XUẤT ĐANG TRIỂN KHAI: ${proposal.title}
VẤN ĐỀ: ${proposal.problem.slice(0, 400)}
GIẢI PHÁP ĐÃ DUYỆT: ${proposal.solution.slice(0, 400)}

BƯỚC VỪA HOÀN THÀNH: ${justDone.title} [${justDone.assignee}]
KẾT QUẢ BÀN GIAO CỦA BƯỚC ĐÓ:
${justDoneOutput.slice(0, 1200)}

NGỮ CẢNH CÁC BƯỚC TRƯỚC ĐÓ:
${doneContext}

CÁC BƯỚC CÒN LẠI CỦA KẾ HOẠCH:
${remainingText}

AGENT ROSTER (chọn assignee từ đây): ${names.join(', ')}

Đánh giá lại các bước còn lại (JSON).`

    const raw = await callBrain({ prompt: userPrompt, systemPrompt, maxTokens: 2400, temperature: 0.3, label: `OmegaRePlan ${proposal.id.slice(0, 8)}` })
    const jsonStr = findBalancedJson(raw.replace(/```(?:json)?/g, ''), 'replanNeeded')
    if (!jsonStr) return null
    const obj = JSON.parse(jsonStr) as Record<string, unknown>
    if (obj.replanNeeded !== true) {
      console.log(`[SelfDirection] RePlan sau bước ${doneIndex + 1}: Omega KHÔNG điều chỉnh (${typeof obj.reason === 'string' ? obj.reason.slice(0, 140) : 'kế hoạch còn phù hợp'})`)
      return null
    }
    const reason = typeof obj.reason === 'string' ? obj.reason.slice(0, 600) : ''
    const rawStepDecisions = Array.isArray(obj.steps) ? obj.steps : []
    const rawNewSteps = Array.isArray(obj.newSteps) ? obj.newSteps : []

    // stepOrder → decision (bỏ entry lạ)
    const decisionMap = new Map<number, { action: 'keep' | 'adjust' | 'drop'; title?: string; description?: string; assignee?: string; rationale?: string }>()
    for (const d of rawStepDecisions) {
      if (!d || typeof d !== 'object') continue
      const rec = d as Record<string, unknown>
      const order = Number(rec.stepOrder)
      if (!Number.isFinite(order)) continue
      const action = rec.action === 'adjust' ? 'adjust' : rec.action === 'drop' ? 'drop' : 'keep'
      decisionMap.set(order, {
        action,
        title: typeof rec.title === 'string' ? rec.title.slice(0, 150) : undefined,
        description: typeof rec.description === 'string' ? rec.description.slice(0, 800) : undefined,
        assignee: typeof rec.assignee === 'string' ? rec.assignee : undefined,
        rationale: typeof rec.rationale === 'string' ? rec.rationale.slice(0, 400) : undefined,
      })
    }

    const doneCount = doneIndex + 1
    const changes: Array<Record<string, unknown>> = []
    const survivorRowIds: string[] = []
    const survivorDefs: SdPlanStep[] = []

    for (let j = 0; j < pendingRows.length; j++) {
      const row = pendingRows[j]
      const d = decisionMap.get(row.stepOrder)
      // BẢO VỆ verify_and_push cuối (code-workflow): force keep mọi trường hợp
      const isProtectedVerify = isCodeWorkflow && j === pendingRows.length - 1
        && isVerifyAndPushStep({ title: row.title, assignee: row.assignee }, true)
      const action = isProtectedVerify ? 'keep' : (d?.action ?? 'keep')

      if (action === 'drop') {
        await db.proposalStep.delete({ where: { id: row.id } })
        changes.push({
          action: 'drop', stepOrder: row.stepOrder,
          old: { title: row.title, description: row.description, assignee: row.assignee },
          rationale: d?.rationale || '',
        })
        continue
      }

      if (action === 'adjust' && d?.title && d?.description) {
        const newAssignee = normalizeAssignee(d.assignee, names)
        await db.proposalStep.update({
          where: { id: row.id },
          data: { title: d.title, description: d.description, assignee: newAssignee },
        })
        changes.push({
          action: 'adjust', stepOrder: row.stepOrder,
          old: { title: row.title, description: row.description, assignee: row.assignee },
          new: { title: d.title, description: d.description, assignee: newAssignee },
          rationale: d?.rationale || '',
        })
        survivorRowIds.push(row.id)
        survivorDefs.push({ title: d.title, description: d.description, assignee: newAssignee, executionMode: proposal.executionMode })
        continue
      }

      if (action === 'adjust') {
        console.warn(`[SelfDirection] RePlan: adjust bước ${row.stepOrder} thiếu title/description — giữ nguyên (an toàn)`)
      }
      // keep (mặc định an toàn — gồm cả trường hợp LLM không nhắc tới bước này)
      survivorRowIds.push(row.id)
      survivorDefs.push({ title: row.title, description: row.description, assignee: row.assignee, executionMode: proposal.executionMode })
    }

    // newSteps — cap tổng ≤ MAX_PLAN_STEPS, chèn TRƯỚC verify_and_push cuối
    const slots = Math.max(0, MAX_PLAN_STEPS - doneCount - survivorDefs.length)
    const newDefs: SdPlanStep[] = []
    const newRowIds: string[] = []
    for (const ns of rawNewSteps) {
      if (newDefs.length >= slots) break
      if (!ns || typeof ns !== 'object') continue
      const rec = ns as Record<string, unknown>
      const title = typeof rec.title === 'string' ? rec.title.trim().slice(0, 150) : ''
      const description = typeof rec.description === 'string' ? rec.description.trim().slice(0, 800) : ''
      if (!title || !description) continue
      const assignee = normalizeAssignee(typeof rec.assignee === 'string' ? rec.assignee : null, names)
      newDefs.push({ title, description, assignee, executionMode: proposal.executionMode })
      changes.push({
        action: 'new',
        new: { title, description, assignee },
        rationale: typeof rec.rationale === 'string' ? rec.rationale.slice(0, 400) : '',
      })
    }

    if (changes.length === 0) {
      console.log(`[SelfDirection] RePlan sau bước ${doneCount}: Omega giữ nguyên toàn bộ ${pendingRows.length} bước còn lại — ${reason.slice(0, 140)}`)
      return null
    }

    // Vị trí chèn newSteps: trước verify_and_push cuối (code-workflow), không
    // thì chèn cuối danh sách.
    let insertAt = survivorDefs.length
    if (isCodeWorkflow && survivorDefs.length > 0) {
      const lastDef = survivorDefs[survivorDefs.length - 1]
      if (isVerifyAndPushStep({ title: lastDef.title, assignee: lastDef.assignee }, true)) insertAt = survivorDefs.length - 1
    }

    // Tạo rows mới (order tạm cao — được renumber ngay sau) theo đúng thứ tự chèn
    for (const nd of newDefs) {
      const created = await db.proposalStep.create({
        data: {
          proposalId: proposal.id,
          stepOrder: doneCount + 500 + newRowIds.length,
          title: nd.title, description: nd.description, assignee: nd.assignee,
          status: 'pending',
        },
      })
      newRowIds.push(created.id)
    }

    // Hàng đợi cuối cùng (đúng thứ tự) + renumber tuần tự từ doneCount+1
    const finalDefs = [...survivorDefs]
    finalDefs.splice(insertAt, 0, ...newDefs)
    const finalRowIds = [...survivorRowIds]
    finalRowIds.splice(insertAt, 0, ...newRowIds)
    for (let k = 0; k < finalRowIds.length; k++) {
      await db.proposalStep.update({ where: { id: finalRowIds[k] }, data: { stepOrder: doneCount + 1 + k } })
    }

    // Lịch sử re-plan (UI hiển thị) — chỉ ghi khi có thay đổi THẬT
    const entry = {
      at: new Date().toISOString(),
      afterStepOrder: doneCount,
      afterStepTitle: justDone.title,
      afterStepAssignee: justDone.assignee,
      reason: reason || '(không nêu)',
      changes,
    }
    const cur = await db.selfDirectionProposal.findUnique({ where: { id: proposal.id }, select: { replanHistory: true } })
    const history = Array.isArray(cur?.replanHistory) ? (cur?.replanHistory as unknown[]) : []
    await db.selfDirectionProposal.update({
      where: { id: proposal.id },
      data: { replanHistory: [...history, entry] as unknown as Prisma.InputJsonValue },
    })

    const changeSummary = changes.map(c =>
      c.action === 'drop' ? `bỏ bước ${c.stepOrder}`
      : c.action === 'adjust' ? `đổi bước ${c.stepOrder} → "${(c.new as { title?: string })?.title}" [${(c.new as { assignee?: string })?.assignee}]`
      : `thêm "${(c.new as { title?: string })?.title}" [${(c.new as { assignee?: string })?.assignee}]`,
    ).join('; ')
    console.log(`[SelfDirection] RePlan sau bước ${doneCount}/${doneCount + finalDefs.length} "${justDone.title}": ${changeSummary} — lý do: ${reason.slice(0, 200)}`)
    return [...currentQueue.slice(0, doneIndex + 1), ...finalDefs]
  } catch (err) {
    // Fail-open: lỗi bất kỳ → giữ nguyên kế hoạch, KHÔNG giết pipeline
    console.warn(`[SelfDirection] RePlan sau bước ${doneIndex + 1} lỗi (fail-open — giữ kế hoạch hiện tại):`, err instanceof Error ? err.message : String(err))
    return null
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
        // FIX Task 32 (E2E 2026-09-27): 900 → 2500 — reasoning model failover
        // (space-bunny) đốt token nội bộ; 900 làm output agent bị cắt cụt giữa
        // chừng (quan sát: 149 chars trả về sau 3997 tokens tổng).
        maxTokens: 2500,
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
 * LLM call cho ReAct loop code-workflow: callLLMForAgent (persona brain). Khi
 * LLM_PROVIDER=zai (Task 21) callLLMForAgent route qua z-ai-sdk (glm-4-plus,
 * ~1s); mặc định đi chuỗi NVIDIA model-first (kimi-k3 → fallback chain). LLM
 * fail trả null — caller tổng hợp output trung thực.
 */
/** Tool call đã được inner loop OpenCode CLI THỰC THI (native + tmo_* bridge).
 *  Shape lầy từ LLMResult.executed_tool_calls (llm.ts) — chỉ dùng làm RECEIPT,
 *  tuyệt đối KHÔNG thực thi lại (chống double-execution). (fix 2026-09-25) */
interface SdExecutedToolCall {
  function: { name: string; arguments: string }
}

/** Map tên tool native của OpenCode CLI → tên chuẩn TMO tool (cho receipts).
 *  tmo_* bridge tools ĐÃ được map ở llm.ts (tmo_file_read → file_read...). */
const SD_CLI_NATIVE_TOOL_MAP: Record<string, string> = {
  write: 'file_write',
  edit: 'file_edit',
  read: 'file_read',
  bash: 'shell',
  todowrite: 'todo_write',
  glob: 'file_list',
  ls: 'file_list',
  grep: 'grep',
}

/** Ghi receipts từ CLI-executed tool calls (map tên + lầy detail từ args).
 *  Chỉ giữ tool nằm trong SD_CODE_TOOL_ALLOWLIST (sau khi map) — tool lạ
 *  ('invalid', tool plugin khác...) bị bỏ. Trả về số receipts đã ghi. */
function recordCliExecutedReceipts(
  executed: SdExecutedToolCall[],
  toolCallsLog: Array<{ tool: string; success: boolean; detail?: string }>,
): number {
  let recorded = 0
  for (const tc of executed) {
    const rawName = tc?.function?.name || ''
    const tmoName = SD_CLI_NATIVE_TOOL_MAP[rawName] || rawName
    if (!SD_CODE_TOOL_ALLOWLIST.has(tmoName)) continue
    let detail = ''
    try {
      const a = JSON.parse(tc.function.arguments || '{}') as Record<string, unknown>
      const d = a.path ?? a.filePath ?? a.file_path ?? a.command ?? a.pattern ?? a.query ?? ''
      if (typeof d === 'string') detail = d.replace(/\s+/g, ' ').slice(0, 120)
    } catch { /* args không phải JSON — detail trống */ }
    toolCallsLog.push({ tool: tmoName, success: true, detail: detail || undefined })
    recorded++
  }
  return recorded
}

async function callStepBrain(params: {
  prompt: string
  systemPrompt: string
  brain: { provider: string; model: string }
  agentName: string
  label: string
}): Promise<{ content: string | null; cliExecuted: SdExecutedToolCall[] }> {
  const { prompt, systemPrompt, brain, agentName, label } = params
  try {
    const result = await withTimeout(
      callLLMForAgent(prompt, brain, systemPrompt, {
        agentName,
        temperature: 0.4,
        // FIX (2026-09-03, Task 24 — quan sát E2E): 1400 tokens KHÔNG đủ phát
        // file_write có nội dung code (200-400 dòng ≈ 3-5K tokens) → output bị
        // cắt cụt giữa JSON → parser drop → agent tưởng đã ghi file. Nới lên
        // 4000 (đủ 1 file vừa + text quanh; file to vẫn phải chia append).
        maxTokens: 4000,
      }),
      LLM_TIMEOUT_MS,
      `${label} (${agentName}) (NVIDIA chain)`,
    )
    // (fix 2026-09-25) CLI-executed tool calls đi kèm — caller ghi receipts,
    // KHÔNG thực thi lại (inner loop OpenCode CLI đã chạy thật các tool này).
    const cliExecuted: SdExecutedToolCall[] = (result.executed_tool_calls as SdExecutedToolCall[] | undefined) ?? []
    if (result.content && result.content.trim()) return { content: result.content.trim(), cliExecuted }
    // Content rỗng nhưng CÓ executed tool calls — inner loop đã làm việc,
    // model chỉ không viết báo cáo text. Trả tool calls để caller tổng hợp
    // output trung thực từ receipts.
    if (cliExecuted.length > 0) return { content: null, cliExecuted }
    // FIX 2026-10-15 (user report "output trống lần cuối"): content rỗng là LỖI
    // thật — log rõ error của chuỗi để truy nguyên nhân (key/timeout/model)
    // thay vì im lặng trả null khiến evaluateStep đánh giá output trống mù.
    console.warn(
      `[SelfDirection] ${label} (${agentName}): LLM trả content rỗng — error: ${(result.error || '(không có error detail)').slice(0, 200)}`,
    )
  } catch (err) {
    console.warn(`[SelfDirection] ${label} (${agentName}): LLM call lỗi:`, err instanceof Error ? err.message : String(err))
  }
  return { content: null, cliExecuted: [] }
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
  /** FIX (2026-09-03, lượt quan sát 2): true khi orchestration chạy lại đề xuất đã fail trước đó — prompt sẽ nhắc agent tận dụng file còn sót */
  isRetry?: boolean
}): Promise<{ output: string; receipt: SdToolBatchReceipt }> {
  const { proposal, step, previousOutputs, reworkFeedback } = params
  const persona = await agentPersona(step.assignee)
  const sessionId = `sd-${proposal.id}`

  // FIX (2026-09-03, Task 23 — E2E quét hệ thống, ROOT CAUSE chính của failure
  // "Mở rộng thư viện kỹ năng"): cả 3 bước đi lạc path — 22 tool call vô nghĩa
  // (../lib, lib/skills, src/lib/skills — path escape bị chặn + ENOENT lặp lại
  // qua 3 attempts × 3 agents) vì system prompt KHÔNG cho agent biết workspace
  // root là gì và bên trong có gì. Chèn hint định hướng: root tuyệt đối +
  // listing top-level thật + cảnh báo khi workspace gần trống. Fail-open:
  // lỗi resolve → hint rỗng, giữ hành vi cũ.
  let workspaceHint = ''
  try {
    const root = await resolveWorkspaceRoot()
    const entries = await readdir(root, { withFileTypes: true })
    const names = entries.slice(0, 30).map(e => `${e.name}${e.isDirectory() ? '/' : ''}`)
    const onlyHidden = entries.length > 0 && entries.every(e => e.name.startsWith('.'))
    workspaceHint = `

WORKSPACE ROOT (mọi đường dẫn tương đối tính TỪ ĐÂY — "../" BỊ CHẶN, path escape bị từ chối): ${root}
Nội dung top-level hiện có: ${names.length > 0 ? names.join(', ') : '(trống)'}${
      onlyHidden
        ? `\n⚠️ Workspace GẦN TRỐNG (chỉ thư mục ẩn như .git) — KHÔNG có source có sẵn. ĐỪNG cố tìm "lib/", "src/", "skills/" không tồn tại — nếu bước cần cấu trúc mới, hãy TẠO file mới bằng file_write với đường dẫn tương đối từ root. Báo cáo trung thực nếu phạm vi công việc VƯỢT KHÔNG GIAN workspace (khai báo rõ trong output để người đánh giá xử lý).`
        : ''
    }`
  } catch { /* fail-open: không hint */ }

  const systemPrompt = `${persona.systemPrompt}

═══════════════════════════════════════════
 CHẾ ĐỘ CODE-WORKFLOW — THỰC THI WORKSPACE THẬT (SELF-DIRECTION)
═══════════════════════════════════════════
Bạn đang thực hiện 1 bước kế hoạch cần THAY ĐỔI CODE THẬT trong workspace active. Bạn có TOOL THẬT — mọi tool call thực thi thật trên hệ thống file và git của workspace.
${workspaceHint}

Cú pháp tool call (1 hoặc nhiều trong 1 lượt, mỗi call 1 dòng):
tool_call: tên_tool({"tham_số": "giá trị"})

Tools khả dụng + THAM SỐ BẮT BUỘC:
- file_read({"path": "...", "offset"?: 1, "limit"?: 2000}) — đọc file (path bắt buộc).
- file_list({"path": "."}) — liệt kê thư mục.
- file_write({"path": "...", "content": "...", "mode"?: "overwrite"|"append"}) — tạo/ghi file. NỘI DUNG CODE NHIỀU DÒNG: DÙNG FORMAT FENCE-BLOCK (bên dưới) thay vì nhét code vào JSON string (phải escape \n + mọi dấu " — rất hay lỗi).
- file_edit({"path": "...", "old_str": "...", "new_str": "..."}) — sửa file hiện có (old_str phải khớp CHÍNH XÁC đoạn gốc).
- grep({"pattern": "...", "path"?: "."}) — tìm text trong workspace.
- shell({"command": "..."}) — chạy lệnh (KHÔNG git commit/push/pull).
- git_status() / git_diff() / git_log() — xem trạng thái git (KHÔNG tham số).
- lint() / type_check() / run_tests() — kiểm định.

FORMAT FENCE-BLOCK cho file_write (KHUYÊN DÙNG khi ghi file code — không cần escape gì cả):
tool_call: file_write({"path": "<đường dẫn file THẬT trong workspace của bạn>", "mode": "overwrite"})
\`\`\`python
<nội dung file GỐC — nhiều dòng, dấu " tự do, KHÔNG cần escape>
\`\`\`
(Lưu ý: path ở trên là placeholder — thay bằng đường dẫn thật của dự án, KHÔNG tạo thư mục literal từ ví dụ.)

Quy tắc:
- LÀM ĐÚNG PHẠM VI BƯỚC NÀY (fix 2026-09-25): chỉ làm đúng phần việc trong MÔ TẢ CÔNG VIỆC của bước — khảo sát thì chỉ khảo sát + báo cáo; triển khai thì triển khai đúng scope; chạy thử thì chạy + báo cáo kết quả. KHÔNG làm trước phần việc của các bước SAU (mỗi bước có agent chuyên trách riêng, pipeline sẽ kiểm định lại từng bước). Làm vượt scope = bị đánh giá CHƯA ĐẠT.
- KHẢO SÁT GỌN: tối đa ~5 lượt file_read/file_list/git_status ĐẦU bước — sau đó PHẢI bắt đầu tạo/sửa file. Ưu tiên file_write (overwrite lần đầu + append các lần sau) — file_edit chỉ dùng khi đã file_read và copy old_str NGUYÊN VĂN (bất khớp whitespace = fail).
- ⚠️ KHÔNG ĐOÁN ĐƯỜNG DẪN (lượt quan sát 1 — 10/18 call fail vì đoán path không tồn tại): trước khi file_read một path CHƯA XÁC NHẬN, hãy grep (tên symbol/file) hoặc file_list thư mục cha TRƯỚC. Chỉ file_read khi path đã thấy trong kết quả list/grep/git_status, hoặc khi chấp nhận miss. Đặc biệt: package.json và mọi JSON đã có cấu trúc — KHÔNG append text vào sau ký tự "}" cuối (JSON vỡ); muốn thêm script/field thì file_read toàn file rồi file_write lại NGUYÊN file JSON hợp lệ.
- Đọc file trước khi sửa (file_read). Tạo file mới/file lớn: file_write chia phần (~200-400 dòng/lần, lần đầu mode "overwrite", các lần sau "append").
- KHÔNG commit/push/pull (bị chặn ở bước này) — pipeline kiểm định ở bước CUỐI sẽ commit + push mọi thay đổi.
- Giới hạn ${SD_CODE_STEP_MAX_TOOL_CALLS} tool call cho bước này — làm phần việc CHÍNH, gọn.
- ⚠️ TRUNG THỰC tuyệt đối về bằng chứng: CHỈ được khai "đã tạo/sửa file X" khi BẠN VỪA gọi file_write/file_edit cho X TRONG BƯỚC NÀY và tool trả success. Tool receipt là bằng chứng DUY NHẤT người đánh giá tin — khai file không có receipt = thất bại trắng (bước bị đánh fail). File do bước TRƯỚC tạo KHÔNG phải thành quả của bạn.
- Xong (hoặc hết ngân sách): viết báo cáo output TEXT THUẦN (~150 từ, KHÔNG JSON, KHÔNG format report của persona — ghi đè format đó cho nhiệm vụ này): đã làm gì, file nào đã sửa/tạo bằng tool THÀNH CÔNG (đường dẫn), bằng chứng kiểm chứng (lint/type_check/file_read), còn vấn đề gì.`

  const handover = previousOutputs.length > 0
    ? previousOutputs.map(p => `• [Bước "${p.title}"]: ${p.output.slice(0, 400)}`).join('\n')
    : '(bước đầu tiên — chưa có bàn giao)'

  const userPrompt = `ĐỀ XUẤT ĐANG TRIỂN KHAI (code-workflow): ${proposal.title}
VẤN ĐỀ GỐC: ${proposal.problem.slice(0, 600)}
GIẢI PHÁP ĐÃ DUYỆT: ${proposal.solution.slice(0, 600)}
${proposal.userNotes ? `GHI CHÚ MR. ARCHITECT (bắt buộc tuân thủ): ${proposal.userNotes.slice(0, 400)}` : ''}
${params.isRetry ? `\n⚠️ LẦN CHẠY LẠI: đề xuất này đã thất bại ít nhất 1 lần trước đó — workspace CÓ THỂ còn file từ lần chạy trước (dùng git_status/file_list xem trước khi tạo mới). KHÔNG xóa file cũ — tiếp tục/phát triển trên nền hiện có khi có ích. Chỉ khai báo file do BẠN tạo/sửa trong BƯỚC NÀY (theo tool receipt của bước này).\n` : ''}
KẾT QUẢ BÀN GIAO TỪ CÁC BƯỚC TRƯỚC:
${handover}

BẠN (${step.assignee}) THỰC HIỆN BƯỚC ${step.stepOrder}: ${step.title}
MÔ TẢ CÔNG VIỆC: ${step.description}
${reworkFeedback ? `\n⚠️ PHẢN HỒI TỪ OMEGA VỀ LẦN THỬ TRƯỚC (chưa đạt — phải khắc phục): ${reworkFeedback.slice(0, 600)}` : ''}

Bắt đầu: khảo sát bằng tool (git_status/file_list/file_read) rồi sửa code thật. Kết thúc bằng báo cáo text thuần.`

  const messages: Array<{ role: 'user' | 'assistant' | 'tool'; content: string }> = [
    { role: 'user', content: userPrompt },
  ]
  const toolCallsLog: Array<{ tool: string; success: boolean; detail?: string }> = []
  let lastAssistant = ''
  let output = ''
  // FIX 2026-10-15: đếm lượt LLM fail — tổng hợp vào output trung thực khi cả
  // ReAct loop chết vì LLM (không còn output rỗng → evaluateStep không rơi vào
  // fail-open mù "output trống lần cuối, chấp nhận để mở kẹt pipeline").
  let llmFailTurns = 0
  // FIX (2026-09-03, Task 24): số lần đẩy broken-tool-call feedback — cap 3
  // chống LLM lặp vô hạn format sai.
  let brokenCallFeedbacks = 0
  // FIX (2026-09-03, Task 24 — run#3): số nudge "tiếp tục đi, chưa xong thì
  // đừng kết luận" — cap 2/attempt.
  let incompleteNudges = 0
  // FIX (2026-09-03, lượt quan sát 2 — Run 4 E2E): đã nhắc "chuyển sang ghi file"
  // khi agent đốt budget vào khảo sát (chỉ đọc không ghi)? Cap 1 lần/bước.
  let surveyNudged = false

  for (let turn = 1; turn <= SD_CODE_STEP_MAX_TURNS; turn++) {
    const formatted = formatMessagesForLLM(messages)
    const { content, cliExecuted } = await callStepBrain({
      prompt: formatted,
      systemPrompt,
      brain: persona.brain,
      agentName: step.assignee,
      label: `CodeStep ${step.stepOrder}`,
    })
    if (!content && cliExecuted.length === 0) {
      llmFailTurns++
      break
    }
    lastAssistant = content || lastAssistant

    // ━━ CLI NATIVE RECEIPTS BRIDGE (fix 2026-09-25 — E2E 2026-09-25 lộ conflict) ━━
    // Khi LLM chạy qua OpenCode CLI, inner loop của CLI TỰ THỰC THI tool (native
    // write/bash/read + tmo_* bridge) — công việc đã XONG, content là báo cáo
    // cuối. Trước đây receipts của bước luôn rỗng ("thực thi THẬT 0 tool call")
    // dù agent đã làm thật → evaluator kết luận oan "bịa đặt/không có bằng
    // chứng" (E2E: bước "chạy thử script" fail oan 3 lần liên tiếp). Giờ: ghi
    // receipts từ CLI-executed tool calls (map tên về chuẩn TMO, KHÔNG thực
    // thi lại — chống double-execution) rồi chốt output = báo cáo của agent.
    if (cliExecuted.length > 0) {
      const recorded = recordCliExecutedReceipts(cliExecuted, toolCallsLog)
      console.log(`[SelfDirection] CodeStep ${step.stepOrder} [${step.assignee}] CLI inner loop đã thực thi ${cliExecuted.length} tool — ghi ${recorded} receipt (bridge, không re-exec)`)
      if (content) {
        output = content
        break
      }
      // Content rỗng (hiếm) — tổng hợp output trung thực từ receipts rồi dừng
      const okCount = toolCallsLog.filter(t => t.success).length
      output = `Đã thực thi ${toolCallsLog.length} tool call trong workspace thật (${okCount} thành công): ${toolCallsLog.map(t => `${t.tool}${t.success ? '✓' : '✗'}${t.detail ? `(${t.detail})` : ''}`).join(', ')}. [CLI inner loop đã làm việc — tổng hợp từ receipts, model không viết báo cáo text]`
      break
    }
    if (!content) {
      // content rỗng + không có executed calls — caller tổng hợp ở cuối
      break
    }
    messages.push({ role: 'assistant', content })

    const { calls: toolCalls, parseFailures } = extractToolCallsWithDiagnostics(content)
    if (toolCalls.length === 0) {
      // FIX (2026-09-03, Task 24 — ROOT CAUSE failure run#2 "Mở rộng thư viện
      // kỹ năng"): output CÓ dấu hiệu tool_call nhưng parse fail (JSON lỗi vì
      // code nhiều dòng nhét trong string / bị cắt maxTokens) → trước đây rơi
      // vào nhánh này, output = content (chứa tool_call dở) được coi là BÁO CÁO
      // CUỐI → agent tưởng đã ghi file, evaluator thấy 0 file_write → fail.
      // Giờ: đẩy feedback hướng dẫn phát lại (kể cả format fence-block) và
      // TIẾP TỤC vòng ReAct thay vì kết luận. Feedback giới hạn 3 lần (chống
      // LLM lặp vô hạn — sau đó chấp nhận làm output như cũ).
      const hint = detectBrokenToolCallHint(content)
      if (hint && brokenCallFeedbacks < 3) {
        brokenCallFeedbacks++
        messages.push({ role: 'user', content: hint })
        continue
      }
      // FIX (2026-09-03, Task 24 — run#3 E2E): agent KẾT LUẬN SỚM với tự thừa
      // nhận việc chưa xong (BOLT bước 5: "chưa triển khai code... cần tiếp
      // tục triển khai" — rồi dừng luôn, không làm tiếp) → bước fail dù còn
      // budget/turns. Nếu output tự nhận CHƯA HOÀN THÀNH + còn ngân sách →
      // đẩy nudge TIẾP TỤC thay vì chấp nhận kết luận. Cap 2 nudge/attempt.
      const admitsIncomplete = /(chưa\s+(?:triển\s*khai|tạo|được\s+(?:tạo|viết)|xong|hoàn\s*thành|làm)|cần\s+(?:tiếp\s*tục|bổ\s*sung))/i.test(content)
      if (
        admitsIncomplete &&
        incompleteNudges < 2 &&
        toolCallsLog.length < SD_CODE_STEP_MAX_TOOL_CALLS - 2 &&
        turn < SD_CODE_STEP_MAX_TURNS
      ) {
        incompleteNudges++
        messages.push({
          role: 'user',
          content: '⚠️ Báo cáo của bạn THỪA NHẬN công việc CHƯA hoàn thành — KHÔNG kết luận lúc này. TIẾP TỤC thực hiện NGAY bằng tool_call (ghi file bằng file_write — dùng format fence-block cho code nhiều dòng, chia append nếu dài; file_edit cho file có sẵn). Chỉ viết báo cáo cuối khi phần việc CHÍNH của bước đã xong THẬT (có tool receipt).',
        })
        continue
      }
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
      // FIX (2026-09-03, lượt quan sát 2 — Run 4 E2E): receipt kèm detail (path +
      // size/số edit) — evaluator + báo cáo đối chiếu được claim của agent với
      // file THẬT đã ghi. Result là object (file tools) hoặc string (error).
      let detail = ''
      try {
        const r = res.result as unknown
        if (r && typeof r === 'object') {
          const ro = r as Record<string, unknown>
          if (typeof ro.path === 'string') {
            detail = `${ro.path}${typeof ro.bytesWritten === 'number' ? ` (${ro.bytesWritten}B)` : typeof ro.editsApplied === 'number' ? ` (${ro.editsApplied} edit)` : ''}`
          } else if (typeof ro.error === 'string') {
            detail = ro.error.replace(/\s+/g, ' ').slice(0, 100)
          }
        } else if (typeof r === 'string') {
          detail = r.replace(/\s+/g, ' ').slice(0, 100)
        }
      } catch { /* detail rỗng — không quan trọng */ }
      toolCallsLog.push(detail ? { tool: tc.name, success: res.success, detail: detail.slice(0, 120) } : { tool: tc.name, success: res.success })
      messages.push({ role: 'tool', content: sdToolResultToMessage(tc.name, res.success, res.result) })
    }

    // FIX (2026-09-03, lượt quan sát 2 — Run 4 E2E): agent đốt budget vào khảo
    // sát (thực đo 54/72 call là read/list) → bước implementation hết ngân sách
    // trước khi ghi file nào → evaluator fail. Nếu đã ≥8 tool call mà CHƯA có
    // call SỬA file nào thành công → nhắc (1 lần/bước) chuyển sang ghi NGAY.
    const mutatingOk = toolCallsLog.some(t => SD_MUTATING_TOOLS.has(t.tool) && t.success)
    if (!mutatingOk && !surveyNudged && toolCallsLog.length >= 8 && toolCallsLog.length < SD_CODE_STEP_MAX_TOOL_CALLS) {
      surveyNudged = true
      messages.push({
        role: 'user',
        content: '⚠️ Bạn đã dùng nhiều lượt tool cho KHẢO SÁT (đọc/liệt kê) mà chưa tạo/sửa file nào. Nếu bước này cần thay đổi code/file: chuyển sang file_write NGAY (dùng format fence-block, chia append nếu dài). Nếu bước THẬT SỰ chỉ mang tính phân tích/khảo sát thì cứ tiếp tục và kết luận bằng báo cáo text thuần.',
      })
    }

    if (toolCallsLog.length >= SD_CODE_STEP_MAX_TOOL_CALLS) {
      messages.push({
        role: 'user',
        content: '⚠️ Đã dùng hết ngân sách tool call của bước. Viết báo cáo output cuối NGAY (text thuần, KHÔNG tool_call): đã làm gì, file đã sửa, bằng chứng, còn thiếu gì.',
      })
    } else if (parseFailures > 0 && brokenCallFeedbacks < 2) {
      // FIX (2026-09-03, Task 24): 1 số tool call parse được nhưng CÓ call bị
      // drop (JSON lỗi/cắt cụt) — nhắc agent biết có call chưa chạy (tránh
      // tưởng mọi lệnh đã thực thi) + dạy format phát lại an toàn.
      brokenCallFeedbacks++
      messages.push({
        role: 'user',
        content: `⚠️ Lưu ý: ${parseFailures} tool call trong lượt vừa rồi bị LỖI JSON/cắt cụt → KHÔNG được thực thi (các call hợp lệ đã chạy phía trên). Nếu call bị drop đó còn cần cho công việc, hãy phát lại — file_write nhiều dòng nên dùng fence-block.`,
      })
    }
  }

  if (!output && toolCallsLog.length > 0) {
    // FIX (2026-09-03, Task 23 — E2E quét hệ thống): agent hết lượt ReAct
    // (MAX_TURNS) hoặc hết budget tool call TRƯỚC khi viết báo cáo — thực tế
    // thấy: SHOCWAVE "Agent không viết báo cáo tổng kết (hết lượt LLM)" →
    // evaluator chỉ có tool-log thô để đánh giá, chất lượng đánh giá kém.
    // Reserve 1 lượt "final report" RIÊNG NGOÀI vòng ReAct: gửi lại toàn bộ
    // conversation + yêu cầu tổng kết. Nếu LLM fail hoặc vẫn đòi tool_call →
    // bỏ, giữ fallback tổng hợp trung thực như cũ (fail-open).
    try {
      const finalMessages: Array<{ role: 'user' | 'assistant' | 'tool'; content: string }> = [
        ...messages,
        {
          role: 'user',
          content: '⚠️ Đã kết thúc ngân sách tool call/LLM của bước. NGAY BÂY GIỜ viết BÁO CÁO OUTPUT CUỐI (text thuần, KHÔNG tool_call, ~150 từ): đã làm gì, file nào đã sửa/tạo (đường dẫn tương đối từ workspace root), bằng chứng kiểm chứng (file_read/lint/type_check), còn vấn đề gì. Đây là output DUY NHẤT người đánh giá sẽ xem.',
        },
      ]
      const { content: final } = await callStepBrain({
        prompt: formatMessagesForLLM(finalMessages),
        systemPrompt,
        brain: persona.brain,
        agentName: step.assignee,
        label: `CodeStep ${step.stepOrder} final`,
      })
      // Chỉ chấp nhận báo cáo text thuần — LLM vẫn đòi tool_call thì bỏ
      if (final && final.trim() && parseToolCallsFromOutput(final).length === 0) {
        output = final.trim()
      }
    } catch { /* giữ fallback tổng hợp dưới */ }
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
      ? `Đã thực thi ${toolCallsLog.length} tool call trong workspace thật (${toolCallsLog.filter(t => t.success).length} thành công): ${toolCallsLog.map(t => `${t.tool}${t.success ? '✓' : '✗'}${t.detail ? `(${t.detail})` : ''}`).join(', ')}. Agent không viết báo cáo tổng kết (hết lượt LLM) — xem chi tiết tool receipts trong workspaceReceipt.`
      : lastAssistant || `[${step.assignee} chưa tạo được output do LLM call thất bại${llmFailTurns > 0 ? ` (${llmFailTurns} lượt fail — ${isZaiEnabledText()})` : ''} — cần retry]`
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
  else if (result.success) {
    // FIX (2026-09-03, lượt quan sát 2 — Run 4): dry-run bỏ commit thật →
    // commitHash luôn rỗng — không được nói "cây làm việc sạch" khi thực tế
    // có N file chờ commit (Run 4: 19 file). Phân biệt 2 trường hợp rõ ràng.
    lines.push(
      dryRun
        ? 'Không commit — DRY-RUN: mọi kiểm định PASS, commit/push bị bỏ theo chế độ dry-run (file thay đổi vẫn còn trong working tree)'
        : 'Không có commit — cây làm việc sạch, không có gì để commit (đề xuất có thể chỉ mang tính phân tích/tư vấn).',
    )
  }
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
 * USER DIRECTIVE 2026-09-04: OMEGA LUÔN chấm bước đạt/chưa đạt (kể cả khi ủy
 * quyền bật — Opus không tham gia đánh giá từng bước; system prompt persona
 * Omega + context đánh giá). Output format {"complete","evaluation"} GIỮ
 * NGUYÊN → logic rework (MAX_STEP_ATTEMPTS + reworkFeedback) không đổi.
 */
async function evaluateStep(params: {
  step: { stepOrder: number; title: string; description: string; assignee: string }
  output: string
  attempt: number
  /**
   * FIX (2026-09-03, Task 23): receipts tool THẬT của bước code-workflow —
   * evaluator trước đây chỉ thấy output tự tổng hợp của agent (dễ bị đánh
   * lừa: "5/6 file_list✓" được chấm ĐẠT như "triển khai phần lõi"). Giờ nhận
   * thêm bằng chứng tool thô + tiêu chí bắt buộc: bước đòi sửa code mà không
   * có tool sửa file nào thành công → complete PHẢI false. Null/undefined =
   * bước llm-mode (không có receipts) — giữ hành vi cũ.
   * FIX (2026-09-03, lượt quan sát 2): receipt giờ kèm `detail` (path file +
   * size/số edit) — đối chiếu claim của agent với file THẬT đã ghi.
   */
  codeReceipts?: Array<{ tool: string; success: boolean; detail?: string }> | null
}): Promise<SdStepEvaluation> {
  const { systemPrompt, reviewerName } = await getReviewerSystemPrompt('evaluate')

  const receiptsBlock = params.codeReceipts
    ? `\nTOOL ĐÃ THỰC THI TRONG BƯỚC (bằng chứng THẬT từ tool executor, không bịa — detail là path file + size/số edit): ${
        params.codeReceipts.length > 0
          ? params.codeReceipts.map(t => `${t.tool}${t.success ? '✓' : '✗'}${t.detail ? `(${t.detail})` : ''}`).join(', ')
          : '(không có tool call nào)'}\nTIÊU CHÍ BẮT BUỘC (code-workflow): nếu MÔ TẢ công việc đòi THAY ĐỔI/TẠO code hay file thì CHỈ complete=true khi có ít nhất 1 tool sửa file THÀNH CÔNG (file_write/file_edit/file_multi_edit ✓ — kèm path trong detail). Đối chiếu CLAIM của agent ("đã tạo file X") với receipt: file KHÔNG có trong receipt = KHÔNG tính. Chỉ khảo sát/liệt kê file (file_list/grep/file_read) KHÔNG đủ cho bước triển khai. Bước có mô tả thuần phân tích/khảo sát thì đánh giá trên chất lượng phân tích.\n`
    : ''

  const userPrompt = `BƯỚC ${params.step.stepOrder}: ${params.step.title} (agent thực hiện: ${params.step.assignee})
MÔ TẢ CÔNG VIỆC: ${params.step.description}
${receiptsBlock}
OUTPUT AGENT BÀN GIAO (lần thử ${params.attempt}/${MAX_STEP_ATTEMPTS}):
${params.output.slice(0, 2000)}

Đánh giá (JSON).`

  let evalErrMsg = ''
  try {
    // FIX Task 32 (E2E 2026-09-27): 350 → 2000 — evaluator QUA reasoning
    // model failover cần chỗ cho token reasoning nội bộ; 350 làm JSON
    // {complete,evaluation} bị cắt/mất → "không đánh giá được" 4 lần liên tiếp
    // → step fail oan (quan sát E2E bước 1/4 MEGATRON). Trần cao vô hại với
    // model non-reasoning (tự dừng sớm).
    const raw = await callBrain({ prompt: userPrompt, systemPrompt, maxTokens: 2000, temperature: 0.2, label: `StepEval ${params.step.stepOrder}` })
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
    // Lượt quan sát 3: giữ nguyên nhân LLM lỗi (429/timeout) vào evaluation —
    // (1) attempt-loop phát hiện provider-failure để backoff thay vì đốt
    //     attempt tức thời, (2) user nhìn thấy lý do thật trong UI.
    evalErrMsg = err instanceof Error ? err.message : String(err)
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
    evaluation: tagEvaluation(
      reviewerName,
      evalErrMsg
        ? `(không đánh giá được — LLM lỗi: ${evalErrMsg.slice(0, 220)} — KHÔNG chấp nhận mù, cần agent làm lại output chất lượng hơn)`
        : `(không đánh giá được — KHÔNG chấp nhận mù, cần agent làm lại output chất lượng hơn)`,
    ),
  }
}

// ==================== 5. REPORT — báo cáo hoàn thiện (LUÔN do Omega viết — user directive 2026-09-04) ====================

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
  // USER DIRECTIVE 2026-09-04: OMEGA luôn viết báo cáo hoàn thiện (Opus không
  // tham gia — kể cả khi ủy quyền bật). Triển khai vẫn của Omega — các chỗ
  // hardcode "Omega" trong template cũ dùng biến reviewerName.
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

  // USER DIRECTIVE 2026-09-04: Omega luôn viết → không còn prefix danh nghĩa
  // Opus (log cũ của các vòng trước vẫn có prefix — dữ liệu lịch sử, giữ nguyên).
  const reportPrefix = ''

  try {
    // FIX Task 32 (E2E 2026-09-27): 1400 → 3000 — báo cáo hoàn thiện 5 section
    // markdown QUA reasoning model failover cần chỗ cho token nội bộ; 1400 cắt
    // giữa chừng (báo cáo cụt, mất section cuối).
    const raw = await callBrain({ prompt: userPrompt, systemPrompt, maxTokens: 3000, temperature: 0.4, label: `${reviewerName}Report` })
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

    // ━━ Lượt quan sát 5 (2026-09-04): TRIGGER = "sẵn sàng chạy" ━━
    // Hiện tượng: deploy đề xuất failed → runOrchestration xếp hàng mutex
    // serializeCodeWorkflow (chờ run code-workflow trước xong) → PM2 restart
    // giết waiter TRƯỚC khi runOrchestrationInner kịp chạy → proposal kẹt
    // 'failed' vĩnh viễn — sweep "Ready nhưng chưa chạy" (section 2 dưới)
    // chỉ re-trigger status='ready' → run bị MẤT ÂM THẦM không hồi phục
    // (quan sát: mirror_lesson_drift re-deploy 20:16:25UTC, restart 20:45:21UTC
    // giết waiter — proposal về failed, không bao giờ chạy lại). Fix: flip
    // status sang 'ready' NGAY khi trigger (trước khi xếp hàng mutex) → nếu
    // process chết khi waiter đang chờ, sweep section 2 tự re-trigger sau
    // restart. Check-and-add phía trên đã chống double-trigger in-process.
    if (proposal.status !== 'ready') {
      try {
        await db.selfDirectionProposal.update({
          where: { id: proposalId },
          data: {
            status: 'ready',
            // USER DIRECTIVE 2026-09-04: retry chạy lại → BÁO CÁO HOÀN THIỆN MỚI
            // sẽ được viết → reset marker để OPUS xem lại "Ý kiến & đề xuất khác"
            // của báo cáo mới (giữ opusFollowUpResult cũ làm lịch sử cho tới khi
            // được ghi đè).
            opusFollowUpAt: null,
          },
        })
        console.log(`[SelfDirection] Proposal "${proposal.title}" ${proposal.status} → ready (trigger — sẽ tự chạy lại nếu process restart giữa chừng)`)
      } catch { /* best-effort — không chặn trigger */ }
    }

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

// ── Lượt quan sát 4 (2026-09-04): llm-mode proposal đòi THỰC THI VẬT LÝ ──
// Hiện tượng: gq5jtob7 (domain:weak_domains, llm) fail bước 6 "Tích hợp
// entity vào hệ thống" 4 lần — agent llm-mode KHÔNG CÓ TOOL nên không thể
// tích hợp/test thật; trung thực khai "mới test 30%" → evaluator (chấm đúng)
// trượt → 4 attempts lặp vô nghiệm. Ngược lại mirror_episode_drift llm-mode
// "Chạy script backfill" ĐẠT trong 3 GIÂY = bịa báo cáo (perverse incentive:
// agent bịa thì đậu, agent thật thà thì trượt). ALISTA proposal được tạo
// executionMode=llm mặc định dù công việc là backfill/integrate/sync thật.
// Fix: classifier tại trigger — CÁCH TRIỂN KHAI (implementation) khớp động từ
// thực thi + mục tiêu hệ thống/dữ liệu → nâng cấp run lên code-workflow
// (agents có tool thật, receipts đối chiếu, pipeline verify cuối).
const EXECUTION_DEMAND_RE = new RegExp(
  [
    // (1) động từ tạo/sửa code + mục tiêu code (mirror CODE_CHANGE_ACTION_RE scan.ts)
    String.raw`\b(sửa|sua|fix|patch|refactor|viết|viet|rewrite|thêm|them|add|tạo|tao|create|xây|xay|build|implement|commit|push|deploy|xóa|xoa|remove|bổ sung|bo sung)\b`,
    String.raw`[^\n.]{0,60}`,
    String.raw`\b(code|hàm|ham|function|component|module|script|route|api|endpoint|schema|model|prisma|tool|test|hook|middleware|type|interface|file|library|package|bug|lỗi|loi)\b`,
    // (2) động từ THỰC THI + mục tiêu hệ thống/dữ liệu (chạy script, backfill DB,
    // tích hợp vào hệ thống, sync, cài đặt, nạp entity...)
    String.raw`|\b(chạy|run|thực thi|execute|backfill|migrate|migration|import|nạp|nap|seed|sync|đồng bộ|dong bo|cài đặt|cai dat|install|áp dụng|ap dung|integrate|tích hợp|tich hop)\b`,
    String.raw`[^\n.]{0,60}`,
    String.raw`\b(script|database|db|sqlite|neo4j|prisma|bảng|bang|table|record|entity|hệ thống|he thong|system|pipeline|cron|job|queue|api|endpoint)\b`,
  ].join(''),
  'i',
)

/** Classifier lượt 4: kế hoạch triển khai có đòi thực thi vật lý không? */
function planNeedsRealExecution(p: {
  category?: string | null
  problem?: string | null
  solution?: string | null
  implementation?: string | null
}): boolean {
  const category = String(p.category || '').trim()
  if (category === 'kb_contradiction') return false // tri thức thuần — không nâng cấp
  const text = `${p.problem || ''}\n${p.solution || ''}\n${p.implementation || ''}`
  return EXECUTION_DEMAND_RE.test(text)
}

async function runOrchestration(proposalId: string, opts?: { dryRun?: boolean }): Promise<void> {
  // FIX review GĐ2 #2: code-workflow → serialize qua mutex workspace (XEM
  // serializeCodeWorkflow). Đọc executionMode TRƯỚC để quyết định có cần mutex.
  const pre = await db.selfDirectionProposal.findUnique({
    where: { id: proposalId },
    select: { executionMode: true, category: true, problem: true, solution: true, implementation: true },
  })
  // Lượt quan sát 4: llm-mode nhưng CÁCH TRIỂN KHAI đòi chạy/sửa code thật
  // (backfill script, tích hợp vào database, chạy cron...) → nâng cấp lên
  // code-workflow cho run này + persist để UI/reflection thấy đúng chế độ.
  if (pre && pre.executionMode !== 'code-workflow' && planNeedsRealExecution(pre)) {
    await db.selfDirectionProposal.update({ where: { id: proposalId }, data: { executionMode: 'code-workflow' } })
    console.log(`[SelfDirection] Nâng cấp executionMode llm → code-workflow (CÁCH TRIỂN KHAI đòi thực thi code/dữ liệu thật — agents sẽ có tool + receipts, chống báo cáo ảo)`)
    pre.executionMode = 'code-workflow'
  }
  if (pre?.executionMode === 'code-workflow') {
    await serializeCodeWorkflow(() => runOrchestrationInner(proposalId, opts))
    return
  }
  await runOrchestrationInner(proposalId, opts)
}

async function runOrchestrationInner(proposalId: string, opts?: { dryRun?: boolean }): Promise<void> {
  // === Phase 1: PLAN ===
  // FIX (2026-09-03, lượt quan sát 2 — Run 4): chạy lại đề xuất đã fail → xóa
  // completedAt/decisionReason cũ NGAY lúc vào planning — tránh trạng thái sai
  // "status=executing nhưng completedAt còn của lần fail trước" (quan sát:
  // bu58c4 completedAt=16:33 trong khi run 4 executing từ 16:50 — UI hiển thị
  // sai ngày hoàn tất suốt 30 phút chạy).
  const preRow = await db.selfDirectionProposal.findUnique({ where: { id: proposalId }, select: { completedAt: true, executedAt: true, decisionReason: true } })
  await db.selfDirectionProposal.update({
    where: { id: proposalId },
    data: { status: 'planning', ...(preRow?.completedAt || preRow?.decisionReason ? { completedAt: null, decisionReason: null } : {}) },
  })
  const proposal = await db.selfDirectionProposal.findUnique({ where: { id: proposalId } })
  if (!proposal) throw new Error('Proposal biến mất')
  // FIX (2026-09-03, lượt quan sát 2): đây có phải lần chạy LẠI (đề xuất đã từng
  // được triển khai) không — truyền vào executeCodeStepWithTools để nhắc agent
  // tận dụng file còn sót từ lần trước thay vì dựng lại từ đầu.
  const isRetry = !!preRow?.executedAt

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
  // TASK 32 (mechanism 2): hàng đợi bước LINH ĐỘNG — sau mỗi bước hoàn thành,
  // Omega re-plan các bước còn lại (adjust nội dung/agent, drop bước thừa,
  // thêm việc mới) → queue thay thế phần còn lại của vòng lặp này.
  let stepsQueue: SdPlanStep[] = plan.steps
  const doneOutputs: Array<{ title: string; output: string }> = []

  for (let i = 0; i < stepsQueue.length; i++) {
    const stepDef = stepsQueue[i]
    const stepRow = await db.proposalStep.findFirst({ where: { proposalId, stepOrder: i + 1 } })
    if (!stepRow) continue

    await db.proposalStep.update({
      where: { id: stepRow.id },
      data: { status: 'in_progress', startedAt: new Date(), attempts: { increment: 1 } },
    })

    // ━━ R12 (fix P-NEW-2 lượt quan sát 5): USER-CHAT PRIORITY GATE ━━
    // Trước khi bắt đầu mỗi bước: nhường chỗ nếu request chat của user đang chờ
    // phản hồi (bằng chứng lượt 5 §8.3: escalation 6 bước chạy song song run chat
    // → MemWatchdog self-exit, PM2 restart 9 lần/2.5h). Gate là ƯU TIÊN không
    // khóa cứng — hết SD_USER_RUN_MAX_WAIT_MS thì chạy tiếp (semaphore F7 vẫn
    // serialize OC-CLI spawn). Log [SD-Priority] minh bạch từng lần chờ.
    await waitForUserChatPriority(`Bước ${i + 1}/${stepsQueue.length} "${stepDef.title}" [${stepDef.assignee}]`)

    // ── CI-6 B5: bước CUỐI code-workflow → pipeline verify_and_push THẬT ──
    // Thành công của bước = pipeline PASS (đánh giá deterministic — không cần
    // Omega chấm lại); cây sạch → "không có gì để commit" vẫn ĐẠT.
    // FIX (2026-09-03, lượt quan sát 2 — Run 2 tử vong vì 1 lỗi lint): pipeline
    // fail ở bước kiểm định SỬA ĐƯỢC (lint/type_check/run_tests — lỗi code thật
    // trong workspace) → TRƯỚC ĐÂY single-shot fail luôn cả proposal dù 11/12
    // bước đã đạt. Giờ: 1 chu kỳ REPAIR — RAMPAGE nhận chi tiết lỗi, sửa code
    // thật, rồi chạy lại pipeline (tối đa 2 lần chạy / bước). Pipeline fail do
    // git/secret/smoke (không sửa bằng code thường) → giữ hành vi cũ (fail).
    if (isCodeWorkflow && isVerifyAndPushStep(stepDef, i === stepsQueue.length - 1)) {
      const runPipeline = () => executeVerifyAndPushStep({
        proposal: { id: proposal.id, title: proposal.title },
        planSummary: plan.planSummary,
        // FIX 2026-09-02 (audit #2): dryRun tùy chọn từ caller (route deploy đọc
        // body) — mặc định KHÔNG dry-run: pipeline commit + push THẬT lên remote
        // (yêu cầu Mr. Architect: chức năng push code từ workspace phải hoạt động thật).
        dryRun: opts?.dryRun === true,
      })
      let result = await runPipeline()
      const fixableFail = !result.success && result.receipt.steps.some(s => s.status === 'fail' && ['lint', 'type_check', 'run_tests'].includes(s.name))
      if (fixableFail) {
        const failDetail = result.receipt.steps
          .filter(s => s.status === 'fail')
          .map(s => `${s.name} FAIL: ${s.detail || '(không chi tiết)'}`)
          .join('\n')
          .slice(0, 1500)
        console.warn(`[SelfDirection] Bước ${i + 1}/${stepsQueue.length} verify_and_push fail ở bước kiểm định SỬA ĐƯỢC — giao RAMPAGE sửa code rồi chạy lại pipeline (lần 2/2)`)
        await db.proposalStep.update({
          where: { id: stepRow.id },
          data: {
            attempts: { increment: 1 },
            status: 'in_progress',
            output: result.output,
            evaluation: `Pipeline lần 1 THẤT BẠI (bước kiểm định sửa được) — REPAIR đang chạy: ${failDetail.slice(0, 200)}`,
            workspaceReceipt: result.receipt as unknown as Prisma.InputJsonValue,
          },
        })
        const repair = await executeCodeStepWithTools({
          proposal,
          step: {
            stepOrder: i + 1,
            title: 'Sửa lỗi kiểm định (repair verify_and_push)',
            description: `Pipeline kiểm định cuối (verify_and_push) THẤT BẠI ở các bước:\n${failDetail}\nNHIỆM VỤ: đọc file liên quan theo thông báo lỗi, sửa lỗi lint/type/test THẬT trong workspace bằng tool (file_edit/file_write). KHÔNG commit/push — pipeline sẽ tự chạy lại sau khi bạn xong.`,
            assignee: 'RAMPAGE',
          },
          previousOutputs: doneOutputs.slice(-3),
          isRetry,
        })
        await db.proposalStep.update({
          where: { id: stepRow.id },
          data: {
            output: `${result.output}\n\n[REPAIR RAMPAGE]: ${repair.output.slice(0, 1500)}`.slice(0, 3000),
            workspaceReceipt: repair.receipt as unknown as Prisma.InputJsonValue,
          },
        })
        result = await runPipeline()
      }
      if (result.success) {
        const evalNote = result.receipt.commitHash
          ? ` — commit ${result.receipt.commitHash.slice(0, 7)}`
          : opts?.dryRun === true
            ? ' — [DRY-RUN] mọi kiểm định PASS (bỏ commit/push thật theo chế độ dry-run)'
            : ' — cây làm việc sạch, không có gì để commit'
        await db.proposalStep.update({
          where: { id: stepRow.id },
          data: {
            status: 'done',
            output: result.output,
            evaluation: `Pipeline kiểm định ${result.receipt.steps.length} bước PASS${evalNote}`,
            workspaceReceipt: result.receipt as unknown as Prisma.InputJsonValue,
            finishedAt: new Date(),
          },
        })
        doneOutputs.push({ title: stepDef.title, output: result.output })
        // FIX (2026-09-03, lượt quan sát 2 — Run 4): dry-run KHÔNG có commitHash
        // (bỏ commit thật) — log cũ in "cây sạch, không có gì để commit" là SAI
        // sự thật (Run 4 dry-run có 19 file chờ commit nhưng log vẫn nói cây sạch).
        console.log(`[SelfDirection] Bước ${i + 1}/${stepsQueue.length} verify_and_push [Omega] ĐẠT — pipeline PASS${result.receipt.commitHash ? ` (commit ${result.receipt.commitHash.slice(0, 7)}, pushed=${result.receipt.pushed === true})` : opts?.dryRun === true ? ' [DRY-RUN — bỏ commit/push thật]' : ' (cây sạch — không có gì để commit)'}`)
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
      console.warn(`[SelfDirection] Bước ${i + 1}/${stepsQueue.length} verify_and_push THẤT BẠI: ${result.receipt.error || 'xem steps trong workspaceReceipt'}`)
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
      // FIX (2026-09-03, Task 23): reset receipt mỗi attempt (attempt llm-mode
      // sau attempt code-workflow không giữ receipt cũ) + truyền receipts cho
      // evaluateStep làm bằng chứng bắt buộc (bước triển khai không có tool
      // sửa file thành công → KHÔNG ĐẠT).
      lastReceipt = null
      if (isCodeWorkflow) {
        // CI-6 B5 — bước GIỮA: agent persona ReAct qua TOOL THẬT trong workspace
        const r = await executeCodeStepWithTools({
          proposal,
          step: { ...stepDef, stepOrder: i + 1 },
          previousOutputs: doneOutputs.slice(-3),
          reworkFeedback: attempt > 1 ? lastEvaluation : null,
          isRetry,
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
        // FIX (2026-09-03, Task 23): bằng chứng tool thật cho evaluator
        codeReceipts: isCodeWorkflow && lastReceipt ? lastReceipt.toolCalls : null,
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
        console.log(`[SelfDirection] Bước ${i + 1}/${stepsQueue.length} "${stepDef.title}" [${stepDef.assignee}] ĐẠT (lần ${attempt})`)
      } else {
        console.warn(`[SelfDirection] Bước ${i + 1}/${stepsQueue.length} [${stepDef.assignee}] CHƯA ĐẠT (lần ${attempt}): ${lastEvaluation.slice(0, 150)}`)
        // ── Lượt quan sát 3 (2026-09-04): LỖI PROVIDER ≠ lỗi chất lượng —
        // không đốt 4 attempts trong 1 giây khi z-ai gateway 429/timeout.
        // Phát hiện qua output (LLM unavailable/thất bại) hoặc evaluation
        // (mọi LLM backend đều thất bại) → chờ backoff trước attempt kế tiếp.
        const providerFail = /mọi LLM backend đều thất bại|LLM call thất bại|LLM unavailable|status 429|too many requests|rate.?limit/i.test(`${lastOutput}\n${lastEvaluation}`)
        if (providerFail && attempt < MAX_STEP_ATTEMPTS) {
          const waitMs = Math.min(30_000, 10_000 * attempt)
          console.warn(`[SelfDirection] Bước ${i + 1} fail do LLM PROVIDER (429/timeout) — chờ ${Math.round(waitMs / 1000)}s trước lần thử ${attempt + 1} (backoff) thay vì đốt attempt tức thời`)
          await new Promise(r => setTimeout(r, waitMs))
        }
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

    // ── TASK 32 (mechanism 2): OMEGA ĐÁNH GIÁ LẠI CÁC BƯỚC CÒN LẠI sau mỗi
    // bước hoàn thành — kết quả bước vừa có có thể làm các bước sau cần đổi
    // nội dung, đổi agent, bỏ bớt (đã giải quyết xong) hoặc thêm việc mới.
    // Fail-open: lỗi → giữ nguyên kế hoạch, KHÔNG bao giờ giết pipeline.
    // (Bước cuối không có bước sau → không gọi.)
    if (i < stepsQueue.length - 1) {
      const replannedQueue = await maybeReplanAfterStepCompletion({
        proposal,
        currentQueue: stepsQueue,
        doneIndex: i,
        doneOutputs,
        isCodeWorkflow,
      })
      if (replannedQueue) stepsQueue = replannedQueue
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
  // USER DIRECTIVE 2026-09-04: OPUS xem phần "Ý kiến & đề xuất khác" trong
  // BÁO CÁO HOÀN THIỆN vừa lưu (do Omega viết) → tự quyết định tạo đề xuất
  // phái sinh tới SELF-DIRECTION hay không. Fire-and-forget — nếu process
  // restart giữa chừng, sweep GET proposals sẽ bắt lại (opusFollowUpAt null).
  void opusReviewReportSuggestions(proposalId)
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
      // Lượt quan sát 4 (user directive 2026-09-04): trigger nền mặc định DRY-RUN —
      // chỉ user chủ động mới push thật (chỉ thị chỉ push TMO-backup; workspace
      // origin đang trỏ repo TMO app — push nền sẽ bẩn repo app).
      if (await triggerOrchestration(p.id, { dryRun: true })) triggered.push(p.id)
    }
    // 2) Ready nhưng chưa chạy (vd server restart ngay sau promote) → trigger lại.
    //    ROUND-52 (user directive 2026-10-07 — tự động liên hoàn): proposal do
    //    OPUS DUYỆT (reviewer='opus') → deploy THẬT (nhất quán với đường
    //    opusReviewPending — nếu không, proposal Opus duyệt xong bị restart
    //    gián đoạn rồi sweeper nhặt lại bằng dry-run = cùng proposal lúc thì
    //    ship thật lúc thì không, tùy timing). Đường Mr. Architect hẹn lịch
    //    (reviewer ≠ 'opus') GIỮ dry-run theo lượt quan sát 4.
    const ready = await db.selfDirectionProposal.findMany({
      where: { status: 'ready' },
      select: { id: true, reviewer: true, title: true },
    })
    for (const p of ready) {
      const opusApproved = p.reviewer === 'opus'
      if (opusApproved) {
        console.log(`[SelfDirection] Sweeper re-trigger đề xuất Opus duyệt "${p.title}" → deploy THẬT (nhất quán đường opusReviewPending — round-52)`)
      }
      if (await triggerOrchestration(p.id, opusApproved ? undefined : { dryRun: true })) triggered.push(p.id)
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
      // Lượt quan sát 5: chốt LUÔN step in_progress mồ côi — bản cũ chỉ đánh
      // dấu proposal failed mà bỏ step đang chạy → step kẹt "in_progress"
      // vĩnh viễn trong proposal đã thất bại (UI hiển thị sai "đang tiến
      // hành" mãi mãi — quan sát mirror_episode_drift sau restart 20:45UTC)
      const killed = await db.proposalStep.updateMany({
        where: { proposalId: p.id, status: 'in_progress' },
        data: { status: 'failed', finishedAt: new Date() },
      })
      if (killed.count > 0) {
        console.warn(`[SelfDirection] Proposal ${p.id} đánh dấu failed (stalled > 10 phút, không còn tín hiệu sống) + chốt ${killed.count} step mồ côi in_progress → failed`)
      } else {
        console.warn(`[SelfDirection] Proposal ${p.id} đánh dấu failed (stalled > 10 phút, không còn tín hiệu sống)`)
      }
    }

    // 4) STEP MỒ CÔI "in_progress" trong proposal KHÔNG còn chạy (lượt 5).
    //    Nguồn: (a) run bị restart giết khi waiter chờ mutex TRƯỚC khi inner
    //    kịp deleteMany steps cũ (mirror_lesson_drift); (b) reset thủ công
    //    proposal về failed mà step cũ chưa kịp chốt. Proposal không ở trạng
    //    thái planning/executing thì chắc chắn KHÔNG có step nào đang chạy
    //    hợp lệ → chốt thành failed để UI hết hiển thị "đang tiến hành".
    const orphaned = await db.selfDirectionProposal.findMany({
      where: { status: { notIn: ['planning', 'executing'] }, steps: { some: { status: 'in_progress' } } },
      select: { id: true, title: true },
    })
    for (const p of orphaned) {
      if (isOrchestrating(p.id)) continue // đang chạy/chờ mutex trong process này — inner sẽ tự reset steps
      const r = await db.proposalStep.updateMany({
        where: { proposalId: p.id, status: 'in_progress' },
        data: { status: 'failed', finishedAt: new Date() },
      })
      if (r.count > 0) {
        console.warn(`[SelfDirection] Chốt ${r.count} step mồ côi "in_progress" → failed (proposal "${p.title}" không còn chạy — gián đoạn bởi restart/reset)`)
      }
    }
  } catch (err) {
    console.warn('[SelfDirection] promoteDueProposals lỗi (fail-open):', err instanceof Error ? err.message : String(err))
  }
  return triggered
}

/** Ủy quyền đang bật → Opus tự review mọi proposal pending (gọi từ GET proposals) —
 * user decision #3. USER DIRECTIVE 2026-09-04: "mọi proposal pending" bao gồm
 * CẢ ĐỀ XUẤT PHÁI SINH DO CHÍNH OPUS TẠO (opusReviewReportSuggestions) — Opus
 * được phép phê duyệt đề xuất của mình khi ủy quyền bật (user cho phép tường minh). */
export async function autoReviewPendingIfDelegated(): Promise<number> {
  try {
    const settings = await getSelfDirectionSettings()
    if (!settings.opusDelegated) return 0

    // ━━ USER REQUEST (2026-09-02 + 2026-10-07): duyệt tuần tự, chờ xử lý xong ━━
    // Nếu có ĐỀ XUẤT ĐANG ACTIVE (status ready/planning/executing) — kể cả
    // orchestration ĐANG CHẠY trong process này lẪN proposal mồ côi sau restart
    // (đang chờ sweep re-trigger/stall-kill) → KHÔNG duyệt thêm, chờ hết.
    // Bản cũ chỉ hold khi in-process (runningOrchestrations) — proposal mồ côi
    // sau restart bị bỏ qua → Opus duyệt cái kế trong khi cái trước chưa xử lý
    // xong, sai chỉ thị "xử lý xong (dù hoàn thành hay không) mới duyệt cái kế".
    // Chống kẹt vĩnh viễn: mọi proposal active rồi cũng về terminal (orchestration
    // tự chốt / stall-kill 10 phút không tín hiệu → failed / sweep re-trigger).
    const activeOrchestrations = await db.selfDirectionProposal.findMany({
      where: { status: { in: ['ready', 'planning', 'executing'] } },
      select: { id: true },
    })
    if (activeOrchestrations.length > 0) {
      // Lượt quan sát 5: log dedupe — hàm này chạy trên MỌI poll UI (~4s khi
      // module Self-Direction đang mở) → spam "KHÔNG duyệt thêm" mỗi 4 giây
      // suốt thời gian orchestration chạy (quan sát 01:49-01:51UTC: ~40 dòng
      // trong 2.5 phút). Giới hạn 1 dòng/phút — ngữ nghĩa không đổi, chỉ bớt noise.
      const g = globalThis as { __tmoSdDelegHoldLogAt?: number }
      const nowMs = Date.now()
      if (!g.__tmoSdDelegHoldLogAt || nowMs - g.__tmoSdDelegHoldLogAt > 60_000) {
        g.__tmoSdDelegHoldLogAt = nowMs
        const inProcessCount = activeOrchestrations.filter(p => runningOrchestrations.has(p.id)).length
        console.log(`[SelfDirection] Opus KHÔNG duyệt thêm — ${activeOrchestrations.length} đề xuất đang active (${inProcessCount} đang chạy in-process) — chờ xử lý xong mới duyệt cái kế`)
      }
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

      // ━━ USER REQUEST (2026-10-07): chờ đề xuất được XỬ LÝ XONG HẲN ━━
      // Sau khi Opus duyệt (approve → status ready → triggerOrchestration
      // triển khai NGAY), KHÔNG duyệt đề xuất kế cho tới khi đề xuất này kết
      // thúc xử lý — dù HOÀN THÀNH hay THẤT BẠI (user chỉ đạo tường minh:
      // "sau khi đề xuất đó xử lý xong (dù hoàn thành hay không) mới tiến
      // hành tiếp tục phê duyệt đề xuất tiếp theo").
      // Bỏ timeout cứng 10 phút của USER REQUEST (2026-09-02): orchestration
      // code-workflow dài hợp lệ (>10 phút) từng bị cắt đột ngột → duyệt cái
      // kế khi cái trước chưa xong — sai chỉ thị mới. Chống kẹt vĩnh viễn
      // KHÔNG cần timeout: mọi proposal active rồi cũng về trạng thái terminal
      // nhờ (a) orchestration tự chốt completed/failed; (b) stall-kill của
      // promoteDueProposals (scheduler nền chạy mỗi 60s — STALLED_AFTER_MS
      // 10 phút không tín hiệu → failed); (c) sweep section 2 re-trigger
      // 'ready' bị mất âm thầm sau restart. Proposal bị user xóa/từ chối giữa
      // chừng cũng thoát vòng chờ (findUnique null / status ngoài active).
      while (true) {
        try {
          const cur = await db.selfDirectionProposal.findUnique({ where: { id }, select: { status: true } })
          // Không còn row (user xóa hẳn) hoặc đã rời trạng thái active
          // (completed/failed/rejected/...) → xử lý xong → duyệt cái kế.
          if (!cur || !['ready', 'planning', 'executing'].includes(cur.status)) break
        } catch {
          break // DB lỗi đọc trạng thái — cứ tiến hành cái kế (fail-open)
        }
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
