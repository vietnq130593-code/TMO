/**
 * Shared Tool Call Parsing & Message Formatting Utilities
 *
 * Extracted from workflow-engine.ts so they can be reused by:
 *   - Code Team Workflow Engine (original consumer)
 *   - OpenClaw Chat ReAct loop (standalone agents like Omega)
 *
 * parseToolCallsFromOutput: Parses tool_call patterns from LLM text output
 * formatMessagesForLLM: Formats conversation messages into a single prompt string
 * detectBrokenToolCallHint: 21-d — phát hiện tool call bị cắt cụt/JSON lỗi
 *   (parse thất bại) để caller đẩy feedback cho LLM thử lại thay vì bỏ im lặng.
 */

// FIX 2026-08-29: import from the standalone pure-utility module instead of the
// heavy worklog.ts (which pulls Prisma DB + full agents registry into the chat
// route's module graph, and breaks the build when worklog.ts is missing from a
// partial checkout — "Module not found: Can't resolve '@/lib/code-team/worklog'")
import { findBalancedJson as findBalancedJsonUtil } from '@/lib/code-team/find-balanced-json'

/** Parsed tool call (shape giữ nguyên backward-compat cho mọi caller hiện có). */
export interface ParsedToolCall {
  id: string
  name: string
  args: Record<string, unknown>
  /** ROUND-50 (P2-δ r49): native tool_call args bị cắt cụt (JSON.parse fail
   * sau cả loose-repair) — giữ nguyên văn chuỗi args hỏng để caller PHẢN HỒI
   * lại cho LLM (yêu cầu phát lại hoàn chỉnh) thay vì thực thi với args rỗng
   * (bằng chứng r49: read_skill args truncated → {} → schema "thiếu slug" →
   * agent không đọc được skill agent-browser). */
  rawArgs?: string
}

/**
 * Kết quả parse kèm diagnostics (21-d): calls là các tool call parse thành công;
 * parseFailures đếm các vị trí CÓ dấu hiệu tool call nhưng parse thất bại
 * (findBalancedJson null — JSON cắt cụt giữa chừng, hoặc JSON.parse throw).
 */
export interface ToolCallParseResult {
  calls: ParsedToolCall[]
  parseFailures: number
}

/**
 * FIX (2026-09-03, Task 24 — quan sát agents chạy SELF-DIRECTION E2E): LLM
 * (glm-4-plus qua ZAI) phát JSON args với lỗi cú pháp rất phổ biến khi nội dung
 * là CODE nhiều dòng: (a) newline/tab THẬT nằm trong string (JSON chuẩn phải
 * escape \\n), (b) trailing comma trước }/]. Trước đây JSON.parse throw → tool
 * call bị DROP im lặng → ReAct loop coi output là "báo cáo cuối" → agent tưởng
 * đã ghi file, evaluator thấy 0 file_write → step fail (đề xuất "Mở rộng thư
 * viện kỹ năng" fail 2 lần chạy vì đúng cơ chế này). repair pass: escape control
 * chars trong string + strip trailing comma (string-aware, không đụng nội dung
 * string) — fail-open, parse được thì dùng, không thì giữ đếm failure như cũ.
 */
/**
 * TASK 43 — export cho workflow-engine (parser bản địa của nó thiếu lớp
 * loose-repair này: JSON args bị dính raw newline/tab trong chuỗi hoặc dấu
 * phẩy thừa → JSON.parse thuần fail → tool call bị BỎ QUA im lặng).
 */
export function tryParseLooseJson(raw: string): Record<string, unknown> | null {
  try {
    const obj = JSON.parse(raw)
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : null
  } catch { /* rơi xuống repair */ }
  try {
    const escaped = escapeRawControlCharsInStrings(raw)
    const cleaned = stripTrailingCommasStringAware(escaped)
    const obj = JSON.parse(cleaned)
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : null
  } catch {
    return null
  }
}

/** Escape newline/CR/tab/control chars THẬT nằm trong string literal của JSON. */
function escapeRawControlCharsInStrings(raw: string): string {
  let out = ''
  let inString = false
  let escape = false
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]
    if (escape) { out += ch; escape = false; continue }
    if (ch === '\\' && inString) { out += ch; escape = true; continue }
    if (ch === '"') { inString = !inString; out += ch; continue }
    if (inString) {
      if (ch === '\n') { out += '\\n'; continue }
      if (ch === '\r') { out += '\\r'; continue }
      if (ch === '\t') { out += '\\t'; continue }
      const code = ch.charCodeAt(0)
      if (code < 0x20) { out += `\\u${code.toString(16).padStart(4, '0')}`; continue }
    }
    out += ch
  }
  return out
}

/** Xóa trailing comma TRƯỚC }/] — chỉ ngoài string (string-aware). */
function stripTrailingCommasStringAware(raw: string): string {
  let out = ''
  let inString = false
  let escape = false
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]
    if (escape) { out += ch; escape = false; continue }
    if (ch === '\\' && inString) { out += ch; escape = true; continue }
    if (ch === '"') { inString = !inString; out += ch; continue }
    if (!inString && ch === ',') {
      let j = i + 1
      while (j < raw.length && /\s/.test(raw[j])) j++
      if (j < raw.length && (raw[j] === '}' || raw[j] === ']')) continue // bỏ comma
    }
    out += ch
  }
  return out
}

