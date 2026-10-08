// ============================================================================
// TEST SUITE — POST /api/opencode/execute (P0-1 security)
// Gọi route handler TRỰC TIẾP (không cần dev server) — cùng pattern với
// tests/tools-register-route.test.ts.
//
// Khoá 4 nhánh bảo mật + 2 nhánh giới hạn:
//  1. UNAUTHORIZED  — không token / token sai            → 401
//  2. FORBIDDEN     — token app đúng nhưng TMO_EXEC_TOKEN khác → 403
//  3. NOT-ALLOWLIST — `curl`, `bash -c`, `git push`      → 403 code not_allowlisted/bad_subcommand
//  4. SHELL INJECT  — `ls; whoami`, `ls && id`, `$(...)` → 400 code metachar
//  5. CWD / SECRET  — cwd ngoài allowed roots, arg đọc .env → 403
//  6. TIMEOUT / OUTPUT CAP — unit test trên exec-runner (không qua route)
// ============================================================================

import { describe, test, expect } from 'bun:test'
import { NextRequest } from 'next/server'
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { POST } from '../src/app/api/opencode/execute/route'
import { ensureTmoApiToken } from '../src/lib/tmo-token'
import {
  checkAllowlist,
  parseCommand,
  resolveSafeCwd,
  isSecretPath,
  validatePaths,
  ALLOWLIST_BINARIES,
} from '../src/lib/exec-allowlist'
import { runAllowedCommand, resolveTimeoutMs, buildSafeEnv, findRealpathEscape } from '../src/lib/exec-runner'
import { LIMITS } from '../src/lib/exec-allowlist'

const ENDPOINT = 'http://localhost:3000/api/opencode/execute'
const APP_TOKEN = ensureTmoApiToken() ?? process.env.TMO_API_TOKEN ?? ''

function makeRequest(body: Record<string, unknown>, token?: string | null): NextRequest {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (token) headers['x-tmo-api-token'] = token
  return new NextRequest(ENDPOINT, { method: 'POST', headers, body: JSON.stringify(body) })
}

describe('P0-1 execute route — auth', () => {
  test('thiếu token → 401 Unauthorized', async () => {
    const res = await POST(makeRequest({ command: 'git status' }, null))
    expect(res.status).toBe(401)
    const data = (await res.json()) as { error?: string }
    expect(data.error).toBe('Unauthorized')
  })

  test('token sai → 401 (không fallback sang local exec)', async () => {
    const res = await POST(makeRequest({ command: 'git status' }, 'wrong-token-value-0123456789'))
    expect(res.status).toBe(401)
  })

  test('token hợp lệ nhưng thiếu quyền execute (TMO_EXEC_TOKEN khác) → 403', async () => {
    const previous = process.env.TMO_EXEC_TOKEN
    process.env.TMO_EXEC_TOKEN = 'exec-only-token-abcdef0123456789'
    try {
      const res = await POST(makeRequest({ command: 'git status' }, APP_TOKEN))
      expect(res.status).toBe(403)
      const data = (await res.json()) as { error?: string }
      expect(data.error).toContain('Forbidden')
    } finally {
      if (previous === undefined) delete process.env.TMO_EXEC_TOKEN
      else process.env.TMO_EXEC_TOKEN = previous
    }
  })

  test('token hợp lệ + đúng quyền → không phải 401/403', async () => {
    const res = await POST(makeRequest({ command: 'pwd' }, APP_TOKEN))
    expect([401, 403]).not.toContain(res.status)
  })
})

