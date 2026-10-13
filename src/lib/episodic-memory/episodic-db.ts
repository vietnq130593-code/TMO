/**
 * EPISODIC DB — SQLite mirror bridge (A6 · EpisodeRecord + LessonRecord)
 *
 * Pattern metrics-db.ts: dev server cache Prisma instance trên globalThis —
 * sau `prisma db push` thêm MODEL MỚI, instance cũ không có delegate →
 * TypeError. KHÔNG restart PM2 được → cầu nối:
 *   - Delegate path (type-safe) khi instance fresh
 *   - Raw SQL path khi stale (bảng đã tồn tại sau db:push)
 *
 * Vai trò mirror: Neo4j là graph PRIMARY (quan hệ Episode→Action→Error,
 * Lesson→ABOUT→Concept); SQLite mirror giữ data khi Neo4j drift/reset +
 * dashboard UI đọc nhanh + fallback lessons cho PRE-ACT khi graph down.
 *
 * Fail-open: hàm throw lên caller — caller (recorder/PRE-ACT/API route)
 * tự .catch(() => {}) theo pattern fire-and-forget.
 */

import { db } from '@/lib/db'
// OBS-P2 hook (§C.3 đợt 2) — learn.episode (static — không chu trình)
import { observeEvent } from '@/lib/observation/ledger'
import { clampSqlLimit } from '@/lib/sql-policy'
import type { EpisodeNode, LessonNode } from './types'

// ==================== DELEGATE DETECTION ====================

function hasEpisodeRecordDelegate(): boolean {
  try {
    return typeof (db as unknown as Record<string, unknown>).episodeRecord !== 'undefined'
  } catch {
    return false
  }
}

function hasLessonRecordDelegate(): boolean {
  try {
    return typeof (db as unknown as Record<string, unknown>).lessonRecord !== 'undefined'
  } catch {
    return false
  }
}

function randomId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
}

// ==================== EPISODE RECORD ====================

export interface EpisodeRecordRow {
  id: string
  title: string
  goal: string
  contextSummary: string
  outcome: string
  confidence: number
  agent: string
  sessionId: string | null
  importance: number
  accessCount: number
  cycles: number | null
  tokensUsed: number | null
  toolCalls: number | null
  toolFailures: number | null
  stopReason: string | null
  actionsJson: string | null
  errorsJson: string | null
  lessonsJson: string | null
  embeddingId: string | null
  startedAt: Date | null
  endedAt: Date | null
  createdAt: Date
}

