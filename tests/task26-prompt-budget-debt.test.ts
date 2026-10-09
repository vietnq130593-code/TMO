/**
 * TASK 26 (user directive 2026-10-27) — test các thay đổi:
 *   (1) r73 GỠ NÚT "Prompt Auto": budgetPromptWith THEO TÁC VỤ đã bị XOÁ —
 *       khoá hợp đồng MỚI: budgetPrompt chỉ còn trần env hệ thống,
 *       applyPromptBudget giữ hành vi -1 = unlimited (lõi KHÔNG đổi)
 *   (2) CƠ CHẾ XỬ LÝ NỢ Todo follow-up TẠI THỜI ĐIỂM RÕ RÀNG: buildPendingDebtBlock
 *       nhặt Todo follow-up pending từ các run TRƯỚC trong cùng session, loại
 *       run hiện tại, mỗi mục kèm id để agent đóng đúng row.
 *
 * Chạy: DATABASE_URL=file:/home/z/tmo-app/db/custom.db GOAL_LOOP_TEST_MODE=1 bun test tests/task26-prompt-budget-debt.test.ts
 */
import { describe, expect, test, afterAll } from 'bun:test'
import {
  applyPromptBudget,
  budgetPrompt,
  type PromptBlock,
} from '../src/lib/prompt-budget'
import { assembleGoalLoopSystemPrompt, buildPendingDebtBlock } from '../src/lib/agent-goal-loop'

// ==================== (1) TRẦN PROMPT THEO TÁC VỤ ====================

function bigBlocks(totalChars: number): PromptBlock[] {
  return [
    { name: 'base', content: 'x'.repeat(Math.floor(totalChars * 0.7)), priority: 10 },
    { name: 'prot', content: 'y'.repeat(Math.floor(totalChars * 0.3)), priority: 100 },
  ]
}

describe('Task 26 — budget prompt (r73: chỉ còn trần env hệ thống)', () => {
  test('A1. applyPromptBudget -1 → KHÔNG cắt dù tổng rất lớn', () => {
    const blocks = bigBlocks(200_000)
    const res = applyPromptBudget(blocks, -1, 'test')
    expect(res.truncatedBlocks.length).toBe(0)
    expect(res.totalChars).toBe(blocks[0].content.length + blocks[1].content.length)
  })

  test('A2. r73 — budgetPromptWith ĐÃ BỊ XOÁ (không export nữa)', async () => {
    // Khoá hợp đồng gỡ nút: module không còn export budgetPromptWith — dùng
    // dynamic import để test tồn tại export mà không làm type-check hỏng.
    const mod: Record<string, unknown> = await import('../src/lib/prompt-budget')
    expect(mod.budgetPromptWith).toBeUndefined()
    expect(typeof mod.budgetPrompt).toBe('function')
  })

  test('A5. assembleGoalLoopSystemPrompt — base lớn vẫn qua budget hệ thống (toolSchemas luôn giữ)', () => {
    const bigBase = 'B'.repeat(200_000)
    const prompt = assembleGoalLoopSystemPrompt({
      systemPrompt: bigBase,
      hasDelegation: true,
      hasOrchestration: true,
      hasDispatch: true,
      hasCreate: true,
      preActBlock: '',
      toolSchemasBlock: 'TOOLSCHEMAS-CANARY',
      agentName: 'TEST26',
    })
    // toolSchemas (priority 100) luôn hiện diện dù base 200k bị budget-cut
    expect(prompt).toContain('TOOLSCHEMAS-CANARY')
  })

  test('A6. assembleGoalLoopSystemPrompt KHÔNG truyền → mặc định env cắt base (hành vi cũ)', () => {
    const bigBase = 'B'.repeat(200_000)
    const prompt = assembleGoalLoopSystemPrompt({
      systemPrompt: bigBase,
      hasDelegation: false,
      hasOrchestration: false,
      hasDispatch: false,
      hasCreate: false,
      preActBlock: '',
      toolSchemasBlock: 'TOOLSCHEMAS-CANARY',
      agentName: 'TEST26',
    })
    // budget mặc định (72000 trên .env máy này) phải cắt block base priority thấp
    expect(prompt).toContain('budget-cut')
    expect(prompt.length).toBeLessThan(100_000)
  })
})

