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
import { parseToolCallsFromOutput, formatMessagesForLLM, detectBrokenToolCallHint } from '@/lib/tool-calls'
import { findBalancedJson } from '@/lib/code-team/find-balanced-json'
import {
  startAgentRun,
  endAgentRun,
  recordAgentThought,
  recordAgentRunTodos,
  isSessionCancelled,
} from '@/lib/agent-run-tracker'
// CI-2 (Task 11-a) — auto-complete todo theo bằng chứng tool giữa chừng run
// (helper DB-backed trong TODO section của dev-tools — không đụng git section)
import { autoCompleteRunTodosByEvidence } from '@/lib/code-team/dev-tools'
// Task 20-c (self-evaluation) — persist lifecycle AgentRunRecord (start row +
// end update, dedup với tracker qua dbPersistBy:'caller') + ArbiterVerdict mỗi
// chu kỳ EVALUATE + resolve outcome khi run kết thúc. Mọi write fire-and-forget
// fail-open qua raw-SQL bridge (metrics-db) — không được phép làm hỏng loop.
import {
  insertAgentRunRecord,
  insertAgentRunRecordRunning,
  updateLatestAgentRunRecord,
  insertArbiterVerdict,
  resolveArbiterVerdicts,
} from '@/lib/metrics-db'
// WORKING MEMORY (HOT) — user request 2026-08-28: ghi nhận quá trình làm việc
// (tool đã chạy, kết quả ra sao) vào WorkingMemory để (a) request sau trong cùng
// session KHÔNG phải đọc/làm lại — tiết kiệm token, (b) hết phiên promote lên
// WARM (AgentMemory) qua runTierTransitions → ghi nhớ dài hạn về công việc đã làm.
import { addToWorkingMemory } from '@/lib/memory-tiers'
// CI-3 B1 (Task 13-a) — nén context tách thành module dùng chung (workflow-engine
// tái dùng cùng pattern); constants + digest prompt + compressConversation gốc
// của goal-loop chuyển sang đây, hành vi giữ nguyên như đã verify GĐ1/GĐ2.
import {
  COMPRESS_THRESHOLD_CHARS,
  KEEP_RECENT_MESSAGES,
  TOOL_RESULT_MAX_CHARS,
  compressConversation,
} from '@/lib/context-compression'
// CI-3 B4 (Task 13-c) — Kho Context "đọc lại khi cần" (Task 13-b): cuối mỗi
// run lưu task_summary (kind='task_summary') vào TaskContextArchive; run mới
// trong cùng session nạp lại các summary này TRƯỚC 6 message cuối thô —
// liên tác vụ: tác vụ sau có bức tranh dài hạn (mục tiêu đạt/không, việc đã
// làm, kết quả chính) của các tác vụ trước. Không circular import
// (context-store chỉ phụ thuộc db/qdrant/embeddings).
import { archiveContext, recallContext } from '@/lib/context-store'
// CI-3 B7 (Task 13-e) — system prompt TỔNG có budget ký tự: base từ chat route
// (chỉ skills 16k/HOT 2k có cap riêng) + protocol của loop ghép lại vượt
// SYSTEM_PROMPT_BUDGET_CHARS (mặc định 24k) → cắt block priority thấp nhất
// giữ đầu. Tổng < budget → prompt GIỮ NGUYÊN 100%.
import { budgetPrompt } from '@/lib/prompt-budget'
// CI-5 (Task 14-b) — DURABLE GOAL LOOP: contract types dùng chung với worker
// nền (14-a, goal-loop-worker.ts) — TYPE-ONLY import (erased lúc build, 0
// runtime dependency, không circular). Khi `durable` KHÔNG được truyền vào
// runGoalDrivenLoop → mọi hooks inert → hành vi inline cũ GIỮ NGUYÊN 100%
// (đường chat route + tests hiện có không hề hay biết hooks tồn tại).
import type { GoalLoopCheckpoint, GoalLoopDurableHooks } from '@/lib/goal-loop-durable-types'

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

/**
 * CI-2 (Task 11-a) — Trích "bằng chứng" từ args của 1 tool call THÀNH CÔNG để
 * khớp với nội dung todo (auto-complete theo bằng chứng, không tin lời tuyên bố):
 *   - shell/run_bg → lệnh shell (≥6 ký tự, trim)
 *   - tool file_*  → đường dẫn file chính (args.path theo quy ước dev-tools;
 *                    chỉ nhận chuỗi chứa '/' hoặc '.' — chống khớp giả)
 * Trả null nếu không có bằng chứng hợp lệ. Bảo thủ chủ đích: chỉ chuỗi-con
 * CHÍNH XÁC mới được tính (xem autoCompleteRunTodosByEvidence trong dev-tools).
 */
/**
 * FIX review GĐ2 #1 (MEDIUM): evidence auto-complete chỉ tính tool THAY ĐỔI
 * thật — file_read/liệt kê (read-only) KHÔNG đánh dấu todo hoàn thành (đọc
 * xong chưa nghĩa là làm xong; trước đây mọi tool có args.path đều tính).
 */
const TODO_EVIDENCE_MODIFY_TOOLS = new Set([
  'file_edit', 'file_multi_edit', 'file_write', 'file_delete', 'opencode',
])
function extractTodoEvidence(toolName: string, args: Record<string, unknown> | undefined): string | null {
  try {
    if (!args || typeof args !== 'object') return null
    if (toolName === 'shell' || toolName === 'run_bg') {
      const cmd = (args as { command?: unknown }).command
      if (typeof cmd === 'string' && cmd.trim().length >= 6) return cmd.trim()
      return null
    }
    if (!TODO_EVIDENCE_MODIFY_TOOLS.has(toolName)) return null
    const p = (args as { path?: unknown }).path ?? (args as { file_path?: unknown }).file_path
    if (typeof p === 'string' && p.length >= 3 && (p.includes('/') || p.includes('.'))) return p
    return null
  } catch {
    return null
  }
}

// ==================== CONFIG (env override) ====================

/**
 * Parse int từ env — CHẤP NHẬN 0 HỢP LỆ (CI-1 "0 = UNLIMITED": budget caps
 * đặt 0 nghĩa là KHÔNG GIỚI HẠN). Env không set / rỗng / không phải số hữu
 * hạn / âm → fallback.
 * (Fix falsy-bug: bản cũ check `v > 0` → env "0" bị nuốt thành fallback,
 * khiến chế độ unlimited không bao giờ bật được từ env.)
 */
function intEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') return fallback
  const v = Number(raw)
  return Number.isFinite(v) && v >= 0 ? Math.floor(v) : fallback
}

/**
 * Biến thể CHỈ NHẬN số dương (giữ nguyên ngữ nghĩa intEnv cũ) — cho các cap
 * mà 0 là vô nghĩa/nguy hiểm: timeout 0ms giết mọi LLM call ngay lập tức,
 * ngưỡng nén 0 = nén mỗi vòng... KHÔNG áp "0 = unlimited" cho các hằng này.
 */
function intEnvPositive(name: string, fallback: number): number {
  const v = Number(process.env[name])
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback
}

/** CI-1 (0 = UNLIMITED) — hiển thị cap dạng "∞" khi = 0 (progress display +
 *  báo cáo cuối). Dùng cho mọi chỗ format `X/Y chu kỳ`, `max N vòng`... */
const fmtCap = (n: number): string => (n === 0 ? '∞' : String(n))

/** Số chu kỳ PLAN→EXECUTE→VERIFY→EVALUATE tối đa (mặc định 4; 0 = ∞ — CI-1) */
const MAX_CYCLES = intEnv('GOAL_LOOP_MAX_CYCLES', 4)
/** Số vòng ReAct tối đa MỖI chu kỳ (mặc định 10 → tổng tối đa 40 vòng; 0 = ∞ — CI-1) */
const ITER_PER_CYCLE = intEnv('GOAL_LOOP_ITERATIONS_PER_CYCLE', 10)
/** Budget thời gian toàn bộ loop (mặc định 30 phút — tác vụ dài hạn; align với
 *  client display safeguard 30' — E2E Test B cho thấy kimi-k3 ~100s/call nên
 *  12' cũ quá ngắn: agent đang tiến triển tốt vẫn bị cắt giữa chừng;
 *  0 = ∞ — CI-1 "0 = UNLIMITED") */
const TIME_BUDGET_MS = intEnv('GOAL_LOOP_TIME_BUDGET_MS', 30 * 60_000)
/** Budget token toàn bộ loop (mặc định 200k — đủ ~40 vòng context lớn;
 *  0 = ∞ KHÔNG giới hạn — CI-1 "0 = UNLIMITED") */
const TOKEN_BUDGET = intEnv('GOAL_LOOP_TOKEN_BUDGET', 200_000)
/**
 * [A] REPORT RESERVE — phần token dự trữ KHÔNG cho EXECUTE dùng. Dành riêng cho
 * evaluator chu kỳ cuối + FINAL REPORT call → khi budget cạn, loop vẫn đủ token
 * tổng kết báo cáo HOÀN CHỈNH thay vì cắt ngang giữa chừng.
 * (user report 2026-09-07: "báo cáo bị cắt ngang ở phần Workflow Engine")
 * CI-1: TOKEN_BUDGET = 0 (unlimited) → reserve bắt buộc 0, nếu không các
 * điểm check `tokenLeft() <= reserve` sẽ so với ngưỡng ÂM và cắt loop
 * ngay lập tức — trái ý "không giới hạn".
 */
const REPORT_RESERVE_TOKENS = TOKEN_BUDGET === 0
  ? 0
  : intEnv('GOAL_LOOP_REPORT_RESERVE_TOKENS', Math.max(15_000, Math.floor(TOKEN_BUDGET * 0.1)))
/**
 * Timeout 1 LLM call. Mặc định 21 phút > KEY_ROTATION_BUDGET_MS (15') của
 * callLLMForAgent — E2E Test C/live-UI cho thấy khi NVIDIA rate-limit nặng,
 * 1 callLLMForAgent hợp lệ cần 12 attempts + nhiều cooldown 30s (vượt xa 240s
 * cũ — timeout ngoài giết chuỗi xoay vòng key giữa chừng, biến "retry kiên
 * trì" thành "error"). Timeout giờ chỉ là lưới an toàn chống call treo vĩnh
 * viễn; bound thật của loop = TIME_BUDGET_MS (30') + TOKEN_BUDGET + user cancel
 * (abortCheck xuyên suốt mọi vòng đợi cooldown).
 */
const LLM_TIMEOUT_MS = intEnvPositive('GOAL_LOOP_LLM_TIMEOUT_MS', 21 * 60_000)
/** Cap ký tự của tool result khi đẩy vào messages (chống context nén) — CI-3 B1: nguồn duy nhất từ module dùng chung */
const MAX_TOOL_RESULT_CHARS = TOOL_RESULT_MAX_CHARS
/** Cap số messages giữa các chu kỳ (trim giữ system + goal + đuôi gần nhất) */
const MAX_MESSAGES = 48
/** Cap số dòng evidence log giữ lại cho evaluator */
const MAX_EVIDENCE_ENTRIES = 60
/** [C] Tool kiểm định — bằng chứng verify chỉ tính khi tool THÀNH CÔNG */
const VERIFY_TOOLS = new Set(['run_tests', 'lint', 'type_check', 'test_coverage', 'get_diagnostics', 'lsp_diagnostics'])
/** [C] Đọc lại kết quả (file_read/grep sau khi sửa) cũng là kiểm định */
const READBACK_TOOLS = new Set(['file_read', 'grep'])
/** [C] Tool sửa đổi — sau những tool này PHẢI có kiểm định lại trước khi kết luận */
const MODIFY_TOOLS = new Set(['file_edit', 'file_multi_edit', 'file_write', 'file_delete', 'mkdir', 'shell', 'run_bg', 'git_commit', 'delegate_task', 'dispatch_agent'])
/** [D] Tool verify được cap context lớn hơn (cần thấy đủ kết quả test/lint/tsc) */
const VERIFY_RESULT_CHARS = 6000
/**
 * [E] CONTEXT COMPRESSION (user request 2026-09-08: "lượng dữ liệu phải đọc có
 * thể nhiều nhưng có cần nhớ toàn bộ không hay có thể tóm tắt... tổng hợp lại
 * rồi tiến hành tóm tắt thành nội dung đủ để hiểu và triển khai")
 *
 * CI-3 B1 (Task 13-a): constants (COMPRESS_THRESHOLD_CHARS / KEEP_RECENT_MESSAGES /
 * DIGEST_MAX_CHARS / COMPRESS_INPUT_CHARS / MIN_COMPRESSIBLE_MESSAGES),
 * buildDigestPrompt và compressConversation đã tách sang module dùng chung
 * `@/lib/context-compression` (workflow-engine tái dùng cùng pattern — roadmap
 * CI-3 "Lỗ hổng 1"). Digest vẫn được ghi vào WorkingMemory (HOT) ngay sau khi nén
 * — request sau trong session đọc lại được ngay (đúng ý user: "tóm tắt và phần
 * bộ nhớ này và đọc lại").
 */