describe('P0-1 execute route — allowlist + shell injection', () => {
  test('binary ngoài allowlist (curl) → 403 not_allowlisted', async () => {
    const res = await POST(makeRequest({ command: 'curl http://evil.test' }, APP_TOKEN))
    expect(res.status).toBe(403)
    const data = (await res.json()) as { code?: string }
    expect(data.code).toBe('not_allowlisted')
  })

  test('git subcommand ghi (git push) → 403 bad_subcommand', async () => {
    const res = await POST(makeRequest({ command: 'git push origin main' }, APP_TOKEN))
    expect(res.status).toBe(403)
    const data = (await res.json()) as { code?: string }
    expect(data.code).toBe('bad_subcommand')
  })

  test('shell metachar (; && $() |) → 400 metachar, KHÔNG interpret', async () => {
    for (const command of ['ls; whoami', 'ls && id', 'ls $(whoami)', 'ls | id', 'ls > /tmp/x']) {
      const res = await POST(makeRequest({ command }, APP_TOKEN))
      expect(res.status).toBe(400)
      const data = (await res.json()) as { code?: string }
      expect(data.code).toBe('metachar')
    }
  })

  test('quote/backslash bị chặn (không quote-aware → không parse được)', async () => {
    const parsed = parseCommand('ls "a b"')
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.error).toBe('metachar')
  })

  test('command rỗng / không phải string → 400', async () => {
    const empty = await POST(makeRequest({ command: '' }, APP_TOKEN))
    expect(empty.status).toBe(400)
    const notString = await POST(makeRequest({ command: { toString: 'x' } }, APP_TOKEN))
    expect(notString.status).toBe(400)
  })

  test('body > 8KB → 413', async () => {
    const res = await POST(makeRequest({ command: 'a'.repeat(9000) }, APP_TOKEN))
    expect(res.status).toBe(413)
  })
})

describe('P0-1 execute route — cwd + secret path guard', () => {
  test('cwd ngoài allowed roots → 403', async () => {
    const res = await POST(makeRequest({ command: 'ls', cwd: '/etc' }, APP_TOKEN))
    expect(res.status).toBe(403)
    const data = (await res.json()) as { code?: string }
    expect(data.code).toBe('cwd_not_allowed')
  })

  test('cwd traversal (../../../etc) → 403', async () => {
    const res = await POST(makeRequest({ command: 'ls', cwd: '../../../../etc' }, APP_TOKEN))
    expect(res.status).toBe(403)
  })

  test('arg đọc file secret (.env) → 403 path_not_allowed', async () => {
    const res = await POST(makeRequest({ command: 'cat .env' }, APP_TOKEN))
    expect(res.status).toBe(403)
    const data = (await res.json()) as { code?: string }
    expect(data.code).toBe('path_not_allowed')
  })

  test('arg path ngoài cwd (../) → 403 path_not_allowed', async () => {
    const res = await POST(makeRequest({ command: 'ls ../..' }, APP_TOKEN))
    expect(res.status).toBe(403)
    const data = (await res.json()) as { code?: string }
    expect(data.code).toBe('path_not_allowed')
  })

  test('isSecretPath bắt .env / .tmo-api-token / id_rsa / *.pem', () => {
    expect(isSecretPath('.env')).toBe(true)
    expect(isSecretPath('/home/z/tmo-app/.env')).toBe(true)
    expect(isSecretPath('.tmo-api-token')).toBe(true)
    expect(isSecretPath('~/.ssh/id_rsa')).toBe(true)
    expect(isSecretPath('certs/server.pem')).toBe(true)
    expect(isSecretPath('src/lib/db.ts')).toBe(false)
  })

  test('resolveSafeCwd(undefined) → project cwd', () => {
    const result = resolveSafeCwd(undefined)
    expect(result.ok).toBe(true)
  })
})

