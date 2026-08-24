/**
 * Dev Tools — Extended toolchain for the Code Team.
 *
 * Implements the P0/P1/P2 tools proposed in the tool-executor audit:
 *
 *   P0 (essential):  file_edit, file_delete, run_tests, file_list, grep, git_commit
 *   P1 (enhanced):  get_diagnostics, decompose_task, create_task, update_task,
 *                   get_plan, summarize, synthesize, run_bg, read_output,
 *                   kill_process, manage_packages
 *   P2 (wiring):    gateway_tool (proxy to the 36 gateway-bridge tools)
 *
 * All file/path operations are scoped to the project workspace root
 * (process.cwd() / OPENCODE_WORKSPACE) — a resolved path that escapes the root
 * is rejected. Destructive operations support `dry_run`.
 */

import { exec, execFile, spawn } from 'child_process'
import { promisify } from 'util'
import path from 'path'
import fs from 'fs/promises'
import { existsSync } from 'fs'
// Phase 1a.2 — DB-backed Todo store (replaces globalThis.__devTasks)
// Both Code Team agents AND independent agents share this table; sessionId scopes each list.
import { db } from '@/lib/db'

const execAsync = promisify(exec)
// Phase 3 audit fix (Task 9): execFileAsync passes argv as an array — bypasses
// the system shell entirely, eliminating shell-injection via user-supplied path
// arguments (e.g., `lint({path: 'foo"; rm -rf /tmp; echo "bar'})`). All tool
// functions that interpolate an agent-supplied path into a runner command MUST
// use execFileAsync (not execAsync) — see lint/testCoverage/runTests below.
const execFileAsync = promisify(execFile)

// ==================== SHARED HELPERS ====================

/**
 * fileRead — Phase 2.1 Claude Code parity tool.
 *
 * Reads a text file with line numbers (cat -n style), offset + limit for paging,
 * and a `nextOffset` cursor for continuing large files. Auto-detects binary files
 * (NULL byte in first 8KB) and refuses them.
 *
 * Spec: docs/FULLSTACK_CAPABILITY_PLAN_V2.md Phase 2.1 (line 209)
 * Feature flag: ENABLE_FILE_READ (default true — already shipped before flag added)
 */
export async function fileRead(args: {
  path: string
  offset?: number  // 1-based line number to start reading from
  limit?: number   // max lines to return (default 2000)
  line_numbers?: boolean  // prefix each line with line number (default true)
}): Promise<unknown> {
  if (!args.path) return { success: false, error: 'path is required' }

  const resolvedPath = await resolveWithinWorkspace(args.path)
  const offset = Math.max(1, args.offset || 1)
  const limit = Math.min(10_000, args.limit || 2000)
  const wantLineNumbers = args.line_numbers !== false // default true

  // Stat first — distinguish file-not-found, dir, and binary
  let stat
  try {
    stat = await fs.stat(resolvedPath)
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return { success: false, error: `File not found: ${args.path}` }
    return { success: false, error: `stat failed: ${err instanceof Error ? err.message : String(err)}` }
  }
  if (stat.isDirectory()) {
    return { success: false, error: `Path is a directory, not a file: ${args.path} (use file_list instead)` }
  }

  // Read first 8KB to detect binary (NULL byte = strong binary signal)
  const fh = await fs.open(resolvedPath, 'r')
  try {
    const probe = Buffer.alloc(8192)
    const { bytesRead } = await fh.read(probe, 0, 8192, 0)
    for (let i = 0; i < bytesRead; i++) {
      if (probe[i] === 0) {
        return {
          success: false,
          error: `Binary file detected (NULL byte at offset ${i}). file_read chỉ hỗ trợ text — dùng shell với \`xxd\` hoặc \`file\` để inspect binary.`,
          path: args.path,
          size: stat.size,
        }
      }
    }
  } finally {
    await fh.close()
  }

  // Full read (text mode)
  const content = await fs.readFile(resolvedPath, 'utf-8')
  const allLines = content.split('\n')
  const totalLines = allLines.length

  // Apply offset (1-based → 0-based)
  const startIdx = Math.min(offset - 1, totalLines)
  const endIdx = Math.min(startIdx + limit, totalLines)
  const visibleLines = allLines.slice(startIdx, endIdx)

  // Optional line-number prefix (cat -n style: right-justified 6-char width + tab)
  const formatted = wantLineNumbers
    ? visibleLines.map((line, i) => {
        const lineNo = startIdx + i + 1
        return `${String(lineNo).padStart(6, ' ')}\t${line}`
      })
    : visibleLines

  const hasMore = endIdx < totalLines
  return {
    success: true,
    path: args.path,
    content: formatted.join('\n'),
    lines: visibleLines.length,
    totalLines,
    offset,
    limit,
    // Cursor for the next page — caller passes this back as `offset` to continue.
    // Undefined when file fully read in this call.
    nextOffset: hasMore ? endIdx + 1 : undefined,
    truncated: hasMore,
  }
}

/** Resolve a path within the workspace root, rejecting traversal escapes. */
async function resolveWithinWorkspace(filePath: string): Promise<string> {
  const root = process.env.OPENCODE_WORKSPACE || process.cwd()
  const resolved = path.resolve(root, filePath)
  // Allow the root itself OR anything nested under it
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`Access denied: path escapes workspace root (${filePath})`)
  }
  return resolved
}

/** Truncate output to a token-budget-friendly size with a clear flag. */
function truncateOutput(text: string, maxChars = 50_000): { output: string; truncated: boolean; totalChars: number } {
  const totalChars = text.length
  if (totalChars <= maxChars) return { output: text, truncated: false, totalChars }
  return {
    output: text.slice(0, maxChars) + `\n\n... [TRUNCATED — ${totalChars - maxChars} more chars]`,
    truncated: true,
    totalChars,
  }
}

// ==================== P0: FILE OPS ====================

/**
 * file_edit — exact string replace, atomic batch mode.
 * Errors on 0 matches (old_str not found) or >1 match unless replace_all/edits[].
 * This is the primary "fix a bug" tool — never rewrites the whole file.
 */
export async function fileEdit(args: {
  path: string
  old_str: string
  new_str: string
  replace_all?: boolean
  edits?: Array<{ old_str: string; new_str: string }>
  match_count?: number  // Phase 2.2 — assert expected match count, fail if mismatch
  dry_run?: boolean     // Phase 2.2 — preview diff without writing
}): Promise<unknown> {
  const resolvedPath = await resolveWithinWorkspace(args.path)
  const original = await fs.readFile(resolvedPath, 'utf-8')

  // Batch mode: apply all edits atomically (all-or-nothing)
  const edits = args.edits
    ? args.edits
    : [{ old_str: args.old_str, new_str: args.new_str }]

  if (!args.edits && (!args.old_str || args.new_str === undefined)) {
    return { success: false, error: 'Either (old_str + new_str) or edits[] is required' }
  }

  let content = original
  const applied: Array<{ old_str: string; matches: number }> = []

  for (const edit of edits) {
    if (!edit.old_str) {
      throw new Error('Each edit requires old_str (non-empty)')
    }
    if (edit.old_str === edit.new_str) {
      throw new Error('old_str and new_str are identical — nothing to change')
    }

    // Count occurrences
    const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const countRegex = new RegExp(escapeRegExp(edit.old_str), 'g')
    const matches = (content.match(countRegex) || []).length

    if (matches === 0) {
      throw new Error(
        `0 matches for old_str (length ${edit.old_str.length}). The file content does not contain the exact string — whitespace/indentation must match exactly.`
      )
    }
    if (matches > 1 && !args.replace_all && !args.edits) {
      throw new Error(
        `${matches} matches for old_str — pass replace_all:true to replace all, or make old_str more specific (include surrounding context).`
      )
    }

    // Phase 2.2 — match_count guard: assert the expected number of matches.
    // Prevents accidentally editing the wrong file (e.g. wrong package.json after a copy).
    if (args.match_count !== undefined && matches !== args.match_count) {
      throw new Error(
        `match_count assertion failed: expected ${args.match_count} match(es) for old_str but found ${matches}. Refusing to edit — verify the file is what you expect.`
      )
    }

    if (args.replace_all || matches === 1) {
      content = content.split(edit.old_str).join(edit.new_str)
    } else {
      // Batch mode: replace only the first occurrence per edit
      const idx = content.indexOf(edit.old_str)
      content = content.slice(0, idx) + edit.new_str + content.slice(idx + edit.old_str.length)
    }
    applied.push({ old_str: edit.old_str.slice(0, 60), matches })
  }

  if (content === original) {
    return { success: true, message: 'No changes (new_str === old_str across all edits)', applied }
  }

  // Phase 2.2 — dry_run: return diff preview, do NOT touch the filesystem
  if (args.dry_run) {
    return {
      success: true,
      dryRun: true,
      path: args.path,
      editsApplied: applied.length,
      details: applied,
      wouldChangeSize: content.length - original.length,
    }
  }

  // Phase 2.2 — atomic write: temp file in same dir + rename.
  // Crash mid-write leaves the original file untouched (rename is atomic on POSIX/NTFS).
  const tmpPath = resolvedPath + `.tmp.${process.pid}.${Date.now()}`
  await fs.writeFile(tmpPath, content, 'utf-8')
  try {
    await fs.rename(tmpPath, resolvedPath)
  } catch (err) {
    await fs.unlink(tmpPath).catch(() => {})
    throw err
  }

  return {
    success: true,
    path: args.path,
    editsApplied: applied.length,
    details: applied,
    newFileSize: content.length,
  }
}

/**
 * file_delete — delete a file or directory.
 * Refuses to delete the workspace root or paths outside it.
 * dry_run returns what would be deleted without touching the filesystem.
 */
