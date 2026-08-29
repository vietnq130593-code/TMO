/**
 * EPISODIC NEO4J — graph layer cho Episodic Memory (A6 · A.2-A.4)
 *
 * Neo4j giữ vai trò CẤU TRÚC & QUAN HỆ (pattern lỗi, lesson, chuỗi thời
 * gian); Qdrant giữ vai trò SEMANTIC INDEX (tìm episode giống — xem
 * episode-store.ts). Đúng pattern GraphRAG đang có của TMO.
 *
 * Nodes: Episode, Action, ErrorOccurrence, Lesson, Strategy, Session
 * Rels:  CONTAINS, PRODUCED, FOLLOWED_STRATEGY, YIELDED, TAUGHT,
 *        RESOLVED_BY, SIMILAR_TO, SAME_PATTERN_AS, INVOLVES, ABOUT,
 *        RELATES_TO, NEXT_EPISODE, PART_OF_SESSION
 *
 * KB bridge (nguyên tắc A.1 #3 — episode liên kết semantic KB):
 *   (Episode)-[:INVOLVES]->(Concept|Technology|...) — node KB theo tên
 *   (Lesson)-[:ABOUT]->(Concept|Technology|...)
 *   (ErrorOccurrence)-[:RELATES_TO]->(Technology|...)
 *
 * Fail-open: mọi hàm catch lỗi Neo4j (down/driver null — executeCypher
 * throw) và trả giá trị an toàn — episodic memory KHÔNG BAO GIỜ được làm
 * hỏng agent runtime. Log prefix `[Episodic]`.
 */

import { executeCypher, readCypher } from '@/lib/neo4j'
import type {
  ActionNode,
  EpisodeNode,
  ErrorOccurrenceNode,
  LessonNode,
  RootCauseCode,
} from './types'

// ==================== SCHEMA INIT (idempotent) ====================

const SCHEMA_STATEMENTS = [
  // Constraints — UNIQUE id cho mọi episodic node type
  'CREATE CONSTRAINT episode_id_unique IF NOT EXISTS FOR (e:Episode) REQUIRE e.id IS UNIQUE',
  'CREATE CONSTRAINT action_id_unique IF NOT EXISTS FOR (a:Action) REQUIRE a.id IS UNIQUE',
  'CREATE CONSTRAINT errorocc_id_unique IF NOT EXISTS FOR (e:ErrorOccurrence) REQUIRE e.id IS UNIQUE',
  'CREATE CONSTRAINT lesson_id_unique IF NOT EXISTS FOR (l:Lesson) REQUIRE l.id IS UNIQUE',
  'CREATE CONSTRAINT strategy_id_unique IF NOT EXISTS FOR (s:Strategy) REQUIRE s.id IS UNIQUE',
  'CREATE CONSTRAINT session_id_unique IF NOT EXISTS FOR (s:Session) REQUIRE s.id IS UNIQUE',
  // Indexes — retrieval ranking (A.4 Q3/Q4/Q5 quét các field này)
  'CREATE INDEX episode_importance IF NOT EXISTS FOR (e:Episode) ON (e.importance)',
  'CREATE INDEX episode_last_accessed IF NOT EXISTS FOR (e:Episode) ON (e.last_accessed)',
  'CREATE INDEX episode_agent IF NOT EXISTS FOR (e:Episode) ON (e.agent)',
  'CREATE INDEX episode_outcome IF NOT EXISTS FOR (e:Episode) ON (e.outcome)',
  'CREATE INDEX lesson_confidence IF NOT EXISTS FOR (l:Lesson) ON (l.confidence)',
  'CREATE INDEX lesson_needs_review IF NOT EXISTS FOR (l:Lesson) ON (l.needs_review)',
  'CREATE INDEX errorocc_category IF NOT EXISTS FOR (e:ErrorOccurrence) ON (e.category)',
  'CREATE INDEX errorocc_root_cause IF NOT EXISTS FOR (e:ErrorOccurrence) ON (e.root_cause)',
  'CREATE INDEX errorocc_resolved IF NOT EXISTS FOR (e:ErrorOccurrence) ON (e.resolved)',
]

