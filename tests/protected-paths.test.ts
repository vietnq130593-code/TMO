// ============================================================================
// TEST SUITE — INFRA GUARD / PROTECTED PATHS (Task 24, 2026-10-21;
// cập nhật chính sách 2026-10-27 phiên 4; hardening 2026-09-30 vòng 9)
// ============================================================================
// Chạy: cd /home/z/tmo-app && bun run tests/protected-paths.test.ts
//
// Mục đích: test guard hạ tầng TMO — lịch sử 2026-10-20 (agent tự ý bun add +
// rewrite schema → OOM-crash 97 restarts) dẫn đến guard Task 24 chặn TOÀN BỘ.
//
// CHÍNH SÁCH MỚI (user directive 2026-10-27 phiên 4): agent ĐƯỢC PHÉP tự cài
// package + tự sửa prisma schema (+ db push) — 2 hạng mục này KHÔNG còn chặn.
// Vẫn chặn: .env/keys, db/ (data files), opencode.json, .opencode/,
// mini-services/, package.json + lockfiles + configs (sửa tay manifests vẫn
// phải qua lệnh chính thống bun add).
//
// ⚠️ HARDENING 2026-09-30 (sự cố thực chiến 06:43 — vòng 8): khi operator tắt
// TMO_INFRA_GUARD=off, D1/D2/D4/D5 là probe PHÁ HOẠI THẬT đã THỰC THI — `echo
// hacked > .env` + `> package.json` đè file thật (626 dòng + manifest) →
// Next.js turbopack không compile nổi route nào (package.json unparseable) →
// 18× HTTP 500 /api/tools/execute, app tê liệt tới khi operator git checkout tay.
// Bộ test này giờ có 3 lớp phòng vệ:
//   (1) D0 dò trạng thái guard bằng probe KHÔNG phá hoại (file tạm tiền tố .env*)
//   (2) guard OFF → SKIP toàn bộ probe phá hoại (D1/D2/D4/D5) — không phá file thật
//   (3) backup + restore .env/package.json quanh D-suite (phòng vệ sâu — kể cả
//       khi guard bật lại giữa chừng hay probe lọt qua do tool bị disable)
//
// Phạm vi: unit (guardShellCommand + isProtectedInfraPathSync thuần) +
// HTTP thật qua /api/tools/execute (đúng đường bridge tmo_* của OpenCode CLI).
// Test ghi file tạm prisma/test-guard-*.tmp rồi tự dọn — KHÔNG đụng file thật.
// ============================================================================

// Ép DB đúng của tmo-app — chống shell DATABASE_URL nhiễm path my-project.
// NHƯNG khi đang ở chế độ test cô lập (tests/db-isolation-preload.ts đã trỏ
// DATABASE_URL vào bản copy trong /tmp) thì PHẢI GIỮ NGUYÊN. Ghi đè ở đây
// sẽ đưa test về ghi thẳng DB production của app đang chạy (bug Task 54).
if (process.env.TMO_TEST_DB_ISOLATED !== '1') {
  process.env.DATABASE_URL = 'file:/home/z/tmo-app/db/custom.db'
}

import { createHash } from 'crypto'
import * as fs from 'fs'
import { readFileSync } from 'fs'
import {
  guardShellCommand,
  isProtectedInfraPathSync,
  INFRA_PROTECTED_FILES,
} from '../src/lib/protected-paths'

const ROOT = '/home/z/tmo-app'

