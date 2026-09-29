/**
 * TASK 28 (user directive 2026-10-27 phiên 4) — test 3 thay đổi:
 *   (1) CHÍNH SÁCH TỰ PHỤC VỤ HẠ TẦNG: agent được phép tự cài package + sửa
 *       schema + tự xây tool — INFRA SELF-SERVICE protocol inject vào system
 *       prompt của MỌI agent goal-loop; evaluator rule "record" thu hẹp.
 *   (2) GĐ3 READINESS: evaluator phán debtReadiness ready/blocked + lý do —
 *       nợ chưa thể xử lý chu kỳ kế → KHÔNG quay GĐ0 vô ích, ghi follow-up
 *       kèm điều kiện (parseEvalVerdict + goal protocol + debt directive).
 *   (3) Guard hạ tầng mở đúng hạng mục (unit-level qua protected-paths —
 *       chi tiết bộ đầy đủ trong tests/protected-paths.test.ts).
 *
 * Chạy: DATABASE_URL=file:/home/z/tmo-app/db/custom.db GOAL_LOOP_TEST_MODE=1 bun test tests/task28-infra-selfservice-readiness.test.ts
 */
import { describe, expect, test } from 'bun:test'
import {
  assembleGoalLoopSystemPrompt,
  buildPendingDebtBlock,
  EVALUATOR_SYSTEM_PROMPT,
  parseEvalVerdict,
} from '../src/lib/agent-goal-loop'

// ==================== (1) INFRA SELF-SERVICE PROTOCOL ====================

describe('Task 28 — Infra self-service protocol (chính sách 2026-10-27)', () => {
  test('S1. Protocol TỰ PHỤC VỤ inject vào system prompt MỌI agent goal-loop', () => {
    const prompt = assembleGoalLoopSystemPrompt({
      systemPrompt: 'BASE',
      hasDelegation: false,
      hasOrchestration: false,
      hasDispatch: false,
      hasCreate: false,
      preActBlock: '',
      agentName: 'TEST28',
    })
    expect(prompt).toContain('XỬ LÝ LỖI HẠ TẦNG & THIẾU TOOL/AGENT')
    // 5 bước quy trình đủ mặt
    expect(prompt).toContain('manage_packages')
    expect(prompt).toContain('prisma/schema.prisma')
    expect(prompt).toContain('create_custom_tool')
    expect(prompt).toContain('dispatch_agent')
    expect(prompt).toContain('escalate_problem')
    // tab Tools/Skills module Smolab + module Agents được nhắc (yêu cầu user)
    expect(prompt).toContain('Tools/Skills')
    expect(prompt).toContain('module Agents')
  })

  test('S2. Protocol có cả khi agent có delegation (không mất khi có protocol khác)', () => {
    const prompt = assembleGoalLoopSystemPrompt({
      systemPrompt: 'BASE',
      hasDelegation: true,
      hasOrchestration: true,
      hasDispatch: true,
      hasCreate: true,
      preActBlock: '',
      agentName: 'TEST28',
    })
    expect(prompt).toContain('XỬ LÝ LỖI HẠ TẦNG & THIẾU TOOL/AGENT')
    expect(prompt).toContain('create_agent')
  })

  test('S3. Evaluator rule "record" thu hẹp theo chính sách mới — cài package/sửa schema KHÔNG còn là lý do record', () => {
    // Rule record phải nói rõ 2 hạng mục ĐÃ ĐƯỢC PHÉP
    expect(EVALUATOR_SYSTEM_PROMPT).toContain('ĐÃ ĐƯỢC PHÉP')
    expect(EVALUATOR_SYSTEM_PROMPT).toContain('tự cài package')
    expect(EVALUATOR_SYSTEM_PROMPT).toContain('tự sửa DB schema')
    expect(EVALUATOR_SYSTEM_PROMPT).toContain('create_custom_tool')
    // Phần vẫn bảo vệ được nêu đích danh
    expect(EVALUATOR_SYSTEM_PROMPT).toContain('.env/keys')
  })
})

// ==================== (2) GĐ3 DEBT READINESS ====================

