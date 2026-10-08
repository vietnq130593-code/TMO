/**
 * r70 — TEST CHO CÁC FIX TỪ GIAO THỨC QUAN SÁT round-70 (Bug_v2.md)
 *
 * Mọi test bắt từ BẰNG CHỨNG quan sát mission cmuzscdvj0013llzrvlyky79t
 * (Omega + SENTINEL/RAMPAGE/Linh Sickyx/MEGATRON, 17:03-17:31Z — Bug_v2.md):
 *   - BUG2-001: Omega evt4 phát priority "critical" → tool reject oan →
 *     alias normalization tầng tool (critical/urgent/blocker → high...).
 *   - BUG2-002: matcher coverage chỉ nhận "[Nghiệm thu <số>]" trong khi
 *     directive dạy "[Nghiệm thu P1-3]" → Omega viết todo 3 lần (evt9/12)
 *     → giờ label-id từ chính tiêu chí cũng khớp.
 *   - BUG2-003: "hoàn toàn chỉ đọc … không sửa cấu hình bị cấm" → "sửa" trong
 *     PHỦ ĐỊNH sống sót qua strip → auto-detect false → sub nhận 45 tool ghi
 *     (Linh Sickyx mkdir + redirect thật) → giờ phủ định tổng quát được strip.
 *   - BUG2-007/013: detector ngôn ngữ đo result.content THÔ → lượt thuần
 *     tool-call JSON bị kết tội "tiếng Anh" oan 11 lần (evt47-89) → giờ đo
 *     prose ĐÃ MASK; vi phạm thật (evt68/88) vẫn bắn.
 *   - BUG2-008: evt38 thought text = `<tool_call>` treo lẻ (11 ký tự) →
 *     persist event "rỗng" → giờ strip tag treo + ký tự vô hình.
 *   - BUG2-012: tool call dạng Claude `tool_use>{"tool_uses":[
 *     {"recipient_name":"functions.file_read","parameters":{…}}]}` (evt55/68)
 *     → parser không nhận (prose-nudge oan 2/2) + mask không che → giờ có
 *     tầng parse thứ 7 + mask family (4).
 *   - BUG2-015: "Zen 429 rate-limited (key #1) — FreeUsageLimitError" giết
 *     delegation nhãn error (evt145) → giờ TRANSIENT_LLM_ERROR_RE phân loại
 *     để sub-loop ngủ-65s-tái-thử thay vì chết.
 *   - BUG2-016: trọng tài phán âm 18%/12% vì preview 160-chars cắt 72-match
 *     → giờ evidence kèm digest có cấu trúc (tổng số + mẫu path).
 *   - BUG2-017: nudge "9 mục CHƯA hoàn thành" khi DB 9/9 completed (MEGATRON
 *     evt41→47) → giờ merge snapshot GIỮ status cũ khi item thiếu status.
 *   - BUG2-011: 6 tiến trình bun test/5 phút đẩy RSS 2126MB → restart giết
 *     3 delegation → giờ testSpawnGuard serialize + mem pre-flight.
 */

import { describe, test, expect } from 'bun:test'

import { detectReadOnlyDelegation } from '../src/lib/subagent-delegate'
import { TRANSIENT_LLM_ERROR_RE, mergeTodoSnapshot, resultDigestForEvidence } from '../src/lib/subagent-delegate'
import { parseToolCallsFromOutput, maskToolCallText } from '../src/lib/tool-calls'
import { stripInvisibleThoughtNoise } from '../src/lib/agent-run-tracker'
import { vietnameseTextRatio } from '../src/lib/agent-goal-loop'
import { normalizeTodoPriority } from '../src/lib/code-team/dev-tools'
import { testSpawnGuard } from '../src/lib/code-team/dev-tools'
import { checkTodoCoverage } from '../src/lib/todo-coverage'

// ==================== BUG2-001 — priority alias ====================

