/**
 * LESSONS SEARCH — r71 (BUG2-022, user directive "agents khai thác database
 * triệt để")
 * =====================================================
 * Trước r71: bài học episodic (LessonRecord — mirror Neo4j Lesson), episodes
 * (EpisodeRecord) và trí nhớ warm (AgentMemory + Qdrant) CHỈ được nạp tự động
 * đầu run (preact block — timeout 4s, có khi trống). Giữa run, khi agent gặp
 * vấn đề và muốn đối chiếu "lỗi/bài học tương tự đã gặp chưa" → KHÔNG có tool
 * nào tra cứu on-demand (context_recall chỉ là digest run cũ trong cùng
 * session; knowledge_search chỉ quét KB tài liệu). Bộ não DB có dữ liệu mà
 * không có đường truy vấn chủ động.
 *
 * Tool `lessons_search({query, agent?, limit?})` — tra 3 kho trong 1 call:
 *   1. LessonRecord   — bài học đã học (sort confidence × timesValidated)
 *   2. EpisodeRecord  — episode run quá khứ theo từ khoá (mới nhất trước)
 *   3. AgentMemory    — trí nhớ warm agent (importance desc; lọc theo agent
 *                       tùy chọn — mặc định quét MỌI agent để học chéo)
 *
 * Deterministic keyword search (Prisma contains — không phụ thuộc embedding
 * provider; nhất quán triết lý data-map r67 "0 LLM, 0 prompt"). Read-only,
 * idempotent, fail-open trả lỗi có cấu trúc chứ KHÔNG throw.
 */

import { db } from '@/lib/db'

export interface LessonsSearchArgs {
  query: string
  /** Lọc theo tên agent (vd "SENTINEL") — bỏ trống = quét mọi agent */
  agent?: string
  /** Số kết quả tối đa MỖI kho (default 5, max 15) */
  limit?: number
}

export interface LessonsSearchResult {
  success: boolean
  query: string
  agentFilter?: string
  lessons: Array<{
    id: string
    statement: string
    triggerCondition?: string | null
    confidence: number
    timesValidated: number
    timesFailed: number
    source?: string
    updatedAt: string
  }>
  episodes: Array<{
    id: string
    title: string
    outcome: string
    stopReason?: string | null
    toolFailures?: number | null
    agent: string
    createdAt: string
  }>
  memories: Array<{
    id: string
    agentName: string
    category: string
    content: string
    importance: number
    createdAt: string
  }>
  total: number
  hint: string
  error?: string
}

/** Strip wildcard LIKE (% _) khỏi từ khoá — tra cứu theo ý người gọi, không
 * cho phép pattern-match tự do. */
function sanitizeKeyword(raw: string): string {
  return raw.replace(/[%_\\]/g, ' ').replace(/\s+/g, ' ').trim()
}

export async function lessonsSearch(args: LessonsSearchArgs): Promise<LessonsSearchResult> {
  const query = sanitizeKeyword(String(args?.query ?? ''))
  const agentFilter = args?.agent ? sanitizeKeyword(String(args.agent)) : undefined
  const limit = Math.max(1, Math.min(15, Math.floor(Number(args?.limit) || 5)))

  const empty: LessonsSearchResult = {
    success: true,
    query,
    agentFilter,
    lessons: [],
    episodes: [],
    memories: [],
    total: 0,
    hint: '',
  }
  if (query.length < 2) {
    return { ...empty, hint: 'Query quá ngắn — truyền ít nhất 2 ký tự mô tả vấn đề/bài học cần tra (vd "429 rate limit", "prisma migrate", "sandbox reset").' }
  }

  try {
    // 1. LessonRecord — bài học đã học (confidence cao + validate nhiều trước)
    const lessons = await db.lessonRecord.findMany({
      where: {
        OR: [
          { statement: { contains: query } },
          { triggerCondition: { contains: query } },
          { appliesTo: { contains: query } },
        ],
      },
      orderBy: [{ confidence: 'desc' }, { timesValidated: 'desc' }, { updatedAt: 'desc' }],
      take: limit,
      select: {
        id: true, statement: true, triggerCondition: true, confidence: true,
        timesValidated: true, timesFailed: true, source: true, updatedAt: true,
      },
    }).catch(() => [])

    // 2. EpisodeRecord — episode quá khứ (mới nhất trước; lọc agent tùy chọn)
    const episodes = await db.episodeRecord.findMany({
      where: {
        AND: [
          {
            OR: [
              { title: { contains: query } },
              { goal: { contains: query } },
              { contextSummary: { contains: query } },
            ],
          },
          ...(agentFilter ? [{ agent: { contains: agentFilter } }] : []),
        ],
      },
      orderBy: [{ createdAt: 'desc' }],
      take: limit,
      select: {
        id: true, title: true, outcome: true, stopReason: true,
        toolFailures: true, agent: true, createdAt: true,
      },
    }).catch(() => [])

    // 3. AgentMemory — trí nhớ warm (importance desc; mặc định MỌI agent —
    // bài học chéo giữa agents là giá trị chính của kho này)
    const memories = await db.agentMemory.findMany({
      where: {
        isActive: true,
        OR: [{ content: { contains: query } }, { context: { contains: query } }],
        ...(agentFilter ? { agentName: { contains: agentFilter } } : {}),
      },
      orderBy: [{ importance: 'desc' }, { createdAt: 'desc' }],
      take: limit,
      select: {
        id: true, agentName: true, category: true, content: true,
        importance: true, createdAt: true,
      },
    }).catch(() => [])

    const total = lessons.length + episodes.length + memories.length
    return {
      ...empty,
      lessons: lessons.map(l => ({
        ...l,
        statement: l.statement.length > 400 ? `${l.statement.slice(0, 380)}…` : l.statement,
        updatedAt: l.updatedAt.toISOString(),
      })),
      episodes: episodes.map(e => ({ ...e, createdAt: e.createdAt.toISOString() })),
      memories: memories.map(m => ({
        ...m,
        content: m.content.length > 400 ? `${m.content.slice(0, 380)}…` : m.content,
        createdAt: m.createdAt.toISOString(),
      })),
      total,
      hint: total === 0
        ? `Không khớp kho nào cho "${query}"${agentFilter ? ` (agent: ${agentFilter})` : ''} — thử từ khoá khác (tên tool, thông điệp lỗi, tên module) hoặc bỏ lọc agent.`
        : `Lesson có confidence ≥0.7 tự áp dụng ở run sau (preact). Đối chiếu episode FAILURE để tránh lặp sai lầm cũ; memory của agent khác = bài học chéo.`,
    }
  } catch (err) {
    return {
      ...empty,
      success: false,
      error: `lessons_search lỗi: ${err instanceof Error ? err.message : String(err)}`,
      hint: 'Kho bài học tạm không truy vấn được (fail-open) — tiếp tục nhiệm vụ không phụ thuộc kết quả này.',
    }
  }
}
