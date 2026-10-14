/**
 * ROUND-102 TESTS — FB-R13DEBT: regression vĩnh viễn cho Sổ nợ DebtLedger (R13 + fix R14)
 * ============================================================================
 *
 * Lý do tồn tại (FB-R13DEBT-R1-04 — THIẾU SÓT C5): cả 5 fix R13 không có test
 * regression nào trong suite ("E2E 12/12" là script dùng-xong-vứt). Fixbug yêu
 * cầu mỗi fix ≥1 pin chứng minh lỗi cũ đã hết. Nhóm test này pin:
 *
 *   A. fingerprint chuẩn hóa (thuần — import hàm thật, không DB):
 *      A1 run1 ≡ run99 (số nhỏ → 'n') · A2 410 ≠ 403 (mã ≥3 chữ số giữ nguyên)
 *      · A3 "lỗi12lần" ≡ "lỗi 12 lần" (FB-R13DEBT-R1-07b — \b ASCII cũ bắt
 *      không được số dính chữ unicode) · A4 2 issue khác sau ký tự 160 → KHÁC
 *      (R1-07a — slice(0,160) cũ gây false-dedupe) · A5 "HTTP 410" ≠ "HTTP
 *      41" (run-approach không xâu '41' trong '410') · A6 debtTitleFrom bỏ prefix.
 *   B. Vòng đời same-session TRÊN DB (chạy qua gate — DB test cô lập):
 *      B1 record → open · B2 pickup claim in_progress attempts=1 ·
 *      B3 HOÀN THÀNH Todo GỐC + trọng tài không re-list → finalize → RESOLVED
 *      (FB-R13DEBT-R1-01 — P1: lookup cũ bỏ sót Todo gốc, nợ same-session
 *      không bao giờ giảm) · B4 reopen từ resolved (recurrence++) ·
 *      B5 park sau đủ attempts + Todo GỐC đánh failed (R1-02a) ·
 *      B6 sau park: directive KHÔNG còn liệt kê trong "ƯU TIÊN XỬ LÝ" —
 *      chuyển sang ghi-chú "ĐÃ PARK" (R1-02b) · B7 parked không được claim lại.
 *   C. GLOBAL pickup: cap theo env (mặc định 2) — 3 debt cũ >30' → ≤2 claimed.
 *   D. Claim có điều kiện cạnh tranh (R1-05): updateMany + status — source pin
 *      (race thật không pin deterministic được — precedent BUG2-210).
 *   E. PATCH validate (R1-06): typeof non-string → 400; reopen khi open/
 *      in_progress → 400; park resolved → 400 (behavioral qua route thật).
 *   F. Kill-switch fallback (R1-03): source pin — DEBT_LEDGER=0 vẫn dựng block
 *      same-session legacy (comment module hứa; behavioral cần env per-process
 *      không pin được trong cùng file).
 *
 * Nguyên tắc: DB test qua gate (DATABASE_URL ghi đè — không đụng db/custom.db);
 * mọi row test đánh dấu sessionId/id duy nhất 'r102-…' + dọn sạch finally.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  fingerprintDebtIssue,
  debtTitleFrom,
  recordDebtIssue,
  pickupDebtForRun,
  finalizeDebtAfterRun,
  DEBT_GLOBAL_PICKUP_LIMIT,
  DEBT_MAX_PICKUP_ATTEMPTS,
} from '@/lib/execution/debt-ledger'
import { db } from '@/lib/db'

const readSrc = (rel: string): string => readFileSync(join(process.cwd(), rel), 'utf-8')

/** Marker duy nhất theo thời gian — tránh đụng data thật của DB test. */
const RUN_TAG = `r102-${Date.now().toString(36)}`
const SESS_A = `sess-${RUN_TAG}-a`   // session có Todo gốc
const SESS_B = `sess-${RUN_TAG}-b`   // session pickup GLOBAL
const createdTodoIds: string[] = []

/** R2-02c: session C (pickup global) cũng phải dọn — mirror todo của C1 tạo
 * trong session này; bản cũ chỉ dọn A/B → leak 2 row/lần chạy. */
