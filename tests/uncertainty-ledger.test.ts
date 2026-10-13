// ============================================================================
// TEST SUITE — UNCERTAINTY LEDGER (phản chiếu trong quy trình) + RICH RUN
// SUMMARY (tên tool sau reload) + PROBLEM-HINT (Flaw→Resolver) — 2026-10-22
// ============================================================================
// Chạy: cd /home/z/tmo-app && DATABASE_URL=file:/home/z/tmo-app/db/custom.db \
//        bun run tests/uncertainty-ledger.test.ts
//
// Bối cảnh user directive 2026-10-22:
//  (1) "xác định biên độ dữ liệu và tự phản chiếu là năng lực nằm trong quy
//      trình xử lý chứ không phải ở trong 1 báo cáo nghiệm thu" → ledger ❓
//      sống theo run (parse → RunContext → render directive → aging warning).
//  (2) "không thấy tên tool được gọi, chỉ có ký hiệu" → tool event persist
//      ĐẦY ĐỦ trường (tool/args/ok/dur/result) trong ChatMessage metadata.
//  (3) Flaw→Resolver (SDA_ENT_054/055): todo failed/blocked → hint quy trình.
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

import {
  parseUncertainItems, mergeUncertainLedger, renderUncertainLedgerBlock,
  upsertRunContext, getRunContext,
  UNCERTAIN_LEDGER_MAX, UNCERTAIN_MATCH_JACCARD,
} from '../src/lib/structured-hypothesis'
import { todoWrite } from '../src/lib/code-team/dev-tools'
import { buildAgentRunSummaryForMessage } from '../src/lib/goal-loop-finalize'
import {
  startAgentRun, endAgentRun, recordAgentRunTool, recordAgentThought,
} from '../src/lib/agent-run-tracker'
import { db } from '../src/lib/db'

const TS = Date.now()
const SID = `test-unc-${TS}`
const RUN = `test-run-unc-${TS}`
const SID2 = `test-sum-${TS}`

