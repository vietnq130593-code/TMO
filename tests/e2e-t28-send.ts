// @ts-nocheck — E2E script chạy bằng bun (top-level await), không cần typecheck
// E2E TASK 28 (phiên 4) — 2 run TUẦN TỰ (tránh OOM — bài học Task 23/27):
//   RUN A (Omega, space-bunny): tác vụ quản trị buộc dùng create_custom_tool —
//     xây tool word_count_vn + đăng ký (tab Tools/Skills Smolab) + DÙNG NGAY.
//     → verify Yêu cầu 1 (tự xây tool thiếu + đăng ký hệ thống + dùng triển khai tiếp).
//   RUN B (BELI, muse-spark-1.3-contributor-free): tác vụ nhỏ — trên server này
//     muse-spark bị geo-block → phải fallback NIM. → verify Yêu cầu 3 (model mới
//     + chuỗi fallback không giết agent; model chạy trực tiếp sẽ có hiệu lực ở
//     môi trường local VN của user).
// Ghi kết quả từng run vào /tmp/e2e-t28-{a,b}.json. Chạy: bun run tests/e2e-t28-send.ts
const BASE = 'http://localhost:3000'

const setupRes = await fetch(`${BASE}/api/auth/setup`, { credentials: 'same-origin' })
const token = ((await setupRes.json().catch(() => null)) as { token?: string } | null)?.token || ''
if (!token) { console.error('NO TOKEN'); process.exit(1) }

const agentsRes = await fetch(`${BASE}/api/agents?enabled=true`, { headers: { 'x-tmo-api-token': token } })
const agentsData = await agentsRes.json().catch(() => null) as { agents?: Array<Record<string, unknown>> } | null
const omega = agentsData?.agents?.find(a => a.name === 'Omega')
const beli = agentsData?.agents?.find(a => a.name === 'BELI')
if (!omega || !beli) { console.error('AGENTS NOT FOUND', !!omega, !!beli); process.exit(1) }
console.log(`Omega model=${omega.model} | BELI model=${beli.model} (kỳ vọng: muse-spark-1.3-contributor-free)`)

async function makeSession(title: string, profileId: string): Promise<string> {
  const res = await fetch(`${BASE}/api/smolab/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-tmo-api-token': token },
    body: JSON.stringify({ mode: 'single', agentProfileId: profileId, title }),
  })
  const data = await res.json().catch(() => null) as { session?: { sessionId?: string } } | null
  return data?.session?.sessionId || ''
}

async function runAgent(agent: Record<string, unknown>, sessionId: string, prompt: string, outFile: string) {
  const t0 = Date.now()
  console.log(`\n=== RUN ${agent.name} (${agent.model}) — ${outFile} ===`)
  try {
    const chatRes = await fetch(`${BASE}/api/openclaw/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-tmo-api-token': token },
      body: JSON.stringify({
        messages: [{ role: 'user', content: prompt }],
        model: agent.model,
        sessionId,
        stream: false,
        agentInstruction: agent.instruction,
        agentTemperature: agent.temperature,
        agentMaxTokens: agent.maxTokens,
        agentProfileId: agent.id,
        agentProfileName: agent.name,
        agentProvider: agent.provider,
        agentModel: agent.model,
        teamMode: 'single',
        promptBudgetChars: -1,
      }),
    })
    const data = await chatRes.json().catch(() => null)
    const mins = ((Date.now() - t0) / 60000).toFixed(1)
    console.log(`HTTP ${chatRes.status} sau ${mins} phút`)
    const { writeFileSync } = await import('fs')
    writeFileSync(outFile, JSON.stringify({ status: chatRes.status, sessionId, minutes: mins, agent: agent.name, model: agent.model, data }, null, 2))
    console.log(`→ ${outFile}`)
  } catch (err) {
    console.error('RUN FAIL:', err instanceof Error ? err.message : String(err))
  }
}

// ===== RUN A — Omega: xây tool thiếu + đăng ký + dùng ngay (Yêu cầu 1) =====
const sessA = await makeSession('E2E-T28-A infra self-service tool', String(omega.id))
const { writeFileSync: wf } = await import('fs')
wf('/tmp/e2e-t28-a-session.txt', sessA)
console.log('SESSION A:', sessA)

const PROMPT_A = `Nhiệm vụ quản trị hệ thống (làm theo protocol goal-loop đầy đủ):
Hệ thống TMO đang thiếu một tool đếm từ cho văn bản tiếng Việt. Kiểm tra và xử lý:
1. Kiểm tra danh sách custom tool hiện có (list_custom_tools) — xác nhận chưa có tool đếm từ.
2. XÂY tool mới tên "word_count_vn": nhận parameter "text" (chuỗi), trả về số từ (tách theo khoảng trắng). Đăng ký qua create_custom_tool — tool sẽ vào tab Tools/Skills của module Smolab và các agent khác dùng được.
3. DÙNG NGAY tool vừa tạo để đếm số từ trong câu: "Hệ thống đa agent TMO vận hành ổn định và minh bạch" — báo cáo con số.
4. Kiểm định lại: gọi tool lần nữa với câu "Một hai ba bốn" — báo cáo con số (kỳ vọng 4).
Báo cáo cuối: đã làm · bằng chứng tool (tên tool + kết quả) · còn thiếu.`

await runAgent(omega, sessA, PROMPT_A, '/tmp/e2e-t28-a.json')

// ===== RUN B — BELI (muse-spark): tác vụ nhỏ, verify fallback NIM (Yêu cầu 3) =====
const sessB = await makeSession('E2E-T28-B muse-spark fallback', String(beli.id))
wf('/tmp/e2e-t28-b-session.txt', sessB)
console.log('SESSION B:', sessB)

const PROMPT_B = `Nhiệm vụ nhỏ (làm theo protocol): đọc file /home/z/tmo-app/package.json và báo cáo: (1) tên ứng dụng ("name"), (2) số dependencies trong "dependencies". Kiểm định bằng lệnh máy (grep/jq hoặc file_read + đếm máy), báo cáo 2 con số kèm bằng chứng tool.`

await runAgent(beli, sessB, PROMPT_B, '/tmp/e2e-t28-b.json')

console.log('\nDONE — kết quả: /tmp/e2e-t28-a.json + /tmp/e2e-t28-b.json')