export async function fileDelete(args: {
  path: string
  recursive?: boolean
  dry_run?: boolean
  force?: boolean
}): Promise<unknown> {
  const resolvedPath = await resolveWithinWorkspace(args.path)
  const root = process.env.OPENCODE_WORKSPACE || process.cwd()
  if (resolvedPath === root) {
    return { error: 'Refusing to delete the workspace root' }
  }

  // lstat (not stat) — does NOT follow symlinks; symlinked dirs reported as
  // 'symlink' rather than the target's type. Without this, a symlinked dir
  // pointing outside the workspace could trigger fs.rm({recursive:true}) on
  // the TARGET directory (security escape). Phase 2 audit P1 #1.
  let lstat: Awaited<ReturnType<typeof fs.lstat>>
  try {
    lstat = await fs.lstat(resolvedPath)
  } catch {
    return { success: false, error: `Path does not exist: ${args.path}` }
  }

  const isSymlink = lstat.isSymbolicLink()
  const isDir = lstat.isDirectory()

  // Symlink target read is for dry_run preview only — never followed during
  // actual delete (we use fs.unlink on the link itself, not fs.rm on target).
  let symlinkTarget: string | undefined
  if (isSymlink) {
    try {
      symlinkTarget = await fs.readlink(resolvedPath)
    } catch {
      symlinkTarget = '<unreadable>'
    }
  }

  if (isDir && !args.recursive && !isSymlink) {
    return { error: 'Path is a directory — pass recursive:true to delete it' }
  }

  // dry_run preview — count files inside dir when applicable (audit P1 suggestion)
  if (args.dry_run) {
    let wouldDeleteCount = 1
    if (isDir && !isSymlink) {
      try {
        const countResult = await countFilesRecursive(resolvedPath)
        wouldDeleteCount = countResult
      } catch {
        wouldDeleteCount = -1
      }
    }
    return {
      success: true,
      dryRun: true,
      wouldDelete: args.path,
      type: isSymlink ? 'symlink' : isDir ? 'directory' : 'file',
      ...(symlinkTarget ? { symlinkTarget } : {}),
      ...(isDir && !isSymlink ? { fileCount: wouldDeleteCount } : {}),
    }
  }

  if (isSymlink) {
    // fs.unlink on the link itself — removes the link, NOT the target.
    // This is the safe path: even if the symlink points outside the workspace,
    // we only delete the link entry inside the workspace.
    await fs.unlink(resolvedPath)
    return { success: true, deleted: args.path, type: 'symlink', ...(symlinkTarget ? { symlinkTarget } : {}) }
  }

  if (isDir) {
    // force:true required to actually delete readonly files inside the dir;
    // default false — caller must opt-in to bypass fs.rm's readonly refusal.
    await fs.rm(resolvedPath, { recursive: true, force: args.force === true })
  } else {
    await fs.unlink(resolvedPath)
  }

  return { success: true, deleted: args.path, type: isDir ? 'directory' : 'file' }
}

/**
 * countFilesRecursive — walk a directory and count all entries (files +
 * subdirs, recursively). Used by file_delete dry_run preview so the user
 * knows "would delete N files" before confirming.
 *
 * Returns 0 on empty dir, throws on inaccessible (rethrows caller to handle).
 */
async function countFilesRecursive(dirPath: string): Promise<number> {
  let count = 0
  const stack: string[] = [dirPath]
  while (stack.length > 0) {
    const current = stack.pop()!
    let entries: Awaited<ReturnType<typeof fs.readdir>>
    try {
      entries = await fs.readdir(current, { withFileTypes: true })
    } catch {
      // Skip unreadable subdir — partial count is acceptable for dry_run preview.
      continue
    }
    for (const entry of entries) {
      count++
      // lstat check — don't follow symlinks during count (avoid escape / loops)
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        stack.push(path.join(current, entry.name))
      }
    }
  }
  return count
}

/**
 * file_list — shallow directory listing / tree.
 * Returns typed entries with size + mtime. depth controls recursion.
 * Phase 2.5 enhancements: `pattern` glob filter + `lstat` (don't follow symlinks).
 */
export async function fileList(args: {
  path?: string
  depth?: number
  ignore?: string[]
  pattern?: string  // Phase 2.5 — glob filter on entry name (e.g. "*.ts" or "*.json")
}): Promise<unknown> {
  const target = args.path || '.'
  const resolvedPath = await resolveWithinWorkspace(target)
  const maxDepth = Math.min(args.depth || 1, 5)
  const ignoreSet = new Set(args.ignore || ['node_modules', '.next', '.git', 'dist', 'build'])
  // Compile glob pattern once (simple * support, same convention as grep)
  const globRe = args.pattern
    ? new RegExp('^' + args.pattern.replace(/\./g, '\\.').replace(/\*/g, '.*') + '$')
    : null

  async function walk(dir: string, depth: number): Promise<Array<{ name: string; type: string; size: number; mtime: string; symlink?: boolean }>> {
    if (depth > maxDepth) return []
    const entries = await fs.readdir(dir, { withFileTypes: true })
    const result: Array<{ name: string; type: string; size: number; mtime: string; symlink?: boolean }> = []
    for (const entry of entries) {
      if (ignoreSet.has(entry.name)) continue
      // Phase 2.5 — glob filter (skip directories that don't match — let directory walk
      // reveal matching files inside; but if pattern is "*.ts", a dir "foo/" won't match,
      // so we only filter FILE entries here, dirs pass through to allow recursion)
      const full = path.join(dir, entry.name)
      try {
        // Phase 2.5 — use lstat (not stat) so symlinks don't follow (security: prevents
        // a symlink from reporting the size/mtime of a path outside the workspace).
        const stat = await fs.lstat(full)
        const isSymlink = stat.isSymbolicLink()
        const isDir = stat.isDirectory() || (isSymlink && entry.isDirectory())
        // Apply pattern filter ONLY to file entries (dirs recurse to find files inside)
        if (!isDir && globRe && !globRe.test(entry.name)) continue
        result.push({
          name: entry.name,
          type: isDir ? 'dir' : 'file',
          size: stat.size,
          mtime: stat.mtime.toISOString(),
          symlink: isSymlink || undefined,
        })
        if (isDir && depth < maxDepth) {
          const nested = await walk(full, depth + 1)
          for (const n of nested) {
            result.push({ ...n, name: `${entry.name}/${n.name}` })
          }
        }
      } catch { /* skip unreadable */ }
    }
    return result
  }

  const entries = await walk(resolvedPath, 1)
  return { success: true, path: target, entries, total: entries.length }
}

/**
 * grep — content search with regex (ripgrep semantics, but pure JS so no shell quoting issues).
 * mode: 'content' (default) | 'files' (just filenames) | 'count'
 */