let pass = 0, fail = 0
const fails: string[] = []
function ok(name: string, cond: boolean, detail = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; fails.push(name); console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`) }
}

async function cleanup() {
  await db.runContext.deleteMany({ where: { sessionId: { in: [SID, SID2] } } }).catch(() => null)
  await db.todo.deleteMany({ where: { sessionId: { in: [SID, SID2] } } }).catch(() => null)
  await db.agentRunRecord.deleteMany({ where: { sessionId: SID2 } }).catch(() => null)
}

// ==================== A. parseUncertainItems — pure ====================
console.log('\n━━━ A. parseUncertainItems (trích mục ❓ từ báo cáo) ━━━')

const report1 = `BÁO CÁO chu kỳ 1
Đã làm gì: đọc file X, sửa module Y.
✅ Đã CHẮC CHẮN (có bằng chứng tool): file X tồn tại (file_read trả nội dung); module Y đã sửa (file_read đọc lại khớp).
❓ Còn CHƯA CHẮC (giả thuyết cần kiểm tra ở chu kỳ sau): liệu schema Z đã có bảng W; liệu hàm Q xử lý đúng trường hợp rỗng
Còn thiếu: kiểm thử.`

const items1 = parseUncertainItems(report1)
ok('A1 trích được 2 mục từ dòng ❓ (tách theo ";")', items1.length === 2, JSON.stringify(items1))
ok('A2 mục 1 đúng nội dung', items1[0].includes('schema Z') && items1[0].includes('bảng W'), items1[0])
ok('A3 mục 2 đúng nội dung', items1[1].includes('hàm Q'), items1[1])

const reportNoUncertain = `Báo cáo không có gì сомневаюсь — chỉ ✅ Đã CHẮC CHẮN: mọi thứ xong.`
ok('A4 không có dòng ❓ → mảng rỗng', parseUncertainItems(reportNoUncertain).length === 0)
ok('A5 report rỗng → mảng rỗng', parseUncertainItems('').length === 0)

// Decoy: ❓ xuất hiện trong văn bản khác (không phải dòng REFLECT) nhưng CŨNG
// có dòng REFLECT thật → phải ưu tiên dòng có "chưa chắc"
const reportDecoy = `Todo: kiểm tra ❓ vấn đề A trong BELIEF-STATE
❓ Còn CHƯA CHẮC (giả thuyết cần kiểm tra ở chu kỳ sau): cơ chế cache có tự vô hiệu sau TTL không`
const itemsDecoy = parseUncertainItems(reportDecoy)
ok('A6 ưu tiên dòng ❓ có "chưa chắc" (bỏ decoy)', itemsDecoy.length === 1 && itemsDecoy[0].includes('cache'), JSON.stringify(itemsDecoy))

// Cap 3 mục
const reportMany = `❓ Còn CHƯA CHẮC: mục một còn nghi; mục hai còn nghi; mục ba còn nghi; mục bốn còn nghi; mục năm`
const itemsMany = parseUncertainItems(reportMany)
ok('A7 cap tối đa ' + UNCERTAIN_LEDGER_MAX + ' mục', itemsMany.length === UNCERTAIN_LEDGER_MAX, JSON.stringify(itemsMany))
ok('A8 mỗi mục ≤200 ký tự', itemsMany.every(i => i.length <= 200))

// ==================== B. mergeUncertainLedger — pure ====================
console.log('\n━━━ B. mergeUncertainLedger (aging xuyên chu kỳ) ━━━')

const j1 = mergeUncertainLedger(null, ['cơ chế cache TTL có tự vô hiệu không'], 1)
const p1 = JSON.parse(j1) as Array<{ text: string; firstSeenCycle: number }>
ok('B1 ledger mới: firstSeenCycle = chu kỳ hiện tại', p1.length === 1 && p1[0].firstSeenCycle === 1, j1)

// Cùng mục lặp lại chu kỳ 2 (jaccard ≥ ngưỡng) → giữ firstSeenCycle=1
const j2 = mergeUncertainLedger(j1, ['cơ chế cache TTL có tự vô hiệu không'], 2)
const p2 = JSON.parse(j2) as Array<{ text: string; firstSeenCycle: number }>
ok('B2 mục trùng (Jaccard ≥' + UNCERTAIN_MATCH_JACCARD + ') kế thừa firstSeenCycle=1', p2[0].firstSeenCycle === 1, j2)

// Chu kỳ 3 vẫn treo → firstSeenCycle giữ 1 (tuổi 2 chu kỳ)
const j3 = mergeUncertainLedger(j2, ['cơ chế cache TTL có tự vô hiệu không'], 3)
const p3 = JSON.parse(j3) as Array<{ text: string; firstSeenCycle: number }>
ok('B3 mục treo chu kỳ 3 vẫn giữ firstSeenCycle=1', p3[0].firstSeenCycle === 1, j3)

// Mục MỚI unrelated → firstSeenCycle = chu kỳ hiện tại
const j4 = mergeUncertainLedger(j1, ['hàm Q xử lý đúng input rỗng chưa kiểm chứng'], 2)
const p4 = JSON.parse(j4) as Array<{ text: string; firstSeenCycle: number }>
ok('B4 mục mới unrelated → firstSeenCycle=2', p4[0].firstSeenCycle === 2, j4)

// Báo cáo không còn ❓ → ledger sạch "[]" (latest-state-wins như 📐)
const j5 = mergeUncertainLedger(j1, [], 2)
ok('B5 hết mục ❓ → ledger rỗng "[]"', j5 === '[]', j5)

// JSON prev hỏng → coi như trống, không throw
const j6 = mergeUncertainLedger('not-json{{{', ['mục mới sau json hỏng'], 4)
const p6 = JSON.parse(j6) as Array<{ text: string; firstSeenCycle: number }>
ok('B6 JSON hỏng không throw → ledger mới sạch', p6.length === 1 && p6[0].firstSeenCycle === 4, j6)

// ==================== C. renderUncertainLedgerBlock — pure ====================
console.log('\n━━━ C. renderUncertainLedgerBlock (directive chu kỳ sau) ━━━')

ok('C1 ledger rỗng → block rỗng', renderUncertainLedgerBlock(null, 2) === '' && renderUncertainLedgerBlock('[]', 2) === '' && renderUncertainLedgerBlock('hỏng{', 2) === '')

const block1 = renderUncertainLedgerBlock(j1, 2) // mục firstSeen=1, hiện tại chu kỳ 2 → tuổi 1
ok('C2 block chứa tiêu đề + nội dung mục', block1.includes('❓ CÒN CHƯA CHẮC') && block1.includes('cache'), block1)
ok('C3 tuổi 1 chu kỳ → ghi "chưa kiểm chứng từ chu kỳ 1"', block1.includes('chưa kiểm chứng từ chu kỳ 1'), block1)
ok('C4 tuổi 1 chu kỳ → CHƯA cảnh báo ⚠️', !block1.includes('⚠️'), block1)

const block2 = renderUncertainLedgerBlock(j3, 3) // mục firstSeen=1, hiện tại 3 → tuổi 2
ok('C5 tuổi ≥2 chu kỳ → cảnh báo ⚠️ ưu tiên', block2.includes('⚠️') && block2.includes('≥2 chu kỳ'), block2)

// ==================== D. RunContext roundtrip (DB) ====================
console.log('\n━━━ D. RunContext.uncertainItems — persist + preserve-on-null ━━━')

await upsertRunContext({ runId: RUN, sessionId: SID, dataScope: 'cần đọc schema.prisma · ngoài phạm vi: UI', uncertainItems: j1 })
const ctx1 = await getRunContext(RUN)
ok('D1 upsert → đọc lại đúng ledger', ctx1?.uncertainItems === j1, JSON.stringify(ctx1?.uncertainItems))
ok('D2 dataScope cùng persist', ctx1?.dataScope?.includes('schema.prisma') === true)

// Upsert KHÔNG truyền uncertainItems (short-report path) → KHÔNG đè (preserve)
await upsertRunContext({ runId: RUN, sessionId: SID, goalDigest: 'mục tiêu test' })
const ctx2 = await getRunContext(RUN)
ok('D3 preserve-on-null: không truyền → giữ nguyên ledger', ctx2?.uncertainItems === j1, JSON.stringify(ctx2?.uncertainItems))

// Upsert với "[]" → clean (latest-state-wins)
await upsertRunContext({ runId: RUN, sessionId: SID, uncertainItems: '[]' })
const ctx3 = await getRunContext(RUN)
ok('D4 truyền "[]" → ledger sạch', ctx3?.uncertainItems === '[]', JSON.stringify(ctx3?.uncertainItems))

// ==================== E. buildAgentRunSummaryForMessage — tool event ĐẦY ĐỦ ====================
console.log('\n━━━ E. Run summary sau reload: TÊN TOOL + args + ✓/✗ + kết quả ━━━')

const runId2 = startAgentRun({ sessionId: SID2, agentName: 'TEST-AGENT', task: 'test rich summary', dbPersistBy: 'caller' })
ok('E1 startAgentRun trả runId', typeof runId2 === 'string' && !!runId2)

recordAgentThought(SID2, 'Đang phân tích file cấu hình để xác định biên độ dữ liệu', 1)
recordAgentRunTool(SID2, {
  tool: 'file_read',
  argsSummary: 'path: prisma/schema.prisma',
  success: true,
  durationMs: 1234,
  resultPreview: 'model RunContext {\n  uncertainItems String?\n}',
  iteration: 1,
}, runId2 || undefined)
recordAgentRunTool(SID2, {
  tool: 'shell',
  argsSummary: 'cmd: bun run typecheck',
  success: false,
  durationMs: 5678,
  resultPreview: 'error TS2322: Type mismatch',
  iteration: 2,
}, runId2 || undefined)
endAgentRun(SID2, runId2, 'done', 'hoàn thành test')

const summary = buildAgentRunSummaryForMessage(SID2, runId2)
ok('E2 summary tạo được', !!summary)
if (summary) {
  const toolEvents = summary.events.filter(e => e.type === 'tool')
  ok('E3 có 2 tool event', toolEvents.length === 2, JSON.stringify(toolEvents))
  const eRead = toolEvents.find(e => e.tool === 'file_read')
  ok('E4 tool event mang TÊN TOOL (file_read)', !!eRead && eRead.tool === 'file_read')
  ok('E5 mang args', eRead?.args === 'path: prisma/schema.prisma', JSON.stringify(eRead))
  ok('E6 mang ok=true + dur', eRead?.ok === true && eRead?.dur === 1234, JSON.stringify(eRead))
  ok('E7 mang result preview', !!eRead?.result && eRead.result.includes('uncertainItems'), JSON.stringify(eRead?.result))
  ok('E8 text tổng hợp chứa tên tool (backward compat)', eRead?.text.includes('file_read') === true, eRead?.text)
  const eShell = toolEvents.find(e => e.tool === 'shell')
  ok('E9 tool fail: ok=false + result lỗi', eShell?.ok === false && eShell?.result?.includes('TS2322') === true, JSON.stringify(eShell))
  const thought = summary.events.find(e => e.type === 'thought')
  ok('E10 thought event giữ nguyên text', !!thought && thought.text.includes('biên độ dữ liệu'), thought?.text)
  ok('E11 thought event KHÔNG có field tool', thought?.tool === undefined)
}

// ==================== F. todoWrite problemHint (Flaw→Resolver) ====================
console.log('\n━━━ F. todoWrite — hint xử lý vấn đề khi todo failed/blocked ━━━')

const w1 = await todoWrite({
  sessionId: SID, runId: RUN, agentRole: 'TEST',
  todos: [
    { content: `[test-unc] việc bình thường A`, status: 'completed' },
    { content: `[test-unc] việc bình thường B`, status: 'pending' },
  ],
}) as { problemHint?: string; success: boolean }
ok('F1 todo thường → KHÔNG problemHint (chống nhiễu)', w1.success && w1.problemHint === undefined, JSON.stringify(w1.problemHint))

const w2 = await todoWrite({
  sessionId: SID, runId: RUN, agentRole: 'TEST',
  todos: [{ content: `[test-unc] việc hỏng C`, status: 'failed' }],
}) as { problemHint?: string; success: boolean }
ok('F2 todo failed → CÓ problemHint', w2.success && typeof w2.problemHint === 'string' && w2.problemHint.length > 20, JSON.stringify(w2.problemHint))
ok('F3 hint nêu quy trình chẩn đoán + resolver', w2.problemHint?.includes('chẩn đoán') === true && (w2.problemHint?.includes('ĐỔI HƯỚNG') || w2.problemHint?.includes('đổi hướng')) === true, w2.problemHint)

const w3 = await todoWrite({
  sessionId: SID, runId: RUN, agentRole: 'TEST',
  todos: [{ content: `[test-unc] việc kẹt D`, status: 'blocked' }],
}) as { problemHint?: string }
ok('F4 todo blocked → CÓ problemHint', typeof w3.problemHint === 'string' && w3.problemHint.length > 20, JSON.stringify(w3.problemHint))

// ==================== TỔNG KẾT ====================
await cleanup()
console.log(`\n════════════════════════════════════════════`)
console.log(`KẾT QUẢ: ${pass} pass · ${fail} fail`)

// ==================== Task 54 FIX: suite-safe exit ====================
// File script-style nhưng tên .test.ts → bun test nhặt vào suite.
// process.exit() cũ GIẾT cả suite → các test file sau không bao giờ chạy.
// Trong suite → đăng ký test thật; chạy trực tiếp → giữ exit-code.
{
  let registered = false
  try {
    const { test } = await import('bun:test')
    test(`script-summary: ${pass} pass / ${fail} fail`, () => {
      if (fail > 0) throw new Error(`${fail} check thất bại:\n${fails.map(f => `  ❌ ${f}`).join('\n')}`)
    })
    registered = true
  } catch { /* chạy trực tiếp — bun:test không khả dụng */ }
  if (!registered) {
    if (fail > 0) process.exit(1)
    process.exit(0)
  }
}
