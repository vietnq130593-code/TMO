// E2E RUN 2 — gửi prompt đa bước cho Omega (fetch thuần — KHÔNG Prisma để
// tránh OOM khi chờ lâu). Ghi response vào /tmp/e2e2-response.json.
// Chạy: bun run tests/e2e2-send.ts

const BASE = 'http://localhost:3000'
const OMEGA_PROFILE_ID = 'cmugtfmxh000cng87m9h8vni3'

const setupRes = await fetch(`${BASE}/api/auth/setup`, { credentials: 'same-origin' })
const token = ((await setupRes.json().catch(() => null)) as { token?: string } | null)?.token || ''
if (!token) { console.error('NO TOKEN'); process.exit(1) }

// Profile Omega (đọc qua API agents — không cần Prisma)
const agentsRes = await fetch(`${BASE}/api/agents?enabled=true`, { headers: { 'x-tmo-api-token': token } })
const agentsData = await agentsRes.json().catch(() => null) as { agents?: Array<Record<string, unknown>> } | null
const omega = agentsData?.agents?.find((a) => a.id === OMEGA_PROFILE_ID) as Record<string, unknown> | undefined
if (!omega) { console.error('OMEGA NOT FOUND'); process.exit(1) }

const sessRes = await fetch(`${BASE}/api/smolab/sessions`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'x-tmo-api-token': token },
  body: JSON.stringify({ mode: 'single', agentProfileId: OMEGA_PROFILE_ID, title: 'E2E-3 fix verify' }),
})
const sessData = await sessRes.json().catch(() => null) as { session?: { sessionId?: string } } | null
const sessionId = sessData?.session?.sessionId || ''
if (!sessionId) { console.error('NO SESSION', JSON.stringify(sessData)); process.exit(1) }

const PROMPT = `Nhiệm vụ đa bước (làm theo protocol goal-loop đầy đủ):
1. Tạo thư mục /tmp/tmo-e2e3 và file /tmp/tmo-e2e3/notes.md với đúng 3 dòng: (a) tên ứng dụng (đọc /home/z/tmo-app/package.json), (b) port lắng nghe, (c) số agents đang bật (http://localhost:3000/api/agents?enabled=true).
2. Kiểm định file tồn tại và có đúng 3 dòng bằng tool thật.
3. Điều tra cơ chế: file_write mode "append" có THÊM nội dung vào cuối file mà KHÔNG ghi đè nội dung cũ không? Kiểm chứng bằng thử nghiệm: append 1 dòng "dòng 4" vào notes.md (trong /tmp/tmo-e2e3) rồi đọc lại file — so sánh trước/sau. Ghi nhận kết luận cơ chế bằng hypothesis_write kèm phán quyết judge dựa trên bằng chứng thật.
4. Báo cáo cuối theo protocol: đã làm · bằng chứng tool · còn thiếu · 2 dòng ✅/❓ · khối 📐 BIÊN ĐỘ DỮ LIỆU.`

console.log(`SESSION: ${sessionId}`)
const { writeFileSync } = await import('fs')
writeFileSync('/tmp/e2e2-session.txt', sessionId)

const t0 = Date.now()
console.log(`Gửi prompt (${PROMPT.length} chars) — chờ goal-loop...`)
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
    agentProfileId: OMEGA_PROFILE_ID,
    agentProfileName: 'Omega',
    agentProvider: omega.provider,
    agentModel: omega.model,
    teamMode: 'single',
  }),
})
const chatData = await chatRes.json().catch(() => null)
const mins = ((Date.now() - t0) / 60000).toFixed(1)
console.log(`HTTP ${chatRes.status} sau ${mins} phút`)
writeFileSync('/tmp/e2e2-response.json', JSON.stringify({ status: chatRes.status, sessionId, minutes: mins, data: chatData }, null, 2))
console.log('DONE — response lưu /tmp/e2e2-response.json')
export {}