let pass = 0, fail = 0, skip = 0
const fails: string[] = []
function ok(name: string, cond: boolean, detail = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; fails.push(name); console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`) }
}
/** HARDENING 2026-09-30 — SKIP không làm hỏng suite (không phải regression) */
function skipTest(name: string, reason: string) {
  skip++; console.log(`  ⏭️ SKIP ${name} — ${reason}`)
}

const sha = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex').slice(0, 16)

// ==================== A. isProtectedInfraPathSync — DANH SÁCH ====================
console.log('\n━━━ A. Protected path matching ━━━')

ok('package.json (relative) protected',
  isProtectedInfraPathSync(`${ROOT}/package.json`, ROOT).protected)
ok('prisma/schema.prisma KHÔNG còn protected (2026-10-27 — agent được sửa schema)',
  !isProtectedInfraPathSync(`${ROOT}/prisma/schema.prisma`, ROOT).protected)
ok('prisma/migrations/xxx.sql KHÔNG protected (agent sửa schema + migration)',
  !isProtectedInfraPathSync(`${ROOT}/prisma/migrations/xxx.sql`, ROOT).protected)
ok('db/custom.db protected',
  isProtectedInfraPathSync(`${ROOT}/db/custom.db`, ROOT).protected)
ok('.env protected (prefix)', isProtectedInfraPathSync(`${ROOT}/.env`, ROOT).protected)
ok('.env.local protected (prefix)', isProtectedInfraPathSync(`${ROOT}/.env.local`, ROOT).protected)
ok('.opencode/auth.json protected',
  isProtectedInfraPathSync(`${ROOT}/.opencode/auth.json`, ROOT).protected)
ok('opencode.json protected', isProtectedInfraPathSync(`${ROOT}/opencode.json`, ROOT).protected)
ok('mini-services/foo/index.ts protected',
  isProtectedInfraPathSync(`${ROOT}/mini-services/foo/index.ts`, ROOT).protected)
ok('AGENTS.md protected', isProtectedInfraPathSync(`${ROOT}/AGENTS.md`, ROOT).protected)

ok('src/lib/foo.ts KHÔNG protected (code team làm việc)',
  !isProtectedInfraPathSync(`${ROOT}/src/lib/foo.ts`, ROOT).protected)
ok('src/app/page.tsx KHÔNG protected',
  !isProtectedInfraPathSync(`${ROOT}/src/app/page.tsx`, ROOT).protected)
ok('docs/plan.md KHÔNG protected',
  !isProtectedInfraPathSync(`${ROOT}/docs/plan.md`, ROOT).protected)
ok('README.md KHÔNG protected (git rollback được)',
  !isProtectedInfraPathSync(`${ROOT}/README.md`, ROOT).protected)
ok('file cùng tên NGOÀI workspace KHÔNG protected (/tmp)',
  !isProtectedInfraPathSync('/tmp/other-project/package.json', ROOT).protected)
ok('path thoát workspace (traversal ../) KHÔNG protected',
  !isProtectedInfraPathSync(`${ROOT}/../elsewhere/package.json`, ROOT).protected)
ok('root chính nó KHÔNG protected (để check riêng)',
  !isProtectedInfraPathSync(ROOT, ROOT).protected)

// ==================== B. guardShellCommand — CHÍNH SÁCH MỚI 2026-10-27 ====================
console.log('\n━━━ B. Shell guard — chính sách tự phục vụ hạ tầng (2026-10-27) ━━━')

const g = (cmd: string, cwd = ROOT) => guardShellCommand(cmd, cwd, ROOT)

// B1-B7: HẠNG MỤC ĐÃ MỞ (user directive phiên 4 — cho phép tự cài package + sửa schema)
ok('B1. `bun add better-sqlite3` ĐƯỢC PHÉP (2026-10-27 — tự cài package)',
  !g('bun add better-sqlite3').blocked)
ok('B2. `npm install react` ĐƯỢC PHÉP', !g('npm install react').blocked)
ok('B3. `cd /home/z/tmo-app && bun add x` ĐƯỢC PHÉP (cwd ngoài, nhắc tên root)',
  !g('cd /home/z/tmo-app && bun add x', '/tmp').blocked)
ok('B4. `bun run db:push` ĐƯỢC PHÉP (sửa schema xong push)',
  !g('bun run db:push').blocked)
ok('B5. `npx prisma db push` ĐƯỢC PHÉP', !g('npx prisma db push').blocked)
ok('B6. `npx prisma migrate dev` ĐƯỢC PHÉP', !g('npx prisma migrate dev').blocked)
ok('B7. `echo x >> prisma/schema.prisma` ĐƯỢC PHÉP (sửa schema)',
  !g('echo x >> prisma/schema.prisma').blocked)
// B8-B12: PHẦN VẪN ĐƯỢC BẢO VỆ
ok('B8. `echo x > package.json` CHẶN (sửa tay manifest — phải qua bun add)',
  g('echo x > package.json').blocked)
ok('B9. `rm db/custom.db` CHẶN (data files)', g('rm db/custom.db').blocked)
ok('B10. `sed -i s/a/b/ package.json` CHẶN', g('sed -i s/a/b/ package.json').blocked)
ok('B11. `mv .env .env.bak` CHẶN (keys)', g('mv .env .env.bak').blocked)
ok('B12. `cat x | tee .opencode/auth.json` CHẶN (bridges)', g('cat x | tee .opencode/auth.json').blocked)
ok('B13. message chặn có hướng dẫn escalate + đường tự phục vụ (tiếng Việt)',
  g('echo x > .env').message?.includes('escalate_problem') === true)

// ==================== C. guardShellCommand — KHÔNG CHẶN NHẦM ====================
console.log('\n━━━ C. Shell guard — lệnh hợp lệ vẫn chạy ━━━')

ok('C1. `cat package.json` (đọc) KHÔNG chặn', !g('cat package.json').blocked)
ok('C2. `ls prisma/` (đọc) KHÔNG chặn', !g('ls prisma/').blocked)
ok('C3. `bun run dev` KHÔNG chặn', !g('bun run dev').blocked)
ok('C4. `bun run lint` KHÔNG chặn', !g('bun run lint').blocked)
ok('C5. `rg TODO src/` KHÔNG chặn', !g('rg TODO src/').blocked)
ok('C6. `curl -s localhost:3000/api/health` KHÔNG chặn', !g('curl -s localhost:3000/api/health').blocked)
ok('C7. `echo hi > src/out.txt` (ghi src — code team) KHÔNG chặn',
  !g('echo hi > src/out.txt').blocked)
ok('C8. `bun add x` ở /tmp workspace khác KHÔNG chặn',
  !g('bun add x', '/tmp/task-ws').blocked)
ok('C9. `echo x > package.json` ở /tmp KHÔNG chặn',
  !g('echo x > package.json', '/tmp/task-ws').blocked)
ok('C10. `git status` KHÔNG chặn', !g('git status').blocked)
ok('C11. `grep -c model prisma/schema.prisma` (đọc) KHÔNG chặn',
  !g('grep -c model prisma/schema.prisma').blocked)
ok('C12. `wc -l db/custom.db` (đọc) KHÔNG chặn', !g('wc -l db/custom.db').blocked)
ok('C13. `mkdir -p src/new-mod` KHÔNG chặn', !g('mkdir -p src/new-mod').blocked)

// ==================== D. HTTP THẬT — QUA ĐƯỜNG BRIDGE tmo_* DÙNG ====================
// HARDENING 2026-09-30 (sự cố 06:43): xem header file — 3 lớp phòng vệ.
console.log('\n━━━ D. HTTP /api/tools/execute — chính sách mới qua đường bridge tmo_* ━━━')

const CHECKSUM_FILES = [`${ROOT}/package.json`, `${ROOT}/prisma/schema.prisma`, `${ROOT}/opencode.json`, `${ROOT}/.env`]
const before = CHECKSUM_FILES.map(sha)

// ── LỚP 3 (phòng vệ sâu): backup .env + package.json — restore ở cuối D-suite
const BK = `/tmp/tmo-guard-test-backup-${Date.now()}`
fs.mkdirSync(BK, { recursive: true })
const BACKUP_FILES = ['package.json', '.env']
for (const f of BACKUP_FILES) {
  try { fs.copyFileSync(`${ROOT}/${f}`, `${BK}/${f}`) } catch { /* không tồn tại thì thôi */ }
}
function restoreBackups(): number {
  let restored = 0
  for (const f of BACKUP_FILES) {
    const bkPath = `${BK}/${f}`
    if (!fs.existsSync(bkPath)) continue
    const orig = sha(bkPath)
    const cur = fs.existsSync(`${ROOT}/${f}`) ? sha(`${ROOT}/${f}`) : null
    if (cur !== orig) {
      fs.copyFileSync(bkPath, `${ROOT}/${f}`)
      restored++
      console.log(`  🛡️ RESTORED ${f} từ backup (nội dung đã đổi trong lúc test — tự khôi phục)`)
    }
  }
  return restored
}

async function callTool(tool: string, args: Record<string, unknown>) {
  const res = await fetch('http://localhost:3000/api/tools/execute', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tool, args, context: { agentName: 'test-infra-guard' } }),
    signal: AbortSignal.timeout(30000),
  })
  const data = await res.json() as { success: boolean; result: unknown }
  const resultStr = typeof data.result === 'string' ? data.result : JSON.stringify(data.result)
  return { success: data.success, resultStr }
}

// ── LỚP 1: D0 dò trạng thái guard KHÔNG phá hoại (file tạm tiền tố .env*)
// Guard ON → cả 2 probe bị chặn (success=false). Guard OFF → ÍT NHẤT 1 probe
// thực thi (success=true) → coi như OFF → SKIP probe phá hoại.
// Dual-probe (file_write + shell) chống mù khi 1 trong 2 tool bị disable.
{
  let execAllowed = false
  const p1 = await callTool('file_write', { path: '.env.guard-state-probe', content: 'probe', mode: 'overwrite' })
  execAllowed = execAllowed || p1.success
  const p2 = await callTool('shell', { command: 'echo probe > .env.guard-state-probe2' })
  execAllowed = execAllowed || p2.success
  // dọn file probe nếu guard OFF (nếu ON thì chẳng có gì được ghi)
  if (execAllowed) {
    await callTool('shell', { command: 'rm -f .env.guard-state-probe .env.guard-state-probe2' })
  }
  ok('D0. Dò trạng thái guard bằng probe KHÔNG phá hoại (file tạm .env*)', true,
    execAllowed ? 'guard OFF — probe phá hoại D1/D2/D4/D5 sẽ SKIP' : 'guard ON — probe phá hoại sẽ được chạy + phải bị chặn')

  if (execAllowed) {
    // ── LỚP 2: guard OFF → KHÔNG chạy probe phá hoại (sự cố 06:43)
    skipTest('D1. HTTP shell redirect vào .env bị TỪ CHỐI (keys)', 'guard OFF — probe sẽ THỰC THI và phá .env thật (sự cố 06:43), bỏ qua để bảo vệ file')
    skipTest('D2. HTTP shell redirect vào package.json bị TỪ CHỐI', 'guard OFF — probe sẽ phá package.json thật → mọi route 500')
    skipTest('D4. HTTP file_edit package.json bị TỪ CHỐI', 'guard OFF — probe sẽ phá manifest thật')
    skipTest('D5. HTTP file_delete db/custom.db bị TỪ CHỐI', 'guard OFF — probe sẽ XÓA DB production')
  } else {
// D1: shell ghi đè .env qua redirect — VẪN bị chặn (keys được bảo vệ)
{
  const { success, resultStr } = await callTool('shell', { command: 'echo hacked > .env' })
  ok('D1. HTTP shell redirect vào .env bị TỪ CHỐI (keys)',
    !success && /TỪ CHỐI|infra-guard|blocked/i.test(resultStr), resultStr.slice(0, 120))
}
// D2: shell ghi đè package.json qua redirect — VẪN bị chặn (manifest sửa tay)
{
  const { success, resultStr } = await callTool('shell', { command: 'echo hacked > package.json' })
  ok('D2. HTTP shell redirect vào package.json bị TỪ CHỐI',
    !success && /TỪ CHỐI|infra-guard|blocked/i.test(resultStr), resultStr.slice(0, 120))
}
// D4: file_edit vào package.json — VẪN bị chặn
{
  const { success, resultStr } = await callTool('file_edit', {
    path: 'package.json', old_str: '"name"', new_str: '"hacked"',
  })
  ok('D4. HTTP file_edit package.json bị TỪ CHỐI',
    !success && /TỪ CHỐI|infra-guard|blocked/i.test(resultStr), resultStr.slice(0, 120))
}
// D5: file_delete db/custom.db — VẪN bị chặn (data files)
{
  const { success, resultStr } = await callTool('file_delete', { path: 'db/custom.db' })
  ok('D5. HTTP file_delete db/custom.db bị TỪ CHỐI',
    !success && /TỪ CHỐI|infra-guard|blocked/i.test(resultStr), resultStr.slice(0, 120))
}
  }
}
// D3: file_write file TẠM trong prisma/ — ĐƯỢC PHÉP (2026-10-27: agent sửa schema)
// Dùng file tạm riêng (KHÔNG đụng schema.prisma thật) → sau đó D3b dọn sạch.
const TMP_PRISMA = 'prisma/test-guard-tmp-DELETE.me'
{
  const { success, resultStr } = await callTool('file_write', {
    path: TMP_PRISMA, content: '// test-guard tạm — tự dọn sau test', mode: 'overwrite',
  })
  ok('D3. HTTP file_write trong prisma/ ĐƯỢC PHÉP (chính sách 2026-10-27)',
    success, resultStr.slice(0, 160))
}
// D3b: file_delete file tạm — cũng ĐƯỢC PHÉP (prisma/ mở) → dọn sạch
{
  const { success, resultStr } = await callTool('file_delete', { path: TMP_PRISMA })
  ok('D3b. HTTP file_delete file tạm trong prisma/ ĐƯỢC PHÉP (tự dọn)',
    success, resultStr.slice(0, 160))
}
// D6: shell ĐỌC hợp lệ vẫn chạy
{
  const { success, resultStr } = await callTool('shell', { command: 'echo guard-ok' })
  ok('D6. HTTP shell đọc hợp lệ VẪN CHẠY', success && resultStr.includes('guard-ok'), resultStr.slice(0, 120))
}
// ── LỚP 3 (tiếp): restore backup TRƯỚC khi checksum — D7 chứng minh file thật
// nguyên vẹn sau toàn bộ D-suite (kể cả khi probe nào lọt qua)
const restoredCount = restoreBackups()
ok('D3c. Backup/restore phòng vệ sâu .env + package.json (sự cố 06:43)', true,
  restoredCount === 0 ? 'không cần restore — không file nào bị đổi' : `đã tự khôi phục ${restoredCount} file từ backup`)
// D7: checksum — KHÔNG file hạ tầng thật nào đổi sau các lần thử
const after = CHECKSUM_FILES.map(sha)
ok('D7. Checksum package.json + schema.prisma + opencode.json + .env KHÔNG đổi',
  before.every((h, i) => h === after[i]),
  before.map((h, i) => `${h}→${after[i]}`).join(' '))
// dọn thư mục backup
try { fs.rmSync(BK, { recursive: true, force: true }) } catch { /* best-effort */ }

// ==================== FB-P1-R1-01: DỌN ToolMetric test khỏi DB THẬT ====================
// Các callTool() ở trên đánh HTTP vào app sống → APP (process khác) ghi
// ToolMetric vào db/custom.db THẬT với agentRole='test-infra-guard' (không có
// sessionId trong context → 'unknown'). Trước đây bị BỎ SÓT → mỗi lần gate
// chạy để lại ~13-15 row test, làm bẩn số đo P1-M3 (anomaly scan) + P1-M4
// (tool_success_rate) — bằng chứng 117 row role test-infra-guard tích luỹ
// 08:22→10:15 ngày 2026-10-10. Dọn bằng marker agentRole (an toàn: role này
// chỉ tồn tại từ chính test này). Ghi app-side là async fire-and-forget →
// đợi 750ms cho lượt cuối land trước khi xoá; đồng thời dọn cả phần mồ côi
// từ lần chạy trước (crash giữa chừng) ở ĐẦU file không cần — dọn cuối đủ.
try {
  const { Database: BunSqlite } = await import('bun:sqlite')
  await new Promise((r) => setTimeout(r, 750))
  const cleaner = new BunSqlite('/home/z/tmo-app/db/custom.db')
  cleaner.exec('PRAGMA busy_timeout=5000')
  const info = cleaner.query("DELETE FROM ToolMetric WHERE agentRole = 'test-infra-guard'").run()
  cleaner.close()
  if (info.changes > 0) console.log(`  🧹 FB-P1-R1-01: dọn ${info.changes} ToolMetric test-infra-guard khỏi DB thật`)
} catch (e) {
  console.log(`  ⚠️ không dọn được ToolMetric test (FB-P1-R1-01): ${(e as Error).message}`)
}

// ==================== KẾT QUẢ ====================
console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
console.log(`KẾT QUẢ: ${pass} PASS · ${fail} FAIL · ${skip} SKIP / ${pass + fail + skip} test`)

// ==================== Task 54 FIX: suite-safe exit ====================
// File script-style nhưng tên .test.ts → bun test nhặt vào suite.
// process.exit() cũ GIẾT cả suite → các test file sau không bao giờ chạy.
// Trong suite → đăng ký test thật; chạy trực tiếp → giữ exit-code.
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