/** Đã init schema trong process này chưa (tránh lặp lại mỗi chat run) */
const g = globalThis as unknown as { __tmoEpisodicSchemaReady?: boolean }

/**
 * Khởi tạo constraints/indexes cho episodic memory — idempotent (IF NOT
 * EXISTS), gọi 1 lần mỗi process. An toàn gọi nhiều lần.
 */
export async function ensureEpisodicSchema(): Promise<boolean> {
  if (g.__tmoEpisodicSchemaReady) return true
  try {
    for (const stmt of SCHEMA_STATEMENTS) {
      try {
        await executeCypher(stmt)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        // "already exists"/"EquivalentIndex" → OK (idempotent), lỗi khác → log
        if (!/already exists|equivalent/i.test(msg)) {
          console.warn(`[Episodic] schema stmt warn: ${msg.slice(0, 160)}`)
        }
      }
    }
    g.__tmoEpisodicSchemaReady = true
    console.log('[Episodic] Neo4j episodic schema ready (6 node types, constraints + indexes)')
    return true
  } catch (err) {
    console.error('[Episodic] ensureEpisodicSchema failed:', err instanceof Error ? err.message : String(err))
    return false
  }
}

// ==================== Q1 — GHI EPISODE (pipeline A.5 bước 4) ====================

/**
 * Ghi Episode + Action + ErrorOccurrence nodes + quan hệ CONTAINS/PRODUCED
 * vào Neo4j. Ghi 1 lần (UNWIND batch) — node Episode cha được MERGE theo id
 * (retry-an-toàn), Action/ErrorOccurrence con DETACH DELETE cũ rồi tạo lại
 * (re-recording cùng episode id không nhân bản).
 */
