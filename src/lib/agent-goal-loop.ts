/**
 * GOAL-DRIVEN LONG-HORIZON AGENT LOOP
 * ====================================
 * (user request 2026-09-01: "Tôi muốn các Agents có thể thực hiện tác vụ dài hạn cho
 * đến khi đạt được mục tiêu cuối cùng. Vòng lặp cần xác định được vấn đề, triển khai,
 * kiểm định/test, xác định hoàn thành hay chưa, nếu chưa xác định vấn đề nằm ở đâu,
 * rồi lại lên kế hoạch triển khai, triển khai, kiểm định cho đến khi hoàn thành")
 *
 * Đây là bộ não điều khiển vòng lặp mục tiêu dài hạn — thay thế runAgentReActLoop
 * (loop cũ kết thúc khi LLM ngừng phát tool call hoặc cắt cứng ở 8 vòng, KHÔNG kiểm
 * chứng mục tiêu có đạt hay không).
 *
 * Kiến trúc (so sánh Claude Code / Z.ai Code / Kimi Code — xem
 * docs/DANH_GIA_REACT_LOOP_VS_CLAUDE_CODE.md):
 *
 *   CYCLE 1..maxCycles:
 *     [1] PLAN      — protocol ép agent phân tích vấn đề + todo_write kế hoạch
 *     [2] EXECUTE   — inner ReAct loop (maxIterationsPerCycle vòng, tools thật)
 *     [3] VERIFY    — protocol ép agent kiểm định bằng tool (file_read / run_tests /
 *                     lint / shell) — bằng chứng phải nằm trong KẾT QUẢ TOOL
 *     [4] EVALUATE  — trọng tài LLM ĐỘC LẬP: chỉ tin BẰNG CHỨNG tool, không tin
 *                     lời tuyên bố → JSON verdict {complete, confidence, verified,
 *                     missing, rootCause, nextPlan}
 *     [5] chưa đạt  → DIAGNOSE + REPLAN → inject continuation directive
 *                     ("vấn đề nằm ở đâu, kế hoạch mới, KHÔNG lặp hành động đã fail")
 *                     → chu kỳ kế tiếp
 *
 *   STOP: complete | max_cycles | time_budget | token_budget | no_progress
 *         | cancelled | error
 *   → luôn kết thúc bằng báo cáo trung thực (hoàn thành đến đâu, bằng chứng gì,
 *     còn thiếu gì).
 *
 * UPGRADE 2026-09-07 (user report: "vòng lặp dừng giữa chừng do hết budget,
 * báo cáo bị cắt ngang, không có bằng chứng kiểm định"):
 *   [A] REPORT RESERVE — dự trữ ~10% token budget (min 15k) riêng cho
 *       EVALUATE cuối + BÁO CÁO CUỐI. EXECUTE dừng sớm khi chạm ngưỡng reserve
 *       → báo cáo cuối KHÔNG BAO GIỜ bị cắt ngang giữa chừng nữa.
 *   [B] FINAL REPORT CALL — khi dừng vì budget/chu kỳ mà chưa complete: 1 LLM
 *       call tổng kết bắt buộc (đã làm · bằng chứng tool · còn thiếu · ĐỀ XUẤT
 *       KHẮC PHỤC) — thay vì trả lastContent đang dở.
 *   [C] VERIFY EVIDENCE GUARD (harness kiểm đếm, không thể bịa) — track tool
 *       kiểm định (run_tests/lint/type_check/file_read...) theo thứ tự so với
 *       tool sửa (file_edit/shell...). Kết luận "complete" mà có sửa SAU lần
 *       kiểm định cuối → harness HẠ xuống chưa đạt.
 *   [D] SMART TRUNCATION — tool result cắt đầu+cuối (lỗi tsc/lint/test summary
 *       nằm CUỐI output) + evidence preview trích errorCount + thông báo lỗi
 *       cụ thể — evaluator thấy đúng bằng chứng, không phải đoán.
 *
 * Khác Claude Code/Z.ai/Kimi Code (dựa vào model-discipline): TMO ép bằng HARNESS —
 * evaluator độc lập soi bằng chứng + no-progress fingerprint + budgets. Đánh đổi:
 * +1 LLM call mỗi chu kỳ (rẻ so với chạy sai 1 task dài).
 *
 * Fail-open toàn bộ: crash ở bất kỳ đâu → trả nội dung tốt nhất đã có; caller
 * (chat route) có fallback /api/query như cũ.
 */

import { callLLMForAgent } from '@/lib/llm'
import { executeTool } from '@/lib/code-team/tool-executor'
import { parseToolCallsFromOutput, formatMessagesForLLM } from '@/lib/tool-calls'
import { findBalancedJson } from '@/lib/code-team/find-balanced-json'
import {
  startAgentRun,
  endAgentRun,
  recordAgentThought,
  isSessionCancelled,
} from '@/lib/agent-run-tracker'
// WORKING MEMORY (HOT) — user request 2026-08-28: ghi nhận quá trình làm việc
// (tool đã chạy, kết quả ra sao) vào WorkingMemory để (a) request sau trong cùng
// session KHÔNG phải đọc/làm lại — tiết kiệm token, (b) hết phiên promote lên
// WARM (AgentMemory) qua runTierTransitions → ghi nhớ dài hạn về công việc đã làm.
import { addToWorkingMemory } from '@/lib/memory-tiers'

/** Gọn args để nhét vào working memory (chống phình) */
function compactToolArgs(args: Record<string, unknown>, maxLen = 120): string {
  try {
    const s = JSON.stringify(args)
    return s.length > maxLen ? s.slice(0, maxLen) + '…' : s
  } catch {
    return '(args không serialize được)'
  }
}

/** Fire-and-forget ghi 1 entry HOT — fail-open, không chặn loop */
function recordWorkMemory(agentId: string, sessionId: string | null, content: string, importance = 0.7): void {
  if (!agentId || agentId === 'unknown' || !sessionId) return // HOT cần agent + session thật
  addToWorkingMemory({
    agentId,
    sessionId,
    content: content.slice(0, 600),
    role: 'system',
    importance,
  }).catch(() => { /* fail-open — memory không được phép làm hỏng task */ })
}

// ==================== CONFIG (env override) ====================

function intEnv(name: string, fallback: number): number {
  const v = Number(process.env[name])
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback
}

/** Số chu kỳ PLAN→EXECUTE→VERIFY→EVALUATE tối đa (mặc định 4) */
const MAX_CYCLES = intEnv('GOAL_LOOP_MAX_CYCLES', 4)
/** Số vòng ReAct tối đa MỖI chu kỳ (mặc định 10 → tổng tối đa 40 vòng) */
const ITER_PER_CYCLE = intEnv('GOAL_LOOP_ITERATIONS_PER_CYCLE', 10)
/** Budget thời gian toàn bộ loop (mặc định 30 phút — tác vụ dài hạn; align với
 *  client display safeguard 30' — E2E Test B cho thấy kimi-k3 ~100s/call nên
 *  12' cũ quá ngắn: agent đang tiến triển tốt vẫn bị cắt giữa chừng) */
