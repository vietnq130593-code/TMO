/**
 * CI-5 (GĐ4, Task 14-c) — GOAL LOOP JOBS API
 * ===========================================
 *
 * Endpoint cho UI (Task 14-e) poll tiến trình job durable goal loop —
 * KHÔNG phụ thuộc flag ENABLE_DURABLE_GOAL_LOOP: GET chỉ đọc DB qua worker
 * view (getJobStatus/listJobs là thuần DB read — worker tắt vẫn trả 200),
 * POST cancel là DB write + flag in-memory (im lặng an toàn khi worker off).
 *
 * GET  /api/goal-loop-jobs?jobId=<id>
 *        → chi tiết 1 job (kèm result projection khi completed)
 *      /api/goal-loop-jobs?sessionId=<sid>
 *        → list job của session, mặc định statuses [queued, running];
 *          ?all=true → mọi status, 50 gần nhất.
 *      /api/goal-loop-jobs (không tham số)
 *        → { jobs: [] } — không scope thì không có gì để liệt kê (fail-open,
 *          không 400 — smoke flag-OFF quy định GET trần phải 200).
 *
 * POST /api/goal-loop-jobs  { jobId, action: 'cancel' }
 *      → hủy 1 job (queued → cancelled ngay; running → DB flag, loop tự thoát
 *        ở vòng check kế; không tồn tại/đã terminal → cancelled: 0, KHÔNG 500)
 *      { sessionId, action: 'cancel_all' }
 *      → hủy mọi job của session (dùng bởi nút Dừng hiện có qua agent-run
 *        route — endpoint này cho UI job-monitor của 14-e).
 *
 * STALE-PRISMA-CLIENT GUARD (pattern 14-d orchestrator): process dev đang chạy
 * có thể giữ Prisma client sinh TRƯỚC lần db:push thêm model GoalLoopJob (14-a)
 * → delegate db.goalLoopJob undefined → TypeError. Khi datasource chưa sẵn
 * sàng: đọc coi như rỗng (list → [], detail → 404), cancel → 0 — KHÔNG 500,
 * tự lành sau restart (client mới luôn có delegate — guard thành dead-code).
 *
 * Pattern error shape + method guard mirror /api/agent-run (route API hiện có:
 * { ok: false, error } status 400/404/500; route chỉ export GET+POST → Next.js
 * tự 405 các method khác).
 */

import { NextRequest, NextResponse } from 'next/server'
import { goalLoopWorker } from '@/lib/goal-loop-worker'
import type { GoalLoopJobStatus, GoalLoopJobInput } from '@/lib/goal-loop-durable-types'
import type { GoalLoopResult } from '@/lib/agent-goal-loop'
import { db } from '@/lib/db'
// REQ-AUDIT FIX2 (2026-10-19) — micro-cache GET + invalidate khi cancel.
// Xem wrapper GET_impl bên dưới cho lý do TTL.
import { withPollCache, invalidatePollCache } from '@/lib/poll-microcache'

export const dynamic = 'force-dynamic'

// ==================== TYPES ====================

/** Result projection khi completed — frontend (14-e) render lượt chat từ đây. */
interface GoalLoopJobResultProjection {
  content: string
  goalLoop?: GoalLoopResult['goalLoop']
  taskSummary?: string
  agentName?: string
}

/** Item trả về cho UI — KHÔNG chứa input/checkpoint raw (quá lớn). */
interface GoalLoopJobApiItem {
  id: string
  sessionId: string
  messageId: string | null
  status: GoalLoopJobStatus
  cyclesDone: number
  progressHint: string | null
  stopReason: string | null
  /** slice 500 chars — đủ chẩn đoán, không phình payload */
  error: string | null
  attempts: number
  cancelRequested: boolean
  cancelRequestedAt: string | null
  heartbeatAt: string | null
  createdAt: string
  startedAt: string | null
  completedAt: string | null
  ageMs: number
  stallWarning: boolean
  /** R43 — tên agent phụ trách (parse từ input) để UI hiện "agent nào đang
 *  làm việc" ngay từ lúc queued/running (không phải đợi completed). */
  agentName?: string
  /** CHỈ khi completed — projection kết quả cho UI render lượt chat */
  result?: GoalLoopJobResultProjection
}

// ==================== HELPERS ====================

