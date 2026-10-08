// ============================================
// src/app/api/opencode/execute/route.ts — P0-1 FIX
//
// TRƯỚC (RCE):
//   const output = execSync(command, { cwd: cwd || process.cwd(),
//                                      env: { ...process.env, FORCE_COLOR: '0' } })
//   - `command` lấy thẳng từ body → chuỗi shell tùy ý (RCE)
//   - `cwd` lấy thẳng từ body → chạy ở bất kỳ thư mục nào trên máy
//   - env = {...process.env} → lệnh con đọc được TMO_API_TOKEN / DATABASE_URL
//   - KHÔNG có auth trong route (chỉ dựa vào proxy/middleware)
//   - timeout 10 phút, maxBuffer 10MB
//
// SAU:
//   1. auth + authorization thực hiện LOCAL trong route (không chỉ dựa vào proxy)
//   2. command → argv (parseCommand) rồi kiểm allowlist (checkAllowlist)
//   3. execFile(shell:false) → KHÔNG bao giờ nối chuỗi người dùng vào shell
//   4. cwd bị ràng buộc trong allowed roots; arg dạng path không được đọc secret
//   5. timeout ≤ 30s, output cắt cứng 256KB, env là allowlist key
//   6. log chỉ bin/subcommand/fingerprint — không log raw command/env
//
// Policy thuần (không import child_process) nằm ở src/lib/exec-allowlist.ts,
// runner nằm ở src/lib/exec-runner.ts.
// ============================================

import { NextResponse } from 'next/server'
import { timingSafeEqual } from 'node:crypto'
import { ensureTmoApiToken } from '@/lib/tmo-token'
import {
  checkAllowlist,
  commandFingerprint,
  LIMITS,
  parseCommand,
  resolveSafeCwd,
  validatePaths,
} from '@/lib/exec-allowlist'
import { findRealpathEscape, resolveTimeoutMs, runAllowedCommand } from '@/lib/exec-runner'

export const dynamic = 'force-dynamic'

/** Body > 8KB là dấu hiệu lạm dụng — từ chối trước khi JSON.parse */
const MAX_BODY_CHARS = 8 * 1024
/**
 * r64.2 (audit lượt 6 — F9): chặn theo Content-Length TRƯỚC request.text()
 * để không buffer body khổng lồ vào RAM mới phát hiện vượt cap. UTF-8 tối đa
 * 4 byte/char + slack — không bao giờ từ chối body hợp lệ theo cap ký tự.
 */
const MAX_BODY_BYTES = MAX_BODY_CHARS * 4 + 1024

/** So sánh constant-time; chỉ lộ độ dài (không đáng kể với token cố định). */
function safeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8')
  const bufB = Buffer.from(b, 'utf8')
  if (bufA.length !== bufB.length || bufA.length === 0) return false
  return timingSafeEqual(bufA, bufB)
}

function readCookie(request: Request, name: string): string | null {
  const raw = request.headers.get('cookie')
  if (!raw) return null
  for (const part of raw.split(';')) {
    const [key, ...rest] = part.trim().split('=')
    if (key === name) return rest.join('=') || null
  }
  return null
}

/** Token do caller trình: Bearer > header > cookie. KHÔNG nhận query (?token=) — query rò vào access log. */
function extractToken(request: Request): string | null {
  const authorization = request.headers.get('authorization')
  if (authorization?.startsWith('Bearer ')) {
    const value = authorization.slice('Bearer '.length).trim()
    if (value) return value
  }
  const header = request.headers.get('x-tmo-api-token')?.trim()
  if (header) return header
  return readCookie(request, 'tmo_api_token')
}

type Gate = { ok: true } | { ok: false; status: number; message: string }

/** AUTH (local): phải có token hợp lệ của app. Fail-closed. */
function authenticate(request: Request): Gate {
  let expected: string | null = null
  try {
    expected = ensureTmoApiToken() ?? process.env.TMO_API_TOKEN ?? null
  } catch {
    expected = null
  }
  if (!expected) {
    return { ok: false, status: 503, message: 'Auth not configured — TMO_API_TOKEN unavailable' }
  }
  const token = extractToken(request)
  if (!token || !safeEquals(token, expected)) {
    return { ok: false, status: 401, message: 'Unauthorized' }
  }
  return { ok: true }
}

/**
 * AUTHORIZATION (local): nếu admin cấu hình TMO_EXEC_TOKEN (token riêng, ≥16 ký tự)
 * thì CHỈ token đó mới được quyền execute — token app thường bị từ chối 403.
 * Không cấu hình → mọi credential đã xác thực đều có quyền (fail-open có chủ đích,
 * để không làm hỏng module Code; cấu hình TMO_EXEC_TOKEN để siết).
 */
function authorize(request: Request): Gate {
  const execToken = process.env.TMO_EXEC_TOKEN?.trim()
  if (!execToken || execToken.length < 16) return { ok: true }
  const token = extractToken(request) ?? ''
  if (!safeEquals(token, execToken)) {
    return {
      ok: false,
      status: 403,
      message: 'Forbidden — this credential may not execute commands',
    }
  }
  return { ok: true }
}

function reject(status: number, message: string, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ success: false, error: message, exitCode: -1, ...extra }, { status })
}

/**
 * POST /api/opencode/execute
 * Body: { command: string, sessionId?: string, cwd?: string, timeoutMs?: number }
 * Chỉ nhận lệnh READ-ONLY trong allowlist (git status/log/diff/show/…, ls, cat, …).
 */
