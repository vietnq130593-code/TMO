/**
 * TMO Bridge Common — shared helpers for TMO↔OpenCode custom tools bridge.
 *
 * All tmo_*.ts tools in this directory call POST http://localhost:3000/api/tools/execute
 * to invoke TMO's executeTool(). This bridges OpenCode agent loop → TMO tool system.
 *
 * Endpoint: POST /api/tools/execute
 * Body: { tool: string, args: Record<string, unknown>, context?: { agentName?, sessionId?, runId? } }
 */

/** Base URL of TMO app (Next.js server). */
const TMO_BASE_URL = process.env.TMO_BASE_URL || 'http://localhost:3000'

/** Agent name for audit trail (which OpenCode-spawned agent is calling). */
const AGENT_NAME = process.env.TMO_AGENT_NAME || 'opencode-bridge'

/** Session ID for tool events persistence (passed via env from callOpenCodeCLIProvider). */
const SESSION_ID = process.env.TMO_SESSION_ID || null

/** 2026-10-20 TASK 20 — Run ID của agent run đang chạy (env từ
 * callOpenCodeCLIProvider). Truyền vào context để todo_write từ inner loop
 * CLI được gắn ĐÚNG run — buildRunTodosBlock (TODO block chu kỳ sau) +
 * autoCompleteRunTodosByEvidence đều query theo sessionId+runId. */
const RUN_ID = process.env.TMO_RUN_ID || null

/**
 * Call TMO executeTool via HTTP.
 * Returns stringified result (compact for LLM context).
 */
export async function callTmoTool(
  tool: string,
  args: Record<string, unknown>,
): Promise<string> {
  try {
    const res = await fetch(`${TMO_BASE_URL}/api/tools/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tool,
        args,
        context: {
          agentName: AGENT_NAME,
          sessionId: SESSION_ID,
          runId: RUN_ID,
        },
      }),
      signal: AbortSignal.timeout(60000), // 60s timeout
    })

    if (!res.ok) {
      const errText = await res.text().catch(() => '')
      return `TMO tool "${tool}" failed: HTTP ${res.status} — ${errText.slice(0, 200)}`
    }

    const data = await res.json() as { success: boolean; result: unknown; duration: number }

    // Compact result for LLM context — stringified, capped at 2000 chars
    const resultStr = typeof data.result === 'string'
      ? data.result
      : JSON.stringify(data.result)

    if (resultStr.length > 2000) {
      return `${resultStr.slice(0, 1800)}\n\n[...truncated, ${resultStr.length} total chars, duration ${data.duration}ms]`
    }
    return `${resultStr}${data.duration ? `\n(tool_duration: ${data.duration}ms)` : ''}`
  } catch (err) {
    return `TMO bridge error (${tool}): ${err instanceof Error ? err.message : String(err)}`
  }
}
