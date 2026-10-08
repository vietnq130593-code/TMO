// ============================================================================
// TEST SUITE — r66 (AUDIT LƯỢT 8): phục hồi tool-call — V1a salvage JSON đứt
// + V1b dạng "tên tool làm tag mở" (<todo_write">… — bằng chứng mission #18
// chu kỳ 2 L37: markup dồn vào thought, 0 execute, trọng tài CHƯA ĐẠT 1%).
// ============================================================================

import { describe, test, expect } from 'bun:test'
import {
  extractToolCallsWithDiagnostics,
  parseToolCallsFromOutput,
  detectBrokenToolCallHint,
  salvageTruncatedJsonArgs,
  salvageNativeToolArgs,
} from '../src/lib/tool-calls'

describe('r66 (V1b) — parser dạng TÊN TOOL LÀM TAG MỞ', () => {
  test('bằng chứng L37: <todo_write"> + XML con (mangled quote) → THỰC THI được', () => {
    const raw = `<todo_write"><sessionId>agent_1791447938659_4x5wxb</sessionId><agentRole>TL</agentRole><todos><item><id>cmuz9vnnb000mllo2o224eknd</id><status>in_progress</status><priority>high</priority><content>Ưu tiên xử lý nợ kỹ thuật parse_error</content></item><item><id>t2</id><status>pending</status><content>Kiểm kê route có thật</content></item></todos>`
    const { calls } = extractToolCallsWithDiagnostics(raw)
    expect(calls.length).toBe(1)
    expect(calls[0].name).toBe('todo_write')
    expect(calls[0].args.sessionId).toBe('agent_1791447938659_4x5wxb')
    expect(calls[0].args.agentRole).toBe('TL')
    const todos = calls[0].args.todos as Array<Record<string, unknown>>
    expect(Array.isArray(todos)).toBe(true)
    expect(todos.length).toBe(2)
    expect(todos[0].status).toBe('in_progress')
  })

  test('dạng CHUẨN không quote: <file_read><path>…</path></file_read> → call', () => {
    const { calls } = extractToolCallsWithDiagnostics('<file_read><path>src/lib/agent-goal-loop.ts</path></file_read>')
    expect(calls.length).toBe(1)
    expect(calls[0].name).toBe('file_read')
    expect(calls[0].args.path).toBe('src/lib/agent-goal-loop.ts')
  })

  test('JSON object ngay sau tag: <grep>{"pattern":"x","path":"src"}</grep> → call', () => {
    const { calls } = extractToolCallsWithDiagnostics('<grep>{"pattern": "TODO", "path": "src"}</grep>')
    expect(calls.length).toBe(1)
    expect(calls[0].name).toBe('grep')
    expect(calls[0].args.pattern).toBe('TODO')
  })

  test('tên NGOÀI whitelist → KHÔNG execute (chống hallucinate)', () => {
    const { calls } = extractToolCallsWithDiagnostics('<khong_co_tool_nay"><x>1</x></khong_co_tool_nay">')
    expect(calls.length).toBe(0)
  })

  test('tag mở + args XML CỤT giữa chừng → 0 call + DETECTOR bắt được (không im lặng)', () => {
    const raw = `<todo_write"><sessionId>default</sessionId><todos><item><id>sec-01</id><content>Kiểm kê bề mặt tấn công`
    const { calls } = extractToolCallsWithDiagnostics(raw)
    expect(calls.length).toBe(0)
    const hint = detectBrokenToolCallHint(raw)
    expect(hint).not.toBeNull()
    expect(hint).toContain('todo_write') // feedback kèm skeleton của ĐÚNG tool định gọi
  })

  test('prose sạch KHÔNG chứa tag tool → detector im lặng (không nhiễu)', () => {
    expect(detectBrokenToolCallHint('Tôi sẽ phân tích kiến trúc hệ thống và báo cáo sau.')).toBeNull()
  })
})