describe('P0-1 policy unit — argv không shell', () => {
  test('parseCommand tách argv, không có metachar nào lọt qua', () => {
    const parsed = parseCommand('git status --porcelain')
    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      expect(parsed.value.tokens).toEqual(['git', 'status', '--porcelain'])
      expect(parsed.value.bin).toBe('git')
    }
  })

  test('node -e bị chặn (đọc code từ argv)', () => {
    const parsed = parseCommand('node -e console.log(1)')
    // '(' và ')' là metachar → chặn ở tầng parse
    expect(parsed.ok).toBe(false)
    const check = checkAllowlist({ tokens: ['node', '-e'], bin: 'node' })
    expect(check.ok).toBe(false)
    if (!check.ok) expect(check.code).toBe('bad_flag')
  })

  test('git --exec bị chặn (chạy code tùy ý)', () => {
    const check = checkAllowlist({ tokens: ['git', '--exec=rm', 'status'], bin: 'git' })
    expect(check.ok).toBe(false)
    if (!check.ok) expect(check.code).toBe('bad_flag')
  })

  test('git flag mang ĐƯỜNG DẪN bị chặn (bypass path guard + ghi file ngoài cwd)', () => {
    // Arg bắt đầu bằng '-' bị path guard `continue` → nếu không deny, giá trị
    // đường dẫn của các flag này thoát hoàn toàn khỏi kiểm tra.
    for (const flag of ['--output=/etc/cron.d/x', '--git-dir=/etc', '--work-tree=/etc']) {
      const check = checkAllowlist({ tokens: ['git', flag, 'log'], bin: 'git' })
      expect(check.ok).toBe(false)
      if (!check.ok) expect(check.code).toBe('bad_flag')
    }
  })

  test('allowlist là danh sách đóng, nhỏ, không chứa shell/bin tùy ý', () => {
    expect(ALLOWLIST_BINARIES.length).toBeGreaterThan(0)
    for (const forbidden of ['bash', 'sh', 'zsh', 'curl', 'wget', 'ssh', 'python', 'rm', 'sudo']) {
      expect(ALLOWLIST_BINARIES).not.toContain(forbidden)
    }
  })
})

describe('P0-1 runner — timeout, output cap, env', () => {
  test('resolveTimeoutMs clamp về max 30s, mặc định 15s', () => {
    expect(resolveTimeoutMs(undefined)).toBe(LIMITS.defaultTimeoutMs)
    expect(resolveTimeoutMs(600_000)).toBe(LIMITS.maxTimeoutMs)
    expect(resolveTimeoutMs(5_000)).toBe(5_000)
    expect(resolveTimeoutMs(-1)).toBe(LIMITS.defaultTimeoutMs)
  })

  test('buildSafeEnv KHÔNG kế thừa secret của process.env', () => {
    process.env.SOME_FAKE_SECRET_TOKEN = 'super-secret-value'
    try {
      const env = buildSafeEnv()
      expect(env.SOME_FAKE_SECRET_TOKEN).toBeUndefined()
      expect(env.TMO_API_TOKEN).toBeUndefined()
      expect(env.DATABASE_URL).toBeUndefined()
      expect(env.FORCE_COLOR).toBe('0')
    } finally {
      delete process.env.SOME_FAKE_SECRET_TOKEN
    }
  })

  test('timeout thực sự giết tiến trình → failure=timeout', async () => {
    // Bypass allowlist ở mức unit: route KHÔNG BAO GIỜ tạo allow shape này.
    const run = await runAllowedCommand(
      {
        bin: 'node',
        args: ['-e', 'setTimeout(() => {}, 10000)'],
        ok: true,
        rule: { description: 'test-only' },
      },
      { cwd: process.cwd(), timeoutMs: 400 }
    )
    expect(run.ok).toBe(false)
    expect(run.failure).toBe('timeout')
    expect(run.durationMs).toBeLessThan(5_000)
  })

  test('output vượt maxBuffer → failure=output_overflow, không trả nguyên output', async () => {
    const run = await runAllowedCommand(
      {
        bin: 'node',
        args: ['-e', `process.stdout.write('A'.repeat(${LIMITS.maxOutputBytes * 3}))`],
        ok: true,
        rule: { description: 'test-only' },
      },
      { cwd: process.cwd(), timeoutMs: 20_000 }
    )
    expect(run.ok).toBe(false)
    expect(run.failure).toBe('output_overflow')
    expect(run.output.length).toBeLessThanOrEqual(LIMITS.maxOutputBytes + 4096)
  })

  test('argv chứa metachar không bị shell interpret (echo số 5 chứ không lệnh)', async () => {
    const run = await runAllowedCommand(
      {
        bin: 'echo',
        args: ['5;', 'whoami'],
        ok: true,
        rule: { description: 'test-only' },
      },
      { cwd: process.cwd(), timeoutMs: 5_000 }
    )
    expect(run.ok).toBe(true)
    // Nếu có shell, "5; whoami" sẽ in "5" rồi chạy whoami. Không shell → in literal.
    expect(run.output).toBe('5; whoami')
  })
})

