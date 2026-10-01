/**
 * CONTEXT COMPRESSION — module dùng chung (CI-3 B1, Task 13-a)
 * =============================================================
 *
 * Tách logic nén rolling-digest từ agent-goal-loop.ts thành module độc lập
 * để Code Team workflow-engine tái dùng cùng một pattern (roadmap CI-3
 * "Lỗ hổng 1": workflow push tool result THÔ không giới hạn → task code dài
 * phình đến 80k tokens rồi pause).
 *
 * 2 tầng nén (nguyên vẹn pattern đã verify GĐ1/GĐ2 của goal-loop):
 *   1. capToolResult — cap tool result ~4k chars TRƯỚC khi push vào messages
 *      (giữ đầu + cuối vì lỗi/tổng kết lệnh thường nằm CUỐI output).
 *   2. compressConversation — rolling digest: khi segment cũ vượt ngưỡng
 *      50k chars → LLM digest (callUtilityLLM — lõi utility rẻ, không đụng
 *      provider chính của agent) → 1 digest message ~2.5k chars; LLM hỏng thì
 *      fallback heuristic deterministic; mọi lỗi fail-open (return null,
 *      messages giữ nguyên — loop KHÔNG BAO GIỜ bị làm hỏng vì nén).
 *
 * Quy tắc bảo toàn:
 *   - KHÔNG đụng mọi message có index <= protectedStartIndex (system prompt,
 *     chat history, goal/step instruction).
 *   - GIỮ NGUYÊN `keepRecent` message gần nhất (agent đang làm việc với chúng).
 *   - Splice THEO CẶP: assistant-with-tool_calls + các tool reply liền sau nó
 *     là 1 khối nguyên vẹn — không bao giờ cắt một nửa gây orphan tool_call_id
 *     (API "tool_call_id not found" với provider native function calling).
 *
 * FAIL-OPEN TUYỆT ĐỐI — nén là tối ưu, không phải chức năng bắt buộc.
 */

import { createHash } from 'node:crypto'

import { callUtilityLLM } from '@/lib/llm'

// ==================== CONSTANTS (giá trị exact như goal-loop trước tách) ====================

/**
 * Biến thể CHỈ NHẬN số dương (giữ nguyên ngữ nghĩa intEnvPositive của
 * goal-loop): ngưỡng nén 0 = nén mỗi vòng → vô nghĩa/nguy hiểm, không áp
 * "0 = unlimited" cho các hằng nén.
 */
function intEnvPositive(name: string, fallback: number): number {
  const v = Number(process.env[name])
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback
}

/** Ngưỡng tổng ký tự của segment nén được — vượt quá thì nén (goal-loop cũ: 50k) */
export const COMPRESS_THRESHOLD_CHARS = intEnvPositive('GOAL_LOOP_COMPRESS_THRESHOLD_CHARS', 50_000)
/** Số message gần nhất GIỮ NGUYÊN khi nén (goal-loop cũ: 8) */
export const KEEP_RECENT_MESSAGES = intEnvPositive('GOAL_LOOP_KEEP_RECENT_MESSAGES', 8)
/** Cap ký tự của digest message sau nén (goal-loop cũ: 2500) */
export const DIGEST_MAX_CHARS = intEnvPositive('GOAL_LOOP_DIGEST_MAX_CHARS', 2500)
/** Cap ký tự transcript đưa vào LLM nén (đầu vào) — goal-loop cũ: 30k, KHÔNG env */
export const COMPRESS_INPUT_CHARS = 30_000
/** Ngưỡng tối thiểu số message nén được (dưới đây thì không đáng nén) — goal-loop cũ: 4 */
export const MIN_COMPRESSIBLE_MESSAGES = 4
/**
 * Cap ký tự tool result khi đẩy vào messages (goal-loop cũ: MAX_TOOL_RESULT_CHARS = 4000).
 *
 * 2026-09-30 (round-10 audit root-cause): 4000 ký tự làm agent audit KHÔNG THỂ
 * đọc trọn output shell baseline / file_list / protected-hash của chính mình →
 * báo cáo cuối thành "chưa kiểm định được" dù artifact tồn tại (mission
 * run_1790755954444_1 — 100% các mục "KHÔNG KIỂM ĐỊNH ĐƯỢC" đều do cắt giữa).
 * Nâng mặc định 4000 → 12000 + env-configurable (TOOL_RESULT_MAX_CHARS) để
 * điều chỉnh theo loại nhiệm vụ mà không cần sửa code. smartTruncate ở
 * pushToolMessage (giữ đầu+cuối) vẫn bảo vệ context tổng.
 */
