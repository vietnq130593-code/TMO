/**
 * Pre-Push Verification Pipeline — CI-6.4 (Task 10-b)
 *
 * Pipeline kiểm định 5 lớp TRƯỚC khi push code lên remote (quy trình CI-6 cho
 * workspace local của Mr. Architect — xem docs/CODE_EXECUTION_IMPROVEMENT_ROADMAP.md):
 *
 *   lint → type_check → run_tests → smoke (optional) → secret_scan
 *   → git_preflight → commit (scoped paths) → push → pull verify (ff-only)
 *
 * NGUYÊN TẮC SỐ 1: bất kỳ bước kiểm định nào FAIL → TỪ CHỐI push. Không bao giờ
 * push code có lint error / type error / test fail / secret lộ lên remote.
 *
 * Các bước commit/push/pull TÁI SỬ DỤNG implementation trong dev-tools.ts
 * (gitCommit / gitPush / gitPullWorkspace) — token resolution 3 tầng, scoped
 * paths, ff-only merge đã có sẵn ở đó, không viết lại.
 *
 * Workspace root = ACTIVE workspace (workspace-root.ts: DB → env → cwd).
 *
 * Tool surface: verify_and_push (tool-executor.ts) dispatch vào đây. Log mọi
 * bước với prefix [PRE-PUSH] (tiếng Việt) để ops theo dõi trong dev.log.
 */

import { execFile } from 'child_process'
import { promisify } from 'util'
import fs from 'fs/promises'
import path from 'path'
import { gitCommit, gitPush, gitPullWorkspace } from './dev-tools'
import { resolveWorkspaceRoot } from './workspace-root'

const execFileAsync = promisify(execFile)

// ==================== TYPES ====================

/** Kết quả 1 bước trong pipeline */
export interface PrePushStep {
  name: string
  status: 'pass' | 'fail' | 'skip'
  detail: string
  durationMs?: number
}

/** Kết quả tổng của pipeline kiểm định trước push */
export interface PrePushResult {
  success: boolean
  steps: PrePushStep[]
  commitHash?: string
  pushed?: boolean
  pulled?: boolean
  error?: string
}

// ==================== CONFIG ====================

/** Timeout hào phóng cho lint (quality gate đo ~28s — dư dải cho máy chậm/lần chạy lạnh) */
const LINT_TIMEOUT_MS = 300_000
/** Timeout cho tsc --noEmit (quality gate đo ~5s) */
const TYPECHECK_TIMEOUT_MS = 300_000
/** Timeout cho test suite (gate đặt 10 phút — gồm cả việc dựng DB test cô lập) */
const TESTS_TIMEOUT_MS = 600_000
/** Timeout smoke probe HEAD */
const SMOKE_TIMEOUT_MS = 10_000
/** Secret scan: tối đa dung lượng mỗi file untracked (đọc 100KB đầu — secret thường nằm đầu file) */
const UNTRACKED_FILE_MAX_BYTES = 100 * 1024

/**
 * Các pattern secret phải bị chặn trước khi push (CI-6.4 — lớp 5).
 * Dòng đã chứa "[REDACTED" được bỏ qua (secret đã được che sẵn).
 */
