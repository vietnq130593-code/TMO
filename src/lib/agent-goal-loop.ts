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

import { callLLMForAgent, type LLMTool } from '@/lib/llm'
import { executeTool, buildCompactToolSchemasSection, resolveToolAlias, getToolDefinitions, getAllBuiltinToolNames } from '@/lib/code-team/tool-executor'
import { parseToolCallsFromOutput, formatMessagesForLLM, detectBrokenToolCallHint, countProviderGarbleMarkers, tryParseLooseJson } from '@/lib/tool-calls'
// TASK 43 — Agent Event Bus: emit sự kiện vòng đời run lên bus hợp nhất
// (GET /api/agent-events) — fail-open tuyệt đối bên trong emit (try/catch).
import { emitAgentEvent } from '@/lib/agent-event-bus'
import { findBalancedJson } from '@/lib/code-team/find-balanced-json'
import {
  startAgentRun,
  endAgentRun,
  recordAgentThought,
  recordAgentRunTodos,
  recordAgentRunTool,
  isSessionCancelled,
} from '@/lib/agent-run-tracker'
// CI-2 (Task 11-a) — auto-complete todo theo bằng chứng tool giữa chừng run
// (helper DB-backed trong TODO section của dev-tools — không đụng git section)
import { autoCompleteRunTodosByEvidence, evidenceMatchesTodo, extractTodoEvidence } from '@/lib/code-team/dev-tools'
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
  truncateToolMessageJson,
} from '@/lib/context-compression'
// ROUND-27 FIX V1 — truncateToolMessageJson chuyển sang context-compression
// (module dùng chung — sub-agent + workflow-engine cùng envelope, chống circular
// import). Re-export giữ compatibility cho verify scratch + caller cũ.
export { truncateToolMessageJson }
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
import { budgetPromptWith } from '@/lib/prompt-budget'
// CI-5 (Task 14-b) — DURABLE GOAL LOOP: contract types dùng chung với worker
// nền (14-a, goal-loop-worker.ts) — TYPE-ONLY import (erased lúc build, 0
// runtime dependency, không circular). Khi `durable` KHÔNG được truyền vào
// runGoalDrivenLoop → mọi hooks inert → hành vi inline cũ GIỮ NGUYÊN 100%
// (đường chat route + tests hiện có không hề hay biết hooks tồn tại).
import type { GoalLoopCheckpoint, GoalLoopDurableHooks } from '@/lib/goal-loop-durable-types'
// ROUND-28 W1 — OBSERVABILITY: revision marker của module này. goal-loop-worker
// dynamic-import runGoalDrivenLoop MỖI JOB và log giá trị này — trong môi
// trường dev (app chạy `next dev` vĩnh viễn + agents tự sửa code), marker cho
// phép đối chiếu trực tiếp trên log rằng job đang chạy code MỚI NHẤT (chống
// "verify giả" khi singleton worker giữ module cũ sau HMR — bằng chứng sống
// job r28v2proof: checkpoint chứa omegaAdvisory nhưng code cũ bỏ qua restore).
// Bump mỗi lần sửa module này một cách có ý nghĩa.
export const GOAL_LOOP_CODE_REV = 'r28w4'

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
 * CI-2 (Task 11-a) — Bằng chứng auto-complete todo ĐÃ CHUYỂN sang module dùng
 * chung dev-tools.ts (extractTodoEvidence + TODO_EVIDENCE_MODIFY_TOOLS —
 * USER DIRECTIVE 2026-09-28 "không bỏ sót đánh dấu hoàn thành"): đường ReAct
 * TMO (đây) và đường CLI inner-loop (/api/tools/execute) cùng 1 bộ evidence,
 * bổ sung gateway_edit/write/apply_patch. Xem dev-tools.ts để biết chi tiết.
 */

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
/**
 * TASK 22 (user directive 2026-09-30 #1 — "cho phép max 100 chu kỳ"): trần
 * tái lập nâng 2 → 100. Hệ thống được thiết kế giải quyết vấn đề HÀNG LOẠT
 * trong thời gian dài + NVIDIA NIM key không giới hạn token → làm việc càng
 * nhiều càng tốt. Khi hết trần MAX_CYCLES mà mục tiêu CHƯA hoàn thành triệt
 * để (verdict chưa complete, hoặc còn lỗi phát sinh liên quan chưa xử lý),
 * loop TÁI LẬP thêm 1 cửa sổ MAX_CYCLES chu kỳ mới — tối đa 100 cửa sổ
 * (MAX_CYCLES=4 → tổng tối đa 4×101=404 chu kỳ; 0 = KHÔNG tái lập).
 * An toàn: tái lập CHỈ xảy ra khi còn budget + chu kỳ vừa rồi CÓ tiến triển
 * (no-progress / stall-brake vẫn cắt như thường trước điểm này) + user chưa
 * cancel → không đẻ vòng lặp vô hạn. Phanh chính: stall-brake 3 chu kỳ
 * không tool call thành công + time budget 12h + nút Dừng của user.
 */
const MAX_CYCLE_RENEWALS = Math.max(0, intEnv('GOAL_LOOP_MAX_CYCLE_RENEWALS', 100))
/**
 * TASK 22 (user directive 2026-09-30 #1) — số chu kỳ debt tối đa / run nâng
 * 3 → 100 (đồng bộ với trần tái lập 100). Với GOAL_LOOP_MAX_CYCLES=0 (∞ —
 * cấu hình .env hiện tại của user) trần chu kỳ KHÔNG bao giờ chạm → debt
 * cycles là cơ chế DUY NHẤT tiếp tục xử lý lỗi phát sinh → 3 đợt là điểm
 * nghẽn thật. 100 đợt = "giải quyết vấn đề hàng loạt" đúng kỳ vọng user
 * (stall-brake + time budget + cancel vẫn cắt như thường); 0 = không chạy
 * debt cycle nào (chỉ ghi nợ Todo).
 */
const MAX_DEBT_CYCLES = Math.max(0, intEnv('GOAL_LOOP_MAX_DEBT_CYCLES', 100))
/** Số vòng ReAct tối đa MỖI chu kỳ (mặc định 10 → tổng tối đa 40 vòng; 0 = ∞ — CI-1) */
const ITER_PER_CYCLE = intEnv('GOAL_LOOP_ITERATIONS_PER_CYCLE', 10)
/**
 * 2026-10 PROCESS INTEGRITY — SAFE CAP FALLBACK cho cap = 0 (∞).
 * User report: "các chu kỳ bị lặp lại y hệt một việc, không có tiến triển thực
 * sự". Cap ∞ (CI-1) + token ∞ = mọi phanh budget vô hiệu; stall brake thì bị
 * vô hiệu hóa trên đường OpenCode CLI (trước đây hard-code success=true cho
 * mọi tool CLI đã chạy — fix cùng đợt). Tai nạn thực tế (e2eb): 18 vòng lặp
 * xác minh (~15 phút, ~3M tokens) cho task 4 bước. Giờ: cap = 0 → fallback
 * TRẦN AN TOÀN thay vì ∞. Muốn ∞ thật: set SAFE_CAP tương ứng = 0.
 *
 * ⚠️ 2026-10 USER DIRECTIVE (lần 2): "không cần đặt giới hạn chu kỳ — đặt
 * giới hạn nhưng thực hiện sai thì cũng chẳng khác gì; vấn đề là năng lực tự
 * phản chiếu trong từng chu kỳ". .env hiện set MAX_CYCLES=0 + ITER=0 +
 * SAFE_CAP_*=0 (= ∞ thật, theo chủ đích). Cơ chế safe-cap GIỮ nguyên cho ai
 * muốn bật lại (set SAFE_CAP > 0) — phanh chất lượng (no-progress fingerprint,
 * signature lặp 4×/8×, in-cycle stall, stagnation, verify-guard) là lớp bảo
 * vệ đúng nghĩa: dừng khi THẬT SỰ kẹt, không dừng theo số đếm.
 */
const SAFE_CAP_CYCLES = Math.max(0, intEnv('GOAL_LOOP_SAFE_CAP_CYCLES', 12))
const SAFE_CAP_ITERATIONS = Math.max(0, intEnv('GOAL_LOOP_SAFE_CAP_ITERATIONS', 8))
/** Giá trị HIỆU DỤNG sau fallback — mọi logic loop dùng 2 biến này (cap = 0
 *  chỉ còn nghĩa "dùng safe cap"; safe cap = 0 mới là ∞ thật). */
const EFFECTIVE_MAX_CYCLES = MAX_CYCLES === 0
  ? (SAFE_CAP_CYCLES > 0 ? SAFE_CAP_CYCLES : 0)
  : MAX_CYCLES
const EFFECTIVE_ITER_PER_CYCLE = ITER_PER_CYCLE === 0
  ? (SAFE_CAP_ITERATIONS > 0 ? SAFE_CAP_ITERATIONS : 0)
  : ITER_PER_CYCLE
/** FIX (review R2-b #1, 2026-08-31) — IN-CYCLE STALL BRAKE: khi ITER_PER_CYCLE=0
 * (∞) + TOKEN_BUDGET=0 (∞), stall-brake/no-progress CHỈ chạy ở biên chu kỳ → 1 chu
 * kỳ có thể đốt cả 12h khi model phát tool call hoài mà không tiến triển. Phanh
 * TRONG chu kỳ: (1) N vòng LIÊN TIẾP không có tool call thành công nào → cắt chu kỳ;
 * (2) fingerprint transcript (check mỗi 10 vòng) lặp 3 lần liên tiếp → cắt chu kỳ.
 * Cắt giữa chừng = endedBy 'iteration_limit' → evaluator vẫn đánh giá + stall-brake
 * biên chu kỳ (3 chu kỳ stall → dừng hẳn) vẫn hoạt động. 0 = tắt phanh in-cycle. */
const IN_CYCLE_STALL_ITERATIONS = Math.max(0, intEnv('GOAL_LOOP_IN_CYCLE_STALL_ITERATIONS', 12))
const IN_CYCLE_FP_CHECK_EVERY = Math.max(1, intEnv('GOAL_LOOP_IN_CYCLE_FP_CHECK_EVERY', 10))
const IN_CYCLE_FP_MAX_REPEATS = Math.max(1, intEnv('GOAL_LOOP_IN_CYCLE_FP_MAX_REPEATS', 3))
/** Budget thời gian toàn bộ loop (mặc định 12 GIỜ — user request 2026-09-13:
 *  "tôi muốn budget này đặt là 12h tối đa thay vì 30 phút như hiện tại"; tác vụ
 *  dài hạn Opus auto-mode cần trần dài — trước đây 30' cắt agent đang tiến
 *  triển tốt giữa chừng; 0 = ∞ — CI-1 "0 = UNLIMITED") */
const TIME_BUDGET_MS = intEnv('GOAL_LOOP_TIME_BUDGET_MS', 12 * 60 * 60_000)
/** Budget token toàn bộ loop. TASK 21 (user 2026-09-30: "NVIDIA NIM key vốn
 *  không giới hạn token, việc hệ thống làm việc càng nhiều càng tốt") →
 *  mặc định 0 = ∞ KHÔNG GIỚI HẠN (CI-1). Phanh an toàn khi unlimited:
 *  no-progress fingerprint + stall-brake 3 chu kỳ + TIME_BUDGET 12h + cancel.
 *  Muốn giới hạn lại: set env GOAL_LOOP_TOKEN_BUDGET=<n>. */
const TOKEN_BUDGET = intEnv('GOAL_LOOP_TOKEN_BUDGET', 0)
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
 * viễn; bound thật của loop = TIME_BUDGET_MS (12h) + TOKEN_BUDGET + user cancel
 * (abortCheck xuyên suốt mọi vòng đợi cooldown).
 */
const LLM_TIMEOUT_MS = intEnvPositive('GOAL_LOOP_LLM_TIMEOUT_MS', 21 * 60_000)
/** Cap ký tự của tool result khi đẩy vào messages (chống context nén) — CI-3 B1: nguồn duy nhất từ module dùng chung */
const MAX_TOOL_RESULT_CHARS = TOOL_RESULT_MAX_CHARS
/** Cap số messages giữa các chu kỳ (trim giữ system + goal + đuôi gần nhất)
 * ROUND-23 P7 — env-tunable (mặc định 48 như cũ): vặn nhỏ GOAL_LOOP_MAX_MESSAGES
 * khi cần ép context mà không cần sửa code. */
const MAX_MESSAGES = intEnvPositive('GOAL_LOOP_MAX_MESSAGES', 48)
/** Cap số dòng evidence log giữ lại cho evaluator */
const MAX_EVIDENCE_ENTRIES = 60
/**
 * FIX (mission #15 evidence 2026-09-30) — cap preview bằng chứng cho evaluator.
 * Trước đây 250 ký tự làm mất nội dung rows/todos (db_query/todo_read chỉ còn
 * "PASS …| đuôi: <80 ký tự>") → trọng tài KHÔNG BAO GIỜ xác minh được
 * id/status/content từng dòng dù output đầy đủ đã nằm trong transcript —
 * root cause chuỗi run needs_input không thoát được (run_1790803610471_1,
 * run_1790806753214_2, run_1790807918140_4). 900 giữ evidence log gọn
 * (≤60 entry × ~900 ≈ tối đa 54k chars, thực tế thấp hơn nhiều) mà các truy vấn
 * nhỏ (vài row) hiện đủ nội dung để đối chiếu.
 */
const EVIDENCE_PREVIEW_MAX_CHARS = 900
/** [C] Tool kiểm định — bằng chứng verify chỉ tính khi tool THÀNH CÔNG */
const VERIFY_TOOLS = new Set(['run_tests', 'lint', 'type_check', 'test_coverage', 'get_diagnostics', 'lsp_diagnostics'])
/** [C] Đọc lại kết quả (file_read/grep sau khi sửa) cũng là kiểm định */
const READBACK_TOOLS = new Set(['file_read', 'grep'])
/**
 * IMP-2 (F4 — điều tra Task F "read-repeat 2-3× trong 4 phút"): bộ tool CHỈ ĐỌC —
 * lặp y hệt args là tín hiệu đọc lại vô ích rõ nhất (kết quả đã nằm trong
 * transcript, context compression làm tăng xác suất re-read). Ngưỡng riêng 3
 * lần (chặt hơn cảnh báo chung 4 / cắt cứng 8): breach → nhắc agent DÙNG kết quả
 * có sẵn thay vì đọc lại (KHÔNG cắt — cắt cứng giữ nguyên ở 8 cho mọi tool).
 */
const READ_REPEAT_TOOLS = new Set(['file_read', 'file_list', 'grep', 'knowledge_search', 'list_custom_tools', 'list_skills', 'mcp_list_servers', 'read_skill', 'read_tool', 'manage_tools', 'get_app_runtime_status', 'todo_read', 'context_recall'])
/** ROUND-12c — tool THUẦN quan sát/lập kế hoạch (không tạo/mutate artifact).
 * Chu kỳ mà MỌI tool call thuộc set này = "planning-only" — streak ≥2 chu kỳ
 * → ép chuyển GĐ2 triển khai (bằng chứng mission audit: chu kỳ 54-67 lặp
 * todo_write + list registry, không file_write/shell/probe nào). */
const PLANNING_LOOP_TOOLS = new Set([...READ_REPEAT_TOOLS, 'todo_write', 'knowledge_graph', 'list_builtin_tools', 'http_get', 'http_read_webpage'])
/** [C] Tool sửa đổi — sau những tool này PHẢI có kiểm định lại trước khi kết luận */
const MODIFY_TOOLS = new Set(['file_edit', 'file_multi_edit', 'file_write', 'file_delete', 'mkdir', 'shell', 'run_bg', 'git_commit', 'delegate_task', 'dispatch_agent', 'dispatch_agents_parallel', 'request_code_team'])
/** FIX 2026-09-14 #7 — tool kiểm định MẠNH (đối lập READBACK chỉ-đọc-again: với
 * thay đổi LOGIC, bằng chứng file_read-only là kiểm định YẾU). */
const STRONG_VERIFY_TOOLS = new Set(['run_tests', 'lint', 'type_check', 'test_coverage'])
/** FIX 2026-09-14 #7 — tool SỬA CODE (đối lập sửa config/data... — dùng cho
 * cảnh báo E2E verification của trọng tài). */
const CODE_MODIFY_TOOLS = new Set(['file_edit', 'file_multi_edit', 'file_write', 'shell', 'run_bg', 'git_commit'])
/** FIX 2026-09-14 #4 — tool DAG task: goal-loop inject sessionId/runId để map DB Todo */
const TASK_DAG_TOOLS = new Set(['decompose_task', 'create_task', 'update_task', 'get_plan'])
/** [D] Tool verify được cap context lớn hơn (cần thấy đủ kết quả test/lint/tsc) */
const VERIFY_RESULT_CHARS = 6000
/**
 * 2026-09-30 (round-10 audit root-cause) — HAI PHANH no_progress/stall của goal
 * loop giờ env-tunable. Mission audit r10 (run_1790755954444_1) chết ở chu kỳ 10
 * vì: (a) chu kỳ chứa tool call THẤT BẠI NHƯNG CÓ THÔNG TIN (chạy checker exit 1
 * → học được file thiếu) bị tính là "không tiến triển" bởi stall brake chỉ đếm
 * call THÀNH CÔNG; (b) fingerprint lặp 2 lần + quota Omega consult đã tiêu →
 * stop. Với nhiệm vụ audit dài, cần cửa sổ rộng hơn — nhưng vẫn bounded (chống
 * chạy vô hạn thật). Điều chỉnh qua env, không cần sửa code:
 *   GOAL_LOOP_STALL_CYCLES        — số chu kỳ stall liên tiếp tối đa (mặc định 3)
 *   GOAL_LOOP_NO_PROGRESS_GRACE   — số lần fingerprint-repeat tối đa (mặc định 2)
 */
const STALL_CYCLE_LIMIT = intEnvPositive('GOAL_LOOP_STALL_CYCLES', 3)
const NO_PROGRESS_GRACE = intEnvPositive('GOAL_LOOP_NO_PROGRESS_GRACE', 2)
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
  maxCycleRenewals: number
  maxDebtCycles: number
} {
  return {
    tokenBudget: TOKEN_BUDGET,
    timeBudgetMs: TIME_BUDGET_MS,
    maxCycles: EFFECTIVE_MAX_CYCLES,
    iterationsPerCycle: EFFECTIVE_ITER_PER_CYCLE,
    reportReserveTokens: REPORT_RESERVE_TOKENS,
    unlimited: TOKEN_BUDGET === 0,
    unlimitedToken: TOKEN_BUDGET === 0,
    unlimitedTime: TIME_BUDGET_MS === 0,
    unlimitedCycles: EFFECTIVE_MAX_CYCLES === 0,
    unlimitedIterations: EFFECTIVE_ITER_PER_CYCLE === 0,
    // TASK 21 — tái lập cửa sổ chu kỳ + chu kỳ debt (metrics/UI hiển thị)
    maxCycleRenewals: MAX_CYCLE_RENEWALS,
    maxDebtCycles: MAX_DEBT_CYCLES,
  }
}

// ==================== ROUND-44 FIX (c) — TEXT TOOL-CALL RECOVERY ====================

/**
 * Tool huy động thường bị agent "NÓI TỚI" bằng văn xuôi thay vì phát cú pháp
 * tool_call (bằng chứng TEST A round-43 — Omega agent_1791223503730_yffcsa:
 * 4 chu kỳ planning-only mô tả "sẽ dùng dispatch_agent cho ALISTA" nhưng 0
 * tool call thật → stall brake cắt sau 1.3M tokens). Nguyên nhân vận hành:
 * model space-bunny-free qua HTTP bỏ qua native FC (body.tools — test
 * 2026-10-30) nên ĐƯỜNG HÀNH ĐỘNG duy nhất là text protocol; model reasoning
 * max hay viết ý định thành văn. Giải pháp: khi chu kỳ chuẩn bị kết thúc
 * 'no_tool_calls' mà content NHẮC đúng tên tool huy động → nudge có SẴN MẪU
 * điền trước cho tool đó (tỷ lệ chấp nhận cao hơn hẳn nudge generic).
 */
const DELEGATION_INTENT_TOOLS = [
  'dispatch_agents_parallel', 'request_code_team', 'dispatch_agent',
  'delegate_task', 'escalate_problem', 'create_agent',
] as const

/** Mẫu cú pháp điền sẵn cho từng intent tool (agent chỉ cần thay nội dung). */
const DELEGATION_INTENT_TEMPLATES: Record<string, string> = {
  dispatch_agent: 'tool_call: dispatch_agent({"agent": "TÊN_AGENT_TỪ_AGENT_ROSTER", "task": "nhiệm vụ cụ thể có tiêu chí kiểm định", "context": "bối cảnh/bằng chứng liên quan"})',
  dispatch_agents_parallel: 'tool_call: dispatch_agents_parallel({"tasks": [{"agent": "TÊN_AGENT", "task": "..."}, {"agent": "TÊN_AGENT", "task": "..."}]})',
  delegate_task: 'tool_call: delegate_task({"agent": "RAMPAGE", "task": "nhiệm vụ cụ thể", "context": "...", "acceptance_criteria": "xong khi..."})',
  request_code_team: 'tool_call: request_code_team({"task": "mục tiêu + phạm vi + ràng buộc", "context": "...", "acceptance_criteria": "xong khi..."})',
  escalate_problem: 'tool_call: escalate_problem({"problem": "vấn đề cụ thể", "context": "...", "attempted": "đã thử gì", "severity": "medium"})',
  create_agent: 'tool_call: create_agent({"name": "TÊN_AGENT", "description": "mô tả vai trò", "instruction": "system prompt chi tiết", "model": "minimaxai/minimax-m3", "tools": ["file_read", "..."]})',
}

/**
 * Phát hiện output CORRUPT tầng provider — marker template lẫn vào content
 * (bằng chứng TEST A round-43 chu kỳ 2 + job r44 cmuw7to9e…: `<]minimax[>[`
 * dày đặc — HTTP 200 nhưng nội dung hỏng, đốt nguyên chu kỳ vô ích).
 * ROUND-44: hàm đếm nằm ở tool-calls.ts DÙNG CHUNG (countProviderGarbleMarkers
 * — import ở đầu file) — mọi parser đều strip marker này trước khi parse.
 */

// ==================== TYPES ====================

export type GoalStopReason =
  | 'complete'
  | 'max_cycles'
  | 'time_budget'
  | 'token_budget'
  | 'no_progress'
  | 'cancelled'
  | 'error'
  /**
   * TASK 48 (đánh giá Multi-step Reasoning Loop — gap fix): mục tiêu bị chặn
   * DUY NHẤT bởi thông tin/ủy quyền/phê duyệt CHỈ người dùng cung cấp được
   * (trọng tài đánh dấu needsInput=true — rule 16 evaluator). Loop dừng SỚM
   * thay vì đốt 2-3 chu kỳ thừa: câu hỏi của agent được trả thẳng về user
   * (lastContent), user trả lời trong chat → run mới bootstrap với câu trả
   * lời trong chat history. Đặc biệt quan trọng cho agent security (Linh
   * Sickyx — ethics rule 4: "không chắc có ủy quyền → HỎI LẠI trước khi hành
   * động") và mọi agent cần credentials/quyết định của user.
   */
  | 'needs_input'

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
  /** FIX 2026-09-14 #9 — lỗi PHÁT SINH ngoài mục tiêu (side issues) trong quá
   * trình làm: tool fail không chạm mục tiêu, lint lỗi file khác, lỗi ngẫu
   * nhiên... Trọng tài quyết định xử lý qua debtDecision. */
  sideIssues: string[]
  /** 'none' = không đáng kể · 'record' = ghi nợ kỹ thuật (Todo follow-up,
   * không chặn hoàn thành) · 'continue' = nghiêm trọng → đề xuất 1 chu kỳ
   * debt mới xử lý ngay (nếu còn chu kỳ + budget). */
  debtDecision: 'none' | 'record' | 'continue'
  /** 2026-10-27 (user directive phiên 4 — GĐ3 readiness): trọng tài xác định
   * lại xem các nợ còn tồn tại ĐÃ CÓ THỂ xử lý ở chu kỳ kế tiếp hay chưa.
   * 'ready' = có đường xử lý trong tầm agent (tool/package/schema/delegate) →
   * quay GĐ0 có ý nghĩa. 'blocked' = chờ điều kiện ngoài (phê duyệt, vendor,
   * agent chưa tạo được) → ghi follow-up chờ điều kiện thay vì debt cycle.
   * Fail-open: thiếu field → coi như 'ready' (giữ hành vi cũ). */
  debtReadiness: 'ready' | 'blocked'
  /** Lý do cụ thể nợ chưa thể xử lý ở chu kỳ kế (khi debtReadiness='blocked'). */
  debtBlockedReason: string
  /**
   * TASK 48 (gap fix — NEEDS-INPUT): trọng tài xác định phần còn thiếu nằm
   * NGOÀI hệ thống — CHỈ người dùng trả lời được (thiếu ủy quyền/scope
   * pentest, credentials, quyết định phương án, thông tin không có trong
   * hệ thống...). true → loop dừng 'needs_input' trả câu hỏi về user.
   * Fail-open: field thiếu/sai → false (giữ hành vi cũ).
   */
  needsInput: boolean
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
Bạn đang chạy trong vòng lặp thực hiện mục tiêu đến khi HOÀN THÀNH. Mỗi chu kỳ làm việc TUÂN THỦ ĐÚNG 4 giai đoạn:

GIAI ĐOẠN 0 — QUAN SÁT & PHÂN TÍCH (BẮT BUỘC trước mọi hành động):
- CHU KỲ ĐẦU (chưa có kết quả tích lũy) → PHÂN TÍCH BỐI CẢNH ĐẦU VÀO, làm ĐÚNG thứ tự:
  (a) TRÍCH YẾU CẦU: mục tiêu cuối cùng cụ thể là gì? TỪNG tiêu chí nghiệm thu (nếu yêu cầu/directive có sẵn khối "Nghiệm thu" — dùng nguyên văn, không tự chế).
  (b) QUÉT MÔI TRƯỜNG LÀM VIỆC: file_list/glob thư mục liên quan, grep từ khóa để biết CÓ GÌ sẵn — KHÔNG ĐOÁN đường dẫn/tên file chưa từng thấy.
  (c) XÁC ĐỊNH BIÊN ĐỘ DỮ LIỆU CẦN THIẾT (viết ngắn 2-4 dòng trước khi làm): cần ĐỌC/KIỂM TRA những gì (file, bảng, cấu hình, hằng số) để triển khai ĐÚNG — và những gì NGOÀI PHẠM VI (KHÔNG đụng — tránh lan man, tốn vòng vô ích).
  (d) Yêu cầu MƠ HỒ / thiếu thông tin quyết định được → nêu GIẢ ĐỊNH rõ ràng (hoặc hỏi lại nếu blocking) TRƯỚC KHI triển khai — không tự chế yêu cầu không có.
- CHU KỲ SAU (đã có kết quả tích lũy) → ĐỌC toàn bộ context: khối "KẾT QUẢ TOOL THẬT" (kết quả inner-loop CLI đã thực thi — đây là SỰ THẬT duy nhất), khối "✅ Việc chu kỳ trước ĐÃ làm" (KHÔNG làm lại), cảnh báo "⚠️ CẢNH BÁO LẶP", khối "📋 TODO HIỆN TẠI", khối "📐 BIÊN ĐỘ DỮ LIỆU đã xác định" (giữ nguyên nếu còn đúng — không mở rộng phạm vi tự tiện), khối "❓ CÒN CHƯA CHẮC" (giả thuyết chưa kiểm chứng từ chu kỳ trước — ƯU TIÊN kiểm định bằng tool hoặc bác bỏ, KHÔNG dùng làm tiền đề kết luận), khối "🧬 BELIEF-STATE" (hypothesis sống từ chu kỳ trước — xem mục ❓ còn chưa chắc có bị bác chưa), khối "🧠 Prior reasoning" (mẩu suy luận run trước — PRIOR KHÔNG phải chân lý, kiểm chứng lại), directive chẩn đoán của trọng tài.
- TỰ PHẢN CHIẾU (viết ngắn gọn trước khi hành động): Hiện trạng đạt được gì (bằng chứng nào)? Còn thiếu gì so với MỤC TIÊU + TIÊU CHÍ NGHIỆM THU? Vì sao cách làm trước chưa đạt (nếu có)?
- XÁC ĐỊNH việc chu kỳ này: PHẢI là việc MỚI có tiến triển — không lặp lại việc đã THÀNH CÔNG, không lặp y hệt việc đã THẤT BẠI (đổi tool / đổi args / đổi cách tiếp cận).

GIAI ĐOẠN 1 — XÁC ĐỊNH VẤN ĐỀ & LẬP KẾ HOẠCH:
- BƯỚC ĐẦU TIÊN của mọi task từ 2 bước trở lên (gần như MỌI task làm việc): gọi todo_write (trên đường CLI là tool tmo_todo) chia nhỏ kế hoạch TRƯỚC KHI hành động — mỗi tiêu chí nghiệm thu ít nhất 1 todo tương ứng (ghi "[Nghiệm thu n]" trong nội dung) + các todo THU THẬP DỮ LIỆU từ bước biên độ dữ liệu. Mỗi todo viết dạng KIỂM ĐỊNH ĐƯỢC (xong = kiểm tra/chạy gì để biết đạt) — đừng viết todo mơ hồ kiểu "xử lý phần X". Bỏ qua todo_write chỉ khi task ĐÚNG 1 bước (một câu hỏi đơn lẻ trả lời ngay). NGOẠI LỆ ƯU TIÊN CAO NHẤT (round-12c): nếu directive chu kỳ có khối "🚨 VÒNG LẶP LẬP KẾ HOẠCH" hoặc "🚨 ÉP TRIỂN KHAI" → kế hoạch ĐÃ ĐỦ — BỎ QUA quan sát/todo_write, tool call ĐẦU TIÊN phải là TRIỂN KHAI (file_write/shell/probe) theo todo in_progress; todo_write chỉ dùng SAU khi có tool triển khai thành công (đóng todo kèm bằng chứng).
- KỶ LUẬT TODO (bắt buộc): todo làm XONG phải được đánh dấu completed NGAY trong lần todo_write kế tiếp TRƯỚC KHI thêm todo mới (đóng việc cũ rồi mới mở việc mới — danh sách luôn phản ánh trạng thái thật). Việc phức tạp cần phân rã tiếp → tạo TODO CON: gọi todo_write với "id" của todo cha trong trường "parentId" của todo con (hiển thị lồng nhau trong panel — KHÔNG viết phẳng trùng nội dung). Cập nhật todo cũ — KHÔNG viết lại từ đầu.
- 🧩 PHÂN LOẠI THEO CHỨC TRÁCH (user directive 2026-10-27): khi lập/kết nạp todo, đối chiếu TỪNG việc với chức trách được thiết kế cho bạn (vai trò của chính mình): việc THUỘC chức trách mình → tự làm bằng tools của mình; việc NGOÀI chức trách (chuyên môn của agents khác: code/review/research/tối ưu/thiết kế... — đối chiếu Agent Roster) → KHÔNG tự làm thay: giao đúng người (Code Team qua delegate_task, agent phù hợp qua dispatch_agent) kèm mô tả nhiệm vụ + tiêu chí nghiệm thu rõ ràng, rồi tổng hợp báo cáo của họ. Bạn là người ĐIỀU PHỐI kết quả đúng chuyên môn — không phải người ôm hết mọi việc.
- Sau khi chốt Todos, ưu tiên delegate từng todo/nhóm todo cho agent phù hợp ngay (đây là việc chính của orchestrator).
- 🔍 KIỂM TRA PHỦ KẾ HOẠCH (harness — determinstic, chạy tự động trong mọi todo_write): hệ thống đối chiếu kế hoạch của bạn với (a) từng tiêu chí NGHIỆM THU của directive — mỗi "[Nghiệm thu n]" phải có ≥1 todo nhắm tới, (b) từng mục "cần đọc" trong khối 📐 — mỗi mục phải có ≥1 todo thu thập dữ liệu. Kết quả nằm trong trường "coverage" của kết quả todo_write: thiếu mục nào sẽ liệt kê CỤ THỂ kèm yêu cầu bổ sung → gọi todo_write BỔ SUNG đúng các mục thiếu ngay (KHÔNG viết lại danh sách); phủ đủ sẽ có dòng ✅. Đây là kiểm tra máy (không tin tự khai) — bỏ qua cảnh báo này khiến evaluator chấm thiếu tiêu chí ở cuối chu kỳ.

GIAI ĐOẠN 2 — TRIỂN KHAI (mỗi hành động đều có suy nghĩ):
- Trước MỖI tool call: hành động này phục vụ tiêu chí nghiệm thu nào? (không gọi tool theo quán tính)
- Sau MỖI kết quả tool: NGHĨ ý nghĩa kết quả — thành công = tiêu chí nào đã đạt? thất bại = nguyên nhân cụ thể là gì (đọc error)? — rồi mới chọn hành động kế.
- 🔧 XỬ LÝ VẤN ĐỀ khi thất bại/vướng (tool fail, kết quả sai, todo blocked): CHẨN ĐOÁN THEO PHÂN LOẠI trước khi thử lại — (i) chưa xác định được nguyên nhân/thiếu bằng chứng → thu thập dữ liệu (đọc error, grep, file_read); (ii) việc quá lớn/chưa phân rã đủ → tách TODO CON; (iii) xung đột ràng buộc hoặc hướng hiện tại KHÔNG THỂ đạt → ĐỔI HƯỚNG (nới lỏng ràng buộc hoặc cách tiếp cận khác), bỏ nhánh không khả thi khỏi kế hoạch. KHÔNG thử lặp Y HỆT quá 2 lần — sau 2 lần fail PHẢI đổi cách xử lý; hết phương án → đánh dấu todo failed/blocked kèm nguyên nhân cụ thể + phương án thay thế (chu kỳ sau đọc và xử lý tiếp).
- Thực hiện từng bước bằng tools. Đọc file (file_read) trước khi sửa. Chạy lệnh (shell) khi cần.
- TẠO FILE MỚI / FILE LỚN: dùng file_write — viết từng phần (~200-400 dòng/lần), lần đầu mode "overwrite", các lần sau mode "append" (đừng nhét cả file 1000+ dòng vào 1 tool call — output dễ bị cắt giữa JSON → tool call KHÔNG thực thi được).

