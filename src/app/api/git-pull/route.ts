/**
 * Git Pull API — Pull latest code from GitHub repository
 *
 * GET  /api/git-pull — Return current git config (remote URL, branch, commit)
 *                      + saved GitHub token (pre-fill dialog) + default repo URL
 * POST /api/git-pull — Execute git pull with custom remote URL and token
 *                      Token nhập vào được TỰ ĐỘNG LƯU (ghi đè token cũ nếu khác)
 *                      body: { repoUrl?, apiToken?, branch?, dryRun?, forgetToken? }
 *
 * Strategy: AGGRESSIVE CHECKOUT — overwrite all files except database data.
 *   - Fetch remote → list changed files → checkout each non-protected file from FETCH_HEAD
 *   - Protected dirs (db/, upload/, qdrant-storage/, agent-ctx/) are NEVER touched
 *     FIX 2026-09-15 (Task 25): file bảo vệ bị BỎ QUA (skip) thay vì chặn cả pull 403
 *     (hành vi cũ khiến Pull code không bao giờ chạy được khi repo local track db//upload/
 *     cho reset-survival mà remote không có). Local artifacts (worklog, tool-results,
 *     bin/, dev.log) cũng được GIỮ NGUYÊN thay vì bị git rm như luồng cũ.
 *   - .env is smart-merged: local values preserved, new keys from remote added
 *   - No "would be overwritten" errors — we force-checkout each file individually
 *   - Token safety: never stores token in .git/config (saved token lives in db/.github-token.json)
 *   - Shell-safe: uses execFile to avoid shell injection
 *   - Mutex: prevents concurrent pull operations
 */

import { NextRequest, NextResponse } from 'next/server'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, rmSync, cpSync } from 'fs'
import { join } from 'path'
import { getSavedGithubTokenInfo, saveGithubToken, clearSavedGithubToken, getSavedGithubToken } from '@/lib/github-token-store'

const execFileAsync = promisify(execFile)

export const dynamic = 'force-dynamic'

/**
 * Repo mặc định khi không có git remote nào cấu hình (user request 2026-08-29).
 * CI-6 (Task 10-b): ưu tiên env TMO_REPO_URL (kho chuẩn của Mr. Architect —
 * https://github.com/nguyenquocviety2c-code/TMO, user-confirmed round-12).
 */
const DEFAULT_REPO_URL = process.env.TMO_REPO_URL || 'https://github.com/nguyenquocviety2c-code/TMO'

/** Protected directories that must never be affected by a git pull — database data lives here */
const PROTECTED_DIRS = ['db/', 'upload/', 'qdrant-storage/', 'agent-ctx/']
/** Files to smart-merge (not force-overwrite) after pull */
const SMART_MERGE_FILES = ['.env']

// ── FIX 2026-09-15 (Task 25): local-only artifacts — không bao giờ bị pull
// ghi đè hay XÓA. Repo local (platform) và remote có thể KHÁC lịch sử (local
// được git-init riêng + track db//upload/ cho reset-survival) — các file dưới
// đây không tồn tại trên remote, và luồng pull cũ sẽ `git rm --force` chúng
// ngay khi checkout fail. worklog/tool-results = audit trail multi-agent của
// platform; bin/qdrant = binary hạ tầng Qdrant; dev.log = log dev server.
const LOCAL_PRESERVE_EXACT = ['worklog.md', 'dev.log']
const LOCAL_PRESERVE_PREFIX = ['tool-results/', 'bin/']

// ─── MUTEX: Prevent concurrent pull operations ─────────────────────────────────
let pullInProgress = false

/** Mask a token for safe logging — show first 4 and last 4 chars */
function maskToken(token: string): string {
  if (token.length <= 8) return '****'
  return token.slice(0, 4) + '****' + token.slice(-4)
}

/** Mask a token value that may appear in an error/log string */
function maskTokenInString(str: string, token: string): string {
  if (!token) return str
  return str.split(token).join(maskToken(token))
}

/**
 * Sanitize API token: trim whitespace, strip common prefixes/labels.
 * Handles: "API Token: ghp_xxx" → "ghp_xxx", "ghp_xxx " → "ghp_xxx"
 */