/**
 * FIX (2026-09-03, Task 24): format "fence-block" cho file_write — giải quyết
 * gốc rác việc nhét CODE vào JSON string (phải escape \\n + mọi dấu " trong
 * code — Python docstring """""""", JS string... gãy JSON gần như 100% với LLM).
 * Format mới (system prompt hướng dẫn):
 *   tool_call: file_write({"path": "skills/x.py", "mode": "overwrite"})
 *   ```python
 *   <nội dung file GỐC — nhiều dòng, quote tự do, KHÔNG cần escape>
 *   ```
 * Trích args JSON ngắn (không content) + fence ngay sau dấu ) — content lấy
 * thẳng từ fence. Trả về text đã cắt vùng đó để main loop không xử lý lần nữa.
 */
function extractFencedFileWrites(output: string): { calls: ParsedToolCall[]; cleaned: string; failures: number } {
  const calls: ParsedToolCall[] = []
  const ranges: Array<[number, number]> = []
  let failures = 0
  const fenceRe = /tool_call:\s*file_write\s*\(\s*\{/g
  let m
  while ((m = fenceRe.exec(output)) !== null) {
    const braceStart = output.indexOf('{', m.index + m[0].length - 1)
    if (braceStart === -1) continue
    const jsonStr = findBalancedJsonUtil(output.slice(braceStart), '')
    if (!jsonStr) continue // để main loop đếm failure (cắt cụt args)
    const args = tryParseLooseJson(jsonStr)
    if (!args || typeof args.path !== 'string' || args.content !== undefined) continue
    // Tìm dấu ) đóng tool_call ngay sau args JSON (chỉ whitespace được phép)
    let parenEnd = -1
    for (let i = braceStart + jsonStr.length; i < output.length; i++) {
      if (output[i] === ')') { parenEnd = i; break }
      if (!/\s/.test(output[i])) break
    }
    if (parenEnd === -1) continue
    // Ngay sau ) phải là fence mở (``` + tuỳ chọn language tag)
    const rest = output.slice(parenEnd + 1)
    const fenceOpen = /^\s*```[^\n]*\n/.exec(rest)
    if (!fenceOpen) continue
    const contentStart = parenEnd + 1 + fenceOpen[0].length
    const closeIdx = output.indexOf('```', contentStart)
    if (closeIdx === -1) {
      // Fence không đóng (output cắt cụt vì maxTokens) → đếm failure + cắt sạch
      // phần này để main loop không đếm trùng.
      failures++
      ranges.push([m.index, output.length])
      continue
    }
    let content = output.slice(contentStart, closeIdx)
    if (content.endsWith('\n')) content = content.slice(0, -1)
    calls.push({
      id: nextToolCallId(),
      name: 'file_write',
      args: { ...args, content },
    })
    ranges.push([m.index, closeIdx + 3])
  }
  // Cắt các vùng đã xử lý (từ cuối về đầu giữ index ổn định)
  let cleaned = output
  for (let i = ranges.length - 1; i >= 0; i--) {
    const [start, end] = ranges[i]
    cleaned = cleaned.slice(0, start) + ' ' + cleaned.slice(end)
  }
  return { calls, cleaned, failures }
}

/**
 * ROUND-44 FIX (c) — DANH SÁCH tool name hợp lệ dùng chung (pattern 2 +
 * invoke-recovery). Trước đây lặp inline 2 nơi (tool-calls.ts + workflow-engine.ts)
 * — dễ lệch khi thêm tool mới.
 */
const KNOWN_TOOL_NAMES = ['opencode', 'knowledge_search', 'knowledge_graph', 'knowledge_write', 'tavily', 'serper', 'jina', 'file_read', 'file_edit', 'file_multi_edit', 'file_write', 'file_delete', 'file_list', 'grep', 'run_tests', 'git_commit', 'git_push', 'git_pull', 'get_diagnostics', 'decompose_task', 'create_task', 'update_task', 'get_plan', 'summarize', 'synthesize', 'run_bg', 'read_output', 'kill_process', 'manage_packages', 'gateway_tool', 'shell', 'todo_write', 'todo_read', 'hypothesis_write', 'list_skills', 'read_skill', 'mcp_list_servers', 'web_search', 'web_fetch', 'gateway_exec', 'gateway_read', 'gateway_write', 'gateway_edit', 'gateway_apply_patch', 'lsp_diagnostics', 'browser_screenshot', 'lint', 'type_check', 'test_coverage', 'db_query', 'mcp_call', 'exit_plan_mode', 'cron', 'start_preview', 'stop_preview', 'get_app_runtime_status', 'create_custom_tool', 'delete_custom_tool', 'list_custom_tools', 'manage_tools',
  // FIX 2026-09-15 #7 (P4 — audit Team Code): bổ sung tool mới thiếu trong
  // danh sách regex (mirror workflow-engine.ts) — agent phát tên_tool({...})
  // trực tiếp giờ được parse đúng thay vì bị bỏ lỡ → tự bịa output.
  'git_status', 'git_diff', 'git_log', 'git_branch', 'context_recall',
  'escalate_problem', 'propose_automation', 'verify_and_push',
  'delegate_task', 'request_code_team', 'dispatch_agent', 'dispatch_agents_parallel',
  'create_agent', 'manage_automation',
  // P5/P8 (2026-11) — run_gate (gate receipt sha256) + work_data (CRUD dữ
  // liệu công việc DB)
  // ROUND-46 review-fix (5d): bổ sung 2 tool đã đăng ký ở tool-executor
  // (open_workspace, git_clone) nhưng thiếu ở đây — đánh giá round-46 phát
  // hiện pattern-2 + invoke-recovery bỏ lỡ 2 tool này (drift đúng dạng mà
  // việc hợp nhất round-44 định dẹp).
  'run_gate', 'work_data', 'open_workspace', 'git_clone']
const KNOWN_TOOL_NAME_SET = new Set(KNOWN_TOOL_NAMES)

/**
 * ROUND-46 review-fix (5c): id tool_call duy nhất toàn tiến trình — trước đây
 * cả 4 extractor (fence/invoke/pattern-1/pattern-2) mỗi bên tự đánh số từ 0
 * với cùng Date.now() → 1 output chứa fence call + invoke call có THỂ trùng
 * id trong cùng conversation (đánh giá round-46 phát hiện). Counter đơn điệu
 * module-scope loại trừ tuyệt đối trùng lặp (kể cả parse khác nhau cùng ms).
 */
let toolCallIdSeq = 0
function nextToolCallId(): string {
  return `tc_${Date.now()}_${toolCallIdSeq++}`
}

// ==================== ROUND-44 FIX (c) — PROVIDER GARBLE + INVOKE RECOVERY ====================

/**
 * ROUND-44 FIX (c-recovery, tầng 2) — coerce giá trị XML-tag: nguyên thủy
 * (number/bool/null) → JSON (nếu mở bằng {/[ ) → XML LỒNG (recurve — giá trị
 * chứa tag con; toàn bộ tag con CÙNG tên vd <item>×N → ARRAY) → string.
 * Bằng chứng v2 (job cmuw8c5pd…): `<todos><item>…</item>×N</todos>` bị ép
 * thành string → todo_write exec fail "tham số todos sai kiểu — cần array".
 */
function coerceXmlValue(raw: string): unknown {
  const t = raw.trim()
  if (t === '') return raw
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t)
  if (t === 'true') return true
  if (t === 'false') return false
  if (t === 'null') return null
  if (t.startsWith('{') || t.startsWith('[')) {
    // Giá trị JSON thuần (OBJECT hoặc ARRAY — tryParseLooseJson chỉ nhận object)
    // → loose-repair (newline thô/trailing comma) rồi parse
    try {
      return JSON.parse(t) as unknown
    } catch { /* rơi xuống repair */ }
    try {
      const repaired = stripTrailingCommasStringAware(escapeRawControlCharsInStrings(t))
      return JSON.parse(repaired) as unknown
    } catch { /* giữ string */ }
  }
  if (/^<[A-Za-z_]/.test(t)) {
    const nested = parseXmlTagArgs(t)
    if (nested) {
      // <todos><item>…</item><item>…</item></todos> → {item: [a, b]} →
      // unwrap thành ARRAY [a, b] (đúng schema todo_write/… cần mảng)
      const keys = Object.keys(nested)
      if (keys.length === 1 && Array.isArray(nested[keys[0]])) return nested[keys[0]]
      return nested
    }
  }
  return raw
}

/**
 * Parse chuỗi gồm các tag liên tiếp `<key>value</key>…` thành object.
 * Key LẶP (vd `<item>`×N) → gom thành ARRAY (bằng chứng v2: todo_write
 * `<todos><item>…</item><item>…</item></todos>` cần array các item).
 * Trả null khi không khớp tag nào (caller giữ giá trị gốc).
 */
function parseXmlTagArgs(text: string): Record<string, unknown> | null {
  const collected = new Map<string, unknown[]>()
  let pos = 0
  let any = false
  while (pos < text.length) {
    const m = /^<([A-Za-z_][\w-]*)>([\s\S]*?)<\/\1>\s*/.exec(text.slice(pos))
    if (!m) break
    const list = collected.get(m[1]) || []
    list.push(coerceXmlValue(m[2]))
    collected.set(m[1], list)
    any = true
    pos += m[0].length
  }
  if (!any) return null
  const out: Record<string, unknown> = {}
  for (const [k, vs] of collected.entries()) {
    out[k] = vs.length === 1 ? vs[0] : vs
  }
  return out
}

/**
 * Marker corruption của provider (chat-template leak): chuỗi dạng
 * `]<]namespace[>[` (vd `]<]minimax[>[` lặp dày đặc — bằng chứng job
 * cmuw7to9e… r44: toàn bộ output Omega bị bọc marker này). HTTP 200 nhưng
 * nội dung gần như không đọc được nếu không strip. Regex ăn CẢ cặp ngoặc
 * bao quanh `]`…`[` + tối đa 1 ký tự whitespace mỗi bên — tránh để lại mảnh
 * `][` rời rạc kẹt giữa invoke-tag và args (bug phát hiện qua unit test C1/C2).
 * Output SẠCH (0 marker) → regex không khớp chỗ nào → zero tác động phụ.
 */
const PROVIDER_GARBLE_MARKER_RE = /\]?\s?<\][^\]\s]{1,24}\[>\[?\s?/g

export function countProviderGarbleMarkers(content: string): number {
  return (content.match(PROVIDER_GARBLE_MARKER_RE) || []).length
}

export function stripProviderGarbleMarkers(content: string): string {
  return content.replace(PROVIDER_GARBLE_MARKER_RE, '')
}

/**
 * ROUND-44 FIX (c-recovery) — parse format `<invoke name="tool">` của minimax.
 *
 * Bằng chứng r44 (goal-loop job cmuw7to9e…, Omega): model phát tool call dưới
 * dạng `<invoke name="functions.request_code_team">{"task":…}` và
 * `<invoke name="request_code_team"><task>…</task><context>…</context>…</invoke>`
 * — Ý ĐỊNH + ARGS ĐẦY ĐỦ nhưng format không khớp `tool_call: name({...})` →
 * parser cũ trả 0 call → 4 chu kỳ planning-only đốt 267K tokens → stall brake
 * cắt no_progress (đúng pattern TEST A round-43). Giờ: strip marker rác +
 * công nhận cả 2 dạng args (JSON object ngay sau tag / XML tags <key>value</key>).
 * Tool name phải nằm trong whitelist (chống hallucinate); prefix `functions.`
 * (OpenAI-style namespace) được lược bỏ.
 */
function extractInvokeToolCalls(output: string): { calls: ParsedToolCall[]; cleaned: string; failures: number } {
  if (output.indexOf('<invoke') === -1) return { calls: [], cleaned: output, failures: 0 }
  const calls: ParsedToolCall[] = []
  const ranges: Array<[number, number]> = []
  // ROUND-46 vòng 2b: skip-ranges (chống parse nhúng) TÁCH khỏi ranges (cắt
  // cleaned cho pattern-1/2) — shadow range của vùng parse-FAIL KHÔNG được
  // cắt khỏi cleaned: bên trong có thể còn dòng `tool_call: x({...})` định
  // dạng pattern-1 cần phục hồi (mixed-format recovery giữ nguyên hành vi cũ).
  const skipRanges: Array<[number, number]> = []
  let failures = 0
  const re = /<invoke\s+name\s*=\s*"?([A-Za-z_][\w.-]*)"?\s*>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(output)) !== null) {
    // ROUND-46 review-fix (5a): match nổ TRONG args của invoke đã đo hệm ở
    // trước (agent ghi file chứa VÍ DỤ `<invoke name="shell">…` — dogfooding
    // thật của app này) KHÔNG phải tool call thật → skip. re.lastIndex không
    // nhả qua vùng consumed nên phải tự kiểm tra từng span (regex chỉ đi tới).
    if (skipRanges.some(([s, e]) => m!.index >= s && m!.index < e)) continue
    let toolName = m[1]
    if (toolName.startsWith('functions.')) toolName = toolName.slice('functions.'.length)
    if (!KNOWN_TOOL_NAME_SET.has(toolName)) continue // tên bịa — KHÔNG execute
    const afterTag = output.slice(m.index + m[0].length)
    // Bỏ qua junk prefix (whitespace + mảnh ngoặc rơi `][` của marker đã strip
    // nhưng thiếu cặp bao quanh) — tối đa 8 ký tự, chỉ brackets/whitespace.
    const junkM = /^[\s\]\[]{0,8}/.exec(afterTag)
    const junkLen = junkM ? junkM[0].length : 0
    const leadingWs = junkLen
    const trimmed = afterTag.slice(leadingWs)
    let args: Record<string, unknown> | null = null
    let consumed = 0
    if (trimmed.startsWith('{')) {
      // Form A: JSON object ngay sau tag — dùng balanced-json + loose-repair
      const jsonStr = findBalancedJsonUtil(trimmed, '')
      if (jsonStr) {
        args = tryParseLooseJson(jsonStr)
        if (!args) failures++
        else consumed = leadingWs + jsonStr.length
      } else {
        failures++ // JSON bị cắt cụt giữa chừng
      }
    } else {
      // Form B: XML-ish tags <key>value</key>… (value nhiều dòng + LỒNG:
      // <todos><item>…</item>×N</todos> → array) — parseXmlTagArgs tái sử dụng
      // lớp coerce (ROUND-44 tầng 2 — fix todo_write exec fail "cần array")
      const argsObj = parseXmlTagArgs(trimmed)
      if (argsObj && Object.keys(argsObj).length > 0) {
        args = argsObj
        // consumed = toàn bộ vùng tag đã khớp: tính lại bằng regex chạy lần 2
        let pos = 0
        for (;;) {
          const tm = /^<([A-Za-z_][\w-]*)>([\s\S]*?)<\/\1>\s*/.exec(trimmed.slice(pos))
          if (!tm) break
          pos += tm[0].length
        }
        consumed = leadingWs + pos
      } else {
        failures++
      }
    }
    if (args && Object.keys(args).length > 0) {
      calls.push({
        id: nextToolCallId(),
        name: toolName,
        args,
      })
      ranges.push([m.index, m.index + m[0].length + consumed])
      skipRanges.push([m.index, m.index + m[0].length + consumed])
      // Tiếp tục quét sau vùng đã dùng (một output có thể chứa nhiều invoke)
    } else {
      // ROUND-46 review-fix (vòng 2 — 5b mở rộng): parse args FAIL → vẫn đánh
      // SHADOW range (tag mở → thẻ </invoke> đóng gần nhất) để invoke VÍ DỤ
      // lồng trong vùng args hỏng KHÔNG bị parse + execute thay thế (đánh giá
      // vòng 2: trước đây chỉ vùng parse THÀNH CÔNG mới được bảo vệ — model
      // gửi file_write chứa ví dụ invoke với JSON hỏng → ví dụ shell vẫn chạy).
      const closeRel = output.indexOf('</invoke>', m.index)
      const shadowEnd = closeRel === -1 ? m.index + m[0].length : closeRel + '</invoke>'.length
      skipRanges.push([m.index, shadowEnd])
    }
  }
  // Cắt các vùng đã parse (từ cuối về đầu giữ index ổn định)
  let cleaned = output
  for (let i = ranges.length - 1; i >= 0; i--) {
    const [s, e] = ranges[i]
    cleaned = cleaned.slice(0, s) + ' ' + cleaned.slice(e)
  }
  return { calls, cleaned, failures }
}

