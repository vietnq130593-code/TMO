// ============================================================================
// ROUND-44 E2E qua ROUTE APP (in-process, continueOnDisconnect=true) — workflow
// chạy bên trong process PM2 (ổn định, không chết như scratch process vì OOM).
// Pure fetch — không import heavy module.
// Chạy: bun run scratch/r44-route-team.ts
// ============================================================================
const BASE = 'http://localhost:3000'
const TASK = `Xây một ứng dụng fullstack nhỏ "Kho trích dẫn" trong /tmp/tmo-r44-quote-app: server.ts chạy bằng Bun lắng nghe port 8898, dùng module builtin bun:sqlite, tuyệt đối không cài thêm package. Database quotes.db với bảng quotes(id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL, author TEXT DEFAULT ''). REST API: GET /api/quotes liệt kê tất cả; POST /api/quotes nhận {text, author} trả 201; DELETE /api/quotes/:id trả 200. public/index.html gồm HTML/CSS/JavaScript thuần trong 1 file (không framework, không CDN) liệt kê trích dẫn, form thêm mới, nút xóa từng mục, gọi API đúng endpoint. Sau khi code xong phải khởi động server bằng tool run_bg trên port 8898 và chạy test API thật bằng curl đúng thứ tự: POST tạo 2 trích dẫn mẫu, GET đọc lại phải thấy đúng 2, DELETE xóa trích dẫn 1, GET lại phải còn đúng 1; xác nhận GET / trả HTML 200. Báo cáo kết quả từng bước kèm HTTP code và body rút gọn; không kết luận thành công nếu thiếu bằng chứng thực tế.`

// 1. Auth
const setupRes = await fetch(`${BASE}/api/auth/setup`, { credentials: 'same-origin' })
const setupData = await setupRes.json().catch(() => null)
const token = setupData?.token || ''
if (!token) { console.error('❌ không có token'); process.exit(1) }
console.log('✅ token')

// 2. Session (cần session thật để events persist — panel UI cũng thấy)
const sessRes = await fetch(`${BASE}/api/smolab/sessions`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'x-tmo-api-token': token },
  body: JSON.stringify({ mode: 'single', agentProfileId: 'cmutow3uj000cll3ogscfngmv', title: 'R44 E2E — Team SOP full pipeline' }),
})
const sessData = await sessRes.json().catch(() => null)
const sessionId = sessData?.session?.sessionId || ''
console.log('✅ session:', sessionId)
if (!sessionId) process.exit(1)

// 3. POST workflow (routing Mode C / Tier 2 như Omega round-43; SSE đọc 45s rồi ngắt —
//    continueOnDisconnect=true → workflow chạy tiếp trong app)
const controller = new AbortController()
const t0 = Date.now()
const wfRes = await fetch(`${BASE}/api/code-team/workflow`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'x-tmo-api-token': token },
  signal: controller.signal,
  body: JSON.stringify({
    messages: [{ role: 'user', content: TASK }],
    sessionId,
    userRequest: TASK,
    continueOnDisconnect: true,
    routing: {
      mode: 'C',
      tier: 2,
      score: 8,
      reasoning: 'R44 E2E: caller chỉ định routing Mode C, Tier 2 (mirror Omega round-43 TEST B)',
      parts: [
        { name: 'visual', type: 'visual', description: `Phần giao diện UI/UX: ${TASK}`, dependency: [] },
        { name: 'backend', type: 'backend', description: `Phần backend/logic: ${TASK}`, dependency: ['visual'] },
      ],
      spec: TASK,
    },
  }),
})
console.log('✅ workflow POST status:', wfRes.status, '— đọc SSE 45s...')
const reader = wfRes.body?.getReader()
const dec = new TextDecoder()
let saw = []
try {
  const deadline = Date.now() + 45_000
  while (Date.now() < deadline) {
    const { done, value } = await Promise.race([
      reader.read(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('read-timeout')), Math.max(1000, deadline - Date.now()))),
    ])
    if (done) break
    const text = dec.decode(value, { stream: true })
    for (const line of text.split('\n')) {
      const m = /^data: (.+)$/.exec(line)
      if (m) {
        try {
          const ev = JSON.parse(m[1])
          if (['workflow_start', 'agent_start', 'checkpoint', 'workflow_done', 'error'].includes(ev.type) || saw.length < 3) {
            saw.push(`${ev.type}:${ev.agent || ''}${ev.position ? `/${ev.position}` : ''}${ev.message ? ` ${String(ev.message).slice(0, 80)}` : ''}`)
          }
        } catch { /* skip */ }
      }
    }
  }
} catch { /* timeout — expected */ }
controller.abort()
console.log('✅ SSE events đầu tiên:')
for (const s of saw.slice(0, 8)) console.log('   ', s)
console.log(`\n📌 Workflow đang chạy IN-APP (session chat: ${sessionId}). Theo dõi qua scratch/r44-monitor-db.ts`)
console.log('📌 Kỳ vọng pipeline 7 bước: TL-analyze → TL-code → G1-design → G2-A-code → G2-B-review → G3-optimize → TL-verify')
process.exit(0)