const SESS_C = () => `sess-${RUN_TAG}-c`
async function cleanup(): Promise<void> {
  try {
    if (createdTodoIds.length > 0) await db.todo.deleteMany({ where: { id: { in: [...createdTodoIds] } } }).catch(() => {})
    await db.todo.deleteMany({ where: { sessionId: { in: [SESS_A, SESS_B, SESS_C()] } } }).catch(() => {})
    await db.debtLedger.deleteMany({ where: { OR: [{ originSessionId: SESS_A }, { originSessionId: SESS_B }] } }).catch(() => {})
  } catch { /* dọn tối đa */ }
}

/** Tạo 1 Todo follow-up (giống 3 đường ghi agent-goal-loop) + nợ tương ứng. */
async function seedDebt(suffix: string, issueText: string): Promise<{ todoId: string }> {
  const todo = await db.todo.create({
    data: {
      sessionId: SESS_A,
      runId: `run-${RUN_TAG}-0`,
      content: `🔁 Follow-up (trọng tài R102 ${suffix}): ${issueText}`,
      status: 'pending',
      taskMetaJson: JSON.stringify({ source: 'arbiter_side_issue', cycle: 1, debtDecision: 'continue' }),
    },
  })
  createdTodoIds.push(todo.id)
  await recordDebtIssue({
    kind: 'infra',
    issue: todo.content,
    sessionId: SESS_A,
    runId: `run-${RUN_TAG}-0`,
    todoId: todo.id,
  })
  return { todoId: todo.id }
}

describe('R102 · A. fingerprint chuẩn hóa (thuần)', () => {
  test('A1 — run 1 ≡ run 99 (số nhỏ → n); 410 ≠ 403 (mã ≥3 chữ số giữ)', () => {
    const a = fingerprintDebtIssue('Lỗi infra run 1: path-escape workspace root ở run 7')
    const b = fingerprintDebtIssue('Lỗi infra run 99: path-escape workspace root ở run 12')
    expect(a).toBe(b) // số 1-2 chữ số là noise — cùng một lỗi
    expect(fingerprintDebtIssue('HTTP 410 ModelDeprecated từ provider')).not.toBe(fingerprintDebtIssue('HTTP 403 FreeTierError từ provider'))
  })

  test('A2 — FB-R13DEBT-R1-07b: "lỗi12lần" ≡ "lỗi 12 lần" (\\b ASCII cũ bắt không được)', () => {
    expect(fingerprintDebtIssue('SQLite busy lỗi12lần ở chu kỳ cuối')).toBe(fingerprintDebtIssue('SQLite busy lỗi 12 lần ở chu kỳ cuối'))
  })

  test('A3 — FB-R13DEBT-R1-07a: 2 issue khác nhau SAU ký tự 160 → KHÁC fingerprint (hết false-dedupe)', () => {
    const pad = 'x'.repeat(170)
    const t1 = `Lỗi hạ tầng A ${pad} BIẾN THỨ NHẤT`
    const t2 = `Lỗi hạ tầng A ${pad} BIẾN THỨ HAI`
    expect(t1.slice(0, 160)).toBe(t2.slice(0, 160)) // tiền đề: cũ slice(160) sẽ trùng
    expect(fingerprintDebtIssue(t1)).not.toBe(fingerprintDebtIssue(t2))
  })

  test('A4 — run-approach: "HTTP 410" giữ nguyên (không xâu "41"→"n" thành "HTTP n0")', () => {
    const fp = fingerprintDebtIssue('provider trả HTTP 410 deprecated')
    expect(fp).toContain('410')
    expect(fp).not.toMatch(/\bn0\b| 4n | n0/)
    // 3+ chữ số là 1 run → giữ nguyên, 1-2 chữ số lẻ cũng không sót
    // (R2-02a: pin thật thay assert tự-satisfied cũ)
    expect(fingerprintDebtIssue('exit code 1')).toContain('exit code n')
    // R2-02d: 410 ≠ 41 (run 2 chữ số → n; không xâu '41' từ '410')
    expect(fingerprintDebtIssue('HTTP 410')).not.toBe(fingerprintDebtIssue('HTTP 41'))
  })

  test('A5 — debtTitleFrom bỏ prefix Follow-up', () => {
    expect(debtTitleFrom('🔁 Follow-up (trọng tài GĐ3): Sửa lỗi X')).toBe('Sửa lỗi X')
  })
})