// ============================================================================
// r64.2 — AUDIT LƯỢT 6 (kỹ sư AI / kiến trúc sư hệ thống, sau round-64.1):
// các vector policy LỌT trong deliverable P0-1 (F2/F3/F4/F7/F8) + khôi phục
// usability cho lệnh inspect chuẩn (F5) + một đường thực thi duy nhất (F1).
// ============================================================================

/** Pipeline policy đầy đủ: parse → allowlist → path guard (rev:path gồm cả). */
function policy(command: string, cwd = '/home/z/tmo-app') {
  const parsed = parseCommand(command)
  if (!parsed.ok) return { ok: false as const, code: parsed.error }
  const allow = checkAllowlist(parsed.value)
  if (!allow.ok) return { ok: false as const, code: allow.code }
  const pathCheck = validatePaths(allow, cwd)
  if (!pathCheck.ok) return { ok: false as const, code: pathCheck.code }
  return { ok: true as const, code: undefined }
}

describe('r64.2 — chặn vector policy bị lọt (F2/F3/F4/F7)', () => {
  test('F2: rg --pre=<bin> (spawn preprocessor lên nội dung file) → bad_flag', () => {
    expect(policy('rg --pre=bash foo pm2-start.sh')).toEqual({ ok: false, code: 'bad_flag' })
    expect(policy('rg --pre-glob=*.sh foo x')).toEqual({ ok: false, code: 'bad_flag' })
  })

  test('F2b: rg/grep -f và --file (pattern từ file — attach thoát path guard) → bad_flag', () => {
    expect(policy('rg -f .env x')).toEqual({ ok: false, code: 'bad_flag' })
    expect(policy('grep --file=.env x')).toEqual({ ok: false, code: 'bad_flag' })
  })

  test('F3: git branch <tên> (TẠO ref) → extra_positional', () => {
    expect(policy('git branch newbranch')).toEqual({ ok: false, code: 'extra_positional' })
  })

  test('F3b: git remote set-url/add (GHI .git/config — repoint origin) → extra_positional', () => {
    expect(policy('git remote set-url origin https://evil.x/r.git')).toEqual({
      ok: false,
      code: 'extra_positional',
    })
    expect(policy('git remote add evil https://evil.x')).toEqual({
      ok: false,
      code: 'extra_positional',
    })
    expect(policy('git remote remove origin')).toEqual({ ok: false, code: 'extra_positional' })
  })

  test('F3c: git branch / git remote DẠNG LIST vẫn được phép', () => {
    expect(policy('git branch')).toEqual({ ok: true, code: undefined })
    expect(policy('git remote')).toEqual({ ok: true, code: undefined })
    expect(policy('git branch --show-current')).toEqual({ ok: true, code: undefined })
  })

  test('F4: git show HEAD:.env (secret trong lịch sử commit) → path_not_allowed', () => {
    expect(policy('git show HEAD:.env')).toEqual({ ok: false, code: 'path_not_allowed' })
    expect(policy('git log HEAD~5:./.env.production')).toEqual({
      ok: false,
      code: 'path_not_allowed',
    })
  })

  test('F4b: git show HEAD:../ngoài-repo (escape 1 mức — git resolve theo REPO ROOT) → path_not_allowed', () => {
    expect(policy('git show HEAD:../my-project/worklog.md')).toEqual({
      ok: false,
      code: 'path_not_allowed',
    })
  })

  test('F4c: git show HEAD:./src/lib/exec-allowlist.ts (trong repo, không secret) → được phép', () => {
    expect(policy('git show HEAD:./src/lib/exec-allowlist.ts')).toEqual({ ok: true, code: undefined })
  })

  test('F7: git flag ngắn mọi dạng (-c<cfg>=…, -C=/path, -n5) → bad_flag (long-only)', () => {
    expect(policy('git -cfoo=bar log')).toEqual({ ok: false, code: 'bad_flag' })
    expect(policy('git -C=/tmp log')).toEqual({ ok: false, code: 'bad_flag' })
    expect(policy('git log -n 5')).toEqual({ ok: false, code: 'bad_flag' })
    // dài + tuỳ chọn giá trị vẫn ok
    expect(policy('git log --oneline')).toEqual({ ok: true, code: undefined })
    expect(policy('git log --max-count=5')).toEqual({ ok: true, code: undefined })
  })

  test('F4 (route): git show HEAD:.env qua route thật → 403 path_not_allowed', async () => {
    const res = await POST(makeRequest({ command: 'git show HEAD:.env' }, APP_TOKEN))
    expect(res.status).toBe(403)
    const data = (await res.json()) as { code?: string }
    expect(data.code).toBe('path_not_allowed')
  })
})

