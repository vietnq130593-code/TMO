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
 *          └─ runSubAgent() — mini ReAct loop IN-PROCESS:
 *              · resolve agent (APEX/CORTEX/BOLT/SENTINEL/CATALYST) từ DB/hardcoded
 *              · tối đa SUBAGENT_MAX_ITERATIONS vòng LLM + tool thật
 *              · token budget RIÊNG (SUBAGENT_TOKEN_BUDGET) — onTokens báo lên
 *                parent để cộng vào budget tổng (không thể chạy tuột)
 *              · context của sub-agent KHÔNG đổ vào parent — parent chỉ nhận
 *                BÁO CÁO NÉN (≤ ~3500 chars): đã làm · bằng chứng · còn thiếu
 *              · DEPTH GUARD: sub-agent KHÔNG có delegate_task trong whitelist
 *                → không bao giờ đệ quy vô hạn
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
import { parseToolCallsFromOutput } from '@/lib/tool-calls'
import { resolveAgent } from '@/lib/code-team/agent-resolver'
import { isSessionCancelled } from '@/lib/agent-run-tracker'

// ==================== CONFIG (env override) ====================

function intEnv(name: string, fallback: number): number {
  const v = Number(process.env[name])
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback
}

/** Số vòng LLM tối đa cho sub-agent (mặc định 5 — task delegate phải gọn) */
const SUBAGENT_MAX_ITERATIONS = intEnv('SUBAGENT_MAX_ITERATIONS', 5)
/** Token budget riêng của MỖI lần delegate (mặc định 40k) */
const SUBAGENT_TOKEN_BUDGET = intEnv('SUBAGENT_TOKEN_BUDGET', 40_000)
/** Timeout toàn bộ sub-agent run (mặc định 8 phút < time budget loop 30') */
const SUBAGENT_TIMEOUT_MS = intEnv('SUBAGENT_TIMEOUT_MS', 8 * 60_000)
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

// ==================== MAIN ENTRY ====================

/**
 * Chạy 1 sub-agent (Code Team) cho task được delegate.
 *
 * @param params.position position đã chuẩn hoá ('TL' | 'G1' | 'G2-A' | 'G2-B' | 'G3')
 * @param params.task     mô tả nhiệm vụ delegate (bắt buộc)
 * @param params.context  context bổ sung từ parent (file liên quan, ràng buộc...)
 * @param params.onTokens callback báo token tiêu thụ về PARENT budget
 */
