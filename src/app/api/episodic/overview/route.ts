/**
 * EPISODIC MEMORY OVERVIEW — Task A6-API-UI
 *
 * GET /api/episodic/overview — endpoint tập trung cho UI panel Episodic
 * Memory (tab Analytics). Pattern giống /api/metrics/overview: MỖI section
 * độc lập try/catch fail-open — section lỗi → zero-state + error message,
 * KHÔNG làm fail cả response.
 *
 * Sections:
 *   stats          — EpisodeRecord/LessonRecord count + Qdrant points +
 *                    số lesson cần review (confidence < 0.4 bị flag)
 *   errorDashboard — Q5 dashboard: category × rootCause, occurrences, resolved
 *   escalations    — pattern lỗi lặp ≥ 3 lần (đề xuất cải tiến hệ thống — C.2)
 *   recentEpisodes — Neo4j Episode rows gần đây; FALLBACK SQLite mirror khi
 *                    graph trống hoặc down (flag source: 'sqlite-mirror')
 *   lessons        — SQLite mirror lessons (parse appliesTo JSON, coerce
 *                    needsReview boolean)
 *   taxonomy       — static R1-R6 playbook (luôn ok, không async)
 */

import { NextResponse } from 'next/server'
import {
  countEpisodeRecords,
  countLessonRecords,
  findAllLessonRecords,
  findRecentEpisodeRecords,
  getAllLessonNodes,
  getEpisodicGraphCounts,
  getErrorDashboard,
  getEscalationCandidates,
  getEpisodePointCount,
  getRecentEpisodes,
  listTaxonomy,
} from '@/lib/episodic-memory'
import type { ErrorDashboardRow } from '@/lib/episodic-memory'

export const dynamic = 'force-dynamic'

const RECENT_EPISODES_LIMIT = 15
const DASHBOARD_LIMIT = 10
const ESCALATION_MIN = 3
const LESSONS_LIMIT = 50
const LESSONS_FOR_REVIEW_SCAN = 200

// ==================== helpers (sanitize/parse) ====================

/** Parse appliesTo JSON string (SQLite mirror) → string[] — chấp nhận cả comma-separated */
function parseAppliesTo(json: string | null): string[] {
  if (!json) return []
  try {
    const v = JSON.parse(json)
    return Array.isArray(v) ? v.map(String) : []
  } catch {
    return json.split(',').map(s => s.trim()).filter(Boolean)
  }
}

/** Date | Neo4j DateTime (sống sót qua toNative như plain object year/month/day) → ISO string */
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

/** Sanitize 1 row Neo4j (Date/DateTime/Integer đã toNative) → JSON-safe */
function sanitizeRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(row)) out[k] = toIso(v)
  return out
}

// ==================== GET ====================