function sanitizeToken(token: string): string {
  let cleaned = token.trim()
  const labelPatterns = [
    /^api\s*token\s*[:=]\s*/i,
    /^token\s*[:=]\s*/i,
    /^github\s*token\s*[:=]\s*/i,
    /^pat\s*[:=]\s*/i,
    /^password\s*[:=]\s*/i,
    /^key\s*[:=]\s*/i,
  ]
  for (const pattern of labelPatterns) {
    cleaned = cleaned.replace(pattern, '')
  }
  cleaned = cleaned.replace(/^["']|["']$/g, '')
  cleaned = cleaned.trim()
  cleaned = cleaned.replace(/[\s\r\n]+/g, '')
  return cleaned
}

/**
 * Parse a remote URL and strip any embedded token.
 * Supports HTTPS and SSH formats.
 */
function parseRemoteUrl(url: string): {
  cleanUrl: string
  embeddedToken: string | null
  host: string
  path: string
  isSSH: boolean
} {
  let embeddedToken: string | null = null
  let cleanUrl = url
  let isSSH = false

  const sshMatch = url.match(/^git@([^:]+):(.+?)(?:\.git)?$/)
  if (sshMatch) {
    isSSH = true
    return { cleanUrl: `https://${sshMatch[1]}/${sshMatch[2]}`, embeddedToken: null, host: sshMatch[1], path: sshMatch[2], isSSH }
  }

  const tokenMatch = url.match(/^https?:\/\/([^@]+)@(.+)$/)
  if (tokenMatch) {
    embeddedToken = tokenMatch[1]
    cleanUrl = url.replace(/^(https?:\/\/)[^@]+@/, '$1')
  }

  cleanUrl = cleanUrl.replace(/\.git$/, '')

  try {
    const urlObj = new URL(cleanUrl)
    return { cleanUrl, embeddedToken, host: urlObj.host, path: urlObj.pathname.replace(/^\/+/, ''), isSSH }
  } catch {
    const parts = cleanUrl.replace(/^https?:\/\//, '').split('/')
    return { cleanUrl, embeddedToken, host: parts[0] || '', path: parts.slice(1).join('/'), isSSH }
  }
}

/** Build an authenticated URL: https://{token}@{host}/{path} */
function buildAuthUrl(repoUrl: string, token: string): string {
  const { host, path: repoPath } = parseRemoteUrl(repoUrl)
  if (!host || !host.includes('.')) {
    throw new Error(`URL repository không hợp lệ: host "${host}" không phải là domain hợp lệ. Vui lòng nhập URL dạng https://github.com/user/repo`)
  }
  return token ? `https://${token}@${host}/${repoPath}` : `https://${host}/${repoPath}`
}

/** Strip token from a URL for safe display */
function stripTokenFromUrl(url: string): string {
  return url.replace(/^(https?:\/\/)[^@]+@/, '$1')
}

/** Check if a file path falls within protected directories */
function isProtectedFile(file: string): boolean {
  for (const dir of PROTECTED_DIRS) {
    if (file.startsWith(dir) || file === dir.slice(0, -1)) return true
  }
  return false
}

/** Check if a file should be smart-merged instead of force-overwritten */
function isSmartMergeFile(file: string): boolean {
  return SMART_MERGE_FILES.includes(file)
}

/** FIX 2026-09-15 (Task 25): file artifact cục bộ — giữ nguyên qua mọi pull */
function isLocalPreservedFile(file: string): boolean {
  return LOCAL_PRESERVE_EXACT.includes(file) || LOCAL_PRESERVE_PREFIX.some((p) => file.startsWith(p))
}

/** Sanitize branch name to prevent command injection */
function sanitizeBranch(branch: string): string {
  const sanitized = branch.replace(/[^a-zA-Z0-9\-_\/\.]/g, '')
  if (sanitized !== branch) {
    console.log(`[GitPull] Branch name sanitized: "${branch}" → "${sanitized}"`)
  }
  return sanitized || 'main'
}

/**
 * Smart-merge .env files: keep local values for existing keys,
 * but add new keys from the remote version.
 */
function mergeEnvFile(localContent: string, remoteContent: string): string {
  const localLines = localContent.split('\n')
  const remoteLines = remoteContent.split('\n')

  const localMap = new Map<string, string>()
  for (const line of localLines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eqIndex = trimmed.indexOf('=')
    if (eqIndex > 0) {
      const key = trimmed.substring(0, eqIndex).trim()
      const value = trimmed.substring(eqIndex + 1).trim()
      localMap.set(key, value)
    }
  }

  const remoteMap = new Map<string, { key: string; value: string; line: string }>()
  for (const line of remoteLines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eqIndex = trimmed.indexOf('=')
    if (eqIndex > 0) {
      const key = trimmed.substring(0, eqIndex).trim()
      const value = trimmed.substring(eqIndex + 1).trim()
      remoteMap.set(key, { key, value, line })
    }
  }

  const newKeys: string[] = []
  for (const [, entry] of remoteMap) {
    if (!localMap.has(entry.key)) {
      newKeys.push(entry.line)
    }
  }

  if (newKeys.length === 0) return localContent

  const merged = localContent.trimEnd() + '\n\n# === New keys from remote (auto-merged) ===\n' + newKeys.join('\n') + '\n'
  console.log(`[GitPull] .env merged: added ${newKeys.length} new key(s) from remote, preserved all local values`)
  return merged
}

/**
 * Backup config files before pull so they can be smart-merged after.
 * Returns a map of filename → local content.
 */
function backupConfigFiles(projectRoot: string): Map<string, string | null> {
  const backups = new Map<string, string | null>()
  for (const file of SMART_MERGE_FILES) {
    const filePath = join(projectRoot, file)
    try {
      const content = readFileSync(filePath, 'utf-8')
      backups.set(file, content)
      console.log(`[GitPull] Backed up ${file} (${content.length} bytes)`)
    } catch {
      backups.set(file, null)
    }
  }
  return backups
}

/**
 * Smart-restore config files after pull: merge new keys from remote
 * while preserving local values for existing keys.
 */
function smartRestoreConfigFiles(projectRoot: string, backups: Map<string, string | null>): void {
  for (const [file, localContent] of backups.entries()) {
    if (localContent === null) continue
    const filePath = join(projectRoot, file)
    try {
      const remoteContent = readFileSync(filePath, 'utf-8')
      if (remoteContent !== localContent) {
        const merged = mergeEnvFile(localContent, remoteContent)
        writeFileSync(filePath, merged, 'utf-8')
        console.log(`[GitPull] Smart-merged ${file} — local values preserved, new remote keys added`)
      }
    } catch {
      writeFileSync(filePath, localContent, 'utf-8')
      console.log(`[GitPull] Restored ${file} — file was removed by pull`)
    }
  }
}

/**
 * Nhánh mặc định của remote (git ls-remote --symref HEAD) — dùng khi client
 * KHÔNG chỉ định branch tường minh. Fail-open: trả '' → caller fallback 'main'.
 * FIX 2026-09-13 (user report: "pull nhánh master trong khi phải pull nhánh main
 * thì mới pull được") — thay vì hardcode 'main', hỏi remote thật để repo nào
 * (main/master khác) cũng hoạt động đúng.
 */
async function detectRemoteDefaultBranch(authUrl: string, cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['ls-remote', '--symref', authUrl, 'HEAD'], {
      cwd,
      timeout: 30_000,
    })
    const m = String(stdout).match(/ref:\s*refs\/heads\/(\S+)/)
    return m ? m[1] : ''
  } catch {
    return '' // fail-open — mạng/token lỗi không chặn pull
  }
}

/**
 * Ensure the project directory is a valid git repository.
 * If not, auto-initialize git, add protected dirs to .gitignore,
 * and create an initial commit so we have a HEAD to diff against.
 */
async function ensureGitRepo(
  projectRoot: string
): Promise<{ isNewRepo: boolean; hadNoCommits: boolean }> {
  let isGitRepo = false
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: projectRoot })
    isGitRepo = stdout.trim() === 'true'
  } catch {
    isGitRepo = false
  }

  let isNewRepo = false
  let hadNoCommits = false

  if (!isGitRepo) {
    console.log('[GitPull] Directory is not a git repo — initializing...')
    // FIX 2026-09-13: init -b main (khớp nhánh mặc định GitHub) — git init không
    // -b mặc định tạo 'master', khiến pull/push lệch nhánh với remote 'main'.
    // Git < 2.28 không hỗ trợ -b → fallback git init + symbolic-ref.
    try {
      await execFileAsync('git', ['init', '-b', 'main'], { cwd: projectRoot })
    } catch {
      await execFileAsync('git', ['init'], { cwd: projectRoot })
      await execFileAsync('git', ['symbolic-ref', 'HEAD', 'refs/heads/main'], { cwd: projectRoot, timeout: 10_000 }).catch(() => {})
    }
    isNewRepo = true

    const gitignorePath = join(projectRoot, '.gitignore')
    let gitignoreContent = ''
    try {
      gitignoreContent = readFileSync(gitignorePath, 'utf-8')
    } catch {
      gitignoreContent = ''
    }

    const dirsToAdd = PROTECTED_DIRS.filter(
      (dir) => !gitignoreContent.split('\n').some((line) => line.trim() === dir || line.trim() === '/' + dir)
    )
    if (dirsToAdd.length > 0) {
      const appendBlock = '\n# Protected directories (auto-added by git-pull)\n' + dirsToAdd.join('\n') + '\n'
      appendFileSync(gitignorePath, appendBlock, 'utf-8')
      console.log(`[GitPull] Added to .gitignore: ${dirsToAdd.join(', ')}`)
    }
  }

  let hasCommits = false
  try {
    await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: projectRoot })
    hasCommits = true
  } catch {
    hasCommits = false
  }

  if (!hasCommits) {
    hadNoCommits = true
    console.log('[GitPull] No commits yet — creating initial commit from current files...')

    try {
      await execFileAsync('git', ['add', '-A'], { cwd: projectRoot, timeout: 30000 })
    } catch { /* May fail if no files */ }

    try {
      const { stdout: statusOutput } = await execFileAsync('git', ['status', '--porcelain'], { cwd: projectRoot, timeout: 10000 })
      if (statusOutput.trim()) {
        await execFileAsync('git', ['commit', '-m', 'Initial commit (auto-created before first pull)'], {
          cwd: projectRoot, timeout: 30000,
        })
      } else {
        await execFileAsync('git', ['commit', '--allow-empty', '-m', 'Initial empty commit'], {
          cwd: projectRoot, timeout: 15000,
        })
      }
    } catch {
      try {
        await execFileAsync('git', ['commit', '--allow-empty', '-m', 'Initial empty commit'], {
          cwd: projectRoot, timeout: 15000,
        })
      } catch { /* Last resort */ }
    }
  }

  return { isNewRepo, hadNoCommits }
}

