/**
 * EPISODIC EPISODES API — Task A6-API-UI
 *
 * GET /api/episodic/episodes?id=<episodeId> — chi tiết 1 episode từ Neo4j:
 *   {episode, actions[], errors[], lessons[]} (getEpisodeDetail)
 * GET /api/episodic/episodes (không id)     — getRecentEpisodes(20), FALLBACK
 *   SQLite mirror khi graph trống/down (pattern như /overview)
 *
 * Fail-open: try/catch toàn bộ — lỗi trả data rỗng + error message, không 500.
 */

import { NextRequest, NextResponse } from 'next/server'
import {
  findRecentEpisodeRecords,
  getEpisodeDetail,
  getRecentEpisodes,
} from '@/lib/episodic-memory'

export const dynamic = 'force-dynamic'

const LIST_LIMIT = 20

// ==================== helpers ====================

/** Date | Neo4j DateTime (plain object year/month/day sau toNative) → ISO string */
function toIso(v: unknown): unknown {
  if (v instanceof Date) return v.toISOString()
  if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
    const o = v as Record<string, unknown>
    if (typeof o.year === 'number' && typeof o.month === 'number' && typeof o.day === 'number') {
      const d = new Date(
        Date.UTC(
          o.year, o.month - 1, o.day,
          Number(o.hour ?? 0), Number(o.minute ?? 0), Number(o.second ?? 0),
        ),
      )
      return Number.isNaN(d.getTime()) ? String(v) : d.toISOString()
    }
  }
  return v
}

function sanitizeRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(row)) out[k] = toIso(v)
  return out
}

function sanitizeRows(rows: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return rows.map(sanitizeRow)
}

// ==================== GET ====================

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const id = (searchParams.get('id') || '').trim()

  // ---- chi tiết 1 episode ----
  if (id) {
    try {
      const detail = await getEpisodeDetail(id)
      return NextResponse.json({
        id,
        episode: detail.episode ? sanitizeRow(detail.episode) : null,
        actions: sanitizeRows(detail.actions),
        errors: sanitizeRows(detail.errors),
        lessons: sanitizeRows(detail.lessons),
        error: null,
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('[Episodic/Episodes] GET detail error (fail-open):', err)
      return NextResponse.json({
        id,
        episode: null,
        actions: [],
        errors: [],
        lessons: [],
        error: msg,
      })
    }
  }

  // ---- danh sách episodes gần đây (Neo4j → fallback mirror) ----
  let episodes: Array<Record<string, unknown>> = []
  let error: string | null = null
  let source: 'neo4j' | 'sqlite-mirror' = 'neo4j'
  try {
    const rows = await getRecentEpisodes(LIST_LIMIT)
    episodes = rows.map(r => ({ ...sanitizeRow(r), source: 'neo4j' }))
  } catch (err) {
    error = err instanceof Error ? err.message : String(err)
    console.error('[Episodic/Episodes] GET list (Neo4j) error (fail-open):', err)
  }
  if (episodes.length === 0) {
    try {
      const mirror = await findRecentEpisodeRecords(LIST_LIMIT)
      if (mirror.length > 0) {
        episodes = mirror.map(r => ({
          id: r.id,
          title: r.title,
          goal: r.goal,
          outcome: r.outcome,
          agent: r.agent,
          confidence: r.confidence,
          cycles: r.cycles,
          tokensUsed: r.tokensUsed,
          toolCalls: r.toolCalls,
          toolFailures: r.toolFailures,
          stopReason: r.stopReason,
          createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : r.createdAt,
          source: 'sqlite-mirror',
        }))
        source = 'sqlite-mirror'
      }
    } catch (err) {
      error = error ?? (err instanceof Error ? err.message : String(err))
      console.error('[Episodic/Episodes] GET list (mirror fallback) error (fail-open):', err)
    }
  }

  return NextResponse.json({
    generatedAt: new Date().toISOString(),
    episodes,
    source,
    error,
  })
}