export async function grep(args: {
  pattern: string
  path?: string
  glob?: string
  mode?: 'content' | 'files' | 'count'
  context?: number
  head_limit?: number
  multiline?: boolean  // Phase 2.5 — enable cross-line patterns (e.g. "function\\s+\\w+[\\s\\S]*?return")
  case_sensitive?: boolean  // Phase 2.5 — default false (case-insensitive), opt-out for case-sensitive
}): Promise<unknown> {
  if (!args.pattern) return { success: false, error: 'pattern is required' }
  const searchRoot = args.path ? await resolveWithinWorkspace(args.path) : await resolveWithinWorkspace('.')
  const mode = args.mode || 'content'
  const contextLines = Math.min(args.context || 0, 5)
  const headLimit = Math.min(args.head_limit || 100, 500)

  let regex: RegExp
  try {
    // Phase 2.5 — case-insensitive by default (audit confirmed); opt-out via case_sensitive=true.
    // multiline flag enables ^/$ to match line boundaries AND allows [\s\S]*? patterns to span lines.
    const flags = args.multiline ? (args.case_sensitive ? 'gm' : 'gim') : (args.case_sensitive ? 'g' : 'gi')
    regex = new RegExp(args.pattern, flags)
  } catch (e) {
    return { success: false, error: `Invalid regex: ${e instanceof Error ? e.message : String(e)}` }
  }

  const ignoreDirs = new Set(['node_modules', '.next', '.git', 'dist', 'build'])
  const matches: Array<{ file: string; line: number; text: string; context?: string[] }> = []
  const fileMatches = new Set<string>()
  const fileMatchCounts = new Map<string, number>()

  // Phase 2.5 — binary detection helper: check first 8KB for NULL byte.
  // Reading 8KB is much cheaper than reading a multi-MB binary file fully.
  async function isBinaryMaybe(full: string): Promise<boolean> {
    try {
      const fh = await fs.open(full, 'r')
      try {
        const probe = Buffer.alloc(8192)
        const { bytesRead } = await fh.read(probe, 0, 8192, 0)
        for (let i = 0; i < bytesRead; i++) {
          if (probe[i] === 0) return true
        }
        return false
      } finally {
        await fh.close()
      }
    } catch {
      return true // unreadable → treat as binary, skip
    }
  }

  async function scan(dir: string, relBase: string) {
    let entries: import('fs').Dirent[]
    try { entries = await fs.readdir(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (ignoreDirs.has(entry.name)) continue
      const full = path.join(dir, entry.name)
      const rel = relBase ? `${relBase}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        await scan(full, rel)
      } else if (entry.isFile()) {
        // glob filter (simple * support)
        if (args.glob) {
          const globRe = new RegExp('^' + args.glob.replace(/\./g, '\\.').replace(/\*/g, '.*') + '$')
          if (!globRe.test(entry.name)) continue
        }
        // Phase 2.5 — skip binary files (NULL byte in first 8KB)
        if (await isBinaryMaybe(full)) continue
        try {
          const content = await fs.readFile(full, 'utf-8')
          if (args.multiline) {
            // Multiline mode: test against full content; record file as match if any match.
            // We don't get per-line `line` info for cross-line matches — set to 1 with full
            // match preview (first 200 chars of the matched substring).
            const m = content.match(regex)
            if (m) {
              fileMatches.add(rel)
              fileMatchCounts.set(rel, (fileMatchCounts.get(rel) || 0) + 1)
              if (mode === 'content') {
                matches.push({ file: rel, line: 1, text: m[0].slice(0, 200) })
                if (matches.length >= headLimit) return
              }
            }
          } else {
            const lines = content.split('\n')
            for (let i = 0; i < lines.length; i++) {
              if (regex.test(lines[i])) {
                fileMatches.add(rel)
                fileMatchCounts.set(rel, (fileMatchCounts.get(rel) || 0) + 1)
                if (mode === 'content') {
                  const ctx: string[] = []
                  if (contextLines > 0) {
                    for (let c = Math.max(0, i - contextLines); c < Math.min(lines.length, i + contextLines + 1); c++) {
                      if (c !== i) ctx.push(`${c + 1}: ${lines[c]}`)
                    }
                  }
                  matches.push({ file: rel, line: i + 1, text: lines[i].trim().slice(0, 200), context: ctx.length ? ctx : undefined })
                  if (matches.length >= headLimit) return
                }
              }
            }
          }
        } catch { /* binary/unreadable — skip */ }
      }
    }
  }

  await scan(searchRoot, '')
  if (mode === 'files') return { success: true, files: Array.from(fileMatches), total: fileMatches.size }
  if (mode === 'count') return { success: true, files: Array.from(fileMatches).map(f => ({ file: f, count: fileMatchCounts.get(f) || 0 })), totalMatches: Array.from(fileMatchCounts.values()).reduce((a, b) => a + b, 0) }
  return { success: true, matches, totalMatches: matches.length, truncated: matches.length >= headLimit }
}

// ==================== P0: RUN TESTS ====================

/**
 * run_tests — framework-aware test runner.
 * Autodetects: bun test (if bun.lock present), vitest (vitest in deps + *.test.ts),
 * jest (jest in deps), pytest (Python project). Runs the matching command
 * with a 5-minute timeout and parses pass/fail counts + failure locations.
 */
export async function runTests(args: {
  target?: string  // path to test file or test-name pattern
  coverage?: boolean
}): Promise<unknown> {
  const root = process.env.OPENCODE_WORKSPACE || process.cwd()

  // Detect framework
  let framework: 'bun' | 'vitest' | 'jest' | 'pytest'
  let command: string

  const hasBunLock = existsSync(path.join(root, 'bun.lock'))
  const hasPyproject = existsSync(path.join(root, 'pyproject.toml')) || existsSync(path.join(root, 'pytest.ini'))
  const pkgJsonPath = path.join(root, 'package.json')
  let pkgJson: any = null
  try { pkgJson = JSON.parse(await fs.readFile(pkgJsonPath, 'utf-8')) } catch {}
  const deps = { ...(pkgJson?.dependencies || {}), ...(pkgJson?.devDependencies || {}) }

  // Build argv array (no shell — Phase 3 audit fix for shell-injection via args.target)
  let argv: string[]
  if (hasBunLock) {
    framework = 'bun'
    argv = ['test']
    if (args.target) argv.push(args.target)
    if (args.coverage) argv.push('--coverage')
    command = `bun ${argv.join(' ')}`
  } else if (deps.vitest || deps['@vitest/ui']) {
    framework = 'vitest'
    argv = ['vitest', 'run']
    if (args.target) argv.push(args.target)
    if (args.coverage) argv.push('--coverage')
    command = `npx ${argv.join(' ')}`
  } else if (deps.jest) {
    framework = 'jest'
    argv = ['jest']
    if (args.target) argv.push(args.target)
    if (args.coverage) argv.push('--coverage')
    command = `npx ${argv.join(' ')}`
  } else if (hasPyproject) {
    framework = 'pytest'
    argv = ['pytest']
    if (args.target) argv.push(args.target)
    if (args.coverage) argv.push('--cov')
    command = argv.join(' ')
  } else {
    // Default to bun (the project's primary runtime)
    framework = 'bun'
    argv = ['test']
    if (args.target) argv.push(args.target)
    command = `bun ${argv.join(' ')}`
  }

  console.log(`[run_tests] Detected framework: ${framework} → ${command}`)

  try {
    // execFileAsync bypasses shell — no shell-injection risk from args.target.
    // The first element of argv is the executable name (lookup via PATH).
    const runner = framework === 'pytest' ? 'pytest'
      : framework === 'bun' ? 'bun'
      : 'npx'
    const runnerArgs = framework === 'pytest' ? argv.slice(1)
      : framework === 'bun' ? argv.slice(1)
      : argv
    const { stdout, stderr } = await execFileAsync(runner, runnerArgs, {
      cwd: root,
      timeout: 5 * 60 * 1000, // 5 minutes
      maxBuffer: 5 * 1024 * 1024, // 5MB
      env: { ...process.env, CI: 'true' }, // CI=true disables watch mode + colors
      shell: false, // explicit: never invoke shell
    })
    const combined = stdout + '\n' + stderr
    const parsed = parseTestOutput(combined, framework)
    const trunc = truncateOutput(combined, 30_000)
    return {
      success: true,
      framework,
      command,
      ...parsed,
      output: trunc.output,
      truncated: trunc.truncated,
    }
  } catch (err: any) {
    const combined = (err.stdout || '') + '\n' + (err.stderr || '')
    const parsed = parseTestOutput(combined, framework)
    const trunc = truncateOutput(combined, 30_000)
    return {
      success: false,
      framework,
      command,
      ...parsed,
      output: trunc.output,
      truncated: trunc.truncated,
      error: `Tests failed: ${err.message}`,
    }
  }
}

/** Parse framework-specific test output for pass/fail counts + failure locations + duration. */
function parseTestOutput(output: string, framework: string): { passed: number; failed: number; skipped: number; durationMs?: number; failingTests: Array<{ file: string; line?: number; message: string }> } {
  const failingTests: Array<{ file: string; line?: number; message: string }> = []
  let passed = 0, failed = 0, skipped = 0
  let durationMs: number | undefined

  if (framework === 'bun') {
    // bun test: "(pass) test name", "(fail) test name", "(skip) test name"
    const passMatches = output.match(/\(pass\)/g) || []
    const failMatches = output.match(/\(fail\)/g) || []
    const skipMatches = output.match(/\(skip\)/g) || []
    passed = passMatches.length
    failed = failMatches.length
    skipped = skipMatches.length
    // Phase 2.6 fix — extract duration: bun prints "Xms" at the end of summary
    const durMatch = output.match(/(\d+(?:\.\d+)?)\s*ms/i)
    if (durMatch) durationMs = parseFloat(durMatch[1])
    // Extract failure file:line from error stack lines
    const failBlocks = output.split(/\(fail\)/).slice(1)
    for (const block of failBlocks) {
      const stackLine = block.match(/([^\s]+\.(?:test|spec)\.[tj]sx?):(\d+):(\d+)/)
      const msg = block.split('\n').find(l => l.trim() && !l.includes('at '))?.trim().slice(0, 200) || 'test failed'
      failingTests.push({
        file: stackLine?.[1] || 'unknown',
        line: stackLine ? parseInt(stackLine[2]) : undefined,
        message: msg,
      })
    }
  } else if (framework === 'vitest' || framework === 'jest') {
    // vitest/jest: "Tests  X passed, Y failed, Z skipped" + "✓" / "✗" / "✘"
    const summary = output.match(/Tests\s+(\d+)\s+passed(?:,?\s*(\d+)\s+failed)?(?:,?\s*(\d+)\s+(?:skipped|todo|disabled))?/i)
    if (summary) {
      passed = parseInt(summary[1]) || 0
      failed = parseInt(summary[2]) || 0
      skipped = parseInt(summary[3]) || 0
    } else {
      // Fallback: count symbols
      passed = (output.match(/[✓√]/g) || []).length
      failed = (output.match(/[✗×✘]/g) || []).length
    }
    // Phase 2.6 fix — vitest: "Test Files  N passed (Mms)" / jest: "Time: N.Ns"
    const vitestDur = output.match(/Test Files\s+\d+\s+\w+\s*\((\d+(?:\.\d+)?)\s*ms\)/i)
    const jestDur = output.match(/Time:\s+(\d+(?:\.\d+)?)\s*s/i)
    if (vitestDur) durationMs = parseFloat(vitestDur[1])
    else if (jestDur) durationMs = parseFloat(jestDur[1]) * 1000
    // Extract failure locations
    const failBlocks = output.split(/FAIL\s/).slice(1)
    for (const block of failBlocks) {
      const fileMatch = block.match(/^([^\s▲▼►◀]*\.(?:test|spec)\.[tj]sx?)/m)
      const lineMatch = block.match(/:(\d+):\d+/)
      const msg = block.split('\n')[0]?.trim().slice(0, 200) || 'test failed'
      failingTests.push({
        file: fileMatch?.[1] || 'unknown',
        line: lineMatch ? parseInt(lineMatch[1]) : undefined,
        message: msg,
      })
    }
  } else if (framework === 'pytest') {
    // pytest: "===== X passed, Y failed, Z skipped in N.Ns ====="
    const summary = output.match(/(\d+)\s+passed(?:,?\s*(\d+)\s+failed)?(?:,?\s*(\d+)\s+skipped)?(?:\s+in\s+(\d+(?:\.\d+)?)\s*s)?/i)
    if (summary) {
      passed = parseInt(summary[1]) || 0
      failed = parseInt(summary[2]) || 0
      skipped = parseInt(summary[3]) || 0
      // Phase 2.6 fix — extract duration from "in N.Ns" suffix
      if (summary[4]) durationMs = parseFloat(summary[4]) * 1000
    }
    // Extract failure file:line from "file.py:123: AssertionError"
    const failMatches = output.matchAll(/([^\s:]+\.py):(\d+):\s+(.+)/g)
    for (const m of failMatches) {
      failingTests.push({ file: m[1], line: parseInt(m[2]), message: m[3].slice(0, 200) })
    }
  }

  return { passed, failed, skipped, durationMs, failingTests: failingTests.slice(0, 20) }
}

// ==================== P0: GIT COMMIT ====================

/**
 * git_commit — Phase 2.7 spec compliance.
 *
 * Scoped paths only (NO `git add -A`/`.` wildcard — explicitly forbidden per spec line 215).
 * Pre-flight check (`git status --porcelain`) refuses to commit if there's nothing staged
 * to avoid cryptic "nothing to commit" errors from git.
 * Structured receipt: `{ commitHash, branch, filesChanged[], message }` (Claude Code parity).
 * Does NOT push — standing rule.
 *
 * Spec: docs/FULLSTACK_CAPABILITY_PLAN_V2.md Phase 2.7 (line 215)
 * Feature flag: ENABLE_GIT_COMMIT (default true)
 */
export async function gitCommit(args: {
  message: string
  paths?: string[]  // REQUIRED when all=true — we never commit everything by wildcard
  all?: boolean     // also `git add` the paths first (paths REQUIRED — see above)
  dry_run?: boolean // stage + show diff but don't commit
  no_verify?: boolean // pass --no-verify to skip pre-commit hooks (use sparingly)
}): Promise<unknown> {
  if (!args.message || !args.message.trim()) {
    return { success: false, error: 'Commit message is required (non-empty)' }
  }
  // Spec violation guard: `all=true` without `paths[]` would fall back to `git add -A`
  // which violates "scoped paths" principle. Force the caller to specify paths.
  if (args.all && (!args.paths || args.paths.length === 0)) {
    return {
      success: false,
      error: 'all=true requires paths[] (scoped paths only — `git add -A` is forbidden per spec). Pass paths explicitly, or omit `all` to commit only currently-staged changes.',
    }
  }

  const root = process.env.OPENCODE_WORKSPACE || process.cwd()

  try {
    // Resolve + scope-check paths (reject escapes)
    const resolvedPaths = args.paths
      ? await Promise.all(args.paths.map(p => resolveWithinWorkspace(p)))
      : []

    // Pre-flight: detect "nothing to commit" before running git add
    if (args.all && resolvedPaths.length > 0) {
      const relPaths = resolvedPaths.map(p => path.relative(root, p))
      const { stdout: porcelain } = await execAsync(`git status --porcelain -- ${relPaths.map(p => `"${p}"`).join(' ')}`, { cwd: root, timeout: 10_000 })
      if (!porcelain.trim()) {
        return { success: false, error: `Nothing to commit — paths have no changes: ${relPaths.join(', ')}` }
      }
    } else if (!args.paths || args.paths.length === 0) {
      // Commit-only path: check what's already staged
      const { stdout: staged } = await execAsync('git diff --cached --name-only', { cwd: root, timeout: 10_000 })
      if (!staged.trim()) {
        return { success: false, error: 'Nothing staged to commit. Pass paths + all=true to stage first, or stage manually with `git add`.' }
      }
    }

    // Stage if requested (scoped — only the explicitly-listed paths)
    // NOTE: dry_run skips staging entirely — it computes "would commit" via git status
    // so the index is left untouched (no persistent side-effects).
    if (!args.dry_run && args.all && resolvedPaths.length > 0) {
      const relPaths = resolvedPaths.map(p => `"${path.relative(root, p)}"`)
      await execAsync(`git add -- ${relPaths.join(' ')}`, { cwd: root, timeout: 15_000 })
    }

    // Dry-run: do NOT stage, do NOT commit — show what WOULD be committed.
    // Uses `git status --porcelain` which reports both staged + unstaged changes per path.
    if (args.dry_run) {
      const relPaths = resolvedPaths.length > 0
        ? resolvedPaths.map(p => path.relative(root, p))
        : []
      let wouldCommitFiles: string[] = []
      if (relPaths.length > 0) {
        const { stdout: porcelain } = await execAsync(
          `git status --porcelain -- ${relPaths.map(p => `"${p}"`).join(' ')}`,
          { cwd: root, timeout: 10_000 }
        )
        // Porcelain format: "XY path" where X=staged, Y=unstaged. We report any path with changes.
        wouldCommitFiles = porcelain.split('\n').filter(Boolean).map(l => l.slice(3).trim())
      } else {
        // No paths specified → report all currently-staged files
        const { stdout: staged } = await execAsync('git diff --cached --name-only', { cwd: root, timeout: 10_000 })
        wouldCommitFiles = staged.split('\n').filter(Boolean)
      }
      return {
        success: true,
        dryRun: true,
        message: args.message,
        wouldCommitFiles,
      }
    }

    // Build commit command (use a temp file for the message to avoid shell-escaping hell)
    const tmpFile = path.join(root, `.git/COMMIT_EDITMSG_${Date.now()}`)
    await fs.writeFile(tmpFile, args.message, 'utf-8')
    try {
      const noVerifyFlag = args.no_verify ? ' --no-verify' : ''
      // No pathArgs here — `git commit path1 path2` only commits those paths even if
      // other things are staged. We already scoped via `git add` above, so commit alone
      // is what we want (commit everything currently staged, which is exactly the paths added).
      const { stdout, stderr } = await execAsync(
        `git commit -F "${path.relative(root, tmpFile)}"${noVerifyFlag}`,
        { cwd: root, timeout: 30_000 }
      )

      // Structured receipt: hash + branch + filesChanged[]
      const { stdout: hashOut } = await execAsync('git rev-parse HEAD', { cwd: root, timeout: 5_000 })
      const { stdout: branchOut } = await execAsync('git rev-parse --abbrev-ref HEAD', { cwd: root, timeout: 5_000 }).catch(() => ({ stdout: 'unknown' }))
      const { stdout: filesOut } = await execAsync('git show --stat --name-only --format= HEAD', { cwd: root, timeout: 10_000 })

      return {
        success: true,
        commitHash: hashOut.trim().slice(0, 12),
        branch: branchOut.trim(),
        message: args.message,
        filesChanged: filesOut.split('\n').filter(Boolean),
        output: (stdout + stderr).trim() || 'committed',
      }
    } finally {
      await fs.unlink(tmpFile).catch(() => {})
    }
  } catch (err: any) {
    const { stdout, stderr } = err
    return {
      success: false,
      error: `git commit failed: ${err.message}`,
      output: ((stdout || '') + (stderr || '')).trim().slice(0, 1000),
    }
  }
}

// ==================== P1: GET DIAGNOSTICS (LSP / tsc) ====================

/**
 * get_diagnostics — type-check + lint diagnostics for a file or the whole workspace.
 * Tries the opencode-server /lsp/diagnostics endpoint first (it wraps `tsc --noEmit`),
 * falls back to running `tsc --noEmit` locally and parsing the output.
 */
export async function getDiagnostics(args: { path?: string }): Promise<unknown> {
  const root = process.env.OPENCODE_WORKSPACE || process.cwd()
  const opencodeUrl = process.env.OPENCODE_SERVER_URL || 'http://127.0.0.1:18790'

  // Try opencode-server first
  try {
    const res = await fetch(`${opencodeUrl}/lsp/diagnostics`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filePath: args.path || '' }),
      signal: AbortSignal.timeout(60_000),
    })
    if (res.ok) {
      const data = await res.json()
      return { success: true, source: 'opencode-server', ...data }
    }
  } catch { /* fall through to local tsc */ }

  // Fallback: run tsc --noEmit locally
  try {
    const { stdout, stderr } = await execAsync('npx tsc --noEmit', {
      cwd: root,
      timeout: 120_000,
      maxBuffer: 5 * 1024 * 1024,
    })
    return {
      success: true,
      source: 'tsc --noEmit',
      diagnostics: [],
      output: (stdout + stderr).trim() || 'No type errors',
    }
  } catch (err: any) {
    // tsc exits non-zero on errors — the errors are in stdout
    const output = (err.stdout || '') + (err.stderr || '')
    const diagnostics = parseTscOutput(output)
    return {
      success: diagnostics.length === 0,
      source: 'tsc --noEmit',
      diagnostics,
      errorCount: diagnostics.length,
      output: output.slice(0, 5000),
    }
  }
}

/** Parse `tsc --noEmit` output: `file.ts(line,col): error TSxxxx: message` */
function parseTscOutput(output: string): Array<{ file: string; line: number; col: number; severity: string; code: string; message: string }> {
  const regex = /^([^(]+)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s+(.+)$/gm
  const diags: Array<{ file: string; line: number; col: number; severity: string; code: string; message: string }> = []
  let match
  while ((match = regex.exec(output)) !== null) {
    diags.push({
      file: match[1],
      line: parseInt(match[2]),
      col: parseInt(match[3]),
      severity: match[4],
      code: match[5],
      message: match[6].slice(0, 200),
    })
  }
  return diags
}

// ==================== P1: TASK DAG STORE (in-memory, globalThis) ====================

interface DevTask {
  id: string
  title: string
  spec: string
  assignee: string | null
  priority: 'low' | 'medium' | 'high'
  deps: string[]
  status: 'pending' | 'in_progress' | 'blocked' | 'completed' | 'failed'
  notes: string | null
  createdAt: string
  updatedAt: string
}

const globalForTasks = globalThis as unknown as { __devTasks?: Map<string, DevTask>; __devTaskCounter?: number }
function getTaskStore(): Map<string, DevTask> {
  if (!globalForTasks.__devTasks) {
    globalForTasks.__devTasks = new Map()
    globalForTasks.__devTaskCounter = 0
  }
  return globalForTasks.__devTasks
}
function nextTaskId(): string {
  const n = (globalForTasks.__devTaskCounter || 0) + 1
  globalForTasks.__devTaskCounter = n
  return `T${String(n).padStart(3, '0')}`
}

/**
 * decompose_task — break a goal into a DAG of subtasks.
 * NOTE: this is an LLM-assisted decomposition; the LLM is prompted to return
 * a JSON array of tasks with dependencies, which we persist in the task store.
 */
export async function decomposeTask(args: { goal: string; context?: string }): Promise<unknown> {
  if (!args.goal) return { error: 'goal is required' }

  const { callLLM } = await import('@/lib/llm')
  const prompt = `Decompose this goal into 3-7 concrete subtasks. Return a JSON array (no markdown fence).
Each task: { "title": short, "spec": 1-2 sentence acceptance criteria, "assignee": "TL"|"G1"|"G2-A"|"G2-B"|"G3", "priority": "low"|"medium"|"high", "deps": [task indices 0-based] }

Goal: ${args.goal}
${args.context ? `Context: ${args.context}` : ''}

JSON:`
  const result = await callLLM(prompt, 'You are a senior tech lead. Be concrete and minimal.', 'task_decomposition')
  const text = result.content || '[]'

  let tasksRaw: any[]
  try {
    // Strip markdown fence if present
    const cleaned = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim()
    tasksRaw = JSON.parse(cleaned)
  } catch {
    return { error: 'LLM did not return valid JSON', raw: text.slice(0, 500) }
  }

  const store = getTaskStore()
  const created: DevTask[] = []
  // First pass: create with placeholder deps (will resolve after all created)
  const idMap = new Map<number, string>()
  for (let i = 0; i < tasksRaw.length; i++) {
    const id = nextTaskId()
    idMap.set(i, id)
  }
  for (let i = 0; i < tasksRaw.length; i++) {
    const t = tasksRaw[i]
    const id = idMap.get(i)!
    const now = new Date().toISOString()
    const task: DevTask = {
      id,
      title: String(t.title || `Task ${i + 1}`),
      spec: String(t.spec || ''),
      assignee: String(t.assignee || 'G2-A'),
      priority: (['low', 'medium', 'high'].includes(t.priority) ? t.priority : 'medium'),
      deps: (Array.isArray(t.deps) ? t.deps : []).map((d: number) => idMap.get(d) || `T${String(d + 1).padStart(3, '0')}`),
      status: 'pending',
      notes: null,
      createdAt: now,
      updatedAt: now,
    }
    store.set(id, task)
    created.push(task)
  }

  return { success: true, goal: args.goal, tasksCreated: created.length, tasks: created }
}

export async function createTask(args: {
  title: string
  spec: string
  assignee?: string
  priority?: 'low' | 'medium' | 'high'
  deps?: string[]
}): Promise<unknown> {
  const store = getTaskStore()
  const id = nextTaskId()
  const now = new Date().toISOString()
  const task: DevTask = {
    id,
    title: args.title,
    spec: args.spec,
    assignee: args.assignee || null,
    priority: args.priority || 'medium',
    deps: args.deps || [],
    status: 'pending',
    notes: null,
    createdAt: now,
    updatedAt: now,
  }
  store.set(id, task)
  return { success: true, task }
}

export async function updateTask(args: {
  task_id: string
  status?: 'pending' | 'in_progress' | 'blocked' | 'completed' | 'failed'
  notes?: string
}): Promise<unknown> {
  const store = getTaskStore()
  const task = store.get(args.task_id)
  if (!task) return { error: `Task not found: ${args.task_id}` }
  if (args.status) task.status = args.status
  if (args.notes !== undefined) task.notes = args.notes
  task.updatedAt = new Date().toISOString()
  store.set(args.task_id, task)
  return { success: true, task }
}

export async function getPlan(): Promise<unknown> {
  const store = getTaskStore()
  const tasks = Array.from(store.values())
  const byStatus = {
    pending: tasks.filter(t => t.status === 'pending').length,
    in_progress: tasks.filter(t => t.status === 'in_progress').length,
    blocked: tasks.filter(t => t.status === 'blocked').length,
    completed: tasks.filter(t => t.status === 'completed').length,
    failed: tasks.filter(t => t.status === 'failed').length,
  }
  return { success: true, total: tasks.length, byStatus, tasks }
}

// ==================== P1: SUMMARIZE + SYNTHESIZE ====================

export async function summarize(args: { paths?: string[]; content?: string; focus?: string }): Promise<unknown> {
  if (!args.paths && !args.content) return { error: 'Either paths[] or content is required' }

  let sourceContent = args.content || ''
  if (args.paths && args.paths.length > 0) {
    const parts: string[] = []
    for (const p of args.paths) {
      try {
        const resolved = await resolveWithinWorkspace(p)
        const content = await fs.readFile(resolved, 'utf-8')
        parts.push(`=== ${p} (${content.length} chars) ===\n${content.slice(0, 10000)}`)
      } catch (e) {
        parts.push(`=== ${p} (READ ERROR: ${e instanceof Error ? e.message : String(e)}) ===`)
      }
    }
    sourceContent = parts.join('\n\n')
  }

  if (!sourceContent.trim()) return { error: 'No content to summarize' }

  const { callLLM } = await import('@/lib/llm')
  const focus = args.focus ? `\nFocus on: ${args.focus}` : ''
  const result = await callLLM(
    `Summarize the following content. Be concise but cover: purpose, key points, notable risks/issues, and any TODOs.\n${focus}\n\n---\n${sourceContent.slice(0, 30000)}`,
    'You are a senior engineer writing a summary for a teammate. Use bullet points. Vietnamese if the source is Vietnamese, English otherwise.',
    'summarize'
  )
  return { success: true, summary: result.content, sourcePaths: args.paths, sourceChars: sourceContent.length }
}

export async function synthesize(args: { sources: string[]; goal: string }): Promise<unknown> {
  if (!args.sources || args.sources.length === 0) return { error: 'sources[] is required' }
  if (!args.goal) return { error: 'goal is required' }

  // Each source can be a file path or inline text
  const parts: string[] = []
  for (let i = 0; i < args.sources.length; i++) {
    const src = args.sources[i]
    if (src.startsWith('/') || src.startsWith('./') || src.startsWith('../') || /^[a-z_]+\.(ts|tsx|js|md|py)$/i.test(src)) {
      // Looks like a file path
      try {
        const resolved = await resolveWithinWorkspace(src)
        const content = await fs.readFile(resolved, 'utf-8')
        parts.push(`=== Source ${i + 1}: ${src} ===\n${content.slice(0, 8000)}`)
      } catch {
        parts.push(`=== Source ${i + 1}: ${src} (FILE NOT FOUND — treating as inline) ===\n${src}`)
      }
    } else {
      parts.push(`=== Source ${i + 1} (inline) ===\n${src}`)
    }
  }

  const { callLLM } = await import('@/lib/llm')
  const result = await callLLM(
    `Synthesize the following sources into a single cohesive answer for this goal: "${args.goal}".
Identify conflicts between sources, open questions, and a recommended conclusion.

${parts.join('\n\n')}`,
    'You are a senior engineer synthesizing findings for a decision. Be honest about uncertainty. Vietnamese if the goal is Vietnamese, English otherwise.',
    'synthesize'
  )
  return { success: true, synthesis: result.content, sourcesCount: args.sources.length }
}

// ==================== P1: BACKGROUND PROCESS MANAGEMENT ====================

export async function runBg(args: { command: string; cwd?: string }): Promise<unknown> {
  if (!args.command) return { error: 'command is required' }
  const { processManager } = await import('@/lib/execution/process-manager')
  const root = process.env.OPENCODE_WORKSPACE || process.cwd()
  const cwd = args.cwd ? await resolveWithinWorkspace(args.cwd) : root
  const info = await processManager.startProcess({
    command: args.command,
    name: args.command.slice(0, 40),
    cwd,
  })
  return {
    success: true,
    processId: info.id,
    pid: info.pid,
    command: args.command,
    cwd: path.relative(root, cwd) || '.',
    message: `Background process started (id: ${info.id}, pid: ${info.pid ?? 'n/a'}). Use read_output to poll.`,
  }
}

export async function readOutput(args: { process_id?: string; list?: boolean; since_offset?: number }): Promise<unknown> {
  const { processManager } = await import('@/lib/execution/process-manager')

  if (args.list) {
    const all = await processManager.listProcesses()
    return {
      success: true,
      processes: all.map(p => ({ id: p.id, pid: p.pid, command: p.command, age: Date.now() - p.startedAt, status: p.status, exitCode: p.exitCode })),
      total: all.length,
    }
  }

  if (!args.process_id) return { error: 'process_id is required (or pass list:true)' }
  const output = await processManager.readProcessOutput(args.process_id, args.since_offset || 0)
  const trunc = truncateOutput(output.output, 30_000)
  return {
    success: true,
    processId: args.process_id,
    ...trunc,
    ended: output.ended,
    bytesRead: output.bytesRead,
    totalBytes: output.totalBytes,
  }
}

export async function killProcess(args: { process_id?: string; port?: number }): Promise<unknown> {
  const { processManager } = await import('@/lib/execution/process-manager')

  if (args.process_id) {
    const ok = await processManager.killProcess(args.process_id)
    return { success: ok, processId: args.process_id, message: ok ? 'killed' : 'process not found or already exited' }
  }

  if (args.port) {
    // Find process by port (lsof-like)
    try {
      const { stdout } = await execAsync(`lsof -ti:${args.port} || true`, { timeout: 5_000 })
      const pids = stdout.trim().split('\n').filter(Boolean)
      if (pids.length === 0) return { success: false, message: `no process listening on port ${args.port}` }
      for (const pid of pids) {
        try { process.kill(parseInt(pid), 'SIGTERM') } catch {}
      }
      return { success: true, port: args.port, killedPids: pids }
    } catch (e) {
      return { success: false, error: `could not find/kill process on port ${args.port}: ${e instanceof Error ? e.message : String(e)}` }
    }
  }

  return { error: 'Either process_id or port is required' }
}

// ==================== P1: MANAGE PACKAGES ====================

export async function managePackages(args: {
  action: 'add' | 'remove' | 'install' | 'update'
  packages?: string[]
  dev?: boolean
}): Promise<unknown> {
  const root = process.env.OPENCODE_WORKSPACE || process.cwd()
  const action = args.action
  const pkgs = args.packages || []

  let command: string
  if (action === 'add') {
    if (pkgs.length === 0) return { error: 'packages[] is required for add' }
    command = `bun add${args.dev ? ' -d' : ''} ${pkgs.join(' ')}`
  } else if (action === 'remove') {
    if (pkgs.length === 0) return { error: 'packages[] is required for remove' }
    command = `bun remove ${pkgs.join(' ')}`
  } else if (action === 'install') {
    command = 'bun install'
  } else if (action === 'update') {
    command = pkgs.length > 0 ? `bun update ${pkgs.join(' ')}` : 'bun update'
  } else {
    return { error: `Unknown action: ${action}` }
  }

  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd: root,
      timeout: 120_000, // 2 minutes — installs can be slow
      maxBuffer: 2 * 1024 * 1024,
    })
    return {
      success: true,
      command,
      output: (stdout + stderr).slice(0, 5000),
    }
  } catch (err: any) {
    return {
      success: false,
      command,
      error: `${action} failed: ${err.message}`,
      output: ((err.stdout || '') + (err.stderr || '')).slice(0, 3000),
    }
  }
}

// ==================== P2: GATEWAY TOOL PROXY ====================

/**
 * gateway_tool — proxy to one of the 36 gateway-bridge tools (port 18791).
 * This finally wires the dormant gateway catalog into the Code Team executor
 * (per the P0.5 plan in OPENCLAW_IMPLEMENTATION_PLAN.md).
 */
export async function gatewayTool(args: { name: string; args?: Record<string, unknown> }): Promise<unknown> {
  if (!args.name) return { error: 'name is required (one of the 36 gateway tools)' }
  const bridgeUrl = process.env.OPENCLAW_GATEWAY_URL
    ? 'http://127.0.0.1:18791' // gateway-bridge is always on 18791
    : 'http://127.0.0.1:18791'

  try {
    const res = await fetch(`${bridgeUrl}/tools/invoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: args.name, args: args.args || {} }),
      signal: AbortSignal.timeout(30_000),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => 'unknown')
      return { success: false, error: `gateway-bridge ${res.status}: ${text.slice(0, 200)}` }
    }
    const data = await res.json() as { ok?: boolean; result?: unknown; error?: { message: string } }
    if (!data.ok && data.error) {
      return { success: false, error: `Tool error: ${data.error.message}` }
    }
    return { success: true, tool: args.name, result: data.result ?? data }
  } catch (err) {
    return {
      success: false,
      error: `gateway-bridge unreachable (port 18791): ${err instanceof Error ? err.message : String(err)}. Ensure the app is running — gateway-bridge is auto-spawned.`,
    }
  }
}

