/**
 * PRE-ACT RETRIEVAL (A6 · C.1 nhịp 1 — Bước 3 lộ trình: vòng lặp KHÉP KÍN)
 *
 * Chạy TRƯỚC khi agent hành động:
 *
 *   Nhận task → extract entities/context
 *   → Q3: có Lesson nào ABOUT các entities này không?
 *   → Qdrant: episode tương tự chưa? (task text → cosine search)
 *   → Insights từ episode tương tự: lỗi chưa resolve → cảnh báo;
 *     lesson YIELDED → áp dụng
 *   → Lesson confidence > 0.7 → ÁP DỤNG ngay, ghi vào plan (system prompt)
 *
 * Trả về:
 *   - promptBlock: block text hoàn chỉnh append vào system prompt
 *   - appliedLessonIds: lesson ids confidence ≥ 0.7 đã inject → goal-loop
 *     dùng để VALIDATE sau run (EVALUATE nhịp 3 — times_validated/failed)
 *
 * Fail-open tuyệt đối: Neo4j/Qdrant/embedding chết → trả block rỗng —
 * agent chạy bình thường không có ký ức (không bao giờ block response).
 * Timeout guard: goal-loop bọc 4s — PRE-ACT không được làm chậm cold-start.
 */

import {
  getLessonsForContext,
  extractContextEntities,
  getEpisodeInsights,
} from './episodic-neo4j'
import { searchSimilarEpisodes } from './episode-store'
import { findAllLessonRecords } from './episodic-db'
import { EPISODIC_THRESHOLDS, type PreActContext } from './types'

/**
 * Build PRE-ACT context cho 1 task sắp chạy.
 * @param params.agentName — agent sắp thực hiện (log)
 * @param params.task — userMessage/task text (embed để tìm episode tương tự)
 */
