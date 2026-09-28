// ============================================================================
// TEST SUITE — TODO-COVERAGE (kiểm tra phủ kế hoạch determinstic — hướng 1+2)
// ============================================================================
// Chạy: cd /home/z/tmo-app && bun run tests/todo-coverage.test.ts
//
// Hướng 1: mỗi tiêu chí nghiệm thu [Nghiệm thu n] của directive ≥1 todo
// Hướng 2: mỗi mục "cần đọc" trong khối 📐 ≥1 todo thu thập dữ liệu
//
// Test THỰC TẾ trên DB thật của app (SQLite tmo-app) — session test riêng
// (prefix test-cov-<ts>) → dọn sạch cuối test. Không phù hợp CI/Jest.
// ============================================================================

// Ép DB đúng của tmo-app — chống shell DATABASE_URL nhiễm path my-project
process.env.DATABASE_URL = 'file:/home/z/tmo-app/db/custom.db'

import {
  parseDataScopeNeedItems,
  parseAcceptanceCriteriaJson,
  checkTodoCoverage,
  buildCoverageWarning,
  checkRunTodoCoverage,
} from '../src/lib/todo-coverage'
import { todoWrite } from '../src/lib/code-team/dev-tools'
import { upsertRunContext, getRunContext, parseDataScopeBlock } from '../src/lib/structured-hypothesis'
import { db } from '../src/lib/db'

const TS = Date.now()
const SID = `test-cov-${TS}`
const RUN = `test-cov-run-${TS}`