// ==================== v2.1 Phase 1a: SHELL + TODO + (quality gate is in workflow-engine) ====================

/**
 * shell — Sandboxed bash with timeout + working-dir lock + structured receipt.
 *
 * Replaces 5 of v1's specialized tools (install_package, read_logs, lint,
 * type_check, db_query, env_update) — Claude Code/Z.ai Code pattern.
 *
 * Security:
 * - Refuse `sudo`, `rm -rf /`, fork bombs (`:(){ :|:& };:`), `dd of=/dev/`
 * - Working dir locked to OPENCODE_WORKSPACE (default process.cwd())
 * - 5min default timeout, max 10min, SIGTERM then SIGKILL after 5s grace
 * - stdout/stderr truncated to 30KB with `cursor` for next call
 * - Shell metacharacters ALLOWED (|, &&, ;, >) — needed for `npm run build && npm test`
 *
 * Feature flag: ENABLE_SHELL_TOOL (off by default per D11 principle)
 *
 * Returns (D2 structured receipt):
 *   { success, exit_code, stdout, stderr, duration_ms, truncated, cursor, cwd }
 */
export async function shell(args: {
  command: string
  cwd?: string
  timeout_ms?: number
  env?: Record<string, string>
  stdin?: string
}): Promise<unknown> {
  if (!args.command || typeof args.command !== 'string') {
    return { success: false, error: 'command is required (string)' }
  }

  const command = args.command
  const root = process.env.OPENCODE_WORKSPACE || process.cwd()
  const cwd = args.cwd ? path.resolve(root, args.cwd) : root
  // Guard: refuse cwd outside workspace root
  if (cwd !== root && !cwd.startsWith(root + path.sep)) {
    return { success: false, error: `cwd escapes workspace root: ${args.cwd}` }
  }

  // Guard: refuse dangerous commands
  const dangerousPatterns = [
    { pattern: /\bsudo\b/, reason: 'sudo is forbidden' },
    { pattern: /\brm\s+-rf\s+\/(\s|$)/, reason: 'rm -rf / is forbidden (refusing to nuke root)' },
    { pattern: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;/, reason: 'fork bomb detected' },
    { pattern: /\bdd\s+.*of=\/dev\//, reason: 'dd to /dev/ is forbidden' },
    { pattern: /\bmkfs\b/, reason: 'mkfs is forbidden' },
    { pattern: />\s*\/dev\/sd[a-z]/, reason: 'write to raw disk forbidden' },
  ]
  for (const { pattern, reason } of dangerousPatterns) {
    if (pattern.test(command)) {
      return { success: false, error: `Command refused: ${reason}` }
    }
  }

  // Timeout: 5min default, 10min max
  const timeoutMs = Math.min(Math.max(args.timeout_ms ?? 300_000, 1_000), 600_000)

  // Truncation budget
  const MAX_OUT = 30_000 // 30KB per stream

  return new Promise((resolve) => {
    const startedAt = Date.now()
    let stdoutBuf = ''
    let stderrBuf = ''
    let killed = false
    let timer: ReturnType<typeof setTimeout> | null = null
    let killTimer: ReturnType<typeof setTimeout> | null = null

    // Use spawn with shell:true to allow metacharacters (|, &&, ;, >)
    const child = spawn(command, {
      cwd,
      shell: true,
      env: { ...process.env, ...(args.env || {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    // Feed stdin if provided
    if (args.stdin && child.stdin) {
      child.stdin.write(args.stdin)
      child.stdin.end()
    } else if (child.stdin) {
      child.stdin.end()
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdoutBuf.length < MAX_OUT) {
        stdoutBuf += chunk.toString('utf-8').slice(0, MAX_OUT - stdoutBuf.length)
      }
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderrBuf.length < MAX_OUT) {
        stderrBuf += chunk.toString('utf-8').slice(0, MAX_OUT - stderrBuf.length)
      }
    })

    child.on('error', (err: Error) => {
      if (timer) clearTimeout(timer)
      resolve({
        success: false,
        exit_code: -1,
        stdout: stdoutBuf,
        stderr: stderrBuf + `\n[spawn error: ${err.message}]`,
        duration_ms: Date.now() - startedAt,
        truncated: false,
        cwd,
      })
    })

    child.on('close', (code: number | null) => {
      if (timer) clearTimeout(timer)
      if (killTimer) clearTimeout(killTimer)
      const durationMs = Date.now() - startedAt
      const stdoutTruncated = stdoutBuf.length >= MAX_OUT
      const stderrTruncated = stderrBuf.length >= MAX_OUT
      resolve({
        success: code === 0,
        exit_code: code ?? -1,
        stdout: stdoutBuf,
        stderr: stderrBuf,
        duration_ms: durationMs,
        truncated: stdoutTruncated || stderrTruncated,
        cursor: stdoutTruncated ? MAX_OUT : undefined,
        cwd,
        killed,
      })
    })

    // Timeout: SIGTERM, then SIGKILL after 5s grace
    timer = setTimeout(() => {
      killed = true
      try { child.kill('SIGTERM') } catch {}
      killTimer = setTimeout(() => {
        try { child.kill('SIGKILL') } catch {}
      }, 5_000)
    }, timeoutMs)
  })
}

/**
 * todoWrite — Claude Code-style in-flight task list (batch upsert).
 *
 * Wraps the existing createTask/updateTask functions with a simpler API
 * aligned to Claude Code's TodoWrite:
 *   - Pass an array of todos (with optional id for update, no id for create)
 *   - Returns the full ordered list after write
 *
 * Note on sessionId: the existing in-memory store is global (per-process).
 * SessionId scoping is reserved for Phase 5.6 (SQLite-backed session resume
 * with WorkflowSession table). For Phase 1a, sessionId is accepted but
 * currently unused — it is reserved for forward compatibility.
 *
 * Feature flag: ENABLE_TODO_TOOL (off by default per D11)
 */
/** Phase 1a.2 — todo_write (DB-backed, replaces globalThis.__devTasks)
 *
 * Both Code Team pipeline agents (workflow-engine runAgentStep) AND independent
 * agents invoked via /api/openclaw/chat (which calls executeTool directly) reach
 * this function. The sessionId scopes each conversation's todo list independently.
 *
 * Semantics (Claude Code-compatible):
 *   - If `id` provided  → update existing todo by primary key (404 if not found)
 *   - If `idempotencyKey` provided and exists → return existing (no duplicate)
 *   - Otherwise → create new
 *   - Max 200 todos per session (guard against runaway agents)
 *
 * Spec: docs/FULLSTACK_CAPABILITY_PLAN_V2.md Part 4 Phase 1a.2
 * Feature flag: ENABLE_TODO_TOOL (off by default per D11)
 */
export async function todoWrite(args: {
  sessionId?: string
  agentRole?: string
  todos: Array<{
    id?: string
    content: string
    status?: 'pending' | 'in_progress' | 'blocked' | 'completed' | 'failed'
    priority?: 'low' | 'medium' | 'high'
    parentId?: string
    idempotencyKey?: string
  }>
}): Promise<unknown> {
  if (!Array.isArray(args.todos) || args.todos.length === 0) {
    return { success: false, error: 'todos[] is required (non-empty array)' }
  }

  const sessionId = args.sessionId || 'default'
  const agentRole = args.agentRole || null

  // Guard against runaway agents trying to create thousands of todos
  const MAX_TODOS_PER_SESSION = 200
  const existingCount = await db.todo.count({ where: { sessionId } })
  const newCount = args.todos.filter(t => !t.id && !t.idempotencyKey).length
  if (existingCount + newCount > MAX_TODOS_PER_SESSION) {
    return {
      success: false,
      error: `Todo list cap exceeded: ${existingCount} existing + ${newCount} new > ${MAX_TODOS_PER_SESSION} max per session. Mark some todos as completed or remove stale ones first.`,
    }
  }

  const VALID_STATUS = new Set(['pending', 'in_progress', 'blocked', 'completed', 'failed'])
  const VALID_PRIORITY = new Set(['low', 'medium', 'high'])
  const upserted: Array<{ id: string; content: string; status: string; priority: string }> = []

  for (const t of args.todos) {
    if (!t.content || typeof t.content !== 'string') {
      return { success: false, error: 'Each todo needs a `content` string' }
    }
    if (t.status && !VALID_STATUS.has(t.status)) {
      return { success: false, error: `Invalid status: ${t.status}. Allowed: ${[...VALID_STATUS].join('|')}` }
    }
    if (t.priority && !VALID_PRIORITY.has(t.priority)) {
      return { success: false, error: `Invalid priority: ${t.priority}. Allowed: ${[...VALID_PRIORITY].join('|')}` }
    }

    // Update existing by ID
    if (t.id) {
      const updated = await db.todo.update({
        where: { id: t.id },
        data: {
          content: t.content,
          status: t.status || undefined,
          priority: t.priority || undefined,
          parentId: t.parentId || undefined,
        },
      }).catch(() => null)
      if (!updated) {
        return { success: false, error: `Todo not found: ${t.id}` }
      }
      upserted.push({
        id: updated.id,
        content: updated.content,
        status: updated.status,
        priority: updated.priority,
      })
      continue
    }

    // Idempotent create by idempotencyKey
    if (t.idempotencyKey) {
      const existing = await db.todo.findFirst({
        where: { sessionId, idempotencyKey: t.idempotencyKey },
      })
      if (existing) {
        upserted.push({
          id: existing.id,
          content: existing.content,
          status: existing.status,
          priority: existing.priority,
        })
        continue
      }
    }

    // Create new
    const created = await db.todo.create({
      data: {
        sessionId,
        agentRole,
        content: t.content,
        status: t.status || 'pending',
        priority: t.priority || 'medium',
        parentId: t.parentId || null,
        idempotencyKey: t.idempotencyKey || null,
      },
    })
    upserted.push({
      id: created.id,
      content: created.content,
      status: created.status,
      priority: created.priority,
    })
  }

  return {
    success: true,
    sessionId,
    upserted: upserted.length,
    todos: upserted,
  }
}

/** Phase 1a.2 — todo_read (DB-backed)
 *
 * Returns the current todo list for the given session, ordered by position
 * then createdAt. Also returns a status breakdown summary for quick stats.
 *
 * Feature flag: ENABLE_TODO_TOOL (off by default per D11)
 */
export async function todoRead(args: {
  sessionId?: string
  agentRole?: string
}): Promise<unknown> {
  const sessionId = args.sessionId || 'default'
  const where = args.agentRole
    ? { sessionId, agentRole: args.agentRole }
    : { sessionId }

  const todos = await db.todo.findMany({
    where,
    orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
  })

  const byStatus: Record<string, number> = {}
  for (const t of todos) {
    byStatus[t.status] = (byStatus[t.status] || 0) + 1
  }

  return {
    success: true,
    sessionId,
    total: todos.length,
    byStatus,
    todos: todos.map(t => ({
      id: t.id,
      content: t.content,
      status: t.status,
      priority: t.priority,
      parentId: t.parentId,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
    })),
  }
}

// ==================== PHASE 3: CODE INTELLIGENCE + MCP ====================
//
// Spec: docs/FULLSTACK_CAPABILITY_PLAN_V2.md Phase 3 (lines 223-242)
//   3.1 lsp_diagnostics  — alias to getDiagnostics (separate tool name per spec)
//   3.2 browser_screenshot — Playwright (lazy import) chromium
//   3.3 lint + type_check — structured ESLint JSON + tsc output parsers
//   3.4 test_coverage   — bun test --coverage parser
//   3.5 db_query        — Prisma $queryRawUnsafe + READ-ONLY guard
//
// All new tools gate behind per-tool feature flags (default false per spec Part 12).
// Pattern matches existing P0/P1 tools in this file (resolveWithinWorkspace,
// truncateOutput, try/catch with helpful error messages, Vietnamese descriptions).
// =====================================================================

/**
 * browser_screenshot — Phase 3.2 tool.
 *
 * Launches a headless chromium (via Playwright) and returns a base64 PNG of
 * the requested URL. Returns base64 (preferred for agent consumption) — no
 * filesystem cleanup headaches.
 *
 * Spec: docs/FULLSTACK_CAPABILITY_PLAN_V2.md Phase 3.2 (line 229)
 * Feature flag: ENABLE_BROWSER_SCREENSHOT (default false)
 */
export async function browserScreenshot(args: {
  url: string
  full_page?: boolean
  viewport_width?: number
  viewport_height?: number
  wait_until?: 'load' | 'domcontentloaded' | 'networkidle'
  wait_ms?: number
  selector?: string
}): Promise<unknown> {
  if (!args.url) {
    return { success: false, error: 'url is required' }
  }

  let parsedUrl: URL
  try {
    parsedUrl = new URL(args.url)
  } catch {
    return { success: false, error: `Invalid URL: ${args.url}` }
  }
  if (!/^https?:$/.test(parsedUrl.protocol)) {
    return { success: false, error: `Only http/https URLs are allowed (got ${parsedUrl.protocol})` }
  }

  const viewportWidth = Math.max(320, Math.min(4096, args.viewport_width || 1280))
  const viewportHeight = Math.max(240, Math.min(4096, args.viewport_height || 720))
  const waitUntil = args.wait_until || 'load'
  const waitMs = Math.max(0, Math.min(60_000, args.wait_ms || 0))
  const fullPage = args.full_page === true
  const selector = args.selector

  // Lazy import — keeps `bun install` time low if Playwright never used.
  let chromium: any
  try {
    const pw = await import('playwright')
    chromium = pw.chromium
  } catch (err: any) {
    return {
      success: false,
      error: `Playwright not available: ${err?.message || String(err)}. Run \`bun add playwright\` + \`bunx playwright install chromium\`.`,
    }
  }

  const startedAt = Date.now()
  let browser: any = null
  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    })
    const context = await browser.newContext({
      viewport: { width: viewportWidth, height: viewportHeight },
      userAgent: 'TMO-CodeTeam-Playwright/1.0 (+https://localhost)',
    })
    const page = await context.newPage()

    // Default 30s navigation timeout
    page.setDefaultNavigationTimeout(30_000)
    page.setDefaultTimeout(30_000)

    try {
      await page.goto(parsedUrl.toString(), { waitUntil, timeout: 30_000 })
    } catch (err: any) {
      return {
        success: false,
        error: `Navigation failed: ${err?.message || String(err)}`,
        url: args.url,
        durationMs: Date.now() - startedAt,
      }
    }

    if (waitMs > 0) {
      try {
        await page.waitForTimeout(waitMs)
      } catch { /* best-effort wait */ }
    }

    let base64: string
    let width = viewportWidth
    let height = viewportHeight

    if (selector) {
      // Element screenshot — clip to the locator's bounding box
      let locator
      try {
        locator = page.locator(selector).first()
        await locator.waitFor({ state: 'visible', timeout: 15_000 })
      } catch (err: any) {
        return {
          success: false,
          error: `Selector not found / not visible: ${selector} — ${err?.message || String(err)}`,
          url: args.url,
          durationMs: Date.now() - startedAt,
        }
      }
      const buf = await locator.screenshot({ type: 'png' })
      base64 = buf.toString('base64')
      try {
        const box = await locator.boundingBox()
        if (box) {
          width = Math.round(box.width)
          height = Math.round(box.height)
        }
      } catch { /* fall back to viewport dims */ }
    } else {
      const buf = await page.screenshot({ type: 'png', fullPage })
      base64 = buf.toString('base64')
      if (fullPage) {
        // Try to capture the actual full-page height (best-effort)
        try {
          height = await page.evaluate(() => Math.max(
            document.body.scrollHeight,
            document.documentElement.scrollHeight,
            document.body.offsetHeight,
            document.documentElement.offsetHeight,
          ))
        } catch { /* keep viewport height */ }
      }
    }

    return {
      success: true,
      url: args.url,
      base64,
      width,
      height,
      viewport: { width: viewportWidth, height: viewportHeight },
      fullPage,
      selector: selector || null,
      capturedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
    }
  } catch (err: any) {
    return {
      success: false,
      error: `browser_screenshot failed: ${err?.message || String(err)}`,
      url: args.url,
      durationMs: Date.now() - startedAt,
    }
  } finally {
    if (browser) {
      try { await browser.close() } catch { /* ignore */ }
    }
  }
}

