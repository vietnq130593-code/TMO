// ============================================================================
// TEST SUITE — r68 (GIAO THỨC QUAN SÁT mission cmuznvkl1000nll50th6b136k):
// mọi test dưới đây bắt từ bug.md — bằng chứng trích nguyên văn từ
// agent-runs/run_1791471503465_1.jsonl + sub_1791471783200_2.jsonl +
// sub_1791472598062_3.jsonl + checkpoint GoalLoopJob (xem bug.md mục tương ứng).
// ============================================================================

import { describe, test, expect } from 'bun:test'
import {
  extractToolCallsWithDiagnostics,
  detectBrokenToolCallHint,
  maskToolCallText,
} from '../src/lib/tool-calls'
import {
  buildDelegationOutcomeThought,
  vietnameseTextRatio,
} from '../src/lib/agent-goal-loop'
import { buildCallIndexBlock } from '../src/lib/delegation-evaluator'
import { buildDataMapBlock, DATA_REGIONS } from '../src/lib/data-map'
import { applyPromptBudget } from '../src/lib/prompt-budget'

// ---------------------------------------------------------------------------
// FIX-1 (BUG-017) — MỤC LỤC TOOL CALL cho trọng tài delegation: 2/2 lần phán
// âm vì evidence tier 12k cắt mất call ở ĐẦU run ("không có tool call
// file_read cho route.ts" — sai sự thật máy, evt4-5 sub_1791472598062_3).
// ---------------------------------------------------------------------------
describe('r68 (FIX-1/BUG-017) — buildCallIndexBlock: mục lục đầy đủ không cắt', () => {
  test('entry chuẩn "tool(args) → ✓ preview" → 1 dòng đánh số, KHÔNG kèm preview', () => {
    const idx = buildCallIndexBlock([
      'file_read({"path":"src/app/api/opencode/execute/route.ts"}) → ✓ 1 // ====',
      'todo_write({"todos":[]}) → ✗ lỗi schema',
    ])
    expect(idx).toContain('1. file_read({"path":"src/app/api/opencode/execute/route.ts"}) → ✓')
    expect(idx).toContain('2. todo_write({"todos":[]}) → ✗')
    expect(idx).not.toContain('// ====') // preview bị bỏ — chỉ còn tool+args+trạng thái
  })

  test('rỗng → nhãn minh bạch (evaluator không nhầm "không chạy tool")', () => {
    expect(buildCallIndexBlock([])).toBe('(KHÔNG có tool call nào)')
  })

  test('>150 call → đủ 150 dòng đầu + dòng đếm phần dư', () => {
    const many = Array.from({ length: 160 }, (_, i) => `shell({"n":${i}}) → ✓ ok`)
    const idx = buildCallIndexBlock(many)
    expect((idx.match(/^\d+\./gm) || []).length).toBe(150)
    expect(idx).toContain('+10 call khác')
  })

  test('dòng dài bị cắt ngưỡng 170 chars (chống phình prompt evaluator)', () => {
    const long = `file_read({"path":"${'x'.repeat(300)}"}) → ✓ ${'y'.repeat(200)}`
    const lines = buildCallIndexBlock([long]).split('\n')
    expect(lines[0].length).toBeLessThanOrEqual(200)
  })
})