describe('r64.2 — usability: lệnh inspect chuẩn phải chạy được (F5)', () => {
  test('ls -la / git status --porcelain / git log --oneline được phép (trước đây 403)', () => {
    expect(policy('ls -la')).toEqual({ ok: true, code: undefined })
    expect(policy('git status --porcelain')).toEqual({ ok: true, code: undefined })
    expect(policy('git log --oneline --max-count=10')).toEqual({ ok: true, code: undefined })
    expect(policy('git diff --name-only')).toEqual({ ok: true, code: undefined })
  })

  test('grep -rn / rg -i / tail -n 20 được phép', () => {
    expect(policy('grep -rn TODO src')).toEqual({ ok: true, code: undefined })
    expect(policy('rg -i pattern src/lib')).toEqual({ ok: true, code: undefined })
    expect(policy('tail -n 20 package.json')).toEqual({ ok: true, code: undefined })
  })

  test('tail -f / -F / --follow (treo tới hết timeout) → bad_flag', () => {
    expect(policy('tail -f dev.log')).toEqual({ ok: false, code: 'bad_flag' })
    expect(policy('tail -F dev.log')).toEqual({ ok: false, code: 'bad_flag' })
    expect(policy('tail -fn20 dev.log')).toEqual({ ok: false, code: 'bad_flag' })
    expect(policy('tail --follow=name dev.log')).toEqual({ ok: false, code: 'bad_flag' })
  })

  test('route: ls -la chạy thật → 200, source=local-exec', async () => {
    const res = await POST(makeRequest({ command: 'ls -la' }, APP_TOKEN))
    expect(res.status).toBe(200)
    const data = (await res.json()) as { source?: string; success?: boolean }
    expect(data.source).toBe('local-exec')
    expect(data.success).toBe(true)
  })
})

describe('r64.2 — F1: một đường thực thi duy nhất (đã gỡ ưu tiên opencode-server)', () => {
  test('pwd → 200 source=local-exec (nhánh remote-shell đã bị gỡ)', async () => {
    const res = await POST(makeRequest({ command: 'pwd' }, APP_TOKEN))
    expect(res.status).toBe(200)
    const data = (await res.json()) as { source?: string; success?: boolean; output?: string }
    expect(data.source).toBe('local-exec')
    expect(data.success).toBe(true)
    expect(typeof data.output).toBe('string')
  })
})

describe('r64.2 — F8: realpath containment (symlink thoát cwd)', () => {
  test('findRealpathEscape bắt symlink trong cwd trỏ ra ngoài (lexical guard không thấy)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tmo-exec-guard-'))
    try {
      symlinkSync('/etc', join(dir, 'etc-link'))
      // Lexical: 'etc-link' resolve nằm TRONG dir → validatePaths cho qua…
      const parsed = parseCommand('ls etc-link')
      expect(parsed.ok).toBe(true)
      if (!parsed.ok) return
      const allow = checkAllowlist(parsed.value)
      expect(allow.ok).toBe(true)
      if (!allow.ok) return
      expect(validatePaths(allow, dir).ok).toBe(true)
      // …nhưng realpath thoát ra ngoài → findRealpathEscape phải bắt được.
      expect(findRealpathEscape(allow, dir)).toBe('etc-link')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('findRealpathEscape bỏ qua path không tồn tại (lệnh sẽ tự lỗi — an toàn)', () => {
    const parsed = parseCommand('ls khong-ton-tai-xyz')
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const allow = checkAllowlist(parsed.value)
    expect(allow.ok).toBe(true)
    if (!allow.ok) return
    expect(findRealpathEscape(allow, '/home/z/tmo-app')).toBe(null)
  })
})