/** Upsert EpisodeRecord theo id (id trùng Neo4j Episode node) */
export async function upsertEpisodeRecord(params: {
  episode: EpisodeNode
  actionsJson: string
  errorsJson: string
  lessonsJson: string
}): Promise<void> {
  const { episode, actionsJson, errorsJson, lessonsJson } = params
  const e = episode
  if (hasEpisodeRecordDelegate()) {
    await db.episodeRecord.upsert({
      where: { id: e.id },
      create: {
        id: e.id, title: e.title, goal: e.goal, contextSummary: e.contextSummary,
        outcome: e.outcome, confidence: e.confidence, agent: e.agent,
        sessionId: e.sessionId ?? null, importance: e.importance,
        accessCount: e.accessCount, cycles: e.cycles ?? null,
        tokensUsed: e.tokensUsed ?? null, toolCalls: e.toolCalls ?? null,
        toolFailures: e.toolFailures ?? null, stopReason: e.stopReason ?? null,
        actionsJson, errorsJson, lessonsJson,
        embeddingId: e.embeddingId ?? null,
        startedAt: e.startedAt, endedAt: e.endedAt,
      },
      update: {
        title: e.title, goal: e.goal, contextSummary: e.contextSummary,
        outcome: e.outcome, confidence: e.confidence, agent: e.agent,
        importance: e.importance, accessCount: e.accessCount,
        cycles: e.cycles ?? null, tokensUsed: e.tokensUsed ?? null,
        toolCalls: e.toolCalls ?? null, toolFailures: e.toolFailures ?? null,
        stopReason: e.stopReason ?? null,
        actionsJson, errorsJson, lessonsJson,
        embeddingId: e.embeddingId ?? null,
        startedAt: e.startedAt, endedAt: e.endedAt,
      },
    })
    // OBS-P2 hook (§C.3 đợt 2 — learn.episode, nhánh delegate)
    observeEvent({
      actor: e.agent ? `agent:${e.agent}` : 'system',
      kind: 'learn.episode',
      sessionId: e.sessionId ?? null,
      table: 'EpisodeRecord',
      rowKey: e.id,
      summary: `Episode "${(e.title ?? '').slice(0, 60)}" — ${e.outcome ?? '?'} (conf ${e.confidence.toFixed(2)})`,
      payload: { id: e.id, title: e.title, outcome: e.outcome, confidence: e.confidence, agent: e.agent },
    })
    return
  }

  await db.$executeRaw`
    INSERT INTO EpisodeRecord (
      id, title, goal, contextSummary, outcome, confidence, agent, sessionId,
      importance, accessCount, cycles, tokensUsed, toolCalls, toolFailures,
      stopReason, actionsJson, errorsJson, lessonsJson, embeddingId,
      startedAt, endedAt, createdAt
    ) VALUES (
      ${e.id}, ${e.title}, ${e.goal}, ${e.contextSummary}, ${e.outcome},
      ${e.confidence}, ${e.agent}, ${e.sessionId ?? null},
      ${e.importance}, ${e.accessCount}, ${e.cycles ?? null},
      ${e.tokensUsed ?? null}, ${e.toolCalls ?? null}, ${e.toolFailures ?? null},
      ${e.stopReason ?? null}, ${actionsJson}, ${errorsJson}, ${lessonsJson},
      ${e.embeddingId ?? null}, ${e.startedAt}, ${e.endedAt}, ${new Date()}
    )
    ON CONFLICT(id) DO UPDATE SET
      title = excluded.title, goal = excluded.goal,
      contextSummary = excluded.contextSummary, outcome = excluded.outcome,
      confidence = excluded.confidence, agent = excluded.agent,
      importance = excluded.importance, accessCount = excluded.accessCount,
      cycles = excluded.cycles, tokensUsed = excluded.tokensUsed,
      toolCalls = excluded.toolCalls, toolFailures = excluded.toolFailures,
      stopReason = excluded.stopReason, actionsJson = excluded.actionsJson,
      errorsJson = excluded.errorsJson, lessonsJson = excluded.lessonsJson,
      embeddingId = excluded.embeddingId,
      startedAt = excluded.startedAt, endedAt = excluded.endedAt
  `
  // OBS-P2 hook (§C.3 đợt 2 — learn.episode, nhánh raw fallback)
  observeEvent({
    actor: e.agent ? `agent:${e.agent}` : 'system',
    kind: 'learn.episode',
    sessionId: e.sessionId ?? null,
    table: 'EpisodeRecord',
    rowKey: e.id,
    summary: `Episode "${(e.title ?? '').slice(0, 60)}" — ${e.outcome ?? '?'} (conf ${e.confidence.toFixed(2)})`,
    payload: { id: e.id, title: e.title, outcome: e.outcome, confidence: e.confidence, agent: e.agent },
  })
}

/** Đếm episode records (dashboard + health) */
export async function countEpisodeRecords(): Promise<number> {
  try {
    if (hasEpisodeRecordDelegate()) return await db.episodeRecord.count()
    const rows = await db.$queryRaw<Array<{ n: number | bigint }>>`SELECT COUNT(*) AS n FROM EpisodeRecord`
    return Number(rows[0]?.n ?? 0)
  } catch {
    return 0
  }
}

