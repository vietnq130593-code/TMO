/**
 * GET    /api/tools/[name] — Return a single custom tool by name
 * PUT    /api/tools/[name] — Update a custom tool (enabled, handlerCode, description, etc.)
 * DELETE /api/tools/[name] — Deregister a custom tool (delete from DB + unregister from gateway)
 */

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { unregisterCustomTool, registerCustomTool, type CustomToolEntry } from '@/lib/custom-tool-registry'
import type { CustomTool } from '@prisma/client'

/** CustomTool + các field meta tùy chọn (lastTestedAt/lastUsedAt/testArgs chưa có trong
 *  schema — runtime là undefined, giữ nguyên response JSON cũ qua type mở rộng) */
type CustomToolWithMeta = CustomTool & {
  lastTestedAt?: Date | string | null
  lastUsedAt?: Date | string | null
  testArgs?: string | null
}

export const dynamic = 'force-dynamic'

interface RouteContext {
  params: Promise<{ name: string }>
}

/**
 * GET — Return a single custom tool by name
 */
export async function GET(
  _request: NextRequest,
  context: RouteContext
) {
  try {
    const { name } = await context.params

    const tool = await db.customTool.findUnique({
      where: { name },
    })

    if (!tool) {
      return NextResponse.json(
        { error: `Custom tool "${name}" not found` },
        { status: 404 }
      )
    }

    // Parse parameters JSON for convenience
    let parameters: Record<string, unknown>
    try {
      parameters = JSON.parse(tool.parameters)
    } catch {
      parameters = { type: 'object', properties: {} }
    }

    return NextResponse.json({
      tool: {
        id: tool.id,
        name: tool.name,
        description: tool.description,
        parameters,
        handlerCode: tool.handlerCode,
        version: tool.version,
        source: tool.source,
        category: tool.category,
        enabled: tool.enabled,
        isPublic: tool.isPublic,
        skillSlug: tool.skillSlug,
        callCount: tool.callCount,
        lastTestedAt: (tool as CustomToolWithMeta).lastTestedAt,
        lastUsedAt: (tool as CustomToolWithMeta).lastUsedAt,
        testArgs: (tool as CustomToolWithMeta).testArgs,
        createdAt: tool.createdAt,
        updatedAt: tool.updatedAt,
      },
    })
  } catch (err) {
    console.error('[Tools:GetByName] Error:', err)
    return NextResponse.json(
      { error: 'Failed to fetch tool', detail: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 }
    )
  }
}

/**
 * PUT — Update a custom tool by name
 *
 * Accepts partial update:
 *   { description?, handlerCode?, parameters?, enabled?, version?, category?, isPublic? }
 *
 * Updates the DB record and re-syncs the in-memory registry.
 */
