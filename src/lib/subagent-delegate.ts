/**
 * SUB-AGENT DELEGATION — goal-loop on-demand dispatch
 * ====================================
 * (user request 2026-09-08: "các Agents đang thiếu cơ chế gọi sub-agents để
 * giảm tải và chia việc khi cần thiết — thậm chí một Agent như Omega có thể
 * kết nối tới agents team code hoặc gọi team code để xử lý các tác vụ phù hợp")
 *
 * Kiến trúc — CONTEXT ISOLATION là lợi ích cốt lõi:
 *
 *   PARENT (goal loop, vd Omega)
 *     └─ tool_call: delegate_task({agent: "RAMPAGE", task: "..."})
 *        hoặc dispatch_agent({agent: "BẤT KỲ AGENT", task: "..."})
 *          └─ runSubAgentForProfile() — mini ReAct loop IN-PROCESS:
 *              · profile do caller resolve (Code Team qua resolveAgent,
 *                custom/Omega-created qua DB AgentProfile theo tên)
 *              · tối đa SUBAGENT_MAX_ITERATIONS vòng LLM + tool thật
 *              · token budget RIÊNG (SUBAGENT_TOKEN_BUDGET) — onTokens báo lên
 *                parent để cộng vào budget tổng (không thể chạy tuột)
 *              · context của sub-agent KHÔNG đổ vào parent — parent chỉ nhận
 *                BÁO CÁO NÉN (≤ ~3500 chars): đã làm · bằng chứng · còn thiếu
 *              · DEPTH GUARD: sub-agent KHÔNG có delegate_task/dispatch_agent/
 *                create_agent trong whitelist → không bao giờ đệ quy vô hạn.
 *                (escalate_problem ĐƯỢC GIỮ — sub-agent kẹt có thể hỏi Omega
 *                tư vấn; consult là 1 LLM call đơn, không đệ quy.)
 *
 * Vì sao thiết kế này giúp budget 200k:
 *   - Parent context không phình theo lượng file sub-agent đọc (isolation)
 *   - Burn token của sub-agent bị chặn trên cứng (token budget riêng)
 *   - 1 lần delegate ≈ 1 tool result ~1000 tokens trong parent, bất kể
 *     sub-agent đã tiêu bao nhiêu để làm việc
 *
 * Fail-open: mọi lỗi resolve/LLM → trả result success=false + error message
 * (parent agent thấy được lỗi và tự quyết định làm trực tiếp).
 *
 * IMP-1 (2026-09-30, Task G+H — delegation reinforcement-loop fix):
 *   Trước đây vòng lặp reinforcement CHỐNG delegate: cap vòng thấp → 52%
 *   runs chết iteration_limit → trọng tài chấm CHƯA ĐẠT 71% → outcome.success
 *   bị ép false theo evaluation.pass (:918-921 cũ) → hint parent "tự làm trực
 *   tiếp" → Omega học rằng tự làm đáng tin hơn delegate → delegation chiếm
 *   0.29% tool calls. Giờ:
 *   · outcome.success = "usable results DELIVERED" (delivery semantics) —
 *     TÁCH BẠCH khỏi evaluation.pass (verdict CHẤT LƯỢNG nằm trong
 *     outcome.evaluation: pass/gaps — parent đọc để RE-DELEGATE phần còn
 *     thiếu, không phải tín hiệu tự làm thay).
 *   · iteration_limit → success GIỮ true (partial work IS delivered — kèm
 *     report wrap-up + evidence); evaluation.pass=false + gaps chỉ thị phần
 *     chưa xong để parent giao lại.
 *   · W2 (fail-open transparency): evaluator null (lỗi/timeout/JSON hỏng) →
 *     outcome.evaluationMissing=true + ghi chú ⚠ trong report — parent biết
 *     kết quả CHƯA được trọng tài xác nhận (fail-open giữ nguyên design).
 *   · W1 (evidence đói): evidence cho trọng tài là TOOL-RESULT TRANSCRIPT
 *     đầy đủ (entry cap SUBAGENT_TOOL_RESULT_CHARS = 8000 chars — ROUND-27
 *     FIX V1: result lớn là envelope JSON hợp lệ) thay vì preview 160 chars;
 *     delegation-evaluator tự tier 600/entry, 12k tổng.
 */

import { callLLMForAgent, getZenKeyCount, runWithZenKeyBinding } from '@/lib/llm'
import { executeTool, buildCompactToolSchemasSection, getToolDefinitions } from '@/lib/code-team/tool-executor'
// ROUND-27 FIX V1 — envelope JSON hợp lệ cho tool message của sub-agent (dùng
// chung với goal-loop + workflow-engine; context-compression không import lại
// module này → không circular).
import { truncateToolMessageJson } from '@/lib/context-compression'
import type { LLMTool } from '@/lib/llm'
import { parseToolCallsFromOutput, detectBrokenToolCallHint, tryParseLooseJson } from '@/lib/tool-calls'
import { resolveAgent } from '@/lib/code-team/agent-resolver'
import { isSessionCancelled, registerDelegationRun, endAgentRun } from '@/lib/agent-run-tracker'

// ==================== CONFIG (env override) ====================

/**
 * Parse int từ env — CHẤP NHẬN 0 HỢP LỆ (CI-1 "0 = UNLIMITED": đặt 0 nghĩa
 * là KHÔNG GIỚI HẠN cap tương ứng). Env không set / rỗng / không phải số hữu
 * hạn / âm → fallback. (Fix falsy-bug: bản cũ check `v > 0` nuốt "0".)
 */
function intEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') return fallback
  const v = Number(raw)
  return Number.isFinite(v) && v >= 0 ? Math.floor(v) : fallback
}

/**
 * Số vòng LLM tối đa cho sub-agent (mặc định 5; 0 = ∞ — CI-1).
 * USER DIRECTIVE (2026-10, lần 3): "subagent bị giới hạn 12 chu kỳ không thể
 * triển khai khối công việc lớn — sửa lại thành vô hạn" → cấu hình .env hiện
 * tại = 0 (KHÔNG GIỚI HẠN vòng, mirror GOAL_LOOP_MAX_CYCLES=0 của loop cha).
 */
const SUBAGENT_MAX_ITERATIONS = intEnv('SUBAGENT_MAX_ITERATIONS', 5)
/** Token budget riêng của MỖI lần delegate (mặc định 40k; 0 = ∞ — CI-1) */
const SUBAGENT_TOKEN_BUDGET = intEnv('SUBAGENT_TOKEN_BUDGET', 40_000)
/** Timeout toàn bộ sub-agent run (mặc định 8 phút < time budget loop 30'; 0 = ∞ — CI-1) */
const SUBAGENT_TIMEOUT_MS = intEnv('SUBAGENT_TIMEOUT_MS', 8 * 60_000)
/**
 * FIX 2026-09-11 (review #7 MEDIUM): khi CẢ 3 cap đều = 0 (unlimited) sub-agent
 * không còn phanh nào → parent kẹt vĩnh viễn trong executeTool. Trần cứng dự
 * phòng chỉ kích hoạt khi cả 3 cap đều 0.
 * USER DIRECTIVE (2026-10 — "vô hạn"): trần cứng giờ CẤU HÌNH ĐƯỢC qua env
 * SUBAGENT_HARD_CEILING_ITERATIONS (mặc định 200; 0 = TẮT hẳn — sub-agent chạy
 * VÔ HẠN thật, chỉ dừng bởi conclude (tự nhận hoàn thành) / cancel / error;
 * mỗi call LLM vẫn có per-call timeout 21' — mirror pattern SAFE_CAP_* của
 * goal-loop, nơi user cũng đã đặt 0 = ∞ thật).
 */
const SUBAGENT_HARD_CEILING_ITERATIONS = intEnv('SUBAGENT_HARD_CEILING_ITERATIONS', 200)
const ALL_SUBAGENT_CAPS_UNLIMITED =
  SUBAGENT_MAX_ITERATIONS === 0 && SUBAGENT_TOKEN_BUDGET === 0 && SUBAGENT_TIMEOUT_MS === 0
const SUBAGENT_EFFECTIVE_MAX_ITERATIONS = ALL_SUBAGENT_CAPS_UNLIMITED
  ? SUBAGENT_HARD_CEILING_ITERATIONS
  : SUBAGENT_MAX_ITERATIONS
/** Cap ký tự tool result trong context CỦA SUB-AGENT
 * 2026-09-30 (round-10 audit): 4000 → 8000 + env (SUBAGENT_TOOL_RESULT_CHARS)
 * — sub-agent audit đọc evidence/output dài cần trọn vẹn hơn (cùng root-cause
 * với TOOL_RESULT_MAX_CHARS của goal-loop). */
const SUBAGENT_TOOL_RESULT_CHARS = intEnv('SUBAGENT_TOOL_RESULT_CHARS', 8_000)
/** Cap ký tự báo cáo trả về PARENT
 * 2026-09-30 (round-10 audit): 3500 → 9000 + env (SUBAGENT_REPORT_MAX_CHARS)
 * + cắt ĐẦU+CUỐI (smartTruncate) thay vì head-only — phần cuối báo cáo sub-agent
 * (danh sách artifact path + kết luận verification) là phần parent cần nhất;
 * head-only cắt mất đúng phần đó (mission r10: parent không thấy artifact path
 * → kết luận "không thể xác nhận manifest/probe tồn tại"). */
const REPORT_MAX_CHARS = intEnv('SUBAGENT_REPORT_MAX_CHARS', 9_000)

/** Map tên agent → position trong Code Team (resolveAgent nhận position).
 * TASK 43 — export cho eval/agent-harness (resolve profile theo tên Code Team).
 * TASK 48 — RAVAGE ('SEC') đã GỠ: agent đổi tên "Linh Sickyx" + tách thành
 * standalone ĐỘC LẬP (team=null) → KHÔNG còn là đích delegate_task của Code
 * Team. Gọi nó qua dispatch_agent của Omega (resolve by-name, team-agnostic)
 * hoặc chat trực tiếp Single Agent mode. */
export const POSITION_BY_NAME: Record<string, string> = {
  MEGATRON: 'TL',
  SHOCWAVE: 'G1',
  RAMPAGE: 'G2-A',
  SENTINEL: 'G2-B',
  CATALYST: 'G3',
  // TASK 43 — FORGE: full-stack-developer subagent (builder tổng lực
  // end-to-end UI+API+DB). Vị trí 'FS' ngoài pipeline SOP — chỉ delegate.
  FORGE: 'FS',
}

/**
 * DEPTH GUARD — sub-agent KHÔNG BAO GIỜ có các tool điều phối này (đệ quy
 * vô hạn: agent A delegate B, B delegate C...). escalate_problem được GIỮ —
 * consult Omega là 1 LLM call đơn (không chạy tool, không đệ quy).
 * dispatch_agents_parallel (2026-09-14 fan-out) cũng bị strip — chống
 * fan-out lồng nhau nổ token.
 * request_code_team (2026-09-30) cũng bị strip — sub-agent (vd MEGATRON được
 * delegate) không được huy động workflow team code lồng nhau (workflow
 * trong workflow → depth explosion token/thời gian).
 */
