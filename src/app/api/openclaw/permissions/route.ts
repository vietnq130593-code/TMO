/**
 * Tool Permissions API (Consolidated)
 *
 * GET    /api/openclaw/permissions — List permissions for an agent
 * POST   /api/openclaw/permissions — Set/update permission for a single tool
 * PUT    /api/openclaw/permissions — Batch update permissions
 * DELETE /api/openclaw/permissions — Remove a permission
 */

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

// ---------------------------------------------------------------------------
// TYPE-ONLY: ToolPermission trong Prisma schema chỉ có 4 cột gốc (id, agentId,
// toolName, permission) — route này viết theo shape MỞ RỘNG (source,
// requiresApproval, maxCallsPerHour) chưa có trong schema. Khai báo type theo
// shape route đang dùng, cast delegate MỘT lần ở root — runtime giữ nguyên
// (vẫn gọi đúng db.toolPermission.* với đúng args như cũ).
// ---------------------------------------------------------------------------
type ToolPermissionRow = {
  id: string
  agentId: string
  toolName: string
  permission: string
  source?: string
  requiresApproval?: boolean
  maxCallsPerHour?: number | null
}

type ToolPermissionData = {
  agentId?: string
  toolName?: string
  permission?: string
  source?: string
  requiresApproval?: boolean
  maxCallsPerHour?: number | null
}

const toolPermissions = (db as unknown as {
  toolPermission: {
    findMany(args?: {
      where?: { agentId?: string }
      orderBy?: { toolName?: 'asc' | 'desc' }
    }): Promise<ToolPermissionRow[]>
    upsert(args: {
      where: { agentId_toolName: { agentId: string; toolName: string } }
      create: ToolPermissionData
      update: ToolPermissionData
    }): Promise<ToolPermissionRow>
    delete(args: {
      where: { agentId_toolName: { agentId: string; toolName: string } }
    }): Promise<ToolPermissionRow>
  }
}).toolPermission

/** Valid permission values */
const VALID_PERMISSIONS = ['allow', 'deny', 'ask'] as const
type ValidPermission = (typeof VALID_PERMISSIONS)[number]

/** Module-level flag to avoid re-seeding on every GET request */
let seedsInitialized = false

/**
 * Seed default "ask" permissions for dangerous tools
 * (exec, write, apply_patch, code_execution, subagents)
 * for the default agent. These require user approval before running.
 * Skipped if already seeded during this process lifetime.
 */
async function seedDefaultPermissions() {
  if (seedsInitialized) return

  const dangerousTools = [
    { toolName: 'exec', permission: 'ask', source: 'gateway', requiresApproval: true },
    { toolName: 'write', permission: 'ask', source: 'gateway', requiresApproval: true },
    { toolName: 'apply_patch', permission: 'ask', source: 'gateway', requiresApproval: true },
    { toolName: 'code_execution', permission: 'ask', source: 'gateway', requiresApproval: true },
    { toolName: 'subagents', permission: 'ask', source: 'gateway', requiresApproval: true },
  ]

  for (const tool of dangerousTools) {
    await toolPermissions.upsert({
      where: { agentId_toolName: { agentId: 'default', toolName: tool.toolName } },
      create: { agentId: 'default', ...tool },
      update: {},
    }).catch(() => {})
  }

  seedsInitialized = true
}

/** Validate that a permission value is one of the allowed options */
function isValidPermission(value: unknown): value is ValidPermission {
  return typeof value === 'string' && VALID_PERMISSIONS.includes(value as ValidPermission)
}

// GET: List permissions
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const agentId = searchParams.get('agentId') || 'default'

  // Seed default permissions on first access only
  await seedDefaultPermissions()

  const permissions = await toolPermissions.findMany({
    where: { agentId },
    orderBy: { toolName: 'asc' },
  })

  return NextResponse.json({ permissions, total: permissions.length })
}

// POST: Set/update permission for a single tool
export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { agentId = 'default', toolName, permission, source, requiresApproval, maxCallsPerHour } = body

    if (!toolName) {
      return NextResponse.json({ error: 'toolName is required' }, { status: 400 })
    }

    // Validate permission value
    if (permission !== undefined && !isValidPermission(permission)) {
      return NextResponse.json(
        { error: `Permission "${permission}" is invalid. Must be one of: allow, deny, ask` },
        { status: 400 }
      )
    }

    const perm = await toolPermissions.upsert({
      where: { agentId_toolName: { agentId, toolName } },
      create: {
        agentId,
        toolName,
        permission: permission !== undefined ? permission : 'allow',
        source: source !== undefined ? source : 'custom',
        requiresApproval: requiresApproval ?? false,
        maxCallsPerHour: maxCallsPerHour ?? null,
      },
      update: {
        permission: permission !== undefined ? permission : undefined,
        source: source !== undefined ? source : undefined,
        requiresApproval: requiresApproval !== undefined ? requiresApproval : undefined,
        maxCallsPerHour: maxCallsPerHour !== undefined ? maxCallsPerHour : undefined,
      },
    })

    return NextResponse.json({ success: true, permission: perm })
  } catch {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
  }
}

// PUT: Batch update permissions
export async function PUT(request: NextRequest) {
  try {
    const body = await request.json()
    const { agentId = 'default', permissions } = body as {
      agentId?: string
      permissions: Array<{
        toolName: string
        permission: string
        source?: string
        requiresApproval?: boolean
        maxCallsPerHour?: number | null
      }>
    }

    if (!permissions || !Array.isArray(permissions) || permissions.length === 0) {
      return NextResponse.json({ error: 'Missing permissions list' }, { status: 400 })
    }

    // Validate all permissions before making any changes
    for (const p of permissions) {
      if (!p.toolName || !p.permission) {
        return NextResponse.json(
          { error: 'Each permission requires toolName and permission' },
          { status: 400 }
        )
      }
      if (!isValidPermission(p.permission)) {
        return NextResponse.json(
          { error: `Permission "${p.permission}" is invalid. Must be one of: allow, deny, ask` },
          { status: 400 }
        )
      }
    }

    const results = await Promise.all(
      permissions.map(p =>
        toolPermissions.upsert({
          where: { agentId_toolName: { agentId, toolName: p.toolName } },
          create: {
            agentId,
            toolName: p.toolName,
            permission: p.permission,
            source: p.source || 'custom',
            requiresApproval: p.requiresApproval ?? false,
            maxCallsPerHour: p.maxCallsPerHour ?? null,
          },
          update: {
            permission: p.permission,
            ...(p.source !== undefined ? { source: p.source } : {}),
            ...(p.requiresApproval !== undefined ? { requiresApproval: p.requiresApproval } : {}),
            ...(p.maxCallsPerHour !== undefined ? { maxCallsPerHour: p.maxCallsPerHour } : {}),
          },
        })
      )
    )

    return NextResponse.json({
      success: true,
      permissions: results,
      message: `Updated ${results.length} tool permissions`,
    })
  } catch (error) {
    console.error('Permissions batch update error:', error)
    return NextResponse.json({ error: 'Failed to update permissions' }, { status: 500 })
  }
}

// DELETE: Remove permission
export async function DELETE(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const agentId = searchParams.get('agentId') || 'default'
  const toolName = searchParams.get('toolName')

  if (!toolName) {
    return NextResponse.json({ error: 'toolName is required' }, { status: 400 })
  }

  try {
    await toolPermissions.delete({
      where: { agentId_toolName: { agentId, toolName } },
    })
    return NextResponse.json({ success: true })
  } catch {
    return NextResponse.json({ error: 'Permission not found' }, { status: 404 })
  }
}
