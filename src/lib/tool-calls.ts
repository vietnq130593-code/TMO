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
 * Parse tool_call patterns from LLM text output (kèm đếm parse failures).
 *
 * Supported formats:
 * 1. tool_call: function_name({...})
 * 2. Direct invocation like opencode({action: "read", path: "..."})
 */
export function extractToolCallsWithDiagnostics(output: string): ToolCallParseResult {
  const calls: ParsedToolCall[] = []
  let parseFailures = 0

  // Pattern 1: tool_call: function_name({...})
  // Use findBalancedJson for nested JSON args (e.g., opencode write with content containing code)
  const regex1 = /tool_call:\s*(\w+)\s*\(\s*\{/g
  let match1
  while ((match1 = regex1.exec(output)) !== null) {
    const toolName = match1[1]
    // Find the opening brace position and extract balanced JSON
    const braceStart = output.indexOf('{', match1.index + match1[0].length - 1)
    if (braceStart === -1) continue
    const jsonStr = findBalancedJsonUtil(output.slice(braceStart), '')
    if (jsonStr) {
      try {
        const args = JSON.parse(jsonStr)
        calls.push({
          id: `tc_${Date.now()}_${calls.length}`,
          name: toolName,
          args,
        })
      } catch {
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
    const validToolNames = ['opencode', 'knowledge_search', 'knowledge_graph', 'knowledge_write', 'tavily', 'serper', 'jina', 'file_read', 'file_edit', 'file_multi_edit', 'file_write', 'file_delete', 'file_list', 'grep', 'run_tests', 'git_commit', 'git_push', 'git_pull', 'get_diagnostics', 'decompose_task', 'create_task', 'update_task', 'get_plan', 'summarize', 'synthesize', 'run_bg', 'read_output', 'kill_process', 'manage_packages', 'gateway_tool', 'shell', 'todo_write', 'todo_read', 'list_skills', 'read_skill', 'mcp_list_servers', 'web_search', 'web_fetch', 'gateway_exec', 'gateway_read', 'gateway_write', 'gateway_edit', 'gateway_apply_patch', 'lsp_diagnostics', 'browser_screenshot', 'lint', 'type_check', 'test_coverage', 'db_query', 'mcp_call', 'exit_plan_mode', 'cron', 'start_preview', 'stop_preview', 'get_app_runtime_status', 'create_custom_tool', 'delete_custom_tool', 'list_custom_tools']
    const regex2 = new RegExp(`(${validToolNames.join('|')})\\s*\\(\\s*\\{`, 'g')
    let match2
    while ((match2 = regex2.exec(output)) !== null) {
      const toolName = match2[1]
      const braceStart = output.indexOf('{', match2.index + match2[0].length - 1)
      if (braceStart === -1) continue
      const jsonStr = findBalancedJsonUtil(output.slice(braceStart), '')
      if (jsonStr) {
        try {
          const args = JSON.parse(jsonStr)
          calls.push({
            id: `tc_${Date.now()}_${calls.length}`,
            name: toolName,
            args,
          })
        } catch {
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

/** Feedback message chuẩn khi phát hiện tool call bị cắt/JSON lỗi (21-d). */
export const BROKEN_TOOL_CALL_FEEDBACK =
  '⚠️ Tool call của bạn bị cắt hoặc JSON lỗi → KHÔNG thực thi được. Có thể do output quá dài. Hãy phát lại tool call GỌN HƠN (chia file thành nhiều lần ghi, dùng file_write mode append) hoặc giảm nội dung.'

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
