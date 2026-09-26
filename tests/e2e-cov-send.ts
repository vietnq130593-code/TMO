// E2E TODO-COVERAGE — gửi prompt có khối "Nghiệm thu:" cho Omega (goal-loop
// thật), quan sát: (1) stash nghiệm thu vào RunContext lúc run start,
// (2) todo_write đầu có thể thiếu tiêu chí → coverage warning trong kết quả
// tool, (3) agent có bổ sung todo theo warning không.
// Chạy: bun run tests/e2e-cov-send.ts   (server phải đang chạy port 3000)

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
  body: JSON.stringify({ mode: 'single', agentProfileId: omega.id, title: 'E2E todo-coverage' }),
})
const sessData = await sessRes.json().catch(() => null) as { session?: { sessionId?: string } } | null
const sessionId = sessData?.session?.sessionId || ''
if (!sessionId) { console.error('NO SESSION', JSON.stringify(sessData)); process.exit(1) }

const PROMPT = `Nhiệm vụ kiểm thử dữ liệu (làm theo protocol goal-loop đầy đủ GĐ0→GĐ3 — nhớ lập todo_write ngay GĐ1):

Tạo bộ dữ liệu kiểm thử trong /tmp/tmo-cov-e2e:
1. Tạo file /tmp/tmo-cov-e2e/config.json với nội dung JSON hợp lệ {"app":"TMO","version":"<đọc version thật từ /home/z/tmo-app/package.json>"}
2. Tạo file /tmp/tmo-cov-e2e/README.md ghi đúng 2 dòng mô tả cấu trúc thư mục
3. Kiểm định cả 2 file bằng tool thật

Nghiệm thu:
- [ ] File config.json tồn tại với nội dung JSON hợp lệ chứa đúng version thật
- [ ] File README.md tồn tại có đúng 2 dòng
- [ ] Cả 2 file được kiểm định bằng tool thật (đọc lại + đếm dòng bằng lệnh máy)
- [ ] Báo cáo cuối có khối 📐 BIÊN ĐỘ DỮ LIỆU ngắn + 2 dòng ✅/❓ tự phản chiếu`

console.log(`SESSION: ${sessionId}`)
const { writeFileSync } = await import('fs')
writeFileSync('/tmp/e2e-cov-session.txt', sessionId)

const t0 = Date.now()
console.log(`Gửi prompt (${PROMPT.length} chars) — ngắt client sau 25s (goal-loop TIẾP TỤC server-side — đã kiểm chứng), theo dõi bằng e2e-cov-verify.ts...`)
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
  signal: AbortSignal.timeout(25_000), // ngắt client — server vẫn chạy (fetch Bun mặc định 300s không đủ)
}).catch((err: unknown) => {
  // Timeout/abort là KỲ VỌNG — goal-loop chạy server-side độc lập client
  console.log(`Client ngắt kết nối như dự kiến (${err instanceof Error ? err.name : 'unknown'}) — server tiếp tục xử lý`)
  return null
})
if (chatRes) {
  const chatData = await chatRes.json().catch(() => null)
  const mins = ((Date.now() - t0) / 60000).toFixed(1)
  console.log(`HTTP ${chatRes.status} sau ${mins} phút (nhanh hơn dự kiến)`)
  const { writeFileSync: wf } = await import('fs')
  wf('/tmp/e2e-cov-response.json', JSON.stringify({ status: chatRes.status, sessionId, data: chatData }, null, 2))
}
console.log('DONE — chạy: bun run tests/e2e-cov-verify.ts')
export {}
