/**
 * EPISODE RECORDER — pipeline A.5 (tích hợp vào agent runtime)
 *
 * Sau mỗi task/run kết thúc (goal-loop gọi, fire-and-forget fail-open):
 *
 *   1. Tóm tắt: goal, các action chính, outcome, lỗi gặp
 *   2. Embed summary → Qdrant (collection theopus_episodes)
 *   3. Tìm top-3 episode tương tự (cosine > 0.8) → tạo [:SIMILAR_TO]
 *   4. Ghi Episode + Action + ErrorOccurrence nodes vào Neo4j (+ SQLite mirror)
 *   5. Nếu có lỗi ĐÃ resolve → sinh/cập nhật Lesson (consolidateLesson)
 *   6. Nếu lỗi thuộc pattern đã có Lesson → times_validated/times_failed
 *      (validateAppliedLessons — PRE-ACT đã áp lesson cho run này)
 *   7. Link Episode/Lesson sang KB semantic (INVOLVES/ABOUT)
 *
 * ErrorOccurrence sinh từ tool-evidence fail của goal-loop:
 *   - root_cause: classifyRootCause (B.3) trên raw message
 *   - resolved: có tool call THÀNH CÔNG sau lỗi đó (fix_summary = action
 *     thành công kế tiếp cùng tool — heuristic, không tốn LLM)
 *
 * Bước 2 lộ trình A6: bắt đầu chỉ với GHI (chưa cần đọc) — PRE-ACT đọc
 * ở preact.ts, bật riêng (bước 3).
 */

import { classifyRootCause } from './taxonomy'
import {
  writeEpisodeGraph,
  linkEpisodeToKB,
  linkEpisodeYieldedLessons,
  extractContextEntities,
} from './episodic-neo4j'
import {
  upsertEpisodeEmbedding,
  searchSimilarEpisodes,
} from './episode-store'
import {
  upsertEpisodeRecord,
} from './episodic-db'
import {
  consolidateLesson,
  validateAppliedLessons,
} from './lessons'
import {
  EPISODIC_THRESHOLDS,
  type ActionNode,
  type EpisodeNode,
  type EpisodeOutcome,
  type ErrorOccurrenceNode,
  type RecordEpisodeInput,
  type RecordEpisodeResult,
  type RootCauseCode,
} from './types'

// ==================== OUTCOME MAPPING ====================

/** Map stopReason goal-loop → EpisodeOutcome (A.2) */
export function mapOutcome(stopReason: string, toolFailures: number): EpisodeOutcome {
  switch (stopReason) {
    case 'complete': return 'SUCCESS'
    case 'cancelled': return 'ABANDONED'
    // ROUND-32 P3-a: run kết thúc bằng exception = FAILURE bất kể tool failures.
    // (Bản cũ `toolFailures > 0 ? 'FAILURE' : 'FAILURE'` là dead-code typo từ
    // commit gốc 4b46d20 — copy nhầm từ case 'max_cycles' bên dưới. Giữ NGUYÊN
    // semantics đã vận hành: cả 2 nhánh cũ đều trả 'FAILURE'.)
    case 'error': return 'FAILURE'
    case 'no_progress': return 'FAILURE'
    case 'max_cycles': return toolFailures > 0 ? 'FAILURE' : 'PARTIAL'
    case 'time_budget':
    case 'token_budget': return 'PARTIAL'
    // TASK 48 — needs_input: kết thúc CÓ MỤC ĐÍCH (trọng tài xác định phần còn
    // thiếu CHỈ user trả lời được — không phải lỗi hay dở dang vì agent bế tắc).
    // Map PARTIAL tường minh: goal chưa đạt (không SUCCESS), không có lỗi
    // (không FAILURE), không bị hủy (không ABANDONED). Tường minh thay vì để
    // rơi default để semantics rõ ràng cho các rule học bài học episodic.
    case 'needs_input': return 'PARTIAL'
    default: return 'PARTIAL'
  }
}

/** Importance khởi đầu (A.2) — lỗi là dữ liệu quý: FAILURE > SUCCESS */
function initialImportance(outcome: EpisodeOutcome, toolCalls: number, errors: number): number {
  let imp = 0.8
  if (outcome === 'FAILURE') imp = 0.85
  if (outcome === 'ABANDONED') imp = 0.4
  if (outcome === 'PARTIAL') imp = 0.7
  if (toolCalls >= 10) imp += 0.05   // episode dài — nhiều chi tiết
  if (errors >= 3) imp += 0.05       // nhiều lỗi — nhiều dữ liệu học
  return Math.min(1, imp)
}

