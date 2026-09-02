/**
 * RESEARCH TEAM — PROPOSAL GIT BRANCH (TB-11 §3 — 1 Proposal = 1 branch + DR-C3 Q3 versioning)
 * =====================================================================================
 * Spec:
 *  - TB-11 §3 — Lifecycle: DRAFT → SUBMITTED (tạo branch) → APPROVED → APPLIED (merge).
 *      Quy tắc vàng TB-01 §3: KHÔNG sửa Live ngoài Workspace. Mọi thay đổi thực hiện
 *      trong `workspace/research/<missionId>/` (TC-10 — Live read-only).
 *  - DR-C3 Q3 — Versioning: commit author + timestamp + part ref; diff base..head artifact.
 *  - TB-13 §7 — Workspace git flow: tạo branch trong workspace dir, commit changes, diff
 *      so với base (main | master), merge khi APPROVED.
 *
 * Fail-open policy (TB-13 §1 nguyên tắc 7 — không require git binary):
 *  - Nếu `git --version` fail → tất cả function fail-open (created=false, error logged).
 *    Code vẫn compile + run (sandbox có thể không có git binary).
 *  - KHÔNG bao giờ chạy git ngoài `workspace/research/<missionId>/` dir.
 *
 * Bridge target: P5 proposal/store.ts gọi createBranch(submit) + mergeBranch(apply).
 */

import { exec } from 'child_process'
import { promisify } from 'util'
import { mkdir } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'

const execAsync = promisify(exec)

// ============================================================
// §1. TYPES + CONSTANTS
// ============================================================

export interface GitResult {
  success: boolean
  error?: string
  stdout?: string
  stderr?: string
}

export interface BranchResult {
  branchName: string
  created: boolean
  error?: string
}

export interface CommitResult {
  committed: boolean
  sha?: string
  error?: string
}

export interface DiffResult {
  summary: string
  filesChanged: string[]
  error?: string
}

export interface MergeResult {
  merged: boolean
  sha?: string
  error?: string
}

export interface DeleteBranchResult {
  deleted: boolean
  error?: string
}

/** Default target branch khi merge — 'main' (fallback 'master' nếu main không tồn tại). */
export const DEFAULT_MERGE_TARGET = 'main'
export const FALLBACK_MERGE_TARGET = 'master'

/** Default workspace root — relative to process.cwd() (caller có thể override). */
export function defaultWorkspaceRoot(missionId: string): string {
  return join(process.cwd(), 'workspace', 'research', missionId)
}

// ============================================================
// §2. GIT AVAILABILITY CHECK — fail-open nếu git không có
// ============================================================

let gitAvailabilityChecked = false
let gitAvailable: boolean | null = null

/**
 * Check git binary available — fail-open (TB-13 §1 nguyên tắc 7).
 * Cache kết quả sau lần check đầu để tránh lặp subprocess.
 */
export async function isGitAvailable(): Promise<boolean> {
  if (gitAvailabilityChecked && gitAvailable !== null) {
    return gitAvailable
  }
  try {
    await execAsync('git --version', { timeout: 5000 })
    gitAvailable = true
  } catch {
    gitAvailable = false
    console.warn(
      '[GitBranch] git binary không khả dụng — tất cả function fail-open (sandbox mode).',
    )
  }
  gitAvailabilityChecked = true
  return gitAvailable
}

// ============================================================
// §3. BUILD BRANCH NAME — pure
// ============================================================

/**
 * Build branch name từ proposal code — TB-11 §3 "1 Proposal = 1 branch".
 * Pure function: `P-YYYYMMDD-NNN` → `proposal/P-YYYYMMDD-NNN`.
 */
export function buildBranchName(proposalCode: string): string {
  if (!proposalCode || typeof proposalCode !== 'string') {
    return `proposal/unknown-${Date.now()}`
  }
  // Sanitize — code đã match pattern P-YYYYMMDD-NNN nhưng phòng xa
  const safe = proposalCode.replace(/[^a-zA-Z0-9_-]/g, '-')
  return `proposal/${safe}`
}