export const DEPTH_GUARD_TOOLS = ['delegate_task', 'dispatch_agent', 'create_agent', 'dispatch_agents_parallel', 'request_code_team']

/**
 * Toolset mặc định khi profile KHÔNG khai báo tools (agent custom cũ trong DB
 * không có field tools) — generalist an toàn + escalate_problem.
 */
export const DEFAULT_SUBAGENT_TOOLS = [
  'file_read', 'file_list', 'grep', 'file_edit', 'file_multi_edit',
  'shell', 'run_tests', 'lint', 'type_check', 'get_diagnostics',
  'tavily', 'serper', 'jina', 'knowledge_search', 'knowledge_graph',
  'todo_write', 'todo_read', 'list_skills', 'read_skill',
  'create_custom_tool', 'list_custom_tools', 'escalate_problem',
]

/** Danh sách agent có thể delegate (cho tool description + validate)
 * TASK 48 — RAVAGE gỡ khỏi danh sách (agent thành "Linh Sickyx" standalone —
 * dùng dispatch_agent của Omega hoặc chat trực tiếp). */
export const DELEGATABLE_AGENTS: Array<{ name: string; role: string; bestFor: string }> = [
  { name: 'MEGATRON', role: 'TL — Nhìn & Điều hướng', bestFor: 'phân tích yêu cầu phức tạp, routing, code UI fast-track, verify kết quả tổng thể' },
  { name: 'SHOCWAVE', role: 'G1 — Thiết kế', bestFor: 'thiết kế kiến trúc, DB schema, API design, component tree' },
  { name: 'RAMPAGE', role: 'G2-A — Code Execution', bestFor: 'implement code TypeScript/React/Next.js, viết API, database operations' },
  { name: 'SENTINEL', role: 'G2-B — Review & Fix', bestFor: 'code review, tìm bug, security check, fix lỗi, iterative refinement' },
  { name: 'CATALYST', role: 'G3 — Tối ưu', bestFor: 'performance optimization, refactor, scalability, best practices' },
  { name: 'FORGE', role: 'FS — Full-Stack Developer', bestFor: 'tính năng full-stack END-TO-END tự chủ theo spec trọn gói: UI + API + DB + tự kiểm định (lint/type_check/run_tests) + preview verify' },
]

/**
 * Chuẩn hoá input (chấp nhận tên 'RAMPAGE'/'bolt' hoặc position 'G2-A')
 * → position để resolveAgent, hoặc null nếu không hợp lệ.
 * TASK 48 — 'SEC' gỡ: Linh Sickyx (đổi tên từ RAVAGE) là agent ĐỘC LẬP —
 * không resolve qua position của Code Team nữa.
 */
export function resolveDelegationTarget(input: unknown): string | null {
  const key = String(input ?? '').trim().toUpperCase()
  if (!key) return null
  if (POSITION_BY_NAME[key]) return POSITION_BY_NAME[key]
  if (['TL', 'G1', 'G2-A', 'G2-B', 'G3', 'FS'].includes(key)) return key
  return null
}

// ==================== TYPES ====================

export interface SubAgentOutcome {
  success: boolean
  agent: string
  position: string
  /** Báo cáo NÉN cho parent — đã làm · bằng chứng · còn thiếu */
  report: string
  tokensUsed: number
  iterations: number
  toolCalls: number
  endedBy: 'concluded' | 'iteration_limit' | 'token_budget' | 'timeout' | 'cancelled' | 'error'
  /** evidence lines — parent có thể nối vào nhật ký bằng chứng của mình */
  evidence: string[]
  error?: string
  /** FIX 2026-09-14 #2 — verdict của TRỌNG TÀI ĐỘC LẬP (delegation-evaluator):
   *  null = đánh giá không chạy được (fail-open) — parent tự cân nhắc như cũ. */
  evaluation?: {
    pass: boolean
    confidence: number
    gaps: string[]
    note: string
  }
  /**
   * IMP-1 (W2 — fail-open transparency): true = trọng tài độc lập KHÔNG chạy
   * được (evaluator lỗi/timeout/JSON hỏng) → kết quả CHƯA được xác nhận độc
   * lập — parent tự verify hoặc giao lại. Thiết kế fail-open GIỮ NGUYÊN
   * (delegation vẫn trả kết quả), chỉ thêm marker minh bạch + ghi chú ⚠
   * trong report để parent không tưởng đã có xác nhận độc lập.
   */
  evaluationMissing?: boolean
}

/** Profile agent chạy như sub-agent — do caller resolve (Code Team hoặc DB) */
export interface SubAgentProfile {
  id?: string
  name: string
  instruction: string
  provider: string
  model: string
  temperature: number
  maxTokens: number
  /** Whitelist tools của sub-agent — rỗng → DEFAULT_SUBAGENT_TOOLS */
  tools: string[]
}

// ==================== HELPERS ====================

/** Timeout wrapper (giúp sub-agent không treo quá SUBAGENT_TIMEOUT_MS) */
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

/** ROUND-27 FIX V1 — CHỈ dùng cho VĂN BẢN THÔ (báo cáo wrap-up trả parent —
 *  line ~949). Tool message JSON PHẢI dùng truncateToolMessageJson của
 *  context-compression: splice marker chứa \n thô ở đây làm VỠ cú pháp JSON
 *  (đúng lớp bug FIX B round-26 đã sửa cho goal-loop nhưng round-26 bỏ sót
 *  đường sub-agent — MEGATRON/sub-agents nhận JSON vỡ với mọi tool result
 *  > SUBAGENT_TOOL_RESULT_CHARS). */
function truncateResult(s: string, maxChars: number): string {
  if (s.length <= maxChars) return s
  const head = Math.floor(maxChars * 0.6)
  const tail = Math.max(200, maxChars - head - 90)
  return s.slice(0, head) + `\n…[truncated ${s.length - head - tail}]…\n` + s.slice(-tail)
}

function compactArgs(args: Record<string, unknown>, maxLen = 100): string {
  try {
    const s = JSON.stringify(args)
    return s.length > maxLen ? s.slice(0, maxLen) + '…' : s
  } catch {
    return '(?)'
  }
}

// ==================== SUB-AGENT SLOT POOL — TỐI ĐA 3, MỖI SLOT 1 KEY (user 2026-10-29b) ====================
// USER DIRECTIVE (bản 2, ghi đè bản 1 "tối đa 1"): "có 3 API key Opencode
// Zen → thiết lập 3 là số subagents tối đa, và nếu gọi subagents thì KHÔNG
// được sử dụng cùng API [key]". Thiết kế:
//   · SUBAGENT_MAX_CONCURRENT slot (mặc định = min(3, số key Zen cấu hình;
//     env SUBAGENT_MAX_CONCURRENT override) — mọi đường delegate đều đi qua
//     đây (delegate_task / dispatch_agent / dispatch_agents_parallel /
//     eval harness...), kể cả 2 goal-loop job song song của worker.
//   · Slot i GHIM key Zen #i (runWithZenKeyBinding — AsyncLocalStorage trong
//     llm.ts): MỌI LLM call của run (ReAct + wrap-up + trọng tài độc lập)
//     dùng đúng key đó → 3 sub-agent song song KHÔNG BAO GIỜ dùng chung key.
//     Caller thường (parent goal-loop / utility) bị getZenKey() tự NÉ key
//     đang ghim (xem llm.ts).
//   · Thời gian chờ hàng đợi KHÔNG đếm vào SUBAGENT_TIMEOUT_MS (acquire trước
//     startedAt — timeout tính từ khi sub-agent THỰC SỰ chạy).
//
// Chống deadlock (giữ nguyên từ bản 1):
//   - Sub-agent KHÔNG có tool điều phối (DEPTH_GUARD) → 1 run giữ tối đa 1
//     slot, không acquire lồng.
//   - escalate_problem auto-apply bị TẮT khi gọi từ sub-agent (tool-executor)
//     → không xảy ra kịch bản 3 sub-agent đồng thời giữ hết 3 slot rồi mỗi
//     cái lại chờ slot thứ 4 qua auto-dispatch.
const SUBAGENT_SLOT_QUEUE_LOG_MS = 1_000
const zenKeyCountForSlots = getZenKeyCount()
const rawSubagentMaxConcurrent = Number(process.env.SUBAGENT_MAX_CONCURRENT)
const SUBAGENT_MAX_CONCURRENT = Number.isFinite(rawSubagentMaxConcurrent) && rawSubagentMaxConcurrent >= 1
  ? Math.floor(rawSubagentMaxConcurrent)
  : Math.min(3, Math.max(1, zenKeyCountForSlots))

interface SubAgentSlot {
  id: number
  /** Index key Zen (0-based) ghim cho slot này; -1 = không ghim (slot thừa hơn số key) */
  keyIndex: number
}
const subAgentSlots: SubAgentSlot[] = Array.from(
  { length: SUBAGENT_MAX_CONCURRENT },
  (_, i) => ({ id: i + 1, keyIndex: i < zenKeyCountForSlots ? i : -1 }),
)
/** Chuỗi hiển thị agent đang giữ từng slot (rỗng = slot tự do) */
const subAgentSlotHolders: string[] = subAgentSlots.map(() => '')
interface SubAgentSlotWaiter {
  holder: string
  startedAt: number
  resolve: (slot: SubAgentSlot) => void
}
const subAgentSlotWaiters: SubAgentSlotWaiter[] = []

function assignSubAgentSlot(idx: number, holder: string): SubAgentSlot {
  subAgentSlotHolders[idx] = holder
  return subAgentSlots[idx]
}