export const TOOL_RESULT_MAX_CHARS = intEnvPositive('TOOL_RESULT_MAX_CHARS', 12_000)

/** Timeout LLM digest (goal-loop cũ: 90s — utility prompt nhỏ, không cần dài hơn) */
const DIGEST_LLM_TIMEOUT_MS = 90_000

// ==================== TYPES ====================

/**
 * Message tổng quát cho nén — tương thích cả 2 engine:
 *   - GoalMessage của goal-loop (role: user/assistant/tool, content string)
 *   - Workflow message của workflow-engine (role: system/user/assistant/tool,
 *     content string, tool_call_id?, tool_calls?)
 */
export interface CompressionMessage {
  role: string
  content: string
  tool_call_id?: string
  /** Có mặt trên assistant message native function calling (workflow-engine) */
  tool_calls?: unknown
}

/** Entry bằng chứng cho heuristic fallback — tương thích EvidenceEntry của goal-loop */
export interface CompressEvidenceEntry {
  kind: string
  tool?: string
  success?: boolean
  text: string
}

/** Kết quả nén — `digest` là nội dung digest thô (caller ghi preview vào memory nếu cần) */
export interface CompressionResult {
  digest: string
  digestChars: number
  savedChars: number
  method: 'llm' | 'heuristic'
  /**
   * SUMMARIZER RECEIPT (Task 42) — biên lai xác nhận nội dung đã được tóm tắt:
   * sha256 của transcript đầu vào + digest đầu ra (12 hex), số message đã nén,
   * range index gốc, số ký tự trước→sau, phương pháp. Gắn kèm cuối digest
   * message để agent + user đối chiếu được "đã nén gì, nén từ bao nhiêu".
   */
  receipt?: string
}

// ==================== HELPERS ====================

/** Timeout wrapper cho LLM call (Promise.race — pattern goal-loop/workflow-engine) */
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

/** Assistant message có tool_calls (native function calling) → phải cắt nguyên khối cùng tool replies */
function hasToolCalls(m: CompressionMessage): boolean {
  return m.role === 'assistant' && Array.isArray(m.tool_calls) && (m.tool_calls as unknown[]).length > 0
}

/**
 * Prompt cho LLM nén context — chưng cất transcript cũ thành digest.
 * Ưu tiên giữ: file path + điểm chính, kết quả lệnh (pass/fail + SỐ LỖI),
 * quyết định đã chốt, việc đang dở. Bỏ: code trích dẫn, output chi tiết.
 * (Nguyên vẹn prompt tiếng Việt của goal-loop trước tách.)
 */
export function buildDigestPrompt(transcript: string): string {
  return `Bạn là hệ thống NÉN CONTEXT cho AI agent đang làm task dài hạn. Nén nhật ký làm việc dưới đây thành 1 DIGEST cô đọng (≤ ${DIGEST_MAX_CHARS} ký tự) để agent tiếp tục công việc mà KHÔNG mất thông tin cần thiết.

NHẬT KÝ (đã cắt bớt):
${transcript}

GIỮ LẠI (quan trọng giảm dần):
1. File đã đọc/sửa/tạo (đường dẫn) + điểm chính mỗi file (hàm/struct quan trọng, mục đích)
2. Lệnh/tool đã chạy + kết quả: pass/fail, exit code, SỐ LỖI cụ thể nếu có
3. Kết luận + quyết định kỹ thuật đã chốt; bug đã tìm thấy + nguyên nhân
4. Việc đang DỞ (làm đến đâu)
BỎ: nội dung file đầy đủ, code trích dẫn dài, output lệnh chi tiết, suy nghĩ thừa.

Output CHỈ digest (không preamble, không markdown fence), tiếng Việt, gọn theo bullet.`
}

