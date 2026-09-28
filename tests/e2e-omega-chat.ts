// ============================================================================
// E2E TEST — Gửi prompt THẬT qua khung chat cho Omega (POST /api/openclaw/chat
// — đúng đường UI dùng), quan sát agent tiếp nhận + thực thi goal protocol,
// rồi đối chiếu artifacts trong DB (todo cây, SHR, CoT, RunContext, báo cáo).
//
// Chạy: cd /home/z/tmo-app && DATABASE_URL=file:/home/z/tmo-app/db/custom.db \
//        bun run tests/e2e-omega-chat.test.ts
//
// Session E2E KHÔNG bị dọn — giữ lại để user mở UI xem Thought Progress tree.
// ============================================================================

process.env.DATABASE_URL = 'file:/home/z/tmo-app/db/custom.db'

import { db } from '../src/lib/db'

const BASE = 'http://localhost:3000'
const OMEGA_PROFILE_ID = 'cmugtfmxh000cng87m9h8vni3' // Omega — zen/nemotron-3-ultra-free

let pass = 0, fail = 0
const fails: string[] = []
function ok(name: string, cond: boolean, detail = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; fails.push(name); console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`) }
}

// ── 1. Auth token (proxy) ──
const setupRes = await fetch(`${BASE}/api/auth/setup`, { credentials: 'same-origin' })
const setupData = await setupRes.json().catch(() => null) as { token?: string } | null
const token = setupData?.token || ''
ok('E1 có auth token từ /api/auth/setup', !!token)

// ── 2. Tạo session chat riêng cho Omega (như UI Smolab) ──
const omega = await db.agentProfile.findUnique({ where: { id: OMEGA_PROFILE_ID } })
ok('E2 Omega profile tồn tại + enabled', !!omega?.enabled)

const sessRes = await fetch(`${BASE}/api/smolab/sessions`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'x-tmo-api-token': token },
  body: JSON.stringify({ mode: 'single', agentProfileId: OMEGA_PROFILE_ID, title: 'E2E SHR test' }),
})
const sessData = await sessRes.json().catch(() => null) as { session?: { sessionId?: string } } | null
const sessionId = sessData?.session?.sessionId || ''
ok('E3 tạo session chat cho Omega', !!sessionId, JSON.stringify(sessData))
console.log(`\n▶ Session: ${sessionId}`)

// ── 3. GỬI PROMPT THẬT (như user gõ vào khung chat) ──
// Prompt tự nhiên — KHÔNG chỉ dẫn tool chi tiết: để protocol GĐ0-GĐ3 trong
// system prompt tự dẫn dắt agent (test việc agent TIẾP NHẬN protocol thật).
const PROMPT = `Điều tra và xác nhận cơ chế trong repo /home/z/tmo-app: đọc file package.json, xác nhận (1) script "dev" chạy lệnh gì và (2) ứng dụng lắng nghe port nào khi chạy script đó. Kiểm chứng bằng tool thật (đọc file thật, không đoán), rồi báo cáo kết quả.`

console.log(`▶ Prompt gửi cho Omega: "${PROMPT}"`)
console.log(`▶ Đang chờ goal-loop chạy (agent thật — có thể vài phút)...\n`)

const chatStart = Date.now()
const chatRes = await fetch(`${BASE}/api/openclaw/chat`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'x-tmo-api-token': token },
  body: JSON.stringify({
    messages: [{ role: 'user', content: PROMPT }],
    model: omega?.model || 'nemotron-3-ultra-free',
    sessionId,
    stream: false,
    agentInstruction: omega?.instruction,
    agentTemperature: omega?.temperature,
    agentMaxTokens: omega?.maxTokens,
    agentProfileId: OMEGA_PROFILE_ID,
    agentProfileName: 'Omega',
    agentProvider: omega?.provider || 'zen',
    agentModel: omega?.model || 'nemotron-3-ultra-free',
    teamMode: 'single',
  }),
})
const chatData = await chatRes.json().catch(() => null) as {
  content?: string; durable?: boolean; jobId?: string; error?: string
} | null
const elapsedMin = ((Date.now() - chatStart) / 60000).toFixed(1)
console.log(`◀ HTTP ${chatRes.status} sau ${elapsedMin} phút`)
ok('E4 chat API trả 200', chatRes.status === 200, `status=${chatRes.status} err=${chatData?.error || ''}`)
ok('E5 có phản hồi cuối (goal-loop kết thúc)', !!(chatData?.durable && chatData?.jobId ? false : chatData?.content && chatData.content.length > 50),
  `durable=${chatData?.durable} len=${chatData?.content?.length ?? 0}`)

const finalReport = chatData?.content || ''
console.log('\n──────── BÁO CÁO CỦA OMEGA (600 ký tự đầu) ────────')
console.log(finalReport.slice(0, 600))
console.log('─────────────────────────────────────────────────\n')

// ── 4. Đối chiếu artifacts trong DB ──
console.log('━━━ Đối chiếu artifacts (goal protocol tự dẫn dắt) ━━━')

// 4a. Todo — agent có mở todo không? Có todo CON lồng không?
const todos = await db.todo.findMany({ where: { sessionId }, orderBy: { createdAt: 'asc' } })
ok(`E6 agent tự mở todo (${todos.length} mục)`, todos.length >= 2, `count=${todos.length}`)
const nested = todos.filter(t => t.parentId)
ok('E7 có TODO CON lồng nhau (parentId — cây Thought Progress)', nested.length >= 1,
  nested.length === 0 ? 'agent không tạo todo con (cây phẳng)' : `${nested.length} todo con`)
const completed = todos.filter(t => t.status === 'completed')
ok('E8 todo xong được đánh dấu completed (kỷ luật đóng việc)', completed.length >= 1,
  `${completed.length}/${todos.length} completed`)

// 4b. SHR — hypothesis propose + judge?
const hyps = await db.structuredHypothesis.findMany({ where: { sessionId } })
ok(`E9 agent tự ghi hypothesis SHR (${hyps.length} mục)`, hyps.length >= 1, 'không có hypothesis — task có thể không gợi cơ chế')
const judged = hyps.filter(h => h.alpha > 0 || h.beta > 0)
ok('E10 hypothesis được judge + verify bằng chứng thật (α/β > 0)',
  judged.length >= 1, judged.length === 0 ? 'chưa có phán quyết được verify' : `α=${judged[0].alpha} β=${judged[0].beta}`)

// 4c. RunContext — khối 📐 được parse + persist?
const runCtxs = await db.runContext.findMany({ where: { sessionId } })
ok('E11 RunContext persist (📐 biên độ dữ liệu sống xuyên chu kỳ)',
  runCtxs.length >= 1 && !!runCtxs[0].dataScope,
  runCtxs.length === 0 ? 'chưa có' : `scope="${runCtxs[0].dataScope?.slice(0, 60)}..."`)

// 4d. CoT — mẩu được nén từ báo cáo?
const cots = await db.cotSample.findMany({ where: { sessionId } })
ok(`E12 kho mẩu CoT nén từ báo cáo (${cots.length} mẩu)`, cots.length >= 1)
if (cots.length > 0) {
  ok('E13 mẩu CoT có nguồn gen + không drifted', cots.every(c => c.generation >= 1 && !c.drifted))
}

// 4e. Báo cáo cuối — protocol ✅/❓/📐?
ok('E14 báo cáo cuối có dòng ✅ (đã chắc chắn)', /✅/.test(finalReport))
ok('E15 báo cáo cuối có dòng ❓ (còn chưa chắc)', /❓/.test(finalReport))
ok('E16 báo cáo cuối có khối 📐 BIÊN ĐỘ DỮ LIỆU', /📐/.test(finalReport))

// ── 5. Thought Progress — /api/agent-run có dữ liệu panel? ──
const runRes = await fetch(`${BASE}/api/agent-run?sessionId=${encodeURIComponent(sessionId)}&limit=10`, {
  headers: { 'x-tmo-api-token': token },
})
const runData = await runRes.json().catch(() => null) as {
  ok?: boolean; runs?: Array<{
    runId: string; status: string; agentName: string; counters?: { toolCalls?: number }
    events?: Array<{ type: string; tool?: string }>; todos?: Array<{ parentId?: string | null }>
  }>
} | null
const runs = runData?.runs || []
ok(`E17 /api/agent-run trả run (${runs.length} run)`, runs.length >= 1)
if (runs.length > 0) {
  const r = runs[0]
  ok(`E18 run có thought/tool events (${r.events?.length ?? 0} events, ${r.counters?.toolCalls ?? 0} tool calls)`,
    (r.events?.length ?? 0) >= 2 && (r.counters?.toolCalls ?? 0) >= 1)
  ok('E19 run.todos có parentId (Thought Progress render cây được)',
    (r.todos || []).some(t => !!t.parentId) || (r.todos || []).length === 0 ? (r.todos || []).some(t => !!t.parentId) : false,
    `${(r.todos || []).filter(t => t.parentId).length}/${(r.todos || []).length} todo có parentId`)
  console.log(`  ℹ️ runId=${r.runId} agent=${r.agentName} status=${r.status}`)
}

// ── 6. Kiểm tra câu trả lời ĐÚNG sự thật (port + script dev) ──
const pkgRaw = await db.$queryRawUnsafe(`SELECT 1`) // noop — đọc file trực tiếp bên dưới
const { readFileSync } = await import('fs')
const pkg = JSON.parse(readFileSync('/home/z/tmo-app/package.json', 'utf8')) as { scripts?: Record<string, string> }
const devScript = pkg.scripts?.dev || ''
console.log(`\n  ℹ️ Sự thật: script dev = "${devScript}"`)
ok('E20 câu trả lời khớp sự thật (script dev có "next dev")',
  /next\s+dev/.test(finalReport) && devScript.includes('next dev'))

// ==================== TỔNG KẾT ====================
console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
console.log(`E2E KẾT QUẢ: ${pass} PASS · ${fail} FAIL / ${pass + fail}`)
if (fail > 0) {
  console.log('FAIL chi tiết:')
  for (const f of fails) console.log(`  ❌ ${f}`)
}
console.log(`\n📌 Session E2E GIỮ LẠI trong app: ${sessionId}`)
console.log(`   → User mở Smolab chat Omega, chọn session này để xem Thought Progress (todo cây + timeline).`)
await db.$disconnect()
process.exit(fail > 0 ? 1 : 0)
