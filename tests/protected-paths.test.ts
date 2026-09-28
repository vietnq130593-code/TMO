// ============================================================================
// TEST SUITE — INFRA GUARD / PROTECTED PATHS (Task 24, 2026-10-21;
// cập nhật chính sách 2026-10-27 phiên 4)
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
// Phạm vi: unit (guardShellCommand + isProtectedInfraPathSync thuần) +
// HTTP thật qua /api/tools/execute (đúng đường bridge tmo_* của OpenCode CLI).
// Test ghi file tạm prisma/test-guard-*.tmp rồi tự dọn — KHÔNG đụng file thật.
// ============================================================================

process.env.DATABASE_URL = 'file:/home/z/tmo-app/db/custom.db'

import { createHash } from 'crypto'
import { readFileSync } from 'fs'
import {
  guardShellCommand,
  isProtectedInfraPathSync,
  INFRA_PROTECTED_FILES,
} from '../src/lib/protected-paths'

const ROOT = '/home/z/tmo-app'

let pass = 0, fail = 0
const fails: string[] = []
function ok(name: string, cond: boolean, detail = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; fails.push(name); console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`) }
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
console.log('\n━━━ D. HTTP /api/tools/execute — chính sách mới qua đường bridge tmo_* ━━━')

const CHECKSUM_FILES = [`${ROOT}/package.json`, `${ROOT}/prisma/schema.prisma`, `${ROOT}/opencode.json`]
const before = CHECKSUM_FILES.map(sha)

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
// D6: shell ĐỌC hợp lệ vẫn chạy
{
  const { success, resultStr } = await callTool('shell', { command: 'echo guard-ok' })
  ok('D6. HTTP shell đọc hợp lệ VẪN CHẠY', success && resultStr.includes('guard-ok'), resultStr.slice(0, 120))
}
// D7: checksum — KHÔNG file hạ tầng thật nào đổi sau các lần thử
const after = CHECKSUM_FILES.map(sha)
ok('D7. Checksum package.json + schema.prisma + opencode.json KHÔNG đổi',
  before.every((h, i) => h === after[i]),
  before.map((h, i) => `${h}→${after[i]}`).join(' '))

// ==================== KẾT QUẢ ====================
console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
console.log(`KẾT QUẢ: ${pass} PASS · ${fail} FAIL / ${pass + fail} test`)

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