/** Slice error 500 chars an toàn (null/undefined → null). */
function sliceError(error: string | null | undefined): string | null {
  if (typeof error !== 'string' || error.length === 0) return null
  return error.slice(0, 500)
}

/** Parse JSON an toàn (hỏng → null — fail-open). */
function safeParseJson<T>(raw: string | null | undefined): T | null {
  if (typeof raw !== 'string' || raw.length === 0) return null
  try {
    return JSON.parse(raw) as T
  } catch { return null }
}

/**
 * STALE-PRISMA-CLIENT GUARD (pattern 14-d): true khi delegate goalLoopJob sẵn
 * sàng. Prisma 6 client là Proxy — capture delegate THẬT qua property access
 * (getOwnPropertyDescriptor không đáng tin) — undefined nghĩa là process này
 * đang giữ client sinh trước db:push của 14-a (restart app để nạp client mới).
 */
function isGoalLoopJobReady(): boolean {
  return !!(db as unknown as Record<string, unknown>).goalLoopJob
}

// ==================== GET ====================

async function GET_impl(request: NextRequest) {
  try {
    const jobId = request.nextUrl.searchParams.get('jobId')
    const sessionId = request.nextUrl.searchParams.get('sessionId')
    const all = request.nextUrl.searchParams.get('all') === 'true'

    // ---- Chi tiết 1 job: ?jobId= ----
    if (jobId) {
      // Stale client (chưa có delegate) → datasource rỗng → coi như không có
      if (!isGoalLoopJobReady()) {
        return NextResponse.json({ ok: false, error: 'job không tồn tại' }, { status: 404 })
      }
      const view = await goalLoopWorker.getJobStatus(jobId)
      if (!view) {
        return NextResponse.json({ ok: false, error: 'job không tồn tại' }, { status: 404 })
      }
      // Supplement từ DB row: cancelRequestedAt (ISO — view worker chỉ có
      // boolean) + input (chỉ để lấy agentName cho result projection — KHÔNG
      // trả input raw). Fail-open: lỗi query → field null, response vẫn 200.
      let cancelRequestedAtIso: string | null = null
      let agentName: string | undefined
      try {
        const row = await db.goalLoopJob.findUnique({
          where: { id: jobId },
          select: { cancelRequestedAt: true, input: true },
        })
        cancelRequestedAtIso = row?.cancelRequestedAt?.toISOString() ?? null
        const jobInput = safeParseJson<GoalLoopJobInput>(row?.input)
        if (jobInput && typeof jobInput.agentName === 'string' && jobInput.agentName.length > 0) {
          agentName = jobInput.agentName
        }
      } catch { /* fail-open — supplement bỏ qua */ }

      const item: GoalLoopJobApiItem = {
        id: view.id,
        sessionId: view.sessionId,
        messageId: view.messageId,
        status: view.status,
        cyclesDone: view.cyclesDone,
        progressHint: view.progressHint,
        stopReason: view.stopReason,
        error: sliceError(view.error),
        attempts: view.attempts,
        cancelRequested: view.cancelRequested,
        cancelRequestedAt: cancelRequestedAtIso,
        heartbeatAt: view.heartbeatAt,
        createdAt: view.createdAt,
        startedAt: view.startedAt,
        completedAt: view.completedAt,
        ageMs: view.ageMs,
        stallWarning: view.stallWarning,
        agentName,
      }
      if (view.status === 'completed' && view.result) {
        item.result = {
          content: view.result.content,
          goalLoop: view.result.goalLoop,
          taskSummary: view.result.taskSummary,
          agentName,
        }
      }
      return NextResponse.json({ ok: true, job: item, serverTs: Date.now() })
    }

    // ---- List theo session: ?sessionId= (mặc định [queued, running]) ----
    if (sessionId) {
      // Stale client (chưa có delegate) → datasource rỗng → list rỗng fail-open
      if (!isGoalLoopJobReady()) {
        return NextResponse.json({ ok: true, jobs: [], count: 0, serverTs: Date.now() })
      }
      const statuses: GoalLoopJobStatus[] | undefined = all ? undefined : ['queued', 'running']
      const views = await goalLoopWorker.listJobs({ sessionId, statuses, limit: 50 })

      // Supplement 1 query batch: cancelRequestedAt (ISO) cho mọi item +
      // result + input.agentName cho item completed (view listJobs không trả
      // result raw theo thiết kế worker — API tự projection). Fail-open.
      const cancelByJob = new Map<string, string | null>()
      const resultByJob = new Map<string, GoalLoopResult>()
      const agentNameByJob = new Map<string, string>()
      if (views.length > 0) {
        try {
          const rows = await db.goalLoopJob.findMany({
            where: { id: { in: views.map(v => v.id) } },
            select: { id: true, cancelRequestedAt: true, result: true, input: true },
          })
          for (const row of rows) {
            cancelByJob.set(row.id, row.cancelRequestedAt?.toISOString() ?? null)
            const res = safeParseJson<GoalLoopResult>(row.result)
            if (res) resultByJob.set(row.id, res)
            const jobInput = safeParseJson<GoalLoopJobInput>(row.input)
            if (jobInput?.agentName) agentNameByJob.set(row.id, jobInput.agentName)
          }
        } catch { /* fail-open — supplement bỏ qua */ }
      }

      const items: GoalLoopJobApiItem[] = views.map(view => {
        const item: GoalLoopJobApiItem = {
          id: view.id,
          sessionId: view.sessionId,
          messageId: view.messageId,
          status: view.status,
          cyclesDone: view.cyclesDone,
          progressHint: view.progressHint,
          stopReason: view.stopReason,
          error: sliceError(view.error),
          attempts: view.attempts,
          cancelRequested: view.cancelRequested,
          cancelRequestedAt: cancelByJob.get(view.id) ?? null,
          heartbeatAt: view.heartbeatAt,
          createdAt: view.createdAt,
          startedAt: view.startedAt,
          completedAt: view.completedAt,
          ageMs: view.ageMs,
          stallWarning: view.stallWarning,
          agentName: agentNameByJob.get(view.id),
        }
        if (view.status === 'completed') {
          const res = resultByJob.get(view.id)
          if (res) {
            item.result = {
              content: res.content,
              goalLoop: res.goalLoop,
              taskSummary: res.taskSummary,
              agentName: agentNameByJob.get(view.id),
            }
          }
        }
        return item
      })
      return NextResponse.json({ ok: true, jobs: items, count: items.length, serverTs: Date.now() })
    }

    // ---- Không tham số → list rỗng (không scope thì không có gì để liệt kê —
    // fail-open 200 theo smoke flag-OFF, không 400 kiểu agent-run GET) ----
    return NextResponse.json({ ok: true, jobs: [], count: 0, serverTs: Date.now() })
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : 'Internal server error' },
      { status: 500 },
    )
  }
}