/**
 * lint — Phase 3.3 tool.
 *
 * Runs ESLint with `--format json` and parses structured output. Caps result
 * list at `max_results` (default 100) to avoid blowing the LLM context budget.
 *
 * Spec: docs/FULLSTACK_CAPABILITY_PLAN_V2.md Phase 3.3 (line 230)
 * Feature flag: ENABLE_LINT (default false)
 */
export async function lint(args: {
  path?: string
  fix?: boolean
  max_results?: number
}): Promise<unknown> {
  const root = process.env.OPENCODE_WORKSPACE || process.cwd()
  const maxResults = Math.max(1, Math.min(1000, args.max_results || 100))
  const target = args.path || '.'

  // Resolve target within workspace (security: no traversal escapes)
  let targetPath = root
  if (args.path) {
    try {
      targetPath = await resolveWithinWorkspace(args.path)
    } catch (err: any) {
      return { success: false, error: `Path rejected: ${err?.message || String(err)}` }
    }
  }

  // Build ESLint argv (no shell — Phase 3 audit fix for shell-injection via path arg)
  // execFileAsync passes argv as array, bypassing shell parsing entirely.
  const argv = ['eslint', '--format', 'json']
  if (args.fix === true) argv.push('--fix')
  argv.push('--no-error-on-unmatched-pattern', targetPath)

  const startedAt = Date.now()
  let stdout = ''
  let stderr = ''
  let exitCode = 0

  try {
    const out = await execFileAsync('bunx', argv, {
      cwd: root,
      timeout: 120_000,
      maxBuffer: 10 * 1024 * 1024,
      shell: false, // explicit: never invoke shell — path arg safe
    })
    stdout = out.stdout || ''
    stderr = out.stderr || ''
  } catch (err: any) {
    // ESLint exits non-zero on lint errors — output is still JSON in stdout
    stdout = err.stdout || ''
    stderr = err.stderr || ''
    exitCode = err.code ?? 1
  }

  // Parse JSON output
  // eslint --format json emits an array of per-file result objects
  let parsed: Array<{
    filePath: string
    messages: Array<{
      ruleId: string | null
      severity: number  // 1=warning, 2=error
      message: string
      line: number | undefined
      column: number | undefined
      nodeType: string | undefined
    }>
    errorCount: number
    warningCount: number
    fixableErrorCount: number
    fixableWarningCount: number
  }> = []
  let parseError = ''
  try {
    // stdout may have leading warnings before the JSON array — extract first `[`
    const jsonStart = stdout.indexOf('[')
    if (jsonStart >= 0) {
      parsed = JSON.parse(stdout.slice(jsonStart))
    } else if (stdout.trim().startsWith('[')) {
      parsed = JSON.parse(stdout)
    } else {
      // No JSON output — likely config error
      parseError = 'No JSON output (ESLint config missing or invalid target)'
    }
  } catch (err: any) {
    parseError = `Failed to parse ESLint JSON output: ${err?.message || String(err)}`
  }

  // Flatten results into a single sorted array
  let totalErrors = 0
  let totalWarnings = 0
  const flat: Array<{
    file: string
    line: number | undefined
    column: number | undefined
    severity: 'error' | 'warning'
    ruleId: string | null
    message: string
  }> = []

  for (const r of parsed) {
    totalErrors += r.errorCount || 0
    totalWarnings += r.warningCount || 0
    for (const m of r.messages) {
      flat.push({
        file: r.filePath,
        line: m.line,
        column: m.column,
        severity: m.severity === 2 ? 'error' : 'warning',
        ruleId: m.ruleId,
        message: (m.message || '').slice(0, 300),
      })
    }
  }

  // Sort: errors first, then warnings; then by file:line
  flat.sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === 'error' ? -1 : 1
    if (a.file !== b.file) return a.file < b.file ? -1 : 1
    return (a.line || 0) - (b.line || 0)
  })

  const truncated = flat.length > maxResults
  const trimmed = flat.slice(0, maxResults)

  return {
    success: totalErrors === 0,
    errorCount: totalErrors,
    warningCount: totalWarnings,
    fixableErrorCount: parsed.reduce((s, r) => s + (r.fixableErrorCount || 0), 0),
    fixableWarningCount: parsed.reduce((s, r) => s + (r.fixableWarningCount || 0), 0),
    results: trimmed,
    truncated,
    totalCount: flat.length,
    durationMs: Date.now() - startedAt,
    exitCode,
    parseError: parseError || undefined,
    raw: (stdout + stderr).slice(0, 5000),
  }
}