// ============================================================
// §4. CREATE BRANCH — TB-11 §3 (DRAFT → SUBMITTED triggers createBranch)
// ============================================================

/**
 * Create branch trong workspace dir — TB-13 §7 workspace git flow.
 *  1. Ensure workspace dir exists (mkdir -p).
 *  2. `git -C <workspaceRoot> init` (nếu chưa phải git repo — idempotent).
 *  3. `git -C <workspaceRoot> checkout -b <branchName>` (fail nếu branch đã tồn tại).
 *
 * TC-10: KHÔNG bao giờ chạy git ngoài workspaceRoot.
 * Fail-open: git binary không có / branch đã tồn tại → created=false, error logged.
 */
export async function createBranch(
  proposalCode: string,
  workspaceRoot: string,
): Promise<BranchResult> {
  const branchName = buildBranchName(proposalCode)

  if (!(await isGitAvailable())) {
    return {
      branchName,
      created: false,
      error: 'git not available (sandbox mode — branchName set but not created)',
    }
  }

  // Ensure workspace dir exists
  try {
    if (!existsSync(workspaceRoot)) {
      await mkdir(workspaceRoot, { recursive: true })
    }
  } catch (err) {
    return {
      branchName,
      created: false,
      error: `mkdir workspace failed: ${err instanceof Error ? err.message : String(err)}`,
    }
  }

  // Init git repo if needed (idempotent — git init on existing repo is no-op)
  try {
    await execAsync(`git -C "${workspaceRoot}" init`, { timeout: 10000 })
    // Set default branch to main if not configured (git 2.28+)
    try {
      await execAsync(`git -C "${workspaceRoot}" symbolic-ref HEAD refs/heads/main`, { timeout: 5000 })
    } catch {
      // Older git — default branch is 'master'; not a problem
    }
  } catch (err) {
    return {
      branchName,
      created: false,
      error: `git init failed: ${err instanceof Error ? err.message : String(err)}`,
    }
  }

  // Create initial commit if repo is empty (git checkout -b requires HEAD)
  try {
    const { stdout: logStdout } = await execAsync(
      `git -C "${workspaceRoot}" log --oneline -1 2>&1 || true`,
      { timeout: 5000 },
    )
    if (!logStdout || logStdout.includes('does not have any commits') || logStdout.length === 0) {
      // Empty repo — create empty initial commit on main
      await execAsync(`git -C "${workspaceRoot}" commit --allow-empty -m "Initial commit (workspace root)"`, {
        timeout: 10000,
      })
    }
  } catch (err) {
    // Ignore — checkout -b might still work if HEAD exists
    console.warn(
      '[GitBranch] initial commit check failed (non-blocking):',
      err instanceof Error ? err.message : String(err),
    )
  }

  // Checkout -b the new branch
  try {
    await execAsync(`git -C "${workspaceRoot}" checkout -b "${branchName}"`, { timeout: 10000 })
    return { branchName, created: true }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    // Branch already exists → try checkout (no -b)
    if (msg.includes('already exists') || msg.includes('already')) {
      try {
        await execAsync(`git -C "${workspaceRoot}" checkout "${branchName}"`, { timeout: 10000 })
        return { branchName, created: true }
      } catch (err2) {
        return {
          branchName,
          created: false,
          error: `branch exists but checkout failed: ${err2 instanceof Error ? err2.message : String(err2)}`,
        }
      }
    }
    return {
      branchName,
      created: false,
      error: `git checkout -b failed: ${msg}`,
    }
  }
}

// ============================================================
// §5. COMMIT CHANGES — DR-C3 Q3 versioning (author + ts + part ref)
// ============================================================

export interface CommitAuthor {
  name: string
  email: string
}

/**
 * Commit changes trong workspace — DR-C3 Q3 versioning format:
 *  - Message: `[<proposalCode>] <message> (author, ts, part ref)`
 *  - Author: optional — fallback git config user.name/email.
 *  - `git add -A` trước `git commit -m`.
 *
 * Fail-open: git error → committed=false, error logged.
 */