// ─── GET ────────────────────────────────────────────────────────────────────────

export async function GET() {
  try {
    const projectRoot = process.cwd()

    let isGitRepo = false
    try {
      const { stdout } = await execFileAsync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: projectRoot })
      isGitRepo = stdout.trim() === 'true'
    } catch {
      isGitRepo = false
    }

    if (!isGitRepo) {
      // Không phải git repo — vẫn trả default repo URL + saved token để dialog điền sẵn
      const tokenInfo = getSavedGithubTokenInfo()
      return NextResponse.json({
        currentRemote: null,
        currentBranch: null,
        currentCommit: null,
        repoUrl: DEFAULT_REPO_URL,
        defaultRepoUrl: DEFAULT_REPO_URL,
        hasToken: false,
        isGitRepo: false,
        ...tokenInfo,
      })
    }

    let currentRemote = ''
    try {
      const { stdout } = await execFileAsync('git', ['remote', 'get-url', 'origin'], { cwd: projectRoot })
      currentRemote = stdout.trim()
    } catch { /* No remote */ }

    let currentBranch = ''
    try {
      const { stdout } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: projectRoot })
      currentBranch = stdout.trim()
    } catch { /* Not a git repo */ }

    let currentCommit = ''
    try {
      const { stdout } = await execFileAsync('git', ['rev-parse', '--short', 'HEAD'], { cwd: projectRoot })
      currentCommit = stdout.trim()
    } catch { /* Not a git repo */ }

    const parsed = currentRemote ? parseRemoteUrl(currentRemote) : null

    // SECURITY: Auto-clean token from .git/config
    if (parsed?.embeddedToken && parsed.cleanUrl) {
      console.log('[GitPull GET] Token found in remote URL — cleaning .git/config')
      try {
        await execFileAsync('git', ['remote', 'set-url', 'origin', parsed.cleanUrl], { cwd: projectRoot })
        console.log(`[GitPull GET] Cleaned remote URL: ${parsed.cleanUrl}`)
      } catch {
        console.error('[GitPull GET] Failed to clean remote URL')
      }
    }

    // SECURITY: Never send raw token to client — saved token (user nhập qua dialog)
    // được trả RAW để pre-fill theo yêu cầu user 2026-08-29; token embedded trong
    // remote URL thì vẫn KHÔNG bao giờ trả raw (chỉ hasToken flag).
    const tokenInfo = getSavedGithubTokenInfo()

    return NextResponse.json({
      currentRemote: parsed ? parsed.cleanUrl : (currentRemote || null),
      currentBranch: currentBranch || null,
      currentCommit: currentCommit || null,
      repoUrl: parsed ? parsed.cleanUrl : null,
      defaultRepoUrl: (parsed ? parsed.cleanUrl : null) || DEFAULT_REPO_URL,
      hasToken: parsed ? !!parsed.embeddedToken : false,
      isGitRepo: true,
      ...tokenInfo,
    })
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err)
    console.error('[GitPull GET] Error:', errorMsg)
    return NextResponse.json({ success: false, error: errorMsg }, { status: 500 })
  }
}

