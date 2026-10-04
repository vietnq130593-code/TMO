// ============================================================================
// TEST SUITE — ROUND-32 P1-c: LESSON CREDIT ASSIGNMENT (attribution theo ngữ cảnh lỗi)
// ============================================================================
//
// Bản cũ validateAppliedLessons phạt/thưởng DÀN TRẢI cả episode: FAILURE → MỌI
// lesson applied bị −0.1 confidence (kể cả lesson liên quan cách xa lỗi). P1-c
// chỉ quy tội lesson KHỚP dấu vết lỗi (failedTools/errorRootCauses/errorKeywords);
// lesson không khớp → neutral: timesApplied++ nhưng KHÔNG đổi confidence.
//
// File này khoá hành vi attribution lại bằng bằng chứng máy.
//
// Chạy: cd /home/z/tmo-app && bun test tests/lesson-attribution.test.ts
// ============================================================================

// Ép DB đúng của tmo-app — chống shell DATABASE_URL nhiễm path my-project.
// KHI test cô lập (tests/db-isolation-preload.ts) thì PHẢI GIỮ NGUYÊN.
if (process.env.TMO_TEST_DB_ISOLATED !== '1') {
  process.env.DATABASE_URL = 'file:/home/z/tmo-app/db/custom.db'
}

import { describe, expect, test, beforeEach } from 'bun:test'
import { db } from '../src/lib/db'
import { validateAppliedLessons } from '../src/lib/episodic-memory/lessons'

// ---------- fixtures ----------
const LESSON_DB = 'test-lesson-p1c-db'
const LESSON_LLM = 'test-lesson-p1c-llm'

async function seedLesson(
  id: string,
  statement: string,
  trigger: string,
  appliesTo: string[]
): Promise<void> {
  const data = {
    statement,
    triggerCondition: trigger,
    appliesTo: JSON.stringify(appliesTo),
    rootCause: 'REASONING_ERROR',
    source: 'SELF_DERIVED',
    confidence: 0.8,
    timesApplied: 5,
    timesValidated: 3,
    timesFailed: 0,
    needsReview: false,
  }
  await db.lessonRecord.upsert({
    where: { id },
    create: { id, ...data },
    update: data,
  })
}

async function resetFixture(): Promise<void> {
  await db.lessonRecord.deleteMany({ where: { id: { in: [LESSON_DB, LESSON_LLM] } } }).catch(() => {})
  await seedLesson(
    LESSON_DB,
    'Khi sửa schema database, chạy db:push trước khi restart app',
    'khi sửa schema database của prisma',
    ['db_query', 'database', 'schema']
  )
  await seedLesson(
    LESSON_LLM,
    'Khi viết prompt dài cho LLM, tách thành các mục đánh số',
    'khi viết prompt dài cho llm',
    ['llm', 'prompt', 'writing']
  )
}

async function getLesson(id: string) {
  return db.lessonRecord.findUniqueOrThrow({ where: { id } })
}

beforeEach(async () => {
  await resetFixture()
})

