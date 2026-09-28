/**
 * OPUS ACTIVITY API (Task 53 — realtime heartbeat)
 * GET /api/opus/activity?sessionId=<sessionId>
 *   → { ok, mode, killed,
 *       messageCount, latestMessageAt,
 *       reviewCount, latestReviewAt,
 *       activeJobIds, activeRunCount, latestRunAt }
 *
 * USER REQUEST 2026-09-28: bật chế độ Tự động review của Opus thì phải chuyển
 * module khác rồi quay lại mới thấy review mới nhất + những gì agents triển
 * khai. Nguyên nhân: vòng auto chạy hoàn toàn server-side (review → directive
 * message → goal-loop job → agent run) trong khi UI chỉ fetch dữ liệu MỘT LẦN
 * khi mở session. Giải pháp: client poll endpoint fingerprint này mỗi 3s
 * (auto) / 8s (manual) — rẻ (~4 indexed query + registry in-memory), phần nào
 * đổi thì refresh đúng phần đó (delta messages / reviews / jobs / runs).
 */

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getOpusSettings } from '@/lib/opus/pipeline'
import { getAgentRuns } from '@/lib/agent-run-tracker'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  try {
    const sessionId = request.nextUrl.searchParams.get('sessionId')
    if (!sessionId) {
      return NextResponse.json({ error: 'Thiếu tham số sessionId' }, { status: 400 })
    }

    const [session, settings, lastMessage, messageCount, lastReview, reviewCount, activeJobs, runs] = await Promise.all([
      db.agentSession.findUnique({
        where: { sessionId },
        select: { opusReviewMode: true },
      }),
      getOpusSettings(),
      db.chatMessage.findFirst({
        where: { sessionId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: { createdAt: true },
      }),
      db.chatMessage.count({ where: { sessionId } }),
      db.opusReview.findFirst({
        where: { sessionId },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      }),
      db.opusReview.count({ where: { sessionId } }),
      db.goalLoopJob.findMany({
        where: { sessionId, status: { in: ['queued', 'running'] } },
        select: { id: true },
        orderBy: { createdAt: 'asc' },
      }),
      // Run registry in-memory (cùng process) — 10 runs gần nhất đủ làm dấu
      // hiệu "run mới bắt đầu/kết thúc" cho Thought Process panel
      Promise.resolve(getAgentRuns(sessionId, 10)),
    ])

    const activeRunCount = runs.filter(r => r.status === 'running').length
    const latestRunAt = runs.reduce((max, r) => Math.max(max, r.startedAt || 0), 0)

    return NextResponse.json({
      ok: true,
      mode: session?.opusReviewMode === 'auto' ? 'auto' : 'manual',
      killed: settings.killed,
      messageCount,
      latestMessageAt: lastMessage?.createdAt instanceof Date ? lastMessage.createdAt.toISOString() : null,
      reviewCount,
      latestReviewAt: lastReview?.createdAt instanceof Date ? lastReview.createdAt.toISOString() : null,
      activeJobIds: activeJobs.map(j => j.id),
      activeRunCount,
      latestRunAt: latestRunAt > 0 ? latestRunAt : null,
    })
  } catch (err) {
    console.error('[Opus] GET activity error:', err)
    return NextResponse.json({ error: 'Không tải được hoạt động phiên' }, { status: 500 })
  }
}