describe('R102 · B. Vòng đời same-session (DB qua gate)', () => {
  beforeAll(async () => { await cleanup() })
  afterAll(async () => { await cleanup() })

  test('B0 — R15-R1-01: production path (a) directiveBlock ĐỦ 4 MỤC như legacy (1 nguồn format)', async () => {
    // Pin hành vi cho fix auditor R15-R1-01: trước đây path (a) (DEBT_LEDGER=1
    // — production) dựng block inline riêng THIẾU mục 4 "Hết nợ mới làm việc
    // mới" + vùng bảo vệ ở mục 3, trong khi kill-switch fallback đủ 4 mục —
    // nghịch lý chế độ hiếm đầy đủ hơn chế độ chính (lớp BUG2-253).
    // Giờ cả 2 đường cùng formatDebtDirectiveBlock — pin này chặn lệch lại.
    const { todoId } = await seedDebt('B0', `Lỗi B0 ${RUN_TAG}: directive thiếu mục 4 thời kỳ trước R15`)
    void todoId
    const pick = await pickupDebtForRun({ sessionId: SESS_A, currentRunId: `run-${RUN_TAG}-b0` })
    expect(pick.directiveBlock).toContain('ƯU TIÊN XỬ LÝ TRƯỚC VIỆC MỚI')
    expect(pick.directiveBlock).toContain('sổ cái DebtLedger ON')
    expect(pick.directiveBlock).toContain('3. Mục nào vẫn nằm ngoài quyền sửa')
    expect(pick.directiveBlock).toContain('phần hạ tầng VẪN ĐƯỢC BẢO VỆ')
    expect(pick.directiveBlock).toContain('4. Hết nợ mới làm việc mới của yêu cầu hiện tại.')
    // Dọn nợ B0 để không nhiễu các test sau (park qua finalize đường thường)
    await db.todo.deleteMany({ where: { id: todoId } }).catch(() => {})
    await db.debtLedger.deleteMany({ where: { fingerprint: fingerprintDebtIssue(`🔁 Follow-up (trọng tài R102 B0): Lỗi B0 ${RUN_TAG}: directive thiếu mục 4 thời kỳ trước R15`) } }).catch(() => {})
  })

  test('B1→B3 — FB-R13DEBT-R1-01 (P1): hoàn thành Todo GỐC → nợ RESOLVED (lookup cũ bỏ sót Todo gốc)', async () => {
    // B1: ghi nợ + Todo gốc pending
    const { todoId } = await seedDebt('P1', `Lỗi hạ tầng ${RUN_TAG}: HTTP 410 ModelDeprecated từ provider zen`)
    const fp = fingerprintDebtIssue(`🔁 Follow-up (trọng tài R102 P1): Lỗi hạ tầng ${RUN_TAG}: HTTP 410 ModelDeprecated từ provider zen`)
    const row1 = await db.debtLedger.findUnique({ where: { fingerprint: fp } })
    expect(row1?.status).toBe('open')

    // B2: pickup run mới cùng session → claim in_progress attempts=1
    const pick = await pickupDebtForRun({ sessionId: SESS_A, currentRunId: `run-${RUN_TAG}-1` })
    const hit = pick.picked.find(p => p.origin === 'session')
    expect(hit).toBeTruthy()
    expect(hit?.mirrorTodoId).toBe(todoId) // same-session: mirror chính là Todo gốc
    const row2 = await db.debtLedger.findUnique({ where: { fingerprint: fp } })
    expect(row2?.status).toBe('in_progress')
    expect(row2?.attempts).toBe(1)

    // B3: agent hoàn thành Todo GỐC (taskMeta KHÔNG có debtLedgerId — đúng như
    // 3 đường ghi thật) + trọng tài KHÔNG re-list → finalize → RESOLVED.
    // Đây là pin cho P1: lookup cũ (taskMetaJson contains) không bao giờ match
    // Todo gốc → nợ same-session kẹt open vĩnh viễn / park oan.
    await db.todo.update({ where: { id: todoId }, data: { status: 'completed' } })
    const fin = await finalizeDebtAfterRun({
      runId: `run-${RUN_TAG}-1`,
      sessionId: SESS_A,
      unresolvedDebtTexts: [],
    })
    expect(fin.resolved).toBe(1)
    expect(fin.resolvedTitles.some(t => t.includes('HTTP 410'))).toBe(true)
    const row3 = await db.debtLedger.findUnique({ where: { fingerprint: fp } })
    expect(row3?.status).toBe('resolved')
    expect(row3?.resolvedByRunId).toBe(`run-${RUN_TAG}-1`)

    // B4: tái phát (record lại cùng fingerprint) → reopen + recurrence=1+1=2
    await recordDebtIssue({
      kind: 'infra',
      issue: `🔁 Follow-up (trọng tài R102 P1-redux): Lỗi hạ tầng ${RUN_TAG}: HTTP 410 ModelDeprecated từ provider zen`,
      sessionId: SESS_A,
      runId: `run-${RUN_TAG}-2`,
    })
    const row4 = await db.debtLedger.findUnique({ where: { fingerprint: fp } })
    expect(row4?.status).toBe('open')
    // recurrence đếm LƯỢT TÁI PHÁT sau resolved: record đầu = 0, tái phát
    // sau resolve lần 1 → increment 1 (create không set — kỳ vọng ≥1, không
    // phải ≥2: lần đầu là occurrence chứ không phải recurrence).
    expect(row4?.recurrenceCount).toBeGreaterThanOrEqual(1)
  })

  test('B5 — park sau đủ attempts + Todo GỐC đánh failed (FB-R13DEBT-R1-02a)', async () => {
    const { todoId } = await seedDebt('P2', `Lỗi khác ${RUN_TAG}: SQLITE_BUSY khi ghi qEntry cuối run`)
    const fp = fingerprintDebtIssue(`🔁 Follow-up (trọng tài R102 P2): Lỗi khác ${RUN_TAG}: SQLITE_BUSY khi ghi qEntry cuối run`)
    // DEBT_MAX_PICKUP_ATTEMPTS lần pickup+finalize KHÔNG hoàn thành todo.
    // R2-02b: unresolvedDebtTexts phải KHỚP fingerprint debt (dùng nguyên văn
    // content todo — có prefix Follow-up) — bản cũ truyền text rút gọn →
    // isRelisted=false oan, nhánh parkReason "vẫn bị re-list" không được exercise.
    const todoRow = await db.todo.findFirst({ where: { sessionId: SESS_A }, orderBy: { createdAt: 'desc' } })
    const unresolved = [todoRow?.content ?? '']
    for (let i = 1; i <= DEBT_MAX_PICKUP_ATTEMPTS; i++) {
      await pickupDebtForRun({ sessionId: SESS_A, currentRunId: `run-${RUN_TAG}-p${i}` })
      // trọng tài vẫn re-list (chưa xong) — mirror chưa completed
      await finalizeDebtAfterRun({
        runId: `run-${RUN_TAG}-p${i}`,
        sessionId: SESS_A,
        unresolvedDebtTexts: unresolved,
      })
    }
    // parkReason phải qua nhánh "vẫn bị re-list" (isRelisted=true)
    const parkedRow = await db.debtLedger.findUnique({ where: { fingerprint: fingerprintDebtIssue(unresolved[0]) } })
    expect(parkedRow?.parkReason ?? '').toContain('vẫn bị re-list')
    const row = await db.debtLedger.findUnique({ where: { fingerprint: fp } })
    expect(row?.status).toBe('parked')
    expect(row?.parkReason ?? '').toContain('đã thử')
    // Todo GỐC (đường same-session) cũng failed — không bị pickup lặp
    const orig = await db.todo.findUnique({ where: { id: todoId } })
    expect(orig?.status).toBe('failed')
  })

  test('B6+B7 — park qua PATCH (đường user — Todo vẫn mở): KHÔNG re-list "ƯU TIÊN XỬ LÝ"; ghi-chú ĐÃ PARK (R1-02b)', async () => {
    // Park qua finalize (B5) đã đánh Todo gốc failed → không bao giờ vào
    // same-session query. Nhánh parkedNotes phục vụ đúng đường PATCH (user/
    // thầy park thủ công — KHÔNG đụng todo): todo vẫn pending nhưng debt đã
    // parked → phải ra khỏi khối ưu tiên, sang ghi-chú.
    const { PATCH } = await import('@/app/api/debt/status/route')
    type NextRequestLike = Parameters<typeof PATCH>[0]
    const mkReq = (body: unknown): NextRequestLike =>
      new Request('http://x/api/debt/status', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) as unknown as NextRequestLike
    const { todoId } = await seedDebt('P3', `Lỗi P3 ${RUN_TAG}: socket timeout khi upsert dailyTokenUsage`)
    const fp3 = fingerprintDebtIssue(`🔁 Follow-up (trọng tài R102 P3): Lỗi P3 ${RUN_TAG}: socket timeout khi upsert dailyTokenUsage`)
    const rowBefore = await db.debtLedger.findUnique({ where: { fingerprint: fp3 } })
    expect(rowBefore?.status).toBe('open')
    // PATCH park (từ open — hợp lệ) → todo VẪN pending
    const rPark = await PATCH(mkReq({ id: rowBefore?.id, action: 'park', reason: 'r102 test parkedNotes' }))
    expect(rPark.status).toBe(200)
    const orig = await db.todo.findUnique({ where: { id: todoId } })
    expect(orig?.status).toBe('pending') // PATCH không đánh failed — nhánh parkedNotes phải tự xử

    const pick = await pickupDebtForRun({ sessionId: SESS_A, currentRunId: `run-${RUN_TAG}-after` })
    // KHÔNG claim lại: picked không chứa debt parked; attempts không tăng
    const pickedRows = await Promise.all(pick.picked.map(p => db.debtLedger.findUnique({ where: { id: p.debtLedgerId } })))
    expect(pickedRows.some(r => r?.status === 'parked')).toBe(false)
    const rowAfter = await db.debtLedger.findUnique({ where: { fingerprint: fp3 } })
    expect(rowAfter?.attempts).toBe(rowBefore?.attempts) // không tăng thêm
    // Directive: ghi-chú ĐÃ PARK; KHÔNG có khối ƯU TIÊN XỬ LÝ (actionable=0 —
    // mọi todo follow-up còn mở đều trỏ debt parked); issue không nằm trong
    // bất kỳ khối ưu tiên nào
    expect(pick.directiveBlock).toContain('ĐÃ PARK')
    expect(pick.directiveBlock).not.toContain('ƯU TIÊN XỬ LÝ TRƯỚC VIỆC MỚI')
    // Issue text chỉ được phép xuất hiện trong ghi-chú thông tin (kèm "ĐÃ
    // PARK … KHÔNG thử lại") — không nằm trong khối ưu tiên nào (đã assert
    // vắng 'ƯU TIÊN XỬ LÝ' ở trên).
    expect(pick.directiveBlock).toContain('KHÔNG thử lại trong run này')
  })
})