describe('r70 BUG2-001 — todo_write priority alias (bằng chứng evt4: "Invalid priority: critical")', () => {
  test('critical/urgent/blocker/p0 → high (từ vựng bảo mật tự nhiên của model)', () => {
    expect(normalizeTodoPriority('critical')).toBe('high')
    expect(normalizeTodoPriority('Urgent')).toBe('high')
    expect(normalizeTodoPriority('blocker')).toBe('high')
    expect(normalizeTodoPriority('P0')).toBe('high')
  })
  test('trivial/minor/lowest/optional → low · normal/default → medium', () => {
    expect(normalizeTodoPriority('trivial')).toBe('low')
    expect(normalizeTodoPriority('minor')).toBe('low')
    expect(normalizeTodoPriority('normal')).toBe('medium')
    expect(normalizeTodoPriority('default')).toBe('medium')
  })
  test('giá trị chuẩn giữ nguyên · giá trị lạ thật sự KHÔNG bị mù map', () => {
    expect(normalizeTodoPriority('high')).toBe('high')
    expect(normalizeTodoPriority('medium')).toBe('medium')
    expect(normalizeTodoPriority('low')).toBe('low')
    // giá trị lạ → trả nguyên bản để tầng validation reject như cũ
    expect(normalizeTodoPriority('supercalifragilistic')).toBe('supercalifragilistic')
    expect(normalizeTodoPriority(42)).toBe(42)
  })
})

// ==================== BUG2-002 — coverage label-id ====================

describe('r70 BUG2-002 — coverage matcher chấp nhận nhãn directive (bằng chứng evt9: "2/8", evt12: 3 lần todo_write)', () => {
  // Tiêu chí NGUYÊN VĂN từ GoalLoopJob.input.userMessage mission r70
  const CRIT_P1_3 = '[Nghiệm thu P1-3] Chỉ đọc secret scan redact, bun audit, Next/reverse-proxy/security headers/cookie/debug/env; lưu báo cáo machine-verifiable, không sửa cấu hình bị cấm'
  const CRIT_P0_3 = '[Nghiệm thu P0-3] Kiểm kê mọi raw SQL, loại bỏ SQL input không tham số, giới hạn knowledge read-only/LIMIT/log an toàn, và test SQL injection âm tính'
  const CRIT_TONG_THE = '[Nghiệm thu tổng thể 2] Hoàn thiện báo cáo cuối: bảng 7 dòng, bằng chứng file:dòng/test, phần thiếu, đề xuất và tự phản chiếu'

  test('todo ghi "[Nghiệm thu P1-3]" (dạng nhãn directive dạy) → ĐƯỢC tính phủ (trước đây = gap)', () => {
    const todos = [{ content: '[Nghiệm thu P1-3] Secret scan có redact + bun audit + kiểm tra cấu hình Next/proxy/headers/cookie' }]
    const r = checkTodoCoverage({ todos, acceptance: [CRIT_P1_3], dataScopeItems: [] })
    expect(r.acceptanceCovered).toBe(1)
    expect(r.ok).toBe(true)
  })
  test('biến thể "nghiệm thu p1.3"/"p1_3" (chuẩn hóa -/./_) vẫn khớp', () => {
    const todos = [{ content: 'Chạy nghiệm thu p1.3: secret scan + audit cấu hình' }]
    const r = checkTodoCoverage({ todos, acceptance: [CRIT_P1_3], dataScopeItems: [] })
    expect(r.acceptanceCovered).toBe(1)
  })
  test('nhãn "tổng thể 2" (chữ + số) khớp đúng tiêu chí tương ứng — không tràn sang tiêu chí khác', () => {
    const todos = [{ content: 'Hoàn thiện báo cáo cuối theo nghiệm thu tổng thể 2' }]
    const r = checkTodoCoverage({ todos, acceptance: [CRIT_P0_3, CRIT_TONG_THE], dataScopeItems: [] })
    expect(r.acceptanceCovered).toBe(1)
    expect(r.acceptanceGaps.map(g => g.index)).toEqual([1]) // P0-3 vẫn thiếu — đúng
  })
  test('tag số-thứ-tự cũ "[Nghiệm thu 2]" vẫn hoạt động (không hồi quy)', () => {
    const todos = [{ content: '[Nghiệm thu 2] Kiểm kê raw SQL + test SQLi âm tính' }]
    const r = checkTodoCoverage({ todos, acceptance: [CRIT_P1_3, CRIT_P0_3], dataScopeItems: [] })
    expect(r.acceptanceCovered).toBe(1)
    expect(r.acceptanceGaps.map(g => g.index)).toEqual([1])
  })
})

