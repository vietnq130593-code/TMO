// ============================================================================
// E2E VERIFY — Đối chiếu artifacts của session E2E vừa chạy (chat THẬT với
// Omega đã hoàn tất server-side: POST 200 sau 3.2 phút). Script này CHỈ ĐỌC
// DB + API — không giữ fetch dài (bản script trước bị OOM-kill khi chờ).
//
// Chạy: cd /home/z/tmo-app && DATABASE_URL=file:/home/z/tmo-app/db/custom.db \
//        bun run tests/e2e-verify-artifacts.test.ts <sessionId>
// ============================================================================

process.env.DATABASE_URL = 'file:/home/z/tmo-app/db/custom.db'

import { db } from '../src/lib/db'

const BASE = 'http://localhost:3000'
const sessionId = process.argv[2] || 'agent_1790429946447_piiqvu'

let pass = 0, fail = 0
const fails: string[] = []
function ok(name: string, cond: boolean, detail = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; fails.push(name); console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`) }
}

console.log(`\n━━━ E2E VERIFY — session ${sessionId} ━━━`)

// ── 1. Báo cáo cuối của agent (ChatMessage assistant) ──
const msgs = await db.chatMessage.findMany({
  where: { sessionId, role: 'assistant' },
  orderBy: { createdAt: 'asc' },
})
const lastAssistant = msgs[msgs.length - 1]
ok(`V1 có báo cáo cuối của Omega (${msgs.length} assistant msgs)`, !!lastAssistant)
const report = lastAssistant?.content || ''
console.log('\n──────── BÁO CÁO OMEGA (700 ký tự) ────────')
console.log(report.slice(0, 700))
console.log('─────────────────────────────────────────\n')

ok('V2 báo cáo khớp sự thật: script dev = "next dev -p 3000"', /next dev/i.test(report) && /3000/.test(report))
ok('V3 báo cáo có dòng ✅ (protocol REFLECT)', report.includes('✅'))
ok('V4 báo cáo có dòng ❓ (protocol REFLECT)', report.includes('❓'))
ok('V5 báo cáo có khối 📐 BIÊN ĐỘ DỮ LIỆU', report.includes('📐'))

// ── 2. Todos của session (cây parentId) ──
const todos = await db.todo.findMany({ where: { sessionId }, orderBy: { createdAt: 'asc' } })
console.log(`  ℹ️ Todos: ${todos.length} mục`)
for (const t of todos) {
  console.log(`     ${t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '◐' : '○'} ${t.parentId ? '  ↳ (con) ' : ''}${t.content.slice(0, 70)} [run=${t.runId?.slice(-8) || 'null'}]`)
}
ok(`V6 agent tự mở todo trong goal-loop (${todos.length} mục)`, todos.length >= 1, `count=${todos.length}`)
const nested = todos.filter(t => t.parentId)
ok('V7 có TODO CON lồng (parentId — cây)', nested.length >= 1, nested.length === 0 ? 'task 1 chu kỳ đơn giản — agent chưa cần phân rã con' : `${nested.length} con`)
const completed = todos.filter(t => t.status === 'completed')
ok('V8 todo xong được đánh dấu completed', completed.length >= 1, `${completed.length}/${todos.length}`)

// ── 3. SHR hypothesis ──
const hyps = await db.structuredHypothesis.findMany({ where: { sessionId } })
console.log(`  ℹ️ Hypotheses: ${hyps.length}`)
for (const h of hyps) {
  console.log(`     [${h.status}] α=${h.alpha} β=${h.beta} — ${h.mechanicsClaim.slice(0, 70)}`)
}
ok(`V9 agent tự ghi hypothesis SHR (${hyps.length})`, hyps.length >= 1, 'task đơn giản — agent có thể không đề xuất hypothesis (protocol: chỉ khi phát hiện cơ chế chưa chắc)')
const judged = hyps.filter(h => h.alpha > 0 || h.beta > 0)
ok('V10 hypothesis được judge + verify bằng chứng (α/β cập nhật)', judged.length >= 1,
  judged.length === 0 ? 'chưa có phán quyết verify' : `α=${judged[0].alpha} β=${judged[0].beta}`)

// ── 4. RunContext (📐) ──
const runCtxs = await db.runContext.findMany({ where: { sessionId } })
ok('V11 RunContext persist (📐 sống xuyên chu kỳ)', runCtxs.length >= 1)
if (runCtxs.length > 0) {
  console.log(`  ℹ️ 📐 scope: "${runCtxs[0].dataScope?.slice(0, 100) || '(null)'}"`)
  ok('V12 RunContext có dataScope parse từ báo cáo', !!runCtxs[0].dataScope)
}

// ── 5. Kho mẩu CoT ──
const cots = await db.cotSample.findMany({ where: { sessionId } })
console.log(`  ℹ️ CoT samples: ${cots.length}`)
for (const c of cots) {
  console.log(`     gen=${c.generation} drifted=${c.drifted} hits=${c.hitCount} — ${c.sampleText.slice(0, 90)}`)
}
ok(`V13 mẩu CoT được nén từ báo cáo chu kỳ (${cots.length})`, cots.length >= 1)
ok('V14 mẩu có kết luận (dòng ✅) + không drifted', cots.every(c => !c.drifted && c.conclusion.length > 10))

// ── 6. /api/agent-run — dữ liệu Thought Progress panel ──
const setupRes = await fetch(`${BASE}/api/auth/setup`, { credentials: 'same-origin' })
const token = ((await setupRes.json().catch(() => null)) as { token?: string } | null)?.token || ''
const runRes = await fetch(`${BASE}/api/agent-run?sessionId=${encodeURIComponent(sessionId)}&limit=10`, {
  headers: { 'x-tmo-api-token': token },
})
const runData = await runRes.json().catch(() => null) as {
  ok?: boolean; runs?: Array<{
    runId: string; status: string; agentName: string
    counters?: { toolCalls?: number; iterations?: number }
    events?: Array<{ type: string; tool?: string; argsSummary?: string }>
    todos?: Array<{ id: string; parentId?: string | null; content: string; status: string }>
  }>
} | null
const runs = runData?.runs || []
ok(`V15 /api/agent-run trả run (${runs.length})`, runs.length >= 1)
if (runs.length > 0) {
  const r = runs[0]
  console.log(`  ℹ️ Run: ${r.runId} — ${r.agentName} [${r.status}] · ${r.counters?.toolCalls ?? 0} tools · ${r.counters?.iterations ?? 0} vòng`)
  const toolEvents = (r.events || []).filter(e => e.type === 'tool')
  console.log(`     Tool events: ${toolEvents.map(e => e.tool).join(', ') || '(trống — tracker in-memory reset khi restart pm2)'}`)
  ok('V16 run có tool calls trong tracker', (r.counters?.toolCalls ?? 0) >= 1 || toolEvents.length >= 1)
  const withParent = (r.todos || []).filter(t => !!t.parentId)
  ok(`V17 run.todos trả parentId cho UI (${withParent.length}/${(r.todos || []).length} có cha)`,
    (r.todos || []).length === 0 || withParent.length > 0 || nested.length === 0)
}

// ── TỔNG KẾT ──
console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
console.log(`VERIFY KẾT QUẢ: ${pass} PASS · ${fail} FAIL / ${pass + fail}`)
if (fail > 0) for (const f of fails) console.log(`  ❌ ${f}`)
console.log(`\n📌 Session giữ lại trong app: ${sessionId} — user mở Smolab (Omega) để xem.`)
await db.$disconnect()
process.exit(fail > 0 ? 1 : 0)
