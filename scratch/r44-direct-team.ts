// ============================================================================
// ROUND-44 E2E — gọi TRỰC TIẾP executeCodeTeamRequest (đúng hàm tool call
// request_code_team của Omega sẽ kích hoạt trong process) — verify toàn bộ fix
// round-44 trên đường vận hành THẬT:
//   (a) shell không treo khi agent chạy lệnh nền
//   (b) G1/G2-B có run_bg/read_output/kill_process
//   (d) step-mission: G1 chỉ thiết kế, G2-A code, G2-B review...
//   (e) toolCallsLog persist vào worklog (checkpoint verify đủ bằng chứng)
//   (f) budget enforcement
// Kỳ vọng: Mode C/Tier 2 → pipeline 7 bước chạy ĐỦ: TL→TL-code→G1→G2-A→G2-B→G3→TL-verify
//
// Chạy: env -u DATABASE_URL bun run scratch/r44-direct-team.ts
// ============================================================================
process.env.DATABASE_URL = 'file:/home/z/tmo-app/db/custom.db'
import { db } from '../src/lib/db'

const TASK = `Xây một ứng dụng fullstack nhỏ "Kho trích dẫn" trong /tmp/tmo-r44-quote-app: server.ts chạy bằng Bun lắng nghe port 8898, dùng module builtin bun:sqlite, tuyệt đối không cài thêm package. Database quotes.db với bảng quotes(id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL, author TEXT DEFAULT ''). REST API: GET /api/quotes liệt kê tất cả; POST /api/quotes nhận {text, author} trả 201; DELETE /api/quotes/:id trả 200. public/index.html gồm HTML/CSS/JavaScript thuần trong 1 file (không framework, không CDN) liệt kê trích dẫn, form thêm mới, nút xóa từng mục, gọi API đúng endpoint. Sau khi code xong phải khởi động server bằng tool run_bg trên port 8898 và chạy test API thật bằng curl đúng thứ tự: POST tạo 2 trích dẫn mẫu, GET đọc lại phải thấy đúng 2, DELETE xóa trích dẫn 1, GET lại phải còn đúng 1; xác nhận GET / trả HTML 200. Báo cáo kết quả từng bước kèm HTTP code và body rút gọn; không kết luận thành công nếu thiếu bằng chứng thực tế.`

console.log('▶ Gọi executeTool("request_code_team") — đúng đường tool call của Omega (Mode C / Tier 2)...')
const t0 = Date.now()
const { executeTool } = await import('../src/lib/code-team/tool-executor')
const toolRes = await executeTool(
  'request_code_team',
  {
    task: TASK,
    context: 'E2E round-44: verify team SOP đầy đủ chuỗi sau fix (shell-detach, G1 run_bg, step-mission, toolCallsLog persist, budget).',
    mode: 'C',
    tier: 2,
    acceptance_criteria: '1) /tmp/tmo-r44-quote-app có server.ts + public/index.html + quotes.db đúng schema. 2) API GET/POST/DELETE đúng method/path/status. 3) Server chạy thật port 8898 (run_bg), test curl theo thứ tự PASS. 4) GET / trả HTML 200.',
  },
  { agentName: 'R44-E2E', sessionId: 'r44-direct-e2e' },
)
const result = toolRes.result
console.log(`◀ Hoàn tất sau ${((Date.now() - t0) / 60000).toFixed(1)} phút (success=${toolRes.success})`)
console.log('─'.repeat(80))
console.log(JSON.stringify(result, null, 1).slice(0, 3500))

// ── Đối chiếu DB: pipeline đầy đủ + toolCallsLog persist ──
console.log('─'.repeat(80))
const wls = await db.codeTeamWorklog.findMany({
  where: { sessionId: { startsWith: 'ct-req-' } },
  orderBy: { createdAt: 'desc' },
  take: 12,
})
const latest = wls.filter(w => Date.now() - new Date(w.createdAt).getTime() < 1000 * 60 * 90)
let pass = 0, fail = 0
const ok = (n: string, c: boolean, d = '') => { if (c) { pass++; console.log(`  ✅ ${n}`) } else { fail++; console.log(`  ❌ ${n} ${d}`) } }
const positions = latest.map(w => `${w.position}/${w.step}`)
console.log('Steps:', positions.join(' → '))
ok('Pipeline có TL analyze', latest.some(w => w.position === 'TL' && w.step === 'analyze'))
ok('Pipeline có TL code', latest.some(w => w.position === 'TL' && w.step === 'code'))
ok('Pipeline có G1 design', latest.some(w => w.position === 'G1'))
ok('Pipeline có G2-A code (RAMPAGE chạy)', latest.some(w => w.position === 'G2-A'))
ok('Pipeline có G2-B review (SENTINEL chạy)', latest.some(w => w.position === 'G2-B'))
ok('Pipeline có G3 optimize (CATALYST chạy)', latest.some(w => w.position === 'G3'))
ok('Pipeline có TL verify cuối', latest.some(w => w.position === 'TL' && w.step === 'verify'))
for (const w of latest) {
  let n = 0
  try { n = JSON.parse(w.toolCalls || '[]').length } catch { n = 0 }
  if (w.position !== 'OMEGA') {
    ok(`toolCallsLog persist ${w.position}/${w.step} (${n} calls)`, n > 0, '(rỗng — bug (e) chưa fix?)')
  }
}
const session = await db.codeTeamSession.findFirst({ where: { sessionId: latest[0]?.sessionId }, orderBy: { updatedAt: 'desc' } })
console.log(`ℹ️ Trạng thái session: ${session?.currentStep} · completedAgents=${session?.completedAgents}`)
await db.$disconnect()
console.log(`\n══ R44 DIRECT E2E: ${pass} PASS / ${fail} FAIL ══`)
process.exit(fail > 0 ? 1 : 0)