/** Wrapper của digest message khi chèn vào transcript (nguyên văn goal-loop cũ) */
function buildDigestMessageContent(digest: string): string {
  return `📦 [WORKSPACE DIGEST — các bước TRƯỚC ĐÂY đã được NÉN để tiết kiệm budget token. Đây là TÓM TẮT công việc đã làm; nội dung gốc (file đã đọc, output lệnh) đã bỏ. Nếu cần chi tiết chính xác một file/lệnh cũ → gọi file_read/grep/shell LẠI.]\n\n${digest}`
}

/**
 * Heuristic fallback khi thiếu evidence log (workflow-engine không giữ evidence
 * array như goal-loop): suy xuất pseudo-evidence từ chính transcript — tool
 * message có JSON shape {tool, success, result} thì trích tên tool + trạng thái
 * + preview result; assistant message lấy preview text thuần.
 */
function deriveEvidenceFromMessages(msgs: CompressionMessage[]): CompressEvidenceEntry[] {
  const out: CompressEvidenceEntry[] = []
  for (const m of msgs) {
    if (m.role === 'tool') {
      let tool = ''
      let success: boolean | undefined
      let text = ''
      try {
        const parsed = JSON.parse(m.content) as { tool?: unknown; success?: unknown; result?: unknown }
        if (typeof parsed.tool === 'string') tool = parsed.tool
        if (typeof parsed.success === 'boolean') success = parsed.success
        if (parsed.result !== undefined) text = JSON.stringify(parsed.result)
      } catch {
        /* không phải JSON — dùng content thô */
      }
      out.push({
        kind: 'tool',
        tool: tool || 'tool',
        success,
        text: (text || m.content).replace(/\s+/g, ' ').slice(0, 160),
      })
    } else if (m.role === 'assistant' && m.content.trim()) {
      out.push({ kind: 'directive', text: m.content.replace(/\s+/g, ' ').slice(0, 160) })
    }
  }
  return out.slice(-40)
}

// ==================== CAP TOOL RESULT (tầng 1) ====================

/**
 * Cap tool result (JSON string) ở ~maxChars (mặc định 4000 — pattern 4k của
 * goal-loop). Cắt GIỮ ĐẦU 60% + CUỐI 40% vì lỗi của tsc/lint/test và dòng
 * tổng kết ("X errors, Y passed") thường nằm CUỐI output; cuối content gắn
 * marker chỉ dẫn agent đọc lại phần bị cắt qua file_read offset.
 *
 * @returns content đã cap + cờ truncated + tổng ký tự gốc (để receipt/log)
 */
export function capToolResult(
  content: string,
  maxChars: number = TOOL_RESULT_MAX_CHARS,
): { content: string; truncated: boolean; totalChars: number } {
  const totalChars = content.length
  if (totalChars <= maxChars) {
    return { content, truncated: false, totalChars }
  }
  // Pattern goal-loop smartTruncate: head 60% / tail 40% — marker ngắn ở giữa
  // (giữ lỗi + tổng kết cuối output), sau đó marker TRUNCATED ở CUỐI content
  // (chỉ dẫn đọc lại bằng file_read offset).
  const head = Math.floor(maxChars * 0.6)
  const tail = Math.max(200, maxChars - head - 200)
  const keptChars = head + tail
  const marker = `…[TRUNCATED ${keptChars}/${totalChars} chars — dùng file_read offset để đọc tiếp]`
  const output =
    content.slice(0, head) +
    `\n…[truncated ${totalChars - keptChars} chars giữa — giữ đầu + cuối vì lỗi/tổng kết thường nằm cuối output]…\n` +
    content.slice(-tail) +
    `\n${marker}`
  return { content: output, truncated: true, totalChars }
}

/**
 * SMART TRUNCATION — cắt giữ ĐẦU + CUỐI (60%/40%) cho VĂN BẢN THÔ (không phải
 * JSON). Lỗi của tsc/lint/test và dòng tổng kết ("X errors, Y passed") thường
 * nằm CUỐI output — cắt head-only làm mất đúng phần quan trọng nhất.
 * ROUND-27: chuyển từ agent-goal-loop.ts sang module dùng chung — hiện chỉ còn
 * là FALLBACK của truncateToolMessageJson khi cap quá nhỏ / serialize lỗi.
 * KHÔNG dùng trực tiếp cho tool message JSON — marker chứa \n thô làm VỠ cú pháp.
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

/**
 * ROUND-28 W2 — CORE envelope builder dùng chung 2 tầng (tool-message của
 * truncateToolMessageJson + tool-output của truncateToolOutputObject):
 * trả về OBJECT {_truncated, _originalChars, _note, head, tail} khớp ngân sách
 * `budget` (length của envelope JSON ≤ budget), hoặc null khi budget quá nhỏ
 * cho skeleton — caller tự fallback (smartTruncate / substring text cũ).
 * head/tail là string field escape chuẩn từ `serialized` (payload gốc) →
 * tầng nào truyền payload tầng đó được mô tả đúng (_originalChars = đúng
 * payload, KHÔNG lẫn wrapper nội bộ).
 */