describe('P1-c — lesson credit assignment', () => {
  test('FAILURE + ngữ cảnh lỗi DB → lesson DB bị quy tội (−0.1), lesson LLM neutral (KHÔNG đổi)', async () => {
    const r = await validateAppliedLessons([LESSON_DB, LESSON_LLM], 'FAILURE', {
      failedTools: ['db_query'],
      errorRootCauses: ['RESOURCE_ERROR'],
      errorKeywords: ['database', 'sqlite', 'schema'],
    })

    expect(r.failed).toBe(1)
    expect(r.neutral).toBe(1)

    const dbLesson = await getLesson(LESSON_DB)
    const llmLesson = await getLesson(LESSON_LLM)

    // Lesson DB khớp (appliesTo chứa db_query/database/schema) → bị penalty
    expect(dbLesson.confidence).toBeCloseTo(0.7, 5) // 0.8 − 0.1
    expect(dbLesson.timesFailed).toBe(1)
    expect(dbLesson.timesApplied).toBe(6)

    // Lesson LLM KHÔNG khớp dấu vết lỗi DB → neutral: confidence giữ nguyên
    expect(llmLesson.confidence).toBeCloseTo(0.8, 5)
    expect(llmLesson.timesFailed).toBe(0)
    expect(llmLesson.timesApplied).toBe(6) // lần áp dụng vẫn được đếm (thật)
  })

  test('FAILURE + ngữ cảnh lỗi LLM → vai trò đảo ngược: lesson LLM bị quy tội, lesson DB neutral', async () => {
    const r = await validateAppliedLessons([LESSON_DB, LESSON_LLM], 'FAILURE', {
      failedTools: ['call_llm'],
      errorRootCauses: ['LLM_PARSE_ERROR'],
      errorKeywords: ['prompt', 'parse', 'json'],
    })

    expect(r.failed).toBe(1)
    expect(r.neutral).toBe(1)

    const dbLesson = await getLesson(LESSON_DB)
    const llmLesson = await getLesson(LESSON_LLM)
    expect(dbLesson.confidence).toBeCloseTo(0.8, 5) // neutral — không phạt oan
    expect(llmLesson.confidence).toBeCloseTo(0.7, 5) // khớp prompt/llm → −0.1
  })

  test('SUCCESS → validate TẤT CẢ (giữ nguyên semantics cũ — P1-c không đổi nhánh này)', async () => {
    const r = await validateAppliedLessons([LESSON_DB, LESSON_LLM], 'SUCCESS', {
      failedTools: [],
      errorRootCauses: [],
      errorKeywords: [],
    })
    expect(r.validated).toBe(2)

    const dbLesson = await getLesson(LESSON_DB)
    const llmLesson = await getLesson(LESSON_LLM)
    expect(dbLesson.confidence).toBeCloseTo(0.85, 5) // 0.8 + 0.05
    expect(llmLesson.confidence).toBeCloseTo(0.85, 5)
    expect(dbLesson.timesValidated).toBe(4)
  })

  test('KHÔNG có attribution → fallback hành vi cũ: phạt tất cả (không làm hệ thống nghiêm hơn lúc thiếu dữ liệu)', async () => {
    const r = await validateAppliedLessons([LESSON_DB, LESSON_LLM], 'FAILURE')
    expect(r.failed).toBe(2)
    expect(r.neutral ?? 0).toBe(0)

    const dbLesson = await getLesson(LESSON_DB)
    expect(dbLesson.confidence).toBeCloseTo(0.7, 5)
  })

  test('FAILURE nhưng KHÔNG có dấu vết lỗi nào → vẫn giữ hành vi cũ (phạt tất cả)', async () => {
    const r = await validateAppliedLessons([LESSON_DB], 'FAILURE', {
      failedTools: [],
      errorRootCauses: [],
      errorKeywords: [],
    })
    expect(r.failed).toBe(1)
    const dbLesson = await getLesson(LESSON_DB)
    expect(dbLesson.confidence).toBeCloseTo(0.7, 5)
  })

  // ROUND-35 (C-4): run ABANDONED/PARTIAL không còn bị ép vào nhánh phạt —
  // bản cũ boolean ép mọi non-SUCCESS → FAILURE: user cancel run không lỗi
  // nào cũng rút confidence của mọi lesson auto-applied (−0.1/lesson/cancel).
  test('NEUTRAL (run ABANDONED/PARTIAL) → KHÔNG phạt lesson nào: confidence/timesFailed giữ nguyên, chỉ timesApplied++', async () => {
    const r = await validateAppliedLessons([LESSON_DB, LESSON_LLM], 'NEUTRAL', {
      failedTools: [],
      errorRootCauses: [],
      errorKeywords: [],
    })
    expect(r.validated).toBe(0)
    expect(r.failed).toBe(0)
    expect(r.neutral).toBe(2)
    expect(r.flaggedForReview.length).toBe(0)

    const dbLesson = await getLesson(LESSON_DB)
    const llmLesson = await getLesson(LESSON_LLM)
    expect(dbLesson.confidence).toBeCloseTo(0.8, 5) // KHÔNG đổi
    expect(llmLesson.confidence).toBeCloseTo(0.8, 5) // KHÔNG đổi
    expect(dbLesson.timesFailed).toBe(0)
    expect(dbLesson.timesValidated).toBe(3) // KHÔNG tăng
    expect(dbLesson.timesApplied).toBe(6) // lần áp dụng vẫn được đếm (thật)

    // NEUTRAL kể cả khi CÓ dấu vết lỗi (cancel giữa chừng lúc tool đang fail —
    // lỗi chưa kịp chứng minh lesson sai; phạt lúc này vẫn là quy oan)
    const r2 = await validateAppliedLessons([LESSON_DB], 'NEUTRAL', {
      failedTools: ['db_query'],
      errorRootCauses: ['RESOURCE_ERROR'],
      errorKeywords: ['database', 'sqlite'],
    })
    expect(r2.failed).toBe(0)
    expect(r2.neutral).toBe(1)
    const dbLesson2 = await getLesson(LESSON_DB)
    expect(dbLesson2.confidence).toBeCloseTo(0.8, 5) // vẫn KHÔNG phạt
    expect(dbLesson2.timesApplied).toBe(7)
  })
})