/**
 * ROUND-32 P1-c — rút từ khóa ngữ cảnh từ text các tool thất bại (đơn giản,
 * deterministic) cho LessonAttribution.errorKeywords. Chỉ lấy từ dài ≥ 4 ký tự
 * (bỏ mạo từ/toán tử), cap số lượng — mục đích khớp token với trigger/appliesTo
 * của lesson, không phải NLU.
 */
function extractErrorKeywords(texts: string[], limit = 20): string[] {
  const seen = new Set<string>()
  for (const t of texts) {
    if (!t) continue
    for (const w of String(t).toLowerCase().split(/[^\p{L}\p{N}_]+/u)) {
      if (w.length >= 4 && !seen.has(w)) seen.add(w)
    }
  }
  return Array.from(seen).slice(0, limit)
}

// ==================== PIPELINE A.5 ====================

/**
 * Ghi 1 episode hoàn chỉnh từ goal-loop run. Mọi bước fail-open — trả
 * result kèm error string để caller log, KHÔNG throw (recorder không được
 * làm hỏng response của agent).
 */
export async function recordEpisodeFromRun(input: RecordEpisodeInput): Promise<RecordEpisodeResult> {
  const result: RecordEpisodeResult = {
    episodeId: '',
    lessonsCreated: 0, lessonsMerged: 0,
    lessonsValidated: 0, lessonsFailed: 0,
    similarEpisodesLinked: 0, errorsRecorded: 0,
  }
  try {
    // ── Bước 1: Tóm tắt run — actions + errors từ tool evidence ──
    const toolEvents = input.toolEvidence.slice(0, 60) // cap防爆 graph
    const actions: ActionNode[] = []
    const errors: ErrorOccurrenceNode[] = []
    const resolvedBy: Record<string, string> = {}
    let seq = 0

    for (const ev of toolEvents) {
      seq++
      const actionId = `act_${Date.now().toString(36)}_${seq.toString(36)}_${Math.random().toString(36).slice(2, 6)}`
      if (ev.success) {
        actions.push({
          id: actionId,
          sequence: seq,
          tool: ev.tool,
          inputSummary: ev.text.slice(0, 300),
          result: 'SUCCESS',
          errorRef: null,
        })
        // Heuristic resolved: action thành công SAU error cùng tool → error này
        // được fix bởi action này (đi ngược lên tìm error cùng tool chưa gán)
        for (let i = errors.length - 1; i >= 0; i--) {
          const err = errors[i]
          if (err.tool === ev.tool && !err.resolved && !resolvedBy[err.id]) {
            err.resolved = true
            err.fixSummary = `Tool "${ev.tool}" thành công sau lỗi: ${ev.text.slice(0, 160)}`
            resolvedBy[err.id] = actionId
            break
          }
        }
      } else {
        // Tool fail → classify root cause (B.3) + ErrorOccurrence node
        const rawMessage = ev.text.slice(0, 600) || `(tool ${ev.tool} fail — không có message)`
        const cls = classifyRootCause({ rawMessage, tool: ev.tool })
        const errorId = `err_${Date.now().toString(36)}_${seq.toString(36)}_${Math.random().toString(36).slice(2, 6)}`
        errors.push({
          id: errorId,
          rawMessage,
          category: cls.manifestation ?? 'unknown',
          rootCause: cls.rootCause,
          manifestation: cls.manifestation,
          tool: ev.tool,
          occurredAt: new Date(),
          resolved: false,
          fixSummary: null,
        })
        actions.push({
          id: actionId,
          sequence: seq,
          tool: ev.tool,
          inputSummary: ev.text.slice(0, 300),
          result: 'FAIL',
          errorRef: errorId,
        })
        result.errorsRecorded++
      }
    }
    // Nếu run thành công → mọi lỗi còn lại coi như đã resolve (agent vượt qua)
    if (input.outcome === 'SUCCESS') {
      for (const err of errors) {
        if (!err.resolved) {
          err.resolved = true
          err.fixSummary = err.fixSummary ?? 'Run kết thúc SUCCESS — lỗi đã được khắc phục trong tiến trình'
        }
      }
    }

    const contextSummary = buildContextSummary(input, errors)

    const episode: EpisodeNode = {
      id: `ep_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      title: input.goal.slice(0, 140) || '(task không tên)',
      goal: input.goal,
      contextSummary,
      startedAt: input.startedAt,
      endedAt: input.endedAt,
      outcome: input.outcome,
      confidence: Math.max(0, Math.min(1, input.confidence)),
      agent: input.agentName,
      sessionId: input.sessionId ?? null,
      importance: initialImportance(input.outcome, input.toolCalls, errors.length),
      accessCount: 0,
      lastAccessed: new Date(),
      embeddingId: null,
      cycles: input.cycles,
      tokensUsed: input.tokensUsed,
      toolCalls: input.toolCalls,
      toolFailures: errors.length,
      stopReason: input.stopReason,
    }
    result.episodeId = episode.id

    // ── Bước 2: Embed summary → Qdrant ──
    const embeddingId = await upsertEpisodeEmbedding({
      episodeId: episode.id,
      summaryText: `${episode.title}\n${contextSummary}\nOutcome: ${episode.outcome}\nLỗi chính: ${errors.slice(0, 3).map(e => e.rawMessage.slice(0, 120)).join(' | ')}`,
      payload: {
        title: episode.title,
        goal: episode.goal.slice(0, 500),
        outcome: episode.outcome,
        agent: episode.agent,
        session_id: episode.sessionId ?? '',
        importance: episode.importance,
        stop_reason: episode.stopReason ?? '',
        created_at: new Date().toISOString(),
      },
    })
    episode.embeddingId = embeddingId

    // ── Bước 3: Tìm top-3 episode tương tự → [:SIMILAR_TO] ──
    // mode='passage': summary↔summary — cùng input type, score đối xứng
    // point-to-point (query↔passage cross-type bị tụt ~5-8% dưới ngưỡng 0.8)
    const similar = await searchSimilarEpisodes({
      queryText: `${episode.title}\n${contextSummary}`,
      topK: 3,
      minScore: EPISODIC_THRESHOLDS.episodeSimilarity,
      mode: 'passage',
    }).catch(() => [])
    // Loại chính nó (upsert vừa ghi có thể match)
    const similarFiltered = similar.filter(s => s.episodeId !== episode.id)
    result.similarEpisodesLinked = similarFiltered.length

    // ── Bước 4: Ghi graph Neo4j (episode + actions + errors + rels) ──
    // FIX (TAUGHT edge): ghi graph TRƯỚC khi consolidate lesson — node
    // ErrorOccurrence phải tồn tại trước khi linkErrorTaughtLesson chạy
    // MATCH (không thì cạnh TAUGHT mất thầm lặng — 0 cạnh trong toàn bộ
    // graph cũ). YIELDED lesson ids nối RIÊNG sau bước 5 qua
    // linkEpisodeYieldedLessons (lesson chưa tồn tại ở thời điểm này).
    const graphOk = await writeEpisodeGraph({
      episode,
      actions,
      errors: errors.map(e => ({
        id: e.id, rawMessage: e.rawMessage, category: e.category,
        rootCause: e.rootCause, manifestation: e.manifestation ?? null,
        occurredAt: e.occurredAt, resolved: e.resolved, fixSummary: e.fixSummary ?? null,
      })),
      resolvedBy,
      yieldedLessonIds: [], // nối riêng sau khi consolidate (bước 5)
      similarTo: similarFiltered.map(s => ({ episodeId: s.episodeId, score: s.score })),
    })

    // ── Bước 5: Lỗi đã resolve → sinh/merge Lesson (TAUGHT giờ match node) ──
    const yieldedLessonIds: string[] = []
    for (const err of errors.slice(0, 5)) {
      if (!err.resolved || !err.fixSummary) continue
      const consolidated = await consolidateLesson({
        rootCause: err.rootCause as RootCauseCode,
        triggerCondition: buildTriggerCondition(err, input),
        fixSummary: err.fixSummary.slice(0, 200),
        appliesTo: [err.tool ?? 'general', ...extractAppliesTags(input.goal)],
        errorId: err.id,
        episodeId: episode.id,
      }).catch(() => null)
      if (consolidated?.lesson) {
        yieldedLessonIds.push(consolidated.lesson.id)
        if (consolidated.status === 'created') result.lessonsCreated++
        if (consolidated.status === 'merged') result.lessonsMerged++
      }
    }

    // (Episode)-[:YIELDED]->(Lesson) — sau khi lesson đã tồn tại
    if (yieldedLessonIds.length > 0) {
      await linkEpisodeYieldedLessons(episode.id, yieldedLessonIds).catch(() => 0)
    }

    // ── Bước 6: Validate lessons PRE-ACT đã áp dụng (EVALUATE nhịp 3) ──
    // ROUND-32 P1-c: attribution ngữ cảnh lỗi — FAILURE chỉ quy tội lesson khớp
    // dấu vết lỗi (tool thất bại / root cause / từ khóa message lỗi) thay vì
    // phạt dàn trải cả episode. SUCCESS giữ nguyên semantics cũ (validate tất cả).
    // ROUND-35 (C-4): outcome 3 trạng thái — ABANDONED (user cancel) và PARTIAL
    // (budget/needs_input) KHÔNG phải bằng chứng thắng/thua → NEUTRAL: không
    // phạt bài học nào (bản cũ ép vào nhánh phạt → cancel thường xuyên rút
    // cạn confidence của các lesson hay dùng nhất).
    const failedToolNames = Array.from(new Set(
      input.toolEvidence.filter(ev => !ev.success && ev.tool).map(ev => ev.tool)
    ))
    const errorRootCauses = Array.from(new Set(
      errors.map(e => String(e.rootCause ?? '')).filter(Boolean)
    ))
    const attribution = {
      failedTools: failedToolNames,
      errorRootCauses,
      errorKeywords: extractErrorKeywords(
        input.toolEvidence.filter(ev => !ev.success).map(ev => ev.text)
      ),
    }
    const lessonOutcome = input.outcome === 'SUCCESS'
      ? 'SUCCESS' as const
      : input.outcome === 'FAILURE'
        ? 'FAILURE' as const
        : 'NEUTRAL' as const
    const validation = await validateAppliedLessons(
      input.appliedLessonIds,
      lessonOutcome,
      attribution
    ).catch(() => null)
    if (validation) {
      result.lessonsValidated = validation.validated
      result.lessonsFailed = validation.failed
    }

    // SQLite mirror (fallback + dashboard)
    await upsertEpisodeRecord({
      episode,
      actionsJson: JSON.stringify(actions.slice(0, 40)),
      errorsJson: JSON.stringify(errors.map(e => ({
        id: e.id, rawMessage: e.rawMessage, category: e.category,
        rootCause: e.rootCause, resolved: e.resolved, fixSummary: e.fixSummary,
      }))),
      lessonsJson: JSON.stringify(yieldedLessonIds),
    }).catch(err => {
      console.error('[Episodic] mirror EpisodeRecord failed:', err instanceof Error ? err.message : String(err))
    })

    // ── Bước 7: Link sang KB semantic (INVOLVES / ABOUT) ──
    const kbLinked = await linkEpisodeToKB({
      episodeId: episode.id,
      text: `${input.goal} ${contextSummary}`,
      lessonIds: yieldedLessonIds,
    }).catch(() => 0)

    console.log(
      `[Episodic] Episode ${episode.id} ghi xong — outcome=${episode.outcome}, ${actions.length} actions, ${errors.length} errors (${errors.filter(e => e.resolved).length} resolved), ${result.lessonsCreated} lesson mới, ${result.lessonsMerged} merge, ${result.similarEpisodesLinked} SIMILAR_TO${graphOk ? '' : ' [Neo4j FAIL — mirror SQLite vẫn có]'}${kbLinked > 0 ? `, ${kbLinked} KB link` : ''}`
    )
    return result
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err)
    console.error('[Episodic] recordEpisodeFromRun failed:', result.error)
    return result
  }
}

// ==================== HELPERS ====================

/** Context summary (A.5 bước 1) — gọn cho embed + hiển thị */
function buildContextSummary(input: RecordEpisodeInput, errors: ErrorOccurrenceNode[]): string {
  const parts = [
    `Agent ${input.agentName} thực hiện task với ${input.cycles} chu kỳ, ${input.toolCalls} tool calls, ${input.tokensUsed} tokens.`,
    `Kết thúc vì: ${input.stopReason}. Outcome: ${input.outcome} (confidence ${(input.confidence * 100).toFixed(0)}%).`,
  ]
  const failedTools = input.toolEvidence.filter(e => !e.success).map(e => e.tool)
  if (failedTools.length > 0) {
    parts.push(`Tools gặp lỗi: ${Array.from(new Set(failedTools)).join(', ')}.`)
  }
  if (errors.length > 0) {
    parts.push(`Root causes: ${Array.from(new Set(errors.map(e => e.rootCause))).join(', ')}.`)
  }
  const okTools = input.toolEvidence.filter(e => e.success).map(e => e.tool)
  if (okTools.length > 0) {
    parts.push(`Tools dùng tốt: ${Array.from(new Set(okTools)).slice(0, 10).join(', ')}.`)
  }
  return parts.join(' ')
}

/** Trigger condition cho lesson — mô tả hoàn cảnh gặp lỗi */
function buildTriggerCondition(err: ErrorOccurrenceNode, input: RecordEpisodeInput): string {
  if (err.tool) return `dùng tool ${err.tool} trong task kiểu "${input.goal.slice(0, 80)}" và gặp lỗi ${err.category}`
  return `thao tác trong task kiểu "${input.goal.slice(0, 80)}" gặp lỗi ${err.category}`
}

/** Tags áp dụng từ goal text — từ kỹ thuật dài ≥ 4 ký tự */
function extractAppliesTags(goal: string): string[] {
  return goal.toLowerCase().split(/[^\p{L}\p{N}#+.-]+/u).filter(w => w.length >= 4 && w.length <= 24).slice(0, 5)
}
