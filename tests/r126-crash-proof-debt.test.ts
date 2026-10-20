/**
 * R126 TESTS — ĐƯỜNG GHI NỢ THỨ 4 "CRASH-PROOF" (QUAN-SAT lượt 7 · R17 —
 * user duyệt "Tiến hành các đề xuất cho tôi": 6.1a salvage ghi nợ · 6.1b
 * orphan-sweep đánh FAIL ghi nợ · 6.1c tool-failure lặp ≥3 ghi nợ · 6.2A
 * health timeout 20s→60s + hidden guard · 6.3 nhãn nguồn R2 uploads).
 *
 * Phạm vi regression (pattern r123/r124/r125: nhóm A source-scan + nhóm B unit):
 *   A. Source-scan:
 *      - alerts.ts salvageCrashedRun: recordDebtIssue kind='infra' nằm trong
 *        cửa !alreadyAlerted (dedup boot sweep + runtime sweep — 1 run crash
 *        ghi nợ đúng 1 lần) + fail-open.
 *      - goal-loop-worker.ts sweepOrphans: CẢ 2 nhánh mark FAILED (stale R18
 *        + attempts cạn) đều recordDebtIssue — trước đây im lặng (bằng chứng
 *        R16 V1.5: DebtLedger 0 dòng dù job user hủy vĩnh viễn).
 *      - tool-metrics-recorder.ts: nhánh !success đếm toolMetric.count cùng
 *        (sessionId, toolName) — ≥3 → recordDebtIssue; errorTag nằm trong
 *        issue (2 họ lỗi của cùng tool = 2 nợ riêng); sessionId 'unknown'
 *        → null (không gộp oan mọi session thiếu id).
 *      - page.tsx 6.2A: /api/health client timeout 20s→60s (×19 "failed to
 *        pipe response — ReadableStream is locked" khi client abort request
 *        45-118s giữa chừng) + tab ẩn bỏ poll (force vẫn chạy).
 *      - page.tsx 6.3: "Đang chờ {n}" → "R2 uploads (chưa qua pipeline) {n}"
 *        + dòng đối chiếu "Đã indexed (Qdrant) {i}/{t}" (2 nguồn sự thật —
 *        stats 9 Qdrant vs listing 118 R2, bằng chứng R16 V3).
 *   B. Unit — pure logic fingerprintDebtIssue/debtTitleFrom (debt-ledger.ts
 *      thuần, không import tĩnh DB — không đụng file DB khi load):
 *      - 2 lần salvage khác runId (cuid) + khác số phút mồ côi → CÙNG
 *        fingerprint (dedupe xuyên run N2 — crash tái phát bump recurrence,
 *        không nhân bản row).
 *      - 2 họ lỗi shell khác errorTag → fingerprint KHÁC (không false-dedupe).
 *      - orphan sweep 'attempts cạn' ≠ 'stale' (2 nợ riêng, đúng thiết kế).
 *      - tool-failure failCount 3 vs 5 (số nhỏ) → cùng fingerprint.
 */

import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'

const read = (p: string): string => readFileSync(p, 'utf8')

// Pure logic — debt-ledger.ts không có import tĩnh nào (db import động bên
// trong recordDebtIssue) → import an toàn cho unit test, không đụng DB.
const { fingerprintDebtIssue, debtTitleFrom } = await import('../src/lib/execution/debt-ledger')

// ==================== A. SOURCE-SCAN — 3 đường ghi nợ + UI 2 nguồn ====================