export async function POST(request: Request) {
  try {
    // ---- 1. AUTH + AUTHORIZATION (local, không dựa vào proxy) ----
    const auth = authenticate(request)
    if (!auth.ok) return reject(auth.status, auth.message)

    const authz = authorize(request)
    if (!authz.ok) return reject(authz.status, authz.message)

    // ---- 2. BODY (giới hạn kích thước trước khi parse) ----
    const contentLength = Number(request.headers.get('content-length') ?? '0')
    if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
      return reject(413, `request body too large (max ${MAX_BODY_CHARS} characters)`)
    }
    const raw = await request.text()
    if (raw.length > MAX_BODY_CHARS) {
      return reject(413, `request body too large (max ${MAX_BODY_CHARS} characters)`)
    }
    let body: { command?: unknown; sessionId?: unknown; cwd?: unknown; timeoutMs?: unknown }
    try {
      body = JSON.parse(raw || '{}') as typeof body
    } catch {
      return reject(400, 'invalid JSON body')
    }

    // ---- 3. TOKEN HOÁ (KHÔNG shell) ----
    const parsed = parseCommand(body.command)
    if (!parsed.ok) {
      return reject(400, parsed.message, { code: parsed.error })
    }

    // ---- 4. ALLOWLIST ----
    const allow = checkAllowlist(parsed.value)
    if (!allow.ok) {
      console.warn(
        `[opencode/execute] DENY ${allow.code} bin=${parsed.value.bin} ` +
          `fp=${commandFingerprint(parsed.value.tokens.join(' '))}`
      )
      return reject(403, allow.message, { code: allow.code })
    }

    // ---- 5. CWD an toàn ----
    const cwdResult = resolveSafeCwd(body.cwd)
    if (!cwdResult.ok) return reject(403, cwdResult.message, { code: 'cwd_not_allowed' })
    const cwd = cwdResult.cwd

    // ---- 6. ARG DẠNG PATH: phải trong cwd, không đọc file secret ----
    // r64.2 (F4+F6): hợp nhất về validatePaths của lib (trước đây route tự
    // viết lại vòng kiểm — trùng lặp + thiếu nhánh rev:path `HEAD:.env`);
    // kèm realpath containment (F8) chặn symlink thoát cwd.
    const pathCheck = validatePaths(allow, cwd)
    if (!pathCheck.ok) {
      console.warn(
        `[opencode/execute] DENY ${pathCheck.code} bin=${allow.bin} ` +
          `fp=${commandFingerprint(parsed.value.tokens.join(' '))}`
      )
      return reject(403, pathCheck.message, { code: pathCheck.code })
    }
    const escape = findRealpathEscape(allow, cwd)
    if (escape) {
      console.warn(
        `[opencode/execute] DENY symlink_escape bin=${allow.bin} ` +
          `fp=${commandFingerprint(parsed.value.tokens.join(' '))}`
      )
      return reject(403, `path not allowed (symlink escapes cwd): ${escape}`, {
        code: 'path_not_allowed',
      })
    }

    const timeoutMs = resolveTimeoutMs(body.timeoutMs)
    console.log(
      `[opencode/execute] ALLOW bin=${allow.bin} sub=${allow.subcommand ?? '-'} ` +
        `timeoutMs=${timeoutMs} fp=${commandFingerprint(parsed.value.tokens.join(' '))}`
    )

    // ---- 7. LOCAL EXEC — execFile(shell:false), argv đã kiểm duyệt ----
    // r64.2 (F1): ĐÃ GỞ nhánh "ưu tiên opencode-server" — server đó thực thi
    // qua execSync (shell thật) → tilde/glob expansion (`cat ~/.*`,
    // `cat ~/tmo-app/db/custom.db`) thoát path guard, chạy sai cwd yêu cầu
    // (WORKSPACE thay vì body.cwd) và kế thừa env đầy của server. Một đường
    // thực thi duy nhất = containment deterministic. Tham chiếu lịch sử:
    // P0-2 (inventory mission #18) còn để opencode-server /execute (blocklist
    // execSync) + /lsp/diagnostics (grep interpolation) — đề bài mission sau.
    const command = parsed.value.tokens.join(' ')
    const run = await runAllowedCommand(allow, { cwd, timeoutMs })
    const payload = {
      success: run.ok,
      output: run.output,
      error: run.ok ? undefined : (run.failure ?? `command failed (exit ${run.exitCode})`),
      command,
      exitCode: run.exitCode,
      truncated: run.truncated,
      durationMs: run.durationMs,
      source: 'local-exec',
    }
    if (run.ok) return NextResponse.json(payload)

    // timeout / overflow là lỗi chính sách, không phải lỗi người dùng → 400
    if (run.failure === 'timeout') {
      return NextResponse.json(
        { ...payload, error: `command timed out after ${timeoutMs}ms` },
        { status: 400 }
      )
    }
    if (run.failure === 'output_overflow') {
      return NextResponse.json(
        { ...payload, error: `command output exceeded ${LIMITS.maxOutputBytes} bytes limit` },
        { status: 400 }
      )
    }
    return NextResponse.json(payload, { status: 400 })
  } catch (error) {
    console.error('[opencode/execute] unexpected error:', error instanceof Error ? error.name : 'unknown')
    return reject(500, 'internal error')
  }
}