describe('Task 28 — GĐ3 debt readiness (xác định lại khả năng xử lý nợ chu kỳ kế)', () => {
  test('R1. parseEvalVerdict: debtReadiness ready + blocked + reason parse đúng', () => {
    const ready = parseEvalVerdict('{"complete": true, "confidence": 0.9, "verified": true, "missing": [], "rootCause": "", "nextPlan": [], "sideIssues": ["lint lỗi file X"], "debtDecision": "continue", "debtReadiness": "ready", "debtBlockedReason": ""}')
    expect(ready).not.toBeNull()
    expect(ready!.debtReadiness).toBe('ready')
    expect(ready!.debtBlockedReason).toBe('')

    const blocked = parseEvalVerdict('{"complete": true, "confidence": 0.9, "verified": true, "missing": [], "rootCause": "", "nextPlan": [], "sideIssues": ["chờ vendor fix API"], "debtDecision": "continue", "debtReadiness": "blocked", "debtBlockedReason": "chờ vendor bên thứ 3 phát hành bản vá API"}')
    expect(blocked).not.toBeNull()
    expect(blocked!.debtReadiness).toBe('blocked')
    expect(blocked!.debtBlockedReason).toContain('vendor')
  })

  test('R2. Fail-open: verdict thiếu debtReadiness → coi như ready (giữ hành vi cũ)', () => {
    const legacy = parseEvalVerdict('{"complete": true, "confidence": 0.9, "verified": true, "missing": [], "rootCause": "", "nextPlan": [], "sideIssues": ["lỗi A"], "debtDecision": "continue"}')
    expect(legacy).not.toBeNull()
    expect(legacy!.debtReadiness).toBe('ready')
    expect(legacy!.debtBlockedReason).toBe('')
  })

  test('R3. Giá trị lạ → fail-open ready (không chấp nhận giá trị không hợp lệ)', () => {
    const weird = parseEvalVerdict('{"complete": true, "confidence": 0.9, "verified": true, "missing": [], "rootCause": "", "nextPlan": [], "sideIssues": [], "debtDecision": "none", "debtReadiness": "maybe", "debtBlockedReason": "x"}')
    expect(weird).not.toBeNull()
    expect(weird!.debtReadiness).toBe('ready')
  })

  test('R4. Evaluator prompt có rule 14 DEBT READINESS + JSON output yêu cầu đủ field', () => {
    expect(EVALUATOR_SYSTEM_PROMPT).toContain('DEBT READINESS')
    expect(EVALUATOR_SYSTEM_PROMPT).toContain('debtReadiness')
    expect(EVALUATOR_SYSTEM_PROMPT).toContain('debtBlockedReason')
    // Kỷ luật: không phán ready khi nợ cần điều kiện chưa có
    expect(EVALUATOR_SYSTEM_PROMPT).toContain('KHÔNG phán "ready" khi nợ cần điều kiện chưa có')
  })

  test('R5. Goal protocol GĐ3 hướng dẫn đánh giá khả năng xử lý nợ chu kỳ kế', () => {
    const prompt = assembleGoalLoopSystemPrompt({
      systemPrompt: 'BASE',
      hasDelegation: false,
      hasOrchestration: false,
      hasDispatch: false,
      hasCreate: false,
      preActBlock: '',
      agentName: 'TEST28',
    })
    expect(prompt).toContain('XÁC ĐỊNH LẠI')
    expect(prompt).toContain('ĐÃ CÓ THỂ TIẾN HÀNH XỬ LÝ')
    expect(prompt).toContain('ĐIỀU KIỆN CẦN')
  })
})

// ==================== (3) NỢ FOLLOW-UP BLOCK — ĐƯỜNG TỰ PHỤC VỤ ====================

describe('Task 28 — buildPendingDebtBlock nhắc đường tự phục vụ trước khi kết luận ngoài quyền', () => {
  test('D1. Block nợ chứa hướng dẫn thử đường tự phục vụ (package/schema/tool/delegate/escalate)', async () => {
    const SESSION = `test-task28-${Date.now()}`
    const { db } = await import('../src/lib/db')
    await db.todo.create({
      data: {
        sessionId: SESSION,
        content: '🔁 Follow-up (nợ kỹ thuật từ run old-run-t28): Lỗi thiếu package lodash khi build script',
        status: 'pending',
        runId: 'old-run-t28',
      },
    })
    const block = await buildPendingDebtBlock(SESSION, 'cur-run-t28')
    expect(block).toContain('NỢ KỸ THUẬT CÒN TREO')
    expect(block).toContain('manage_packages')
    expect(block).toContain('create_custom_tool')
    expect(block).toContain('escalate_problem')
    expect(block).toContain('ĐIỀU KIỆN CẦN')
    // Dọn
    await db.todo.deleteMany({ where: { sessionId: SESSION } })
    // KHÔNG gọi db.$disconnect() ở đây — xem ghi chú giải thích trong
    // tests/task26-prompt-budget-debt.test.ts: db là singleton Prisma dùng
    // chung cho mọi test file trong cùng process bun test.
  })
})
