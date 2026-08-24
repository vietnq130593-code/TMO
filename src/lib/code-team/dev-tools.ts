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

import { exec } from 'child_process'
import { promisify } from 'util'
import path from 'path'
import fs from 'fs/promises'
import { existsSync } from 'fs'

const execAsync = promisify(exec)

// ==================== SHARED HELPERS ====================

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
}): Promise<unknown> {
  const resolvedPath = await resolveWithinWorkspace(args.path)
  const original = await fs.readFile(resolvedPath, 'utf-8')

  // Batch mode: apply all edits atomically (all-or-nothing)
  const edits = args.edits
    ? args.edits
    : [{ old_str: args.old_str, new_str: args.new_str }]

  if (!args.edits && (!args.old_str || args.new_str === undefined)) {
    return { error: 'Either (old_str + new_str) or edits[] is required' }
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

  await fs.writeFile(resolvedPath, content, 'utf-8')
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
}): Promise<unknown> {
  const resolvedPath = await resolveWithinWorkspace(args.path)
  const root = process.env.OPENCODE_WORKSPACE || process.cwd()
  if (resolvedPath === root) {
    return { error: 'Refusing to delete the workspace root' }
  }

  if (!existsSync(resolvedPath)) {
    return { success: false, error: `Path does not exist: ${args.path}` }
  }

  const stat = await fs.stat(resolvedPath)
  const isDir = stat.isDirectory()

  if (isDir && !args.recursive) {
    return { error: 'Path is a directory — pass recursive:true to delete it' }
  }

  if (args.dry_run) {
    return { success: true, dryRun: true, wouldDelete: args.path, type: isDir ? 'directory' : 'file' }
  }

  if (isDir) {
    await fs.rm(resolvedPath, { recursive: true, force: true })
  } else {
    await fs.unlink(resolvedPath)
  }

  return { success: true, deleted: args.path, type: isDir ? 'directory' : 'file' }
}

/**
 * file_list — shallow directory listing / tree.
 * Returns typed entries with size + mtime. depth controls recursion.
 */