// ==================== BUG2-003 — readOnly auto-detect phủ định ====================

describe('r70 BUG2-003 — detectReadOnlyDelegation strip phủ định tổng quát (bằng chứng Linh Sickyx 45 tools)', () => {
  test('"chỉ đọc … không sửa cấu hình bị cấm" (tân ngữ ngoài whitelist cũ) → TRUE (trước đây false oan)', () => {
    const brief = 'Kiểm định read-only hạng mục bảo mật: audit auth/authorization, argv allowlist, path confinement; không sửa cấu hình bị cấm trong lúc kiểm định.'
    expect(detectReadOnlyDelegation(brief)).toBe(true)
  })
  test('ràng buộc phủ định các đối tượng cũ vẫn TRUE (không hồi quy): "chỉ đọc và kiểm định; không sửa file"', () => {
    expect(detectReadOnlyDelegation('Khảo sát độc lập phần còn dở P0-1, chỉ đọc và kiểm định; không sửa file. Đọc đầy đủ route và test.')).toBe(true)
  })
  test('nhiệm vụ CÓ yêu cầu lưu artifact riêng → FALSE (BUG2-003b — readOnly strip sẽ chặn luôn việc lưu, TL phải chủ đích truyền cờ)', () => {
    const brief = 'Thực hiện P1-3 hoàn toàn chỉ đọc: secret scan có redact, bun audit, kiểm tra cấu hình Next.js, reverse-proxy trust, security headers, cookie flags, chế độ debug, khai báo biến môi trường nhạy cảm và endpoint debug. Lưu artifact báo cáo machine-verifiable dưới scratch/.'
    expect(detectReadOnlyDelegation(brief)).toBe(false)
  })
  test('task hỗn hợp khảo sát + sửa thật sự (không ràng buộc chỉ-đọc) → FALSE', () => {
    expect(detectReadOnlyDelegation('Hoàn thiện và kiểm định P0-1: sửa argv allowlist rồi chạy test')).toBe(false)
  })
  test('"don\'t write code" (phủ định tiếng Anh) → TRUE', () => {
    expect(detectReadOnlyDelegation('Survey this module read-only, don\'t write code or commit anything.')).toBe(true)
  })
})

// ==================== BUG2-012 — parser dạng Claude tool_use + mask ====================

// Nguyên văn dạng evt55 mission r70 (functions.* + parameters)
const CLAUDE_TOOL_USE_EVT55 = `Phân tích trace của SENTINEL để đối chiếu.
tool_use>{"tool_uses":[{"recipient_name":"functions.file_read","parameters":{"path":"agent-runs/sub_1791479109537_3.jsonl","offset":9,"limit":50}}]}
Tiếp theo tôi sẽ đọc nốt phần còn lại.`