/**
 * type_check — Phase 3.3 tool.
 *
 * Runs `tsc --noEmit` and parses output via existing parseTscOutput().
 * Returns per-file error list with TS codes — structured for agent consumption.
 *
 * Spec: docs/FULLSTACK_CAPABILITY_PLAN_V2.md Phase 3.3 (line 230)
 * Feature flag: ENABLE_TYPE_CHECK (default false)
 */
export async function typeCheck(args: { path?: string }): Promise<unknown> {
  const root = process.env.OPENCODE_WORKSPACE || process.cwd()
  const startedAt = Date.now()

  let stdout = ''
  let stderr = ''
  let exitCode = 0

  // tsc has no flag for a single file path with project tsconfig — we run
  // the whole project (--noEmit) which honours include/exclude in tsconfig.json.
  // For path-specific filtering we post-filter the parsed results.
  const cmd = 'bunx tsc --noEmit'

  try {
    const out = await execAsync(cmd, {
      cwd: root,
      timeout: 180_000,
      maxBuffer: 10 * 1024 * 1024,
    })
    stdout = out.stdout || ''
    stderr = out.stderr || ''
  } catch (err: any) {
    // tsc exits non-zero on errors — output (errors) is in stdout/stderr
    stdout = err.stdout || ''
    stderr = err.stderr || ''
    exitCode = err.code ?? 1
  }

  const output = stdout + stderr
  let diags = parseTscOutput(output)

  // Optional path filter — keep only diagnostics whose file path matches
  if (args.path) {
    const want = args.path.replace(/\/+$/, '')
    diags = diags.filter(d =>
      d.file === want ||
      d.file.endsWith('/' + want) ||
      d.file.endsWith(want)
    )
  }

  return {
    success: diags.length === 0,
    errorCount: diags.length,
    results: diags.map(d => ({
      file: d.file,
      line: d.line,
      col: d.col,
      severity: d.severity,
      code: d.code,
      message: d.message,
    })),
    durationMs: Date.now() - startedAt,
    exitCode,
    raw: output.slice(0, 5000),
  }
}