describe('R102 · C. GLOBAL pickup cap (DB qua gate)', () => {
  beforeAll(async () => { await cleanup() })
  afterAll(async () => { await cleanup() })

  test(`C1 — 3 debt cũ >30' + 2 debt mới → global claimed ≤ DEBT_GLOBAL_PICKUP_LIMIT (${DEBT_GLOBAL_PICKUP_LIMIT})`, async () => {
    // 3 debt từ session khác, lastSeenAt > 30' cũ
    for (let i = 1; i <= 3; i++) {
      const todo = await db.todo.create({
        data: {
          sessionId: SESS_B,
          runId: `run-${RUN_TAG}-g${i}`,
          content: `🔁 Follow-up (global ${RUN_TAG}-${i}): Lỗi global ${i} HTTP ${400 + i} từ provider test`,
          status: 'pending',
        },
      })
      createdTodoIds.push(todo.id)
      await recordDebtIssue({
        kind: 'infra',
        issue: todo.content,
        sessionId: SESS_B,
        runId: `run-${RUN_TAG}-g${i}`,
        todoId: todo.id,
      })
      // làm giàu tuổi: lastSeenAt lùi >30' để qua min-age
      const fp = fingerprintDebtIssue(todo.content)
      await db.debtLedger.update({
        where: { fingerprint: fp },
        data: { lastSeenAt: new Date(Date.now() - 45 * 60 * 1000) },
      }).catch(() => {})
    }
    const pick = await pickupDebtForRun({ sessionId: SESS_C(), currentRunId: `run-${RUN_TAG}-gc` })
    const globals = pick.picked.filter(p => p.origin === 'global')
    expect(globals.length).toBeLessThanOrEqual(DEBT_GLOBAL_PICKUP_LIMIT)
    expect(globals.length).toBeGreaterThan(0)
    expect(pick.directiveBlock).toContain('NỢ KỸ THUẬT TOÀN HỆ THỐNG')
  })
})