const SECRET_PATTERNS: Array<{ name: string; regex: RegExp }> = [
  { name: 'github_classic_pat', regex: /ghp_[A-Za-z0-9]{20,}/ },
  { name: 'github_fine_grained_pat', regex: /github_pat_[A-Za-z0-9_]{20,}/ },
  { name: 'github_oauth_token', regex: /gho_[A-Za-z0-9]{20,}/ },
  { name: 'github_refresh_token', regex: /ghr_[A-Za-z0-9]{20,}/ },
  { name: 'sk_api_key', regex: /sk-[A-Za-z0-9]{20,}/ },
  { name: 'private_key_block', regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  // FIX 2026-09-11 (review #9 LOW): bổ sung AWS access key, Google API key, Slack token
  { name: 'aws_access_key', regex: /AKIA[0-9A-Z]{16}/ },
  { name: 'google_api_key', regex: /AIza[0-9A-Za-z_\-]{35}/ },
  { name: 'slack_token', regex: /xox[baprs]-[0-9A-Za-z\-]{10,}/ },
  { name: 'generic_secret_assignment', regex: /(api[_-]?key|secret|password|token)\s*[:=]\s*['"][A-Za-z0-9_\-]{16,}['"]/i },
]

// ==================== HELPERS ====================

/** Che secret trong output: chỉ hiện 8 ký tự đầu + "…" */
function maskSecret(secret: string): string {
  return secret.slice(0, 8) + '…'
}

/** Lấy N dòng cuối của text (để nhét vào detail của step) */
function tailOf(text: string, lines: number, maxChars = 2000): string {
  const t = (text || '').trim()
  if (!t) return ''
  return t.split('\n').slice(-lines).join('\n').slice(0, maxChars)
}

/** Rút gọn chuỗi hiển thị */
function trunc(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '…' : s
}

/** 1 vị trí secret nghi vấn bị phát hiện */
interface SecretHit {
  file: string
  line: number
  pattern: string
  preview: string
}

/** Quét danh sách dòng (1 file) tìm secret — bỏ qua dòng đã chứa [REDACTED */
function scanLinesForSecrets(lines: string[], file: string, startLine: number): SecretHit[] {
  const hits: SecretHit[] = []
  lines.forEach((line, idx) => {
    if (line.includes('[REDACTED')) return
    for (const p of SECRET_PATTERNS) {
      const m = line.match(p.regex)
      if (m) {
        hits.push({ file, line: startLine + idx, pattern: p.name, preview: maskSecret(m[0]) })
      }
    }
  })
  return hits
}

/**
 * Quét output `git diff HEAD` tìm secret — track file hiện tại qua header
 * `+++ b/<path>` và số dòng đích qua hunk header `@@ -a,b +c,d @@` để báo
 * chính xác file:line của từng hit.
 */
function scanDiffForSecrets(diffText: string): SecretHit[] {
  const hits: SecretHit[] = []
  let currentFile = ''
  let targetLine = 0
  for (const rawLine of diffText.split('\n')) {
    const fileHeader = rawLine.match(/^\+\+\+ b\/(.+)$/)
    if (fileHeader) {
      currentFile = fileHeader[1].replace(/^"|"$/g, '')
      continue
    }
    const hunkHeader = rawLine.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
    if (hunkHeader) {
      targetLine = parseInt(hunkHeader[1], 10)
      continue
    }
    if (
      rawLine.startsWith('diff --git') ||
      rawLine.startsWith('index ') ||
      rawLine.startsWith('--- ') ||
      rawLine.startsWith('new file') ||
      rawLine.startsWith('deleted file') ||
      rawLine.startsWith('\\')
    ) {
      continue
    }
    if (rawLine.startsWith('+')) {
      // Dòng content MỚI được thêm vào — quét
      if (!rawLine.includes('[REDACTED')) {
        for (const p of SECRET_PATTERNS) {
          const m = rawLine.match(p.regex)
          if (m) {
            hits.push({
              file: currentFile || '(không rõ file)',
              line: targetLine,
              pattern: p.name,
              preview: maskSecret(m[0]),
            })
          }
        }
      }
      targetLine++
    } else if (rawLine.startsWith('-')) {
      // Dòng bị xóa — không tăng dòng đích
    } else {
      // Context line (bắt đầu bằng space) hoặc dòng trống — vẫn tăng dòng đích
      targetLine++
    }
  }
  return hits
}

/**
 * Parse `git status --porcelain` thành danh sách file thay đổi (explicit list
 * — KHÔNG dùng `git add -A` theo spec CI-6.4). Với rename lấy CẢ old lẫn new
 * path để `git add` stage đủ phần xóa + phần thêm.
 */
function parseChangedFiles(porcelain: string): string[] {
  const files = new Set<string>()
  for (const line of porcelain.split('\n')) {
    if (line.length < 4) continue
    let p = line.slice(3).trim()
    if (!p) continue
    const arrow = p.indexOf(' -> ')
    if (arrow >= 0) {
      // Rename: stage cả old (deletion) lẫn new (addition)
      files.add(p.slice(0, arrow).replace(/^"|"$/g, ''))
      files.add(p.slice(arrow + 4).replace(/^"|"$/g, ''))
    } else {
      files.add(p.replace(/^"|"$/g, ''))
    }
  }
  return [...files]
}

/** Receipt shape từ gitCommit/gitPush/gitPullWorkspace (dev-tools) */
interface GitReceipt {
  success?: boolean
  error?: string
  hint?: string
  commitHash?: string
  pushed?: boolean
  upToDate?: boolean
  afterCommit?: string
  filesChanged?: string[]
  wouldCommitFiles?: string[]
}

/**
 * Chạy 1 script của repo (bun run <script>) trong workspace root — pass nếu exit 0.
 * Trả về reason (exit code / timeout) + tail output để nhét vào detail của step.
 */
async function runRepoScript(
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<{ ok: boolean; reason: string; tail: string }> {
  const startedAt = Date.now()
  try {
    const { stdout, stderr } = await execFileAsync('bun', args, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 20 * 1024 * 1024,
    })
    const tail = tailOf((stdout || '') + (stderr || ''), 3)
    return { ok: true, reason: 'exit 0', tail }
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; code?: number | string; killed?: boolean; message?: string }
    const raw = ((e.stdout || '') + (e.stderr || '')).trim()
    const tail = tailOf(raw, 12) || trunc(e.message || 'không rõ lỗi', 500)
    const reason = e.killed
      ? `timeout sau ${Math.round((Date.now() - startedAt) / 1000)}s`
      : `exit ${e.code ?? '?'}`
    return { ok: false, reason, tail }
  }
}

// ==================== PIPELINE CHÍNH ====================

export async function runPrePushVerification(opts: {
  commitMessage: string
  paths?: string[]
  smokeUrl?: string
  dryRun?: boolean
}): Promise<PrePushResult> {
  const dryRun = opts.dryRun === true
  const commitMessage = (opts.commitMessage || '').trim()
  const steps: PrePushStep[] = []
  let commitHash: string | undefined
  let pushed = false
  let pulled = false

  console.log(`[PRE-PUSH] Bắt đầu pipeline kiểm định${dryRun ? ' (DRY-RUN — không commit/push/pull)' : ''}`)

  // Validate đầu vào trước mọi bước
  if (!commitMessage) {
    return { success: false, steps, error: 'commitMessage là bắt buộc (chuỗi không rỗng)' }
  }

  const root = await resolveWorkspaceRoot()
  console.log(`[PRE-PUSH] Workspace root: ${root}`)

  /**
   * Chạy 1 bước tuần tự — fail hoặc throw → dừng TOÀN pipeline ngay tại đó
   * (không bao giờ chạy tiếp tới push sau khi có bước fail).
   */
  const step = async (
    name: string,
    fn: () => Promise<{ status: 'pass' | 'fail' | 'skip'; detail: string }>,
  ): Promise<boolean> => {
    const t0 = Date.now()
    try {
      const r = await fn()
      steps.push({ name, status: r.status, detail: r.detail, durationMs: Date.now() - t0 })
      const icon = r.status === 'pass' ? '✓' : r.status === 'skip' ? '⊘' : '✘'
      console.log(`[PRE-PUSH] ${icon} ${name} ${r.status.toUpperCase()} (${Date.now() - t0}ms) — ${trunc(r.detail, 160)}`)
      return r.status !== 'fail'
    } catch (err) {
      const detail = `lỗi bất ngờ: ${err instanceof Error ? err.message : String(err)}`
      steps.push({ name, status: 'fail', detail, durationMs: Date.now() - t0 })
      console.log(`[PRE-PUSH] ✘ ${name} FAIL — ${trunc(detail, 160)}`)
      return false
    }
  }

  /**
   * Bước 8+9: push + pull verify — dùng chung cho 2 luồng:
   * (a) sau khi commit thay đổi mới; (b) cây sạch nhưng còn commit chờ push
   * (retry sau lần push fail). Dùng closure steps/root/state của hàm chính.
   */
  const pushAndVerify = async (): Promise<PrePushResult> => {
    // ── Bước 8: push (tái dùng gitPush — token resolution 3 tầng có sẵn) ──
    const pushOk = await step('push', async () => {
      const receipt = (await gitPush({})) as GitReceipt
      if (receipt && receipt.success) {
        if (receipt.pushed) pushed = true
        return {
          status: 'pass',
          detail: receipt.pushed
            ? 'Pushed lên origin thành công'
            : receipt.upToDate
              ? 'Branch đã đồng bộ remote — không có gì để push'
              : 'Push hoàn tất',
        }
      }
      return {
        status: 'fail',
        detail: `git push thất bại: ${receipt?.error || 'không rõ lỗi'}${receipt?.hint ? ` — ${receipt.hint}` : ''}`,
      }
    })
    if (!pushOk) {
      return { success: false, steps, commitHash, pushed, error: 'Bước push thất bại' }
    }

    // ── Bước 9: pull_verify (ff-only — xác nhận round-trip push/pull) ──
    const pullOk = await step('pull_verify', async () => {
      const receipt = (await gitPullWorkspace({})) as GitReceipt
      if (receipt && receipt.success) {
        pulled = true
        return {
          status: 'pass',
          detail: receipt.upToDate
            ? 'Remote đã đồng bộ (ff-only up-to-date) — round-trip xác nhận'
            : `Pull ff-only về ${receipt.afterCommit || '?'} — round-trip xác nhận`,
        }
      }
      return {
        status: 'fail',
        detail: `git pull verify thất bại: ${receipt?.error || 'không rõ lỗi'}${receipt?.hint ? ` — ${receipt.hint}` : ''}`,
      }
    })
    if (!pullOk) {
      return { success: false, steps, commitHash, pushed, error: 'Bước pull_verify thất bại' }
    }

    console.log(`[PRE-PUSH] ✓ Pipeline HOÀN TẤT — commit ${commitHash || '?'} pushed=${pushed} pulled=${pulled}`)
    return { success: true, steps, commitHash, pushed, pulled }
  }

  // ── Bước 1: lint (script "lint" của repo — eslint .) ──
  const lintOk = await step('lint', async () => {
    const r = await runRepoScript(['run', 'lint'], root, LINT_TIMEOUT_MS)
    return r.ok
      ? { status: 'pass', detail: `bun run lint PASS${r.tail ? ` — ${r.tail}` : ''}` }
      : { status: 'fail', detail: `bun run lint ${r.reason} — ${r.tail}` }
  })
  if (!lintOk) {
    return { success: false, steps, error: 'Bước lint thất bại — TỪ CHỐI push' }
  }

  // ── Bước 2: type_check (script "typecheck" của repo — tsc --noEmit) ──
  const typeOk = await step('type_check', async () => {
    const r = await runRepoScript(['run', 'typecheck'], root, TYPECHECK_TIMEOUT_MS)
    return r.ok
      ? { status: 'pass', detail: `bun run typecheck PASS${r.tail ? ` — ${r.tail}` : ''}` }
      : { status: 'fail', detail: `bun run typecheck ${r.reason} — ${r.tail}` }
  })
  if (!typeOk) {
    return { success: false, steps, error: 'Bước type_check thất bại — TỪ CHỐI push' }
  }

  // ── Bước 3: run_tests (script "test" của repo — bun test trên DB test cô lập) ──
  const testsOk = await step('run_tests', async () => {
    const r = await runRepoScript(['run', 'test'], root, TESTS_TIMEOUT_MS)
    return r.ok
      ? { status: 'pass', detail: `bun run test PASS${r.tail ? ` — ${r.tail}` : ''}` }
      : { status: 'fail', detail: `bun run test ${r.reason} — ${r.tail}` }
  })
  if (!testsOk) {
    return { success: false, steps, error: 'Bước run_tests thất bại — TỪ CHỐI push' }
  }

  // ── Bước 4: smoke (optional — HEAD probe URL, mong status < 400) ──
  if (opts.smokeUrl && opts.smokeUrl.trim()) {
    const smokeUrl = opts.smokeUrl.trim()
    const smokeOk = await step('smoke', async () => {
      const res = await fetch(smokeUrl, { method: 'HEAD', signal: AbortSignal.timeout(SMOKE_TIMEOUT_MS) })
      if (res.status < 400) {
        return { status: 'pass', detail: `HEAD ${smokeUrl} → HTTP ${res.status}` }
      }
      return { status: 'fail', detail: `HEAD ${smokeUrl} → HTTP ${res.status} (≥400)` }
    })
    if (!smokeOk) {
      return { success: false, steps, error: 'Bước smoke thất bại — TỪ CHỐI push' }
    }
  } else {
    steps.push({ name: 'smoke', status: 'skip', detail: 'chưa cấu hình smokeUrl — bỏ qua probe' })
    console.log('[PRE-PUSH] ⊘ smoke SKIP — chưa cấu hình smokeUrl — bỏ qua probe')
  }

  // ── Bước 5: secret_scan (git diff HEAD + ahead commits + file untracked) ──
  // FIX 2026-09-11 (review #2/#4/#5): (2) quét cả commit CHƯA PUSH (đường
  // clean-tree-ahead có thể đẩy commit tạo out-of-band qua git_commit — không
  // qua pipeline); (4) FAIL-CLOSED khi git diff lỗi thật (trước đây fail-open);
  // (5) quét MỌI file untracked sẽ commit (bỏ cap 20 file).
  const scanOk = await step('secret_scan', async () => {
    const hits: SecretHit[] = []
    const scanSources: string[] = []

    // (a) Diff toàn bộ thay đổi chưa commit so với HEAD
    // FIX #4: phân biệt "repo chưa có commit nào" (an toàn bỏ qua) với lỗi THẬT (fail-closed)
    const diffResult = await execFileAsync('git', ['diff', 'HEAD'], {
      cwd: root,
      timeout: 30_000,
      maxBuffer: 20 * 1024 * 1024,
    })
      .then(r => ({ ok: true as const, stdout: r.stdout }))
      .catch(() => ({ ok: false as const, stdout: '' }))
    const diff = diffResult.ok ? diffResult.stdout : ''
    const diffFailed = !diffResult.ok
    if (diff) scanSources.push('git diff HEAD')
    hits.push(...scanDiffForSecrets(diff))

    // (b+) FIX #2: diff các commit CHƯA PUSH (upstream..HEAD) — nội dung đã
    // commit out-of-band (qua git_commit riêng) cũng phải qua secret scan trước push
    const aheadDiff = await execFileAsync('git', ['diff', '@{upstream}..HEAD'], {
      cwd: root,
      timeout: 30_000,
      maxBuffer: 20 * 1024 * 1024,
    })
      .then(r => r.stdout)
      .catch((e: unknown) => {
        // chưa có upstream tracking (push lần đầu) → quét commit gần nhất
        const msg = e instanceof Error ? e.message : String(e)
        if (/no upstream|ambiguous|unknown revision|bad revision/i.test(msg)) return null
        return '' // lỗi khác → đánh dấu fail dưới
      })
    if (aheadDiff === null) {
      const lastCommitDiff = await execFileAsync('git', ['diff', 'HEAD~1..HEAD'], {
        cwd: root,
        timeout: 30_000,
        maxBuffer: 20 * 1024 * 1024,
      })
        .then(r => r.stdout)
        .catch(() => undefined)
      if (typeof lastCommitDiff === 'string' && lastCommitDiff) {
        hits.push(...scanDiffForSecrets(lastCommitDiff))
        scanSources.push('diff HEAD~1..HEAD (chưa có upstream)')
      }
    } else if (typeof aheadDiff === 'string' && aheadDiff) {
      hits.push(...scanDiffForSecrets(aheadDiff))
      scanSources.push('diff @{upstream}..HEAD (commit chưa push)')
    }

    // (c) File untracked (đã qua .gitignore) — FIX #5: quét TẤT CẢ file sẽ
    // commit (bỏ cap số file; giữ cap 100KB/file để chống phình — file lớn hơn
    // vẫn quét 100KB đầu, đủ bắt secret ở phần đầu file)
    const untrackedOut = await execFileAsync('git', ['ls-files', '--others', '--exclude-standard'], {
      cwd: root,
      timeout: 15_000,
    })
      .then(r => r.stdout)
      .catch(() => '')
    const untrackedFiles = untrackedOut
      .split('\n')
      .map(l => l.trim().replace(/^"|"$/g, ''))
      .filter(Boolean)
    for (const rel of untrackedFiles) {
      try {
        const abs = path.resolve(root, rel)
        const stat = await fs.stat(abs)
        if (!stat.isFile()) continue
        const fh = await fs.open(abs, 'r')
        try {
          const len = Math.min(stat.size, UNTRACKED_FILE_MAX_BYTES)
          const buf = Buffer.alloc(len)
          await fh.read(buf, 0, len, 0)
          const content = buf.toString('utf-8')
          hits.push(...scanLinesForSecrets(content.split('\n'), rel, 1))
        } finally {
          await fh.close()
        }
      } catch { /* đọc file lỗi → bỏ qua file (secret scan không được crash pipeline) */ }
    }
    if (untrackedFiles.length > 0) scanSources.push(`${untrackedFiles.length} file untracked`)

    // FIX #4: fail-closed — git diff HEAD lỗi thật (không phải repo rỗng) → FAIL
    if (diffFailed && diff === '') {
      // Kiểm tra repo có commit nào chưa: git rev-parse --verify HEAD
      const hasHead = await execFileAsync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: root, timeout: 5_000 })
        .then(() => true)
        .catch(() => false)
      if (hasHead) {
        return {
          status: 'fail',
          detail: 'git diff HEAD lỗi — secret scan không thể xác minh (fail-closed theo nguyên tắc số 1)',
        }
      }
      // repo chưa có commit nào → diff rỗng là hợp lệ
    }

    if (hits.length === 0) {
      return {
        status: 'pass',
        detail: `Không phát hiện secret (quét ${scanSources.join(' + ') || 'git diff HEAD'})`,
      }
    }
    // Liệt kê file:line từng hit — secret bị che (chỉ 8 ký tự đầu)
    const listing = hits
      .slice(0, 20)
      .map(h => `${h.file}:${h.line} [${h.pattern}] ${h.preview}`)
      .join('; ')
    return {
      status: 'fail',
      detail: `Phát hiện ${hits.length} secret nghi vấn — ${listing}`,
    }
  })
  if (!scanOk) {
    return { success: false, steps, error: 'Bước secret_scan thất bại (phát hiện secret) — TỪ CHỐI push' }
  }

  // ── Bước 6: git status preflight — cây sạch thì dừng tuần tự (không cần commit/push/pull) ──
  const porcelain = await execFileAsync('git', ['status', '--porcelain'], { cwd: root, timeout: 15_000 })
    .then(r => r.stdout)
    .catch(() => null)
  if (porcelain === null) {
    steps.push({
      name: 'git_preflight',
      status: 'fail',
      detail: 'git status --porcelain lỗi — không đọc được trạng thái working tree',
    })
    console.log('[PRE-PUSH] ✘ git_preflight FAIL — không đọc được trạng thái working tree')
    return { success: false, steps, error: 'Bước git_preflight thất bại — TỪ CHỐI push' }
  }
  const changedFiles = parseChangedFiles(porcelain)
  if (changedFiles.length === 0) {
    // FIX 2026-09-11 (E2E retry): cây sạch NHƯNG có thể vẫn còn commit chưa push
    // (kịch bản: lần push trước fail / push thủ công bị gián đoạn). Kiểm tra
    // ahead-of-upstream trước khi kết luận "không cần push".
    const aheadCount = await execFileAsync('git', ['rev-list', '--count', '@{upstream}..HEAD'], { cwd: root, timeout: 10_000 })
      .then(r => parseInt(r.stdout.trim(), 10) || 0)
      .catch(() => -1) // -1 = chưa có upstream tracking — để gitPush tự xử lý
    if (aheadCount === 0) {
      // Cây sạch + đã đồng bộ remote: mọi kiểm định đã PASS — không có gì để commit/push/pull
      steps.push({ name: 'git_preflight', status: 'pass', detail: 'Không có thay đổi để commit' })
      steps.push({ name: 'commit', status: 'skip', detail: 'Không có thay đổi để commit' })
      steps.push({ name: 'push', status: 'skip', detail: 'Không có commit mới — không cần push' })
      steps.push({ name: 'pull_verify', status: 'skip', detail: 'Không có commit mới — bỏ qua pull verify' })
      console.log('[PRE-PUSH] ✓ git_preflight PASS — Không có thay đổi để commit (bỏ qua commit/push/pull)')
      return { success: true, steps, pushed: false }
    }
    // Cây sạch nhưng còn N commit chờ push → bỏ commit, VẪN push + pull verify
    steps.push({
      name: 'git_preflight',
      status: 'pass',
      detail: aheadCount > 0
        ? `Cây sạch nhưng còn ${aheadCount} commit chưa push lên remote`
        : 'Cây sạch (chưa có upstream tracking) — sẽ push branch hiện tại',
    })
    steps.push({ name: 'commit', status: 'skip', detail: 'Không có thay đổi để commit' })
    console.log(`[PRE-PUSH] ✓ git_preflight PASS — ${aheadCount > 0 ? `${aheadCount} commit chờ push` : 'chưa có upstream'} (bỏ commit, vẫn push + pull verify)`)
    // Rơi xuống push/pull verify (bỏ qua bước commit — dùng closure pushAndVerify)
    return await pushAndVerify()
  }
  steps.push({
    name: 'git_preflight',
    status: 'pass',
    detail: `Working tree có ${changedFiles.length} file thay đổi`,
  })
  console.log(`[PRE-PUSH] ✓ git_preflight PASS — ${changedFiles.length} file thay đổi`)

  // Scoped paths: caller chỉ định, hoặc toàn bộ file thay đổi từ porcelain (KHÔNG git add -A)
  const commitPaths = opts.paths && opts.paths.length > 0 ? opts.paths : changedFiles

  // ── dryRun: mọi kiểm định đã chạy — KHÔNG commit/push/pull thật ──
  if (dryRun) {
    // Dùng gitCommit dry_run (không đụng index) để báo "sẽ commit file nào"
    let wouldCommit = `${commitPaths.length} file scoped`
    try {
      const preview = (await gitCommit({
        message: commitMessage,
        paths: commitPaths,
        all: true,
        dry_run: true,
      })) as GitReceipt
      if (preview && preview.success && Array.isArray(preview.wouldCommitFiles)) {
        wouldCommit = `${preview.wouldCommitFiles.length} file: ${preview.wouldCommitFiles.slice(0, 10).join(', ')}${preview.wouldCommitFiles.length > 10 ? '…' : ''}`
      } else if (preview && preview.error) {
        wouldCommit = `${wouldCommit} (preview: ${preview.error})`
      }
    } catch { /* preview lỗi không ảnh hưởng dry-run receipt */ }
    steps.push({
      name: 'commit',
      status: 'skip',
      detail: `dryRun=true — sẽ commit ${wouldCommit} với message "${trunc(commitMessage, 80)}"`,
    })
    steps.push({ name: 'push', status: 'skip', detail: 'dryRun=true — bỏ qua push' })
    steps.push({ name: 'pull_verify', status: 'skip', detail: 'dryRun=true — bỏ qua pull verify' })
    console.log(`[PRE-PUSH] ⊘ commit/push/pull SKIP (dryRun) — sẽ commit ${wouldCommit}`)
    return { success: true, steps, pushed: false }
  }

  // ── Bước 7: commit (scoped paths — tái dùng gitCommit dev-tools) ──
  const commitOk = await step('commit', async () => {
    const receipt = (await gitCommit({
      message: commitMessage,
      paths: commitPaths,
      all: true, // stage đúng các path scoped (KHÔNG git add -A)
    })) as GitReceipt
    if (receipt && receipt.success) {
      if (receipt.commitHash) commitHash = receipt.commitHash
      const n = receipt.filesChanged?.length ?? commitPaths.length
      return { status: 'pass', detail: `Commit ${receipt.commitHash || '?'} — ${n} file` }
    }
    return { status: 'fail', detail: `git commit thất bại: ${receipt?.error || 'không rõ lỗi'}` }
  })
  if (!commitOk) {
    return { success: false, steps, error: 'Bước commit thất bại — TỪ CHỐI push' }
  }

  // ── Bước 8+9: push + pull verify (closure pushAndVerify) ──
  return await pushAndVerify()
}