describe('r66 (V1a) — salvage JSON args bị cắt cụt giữa chừng', () => {
  test('salvageTruncatedJsonArgs: JSON đứt giữa item cuối → giữ items hoàn chỉnh', () => {
    const salvaged = salvageTruncatedJsonArgs('{"todos": [{"content": "việc A", "status": "completed"}, {"content": "việc B')
    expect(salvaged).not.toBeNull()
    const todos = salvaged!.todos as Array<Record<string, unknown>>
    expect(todos.length).toBe(1)
    expect(todos[0].content).toBe('việc A')
  })

  test('salvageTruncatedJsonArgs: đứt giữa VALUE của key cuối → giữ key đầu', () => {
    const salvaged = salvageTruncatedJsonArgs('{"pattern": "TODO", "path": "src/li')
    expect(salvaged).not.toBeNull()
    expect(salvaged!.pattern).toBe('TODO')
    expect(salvaged!.path).toBeUndefined() // string dở bị bỏ
  })

  test('salvageTruncatedJsonArgs: chỉ thiếu ngoặc đóng → vá được nguyên vẹn', () => {
    const salvaged = salvageTruncatedJsonArgs('{"a": 1, "b": [1, 2, 3')
    expect(salvaged).toEqual({ a: 1, b: [1, 2, 3] })
  })

  test('salvageTruncatedJsonArgs: chuỗi rác → null (fail-closed)', () => {
    expect(salvageTruncatedJsonArgs('không phải json')).toBeNull()
    expect(salvageTruncatedJsonArgs('')).toBeNull()
  })

  test('pattern-1 + tool AN TOÀN (todo_write) + JSON đứt → salvage call (tiết kiệm round-trip)', () => {
    const raw = 'tool_call: todo_write({"todos": [{"content": "khảo sát route", "status": "completed"}, {"content": "phân tích auth'
    const { calls, parseFailures } = extractToolCallsWithDiagnostics(raw)
    expect(calls.length).toBe(1)
    expect(calls[0].name).toBe('todo_write')
    expect(parseFailures).toBe(0)
    const todos = calls[0].args.todos as Array<Record<string, unknown>>
    expect(todos.length).toBe(1)
  })

  test('pattern-1 + tool NGUY HIỂM (file_write) + JSON đứt → KHÔNG salvage (đếm failure + nudge)', () => {
    const raw = 'tool_call: file_write({"path": "src/x.ts", "content": "abc def'
    const { calls, parseFailures } = extractToolCallsWithDiagnostics(raw)
    expect(calls.length).toBe(0)
    // 2 = pattern-1 + pattern-2 cùng vị trí cùng đếm (hành vi 21-d cũ — cả hai
    // regex match cùng chỗ, mỗi match đếm 1 failure)
    expect(parseFailures).toBe(2)
  })

  test('salvageNativeToolArgs gate: todo_write → vá được; file_write/shell → null', () => {
    // item đầu hoàn chỉnh về cú pháp (quote đóng) → salvage đóng ngoặc được
    expect(salvageNativeToolArgs('todo_write', '{"todos": [{"content": "x"')).not.toBeNull()
    expect(salvageNativeToolArgs('file_write', '{"path": "x", "content": "abc')).toBeNull()
    expect(salvageNativeToolArgs('shell', '{"command": "rm')).toBeNull()
    // string HỞ ở item đầu → salvage hết sạch thành rỗng → null (AN TOÀN —
    // todo_write với todos=[] vô nghĩa, tốt hơn là nudge phát lại)
    expect(salvageNativeToolArgs('todo_write', '{"todos": [{"content": "x')).toBeNull()
  })
})

describe('r66 — hồi quy: các format cũ KHÔNG vỡ', () => {
  test('pattern-1 chuẩn + pattern-2 + invoke + tool_name vẫn parse', () => {
    expect(parseToolCallsFromOutput('tool_call: file_read({"path": "a.ts"})').length).toBe(1)
    expect(parseToolCallsFromOutput('file_read({"path": "a.ts"})').length).toBe(1)
    expect(parseToolCallsFromOutput('<invoke name="file_read">{"path": "a.ts"}</invoke>').length).toBe(1)
    expect(parseToolCallsFromOutput('<tool_name>file_read</tool_name><parameters>{"path": "a.ts"}</parameters>').length).toBe(1)
  })

  test('prose thuần → 0 call, 0 failure (giữ hành vi cũ)', () => {
    const { calls, parseFailures } = extractToolCallsWithDiagnostics('Báo cáo: đã hoàn thành khảo sát. Không cần tool.')
    expect(calls.length).toBe(0)
    expect(parseFailures).toBe(0)
  })

  test('skip-range: tag-mở nằm TRONG args JSON của tool_call khác → không nhúng nhầm', () => {
    // file_write ghi file có chứa ví dụ <file_read>...</file_read> trong content
    const raw = 'tool_call: file_write({"path": "docs/x.md", "content": "ví dụ: <file_read><path>a.ts</path></file_read> kết thúc"})'
    const { calls } = extractToolCallsWithDiagnostics(raw)
    expect(calls.length).toBe(1)
    expect(calls[0].name).toBe('file_write') // KHÔNG sinh thêm call file_read nhúng
  })
})
