// LIVE BRIDGE TEST — đường CẢNH BÁO coverage qua ĐÚNG production path:
// tmo_todo bridge → POST /api/tools/execute → executeTool (context-merge
// sessionId/runId) → todoWrite → checkRunTodoCoverage → warning trong response.
// Kịch bản: RunContext có 2 nghiệm thu + 📐 1 mục → todo_write thiếu → warning
// → todo_write bổ sung → ✅ phủ đủ. Dọn sạch cuối (session test riêng).
// Chạy: bun run tests/e2e-cov-bridge.ts (server chạy port 3000)

process.env.DATABASE_URL = 'file:/home/z/tmo-app/db/custom.db'

import { db } from '../src/lib/db'
import { upsertRunContext } from '../src/lib/structured-hypothesis'

const BASE = 'http://localhost:3000'
const TS = Date.now()
const SID = `test-bridge-cov-${TS}`
const RUN = `test-bridge-run-${TS}`

let pass = 0, fail = 0
const fails: string[] = []
function ok(name: string, cond: boolean, detail = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; fails.push(name); console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`) }
}

// Lấy token (giống bridge thật — .opencode/tools dùng TMO_BASE_URL + token
// nội bộ; ở đây dùng /api/auth/setup như e2e2-send)
const setupRes = await fetch(`${BASE}/api/auth/setup`, { credentials: 'same-origin' })
const token = ((await setupRes.json().catch(() => null)) as { token?: string } | null)?.token || ''
if (!token) { console.error('NO TOKEN'); process.exit(1) }

// Giống goal-loop run start: stash nghiệm thu + 📐
await upsertRunContext({
  runId: RUN, sessionId: SID,
  acceptanceCriteria: JSON.stringify([
    'Todo hiển thị dạng cây lồng nhau trong panel',
    'Bằng chứng tool khi đóng todo',
  ]),
  dataScope: 'cần đọc src/lib/todo-coverage.ts · ngoài phạm vi: docs/',
})

async function bridgeTodoWrite(todos: Array<Record<string, unknown>>) {
  // ĐÚNG format tmo_todo gửi: tool "todo_write", args chỉ có todos — sessionId
  // + runId đến từ CONTEXT (context-merge của tool-executor, như TMO_SESSION_ID
  // / TMO_RUN_ID env qua bridge thật)
  const res = await fetch(`${BASE}/api/tools/execute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-tmo-api-token': token },
    body: JSON.stringify({
      tool: 'todo_write',
      args: { todos },
      context: { agentName: 'e2e-bridge-test', sessionId: SID, runId: RUN },
    }),
  })
  return await res.json() as { success: boolean; result?: { coverage?: { ok?: boolean; acceptance?: string | null; dataScope?: string | null; warning?: string } } }
}

console.log('\n━━━ LIVE BRIDGE — cảnh báo coverage qua /api/tools/execute ━━━')

// Lần 1: thiếu cả 2 (chỉ todo liên quan 📐)
const r1 = await bridgeTodoWrite([{ content: 'Đọc src/lib/todo-coverage.ts hiểu cấu trúc', status: 'in_progress' }])
const c1 = r1.result?.coverage
ok('L1 todo thiếu 2 nghiệm thu → coverage.ok=false, 0/2', r1.success && c1?.ok === false && c1?.acceptance === '0/2', JSON.stringify(c1))
ok('L2 warning liệt kê Nghiệm thu 1 + 2', !!c1?.warning && c1.warning.includes('Nghiệm thu 1') && c1.warning.includes('Nghiệm thu 2'), c1?.warning || '')
ok('L3 📐 1 mục đã phủ (todo đọc file khớp path)', c1?.dataScope === '1/1', JSON.stringify(c1))
ok('L4 warning có hướng dẫn bổ sung', !!c1?.warning && c1.warning.includes('BỔ SUNG'))

// Lần 2: agent bổ sung đúng 2 todo thiếu (giống hành vi sau warning)
const r2 = await bridgeTodoWrite([
  { content: 'Render cây todo parentId lồng nhau [Nghiệm thu 1]', status: 'pending' },
  { content: 'Ghi bằng chứng tool khi đóng todo [Nghiệm thu 2]', status: 'pending' },
])
const c2 = r2.result?.coverage
ok('L5 sau bổ sung → ok=true 2/2 + ✅', r2.success && c2?.ok === true && c2?.acceptance === '2/2' && !!c2?.warning?.includes('✅'), JSON.stringify(c2))

// Xác minh warning đã nằm trong DB (todos được stash đúng run)
const cnt = await db.todo.count({ where: { sessionId: SID, runId: RUN } })
ok('L6 todos qua bridge gắn đúng sessionId + runId (context-merge)', cnt === 3, `count=${cnt}`)

// Dọn sạch
await db.todo.deleteMany({ where: { sessionId: SID } }).catch(() => null)
await db.runContext.deleteMany({ where: { sessionId: SID } }).catch(() => null)
await db.$disconnect()

console.log(`\n━━━ BRIDGE KẾT QUẢ: ${pass} pass · ${fail} fail ━━━`)
if (fail > 0) { console.log('FAILED:', fails.join(' | ')); process.exit(1) }
process.exit(0)