export async function PUT(
  request: NextRequest,
  context: RouteContext
) {
  try {
    const { name } = await context.params

    // Check if tool exists
    const existing = await db.customTool.findUnique({
      where: { name },
    })

    if (!existing) {
      return NextResponse.json(
        { error: `Custom tool "${name}" not found` },
        { status: 404 }
      )
    }

    const body = await request.json()

    // Build update data (only include fields that are provided)
    const updateData: Record<string, unknown> = {}

    if (body.description !== undefined && typeof body.description === 'string') {
      updateData.description = body.description
    }
    if (body.handlerCode !== undefined && typeof body.handlerCode === 'string') {
      // Validate handler code syntax if provided
      if (body.handlerCode.trim().length > 0) {
        try {
          new Function('args', 'sandbox', body.handlerCode)
        } catch (err) {
          return NextResponse.json(
            { error: `handlerCode has a syntax error: ${err instanceof Error ? err.message : 'Invalid JavaScript'}` },
            { status: 400 }
          )
        }
      }
      updateData.handlerCode = body.handlerCode
    }
    if (body.parameters !== undefined && typeof body.parameters === 'object') {
      const params = body.parameters as Record<string, unknown>
      if (params.type !== 'object' || !params.properties) {
        return NextResponse.json(
          { error: 'parameters must have type="object" and a "properties" object' },
          { status: 400 }
        )
      }
      updateData.parameters = JSON.stringify(params)
    }
    if (body.enabled !== undefined && typeof body.enabled === 'boolean') {
      updateData.enabled = body.enabled
    }
    if (body.version !== undefined && typeof body.version === 'string') {
      updateData.version = body.version
    }
    if (body.category !== undefined && typeof body.category === 'string') {
      updateData.category = body.category
    }
    if (body.isPublic !== undefined && typeof body.isPublic === 'boolean') {
      updateData.isPublic = body.isPublic
    }

    // If no fields to update, return current tool
    if (Object.keys(updateData).length === 0) {
      return NextResponse.json(
        { error: 'No valid fields to update. Provide at least one of: description, handlerCode, parameters, enabled, version, category, isPublic' },
        { status: 400 }
      )
    }

    // Update in DB
    const updated = await db.customTool.update({
      where: { name },
      data: updateData,
    })

    // Re-sync in-memory registry:
    // If tool is enabled, update/re-register it. If disabled, unregister it.
    if (updated.enabled) {
      let parameters: Record<string, unknown>
      try {
        parameters = JSON.parse(updated.parameters)
      } catch {
        parameters = { type: 'object', properties: {} }
      }

      const toolEntry: CustomToolEntry = {
        id: updated.id,
        name: updated.name,
        description: updated.description,
        parameters,
        handlerCode: updated.handlerCode,
        version: updated.version,
        source: updated.source,
        category: updated.category,
        enabled: updated.enabled,
        isPublic: updated.isPublic,
        skillSlug: updated.skillSlug,
        callCount: updated.callCount,
        createdAt: updated.createdAt,
        updatedAt: updated.updatedAt,
      }

      // Re-register in memory (this updates the registry entry)
      await registerCustomTool(toolEntry, true)
    } else {
      // Tool was disabled — remove from in-memory registry
      await unregisterCustomTool(name)
    }

    // Parse parameters for response
    let responseParams: Record<string, unknown>
    try {
      responseParams = JSON.parse(updated.parameters)
    } catch {
      responseParams = { type: 'object', properties: {} }
    }

    return NextResponse.json({
      success: true,
      tool: {
        id: updated.id,
        name: updated.name,
        description: updated.description,
        parameters: responseParams,
        handlerCode: updated.handlerCode,
        version: updated.version,
        source: updated.source,
        category: updated.category,
        enabled: updated.enabled,
        isPublic: updated.isPublic,
        skillSlug: updated.skillSlug,
        callCount: updated.callCount,
        lastTestedAt: (updated as CustomToolWithMeta).lastTestedAt,
        lastUsedAt: (updated as CustomToolWithMeta).lastUsedAt,
        testArgs: (updated as CustomToolWithMeta).testArgs,
        createdAt: updated.createdAt,
        updatedAt: updated.updatedAt,
      },
    })
  } catch (err) {
    console.error('[Tools:Update] Error:', err)
    return NextResponse.json(
      { error: 'Failed to update tool', detail: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 }
    )
  }
}

/**
 * DELETE — Deregister a custom tool by name
 * Removes from DB + unregisters from gateway registry
 */
export async function DELETE(
  _request: NextRequest,
  context: RouteContext
) {
  try {
    const { name } = await context.params

    // Check if tool exists
    const tool = await db.customTool.findUnique({
      where: { name },
    })

    if (!tool) {
      return NextResponse.json(
        { error: `Custom tool "${name}" not found` },
        { status: 404 }
      )
    }

    // Unregister from in-memory registry + Gateway
    const unregResult = await unregisterCustomTool(name)

    // Delete from DB
    await db.customTool.delete({
      where: { name },
    })

    return NextResponse.json({
      deleted: true,
      tool: {
        id: tool.id,
        name: tool.name,
        description: tool.description,
      },
      unregistered: unregResult.unregistered,
    })
  } catch (err) {
    console.error('[Tools:Delete] Error:', err)
    return NextResponse.json(
      { error: 'Failed to delete tool', detail: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 }
    )
  }
}
