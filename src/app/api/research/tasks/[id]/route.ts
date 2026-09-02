/**
 * /api/research/tasks/[id] — GET (detail) + PATCH (update task .md + amendments) — TB-13 §2.2
 * =================================================================================
 * Spec:
 *  - TB-13 §2.2 — API route chi tiết task + state update.
 *  - TB-07 — Task .md: Success Criteria BẮT BUỘC trước ASSIGNED (gate TC-13).
 *  - DR-C3 — Append-only amendments: amendmentsJson KHÔNG rewrite, chỉ push entry.
 *
 * Behavior:
 *  GET  /api/research/tasks/{id}                       → 200 { status:'ok', task }
 *                                                         404 nếu null.
 *  PATCH /api/research/tasks/{id} { status?, assignedGroup?,
 *         successCriteria?, amendment?, taskMdPath? } → 200 { status:'ok', task }
 *                                                         404 nếu null.
 *                                                         400 nếu invalid (TC-13 gate).
 *
 * Gate TC-13 (TB-07 §11 Q5): nếu body.status='ASSIGNED' mà successCriteria empty
 * (sau khi merge) → 400 'Success Criteria required before ASSIGN (TC-13)'.
 *
 * Next.js 16 App Router: params là Promise (await bắt buộc).
 */

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import {
  encodeJson,
  decodeTask,
  decodeJsonArray,
  type SuccessCriterion,
  type TaskAmendment,
  type DecodedResearchTask,
} from '@/lib/research-team/types'

export const dynamic = 'force-dynamic'

interface RouteContext {
  params: Promise<{ id: string }>
}

// ============================================================
// GET — DETAIL TASK
// ============================================================

export async function GET(_req: NextRequest, { params }: RouteContext) {
  const { id } = await params
  try {
    const row = await db.researchTask.findUnique({ where: { id } })
    if (!row) {
      return NextResponse.json(
        { status: 'error', error: `Task ${id} không tồn tại` },
        { status: 404 },
      )
    }
    const task = decodeTask(row)
    return NextResponse.json({ status: 'ok', task })
  } catch (err) {
    console.error('[ResearchTasks:id] GET error:', err)
    return NextResponse.json(
      {
        status: 'error',
        error: err instanceof Error ? err.message : 'Lỗi không xác định',
      },
      { status: 500 },
    )
  }
}

// ============================================================
// PATCH — UPDATE TASK (status / assignedGroup / successCriteria / amendment / taskMdPath)
// ============================================================

interface PatchBody {
  status?: string
  assignedGroup?: string
  successCriteria?: SuccessCriterion[]
  amendment?: {
    amendment: string
    reason: string
  }
  taskMdPath?: string
}