export async function runSubAgent(params: {
  position: string
  task: string
  context?: string
  parentAgentName?: string
  sessionId?: string | null
  onTokens?: (tokens: number) => void
}): Promise<SubAgentOutcome> {
  const {
    position,
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
  const state: {
    endedBy: SubAgentOutcome['endedBy']
    errorMessage: string
    lastContent: string
    forceWrapUp: boolean
    wrapUpReason: string
  } = {
    endedBy: 'error',
    errorMessage: '',
    lastContent: '',
    forceWrapUp: false,
    wrapUpReason: '',
  }
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
    // ===== 1. Resolve agent (DB-first → hardcoded) =====
    const agent = await resolveAgent(position)
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
        error: `Agent position "${position}" không resolve được (missing) — kiểm tra Agents module.`,
      }
    }

    // DEPTH GUARD: sub-agent KHÔNG BAO GIỜ có delegate_task → không đệ quy
    const allowedTools = agent.tools.filter(t => t !== 'delegate_task')

    console.log(`[SubAgent] ${parentAgentName} → ${agent.name} (${position}): "${task.slice(0, 100)}" (max ${SUBAGENT_MAX_ITERATIONS} vòng, budget ${SUBAGENT_TOKEN_BUDGET} tokens)`)

    // ===== 2. Mini ReAct loop =====
    const systemPrompt = agent.instruction || `Bạn là ${agent.name} — agent chuyên trách của Code Team. Hoàn thành nhiệm vụ được delegate một cách tự chủ, ngắn gọn.`
    const transcript: Array<{ role: 'user' | 'assistant' | 'tool'; content: string }> = [
      { role: 'user', content: buildDelegationPrompt(agent.name, task, context, allowedTools, parentAgentName) },
    ]

    const loopPromise = (async () => {
      while (iterations < SUBAGENT_MAX_ITERATIONS) {
        if (isCancelled()) { state.endedBy = 'cancelled'; return }
        if (Date.now() - startedAt > SUBAGENT_TIMEOUT_MS - 60_000) {
          state.forceWrapUp = true; state.wrapUpReason = 'gần hết thời gian'; break
        }
        if (tokensUsed >= SUBAGENT_TOKEN_BUDGET) {
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
            callLLMForAgent(formatted, { provider: agent.provider, model: agent.model }, systemPrompt, {
              agentId: agent.id || `code-team:${position}`,
              agentName: `${agent.name} (sub-agent)`,
              temperature: agent.temperature,
              maxTokens: Math.min(agent.maxTokens, 4096),
              abortCheck: isCancelled,
            }),
            Math.max(60_000, SUBAGENT_TIMEOUT_MS - (Date.now() - startedAt)),
            `SubAgent ${agent.name} LLM`,
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

        const toolCalls = parseToolCallsFromOutput(result.content)
        if (toolCalls.length === 0) {
          state.lastContent = result.content
          state.endedBy = 'concluded'
          return
        }

        transcript.push({ role: 'assistant', content: result.content })

        for (const tc of toolCalls) {
          if (isCancelled()) break
          // Sub-agent bị giới hạn trong whitelist CỦA NÓ (đã loại delegate_task)
          if (!allowedTools.includes(tc.name)) {
            transcript.push({ role: 'tool', content: JSON.stringify({ tool: tc.name, success: false, result: `Tool "${tc.name}" not available for sub-agent ${agent.name}.` }) })
            evidence.push(`${tc.name}: bị từ chối (ngoài whitelist)`)
            continue
          }
          toolCallCount++
          let toolResult: { success: boolean; result: unknown }
          try {
            toolResult = await executeTool(tc.name, tc.args, { agentName: agent.name, sessionId })
          } catch (err) {
            toolResult = { success: false, result: { error: err instanceof Error ? err.message : String(err) } }
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

      if (state.endedBy !== 'concluded' && state.endedBy !== 'cancelled' && state.endedBy !== 'error') {
        state.forceWrapUp = true
        if (!state.wrapUpReason) state.wrapUpReason = `hết ${SUBAGENT_MAX_ITERATIONS} vòng`
        state.endedBy = 'iteration_limit'
      }
    })()

    await withTimeout(loopPromise, SUBAGENT_TIMEOUT_MS, `SubAgent ${agent.name} loop`)
      .catch(err => {
        if (state.endedBy === 'error' && !state.errorMessage) state.errorMessage = err instanceof Error ? err.message : String(err)
        state.endedBy = state.endedBy === 'concluded' ? state.endedBy : 'timeout'
      })

    if (isCancelled()) state.endedBy = 'cancelled'

    // ===== 3. Báo cáo NÉN trả về parent =====
    let report = state.lastContent
    const needWrapUp = state.forceWrapUp || state.endedBy === 'iteration_limit' || state.endedBy === 'token_budget' || state.endedBy === 'timeout' || (state.endedBy === 'error' && (state.lastContent || evidence.length > 0))

    if (needWrapUp && !isCancelled() && tokensUsed < SUBAGENT_TOKEN_BUDGET + 5_000) {
      // 1 call ép tổng kết ngắn — parent nhận báo cáo cô đọng thay vì
      // lastContent dài (đây là chìa khóa context isolation).
      try {
        const wrap = await withTimeout(
          callLLMForAgent(
            buildWrapUpPrompt(task, state.lastContent, evidence, state.wrapUpReason || state.endedBy),
            { provider: agent.provider, model: agent.model },
            `Bạn là ${agent.name}. Viết báo cáo tổng kết NGẮN GỌN theo đúng format yêu cầu.`,
            {
              agentId: agent.id || `code-team:${position}`,
              agentName: `${agent.name} (sub-agent wrap-up)`,
              temperature: 0.3,
              maxTokens: 900,
              abortCheck: isCancelled,
            },
          ),
          120_000,
          `SubAgent ${agent.name} wrap-up`,
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
        `**${agent.name} (${position}) — kết quả delegate**`,
        state.endedBy === 'error' ? `Lỗi: ${state.errorMessage}` : `Kết thúc: ${state.endedBy}`,
        evidence.length > 0 ? `**Tool đã chạy:**\n${evidence.slice(-15).map(e => `- ${e}`).join('\n')}` : '(không có tool call nào)',
      ].join('\n\n')
    }

    if (report.length > REPORT_MAX_CHARS) {
      report = report.slice(0, REPORT_MAX_CHARS) + '\n…(báo cáo sub-agent đã nén — hỏi lại sub-agent nếu cần chi tiết)'
    }

    const outcome: SubAgentOutcome = {
      success: state.endedBy === 'concluded' || (state.endedBy !== 'error' && evidence.length > 0),
      agent: agent.name,
      position,
      report,
      tokensUsed,
      iterations,
      toolCalls: toolCallCount,
      endedBy: state.endedBy,
      evidence,
      error: state.endedBy === 'error' ? state.errorMessage : undefined,
    }

    console.log(`[SubAgent] ${agent.name} xong: ${state.endedBy} — ${iterations} vòng, ${toolCallCount} tool calls, ${tokensUsed} tokens, ${Math.round((Date.now() - startedAt) / 1000)}s`)
    return outcome
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err)
    console.warn(`[SubAgent] Delegate "${position}" failed:`, errorMessage)
    return {
      success: false,
      agent: `Unknown-${position}`,
      position,
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

// ==================== PROMPTS ====================

function buildDelegationPrompt(
  agentName: string,
  task: string,
  context: string | undefined,
  allowedTools: string[],
  parentAgentName: string,
): string {
  return `Bạn (${agentName}) được ${parentAgentName} DELEGATE một nhiệm vụ tự chủ. Làm việc ĐỘC LẬP — không hỏi lại parent.

NHIỆM VỤ:
${task}
${context ? `\nCONTEXT TỪ PARENT:\n${context.slice(0, 3000)}\n` : ''}
TOOLS BẠN ĐƯỢC DÙNG: ${allowedTools.join(', ') || '(none — trả lời bằng kiến thức)'}

QUY TẮC:
- Dùng tools thật để đọc/sửa/chạy — không đoán kết quả file/lệnh.
- Mỗi vòng tối đa vài tool calls; ưu tiên hành động trực tiếp.
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