GIAI ĐOẠN 3 — KIỂM ĐỊNH & BÁO CÁO (BẮT BUỘC trước khi kết luận):
- Với tác vụ tạo/sửa file, code, lệnh, dữ liệu: PHẢI kiểm định bằng tool thật — file_read đọc lại kết quả, run_tests / lint / type_check, shell kiểm tra output. Bằng chứng phải nằm trong KẾT QUẢ TOOL.
- Khi type_check/lint/run_tests FAIL: đọc errorCount + thông báo lỗi cụ thể từng file trong KẾT QUẢ TOOL — KHÔNG đoán nguyên nhân; nếu output không đủ để xác định lỗi cụ thể thì báo rõ "không xác định được nguyên nhân cụ thể". Tool fail KHÔNG đồng nghĩa "đã kiểm định".
- XÁC ĐỊNH NỢ KỸ THUẬT → ĐÁNH GIÁ KHẢ NĂNG XỬ LÝ → QUYẾT ĐỊNH LẶP LẠI GĐ0 (user directive 2026-10-27): khi kiểm định, đối chiếu và liệt kê CÁC LỖI PHÁT SINH còn tồn tại (nợ kỹ thuật của chu kỳ — tool fail chưa xử lý, lint/test lỗi ở file đã đụng, hành vi hỏng do thay đổi của chu kỳ tạo ra...). Với từng nợ, XÁC ĐỊNH LẠI xem chu kỳ kế tiếp ĐÃ CÓ THỂ TIẾN HÀNH XỬ LÝ ĐƯỢC CHƯA (đủ tool? đủ quyền? thuộc chức trách mình hay agent khác? còn phụ thuộc điều kiện ngoài — chờ phê duyệt/vendor?): nợ CÓ THỂ xử lý → chu kỳ tiếp QUAY LẠI GĐ0 với TOÀN BỘ nợ được ƯU TIÊN triển khai TRƯỚC, sau đó mới tới phần việc khác; nợ KHÔNG THỂ xử lý được ở chu kỳ kế (thiếu điều kiện ngoài tầm với) → nêu rõ ĐIỀU KIỆN CẦN trong báo cáo để hệ thống ghi nợ follow-up chờ điều kiện thay vì quay GĐ0 vô ích. Trọng tài độc lập sẽ phán quyết việc này từ bằng chứng — hãy phản ánh trung thực từng lỗi còn tồn tại trong báo cáo (không che giấu, không tuyên bố sạch khi chưa kiểm định đủ).
- CHỈ được kết luận hoàn thành khi bằng chứng kiểm định thực sự KHỚP mục tiêu.
- Kết thúc chu kỳ bằng báo cáo đủ 4 phần: đã làm gì · bằng chứng tool (tên tool + kết quả ngắn) · còn thiếu gì · đề xuất khắc phục. Chốt thêm 2 dòng TỰ PHẢN CHIẾU:
  "✅ Đã CHẮC CHẮN (có bằng chứng tool): ..." / "❓ Còn CHƯA CHẮC (giả thuyết cần kiểm tra ở chu kỳ sau): ..." — phân biệt cái đã kiểm chứng với cái còn đoán. Hệ thống GIỮ LẠI các mục ❓ xuyên chu kỳ và nhắc lại ở chu kỳ sau (mục treo ≥2 chu kỳ bị đánh dấu ưu tiên) — viết ❓ THẬT sự cần kiểm chứng, đã kiểm chứng xong thì BỎ KHỎI danh sách.
  ⚖️ NGƯỠC KỸ PHÂN LOẠI (2026-10-20 — E2E lộ agent đếm bằng mắt sai nhưng xếp ✅): dòng ✅ CHỈ được xếp những gì ĐỌC TRỰC TIẾP từ kết quả tool (nội dung file đọc lại khớp, output lệnh hiển thị đúng giá trị). Kết quả GIÁN TIẾP (đếm số dòng/số phần tử, tính tổng, so sánh, suy diễn từ dữ liệu đọc được) PHẢI kiểm định bằng LỆNH MÁY (wc -l, jq length, grep -c...) rồi mới xếp ✅ — kết quả đếm/tính bằng đầu không phải bằng chứng, xếp vào ❓.
  📐 BIÊN ĐỘ DỮ LIỆU: kết thúc báo cáo bằng 1 khối ngắn "📐 BIÊN ĐỘ DỮ LIỆU: cần đọc <...> · ngoài phạm vi <...>" (giữ nguyên khối đã viết ở GĐ0 nếu vẫn đúng) — hệ thống giữ lại nguyên văn cho các chu kỳ sau, không mất định hướng phạm vi.
  🧬 SHR — hypothesis có cấu trúc (tool hypothesis_write):
  - Phát hiện CƠ CHẾ hệ thống (MỘT quan hệ nhân quả về cách hệ thống/tính năng hoạt động) chưa chắc chắn → hypothesis_write op=propose với mechanicsClaim (MỘT quan hệ ≤12 từ) + predictedDelta (dự đoán KIỂM ĐỊNH ĐƯỢC bằng tool). KHÔNG propose chuyện của task ("file X ghi được" là todo, không phải hypothesis).
  - Bằng chứng tool chu kỳ này XÁC NHẬN hoặc BÁC hypothesis cũ (xem khối 🧬 BELIEF-STATE / hypothesis_write op=list) → hypothesis_write op=judge kèm hypothesisId + verdict + evidenceTool + evidenceQuote (trích ngắn từ KẾT QUẢ tool thật) — phán quyết KHÔNG có bằng chứng khớp sẽ bị hệ thống TỪ CHỐI khi đối chiếu cuối chu kỳ.
  📝 ĐỊNH DẠNG BÁO CÁO (user directive 2026-10-20 — kỷ luật hiển thị): báo cáo cho người đọc là văn xuôi tiếng Việt SẠCH, dùng markdown TỐI THIỂU — KHÔNG bọc nhấn mạnh bằng ** hay __, KHÔNG bọc từ ngữ bằng dấu \` hay dấu ' tràn lan (chỉ trích dẫn mã/lệnh thật sự cần). Nhấn mạnh bằng CHỮ IN HOA. Liệt kê bằng gạch đầu dòng "- ". Chỉ dùng khối \`\`\` khi trích dẫn mã/code output thật.

⚠️ Một TRỌNG TÀI ĐỘC LẬP sẽ đánh giá lại kết quả của bạn DỰA TRÊN BẰNG CHỨNG TOOL THẬT. Lời tuyên bố không có bằng chứng sẽ BỊ TỪ CHỐI và bạn phải làm lại ở chu kỳ tiếp theo.
Nếu mục tiêu là câu hỏi kiến thức chung thuần túy (không đòi dữ liệu thật từ hệ thống/file/DB — vd hỏi khái niệm, giải thích, gợi ý) thì chỉ cần trả lời đầy đủ, chính xác — không cần tool. Còn mục tiêu đòi dữ liệu thật (khảo sát/đánh giá/đếm/kiểm tra hiện trạng) → PHẢI thu thập bằng tool, trả lời không bằng chứng sẽ bị trọng tài từ chối.

🧰 TOOL ECONOMY — CHỌN ĐÚNG TOOL CHO TỪNG VIỆC (fix 2026-09-29 — quan sát vận hành: 96% lệnh shell chỉ để ĐỌC bằng sed/awk/grep/cat trong khi tool chuyên biệt có audit ToolMetric + output cấu trúc; knowledge_search 0 lượt dùng; lint/type_check chỉ chạy khi trọng tài đòi):
- 1 THAO TÁC ĐƠN → dùng TOOL CHUYÊN BIỆT, KHÔNG dùng shell thay thế: đọc file/đoạn file → file_read (offset/limit); tìm chuỗi → grep; sửa file → file_edit/file_multi_edit; ghi file mới → file_write. Shell (sed -n/awk/cat/grep trong lệnh) CHỈ dành cho: (a) gộp NHIỀU truy vấn thành 1 batch thật sự, (b) thao tác hệ thống không có tool (process, service, pipe...). Kết quả tool chuyên biệt được hệ thống audit + theo dõi sức khỏe tool; kết quả qua shell không được tính.
- SAU MỖI lần file_edit/file_write/file_multi_edit trên source code → chạy NGAY trong batch kế: lint({"path":"<file vừa sửa>"}) và/hoặc type_check({"path":"<file>"}) — đừng đợi tới cuối chu kỳ (lỗi dồn cục khó sửa hơn lỗi lẻ).
- DOMAIN KHÔNG CHẮC (security pattern, best practice, lỗi hệ thống từng gặp, cách hệ thống khác giải quyết) → knowledge_search TRƯỚC KHI tự kết luận bằng phán đoán (nếu bạn có tool này). Sau khi FIX một bug quan trọng/lỗi hạ tầng → ghi lesson vào KB bằng knowledge_write (nếu có) để agents sau tra cứu được.
- ĐẦU NHIỆM VỤ có tính chất chuyên môn (build app, làm slide/bảng tính/tài liệu, tra cứu web...) → gọi list_skills({}) xem có skill hướng dẫn sẵn không; có → read_skill rồi theo hướng dẫn (nếu bạn có 2 tool này).`
}

/**
 * TASK 43 — OODA PROTOCOL (user audit "vòng OODA: quan sát → định vị → dự
 * đoán → thích ứng"). Khung ra quyết định TỪNG VÒNG hành động — ánh xạ tăng
 * cường lên 4 giai đoạn GĐ0-GĐ3 đã có của goal protocol (không thay thế):
 * mỗi vòng ReAct là 1 vòng OODA hoàn chỉnh, tránh hành động theo quán tính.
 */
function buildOodaProtocol(): string {
  return `

🔄 VÒNG OODA (QUAN SÁT → ĐỊNH VỊ → DỰ ĐOÁN → THÍCH ỨNG — áp cho TỪNG vòng hành động):
- QUAN SÁT (Observe): đọc KẾT QUẢ TOOL vừa về + trạng thái todo + context hiện tại — sự thật mới là gì?
- ĐỊNH VỊ (Orient): kết quả đó thay đổi hiểu biết gì về vấn đề? Đang ở đâu so với mục tiêu + tiêu chí nghiệm thu? Bằng chứng mới mâu thuẫn định kiến chu kỳ trước → bỏ định kiến đó.
- DỰ ĐOÁN (Decide/Predict): hành động kế tiếp DỰ ĐOÁN kết quả gì (kỳ vọng kiểm định được)? Nếu kết quả khác dự đoán — nghĩa là gì, đo từ đâu để biết? Hành động không nói được dự đoán → chưa đáng làm (quán tính).
- THÍCH ỨNG (Adapt): bằng chứng mâu thuẫn giả thuyết → ĐỔI hành động/kế hoạch NGAY — không bám kế hoạch cũ chỉ vì đã viết ra. Đổi hướng sớm rẻ hơn chữa sau.
Vòng OODA rỗng (quan sát mà không định vị / hành động mà không dự đoán) = hành động theo quán tính — sẽ bị cảnh báo lặp phát hiện và trọng tài từ chối bằng chứng.`
}

/**
 * [H] INFRA SELF-SERVICE protocol (user directive 2026-10-27 phiên 4) — quy
 * trình xử lý LỖI HẠ TẦNG / THIẾU TOOL / THIẾU AGENT. Agents giờ ĐƯỢC PHÉP
 * tự cài package + sửa schema + tự xây tool; việc thuộc chức trách agent khác
 * → delegate; thiếu agent → escalate Omega tạo agent mới. Inject cho MỌI agent
 * chạy goal-loop (nội dung tự điều chỉnh theo tool có trong whitelist).
 */
function buildInfraSelfServiceProtocol(): string {
  return `

🔧 XỬ LÝ LỖI HẠ TẦNG & THIẾU TOOL/AGENT (chính sách 2026-10-27 — TỰ PHỤC VỤ theo thứ tự):
💡 Nếu API hỗ trợ native tool_calls (function calling) → ƯU TIÊN dùng native tool_calls thay vì viết văn bản "tool_call: ..." (văn bản protocol dưới đây chỉ dành cho API không có native tool_calls).
Khi vướng lỗi hạ tầng / thiếu thư viện / thiếu tool / việc ngoài chức trách của bạn — xử lý THEO THỨ TỰ sau (KHÔNG dừng ở bước đầu):
1. THIẾU PACKAGE (module not found, dependency lỗi) → TỰ CÀI: tool_call: manage_packages({"action":"add","packages":["tên-package"]}) hoặc shell "bun add tên-package" — ĐÃ ĐƯỢC PHÉP tự làm (chính sách 2026-10-27).
2. CẦN SỬA DB SCHEMA (thiếu bảng/cột cho việc đang làm) → TỰ SỬA: file_edit/file_write prisma/schema.prisma → shell "bun run db:push" → shell "bun run db:generate" (regenerate client). KHÔNG ghi tay file trong db/ (data) — chỉ qua prisma.
3. THIẾU TOOL HOÀN TOẢN (không có tool nào làm được việc này) → xác định CHÍNH XÁC loại tool thiếu là gì → TỰ XÂY: tool_call: list_custom_tools({}) kiểm tra chưa có → tool_call: create_custom_tool({"name":"...","description":"...","parameters":{...},"handlerCode":"function handler(args){...}"}) → tool mới ĐĂNG KÝ VÀO hệ thống TMO (tab Tools/Skills của module Smolab) và GỌI ĐƯỢC NGAY: tool_call: tên_tool({...}) — dùng triển khai tiếp công việc làm dở, không cần restart.
4. VIỆC THUỘC CHỨC TRÁCH AGENT KHÁC (code/review/research/tối ưu/thiết kế — đối chiếu Agent Roster) → GỌI AGENT đó: delegate_task / dispatch_agent kèm nhiệm vụ + tiêu chí nghiệm thu rõ ràng.
5. CHƯA CÓ AGENT thuộc chức trách đó (đã kiểm tra Agent Roster) → tool_call: escalate_problem({"problem":"...","context":"..."}) — OMEGA sẽ phân tích và TẠO AGENT MỚI có chức trách xử lý vấn đề (agent mới tự cập nhật vào module Agents + Agent Roster) rồi điều phối xử lý.
CHỈ escalate chờ phê duyệt đối với phần VẪN ĐƯỢC BẢO VỆ: .env/keys, file data db/, opencode.json, .opencode/, mini-services/, config hệ thống — phần này KHÔNG tự sửa.`
}

/**
 * [F] SUB-AGENT DELEGATION protocol — chỉ append khi agent CÓ delegate_task
 * trong tool whitelist (vd Omega). Hướng dẫn khi nào chia việc cho Code Team
 * + kỷ luật kiểm định lại kết quả sub-agent (verify-guard vẫn áp vì
 * delegate_task nằm trong MODIFY_TOOLS).
 */
function buildDelegationProtocol(): string {
  // IMP-2 (G — điều tra Task G "Omega 0.29% delegation / 30 ngày"): 2 nudge
  // chống delegate được nới lại — (a) ngưỡng "KHÔNG delegate việc 1-2 bước" chặn
  // mất phần lớn việc thật (mọi việc ≥3 bước / ≥2 file giờ NÊN delegate);
  // (b) cảnh báo token-budget chỉ có nghĩa khi budget HỮU HẠN (GOAL_LOOP_TOKEN_
  // BUDGET>0) — agent ∞ budget (mặc định CI-1) đọc cảnh báo thành lý do KHÔNG
  // delegate (noise vô nghĩa với nó).
  const tokenNote = TOKEN_BUDGET > 0
    ? '- Token sub-agent tiêu thụ cộng vào budget của bạn — scope task rõ ràng, không delegate task mờ hồ to đùng.'
    : '- Budget token của bạn hiện KHÔNG giới hạn — mạnh dạn delegate đúng người; scope task vẫn phải rõ ràng (task mờ hồ to đùng khó đạt tiêu chí nghiệm thu).'
  return `

📦 PHÂN CÔNG SUB-AGENT (delegate_task — Code Team chuyên trách):
- RAMPAGE: implement code · SENTINEL: review/bug/security · CATALYST: tối ưu/refactor · SHOCWAVE: thiết kế kiến trúc/DB/API · MEGATRON: phân tích + verify tổng thể · FORGE: full-stack builder END-TO-END (UI + API + DB + tự kiểm định + preview verify) — tính năng trọn gói tự chứa. (TASK 48: agent security "Linh Sickyx" giờ là standalone ĐỘC LẬP — KHÔNG nằm trong delegate_task; cần security work → dispatch_agent.)
- Cú pháp: tool_call: delegate_task({"agent": "RAMPAGE", "task": "Nhiệm vụ cụ thể...", "context": "file liên quan, ràng buộc...", "acceptance_criteria": "điều kiện hoàn thành kiểm định được"})
- NÊN delegate khi: task cần đọc/sửa NHIỀU file (làm trực tiếp sẽ phình context của bạn), cần chuyên môn sâu, hoặc task giao trọn được cho 1 agent.
- NÊN delegate khi việc ≥3 bước hoặc đụng ≥2 file; chỉ tự làm việc 1 bước trivial.
- 🔄 FAN-OUT: nhiều delegation ĐỘC LẬP trong 1 message → hệ thống tự chạy SONG SONG + hợp nhất kết quả (không cần đợi tuần tự).
- ⚖️ TRỌNG TÀI ĐỘC LẬP chấm từng delegation (field "evaluation" trong kết quả): pass=false + gaps[] = sub-agent CHƯA đạt theo tiêu chí — đọc gaps và khắc phục phần còn thiếu (tự làm hoặc delegate lại), KHÔNG tin report tự chấm của sub-agent.
- Báo cáo sub-agent quay về dạng NÉN (đã làm · bằng chứng · còn thiếu) — ĐỌC kỹ "còn thiếu". Với kết quả QUAN TRỌNG, tự KIỂM ĐỊNH LẠI bằng tool của bạn (file_read/lint/type_check) trước khi kết luận.
${tokenNote}`
}

/**
 * [F2] CODE TEAM SOP REQUEST protocol (user directive 2026-09-30 #2) — chỉ
 * append khi agent CÓ request_code_team trong whitelist (Opus/Omega/
 * standalone). Hướng dẫn phân biệt với delegate_task + kỷ luật đọc báo cáo
 * pipeline (verify-guard áp vì request_code_team nằm trong MODIFY_TOOLS).
 */
function buildCodeTeamProtocol(): string {
  return `

🏗 HUY ĐỘNG TOÀN CODE TEAM THEO SOP (request_code_team):
- DÙNG KHI: tác vụ code PHỨC TẠP, KHỐI LƯỢNG LỚN — tính năng hoàn chỉnh nhiều module/file, kiến trúc mới, cần nhiều VAI tuần tự (thiết kế → code → review → tối ưu → verify) hoặc cần chất lượng đảm bảo bởi pipeline kiểm định nhiều tầng.
- KHÔNG dùng: task nhỏ 1-2 file (delegate_task 1 agent hoặc tự làm nhanh hơn), câu hỏi/phân tích không cần code.
- Cú pháp: tool_call: request_code_team({"task": "Yêu cầu đầy đủ gửi TL: mục tiêu, phạm vi, ràng buộc, điều kiện hoàn thành", "context": "...", "acceptance_criteria": "xong khi..."}) — có thể kèm "mode" (A=UI/B=backend/C=hybrid) + "tier" (1/2/3) nếu BIẾT CHẮN routing; không truyền thì TL TỰ PHÂN TÍCH (chuẩn SOP).
- Quy trình sau khi gọi: TL (MEGATRON) nhận yêu cầu → phân tích routing → TOÀN TEAM vận hành (G1 thiết kế → G2-A code → G2-B review/fix → G3 tối ưu theo routing) → checkpoint verify từng bước → bạn nhận BÁO CÁO NÉN toàn pipeline.
- Tool CHẠY DÀI (phút → chục phút) — gọi ĐÚNG 1 LẦN cho 1 tác vụ, KHÔNG gọi lặp khi đang chờ.
- 🧬 CLONE-FIRST (user directive 2026-09-15): workspace root của team là THƯ MỤC CLONE của TMO chính thức (env TMO_CLONE_DIR) — an toàn để sửa + commit. Khi giao task sửa code HỆ THỐNG: ghi rõ "thực hiện trên workspace clone, chạy kiểm định (lint/type_check/run_tests) trước khi commit". Team sửa + kiểm định trên CLONE → PASS mới git_push lên GitHub → hệ thống đang vận hành cập nhật bằng git_pull riêng sau đó. KHÔNG kết luận "nâng cấp thành công" khi pipeline kiểm định chưa PASS.
- Sau khi nhận báo cáo: đọc "status" + từng bước (issues/unfixedBugs) — workflow ESCALATE/failed hoặc còn unfixedBugs → khắc phục phần còn lại bằng tools của mình (file_read/lint/type_check kiểm định lại) rồi mới kết luận.`
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
  lines.push('- Gặp vấn đề / kẹt / lặp lỗi: tool_call: escalate_problem({"problem": "vấn đề cụ thể", "context": "...", "attempted": "đã thử gì", "severity": "low|medium|high"}) → OMEGA phân tích căn nguyên + cân nhắc các phương án → trả TƯ VẤN TỐT NHẤT. Nếu Omega đề xuất điều agent: hệ thống TỰ ĐỘNG ĐIỀU ĐỘNG agent đó NGAY trong cùng tool call (auto-apply — kết quả kèm trong "autoApplied"), bạn không phải gọi dispatch_agent lại.')
  lines.push('- NHẬN DIỆN SỚM (quan trọng): tool fail 2 lần cùng lỗi / cùng hành động lặp lại / task cần chuyên môn ngoài vòng của bạn (đối chiếu Agent Roster) → escalate NGAY khi có dấu hiệu đầu tiên, đừng chờ kẹt hẳn. Vấn đề được giải từ trước rẻ hơn chữa sau.')
  lines.push('- Escalate xong: LÀM THEO tư vấn của Omega (đổi cách tiếp cận / điều agent khác / dùng tool theo hướng dẫn mới) — không lặp lại cách cũ đã fail.')
  if (hasDispatch) {
    lines.push('- Điều động agent BẤT KỲ trong Agent Roster: tool_call: dispatch_agent({"agent": "TÊN", "task": "nhiệm vụ cụ thể", "context": "..."}) — agent chạy tự chủ, trả báo cáo nén (context của bạn không phình). Điều LÂU DÀI vào team: thêm {"duration": "long_term", "team": "code", "position": "G4"}.')
    lines.push('- NHIỀU việc ĐỘC LẬP: tool_call: dispatch_agents_parallel({"tasks": [{"agent": "MEGATRON", "task": "..."}, {"agent": "SENTINEL", "task": "..."}]}) — tối đa 4 task/lần, chạy song song tối đa 3 sub-agent cùng lúc (mỗi sub-agent tự động ghim 1 API key riêng — user directive 2026-10-29b), kết quả hợp nhất về 1 báo cáo; xung đột (cùng đụng 1 file) được liệt kê trong "conflicts" — tự phân xử.')
  }
  if (hasCreate) {
    lines.push('- Hệ thống THIẾU agent có kỹ năng phù hợp (đã kiểm tra Agent Roster): tool_call: create_agent({"name": "...", "description": "mô tả vai trò", "instruction": "system prompt chi tiết", "model": "minimaxai/minimax-m3", "avatar": "🤖", "temperature": 0.7, "maxTokens": 4096, "tools": ["file_read", "..."]}) — agent mới hiện trong module Agents, giao việc NGAY qua dispatch_agent.')
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
    lines.push('- Tạo cron job (KHUYẾN KHÍCH lịch dựng sẵn — Ngày/Tuần/Tháng, nhiều giờ, Lặp):')
    lines.push('  tool_call: manage_automation({"action": "create_cron", "taskPrompt": "nhiệm vụ", "schedule": {"mode": "day|week|month", "times": ["09:30", "14:00"], "daysOfWeek": [1, 3], "daysOfMonth": [1, 15], "repeat": true}, "executor": "" | "RAMPAGE" | "team:code"})')
    lines.push('  → mode+repeat: day=hàng ngày · week=hàng tuần vào các thứ (0=CN..6=T7) · month=hàng tháng vào các ngày 1-31; repeat=false → chạy ĐÚNG 1 LẦN; executor = agent thực thi ("team:xxx" → TL của team đó điều phối triển khai toàn bộ tác vụ, "" = Automation Agent mặc định).')
    lines.push('  (Lịch đặc biệt mới dùng expression thô: {"action": "create_cron", "expression": "0 9 * * 1-5", "taskPrompt": "..."})')
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
    lines.push('  cron payload KHUYẾN KHÍCH: {"taskPrompt": "...", "schedule": {"mode": "day|week|month", "times": ["09:30"], "daysOfWeek": [1, 3], "repeat": true}, "executor": "RAMPAGE" | "team:code" | ""} (executor = agent thực thi — "team:xxx" → TL điều phối toàn bộ tác vụ).')
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
  /** CODE TEAM SOP (2026-09-30): request_code_team (huy động toàn team theo SOP) */
  hasCodeTeamRequest?: boolean
  /** TOOL SCHEMAS (2026-09-30): schema compact của whitelist tools — model gọi đúng param */
  toolSchemasBlock?: string
  /** nhãn context cho log 1 dòng khi có cut */
  agentName?: string
  /**
   * 2026-10-27 (user directive — trần prompt THEO TÁC VỤ): override budget ký
   * tự cho ĐÚNG tác vụ này. -1 (hoặc ≤0) = KHÔNG GIỚI HẠN; undefined = dùng
   * mặc định hệ thống SYSTEM_PROMPT_BUDGET_CHARS.
   */
  promptBudgetChars?: number
}): string {
  const { systemPrompt, hasDelegation, hasOrchestration, hasDispatch, hasCreate, preActBlock, agentName } = params
  try {
    return budgetPromptWith(
      [
        { name: 'base', content: systemPrompt, priority: 10 },
        { name: 'goalProtocol', content: buildGoalProtocol(), priority: 100 },
        // TASK 43 — OODA: khung ra quyết định từng vòng (áp MỌI agents goal-loop)
        { name: 'oodaProtocol', content: buildOodaProtocol(), priority: 95 },
        // 2026-10-27 (E2E lộ bug): toolSchemas phải cùng tier bảo vệ CAO NHẤT với
        // goalProtocol — budget chật từng stub block này (log: "cut ...toolSchemas...")
        // → agent KHÔNG còn biết tool nào để gọi → run 0 tool calls, đứng im trả
        // 1 câu chung chung. Mất schema là mất toàn bộ năng lực hành động —
        // không bao giờ được hy sinh để tiết kiệm token.
        { name: 'toolSchemas', content: params.toolSchemasBlock ?? '', priority: 100 },
        { name: 'delegationProtocol', content: hasDelegation ? buildDelegationProtocol() : '', priority: 90 },
        // 2026-10-27 (user directive phiên 4): INFRA SELF-SERVICE — quy trình xử
        // lý lỗi hạ tầng/thiếu tool/thiếu agent cho MỌI agent goal-loop.
        { name: 'infraSelfService', content: buildInfraSelfServiceProtocol(), priority: 89 },
        { name: 'codeTeamProtocol', content: params.hasCodeTeamRequest === true ? buildCodeTeamProtocol() : '', priority: 88 },
        { name: 'orchestrationProtocol', content: hasOrchestration ? buildOrchestrationProtocol(hasDispatch, hasCreate) : '', priority: 80 },
        { name: 'automationProtocol', content: buildAutomationProtocol(params.hasAutomationDirect === true, params.hasAutomationPropose === true), priority: 78 },
        { name: 'confidenceProtocol', content: buildConfidenceProtocol(), priority: 70 },
        { name: 'preAct', content: preActBlock, priority: 60 },
      ],
      params.promptBudgetChars,
      `goal-loop:${agentName || 'agent'}`,
    )
  } catch (err) {
    // FAIL-OPEN — lỗi budget: ghép nguyên bản như cũ (không cut)
    console.warn(
      `[GoalLoop] prompt budget thất bại (fail-open — system prompt nguyên bản): ${err instanceof Error ? err.message : String(err)}`,
    )
    return (
      systemPrompt +
      (params.toolSchemasBlock ? '\n' + params.toolSchemasBlock : '') +
      buildGoalProtocol() +
      buildOodaProtocol() +
      buildInfraSelfServiceProtocol() +
      (hasDelegation ? buildDelegationProtocol() : '') +
      (params.hasCodeTeamRequest === true ? buildCodeTeamProtocol() : '') +
      (hasOrchestration ? buildOrchestrationProtocol(hasDispatch, hasCreate) : '') +
      buildAutomationProtocol(params.hasAutomationDirect === true, params.hasAutomationPropose === true) +
      buildConfidenceProtocol() +
      preActBlock
    )
  }
}

/**
 * 2026-10 SELF-REFLECTION AUDIT (Task 19) — TODO HIỆN TẠI CỦA RUN.
 *
 * Gap phát hiện: protocol GIAI ĐOẠN 0 bảo agent "đọc todo hiện tại" nhưng
 * harness KHÔNG BAO GIỜ render todo vào directive nối tiếp — với đường CLI
 * (mỗi spawn = session mới hoàn toàn), agent chu kỳ sau KHÔNG THẤY todo mình
 * đã viết ở chu kỳ trước → plan bị mất liên tục giữa các chu kỳ (vi phạm
 * nguyên tắc R2 "belief-state nén xuống R1" của SELF_REFLECTION_DESIGN —
 * trạng thái kế hoạch phải đi cùng agent qua chu kỳ).
 *
 * Fix: trước khi inject continuation directive, đọc todo của ĐÚNG run này từ
 * DB → render khối "📋 TODO HIỆN TẠI" (chỉ dòng MỞ, thụt lề theo cây cha–con —
 * TASK 21-d) đính kèm directive. Fail-open tuyệt đối (DB lỗi → block rỗng, hành
 * vi cũ). Chỉ hiện tối đa 15 todo mở — đủ bức tranh, không phình context.
 */
async function buildRunTodosBlock(sessionId: string | null | undefined, runId: string | null | undefined): Promise<string> {
  if (!sessionId || !runId) return ''
  try {
    const { db } = await import('@/lib/db')
    // TASK 21-d (rà soát sau triển khai): load TẤT CẢ todo của run (không chỉ
    // mở) — cần cả todo completed để tính độ sâu cha–con (todo mở có cha đã
    // xong vẫn hiển thị thụt đúng cấp). Render: chỉ dòng MỞ, indent theo cây.
    const all = await db.todo.findMany({
      where: { sessionId, runId },
      orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
      take: 40,
    })
    if (all.length === 0) return ''
    const byId = new Map(all.map(t => [t.id, t]))
    const depthOf = (t: { id: string; parentId: string | null }, seen = new Set<string>()): number => {
      let d = 0
      let cur = t
      while (cur.parentId && byId.has(cur.parentId) && !seen.has(cur.parentId) && d < 4) {
        seen.add(cur.parentId)
        cur = byId.get(cur.parentId)!
        d++
      }
      return d
    }
    const open = all.filter(t => t.status === 'pending' || t.status === 'in_progress' || t.status === 'blocked')
    if (open.length === 0) return ''
    // Ops log (2026-10-20 Task 20): xác nhận TODO block thực sự render —
    // quan sát được trong dev.log khi audit hành vi đa chu kỳ.
    const nested = open.filter(t => depthOf(t) > 0).length
    console.log(`[GoalLoop] TODO block: ${open.length} todo mở (${nested} con lồng nhau) của run ${runId} → đính kèm directive chu kỳ sau`)
    const lines = open.map(t => {
      const tag = t.status === 'in_progress' ? '[ĐANG LÀM] ' : t.status === 'blocked' ? '[KẸT] ' : ''
      const d = depthOf(t)
      return `${'  '.repeat(d)}${d > 0 ? '↳ ' : '- '}${tag}${t.content.slice(0, 140)}`
    })
    return `\n\n📋 TODO HIỆN TẠI CỦA RUN (trạng thái kế hoạch còn mở — cập nhật bằng todo_write: đóng mục xong, KHÔNG viết lại từ đầu; việc lồng nhau thụt lề là TODO CON của việc trên nó):\n${lines.join('\n')}`
  } catch { return '' /* fail-open — todo không được phép làm hỏng loop */ }
}

/**
 * 2026-10-27 (user directive — CƠ CHỂ XỬ LÝ NỢ Todo follow-up TẠI THỜI ĐIỂM
 * RÕ RẰNG): Todo follow-up (nợ kỹ thuật — trọng tài ghi khi run cũ kết thúc
 * còn side issues ngoài quyền) trước đây CHỈ được ghi ra DB rồi "ngủ" — không
 * có thời điểm nào hệ thống nhặt lên xử lý. Giờ: THỜI ĐIỂM XỬ LÝ = ĐẦU MỖI RUN
 * MỚI trong cùng session. Harness đọc các Todo follow-up pending từ các run
 * TRƯỚC (source arbiter_side_issue, loại run hiện tại) → render khối ưu tiên
 * đặt TRƯỚC user message của run mới → agent phải xử lý nợ TRƯỚC việc mới.
 *
 * Mỗi mục kèm id để agent ĐÓNG ĐÚNG row bằng todo_write({id, status}) —
 * todoWrite update-by-id không đổi runId gốc (chỉ backfill khi null) nên
 * không giành todo về run hiện tại. Fail-open tuyệt đối.
 */
export async function buildPendingDebtBlock(sessionId: string | null | undefined, currentRunId: string | null): Promise<string> {
  if (!sessionId) return ''
  try {
    const { db } = await import('@/lib/db')
    const pending = await db.todo.findMany({
      where: {
        sessionId,
        // 2026-10-27 (rà soát Task 27-a): nhặt cả nợ đang 'in_progress'/'blocked'
        // — run trước chết giữa lúc xử lý nợ thì nợ kẹt ở trạng thái đó, không
        // archive được (được bảo vệ) cũng không pending → không được bỏ lại ngủ
        // vĩnh viễn; run mới nhặt lại và xử lý tiếp.
        status: { in: ['pending', 'in_progress', 'blocked'] },
        content: { startsWith: '🔁 Follow-up' },
      },
      orderBy: { createdAt: 'asc' },
      take: 10,
    })
    // Chỉ nợ từ các run KHÁC (run hiện tại chưa tồn tại nợ — filter JS cho
    // an toàn với runId null của data cũ)
    const debt = pending.filter(t => t.runId !== currentRunId)
    if (debt.length === 0) return ''
    console.log(`[GoalLoop] NỢ KỸ THUẬT: nhặt ${debt.length} Todo follow-up còn treo từ các run trước trong session ${sessionId} → ưu tiên xử lý đầu run`)
    const lines = debt.map(t => `- [id ${t.id}] ${t.content.replace(/^🔁 Follow-up \([^)]*\):\s*/, '')}`)
    return `[📋 NỢ KỸ THUẬT CÒN TREO — ƯU TIÊN XỬ LÝ TRƯỚC VIỆC MỚI (user directive 2026-10-27)]
Các run trước trong phiên này còn ${debt.length} nợ kỹ thuật chưa xử lý (trọng tài đã ghi Todo follow-up). Thứ tự ưu tiên SẮT của run này:
1. XỬ LÝ TOÀN BỘ nợ dưới đây TRƯỚC TIÊN (đưa từng mục vào todo_write kế hoạch, đặt TRƯỚC các việc mới).
2. Xử lý xong mục nào → gọi todo_write với ĐÚNG "id" của mục đó + status "completed" (đóng row cũ — KHÔNG tạo row trùng nội dung).
3. Mục nào vẫn nằm ngoài quyền sửa (phần hạ tầng VẪN ĐƯỢC BẢO VỆ: .env/keys, file data db/, opencode.json, .opencode/, mini-services/ — hoặc chờ phê duyệt / vendor bên thứ 3) → trước khi kết luận ngoài quyền, HÃY KIỂM TRA đã thử đủ đường tự phục vụ chưa: cài package (manage_packages), sửa schema (file_edit prisma/schema.prisma + bun run db:push), tự xây tool thiếu (create_custom_tool), gọi agent đúng chức trách (dispatch_agent), escalate Omega tạo agent mới (escalate_problem). Chỉ khi THẬT SỰ thiếu điều kiện ngoài tầm với → nêu rõ trạng thái + ĐIỀU KIỆN CẦN trong báo cáo, KHÔNG xóa bỏ.
4. Hết nợ mới làm việc mới của yêu cầu hiện tại.
${lines.join('\n')}`
  } catch { return '' /* fail-open — nợ kỹ thuật không được phép làm hỏng run mới */ }
}

// ==================== 2026-10-27 (user directive phiên 3) — DELEGATION LOG ====================
// Trong 1 chu kỳ, MỖI LẦN agent gọi agent khác xử lý một công việc/tác vụ phải
// ghi rõ vào Thought Progress 3 thông tin: (1) gọi agent nào, (2) xử lý tác vụ
// gì, (3) agent đó đã triển khai tác vụ đó NHƯ THẾ NÀO (vòng ReAct / tool
// calls / tokens / tóm tắt kết quả). Thought 📤 ghi NGAY TRƯỚC khi launch,
// thought 📥 ghi khi sub-agent hoàn tất (kết quả đầy đủ) — người quản trị theo
// dõi được toàn bộ chuỗi giao-việc mà không phải mở log server.
const DELEGATION_LOG_TOOLS = new Set(['delegate_task', 'dispatch_agent', 'dispatch_agents_parallel', 'request_code_team'])

/** Nén chuỗi hiển thị: trim + gộp whitespace + cắt n ký tự */
function dlClip(s: unknown, n = 160): string {
  return typeof s === 'string' && s.trim() ? s.trim().replace(/\s+/g, ' ').slice(0, n) : ''
}

/** Thought 📤 — ghi NGAY TRƯỚC khi launch delegation (ai giao ai làm gì) */
function buildDelegationDispatchThought(cycle: number, parentAgent: string, tc: { name: string; args: Record<string, unknown> }): string | null {
  if (tc.name === 'delegate_task' || tc.name === 'dispatch_agent') {
    const agent = String(tc.args?.agent ?? tc.args?.agentName ?? '?')
    const task = dlClip(tc.args?.task ?? tc.args?.description)
    if (!task) return null
    const acc = dlClip(tc.args?.acceptance_criteria, 120)
    return `📤 Chu kỳ ${cycle} — PHÂN CÔNG: ${parentAgent} gửi agent [${agent}] xử lý "${task}"${acc ? ` — tiêu chí nghiệm thu: ${acc}` : ''} — chờ sub-agent tự chủ triển khai, kết quả sẽ ghi nhận khi hoàn tất`
  }
  if (tc.name === 'dispatch_agents_parallel') {
    const tasks = Array.isArray(tc.args?.tasks) ? (tc.args.tasks as Array<Record<string, unknown>>) : []
    const lines = tasks
      .map(x => {
        const t = dlClip(x.task, 90)
        return t ? `[${String(x.agent ?? '?')}] "${t}"` : ''
      })
      .filter(Boolean)
      .slice(0, 4)
    if (lines.length === 0) return null
    return `📤 Chu kỳ ${cycle} — PHÂN CÔNG SONG SONG: ${parentAgent} gửi ${tasks.length} agent cùng lúc — ${lines.join(' · ')}`
  }
  if (tc.name === 'request_code_team') {
    const task = dlClip(tc.args?.task)
    if (!task) return null
    return `📤 Chu kỳ ${cycle} — HUY ĐỘNG CODE TEAM: ${parentAgent} gửi toàn team code (TL phân tích routing, pipeline 5-7 bước) xử lý "${task}"`
  }
  return null
}

