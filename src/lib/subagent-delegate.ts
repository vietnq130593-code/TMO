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
import { AsyncLocalStorage } from 'node:async_hooks'
import { executeTool, buildCompactToolSchemasSection, getToolDefinitions } from '@/lib/code-team/tool-executor'
// ROUND-27 FIX V1 — envelope JSON hợp lệ cho tool message của sub-agent (dùng
// chung với goal-loop + workflow-engine; context-compression không import lại
// module này → không circular).
import { capAssistantContentForTranscript, truncateToolMessageJson } from '@/lib/context-compression'
import type { LLMTool } from '@/lib/llm'
import { parseToolCallsFromOutput, detectBrokenToolCallHint, tryParseLooseJson } from '@/lib/tool-calls'
import { resolveAgent } from '@/lib/code-team/agent-resolver'
import { isSessionCancelled, registerDelegationRun, endAgentRun, recordAgentThought } from '@/lib/agent-run-tracker'

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
/**
 * r60 (A1/C4 — từ quan sát mission r59): khi SUBAGENT_TIMEOUT_MS = 0 (vô hạn
 * theo user directive 2026-10), sub-agent "productive fixation" (ALISTA#1:
 * 27 vòng/56 calls/1.47M tokens cho tác vụ ĐẾM — xen kẽ nháp báo cáo + file_list
 * làm chữ ký mỗi vòng khác nhau → stall brake batch-signature mãi mới cắt)
 * không còn điểm dừng thời gian nào. User directive 2026-10-07 (phiên fix r60):
 * "token không quan tâm — công việc phải hiệu quả" → giữ iter/token = ∞ nhưng
 * bổ sung WALL-CLOCK hào phóng: trần thời gian dự phòng 15 phút MẶC ĐỊNH áp
 * dụng khi timeout = 0 (đủ cho task lớn — FORGE end-to-end ~10-12'; fixation
 * kiểu 45+ phút bị cắt). Env SUBAGENT_WALL_CLOCK_MS; 0 = TẮT (vô hạn thật).
 */
const SUBAGENT_WALL_CLOCK_MS = intEnv('SUBAGENT_WALL_CLOCK_MS', 15 * 60_000)
/** r60 (A1b) — PER-CALL REPEAT BRAKE: 1 tool call (tên + args nguyên văn) xuất
 * hiện ≥N lần trong TOÀN BỘ run (không cần liên tiếp) → wrap-up no_progress.
 * Bắt đúng "productive fixation": ALISTA#1 gọi file_list giống hệt nhau 21 lần
 * rải rác 27 vòng — batch-signature (chỉ bắt vòng GIỐNG HỆT liên tiếp) không bao
 * giờ khớp vì các call khác xen kẽ làm đổi chữ ký vòng. Mirror ngưỡng 8 của
 * signatureOverrun goal-loop. 0 = tắt. */
const SUBAGENT_STALL_CALL_REPEATS = intEnv('SUBAGENT_STALL_CALL_REPEATS', 8)
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
/** ROUND-54 FIX C — stall brake cho sub-agent: số vòng LIÊN TIẾP lặp tool-signature
 *  (cùng tên tool + cùng args nguyên văn) trước khi wrap-up conclude. Mặc định 3;
 *  0 = tắt brake (env SUBAGENT_STALL_SIG_REPEATS). Bằng chứng r54: SENTINEL
 *  lặp 62× todo_read cùng args (đọc nhầm scope session cha — Fix A) không phanh
 *  nào chặn được (main loop có fingerprint brake từ r46 nhưng sub-agent KHÔNG). */
const SUBAGENT_STALL_SIG_REPEATS = intEnv('SUBAGENT_STALL_SIG_REPEATS', 3)
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
  // USER DIRECTIVE 2026-10-09 — FORGE ĐÃ GỠ: FORGE là agent ĐỘC LẬP (không
  // thuộc team code) → KHÔNG resolve qua position của Code Team nữa mà qua
  // nhánh by-name DB-first của delegate_task (giống ALISTA/Linh Sickyx —
  // AgentProfile FORGE có tools JSON đầy đủ từ standalone seed). Vị trí 'FS'
  // cũng đã rời danh sách hợp lệ ở resolveDelegationTarget.
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

// ==================== r69 (BUG-010/014) — READ-ONLY DELEGATION CONTRACT ====================
// Quan sát r68 mission cmuznvkl…6b136k: SENTINEL được giao "KHẢO SÁT P0-1 …
// xác định mọi khoảng trống" (phạm vi ĐỌC + BÁO CÁO) nhưng tự SỬA mã bảo mật
// (+33 dòng exec-allowlist.ts) + tự thêm 3 regression test (+68 dòng) + chạy
// gate — KHÔNG có bước phê duyệt TL (BUG-010). Omega học nhanh, lần giao 2
// kèm ràng buộc "chỉ đọc và kiểm định; không sửa file" — nhưng ràng buộc chỉ
// là CÂU CHỮ trong lời giao (BUG-014, vi phạm doctrine "hardcode > prompt").
// Giờ: cờ readOnly (từ delegate_task args HOẶC auto-detect từ ý định trong
// lời giao) → strip TẤT CẢ tool có khả năng ghi khỏi whitelist — enforcement
// tầng TOOL, gọi sẽ bị từ chối kèm hướng dẫn. Sub-agent khảo sát vẫn có đầy
// đủ tool đọc + kiểm định (file_read/grep/file_list/run_tests/lint/type_check/
// run_gate/git_diff...).
export const SUBAGENT_WRITE_TOOLS = new Set([
  'file_write', 'file_edit', 'file_multi_edit', 'file_delete', 'mkdir',
  'shell', 'run_bg', 'gateway_write', 'gateway_edit', 'gateway_apply_patch',
  'git_commit', 'git_push', 'git_pull', 'git_clone', 'open_workspace',
  'manage_packages', 'create_custom_tool', 'delete_custom_tool',
  'cron', 'start_preview', 'stop_preview', 'knowledge_write',
])
/** Auto-detect ý định chỉ-đọc trong lời giao (bằng chứng evt70 r68: "chỉ đọc
 * và kiểm định; không sửa file") — CỜ mới là cơ chế, câu chữ chỉ là tín hiệu
 * bật cờ (enforcement vẫn ở whitelist tầng tool). CHỈ dùng TÍN HIỆU MẠNH
 * (ràng buộc tường minh) — không đoán nhiệm vụ "khảo sát" là chỉ-đọc (BUG-010
 * gốc không có ràng buộc → TL phải chủ động truyền cờ; tránh chặn nhầm task
 * khảo sát+xén ghép sửa). */
export const READ_ONLY_INTENT_RE = /(chỉ\s+đọc|read[- ]?only|không\s+sửa\s+(file|mã|code|nguồn)|no\s+(file\s+)?(modif|edit|write))/i
/** Ý định SỬA — có mặt (sau khi bỏ cụm ràng buộc chỉ-đọc) → KHÔNG auto-bật
 * readOnly (task hỗn hợp khảo sát + sửa là hợp lệ — cờ readOnly khi đó phải
 * do TL chủ ý truyền và sẽ chặn phần sửa, TL tự cân nhắc). */
const MODIFY_INTENT_RE = /\b(sửa|chỉnh\s+sửa|implement|viết|tạo|thêm|refactor|deploy|commit|push|cài\s+đặt|upgrade)\b/i
/**
 * r70 (BUG2-003): cụm PHỦ ĐỊNH + động từ sửa với TẤT TẬN NGỮ (không chỉ
 * file|mã|code|nguồn như whitelist cũ trong READ_ONLY_INTENT_RE). Bằng chứng
 * mission cmuzscdvj…yky79t (Linh Sickyx P1-3): lời giao chứa "hoàn toàn chỉ
 * đọc … không sửa cấu hình bị cấm" — "sửa" trong PHỦ ĐỊNH với tân ngữ
 * "cấu hình" (ngoài whitelist 4 đối tượng cũ) sống sót qua bước strip →
 * MODIFY_INTENT_RE khớp từ "sửa" → auto-detect trả false → sub nhận đủ 45
 * tool ghi và THỰC THI các lệnh ghi (mkdir + redirect tạo artifact). Strip
 * tới 3 từ theo sau động từ (đủ nuốt "cấu hình bị cấm", "file mới nào",
 * "code production"...).
 */
