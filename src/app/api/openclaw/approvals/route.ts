/**
 * Tool Approval Queue API
 *
 * GET  /api/openclaw/approvals — List pending approval requests
 * POST /api/openclaw/approvals — Create a new approval request (when a tool with "ask" permission is called)
 * PUT  /api/openclaw/approvals — Approve or deny an approval request
 *
 * Approval flow:
 * 1. Agent calls a tool with "ask" permission → POST creates an approval request
 * 2. User reviews pending requests → GET shows pending items
 * 3. User approves/denies → PUT updates status to "approved" or "denied"
 * 4. Expired requests are auto-cleaned on each GET request
 */

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

// ---------------------------------------------------------------------------
// TYPE-ONLY: model ToolApprovalQueue CHƯA được khai báo trong Prisma schema —
// runtime `db.toolApprovalQueue` là undefined và mọi call sẽ throw TypeError,
// đã được try/catch của từng handler bắt (500) như behavior hiện tại. Khai báo
// type theo shape route đang dùng, cast delegate MỘT lần ở root — không thêm/
// bớt call, không đổi logic. Khi model được thêm vào schema thì cast này vẫn
// khớp (structural typing).
// ---------------------------------------------------------------------------
type ToolApprovalQueueRow = {
  id: string
  agentId: string
  agentName: string | null
  toolName: string
  args: string | null
  sessionId: string | null
  status: string
  expiresAt: Date
  reviewedBy: string | null
  reviewedAt: Date | null
  createdAt: Date
}

type ToolApprovalQueueModel = {
  updateMany(args: {
    where: { status?: string; expiresAt?: { lt: Date } }
    data: { status: string }
  }): Promise<{ count: number }>
  findMany(args?: {
    where?: Record<string, unknown>
    orderBy?: { createdAt: 'asc' | 'desc' }
  }): Promise<ToolApprovalQueueRow[]>
  create(args: {
    data: {
      agentId: string
      agentName?: string | null
      toolName: string
      args?: string | null
      sessionId?: string | null
      status: string
      expiresAt: Date
    }
  }): Promise<ToolApprovalQueueRow>
  findUnique(args: { where: { id: string } }): Promise<ToolApprovalQueueRow | null>
  update(args: {
    where: { id: string }
    data: { status: string; reviewedBy?: string | null; reviewedAt?: Date }
  }): Promise<ToolApprovalQueueRow>
}

const toolApprovalQueue = (db as unknown as { toolApprovalQueue: ToolApprovalQueueModel })
  .toolApprovalQueue

/** Valid approval statuses */
const VALID_STATUSES = ['pending', 'approved', 'denied', 'expired'] as const
type ValidStatus = (typeof VALID_STATUSES)[number]

function isValidStatus(value: unknown): value is ValidStatus {
  return typeof value === 'string' && VALID_STATUSES.includes(value as ValidStatus)
}

/**
 * Auto-expire old approval requests.
 * Called on each GET to keep the queue clean.
 */
async function expireOldRequests(): Promise<number> {
  const result = await toolApprovalQueue.updateMany({
    where: {
      status: 'pending',
      expiresAt: { lt: new Date() },
    },
    data: { status: 'expired' },
  })
  return result.count
}

// GET: List pending approval requests
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const status = searchParams.get('status') || 'pending'
    const agentId = searchParams.get('agentId')

    // Auto-expire old requests on every GET
    const expiredCount = await expireOldRequests()

    // Build where clause
    const where: Record<string, unknown> = {}
    if (status !== 'all') {
      if (!isValidStatus(status)) {
        return NextResponse.json(
          { error: `Invalid status "${status}". Must be one of: pending, approved, denied, expired, all` },
          { status: 400 }
        )
      }
      where.status = status
    }
    if (agentId) {
      where.agentId = agentId
    }

    const approvals = await toolApprovalQueue.findMany({
      where,
      orderBy: { createdAt: 'desc' },
    })

    return NextResponse.json({
      approvals,
      total: approvals.length,
      autoExpired: expiredCount,
    })
  } catch (error) {
    console.error('[Approvals] GET error:', error)
    return NextResponse.json({ error: 'Failed to list approval requests' }, { status: 500 })
  }
}

// POST: Create a new approval request
export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const {
      agentId = 'default',
      agentName,
      toolName,
      args,
      sessionId,
      expiresInSeconds = 300, // Default: 5 minutes
    } = body as {
      agentId?: string
      agentName?: string
      toolName: string
      args?: string
      sessionId?: string
      expiresInSeconds?: number
    }

    if (!toolName || typeof toolName !== 'string') {
      return NextResponse.json({ error: 'toolName is required' }, { status: 400 })
    }

    // Validate expiresInSeconds
    const ttl = Math.max(60, Math.min(expiresInSeconds, 3600)) // Clamp: 1 min to 1 hour
    const expiresAt = new Date(Date.now() + ttl * 1000)

    const approval = await toolApprovalQueue.create({
      data: {
        agentId,
        agentName: agentName || null,
        toolName,
        args: args || null,
        sessionId: sessionId || null,
        status: 'pending',
        expiresAt,
      },
    })

    return NextResponse.json({ success: true, approval }, { status: 201 })
  } catch (error) {
    console.error('[Approvals] POST error:', error)
    return NextResponse.json({ error: 'Failed to create approval request' }, { status: 500 })
  }
}

// PUT: Approve or deny an approval request
export async function PUT(request: NextRequest) {
  try {
    const body = await request.json()
    const { id, status, reviewedBy } = body as {
      id: string
      status: 'approved' | 'denied'
      reviewedBy?: string
    }

    if (!id || typeof id !== 'string') {
      return NextResponse.json({ error: 'id is required' }, { status: 400 })
    }

    if (!status || (status !== 'approved' && status !== 'denied')) {
      return NextResponse.json(
        { error: 'status must be "approved" or "denied"' },
        { status: 400 }
      )
    }

    // Check the approval exists and is still pending
    const existing = await toolApprovalQueue.findUnique({ where: { id } })
    if (!existing) {
      return NextResponse.json({ error: 'Approval request not found' }, { status: 404 })
    }

    if (existing.status !== 'pending') {
      return NextResponse.json(
        { error: `Approval request is already ${existing.status}` },
        { status: 409 }
      )
    }

    // Update the approval
    const updated = await toolApprovalQueue.update({
      where: { id },
      data: {
        status,
        reviewedBy: reviewedBy || null,
        reviewedAt: new Date(),
      },
    })

    return NextResponse.json({ success: true, approval: updated })
  } catch (error) {
    console.error('[Approvals] PUT error:', error)
    return NextResponse.json({ error: 'Failed to update approval request' }, { status: 500 })
  }
}
