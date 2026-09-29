/**
 * Active Sessions Context — FIX 2026-09-29 (user report: "session đang vận
 * hành không hiển thị ra, chỉ hiện những session đang đứng im").
 *
 * Session có agent đang chạy thật (durable goal-loop job do OPUS tự dispatch,
 * cron, hay user kích hoạt) bị ẩn khỏi dropdown vì:
 *  (1) UI lọc session theo agent/team đang chọn — session vận hành thường
 *      thuộc agent KHÁC (SENTINEL/FORGE…) hoặc teamName=null;
 *  (2) hasActiveRun in-memory single-slot có thể bị run ngắn (OPUS review)
 *      tắt nhầm chấm xanh (đã vá trong agent-run-tracker).
 *
 * Helper này gom nguồn sự thật hoạt động:
 *  - GoalLoopJob DB: status queued/running (durable — sống qua restart)
 *  - Run tracker in-memory: mọi session có run 'running'
 * và trả:
 *  - isSessionActive(sid)  — cho flag hasActiveRun của MỌI session list
 *  - activeJobCount(sid)   — số goal-loop job queued/running của session
 *  - activeSessions        — payload ghim "⚡ Đang vận hành" (cross agent/
 *                            team, kèm tên agent giải từ AgentProfile)
 *
 * Dùng chung bởi /api/openclaw/sessions (dropdown Smolab) và
 * /api/smolab/sessions (fetchSessionsForAgent/Team) — 2 endpoint phải trả
 * cùng một nguồn sự thật nếu không dropdown nhấp nháy sai lệch nhau.
 */

import { db } from '@/lib/db'
import { hasActiveRun, getActiveRunSessionIds } from '@/lib/agent-run-tracker'

export interface ActiveSessionPayload {
  id: string
  sessionId: string
  title: string
  model: string | null
  provider: string | null
  messageCount: number
  agentProfileId: string | null
  agentName: string | null
  teamMode: string | null
  teamName: string | null
  createdAt: Date
  updatedAt: Date
  /** Luôn true — payload này CHỈ chứa session đang vận hành */
  hasActiveRun: boolean
  activeJobCount: number
}

export interface ActiveSessionsContext {
  /** Session có hoạt động thật (job DB queued/running HOẶC run tracker running)? */
  isSessionActive: (sessionId: string) => boolean
  /** Số goal-loop job queued/running của session (0 = không có) */
  activeJobCount: (sessionId: string) => number
  /** Payload ghim lên đầu dropdown — KHÔNG lọc agent/team */
  activeSessions: ActiveSessionPayload[]
}

/** Fail-open helper — mọi lỗi DB trả context rỗng (session list vẫn hoạt động) */
export async function getActiveSessionsContext(): Promise<ActiveSessionsContext> {
  const empty: ActiveSessionsContext = {
    isSessionActive: () => false,
    activeJobCount: () => 0,
    activeSessions: [],
  }
  try {
    const [activeJobRows, trackerActiveIds] = await Promise.all([
      db.goalLoopJob
        .findMany({
          where: { status: { in: ['running', 'queued'] } },
          select: { sessionId: true },
        })
        .catch(() => [] as Array<{ sessionId: string }>),
      Promise.resolve(getActiveRunSessionIds()),
    ])

    const activeJobCountBySession = new Map<string, number>()
    for (const j of activeJobRows) {
      if (!j.sessionId) continue
      activeJobCountBySession.set(j.sessionId, (activeJobCountBySession.get(j.sessionId) || 0) + 1)
    }
    const allActiveIds = new Set<string>([...activeJobCountBySession.keys(), ...trackerActiveIds])

    const isSessionActive = (sid: string) => allActiveIds.has(sid) || hasActiveRun(sid)
    const activeJobCount = (sid: string) => activeJobCountBySession.get(sid) || 0

    if (allActiveIds.size === 0) {
      return { isSessionActive, activeJobCount, activeSessions: [] }
    }

    // Chỉ lấy row CÓ thật trong DB (session đã purge/tombstone không tái xuất)
    const rows = await db.agentSession
      .findMany({
        where: { sessionId: { in: [...allActiveIds] } },
        orderBy: { updatedAt: 'desc' },
        take: 20,
      })
      .catch(() => [])
    if (rows.length === 0) {
      return { isSessionActive, activeJobCount, activeSessions: [] }
    }

    // Giải tên agent cho badge (id khô không giúp user nhận diện)
    const profileIds = [...new Set(rows.map(r => r.agentProfileId).filter((v): v is string => !!v))]
    const profiles = profileIds.length > 0
      ? await db.agentProfile
          .findMany({ where: { id: { in: profileIds } }, select: { id: true, name: true } })
          .catch(() => [])
      : []
    const agentNameById = new Map(profiles.map(p => [p.id, p.name]))

    const activeSessions: ActiveSessionPayload[] = rows.map(s => ({
      id: s.id,
      sessionId: s.sessionId,
      title: s.title || 'Untitled Session',
      model: s.model,
      provider: s.provider,
      messageCount: s.messageCount,
      agentProfileId: s.agentProfileId,
      agentName: s.agentProfileId ? agentNameById.get(s.agentProfileId) || null : null,
      teamMode: s.teamMode,
      teamName: s.teamName,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      hasActiveRun: true,
      activeJobCount: activeJobCount(s.sessionId),
    }))

    return { isSessionActive, activeJobCount, activeSessions }
  } catch {
    return empty
  }
}
