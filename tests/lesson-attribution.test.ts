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

// Task 33 (§0b lượt 2 — 2026-10-13): TỪ CHỐI chạy khi DB chưa được cô lập.
// Bản cũ ép DATABASE_URL thẳng file:/home/z/tmo-app/db/custom.db (DB
// PRODUCTION của app) — mọi lượt `bun test` chạy từ cwd NGOÀI project
// (bunfig preload không nạp → TMO_TEST_DB_ISOLATED không set) ghi fixture
// thẳng DB thật. Bằng chứng đo thật: 3 dòng test-lesson-* trong
// LessonRecord production (13:28:34 sau restore) — auto-learn thật còn
// validate + phát learn.episode bẩn vào ledger (2026-10-13). Đường hợp lệ
// duy nhất: `bun test` từ project root — preload (tests/db-isolation-preload.ts)
// copy DB sang /tmp + set TMO_TEST_DB_ISOLATED=1. Ngoài đường đó → fail NGAY
// (doctrine fail-loud Task 54), tuyệt đối không ghi DB production.
if (process.env.TMO_TEST_DB_ISOLATED !== '1') {
  throw new Error(
    '[DB-ISOLATION] Test từ chối chạy trên DB production. Chạy `bun test` từ thư mục gốc tmo-app — bunfig.toml [test].preload sẽ cô lập DB (copy /tmp). Xem tests/db-isolation-preload.ts.',
  )
}

import { describe, expect, test, beforeEach } from 'bun:test'
import { db } from '../src/lib/db'
import { validateAppliedLessons } from '../src/lib/episodic-memory/lessons'

// ---------- fixtures ----------
const LESSON_DB = 'test-lesson-p1c-db'
const LESSON_LLM = 'test-lesson-p1c-llm'
// ROUND-39 — lesson conf thấp để test cờ needsReview khi PARTIAL penalty
const LESSON_LOW = 'test-lesson-r39-low'

