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
  } catch { /* rơi xuống repair tầng 2 */ }
  // ROUND-57: tầng 2 — keys không quote (JS object literal) + ghép cả 3 pass
  try {
    const repaired = quoteUnquotedKeysStringAware(stripTrailingCommasStringAware(escapeRawControlCharsInStrings(raw)))
    const obj = JSON.parse(repaired)
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
  'data_map', // r67 (F8): tra cứu bản đồ dữ liệu (đọc thuần — an toàn)
  'lessons_search', // r71 (BUG2-022): tra bài học/episode/trí nhớ (đọc thuần — an toàn)
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
    // → loose-repair (newline thô/trailing comma/keys không quote r57) rồi parse
    try {
      return JSON.parse(t) as unknown
    } catch { /* rơi xuống repair */ }
    try {
      const repaired = quoteUnquotedKeysStringAware(stripTrailingCommasStringAware(escapeRawControlCharsInStrings(t)))
      return JSON.parse(repaired) as unknown
    } catch { /* giữ string */ }
  }
  if (/^<[A-Za-z_]/.test(t)) {
    const nested = parseXmlTagArgs(t)
    if (nested) {
      // <todos><item>…</item><item>…</item></todos> → {item: [a, b]} →
      // unwrap thành ARRAY [a, b] (đúng schema todo_write/… cần mảng).
      // r67 (F4 — nhất quán shape): 1 phần tử CŨNG phải ra ARRAY — trước đây
      // `<todos><item>…</item></todos>` (đúng 1 item) cho object {item:{…}}
      // trong khi ≥2 item cho array (bằng chứng L38: args.todos = object,
      // chỉ thoát nhờ todoWrite unwrap 1-key phía consumer — fragile cho tool
      // khác). Giờ 1 hay N item đều ra ARRAY → shape ổn định mọi consumer.
      const keys = Object.keys(nested)
      if (keys.length === 1) {
        const v = nested[keys[0]]
        return Array.isArray(v) ? v : [v]
      }
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

// ==================== r68 (BUG-003) — MASK TOOL-CALL KHỎI KÊNH SUY NGHĨ ====================
//
// Quan sát mission cmuznvkl…6b136k (giao thức giám sát r68): các evt
// type=thought chứa NGUYÊN VĂN body tool-call (evt5 `TỠI_CALL> {"name":…}`,
// evt9 `tt>tout {…}`, evt23 `_call: todo_write({…})`, evt49 `todo_write">{…}`)
// — đúng hiện tượng user chỉ đạo cụm 2 "tool call lọt vào phần suy nghĩ".
// Rootcause: recordAgentThought (agent-run-tracker.ts) chỉ strip <invoke>…
// </invoke> hoàn chỉnh + tiền tố `tool_call:` — các dạng méo (mà parser
// r66/r67 VẪN extract + execute được từ cùng content) nằm lại nguyên văn
// trong text thought hiển thị ở panel Suy nghĩ.
//
// Giải pháp hardcode (không dạy-bằng-prompt): maskToolCallText quét các HỌ
// dạng đã quan sát bằng whitelist KNOWN_TOOL_NAMES + kết thúc cân bằng —
// span khớp được thay bằng marker ngắn `[🔧 name(…) — đã tách]`. record-
// AgentThought gọi hàm này TRƯỚC khi ghi — suy nghĩ hiển thị chỉ còn phần
// NGHĨ thật, tool call hiển thị là event riêng (đã có sẵn).
//
// Phủ: (1) `name({json})` — pattern-2 + biến thể `_call: name({…})`;
// (2) `name">{json|<xml}` — tag-direct r66 (kèm mangled-quote);
// (3) `{"name": "tool", "arguments": …}` — native body r67 (kèm rác tiền
// tố: TỠI_CALL>/tt>tout/content> — phần rác ngắn còn lại vô hại).
// Giới hạn an toàn: (1) yêu cầu args là JSON object mở bằng `{` (chống bắt
// văn xuôi "gọi file_read(ở trên)"); (3) yêu cầu JSON parse được + tên
// whitelist — suy nghĩ thuần không bao giờ khớp.

/** Quét dấu cân bằng string-aware từ openIdx (chỉ số ký tự MỞ). Trả index ký tự ĐÓNG hoặc -1. */
function findBalancedEnd(text: string, openIdx: number, open: string, close: string): number {
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = openIdx; i < text.length; i++) {
    const ch = text[i]
    if (esc) { esc = false; continue }
    if (ch === '\\' && inStr) { esc = true; continue }
    if (ch === '"') { inStr = !inStr; continue }
    if (inStr) continue
    if (ch === open) depth++
    else if (ch === close) {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

export function maskToolCallText(content: string): string {
  if (!content || content.length < 8) return content
  const known = new Set(KNOWN_TOOL_NAMES)
  type Span = { start: number; end: number; name: string }
  const spans: Span[] = []

  // (1) name( {json} ) — pattern-2 + biến thể tiền tố rác (`_call: name({…})`)
  const nameParen = /\b([a-z_][a-z0-9_]*)\s*\(/g
  for (const m of content.matchAll(nameParen)) {
    const name = m[1]
    if (!known.has(name)) continue
    const openIdx = m.index! + m[0].length - 1
    // args PHẢI là JSON object mở bằng '{' (sau whitespace) — chống bắt văn xuôi
    let j = openIdx + 1
    while (j < content.length && /\s/.test(content[j])) j++
    if (content[j] !== '{') continue
    const end = findBalancedEnd(content, openIdx, '(', ')')
    if (end > openIdx) spans.push({ start: m.index!, end: end + 1, name })
  }

  // (2) name">{json}|<xml — tag-direct r66 (kèm mangled-quote `todo_write">`)
  const nameTag = /\b([a-z_][a-z0-9_]*)\s*">/g
  for (const m of content.matchAll(nameTag)) {
    const name = m[1]
    if (!known.has(name)) continue
    const after = m.index! + m[0].length
    if (content[after] === '{') {
      const json = findBalancedJsonUtil(content.slice(after), '')
      if (json) spans.push({ start: m.index!, end: after + json.length, name })
    } else if (content[after] === '<') {
      // XML-con: quét thẻ + TEXT GIỮA THẺ (bằng chứng evt49 mission #18:
      // `<todo_write"><sessionId>…</sessionId><todos><item>…</todos>`) —
      // kết thúc tại thẻ ĐÓNG cuối cùng trước khi gặp text ngoài XML.
      let idx = after
      let lastClose = -1
      while (idx < content.length) {
        while (idx < content.length && /\s/.test(content[idx])) idx++
        if (idx >= content.length) break
        if (content[idx] === '<') {
          const tagm = /^<[^>]*>/.exec(content.slice(idx))
          if (!tagm) break
          idx += tagm[0].length
          if (tagm[0].startsWith('</')) lastClose = idx
          continue
        }
        // text thường: nếu ĐÃ có thẻ đóng → XML hết (lastClose chốt);
        // chưa có thẻ đóng (text bên trong thẻ mở — vd giá trị <sessionId>)
        // → nhảy tới thẻ kế tiếp
        if (lastClose > after) break
        const nextTag = content.indexOf('<', idx)
        if (nextTag === -1) break
        idx = nextTag
      }
      if (lastClose > after) spans.push({ start: m.index!, end: lastClose, name })
    }
  }

  // (3) {"name": "tool", …} — native body r67 (kèm rác tiền tố đứng trước `{`)
  const nativeRe = /\{\s*"name"\s*:\s*"([a-z_][a-z0-9_]*)"/g
  for (const m of content.matchAll(nativeRe)) {
    const name = m[1]
    if (!known.has(name)) continue
    const json = findBalancedJsonUtil(content.slice(m.index!), 'name')
    if (json) spans.push({ start: m.index!, end: m.index! + json.length, name })
  }

  // (4) r70 (BUG2-012): khối Claude tool_use `{"tool_uses":[{recipient_name…
  // parameters…}]}` — kèm rác tiền tố kết thúc bằng `>` (tool_use>/
  // ngt_…_rewritten>/`< foothold to=…`) vẫn còn lại phía trước (ngắn, vô hại).
  // Bằng chứng main evt55/68 r70: họ này ngoài 3 họ trên → thought lộ nguyên
  // văn khối JSON + detector ngôn ngữ đo nhầm (BUG2-007/013).
  const usesRe = /\{\s*"tool_uses"\s*:\s*\[/g
  for (const m of content.matchAll(usesRe)) {
    const outerEnd = findBalancedEnd(content, m.index!, '{', '}')
    let firstName = 'tool_uses'
    const nm = /"recipient_name"\s*:\s*"(?:functions\.)?([a-z_][a-z0-9_]*)"/.exec(
      content.slice(m.index!, m.index! + 400),
    )
    if (nm) firstName = nm[1]
    if (outerEnd > m.index!) {
      spans.push({ start: m.index!, end: outerEnd + 1, name: firstName })
    } else {
      // Mảng đứt giữa chừng (maxTokens cắt) — phần còn lại của chuỗi là đuôi
      // dở của cùng khối call (không có prose lành mạnh nào theo sau một JSON
      // đứt) → che tới HẾT để thought không lộ nửa sau `recipient_name`.
      spans.push({ start: m.index!, end: content.length, name: firstName })
    }
  }

  if (spans.length === 0) return content
  // Sắp theo start + loại span chồng lấn, thay từ CUỐI về ĐẦU (giữ index)
  spans.sort((a, b) => a.start - b.start)
  const merged: Span[] = []
  for (const s of spans) {
    if (merged.length && s.start < merged[merged.length - 1].end) continue
    merged.push(s)
  }
  let out = content
  for (let i = merged.length - 1; i >= 0; i--) {
    const s = merged[i]
    out = out.slice(0, s.start) + `[🔧 ${s.name}(…) — tool call đã tách khỏi suy nghĩ]` + out.slice(s.end)
  }
  return out
}

/**
 * ROUND-57 FIX (A1 — bão cú pháp mission …iahkk3) — AUTO-REPAIR marker
 * near-miss: model nền phát tool call với THẺ/TIỀN TỐ hỏng 1-2 ký tự trong
 * khi Ý ĐỊNH + args đầy đủ — trước đây rơi vào thought content, 0 call thực
 * thi, agent đoán mò lặp lại (~11/28 vòng chết vì parse trong mission
 * …iahkk3). Bằng chứng nguyên văn (run_1791376496694_1):
 *   R1 `cinvoke name="todo_read"> <parameter name="sessionId">…` (12:38:29)
 *   R2 `c_todo_write({ todos: [ { } ], sessionId: … })` (12:39:22 — 2 call
 *      mashed liền nhau, keys không quote)
 *   R3 `<invoke_call">todo_write({"sessionId":"default",…})` (12:35:48)
 *   R4 `��� name="todo_write" parameters={"sessionId":…}` (12:57:23 — ký tự
 *      private-use thay thẻ + attribute-style parameters=)
 *   R5 `n invoke name="todo_write">` (12:37:47 — mất `<`, stray 'n')
 * Mỗi repair: regex CHẶN (chỉ hình dạng đặc thù của lỗi thật), tên tool vẫn
 * phải qua whitelist ở tầng parse (chống hallucinate) — repair chỉ đổi MARKER,
 * không đụng args. Output sạch → regex không khớp → zero tác động phụ.
 */
function repairNearMissToolMarkers(output: string): string {
  // R2 trước R1: `c_todo_write(` — c_ + tên tool whitelist → pattern-1
  // (`c` cuối có thể là ký tự chat-template rơi, không đoán thêm).
  let s = output.replace(/\bc_([A-Za-z_][\w]*)\s*\(/g, (full, name: string) =>
    KNOWN_TOOL_NAME_SET.has(name) ? `tool_call: ${name}(` : full,
  )
  // R1: `cinvoke` → `<invoke` (typo tiền tố c — xuất hiện lặp lại).
  s = s.replace(/\bcinvoke\b/g, '<invoke')
  // R3: `<invoke_call">` / `<invoke_call>` (tag mở mangled/fused) → tiền tố
  // pattern-1; thẻ đóng `</invoke_call>` tương tự (nếu có) chỉ là text thừa.
  s = s.replace(/<\/?invoke_call"?>/g, (m) => (m.startsWith('</') ? ' ' : 'tool_call: '))
  // R4: attribute-style `name="X" parameters={` (kèm rác byte trước name=
  // cũng sống — regex không yêu cầu ký tự đứng trước) → invoke Form A.
  s = s.replace(/name\s*=\s*"([A-Za-z_][\w.-]*)"\s+parameters\s*=\s*(?=\s*\{)/g, (full, name: string) =>
    KNOWN_TOOL_NAME_SET.has(name) ? `<invoke name="${name}">` : full,
  )
  // R5: `invoke name="` THIẾU `<` (kể cả stray word trước nó — 'n invoke…')
  // → `<invoke name="`. `<invoke` chuẩn không khớp (ký tự trước là `<`).
  s = s.replace(/(^|[\s>])invoke\s+name\s*=\s*"/g, '$1<invoke name="')
  // r67 (F1 — bằng chứng run_1791447941276_1 L23 + 15 dòng/8 file thật):
  // `todo_write">{JSON}` / `todo_write"><sessionId>…` — tên tool + `">`
  // MẤT dấu `<` mở (mirror R5 cho dạng tên-tool-trực-tiếp r66 V1b). Điều kiện
  // CHẶN: tên ∈ whitelist + bắt buộc `">` theo sau + args-con bắt đầu bằng
  // `{` (JSON) hoặc `<` (XML tag con) ngay sau đó → prepend `<` (bỏ quote
  // mangled) → tầng tag-direct nhận. Prose thường (`dùng todo_write> để ghi…`)
  // KHÔNG khớp (lookahead fail) → zero tác động phụ.
  s = s.replace(
    new RegExp(`(^|[^\w<])(${KNOWN_TOOL_NAMES.join('|')})\\s*"?>\\s*(?=[<{])`, 'g'),
    (full, pre: string, name: string) => (KNOWN_TOOL_NAME_SET.has(name) ? `${pre}<${name}>` : full),
  )
  // r68 (BUG-001 — bằng chứng mission cmuznvkl…6b136k evt3 14:58:36): dạng
  // `…{</name> "todo_write", "arguments": {…}}` — native body bị NHIỄM tiền tố
  // `</name>` ngay sau `{` (JSON.parse chết vì tag rác trong object) → 0 call +
  // detector im lặng (chỉ nhận cảnh báo generic thuần-văn-bản) → mất 1 vòng.
  // Repair CHẶN: đòi hỏi cặp `</name> "tool", "arguments":` + tên ∈ whitelist
  // — văn xuôi thường không bao giờ có cấu trúc này. Viết lại thành native
  // body chuẩn cho tầng 6 (extractNativeJsonBodyCalls) nhận.
  s = s.replace(
    /\{?\s*<\/name>\s*"([A-Za-z_][\w.-]*)"\s*,\s*"arguments"\s*:/g,
    (full, name: string) => (KNOWN_TOOL_NAME_SET.has(name) ? `{"name": "${name}", "arguments":` : full),
  )
  // r68 (BUG-023 — bằng chứng checkpoint assistant 4/6): họ pseudo-XML
  // function-call `functions.git_diff<parameter name="parameters">…` (thường
  // cắt đầu + méo thẻ) — không có tầng parse nào nhận. Repair dạng SẠCH
  // (tham số JSON nằm ngay sau parameter name="parameters">): `functions.X …
  // name="parameters"> {json}` → pattern-1 `tool_call: X({json}` — Balanced JSON
  // phía parser tự lo phần cắt. Dạng cụt giữa chừng (không JSON theo sau) rơi
  // tiếp detector sign bên dưới (MALFORMED feedback).
  s = s.replace(
    /functions\.([A-Za-z_][\w.-]*)[\s\S]{0,40}?name="parameters"\s*>\s*(?=\{)/g,
    (full, name: string) => (KNOWN_TOOL_NAME_SET.has(name) ? `tool_call: ${name}(` : full),
  )
  return s
}

/**
 * ROUND-57 FIX (A1 — tầng loose-repair bổ sung): model phát args dạng JS
 * OBJECT LITERAL (keys không quote — bằng chứng `c_todo_write({ todos: [ { } ],
 * sessionId: "sess_…" })`) → JSON.parse fail dù balanced. Pass này quote key
 * nằm NGOÀI string (string-aware — keys trong giá trị string không bị đụng),
 * chạy trong chuỗi repair của tryParseLooseJson. Chỉ được gọi trên chuỗi
 * JSON-candidate đã trích từ ngữ cảnh tool call (balanced braces) — không
 * chạy trên văn xuôi tuỳ tiện.
 */
function quoteUnquotedKeysStringAware(raw: string): string {
  let out = ''
  let inString = false
  let escape = false
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]
    if (escape) { out += ch; escape = false; continue }
    if (ch === '\\' && inString) { out += ch; escape = true; continue }
    if (ch === '"') { inString = !inString; out += ch; continue }
    if (inString) { out += ch; continue }
    // NGOÀI string: `{` hoặc `,` theo sau là `key:` không quote → quote key
    if (ch === '{' || ch === ',') {
      out += ch
      let j = i + 1
      while (j < raw.length && /\s/.test(raw[j])) j++
      const m = /^[A-Za-z_][\w-]*\s*:/.exec(raw.slice(j))
      if (m) {
        out += `"${m[0].slice(0, m[0].indexOf(':')).trim()}":`
        i = j + m[0].length - 1
      }
      continue
    }
    out += ch
  }
  return out
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
      // Form C (ROUND-55 FIX F): MISTRAL NATIVE — chuỗi
      // `<parameter name="k">v</parameter>` lồng trong <invoke name="…">.
      // Bằng chứng r55: 3 tool call Mistral-style trong checkpoint mission
      // ch0jj4 KHÔNG parse được (parseXmlTagArgs của Form B KHÔNG khớp thẻ có
      // attribute `name=`) → rơi vào MALFORMED feedback — mất 1 round-trip
      // mỗi lần gặp dù ĐÚNG cú pháp chuẩn của model nền. Giờ công nhận luôn.
      let formCMatched = false
      if (/^<parameter\s+name\s*=\s*["']/.test(trimmed)) {
        formCMatched = true
        const collected: Record<string, unknown> = {}
        let ppos = 0
        let parsedCount = 0
        for (;;) {
          const pm = /^<parameter\s+name\s*=\s*["']([^"']+)["']\s*>([\s\S]*?)<\/parameter>[ \t]*\r?\n?/.exec(trimmed.slice(ppos))
          if (!pm) break
          collected[pm[1]] = coerceXmlValue(pm[2]) // tái dùng lớp coerce Form B (số/bool/JSON/nested-XML)
          parsedCount++
          ppos += pm[0].length
        }
        const restRaw = trimmed.slice(ppos)
        const restTrim = restRaw.replace(/^[ \t\r\n]+/, '')
        // Trọn vẹn khi: ≥1 parameter ĐÃ ĐÓNG + phần đuôi KHÔNG còn parameter hở
        // (cụt giữa thẻ). Thiếu `</invoke>` cuối KHÔNG vô hiệu (model lược thẻ
        // đóng vẫn cho args đầy đủ) — chỉ tiêu thụ tới hết parameter cuối + vỏ
        // đóng nếu có (không ăn prose đuôi).
        if (parsedCount > 0 && !restTrim.startsWith('<parameter')) {
          let extra = restRaw.length - restTrim.length
          const closeM = /^<\/invoke>\s*/.exec(restTrim)
          if (closeM) extra = (restRaw.length - restTrim.length) + closeM[0].length
          args = collected
          consumed = leadingWs + ppos + extra
        }
        // Parameter cụt giữa thẻ / 0 param khớp → args giữ null, KHÔNG đếm
        // failures — fallback detector `<invoke>` trả MALFORMED_INVOKE_FEEDBACK
        // dạy lại đúng nhóm cú pháp (mirror triết lý FIX E r54)
      }
      if (!formCMatched) {
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
      // ROUND-57 (T9-probe — mirror nguyên tắc r55 "cụt thì KHÔNG execute"):
      // vỏ <parameters> thiếu đóng + đuôi còn thẻ DỞ (dangling '<' không có
      // '>') → output bị cắt cụt giữa chừng — args thu được chỉ là MẢNH rơi
      // (vd mất agentRole) → execute với args thiếu sẽ cho kết quả gây nhiễu
      // (todo_read chạy với role sai → 0 todo — đúng lớp bế tắc mission
      // …iahkk3). Không tạo call, không đếm failures — fallback detector trả
      // MALFORMED feedback v3 (kèm skeleton của tool định gọi) dạy phát lại.
      const danglingTag = closeRel === -1 && innerTrim.lastIndexOf('<') > innerTrim.lastIndexOf('>')
      if (!danglingTag) {
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
      }
      // dangling → args giữ null, KHÔNG đếm failures — fallback detector dạy lại
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

// ============================================================================
// r66 (AUDIT LƯỢT 8 — V1b, bằng chứng mission #18 chu kỳ 2 L37): dạng
// "TÊN TOOL LÀM TAG MỞ TRỰC TIẾP" — model phát
//   `<todo_write"><sessionId>…</sessionId><agentRole>TL</agentRole><todos>
//    <item>…</item>…</todos>` (tag mở MANGLED kèm dấu `"` thừa) ngay trong
// text/thought. KHÔNG khớp tầng nào trước đây: không `<invoke name=>`, không
// `<tool_name>`, không `tool_call:` → parser 0 call + detector im lặng →
// nguyên văn markup dồn vào thought, agent tưởng ĐÃ ghi todo, chu kỳ kết thúc
// không tiến triển (trọng tài CHƯA ĐẠT 1%). Giờ: công nhận dạng này — tên
// phải ∈ whitelist (chống hallucinate), args là XML tags con hoặc JSON.
// ============================================================================

/** Regex khớp tag-mở tên-tool-whitelist: `<todo_write">` / `<todo_write>` / `<todo_write >`. */
const KNOWN_TOOL_TAG_RE = new RegExp(`<(${KNOWN_TOOL_NAMES.join('|')})\\s*\\"?>`, 'g')
/** Dấu hiệu cho detector: tag-mở tên-tool-whitelist tồn tại trong chuỗi.
 * r67 (F5): KHÔNG dùng flag g — regex module-level có g + .test() là bẫy
 * stateful (lastIndex rò qua các lần gọi → miss ngẫu nhiên). Không có g,
 * .test() luôn stateless an toàn. */
const KNOWN_TOOL_TAG_SIGN = new RegExp(`<(?:${KNOWN_TOOL_NAMES.join('|')})\\s*\\"?>`)
/** r67 (F1): dấu hiệu biến thể MẤT `<` — `todo_write">` + args-con `{`/`<`
 * (regex KHÔNG có g — mirror F5). */
const KNOWN_TOOL_NOANGLE_SIGN = new RegExp(`(?:^|[^\\w<])(?:${KNOWN_TOOL_NAMES.join('|')})\\s*"?>\\s*[<{]`)

function extractToolTagDirectCalls(
  output: string,
  /** r66: các span JSON đã được pattern-1/2 parse (args JSON của tool_call
   * chuẩn) — tag-tool nằm TRONG span (ví dụ docs agent ghi file) không được
   * nhúng execute. */
  initialSpans: Array<[number, number]> = [],
): { calls: ParsedToolCall[]; cleaned: string; failures: number } {
  if (!KNOWN_TOOL_TAG_SIGN.test(output)) return { calls: [], cleaned: output, failures: 0 }
  // r67 (F5): SIGN không còn flag g → .test() stateless — dòng reset lastIndex
  // cũ đã xoá (không còn cần thiết, tránh hiểu lầm là đang có state).
  const calls: ParsedToolCall[] = []
  const ranges: Array<[number, number]> = []
  const skipRanges: Array<[number, number]> = [...initialSpans]
  // Reset lastIndex của RE dùng chung (an toàn stateless)
  const re = new RegExp(KNOWN_TOOL_TAG_RE.source, 'g')
  let m: RegExpExecArray | null
  while ((m = re.exec(output)) !== null) {
    if (skipRanges.some(([s, e]) => m!.index >= s && m!.index < e)) continue
    const toolName = m[1]
    const afterTag = output.slice(m.index + m[0].length)
    // Junk prefix ≤ 8 ký tự (whitespace + mảnh ngoặc rơi) — mirror invoke path
    const junkM = /^[\s\]\[]{0,8}/.exec(afterTag)
    const leadingWs = junkM ? junkM[0].length : 0
    const trimmed = afterTag.slice(leadingWs)
    let args: Record<string, unknown> | null = null
    let consumed = 0
    if (trimmed.startsWith('{')) {
      // JSON object ngay sau tag
      const jsonStr = findBalancedJsonUtil(trimmed, '')
      if (jsonStr) {
        args = tryParseLooseJson(jsonStr)
        if (args) consumed = leadingWs + jsonStr.length
      }
      // JSON cụt giữa chừng → KHÔNG đếm failures ở đây — detector fallback sẽ
      // nhận diện tag-mở + MALFORMED feedback dạy lại (đúng triết lý r55)
    } else {
      // XML tags con <key>value</key>… (dạng bằng chứng L37: <sessionId>…<todos>…)
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
      // 0 thẻ con khớp (thẻ hở hoàn toàn / prose) → không call, không failures
    }
    const shadowRange = (): [number, number] => {
      const mm = m as RegExpExecArray // m non-null trong thân vòng while
      const closeTag = `</${toolName}`
      const closeRel = output.indexOf(closeTag, mm.index)
      return closeRel === -1 ? [mm.index, mm.index + mm[0].length] : [mm.index, closeRel + closeTag.length]
    }
    // r66: PHÁT HIỆN CỤT GIỮA ARGS — sau vùng tag đã khớp còn thẻ MỞ không có
    // cặp đóng (bằng chứng: <sessionId>x</sessionId><todos><item><content>VĂN
    // BẢN DỞ — </content> không tồn tại). Args thu được chỉ là MẢNH rơi →
    // KHÔNG execute (todo_write chạy với sessionId không có todos = ghi sai
    // trạng thái) — để detector dạy phát lại (triết lý r55 "cụt thì không
    // execute"). Ngoại lệ: thẻ mở có cặp đóng = call KẾ TIẾP hợp lệ.
    let truncatedArgs = false
    if (args && Object.keys(args).length > 0 && consumed > 0) {
      const rest = afterTag.slice(consumed).trim()
      if (rest.startsWith('<') && !rest.startsWith('</')) {
        const om = /^<([A-Za-z_][\w-]*)[\s>]/.exec(rest)
        if (om && !rest.includes(`</${om[1]}>`)) truncatedArgs = true
      }
    }
    if (args && Object.keys(args).length > 0 && !truncatedArgs) {
      calls.push({ id: nextToolCallId(), name: toolName, args })
      ranges.push([m.index, m.index + m[0].length + consumed])
      skipRanges.push([m.index, m.index + m[0].length + consumed])
    } else {
      // Shadow range (kể cả args cụt): tag mở → thẻ `</tên_tool>` gần nhất —
      // chống parse nhúng các call VÍ DỤ nồng trong vùng hỏng (mirror 5b)
      skipRanges.push(shadowRange())
    }
  }
  let cleaned = output
  for (let i = ranges.length - 1; i >= 0; i--) {
    const [s, e] = ranges[i]
    cleaned = cleaned.slice(0, s) + ' ' + cleaned.slice(e)
  }
  return { calls, cleaned, failures: 0 }
}

// ============================================================================
// r66 (AUDIT LƯỢT 8 — V1a): SALVAGE JSON ARGS BỊ CẮT CỤT giữa chừng.
// Nguồn gốc cắt cụt: provider upstream (space-bunny-free qua Zen) trả
// tool-call JSON đứt giữa output — không phải maxTokens (các profile đều
// maxTokens=-1 = unlimited; goal-loop vẫn có 3 tầng recovery: loose-repair
// → rawArgs-feedback → parse-nudge, r64 đo recovery 100%). Tầng salvage bổ
// sung: đối với tool AN TOÀN (đọc + todo — idempotent), JSON đứt được VÁ
// bằng cách bỏ phần tử/string dở ở cuối + đóng đủ ngoặc → thực thi ngay
// phần hoàn chỉnh, TIẾT KIỆM 1 round-trip nudge. KHÔNG bao giờ áp cho tool
// ghi/modify (file_write/shell…) — args nửa vời nguy hiểm hơn phát lại.
// ============================================================================

const SALVAGE_SAFE_TOOLS = new Set([
  'todo_write', 'todo_read', 'file_read', 'file_list', 'grep', 'db_query',
  'web_search', 'web_fetch', 'get_diagnostics', 'lsp_diagnostics', 'lint',
  'type_check', 'test_coverage', 'run_tests', 'get_plan', 'summarize',
  'list_skills', 'read_skill', 'mcp_list_servers', 'list_custom_tools',
  'get_app_runtime_status', 'knowledge_search', 'knowledge_graph',
  'data_map', // r67 (F8): đọc thuần từ registry hardcode — idempotent an toàn
  'lessons_search', // r71 (BUG2-022): đọc thuần 3 kho Prisma — idempotent an toàn
])

/** Vá JSON object bị đứt giữa chừng: bỏ string/phần tử dở ở cuối + đóng ngoặc. */
export function salvageTruncatedJsonArgs(raw: string): Record<string, unknown> | null {  try {
    if (!raw || raw[0] !== '{') return null
    // Bước 1: cắt bỏ string dở (dấu `"` mở chưa đóng)
    let cut = raw.length
    {
      let inString = false
      let escape = false
      for (let i = 0; i < raw.length; i++) {
        const ch = raw[i]
        if (escape) { escape = false; continue }
        if (inString) {
          if (ch === '\\') { escape = true; continue }
          if (ch === '"') inString = false
          continue
        }
        if (ch === '"') { inString = true; cut = i; continue } // nhớ vị trí `"` mở cuối
      }
      if (inString) {
        // đứt giữa string — cắt tại `"` mở đó (bỏ toàn bộ string dở)
      } else {
        cut = raw.length
      }
    }
    let s = raw.slice(0, cut)
    // Bước 2: lặp bỏ "đuôi dở" — separator/key-mồ-côi/object-mở rỗng ở cuối
    for (let guard = 0; guard < 12; guard++) {
      s = s.replace(/[\s,:]+$/, '')
      if (/[{,]\s*"[^"]*"\s*$/.test(s)) {
        // key mồ côi (vd `{"todos": [{"content"`) → bỏ key + dấu mở theo nó
        s = s.replace(/[{,]\s*"[^"]*"\s*$/, '')
        continue
      }
      if (/[{[]$/.test(s)) { s = s.slice(0, -1); continue } // object/array mở rỗng
      break
    }
    // Bước 3: đóng đủ ngoặc theo stack (quét lại chuỗi đã cắt — string-aware)
    let stack = ''
    {
      let inString = false
      let escape = false
      let ok = true
      for (let i = 0; i < s.length; i++) {
        const ch = s[i]
        if (escape) { escape = false; continue }
        if (inString) {
          if (ch === '\\') { escape = true; continue }
          if (ch === '"') inString = false
          continue
        }
        if (ch === '"') { inString = true; continue }
        if (ch === '{' || ch === '[') stack += ch
        else if (ch === '}' || ch === ']') {
          const open = ch === '}' ? '{' : '['
          if (stack.slice(-1) !== open) { ok = false; break }
          stack = stack.slice(0, -1)
        }
      }
      if (inString || !ok) return null
    }
    for (let i = stack.length - 1; i >= 0; i--) s += stack[i] === '{' ? '}' : ']'
    // Bước 4: parse + validate là object có ≥1 key
    const obj = JSON.parse(s) as unknown
    if (obj && typeof obj === 'object' && !Array.isArray(obj) && Object.keys(obj).length > 0) {
      return obj as Record<string, unknown>
    }
    return null
  } catch {
    return null
  }
}

/**
 * r66 (V1a) — gate salvage cho NATIVE tool_calls (goal-loop): chỉ salvage tool
 * AN TOÀN (đọc/todo — idempotent), KHÔNG bao giờ áp cho tool ghi/modify
 * (file_write/shell/git_commit… — args nửa vời nguy hiểm hơn phát lại).
 */
export function salvageNativeToolArgs(toolName: string, raw: string): Record<string, unknown> | null {
  if (!SALVAGE_SAFE_TOOLS.has(toolName)) return null
  return salvageTruncatedJsonArgs(raw)
}

// ============================================================================
// r67 (F2 — AUDIT LƯỢT 9): THÂN NATIVE TOOL CALL DẠNG JSON OBJECT TRẦN.
// Bằng chứng run_1791316436940_1 (đa dòng liên tiếp):
//   {"name":"todo_read","arguments":{}}
//   {"name":"file_list","arguments":{"path":"audit-out/security-evidence"}}
// không nằm trong ```json fence → detector cũ (dấu hiệu fence-only) im lặng,
// 6 tầng parse cũ đều không khớp → 0 call + 0 nhắc → agent tưởng ĐÃ gọi tool.
// Giờ: quét body `{"name": "<known>", "arguments": {…}}` — balanced-JSON,
// whitelist tên, tool an toàn được salvage khi arguments đứt giữa chừng.
// Tách bạch với pattern-1/2 (không dấu hiệu tool_call:/dấu ngoặc) và với
// json-fence native (fence đã được tầng fence xử lý).
// ============================================================================

const NATIVE_JSON_BODY_RE = /\{\s*"name"\s*:\s*"([A-Za-z_][\w.-]*)"\s*,\s*"arguments"\s*:\s*/g
/** Dấu hiệu nhanh cho tầng này (rẻ — test 1 lần trước khi quét). */
const NATIVE_JSON_BODY_SIGN = /\{\s*"name"\s*:\s*"[A-Za-z_][\w.-]*"\s*,\s*"arguments"\s*:/

function extractNativeJsonBodyCalls(
  output: string,
  /** Vùng đã được tầng khác parse (pattern-1/2) — body JSON nằm TRONG args
   * của tool_call chuẩn (vd file_write ví dụ) KHÔNG được nhúng execute kép. */
  skipSpans: Array<[number, number]>,
): { calls: ParsedToolCall[]; failures: number } {
  if (!NATIVE_JSON_BODY_SIGN.test(output)) return { calls: [], failures: 0 }
  const calls: ParsedToolCall[] = []
  let failures = 0
  const re = new RegExp(NATIVE_JSON_BODY_RE.source, 'g') // bản sao stateless
  let m: RegExpExecArray | null
  while ((m = re.exec(output)) !== null) {
    if (skipSpans.some(([s, e]) => m!.index >= s && m!.index < e)) continue
    let name = m[1]
    if (name.startsWith('functions.')) name = name.slice('functions.'.length)
    if (!KNOWN_TOOL_NAME_SET.has(name)) continue // chống hallucinate
    const argsStart = m.index + m[0].length
    if (output[argsStart] !== '{') continue // arguments phải là object
    const jsonStr = findBalancedJsonUtil(output.slice(argsStart), '')
    if (jsonStr) {
      const args = tryParseLooseJson(jsonStr) ?? (SALVAGE_SAFE_TOOLS.has(name) ? salvageTruncatedJsonArgs(jsonStr) : null)
      if (args) { // arguments rỗng {} là HỢP LỆ (vd todo_read không cần args)
        calls.push({ id: nextToolCallId(), name, args })
        skipSpans.push([argsStart, argsStart + jsonStr.length]) // che tầng tag-direct
        re.lastIndex = argsStart + jsonStr.length // nhảy qua body đã parse
        continue
      }
      failures++ // body balanced nhưng JSON hỏng + salvage không được (tool modify)
      continue
    }
    // Arguments đứt giữa chừng (không khớp cặp ngoặc): salvage chỉ cho tool
    // AN TOÀN — cắt candidate ở body JSON KẾ TIẾP (dòng `{"name":…` mới) hoặc
    // hết chuỗi, tránh nuốt cả các body sau vào 1 lần vá.
    if (SALVAGE_SAFE_TOOLS.has(name)) {
      const tail = output.slice(argsStart)
      const nextBody = tail.search(/\n\s*\{/)
      const candidate = nextBody === -1 ? tail : tail.slice(0, nextBody)
      const salvaged = salvageTruncatedJsonArgs(candidate)
      if (salvaged) {
        calls.push({ id: nextToolCallId(), name, args: salvaged })
        skipSpans.push([argsStart, argsStart + candidate.length])
        if (nextBody !== -1) re.lastIndex = argsStart + nextBody
        continue
      }
    }
    failures++ // đứt + không salvage được → detector dạy phát lại (triết lý r55)
  }
  return { calls, failures }
}

// ============================================================================
// r70 (BUG2-012 — quan sát mission cmuzscdvj…yky79t): THÂN TOOL CALL DẠNG
// CLAUDE tool_use. Bằng chứng main run evt55/evt68 (17:14-17:18Z — model rối
// cú pháp sau restart + cảnh báo ngôn ngữ, chuyển hẳn sang định dạng Claude):
//   tool_use>{"tool_uses":[{"recipient_name":"functions.file_read",
//     "parameters":{"path":"agent-runs/sub_1791479109537_3.jsonl","offset":9,…}}]}
// kèm biến thể tiền tố garble (`ngt_2b90d4cfb8c4_rewritten>`, `< foothold
// to=todo_write`). Tầng 1-8 không khớp → prose-nudge "Lượt output THUẦN VĂN
// BẢN (0 tool call)" bắn OAN 2/2 (evt45/70) — model ĐANG cố gọi tool mà bị
// bảo "hãy phát tool call thật"; maskToolCallText cũng không che họ này →
// thought lộ nguyên văn khối JSON (evt55/68). Giờ: quét body
// `{"tool_uses":[{recipient_name, parameters}, …]}` — bóc TỪNG phần tử,
// strip tiền tố `functions.`, whitelist tên (chống hallucinate), salvage
// phần tử hoàn chỉnh trước điểm đứt khi cả mảng bị cắt giữa chừng.
// ============================================================================

const CLAUDE_TOOL_USE_SIGN = /"tool_uses"\s*:\s*\[/
const CLAUDE_TOOL_USE_ELEM_RE = /\{\s*"recipient_name"\s*:\s*"([A-Za-z_][\w.-]*)"\s*,\s*"parameters"\s*:\s*/g

function extractClaudeToolUseCalls(
  output: string,
  /** Vùng đã được tầng khác parse — không nhúng execute kép. */
  skipSpans: Array<[number, number]>,
): { calls: ParsedToolCall[]; failures: number } {
  if (!CLAUDE_TOOL_USE_SIGN.test(output)) return { calls: [], failures: 0 }
  const calls: ParsedToolCall[] = []
  let failures = 0
  const re = new RegExp(CLAUDE_TOOL_USE_ELEM_RE.source, 'g')
  let m: RegExpExecArray | null
  while ((m = re.exec(output)) !== null) {
    if (skipSpans.some(([s, e]) => m!.index >= s && m!.index < e)) continue
    let name = m[1]
    if (name.startsWith('functions.')) name = name.slice('functions.'.length)
    if (name.startsWith('fn.')) name = name.slice('fn.'.length)
    if (!KNOWN_TOOL_NAME_SET.has(name)) continue // chống hallucimate
    const argsStart = m.index + m[0].length
    if (output[argsStart] !== '{') continue // parameters phải là object
    const jsonStr = findBalancedJsonUtil(output.slice(argsStart), '')
    if (jsonStr) {
      const args = tryParseLooseJson(jsonStr) ?? (SALVAGE_SAFE_TOOLS.has(name) ? salvageTruncatedJsonArgs(jsonStr) : null)
      if (args) {
        calls.push({ id: nextToolCallId(), name, args })
        skipSpans.push([m.index, argsStart + jsonStr.length]) // che phần tử + che tầng tag-direct
        re.lastIndex = argsStart + jsonStr.length
        continue
      }
      failures++ // parameters balanced nhưng JSON hỏng + salvage không được
      continue
    }
    // Parameters đứt giữa chừng: salvage chỉ cho tool AN TOÀN — cắt candidate
    // tại dấu `}` cấp phần tử kế (hoặc hết chuỗi).
    if (SALVAGE_SAFE_TOOLS.has(name)) {
      const tail = output.slice(argsStart)
      const nextElem = tail.search(/\}\s*,\s*\{|\}\s*\]/)
      const candidate = nextElem === -1 ? tail : tail.slice(0, nextElem + 1)
      const salvaged = salvageTruncatedJsonArgs(candidate)
      if (salvaged) {
        calls.push({ id: nextToolCallId(), name, args: salvaged })
        skipSpans.push([m.index, argsStart + candidate.length])
        if (nextElem !== -1) re.lastIndex = argsStart + nextElem
        continue
      }
    }
    failures++ // đứt + không salvage được → detector dạy phát lại
  }
  return { calls, failures }
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
 *    4b. ROUND-55 (F): Mistral native — `<invoke name="tool">` chứa
 *    `<parameter name="k">v</parameter>` (thẻ có attribute — Form B cũ
 *    không khớp; bằng chứng: 3 tool call Mistral-style trong checkpoint
 *    mission ch0jj4)
 * 5. ROUND-54 (E): `<tool_name>tool</tool_name><parameters>…</parameters>`
 *    Anthropic-style (JSON hoặc XML-tag params; có/không vỏ parameters)
 */
export function extractToolCallsWithDiagnostics(rawOutput: string): ToolCallParseResult {
  // ROUND-44 FIX (c): strip marker rác của provider TRƯỚC mọi parse — marker
  // chen giữa `tool_call: x({...})` cũng làm regex cũ miss.
  // ROUND-57 FIX (A1): repair marker near-miss (cinvoke/c_tool/invoke_call/
  // parameters=//invoke thiếu `<`) — xem repairNearMissToolMarkers cho bằng
  // chứng nguyên văn từng dạng.
  const output = repairNearMissToolMarkers(stripProviderGarbleMarkers(rawOutput))
  const { calls: fenceCalls, cleaned: afterFence, failures: fenceFailures } = extractFencedFileWrites(output)
  // ROUND-44 FIX (c): invoke-recovery chạy TRƯỚC regex (format đặc thù, không
  // đụng pattern 1/2); vùng đã parse bị cắt khỏi chuỗi regex quét tiếp.
  const invokeRes = extractInvokeToolCalls(afterFence)
  // ROUND-54 FIX E: tool_name-tag recovery chạy sau invoke (cùng lớp đặc thù)
  const tntRes = extractToolNameTagCalls(invokeRes.cleaned)
  const calls: ParsedToolCall[] = [...fenceCalls, ...invokeRes.calls, ...tntRes.calls]
  let parseFailures = fenceFailures + invokeRes.failures + tntRes.failures
  // r66 (V1b): tag-trực-tiếp (<todo_write">…) chạy SAU pattern-1/2 — tên tool
  // phổ biến (file_read/grep…) dễ xuất hiện trong content JSON của tool_call
  // khác (docs/ví dụ) → pattern-1/2 parse + CẮT vùng JSON khỏi cleaned trước,
  // tag-direct chỉ quét phần còn lại → không nhúng nhầm.
  let cleaned = tntRes.cleaned

  // Pattern 1: tool_call: function_name({...})
  // Use findBalancedJson for nested JSON args (e.g., opencode write with content containing code)
  // r66: jsonSpans — vùng JSON pattern-1/2 đã parse thành công (che tag-direct
  // khỏi tag-tool nằm trong content của tool_call chuẩn)
  const jsonSpans: Array<[number, number]> = []
  // r67 (F6 hoàn thiện): nhánh THẤT BẠI của pattern-1/2 cũng PHẢI che vùng —
  // nếu không tầng tag-direct sẽ gặt tag-tool nằm trong content của tool_call
  // JSON-hỏng (vd ví dụ mangled trong doc agent định ghi) → execute nhúng.
  const protectSpan = (start: number, end: number) => {
    if (end > start) jsonSpans.push([start, end])
  }
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
        jsonSpans.push([braceStart, braceStart + jsonStr.length])
      } else if (SALVAGE_SAFE_TOOLS.has(toolName)) {
        // r66 (V1a): JSON lệch nhưng tool AN TOÀN → salvage (bỏ đuôi dở + đóng
        // ngoặc) — tiết kiệm 1 round-trip nudge; KHÔNG áp cho tool modify
        const candidate = jsonStr
        const salvaged = salvageTruncatedJsonArgs(candidate)
        if (salvaged) {
          calls.push({ id: nextToolCallId(), name: toolName, args: salvaged })
        } else {
          parseFailures++
          protectSpan(braceStart, braceStart + jsonStr.length) // r67 (F6)
        }
      } else {
        // 21-d: JSON parse failed → ĐẾM thay vì skip im lặng (caller dùng
        // detectBrokenToolCallHint để nhắc LLM phát lại gọn hơn)
        parseFailures++
        protectSpan(braceStart, braceStart + jsonStr.length) // r67 (F6)
      }
    } else if (SALVAGE_SAFE_TOOLS.has(toolName)) {
      // r66 (V1a): JSON CẮT CỤT giữa chừng + tool an toàn → salvage phần đầu
      // hoàn chỉnh (bỏ item/string dở ở cuối) thay vì đếm failure + nudge
      const candidate = cleaned.slice(braceStart).replace(/\)[\s\S]*$/, '')
      const salvaged = salvageTruncatedJsonArgs(candidate)
      if (salvaged) {
        calls.push({ id: nextToolCallId(), name: toolName, args: salvaged })
        jsonSpans.push([braceStart, braceStart + candidate.length])
      } else {
        // 21-d: findBalancedJson null → JSON không khớp cặp ngoặc (bị cắt cụt
        // giữa chừng vì output đạt maxTokens) → ĐẾM
        parseFailures++
        protectSpan(braceStart, braceStart + candidate.length) // r67 (F6)
      }
    } else {
      // 21-d: findBalancedJson null → JSON không khớp cặp ngoặc (bị cắt cụt
      // giữa chừng vì output đạt maxTokens) → ĐẾM
      parseFailures++
      // r67 (F6): JSON cụt + tool nguy hiểm — vẫn che vùng bounded (đến `)`
      // đầu tiên) chống tag-direct gặt tag nhúng trong phần đã cụt
      const bounded = cleaned.slice(braceStart).replace(/\)[\s\S]*$/, '')
      protectSpan(braceStart, braceStart + bounded.length)
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
          // r67 (F6): pattern-2 parse thành công cũng PHẢI push jsonSpans —
          // pattern-2 KHÔNG cắt matched JSON khỏi cleaned → tầng tag-direct
          // (r66 V1b) quét lại vùng này sẽ nhúng execute KÉP tag-tool nằm
          // trong content (mirror pattern-1).
          jsonSpans.push([braceStart, braceStart + jsonStr.length])
        } else if (SALVAGE_SAFE_TOOLS.has(toolName)) {
          // r66 (V1a) — mirror pattern-1
          const salvaged = salvageTruncatedJsonArgs(jsonStr)
          if (salvaged) {
            calls.push({ id: nextToolCallId(), name: toolName, args: salvaged })
            jsonSpans.push([braceStart, braceStart + jsonStr.length]) // r67 (F6)
          } else {
            parseFailures++
            protectSpan(braceStart, braceStart + jsonStr.length) // r67 (F6)
          }
        } else {
          parseFailures++
          protectSpan(braceStart, braceStart + jsonStr.length) // r67 (F6)
        }
      } else if (SALVAGE_SAFE_TOOLS.has(toolName)) {
        // r66 (V1a) — mirror pattern-1
        const candidate = cleaned.slice(braceStart).replace(/\)[\s\S]*$/, '')
        const salvaged = salvageTruncatedJsonArgs(candidate)
        if (salvaged) {
          calls.push({ id: nextToolCallId(), name: toolName, args: salvaged })
          jsonSpans.push([braceStart, braceStart + candidate.length]) // r67 (F6)
        } else {
          parseFailures++
          protectSpan(braceStart, braceStart + candidate.length) // r67 (F6)
        }
      } else {
        parseFailures++
        // r67 (F6): mirror pattern-1 — che vùng bounded chống nhúng
        const bounded = cleaned.slice(braceStart).replace(/\)[\s\S]*$/, '')
        protectSpan(braceStart, braceStart + bounded.length)
      }
    }
  }

  // r67 (F2 — bằng chứng run_1791316436940_1: 2 dòng JSON thường trần không
  // fence): thân native tool call phát DƯỚI DẠNG JSON OBJECT thuần trong
  // text/prose — `{"name":"todo_read","arguments":{}}` (định dạng
  // request OpenAI rơi ra output). Trước đây: 0 tầng nào parse + detector chỉ
  // nhận dạng TRONG ```json fence → im lặng hoàn toàn. Giờ: tầng 6 quét body
  // JSON name+arguments, whitelist, salvage tool an toàn khi đứt.
  const nativeJsonRes = extractNativeJsonBodyCalls(cleaned, jsonSpans)
  calls.push(...nativeJsonRes.calls)
  parseFailures += nativeJsonRes.failures

  // r70 (BUG2-012): tầng 7 — thân Claude tool_use (bằng chứng evt55/68 r70:
  // `tool_use>{"tool_uses":[{"recipient_name":"functions.X","parameters":…}]}`)
  // — chạy SAU native body để không đè tier 6; span đã che chống execute kép.
  const claudeRes = extractClaudeToolUseCalls(cleaned, jsonSpans)
  calls.push(...claudeRes.calls)
  parseFailures += claudeRes.failures

  // r66 (V1b): tầng CUỐI — tag-trực-tếp trên vùng còn lại (pattern-1/2 đã cắt
  // các JSON args của tool_call chuẩn khỏi cleaned → ví dụ tag-tool nằm trong
  // content không bị nhúng execute).
  const tagRes = extractToolTagDirectCalls(cleaned, jsonSpans)
  calls.push(...tagRes.calls)
  parseFailures += tagRes.failures

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
  '⚠️ Bạn vừa cố gọi tool bằng cú pháp <invoke>/<tool_name> nhưng SAI ĐỊNH DẠNG (thiếu name="tên_tool" / params không chuẩn / bị cắt cụt giữa chừng) → KHÔNG tool nào được thực thi (KHÔNG coi text này là báo cáo hoàn thành). Hệ thống chấp nhận: (1) tool_call: <tên_tool>({json args}) — vd: tool_call: todo_write({"todos": [{"content": "việc cần làm", "status": "pending"}]}) HOẶC (2) <invoke name="tên_tool">{json args}</invoke> (hoặc <invoke name="tên_tool"><parameter name="tên_arg">giá trị</parameter>…</invoke>) HOẶC (3) <tool_name>tên_tool</tool_name><parameters>{json args}</parameters>. Phát lại NGAY theo 1 trong 3 cú pháp đúng (cắt args ngắn nếu bị cắt cụt).'

/**
 * ROUND-57 FIX (A1 — feedback v3 "copy-paste được"): feedback chung chung bắt
 * model phải TỰ DỊCH cú pháp → vẫn đoán mò (bằng chứng mission …iahkk3: 6/6
 * prose-only, model phát 6 biến thể hỏng mới dù đã được dạy 3 cú pháp). Giờ
 * trích TÊN TOOL model định gọi từ chính chuỗi hỏng (kể cả dạng mangled) rồi
 * gắn kèm skeleton HOÀN CHỈNH của tool đó — model chỉ cần thay args. Fail-open:
 * không trích được → trả feedback chung (giữ nguyên hành vi cũ).
 */
function extractIntendedToolName(output: string): string | null {
  const patterns = [
    /<invoke\s+name\s*=\s*"?([A-Za-z_][\w.-]*)/i,
    /invoke\s+name\s*=\s*"?([A-Za-z_][\w.-]*)/i,
    /<tool_name>\s*([A-Za-z_][\w.-]*)\s*<\/tool_name>/i,
    /"name"\s*:\s*"([a-z0-9_.-]+)"/i,
    /\bc_([A-Za-z_][\w]*)\s*\(/i,
    /<\/?invoke_call"?>\s*([A-Za-z_][\w]*)\s*\(/i,
    /name\s*=\s*"([A-Za-z_][\w.-]*)"\s+parameters/i,
    // r66 (V1b): tên tool whitelist làm tag-mở trực tiếp (kể cả mangled quote)
    new RegExp(`<(${KNOWN_TOOL_NAMES.join('|')})\\s*"?>`, 'i'),
    // r67 (F1): biến thể MẤT `<` — `todo_write">` + args-con (mirror tầng trên)
    new RegExp(`(?:^|[^\\w<])(${KNOWN_TOOL_NAMES.join('|')})\\s*"?>\\s*[<{]`, 'i'),
  ]
  for (const re of patterns) {
    const m = re.exec(output)
    if (m) {
      let name = m[1]
      if (name.startsWith('functions.')) name = name.slice('functions.'.length)
      if (KNOWN_TOOL_NAME_SET.has(name)) return name
    }
  }
  return null
}

function malformedInvokeFeedback(intendedTool: string | null): string {
  if (!intendedTool) return MALFORMED_INVOKE_FEEDBACK
  return (
    `⚠️ Bạn vừa cố gọi tool "${intendedTool}" bằng cú pháp <invoke>/<tool_name> nhưng SAI ĐỊNH DẠNG (marker hỏng/thiếu name=/bị cắt cụt) → KHÔNG tool nào được thực thi (KHÔNG coi text này là báo cáo hoàn thành).\n` +
    `👉 COPY ĐÚNG DÒNG DƯỚI RỒI THAY args của bạn vào (giữ nguyên phần ngoài {} — KHÔNG thêm/bớt ký tự nào khác):\n` +
    `tool_call: ${intendedTool}({ "args_cua_ban": "gia tri" })\n` +
    `Hoặc dạng thẻ (khi args dài dễ cắt cụt — mỗi tham số 1 thẻ):\n` +
    `<invoke name="${intendedTool}"><parameter name="ten_arg">gia tri</parameter></invoke>\n` +
    `Args phải là JSON chuẩn (key và value đều trong ngoặc kép "…", phần tử ngăn cách bằng dấu phẩy). Nếu bị cắt cụt: rút ngắn args hoặc chia nhỏ làm nhiều lần gọi.`
  )
}

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
    // ROUND-57 v3: trích tên tool định gọi từ chuỗi hỏng → feedback kèm
    // skeleton copy-paste của CHÍNH tool đó (thay vì chỉ dạy cú pháp chung)
    const intended = extractIntendedToolName(output)
    if (parseFailures > 0) return intended ? malformedInvokeFeedback(intended) : BROKEN_TOOL_CALL_FEEDBACK
    // Dấu hiệu phụ: chuỗi "tool_call:" tồn tại nhưng regex không match được cặp
    // `name({` hoàn chỉnh (bị cắt trước ngoặc nhọn) hoặc parse trả 0 call
    if (/tool_call\s*:/i.test(output)) return intended ? malformedInvokeFeedback(intended) : BROKEN_TOOL_CALL_FEEDBACK
    // Dấu hiệu phụ: block ```json chứa "name" (LLM phát tool call dạng JSON fence
    // — thường gặp khi native FC bị cắt giữa chừng)
    if (/```json[\s\S]{0,400}?"name"\s*:/.test(output)) return intended ? malformedInvokeFeedback(intended) : BROKEN_TOOL_CALL_FEEDBACK
    // ROUND-50: <invoke> hiện diện nhưng parse không ra call nào — invoke sai
    // định dạng (thiếu name/mangled, kể cả THẺ ĐÓNG MỒ CÔI `</invoke name="?…`
    // — bằng chứng paste 2 của user: model deliberation cú pháp trong thinking)
    // → dạy lại cú pháp đúng
    if (/<\/?invoke[\s>]/i.test(output)) return malformedInvokeFeedback(intended)
    // ROUND-54 FIX E: `<tool_name>` (Anthropic-style) hiện diện nhưng parse
    // không ra call nào — name ngoài whitelist / params vắng hoàn toàn / vỏ
    // <parameters> mất đóng (bằng chứng user r54: "invoke\n<tool_name>todo_read
    // </tool_name><parameters>…" rơi thẳng vào thought content) → dạy lại
    if (/<tool_name>/i.test(output)) return malformedInvokeFeedback(intended)
    // r66 (V1b — bằng chứng mission #18 L37): TÊN TOOL whitelist làm TAG MỞ
    // trực tiếp (`<todo_write">` mangled-quote, args XML con cụt giữa chừng)
    // nhưng tầng parse không tạo được call → KHÔNG được im lặng — dạy lại kèm
    // skeleton của đúng tool định gọi
    if (KNOWN_TOOL_TAG_SIGN.test(output)) return malformedInvokeFeedback(intended)
    // r67 (F1 — bằng chứng L23 + 15 dòng/8 file): biến thể MẤT `<` —
    // `todo_write">{…}` / `todo_write"><sessionId>…` chưa parse được → KHÔNG
    // im lặng (extract đã repair R6 bên trong — tới đây nghĩa là args vẫn hỏng)
    if (KNOWN_TOOL_NOANGLE_SIGN.test(output)) return malformedInvokeFeedback(intended)
    // r67 (F2 — bằng chứng run_1791316436940_1): thân native JSON trần
    // `{"name":"x","arguments":{…}` hiện diện nhưng tầng 6 không tạo được
    // call (arguments đứt + tool modify không salvage) → dạy phát lại
    if (NATIVE_JSON_BODY_SIGN.test(output)) return malformedInvokeFeedback(intended)
    // r68 (BUG-023 — bằng chứng checkpoint assistant 4/6 mission cmuznvkl…):
    // họ pseudo-XML function-call `functions.<tool>` / `<parameter
    // name="parameters|recipient_name|arguments">` (cắt đầu + méo thẻ) — tầng
    // parse chưa nhận dạng này (riêng dạng SẠCH đã có repair R8 phía extract)
    // → KHÔNG im lặng: dạy lại bằng skeleton đúng tool định gọi.
    if (/functions\.[A-Za-z_][\w.-]*[<{\s]/.test(output) || /<parameter\s+name="(?:parameters|recipient_name|arguments)"/.test(output)) {
      return malformedInvokeFeedback(intended)
    }
    // ROUND-54 FIX E: dòng "invoke" trơ trụi (mất cặp `<` — dấu vết cú pháp
    // invoke bị provider bể) đứng MỘT MÌNH trên dòng → coi là ý định tool call
    // hỏng format chứ không phải văn xuôi thường
    if (/(^|\n)[ \t]*invoke[ \t]*(\n|$)/i.test(output)) return malformedInvokeFeedback(intended)
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