export async function fileList(args: {
  path?: string
  depth?: number
  ignore?: string[]
}): Promise<unknown> {
  const target = args.path || '.'
  const resolvedPath = await resolveWithinWorkspace(target)
  const maxDepth = Math.min(args.depth || 1, 5)
  const ignoreSet = new Set(args.ignore || ['node_modules', '.next', '.git', 'dist', 'build'])

  async function walk(dir: string, depth: number): Promise<Array<{ name: string; type: string; size: number; mtime: string }>> {
    if (depth > maxDepth) return []
    const entries = await fs.readdir(dir, { withFileTypes: true })
    const result: Array<{ name: string; type: string; size: number; mtime: string }> = []
    for (const entry of entries) {
      if (ignoreSet.has(entry.name)) continue
      const full = path.join(dir, entry.name)
      try {
        const stat = await fs.stat(full)
        result.push({
          name: entry.name,
          type: entry.isDirectory() ? 'dir' : 'file',
          size: stat.size,
          mtime: stat.mtime.toISOString(),
        })
        if (entry.isDirectory() && depth < maxDepth) {
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
}): Promise<unknown> {
  if (!args.pattern) return { error: 'pattern is required' }
  const searchRoot = args.path ? await resolveWithinWorkspace(args.path) : await resolveWithinWorkspace('.')
  const mode = args.mode || 'content'
  const contextLines = Math.min(args.context || 0, 5)
  const headLimit = Math.min(args.head_limit || 100, 500)

  let regex: RegExp
  try {
    regex = new RegExp(args.pattern, 'i')
  } catch (e) {
    return { error: `Invalid regex: ${e instanceof Error ? e.message : String(e)}` }
  }

  const ignoreDirs = new Set(['node_modules', '.next', '.git', 'dist', 'build'])
  const matches: Array<{ file: string; line: number; text: string; context?: string[] }> = []
  const fileMatches = new Set<string>()
  const fileMatchCounts = new Map<string, number>() // FIX: track per-file counts for count mode

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
        try {
          const content = await fs.readFile(full, 'utf-8')
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

  if (hasBunLock) {
    framework = 'bun'
    command = `bun test${args.target ? ` ${args.target}` : ''}${args.coverage ? ' --coverage' : ''}`
  } else if (deps.vitest || deps['@vitest/ui']) {
    framework = 'vitest'
    command = `npx vitest run${args.target ? ` ${args.target}` : ''}${args.coverage ? ' --coverage' : ''}`
  } else if (deps.jest) {
    framework = 'jest'
    command = `npx jest${args.target ? ` ${args.target}` : ''}${args.coverage ? ' --coverage' : ''}`
  } else if (hasPyproject) {
    framework = 'pytest'
    command = `pytest${args.target ? ` ${args.target}` : ''}${args.coverage ? ' --cov' : ''}`
  } else {
    // Default to bun (the project's primary runtime)
    framework = 'bun'
    command = `bun test${args.target ? ` ${args.target}` : ''}`
  }

  console.log(`[run_tests] Detected framework: ${framework} → ${command}`)

  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd: root,
      timeout: 5 * 60 * 1000, // 5 minutes
      maxBuffer: 5 * 1024 * 1024, // 5MB
      env: { ...process.env, CI: 'true' }, // CI=true disables watch mode + colors
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

/** Parse framework-specific test output for pass/fail counts + failure locations. */
function parseTestOutput(output: string, framework: string): { passed: number; failed: number; skipped: number; durationMs?: number; failures: Array<{ file: string; line?: number; message: string }> } {
  const failures: Array<{ file: string; line?: number; message: string }> = []
  let passed = 0, failed = 0, skipped = 0

  if (framework === 'bun') {
    // bun test: "(pass) test name", "(fail) test name", "(skip) test name"
    const passMatches = output.match(/\(pass\)/g) || []
    const failMatches = output.match(/\(fail\)/g) || []
    const skipMatches = output.match(/\(skip\)/g) || []
    passed = passMatches.length
    failed = failMatches.length
    skipped = skipMatches.length
    // Extract failure file:line from error stack lines
    const failBlocks = output.split(/\(fail\)/).slice(1)
    for (const block of failBlocks) {
      const stackLine = block.match(/([^\s]+\.(?:test|spec)\.[tj]sx?):(\d+):(\d+)/)
      const msg = block.split('\n').find(l => l.trim() && !l.includes('at '))?.trim().slice(0, 200) || 'test failed'
      failures.push({
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
    // Extract failure locations
    const failBlocks = output.split(/FAIL\s/).slice(1)
    for (const block of failBlocks) {
      const fileMatch = block.match(/^([^\s▲▼►◀]*\.(?:test|spec)\.[tj]sx?)/m)
      const lineMatch = block.match(/:(\d+):\d+/)
      const msg = block.split('\n')[0]?.trim().slice(0, 200) || 'test failed'
      failures.push({
        file: fileMatch?.[1] || 'unknown',
        line: lineMatch ? parseInt(lineMatch[1]) : undefined,
        message: msg,
      })
    }
  } else if (framework === 'pytest') {
    // pytest: "===== X passed, Y failed, Z skipped in N.Ns ====="
    const summary = output.match(/(\d+)\s+passed(?:,?\s*(\d+)\s+failed)?(?:,?\s*(\d+)\s+skipped)?/i)
    if (summary) {
      passed = parseInt(summary[1]) || 0
      failed = parseInt(summary[2]) || 0
      skipped = parseInt(summary[3]) || 0
    }
    // Extract failure file:line from "file.py:123: AssertionError"
    const failMatches = output.matchAll(/([^\s:]+\.py):(\d+):\s+(.+)/g)
    for (const m of failMatches) {
      failures.push({ file: m[1], line: parseInt(m[2]), message: m[3].slice(0, 200) })
    }
  }

  return { passed, failed, skipped, failures: failures.slice(0, 20) }
}

// ==================== P0: GIT COMMIT ====================

/**
 * git_commit — commit scoped paths with a message.
 * Refuses to commit if the message is empty. Does NOT push.
 */
export async function gitCommit(args: {
  message: string
  paths?: string[]  // if omitted, commits all staged + unstaged tracked changes (NOT untracked)
  all?: boolean     // also `git add` the paths first
}): Promise<unknown> {
  if (!args.message || !args.message.trim()) {
    return { error: 'Commit message is required (non-empty)' }
  }
  const root = process.env.OPENCODE_WORKSPACE || process.cwd()

  try {
    // Resolve + scope-check paths
    const resolvedPaths = args.paths
      ? await Promise.all(args.paths.map(p => resolveWithinWorkspace(p)))
      : []

    // Stage if requested
    if (args.all && resolvedPaths.length > 0) {
      await execAsync(`git add -- ${resolvedPaths.map(p => `"${path.relative(root, p)}"`).join(' ')}`, { cwd: root, timeout: 15_000 })
    } else if (args.all && !args.paths) {
      // `all` with no paths → add all tracked + untracked
      await execAsync('git add -A', { cwd: root, timeout: 15_000 })
    }

    // Build commit command (use a temp file for the message to avoid shell-escaping hell)
    const tmpFile = path.join(root, `.git/COMMIT_EDITMSG_${Date.now()}`)
    await fs.writeFile(tmpFile, args.message, 'utf-8')
    try {
      const pathArgs = resolvedPaths.length > 0
        ? ' -- ' + resolvedPaths.map(p => `"${path.relative(root, p)}"`).join(' ')
        : ''
      const { stdout, stderr } = await execAsync(
        `git commit -F "${path.relative(root, tmpFile)}"${pathArgs}`,
        { cwd: root, timeout: 30_000 }
      )
      // Get the new commit hash
      const { stdout: hashOut } = await execAsync('git rev-parse HEAD', { cwd: root, timeout: 5_000 })
      return {
        success: true,
        commit: hashOut.trim().slice(0, 12),
        message: args.message,
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