/** Nhận slot: FIFO công bằng — slot tự do chỉ trao thẳng khi KHÔNG có người chờ. */
function acquireSubAgentSlot(profileName: string, parentAgentName: string): Promise<SubAgentSlot> {
  const holder = `${profileName} ← ${parentAgentName}`
  if (subAgentSlotWaiters.length === 0) {
    const freeIdx = subAgentSlotHolders.findIndex(h => h === '')
    if (freeIdx >= 0) return Promise.resolve(assignSubAgentSlot(freeIdx, holder))
  }
  const busy = subAgentSlotHolders.filter(Boolean)
  console.log(`[SubAgentSlot] ${profileName} (từ ${parentAgentName}) xếp hàng — ${busy.length}/${SUBAGENT_MAX_CONCURRENT} slot bận${busy.length > 0 ? `: ${busy.join(' · ')}` : ''}${subAgentSlotWaiters.length > 0 ? ` (+${subAgentSlotWaiters.length} đang chờ trước)` : ''}`)
  return new Promise<SubAgentSlot>(resolve => {
    const startedAt = Date.now()
    subAgentSlotWaiters.push({
      holder,
      startedAt,
      resolve: slot => {
        const waitedMs = Date.now() - startedAt
        if (waitedMs >= SUBAGENT_SLOT_QUEUE_LOG_MS) {
          console.log(`[SubAgentSlot] ${profileName} chờ ${Math.round(waitedMs / 1000)}s → nhận slot ${slot.id}${slot.keyIndex >= 0 ? ` (ghim Zen key #${slot.keyIndex + 1})` : ''}`)
        }
        resolve(slot)
      },
    })
  })
}

/** Nhả slot — trao thẳng cho người chờ đầu hàng (FIFO, không ai nhảy hàng). */
function releaseSubAgentSlot(slot: SubAgentSlot): void {
  const idx = slot.id - 1
  const next = subAgentSlotWaiters.shift()
  if (next) {
    next.resolve(assignSubAgentSlot(idx, next.holder))
  } else {
    subAgentSlotHolders[idx] = ''
  }
}

// ==================== GENERIC SUB-AGENT RUNNER ====================

/**
 * USER DIRECTIVE 2026-10-29b — ĐIỂM ĐI QUA DUY NHẤT cho quy tắc concurrency:
 * "tối đa 3 sub-agent cùng lúc, mỗi sub-agent 1 API key Zen riêng". Wrapper
 * này acquire 1 slot trong pool (FIFO) rồi GHIM key của slot đó vào toàn bộ
 * run qua runWithZenKeyBinding (AsyncLocalStorage — mọi LLM call con: ReAct
 * loop, wrap-up, trọng tài độc lập... tự kế thừa đúng key). Mọi đường gọi
 * (runSubAgent legacy, dispatchAgentByOmega, dispatchAgentsParallel, eval
 * harness...) đều đi qua đây. Fail-safe: throw → finally release slot.
 */
export async function runSubAgentForProfile(params: {
  profile: SubAgentProfile
  task: string
  context?: string
  acceptanceCriteria?: string
  parentRunId?: string | null
  parentAgentName?: string
  sessionId?: string | null
  onTokens?: (tokens: number) => void
}): Promise<SubAgentOutcome> {
  const profileName = params.profile?.name || 'unknown-agent'
  const parentName = params.parentAgentName || 'parent-agent'
  const slot = await acquireSubAgentSlot(profileName, parentName)
  if (slot.keyIndex >= 0) {
    console.log(`[SubAgentSlot] ${profileName} nhận slot ${slot.id}/${SUBAGENT_MAX_CONCURRENT} — ghim Zen key #${slot.keyIndex + 1} riêng cho toàn bộ run (user directive: sub-agent không dùng chung key)`)
  }
  try {
    return slot.keyIndex >= 0
      ? await runWithZenKeyBinding(slot.keyIndex, () => runSubAgentForProfileInner(params))
      : await runSubAgentForProfileInner(params)
  } finally {
    releaseSubAgentSlot(slot)
  }
}

/**
 * Chạy 1 sub-agent THEO PROFILE (generic — Code Team, custom, hoặc agent do
 * Omega tạo). Đây là lõi mini ReAct loop với context isolation + depth guard.
 *
 * DELEGATION CONTRACT (fix 2026-09-12 — gap so với quy trình orchestrator):
 * Trước đây sub-agent nhận việc → chạy thẳng ReAct KHÔNG kế hoạch, todos (nếu
 * có) rơi scope 'default' vô hình, kết quả không lưu lại cho run sau. Giờ:
 *   · PLAN-FIRST — prompt bắt buộc BƯỚC 0: task nhiều bước → todo_write chia
 *     kế hoạch TRƯỚC, làm từng bước, cập nhật trạng thái; harness plan-nudge
 *     (≥3 tool calls chưa có todo → nhắc 1 lần);
 *   · ACCEPTANCE — delegate_task truyền điều kiện hoàn thành kiểm định được,
 *     sub-agent tự verify từng điều kiện trước khi báo cáo;
 *   · SELF-VERIFY — báo cáo bắt buộc kèm bằng chứng tool (đã có từ trước,
 *     giờ đối chiếu cả acceptance);
 *   · VISIBILITY — todos inject sessionId + delegationRunId → panel Thought
 *     Process hiện run riêng của sub-agent (kế hoạch + tool events);
 *   · LEARNING — cuối run lưu task_summary vào Kho Context (context_recall
 *     cho run sau — delegation không còn là "ngõ cụt tri thức").
 *
 * @param params.profile   profile agent đã resolve (provider/model/tools...)
 * @param params.task      mô tả nhiệm vụ delegate (bắt buộc)
 * @param params.context   context bổ sung từ parent (file liên quan, ràng buộc...)
 * @param params.acceptanceCriteria  điều kiện hoàn thành kiểm định được (parent đối chiếu báo cáo theo đây)
 * @param params.parentRunId  runId của parent (goal-loop / pipeline step) — hiển thị nguồn giao việc
 * @param params.onTokens  callback báo token tiêu thụ về PARENT budget
 */
async function runSubAgentForProfileInner(params: {
  profile: SubAgentProfile
  task: string
  context?: string
  acceptanceCriteria?: string
  parentRunId?: string | null
  parentAgentName?: string
  sessionId?: string | null
  onTokens?: (tokens: number) => void
}): Promise<SubAgentOutcome> {
  const {
    profile,
    task,
    context,
    acceptanceCriteria,
    parentRunId = null,
    parentAgentName = 'parent-agent',
    sessionId = null,
    onTokens,
  } = params

  const startedAt = Date.now()
  // ROUND-38 fix Y8 — cờ chống double-record episode (outer-catch ghi bù khi
  // record thường chưa kịp chạy — khai báo NGOÀI try để catch thấy được)
  let episodeRecorded = false
  const evidence: string[] = []
  // IMP-1 (W1) — tool-result transcript ĐẦY ĐỦ (entry JSON {tool, success,
  // result} đã cap SUBAGENT_TOOL_RESULT_CHARS=4000) để trọng tài độc lập ĐỌC
  // ĐƯỢC nội dung result thật khi verify. Khác với `evidence` (preview 160
  // chars — dành cho hiển thị parent + wrap-up prompt gọn).
  const toolResultLog: string[] = []
  // IMP-1 (Task G) — đếm tool call THÀNH CÔNG (phân biệt attempted): cơ sở
  // cho "usable results delivered" trong công thức outcome.success.
  let successfulToolCalls = 0
  // Mutable state object — TS không track được phép gán `let` bên trong closure
  // async (narrowing sai → TS2367), nên đóng gói vào object.
  // FIX (review 2026-09-08): endedBy khởi tạo 'iteration_limit' thay vì 'error'
  // — nếu không, sub-agent chạy hết vòng/budget mà KHÔNG conclude sẽ bị phân
  // loại nhầm là 'error' + success=false (parent tưởng thất bại → làm lại việc
  // đã xong). Nhánh classify ở cuối loop trước đây là dead-code vì init 'error'.
  const state: {
    endedBy: SubAgentOutcome['endedBy']
    errorMessage: string
    lastContent: string
    forceWrapUp: boolean
    wrapUpReason: string
  } = {
    endedBy: 'iteration_limit',
    errorMessage: '',
    lastContent: '',
    forceWrapUp: false,
    wrapUpReason: '',
  }
  // FIX ZOMBIE (review 2026-09-08): timeout trước đây chỉ race — vòng lặp async
  // vẫn chạy tiếp chạy tool thật (file_edit/shell!) sau khi parent đã nhận báo
  // cáo timeout. timedOut được set ngay khi race thua và loop tự dừng ở checkpoint
  // gần nhất (đầu vòng / trước mỗi tool call).
  let timedOut = false
  // ANTI-HALLUCINATION (E2E 2026-09-08): MEGATRON được delegate "đọc 3 file" nhưng
  // conclude ngay vòng 1 với 0 tool call → "phân tích" là bịa (parent may mắn
  // tự đọc lại). Giờ: task yêu cầu bằng chứng thật mà sub-agent chưa chạy tool
  // nào → đẩy 1 directive ép chạy tool, chỉ accept conclude ở vòng sau.
  let nudgedOnce = false
  // 21-d: số lần đẩy feedback parse-fail (tool call bị cắt cụt giữa JSON)
  // — tránh loop vô hạn khi LLM liên tục phát JSON lỗi.
  let parseFailNudges = 0
  // DELEGATION CONTRACT: plan-nudge — sub-agent chạy ≥3 tool calls mà chưa
  // từng todo_write → nhắc 1 lần duy nhất "lập kế hoạch rồi làm từng bước"
  // (mirror kỷ luật TodoWrite của orchestrator — không ép task đơn giản).
  let sawTodoWrite = false
  let planNudged = false
  let tokensUsed = 0
  let iterations = 0
  let toolCallCount = 0
  // USER DIRECTIVE 2026-10-29 — TODO COMPLETION GUARD: sub-agent có kế hoạch
  // todo mà còn mục chưa xong → KHÔNG chấp nhận conclude ngay (trước đây loop
  // conclude ngay khi sub-agent ngừng gọi tool → "agents được gọi không thực
  // hiện hết tác vụ trong Todos của mình"). Snapshot cập nhật từ:
  //   (a) args todo_write đi qua loop (local — hoạt động cả khi DB fail-open)
  //   (b) autoCompleteRunTodosByEvidence trả về (DB — nguồn sự thật)
  const MAX_TODO_COMPLETION_NUDGES = 2
  let todoCompletionNudges = 0
  let lastTodoSnapshot: Array<{ id?: string; content: string; status: string }> = []
  // DELEGATION CONTRACT — khai báo NGOÀI try để catch-path kết thúc được run
  // hiển thị khi exception văng ra giữa chừng (TS scope — mirror jobInputCrashContext pattern)
  let delegationRunId: string | null = null
  let finishDelegationRun: (status: 'done' | 'error' | 'cancelled', summary: string) => void = () => {}

  const addTokens = (t?: number) => {
    if (typeof t === 'number' && t > 0) {
      tokensUsed += t
      onTokens?.(t)
    }
  }

  const isCancelled = () => isSessionCancelled(sessionId)

  try {
    if (!profile.provider || !profile.model) {
      return {
        success: false,
        agent: profile.name,
        position: '-',
        report: '',
        tokensUsed: 0,
        iterations: 0,
        toolCalls: 0,
        endedBy: 'error',
        evidence: [],
        error: `Agent "${profile.name}" thiếu provider/model — không chạy sub-agent được.`,
      }
    }

    // DEPTH GUARD: strip tool điều phối khỏi whitelist sub-agent (chống đệ quy)
    const baseTools = profile.tools.length > 0 ? profile.tools : DEFAULT_SUBAGENT_TOOLS
    // 21-c: áp ToolAssignment overrides (Tools Manager / Omega manage_tools) —
    // disable → loại khỏi whitelist sub-agent; enable-thêm → được dùng. Fail-open.
    let effectiveBaseTools = baseTools
    try {
      const { getEffectiveToolNames } = await import('@/lib/tool-access')
      effectiveBaseTools = await getEffectiveToolNames(profile.name, baseTools)
    } catch { /* fail-open — giữ whitelist mặc định */ }
    const allowedTools = effectiveBaseTools.filter(t => !DEPTH_GUARD_TOOLS.includes(t))

    // DELEGATION CONTRACT — đăng ký run riêng cho sub-agent (Thought Process
    // panel + AgentRunRecord + todos theo runId). Fail-open: null → delegation
    // vẫn chạy, chỉ thiếu hiển thị. KHÔNG đụng flag cancel/activeRun của parent.
    try {
      delegationRunId = registerDelegationRun({
        sessionId,
        parentRunId,
        agentName: profile.name,
        agentPosition: POSITION_BY_NAME[profile.name.toUpperCase()] || undefined,
        task,
      })
    } catch { /* fail-open */ }
    // ROUND-11 (vòng quan sát 9 — FIX subagent vô hình khi bị restart giết):
    // trước đây row AgentRunRecord của delegation CHỈ được ghi lúc kết thúc
    // (persistAgentRunRecord trong endAgentRun) → server restart giữa chừng
    // (bằng chứng: sub_1790767073236_5 bị MemWatchdog restart #93 giết lúc
    // 11:27 — không kịp ghi row, ~phút làm việc mất trắng KHÔNG dấu vết,
    // parent resume không biết delegation từng bay). Giờ insert row 'running'
    // NGAY lúc start (mirror Task 20-c của goal-loop parent) — restart để lại
    // row mồ côi mà boot stale-cleanup (instrumentation Task 54) lật thành
    // failed/crashed → mất mát hiển thị được trong UI/metrics + parent resume
    // dò được (agent-goal-loop resume notice). Fire-and-forget, fail-open.
    if (delegationRunId && sessionId) {
      void (async () => {
        try {
          const { insertAgentRunRecordRunning } = await import('@/lib/metrics-db')
          await insertAgentRunRecordRunning({
            sessionId,
            runId: delegationRunId,
            parentRunId: parentRunId ?? null,
            agentName: profile.name,
            startedAt: new Date(),
          })
        } catch { /* fail-open — hiển thị thôi, không được phép lỗi delegation */ }
      })()
    }
    finishDelegationRun = (status: 'done' | 'error' | 'cancelled', summary: string) => {
      if (!delegationRunId || !sessionId) return
      try { endAgentRun(sessionId, delegationRunId, status, summary) } catch { /* fail-open */ }
    }

    const maxIterDisplay = ALL_SUBAGENT_CAPS_UNLIMITED
      ? (SUBAGENT_HARD_CEILING_ITERATIONS > 0
          ? `${SUBAGENT_HARD_CEILING_ITERATIONS} (trần cứng dự phòng — cả 3 cap = 0)`
          : '∞ (KHÔNG GIỚI HẠN — user directive)')
      : SUBAGENT_MAX_ITERATIONS === 0 ? '∞' : String(SUBAGENT_MAX_ITERATIONS)
    console.log(`[SubAgent] ${parentAgentName} → ${profile.name}: "${task.slice(0, 100)}" (max ${maxIterDisplay} vòng, budget ${SUBAGENT_TOKEN_BUDGET === 0 ? '∞' : SUBAGENT_TOKEN_BUDGET} tokens${SUBAGENT_TIMEOUT_MS === 0 ? ', timeout ∞' : ''}, ${allowedTools.length} tools${delegationRunId ? `, run ${delegationRunId.slice(0, 22)}…` : ''})`)

    // ROUND-50 FIX (P2-γ r49) — TODO SCOPE RIÊNG CHO SUB-AGENT:
    // trước đây todo_write bị ép sessionId = session chat CHA (để hiển thị
    // panel) → /api/todos?sessionId=<chat> trộn todo cha + todo sub-agent
    // (bằng chứng r49: 9 todo Linh + 10 ALISTA = 19 mục trộn lẫn, attribution
    // chỉ phân biệt qua runId). Giờ todo của sub-agent ghi scope
    // `delegation:<runId>` — KHÔNG trộn scope chat cha; panel Thought Process
    // vẫn thấy ĐỦ (API /api/agent-run query theo runId — không phụ thuộc
    // sessionId), còn /api/todos?sessionId=<chat> chỉ còn todo của chính phiên.
    // delegationRunId null (tracker fail-open) → fallback scope cha như cũ.
    const todoScopeSessionId = delegationRunId ? `delegation:${delegationRunId}` : (sessionId || '')

    // Mini ReAct loop
    const baseSystemPrompt = profile.instruction || `Bạn là ${profile.name} — agent chuyên trách. Hoàn thành nhiệm vụ được delegate một cách tự chủ, ngắn gọn.`

    // ━━━ ROUND-37 V3.3 — EPISODIC BRAIN PRE-ACT (sub-agents nối vào bộ não) ━━━
    // Trước đây chỉ goal-loop có PRE-ACT — sub-agent (MEGATRON/SHOCWAVE/...)
    // chạy delegation KHÔNG ký ức: task từng fail theo pattern tương tự không
    // được cảnh báo. Giờ append block bài học + lỗi tương tự vào system prompt
    // (4s timeout, fail-open). appliedLessonIds track để validate sau run.
    let subAgentAppliedLessonIds: string[] = []
    // ROUND-40 fix V3-GAP — exploration lessons track để CONSOLIDATE truyền
    // xuống recorder (run PARTIAL của sub-agent giờ được chấm ±confidence)
    let subAgentExplorationLessonIds: string[] = []
    let systemPrompt = baseSystemPrompt
    try {
      const { buildAgentBrainBlock } = await import('@/lib/episodic-memory/agent-brain')
      const brain = await buildAgentBrainBlock({
        family: 'sub-agent',
        agentName: profile.name,
        task: `${task}${context ? `\nContext: ${context.slice(0, 500)}` : ''}`.slice(0, 1500),
      })
      if (brain.promptBlock) {
        systemPrompt = `${baseSystemPrompt}${brain.promptBlock}`
        subAgentAppliedLessonIds = brain.appliedLessonIds
        subAgentExplorationLessonIds = brain.explorationLessonIds ?? []
        console.log(`[SubAgent] V3.3 — episodic brain PRE-ACT cho ${profile.name}: ${brain.appliedLessonIds.length} lesson applied`)
      }
    } catch { /* fail-open — sub-agent chạy như cũ */ }

    const transcript: Array<{ role: 'user' | 'assistant' | 'tool'; content: string }> = [
      { role: 'user', content: buildDelegationPrompt(profile.name, task, context, allowedTools, parentAgentName, acceptanceCriteria) },
    ]

    // FIX 2026-09-30 (E2E audit — "agents thường lỗi khi được Omega gọi"):
    // delegation prompt trước đây CHỈ liệt kê TÊN tools → LLM đoán mò param
    // (file_read gọi "file_path" thay vì "path" → 'path is required' →
    // sub-agent fail + bịa bằng chứng). Giờ inject SCHEMA COMPACT của từng
    // tool vào ĐẦU transcript (user message riêng, chỉ 1 lần — context của
    // sub-agent vẫn isolated với parent). Fail-open: schema lỗi → prompt cũ.
    let toolSchemaMsg: string | null = null
    // TASK 39 — NATIVE FC schemas: truyền schema ĐẦY ĐỦ của whitelist qua API
    // (body.tools) — sub-agent emit tool_calls chuẩn thay vì text protocol.
    // Fail-open: lỗi build → mảng rỗng (text protocol vẫn hoạt động).
    let nativeToolSchemas: LLMTool[] = []
    try {
      const schemaSection = buildCompactToolSchemasSection(allowedTools)
      if (schemaSection) {
        toolSchemaMsg = `${schemaSection}\n\n(Trên đây là schema ĐẦY ĐỦ của các tool bạn được dùng — tham chiếu mỗi khi gọi tool; KHÔNG đoán tên param. Tools cũng ĐÃ ĐƯỢC TRUYỀN QUA API native function calling — ƯU TIÊN emit tool_calls qua API, chỉ viết text tool_call: khi API không hỗ trợ.)`
        transcript.push({ role: 'user', content: toolSchemaMsg })
      }
      nativeToolSchemas = getToolDefinitions(allowedTools) as LLMTool[]
    } catch (schemaErr) {
      console.warn(`[SubAgent] Tool schema injection fail-open:`, schemaErr instanceof Error ? schemaErr.message : String(schemaErr))
    }

    // USER DIRECTIVE 2026-10-29 — lazy-load bộ CI-2 todo (dev-tools) 1 lần/run:
    // extractTodoEvidence (thu bằng chứng tool thành công) +
    // autoCompleteRunTodosByEvidence (đường sub-agent trước đây KHÔNG có lưới
    // an toàn này — chỉ goal-loop + /api/tools/execute có) + closeRunTodosAtEnd
    // (đóng todo dang dở trung thực khi run kết thúc). Dynamic import chống
    // circular; fail-open → guard vẫn chạy với snapshot local.
    let extractTodoEvidenceFn: ((toolName: string, args: Record<string, unknown>) => string | null) | null = null
    let autoCompleteRunTodosByEvidenceFn: ((p: { sessionId: string; runId: string | null; evidence: string[] }) => Promise<{ completed: number; todos: Array<{ id: string; content: string; status: string }> }>) | null = null
    let closeRunTodosAtEndFn: ((p: { sessionId: string; runId: string | null; goalComplete: boolean; crash?: boolean }) => Promise<{ inProgressClosed: number; pendingCompleted: number; pendingArchived: number }>) | null = null
    try {
      const dt = await import('@/lib/code-team/dev-tools')
      extractTodoEvidenceFn = dt.extractTodoEvidence
      autoCompleteRunTodosByEvidenceFn = dt.autoCompleteRunTodosByEvidence
      closeRunTodosAtEndFn = dt.closeRunTodosAtEnd
    } catch { /* fail-open — todo guard dùng snapshot local */ }

    const loopPromise = (async () => {
      // CI-1 (0 = UNLIMITED): cap = 0 → KHÔNG trần tương ứng (vòng / token /
      // thời gian). Check timeout/token chỉ áp dụng khi cap đó > 0.
      // CI-1 + review #7: dùng effective max — khi cả 3 cap = 0 (unlimited) vẫn có
      // trần cứng 200 vòng chống kẹt parent vĩnh viễn
      while (SUBAGENT_EFFECTIVE_MAX_ITERATIONS === 0 || iterations < SUBAGENT_EFFECTIVE_MAX_ITERATIONS) {
        if (isCancelled()) { state.endedBy = 'cancelled'; return }
        if (timedOut) { return } // zombie guard — parent đã nhận timeout
        if (SUBAGENT_TIMEOUT_MS > 0 && Date.now() - startedAt > SUBAGENT_TIMEOUT_MS - 60_000) {
          state.forceWrapUp = true; state.wrapUpReason = 'gần hết thời gian'; break
        }
        if (SUBAGENT_TOKEN_BUDGET > 0 && tokensUsed >= SUBAGENT_TOKEN_BUDGET) {
          state.forceWrapUp = true; state.wrapUpReason = 'hết token budget của sub-agent'; break
        }

        iterations++
        // USER DIRECTIVE 2026-10-29 — bằng chứng CI-2 của batch này (reset mỗi vòng)
        let batchEvidence: string[] = []
        const formatted = transcript
          .map(m => `\n\n[${m.role === 'user' ? 'USER' : m.role === 'assistant' ? 'ASSISTANT' : 'TOOL RESULT'}]: ${m.content}`)
          .join('')
          .trim()

        let result: Awaited<ReturnType<typeof callLLMForAgent>> | null = null
        try {
          result = await withTimeout(
            callLLMForAgent(formatted, { provider: profile.provider, model: profile.model }, systemPrompt, {
              agentId: profile.id || `subagent:${profile.name}`,
              agentName: `${profile.name} (sub-agent)`,
              temperature: profile.temperature,
              // TASK 39 — bỏ cap 16384: maxTokens <= 0 (-1) = KHÔNG giới hạn
              // (callZenProvider omit max_tokens → model output max 512k);
              // > 0 giữ nguyên giá trị profile (cap không phải target).
              maxTokens: profile.maxTokens,
              // TASK 39 — NATIVE FC: schema tools qua API → model emit tool_calls
              ...(nativeToolSchemas.length > 0 ? { tools: nativeToolSchemas, tool_choice: 'auto' as const } : {}),
              abortCheck: isCancelled,
            }),
            // CI-1: timeout tổng = 0 (unlimited) → per-call timeout standalone
            // 21' (align GOAL_LOOP_LLM_TIMEOUT_MS) thay vì "thời gian còn lại"
            SUBAGENT_TIMEOUT_MS > 0
              ? Math.max(60_000, SUBAGENT_TIMEOUT_MS - (Date.now() - startedAt))
              : 21 * 60_000,
            `SubAgent ${profile.name} LLM`,
          )
        } catch (err) {
          state.errorMessage = err instanceof Error ? err.message : String(err)
          state.endedBy = 'error'
          return
        }

        if (!result || (!result.content && !result.tool_calls?.length)) {
          state.errorMessage = result?.error || 'LLM call failed'
          state.endedBy = 'error'
          return
        }
        addTokens(result.tokensUsed)
        if (timedOut) { return } // LLM về nhưng timeout đã nổ — không chạy tool nữa

        // TASK 39 — NATIVE FC: ưu tiên tool_calls từ API (space-bunny trả chuẩn
        // OpenAI khi body có tools); fallback text protocol như cũ.
        // ROUND-50 FIX (P2-δ r49): args native JSON.parse fail → 2 tầng hồi phục
        // (loose-repair → rawArgs feedback phát lại hoàn chỉnh) — mirror
        // agent-goal-loop. Bằng chứng r49: read_skill args truncated → {}
        // → schema "thiếu slug" mơ hồ → sub-agent không đọc được skill.
        const nativeCalls = (result.tool_calls && result.tool_calls.length > 0
          ? result.tool_calls.map((tc, idx) => {
              let args: Record<string, unknown> = {}
              let rawArgs: string | undefined
              try {
                args = typeof tc.function.arguments === 'string'
                  ? JSON.parse(tc.function.arguments)
                  : (tc.function.arguments as Record<string, unknown>) || {}
              } catch {
                const rawStr = typeof tc.function.arguments === 'string' ? tc.function.arguments : ''
                const loose = tryParseLooseJson(rawStr)
                if (loose) {
                  args = loose
                } else {
                  rawArgs = rawStr
                  console.warn(`[SubAgent] ${profile.name} native tool_call "${tc.function.name}" — args BỊ CẮT CỤT (loose-repair fail) — sẽ phản hồi yêu cầu phát lại hoàn chỉnh raw=${rawStr.slice(0, 120)}`)
                }
              }
              return { id: tc.id || `native_${idx}`, name: tc.function.name, args, ...(rawArgs !== undefined ? { rawArgs } : {}) }
            })
          : []
        ).filter(tc => allowedTools.includes(tc.name))
        const toolCalls = nativeCalls.length > 0 ? nativeCalls : parseToolCallsFromOutput(result.content)
        if (toolCalls.length === 0) {
          // 21-d FIX silent parse-drop: output CÓ dấu hiệu tool call ("tool_call:"
          // hoặc ```json chứa "name") nhưng parse THẤT BẠI (JSON bị cắt cụt giữa
          // chừng do output quá dài/maxTokens) → trước đây bị BỎ QUA IM LẶNG, sub-agent
          // conclude như thường. Giờ: đẩy feedback vào transcript để LLM phát lại
          // GỌN HƠN (chia file thành nhiều lần ghi qua file_write append) — tối đa 2 lần.
          const brokenHint = detectBrokenToolCallHint(result.content)
          if (brokenHint && parseFailNudges < 2 && !timedOut && (SUBAGENT_EFFECTIVE_MAX_ITERATIONS === 0 || iterations < SUBAGENT_EFFECTIVE_MAX_ITERATIONS)) {
            parseFailNudges++
            transcript.push({ role: 'assistant', content: result.content })
            transcript.push({ role: 'tool', content: brokenHint })
            continue
          }
          // ANTI-HALLUCINATION GUARD: task cần bằng chứng (đọc file / review /
          // kiểm tra...) mà sub-agent CHƯA chạy tool nào → không chấp nhận kết
          // luận ngay — ép 1 vòng thu thập bằng chứng thật.
          const taskNeedsEvidence = /đọc|read|review|phân tích|analyz|kiểm tra|verify|lint|test|file|source|code|mã nguồn/i.test(task)
          if (!nudgedOnce && taskNeedsEvidence && evidence.length === 0 && (SUBAGENT_MAX_ITERATIONS === 0 || iterations < SUBAGENT_MAX_ITERATIONS) && !timedOut) {
            nudgedOnce = true
            transcript.push({ role: 'assistant', content: result.content })
            transcript.push({
              role: 'user',
              content: '⚠️ Bạn vừa KẾT LUẬN mà CHƯA chạy tool nào. Nhiệm vụ yêu cầu bằng chứng THẬT (đọc file / chạy lệnh / lint...). Hãy dùng tools (file_read / grep / shell...) để thu thập thông tin chính xác RỒI mới báo cáo — KHÔNG đoán nội dung file/code. Nếu bạn đã có thông tin chính xác từ context parent cung cấp, hãy nêu rõ nguồn trong báo cáo và chạy ít nhất 1 tool xác nhận.',
            })
            continue
          }
          // TODO COMPLETION GUARD (user directive 2026-10-29 — "agents được gọi
          // không thực hiện hết tác vụ trong Todos của mình"): sub-agent ĐÃ có
          // kế hoạch todo mà còn mục CHƯA hoàn thành → KHÔNG chấp nhận kết luận
          // — nudge (tối đa 2 lần) yêu cầu làm nốt hoặc đánh dấu failed kèm lý
          // do thật. Hết lượt nudge → chấp nhận conclude (chống loop vô hạn) —
          // closeRunTodosAtEnd sẽ đóng phần còn lại theo verdict.
          const openTodos = lastTodoSnapshot.filter(t => t.status === 'pending' || t.status === 'in_progress' || t.status === 'blocked')
          if (
            openTodos.length > 0 && sawTodoWrite && todoCompletionNudges < MAX_TODO_COMPLETION_NUDGES &&
            (SUBAGENT_EFFECTIVE_MAX_ITERATIONS === 0 || iterations < SUBAGENT_EFFECTIVE_MAX_ITERATIONS) &&
            !timedOut && !isCancelled()
          ) {
            todoCompletionNudges++
            transcript.push({ role: 'assistant', content: result.content })
            transcript.push({
              role: 'user',
              content: `⚠️ Bạn vừa KẾT LUẬN nhưng kế hoạch todo của bạn còn ${openTodos.length} mục CHƯA hoàn thành:\n${openTodos.map((t, i) => `${i + 1}. [${t.status}] ${t.content}`).join('\n')}\n\nHãy HOÀN THÀNH các mục này bằng tools (làm từng mục, cập nhật trạng thái qua todo_write) — hoặc nếu mục nào THẬT SỰ không làm được, đánh dấu status "failed" kèm lý do cụ thể. KHÔNG được bỏ dở không lý do. (Lần nhắc ${todoCompletionNudges}/${MAX_TODO_COMPLETION_NUDGES} — sau đó hệ thống tự đóng todo theo verdict cuối.)`,
            })
            continue
          }
          state.lastContent = result.content
          state.endedBy = 'concluded'
          return
        }

        transcript.push({ role: 'assistant', content: result.content })

        for (const tc of toolCalls) {
          if (isCancelled() || timedOut) break // zombie guard — dừng tool batch
          // Sub-agent bị giới hạn trong whitelist CỦA NÓ (đã strip depth-guard tools)
          if (!allowedTools.includes(tc.name)) {
            const rejection = JSON.stringify({ tool: tc.name, success: false, result: `Tool "${tc.name}" not available for sub-agent ${profile.name}.` })
            transcript.push({ role: 'tool', content: rejection })
            toolResultLog.push(rejection) // IMP-1 (W1) — trọng tài thấy cả lần bị từ chối
            evidence.push(`${tc.name}: bị từ chối (ngoài whitelist)`)
            continue
          }
          // ROUND-50 FIX (P2-δ r49): args native BỊ CẮT CỤT → KHÔNG thực thi với
          // args rỗng — phản hồi nguyên văn + yêu cầu phát lại hoàn chỉnh
          // (mirror agent-goal-loop; bằng chứng r49: read_skill truncated).
          if (tc.rawArgs !== undefined) {
            const rawFeedback = JSON.stringify({
              tool: tc.name,
              success: false,
              result: `⚠️ Tool call "${tc.name}" bị CẮT CỤT ở tầng hạ tầng (args JSON không hoàn chỉnh — tool KHÔNG được thực thi). Nguyên văn phần args đến được: ${tc.rawArgs.slice(0, 400)} — Hãy phát LẠI tool_call HOÀN CHỈNH cho tool này (rút gọn args nếu cần).`,
            })
            transcript.push({ role: 'tool', content: rawFeedback })
            toolResultLog.push(rawFeedback)
            evidence.push(`${tc.name}: args bị cắt cụt — đã yêu cầu phát lại hoàn chỉnh`)
            continue
          }
          toolCallCount++
          // DELEGATION CONTRACT — todo_write: inject sessionId của parent +
          // runId delegation (mirror agent-goal-loop CI-2): todos của sub-agent
          // gắn đúng phiên chat + run riêng → hiển thị trong panel Thought
          // Process thay vì rơi scope 'default' vô hình.
          //
          // ROUND-11 (vòng quan sát 9 — FIX 'default' hallucination): model
          // hay tự chế {"sessionId": "default", "agentRole": "TL"} (bằng chứng
          // probe round-11) → chính sách cũ "tôn trọng sessionId khác" tôn
          // trọng ảo giác → todo rơi bucket "default" mất dấu. Sub-agent loop
          // LÀ chủ sở hữu scope → LUÔN ép sessionId/runId/agentRole đúng
          // (khai báo trùng = no-op).
          const toolArgs: Record<string, unknown> = { ...tc.args }
          if (tc.name === 'todo_write') {
            sawTodoWrite = true
            // ROUND-50 (P2-γ r49): ép scope `delegation:<runId>` (không còn
            // session chat cha — xem comment khai báo todoScopeSessionId).
            if (todoScopeSessionId) {
              if (toolArgs.sessionId !== todoScopeSessionId) {
                if (toolArgs.sessionId) {
                  console.log(`[SubAgent] ${profile.name} todo_write: sessionId khai báo "${String(toolArgs.sessionId).slice(0, 60)}" ≠ scope delegation → ép lại (chống todo rơi scope sai)`)
                }
                toolArgs.sessionId = todoScopeSessionId
              }
              if (delegationRunId && toolArgs.runId !== delegationRunId) toolArgs.runId = delegationRunId
              if (toolArgs.agentRole !== profile.name) toolArgs.agentRole = profile.name
            }
            // USER DIRECTIVE 2026-10-29 — snapshot MERGE (không thay thế): lần
            // update todo_write thường chỉ chứa MỤC THAY ĐỔI → thay thế cả snapshot
            // sẽ mất các mục còn lại. Merge theo (id || content): item đến thay
            // item trùng, item mới thêm vào, item vắng vẫn giữ trạng thái cũ.
            if (Array.isArray(toolArgs.todos)) {
              const incoming = (toolArgs.todos as Array<Record<string, unknown>>)
                .map(t => ({
                  id: typeof t?.id === 'string' ? t.id : undefined,
                  content: String(t?.content ?? ''),
                  status: String(t?.status ?? 'pending'),
                }))
                .filter(t => t.content)
              lastTodoSnapshot = [
                ...lastTodoSnapshot.filter(prev => !incoming.some(t => (t.id && t.id === prev.id) || t.content === prev.content)),
                ...incoming,
              ]
            }
          }
          let toolResult: { success: boolean; result: unknown }
          try {
            toolResult = await executeTool(tc.name, toolArgs, { agentName: profile.name, sessionId, delegationRunId })
          } catch (err) {
            toolResult = { success: false, result: { error: err instanceof Error ? err.message : String(err) } }
          }
          // TOKEN ACCOUNTING (fix review 2026-09-08): escalate_problem/
          // dispatch_agent (consult Omega) tiêu tokens — cộng vào budget của
          // sub-agent và báo lên parent, không để lọt ngoài kế toán.
          const resObj = toolResult.result as { tokensUsed?: number } | null | undefined
          if (resObj && typeof resObj === 'object' && typeof resObj.tokensUsed === 'number' && resObj.tokensUsed > 0) {
            addTokens(resObj.tokensUsed)
          }
          // USER DIRECTIVE 2026-10-29 — thu bằng chứng CI-2 từ tool THÀNH CÔNG
          // (mirror processToolResult của goal-loop)
          if (toolResult.success && extractTodoEvidenceFn) {
            const ev = extractTodoEvidenceFn(tc.name, toolArgs)
            if (ev) batchEvidence.push(ev)
          }
          let preview = ''
          try {
            const r = toolResult.result
            preview = typeof r === 'object' && r !== null
              ? JSON.stringify(r).slice(0, 160)
              : String(r ?? '').slice(0, 160)
          } catch { preview = '(?)' }
          evidence.push(`${tc.name}(${compactArgs(tc.args)}) → ${toolResult.success ? '✓' : '✗'} ${preview}`)
          if (toolResult.success) successfulToolCalls++
          // IMP-1 (W1): entry transcript (cap SUBAGENT_TOOL_RESULT_CHARS) vào
          // log riêng cho trọng tài độc lập — cùng chuỗi với transcript của sub-agent.
          // ROUND-27 FIX V1 — trước đây truncateResult SPLICE marker "\n…[truncated
          // N]…\n" thẳng vào giữa chuỗi JSON → mọi tool result > cap (file_read file
          // lớn, shell output dài, run_tests...) đẩy về sub-agent LÀ JSON VỠ —
          // sub-agent không parse được cấu trúc; toolResultLog (trọng tài delegation
          // đọc) cũng vỡ theo. Giờ dùng CHUNG envelope JSON hợp lệ của round-26
          // {tool, success, result:{_truncated, _originalChars, _note, head, tail}}
          // — sub-agent + trọng tài luôn nhận JSON parse được, head/tail là string
          // field escape chuẩn (kết quả < cap giữ NGUYÊN VĂN — guard trong hàm).
          const toolEntry = truncateToolMessageJson(
            { tool: tc.name, success: toolResult.success, result: toolResult.result },
            safeStringify({ tool: tc.name, success: toolResult.success, result: toolResult.result }),
            SUBAGENT_TOOL_RESULT_CHARS,
          )
          toolResultLog.push(toolEntry)
          transcript.push({ role: 'tool', content: toolEntry })
        }

        // USER DIRECTIVE 2026-10-29 — CI-2 CHO ĐƯỜNG SUB-AGENT (parity goal-loop
        // + /api/tools/execute): todo của run delegation khớp bằng chứng tool
        // THÀNH CÔNG trong batch → tự đánh completed (LLM hay quên todo_write
        // lần cuối). Snapshot DB trả về là NGUỒN SỰ THẬT cho completion guard.
        if (sessionId && delegationRunId && batchEvidence.length > 0 && autoCompleteRunTodosByEvidenceFn) {
          try {
            // ROUND-50 (P2-γ): query theo scope delegation (đồng bộ với scope
            // ghi ở todo_write phía trên — cùng cặp sessionId+runId mới thấy).
            const res = await autoCompleteRunTodosByEvidenceFn({ sessionId: todoScopeSessionId, runId: delegationRunId, evidence: batchEvidence })
            if (res.todos.length > 0) {
              lastTodoSnapshot = res.todos.map(t => ({ id: t.id, content: t.content, status: t.status }))
            }
          } catch { /* fail-open — không được phép làm hỏng delegation */ }
        }

        // DELEGATION CONTRACT — plan-nudge (1 lần): ≥3 tool calls mà chưa từng
        // todo_write → nhắc lập kế hoạch rồi làm từng bước. Task đơn giản
        // (1-2 calls) không bị làm phiền. Nudge là user-message trong transcript
        // của sub-agent — parent context KHÔNG phình (isolation giữ nguyên).
        if (
          !planNudged && !sawTodoWrite && toolCallCount >= 3 && allowedTools.includes('todo_write') &&
          !timedOut && !isCancelled() &&
          (SUBAGENT_EFFECTIVE_MAX_ITERATIONS === 0 || iterations < SUBAGENT_EFFECTIVE_MAX_ITERATIONS)
        ) {
          planNudged = true
          transcript.push({
            role: 'user',
            content: `📌 Bạn đã chạy ${toolCallCount} tool calls mà chưa có kế hoạch. Nếu nhiệm vụ còn nhiều bước: gọi todo_write ngay chia việc còn lại thành các bước có thứ tự (mỗi bước 1 mục) rồi làm theo từng bước, cập nhật trạng thái qua todo_write. Báo cáo cuối phải nêu tiến độ từng bước. Nếu chỉ còn ≤1 bước nữa là xong thì cứ làm tiếp, không cần kế hoạch.`,
          })
        }
      }

      // Phân loại kết thúc khi loop thoát KHÔNG qua concluded/cancelled/error/
      // timeout — trước đây dead-code vì endedBy khởi tạo 'error' (fix ở trên).
      if (state.endedBy !== 'concluded' && state.endedBy !== 'cancelled' && state.endedBy !== 'error' && state.endedBy !== 'timeout') {
        state.forceWrapUp = true
        if (!state.wrapUpReason) state.wrapUpReason = `hết ${SUBAGENT_EFFECTIVE_MAX_ITERATIONS === 0 ? '∞' : SUBAGENT_EFFECTIVE_MAX_ITERATIONS} vòng${ALL_SUBAGENT_CAPS_UNLIMITED && SUBAGENT_HARD_CEILING_ITERATIONS > 0 ? ' (trần cứng dự phòng — cả 3 cap = 0)' : ''}`
        state.endedBy = state.wrapUpReason.includes('token')
          ? 'token_budget'
          : state.wrapUpReason.includes('thời gian') ? 'timeout' : 'iteration_limit'
      }
    })()

    if (SUBAGENT_TIMEOUT_MS > 0) {
      await withTimeout(loopPromise, SUBAGENT_TIMEOUT_MS, `SubAgent ${profile.name} loop`)
        .catch(err => {
          timedOut = true // loop vẫn chạy nền — sẽ tự dừng ở checkpoint gần nhất
          if (state.endedBy === 'error' && !state.errorMessage) state.errorMessage = err instanceof Error ? err.message : String(err)
          state.endedBy = state.endedBy === 'concluded' ? state.endedBy : 'timeout'
        })
    } else {
      // CI-1 (0 = UNLIMITED): không trần thời gian — đợi loop tự kết thúc
      // (concluded / error / cancelled, hoặc brake token/iteration nếu cap đó > 0)
      await loopPromise
    }

    if (isCancelled()) state.endedBy = 'cancelled'
    // Zombie guard: nếu loop nền vẫn kịp conclude SAU timeout (race hiếm),
    // state.endedBy đã được loop ghi đè — tôn trọng kết luận đó nếu có report.

    // ===== Báo cáo NÉN trả về parent =====
    let report = state.lastContent
    const needWrapUp = state.forceWrapUp || state.endedBy === 'iteration_limit' || state.endedBy === 'token_budget' || state.endedBy === 'timeout' || (state.endedBy === 'error' && (state.lastContent || evidence.length > 0))

    // CI-1: token budget = 0 (unlimited) → luôn cho wrap-up (không so với 0 + 5k)
    if (needWrapUp && !isCancelled() && !timedOut && (SUBAGENT_TOKEN_BUDGET === 0 || tokensUsed < SUBAGENT_TOKEN_BUDGET + 5_000)) {
      // 1 call ép tổng kết ngắn — parent nhận báo cáo cô đọng thay vì
      // lastContent dài (đây là chìa khóa context isolation).
      try {
        const wrap = await withTimeout(
          callLLMForAgent(
            buildWrapUpPrompt(task, state.lastContent, evidence, state.wrapUpReason || state.endedBy),
            { provider: profile.provider, model: profile.model },
            `Bạn là ${profile.name}. Viết báo cáo tổng kết NGẮN GỌN theo đúng format yêu cầu.`,
            {
              agentId: profile.id || `subagent:${profile.name}`,
              agentName: `${profile.name} (sub-agent wrap-up)`,
              temperature: 0.3,
              maxTokens: 900,
              abortCheck: isCancelled,
            },
          ),
          120_000,
          `SubAgent ${profile.name} wrap-up`,
        )
        if (wrap?.content) {
          addTokens(wrap.tokensUsed)
          report = wrap.content
        }
      } catch { /* fail-open: dùng lastContent / evidence */ }
    }

    if (!report) {
      // Fallback cuối: dựng báo cáo deterministic từ evidence
      report = [
        `**${profile.name} — kết quả delegate**`,
        state.endedBy === 'error' ? `Lỗi: ${state.errorMessage}` : `Kết thúc: ${state.endedBy}`,
        evidence.length > 0 ? `**Tool đã chạy:**\n${evidence.slice(-15).map(e => `- ${e}`).join('\n')}` : '(không có tool call nào)',
      ].join('\n\n')
    }

    // ANTI-HALLUCINATION DISCLAIMER: sub-agent kết thúc mà KHÔNG chạy tool nào
    // → nội dung là từ kiến thức model, KHÔNG phải bằng chứng đọc thật. Parent
    // cần biết điều này để tự verify (E2E 2026-09-08: MEGATRON "phân tích" 3 file
    // mà 0 tool call — may Omega tự đọc lại).
    if (toolCallCount === 0 && !report.startsWith('⚠️')) {
      report = `⚠️ (LƯU Ý: sub-agent ${profile.name} KHÔNG chạy tool nào — nội dung dưới đây từ kiến thức model, chưa có bằng chứng đọc file/lệnh thật. Nếu cần chính xác, hãy tự file_read/grep verify hoặc delegate lại với yêu cầu rõ ràng dùng tool.)\n\n${report}`
    }

    if (report.length > REPORT_MAX_CHARS) {
      // 2026-09-30: head-only → truncateResult (giữ đầu 60% + cuối) — kết luận
      // + artifact path của sub-agent nằm CUỐI báo cáo, không được cắt mất.
      report = truncateResult(report, REPORT_MAX_CHARS) + '\n…(báo cáo sub-agent đã nén — hỏi lại sub-agent nếu cần chi tiết)'
    }

    // IMP-1 (Task G — decouple success khỏi evaluation.pass): success =
    // "usable results DELIVERED to parent" (delivery semantics):
    //   · concluded       → có kết luận (report + evidence) = true
    //   · iteration_limit → PARTIAL WORK IS DELIVERED (report wrap-up +
    //     evidence tool kèm theo) = true — evaluation.pass=false + gaps chỉ
    //     thị phần chưa xong để parent RE-DELEGATE remainder (không còn bị
    //     ép false như bản cũ :918-921 — chính là vòng lặp reinforcement
    //     chống-delegate mà Task G phát hiện).
    //   · timeout/token_budget/error/cancelled → false (run không trọn vẹn —
    //     parent nhận report/evidence + hint giao lại kèm gaps).
    // Chất lượng kết quả nằm ở outcome.evaluation (pass/gaps) — tách bạch.
    const deliveredUsableResults = successfulToolCalls > 0 || report.trim().length > 0
    const outcome: SubAgentOutcome = {
      success: (state.endedBy === 'concluded' || state.endedBy === 'iteration_limit') && deliveredUsableResults,
      agent: profile.name,
      position: '-',
      report,
      tokensUsed,
      iterations,
      toolCalls: toolCallCount,
      endedBy: state.endedBy,
      evidence,
      error: state.endedBy === 'error' ? state.errorMessage : undefined,
    }

    // (DELEGATION CONTRACT (a)+(b) — ĐÃ DỜI XUỐNG SAU trọng tài + closeRunTodos:
    // ROUND-53 FIX D2 — xem block mới trước dòng '[SubAgent] … xong:' cuối hàm)

    // ===== FIX 2026-09-14 #2 — TRỌNG TÀI ĐỘC LẬP CHO DELEGATION =====
    // Sub-agent vừa TỰ verify theo prompt (học sinh tự chấm bài mình) — giờ
    // 1 LLM call với persona trọng tài riêng soi task + acceptance criteria +
    // report + evidence THẬT → verdict gắn vào outcome.evaluation. Parent
    // nhận KẾT QUẢ CHẤM ĐỘC LẬP trong tool result (không phải chỉ lời tự chấm).
    // Fail-open: evaluator lỗi → evaluation undefined → hành vi cũ. Bỏ qua
    // khi cancelled (user chủ động dừng — không tốn thêm 1 call).
    if (state.endedBy !== 'cancelled' && task.trim()) {
      let evaluation: import('@/lib/delegation-evaluator').DelegationEvaluation | null = null
      try {
        const { evaluateDelegationOutcome } = await import('@/lib/delegation-evaluator')
        evaluation = await evaluateDelegationOutcome({
          agentName: profile.name,
          agentId: profile.id,
          task,
          acceptanceCriteria,
          report,
          // IMP-1 (W1): evidence cho trọng tài là TOOL-RESULT TRANSCRIPT đầy đủ
          // (entry cap 4000 chars) — KHÔNG còn preview 160 chars; evaluator
          // tự tier ~600 chars/entry, ~12k chars tổng khi dựng prompt.
          evidence: toolResultLog,
          endedBy: state.endedBy,
          provider: profile.provider,
          model: profile.model,
          abortCheck: isCancelled,
          onTokens: addTokens,
        })
      } catch { /* fail-open — evaluator không được phá delegation */ }
      if (evaluation) {
        outcome.evaluation = evaluation
        console.log(`[SubAgent] ${profile.name} trọng tài độc lập: ${evaluation.pass ? 'ĐẠT' : 'CHƯA ĐẠT'} (tin cậy ${Math.round(evaluation.confidence * 100)}%)${evaluation.gaps.length > 0 ? ` — thiếu: ${evaluation.gaps[0].slice(0, 80)}` : ''}`)
        // IMP-1 (Task G): KHÔNG còn hạ outcome.success theo evaluation.pass —
        // success = delivery ("kết quả dùng được đã trả về"), evaluation =
        // verdict CHẤT LƯỢNG. Parent đọc evaluation.pass/gaps để quyết giao
        // lại phần còn thiếu. Chỉ nhấn mạnh verdict CHƯA ĐẠT trong report để
        // parent (LLM) không bỏ qua khi phần việc chỉ làm dở.
        if (!evaluation.pass) {
          outcome.report += `\n\n⚠ Trọng tài độc lập: CHƯA ĐẠT — ${(evaluation.gaps.join('; ') || evaluation.note).slice(0, 300)} — hãy giao lại phần còn thiếu (re-delegate kèm gaps cụ thể) hoặc đổi agent phù hợp hơn.`
        }
      } else {
        // IMP-1 (W2 — fail-open transparency): evaluator KHÔNG chạy được
        // (lỗi/timeout/JSON hỏng) → đánh dấu minh bạch. Thiết kế fail-open
        // GIỮ NGUYÊN (delegation vẫn trả kết quả) — parent biết kết quả
        // CHƯA được trọng tài xác nhận để tự cân nhắc/verify thêm.
        outcome.evaluationMissing = true
        outcome.report += '\n\n⚠ Chưa có đánh giá độc lập (evaluator lỗi/timeout) — kết quả CHƯA được trọng tài xác nhận.'
        console.log(`[SubAgent] ${profile.name} trọng tài độc lập KHÔNG chạy được (evaluationMissing=true — kết quả chưa được xác nhận)`)
      }
    }

    // USER DIRECTIVE 2026-10-29 (re-audit fix: DỜI SAU trọng tài) — đóng todo
    // dang dở TRUNG THỰC khi run sub-agent kết thúc (parity goal-loop finalize
    // / chat-route crash-path — trước đây đường delegation KHÔNG gọi
    // closeRunTodosAtEnd → todo sub-agent nằm pending/in_progress vĩnh viễn
    // trong DB). PHẢI chạy SAU evaluator: goalComplete lấy verdict CHẤT LƯỢNG
    // của trọng tài (evaluation.pass) khi có — IMP-1 đã tách outcome.success
    // (delivery) khỏi chất lượng, nên run iteration_limit delivery-success=true
    // nhưng CHƯA ĐẠT vẫn đóng todo "chưa đạt" trung thực; evaluation missing
    // (fail-open) → fallback delivery semantics như cũ.
    // in_progress/blocked → completed|failed theo verdict CHỐT, pending →
    // completed (đạt) | archivedAt (chưa đạt). Fail-open.
    if (sessionId && delegationRunId && closeRunTodosAtEndFn) {
      try {
        const closed = await closeRunTodosAtEndFn({
          // ROUND-50 (P2-γ): đóng todo theo scope delegation (đồng bộ scope ghi)
          sessionId: todoScopeSessionId,
          runId: delegationRunId,
          goalComplete: outcome.evaluation ? outcome.evaluation.pass : outcome.success,
          crash: state.endedBy === 'error',
        })
        const closedTotal = closed.inProgressClosed + closed.pendingCompleted + closed.pendingArchived
        if (closedTotal > 0) {
          const todoVerdict = outcome.evaluation ? outcome.evaluation.pass : outcome.success
          console.log(`[SubAgent] ${profile.name} đóng ${closedTotal} todo dang dở (verdict ${todoVerdict ? 'đạt' : 'chưa đạt'}: ${closed.inProgressClosed} in_progress/blocked, ${closed.pendingCompleted} pending→completed, ${closed.pendingArchived} pending→archived)`)
        }
      } catch { /* fail-open — không được phép làm hỏng delegation */ }
    }

    // DELEGATION CONTRACT (a)+(b) — ROUND-53 FIX D2: chạy SAU trọng tài +
    // closeRunTodos (trước đây chạy TRƯỚC arbiter → AgentRunRecord +
    // task_summary KHÔNG phản ánh verdict — bằng chứng r53: sub-run ghi
    // 'done/complete' trong khi trọng tài chấm CHƯA ĐẠT 5% — kênh quan sát
    // DB đọc sai trạng thái). Summary giờ kèm verdict; task_summary archive
    // theo outcome.report (đã gồm phần ⚠ Trọng tài độc lập).
    finishDelegationRun(
      state.endedBy === 'cancelled' ? 'cancelled' : state.endedBy === 'error' ? 'error' : 'done',
      `[Delegation] ${state.endedBy} · ${iterations} vòng · ${toolCallCount} tool calls · ${tokensUsed} tokens${outcome.evaluation ? ` · trọng tài ${outcome.evaluation.pass ? 'ĐẠT' : 'CHƯA ĐẠT'} (${Math.round(outcome.evaluation.confidence * 100)}%)` : ' · trọng tài chưa chấm'}`,
    )
    if (sessionId && outcome.report.trim()) {
      try {
        void import('@/lib/context-store')
          .then(({ archiveContext }) => archiveContext({
            runId: delegationRunId,
            sessionId,
            agentName: profile.name,
            kind: 'task_summary',
            content: `[Delegation từ ${parentAgentName}] Nhiệm vụ: ${task.slice(0, 400)}\n\n${outcome.report}`,
            tags: 'delegation',
          }))
          .catch(() => { /* fail-open — learning không được phá delegation */ })
      } catch { /* fail-open */ }
    }

    console.log(`[SubAgent] ${profile.name} xong: ${state.endedBy} — ${iterations} vòng, ${toolCallCount} tool calls, ${tokensUsed} tokens, ${Math.round((Date.now() - startedAt) / 1000)}s`)

    // ━━━ ROUND-37 V3.3 — EPISODIC CONSOLIDATE: lỗi delegation thành bài học ━━━
    // Trước đây sub-agent fail KHÔNG bao giờ trở thành ErrorOccurrence/Lesson.
    // Giờ record episode: toolResultLog (JSON {tool, success, result}) làm
    // evidence, endedBy map outcome, appliedLessonIds từ PRE-ACT validate.
    // Fire-and-forget fail-open — KHÔNG đụng delegation result.
    try {
      const { recordAgentEpisode, mapRunOutcome, parseToolResultLogEntry } = await import('@/lib/episodic-memory/agent-brain')
      // Parse toolResultLog entries (JSON string {tool, success, result}) —
      // ROUND-38 fix B2: parseToolResultLogEntry (agent-brain dùng chung):
      // object → JSON.stringify thay '[object Object]', string giữ nguyên.
      const evidence = toolResultLog
        .map(parseToolResultLogEntry)
        .filter((e): e is { tool: string; success: boolean; text: string } => e !== null)
      const toolFailures = evidence.filter(e => !e.success).length
      // endedBy: 'concluded' | 'timeout' | 'token_budget' | 'error' | 'cancelled' | 'iteration_limit'
      const outcomeForBrain = state.endedBy === 'cancelled'
        ? 'ABANDONED' as const
        : state.endedBy === 'error'
          ? 'FAILURE' as const
          : mapRunOutcome({
              status: state.endedBy === 'concluded' ? 'done' : 'iteration_limit',
              toolFailures,
            })
      recordAgentEpisode({
        family: 'sub-agent',
        agentName: profile.name,
        goal: task.slice(0, 500),
        sessionId,
        // ROUND-38 fix Y3 — startedAt thật của delegation (startedAt có sẵn
        // từ đầu hàm — trước đây duration ảo 60s)
        startedAt: new Date(startedAt),
        outcome: outcomeForBrain,
        stopReason: state.endedBy,
        cycles: iterations,
        tokensUsed,
        appliedLessonIds: subAgentAppliedLessonIds,
        explorationLessonIds: subAgentExplorationLessonIds,
        toolEvidence: evidence,
      })
      episodeRecorded = true
    } catch { /* fail-open — không được phép làm hỏng delegation */ }

    return outcome
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err)
    console.warn(`[SubAgent] Delegate "${profile.name}" failed:`, errorMessage)
    try { finishDelegationRun('error', `[Delegation] lỗi: ${errorMessage.slice(0, 200)}`) } catch { /* fail-open */ }
    // ━━ ROUND-38 fix Y8 — outer-catch (exception giữa delegation) trước đây
    // KHÔNG ghi episode (record site nằm trong try) → lỗi chết nhất của sub-agent
    // (exception xuyên thấu) lại là lỗi KHÔNG bao giờ thành bài học. Ghi minimal
    // FAILURE episode, guard chống double-record khi record thường đã chạy.
    if (!episodeRecorded) {
      try {
        const { recordAgentEpisode } = await import('@/lib/episodic-memory/agent-brain')
        recordAgentEpisode({
          family: 'sub-agent',
          agentName: profile.name,
          goal: task.slice(0, 500),
          sessionId,
          startedAt: new Date(startedAt),
          outcome: 'FAILURE',
          stopReason: 'error',
          cycles: iterations,
          tokensUsed,
          toolEvidence: [{ tool: 'delegation', success: false, text: `Exception xuyên thấu delegation: ${errorMessage.slice(0, 400)}` }],
        })
      } catch { /* fail-open */ }
    }
    return {
      success: false,
      agent: profile.name,
      position: '-',
      report: '',
      tokensUsed,
      iterations,
      toolCalls: toolCallCount,
      endedBy: 'error',
      evidence,
      error: errorMessage,
    }
  }
}

// ==================== CODE TEAM ENTRY (legacy — delegate_task) ====================

/**
 * Chạy 1 sub-agent CODE TEAM (MEGATRON/SHOCWAVE/RAMPAGE/SENTINEL/CATALYST) cho task
 * được delegate — giữ tương thích ngược với delegate_task.
 */
export async function runSubAgent(params: {
  position: string
  task: string
  context?: string
  acceptanceCriteria?: string
  parentRunId?: string | null
  parentAgentName?: string
  sessionId?: string | null
  onTokens?: (tokens: number) => void
}): Promise<SubAgentOutcome> {
  const { position, task, context, acceptanceCriteria, parentRunId = null, parentAgentName = 'parent-agent', sessionId = null, onTokens } = params

  // ===== 1. Resolve agent (DB-first → hardcoded) =====
  // strictEnabled: agent bị user DISABLE → từ chối (không chạy fallback ngầm)
  const agent = await resolveAgent(position, { strictEnabled: true })
  if (agent.source === 'missing' || !agent.provider || !agent.model) {
    return {
      success: false,
      agent: `Unknown-${position}`,
      position,
      report: '',
      tokensUsed: 0,
      iterations: 0,
      toolCalls: 0,
      endedBy: 'error',
      evidence: [],
      error: agent.note || `Agent position "${position}" không resolve được (missing) — kiểm tra Agents module.`,
    }
  }

  // ===== 2. Chạy generic runner =====
  const outcome = await runSubAgentForProfile({
    profile: {
      id: agent.id,
      name: agent.name,
      instruction: agent.instruction,
      provider: agent.provider,
      model: agent.model,
      temperature: agent.temperature,
      maxTokens: agent.maxTokens,
      tools: agent.tools,
    },
    task,
    context,
    acceptanceCriteria,
    parentRunId,
    parentAgentName,
    sessionId,
    onTokens,
  })
  // Giữ position trong outcome cho delegate_task legacy (UI/logs dùng)
  return { ...outcome, position }
}

// ==================== PROMPTS ====================

function buildDelegationPrompt(
  agentName: string,
  task: string,
  context: string | undefined,
  allowedTools: string[],
  parentAgentName: string,
  acceptanceCriteria?: string,
): string {
  const canEscalate = allowedTools.includes('escalate_problem')
  const canTodo = allowedTools.includes('todo_write')
  return `Bạn (${agentName}) được ${parentAgentName} DELEGATE một nhiệm vụ tự chủ. Làm việc ĐỘC LẬP — không hỏi lại parent.

NHIỆM VỤ:
${task}
${context ? `\nCONTEXT TỪ PARENT:\n${context.slice(0, 3000)}\n` : ''}
${acceptanceCriteria ? `ĐIỀU KIỆN HOÀN THÀNH (parent đối chiếu báo cáo của bạn theo danh sách này — từng điều kiện phải nêu ĐẠT/CHƯA ĐẠT kèm bằng chứng):
${acceptanceCriteria.slice(0, 1200)}
` : ''}
TOOLS BẠN ĐƯỢC DÙNG: ${allowedTools.join(', ') || '(none — trả lời bằng kiến thức)'} (SCHEMA ĐẦY ĐỦ từng tool — tên param bắt buộc — ở message kế tiếp: ĐỌC kỹ trước khi gọi, KHÔNG đoán tên param)
${allowedTools.includes('list_skills') ? `- 56+ SKILLS HƯỚNG DẪN có sẵn trên hệ thống (fullstack-dev build app, ppt/pptx slide, xlsx bảng tính, docx/pdf tài liệu, charts, interview-prep, knowledge-search...): nhiệm vụ khớp skill nào → gọi list_skills({}) tìm đúng tên rồi read_skill({"slug":"..."}) đọc hướng dẫn TRƯỚC KHI làm.
` : ''}

QUY TRÌNH LÀM VIỆC (bắt buộc):
${canTodo ? `- BƯỚC 0 — LẬP KẾ HOẠCH: đánh giá nhiệm vụ. Nếu cần NHIỀU BƯỚC (đọc/sửa nhiều file, research rồi code, cài đặt rồi kiểm định...) → gọi todo_write NGAY ĐẦU TIÊN, chia nhiệm vụ thành các bước có thứ tự (mỗi bước 1 mục, mô tả đo đếm được) → làm TỪNG BƯỚC, cập nhật trạng thái qua todo_write (pending → in_progress → completed/failed). Nhiệm vụ đơn giản (1-2 tool call) → làm thẳng, không cần todo.
` : ''}- Dùng tools thật để đọc/sửa/chạy — không đoán kết quả file/lệnh.
- TỰ KIỂM ĐỊNH trước khi kết luận: chạy ít nhất 1 tool xác nhận kết quả cuối (file_read đọc lại / lint / type_check / run_tests...) — KHÔNG kết luận "hoàn thành" suông không bằng chứng.${acceptanceCriteria ? ' Đối chiếu TỪNG điều kiện hoàn thành phía trên — điều kiện nào chưa đạt phải nói rõ.' : ''}
- Mỗi vòng tối đa vài tool calls; ưu tiên hành động trực tiếp.
- ⛔ PHẠM VI (ROUND-53 — bằng chứng r53: sub-agent chẩn đoán tự mở rộng làm thay toàn bộ nhiệm vụ gốc của run cha, đốt 950k tokens rồi trọng tài chấm CHƯA ĐẠT): CHỈ làm đúng NHIỆM VỤ được delegate phía trên. Có kết luận đúng phạm vi là BÁO CÁO + DỪNG — nhiệm vụ lớn hơn là việc của parent sau khi đọc báo cáo của bạn. KHÔNG tự mở rộng phạm vi.
${canEscalate ? '- Nếu BẾ TẮC (tool fail lặp lại / không rõ hướng giải): tool_call: escalate_problem({"problem": "...", "context": "...", "attempted": "..."}) → Omega orchestrator sẽ tư vấn giải pháp.' : ''}
- Khi xong (hoặc không làm tiếp được), viết BÁO CÁO ≤ 300 từ theo format:
  1. ĐÃ LÀM: từng việc + bằng chứng tool (tên tool + kết quả ngắn: file:line, pass/fail, số lỗi)${canTodo ? `
  2. KẾ HOẠCH & TIẾN ĐỘ: nếu đã tạo todo — liệt kê từng bước + trạng thái cuối (completed/failed/in_progress); task đơn giản thì ghi "(không cần kế hoạch)"` : ''}
  ${canTodo ? '3' : '2'}. CÒN THIẾU / CHƯA XÁC ĐỊNH: thành thật — KHÔNG tuyên bố hoàn thành gì thiếu bằng chứng
  ${canTodo ? '4' : '3'}. ĐỀ XUẤT cho parent: bước tiếp theo (nếu có)
- Tool call format: tool_call: <name>({ ...args })`
}

function buildWrapUpPrompt(task: string, lastContent: string, evidence: string[], reason: string): string {
  return `NHIỆM VỤ ĐÃ DELEGATE:
${task.slice(0, 1500)}

NỘI DUNG CUỐI (có thể đang dở):
${lastContent.slice(0, 2000) || '(trống)'}

NHẬT KÝ TOOL ĐÃ CHẠY:
${evidence.slice(-20).map(e => `- ${e}`).join('\n') || '(không có)'}

TÌNH TRẠNG: dừng vì ${reason}.

NHIỆM VỤ: viết BÁO CÁO TỔNG KẾT ≤ 300 từ theo 4 phần: (1) ĐÃ LÀM + bằng chứng tool cụ thể, (2) KẾ HOẠCH & TIẾN ĐỘ từng bước nếu có todo (completed/failed/in_progress — không có thì ghi "không cần kế hoạch"), (3) CÒN THIẾU/CHƯA KIỂM ĐỊNH ĐƯỢC — không đoán, (4) ĐỀ XUẤT bước tiếp theo. Không gọi tool. Không viết dài.`
}

function safeStringify(entry: { tool: string; success: boolean; result: unknown }): string {
  try {
    return JSON.stringify(entry)
  } catch {
    return JSON.stringify({ tool: entry.tool, success: entry.success, result: String(entry.result).slice(0, 500) })
  }
}
