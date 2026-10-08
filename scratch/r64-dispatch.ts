// ============================================================================
// ROUND-64 DISPATCH — NHIỆM VỤ QUẢN TRỊ #18: KHẮC PHỤC BẢO MẬT P0/P1/P2
// (đề bài từ sổ rủi ro mission cmuz4z2n1 — user chỉ đạo: P0/P1/P2 là đề bài
//  kế tiếp, dispatch kèm tiêu chí nghiệm thu để tránh ping-pong kiểu mission)
//
// Chạy: bun run scratch/r64-dispatch.ts
// ============================================================================
process.env.DATABASE_URL = 'file:/home/z/tmo-app/db/custom.db'

import { readFileSync } from 'fs'

const BASE = 'http://localhost:3000'
const OMEGA_PROFILE_ID = 'cmutow3uj000cll3ogscfngmv' // Omega (zen/space-bunny-free)
const PROMPT = readFileSync('/home/z/tmo-app/scratch/r64-directive.txt', 'utf8').trim()

// ── 1. Auth token ──
const setupRes = await fetch(`${BASE}/api/auth/setup`, { credentials: 'same-origin' })
const setupData = await setupRes.json().catch(() => null) as { token?: string } | null
const token = setupData?.token || ''
if (!token) { console.error('✗ không lấy được auth token'); process.exit(1) }

// ── 2. Session quan sát (đúng pattern obsv của r59/r61) ──
const sessRes = await fetch(`${BASE}/api/smolab/sessions`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'x-tmo-api-token': token },
  body: JSON.stringify({ mode: 'single', agentProfileId: OMEGA_PROFILE_ID, title: 'R18 obs — khắc phục bảo mật P0/P1/P2' }),
})
const sessData = await sessRes.json().catch(() => null) as { session?: { sessionId?: string } } | null
const sessionId = sessData?.session?.sessionId || ''
if (!sessionId) { console.error('✗ không tạo được session'); process.exit(1) }
console.log(`▶ Session: ${sessionId}`)

// ── 3. Lấy profile Omega (model/instruction thật từ DB) ──
const { Database } = await import('bun:sqlite')
const db = new Database('/home/z/tmo-app/db/custom.db', { readonly: true })
const omega = db.query('SELECT name, provider, model, instruction, temperature, "maxTokens" as maxTokens FROM AgentProfile WHERE id = ?').get(OMEGA_PROFILE_ID) as any
db.close()

// ── 4. Dispatch qua POST /api/openclaw/chat (đường UI, durable goal loop) ──
console.log(`▶ Directive: ${PROMPT.length} chars — dispatch lúc ${new Date().toISOString()}`)
const chatStart = Date.now()
const chatRes = await fetch(`${BASE}/api/openclaw/chat`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'x-tmo-api-token': token },
  body: JSON.stringify({
    messages: [{ role: 'user', content: PROMPT }],
    model: omega?.model || 'space-bunny-free',
    sessionId,
    stream: false,
    agentInstruction: omega?.instruction,
    agentTemperature: omega?.temperature,
    agentMaxTokens: omega?.maxTokens,
    agentProfileId: OMEGA_PROFILE_ID,
    agentProfileName: omega?.name || 'Omega',
    agentProvider: omega?.provider || 'zen',
    agentModel: omega?.model || 'space-bunny-free',
    teamMode: 'single',
  }),
})
const chatData = await chatRes.json().catch(() => null) as {
  content?: string; durable?: boolean; jobId?: string; error?: string
} | null
console.log(`◀ HTTP ${chatRes.status} sau ${((Date.now() - chatStart) / 1000).toFixed(1)}s — durable=${chatData?.durable} jobId=${chatData?.jobId || '-'}`)
if (chatData?.error) console.log(`  ⚠️ error: ${chatData.error}`)
if (!chatData?.jobId) { console.error('✗ không có jobId — dispatch thất bại'); process.exit(1) }
console.log(`\n✅ DISPATCH OK — job ${chatData.jobId} · session ${sessionId}`)
console.log(`   Theo dõi: tail -f /home/z/tmo-app/mission-watch-live.log`)