const TIME_BUDGET_MS = intEnv('GOAL_LOOP_TIME_BUDGET_MS', 30 * 60_000)
/** Budget token toàn bộ loop (mặc định 200k — đủ ~40 vòng context lớn) */
const TOKEN_BUDGET = intEnv('GOAL_LOOP_TOKEN_BUDGET', 200_000)
/**
 * [A] REPORT RESERVE — phần token dự trữ KHÔNG cho EXECUTE dùng. Dành riêng cho
 * evaluator chu kỳ cuối + FINAL REPORT call → khi budget cạn, loop vẫn đủ token
 * tổng kết báo cáo HOÀN CHỈNH thay vì cắt ngang giữa chừng.
 * (user report 2026-09-07: "báo cáo bị cắt ngang ở phần Workflow Engine")
 */
const REPORT_RESERVE_TOKENS = intEnv('GOAL_LOOP_REPORT_RESERVE_TOKENS', Math.max(15_000, Math.floor(TOKEN_BUDGET * 0.1)))
/**
 * Timeout 1 LLM call. Mặc định 21 phút > KEY_ROTATION_BUDGET_MS (15') của
 * callLLMForAgent — E2E Test C/live-UI cho thấy khi NVIDIA rate-limit nặng,
 * 1 callLLMForAgent hợp lệ cần 12 attempts + nhiều cooldown 30s (vượt xa 240s
 * cũ — timeout ngoài giết chuỗi xoay vòng key giữa chừng, biến "retry kiên
 * trì" thành "error"). Timeout giờ chỉ là lưới an toàn chống call treo vĩnh
 * viễn; bound thật của loop = TIME_BUDGET_MS (30') + TOKEN_BUDGET + user cancel
 * (abortCheck xuyên suốt mọi vòng đợi cooldown).
 */
const LLM_TIMEOUT_MS = intEnv('GOAL_LOOP_LLM_TIMEOUT_MS', 21 * 60_000)
/** Cap ký tự của tool result khi đẩy vào messages (chống context nổ) */
const MAX_TOOL_RESULT_CHARS = 4000
/** Cap số messages giữa các chu kỳ (trim giữ system + goal + đuôi gần nhất) */
const MAX_MESSAGES = 48
/** Cap số dòng evidence log giữ lại cho evaluator */
const MAX_EVIDENCE_ENTRIES = 60
/** [C] Tool kiểm định — bằng chứng verify chỉ tính khi tool THÀNH CÔNG */
const VERIFY_TOOLS = new Set(['run_tests', 'lint', 'type_check', 'test_coverage', 'get_diagnostics', 'lsp_diagnostics'])
/** [C] Đọc lại kết quả (file_read/grep sau khi sửa) cũng là kiểm định */
const READBACK_TOOLS = new Set(['file_read', 'grep'])
/** [C] Tool sửa đổi — sau những tool này PHẢI có kiểm định lại trước khi kết luận */
const MODIFY_TOOLS = new Set(['file_edit', 'file_multi_edit', 'file_delete', 'mkdir', 'shell', 'run_bg', 'git_commit'])
/** [D] Tool verify được cap context lớn hơn (cần thấy đủ kết quả test/lint/tsc) */
const VERIFY_RESULT_CHARS = 6000

// ==================== TYPES ====================

export type GoalStopReason =
  | 'complete'
  | 'max_cycles'
  | 'time_budget'
  | 'token_budget'
  | 'no_progress'
  | 'cancelled'
  | 'error'

export interface GoalLoopResult {
  content: string
  iterations: number
  toolCallsExecuted: number
  runId?: string | null
  /** Goal-loop metadata — response JSON + todo auto-close quyết định theo complete */
  goalLoop?: {
    cycles: number
    complete: boolean
    stopReason: GoalStopReason
    evaluatorConfidence?: number
    missing?: string[]
    /** [B] final-report tổng hợp được dùng (báo cáo hoàn chỉnh khi budget cạn) */
    finalReport?: boolean
    /** Token đã tiêu thụ toàn bộ loop — UI có thể hiển thị so với budget */
    tokensUsed?: number
  }
}

interface GoalMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  tool_call_id?: string
}

interface EvidenceEntry {
  cycle: number
  kind: 'tool' | 'directive'
  tool?: string
  success?: boolean
  text: string // preview ~200 chars
}

interface EvalVerdict {
  complete: boolean
  confidence: number
  verified: boolean
  missing: string[]
  rootCause: string
  nextPlan: string[]
  raw: string
}

// ==================== PROMPTS ====================

/**
 * Protocol điều pha — appended vào system prompt của agent (KHÔNG sửa instruction
 * agent trong DB → giữ nguyên customization của user).
 */
function buildGoalProtocol(): string {
  return `

═══════════════════════════════════════════
📋 GOAL-DRIVEN EXECUTION PROTOCOL (vòng lặp mục tiêu dài hạn)
═══════════════════════════════════════════
Bạn đang chạy trong vòng lặp thực hiện mục tiêu đến khi HOÀN THÀNH. Mỗi chu kỳ làm việc TUÂN THỦ ĐÚNG 3 giai đoạn:

GIAI ĐOẠN 1 — XÁC ĐỊNH VẤN ĐỀ & LẬP KẾ HOẠCH:
- Phân tích mục tiêu: kết quả cuối cùng cụ thể là gì? Điều kiện hoàn thành kiểm định được thế nào?
- Nếu task hơn 1 bước: gọi todo_write chia nhỏ thành các bước có thứ tự

GIAI ĐOẠN 2 — TRIỂN KHAI:
- Thực hiện từng bước bằng tools. Đọc file (file_read) trước khi sửa. Chạy lệnh (shell) khi cần.

GIAI ĐOẠN 3 — KIỂM ĐỊNH & BÁO CÁO (BẮT BUỘC trước khi kết luận):
- Với tác vụ tạo/sửa file, code, lệnh, dữ liệu: PHẢI kiểm định bằng tool thật — file_read đọc lại kết quả, run_tests / lint / type_check, shell kiểm tra output. Bằng chứng phải nằm trong KẾT QUẢ TOOL.
- Khi type_check/lint/run_tests FAIL: đọc errorCount + thông báo lỗi cụ thể từng file trong KẾT QUẢ TOOL — KHÔNG đoán nguyên nhân; nếu output không đủ để xác định lỗi cụ thể thì báo rõ "không xác định được nguyên nhân cụ thể". Tool fail KHÔNG đồng nghĩa "đã kiểm định".
- CHỈ được kết luận hoàn thành khi bằng chứng kiểm định thực sự KHỚP mục tiêu.
- Kết thúc chu kỳ bằng báo cáo đủ 4 phần: đã làm gì · bằng chứng tool (tên tool + kết quả ngắn) · còn thiếu gì · đề xuất khắc phục.

⚠️ Một TRỌNG TÀI ĐỘC LẬP sẽ đánh giá lại kết quả của bạn DỰA TRÊN BẰNG CHỨNG TOOL THẬT. Lời tuyên bố không có bằng chứng sẽ BỊ TỪ CHỐI và bạn phải làm lại ở chu kỳ tiếp theo.
Nếu mục tiêu là câu hỏi/thông tin (không cần hành động), chỉ cần trả lời đầy đủ, chính xác — không cần tool.`
}

