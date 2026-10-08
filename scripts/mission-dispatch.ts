// ============================================================================
// scripts/mission-dispatch.ts — DISPATCHER MISSION CHUẨN HÓA (r64.2)
//
// THỂ CHẾ HÓA chỉ đạo user (round-64.1, sau mission #18): mission mới BẮT
// BUỘC kèm TIÊU CHÍ NGHIỆM THU từng mục — chống ping-pong kiểu mission
// (nhiệm vụ bị đánh giá mơ hồ → tái dispatch lặp lại không hồi kết).
// Mission #18 dispatch tay (scratch/r64-dispatch.ts) đã chứng minh cơ chế
// hoạt động: evaluator bám đúng danh sách nghiệm thu thay vì đòi "báo cáo
// cuối" chung chung. Script này biến kỷ luật đó THÀNH CÔNG CỤ có guard máy.
//
// GUARD CHỐNG PING-PONG (kiểm tra TRƯỚC khi dispatch — fail-fast):
//   Directive PHẢI chứa khối "Nghiệm thu:" (hoặc "Tiêu chí nghiệm thu:")
//   với ≥1 mục "- [ ] …" — khớp parser extractDirectiveSpec của
//   agent-goal-loop.ts (RunContext.acceptanceCriteria + todo-coverage
//   "mỗi [Nghiệm thu n] ≥ 1 todo" + evaluator checklist cuối chu kỳ).
//
// Chạy:
//   bun run scripts/mission-dispatch.ts \
//     --directive scratch/<file-directive>.txt \
//     --profile <AgentProfileId> \
//     --title "Tên mission" [--mode single]
// ============================================================================
process.env.DATABASE_URL ??= 'file:/home/z/tmo-app/db/custom.db'

import { readFileSync } from 'fs'

const BASE = 'http://localhost:3000'

// ── Args ──
function argOf(name: string): string | null {
  const idx = process.argv.indexOf(name)
  if (idx === -1) return null
  const value = process.argv[idx + 1]
  return value && !value.startsWith('--') ? value : null
}
const directivePath = argOf('--directive')
const profileId = argOf('--profile')
const title = argOf('--title') ?? 'Mission (không tên)'
const mode = argOf('--mode') ?? 'single'
if (!directivePath || !profileId) {
  console.error('Dùng: bun run scripts/mission-dispatch.ts --directive <file> --profile <AgentProfileId> --title "<tên>" [--mode single]')
  process.exit(1)
}

const PROMPT = readFileSync(directivePath, 'utf8').trim()

// ── GUARD: nghiệm thu bắt buộc (mirror extractDirectiveSpec — giữ đồng bộ
//    chủ đích với agent-goal-loop.ts: parser đó phục vụ runtime, guard này
//    phục vụ operator fail-fast trước khi tốn token) ──
function extractAcceptance(raw: string): string[] {
  const items = new Set<string>()
  // (a) Khối checklist "Nghiệm thu:" + các dòng "- [ ] …" (dạng chuẩn hoá).
  const block = raw.match(
    /(?:Tiêu chí )?[Nn]ghiệm thu[^:\n]*:\s*([\s\S]*?)(?=\n\s*\n|\n\s*[•🏁🔍💡📊🚨⚖️]|$)/
  )
  if (block) {
    for (const line of block[1].split('\n')) {
      const item = line
        .replace(/^\s*-\s*\[[ xX]\]\s*/, '')
        .replace(/^\s*-\s*/, '')
        .trim()
      if (item && item.length > 3) items.add(item)
    }
  }
  // (b) Per-item "Nghiệm thu: <điều kiện>" — format mission #18 (mỗi hạng mục
  // một dòng) đã chứng minh hiệu quả với evaluator; parser harness chỉ bắt
  // block đầu nên guard bổ sung đường này để không từ chối nhầm format thật.
  for (const m of raw.matchAll(/^[^\S\n]*[Nn]ghiệm thu[^:\n]*:[ \t]*(\S.*)$/gm)) {
    const item = m[1].trim()
    if (item.length > 3) items.add(item)
  }
  return [...items]
}
const acceptance = extractAcceptance(PROMPT)
if (acceptance.length === 0) {
  console.error('✗ TỪ CHỐI DISPATCH — directive KHÔNG có khối "Nghiệm thu:" hợp lệ (≥1 mục "- [ ] …").')
  console.error('  Chống ping-pong kiểu mission: mỗi mục phải kèm tiêu chí nghiệm thu ĐỐI CHIẾU ĐƯỢC')
  console.error('  (tên file tạo/số test/lệnh chạy/kết quả đo) — worked-example: scratch/r64-directive.txt.')
  process.exit(1)
}
console.log(`▶ Guard nghiệm thu PASS — ${acceptance.length} tiêu chí:`)
acceptance.forEach((a, i) => console.log(`   [Nghiệm thu ${i + 1}] ${a.slice(0, 100)}`))