describe('r70 BUG2-012 — parser tầng Claude tool_use (bằng chứng evt55/68 + prose-nudge oan 2/2)', () => {
  test('bóc được file_read với parameters chuẩn hóa (strip tiền tố functions.)', () => {
    const calls = parseToolCallsFromOutput(CLAUDE_TOOL_USE_EVT55)
    expect(calls.length).toBe(1)
    expect(calls[0].name).toBe('file_read')
    expect((calls[0].args as Record<string, unknown>).path).toBe('agent-runs/sub_1791479109537_3.jsonl')
    expect((calls[0].args as Record<string, unknown>).offset).toBe(9)
  })
  test('mảng NHIỀU phần tử — bóc đủ từng call', () => {
    const two = `tool_use>{"tool_uses":[{"recipient_name":"functions.todo_read","parameters":{}},{"recipient_name":"functions.grep","parameters":{"pattern":"queryRawUnsafe","path":"src"}}]}`
    const calls = parseToolCallsFromOutput(two)
    expect(calls.map(c => c.name).sort()).toEqual(['grep', 'todo_read'])
  })
  test('mảng bị CẮT GIỮA CHỪNG (maxTokens) — salvage phần tử hoàn chỉnh trước điểm đứt', () => {
    const cut = `tool_use>{"tool_uses":[{"recipient_name":"functions.todo_read","parameters":{}},{"recipient_name":"functions.file_read","parameters":{"path":"src/li`
    const calls = parseToolCallsFromOutput(cut)
    // todo_read (phần tử hoàn chỉnh) vẫn execute được — không mất trắng
    expect(calls.some(c => c.name === 'todo_read')).toBe(true)
  })
  test('garble tiền tố của provider (ngt_…_rewritten>) không cản trở việc bóc', () => {
    const garbled = `ngt_2b90d4cfb8c4_rewritten>{"tool_uses":[{"recipient_name":"functions.todo_read","parameters":{}}]}`
    const calls = parseToolCallsFromOutput(garbled)
    expect(calls.length).toBe(1)
    expect(calls[0].name).toBe('todo_read')
  })
  test('tên tool NGOÀI whitelist không execute (chống hallucinate)', () => {
    const bogus = `tool_use>{"tool_uses":[{"recipient_name":"functions.delete_everything","parameters":{"path":"/"}}]}`
    expect(parseToolCallsFromOutput(bogus).length).toBe(0)
  })
})

describe('r70 BUG2-012 — maskToolCallText family (4) che khối tool_use khỏi kênh suy nghĩ', () => {
  test('khối tool_use trọn vẹn bị thay bằng marker, prose thật giữ lại', () => {
    const masked = maskToolCallText(CLAUDE_TOOL_USE_EVT55)
    expect(masked).toContain('file_read')
    expect(masked).not.toContain('"recipient_name"')
    expect(masked).toContain('Phân tích trace của SENTINEL')
    expect(masked).toContain('Tiếp theo tôi sẽ đọc nốt')
  })
  test('mảng đứt giữa chừng cũng được che tới phần tử hoàn chỉnh cuối', () => {
    const cut = `Suy nghĩ trước.{"tool_uses":[{"recipient_name":"functions.todo_read","parameters":{}},{"recipient_name":"functions.file_read","parameters":{"path":"src/li`
    const masked = maskToolCallText(cut)
    expect(masked).not.toContain('"recipient_name"')
    expect(masked).toContain('Suy nghĩ trước.')
  })
})

// ==================== BUG2-007/013 — detector ngôn ngữ đo prose đã mask ====================

describe('r70 BUG2-007/013 — detector đo prose ĐÃ MASK (bằng chứng 11 cảnh báo oan evt47-89 + evt68/88 thật)', () => {
  test('lượt thuần tool-call JSON → prose rỗng → ratio 1 (IM LẶNG — trước đây 0% oan)', () => {
    const prose = maskToolCallText(stripInvisibleThoughtNoise(CLAUDE_TOOL_USE_EVT55.replace('Phân tích trace của SENTINEL để đối chiếu.', '').replace('Tiếp theo tôi sẽ đọc nốt phần còn lại.', '')))
    expect(vietnameseTextRatio(prose)).toBe(1)
  })
  test('vi phạm THẬT (suy luận tiếng Anh evt68/88) vẫn bị bắt sau mask', () => {
    const realEnglish = 'We need produce tool call. Since tools not actually exposed as namespace in prompt UI? In previous transcript, assistant used the recipient name format successfully.'
    expect(vietnameseTextRatio(maskToolCallText(realEnglish))).toBeLessThan(0.08)
  })
  test('prose tiếng Việt chuẩn quanh khối JSON không bị cảnh báo', () => {
    const mixed = `Tôi đọc trace trước đã. tool_use>{"tool_uses":[{"recipient_name":"functions.file_read","parameters":{"path":"a.jsonl"}}]} Sau khi đọc xong tôi sẽ tổng hợp lại bằng chứng cho trọng tài độc lập kiểm tra.`
    expect(vietnameseTextRatio(maskToolCallText(mixed))).toBeGreaterThanOrEqual(0.08)
  })
})

// ==================== BUG2-008 — thought rỗng / tag treo ====================