export async function commitChanges(
  branchName: string,
  workspaceRoot: string,
  message: string,
  author?: CommitAuthor,
): Promise<CommitResult> {
  if (!(await isGitAvailable())) {
    return { committed: false, error: 'git not available (sandbox mode)' }
  }

  // Ensure on correct branch
  try {
    await execAsync(`git -C "${workspaceRoot}" checkout "${branchName}"`, { timeout: 10000 })
  } catch (err) {
    return {
      committed: false,
      error: `checkout branch ${branchName} failed: ${err instanceof Error ? err.message : String(err)}`,
    }
  }

  // Stage all
  try {
    await execAsync(`git -C "${workspaceRoot}" add -A`, { timeout: 10000 })
  } catch (err) {
    return {
      committed: false,
      error: `git add failed: ${err instanceof Error ? err.message : String(err)}`,
    }
  }

  // Commit
  const ts = new Date().toISOString()
  const safeMsg = message.replace(/"/g, '\\"').replace(/`/g, '\\`')
  const fullMsg = `${safeMsg} (${author ? author.name + ', ' : ''}${ts})`
  const authorFlag = author
    ? ` --author="${author.name} <${author.email}>"`
    : ''

  try {
    const { stdout } = await execAsync(
      `git -C "${workspaceRoot}" commit -m "${fullMsg}"${authorFlag}`,
      { timeout: 30000 },
    )
    // Extract SHA from stdout (format: "[branch abc1234] message")
    const shaMatch = stdout.match(/\[[\w/-]+\s+([a-f0-9]{7,40})\]/)
    return { committed: true, sha: shaMatch ? shaMatch[1] : undefined }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    // "nothing to commit" is not an error
    if (msg.includes('nothing to commit') || msg.includes('no changes')) {
      return { committed: true, sha: undefined }
    }
    return { committed: false, error: `git commit failed: ${msg}` }
  }
}

// ============================================================
// §6. DIFF SUMMARY — DR-C3 Q3 diff base..head artifact
// ============================================================

/**
 * Get diff summary — TB-11 §3 + DR-C3 Q3: diff base..head artifact.
 *  - base mặc định 'main' (fallback 'master').
 *  - `git diff <base>..<branch> --stat` → parse summary + filesChanged list.
 *
 * Fail-open: git error → return empty summary + error.
 */
export async function diffSummary(
  branchName: string,
  workspaceRoot: string,
  base?: string,
): Promise<DiffResult> {
  if (!(await isGitAvailable())) {
    return { summary: '', filesChanged: [], error: 'git not available (sandbox mode)' }
  }

  const baseBranch = base || (await resolveBaseBranch(workspaceRoot))

  try {
    const { stdout } = await execAsync(
      `git -C "${workspaceRoot}" diff "${baseBranch}..${branchName}" --stat`,
      { timeout: 30000 },
    )
    const lines = stdout.split('\n').filter((l) => l.trim().length > 0)
    const filesChanged: string[] = []
    for (const line of lines) {
      // Format: " path/to/file | N +-"
      const m = line.match(/^\s*([^\s|]+)\s*\|/)
      if (m && !m[1].includes('file changed') && !m[1].includes('files changed')) {
        filesChanged.push(m[1])
      }
    }
    // Last line is summary: " N files changed, M insertions(+), K deletions(-)"
    const summaryLine = lines.find((l) => l.includes('changed')) || ''
    return { summary: summaryLine.trim() || stdout.trim(), filesChanged }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    // base branch may not exist yet → return empty diff (no merge base)
    if (msg.includes('merge base') || msg.includes('unknown revision') || msg.includes('not a valid object name')) {
      return { summary: '(no merge base — branch may be initial commit)', filesChanged: [] }
    }
    return { summary: '', filesChanged: [], error: `git diff failed: ${msg}` }
  }
}

// ============================================================
// §7. MERGE BRANCH — TB-01 §3 Quy tắc vàng: APPLY only sau APPROVED
// ============================================================

/**
 * Merge branch vào target — TB-01 §3 Quy tắc vàng (APPLY operation sau APPROVED).
 *  1. `git -C <workspaceRoot> checkout <target>` (default 'main', fallback 'master').
 *  2. `git -C <workspaceRoot> merge <branchName> --no-ff -m "Merge <branchName>"`.
 *
 * Fail-open: merge conflict → merged=false + error. Caller (proposal/store.applyProposal)
 * wrap try/catch — proposal vẫn ở APPROVED, applied=false.
 */
export async function mergeBranch(
  branchName: string,
  workspaceRoot: string,
  target?: string,
): Promise<MergeResult> {
  if (!(await isGitAvailable())) {
    return { merged: false, error: 'git not available (sandbox mode)' }
  }

  const targetBranch = target || (await resolveBaseBranch(workspaceRoot))

  // Checkout target
  try {
    await execAsync(`git -C "${workspaceRoot}" checkout "${targetBranch}"`, { timeout: 10000 })
  } catch (err) {
    return {
      merged: false,
      error: `checkout target ${targetBranch} failed: ${err instanceof Error ? err.message : String(err)}`,
    }
  }

  // Merge --no-ff
  try {
    const { stdout } = await execAsync(
      `git -C "${workspaceRoot}" merge "${branchName}" --no-ff -m "Merge ${branchName} into ${targetBranch}"`,
      { timeout: 60000 },
    )
    // Extract merge commit SHA
    const shaMatch = stdout.match(/Merge made by the .*strategy.*\n?\s*([a-f0-9]{7,40})/i) ||
      stdout.match(/creating \w+ commit '?([a-f0-9]{7,40})'?/i)
    return { merged: true, sha: shaMatch ? shaMatch[1] : undefined }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes('CONFLICT') || msg.includes('conflict')) {
      return {
        merged: false,
        error: `merge conflict — manual resolution required: ${msg.slice(0, 500)}`,
      }
    }
    return { merged: false, error: `git merge failed: ${msg}` }
  }
}

// ============================================================
// §8. DELETE BRANCH — cleanup sau merge (optional)
// ============================================================

/**
 * Delete branch — cleanup sau merge (TB-13 §7 final step).
 *  - `git -C <workspaceRoot> branch -d <branchName>` (safe — refuses if not merged).
 *
 * Fail-open: delete error → deleted=false, error logged (caller tiếp tục pipeline).
 */
export async function deleteBranch(
  branchName: string,
  workspaceRoot: string,
): Promise<DeleteBranchResult> {
  if (!(await isGitAvailable())) {
    return { deleted: false, error: 'git not available (sandbox mode)' }
  }

  try {
    await execAsync(`git -C "${workspaceRoot}" branch -d "${branchName}"`, { timeout: 10000 })
    return { deleted: true }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    // Try force delete as fallback (caller explicit intent)
    try {
      await execAsync(`git -C "${workspaceRoot}" branch -D "${branchName}"`, { timeout: 10000 })
      return { deleted: true }
    } catch {
      return { deleted: false, error: `git branch -d failed: ${msg}` }
    }
  }
}

// ============================================================
// §9. INTERNAL HELPERS
// ============================================================

/**
 * Resolve base branch — try 'main' first, fallback 'master'.
 * Pure (no mutation); return 'main' default if both fail (git will report error upstream).
 */
async function resolveBaseBranch(workspaceRoot: string): Promise<string> {
  try {
    // Check if main exists
    const { stdout: mainCheck } = await execAsync(
      `git -C "${workspaceRoot}" rev-parse --verify main 2>/dev/null || echo "NOT_FOUND"`,
      { timeout: 5000 },
    )
    if (!mainCheck.includes('NOT_FOUND')) return 'main'

    // Fallback master
    const { stdout: masterCheck } = await execAsync(
      `git -C "${workspaceRoot}" rev-parse --verify master 2>/dev/null || echo "NOT_FOUND"`,
      { timeout: 5000 },
    )
    if (!masterCheck.includes('NOT_FOUND')) return 'master'
  } catch {
    // Ignore — return default
  }
  return DEFAULT_MERGE_TARGET
}
