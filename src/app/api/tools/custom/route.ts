/**
 * Custom Tools API — manage agent-written custom tools
 *
 * GET    /api/tools/custom           — List all custom tools (DB)
 * DELETE /api/tools/custom {name}    — Delete a custom tool (+ SKILL.md guide)
 *
 * Creation đi qua tool create_custom_tool (agents) hoặc /api/tools/register.
 * (user request 2026-08-30)
 */

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { deleteCustomTool, ensureCustomToolsLoaded } from '@/lib/custom-tool-registry'

export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    await ensureCustomToolsLoaded()
    const tools = await db.customTool.findMany({ orderBy: { createdAt: 'desc' } })
    return NextResponse.json({
      ok: true,
      tools: tools.map(t => {
        let parameters: unknown = {}
        try { parameters = JSON.parse(t.parameters) } catch { /* keep {} */ }
        return {
          name: t.name,
          description: t.description,
          parameters,
          version: t.version,
          source: t.source,
          enabled: t.enabled,
          callCount: t.callCount,
          skillSlug: t.skillSlug,
          createdAt: t.createdAt,
        }
      }),
      total: tools.length,
    })
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    )
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const body = await request.json()
    const { name } = body
    if (!name || typeof name !== 'string') {
      return NextResponse.json({ ok: false, error: 'Thiếu "name"' }, { status: 400 })
    }
    const result = await deleteCustomTool(name)
    if (!result.success) {
      return NextResponse.json({ ok: false, error: result.error }, { status: 404 })
    }
    return NextResponse.json({ ok: true, message: `Custom tool "${name}" đã xóa (kèm SKILL.md guide)` })
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid request body' }, { status: 400 })
  }
}
