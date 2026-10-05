// ============================================================================
// ROUND-43 OMEGA TEST — gửi prompt THẬT cho Omega (POST /api/openclaw/chat,
// đường UI dùng), chờ durable goal-loop job chạy xong, in báo cáo + đối chiếu
// artifacts (todo cây, SHR, RunContext, CoT, agent-run, worklog code team).
//
// Chạy: bun run scratch/r43-omega-test.ts <label> <prompt-file>
// ============================================================================
process.env.DATABASE_URL = 'file:/home/z/tmo-app/db/custom.db'

import { db } from '../src/lib/db'
import { readFileSync } from 'fs'

const BASE = 'http://localhost:3000'
const OMEGA_PROFILE_ID = 'cmutow3uj000cll3ogscfngmv' // Omega (từ DB hiện tại)

const label = process.argv[2] || 'omega-test'
const promptFile = process.argv[3]
if (!promptFile) {
  console.error('Usage: bun run scratch/r43-omega-test.ts <label> <prompt-file>')
  process.exit(1)
}
const PROMPT = readFileSync(promptFile, 'utf8').trim()

let pass = 0, fail = 0
const fails: string[] = []
function ok(name: string, cond: boolean, detail = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; fails.push(name); console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`) }
}

// ── 1. Auth token ──
const setupRes = await fetch(`${BASE}/api/auth/setup`, { credentials: 'same-origin' })
const setupData = await setupRes.json().catch(() => null) as { token?: string } | null
const token = setupData?.token || ''
ok(`[${label}] E1 có auth token`, !!token)

// ── 2. Omega profile ──
const omega = await db.agentProfile.findUnique({ where: { id: OMEGA_PROFILE_ID } })
ok(`[${label}] E2 Omega profile tồn tại + enabled (${omega?.name})`, !!omega?.enabled)

// ── 3. Tạo session ──
const sessRes = await fetch(`${BASE}/api/smolab/sessions`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'x-tmo-api-token': token },
  body: JSON.stringify({ mode: 'single', agentProfileId: OMEGA_PROFILE_ID, title: `R43 ${label}` }),
})
const sessData = await sessRes.json().catch(() => null) as { session?: { sessionId?: string } } | null
const sessionId = sessData?.session?.sessionId || ''
ok(`[${label}] E3 tạo session`, !!sessionId)
console.log(`▶ Session: ${sessionId}`)

// ── 4. Gửi prompt ──
console.log(`▶ Prompt (${PROMPT.length} chars): "${PROMPT.slice(0, 150)}..."`)
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
console.log(`◀ HTTP ${chatRes.status} sau ${((Date.now() - chatStart) / 1000).toFixed(1)}s — durable=${chatData?.durable} jobId=${chatData?.jobId || '-'}`)
ok(`[${label}] E4 chat API trả 200`, chatRes.status === 200, `err=${chatData?.error || ''}`)

// ── 5. Chờ job (durable goal loop chạy nền) ──
let jobId = chatData?.jobId || ''
let finalContent = chatData?.content || ''
let finalStatus = ''
if (chatData?.durable && jobId) {
  const deadline = Date.now() + 40 * 60_000 // tối đa 40'
  let lastHint = ''
  let lastLog = Date.now()
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 10_000))
    const jr = await fetch(`${BASE}/api/goal-loop-jobs?jobId=${encodeURIComponent(jobId)}`, {
      headers: { 'x-tmo-api-token': token },
    })
    const jd = await jr.json().catch(() => null) as { job?: { status?: string; progressHint?: string | null; result?: { content?: string } | null; error?: string | null } } | null
    const st = jd?.job?.status || ''
    const hint = jd?.job?.progressHint || ''
    if (st === 'completed' || st === 'failed' || st === 'cancelled') {
      finalStatus = st
      finalContent = jd?.job?.result?.content || ''
      if (st === 'failed') console.log(`  ⚠️ job error: ${jd?.job?.error || ''}`)
      break
    }
    if (hint !== lastHint && Date.now() - lastLog > 20_000) {
      console.log(`  ⏳ [${((Date.now() - chatStart) / 60000).toFixed(1)}'] ${st}: ${hint}`)
      lastHint = hint
      lastLog = Date.now()
    }
  }
}
ok(`[${label}] E5 job hoàn tất${finalStatus ? ` (${finalStatus})` : ' (inline)'}`,
  finalStatus === '' || finalStatus === 'completed', `status=${finalStatus}`)
ok(`[${label}] E6 có báo cáo cuối (${finalContent.length} chars)`, finalContent.length > 100)
console.log('\n──────── BÁO CÁO CỦA OMEGA (2500 ký tự đầu) ────────')
console.log(finalContent.slice(0, 2500))
console.log('─────────────────────────────────────────────────\n')

// ── 6. Đối chiếu artifacts ──
const todos = await db.todo.findMany({ where: { sessionId }, orderBy: { createdAt: 'asc' } })
ok(`[${label}] A1 agent tự mở todo (${todos.length} mục)`, todos.length >= 1)
const completedTodos = todos.filter(t => t.status === 'completed').length
console.log(`  ℹ️ ${completedTodos}/${todos.length} todo completed`)
const msgs = await db.chatMessage.findMany({ where: { sessionId } })
console.log(`  ℹ️ ${msgs.length} ChatMessage rows trong phiên`)
const runsRes = await fetch(`${BASE}/api/agent-run?sessionId=${encodeURIComponent(sessionId)}&limit=10`, {
  headers: { 'x-tmo-api-token': token },
})
const runsData = await runsRes.json().catch(() => null) as { runs?: Array<{ runId: string; status: string; agentName: string; counters?: { toolCalls?: number }; events?: Array<{ type: string }> }> } | null
const runs = runsData?.runs || []
ok(`[${label}] A2 agent-run tracker có run (${runs.length})`, runs.length >= 1)
for (const r of runs.slice(0, 5)) {
  console.log(`  ℹ️ run ${r.runId.slice(0, 22)}… agent=${r.agentName} status=${r.status} tools=${r.counters?.toolCalls ?? 0} events=${r.events?.length ?? 0}`)
}
ok(`[${label}] A3 run có tool calls thật`,
  runs.some(r => (r.counters?.toolCalls ?? 0) >= 1), 'không tool call nào — Omega không thực thi?')

console.log(`\n══ [${label}] KẾT QUẢ: ${pass} PASS / ${fail} FAIL ══`)
if (fail > 0) for (const f of fails) console.log(`  ❌ ${f}`)
console.log(`📌 Session: ${sessionId}`)
await db.$disconnect()
process.exit(fail > 0 ? 1 : 0)
