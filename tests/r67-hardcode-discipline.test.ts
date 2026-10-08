// ============================================================================
// TEST SUITE — r67 (AUDIT LƯỢT 9): hardcode thay dạy-bằng-prompt + bản đồ dữ
// liệu + 2 gap parser thật từ dữ liệu vận hành (bằng chứng trích nguyên văn
// từ agent-runs/*.jsonl — xem comment từng test).
// ============================================================================

import { describe, test, expect } from 'bun:test'
import {
  extractToolCallsWithDiagnostics,
  detectBrokenToolCallHint,
} from '../src/lib/tool-calls'
import { applyDelegationVerdictGuard, vietnameseTextRatio, type EvalVerdict } from '../src/lib/agent-goal-loop'
import {
  DATA_REGIONS,
  routeDataMap,
  buildDataMapBlock,
  dataMapToolResult,
} from '../src/lib/data-map'

// ---------------------------------------------------------------------------
// F1 — biến thể MẤT `<`: `todo_write">{…}` (bằng chứng run_1791447941276_1
// L23 + ~15 dòng/8 file thật — trước r67: 0 call + detector im lặng).
// ---------------------------------------------------------------------------
describe('r67 (F1) — parser biến thể mất dấu < mở', () => {
  test('bằng chứng L23: todo_write">{JSON} (không <) → 1 call execute được', () => {
    const raw = `Tự phản chiếu: việc còn thiếu là đọc lại artifact và mã nguồn thật.\ntodo_write">{\"sessionId\":\"default\",\"agentRole\":\"TL\",\"todos\":[{\"id\":\"cmuz9vnnb000mllo2o224eknd\",\"status\":\"completed\"}]}`
    const { calls, parseFailures } = extractToolCallsWithDiagnostics(raw)
    expect(calls.length).toBe(1)
    expect(calls[0].name).toBe('todo_write')
    expect(Array.isArray(calls[0].args.todos)).toBe(true)
    expect(parseFailures).toBe(0)
  })

  test('todo_write"><sessionId>… (XML, không <) → 1 call, todos là MẢNG', () => {
    const raw = `todo_write"><sessionId>agent_x</sessionId><agentRole>TL</agentRole><todos><item><content>việc A</content><status>pending</status></item></todos>`
    const { calls } = extractToolCallsWithDiagnostics(raw)
    expect(calls.length).toBe(1)
    expect(Array.isArray(calls[0].args.todos)).toBe(true)
  })

  test('prose thường nhắc tên tool (không có args-con {/< theo sau) → KHÔNG execute', () => {
    const raw = `Tôi sẽ dùng todo_write> sau khi khảo sát xong, và grep> để tìm dấu vết.`
    const { calls } = extractToolCallsWithDiagnostics(raw)
    expect(calls.length).toBe(0)
  })

  test('biến thể mất < + args CỤT → detector KHÔNG im lặng (dạy phát lại)', () => {
    const raw = `todo_write">{\"sessionId\":\"default\",\"todos\":[{\"id\":\"a1\",\"status\":\"in_prog`
    const { calls } = extractToolCallsWithDiagnostics(raw)
    expect(calls.length).toBe(0)
    const hint = detectBrokenToolCallHint(raw)
    expect(hint).toBeTruthy() // phải có feedback dạy lại — không được im lặng
    expect(hint).toContain('todo_write')
  })
})

// ---------------------------------------------------------------------------
// F2 — thân native JSON TRẦN (không fence): bằng chứng run_1791316436940_1
// 2 dòng liên tiếp `{"name":"todo_read","arguments":{}}` — trước r67: 0 tầng
// nào parse + detector chỉ nhận dạng trong ```json fence → im lặng.
// ---------------------------------------------------------------------------
describe('r67 (F2) — parser thân native JSON thường trần', () => {
  test('bằng chứng thật: 2 body JSON liền nhau → 2 call đúng tool + args', () => {
    const raw = `...đối chiếu fixture local, không đụng production config.\n\n\n{"name":"todo_read","arguments":{}}\n{"name":"file_list","arguments":{"path":"audit-out/security-evidence"}}`
    const { calls, parseFailures } = extractToolCallsWithDiagnostics(raw)
    expect(calls.length).toBe(2)
    expect(calls[0].name).toBe('todo_read')
    expect(calls[1].name).toBe('file_list')
    expect(calls[1].args.path).toBe('audit-out/security-evidence')
    expect(parseFailures).toBe(0)
  })

  test('tên NGOÀI whitelist (chống hallucinate) → không execute', () => {
    const raw = `{"name":"rm_rf_everything","arguments":{}}`
    const { calls } = extractToolCallsWithDiagnostics(raw)
    expect(calls.length).toBe(0)
  })

  test('tool NGUY HIỂM (file_write) + arguments đứt → KHÔNG salvage (đếm failure + detector)', () => {
    const raw = `{"name":"file_write","arguments":{"path":"x.ts","content":"đứt giữa chừng`
    const { calls, parseFailures } = extractToolCallsWithDiagnostics(raw)
    expect(calls.length).toBe(0)
    expect(parseFailures).toBeGreaterThan(0)
    expect(detectBrokenToolCallHint(raw)).toBeTruthy()
  })

  test('body JSON nằm TRONG args tool_call chuẩn → không nhúng kép', () => {
    const raw = `tool_call: file_write({"path": "docs/vd.md", "content": "ví dụ gọi: {\\"name\\":\\"todo_read\\",\\"arguments\\":{}}"})`
    const { calls } = extractToolCallsWithDiagnostics(raw)
    expect(calls.length).toBe(1) // chỉ file_write — todo_read trong content KHÔNG chạy
    expect(calls[0].name).toBe('file_write')
  })
})