// ---------------------------------------------------------------------------
// FIX-8 (BUG-013) — nhãn kết quả phân công: "HOÀN THÀNH" (delivery) cạnh
// verdict CHƯA ĐẠT gây đọc nhầm (main evt57) → tách bạch.
// ---------------------------------------------------------------------------
describe('r68 (FIX-8/BUG-013) — nhãn TRẢ VỀ ĐẦY ĐỦ tách verdict', () => {
  const mk = (evaluation: unknown) =>
    buildDelegationOutcomeThought(2, { name: 'delegate_task', args: { agent: 'SENTINEL', task: 'Khảo sát độc lập P0-1' } }, { success: true, result: { agent: 'SENTINEL', iterations: 31, toolCalls: 49, tokensUsed: 1859401, endedBy: 'concluded', evaluation } })

  test('delivery OK + verdict CHƯA ĐẠT → nhãn tách bạch cả 2 tín hiệu', () => {
    const t = mk({ pass: false, confidence: 0.28 })
    expect(t).toBeTruthy()
    expect(t!).toContain('TRẢ VỀ ĐẦY ĐỦ (trọng tài CHƯA ĐẠT)')
    expect(t!).not.toMatch(/HOÀN THÀNH "(?!.*trọng tài)/)
    expect(t!).toContain('trọng tài độc lập: CHƯA ĐẠT')
  })

  test('delivery OK + verdict ĐẠT → giữ nhãn HOÀN THÀNH như cũ', () => {
    const t = mk({ pass: true, confidence: 0.91 })
    expect(t!).toContain('HOÀN THÀNH')
  })

  test('delivery fail → CHƯA ĐẠT như cũ (hồi quy)', () => {
    const t = buildDelegationOutcomeThought(2, { name: 'delegate_task', args: { agent: 'X', task: 't' } }, { success: false, result: { agent: 'X', endedBy: 'error', error: 'timeout' } })
    expect(t!).toContain('CHƯA ĐẠT')
  })
})

// ---------------------------------------------------------------------------
// FIX-3a (BUG-015) — data-map fallback: directive mơ hồ 82 ký tự của user
// ("Tiếp tục triển khai…") từng trả RỖNG (repro length 0 trên mission thật).
// ---------------------------------------------------------------------------
describe('r68 (FIX-3a/BUG-015) — buildDataMapBlock fallback 0-match', () => {
  test('directive mơ hồ thật của mission → KHÔNG rỗng, liệt kê sơ lược registry', () => {
    const block = buildDataMapBlock('Tiếp tục triển khai các đề xuất khắc phục và các phần việc chưa hoàn thành cho tôi')
    expect(block.length).toBeGreaterThan(200)
    expect(block).toContain('KHÔNG khớp vùng chuyên biệt')
    expect(block).toContain(`toàn bộ ${DATA_REGIONS.length} vùng`)
    // mỗi vùng 1 dòng — không phình (cap 1600 mặc định trừ 400 nhãn)
    expect(block.length).toBeLessThan(2200)
  })

  test('query cụ thể vẫn định tuyến như cũ (hồi quy r67)', () => {
    const block = buildDataMapBlock('tìm kiếm tài liệu kiến trúc trong knowledge base')
    expect(block).not.toContain('KHÔNG khớp vùng chuyên biệt')
  })
})

// ---------------------------------------------------------------------------
// FIX-4 (BUG-016) — budget-cut KHÔNG BAO GIỜ giữ 0: block identity 36,411
// chars từng bị stub về `[budget-cut 0/36411 chars]` (checkpoint thật).
// ---------------------------------------------------------------------------
describe('r68 (FIX-4/BUG-016) — sàn giữ tối thiểu 1500 chars khi budget ép cắt sâu', () => {
  test('nhánh threshold: buộc cắt sâu → giữ ≥1500 (không về 0)', () => {
    const blocks = [
      { name: 'base', content: 'IDENTITY '.repeat(2223), priority: 10 }, // ~20k
      { name: 'goalProtocol', content: 'P '.repeat(19500), priority: 100 }, // ~39k
    ]
    const res = applyPromptBudget(blocks, 40000, 'test:min-keep')
    const base = res.blocks.find(b => b.name === 'base')!
    expect(base.truncated).toBe(true)
    expect(base.content.length).toBeGreaterThanOrEqual(1500)
    expect(base.content).toContain('IDENTITY')
  })

  test('nhánh stub (tier p10 nhiều block, cap gần 0) → MỖI block vẫn giữ ≥1500', () => {
    const blocks = [
      { name: 'base', content: 'A'.repeat(20000), priority: 10 },
      { name: 'roster', content: 'B'.repeat(20000), priority: 10 },
      { name: 'protos', content: 'C'.repeat(39930), priority: 100 },
    ]
    const res = applyPromptBudget(blocks, 40000, 'test:stub-floor')
    for (const b of res.blocks.filter(x => x.name !== 'protos')) {
      // nội dung giữ ≥ 1500 hoặc nguyên vẹn (nếu không cần cắt)
      expect(b.content.replace(/…\[budget-cut [^\]]*\]/g, '').length).toBeGreaterThanOrEqual(1500)
    }
  })

  test('tổng ≤ budget → KHÔNG đụng block nào (hồi quy)', () => {
    const res = applyPromptBudget([{ name: 'a', content: 'x'.repeat(100), priority: 0 }], 50000)
    expect(res.truncatedBlocks.length).toBe(0)
    expect(res.prompt).toBe('x'.repeat(100))
  })
})

