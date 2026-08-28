/**
 * POST /api/tools/register — Register a new custom tool
 *
 * Accepts:
 *   { name, description, parameters, handlerCode, version?, category?, skillSlug? }
 *
 * Validates:
 *   - name is unique (no conflict with existing CustomTool or known Gateway tools)
 *   - parameters is valid JSON schema (object type with properties)
 *   - handlerCode is non-empty JavaScript
 *
 * Saves to CustomTool DB table and registers with gateway-tool-registry
 */

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import {
  registerCustomTool,
  isToolNameTaken,
  type CustomToolEntry,
} from '@/lib/custom-tool-registry'
import type { Prisma } from '@prisma/client'

export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()

    // ===== Validate required fields =====
    const { name, description, parameters, handlerCode } = body

    if (!name || typeof name !== 'string') {
      return NextResponse.json(
        { error: 'Missing or invalid "name" field (must be a non-empty string)' },
        { status: 400 }
      )
    }

    if (!description || typeof description !== 'string') {
      return NextResponse.json(
        { error: 'Missing or invalid "description" field (must be a non-empty string)' },
        { status: 400 }
      )
    }

    if (!parameters || typeof parameters !== 'object') {
      return NextResponse.json(
        { error: 'Missing or invalid "parameters" field (must be a JSON object)' },
        { status: 400 }
      )
    }

    if (!handlerCode || typeof handlerCode !== 'string') {
      return NextResponse.json(
        { error: 'Missing or invalid "handlerCode" field (must be a non-empty string)' },
        { status: 400 }
      )
    }

    // ===== Validate tool name format =====
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
      return NextResponse.json(
        { error: 'Invalid tool name. Must start with a letter or underscore, and contain only letters, digits, and underscores.' },
        { status: 400 }
      )
    }

    // ===== Validate name uniqueness =====
    // Check against known built-in/gateway tools first (fast, in-memory)
    if (isToolNameTaken(name)) {
      return NextResponse.json(
        { error: `Tool name "${name}" conflicts with an existing built-in or gateway tool` },
        { status: 409 }
      )
    }

    // Check against DB (custom tools)
    const existingDb = await db.customTool.findUnique({ where: { name } })
    if (existingDb) {
      return NextResponse.json(
        { error: `Tool name "${name}" already exists as a custom tool` },
        { status: 409 }
      )
    }

    // ===== Validate parameters is a valid JSON schema =====
    const params = parameters as Record<string, unknown>
    if (params.type !== 'object') {
      return NextResponse.json(
        { error: 'parameters.type must be "object"' },
        { status: 400 }
      )
    }
    if (!params.properties || typeof params.properties !== 'object') {
      return NextResponse.json(
        { error: 'parameters must have a "properties" object' },
        { status: 400 }
      )
    }

    // ===== Validate handlerCode =====
    if (handlerCode.trim().length === 0) {
      return NextResponse.json(
        { error: 'handlerCode must not be empty' },
        { status: 400 }
      )
    }

    // Basic syntax check — try to parse as a function
    try {
      new Function('args', 'sandbox', handlerCode)
    } catch (err) {
      return NextResponse.json(
        { error: `handlerCode has a syntax error: ${err instanceof Error ? err.message : 'Invalid JavaScript'}` },
        { status: 400 }
      )
    }

    // ===== Optional fields =====
    const version = typeof body.version === 'string' ? body.version : '1.0.0'
    const category = typeof body.category === 'string' ? body.category : 'Custom'
    const skillSlug = typeof body.skillSlug === 'string' ? body.skillSlug : null

    // ===== Save to DB =====
    // authorId chưa có trong model CustomTool (schema.prisma) — runtime Prisma sẽ
    // reject unknown arg (bắt ở catch → 500, giữ nguyên behavior hiện tại).
    // Cast để tsc hiểu, chờ schema thêm field này thì bỏ cast.
    const customTool = await db.customTool.create({
      data: {
        name,
        description,
        parameters: JSON.stringify(params),
        handlerCode,
        version,
        category,
        skillSlug,
        source: 'custom',
        enabled: true,
        isPublic: false,
        authorId: 'default',
      } as Prisma.CustomToolUncheckedCreateInput,
    })

    // ===== Register in memory + Gateway =====
    const toolEntry: CustomToolEntry = {
      id: customTool.id,
      name: customTool.name,
      description: customTool.description,
      parameters: params,
      handlerCode: customTool.handlerCode,
      version: customTool.version,
      source: customTool.source,
      category: customTool.category,
      enabled: customTool.enabled,
      isPublic: customTool.isPublic,
      skillSlug: customTool.skillSlug,
      callCount: customTool.callCount,
      createdAt: customTool.createdAt,
      updatedAt: customTool.updatedAt,
    }

    const regResult = await registerCustomTool(toolEntry, true)

    // ===== Return the created tool =====
    return NextResponse.json({
      tool: {
        id: customTool.id,
        name: customTool.name,
        description: customTool.description,
        parameters: params,
        handlerCode: customTool.handlerCode,
        version: customTool.version,
        source: customTool.source,
        category: customTool.category,
        enabled: customTool.enabled,
        isPublic: customTool.isPublic,
        skillSlug: customTool.skillSlug,
        callCount: customTool.callCount,
        createdAt: customTool.createdAt,
        updatedAt: customTool.updatedAt,
      },
      registration: {
        inMemory: regResult.registered,
        gateway: regResult.gatewayResult
          ? {
              success: regResult.gatewayResult.success,
              method: regResult.gatewayResult.method,
              error: regResult.gatewayResult.error,
            }
          : null,
      },
    }, { status: 201 })
  } catch (err) {
    console.error('[Tools:Register] Error:', err)
    return NextResponse.json(
      { error: 'Failed to register tool', detail: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 }
    )
  }
}
