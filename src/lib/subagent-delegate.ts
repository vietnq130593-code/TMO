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
 *     └─ tool_call: delegate_task({agent: "BOLT", task: "..."})
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
 */

import { callLLMForAgent } from '@/lib/llm'
import { executeTool } from '@/lib/code-team/tool-executor'
import { parseToolCallsFromOutput, detectBrokenToolCallHint } from '@/lib/tool-calls'
import { resolveAgent } from '@/lib/code-team/agent-resolver'
import { isSessionCancelled } from '@/lib/agent-run-tracker'

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

/** Số vòng LLM tối đa cho sub-agent (mặc định 5 — task delegate phải gọn; 0 = ∞ — CI-1) */
const SUBAGENT_MAX_ITERATIONS = intEnv('SUBAGENT_MAX_ITERATIONS', 5)
/** Token budget riêng của MỖI lần delegate (mặc định 40k; 0 = ∞ — CI-1) */
const SUBAGENT_TOKEN_BUDGET = intEnv('SUBAGENT_TOKEN_BUDGET', 40_000)
/** Timeout toàn bộ sub-agent run (mặc định 8 phút < time budget loop 30'; 0 = ∞ — CI-1) */
const SUBAGENT_TIMEOUT_MS = intEnv('SUBAGENT_TIMEOUT_MS', 8 * 60_000)
/**
 * FIX 2026-09-11 (review #7 MEDIUM): khi CẢ 3 cap đều = 0 (unlimited) sub-agent
 * không còn phanh nào → parent kẹt vĩnh viễn trong executeTool. Trần cứng dự
 * phòng: KHÔNG thể tắt qua env — chỉ kích hoạt khi cả 3 cap đều 0.
 */
const SUBAGENT_HARD_CEILING_ITERATIONS = 200
const ALL_SUBAGENT_CAPS_UNLIMITED =
  SUBAGENT_MAX_ITERATIONS === 0 && SUBAGENT_TOKEN_BUDGET === 0 && SUBAGENT_TIMEOUT_MS === 0
const SUBAGENT_EFFECTIVE_MAX_ITERATIONS = ALL_SUBAGENT_CAPS_UNLIMITED
  ? SUBAGENT_HARD_CEILING_ITERATIONS
  : SUBAGENT_MAX_ITERATIONS
/** Cap ký tự tool result trong context CỦA SUB-AGENT */
const SUBAGENT_TOOL_RESULT_CHARS = 4000
/** Cap ký tự báo cáo trả về PARENT */
const REPORT_MAX_CHARS = 3500

/** Map tên agent → position trong Code Team (resolveAgent nhận position) */
const POSITION_BY_NAME: Record<string, string> = {
  APEX: 'TL',
  CORTEX: 'G1',
  BOLT: 'G2-A',
  SENTINEL: 'G2-B',
  CATALYST: 'G3',
}

/**
 * DEPTH GUARD — sub-agent KHÔNG BAO GIỜ có các tool điều phối này (đệ quy
 * vô hạn: agent A delegate B, B delegate C...). escalate_problem được GIỮ —
 * consult Omega là 1 LLM call đơn (không chạy tool, không đệ quy).
 */
export const DEPTH_GUARD_TOOLS = ['delegate_task', 'dispatch_agent', 'create_agent']

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

/** Danh sách agent có thể delegate (cho tool description + validate) */
export const DELEGATABLE_AGENTS: Array<{ name: string; role: string; bestFor: string }> = [
  { name: 'APEX', role: 'TL — Nhìn & Điều hướng', bestFor: 'phân tích yêu cầu phức tạp, routing, code UI fast-track, verify kết quả tổng thể' },
  { name: 'CORTEX', role: 'G1 — Thiết kế', bestFor: 'thiết kế kiến trúc, DB schema, API design, component tree' },
  { name: 'BOLT', role: 'G2-A — Code Execution', bestFor: 'implement code TypeScript/React/Next.js, viết API, database operations' },
  { name: 'SENTINEL', role: 'G2-B — Review & Fix', bestFor: 'code review, tìm bug, security check, fix lỗi, iterative refinement' },
  { name: 'CATALYST', role: 'G3 — Tối ưu', bestFor: 'performance optimization, refactor, scalability, best practices' },
]

/**
 * Chuẩn hoá input (chấp nhận tên 'BOLT'/'bolt' hoặc position 'G2-A')
 * → position để resolveAgent, hoặc null nếu không hợp lệ.
 */