// ---------------------------------------------------------------------------
// FIX-5 (BUG-003) — maskToolCallText: tool-call méo KHÔNG còn nằm nguyên văn
// trong kênh suy nghĩ (evt5/9/23/49 mission thật — cụm 2 user chỉ đạo).
// ---------------------------------------------------------------------------
describe('r68 (FIX-5/BUG-003) — maskToolCallText 3 họ dạng đã quan sát', () => {
  test('native body trần kèm rác tiền tố (TỠI_CALL>/tt>tout — evt5/evt9)', () => {
    const out = maskToolCallText('TỠI_CALL> {"name":"todo_write","arguments":{"sessionId":"default","agentRole":"TL","todos":[{"id":"cmuz9vnng000mllo2erg6jgxg","status":"in_progress"}]}}')
    expect(out).toContain('🔧 todo_write(…)')
    expect(out).not.toContain('"sessionId":"default"')
  })

  test('pattern-2 biến thể `_call: todo_write({json})` (evt23)', () => {
    const out = maskToolCallText('_call: todo_write({"sessionId":"default","agentRole":"TL","todos":[]})')
    expect(out).toContain('🔧 todo_write(…)')
    expect(out).not.toContain('"todos":[]')
  })

  test('tag-direct mangled-quote `todo_write">{json}` (evt49)', () => {
    const out = maskToolCallText('Đã đọc xong route; việc kế tiếp là đối chiếu helper.\ntodo_write">{"sessionId":"agent_1791447938659_4x5wxb","todos":[{"id":"cmuzo09wh003ell507j6rg426","status":"in_progress"}]}')
    expect(out).toContain('🔧 todo_write(…)')
    expect(out).toContain('Đã đọc xong route') // phần suy nghĩ thật giữ nguyên
  })

  test('tag-direct XML-con `todo_write"><sessionId>…</todos>`', () => {
    const out = maskToolCallText('todo_write"><sessionId>agent_x</sessionId><agentRole>TL</agentRole><todos><item><id>a1</id></item></todos>')
    expect(out).toContain('🔧 todo_write(…)')
    expect(out).not.toContain('<sessionId>agent_x</sessionId>')
  })

  test('văn xuôi KHÔNG bị mask (chống false-positive — prose thật của mission)', () => {
    const prose = 'Tôi sẽ gọi file_read(ở trên) để đọc tiếp phần chưa xong của helper allowlist, sau đó đối chiếu diff bằng bằng chứng máy, không đoán mò.'
    expect(maskToolCallText(prose)).toBe(prose)
  })

  test('hợp lệ ack ngắn + JSON không whitelist tên → giữ nguyên', () => {
    const s = 'OK {"name":"không_phải_tool","arguments":{}}'
    expect(maskToolCallText(s)).toBe(s)
  })
})