/** Episode records gần đây (dashboard fallback khi Neo4j down) */
export async function findRecentEpisodeRecords(limit = 20): Promise<EpisodeRecordRow[]> {
  try {
    if (hasEpisodeRecordDelegate()) {
      return await db.episodeRecord.findMany({ orderBy: { createdAt: 'desc' }, take: limit })
    }
    // P0-3: LIMIT bind placeholder (? thứ 1) + clamp số nguyên — không nối chuỗi
    // vào SQL (LIMIT -1 trong SQLite = KHÔNG GIỚI HẠN → đọc cả bảng).
    return await db.$queryRawUnsafe<EpisodeRecordRow[]>(
      `SELECT * FROM EpisodeRecord ORDER BY createdAt DESC LIMIT ?`,
      clampSqlLimit(limit)
    )
  } catch {
    return []
  }
}

// ==================== LESSON RECORD ====================

export interface LessonRecordRow {
  id: string
  statement: string
  triggerCondition: string | null
  rootCause: string | null
  appliesTo: string | null
  source: string
  confidence: number
  timesApplied: number
  timesValidated: number
  timesFailed: number
  needsReview: boolean
  embeddingId: string | null
  createdAt: Date
  updatedAt: Date
}

/** Coerce raw SQLite row (needsReview 0/1) → boolean */
type RawLessonRow = Omit<LessonRecordRow, 'needsReview'> & { needsReview: number | boolean | null }
function coerceLessonRows(rows: RawLessonRow[]): LessonRecordRow[] {
  return rows.map(r => ({ ...r, needsReview: !!r.needsReview }))
}

/** Upsert LessonRecord theo id */
export async function upsertLessonRecord(lesson: LessonNode): Promise<void> {
  const appliesTo = JSON.stringify(lesson.appliesTo)
  if (hasLessonRecordDelegate()) {
    await db.lessonRecord.upsert({
      where: { id: lesson.id },
      create: {
        id: lesson.id, statement: lesson.statement,
        triggerCondition: lesson.triggerCondition ?? null,
        rootCause: lesson.rootCause ?? null, appliesTo,
        source: lesson.source, confidence: lesson.confidence,
        timesApplied: lesson.timesApplied, timesValidated: lesson.timesValidated,
        timesFailed: lesson.timesFailed, needsReview: lesson.needsReview ?? false,
        embeddingId: lesson.embeddingId ?? null,
      },
      update: {
        statement: lesson.statement,
        triggerCondition: lesson.triggerCondition ?? null,
        rootCause: lesson.rootCause ?? null, appliesTo,
        confidence: lesson.confidence,
        timesApplied: lesson.timesApplied, timesValidated: lesson.timesValidated,
        timesFailed: lesson.timesFailed, needsReview: lesson.needsReview ?? false,
        embeddingId: lesson.embeddingId ?? null,
      },
    })
    // OBS-P2 hook (§C.3 đợt 2 — learn.episode cho LessonRecord, nhánh delegate)
    observeEvent({
      actor: 'system',
      kind: 'learn.episode',
      table: 'LessonRecord',
      rowKey: lesson.id,
      summary: `Lesson: "${lesson.statement.slice(0, 70)}" (conf ${lesson.confidence.toFixed(2)}${lesson.needsReview ? ' · cần duyệt' : ''})`,
      payload: { id: lesson.id, statement: lesson.statement.slice(0, 200), confidence: lesson.confidence, needsReview: lesson.needsReview ?? false },
    })
    return
  }

  await db.$executeRaw`
    INSERT INTO LessonRecord (
      id, statement, triggerCondition, rootCause, appliesTo, source,
      confidence, timesApplied, timesValidated, timesFailed, needsReview,
      embeddingId, createdAt, updatedAt
    ) VALUES (
      ${lesson.id}, ${lesson.statement}, ${lesson.triggerCondition ?? null},
      ${lesson.rootCause ?? null}, ${appliesTo}, ${lesson.source},
      ${lesson.confidence}, ${lesson.timesApplied}, ${lesson.timesValidated},
      ${lesson.timesFailed}, ${(lesson.needsReview ?? false) ? 1 : 0},
      ${lesson.embeddingId ?? null}, ${lesson.createdAt}, ${new Date()}
    )
    ON CONFLICT(id) DO UPDATE SET
      statement = excluded.statement,
      triggerCondition = excluded.triggerCondition,
      rootCause = excluded.rootCause, appliesTo = excluded.appliesTo,
      confidence = excluded.confidence,
      timesApplied = excluded.timesApplied,
      timesValidated = excluded.timesValidated,
      timesFailed = excluded.timesFailed,
      needsReview = excluded.needsReview,
      embeddingId = excluded.embeddingId,
      updatedAt = excluded.updatedAt
  `
  // OBS-P2 hook (§C.3 đợt 2 — learn.episode cho LessonRecord, nhánh raw fallback)
  observeEvent({
    actor: 'system',
    kind: 'learn.episode',
    table: 'LessonRecord',
    rowKey: lesson.id,
    summary: `Lesson: "${lesson.statement.slice(0, 70)}" (conf ${lesson.confidence.toFixed(2)}${lesson.needsReview ? ' · cần duyệt' : ''})`,
    payload: { id: lesson.id, statement: lesson.statement.slice(0, 200), confidence: lesson.confidence, needsReview: lesson.needsReview ?? false },
  })
}

