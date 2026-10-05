/**
 * ROUND-36 (rà soát lượt 3) — Heal episodic stores sau reset/desync.
 *
 * BỐI CẢNH PHÁT HIỆN: reset 2026-10-04 xoá Qdrant collections (kể cả
 * theopus_episodes) + SQLite deploy lại 0_init trắng, nhưng Neo4j Aura
 * restore giữ nguyên 94 Episode + 64 Lesson. Hệ quả "bộ não mất trí nhớ":
 *  - searchSimilarEpisodes() luôn [] (collection mất — fail-open im lặng)
 *  - Episode.embedding_id treo (trỏ point không tồn tại nữa)
 *  - SQLite EpisodeRecord/LessonRecord = 0 rows → /api/episodic/lessons
 *    trống + preact fallback trống dù graph còn nguyên dữ liệu
 * Trước round này KHÔNG có đường backfill nào → mỗi lần mất Qdrant là mất
 * vĩnh viễn kinh nghiệm đã học (dù bản gốc còn nằm ở Neo4j).
 *
 * Heal 3 tầng (idempotent — chạy lại vô hại):
 *  1) Qdrant: re-embed mọi episode thiếu point. pointId = deterministicUuid
 *     (episodeId) — cùng công thức recorder dùng → upsert đè không nhân bản.
 *  2) Neo4j: cập nhật embedding_id mới (bản treo trỏ point đã chết).
 *  3) SQLite: backfill EpisodeRecord + LessonRecord mirror cho bản thiếu —
 *     lessons API + preact fallback sống lại.
 *
 * Mọi bước fail-open (throw → ghi errors[] — không làm hỏng caller).
 */

import { readCypher, executeCypher } from '@/lib/neo4j'
import { db } from '@/lib/db'
import { qdrant } from '@/lib/qdrant'
import { ensureEpisodeCollection, upsertEpisodeEmbedding, getEpisodePointCount, COLLECTION_EPISODES } from './episode-store'
import { getAllLessonNodes, getEpisodicGraphCounts } from './episodic-neo4j'
import { upsertEpisodeRecord, upsertLessonRecord, countEpisodeRecords, countLessonRecords } from './episodic-db'
import type { EpisodeNode, LessonNode, EpisodeOutcome, RootCauseCode } from './types'

export interface EpisodicHealStats {
  episodesScanned: number
  embeddingsCreated: number
  embeddingIdsUpdated: number
  episodeRecordsBackfilled: number
  lessonRecordsBackfilled: number
  skipped: string[]
  errors: string[]
}

interface EpisodeBackfillRow {
  id: string
  title: string
  goal: string
  contextSummary: string
  outcome: string
  confidence: number
  agent: string
  startedAt: string
  endedAt: string
  importance: number
  accessCount: number
  sessionId: string | null
  embeddingId: string | null
  cycles: number | null
  tokensUsed: number | null
  toolCalls: number | null
  toolFailures: number | null
  stopReason: string | null
  lessonIds: string[]
}

function toIsoDate(v: unknown): Date {
  // Neo4j đọc về qua toString() trong Cypher = ISO string; fallback an toàn
  if (v instanceof Date) return v
  const s = typeof v === 'string' ? v : String(v ?? '')
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? new Date() : d
}