let pass = 0, fail = 0
const fails: string[] = []
function ok(name: string, cond: boolean, detail = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; fails.push(name); console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`) }
}

async function cleanup() {
  await db.todo.deleteMany({ where: { sessionId: SID } }).catch(() => null)
  await db.runContext.deleteMany({ where: { sessionId: SID } }).catch(() => null)
}

// ==================== A. PARSE — 📐 → MỤC CẦN ĐỌC ====================
console.log('\n━━━ A. parseDataScopeNeedItems — tách mục "cần đọc" khỏi khối 📐 ━━━')

const scope1 = parseDataScopeBlock('Báo cáo chu kỳ 1...\n📐 BIÊN ĐỘ DỮ LIỆU: cần đọc prisma/schema.prisma, src/lib/agent-goal-loop.ts, .env (GOAL_LOOP_*) · ngoài phạm vi: docs/, UI components, toàn bộ mini-services')
const items1 = parseDataScopeNeedItems(scope1)
ok('A1 khối chuẩn: tách đúng 3 mục cần đọc (loại phần ngoài phạm vi)', items1.length === 3, JSON.stringify(items1))
ok('A2 mục có đường dẫn giữ nguyên đường dẫn', items1.some(i => i.includes('prisma/schema.prisma')))

const items2 = parseDataScopeNeedItems('cần đọc file cấu hình goal-loop và code vòng lặp chính')
ok('A3 không có marker ngoài phạm vi → lấy toàn bộ', items2.length >= 1, JSON.stringify(items2))

ok('A4 null/empty → []', parseDataScopeNeedItems(null).length === 0 && parseDataScopeNeedItems('').length === 0)

const items3 = parseDataScopeNeedItems('ngoài phạm vi: chỉ có phần ngoài phạm vi, không có cần đọc')
ok('A5 chỉ có "ngoài phạm vi" → 0 mục (không đòi todo cho thứ không đụng)', items3.length === 0, JSON.stringify(items3))

// ==================== B. PARSE — ACCEPTANCE JSON ====================
console.log('\n━━━ B. parseAcceptanceCriteriaJson ━━━')

ok('B1 JSON array hợp lệ → giữ nguyên',
  JSON.stringify(parseAcceptanceCriteriaJson(JSON.stringify(['tiêu chí 1', 'tiêu chí 2']))) === JSON.stringify(['tiêu chí 1', 'tiêu chí 2']))
ok('B2 JSON rác → [] an toàn', parseAcceptanceCriteriaJson('not json').length === 0)
ok('B3 null → []', parseAcceptanceCriteriaJson(null).length === 0)

// ==================== C. CORE CHECK — PHỦ NGHIỆM THU (HƯỚNG 1) ====================
console.log('\n━━━ C. checkTodoCoverage — phủ nghiệm thu ━━━')

const ACC = [
  'Todo hiển thị dạng cây lồng nhau trong panel',
  'Todo hoàn thành được đánh dấu và đóng trước khi thêm mới',
  'Kiểm tra bằng chứng tool khi đóng todo',
]

// C1: phủ đủ bằng tag
const cov1 = checkTodoCoverage({
  todos: [
    { content: 'Khảo sát UI panel hiện tại [Nghiệm thu 1]' },
    { content: 'Triển khai đánh dấu + đóng todo [Nghiệm thu 2]' },
    { content: 'Viết bằng chứng tool cho todo hoàn thành [Nghiệm thu 3]' },
  ],
  acceptance: ACC, dataScopeItems: [],
})
ok('C1 phủ đủ bằng tag [Nghiệm thu n] → ok=true, 3/3', cov1.ok && cov1.acceptanceCovered === 3)
ok('C2 warning dạng ✅ khi phủ đủ', !!cov1.warning && cov1.warning.includes('✅'), cov1.warning || '')

// C3: thiếu nghiệm thu 2
const cov2 = checkTodoCoverage({
  todos: [
    { content: 'Khảo sát UI panel [Nghiệm thu 1]' },
    { content: 'Bằng chứng tool [Nghiệm thu 3]' },
  ],
  acceptance: ACC, dataScopeItems: [],
})
ok('C3 thiếu nghiệm thu 2 → ok=false, 2/3, gap index 2', !cov2.ok && cov2.acceptanceCovered === 2 && cov2.acceptanceGaps.length === 1 && cov2.acceptanceGaps[0].index === 2)
ok('C4 warning nêu đúng số + yêu cầu bổ sung', !!cov2.warning && cov2.warning.includes('Nghiệm thu 2') && cov2.warning.includes('bổ sung'), cov2.warning || '')

// C5: chống khớp giả "Nghiệm thu 1" vs "Nghiệm thu 10"
const cov3 = checkTodoCoverage({
  todos: [{ content: 'Việc gì đó cho [Nghiệm thu 10]' }],
  acceptance: Array.from({ length: 10 }, (_, i) => `Tiêu chí thứ ${i + 1} nào đó`),
  dataScopeItems: [],
})
ok('C5 "Nghiệm thu 10" KHÔNG khớp nhầm tiêu chí 1 (lookahead số)', cov3.acceptanceCovered === 1 && cov3.acceptanceGaps.every(g => g.index !== 10))

// C6: fuzzy — không tag nhưng diễn đạt lại đúng nội dung tiêu chí
const cov4 = checkTodoCoverage({
  todos: [{ content: 'Hiển thị todo dạng cây lồng nhau trong panel Thought Progress' }],
  acceptance: ['Todo hiển thị dạng cây lồng nhau trong panel'], dataScopeItems: [],
})
ok('C6 fuzzy match khi không có tag (≥70% từ khớp)', cov4.acceptanceCovered === 1, JSON.stringify(cov4))

// ==================== D. CORE CHECK — PHỦ 📐 (HƯỚNG 2) ====================
console.log('\n━━━ D. checkTodoCoverage — phủ mục 📐 cần đọc ━━━')

const DSCOPE = ['prisma/schema.prisma', 'src/lib/agent-goal-loop.ts', 'biến môi trường GOAL_LOOP_ITER_PER_CYCLE trong .env']

const d1 = checkTodoCoverage({
  todos: [
    { content: 'Đọc prisma/schema.prisma xem model Todo' },
    { content: 'Đọc agent-goal-loop.ts tìm protocol' }, // basename match
    { content: 'Kiểm tra .env biến GOAL_LOOP_ITER_PER_CYCLE' },
  ],
  acceptance: [], dataScopeItems: DSCOPE,
})
ok('D1 phủ đủ 3/3 (full path + basename + env key)', d1.ok && d1.dataScopeCovered === 3, JSON.stringify(d1))

const d2 = checkTodoCoverage({
  todos: [{ content: 'Đọc schema.prisma' }],
  acceptance: [], dataScopeItems: DSCOPE,
})
ok('D2 thiếu 2 mục → gap liệt kê đúng 2', !d2.ok && d2.dataScopeGaps.length === 2 && d2.dataScopeGaps[0].text.includes('agent-goal-loop'))
ok('D3 warning nhắc mục 📐 cụ thể', !!d2.warning && d2.warning.includes('📐 cần đọc'), d2.warning || '')

// D4: fuzzy phrase — mục không phải đường dẫn
const d3 = checkTodoCoverage({
  todos: [{ content: 'Thu thập cấu hình goal-loop hiện tại để biết các giới hạn' }],
  acceptance: [], dataScopeItems: ['cấu hình goal-loop hiện tại'],
})
ok('D4 mục dạng câu → fuzzy token ≥50% khớp', d3.ok && d3.dataScopeCovered === 1, JSON.stringify(d3))

// D5: không có gì để check → warning null (im lặng, không nhiễu)
const d4 = checkTodoCoverage({ todos: [], acceptance: [], dataScopeItems: [] })
ok('D5 không có nghiệm thu + 📐 → warning=null, ok=true', d4.ok && d4.warning === null)

// D6: cap danh sách gap hiển thị
const d5 = checkTodoCoverage({
  todos: [],
  acceptance: Array.from({ length: 8 }, (_, i) => `Tiêu chí dài nào đó số ${i + 1}`), dataScopeItems: [],
})
ok('D6 >4 gap → warning gọn kèm "(còn N mục...)"', !!d5.warning && d5.warning.includes('còn 4 mục'), d5.warning || '')

// D7: todo completed vẫn phủ (coverage = kế hoạch có nhắm tới, không phải việc còn mở)
const d6 = checkTodoCoverage({
  todos: [{ content: 'Đọc prisma/schema.prisma xong [Nghiệm thu 1]' }],
  acceptance: ['Đọc prisma/schema.prisma'], dataScopeItems: ['prisma/schema.prisma'],
})
ok('D7 todo completed vẫn tính phủ', d6.ok && d6.acceptanceCovered === 1 && d6.dataScopeCovered === 1)

// ==================== E. DB INTEGRATION — todoWrite + RunContext ====================
console.log('\n━━━ E. todoWrite trả coverage từ RunContext (đường DB thật) ━━━')

// E1: run KHÔNG có RunContext → không có field coverage (chống nhiễu task thường)
const SID2 = `${SID}-norc`, RUN2 = `${RUN}-norc`
const w1 = await todoWrite({ sessionId: SID2, runId: RUN2, todos: [{ content: 'Việc A' }] }) as { coverage?: unknown }
ok('E1 không RunContext → KHÔNG có coverage trong result', w1.coverage === undefined, JSON.stringify(w1).slice(0, 200))

// E2: stash nghiệm thu (giống goal-loop run start) → todo thiếu → warning
await upsertRunContext({ runId: RUN, sessionId: SID, acceptanceCriteria: JSON.stringify(ACC) })
const rcLoaded = await getRunContext(RUN)
ok('E2 upsertRunContext lưu được acceptanceCriteria (getRunContext đọc lại)', rcLoaded?.acceptanceCriteria === JSON.stringify(ACC))

const w2 = await todoWrite({ sessionId: SID, runId: RUN, todos: [
  { content: 'Khảo sát UI [Nghiệm thu 1]' },
] }) as { coverage?: { ok?: boolean; acceptance?: string; warning?: string } }
ok('E3 todo thiếu 2 nghiệm thu → coverage.ok=false, 1/3', w2.coverage?.ok === false && w2.coverage?.acceptance === '1/3', JSON.stringify(w2.coverage))
ok('E4 warning đính kèm liệt kê Nghiệm thu 2', !!w2.coverage?.warning && w2.coverage.warning.includes('Nghiệm thu 2'), w2.coverage?.warning || '')

// E5: agent bổ sung todo (giống hành vi sau warning) → coverage chuyển ✅
const w3 = await todoWrite({ sessionId: SID, runId: RUN, todos: [
  { content: 'Đánh dấu + đóng todo trước khi thêm mới [Nghiệm thu 2]' },
  { content: 'Bằng chứng tool khi đóng [Nghiệm thu 3]' },
] }) as { coverage?: { ok?: boolean; acceptance?: string; warning?: string } }
ok('E5 sau khi bổ sung → ok=true 3/3, warning ✅', w3.coverage?.ok === true && w3.coverage?.acceptance === '3/3' && !!w3.coverage?.warning?.includes('✅'), JSON.stringify(w3.coverage))

// E6: stash 📐 (giống mid-cycle stash) → todo thu thập đủ → phủ
await upsertRunContext({ runId: RUN, sessionId: SID, dataScope: 'cần đọc prisma/schema.prisma, tests/shr-cot-todo.test.ts · ngoài phạm vi docs/' })
const w4 = await todoWrite({ sessionId: SID, runId: RUN, todos: [
  { content: 'Đọc schema.prisma kiểm tra model Todo' },
  { content: 'Đọc tests/shr-cot-todo.test.ts xem pattern' },
] }) as { coverage?: { dataScope?: string; ok?: boolean } }
ok('E6 📐 2 mục phủ đủ qua basename + full path → dataScope 2/2', w4.coverage?.dataScope === '2/2', JSON.stringify(w4.coverage))

// E7: checkRunTodoCoverage standalone (đường bridge /api/tools/execute gọi todoWrite → cùng hàm)
const st = await checkRunTodoCoverage({ sessionId: SID, runId: RUN })
ok('E7 checkRunTodoCoverage tổng hợp trên TOÀN BỘ todo run (đủ cả nghiệm thu + 📐)', !!st && st.ok === true && st.acceptanceTotal === 3 && st.dataScopeTotal === 2, JSON.stringify(st))

// E8: buildCoverageWarning null khi không gì để báo
ok('E8 buildCoverageWarning(EMPTY_OK) → null', buildCoverageWarning({ ok: true, acceptanceTotal: 0, acceptanceCovered: 0, dataScopeTotal: 0, dataScopeCovered: 0, acceptanceGaps: [], dataScopeGaps: [], warning: null }) === null)

// E9: RunContext của run khác (self-direction sd-*) không bị dính (isolation)
const w5 = await todoWrite({ sessionId: `${SID}-other`, runId: `${RUN}-other`, todos: [{ content: 'Việc riêng' }] }) as { coverage?: unknown }
ok('E9 run khác không có RunContext → không coverage (isolation theo runId)', w5.coverage === undefined)

// ==================== F. ROUND-TRIP — extractDirectiveSpec → RunContext → coverage ====================
console.log('\n━━━ F. round-trip directive Opus → coverage ━━━')

// Giống format chỉ đạo Opus 2-mục thật
const opusDirective = `🚀 BƯỚC TIẾP THEO
• Mục tiêu: Nâng cấp Thought Progress hiển thị todo dạng cây
Nghiệm thu:
- [ ] Todo con lồng dưới todo cha theo parentId
- [ ] Todo hoàn thành có dấu ✓ và gạch ngang
- [ ] Panel không lỗi console`
const { extractDirectiveSpec } = await import('../src/lib/agent-goal-loop')
const spec = extractDirectiveSpec(opusDirective)
ok('F1 extractDirectiveSpec trích được 3 tiêu chí', spec.acceptance.length === 3, JSON.stringify(spec.acceptance))

const SID3 = `${SID}-rt`, RUN3 = `${RUN}-rt`
await upsertRunContext({ runId: RUN3, sessionId: SID3, acceptanceCriteria: JSON.stringify(spec.acceptance) })
const w6 = await todoWrite({ sessionId: SID3, runId: RUN3, todos: [
  { content: 'Render cây parentId [Nghiệm thu 1]' },
  { content: 'Dấu ✓ gạch ngang completed [Nghiệm thu 2]' },
  // thiếu nghiệm thu 3 cố ý
] }) as { coverage?: { ok?: boolean } }
ok('F2 round-trip: thiếu nghiệm thu 3 bị phát hiện qua todo_write', w6.coverage?.ok === false, JSON.stringify(w6.coverage))

const w7 = await todoWrite({ sessionId: SID3, runId: RUN3, todos: [
  { content: 'Kiểm console sạch bằng browser [Nghiệm thu 3]' },
] }) as { coverage?: { ok?: boolean } }
ok('F3 bổ sung đủ → ok=true', w7.coverage?.ok === true, JSON.stringify(w7.coverage))

// ==================== G. REGRESSION — FALSE POSITIVE 📐 (lộ E2E thật) ====================
console.log('\n━━━ G. parse 📐 chống nhặt nhầm (E2E regression) ━━━')

// Kịch bản E2E thật: nội dung todo NHẮC TỚI 📐 trước, khối 📐 thật ở cuối
const e2eReport = `Kế hoạch:
- [Nghiệm thu 4] Báo cáo cuối với 📐 BIÊN ĐỘ DỮ LIỆU + ✅/❓
6. **Kiểm định cả 2 file gốc + báo cáo** bằng tool thật

Đã làm xong mọi việc.

### 📐 BIÊN ĐỘ DỮ LIỆU
**Cần đọc**: \`/home/z/tmo-app/package.json\` (version), \`/tmp/tmo-cov-e2e/config.json\`
**Ngoài phạm vi**: Bất kỳ file/thư mục nào khác ngoài \`/tmp/tmo-cov-e22\``

const { parseDataScopeBlock: parseScope, looksLikeDataScope } = await import('../src/lib/structured-hypothesis')
const e2eScope = parseScope(e2eReport)
ok('G1 khối 📐 THẬT (có marker) được ưu tiên thay vì đoạn nhắc tới 📐 trong todo', !!e2eScope && e2eScope.includes('Cần đọc') && e2eScope.includes('package.json'), e2eScope || '(null)')
ok('G2 looksLikeDataScope: khối thật → true', looksLikeDataScope(e2eScope) === true)
ok('G3 looksLikeDataScope: đoạn nhắc tới 📐 không marker → false (gate chặn stash rác)', looksLikeDataScope('+ 2 dòng ✅/❓ 6. **Kiểm định cả 2 file gốc + báo cáo** bằng tool thật') === false)

// Chỉ có junk (không khối thật) → parse vẫn trả junk (hành vi cũ) nhưng gate chặn stash
const junkOnly = 'Việc cần làm: báo cáo cuối với 📐 BIÊN ĐỘ DỮ LIỆU + ✅/❓ rồi kết thúc'
const junkScope = parseScope(junkOnly)
ok('G4 junk-only: gate chặn được (looksLikeDataScope=false) dù parse vẫn trả text', junkScope !== null && looksLikeDataScope(junkScope) === false)

// Items từ khối 📐 thật của E2E → khớp todo "Đọc version từ package.json"
const e2eItems = parseDataScopeNeedItems(e2eScope)
ok('G5 items từ khối 📐 thật tách đúng 2 file', e2eItems.length === 2 && e2eItems.some(i => i.includes('package.json')), JSON.stringify(e2eItems))
const e2eMatch = checkTodoCoverage({
  todos: [{ content: 'Đọc version từ package.json (đã đọc: 2.0.0)' }, { content: 'Tạo config.json với version thật' }],
  acceptance: [], dataScopeItems: e2eItems,
})
ok('G6 basename match: todo "package.json"/"config.json" phủ 2/2 mục 📐', e2eMatch.dataScopeCovered === 2, JSON.stringify(e2eMatch))

// ==================== CLEANUP + SUMMARY ====================
await cleanup()
console.log(`\n━━━ KẾT QUẢ: ${pass} pass · ${fail} fail ━━━`)

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
