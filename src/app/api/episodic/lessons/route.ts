/**
 * EPISODIC LESSONS API — Task A6-API-UI
 *
 * GET   /api/episodic/lessons           — tất cả LessonRecord (mirror SQLite,
 *                                          top 100 theo confidence) + stats nhỏ
 * POST  /api/episodic/lessons           — user dạy bài học mới (USER_TAUGHT,
 *                                          confidence 0.8) → teachLesson()
 * PATCH /api/episodic/lessons           — đánh dấu lesson đã xử lý review
 *                                          {id, needsReview} → setLessonNeedsReview()
 *
 * Fail-open: mọi handler try/catch — lỗi trả {ok:false, error} kèm data rỗng,
 * KHÔNG bao giờ 500 crash. Validation error → 400 (client error).
 */

import { NextRequest, NextResponse } from 'next/server'
import {
  ROOT_CAUSES,
  findAllLessonRecords,
  countLessonRecords,
  setLessonNeedsReview,
  teachLesson,
} from '@/lib/episodic-memory'
import type { LessonNode, RootCauseCode } from '@/lib/episodic-memory'

export const dynamic = 'force-dynamic'

const GET_LIMIT = 100
const STATEMENT_MIN = 10
const STATEMENT_MAX = 500
const TRIGGER_MAX = 300

// ==================== helpers ====================

function parseAppliesTo(json: string | null): string[] {
  if (!json) return []
  try {
    const v = JSON.parse(json)
    return Array.isArray(v) ? v.map(String) : []
  } catch {
    return json.split(',').map(s => s.trim()).filter(Boolean)
  }
}

function isRootCause(v: unknown): v is RootCauseCode {
  return typeof v === 'string' && (ROOT_CAUSES as readonly string[]).includes(v)
}

/** Coerce appliesTo từ body (string[] | comma-separated string) → string[] */
function coerceAppliesTo(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String).map(s => s.trim()).filter(Boolean).slice(0, 8)
  if (typeof v === 'string' && v.trim()) {
    return v.split(',').map(s => s.trim()).filter(Boolean).slice(0, 8)
  }
  return []
}

async function readBody(request: NextRequest): Promise<Record<string, unknown>> {
  try {
    const body = await request.json()
    return typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

// ==================== GET — danh sách lessons ====================

export async function GET() {
  let lessons: Array<Record<string, unknown>> = []
  let error: string | null = null
  try {
    const rows = await findAllLessonRecords(0, GET_LIMIT)
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
  } catch (err) {
    error = err instanceof Error ? err.message : String(err)
    console.error('[Episodic/Lessons] GET error (fail-open):', err)
  }

  const needReview = lessons.filter(l => !!l.needsReview).length
  const confidences = lessons.map(l => Number(l.confidence) || 0)
  const avgConfidence = confidences.length > 0
    ? Math.round((confidences.reduce((s, c) => s + c, 0) / confidences.length) * 100) / 100
    : 0

  let total = lessons.length
  try {
    total = await countLessonRecords()
  } catch { /* fail-open — dùng lessons.length */ }

  return NextResponse.json({
    generatedAt: new Date().toISOString(),
    lessons,
    stats: { total, shown: lessons.length, needReview, avgConfidence },
    error,
  })
}

// ==================== POST — dạy bài học (USER_TAUGHT) ====================

export async function POST(request: NextRequest) {
  const body = await readBody(request)
  const statement = typeof body.statement === 'string' ? body.statement.trim() : ''
  const triggerCondition = typeof body.triggerCondition === 'string'
    ? body.triggerCondition.trim().slice(0, TRIGGER_MAX)
    : ''
  const rootCause = body.rootCause
  const appliesTo = coerceAppliesTo(body.appliesTo)

  // Validation — 400 (client error, không phải crash)
  if (statement.length < STATEMENT_MIN) {
    return NextResponse.json(
      { ok: false, lesson: null, error: `Statement quá ngắn — tối thiểu ${STATEMENT_MIN} ký tự (hiện ${statement.length})` },
      { status: 400 },
    )
  }
  if (statement.length > STATEMENT_MAX) {
    return NextResponse.json(
      { ok: false, lesson: null, error: `Statement quá dài — tối đa ${STATEMENT_MAX} ký tự (hiện ${statement.length})` },
      { status: 400 },
    )
  }
  if (rootCause !== undefined && rootCause !== null && !isRootCause(rootCause)) {
    return NextResponse.json(
      { ok: false, lesson: null, error: `rootCause không hợp lệ — phải thuộc ${ROOT_CAUSES.join(', ')}` },
      { status: 400 },
    )
  }

  try {
    const lesson: LessonNode = await teachLesson({
      statement,
      triggerCondition: triggerCondition || undefined,
      appliesTo,
      rootCause: isRootCause(rootCause) ? rootCause : undefined,
    })
    return NextResponse.json({ ok: true, lesson, error: null })
  } catch (err) {
    // Fail-open — không 500
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[Episodic/Lessons] POST teachLesson error (fail-open):', err)
    return NextResponse.json({ ok: false, lesson: null, error: msg })
  }
}

// ==================== PATCH — đánh dấu đã xử lý review ====================

export async function PATCH(request: NextRequest) {
  const body = await readBody(request)
  const id = typeof body.id === 'string' ? body.id.trim() : ''
  const needsReview = body.needsReview

  if (!id) {
    return NextResponse.json({ ok: false, error: 'Thiếu lesson id' }, { status: 400 })
  }
  if (typeof needsReview !== 'boolean') {
    return NextResponse.json({ ok: false, error: 'needsReview phải là boolean' }, { status: 400 })
  }

  try {
    await setLessonNeedsReview(id, needsReview)
    return NextResponse.json({ ok: true, updated: { id, needsReview }, error: null })
  } catch (err) {
    // Prisma P2025 (record không tồn tại) hoặc lỗi khác — fail-open, không 500
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[Episodic/Lessons] PATCH setLessonNeedsReview error (fail-open):', err)
    return NextResponse.json({
      ok: false,
      updated: null,
      error: `Không cập nhật được lesson "${id}": ${msg}`,
    })
  }
}