/**
 * test_coverage — Phase 3.4 tool.
 *
 * Runs `bun test --coverage` and parses the per-file coverage table that Bun
 * prints to stdout. Returns total + per-file coverage percentages and the
 * uncovered line ranges for each file.
 *
 * Spec: docs/FULLSTACK_CAPABILITY_PLAN_V2.md Phase 3.4 (line 231)
 * Feature flag: ENABLE_TEST_COVERAGE (default false)
 */
export async function testCoverage(args: {
  target?: string
  reporter?: 'text' | 'json'
}): Promise<unknown> {
  const root = process.env.OPENCODE_WORKSPACE || process.cwd()
  const startedAt = Date.now()
  const target = args.target || ''
  const wantJson = args.reporter === 'json'

  // bun test --coverage prints a table to stdout. --coverage-reporter=json
  // is NOT a stable Bun flag in all versions, so we parse the text table
  // regardless of `reporter` for now (json reporter is best-effort: pass the
  // flag through, fall back to text parsing).
  //
  // Build argv (no shell — Phase 3 audit fix for shell-injection via target arg)
  const argv = ['test', '--coverage']
  if (wantJson) argv.push('--coverage-reporter=json')
  if (target) argv.push(target)

  let stdout = ''
  let stderr = ''
  let exitCode = 0

  try {
    const out = await execFileAsync('bun', argv, {
      cwd: root,
      timeout: 300_000,  // 5 min — same as runTests
      maxBuffer: 10 * 1024 * 1024,
      shell: false, // explicit: never invoke shell — target arg safe
    })
    stdout = out.stdout || ''
    stderr = out.stderr || ''
  } catch (err: any) {
    stdout = err.stdout || ''
    stderr = err.stderr || ''
    exitCode = err.code ?? 1
  }

  const output = stdout + stderr
  const durationMs = Date.now() - startedAt

  // Try JSON parse first (when --coverage-reporter=json actually emits JSON)
  if (wantJson) {
    try {
      const jsonStart = output.indexOf('{')
      if (jsonStart >= 0) {
        // Find the matching closing brace (best-effort — slice to last `}`)
        const jsonEnd = output.lastIndexOf('}')
        if (jsonEnd > jsonStart) {
          const slice = output.slice(jsonStart, jsonEnd + 1)
          const data = JSON.parse(slice)
          return {
            success: true,
            source: 'json',
            totalCoverage: {
              functions: typeof data.functions === 'number' ? data.functions : null,
              lines: typeof data.lines === 'number' ? data.lines : null,
              branches: typeof data.branches === 'number' ? data.branches : null,
            },
            files: Array.isArray(data.files) ? data.files : [],
            durationMs,
            exitCode,
            raw: output.slice(0, 5000),
          }
        }
      }
    } catch {
      // fall through to text parsing
    }
  }

  // Text table parser — Bun's default coverage output looks like:
  //   file                         | % func   | % lines  | uncovered
  //   ----------------------------+----------+----------+------------------
  //   src/lib/foo.ts               | 100.00 % |  85.71 % | 12-14, 20
  //   ...
  //   ----------------------------+----------+----------+------------------
  //   all files                    |  90.00 % |  78.50 % |
  const lines = output.split('\n')
  const files: Array<{
    path: string
    functions: number | null
    lines: number | null
    branches: number | null
    uncoveredLines: Array<number[]>
  }> = []

  let totalFunc: number | null = null
  let totalLines: number | null = null
  let totalBranches: number | null = null

  // Match: <file> | NN.NN % | NN.NN % | NN.NN % | <uncovered>
  // Bun prints at minimum % funcs + % lines (no branches column if unsupported).
  const rowRegex = /^(.+?)\s*\|\s*(\d+(?:\.\d+)?)\s*%\s*\|\s*(\d+(?:\.\d+)?)\s*%\s*(?:\|\s*(\d+(?:\.\d+)?)\s*%)?\s*(?:\|\s*(.*?))?$/

  for (const line of lines) {
    const m = line.match(rowRegex)
    if (!m) continue
    const filePath = m[1].trim()
    if (!filePath || filePath.startsWith('-')) continue
    if (filePath.toLowerCase().includes('all files') || filePath.toLowerCase() === 'all files') {
      totalFunc = parseFloat(m[2])
      totalLines = parseFloat(m[3])
      totalBranches = m[4] ? parseFloat(m[4]) : null
      continue
    }
    // Filter out separator/header noise — only keep paths that look like files
    if (!/[\\/]/.test(filePath) && !/\.(ts|js|tsx|jsx|py)$/.test(filePath)) {
      continue
    }
    const uncoveredStr = (m[5] || '').trim()
    const uncoveredLines = parseUncoveredLines(uncoveredStr)
    files.push({
      path: filePath,
      functions: parseFloat(m[2]),
      lines: parseFloat(m[3]),
      branches: m[4] ? parseFloat(m[4]) : null,
      uncoveredLines,
    })
  }

  // If no total row was found, compute aggregate from per-file (rough — Bun's
  // aggregate uses statement-weighted averaging, which we can't replicate here)
  if (totalFunc === null && files.length > 0) {
    totalFunc = files.reduce((s, f) => s + (f.functions || 0), 0) / files.length
    totalLines = files.reduce((s, f) => s + (f.lines || 0), 0) / files.length
    const branchFiles = files.filter(f => f.branches !== null)
    totalBranches = branchFiles.length > 0
      ? branchFiles.reduce((s, f) => s + (f.branches || 0), 0) / branchFiles.length
      : null
  }

  // Detect test failures (Bun prints "X pass", "Y fail" summary)
  const failMatch = output.match(/(\d+)\s+fail/i)
  const testFailures = failMatch ? parseInt(failMatch[1]) : 0

  return {
    success: true,
    source: 'text',
    totalCoverage: {
      functions: totalFunc,
      lines: totalLines,
      branches: totalBranches,
    },
    files,
    testFailures,
    durationMs,
    exitCode,
    raw: output.slice(0, 5000),
  }
}