/** Tìm lesson theo statement contains (check trùng khi sinh lesson mới) */
export async function findLessonsByStatementFragment(fragment: string, limit = 5): Promise<LessonRecordRow[]> {
  const pattern = `%${fragment.slice(0, 120)}%`
  try {
    if (hasLessonRecordDelegate()) {
      return await db.lessonRecord.findMany({
        where: { statement: { contains: fragment.slice(0, 120) } },
        orderBy: { confidence: 'desc' }, take: limit,
      })
    }
    const raw = await db.$queryRaw<RawLessonRow[]>`
      SELECT * FROM LessonRecord WHERE statement LIKE ${pattern}
      ORDER BY confidence DESC LIMIT ${limit}
    `
    return coerceLessonRows(raw)
  } catch {
    return []
  }
}

/** Tất cả lessons (dashboard + PRE-ACT fallback khi Neo4j down) */
export async function findAllLessonRecords(minConfidence = 0, limit = 100): Promise<LessonRecordRow[]> {
  try {
    if (hasLessonRecordDelegate()) {
      return await db.lessonRecord.findMany({
        where: { confidence: { gte: minConfidence } },
        orderBy: { confidence: 'desc' }, take: limit,
      })
    }
    // P0-3: cả confidence lẫn LIMIT đều bind placeholder — không nối chuỗi SQL.
    const minConf = Number(minConfidence)
    return await db.$queryRawUnsafe<RawLessonRow[]>(
      `SELECT * FROM LessonRecord WHERE confidence >= ? ORDER BY confidence DESC LIMIT ?`,
      Number.isFinite(minConf) ? minConf : 0,
      clampSqlLimit(limit)
    ).then(coerceLessonRows)
  } catch {
    return []
  }
}

/** Đọc 1 lesson theo id (validate trước times_validated++) */
export async function findLessonRecordById(id: string): Promise<LessonRecordRow | null> {
  try {
    if (hasLessonRecordDelegate()) {
      return await db.lessonRecord.findUnique({ where: { id } })
    }
    const rows = await db.$queryRaw<RawLessonRow[]>`SELECT * FROM LessonRecord WHERE id = ${id} LIMIT 1`
    return coerceLessonRows(rows)[0] ?? null
  } catch {
    return null
  }
}

/** Đếm lessons (dashboard) */
export async function countLessonRecords(): Promise<number> {
  try {
    if (hasLessonRecordDelegate()) return await db.lessonRecord.count()
    const rows = await db.$queryRaw<Array<{ n: number | bigint }>>`SELECT COUNT(*) AS n FROM LessonRecord`
    return Number(rows[0]?.n ?? 0)
  } catch {
    return 0
  }
}

/** Bật/tắt needsReview (user review từ UI) */
export async function setLessonNeedsReview(id: string, needsReview: boolean): Promise<void> {
  if (hasLessonRecordDelegate()) {
    await db.lessonRecord.update({ where: { id }, data: { needsReview } })
    return
  }
  await db.$executeRaw`
    UPDATE LessonRecord SET needsReview = ${needsReview ? 1 : 0}, updatedAt = ${new Date()}
    WHERE id = ${id}
  `
}

export { randomId }