/**
 * CI-1 "0 = UNLIMITED" — budget HIỆN TẠI của goal-loop (pure function, không
 * side-effect). Metrics API/UI dùng để hiển thị "∞" khi `unlimited: true`
 * thay vì so tokensUsed với budget. Từng cap = 0 → không giới hạn cap đó.
 */
export function getGoalLoopBudgetInfo(): {
  tokenBudget: number
  timeBudgetMs: number
  maxCycles: number
  iterationsPerCycle: number
  reportReserveTokens: number
  unlimited: boolean
  /** FIX review #14: unlimited chi tiết theo từng cap — UI/metrics hiển thị chính xác cap nào đang ∞ */
  unlimitedToken: boolean
  unlimitedTime: boolean
  unlimitedCycles: boolean
  unlimitedIterations: boolean
} {
  return {
    tokenBudget: TOKEN_BUDGET,
    timeBudgetMs: TIME_BUDGET_MS,
    maxCycles: MAX_CYCLES,
    iterationsPerCycle: ITER_PER_CYCLE,
    reportReserveTokens: REPORT_RESERVE_TOKENS,
    unlimited: TOKEN_BUDGET === 0,
    unlimitedToken: TOKEN_BUDGET === 0,
    unlimitedTime: TIME_BUDGET_MS === 0,
    unlimitedCycles: MAX_CYCLES === 0,
    unlimitedIterations: ITER_PER_CYCLE === 0,
  }
}

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
  /**
   * CI-3 B4 (Task 13-c) — task_summary cuối run (~500 chars, distill
   * deterministic từ final report/verdict — 0 LLM call thêm). Chat route
   * persist vào ChatMessage.metadata.taskSummary (merge, không đè field cũ).
   */
  taskSummary?: string
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
    /** [E] Số lần nén context (rolling digest) đã thực hiện trong loop */
    compressions?: number
    /** [F] Số lần delegate cho sub-agent (Code Team) + token sub-agent tiêu thụ */
    delegations?: number
    subagentTokens?: number
    /** [G] Số lần auto-escalate hỏi Omega orchestrator (nhận diện bế tắc sớm) */
    escalations?: number
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
- TẠO FILE MỚI / FILE LỚN: dùng file_write — viết từng phần (~200-400 dòng/lần), lần đầu mode "overwrite", các lần sau mode "append" (đừng nhét cả file 1000+ dòng vào 1 tool call — output dễ bị cắt giữa JSON → tool call KHÔNG thực thi được).

GIAI ĐOẠN 3 — KIỂM ĐỊNH & BÁO CÁO (BẮT BUỘC trước khi kết luận):
- Với tác vụ tạo/sửa file, code, lệnh, dữ liệu: PHẢI kiểm định bằng tool thật — file_read đọc lại kết quả, run_tests / lint / type_check, shell kiểm tra output. Bằng chứng phải nằm trong KẾT QUẢ TOOL.
- Khi type_check/lint/run_tests FAIL: đọc errorCount + thông báo lỗi cụ thể từng file trong KẾT QUẢ TOOL — KHÔNG đoán nguyên nhân; nếu output không đủ để xác định lỗi cụ thể thì báo rõ "không xác định được nguyên nhân cụ thể". Tool fail KHÔNG đồng nghĩa "đã kiểm định".
- CHỈ được kết luận hoàn thành khi bằng chứng kiểm định thực sự KHỚP mục tiêu.
- Kết thúc chu kỳ bằng báo cáo đủ 4 phần: đã làm gì · bằng chứng tool (tên tool + kết quả ngắn) · còn thiếu gì · đề xuất khắc phục.

⚠️ Một TRỌNG TÀI ĐỘC LẬP sẽ đánh giá lại kết quả của bạn DỰA TRÊN BẰNG CHỨNG TOOL THẬT. Lời tuyên bố không có bằng chứng sẽ BỊ TỪ CHỐI và bạn phải làm lại ở chu kỳ tiếp theo.
Nếu mục tiêu là câu hỏi/thông tin (không cần hành động), chỉ cần trả lời đầy đủ, chính xác — không cần tool.`
}

/**
 * [F] SUB-AGENT DELEGATION protocol — chỉ append khi agent CÓ delegate_task
 * trong tool whitelist (vd Omega). Hướng dẫn khi nào chia việc cho Code Team
 * + kỷ luật kiểm định lại kết quả sub-agent (verify-guard vẫn áp vì
 * delegate_task nằm trong MODIFY_TOOLS).
 */
function buildDelegationProtocol(): string {
  return `

📦 PHÂN CÔNG SUB-AGENT (delegate_task — Code Team chuyên trách):
- BOLT: implement code · SENTINEL: review/bug/security · CATALYST: tối ưu/refactor · CORTEX: thiết kế kiến trúc/DB/API · APEX: phân tích + verify tổng thể.
- Cú pháp: tool_call: delegate_task({"agent": "BOLT", "task": "Nhiệm vụ cụ thể...", "context": "file liên quan, ràng buộc..."})
- NÊN delegate khi: task cần đọc/sửa NHIỀU file (làm trực tiếp sẽ phình context của bạn), cần chuyên môn sâu, hoặc task giao trọn được cho 1 agent.
- KHÔNG delegate việc 1-2 bước đơn giản — tự làm nhanh hơn.
- Báo cáo sub-agent quay về dạng NÉN (đã làm · bằng chứng · còn thiếu) — ĐỌC kỹ "còn thiếu". Với kết quả QUAN TRỌNG, tự KIỂM ĐỊNH LẠI bằng tool của bạn (file_read/lint/type_check) trước khi kết luận.
- Token sub-agent tiêu thụ cộng vào budget của bạn — scope task rõ ràng, không delegate task mờ hồ to đùng.`
}

/**
 * [G] OMEGA ORCHESTRATION protocol (user request 2026-09-08) — chỉ append khi
 * agent CÓ tool phối hợp (escalate_problem / dispatch_agent / create_agent).
 * Agent bất kỳ gặp vấn đề (hoặc nhận diện rủi ro sớm) escalate về Omega —
 * orchestrator phân tích + đề xuất giải pháp tốt nhất.
 */
function buildOrchestrationProtocol(hasDispatch: boolean, hasCreate: boolean): string {
  const lines: string[] = []
  lines.push('')
  lines.push('🧠 PHỐI HỢP MULTI-AGENT (Omega orchestrator):')
  lines.push('- Gặp vấn đề / kẹt / lặp lỗi: tool_call: escalate_problem({"problem": "vấn đề cụ thể", "context": "...", "attempted": "đã thử gì", "severity": "low|medium|high"}) → OMEGA phân tích căn nguyên + cân nhắc các phương án → trả TƯ VẤN TỐT NHẤT (có thể kèm: agent nào nên xử lý, agent mới cần tạo).')
  lines.push('- NHẬN DIỆN SỚM (quan trọng): tool fail 2 lần cùng lỗi / cùng hành động lặp lại / task cần chuyên môn ngoài vòng của bạn (đối chiếu Agent Roster) → escalate NGAY khi có dấu hiệu đầu tiên, đừng chờ kẹt hẳn. Vấn đề được giải từ trước rẻ hơn chữa sau.')
  lines.push('- Escalate xong: LÀM THEO tư vấn của Omega (đổi cách tiếp cận / điều agent khác / dùng tool theo hướng dẫn mới) — không lặp lại cách cũ đã fail.')
  if (hasDispatch) {
    lines.push('- Điều động agent BẤT KỲ trong Agent Roster: tool_call: dispatch_agent({"agent": "TÊN", "task": "nhiệm vụ cụ thể", "context": "..."}) — agent chạy tự chủ, trả báo cáo nén (context của bạn không phình). Điều LÂU DÀI vào team: thêm {"duration": "long_term", "team": "code", "position": "G4"}.')
  }
  if (hasCreate) {
    lines.push('- Hệ thống THIẾU agent có kỹ năng phù hợp (đã kiểm tra Agent Roster): tool_call: create_agent({"name": "...", "description": "mô tả vai trò", "instruction": "system prompt chi tiết", "model": "moonshotai/kimi-k3", "avatar": "🤖", "temperature": 0.7, "maxTokens": 4096, "tools": ["file_read", "..."]}) — agent mới hiện trong module Agents, giao việc NGAY qua dispatch_agent.')
  }
  lines.push('- Token sub-agent (delegate_task/dispatch_agent) + consult Omega đều cộng vào budget của bạn — dùng có kỷ luật.')
  return lines.join('\n')
}

/**
 * [20-c] CONFIDENCE PROTOCOL — kỷ luật khai báo nguồn + mức chắc chắn trung thực.
 * Appended vào system prompt của executor agent (mọi agents chạy goal-loop).
 * Tag nguồn cho phép phân loại claim (verified-by-tool / KB / model-prior) —
 * nền cho calibration claim-level (roadmap) + chống overconfidence mặc định.
 */
function buildConfidenceProtocol(): string {
  return `

🎯 CONFIDENCE PROTOCOL (bắt buộc):
- Mỗi nhận định quan trọng trong câu trả lời PHẢI gắn nhãn nguồn:
  [verified-by-tool] = đã kiểm chứng bằng tool thật (đọc lại file, chạy lệnh, test)
  [KB] = trích từ knowledge base/tài liệu người dùng cung cấp
  [model-prior] = suy đoán từ kiến thức có sẵn của model (chưa kiểm chứng)
- Cuối phản hồi LUÔN có đúng 1 dòng: "Confidence: <0-100>%" phản ánh THẬT mức chắc chắn của bạn:
  ≥85% = có bằng chứng tool trực tiếp · 60-85% = bằng chứng gián tiếp/KB · 35-60% = suy luận · <35% = đoán mò (nên đề xuất cách verify thêm).