// ─── POST ───────────────────────────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  // Mutex check
  if (pullInProgress) {
    return NextResponse.json(
      { success: false, error: 'Đang có thao tác Pull code khác đang thực hiện. Vui lòng đợi hoàn tất rồi thử lại.' },
      { status: 429 }
    )
  }
  pullInProgress = true

  try {
    const projectRoot = process.cwd()
    const body = await request.json()

    const {
      repoUrl: bodyRepoUrl,
      apiToken: bodyApiToken,
      branch: bodyBranch, // FIX 2026-09-13: KHÔNG hardcode default 'main' — auto-detect nhánh mặc định remote khi client không gửi
      dryRun = false,
      forgetToken = false,
    }: {
      repoUrl?: string
      apiToken?: string
      branch?: string
      dryRun?: boolean
      forgetToken?: boolean
    } = body

    // ── Token management (user request 2026-08-29) ──
    // forgetToken=true → xóa token đã lưu, KHÔNG pull (dùng cho nút "Xóa token")
    if (forgetToken) {
      const cleared = clearSavedGithubToken()
      return NextResponse.json({
        success: true,
        forgotToken: true,
        message: cleared ? 'Đã xóa token đã lưu' : 'Không có token nào được lưu',
      })
    }

    const explicitBranch = sanitizeBranch(bodyBranch || '') // FIX 2026-09-13: '' khi client không gửi → auto-detect nhánh mặc định remote (sau khi có authUrl)
    const effectiveToken = bodyApiToken ? sanitizeToken(bodyApiToken) : ''

    // Auto-save token: nhập token mới → lưu lại (ghi đè token cũ nếu khác),
    // để lần sau dialog tự điền sẵn. Không lưu khi dry-run? Vẫn lưu — user
    // "Kiểm tra trước" với token là ý định dùng token đó.
    if (effectiveToken) {
      const savedBefore = getSavedGithubTokenInfo()
      if (savedBefore.savedToken !== effectiveToken) {
        try {
          const { preview } = saveGithubToken(effectiveToken)
          console.log(`[GitPull] Auto-saved GitHub token (${preview}) — sẽ điền sẵn lần sau`)
        } catch (saveErr) {
          console.warn('[GitPull] Failed to auto-save token:', saveErr instanceof Error ? saveErr.message : String(saveErr))
        }
      }
    }

    // ── Resolve current remote config ──
    let currentRemote = ''
    try {
      const { stdout } = await execFileAsync('git', ['remote', 'get-url', 'origin'], { cwd: projectRoot })
      currentRemote = stdout.trim()
    } catch { /* No remote */ }

    const parsedCurrent = currentRemote ? parseRemoteUrl(currentRemote) : null

    // ── Determine effective repoUrl ──
    let effectiveRepoUrl = bodyRepoUrl?.trim() || (parsedCurrent?.cleanUrl ?? '')
    if (!effectiveRepoUrl) {
      return NextResponse.json(
        { success: false, error: 'Chưa cung cấp địa chỉ kho lưu trữ (Repo URL). Vui lòng nhập URL của repository GitHub.' },
        { status: 400 }
      )
    }

    if (!effectiveRepoUrl.match(/^https?:\/\//)) {
      effectiveRepoUrl = 'https://' + effectiveRepoUrl
    }

    const parsedRepo = parseRemoteUrl(effectiveRepoUrl)
    if (parsedRepo.isSSH) {
      effectiveRepoUrl = parsedRepo.cleanUrl
      console.log(`[GitPull] Converted SSH URL to HTTPS: ${effectiveRepoUrl}`)
    }

    // Token resolution precedence: token user nhập > token embedded trong URL
    // input > token embedded trong remote hiện tại > TOKEN ĐÃ LƯU (tự điền sẵn)
    let finalToken = effectiveToken || parsedRepo.embeddedToken || (parsedCurrent?.embeddedToken ?? '') || getSavedGithubToken() || ''
    if (!effectiveToken && !parsedRepo.embeddedToken && !parsedCurrent?.embeddedToken && finalToken) {
      console.log('[GitPull] No token in request — using SAVED token from db/.github-token.json')
    }
    if (parsedRepo.embeddedToken) {
      effectiveRepoUrl = parsedRepo.cleanUrl
    }

    // ── Validate repo URL ──
    const parsedEffective = parseRemoteUrl(effectiveRepoUrl)
    if (!parsedEffective.host || !parsedEffective.host.includes('.')) {
      return NextResponse.json(
        { success: false, error: `Địa chỉ repository không hợp lệ: "${effectiveRepoUrl}". Vui lòng nhập URL đúng định dạng, ví dụ: https://github.com/user/repo` },
        { status: 400 }
      )
    }

    // ── Build authenticated URL ──
    let authUrl: string
    try {
      authUrl = finalToken ? buildAuthUrl(effectiveRepoUrl, finalToken) : effectiveRepoUrl
    } catch (urlErr) {
      return NextResponse.json(
        { success: false, error: urlErr instanceof Error ? urlErr.message : String(urlErr) },
        { status: 400 }
      )
    }

    try {
      const validatedUrl = new URL(authUrl)
      if (!validatedUrl.host.includes('.')) throw new Error(`Host không hợp lệ: ${validatedUrl.host}`)
    } catch {
      return NextResponse.json(
        { success: false, error: `URL không hợp lệ sau khi xây dựng: ${stripTokenFromUrl(authUrl)}. Vui lòng kiểm tra lại Repo URL và API Token.` },
        { status: 400 }
      )
    }

    // ── SMART BRANCH (fix 2026-09-13) ──
    // Client KHÔNG gửi branch → dùng nhánh MẶC ĐỊNH CỦA REMOTE (ls-remote
    // --symref HEAD) thay vì hardcode — repo mặc định 'main' hay 'master' gì
    // cũng pull đúng nhánh. Fail-open: ls-remote lỗi → 'main'.
    let branch = explicitBranch
    let branchAutoDetected = false
    if (!branch) {
      branch = sanitizeBranch((await detectRemoteDefaultBranch(authUrl, projectRoot)) || 'main')
      branchAutoDetected = true
      console.log(`[GitPull] Client không chỉ định branch — auto-detect nhánh mặc định remote: ${branch}`)
    }

    console.log(`[GitPull] Using remote: ${stripTokenFromUrl(authUrl)} token: ${finalToken ? maskToken(finalToken) : '(none)'} branch: ${branch}${branchAutoDetected ? ' (auto-detected)' : ''}`)

    // ── Ensure git repo ──
    const { isNewRepo, hadNoCommits } = await ensureGitRepo(projectRoot)

    // ── Set remote origin to CLEAN URL ──
    try {
      await execFileAsync('git', ['remote', 'set-url', 'origin', effectiveRepoUrl], { cwd: projectRoot })
      console.log(`[GitPull] Updated remote origin to ${effectiveRepoUrl} (no token stored)`)
    } catch {
      try {
        await execFileAsync('git', ['remote', 'add', 'origin', effectiveRepoUrl], { cwd: projectRoot })
      } catch { /* ignore */ }
    }

    // ── Backup config files for smart-merge ──
    const configBackups = backupConfigFiles(projectRoot)

    // ── Get current commit ──
    let beforeCommit = ''
    try {
      const { stdout } = await execFileAsync('git', ['rev-parse', '--short', 'HEAD'], { cwd: projectRoot })
      beforeCommit = stdout.trim()
    } catch { /* fresh repo */ }

    // ── Fetch from remote ──
    try {
      console.log(`[GitPull] Fetching from ${stripTokenFromUrl(authUrl)} branch=${branch}`)
      await execFileAsync('git', ['fetch', authUrl, branch, '--force'], {
        cwd: projectRoot,
        timeout: 120000,
      })
    } catch (fetchErr) {
      const fetchMsg = fetchErr instanceof Error ? fetchErr.message : String(fetchErr)
      const safeMsg = maskTokenInString(fetchMsg, finalToken)
      console.error(`[GitPull] Fetch failed: ${safeMsg}`)

      let userError = `Không thể fetch từ repository. ${safeMsg}`
      if (fetchMsg.includes('not a git repository')) {
        userError = 'Thư mục hiện tại không phải là Git repository. Vui lòng đảm bảo project được clone bằng git hoặc thử lại (hệ thống đã tự khởi tạo git).'
      } else if (fetchMsg.includes("couldn't find remote ref") || fetchMsg.includes('not a valid ref')) {
        // FIX 2026-09-13: pull sai tên nhánh (vd 'master' trong khi repo mặc định 'main')
        userError = `Không tìm thấy nhánh "${branch}" trên remote — kiểm tra tên nhánh (nhánh mặc định của repo có thể là "main" hoặc "master"), rồi thử lại.`
      } else if (fetchMsg.includes('Authentication failed') || fetchMsg.includes('could not read Username') || fetchMsg.includes('could not read Password')) {
        userError = 'Xác thực thất bại. Vui lòng kiểm tra lại API Token (GitHub PAT) và đảm bảo token có quyền truy cập repository.'
      } else if (fetchMsg.includes('Repository not found') || fetchMsg.includes('not found')) {
        userError = `Không tìm thấy repository. Vui lòng kiểm tra lại địa chỉ: ${stripTokenFromUrl(effectiveRepoUrl)}`
      } else if (fetchMsg.includes('timed out') || fetchMsg.includes('timeout')) {
        userError = 'Kết nối tới GitHub bị timeout. Vui lòng kiểm tra mạng và thử lại.'
      } else if (fetchMsg.includes('could not resolve host') || fetchMsg.includes('Could not resolve')) {
        userError = `Không thể kết nối đến server. Vui lòng kiểm tra lại địa chỉ repository: ${stripTokenFromUrl(effectiveRepoUrl)}. Đảm bảo URL đúng định dạng.`
      }

      return NextResponse.json({ success: false, error: userError }, { status: 500 })
    }

    // ── List files that differ between HEAD and FETCH_HEAD ──
    let changedFiles: string[] = []
    try {
      // FIX 2026-09-15 (Task 25): core.quotepath=false — đường dẫn chứa ký tự
      // không ASCII (vd tên file tiếng Trung trong skills/design) mặc định bị
      // git escape thành "\357\274\210..." → checkout nhận chuỗi escape THẬT →
      // fail 23 file. Tắt quotepath để đường dẫn ra UTF-8 thô, checkout đúng.
      const { stdout: diffOutput } = await execFileAsync('git', ['-c', 'core.quotepath=false', 'diff', '--name-only', 'HEAD..FETCH_HEAD'], { cwd: projectRoot })
      changedFiles = diffOutput.split('\n').map((f) => f.trim()).filter(Boolean)
    } catch {
      // diff may fail if no common ancestor — try alternative
      try {
        const { stdout: listOutput } = await execFileAsync('git', ['-c', 'core.quotepath=false', 'diff-tree', '--no-commit-id', '--name-only', '-r', 'FETCH_HEAD'], { cwd: projectRoot })
        changedFiles = listOutput.split('\n').map((f) => f.trim()).filter(Boolean)
      } catch {
        console.log('[GitPull] Cannot preview changes — will proceed with checkout')
      }
    }

    // ── Also check for files that exist in FETCH_HEAD but not in changed list (new files) ──
    // git diff --name-only HEAD..FETCH_HEAD only shows changes, not new files from unrelated histories
    // For full coverage, also list all files in FETCH_HEAD if this is a fresh repo
    if (hadNoCommits || isNewRepo) {
      try {
        const { stdout: allFilesOutput } = await execFileAsync('git', ['-c', 'core.quotepath=false', 'ls-tree', '-r', '--name-only', 'FETCH_HEAD'], { cwd: projectRoot })
        const allRemoteFiles = allFilesOutput.split('\n').map((f) => f.trim()).filter(Boolean)
        // Merge with changedFiles (deduplicate)
        const existingSet = new Set(changedFiles)
        for (const f of allRemoteFiles) {
          if (!existingSet.has(f)) changedFiles.push(f)
        }
      } catch {
        console.log('[GitPull] Could not list all remote files — continuing with diff list')
      }
    }

    // ── Separate files into categories ──
    const protectedFiles = changedFiles.filter(f => isProtectedFile(f))
    const localPreservedFiles = changedFiles.filter(f => isLocalPreservedFile(f))
    const smartMergeFiles = changedFiles.filter(f => isSmartMergeFile(f) && !isProtectedFile(f) && !isLocalPreservedFile(f))
    const forceOverwriteFiles = changedFiles.filter(f => !isProtectedFile(f) && !isLocalPreservedFile(f) && !isSmartMergeFile(f))

    // ── FIX 2026-09-15 (Task 25): protected dirs → SKIP từng file, KHÔNG chặn cả pull ──
    // Hành vi cũ: bất kỳ file bảo vệ nào xuất hiện trong diff HEAD..FETCH_HEAD → 403
    // chặn TOÀN BỘ pull. Nhưng repo platform chủ động track db//upload/ (reset-
    // survival kép) trong khi remote KHÔNG có → diff luôn liệt kê 25 file bảo vệ →
    // chức năng Pull code không bao giờ pull được (user report 2026-09-15).
    // Hành vi mới: file bảo vệ bị BỎ QUA (không ghi đè, không xóa — đúng thiết kế
    // gốc "Protected dirs are NEVER touched"), pull tiếp tục với phần code, và
    // response báo rõ danh sách đã bỏ qua. Local artifacts (worklog/tool-results/
    // bin/dev.log) cũng được giữ nguyên thay vì bị `git rm` như luồng cũ.
    if (protectedFiles.length > 0) {
      console.warn(`[GitPull] Skipping ${protectedFiles.length} protected files (kept intact, never touched): ${protectedFiles.join(', ')}`)
    }
    if (localPreservedFiles.length > 0) {
      console.log(`[GitPull] Preserving ${localPreservedFiles.length} local-only artifacts: ${localPreservedFiles.join(', ')}`)
    }

    // ── Dry-run mode ──
    if (dryRun) {
      const effectiveFiles = [...forceOverwriteFiles, ...smartMergeFiles]
      const depsChanged = effectiveFiles.some(f => f === 'package.json' || f === 'bun.lock' || f === 'bun.lockb')
      return NextResponse.json({
        success: true,
        dryRun: true,
        changedFiles: effectiveFiles,
        beforeCommit,
        branch,
        repoUrl: stripTokenFromUrl(effectiveRepoUrl),
        isNewRepo,
        schemaChanged: effectiveFiles.some(f => f === 'prisma/schema.prisma' || f.startsWith('prisma/')),
        depsChanged,
        forceOverwriteCount: forceOverwriteFiles.length,
        smartMergeCount: smartMergeFiles.length,
        protectedCount: protectedFiles.length,
        protectedFiles,
        preservedLocalCount: localPreservedFiles.length,
        preservedLocalFiles: localPreservedFiles,
        message:
          effectiveFiles.length > 0
            ? `${effectiveFiles.length} file sẽ cập nhật (${forceOverwriteFiles.length} ghi đè, ${smartMergeFiles.length} smart-merge) · ${protectedFiles.length} file bảo vệ + ${localPreservedFiles.length} artifact cục bộ sẽ được GIỮ NGUYÊN`
            : `Đã là phiên bản mới nhất — không có thay đổi${protectedFiles.length > 0 ? ` (${protectedFiles.length} file bảo vệ được giữ nguyên)` : ''}`,
      })
    }

    // ── No changes — skip pull (FIX Task 25: đếm theo file THỰC TẾ sẽ được áp,
    // không tính file bảo vệ/artifact bị bỏ qua — trước đây diff chứa 25 file
    // protected khiến nhánh này không bao giờ chạy) ──
    if (forceOverwriteFiles.length + smartMergeFiles.length === 0 && !hadNoCommits) {
      return NextResponse.json({
        success: true,
        hasChanges: false,
        isUpToDate: true,
        beforeCommit,
        afterCommit: beforeCommit,
        changedFiles: [],
        isNewRepo,
        protectedCount: protectedFiles.length,
        preservedLocalCount: localPreservedFiles.length,
        message: protectedFiles.length + localPreservedFiles.length > 0
          ? `Đã là phiên bản mới nhất · ${protectedFiles.length} file bảo vệ + ${localPreservedFiles.length} artifact cục bộ được giữ nguyên`
          : 'Đã là phiên bản mới nhất',
      })
    }

    // ═══════════════════════════════════════════════════════════════════════
    // ── AGGRESSIVE CHECKOUT STRATEGY ──────────────────────────────────────
    //
    // Instead of "git merge" (which fails on untracked files, conflicts, etc.),
    // we force-checkout each file individually from FETCH_HEAD.
    // This guarantees:
    //   ✅ No "would be overwritten" errors
    //   ✅ No merge conflicts (remote version always wins)
    //   ✅ Protected directories are never touched
    //   ✅ .env is smart-merged after checkout
    // ═══════════════════════════════════════════════════════════════════════

    console.log(`[GitPull] Aggressive checkout: ${forceOverwriteFiles.length} files to force-overwrite, ${smartMergeFiles.length} to smart-merge`)

    let checkoutSuccess = 0
    let checkoutFailed = 0
    const failedFiles: string[] = []

    // Force-checkout each non-protected, non-smart-merge file from FETCH_HEAD
    for (const file of forceOverwriteFiles) {
      try {
        await execFileAsync('git', ['checkout', 'FETCH_HEAD', '--', file], {
          cwd: projectRoot,
          timeout: 30000,
        })
        checkoutSuccess++
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        // If checkout fails (file might have been deleted in remote), try removing it locally
        try {
          await execFileAsync('git', ['rm', '--force', file], { cwd: projectRoot, timeout: 10000 })
          checkoutSuccess++
          console.log(`[GitPull] Removed deleted file: ${file}`)
        } catch {
          checkoutFailed++
          failedFiles.push(file)
          console.error(`[GitPull] Failed to checkout ${file}: ${errMsg}`)
        }
      }
    }

    // Also checkout smart-merge files from FETCH_HEAD (will be merged after)
    for (const file of smartMergeFiles) {
      try {
        await execFileAsync('git', ['checkout', 'FETCH_HEAD', '--', file], {
          cwd: projectRoot,
          timeout: 30000,
        })
        checkoutSuccess++
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        try {
          await execFileAsync('git', ['rm', '--force', file], { cwd: projectRoot, timeout: 10000 })
          checkoutSuccess++
        } catch {
          checkoutFailed++
          failedFiles.push(file)
          console.error(`[GitPull] Failed to checkout ${file}: ${errMsg}`)
        }
      }
    }

    // ── Update git index: stage all checked-out files and update HEAD ──
    try {
      await execFileAsync('git', ['add', '-A'], { cwd: projectRoot, timeout: 30000 })
    } catch { /* May fail if nothing to add */ }

    // Commit the checkout result so HEAD points to the right state
    // We use the FETCH_HEAD commit as the new HEAD (fast-forward if possible)
    let afterCommit = ''
    let pullOutput = ''

    // Try fast-forward first (if no divergence)
    try {
      await execFileAsync('git', ['reset', '--soft', 'FETCH_HEAD'], { cwd: projectRoot, timeout: 30000 })
      const { stdout } = await execFileAsync('git', ['rev-parse', '--short', 'HEAD'], { cwd: projectRoot })
      afterCommit = stdout.trim()
      pullOutput = `Updated to remote version (fast-forward)`
      console.log(`[GitPull] Fast-forwarded to FETCH_HEAD: ${afterCommit}`)
    } catch {
      // If fast-forward fails, just commit what we have
      try {
        // Reset index to match FETCH_HEAD but keep working tree
        await execFileAsync('git', ['read-tree', '-u', '-m', 'FETCH_HEAD'], { cwd: projectRoot, timeout: 60000 })
        await execFileAsync('git', ['reset', 'HEAD'], { cwd: projectRoot, timeout: 10000 }) // unstage
        await execFileAsync('git', ['add', '-A'], { cwd: projectRoot, timeout: 30000 })

        const { stdout: statusOut } = await execFileAsync('git', ['status', '--porcelain'], { cwd: projectRoot, timeout: 10000 })
        if (statusOut.trim()) {
          await execFileAsync('git', ['commit', '-m', `Pull code từ ${stripTokenFromUrl(effectiveRepoUrl)}`], {
            cwd: projectRoot, timeout: 30000,
          })
        }

        const { stdout } = await execFileAsync('git', ['rev-parse', '--short', 'HEAD'], { cwd: projectRoot })
        afterCommit = stdout.trim()
        pullOutput = `Checkout ${checkoutSuccess} files from remote`
      } catch (commitErr) {
        console.error(`[GitPull] Commit after checkout failed: ${commitErr instanceof Error ? commitErr.message : String(commitErr)}`)
        // Still continue — files are updated in working tree even if commit failed
        try {
          const { stdout } = await execFileAsync('git', ['rev-parse', '--short', 'HEAD'], { cwd: projectRoot })
          afterCommit = stdout.trim()
        } catch { /* ignore */ }
        pullOutput = `Checkout ${checkoutSuccess} files (commit pending)`
      }
    }

    // ── Smart-restore .env: local values preserved, new keys added ──
    smartRestoreConfigFiles(projectRoot, configBackups)

    // ── Re-compute changed files after pull ──
    try {
      if (beforeCommit && afterCommit && beforeCommit !== afterCommit) {
        const { stdout: diffOutput } = await execFileAsync('git', ['-c', 'core.quotepath=false', 'diff', '--name-only', `${beforeCommit}..${afterCommit}`], { cwd: projectRoot })
        const postPullFiles = diffOutput.split('\n').map((f) => f.trim()).filter(Boolean)
        if (postPullFiles.length > 0) changedFiles = postPullFiles
      }
    } catch { /* fall back to pre-pull list */ }

    // ── Post-pull automation ──

    // Run bun install if deps changed
    let installResult: string | null = null
    const depsChanged = changedFiles.some(f => f === 'package.json' || f === 'bun.lock' || f === 'bun.lockb')

    if (depsChanged) {
      console.log('[GitPull] Dependencies changed — running bun install')
      try {
        const { stdout: installOutput } = await execFileAsync('bun', ['install'], { cwd: projectRoot, timeout: 120000 })
        installResult = 'bun install completed successfully'
        console.log(`[GitPull] bun install done: ${installOutput.substring(0, 200)}`)
      } catch (installErr) {
        const installMsg = installErr instanceof Error ? installErr.message : String(installErr)
        console.error(`[GitPull] bun install failed: ${installMsg}`)
        installResult = `bun install failed: ${installMsg}`
      }
    }

    // Run prisma generate + db push if schema changed
    let prismaResult: string | null = null
    const schemaChanged = changedFiles.some(f => f === 'prisma/schema.prisma' || f.startsWith('prisma/'))

    if (schemaChanged) {
      console.log('[GitPull] Prisma schema changed — running generate and db push')
      try {
        await execFileAsync('bunx', ['prisma', 'generate'], { cwd: projectRoot, timeout: 120000 })
        console.log('[GitPull] prisma generate done')
        await execFileAsync('bunx', ['prisma', 'db', 'push'], { cwd: projectRoot, timeout: 120000 })
        console.log('[GitPull] prisma db push done')
        prismaResult = 'prisma generate + db push completed successfully'
      } catch (prismaErr) {
        const prismaMsg = prismaErr instanceof Error ? prismaErr.message : String(prismaErr)
        console.error(`[GitPull] Prisma automation failed: ${prismaMsg}`)
        prismaResult = `Prisma automation failed: ${prismaMsg}`
      }
    }

    // ── Build and return result ──
    const hasChanges = beforeCommit !== afterCommit || checkoutSuccess > 0
    const output = pullOutput || 'OK'

    return NextResponse.json({
      success: true,
      beforeCommit,
      afterCommit,
      hasChanges,
      changedFiles,
      schemaChanged,
      depsChanged,
      installResult,
      prismaResult,
      output,
      branch,
      repoUrl: stripTokenFromUrl(effectiveRepoUrl),
      isNewRepo,
      checkoutStats: {
        success: checkoutSuccess,
        failed: checkoutFailed,
        failedFiles,
      },
      skipped: {
        protectedCount: protectedFiles.length,
        protectedFiles,
        preservedLocalCount: localPreservedFiles.length,
        preservedLocalFiles: localPreservedFiles,
      },
    })
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err)
    console.error('[GitPull POST] Error:', errorMsg)

    // Try to clean up git state
    try {
      await execFileAsync('git', ['merge', '--abort'], { cwd: process.cwd(), timeout: 10000 })
    } catch { /* ignore */ }

    return NextResponse.json(
      { success: false, error: `Lỗi hệ thống: ${errorMsg}` },
      { status: 500 }
    )
  } finally {
    // Always release the mutex
    pullInProgress = false
  }
}