/**
 * ROUND-54 FIX E — parse format Anthropic-style `<tool_name>X</tool_name>`
 * + `<parameters>…</parameters>` (kèm nhánh mangled "invoke\n<tool_name>…").
 *
 * Bằng chứng r54 (user dán nguyên văn thought của agent):
 *   `lét\ninvoke\n<tool_name>todo_read</tool_name><parameters><sessionId>sess_…
 *   </sessionId><agentRole>G2-A</agentRole></parameters>` — Ý ĐỊNH + ARGS ĐẦY ĐỦ
 *   nhưng không khớp format nào hệ thống nhận (regex invoke cần name=; pattern-1
 *   cần tiền tố `tool_call:`) → 0 tool call thực thi, nguyên văn markup dồn
 *   vào thought content + agent lặp đoán mò (user: "tưởng xử lý từ trước rồi
 *   hóa ra vẫn còn"). Giờ: công nhận format này — params JSON hoặc XML-tag,
 *   có/không có vỏ <parameters>; name phải qua whitelist (chống hallucinate);
 *   prefix `functions.` (OpenAI-style namespace) được lược bỏ — mirror
 *   extractInvokeToolCalls. Params bị cắt cụt giữa chừng KHÔNG đếm failures
 *   chung — để detector fallback `<tool_name>` bắt và trả
 *   MALFORMED_INVOKE_FEEDBACK (dạy đúng 3 cú pháp của NHÓM này, kể cả nhắc
 *   "cắt args ngắn nếu bị cắt cụt" — BROKEN chung chỉ dạy fence file_write,
 *   lệch nhóm).
 */
