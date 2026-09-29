/**
 * OpenClaw Sessions API — CRUD Session Management
 *
 * GET    ?action=list                        — List sessions from SQLite
 * POST   ?action=create                      — Create new session
 * PATCH  ?action=rename                      — Rename session (update title)
 * DELETE ?action=delete&sessionId=xxx         — Delete session
 */

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { hasActiveRun, cancelSessionRuns } from '@/lib/agent-run-tracker'
// FIX 2026-09-29 — nguồn sự thật hoạt động dùng chung (GoalLoopJob DB +
// run tracker) cho hasActiveRun + activeSessions (xem lib/active-sessions.ts)
import { getActiveSessionsContext } from '@/lib/active-sessions'
// SESSION TOMBSTONE (user request 2026-09-08): đánh dấu session đã xóa để chat
// route KHÔNG upsert/persist lại (chống "hồi sinh" phiên đã xóa).
import { markSessionDeleted, clearSessionTombstone, isSessionDeletedDeep } from '@/lib/session-tombstone'

export const dynamic = 'force-dynamic'

// Title length limits
const TITLE_MIN = 1
const TITLE_MAX = 200

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const action = searchParams.get('action') || 'list'

  if (action === 'list') {
    try {
      // Support filtering by agentProfileId and teamName (needed for Agent/Team session isolation)
      const agentProfileId = searchParams.get('agentProfileId')
      const teamName = searchParams.get('teamName')

      const where: Record<string, unknown> = {}
      if (agentProfileId) where.agentProfileId = agentProfileId
      if (teamName) where.teamName = teamName

      // ============================================================
      // USER REPORT 2026-09-29 ("session đang vận hành không hiển thị
      // ra, chỉ hiện những session đang đứng im"): đọc kèm nguồn sự thật
      // hoạt động (GoalLoopJob queued/running + run tracker) — chi tiết
      // trong src/lib/active-sessions.ts.
      // ============================================================
      const [sessions, activeCtx] = await Promise.all([
        db.agentSession.findMany({ where, orderBy: { updatedAt: 'desc' }, take: 50 }),
        getActiveSessionsContext(),
      ])

      // Get sessions from SQLite
      // FIX SLOW AGENT/SESSION LIST (user report 2026-09-08: "mỗi khi khởi
      // động lại, load danh sách agents khá lâu"):
      // Trước đây route gọi gatewayListSessions() — hàm này ensureGatewayRunning()
      // → LAZY-SPAWN openclaw-gateway và chờ health tới 45s (Windows local:
      // binary không chạy được → chờ đủ 45s RỒI fail). UI gọi route này NGAY
      // KHI MOUNT (+ mỗi 30s) và CHỈ dùng `sessions` (SQLite) — KHÔNG bao giờ
      // đọc `gatewaySessions`. Kết quả: mọi lần mở app/reload đều chặn 8-45s
      // + tiêu ~340MB RAM spawn gateway không ai dùng, 10 phút sau idle-shutdown
      // rồi lặp lại. Bỏ hẳn call — session list là dữ liệu SQLite thuần.
      const gatewaySessions: unknown[] = []

      return NextResponse.json({
        sessions: sessions.map(s => ({
          id: s.id,
          sessionId: s.sessionId,
          title: s.title || 'Untitled Session',
          model: s.model,
          provider: s.provider,
          messageCount: s.messageCount,
          agentProfileId: s.agentProfileId,
          teamMode: s.teamMode,
          teamName: s.teamName,
          createdAt: s.createdAt,
          updatedAt: s.updatedAt,
          // USER REQUEST 2026-09-01: agent/team vẫn đang chạy dở ở session này?
          // (in-memory run tracker — hiển thị chấm xanh nhấp nháy ở dropdown)
          // FIX 2026-09-29: cộng thêm nguồn sự thật durable (GoalLoopJob DB
          // queued/running) — tracker in-memory single-slot có thể bị run
          // ngắn (OPUS review) tắt nhầm sau khi đè con trỏ.
          hasActiveRun: activeCtx.isSessionActive(s.sessionId) || hasActiveRun(s.sessionId),
          activeJobCount: activeCtx.activeJobCount(s.sessionId),
        })),
        // Sessions đang vận hành (cross agent/team) — UI ghim section riêng
        activeSessions: activeCtx.activeSessions,
        gatewaySessions,
        total: sessions.length,
      })
    } catch (err) {
      return NextResponse.json(
        { error: 'Failed to list sessions', details: err instanceof Error ? err.message : String(err) },
        { status: 500 }
      )
    }
  }

  return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
}