/** Parse Bun's uncovered-line notation: "12-14, 20, 25-30" → [[12,14],[20,20],[25,30]] */
function parseUncoveredLines(s: string): Array<number[]> {
  if (!s) return []
  const ranges: Array<number[]> = []
  for (const part of s.split(',')) {
    const trimmed = part.trim()
    if (!trimmed) continue
    const rangeMatch = trimmed.match(/^(\d+)\s*[-–]\s*(\d+)$/)
    if (rangeMatch) {
      ranges.push([parseInt(rangeMatch[1]), parseInt(rangeMatch[2])])
      continue
    }
    const singleMatch = trimmed.match(/^(\d+)$/)
    if (singleMatch) {
      const n = parseInt(singleMatch[1])
      ranges.push([n, n])
    }
  }
  return ranges
}

/**
 * db_query — Phase 3.5 tool.
 *
 * Read-only Prisma $queryRawUnsafe wrapper. Strict SQL validation rejects
 * any write/DDL operation, multi-statement injection, and forbidden pragmas.
 *
 * Spec: docs/FULLSTACK_CAPABILITY_PLAN_V2.md Phase 3.5 (line 232)
 * Feature flag: ENABLE_DB_QUERY (default false)
 *
 * SECURITY-CRITICAL: never relax this guard without a separate audit. The
 * whole point of this tool is to let agents inspect the SQLite buffer layer
 * without ever being able to mutate it.
 */
export async function dbQuery(args: {
  sql: string
  params?: any[]
  limit?: number
}): Promise<unknown> {
  if (!args.sql || typeof args.sql !== 'string') {
    return { success: false, error: 'sql (string) is required' }
  }

  const rawSql = args.sql
  const params = Array.isArray(args.params) ? args.params : []
  const requestedLimit = args.limit !== undefined
    ? Math.max(1, Math.min(1000, Math.floor(args.limit)))
    : 100
  const hardMax = 1000

  // ---------- READ-ONLY GUARD ----------
  // Strip comments (-- line comments, /* block comments */)
  const stripped = rawSql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .trim()

  const upper = stripped.toUpperCase()

  // Reject multi-statement: `;` followed by non-whitespace
  if (/;\s*\S/.test(stripped)) {
    return {
      success: false,
      error: 'SQL rejected by read-only guard: multi-statement queries are not allowed',
      sql: rawSql.slice(0, 500),
    }
  }

  // Forbidden write keywords — anywhere in the (comment-stripped) SQL.
  // Exception: `PRAGMA query_plan` (read-only EXPLAIN-style) is allowed.
  const writeKeywords = [
    'INSERT', 'UPDATE', 'DELETE', 'DROP', 'ALTER', 'TRUNCATE',
    'CREATE', 'GRANT', 'REVOKE', 'ATTACH', 'DETACH',
  ]
  for (const kw of writeKeywords) {
    // Word-boundary match to avoid false positives (e.g. column name containing "update")
    const re = new RegExp(`\\b${kw}\\b`)
    if (re.test(upper)) {
      return {
        success: false,
        error: `SQL rejected by read-only guard: write keyword "${kw}" is not allowed`,
        sql: rawSql.slice(0, 500),
      }
    }
  }

  // PRAGMA — only `PRAGMA <table>(<info>)` and `PRAGMA query_plan` are read-only
  // For simplicity here: reject ALL pragmas except `query_plan`.
  if (/\bPRAGMA\b/.test(upper) && !/\bQUERY_PLAN\b/.test(upper)) {
    return {
      success: false,
      error: 'SQL rejected by read-only guard: PRAGMA statements are not allowed (except PRAGMA query_plan)',
      sql: rawSql.slice(0, 500),
    }
  }

  // sqlite_master writes are guarded by the write-keyword check above — reads OK.

  // Apply LIMIT by wrapping the query. Only safe-wrap SELECT statements
  // (everything else should have been rejected above). Bun/SQLite accept
  // `SELECT * FROM (<original>) sub LIMIT N` for any SELECT, including those
  // with ORDER BY / LIMIT / OFFSET already (the inner LIMIT just gets
  // overridden by the outer one).
  let execSql = rawSql.trim().replace(/;+\s*$/, '')
  let wrapped = false
  if (/^\s*SELECT\b/i.test(execSql) && requestedLimit < hardMax) {
    execSql = `SELECT * FROM (${execSql}) sub LIMIT ${requestedLimit}`
    wrapped = true
  }

  const startedAt = Date.now()
  try {
    // Prisma's $queryRawUnsafe accepts the SQL string + positional params.
    // Type-cast to any[] because $queryRawUnsafe is variadic.
    const rows = await (db as any).$queryRawUnsafe(execSql, ...params)
    // Prisma returns BigInt for INTEGER columns when using raw queries —
    // JSON.stringify would throw on BigInt. Convert to Number where possible.
    const safeRows = JSON.parse(JSON.stringify(rows, (_k, v) =>
      typeof v === 'bigint' ? Number(v) : v
    )) as unknown[]

    const rowCount = Array.isArray(safeRows) ? safeRows.length : 0
    const truncated = rowCount >= requestedLimit

    return {
      success: true,
      rows: safeRows,
      rowCount,
      truncated,
      limit: requestedLimit,
      wrapped,
      durationMs: Date.now() - startedAt,
      sql: execSql,
    }
  } catch (err: any) {
    return {
      success: false,
      error: `db_query failed: ${err?.message || String(err)}`,
      sql: rawSql.slice(0, 500),
      durationMs: Date.now() - startedAt,
    }
  }
}
