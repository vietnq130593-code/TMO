// E2E UNCERTAINTY LEDGER VERIFY — poll DB đến khi goal-loop run của session
// E2E kết thúc, xác minh: (1) RunContext.uncertainItems có mục ❓ từ báo cáo
// (phản chiếu → năng lực trong quy trình), (2) renderUncertainLedgerBlock cho
// ra block directive chuẩn, (3) ChatMessage metadata agentRun.events có TÊN
// TOOL đầy đủ (fix " Thought Progress biến mất / không thấy tên tool").
// Chạy: bun run tests/e2e-unc-verify.ts

process.env.DATABASE_URL = 'file:/home/z/tmo-app/db/custom.db'

import { readFileSync, existsSync } from 'fs'
import { db } from '../src/lib/db'
import { parseUncertainItems, renderUncertainLedgerBlock } from '../src/lib/structured-hypothesis'

// Task 54 FIX (skip-guard): bun test (không filter) cũng nhặt file này trong
// tests/ — /tmp session file không tồn tại (máy/sandbox khác) → readFileSync
// throw làm cả suite crash. Guard: thiếu file → SKIP + exit 0.
const SESSION_FILE = '/tmp/e2e-unc-session.txt'
if (!existsSync(SESSION_FILE)) {
  console.log(`\n━━━ E2E UNC VERIFY — SKIP ━━━\n${SESSION_FILE} không tồn tại (chưa chạy e2e-unc-send.ts trên máy này).`)
  process.exit(0)
}
const sessionId = readFileSync(SESSION_FILE, 'utf-8').trim()
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

// ── 1. UNCERTAINTY LEDGER: RunContext.uncertainItems từ báo cáo thật ──
const rc = runId ? await db.runContext.findUnique({ where: { runId } }) : null
ok('1a RunContext tồn tại', !!rc)
let ledger: Array<{ text: string; firstSeenCycle: number }> = []
if (rc?.uncertainItems) {
  try { ledger = JSON.parse(rc.uncertainItems) } catch { ledger = [] }
}
ok('1b ledger ❓ được stash (JSON parse được)', Array.isArray(ledger), rc?.uncertainItems?.slice(0, 200) || '(null)')
ok('1c ledger CÓ ít nhất 1 mục (báo cáo thật có dòng ❓)', ledger.length > 0, JSON.stringify(ledger))
if (ledger.length > 0) {
  ok('1d mục có firstSeenCycle hợp lệ', ledger.every(i => typeof i.firstSeenCycle === 'number' && i.firstSeenCycle >= 1))
  console.log(`    ❓ ledger: ${ledger.map(i => `"${i.text.slice(0, 80)}" (chu kỳ ${i.firstSeenCycle})`).join(' · ')}`)
  // Render block như directive chu kỳ sau sẽ nhận
  const block = renderUncertainLedgerBlock(rc?.uncertainItems, (ledger[0].firstSeenCycle || 1) + 1)
  ok('1e renderUncertainLedgerBlock cho ra block directive', block.includes('❓ CÒN CHƯA CHẮC') && block.includes(ledger[0].text.slice(0, 30)), block.slice(0, 200))
}

// ── 2. Báo cáo cuối: dòng ❓ tồn tại (nguồn của ledger) ──
const msgs = await db.chatMessage.findMany({ where: { sessionId, role: 'assistant' }, orderBy: { createdAt: 'asc' } })
const lastContent = msgs[msgs.length - 1]?.content || ''
ok('2a báo cáo cuối tồn tại', lastContent.length > 100)
ok('2b báo cáo có dòng ❓', /❓/.test(lastContent))
const parsedFromReport = parseUncertainItems(lastContent)
console.log(`    parseUncertainItems(báo cáo) = ${parsedFromReport.length} mục: ${JSON.stringify(parsedFromReport.map(x => x.slice(0, 60)))}`)

// ── 3. RICH RUN SUMMARY: ChatMessage metadata agentRun.events có TÊN TOOL ──
const lastMeta = msgs.length > 0 ? (() => { try { const p = JSON.parse(msgs[msgs.length - 1].metadata || '{}'); return typeof p === 'string' ? JSON.parse(p) : p } catch { return null } })() : null
const summary = lastMeta?.agentRun as { events?: Array<{ type: string; text?: string; tool?: string; args?: string; ok?: boolean; result?: string }> } | undefined
ok('3a metadata.agentRun tồn tại (persist cho reload)', !!summary)
if (summary?.events) {
  const evs = summary.events
  const toolEvs = evs.filter(e => e.type === 'tool')
  ok('3b events có tool event', toolEvs.length > 0, `${toolEvs.length} tool events`)
  const namedTools = toolEvs.filter(e => typeof e.tool === 'string' && e.tool.length > 0)
  ok('3c MỌI tool event mang TÊN TOOL (fix "chỉ có ký hiệu")', toolEvs.length > 0 && namedTools.length === toolEvs.length,
    `${namedTools.length}/${toolEvs.length} — tên: ${[...new Set(namedTools.map(e => e.tool))].join(', ')}`)
  const withResult = toolEvs.filter(e => typeof e.result === 'string' && e.result.length > 0)
  console.log(`    Tool events: ${toolEvs.length} · có result preview: ${withResult.length} · tên dùng: ${[...new Set(namedTools.map(e => e.tool))].slice(0, 10).join(', ')}`)
  ok('3d tool event có ok (✓/✗) + args', toolEvs.every(e => typeof e.ok === 'boolean') && toolEvs.some(e => typeof e.args === 'string'))
  const thoughtEvs = evs.filter(e => e.type === 'thought')
  ok('3e thought event có text (suy nghĩ agent xem lại được)', thoughtEvs.length > 0 && thoughtEvs.some(e => (e.text || '').length > 20), `${thoughtEvs.length} thoughts`)
}

// ── 4. Kết quả trên đĩa (nhiệm vụ thật) ──
ok('4a /tmp/tmo-unc-e2e/notes.txt tồn tại', existsSync('/tmp/tmo-unc-e2e/notes.txt'))
if (existsSync('/tmp/tmo-unc-e2e/notes.txt')) {
  const notes = readFileSync('/tmp/tmo-unc-e2e/notes.txt', 'utf-8')
  const lines = notes.trim().split('\n')
  ok('4b notes.txt đúng 3 dòng', lines.length === 3, `${lines.length} dòng: ${JSON.stringify(lines)}`)
  ok('4c dòng 3 ghi số N đếm bằng lệnh máy', /uncertainItems.*:?\s*\d+/.test(lines[2] || ''), lines[2] || '(trống)')
  // Đối chiếu N với giá trị thật
  const m = (lines[2] || '').match(/(\d+)/)
  if (m) {
    const schemaContent = readFileSync('/home/z/tmo-app/prisma/schema.prisma', 'utf-8')
    const realCount = (schemaContent.match(/uncertainItems/g) || []).length
    ok(`4d N=${m[1]} khớp đếm thật (${realCount})`, Number(m[1]) === realCount, `agent ghi ${m[1]}, thật ${realCount}`)
  }
}

await db.$disconnect()
console.log(`\n━━━ E2E VERIFY KẾT QUẢ: ${pass} pass · ${fail} fail ━━━`)
if (fail > 0) { console.log('FAILED:', fails.join(' | ')); process.exit(1) }
process.exit(0)
