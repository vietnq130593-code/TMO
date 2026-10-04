/**
 * LESSON ENGINE (A6 · C.1 nhịp 3 EVALUATE + nhịp 4 CONSOLIDATE)
 *
 * EVALUATE (nhịp 3) — so outcome với goal:
 *   - SUCCESS + đã áp dụng lesson → times_validated++ (lesson được củng cố)
 *   - FAILURE + đã áp dụng lesson → times_failed++ → confidence < 0.4 → đánh
 *     dấu lesson cần review
 *   - FAILURE mới → chạy taxonomy (B.3) → tạo ErrorOccurrence (recorder.ts)
 *
 * CONSOLIDATE (nhịp 4):
 *   - ErrorOccurrence mới VÀ đã resolve → sinh Lesson draft
 *     "Khi [trigger], nên [fix] vì [root_cause]"
 *   - Check đã có Lesson tương tự chưa? (design A6: embedding similarity
 *     > 0.85; bản này dùng Jaccard word-overlap ≥ 0.55 trên statement +
 *     cùng root_cause — không thêm collection Qdrant riêng cho lesson)
 *   - Có: merge, tăng confidence | Chưa: tạo Lesson mới, confidence 0.6
 *   - Cùng pattern lỗi ≥ 3 lần → escalate đề xuất cải tiến hệ thống
 *     (input cho Goal Generator)
 *
 * Lesson TỒN TẠI VĨNH VIỄN — không bao giờ decay (C.2).
 * Ghi cả Neo4j (:Lesson node) lẫn SQLite mirror (LessonRecord).
 */

import {
  buildLessonStatement,
  getPlaybook,
} from './taxonomy'
import {
  getAllLessonNodes,
  linkErrorTaughtLesson,
  upsertLessonNode,
} from './episodic-neo4j'
import {
  findLessonRecordById,
  findLessonsByStatementFragment,
  upsertLessonRecord,
} from './episodic-db'
import {
  EPISODIC_THRESHOLDS,
  type LessonNode,
  type RootCauseCode,
} from './types'

// ==================== CONSOLIDATE — SINH / MERGE LESSON ====================

/** Jaccard word overlap giữa 2 statement — thay embedding similarity (không thêm collection riêng cho lesson) */
function statementSimilarity(a: string, b: string): number {
  const norm = (s: string) => new Set(s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(w => w.length > 2))
  const wa = norm(a)
  const wb = norm(b)
  if (wa.size === 0 || wb.size === 0) return 0
  let inter = 0
  for (const w of wa) if (wb.has(w)) inter++
  return inter / (wa.size + wb.size - inter)
}

export interface ConsolidateLessonInput {
  rootCause: RootCauseCode
  /** "khi sắp sửa interface/type được nhiều file dùng" */
  triggerCondition: string
  /** "thêm type guard trước khi cast" */
  fixSummary: string
  /** Tags áp dụng — vd từ tool/file liên quan */
  appliesTo: string[]
  /** ErrorOccurrence id sinh ra lesson (→ [:TAUGHT]) */
  errorId?: string
  /** Episode id sinh ra lesson (→ [:YIELDED]) */
  episodeId?: string
}

export interface ConsolidateLessonResult {
  status: 'created' | 'merged' | 'skipped'
  lesson: LessonNode | null
}

/**
 * Sinh hoặc merge 1 lesson từ ErrorOccurrence đã resolve (nhịp 4).
 * Merge khi: cùng root_cause VÀ statement similarity ≥ 0.55 (word-overlap
 * approximation của "embedding similarity > 0.85" trong A6) → tăng
 * confidence + times_validated (pattern lặp lại là bằng chứng lesson đúng).
 */