export async function writeEpisodeGraph(params: {
  episode: EpisodeNode
  actions: ActionNode[]
  errors: ErrorOccurrenceNode[]
  /** ErrorOccurrence nào được resolve bởi action nào (errorId → actionId) */
  resolvedBy?: Record<string, string>
  /** Lesson ids episode này sinh ra → (Episode)-[:YIELDED]->(Lesson) */
  yieldedLessonIds?: string[]
  /** Episode ids tương tự → (Episode)-[:SIMILAR_TO {score}]->(Episode) */
  similarTo?: Array<{ episodeId: string; score: number }>
}): Promise<boolean> {
  const { episode, actions, errors, resolvedBy = {}, yieldedLessonIds = [], similarTo = [] } = params
  try {
    await ensureEpisodicSchema()

    // Node Episode (MERGE theo id — idempotent)
    await executeCypher(
      `MERGE (e:Episode {id: $id})
       SET e.title = $title, e.goal = $goal, e.context_summary = $contextSummary,
           e.outcome = $outcome, e.confidence = $confidence, e.agent = $agent,
           e.started_at = datetime($startedAt), e.ended_at = datetime($endedAt),
           e.importance = $importance, e.access_count = $accessCount,
           e.last_accessed = datetime($lastAccessed),
           e.session_id = $sessionId, e.embedding_id = $embeddingId,
           e.cycles = $cycles, e.tokens_used = $tokensUsed,
           e.tool_calls = $toolCalls, e.tool_failures = $toolFailures,
           e.stop_reason = $stopReason`,
      {
        id: episode.id,
        title: episode.title,
        goal: episode.goal,
        contextSummary: episode.contextSummary,
        outcome: episode.outcome,
        confidence: episode.confidence,
        agent: episode.agent,
        startedAt: episode.startedAt.toISOString(),
        endedAt: episode.endedAt.toISOString(),
        importance: episode.importance,
        accessCount: episode.accessCount,
        lastAccessed: episode.lastAccessed.toISOString(),
        sessionId: episode.sessionId ?? '',
        embeddingId: episode.embeddingId ?? '',
        cycles: episode.cycles ?? 0,
        tokensUsed: episode.tokensUsed ?? 0,
        toolCalls: episode.toolCalls ?? 0,
        toolFailures: episode.toolFailures ?? 0,
        stopReason: episode.stopReason ?? '',
      }
    )

    // Xoá Action/ErrorOccurrence cũ của episode (re-record cùng id)
    await executeCypher(
      `MATCH (e:Episode {id: $id})-[:CONTAINS]->(old)
       DETACH DELETE old`,
      { id: episode.id }
    )

    // Action nodes + CONTAINS
    if (actions.length > 0) {
      await executeCypher(
        `UNWIND $actions AS a
         MATCH (e:Episode {id: $episodeId})
         CREATE (act:Action {
           id: a.id, sequence: a.sequence, tool: a.tool,
           input_summary: a.inputSummary, reasoning: a.reasoning,
           result: a.result, error_ref: a.errorRef
         })
         CREATE (e)-[:CONTAINS {order: a.sequence}]->(act)`,
        { episodeId: episode.id, actions: actions.map(a => ({
          id: a.id, sequence: a.sequence, tool: a.tool,
          inputSummary: a.inputSummary, reasoning: a.reasoning ?? '',
          result: a.result, errorRef: a.errorRef ?? '',
        })) }
      )
    }

    // ErrorOccurrence nodes + PRODUCED + TAUGHT + RESOLVED_BY
    if (errors.length > 0) {
      await executeCypher(
        `UNWIND $errors AS er
         MATCH (e:Episode {id: $episodeId})
         CREATE (occ:ErrorOccurrence {
           id: er.id, raw_message: er.rawMessage, category: er.category,
           root_cause: er.rootCause, manifestation: er.manifestation,
           occurred_at: datetime(er.occurredAt), resolved: er.resolved,
           fix_summary: er.fixSummary
         })
         CREATE (e)-[:PRODUCED]->(occ)`,
        { episodeId: episode.id, errors: errors.map(e => ({
          id: e.id, rawMessage: e.rawMessage, category: e.category,
          rootCause: e.rootCause, manifestation: e.manifestation ?? '',
          occurredAt: e.occurredAt.toISOString(), resolved: e.resolved,
          fixSummary: e.fixSummary ?? '',
        })) }
      )
      // (ErrorOccurrence)-[:RESOLVED_BY]->(Action)
      const resolvedPairs = Object.entries(resolvedBy)
      if (resolvedPairs.length > 0) {
        await executeCypher(
          `UNWIND $pairs AS p
           MATCH (err:ErrorOccurrence {id: p.errorId})
           MATCH (act:Action {id: p.actionId})
           MERGE (err)-[:RESOLVED_BY]->(act)`,
          { pairs: resolvedPairs.map(([errorId, actionId]) => ({ errorId, actionId })) }
        )
      }
    }

    // (Episode)-[:YIELDED]->(Lesson)
    if (yieldedLessonIds.length > 0) {
      await executeCypher(
        `UNWIND $lessonIds AS lid
         MATCH (e:Episode {id: $episodeId})
         MATCH (l:Lesson {id: lid})
         MERGE (e)-[:YIELDED]->(l)`,
        { episodeId: episode.id, lessonIds: yieldedLessonIds }
      )
    }

    // (Episode)-[:SIMILAR_TO {score}]->(Episode)
    if (similarTo.length > 0) {
      await executeCypher(
        `UNWIND $sims AS s
         MATCH (e:Episode {id: $episodeId})
         MATCH (other:Episode {id: s.episodeId})
         MERGE (e)-[:SIMILAR_TO {score: s.score}]->(other)`,
        { episodeId: episode.id, sims: similarTo }
      )
    }

    // (Episode)-[:PART_OF_SESSION]->(Session)
    if (episode.sessionId) {
      await executeCypher(
        `MERGE (s:Session {id: $sessionId})
         WITH s
         MATCH (e:Episode {id: $episodeId})
         MERGE (e)-[:PART_OF_SESSION]->(s)`,
        { sessionId: episode.sessionId, episodeId: episode.id }
      )
    }

    return true
  } catch (err) {
    console.error('[Episodic] writeEpisodeGraph failed:', err instanceof Error ? err.message : String(err))
    return false
  }
}