function buildEnvelopeObject(
  serialized: string,
  budget: number,
): { _truncated: true; _originalChars: number; _note: string; head: string; tail: string } | null {
  if (budget < 300) return null // skeleton + head/tail tối thiểu không vừa — fallback
  let head = Math.floor(budget * 0.55)
  let tail = Math.max(200, Math.floor(budget * 0.3))
  const build = (): string =>
    JSON.stringify({
      _truncated: true,
      _originalChars: serialized.length,
      _note: `Kết quả thật ${serialized.length} ký tự — giữ ~55% đầu + ~30% đuôi (lỗi/tổng kết thường nằm cuối). Cần phần giữa → gọi lại tool với phạm vi hẹp hơn (path/depth/pattern/glob/head_limit/ignore...).`,
      head: serialized.slice(0, head),
      tail: serialized.slice(-tail),
    })
  let out = build()
  // envelope vẫn vượt budget (edge: budget rất nhỏ) → co head/tail theo tỉ lệ
  // rồi thử đúng 1 lần
  if (out.length > budget) {
    const overflow = out.length - budget
    head = Math.max(200, head - Math.ceil(overflow * 0.65))
    tail = Math.max(120, tail - Math.ceil(overflow * 0.35))
    out = build()
  }
  if (out.length > budget) return null
  try {
    return JSON.parse(out) as { _truncated: true; _originalChars: number; _note: string; head: string; tail: string }
  } catch {
    return null
  }
}

/**
 * ROUND-26 FIX B (mission cmupl7uen — Omega báo cáo "file_list PASS nhưng
 * không có dữ liệu hữu ích"): splice text cũ cắt GIỮA chuỗi JSON của tool
 * message rồi chèn marker chứa \n thô → chuỗi đẩy về LLM KHÔNG còn parse được
 * (thực tế 13:53: file_list 125k chars → message 11999 chars VỠ, agent đọc
 * được mảnh rời nhưng không trích xuất cấu trúc, kết luận "không có dữ liệu
 * hữu ích về tên file" → chu kỳ sau mất định hướng). Giờ: vượt cap → đóng
 * envelope JSON HỢP LỆ {tool, success, result: {_truncated, _originalChars,
 * _note, head, tail}} — head/tail là string field được escape chuẩn → LLM
 * LUÔN nhận JSON parse được, thấy rõ ~55% đầu + ~30% đuôi (lỗi/tổng kết thường
 * nằm cuối) + biết kích thước thật để gọi lại hẹp hơn.
 * Fallback (serialize lỗi / cap quá nhỏ) → giữ splice text cũ (smartTruncate).
 *
 * ROUND-27 FIX V1 — chuyển từ agent-goal-loop.ts sang module DÙNG CHUNG để
 * cả BA vòng lặp cùng một envelope: goal-loop (pushToolMessage — đã dùng từ
 * round-26), SUB-AGENT (subagent-delegate — round-26 BỎ SÓT: truncateResult
 * splice thẳng làm vỡ JSON mọi tool result > 8k chars cho MEGATRON/sub-agents
 * + trọng tài delegation đọc toolResultLog), workflow-engine (code-team —
 * round-26 bỏ sót: result lớn thành STRING chứa mảnh JSON vỡ). Tại đây không
 * circular import (context-compression chỉ phụ thuộc llm + crypto).
 *
 * ROUND-28 W2 — sizing CHÍNH XÁC qua buildEnvelopeObject: overhead wrapper
 * ({"tool":...,"success":...,"result": + }) tính đúng theo prefix thực tế →
 * tổng message ≤ cap NGUYÊN VẸN (không còn co xấp xỉ + thử lại như cũ).
 */
