// @ts-nocheck — E2E script chạy bằng bun (top-level await), không cần typecheck
/**
 * E2E Task 34 — Verify chuỗi Zen: HTTP 403 (mark cache) → CLI FreeTierError
 * (mark cache) → ZEN FAILOVER space-bunny OK; lần 2 skip thẳng (nhanh hơn).
 */
const BASE = 'http://localhost:3000'

async function main() {
  const setupRes = await fetch(`${BASE}/api/auth/setup`, { credentials: 'same-origin' })
  const token = ((await setupRes.json().catch(() => null)) as { token?: string } | null)?.token || ''
  if (!token) { console.error('NO TOKEN'); process.exit(1) }
  const H = { 'Content-Type': 'application/json', 'x-tmo-api-token': token }

  // BELI = muse-spark-1.3-contributor-free (model bị chặn free-tier)
  const agentsRes = await fetch(`${BASE}/api/agents?enabled=true`, { headers: H })
  const agentsData = await agentsRes.json().catch(() => null) as { agents?: Array<Record<string, unknown>> } | null
  const beli = agentsData?.agents?.find(a => String(a.name).toLowerCase().includes('beli'))
  if (!beli) { console.error('BELI NOT FOUND'); process.exit(1) }
  console.log(`Agent: ${beli.name} (model ${beli.model}, provider ${beli.provider})`)

  const sessRes = await fetch(`${BASE}/api/smolab/sessions`, {
    method: 'POST', headers: H,
    body: JSON.stringify({ mode: 'single', agentProfileId: beli.id, title: 'E2E T34 zen failover cache' }),
  })
  const sessData = await sessRes.json().catch(() => null) as { session?: { sessionId?: string } } | null
  const sessionId = sessData?.session?.sessionId || ''
  if (!sessionId) { console.error('NO SESSION', JSON.stringify(sessData)); process.exit(1) }

  for (let round = 1; round <= 2; round++) {
    const t0 = Date.now()
    const res = await fetch(`${BASE}/api/openclaw/chat`, {
      method: 'POST', headers: H,
      body: JSON.stringify({
        messages: [{ role: 'user', content: `Tính nhanh (chỉ trả lời số): 17 + 26 = ? (lượt ${round})` }],
        agentName: beli.name,
        sessionId,
        stream: false,
      }),
    })
    const ms = Date.now() - t0
    const text = await res.text()
    let answer = ''
    try {
      const j = JSON.parse(text)
      answer = (j.message?.content || j.content || j.text || JSON.stringify(j)).slice(0, 150)
    } catch { answer = text.slice(0, 150) }
    console.log(`\n=== LƯỢT ${round}: HTTP ${res.status} — ${ms}ms ===`)
    console.log(`Answer: ${answer}`)
  }
  process.exit(0)
}
main().catch(e => { console.error('FATAL', e); process.exit(1) })
