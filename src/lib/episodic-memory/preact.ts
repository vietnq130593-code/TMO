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
import { findAllLessonRecords, findLessonsByStatementFragment } from './episodic-db'
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

/**
 * FIX 2026-09-14 #8 — MID-RUN SIMILAR-ERROR RECALL
 * ==============================================
 * Giữa các chu kỳ của goal-loop (user report: "4 chu kỳ nếu có vấn đề, thiếu
 * sót, lỗi thì có cơ chế khai thác dữ liệu kiểm tra các lỗi tương tự từng gặp
 * phải không") — PRE-ACT chỉ chạy 1 lần đầu run; khi chu kỳ N fail với
 * rootCause mới, agent KHÔNG được nhắc về các lỗi TƯƠNG TỪ đã gặp + cách đã
 * khắc phục.
 *
 * Hàm này build block directive cho chu kỳ kế:
 *   - Fingerprint lỗi = rootCause của trọng tài + tool fail gần nhất
 *   - Qdrant searchSimilarEpisodes (minScore hạ 0.65 — cross-type query)
 *   + SQLite LessonRecord fallback (fragment match) khi Qdrant trống
 *   → "LỖI TƯƠNG TỪ ĐÃ GẶP + cách đã khắc phục" — áp dụng ngay, không lặp vết xe đổ.
 *
 * Fail-open tuyệt đối: mọi lỗi → '' (không chặn continuation directive).
 */
export async function buildMidRunSimilarErrorBlock(params: {
  agentName: string
  rootCause: string
  failedTools: string[]
}): Promise<string> {
  try {
    const rootCause = (params.rootCause || '').trim()
    if (!rootCause && params.failedTools.length === 0) return ''

    const queryText = [
      rootCause ? `Lỗi: ${rootCause}` : '',
      params.failedTools.length > 0 ? `Tool fail: ${params.failedTools.join(' | ')}` : '',
    ].filter(Boolean).join('\n').slice(0, 1500)
    if (!queryText) return ''

    // Song song: Qdrant episodes + SQLite lessons (fragment match theo từ khóa
    // chính của rootCause — lỗi MỚI chưa có episode vẫn có thể khớp lesson cũ)
    const [hits, lessonHits] = await Promise.all([
      searchSimilarEpisodes({ queryText, topK: 3, minScore: 0.65 }).catch(() => []),
      (async () => {
        try {
          // Trích 1-2 từ khóa dài nhất có ý nghĩa từ rootCause
          const keywords = rootCause
            .replace(/[^\p{L}\p{N}\s]/gu, ' ')
            .split(/\s+/)
            .filter(w => w.length >= 5)
            .slice(0, 3)
          for (const kw of keywords) {
            const rows = await findLessonsByStatementFragment(kw, 3)
            if (rows.length > 0) return rows
          }
          return []
        } catch {
          return []
        }
      })(),
    ])

    const lines: string[] = []

    if (hits.length > 0) {
      const { getEpisodeInsights } = await import('./episodic-neo4j')
      const insights = await getEpisodeInsights(hits.map(h => h.episodeId)).catch(() => ({ unresolvedErrors: [], lessons: [] }))
      lines.push('🔁 LỖI TƯƠNG TỪ ĐÃ GẶP (Episodic Memory — giữa chừng run, chu kỳ trước fail):')
      for (const h of hits) {
        const p = h.payload
        const outcome = String(p.outcome ?? '?')
        lines.push(`- "${String(p.title ?? '').slice(0, 110)}" [${outcome}, agent ${String(p.agent ?? '?')}] — score ${(h.score * 100).toFixed(0)}%`)
      }
      const lessons = [...insights.lessons]
      if (lessons.length > 0) {
        lines.push('  Cách đã khắc phục (lessons từ các episode đó):')
        for (const l of lessons.slice(0, 3)) {
          lines.push(`  → ${l.statement.slice(0, 180)} [confidence ${Math.round((l.confidence ?? 0) * 100)}%]`)
        }
      }
      if (insights.unresolvedErrors.length > 0) {
        lines.push('  ⚠️ Cảnh báo — các lỗi tương tự từng CHƯA resolve:')
        for (const e of insights.unresolvedErrors.slice(0, 2)) {
          lines.push(`  → ${String(e.rawMessage).slice(0, 130)} (${e.rootCause})`)
        }
      }
    }

    if (lessonHits.length > 0) {
      if (lines.length === 0) lines.push('🔁 BÀI HỌC LIÊN QUAN LỖI HIỆN TẠI (LessonRecord — đã từng gặp pattern này):')
      for (const l of lessonHits.slice(0, 3)) {
        if (lines.some(li => li.includes(l.statement.slice(0, 60)))) continue // dedup với episode lessons
        lines.push(`- ${l.statement.slice(0, 180)}${l.triggerCondition ? ` (trigger: ${l.triggerCondition.slice(0, 80)})` : ''} [confidence ${Math.round(l.confidence * 100)}%, validated ${l.timesValidated ?? 0} lần]`)
      }
    }

    if (lines.length === 0) return ''
    return `\n\n=== LỖI TƯƠNG TỪ TRONG QUÁ KHỨ (khai thác dữ liệu episodic memory — áp dụng cách đã khắc phục, KHÔNG lặp vết xe đổ) ===\n${lines.join('\n')}\n→ Nếu lỗi hiện tại trùng pattern: dùng NGAY cách khắc phục đã được validate. Nếu là lỗi MỚI chưa từng gặp: xử lý theo kế hoạch của trọng tài — hệ thống sẽ ghi nhận làm bài học sau run.`
  } catch (err) {
    console.warn('[Episodic] buildMidRunSimilarErrorBlock failed (fail-open):', err instanceof Error ? err.message : String(err))
    return ''
  }
}