const NEGATED_MODIFY_RE = /\b(?:không|chưa|chẳng|never|don'?t|do\s+not)\s+(?:được\s+)?(?:sửa|chỉnh\s+sửa|viết|tạo|thêm|implement|refactor|deploy|commit|push|cài\s+đặt|upgrade|nâng\s+cấp|write|edit|modify|create|add|remove|delete|install)(?:\s+[^\s,.;:)\]]+){0,3}/gi
/**
 * r70 (BUG2-003b): nhiệm vụ CÓ yêu cầu ghi artifact riêng (lưu báo cáo/
 * artifact/inventory...) → KHÔNG tự bật readOnly hờ — whitelist strip sẽ chặn
 * luôn việc lưu artifact (nhiệm vụ bế tắc); TL muốn strict phải truyền cờ
 * readOnly chủ đích và tự cân nhắc (bằng chứng P1-3: "chỉ đọc" + "lưu artifact
 * báo cáo machine-verifiable" trong cùng một tiêu chí nghiệm thu).
 */
const ARTIFACT_WRITE_RE = /\b(?:lưu|ghi|tạo|save|write)\s+(?:artifact|báo\s+cáo|report|inventory|bằng\s+chứng)/i
/** Detect readOnly từ lời giao: TÍN HIỆU MẠNH có mặt + KHÔNG còn ý định sửa
 * nào sau khi bỏ cụm ràng buộc (chống "không sửa file" tự kích hoạt guard âm
 * vì chứa từ "sửa") — r70: phủ định-sửa được strip tổng quát theo
 * NEGATED_MODIFY_RE trước khi test; nhiệm vụ đòi lưu artifact riêng thì
 * KHÔNG auto-bật (BUG2-003b). */
export function detectReadOnlyDelegation(task: string, context?: string | null): boolean {
  const text = `${task}\n${context ?? ''}`
  if (!READ_ONLY_INTENT_RE.test(text)) return false
  if (ARTIFACT_WRITE_RE.test(text)) return false
  let stripped = text.replace(new RegExp(READ_ONLY_INTENT_RE.source, 'gi'), ' ')
  stripped = stripped.replace(NEGATED_MODIFY_RE, ' ')
  return !MODIFY_INTENT_RE.test(stripped)
}

/** r69 (BUG-012 — quan sát r68): ngưỡng cảnh báo token THEO PHẦN VIỆC (không
 * cắt cứng — user directive là ∞ TỔNG). Bằng chứng: 1 sub-task khảo sát đốt
 * 1.86M tokens ≈ 46% mission #18, không một cảnh báo. 2 mốc 1.2M / 2.4M:
 * mốc 1 chốt-đi-viết-báo-cáo, mốc 2 nhắc lại mạnh (mọi cảnh báo đều là
 * evidence trong transcript + máy đo báo về parent). */
export const DELEGATION_TOKEN_WARN_TIERS = [1_200_000, 2_400_000, Number.POSITIVE_INFINITY]



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
  // r71 (BUG2-019/021/022 — user directive "agents khai thác DB triệt để"):
  // knowledge_write (ghi bài học KB — bỏ gate CATALYST; readOnly delegation
  // vẫn strip đúng qua SUBAGENT_WRITE_TOOLS) + data_map (bản đồ vùng dữ liệu
  // — sửa hồi quy r67) + lessons_search (tra bài học/episode on-demand).
  'knowledge_write', 'data_map', 'lessons_search',
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
  // USER DIRECTIVE 2026-10-09 — FORGE giữ nguyên là đích delegate hợp lệ
  // (builder tổng lực) nhưng là agent ĐỘC LẬP — resolve by-name DB-first
  // (không còn qua POSITION_BY_NAME/position 'FS').
  { name: 'FORGE', role: 'Full-Stack Developer (độc lập)', bestFor: 'tính năng full-stack END-TO-END tự chủ theo spec trọn gói: UI + API + DB + tự kiểm định (lint/type_check/run_tests) + preview verify' },
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
  // USER DIRECTIVE 2026-10-09 — 'FS' đã GỠ (FORGE tách khỏi Code Team → resolve
  // by-name DB-first ở caller). TASK 48 — 'SEC' cũng đã gỡ trước đó.
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
  endedBy: 'concluded' | 'iteration_limit' | 'stall_brake' | 'token_budget' | 'timeout' | 'cancelled' | 'error'
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

/**
 * r70 (BUG2-016): digest có cấu trúc cho evidence của trọng tài độc lập —
 * tool đọc/khảo sát trả kết quả lớn (grep 72 match, file_read 500 dòng) thì
 * preview 160-chars chỉ là mẩu cụt, trọng tài "không trình bày đủ" → phán
 * âm oan (2 case r70: SENTINEL 18% + MEGATRON 12%). Digest kèm TỔNG SỐ +
 * tối đa 6 mẫu path/dòng — đủ thẩm định trọn vẹn mà không phình evidence.
 * Fail-open tuyệt đối: mọi lỗi → '' (evidence giữ nguyên như cũ).
 */
export function resultDigestForEvidence(toolName: string, r: unknown): string {
  try {
    if (r === null || r === undefined) return ''
    const o = (typeof r === 'object' ? r : null) as Record<string, unknown> | null
    if (!o) return ''
    if (toolName === 'grep') {
      const total = typeof o.totalMatches === 'number'
        ? o.totalMatches
        : Array.isArray(o.matches) ? (o.matches as unknown[]).length : -1
      if (total >= 0) {
        const paths = Array.isArray(o.matches)
          ? [...new Set((o.matches as unknown[]).slice(0, 80).map(m => {
              if (m && typeof m === 'object') {
                const mm = m as Record<string, unknown>
                return String(mm.file ?? mm.path ?? mm.filePath ?? '')
              }
              return String(m ?? '').split(':')[0]
            }).filter(Boolean))].slice(0, 6)
          : []
        return ` ‹digest: ${total} match${paths.length ? ` · ${paths.join(' · ')}` : ''}›`
      }
    }
    if (toolName === 'file_read' || toolName === 'file_list') {
      const path = typeof o.path === 'string' ? o.path : ''
      const content = typeof o.content === 'string' ? o.content : ''
      if (path && toolName === 'file_read') return ` ‹digest: đọc trọn ${path} · ${content ? content.split('\n').length : '?'} dòng›`
      if (toolName === 'file_list' && Array.isArray(o.files)) return ` ‹digest: ${o.files.length} file›`
    }
    if (toolName === 'shell' || toolName === 'run_tests' || toolName === 'run_gate' || toolName === 'type_check' || toolName === 'lint') {
      const out = typeof o.output === 'string' ? o.output : typeof o.stdout === 'string' ? o.stdout : ''
      if (out) return ` ‹digest: ${out.split('\n').length} dòng output›`
    }
    return ''
  } catch {
    return ''
  }
}

/** r70 (BUG2-015): dấu hiệu lỗi provider TRANSIENT — 429/rate-limit/FreeUsage
 * (bằng chứng r70: "Zen 429 rate-limited (key #1) — FreeUsageLimitError",
 * "thất bại toàn chuỗi (HTTP + CLI)") / 5xx / mạng. Sub-agent loop dùng để
 * quyết định ngủ-65s-tái-thử thay vì chết nhãn error. Export để test hồi quy. */
export const TRANSIENT_LLM_ERROR_RE = /429|rate.?limit|freeusage|throttl|econnreset|econnrefused|etimedout|socket hang up|\b50[234]\b|temporarily|overloaded/i

/**
 * r70 (BUG2-017): merge snapshot todo của delegation — item incoming KHÔNG
 * kèm status (update-theo-id chỉ đổi nội dung) → GIỮ status cũ của item trùng
 * (id || content). Trước đây mặc định 'pending' → snapshot regress →
 * completion-guard nudge stale oan (bằng chứng MEGATRON P0-3 r70: DB 9/9
 * completed nhưng nudge "9 mục CHƯA hoàn thành"). Export để test hồi quy.
 */
export function mergeTodoSnapshot(
  prev: Array<{ id?: string; content: string; status: string }>,
  incoming: Array<{ id?: string; content: string; status: string | null }>,
): Array<{ id?: string; content: string; status: string }> {
  const kept = prev.filter(p => !incoming.some(t => (t.id && t.id === p.id) || t.content === p.content))
  const merged = incoming.map(t => {
    if (t.status !== null) return { id: t.id, content: t.content, status: t.status }
    const hit = prev.find(p => (t.id && p.id === t.id) || p.content === t.content)
    return { id: t.id, content: t.content, status: hit?.status ?? 'pending' }
  })
  return [...kept, ...merged]
}

// ==================== SUB-AGENT SLOT POOL — TUẦN TỰ: MỖI LƯỢT 1 (user R14, bản 3) ====================
// USER DIRECTIVE lịch sử (3 bản — bản sau ghi đè bản trước):
//   · Bản 1: "tối đa 1" (đúng ý tuần tự từ đầu).
//   · Bản 2 (2026-10-29b, ĐÃ BỎ theo bản 3): "3 là số subagents tối đa, mỗi
//     sub-agent KHÔNG dùng chung API key" → pool 3 slot, mỗi slot ghim 1 key.
//   · Bản 3 (R14, phiên này — QUAY LẠI TUẦN TỰ): "agents khi gọi agent khác
//     tham gia xử lý tác vụ thì mỗi lượt chỉ gọi thêm 1, lần lượt agent này
//     xử lý xong mới tới agent khác để khỏi vấn đề lỗi; nếu gọi team thì lần
//     lượt từng thành viên". Rationale từ bằng chứng quan sát R11: sub-agent
//     spawn ĐỒNG THỜI là nguồn lỗi thực đo được (2 opencode process ~600MB/cái
//     cùng lúc → MemAvailable 364MB < 450MB → OOM kill + PM2 restart 9 lần/
//     2.5h; SQLite contention; recompile chồng nhau).
// Thiết kế (giữ nguyên khung, chỉ đổi mặc định):
//   · SUBAGENT_MAX_CONCURRENT slot (mặc định = 1 TUẦN TỰ; env
//     SUBAGENT_MAX_CONCURRENT override — kill-switch đặt 3 để quay lại bản 2)
//     — mọi đường delegate đều đi qua đây (delegate_task / dispatch_agent /
//     dispatch_agents_parallel / eval harness...), kể cả 2 goal-loop job
//     song song của worker: với pool=1, FIFO đảm bảo sub-agent trước HOÀN
//     THÀT (release slot) rồi sub-agent sau mới bắt đầu — đúng semantics
//     "mỗi lượt chỉ gọi thêm 1".
//   · Slot i GHIM key Zen #i (runWithZenKeyBinding — AsyncLocalStorage trong
//     llm.ts): MỌI LLM call của run (ReAct + wrap-up + trọng tài độc lập)
//     dùng đúng key đó → sub-agent KHÔNG BAO GIỜ dùng chung key với sub-agent
//     khác / caller thường (parent goal-loop / utility) — getZenKey() tự NÉ
//     key đang ghim (xem llm.ts). Với pool=1 chỉ dùng key #1 cho sub-agent;
//     key #2/#3 (nếu có) tự do cho parent — không đổi chính sách key-isolation
//     của bản 2 (vẫn đúng với 1 sub-agent).
//   · Thời gian chờ hàng đợi KHÔNG đếm vào SUBAGENT_TIMEOUT_MS (acquire trước
//     startedAt — timeout tính từ khi sub-agent THỰC SỰ chạy).
//
// Chống deadlock (giữ nguyên từ bản 1):
//   - Sub-agent KHÔNG có tool điều phối (DEPTH_GUARD) → 1 run giữ tối đa 1
//     slot, không acquire lồng (pool=1 an toàn: người giữ slot duy nhất không
//     thể tự chờ chính nó).
//   - escalate_problem auto-apply bị TẮT khi gọi từ sub-agent (tool-executor)
//     → không xảy ra kịch bản giữ slot rồi chờ slot mới qua auto-dispatch.
const SUBAGENT_SLOT_QUEUE_LOG_MS = 1_000
const zenKeyCountForSlots = getZenKeyCount()
const rawSubagentMaxConcurrent = Number(process.env.SUBAGENT_MAX_CONCURRENT)
const SUBAGENT_MAX_CONCURRENT = Number.isFinite(rawSubagentMaxConcurrent) && rawSubagentMaxConcurrent >= 1
  ? Math.floor(rawSubagentMaxConcurrent)
  : 1

interface SubAgentSlot {
  id: number
  /** Index key Zen (0-based) ghim cho slot này; -1 = không ghim (slot thừa hơn số key) */
  keyIndex: number
}
interface SubAgentSlotWaiter {
  holder: string
  startedAt: number
  resolve: (slot: SubAgentSlot) => void
}

/** R15 (fixbug.md đợt R14 "đo phân phối waitedMs hàng đợi chéo" + BUG2-239
 *  "đài quan sát"): thống kê hàng đợi. Chỉ lượt PHẢI XẾP HÀNG mới ghi mẫu
 *  waitedMs (nhận slot ngay không ghi — không làm lệch trung bình); recent
 *  giữ 20 mẫu gần nhất, consumer (API/UI) tự tính p50/p95. */
interface SubAgentQueueStats {
  /** Tổng lượt acquire (kể cả nhận slot ngay không xếp hàng) */
  acquires: number
  /** Số lượt phải xếp hàng (= số mẫu waitedMs thật) */
  queued: number
  waitedMsTotal: number
  waitedMsMax: number
  recentWaitedMs: number[]
}

/** Toàn bộ state pool để BEHIND globalThis singleton (R15) — cùng pattern
 *  __tmoOcCliGate của llm.ts. Lý do: next dev nạp module đa instance theo từng
 *  route-bundle → 2 pool riêng = 2 sub-agent chạy song song (VỠ tính tuần tự
 *  R14) + đài quan sát đọc pool sai instance (thấy số 0 giả). 1 singleton
 *  toàn process khắc phục cả hai. Ghi chú: slots tạo theo SUBAGENT_MAX_CONCURRENT
 *  của instance nạp đầu — cùng process thì env đồng nhất, không phải edge thật. */
interface SubAgentSlotPoolState {
  slots: SubAgentSlot[]
  /** Chuỗi hiển thị agent đang giữ từng slot (rỗng = slot tự do) */
  holders: string[]
  waiters: SubAgentSlotWaiter[]
  queueStats: SubAgentQueueStats
}
const gForSubAgentSlots = globalThis as unknown as { __tmoSubAgentSlotPool?: SubAgentSlotPoolState; __tmoSubAgentSlotBootLogged?: boolean }
function subAgentSlotPool(): SubAgentSlotPoolState {
  if (!gForSubAgentSlots.__tmoSubAgentSlotPool) {
    gForSubAgentSlots.__tmoSubAgentSlotPool = {
      slots: Array.from(
        { length: SUBAGENT_MAX_CONCURRENT },
        (_, i) => ({ id: i + 1, keyIndex: i < zenKeyCountForSlots ? i : -1 }),
      ),
      holders: Array.from({ length: SUBAGENT_MAX_CONCURRENT }, () => ''),
      waiters: [],
      queueStats: { acquires: 0, queued: 0, waitedMsTotal: 0, waitedMsMax: 0, recentWaitedMs: [] },
    }
  }
  return gForSubAgentSlots.__tmoSubAgentSlotPool
}

// Boot log phanh (R12 lesson: "mọi fix phanh phải kèm boot log đối chiếu
// được" — .env đè default là lỗi đã xảy ra thật với GOAL_LOOP_MAX_DEBT_CYCLES).
// 1 dòng, hiện đúng 1 lần/process — globalThis guard đảm bảo KHÔNG lặp khi
// next dev nạp module lần 2 từ bundle khác (bài học __tmoOcCliGate llm.ts).
if (!gForSubAgentSlots.__tmoSubAgentSlotBootLogged) {
  gForSubAgentSlots.__tmoSubAgentSlotBootLogged = true
  console.log(
    `[SubAgentSlot] Phanh hiệu dụng (R14): maxConcurrent=${SUBAGENT_MAX_CONCURRENT} — TUẦN TỰ, mỗi lượt 1 sub-agent, hoàn tất mới tới kế tiếp (user directive bản 3; ` +
    `kill-switch env SUBAGENT_MAX_CONCURRENT>=2 để quay lại bản 2 song song) [ nguồn: ${
      Number.isFinite(rawSubagentMaxConcurrent) && rawSubagentMaxConcurrent >= 1 ? `env=${rawSubagentMaxConcurrent}` : 'default=1'
    }, zenKeys=${zenKeyCountForSlots} ]`,
  )
}

/**
 * Trạng thái pool cho quan sát/test (R14) — observability: đài quan sát + test
 * đọc giá trị hiệu dụng mà không phải parse log. Fail-open: luôn trả object.
 * R15: (+) queueStats — phân phối waitedMs hàng đợi (đo đếm theo directive
 * fixbug.md R14 "đo phân phối waitedMs") — dữ liệu đầu vào cho quyết định
 * kill-switch concurrency (đợ bàn TB-03): p95 chờ thấp + RAM dư → có thể cân
 * nhắc nâng pool; p95 cao + OOM từng xảy ra → giữ 1.
 */
export function getSubAgentSlotPoolInfo(): {
  maxConcurrent: number
  source: 'env' | 'default'
  zenKeys: number
  busySlots: number
  waiting: number
  queueStats: {
    acquires: number
    queued: number
    waitedMsAvg: number | null
    waitedMsMax: number | null
    p50WaitedMs: number | null
    p95WaitedMs: number | null
    recentSamples: number
  }
} {
  const pool = subAgentSlotPool()
  const q = pool.queueStats
  // p50/p95 trên 20 mẫu gần nhất (sorted copy — không đổi mảng gốc)
  const sorted = [...q.recentWaitedMs].sort((a, b) => a - b)
  const pct = (p: number): number | null => (sorted.length === 0 ? null : sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))])
  return {
    maxConcurrent: SUBAGENT_MAX_CONCURRENT,
    source: Number.isFinite(rawSubagentMaxConcurrent) && rawSubagentMaxConcurrent >= 1 ? 'env' : 'default',
    zenKeys: zenKeyCountForSlots,
    busySlots: pool.holders.filter(Boolean).length,
    waiting: pool.waiters.length,
    queueStats: {
      acquires: q.acquires,
      queued: q.queued,
      waitedMsAvg: q.queued > 0 ? Math.round(q.waitedMsTotal / q.queued) : null,
      waitedMsMax: q.waitedMsMax || null,
      p50WaitedMs: pct(0.5),
      p95WaitedMs: pct(0.95),
      recentSamples: sorted.length,
    },
  }
}