describe('R102 · D-F. Source pins (race + PATCH + kill-switch)', () => {
  test('D1 — FB-R13DEBT-R1-05: claim có điều kiện cạnh tranh (updateMany + status + increment)', () => {
    const src = readSrc('src/lib/execution/debt-ledger.ts')
    expect(src).toContain('const claimed = await db.debtLedger.updateMany({')
    expect(src).toContain('if (!claimed || claimed.count !== 1) continue')
    expect(src).toContain("attempts: { increment: 1 }")
    expect(src).toContain("recurrenceCount: { increment: 1 }")
  })

  test('E1 — FB-R13DEBT-R1-06: PATCH validate — behavioral qua route thật', async () => {
    const { PATCH } = await import('@/app/api/debt/status/route')
    type NextRequestLike = Parameters<typeof PATCH>[0]
    const mkReq = (body: unknown): NextRequestLike => {
      return new Request('http://x/api/debt/status', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }) as unknown as NextRequestLike
    }
    // non-string id → 400 (cũ: TypeError 500)
    const r1 = await PATCH(mkReq({ id: 123, action: 'resolve' }))
    expect(r1.status).toBe(400)
    // reopen debt đang open → 400 (cũ: reset lastAttemptRunId của run đang chạy)
    const { todoId } = await seedDebt('E1', `Lỗi E1 ${RUN_TAG}: EACCES khi ghi file workspace`)
    const fp = fingerprintDebtIssue(`🔁 Follow-up (trọng tài R102 E1): Lỗi E1 ${RUN_TAG}: EACCES khi ghi file workspace`)
    const row = await db.debtLedger.findUnique({ where: { fingerprint: fp } })
    expect(row?.status).toBe('open')
    const r2 = await PATCH(mkReq({ id: row?.id, action: 'reopen' }))
    expect(r2.status).toBe(400)
    // resolve hợp lệ → 200
    const r3 = await PATCH(mkReq({ id: row?.id, action: 'resolve', reason: 'test r102' }))
    expect(r3.status).toBe(200)
    // park debt đã resolved → 400
    const r4 = await PATCH(mkReq({ id: row?.id, action: 'park' }))
    expect(r4.status).toBe(400)
    // reopen từ resolved → 200 + attempts reset
    const r5 = await PATCH(mkReq({ id: row?.id, action: 'reopen' }))
    expect(r5.status).toBe(200)
    const after = await db.debtLedger.findUnique({ where: { fingerprint: fp } })
    expect(after?.status).toBe('open')
    expect(after?.attempts).toBe(0)
    void todoId
    await cleanup()
  })

  test('F1 — FB-R13DEBT-R1-03: kill-switch fallback same-session legacy (source pin)', () => {
    const src = readSrc('src/lib/execution/debt-ledger.ts')
    expect(src).toContain('if (!DEBT_LEDGER_ENABLED) {')
    expect(src).toContain('chế độ legacy')
    // comment module hứa "hành vi y hệt trước R13" giờ THẬT: block same-session
    // dựng bằng buildLegacyPendingDebtBlock — HÀM DUY NHẤT dùng chung với
    // production path (a) qua formatDebtDirectiveBlock (R15-R1-01); không
    // import ngược agent-goal-loop (tránh chu trình)
    expect(src).not.toContain("await import('@/lib/agent-goal-loop')")
    // R15 (P-R13-1 + BUG2-253 reopening): fallback giờ gọi HÀM DUY NHẤT
    // buildLegacyPendingDebtBlock — pin nội dung ĐỦ 4 MỤC (bản R14 ghi "đã
    // fix" trong biên bản nhưng code commit thực tế thiếu mục 3-4 — pin yếu
    // cũ không bắt được; pin này chặn lặp lại).
    expect(src).toContain('await buildLegacyPendingDebtBlock(params.sessionId, params.currentRunId')
    expect(src).toContain('3. Mục nào vẫn nằm ngoài quyền sửa')
    expect(src).toContain('4. Hết nợ mới làm việc mới của yêu cầu hiện tại.')
    // single-source: agent-goal-loop KHÔNG còn export buildPendingDebtBlock
    const agl = readSrc('src/lib/agent-goal-loop.ts')
    expect(agl).not.toContain('export async function buildPendingDebtBlock')
  })

  test('F2 — FB-R13DEBT-R1-08: sweeper có đồng hồ riêng tại module-load', () => {
    const src = readSrc('src/lib/execution/debt-ledger.ts')
    expect(src).toContain('setTimeout(() => { void maybeSweepStaleTodos().catch(() => {}) }, 5_000)')
    expect(src).toContain('sweepTimer.unref?.()')
  })
})
