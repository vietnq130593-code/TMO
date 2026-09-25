/**
 * POST /api/tools/execute — Execute a TMO tool by name (hybrid bridge endpoint).
 *
 * Exposes executeTool() over HTTP so OpenCode CLI custom tools (`.opencode/tools/tmo_*.ts`)
 * can call TMO tools during OpenCode agent loop execution.
 *
 * Body: { tool: string, args: Record<string, unknown>, context?: { agentName?, sessionId?, runId? } }
 * Response: { success: boolean, result: unknown, duration: number } | { error: string }
 *
 * Security: validates tool name against builtin + custom registries (no arbitrary execution).
 */
import { NextRequest, NextResponse } from 'next/server'
import { executeTool, isBuiltinTool, getAllBuiltinToolNames, getBuiltinToolDefinition } from '@/lib/code-team/tool-executor'

export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as {
      tool?: string
      args?: Record<string, unknown>
      context?: { agentName?: string; sessionId?: string | null; runId?: string | null }
    }

    const { tool, args = {}, context } = body

    if (!tool || typeof tool !== 'string') {
      return NextResponse.json(
        { error: 'Missing or invalid "tool" field (must be string)' },
        { status: 400 },
      )
    }

    // Security: only allow builtin + custom tools. Reject arbitrary names.
    if (!isBuiltinTool(tool)) {
      try {
        const { isCustomToolRegistered } = await import('@/lib/custom-tool-registry')
        if (!isCustomToolRegistered(tool)) {
          return NextResponse.json(
            { error: `Tool "${tool}" not found in builtin or custom registry` },
            { status: 404 },
          )
        }
      } catch {
        return NextResponse.json(
          { error: `Tool "${tool}" not found in builtin registry` },
          { status: 404 },
        )
      }
    }

    const result = await executeTool(tool, args, {
      agentName: context?.agentName || 'opencode-bridge',
      sessionId: context?.sessionId ?? null,
      runId: context?.runId ?? null,
    })

    return NextResponse.json({
      success: result.success,
      result: result.result,
      duration: result.duration,
      tool,
    })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Tool execution failed' },
      { status: 500 },
    )
  }
}

/** GET — list available TMO tools (for OpenCode bridge discovery). */
export async function GET() {
  try {
    const names = getAllBuiltinToolNames()
    const tools = names.map(name => {
      const def = getBuiltinToolDefinition(name)
      return {
        name,
        description: def?.function?.description || '',
        category: 'general',
        dangerous: false,
      }
    })
    return NextResponse.json({ tools, total: tools.length, source: 'tmo-execute-endpoint' })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to list tools' },
      { status: 500 },
    )
  }
}