/** Directive nối tiếp chu kỳ — chẩn đoán + kế hoạch mới từ evaluator */
function buildContinuationDirective(v: EvalVerdict, cycle: number, cutMidWork: boolean): string {
  const missing = v.missing.length > 0 ? v.missing.map(m => `- ${m}`).join('\n') : '- (trọng tài không liệt kê cụ thể — tự rà soát lại mục tiêu)'
  const plan = v.nextPlan.length > 0 ? v.nextPlan.map((p, i) => `${i + 1}. ${p}`).join('\n') : '- tự xác định bước khắc phục'
  const cut = cutMidWork ? '\n⚠️ Chu kỳ trước bị cắt giữa chừng do hết vòng lặp — công việc có thể đang dở.' : ''
  return `[GOAL-LOOP: Chu kỳ ${cycle}/${MAX_CYCLES}] Mục tiêu CHƯA hoàn thành theo đánh giá độc lập (độ tin cậy ${Math.round(v.confidence * 100)}%).${cut}

❌ Còn thiếu:
${missing}

🔍 Vấn đề nằm ở: ${v.rootCause || '(chưa xác định được nguyên nhân gốc)'}${!v.verified ? '\n⚠️ Bạn CHƯA kiểm định kết quả bằng tool thật ở chu kỳ trước — chu kỳ này PHẢI có bằng chứng kiểm định.' : ''}

📋 Kế hoạch tiếp theo:
${plan}

Hãy: (1) cập nhật todo_write với kế hoạch trên (điều chỉnh nếu thấy hợp lý hơn), (2) khắc phục vấn đề, (3) KIỂM ĐỊNH LẠI bằng tools để có bằng chứng. KHÔNG lặp lại đúng hành động đã thất bại — nếu cách cũ fail, đổi cách tiếp cận.`
}

const EVALUATOR_SYSTEM_PROMPT = `Bạn là EVALUATOR — trọng tài độc lập đánh giá việc thực hiện mục tiêu của một AI Agent.

Nguyên tắc SẮT:
1. Bạn KHÔNG tin vào lời tuyên bố của agent ("tôi đã hoàn thành", "file đã tạo"...). Bạn CHỈ tin vào BẰNG CHỨNG trong kết quả tool thật: output lệnh, kết quả test, nội dung file đọc lại.
2. Mục tiêu là câu hỏi/thông tin (không yêu cầu tạo/sửa/ chạy gì) → "complete": true khi câu trả lời cuối của agent đầy đủ và đúng trọng tâm.
3. Mục tiêu đòi hỏi hành động (tạo/sửa file, code, chạy lệnh, dữ liệu) → "complete": true KHI VÀ CHỈ KHI có bằng chứng tool cho thấy kết quả đúng (file đọc lại khớp yêu cầu, test/lint pass, lệnh exit thành công).
4. Agent KHÔNG kiểm định (không có tool nào xác nhận kết quả) → "verified": false → với mục tiêu hành động thì "complete": false.
5. "missing" = những gì còn thiếu so với mục tiêu. "rootCause" = vấn đề nằm chính xác ở đâu (bước nào fail / thiếu gì / sai chỗ nào). "nextPlan" = các bước khắc phục cụ thể cho chu kỳ kế tiếp.
6. Công cụ kiểm định FAIL (type_check/lint/run_tests lỗi) KHÔNG tự động là "bằng chứng đã kiểm định": chỉ tin khi kết quả chứa errorCount/thông báo lỗi CỤ THỂ; nếu agent không trích được lỗi cụ thể (output bị cắt / nguyên nhân mơ hồ như "tsc fail") → "verified": false và ghi rõ vào "missing".

Output DUY NHẤT một dòng JSON hợp lệ (KHÔNG markdown fence, KHÔNG giải thích thêm):
{"complete": true|false, "confidence": 0.0-1.0, "verified": true|false, "missing": ["..."], "rootCause": "...", "nextPlan": ["..."]}`

// ==================== HELPERS ====================

/** Timeout wrapper cho LLM call (Promise.race như workflow-engine) */
async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
  })
  try {
    return await Promise.race([promise, timeoutPromise])
  } finally {
    if (timeoutId) clearTimeout(timeoutId)
  }
}