function extractToolNameTagCalls(output: string): { calls: ParsedToolCall[]; cleaned: string; failures: number } {
  if (output.indexOf('<tool_name>') === -1) return { calls: [], cleaned: output, failures: 0 }
  const calls: ParsedToolCall[] = []
  const ranges: Array<[number, number]> = []
  const skipRanges: Array<[number, number]> = []
  const re = /<tool_name>\s*([A-Za-z_][\w.-]*)\s*<\/tool_name>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(output)) !== null) {
    // ROUND-46 5a mirror: match nổ trong vùng invoke/tool_name đã đo hệm → skip
    if (skipRanges.some(([s, e]) => m!.index >= s && m!.index < e)) continue
    let toolName = m[1]
    if (toolName.startsWith('functions.')) toolName = toolName.slice('functions.'.length)
    if (!KNOWN_TOOL_NAME_SET.has(toolName)) continue // tên bịa — KHÔNG execute
    const afterTag = output.slice(m.index + m[0].length)
    // Bỏ junk prefix (whitespace + mảnh ngoặc rơi của marker đã strip) ≤ 8 ký tự
    const junkM = /^[\s\]\[]{0,8}/.exec(afterTag)
    const leadingWs = junkM ? junkM[0].length : 0
    const trimmed = afterTag.slice(leadingWs)
    let args: Record<string, unknown> | null = null
    let consumed = 0
    const paramsOpenM = /^<parameters>\s*/.exec(trimmed)
    if (paramsOpenM) {
      // Có vỏ <parameters>…</parameters>: nội dung bên trong là JSON hoặc XML
      const innerStart = paramsOpenM[0].length
      const closeRel = trimmed.indexOf('</parameters>', innerStart)
      const inner = closeRel === -1 ? trimmed.slice(innerStart) : trimmed.slice(innerStart, closeRel)
      const innerTrim = inner.trim()
      if (innerTrim.startsWith('{')) {
        const jsonStr = findBalancedJsonUtil(inner, '')
        if (jsonStr) {
          args = tryParseLooseJson(jsonStr)
        }
        // JSON cắt cụt / parse fail → KHÔNG đếm failures — detector fallback
        // `<tool_name>` sẽ trả MALFORMED_INVOKE_FEEDBACK dạy lại đúng nhóm cú pháp
      } else {
        const argsObj = parseXmlTagArgs(inner)
        if (argsObj && Object.keys(argsObj).length > 0) args = argsObj
        // params rỗng/không khớp tag → KHÔNG đếm failures — fallback detector
      }
      // consumed: tính đến cuối vỏ parameters (hoặc hết chuỗi nếu thiếu vỏ đóng)
      consumed = leadingWs + (closeRel === -1 ? trimmed.length : closeRel + '</parameters>'.length)
    } else if (trimmed.startsWith('{')) {
      // JSON trực tiếp sau </tool_name> (không có vỏ parameters)
      const jsonStr = findBalancedJsonUtil(trimmed, '')
      if (jsonStr) {
        args = tryParseLooseJson(jsonStr)
        if (args) consumed = leadingWs + jsonStr.length
      }
    } else {
      // XML tags trực tiếp <key>value</key>… (không có vỏ parameters) — mirror
      // invoke Form B; consumed = toàn bộ vùng tag khớp (tính lại lần 2)
      const argsObj = parseXmlTagArgs(trimmed)
      if (argsObj && Object.keys(argsObj).length > 0) {
        args = argsObj
        let pos = 0
        for (;;) {
          const tm = /^<([A-Za-z_][\w-]*)>([\s\S]*?)<\/\1>\s*/.exec(trimmed.slice(pos))
          if (!tm) break
          pos += tm[0].length
        }
        consumed = leadingWs + pos
      }
      // params vắng hoàn toàn (cut sớm) → KHÔNG đếm failures — fallback detector
    }
    if (args && Object.keys(args).length > 0) {
      calls.push({ id: nextToolCallId(), name: toolName, args })
      ranges.push([m.index, m.index + m[0].length + consumed])
      skipRanges.push([m.index, m.index + m[0].length + consumed])
    } else {
      // ROUND-46 5b mirror: parse FAIL → shadow range (tag mở → vỏ đóng gần
      // nhất) chống parse nhúng invoke/tool_name VÍ DỤ nồng trong vùng hỏng
      const closeRel = output.indexOf('</parameters>', m.index)
      const shadowEnd = closeRel === -1 ? m.index + m[0].length : closeRel + '</parameters>'.length
      skipRanges.push([m.index, shadowEnd])
    }
  }
  // Cắt vùng đã parse (từ cuối về đầu giữ index ổn định) — pattern 1/2 không
  // quét lại vùng này
  let cleaned = output
  for (let i = ranges.length - 1; i >= 0; i--) {
    const [s, e] = ranges[i]
    cleaned = cleaned.slice(0, s) + ' ' + cleaned.slice(e)
  }
  return { calls, cleaned, failures: 0 }
}

