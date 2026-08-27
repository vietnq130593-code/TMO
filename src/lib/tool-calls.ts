/**
 * Shared Tool Call Parsing & Message Formatting Utilities
 *
 * Extracted from workflow-engine.ts so they can be reused by:
 *   - Code Team Workflow Engine (original consumer)
 *   - OpenClaw Chat ReAct loop (standalone agents like Omega)
 *
 * parseToolCallsFromOutput: Parses tool_call patterns from LLM text output
 * formatMessagesForLLM: Formats conversation messages into a single prompt string
 */

// FIX 2026-08-29: import from the standalone pure-utility module instead of the
// heavy worklog.ts (which pulls Prisma DB + full agents registry into the chat
// route's module graph, and breaks the build when worklog.ts is missing from a
// partial checkout — "Module not found: Can't resolve '@/lib/code-team/worklog'")
import { findBalancedJson as findBalancedJsonUtil } from '@/lib/code-team/find-balanced-json'

/**
 * Parse tool_call patterns from LLM text output.
 *
 * Supported formats:
 * 1. tool_call: function_name({args})
 * 2. Direct invocation like opencode({action: "read", path: "..."})
 *
 * Returns array of parsed tool calls with id, name, and args.
 */
export function parseToolCallsFromOutput(output: string): Array<{ id: string; name: string; args: Record<string, unknown> }> {
  const calls: Array<{ id: string; name: string; args: Record<string, unknown> }> = []

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
        // JSON parse failed, skip this tool call
      }
    }
  }

  // Pattern 2: Direct tool invocation like opencode({...})
  if (calls.length === 0) {
    const validToolNames = ['opencode', 'knowledge_search', 'knowledge_graph', 'knowledge_write', 'tavily', 'serper', 'jina', 'file_read', 'file_multi_edit', 'file_edit', 'file_delete', 'file_list', 'grep', 'run_tests', 'git_commit', 'git_push', 'git_pull', 'get_diagnostics', 'decompose_task', 'create_task', 'update_task', 'get_plan', 'summarize', 'synthesize', 'run_bg', 'read_output', 'kill_process', 'manage_packages', 'gateway_tool', 'shell', 'todo_write', 'todo_read', 'list_skills', 'read_skill', 'mcp_list_servers', 'web_search', 'web_fetch', 'gateway_exec', 'gateway_read', 'gateway_write', 'gateway_edit', 'gateway_apply_patch', 'lsp_diagnostics', 'browser_screenshot', 'lint', 'type_check', 'test_coverage', 'db_query', 'mcp_call', 'exit_plan_mode', 'cron', 'start_preview', 'stop_preview']
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
          // JSON parse failed
        }
      }
    }
  }

  return calls
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