// ==================== POST (cancel) ====================

// REQ-AUDIT FIX2 (2026-10-19) — micro-cache GET: UI poll jobId 3s khi job
// chạy + panel list. TTL 4s ≈ 1.3× nhịp 3s → ~50% gộp, tiến độ tối đa 4s
// tuổi (chu kỳ goal-loop dài hàng phút — chấp nhận được). POST cancel
// invalidate ngay (UI không thấy trạng thái cancelled cũ).
export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams
  return withPollCache(`glj|${sp.get('jobId') ?? ''}|${sp.get('sessionId') ?? ''}|${sp.get('all') === 'true'}`, 4_000, () => GET_impl(request))
}

export async function POST(request: NextRequest) {
  invalidatePollCache('glj|') // REQ-AUDIT FIX2 — cancel/cancel_all: bỏ cache
  try {
    const body = await request.json().catch(() => null) as {
      jobId?: string
      sessionId?: string
      action?: string
    } | null

    if (body?.action === 'cancel' && body.jobId) {
      // Stale client (chưa có delegate) → không có gì để hủy → cancelled: 0
      // (200, KHÔNG 500). Job không tồn tại/đã terminal → false → cũng 0.
      const ok = isGoalLoopJobReady() ? await goalLoopWorker.cancel(body.jobId) : false
      return NextResponse.json({ ok: true, cancelled: ok ? 1 : 0, serverTs: Date.now() })
    }

    if (body?.action === 'cancel_all' && body.sessionId) {
      const cancelled = isGoalLoopJobReady() ? await goalLoopWorker.cancelSessionJobs(body.sessionId) : 0
      return NextResponse.json({ ok: true, cancelled, serverTs: Date.now() })
    }

    return NextResponse.json(
      { ok: false, error: 'yêu cầu `{ jobId, action: "cancel" }` hoặc `{ sessionId, action: "cancel_all" }`' },
      { status: 400 },
    )
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : 'Internal server error' },
      { status: 500 },
    )
  }
}