/** Toàn bộ Episode node từ Neo4j — dữ liệu gốc cho mọi tầng heal */
async function getAllEpisodesForBackfill(): Promise<EpisodeBackfillRow[]> {
  const rows = await readCypher<Record<string, unknown>>(
    `MATCH (e:Episode)
     OPTIONAL MATCH (e)-[:YIELDED]->(l:Lesson)
     RETURN e.id AS id, e.title AS title, e.goal AS goal,
            e.context_summary AS contextSummary, e.outcome AS outcome,
            e.confidence AS confidence, e.agent AS agent,
            toString(e.started_at) AS startedAt, toString(e.ended_at) AS endedAt,
            e.importance AS importance, e.access_count AS accessCount,
            e.session_id AS sessionId, e.embedding_id AS embeddingId,
            e.cycles AS cycles, e.tokens_used AS tokensUsed,
            e.tool_calls AS toolCalls, e.tool_failures AS toolFailures,
            e.stop_reason AS stopReason,
            collect(DISTINCT l.id) AS lessonIds
     ORDER BY startedAt ASC`
  )
  return rows.map(r => ({
    id: String(r.id ?? ''),
    title: String(r.title ?? ''),
    goal: String(r.goal ?? ''),
    contextSummary: String(r.contextSummary ?? ''),
    outcome: String(r.outcome ?? 'FAILURE') as EpisodeOutcome,
    confidence: Number(r.confidence ?? 0.5),
    agent: String(r.agent ?? 'unknown'),
    startedAt: String(r.startedAt ?? ''),
    endedAt: String(r.endedAt ?? ''),
    importance: Number(r.importance ?? 0.8),
    accessCount: Number(r.accessCount ?? 0),
    sessionId: r.sessionId ? String(r.sessionId) : null,
    embeddingId: r.embeddingId ? String(r.embeddingId) : null,
    cycles: r.cycles != null ? Number(r.cycles) : null,
    tokensUsed: r.tokensUsed != null ? Number(r.tokensUsed) : null,
    toolCalls: r.toolCalls != null ? Number(r.toolCalls) : null,
    toolFailures: r.toolFailures != null ? Number(r.toolFailures) : null,
    stopReason: r.stopReason ? String(r.stopReason) : null,
    lessonIds: Array.isArray(r.lessonIds) ? (r.lessonIds as unknown[]).map(String) : [],
  })).filter(r => r.id)
}

/** Tập point-id (UUID deterministic) hiện có trong collection */
async function getExistingEpisodePointIds(): Promise<Set<string>> {
  const ids = new Set<string>()
  try {
    // Pattern backfillMemoryVectors (agent-memory.ts:1130) — do/while theo
    // next_page_offset, không cap trang (kịp scale khi episodes tăng lớn)
    let offset: string | number | undefined = undefined
    do {
      const res = await qdrant.scroll(COLLECTION_EPISODES, {
        limit: 256,
        offset,
        with_payload: false,
        with_vector: false,
      })
      for (const p of res.points) ids.add(String(p.id))
      offset = (res.next_page_offset as string | number | undefined) ?? undefined
    } while (offset)
  } catch {
    // collection chưa tồn tại / Qdrant down → tập rỗng → heal sẽ tạo lại hết
  }
  return ids
}

/**
 * Heal chính — chạy cả 3 tầng. An toàn chạy đè: pointId deterministic +
 * upsert + chỉ ghi mirror những bản thiếu.
 */