export async function GET() {
  // ---- stats ----
  let stats = { episodes: 0, lessons: 0, qdrantPoints: 0, lessonsNeedReview: 0, source: 'sqlite-mirror' as 'sqlite-mirror' | 'neo4j' | 'mixed' }
  let statsError: string | null = null
  try {
    const [episodes, lessons, qdrantPoints, allLessons] = await Promise.all([
      countEpisodeRecords(),
      countLessonRecords(),
      getEpisodePointCount(),
      findAllLessonRecords(0, LESSONS_FOR_REVIEW_SCAN),
    ])
    stats = {
      episodes,
      lessons,
      qdrantPoints,
      lessonsNeedReview: allLessons.filter(l => !!l.needsReview).length,
      source: 'sqlite-mirror',
    }

    // FIX (query learning data): SQLite mirror trống (deploy mới) nhưng graph
    // Neo4j Aura có dữ liệu học tập thật → dùng counts từ graph thay vì hiện 0.
    // Đây chính là tình huống hiện tại: 39 Episode + 17 Lesson trên Aura nhưng
    // mirror trống → stats toàn 0, panel Lessons trống dù dữ liệu tồn tại.
    if (episodes === 0 && lessons === 0) {
      const graphCounts = await getEpisodicGraphCounts()
      if (graphCounts && (graphCounts.episodes > 0 || graphCounts.lessons > 0)) {
        stats = {
          ...stats,
          episodes: graphCounts.episodes,
          lessons: graphCounts.lessons,
          lessonsNeedReview: graphCounts.lessonsNeedReview,
          source: 'neo4j',
        }
      }
    }
  } catch (err) {
    statsError = err instanceof Error ? err.message : String(err)
    console.error('[Episodic/Overview] stats section error (fail-open):', err)
  }

  // ---- errorDashboard (Q5) ----
  let errorDashboard: ErrorDashboardRow[] = []
  let errorDashboardError: string | null = null
  try {
    errorDashboard = await getErrorDashboard(DASHBOARD_LIMIT)
  } catch (err) {
    errorDashboardError = err instanceof Error ? err.message : String(err)
    console.error('[Episodic/Overview] errorDashboard section error (fail-open):', err)
  }

  // ---- escalations (pattern ≥ 3) ----
  let escalations: Array<{
    rootCause: string
    occurrences: number
    resolved: number
    recentErrors: string[]
  }> = []
  let escalationsError: string | null = null
  try {
    escalations = await getEscalationCandidates(ESCALATION_MIN)
  } catch (err) {
    escalationsError = err instanceof Error ? err.message : String(err)
    console.error('[Episodic/Overview] escalations section error (fail-open):', err)
  }

  // ---- recentEpisodes (Neo4j → fallback SQLite mirror) ----
  let recentEpisodes: Array<Record<string, unknown>> = []
  let recentEpisodesError: string | null = null
  let recentEpisodesSource: 'neo4j' | 'sqlite-mirror' = 'neo4j'
  try {
    const rows = await getRecentEpisodes(RECENT_EPISODES_LIMIT)
    recentEpisodes = rows.map(r => ({ ...sanitizeRow(r), source: 'neo4j' }))
  } catch (err) {
    recentEpisodesError = err instanceof Error ? err.message : String(err)
    console.error('[Episodic/Overview] recentEpisodes (Neo4j) error (fail-open):', err)
  }
  if (recentEpisodes.length === 0) {
    try {
      const mirror = await findRecentEpisodeRecords(RECENT_EPISODES_LIMIT)
      if (mirror.length > 0) {
        recentEpisodes = mirror.map(r => ({
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
        recentEpisodesSource = 'sqlite-mirror'
      }
    } catch (err) {
      recentEpisodesError =
        recentEpisodesError ?? (err instanceof Error ? err.message : String(err))
      console.error('[Episodic/Overview] recentEpisodes (mirror fallback) error (fail-open):', err)
    }
  }

  // ---- lessons (SQLite mirror → fallback Neo4j graph) ----
  let lessons: Array<Record<string, unknown>> = []
  let lessonsError: string | null = null
  let lessonsSource: 'sqlite-mirror' | 'neo4j' = 'sqlite-mirror'
  try {
    const rows = await findAllLessonRecords(0, LESSONS_LIMIT)
    if (rows.length > 0) {
      lessons = rows.map(r => ({
        id: r.id,
        statement: r.statement,
        triggerCondition: r.triggerCondition,
        rootCause: r.rootCause,
        appliesTo: parseAppliesTo(r.appliesTo),
        source: r.source,
        confidence: r.confidence,
        timesApplied: r.timesApplied,
        timesValidated: r.timesValidated,
        timesFailed: r.timesFailed,
        needsReview: !!r.needsReview,
        createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : r.createdAt,
        updatedAt: r.updatedAt instanceof Date ? r.updatedAt.toISOString() : r.updatedAt,
      }))
    } else {
      // FIX (query learning data): mirror trống → đọc lessons thẳng từ graph
      // (tình huống deploy mới — dữ liệu học tập agents nằm trên AuraDB).
      const graphLessons = await getAllLessonNodes(LESSONS_LIMIT)
      if (graphLessons.length > 0) {
        lessonsSource = 'neo4j'
        lessons = graphLessons.map(l => ({
          id: l.id,
          statement: l.statement,
          triggerCondition: l.triggerCondition,
          rootCause: l.rootCause,
          appliesTo: Array.isArray(l.appliesTo) ? l.appliesTo.map(String) : [],
          source: l.source,
          confidence: typeof l.confidence === 'number' ? l.confidence : 0,
          timesApplied: Number(l.timesApplied ?? 0),
          timesValidated: Number(l.timesValidated ?? 0),
          timesFailed: Number(l.timesFailed ?? 0),
          needsReview: l.needsReview === true,
          createdAt: toIso(l.createdAt) ?? null,
          updatedAt: toIso(l.updatedAt) ?? null,
        }))
      }
    }
  } catch (err) {
    lessonsError = err instanceof Error ? err.message : String(err)
    console.error('[Episodic/Overview] lessons section error (fail-open):', err)
  }

  // ---- taxonomy (static — luôn ok) ----
  const taxonomy = listTaxonomy().map(t => ({
    code: t.code,
    label: t.label,
    correctResponse: t.correctResponse,
    antiPattern: t.antiPattern,
    manifestations: t.manifestations.map(m => ({ code: m.code, description: m.description })),
  }))

  return NextResponse.json({
    generatedAt: new Date().toISOString(),
    stats: { ...stats, error: statsError },
    errorDashboard: { rows: errorDashboard, error: errorDashboardError },
    escalations: { rows: escalations, error: escalationsError },
    recentEpisodes: { rows: recentEpisodes, source: recentEpisodesSource, error: recentEpisodesError },
    lessons: { rows: lessons, source: lessonsSource, error: lessonsError },
    taxonomy,
  })
}