// ---------------------------------------------------------------------------
// F4 — nhất quán shape: <todos> 1 item CŨNG phải ra ARRAY (trước r67: 1 item
// → object {item:{…}} chỉ thoát nhờ unwrap phía consumer).
// ---------------------------------------------------------------------------
describe('r67 (F4) — shape nhất quán mảng XML 1/N phần tử', () => {
  test('1 item → ARRAY 1 phần tử (không còn object {item:…})', () => {
    const raw = `<todo_write"><sessionId>s1</sessionId><todos><item><id>i1</id><status>in_progress</status></item></todos>`
    const { calls } = extractToolCallsWithDiagnostics(raw)
    expect(calls.length).toBe(1)
    expect(Array.isArray(calls[0].args.todos)).toBe(true)
    expect((calls[0].args.todos as unknown[]).length).toBe(1)
  })
  test('2 item → ARRAY 2 phần tử (giữ hành vi r66)', () => {
    const raw = `<todo_write"><sessionId>s1</sessionId><todos><item><id>i1</id></item><item><id>i2</id></item></todos>`
    const { calls } = extractToolCallsWithDiagnostics(raw)
    expect(Array.isArray(calls[0].args.todos)).toBe(true)
    expect((calls[0].args.todos as unknown[]).length).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// F6 — pattern-2 push jsonSpans: tag-tool trong content JSON của pattern-2
// call không bị tầng tag-direct nhúng execute kép.
// ---------------------------------------------------------------------------
describe('r67 (F6) — pattern-2 + tag-direct không execute kép', () => {
  test('opencode({content JSON HỢP LỆ có <todo_write"> escape đúng}) → chỉ 1 call opencode', () => {
    // Nội dung JSON string escape đúng (\") — như output LLM thật
    const raw = `opencode({"action": "write", "path": "notes.md", "content": "ví dụ mangled: <todo_write\\"><sessionId>x</sessionId><todos><item><content>không được chạy</content></item></todos>"})`
    const { calls } = extractToolCallsWithDiagnostics(raw)
    expect(calls.length).toBe(1)
    expect(calls[0].name).toBe('opencode')
  })

  test('opencode({JSON HỎNG — quote không escape trong content}) → 0 call từ ví dụ nhúng (vùng được che)', () => {
    // JSON hỏng (content chứa " thô) → pattern-2 fail → TRƯỚC r67 tầng
    // tag-direct gặt tag-tool trong vùng hỏng → execute nhúng. Giờ vùng fail
    // được che → ví dụ bên trong KHÔNG chạy.
    const raw = `opencode({"action": "write", "path": "notes.md", "content": "ví dụ mangled: <todo_write"><sessionId>x</sessionId><todos><item><content>không được chạy</content></item></todos>"})`
    const { calls, parseFailures } = extractToolCallsWithDiagnostics(raw)
    expect(parseFailures).toBeGreaterThan(0) // pattern-2 thấy JSON hỏng
    expect(calls.length).toBe(0) // KHÔNG execute nhúng ví dụ bên trong
  })
})

// ---------------------------------------------------------------------------
// F7 — CỔNG PHÂN CÔNG hardcode: hậu xử lý verdict bằng MÃ (thay rule 19
// prompt r66 — user: "tôi không thích dạy agents bằng prompt").
// ---------------------------------------------------------------------------
describe('r67 (F7) — applyDelegationVerdictGuard (verdict guard bằng mã)', () => {
  const baseVerdict = (): EvalVerdict => ({
    complete: true,
    confidence: 0.9,
    verified: true,
    missing: [],
    rootCause: '',
    nextPlan: ['nộp báo cáo'],
    sideIssues: [],
    debtDecision: 'none',
    debtReadiness: 'ready',
    debtBlockedReason: '',
    needsInput: false,
    raw: '',
  })

  test('TL ôm làm (10 modify, 0 delegation) → gắn sideIssue phân công + nextPlan delegate, KHÔNG đổi complete', () => {
    const v = baseVerdict()
    applyDelegationVerdictGuard(v, { selfModifyOps: 10, delegationOps: 0 }, true)
    expect(v.complete).toBe(true) // kết quả đúng vẫn đúng — không hạ
    expect(v.confidence).toBe(0.9)
    expect(v.sideIssues.some(s => s.includes('phân công:'))).toBe(true)
    expect(v.nextPlan.some(p => p.includes('delegate'))).toBe(true)
  })

  test('đã có delegation (≥1) → KHÔNG gắn (phân công đã ổn)', () => {
    const v = baseVerdict()
    applyDelegationVerdictGuard(v, { selfModifyOps: 15, delegationOps: 2 }, true)
    expect(v.sideIssues.length).toBe(0)
    expect(v.nextPlan.length).toBe(1)
  })

  test('chưa tới ngưỡng 8 → KHÔNG gắn (TL tự làm việc nhỏ đúng đắn)', () => {
    const v = baseVerdict()
    applyDelegationVerdictGuard(v, { selfModifyOps: 7, delegationOps: 0 }, true)
    expect(v.sideIssues.length).toBe(0)
  })

  test('agent KHÔNG có tool delegation → kỷ luật TL không áp', () => {
    const v = baseVerdict()
    applyDelegationVerdictGuard(v, { selfModifyOps: 20, delegationOps: 0 }, false)
    expect(v.sideIssues.length).toBe(0)
  })

  test('idempotent — verdict đã có sideIssue phân công → không gắn kép', () => {
    const v = baseVerdict()
    v.sideIssues.push('phân công: 9 thao tác tự làm từ chu kỳ trước')
    applyDelegationVerdictGuard(v, { selfModifyOps: 9, delegationOps: 0 }, true)
    expect(v.sideIssues.length).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// F9 — detector ngôn ngữ tiếng Việt bằng mã (protocol prompt r66 V4 dễ bị
// bỏ qua khi dữ liệu lớn — giờ có kiểm tra cứng).
// ---------------------------------------------------------------------------
describe('r67 (F9) — vietnameseTextRatio (đo bằng mã)', () => {
  test('văn tiếng Việt chuẩn → ratio cao (>0.15)', () => {
    const vi = 'Tôi sẽ khảo sát mã nguồn của hệ thống, lập danh sách các tuyến đường API rồi đối chiếu với bằng chứng thu thập được từ công cụ máy, sau đó viết báo cáo nghiệm thu bằng tiếng Việt có dấu cho người đọc xem xét.'
    expect(vietnameseTextRatio(vi)).toBeGreaterThan(0.15)
  })
  test('văn tiếng Anh → ratio ~0 (bị cờ)', () => {
    const en = 'I will now survey the repository structure, compile a list of all API routes, then cross-check each entry against machine-collected evidence before writing the final acceptance report for review.'
    expect(vietnameseTextRatio(en)).toBeLessThan(0.05)
  })
  test('text ngắn (<60 chữ) → không chấm (trả 1 — tránh nhiễu code/args)', () => {
    expect(vietnameseTextRatio('ok done')).toBe(1)
    expect(vietnameseTextRatio('')).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// F8 — BẢN ĐỒ DỮ LIỆU (thay vai trò schema-router của LlamaIndex — hardcode
// registry phủ Prisma + Qdrant + Neo4J + file).
// ---------------------------------------------------------------------------
describe('r67 (F8) — data map registry + bộ định tuyến deterministic', () => {
  test('registry ≥14 vùng, phủ đủ 3 kho: prisma + qdrant + neo4j', () => {
    expect(DATA_REGIONS.length).toBeGreaterThanOrEqual(14)
    const stores = new Set(DATA_REGIONS.map(r => r.store))
    expect(stores.has('prisma')).toBe(true)
    expect(stores.has('qdrant')).toBe(true)
    expect(stores.has('neo4j')).toBe(true)
  })

  test('routeDataMap: việc todo/kế hoạch → vùng todo_plan đứng đầu reads', () => {
    const { reads } = routeDataMap('Lập kế hoạch các bước cần làm và cập nhật trạng thái todo trong phiên làm việc')
    expect(reads.length).toBeGreaterThan(0)
    expect(reads[0].region.id).toBe('todo_plan')
  })

  test('routeDataMap: việc tri thức tài liệu → knowledge_kb (Qdrant) + knowledge_graph (Neo4J)', () => {
    const { reads, writes } = routeDataMap('Tìm kiếm tài liệu tri thức đã nạp vào hệ thống và ghi thực thể mới vào đồ thị quan hệ')
    const ids = reads.map(r => r.region.id).concat(writes.map(w => w.region.id))
    expect(ids).toContain('knowledge_kb')
    expect(ids).toContain('knowledge_graph')
  })

  test('routeDataMap: deterministic — cùng input ra đúng cùng output', () => {
    const q = 'nghiên cứu khảo sát tài liệu ngoài rồi lưu kết quả nghiên cứu'
    const a = routeDataMap(q)
    const b = routeDataMap(q)
    expect(JSON.stringify(a.reads.map(r => r.region.id))).toBe(JSON.stringify(b.reads.map(r => r.region.id)))
  })

  test('buildDataMapBlock: có query khớp → block chứa chỉ dẫn đọc/ghi + tên tool; cap 1600 chars', () => {
    const block = buildDataMapBlock('Đối chiếu todo dở và lưu bài học run vào trí nhớ, tra số liệu token đã tiêu hao')
    expect(block.length).toBeGreaterThan(100)
    expect(block).toContain('BẢN ĐỒ DỮ LIỆU')
    expect(block.length).toBeLessThanOrEqual(1700)
  })

  test('buildDataMapBlock: query không khớp vùng nào → LIỆT KÊ SƠ LƯỢC registry (r68 BUG-015 đổi spec — rỗng làm mission thật mất bản đồ)', () => {
    // r67 gốc: expect(...).toBe('') — 0-match im lặng. r68 (bằng chứng mission
    // cmuznvkl…6b136k: directive "Tiếp tục triển khai…" 82 ký tự → map rỗng →
    // 0/18 message có 🗺️) ĐỔI SPEC: 0-match phải liệt kê SƠ LƯỢC toàn registry
    // (1 dòng/vùng) thay vì im lặng — giữ ý đồ gốc "không nhiễu context" bằng
    // cap độ dài thay vì chuỗi rỗng.
    const block = buildDataMapBlock('xin chào')
    expect(block.length).toBeGreaterThan(200) // có nội dung hướng dẫn
    expect(block.length).toBeLessThan(2200) // KHÔNG phình — cap 1600 mặc định
    expect(block).toContain('KHÔNG khớp vùng chuyên biệt')
  })

  test('dataMapToolResult: đầy đủ khi không query; routed khi có query', () => {
    const full = dataMapToolResult() as { success: boolean; mode: string; regions: unknown[] }
    expect(full.success).toBe(true)
    expect(full.mode).toBe('full')
    expect(full.regions.length).toBe(DATA_REGIONS.length)
    const routed = dataMapToolResult('ghi todo mới cho việc này') as { mode: string; docKhiCan: Array<{ id: string }> }
    expect(routed.mode).toBe('routed')
    expect(routed.docKhiCan[0].id).toBe('todo_plan')
  })

  test('mọi vùng registry có đủ 7 trường mô tả (location/purpose/read/write/readWhen/writeWhen/keywords)', () => {
    for (const r of DATA_REGIONS) {
      expect(r.id.length).toBeGreaterThan(2)
      expect(r.location.length).toBeGreaterThan(3)
      expect(r.purpose.length).toBeGreaterThan(5)
      expect(r.readPath.length).toBeGreaterThan(2)
      expect(r.keywords.length).toBeGreaterThan(2)
    }
  })
})

// ---------------------------------------------------------------------------
// Hồi quy tổng — các format cũ r66 không vỡ (đã có suite r66 riêng; ở đây
// chỉ chặp nhanh 2 dạng biên liên quan tới tầng mới).
// ---------------------------------------------------------------------------
describe('r67 — hồi quy biên', () => {
  test('prose thuần sạch → 0 call 0 failure (không false-positive tầng mới)', () => {
    const raw = 'Hôm nay tôi sẽ phân tích kiến trúc tổng thể của hệ thống dữ liệu trước khi bắt tay vào việc.'
    const { calls, parseFailures } = extractToolCallsWithDiagnostics(raw)
    expect(calls.length).toBe(0)
    expect(parseFailures).toBe(0)
    expect(detectBrokenToolCallHint(raw)).toBeNull()
  })
})
