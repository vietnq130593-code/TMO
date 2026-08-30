/**
 * TASK FLOWS API (user request 2026-09-13)
 * ====================================
 * GET    /api/task-flows              — Danh sách task flow (đã parse steps)
 * POST   /api/task-flows              — Tạo flow mới {name, description?, steps, enabled?}
 *
 * Flow do USER tạo qua UI designer (Smolab > Automation); Omega tạo qua tool
 * manage_automation (đường lib — không qua HTTP này).
 */

import { NextRequest, NextResponse } from 'next/server'
import { listTaskFlows, createTaskFlow, validateTaskFlowInput } from '@/lib/task-flows'
import { ensureDbReady } from '@/lib/db-setup'

export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const flows = await listTaskFlows()
    return NextResponse.json({ flows, total: flows.length })
  } catch (err) {
    // Self-heal: bảng TaskFlow chưa tồn tại (DB cũ chưa db:push) → heal + retry
    try {
      await ensureDbReady({ force: true })
      const flows = await listTaskFlows()
      return NextResponse.json({ flows, total: flows.length })
    } catch (retryErr) {
      console.error('[TaskFlows GET] Error:', retryErr)
      return NextResponse.json({ error: 'Không tải được danh sách task flow' }, { status: 500 })
    }
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}))
    const validated = validateTaskFlowInput({
      name: body.name,
      description: body.description,
      steps: body.steps,
      enabled: body.enabled,
      createdBy: body.createdBy || 'user',
    })
    if (!validated.ok) {
      return NextResponse.json({ error: validated.error }, { status: 400 })
    }
    const flow = await createTaskFlow(validated.data)
    return NextResponse.json({ flow }, { status: 201 })
  } catch (err) {
    console.error('[TaskFlows POST] Error:', err)
    return NextResponse.json({ error: 'Không tạo được task flow' }, { status: 500 })
  }
}