export function truncateToolMessageJson(
  entry: { tool: string; success: boolean; result: unknown },
  serialized: string,
  cap: number,
): string {
  try {
    // Guard — payload nằm dưới cap: trả NGUYÊN VĂN (caller chỉ gọi khi vượt
    // cap, nhưng hàm public + test gọi trực tiếp cần hành vi đúng).
    if (serialized.length <= cap) return serialized
    const prefix = `{"tool":${JSON.stringify(entry.tool)},"success":${entry.success},"result":`
    const overhead = prefix.length + 1 // + '}' đóng
    const envelope = buildEnvelopeObject(serialized, cap - overhead)
    if (!envelope) return smartTruncate(serialized, cap)
    return prefix + JSON.stringify(envelope) + '}'
  } catch {
    return smartTruncate(serialized, cap) // fail-open — splice text cũ
  }
}

/**
 * ROUND-28 W2 — envelope cho TOOL OUTPUT OBJECT (tầng tool-output, khác tầng
 * tool-message của truncateToolMessageJson): custom tool (agent tự tạo qua
 * create_custom_tool) trả OBJECT quá lớn thì custom-tool-registry trước đây
 * `serialized.substring(0, maxOutputLength)` — cắt giữa chuỗi JSON + append
 * marker text → result value là JSON VỠ không parse được (cùng lớp bug FIX B
 * round-26, site thứ 3 tìm thấy round-28). Giờ: result value là OBJECT envelope
 * {_truncated, _originalChars, _note, head, tail} — parse được, thấy đầu+cuối;
 * _originalChars/_note mô tả ĐÚNG payload (value), head/tail là mảnh value
 * thuần (không lẫn wrapper nội bộ). Value nằm dưới cap → trả NGUYÊN reference.
 * Fail-open: mọi lỗi / budget quá nhỏ → substring + marker text cũ.
 */
export function truncateToolOutputObject(value: unknown, maxChars: number): unknown {
  try {
    const valueSerialized = JSON.stringify(value)
    if (valueSerialized === undefined) {
      // value là function/undefined — JSON.stringify trả undefined
      return String(value).slice(0, maxChars) + '... [truncated]'
    }
    if (valueSerialized.length <= maxChars) return value
    const envelope = buildEnvelopeObject(valueSerialized, maxChars)
    if (envelope) return envelope
    return String(value).slice(0, maxChars) + '... [truncated]'
  } catch {
    return String(value).slice(0, maxChars) + '... [truncated]'
  }
}

// ==================== ROLLING COMPRESSION (tầng 2) ====================

/**
 * ROLLING CONTEXT COMPRESSION — nén segment cũ của messages thành 1 digest
 * message (bản tổng quát của compressHistory goal-loop, dùng chung cho cả
 * goal-loop và code-team workflow-engine).
 *
 * Nguyên tắc BẢO TOÀN:
 *   - KHÔNG đụng: mọi message index <= protectedStartIndex (system prompt,
 *     chat history, goal message / step instruction).
 *   - GIỮ NGUYÊN: keepRecent message gần nhất.
 *   - NÉN: toàn bộ assistant/tool ở giữa → 1 digest message (role user).
 *   - SPLICE THEO CẶP: assistant-with-tool_calls + tool replies liền sau là
 *     1 khối nguyên vẹn — biên nén tự co để KHÔNG bao giờ cắt một nửa cặp
 *     (chống lỗi API "tool_call_id not found" khi provider yêu cầu pairing).
 *
 * 2 lớp digest:
 *   1. LLM digest qua callUtilityLLM (~700 maxTokens/lần — rẻ, không đụng
 *      provider chính của agent).
 *   2. Fallback heuristic deterministic từ evidence log (param) hoặc suy xuất
 *      từ chính transcript nếu thiếu — LLM hỏng vẫn nén được.
 *
 * CI-3 B2 (Task 13-b) — KHO CONTEXT "đọc lại khi cần": khi nén THÀNH CÔNG và
 * caller truyền `archive` → digest được lưu vào TaskContextArchive (Prisma —
 * source of truth) + Qdrant task_context (best-effort embed) qua
 * archiveContext(@/lib/context-store) — dynamic import tránh circular import;
 * fire-and-forget fail-open (KHÔNG đợi archive xong, KHÔNG bao giờ làm fail
 * nén vì lỗi archive). Bỏ qua hoàn toàn khi thiếu archive param.
 *
 * Fail-open: mọi lỗi → return null (giữ nguyên messages như cũ, loop vẫn chạy).
 * Mutates messages in-place (splice).
 */