describe('r70 BUG2-008 — stripInvisibleThoughtNoise (bằng chứng evt38: 11 ký tự `<tool_call>` treo lẻ)', () => {
  test('tag tool_call treo lẻ nguyên văn evt38 → rỗng (không persist event trống)', () => {
    const evt38 = '<tool_call>' // codepoints 0x3c,0x74,0x6f,0x6f,0x6c,0x5f,0x63,0x61,0x6c,0x6c,0x3e
    expect(stripInvisibleThoughtNoise(evt38)).toBe('')
  })
  test('biến thể tag treo khác cũng bị dọn (đóng/mở/tool_use/invoke, không có >)', () => {
    expect(stripInvisibleThoughtNoise('</tool_call>')).toBe('')
    expect(stripInvisibleThoughtNoise('<tool_use ')).toBe('')
    expect(stripInvisibleThoughtNoise('<invoke name="x">')).toBe('')
    expect(stripInvisibleThoughtNoise('</function_calls>')).toBe('')
  })
  test('ký tự zero-width/control bị dọn nhưng prose Việt giữ nguyên', () => {
    expect(stripInvisibleThoughtNoise('\u200b\u200e\u0000\u000b')).toBe('')
    const vi = 'Tôi sẽ đọc trace của SENTINEL để đối chiếu bằng chứng.'
    expect(stripInvisibleThoughtNoise(vi)).toBe(vi)
  })
})

// ==================== BUG2-015 — phân loại lỗi provider transient ====================

describe('r70 BUG2-015 — TRANSIENT_LLM_ERROR_RE (bằng chứng evt145: Zen 429 giết delegation)', () => {
  test('thông điệp 429 thật từ mission r70 được phân loại là transient (được ngủ-tái-thử)', () => {
    expect(TRANSIENT_LLM_ERROR_RE.test('Zen model "space-bunny-free" thất bại toàn chuỗi (HTTP + CLI): Zen 429 rate-limited (key #1) — NIM đã ngừng dùng cho agents')).toBe(true)
    expect(TRANSIENT_LLM_ERROR_RE.test('{"type":"error","error":{"type":"FreeUsageLimitError","message":"Rate limit exceeded. Please try again later."}}')).toBe(true)
    expect(TRANSIENT_LLM_ERROR_RE.test('fetch failed: socket hang up')).toBe(true)
    expect(TRANSIENT_LLM_ERROR_RE.test('HTTP 503 Service Unavailable — provider overloaded')).toBe(true)
  })
  test('lỗi KHÔNG transient (cú pháp/tham số) không lọt nhánh retry', () => {
    expect(TRANSIENT_LLM_ERROR_RE.test('Invalid tool arguments: expected object')).toBe(false)
    expect(TRANSIENT_LLM_ERROR_RE.test('model not found: unknown-model-xyz')).toBe(false)
  })
})

// ==================== BUG2-016 — evidence digest ====================

describe('r70 BUG2-016 — resultDigestForEvidence (bằng chứng: trọng tài phán âm vì "72 kết quả bị cắt")', () => {
  test('grep 72 match → digest kèm tổng số + mẫu path (đủ cho trọng tài thẩm định)', () => {
    const matches = Array.from({ length: 72 }, (_, i) => `src/lib/file${i % 7}.ts:${i + 10}:$queryRawUnsafe(...)`)
    const d = resultDigestForEvidence('grep', { success: true, matches, totalMatches: 72, filesScanned: 7, truncated: false })
    expect(d).toContain('72 match')
    expect(d).toContain('src/lib/file0.ts')
    expect(d.length).toBeLessThan(200) // không phình evidence tier
  })
  test('file_read → digest path + số dòng', () => {
    const d = resultDigestForEvidence('file_read', { success: true, path: 'src/lib/exec-allowlist.ts', content: 'a\nb\nc\nd' })
    expect(d).toContain('exec-allowlist.ts')
    expect(d).toContain('4 dòng')
  })
  test('tool không liên quan → rỗng (không nhiễu)', () => {
    expect(resultDigestForEvidence('todo_write', { success: true })).toBe('')
    expect(resultDigestForEvidence('grep', null)).toBe('')
  })
})

