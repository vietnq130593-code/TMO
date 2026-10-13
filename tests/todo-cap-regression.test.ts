// ============================================================================
// TEST SUITE — TODO-CAP-REGRESSION (hồi quy cap todo theo todo CHƯA XONG)
// ============================================================================
// Chạy: cd /home/z/tmo-app && bun run tests/todo-cap-regression.test.ts
//
// Bug gốc (2026-10-30, chu kỳ goal-loop 29): todoWrite chặn theo
// count({ sessionId }) — TẤT CẢ status kể cả completed/failed. Hệ quả: một
// session chạy nhiều chu kỳ tích luỹ 200+ todo ĐÃ HOÀN TẤT thì bị chặn vĩnh
// viễn, mọi todo_write sau đó fail → agent mất công cụ lập kế hoạch giữa chừng.
// Bằng chứng thực: session 'sess_1790637110029_w1x31q' có 202 todo →
// "Todo list cap exceeded: 202 existing + 0 new > 200 max per session".
//
// Hồi quy này khẳng định 2 hành vi:
//   H1 — session >200 todo ĐÃ ĐÓNG vẫn gọi todoWrite mới được (success:true).
//   H2 — ngưỡng ngân sách MỞ vẫn còn: >200 todo CHƯA XONG thì bị chặn đúng.
//
// Test THỰC TẾ trên DB thật của app (SQLite tmo-app) — session test riêng
// (prefix test-cap-<ts>) → dọn sạch cuối test. Không phù hợp CI/Jest.
// ============================================================================

// Task 33 (§0b lượt 2 — 2026-10-13): TỪ CHỐI chạy khi DB chưa được cô lập.
// Bản cũ ép DATABASE_URL thẳng file:/home/z/tmo-app/db/custom.db (DB
// PRODUCTION của app) — mọi lượt `bun test` chạy từ cwd NGOÀI project
// (bunfig preload không nạp → TMO_TEST_DB_ISOLATED không set) ghi fixture
// thẳng DB thật. Bằng chứng đo thật: 3 dòng test-lesson-* trong
// LessonRecord production (13:28:34 sau restore) — auto-learn thật còn
// validate + phát learn.episode bẩn vào ledger (2026-10-13). Đường hợp lệ
// duy nhất: `bun test` từ project root — preload (tests/db-isolation-preload.ts)
// copy DB sang /tmp + set TMO_TEST_DB_ISOLATED=1. Ngoài đường đó → fail NGAY
// (doctrine fail-loud Task 54), tuyệt đối không ghi DB production.
if (process.env.TMO_TEST_DB_ISOLATED !== '1') {
  throw new Error(
    '[DB-ISOLATION] Test từ chối chạy trên DB production. Chạy `bun test` từ thư mục gốc tmo-app — bunfig.toml [test].preload sẽ cô lập DB (copy /tmp). Xem tests/db-isolation-preload.ts.',
  )
}

import { todoWrite } from '../src/lib/code-team/dev-tools'
import { db } from '../src/lib/db'

const TS = Date.now()
// SID_H1 = session lịch sử dày (205 todo đã đóng) — mô phỏng đúng bug gốc.
const SID_H1 = `test-cap-closed-${TS}`
// SID_H2 = session ngân sách mở đầy — mô phỏng hành vi CHẶN còn đúng.
const SID_H2 = `test-cap-open-${TS}`