export async function POST(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const action = searchParams.get('action') || 'create'

  if (action === 'create') {
    try {
      const body = await request.json().catch(() => ({}))
      const sessionId = `sess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`

      // Session mới — xóa tombstone (nếu id trùng — gần như không xảy ra vì
      // sessionId sinh theo timestamp, nhưng đúng ngữ nghĩa tạo lại)
      clearSessionTombstone(sessionId)

      const session = await db.agentSession.create({
        data: {
          sessionId,
          title: body.title || 'Cuộc trò chuyện mới',
          model: body.model || null,
          provider: body.provider || null,
          messageCount: 0,
          agentProfileId: body.agentProfileId || null,
          teamMode: body.teamMode || null,
          teamName: body.teamName || null,
        },
      })

      return NextResponse.json({
        id: session.id,
        sessionId: session.sessionId,
        title: session.title,
        model: session.model,
        provider: session.provider,
        messageCount: session.messageCount,
        agentProfileId: session.agentProfileId,
        teamMode: session.teamMode,
        teamName: session.teamName,
        createdAt: session.createdAt,
      })
    } catch (err) {
      return NextResponse.json(
        { error: 'Failed to create session', details: err instanceof Error ? err.message : String(err) },
        { status: 500 }
      )
    }
  }

  // Phase 4.6 — cron-scheduler mini-service (port 3004) calls this action to
  // execute a due CronJob. Body: { sessionId?, task, agentId, source, jobId }.
  // If sessionId is provided → resume; otherwise → create a fresh session.
  // Returns { success, sessionId, response, jobId, source } on success.
  // Run cron task — có tombstone guard (fix review 2026-09-08: CronJob trỏ vào
  // session đã xóa cứ firing mãi, mỗi lần POST action=run lại TẠO chatMessage
  // mồ côi cho session đã purge + báo success trong khi không ai xử lý).
  if (action === 'run') {
    try {
      const body = await request.json().catch(() => ({}))
      const task = String(body.task || '').trim()
      if (!task) {
        return NextResponse.json({ error: 'task is required for action=run' }, { status: 400 })
      }
      const agentId = String(body.agentId || 'default')
      const source = String(body.source || 'cron')
      const jobId = body.jobId ? String(body.jobId) : undefined
      let sessionId = body.sessionId ? String(body.sessionId) : ''

      // Session đã bị user xóa (tombstone) hoặc KHÔNG còn tồn tại trong DB →
      // từ chối, không tự tạo mới (session đã xóa = xóa hẳn, kể cả với cron)
      if (await isSessionDeletedDeep(sessionId)) {
        return NextResponse.json({ error: `Session ${sessionId} đã bị xóa — cron job này nên bị gỡ (sessionId không còn hợp lệ).` }, { status: 410 })
      }
      if (sessionId) {
        const exists = await db.agentSession.findFirst({ where: { sessionId }, select: { id: true } })
        if (!exists) {
          return NextResponse.json({ error: `Session ${sessionId} không tồn tại — cron job sessionId lệch (đã bị purge?).` }, { status: 410 })
        }
      }

      // Create a fresh session if not resuming
      if (!sessionId) {
        sessionId = `sess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
        await db.agentSession.create({
          data: {
            sessionId,
            title: `[cron] ${task.slice(0, 60)}`,
            model: null,
            provider: null,
            messageCount: 0,
            agentProfileId: agentId !== 'default' ? agentId : null,
            teamMode: null,
            teamName: null,
          },
        })
      }

      // Persist the user's task as a chat message (schema: id/sessionId/role/content/model/provider/metadata/createdAt)
      await db.chatMessage.create({
        data: {
          sessionId,
          role: 'user',
          content: task,
          model: null,
          provider: null,
          metadata: JSON.stringify({ source, jobId }),
        },
      })

      // Acknowledge the task — actual LLM execution is handled by the openclaw
      // chat loop (the user-facing UI polls /api/openclaw/sessions?action=list
      // + /api/openclaw/chat to retrieve the assistant's response). Returning
      // success here satisfies the cron-scheduler's contract; deep async LLM
      // dispatch is a Phase 5 hardening (subagent-delegation in 5.2).
      return NextResponse.json({
        success: true,
        sessionId,
        response: `Task queued for execution (session ${sessionId}). The assistant response will appear in the chat UI.`,
        jobId,
        source,
        queuedAt: new Date().toISOString(),
      })
    } catch (err) {
      return NextResponse.json(
        { error: 'Failed to queue cron task', details: err instanceof Error ? err.message : String(err) },
        { status: 500 }
      )
    }
  }

  return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
}

export async function PATCH(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const action = searchParams.get('action') || 'rename'

  if (action === 'rename') {
    try {
      const body = await request.json().catch(() => ({}))
      const { sessionId, title } = body

      if (!sessionId || typeof sessionId !== 'string') {
        return NextResponse.json({ error: 'sessionId là bắt buộc' }, { status: 400 })
      }

      if (!title || typeof title !== 'string' || title.trim().length < TITLE_MIN || title.trim().length > TITLE_MAX) {
        return NextResponse.json({ error: `Tiêu đề phải từ ${TITLE_MIN}-${TITLE_MAX} ký tự` }, { status: 400 })
      }

      const existing = await db.agentSession.findFirst({ where: { sessionId } })
      if (!existing) {
        return NextResponse.json({ error: 'Session không tồn tại' }, { status: 404 })
      }

      const updated = await db.agentSession.update({
        where: { id: existing.id },
        data: { title: title.trim() },
      })

      return NextResponse.json({
        success: true,
        sessionId: updated.sessionId,
        title: updated.title,
      })
    } catch (err) {
      return NextResponse.json(
        { error: 'Failed to rename session', details: err instanceof Error ? err.message : String(err) },
        { status: 500 }
      )
    }
  }

  return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
}

export async function DELETE(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const action = searchParams.get('action') || 'delete'
  const sessionId = searchParams.get('sessionId')

  if (action === 'delete' && sessionId) {
    try {
      // ============================================================
      // MARK TOMBSTONE TRƯỚC (fix review 2026-09-08 — TOCTOU): trước đây
      // mark SAU purge transaction — request chat chạy song song hoàn tất
      // upsert ngay giữa cửa sổ đó → row session được tạo lại rồi tombstone
      // mới chặn (row hồi sinh ở lại list mãi mãi). Mark trước + persist DB
      // (chống hồi sinh sau restart) + mark lại sau transaction cho chắc.
      // ============================================================
      markSessionDeleted(sessionId)

      // CANCEL ACTIVE RUNS (fix review 2026-09-08): session đang có agent
      // goal-loop/sub-agent chạy dở → hủy ngay (không để loop viết thêm
      // working-memory/todo/metrics cho session đã purge + không đốt token).
      const cancelledRuns = cancelSessionRuns(sessionId)
      if (cancelledRuns > 0) {
        console.log(`[Sessions] HARD DELETE ${sessionId}: đã hủy ${cancelledRuns} agent run đang chạy dở`)
      }
      // ============================================================
      // HARD DELETE (user request 2026-09-08: "các phiên chat tôi đã bấm xóa
      // phải xóa hẳn, lần sau vào lại không còn, chỉ những gì còn học từ đó
      // thì giữ lại") — purge TOÀN BỘ dữ liệu scoped theo phiên chat:
      //
      // XÓA (thuộc về phiên chat):
      //   - ChatMessage          — nội dung hội thoại
      //   - CodeTeamWorklog/Session — nhật ký làm việc của team trong phiên
      //   - SmolabTask           — background tasks của phiên (cascade sẵn nhưng
      //                             xóa tường minh cho chắc)
      //   - WorkingMemory        — HOT tier (raw working memory của phiên)
      //   - Todo                 — Agent Tasks panel của phiên
      //   - PendingEdit          — file edits chờ duyệt của phiên
      //   - FsCheckpoint / Neo4jCheckpointDiff — checkpoints của phiên
      //   - MemoryAccessLog      — log truy cập memory của phiên
      //   - ToolMetric           — analytics tool chạy trong phiên
      //   - AgentSession         — row phiên chat
      //
      // GIỮ (những gì HỌC được — user yêu cầu rõ):
      //   - AgentMemory (WARM)   — ký ức dài hạn đã học từ phiên
      //   - MemoryArchive (COLD) — bản nén ký ức
      //   - LearningLog          — sự kiện học (feedback/insight/correction)
      //   - AgentInsight / AgentCorrection / AgentPreference — tri thức tích lũy
      //   - PendingWriteback     — tri thức đang chờ ghi vào KB
      //
      // Sau purge → markSessionDeleted() để chat route KHÔNG upsert/persist
      // lại session này nữa (chống hồi sinh khi còn request chạy dở).
      // ============================================================
      const deleted = await db.$transaction([
        db.chatMessage.deleteMany({ where: { sessionId } }),
        db.codeTeamWorklog.deleteMany({ where: { sessionId } }),
        db.codeTeamSession.deleteMany({ where: { sessionId } }),
        db.smolabTask.deleteMany({ where: { sessionId } }),
        db.workingMemory.deleteMany({ where: { sessionId } }),
        db.todo.deleteMany({ where: { sessionId } }),
        db.pendingEdit.deleteMany({ where: { sessionId } }),
        db.fsCheckpoint.deleteMany({ where: { sessionId } }),
        db.neo4jCheckpointDiff.deleteMany({ where: { sessionId } }),
        db.memoryAccessLog.deleteMany({ where: { sessionId } }),
        db.toolMetric.deleteMany({ where: { sessionId } }),
        // FIX review 2026-09-08 — 3 bảng session-scoped còn sót:
        // FailurePattern + StrategyAdaptationLog được workflow-engine ghi theo
        // chat sessionId → không purge sẽ leak; CronJob trỏ session đã xóa cứ
        // firing (mỗi fire lại đẻ chatMessage mồ côi qua action=run).
        db.failurePattern.deleteMany({ where: { sessionId } }),
        db.strategyAdaptationLog.deleteMany({ where: { sessionId } }),
        db.cronJob.deleteMany({ where: { sessionId } }),
        db.agentSession.deleteMany({ where: { sessionId } }),
      ])

      // Tombstone — mark lại sau purge (idempotent; persist DB chống hồi sinh sau restart)
      markSessionDeleted(sessionId)

      const totalDeleted = deleted.reduce((sum, r) => sum + r.count, 0)
      console.log(`[Sessions] HARD DELETE session ${sessionId}: đã purge ${totalDeleted} bản ghi (chat messages, tasks, working memory, todos, checkpoints, metrics...) — GIỮ lại AgentMemory/MemoryArchive/LearningLog (những gì đã học)`)

      return NextResponse.json({ success: true, sessionId, purgedRecords: totalDeleted })
    } catch (err) {
      return NextResponse.json(
        { error: 'Failed to delete session', details: err instanceof Error ? err.message : String(err) },
        { status: 500 }
      )
    }
  }

  return NextResponse.json({ error: 'sessionId is required for delete' }, { status: 400 })
}
