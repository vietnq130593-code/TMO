/**
 * TASK FLOW DETAIL API (user request 2026-09-13)
 * ====================================
 * GET    /api/task-flows/[id]             — Chi tiết 1 flow
 * PUT    /api/task-flows/[id]             — Cập nhật {name?, description?, steps?, enabled?}
 * DELETE /api/task-flows/[id]             — Xóa flow
 * POST   /api/task-flows/[id]             — Chạy ngay (manual trigger)
 *
 * Đây là đường USER tinh chỉnh flow (UI designer). Omega tinh chỉnh qua tool
 * manage_automation action=update_flow (đường lib — cùng hàm updateTaskFlow).
 */

import { NextRequest, NextResponse } from 'next/server'
import { getTaskFlow, updateTaskFlow, deleteTaskFlow, runTaskFlow, validateTaskFlowInput, type TaskFlowStep } from '@/lib/task-flows'

export const dynamic = 'force-dynamic'

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const flow = await getTaskFlow(id)
    if (!flow) return NextResponse.json({ error: 'Không tìm thấy task flow' }, { status: 404 })
    return NextResponse.json({ flow })
  } catch (err) {
    console.error('[TaskFlow GET] Error:', err)
    return NextResponse.json({ error: 'Không tải được task flow' }, { status: 500 })
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const body = await request.json().catch(() => ({}))
    const patch: { name?: string; description?: string; steps?: TaskFlowStep[]; enabled?: boolean } = {}
    if (body.name !== undefined) patch.name = String(body.name)
    if (body.description !== undefined) patch.description = String(body.description)
    if (body.enabled !== undefined) patch.enabled = Boolean(body.enabled)
    if (body.steps !== undefined) {
      // Steps phải qua validate đầy đủ (đổi trigger → tính lại nextRunAt)
      const validated = validateTaskFlowInput({
        name: body.name ?? '(check)',
        description: body.description,
        steps: body.steps,
        enabled: body.enabled ?? true,
      })
      if (!validated.ok) return NextResponse.json({ error: validated.error }, { status: 400 })
      patch.steps = validated.data.steps
    }
    const flow = await updateTaskFlow(id, patch)
    if (!flow) return NextResponse.json({ error: 'Không tìm thấy task flow' }, { status: 404 })
    return NextResponse.json({ flow })
  } catch (err) {
    console.error('[TaskFlow PUT] Error:', err)
    return NextResponse.json({ error: 'Không cập nhật được task flow' }, { status: 500 })
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const ok = await deleteTaskFlow(id)
    if (!ok) return NextResponse.json({ error: 'Không tìm thấy task flow' }, { status: 404 })
    return NextResponse.json({ success: true })
  } catch (err) {
    console.error('[TaskFlow DELETE] Error:', err)
    return NextResponse.json({ error: 'Không xóa được task flow' }, { status: 500 })
  }
}

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const result = await runTaskFlow(id, { trigger: 'manual' })
    return NextResponse.json({ result })
  } catch (err) {
    console.error('[TaskFlow RUN] Error:', err)
    return NextResponse.json({ error: 'Không chạy được task flow' }, { status: 500 })
  }
}