// ==================== (2) NỢ Todo follow-up — THỜI ĐIỂM XỬ LÝ ĐẦU RUN MỚI ====================

const TEST_SESSION = `test-task26-${Date.now()}`

describe('Task 26 — buildPendingDebtBlock (thời điểm xử lý nợ = đầu run mới)', () => {
  test('B1. Chỉ nhặt Todo follow-up PENDING từ run KHÁC — kèm id để đóng đúng row', async () => {
    const { db } = await import('../src/lib/db')
    // Seed: 1 follow-up pending từ run cũ + 1 follow-up completed (đã xong) +
    // 1 follow-up pending của CHÍNH run hiện tại + 1 todo thường pending
    await db.todo.create({ data: { sessionId: TEST_SESSION, content: '🔁 Follow-up (nợ kỹ thuật từ run old-run-111): Lỗi lint file X chưa sửa', status: 'pending', runId: 'old-run-111' } })
    const completedDebt = await db.todo.create({ data: { sessionId: TEST_SESSION, content: '🔁 Follow-up (nợ kỹ thuật từ run old-run-222): Lỗi đã xử lý', status: 'completed', runId: 'old-run-222' } })
    void completedDebt
    await db.todo.create({ data: { sessionId: TEST_SESSION, content: '🔁 Follow-up (nợ kỹ thuật từ run cur-run-999): Nợ của chính run hiện tại', status: 'pending', runId: 'cur-run-999' } })
    await db.todo.create({ data: { sessionId: TEST_SESSION, content: 'Việc thường của run cũ (không phải nợ)', status: 'pending', runId: 'old-run-333' } })

    const block = await buildPendingDebtBlock(TEST_SESSION, 'cur-run-999')
    // Chỉ nợ pending từ run KHÁC xuất hiện
    expect(block).toContain('NỢ KỸ THUẬT CÒN TREO')
    expect(block).toContain('Lỗi lint file X chưa sửa')
    expect(block).toContain('[id ') // mục kèm id để todo_write đóng đúng row
    expect(block).toContain('ƯU TIÊN')
    // KHÔNG chứa: nợ completed, nợ của run hiện tại, todo thường
    expect(block).not.toContain('Lỗi đã xử lý')
    expect(block).not.toContain('Nợ của chính run hiện tại')
    expect(block).not.toContain('Việc thường của run cũ')
  })

  test('B2. Session không có nợ → block rỗng (không inject)', async () => {
    const block = await buildPendingDebtBlock(`${TEST_SESSION}-clean`, 'any-run')
    expect(block).toBe('')
  })

  test('B3. sessionId null → rỗng (fail-open)', async () => {
    const block = await buildPendingDebtBlock(null, 'any-run')
    expect(block).toBe('')
  })

  afterAll(async () => {
    // Dọn sạch dữ liệu test
    try {
      const { db } = await import('../src/lib/db')
      await db.todo.deleteMany({ where: { sessionId: { startsWith: `test-task26-` } } })
      console.log('🧹 Đã dọn dữ liệu test task26')
    } catch { /* best-effort */ }
    // KHÔNG gọi db.$disconnect() ở đây: db là singleton Prisma DÙNG CHUNG cho MỌI
    // test file trong cùng process bun test (src/lib/db.ts gắn vào
    // globalThis.prisma khi NODE_ENV khác production). Ngắt connection ở file
    // này khiến các file chạy SAU đó nhận lỗi "Engine is not yet connected"
    // → quality gate FAIL ngẫu nhiên (flake 2/10 lần chạy).
  })
})
