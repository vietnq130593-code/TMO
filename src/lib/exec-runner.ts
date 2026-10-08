// ============================================
// src/lib/exec-runner.ts — THỰC THI lệnh đã qua allowlist
//
// Nguyên tắc bất di bất dịch ở file này:
//   1. execFile(shell:false) — KHÔNG bao giờ nối chuỗi vào shell.
//      `;` `|` `&&` `$()` chỉ là byte vô hại trong argv.
//   2. env là ALLOWLIST key, không phải {...process.env} → lệnh con không
//      nhìn thấy TMO_API_TOKEN / OPENCODE_API_KEY / DATABASE_URL.
//   3. timeout + maxBuffer luôn có → không treo event loop, không nuốt RAM.
//   4. Output bị cắt cứng + đánh dấu `truncated`.
//   5. KHÔNG log raw command / raw env (có thể chứa secret do user gõ).
// ============================================

import { execFile } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { isInside, LIMITS, type AllowResult } from './exec-allowlist'

/** Chỉ copy các key env vô hại — chủ động KHÔNG kế thừa process.env. */
const ENV_ALLOWLIST = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LC_ALL',
  'TZ',
  'TMPDIR',
  'TEMP',
  'TMP',
  'SystemRoot',
  'windir',
  'COMSPEC',
  'PATHEXT',
] as const

export function buildSafeEnv(): Record<string, string> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    LANG: process.env.LANG ?? 'C.UTF-8',
    TZ: process.env.TZ ?? 'UTC',
    // Không tô màu / không phân trang → output parse được và nhỏ hơn
    FORCE_COLOR: '0',
    NO_COLOR: '1',
    CI: '1',
    TERM: 'dumb',
    GIT_TERMINAL_PROMPT: '0',
    GIT_PAGER: 'cat',
  }
  for (const key of ENV_ALLOWLIST) {
    const value = process.env[key]
    if (typeof value === 'string') env[key] = value
  }
  return env
}

export interface RunOptions {
  cwd: string
  timeoutMs: number
}

export type RunFailure = 'timeout' | 'output_overflow' | 'spawn_failed' | 'nonzero'

export interface RunResult {
  ok: boolean
  output: string
  exitCode: number
  truncated: boolean
  durationMs: number
  failure?: RunFailure
}

/** Cắt chuỗi theo byte (không cắt giữa 1 ký tự UTF-16 → không sinh surrogate lạ). */
function truncate(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return { text, truncated: false }
  return { text: Buffer.from(text, 'utf8').subarray(0, maxBytes).toString('utf8'), truncated: true }
}

/** Clamp timeout do client gửi — không cho cấp 10 phút như bản cũ. */
export function resolveTimeoutMs(candidate: unknown): number {
  if (typeof candidate !== 'number' || !Number.isFinite(candidate)) {
    return LIMITS.defaultTimeoutMs
  }
  const ms = Math.floor(candidate)
  if (ms <= 0) return LIMITS.defaultTimeoutMs
  return Math.min(ms, LIMITS.maxTimeoutMs)
}

/**
 * r64.2 (audit lượt 6 — F8): path guard ở exec-allowlist là LEXICAL — một
 * symlink trong cwd trỏ ra ngoài (`cat link/etc/passwd`) sẽ thoát containment
 * vì lệnh con đi theo symlink thật. Với path TỒN TẠI, so realpath thật phải
 * nằm trong realpath(cwd); path chưa tồn tại bỏ qua (lệnh sẽ tự lỗi — an toàn).
 * Trả về arg vi phạm đầu tiên, hoặc null nếu sạch.
 */
export function findRealpathEscape(
  allow: Extract<AllowResult, { ok: true }>,
  cwd: string
): string | null {
  if (!allow.rule.pathsOnly) return null
  let realCwd: string | null = null
  for (const arg of allow.args) {
    if (arg.startsWith('-')) continue
    if (allow.subcommand && arg === allow.subcommand) continue
    const candidates = [arg]
    if (allow.rule.revPathAware && arg.includes(':')) {
      const pathPart = arg.slice(arg.indexOf(':') + 1)
      if (pathPart) candidates.push(pathPart)
    }
    for (const candidate of candidates) {
      const absolute = isAbsolute(candidate) ? resolve(candidate) : resolve(cwd, candidate)
      if (!existsSync(absolute)) continue
      realCwd ??= realpathSync(cwd)
      const real = realpathSync(absolute)
      if (!isInside(realCwd, real)) return arg
    }
  }
  return null
}

/**
 * Chạy lệnh đã được allowlist duyệt. Tuyệt đối không nhận `command` dạng
 * chuỗi từ người dùng — chỉ nhận `allow.args` đã token-hoá.
 */
export function runAllowedCommand(
  allow: Extract<AllowResult, { ok: true }>,
  options: RunOptions
): Promise<RunResult> {
  const { bin, args, cwd, timeoutMs } = { ...allow, ...options }
  const startedAt = Date.now()

  return new Promise<RunResult>((resolve) => {
    execFile(
      bin,
      args,
      {
        // shell:false là mặc định — nêu tường minh để không ai đổi nhầm
        shell: false,
        cwd,
        // cast: Record<string,string> → ProcessEnv (NODE_ENV required by Next types)
        env: buildSafeEnv() as NodeJS.ProcessEnv,
        timeout: timeoutMs,
        maxBuffer: LIMITS.maxOutputBytes,
        encoding: 'utf8',
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const durationMs = Date.now() - startedAt
        const err = error as (Error & { killed?: boolean; code?: string; status?: number }) | null
        const out = typeof stdout === 'string' ? stdout : ''
        const errOut = typeof stderr === 'string' ? stderr : ''

        // ĐO THẬT (bun 1.4.2 / node): khi vượt maxBuffer, Node trả
        // code='ERR_CHILD_PROCESS_STDIO_MAXBUFFER' nhưng `killed` = undefined
        // (chỉ timeout mới set killed). → phải kiểm `code` TRƯỚC `killed`.
        if (err && err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
          resolve({
            ok: false,
            output: truncate(errOut, LIMITS.maxOutputBytes).text.slice(0, 4096),
            exitCode: err.status ?? 1,
            truncated: true,
            durationMs,
            failure: 'output_overflow',
          })
          return
        }
        if (err && err.killed) {
          resolve({
            ok: false,
            output: errOut.slice(0, 4096),
            exitCode: err.status ?? 1,
            truncated: false,
            durationMs,
            failure: 'timeout',
          })
          return
        }
        if (err && typeof err.code === 'string' && err.code === 'ENOENT') {
          resolve({
            ok: false,
            output: `binary not found: ${bin}`,
            exitCode: 127,
            truncated: false,
            durationMs,
            failure: 'spawn_failed',
          })
          return
        }

        const combined = (out + (errOut ? (out ? '\n' : '') + errOut : '')).trim()
        const capped = truncate(combined, LIMITS.maxOutputBytes)
        if (err) {
          resolve({
            ok: false,
            output: capped.text,
            exitCode: typeof err.status === 'number' ? err.status : 1,
            truncated: capped.truncated,
            durationMs,
            failure: 'nonzero',
          })
          return
        }
        resolve({
          ok: true,
          output: capped.text,
          exitCode: 0,
          truncated: capped.truncated,
          durationMs,
        })
      }
    )
  })
}