// ==================== BUG2-017 — merge snapshot giữ status cũ ====================

describe('r70 BUG2-017 — mergeTodoSnapshot (bằng chứng MEGATRON: nudge "9 chưa hoàn thành" khi DB 9/9)', () => {
  test('item update-theo-id KHÔNG kèm status → GIỮ status cũ (không regress về pending)', () => {
    const prev = [
      { id: 't1', content: 'Inventory raw SQL', status: 'completed' },
      { id: 't2', content: 'Viết test SQLi âm tính', status: 'completed' },
    ]
    const incoming = [
      { id: 't1', content: 'Inventory raw SQL', status: null }, // update không kèm status
    ]
    const merged = mergeTodoSnapshot(prev, incoming)
    const t1 = merged.find(t => t.id === 't1')
    expect(t1?.status).toBe('completed') // TRƯỚC FIX: 'pending' → nudge stale oan
    expect(merged.find(t => t.id === 't2')).toBeDefined() // item vắng vẫn giữ
  })
  test('item kèm status tường minh vẫn ghi đè đúng', () => {
    const prev = [{ id: 't1', content: 'A', status: 'pending' }]
    const merged = mergeTodoSnapshot(prev, [{ id: 't1', content: 'A', status: 'completed' }])
    expect(merged[0].status).toBe('completed')
  })
  test('item hoàn toàn MỚI (không trùng) → status mặc định pending (chuẩn tạo-mới)', () => {
    const prev = [{ id: 't1', content: 'A', status: 'completed' }]
    const merged = mergeTodoSnapshot(prev, [{ id: undefined, content: 'Việc mới', status: null }])
    expect(merged.find(t => t.content === 'Việc mới')?.status).toBe('pending')
  })
})

// ==================== BUG2-011 — test spawn guard ====================

describe('r70 BUG2-011 — testSpawnGuard serialize + mem pre-flight (bằng chứng RSS 2126MB → restart giết 3 delegation)', () => {
  test('đã có 1 test đang chạy → từ chối spawn (serialize) kèm hướng dẫn không coi là FAIL', () => {
    const g = testSpawnGuard({ inflight: 1, freeMb: 2000 })
    expect(g.ok).toBe(false)
    if (!g.ok) {
      expect(g.error).toContain('KHÔNG coi đây là test FAIL')
      expect(g.error).toContain('serialize')
    }
  })
  test('MemAvailable dưới sàn → từ chối spawn kèm lý do tài nguyên', () => {
    const g = testSpawnGuard({ inflight: 0, freeMb: 300, minFreeMb: 450 })
    expect(g.ok).toBe(false)
    if (!g.ok) expect(g.error).toContain('MemAvailable')
  })
  test('điều kiện bình thường → cho phép', () => {
    const g = testSpawnGuard({ inflight: 0, freeMb: 1992, minFreeMb: 450 })
    expect(g.ok).toBe(true)
  })
})

// ==================== HỒI QUY — các họ parser/mask cũ không vỡ ====================

describe('r70 hồi quy — các dạng cũ vẫn parse/mask như trước (không vỡ sau khi thêm tầng 7)', () => {
  test('pattern-1 tool_call: name({...}) vẫn parse', () => {
    const calls = parseToolCallsFromOutput('tool_call: todo_read({"sessionId":"s1"})')
    expect(calls.length).toBe(1)
    expect(calls[0].name).toBe('todo_read')
  })
  test('native body {"name":…,"arguments":…} vẫn parse (tầng 6 không bị tầng 7 đè)', () => {
    const calls = parseToolCallsFromOutput('{"name":"todo_read","arguments":{}}')
    expect(calls.length).toBe(1)
    expect(calls[0].name).toBe('todo_read')
  })
  test('mask family cũ vẫn che: name({json}) + {"name":…}', () => {
    const masked = maskToolCallText('Suy nghĩ Việt. todo_read({"sessionId":"x"}) tiếp tục nghĩ.')
    expect(masked).not.toContain('"sessionId"')
    expect(masked).toContain('Suy nghĩ Việt.')
  })
})