export async function consolidateLesson(input: ConsolidateLessonInput): Promise<ConsolidateLessonResult> {
  try {
    const statement = buildLessonStatement({
      rootCause: input.rootCause,
      triggerCondition: input.triggerCondition,
      fixSummary: input.fixSummary,
    })

    // Check trùng: (a) SQLite fragment match, (b) Jaccard similarity
    // Kiểu khai báo hẹp {id, statement} để CẢ 2 nhánh (SQLite mirror và
    // Neo4j fallback) gán được — trước đây suy luận LessonRecordRow[]
    // khiến nhánh fallback Neo4j báo TS2322 (type_check fail = chặn CI).
    let candidates: Array<{ id: string; statement: string }> = await findLessonsByStatementFragment(
      input.triggerCondition.slice(0, 60), 10
    ).catch(() => [])
    // FIX 2026-09-28 (quan sát vận hành thật): mirror SQLite có thể TRỐNG
    // trong khi graph Neo4j đã có lessons (deploy mới giữ graph cũ — E2E:
    // Neo4j 44 lessons vs SQLite 0 rows). Dedup chỉ đọc mirror → mọi lỗi
    // resolve đều sinh lesson MỚI trùng lặp trong Neo4j (merge chết).
    // Fallback: mirror trống → đọc lessons từ Neo4j + BACKFILL mirror
    // (lần đầu gọi tự chữa drift — các lần sau SQLite tự phục vụ).
    if (candidates.length === 0) {
      const neoLessons = await getAllLessonNodes(100).catch(() => [])
      for (const nl of neoLessons) {
        if (!nl?.id || typeof nl.statement !== 'string') continue
        // Backfill mirror row cho lesson Neo4j đang thiếu (best-effort —
        // fail 1 row không chặn vòng: fail-open như toàn bộ episodic).
        await upsertLessonRecord({
          id: nl.id,
          statement: nl.statement,
          triggerCondition: nl.triggerCondition ?? null,
          rootCause: nl.rootCause ?? null,
          appliesTo: Array.isArray(nl.appliesTo) ? nl.appliesTo : [],
          source: (nl.source as LessonNode['source']) ?? 'SELF_DERIVED',
          confidence: typeof nl.confidence === 'number' ? nl.confidence : 0.6,
          timesApplied: nl.timesApplied ?? 0,
          timesValidated: nl.timesValidated ?? 0,
          timesFailed: nl.timesFailed ?? 0,
          needsReview: !!nl.needsReview,
          createdAt: new Date(),
        } as LessonNode).catch(() => { /* mirror heal fail-open */ })
      }
      // Chỉ tính candidates từ Neo4j KHỎE (có statement) — cùng shape
      // {id, statement} như SQLite path để Jaccard dùng chung.
      candidates = neoLessons
        .filter(nl => nl?.id && typeof nl.statement === 'string')
        .map(nl => ({ id: nl.id, statement: nl.statement }))
      if (candidates.length > 0) {
        console.log(`[Episodic] Lesson dedup: mirror SQLite trống → fallback ${candidates.length} lessons từ Neo4j (+backfill mirror)`)
      }
    }
    let bestMatch: { id: string; statement: string } | null = null
    let bestScore = 0
    for (const c of candidates) {
      const sim = statementSimilarity(statement, c.statement)
      if (sim > bestScore) { bestScore = sim; bestMatch = c }
    }

    if (bestMatch && bestScore >= 0.55) {
      // MERGE — pattern lặp lại → củng cố lesson cũ
      const existing = await findLessonRecordById(bestMatch.id)
      if (existing) {
        const lesson: LessonNode = {
          id: existing.id,
          statement: existing.statement,
          triggerCondition: existing.triggerCondition,
          appliesTo: safeParseApplies(existing.appliesTo),
          rootCause: (existing.rootCause as RootCauseCode) ?? input.rootCause,
          confidence: Math.min(0.99, existing.confidence + EPISODIC_THRESHOLDS.lessonValidateBoost),
          timesApplied: existing.timesApplied,
          timesValidated: existing.timesValidated + 1, // pattern xuất hiện lại = validate
          timesFailed: existing.timesFailed,
          createdAt: existing.createdAt,
          source: 'SELF_DERIVED',
          // FIX (merge gỡ cờ review oan): trước đây merge luôn reset
          // needsReview=false dù confidence sau boost vẫn có thể < 0.4.
          // Giờ chỉ giữ nguyên cờ theo ngưỡng lessonNeedsReview — lesson
          // đang chờ review mà được củng cố vẫn dưới ngưỡng thì vẫn cần review.
          needsReview: Math.min(0.99, existing.confidence + EPISODIC_THRESHOLDS.lessonValidateBoost) < EPISODIC_THRESHOLDS.lessonNeedsReview,
          embeddingId: existing.embeddingId,
        }
        await upsertLessonNode(lesson).catch(() => {})
        await upsertLessonRecord(lesson).catch(() => {})
        if (input.errorId) await linkErrorTaughtLesson(input.errorId, lesson.id).catch(() => {})
        console.log(`[Episodic] Lesson MERGE "${lesson.id}" (similarity ${(bestScore * 100).toFixed(0)}%, confidence → ${(lesson.confidence * 100).toFixed(0)}%)`)
        return { status: 'merged', lesson }
      }
    }

    // CREATE — lesson mới, confidence khởi đầu 0.6 (C.2)
    const lesson: LessonNode = {
      id: `lesson_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      statement,
      triggerCondition: input.triggerCondition,
      appliesTo: Array.from(new Set(input.appliesTo)).slice(0, 8),
      rootCause: input.rootCause,
      confidence: EPISODIC_THRESHOLDS.lessonInitialConfidence,
      timesApplied: 0,
      timesValidated: 0,
      timesFailed: 0,
      createdAt: new Date(),
      source: 'SELF_DERIVED',
      needsReview: false,
    }
    await upsertLessonNode(lesson).catch(() => {})
    await upsertLessonRecord(lesson).catch(() => {})
    if (input.errorId) await linkErrorTaughtLesson(input.errorId, lesson.id).catch(() => {})
    console.log(`[Episodic] Lesson CREATED "${lesson.id}": ${statement.slice(0, 120)}`)
    return { status: 'created', lesson }
  } catch (err) {
    console.error('[Episodic] consolidateLesson failed:', err instanceof Error ? err.message : String(err))
    return { status: 'skipped', lesson: null }
  }
}

// ==================== EVALUATE — VALIDATE LESSON THEO OUTCOME ====================

export interface ValidateLessonsResult {
  validated: number
  failed: number
  /** ROUND-32 P1-c: lesson applied trong run FAILURE nhưng KHÔNG khớp ngữ cảnh
   *  lỗi → không bị quy tội (chỉ đếm timesApplied, không đổi confidence). */
  neutral?: number
  flaggedForReview: string[]
}

/**
 * ROUND-32 P1-c — ngữ cảnh lỗi để gán trách nhiệm (credit assignment).
 * "applied" ở PRE-ACT chỉ nghĩa là "được inject vào prompt" (mọi lesson
 * confidence ≥ 0.7 được retrieve — preact.ts), KHÔNG phải "được dùng thật".
 * Bản cũ phạt/thưởng DÀN TRẢI cả episode: FAILURE → MỌI lesson applied −0.1
 * confidence (kể cả lesson liên quan cách xa lỗi), SUCCESS → mọi lesson +0.05
 * (kể cả lesson sai may mắn đi cùng) → confidence lệch dần theo độ nhiễu thay
 * vì theo chất lượng → auto-apply (≥0.7) quyết định sai.
 */
export interface LessonAttribution {
  /** Tool names thất bại trong run (từ toolEvidence của goal-loop) */
  failedTools?: string[]
  /** Root cause code các lỗi (taxonomy B.3) */
  errorRootCauses?: string[]
  /** Từ khóa ngữ cảnh lỗi (token từ message lỗi) */
  errorKeywords?: string[]
}

/**
 * Khớp ngữ cảnh lesson với dấu vết lỗi của run (P1-c Lớp 1 — deterministic).
 * Trả true khi: không có dữ liệu attribution (fallback hành vi cũ — không làm
 * hệ thống NGHIÊM hơn lúc thiếu dữ liệu), run không có dấu vết lỗi nào, hoặc
 * lesson không có ngữ cảnh để khớp. Chỉ trả false khi CÓ dấu vết lỗi rõ ràng
 * và ngữ cảnh lesson KHÔNG chạm dấu vết đó — asymmetric có chủ đích: kệ thừa
 * quy tội còn hơn quy oan (over-match ≈ hành vi cũ, under-match = thoát tội).
 */
function isLessonRelatedToFailure(
  rec: { triggerCondition: string | null; appliesTo: string | null },
  att?: LessonAttribution
): boolean {
  if (!att) return true
  const trace: string[] = []
  for (const t of att.failedTools ?? []) if (t) trace.push(String(t).toLowerCase())
  for (const r of att.errorRootCauses ?? []) if (r) trace.push(String(r).toLowerCase())
  for (const k of att.errorKeywords ?? []) if (k) trace.push(String(k).toLowerCase())
  if (trace.length === 0) return true // FAILURE không có dấu vết lỗi → giữ hành vi cũ

  const lessonText = [
    rec.triggerCondition ?? '',
    ...safeParseApplies(rec.appliesTo),
  ].join(' ').toLowerCase()
  if (!lessonText.trim()) return true // lesson không có ngữ cảnh để khớp → không loại oan

  const tokens = lessonText.split(/[^\p{L}\p{N}_]+/u).filter(t => t.length > 2)
  // Khớp 2 chiều substring: token 'query' khớp trace 'db_query'; trace
  // 'timeout' khớp token 'timeout'/'timeouts'.
  return tokens.some(tok => trace.some(tr => tr.includes(tok) || tok.includes(tr)))
}

/**
 * Nhịp 3 EVALUATE — cập nhật vòng đời lesson theo outcome run:
 *   SUCCESS + lesson đã áp dụng → times_validated++, confidence += 0.05
 *   FAILURE + lesson đã áp dụng → times_failed++, confidence −0.1
 *     → confidence < 0.4 → needsReview = true (user xem lại)
 *
 * ROUND-32 P1-c: FAILURE chỉ quy tội lesson KHỚP ngữ cảnh lỗi (attribution);
 * lesson không khớp → neutral (timesApplied++ nhưng KHÔNG đổi confidence,
 * KHÔNG times_failed — không phạt oan). SUCCESS vẫn validate tất cả (bằng
 * chứng yếu nhưng công bằng: lesson có mặt trong run thành công).
 *
 * ROUND-35 (C-4 — rà soát lượt 2): outcome 3 TRẠNG THÁI thay vì boolean —
 * bản cũ ép mọi non-SUCCESS vào nhánh phạt: run ABANDONED (user cancel —
 * mapOutcome) hoặc PARTIAL (budget/needs_input) mà KHÔNG có tool fail nào →
 * attribution rỗng → isLessonRelatedToFailure trả true (theo chủ đích
 * fail-open) → MỌI lesson auto-applied bị −0.1 + timesFailed++. Cancel thường
 * xuyên (hành vi user bình thường) rút cạn confidence của chính các lesson
 * hay được retrieve nhất → tụt dưới ngưỡng auto-apply 0.3/0.7 âm thầm.
 * NEUTRAL: run không phải bằng chứng thắng hay thua — mọi lesson chỉ
 * timesApplied++, KHÔNG đổi confidence/timesValidated/timesFailed.
 */
export type LessonValidationOutcome = 'SUCCESS' | 'FAILURE' | 'NEUTRAL'

export async function validateAppliedLessons(
  appliedLessonIds: string[],
  outcome: LessonValidationOutcome,
  attribution?: LessonAttribution
): Promise<ValidateLessonsResult> {
  const result: ValidateLessonsResult = { validated: 0, failed: 0, neutral: 0, flaggedForReview: [] }
  if (appliedLessonIds.length === 0) return result
  const outcomeSuccess = outcome === 'SUCCESS'
  const penalize = outcome === 'FAILURE'
  for (const id of appliedLessonIds.slice(0, 10)) {
    try {
      const rec = await findLessonRecordById(id)
      if (!rec) continue

      // P1-c: FAILURE → chỉ penalize lesson LIÊN QUAN ngữ cảnh lỗi
      // NEUTRAL → không phạt lesson nào (C-4)
      const related = penalize && isLessonRelatedToFailure(rec, attribution)

      const confidence = outcomeSuccess
        ? Math.min(0.99, rec.confidence + EPISODIC_THRESHOLDS.lessonValidateBoost)
        : related
          ? Math.max(0, rec.confidence - EPISODIC_THRESHOLDS.lessonValidatePenalty)
          : rec.confidence // neutral — không đổi (lesson không khớp lỗi HOẶC outcome NEUTRAL)
      const needsReview = confidence < EPISODIC_THRESHOLDS.lessonNeedsReview
      const lesson: LessonNode = {
        id: rec.id,
        statement: rec.statement,
        triggerCondition: rec.triggerCondition,
        appliesTo: safeParseApplies(rec.appliesTo),
        rootCause: (rec.rootCause as RootCauseCode) ?? null,
        confidence,
        timesApplied: rec.timesApplied + 1,
        timesValidated: rec.timesValidated + (outcomeSuccess ? 1 : 0),
        timesFailed: rec.timesFailed + (related ? 1 : 0),
        createdAt: rec.createdAt,
        source: (rec.source as LessonNode['source']) ?? 'SELF_DERIVED',
        needsReview,
        embeddingId: rec.embeddingId,
      }
      await upsertLessonNode(lesson).catch(() => {})
      await upsertLessonRecord(lesson).catch(() => {})
      if (outcomeSuccess) result.validated++
      else if (related) result.failed++
      else result.neutral = (result.neutral ?? 0) + 1
      if (needsReview && (outcomeSuccess || related)) result.flaggedForReview.push(id)
    } catch { /* fail-open từng lesson */ }
  }
  const neutralNote = (result.neutral ?? 0) > 0 ? `, ${(result.neutral ?? 0)} neutral (không quy tội — P1-c)` : ''
  if (result.validated + result.failed > 0 || (result.neutral ?? 0) > 0) {
    console.log(`[Episodic] Lesson validation (outcome=${outcome}): ${result.validated} validated, ${result.failed} failed${neutralNote}${result.flaggedForReview.length > 0 ? `, ${result.flaggedForReview.length} cần review` : ''}`)
  }
  return result
}

// ==================== USER-TAUGHT LESSON (source USER_TAUGHT) ====================

/** User dạy bài học trực tiếp từ UI — confidence khởi đầu 0.8 (tin hơn self-derived) */
export async function teachLesson(params: {
  statement: string
  triggerCondition?: string
  appliesTo?: string[]
  rootCause?: RootCauseCode
}): Promise<LessonNode> {
  const lesson: LessonNode = {
    id: `lesson_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    statement: params.statement.trim(),
    triggerCondition: params.triggerCondition?.trim() || null,
    appliesTo: params.appliesTo ?? [],
    rootCause: params.rootCause ?? null,
    confidence: 0.8,
    timesApplied: 0,
    timesValidated: 0,
    timesFailed: 0,
    createdAt: new Date(),
    source: 'USER_TAUGHT',
    needsReview: false,
  }
  await upsertLessonNode(lesson).catch(() => {})
  await upsertLessonRecord(lesson).catch(() => {})
  return lesson
}

// ==================== HELPERS ====================

function safeParseApplies(json: string | null): string[] {
  if (!json) return []
  try {
    const v = JSON.parse(json)
    return Array.isArray(v) ? v.map(String) : []
  } catch {
    return json.split(',').map(s => s.trim()).filter(Boolean)
  }
}

/** Format escalation proposal cho Goal Generator (C.1 nhịp 4 cuối) */
export function formatEscalationProposal(item: {
  rootCause: string
  occurrences: number
  resolved: number
  recentErrors: string[]
}): string {
  const playbook = getPlaybook((item.rootCause as RootCauseCode) ?? 'REASONING_ERROR')
  return [
    `Pattern lỗi lặp lại ${item.occurrences} lần (root cause: ${playbook.label}; ${item.resolved} đã resolve):`,
    ...item.recentErrors.slice(0, 3).map(e => `  - "${String(e).slice(0, 140)}"`),
    `Đề xuất cải tiến hệ thống theo phản ứng chuẩn: ${playbook.correctResponse}`,
    `Anti-pattern cần chặn: ${playbook.antiPattern}`,
  ].join('\n')
}
