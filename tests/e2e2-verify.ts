// E2E-2 VERIFY — đối chiếu artifacts của session E2E-2 (task đa bước —
// kiểm chứng protocol đầy đủ: todo cây + SHR hypothesis + ✅/❓/📐 + tracker).
// Chạy: bun run tests/e2e2-verify.ts [sessionId]

process.env.DATABASE_URL = 'file:/home/z/tmo-app/db/custom.db'

import { db } from '../src/lib/db'
import { readFileSync, existsSync } from 'fs'

const BASE = 'http://localhost:3000'
const sessionId = process.argv[2] || readFileSync('/tmp/e2e2-session.txt', 'utf8').trim()

let pass = 0, fail = 0
const fails: string[] = []
function ok(name: string, cond: boolean, detail = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; fails.push(name); console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`) }
}

console.log(`\n━━━ E2E-2 VERIFY — session ${sessionId} ━━━`)

// ── 1. Response cuối (file từ send-script nếu có, không thì DB) ──
let report = ''
let httpInfo = '(từ DB — send script bị kill khi chờ)'
try {
  const resp = JSON.parse(readFileSync('/tmp/e2e2-response.json', 'utf8')) as {
    status: number; minutes: string; data: { content?: string } | null
  }
  report = resp.data?.content || ''
  httpInfo = `HTTP ${resp.status} · ${resp.minutes} phút`
} catch {
  const msgs = await db.chatMessage.findMany({
    where: { sessionId, role: 'assistant' },
    orderBy: { createdAt: 'desc' }, take: 1,
  })
  report = msgs[0]?.content || ''
}
console.log(`${httpInfo} · báo cáo ${report.length} chars`)
ok('W1 có báo cáo cuối (persist DB)', report.length > 100)

console.log('\n──────── BÁO CÁO OMEGA (900 ký tự) ────────')
console.log(report.slice(0, 900))
console.log('─────────────────────────────────────────\n')

// ── 2. Protocol adherence trong báo cáo ──
ok('W2 báo cáo có dòng ✅ (REFLECT chắc chắn)', report.includes('✅'))
ok('W3 báo cáo có dòng ❓ (REFLECT chưa chắc)', report.includes('❓'))
ok('W4 báo cáo có khối 📐 BIÊN ĐỘ DỮ LIỆU', report.includes('📐'))

// ── 3. Kết quả task THẬT trên đĩa ──
const notesPath = '/tmp/tmo-e2e/notes.md'
if (existsSync(notesPath)) {
  const notes = readFileSync(notesPath, 'utf8')
  const lines = notes.split('\n').filter(l => l.trim() !== '')
  console.log(`  ℹ️ notes.md (${lines.length} dòng): ${JSON.stringify(lines.slice(0, 5))}`)
  ok('W5 file notes.md tồn tại + ≥3 dòng', lines.length >= 3, `${lines.length} dòng`)
  ok('W6 có nội dung dòng 4 sau append (thử nghiệm cơ chế)', lines.some(l => l.includes('dòng 4')) || lines.length >= 4)
} else {
  ok('W5 file notes.md tồn tại', false, 'file không tồn tại — agent không làm đúng task')
  ok('W6 có nội dung dòng 4 sau append', false)
}

// ── 4. Todos (cây) ──
const todos = await db.todo.findMany({ where: { sessionId }, orderBy: { createdAt: 'asc' } })
console.log(`  ℹ️ Todos: ${todos.length}`)
for (const t of todos.slice(0, 12)) {
  console.log(`     ${t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '◐' : t.status === 'failed' ? '✗' : '○'} ${t.parentId ? '  ↳ (con) ' : ''}${t.content.slice(0, 66)} [run=${t.runId?.slice(-6) || 'null'}]`)
}
ok(`W7 agent mở todo (${todos.length} mục — protocol GĐ1)`, todos.length >= 2, `count=${todos.length}`)
const nested = todos.filter(t => t.parentId)
ok('W8 có TODO CON lồng nhau (parentId)', nested.length >= 1, nested.length === 0 ? 'chỉ todo phẳng' : `${nested.length} con`)
const completed = todos.filter(t => t.status === 'completed')
ok(`W9 todo xong được đóng (completed) — kỷ luật`, completed.length >= 1 && completed.length >= Math.floor(todos.length / 2),
  `${completed.length}/${todos.length}`)

// ── 5. SHR hypothesis ──
const hyps = await db.structuredHypothesis.findMany({ where: { sessionId } })
console.log(`  ℹ️ Hypotheses: ${hyps.length}`)
for (const h of hyps) {
  console.log(`     [${h.status}] α=${h.alpha} β=${h.beta} — ${h.mechanicsClaim.slice(0, 70)}`)
  if (h.pendingJudgment) console.log(`       pending: ${h.pendingJudgment.slice(0, 90)}`)
}
ok(`W10 agent ghi hypothesis SHR (${hyps.length})`, hyps.length >= 1)
const judged = hyps.filter(h => h.alpha > 0 || h.beta > 0)
ok('W11 hypothesis judge + verify bằng chứng thật (α/β cập nhật qua λ-grounded)',
  judged.length >= 1, judged.length === 0 ? 'chưa có phán quyết được verify (agent có thể chỉ judge ở chu kỳ cuối — check pending)' : `α=${judged[0].alpha} β=${judged[0].beta}`)
const pending = hyps.filter(h => h.pendingJudgment)
if (pending.length > 0) console.log(`  ⚠️ ${pending.length} phán quyết PENDING chưa verify (verify chạy CUỐI chu kỳ — nếu run vừa kết thúc có thể đã xử lý)`)

// ── 6. RunContext + CoT ──
const runCtxs = await db.runContext.findMany({ where: { sessionId } })
ok('W12 RunContext persist 📐', runCtxs.length >= 1)
if (runCtxs.length > 0) {
  console.log(`  ℹ️ 📐 scope: "${runCtxs[0].dataScope?.slice(0, 110) || '(null)'}"`)
  ok('W13 dataScope parse được từ khối 📐 của báo cáo', !!runCtxs[0].dataScope)
}
const cots = await db.cotSample.findMany({ where: { sessionId } })
ok(`W14 mẩu CoT nén (${cots.length} mẩu — 1/chu kỳ)`, cots.length >= 1)
for (const c of cots) console.log(`     gen=${c.generation} drifted=${c.drifted} — ${c.sampleText.slice(0, 85)}`)

// ── 7. Thought Progress tracker (fix V16 — tool native CLI giờ hiện) ──
const setupRes = await fetch(`${BASE}/api/auth/setup`, { credentials: 'same-origin' })
const token = ((await setupRes.json().catch(() => null)) as { token?: string } | null)?.token || ''
const runRes = await fetch(`${BASE}/api/agent-run?sessionId=${encodeURIComponent(sessionId)}&limit=10`, {
  headers: { 'x-tmo-api-token': token },
})
const runData = await runRes.json().catch(() => null) as {
  runs?: Array<{
    runId: string; status: string; agentName: string
    counters?: { toolCalls?: number; iterations?: number }
    events?: Array<{ type: string; tool?: string; argsSummary?: string; success?: boolean }>
    todos?: Array<{ id: string; parentId?: string | null; content: string; status: string }>
  }>
} | null
const runs = runData?.runs || []
if (runs.length > 0) {
  const r = runs[0]
  const toolEvents = (r.events || []).filter(e => e.type === 'tool')
  console.log(`  ℹ️ Run ${r.runId} [${r.status}] — ${r.counters?.toolCalls ?? 0} tools · ${r.counters?.iterations ?? 0} vòng · ${toolEvents.length} tool events tracker`)
  console.log(`     Tools: ${toolEvents.map(e => `${e.tool}${e.success === false ? '✗' : ''}`).join(', ').slice(0, 200)}`)
  ok('W15 tracker HIỆN tool native CLI (fix gap V16)', toolEvents.length >= 2, `${toolEvents.length} events`)
  const thoughts = (r.events || []).filter(e => e.type === 'thought')
  ok(`W16 tracker có thought events (${thoughts.length})`, thoughts.length >= 1)
  const withParent = (r.todos || []).filter(t => !!t.parentId)
  ok(`W17 run.todos có parentId cho UI (${withParent.length}/${(r.todos || []).length})`,
    nested.length === 0 ? true : withParent.length >= 1)
} else {
  ok('W15 tracker có run', false, 'không có run')
  ok('W16 tracker có thought', false)
  ok('W17 run.todos parentId', false)
}

console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
console.log(`E2E-2 KẾT QUẢ: ${pass} PASS · ${fail} FAIL / ${pass + fail}`)
if (fail > 0) for (const f of fails) console.log(`  ❌ ${f}`)
console.log(`\n📌 Session: ${sessionId} — giữ trong app để user xem trên UI.`)
await db.$disconnect()
process.exit(fail > 0 ? 1 : 0)