// ==================== KB BRIDGE (nguyên tắc A.1 #3) ====================

/**
 * Nối Episode/Lesson/ErrorOccurrence sang node KB semantic hiện có
 * (Concept|Technology|Framework|...) THEO TÊN entity xuất hiện trong text.
 * "Episode về Neo4j query fail nối node Neo4j trong KB → khi hỏi về Neo4j,
 * cả tri thức LẪN kinh nghiệm cùng hiện ra."
 */
export async function linkEpisodeToKB(params: {
  episodeId: string
  /** Text quét tên entity (goal + context) */
  text: string
  lessonIds?: string[]
}): Promise<number> {
  const { episodeId, text, lessonIds = [] } = params
  try {
    // Tách token ứng viên từ text (tên entity KB thường là từ kỹ thuật)
    const tokens = Array.from(new Set(
      text.toLowerCase().split(/[^\p{L}\p{N}#+.-]+/u).filter(w => w.length >= 3 && w.length <= 40)
    )).slice(0, 60)
    if (tokens.length === 0) return 0

    // MATCH mọi node KB có name khớp token (label bất kỳ trong KB hiện có)
    const rows = await readCypher<{ name: string }>(
      `MATCH (n)
       WHERE any(l IN labels(n) WHERE l IN ['Concept','Technology','Framework','Vulnerability','Principle','Domain','Document','Person','Tool','System','Algorithm','Language','Technique','Project'])
         AND toLower(n.name) IN $tokens
       RETURN DISTINCT n.name AS name
       LIMIT 12`,
      { tokens }
    )
    if (rows.length === 0) return 0

    const names = rows.map(r => r.name)
    await executeCypher(
      `UNWIND $names AS nm
       MATCH (kb)
       WHERE any(l IN labels(kb) WHERE l IN ['Concept','Technology','Framework','Vulnerability','Principle','Domain','Document','Person','Tool','System','Algorithm','Language','Technique','Project'])
         AND toLower(kb.name) = toLower(nm)
       WITH DISTINCT kb
       MATCH (e:Episode {id: $episodeId})
       MERGE (e)-[:INVOLVES]->(kb)`,
      { names, episodeId }
    )
    // Lesson ABOUT cùng entity
    if (lessonIds.length > 0) {
      await executeCypher(
        `UNWIND $names AS nm
         MATCH (kb)
         WHERE any(l IN labels(kb) WHERE l IN ['Concept','Technology','Framework','Vulnerability','Principle','Domain','Document','Person','Tool','System','Algorithm','Language','Technique','Project'])
           AND toLower(kb.name) = toLower(nm)
         WITH DISTINCT kb
         UNWIND $lessonIds AS lid
         MATCH (l:Lesson {id: lid})
         MERGE (l)-[:ABOUT]->(kb)`,
        { names, lessonIds }
      )
    }
    return names.length
  } catch (err) {
    console.error('[Episodic] linkEpisodeToKB failed:', err instanceof Error ? err.message : String(err))
    return 0
  }
}

// ==================== LESSON NODE OPS ====================

/** Upsert Lesson node (MERGE theo id) — idempotent, không decay. */
export async function upsertLessonNode(lesson: LessonNode): Promise<boolean> {
  try {
    await ensureEpisodicSchema()
    await executeCypher(
      `MERGE (l:Lesson {id: $id})
       SET l.statement = $statement, l.trigger_condition = $triggerCondition,
           l.applies_to = $appliesTo, l.root_cause = $rootCause,
           l.confidence = $confidence, l.times_applied = $timesApplied,
           l.times_validated = $timesValidated, l.times_failed = $timesFailed,
           l.created_at = datetime($createdAt), l.source = $source,
           l.needs_review = $needsReview, l.embedding_id = $embeddingId`,
      {
        id: lesson.id,
        statement: lesson.statement,
        triggerCondition: lesson.triggerCondition ?? '',
        appliesTo: lesson.appliesTo.join(','),
        rootCause: lesson.rootCause ?? '',
        confidence: lesson.confidence,
        timesApplied: lesson.timesApplied,
        timesValidated: lesson.timesValidated,
        timesFailed: lesson.timesFailed,
        createdAt: lesson.createdAt.toISOString(),
        source: lesson.source,
        needsReview: lesson.needsReview ?? false,
        embeddingId: lesson.embeddingId ?? '',
      }
    )
    return true
  } catch (err) {
    console.error('[Episodic] upsertLessonNode failed:', err instanceof Error ? err.message : String(err))
    return false
  }
}

/**
 * Q3 — Lấy lessons áp dụng cho context hiện tại.
 * 2 đường: (a) Lesson-[:ABOUT]->(entity KB) khớp context entities,
 *          (b) fallback: Lesson confidence cao nhất (KB chưa nối entity).
 * ORDER BY confidence * (times_validated + 1) — đúng A.4.
 */
export async function getLessonsForContext(params: {
  contextEntities: string[]
  minConfidence?: number
  limit?: number
}): Promise<Array<Pick<LessonNode, 'id' | 'statement' | 'triggerCondition' | 'confidence' | 'timesValidated'>>> {
  const { contextEntities, minConfidence = 0.6, limit = 5 } = params
  try {
    await ensureEpisodicSchema()
    const tokens = contextEntities.map(e => e.toLowerCase()).slice(0, 60)
    // Đường (a) — qua quan hệ ABOUT
    const viaAbout = await readCypher<{
      id: string; statement: string; triggerCondition: string | null;
      confidence: number; timesValidated: number
    }>(
      `MATCH (l:Lesson)-[:ABOUT]->(t)
       WHERE toLower(t.name) IN $tokens AND l.confidence > $minConfidence
       RETURN DISTINCT l.id AS id, l.statement AS statement,
              l.trigger_condition AS triggerCondition, l.confidence AS confidence,
              l.times_validated AS timesValidated
       ORDER BY l.confidence * (l.times_validated + 1) DESC
       LIMIT toInteger($limit)`,
      { tokens, minConfidence, limit }
    )
    if (viaAbout.length >= 3) return viaAbout

    // Đường (b) — fallback top lessons (mọi lesson đạt ngưỡng)
    const fallback = await readCypher<{
      id: string; statement: string; triggerCondition: string | null;
      confidence: number; timesValidated: number
    }>(
      `MATCH (l:Lesson)
       WHERE l.confidence > $minConfidence
       RETURN l.id AS id, l.statement AS statement,
              l.trigger_condition AS triggerCondition, l.confidence AS confidence,
              l.times_validated AS timesValidated
       ORDER BY l.confidence * (l.times_validated + 1) DESC
       LIMIT toInteger($limit)`,
      { minConfidence, limit }
    )
    // Dedup giữ thứ tự ưu tiên
    const seen = new Set(viaAbout.map(r => r.id))
    return [...viaAbout, ...fallback.filter(r => !seen.has(r.id))].slice(0, limit)
  } catch (err) {
    console.error('[Episodic] getLessonsForContext failed:', err instanceof Error ? err.message : String(err))
    return []
  }
}

/**
 * Q2 — RETRIEVAL "Tôi từng gặp lỗi tương tự chưa?" (trái tim learning loop).
 * MATCH ErrorOccurrence cùng root_cause đã resolve + SAME_PATTERN_AS chain
 * → trả fix + lesson. Chạy TRƯỚC khi hành động (PRE-ACT).
 */
export async function findSimilarResolvedErrors(params: {
  rootCause: RootCauseCode | null
  category?: string
  limit?: number
}): Promise<PreActSimilarError[]> {
  const { rootCause, category, limit = 3 } = params
  if (!rootCause) return []
  try {
    await ensureEpisodicSchema()
    const rows = await readCypher<{
      rawMessage: string; fixSummary: string | null;
      lessonStatement: string | null; lessonConfidence: number | null; occurredAt?: string
    }>(
      `MATCH (similar:ErrorOccurrence)
       WHERE similar.root_cause = $rootCause AND similar.resolved = true
         AND ($category IS NULL OR similar.category = $category)
       OPTIONAL MATCH (similar)-[:RESOLVED_BY]->(fix:Action)
       OPTIONAL MATCH (similar)-[:TAUGHT]->(lesson:Lesson)
       RETURN similar.raw_message AS rawMessage,
              fix.input_summary AS fixSummary,
              lesson.statement AS lessonStatement,
              lesson.confidence AS lessonConfidence,
              similar.occurred_at AS occurredAt
       ORDER BY lessonConfidence DESC, similar.occurred_at DESC
       LIMIT toInteger($limit)`,
      { rootCause, category: category ?? null, limit }
    )
    return rows
  } catch (err) {
    console.error('[Episodic] findSimilarResolvedErrors failed:', err instanceof Error ? err.message : String(err))
    return []
  }
}

export interface PreActSimilarError {
  rawMessage: string
  fixSummary?: string | null
  lessonStatement?: string | null
  lessonConfidence?: number | null
  occurredAt?: string
}

/** Tạo (ErrorOccurrence)-[:TAUGHT]->(Lesson) khi lesson sinh từ error */
export async function linkErrorTaughtLesson(errorId: string, lessonId: string): Promise<void> {
  try {
    await executeCypher(
      `MATCH (err:ErrorOccurrence {id: $errorId}), (l:Lesson {id: $lessonId})
       MERGE (err)-[:TAUGHT]->(l)`,
      { errorId, lessonId }
    )
  } catch { /* fail-open */ }
}

/** (ErrorOccurrence)-[:SAME_PATTERN_AS]->(ErrorOccurrence) cùng root_cause */
export async function linkSamePatternErrors(): Promise<number> {
  try {
    const rows = await executeCypher(
      `MATCH (a:ErrorOccurrence), (b:ErrorOccurrence)
       WHERE a.root_cause = b.root_cause AND a.id < b.id
         AND NOT (a)-[:SAME_PATTERN_AS]-(b)
       MERGE (a)-[:SAME_PATTERN_AS]->(b)
       RETURN count(*) AS n`
    )
    return Number(rows[0]?.n ?? 0)
  } catch {
    return 0
  }
}

// ==================== Q4 — DECAY ====================

/**
 * Q4 — Giảm importance episode không được dùng tới N ngày (×factor).
 * Episode cũ ít liên quan dần — "quên có kiểm soát". Lesson KHÔNG decay.
 */
export async function decayEpisodes(params?: {
  days?: number
  factor?: number
}): Promise<number> {
  const days = params?.days ?? 30
  const factor = params?.factor ?? 0.9
  try {
    await ensureEpisodicSchema()
    const rows = await executeCypher(
      `MATCH (e:Episode)
       WHERE e.last_accessed < datetime() - duration('P' + $days + 'D')
       SET e.importance = e.importance * $factor
       RETURN count(e) AS n`,
      { days: String(days), factor }
    )
    return Number(rows[0]?.n ?? 0)
  } catch (err) {
    console.error('[Episodic] decayEpisodes failed:', err instanceof Error ? err.message : String(err))
    return 0
  }
}

// ==================== Q5 — DASHBOARD ====================

export interface ErrorDashboardRow {
  category: string
  rootCause: string
  occurrences: number
  resolved: number
}

/** Q5 — Lỗi hay gặp nhất (category × root_cause) — input cho Goal Generator */
export async function getErrorDashboard(limit = 10): Promise<ErrorDashboardRow[]> {
  try {
    await ensureEpisodicSchema()
    return await readCypher(
      `MATCH (err:ErrorOccurrence)
       RETURN err.category AS category, err.root_cause AS rootCause,
              count(*) AS occurrences,
              sum(CASE WHEN err.resolved THEN 1 ELSE 0 END) AS resolved
       ORDER BY occurrences DESC
       LIMIT toInteger($limit)`,
      { limit }
    )
  } catch {
    return []
  }
}

/** Pattern escalation (C.2): root_cause lặp ≥ N lần → đề xuất cải tiến hệ thống */
export async function getEscalationCandidates(minOccurrences = 3): Promise<Array<{
  rootCause: string
  occurrences: number
  resolved: number
  recentErrors: string[]
}>> {
  try {
    await ensureEpisodicSchema()
    return await readCypher(
      `MATCH (err:ErrorOccurrence)
       WITH err.root_cause AS rootCause, count(*) AS occurrences,
            sum(CASE WHEN err.resolved THEN 1 ELSE 0 END) AS resolved,
            collect(err.raw_message)[..3] AS recentErrors
       WHERE occurrences >= $minOccurrences
       RETURN rootCause, occurrences, resolved, recentErrors
       ORDER BY occurrences DESC`,
      { minOccurrences }
    )
  } catch {
    return []
  }
}

/** Episode gần đây nhất cho UI */
export async function getRecentEpisodes(limit = 20): Promise<Array<Record<string, unknown>>> {
  try {
    await ensureEpisodicSchema()
    return await readCypher(
      `MATCH (e:Episode)
       OPTIONAL MATCH (e)-[:CONTAINS]->(a:Action)
       OPTIONAL MATCH (e)-[:YIELDED]->(l:Lesson)
       RETURN e.id AS id, e.title AS title, e.goal AS goal, e.outcome AS outcome,
              e.confidence AS confidence, e.agent AS agent, e.importance AS importance,
              e.started_at AS startedAt, e.ended_at AS endedAt,
              e.cycles AS cycles, e.tokens_used AS tokensUsed,
              e.tool_calls AS toolCalls, e.tool_failures AS toolFailures,
              e.stop_reason AS stopReason, e.session_id AS sessionId,
              count(DISTINCT a) AS actionCount, collect(DISTINCT l.id)[..8] AS lessonIds
       ORDER BY e.started_at DESC
       LIMIT toInteger($limit)`,
      { limit }
    )
  } catch {
    return []
  }
}

/** Đọc 1 episode full (actions + errors) cho UI detail */
export async function getEpisodeDetail(episodeId: string): Promise<{
  episode: Record<string, unknown> | null
  actions: Array<Record<string, unknown>>
  errors: Array<Record<string, unknown>>
  lessons: Array<Record<string, unknown>>
}> {
  try {
    await ensureEpisodicSchema()
    const episodes = await readCypher(
      `MATCH (e:Episode {id: $id}) RETURN e.id AS id, e.title AS title, e.goal AS goal,
       e.context_summary AS contextSummary, e.outcome AS outcome, e.confidence AS confidence,
       e.agent AS agent, e.importance AS importance, e.started_at AS startedAt,
       e.ended_at AS endedAt, e.cycles AS cycles, e.tokens_used AS tokensUsed,
       e.tool_calls AS toolCalls, e.tool_failures AS toolFailures,
       e.stop_reason AS stopReason, e.session_id AS sessionId, e.embedding_id AS embeddingId`,
      { id: episodeId }
    )
    if (episodes.length === 0) return { episode: null, actions: [], errors: [], lessons: [] }
    const actions = await readCypher(
      `MATCH (:Episode {id: $id})-[:CONTAINS]->(a:Action)
       RETURN a.id AS id, a.sequence AS sequence, a.tool AS tool,
              a.input_summary AS inputSummary, a.reasoning AS reasoning,
              a.result AS result, a.error_ref AS errorRef
       ORDER BY a.sequence`, { id: episodeId }
    )
    const errors = await readCypher(
      `MATCH (:Episode {id: $id})-[:PRODUCED]->(err:ErrorOccurrence)
       RETURN err.id AS id, err.raw_message AS rawMessage, err.category AS category,
              err.root_cause AS rootCause, err.manifestation AS manifestation,
              err.occurred_at AS occurredAt, err.resolved AS resolved,
              err.fix_summary AS fixSummary`, { id: episodeId }
    )
    const lessons = await readCypher(
      `MATCH (:Episode {id: $id})-[:YIELDED]->(l:Lesson)
       RETURN l.id AS id, l.statement AS statement, l.confidence AS confidence,
              l.times_validated AS timesValidated, l.times_failed AS timesFailed,
              l.source AS source`, { id: episodeId }
    )
    return { episode: episodes[0], actions, errors, lessons }
  } catch {
    return { episode: null, actions: [], errors: [], lessons: [] }
  }
}

/** Tăng access_count + last_accessed khi episode được retrieve (càng dùng càng sống) */
export async function touchEpisode(episodeId: string): Promise<void> {
  try {
    await executeCypher(
      `MATCH (e:Episode {id: $id})
       SET e.access_count = coalesce(e.access_count, 0) + 1,
           e.last_accessed = datetime()`,
      { id: episodeId }
    )
  } catch { /* fail-open */ }
}

/** Lesson có tồn tại không (validate trước khi times_validated++) */
export async function lessonExists(lessonId: string): Promise<boolean> {
  try {
    const rows = await readCypher(
      'MATCH (l:Lesson {id: $id}) RETURN l.id AS id', { id: lessonId }
    )
    return rows.length > 0
  } catch {
    return false
  }
}

// ==================== PRE-ACT INSIGHTS (C.1 nhịp 1) ====================

export interface EpisodeInsight {
  /** ErrorOccurrence CHƯA resolve của các episode tương tự → cảnh báo trong plan */
  unresolvedErrors: Array<{
    episodeId: string
    rawMessage: string
    rootCause: string
    category: string
  }>
  /** Lessons của các episode tương tự (YIELDED) */
  lessons: Array<{
    id: string
    statement: string
    triggerCondition: string | null
    confidence: number
    timesValidated: number
  }>
}

/**
 * Lấy insights từ các episode tương tự (PRE-ACT gọi sau khi Qdrant search
 * xong): lỗi chưa resolve → cảnh báo trước khi hành động; lesson của
 * episode từng gặp vấn đề tương tự → áp dụng ngay vào plan.
 */
export async function getEpisodeInsights(episodeIds: string[]): Promise<EpisodeInsight> {
  if (episodeIds.length === 0) return { unresolvedErrors: [], lessons: [] }
  try {
    await ensureEpisodicSchema()
    const unresolvedErrors = await readCypher<{
      episodeId: string; rawMessage: string; rootCause: string; category: string
    }>(
      `UNWIND $ids AS eid
       MATCH (ep:Episode {id: eid})-[:PRODUCED]->(err:ErrorOccurrence)
       WHERE err.resolved = false
       RETURN eid AS episodeId, err.raw_message AS rawMessage,
              err.root_cause AS rootCause, err.category AS category
       LIMIT 5`,
      { ids: episodeIds }
    )
    const lessons = await readCypher<{
      id: string; statement: string; triggerCondition: string | null;
      confidence: number; timesValidated: number
    }>(
      `UNWIND $ids AS eid
       MATCH (ep:Episode {id: eid})-[:YIELDED]->(l:Lesson)
       RETURN DISTINCT l.id AS id, l.statement AS statement,
              l.trigger_condition AS triggerCondition, l.confidence AS confidence,
              l.times_validated AS timesValidated
       ORDER BY l.confidence DESC
       LIMIT 5`,
      { ids: episodeIds }
    )
    return { unresolvedErrors, lessons }
  } catch {
    return { unresolvedErrors: [], lessons: [] }
  }
}

/** Extract context entities từ text — match tên node KB (cho Q3 + KB bridge) */
export async function extractContextEntities(text: string, limit = 12): Promise<string[]> {
  try {
    const tokens = Array.from(new Set(
      text.toLowerCase().split(/[^\p{L}\p{N}#+.-]+/u).filter(w => w.length >= 3 && w.length <= 40)
    )).slice(0, 80)
    if (tokens.length === 0) return []
    const rows = await readCypher<{ name: string }>(
      `MATCH (n)
       WHERE any(l IN labels(n) WHERE l IN ['Concept','Technology','Framework','Vulnerability','Principle','Domain','Document','Person','Tool','System','Algorithm','Language','Technique','Project'])
         AND toLower(n.name) IN $tokens
       RETURN DISTINCT n.name AS name
       LIMIT toInteger($limit)`,
      { tokens, limit }
    )
    return rows.map(r => r.name)
  } catch {
    return []
  }
}