/** Parse JSON verdict từ output evaluator (chống markdown fence + text thừa) */
function parseEvalVerdict(raw: string): EvalVerdict | null {
  try {
    const text = raw.replace(/```(?:json)?/g, '')
    const jsonStr = findBalancedJson(text, 'complete')
    if (!jsonStr) return null
    const obj = JSON.parse(jsonStr) as Record<string, unknown>
    const complete = obj.complete === true
    const confidence = typeof obj.confidence === 'number' ? Math.min(1, Math.max(0, obj.confidence)) : (complete ? 0.8 : 0.5)
    const verified = obj.verified === true
    const missing = Array.isArray(obj.missing) ? obj.missing.map(m => String(m).slice(0, 200)).filter(Boolean).slice(0, 6) : []
    const rootCause = typeof obj.rootCause === 'string' ? obj.rootCause.slice(0, 400) : ''
    const nextPlan = Array.isArray(obj.nextPlan) ? obj.nextPlan.map(p => String(p).slice(0, 200)).filter(Boolean).slice(0, 6) : []
    return { complete, confidence, verified, missing, rootCause, nextPlan, raw: raw.slice(0, 400) }
  } catch {
    return null
  }
}

/** Fingerprint "có tiến triển không" — hash nội dung 6 messages cuối */
function progressFingerprint(messages: GoalMessage[]): string {
  let h = 5381
  for (const m of messages.slice(-6)) {
    const s = `${m.role}|${m.content.slice(-150)}`
    for (let i = 0; i < s.length; i++) {
      h = ((h << 5) + h + s.charCodeAt(i)) | 0
    }
  }
  return String(h)
}

/**
 * [D] SMART TRUNCATION — cắt giữ ĐẦU + CUỐI (60%/40%). Lỗi của tsc/lint/test
 * và dòng tổng kết ("X errors, Y passed") thường nằm CUỐI output — cắt
 * head-only như cũ làm mất đúng phần quan trọng nhất (user report 2026-09-07:
 * "lint output bị cắt nên không xác minh được lỗi cụ thể").
 */
function smartTruncate(s: string, maxChars: number): string {
  if (s.length <= maxChars) return s
  const head = Math.floor(maxChars * 0.6)
  const tail = Math.max(200, maxChars - head - 90)
  return (
    s.slice(0, head) +
    `\n…[truncated ${s.length - head - tail} chars giữa — giữ đầu + cuối vì lỗi/tổng kết thường nằm cuối output]…\n` +
    s.slice(-tail)
  )
}

/** Đẩy tool result vào messages với cap ký tự (chống context nổ).
 *  Tool kiểm định (lint/type_check/run_tests...) được cap cao hơn — agent và
 *  evaluator cần thấy đủ thông tin lỗi để diễn giải chính xác. */
function pushToolMessage(messages: GoalMessage[], entry: { tool: string; success: boolean; result: unknown }): void {
  const cap = VERIFY_TOOLS.has(entry.tool) ? VERIFY_RESULT_CHARS : MAX_TOOL_RESULT_CHARS
  let content: string
  try {
    content = JSON.stringify(entry)
  } catch {
    content = JSON.stringify({ tool: entry.tool, success: entry.success, result: String(entry.result).slice(0, cap) })
  }
  if (content.length > cap) {
    content = smartTruncate(content, cap)
  }
  messages.push({ role: 'tool', content })
}

/**
 * [D] Evidence preview thông minh — thay vì cắt 200 ký tự đầu mù quáng, trích
 * các trường structured (success/errorCount/warningCount/exitCode...) + THÔNG
 * BÁO LỖI CỤ THỂ đầu tiên để evaluator thấy đúng bằng chứng, không phải đoán.
 */
function summarizeToolResult(result: unknown): string {
  let s: string
  try {
    s = JSON.stringify(result)
  } catch {
    s = String(result)
  }
  if (s.length <= 220) return s
  if (result && typeof result === 'object') {
    const r = result as Record<string, unknown>
    const parts: string[] = []
    if (typeof r.success === 'boolean') parts.push(r.success ? 'PASS' : 'FAIL')
    if (typeof r.errorCount === 'number') parts.push(`${r.errorCount} lỗi`)
    if (typeof r.warningCount === 'number') parts.push(`${r.warningCount} cảnh báo`)
    if (typeof r.totalCount === 'number') parts.push(`tổng ${r.totalCount}`)
    if (r.truncated === true) parts.push('output bị cắt')
    if (r.parseError) parts.push(`parseError: ${String(r.parseError).slice(0, 70)}`)
    if (Array.isArray(r.results) && r.results.length > 0) {
      const first = r.results[0] as Record<string, unknown>
      const file = String(first.file || first.path || '')
      const loc = first.line !== undefined ? `:${first.line}` : ''
      const msg = String(first.message || first.error || first.ruleId || '').slice(0, 90)
      if (file || msg) parts.push(`lỗi đầu: ${file.split('/').pop()}${loc} ${msg}`)
    }
    if (parts.length > 0) {
      const tail = s.length > 400 ? ` …| đuôi: ${s.slice(-80)}` : ''
      return parts.join(' · ') + tail
    }
    if (r.error) return `error: ${String(r.error).slice(0, 150)}`
  }
  return s.slice(0, 130) + '…' + s.slice(-60)
}

// ==================== EVALUATOR ====================

/**
 * Đánh giá độc lập: mục tiêu đạt chưa, dựa trên bằng chứng tool thật.
 * Trả về null nếu LLM fail / JSON không parse được (caller tự heuristic).
 */
async function evaluateCompletion(params: {
  goal: string
  lastAssistantContent: string
  evidence: EvidenceEntry[]
  /** [C] Bằng chứng kiểm định chu kỳ cuối — harness kiểm đếm từ tool call thật */
  verifyEvidence: string[]
  /** [C] Có thao tác sửa SAU lần kiểm định cuối (kết quả sửa chưa được kiểm chứng) */
  unverifiedModifications: boolean
  agentProvider: string
  agentModel: string
  agentId: string
  agentName: string
  abortCheck: () => boolean
}): Promise<EvalVerdict | null> {
  const { goal, lastAssistantContent, evidence, verifyEvidence, unverifiedModifications, agentProvider, agentModel, agentId, agentName, abortCheck } = params

  const evidenceLines = evidence
    .slice(-MAX_EVIDENCE_ENTRIES)
    .map(e => {
      if (e.kind === 'tool') {
        return `[tool] ${e.tool} ${e.success ? '✓' : '✗'}: ${e.text}`
      }
      return `[directive] ${e.text}`
    })
    .join('\n')

  const evidenceBlock = evidenceLines || '(không có tool call nào — agent trả lời thuần)'

  // [C] Khối bằng chứng kiểm định — harness kiểm đếm, agent KHÔNG thể bịa
  const verifyBlock = verifyEvidence.length > 0
    ? verifyEvidence.map(l => `- ${l}`).join('\n')
    : '⚠️ KHÔNG có tool kiểm định nào (run_tests/lint/type_check/test_coverage/file_read/grep) thành công ở chu kỳ cuối — mọi lời tuyên bố "đã kiểm tra/đã test" đều KHÔNG có bằng chứng.'

  const prompt = `MỤC TIÊU CỦA AGENT:
${goal.slice(0, 2000)}

LỜI KẾT LUẬN CUỐI CÙNG CỦA AGENT (chỉ là tuyên bố — cần đối chiếu bằng chứng):
${lastAssistantContent.slice(0, 2500)}

BẰNG CHỨNG KIỂM ĐỊNH CHU KỲ CUỐI (HARNESS kiểm đếm từ tool call thật — agent KHÔNG thể bịa):
${verifyBlock}${unverifiedModifications ? '\n\n⚠️ CÓ THAO TÁC SỬA (file_edit/shell/git...) SAU LẦN KIỂM ĐỊNH CUỐI — kết quả của lần sửa đó CHƯA được kiểm chứng.' : ''}

NHẬT KÝ BẰNG CHỨNG TOOL (theo thứ tự thời gian — đây là sự thật duy nhất đáng tin):
${evidenceBlock}

ĐÁNH GIÁ: mục tiêu đã hoàn thành chưa? Output JSON.`

  try {
    const result = await withTimeout(
      callLLMForAgent(prompt, { provider: agentProvider, model: agentModel }, EVALUATOR_SYSTEM_PROMPT, {
        agentId,
        agentName: `${agentName} (evaluator)`,
        temperature: 0.2,
        maxTokens: 1200,
        abortCheck,
      }),
      LLM_TIMEOUT_MS,
      'Evaluator LLM',
    )
    if (!result || (!result.content && !result.tool_calls)) return null
    if (!result.content) return null
    return parseEvalVerdict(result.content)
  } catch (err) {
    console.warn(`[GoalLoop] Evaluator LLM failed: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}

// ==================== FINAL REPORT (budget-exhaustion wrap-up) ====================

/**
 * [B] Báo cáo cuối HOÀN CHỈNH khi loop dừng mà chưa complete (budget/chu kỳ).
 * Trước đây: trả lastContent đang dở → user report "báo cáo bị cắt ngang ở
 * phần Workflow Engine". Giờ: 1 LLM call tổng kết có cấu trúc (đã làm ·
 * bằng chứng tool · còn thiếu · ĐỀ XUẤT KHẮC PHỤC) — chạy bằng token reserve
 * nên luôn đủ chỗ để viết trọn vẹn.
 */
async function generateFinalReport(params: {
  goal: string
  lastContent: string
  evidence: EvidenceEntry[]
  lastVerdict: EvalVerdict | null
  stopReason: GoalStopReason
  cyclesAttempted: number
  maxCycles: number
  agentProvider: string
  agentModel: string
  agentId: string
  agentName: string
  agentTemperature?: number
  agentMaxTokens?: number
  fullSystemPrompt: string
  abortCheck: () => boolean
  onTokens: (tokens: number) => void
}): Promise<string | null> {
  const {
    goal, lastContent, evidence, lastVerdict, stopReason, cyclesAttempted, maxCycles,
    agentProvider, agentModel, agentId, agentName, agentTemperature, agentMaxTokens,
    fullSystemPrompt, abortCheck, onTokens,
  } = params

  const evidenceLines = evidence
    .slice(-MAX_EVIDENCE_ENTRIES)
    .map(e => (e.kind === 'tool' ? `[tool] ${e.tool} ${e.success ? '✓' : '✗'}: ${e.text}` : `[directive] ${e.text}`))
    .join('\n')

  const verdictBlock = lastVerdict
    ? `complete=${lastVerdict.complete}, verified=${lastVerdict.verified}, confidence=${Math.round(lastVerdict.confidence * 100)}%\nCòn thiếu (theo trọng tài): ${lastVerdict.missing.join('; ') || '(không liệt kê)'}\nVấn đề gốc: ${lastVerdict.rootCause || '(không xác định)'}`
    : '(trọng tài không đánh giá được)'

  const prompt = `MỤC TIÊU GỐC:
${goal.slice(0, 1500)}

THÔNG ĐIỆP CUỐI CỦA AGENT (có thể đang DỞ giữa chừng):
${lastContent.slice(0, 3000)}

NHẬT KÝ BẰNG CHỨNG TOOL THẬT (sự thật duy nhất đáng tin — trích dẫn kết quả cụ thể từ đây):
${evidenceLines.slice(0, 8000)}

ĐÁNH GIÁ CỦA TRỌNG TÀI ĐỘC LẬP:
${verdictBlock}

TÌNH TRẠNG: vòng lặp dừng sau ${cyclesAttempted}/${maxCycles} chu kỳ — lý do: ${stopReason}.

NHIỆM VỤ: viết BÁO CÁO CUỐI trung thực + HOÀN CHỈNH cho người dùng (tiếng Việt), theo đúng 4 phần:
1. **ĐÃ LÀM ĐƯỢC** — từng việc cụ thể, kèm bằng chứng tool (tên tool + kết quả ngắn trích từ nhật ký)
2. **CHƯA HOÀN THÀNH / CÒN THIẾU** — thành thật nêu giới hạn (bị cắt vì budget/chu kỳ), KHÔNG tuyên bố hoàn thành những gì chưa có bằng chứng
3. **NHỮNG GÌ CHƯA KIỂM ĐỊNH ĐƯỢC** — nêu rõ khi công cụ kiểm định fail mà không trích được lỗi cụ thể (không đoán nguyên nhân)
4. **ĐỀ XUẤT KHẮC PHỤC** — các bước cụ thể, khả thi cho lần chạy tiếp theo

QUY TẮC: KHÔNG gọi tool. KHÔNG bắt đầu công việc mới. Chỉ tổng kết từ bằng chứng có sẵn. Báo cáo phải trọn vẹn có kết luận (không bị cắt ngang).`

  try {
    const result = await withTimeout(
      callLLMForAgent(prompt, { provider: agentProvider, model: agentModel }, fullSystemPrompt, {
        agentId,
        agentName: `${agentName} (final-report)`,
        temperature: agentTemperature ?? 0.4,
        maxTokens: Math.max(agentMaxTokens ?? 2048, 4096),
        abortCheck,
      }),
      LLM_TIMEOUT_MS,
      'Final report LLM',
    )
    if (!result?.content) return null
    if (typeof result.tokensUsed === 'number' && result.tokensUsed > 0) onTokens(result.tokensUsed)
    return result.content
  } catch (err) {
    console.warn(`[GoalLoop] Final report LLM failed: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}

// ==================== MAIN LOOP ====================

/**
 * Vòng lặp mục tiêu dài hạn cho agent độc lập.
 *
 * Thay thế runAgentReActLoop cũ: return shape tương thích (content/iterations/
 * toolCallsExecuted/runId) + thêm goalLoop metadata.
 */
export async function runGoalDrivenLoop(params: {
  systemPrompt: string
  userMessage: string
  chatHistory: Array<{ role: string; content: string }>
  agentProvider: string
  agentModel: string
  agentId: string
  agentName: string
  agentTemperature?: number
  agentMaxTokens?: number
  agentTools?: string[]
  agentSessionId?: string | null
}): Promise<GoalLoopResult> {
  const {
    systemPrompt,
    userMessage,
    chatHistory,
    agentProvider,
    agentModel,
    agentId,
    agentName,
    agentTemperature,
    agentMaxTokens,
    agentTools = [],
    agentSessionId = null,
  } = params

  const startedAt = Date.now()
  const fullSystemPrompt = systemPrompt + buildGoalProtocol()

  // ===== Thought Process tracking — 1 run cho toàn bộ goal loop =====
  const runId = startAgentRun({
    sessionId: agentSessionId,
    agentName,
    task: userMessage,
    mode: 'standalone',
  })
  let runEnded = false
  const endRun = (status: 'done' | 'error' | 'cancelled') => {
    if (runEnded) return
    runEnded = true
    endAgentRun(agentSessionId, runId, status, `${totalIterations} vòng · ${totalToolCalls} tool calls · ${cyclesDone} chu kỳ hoàn thành${cyclesAttempted > cyclesDone ? ` (chu kỳ ${cyclesAttempted} dở)` : ''}`)
  }
  const isCancelled = () => isSessionCancelled(agentSessionId)

  // Custom tools registry (agent TỰ VIẾT qua create_custom_tool — dùng ngay được)
  try {
    const { ensureCustomToolsLoaded } = await import('@/lib/custom-tool-registry')
    await ensureCustomToolsLoaded()
  } catch { /* fail-open */ }

  // ===== Conversation state =====
  const messages: GoalMessage[] = [
    { role: 'system', content: fullSystemPrompt },
    ...chatHistory.slice(-6).map(m => ({ role: m.role as 'user' | 'assistant', content: m.content })),
    { role: 'user', content: userMessage },
  ]
  const goalMsgIndex = messages.length - 1

  const evidence: EvidenceEntry[] = []
  // [C] Verify-evidence tracking — harness kiểm đếm tool verify theo thứ tự so với tool sửa
  let lastVerifyOrdinal = 0
  let lastModifyOrdinal = 0
  let cycleVerifyEvidence: string[] = []
  let totalIterations = 0
  let totalToolCalls = 0
  let tokensUsed = 0
  let cyclesDone = 0
  /** Chu kỳ đã BẮT ĐẦU (kể cả đang dở) — dùng cho report/metadata trung thực:
   *  budget cắt giữa chu kỳ 1 → "1 chu kỳ (dở)", không phải 0 hay 1 hoàn thành */
  let cyclesAttempted = 0
  let lastContent = ''
  /** Lỗi LLM gần nhất (result.error) — surface lên báo cáo cuối thay vì nuốt lỗi */
  let lastLlmError = ''
  let lastVerdict: EvalVerdict | null = null
  let stopReason: GoalStopReason = 'max_cycles'
  let prevFingerprint = ''
  let noProgressCount = 0
  /** Chu kỳ trước có bị cắt giữa chừng (hết vòng / hết budget) không */
  let cutMidWorkPrev = false

  const timeLeft = () => TIME_BUDGET_MS - (Date.now() - startedAt)
  const tokenLeft = () => TOKEN_BUDGET - tokensUsed

  console.log(`[GoalLoop] ${agentName} bắt đầu — mục tiêu: "${userMessage.slice(0, 100)}" (max ${MAX_CYCLES} chu kỳ × ${ITER_PER_CYCLE} vòng, budget ${Math.round(TIME_BUDGET_MS / 60000)}' / ${TOKEN_BUDGET} tokens, reserve ${REPORT_RESERVE_TOKENS} tokens cho evaluate + báo cáo cuối)`)

  // ================== OUTER CYCLE LOOP ==================
  outerLoop: for (let cycle = 1; cycle <= MAX_CYCLES; cycle++) {
    if (isCancelled()) { stopReason = 'cancelled'; break }
    if (timeLeft() <= 0) { stopReason = 'time_budget'; break }
    // [A] Không bắt đầu chu kỳ mới nếu chỉ còn token reserve (dành cho final report)
    if (tokenLeft() <= REPORT_RESERVE_TOKENS) { stopReason = 'token_budget'; break }
    cyclesAttempted = cycle

    // Cycle > 1 → inject continuation directive (chẩn đoán + kế hoạch mới)
    if (cycle > 1 && lastVerdict) {
      const directive = buildContinuationDirective(lastVerdict, cycle, cutMidWorkPrev)
      messages.push({ role: 'user', content: directive })
      evidence.push({ cycle, kind: 'directive', text: `Chu kỳ ${cycle}: chẩn đoán "${lastVerdict.rootCause.slice(0, 120)}" → kế hoạch mới` })
      recordAgentThought(agentSessionId, `🔄 Chu kỳ ${cycle}/${MAX_CYCLES} — chẩn đoán: ${lastVerdict.rootCause || '(không rõ)'} → lên kế hoạch lại và khắc phục`, totalIterations)
    }

    // ===== INNER REACT LOOP (EXECUTE + VERIFY theo protocol) =====
    let cycleIterations = 0
    let cycleToolCalls = 0
    cycleVerifyEvidence = [] // [C] bằng chứng kiểm định tính lại mỗi chu kỳ
    let endedBy: 'no_tool_calls' | 'iteration_limit' | 'error' | 'budget' | 'cancelled' = 'no_tool_calls'
    let cycleHadLlmError = false

    while (cycleIterations < ITER_PER_CYCLE) {
      if (isCancelled()) { endedBy = 'cancelled'; break }
      // [A] Reserve token cho evaluate cuối + final report — EXECUTE dừng ở
      // ngưỡng reserve thay vì đợi cạn kiệt về 0 (báo cáo không bị cắt giữa chừng)
      if (timeLeft() <= 0 || tokenLeft() <= REPORT_RESERVE_TOKENS) { endedBy = 'budget'; break }
      cycleIterations++
      totalIterations++

      const formattedPrompt = formatMessagesForLLM(messages)

      let result: Awaited<ReturnType<typeof callLLMForAgent>> | null = null
      try {
        result = await withTimeout(
          callLLMForAgent(formattedPrompt, { provider: agentProvider, model: agentModel }, fullSystemPrompt, {
            agentId,
            agentName,
            temperature: agentTemperature,
            maxTokens: agentMaxTokens,
            abortCheck: isCancelled,
          }),
          LLM_TIMEOUT_MS,
          `Agent LLM (chu kỳ ${cycle})`,
        )
      } catch (llmErr) {
        console.error(`[GoalLoop] ${agentName} LLM error (chu kỳ ${cycle}, vòng ${cycleIterations}): ${llmErr instanceof Error ? llmErr.message : String(llmErr)}`)
        lastLlmError = llmErr instanceof Error ? llmErr.message : String(llmErr)
        cycleHadLlmError = true
        endedBy = 'error'
        break
      }

      if (isCancelled()) { endedBy = 'cancelled'; break }
      if (!result || (result.error && !result.content)) {
        lastLlmError = result?.error || 'LLM call failed'
        cycleHadLlmError = true
        endedBy = 'error'
        break
      }

      if (typeof result.tokensUsed === 'number' && result.tokensUsed > 0) {
        tokensUsed += result.tokensUsed
      }

      lastContent = result.content
      recordAgentThought(agentSessionId, result.content, totalIterations)

      const toolCalls = parseToolCallsFromOutput(result.content)
      if (toolCalls.length === 0) {
        // Agent tự kết luận (protocol yêu cầu đã verify + báo cáo ở đây)
        endedBy = 'no_tool_calls'
        break
      }

      console.log(`[GoalLoop] ${agentName} chu kỳ ${cycle} vòng ${cycleIterations}: ${toolCalls.length} tool calls`)
      messages.push({ role: 'assistant', content: result.content })

      for (const tc of toolCalls) {
        if (isCancelled()) break
        totalToolCalls++
        cycleToolCalls++

        // Permission: whitelist của agent + custom tools (agent TỰ VIẾT luôn được dùng)
        let isCustomTool = false
        try {
          const { isCustomToolRegistered } = await import('@/lib/custom-tool-registry')
          isCustomTool = isCustomToolRegistered(tc.name)
        } catch { /* fail-open */ }
        if (agentTools.length > 0 && !agentTools.includes(tc.name) && !isCustomTool) {
          pushToolMessage(messages, { tool: tc.name, success: false, result: `Tool "${tc.name}" not available for this agent. Available: ${agentTools.join(', ')}` })
          evidence.push({ cycle, kind: 'tool', tool: tc.name, success: false, text: `bị từ chối (không có quyền)` })
          continue
        }

        // todo_write → inject sessionId (todos theo phiên chat, không đổ dồn "default")
        const toolArgs: Record<string, unknown> = { ...tc.args }
        if (tc.name === 'todo_write' && agentSessionId && !toolArgs.sessionId) {
          toolArgs.sessionId = agentSessionId
        }

        const toolResult = await executeTool(tc.name, toolArgs, { agentName, sessionId: agentSessionId })

        // ===== WORKING MEMORY (HOT) — ghi nhận tool đã chạy + kết quả =====
        // Các request sau trong session thấy entry này qua digest HOT trong
        // system prompt → không lặp lại tool đã chạy (tiết kiệm token + time)
        // [D] Preview thông minh (errorCount + lỗi cụ thể) thay vì cắt 200 ký tự đầu
        const resultPreview = summarizeToolResult(toolResult.result).slice(0, 250)

        // [C] Harness kiểm đếm bằng chứng kiểm định theo thứ tự thời gian.
        // LƯU Ý: lint/type_check FAIL (có errorCount) VẪN LÀ bằng chứng kiểm định
        // hợp lệ — agent thấy được số lỗi cụ thể. Chỉ tool không chạy được
        // (permission disabled / exception → result là string) mới không tính.
        const isStructuredResult = toolResult.result !== null && typeof toolResult.result === 'object'
        if ((VERIFY_TOOLS.has(tc.name) || READBACK_TOOLS.has(tc.name)) && isStructuredResult) {
          lastVerifyOrdinal = totalToolCalls
          cycleVerifyEvidence.push(`${tc.name}: ${resultPreview}`)
        }
        // shell/run_bg fail vẫn CÓ THỂ đã sửa file (side effect) → tính modify
        // regardless of success; tool sửa file chỉ tính khi thành công.
        if (MODIFY_TOOLS.has(tc.name) && (toolResult.success || tc.name === 'shell' || tc.name === 'run_bg')) {
          lastModifyOrdinal = totalToolCalls
        }
        recordWorkMemory(
          agentId,
          agentSessionId,
          `🔧 ${tc.name}(${compactToolArgs(tc.args)}) → ${toolResult.success ? '✓' : '✗'} ${resultPreview}`,
        )

        evidence.push({ cycle, kind: 'tool', tool: tc.name, success: toolResult.success, text: resultPreview })

        pushToolMessage(messages, { tool: tc.name, success: toolResult.success, result: toolResult.result })
      }

      if (isCancelled()) { endedBy = 'cancelled'; break }
      if (timeLeft() <= 0 || tokenLeft() <= REPORT_RESERVE_TOKENS) { endedBy = 'budget'; break }

      if (cycleIterations >= ITER_PER_CYCLE) {
        endedBy = 'iteration_limit'
      }
    }

    cutMidWorkPrev = endedBy === 'iteration_limit' || endedBy === 'budget'

    if (endedBy === 'cancelled') { stopReason = 'cancelled'; break }
    // [A]+[B] Budget cạn giữa chu kỳ: KHÔNG break ngay — vẫn chạy evaluator
    // (dùng reserve) để có chẩn đoán chính xác cho final report, rồi mới dừng.
    let budgetStop = false
    if (endedBy === 'budget') {
      budgetStop = true
      stopReason = timeLeft() <= 0 ? 'time_budget' : 'token_budget'
    }
    if (endedBy === 'error') {
      // LLM hỏng hoàn toàn ở chu kỳ đầu + chưa có nội dung gì → trả lỗi
      if (cyclesDone === 0 && !lastContent) {
        stopReason = 'error'
        break
      }
      // Có nội dung từ trước → vẫn đánh giá tiếp (work đã làm có thể đã đạt)
    }

    if (!budgetStop) cyclesDone = cycle // chu kỳ bị budget cắt giữa chừng không tính là hoàn thành

    // ===== Context hygiene giữa các chu kỳ =====
    if (messages.length > MAX_MESSAGES) {
      const tail = messages.slice(-(MAX_MESSAGES - 2))
      messages.splice(goalMsgIndex + 1, messages.length - goalMsgIndex - 1, ...tail)
      console.log(`[GoalLoop] ${agentName} trim context về ${messages.length} messages (giữ system + goal + ${MAX_MESSAGES - 2} gần nhất)`)
    }

    // ===== EVALUATE — trọng tài độc lập =====
    console.log(`[GoalLoop] ${agentName} chu kỳ ${cycle} kết thúc (${endedBy}, ${cycleToolCalls} tool calls) — gọi evaluator`)
    let verdict = await evaluateCompletion({
      goal: userMessage,
      lastAssistantContent: lastContent,
      evidence,
      verifyEvidence: cycleVerifyEvidence,
      unverifiedModifications: lastModifyOrdinal > lastVerifyOrdinal,
      agentProvider,
      agentModel,
      agentId,
      agentName,
      abortCheck: isCancelled,
    })

    if (isCancelled()) { stopReason = 'cancelled'; break }

    // Evaluator fail / parse fail → heuristic an toàn:
    //  - chu kỳ KHÔNG có tool call nào (Q&A thuần) → coi như hoàn thành
    //  - có tool call nhưng không đánh giá được → chưa hoàn thành (đánh giá lại chu kỳ sau)
    if (!verdict) {
      if (cycleToolCalls === 0) {
        verdict = { complete: true, confidence: 0.6, verified: false, missing: [], rootCause: '', nextPlan: [], raw: '(evaluator unavailable — pure answer accepted)' }
      } else {
        verdict = { complete: false, confidence: 0.5, verified: false, missing: ['(không đánh giá được — tự rà soát)'], rootCause: '(evaluator LLM lỗi — kiểm tra lại toàn bộ kết quả)', nextPlan: [], raw: '' }
      }
    }

    // [C] VERIFY GUARD — harness override: evaluator kết luận "hoàn thành"
    // nhưng có thao tác SỬA (file/shell/git) sau lần kiểm định cuối mà chưa
    // verify lại → hạ xuống chưa đạt (evaluator có thể sót — harness thì không)
    if (verdict.complete && lastModifyOrdinal > lastVerifyOrdinal) {
      verdict = {
        ...verdict,
        complete: false,
        verified: false,
        rootCause: `Có thao tác sửa (file/shell/git) SAU lần kiểm định cuối (harness kiểm đếm: sửa ở tool-call #${lastModifyOrdinal}, kiểm định cuối ở tool-call #${lastVerifyOrdinal}) — kết quả cuối chưa được kiểm chứng bằng tool.`,
        missing: Array.from(new Set([
          ...verdict.missing,
          'Kiểm định lại kết quả cuối cùng bằng tool (file_read đọc lại / run_tests / lint / type_check) và trích dẫn kết quả cụ thể',
        ])).slice(0, 6),
      }
      recordAgentThought(agentSessionId, `🛡 Harness verify-guard: hạ "hoàn thành" → "chưa đạt" — có sửa sau lần kiểm định cuối mà chưa kiểm định lại`, totalIterations)
    }

    lastVerdict = verdict
    recordAgentThought(
      agentSessionId,
      verdict.complete
        ? `⚖️ Đánh giá chu kỳ ${cycle}: HOÀN THÀNH (tin cậy ${Math.round(verdict.confidence * 100)}%${verdict.verified ? ', đã có bằng chứng kiểm định' : ''})`
        : `⚖️ Đánh giá chu kỳ ${cycle}: CHƯA ĐẠT (tin cậy ${Math.round(verdict.confidence * 100)}%) — còn thiếu: ${verdict.missing.join('; ').slice(0, 200) || '(không liệt kê)'}`,
      totalIterations,
    )

    if (verdict.complete) {
      stopReason = 'complete'
      break outerLoop
    }

    // [A] Budget cạn (đã evaluate xong) → dừng; final report sẽ dùng reserve
    if (budgetStop) break

    // ===== No-progress detection =====
    const fp = progressFingerprint(messages)
    if (cycle > 1 && fp === prevFingerprint) {
      noProgressCount++
      console.warn(`[GoalLoop] ${agentName} NO-PROGRESS: fingerprint chu kỳ ${cycle} trùng chu kỳ trước (lần ${noProgressCount})`)
      if (noProgressCount >= 1) {
        stopReason = 'no_progress'
        break
      }
    } else {
      noProgressCount = 0
    }
    prevFingerprint = fp

    // Budget check sau evaluation (đã tốn thêm 1 call)
    if (timeLeft() <= 0) { stopReason = 'time_budget'; break }
    if (tokenLeft() <= REPORT_RESERVE_TOKENS) { stopReason = 'token_budget'; break }

    // Chu kỳ kế tiếp: evaluator đã chẩn đoán + kế hoạch → continuation directive
  }

  // ================== FINAL REPORT ==================

  let content = ''
  /** [B] Final report tổng hợp được dùng thay lastContent dở? */
  let usedFinalReport = false
  if (stopReason === 'cancelled') {
    content = '⏹ Đã dừng tác vụ theo yêu cầu của bạn.'
  } else if (stopReason === 'error') {
    // Surface lỗi LLM gốc (vd: NVIDIA cạn key) — không nuốt lỗi
    content = `Error: Goal loop LLM failed — ${lastLlmError || lastContent || 'không có nội dung trả về'}`
  } else {
    content = lastContent || '(agent không trả về nội dung)'
    // [B] FINAL REPORT CALL — dừng giữa chừng (budget/max_cycles/no_progress)
    // mà chưa complete: tổng hợp 1 báo cáo HOÀN CHỈNH từ bằng chứng đã thu
    // (đã làm · bằng chứng tool · còn thiếu · ĐỀ XUẤT KHẮC PHỤC) thay vì trả
    // lastContent đang dở. Dùng token reserve → không bao giờ bị cắt ngang.
    if (stopReason !== 'complete' && lastContent) {
      const wrapUp = await generateFinalReport({
        goal: userMessage,
        lastContent,
        evidence,
        lastVerdict,
        stopReason,
        cyclesAttempted,
        maxCycles: MAX_CYCLES,
        agentProvider,
        agentModel,
        agentId,
        agentName,
        agentTemperature,
        agentMaxTokens,
        fullSystemPrompt,
        abortCheck: isCancelled,
        onTokens: (t) => { tokensUsed += t },
      })
      if (wrapUp && wrapUp.length > 200) {
        content = wrapUp
        usedFinalReport = true
        recordAgentThought(agentSessionId, '📝 Budget/chu kỳ cạn — đã tổng hợp BÁO CÁO CUỐI hoàn chỉnh (bằng chứng + còn thiếu + đề xuất khắc phục)', totalIterations)
      }
    }
    if (stopReason !== 'complete') {
      const reasonText: Record<string, string> = {
        max_cycles: `đã hết ${MAX_CYCLES} chu kỳ làm việc`,
        time_budget: `hết budget thời gian (${Math.round(TIME_BUDGET_MS / 60000)} phút)${cyclesAttempted > cyclesDone ? ' — đang dở giữa chu kỳ ' + cyclesAttempted : ''}`,
        token_budget: `hết budget token (${TOKEN_BUDGET} — có thể tăng qua env GOAL_LOOP_TOKEN_BUDGET)`,
        no_progress: 'phát hiện lặp lại hành động không tiến triển',
        error: 'lỗi LLM',
      }
      if (usedFinalReport) {
        // Báo cáo tổng hợp đã có "còn thiếu" + "đề xuất" — chỉ append dòng trạng thái
        content += `\n\n---\n⚠️ **Vòng lặp mục tiêu dừng sau ${cyclesAttempted}/${MAX_CYCLES} chu kỳ** — ${reasonText[stopReason] || stopReason}. Bạn có thể yêu cầu tiếp tục để tôi khắc phục phần còn thiếu.`
      } else {
        const missing = lastVerdict?.missing?.length ? lastVerdict.missing.map(m => `- ${m}`).join('\n') : '(chưa đánh giá được chi tiết — xem tiến trình ở trên)'
        const rootCause = lastVerdict?.rootCause ? `\n🔍 **Vấn đề xác định:** ${lastVerdict.rootCause}` : ''
        content += `\n\n---\n⚠️ **Vòng lặp mục tiêu dừng sau ${cyclesAttempted}/${MAX_CYCLES} chu kỳ — chưa hoàn thành trọn vẹn** (${reasonText[stopReason] || stopReason}).\n❌ **Còn thiếu:**\n${missing}${rootCause}\n\nBạn có thể yêu cầu tiếp tục để tôi khắc phục phần còn thiếu.`
      }
    }
  }

  const elapsedMs = Date.now() - startedAt
  console.log(`[GoalLoop] ${agentName} kết thúc: ${stopReason} — ${cyclesAttempted} chu kỳ (${cyclesDone} hoàn thành), ${totalIterations} vòng, ${totalToolCalls} tool calls, ${tokensUsed} tokens, ${Math.round(elapsedMs / 1000)}s${usedFinalReport ? ' + final-report' : ''}`)

  // ===== WORKING MEMORY (HOT) — báo cáo kết thúc mục tiêu =====
  // Entry tóm tắt "đã làm gì, kết quả thế nào" — quan trọng nhất cho việc
  // agent tự biết việc gì đã xong khi user hỏi tiếp / mở session mới trong TTL
  recordWorkMemory(
    agentId,
    agentSessionId,
    `🏁 Mục tiêu "${userMessage.slice(0, 150)}" — ${stopReason === 'complete' ? 'HOÀN THÀNH' : `dừng (${stopReason})`} sau ${totalIterations} vòng, ${totalToolCalls} tool calls, ${Math.round(elapsedMs / 1000)}s. ${lastContent ? `Kết luận: ${lastContent.slice(0, 200)}` : ''}`,
    0.85,
  )

  endRun(stopReason === 'error' ? 'error' : stopReason === 'cancelled' ? 'cancelled' : 'done')

  return {
    content,
    iterations: totalIterations,
    toolCallsExecuted: totalToolCalls,
    runId,
    goalLoop: {
      cycles: cyclesAttempted,
      complete: stopReason === 'complete',
      stopReason,
      evaluatorConfidence: lastVerdict?.confidence,
      missing: lastVerdict?.missing,
      /** [B] final-report tổng hợp được dùng (báo cáo hoàn chỉnh khi budget cạn) */
      finalReport: usedFinalReport || undefined,
      /** Token đã tiêu thụ — frontend/UI có thể hiển thị so với budget */
      tokensUsed,
    },
  }
}