export function resolveDelegationTarget(input: unknown): string | null {
  const key = String(input ?? '').trim().toUpperCase()
  if (!key) return null
  if (POSITION_BY_NAME[key]) return POSITION_BY_NAME[key]
  if (['TL', 'G1', 'G2-A', 'G2-B', 'G3'].includes(key)) return key
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

// ==================== GENERIC SUB-AGENT RUNNER ====================

/**
 * Chạy 1 sub-agent THEO PROFILE (generic — Code Team, custom, hoặc agent do
 * Omega tạo). Đây là lõi mini ReAct loop với context isolation + depth guard.
 *
 * @param params.profile   profile agent đã resolve (provider/model/tools...)
 * @param params.task      mô tả nhiệm vụ delegate (bắt buộc)
 * @param params.context   context bổ sung từ parent (file liên quan, ràng buộc...)
 * @param params.onTokens  callback báo token tiêu thụ về PARENT budget
 */
export async function runSubAgentForProfile(params: {
  profile: SubAgentProfile
  task: string
  context?: string
  parentAgentName?: string
  sessionId?: string | null
  onTokens?: (tokens: number) => void
}): Promise<SubAgentOutcome> {
  const {
    profile,
    task,
    context,
    parentAgentName = 'parent-agent',
    sessionId = null,
    onTokens,
  } = params

  const startedAt = Date.now()
  const evidence: string[] = []
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
  // ANTI-HALLUCINATION (E2E 2026-09-08): APEX được delegate "đọc 3 file" nhưng
  // conclude ngay vòng 1 với 0 tool call → "phân tích" là bịa (parent may mắn
  // tự đọc lại). Giờ: task yêu cầu bằng chứng thật mà sub-agent chưa chạy tool
  // nào → đẩy 1 directive ép chạy tool, chỉ accept conclude ở vòng sau.
  let nudgedOnce = false
  // 21-d: số lần đẩy feedback parse-fail (tool call bị cắt cụt giữa JSON)
  // — tránh loop vô hạn khi LLM liên tục phát JSON lỗi.
  let parseFailNudges = 0
  let tokensUsed = 0
  let iterations = 0
  let toolCallCount = 0

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

    console.log(`[SubAgent] ${parentAgentName} → ${profile.name}: "${task.slice(0, 100)}" (max ${ALL_SUBAGENT_CAPS_UNLIMITED ? SUBAGENT_HARD_CEILING_ITERATIONS + ' (trần cứng — cả 3 cap = 0)' : SUBAGENT_MAX_ITERATIONS === 0 ? '∞' : SUBAGENT_MAX_ITERATIONS} vòng, budget ${SUBAGENT_TOKEN_BUDGET === 0 ? '∞' : SUBAGENT_TOKEN_BUDGET} tokens${SUBAGENT_TIMEOUT_MS === 0 ? ', timeout ∞' : ''}, ${allowedTools.length} tools)`)

    // ===== Mini ReAct loop =====
    const systemPrompt = profile.instruction || `Bạn là ${profile.name} — agent chuyên trách. Hoàn thành nhiệm vụ được delegate một cách tự chủ, ngắn gọn.`
    const transcript: Array<{ role: 'user' | 'assistant' | 'tool'; content: string }> = [
      { role: 'user', content: buildDelegationPrompt(profile.name, task, context, allowedTools, parentAgentName) },
    ]

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
              maxTokens: Math.min(profile.maxTokens, 16384), // 21-d: nâng cap để agent viết file lớn (file_write append) — cap không phải target
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

        const toolCalls = parseToolCallsFromOutput(result.content)
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
          state.lastContent = result.content
          state.endedBy = 'concluded'
          return
        }

        transcript.push({ role: 'assistant', content: result.content })

        for (const tc of toolCalls) {
          if (isCancelled() || timedOut) break // zombie guard — dừng tool batch
          // Sub-agent bị giới hạn trong whitelist CỦA NÓ (đã strip depth-guard tools)
          if (!allowedTools.includes(tc.name)) {
            transcript.push({ role: 'tool', content: JSON.stringify({ tool: tc.name, success: false, result: `Tool "${tc.name}" not available for sub-agent ${profile.name}.` }) })
            evidence.push(`${tc.name}: bị từ chối (ngoài whitelist)`)
            continue
          }
          toolCallCount++
          let toolResult: { success: boolean; result: unknown }
          try {
            toolResult = await executeTool(tc.name, tc.args, { agentName: profile.name, sessionId })
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
          let preview = ''
          try {
            const r = toolResult.result
            preview = typeof r === 'object' && r !== null
              ? JSON.stringify(r).slice(0, 160)
              : String(r ?? '').slice(0, 160)
          } catch { preview = '(?)' }
          evidence.push(`${tc.name}(${compactArgs(tc.args)}) → ${toolResult.success ? '✓' : '✗'} ${preview}`)
          transcript.push({
            role: 'tool',
            content: truncateResult(safeStringify({ tool: tc.name, success: toolResult.success, result: toolResult.result }), SUBAGENT_TOOL_RESULT_CHARS),
          })
        }
      }

      // Phân loại kết thúc khi loop thoát KHÔNG qua concluded/cancelled/error/
      // timeout — trước đây dead-code vì endedBy khởi tạo 'error' (fix ở trên).
      if (state.endedBy !== 'concluded' && state.endedBy !== 'cancelled' && state.endedBy !== 'error' && state.endedBy !== 'timeout') {
        state.forceWrapUp = true
        if (!state.wrapUpReason) state.wrapUpReason = `hết ${SUBAGENT_EFFECTIVE_MAX_ITERATIONS} vòng${ALL_SUBAGENT_CAPS_UNLIMITED ? ' (trần cứng dự phòng — cả 3 cap = 0)' : ''}`
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
    // cần biết điều này để tự verify (E2E 2026-09-08: APEX "phân tích" 3 file
    // mà 0 tool call — may Omega tự đọc lại).
    if (toolCallCount === 0 && !report.startsWith('⚠️')) {
      report = `⚠️ (LƯU Ý: sub-agent ${profile.name} KHÔNG chạy tool nào — nội dung dưới đây từ kiến thức model, chưa có bằng chứng đọc file/lệnh thật. Nếu cần chính xác, hãy tự file_read/grep verify hoặc delegate lại với yêu cầu rõ ràng dùng tool.)\n\n${report}`
    }

    if (report.length > REPORT_MAX_CHARS) {
      report = report.slice(0, REPORT_MAX_CHARS) + '\n…(báo cáo sub-agent đã nén — hỏi lại sub-agent nếu cần chi tiết)'
    }

    const outcome: SubAgentOutcome = {
      success: state.endedBy === 'concluded' || (state.endedBy !== 'error' && evidence.length > 0),
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

    console.log(`[SubAgent] ${profile.name} xong: ${state.endedBy} — ${iterations} vòng, ${toolCallCount} tool calls, ${tokensUsed} tokens, ${Math.round((Date.now() - startedAt) / 1000)}s`)
    return outcome
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err)
    console.warn(`[SubAgent] Delegate "${profile.name}" failed:`, errorMessage)
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
 * Chạy 1 sub-agent CODE TEAM (APEX/CORTEX/BOLT/SENTINEL/CATALYST) cho task
 * được delegate — giữ tương thích ngược với delegate_task.
 */
export async function runSubAgent(params: {
  position: string
  task: string
  context?: string
  parentAgentName?: string
  sessionId?: string | null
  onTokens?: (tokens: number) => void
}): Promise<SubAgentOutcome> {
  const { position, task, context, parentAgentName = 'parent-agent', sessionId = null, onTokens } = params

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
): string {
  const canEscalate = allowedTools.includes('escalate_problem')
  return `Bạn (${agentName}) được ${parentAgentName} DELEGATE một nhiệm vụ tự chủ. Làm việc ĐỘC LẬP — không hỏi lại parent.

NHIỆM VỤ:
${task}
${context ? `\nCONTEXT TỪ PARENT:\n${context.slice(0, 3000)}\n` : ''}
TOOLS BẠN ĐƯỢC DÙNG: ${allowedTools.join(', ') || '(none — trả lời bằng kiến thức)'}

QUY TẮC:
- Dùng tools thật để đọc/sửa/chạy — không đoán kết quả file/lệnh.
- Mỗi vòng tối đa vài tool calls; ưu tiên hành động trực tiếp.
${canEscalate ? '- Nếu BẾ TẮC (tool fail lặp lại / không rõ hướng giải): tool_call: escalate_problem({"problem": "...", "context": "...", "attempted": "..."}) → Omega orchestrator sẽ tư vấn giải pháp.' : ''}
- Khi xong (hoặc không làm tiếp được), viết BÁO CÁO ≤ 300 từ theo format:
  1. ĐÃ LÀM: từng việc + bằng chứng tool (tên tool + kết quả ngắn: file:line, pass/fail, số lỗi)
  2. CÒN THIẾU / CHƯA XÁC ĐỊNH: thành thật — KHÔNG tuyên bố hoàn thành gì thiếu bằng chứng
  3. ĐỀ XUẤT cho parent: bước tiếp theo (nếu có)
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

NHIỆM VỤ: viết BÁO CÁO TỔNG KẾT ≤ 300 từ, đúng 3 phần: (1) ĐÃ LÀM + bằng chứng tool cụ thể, (2) CÒN THIẾU/CHƯA KIỂM ĐỊNH ĐƯỢC — không đoán, (3) ĐỀ XUẤT bước tiếp theo. Không gọi tool. Không viết dài.`
}

function safeStringify(entry: { tool: string; success: boolean; result: unknown }): string {
  try {
    return JSON.stringify(entry)
  } catch {
    return JSON.stringify({ tool: entry.tool, success: entry.success, result: String(entry.result).slice(0, 500) })
  }
}