export async function buildPreActContext(params: {
  agentName: string
  task: string
}): Promise<PreActContext> {
  const empty: PreActContext = {
    promptBlock: '', lessons: [], similarErrors: [],
    unresolvedWarnings: [], appliedLessonIds: [],
  }
  try {
    const task = params.task?.trim() ?? ''
    if (!task) return empty

    // ── Extract context entities (Q3 input) — chạy song song với Qdrant ──
    // minScore 0.7 < ngưỡng SIMILAR_TO 0.8: PRE-ACT so user-task (query
    // embedding) với episode summaries (passage embedding) — cross input
    // type tụt ~5-8% so với point-to-point, 0.7 giữ đủ recall cảnh báo sớm
    const [contextEntities, similarEpisodes] = await Promise.all([
      extractContextEntities(task).catch(() => []),
      searchSimilarEpisodes({ queryText: task, topK: 3, minScore: 0.7 }).catch(() => []),
    ])

    // ── Q3: lessons theo context entities (Neo4j primary) ──
    let lessons = await getLessonsForContext({
      contextEntities,
      minConfidence: EPISODIC_THRESHOLDS.lessonNeedsReview,
      limit: 5,
    }).catch(() => [])

    // ── Insights từ episodes tương tự (lỗi chưa resolve + lessons YIELDED) ──
    const insights = await getEpisodeInsights(
      similarEpisodes.map(s => s.episodeId)
    ).catch(() => ({ unresolvedErrors: [], lessons: [] }))

    // Dedup lessons (Q3 + episode YIELDED có thể trùng)
    const seen = new Set<string>()
    const allLessons = [
      ...lessons,
      ...insights.lessons.map(l => ({
        id: l.id, statement: l.statement,
        triggerCondition: l.triggerCondition ?? '',
        confidence: l.confidence,
        timesValidated: l.timesValidated ?? 0,
      })),
    ].filter(l => {
      if (seen.has(l.id)) return false
      seen.add(l.id)
      return l.confidence >= EPISODIC_THRESHOLDS.lessonNeedsReview
    }).sort((a, b) => b.confidence * (b.timesValidated + 1) - a.confidence * (a.timesValidated + 1))
      .slice(0, 5)
    lessons = allLessons

    // ── Fallback Neo4j down: lessons từ SQLite mirror ──
    if (lessons.length === 0) {
      const mirror = await findAllLessonRecords(EPISODIC_THRESHOLDS.lessonNeedsReview, 5).catch(() => [])
      lessons = mirror.map(m => ({
        id: m.id, statement: m.statement,
        triggerCondition: m.triggerCondition ?? '',
        confidence: m.confidence,
        timesValidated: m.timesValidated,
      }))
    }

    // Không có gì → không inject (tiết kiệm token prompt)
    if (lessons.length === 0 && insights.unresolvedErrors.length === 0 && similarEpisodes.length === 0) {
      return empty
    }

    // ── Build prompt block ──
    const lines: string[] = []

    if (lessons.length > 0) {
      lines.push('📚 BÀI HỌC TỪ KINH NGHIỆM QUÁ KHỨ (Episodic Memory — lessons đã học):')
      for (const l of lessons) {
        const autoApply = l.confidence >= EPISODIC_THRESHOLDS.lessonAutoApply
        lines.push(
          `- ${l.statement}${l.triggerCondition ? ` (trigger: ${l.triggerCondition})` : ''} [confidence ${Math.round(l.confidence * 100)}%, validated ${l.timesValidated} lần${autoApply ? ' — ÁP DỤNG' : ''}]`
        )
      }
      lines.push('→ Áp dụng lesson liên quan NGAY trong kế hoạch; không lặp lại sai lầm cũ cùng pattern.')
    }

    if (insights.unresolvedErrors.length > 0) {
      lines.push('')
      lines.push('⚠️ CẢNH BÁO — task tương tự TỪNG GẶP LỖI CHƯA RESOLVE:')
      for (const e of insights.unresolvedErrors.slice(0, 3)) {
        lines.push(`- "${String(e.rawMessage).slice(0, 140)}" (root cause: ${e.rootCause})`)
      }
      lines.push('→ Cẩn trọng ngay từ đầu plan với các điểm từng fail này.')
    }

    if (similarEpisodes.length > 0) {
      lines.push('')
      lines.push(`🔗 ${similarEpisodes.length} episode quá khứ tương tự (cosine ≥ ${EPISODIC_THRESHOLDS.episodeSimilarity}):`)
      for (const s of similarEpisodes) {
        const p = s.payload
        lines.push(`- "${String(p.title ?? '').slice(0, 100)}" [${String(p.outcome ?? '?')}, agent ${String(p.agent ?? '?')}] (score ${(s.score * 100).toFixed(0)}%)`)
      }
    }

    const promptBlock = lines.length > 0
      ? `\n\n=== EPISODIC MEMORY — PRE-ACT RETRIEVAL ===\n${lines.join('\n')}\n=== HẾT EPISODIC MEMORY ===`
      : ''

    return {
      promptBlock,
      lessons: lessons.map(l => ({
        id: l.id, statement: l.statement,
        triggerCondition: l.triggerCondition,
        confidence: l.confidence,
      })),
      similarErrors: insights.unresolvedErrors.map(e => ({
        rawMessage: String(e.rawMessage),
        fixSummary: null,
        lessonStatement: null,
        lessonConfidence: null,
      })),
      unresolvedWarnings: insights.unresolvedErrors.map(e =>
        `${e.rootCause}: ${String(e.rawMessage).slice(0, 120)}`
      ),
      // Chỉ lesson tự tin (≥ 0.7) được tính "applied" → validate sau run
      appliedLessonIds: lessons
        .filter(l => l.confidence >= EPISODIC_THRESHOLDS.lessonAutoApply)
        .map(l => l.id),
    }
  } catch (err) {
    console.error('[Episodic] buildPreActContext failed:', err instanceof Error ? err.message : String(err))
    return empty
  }
}