describe('R126 A1 · alerts.ts — 6.1a salvage ghi nợ (đường ghi nợ thứ 4)', () => {
  const src = read('src/lib/observation/alerts.ts')

  test('A1.1: salvageCrashedRun gọi recordDebtIssue — ghi TẠI NƠI PHÁT HIỆN, không đợi arbiter/finalize', () => {
    // salvageCrashedRun là điểm dùng chung của 3 caller (runtime orphan-sweep
    // + boot sweeper instrumentation-node) → 1 chỗ chèn phủ đủ cả 3 đường.
    expect(src).toMatch(/salvageCrashedRun[\s\S]{0,6000}recordDebtIssue/)
    expect(src).toContain(`issue: \`Run \${r.agentName ?? r.runId ?? r.id.slice(0, 8)} crashed (salvage)`)
    expect(src).toContain("kind: 'infra'")
    // Bằng chứng gốc kèm checkpoint trung thực (không bịa số)
    expect(src).toContain('salvage row ${r.id}')
  })

  test('A1.2: ghi nợ nằm TRONG cửa !alreadyAlerted — 2 salvage cùng runId (boot sweep + runtime sweep) chỉ ghi 1 lần', () => {
    // isDuplicated/markAlerted là dedup alert 1h theo targetId; cửa này phải
    // chặn cả ghi nợ — nếu không, restart lại sweep sẽ bump recurrence oan.
    const idxAlerted = src.indexOf('if (!alreadyAlerted) {')
    const idxDebt = src.indexOf('recordDebtIssue({')
    expect(idxAlerted).toBeGreaterThan(0)
    expect(idxDebt).toBeGreaterThan(idxAlerted)
    // và cùng khối try của bước (1) — trước `} catch` mở khối chat-trace
    const idxCatch1 = src.indexOf('/* fail-open bước 1 */')
    expect(idxCatch1).toBeGreaterThan(idxDebt)
  })

  test('A1.3: fail-open — ghi nợ không được phép làm hỏng salvage (try/catch riêng)', () => {
    expect(src).toMatch(/recordDebtIssue\(\{[\s\S]{0,600}\}\)\s*\} catch \{ \/\* fail-open — ghi nợ không được phép làm hỏng salvage \*\//)
  })
})

describe('R126 A2 · goal-loop-worker.ts — 6.1b orphan sweep đánh FAIL phải ghi nợ', () => {
  const src = read('src/lib/goal-loop-worker.ts')

  test('A2.1: nhánh STALE (R18 quá trần resume) — recordDebtIssue kèm tuổi job', () => {
    const idxStale = src.indexOf('mark FAILED (stale')
    expect(idxStale).toBeGreaterThan(0)
    const slice = src.slice(idxStale, idxStale + 1400)
    expect(slice).toContain('recordDebtIssue')
    expect(slice).toContain("kind: 'infra'")
    expect(slice).toMatch(/stale \$\{Math\.round\(jobAgeMs/)
    expect(slice).toContain('orphan sweep stale')
  })

  test('A2.2: nhánh ATTEMPTS cạn (≥ max, không retry vô hạn) — recordDebtIssue kèm attempts', () => {
    const idxAttempts = src.indexOf('mark FAILED job ${row.id} — attempts')
    expect(idxAttempts).toBeGreaterThan(0)
    const slice = src.slice(idxAttempts, idxAttempts + 4000)
    expect(slice).toContain('recordDebtIssue')
    expect(slice).toContain("kind: 'infra'")
    expect(slice).toMatch(/attempts \$\{row\.attempts\}\/\$\{GOAL_LOOP_MAX_ATTEMPTS\}/)
  })

  test('A2.3: cả 2 nhánh đều fail-open (ghi nợ không chặn sweep các row còn lại)', () => {
    const matches = src.match(/ghi nợ không được phép chặn sweep/g) ?? []
    expect(matches.length).toBe(2)
  })

  test('A2.4: đường ghi cũ 5710/5755/6258 (qua arbiter/finalize) giữ nguyên — đây là đường THỨ 4, không thay thế', () => {
    // 3 call site cũ trong agent-goal-loop.ts vẫn tồn tại (không bị xóa
    // nhầm khi thêm đường mới — regression chặn "sửa chỗ này hỏng chỗ kia").
    const goal = read('src/lib/agent-goal-loop.ts')
    expect((goal.match(/recordDebtIssue\(/g) ?? []).length).toBeGreaterThanOrEqual(3)
    expect(goal).toContain("kind: 'infra', sessionId: agentSessionId, runId, todoId: infraTodo.id")
    expect(goal).toContain("issue, kind: 'agent', sessionId: agentSessionId, runId, todoId: debtTodo.id")
  })
})

describe('R126 A3 · tool-metrics-recorder.ts — 6.1c tool-failure lặp ≥3 ghi nợ', () => {
  const src = read('src/lib/tool-metrics-recorder.ts')

  test('A3.1: nhánh !success đếm lại ToolMetric cùng (sessionId, toolName) — ngưỡng ≥3', () => {
    expect(src).toContain("if (!params.success) {")
    expect(src).toContain('db.toolMetric.count({ where: { sessionId, toolName, success: false } })')
    expect(src).toContain('if (failCount < 3) return')
    // Mỗi lần fail mới (4th, 5th...) đếm lại ≥3 → gọi lại → bump recurrence (N2)
    expect(src).toMatch(/failCount[\s\S]{0,300}recordDebtIssue/)
  })

  test('A3.2: errorTag nằm trong issue — 2 họ lỗi của cùng tool = 2 nợ riêng (không false-dedupe)', () => {
    expect(src).toContain(`issue: \`Tool \${toolName} thất bại lặp ≥3 lần cùng session — \${errorTag ?? 'không có errorTag'}`)
    expect(src).toContain(`errorTag=\${errorTag ?? '(trống)'}`)
  })

  test("A3.3: sessionId thiếu (unknown) → ghi nợ với sessionId null (không gộp oan mọi session thiếu id)", () => {
    expect(src).toContain("sessionId: sessionId === 'unknown' ? null : sessionId")
  })

  test('A3.4: tạo row ToolMetric vẫn dùng errorTag chuẩn hóa (refactor không đổi hành vi create)', () => {
    expect(src).toContain('const errorTag = params.success ? null : toErrorTag(params.error)')
    expect(src).toContain('errorTag,')
    expect(src).toContain('toolName,')
    expect(src).toContain('sessionId,')
    expect(src).toContain('agentRole,')
  })
})

describe('R126 A4 · page.tsx — 6.2A health timeout + hidden guard', () => {
  const src = read('src/app/page.tsx')

  test('A4.1: /api/health client timeout 20s → 60s (×19 pipe-error khi abort request 45-118s giữa chừng)', () => {
    expect(src).toContain('controller.abort(), 60000')
    expect(src).not.toContain('controller.abort(), 20000')
    expect(src).toContain("'Hết thời gian chờ (60s)'")
    expect(src).not.toContain("'Hết thời gian chờ (20s)'")
  })

  test('A4.2: tab ẩn bỏ poll health (force vẫn chạy — user vừa action)', () => {
    expect(src).toMatch(/fetchHealth = useCallback[\s\S]{0,400}if \(!force && typeof document !== 'undefined' && document\.hidden\)/)
  })

  test('A4.3: fetchDocuments giữ nguyên chính sách abort — chỉ abort khi ĐỔI TRANG (không đụng vào fix cũ)', () => {
    // isPageChange mới được abort — sửa 6.2A không được làm hồi sinh abort-ở-giữa
    expect(src).toContain('if (isPageChange) {')
    expect(src).toContain('fetchDocsAbortRef.current?.abort()')
  })
})

describe('R126 A5 · page.tsx — 6.3 hai nguồn sự thật tài liệu', () => {
  const src = read('src/app/page.tsx')

  test('A5.1: nhóm status uploaded đổi nhãn "Đang chờ" → "R2 uploads (chưa qua pipeline)"', () => {
    expect(src).toContain('R2 uploads (chưa qua pipeline) {uploadedDocs}')
    expect(src).not.toContain('Đang chờ {uploadedDocs}')
    // Tooltip nguồn — người đọc biết con số đến từ listing R2 prefix pdfs/
    expect(src).toContain('Nguồn: listing R2 prefix pdfs/')
  })

  test('A5.2: dòng đối chiếu Qdrant "Đã indexed (Qdrant) {indexed}/{total}"', () => {
    expect(src).toContain('Đã indexed (Qdrant) {qdrantIndexed.indexed}/{qdrantIndexed.total}')
    expect(src).toContain('qdrantIndexed && qdrantIndexed.total > 0')
  })

  test('A5.3: prop qdrantIndexed khai báo + truyền từ dbStats (stats /api/query?action=stats)', () => {
    expect(src).toContain('qdrantIndexed?: { indexed: number; total: number } | null;')
    expect(src).toContain('qdrantIndexed={dbStats ? { indexed: dbStats.documentsByStatus?.')
    expect(src).toContain("total: dbStats.totalDocuments ?? 0 } : null}")
  })
})

// ==================== B. UNIT — fingerprint dedupe xuyên run ====================

describe('R126 B1 · fingerprint — salvage crash lặp (6.1a)', () => {
  test('B1.1: 2 lần salvage khác runId (cuid) + khác số phút mồ côi → CÙNG fingerprint (N2 xuyên run)', () => {
    const a = fingerprintDebtIssue(
      'Run Omega crashed (salvage) — process chết giữa chừng, không finalize được (mồ côi 43 phút)',
    )
    const b = fingerprintDebtIssue(
      'Run Omega crashed (salvage) — process chết giữa chừng, không finalize được (mồ côi 7 phút)',
    )
    expect(a).toBe(b)
    expect(a.length).toBeGreaterThan(8) // recordDebtIssue bỏ qua fp < 8
  })

  test('B1.2: runId dài cuid 25 ký tự → chuẩn hóa thành cid (2 run khác nhau cùng fingerprint); runId ngắn 9-10 ký tự là đặc trưng phân biệt (giữ nguyên)', () => {
    // runId thực tế có 2 dạng: cuid 25 ký tự (bị fingerprint chuẩn hóa thành
    // cid — crash khác nhau cùng họ lỗi bump recurrence) và id ngắn 9-10 ký tự
    // (cmvg25t2z — là đặc trưng phân biệt, 2 run khác nhau = 2 nợ riêng).
    const a = fingerprintDebtIssue('Run cmd0x1a2b3c4d5e6f7a8b9c0d1e2f3 crashed (salvage) — mồ côi 12 phút')
    const b = fingerprintDebtIssue('Run cmd9f8e7d6c5b4a39281706z5y4x3w2v1 crashed (salvage) — mồ côi 90 phút')
    expect(a).toBe(b)
    const c = fingerprintDebtIssue('Run cmvg25t2z crashed (salvage) — mồ côi 12 phút')
    const d = fingerprintDebtIssue('Run cmvhesjf8z crashed (salvage) — mồ côi 90 phút')
    expect(c).not.toBe(d)
  })

  test('B1.3: agent khác nhau → fingerprint KHÁC (Omega crash ≠ ALISTA crash — 2 nợ riêng)', () => {
    const a = fingerprintDebtIssue('Run Omega crashed (salvage) — process chết giữa chừng (mồ côi 43 phút)')
    const b = fingerprintDebtIssue('Run ALISTA crashed (salvage) — process chết giữa chừng (mồ côi 12 phút)')
    expect(a).not.toBe(b)
  })
})

describe('R126 B2 · fingerprint — orphan sweep 2 nhánh (6.1b)', () => {
  test('B2.1: attempts cạn vs stale quá trần → 2 nợ riêng (đúng thiết kế 2 sự cố khác nhau)', () => {
    const attempts = fingerprintDebtIssue(
      'Goal-loop job failed vĩnh viễn (orphan sweep): attempts cạn sau crash server — công việc dở bị hủy, không finalize được',
    )
    const stale = fingerprintDebtIssue(
      'Goal-loop job failed vĩnh viễn (orphan sweep stale): mồ côi quá trần resume, không finalize được — server mất ổn định giữa chừng',
    )
    expect(attempts).not.toBe(stale)
  })

  test('B2.2: cùng nhánh attempts, jobId khác (cuid) → cùng fingerprint (job fail thứ 2 bump recurrence)', () => {
    const a = fingerprintDebtIssue(
      'Goal-loop job failed vĩnh viễn (orphan sweep): attempts cạn sau crash server — job cmvg25p2a001wsnxz7yinyxlc attempts 2/2',
    )
    const b = fingerprintDebtIssue(
      'Goal-loop job failed vĩnh viễn (orphan sweep): attempts cạn sau crash server — job cmvhesjf8z0001wsnxz7yinyxlc attempts 2/2',
    )
    expect(a).toBe(b)
  })

  test('B2.3: số attempts 2 vs 3 (số nhỏ) → cùng fingerprint (trần max-attempts là cấu hình, không phải đặc trưng lỗi)', () => {
    const a = fingerprintDebtIssue('Goal-loop job failed vĩnh viễn (orphan sweep): attempts cạn sau crash server (2 ≥ max 2)')
    const b = fingerprintDebtIssue('Goal-loop job failed vĩnh viễn (orphan sweep): attempts cạn sau crash server (3 ≥ max 3)')
    expect(a).toBe(b)
  })
})

describe('R126 B3 · fingerprint — tool-failure lặp (6.1c)', () => {
  test('B3.1: cùng tool + cùng errorTag, ngưỡng số lần 3 vs 5 (số nhỏ) → cùng fingerprint', () => {
    // Issue thật không chứa failCount (chỉ trong evidence) — nhưng nếu sau
    // này đổi ngưỡng ≥3 → ≥5 thì vẫn phải là CÙNG nợ (ngưỡng là cấu hình).
    const a = fingerprintDebtIssue(
      "Tool shell thất bại lặp ≥3 lần cùng session — /bin/bash: line 1: sqlite3: command not found",
    )
    const b = fingerprintDebtIssue(
      "Tool shell thất bại lặp ≥5 lần cùng session — /bin/bash: line 1: sqlite3: command not found",
    )
    expect(a).toBe(b)
  })

  test('B3.2: cùng tool shell nhưng 2 errorTag khác nhau → fingerprint KHÁC (2 họ lỗi)', () => {
    const a = fingerprintDebtIssue(
      "Tool shell thất bại lặp ≥3 lần cùng session — /bin/bash: line 1: sqlite3: command not found",
    )
    const b = fingerprintDebtIssue(
      "Tool shell thất bại lặp ≥3 lần cùng session — Access denied: path escapes workspace root (/home/z/)",
    )
    expect(a).not.toBe(b)
  })

  test('B3.3: db_query fail ≠ shell fail (tool khác nhau → 2 nợ riêng)', () => {
    const a = fingerprintDebtIssue("Tool db_query thất bại lặp ≥3 lần cùng session — ❌ db_query failed: timeout")
    const b = fingerprintDebtIssue("Tool shell thất bại lặp ≥3 lần cùng session — ❌ db_query failed: timeout")
    expect(a).not.toBe(b)
  })
})

describe('R126 B4 · debtTitleFrom — hiển thị', () => {
  test('B4.1: bỏ prefix Follow-up, giữ nội dung gốc', () => {
    expect(debtTitleFrom('🔁 Follow-up (Omega R17): Run Omega crashed (salvage) — mồ côi 43 phút')).toBe(
      'Run Omega crashed (salvage) — mồ côi 43 phút',
    )
  })
})
