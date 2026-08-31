/**
 * Auto-Learn API — Query auto-learn records + REAL learning pipeline stats
 *
 * GET /api/auto-learn          — Get auto-learn stats + recent records + learningStats
 * GET /api/auto-learn?stats=1  — Get aggregated stats only (+ learningStats)
 * GET /api/auto-learn?agent=xxx — Filter by agentId
 * GET /api/auto-learn?status=completed|failed|pending — Filter by status
 *
 * FIX 2026-09-10 (orphaned-tab): tab Auto-Learn trước đây chỉ đọc bảng
 * AutoLearnRecord — bảng của legacy path autoLearnFromAnswer, từ 2026-08-21
 * chỉ chạy khi writeback throw exception (fallback) nên tab luôn hiển thị 0.
 * Học THẬT hiện chạy qua Smart KB Writeback (kb-routing/writeback.ts) ghi
 * Qdrant + Neo4j + AgentMemory + AgentInsight + LearningLog sau MỖI lượt chat
 * (conf > 0.5 auto-write; 0.3–0.5 chờ phê duyệt tại Smolab → Learning).
 * Response giờ bổ sung `learningStats` tổng hợp từ pipeline thật;
 * `records`/`stats` (legacy) được giữ lại để tương thích ngược.
 */

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getAutoLearnStats } from '@/lib/auto-learn'
import { readCypher } from '@/lib/neo4j'

export const dynamic = 'force-dynamic'

// learningStats cache (30s TTL) — UI poll mỗi 10s; tránh 3 round-trip Neo4j Aura
// mỗi lần poll. Cache invalid tự nhiên sau 30s.
let learningStatsCache: { data: ReturnType<typeof getLearningStats>; at: number } | null = null
const LEARNING_STATS_TTL_MS = 30_000

async function getLearningStatsCached() {
  if (learningStatsCache && Date.now() - learningStatsCache.at < LEARNING_STATS_TTL_MS) {
    return learningStatsCache.data
  }
  const data = getLearningStats()
  learningStatsCache = { data, at: Date.now() }
  // Promise reject → invalidate cache để lần gọi sau retry ngay
  data.catch(() => { if (learningStatsCache?.data === data) learningStatsCache = null })
  return data
}

/**
 * Tổng hợp thống kê pipeline học THẬT (writeback saga + memory + Neo4j).
 * Mọi truy vấn best-effort: lỗi Neo4j → kgAutoLearn = null (không crash API).
 */
async function getLearningStats() {
  const [wbStatusGroups, activeMemories, totalMemories, insightCount, logCount, recentLogRows] =
    await Promise.all([
      db.pendingWriteback.groupBy({ by: ['status'], _count: { _all: true } }).catch(() => []),
      db.agentMemory.count({ where: { isActive: true } }).catch(() => 0),
      db.agentMemory.count().catch(() => 0),
      db.agentInsight.count().catch(() => 0),
      db.learningLog.count().catch(() => 0),
      db.learningLog
        .findMany({ orderBy: { createdAt: 'desc' }, take: 15 })
        .catch(() => [] as Array<{ id: string; agentId: string; eventType: string; content: string; createdAt: Date }>),
    ])

  const writebacks = { total: 0, completed: 0, pending: 0, needsReview: 0, partial: 0, failed: 0, rejected: 0 }
  for (const g of wbStatusGroups) {
    const n = g._count._all
    writebacks.total += n
    if (g.status === 'completed') writebacks.completed = n
    else if (g.status === 'pending') writebacks.pending = n
    else if (g.status === 'needs_review') writebacks.needsReview = n
    else if (g.status === 'partial') writebacks.partial = n
    else if (g.status === 'failed') writebacks.failed = n
    else if (g.status === 'rejected') writebacks.rejected = n
  }

  // Neo4j: tri thức Agent tự học từ chat — best-effort.
  // FIX (dưới đếm tri thức legacy): legacy path ghi source = `auto-learn:${agentName}`
  // (auto-learn.ts:275/305) và sync-neo4j ghi nguyên source đó — phép `=`
  // 'auto-learn' exact KHÔNG match. Doc-id legacy là `auto-learn-…` (dash)
  // cũng không khớp prefix 'auto-learn:' (colon). Chuyển sang STARTS WITH
  // 'auto-learn' bắt cả writeback-path (source='auto-learn') lẫn legacy.
  let kgAutoLearn: { entities: number; relationships: number; documents: number } | null = null
  try {
    const [entRes, relRes, docRes] = await Promise.all([
      readCypher<{ c: unknown }>(`MATCH (n) WHERE n.source STARTS WITH 'auto-learn' RETURN count(n) AS c`),
      readCypher<{ c: unknown }>(`MATCH ()-[r]->() WHERE r.source STARTS WITH 'auto-learn' RETURN count(r) AS c`),
      readCypher<{ c: unknown }>(`MATCH (d:Document) WHERE d.id STARTS WITH 'auto-learn:' OR d.id STARTS WITH 'auto-learn-' RETURN count(d) AS c`),
    ])
    kgAutoLearn = {
      entities: Number(entRes[0]?.c ?? 0),
      relationships: Number(relRes[0]?.c ?? 0),
      documents: Number(docRes[0]?.c ?? 0),
    }
  } catch {
    kgAutoLearn = null // Neo4j unreachable — UI hiển thị "—"
  }

  // Parse LearningLog content → dòng thời gian đọc được
  const recentLogs = recentLogRows.map(r => {
    let kind = r.eventType
    let summary = ''
    try {
      const c = JSON.parse(r.content) as {
        kind?: string
        entitiesWritten?: number
        relationshipsWritten?: number
        chunksWritten?: number
        query?: string
        agentName?: string
      }
      if (c && typeof c === 'object' && c.kind === 'kb-writeback') {
        kind = 'kb-writeback'
        summary = `${c.entitiesWritten ?? 0} entities · ${c.relationshipsWritten ?? 0} rels · ${c.chunksWritten ?? 0} chunks — "${(c.query || '').slice(0, 90)}"`
      } else {
        summary = (r.content || '').slice(0, 140)
      }
    } catch {
      summary = (r.content || '').slice(0, 140)
    }
    return {
      id: r.id,
      eventType: r.eventType,
      kind,
      summary,
      agentId: r.agentId,
      createdAt: r.createdAt.toISOString(),
    }
  })

  return {
    writebacks,
    memories: { active: activeMemories, total: totalMemories },
    insights: insightCount,
    learningLogs: logCount,
    recentLogs,
    kgAutoLearn,
  }
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const statsOnly = searchParams.get('stats') === '1'
    const agentId = searchParams.get('agent')
    const status = searchParams.get('status')

    // Stats-only mode
    if (statsOnly) {
      const [stats, learningStats] = await Promise.all([getAutoLearnStats(), getLearningStatsCached()])
      return NextResponse.json({ stats, learningStats, source: 'local' })
    }

    // Build filter
    const where: Record<string, unknown> = {}
    if (agentId) where.agentId = agentId
    if (status) where.status = status

    // Get records with filter
    const [records, stats, learningStats] = await Promise.all([
      db.autoLearnRecord.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
      getAutoLearnStats(),
      getLearningStatsCached(),
    ])

    return NextResponse.json({
      records,
      stats,
      learningStats,
      source: 'local',
    })
  } catch (error) {
    console.error('[AutoLearn API] GET error:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to get auto-learn data' },
      { status: 500 }
    )
  }
}