export async function compressConversation(params: {
  /** Message array của engine — mutate in-place (splice) */
  messages: CompressionMessage[]
  /** Mọi message index <= protectedStartIndex KHÔNG đụng (system + goal/step instruction) */
  protectedStartIndex: number
  /** Số message gần nhất giữ nguyên */
  keepRecent: number
  /** Evidence log (goal-loop) cho heuristic fallback — thiếu thì suy xuất từ transcript */
  evidence?: CompressEvidenceEntry[]
  /** Token của LLM digest cũng phải vào kế toán budget của caller */
  onTokens?: (tokens: number) => void
  /** Label task cho callUtilityLLM (log) — goal-loop truyền 'goal-loop-context-compression' */
  llmContext?: string
  /** Ngưỡng tối thiểu số message nén được — mặc định MIN_COMPRESSIBLE_MESSAGES */
  minCompressibleMessages?: number
  /** CI-3 B2: lưu digest vào Kho Context sau khi nén thành công (bỏ qua nếu thiếu) */
  archive?: {
    runId?: string | null
    sessionId?: string | null
    agentName?: string | null
  }
}): Promise<CompressionResult | null> {
  const { messages, keepRecent, evidence, onTokens, llmContext } = params
  const minCompressible = params.minCompressibleMessages ?? MIN_COMPRESSIBLE_MESSAGES

  const workStartRaw = Math.max(0, params.protectedStartIndex + 1)
  let workStart = workStartRaw
  let compressEnd = messages.length - keepRecent
  if (compressEnd <= workStart) return null

  // ---- SPLICE THEO CẶP: co biên để không cắt nửa cặp tool_call ----
  // (1) Đuôi: nếu compressEnd rơi GIỮA khối [assistant-with-tool_calls + tool
  // replies liền sau] → co compressEnd về đầu khối (giữ nguyên cả khối ở tail).
  for (let i = workStart; i < compressEnd; i++) {
    if (hasToolCalls(messages[i])) {
      let unitEnd = i + 1
      while (unitEnd < messages.length && messages[unitEnd].role === 'tool') unitEnd++
      if (unitEnd > compressEnd) {
        compressEnd = i
        break
      }
      i = unitEnd - 1 // đã xét trọn khối — nhảy qua
    }
  }
  // (2) Đầu: tool reply mang tool_call_id đứng đầu segment → assistant cha nằm
  // TRƯỚC segment (vùng bảo vệ) — bỏ qua nhóm tool replies này (không nén) để
  // không mồ côi cặp. (Goal-loop tool message không có tool_call_id → khối này
  // không chạy, hành vi giữ nguyên như cũ.)
  while (
    workStart < compressEnd &&
    messages[workStart].role === 'tool' &&
    typeof messages[workStart].tool_call_id === 'string' &&
    messages[workStart].tool_call_id !== ''
  ) {
    workStart++
  }

  if (compressEnd - workStart < minCompressible) return null // segment quá nhỏ — không đáng nén

  const compressible = messages.slice(workStart, compressEnd)
  const removedChars = compressible.reduce((s, m) => s + m.content.length, 0)
  if (removedChars < COMPRESS_THRESHOLD_CHARS) return null // segment nén được chưa đủ lớn
  if (removedChars - DIGEST_MAX_CHARS < DIGEST_MAX_CHARS * 2) return null // tiết kiệm < 2× digest — không đáng tốn 1 LLM call

  // Transcript đầu vào cho LLM nén (cap COMPRESS_INPUT_CHARS)
  let transcript = ''
  for (const m of compressible) {
    const label = m.role === 'assistant' ? 'ASSISTANT' : m.role === 'tool' ? 'TOOL RESULT' : 'USER'
    transcript += `[${label}] ${m.content.slice(0, 1800)}\n`
    if (transcript.length >= COMPRESS_INPUT_CHARS) break
  }

  // ===== Lớp 1: LLM digest (utility core) =====
  let digest = ''
  let method: 'llm' | 'heuristic' = 'llm'
  try {
    const res = await withTimeout(
      callUtilityLLM(buildDigestPrompt(transcript), undefined, llmContext || 'context-compression', {
        temperature: 0.2,
        // TASK 55: 700 → 2000. Trước đây model utility là nemotron-lightning
        // (không reasoning) nên 700 đủ. Giờ space-bunny-free (reasoning model,
        // effort low) cần chừa headroom cho reasoning tokens + digest trọn vẹn
        // (verified: effort low + mt700 → finish=length, digest bị cắt giữa
        // chừng 1236 chars; mt2000 → dư dả, vẫn rẻ).
        maxTokens: 2000,
      }),
      DIGEST_LLM_TIMEOUT_MS,
      'Context compression LLM',
    )
    if (res?.content && res.content.trim().length > 50) {
      digest = res.content.trim()
      if (typeof res.tokensUsed === 'number' && res.tokensUsed > 0) onTokens?.(res.tokensUsed)
    }
  } catch {
    /* fall-through heuristic */
  }

  // ===== Lớp 2: heuristic fallback từ evidence log (deterministic, 0 LLM) =====
  // Caller truyền evidence (kể cả rỗng — goal-loop giữ nguyên hành vi cũ:
  // evidence rỗng → digest rỗng → return null); KHÔNG truyền → suy xuất từ
  // chính transcript (workflow-engine không giữ evidence log).
  if (!digest) {
    method = 'heuristic'
    const evidenceSource = evidence ? evidence.slice(-40) : deriveEvidenceFromMessages(compressible)
    digest = evidenceSource
      .map(e => (e.kind === 'tool' ? `- [${e.tool}] ${e.success ? '✓' : '✗'} ${e.text}` : `- ${e.text}`))
      .join('\n')
      .slice(0, DIGEST_MAX_CHARS)
  } else if (digest.length > DIGEST_MAX_CHARS) {
    digest = digest.slice(0, DIGEST_MAX_CHARS) + '…'
  }

  if (!digest) return null

  // ===== SUMMARIZER RECEIPT (Task 42) =====
  // Biên lai của lần tóm tắt: hash đầu vào (transcript đã nén) + hash đầu ra
  // (digest) + metadata phạm vi nén — giúp trace/audit được nội dung nào đã
  // được thay bằng digest (chống "nén xong mất dấu"). Fail-safe tuyệt đối:
  // createHash là thuần synchronous CPU, không thể fail theo ngữ cảnh thường.
  const sha12 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 12)
  const receipt =
    `🧾 DIGEST RECEIPT sha256(in)=${sha12(transcript)} sha256(out)=${sha12(digest)}` +
    ` · nén ${compressible.length} messages (#${workStart}–#${compressEnd - 1})` +
    ` · ${removedChars}→${digest.length} chars · method=${method}`

  const digestMessage: CompressionMessage = {
    role: 'user',
    content: `${buildDigestMessageContent(digest)}\n\n${receipt}`,
  }

  messages.splice(workStart, compressEnd - workStart, digestMessage)

  // ===== CI-3 B2 — writer hook: lưu digest vào Kho Context (đọc lại khi cần) =====
  // Fire-and-forget: KHÔNG đợi archive xong (embed Qdrant có thể chậm/fail —
  // nén không được phép block vì layer tối ưu này); dynamic import tránh
  // circular import; fail-open tuyệt đối (archiveContext tự try/catch bên
  // trong, KHÔNG bao giờ throw). Bỏ qua hoàn toàn khi caller không truyền archive.
  if (params.archive) {
    try {
      void import('@/lib/context-store')
        .then(({ archiveContext }) => archiveContext({
          runId: params.archive?.runId ?? null,
          sessionId: params.archive?.sessionId ?? null,
          agentName: params.archive?.agentName ?? null,
          kind: 'digest',
          content: digest,
          tags: 'rolling-digest',
        }))
        .catch(() => { /* fail-open — archive là tối ưu, không bắt buộc */ })
    } catch { /* fail-open — dynamic import lỗi không được phép làm hỏng nén */ }
  }

  return {
    digest,
    digestChars: digestMessage.content.length,
    savedChars: removedChars - digestMessage.content.length,
    method,
    receipt,
  }
}