function assignSubAgentSlot(idx: number, holder: string): SubAgentSlot {
  const pool = subAgentSlotPool()
  pool.holders[idx] = holder
  return pool.slots[idx]
}

/** Nhận slot: FIFO công bằng — slot tự do chỉ trao thẳng khi KHÔNG có người chờ. */
function acquireSubAgentSlot(profileName: string, parentAgentName: string): Promise<SubAgentSlot> {
  const pool = subAgentSlotPool()
  const q = pool.queueStats
  q.acquires++
  const holder = `${profileName} ← ${parentAgentName}`
  if (pool.waiters.length === 0) {
    const freeIdx = pool.holders.findIndex(h => h === '')
    if (freeIdx >= 0) return Promise.resolve(assignSubAgentSlot(freeIdx, holder))
  }
  const busy = pool.holders.filter(Boolean)
  console.log(`[SubAgentSlot] ${profileName} (từ ${parentAgentName}) xếp hàng — ${busy.length}/${SUBAGENT_MAX_CONCURRENT} slot bận${busy.length > 0 ? `: ${busy.join(' · ')}` : ''}${pool.waiters.length > 0 ? ` (+${pool.waiters.length} đang chờ trước)` : ''}`)
  return new Promise<SubAgentSlot>(resolve => {
    const startedAt = Date.now()
    pool.waiters.push({
      holder,
      startedAt,
      resolve: slot => {
        const waitedMs = Date.now() - startedAt
        // R15 stats: đây là mẫu waitedMs THẬT (đã xếp hàng) — ghi vào phân phối
        q.queued++
        q.waitedMsTotal += waitedMs
        if (waitedMs > q.waitedMsMax) q.waitedMsMax = waitedMs
        q.recentWaitedMs.push(waitedMs)
        if (q.recentWaitedMs.length > 20) q.recentWaitedMs.shift()
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
  const pool = subAgentSlotPool()
  const idx = slot.id - 1
  const next = pool.waiters.shift()
  if (next) {
    next.resolve(assignSubAgentSlot(idx, next.holder))
  } else {
    pool.holders[idx] = ''
  }
}

// ==================== RE-ENTRANCY FLAG (FB-SERIAL-R1-01 — R14) ====================
// AsyncLocalStorage đánh dấu "async context này đang giữ slot sub-agent" —
// mirror pattern runWithZenKeyBinding (llm.ts). Vì sao cần: guard duy nhất cũ
// là calledFromSubAgent = Boolean(context?.delegationRunId) (tool-executor
// escalate case) — nhưng registerDelegationRun trả NULL khi sub-agent chạy
// không sessionId (eval harness default / tracker throw fail-open) → guard
// tưởng là parent → auto-apply dispatch → runSubAgentForProfile → acquire
// xếp hàng chờ CHÍNH NÓ (pool=1) → tự-chờ deadlock (bounded bởi loop-bound,
// = 0 → vô hạn thật). Flag này phủ MỌI đường dispatch lồng từ trong sub-agent
// (không phụ thuộc context có delegationRunId hay không).
// R15-R1-03 (auditor): ALS instance ĐƯA LÊN globalThis cùng pool — nếu
// next dev nạp module 2 instance (route-bundle khác), 2 ALS riêng = guard
// instance B không thấy flag của instance A → cửa sau stall cross-bundle
// (pool đã global từ R15 nhưng guard thì chưa). 1 ALS toàn process.
const gForSubAgentALS = globalThis as unknown as { __tmoSubAgentRunALS?: AsyncLocalStorage<{ holding: true }> }
const subAgentRunALS = gForSubAgentALS.__tmoSubAgentRunALS ?? (gForSubAgentALS.__tmoSubAgentRunALS = new AsyncLocalStorage<{ holding: true }>())

/** true nếu async context hiện tại đang chạy bên trong runSubAgentForProfile
 *  (đang giữ slot pool). Dùng cho guard tool-executor + fail-fast nested. */
export function isInsideSubAgentRun(): boolean {
  return subAgentRunALS.getStore()?.holding === true
}

// ==================== GENERIC SUB-AGENT RUNNER ====================

/**
 * ĐIỂM ĐI QUA DUY NHẤT cho quy tắc concurrency (R14, bản 3 — ghi đè
 * 2026-10-29b): "mỗi lượt 1 sub-agent, hoàn tất mới tới kế tiếp; sub-agent
 * vẫn 1 API key Zen riêng, không dùng chung key". Wrapper
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
  /** r69 (BUG-010/014 — quan sát r68): delegation CHỈ ĐỌC — tầng tool chặn
   * mọi tool ghi (strip khỏi whitelist). Cờ từ delegate_task args HOẶC
   * auto-detect từ ý định chỉ-đọc trong lời giao (xem READ_ONLY_INTENT_RE). */
  readOnly?: boolean
  parentRunId?: string | null
  parentAgentName?: string
  sessionId?: string | null
  onTokens?: (tokens: number) => void
}): Promise<SubAgentOutcome> {
  const profileName = params.profile?.name || 'unknown-agent'
  const parentName = params.parentAgentName || 'parent-agent'
  // FB-SERIAL-R1-01 (P2 — R14): context này ĐANG giữ slot (chạy bên trong
  // sub-agent) mà tiếp tục dispatch lồng → acquire sẽ xếp hàng chờ CHÍNH NÓ
  // (pool=1) → tự-chờ deadlock. Fail-open: trả outcome fail rõ lý do —
  // caller (escalate auto-apply / fan-out / eval) thấy lỗi riêng của dispatch
  // này, run cha KHÔNG sập.
  if (isInsideSubAgentRun()) {
    console.warn(`[SubAgentSlot] ⛔ NESTED_DELEGATION_BLOCKED (R14): ${profileName} (từ ${parentName}) — context đang giữ slot, không dispatch lồng (chống tự-chờ)`)
    return {
      success: false,
      agent: profileName,
      position: '',
      report: '',
      tokensUsed: 0,
      iterations: 0,
      toolCalls: 0,
      endedBy: 'error',
      evidence: [],
      error: 'NESTED_DELEGATION_BLOCKED (R14): context hiện đang giữ slot pool sub-agent — dispatch lồng sẽ tự-chờ chính nó. Dùng advisory (escalate_problem) hoặc báo parent dispatch giúp ở vòng sau.',
    }
  }
  const slot = await acquireSubAgentSlot(profileName, parentName)
  if (slot.keyIndex >= 0) {
    console.log(`[SubAgentSlot] ${profileName} nhận slot ${slot.id}/${SUBAGENT_MAX_CONCURRENT} — ghim Zen key #${slot.keyIndex + 1} riêng cho toàn bộ run (user directive: sub-agent không dùng chung key)`)
  }
  try {
    // FB-SERIAL-R1-01: đánh dấu toàn bộ run (kể cả ReAct + tool calls + trọng
    // tài) đang giữ slot — mọi dispatch lồng từ trong đây bị chặn ở trên.
    return subAgentRunALS.run({ holding: true }, () =>
      slot.keyIndex >= 0
        ? runWithZenKeyBinding(slot.keyIndex, () => runSubAgentForProfileInner(params))
        : runSubAgentForProfileInner(params))
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
  readOnly?: boolean
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
    readOnly,
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
  // r69 (BUG-012) — mốc ngưỡng cảnh báo token đã đi qua (index vào TIERS)
  let tokenWarnTier = 0
  // r69 (BUG-010/014 + audit F2) — máy đo governance: số lần sub-agent THỬ gọi
  // tool ghi bị chặn (readOnly) + danh sách file thật nó đã ghi/sửa (từ args
  // THẬT của tool call — không phải preview 160-chars bị cắt như bản r68).
  let blockedWriteAttempts = 0
  const writtenFilePaths = new Set<string>()
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
      // r69 (BUG-012 — quan sát r68): NGƯỠNG CẢNH BÁO TOKEN THEO PHẦN VIỆC.
      // Bằng chứng: 1 sub-task "khảo sát" đốt 1,859,401 tokens / 31 vòng
      // (≈46% toàn bộ mission #18) không một lời cảnh báo — phanh duy nhất là
      // wall-clock 15'. User directive là ∞ TỔNG (không cắt cứng) nhưng mỗi
      // PHẦN VIỆC vượt ngưỡng phải được cảnh báo để sub-agent chốt bằng chứng
      // + viết báo cáo thay vì mở hướng điều tra mới. Queue (scope ngoài try —
      // transcript khai báo trong try) được XẢ vào transcript ở đầu vòng kế.
      if (tokensUsed >= DELEGATION_TOKEN_WARN_TIERS[tokenWarnTier]) {
        tokenWarnTier++
        try {
          pendingTokenWarnings.push(JSON.stringify({ tool: 'harness_warning', success: false, result: `⚠️ NGÂN SÁCH PHẦN VIỆC: sub-task này đã tiêu ${Math.round(tokensUsed / 1000)}k tokens (vượt ngưỡng ${Math.round(DELEGATION_TOKEN_WARN_TIERS[tokenWarnTier - 1] / 1000)}k — tầm vóc bất thường cho 1 phần việc). Hãy: (1) CHỐT bằng chứng đã thu, (2) viết báo cáo tổng hợp NGAY theo acceptance criteria, KHÔNG mở hướng điều tra mới. Token tiếp tục bị đếm và báo cáo về parent.` }))
          if (sessionId && delegationRunId) {
            recordAgentThought(sessionId, `⚠️ NGÂN SÁCH: sub-task vượt ngưỡng ${Math.round(DELEGATION_TOKEN_WARN_TIERS[tokenWarnTier - 1] / 1000)}k tokens (${Math.round(tokensUsed / 1000)}k tiêu thụ) — đã cảnh báo chốt bằng chứng + viết báo cáo (lần ${tokenWarnTier})`, iterations, delegationRunId)
          }
        } catch { /* fail-open — cảnh báo không được phá vòng */ }
      }
    }
  }

  // r69 (BUG-012): queue cảnh báo token (xả vào transcript ở đầu vòng —
  // transcript thuộc scope trong try, addTokens ngoài try)
  const pendingTokenWarnings: string[] = []

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

    // ━━ r69 (BUG-010/014) — READ-ONLY DELEGATION: enforcement TẦNG TOOL ━━
    // Cờ readOnly từ delegate_task args HOẶC auto-detect từ ràng buộc chỉ-đọc
    // trong lời giao ("chỉ đọc…", "không sửa file"…) → strip mọi tool ghi khỏi
    // whitelist. Sub-agent gọi tool ghi sẽ bị từ chối NGAY TẠI TẦNG TOOL với
    // thông báo hướng dẫn — không còn dựa vào kỷ luật đọc câu chữ lời giao.
    const readOnlyContract = readOnly === true || detectReadOnlyDelegation(task, context)
    const effectiveAllowedTools = readOnlyContract
      ? allowedTools.filter(t => !SUBAGENT_WRITE_TOOLS.has(t))
      : allowedTools
    const allowedToolsFinal = effectiveAllowedTools
    if (readOnlyContract) {
      const stripped = allowedTools.filter(t => SUBAGENT_WRITE_TOOLS.has(t))
      console.log(`[SubAgent] ${profile.name} READ-ONLY delegation contract ${readOnly === true ? '(cờ từ TL)' : '(auto-detect từ lời giao)'} — strip ${stripped.length} tool ghi khỏi whitelist: ${stripped.join(', ') || '(không có)'} · giữ ${allowedToolsFinal.length} tool đọc/kiểm định`)
    }

    // ━━ r69 (BUG-009/025) — GIT SNAPSHOT ĐẦU RUN: đếm dòng working-tree bẩn ━━
    // (delta vs snapshot cuối run → machine block báo file sub-agent để lại)
    let gitStatusBefore: import('@/lib/workspace-git').WorkspaceGitStatus | null = null
    try {
      const { getWorkspaceGitStatus } = await import('@/lib/workspace-git')
      gitStatusBefore = await getWorkspaceGitStatus()
    } catch { /* fail-open */ }

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
      // r70 (BUG2-009): lưu TOÀN VĂN lời giao (task + context) vào trace jsonl
      // NGAY lúc dispatch — trước đây mọi kênh đều cắt (run_start 240 chars,
      // dev.log ~100) nên điều tra post-hoc không dựng lại được TL đã giao gì
      // (vụ BUG2-003 phải đoán nguyên nhân từ tiêu chí directive). recordAgent-
      // Thought ghi bền vững vào agent-runs/<runId>.jsonl (sống qua crash) —
      // marker 📋 để phân biệt với suy nghĩ thật.
      if (delegationRunId) {
        const brief = `📋 LỜI GIAO ĐẦY ĐỦ (delegation brief — ghi tại dispatch): ${task}${context ? `\n— Context kèm theo: ${context}` : ''}${readOnly === true ? '\n— Cờ readOnly: ĐÚNG (TL truyền)' : ''}`
        try { recordAgentThought(sessionId, brief, 0, delegationRunId) } catch { /* fail-open */ }
      }
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
            // P4-M2 (mục #8b) — model cấu hình của sub-agent (profile.model,
            // cùng id mà callLLMForAgent dưới dùng) → bảng model-comparison
            // phủ cả delegation rows.
            model: profile.model,
          })
        } catch { /* fail-open — hiển thị thôi, không được phép lỗi delegation */ }
      })()
    }
    finishDelegationRun = (status: 'done' | 'error' | 'cancelled', summary: string) => {
      if (!delegationRunId || !sessionId) return
      // r60 (C7) — persist token/third metadata thật của delegation vào
      // AgentRunRecord (trước đây endAgentRun không nhận tokensUsed/stopReason
      // → row delegation ghi tokensUsed=null, stopReason chung chung 'complete'
      // — bằng chứng r59: hậu kiểm phải đọc outcome từ text run_end thay vì SQL).
      try { endAgentRun(sessionId, delegationRunId, status, summary, tokensUsed, state.endedBy) } catch { /* fail-open */ }
    }

    const maxIterDisplay = ALL_SUBAGENT_CAPS_UNLIMITED
      ? (SUBAGENT_HARD_CEILING_ITERATIONS > 0
          ? `${SUBAGENT_HARD_CEILING_ITERATIONS} (trần cứng dự phòng — cả 3 cap = 0)`
          : '∞ (KHÔNG GIỚI HẠN — user directive)')
      : SUBAGENT_MAX_ITERATIONS === 0 ? '∞' : String(SUBAGENT_MAX_ITERATIONS)
    // r60 (C4) — hiển thị wall-clock khi timeout ∞: operator đọc log thấy ngay
    // điểm dừng thời gian dự phòng đang áp dụng.
    const timeoutDisplay = SUBAGENT_TIMEOUT_MS > 0
      ? `${Math.round(SUBAGENT_TIMEOUT_MS / 60000)}'`
      : (SUBAGENT_WALL_CLOCK_MS > 0 ? `∞ nhưng wall-clock an toàn ${Math.round(SUBAGENT_WALL_CLOCK_MS / 60000)}' (r60)` : '∞')
    console.log(`[SubAgent] ${parentAgentName} → ${profile.name}: "${task.slice(0, 100)}" (max ${maxIterDisplay} vòng, budget ${SUBAGENT_TOKEN_BUDGET === 0 ? '∞' : SUBAGENT_TOKEN_BUDGET} tokens, timeout ${timeoutDisplay}, ${allowedToolsFinal.length} tools${delegationRunId ? `, run ${delegationRunId.slice(0, 22)}…` : ''})`)

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

    // r60 (B1/B2/B3 — từ quan sát tư duy r59) — BLOCK KỶ LUẬT SỐ LIỆU cho
    // sub-agent (mirror NGUYÊN TẮC SỐ LIỆU của goal-loop): 3 lỗi tư duy quan
    // sát được: (1) tin phép tự đếm tay 96 hơn metadata total=97 của tool;
    // (2) re-verify tuyệt đối 162k tokens cho đáp án đã có bằng chứng (ALISTA#2);
    // (3) không dám đọc lại file 4ms để trích dẫn vì hiểu quy tắc không-lặp
    // một cách quá câu nệ. Không sửa instruction gốc trong DB — chỉ append.
    systemPrompt += `\n\n📊 NGUYÊN TẮC SỐ LIỆU (bắt buộc):\n- METADATA CỦA TOOL LÀ NGUỒN CHÂN LÝ: total/rowCount/totalMatches/exitCode trong kết quả tool là số MÁY ĐO — dùng thẳng, KHÔNG tự đếm tay danh sách. Mâu thuẫn → tin metadata trừ khi có bằng chứng tool trực tiếp bác. Cần đếm → file_list({"count_only":true,...}) / grep mode count.\n- KIỂM ĐỊNH MỘT LẦN ĐỦ: kết quả đã có bằng chứng độc lập → KHÔNG đo lại cùng phép đo; chỉ đo lại khi có bằng chứng MỚI mâu thuẫn.\n- ĐỌC LẠI FILE NHỎ ĐỂ TRÍCH DẪN NGUYÊN VĂN bằng chứng là HỢP PHÁP (không phải lặp việc) — cấm là lặp MỘT VIỆC y hệt không ra kết quả mới.\n- KẾT THÚC: báo cáo đủ đã làm (bằng chứng tool) + còn thiếu + đề xuất — trung thực, không khẳng định quá bằng chứng.`

    // r68 FIX-3c (BUG-015 — quan sát mission cmuznvkl…6b136k): sub-agent
    // chạy delegation KHÔNG bao giờ được cấp BẢN ĐỒ DỮ LIỆU (grep 0 kết quả
    // buildDataMapBlock trong file này) — agent chuyên môn đọc/ghi vùng nào
    // không có chỉ dẫn. Giờ cấp cùng block định tuyến như goal-loop chính
    // (route theo task + context, fail-open tuyệt đối).
    try {
      const { buildDataMapBlock } = await import('@/lib/data-map')
      const mapBlock = buildDataMapBlock(`${task}\n${context ?? ''}`.slice(0, 2500))
      if (mapBlock) systemPrompt += mapBlock
    } catch { /* fail-open — bản đồ không được phép làm hỏng delegation */ }

    // r68 FIX-6a (BUG-004 — quan sát cùng mission): SENTINEL nghĩ 100%
    // tiếng Anh suốt sub-run (6/6 thought r=0.000) — đường delegation không
    // nhận protocol ngôn ngữ của goal-loop chính (priority 97 chỉ inject
    // main loop). Import cùng 1 nguồn sự thật (export r68) thay vì copy text.
    try {
      const { buildLanguageProtocol } = await import('@/lib/agent-goal-loop')
      systemPrompt += buildLanguageProtocol()
    } catch { /* fail-open — protocol ngôn ngữ không được phá delegation */ }

    const transcript: Array<{ role: 'user' | 'assistant' | 'tool'; content: string }> = [
      { role: 'user', content: buildDelegationPrompt(profile.name, task, context, allowedToolsFinal, parentAgentName, acceptanceCriteria) },
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
      const schemaSection = buildCompactToolSchemasSection(allowedToolsFinal)
      if (schemaSection) {
        toolSchemaMsg = `${schemaSection}\n\n(Trên đây là schema ĐẦY ĐỦ của các tool bạn được dùng — tham chiếu mỗi khi gọi tool; KHÔNG đoán tên param. Tools cũng ĐÃ ĐƯỢC TRUYỀN QUA API native function calling — ƯU TIÊN emit tool_calls qua API, chỉ viết text tool_call: khi API không hỗ trợ.)`
        transcript.push({ role: 'user', content: toolSchemaMsg })
      }
      nativeToolSchemas = getToolDefinitions(allowedToolsFinal) as LLMTool[]
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

    // ROUND-54 FIX C — stall-brake state: signature vòng trước + chuỗi trùng
    let lastRoundSig = ''
    let sameSigStreak = 0
    // r60 (A1b) — PER-CALL REPEAT: đếm từng call-signature XUYÊN SUỐT run (Map
    // ngoài vòng lặp) — 1 call lặp N lần rải rác nhiều vòng cũng bị bắt.
    const runCallSigCounts = new Map<string, number>()
    // r68 FIX-6b (BUG-004 — quan sát mission cmuznvkl…6b136k): SENTINEL nghĩ
    // 100% tiếng Anh suốt sub-run, 0 nudge — sub loop KHÔNG có detector ngôn
    // ngữ (chỉ main loop có). Mirror detector goal-loop: 2 nudge + đếm muộn.
    let subViNudges = 0
    let subViLateCount = 0

    const loopPromise = (async () => {
      // CI-1 (0 = UNLIMITED): cap = 0 → KHÔNG trần tương ứng (vòng / token /
      // thời gian). Check timeout/token chỉ áp dụng khi cap đó > 0.
      // CI-1 + review #7: dùng effective max — khi cả 3 cap = 0 (unlimited) vẫn có
      // trần cứng 200 vòng chống kẹt parent vĩnh viễn
      while (SUBAGENT_EFFECTIVE_MAX_ITERATIONS === 0 || iterations < SUBAGENT_EFFECTIVE_MAX_ITERATIONS) {
        if (isCancelled()) { state.endedBy = 'cancelled'; return }
        if (timedOut) { return } // zombie guard — parent đã nhận timeout
        // r60 (C4) — WALL-CLOCK dự phòng khi timeout = 0 (vô hạn theo user
        // directive): 15' mặc định — cắt "productive fixation" kiểu ALISTA#1
        // (27 vòng 1.47M tokens) mà không bóp task lớn thật sự (đủ 10-12').
        if (SUBAGENT_TIMEOUT_MS > 0 && Date.now() - startedAt > SUBAGENT_TIMEOUT_MS - 60_000) {
          state.forceWrapUp = true; state.wrapUpReason = 'gần hết thời gian'; break
        }
        if (SUBAGENT_TIMEOUT_MS === 0 && SUBAGENT_WALL_CLOCK_MS > 0 && Date.now() - startedAt > SUBAGENT_WALL_CLOCK_MS - 60_000) {
          state.forceWrapUp = true; state.wrapUpReason = `gần hết thời gian (wall-clock an toàn ${Math.round(SUBAGENT_WALL_CLOCK_MS / 60000)} phút — token/vòng vẫn vô hạn)`; break
        }
        if (SUBAGENT_TOKEN_BUDGET > 0 && tokensUsed >= SUBAGENT_TOKEN_BUDGET) {
          state.forceWrapUp = true; state.wrapUpReason = 'hết token budget của sub-agent'; break
        }

        iterations++
        // r69 (BUG-012): xả queue cảnh báo ngân sách vào transcript TRƯỚC khi
        // build prompt vòng này — sub-agent thấy cảnh báo ở đúng lượt kế.
        while (pendingTokenWarnings.length > 0) {
          const w = pendingTokenWarnings.shift()
          if (w) transcript.push({ role: 'tool', content: w })
        }
        // USER DIRECTIVE 2026-10-29 — bằng chứng CI-2 của batch này (reset mỗi vòng)
        let batchEvidence: string[] = []
        // r60 (C3) — STATUS-AWARENESS cho sub-agent: dòng trạng thái bám vào
        // prompt mỗi vòng (KHÔNG đụng transcript — chỉ thêm vào formatted) để
        // sub-agent thấy chính số vòng/tool/token của mình (bằng chứng r59:
        // ALISTA#1 xoay vòng 27 lần không hay biết mình đang quay vòng). Nhấn
        // tiến-triển > tiết-kiệm (user directive: token không là ràng buộc).
        // r60.2 — format token dễ đọc (≥1M hiển thị M — mirror fmtTok goal-loop)
        const fmtTok = (t: number) => t >= 1_000_000 ? `${(t / 1_000_000).toFixed(1)}M` : `${Math.round(t / 1000)}k`
        const subStatusNote = `\n\n📊 TRẠNG THÁI (vòng ${iterations} · ${toolCallCount} tool calls, ${successfulToolCalls} thành công · ~${fmtTok(tokensUsed)} tokens): token KHÔNG giới hạn — nhưng KHÔNG lặp một phép đo đã có kết quả (dùng total/rowCount/số máy từ tool); cùng lỗi 2 lần → đổi cách; xong phần việc → kết luận trung thực phần đã làm + còn thiếu.`
        const formatted = transcript
          .map(m => `\n\n[${m.role === 'user' ? 'USER' : m.role === 'assistant' ? 'ASSISTANT' : 'TOOL RESULT'}]: ${m.content}`)
          .join('')
          .trim() + subStatusNote

        let result: Awaited<ReturnType<typeof callLLMForAgent>> | null = null
        // r70 (BUG2-015 — bằng chứng mission cmuzscdvj…yky79t): 2 delegation
        // chết nhãn "error" (SENTINEL 17:24:01 sau run_gate; SENTINEL 17:30:17
        // "Zen 429 rate-limited — thất bại toàn chuỗi") chỉ vì provider
        // FreeUsageLimitError cooldown 60s không ai chờ — delegation đang
        // khỏe bị giết oan giữa chừng. Giờ: lỗi TRANSIENT (429/rate-limit/
        // 5xx/mạng) → ngủ 65s (tôn trọng cooldown Zen) rồi THỬ LẠI, tối đa
        // 2 lần; chỉ chịu thua khi hết lượt hoặc lỗi KHÔNG transient.
        let llmAttempts = 0
        while (true) {
          try {
            result = await withTimeout(
              callLLMForAgent(formatted, { provider: profile.provider, model: profile.model }, systemPrompt, {
                agentId: profile.id || `subagent:${profile.name}`,
                agentName: `${profile.name} (sub-agent)`,
                temperature: profile.temperature,
                // R15-R1-03b: cờ lan xuống OC-CLI spawn env (TMO_INSIDE_SUBAGENT_RUN)
                // → bridge tmo_* forward qua HTTP context → guard escalate phía
                // app thấy đường cross-process (ALS không xuyên được qua CLI).
                insideSubAgentRun: true,
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
            break
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            llmAttempts++
            if (
              TRANSIENT_LLM_ERROR_RE.test(msg) && llmAttempts <= 2 && !timedOut && !isCancelled() &&
              (SUBAGENT_EFFECTIVE_MAX_ITERATIONS === 0 || iterations < SUBAGENT_EFFECTIVE_MAX_ITERATIONS)
            ) {
              console.warn(`[SubAgent] ${profile.name} LLM transient (lần ${llmAttempts}/2): ${msg.slice(0, 140)} → chờ 65s (cooldown provider) rồi thử lại`)
              if (sessionId && delegationRunId) {
                try {
                  recordAgentThought(sessionId, `⏳ Provider nghẽn tạm thời (429/rate-limit) — delegation CHỜ 65s rồi thử lại (lần ${llmAttempts}/2), KHÔNG chết giữa chừng`, iterations, delegationRunId)
                } catch { /* fail-open */ }
              }
              await new Promise(r => setTimeout(r, 65_000))
              continue
            }
            state.errorMessage = msg
            state.endedBy = 'error'
            return
          }
        }

        if (!result || (!result.content && !result.tool_calls?.length)) {
          state.errorMessage = result?.error || 'LLM call failed'
          state.endedBy = 'error'
          return
        }
        addTokens(result.tokensUsed)
        if (timedOut) { return } // LLM về nhưng timeout đã nổ — không chạy tool nữa

        // ROUND-55 FIX G — THOUGHT RECORDING cho sub-agent (lấp blind spot
        // quan sát: mission SENTINEL r54 — sub_*.jsonl 172 tool events / 0
        // thought → operator thấy sub-agent LÀM GÌ nhưng không thấy NGHĨ GÌ).
        // Mirror goal-loop chính (agent-goal-loop.ts: recordAgentThought với
        // reasoning riêng + content thô — tracker tự strip khối tool-call ra
        // event riêng). Chỉ ghi khi có delegationRunId — KHÔNG rơi về run
        // parent (registerDelegationRun fail-open → null → bỏ qua, fail-open).
        if (sessionId && delegationRunId) {
          try {
            const reasoning = result.reasoning ? String(result.reasoning).trim() : ''
            if (reasoning) {
              recordAgentThought(sessionId, `💭 (suy nghĩ) ${reasoning.slice(0, 800)}`, iterations, delegationRunId)
            }
            recordAgentThought(sessionId, result.content, iterations, delegationRunId)
          } catch { /* fail-open — observation không được phép làm hỏng run */ }
        }

        // r68 FIX-6b (BUG-004): detector ngôn ngữ cho sub-agent — mirror
        // goal-loop r67 F9 (đo tỉ lệ ký tự có dấu bằng MÃ, không tin prompt).
        // 2 nudge đầu; sau đó ngừng nudge nhưng vẫn đếm (ghi outcome.report)
        // để parent + trọng tài thấy vi phạm tồn dư.
        // r70 (BUG2-007/013): đo trên prose ĐÃ MASK tool-call — mirror fix
        // goal-loop r70 (lượt thuần tool-call JSON không còn bị kết tội
        // "viết tiếng Anh" oan — bằng chứng Linh Sickyx evt6 ratio 7% ngay
        // sau thought tiếng Việt chuẩn).
        try {
          const [{ vietnameseTextRatio }, { maskToolCallText }, { stripInvisibleThoughtNoise }] = await Promise.all([
            import('@/lib/agent-goal-loop'),
            import('@/lib/tool-calls'),
            import('@/lib/agent-run-tracker'),
          ])
          const subProseForLang = maskToolCallText(stripInvisibleThoughtNoise(result.content || ''))
          const viRatio = vietnameseTextRatio(subProseForLang)
          if (viRatio < 0.08 && subViNudges < 2) {
            subViNudges++
            transcript.push({
              role: 'tool',
              content: JSON.stringify({ tool: 'harness_warning', success: false, result: `⚠️ NGÔN NGỮ (kiểm tra bằng mã): nội dung bạn vừa viết gần như KHÔNG có dấu tiếng Việt (tỉ lệ ${Math.round(viRatio * 100)}%). Người dùng là người Việt — TOÀN BỘ suy nghĩ/kế hoạch/báo cáo PHẢI viết TIẾNG VIỆT CÓ DẤU ngay từ lượt tiếp theo (chỉ giữ nguyên tên tool/file/hàm/lệnh/code).` }),
            })
            if (sessionId && delegationRunId) {
              recordAgentThought(sessionId, `⚠️ NGÔN NGỮ: output tiếng Anh (ratio ${Math.round(viRatio * 100)}%) — đã cảnh báo viết tiếng Việt (lần ${subViNudges}/2)`, iterations, delegationRunId)
            }
          } else if (viRatio < 0.08) {
            subViLateCount++
            if (sessionId && delegationRunId) {
              recordAgentThought(sessionId, `⚠️ NGÔN NGỮ (sau trần nudge): output tiếng Anh tiếp diễn (lần thứ ${subViLateCount}) — đã ghi vào báo cáo delegation`, iterations, delegationRunId)
            }
          }
        } catch { /* fail-open — kiểm tra ngôn ngữ không được phép làm hỏng vòng */ }

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
        ).filter(tc => allowedToolsFinal.includes(tc.name))
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
            transcript.push({ role: 'assistant', content: capAssistantContentForTranscript(result.content) })
            transcript.push({ role: 'tool', content: brokenHint })
            continue
          }
          // ANTI-HALLUCINATION GUARD: task cần bằng chứng (đọc file / review /
          // kiểm tra...) mà sub-agent CHƯA chạy tool nào → không chấp nhận kết
          // luận ngay — ép 1 vòng thu thập bằng chứng thật.
          const taskNeedsEvidence = /đọc|read|review|phân tích|analyz|kiểm tra|verify|lint|test|file|source|code|mã nguồn/i.test(task)
          if (!nudgedOnce && taskNeedsEvidence && evidence.length === 0 && (SUBAGENT_MAX_ITERATIONS === 0 || iterations < SUBAGENT_MAX_ITERATIONS) && !timedOut) {
            nudgedOnce = true
            transcript.push({ role: 'assistant', content: capAssistantContentForTranscript(result.content) })
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
          let openTodos = lastTodoSnapshot.filter(t => t.status === 'pending' || t.status === 'in_progress' || t.status === 'blocked')
          if (openTodos.length > 0) {
            // r70 (BUG2-017 — bằng chứng MEGATRON P0-3 r70): snapshot in-memory
            // có thể STALE — batch cuối chỉ có todo_write (không evidence) thì
            // nhánh autoComplete-refresh không chạy → args-merge cũ đẩy status
            // về 'pending' dù DB đã auto-complete theo bằng chứng → nudge
            // "9 mục CHƯA hoàn thành" oan, sub phải tốn 1 vòng todo_read xác
            // minh "stale". Giờ: trước khi nudge, ĐỌC LẠI DB (nguồn sự thật,
            // 1 query delegation-scope) — chỉ nudge khi DB còn xác nhận mở.
            try {
              const { db } = await import('@/lib/db')
              const fresh = await db.todo.findMany({
                where: { sessionId: todoScopeSessionId, runId: delegationRunId },
                orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
                select: { content: true, status: true },
                take: 200,
              })
              if (fresh.length > 0) {
                lastTodoSnapshot = fresh.map(t => ({ id: undefined, content: t.content, status: t.status }))
                openTodos = lastTodoSnapshot.filter(t => t.status === 'pending' || t.status === 'in_progress' || t.status === 'blocked')
              }
            } catch { /* fail-open — giữ snapshot cũ */ }
          }
          if (
            openTodos.length > 0 && sawTodoWrite && todoCompletionNudges < MAX_TODO_COMPLETION_NUDGES &&
            (SUBAGENT_EFFECTIVE_MAX_ITERATIONS === 0 || iterations < SUBAGENT_EFFECTIVE_MAX_ITERATIONS) &&
            !timedOut && !isCancelled()
          ) {
            todoCompletionNudges++
            transcript.push({ role: 'assistant', content: capAssistantContentForTranscript(result.content) })
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

        transcript.push({ role: 'assistant', content: capAssistantContentForTranscript(result.content) })

        // ROUND-54 FIX C — STALL BRAKE cho sub-agent (bằng chứng r54: SENTINEL
        // lặp 62× todo_read cùng args → 95+ tool events / transcript phình
        // 24k→300k+ tokens không phanh — main loop có fingerprint brake r46
        // nhưng sub-agent KHÔNG, và 3 cap CI-1 = ∞ nên không có điểm dừng tự
        // nhiên nào trước trần cứng 200 vòng. Signature = tên tool + args
        // nguyên văn của cả batch (sort ổn định); trùng liên tiếp
        // SUBAGENT_STALL_SIG_REPEATS vòng → wrap-up conclude (KHÔNG phải error —
        // model có kết quả trong tay, chỉ đang quay vòng).
        // (signature dùng stableStringify cục bộ — safeStringify của file này
        // typed hẹp cho envelope {tool,success,result} nên không dùng lại được)
        // r60 (A1b) — PER-CALL REPEAT: cộng dồn chữ ký TỪNG call vào bộ đếm
        // xuyên suốt run (bắt "productive fixation" rải rác nhiều vòng —
        // ALISTA#1 r59: file_list ×21 xen kẽ nháp báo cáo nên batch-signature
        // không bao giờ khớp; per-call thì mọi lần gọi đều được tính).
        for (const tc of toolCalls) {
          const cs = `${tc.name}::${stableArgsString(tc.args)}`
          runCallSigCounts.set(cs, (runCallSigCounts.get(cs) || 0) + 1)
        }
        const roundSig = toolCalls.map(tc => `${tc.name}::${stableArgsString(tc.args)}`).sort().join('|||')
        if (roundSig === lastRoundSig) sameSigStreak++
        else { sameSigStreak = 1; lastRoundSig = roundSig }
        const overrunCall = SUBAGENT_STALL_CALL_REPEATS > 0
          ? [...runCallSigCounts.entries()].find(([, n]) => n >= SUBAGENT_STALL_CALL_REPEATS)
          : undefined
        if (overrunCall && !timedOut && !isCancelled()) {
          state.forceWrapUp = true
          state.wrapUpReason = `no_progress — call "${overrunCall[0].slice(0, 100)}" lặp ${overrunCall[1]} lần trong run (rải rác các vòng — per-call brake r60)`
          if (result.content) state.lastContent = result.content
          console.warn(`[SubAgent] ${profile.name} PER-CALL STALL BRAKE (r60): 1 tool call lặp ${overrunCall[1]} lần — ${overrunCall[0].slice(0, 90)} → wrap-up conclude`)
          break
        }
        if (SUBAGENT_STALL_SIG_REPEATS > 0 && sameSigStreak >= SUBAGENT_STALL_SIG_REPEATS && !timedOut && !isCancelled()) {
          state.forceWrapUp = true
          state.wrapUpReason = `no_progress — lặp tool-signature giống hệt nhau ${sameSigStreak} vòng liên tiếp (${toolCalls.map(tc => tc.name).join(', ')})`
          if (result.content) state.lastContent = result.content
          console.warn(`[SubAgent] ${profile.name} STALL BRAKE: ${sameSigStreak} vòng liên tiếp cùng tool-signature (${toolCalls.map(tc => tc.name).join(', ').slice(0, 80)}) → wrap-up conclude`)
          break
        }

        for (const tc of toolCalls) {
          if (isCancelled() || timedOut) break // zombie guard — dừng tool batch
          // Sub-agent bị giới hạn trong whitelist CỦA NÓ (đã strip depth-guard tools)
          if (!allowedToolsFinal.includes(tc.name)) {
            // r69 (BUG-010/014): READ-ONLY contract — chặn tại TẦNG TOOL kèm
            // hướng dẫn dùng tool đọc (thông báo cũ chung chung "not available"
            // khiến sub-agent tưởng thiếu tool thay vì bị chặn hợp đồng).
            const isReadOnlyBlock = readOnlyContract && SUBAGENT_WRITE_TOOLS.has(tc.name)
            if (isReadOnlyBlock) blockedWriteAttempts++
            const rejection = JSON.stringify({
              tool: tc.name,
              success: false,
              result: isReadOnlyBlock
                ? `⛔ CHẶN BỞI HỢP ĐỒNG CHỈ ĐỌC: delegation này ở chế độ readOnly (TL chỉ giao khảo sát/kiểm định) — tool ghi "${tc.name}" KHÔNG có trong whitelist của bạn. Dùng tool đọc/kiểm định (file_read, file_list, grep, run_tests, lint, type_check, git_diff...) để hoàn thành nhiệm vụ và báo cáo; nếu THẬT SỰ cần sửa mã, nêu đề xuất trong báo cáo để TL quyết định.`
                : `Tool "${tc.name}" not available for sub-agent ${profile.name}.`,
            })
            transcript.push({ role: 'tool', content: rejection })
            toolResultLog.push(rejection) // IMP-1 (W1) — trọng tài thấy cả lần bị từ chối
            evidence.push(`${tc.name}: ${isReadOnlyBlock ? 'bị chặn bởi hợp đồng CHỈ ĐỌC (readOnly)' : 'bị từ chối (ngoài whitelist)'}`)
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
          // ROUND-54 FIX A — todo_read READ/WRITE SYMMETRY (bằng chứng r54
          // mission SENTINEL sub_1791357836734: todo_write bị ép ghi scope
          // delegation:sub_… (r50 P2-γ) nhưng todo_read KHÔNG ép → model đọc
          // sessionId của session CHA 62 lần, 62 kết quả "Đọc 19 todo" giống
          // hệt nhau, không bao giờ thấy 4 todo plan của chính mình → loop
          // 95+ tool events / ~7M tokens / parent block 30+. Giờ: đọc scope
          // MÌNH mặc định (hallucination guard mirror todo_write + main loop);
          // đọc scope KHÁC (chẩn đoán run cha) vẫn CHO nhưng result kèm ghi
          // chú chỉ đường về scope delegation của model.)
          let crossScopeTodoRead = false
          if (tc.name === 'todo_read' && todoScopeSessionId) {
            const declaredSession = typeof toolArgs.sessionId === 'string' ? toolArgs.sessionId.trim() : ''
            if (!declaredSession || declaredSession === 'default' || declaredSession === todoScopeSessionId) {
              if (declaredSession !== todoScopeSessionId) {
                console.log(`[SubAgent] ${profile.name} todo_read: sessionId khai báo "${declaredSession || '(trống)'}" → ép về scope delegation (chống todo mù scope — FIX A r54)`)
              }
              toolArgs.sessionId = todoScopeSessionId
              toolArgs.agentRole = profile.name // todo của delegation ghi kèm role này (r50 P2-γ)
            } else {
              crossScopeTodoRead = true // cross-scope inspection — annotate result
            }
          }
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
            // r70 (BUG2-017): item update-theo-id KHÔNG kèm status → GIỮ status
            // cũ trong snapshot (trước đây mặc định 'pending' → snapshot regress
            // → completion-guard nudge stale oan — bằng chứng MEGATRON P0-3).
            // Trích thành mergeTodoSnapshot export để test hồi quy trực tiếp.
            if (Array.isArray(toolArgs.todos)) {
              const incoming = (toolArgs.todos as Array<Record<string, unknown>>)
                .map(t => ({
                  id: typeof t?.id === 'string' ? t.id : undefined,
                  content: String(t?.content ?? ''),
                  status: t?.status === undefined || t?.status === null ? null : String(t.status),
                }))
                .filter(t => t.content)
              lastTodoSnapshot = mergeTodoSnapshot(lastTodoSnapshot, incoming)
            }
          }
          let toolResult: { success: boolean; result: unknown }
          try {
            toolResult = await executeTool(tc.name, toolArgs, { agentName: profile.name, sessionId, delegationRunId })
          } catch (err) {
            toolResult = { success: false, result: { error: err instanceof Error ? err.message : String(err) } }
          }
          // ROUND-54 FIX A (tiếp): cross-scope todo_read → kèm ghi chú chỉ đường
          // về scope delegation của chính model (chống mù 62 lần như bằng chứng
          // r54 — model đọc đi đọc lại cùng một list của session cha).
          if (crossScopeTodoRead && toolResult && typeof toolResult.result === 'object' && toolResult.result !== null) {
            try {
              toolResult.result = {
                ...(toolResult.result as Record<string, unknown>),
                _scopeNote: `⚠️ Bạn vừa đọc todo của session KHÁC scope delegation của mình. Todo của CHÍNH BẠN (run delegation này — plan + tiến độ) nằm ở: todo_read({"sessionId":"${todoScopeSessionId}","agentRole":"${profile.name}"}) hoặc để sessionId trống. Kiểm tra xong hãy quay về kế hoạch của bạn.`,
              }
            } catch { /* fail-open — annotation không được phép làm hỏng delegation */ }
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
          // r70 (BUG2-016 — bằng chứng r70: trọng tài phán âm SENTINEL 18%
          // "Machine-search có 72 kết quả nhưng bằng chứng bị cắt" + MEGATRON
          // 12% "chỉ nêu tổng 74 match… không trình bày đủ" — 2 case cùng họ:
          // preview 160-chars cắt mất substantive result → trọng tài đòi thứ
          // nó không được thấy (catch-22). Giờ: tool đọc/khảo sát THÀNH CÔNG
          // kèm DIGEST có cấu trúc (tổng số + N mẫu đầu) — đủ thẩm định mà
          // không phình evidence tier.
          let digest = ''
          if (toolResult.success) {
            try {
              digest = resultDigestForEvidence(tc.name, toolResult.result)
            } catch { /* fail-open — digest là phần thưởng */ }
          }
          evidence.push(`${tc.name}(${compactArgs(tc.args)}) → ${toolResult.success ? '✓' : '✗'} ${preview}${digest}`)
          // r69 (audit F2 r68 + BUG-010): máy đo file ghi/sửa từ args THẬT của
          // tool call (bản r68 bóc từ preview 160-chars bị cắt → ra blob JSON
          // cụt thay vì tên file — máy đo phải chính xác tuyệt đối).
          if (toolResult.success && SUBAGENT_WRITE_TOOLS.has(tc.name) && tc.name !== 'shell' && tc.name !== 'run_bg') {
            const p = typeof tc.args?.path === 'string' ? tc.args.path
              : typeof tc.args?.file === 'string' ? tc.args.file
              : typeof tc.args?.filePath === 'string' ? tc.args.filePath : ''
            if (p) writtenFilePaths.add(p)
          }
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
          !planNudged && !sawTodoWrite && toolCallCount >= 3 && allowedToolsFinal.includes('todo_write') &&
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
      // r60 (A3) — wrapUpReason bắt đầu 'no_progress' (stall brake) giờ gắn nhãn
      // ĐÚNG 'stall_brake' thay vì rơi nhánh else 'iteration_limit' (bằng chứng
      // r59: dev.log in STALL BRAKE nhưng run_end ghi "[Delegation] iteration_limit"
      // — operator đọc sai loại sự cố khi hậu kiểm).
      if (state.endedBy !== 'concluded' && state.endedBy !== 'cancelled' && state.endedBy !== 'error' && state.endedBy !== 'timeout') {
        state.forceWrapUp = true
        if (!state.wrapUpReason) state.wrapUpReason = `hết ${SUBAGENT_EFFECTIVE_MAX_ITERATIONS === 0 ? '∞' : SUBAGENT_EFFECTIVE_MAX_ITERATIONS} vòng${ALL_SUBAGENT_CAPS_UNLIMITED && SUBAGENT_HARD_CEILING_ITERATIONS > 0 ? ' (trần cứng dự phòng — cả 3 cap = 0)' : ''}`
        state.endedBy = state.wrapUpReason.startsWith('no_progress')
          ? 'stall_brake'
          : state.wrapUpReason.includes('token')
            ? 'token_budget'
            : state.wrapUpReason.includes('thời gian') ? 'timeout' : 'iteration_limit'
      }
    })()

    // r60 (C4) — outer bound: timeout > 0 → dùng nó; timeout = 0 nhưng wall-clock
    // > 0 → wall-clock + 3' grace cho wrap-up LLM call cuối; cả hai = 0 → vô hạn
    // thật (user directive cũ giữ nguyên khi đặt cả 2 env = 0).
    const SUBAGENT_LOOP_BOUND_MS = SUBAGENT_TIMEOUT_MS > 0
      ? SUBAGENT_TIMEOUT_MS
      : (SUBAGENT_WALL_CLOCK_MS > 0 ? SUBAGENT_WALL_CLOCK_MS + 180_000 : 0)
    if (SUBAGENT_LOOP_BOUND_MS > 0) {
      await withTimeout(loopPromise, SUBAGENT_LOOP_BOUND_MS, `SubAgent ${profile.name} loop`)
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
    // r60 (A3) — stall_brake thêm vào needWrapUp: model có kết quả trong tay,
    // chỉ đang quay vòng — wrap-up tổng hợp là đúng semantics (mirror iteration_limit)
    const needWrapUp = state.forceWrapUp || state.endedBy === 'iteration_limit' || state.endedBy === 'stall_brake' || state.endedBy === 'token_budget' || state.endedBy === 'timeout' || (state.endedBy === 'error' && (state.lastContent || evidence.length > 0))

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
              insideSubAgentRun: true, // R15-R1-03b — mirror call chính (xem trên)
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
      // r60 (A3) — stall_brake cùng semantics delivery với iteration_limit:
      // kết quả dùng được vẫn trả về parent (evaluation.pass/gaps phản ánh phần chưa xong)
      success: (state.endedBy === 'concluded' || state.endedBy === 'iteration_limit' || state.endedBy === 'stall_brake') && deliveredUsableResults,
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
          // r68 (BUG-017 — quan sát mission cmuznvkl…6b136k): MỤC LỤC tool
          // call đầy đủ (preview "tool(args) → ✓/✗" đã có sẵn trong evidence
          // array của run) — trọng tài đối chiếu sự TỒN TẠI của call bằng mục
          // lục này, không phụ thuộc tiering 12k (đã 2/2 lần phán âm vì call
          // ở ĐẦU run bị cắt khỏi cửa sổ).
          callIndex: evidence,
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

      // ===== r68 FIX-2 (BUG-018 — quan sát mission cmuznvkl…6b136k) =====
      // Trọng tài CHÍNH (evaluator chu kỳ của goal-loop) 2 lần phán "chưa có
      // sửa code" trong khi working tree CÓ fix thật do sub-agent thực hiện
      // — vì delegate_task result chỉ lọt vào transcript chính qua 1 dòng
      // preview bị cắt, không có MÁY ĐO. Giờ gắn block máy đo xác định vào
      // report (report là tool-result chính quy mà cả parent LLM lẫn trọng
      // tài chu kỳ đọc): số call, file ghi/sửa, lần chạy gate — toàn bộ thu
      // từ transcript đã chạy, KHÔNG thể bịa.
      // r69 nâng cấp: (a) file ghi/sửa từ args THẬT (audit F2 r68 — bản cũ
      // bóc preview 160-chars cụt ra blob JSON); (b) +readOnly blocked +token
      // warn tiers (BUG-012); (c) +git working-tree delta (BUG-009/025 — rác
      // tmp/ và thay đổi chưa commit không còn vô hình).
      try {
        const gateTools = /^(run_gate|run_tests)\(/
        const gateCalls = evidence.filter(e => gateTools.test(e))
        const gateOk = gateCalls.filter(e => e.includes('→ ✓')).length
        const machineLines = [
          '📊 MÁY ĐO delegation (thu tự động từ transcript — sự thật, không thể bịa):',
          `- Tool calls đã chạy: ${toolCallCount} (${successfulToolCalls} thành công)`,
        ]
        const writtenFiles = [...writtenFilePaths]
        if (writtenFiles.length > 0) machineLines.push(`- File ghi/sửa (từ args thật của tool call): ${writtenFiles.join(', ').slice(0, 600)}`)
        if (readOnlyContract) {
          machineLines.push(`- Hợp đồng CHỈ ĐỌC (readOnly): BẬT${blockedWriteAttempts > 0 ? ` — sub-agent đã THỬ ghi ${blockedWriteAttempts} lần, TẤT CẢ bị chặn ở tầng tool (tuân thủ mandate khảo sát)` : ' — không có lần thử ghi nào bị chặn'}${writtenFiles.length > 0 ? ` — NHƯNG phát hiện ${writtenFiles.length} file ghi qua đường khác (kiểm tra governance!)` : ''}`)
        }
        if (gateCalls.length > 0) machineLines.push(`- Gate/test đã chạy: ${gateCalls.length} lần (${gateOk} ✓${gateCalls.length - gateOk > 0 ? ` / ${gateCalls.length - gateOk} ✗` : ''}) — chi tiết output nằm trong báo cáo`)
        if (tokenWarnTier > 0) machineLines.push(`- Ngân sách: ${Math.round(tokensUsed / 1000)}k tokens — vượt ${tokenWarnTier} ngưỡng cảnh báo theo phần việc (1.2M/2.4M — BUG-012), đã nhắc chốt bằng chứng`)
        if (outcome.evaluation) machineLines.push(`- Verdict trọng tài độc lập: ${outcome.evaluation.pass ? 'ĐẠT' : 'CHƯA ĐẠT'} (tin cậy ${Math.round(outcome.evaluation.confidence * 100)}%)`)
        // r68 FIX-6b: vi phạm ngôn ngữ tồn dư của sub-agent (sau 2 nudge) —
        // máy đếm, parent + trọng tài chu kỳ đọc được trong tool-result.
        if (subViNudges > 0 || subViLateCount > 0) {
          machineLines.push(`- Ngôn ngữ: ${subViNudges} cảnh báo tiếng Việt đã phát${subViLateCount > 0 ? ` · ${subViLateCount} lượt tiếng Anh TIẾP DIỄN sau trần cảnh báo` : ''}`)
        }
        // r69 (BUG-009/025): working-tree delta trong khoảng thời gian sub-agent
        // chạy — rác tmp/, file mồ côi, thay đổi chưa commit đều hiện hình. Lưu
        // ý đọc số: trước R14 sub-agent chạy song song có thể lăn delta của
        // agent khác vào đây; R14 đã tuần tự hóa nhưng guard giữ nguyên (phòng
        // vùng gọi ngoài pool — defense in depth).
        try {
          const { getWorkspaceGitStatus, diffGitStatusSnapshots, formatUncommittedBlock } = await import('@/lib/workspace-git')
          const after = await getWorkspaceGitStatus()
          if (after.ok && gitStatusBefore && after.lines.length > 0) {
            const delta = diffGitStatusSnapshots(gitStatusBefore, after)
            if (delta.length > 0) {
              machineLines.push(`- Working tree để lại (delta trong lúc sub-agent chạy): ${delta.slice(0, 12).join(' | ').slice(0, 700)}${delta.length > 12 ? ` (+${delta.length - 12} khác)` : ''}`)
            }
          } else if (after.ok && !gitStatusBefore?.ok && after.lines.length > 0) {
            const block = formatUncommittedBlock(after, '- Working tree (ảnh cuối run)')
            if (block) machineLines.push(block.split('\n').slice(0, 12).join('\n'))
          }
        } catch { /* fail-open — git delta không được phá máy đo */ }
        outcome.report += `\n\n${machineLines.join('\n')}`
      } catch { /* fail-open — máy đo không được phá delegation result */ }
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
      // endedBy: 'concluded' | 'timeout' | 'token_budget' | 'error' | 'cancelled' | 'iteration_limit' | 'stall_brake' (r60)
      const outcomeForBrain = state.endedBy === 'cancelled'
        ? 'ABANDONED' as const
        : state.endedBy === 'error'
          ? 'FAILURE' as const
          : mapRunOutcome({
              status: state.endedBy === 'concluded' ? 'done' : (state.endedBy === 'stall_brake' ? 'stall_brake' : 'iteration_limit'),
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

    // ━━ r71 (BUG2-019) — HARVEST BÀI HỌC DELEGATION → KB ĐỒ THỊ (hardcode) ━━
    // KHÔNG phụ thuộc CATALYST hay thiện chí gọi knowledge_write của agent:
    // delegation có tín hiệu đáng học (lỗi tool / kết thúc bất thường / báo cáo
    // có mục bài học) → harness TỰ ghi DelegationLesson entity + relationship
    // vào KB (LocalEntity → sync Neo4j). Fail-open tuyệt đối — không đụng
    // kết quả trả về parent. Xem harvestDelegationLessonToKB phía dưới.
    try {
      const { parseToolResultLogEntry } = await import('@/lib/episodic-memory/agent-brain')
      const wrapToolFailures = toolResultLog
        .map(parseToolResultLogEntry)
        .filter((e): e is { tool: string; success: boolean; text: string } => e !== null && !e.success)
        .length
      if (delegationLessonWorthy({ toolFailures: wrapToolFailures, endedBy: state.endedBy, report: outcome.report || '' })) {
        await harvestDelegationLessonToKB({
          agentName: profile.name,
          parentAgentName,
          task,
          endedBy: state.endedBy,
          evaluationPass: outcome.evaluation ? outcome.evaluation.pass : null,
          toolFailures: wrapToolFailures,
          toolCalls: toolCallCount,
          iterations,
          report: outcome.report || '',
        })
        console.log(`[SubAgent] r71 harvest: DelegationLesson "${profile.name}" (${state.endedBy}, ${wrapToolFailures} lỗi tool) đã ghi KB đồ thị`)
      }
    } catch (harvestErr) {
      console.warn(`[SubAgent] r71 harvest DelegationLesson thất bại (fail-open):`, harvestErr instanceof Error ? harvestErr.message : String(harvestErr))
    }

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

// ==================== r71 (BUG2-019) — HARVEST BÀI HỌC DELEGATION → KB ĐỒ THỊ ====================
// User directive r71: "nếu không gọi CATALYST thì không agent nào ghi lại bài
// học trong quá trình thực thi — lỗ hổng lớn liên quan database". Trước r71
// knowledge_write bị gate chỉ CATALYST+Omega → 4 mission quan sát (r67-r70)
// KHÔNG bao giờ dispatch CATALYST → 0 bài học ghi vào KB đồ thị trong khi
// thực thi. Lớp episodic (Episode/Lesson từ LỖI tool) có tự ghi — nhưng tri
// thức dạng entity/quan hệ (đã làm gì, kết cục, mối liên agent→nhiệm vụ) thì
// KHÔNG có đường ghi nào. Giờ: tại delegation wrap-up (SAU khi sub-agent kết
// thúc — không phụ thuộc thiện chí gọi tool của agent), harness TỰ ghi 1
// DelegationLesson entity vào KB (LocalEntity → sync Neo4j) + relationship
// agent -[PERFORMED]-> nhiệm vụ. Tín hiệu "đáng học" (chống spam KB):
// (1) có lỗi tool, (2) kết thúc bất thường (timeout/error/stall/token_budget/
// iteration_limit), hoặc (3) báo cáo có mục bài học. Fail-open tuyệt đối.
export function delegationLessonWorthy(args: {
  toolFailures: number
  endedBy: string
  report: string
}): boolean {
  if (args.toolFailures > 0) return true
  if (args.endedBy !== 'concluded' && args.endedBy !== 'cancelled') return true
  return /bài\s*học|lesson|kết\s+luận|nguyên\s+nhân/i.test(args.report || '')
}

/** Rút gọn báo cáo wrap-up thành digest cho KB — ưu tiên mục "Bài học" nếu
 * sub-agent viết theo format, không thì lấy đầu báo cáo. Cap 700 chars. */
export function digestDelegationReport(report: string): string {
  const text = (report || '').trim()
  if (!text) return '(không có báo cáo)'
  const lessonMatch = text.match(/(?:^|\n)[^\S\n]*(?:##?\s*)?(?:bài\s*học|lessons?)[^\n]*\n([\s\S]{40,900})/i)
  const picked = lessonMatch ? lessonMatch[1].trim() : text
  return picked.length > 700 ? `${picked.slice(0, 660)}…[cắt — ${text.length} chars gốc]` : picked
}

async function harvestDelegationLessonToKB(args: {
  agentName: string
  parentAgentName: string
  task: string
  endedBy: string
  evaluationPass: boolean | null
  toolFailures: number
  toolCalls: number
  iterations: number
  report: string
}): Promise<void> {
  const { agentWriteEntity, agentWriteRelationship } = await import('@/lib/knowledge-bridge')
  const now = new Date()
  const stamp = `${now.toISOString().slice(0, 10)} ${now.toISOString().slice(11, 16)}Z`
  const slug = args.task.replace(/\s+/g, ' ').trim().slice(0, 70)
  const entityName = `DelegationLesson ${args.agentName} ${stamp}: ${slug}`.slice(0, 140)
  const verdictText = args.evaluationPass === null ? 'trọng tài chưa chấm' : args.evaluationPass ? 'trọng tài ĐẠT' : 'trọng tài CHƯA ĐẠT'
  const description = [
    `[${args.agentName} ← ${args.parentAgentName}] Kết thúc: ${args.endedBy} · ${verdictText}`,
    `Nhiệm vụ: ${args.task.replace(/\s+/g, ' ').slice(0, 300)}`,
    `Số liệu: ${args.iterations} vòng · ${args.toolCalls} tool calls · ${args.toolFailures} lỗi tool`,
    `Trích báo cáo: ${digestDelegationReport(args.report)}`,
  ].join('\n').slice(0, 1200)
  await agentWriteEntity({
    entityName,
    entityType: 'DelegationLesson',
    description,
    domain: 'vận hành',
    properties: { agent: args.agentName, endedBy: args.endedBy, toolFailures: args.toolFailures, harvestedBy: 'r71-delegation-wrapup' },
  })
  await agentWriteRelationship({
    sourceEntityName: args.agentName,
    targetEntityName: entityName,
    relationshipType: 'PERFORMED',
    description: `${args.agentName} thực hiện delegation ${stamp} (${args.endedBy})`,
  }).catch(() => { /* relationship là phần phụ — entity đã ghi đủ giá trị */ })
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
  readOnly?: boolean
  parentRunId?: string | null
  parentAgentName?: string
  sessionId?: string | null
  onTokens?: (tokens: number) => void
}): Promise<SubAgentOutcome> {
  const { position, task, context, acceptanceCriteria, readOnly, parentRunId = null, parentAgentName = 'parent-agent', sessionId = null, onTokens } = params

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
    readOnly,
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
${allowedTools.includes('lessons_search') ? '- TRƯỚC khi giải một vấn đề khó/lỗi lạ → lessons_search({"query":"<từ khoá vấn đề>"}) tra bài học + episode + trí nhớ agents (lỗi tương tự đã gặp, cách giải) — đừng giải lại từ đầu những gì hệ thống đã học.' : ''}
${allowedTools.includes('knowledge_write') ? '- Rút ra BÀI HỌC trong lúc làm (cách giải lỗi, pattern hệ thống, quyết định kiến trúc) → ghi NGAY vào KB: knowledge_write({"entityName":"...","entityType":"Lesson","description":"...","category":"..."}). Bài học xứng đáng = giúp agents sau giải nhanh hơn cùng vấn đề. Báo cáo cuối nêu thêm mục "Bài học" ngắn (1-3 dòng).' : ''}
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

NHIỆM VỤ: viết BÁO CÁO TỔNG KẾT ≤ 300 từ theo 5 phần: (1) ĐÃ LÀM + bằng chứng tool cụ thể, (2) KẾ HOẠCH & TIẾN ĐỘ từng bước nếu có todo (completed/failed/in_progress — không có thì ghi "không cần kế hoạch"), (3) CÒN THIẾU/CHƯA KIỂM ĐỊNH ĐƯỢC — không đoán, (4) ĐỀ XUẤT bước tiếp theo, (5) BÀI HỌC — 1-3 dòng điều đắt giá rút ra (cách giải lỗi/pattern hệ thống — nếu không có ghi "không có"). Không gọi tool. Không viết dài.`
}

function safeStringify(entry: { tool: string; success: boolean; result: unknown }): string {
  try {
    return JSON.stringify(entry)
  } catch {
    return JSON.stringify({ tool: entry.tool, success: entry.success, result: String(entry.result).slice(0, 500) })
  }
}

/**
 * ROUND-54 FIX C — string hóa args ỔN ĐỊNH cho tool-signature (stall brake):
 * key sort theo alphabet trước khi stringify (Map/JSON object cùng nội dung
 * nhưng khác thứ tự key → signature KHÁC nhau → brake miss). Fail-open:
 * stringify throw (circular) → trả fallback chuỗi thô đã cắt.
 */
function stableArgsString(args: Record<string, unknown>): string {
  try {
    const sortDeep = (v: unknown): unknown => {
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        const o = v as Record<string, unknown>
        const out: Record<string, unknown> = {}
        for (const k of Object.keys(o).sort()) out[k] = sortDeep(o[k])
        return out
      }
      if (Array.isArray(v)) return v.map(sortDeep)
      return v
    }
    return JSON.stringify(sortDeep(args))
  } catch {
    return String(args).slice(0, 400)
  }
}