// ---------------------------------------------------------------------------
// FIX-7a (BUG-001) — repair R7: `{</name> "todo_write", "arguments": {…}}`
// từng 0 call + detector im lặng (evt3-4) → giờ parse được.
// ---------------------------------------------------------------------------
describe('r68 (FIX-7a/BUG-001) — repair R7 native-body nhiễm tag </name>', () => {
  test('bằng chứng evt3: br>{</name> "todo_write"… → 1 call đầy đủ args', () => {
    const raw = 'MỤC TIÊU: tiếp tục triển khai và kiểm chứng các phần bảo mật P0/P1/P2 còn dở.\nbr>{</name> "todo_write", "arguments": {"sessionId":"default","agentRole":"TL","todos":[{"id":"cmuz9vnng000mllo2erg6jgxg","status":"in_progress","priority":"high"},{"id":"cmuz9w3ge0013lo2jr762p51","status":"in_progress"}]}}'
    const { calls, parseFailures } = extractToolCallsWithDiagnostics(raw)
    expect(calls.length).toBe(1)
    expect(calls[0].name).toBe('todo_write')
    expect(Array.isArray(calls[0].args.todos)).toBe(true)
    expect((calls[0].args.todos as unknown[]).length).toBe(2)
    expect(parseFailures).toBe(0)
  })

  test('tên ngoài whitelist → KHÔNG repair (chống hallucinate)', () => {
    const raw = 'văn bản {</name> "tool_lạ", "arguments": {"x":1}}'
    const { calls } = extractToolCallsWithDiagnostics(raw)
    expect(calls.filter(c => c.name === 'tool_lạ').length).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// FIX-7b (BUG-023) — họ pseudo-XML `functions.<tool><parameter
// name="parameters">`: dạng sạch repair được; dạng cụt → detector KHÔNG im
// lặng (checkpoint assistant 4/6 từng mất trắng git_diff).
// ---------------------------------------------------------------------------
describe('r68 (FIX-7b/BUG-023) — pseudo-XML function-call', () => {
  test('dạng sạch: functions.git_diff<parameter name="parameters">{json} → 1 call', () => {
    const raw = 'truncate parameter name="recipient_name">functions.git_diff<parameter name="parameters">{"ref":"HEAD"}'
    const { calls } = extractToolCallsWithDiagnostics(raw)
    expect(calls.length).toBe(1)
    expect(calls[0].name).toBe('git_diff')
    expect(calls[0].args.ref).toBe('HEAD')
  })

  test('dạng cụt giữa chừng → MALFORMED hint KHÔNG null (không còn im lặng)', () => {
    const raw = 'x truncate parameter name="recipient_name">functions.git_diffparameter name="parameters">{"t'
    const { calls } = extractToolCallsWithDiagnostics(raw)
    expect(calls.length).toBe(0)
    expect(detectBrokenToolCallHint(raw)).not.toBeNull()
  })

  test('hồi quy: prose sạch không trigger hint giả', () => {
    expect(detectBrokenToolCallHint('Tôi sẽ đọc tiếp file helper và đối chiếu diff bằng bằng chứng máy.')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// FIX-6 (BUG-004/005) — vietnameseTextRatio dùng chung cho detector sub-agent
// (export có sẵn) + đếm sau trần: kiểm tra hàm đo là nền của cả 2 cơ chế.
// ---------------------------------------------------------------------------
describe('r68 (FIX-6/BUG-004) — nền detector ngôn ngữ dùng chung', () => {
  test('thought tiếng Anh thật của SENTINEL (it6) → ratio ~0', () => {
    expect(vietnameseTextRatio('Route, allowlist and runner are read. Now the token helper, the test file, and the quality-gate entrypoint.')).toBeLessThan(0.08)
  })
  test('thought tiếng Việt thật của Omega (evt3) → ratio cao', () => {
    expect(vietnameseTextRatio('MỤC TIÊU: tiếp tục triển khai và kiểm chứng các phần bảo mật P0/P1/P2 còn dở, ưu tiên đóng P0-1 rồi P0-2/P0-3.')).toBeGreaterThanOrEqual(0.08)
  })
})
