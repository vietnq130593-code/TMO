// ============================================================================
// ROUND-45 E2E VERIFY — chạy 1 workflow Code Team THẬT qua POST
// /api/code-team/workflow (đường UI dùng) và đối chiếu 6 fix round-45:
//   K1. KHÔNG còn "⚠️ Đạt max N vòng iteration" / "Đạt giới hạn token step"
//       (bỏ cap hardcode — thiết kế không giới hạn của user)
//   K2. agent_complete rows có metadata.agentReport (báo cáo agent → panel
//       "Quá trình thực thi", hết bubble chat 29KB kiểu SHOCWAVE)
//   K3. Có row omega_final_report — Omega (điều phối viên) báo cáo công việc
//       cuối cùng sau khi team hoàn thành
//   K4. Sản phẩm thật: file r45-e2e-check.md tồn tại trong workspace root
//   K5. Todos: đa số todo của các step run ở trạng thái completed sau run
//       (auto-complete theo bằng chứng + todo-gate)
//   K6. Plan-first: nếu agent định ghi file trước khi có kế hoạch → tool bị
//       chặn kèm "PLAN-FIRST"; nếu agent plan trước (đúng kỷ luật) → thứ tự
//       todo_write đứng trước file_write — ghi nhận evidence cả 2 trường hợp
//
// Chạy: bun run scratch/r45-e2e-verify.ts
// ============================================================================
process.env.DATABASE_URL = 'file:/home/z/tmo-app/db/custom.db'

import { db } from '../src/lib/db'

const BASE = 'http://localhost:3000'

const PROMPT = `Tạo file "r45-e2e-check.md" ở thư mục gốc workspace với đúng 2 dòng: dòng 1 là "R45-E2E-OK", dòng 2 là timestamp hiện tại (ISO 8601). Sau đó verify bằng tool rằng file tồn tại và chứa đúng 2 dòng đó. Đây là việc nhỏ (1 file), không cần phức tạp.`