/** Thought ⛔ — phân công bị từ chối (budget/permission) — giám sát cần biết việc giao không tới được agent */
function buildDelegationRefusedThought(cycle: number, parentAgent: string, tc: { name: string; args: Record<string, unknown> }, reason: string): string | null {
  if (!DELEGATION_LOG_TOOLS.has(tc.name)) return null
  const agent = String(tc.args?.agent ?? tc.args?.agentName ?? (Array.isArray(tc.args?.tasks) ? `${(tc.args.tasks as unknown[]).length} agent` : 'code-team'))
  const task = dlClip(tc.args?.task ?? tc.args?.description, 100)
  return `⛔ Chu kỳ ${cycle} — PHÂN CÔNG BỊ TỪ CHỐI: ${parentAgent} định gửi [${agent}] "${task}" — ${reason}`
}

/** Thought 📥 — sub-agent đã triển khai tác vụ như thế nào (kết quả đầy đủ) */
function buildDelegationOutcomeThought(cycle: number, tc: { name: string; args: Record<string, unknown> }, toolResult: { success: boolean; result: unknown }): string | null {
  const fmtTokens = (n: unknown) => (typeof n === 'number' && n > 0 ? `${Math.round(n / 100) / 10}k` : '0')
  const r = (toolResult.result !== null && typeof toolResult.result === 'object')
    ? (toolResult.result as Record<string, unknown>)
    : null
  if (!r) return null
  const taskShort = dlClip(tc.args?.task ?? tc.args?.description, 90)

  // delegate_task / dispatch_agent — 1 sub-agent outcome đầy đủ
  if (tc.name === 'delegate_task' || tc.name === 'dispatch_agent') {
    const agent = String(r.agent ?? tc.args?.agent ?? '?')
    const it = typeof r.iterations === 'number' ? r.iterations : 0
    const tl = typeof r.toolCalls === 'number' ? r.toolCalls : 0
    const ended = String(r.endedBy ?? '-')
    const evalPass = r.evaluation && typeof r.evaluation === 'object'
      ? (typeof (r.evaluation as Record<string, unknown>).pass === 'boolean'
          ? ` · trọng tài độc lập: ${(r.evaluation as Record<string, unknown>).pass ? 'ĐẠT' : 'CHƯA ĐẠT'}`
          : '')
      : ''
    const report = dlClip(r.report, 220)
    const err = toolResult.success ? '' : (dlClip(r.error, 120) ? ` · lỗi: ${dlClip(r.error, 120)}` : '')
    return `📥 Chu kỳ ${cycle} — KẾT QUẢ PHÂN CÔNG: agent [${agent}] ${toolResult.success ? 'HOÀN THÀNH' : 'CHƯA ĐẠT'} "${taskShort}" — triển khai: ${it} vòng ReAct · ${tl} tool calls · ${fmtTokens(r.tokensUsed)} tokens · kết thúc bởi ${ended}${evalPass}${err}${report ? `; báo cáo: ${report}` : ''}`
  }

  // dispatch_agents_parallel — fan-out nhiều agent
  if (tc.name === 'dispatch_agents_parallel') {
    const total = typeof r.total === 'number' ? r.total : 0
    const ok = typeof r.succeeded === 'number' ? r.succeeded : 0
    const results = Array.isArray(r.results) ? (r.results as Array<Record<string, unknown>>) : []
    const lines = results.slice(0, 4).map(x => {
      const s = x.success === true
      return `[${String(x.agent ?? '?')}] ${s ? 'HOÀN THÀNH' : 'CHƯA ĐẠT'} · ${typeof x.iterations === 'number' ? x.iterations : 0} vòng · ${typeof x.toolCalls === 'number' ? x.toolCalls : 0} tools${dlClip(x.report, 90) ? ` — ${dlClip(x.report, 90)}` : ''}`
    })
    return `📥 Chu kỳ ${cycle} — KẾT QUẢ PHÂN CÔNG SONG SONG: ${ok}/${total} agent hoàn thành · tổng ${fmtTokens(r.tokensUsed)} tokens${lines.length > 0 ? `\n${lines.map(l => `  - ${l}`).join('\n')}` : ''}`
  }

  // request_code_team — pipeline cả team theo SOP
  if (tc.name === 'request_code_team') {
    const status = String(r.status ?? (toolResult.success ? 'completed' : 'failed'))
    const steps = Array.isArray(r.steps) ? (r.steps as Array<Record<string, unknown>>) : []
    const dur = typeof r.durationMs === 'number' ? Math.round(r.durationMs / 1000) : 0
    const lines = steps.slice(0, 5).map(s => `[${String(s.position ?? '?')}·${String(s.agent ?? '?')}] ${dlClip(s.summary, 90)}${typeof s.toolsTotal === 'number' && s.toolsTotal > 0 ? ` (${s.toolsOk}/${s.toolsTotal} tools)` : ''}`)
    return `🏭 Chu kỳ ${cycle} — KẾT QUẢ CODE TEAM [${status}]: ${steps.length} bước pipeline · ${dur}s${lines.length > 0 ? `\n${lines.map(l => `  - ${l}`).join('\n')}` : ''}${dlClip(r.report, 160) ? `\n  Tổng hợp: ${dlClip(r.report, 160)}` : ''}`
  }

  // escalate_problem auto-apply — Omega tự điều động agent theo khuyến nghị
  if (tc.name === 'escalate_problem' && r.autoApplied && typeof r.autoApplied === 'object') {
    const ap = r.autoApplied as Record<string, unknown>
    const agent = String(ap.agent ?? '?')
    const report = dlClip(ap.report, 160)
    return `🔄 Chu kỳ ${cycle} — ESCALATE + TỰ ĐIỀU ĐỘNG: Omega tư vấn vấn đề rồi tự điều động agent [${agent}] xử lý — ${ap.success === true ? 'HOÀN THÀNH' : 'CHƯA ĐẠT'}${report ? `; báo cáo: ${report}` : ''}`
  }
  return null
}

/** Directive nối tiếp chu kỳ — chẩn đoán + kế hoạch mới từ evaluator */
function buildContinuationDirective(v: EvalVerdict, cycle: number, cutMidWork: boolean, maxCyclesDisplay: number = EFFECTIVE_MAX_CYCLES, doneSummary?: string, planningLoopStreak?: number): string {
  const missing = v.missing.length > 0 ? v.missing.map(m => `- ${m}`).join('\n') : '- (trọng tài không liệt kê cụ thể — tự rà soát lại mục tiêu)'
  // TASK 43 — COUNTERFACTUAL: dòng nextPlan bắt đầu "CF:" là hướng PHẢN THỰC
  // do trọng tài đề xuất (nếu làm lại từ đầu — làm gì KHÁC thay vì cách đã
  // fail). Tách riêng khối để agent KHÔNG trộn với bước khắc phục thường.
  const cfItems = v.nextPlan.filter(p => /^CF\s*:/i.test(p.trim()))
  const planItems = v.nextPlan.filter(p => !/^CF\s*:/i.test(p.trim()))
  const plan = planItems.length > 0 ? planItems.map((p, i) => `${i + 1}. ${p}`).join('\n') : '- tự xác định bước khắc phục'
  const cfBlock = cfItems.length > 0
    ? `\n🔄 HƯỚNG PHẢN THỰC (COUNTERFACTUAL — cân nhắc TRƯỚC khi bám kế hoạch cũ):\n${cfItems.map(p => `- ${p.replace(/^CF\s*:/i, '').trim()}`).join('\n')}\n`
    : ''
  const cut = cutMidWork ? '\n⚠️ Chu kỳ trước bị cắt giữa chừng do hết vòng lặp — công việc có thể đang dở.' : ''
  // ROUND-12c (2026-09-30 — user report "kẹt lặp todo_write + tra cứu registry
  // chu kỳ 54-67"): N chu kỳ liên tiếp CHỈ có tool quan sát/lập kế hoạch —
  // vòng lặp GĐ0→GĐ1 không bao giờ sang GĐ2. Nguyên nhân amplifer: app RSS
  // self-exit mỗi ~2 phút (mỗi đời sống 1-2 vòng), directive cũ luôn mở đầu
  // "(1) cập nhật todo_write" → vòng đầu tiên BỊ TIÊU vào lập kế hoạch rồi
  // chết. Khi streak ≥2: ép mệnh lệnh triển khai ĐỨNG ĐẦU + cấm list_*/
  // todo_write trước tool triển khai đầu tiên thành công.
  const inPlanningLoop = (planningLoopStreak ?? 0) >= 2
  const plBlock = inPlanningLoop
    ? `\n🚨 VÒNG LẶP LẬP KẾ HOẠCH — ${planningLoopStreak} chu kỳ liên tiếp CHỈ có quan sát registry + todo_write, KHÔNG có tool TRIỂN KHAI nào (file_write/file_edit/shell/probe). Kế hoạch ĐÃ ĐỦ, thông tin registry ĐÃ CÓ trong transcript (KHÔNG tra lại list_*/read lần nữa). Chu kỳ này: tool call ĐẦU TIÊN phải là TRIỂN KHAI theo todo in_progress đầu tiên — tạo artifact (file_write), chạy lệnh (shell), hoặc chạy probe. TUYỆT ĐỐI KHÔNG gọi list_*/todo_write/todo_read/file_read trước khi có ≥1 tool triển khai HOÀN TẤT.\n`
    : ''
  // 2026-10 PROCESS INTEGRITY — khối "việc ĐÃ làm" (quan sát): agent chu kỳ
  // kế NHÌN THẤY những gì chu kỳ trước đã làm thành công → không làm lại y hệt
  // (nguồn lặp phổ biến: CLI spawn mới không nhớ việc cũ → verify lại từ đầu).
  const done = doneSummary
    ? `\n✅ Việc chu kỳ trước ĐÃ làm thành công (KHÔNG làm lại — chỉ kiểm tra khi còn nghi ngờ): ${doneSummary}\n`
    : ''
  // 2026-10-27 (user directive — GĐ3 quyết định lặp lại GĐ0 theo NỢ KỸ THUẬT):
  // mục tiêu CHƯA đạt + chu kỳ trước có lỗi phát sinh còn tồn tại → chu kỳ này
  // quay về GĐ0, TOÀN BỘ nợ được ƯU TIÊN xử lý TRƯỚC phần việc còn thiếu.
  const debtPriority = v.sideIssues.length > 0
    ? `\n📌 NỢ KỸ THUẬT chu kỳ trước còn tồn tại (ƯU TIÊN xử lý TRƯỚC khi làm phần việc còn thiếu):\n${v.sideIssues.map(s => `- ${s}`).join('\n')}\n`
    : ''
  // ROUND-12c — khi kẹt vòng lặp lập kế hoạch: ĐẢO thứ tự chỉ thị — triển khai
  // TRƯỚC (bỏ bước "cập nhật todo_write" mở đầu; todo_write chỉ dùng sau khi
  // có tool triển khai thành công, để đóng todo đúng bằng chứng CI-2).
  const actionItems = inPlanningLoop
    ? `(1) TRIỂN KHAI NGAY tool call đầu tiên theo todo in_progress (KHÔNG cập nhật todo_write trước — kế hoạch trên + todo list ĐÃ ĐỦ), (2) tiếp tục lần lượt các todo còn lại MỖI chu kỳ ít nhất 1 tool triển khai, (3) sau khi triển khai mới dùng todo_write đóng todo kèm bằng chứng + KIỂM ĐỊNH bằng tool thật`
    : `(1) cập nhật todo_write với kế hoạch trên (nợ kỹ thuật xếp TRƯỚC, điều chỉnh nếu thấy hợp lý hơn), (2) khắc phục vấn đề, (3) KIỂM ĐỊNH LẠI bằng tools để có bằng chứng`
  return `[GOAL-LOOP: Chu kỳ ${cycle}/${fmtCap(maxCyclesDisplay)}] Mục tiêu CHƯA hoàn thành theo đánh giá độc lập (độ tin cậy ${Math.round(v.confidence * 100)}%).${plBlock}${cut}${done}

❌ Còn thiếu:
${missing}
${debtPriority}
🔍 Vấn đề nằm ở: ${v.rootCause || '(chưa xác định được nguyên nhân gốc)'}${!v.verified ? '\n⚠️ Bạn CHƯA kiểm định kết quả bằng tool thật ở chu kỳ trước — chu kỳ này PHẢI có bằng chứng kiểm định.' : ''}

📋 Kế hoạch tiếp theo:
${plan}
${cfBlock}
Hãy: ${actionItems}. KHÔNG lặp lại đúng hành động đã thất bại — nếu cách cũ fail, đổi cách tiếp cận.`
}

/**
 * 2026-10 PROCESS INTEGRITY — trích mục tiêu + tiêu chí nghiệm thu khi
 * userMessage là CHỈ ĐẠO của Opus (nhận CẢ 2 format: mới 2-mục "🚀 BƯỚC TIẾP
 * THEO" lẫn cũ "🎯 CHỈ ĐẠO THỰC THI"). Trước đây evaluator chỉ thấy 2000 chars
 * ĐẦU của directive (dài tới 16k) — mục tiêu thật + acceptance criteria nằm
 * NGOÀI phần thấy → đánh giá lệch trọng tâm ("đánh giá hời hợt" theo user).
 */
export function extractDirectiveSpec(rawGoal: string): { goal: string; acceptance: string[] } {
  const acceptance: string[] = []
  // Block "Tiêu chí nghiệm thu:" (cũ) / "Nghiệm thu:" (mới) — các dòng "- [ ] ..."
  const accBlock = rawGoal.match(/(?:Tiêu chí )?[Nn]ghiệm thu[^:\n]*:\s*([\s\S]*?)(?=\n\s*\n|\n\s*[•🏁🔍💡📊🚨⚖️]|$)/)
  if (accBlock) {
    for (const line of accBlock[1].split('\n')) {
      const item = line.replace(/^\s*-\s*\[[ xX]\]\s*/, '').replace(/^\s*-\s*/, '').trim()
      if (item && item.length > 3) acceptance.push(item.slice(0, 200))
    }
  }
  // "• Mục tiêu: ..." (mới + cũ) — fallback "GOAL —..." (JSON style)
  const goalMatch = rawGoal.match(/[•]\s*Mục tiêu:\s*(.+)/) || rawGoal.match(/^\s*GOAL\s*[—:-]\s*(.+)$/m)
  const goal = goalMatch ? goalMatch[1].trim().slice(0, 500) : ''
  return { goal: goal || rawGoal, acceptance: acceptance.slice(0, 8) }
}

/** 2026-10 — rút gọn kết quả tool CLI (ExecutedToolResult) cho evidence +
 *  transcript. Fail → "LỖI: <error>"; success → output bounded (giữ dòng). */
function cliToolResultPreview(er: { success: boolean; output: string; error?: string }, cap = 400): string {
  if (!er.success) {
    const errText = (er.error || er.output || 'lỗi không rõ').trim()
    return `LỖI: ${errText.length > cap ? `${errText.slice(0, cap - 1)}…` : errText}`
  }
  const out = (er.output || '').trim()
  if (!out) return ''
  return out.length > cap ? `${out.slice(0, cap - 1)}…` : out
}

// (2026-10-27 phiên 4) export cho test — rule debtReadiness + parser verdict
export const EVALUATOR_SYSTEM_PROMPT = `Bạn là EVALUATOR — trọng tài độc lập đánh giá việc thực hiện mục tiêu của một AI Agent.

Nguyên tắc SẮT:
1. Bạn KHÔNG tin vào lời tuyên bố của agent ("tôi đã hoàn thành", "file đã tạo"...). Bạn CHỈ tin vào BẰNG CHỨNG trong kết quả tool thật: output lệnh, kết quả test, nội dung file đọc lại.
2. Mục tiêu là câu hỏi/thông tin (không yêu cầu tạo/sửa/chạy gì) → "complete": true khi câu trả lời cuối của agent đầy đủ và đúng trọng tâm. (Lưu ý: yêu cầu khảo sát/đánh giá/đếm dữ liệu thật của hệ thống KHÔNG thuộc loại này — xem rule 13.)
3. Mục tiêu đòi hỏi hành động (tạo/sửa file, code, chạy lệnh, dữ liệu) → "complete": true KHI VÀ CHỈ KHI có bằng chứng tool cho thấy kết quả đúng (file đọc lại khớp yêu cầu, test/lint pass, lệnh exit thành công).
4. Agent KHÔNG kiểm định (không có tool nào xác nhận kết quả) → "verified": false → với mục tiêu hành động thì "complete": false.
5. "missing" = những gì còn thiếu so với mục tiêu. "rootCause" = vấn đề nằm chính xác ở đâu (bước nào fail / thiếu gì / sai chỗ nào). "nextPlan" = các bước khắc phục cụ thể cho chu kỳ kế tiếp.
6. Công cụ kiểm định FAIL (type_check/lint/run_tests lỗi) KHÔNG tự động là "bằng chứng đã kiểm định": chỉ tin khi kết quả chứa errorCount/thông báo lỗi CỤ THỂ; nếu agent không trích được lỗi cụ thể (output bị cắt / nguyên nhân mơ hồ như "tsc fail") → "verified": false và ghi rõ vào "missing".
7. "confidence" = XÁC SUẤT MỤC TIÊU ĐÃ HOÀN THÀNH ĐÚNG (P(complete=true)) — KHÔNG PHẢI độ chắc chắn của bạn về bản thân verdict. Đây là lỗi semantics phổ biến nhất: mô hình cũ Output 0.99 khi complete=false (nghĩ "tôi 99% chắc là CHƯA xong") → hệ thống ghi KB + hiển thị người dùng độ tin 99% cho run THẤT BẠI (đo đạc thực tế: 66/78 verdict sai cách này, Brier 0.88/ECE 0.91). Thang quy đổi BẮT BUỘC: complete=true + verified=true + bằng chứng tool trực tiếp khớp hoàn toàn mục tiêu → 0.85-0.98; complete=true + verified=false → 0.4-0.7; complete=false → 0.0-0.3 (bằng chứng rõ ràng chưa đạt) hoặc 0.3-0.5 (chưa chắc chắn). NGHIÊM CẤM confidence ≥0.5 khi "complete": false — hệ thống sẽ tự clamp về 0.3 nếu vi phạm.
8. E2E VERIFICATION (sửa code nhưng chỉ đọc lại file): mục tiêu có SỬA CODE mà bằng chứng kiểm định chỉ là file_read/grep (KHÔNG run_tests/lint/type_check dù thông báo hệ thống nói tool có sẵn) → chỉ chấp nhận "complete": true khi thay đổi là thuần hiển thị/nội dung tĩnh; thay đổi LOGIC → "complete": false và thêm vào "missing": "chạy run_tests/lint/type_check để kiểm định thay đổi logic".
9. SIDE ISSUES (lỗi phát sinh trong quá trình làm — tool fail, lint/test lỗi ở file run đã đụng, lỗi logic do thay đổi của run tạo ra, config/hành vi hỏng...): liệt kê vào "sideIssues" (tối đa 4, ngắn gọn). Mục tiêu chính ĐẠT nhưng CÓ side issues còn tồn tại → "complete": true vẫn đúng cho MỤC TIÊU GỐC (đừng hạ complete vì lỗi ngoài mục tiêu), NHƯNG run chưa thể kết thúc khi các lỗi liên quan còn treo — chọn "debtDecision" theo mức độ LIÊN QUAN:
   - "continue": MẶC ĐỊNH cho mọi side issue LIÊN QUAN đến công việc của run này (lint/test fail ở file đã đụng, lỗi phát sinh từ thay đổi của run, tool fail chưa xử lý được, hành vi hỏng do run tạo...) → hệ thống TÁI LẬP chu kỳ debt xử lý NGAY trong run này (nhiều đợt liên tiếp nếu cần). Tác vụ chỉ thực sự trọn vẹn khi các vấn đề phát sinh liên quan đã được giải quyết — ĐỪNG vội phán kết thúc khi còn lỗi treo.
   - "record": CHỈ khi issue THẬT SỰ ngoài khả năng xử lý của agent NGAY CẢ SAU khi đã thử đường tự phục vụ. Chính sách 2026-10-27 (phiên 4): agent ĐÃ ĐƯỢC PHÉP (a1) tự cài package (manage_packages / shell bun add) và (a2) tự sửa DB schema (file_edit prisma/schema.prisma + shell bun run db:push) — hai hạng mục này KHÔNG còn là lý do "record"; (a3) thiếu tool hoàn toàn → agent tự xây + đăng ký qua create_custom_tool rồi dùng tiếp; (a4) việc thuộc chức trách agent khác → delegate_task/dispatch_agent; (a5) chưa có agent chức trách đó → escalate_problem (Omega tạo agent mới). Chỉ còn "record" khi: (b) phần hạ tầng VẪN ĐƯỢC BẢO VỆ (.env/keys, file data db/, opencode.json, .opencode/, mini-services/, config hệ thống) mà agent đã thử đường chính thống vẫn kẹt; (c) cần quyền/phê duyệt cấp hệ thống (Mr. Architect / Self-Direction) — kể cả khi agent đã trình phê duyệt và đang chờ; (d) lỗi hạ tầng bên thứ 3 (vendor/LLM provider) không thể sửa từ bên trong; (e) thiếu điều kiện ngoài tầm với sau khi đã thử đủ đường tự phục vụ. Các lỗi này KHÔNG phải agent kém — hệ thống ghi nợ kỹ thuật (Todo follow-up) chờ điều kiện/người quản trị quyết định.
   - "none": CHỈ khi issue tầm thường/đã tự hết và KHÔNG liên quan gì đến thay đổi của run.
   KHÔNG dùng side issues để hạ "complete" khi mục tiêu chính đã đạt theo bằng chứng — nhưng cũng KHÔNG dùng "record"/"none" để né xử lý lỗi liên quan còn giải quyết được trong run này.
10. DEBT CHECK (áp dụng khi prompt có khối "CÁC LỖI PHÁT SINH CHƯA XỬ LÝ" — danh sách trọng tài đã quyết định xử lý ở các chu kỳ trước): đối chiếu TỪNG lỗi với bằng chứng chu kỳ này. Lỗi nào CHƯA có bằng chứng máy xác nhận đã khắc phục (fix xong + verify pass) → PHẢI liệt kê lại vào "sideIssues" và đặt "debtDecision": "continue". KHÔNG phán hoàn thành sạch khi danh sách còn mục chưa đối chiếu được bằng chứng khắc phục.
11. DERIVED-NUMBER GUARD (2026-10-20 — E2E lộ agent đếm bằng mắt sai 80/79 nhưng tự chấm "đã kiểm chứng"): khi mục tiêu/tiêu chí đòi một CON SỐ hoặc kết quả TỔNG HỢP từ dữ liệu gốc (đếm dòng, đếm phần tử, tính tổng...), chỉ chấp nhận là verified khi bằng chứng tool cho thấy LỆNH MÁY trả về đúng con số đó (output wc/jq/grep -c hiển thị giá trị khớp). Agent "tự đếm trong đầu" từ nội dung đã đọc KHÔNG phải bằng chứng — nếu không thấy output lệnh máy xác nhận con số → "verified": false.
12. TODO PLAN CHECK (Task 23-c 2026-10-26 — E2E lộ agent làm task đa bước mà bỏ qua kế hoạch): tác vụ đòi ≥2 bước làm việc thật (đọc/sửa/đếm nhiều mục độc lập) mà bằng chứng KHÔNG có tool todo_write/tmo_todo nào trong run → "complete" vẫn đánh giá theo KẾT QUẢ, nhưng thêm vào "missing": "process: bỏ qua todo_write — chạy không có kế hoạch truy vết được" (ghi nhận gap quy trình cho Opus review + báo cáo cuối; chu kỳ sau nếu còn chạy thì ưu tiên bổ sung todo).
13. FACT-GATHERING GUARD (2026-10-27 — E2E lộ agent trả về 1 câu ý định mà evaluator vẫn chấm hoàn thành): mục tiêu đòi dữ liệu thật về hệ thống/file/database (khảo sát, rà soát, đánh giá hiện trạng, đếm, liệt kê, kiểm tra...) → KHÔNG phải câu hỏi kiến thức chung: "complete": true KHI VÀ CHỈ KHI run CÓ tool call thu thập dữ liệu thật (file_read/grep/shell/query/delegation...) và kết quả khớp mục tiêu. Run 0 tool calls, hoặc nội dung cuối chỉ là Ý ĐỊNH/KẾ HOẠCH ("tôi sẽ...") thay vì báo cáo dữ liệu → "complete": false, "verified": false, rootCause ghi rõ: thiếu bằng chứng thu thập dữ liệu thật.
14. DEBT READINESS (user directive 2026-10-27 phiên 4 — GĐ3 xác định lại khả năng xử lý nợ ở chu kỳ kế): khi có side issues còn tồn tại, XÁC ĐỊNH LẠI xem chu kỳ kế tiếp ĐÃ CÓ THỂ TIẾN HÀNH XỬ LÝ được các nợ này chưa — đối chiếu từng nợ với năng lực tự phục vụ hiện có: tool sẵn có hoặc tự xây được (create_custom_tool), package tự cài được (manage_packages/bun add), schema tự sửa được (prisma + db push), việc thuộc chức trách agent có sẵn trong roster (dispatch được), không phụ thuộc điều kiện ngoài. TẤT CẢ nợ có đường xử lý → "debtReadiness": "ready" (chu kỳ kế quay GĐ0 xử lý được ngay). Nợ chờ phê duyệt Self-Direction / chờ vendor / chờ agent chưa tồn tại / thiếu điều kiện ngoài tầm với → "debtReadiness": "blocked" + "debtBlockedReason" nêu CỤ THỂ điều kiện còn thiếu (1 câu). KHÔNG phán "ready" khi nợ cần điều kiện chưa có — quay GĐ0 khi chưa thể xử lý chỉ đốt chu kỳ vô ích.
15. COUNTERFACTUAL CHECK (Task 43 — chất lượng quyết định chu kỳ kế): khi "complete": false và run đã từng thất bại ít nhất 1 hướng tiếp cận (tool fail / verify fail / hướng đã thử không đạt), "nextPlan" PHẢI chứa ĐÚNG 1 dòng bắt đầu bằng "CF: " — 1 hướng làm KHÁC căn bản đáng giá nhất (nếu làm lại từ đầu sẽ thử gì thay vì cách đã fail) + vì sao hướng đó có thể thắng đúng chỗ cách cũ gục. KHÔNG để nextPlan lặp nguyên văn kế hoạch đã fail — đó là tín hiệu xoay vòng.
16. NEEDS-INPUT CHECK (Task 48 — chống đốt chu kỳ vô ích): xác định xem mục tiêu có đang bị chặn DUY NHẤT bởi thông tin/ủy quyền/phê duyệt mà CHỈ NGƯỜI DÙNG cung cấp được không (agent đã hỏi trong lời kết luận — vd: thiếu scope/ủy quyền pentest, thiếu credentials, cần user chọn giữa các phương án, thông tin không có trong hệ thống...). ĐÚNG → "needsInput": true + "complete": false + "missing" nêu RÕ thông tin cụ thể cần user trả lời. KHÔNG dùng needsInput cho việc agent TỰ làm được bằng tool/tự phục vụ (xem rule 9a — đó là trốn tránh, không phải thiếu thông tin); cũng KHÔNG dùng khi agent chưa hề hỏi hoặc còn đường tấn công khả thi chưa thử. needsInput=true → hệ thống DỪNG vòng lặp ngay và trả câu hỏi về user (không chạy thêm chu kỳ).

Output DUY NHẤT một dòng JSON hợp lệ (KHÔNG markdown fence, KHÔNG giải thích thêm):
{"complete": true|false, "confidence": 0.0-1.0, "verified": true|false, "missing": ["..."], "rootCause": "...", "nextPlan": ["..."], "sideIssues": ["..."], "debtDecision": "none|record|continue", "debtReadiness": "ready|blocked", "debtBlockedReason": "...", "needsInput": true|false}"`

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

/** Parse JSON verdict từ output evaluator (chống markdown fence + text thừa)
 * (2026-10-27 phiên 4) export cho test — parse debtReadiness/debtBlockedReason */
