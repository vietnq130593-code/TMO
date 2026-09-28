// E2E TODO-COVERAGE VERIFY — poll DB đến khi goal-loop run của session E2E kết
// thúc, sau đó xác minh đầy đủ: (1) RunContext stashed, (2) todos + coverage,
// (3) log [TodoCoverage], (4) báo cáo cuối có khối 📐 thật.
// Chạy: bun run tests/e2e-cov-verify.ts

process.env.DATABASE_URL = 'file:/home/z/tmo-app/db/custom.db'

import { readFileSync } from 'fs'
import { db } from '../src/lib/db'
import { checkRunTodoCoverage } from '../src/lib/todo-coverage'
import { looksLikeDataScope } from '../src/lib/structured-hypothesis'

// Task 54 FIX (skip-guard): bun test (không filter) cũng nhặt file này trong
// tests/ — /tmp session file không tồn tại (máy/sandbox khác) → readFileSync
// throw làm cả suite crash. Guard: thiếu file → SKIP + exit 0. (Không dùng
// existsSync trong import — cuối file có `const { existsSync } = await import('fs')`
// block-scoped → xung đột TS2440/2448.)
const SESSION_FILE = '/tmp/e2e-cov-session.txt'
let sessionId = ''
try { sessionId = readFileSync(SESSION_FILE, 'utf-8').trim() } catch { sessionId = '' }
if (!sessionId) {
  console.log(`\n━━━ E2E COV VERIFY — SKIP ━━━\n${SESSION_FILE} không tồn tại (chưa chạy e2e-cov-send.ts trên máy này).`)
  process.exit(0)
}
console.log(`Session E2E: ${sessionId}`)

// ── Poll AgentRunRecord đến khi run kết thúc (tối đa 8 phút) ──
let run: { id: string; runId: string | null; status: string | null } | null = null
const t0 = Date.now()
while (Date.now() - t0 < 480_000) {
  const rows = await db.agentRunRecord.findMany({
    where: { sessionId },
    orderBy: { startedAt: 'desc' },
    take: 1,
  })
  const raw = rows[0]
  run = raw ? { id: raw.id, runId: raw.runId, status: raw.status } : null
  if (run && run.status !== 'running' && run.status !== null) break
  const waited = Math.round((Date.now() - t0) / 1000)
  console.log(`  ...run ${run?.status ?? '(chưa có)'} — chờ ${waited}s`)
  await new Promise(r => setTimeout(r, 15_000))
}

console.log(`\n=== AgentRunRecord: status=${run?.status} runId=${run?.runId} (${Math.round((Date.now() - t0) / 1000)}s) ===`)

const runId = run?.runId || ''
let pass = 0, fail = 0
const fails: string[] = []
function ok(name: string, cond: boolean, detail = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; fails.push(name); console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`) }
}

// ── 1. RunContext: stash nghiệm thu + 📐 ──
const rc = runId ? await db.runContext.findUnique({ where: { runId } }) : null
const acc = rc?.acceptanceCriteria ? JSON.parse(rc.acceptanceCriteria) : []
ok('1a RunContext tồn tại (stash lúc run start)', !!rc)
ok('1b 4 tiêu chí nghiệm thu được stash', Array.isArray(acc) && acc.length === 4, JSON.stringify(acc))
ok('1c dataScope stash được và là khối 📐 THẬT (có marker — fix false positive)', !!rc?.dataScope && looksLikeDataScope(rc.dataScope), rc?.dataScope || '(null)')
console.log(`    📐 = ${rc?.dataScope?.slice(0, 160) || '(null)'}`)

// ── 2. Todos + coverage cuối cùng ──
const todos = await db.todo.findMany({
  where: { sessionId, runId },
  orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
})
console.log(`\n=== Todos của run (${todos.length}) ===`)
for (const t of todos) console.log(`  [${t.status}] ${t.content.slice(0, 100)}`)
ok('2a run có todo (agent gọi todo_write)', todos.length > 0)

const cov = await checkRunTodoCoverage({ sessionId, runId })
ok('2b coverage check chạy được trên run thật', !!cov)
if (cov) {
  ok('2c PHỦ ĐỦ tiêu chí nghiệm thu (hướng 1)', cov.acceptanceCovered === cov.acceptanceTotal && cov.acceptanceTotal > 0,
    `${cov.acceptanceCovered}/${cov.acceptanceTotal}`)
  ok('2d PHỦ mục 📐 cần đọc (hướng 2)', cov.dataScopeTotal === 0 || cov.dataScopeCovered === cov.dataScopeTotal,
    `${cov.dataScopeCovered}/${cov.dataScopeTotal}`)
  console.log(`    Coverage cuối: nghiệm thu ${cov.acceptanceCovered}/${cov.acceptanceTotal} · 📐 ${cov.dataScopeCovered}/${cov.dataScopeTotal}`)
}

// ── 3. Báo cáo cuối có khối 📐 ──
const msgs = await db.chatMessage.findMany({ where: { sessionId, role: 'assistant' }, orderBy: { createdAt: 'asc' } })
const last = msgs[msgs.length - 1]?.content || ''
ok('3a báo cáo cuối tồn tại', last.length > 100)
ok('3b báo cáo có khối 📐 BIÊN ĐỘ DỮ LIỆU', /📐\s*BIÊN\s*ĐỘ\s*DỮ\s*LIỆU/i.test(last))
ok('3c báo cáo có 2 dòng ✅/❓ tự phản chiếu', /✅/.test(last) && /❓/.test(last))

// ── 4. Kết quả trên đĩa (nhiệm vụ thật) ──
const { existsSync, readFileSync: rf } = await import('fs')
ok('4a /tmp/tmo-cov-e2e/config.json tồn tại', existsSync('/tmp/tmo-cov-e2e/config.json'))
if (existsSync('/tmp/tmo-cov-e2e/config.json')) {
  const cfg = JSON.parse(rf('/tmp/tmo-cov-e2e/config.json', 'utf-8'))
  ok('4b config.json JSON hợp lệ + version đúng (2.0.0)', cfg.app === 'TMO' && cfg.version === '2.0.0', JSON.stringify(cfg))
}
ok('4c /tmp/tmo-cov-e2e/README.md tồn tại đúng 2 dòng',
  existsSync('/tmp/tmo-cov-e2e/README.md') && rf('/tmp/tmo-cov-e2e/README.md', 'utf-8').trim().split('\n').length === 2)

await db.$disconnect()
console.log(`\n━━━ E2E VERIFY KẾT QUẢ: ${pass} pass · ${fail} fail ━━━`)
if (fail > 0) { console.log('FAILED:', fails.join(' | ')); process.exit(1) }
process.exit(0)
