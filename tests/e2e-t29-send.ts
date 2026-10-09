// @ts-nocheck — E2E script chạy bằng bun (top-level await), không cần typecheck
// E2E TASK 29 (phiên 5) — RUN A (Omega, nemotron-3-ultra-free):
//   Tác vụ quản trị vận hành THẬT (không phải prompt test chức năng): kiểm toán
//   chính sách model zen toàn hệ thống 13 agents — buộc Omega tra cứu roster,
//   đối chiếu từng agent, kiểm định chéo nguồn độc lập, báo cáo tuân thủ.
//   → Verify gián tiếp: model switch space-bunny-free → nemotron-3-ultra-free
//     hoạt động end-to-end trên chuỗi goal-loop thật (Zen HTTP → CLI → failover).
//   Ground truth (đã set trước): 13/13 agents ĐÚNG chính sách, 0 vi phạm.
// Ghi kết quả vào /tmp/e2e-t29-a.json. Chạy: bun run tests/e2e-t29-send.ts
const BASE = 'http://localhost:3000'

const setupRes = await fetch(`${BASE}/api/auth/setup`, { credentials: 'same-origin' })
const token = ((await setupRes.json().catch(() => null)) as { token?: string } | null)?.token || ''
if (!token) { console.error('NO TOKEN'); process.exit(1) }

const agentsRes = await fetch(`${BASE}/api/agents?enabled=true`, { headers: { 'x-tmo-api-token': token } })
const agentsData = await agentsRes.json().catch(() => null) as { agents?: Array<Record<string, unknown>> } | null
const omega = agentsData?.agents?.find(a => a.name === 'Omega')
if (!omega) { console.error('OMEGA NOT FOUND'); process.exit(1) }
console.log(`Omega model=${omega.model} (kỳ vọng: nemotron-3-ultra-free)`)
if (omega.model !== 'nemotron-3-ultra-free') {
  console.error('SAI MODEL — hủy test'); process.exit(1)
}

const sessRes = await fetch(`${BASE}/api/smolab/sessions`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'x-tmo-api-token': token },
  body: JSON.stringify({ mode: 'single', agentProfileId: String(omega.id), title: 'E2E-T29-A Omega nemotron-3-ultra audit' }),
})
const sessData = await sessRes.json().catch(() => null) as { session?: { sessionId?: string } } | null
const sessionId = sessData?.session?.sessionId || ''
const { writeFileSync } = await import('fs')
writeFileSync('/tmp/e2e-t29-a-session.txt', sessionId)
console.log('SESSION:', sessionId)

const PROMPT = `Nhiệm vụ quản trị vận hành hệ thống (thực hiện theo protocol goal-loop đầy đủ):
Hệ thống TMO vừa chốt chính sách model trên provider zen (OpenCode Zen):
- Nhóm lãnh đạo (Omega, Opus, và 2 Team Lead: MEGATRON của team code, NEMESIS của team research) phải dùng model "nemotron-3-ultra-free".
- Toàn bộ generator agents còn lại (SHOCWAVE, RAMPAGE, SENTINEL, CATALYST của team code; SIVIL, BELI, LISMA, HAN của team research; ALISTA kỹ sư bảo trì) phải dùng model "muse-spark-1.3-contributor-free".
Nhiệm vụ kiểm toán sau khi áp dụng chính sách:
1. Rà soát danh sách agents hiện có trong hệ thống cùng model đang cấu hình thực tế (dùng tool tra cứu roster/agents — không đoán mò).
2. Đối chiếu TỪNG agent với chính sách trên — phân loại ĐÚNG hay SAI.
3. Với agent sai chính sách (nếu có): nêu rõ tên + model hiện tại + model đúng.
4. Kiểm định chéo bằng ít nhất một nguồn độc lập với nguồn ở bước 1 (vd truy vấn dữ liệu hệ thống bằng cách khác) — xác nhận kết quả bước 2 không sai lệch.
Báo cáo cuối theo chuẩn: bảng đối chiếu đủ 13 agents (tên + team + model hiện tại + đúng/sai chính sách) · kết luận tỷ lệ tuân thủ · danh sách vi phạm (nếu có) · bằng chứng tool đã dùng · còn thiếu sót.`

const t0 = Date.now()
console.log('\n=== RUN Omega (nemotron-3-ultra-free) — audit chính sách model ===')
try {
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
  })
  const data = await chatRes.json().catch(() => null)
  const mins = ((Date.now() - t0) / 60000).toFixed(1)
  console.log(`HTTP ${chatRes.status} sau ${mins} phút`)
  writeFileSync('/tmp/e2e-t29-a.json', JSON.stringify({ status: chatRes.status, sessionId, minutes: mins, model: omega.model, data }, null, 2))
  console.log(`→ /tmp/e2e-t29-a.json`)
  // In tóm tắt nội dung trả lời để quan sát nhanh
  const content = data?.choices?.[0]?.message?.content || data?.content || data?.message?.content || ''
  if (content) console.log('\n--- TÓM TẮT TRẢ LỜI (800 chars) ---\n' + String(content).slice(0, 800))
  else console.log('\n(keys của response:', Object.keys(data || {}).join(', '), ')')
} catch (err) {
  console.error('RUN FAIL:', err instanceof Error ? err.message : String(err))
}