async function seedLesson(
  id: string,
  statement: string,
  trigger: string,
  appliesTo: string[],
  confidence = 0.8,
): Promise<void> {
  const data = {
    statement,
    triggerCondition: trigger,
    appliesTo: JSON.stringify(appliesTo),
    rootCause: 'REASONING_ERROR',
    source: 'SELF_DERIVED',
    confidence,
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
  await db.lessonRecord.deleteMany({ where: { id: { in: [LESSON_DB, LESSON_LLM, LESSON_LOW] } } }).catch(() => {})
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
  await seedLesson(
    LESSON_LOW,
    'Khi gọi API ngoài, đặt retry với backoff',
    'khi gọi api ngoài',
    ['api', 'retry', 'backoff'],
    0.42,
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

// ============================================================================
// ROUND-39 — PARTIAL CHẤM ±CONFIDENCE CHO EXPLORATION LESSON (ε-greedy)
// ============================================================================
// Nợ vận hành round-38: "PARTIAL không chấm ±confidence exploration lesson" —
// thí nghiệm ε trúng run nửa vời (giao được nhưng vướng tool) bị cháy không
// tín hiệu. Giờ: exploration khớp attribution → −0.05 (nửa mức FAILURE, không
// tăng timesFailed); exploration không khớp → +0.02; lesson THƯỜNG + run
// PARTIAL budget + ABANDONED + attribution rỗng → vẫn NEUTRAL tuyệt đối (C-4).
describe('ROUND-39 — PARTIAL ±confidence cho exploration lesson', () => {
  test('PARTIAL + exploration KHỚP attribution → −0.05, KHÔNG tăng timesFailed; lesson thường kề cận vẫn neutral', async () => {
    const r = await validateAppliedLessons(
      [LESSON_DB, LESSON_LLM],
      'PARTIAL',
      {
        failedTools: ['db_query'],
        errorRootCauses: ['RESOURCE_ERROR'],
        errorKeywords: ['database', 'sqlite', 'schema'],
      },
      [LESSON_DB], // exploration = lesson DB (ε-greedy slot cuối)
    )

    // Lesson DB: exploration + khớp dấu vết lỗi DB → −0.05 (nửa mức −0.1)
    const dbLesson = await getLesson(LESSON_DB)
    expect(dbLesson.confidence).toBeCloseTo(0.75, 5) // 0.8 − 0.05
    expect(dbLesson.timesFailed).toBe(0) // KHÔNG quy tội hoàn toàn — bằng chứng nửa vời
    expect(dbLesson.timesValidated).toBe(3) // giữ nguyên
    expect(dbLesson.timesApplied).toBe(6)
    expect(r.partialPenalized).toBe(1)

    // Lesson LLM: KHÔNG exploration → neutral tuyệt đối (C-4)
    const llmLesson = await getLesson(LESSON_LLM)
    expect(llmLesson.confidence).toBeCloseTo(0.8, 5)
    expect(llmLesson.timesFailed).toBe(0)
    expect(r.neutral).toBe(1)
  })

  test('PARTIAL + exploration KHÔNG khớp attribution → +0.02 (thiên nhẹ dương), KHÔNG tăng timesValidated', async () => {
    const r = await validateAppliedLessons(
      [LESSON_DB, LESSON_LLM],
      'PARTIAL',
      {
        failedTools: ['db_query'],
        errorRootCauses: ['RESOURCE_ERROR'],
        errorKeywords: ['database', 'sqlite'],
      },
      [LESSON_LLM], // exploration = lesson LLM — không đụng dấu vết DB
    )

    const llmLesson = await getLesson(LESSON_LLM)
    expect(llmLesson.confidence).toBeCloseTo(0.82, 5) // 0.8 + 0.02
    expect(llmLesson.timesValidated).toBe(3) // PARTIAL không tính validated đủ mạnh
    expect(llmLesson.timesFailed).toBe(0)
    expect(r.partialBoosted).toBe(1)

    // Lesson DB thường (không exploration) → neutral
    const dbLesson = await getLesson(LESSON_DB)
    expect(dbLesson.confidence).toBeCloseTo(0.8, 5)
  })

  test('PARTIAL penalty đủ kéo lesson 0.42 xuống dưới ngưỡng 0.4 → flaggedForReview', async () => {
    const r = await validateAppliedLessons(
      [LESSON_LOW],
      'PARTIAL',
      {
        failedTools: ['api_client'],
        errorRootCauses: ['ENV_DRIFT'],
        errorKeywords: ['api', 'retry'],
      },
      [LESSON_LOW],
    )
    const low = await getLesson(LESSON_LOW)
    expect(low.confidence).toBeCloseTo(0.37, 5) // 0.42 − 0.05
    expect(low.needsReview).toBe(true)
    expect(r.flaggedForReview).toContain(LESSON_LOW)
  })

  test('PARTIAL + attribution RỖNG (không biết cái gì fail) → exploration cũng KHÔNG bị chấm — khác FAILURE over-match', async () => {
    const r = await validateAppliedLessons(
      [LESSON_DB],
      'PARTIAL',
      { failedTools: [], errorRootCauses: [], errorKeywords: [] },
      [LESSON_DB],
    )
    expect(r.neutral).toBe(1)
    expect(r.partialBoosted ?? 0).toBe(0)
    expect(r.partialPenalized ?? 0).toBe(0)
    const dbLesson = await getLesson(LESSON_DB)
    expect(dbLesson.confidence).toBeCloseTo(0.8, 5) // KHÔNG đổi
  })

  test('NEUTRAL outcome (run PARTIAL vì budget — recorder không map sang PARTIAL) → exploration cũng KHÔNG bị chấm (C-4)', async () => {
    const r = await validateAppliedLessons(
      [LESSON_DB],
      'NEUTRAL',
      {
        failedTools: ['db_query'],
        errorRootCauses: ['RESOURCE_ERROR'],
        errorKeywords: ['database'],
      },
      [LESSON_DB], // có exploration + CÓ dấu vết lỗi — nhưng outcome NEUTRAL
    )
    expect(r.neutral).toBe(1)
    expect(r.partialPenalized ?? 0).toBe(0)
    const dbLesson = await getLesson(LESSON_DB)
    expect(dbLesson.confidence).toBeCloseTo(0.8, 5) // budget-run không phải bằng chứng
  })
})
