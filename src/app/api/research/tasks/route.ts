/**
 * /api/research/tasks — GET list tasks theo missionId — TB-13 §2.2 + Task 3-fix WORK 7c
 * =================================================================================
 * Spec:
 *  - TASK 3-fix WORK 7c (audit C.18 fix): UI mission-detail Tasks tab trước đây
 *    là dead-end Alert vì API chỉ có GET /tasks/[id] (single). Giờ có GET /tasks
 *    list theo missionId để UI render task table.
 *
 * Behavior:
 *  GET /api/research/tasks?missionId=X → 200 { status:'ok', tasks: DecodedResearchTask[], total }
 *  GET /api/research/tasks            → 200 { status:'ok', tasks: [], total: 0 } (no missionId)
 *
 * Next.js 16 App Router — dynamic='force-dynamic' (Prisma query mỗi request).
 */

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { decodeTask, type DecodedResearchTask } from '@/lib/research-team/types'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url)
    const missionId = url.searchParams.get('missionId')

    if (!missionId || !missionId.trim()) {
      // No missionId → return empty (UI render "no tasks yet")
      return NextResponse.json({
        status: 'ok',
        tasks: [] as DecodedResearchTask[],
        total: 0,
      })
    }

    const rows = await db.researchTask.findMany({
      where: { missionId },
      orderBy: { partIdx: 'asc' },
    })

    const tasks = rows.map(decodeTask)

    return NextResponse.json({
      status: 'ok',
      tasks,
      total: tasks.length,
    })
  } catch (err) {
    console.error('[ResearchTasks] GET error:', err)
    return NextResponse.json(
      {
        status: 'error',
        error: err instanceof Error ? err.message : 'Lỗi không xác định',
      },
      { status: 500 },
    )
  }
}