let pass = 0, fail = 0
const fails: string[] = []
function ok(name: string, cond: boolean, detail = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; fails.push(name); console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`) }
}

// ── 1. Auth ──
const setupRes = await fetch(`${BASE}/api/auth/setup`, { credentials: 'same-origin' })
const setupData = await setupRes.json().catch(() => null) as { token?: string } | null
const token = setupData?.token || ''
ok('E1 auth token', !!token)

// ── 2. Tạo team session (code team) ──
const sessRes = await fetch(`${BASE}/api/smolab/sessions`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'x-tmo-api-token': token },
  body: JSON.stringify({ mode: 'multi', teamName: 'code', title: 'R45 E2E verify' }),
})
const sessData = await sessRes.json().catch(() => null) as { session?: { sessionId?: string } } | null
const sessionId = sessData?.session?.sessionId || ''
ok('E2 tạo team session', !!sessionId, JSON.stringify(sessData || {}).slice(0, 120))
console.log(`▶ Session: ${sessionId}`)

// ── 3. Workspace root (để verify sản phẩm) ──
const ws = await db.workspace.findFirst({ where: { isActive: true } })
const workspaceRoot = ws?.rootPath || '/home/z/tmo-app'
console.log(`▶ Workspace root: ${workspaceRoot}`)

// ── 4. POST workflow + đọc SSE tới khi workflow_done (max 8.5 phút) ──
console.log(`▶ Gửi workflow (${PROMPT.length} chars)...`)
const wfStart = Date.now()
const controller = new AbortController()
const SSE_TIMEOUT_MS = 8.5 * 60 * 1000
const timeoutId = setTimeout(() => controller.abort(), SSE_TIMEOUT_MS)

const events: Array<Record<string, unknown>> = []
let streamClosed = false
try {
  const res = await fetch(`${BASE}/api/code-team/workflow`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-tmo-api-token': token },
    body: JSON.stringify({
      messages: [{ role: 'user', content: PROMPT }],
      sessionId,
      userRequest: PROMPT,
    }),
    signal: controller.signal,
  })
  ok('E3 workflow API trả 200', res.status === 200, `status=${res.status}`)
  if (res.body) {
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''
      for (const line of lines) {
        const t = line.trim()
        if (!t.startsWith('data: ')) continue
        try {
          const ev = JSON.parse(t.slice(6)) as Record<string, unknown>
          events.push(ev)
          if (ev.type === 'workflow_done') {
            console.log(`▶ workflow_done: status=${ev.status} sau ${((Date.now() - wfStart) / 1000).toFixed(0)}s`)
          }
        } catch { /* heartbeat / partial */ }
      }
    }
  }
  streamClosed = true
} catch (err) {
  // Timeout/abort — workflow chạy nền (continueOnDisconnect) → vẫn poll DB
  console.log(`▶ SSE client ngắt sau ${((Date.now() - wfStart) / 1000).toFixed(0)}s (${err instanceof Error ? err.message : String(err)}) — workflow nền tiếp tục, poll DB...`)
} finally {
  clearTimeout(timeoutId)
}

// ── 5. Poll DB tới khi workflow_done row xuất hiện (nếu stream chưa thấy) ──
async function dbRows(): Promise<Array<{ id: string; role: string; content: string; metadata: string | null }>> {
  return db.chatMessage.findMany({
    where: { sessionId },
    orderBy: { createdAt: 'asc' },
  }) as unknown as Array<{ id: string; role: string; content: string; metadata: string | null }>
}

let rows = await dbRows()
const deadline = Date.now() + 6 * 60 * 1000
while (
  Date.now() < deadline &&
  !rows.some(r => {
    try { return (JSON.parse(r.metadata || '{}') as { workflowStatus?: string }).workflowStatus != null } catch { return false }
  })
) {
  await new Promise(r => setTimeout(r, 10_000))
  rows = await dbRows()
  process.stdout.write(`  ... poll ${rows.length} rows (${((Date.now() - wfStart) / 1000).toFixed(0)}s)\n`)
}

const totalDurationS = ((Date.now() - wfStart) / 1000).toFixed(0)
console.log(`▶ Stream ${streamClosed ? 'đóng tự nhiên' : 'ngắt'} + DB ${rows.length} rows sau ${totalDurationS}s`)

// ── 6. Đối chiếu K1..K6 ──
type Meta = {
  isTeamMessage?: boolean; agentName?: string; agentPosition?: string
  agentReport?: boolean; omegaFinalReport?: boolean; omegaEscalation?: boolean
  workflowStatus?: string; workflowFinalReport?: boolean
  toolCallInfo?: { tool?: string }; toolResult?: { preview?: string }
  teamStep?: string; teamThought?: boolean
}
const parsed = rows.map(r => {
  let m: Meta = {}
  try { m = JSON.parse(r.metadata || '{}') as Meta } catch { /* row thường */ }
  return { ...r, m }
})

// K1 — không còn cap messages
const capMsgs = parsed.filter(r =>
  r.content.includes('⚠️ Đạt max ') || r.content.includes('Đạt giới hạn token step')
)
ok('K1 KHÔNG còn "Đạt max N vòng" / "giới hạn token step" (thiết kế không giới hạn)', capMsgs.length === 0,
  capMsgs.length > 0 ? `vẫn còn ${capMsgs.length} tin: "${capMsgs[0].content.slice(0, 90)}"` : '')

// K2 — agent_complete rows có agentReport
const agentCompleteRows = parsed.filter(r => r.m.agentReport === true)
const legacyCompleteRows = parsed.filter(r =>
  r.m.isTeamMessage && r.m.agentName && typeof (r.m as { durationMs?: number }).durationMs === 'number' && r.m.agentReport !== true
    && !r.m.toolCallInfo && !r.m.teamStep && !r.m.teamThought && !r.m.toolResult
)
ok('K2 agent_complete rows có metadata.agentReport (→ panel, hết bubble chat dài)',
  agentCompleteRows.length > 0 && legacyCompleteRows.length === 0,
  `agentReport=${agentCompleteRows.length}, legacy-không-marker=${legacyCompleteRows.length}`)
for (const r of agentCompleteRows) {
  console.log(`    • ${r.m.agentName} (${r.m.agentPosition}): ${(r.m as { durationMs?: number }).durationMs ?? '?'}ms, ${r.content.length} chars → PANEL`)
}

// K3 — Omega final report
const omegaRows = parsed.filter(r => r.m.omegaFinalReport === true)
ok('K3 Omega báo cáo công việc cuối cùng (omega_final_report)', omegaRows.length >= 1,
  omegaRows.length === 0 ? 'không thấy row omegaFinalReport' : '')
if (omegaRows.length > 0) {
  console.log(`    • Omega (${omegaRows[0].content.length} chars): "${omegaRows[0].content.slice(0, 220).replace(/\n/g, ' ')}..."`)
}

// K4 — sản phẩm thật
let productOk = false
let productDetail = ''
try {
  const { readFileSync, existsSync } = await import('fs')
  const path = `${workspaceRoot.replace(/\/$/, '')}/r45-e2e-check.md`
  if (existsSync(path)) {
    const content = readFileSync(path, 'utf8')
    productOk = content.includes('R45-E2E-OK') && content.trim().split('\n').length >= 2
    productDetail = productOk ? `file ${path} ✓` : `file ${path} nội dung sai: ${content.slice(0, 80)}`
  } else {
    productDetail = `file ${path} KHÔNG tồn tại`
  }
} catch (err) { productDetail = `lỗi đọc: ${err instanceof Error ? err.message : String(err)}` }
ok('K4 sản phẩm thật (r45-e2e-check.md đúng nội dung)', productOk, productDetail)

// K5 — Todos sau run
const todos = await db.todo.findMany({
  where: {
    sessionId,
    OR: [
      { idempotencyKey: null },
      { NOT: { idempotencyKey: { startsWith: `${sessionId}:` } } },
    ],
  },
})
const todoCompleted = todos.filter(t => t.status === 'completed').length
const todoTotal = todos.length
if (todoTotal === 0) {
  console.log('  ℹ️ K5 agents không dùng todo_write trong run này (task nhỏ) — không có todo để đo')
} else {
  ok(`K5 todos hoàn thành sau run (${todoCompleted}/${todoTotal})`,
    todoCompleted === todoTotal,
    `còn ${todoTotal - todoCompleted} mở: ${todos.filter(t => t.status !== 'completed').slice(0, 3).map(t => `[${t.status}] ${t.content.slice(0, 60)}`).join(' | ')}`)
}

// K6 — Plan-first evidence
const toolRows = parsed.filter(r => r.m.toolResult?.preview || r.m.toolCallInfo)
const firstPlanIdx = rows.findIndex(r => r.m.toolCallInfo?.tool === 'todo_write' || r.m.toolCallInfo?.tool === 'decompose_task')
const firstMutatingIdx = rows.findIndex(r => ['file_write', 'file_edit', 'file_multi_edit'].includes(r.m.toolCallInfo?.tool || ''))
const planFirstBlock = parsed.find(r => (r.m.toolResult?.preview || '').includes('PLAN-FIRST'))
if (planFirstBlock) {
  ok('K6 plan-first harness CHẶN THẬT (tool bị chặn kèm chỉ dẫn)', true, 'gate đã kích hoạt')
} else if (firstMutatingIdx >= 0 && (firstPlanIdx < 0 || firstPlanIdx > firstMutatingIdx)) {
  // Agent ghi file trước todo mà KHÔNG bị chặn → khả năng: planFirstBlocks ≥ 2 đã cho qua, hoặc path ngoài root... flag để soi
  ok('K6 plan-first (agent ghi file khi chưa plan — kiểm tra engine log)', false,
    `file_write tại row ${firstMutatingIdx}, todo_write tại ${firstPlanIdx}`)
} else if (firstPlanIdx >= 0) {
  ok('K6 plan-first (agent LẬP KẾ HOẠCH trước khi ghi file)', true,
    `todo_write row ${firstPlanIdx}${firstMutatingIdx >= 0 ? ` → file_write row ${firstMutatingIdx}` : ''}`)
} else {
  console.log('  ℹ️ K6 run này không có file_write lẫn todo_write — không đủ dữ liệu')
}

// Thống kê sự kiện SSE
const typeCount: Record<string, number> = {}
for (const ev of events) typeCount[String(ev.type)] = (typeCount[String(ev.type)] || 0) + 1
console.log(`▶ SSE events: ${JSON.stringify(typeCount)}`)

console.log(`\n========== R45 E2E: ${pass} PASS / ${fail} FAIL ==========`)
if (fail > 0) {
  console.log('FAILED:', fails.join(' | '))
  process.exit(1)
}
process.exit(0)
