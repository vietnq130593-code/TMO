// E2E UNCERTAINTY LEDGER + RICH RUN SUMMARY — gửi prompt thật cho Omega
// (goal-loop thật), verify: (1) mục ❓ từ báo cáo được harness trích thành
// ledger sống trong RunContext (phản chiếu = năng lực TRONG quy trình — không
// chỉ là chữ trong báo cáo), (2) ChatMessage metadata agentRun.events mang
// TÊN TOOL đầy đủ (fix "không thấy tên tool — chỉ có ký hiệu").
// Chạy: bun run tests/e2e-unc-send.ts   (server phải đang chạy port 3000)

const BASE = 'http://localhost:3000'

const setupRes = await fetch(`${BASE}/api/auth/setup`, { credentials: 'same-origin' })
const token = ((await setupRes.json().catch(() => null)) as { token?: string } | null)?.token || ''
if (!token) { console.error('NO TOKEN'); process.exit(1) }

// Tìm Omega (theo tên — không phụ thuộc ID cứng)
const agentsRes = await fetch(`${BASE}/api/agents?enabled=true`, { headers: { 'x-tmo-api-token': token } })
const agentsData = await agentsRes.json().catch(() => null) as { agents?: Array<Record<string, unknown>> } | null
const omega = agentsData?.agents?.find((a) => String(a.name).toLowerCase().includes('omega'))
if (!omega) { console.error('OMEGA NOT FOUND'); process.exit(1) }
console.log(`Agent: ${omega.name} (id ${omega.id}, model ${omega.model})`)

const sessRes = await fetch(`${BASE}/api/smolab/sessions`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'x-tmo-api-token': token },
  body: JSON.stringify({ mode: 'single', agentProfileId: omega.id, title: 'E2E uncertainty-ledger' }),
})
const sessData = await sessRes.json().catch(() => null) as { session?: { sessionId?: string } } | null
const sessionId = sessData?.session?.sessionId || ''
if (!sessionId) { console.error('NO SESSION', JSON.stringify(sessData)); process.exit(1) }

const PROMPT = `Nhiệm vụ kiểm thử phản chiếu trong quy trình (làm theo protocol goal-loop đầy đủ GĐ0→GĐ3 — nhớ todo_write ngay GĐ1):

Trong /tmp/tmo-unc-e2e:
1. Tạo file notes.txt với đúng 3 dòng: dòng 1-2 ghi chú ngắn về cấu trúc, dòng 3 ghi "Số lần uncertainItems xuất hiện trong schema: N" (N đếm bằng LỆNH MÁY grep -c trên /home/z/tmo-app/prisma/schema.prisma)
2. Kiểm định notes.txt bằng tool thật (đọc lại + đếm dòng bằng lệnh máy)
3. DỰ ĐOÁN (chưa kiểm chứng — đây là giả thuyết): viết 1 câu dự đoán ngắn về việc ledger ❓ sẽ giúp chu kỳ sau như thế nào — câu này là GIẢ THUYẾT chưa kiểm chứng, PHẢI xếp vào dòng ❓ của phần tự phản chiếu, KHÔNG xếp ✅.

Nghiệm thu:
- [ ] notes.txt tồn tại đúng 3 dòng
- [ ] Số N trong dòng 3 được đếm bằng lệnh máy (grep -c) — KHÔNG đếm bằng mắt
- [ ] Báo cáo cuối có khối 📐 BIÊN ĐỘ DỮ LIỆU + 2 dòng ✅/❓; câu dự đoán ở mục 3 PHẢI nằm trong dòng ❓`

console.log(`SESSION: ${sessionId}`)
const { writeFileSync } = await import('fs')
writeFileSync('/tmp/e2e-unc-session.txt', sessionId)

const t0 = Date.now()
console.log(`Gửi prompt (${PROMPT.length} chars) — ngắt client sau 25s (goal-loop TIẾP TỤC server-side), theo dõi bằng e2e-unc-verify.ts...`)
const chatRes = await fetch(`${BASE}/api/openclaw/chat`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'x-tmo-api-token': token },
  body: JSON.stringify({
    messages: [{ role: 'user', content: PROMPT }],
    model: omega.model,
    sessionId,
    stream: false,
    agentInstruction: omega.instruction,
    agentTemperature: omega.temperature,
    agentMaxTokens: omega.maxTokens,
    agentProfileId: omega.id,
    agentProfileName: omega.name,
    agentProvider: omega.provider,
    agentModel: omega.model,
    teamMode: 'single',
  }),
  signal: AbortSignal.timeout(25_000),
}).catch((err: unknown) => {
  console.log(`Client ngắt kết nối như dự kiến (${err instanceof Error ? err.name : 'unknown'}) — server tiếp tục xử lý`)
  return null
})
if (chatRes) {
  const chatData = await chatRes.json().catch(() => null)
  const mins = ((Date.now() - t0) / 60000).toFixed(1)
  console.log(`HTTP ${chatRes.status} sau ${mins} phút`)
  const { writeFileSync: wf } = await import('fs')
  wf('/tmp/e2e-unc-response.json', JSON.stringify({ status: chatRes.status, sessionId, data: chatData }, null, 2))
}
console.log('DONE — chạy: bun run tests/e2e-unc-verify.ts')
export {}