/**
 * Parse tool_call patterns from LLM text output (kèm đếm parse failures).
 *
 * Supported formats:
 * 1. tool_call: function_name({...}) — args JSON loose-repaired (newline thô,
 *    trailing comma — Task 24)
 * 2. Direct invocation like opencode({action: "read", path: "..."})
 * 3. file_write fence-block: tool_call: file_write({"path": ...}) + ```fence```
 *    (Task 24 — code nhiều dòng không cần escape)
 * 4. ROUND-44 (c): `<invoke name="tool">` của minimax (JSON args hoặc XML
 *    tags args) + strip marker corruption `<]xxx[>` của provider trước khi parse
 * 5. ROUND-54 (E): `<tool_name>tool</tool_name><parameters>…</parameters>`
 *    Anthropic-style (JSON hoặc XML-tag params; có/không vỏ parameters)
 */
export function extractToolCallsWithDiagnostics(rawOutput: string): ToolCallParseResult {
  // ROUND-44 FIX (c): strip marker rác của provider TRƯỚC mọi parse — marker
  // chen giữa `tool_call: x({...})` cũng làm regex cũ miss.
  const output = stripProviderGarbleMarkers(rawOutput)
  const { calls: fenceCalls, cleaned: afterFence, failures: fenceFailures } = extractFencedFileWrites(output)
  // ROUND-44 FIX (c): invoke-recovery chạy TRƯỚC regex (format đặc thù, không
  // đụng pattern 1/2); vùng đã parse bị cắt khỏi chuỗi regex quét tiếp.
  const invokeRes = extractInvokeToolCalls(afterFence)
  // ROUND-54 FIX E: tool_name-tag recovery chạy sau invoke (cùng lớp đặc thù)
  const tntRes = extractToolNameTagCalls(invokeRes.cleaned)
  const calls: ParsedToolCall[] = [...fenceCalls, ...invokeRes.calls, ...tntRes.calls]
  let parseFailures = fenceFailures + invokeRes.failures + tntRes.failures
  const cleaned = tntRes.cleaned

  // Pattern 1: tool_call: function_name({...})
  // Use findBalancedJson for nested JSON args (e.g., opencode write with content containing code)
  const regex1 = /tool_call:\s*(\w+)\s*\(\s*\{/g
  let match1
  while ((match1 = regex1.exec(cleaned)) !== null) {
    const toolName = match1[1]
    // Find the opening brace position and extract balanced JSON
    const braceStart = cleaned.indexOf('{', match1.index + match1[0].length - 1)
    if (braceStart === -1) continue
    const jsonStr = findBalancedJsonUtil(cleaned.slice(braceStart), '')
    if (jsonStr) {
      const args = tryParseLooseJson(jsonStr)
      if (args) {
        calls.push({
          id: nextToolCallId(),
          name: toolName,
          args,
        })
      } else {
        // 21-d: JSON parse failed → ĐẾM thay vì skip im lặng (caller dùng
        // detectBrokenToolCallHint để nhắc LLM phát lại gọn hơn)
        parseFailures++
      }
    } else {
      // 21-d: findBalancedJson null → JSON không khớp cặp ngoặc (bị cắt cụt
      // giữa chừng vì output đạt maxTokens) → ĐẾM
      parseFailures++
    }
  }

  // Pattern 2: Direct tool invocation like opencode({...})
  if (calls.length === 0) {
    // ROUND-44 FIX (c): dùng danh sách dùng chung KNOWN_TOOL_NAMES (trước đây
    // lặp inline — 2 nơi dễ lệch khi thêm tool mới)
    const regex2 = new RegExp(`(${KNOWN_TOOL_NAMES.join('|')})\\s*\\(\\s*\\{`, 'g')
    let match2
    while ((match2 = regex2.exec(cleaned)) !== null) {
      const toolName = match2[1]
      const braceStart = cleaned.indexOf('{', match2.index + match2[0].length - 1)
      if (braceStart === -1) continue
      const jsonStr = findBalancedJsonUtil(cleaned.slice(braceStart), '')
      if (jsonStr) {
        const args = tryParseLooseJson(jsonStr)
        if (args) {
          calls.push({
            id: nextToolCallId(),
            name: toolName,
            args,
          })
        } else {
          parseFailures++
        }
      } else {
        parseFailures++
      }
    }
  }

  return { calls, parseFailures }
}

/**
 * Parse tool_call patterns from LLM text output (backward-compat wrapper —
 * trả về mảng tool calls như cũ; dùng extractToolCallsWithDiagnostics nếu
 * cần cả số lượng parse failures).
 */
export function parseToolCallsFromOutput(output: string): ParsedToolCall[] {
  return extractToolCallsWithDiagnostics(output).calls
}

/**
 * Feedback message chuẩn khi phát hiện tool call bị cắt/JSON lỗi (21-d).
 * FIX (2026-09-03, Task 24): dạy luôn format fence-block cho file_write — lỗi
 * JSON args khi nhét code nhiều dòng vào string là phổ biến nhất (newline thô,
 * quote trong code) → hướng dẫn đường vòng an toàn thay vì chỉ yêu cầu "gọn hơn".
 */
export const BROKEN_TOOL_CALL_FEEDBACK =
  '⚠️ Tool call của bạn bị cắt hoặc JSON lỗi → KHÔNG thực thi được (KHÔNG coi text này là báo cáo hoàn thành). Phát lại theo 1 trong 2 cách: (1) file_write với JSON args CHUẨN (escape \\n trong content, escape mọi dấu " trong code) HOẶC (2) KHUYÊN DÙNG format fence-block: tool_call: file_write({"path": "file.py", "mode": "overwrite"}) rồi xuống dòng mở fence ```python, viết code GỐC nhiều dòng (KHÔNG cần escape), đóng fence ```. Chia file lớn thành nhiều lần ghi (mode append) nếu cần.'

/**
 * ROUND-50 (P3-ζ r49 — bằng chứng user 2026-10-06): model nền MiniMax của
 * space-bunny-free đoán mò cú pháp tool call dạng `<invoke>` (thiếu name attr /
 * name sai vị trí / deliberation trong thinking: "</invoke name="? Wait
 * interface has no explicit tool namespace...") → 0 tool call được thực thi mà
 * KHÔNG có dấu hiệu nào bên dưới bắt được (regex invoke cần name=; không có
 * "tool_call:"; không có ```json) → agent lặp đoán mò. Feedback dạy ĐÚNG 2 cú
 * pháp hệ thống chấp nhận.
 */
export const MALFORMED_INVOKE_FEEDBACK =
  '⚠️ Bạn vừa cố gọi tool bằng cú pháp <invoke>/<tool_name> nhưng SAI ĐỊNH DẠNG (thiếu name="tên_tool" / params không chuẩn / bị cắt cụt giữa chừng) → KHÔNG tool nào được thực thi (KHÔNG coi text này là báo cáo hoàn thành). Hệ thống chấp nhận: (1) tool_call: <tên_tool>({json args}) — vd: tool_call: todo_write({"todos": [{"content": "việc cần làm", "status": "pending"}]}) HOẶC (2) <invoke name="tên_tool">{json args}</invoke> HOẶC (3) <tool_name>tên_tool</tool_name><parameters>{json args}</parameters>. Phát lại NGAY theo 1 trong 3 cú pháp đúng (cắt args ngắn nếu bị cắt cụt).'

/**
 * 21-d — Silent parse-drop detector.
 *
 * Trả về feedback message khi văn bản CÓ dấu hiệu tool call nhưng KHÔNG parse
 * được tool call nào (output bị cắt cụt giữa JSON / JSON lỗi), ngược lại null.
 * Dấu hiệu:
 *   - có ≥1 vị trí parse thất bại (regex match nhưng findBalancedJson null /
 *     JSON.parse throw), HOẶC
 *   - chứa "tool_call:" nhưng 0 call parse được, HOẶC
 *   - có block ```json chứa "name" (định dạng native FC) nhưng 0 call parse được,
 *   - ROUND-50: có `<invoke` nhưng 0 call parse được (invoke sai/mangled —
 *     model MiniMax đoán mò cú pháp, bằng chứng user dán nguyên văn thought).
 *
 * Fail-open tuyệt đối: hàm chỉ đọc chuỗi + regex — không thể throw; mọi lỗi
 * nội bộ → null (caller coi như không có dấu hiệu, giữ behavior cũ).
 */
export function detectBrokenToolCallHint(output: string): string | null {
  try {
    if (!output || typeof output !== 'string' || output.length === 0) return null
    const { calls, parseFailures } = extractToolCallsWithDiagnostics(output)
    if (calls.length > 0) return null // có tool call parse được → không phải parse-drop
    if (parseFailures > 0) return BROKEN_TOOL_CALL_FEEDBACK
    // Dấu hiệu phụ: chuỗi "tool_call:" tồn tại nhưng regex không match được cặp
    // `name({` hoàn chỉnh (bị cắt trước ngoặc nhọn) hoặc parse trả 0 call
    if (/tool_call\s*:/i.test(output)) return BROKEN_TOOL_CALL_FEEDBACK
    // Dấu hiệu phụ: block ```json chứa "name" (LLM phát tool call dạng JSON fence
    // — thường gặp khi native FC bị cắt giữa chừng)
    if (/```json[\s\S]{0,400}?"name"\s*:/.test(output)) return BROKEN_TOOL_CALL_FEEDBACK
    // ROUND-50: <invoke> hiện diện nhưng parse không ra call nào — invoke sai
    // định dạng (thiếu name/mangled, kể cả THẺ ĐÓNG MỒ CÔI `</invoke name="?…`
    // — bằng chứng paste 2 của user: model deliberation cú pháp trong thinking)
    // → dạy lại cú pháp đúng
    if (/<\/?invoke[\s>]/i.test(output)) return MALFORMED_INVOKE_FEEDBACK
    // ROUND-54 FIX E: `<tool_name>` (Anthropic-style) hiện diện nhưng parse
    // không ra call nào — name ngoài whitelist / params vắng hoàn toàn / vỏ
    // <parameters> mất đóng (bằng chứng user r54: "invoke\n<tool_name>todo_read
    // </tool_name><parameters>…" rơi thẳng vào thought content) → dạy lại
    if (/<tool_name>/i.test(output)) return MALFORMED_INVOKE_FEEDBACK
    // ROUND-54 FIX E: dòng "invoke" trơ trụi (mất cặp `<` — dấu vết cú pháp
    // invoke bị provider bể) đứng MỘT MÌNH trên dòng → coi là ý định tool call
    // hỏng format chứ không phải văn xuôi thường
    if (/(^|\n)[ \t]*invoke[ \t]*(\n|$)/i.test(output)) return MALFORMED_INVOKE_FEEDBACK
    return null
  } catch {
    return null // fail-open — không được phép crash caller
  }
}

/**
 * Format conversation messages into a single prompt string for callLLMForAgent.
 * callLLMForAgent takes a single prompt, not a messages array.
 */
export function formatMessagesForLLM(
  messages: Array<{
    role: 'system' | 'user' | 'assistant' | 'tool'
    content: string
    tool_call_id?: string
    tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>
  }>
): string {
  let prompt = ''

  for (const msg of messages) {
    switch (msg.role) {
      case 'system':
        // System prompt is handled separately by callLLMForAgent
        break
      case 'user':
        prompt += `\n\n[USER]: ${msg.content}`
        break
      case 'assistant':
        prompt += `\n\n[ASSISTANT]: ${msg.content}`
        if (msg.tool_calls && msg.tool_calls.length > 0) {
          prompt += `\nTool calls: ${msg.tool_calls.map(tc => `${tc.function.name}(${tc.function.arguments})`).join(', ')}`
        }
        break
      case 'tool':
        prompt += `\n\n[TOOL RESULT]: ${msg.content}`
        break
    }
  }

  return prompt.trim()
}