// ── 1. Auth token ──
const setupRes = await fetch(`${BASE}/api/auth/setup`, { credentials: 'same-origin' })
const setupData = (await setupRes.json().catch(() => null)) as { token?: string } | null
const token = setupData?.token || ''
if (!token) {
  console.error('✗ không lấy được auth token')
  process.exit(1)
}

// ── 2. Session quan sát (đúng pattern obsv r59/r61/r64) ──
const sessRes = await fetch(`${BASE}/api/smolab/sessions`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'x-tmo-api-token': token },
  body: JSON.stringify({ mode, agentProfileId: profileId, title }),
})
const sessData = (await sessRes.json().catch(() => null)) as
  | { session?: { sessionId?: string } }
  | null
const sessionId = sessData?.session?.sessionId || ''
if (!sessionId) {
  console.error('✗ không tạo được session')
  process.exit(1)
}
console.log(`▶ Session: ${sessionId}`)

// ── 3. Profile thật từ DB (model/instruction/params) ──
const { Database } = await import('bun:sqlite')
const db = new Database('/home/z/tmo-app/db/custom.db', { readonly: true })
const profile = db
  .query(
    'SELECT name, provider, model, instruction, temperature, "maxTokens" as maxTokens FROM AgentProfile WHERE id = ?'
  )
  .get(profileId) as
  | { name: string; provider: string; model: string; instruction: string | null; temperature: number | null; maxTokens: number | null }
  | undefined
db.close()
if (!profile) {
  console.error(`✗ không tìm thấy AgentProfile ${profileId}`)
  process.exit(1)
}

// ── 4. Dispatch qua POST /api/openclaw/chat (đường UI, durable goal loop) ──
console.log(`▶ Directive: ${PROMPT.length} chars — dispatch lúc ${new Date().toISOString()}`)
const chatStart = Date.now()
const chatRes = await fetch(`${BASE}/api/openclaw/chat`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'x-tmo-api-token': token },
  body: JSON.stringify({
    messages: [{ role: 'user', content: PROMPT }],
    model: profile.model,
    sessionId,
    stream: false,
    agentInstruction: profile.instruction,
    agentTemperature: profile.temperature,
    agentMaxTokens: profile.maxTokens,
    agentProfileId: profileId,
    agentProfileName: profile.name,
    agentProvider: profile.provider,
    agentModel: profile.model,
    teamMode: mode,
  }),
})
const chatData = (await chatRes.json().catch(() => null)) as {
  content?: string
  durable?: boolean
  jobId?: string
  error?: string
} | null
console.log(
  `◀ HTTP ${chatRes.status} sau ${((Date.now() - chatStart) / 1000).toFixed(1)}s — durable=${chatData?.durable} jobId=${chatData?.jobId || '-'}`
)
if (chatData?.error) console.log(`  ⚠️ error: ${chatData.error}`)
if (!chatData?.jobId) {
  console.error('✗ không có jobId — dispatch thất bại')
  process.exit(1)
}
console.log(`\n✅ DISPATCH OK — job ${chatData.jobId} · session ${sessionId}`)
console.log(`   Theo dõi: tail -f /home/z/tmo-app/mission-watch-live.log`)