export async function healEpisodicStores(): Promise<EpisodicHealStats> {
  const stats: EpisodicHealStats = {
    episodesScanned: 0, embeddingsCreated: 0, embeddingIdsUpdated: 0,
    episodeRecordsBackfilled: 0, lessonRecordsBackfilled: 0,
    skipped: [], errors: [],
  }

  // ── Tầng 1+2: Qdrant embedding + Neo4j embedding_id ──
  try {
    await ensureEpisodeCollection()
    const [episodes, existingPointIds] = await Promise.all([
      getAllEpisodesForBackfill(),
      getExistingEpisodePointIds(),
    ])
    stats.episodesScanned = episodes.length

    if (episodes.length > 0) {
      // Episode nào đã có point (theo deterministic id) thì khỏi re-embed —
      // embed đắt (API call) nên chỉ làm cho phần thiếu.
      const { deterministicUuid } = await import('@/lib/deterministic-uuid')
      const missing = episodes.filter(e => !existingPointIds.has(deterministicUuid(e.id)))
      if (missing.length === 0) {
        stats.skipped.push(`qdrant: ${episodes.length} points đã đủ — không cần re-embed`)
      }
      const embeddingIdUpdates: Array<{ id: string; embeddingId: string }> = []
      for (const ep of missing) {
        try {
          // Công thức summary khớp recorder (bước 2 pipeline A.5) — thiếu
          // phần "Lỗi chính" vì errors nằm ở node ErrorOccurrence riêng;
          // contextSummary đã chứa thông tin lỗi chính (buildContextSummary).
          const summaryText = `${ep.title}\n${ep.contextSummary}\nOutcome: ${ep.outcome}`
          const pointId = await upsertEpisodeEmbedding({
            episodeId: ep.id,
            summaryText,
            payload: {
              title: ep.title,
              goal: ep.goal.slice(0, 500),
              outcome: ep.outcome,
              agent: ep.agent,
              session_id: ep.sessionId ?? '',
              importance: ep.importance,
              stop_reason: ep.stopReason ?? '',
              created_at: ep.startedAt || new Date().toISOString(),
            },
          })
          if (pointId) {
            stats.embeddingsCreated++
            // Chỉ update Neo4j khi id thay đổi thật (bản treo cũ ≠ point mới)
            if (ep.embeddingId !== pointId) {
              embeddingIdUpdates.push({ id: ep.id, embeddingId: pointId })
            }
          } else {
            stats.errors.push(`embed fail: ${ep.id} (provider chết?)`)
          }
        } catch (err) {
          stats.errors.push(`${ep.id}: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
      if (embeddingIdUpdates.length > 0) {
        try {
          await executeCypher(
            `UNWIND $rows AS r
             MATCH (e:Episode {id: r.id})
             SET e.embedding_id = r.embeddingId`,
            { rows: embeddingIdUpdates }
          )
          stats.embeddingIdsUpdated = embeddingIdUpdates.length
        } catch (err) {
          stats.errors.push(`neo4j embedding_id update: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
    }
  } catch (err) {
    stats.errors.push(`tier-1/2: ${err instanceof Error ? err.message : String(err)}`)
  }

  // ── Tầng 3a: SQLite EpisodeRecord mirror ──
  try {
    const episodes = await getAllEpisodesForBackfill()
    const existingIds = new Set(
      (await db.episodeRecord.findMany({ select: { id: true } }).catch(() => [] as Array<{ id: string }>)).map(r => r.id)
    )
    for (const ep of episodes) {
      if (existingIds.has(ep.id)) continue
      try {
        const episodeNode: EpisodeNode = {
          id: ep.id, title: ep.title, goal: ep.goal, contextSummary: ep.contextSummary,
          startedAt: toIsoDate(ep.startedAt), endedAt: toIsoDate(ep.endedAt),
          outcome: ep.outcome as EpisodeOutcome, confidence: ep.confidence, agent: ep.agent,
          sessionId: ep.sessionId, importance: ep.importance, accessCount: ep.accessCount,
          lastAccessed: toIsoDate(ep.startedAt), embeddingId: ep.embeddingId || null,
          cycles: ep.cycles ?? undefined, tokensUsed: ep.tokensUsed ?? undefined,
          toolCalls: ep.toolCalls ?? undefined, toolFailures: ep.toolFailures ?? undefined,
          stopReason: ep.stopReason ?? undefined,
        }
        // Actions/Errors gốc nằm trong graph (getEpisodeDetail đọc Neo4j) —
        // mirror chỉ phục vụ listing/fallback nên '[]' là trung thực hơn bịa
        await upsertEpisodeRecord({
          episode: episodeNode,
          actionsJson: '[]',
          errorsJson: '[]',
          lessonsJson: JSON.stringify(ep.lessonIds),
        })
        stats.episodeRecordsBackfilled++
      } catch (err) {
        stats.errors.push(`mirror ep ${ep.id}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  } catch (err) {
    stats.errors.push(`tier-3a: ${err instanceof Error ? err.message : String(err)}`)
  }

  // ── Tầng 3b: SQLite LessonRecord mirror ──
  try {
    const lessons = await getAllLessonNodes(1000)
    const existingIds = new Set(
      (await db.lessonRecord.findMany({ select: { id: true } }).catch(() => [] as Array<{ id: string }>)).map(r => r.id)
    )
    for (const l of lessons) {
      if (existingIds.has(l.id)) continue
      try {
        const lessonNode: LessonNode = {
          id: l.id, statement: l.statement,
          triggerCondition: l.triggerCondition ?? null,
          rootCause: (l.rootCause ?? null) as RootCauseCode | null,
          appliesTo: Array.isArray(l.appliesTo) ? l.appliesTo.map(String) : [],
          source: (l.source === 'USER_TAUGHT' || l.source === 'SUBAGENT_REPORT' ? l.source : 'SELF_DERIVED'),
          confidence: Number(l.confidence ?? 0.6),
          timesApplied: Number(l.timesApplied ?? 0),
          timesValidated: Number(l.timesValidated ?? 0),
          timesFailed: Number(l.timesFailed ?? 0),
          needsReview: Boolean(l.needsReview),
          createdAt: toIsoDate(l.createdAt),
          embeddingId: null,
        }
        await upsertLessonRecord(lessonNode)
        stats.lessonRecordsBackfilled++
      } catch (err) {
        stats.errors.push(`mirror lesson ${l.id}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  } catch (err) {
    stats.errors.push(`tier-3b: ${err instanceof Error ? err.message : String(err)}`)
  }

  return stats
}

/**
 * Boot wrapper — check desync TRƯỚC (rẻ: 4 count query), chỉ heal khi thật
 * sự lệch. Env TMO_EPISODIC_HEAL=0 tắt hẳn (vận hành chủ ý). Mỗi process
 * chạy tối đa 1 lần (flag globalThis — pattern ensureCommunitiesLazy).
 */
export async function maybeHealEpisodicStores(): Promise<{ healed: boolean; stats?: EpisodicHealStats; reason: string }> {
  const g = globalThis as unknown as {
    __tmoEpisodicHealRunning?: boolean
    __tmoEpisodicHealDone?: boolean
  }
  if (process.env.TMO_EPISODIC_HEAL === '0') return { healed: false, reason: 'disabled by env' }
  if (g.__tmoEpisodicHealRunning) return { healed: false, reason: 'already running' }
  if (g.__tmoEpisodicHealDone) return { healed: false, reason: 'already done this process' }

  try {
    const [graphCounts, qdrantPoints, episodeRecords, lessonRecords] = await Promise.all([
      getEpisodicGraphCounts().catch(() => null),
      getEpisodePointCount().catch(() => 0),
      countEpisodeRecords().catch(() => 0),
      countLessonRecords().catch(() => 0),
    ])
    if (!graphCounts || graphCounts.episodes === 0) {
      g.__tmoEpisodicHealDone = true
      return { healed: false, reason: 'no episodes in graph — nothing to heal' }
    }
    const synced =
      qdrantPoints >= graphCounts.episodes &&
      episodeRecords >= graphCounts.episodes &&
      lessonRecords >= graphCounts.lessons
    if (synced) {
      g.__tmoEpisodicHealDone = true
      return { healed: false, reason: `synced (episodes=${graphCounts.episodes}, qdrant=${qdrantPoints}, mirror=${episodeRecords}/${lessonRecords})` }
    }
    console.log(
      `[Episodic Heal] Phát hiện desync sau reset — Neo4j: ${graphCounts.episodes} episodes/${graphCounts.lessons} lessons, ` +
      `Qdrant points: ${qdrantPoints}, SQLite mirror: ${episodeRecords} ep/${lessonRecords} lesson → chạy heal nền (idempotent)`
    )
  } catch (err) {
    return { healed: false, reason: `desync check failed: ${err instanceof Error ? err.message : String(err)}` }
  }

  g.__tmoEpisodicHealRunning = true
  try {
    const stats = await healEpisodicStores()
    g.__tmoEpisodicHealDone = true
    console.log(
      `[Episodic Heal] Hoàn tất: scanned=${stats.episodesScanned}, re-embed=${stats.embeddingsCreated}, ` +
      `neo4j embedding_id updated=${stats.embeddingIdsUpdated}, mirror backfill=${stats.episodeRecordsBackfilled} ep/` +
      `${stats.lessonRecordsBackfilled} lesson${stats.errors.length > 0 ? `, errors=${stats.errors.length} (xem dev.log)` : ''}`
    )
    if (stats.errors.length > 0) console.warn('[Episodic Heal] Chi tiết lỗi:', stats.errors.slice(0, 5).join(' | '))
    return { healed: true, stats, reason: 'healed' }
  } finally {
    g.__tmoEpisodicHealRunning = false
  }
}