export async function PATCH(req: NextRequest, { params }: RouteContext) {
  const { id } = await params

  let body: PatchBody
  try {
    body = (await req.json()) as PatchBody
  } catch {
    return NextResponse.json(
      { status: 'error', error: 'Body JSON không hợp lệ' },
      { status: 400 },
    )
  }

  // Validate body: cần ít nhất 1 trường update
  if (
    body.status === undefined &&
    body.assignedGroup === undefined &&
    body.successCriteria === undefined &&
    body.amendment === undefined &&
    body.taskMdPath === undefined
  ) {
    return NextResponse.json(
      {
        status: 'error',
        error: 'Body cần có ít nhất 1 trường: status | assignedGroup | successCriteria | amendment | taskMdPath',
      },
      { status: 400 },
    )
  }

  try {
    // 0. Check task tồn tại (404 friendly)
    const existing = await db.researchTask.findUnique({ where: { id } })
    if (!existing) {
      return NextResponse.json(
        { status: 'error', error: `Task ${id} không tồn tại` },
        { status: 404 },
      )
    }

    // Build update data
    const updateData: Record<string, unknown> = {}

    // 1. status — direct update (sẽ check TC-13 gate sau khi merge successCriteria)
    if (body.status !== undefined) {
      if (typeof body.status !== 'string' || body.status.trim().length === 0) {
        return NextResponse.json(
          { status: 'error', error: 'Trường "status" phải là chuỗi không rỗng' },
          { status: 400 },
        )
      }
      updateData.status = body.status.trim()
    }

    // 2. assignedGroup — direct update
    if (body.assignedGroup !== undefined) {
      if (typeof body.assignedGroup !== 'string') {
        return NextResponse.json(
          { status: 'error', error: 'Trường "assignedGroup" phải là chuỗi' },
          { status: 400 },
        )
      }
      updateData.assignedGroup = body.assignedGroup.trim() || null
    }

    // 3. taskMdPath — direct update
    if (body.taskMdPath !== undefined) {
      if (typeof body.taskMdPath !== 'string' || body.taskMdPath.trim().length === 0) {
        return NextResponse.json(
          { status: 'error', error: 'Trường "taskMdPath" phải là chuỗi không rỗng' },
          { status: 400 },
        )
      }
      updateData.taskMdPath = body.taskMdPath.trim()
    }

    // 4. successCriteria — update successCriteriaJson (encode)
    if (body.successCriteria !== undefined) {
      if (!Array.isArray(body.successCriteria)) {
        return NextResponse.json(
          { status: 'error', error: 'Trường "successCriteria" phải là mảng' },
          { status: 400 },
        )
      }
      // Validate từng criterion — phải có 'criterion' (text) + 'measure'
      for (const c of body.successCriteria) {
        if (!c || typeof c !== 'object') {
          return NextResponse.json(
            { status: 'error', error: 'Mỗi Success Criterion phải là object' },
            { status: 400 },
          )
        }
        if (!c.criterion || typeof c.criterion !== 'string' || c.criterion.trim().length === 0) {
          return NextResponse.json(
            { status: 'error', error: 'Success Criterion thiếu "criterion" text (gate TC-13)' },
            { status: 400 },
          )
        }
        if (!c.measure || typeof c.measure !== 'string' || c.measure.trim().length === 0) {
          return NextResponse.json(
            { status: 'error', error: `Success Criterion "${c.criterion.slice(0, 30)}..." thiếu "measure" (gate TC-13)` },
            { status: 400 },
          )
        }
      }
      updateData.successCriteriaJson = encodeJson(body.successCriteria)
    }

    // 5. amendment — append amendmentsJson (DR-C3 append-only)
    if (body.amendment !== undefined) {
      if (!body.amendment.amendment || typeof body.amendment.amendment !== 'string') {
        return NextResponse.json(
          { status: 'error', error: 'amendment.amendment phải là chuỗi' },
          { status: 400 },
        )
      }
      if (!body.amendment.reason || typeof body.amendment.reason !== 'string') {
        return NextResponse.json(
          { status: 'error', error: 'amendment.reason phải là chuỗi' },
          { status: 400 },
        )
      }
      const amendments = decodeJsonArray<TaskAmendment>(existing.amendmentsJson)
      amendments.push({
        at: new Date().toISOString(),
        amendment: body.amendment.amendment,
        reason: body.amendment.reason,
      })
      updateData.amendmentsJson = encodeJson(amendments)
    }

    // 6. TC-13 gate (TB-07 §11 Q5): nếu status='ASSIGNED' mà successCriteria empty → 400
    //    (sau khi merge update — nếu successCriteria update, dùng cái mới; else dùng existing)
    const targetStatus = (updateData.status as string) || existing.status
    if (targetStatus === 'ASSIGNED') {
      const targetCriteria: SuccessCriterion[] =
        updateData.successCriteriaJson !== undefined
          ? (body.successCriteria as SuccessCriterion[])
          : decodeJsonArray<SuccessCriterion>(existing.successCriteriaJson)
      if (!targetCriteria || targetCriteria.length === 0) {
        return NextResponse.json(
          {
            status: 'error',
            error: 'Success Criteria required before ASSIGN (TC-13) — task .md phải có ≥ 1 criterion',
          },
          { status: 400 },
        )
      }
    }

    // 7. Apply update
    const updated = await db.researchTask.update({
      where: { id },
      data: updateData,
    })

    const task: DecodedResearchTask = decodeTask(updated)
    return NextResponse.json({ status: 'ok', task })
  } catch (err) {
    console.error('[ResearchTasks:id] PATCH error:', err)
    return NextResponse.json(
      {
        status: 'error',
        error: err instanceof Error ? err.message : 'Lỗi không xác định',
      },
      { status: 500 },
    )
  }
}