let pass = 0, fail = 0
const fails: string[] = []
function ok(name: string, cond: boolean, detail = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; fails.push(name); console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`) }
}

async function cleanup() {
  await db.todo.deleteMany({ where: { sessionId: SID_H1 } }).catch(() => null)
  await db.todo.deleteMany({ where: { sessionId: SID_H2 } }).catch(() => null)
}

// ==================== H1 — LỊCH SỬ DÀY KHÔNG CHẶN TODO MỚI ====================
console.log('\n━━━ H1. 205 todo ĐÃ ĐÓNG vẫn gọi được todoWrite ━━━')

// Seed 205 todo completed — vượt MAX_TODOS_PER_SESSION (200) nhưng KHÔNG có
// todo nào chưa xong, nên theo cơ chế mới đây là lịch sử, không phải ngân sách.
await db.todo.createMany({
  data: Array.from({ length: 205 }, (_, i) => ({
    id: `cap-h1-${TS}-${i}`,
    sessionId: SID_H1,
    content: `Lịch sử #${i}`,
    status: 'completed',
    priority: 'low',
  })),
})
const seeded = await db.todo.count({ where: { sessionId: SID_H1 } })
ok('H1.0 seed 205 todo completed thành công (tiền đề đáng tin)', seeded === 205, `count=${seeded}`)

// Gọi chính hàm cần hồi quy — không sao chép logic.
const h1 = await todoWrite({
  sessionId: SID_H1,
  todos: [{ content: 'Todo MỚI sau 205 todo lịch sử', status: 'pending' }],
}) as { success?: boolean; error?: string }
ok('H1.1 todoWrite trả success=true (bug gốc: cap exceeded 205 > 200)', h1.success === true, h1.error || JSON.stringify(h1).slice(0, 200))

const h1Open = await db.todo.count({ where: { sessionId: SID_H1, status: { in: ['pending', 'in_progress', 'blocked'] } } })
ok('H1.2 chỉ đúng 1 todo MỞ sau khi thêm (lịch sử không tính ngân sách)', h1Open === 1, `open=${h1Open}`)

const h1Total = await db.todo.count({ where: { sessionId: SID_H1 } })
ok('H1.3 KHÔNG mất row lịch sử (206 = 205 + 1, không xoá cứng)', h1Total === 206, `total=${h1Total}`)

// ==================== H2 — NGÂN SÁCH MỞ VẪN CHẶN ĐÚNG ====================
console.log('\n━━━ H2. 201 todo CHƯA XONG vẫn bị chặn ━━━')

await db.todo.createMany({
  data: Array.from({ length: 201 }, (_, i) => ({
    id: `cap-h2-${TS}-${i}`,
    sessionId: SID_H2,
    content: `Việc mở #${i}`,
    status: 'pending',
    priority: 'low',
  })),
})

const h2 = await todoWrite({
  sessionId: SID_H2,
  todos: [{ content: 'Việc mới khi đã đầy ngân sách mở', status: 'pending' }],
}) as { success?: boolean; error?: string }
ok('H2.1 todoWrite bị chặn (success=false)', h2.success === false, JSON.stringify(h2).slice(0, 200))
ok('H2.2 error nêu rõ ngân sách MỞ, không phải tổng row', /201 open \+ 1 new > 200 max/.test(h2.error || ''), h2.error || '(không có error)')

// ==================== CLEANUP + SUMMARY ====================
await cleanup()
const leftH1 = await db.todo.count({ where: { sessionId: SID_H1 } })
const leftH2 = await db.todo.count({ where: { sessionId: SID_H2 } })
ok('CLEANUP test không rò row vào DB app (H1=0, H2=0)', leftH1 === 0 && leftH2 === 0, `H1=${leftH1} H2=${leftH2}`)

console.log(`\n━━━ KẾT QUẢ: ${pass} pass · ${fail} fail ━━━`)

// ==================== suite-safe exit ====================
// File script-style nhưng tên .test.ts → bun test nhặt vào suite. process.exit()
// cũ GIẾT cả suite → các test file sau không bao giờ chạy. Trong suite → đăng
// ký test thật; chạy trực tiếp → giữ exit-code.
{
  let registered = false
  try {
    const { test } = await import('bun:test')
    test(`script-summary: ${pass} pass / ${fail} fail`, () => {
      if (fail > 0) throw new Error(`${fail} check thất bại:\n${fails.map(f => `  ❌ ${f}`).join('\n')}`)
    })
    registered = true
  } catch { /* chạy trực tiếp — bun:test không khả dụng */ }
  if (!registered) {
    if (fail > 0) process.exit(1)
    process.exit(0)
  }
}