- KHÔNG mặc định tự tin 90% — overconfidence là lỗi nghiêm trọng. Trung thực về những gì chưa kiểm chứng được.`
}

/**
 * AUTOMATION PROTOCOL (user request 2026-09-13) — khi agent có tool automation:
 *   • hasDirect (manage_automation — chỉ Omega): trực tiếp tạo/sửa/xóa cron
 *     job / webhook / standing order / task flow.
 *   • hasPropose (propose_automation — mọi agents): thấy cần automation →
 *     đề xuất với Omega → Omega quyết định forward vào Self-direction chờ
 *     Mr. Architect / agent được ủy quyền phê duyệt.
 */
function buildAutomationProtocol(hasDirect: boolean, hasPropose: boolean): string {
  const lines: string[] = []
  if (hasDirect) {
    lines.push('')
    lines.push('⚙️ QUẢN LÝ TỰ ĐỘNG HÓA (manage_automation — quyền trực tiếp của bạn):')
    lines.push('- Tạo cron job: tool_call: manage_automation({"action": "create_cron", "expression": "0 9 * * 1-5", "taskPrompt": "nhiệm vụ"})')
    lines.push('- Đăng ký webhook: tool_call: manage_automation({"action": "create_webhook", "url": "https://...", "events": ["document.uploaded"]})')
    lines.push('- Thêm standing order: tool_call: manage_automation({"action": "add_standing_order", "order": "chỉ thị", "priority": 50})')
    lines.push('- Tạo/tinh chỉnh task flow (Trigger→Action→Condition→Result): tool_call: manage_automation({"action": "create_flow", "name": "...", "steps": [...]}) — update_flow/run_flow/list_flows tương tự.')
    lines.push('- Chỉ dùng khi user yêu cầu hoặc hệ thống THẬT cần automation — không tạo bừa.')
  }
  if (hasPropose) {
    lines.push('')
    lines.push('📤 ĐỀ XUẤT TỰ ĐỘNG HÓA (propose_automation — khi thấy cần nhưng KHÔNG có quyền tạo trực tiếp):')
    lines.push('- Tác vụ lặp lại định kỳ / cần đẩy sự kiện ra endpoint ngoài / cần chỉ thị thường trực / cần quy trình nhiều bước → đề xuất:')
    lines.push('  tool_call: propose_automation({"kind": "cron|webhook|standing_order|task_flow", "payload": {...}, "reason": "lý do cụ thể", "evidence": "dữ liệu hỗ trợ"})')
    lines.push('- Omega quyết định: forward vào module Self-direction chờ Mr. Architect (hoặc agent được ủy quyền) phê duyệt — được duyệt thì tài nguyên TỰ TẠO. Từ chối thì Omega trả lý do.')
    lines.push('- Việc gấp cần làm NGAY thì tự làm bằng tools của mình — KHÔNG propose.')
  }
  return lines.length > 0 ? '\n' + lines.join('\n') : ''
}

/**
 * CI-3 B7 (Task 13-e) — ghép system prompt HOÀN CHỈNH của goal loop + áp budget
 * ký tự TỔNG (SYSTEM_PROMPT_BUDGET_CHARS — env SYSTEM_PROMPT_BUDGET_CHARS,
 * mặc định 24k chars ~ 6k tokens, 0 = không giới hạn).
 *
 * Block & priority (cao = giữ nguyên khi vượt budget):
 *   base (systemPrompt từ chat route: agent instruction + base prompt + KB +
 *   workspace + capability + roster + skills[cap 16k] + custom tools +
 *   standing orders + memories + HOT[cap 2k] + user profile + additions —
 *   NGOÀI skills/HOT KHÔNG block nào cap) → priority THẤP NHẤT (cắt trước,
 *   giữ ĐẦU block: persona/KB/workspace nằm đầu) · goalProtocol → CAO NHẤT
 *   (quy tắc vận hành loop — cắt là đổi hành vi) · delegation/orchestration/
 *   confidence/preAct giảm dần.
 * Block nhỏ (<500 chars) không bao giờ bị cắt. Fail-open: lỗi budget → trả
 * prompt ghép nguyên bản. Exported cho smoke test (mock base lớn → prompt
 * cuối ≤ budget). Tổng < budget → chuỗi trả về GIỐNG HỆT concat cũ.
 */
export function assembleGoalLoopSystemPrompt(params: {
  systemPrompt: string
  hasDelegation: boolean
  hasOrchestration: boolean
  hasDispatch: boolean
  hasCreate: boolean
  preActBlock: string
  /** AUTOMATION (2026-09-13): manage_automation (trực tiếp — Omega) */
  hasAutomationDirect?: boolean
  /** AUTOMATION (2026-09-13): propose_automation (đề xuất — mọi agents) */
  hasAutomationPropose?: boolean
  /** nhãn context cho log 1 dòng khi có cut */
  agentName?: string
}): string {
  const { systemPrompt, hasDelegation, hasOrchestration, hasDispatch, hasCreate, preActBlock, agentName } = params
  try {
    return budgetPrompt(
      [
        { name: 'base', content: systemPrompt, priority: 10 },
        { name: 'goalProtocol', content: buildGoalProtocol(), priority: 100 },
        { name: 'delegationProtocol', content: hasDelegation ? buildDelegationProtocol() : '', priority: 90 },
        { name: 'orchestrationProtocol', content: hasOrchestration ? buildOrchestrationProtocol(hasDispatch, hasCreate) : '', priority: 80 },
        { name: 'automationProtocol', content: buildAutomationProtocol(params.hasAutomationDirect === true, params.hasAutomationPropose === true), priority: 78 },
        { name: 'confidenceProtocol', content: buildConfidenceProtocol(), priority: 70 },
        { name: 'preAct', content: preActBlock, priority: 60 },
      ],
      `goal-loop:${agentName || 'agent'}`,
    )
  } catch (err) {
    // FAIL-OPEN — lỗi budget: ghép nguyên bản như cũ (không cut)
    console.warn(
      `[GoalLoop] prompt budget thất bại (fail-open — system prompt nguyên bản): ${err instanceof Error ? err.message : String(err)}`,
    )
    return (
      systemPrompt +
      buildGoalProtocol() +
      (hasDelegation ? buildDelegationProtocol() : '') +
      (hasOrchestration ? buildOrchestrationProtocol(hasDispatch, hasCreate) : '') +
      buildAutomationProtocol(params.hasAutomationDirect === true, params.hasAutomationPropose === true) +
      buildConfidenceProtocol() +
      preActBlock
    )
  }
}

/** Directive nối tiếp chu kỳ — chẩn đoán + kế hoạch mới từ evaluator */
function buildContinuationDirective(v: EvalVerdict, cycle: number, cutMidWork: boolean): string {
  const missing = v.missing.length > 0 ? v.missing.map(m => `- ${m}`).join('\n') : '- (trọng tài không liệt kê cụ thể — tự rà soát lại mục tiêu)'
  const plan = v.nextPlan.length > 0 ? v.nextPlan.map((p, i) => `${i + 1}. ${p}`).join('\n') : '- tự xác định bước khắc phục'
  const cut = cutMidWork ? '\n⚠️ Chu kỳ trước bị cắt giữa chừng do hết vòng lặp — công việc có thể đang dở.' : ''
  return `[GOAL-LOOP: Chu kỳ ${cycle}/${fmtCap(MAX_CYCLES)}] Mục tiêu CHƯA hoàn thành theo đánh giá độc lập (độ tin cậy ${Math.round(v.confidence * 100)}%).${cut}

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
7. "confidence" phải CALIBRATED trung thực — đây là XÁC SUẤT dự đoán của bạn, không phải mức độ mong muốn: đa số trường hợp "tự tin nhưng sai" nằm ở 0.6-0.8 chứ KHÔNG phải 0.95. Chỉ ≥0.9 khi bằng chứng tool trực tiếp khớp hoàn toàn mục tiêu; thiếu bằng chứng → ≤0.5.

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
    if (typeof r.totalMatches === 'number') parts.push(`${r.totalMatches} match`)
    if (typeof r.exitCode === 'number') parts.push(`exit=${r.exitCode}`)
    if (r.truncated === true) parts.push('output bị cắt')
    if (r.parseError) parts.push(`parseError: ${String(r.parseError).slice(0, 70)}`)
    // FIX (E2E 2026-09-08): bằng chứng grep/shell cần NỘI DUNG match/output —
    // trước đây chỉ ghi "PASS" → evaluator không thấy kết quả grep (Omega E2E:
    // "output shell grep bị cắt, chỉ thấy exit thành công" → không verify được).
    if (Array.isArray(r.matches) && r.matches.length > 0) {
      const previews = (r.matches as Array<Record<string, unknown>>).slice(0, 3).map(m => {
        const f = String(m.file || '').split('/').pop()
        const ln = m.line !== undefined ? `:${m.line}` : ''
        return `${f}${ln} ${String(m.text || '').slice(0, 60)}`
      })
      parts.push(`match: ${previews.join(' | ')}`)
    }
    if (typeof r.stdout === 'string' && r.stdout.trim()) {
      const so = r.stdout.trim()
      parts.push(`output: ${so.slice(0, 120)}${so.length > 200 ? ' …' + so.slice(-50) : ''}`)
    }
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
  /** Token của evaluator cũng phải vào kế toán budget (fix review 2026-09-08) */
  onTokens?: (tokens: number) => void
}): Promise<EvalVerdict | null> {
  const { goal, lastAssistantContent, evidence, verifyEvidence, unverifiedModifications, agentProvider, agentModel, agentId, agentName, abortCheck, onTokens } = params

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
    : '⚠️ KHÔNG có tool kiểm định nào (run_tests/lint/type_check/test_coverage/file_read/grep/shell-thành-công) ở chu kỳ cuối — mọi lời tuyên bố "đã kiểm tra/đã test" đều KHÔNG có bằng chứng.'

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
    // TOKEN ACCOUNTING (fix review 2026-09-08): evaluator call tiêu token thật
    // (tối đa 4 lần/run) — trước đây không được đếm vào tokensUsed → budget
    // ảo (thực tiêu nhiều hơn metadata báo).
    if (typeof result.tokensUsed === 'number' && result.tokensUsed > 0) onTokens?.(result.tokensUsed)
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

TÌNH TRẠNG: vòng lặp dừng sau ${cyclesAttempted}/${maxCycles === 0 ? '∞' : maxCycles} chu kỳ — lý do: ${stopReason}.

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

// ==================== CI-3 B4 (Task 13-c) — TASK SUMMARY LIÊN TÁC VỤ ====================

/**
 * [CI-3 B4] Distill task_summary ~500 chars từ final report/verdict text đã
 * có — DETERMINISTIC, 0 LLM call thêm (roadmap CI-3 B4: "tái dùng final report
 * LLM call"). Lý do không gọi thêm callUtilityLLM: trong sandbox utility core
 * chết sau ~90s sweep key → summary cuối run bị chậm đúng bằng thời gian đó,
 * vi phạm "không làm chậm ending path"; heuristic path PHẢI là đường chính.
 *
 * Cấu trúc (ưu tiên giảm dần — thông tin quan trọng nhất đứng trước để khi
 * cắt budget vẫn còn):
 *   🏁 [task_summary] <HOÀN THÀNH ✅ | CHƯA hoàn thành (dừng: reason)> — Mục tiêu: …
 *   ⏱ X chu kỳ · Y tool calls · Zs
 *   ❌ Còn thiếu: … (chỉ khi chưa đạt — verdict của trọng tài)
 *   🔍 Vấn đề: …    (chỉ khi chưa đạt)
 *   📋 <final report distill — giữ ĐẦU 65% + CUỐI 35% vì báo cáo cuối có
 *      "ĐÃ LÀM" ở đầu và "ĐỀ XUẤT KHẮC PHỤC" ở cuối>
 *
 * Exported để smoke test trực tiếp (verification 13-c mục 4a).
 */
export function distillTaskSummary(params: {
  goal: string
  finalContent: string
  stopReason: GoalStopReason
  complete: boolean
  /** verdict của trọng tài chu kỳ cuối (missing/rootCause — chỉ dùng khi chưa đạt) */
  verdictMissing?: string[]
  rootCause?: string
  cycles: number
  toolCalls: number
  elapsedMs?: number
  /** cap tổng — default 500, clamp 200..2000 */
  maxChars?: number
}): string {
  const maxChars = Math.max(200, Math.min(2000, params.maxChars ?? 500))
  const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim()

  const status = params.complete
    ? 'HOÀN THÀNH ✅'
    : `CHƯA hoàn thành (dừng: ${params.stopReason})`
  const lines: string[] = [
    `🏁 [task_summary] ${status} — Mục tiêu: ${oneLine(params.goal).slice(0, 90)}`,
    `⏱ ${params.cycles} chu kỳ · ${params.toolCalls} tool calls${typeof params.elapsedMs === 'number' && params.elapsedMs >= 0 ? ` · ${Math.round(params.elapsedMs / 1000)}s` : ''}`,
  ]
  if (!params.complete) {
    const missing = (params.verdictMissing ?? []).filter(m => typeof m === 'string' && m.trim()).join('; ')
    if (missing) lines.push(`❌ Còn thiếu: ${oneLine(missing).slice(0, 120)}`)
    if (params.rootCause) lines.push(`🔍 Vấn đề: ${oneLine(params.rootCause).slice(0, 100)}`)
  }

  // Body = final report distill (phần lớn budget); head 65% giữ "ĐÃ LÀM ĐƯỢC",
  // tail 35% giữ "ĐỀ XUẤT KHẮC PHỤC" (2 phần đầu/cuối của báo cáo 4 phần).
  const fixedLen = lines.join('\n').length + 1 // +1 = '\n' trước body
  const bodyBudget = Math.max(80, maxChars - fixedLen)
  let body = oneLine(params.finalContent)
  if (body.length > bodyBudget) {
    const headKeep = Math.floor(bodyBudget * 0.65)
    const tailKeep = Math.max(30, bodyBudget - headKeep - 12) // 12 = ' …[cắt]… '
    body = `${body.slice(0, headKeep)} …[cắt]… ${body.slice(-tailKeep)}`
  }
  if (body) lines.push(`📋 ${body}`)

  return lines.join('\n').slice(0, maxChars)
}

/** Cap tổng của block tóm tắt các tác vụ trước nạp vào context run mới */
const PRIOR_SUMMARY_BLOCK_MAX_CHARS = 1500
/** Số task_summary tối đa nạp vào run mới */
const PRIOR_SUMMARY_LIMIT = 3

/**
 * [CI-3 B4] Nạp tóm tắt các TÁC VỤ TRƯỚC trong session (kind='task_summary'
 * từ Kho Context — Task 13-b): run mới thay vì chỉ thấy 6 message cuối thô
 * còn có bức tranh dài hạn của cả session (mục tiêu từng run đạt/không, việc
 * đã làm, kết quả chính). Exported để smoke test trực tiếp (verification 13-c
 * mục 4c/4d).
 *
 * @returns '' khi không có summary nào / lỗi (fail-open → caller giữ nguyên
 *          hành vi cũ 6 message cuối).
 */
export async function buildPriorTaskSummariesBlock(
  sessionId: string | null | undefined,
  goal: string,
): Promise<string> {
  if (!sessionId) return ''
  try {
    const recall = await recallContext({
      query: goal,
      sessionId,
      kind: 'task_summary',
      limit: PRIOR_SUMMARY_LIMIT,
    })
    const summaries = (recall.items ?? [])
      .map(it => (typeof it.content === 'string' ? it.content.replace(/\s+/g, ' ').trim() : ''))
      .filter(s => s.length > 0)
    if (summaries.length === 0) return ''

    const lines: string[] = [
      '[TÓM TẮT CÁC TÁC VỤ TRƯỚC TRONG SESSION — kết quả các run trước (mới nhất trước); cần chi tiết deeper → tool context_recall]',
    ]
    for (const s of summaries) {
      const line = `- ${s.slice(0, 480)}`
      if (lines.join('\n').length + line.length + 1 > PRIOR_SUMMARY_BLOCK_MAX_CHARS) break
      lines.push(line)
    }
    return lines.length > 1 ? lines.join('\n').slice(0, PRIOR_SUMMARY_BLOCK_MAX_CHARS) : ''
  } catch (err) {
    // Fail-open — recall lỗi không được phép chặn run mới
    console.warn(`[GoalLoop] recall task_summary thất bại (fail-open — giữ hành vi cũ 6 message cuối): ${err instanceof Error ? err.message : String(err)}`)
    return ''
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
  /**
   * CI-5 (Task 14-b) — DURABLE HOOKS (worker nền 14-a truyền vào). HOÀN TOÀN
   * optional — không truyền = hành vi inline cũ 100% (feature flag off path):
   *   - resumeState  → khôi phục từ checkpoint sau crash/restart: messages dùng
   *                    snapshot (KHÔNG build lại từ chatHistory), counters/
   *                    verdict/fingerprint... khôi phục, runId tracker DÙNG LẠI
   *   - onCheckpoint → worker ghi checkpoint vào DB (throttle bên worker) —
   *                    gọi mỗi vòng inner loop + cuối mỗi chu kỳ + trước return
   *   - onSignal     → heartbeat tín hiệu sống (iteration/tool_batch/compression/cycle)
   *   - cancelCheck  → override isSessionCancelled in-memory (nút Dừng qua DB
   *                    flag cancelRequestedAt — sống qua restart)
   * Mọi hook fail-open: lỗi durable KHÔNG BAO GIỜ được làm hỏng vòng lặp.
   */
  durable?: GoalLoopDurableHooks
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
    durable,
  } = params

  const startedAt = Date.now()
  // [G] Tool hiệu dụng cho protocol injection: agent KHÔNG khai báo whitelist
  // (agentTools=[] → mọi tool đều được phép — agent custom/Omega-created) vẫn
  // thấy delegation + orchestration protocol vì các tool đó thực sự gọi được.
  const effectiveTools = agentTools.length > 0
    ? agentTools
    : ['delegate_task', 'escalate_problem', 'dispatch_agent', 'create_agent']
  const hasDelegation = effectiveTools.includes('delegate_task')
  const hasOrchestration = effectiveTools.includes('escalate_problem') || effectiveTools.includes('dispatch_agent') || effectiveTools.includes('create_agent')
  // AUTOMATION (user request 2026-09-13) — protocol block khi agent có tool
  // automation (trực tiếp = chỉ Omega / đề xuất = mọi agents).
  const hasAutomationDirect = effectiveTools.includes('manage_automation')
  const hasAutomationPropose = effectiveTools.includes('propose_automation')

  // ===== A6 · EPISODIC MEMORY — PRE-ACT RETRIEVAL (nhịp 1 learning loop) =====
  // Trước khi hành động: lessons đã học + cảnh báo lỗi chưa resolve + episodes
  // tương tự → inject vào system prompt. Lesson confidence ≥ 0.7 auto-apply
  // (appliedLessonIds) → được VALIDATE sau run (nhịp 3 EVALUATE).
  // Timeout 4s + fail-open tuyệt đối — episodic memory không được làm chậm
  // cold-start hay làm hỏng response của agent.
  let preActBlock = ''
  let appliedLessonIds: string[] = []
  try {
    const { buildPreActContext } = await import('@/lib/episodic-memory/preact')
    const preAct = await Promise.race([
      buildPreActContext({ agentName, task: userMessage }),
      new Promise<null>(resolve => setTimeout(() => resolve(null), 4000)),
    ])
    if (preAct && preAct.promptBlock) {
      preActBlock = preAct.promptBlock
      appliedLessonIds = preAct.appliedLessonIds
      console.log(`[GoalLoop] ${agentName} PRE-ACT episodic: ${preAct.lessons.length} lessons, ${preAct.unresolvedWarnings.length} cảnh báo lỗi chưa resolve, ${appliedLessonIds.length} lesson auto-apply`)
    }
  } catch { /* fail-open — không có ký ức thì chạy như thường */ }

  // CI-3 B7 (Task 13-e) — system prompt TỔNG có budget ký tự: nhiều block
  // (base từ chat route + goal/delegation/orchestration/confidence protocol +
  // preAct episodic) trước đây ghép không cap ngoài skills 16k/HOT 2k — giờ
  // vượt SYSTEM_PROMPT_BUDGET_CHARS thì cắt block priority thấp nhất giữ đầu.
  const fullSystemPrompt = assembleGoalLoopSystemPrompt({
    systemPrompt,
    hasDelegation,
    hasOrchestration,
    hasDispatch: effectiveTools.includes('dispatch_agent'),
    hasCreate: effectiveTools.includes('create_agent'),
    hasAutomationDirect,
    hasAutomationPropose,
    preActBlock,
    agentName,
  })

  // CI-5 (Task 14-b) — RESUME: capture 1 lần, mọi nhánh dưới guard bằng
  // resumeState → đường inline (không truyền durable) KHÔNG đổi hành vi.
  const resumeState = durable?.resumeState

  // ===== Thought Process tracking — 1 run cho toàn bộ goal loop =====
  // Task 20-c: dbPersistBy 'caller' → tracker KHÔNG insert AgentRunRecord khi
  // run kết thúc (goal-loop tự insert lúc start + update đầy đủ metadata lúc
  // end) — đảm bảo 1 chat run = đúng 1 row AgentRunRecord.
  const runId = startAgentRun({
    sessionId: agentSessionId,
    agentName,
    task: userMessage,
    mode: 'standalone',
    dbPersistBy: 'caller',
    // CI-5 (14-b): resume DÙNG LẠI runId cũ — todos CI-2 keyed theo runId +
    // AgentRunRecord + panel Thought Process liền mạch "1 chat run = 1 run".
    runId: resumeState?.runId ?? undefined,
  })
  // Task 20-c — INSERT row AgentRunRecord 'running' lúc START: runs.active
  // (Runtime Metrics panel) ≠ 0 trong lúc agent đang chạy. Fire-and-forget,
  // fail-open — metrics không được phép làm hỏng loop.
  //
  // CI-5 (Task 14-b) — khi RESUME: KHÔNG insert row mới (row 'running' đã có
  // từ lần chạy trước crash — mục tiêu "1 chat run = 1 row AgentRunRecord",
  // không duplicate). Thay bằng fire-and-forget UPDATE row cũ (refresh
  // startedAt = lúc resume — báo hiệu run đang sống lại; row này sẽ được
  // updateLatestAgentRunRecord update đầy đủ khi run kết thúc như thường).
  // Lưu ý: schema AgentRunRecord KHÔNG có cột runId/updatedAt → where theo
  // (sessionId, status='running') — đúng row của run này vì mọi lần resume
  // đều skip insert nên không tích lũy row 'running' khác trong session.
  // Dynamic import @/lib/db theo pattern sẵn có trong file (fail-open tuyệt
  // đối — DB lỗi không được phép làm hỏng loop).
  if (agentSessionId) {
    if (resumeState) {
      try {
        void (async () => {
          const { db } = await import('@/lib/db')
          await db.agentRunRecord.updateMany({
            where: { sessionId: agentSessionId, status: 'running' },
            data: { startedAt: new Date(startedAt) },
          })
        })().catch(() => { /* fail-open — resume không được phép fail vì metrics */ })
      } catch { /* fail-open */ }
    } else {
      try {
        void insertAgentRunRecordRunning({
          sessionId: agentSessionId,
          agentId,
          agentName,
          startedAt: new Date(startedAt),
        }).catch(() => { /* fail-open */ })
      } catch { /* fail-open */ }
    }
  }
  let runEnded = false
  const endRun = (status: 'done' | 'error' | 'cancelled') => {
    if (runEnded) return
    runEnded = true
    endAgentRun(agentSessionId, runId, status, `${totalIterations} vòng · ${totalToolCalls} tool calls · ${cyclesDone} chu kỳ hoàn thành${cyclesAttempted > cyclesDone ? ` (chu kỳ ${cyclesAttempted} dở)` : ''}`)
  }
  // CI-5 (Task 14-b) — worker override cancel check (DB flag cancelRequestedAt
  // — nút Dừng sống qua restart/app-reload). Không truyền durable.cancelCheck
  // → đúng hàm in-memory cũ, mọi call site isCancelled()/abortCheck giữ nguyên.
  const isCancelled: () => boolean = durable?.cancelCheck
    ? durable.cancelCheck
    : () => isSessionCancelled(agentSessionId)

  // Custom tools registry (agent TỰ VIẾT qua create_custom_tool — dùng ngay được)
  try {
    const { ensureCustomToolsLoaded } = await import('@/lib/custom-tool-registry')
    await ensureCustomToolsLoaded()
  } catch { /* fail-open */ }

  // ===== CI-3 B4 (Task 13-c) — nạp tóm tắt các TÁC VỤ TRƯỚC trong session =====
  // Liên tác vụ: trước đây run mới chỉ nhận 6 message cuối thô (không có
  // bức tranh dài hạn của session). Giờ recall các task_summary
  // (kind='task_summary' trong Kho Context) của session — đặt TRƯỚC 6 message
  // cuối: summary = bức tranh dài hạn, 6 message gần = chi tiết liền kề.
  // Fail-open bên trong helper: lỗi recall → '' → hành vi cũ nguyên vẹn.
  //
  // CI-5 (Task 14-b) — RESUME: KHÔNG nạp lại (bức tranh dài hạn của run trước
  // đã nằm sẵn trong messages snapshot — nạp lại là lặp thông tin).
  const priorTaskSummariesBlock = resumeState ? '' : await buildPriorTaskSummariesBlock(agentSessionId, userMessage)

  // ===== Conversation state =====
  // CI-3 B4: có summary block mà tổng context (summary + 6 message cuối) vượt
  // ngưỡng nén → GIẢM 6 message cuối xuống 4 (summary đã thay phần bức tranh
  // dài hạn — tiết kiệm context cho run mới).
  // (RESUME: priorTaskSummariesBlock luôn '' → historyTake giữ 6, không dùng.)
  let historyTake = 6
  if (priorTaskSummariesBlock) {
    const tailChars = chatHistory.slice(-6).reduce((s, m) => s + (m.content?.length ?? 0), 0)
    if (priorTaskSummariesBlock.length + tailChars > COMPRESS_THRESHOLD_CHARS) historyTake = 4
  }
  // CI-5 (Task 14-b) — RESUME: messages KHÔNG build lại từ chatHistory +
  // userMessage — dùng NGUYÊN snapshot từ checkpoint (shape khớp GoalMessage:
  // role/content/tool_call_id; tool_call_id giữ nguyên để CI-3 pairing-splice
  // nhận diện cặp assistant↔tool khi nén tiếp — xem goal-loop-durable-types).
  // System message của snapshot (index 0) giữ nguyên nội dung run trước;
  // formatMessagesForLLM bỏ qua role 'system' (callLLMForAgent nhận system
  // prompt qua tham số riêng) → không xung đột với fullSystemPrompt lần này.
  const messages: GoalMessage[] = resumeState
    ? resumeState.messages.map(m => ({ role: m.role, content: m.content, tool_call_id: m.tool_call_id }))
    : [
        { role: 'system', content: fullSystemPrompt },
        ...(priorTaskSummariesBlock ? [{ role: 'user' as const, content: priorTaskSummariesBlock }] : []),
        ...chatHistory.slice(-historyTake).map(m => ({ role: m.role as 'user' | 'assistant', content: m.content })),
        { role: 'user', content: userMessage },
      ]
  // goalMsgIndex: run thường = index user message cuối — compressConversation
  // KHÔNG đụng mọi message index <= goalMsgIndex (system + summaries + history
  // + goal) và mid-cycle trim giữ system + goal.
  // CI-5 (Task 14-b) — RESUME: snapshot KHÔNG có "goal message cuối" đáng tin
  // (goal gốc nằm giữa transcript đã nén từ run trước). compressConversation
  // có semantic "protect range [0..protectedStartIndex]" (workStart =
  // protectedStartIndex + 1 — xem context-compression.ts) → truyền 0 bảo vệ
  // ĐÚNG system message (index 0); mọi message index >= 1 được phép nén (CI-3
  // đã chạy từ run trước, transcript đã có digest — hệ quả cần tránh duy nhất
  // là nén làm MẤT system prompt). Mid-cycle trim với goalMsgIndex=0 cũng chỉ
  // giữ system + đuôi gần nhất — chấp nhận được theo cùng lập luận.
  const goalMsgIndex = resumeState ? 0 : messages.length - 1
  if (priorTaskSummariesBlock) {
    console.log(`[GoalLoop] ${agentName} nạp tóm tắt các tác vụ trước trong session (${priorTaskSummariesBlock.length} chars) trước ${historyTake} message cuối — bức tranh dài hạn cho run mới`)
  }

  const evidence: EvidenceEntry[] = resumeState
    ? resumeState.evidence.map(e => ({ cycle: e.cycle, kind: e.kind, tool: e.tool, success: e.success, text: e.text }))
    : []
  // [C] Verify-evidence tracking — harness kiểm đếm tool verify theo thứ tự so với tool sửa
  // (CI-5 14-b: 2 ordinal này KHÔNG thuộc checkpoint contract → reset 0 khi
  // resume — an toàn vì verify-guard so sánh ordinal TRONG run resumed: 0 = 0
  // không kích hoạt spurious downgrade.)
  let lastVerifyOrdinal = 0
  let lastModifyOrdinal = 0
  let cycleVerifyEvidence: string[] = []
  // CI-5 (Task 14-b) — RESUME: counters khôi phục từ checkpoint (MANG TIẾP —
  // tokensUsed KHÔNG reset: trung thực tổng chi phí của run; budget thời gian
  // vẫn tính từ startedAt của lần chạy này — đúng chủ đích).
  let totalIterations = resumeState?.counters.totalIterations ?? 0
  let totalToolCalls = resumeState?.counters.totalToolCalls ?? 0
  let tokensUsed = resumeState?.counters.tokensUsed ?? 0
  let cyclesDone = resumeState?.counters.cyclesDone ?? 0
  /** Chu kỳ đã BẮT ĐẦU (kể cả đang dở) — dùng cho report/metadata trung thực:
   *  budget cắt giữa chu kỳ 1 → "1 chu kỳ (dở)", không phải 0 hay 1 hoàn thành */
  let cyclesAttempted = resumeState?.counters.cyclesAttempted ?? 0
  /** [E] Số lần nén context đã thực hiện */
  let compressions = resumeState?.counters.compressions ?? 0
  /** [F] Số lần delegate + token sub-agent tiêu thụ (báo cáo lên metadata) */
  let delegations = resumeState?.counters.delegations ?? 0
  let subagentTokens = resumeState?.counters.subagentTokens ?? 0
  /** [G] Số lần auto-escalate hỏi Omega + advisory đang chờ inject */
  let escalations = resumeState?.counters.escalations ?? 0
  let omegaConsulted = false
  let omegaAdvisory = ''
  let lastContent = resumeState?.lastContent ?? ''
  /** Lỗi LLM gần nhất (result.error) — surface lên báo cáo cuối thay vì nuốt lỗi */
  let lastLlmError = resumeState?.lastLlmError ?? ''
  /** 21-d: số lần đẩy feedback parse-fail (tool call bị cắt cụt giữa JSON khi
   *  output đạt maxTokens) — chống loop vô hạn nếu LLM liên tục phát JSON lỗi. */
  let parseFailNudges = resumeState?.counters.parseFailNudges ?? 0
  // CI-5 (14-b) — resume khôi phục verdict từ snapshot (bỏ field `raw` lớn —
  // snapshot không lưu; raw chỉ dùng debug/fallback heuristic, '' an toàn).
  let lastVerdict: EvalVerdict | null = resumeState?.verdict
    ? {
        complete: resumeState.verdict.complete,
        confidence: resumeState.verdict.confidence,
        verified: resumeState.verdict.verified,
        missing: resumeState.verdict.missing,
        rootCause: resumeState.verdict.rootCause,
        nextPlan: resumeState.verdict.nextPlan,
        raw: '',
      }
    : null
  let stopReason: GoalStopReason = 'max_cycles'
  let prevFingerprint = resumeState?.fingerprint ?? ''
  let noProgressCount = resumeState?.noProgressCount ?? 0
  /** [B4] CI-1 — số chu kỳ LIÊN TIẾP không có tool call THÀNH CÔNG nào
   *  (stall brake). Khi budget unlimited đây là phanh an toàn chính thay budget. */
  let stallCycles = resumeState?.stallCycles ?? 0
  /** Chu kỳ trước có bị cắt giữa chừng (hết vòng / hết budget) không */
  let cutMidWorkPrev = resumeState?.cutMidWorkPrev ?? false

  // ================== CI-5 (Task 14-b) — DURABLE HOOK HELPERS ==================
  // Worker nền (14-a) truyền hooks; khi `durable` không truyền → mọi helper
  // return ngay (0 side-effect) → đường inline cũ KHÔNG đổi. Hook có thể sync
  // hoặc async — Promise kết quả được .catch() nuốt im lặng (fail-open tuyệt
  // đối: lỗi checkpoint/heartbeat KHÔNG BAO GIỜ làm hỏng vòng lặp).
  /** Snapshot đầy đủ state loop tại thời điểm gọi — worker persist làm checkpoint */
  const buildCheckpoint = (): GoalLoopCheckpoint => ({
    version: 1,
    runId,
    messages: messages.map(m => ({ role: m.role, content: m.content, tool_call_id: m.tool_call_id })),
    evidence: evidence.slice(-120).map(e => ({ cycle: e.cycle, kind: e.kind, tool: e.tool, success: e.success, text: e.text })),
    counters: { cyclesDone, cyclesAttempted, totalIterations, totalToolCalls, tokensUsed, compressions, delegations, subagentTokens, escalations, parseFailNudges },
    verdict: lastVerdict
      ? {
          complete: lastVerdict.complete,
          confidence: lastVerdict.confidence,
          verified: lastVerdict.verified,
          missing: lastVerdict.missing,
          rootCause: lastVerdict.rootCause,
          nextPlan: lastVerdict.nextPlan,
        }
      : null,
    fingerprint: prevFingerprint,
    noProgressCount,
    stallCycles,
    cutMidWorkPrev,
    lastContent,
    lastLlmError,
    savedAt: Date.now(),
  })
  /** Fire onCheckpoint (sync/async) — fail-open */
  const fireCheckpoint = (): void => {
    if (!durable?.onCheckpoint) return
    try {
      const r = durable.onCheckpoint(buildCheckpoint())
      if (r && typeof (r as unknown as { catch?: unknown }).catch === 'function') {
        ;(r as Promise<void>).catch(() => { /* fail-open */ })
      }
    } catch { /* fail-open — checkpoint KHÔNG BAO GIỜ làm hỏng loop */ }
  }
  /** Fire onSignal heartbeat (sync/async) — fail-open */
  const fireSignal = (signal: 'iteration' | 'tool_batch' | 'compression' | 'cycle'): void => {
    if (!durable?.onSignal) return
    try {
      const r = durable.onSignal(signal)
      if (r && typeof (r as unknown as { catch?: unknown }).catch === 'function') {
        ;(r as Promise<void>).catch(() => { /* fail-open */ })
      }
    } catch { /* fail-open */ }
  }

  // CI-1 (0 = UNLIMITED): cap = 0 → không trần → Infinity. Toàn bộ điểm check
  // `timeLeft() <= 0` / `tokenLeft() <= REPORT_RESERVE_TOKENS` (6 chỗ) tự động
  // vô hiệu vì so sánh với Infinity luôn false — không cần sửa từng điểm chặn.
  const timeLeft = () => (TIME_BUDGET_MS === 0 ? Infinity : TIME_BUDGET_MS - (Date.now() - startedAt))
  const tokenLeft = () => (TOKEN_BUDGET === 0 ? Infinity : TOKEN_BUDGET - tokensUsed)

  console.log(`[GoalLoop] ${agentName} bắt đầu — mục tiêu: "${userMessage.slice(0, 100)}" (max ${fmtCap(MAX_CYCLES)} chu kỳ × ${fmtCap(ITER_PER_CYCLE)} vòng, budget ${TIME_BUDGET_MS === 0 ? '∞' : `${Math.round(TIME_BUDGET_MS / 60000)}'`} / ${TOKEN_BUDGET === 0 ? '∞ tokens (KHÔNG GIỚI HẠN — CI-1)' : `${TOKEN_BUDGET} tokens, reserve ${REPORT_RESERVE_TOKENS} cho evaluate + báo cáo cuối`}, nén context @${COMPRESS_THRESHOLD_CHARS} chars${agentTools.includes('delegate_task') ? ', delegate_task BẬT' : ''})`)

  // CI-5 (Task 14-b) — RESUME: chu kỳ bắt đầu = cyclesAttempted + 1 (chu kỳ
  // đã BẮT ĐẦU kể cả dở được tính là đã attempt — checkpoint theo VÒNG nên
  // tối đa replay 1 vòng LLM: vòng in-flight lúc crash). startedAt giữ
  // Date.now() ở trên — budget THỜI GIAN tính từ lúc resume (đúng chủ đích:
  // budget là của lần chạy này); tokensUsed đã mang tiếp từ checkpoint.
  const resumeStartCycle = resumeState ? resumeState.counters.cyclesAttempted + 1 : 1
  if (resumeState) {
    console.log(`[GoalLoop] ${agentName} RESUME từ checkpoint — chu kỳ ${resumeStartCycle}, ${totalIterations} vòng đã chạy, ${messages.length} messages, runId ${runId}`)
  }

  // ================== OUTER CYCLE LOOP ==================
  // CI-1 (0 = UNLIMITED): MAX_CYCLES = 0 → KHÔNG trần chu kỳ (loop chỉ dừng
  // bởi complete / no-progress brake / cancel / error).
  // CI-5 (14-b): resume bắt đầu từ chu kỳ kế của checkpoint (resumeStartCycle).
  outerLoop: for (let cycle = resumeStartCycle; MAX_CYCLES === 0 || cycle <= MAX_CYCLES; cycle++) {
    if (isCancelled()) { stopReason = 'cancelled'; break }
    if (timeLeft() <= 0) { stopReason = 'time_budget'; break }
    // [A] Không bắt đầu chu kỳ mới nếu chỉ còn token reserve (dành cho final report)
    if (tokenLeft() <= REPORT_RESERVE_TOKENS) { stopReason = 'token_budget'; break }
    cyclesAttempted = cycle

    // Cycle > 1 → inject continuation directive (chẩn đoán + kế hoạch mới)
    // [G] + advisory của Omega (nếu auto-escalate đã chạy ở cuối chu kỳ trước)
    if (cycle > 1 && lastVerdict) {
      const advisoryBlock = omegaAdvisory ? `\n\n${omegaAdvisory}\n(Theo tư vấn trên — ĐỔI CÁCH TIẾP CẬN, không lặp lại hành động đã fail.)` : ''
      omegaAdvisory = ''
      const directive = buildContinuationDirective(lastVerdict, cycle, cutMidWorkPrev) + advisoryBlock
      messages.push({ role: 'user', content: directive })
      evidence.push({ cycle, kind: 'directive', text: `Chu kỳ ${cycle}: chẩn đoán "${lastVerdict.rootCause.slice(0, 120)}" → kế hoạch mới${advisoryBlock ? ' + tư vấn Omega orchestrator' : ''}` })
      recordAgentThought(agentSessionId, `🔄 Chu kỳ ${cycle}/${fmtCap(MAX_CYCLES)} — chẩn đoán: ${lastVerdict.rootCause || '(không rõ)'} → lên kế hoạch lại và khắc phục${advisoryBlock ? ' (kèm tư vấn Omega)' : ''}`, totalIterations)
    }

    // ===== INNER REACT LOOP (EXECUTE + VERIFY theo protocol) =====
    let cycleIterations = 0
    let cycleToolCalls = 0
    cycleVerifyEvidence = [] // [C] bằng chứng kiểm định tính lại mỗi chu kỳ
    let endedBy: 'no_tool_calls' | 'iteration_limit' | 'error' | 'budget' | 'cancelled' = 'no_tool_calls'
    let cycleHadLlmError = false

    // CI-1 (0 = UNLIMITED): ITER_PER_CYCLE = 0 → KHÔNG trần vòng ReAct mỗi chu kỳ
    while (ITER_PER_CYCLE === 0 || cycleIterations < ITER_PER_CYCLE) {
      if (isCancelled()) { endedBy = 'cancelled'; break }
      // [A] Reserve token cho evaluate cuối + final report — EXECUTE dừng ở
      // ngưỡng reserve thay vì đợi cạn kiệt về 0 (báo cáo không bị cắt giữa chừng)
      if (timeLeft() <= 0 || tokenLeft() <= REPORT_RESERVE_TOKENS) { endedBy = 'budget'; break }
      // CI-5 (14-b) — heartbeat: tín hiệu sống đầu mỗi vòng (ngay sau cancel/budget check)
      fireSignal('iteration')
      cycleIterations++
      totalIterations++

      // [E] ROLLING CONTEXT COMPRESSION — nén segment cũ trước khi gửi prompt
      // (mỗi vòng đều gửi TOÀN BỘ transcript → chi phí O(n²) nếu không nén).
      // CI-3 B1 (Task 13-a): gọi module dùng chung compressConversation với
      // tham số tương đương compressHistory cũ — HÀNH VI KHÔNG ĐỔI.
      // Fail-open: lỗi nén → giữ nguyên messages, loop vẫn chạy bình thường.
      try {
        const comp = await compressConversation({
          messages,
          protectedStartIndex: goalMsgIndex,
          keepRecent: KEEP_RECENT_MESSAGES,
          evidence,
          onTokens: (t) => { tokensUsed += t },
          llmContext: 'goal-loop-context-compression',
          // CI-3 B2 (Task 13-b): lưu digest vào Kho Context — agent dùng
          // context_recall đọc lại chi tiết đã nén khi cần (fail-open bên trong).
          archive: { runId, sessionId: agentSessionId, agentName },
        })
        if (comp) {
          compressions++
          console.log(`[GoalLoop] ${agentName} nén context #${compressions} (${comp.method}): ${Math.round(comp.savedChars / 1000)}k ký tự tiết kiệm — giữ system + goal + ${KEEP_RECENT_MESSAGES} message gần nhất`)
          // Ghi digest preview 400 chars vào WorkingMemory HOT (giữ nguyên như
          // cũ — request sau trong session đọc lại được ngay qua HOT digest).
          recordWorkMemory(agentId, agentSessionId, `📦 [context-digest] ${comp.digest.slice(0, 400)}`, 0.75)
          recordAgentThought(agentSessionId, `📦 Nén context #${compressions}: tiết kiệm ~${Math.round(comp.savedChars / 1000)}k ký tự (${comp.method === 'llm' ? 'LLM digest' : 'heuristic'}) — phần cũ đã thành tóm tắt, message gần nhất giữ nguyên`, totalIterations)
          // CI-5 (14-b) — heartbeat sau lần nén context THÀNH CÔNG
          fireSignal('compression')
        }
      } catch { /* fail-open — nén lỗi không được phép làm hỏng vòng lặp */ }

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
        // 21-d FIX SILENT PARSE-DROP: output CÓ dấu hiệu tool call ("tool_call:"
        // hoặc ```json chứa "name") nhưng parse thất bại (JSON bị cắt cụt giữa
        // chừng — thường do output quá dài chạm maxTokens) → trước đây tool call
        // bị BỎ QUA IM LẶNG, agent kết thúc 'no_tool_calls' mà không biết file
        // vừa mất. Giờ: đẩy feedback vào conversation (pattern pushToolMessage)
        // để LLM phát lại GỌN HƠN ở lượt kế — tối đa 2 lần, sau đó conclude như cũ.
        try {
          const brokenHint = detectBrokenToolCallHint(result.content)
          if (brokenHint && parseFailNudges < 2 && timeLeft() > 0 && tokenLeft() > REPORT_RESERVE_TOKENS) {
            parseFailNudges++
            messages.push({ role: 'assistant', content: result.content })
            pushToolMessage(messages, { tool: 'parse_error', success: false, result: brokenHint })
            evidence.push({ cycle, kind: 'tool', tool: 'parse_error', success: false, text: 'tool call bị cắt/JSON lỗi — đã yêu cầu phát lại gọn hơn' })
            recordAgentThought(agentSessionId, `⚠️ Tool call bị cắt cụt giữa JSON (lần ${parseFailNudges}/2) — đã phản hồi lỗi để agent phát lại gọn hơn (chia file nhỏ, file_write append)`, totalIterations)
            continue
          }
        } catch { /* fail-open — feedback lỗi không được phép crash loop */ }
        // Agent tự kết luận (protocol yêu cầu đã verify + báo cáo ở đây)
        endedBy = 'no_tool_calls'
        break
      }

      console.log(`[GoalLoop] ${agentName} chu kỳ ${cycle} vòng ${cycleIterations}: ${toolCalls.length} tool calls`)
      messages.push({ role: 'assistant', content: result.content })

      // CI-2 (Task 11-a) — bằng chứng thu được trong batch này (đường dẫn file /
      // lệnh shell của tool call THÀNH CÔNG) → auto-complete todo in_progress
      // khớp nội dung NGAY SAU batch (LLM thường quên tự đóng todo).
      const batchEvidence: string[] = []

      for (const [tcIdx, tc] of toolCalls.entries()) {
        if (isCancelled()) break

        // BATCH BUDGET GUARD (fix review 2026-09-08): trước đây budget chỉ
        // check SAU cả batch — 1 message chứa nhiều tool call (mỗi delegate
        // tới 10 phút/40k token) có thể vượt time-budget HÀNG GIỜ trước khi
        // vòng ngoài nhận ra. Giờ check trước MỖI tool call.
        if (timeLeft() <= 0 || tokenLeft() <= REPORT_RESERVE_TOKENS) {
          // Đẩy stub result cho các tool call còn lại (LLM cần thấy response
          // cho mọi tool_call đã phát ra) rồi thoát batch.
          for (const rest of toolCalls.slice(tcIdx)) {
            pushToolMessage(messages, { tool: rest.name, success: false, result: 'Bỏ qua — budget token/thời gian của vòng lặp đã cạn (report reserve). Hãy tổng hợp báo cáo cuối.' })
            evidence.push({ cycle, kind: 'tool', tool: rest.name, success: false, text: 'bỏ qua (budget cạn)' })
          }
          endedBy = 'budget'
          break
        }

        // DELEGATE PRE-FLIGHT (fix review 2026-09-08): sub-agent có budget
        // riêng 40k token — không bắn khi vòng lặp cha gần cạn (sub-agent
        // chạy xong mà cha không còn token đọc báo cáo = tiền mất tật mang).
        if ((tc.name === 'delegate_task' || tc.name === 'dispatch_agent') && tokenLeft() <= REPORT_RESERVE_TOKENS + 10_000) {
          pushToolMessage(messages, { tool: tc.name, success: false, result: 'Từ chối delegate — budget token của vòng lặp gần cạn (≤ reserve + 10k). Hãy TỰ LÀM phần việc còn lại ngắn gọn thay vì delegate.' })
          evidence.push({ cycle, kind: 'tool', tool: tc.name, success: false, text: 'từ chối (budget cha gần cạn)' })
          continue
        }

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
        // CI-2 (Task 11-a): inject THÊM runId của run hiện tại — todo được scope
        // theo TỪNG RUN (per-task isolation: run mới không thấy todo run cũ).
        // Điều kiện inject: sessionId trống hoặc trùng session của loop (agent
        // tự khai sessionId khác → tôn trọng, không đụng).
        const toolArgs: Record<string, unknown> = { ...tc.args }
        if (tc.name === 'todo_write' && agentSessionId && (!toolArgs.sessionId || toolArgs.sessionId === agentSessionId)) {
          toolArgs.sessionId = toolArgs.sessionId || agentSessionId
          if (runId && !toolArgs.runId) toolArgs.runId = runId
        }

        // DELEGATION CONTRACT (fix 2026-09-12): truyền runId vào context —
        // delegate_task đọc context.runId làm parentRunId (Thought Process panel
        // hiển thị "delegated bởi run_X").
        const toolResult = await executeTool(tc.name, toolArgs, { agentName, sessionId: agentSessionId, runId })

        // CI-2 (Task 11-a) — thu bằng chứng từ tool call THÀNH CÔNG (bảo thủ:
        // chỉ path file/lệnh shell — xem extractTodoEvidence)
        if (toolResult.success) {
          const ev = extractTodoEvidence(tc.name, tc.args)
          if (ev) batchEvidence.push(ev)
        }

        // [F] TOKEN ACCOUNTING cho tool có LLM nội bộ (delegate_task /
        // dispatch_agent: sub-agent tiêu token thật; escalate_problem: Omega
        // consult) — cộng vào budget loop để không chạy tuột. Token này
        // KHÔNG được đếm ở đâu khác (executeTool không báo qua callLLMForAgent).
        if (toolResult.result && typeof toolResult.result === 'object') {
          const innerTokens = (toolResult.result as { tokensUsed?: unknown }).tokensUsed
          if (typeof innerTokens === 'number' && innerTokens > 0) {
            tokensUsed += innerTokens
            if (tc.name === 'delegate_task' || tc.name === 'dispatch_agent') {
              delegations++
              subagentTokens += innerTokens
            }
          }
        }

        // ===== WORKING MEMORY (HOT) — ghi nhận tool đã chạy + kết quả =====
        // Các request sau trong session thấy entry này qua digest HOT trong
        // system prompt → không lặp lại tool đã chạy (tiết kiệm token + time)
        // [D] Preview thông minh (errorCount + lỗi cụ thể) thay vì cắt 200 ký tự đầu
        const resultPreview = summarizeToolResult(toolResult.result).slice(0, 250)

        // [C] Harness kiểm đếm bằng chứng kiểm định theo thứ tự thời gian.
        // LƯU Ý: lint/type_check FAIL (có errorCount) VẪN LÀ bằng chứng kiểm định
        // hợp lệ — agent thấy được số lỗi cụ thể. Chỉ tool không chạy được
        // (permission disabled / exception → result là string) mới không tính.
        //
        // FIX (review 2026-09-08): shell/run_bg THÀNH CÔNG cũng tính là bằng
        // chứng kiểm định (protocol của loop cho phép "shell kiểm tra output"
        // — bun test, cat file...). Trước đây shell chỉ đếm là MODIFY → chu kỳ
        // kết thúc bằng shell-verify bị verify-guard hạ "hoàn thành" →
        // "chưa đạt" SAI (task xong bị ép chạy tới max_cycles). Ordinal
        // modify/verify bằng nhau khi shell là tool cuối → guard không hạ.
        const isStructuredResult = toolResult.result !== null && typeof toolResult.result === 'object'
        const shellVerify = (tc.name === 'shell' || tc.name === 'run_bg') && toolResult.success && isStructuredResult
        if ((VERIFY_TOOLS.has(tc.name) || READBACK_TOOLS.has(tc.name) || shellVerify) && isStructuredResult) {
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

      // ===== CI-2 (Task 11-a) — MID-RUN EVIDENCE-BASED AUTO-COMPLETE =====
      // Sau mỗi batch tool call: todo 'in_progress' của ĐÚNG run hiện tại mà
      // nội dung chứa đúng đường dẫn file / lệnh shell của tool call THÀNH CÔNG
      // → tự đánh dấu 'completed' + snapshot lại todo list của run cho panel.
      // LLM thường quên gọi todo_write đóng bước → đây là lưới an toàn dựa trên
      // bằng chứng THẬT (substring match chặt, chỉ todo đúng runId). Fail-open.
      if (agentSessionId && runId && batchEvidence.length > 0) {
        try {
          const res = await autoCompleteRunTodosByEvidence({
            sessionId: agentSessionId,
            runId,
            evidence: batchEvidence,
          })
          if (res.completed > 0) {
            recordAgentRunTodos(agentSessionId, res.todos.map(t => ({
              id: t.id,
              content: t.content,
              status: t.status,
              priority: t.priority,
            })))
            recordAgentThought(
              agentSessionId,
              `✅ CI-2: tự hoàn thành ${res.completed} todo theo bằng chứng tool (đường dẫn/lệnh shell khớp nội dung todo)`,
              totalIterations,
            )
          }
        } catch { /* fail-open — auto-complete không được phép làm hỏng loop */ }
      }

      // CI-5 (Task 14-b) — CHECKPOINT CUỐI MỖI VÒNG inner loop + heartbeat
      // tool_batch: đây là điểm ĐẦU TIÊN mà messages (assistant + tool results
      // của batch) + evidence + counters đều đã cập nhật đầy đủ — checkpoint
      // ở đây bảo đảm kill -9 ngay sau batch chỉ replay tối đa 1 vòng LLM
      // (đặt TRƯỚC các break cancel/budget để vòng sắp break vẫn được chốt
      // state). Biến cục bộ chu kỳ (cycleToolCalls...) KHÔNG thuộc checkpoint
      // — chỉ state toàn cục loop. Fail-open (fireCheckpoint tự nuốt lỗi).
      fireCheckpoint()
      fireSignal('tool_batch')

      if (isCancelled()) { endedBy = 'cancelled'; break }
      if (timeLeft() <= 0 || tokenLeft() <= REPORT_RESERVE_TOKENS) { endedBy = 'budget'; break }

      // CI-1: chỉ chốt 'iteration_limit' khi CÓ trần vòng (cap = 0 thì while
      // không bao giờ tự thoát vì hết vòng — endedBy do điểm thoát thật ghi)
      if (ITER_PER_CYCLE > 0 && cycleIterations >= ITER_PER_CYCLE) {
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
      onTokens: (t) => { tokensUsed += t },
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
    let forcedDowngrade = false // Task 20-c — flag cho ArbiterVerdict.forcedDowngrade
    if (verdict.complete && lastModifyOrdinal > lastVerifyOrdinal) {
      forcedDowngrade = true
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

    // Task 20-c — PERSIST VERDICT mỗi chu kỳ: verdict EFFECTIVE (sau verify-guard)
    // là dự đoán P(complete)=confidence của trọng tài. Khi run kết thúc,
    // resolveArbiterVerdicts() ghi outcome (confirmed/refuted) → dữ liệu tính
    // Brier/ECE calibration của trọng tài. Fire-and-forget, fail-open.
    if (agentSessionId) {
      try {
        void insertArbiterVerdict({
          sessionId: agentSessionId,
          agentName,
          cycle,
          complete: verdict.complete,
          confidence: verdict.confidence,
          verified: verdict.verified,
          missing: JSON.stringify(verdict.missing),
          rootCause: forcedDowngrade && verdict.rootCause
            ? `${verdict.rootCause} (harness downgrade)`
            : verdict.rootCause || null,
          forcedDowngrade,
        }).catch(() => { /* fail-open — verdict persist không được phép làm hỏng loop */ })
      } catch { /* fail-open */ }
    }

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

    // ===== [G] AUTO-ESCALATE #1 — chưa kiểm định được (dấu hiệu bế tắc chuẩn)
    // User request 2026-09-08: "Agents khi vận hành... tốt nhất là TRƯỚC khi gặp
    // vấn đề cần một cơ chế nhận diện được, từ đó đưa ra giải pháp từ trước".
    // Chu kỳ >= 2 mà mục tiêu chưa đạt + KHÔNG có bằng chứng kiểm định → agent
    // đang xoay vòng → hỏi Omega orchestrator 1 lần (budget-guarded), advisory
    // inject vào continuation directive của chu kỳ kế tiếp.
    if (
      !omegaConsulted && cycle >= 2 && !verdict.verified && !verdict.complete &&
      tokenLeft() > REPORT_RESERVE_TOKENS + 8_000 && !isCancelled()
    ) {
      try {
        const { consultOmega } = await import('@/lib/omega-orchestrator')
        const failedRecent = evidence
          .filter(e => e.kind === 'tool' && e.success === false)
          .slice(-5)
          .map(e => `- ${e.tool}: ${e.text.slice(0, 120)}`)
          .join('\n')
        const consult = await consultOmega({
          problem: `Agent "${agentName}" đã làm ${cycle} chu kỳ nhưng trọng tài độc lập kết luận: mục tiêu CHƯA hoàn thành và kết quả CHƯA được kiểm định bằng tool (verified=false). Căn nguyên theo trọng tài: ${verdict.rootCause || '(không rõ)'}. Còn thiếu: ${verdict.missing.join('; ') || '(không liệt kê)'}. Tool fail gần nhất:\n${failedRecent || '(không có tool fail nào)'}`,
          context: `Mục tiêu: ${userMessage.slice(0, 800)}\nKế hoạch trọng tài đề xuất cho chu kỳ sau: ${verdict.nextPlan.join('; ') || '(trống)'}\nAgent này có tools: ${effectiveTools.slice(0, 30).join(', ')}`,
          attempted: `Đã làm ${totalIterations} vòng / ${totalToolCalls} tool calls qua ${cycle} chu kỳ. Bằng chứng gần nhất: ${evidence.slice(-6).map(e => (e.kind === 'tool' ? `${e.tool}(${e.success ? '✓' : '✗'})` : 'directive')).join(', ')}`,
          callingAgent: agentName,
          severity: 'high',
          autoTriggered: true,
          abortCheck: isCancelled,
          onTokens: (t) => { tokensUsed += t },
        })
        if (consult.success && consult.text) {
          omegaConsulted = true
          escalations++
          omegaAdvisory = consult.text
          evidence.push({ cycle, kind: 'directive', text: `AUTO-ESCALATE → Omega orchestrator tư vấn giải pháp (kèm cho chu kỳ ${cycle + 1})` })
          recordAgentThought(agentSessionId, `🧠 AUTO-ESCALATE: chu kỳ ${cycle} chưa kiểm định được → đã hỏi Omega orchestrator (${consult.tokensUsed} tokens) — tư vấn sẽ dẫn đường chu kỳ ${cycle + 1}`, totalIterations)
          console.log(`[GoalLoop] ${agentName} auto-escalate (unverified cycle ${cycle}) → Omega consult OK (${consult.tokensUsed} tokens)`)
        }
      } catch { /* fail-open — không escalate được thì theo kế hoạch evaluator */ }
    }

    // ===== No-progress detection =====
    const fp = progressFingerprint(messages)
    if (cycle > 1 && fp === prevFingerprint) {
      noProgressCount++
      console.warn(`[GoalLoop] ${agentName} NO-PROGRESS: fingerprint chu kỳ ${cycle} trùng chu kỳ trước (lần ${noProgressCount})`)
      if (noProgressCount >= 1) {
        // ===== [G] AUTO-ESCALATE #2 — agent LẶP hành động không tiến triển =====
        // Trước khi bỏ cuộc: hỏi Omega 1 lần duy nhất còn budget. Nếu Omega
        // đưa được cách tiếp cận MỚI → cho 1 chu kỳ cuối theo tư vấn đó
        // (reset noProgress), chỉ dừng hẳn khi consult fail/lặp lại lần 2.
        if (!omegaConsulted && tokenLeft() > REPORT_RESERVE_TOKENS + 8_000) {
          try {
            const { consultOmega } = await import('@/lib/omega-orchestrator')
            const consult = await consultOmega({
              problem: `Agent "${agentName}" bị phát hiện LẶP LẠI hành động không tiến triển (fingerprint chu kỳ ${cycle} trùng chu kỳ trước — dấu hiệu bế tắc kinh điển: agent đang xoay vòng cùng cách tiếp cận đã fail).`,
              context: `Mục tiêu: ${userMessage.slice(0, 800)}\nChẩn đoán trọng tài: ${lastVerdict?.rootCause || '(không rõ)'}\nCòn thiếu: ${lastVerdict?.missing.join('; ') || '(không liệt kê)'}\nAgent này có tools: ${effectiveTools.slice(0, 30).join(', ')}`,
              attempted: `Nhật ký tool gần nhất: ${evidence.slice(-8).map(e => (e.kind === 'tool' ? `${e.tool}(${e.success ? '✓' : '✗'}) ${e.text.slice(0, 60)}` : 'directive').slice(0, 100)).join(' | ')}`,
              callingAgent: agentName,
              severity: 'high',
              autoTriggered: true,
              abortCheck: isCancelled,
              onTokens: (t) => { tokensUsed += t },
            })
            if (consult.success && consult.text) {
              omegaConsulted = true
              escalations++
              omegaAdvisory = consult.text
              noProgressCount = 0
              evidence.push({ cycle, kind: 'directive', text: 'NO-PROGRESS → Omega tư vấn cách tiếp cận MỚI — tiếp tục 1 chu kỳ theo tư vấn thay vì dừng' })
              recordAgentThought(agentSessionId, `🧠 AUTO-ESCALATE (no-progress): Omega đưa cách tiếp cận mới — tiếp tục chu kỳ ${cycle + 1} theo tư vấn thay vì dừng`, totalIterations)
              console.log(`[GoalLoop] ${agentName} no-progress → Omega consult OK (${consult.tokensUsed} tokens) — tiếp tục với kế hoạch mới`)
              // KHÔNG break — cho 1 chu kỳ cuối theo advisory của Omega
            } else {
              stopReason = 'no_progress'
              break
            }
          } catch {
            stopReason = 'no_progress'
            break
          }
        } else {
          // GRACE (fix review 2026-09-08): quota consult đã tiêu (auto-escalate
          // #1 trước đó) — vẫn cho 1 chu kỳ grace cuối trước khi bỏ cuộc;
          // chỉ break khi lặp THẬT SỰ lần 2 (bounded bởi MAX_CYCLES).
          if (noProgressCount >= 2) {
            stopReason = 'no_progress'
            break
          }
        }
      }
    } else {
      noProgressCount = 0
    }
    prevFingerprint = fp

    // ===== [B4] CI-1 CYCLE-LEVEL STALL BRAKE — phanh an toàn chính khi unlimited =====
    // Khi budget = 0 (không giới hạn), budget không còn cắt được loop nữa →
    // phanh chống chạy vô hạn là ĐÂY: đếm chu kỳ LIÊN TIẾP không có tín hiệu
    // tiến triển. "Có tiến triển" = chu kỳ có ÍT NHẤT 1 tool call THÀNH CÔNG
    // (bằng chứng mới xuất hiện trong evidence log). Chủ ý KHÔNG aggressive:
    // agent thử-sai tool rồi đổi cách vẫn là tiến triển; chỉ khi CẢ chu kỳ
    // không có tool call thành công nào mới tính là stall. 3 chu kỳ stall
    // liên tiếp → dừng 'no_progress' + final report tổng kết (kế thừa reserve
    // = 0 khi unlimited nên báo cáo cuối vẫn đủ chỗ viết trọn vẹn).
    const cycleSuccessfulTools = evidence.filter(e => e.cycle === cycle && e.kind === 'tool' && e.success === true).length
    if (cycleSuccessfulTools > 0) {
      if (stallCycles > 0) stallCycles = 0
    } else {
      stallCycles++
      console.warn(`[GoalLoop] ${agentName} STALL: chu kỳ ${cycle} không có tool call thành công nào (${stallCycles}/3 chu kỳ liên tiếp)`)
      recordAgentThought(agentSessionId, `⚠️ Chu kỳ ${cycle} kết thúc mà không có tool call thành công nào — tín hiệu bế tắc ${stallCycles}/3 (quá 3 chu kỳ liên tiếp loop sẽ dừng để tránh chạy vô hạn)`, totalIterations)
      if (stallCycles >= 3) {
        stopReason = 'no_progress'
        break
      }
    }

    // Budget check sau evaluation (đã tốn thêm 1 call)
    if (timeLeft() <= 0) { stopReason = 'time_budget'; break }
    if (tokenLeft() <= REPORT_RESERVE_TOKENS) { stopReason = 'token_budget'; break }

    // CI-5 (Task 14-b) — CHECKPOINT + HEARTBEAT CUỐI MỖI CHU KỲ: ranh giới quan
    // trọng nhất (cyclesDone đã tăng + verdict chu kỳ đã có + escalate/stall
    // brake đã xong) — trước khi chu kỳ kế tiếp bắt đầu. Các đường break sớm
    // (complete / budget / no_progress / cancel) không qua điểm này nhưng đều
    // hội tụ về checkpoint-final ngay trước return của runGoalDrivenLoop.
    fireCheckpoint()
    fireSignal('cycle')

    // Chu kỳ kế tiếp: evaluator đã chẩn đoán + kế hoạch → continuation directive
  }

  // ================== FINAL REPORT ==================

  let content = ''
  /** [B] Final report tổng hợp được dùng thay lastContent dở? */
  let usedFinalReport = false
  if (stopReason === 'cancelled') {
    content = '⏹ Đã dừng tác vụ theo yêu cầu của bạn.'
  } else if (stopReason === 'error' && !lastContent) {
    // Surface lỗi LLM gốc (vd: NVIDIA cạn key) — không nuốt lỗi
    content = `Error: Goal loop LLM failed — ${lastLlmError || lastContent || 'không có nội dung trả về'}`
  } else {
    // FIX (review 2026-09-08): stopReason=error nhưng CÓ work đã làm → không
    // vứt partial work; giữ lastContent + note lỗi, đi tiếp final-report path.
    content = lastContent || '(agent không trả về nội dung)'
    if (stopReason === 'error') {
      content += `\n\n---\n⚠️ Vòng lặp dừng sớm vì lỗi LLM: ${lastLlmError || '(không rõ lỗi)'} — phần trên là kết quả đã làm được trước khi lỗi xảy ra.`
    }
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
        max_cycles: `đã hết ${fmtCap(MAX_CYCLES)} chu kỳ làm việc`,
        time_budget: `hết budget thời gian (${TIME_BUDGET_MS === 0 ? '∞' : `${Math.round(TIME_BUDGET_MS / 60000)} phút`})${cyclesAttempted > cyclesDone ? ' — đang dở giữa chu kỳ ' + cyclesAttempted : ''}`,
        token_budget: `hết budget token (${TOKEN_BUDGET === 0 ? '∞' : TOKEN_BUDGET} — có thể tăng qua env GOAL_LOOP_TOKEN_BUDGET, hoặc đặt GOAL_LOOP_TOKEN_BUDGET=0 để chạy KHÔNG giới hạn)`,
        no_progress: 'phát hiện bế tắc không tiến triển (lặp lại hành động cũ theo fingerprint, hoặc 3 chu kỳ liên tiếp không có tool call thành công nào — stall brake CI-1)',
        error: 'lỗi LLM',
      }
      if (usedFinalReport) {
        // Báo cáo tổng hợp đã có "còn thiếu" + "đề xuất" — chỉ append dòng trạng thái
        content += `\n\n---\n⚠️ **Vòng lặp mục tiêu dừng sau ${cyclesAttempted}/${fmtCap(MAX_CYCLES)} chu kỳ** — ${reasonText[stopReason] || stopReason}. Bạn có thể yêu cầu tiếp tục để tôi khắc phục phần còn thiếu.`
      } else {
        const missing = lastVerdict?.missing?.length ? lastVerdict.missing.map(m => `- ${m}`).join('\n') : '(chưa đánh giá được chi tiết — xem tiến trình ở trên)'
        const rootCause = lastVerdict?.rootCause ? `\n🔍 **Vấn đề xác định:** ${lastVerdict.rootCause}` : ''
        content += `\n\n---\n⚠️ **Vòng lặp mục tiêu dừng sau ${cyclesAttempted}/${fmtCap(MAX_CYCLES)} chu kỳ — chưa hoàn thành trọn vẹn** (${reasonText[stopReason] || stopReason}).\n❌ **Còn thiếu:**\n${missing}${rootCause}\n\nBạn có thể yêu cầu tiếp tục để tôi khắc phục phần còn thiếu.`
      }
    }
  }

  const elapsedMs = Date.now() - startedAt
  console.log(`[GoalLoop] ${agentName} kết thúc: ${stopReason} — ${cyclesAttempted} chu kỳ (${cyclesDone} hoàn thành), ${totalIterations} vòng, ${totalToolCalls} tool calls, ${tokensUsed} tokens, ${Math.round(elapsedMs / 1000)}s${usedFinalReport ? ' + final-report' : ''}${compressions > 0 ? `, ${compressions} lần nén context` : ''}${delegations > 0 ? `, ${delegations} lần delegate (${subagentTokens} tokens sub-agent)` : ''}${escalations > 0 ? `, ${escalations} lần auto-escalate Omega` : ''}`)

  // ===== CI-3 B4 (Task 13-c) — TASK SUMMARY CUỐI RUN (liên tác vụ) =====
  // Mọi stopReason TRỪ crash trắng (error mà không có nội dung gì) → tạo
  // task_summary ~500 chars TÁI DỤNG final report/verdict đã có (0 LLM call
  // thêm — distillTaskSummary deterministic). Lưu 3 nơi, mỗi nơi fail-open
  // riêng (lỗi nơi này không phá nơi khác, KHÔNG bao giờ làm hỏng response):
  //   (a) Kho Context TaskContextArchive kind='task_summary' — AWAIT (nhanh:
  //       1 SQLite insert, kind != 'digest' nên không tốn embed Qdrant) để
  //       test deterministic được;
  //   (b) ChatMessage metadata.taskSummary — qua GoalLoopResult.taskSummary,
  //       chat route merge vào metadata khi persist message cuối run;
  //   (c) AgentMemory WARM (storeMemory category='insight') — fire-and-forget
  //       (embed có thể fail chậm trong sandbox → không await ending path).
  let taskSummary = ''
  if (stopReason !== 'error' || lastContent) {
    try {
      // 'cancelled' → content chỉ là câu thông báo dừng; lastContent là work
      // cuối cùng của agent — tóm tắt cái có thông tin hơn
      const summarySource = stopReason === 'cancelled' && lastContent ? lastContent : content
      taskSummary = distillTaskSummary({
        goal: userMessage,
        finalContent: summarySource,
        stopReason,
        complete: stopReason === 'complete',
        verdictMissing: lastVerdict?.missing,
        rootCause: lastVerdict?.rootCause,
        cycles: cyclesAttempted,
        toolCalls: totalToolCalls,
        elapsedMs,
      })
    } catch { taskSummary = '' /* fail-open */ }

    if (taskSummary && agentSessionId) {
      // (a) Kho Context — run sau trong session recall lại được (buildPriorTaskSummariesBlock)
      try {
        const res = await archiveContext({
          runId,
          sessionId: agentSessionId,
          agentName,
          kind: 'task_summary',
          content: taskSummary,
          tags: 'final-summary',
        })
        if (res.archived) {
          console.log(`[GoalLoop] ${agentName} task_summary đã lưu vào Kho Context (${taskSummary.length} chars, id ${String(res.archiveId ?? '').slice(0, 8)}…) — run sau trong session sẽ nạp làm bức tranh dài hạn`)
        }
      } catch (err) {
        console.warn(`[GoalLoop] ${agentName} lưu task_summary vào Kho Context thất bại (fail-open): ${err instanceof Error ? err.message : String(err)}`)
      }

      // (c) AgentMemory WARM — best-effort fire-and-forget (điều tra Task 13-c:
      // storeMemory là cơ chế WARM sẵn có — SQLite AgentMemory tier='warm' +
      // Qdrant agent_memory; wiring ~12 dòng < ngưỡng 20 dòng nên LÀM)
      if (agentId && agentId !== 'unknown') {
        try {
          void import('@/lib/agent-memory')
            .then(({ storeMemory }) => storeMemory({
              agentId,
              agentName,
              sessionId: agentSessionId,
              category: 'insight',
              content: taskSummary,
              context: userMessage.slice(0, 300),
              importance: 0.9,
              source: 'goal-loop',
              tags: ['task-summary', 'final-summary'],
            }))
            .catch(() => { /* fail-open — WARM là best-effort */ })
        } catch { /* fail-open — dynamic import lỗi không đụng ending path */ }
      }
    }
  }


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

  // ===== Task 20-c — wire metadata THẬT vào AgentRunRecord + resolve verdicts =====
  // Goal-loop là nguồn sự thật lifecycle của chat run (tracker đã bỏ qua qua
  // dbPersistBy:'caller' → 1 run = đúng 1 row): UPDATE row 'running' inserted
  // lúc start bằng đầy đủ metadata (nếu start-insert fail → insert full row);
  // RESOLVE outcome các ArbiterVerdict của session (confirmed/refuted) → dữ
  // liệu Brier/ECE của trọng tài. Toàn bộ fire-and-forget, fail-open.
  if (agentSessionId) {
    try {
      const runComplete = stopReason === 'complete'
      const runStatus = runComplete
        ? 'completed'
        : stopReason === 'error'
          ? 'failed'
          : stopReason === 'cancelled'
            ? 'cancelled'
            : 'completed'
      const toolFailures = evidence.filter(e => e.kind === 'tool' && e.success === false).length
      const endCompletedAt = new Date()
      void (async () => {
        const updated = await updateLatestAgentRunRecord(agentSessionId, {
          status: runStatus,
          stopReason,
          cycles: cyclesAttempted,
          tokensUsed,
          toolCalls: totalToolCalls,
          toolFailures,
          durationMs: elapsedMs,
          evaluatorConfidence: lastVerdict?.confidence ?? null,
          complete: runComplete,
          startedAt: new Date(startedAt),
          completedAt: endCompletedAt,
        })
        if (updated === 0) {
          // Row 'running' lúc start insert thất bại (DB lỗi tạm thời) → insert
          // full row lúc end — vẫn đảm bảo 1 run = 1 row AgentRunRecord
          await insertAgentRunRecord({
            sessionId: agentSessionId,
            agentId,
            agentName,
            status: runStatus,
            stopReason,
            toolCalls: totalToolCalls,
            toolFailures,
            durationMs: elapsedMs,
            complete: runComplete,
            startedAt: new Date(startedAt),
            completedAt: endCompletedAt,
            cycles: cyclesAttempted,
            tokensUsed,
            evaluatorConfidence: lastVerdict?.confidence ?? null,
          })
        }
      })().catch(() => { /* fail-open — metrics không được phép làm hỏng response */ })
      void resolveArbiterVerdicts(agentSessionId, runComplete, stopReason)
        .then(n => {
          if (n > 0) console.log(`[GoalLoop] ${agentName} resolved ${n} arbiter verdict(s) → outcome theo run ${stopReason} (${runComplete ? 'complete' : 'incomplete'})`)
        })
        .catch(() => { /* fail-open */ })
    } catch { /* fail-open */ }
  }

  // ===== A6 · EPISODIC MEMORY — CONSOLIDATE (pipeline A.5, nhịp 4) =====
  // Sau mỗi run: ghi Episode (goal + actions + errors + outcome) vào Neo4j
  // graph + Qdrant semantic index + SQLite mirror; ErrorOccurrence được phân
  // loại root cause (taxonomy R1-R6); lesson sinh/merge từ lỗi đã resolve;
  // lessons PRE-ACT đã áp dụng được validate theo outcome (times_validated
  // /times_failed, confidence ±). Fire-and-forget, fail-open.
  try {
    const { recordEpisodeFromRun, mapOutcome } = await import('@/lib/episodic-memory/recorder')
    const episodeToolEvidence = evidence
      .filter(e => e.kind === 'tool')
      .map(e => ({ cycle: e.cycle, tool: e.tool ?? 'unknown', success: e.success === true, text: e.text ?? '' }))
    const episodeFailures = episodeToolEvidence.filter(e => !e.success).length
    const episodeOutcome = mapOutcome(stopReason, episodeFailures)
    void recordEpisodeFromRun({
      agentName,
      goal: userMessage,
      sessionId: agentSessionId,
      outcome: episodeOutcome,
      confidence: lastVerdict?.confidence ?? 0.5,
      stopReason,
      cycles: cyclesAttempted,
      tokensUsed,
      toolCalls: totalToolCalls,
      startedAt: new Date(startedAt),
      endedAt: new Date(),
      toolEvidence: episodeToolEvidence,
      appliedLessonIds,
    }).then(r => {
      if (r.error) {
        console.warn(`[GoalLoop] ${agentName} episodic memory ghi lỗi: ${r.error}`)
      } else if (r.episodeId) {
        console.log(`[GoalLoop] ${agentName} episodic memory: episode ${r.episodeId} (${episodeOutcome}, ${r.errorsRecorded} errors, ${r.lessonsCreated} lesson mới, ${r.lessonsMerged} merge, ${r.similarEpisodesLinked} SIMILAR_TO, validate ${r.lessonsValidated}✓/${r.lessonsFailed}✗)`)
      }
    }).catch(() => { /* fail-open — episodic memory không được làm hỏng response */ })
  } catch { /* fail-open */ }

  // CI-5 (Task 14-b) — CHECKPOINT CUỐI (final): runGoalDrivenLoop có DUY NHẤT 1
  // return — mọi exit path (complete / max_cycles / budget / no_progress /
  // cancelled / error) đều hội tụ về đây. REVIEW 14-g L4 (sửa doc-code
  // mismatch): worker phân biệt "job XONG" vs "crash giữa chừng" qua STATUS
  // DB (terminal mark chạy sau checkpoint này) — KHÔNG đọc savedAt. Nếu
  // process chết giữa final-checkpoint và terminal mark: sweep requeue →
  // replay 1 "chu kỳ zombie" (chạy lại evaluate/final-report — bounded, không
  // infinite loop vì attempts tăng dần tới max). Checkpoint cuối giúp replay
  // đó hội tụ nhanh (state kết thúc nằm sẵn trong messages snapshot).
  // Fail-open như mọi hook.
  fireCheckpoint()

  return {
    content,
    iterations: totalIterations,
    toolCallsExecuted: totalToolCalls,
    runId,
    /** CI-3 B4 (Task 13-c) — chat route merge vào ChatMessage.metadata.taskSummary */
    taskSummary: taskSummary || undefined,
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
      /** [E] Số lần nén context (rolling digest) trong loop */
      compressions: compressions || undefined,
      /** [F] Delegation stats — số lần gọi sub-agent + token sub-agent tiêu thụ */
      delegations: delegations || undefined,
      subagentTokens: subagentTokens || undefined,
      /** [G] Số lần auto-escalate hỏi Omega orchestrator khi phát hiện bế tắc */
      escalations: escalations || undefined,
    },
  }
}