export function parseEvalVerdict(raw: string): EvalVerdict | null {
  try {
    const text = raw.replace(/```(?:json)?/g, '')
    const jsonStr = findBalancedJson(text, 'complete')
    if (!jsonStr) return null
    const obj = JSON.parse(jsonStr) as Record<string, unknown>
    const complete = obj.complete === true
    let confidence = typeof obj.confidence === 'number' ? Math.min(1, Math.max(0, obj.confidence)) : (complete ? 0.8 : 0.5)
    // ROUND-8 AUDIT (2026-09-30) — CALIBRATION GUARD: đo thực tế 66/78 verdict
    // cũ có confidence ≥0.9 khi complete=false (LLM hiểu nhầm confidence =
    // "độ chắc chắn về verdict" thay vì P(complete); Brier 0.88, ECE 0.91) →
    // AutoLearn (ngưỡng 0.5) học nhám run THẤT BẠI vào KB + ChatMessage
    // metadata hiển thị người dùng độ tin 99% cho báo cáo chưa hoàn thành.
    // Clamp phòng thủ: complete=false → tối đa 0.3 (dưới ngưỡng auto-learn).
    if (!complete && confidence > 0.3) confidence = 0.3
    const verified = obj.verified === true
    const missing = Array.isArray(obj.missing) ? obj.missing.map(m => String(m).slice(0, 200)).filter(Boolean).slice(0, 6) : []
    const rootCause = typeof obj.rootCause === 'string' ? obj.rootCause.slice(0, 400) : ''
    const nextPlan = Array.isArray(obj.nextPlan) ? obj.nextPlan.map(p => String(p).slice(0, 200)).filter(Boolean).slice(0, 6) : []
    // FIX 2026-09-14 #9 — side issues + quyết định xử lý nợ kỹ thuật của trọng tài
    const sideIssues = Array.isArray(obj.sideIssues) ? obj.sideIssues.map(s => String(s).slice(0, 200)).filter(Boolean).slice(0, 4) : []
    const debtDecision = obj.debtDecision === 'record' || obj.debtDecision === 'continue' ? obj.debtDecision : 'none'
    // 2026-10-27 (phiên 4) — DEBT READINESS: nợ có thể xử lý ở chu kỳ kế không?
    // Fail-open: field thiếu/sai → 'ready' (giữ hành vi cũ — debt cycle vẫn chạy).
    const debtReadiness = obj.debtReadiness === 'blocked' ? 'blocked' : 'ready'
    const debtBlockedReason = typeof obj.debtBlockedReason === 'string' ? obj.debtBlockedReason.slice(0, 300) : ''
    // TASK 48 — NEEDS-INPUT: fail-open false (field thiếu/sai → giữ hành vi cũ).
    const needsInput = obj.needsInput === true
    return { complete, confidence, verified, missing, rootCause, nextPlan, sideIssues, debtDecision, debtReadiness, debtBlockedReason, needsInput, raw: raw.slice(0, 400) }
  } catch {
    return null
  }
}

/**
 * Fingerprint "có tiến triển không" — hash nội dung 6 messages cuối.
 * IMP-2 (G5 — audit Task H): LOẠI directive/hệ thống khỏi hash — continuation
 * directive luôn chứa "Chu kỳ N/M" đổi mỗi chu kỳ → fingerprint 6-message cuối
 * gần như KHÔNG BAO GIỜ trùng (thực tế 36 chu kỳ noProgressCount=0 dù evaluator
 * tự kết luận looping — phanh no-progress gần chết). Giờ chỉ hash nội dung THẬT
 * (assistant + tool result) — 2 chu kỳ lặp lại cùng hành động/kết luận sẽ trùng
 * đúng. Không còn message thực nào → trả '' (phanh in-cycle có guard fp !== '';
 * chu kỳ toàn-text liên tiếp cũng là không tiến triển đúng nghĩa).
 */
function progressFingerprint(messages: GoalMessage[]): string {
  const substantive = messages.filter(m => m.role === 'assistant' || m.role === 'tool')
  if (substantive.length === 0) return ''
  let h = 5381
  for (const m of substantive.slice(-6)) {
    const s = `${m.role}|${m.content.slice(-150)}`
    for (let i = 0; i < s.length; i++) {
      h = ((h << 5) + h + s.charCodeAt(i)) | 0
    }
  }
  return String(h)
}

/**
 * ROUND-27 FIX V1 — smartTruncate + truncateToolMessageJson (ROUND-26 FIX B)
 * đã chuyển sang @/lib/context-compression (module dùng chung cho cả 3 vòng
 * lặp: goal-loop / sub-agent / workflow-engine). agent-goal-loop re-export
 * truncateToolMessageJson phía trên (giữ compatibility scratch + caller cũ).
 * pushToolMessage bên dưới vẫn dùng y hệt — hành vi không đổi.
 */

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
    // ROUND-26 FIX B — envelope JSON hợp lệ thay vì splice cắt giữa làm vỡ JSON
    content = truncateToolMessageJson(entry, content, cap)
  }
  messages.push({ role: 'tool', content })
}

/**
 * [D] Evidence preview thông minh — thay vì cắt 200 ký tự đầu mù quáng, trích
 * các trường structured (success/errorCount/warningCount/exitCode...) + THÔNG
 * BÁO LỖI CỤ THỂ đầu tiên để evaluator thấy đúng bằng chứng, không phải đoán.
 */
export function summarizeToolResult(result: unknown): string {
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
    // FIX (mission #15 evidence 2026-09-30): kết quả truy vấn có `rows`
    // (db_query...) cần NỘI DUNG DÒNG — trước đây evaluator chỉ thấy
    // "PASS …| đuôi: <80 ký tự cuối>" → không thể xác minh id/status/content
    // từng dòng (cùng lớp bug với fix grep/shell 2026-09-08 ở trên).
    if (Array.isArray(r.rows) && r.rows.length > 0) {
      const rows = r.rows as Array<Record<string, unknown>>
      const rowPreviews = rows.slice(0, 5).map(row =>
        Object.keys(row)
          .slice(0, 6)
          .map(k => `${k}=${String(row[k]).replace(/\s+/g, ' ').slice(0, 90)}`)
          .join(' '),
      )
      const total = typeof r.rowCount === 'number' ? r.rowCount : rows.length
      parts.push(`rows ${rows.length}/${total}${r.truncated === true ? ' (bị cắt)' : ''}: ${rowPreviews.join(' || ')}`)
    }
    // FIX (cùng đợt): todo_read trả `todos` + `byStatus` — preview 5 dòng đầu
    // (id/status/content) để evaluator đối chiếu closure TODO không cần
    // đọc lại toàn bộ danh sách.
    if (Array.isArray(r.todos) && r.todos.length > 0) {
      const todos = r.todos as Array<Record<string, unknown>>
      const todoPreviews = todos.slice(0, 5).map(t =>
        `${String(t.id ?? '').slice(0, 16)} [${String(t.status ?? '?')}] ${String(t.content ?? '').replace(/\s+/g, ' ').slice(0, 70)}`,
      )
      const stat = r.byStatus && typeof r.byStatus === 'object' ? ` ${JSON.stringify(r.byStatus)}` : ''
      parts.push(`todos ${typeof r.total === 'number' ? r.total : todos.length}${stat}: ${todoPreviews.join(' | ')}`)
    }
    // FIX (cùng đợt): todo_write trả `upserted` — đếm ghi máy, bằng chứng
    // exactly-once (đúng một lần ghi, N dòng) cho trọng tài.
    if (typeof r.upserted === 'number') parts.push(`upserted=${r.upserted}`)
    // ROUND-26 FIX D (mission cmupl7uen — evidence "file_list: PASS …| đuôi:
    // <argHeal note>" khiến trọng tài + chu kỳ sau tưởng file_list KHÔNG trả
    // dữ liệu hữu ích): kết quả có `entries` (file_list...) cần preview số
    // lượng + vài tên đầu — kèm tổng + cờ truncated để nhận diện cắt.
    if (Array.isArray(r.entries) && r.entries.length > 0) {
      const ents = r.entries as Array<Record<string, unknown>>
      const names = ents.slice(0, 4).map(e => String(e.name ?? '')).filter(Boolean)
      const totalEnts = typeof r.total === 'number' ? r.total : ents.length
      parts.push(`entries ${ents.length}/${totalEnts}${r.truncated === true ? ' (bị cắt)' : ''}${names.length > 0 ? `: ${names.join(', ')}` : ''}`)
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
      // ROUND-26 FIX D — nguồn chuỗi đuôi preview BỎ argHeal (note chữa args là
      // noise với bằng chứng — trước đây đuôi 80 ký tự rơi trúng argHeal làm
      // che mất total/note thật ở cuối kết quả, đúng lỗi mission cmupl7uen).
      let tailSrc = s
      if (Array.isArray(r.argHeal)) {
        try {
          tailSrc = JSON.stringify({ ...r, argHeal: undefined })
        } catch { tailSrc = s }
      }
      const tail = tailSrc.length > 400 ? ` …| đuôi: ${tailSrc.slice(-80)}` : ''
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
  /** FIX 2026-09-14 #7 (E2E verification): chu kỳ có SỬA CODE không? */
  codeModified: boolean
  /** FIX 2026-09-14 #7: có bằng chứng kiểm định MẠNH (run_tests/lint/type_check)
   * ở chu kỳ cuối không — file_read-only là kiểm định YẾU với thay đổi logic. */
  hasStrongVerify: boolean
  /** FIX 2026-09-14 #7: agent có tool kiểm định mạnh trong whitelist không */
  strongVerifyToolsAvailable: boolean
  agentProvider: string
  agentModel: string
  agentId: string
  agentName: string
  abortCheck: () => boolean
  /** Token của evaluator cũng phải vào kế toán budget (fix review 2026-09-08) */
  onTokens?: (tokens: number) => void
  /**
   * TASK 21 — các lỗi phát sinh CHƯA XỬ LÝ (pendingDebtIssues: trọng tài đã
   * quyết định xử lý ở chu kỳ debt trước). Truyền vào để evaluator ĐỐI CHIỂU
   * từng lỗi với bằng chứng chu kỳ này (quy tắc 10): lỗi chưa có bằng chứng
   * khắc phục → PHẢI liệt kê lại sideIssues + debtDecision='continue' —
   * trước đây evaluator không biết danh sách nợ → debt cycle dở vẫn bị phán
   * complete → lỗi treo "chìm" (user report 2026-09-30).
   */
  debtIssues?: string[]
}): Promise<EvalVerdict | null> {
  const { goal, lastAssistantContent, evidence, verifyEvidence, unverifiedModifications, codeModified, hasStrongVerify, strongVerifyToolsAvailable, agentProvider, agentModel, agentId, agentName, abortCheck, onTokens, debtIssues } = params

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

  // FIX 2026-09-14 #7 — cảnh báo E2E verification cho trọng tài: chu kỳ có SỬA
  // CODE nhưng bằng chứng kiểm định chỉ là đọc lại file (YẾU) trong khi tool
  // kiểm định MẠNH (run_tests/lint/type_check) có sẵn — trọng tài áp quy tắc 8.
  const weakVerifyWarning = codeModified && !hasStrongVerify && strongVerifyToolsAvailable
    ? `\n\n⚠️ E2E VERIFICATION: chu kỳ có SỬA CODE nhưng bằng chứng kiểm định CHỈ là đọc lại file/grep (KHÔNG có run_tests/lint/type_check dù tool có sẵn). Theo quy tắc 8: thay đổi LOGIC chỉ được coi hoàn thành khi đã chạy test/lint/type_check — kiểm tra kỹ loại thay đổi trước khi chấm "complete": true.`
    : ''

  // TASK 21 — DEBT CHECK BLOCK: danh sách lỗi phát sinh trọng tài đã quyết
  // định xử lý ở chu kỳ trước → evaluator đối chiếu từng lỗi với bằng chứng
  // chu kỳ này (quy tắc 10 prompt): chưa có bằng chứng khắc phục → liệt kê lại
  // sideIssues + debtDecision='continue' (KHÔNG phán hoàn thành sạch).
  const debtCheckBlock = debtIssues && debtIssues.length > 0
    ? `\n\nCÁC LỖI PHÁT SINH CHƯA XỬ LÝ (trọng tài đã quyết định xử lý — đối chiếu bằng chứng chu kỳ này xem TỪNG lỗi đã khắc phục chưa, quy tắc 10):\n${debtIssues.map(d => `- ${d}`).join('\n')}\n→ Lỗi nào chưa có bằng chứng máy xác nhận đã khắc phục (fix + verify pass) → PHẢI liệt kê lại vào "sideIssues" + "debtDecision": "continue".`
    : ''

  const prompt = `MỤC TIÊU CỦA AGENT:
${goal.slice(0, 2000)}

LỜI KẾT LUẬN CUỐI CÙNG CỦA AGENT (chỉ là tuyên bố — cần đối chiếu bằng chứng):
${lastAssistantContent.slice(0, 2500)}

BẰNG CHỨNG KIỂM ĐỊNH CHU KỲ CUỐI (HARNESS kiểm đếm từ tool call thật — agent KHÔNG thể bịa):
${verifyBlock}${weakVerifyWarning}${debtCheckBlock}${unverifiedModifications ? '\n\n⚠️ CÓ THAO TÁC SỬA (file_edit/shell/git...) SAU LẦN KIỂM ĐỊNH CUỐI — kết quả của lần sửa đó CHƯA được kiểm chứng.' : ''}

NHẬT KÝ BẰNG CHỨNG TOOL (theo thứ tự thời gian — đây là sự thật duy nhất đáng tin):
${evidenceBlock}

ĐÁNH GIÁ: mục tiêu đã hoàn thành chưa? Output JSON.`

  try {
    const result = await withTimeout(
      callLLMForAgent(prompt, { provider: agentProvider, model: agentModel }, EVALUATOR_SYSTEM_PROMPT, {
        agentId,
        agentName: `${agentName} (evaluator)`,
        temperature: 0.2,
        // IMP-2 (H G3 — audit Task H): 1200 sát nút vs worst-case verdict tiếng
        // Việt ~3900 chars → truncate → JSON hỏng → null → rơi nhánh heuristic
        // (false-done G1). 2000 cho evaluator đủ chỗ trả verdict trọn vẹn.
        maxTokens: 2000,
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
  /** FIX 2026-09-14 #9 — nợ kỹ thuật chưa xử lý (đã ghi Todo follow-up) */
  debtIssues?: string[]
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
    goal, lastContent, evidence, lastVerdict, stopReason, cyclesAttempted, maxCycles, debtIssues,
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

  // FIX 2026-09-14 #9 — phần NỢ KỸ THUẬT cho báo cáo cuối khi trọng tài ghi nhận
  // side issues (mục tiêu chính đạt nhưng có lỗi phát sinh chưa xử lý).
  const debtBlock = debtIssues && debtIssues.length > 0
    ? `\nNỢ KỸ THUẬT (lỗi phát sinh ngoài mục tiêu — trọng tài quyết định GHI NỢ thay vì chạy thêm chu kỳ; ĐÃ tạo Todo follow-up):\n${debtIssues.map(d => `- ${d}`).join('\n')}`
    : ''

  const prompt = `MỤC TIÊU GỐC:
${goal.slice(0, 1500)}

THÔNG ĐIỆP CUỐI CỦA AGENT (có thể đang DỞ giữa chừng):
${lastContent.slice(0, 3000)}

NHẬT KÝ BẰNG CHỨNG TOOL THẬT (sự thật duy nhất đáng tin — trích dẫn kết quả cụ thể từ đây):
${evidenceLines.slice(0, 8000)}

ĐÁNH GIÁ CỦA TRỌNG TÀI ĐỘC LẬP:
${verdictBlock}${debtBlock}

TÌNH TRẠNG: vòng lặp dừng sau ${cyclesAttempted}/${maxCycles === 0 ? '∞' : maxCycles} chu kỳ — lý do: ${stopReason}.

NHIỆM VỤ: viết BÁO CÁO CUỐI trung thực + HOÀN CHỈNH cho người dùng (tiếng Việt), theo đúng 4 phần (tiêu đề phần viết thường, kèm số thứ tự):
1. ĐÃ LÀM ĐƯỢC — từng việc cụ thể, kèm bằng chứng tool (tên tool + kết quả ngắn trích từ nhật ký)
2. CHƯA HOÀN THÀNH / CÒN THIẾU — thành thật nêu giới hạn (bị cắt vì budget/chu kỳ), KHÔNG tuyên bố hoàn thành những gì chưa có bằng chứng
3. NHỮNG GÌ CHƯA KIỂM ĐỊNH ĐƯỢC — nêu rõ khi công cụ kiểm định fail mà không trích được lỗi cụ thể (không đoán nguyên nhân)
4. ĐỀ XUẤT KHẮC PHỤC — các bước cụ thể, khả thi cho lần chạy tiếp theo${debtBlock ? '\n\nKèm mục NỢ KỸ THUẬT (cuối báo cáo): liệt kê rõ các lỗi phát sinh đã ghi nhận thành Todo follow-up — người dùng quyết định xử lý lúc nào.' : ''}

QUY TẮC: KHÔNG gọi tool. KHÔNG bắt đầu công việc mới. Chỉ tổng kết từ bằng chứng có sẵn. Báo cáo phải trọn vẹn có kết luận (không bị cắt ngang).
ĐỊNH DẠNG (user directive 2026-10-20): văn xuôi tiếng Việt sạch, markdown TỐI THIỂU — không bọc nhấn mạnh bằng **, không bọc từ ngữ bằng dấu \` hay dấu ' (chỉ trích dẫn mã/lệnh thật). Nhấn mạnh bằng CHỮ IN HOA. Liệt kê bằng gạch đầu dòng "- ".`

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
   * 2026-10-27 (user directive — trần prompt THEO TÁC VỤ): override budget ký
   * tự system prompt cho ĐÚNG run này. -1 (hoặc ≤0) = KHÔNG GIỚI HẠN;
   * undefined = mặc định hệ thống (SYSTEM_PROMPT_BUDGET_CHARS).
   */
  promptBudgetChars?: number
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
    promptBudgetChars,
    durable,
  } = params

  const startedAt = Date.now()
  // [G] Tool hiệu dụng cho protocol injection: agent KHÔNG khai báo whitelist
  // (agentTools=[] → mọi tool đều được phép — agent custom/Omega-created) vẫn
  // thấy delegation + orchestration protocol vì các tool đó thực sự gọi được.
  const effectiveTools = agentTools.length > 0
    ? agentTools
    : ['delegate_task', 'escalate_problem', 'dispatch_agent', 'create_agent', 'dispatch_agents_parallel']
  // ━━━ TASK 39 — NATIVE FUNCTION CALLING qua API (root-cause fix
  // "agents nghĩ nhiều mà không gọi tools") ━━━
  // Từ Phiên 7 mọi agent chạy space-bunny-free qua HTTP trực tiếp — nhưng
  // call EXECUTE trước đây KHÔNG truyền `tools` → model không có native FC,
  // phải tự viết text `tool_call: {...}` theo protocol (model reasoning max
  // thường viết văn xuôi phân tích → gần như không bao giờ gọi tool — trước
  // Phiên 7 tools chạy được là nhờ HTTP 403 → rơi xuống CLI path có native
  // tools sẵn). Test 2026-09-28: space-bunny-free trả `tool_calls` chuẩn
  // OpenAI khi body có `tools` (finish_reason=tool_calls). callZenProvider
  // đã hỗ trợ options.tools (body.tools + tool_choice) và parse tool_calls
  // về result — goal-loop cũng đã xử lý result.tool_calls (hybrid bridge).
  // Giờ: build schema ĐẦY ĐỦ từ whitelist (getToolDefinitions); agent KHÔNG
  // khai báo whitelist ([] = mọi tool đều được phép) → truyền HẾT builtin
  // (76 tools ~15k tokens — space-bunny ctx 1M + prompt caching chấp nhận
  // được). Fail-open: lỗi build → [] (giữ text-protocol như cũ).
  // ━━━ TASK D — TOKEN EFFICIENCY (2026-10-30, theo điều tra Task B) ━━━
  // body.tools (full JSON schemas của 34 tools ~7k tokens) hiện là DEAD WEIGHT:
  // model space-bunny-free trả 0 native tool_calls qua HTTP (bỏ qua body.tools)
  // — đường hành động ĐANG HOẠT ĐỘNG là text protocol parseToolCallsFromOutput
  // dùng compact schema block trong system prompt (bên dưới, KHÔNG đụng).
  // Env knob TMO_GOAL_LOOP_NATIVE_TOOLS: '0' (mặc định) = KHÔNG gửi body.tools
  // cho call agent goal-loop (tiết kiệm ~7k tokens/vòng); '1' = bật lại native
  // FC khi model thật sự hỗ trợ (hybrid bridge native-first vẫn giữ nguyên).
  const goalLoopNativeToolsEnabled = process.env.TMO_GOAL_LOOP_NATIVE_TOOLS?.trim() === '1'
  if (!goalLoopNativeToolsEnabled) {
    console.log(`[GoalLoop] ${agentName} native tools OFF (TMO_GOAL_LOOP_NATIVE_TOOLS=0) — bỏ body.tools khỏi call LLM (~7k tok/vòng tiết kiệm), hành động vẫn chạy qua text protocol trong prompt`)
  }
  const nativeToolSchemas: LLMTool[] = (() => {
    try {
      const names = agentTools.length > 0 ? agentTools : getAllBuiltinToolNames()
      return getToolDefinitions(names) as LLMTool[]
    } catch {
      return [] // fail-open — text protocol vẫn hoạt động
    }
  })()
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
  // ROUND-39 — lesson THỬ NGHIỆM (ε-greedy) của run này — truyền xuống
  // recordEpisodeFromRun để được chấm ±nhỏ khi outcome PARTIAL có lỗi tool.
  let explorationLessonIds: string[] = []
  try {
    const { buildPreActContext } = await import('@/lib/episodic-memory/preact')
    const preAct = await Promise.race([
      buildPreActContext({ agentName, task: userMessage }),
      new Promise<null>(resolve => setTimeout(() => resolve(null), 4000)),
    ])
    if (preAct && preAct.promptBlock) {
      preActBlock = preAct.promptBlock
      appliedLessonIds = preAct.appliedLessonIds
      explorationLessonIds = preAct.explorationLessonIds ?? []
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
    // CODE TEAM SOP (2026-09-30): agent có request_code_team → inject protocol
    hasCodeTeamRequest: effectiveTools.includes('request_code_team'),
    preActBlock,
    agentName,
    // FIX 2026-09-30 (E2E audit "agents đoán mò param tool"): schema compact
    // của whitelist tools — model thấy ĐÚNG tên param + bắt buộc thay vì đoán.
    // Fail-open: lỗi build → block rỗng (prompt cũ).
    toolSchemasBlock: (() => {
      try {
        return agentTools.length > 0 ? buildCompactToolSchemasSection(agentTools) : ''
      } catch { return '' }
    })(),
    // 2026-10-27 — trần prompt theo tác vụ: -1 = không giới hạn (user directive)
    promptBudgetChars,
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
  // FIX 2026-09-14 #5: schema AgentRunRecord ĐÃ CÓ cột runId → updateMany
  // target ĐÚNG row theo (sessionId, runId, status='running').
  // Dynamic import @/lib/db theo pattern sẵn có trong file (fail-open tuyệt
  // đối — DB lỗi không được phép làm hỏng loop).
  if (agentSessionId) {
    if (resumeState) {
      try {
        void (async () => {
          const { db } = await import('@/lib/db')
          // FIX 2026-09-14 #5: row giờ CÓ cột runId → target ĐÚNG row của run
          // này (không còn phải Assumes "mọi row running trong session là run
          // này" — delegation rows sub_xxx có thể chen giữa).
          //
          // FIX 2026-09-30 (quan sát vòng 9 — crash-resume hiển thị SAI trạng
          // thái): boot stale-cleanup (instrumentation-node Task 54) đã lật row
          // này thành failed/crashed TRƯỚC khi GoalLoopWorker claim + RESUME
          // (thứ tự boot: cleanup chạy trước requeue). UpdateMany cũ lọc
          // status='running' → khớp 0 dòng → row kẹt 'failed/crashed' suốt lúc
          // run đang sống lại (UI/metrics sai — quan sát thật: run
          // run_1790755954444_1 failed/crashed 08:20:21 trong khi job RESUME
          // chạy mạnh chu kỳ 3→5). Khôi phục luôn chữ ký failed+crashed của
          // boot-cleanup về 'running'; row fail THẬT (stopReason ≠ 'crashed')
          // không bao giờ bị chạm.
          await db.agentRunRecord.updateMany({
            where: {
              sessionId: agentSessionId,
              runId: runId ?? undefined,
              OR: [
                { status: 'running' },
                { status: 'failed', stopReason: 'crashed' },
              ],
            },
            data: {
              status: 'running',
              stopReason: null,
              completedAt: null,
              startedAt: new Date(startedAt),
            },
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
          // FIX 2026-09-14 #5 — row 'running' gắn runId: updateLatestAgentRunRecord
          // lúc end khớp ĐÚNG row theo runId (delegation rows không cướp chỗ).
          runId,
        }).catch(() => { /* fail-open */ })
      } catch { /* fail-open */ }
    }
  }
  let runEnded = false
  const endRun = (status: 'done' | 'error' | 'cancelled') => {
    if (runEnded) return
    runEnded = true
    endAgentRun(agentSessionId, runId, status, `${totalIterations} vòng · ${totalToolCalls} tool calls · ${cyclesDone} chu kỳ hoàn thành${cyclesAttempted > cyclesDone ? ` (chu kỳ ${cyclesAttempted} dở)` : ''}`)
    // TASK 43 — event bus: sự kiện terminal của run (status tracker + stopReason
    // loop + counters). Fail-open bên trong emit.
    emitAgentEvent('run_terminal', {
      agentName,
      agentId,
      sessionId: agentSessionId,
      runId,
      data: { status, stopReason, cyclesDone, cyclesAttempted, totalIterations, totalToolCalls, tokensUsed, compressions, delegations, escalations },
    })
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

  // 2026-10-27 (user directive — THỜI ĐIỂM XỬ LÝ NỢ Todo follow-up): đầu MỖI
  // RUN MỚI trong cùng session, harness nhặt các Todo follow-up pending từ
  // các run trước → khối ưu tiên đặt TRƯỚC user message → agent xử lý nợ
  // TRƯỚC việc mới (chi tiết buildPendingDebtBlock). RESUME: không inject lại
  // (nợ đã nằm trong transcript snapshot nếu run trước thấy).
  const pendingDebtBlock = resumeState ? '' : await buildPendingDebtBlock(agentSessionId, runId)

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
        ...(pendingDebtBlock ? [{ role: 'user' as const, content: pendingDebtBlock }] : []),
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
  // 2026-10-27 — Thought Progress ghi rõ run này mở đầu bằng xử lý nợ kỹ thuật
  // (nguồn: Todo follow-up pending từ các run trước — xem buildPendingDebtBlock)
  if (pendingDebtBlock) {
    recordAgentThought(agentSessionId, '📋 NỢ KỸ THUẬT CÒN TREO: harness nhặt Todo follow-up pending từ các run trước trong phiên — run này ƯU TIÊN xử lý nợ TRƯỚC việc mới (user directive 2026-10-27)', 0)
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
  /** IMP-2 (F2) — bằng chứng todo (extractTodoEvidence, kể cả evidence yếu
   *  "weak:" của tool kiểm định/probe) TÍCH LŨY TOÀN CHU KỲ — reconcile ranh
   *  giới chu kỳ đối chiếu todo mở với bằng chứng của CẢ chu kỳ (không chỉ từng
   *  batch riêng lẻ như CI-2). */
  let cycleTodoEvidence: string[] = []
  // FIX 2026-09-14 #7 — E2E verification: chu kỳ có SỬA CODE + có kiểm định MẠNH?
  // cycleCodeModified = file_edit/file_multi_edit/file_write/shell chạy trong chu kỳ;
  // cycleStrongVerify = run_tests/lint/type_check/test_coverage có bằng chứng.
  let cycleCodeModified = false
  let cycleStrongVerify = false
  // FIX 2026-09-14 #9 + TASK 21 — DEBT MODE: trọng tài chấm complete nhưng
  // phát hiện side issues liên quan (debtDecision='continue') → chu kỳ debt
  // xử lý lỗi phát sinh. TASK 21: cho phép NHIỀU đợt debt cycle liên tiếp
  // (bounded bởi MAX_DEBT_CYCLES, thay cờ boolean cũ chỉ cho 1 đợt/run).
  // REVIEW 9-fix (2026-08-30): restore từ checkpoint (crash giữa debt cycle →
  // resume vẫn inject debt directive đúng + không lặp lại debt cycle đã chạy;
  // checkpoint cũ dạng boolean debtCycleUsed=true → hiểu là 1).
  let debtCyclesRun = resumeState?.debtCyclesRun ?? (resumeState?.debtCycleUsed ? 1 : 0)
  let debtMode = resumeState?.debtMode ?? false
  /** 2026-10-27 — STAGNANT DEBT GUARD (E2E lộ debt cycle lặp vô hạn với lỗi bị
   * guard chặn): fingerprint tập side issues của đợt debt gần nhất + số đợt
   * LIÊN TIẾP tập issue KHÔNG đổi (không giảm, không thêm mới có ý nghĩa).
   * LLM evaluator có thể mãi chọn 'continue' cho lỗi ngoài quyền sửa của
   * agent → guard KỸ THUẬT ép ghi nợ khi lặp không tiến triển. */
  let lastDebtFingerprint = ''
  let stagnantDebtCount = 0
  /** TASK 21 — số lần TÁI LẬP CỬA SỔ CHU KỲ đã dùng (xem renewal cuối mỗi chu kỳ) */
  let cycleRenewals = resumeState?.cycleRenewals ?? 0
  /** Side issues chưa xử lý khi run kết thúc (đã ghi Todo follow-up — report) */
  let unresolvedDebt: string[] = []
  /** REVIEW 9-fix (2026-08-30) #9 — side issues đã quyết định chạy DEBT CYCLE.
   * Nếu debt cycle THẤT BẠI (verdict chưa complete / hết budget-chu kỳ),
   * các lỗi gốc này không được phép "chìm": cuối run chúng được ghi Todo
   * follow-up + nêu trong báo cáo cuối (như nhánh debtDecision='record').
   * FIX (review R2-b #2, 2026-08-31): PERSIST vào checkpoint — crash giữa debt
   * cycle trước đây mất danh sách này (resume vẫn inject directive từ
   * lastVerdict.sideIssues nhưng evaluateCompletion không nhận debtIssues →
   * rule 10 DEBT CHECK không kích hoạt → nợ bị xóa chìm nếu phán complete). */
  let pendingDebtIssues: string[] = resumeState?.pendingDebtIssues ?? []
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
  // ROUND-3 FIX (2026-09-29 — quan sát vận hành vòng 3): flag omegaConsulted
  // sống trong process-memory — mỗi lần crash/watchdog self-exit + RESUME lại
  // reset về false → chính sách "hỏi Omega 1 lần/run" (comment thiết kế ở cả
  // 2 site auto-escalate) thực tế trở thành "1 lần MỖI RESTART". Bằng chứng
  // vòng 3: chu kỳ 17 auto-escalate → dispatch ALISTA 333s/33K tokens (trọng
  // tài CHƯA ĐẠT — vô ích), restart 08:00 (attempts 16→17), chu kỳ 21 auto-
  // escalate LẠI + ALISTA lần 2 — mỗi lần chặn main-loop ~5.5 phút. Với box
  // 4GB hay restart (17 attempts), bão escalate là có thật. Hạ capital từ
  // counter ĐÃ PERSIST: run đã từng escalate → hết quota auto (đúng thiết kế;
  // agent vẫn còn đường thủ công tool escalate_problem khi THẬT SỰ cần).
  let omegaConsulted = escalations > 0
  // ROUND-27 FIX V2 — restore tư vấn Omega + báo cáo AUTO-APPLY từ checkpoint:
  // trước đây biến này CHỈ sống trong bộ nhớ — app restart giữa 2 chu kỳ
  // (MemWatchdog self-exit — đã xảy ra 6 lần trong mission cmupl7uen) làm mất
  // TRẮNG thông tin ngay trước lúc inject (escalations>0 đã chặn consult lại
  // → không bao giờ hồi phục). Đây chính là lớp "directive điều phối nhưng
  // nhật ký không có kết quả thực thi" mà FIX E round-26 làm nổi bật nhưng
  // chưa chống mất.
  let omegaAdvisory = resumeState?.omegaAdvisory ?? ''
  let lastContent = resumeState?.lastContent ?? ''
  /** Lỗi LLM gần nhất (result.error) — surface lên báo cáo cuối thay vì nuốt lỗi */
  let lastLlmError = resumeState?.lastLlmError ?? ''
  /** 21-d: số lần đẩy feedback parse-fail (tool call bị cắt cụt giữa JSON khi
   *  output đạt maxTokens) — chống loop vô hạn nếu LLM liên tục phát JSON lỗi. */
  let parseFailNudges = resumeState?.counters.parseFailNudges ?? 0
  // ROUND-26 FIX A — counter nudge prose-only (LLM trả thuần văn bản 0 tool
  // call): mirror parseFailNudges — run-scoped, tối đa 2 lần, persist qua
  // checkpoint chống restart reset rồi nudge vô hạn.
  let proseNudges = resumeState?.counters.proseNudges ?? 0
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
        sideIssues: resumeState.verdict.sideIssues ?? [],
        debtDecision: resumeState.verdict.debtDecision ?? 'none',
        debtReadiness: resumeState.verdict.debtReadiness === 'blocked' ? 'blocked' : 'ready',
        debtBlockedReason: resumeState.verdict.debtBlockedReason ?? '',
        needsInput: resumeState.verdict.needsInput === true, // TASK 48 — resume giữ phán quyết needs-input
        raw: '',
      }
    : null
  let stopReason: GoalStopReason = 'max_cycles'
  let prevFingerprint = resumeState?.fingerprint ?? ''
  let noProgressCount = resumeState?.noProgressCount ?? 0
  /** [B4] CI-1 — số chu kỳ LIÊN TIẾP không có tool call THÀNH CÔNG nào
   *  (stall brake). Khi budget unlimited đây là phanh an toàn chính thay budget. */
  let stallCycles = resumeState?.stallCycles ?? 0
  /** 2026-09-30 (round-10) — bộ chữ ký thất bại của chu kỳ trước, cho stall brake
   *  "thất bại có chữ ký MỚI" (thất bại lặp nguyên văn chu kỳ trước = không tiến triển). */
  let prevCycleFailureSigs = new Set<string>()
  /** Chu kỳ trước có bị cắt giữa chừng (hết vòng / hết budget) không */
  let cutMidWorkPrev = resumeState?.cutMidWorkPrev ?? false
  /**
   * IMP-2 (F2 — điều tra Task F "todo drift") — reconcile todo ở RANH GIỚI CHU KỲ:
   * đếm số chu kỳ LIÊN TIẾP mỗi todo in_progress KHÔNG có bằng chứng tool khớp
   * (≥2 → cảnh báo cứng đính continuation directive chu kỳ kế — xem khối
   * reconcile sau inner loop). In-memory — resume từ checkpoint reset về 0
   * (chấp nhận được: đếm lại sau 2 chu kỳ tiếp theo).
   */
  const todoStaleCycles = new Map<string, number>()
  /** Cảnh báo todo kẹt đang chờ đính vào directive chu kỳ kế (tiêu thụ khi build) */
  let pendingTodoWarnings: string[] = []

  // ==================== 2026-10 PROCESS INTEGRITY — REPETITION DETECTION ====================
  // User report: "các chu kỳ bị lặp lại y hệt một việc, không có tiến triển".
  // Các phanh cũ đều vô hiệu trên đường CLI: stall brake dựa success tool call
  // (trước đây CLI hard-code true), fingerprint 6-message (output CLI luôn khác
  // nhau từng chút). Giờ đếm trực tiếp SIGNATURE (tên tool + args) — gọi y hệt
  // N lần là lặp THẬT không thể cãi. N=4: nhắc agent đổi cách; N≥8: cắt chu kỳ
  // chuyển evaluator đánh giá lại hướng đi. Không loại trừ tool nào — chính
  // các tool verify (file_read/grep) là thủ phạm lặp phổ biến nhất (18 vòng
  // xác minh của e2eb); verify hợp lệ hiếm khi cần ≥4 lần y hệt args.
  //
  // ROUND-12c (2026-09-30): map này TRƯỚC ĐÂY in-memory — process chết bởi RSS
  // self-exit mỗi ~2 phút (mission audit nặng) → map reset → ngưỡng 3/4/8 không
  // bao giờ đạt trong 1 đời sống (bằng chứng: chu kỳ 54-67 lặp list_skills/
  // todo_write vô hạn, "Phát hiện đọc lặp" 0 lần trong dev.log). Giờ: KHÔI
  // PHỤC từ checkpoint (worker persist toolSignatures — chỉ entry ≥2) + tính
  // streak planning-only để ép chuyển GĐ2 khi chuỗi chu kỳ không có tool triển khai.
  const toolSignatureCounts = new Map<string, number>(resumeState?.toolSignatures ?? [])
  if (resumeState?.toolSignatures?.length) {
    console.log(`[GoalLoop] ${agentName} RESUME: khôi phục ${resumeState.toolSignatures.length} tool-signature counter (chống lặp tích lũy qua restart)`)
  }
  let signatureOverrun = false
  /** ROUND-12c — số chu kỳ LIÊN TIẾP chỉ toàn tool quan sát/lập kế hoạch
   * (todo_write, list registry, read...) không có tool triển khai nào.
   * Streak ≥2 → directive chu kỳ kế ép triển khai ngay (xem buildContinuationDirective). */
  let planningOnlyStreak = resumeState?.planningOnlyStreak ?? 0
  /** ROUND-12c — chu kỳ hiện tại có tool TRIỂN KHAI (ngoài PLANNING_LOOP_TOOLS) chưa */
  let cycleHadExecutionTool = false
  /** 2026-10 — số tool call THÀNH CÔNG với signature MỚI (lần đầu xuất hiện)
   *  trong chu kỳ hiện hành — dùng làm điều kiện RENEWAL: chu kỳ chỉ lặp lại
   * các hành động cũ (verify đi verify lại) → KHÔNG được tái lập cửa sổ chu kỳ
   * (user report: tái lập tiếp tục vòng lặp vô nghĩa; evaluator tự kết luận
   * "agent is looping" nhưng renewal vẫn mở thêm chu kỳ). */
  let cycleNewSuccessSignatures = 0
  /** 2026-10 — số chu kỳ LIÊN TIẾP evaluator ra verdict GIỐNG HỆT (incomplete
   * + cùng rootCause/missing) = dấu hiệu bế tắc — chặn renewal khi ≥3. */
  let verdictStagnation = 0
  let lastVerdictStagnationSig = ''
  /** Task 21 — SHR: id mẩu CoT được truy hồi chu kỳ này (cha của mẩu chu kỳ sau — chuỗi nguồn gốc ≤3 thế hệ) */
  let cotParentSampleId: string | null = null
  /** TODO-COVERAGE (2026-10-22) — khối 📐 gần nhất đã stash vào RunContext
   * (dedupe: chỉ ghi DB khi nội dung đổi — tránh write mỗi vòng ReAct). */
  let lastStashedDataScope = ''
  const noteToolSignature = (cycleNum: number, name: string, args: Record<string, unknown>, ok: boolean): void => {
    try {
      // ROUND-12c — đánh dấu chu kỳ có tool TRIỂN KHAI (đếm cả fail: ý định
      // triển khai vẫn là triển khai, không phải planning-only)
      if (!PLANNING_LOOP_TOOLS.has(name)) cycleHadExecutionTool = true
      const sig = `${name}:${JSON.stringify(args).slice(0, 300)}`
      const n = (toolSignatureCounts.get(sig) || 0) + 1
      toolSignatureCounts.set(sig, n)
      if (n === 1 && ok) cycleNewSuccessSignatures++ // hành động THÀNH CÔNG chưa từng làm trong run này
      if (n === 3 && READ_REPEAT_TOOLS.has(name)) {
        // IMP-2 (F4) — READ-REPEAT NUDGE: tool chỉ-đọc lặp y hệt args từ lần thứ 3
        // → kết quả ĐÃ nằm trong transcript (context compression dễ làm re-read) —
        // nhắc agent DÙNG lại kết quả đó thay vì đọc lại. KHÔNG cắt — cắt cứng vẫn
        // ở ngưỡng 8 như cũ cho mọi tool.
        const readNote = `📖 ĐỌC LẶP: ${name} với args này bạn đã gọi ${n} lần — kết quả ĐÃ NẰM trong transcript phía trên, DÙNG lại kết quả đó, đừng đọc lại.`
        pushToolMessage(messages, { tool: 'harness_warning', success: true, result: readNote })
        evidence.push({ cycle: cycleNum, kind: 'directive', text: `nhắc đọc lặp: ${name}×${n} — dùng kết quả trong transcript` })
        recordAgentThought(agentSessionId, `📖 Phát hiện đọc lặp: ${name} × ${n} lần args y hệt — đã nhắc agent dùng kết quả sẵn trong transcript, đừng đọc lại`, totalIterations)
      } else if (n === 4) {
        // 2026-10 SELF-REFLECTION AUDIT (Task 19) — A4 anti-habituation: cảnh
        // báo câu CỐ ĐỊNH lặp lại nhiều run → model học cách bỏ đọc (entropy
        // collapse của guidance — SELF_REFLECTION_DESIGN §4c). Đảo ngẫu nhiên
        // 3 biến thể câu để mỗi lần xuất hiện là "mới".
        const warnVariants = [
          `⚠️ CẢNH BÁO LẶP: bạn đã gọi ${name} với ĐÚNG args này ${n} lần trong run. Hành động lặp y hệt KHÔNG tiến triển — nếu chưa đạt kết quả mong muốn thì ĐỔI CÁCH TIẾP CẬN (tool khác / args khác / escalated_problem), đừng gọi lại y hệt lần nữa.`,
          `🔁 PHÁT HIỆN XOAY VÒNG: ${name} × ${n} lần, args không đổi. Kết quả lần sau sẽ GIỐNG HỆT lần trước. Hãy dừng và tự hỏi: kết quả mong muốn khác gì kết quả đang nhận? Thiếu gì thì làm phần đó — bằng tool/cách KHÁC.`,
          `🚨 BẮT QUẢ TANG LẶP: gọi ${name} y hệt ${n} lần rồi. Trọng tài sẽ từ chối bằng chứng trùng lặp. Bước ra khỏi vòng: (1) đọc kỹ kết quả lần cuối — nó nói gì thiếu?, (2) chọn hành động KHÁC để khắc phục phần thiếu đó.`,
        ]
        const warn = warnVariants[Math.floor(Math.random() * warnVariants.length)]
        pushToolMessage(messages, { tool: 'harness_warning', success: true, result: warn })
        evidence.push({ cycle: cycleNum, kind: 'directive', text: `cảnh báo lặp: ${name}×${n} với args y hệt` })
        recordAgentThought(agentSessionId, `⚠️ Phát hiện lặp: ${name} gọi ${n} lần với args y hệt — đã cảnh báo agent đổi cách tiếp cận`, totalIterations)
      } else if (n >= 8) {
        signatureOverrun = true
        recordAgentThought(agentSessionId, `🛑 LẶP VƯỢT NGƯỠNG: ${name} gọi ${n} lần y hệt — cắt chu kỳ ${cycleNum}, chuyển evaluator đánh giá lại hướng`, totalIterations)
        evidence.push({ cycle: cycleNum, kind: 'directive', text: `🛑 lặp vượt ngưỡng: ${name}×${n} y hệt — cắt chu kỳ` })
      }
    } catch { /* fail-open — đếm signature không được phép crash loop */ }
  }

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
    counters: { cyclesDone, cyclesAttempted, totalIterations, totalToolCalls, tokensUsed, compressions, delegations, subagentTokens, escalations, parseFailNudges, proseNudges },
    verdict: lastVerdict
      ? {
          complete: lastVerdict.complete,
          confidence: lastVerdict.confidence,
          verified: lastVerdict.verified,
          missing: lastVerdict.missing,
          rootCause: lastVerdict.rootCause,
          nextPlan: lastVerdict.nextPlan,
          sideIssues: lastVerdict.sideIssues,
          debtDecision: lastVerdict.debtDecision,
          debtReadiness: lastVerdict.debtReadiness,
          debtBlockedReason: lastVerdict.debtBlockedReason,
          needsInput: lastVerdict.needsInput, // TASK 48 — snapshot giữ needs-input qua checkpoint
        }
      : null,
    // ROUND-27 FIX V2 — persist tư vấn Omega orchestrator + báo cáo AUTO-APPLY
    // sub-agent đang chờ inject vào chu kỳ kế (set ở cuối chu kỳ N — checkpoint
    // này chạy SAU escalate, TRƯỚC khi chu kỳ N+1 consume). Restart giữa 2 chu kỳ
    // giờ không còn mất trắng. Cap 8000 chars (advisory + report slice 2000 —
    // chống phình checkpoint). Optional: checkpoint cũ không có → hiểu ''.
    omegaAdvisory: omegaAdvisory.slice(0, 8000),
    fingerprint: prevFingerprint,
    noProgressCount,
    stallCycles,
    cutMidWorkPrev,
    lastContent,
    lastLlmError,
    // REVIEW 9-fix (2026-08-30) #9 + TASK 21 — persist debt/renewal state để
    // resume giữa debt cycle vẫn inject đúng debt directive + không lặp debt
    // cycle đã chạy + giữ đúng trần chu kỳ đã tái lập.
    debtMode,
    debtCyclesRun,
    cycleRenewals,
    // FIX (R2-b #2): persist danh sách debt issues còn treo — resume giữa debt
    // cycle không mất ngữ cảnh (cap 20 issue × 300 chars — chống phình checkpoint).
    pendingDebtIssues: pendingDebtIssues.slice(-20).map(s => s.slice(0, 300)),
    // ROUND-12c — persist repetition-detection + planning-loop state: process
    // chết RSS mỗi ~2 phút → không persist thì counter reset (bằng chứng chu kỳ
    // 54-67). Chỉ giữ entry count ≥2 (entry 1 chưa gần ngưỡng), cap 200 entry.
    toolSignatures: Array.from(toolSignatureCounts.entries())
      .filter(([, n]) => n >= 2)
      .slice(-200) as Array<[string, number]>,
    planningOnlyStreak,
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

  console.log(`[GoalLoop] ${agentName} bắt đầu — mục tiêu: "${userMessage.slice(0, 100)}" (max ${fmtCap(EFFECTIVE_MAX_CYCLES)} chu kỳ × ${fmtCap(EFFECTIVE_ITER_PER_CYCLE)} vòng${MAX_CYCLE_RENEWALS > 0 && EFFECTIVE_MAX_CYCLES !== 0 ? ` + tái lập tối đa ${MAX_CYCLE_RENEWALS} cửa sổ` : ''}, debt cycles tối đa ${MAX_DEBT_CYCLES}, budget ${TIME_BUDGET_MS === 0 ? '∞' : `${Math.round(TIME_BUDGET_MS / 60000)}'`} / ${TOKEN_BUDGET === 0 ? '∞ tokens (KHÔNG GIỚI HẠN — CI-1)' : `${TOKEN_BUDGET} tokens, reserve ${REPORT_RESERVE_TOKENS} cho evaluate + báo cáo cuối`}, nén context @${COMPRESS_THRESHOLD_CHARS} chars${agentTools.includes('delegate_task') ? ', delegate_task BẬT' : ''})`)
  // TASK 43 — event bus: run bắt đầu (mọi agents goal-loop — inline + durable)
  emitAgentEvent('run_started', {
    agentName,
    agentId,
    sessionId: agentSessionId,
    runId,
    data: {
      goal: userMessage.slice(0, 200),
      maxCycles: EFFECTIVE_MAX_CYCLES,
      iterPerCycle: EFFECTIVE_ITER_PER_CYCLE,
      timeBudgetMs: TIME_BUDGET_MS,
      tokenBudget: TOKEN_BUDGET,
      resumed: !!resumeState,
      toolCount: effectiveTools.length,
    },
  })

  // CI-5 (Task 14-b) — RESUME: chu kỳ bắt đầu = cyclesAttempted + 1 (chu kỳ
  // đã BẮT ĐẦU kể cả dở được tính là đã attempt — checkpoint theo VÒNG nên
  // tối đa replay 1 vòng LLM: vòng in-flight lúc crash). startedAt giữ
  // Date.now() ở trên — budget THỜI GIAN tính từ lúc resume (đúng chủ đích:
  // budget là của lần chạy này); tokensUsed đã mang tiếp từ checkpoint.
  const resumeStartCycle = resumeState ? resumeState.counters.cyclesAttempted + 1 : 1
  if (resumeState) {
    console.log(`[GoalLoop] ${agentName} RESUME từ checkpoint — chu kỳ ${resumeStartCycle}, ${totalIterations} vòng đã chạy, ${messages.length} messages, runId ${runId}`)
    // ROUND-11 (vòng quan sát 9 — FIX delegation mất trắng vô hình): restart
    // giết sub-agent đang bay (bằng chứng: sub_1790767073236_5 của SENTINEL bị
    // MemWatchdog restart #93 giết 11:27 — parent resume KHÔNG BIẾT delegation
    // từng được phát, transcript cũng không có kết quả). Delegation giờ insert
    // row 'running' lúc start (subagent-delegate fix kèm theo) + boot
    // stale-cleanup lật thành failed/crashed → query ở đây các row crashed của
    // ĐÚNG run này (cửa sổ 15' quanh lúc resume) → inject notice để agent cân
    // nhắc RE-DISPATCH thay vì tin việc đã làm. Fail-open tuyệt đối.
    if (agentSessionId && runId) {
      try {
        const { db } = await import('@/lib/db')
        const crashed = await db.agentRunRecord.findMany({
          where: {
            parentRunId: runId,
            status: 'failed',
            stopReason: 'crashed',
            completedAt: { gte: new Date(Date.now() - 15 * 60_000) },
          },
          select: { runId: true, agentName: true, startedAt: true, completedAt: true },
          take: 5,
        })
        if (crashed.length > 0) {
          const list = crashed
            .map(c => {
              const startMs = c.startedAt ? c.startedAt.getTime() : Date.now()
              const endMs = c.completedAt ? c.completedAt.getTime() : Date.now()
              return `- ${c.agentName ?? '?'} (run ${String(c.runId ?? '').slice(0, 22)}…, đã chạy ${Math.max(0, Math.round((endMs - startMs) / 1000))}s trước khi bị giết)`
            })
            .join('\n')
          // ROUND-23 P3 — dấu vết sự kiện của sub-run giờ BỀN VỮNG trên đĩa
          // (agent-runs/<subRunId>.jsonl): agent đọc được sub-run đã làm GÌ
          // trước khi chết (qua tool web_fetch URL /api/agent-run?runId=…)
          // thay vì làm lại mù. Phần dở dang vẫn phải dispatch lại — sub-run
          // không có checkpoint — nhưng KHÔNG còn "mất trắng không dấu vết".
          messages.push({
            role: 'user',
            content: `[RESUME NOTICE — GIÁN ĐOẠN DO RESTART] ${crashed.length} sub-agent delegation(s) dưới đây bị server restart giết GIỮA CHỪNG — chúng KHÔNG hoàn thành và kết quả cuối KHÔNG TỒN TẠI (không tin rằng việc đã xong). TUY NHIÊN dấu vết sự kiện (thought + tool calls + kết quả từng bước) của mỗi sub-run đã lưu bền vững — đọc lại bằng web_fetch với URL tương đối "/api/agent-run?runId=<subRunId>" (kèm query XTransformPort nếu qua gateway) để biết chính xác sub-run đã làm được tới đâu, rồi dispatch lại CHỈ phần còn thiếu:\n${list}`,
          })
          recordAgentThought(agentSessionId, `⚠️ RESUME: phát hiện ${crashed.length} delegation bị restart giết giữa chừng (kết quả mất trắng) — đã inject notice để agent cân nhắc re-dispatch`, totalIterations)
          console.log(`[GoalLoop] ${agentName} RESUME: ${crashed.length} delegation crashed do restart → inject re-dispatch notice`)
        }
      } catch { /* fail-open — notice là best-effort */ }
    }
  }

  // 2026-10 PROCESS INTEGRITY — userMessage là CHỈ ĐẠO Opus → trích mục tiêu
  // + tiêu chí nghiệm thu có cấu trúc (evaluator đối chiếu TỪNG tiêu chí thay
  // vì slice 2000 chars đầu của directive 16k — xem extractDirectiveSpec).
  const directiveSpec = extractDirectiveSpec(userMessage)

  // ===== TODO-COVERAGE (2026-10-22 hướng 1) — stash nghiệm thu lúc RUN START =====
  // RunContext.acceptanceCriteria = JSON array tiêu chí → todo_write (cả đường
  // ReAct lẫn CLI bridge tmo_todo → /api/tools/execute) đọc lại để đối chiếu
  // phủ "mỗi [Nghiệm thu n] ≥ 1 todo" NGAY trong kết quả tool. Stash sớm (không
  // đợi hết chu kỳ 1 như dataScope) vì tiêu chí có sẵn từ directive. Fail-open.
  if (agentSessionId && runId && directiveSpec.acceptance.length > 0) {
    try {
      const shr = await import('@/lib/structured-hypothesis')
      void shr.upsertRunContext({
        runId,
        sessionId: agentSessionId,
        acceptanceCriteria: JSON.stringify(directiveSpec.acceptance),
        goalDigest: directiveSpec.goal.slice(0, 400),
      }).catch(() => { /* fail-open */ })
      console.log(`[GoalLoop] ${agentName} stash ${directiveSpec.acceptance.length} tiêu chí nghiệm thu vào RunContext (todo-coverage sẽ đối chiếu)`)
    } catch { /* fail-open */ }
  }

  // ================== OUTER CYCLE LOOP ==================
  // CI-1 (0 = UNLIMITED): MAX_CYCLES = 0 → KHÔNG trần chu kỳ (loop chỉ dừng
  // bởi complete / no-progress brake / cancel / error).
  // CI-5 (14-b): resume bắt đầu từ chu kỳ kế của checkpoint (resumeStartCycle).
  //
  // TASK 21 — EFFECTIVE MAX CYCLES: trần chu kỳ HIỆN HÀNH, có thể được TÁI LẬP
  // (mở rộng +MAX_CYCLES/lần) khi hết trần mà mục tiêu CHƯA hoàn thành triệt để
  // hoặc còn lỗi phát sinh liên quan chưa xử lý (xem renewal cuối mỗi chu kỳ +
  // renew-for-debt ở khối EVALUATE). Công thức: MAX_CYCLES × (1 + cycleRenewals)
  // + Math.max với resumeStartCycle để run resume sau crash ở chu kỳ cuối cùng
  // vẫn được chạy ít nhất 1 chu kỳ đánh giá lại (không rơi vào "resume xong bỏ
  // đi" khi trần đã vượt).
  // 2026-10: dùng EFFECTIVE_MAX_CYCLES (cap=0 đã fallback safe-cap) — renewal
  // giờ HOẠT ĐỘNG cả khi .env cấu hình 0 (trước đây 0 = ∞ = không bao giờ chạm
  // trần = không bao giờ renewal).
  let effectiveMaxCycles = EFFECTIVE_MAX_CYCLES === 0
    ? 0
    : Math.max(EFFECTIVE_MAX_CYCLES + cycleRenewals * EFFECTIVE_MAX_CYCLES, resumeStartCycle)
  outerLoop: for (let cycle = resumeStartCycle; EFFECTIVE_MAX_CYCLES === 0 || cycle <= effectiveMaxCycles; cycle++) {
    if (isCancelled()) { stopReason = 'cancelled'; break }
    if (timeLeft() <= 0) { stopReason = 'time_budget'; break }
    // [A] Không bắt đầu chu kỳ mới nếu chỉ còn token reserve (dành cho final report)
    if (tokenLeft() <= REPORT_RESERVE_TOKENS) { stopReason = 'token_budget'; break }
    cyclesAttempted = cycle

    // TASK 43 FIX (bug audit) — signatureOverrun KHÔNG BAO GIỜ được reset sau
    // khi set (agent-goal-loop v trước): 1 tool lặp 8 lần ở chu kỳ N cắt chu kỳ
    // N, RỒI MỌI chu kỳ sau cũng bị cắt ngay vòng đầu (flag dính mãi) → run suy
    // biến thành chu kỳ 1-vòng, đánh giá lại liên tục không hành động. Sửa: reset
    // flag mỗi chu kỳ — chu kỳ mới có 1 cơ hội làm việc MỚI; nếu lặp lại đúng
    // signature cũ (map toolSignatureCounts vẫn còn) thì n≥8 tái kích hoạt NGAY
    // tại lần gọi kế → cắt lại lần nữa (không mất phanh chống lặp).
    signatureOverrun = false
    // TASK 43 — event bus: chu kỳ mới bắt đầu
    emitAgentEvent('cycle_started', {
      agentName,
      sessionId: agentSessionId,
      runId,
      data: { cycle, effectiveMaxCycles, debtMode, resumedFromCycle: cycle === resumeStartCycle && !!resumeState },
    })

    // 2026-10-27 (user directive — Thought Progress ghi rõ TỪNG GĐ) — GĐ0 marker
    // cho chu kỳ ĐẦU của run: quan sát & phân tích bối cảnh đầu vào trước khi
    // hành động. (Chu kỳ sau: GĐ0 marker nằm trong thought debt/continuation
    // bên dưới — ghi cùng lúc inject directive.)
    if (!lastVerdict && !debtMode) {
      recordAgentThought(agentSessionId, `📍 Chu kỳ ${cycle} — GĐ0 QUAN SÁT & PHÂN TÍCH: trích yêu cầu mục tiêu + tiêu chí nghiệm thu, quét môi trường làm việc (file_list/grep trước khi đoán), xác định biên độ dữ liệu cần đọc — trước mọi hành động`, totalIterations)
    }

    // Cycle > 1 → inject continuation directive (chẩn đoán + kế hoạch mới)
    // [G] + advisory của Omega (nếu auto-escalate đã chạy ở cuối chu kỳ trước)
    if (cycle > 1 && lastVerdict) {
      // ROUND-26 FIX E (mission cmupl7uen — Omega báo cáo "directive điều phối
      // Omega/MEGATRON nhưng nhật ký không cung cấp kết quả thực thi"): tư vấn
      // Omega orchestrator + báo cáo AUTO-APPLY sub-agent trước đây bị NỐI VÀO
      // GIỮA chuỗi khối phụ của directive (10k+ chars) → chìm, chu kỳ sau khó
      // nhận diện kết quả sub-agent. Giờ thành MESSAGE RIÊNG đẩy TRƯỚC directive
      // → cấu trúc rõ: [báo cáo điều phối + tư vấn] → [chỉ thị chu kỳ] (recency
      // vẫn thuộc directive — action items nằm cuối cùng).
      const advisoryBlock = omegaAdvisory ? `${omegaAdvisory}\n(Theo tư vấn trên — ĐỔI CÁCH TIẾP CẬN, không lặp lại hành động đã fail.)` : ''
      omegaAdvisory = ''
      // IMP-2 (F2) — cảnh báo todo kẹt do reconcile cuối chu kỳ trước tính: đính
      // CỨNG vào directive — agent phải đóng/chia nhỏ/hủy ngay chu kỳ này (todo
      // in_progress treo ≥2 chu kỳ không bằng chứng là drift thật theo điều tra F).
      const todoStaleWarnBlock = pendingTodoWarnings.length > 0
        ? `\n\n⚠️ TODO KẸT — reconcile ranh giới chu kỳ phát hiện các mục in_progress treo ≥2 chu kỳ KHÔNG có bằng chứng tool (PHẢI xử lý chu kỳ này: đánh done nếu xong, chia nhỏ việc lớn, hoặc hủy nếu không còn cần — gọi todo_write với id):\n${pendingTodoWarnings.join('\n')}`
        : ''
      pendingTodoWarnings = []

      // ===== FIX 2026-09-14 #9 — DEBT CYCLE DIRECTIVE =====
      // Chu kỳ trước trọng tài chấm complete NHƯNG quyết định 'continue' cho
      // side issues nghiêm trọng → chu kỳ này là CHU KỲ DEBT: mục tiêu chính đã
      // xong, việc duy nhất là xử lý các lỗi phát sinh (side issues).
      if (debtMode) {
        const debtList = lastVerdict.sideIssues.map(s => `- ${s}`).join('\n')
        // 2026-10-20 TASK 20 — debt cycle cũng là CLI spawn mới: kèm TODO block
        // để agent thấy todo còn mở của run (nhất quán với continuation directive)
        const debtTodosBlock = await buildRunTodosBlock(agentSessionId, runId)
        const debtDirective = `[GOAL-LOOP: Chu kỳ ${cycle}/${fmtCap(effectiveMaxCycles)} — CHU KỲ DEBT: quay lại GĐ0] Mục tiêu chính ĐÃ HOÀN THÀNH theo trọng tài độc lập ✅ — KHÔNG làm lại việc đã xong.

Chu kỳ này quay về GĐ0 (quan sát & phân tích) với thứ tự ưu tiên SẮT: TOÀN BỘ nợ kỹ thuật dưới đây được ƯU TIÊN triển khai TRƯỚC TIÊN — xử lý xong hết nợ mới tới phần việc khác (nếu mục tiêu còn việc chưa xong):
${debtList}

Quy tắc: (1) todo_write liệt kê từng lỗi cần xử lý (nợ trước, việc khác sau), (2) khắc phục từng lỗi, (3) KIỂM ĐỊNH bằng tool thật (run_tests/lint/type_check), (4) KHÔNG mở việc mới ngoài danh sách trên khi còn nợ chưa xử lý. Xong hết → báo cáo ngắn từng lỗi đã xử lý + bằng chứng.
LỖI NGOÀI QUYỀN SỬA là gì (2026-10-27 phiên 4 — chính sách TỰ PHỤC VỤ HẠ TẦNG): bạn ĐÃ ĐƯỢC PHÉP (1) tự cài package — manage_packages hoặc shell "bun add <pkg>"; (2) tự sửa DB schema — file_edit/file_write prisma/schema.prisma → shell "bun run db:push" → shell "bun run db:generate"; (3) tự xây tool còn thiếu — list_custom_tools kiểm tra → create_custom_tool đăng ký vào hệ thống (tab Tools/Skills module Smolab) rồi GỌI NGAY tool mới; (4) việc thuộc chức trách agent khác → delegate_task/dispatch_agent; (5) chưa có agent chức trách đó → escalate_problem (Omega tạo agent mới — agent mới tự cập nhật vào module Agents). Hai hạng mục (1)+(2) KHÔNG còn bị chặn — ĐỪNG kết luận "ngoài quyền sửa" khi chưa thử. Chỉ phần VẪN ĐƯỢC BẢO VỆ mới phải chờ phê duyệt: .env/keys, file data trong db/, opencode.json, .opencode/, mini-services/, config hệ thống — với các lỗi này: KHÔNG lặp thử sửa, ghi rõ trạng thái "chờ phê duyệt" + ĐIỀU KIỆN CẦN vào báo cáo rồi chuyển sang lỗi kế — đó là "đã xử lý phần của agent". Hết debt cycles mà còn lỗi treo ngoài quyền → hệ thống ghi nợ Todo follow-up kèm điều kiện, KHÔNG khởi động chu kỳ debt mới.${debtTodosBlock}${todoStaleWarnBlock}`
        // ROUND-26 FIX E — debt mode trước đây BỎ RƠI advisory (omegaAdvisory
        // reset ở trên nhưng không bao giờ inject) → tư vấn Omega + báo cáo
        // sub-agent biến mất trong debt cycle. Inject message riêng như nhánh thường.
        if (advisoryBlock) {
          messages.push({ role: 'user', content: `📡 KẾT QUẢ ĐIỀU PHỐI TỰ ĐỘNG (chu kỳ trước — ĐỌC KỸ trước khi xử lý nợ):\n${advisoryBlock}` })
        }
        messages.push({ role: 'user', content: debtDirective })
        evidence.push({ cycle, kind: 'directive', text: `DEBT CYCLE ${cycle}: xử lý ${lastVerdict.sideIssues.length} lỗi phát sinh (mục tiêu chính đã xong)` })
        recordAgentThought(agentSessionId, `📍 Chu kỳ ${cycle} — GĐ0 QUAN SÁT & PHÂN TÍCH (CHU KỲ DEBT — quay lại GĐ0): trọng tài tái khởi động chu kỳ để xử lý ${lastVerdict.sideIssues.length} lỗi phát sinh (mục tiêu chính đã hoàn thành) — TOÀN BỘ nợ kỹ thuật ƯU TIÊN triển khai TRƯỚC, sau đó mới tới việc khác`, totalIterations)
        debtMode = false // directive đã inject — chu kỳ debt chạy như chu kỳ thường (verdict cuối cùng quyết định kết thúc)
      } else {
        // ===== FIX 2026-09-14 #8 — MID-RUN SIMILAR-ERROR RECALL =====
        // Giữa các chu kỳ (không chỉ PRE-ACT đầu run): truy vấn Episodic Memory
        // các episode/lỗi TƯƠNG TỰ từng gặp (fingerprint = rootCause + tool fail
        // gần nhất) → liệt kê "lỗi tương tự đã gặp + cách đã khắc phục" vào
        // directive — chu kỳ kế không lặp lại vết xe đổ. Fire-and-forget,
        // fail-open (lỗi Qdrant/DB → bỏ qua, không chặn loop).
        let similarErrorsBlock = ''
        try {
          const { buildMidRunSimilarErrorBlock } = await import('@/lib/episodic-memory/preact')
          similarErrorsBlock = await buildMidRunSimilarErrorBlock({
            agentName,
            rootCause: lastVerdict.rootCause,
            failedTools: evidence
              .filter(e => e.kind === 'tool' && e.success === false)
              .slice(-5)
              .map(e => `${e.tool}: ${e.text.slice(0, 100)}`),
          })
        } catch { /* fail-open */ }

        // 2026-10 — tóm tắt việc chu kỳ trước ĐÃ làm thành công (chống làm lại:
        // CLI spawn mới không nhớ việc cũ → verify lại từ đầu — việc đã xong
        // được liệt kê RÕ RÀNG kèm bằng chứng ngắn trong directive, không chỉ tên tool).
        const doneItems = Array.from(new Set(
          evidence
            .filter(e => e.kind === 'tool' && e.success && e.cycle === cycle - 1)
            .map(e => (e.text && !e.text.startsWith('đã thực thi trong CLI inner loop')
              ? `${e.tool}: ${e.text.slice(0, 80)}`
              : e.tool)),
        )).slice(0, 10)
        const doneSummary = doneItems.length > 0 ? doneItems.join(' · ') : undefined
        // 2026-10 SELF-REFLECTION AUDIT (Task 19) — TODO snapshot: agent chu kỳ
        // sau (nhất là CLI spawn mới) THẤY trạng thái kế hoạch còn mở của run.
        const runTodosBlock = await buildRunTodosBlock(agentSessionId, runId)
        // ===== TASK 21 (2026-10-21) — R2 BELIEF-STATE + 📐 BIÊN ĐỘ + PRIOR CoT =====
        // (a) 🧬 BELIEF-STATE: hypothesis sống (π-channel — R2 nén xuống R1):
        //     promoted ưu tiên, candidate posterior cao kế, đã bác nêu tên.
        // (b) 📐 BIÊN ĐỘ DỮ LIỆU: parse từ báo cáo chu kỳ trước → RunContext DB
        //     → render lại (Task 21-c: chu kỳ sau không mất định hướng phạm vi).
        // (c) 🧠 Prior reasoning: mẩu CoT khớp ngữ cảnh (Jaccard ≥0.5) — nhãn
        //     "may be wrong, verify" (mẩu là prior KHÔNG phải chân lý).
        let shrBeliefBlock = ''
        let dataScopeBlock = ''
        let priorCotBlock = ''
        let uncertainBlock = ''
        try {
          const shr = await import('@/lib/structured-hypothesis')
          shrBeliefBlock = agentSessionId ? await shr.renderBeliefState(agentSessionId, runId) : ''
          const runCtx = runId ? await shr.getRunContext(runId) : null
          if (runCtx?.dataScope) {
            dataScopeBlock = `\n\n📐 BIÊN ĐỘ DỮ LIỆU đã xác định (chu kỳ trước — giữ nguyên nếu còn đúng, KHÔNG tự mở rộng phạm vi): ${runCtx.dataScope}`
          }
          // UNCERTAINTY LEDGER (2026-10-22 — phản chiếu là năng lực TRONG quy
          // trình): các mục ❓ "còn chưa chắc" của chu kỳ trước được harness
          // giữ lại (RunContext) → render đây để chu kỳ này THẤY và ưu tiên
          // kiểm chứng — phản chiếu không còn là chữ nằm trong báo cáo.
          if (runCtx?.uncertainItems) {
            uncertainBlock = shr.renderUncertainLedgerBlock(runCtx.uncertainItems, cycle)
          }
          // chữ ký ngữ cảnh hiện hành: từ khóa mục tiêu + tools đã dùng
          const usedTools = [...new Set(evidence.filter(e => e.kind === 'tool').map(e => e.tool!))].slice(0, 8)
          const ctxSig = shr.computeContextSignature(directiveSpec.goal, usedTools)
          const prior = agentSessionId ? await shr.buildPriorReasoningBlock(agentSessionId, ctxSig) : { block: '', parentSampleId: null, matchedCount: 0 }
          priorCotBlock = prior.block
          cotParentSampleId = prior.parentSampleId
          if (shrBeliefBlock || dataScopeBlock || priorCotBlock || uncertainBlock) {
            console.log(`[GoalLoop] ${agentName} chu kỳ ${cycle} SHR directive: belief=${shrBeliefBlock ? 'yes' : 'no'} dataScope=${dataScopeBlock ? 'yes' : 'no'} uncertain=${uncertainBlock ? 'yes' : 'no'} priorCoT=${prior.matchedCount} mẩu khớp`)
          }
        } catch { /* fail-open — SHR không được phép làm hỏng directive */ }
        const directive = buildContinuationDirective(lastVerdict, cycle, cutMidWorkPrev, effectiveMaxCycles, doneSummary, planningOnlyStreak) + similarErrorsBlock + runTodosBlock + todoStaleWarnBlock + dataScopeBlock + uncertainBlock + shrBeliefBlock + priorCotBlock
        // ROUND-26 FIX E — advisory (tư vấn Omega + báo cáo AUTO-APPLY sub-agent)
        // thành message RIÊNG trước directive — không còn chìm giữa các khối.
        if (advisoryBlock) {
          messages.push({ role: 'user', content: `📡 KẾT QUẢ ĐIỀU PHỐI TỰ ĐỘNG (chu kỳ trước — ĐỌC KỸ trước khi hành động):\n${advisoryBlock}` })
        }
        messages.push({ role: 'user', content: directive })
        evidence.push({ cycle, kind: 'directive', text: `Chu kỳ ${cycle}: chẩn đoán "${lastVerdict.rootCause.slice(0, 120)}" → kế hoạch mới${similarErrorsBlock ? ' + lỗi tương tự đã gặp (episodic memory)' : ''}${advisoryBlock ? ' + tư vấn Omega orchestrator' : ''}${planningOnlyStreak >= 2 ? ` + 🚨 ÉP TRIỂN KHAI (streak ${planningOnlyStreak} chu kỳ planning-only)` : ''}` })
        recordAgentThought(agentSessionId, `📍 Chu kỳ ${cycle} — GĐ0 QUAN SÁT & PHÂN TÍCH: đọc kết quả tích lũy + chẩn đoán trọng tài: ${lastVerdict.rootCause || '(không rõ)'} → lên kế hoạch lại và khắc phục${similarErrorsBlock ? ' (kèm lỗi tương tự đã gặp)' : ''}${advisoryBlock ? ' (kèm tư vấn Omega)' : ''}${planningOnlyStreak >= 2 ? ` — 🚨 PHÁ VÒNG LẶP: ${planningOnlyStreak} chu kỳ liên tiếp chỉ lập kế hoạch, chu kỳ này BẮT BUỘC triển khai tool trước` : ''}`, totalIterations)
      }
    }

    // ===== INNER REACT LOOP (EXECUTE + VERIFY theo protocol) =====
    let cycleIterations = 0
    let cycleToolCalls = 0
    cycleNewSuccessSignatures = 0 // 2026-10 — đếm lại mỗi chu kỳ (điều kiện renewal)
    cycleHadExecutionTool = false // ROUND-12c — đếm lại mỗi chu kỳ (điều kiện planning-only streak)
    cycleVerifyEvidence = [] // [C] bằng chứng kiểm định tính lại mỗi chu kỳ
    cycleTodoEvidence = [] // IMP-2 (F2) — bằng chứng todo của chu kỳ, tính lại mỗi chu kỳ
    cycleCodeModified = false // FIX #7 — tính lại mỗi chu kỳ
    cycleStrongVerify = false // FIX #7 — tính lại mỗi chu kỳ
    let endedBy: 'no_tool_calls' | 'iteration_limit' | 'error' | 'budget' | 'cancelled' = 'no_tool_calls'
    let cycleHadLlmError = false
    // FIX (R2-b #1) — IN-CYCLE BRAKE state: đếm vòng liên tiếp không tool-call
    // thành công + fingerprint transcript định kỳ (lặp = không tiến triển).
    let inCycleStallIters = 0
    let inCycleFp = ''
    let inCycleFpRepeats = 0
    // 2026-10-27 (user directive — Thought Progress ghi rõ TỪNG GĐ): marker
    // mỗi giai đoạn chỉ ghi 1 lần/chu kỳ — GĐ1 (lập kế hoạch) khi todo_write
    // đầu tiên thành công, GĐ2 (triển khai) khi tool thi công đầu tiên thành công.
    let cycleGd1Recorded = false
    let cycleGd2Recorded = false

    // 2026-10: EFFECTIVE_ITER_PER_CYCLE (cap=0 đã fallback safe-cap 8)
    while (EFFECTIVE_ITER_PER_CYCLE === 0 || cycleIterations < EFFECTIVE_ITER_PER_CYCLE) {
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
          // TASK 43 — event bus: nén context đã áp dụng (kèm receipt metadata)
          emitAgentEvent('compression_applied', {
            agentName,
            sessionId: agentSessionId,
            runId,
            data: { nth: compressions, method: comp.method, savedChars: comp.savedChars },
          })
        }
      } catch { /* fail-open — nén lỗi không được phép làm hỏng vòng lặp */ }

      // NHẮC XUẤT PHÁT (Task 23-c — E2E lộ agent bỏ todo + báo cáo markdown dày
      // trong chế độ CLI hybrid: protocol nằm ĐẦU system prompt dễ bị CLI prompt
      // lấn át → nhắc ngắn CUỐI prompt user để tận dụng recency, áp mọi provider)
      const formattedPrompt = formatMessagesForLLM(messages) +
        '\n\n📝 NHẮC TRƯỚC KHI HÀNH ĐỘNG: (1) task từ 2 bước trở lên → gọi todo_write (đường CLI: tmo_todo) lập kế hoạch TRƯỚC, xong việc nào đánh dấu completed việc đó; (2) câu trả lời/báo cáo cho người đọc: văn xuôi tiếng Việt sạch, markdown TỐI THIỂU — không bọc nhấn mạnh bằng **, không bọc từ ngữ bằng dấu ` hay dấu nháy đơn — nhấn mạnh bằng CHỮ IN HOA, liệt kê bằng gạch đầu dòng "- ".'

      let result: Awaited<ReturnType<typeof callLLMForAgent>> | null = null
      try {
        result = await withTimeout(
          callLLMForAgent(formattedPrompt, { provider: agentProvider, model: agentModel }, fullSystemPrompt, {
            agentId,
            agentName,
            sessionId: agentSessionId,
            // 2026-10-20 TASK 20: truyền runId → env TMO_RUN_ID cho CLI spawn
            // → bridge tmo_todo gắn todo ĐÚNG run (TODO block chu kỳ sau)
            runId: runId ?? null,
            temperature: agentTemperature,
            maxTokens: agentMaxTokens,
            // TASK 39 — NATIVE FC: truyền schema tools qua API → model emit
            // tool_calls chuẩn (không phải đoán text protocol). Goal-loop xử
            // lý result.tool_calls ở hybrid bridge bên dưới (ưu tiên native,
            // fallback parseToolCallsFromOutput cho provider không FC).
            // TASK D (2026-10-30): skipNativeTools theo env
            // TMO_GOAL_LOOP_NATIVE_TOOLS — '0' (mặc định) → callZenProvider
            // KHÔNG đính kèm body.tools (dead weight với model bỏ qua native
            // FC — tiết kiệm ~7k tok/vòng); '1' → hành vi TASK 39 như cũ.
            ...(nativeToolSchemas.length > 0 ? {
              tools: nativeToolSchemas,
              tool_choice: 'auto' as const,
              skipNativeTools: !goalLoopNativeToolsEnabled,
            } : {}),
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
      // FIX 2026-10-20 TASK 20 (E2E t20d lộ bug): PARTIAL-ON-TIMEOUT của CLI
      // spawn (content='' + error='timeout...' + executed_tool_calls≠rỗng)
      // bị coi là LLM fatal error → run abort ở chu kỳ 1 + VỨT toàn bộ bằng
      // chứng tool đã thực thi (E2E thực tế: 12 tool đã chạy vẫn chết cả run,
      // log "0 tool calls" dù 12 executed). Sửa: có executed_tool_calls →
      // là PARTIAL HỢP LỆ (cut-mid-work) — xử lý evidence bình thường, vòng
      // kế spawn mới nhìn thấy KẾT QUẢ TOOL THẬT trong transcript → tiếp tục
      // việc dở (đúng semantics "chữa cháy giữa chừng" của goal loop).
      const hasPartialExecuted = !!(result.executed_tool_calls && result.executed_tool_calls.length > 0)
      if (!result || (result.error && !result.content && !hasPartialExecuted)) {
        lastLlmError = result?.error || 'LLM call failed'
        cycleHadLlmError = true
        endedBy = 'error'
        break
      }

      if (typeof result.tokensUsed === 'number' && result.tokensUsed > 0) {
        tokensUsed += result.tokensUsed
      }

      lastContent = result.content
      // 2026-10 USER DIRECTIVE ("không thấy dấu hiệu tư duy / suy nghĩ của
      // agents") — suy nghĩ trung gian (reasoning/thinking parts) từ inner
      // loop CLI được llm.ts thu lại trong result.reasoning: ghi vào Thought
      // Process panel để user THẤY agent đang nghĩ gì mỗi vòng (trước đây parse
      // xong vứt — panel chỉ thấy content cuối).
      if (result.reasoning && result.reasoning.trim()) {
        recordAgentThought(agentSessionId, `💭 (suy nghĩ) ${result.reasoning.trim().slice(0, 800)}`, totalIterations)
      }
      recordAgentThought(agentSessionId, result.content, totalIterations)

      // ===== TODO-COVERAGE (2026-10-22 hướng 2) — stash 📐 MID-CYCLE =====
      // Agent viết khối 📐 ở GĐ0(c) RỒI mới gọi todo_write (GĐ1) — trước đây
      // dataScope chỉ được parse CUỐI chu kỳ (từ báo cáo) → todo_write đầu
      // chu kỳ 1 không có gì để đối chiếu phủ. Giờ parse 📐 ngay từ response
      // đang xử lý (cả text ReAct lẫn output cuối của CLI spawn) → stash vào
      // RunContext TRƯỚC khi batch tool calls (có thể chứa todo_write) thực
      // thi → coverage check trong todo_write thấy 📐 NGAY chu kỳ 1 đường
      // ReAct. Giới hạn đường CLI: 📐 trong CÙNG spawn CLI đầu vẫn chưa kịp
      // stash (CLI chạy kín quá trình inner loop) — check 📐 áp dụng từ
      // spawn/chu kỳ sau. Dedupe bằng lastStashedDataScope (1 write/đổi nội
      // dung). Fail-open tuyệt đối.
      try {
        const shrMid = await import('@/lib/structured-hypothesis')
        const scopeMid = shrMid.parseDataScopeBlock(result.content)
        // Gate looksLikeDataScope: chỉ stash khối 📐 CÓ marker phạm vi ("cần
        // đọc"/"ngoài phạm vi") — chống nhặt nhầm đoạn text chỉ NHẮC TỚI 📐
        // (nội dung todo/báo cáo trung gian — lộ E2E todo-coverage).
        if (scopeMid && scopeMid !== lastStashedDataScope && shrMid.looksLikeDataScope(scopeMid) && agentSessionId && runId) {
          lastStashedDataScope = scopeMid
          void shrMid.upsertRunContext({
            runId,
            sessionId: agentSessionId,
            dataScope: scopeMid,
          }).catch(() => { /* fail-open */ })
        }
      } catch { /* fail-open — stash 📐 không được phép làm hỏng vòng lặp */ }

      // 2026-09-25 HYBRID BRIDGE FIX: OpenCode CLI provider returns tool_calls
      // directly in LLMResult (parsed from tool_use events). Use these native
      // tool_calls FIRST — only fallback to text-based parseToolCallsFromOutput
      // when result.tool_calls is empty (legacy NIM/zai providers).
      //
      // 2026-09-26 FIX DOUBLE-EXECUTION (Tool health audit): tool_calls hiện merge
      // CẢ tool call inner loop CLI ĐÃ thực thi thật (executed_tool_calls — tmo_*
      // bridge đã POST /api/tools/execute + native bash/read/write đã chạy trong
      // CLI process). Trước đây GoalLoop thực thi lại TOÀN BỘ → (a) tên native
      // không tồn tại: "Unknown tool: bash/todowrite/read/write" (23 lỗi/24h);
      // (b) tmo_* chạy 2 LẦN (side-effect kép: shell command, todo write...);
      // (c) ToolMetric đếm mỗi hành động 2 lần (session bridge + session run).
      // Giờ: lọc executed ra khỏi hàng thực thi (khớp id — cùng object reference
      // từ llm.ts merge) + ghi evidence-only bên dưới (sau khai báo batch).
      const executedRaw = result.executed_tool_calls || []
      const executedIds = new Set(executedRaw.map(tc => tc.id))
      const executedCalls = executedRaw.map((tc, idx) => {
        let eargs: Record<string, unknown> = {}
        try {
          eargs = typeof tc.function.arguments === 'string'
            ? JSON.parse(tc.function.arguments)
            : (tc.function.arguments as Record<string, unknown>) || {}
        } catch { /* keep empty args */ }
        // Alias tên CLI-native (bash/read/write/todowrite...) → tên TMO — cùng
        // map với executeTool entry (evidence + metrics thống nhất tên tool)
        const resolved = resolveToolAlias(tc.function.name, eargs)
        return { id: tc.id || `exec_${idx}`, name: resolved.name, args: resolved.args }
      })
      let toolCalls = (result.tool_calls && result.tool_calls.length > 0
        ? result.tool_calls.map((tc, idx) => {
            // Convert LLMToolCall → ParsedToolCall shape (id, name, args object)
            let args: Record<string, unknown> = {}
            let rawArgs: string | undefined
            try {
              args = typeof tc.function.arguments === 'string'
                ? JSON.parse(tc.function.arguments)
                : (tc.function.arguments as Record<string, unknown>) || {}
            } catch {
              // ROUND-50 FIX (P2-δ r49): args native hỏng — 2 tầng hồi phục:
              // (1) LOOSE-REPAIR (tryParseLooseJson — newline thô/trailing comma
              //     trong chuỗi JSON do provider escape lệch);
              // (2) vẫn fail (args BỊ CẮT CỤT giữa chừng) → args {} + rawArgs
              //     giữ nguyên văn → batch loop PHẢN HỒI yêu cầu phát lại hoàn
              //     chỉnh (KHÔNG thực thi với args rỗng — chạy sai ý đồ còn tệ hơn
              //     không chạy; bằng chứng r49: read_skill truncated → schema
              //     "thiếu slug" mơ hồ → agent bó tay không đọc được skill).
              const rawStr = typeof tc.function.arguments === 'string' ? tc.function.arguments : ''
              const loose = tryParseLooseJson(rawStr)
              if (loose) {
                args = loose
                console.warn(`[GoalLoop] ${agentName} native tool_call "${tc.function.name}" — args JSON.parse FAILED nhưng LOOSE-REPAIR thành công (newline/trailing comma) — dùng args đã chữa`) 
              } else {
                rawArgs = rawStr
                console.warn(`[GoalLoop] ${agentName} native tool_call "${tc.function.name}" — args BỊ CẮT CỤT (loose-repair cũng fail) — sẽ phản hồi yêu cầu phát lại hoàn chỉnh) raw=${rawStr.slice(0, 120)}`)
              }
            }
            return {
              id: tc.id || `native_${idx}`,
              name: tc.function.name,
              args,
              ...(rawArgs !== undefined ? { rawArgs } : {}),
            }
          })
        : parseToolCallsFromOutput(result.content)
      ).filter(tc => !executedIds.has(tc.id))

      // Log khi native tool_calls được dùng (hybrid bridge active)
      if (result.tool_calls && result.tool_calls.length > 0) {
        console.log(`[GoalLoop] ${agentName} dùng ${result.tool_calls.length} native tool_calls từ provider=${result.provider} (hybrid bridge — ${executedCalls.length} đã thực thi trong CLI inner loop [evidence-only], ${toolCalls.length} cần thực thi)`)
      }
      if (toolCalls.length === 0 && executedCalls.length === 0) {
        // 21-d FIX SILENT PARSE-DROP: output CÓ dấu hiệu tool call ("tool_call:"
        // hoặc ```json chứa "name") nhưng parse thất bại (JSON bị cắt cụt giữa
        // chừng — thường do output quá dài chạm maxTokens) → trước đây tool call
        // bị BỎ QUA IM LẶNG, agent kết thúc 'no_tool_calls' mà không biết file
        // vừa mất. Giờ: đẩy feedback vào conversation (pattern pushToolMessage)
        // để LLM phát lại GỌN HƠN ở lượt kế — tối đa 2 lần, sau đó conclude như cũ.
        let brokenHint: string | null = null
        try {
          brokenHint = detectBrokenToolCallHint(result.content)
          if (brokenHint && parseFailNudges < 2 && timeLeft() > 0 && tokenLeft() > REPORT_RESERVE_TOKENS) {
            parseFailNudges++
            messages.push({ role: 'assistant', content: result.content })
            pushToolMessage(messages, { tool: 'parse_error', success: false, result: brokenHint })
            evidence.push({ cycle, kind: 'tool', tool: 'parse_error', success: false, text: 'tool call bị cắt/JSON lỗi — đã yêu cầu phát lại gọn hơn' })
            recordAgentThought(agentSessionId, `⚠️ Tool call bị cắt cụt giữa JSON (lần ${parseFailNudges}/2) — đã phản hồi lỗi để agent phát lại gọn hơn (chia file nhỏ, file_write append)`, totalIterations)
            continue
          }
        } catch { /* fail-open — feedback lỗi không được phép crash loop */ }
        // ━━━ ROUND-44 FIX (c) — 2 lớp khôi phục trước nudge generic ━━━
        // (1) GARBLED OUTPUT: marker template provider lẫn vào content (bằng
        //     chứng TEST A round-43 chu kỳ 2: `<]minimax[>[` dày đặc) → đốt
        //     nguyên chu kỳ vì evaluator không đọc được gì. Nudge phát lại sạch
        //     (dùng ngân sách parseFailNudges — lỗi hạ tầng, không phải lỗi agent).
        // (2) DELEGATION INTENT: content nhắc đúng tên tool huy động nhưng không
        //     phát cú pháp → nudge KÈM MẪU ĐIỀN SẴN của tool đó (nudge generic
        //     đã thất bại trong TEST A: proseNudges=2 vẫn 0 tool call cả 4 chu kỳ).
        if (!brokenHint) {
          const garbleCount = countProviderGarbleMarkers(result.content || '')
          if (garbleCount >= 3 && parseFailNudges < 2 && timeLeft() > 0 && tokenLeft() > REPORT_RESERVE_TOKENS) {
            parseFailNudges++
            // Chỉ giữ 4000 ký tự đầu — tránh nhét cả khối rác vào transcript
            messages.push({ role: 'assistant', content: (result.content || '').slice(0, 4000) })
            pushToolMessage(messages, {
              tool: 'parse_error',
              success: false,
              result: `⚠️ Output của bạn vừa bị CORRUPT ở tầng hạ tầng provider (${garbleCount} marker template lẫn vào nội dung — không phải lỗi của bạn). PHÁT LẠI nội dung gọn sạch. Nếu ý định của bạn là gọi tool thì phát ĐÚNG cú pháp: tool_call: <tên_tool>({json args}) — tuyệt đối không viết dạng văn bản.`,
            })
            evidence.push({ cycle, kind: 'tool', tool: 'parse_error', success: false, text: `garbled output (${garbleCount} provider markers) — đã yêu cầu phát lại sạch` })
            recordAgentThought(agentSessionId, `⚠️ Output bị corrupt tầng provider (${garbleCount} marker lạ) — đã phản hồi yêu cầu phát lại sạch (lần ${parseFailNudges}/2)`, totalIterations)
            continue
          }
          const intentTool = DELEGATION_INTENT_TOOLS.find(t => new RegExp(`\\b${t}\\b`).test(result.content || ''))
          if (intentTool && proseNudges < 2 && timeLeft() > 0 && tokenLeft() > REPORT_RESERVE_TOKENS) {
            proseNudges++
            messages.push({ role: 'assistant', content: result.content })
            pushToolMessage(messages, {
              tool: 'harness_warning',
              success: false,
              result: `⚠️ Bạn vừa NÓI TỚI việc gọi ${intentTool} BẰNG VĂN BẢN — 0 hành động nào được thực thi (lượt này KHÔNG được ghi nhận là tiến triển, trọng tài sẽ chấm CHƯA ĐẠT). Ý định đó phải phát NGAY dưới dạng tool_call đúng cú pháp — đúng 1 dòng, điền từ chính kế hoạch bạn vừa mô tả:\n${DELEGATION_INTENT_TEMPLATES[intentTool]}\nKhông viết thêm kế hoạch — chỉ phát tool_call.`,
            })
            evidence.push({ cycle, kind: 'tool', tool: 'harness_warning', success: false, text: `delegation-intent nudge (${intentTool} được nhắc bằng văn bản) — đã gửi mẫu tool_call điền sẵn` })
            recordAgentThought(agentSessionId, `⚠️ Phát hiện ý định gọi ${intentTool} dạng văn bản (0 tool call) — đã gửi lại mẫu cú pháp điền sẵn (lần ${proseNudges}/2)`, totalIterations)
            continue
          }
        }
        // ROUND-26 FIX A (mission cmupl7uen — Omega báo cáo "vòng lặp kẹt ở
        // trạng thái lập kế hoạch, chu kỳ 2/3/4 không thực hiện đầy đủ chuỗi"):
        // LLM trả về THUẦN VĂN (kế hoạch/kết luận, không có dấu hiệu tool call)
        // → trước đây break IM LẶNG với 2 tổn thất: (1) assistant message
        // KHÔNG được push → kế hoạch của agent BIẾN MẤT khỏi transcript (chu kỳ
        // sau + trọng tài không thấy agent đã nghĩ gì, LLM stateless phải lập
        // kế hoạch lại từ đầu), (2) KHÔNG có phản hồi sửa sai → agent lặp đúng
        // hành vi prose-only ở chu kỳ kế, mỗi lần đốt NGUYÊN CHU KỲ (bằng chứng:
        // 4 chu kỳ chỉ 1 tool call, planningOnlyStreak=3, no_progress). Giờ:
        // nudge in-cycle (tối đa 2 lần/run, budget-guard như parse nudge) yêu
        // cầu phát tool_call THẬT theo todo in_progress; sau nudge limit hoặc
        // budget cạn → push content (giữ kế hoạch cho trọng tài + chu kỳ sau)
        // rồi break như cũ.
        //
        // ROUND-50 FIX (P1-β r49): cap 2 nudge/run TẠI SAI THUỐC khi agent đang
        // trong vòng lặp planning-only — bằng chứng mission r49: 3 chu kỳ liên
        // tiếp (7-9) chỉ lập kế hoạch, "ép GĐ2" chỉ là directive cảnh báo đính
        // prompt, prose nudge (cơ chế DUY NHẤT thực sự ép tool call trong
        // cycle) đã cạn hạn mức ngay từ đầu run → 1.45M token sub-agent chẩn
        // đoán mà không thoát bế tắc → stall brake kết thúc no_progress. Giờ
        // cap ĐỘNG: đã từng planning-only (streak ≥1) → 6 lượt (1 nudge rẻ hơn
        // nhiều so với 1 chu kỳ tổn phí), agent bình thường giữ 2.
        const proseNudgeCap = planningOnlyStreak >= 1 ? 6 : 2
        if (!brokenHint && proseNudges < proseNudgeCap && timeLeft() > 0 && tokenLeft() > REPORT_RESERVE_TOKENS) {
          proseNudges++
          const streakWarn = planningOnlyStreak >= 2
            ? ` ⛔ CẢNH BÁO NẶNG: bạn đã ${planningOnlyStreak} chu kỳ LIÊN TIẾP chỉ lập kế hoạch không triển khai — stall-brake sẽ KẾT THÚC mission của bạn nếu chu kỳ này vẫn không có tool call thực thi.`
            : ''
          messages.push({ role: 'assistant', content: result.content })
          pushToolMessage(messages, {
            tool: 'harness_warning',
            success: false,
            result: `⚠️ Lượt trả lời của bạn là THUẦN VĂN BẢN — 0 tool call nào được thực thi, lượt này KHÔNG được ghi nhận là tiến triển (trọng tài sẽ chấm CHƯA ĐẠT).${streakWarn} KHÔNG viết thêm kế hoạch/kết luận bằng văn bản. Việc duy nhất bây giờ: phát NGAY 1 tool_call cho việc ĐẦU TIÊN trong todo in_progress (hoặc todo_write nếu run chưa có todo). Định dạng bắt buộc — tool_call: <tên_tool>({json args}) — ví dụ: tool_call: file_read({"path": "src/lib/agent-goal-loop.ts"}). Chỉ cần 1 tool call hợp lệ là đủ để bắt đầu.`,
          })
          evidence.push({ cycle, kind: 'tool', tool: 'harness_warning', success: false, text: `prose-only nudge (lần ${proseNudges}/${proseNudgeCap}${planningOnlyStreak >= 1 ? `, streak ${planningOnlyStreak}` : ''}) — lượt thuần văn bản 0 tool call, đã yêu cầu phát tool_call thật theo todo in_progress` })
          recordAgentThought(agentSessionId, `⚠️ Lượt output THUẦN VĂN BẢN (0 tool call, lần ${proseNudges}/${proseNudgeCap}${planningOnlyStreak >= 2 ? ` — 🚨 streak planning-only ${planningOnlyStreak} chu kỳ, chu kỳ này BUỘC phải có tool thực thi` : ''}) — đã phản hồi yêu cầu phát tool_call thật (chống vòng lặp lập kế hoạch)`, totalIterations)
          continue
        }
        // Agent tự kết luận (protocol yêu cầu đã verify + báo cáo ở đây).
        // ROUND-26 FIX A — push content TRƯỚC KHI break: kế hoạch/kết luận của
        // agent không còn biến mất khỏi transcript (trọng tài + chu kỳ sau đọc
        // được; final report vẫn lấy từ lastContent riêng — không đổi hành vi).
        messages.push({ role: 'assistant', content: result.content })
        endedBy = 'no_tool_calls'
        break
      }

      console.log(`[GoalLoop] ${agentName} chu kỳ ${cycle} vòng ${cycleIterations}: ${toolCalls.length} tool calls cần thực thi${executedCalls.length > 0 ? ` + ${executedCalls.length} đã thực thi trong CLI inner loop (evidence-only)` : ''}`)
      messages.push({ role: 'assistant', content: result.content })

      // CI-2 (Task 11-a) — bằng chứng thu được trong batch này (đường dẫn file /
      // lệnh shell của tool call THÀNH CÔNG) → auto-complete todo in_progress
      // khớp nội dung NGAY SAU batch (LLM thường quên tự đóng todo).
      const batchEvidence: string[] = []
      // FIX (R2-b #1) — batch này có ÍT NHẤT 1 tool call thành công không? (reset
      // mỗi vòng; dùng cho in-cycle stall brake)
      let batchAnySuccess = false

      // ===== 2026-09-26 EVIDENCE-ONLY + 2026-10 PROCESS INTEGRITY cho tool ĐÃ
      // thực thi trong CLI inner loop ===== (fix double-execution — KHÔNG thực
      // thi lại). 2026-10 thay đổi QUAN TRỌNG:
      //  (a) KẾT QUẢ THẬT: matched từ result.executed_tool_results (tên TMO +
      //      output/error/status) → evidence đúng success/fail (trước đây
      //      hard-code success=true → stall brake + no-progress VÔ HIỆU trên
      //      đường CLI — gốc rễ "lặp chu kỳ không tiến triển")
      //  (b) QUAN SÁT: kết quả batch được đẩy về transcript (pushToolMessage)
      //      → vòng LLM kế (CLI spawn mới) THẤY kết quả thật thay vì chỉ đọc
      //      report tự thuật → không làm lại y hệt việc đã xong
      //  (c) CHỐNG LẶP: noteToolSignature đếm (tên + args) — lặp y hệt bị
      //      cảnh báo (4×) rồi cắt chu kỳ (8×)
      const cliBatchLines: string[] = []
      const pendingExecResults = [...(result.executed_tool_results || [])]
      for (const etc of executedCalls) {
        totalToolCalls++
        cycleToolCalls++
        // Match kết quả thật — 2026-10: ưu tiên ĐÚNG callId (chính xác tuyệt đối
        // kể cả 2 call cùng tên khác args), fallback tên TMO (cùng toolMap
        // mapping bên llm.ts) — splice để 1 result không bị dùng 2 lần.
        let rIdx = etc.id ? pendingExecResults.findIndex(r => r.callId === etc.id) : -1
        if (rIdx < 0) rIdx = pendingExecResults.findIndex(r => r.name === etc.name)
        const er = rIdx >= 0 ? pendingExecResults.splice(rIdx, 1)[0] : undefined
        const ok = er ? er.success : true // không có result → giữ hành vi cũ (CLI hoàn tất call)
        noteToolSignature(cycle, etc.name, etc.args, ok)
        if (ok) batchAnySuccess = true // CHỈ success thật mới reset stall brake
        const outPreview = er ? cliToolResultPreview(er) : ''
        const evExec = extractTodoEvidence(etc.name, etc.args)
        if (ok && evExec) batchEvidence.push(evExec)
        // 2026-10 — mirror shellVerify của processToolResult (đường TMO): shell/
        // run_bg THÀNH CÔNG qua CLI inner loop (có kết quả thật) cũng là bằng
        // chứng kiểm định. E2E refl lộ gap: agent verify `cat` qua CLI bị
        // verify-guard từ chối oan ("kiểm định cuối ở tool-call #0") vì đường
        // TMO có shellVerify mà đường CLI không có → 2 chu kỳ thừa + escalate
        // không cần thiết. Giờ 2 đường đồng nhất.
        const shellVerifyCli = (etc.name === 'shell' || etc.name === 'run_bg') && ok && !!er
        if (ok && (VERIFY_TOOLS.has(etc.name) || READBACK_TOOLS.has(etc.name) || shellVerifyCli)) {
          lastVerifyOrdinal = totalToolCalls
          cycleVerifyEvidence.push(`${etc.name}: ${outPreview || 'đã thực thi trong CLI inner loop'}`)
        }
        // shell/run_bg side-effect tính modify kể cả khi exit != 0 (mirror processToolResult)
        if (MODIFY_TOOLS.has(etc.name)) lastModifyOrdinal = totalToolCalls
        if (ok && CODE_MODIFY_TOOLS.has(etc.name)) cycleCodeModified = true
        if (ok && STRONG_VERIFY_TOOLS.has(etc.name)) cycleStrongVerify = true
        recordWorkMemory(
          agentId,
          agentSessionId,
          `🔧 ${etc.name}(${compactToolArgs(etc.args)}) → ${ok ? '✓' : `✗ ${outPreview.slice(0, 150)}`}`,
        )
        evidence.push({
          cycle,
          kind: 'tool',
          tool: etc.name,
          success: ok,
          text: outPreview || (ok ? 'đã thực thi trong CLI inner loop (tmo_* bridge / native)' : 'thất bại trong CLI inner loop'),
        })
        // FIX (rà soát sau Task 21 — E2E lộ gap V16): tool native chạy trong
        // CLI inner loop KHÔNG qua executeTool TMO → recordAgentRunTool (trong
        // recordActivity của executor) không bao giờ được gọi → Thought Progress
        // panel trống tool events dù agent đã chạy thật (E2E thực tế: 2 tool
        // file_read chạy trong CLI nhưng tracker 0 tools). Ghi TRỰC TIẾP vào
        // tracker để panel hiện đúng những gì agent làm. BỎ QUA tool tmo_* —
        // bridge đã POST /api/tools/execute (server-side recordActivity tự ghi
        // event cùng session) → ghi lại lần nữa sẽ duplicate trên panel.
        const cliOriginName = (executedRaw.find(x => (x.id || '') === etc.id)?.function?.name) || ''
        if (!cliOriginName.startsWith('tmo_')) {
          try {
            recordAgentRunTool(agentSessionId, {
              tool: etc.name,
              argsSummary: compactToolArgs(etc.args),
              success: ok,
              durationMs: er?.durationMs ?? 0,
              resultPreview: outPreview ? outPreview.slice(0, 200) : undefined,
              iteration: totalIterations,
            })
          } catch { /* display-only — fail-open */ }
        }
        cliBatchLines.push(`- ${etc.name} → ${ok ? 'THÀNH CÔNG' : 'THẤT BẠI'}${outPreview ? `: ${outPreview}` : ''}`)

        // 2026-10-27 (user directive — Thought Progress ghi rõ TỪNG GĐ): GĐ1
        // marker khi todo_write đầu tiên của chu kỳ thành công (lập kế hoạch),
        // GĐ2 marker khi tool thi công đầu tiên thành công. Hai đường (CLI
        // inner loop + TMO executeTool) dùng chung cờ — ghi đúng 1 lần/chu kỳ.
        if (ok && agentSessionId) {
          const todosArg = Array.isArray(etc.args?.todos) ? etc.args.todos.length : undefined
          if (etc.name === 'todo_write' && !cycleGd1Recorded) {
            cycleGd1Recorded = true
            recordAgentThought(agentSessionId, `📍 Chu kỳ ${cycle} — GĐ1 LẬP KẾ HOẠCH: todo_write chia nhỏ kế hoạch${todosArg ? ` (${todosArg} mục)` : ''} — mỗi tiêu chí nghiệm thu ≥1 todo, việc xong đánh dấu completed ngay`, totalIterations)
          } else if (etc.name !== 'todo_write' && !cycleGd2Recorded) {
            cycleGd2Recorded = true
            recordAgentThought(agentSessionId, `📍 Chu kỳ ${cycle} — GĐ2 TRIỂN KHAI: bắt đầu thực thi bằng tools — mỗi tool call phục vụ tiêu chí nghiệm thu nào, sau mỗi kết quả NGHĨ ý nghĩa rồi mới chọn hành động kế`, totalIterations)
          }
        }

        // 2026-10-20 TASK 20 — MIRROR todo từ inner loop CLI vào TMO DB.
        // Native `todowrite` của OpenCode ghi vào storage NỘI BỘ CLI (chết theo
        // spawn) — KHÔNG bao giờ tới TMO DB → chu kỳ sau (spawn mới) mất kế
        // hoạch dù F4 render TODO block. Bridge tmo_todo đã ghi đúng run (sau
        // fix TMO_RUN_ID) — mirror lần 2 vô hại nhờ dedup (sessionId, content,
        // runId) của todoWrite. Strip field lạ (id native → update-by-pk oan,
        // activeForm...).
        // FIX E2E t20a2: AWAIT (không fire-and-forget) — native todowrite có
        // semantics REPLACE (gửi nguyên list mỗi bước) → 1 spawn có N call
        // todo_write → N mirror chạy SONG SONG thì dedup findFirst của
        // todoWrite không thấy nhau → 13 row trùng (E2E thực tế). executedCalls
        // loop vốn tuần tự → await giữ mirror tuần tự, dedup hoạt động.
        if (etc.name === 'todo_write' && ok && agentSessionId) {
          try {
            const rawTodosSrc = (er?.args && Array.isArray((er.args as Record<string, unknown>).todos))
              ? (er.args as Record<string, unknown>).todos
              : (Array.isArray(etc.args.todos) ? etc.args.todos : null)
            if (Array.isArray(rawTodosSrc)) {
              const VALID_ST = new Set(['pending', 'in_progress', 'blocked', 'completed', 'failed', 'cancelled']) // ROUND-46: + cancelled (mirror dev-tools)
              const VALID_PR = new Set(['low', 'medium', 'high'])
              const todos = (rawTodosSrc as Array<Record<string, unknown>>)
                .filter(t => t && typeof t.content === 'string' && t.content.trim() !== '')
                .slice(0, 30)
                .map(t => ({
                  content: String(t.content).slice(0, 300),
                  status: (typeof t.status === 'string' && VALID_ST.has(t.status) ? t.status : 'pending') as 'pending' | 'in_progress' | 'blocked' | 'completed' | 'failed',
                  priority: (typeof t.priority === 'string' && VALID_PR.has(t.priority) ? t.priority : undefined) as 'low' | 'medium' | 'high' | undefined,
                }))
              if (todos.length > 0) {
                try {
                  const { todoWrite } = await import('@/lib/code-team/dev-tools')
                  const mirrorRes = await todoWrite({ sessionId: agentSessionId, runId: runId ?? undefined, agentRole: agentName, todos })
                  // TODO-COVERAGE (2026-10-22): native todowrite KHÔNG trả kết
                  // quả về CLI (storage nội bộ) → agent không thấy warning phủ
                  // kế hoạch trong spawn này. Đính warning vào cliBatchLines
                  // (đẩy vào transcript ngay sau batch) để spawn/chu kỳ KẾ TIẾP
                  // thấy yêu cầu bổ sung. Bỏ qua tmo_todo — bridge đã trả
                  // coverage trực tiếp trong kết quả tool (tránh lặp noise).
                  const mirrorCov = (mirrorRes as { coverage?: { ok?: boolean; warning?: string } }).coverage
                  if (mirrorCov && mirrorCov.ok === false && mirrorCov.warning && !cliOriginName.startsWith('tmo_')) {
                    cliBatchLines.push(`- todo_write → KIỂM TRA PHỦ KẾ HOẠCH (harness): ${mirrorCov.warning}`)
                  }
                  // PROBLEM-HINT mirror (2026-10-22): native todowrite không trả
                  // kết quả về CLI → hint xử lý vấn đề (todo failed/blocked) cũng
                  // đính vào cliBatchLines cho spawn/chu kỳ kế thấy.
                  const mirrorHint = (mirrorRes as { problemHint?: string }).problemHint
                  if (mirrorHint && !cliOriginName.startsWith('tmo_')) {
                    cliBatchLines.push(`- todo_write → ${mirrorHint}`)
                  }
                } catch { /* fail-open — mirror không được phép lỗi ra ngoài */ }
              }
            }
          } catch { /* fail-open */ }
        }

        // IMP-2 (F1 — điều tra Task F "hypothesis lặp 4× qua 4 session spawn"):
        // MIRROR hypothesis_write từ inner loop CLI về session goal-loop — giống
        // gap TASK 20 đã fix cho todo nhưng hypothesis CHƯA có mirror. Trên đường
        // CLI, hypothesis_write có thể ghi vào session CỦA SPAWN (env
        // TMO_SESSION_ID của spawn / agent tự khai sessionId) → dedup SHR scoped
        // per-session của spawn sau KHÔNG thấy → propose lại NGUYÊN VĂN; đồng thời
        // belief-state render theo session goal-loop nên KHÔNG bao giờ thấy các
        // hypothesis đó. Mirror (idempotent — đã có thì dedup trả 'duplicate'):
        // propose → tạo bản sao keyed session goal-loop; judge → ghi phán quyết
        // lên bản sao khớp cơ chế (xem mirrorSpawnHypothesis). Fail-open tuyệt đối.
        if (etc.name === 'hypothesis_write' && ok && agentSessionId) {
          try {
            const shrMirror = await import('@/lib/structured-hypothesis')
            const m = await shrMirror.mirrorSpawnHypothesis({
              goalSessionId: agentSessionId,
              runId: runId ?? null,
              agentName,
              op: String(etc.args?.op ?? ''),
              args: etc.args ?? {},
            })
            if (m.mirrored) {
              console.log(`[GoalLoop] ${agentName} SHR mirror chu kỳ ${cycle}: hypothesis_write (op=${String(etc.args?.op ?? '?')}) của spawn được re-key về session goal-loop — belief-state chu kỳ sau sẽ thấy`)
            }
          } catch { /* fail-open — mirror hypothesis không được phép lỗi ra ngoài */ }
        }
      }
      // (b) QUAN SÁT — đẩy kết quả batch về transcript (bounded 400 chars/call,
      // cap bởi MAX_TOOL_RESULT_CHARS trong pushToolMessage). Đây là bước quan
      // sát mà user yêu cầu: kết quả thật HIỆN trong context, không bị mất.
      if (cliBatchLines.length > 0) {
        pushToolMessage(messages, {
          tool: 'cli_tool_results',
          success: batchAnySuccess,
          result: `KẾT QUẢ TOOL THẬT inner-loop CLI đã thực thi (harness ghi lại — Đây là SỰ THẬT, đừng làm lại việc đã THÀNH CÔNG):\n${cliBatchLines.join('\n')}`,
        })
      }

      // FIX 2026-09-14 #1/#7 — hậu xử lý tool result DÙNG CHUNG cho nhánh tuần
      // tự lẫn nhánh fan-in (token accounting · working memory · verify ordinals
      // · evidence · pushToolMessage · tracking cycleCodeModified/StrongVerify).
      const processToolResult = (tc: { name: string; args: Record<string, unknown> }, toolResult: { success: boolean; result: unknown }) => {
        // 2026-10 — đếm lặp signature cho cả đường TMO tool (mirror đường CLI)
        noteToolSignature(cycle, tc.name, tc.args, toolResult.success)
        // TASK 43 — event bus: mọi tool result phát lên bus hợp nhất
        // (/api/agent-events). Delegation/escalate có event riêng để lọc nhanh.
        emitAgentEvent('tool_executed', {
          agentName,
          sessionId: agentSessionId,
          runId,
          data: { cycle, tool: tc.name, success: toolResult.success },
        })
        if (tc.name === 'delegate_task' || tc.name === 'dispatch_agent' || tc.name === 'dispatch_agents_parallel') {
          emitAgentEvent('delegation_completed', {
            agentName,
            sessionId: agentSessionId,
            runId,
            data: { cycle, target: String(tc.args.agent ?? tc.args.agentName ?? ''), success: toolResult.success },
          })
        }
        if (tc.name === 'escalate_problem') {
          emitAgentEvent('escalation', {
            agentName,
            sessionId: agentSessionId,
            runId,
            data: { cycle, kind: 'tool', success: toolResult.success },
          })
        }
        // FIX (R2-b #1) — đánh dấu batch có tool thành công (in-cycle stall brake)
        if (toolResult.success) batchAnySuccess = true
        // CI-2 (Task 11-a) — thu bằng chứng từ tool call THÀNH CÔNG (bảo thủ:
        // chỉ path file/lệnh shell — xem extractTodoEvidence)
        if (toolResult.success) {
          const ev = extractTodoEvidence(tc.name, tc.args)
          if (ev) batchEvidence.push(ev)
        }

        // [F] TOKEN ACCOUNTING cho tool có LLM nội bộ (delegate_task /
        // dispatch_agent/dispatch_agents_parallel: sub-agent tiêu token thật;
        // escalate_problem: Omega consult) — cộng vào budget loop để không chạy
        // tuột. Token này KHÔNG được đếm ở đâu khác (executeTool không báo qua
        // callLLMForAgent).
        if (toolResult.result && typeof toolResult.result === 'object') {
          const innerTokens = (toolResult.result as { tokensUsed?: unknown }).tokensUsed
          if (typeof innerTokens === 'number' && innerTokens > 0) {
            tokensUsed += innerTokens
            if (tc.name === 'delegate_task' || tc.name === 'dispatch_agent' || tc.name === 'dispatch_agents_parallel') {
              delegations++
              subagentTokens += innerTokens
            }
          }
        }

        // ===== WORKING MEMORY (HOT) — ghi nhận tool đã chạy + kết quả =====
        // [D] Preview thông minh (errorCount + lỗi cụ thể) thay vì cắt 200 ký tự đầu
        const resultPreview = summarizeToolResult(toolResult.result).slice(0, EVIDENCE_PREVIEW_MAX_CHARS)

        // 2026-10-27 (user directive — Thought Progress ghi rõ TỪNG GĐ): GĐ1/GĐ2
        // marker cho đường TMO executeTool (đôi của hook CLI inner loop bên trên
        // — chung cờ cycleGd1Recorded/cycleGd2Recorded, ghi đúng 1 lần/chu kỳ).
        if (toolResult.success && agentSessionId) {
          const todosArg = Array.isArray(tc.args?.todos) ? tc.args.todos.length : undefined
          if (tc.name === 'todo_write' && !cycleGd1Recorded) {
            cycleGd1Recorded = true
            recordAgentThought(agentSessionId, `📍 Chu kỳ ${cycle} — GĐ1 LẬP KẾ HOẠCH: todo_write chia nhỏ kế hoạch${todosArg ? ` (${todosArg} mục)` : ''} — mỗi tiêu chí nghiệm thu ≥1 todo, việc xong đánh dấu completed ngay`, totalIterations)
          } else if (tc.name !== 'todo_write' && !cycleGd2Recorded) {
            cycleGd2Recorded = true
            recordAgentThought(agentSessionId, `📍 Chu kỳ ${cycle} — GĐ2 TRIỂN KHAI: bắt đầu thực thi bằng tools — mỗi tool call phục vụ tiêu chí nghiệm thu nào, sau mỗi kết quả NGHĨ ý nghĩa rồi mới chọn hành động kế`, totalIterations)
          }
        }

        // 2026-10-27 (user directive phiên 3) — DELEGATION LOG 📥: sub-agent
        // đã triển khai tác vụ như thế nào (kết quả đầy đủ: vòng ReAct · tool
        // calls · tokens · tóm tắt báo cáo). Cả 2 đường (fan-in song song +
        // tuần tự) đều đi qua processToolResult → 1 chỗ ghi dùng chung.
        // escalate_problem có auto-dispatch của Omega cũng ghi (autoApplied).
        if (agentSessionId && (DELEGATION_LOG_TOOLS.has(tc.name) || tc.name === 'escalate_problem')) {
          try {
            const t = buildDelegationOutcomeThought(cycle, tc, toolResult)
            if (t) recordAgentThought(agentSessionId, t, totalIterations)
          } catch { /* display-only — fail-open */ }
        }

        // [C] Harness kiểm đếm bằng chứng kiểm định theo thứ tự thời gian.
        // LƯU Ý: lint/type_check FAIL (có errorCount) VẪN LÀ bằng chứng kiểm định
        // hợp lệ — agent thấy được số lỗi cụ thể. Chỉ tool không chạy được
        // (permission disabled / exception → result là string) mới không tính.
        //
        // FIX (review 2026-09-08): shell/run_bg THÀNH CÔNG cũng tính là bằng
        // chứng kiểm định (protocol cho phép "shell kiểm tra output" — bun
        // test, cat file...). Ordinal modify/verify bằng nhau khi shell là tool
        // cuối → guard không hạ.
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

        // FIX 2026-09-14 #7 — E2E verification tracking cho trọng tài: chu kỳ có
        // SỬA CODE (thành công) và có KIỂM ĐỊNH MẠNH (run_tests/lint/type_check/
        // test_coverage chạy thật — kết quả structured dù pass hay fail).
        if (CODE_MODIFY_TOOLS.has(tc.name) && (toolResult.success || tc.name === 'shell' || tc.name === 'run_bg')) {
          cycleCodeModified = true
        }
        if (STRONG_VERIFY_TOOLS.has(tc.name) && isStructuredResult) {
          cycleStrongVerify = true
        }

        recordWorkMemory(
          agentId,
          agentSessionId,
          `🔧 ${tc.name}(${compactToolArgs(tc.args)}) → ${toolResult.success ? '✓' : '✗'} ${resultPreview}`,
        )

        evidence.push({ cycle, kind: 'tool', tool: tc.name, success: toolResult.success, text: resultPreview })

        pushToolMessage(messages, { tool: tc.name, success: toolResult.success, result: toolResult.result })
      }

      // ===== DELEGATION FAN-OUT (sửa 2026-10-29b — USER DIRECTIVE "tối đa 3
      // sub-agent, mỗi sub-agent 1 API key riêng"): batch chứa ≥2 delegation
      // (delegate_task/dispatch_agent) → launch ĐỒNG THỜI; slot pool trong
      // subagent-delegate (3 permit FIFO, mỗi permit ghim 1 key Zen) tự điều
      // tiết ≤3 chạy cùng lúc — delegation thừa xếp hàng nhận slot khi nhả.
      // Wrapper tự check pre-flight + permission + executeTool; kết quả
      // consumer ở đúng vị trí tcIdx trong vòng lặp tuần tự bên dưới (thứ tự
      // message giữ nguyên cho LLM). Lỗi của sub-agent nào báo riêng kết quả
      // sub-agent đó — KHÔNG kéo sập batch. =====
      const delegationPromises = new Map<number, Promise<{
        tcIdx: number
        preFlightFail?: string
        permissionFail?: string
        toolResult?: { success: boolean; result: unknown }
      }>>()
      {
        const delegationIdxs = toolCalls
          .map((tc, i) => ({ tc, i }))
          .filter(({ tc }) => tc.name === 'delegate_task' || tc.name === 'dispatch_agent')
        if (delegationIdxs.length >= 2) {
          // REVIEW 9-fix (2026-08-30) #1 — BUDGET CAP cho fan-out: delegation
          // thứ K chỉ được phép khi sau khi K-1 delegation trước tiêu ~40k mỗi
          // cái vẫn còn > reserve + 10k (đúng semantics nhánh tuần tự). Budget
          // unlimited (TOKEN_BUDGET=0 → Infinity) → không cap.
          const SUBAGENT_TOKEN_ESTIMATE = 40_000
          const budgetForDelegation = tokenLeft() - REPORT_RESERVE_TOKENS - 10_000
          const maxLaunch = budgetForDelegation <= 0
            ? 0
            : Math.floor(budgetForDelegation / SUBAGENT_TOKEN_ESTIMATE) + 1
          console.log(`[GoalLoop] ${agentName} DELEGATION FAN-OUT: ${delegationIdxs.length} delegation trong 1 batch → launch đồng thời, slot pool điều tiết tối đa 3 sub-agent (mỗi sub-agent 1 API key riêng — user directive 2026-10-29b), cap ${maxLaunch} theo budget`)
          for (const [delegationRank, { tc, i }] of delegationIdxs.entries()) {
            if (delegationRank >= maxLaunch) {
              // Vượt cap budget → pre-flight fail cho delegation này (kết quả
              // vẫn về đúng vị trí message — KHÔNG sập batch).
              if (agentSessionId) {
                // 2026-10-27 (user directive phiên 3) — DELEGATION LOG ⛔
                const t = buildDelegationRefusedThought(cycle, agentName, tc, `vượt cap budget fan-out (chỉ đủ ${maxLaunch} delegation)`)
                if (t) recordAgentThought(agentSessionId, t, totalIterations)
              }
              delegationPromises.set(i, Promise.resolve({
                tcIdx: i,
                preFlightFail: `Từ chối delegate (thứ ${delegationRank + 1} trong batch) — budget token của vòng lặp chỉ đủ chạy ${maxLaunch} delegation (mỗi sub-agent tiêu ~${SUBAGENT_TOKEN_ESTIMATE / 1000}k). Hãy TỰ LÀM phần việc này ngắn gọn, hoặc delegate lại lẻ ở vòng sau khi budget cho phép.`,
              }))
              continue
            }
            delegationPromises.set(i, (async () => {
              // DELEGATE PRE-FLIGHT (mirror nhánh tuần tự — check TRƯỚC khi launch;
              // slot pool phía subagent-delegate lo điều tiết concurrency + key)
              if (tokenLeft() <= REPORT_RESERVE_TOKENS + 10_000) {
                if (agentSessionId) {
                  // 2026-10-27 (user directive phiên 3) — DELEGATION LOG ⛔
                  const t = buildDelegationRefusedThought(cycle, agentName, tc, 'budget token của vòng lặp gần cạn (≤ reserve + 10k)')
                  if (t) recordAgentThought(agentSessionId, t, totalIterations)
                }
                return { tcIdx: i, preFlightFail: 'Từ chối delegate — budget token của vòng lặp gần cạn (≤ reserve + 10k). Hãy TỰ LÀM phần việc còn lại ngắn gọn thay vì delegate.' }
              }
              if (agentTools.length > 0 && !agentTools.includes(tc.name)) {
                if (agentSessionId) {
                  // 2026-10-27 (user directive phiên 3) — DELEGATION LOG ⛔
                  const t = buildDelegationRefusedThought(cycle, agentName, tc, `agent không có quyền dùng tool ${tc.name}`)
                  if (t) recordAgentThought(agentSessionId, t, totalIterations)
                }
                return { tcIdx: i, permissionFail: `Tool "${tc.name}" not available for this agent. Available: ${agentTools.join(', ')}` }
              }
              try {
                // 2026-10-27 (user directive phiên 3) — DELEGATION LOG 📤: ghi
                // NGAY TRƯỚC khi launch sub-agent — người quản trị thấy ngay việc
                // đang được giao cho agent nào (sub-agent có thể chạy nhiều phút,
                // không đợi xong mới biết đã phân công gì)
                if (agentSessionId) {
                  const t = buildDelegationDispatchThought(cycle, agentName, tc)
                  if (t) recordAgentThought(agentSessionId, t, totalIterations)
                }
                const r = await executeTool(tc.name, { ...tc.args }, { agentName, sessionId: agentSessionId, runId, promptBudgetChars })
                return { tcIdx: i, toolResult: r }
              } catch (err) {
                // No-throwError: exception của 1 delegation → kết quả fail riêng
                return { tcIdx: i, toolResult: { success: false, result: { error: err instanceof Error ? err.message : String(err) } } }
              }
            })())
          }
        }
      }

      // ROUND-50 FIX (P3-ε r49) — HEARTBEAT TICKER trong tool batch: sub-agent
      // (dispatch_agent/delegate_task) + shell dài chạy ĐỒNG BỘ trong batch —
      // không vòng LLM nào chạy suốt quãng đó → fireSignal không được gọi →
      // heartbeatAt của durable job đứng im (bằng chứng r49: stale 444s trong
      // lúc ALISTA chạy — orphan sweep sau restart đòi distinguish sống/chết
      // bằng heartbeat). Ticker 30s giữ tín hiệu sống trong SUỐT batch; tĩnh
      // tại mọi lối thoát (break/cancel) qua try/finally. Fail-open.
      const batchHeartbeatTimer = setInterval(() => {
        try { fireSignal('tool_batch') } catch { /* fail-open */ }
      }, 30_000)
      try {
      for (const [tcIdx, tc] of toolCalls.entries()) {
        if (isCancelled()) {
          // TASK 43 FIX (bug audit) — cancel giữa batch: trước đây break NGAY
          // không đẩy stub response cho các tool_call còn lại trong batch →
          // transcript có tool_call mồ côi (không có tool reply). Mirror đường
          // budget-cạn: stub cho TẤT CẢ call còn lại (kể cả current) rồi thoát.
          for (const rest of toolCalls.slice(tcIdx)) {
            pushToolMessage(messages, { tool: rest.name, success: false, result: 'Bỏ qua — run đã bị HỦY giữa batch (người dùng bấm Dừng).' })
          }
          endedBy = 'cancelled'
          break
        }

        // ===== FAN-IN consumer — delegation đã chạy song song ở trên: await kết
        // quả (thường đã resolve) + xử lý ĐÚNG như nhánh tuần tự (giữ thứ tự
        // message cho LLM). ĐÃ TRẢ TIỀN cho sub-agent → không bị budget-guard
        // vứt stub (kết quả đã trả phải về tay agent). =====
        const pendingDelegation = delegationPromises.get(tcIdx)
        if (pendingDelegation) {
          const r = await pendingDelegation
          if (r.preFlightFail) {
            pushToolMessage(messages, { tool: tc.name, success: false, result: r.preFlightFail })
            evidence.push({ cycle, kind: 'tool', tool: tc.name, success: false, text: 'từ chối (budget cha gần cạn)' })
            continue
          }
          totalToolCalls++
          cycleToolCalls++
          if (r.permissionFail) {
            pushToolMessage(messages, { tool: tc.name, success: false, result: r.permissionFail })
            evidence.push({ cycle, kind: 'tool', tool: tc.name, success: false, text: 'bị từ chối (không có quyền)' })
            continue
          }
          processToolResult(tc, r.toolResult!)
          continue
        }

        // ROUND-50 FIX (P2-δ r49): native tool_call args BỊ CẮT CỤT (JSON.parse
        // fail sau loose-repair — xem tầng parse ở trên) → KHÔNG thực thi với
        // args rỗng (chạy sai ý đồ còn tệ hơn không chạy) — phản hồi nguyên văn
        // phần args đến được + yêu cầu phát LẠI tool_call hoàn chỉnh. Agent tự
        // sửa ở lượt kế (bằng chứng r49: read_skill truncated → schema "thiếu
        // slug" mơ hồ → agent không đọc được skill agent-browser).
        if (tc.rawArgs !== undefined) {
          pushToolMessage(messages, {
            tool: tc.name,
            success: false,
            result: `⚠️ Tool call "${tc.name}" của bạn bị CẮT CỤT ở tầng hạ tầng (args JSON không hoàn chỉnh — không thể parse, tool KHÔNG được thực thi). Nguyên văn phần args đến được: ${tc.rawArgs.slice(0, 400)} — Hãy phát LẠI tool_call HOÀN CHỈNH cho tool này (rút gọn args nếu cần để không bị cắt).`,
          })
          evidence.push({ cycle, kind: 'tool', tool: tc.name, success: false, text: 'args bị cắt cụt (JSON không hoàn chỉnh) — đã yêu cầu phát lại hoàn chỉnh' })
          recordAgentThought(agentSessionId, `⚠️ Tool call "${tc.name}" bị cắt cụt args ở tầng provider — đã yêu cầu agent phát lại hoàn chỉnh`, totalIterations)
          continue
        }

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
          if (agentSessionId) {
            // 2026-10-27 (user directive phiên 3) — DELEGATION LOG ⛔
            const t = buildDelegationRefusedThought(cycle, agentName, tc, 'budget token của vòng lặp gần cạn (≤ reserve + 10k)')
            if (t) recordAgentThought(agentSessionId, t, totalIterations)
          }
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
          if (agentSessionId && DELEGATION_LOG_TOOLS.has(tc.name)) {
            // 2026-10-27 (user directive phiên 3) — DELEGATION LOG ⛔
            const t = buildDelegationRefusedThought(cycle, agentName, tc, `agent không có quyền dùng tool ${tc.name}`)
            if (t) recordAgentThought(agentSessionId, t, totalIterations)
          }
          pushToolMessage(messages, { tool: tc.name, success: false, result: `Tool "${tc.name}" not available for this agent. Available: ${agentTools.join(', ')}` })
          evidence.push({ cycle, kind: 'tool', tool: tc.name, success: false, text: `bị từ chối (không có quyền)` })
          continue
        }

        // todo_write → inject sessionId (todos theo phiên chat, không đổ dồn "default")
        // CI-2 (Task 11-a): inject THÊM runId của run hiện tại — todo được scope
        // theo TỪNG RUN (per-task isolation: run mới không thấy todo run cũ).
        //
        // ROUND-11 (vòng quan sát 9 — FIX 'default' hallucination): chính sách cũ
        // "agent tự khai sessionId khác → tôn trọng" vô tình tôn trọng ẢO GIÁC
        // của model (probe round-11: space-bunny-free phát
        // {"sessionId": "default", "agentRole": "TL"} — todo rơi bucket "default"
        // → buildRunTodosBlock + TodoCoverage theo session thật KHÔNG THẤY →
        // kế hoạch mất liên tục giữa các chu kỳ). Goal-loop LÀ chủ sở hữu scope
        // của run này → LUÔN ép sessionId/runId ĐÚNG (khai báo trùng = no-op),
        // agentRole ép về tên agent để panel Todos + todo_read filter đúng nhãn.
        const toolArgs: Record<string, unknown> = { ...tc.args }
        if (
          (tc.name === 'todo_write' || tc.name === 'todo_read' || TASK_DAG_TOOLS.has(tc.name)) &&
          agentSessionId
        ) {
          if (toolArgs.sessionId !== agentSessionId) {
            if (toolArgs.sessionId) {
              console.log(`[GoalLoop] ${agentName} ${tc.name}: sessionId khai báo "${String(toolArgs.sessionId).slice(0, 60)}" ≠ session run → ép về session thật (chống todo rơi scope sai)`)
            }
            toolArgs.sessionId = agentSessionId
          }
          if (runId && toolArgs.runId !== runId) toolArgs.runId = runId
          if (tc.name === 'todo_write' && toolArgs.agentRole !== agentName) toolArgs.agentRole = agentName
        }

        // DELEGATION CONTRACT (fix 2026-09-12): truyền runId vào context —
        // delegate_task đọc context.runId làm parentRunId (Thought Process panel
        // hiển thị "delegated bởi run_X").
        // 2026-10-27 (user directive phiên 3) — DELEGATION LOG 📤: ghi NGAY
        // TRƯỚC khi launch sub-agent (ai giao ai làm gì — không đợi xong mới biết)
        if (agentSessionId && DELEGATION_LOG_TOOLS.has(tc.name)) {
          const t = buildDelegationDispatchThought(cycle, agentName, tc)
          if (t) recordAgentThought(agentSessionId, t, totalIterations)
        }
        // 2026-10-27 (rà soát Task 27-a): truyền trần prompt THEO TÁC VỤ vào
        // context — request_code_team chuyển tiếp cho workflow steps (PROMPT ∞
        // áp đồng bộ cả chuỗi delegation của tác vụ).
        const toolResult = await executeTool(tc.name, toolArgs, { agentName, sessionId: agentSessionId, runId, promptBudgetChars })

        processToolResult(tc, toolResult)
      }

      // FAN-IN log — ghi dấu hợp nhất cho ops theo dõi
      if (delegationPromises.size >= 2) {
        evidence.push({ cycle, kind: 'directive', text: `FAN-OUT/FAN-IN: ${delegationPromises.size} delegation đã chạy song song (slot pool điều tiết ≤3, mỗi sub-agent 1 key riêng) và hợp nhất kết quả về 1 batch` })
        recordAgentThought(agentSessionId, `🔀 FAN-OUT/FAN-IN: ${delegationPromises.size} sub-agent trong batch này chạy song song (tối đa 3 cùng lúc — mỗi sub-agent 1 API key riêng, user directive 2026-10-29b) — kết quả đã hợp nhất`, totalIterations)
      }
      } finally {
        clearInterval(batchHeartbeatTimer)
      }

      // ===== FIX (R2-b #1) — IN-CYCLE STALL BRAKE (ITER_PER_CYCLE=0 + TOKEN=∞) =====
      // Stall-brake/no-progress chỉ chạy ở BIÊN CHU KỲ — trước đây 1 chu kỳ có thể
      // đốt cả 12h khi model phát tool call mãi không tiến triển (kể cả toàn fail
      // hoặc lặp đi lặp lại). 2 phanh: (1) N vòng liên tiếp không tool-call thành
      // công; (2) fingerprint (mỗi 10 vòng) lặp M lần. Cắt = 'iteration_limit'
      // (evaluator vẫn đánh giá; chu kỳ stall tăng đếm stall-brake biên chu kỳ).
      if (IN_CYCLE_STALL_ITERATIONS > 0) {
        if (batchAnySuccess) {
          inCycleStallIters = 0
        } else {
          inCycleStallIters++
          if (inCycleStallIters >= IN_CYCLE_STALL_ITERATIONS) {
            console.warn(`[GoalLoop] ${agentName} IN-CYCLE STALL BRAKE: ${inCycleStallIters} vòng LIÊN TIẾP không có tool call thành công nào (chu kỳ ${cycle}) — cắt chu kỳ giữa chừng, chuyển evaluator`)
            recordAgentThought(agentSessionId, `⚠️ Phanh trong chu kỳ: ${inCycleStallIters} vòng liên tiếp toàn tool call thất bại — cắt chu kỳ ${cycle} giữa chừng để evaluator đánh giá lại hướng đi`, totalIterations)
            endedBy = 'iteration_limit'
            break
          }
        }
      }
      if (cycleIterations % IN_CYCLE_FP_CHECK_EVERY === 0) {
        const fp = progressFingerprint(messages)
        if (fp === inCycleFp && fp !== '') {
          inCycleFpRepeats++
          if (inCycleFpRepeats >= IN_CYCLE_FP_MAX_REPEATS) {
            console.warn(`[GoalLoop] ${agentName} IN-CYCLE NO-PROGRESS: fingerprint transcript lặp ${inCycleFpRepeats}× (mỗi ${IN_CYCLE_FP_CHECK_EVERY} vòng, chu kỳ ${cycle}) — agent xoay vòng lặp lại cùng hành động — cắt chu kỳ giữa chừng, chuyển evaluator`)
            recordAgentThought(agentSessionId, `⚠️ Phanh trong chu kỳ (no-progress): transcript lặp y hệt ${inCycleFpRepeats * IN_CYCLE_FP_CHECK_EVERY} vòng — agent đang xoay vòng lặp — cắt chu kỳ ${cycle} để evaluator đánh giá lại`, totalIterations)
            endedBy = 'iteration_limit'
            break
          }
        } else {
          inCycleFp = fp
          inCycleFpRepeats = 0
        }
      }

      // 2026-10 — SIGNATURE OVERRUN: tool lặp y hệt (tên + args) ≥8 lần trong
      // run → agent xoay vòng vô nghĩa — cắt chu kỳ giữa chừng, chuyển evaluator
      // đánh giá lại hướng đi (evaluator sẽ ra directive ĐỔI cách tiếp cận).
      if (signatureOverrun) {
        console.warn(`[GoalLoop] ${agentName} SIGNATURE-OVERRUN: tool lặp y hệt vượt ngưỡng 8 lần — cắt chu kỳ ${cycle} giữa chừng, chuyển evaluator`)
        endedBy = 'iteration_limit'
        break
      }

      // ===== CI-2 (Task 11-a) — MID-RUN EVIDENCE-BASED AUTO-COMPLETE =====
      // Sau mỗi batch tool call: todo 'in_progress' của ĐÚNG run hiện tại mà
      // nội dung chứa đúng đường dẫn file / lệnh shell của tool call THÀNH CÔNG
      // → tự đánh dấu 'completed' + snapshot lại todo list của run cho panel.
      // LLM thường quên gọi todo_write đóng bước → đây là lưới an toàn dựa trên
      // bằng chứng THẬT (substring match chặt, chỉ todo đúng runId). Fail-open.
      if (agentSessionId && runId && batchEvidence.length > 0) {
        // IMP-2 (F2) — tích lũy bằng chứng TOÀN CHU KỲ cho reconcile ranh giới chu kỳ
        // (CI-2 dưới chạy theo TỪNG batch; reconcile cuối chu kỳ đối chiếu tổng)
        cycleTodoEvidence.push(...batchEvidence)
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
              parentId: t.parentId ?? null,
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
      if (EFFECTIVE_ITER_PER_CYCLE > 0 && cycleIterations >= EFFECTIVE_ITER_PER_CYCLE) {
        endedBy = 'iteration_limit'
      }
    }

    cutMidWorkPrev = endedBy === 'iteration_limit' || endedBy === 'budget'

    // ===== IMP-2 (F2 — điều tra Task F "todo drift") — CYCLE-BOUNDARY TODO RECONCILE =====
    // Trước đây cập nhật todo là TÌNH NGUYỆN (protocol + CI-2 per-batch chỉ khớp
    // bằng chứng MODIFY) → todo kiểm thử/tổng hợp KHÔNG bao giờ khớp → kẹt
    // in_progress đến tận cuối run mới bị honest-close (bằng chứng thực tế: 3
    // in_progress kẹt 13-23 phút trong khi agent chạy tool liên tục). Giờ ở MỖI
    // ranh giới chu kỳ (ngay sau inner loop): (a) chạy lại auto-complete với
    // bằng chứng TOÀN chu kỳ (đã mở rộng bộ evidence — tool kiểm định/probe sinh
    // evidence yếu "weak:", xem dev-tools), (b) đếm số chu kỳ LIÊN TIẾP mỗi todo
    // in_progress KHÔNG có bằng chứng khớp → ≥2 chu kỳ đính cảnh báo CỨNG vào
    // continuation directive chu kỳ kế (todoStaleWarnBlock). Deterministic — 0
    // LLM call, chỉ string matching (evidenceMatchesTodo dùng chung CI-2).
    // Fail-open tuyệt đối — reconcile KHÔNG được phép làm hỏng chu kỳ.
    if (agentSessionId && runId && endedBy !== 'cancelled') {
      try {
        // (a) todo provable-by-evidence của cả chu kỳ → auto-done + log
        if (cycleTodoEvidence.length > 0) {
          const res = await autoCompleteRunTodosByEvidence({
            sessionId: agentSessionId,
            runId,
            evidence: cycleTodoEvidence,
          })
          if (res.completed > 0) {
            recordAgentRunTodos(agentSessionId, res.todos.map(t => ({
              id: t.id,
              content: t.content,
              status: t.status,
              priority: t.priority,
              parentId: t.parentId ?? null,
            })))
            recordAgentThought(
              agentSessionId,
              `✅ RECONCILE chu kỳ ${cycle}: tự hoàn thành ${res.completed} todo theo bằng chứng tool của cả chu kỳ (kể cả bằng chứng kiểm định/probe)`,
              totalIterations,
            )
          }
        }
        // (b) stale in_progress — cảnh báo cứng khi treo ≥2 chu kỳ không bằng chứng
        const { db } = await import('@/lib/db')
        const openNow = await db.todo.findMany({
          where: { sessionId: agentSessionId, runId, status: { in: ['pending', 'in_progress', 'blocked'] } },
          select: { id: true, content: true, status: true },
          orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
          take: 30,
        })
        const openIds = new Set(openNow.map(t => t.id))
        for (const id of [...todoStaleCycles.keys()]) {
          if (!openIds.has(id)) todoStaleCycles.delete(id) // đã đóng/chuyển trạng thái → reset đếm
        }
        for (const t of openNow) {
          if (t.status !== 'in_progress') continue // pending = chưa bắt đầu, blocked = agent tự khai — không cảnh báo
          const hadEvidence = cycleTodoEvidence.some(ev => evidenceMatchesTodo(ev, t.content))
          if (hadEvidence) {
            todoStaleCycles.delete(t.id)
            continue
          }
          const n = (todoStaleCycles.get(t.id) ?? 0) + 1
          todoStaleCycles.set(t.id, n)
          if (n >= 2) {
            pendingTodoWarnings.push(`⚠ Todo [id ${t.id}] "${t.content.slice(0, 100)}" in_progress ${n} chu kỳ không có bằng chứng — đánh giá lại: đánh done nếu xong, chia nhỏ, hoặc hủy.`)
          }
        }
        if (pendingTodoWarnings.length > 0) {
          pendingTodoWarnings = [...new Set(pendingTodoWarnings)].slice(-5) // cap 5 cảnh báo — chống phình directive
          console.warn(`[GoalLoop] ${agentName} RECONCILE chu kỳ ${cycle}: ${pendingTodoWarnings.length} todo in_progress kẹt ≥2 chu kỳ không bằng chứng → cảnh báo đính directive chu kỳ ${cycle + 1}`)
        }
      } catch { /* fail-open — reconcile không được phép làm hỏng chu kỳ */ }
    }

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
    // ROUND-12c — cập nhật planning-only streak: chu kỳ KHÔNG có tool triển khai
    // nào (chỉ todo_write/list registry/hoặc 0 tool) → streak+1; có ≥1 tool
    // triển khai (kể cả fail) → reset. Streak ≥2 → chu kỳ kế bị ép triển khai.
    planningOnlyStreak = cycleHadExecutionTool ? 0 : planningOnlyStreak + 1
    if (planningOnlyStreak >= 2) {
      console.log(`[GoalLoop] ${agentName} ⚠️ PLANNING-ONLY STREAK ${planningOnlyStreak} chu kỳ (không tool triển khai) — chu kỳ ${cycle + 1} sẽ ép GĐ2 triển khai`)
      recordAgentThought(agentSessionId, `🚨 Phát hiện vòng lặp lập kế hoạch: ${planningOnlyStreak} chu kỳ liên tiếp không có tool triển khai nào — chu kỳ kế bị ép chuyển sang GĐ2 (triển khai) ngay`, totalIterations)
    }
    const strongVerifyToolsAvailable = effectiveTools.some(t => STRONG_VERIFY_TOOLS.has(t))
    // 2026-10 — directive Opus: evaluator thấy MỤC TIÊU sạch + TỪNG tiêu chí
    // nghiệm thu (trước đây slice 2000 chars đầu của directive 16k làm mất
    // phần quan trọng nhất — đánh giá hời hợt theo user).
    const evaluatorGoal = directiveSpec.acceptance.length > 0
      ? `${directiveSpec.goal}\n\nTIÊU CHÍ NGHIỆM THU (đối chiếu TỪNG điều — đủ hết mới complete=true):\n${directiveSpec.acceptance.map(a => `- [ ] ${a}`).join('\n')}`
      : directiveSpec.goal
    let verdict = await evaluateCompletion({
      goal: evaluatorGoal,
      lastAssistantContent: lastContent,
      evidence,
      verifyEvidence: cycleVerifyEvidence,
      unverifiedModifications: lastModifyOrdinal > lastVerifyOrdinal,
      // FIX 2026-09-14 #7 — E2E verification signals cho trọng tài (quy tắc 8)
      codeModified: cycleCodeModified,
      hasStrongVerify: cycleStrongVerify,
      strongVerifyToolsAvailable,
      // TASK 21 — DEBT CHECK: truyền danh sách lỗi phát sinh chưa xử lý
      // (đang treo từ các chu kỳ trước) để evaluator đối chiếu từng lỗi với
      // bằng chứng chu kỳ này — debt cycle dở không bị phán complete sạch.
      debtIssues: pendingDebtIssues.length > 0 ? pendingDebtIssues : undefined,
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
      // IMP-2 (H G1 — audit Task H "false-done"): nhánh complete=true cứng
      // (confidence 0.6) trước đây KHÔNG phân biệt Q&A thuần vs mục tiêu hành
      // động — mục tiêu CÓ tiêu chí nghiệm thu/todo + evaluator LLM fail/timeout/
      // truncate = FALSE-DONE (todos pending bị auto-complete theo complete, run
      // kết thúc oan). Chỉ chấp nhận complete mặc định khi mục tiêu THUẦN Q&A:
      // KHÔNG có tiêu chí nghiệm thu VÀ run chưa từng tạo todo nào. Ngược lại →
      // complete=false (fail-safe — incomplete-churn an toàn hơn false-done),
      // confidence thấp + continuation directive yêu cầu bằng chứng tool.
      let runHasTodos = false
      if (agentSessionId && runId) {
        try {
          const { db } = await import('@/lib/db')
          const n = await db.todo.count({ where: { sessionId: agentSessionId, runId } })
          runHasTodos = n > 0
        } catch { runHasTodos = true /* fail-safe: không kiểm tra được → không phán complete */ }
      }
      if (cycleToolCalls === 0 && pendingDebtIssues.length === 0
        && directiveSpec.acceptance.length === 0 && !runHasTodos) {
        verdict = { complete: true, confidence: 0.6, verified: false, missing: [], rootCause: '', nextPlan: [], sideIssues: [], debtDecision: 'none', debtReadiness: 'ready', debtBlockedReason: '', needsInput: false, raw: '(evaluator unavailable — pure answer accepted)' }
      } else if (cycleToolCalls === 0 && pendingDebtIssues.length === 0) {
        // IMP-2 (H G1): mục tiêu HÀNH ĐỘNG (có nghiệm thu/todo) + 0 tool call +
        // evaluator hỏng → KHÔNG complete — directive chu kỳ sau (kèm dòng ⚠️
        // CHƯA kiểm định của buildContinuationDirective) yêu cầu bằng chứng tool.
        verdict = {
          complete: false,
          confidence: 0.3,
          verified: false,
          missing: ['(evaluator lỗi — kết luận thuần text KHÔNG đủ: chạy tool thật (file_read/run_tests/lint/type_check/shell...) và trích kết quả cụ thể làm bằng chứng)'],
          rootCause: '(evaluator LLM lỗi — mục tiêu có tiêu chí nghiệm thu/todo nên không thể chấp nhận hoàn thành khi chưa có bằng chứng tool)',
          nextPlan: [],
          sideIssues: [],
          debtDecision: 'none',
          debtReadiness: 'ready',
          debtBlockedReason: '',
          needsInput: false, // TASK 48 — heuristic fallback: không tin needsInput khi evaluator hỏng
          raw: '(evaluator unavailable — action-goal không chấp nhận complete mặc định)',
        }
      } else {
        // FIX (R2-b #4): evaluator hỏng mà debt issues còn TREO → KHÔNG phán
        // complete (nhánh complete sẽ xóa pendingDebtIssues chìm). Giữ
        // complete=false + relist debt làm sideIssues (debtDecision='record') —
        // run kết thúc vẫn ghi Todo follow-up từng lỗi.
        const hasPendingDebt = pendingDebtIssues.length > 0
        verdict = {
          complete: false,
          confidence: 0.5,
          verified: false,
          missing: hasPendingDebt
            ? ['(evaluator lỗi — tự đối chiếu các lỗi phát sinh còn treo với bằng chứng)']
            : ['(không đánh giá được — tự rà soát)'],
          rootCause: hasPendingDebt
            ? '(evaluator LLM lỗi trong khi còn debt issues chưa xử lý)'
            : '(evaluator LLM lỗi — kiểm tra lại toàn bộ kết quả)',
          nextPlan: [],
          sideIssues: hasPendingDebt ? pendingDebtIssues.slice() : [],
          debtDecision: hasPendingDebt ? 'record' : 'none',
          debtReadiness: 'ready',
          debtBlockedReason: '',
          needsInput: false, // TASK 48 — heuristic fallback: không tin needsInput khi evaluator hỏng
          raw: '(evaluator unavailable)',
        }
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

    // ===== 2026-10 — VERDICT STAGNATION TRACKING (điều kiện renewal) =====
    // Evaluator ra verdict GIỐNG HỆT chu kỳ trước (incomplete + cùng rootCause +
    // cùng missing) = bế tắc: agent đã thử mà không đổi được tình thế. ≥3 chu kỳ
    // liên tiếp như vậy → chặn renewal (đã thấy ở E2E proc2: evaluator tự kết
    // luận "agent is looping" nhưng renewal vẫn mở thêm cửa sổ chu kỳ).
    {
      const stagSig = `${verdict.complete}|${verdict.rootCause}|${verdict.missing.join('§')}`
      if (stagSig === lastVerdictStagnationSig) {
        verdictStagnation++
      } else {
        verdictStagnation = 0
        lastVerdictStagnationSig = stagSig
      }
    }

    // ===== FIX 2026-09-14 #9 + TASK 21 — SIDE ISSUES / DEBT DECISION (trọng
    // tài quyết định thay vì "chấm xong là xong"): mục tiêu hoàn thành NHƯNG có
    // lỗi phát sinh còn tồn tại → lựa chọn của trọng tài:
    //   debtDecision='continue' + còn lượt debt (MAX_DEBT_CYCLES) + còn budget
    //     → KHÔNG dừng: chu kỳ debt xử lý lỗi phát sinh (directive inject đầu
    //       chu kỳ debt ở trên). TASK 21: NHIỀU đợt liên tiếp được phép — debt
    //       cycle trước dở/mở thêm lỗi mới → đợt debt nữa cho tới khi sạch
    //       hoặc cạn lượt (điều kiện dừng bounded, không vô hạn).
    //   Trần chu kỳ đang chặn debt cycle (cycle >= effectiveMaxCycles) nhưng
    //   còn lượt TÁI LẬP → mở rộng cửa sổ chu kỳ (renewal) thay vì ghi nợ rồi
    //   kết thúc vội (user report 2026-09-30: trọng tài không được phán kết
    //   thúc khi còn vấn đề phát sinh liên quan giải quyết được).
    //   'record' (issue ngoài khả năng agent) hoặc 'continue' mà hết lượt
    //   debt/budget → hoàn thành + GHI NỢ: mỗi side issue 1 Todo follow-up
    //   (pending) + báo cáo cuối nêu rõ
    //   'none' → hoàn thành sạch (side issues tầm thường)
    // =====
    // 2026-10-27 (rà soát Task 27-a — BUG GĐ3 marker): cờ số nợ VỪA GHI ở nhánh
    // else dưới (complete + không debt cycle được → ghi Todo follow-up). Trước
    // đây marker GĐ3 chỉ nhìn debtDecision==='record' → nhánh 'continue' mà hết
    // lượt/budget (hoặc STAGNANT GUARD ép ghi nợ) bị phán sai "hoàn thành sạch,
    // nợ tồn đọng 0" dù nợ vừa tạo. Khai báo NGOÀI khối if để GĐ3 marker đọc được.
    let justRecordedFollowUps = 0
    if (verdict.complete && verdict.sideIssues.length > 0 && verdict.debtDecision !== 'none') {
      // TASK 21 — RENEW-FOR-DEBT: debt cycle cần chạy mà trần chu kỳ hiện hành
      // đã chặn → tái lập cửa sổ chu kỳ mới (nếu còn lượt + budget) thay vì để
      // rơi vào nhánh ghi nợ + kết thúc.
      if (
        verdict.debtDecision === 'continue' &&
        EFFECTIVE_MAX_CYCLES !== 0 &&
        cycle >= effectiveMaxCycles &&
        cycleRenewals < MAX_CYCLE_RENEWALS &&
        debtCyclesRun < MAX_DEBT_CYCLES &&
        cycleNewSuccessSignatures > 0 && // 2026-10: chu kỳ này PHẢI có hành động thành công MỚI (không phải lặp lại việc cũ)
        verdictStagnation < 3 && // 2026-10: evaluator không được bế tắc (cùng verdict lặp lại)
        timeLeft() > 0 &&
        tokenLeft() > REPORT_RESERVE_TOKENS + 8_000 &&
        !isCancelled()
      ) {
        cycleRenewals++
        effectiveMaxCycles += EFFECTIVE_MAX_CYCLES
        recordAgentThought(agentSessionId, `🔁 TÁI LẬP CỬA SỔ CHU KỲ (lần ${cycleRenewals}/${MAX_CYCLE_RENEWALS}): trọng tài muốn chạy debt cycle cho ${verdict.sideIssues.length} lỗi phát sinh nhưng hết trần chu kỳ → mở thêm ${EFFECTIVE_MAX_CYCLES} chu kỳ để giải quyết tiếp thay vì kết thúc`, totalIterations)
        evidence.push({ cycle, kind: 'directive', text: `TÁI LẬP cửa sổ chu kỳ (lần ${cycleRenewals}) cho debt cycle — ${verdict.sideIssues.length} side issue(s) chưa xử lý` })
        console.log(`[GoalLoop] ${agentName} RENEWAL (debt): chu kỳ ${cycle} chạm trần → mở thêm ${EFFECTIVE_MAX_CYCLES} chu kỳ (renewal ${cycleRenewals}/${MAX_CYCLE_RENEWALS}, effectiveMax=${effectiveMaxCycles})`)
      }
      const canDebtCycle =
        verdict.debtDecision === 'continue' &&
        debtCyclesRun < MAX_DEBT_CYCLES &&
        (EFFECTIVE_MAX_CYCLES === 0 || cycle < effectiveMaxCycles) &&
        timeLeft() > 0 &&
        tokenLeft() > REPORT_RESERVE_TOKENS + 8_000 &&
        !isCancelled() &&
        // 2026-10-27 (user directive phiên 4 — GĐ3 READINESS GATE): trọng tài
        // xác định lại nợ CHƯA THỂ xử lý ở chu kỳ kế (chờ phê duyệt / vendor /
        // điều kiện ngoài) → KHÔNG quay GĐ0 vô ích — ghi follow-up kèm điều kiện.
        verdict.debtReadiness !== 'blocked'
      // 2026-10-27 — STAGNANT DEBT GUARD: fingerprint side issues (sort + normalize
      // lowercase + cắt 60 ký tự/issue). Debt cycle mới mà tập issue GIỐNG HỆT đợt
      // trước → stagnation++. 3 đợt liên tiếp không tiến triển → ép GHI NỢ (record)
      // thay vì tiếp tục debt — lỗi đang lặp là loại ngoài quyền agent (guard chặn /
      // chờ phê duyệt) hoặc evaluator bế tắc, chạy tiếp chỉ đốt token vô ích.
      const debtFingerprint = verdict.sideIssues.map(s => s.toLowerCase().trim().slice(0, 60)).sort().join('||')
      if (debtFingerprint === lastDebtFingerprint) stagnantDebtCount++
      else { stagnantDebtCount = 1; lastDebtFingerprint = debtFingerprint }
      if (canDebtCycle && stagnantDebtCount >= 3) {
        recordAgentThought(agentSessionId, `🛑 STAGNANT DEBT GUARD: ${stagnantDebtCount} đợt debt LIÊN TIẾP với cùng tập ${verdict.sideIssues.length} lỗi (không tiến triển) → ép GHI NỢ Todo follow-up thay vì debt cycle ${debtCyclesRun + 1} (lỗi ngoài quyền agent hoặc evaluator bế tắc — không đốt thêm chu kỳ)`, totalIterations)
        console.log(`[GoalLoop] ${agentName} STAGNANT DEBT: ${stagnantDebtCount} đợt liên tiếp cùng fingerprint (${debtFingerprint.slice(0, 80)}...) → ép record thay vì debt cycle`)
      }
      if (canDebtCycle && stagnantDebtCount < 3) {
        debtCyclesRun++
        debtMode = true
        // REVIEW 9-fix (2026-08-30) #9 — checkpoint lại các side issues gốc: nếu
        // debt cycle thất bại/chạy dở, chúng vẫn được ghi nợ ở cuối run.
        pendingDebtIssues = verdict.sideIssues
        recordAgentThought(agentSessionId, `⚖️ Trọng tài: mục tiêu ĐẠT nhưng ${verdict.sideIssues.length} lỗi phát sinh còn tồn tại → TÁI KHỞI ĐỘNG chu kỳ debt (đợt ${debtCyclesRun}/${MAX_DEBT_CYCLES}, chu kỳ ${cycle + 1}) để xử lý: ${verdict.sideIssues.slice(0, 2).join('; ').slice(0, 200)}`, totalIterations)
        console.log(`[GoalLoop] ${agentName} DEBT CYCLE (đợt ${debtCyclesRun}/${MAX_DEBT_CYCLES}): complete=true nhưng trọng tài quyết định 'continue' — chu kỳ ${cycle + 1} xử lý ${verdict.sideIssues.length} side issue(s)`)
        evidence.push({ cycle, kind: 'directive', text: `Trọng tài: hoàn thành + debtDecision='continue' → chu kỳ debt (đợt ${debtCyclesRun}) cho ${verdict.sideIssues.length} lỗi phát sinh` })
        // KHÔNG break — để outerLoop chạy chu kỳ debt (directive debt đã sẵn sàng)
      } else {
        // Hoàn thành + GHI NỢ kỹ thuật: mỗi side issue 1 Todo follow-up —
        // không chặn completion nhưng việc phát sinh KHÔNG bị lãng quên.
        unresolvedDebt = verdict.sideIssues
        justRecordedFollowUps = verdict.sideIssues.length
        if (agentSessionId) {
          try {
            const { db } = await import('@/lib/db')
            for (const issue of verdict.sideIssues) {
              // 2026-10-27 (phiên 4): nợ bị BLOCKED (chưa thể xử lý chu kỳ kế) →
              // đính kèm ĐIỀU KIỆN CẦN vào nội dung follow-up để run nhặt nợ
              // (buildPendingDebtBlock) và người quản trị thấy ngay còn thiếu gì.
              const condSuffix = verdict.debtReadiness === 'blocked' && verdict.debtBlockedReason
                ? ` — điều kiện xử lý: ${verdict.debtBlockedReason.slice(0, 120)}`
                : ''
              await db.todo.create({
                data: {
                  sessionId: agentSessionId,
                  content: `🔁 Follow-up (nợ kỹ thuật từ run ${runId?.slice(0, 18) ?? '-'}): ${issue}${condSuffix}`.slice(0, 480),
                  status: 'pending',
                  priority: 'medium',
                  ...(runId ? { runId } : {}),
                  taskMetaJson: JSON.stringify({ source: 'arbiter_side_issue', cycle, debtDecision: verdict.debtDecision, debtReadiness: verdict.debtReadiness }),
                },
              }).catch(() => { /* fail-open từng item */ })
            }
            const whyNoDebt = verdict.debtReadiness === 'blocked'
              ? `NỢ CHƯA THỂ xử lý ở chu kỳ kế — trọng tài xác định còn thiếu điều kiện: ${verdict.debtBlockedReason.slice(0, 160) || '(không nêu lý do)'} → ghi follow-up kèm điều kiện, KHÔNG quay GĐ0 vô ích`
              : verdict.debtDecision === 'continue'
              ? debtCyclesRun >= MAX_DEBT_CYCLES
                ? `hết lượt debt cycle (${debtCyclesRun}/${MAX_DEBT_CYCLES})`
                : 'hết budget/chu kỳ nên không chạy debt cycle'
              : 'issue ngoài khả năng xử lý của agent (trọng tài phân loại)'
            recordAgentThought(agentSessionId, `📋 Trọng tài: hoàn thành + ${verdict.sideIssues.length} lỗi phát sinh được GHI NỢ kỹ thuật (Todo follow-up) — ${whyNoDebt}`, totalIterations)
          } catch { /* fail-open — ghi nợ không được làm hỏng completion */ }
        }
      }
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
        ? `⚖️ Đánh giá chu kỳ ${cycle}: HOÀN THÀNH (tin cậy ${Math.round(verdict.confidence * 100)}%${verdict.verified ? ', đã có bằng chứng kiểm định' : ''})${verdict.sideIssues.length > 0 ? ` — kèm ${verdict.sideIssues.length} lỗi phát sinh (${verdict.debtDecision === 'none' ? 'bỏ qua' : verdict.debtDecision === 'record' ? 'ghi nợ kỹ thuật' : 'debt cycle'})` : ''}`
        : `⚖️ Đánh giá chu kỳ ${cycle}: CHƯA ĐẠT (tin cậy ${Math.round(verdict.confidence * 100)}%) — còn thiếu: ${verdict.missing.join('; ').slice(0, 200) || '(không liệt kê)'}`,
      totalIterations,
    )

    // 2026-10-27 (user directive — GĐ3 kiểm định QUYẾT ĐỊNH lặp lại GĐ0 hay
    // không): Thought Progress chốt rõ kết quả kiểm định của chu kỳ + quyết
    // định vòng tiếp. Nợ kỹ thuật tồn đọng → chu kỳ tiếp QUAY LẠI GĐ0 với
    // TOÀN BỘ nợ được ƯU TIÊN triển khai TRƯỚC, sau đó mới tới việc khác.
    {
      // 2026-10-27 (phiên 4) — GĐ3 readiness hiển thị trong quyết định chu kỳ tiếp:
      // trọng tài đã XÁC ĐỊNH LẠI nợ có thể xử lý ở chu kỳ kế chưa (ready/blocked).
      const readinessNote = verdict.sideIssues.length > 0
        ? verdict.debtReadiness === 'blocked'
          ? ` — nợ CHƯA THỂ xử lý ở chu kỳ kế (còn thiếu điều kiện: ${verdict.debtBlockedReason.slice(0, 140) || 'không nêu'})`
          : ' — nợ ĐÃ CÓ THỂ xử lý ở chu kỳ kế (đủ tool/đường tự phục vụ)'
        : ''
      const nextDecision = debtMode
        ? `QUAY LẠI GĐ0 ở chu kỳ ${cycle + 1} (CHU KỲ DEBT) — TOÀN BỘ ${verdict.sideIssues.length} nợ kỹ thuật ƯU TIÊN triển khai TRƯỚC, sau đó mới tới phần việc khác (trọng tài xác nhận nợ SẴN SÀNG xử lý)${readinessNote}`
        : verdict.complete
          ? justRecordedFollowUps > 0
            ? `KHÔNG chạy tiếp trong run này — ${justRecordedFollowUps} nợ kỹ thuật đã GHI Todo follow-up${readinessNote}, sẽ được ưu tiên xử lý ở RUN KẾ TIẾP của phiên (đầu run)`
            : 'KHÔNG lặp lại — hoàn thành sạch (không còn nợ kỹ thuật)'
          : `QUAY LẠI GĐ0 ở chu kỳ ${cycle + 1} — khắc phục phần thiếu: ${(verdict.missing[0] || verdict.rootCause || '').slice(0, 120)}`
      recordAgentThought(
        agentSessionId,
        `📍 Chu kỳ ${cycle} — GĐ3 KIỂM ĐỊNH & BÁO CÁO: trọng tài độc lập phán ${verdict.complete ? 'MỤC TIÊU ĐẠT' : 'CHƯA ĐẠT'} (verified=${verdict.verified ? 'có' : 'chưa'} · nợ kỹ thuật tồn đọng: ${debtMode ? verdict.sideIssues.length : justRecordedFollowUps} mục) → quyết định chu kỳ tiếp: ${nextDecision}`,
        totalIterations,
      )
    }

    // ===== TASK 21 (2026-10-21) — SHR CUỐI CHU KỲ: verify judgments + 📐 + nén CoT =====
    // (1) λ-VERIFY: đối chiếu pendingJudgments với bằng chứng tool THẬT của run
    //     (chống causal parrot — agent tự confirm không bằng chứng → TỪ CHỐI).
    // (2) 📐 BIÊN ĐỘ DỮ LIỆU: parse khối 📐 từ báo cáo → RunContext (render lại
    //     directive chu kỳ sau — Task 21-c).
    // (3) NÉN MẨU CoT: 2 câu REFLECT + cơ chế → mẩu 200-400 ký tự (MDL, không
    //     gọi model thêm), posterior = confidence trọng tài, chuỗi ≤3 thế hệ.
    // Toàn bộ fail-open — SHR không bao giờ làm hỏng loop.
    if (agentSessionId) {
      let bestMechanics: string | null = null
      try {
        const shr = await import('@/lib/structured-hypothesis')
        const cycleToolEvidence = evidence
          .filter(e => e.kind === 'tool')
          .map(e => ({ tool: e.tool ?? '', success: e.success !== false, text: e.text ?? '' }))
        const verifyRes = await shr.verifyPendingJudgments(agentSessionId, cycleToolEvidence, runId)
        if (verifyRes.applied.length > 0 || verifyRes.rejected.length > 0) {
          const promotedNote = verifyRes.promoted.length > 0 ? `, ${verifyRes.promoted.length} PROMOTE (posterior ≥0.80 — vào belief-state chu kỳ sau)` : ''
          const demotedNote = verifyRes.demoted.length > 0 ? `, ${verifyRes.demoted.length} demote` : ''
          recordAgentThought(agentSessionId, `🧬 SHR: ${verifyRes.applied.length} phán quyết được xác nhận bằng chứng (α/β cập nhật${promotedNote}${demotedNote})${verifyRes.rejected.length > 0 ? ` · ${verifyRes.rejected.length} BỊ TỪ CHỐI (không tìm bằng chứng khớp)` : ''}`, totalIterations)
          console.log(`[GoalLoop] ${agentName} SHR verify chu kỳ ${cycle}: applied=${verifyRes.applied.length} rejected=${verifyRes.rejected.length} promoted=${verifyRes.promoted.length} demoted=${verifyRes.demoted.length}`)
          bestMechanics = verifyRes.applied[0]?.claim ?? null
        }
        // (2) 📐 parse + persist RunContext — gate looksLikeDataScope (chống
        // nhặt nhầm đoạn text nhắc TỚI 📐: parse ra null → upsert preserve
        // giá trị tốt đã stash trước đó, không đè bằng rác)
        const dataScopeRaw = shr.parseDataScopeBlock(lastContent)
        const dataScope = shr.looksLikeDataScope(dataScopeRaw) ? dataScopeRaw : null
        const usedTools = [...new Set(evidence.filter(e => e.kind === 'tool').map(e => e.tool!))].slice(0, 8)
        const ctxKeywords = shr.computeContextSignature(directiveSpec.goal, usedTools)
        // (2b) UNCERTAINTY LEDGER — trích mục ❓ "còn chưa chắc" từ báo cáo →
        // merge aging với ledger chu kỳ trước (mục trùng giữ firstSeenCycle)
        // → persist. Chỉ chạy khi báo cáo đủ dài (báo cáo rỗng/LLM-error không
        // được phép XÓA ledger). Báo cáo KHÔNG còn mục ❓ = agent đã chắc hết
        // → ledger tự clean ("[]" — đúng semantics latest-state-wins như 📐).
        let uncertainJson: string | null = null
        if (runId && lastContent && lastContent.length > 80) {
          const prevCtx = await shr.getRunContext(runId)
          const newUncertain = shr.parseUncertainItems(lastContent)
          uncertainJson = shr.mergeUncertainLedger(prevCtx?.uncertainItems, newUncertain, cycle)
        }
        await shr.upsertRunContext({
          runId: runId ?? '',
          sessionId: agentSessionId,
          dataScope,
          goalDigest: directiveSpec.goal.slice(0, 400),
          contextKeywords: ctxKeywords,
          ...(uncertainJson !== null ? { uncertainItems: uncertainJson } : {}),
        })
        // (3) nén mẩu CoT từ báo cáo chu kỳ (posterior = confidence trọng tài)
        const cotRes = await shr.compressCycleToSample({
          sessionId: agentSessionId,
          agentName,
          report: lastContent,
          contextSig: ctxKeywords,
          posterior: verdict.confidence,
          parentSampleId: cotParentSampleId,
          bestMechanics,
        })
        if (cotRes.created) {
          console.log(`[GoalLoop] ${agentName} SHR: nén mẩu CoT chu kỳ ${cycle} (id ${cotRes.id?.slice(-6)})`)
        }
        cotParentSampleId = null // chu kỳ sau truy hồi lại (chuỗi nguồn gốc đúng)
      } catch (err) {
        console.warn(`[GoalLoop] SHR cuối chu kỳ ${cycle} fail-open: ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    // ===== TASK 48 (đánh giá Multi-step Reasoning Loop — gap fix) =====
    // NEEDS-INPUT STOP: trọng tài xác định mục tiêu bị chặn DUY NHẤT bởi
    // thông tin/ủy quyền/phê duyệt CHỈ người dùng cung cấp được (rule 16 —
    // agent đã hỏi trong lastContent). Trước đây không có stop reason cho
    // trường hợp này: loop cứ chạy tiếp chu kỳ với continuation directive
    // "khắc phục phần còn thiếu" — nhưng agent KHÔNG THỂ tự khắc phục (câu
    // trả lời nằm ngoài hệ thống) → đốt 2-3 chu kỳ + evaluator calls rồi mới
    // dừng ở max_cycles với câu hỏi bị chôn dưới wrapper "chưa hoàn thành".
    // Giờ: dừng NGAY sau chu kỳ đầu tiên có needsInput → lastContent (câu
    // hỏi của agent) được trả thẳng về user; user trả lời trong chat → run
    // mới bootstrap với câu trả lời trong history (context bootstrap đã có
    // sẵn). KHÔNG cần cancel/budget — đây là kết thúc CÓ MỤC ĐÍCH.
    if (!verdict.complete && verdict.needsInput) {
      stopReason = 'needs_input'
      evidence.push({ cycle, kind: 'directive', text: `NEEDS-INPUT: trọng tài xác định phần còn thiếu (${verdict.missing[0]?.slice(0, 120) || 'thông tin từ người dùng'}) CHỈ người dùng trả lời được → dừng vòng lặp, trả câu hỏi về user` })
      recordAgentThought(agentSessionId, `⏸️ Trọng tài: mục tiêu bị chặn bởi thông tin/ủy quyền CHỈ người dùng cung cấp được → TẠM DỪNG vòng lặp ở chu kỳ ${cycle} (không đốt thêm chu kỳ vô ích) — câu hỏi đã trả về user, chờ trả lời để tiếp tục`, totalIterations)
      console.log(`[GoalLoop] ${agentName} NEEDS-INPUT: chu kỳ ${cycle} — trọng tài xác định blocker ngoài hệ thống (chỉ user trả lời được) → dừng chờ input`)
      break outerLoop
    }

    // FIX 2026-09-14 #9 — debtMode=true nghĩa là trọng tài vừa chọn 'continue'
    // cho side issues: KHÔNG dừng ở đây — outerLoop chạy tiếp chu kỳ debt.
    if (verdict.complete && !debtMode) {
      // REVIEW 9-fix (2026-08-30) #9 — hoàn thành nghĩa là các side issues đã
      // được debt cycle (hoặc chu kỳ kế) xử lý xong → không còn nợ treo.
      pendingDebtIssues = []
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
          // TASK 43 — event bus: auto-escalate đã hỏi Omega (đường manual qua
          // tool escalate_problem phát ở processToolResult)
          emitAgentEvent('escalation', {
            agentName,
            sessionId: agentSessionId,
            runId,
            data: { cycle, kind: 'auto-escalate', severity: 'high', tokens: consult.tokensUsed },
          })
          evidence.push({ cycle, kind: 'directive', text: `AUTO-ESCALATE → Omega orchestrator tư vấn giải pháp (kèm cho chu kỳ ${cycle + 1})` })
          recordAgentThought(agentSessionId, `🧠 AUTO-ESCALATE: chu kỳ ${cycle} chưa kiểm định được → đã hỏi Omega orchestrator (${consult.tokensUsed} tokens) — tư vấn sẽ dẫn đường chu kỳ ${cycle + 1}`, totalIterations)
          console.log(`[GoalLoop] ${agentName} auto-escalate (unverified cycle ${cycle}) → Omega consult OK (${consult.tokensUsed} tokens)`)

          // ===== FIX 2026-09-14 #3 — OMEGA ADVISORY AUTO-APPLY =====
          // Advisory có dispatchAgent → THỰC THI NGAY (dispatch sub-agent xử lý
          // giúp) thay vì chỉ inject gợi ý JSON để agent tự gọi tool vòng sau.
          // Báo cáo sub-agent gắn kèm advisory — chu kỳ kế vừa có hướng vừa có
          // kết quả thực tế. Budget-guard chặt hơn (reserve + 15k) vì sub-agent
          // tiêu token thật. Fail-open: auto-dispatch lỗi → giữ advisory thuần.
          const suggested = consult.advisory?.dispatchAgent?.trim()
          if (suggested && tokenLeft() > REPORT_RESERVE_TOKENS + 15_000 && !isCancelled()) {
            try {
              const { dispatchAgentByOmega } = await import('@/lib/omega-orchestrator')
              // IMP-2 (G — điều tra Task G): template rescue mở-ended ("Xử lý giúp
              // agent đang bế tắc") + SUBAGENT_MAX_ITERATIONS 12 → mọi delegation
              // rescue thật lớn đều chết vì iteration_limit (52% runs) → arbitor
              // fail → vòng lặp reinforcement chống-delegate. Giỏ task scope chẩn
              // đoán BOUNDED ≤5 bước (đọc trạng thái → 2-3 giả thuyết → đề xuất
              // hướng đi) — làm được trọn vẹn trong tầm vòng. (Cập nhật 2026-10:
              // user directive bỏ trần — SUBAGENT_MAX_ITERATIONS=0, vòng sub-agent
              // giờ ∞; scope chẩn đoán BOUNDED vẫn giữ vì nhiệm vụ này là CHẨN
              // ĐOÁN, không phải triển khai.)
              const dispatched = await dispatchAgentByOmega({
                agent: suggested,
                task: `Chẩn đoán nguyên nhân bế tắc của agent "${agentName}" (chu kỳ ${cycle}, verified=false) trong ≤5 bước: đọc trạng thái hiện tại, liệt kê 2-3 giả thuyết nguyên nhân, đề xuất hướng đi cụ thể.\nVấn đề: ${(verdict.rootCause || userMessage).slice(0, 500)}\nKhuyến nghị của Omega: ${consult.advisory?.recommendation?.slice(0, 500) || '(theo phân tích của bạn)'}`,
                context: `Mục tiêu gốc: ${userMessage.slice(0, 400)}`,
                duration: 'task',
                parentAgentName: agentName,
                sessionId: agentSessionId,
                // REVIEW 9-fix (2026-08-30) #5 — auto-escalate delegation gắn
                // parentRunId (đủ đường query theo run cha)
                parentRunId: runId,
                onTokens: (t) => { tokensUsed += t; subagentTokens += t },
              })
              // REVIEW 9-fix (2026-08-30) — đếm delegation 1 LẦN/lần auto-apply
              // (trước đây delegations++ nằm trong onTokens → phình theo số
              // LLM call của sub-agent)
              delegations++
              if (dispatched.report) {
                omegaAdvisory += `\n\n🚀 AUTO-APPLY — Omega đã điều ${dispatched.agent} xử lý giúp bạn (kết quả ${dispatched.success ? 'ĐẠT' : 'CHƯA ĐẠT'}${dispatched.evaluation ? `, trọng tài độc lập: ${dispatched.evaluation.pass ? 'pass' : 'chưa pass'}` : ''}):\n${dispatched.report.slice(0, 2000)}`
                evidence.push({ cycle, kind: 'directive', text: `AUTO-APPLY: điều ${dispatched.agent} theo advisory Omega (${dispatched.tokensUsed ?? 0} tokens sub-agent)` })
                recordAgentThought(agentSessionId, `🚀 AUTO-APPLY advisory: Omega điều ${dispatched.agent} xử lý giúp — báo cáo kèm tư vấn chu kỳ ${cycle + 1}`, totalIterations)
              }
            } catch { /* fail-open — advisory thuần vẫn inject */ }
          }
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
          // 2026-09-30 (round-10): ngưỡng grace env-tunable GOAL_LOOP_NO_PROGRESS_GRACE
          // (mặc định 2) — nhiệm vụ audit dài cần cửa sổ rộng hơn khi đang khai thác
          // tác vụ lớn; vẫn bounded để chống chạy vô hạn thật.
          if (noProgressCount >= NO_PROGRESS_GRACE) {
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
    //
    // 2026-09-30 (round-10 audit root-cause FIX): "thành công" giờ bao gồm CẢ
    // thất bại có CHỮ KÝ MỚI (tool + text kết quả khác nhau) trong chu kỳ —
    // mission r10 chết vì chu kỳ 10 toàn tool call exit≠0 (chạy checker thiếu
    // file → MODULE_NOT_FOUND là THÔNG TIN, không phải bế tắc) → bị tính stall
    // sai. Chu kỳ chỉ stall khi: 0 call thành công VÀ mọi thất bại lặp đúng
    // chữ ký đã gặp trong chu kỳ (không học gì mới). Ngưỡng số chu kỳ stall:
    // env GOAL_LOOP_STALL_CYCLES (mặc định 3).
    const cycleToolEvents = evidence.filter(e => e.cycle === cycle && e.kind === 'tool')
    const cycleSuccessfulTools = cycleToolEvents.filter(e => e.success === true).length
    const cycleFailureSigs = new Set(
      cycleToolEvents.filter(e => e.success !== true).map(e => `${e.tool}|${(e.text || '').slice(0, 120)}`)
    )
    // Chữ ký thất bại chỉ tính "mới" nếu KHÔNG lặp đúng nguyên văn chữ ký của
    // chu kỳ trước — thất bại lặp y hệt qua nhiều chu kỳ vẫn là bế tắc thật.
    const newFailureSigs = [...cycleFailureSigs].filter(s => !prevCycleFailureSigs.has(s))
    const cycleProductiveSignals = cycleSuccessfulTools + (newFailureSigs.length > 0 ? 1 : 0)
    prevCycleFailureSigs = cycleFailureSigs
    if (cycleProductiveSignals > 0) {
      if (stallCycles > 0) stallCycles = 0
    } else {
      stallCycles++
      console.warn(`[GoalLoop] ${agentName} STALL: chu kỳ ${cycle} không có tín hiệu tiến triển nào — 0 call thành công + 0 chữ ký thất bại mới (${stallCycles}/${STALL_CYCLE_LIMIT} chu kỳ liên tiếp, ngưỡng GOAL_LOOP_STALL_CYCLES)`)
      recordAgentThought(agentSessionId, `⚠️ Chu kỳ ${cycle} kết thúc mà không có tín hiệu tiến triển nào (0 tool call thành công + 0 thất bại mới) — tín hiệu bế tắc ${stallCycles}/${STALL_CYCLE_LIMIT} (quá ${STALL_CYCLE_LIMIT} chu kỳ liên tiếp loop sẽ dừng để tránh chạy vô hạn)`, totalIterations)
      if (stallCycles >= STALL_CYCLE_LIMIT) {
        stopReason = 'no_progress'
        break
      }
    }

    // Budget check sau evaluation (đã tốn thêm 1 call)
    if (timeLeft() <= 0) { stopReason = 'time_budget'; break }
    if (tokenLeft() <= REPORT_RESERVE_TOKENS) { stopReason = 'token_budget'; break }

    // ===== TASK 21 — CYCLE RENEWAL: hết trần chu kỳ nhưng việc CHƯA xong triệt để =====
    // User report 2026-09-30: "công việc chưa hoàn thành triệt để thì nên tái
    // lập thêm chu kỳ để tìm cách giải quyết tiếp thay vì vội vàng quyết định
    // kết thúc". Đến được điểm này nghĩa là: chu kỳ vừa rồi CÓ tiến triển (no-
    // progress + stall-brake đã break ở trên nếu bế tắc) + còn budget + chưa
    // cancel. Nếu trần chu kỳ (effectiveMaxCycles) đã chạm mà verdict chưa
    // complete hoặc còn lỗi phát sinh liên quan chưa xử lý → TÁI LẬP thêm 1
    // cửa sổ MAX_CYCLES chu kỳ (bounded bởi MAX_CYCLE_RENEWALS).
    //
    // 2026-10 STAGNATION GATE (user report "lặp chu kỳ không tiến triển"): comment
    // cũ claim "chu kỳ vừa rồi CÓ tiến triển" nhưng code KHÔNG kiểm — E2E proc2
    // lộ ra: evaluator tự kết luận "agent is looping" nhưng renewal vẫn mở
    // 12→24. Giờ renewal yêu cầu THẬT SỰ: (a) chu kỳ có ≥1 hành động thành công
    // MỚI (signature chưa từng chạy trong run), (b) evaluator KHÔNG bế tắc
    // (không ra cùng verdict lặp lại ≥3 chu kỳ liên tiếp). Không đạt → dừng ở
    // trần với final report trung thực (Opus/user có thể dispatch run mới).
    if (
      EFFECTIVE_MAX_CYCLES !== 0 &&
      cycle >= effectiveMaxCycles &&
      cycleRenewals < MAX_CYCLE_RENEWALS &&
      (!verdict.complete || (verdict.sideIssues.length > 0 && verdict.debtDecision !== 'none')) &&
      cycleNewSuccessSignatures > 0 &&
      verdictStagnation < 3 &&
      timeLeft() > 0 &&
      tokenLeft() > REPORT_RESERVE_TOKENS + 8_000 &&
      !isCancelled()
    ) {
      const oldCap = effectiveMaxCycles
      cycleRenewals++
      effectiveMaxCycles += EFFECTIVE_MAX_CYCLES
      const why = !verdict.complete
        ? `mục tiêu CHƯA hoàn thành triệt để (còn thiếu: ${verdict.missing[0]?.slice(0, 120) ?? '(trọng tài không liệt kê)'})`
        : `còn ${verdict.sideIssues.length} lỗi phát sinh liên quan chưa xử lý`
      recordAgentThought(agentSessionId, `🔁 TÁI LẬP CỬA SỔ CHU KỲ (lần ${cycleRenewals}/${MAX_CYCLE_RENEWALS}): hết trần ${fmtCap(oldCap)} chu kỳ nhưng ${why} → mở thêm ${EFFECTIVE_MAX_CYCLES} chu kỳ để giải quyết tiếp (KHÔNG kết thúc vội)`, totalIterations)
      evidence.push({ cycle, kind: 'directive', text: `TÁI LẬP cửa sổ chu kỳ lần ${cycleRenewals}/${MAX_CYCLE_RENEWALS}: ${why}` })
      console.log(`[GoalLoop] ${agentName} RENEWAL: chu kỳ ${cycle}/${fmtCap(oldCap)} hết trần nhưng ${why} → mở thêm ${EFFECTIVE_MAX_CYCLES} chu kỳ (renewal ${cycleRenewals}/${MAX_CYCLE_RENEWALS}, effectiveMax=${effectiveMaxCycles})`)
    } else if (
      EFFECTIVE_MAX_CYCLES !== 0 &&
      cycle >= effectiveMaxCycles &&
      (!verdict.complete || (verdict.sideIssues.length > 0 && verdict.debtDecision !== 'none')) &&
      (cycleNewSuccessSignatures === 0 || verdictStagnation >= 3)
    ) {
      // 2026-10 — ghi rõ lý do KHÔNG tái lập (bế tắc) để thought process + log
      // minh bạch cho user/Opus thấy vì sao run dừng ở trần.
      const why = verdictStagnation >= 3
        ? `evaluator lặp cùng verdict ${verdictStagnation} chu kỳ liên tiếp (bế tắc)`
        : 'chu kỳ vừa rồi không có hành động thành công MỚI nào (chỉ lặp lại việc cũ)'
      recordAgentThought(agentSessionId, `🛑 KHÔNG tái lập cửa sổ chu kỳ: ${why} — dừng ở trần ${fmtCap(effectiveMaxCycles)} chu kỳ, tổng kết trung thực để Opus/user quyết định bước tiếp`, totalIterations)
      evidence.push({ cycle, kind: 'directive', text: `KHÔNG tái lập chu kỳ: ${why}` })
      console.log(`[GoalLoop] ${agentName} RENEWAL-BLOCKED: ${why} — dừng ở trần ${effectiveMaxCycles} chu kỳ`)
    }

    // CI-5 (Task 14-b) — CHECKPOINT + HEARTBEAT CUỐI MỖI CHU KỲ: ranh giới quan
    // trọng nhất (cyclesDone đã tăng + verdict chu kỳ đã có + escalate/stall
    // brake đã xong) — trước khi chu kỳ kế tiếp bắt đầu. Các đường break sớm
    // (complete / budget / no_progress / cancel) không qua điểm này nhưng đều
    // hội tụ về checkpoint-final ngay trước return của runGoalDrivenLoop.
    fireCheckpoint()
    fireSignal('cycle')

    // Chu kỳ kế tiếp: evaluator đã chẩn đoán + kế hoạch → continuation directive
  }

  // REVIEW 9-fix (2026-08-30) #9 — DEBT CYCLE THẤT BẠI: trọng tài từng quyết
  // 'continue' (1 chu kỳ debt xử lý side issues) nhưng run kết thúc MÀ KHÔNG
  // complete (debt cycle chưa xong / hết budget-chu kỳ / stall...). Các lỗi
  // gốc KHÔNG được phép "chìm": ghi Todo follow-up (như nhánh 'record') để
  // người dùng quyết định xử lý lúc nào — fail-open từng item.
  if (pendingDebtIssues.length > 0 && stopReason !== 'complete') {
    unresolvedDebt = unresolvedDebt.length > 0
      ? [...unresolvedDebt, ...pendingDebtIssues.filter(d => !unresolvedDebt.includes(d))]
      : pendingDebtIssues
    if (agentSessionId) {
      try {
        const { db } = await import('@/lib/db')
        for (const issue of pendingDebtIssues) {
          await db.todo.create({
            data: {
              sessionId: agentSessionId,
              content: `🔁 Follow-up (debt cycle chưa xử lý xong — run ${runId?.slice(0, 18) ?? '-'} dừng vì ${stopReason}): ${issue}`.slice(0, 480),
              status: 'pending',
              priority: 'medium',
              ...(runId ? { runId } : {}),
              taskMetaJson: JSON.stringify({ source: 'arbiter_side_issue', cycle: cyclesAttempted, debtDecision: 'continue' }),
            },
          }).catch(() => { /* fail-open từng item */ })
        }
        recordAgentThought(agentSessionId, `📋 Debt cycle chưa xử lý xong (${stopReason}) — ${pendingDebtIssues.length} lỗi phát sinh được GHI NỢ kỹ thuật (Todo follow-up)`, totalIterations)
      } catch { /* fail-open — ghi nợ không được làm hỏng response cuối */ }
    }
  }

  // ================== FINAL REPORT ==================

  let content = ''
  /** [B] Final report tổng hợp được dùng thay lastContent dở? */
  let usedFinalReport = false
  if (stopReason === 'cancelled') {
    // FIX 2026-09-29 (quan sát vận hành thật — mission 6.6 giờ bị Dừng giữa
    // chừng trả về đúng 1 dòng "⏹ Đã dừng...", toàn bộ partial work 44 chu
    // kỳ/1274 tool calls bị VỨT): cancel path phải mirror error path (giữ
    // partial work — xem nhánh dưới "không vứt partial work"). User bấm Dừng
    // vẫn muốn biết agent đã làm được gì tới lúc đó.
    content = lastContent
      ? `⏹ Đã dừng tác vụ theo yêu cầu của bạn. Phần dưới là báo cáo tiến độ mới nhất trước khi dừng:\n\n---\n\n${lastContent}`
      : '⏹ Đã dừng tác vụ theo yêu cầu của bạn.'
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
    // TASK 48 — NGOẠI LỆ needs_input: KHÔNG wrap-up — lastContent chính là CÂU
    // HỎI agent hỏi user (wrap-up tổng hợp sẽ làm loãng/chôn câu hỏi).
    // ROUND-4 (2026-09-29, quan sát vòng 4): NGOẠI LỆ đường complete — khi
    // evaluator chốt đạt dựa trên BẰNG CHỨNG (artifact/validator pass) ngay
    // sau chu kỳ bị cắt giữa chừng (iteration_limit), agent không kịp viết
    // thông điệp kết luận → lastContent là thinking THÔ. Bằng chứng: job FIX
    // t4jw6m8s kết thúc complete=true/verified=true nhưng result.content là
    // mảnh dở chứa raw "tool_call: shell(...)" + "Tôi sẽ không kết luận cho
    // tới khi lệnh trên trả về" — user nhận thinking thay vì báo cáo. Heuristic
    // phát hiện: lastContent chứa marker tool_call raw chưa parse.
    const lastContentIsRawMidWork = !!lastContent && /\btool_call:\s*[a-z_]+\s*\(/i.test(lastContent)
    if ((stopReason !== 'complete' && stopReason !== 'needs_input' && lastContent)
        || (stopReason === 'complete' && lastContentIsRawMidWork)) {
      const wrapUp = await generateFinalReport({
        goal: directiveSpec.acceptance.length > 0
          ? `${directiveSpec.goal}\n\nTIÊU CHÍ NGHIỆM THU:\n${directiveSpec.acceptance.map(a => `- [ ] ${a}`).join('\n')}`
          : directiveSpec.goal,
        lastContent,
        evidence,
        lastVerdict,
        stopReason,
        cyclesAttempted,
        maxCycles: effectiveMaxCycles,
        debtIssues: unresolvedDebt.length > 0 ? unresolvedDebt : undefined,
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
        max_cycles: `đã hết ${fmtCap(effectiveMaxCycles)} chu kỳ làm việc${cycleRenewals > 0 ? ` (đã tái lập ${cycleRenewals} cửa sổ chu kỳ)` : ''}`,
        time_budget: `hết budget thời gian (${TIME_BUDGET_MS === 0 ? '∞' : `${Math.round(TIME_BUDGET_MS / 60000)} phút`})${cyclesAttempted > cyclesDone ? ' — đang dở giữa chu kỳ ' + cyclesAttempted : ''}`,
        token_budget: `hết budget token (${TOKEN_BUDGET === 0 ? '∞' : TOKEN_BUDGET} — có thể tăng qua env GOAL_LOOP_TOKEN_BUDGET, hoặc đặt GOAL_LOOP_TOKEN_BUDGET=0 để chạy KHÔNG giới hạn)`,
        no_progress: 'phát hiện bế tắc không tiến triển (lặp lại hành động cũ theo fingerprint, hoặc 3 chu kỳ liên tiếp không có tool call thành công nào — stall brake CI-1)',
        error: 'lỗi LLM',
        // TASK 48 — gap fix: chờ thông tin/ủy quyền CHỈ user cung cấp được
        needs_input: 'trọng tài xác định phần còn thiếu nằm NGOÀI hệ thống — cần thông tin/ủy quyền/phê duyệt của BẠN (người dùng) để tiếp tục',
      }
      if (usedFinalReport) {
        // Báo cáo tổng hợp đã có "còn thiếu" + "đề xuất" — chỉ append dòng trạng thái
        content += `\n\n---\n⚠️ **Vòng lặp mục tiêu dừng sau ${cyclesAttempted}/${fmtCap(effectiveMaxCycles)} chu kỳ** — ${reasonText[stopReason] || stopReason}. Bạn có thể yêu cầu tiếp tục để tôi khắc phục phần còn thiếu.`
      } else {
        const missing = lastVerdict?.missing?.length ? lastVerdict.missing.map(m => `- ${m}`).join('\n') : '(chưa đánh giá được chi tiết — xem tiến trình ở trên)'
        const rootCause = lastVerdict?.rootCause ? `\n🔍 **Vấn đề xác định:** ${lastVerdict.rootCause}` : ''
        if (stopReason === 'needs_input') {
          // TASK 48 — needs_input: câu hỏi của agent (lastContent) là phần
          // chính — chỉ append dòng trạng thái ngắn + câu còn thiếu (thông tin
          // user cần trả lời), KHÔNG wrapper "chưa hoàn thành trọn vẹn".
          content += `\n\n---\n⏸️ **Tạm dừng chờ bạn** (${reasonText.needs_input}).\n📌 **Cần từ bạn:**\n${missing}\n\n→ Hãy trả lời câu hỏi phía trên — tôi sẽ tiếp tục ngay.`
        } else {
          content += `\n\n---\n⚠️ **Vòng lặp mục tiêu dừng sau ${cyclesAttempted}/${fmtCap(effectiveMaxCycles)} chu kỳ — chưa hoàn thành trọn vẹn** (${reasonText[stopReason] || stopReason}).\n❌ **Còn thiếu:**\n${missing}${rootCause}\n\nBạn có thể yêu cầu tiếp tục để tôi khắc phục phần còn thiếu.`
        }
      }
    }
  }

  // FIX 2026-09-14 #9 — hoàn thành + nợ kỹ thuật: KHÔNG để lỗi phát sinh "chìm"
  // — báo cáo cuối nêu đích danh + đã ghi Todo follow-up cho người dùng.
  // REVIEW 9-fix (2026-08-30): chạy cho CẢ trường hợp debt cycle thất bại
  // (stopReason ≠ complete nhưng vẫn còn nợ kỹ thuật chưa xử lý).
  if (unresolvedDebt.length > 0) {
    const debtNote = stopReason === 'complete'
      ? 'trọng tài quyết định hoàn thành + ghi nhận, KHÔNG chạy thêm chu kỳ'
      : `debt cycle chưa xử lý xong — vòng lặp dừng vì ${stopReason}`
    content += `\n\n---\n📋 **NỢ KỸ THUẬT (${unresolvedDebt.length} lỗi phát sinh trong quá trình xử lý — ${debtNote}):**\n${unresolvedDebt.map(d => `- ${d}`).join('\n')}\n\n→ Đã tạo Todo follow-up tương ứng — bạn có thể yêu cầu xử lý các mục này bất cứ lúc nào.`
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
        goal: directiveSpec.goal !== userMessage ? `${directiveSpec.goal} (chỉ đạo Opus)` : userMessage,
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
      // IMP-2 (H G6 — audit Task H "miscategorization"): run KHÔNG hoàn thành
      // (no_progress/max_cycles/time_budget/token_budget/needs_input) trước đây
      // rơi nhánh else ghi status='completed' → metrics đếm run bế tắc/hết
      // budget là "thành công". Giá trị mới 'incomplete'; cancelled + error giữ
      // giá trị riêng như cũ ('cancelled'/'failed').
      const runStatus = runComplete
        ? 'completed'
        : stopReason === 'error'
          ? 'failed'
          : stopReason === 'cancelled'
            ? 'cancelled'
            : 'incomplete'
      const toolFailures = evidence.filter(e => e.kind === 'tool' && e.success === false).length
      const endCompletedAt = new Date()
      void (async () => {
        const updated = await updateLatestAgentRunRecord(
          agentSessionId,
          {
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
          },
          // FIX 2026-09-14 #5 — target ĐÚNG row theo runId (fallback latest bên trong)
          runId,
        )
        if (updated === 0) {
          // Row 'running' lúc start insert thất bại (DB lỗi tạm thời) → insert
          // full row lúc end — vẫn đảm bảo 1 run = 1 row AgentRunRecord
          await insertAgentRunRecord({
            sessionId: agentSessionId,
            runId,
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
      explorationLessonIds,
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
