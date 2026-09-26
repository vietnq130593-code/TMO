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
function tryParseLooseJson(raw: string): Record<string, unknown> | null {
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
      id: `tc_${Date.now()}_${calls.length}`,
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
 * Parse tool_call patterns from LLM text output (kèm đếm parse failures).
 *
 * Supported formats:
 * 1. tool_call: function_name({...}) — args JSON loose-repaired (newline thô,
 *    trailing comma — Task 24)
 * 2. Direct invocation like opencode({action: "read", path: "..."})
 * 3. file_write fence-block: tool_call: file_write({"path": ...}) + ```fence```
 *    (Task 24 — code nhiều dòng không cần escape)
 */
export function extractToolCallsWithDiagnostics(output: string): ToolCallParseResult {
  const { calls: fenceCalls, cleaned, failures: fenceFailures } = extractFencedFileWrites(output)
  const calls: ParsedToolCall[] = [...fenceCalls]
  let parseFailures = fenceFailures

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
          id: `tc_${Date.now()}_${calls.length}`,
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
    const validToolNames = ['opencode', 'knowledge_search', 'knowledge_graph', 'knowledge_write', 'tavily', 'serper', 'jina', 'file_read', 'file_edit', 'file_multi_edit', 'file_write', 'file_delete', 'file_list', 'grep', 'run_tests', 'git_commit', 'git_push', 'git_pull', 'get_diagnostics', 'decompose_task', 'create_task', 'update_task', 'get_plan', 'summarize', 'synthesize', 'run_bg', 'read_output', 'kill_process', 'manage_packages', 'gateway_tool', 'shell', 'todo_write', 'todo_read', 'hypothesis_write', 'list_skills', 'read_skill', 'mcp_list_servers', 'web_search', 'web_fetch', 'gateway_exec', 'gateway_read', 'gateway_write', 'gateway_edit', 'gateway_apply_patch', 'lsp_diagnostics', 'browser_screenshot', 'lint', 'type_check', 'test_coverage', 'db_query', 'mcp_call', 'exit_plan_mode', 'cron', 'start_preview', 'stop_preview', 'get_app_runtime_status', 'create_custom_tool', 'delete_custom_tool', 'list_custom_tools', 'manage_tools',
      // FIX 2026-09-15 #7 (P4 — audit Team Code): bổ sung tool mới thiếu trong
      // danh sách regex (mirror workflow-engine.ts) — agent phát tên_tool({...})
      // trực tiếp giờ được parse đúng thay vì bị bỏ lỡ → tự bịa output.
      'git_status', 'git_diff', 'git_log', 'git_branch', 'context_recall',
      'escalate_problem', 'propose_automation', 'verify_and_push',
      'delegate_task', 'request_code_team', 'dispatch_agent', 'dispatch_agents_parallel',
      'create_agent', 'manage_automation']
    const regex2 = new RegExp(`(${validToolNames.join('|')})\\s*\\(\\s*\\{`, 'g')
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
            id: `tc_${Date.now()}_${calls.length}`,
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
 * 21-d — Silent parse-drop detector.
 *
 * Trả về feedback message khi văn bản CÓ dấu hiệu tool call nhưng KHÔNG parse
 * được tool call nào (output bị cắt cụt giữa JSON / JSON lỗi), ngược lại null.
 * Dấu hiệu:
 *   - có ≥1 vị trí parse thất bại (regex match nhưng findBalancedJson null /
 *     JSON.parse throw), HOẶC
 *   - chứa "tool_call:" nhưng 0 call parse được, HOẶC
 *   - có block ```json chứa "name" (định dạng native FC) nhưng 0 call parse được.
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
