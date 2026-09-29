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
import type { Dirent } from 'node:fs'
// Phase 1a.2 — DB-backed Todo store (replaces globalThis.__devTasks)
// Both Code Team agents AND independent agents share this table; sessionId scopes each list.
import { db } from '@/lib/db'
import { isFlagEnabled } from '@/lib/feature-flags'
import { getActiveRunId } from '@/lib/agent-run-tracker'
// TOMBSTONE GUARD (fix review 2026-09-08): chặn todo_write cho session đã xóa
import { isSessionDeleted } from '@/lib/session-tombstone'
// INFRA GUARD (Task 24, 2026-10-21; chính sách mới 2026-10-27 phiên 4): chặn
// agent sửa phần hạ tầng VẪN ĐƯỢC BẢO VỆ (.env/keys, db/ data files, .opencode,
// mini-services/, manifests/config). Từ 2026-10-27 agent ĐÃ ĐƯỢC PHÉP tự cài
// package (bun add qua shell/manage_packages) + tự sửa prisma/schema.prisma +
// chạy db push — các hạng mục đó KHÔNG còn bị chặn (xem protected-paths.ts).
import {
  guardShellCommand,
  isProtectedInfraPathSync,
  buildFileOpBlockedMessage,
  guardBridgeToolInvocation,
} from '@/lib/protected-paths'
// Phase 6/7 (rebuild) — workspace root now follows the USER's ACTIVE workspace
// (SQLite Workspace table) instead of process.cwd(); 5s cache.
import { resolveWorkspaceRoot } from './workspace-root'
// CI-3 B2+B3 (Task 13-b) — Kho Context: data layer recallContext (Qdrant
// semantic + SQL LIKE fallback trên TaskContextArchive) cho tool context_recall.
import { recallContext, MAX_RECALL_LIMIT } from '@/lib/context-store'

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
  const root = await resolveWorkspaceRoot()
  // FIX 2026-09-02 (push blocker — audit Omega E2E): normalize root TUYỆT ĐỐI
  // trước khi so. Trước đây nếu root là đường dẫn tương đối (env fallback
  // OPENCODE_WORKSPACE=".") thì resolved = path.resolve(...) luôn TUYỆT ĐỐI
  // trong khi startsWith(root + sep) so với prefix TƯƠNG ĐỐI "./" → không
  // bao giờ khớp → "Access denied: path escapes workspace root" oan MỌI path
  // → git_commit (scoped paths) bị chặn hoàn toàn → verify_and_push TỪ CHỐI
  // push. (workspace-root.ts đã normalize ở tầng resolver — đây là lớp
  // phòng thủ sâu thứ 2, fail-closed đúng nghĩa traversal thật.)
  const absRoot = path.resolve(root)
  const resolved = path.resolve(absRoot, filePath)
  // Allow the root itself OR anything nested under it
  if (resolved !== absRoot && !resolved.startsWith(absRoot + path.sep)) {
    throw new Error(`Access denied: path escapes workspace root (${filePath})`)
  }
  return resolved
}

/**
 * TASK 41 (fix "[FileSelect] read failed: /home/z/.tmo-harness/task-1.txt"):
 * Resolve path RAW của tool call → đường dẫn TUYỆT ĐỐI theo workspace root
 * THẬT mà server tools đang dùng (DB active workspace → OPENCODE_WORKSPACE →
 * cwd). Dùng cho Agent Activity Log + workflow SSE tool_call event để UI mở
 * ĐÚNG file agents vừa đụng tới — client không còn phải đoán abs path bằng
 * workspaceRoot localStorage (có thể lệch với root thật của server).
 *
 * Fail-open: path ngoài workspace / lỗi resolve → undefined (caller giữ hành
 * vi fallback cũ). KHÔNG throw — chỉ dùng cho hiển thị, không được phép làm
 * hỏng tool execution hay workflow emit.
 */
export async function resolveUiAbsPath(rawPath: string): Promise<string | undefined> {
  const p = typeof rawPath === 'string' ? rawPath.trim() : ''
  if (!p) return undefined
  try {
    return await resolveWithinWorkspace(p)
  } catch {
    return undefined
  }
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
  // INFRA GUARD (Task 24): chặn sửa file hạ tầng runtime (prisma/schema, .env,
  // .opencode bridges...) — agent cần thay đổi thì escalate cho operator.
  {
    const root = await resolveWorkspaceRoot()
    const verdict = isProtectedInfraPathSync(resolvedPath, root)
    if (verdict.protected) {
      return { success: false, error: buildFileOpBlockedMessage(verdict.matched || args.path), blocked: true, path: args.path }
    }
  }
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
      // FIX (2026-09-03, lượt quan sát agents 2 — E2E Run 4): 100% file_edit fail
      // vì LLM "bịa" old_str từ trí nhớ thay vì copy nguyên văn (quan sát: 10/11
      // call fail đều "0 matches") — error cũ KHÔNG cho nội dung file thật →
      // agent không có gì để copy, tiếp tục bịa ở call sau. Giờ kèm excerpt nội
      // dung thật (≤35 dòng đầu, cap 1200 ký tự) để agent copy chính xác + gợi ý
      // file_write overwrite cho thay đổi lớn. Excerpt nằm trong Error message
      // → executeTool catch → đẩy về agent như tool-result (self-correct 1 lượt).
      const lineCount = original.split('\n').length
      const excerpt = original.split('\n').slice(0, 35).join('\n').slice(0, 1200)
      throw new Error(
        `0 matches for old_str (length ${edit.old_str.length}). File hiện có ${lineCount} dòng — KHÔNG chứa chuỗi này (whitespace/indent phải khớp CHÍNH XÁC, copy nguyên văn). Phần đầu file THẬT hiện tại:\n---\n${excerpt}\n---\n→ Phát lại file_edit với old_str copy NGUYÊN VĂN từ file (hoặc file_read phần liên quan), hoặc dùng file_write mode=overwrite cho thay đổi lớn.`
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
 * file_write — Task 21-d: tạo file mới / ghi đè / nối tiếp (append).
 *
 * DÙNG CHO FILE LỚN: viết từng phần (mỗi lần ~200-400 dòng) — lần đầu
 * mode=overwrite, các lần sau mode=append. KHÔNG giới hạn độ dài content
 * (không truncate) — executor ghi nguyên văn ra đĩa.
 *
 * - Path resolve theo ACTIVE workspace root (resolveWithinWorkspace — giống
 *   file_edit/file_read), guard chặn path thoát workspace root.
 * - mode=overwrite: atomic write (temp file + rename — crash giữa chừng
 *   không phá file cũ). Từ chối content rỗng (tránh xoá nhầm nội dung file).
 * - mode=append: file chưa tồn tại → tạo mới (tiện continuation); content
 *   rỗng được phép (no-op, trả bytesWritten=0).
 * - create_dirs (default true): tự tạo parent directories.
 */
export async function fileWrite(args: {
  path: string
  content: string
  mode?: 'overwrite' | 'append'
  create_dirs?: boolean
}): Promise<unknown> {
  try {
    if (!args.path || typeof args.path !== 'string') {
      return { success: false, error: 'path là bắt buộc (đường dẫn file relative từ workspace root)' }
    }
    const mode = args.mode === 'append' ? 'append' : 'overwrite'
    const createDirs = args.create_dirs !== false // default true
    const content = typeof args.content === 'string' ? args.content : ''
    if (mode === 'overwrite' && content.length === 0) {
      return {
        success: false,
        error: 'content rỗng khi mode=overwrite sẽ XÓA sạch file — nếu muốn ghi tiếp hãy dùng mode:"append", nếu muốn xoá file hãy dùng file_delete.',
      }
    }

    const resolvedPath = await resolveWithinWorkspace(args.path)
    const root = await resolveWorkspaceRoot()
    // INFRA GUARD: chặn ghi đè file hạ tầng VẪN ĐƯỢC BẢO VỆ (2026-10-27: prisma/schema.prisma
    // giờ ĐƯỢC PHÉP sửa — agent tự chỉnh schema + db push theo chính sách tự phục vụ).
    {
      const verdict = isProtectedInfraPathSync(resolvedPath, root)
      if (verdict.protected) {
        return { success: false, error: buildFileOpBlockedMessage(verdict.matched || args.path), blocked: true, path: args.path }
      }
    }
    if (resolvedPath === root) {
      return { success: false, error: 'Refusing to write to the workspace root — path phải trỏ tới FILE, không phải thư mục gốc.' }
    }

    // Parent dirs (default tự tạo — thoải mái viết src/new-module/file.ts)
    if (createDirs) {
      await fs.mkdir(path.dirname(resolvedPath), { recursive: true })
    }

    const existed = await fs.access(resolvedPath).then(() => true).catch(() => false)

    if (mode === 'append') {
      // Append thuần — file không tồn tại → appendFile tự tạo mới (continuation-friendly)
      await fs.appendFile(resolvedPath, content, 'utf-8')
    } else {
      // Atomic overwrite: temp file trong cùng dir + rename (POSIX/NTFS atomic)
      const tmpPath = resolvedPath + `.tmp.${process.pid}.${Date.now()}`
      await fs.writeFile(tmpPath, content, 'utf-8')
      try {
        await fs.rename(tmpPath, resolvedPath)
      } catch (err) {
        await fs.unlink(tmpPath).catch(() => {})
        throw err
      }
    }

    let fileSize = 0
    try { fileSize = (await fs.stat(resolvedPath)).size } catch { /* just-wrote — ignore */ }

    return {
      success: true,
      path: args.path,
      mode,
      bytesWritten: Buffer.byteLength(content, 'utf-8'),
      fileExistedBefore: existed,
      fileSize,
      hint: mode === 'append' && fileSize > 0
        ? 'Đã nối tiếp. Tiếp tục append phần kế tiếp, hoặc file_read để kiểm tra.'
        : undefined,
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return {
      success: false,
      path: args.path,
      error: `file_write thất bại: ${msg}`,
      hint: /escapes workspace root/.test(msg)
        ? 'Path phải nằm TRONG workspace root (dùng đường dẫn relative, không ../).'
        : undefined,
    }
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
  const root = await resolveWorkspaceRoot()
  // INFRA GUARD: chặn xoá file/thư mục hạ tầng VẪN ĐƯỢC BẢO VỆ (2026-10-27: prisma/ đã
  // mở cho agent sửa schema — db/ data files vẫn bảo vệ tuyệt đối).
  {
    const verdict = isProtectedInfraPathSync(resolvedPath, root)
    if (verdict.protected) {
      return { success: false, error: buildFileOpBlockedMessage(verdict.matched || args.path), blocked: true, path: args.path }
    }
  }
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
    // Type đúng của readdir({ withFileTypes: true }) — tránh ReturnType<typeof fs.readdir>
    // (chọn nhầm overload encoding:'buffer' → Dirent<Buffer>)
    let entries: Dirent[]
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

  // Lượt quan sát 1 (2026-09-06): graceful ENOENT/ENOTDIR — agent hay list
  // đường dẫn chưa tồn tại (logs/ không có trong fresh clone) hoặc list trỏ
  // vào FILE thay vì dir (ecosystem.config.cjs) → trước đây throw error
  // ([ToolExecutor] Error executing file_list: ENOENT...) cháy cả tool call.
  // Giờ trả kết quả THÀNH CÔNG với danh sách rỗng + note rõ lý do — agent
  // đọc note và tự điều hướng (tạo dir / list thư mục cha) thay vì nhận lỗi.
  let entries: Array<{ name: string; type: string; size: number; mtime: string; symlink?: boolean }>
  try {
    entries = await walk(resolvedPath, 1)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code || ''
    const msg = err instanceof Error ? err.message : String(err)
    if (code === 'ENOENT') {
      return {
        success: true,
        path: target,
        entries: [],
        total: 0,
        note: `Thư mục "${target}" KHÔNG tồn tại trong workspace. Dùng file_list thư mục cha để xem cấu trúc thật, hoặc file_write để tạo đường dẫn này nếu bước công việc cần.`,
      }
    }
    if (code === 'ENOTDIR') {
      return {
        success: true,
        path: target,
        entries: [],
        total: 0,
        note: `"${target}" là FILE chứ không phải thư mục — dùng file_read để đọc nó, hoặc file_list thư mục cha.`,
      }
    }
    throw new Error(`file_list "${target}" lỗi: ${msg}`)
  }
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

  // FIX (E2E 2026-09-08): tách logic match 1 FILE riêng — trước đây scan() chỉ
  // readdir DIRECTORY; khi agent truyền path là FILE đơn (grep "export" trong
  // file.ts — cách dùng tự nhiên nhất) thì readdir(file) throw → catch →
  // trả 0 matches THẦM LẶNG (Omega E2E: grep 5-export file trả totalMatches=0,
  // phải mò sang file_read). Giờ: searchRoot là file → scan trực tiếp file đó.
  async function scanFile(full: string, rel: string): Promise<void> {
    // glob filter (simple * support)
    if (args.glob) {
      const globRe = new RegExp('^' + args.glob.replace(/\./g, '\\.').replace(/\*/g, '.*') + '$')
      if (!globRe.test(path.basename(rel))) return
    }
    // Phase 2.5 — skip binary files (NULL byte in first 8KB)
    if (await isBinaryMaybe(full)) return
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
            }
          }
        }
      }
    } catch { /* binary/unreadable — skip */ }
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
        await scanFile(full, rel)
        if (matches.length >= headLimit) return
      }
    }
  }

  // searchRoot là FILE đơn → scan file đó; là directory → scan đệ quy
  const rootStat = await fs.stat(searchRoot).catch(() => null)
  if (rootStat?.isFile()) {
    await scanFile(searchRoot, path.basename(searchRoot))
  } else {
    await scan(searchRoot, '')
  }
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
  const root = await resolveWorkspaceRoot()

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
    // 21-d FIX (audit 21-d phát hiện): nhánh bun trước đây dùng argv.slice(1)
    // làm runnerArgs — nhưng argv[0] của bun là 'test' (không phải 'bun'),
    // slice(1) làm MẤT chữ 'test' → chạy `bun math.test.ts` thay vì
    // `bun test math.test.ts` → "Cannot use test outside of the test runner".
    // Giờ: bun truyền nguyên argv ['test', target?] (pytest vẫn slice(1) vì
    // argv[0] là 'pytest' — trùng tên runner).
    const runner = framework === 'pytest' ? 'pytest'
      : framework === 'bun' ? 'bun'
      : 'npx'
    const runnerArgs = framework === 'pytest' ? argv.slice(1)
      : framework === 'bun' ? argv
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

  const root = await resolveWorkspaceRoot()

  try {
    // Resolve + scope-check paths (reject escapes)
    const resolvedPaths = args.paths
      ? await Promise.all(args.paths.map(p => resolveWithinWorkspace(p)))
      : []

    // Pre-flight: detect "nothing to commit" before running git add
    // FIX 2026-09-12 (review GĐ1 finding #16): mọi git call trong gitCommit chạy
    // qua execFileAsync('git', [argv...]) — argv array bypass shell hoàn toàn
    // (cùng pattern gitStatus/gitDiff/gitLog/gitBranch/gitClone của GĐ2 — Task 11-c).
    if (args.all && resolvedPaths.length > 0) {
      const relPaths = resolvedPaths.map(p => path.relative(root, p))
      const { stdout: porcelain } = await execFileAsync(
        'git',
        ['status', '--porcelain', '--', ...relPaths],
        { cwd: root, timeout: 10_000 }
      )
      if (!porcelain.trim()) {
        return { success: false, error: `Nothing to commit — paths have no changes: ${relPaths.join(', ')}` }
      }
    } else if (!args.paths || args.paths.length === 0) {
      // Commit-only path: check what's already staged
      const { stdout: staged } = await execFileAsync('git', ['diff', '--cached', '--name-only'], { cwd: root, timeout: 10_000 })
      if (!staged.trim()) {
        return { success: false, error: 'Nothing staged to commit. Pass paths + all=true to stage first, or stage manually with `git add`.' }
      }
    }

    // Stage if requested (scoped — only the explicitly-listed paths)
    // NOTE: dry_run skips staging entirely — it computes "would commit" via git status
    // so the index is left untouched (no persistent side-effects).
    if (!args.dry_run && args.all && resolvedPaths.length > 0) {
      const relPaths = resolvedPaths.map(p => path.relative(root, p))
      await execFileAsync('git', ['add', '--', ...relPaths], { cwd: root, timeout: 15_000 })
    }

    // Dry-run: do NOT stage, do NOT commit — show what WOULD be committed.
    // Uses `git status --porcelain` which reports both staged + unstaged changes per path.
    if (args.dry_run) {
      const relPaths = resolvedPaths.length > 0
        ? resolvedPaths.map(p => path.relative(root, p))
        : []
      let wouldCommitFiles: string[] = []
      if (relPaths.length > 0) {
        const { stdout: porcelain } = await execFileAsync(
          'git',
          ['status', '--porcelain', '--', ...relPaths],
          { cwd: root, timeout: 10_000 }
        )
        // Porcelain format: "XY path" where X=staged, Y=unstaged. We report any path with changes.
        wouldCommitFiles = porcelain.split('\n').filter(Boolean).map(l => l.slice(3).trim())
      } else {
        // No paths specified → report all currently-staged files
        const { stdout: staged } = await execFileAsync('git', ['diff', '--cached', '--name-only'], { cwd: root, timeout: 10_000 })
        wouldCommitFiles = staged.split('\n').filter(Boolean)
      }
      return {
        success: true,
        dryRun: true,
        message: args.message,
        wouldCommitFiles,
      }
    }

    // FIX 2026-09-12 (review GĐ1 finding #16): git commit chạy qua execFileAsync
    // argv-array — commit message là 1 argv element duy nhất (bypass shell hoàn
    // toàn, không cần shell-escaping hay temp file COMMIT_EDITMSG như trước —
    // message chứa nháy kép/nháy đơn/xuống dòng truyền verbatim qua execFile).
    // No pathArgs here — `git commit path1 path2` only commits those paths even if
    // other things are staged. We already scoped via `git add` above, so commit alone
    // is what we want (commit everything currently staged, which is exactly the paths added).
    const commitArgs = ['commit', '-m', args.message]
    if (args.no_verify) commitArgs.push('--no-verify')
    const { stdout, stderr } = await execFileAsync('git', commitArgs, { cwd: root, timeout: 30_000 })

    // Structured receipt: hash + branch + filesChanged[]
    const { stdout: hashOut } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: root, timeout: 5_000 })
    const { stdout: branchOut } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root, timeout: 5_000 }).catch(() => ({ stdout: 'unknown' }))
    const { stdout: filesOut } = await execFileAsync('git', ['show', '--stat', '--name-only', '--format=', 'HEAD'], { cwd: root, timeout: 10_000 })

    return {
      success: true,
      commitHash: hashOut.trim().slice(0, 12),
      branch: branchOut.trim(),
      message: args.message,
      filesChanged: filesOut.split('\n').filter(Boolean),
      output: (stdout + stderr).trim() || 'committed',
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

// ==================== P0.5: GIT PUSH / GIT PULL (remote ops) ====================
//
// User request 2026-08-29: agents (độc lập lẫn team) phải push/pull code được
// khi user yêu cầu. Token xác thực lấy từ GitHub Token Store (db/.github-token.json
// — token user nhập trong dialog "Pull Code từ GitHub" được tự động lưu) hoặc
// token embedded trong remote URL. Token KHÔNG BAO GIỜ ghi vào .git/config —
// push/fetch bằng URL one-shot rồi vứt bỏ.
//
// Feature flag: ENABLE_GIT_COMMIT (chung cho mọi git tool — operators tắt 1
// flag là tắt cả commit/push/pull).

/** Strip token từ URL https://token@host/... để log/return an toàn */
function stripTokenFromGitUrl(url: string): string {
  return url.replace(/^(https?:\/\/)[^@]+@/, '$1')
}

/** Xây URL kèm token để authenticate (one-shot, không lưu lại) */
function buildAuthedGitUrl(remoteUrl: string, token: string): string {
  const cleaned = remoteUrl.trim()
  if (/^git@/.test(cleaned) || /^file:\/\//.test(cleaned) || /^\/\//.test(cleaned)) {
    return cleaned // SSH / local path — không nhúng token
  }
  const stripped = cleaned.replace(/^(https?:\/\/)[^@]+@/, '$1')
  return token ? stripped.replace(/^(https?:\/\/)/, `$1${token}@`) : stripped
}

/** Trích token embedded từ remote URL (nếu có) */
function extractEmbeddedToken(remoteUrl: string): string | null {
  const m = remoteUrl.match(/^https?:\/\/([^@]+)@/)
  return m ? m[1] : null
}

interface RemoteGitStatus {
  isGitRepo: boolean
  branch: string
  remoteUrl: string // cleaned (không token) — an toàn hiển thị/trả receipt
  rawRemoteUrl: string // RAW (có thể chứa token nhúng) — CHỈ dùng extract token nội bộ, KHÔNG BAO GIỜ hiển thị/log/trả về client
  ahead: number
  behind: number
  uncommitted: string[]
  headCommit: string
}

/** Thăm dò trạng thái git của workspace root — dùng chung cho push/pull */
async function probeWorkspaceGit(root: string): Promise<RemoteGitStatus> {
  let isGitRepo = false
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: root, timeout: 5_000 })
    isGitRepo = stdout.trim() === 'true'
  } catch { isGitRepo = false }
  if (!isGitRepo) {
    return { isGitRepo: false, branch: '', remoteUrl: '', rawRemoteUrl: '', ahead: 0, behind: 0, uncommitted: [], headCommit: '' }
  }

  const branchOut = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root, timeout: 5_000 })
    .then(r => r.stdout.trim()).catch(() => '')
  const headOut = await execFileAsync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, timeout: 5_000 })
    .then(r => r.stdout.trim()).catch(() => '')
  const remoteOut = await execFileAsync('git', ['remote', 'get-url', 'origin'], { cwd: root, timeout: 5_000 })
    .then(r => r.stdout.trim()).catch(() => '')

  let ahead = 0
  let behind = 0
  if (remoteOut) {
    // So HEAD với upstream tracking branch (nếu có)
    const counts = await execFileAsync('git', ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}'], { cwd: root, timeout: 5_000 })
      .then(r => r.stdout.trim()).catch(() => '')
    const parts = counts.split(/\s+/).map(n => parseInt(n, 10))
    if (parts.length === 2 && !Number.isNaN(parts[0]) && !Number.isNaN(parts[1])) {
      ahead = parts[0] || 0
      behind = parts[1] || 0
    }
  }

  const statusOut = await execFileAsync('git', ['status', '--porcelain'], { cwd: root, timeout: 5_000 })
    .then(r => r.stdout).catch(() => '')
  const uncommitted = statusOut.split('\n').map(l => l.trim()).filter(Boolean)

  return {
    isGitRepo: true,
    branch: branchOut,
    remoteUrl: stripTokenFromGitUrl(remoteOut),
    // FIX 2026-09-11 (CI-6 review): giữ RAW URL để gitPush/gitPull trích được
    // token nhúng — trước đây strip quá sớm khiến tier "embedded" trong chuỗi
    // resolve (embedded > store > env) KHÔNG BAO GIỜ khớp → push/pull rơi
    // xuống env/store và fail khi không có 2 nguồn đó.
    rawRemoteUrl: remoteOut,
    ahead,
    behind,
    uncommitted,
    headCommit: headOut,
  }
}

// ==================== SMART BRANCH RESOLUTION (fix 2026-09-13) ====================
//
// User report: "agent push code tại workspace thành công nhưng không pull được
// về hệ thống vì pull nhánh master trong khi đấy phải pull nhánh main".
//
// Root cause: `git init` (không -b) mặc định tạo nhánh `master`, trong khi repo
// GitHub mặc định `main` (origin/HEAD → main) → workspace đứng ở nhánh `master`
// artifact: push đẩy code lên nhánh `master` LẠC LÕNG trên remote, còn pull về
// hệ thống (nhánh `main`) không bao giờ thấy code đó.
//
// Self-heal (chỉ khi agent KHÔNG chỉ định branch tường minh):
//   - local branch ≠ 'master' → giữ nguyên (feature branch workflow).
//   - local branch = 'master' (artifact git init) → hỏi nhánh mặc định remote
//     (git ls-remote --symref HEAD): nếu khác 'master' (thường 'main') →
//     `git branch -m master <default>` (rename an toàn — KHÔNG mất commit),
//     mọi push/pull sau đó TỰ ĐỘNG khớp nhánh mặc định remote.
//   - ls-remote fail (mạng/token) hoặc remote default cũng = 'master' →
//     fail-open: giữ 'master' như cũ (không chặn luồng).
//
// Trả { branch, remoteDefault, renamed, note } — note (nếu có) được ghép vào
// receipt để agent + user thấy việc đổi tên đã diễn ra.

async function resolveSmartBranch(
  root: string,
  localBranch: string,
  explicitBranch: string | undefined,
  authedUrl: string,
): Promise<{ branch: string; remoteDefault: string; renamed: boolean; note: string }> {
  const explicit = (explicitBranch || '').trim()
  // Agent chỉ định tường minh → tôn trọng tuyệt đối (không đụng)
  if (explicit) return { branch: explicit, remoteDefault: '', renamed: false, note: '' }

  // Unborn HEAD (repo chưa commit lần nào) → symbolic-ref cho TÊN nhánh thật
  // ('master' mặc định của git init) — rev-parse --abbrev-ref chỉ trả 'HEAD'.
  const unborn = !localBranch || localBranch === 'HEAD'
  let local = localBranch
  if (unborn) {
    local = await execFileAsync('git', ['symbolic-ref', '--short', 'HEAD'], { cwd: root, timeout: 5_000 })
      .then(r => String(r.stdout).trim()).catch(() => '')
  }
  // Không phải artifact 'master' → giữ branch local (feature branch workflow)
  if (!local || local !== 'master') {
    return { branch: localBranch, remoteDefault: '', renamed: false, note: '' }
  }

  // local = 'master' → hỏi nhánh mặc định của remote (authed URL one-shot)
  let remoteDefault = ''
  try {
    const { stdout } = await execFileAsync('git', ['ls-remote', '--symref', authedUrl, 'HEAD'], {
      cwd: root,
      timeout: 20_000,
    })
    const m = String(stdout).match(/ref:\s*refs\/heads\/(\S+)/)
    remoteDefault = m ? m[1] : ''
  } catch {
    remoteDefault = '' // fail-open — mạng/token lỗi không chặn push/pull
  }
  if (!remoteDefault || remoteDefault === 'master') {
    return { branch: localBranch, remoteDefault, renamed: false, note: '' }
  }

  // Self-heal: rename master → remoteDefault (an toàn: chỉ đổi tên ref).
  // - Đã có commit: `git branch -m` (KHÔNG dùng -M — nếu branch đích đã tồn tại,
  //   rename fail → fallback giữ 'master' + note hướng dẫn switch tay, không bao
  //   giờ đè branch sẵn có).
  // - Unborn HEAD (chưa commit): đổi qua symbolic-ref (branch -m cần branch tồn tại).
  let renamed = false
  try {
    if (unborn) {
      await execFileAsync('git', ['symbolic-ref', 'HEAD', `refs/heads/${remoteDefault}`], { cwd: root, timeout: 10_000 })
    } else {
      await execFileAsync('git', ['branch', '-m', 'master', remoteDefault], { cwd: root, timeout: 10_000 })
    }
    renamed = true
    console.log(`[SmartBranch] Workspace đứng ở nhánh 'master' (artifact git init) — đã đổi tên thành '${remoteDefault}' cho khớp nhánh mặc định remote`)
  } catch {
    renamed = false
  }
  return {
    branch: renamed ? remoteDefault : localBranch,
    remoteDefault,
    renamed,
    note: renamed
      ? `Đã tự đổi tên nhánh local 'master' → '${remoteDefault}' (khớp nhánh mặc định remote — 'master' là artifact mặc định của git init, không phải nhánh thật của repo)`
      : `Nhánh local đang là 'master' nhưng remote mặc định là '${remoteDefault}' — hãy switch: git_branch({action:"switch", name:"${remoteDefault}"}) rồi thao tác lại`,
  }
}

/**
 * gitPush — push commits local của ACTIVE WORKSPACE lên remote.
 *
 * Flow:
 *   1. Probe workspace git status (repo? branch? remote? ahead?)
 *   2. Resolve token: embedded trong remote URL > token đã lưu trong token store
 *      (token user nhập dialog Pull Code) > env GITHUB_TOKEN (nếu có)
 *   3. Push bằng URL one-shot kèm token — KHÔNG ghi token vào .git/config
 *
 * Args:
 *   branch       — branch cần push (default: branch hiện tại)
 *   remote       — tên remote (default: origin)
 *   force        — --force-with-lease (chỉ khi user/agent yêu cầu tường minh)
 *   set_upstream — --set-upstream (lần push đầu của branch mới)
 *   dry_run      — chỉ báo trạng thái, KHÔNG push
 */
export async function gitPush(args: {
  branch?: string
  remote?: string
  force?: boolean
  set_upstream?: boolean
  dry_run?: boolean
}): Promise<unknown> {
  const root = await resolveWorkspaceRoot()
  const status = await probeWorkspaceGit(root)

  if (!status.isGitRepo) {
    return {
      success: false,
      error: `Workspace (${root}) KHÔNG phải git repository. Hãy yêu cầu user đăng ký workspace là git repo, hoặc tự khởi tạo: shell({"command": "git init -b main && git remote add origin <url>"}) — rồi commit (git_commit) trước khi push.`,
    }
  }
  if (!status.remoteUrl) {
    return {
      success: false,
      error: `Git repo (${root}) chưa có remote 'origin'. Hãy thêm remote: shell({"command": "git remote add origin https://github.com/user/repo.git"}) — rồi push lại.`,
      branch: status.branch,
      headCommit: status.headCommit,
    }
  }

  const requestedBranch = (args.branch || '').trim() || status.branch // pre-smart (dry-run/upstream probe) — SMART BRANCH resolve sau khi có authedUrl
  const remoteName = (args.remote || 'origin').replace(/[^a-zA-Z0-9\-_\/\\.]/g, '') || 'origin'

  // Dry-run: báo trạng thái, không push
  if (args.dry_run) {
    return {
      success: true,
      dryRun: true,
      branch: requestedBranch,
      remote: status.remoteUrl,
      ahead: status.ahead,
      behind: status.behind,
      uncommittedCount: status.uncommitted.length,
      uncommitted: status.uncommitted.slice(0, 20),
      message: status.ahead > 0
        ? `${status.ahead} commit sẵn sàng push lên ${status.remoteUrl} (branch ${requestedBranch})`
        : 'Không có commit nào ahead của upstream — không cần push',
    }
  }

  // ── Lượt quan sát 4 (2026-09-04, user directive): PUSH ALLOWLIST ──
  // Chỉ push THẬT lên repo trong allowlist (mặc định TMO-backup). Workspace
  // hiện trỏ origin về repo TMO app — mọi push từ pipeline verify_and_push
  // hay agent gọi trực tiếp git_push sẽ bẩn repo app, vi phạm chỉ thị
  // "chỉ push TMO-backup". Chặn tại TẦNG TOOL (mọi đường gọi đều an toàn);
  // đổi remote workspace sang repo được phép hoặc set SD_PUSH_REMOTE_ALLOWLIST
  // để mở. Dry-run probe phía trên KHÔNG bị chặn (chỉ đọc).
  {
    const allowRaw = process.env.SD_PUSH_REMOTE_ALLOWLIST || 'TMO-backup'
    const allowlist = allowRaw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
    let targetUrl = status.remoteUrl || ''
    if (remoteName !== 'origin') {
      targetUrl = (await execFileAsync('git', ['remote', 'get-url', remoteName], { cwd: root, timeout: 5_000 })
        .then(r => r.stdout.trim())
        .catch(() => '')) || targetUrl
    }
    if (allowlist.length > 0 && !allowlist.some(a => targetUrl.toLowerCase().includes(a))) {
      console.warn(`[gitPush] ✘ CHẶN theo allowlist — remote "${targetUrl}" không nằm trong SD_PUSH_REMOTE_ALLOWLIST ("${allowRaw}") — commit giữ local (user directive 2026-09-04: chỉ push TMO-backup)`)
      return {
        success: false,
        blocked: true,
        error: `Push CHẶN theo allowlist: remote "${targetUrl}" không nằm trong SD_PUSH_REMOTE_ALLOWLIST (${allowRaw}) — user directive 2026-09-04: chỉ push TMO-backup. Commit giữ local trong workspace; đổi remote sang repo được phép để push thật.`,
        branch: status.branch,
        headCommit: status.headCommit,
      }
    }
  }

  if (status.ahead === 0 && status.uncommitted.length === 0) {
    // Có thể chưa có upstream tracking — vẫn thử push (branch mới)
    const hasUpstream = await execFileAsync('git', ['config', `branch.${requestedBranch}.remote`], { cwd: root, timeout: 5_000 })
      .then(r => !!r.stdout.trim()).catch(() => false)
    if (hasUpstream) {
      return {
        success: true,
        pushed: false,
        upToDate: true,
        branch: requestedBranch,
        remote: status.remoteUrl,
        message: 'Không có gì để push — branch đã đồng bộ với remote',
      }
    }
  }

  // Resolve authentication token: embedded > saved store > env
  // FIX 2026-09-11: trích token từ RAW remote URL (probeWorkspaceGit đã strip
  // remoteUrl cho an toàn hiển thị — dùng rawRemoteUrl cho tier embedded)
  const embedded = extractEmbeddedToken(status.rawRemoteUrl || status.remoteUrl)
  const { getSavedGithubToken, saveGithubToken } = await import('@/lib/github-token-store')
  const savedToken = getSavedGithubToken()
  const envToken = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || ''
  const token = embedded || savedToken || envToken || ''

  // FIX 2026-09-11 (CI-6 E2E): token embedded sắp bị clean khỏi .git/config
  // (bước safety bên dưới) → LƯU VÀO TOKEN STORE (0600) để các lần push/pull
  // sau (kể cả pull_verify ngay sau push) vẫn xác thực được qua tier store.
  // Không giảm an toàn: token vốn đã nằm trong .git/config (world-readable
  // hơn file 0600); store là vị trí chuẩn theo thiết kế.
  if (embedded && embedded !== savedToken) {
    try {
      saveGithubToken(embedded)
      console.log('[gitPush] Embedded token → đã lưu vào token store (db/.github-token.json, 0600)')
    } catch (saveErr) {
      console.warn('[gitPush] Không lưu được token vào store:', saveErr instanceof Error ? saveErr.message : String(saveErr))
    }
  }

  const authedUrl = buildAuthedGitUrl(status.remoteUrl, token)

  // SMART BRANCH (fix 2026-09-13): workspace đứng ở nhánh 'master' (artifact
  // git init) trong khi remote mặc định 'main' → push lên nhánh LẠC LÕNG, hệ
  // thống pull 'main' không bao giờ thấy code. Self-heal: rename local cho
  // khớp nhánh mặc định remote rồi push đúng nhánh (chỉ khi agent KHÔNG chỉ
  // định branch tường minh).
  const smart = await resolveSmartBranch(root, status.branch, args.branch, authedUrl)
  const branch = smart.branch

  const pushArgs = ['push', authedUrl, branch]
  if (args.force) pushArgs.push('--force-with-lease')
  if (args.set_upstream) pushArgs.push('--set-upstream')

  console.log(`[gitPush] Pushing ${branch} → ${stripTokenFromGitUrl(status.remoteUrl)} (token: ${token ? 'yes' : 'no'})`)

  try {
    const { stdout, stderr } = await execFileAsync('git', pushArgs, { cwd: root, timeout: 120_000 })
    const afterOut = await execFileAsync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, timeout: 5_000 })
      .then(r => r.stdout.trim()).catch(() => status.headCommit)

    // Bảo vệ: nếu push qua URL one-shot, đảm bảo remote 'origin' config KHÔNG chứa token
    const remoteNow = await execFileAsync('git', ['remote', 'get-url', remoteName], { cwd: root, timeout: 5_000 })
      .then(r => r.stdout.trim()).catch(() => '')
    if (remoteNow && extractEmbeddedToken(remoteNow)) {
      await execFileAsync('git', ['remote', 'set-url', remoteName, stripTokenFromGitUrl(remoteNow)], { cwd: root, timeout: 5_000 }).catch(() => {})
      console.log('[gitPush] Cleaned embedded token from .git/config (safety)')
    }

    // FIX 2026-09-11 (review #3 MEDIUM): push qua one-shot URL KHÔNG cập nhật
    // refs/remotes/origin/<branch> → tracking ref stale mãi (ahead/behind sai,
    // verify_and_push lặp push dư). Fetch + update-ref để tracking phản ánh đúng.
    await execFileAsync('git', ['fetch', authedUrl, branch], { cwd: root, timeout: 60_000 })
      .then(() => execFileAsync('git', ['update-ref', `refs/remotes/${remoteName}/${branch}`, 'FETCH_HEAD'], { cwd: root, timeout: 5_000 }))
      .catch(() => {}) // best-effort — tracking stale không làm hỏng push đã thành công

    // FIX 2026-09-11 (review #3): "pushed" phải phản ánh kết quả THẬT —
    // "Everything up-to-date" nghĩa là KHÔNG có commit mới nào được đẩy lên
    const combined = `${stdout || ''}\n${stderr || ''}`
    const upToDate = /Everything up-to-date/i.test(combined)

    return {
      success: true,
      pushed: !upToDate,
      upToDate,
      branch,
      remote: status.remoteUrl,
      ...(smart.note ? { branchAligned: smart.note } : {}),
      beforeCommit: status.headCommit,
      afterCommit: afterOut,
      commitsPushed: upToDate ? 0 : (status.ahead || 'unknown'),
      authenticated: !!token,
      output: (token ? combined.split(token).join('****') : combined).trim().slice(0, 2000),
    }
  } catch (err: any) {
    const { stdout, stderr } = err
    const raw = ((stdout || '') + (stderr || '')).trim()
    const output = token ? raw.split(token).join('****') : raw // mask token trong output

    let hint = ''
    if (/Authentication failed|could not read Username|403/.test(raw)) {
      hint = 'Xác thực thất bại — chưa có token hợp lệ. Hãy nhờ user nhập GitHub PAT trong dialog "Pull Code từ GitHub" (token được lưu tự động, git_push sẽ dùng lại), hoặc set env GITHUB_TOKEN.'
    } else if (/non-fast-forward|fetch first|rejected/.test(raw) && !args.force) {
      hint = 'Remote có commit mới hơn — hãy git_pull trước rồi push lại, hoặc dùng force:true (--force-with-lease) nếu chắc chắn ghi đè.'
    } else if (/Repository not found|does not appear to be a repository/i.test(raw)) {
      hint = `Không tìm thấy repository ${status.remoteUrl} — kiểm tra URL remote và quyền truy cập của token.`
    }

    return {
      success: false,
      // FIX 2026-09-11 (review #1 HIGH): err.message chứa FULL command line kèm
      // authed URL (có token) → mask token trong error như đã làm với output
      error: `git push failed: ${token ? String(err.message).split(token).join('****') : err.message}`,
      hint,
      branch,
      remote: status.remoteUrl,
      output: output.slice(0, 2000),
    }
  }
}

/**
 * gitPull — pull code từ remote về ACTIVE WORKSPACE (an toàn cho thay đổi local).
 *
 * Flow:
 *   1. Probe workspace git status
 *   2. Fetch từ remote (URL one-shot kèm token nếu có)
 *   3. Merge fast-forward-only: KHÔNG đụng uncommitted changes, KHÔNG tạo
 *      merge commit. Nếu local diverge → trả lỗi kèm hướng dẫn (agent có thể
 *      git_commit local trước, hoặc force:true để hard-reset theo remote).
 *   4. force:true → git reset --hard FETCH_HEAD (PHÁ HỦY local changes — opt-in tường minh)
 *
 * Args:
 *   branch — branch cần pull (mặc định: nhánh hiện tại; SMART BRANCH — nếu nhánh
 *            hiện tại là 'master' (artifact git init) mà remote mặc định 'main'
 *            → tự rename local cho khớp rồi pull đúng nhánh)
 *   remote — tên remote (default: origin)
 *   force  — hard-reset về FETCH_HEAD, discard mọi thay đổi local
 *   dry_run — fetch + báo cáo khác biệt, KHÔNG apply
 */
export async function gitPullWorkspace(args: {
  branch?: string
  remote?: string
  force?: boolean
  dry_run?: boolean
}): Promise<unknown> {
  const root = await resolveWorkspaceRoot()
  const status = await probeWorkspaceGit(root)

  if (!status.isGitRepo) {
    return {
      success: false,
      error: `Workspace (${root}) KHÔNG phải git repository. Hãy yêu cầu user đăng ký workspace là git repo, hoặc tự khởi tạo: shell({"command": "git init -b main && git remote add origin <url>"}) — rồi pull lại.`,
    }
  }

  // Remote URL: dùng remoteName config nếu có, fallback origin
  const remoteName = (args.remote || 'origin').replace(/[^a-zA-Z0-9\-_\/\.]/g, '') || 'origin'
  let remoteUrl = status.remoteUrl
  // FIX 2026-09-11: giữ RAW URL (có thể chứa token nhúng) để extract token —
  // trước đây extractEmbeddedToken nhận URL ĐÃ STRIP → tier embedded never fires
  let rawRemoteUrl = status.rawRemoteUrl || status.remoteUrl
  if (remoteName !== 'origin' && status.isGitRepo) {
    const rawOut = await execFileAsync('git', ['remote', 'get-url', remoteName], { cwd: root, timeout: 5_000 })
      .then(r => r.stdout.trim()).catch(() => '')
    rawRemoteUrl = rawOut
    remoteUrl = stripTokenFromGitUrl(rawOut)
  }
  if (!remoteUrl) {
    return {
      success: false,
      error: `Git repo (${root}) chưa có remote '${remoteName}'. Hãy thêm: shell({"command": "git remote add origin https://github.com/user/repo.git"})`,
      branch: status.branch,
    }
  }

  // Resolve token như gitPush
  const embedded = extractEmbeddedToken(rawRemoteUrl)
  const { getSavedGithubToken } = await import('@/lib/github-token-store')
  const savedToken = getSavedGithubToken()
  const envToken = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || ''
  const token = embedded || savedToken || envToken || ''

  const authedUrl = buildAuthedGitUrl(remoteUrl, token)

  // SMART BRANCH (fix 2026-09-13): workspace đứng ở nhánh 'master' (artifact
  // git init) trong khi remote mặc định 'main' → pull nhánh LẠC LÕNG không có
  // code mới. Self-heal: rename local cho khớp nhánh mặc định remote rồi pull
  // đúng nhánh (chỉ khi agent KHÔNG chỉ định branch tường minh).
  const smart = await resolveSmartBranch(root, status.branch, args.branch, authedUrl)
  const branch = smart.branch

  // 1. Fetch
  try {
    await execFileAsync('git', ['fetch', authedUrl, branch], { cwd: root, timeout: 120_000 })
  } catch (err: any) {
    const raw = ((err.stdout || '') + (err.stderr || '')).trim()
    const output = token ? raw.split(token).join('****') : raw
    let hint = ''
    if (/Authentication failed|could not read Username|403/.test(raw)) {
      hint = 'Xác thực thất bại — chưa có token hợp lệ. Hãy nhờ user nhập GitHub PAT trong dialog "Pull Code từ GitHub" (token được lưu tự động).'
    } else if (/Repository not found|does not appear to exist/i.test(raw)) {
      hint = `Không tìm thấy repository — kiểm tra URL remote: ${remoteUrl}`
    } else if (/couldn't find remote ref|not a valid ref|couldn't find/i.test(raw)) {
      hint = `Không tìm thấy nhánh '${branch}' trên remote — kiểm tra tên nhánh (nhánh mặc định remote có thể khác, vd 'main' thay vì 'master'), hoặc git_pull({dry_run:true}) để khảo sát.`
    }
    // FIX 2026-09-11 (review #1 HIGH): mask token trong error message (authed URL leak)
    return { success: false, error: `git fetch failed: ${token ? String(err.message).split(token).join('****') : err.message}`, hint, remote: remoteUrl, branch, output: output.slice(0, 2000) }
  }

  // 2. So sánh HEAD vs FETCH_HEAD
  const countOut = await execFileAsync('git', ['rev-list', '--left-right', '--count', 'HEAD...FETCH_HEAD'], { cwd: root, timeout: 5_000 })
    .then(r => r.stdout.trim()).catch(() => '')
  const parts = countOut.split(/\s+/).map(n => parseInt(n, 10))
  const aheadLocal = parts[0] || 0
  const behindRemote = parts[1] || 0
  const fetchHeadShort = await execFileAsync('git', ['rev-parse', '--short', 'FETCH_HEAD'], { cwd: root, timeout: 5_000 })
    .then(r => r.stdout.trim()).catch(() => '')

  // Files sẽ thay đổi (cho dry-run report)
  const diffFiles = await execFileAsync('git', ['diff', '--name-only', 'HEAD..FETCH_HEAD'], { cwd: root, timeout: 10_000 })
    .then(r => r.stdout.split('\n').map(l => l.trim()).filter(Boolean)).catch(() => [] as string[])

  if (args.dry_run) {
    return {
      success: true,
      dryRun: true,
      branch,
      remote: remoteUrl,
      headCommit: status.headCommit,
      fetchHead: fetchHeadShort,
      ahead: aheadLocal,
      behind: behindRemote,
      filesToChange: diffFiles.slice(0, 50),
      uncommittedCount: status.uncommitted.length,
      ...(smart.note ? { note: smart.note } : {}),
      message: behindRemote > 0
        ? `${behindRemote} commit mới trên remote (${diffFiles.length} file sẽ thay đổi)`
        : 'Đã là phiên bản mới nhất',
    }
  }

  // Unborn HEAD (workspace chưa commit lần nào): rev-list HEAD...FETCH_HEAD
  // FAIL → behindRemote false 0 → KHÔNG được early-return "đã cập nhật" —
  // phải đi tiếp tới ff-merge (git merge --ff-only trên unborn HEAD hoạt động
  // và bootstrap nội dung đầu tiên — đã kiểm chứng sandbox 2026-09-13).
  const unborn = !status.branch || status.branch === 'HEAD'

  if (behindRemote === 0 && !args.force && !unborn) {
    return {
      success: true,
      upToDate: true,
      branch,
      remote: remoteUrl,
      headCommit: status.headCommit,
      ...(smart.note ? { note: smart.note } : {}),
      message: 'Đã là phiên bản mới nhất — không có gì để pull',
    }
  }

  // 3. Apply: force → hard reset; mặc định → ff-only merge
  if (args.force) {
    try {
      await execFileAsync('git', ['reset', '--hard', 'FETCH_HEAD'], { cwd: root, timeout: 30_000 })
      const after = await execFileAsync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, timeout: 5_000 })
        .then(r => r.stdout.trim()).catch(() => '')
      return {
        success: true,
        forced: true,
        branch,
        remote: remoteUrl,
        beforeCommit: status.headCommit,
        afterCommit: after,
        filesChanged: diffFiles.slice(0, 100),
        message: `Hard-reset ${branch} về ${after} theo remote (local changes đã bị discard)`,
      }
    } catch (err: any) {
      return { success: false, error: `git reset --hard failed: ${err.message}`, branch, remote: remoteUrl }
    }
  }

  try {
    // Cảnh báo uncommitted changes có thể cản trở checkout
    const blockingFiles = status.uncommitted
      .map(l => l.replace(/^..\s+/, '').replace(/^"|"$/g, ''))
      .filter(f => diffFiles.includes(f))

    await execFileAsync('git', ['merge', '--ff-only', 'FETCH_HEAD'], { cwd: root, timeout: 60_000 })
    const after = await execFileAsync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, timeout: 5_000 })
      .then(r => r.stdout.trim()).catch(() => '')

    return {
      success: true,
      branch,
      remote: remoteUrl,
      beforeCommit: status.headCommit,
      afterCommit: after,
      filesChanged: diffFiles.slice(0, 100),
      localCommitsPreserved: aheadLocal,
      message: `Fast-forward ${status.headCommit} → ${after} (${diffFiles.length} file cập nhật)`,
      ...((blockingFiles.length > 0 || smart.note)
        ? { note: [blockingFiles.length > 0 ? `Có ${blockingFiles.length} file vừa được pull cũng đang modified local — check git status` : '', smart.note].filter(Boolean).join(' | ') }
        : {}),
    }
  } catch (err: any) {
    const raw = ((err.stdout || '') + (err.stderr || '')).trim()
    const output = token ? raw.split(token).join('****') : raw
    let hint = ''
    if (/Not possible to fast-forward|divergent branches/i.test(raw)) {
      hint = `Local diverge với remote (local ahead ${aheadLocal}). Hãy git_commit thay đổi local trước rồi thử lại, hoặc dùng force:true để hard-reset theo remote (DISCARD local).`
    } else if (/would be overwritten|local changes/i.test(raw)) {
      hint = 'Có uncommitted changes cản trở merge — hãy git_commit/stash trước, hoặc force:true để discard.'
    }
    return {
      success: false,
      // FIX 2026-09-11 (review #1 HIGH): mask token trong error message (authed URL leak)
      error: `git pull (ff-only) failed: ${token ? String(err.message).split(token).join('****') : err.message}`,
      hint,
      branch,
      remote: remoteUrl,
      uncommittedCount: status.uncommitted.length,
      output: output.slice(0, 2000),
    }
  }
}

// ==================== CI-6 / CI-4 (Task 10-b): OPEN WORKSPACE IN EXPLORER ====================
//
// Roadmap CI-6.3 (docs/CODE_EXECUTION_IMPROVEMENT_ROADMAP.md): agent phải mở
// được thư mục workspace trên máy người dùng — File Explorer (Windows),
// Finder (macOS), xdg-open (Linux) — hoặc VS Code khi editor='vscode'.
//
// Người gọi: tool open_workspace (tool-executor) + ensureDefaultWorkspace
// (bootstrap lúc boot — lazy import để không kéo cả dev-tools vào boot path).
//
// Receipt-based KHÔNG throw: mọi nhánh lỗi (thư mục không tồn tại, binary
// không có trên máy) đều trả { success: false, error, message } tiếng Việt.

/** Receipt mở workspace — shape thống nhất cho tool + bootstrap */
export interface WorkspaceOpenReceipt {
  success: boolean
  opened: boolean
  rootPath: string
  /** Lệnh/launcher đã dùng (explorer.exe | open | xdg-open | vscode (code) | none) */
  method: string
  editor?: 'explorer' | 'vscode'
  message: string
  error?: string
}

export async function openWorkspaceInExplorer(
  rootPath: string,
  editor?: 'explorer' | 'vscode',
): Promise<WorkspaceOpenReceipt> {
  // Validate: đường dẫn trống
  if (!rootPath || typeof rootPath !== 'string' || !rootPath.trim()) {
    return {
      success: false,
      opened: false,
      rootPath: String(rootPath ?? ''),
      method: 'none',
      editor,
      message: 'Đường dẫn workspace trống — không thể mở',
      error: 'rootPath là bắt buộc (đường dẫn thư mục workspace)',
    }
  }

  const resolved = path.resolve(rootPath.trim())
  if (!existsSync(resolved)) {
    return {
      success: false,
      opened: false,
      rootPath: resolved,
      method: 'none',
      editor,
      message: `Thư mục không tồn tại trên đĩa: ${resolved}`,
      error: `Thư mục không tồn tại: ${resolved}`,
    }
  }

  // FIX 2026-09-11 (review #6 MEDIUM): chống shell injection — command chạy qua
  // shell:true với "${resolved}" được bọc nháy kép; các ký tự "/" ` $ " và ký tự
  // điều khiển có thể THOÁT khỏi chuỗi quote (command substitution / escape).
  // Windows cấm " trong tên file (đường dẫn E:\APP\TMO-clone an toàn); trên
  // Linux/mac đường dẫn chứa các ký tự này → từ chối mở thay vì rủi ro inject.
  if(/["`$\r\n\t]/.test(resolved)){
    return {
      success: false,
      opened: false,
      rootPath: resolved,
      method: 'none',
      editor,
      message: 'Đường dẫn chứa ký tự nguy hiểm với shell (" ` $ tab/newline) — từ chối mở để chống injection',
      error: 'Đường dẫn chứa ký tự không an toàn cho shell exec',
    }
  }

  // Chọn lệnh mở theo editor + nền tảng
  const useVscode = editor === 'vscode'
  let command: string
  let method: string
  let notAvailableMsg: string
  if (useVscode) {
    // VS Code CLI "code" nằm trong PATH trên cả Windows/macOS/Linux
    command = `code "${resolved}"`
    method = 'vscode (code)'
    notAvailableMsg = 'code không khả dụng — cần cài VS Code CLI (Command Palette → "Shell Command: Install \'code\' command in PATH")'
  } else if (process.platform === 'win32') {
    // explorer.exe thường thoát với code 1 NGAY CẢ KHI MỞ THÀNH CÔNG (quirk
    // của Windows) — xử lý riêng khi đọc exit code bên dưới.
    command = `explorer.exe "${resolved}"`
    method = 'explorer.exe'
    notAvailableMsg = 'explorer.exe không khả dụng'
  } else if (process.platform === 'darwin') {
    command = `open "${resolved}"`
    method = 'open'
    notAvailableMsg = 'open không khả dụng'
  } else {
    command = `xdg-open "${resolved}"`
    method = 'xdg-open'
    notAvailableMsg = 'xdg-open không khả dụng'
  }

  console.log(`[open_workspace] ${method} → ${resolved}`)

  return new Promise((resolve) => {
    const startedAt = Date.now()
    let settled = false
    const child = spawn(command, {
      shell: true, // explorer.exe / code(.cmd) cần shell; path đã được quote
      stdio: 'ignore',
      windowsHide: true,
    })

    const finish = (receipt: WorkspaceOpenReceipt) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(receipt)
    }

    // GUI launcher (explorer/vscode) có thể giữ process sống dai dẳng — sau
    // 10s mà process vẫn chạy bình thường (chưa exit lỗi) coi như đã mở xong
    // (kill launcher KHÔNG đóng cửa sổ đã mở — launcher chỉ chuyển giao việc).
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* process đã tự thoát — bỏ qua */ }
      finish({
        success: true,
        opened: true,
        rootPath: resolved,
        method,
        editor,
        message: `Đã mở workspace bằng ${method} (launcher vẫn chạy sau ${Math.round((Date.now() - startedAt) / 1000)}s — coi như thành công): ${resolved}`,
      })
    }, 10_000)

    child.on('error', (err: Error) => {
      // spawn lỗi (ENOENT — binary không có trên máy) → receipt graceful
      finish({
        success: false,
        opened: false,
        rootPath: resolved,
        method,
        editor,
        message: `${notAvailableMsg} — không thể mở ${resolved}`,
        error: `${notAvailableMsg}: ${err.message}`,
      })
    })

    child.on('close', (code: number | null) => {
      const exit = code ?? -1
      // explorer.exe trả 1 ngay cả khi mở thành công (quirk Windows)
      const ok = exit === 0 || (process.platform === 'win32' && !useVscode && exit === 1)
      if (ok) {
        finish({
          success: true,
          opened: true,
          rootPath: resolved,
          method,
          editor,
          message: `Đã mở workspace bằng ${method}: ${resolved}`,
        })
      } else if (exit === 127) {
        // exit 127 = "command not found" từ shell unix
        finish({
          success: false,
          opened: false,
          rootPath: resolved,
          method,
          editor,
          message: `${notAvailableMsg} — không thể mở ${resolved}`,
          error: notAvailableMsg,
        })
      } else {
        finish({
          success: false,
          opened: false,
          rootPath: resolved,
          method,
          editor,
          message: `Lệnh ${method} thoát với code ${exit} — không mở được ${resolved}`,
          error: `${method} exit ${exit}`,
        })
      }
    })
  })
}

// ==================== CI-4 B3-B5 (Task 11-c): STRUCTURED GIT TOOLS ====================
//
// Roadmap CI-4 (docs/CODE_EXECUTION_IMPROVEMENT_ROADMAP.md): bộ 5 git tools có
// cấu trúc (receipt) cho agents KHẢO SÁT repo trước khi sửa code —
//   B3. git_status — branch / ahead-behind / clean / files[] (staged? untracked?)
//   B4. git_diff  — diff có kiểm soát (numstat summary + content capped max_lines)
//   B5. git_log   — lịch sử commit structured (hash/author/date/message/files)
//   B5. git_branch— list / create / switch / delete (validate tên, chống injection)
//   B5. git_clone — clone repo https:// INTO workspace root (token mask toàn bộ)
//
// Pattern: execFileAsync('git', [argv...], { cwd: root, timeout }) — argv array
// bypass shell hoàn toàn (không shell-injection); token KHÔNG BAO GIỜ xuất hiện
// trong receipt/log (stripTokenFromGitUrl + mask err.message — cùng chuẩn fix
// review #1 HIGH của GĐ1). Read-mostly (status/diff/log) chạy luôn không cần
// feature flag; git_branch/git_clone gate chung ENABLE_GIT_COMMIT ở tầng
// tool-executor (đồng bộ policy "1 flag tắt hết mọi git tool" của section P0.5).

/** Cap số file trong receipt git_status — chống phình context agent */
const GIT_STATUS_MAX_FILES = 200

/** Map mã XY của `git status --porcelain` sang tên trạng thái thân thiện */
function mapPorcelainStatus(code: string): string {
  const x = code[0] || ' '
  const y = code[1] || ' '
  if (code === '??') return 'untracked'
  if (x === 'A' || y === 'A') return 'added'
  if (x === 'D' || y === 'D') return 'deleted'
  if (x === 'R' || y === 'R') return 'renamed'
  if (x === 'C' || y === 'C') return 'copied'
  if (x === 'U' || y === 'U' || code === 'AA' || code === 'DD') return 'conflict'
  return 'modified'
}

/** Bỏ cặp nháy kép mà git porcelain bọc quanh path chứa ký tự đặc biệt */
function stripPorcelainPath(raw: string): string {
  let p = raw.trim()
  if (p.startsWith('"') && p.endsWith('"') && p.length >= 2) p = p.slice(1, -1)
  return p
}

/**
 * gitStatus — B3: trạng thái git có cấu trúc của 1 repo (default = ACTIVE workspace).
 *
 * 1 lệnh `git status --porcelain -b` cho ra branch + ahead/behind + files;
 * `git remote get-url origin` lấy remote (STRIP token qua stripTokenFromGitUrl);
 * `git rev-parse --short HEAD` lấy head commit. Receipt:
 *   { success, root, branch, upstream, ahead, behind, clean, fileCount,
 *     files: [{path, status, staged}], remoteUrl (đã strip token), headCommit }
 *
 * Read-only — KHÔNG feature flag. Dùng ĐẦU TIÊN khi khảo sát repo trước khi sửa.
 */
export async function gitStatus(rootArg?: string): Promise<unknown> {
  // root: relative resolve theo ACTIVE workspace root; absolute bị chặn nếu
  // thoát khỏi workspace (FIX review GĐ2 LOW#1 — đồng bộ với gitDiff/gitLog)
  const root = rootArg && typeof rootArg === 'string' && rootArg.trim()
    ? await resolveWithinWorkspace(rootArg.trim())
    : await resolveWorkspaceRoot()

  try {
    const isRepo = await execFileAsync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: root, timeout: 5_000 })
      .then(r => r.stdout.trim() === 'true').catch(() => false)
    if (!isRepo) {
      return {
        success: false,
        root,
        error: `Thư mục (${root}) KHÔNG phải git repository — kiểm tra đường dẫn, hoặc khởi tạo bằng shell({"command": "git init -b main"}).`,
      }
    }

    // Branch + upstream + ahead/behind + files: 1 call duy nhất
    const { stdout: porcelainB } = await execFileAsync('git', ['status', '--porcelain', '-b'], { cwd: root, timeout: 10_000 })
    const lines = porcelainB.split('\n')

    // Header: "## branch...upstream [ahead N, behind M]" | "## HEAD (no branch)" | "## No commits yet on main"
    let branch = ''
    let upstream: string | null = null
    let ahead = 0
    let behind = 0
    const header = (lines[0] || '').trim()
    if (header.startsWith('## ')) {
      const headerBody = header.slice(3)
      if (headerBody.startsWith('No commits yet on ')) {
        branch = headerBody.replace('No commits yet on ', '').trim()
      } else {
        const m = headerBody.match(/^(\S+?)(?:\.\.\.(\S+))?(?:\s+\[(.*)\])?$/)
        if (m) {
          if (m[1] === 'HEAD') {
            // Detached HEAD — hiển thị kèm commit để agent không lạc ngữ cảnh
            const short = await execFileAsync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, timeout: 5_000 })
              .then(r => r.stdout.trim()).catch(() => '?')
            branch = `HEAD (detached tại ${short})`
          } else {
            branch = m[1]
          }
          upstream = m[2] || null
          if (m[3]) {
            const aheadM = m[3].match(/ahead (\d+)/)
            const behindM = m[3].match(/behind (\d+)/)
            ahead = aheadM ? parseInt(aheadM[1], 10) || 0 : 0
            behind = behindM ? parseInt(behindM[1], 10) || 0 : 0
          }
        }
      }
    }

    // Files: các dòng sau header — "XY path" / "XY old -> new" (rename) / "?? path"
    const files: Array<{ path: string; status: string; staged: boolean }> = []
    for (const line of lines.slice(1)) {
      if (!line.trim()) continue
      const code = line.slice(0, 2)
      const rawPath = line.slice(3)
      // Rename "R  old -> new": lấy path MỚI làm chính (path cũ nằm trong git output gốc)
      const displayPath = rawPath.includes(' -> ')
        ? stripPorcelainPath(rawPath.split(' -> ').pop() || '')
        : stripPorcelainPath(rawPath)
      if (!displayPath) continue
      files.push({
        path: displayPath,
        status: mapPorcelainStatus(code),
        staged: code[0] !== ' ' && code !== '??',
      })
    }

    // Remote URL (STRIP token) + head commit — best-effort, không fail chính
    const remoteUrl = await execFileAsync('git', ['remote', 'get-url', 'origin'], { cwd: root, timeout: 5_000 })
      .then(r => stripTokenFromGitUrl(r.stdout.trim())).catch(() => '')
    const headCommit = await execFileAsync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, timeout: 5_000 })
      .then(r => r.stdout.trim()).catch(() => '')

    return {
      success: true,
      root,
      branch,
      upstream,
      ahead,
      behind,
      clean: files.length === 0,
      fileCount: files.length,
      files: files.slice(0, GIT_STATUS_MAX_FILES),
      ...(files.length > GIT_STATUS_MAX_FILES ? { filesTruncated: true, note: `Hiển thị ${GIT_STATUS_MAX_FILES}/${files.length} file — thu hẹp bằng cách commit dần hoặc xem git_diff theo paths.` } : {}),
      remoteUrl, // đã strip token — an toàn hiển thị
      headCommit,
    }
  } catch (err: any) {
    return { success: false, root, error: `git status failed: ${err.message}` }
  }
}

/**
 * gitDiff — B4: diff có kiểm soát so với 1 ref cục bộ (default HEAD).
 *
 * Injection guard: target phải là git ref cục bộ (HEAD, main, abc1234, HEAD~3...) —
 * từ chối target chứa khoảng trắng, bắt đầu bằng '-' (option giả mạo), hoặc chứa
 * '://' (URL remote — KHÔNG BAO GIỜ diff với authed URL). Summary qua
 * `git diff --numstat` (files + insertions + deletions trong 1 call), content
 * capped max_lines (default 400) chống tràn context.
 */
export async function gitDiff(args: {
  target?: string
  staged_only?: boolean
  paths?: string[]
  max_lines?: number
}): Promise<unknown> {
  const root = await resolveWorkspaceRoot()

  try {
    // Guard: target = 1 ref cục bộ duy nhất, không khoảng trắng/option/URL
    const target = (args.target ?? 'HEAD').trim()
    if (!target || /\s/.test(target)) {
      return { success: false, error: `target không hợp lệ ("${target}") — chỉ nhận 1 git ref cục bộ (vd HEAD, main, abc1234, HEAD~3), không chứa khoảng trắng.` }
    }
    if (target.startsWith('-') || target.includes('://')) {
      return { success: false, error: `target bị từ chối vì an toàn ("${target}") — không chấp nhận option giả mạo (bắt đầu '-') hay URL remote (chỉ diff với ref cục bộ).` }
    }

    const maxLines = Math.max(10, Math.min(2_000, args.max_lines ?? 400))

    // Paths resolve + scope-check như gitCommit (chống escape workspace)
    let pathArgs: string[] = []
    if (args.paths && args.paths.length > 0) {
      const resolved = await Promise.all(args.paths.map(p => resolveWithinWorkspace(p)))
      const rels = resolved.map(p => path.relative(root, p)).filter(p => p !== '')
      if (rels.length > 0) pathArgs = ['--', ...rels]
    }

    // 1. Summary: `git diff --numstat` — "<ins>\t<del>\t<path>" mỗi dòng (binary: "-\t-\t...")
    const numstatOut = await execFileAsync(
      'git',
      ['diff', '--numstat', ...(args.staged_only ? ['--cached'] : []), target, ...pathArgs],
      { cwd: root, timeout: 15_000, maxBuffer: 2 * 1024 * 1024 },
    ).then(r => r.stdout).catch(() => '')

    const filesChanged: string[] = []
    let insertions = 0
    let deletions = 0
    for (const line of numstatOut.split('\n')) {
      if (!line.trim()) continue
      const parts = line.split('\t')
      if (parts.length < 3) continue
      filesChanged.push(parts.slice(2).join('\t')) // path chứa '\t' hiếm — ghép lại cho đúng
      if (parts[0] !== '-') insertions += parseInt(parts[0], 10) || 0
      if (parts[1] !== '-') deletions += parseInt(parts[1], 10) || 0
    }

    // 2. Content — cap max_lines
    const { stdout: diffOut } = await execFileAsync(
      'git',
      ['diff', ...(args.staged_only ? ['--cached'] : []), target, ...pathArgs],
      { cwd: root, timeout: 30_000, maxBuffer: 10 * 1024 * 1024 },
    )

    const allLines = diffOut.split('\n')
    const totalDiffLines = allLines.length
    const truncated = totalDiffLines > maxLines

    return {
      success: true,
      root,
      target,
      stagedOnly: args.staged_only === true,
      filesChanged,
      insertions,
      deletions,
      diff: allLines.slice(0, maxLines).join('\n'),
      diffLines: Math.min(totalDiffLines, maxLines),
      truncated,
      totalDiffLines,
      ...(truncated ? { note: `Diff cắt ở ${maxLines}/${totalDiffLines} dòng — thu hẹp bằng paths[]/target cụ thể hoặc tăng max_lines (max 2000).` } : {}),
      ...(filesChanged.length === 0 && !truncated && diffOut.trim() === '' ? { message: `Không có khác biệt nào so với ${target}${args.staged_only ? ' (staged only)' : ''}.` } : {}),
    }
  } catch (err: any) {
    const hint = /unknown revision|bad revision|ambiguous argument|unknown object/i.test(err.message || '')
      ? `Không tìm thấy ref "${args.target ?? 'HEAD'}" — repo chưa có commit nào (HEAD chưa tồn tại) hoặc ref sai.`
      : /does not have (any )?commits/i.test(err.message || '')
        ? 'Repository chưa có commit nào — so sánh với cây rỗng bằng cách commit lần đầu.'
        : ''
    return { success: false, error: `git diff failed: ${err.message}`, hint }
  }
}

/**
 * gitLog — B5: lịch sử commit có cấu trúc.
 *
 * Custom format %H%x1f%h%x1f%an%x1f%ad%x1f%s%x1e (field \x1f / record \x1e) —
 * parse bền vững kể cả message chứa ký tự lạ. oneline=true = compact (không kèm
 * files[] mỗi commit); mặc định kèm files (cap 50/commit) khi agent cần xem
 * commit nào đụng file gì.
 */
export async function gitLog(args: {
  limit?: number
  path?: string
  oneline?: boolean
}): Promise<unknown> {
  const root = await resolveWorkspaceRoot()

  try {
    const limit = Math.max(1, Math.min(100, args.limit ?? 20))
    const wantFiles = args.oneline !== true

    let pathArgs: string[] = []
    if (args.path && args.path.trim()) {
      const resolved = await resolveWithinWorkspace(args.path.trim())
      const rel = path.relative(root, resolved)
      if (rel) pathArgs = ['--', rel]
    }

    const fmt = '%H%x1f%h%x1f%an%x1f%ad%x1f%s%x1e'
    const { stdout } = await execFileAsync(
      'git',
      ['log', '-n', String(limit), '--date=iso', `--pretty=format:${fmt}`, ...(wantFiles ? ['--name-only'] : []), ...pathArgs],
      { cwd: root, timeout: 15_000, maxBuffer: 5 * 1024 * 1024 },
    )

    // Parse theo DÒNG: dòng chứa \x1f = meta commit; dòng khác (không rỗng) = file
    // của commit hiện tại — không phụ thuộc thứ tự blank-line separator của git.
    const commits: Array<{ hash: string; shortHash: string; author: string; date: string; message: string; files?: string[] }> = []
    let current: { hash: string; shortHash: string; author: string; date: string; message: string; files: string[] } | null = null
    for (const rawLine of stdout.split('\n')) {
      const line = rawLine.replace(/\x1e$/, '')
      if (line.includes('\x1f')) {
        if (current) commits.push(current)
        const meta = line.split('\x1f')
        current = {
          hash: meta[0] || '',
          shortHash: meta[1] || '',
          author: meta[2] || '',
          date: meta[3] || '',
          message: meta.slice(4).join('\x1f'),
          files: [],
        }
      } else if (line.trim() && current) {
        current.files.push(line.trim())
      }
    }
    if (current) commits.push(current)

    if (commits.length === 0) {
      return {
        success: true,
        root,
        commits: [],
        count: 0,
        message: 'Không có commit nào (repo trống hoặc path không có lịch sử).',
      }
    }

    // Ép shape output: files chỉ kèm khi wantFiles (cap 50/commit)
    return {
      success: true,
      root,
      count: commits.length,
      oneline: args.oneline === true,
      commits: commits.map(c => {
        const entry: { hash: string; shortHash: string; author: string; date: string; message: string; files?: string[] } = {
          hash: c.hash,
          shortHash: c.shortHash,
          author: c.author,
          date: c.date,
          message: c.message,
        }
        if (wantFiles && c.files && c.files.length > 0) entry.files = c.files.slice(0, 50)
        return entry
      }),
    }
  } catch (err: any) {
    const hint = /does not have (any )?commits|unknown revision|bad default revision/i.test(err.message || '')
      ? 'Repository chưa có commit nào — dùng git_status để kiểm tra.'
      : /ambiguous argument|unknown revision/i.test(err.message || '')
        ? 'Path không tồn tại trong lịch sử git — kiểm tra lại path.'
        : ''
    return { success: false, error: `git log failed: ${err.message}`, hint }
  }
}

/**
 * gitBranch — B5: quản lý branch (list / create / switch / delete).
 *
 * Tên branch validate /^[a-zA-Z0-9._\-\/]+$/ + không bắt đầu '-' + không chứa '..'
 * (chống option/refspec giả mạo — execFileAsync đã bypass shell, đây là lớp
 * phòng thủ thứ hai). delete: TỪ CHỐI xóa branch đang đứng; branch chưa merge
 * chỉ xóa được khi force:true (git branch -D), còn lại dùng -d an toàn.
 */
export async function gitBranch(args: {
  action: 'list' | 'create' | 'switch' | 'delete'
  name?: string
  force?: boolean
}): Promise<unknown> {
  const root = await resolveWorkspaceRoot()
  const action = args.action
  const name = (args.name || '').trim()

  // Validate action + branch name
  if (!action || !['list', 'create', 'switch', 'delete'].includes(action)) {
    return { success: false, error: `action không hợp lệ: "${action}" — dùng list | create | switch | delete.` }
  }
  const VALID_BRANCH = /^[a-zA-Z0-9._\-\/]+$/
  if (action !== 'list' && (!name || !VALID_BRANCH.test(name) || name.startsWith('-') || name.includes('..'))) {
    return {
      success: false,
      action,
      error: `Tên branch không hợp lệ: "${name}" — chỉ nhận [a-zA-Z0-9._-/], không bắt đầu bằng '-', không chứa '..'.`,
    }
  }

  try {
    const isRepo = await execFileAsync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: root, timeout: 5_000 })
      .then(r => r.stdout.trim() === 'true').catch(() => false)
    if (!isRepo) {
      return { success: false, action, error: `Workspace (${root}) KHÔNG phải git repository — không thao tác branch được.` }
    }

    const currentBranch = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root, timeout: 5_000 })
      .then(r => r.stdout.trim()).catch(() => '')

    // ---------- list ----------
    if (action === 'list') {
      const { stdout } = await execFileAsync('git', ['branch', '--no-color'], { cwd: root, timeout: 10_000 })
      const branches = stdout.split('\n').map(l => l.trim()).filter(Boolean).map(l => {
        const isCurrent = l.startsWith('* ')
        return { name: isCurrent ? l.slice(2).trim() : l, current: isCurrent }
      })
      return {
        success: true,
        action,
        root,
        current: currentBranch,
        branches,
        count: branches.length,
      }
    }

    // ---------- create ----------
    if (action === 'create') {
      // Pre-check tồn tại cho receipt thân thiện (git branch sẽ fail "already exists")
      const exists = await execFileAsync('git', ['show-ref', '--verify', '--quiet', `refs/heads/${name}`], { cwd: root, timeout: 5_000 })
        .then(() => true).catch(() => false)
      if (exists) {
        return {
          success: false,
          action,
          error: `Branch "${name}" đã tồn tại.`,
          hint: `Dùng action "switch" để chuyển sang nó, hoặc chọn tên khác.`,
        }
      }
      await execFileAsync('git', ['branch', name], { cwd: root, timeout: 10_000 })
      const headCommit = await execFileAsync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, timeout: 5_000 })
        .then(r => r.stdout.trim()).catch(() => '')
      return {
        success: true,
        action,
        created: name,
        fromCommit: headCommit,
        message: `Đã tạo branch "${name}" từ ${headCommit} (KHÔNG switch — dùng action "switch" để chuyển sang).`,
      }
    }

    // ---------- switch ----------
    if (action === 'switch') {
      if (name === currentBranch) {
        return { success: true, action, branch: name, switched: false, message: `Đã đang ở branch "${name}" — không cần switch.` }
      }
      try {
        const previousBranch = currentBranch
        await execFileAsync('git', ['switch', name], { cwd: root, timeout: 15_000 })
        return {
          success: true,
          action,
          switchedTo: name,
          previousBranch,
          message: `Đã chuyển branch: ${previousBranch || '?'} → ${name}.`,
        }
      } catch (err: any) {
        const raw = ((err.stdout || '') + (err.stderr || '')).trim()
        let hint = ''
        if (/did not match|not found|unknown branch/i.test(raw)) {
          hint = `Branch "${name}" chưa tồn tại — dùng action "create" trước rồi "switch".`
        } else if (/would be overwritten|local changes|uncommitted/i.test(raw)) {
          hint = 'Có thay đổi chưa commit cản trở switch — git_commit (scoped paths) hoặc stash trước rồi switch lại.'
        }
        return { success: false, action, error: `git switch failed: ${err.message}`, hint, output: raw.slice(0, 1000) }
      }
    }

    // ---------- delete ----------
    if (name === currentBranch) {
      return {
        success: false,
        action,
        error: `KHÔNG thể xóa branch đang đứng ("${name}") — switch sang branch khác trước rồi xóa.`,
        hint: `Ví dụ: git_branch({action: "switch", name: "main"}) trước, rồi mới delete "${name}" (đừng delete chính branch vừa switch sang).`,
      }
    }
    try {
      // -d = chỉ xóa branch ĐÃ merge (an toàn); force → -D xóa vĩnh viễn kể cả chưa merge
      await execFileAsync('git', ['branch', args.force ? '-D' : '-d', name], { cwd: root, timeout: 10_000 })
      return {
        success: true,
        action,
        deleted: name,
        forced: args.force === true,
        message: `Đã xóa branch "${name}"${args.force ? ' (force -D — có thể chứa commit chưa merge)' : ' (chỉ merged — an toàn)'}.`,
      }
    } catch (err: any) {
      const raw = ((err.stdout || '') + (err.stderr || '')).trim()
      let hint = ''
      if (/not fully merged|not merged/i.test(raw)) {
        hint = `Branch "${name}" có commit CHƯA merge — xác nhận thật sự muốn mất chúng thì dùng force:true (git branch -D).`
      } else if (/not found|did not match|no branch/i.test(raw)) {
        hint = `Không tìm thấy branch "${name}" — dùng action "list" để xem branch hiện có.`
      }
      return { success: false, action, error: `git branch delete failed: ${err.message}`, hint, output: raw.slice(0, 1000) }
    }
  } catch (err: any) {
    return { success: false, action, error: `git branch failed: ${err.message}` }
  }
}

/**
 * gitClone — B5: clone repo https:// VÀO thư mục con của ACTIVE workspace.
 *
 * Bảo mật:
 *   - URL: CHỈ https:// (từ chối git@/http/file/...) — validate qua new URL()
 *   - Token embedded trong URL (https://ghp_x@...) được DÙNG cho clone thật
 *     (one-shot) nhưng mọi log/receipt chỉ chứa bản ĐÃ STRIP; sau clone xong
 *     clean authed URL khỏi .git/config của repo mới (standing rule: token
 *     không bao giờ nằm trong .git/config). KHÔNG lưu token của repo lạ vào
 *     token store (tránh đè token chính của workspace).
 *   - Token store/env chỉ đính khi host là github.com (token GitHub không gửi
 *     sang host lạ — chống exfiltration qua URL agent tự chế).
 *   - target_dir resolve + verify NẰM TRONG workspace root (resolveWithinWorkspace).
 */
export async function gitClone(args: {
  url: string
  target_dir?: string
  depth?: number
}): Promise<unknown> {
  const root = await resolveWorkspaceRoot()

  try {
    // 1. URL validation — https:// only
    const rawUrl = (args.url || '').trim()
    if (!rawUrl) return { success: false, error: 'url là bắt buộc (https://host/user/repo.git)' }
    let parsed: URL
    try {
      parsed = new URL(rawUrl)
    } catch {
      return { success: false, error: `URL không hợp lệ: "${rawUrl}"` }
    }
    if (parsed.protocol !== 'https:') {
      return { success: false, error: `Chỉ chấp nhận URL https:// (nhận ${parsed.protocol}) — SSH (git@), http://, file:// bị từ chối.` }
    }

    // 2. Token resolution: embedded trong URL > store/env (chỉ github.com) > công khai
    const embedded = extractEmbeddedToken(rawUrl)
    const cleanUrl = stripTokenFromGitUrl(rawUrl)
    let authedUrl = rawUrl
    let tokenUsed = embedded || ''
    let tokenSource: 'embedded' | 'store/env' | 'none' = embedded ? 'embedded' : 'none'
    if (!embedded) {
      const host = parsed.hostname.toLowerCase()
      if (host === 'github.com' || host.endsWith('.github.com')) {
        const { getSavedGithubToken } = await import('@/lib/github-token-store')
        const savedToken = getSavedGithubToken()
        const envToken = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || ''
        const token = savedToken || envToken || ''
        if (token) {
          authedUrl = buildAuthedGitUrl(cleanUrl, token)
          tokenUsed = token
          tokenSource = 'store/env'
        }
      }
    }
    // Mask mọi vị trí token có thể lộ (err.message chứa command line — review #1 HIGH)
    const maskToken = (s: string): string => (tokenUsed ? s.split(tokenUsed).join('****') : s)

    // 3. Target dir — luôn NẰM TRONG workspace root
    let targetDir = (args.target_dir || '').trim()
    if (!targetDir) {
      const repoName = (parsed.pathname.split('/').filter(Boolean).pop() || 'repo').replace(/\.git$/, '')
      targetDir = repoName
    }
    let targetPath: string
    try {
      targetPath = await resolveWithinWorkspace(targetDir)
    } catch (err: any) {
      return { success: false, error: `target_dir nằm NGOÀI workspace root (${targetDir}): ${err.message}` }
    }
    // Pre-check: dir tồn tại + không trống → git clone sẽ fail — báo rõ thay vì lỗi mù
    try {
      const entries = await fs.readdir(targetPath)
      if (entries.length > 0) {
        return {
          success: false,
          error: `Thư mục đích không trống: ${targetPath} (${entries.length} mục) — chọn target_dir khác hoặc dọn thư mục trước.`,
        }
      }
    } catch { /* chưa tồn tại — git clone tự tạo */ }

    // 4. Clone (depth shallow khi có) — GIT_TERMINAL_PROMPT=0 chống treo prompt tương tác
    const depth = args.depth ? Math.max(1, Math.min(1_000, Math.floor(args.depth))) : undefined
    const cloneArgs = ['clone', ...(depth ? ['--depth', String(depth)] : []), authedUrl, targetPath]
    console.log(`[gitClone] ${cleanUrl} → ${targetPath}${depth ? ` (depth ${depth})` : ''}${tokenUsed ? ' (token: yes)' : ' (không token)'}`)

    try {
      await execFileAsync('git', cloneArgs, {
        cwd: root,
        timeout: 300_000,
        maxBuffer: 10 * 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      })
    } catch (err: any) {
      const raw = ((err.stdout || '') + (err.stderr || '')).trim()
      let hint = ''
      if (/Authentication failed|could not read Username|403|terminal prompts disabled/i.test(raw)) {
        hint = 'Không xác thực được (repo private?) — nhúng token vào URL (https://<token>@github.com/...) hoặc nhờ user nhập GitHub PAT trong dialog "Pull Code từ GitHub".'
      } else if (/Repository not found|does not appear|not found/i.test(raw)) {
        hint = `Không tìm thấy repository ${cleanUrl} — kiểm tra URL (repo private cần token có quyền truy cập).`
      } else if (/already exists and is not an empty directory/i.test(raw)) {
        hint = `Thư mục đích đã có nội dung — chọn target_dir khác.`
      }
      return {
        success: false,
        error: `git clone failed: ${maskToken(String(err.message))}`,
        hint,
        url: cleanUrl,
        targetPath,
        output: maskToken(raw).slice(0, 2000),
      }
    }

    // 5. Dọn authed URL khỏi .git/config của repo vừa clone (standing rule CI-6)
    if (tokenUsed) {
      await execFileAsync('git', ['remote', 'set-url', 'origin', cleanUrl], { cwd: targetPath, timeout: 5_000 })
        .then(() => console.log('[gitClone] Cleaned authed URL from cloned .git/config (safety)'))
        .catch(() => {})
    }

    // 6. Receipt: branch + số file tracked (git ls-files) — mô tả cái vừa clone về
    const branch = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: targetPath, timeout: 5_000 })
      .then(r => r.stdout.trim()).catch(() => '')
    const fileCount = await execFileAsync('git', ['ls-files'], { cwd: targetPath, timeout: 15_000 })
      .then(r => r.stdout.split('\n').filter(Boolean).length).catch(() => 0)

    return {
      success: true,
      url: cleanUrl, // đã strip token — an toàn hiển thị
      targetPath,
      ...(depth ? { depth } : {}),
      branch,
      fileCount,
      authenticated: !!tokenUsed,
      tokenSource, // 'embedded' | 'store/env' | 'none' — KHÔNG chứa giá trị token
      message: `Đã clone ${cleanUrl} → ${targetPath} (${fileCount} file, branch ${branch || '?'})${depth ? ` [shallow depth ${depth}]` : ''}.`,
    }
  } catch (err: any) {
    return { success: false, error: `git clone failed: ${err.message}` }
  }
}

// ==================== P1: GET DIAGNOSTICS (LSP / tsc) ====================

/**
 * get_diagnostics — type-check + lint diagnostics for a file or the whole workspace.
 * Tries the opencode-server /lsp/diagnostics endpoint first (it wraps `tsc --noEmit`),
 * falls back to running `tsc --noEmit` locally and parsing the output.
 */
export async function getDiagnostics(args: { path?: string }): Promise<unknown> {
  const root = await resolveWorkspaceRoot()
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
 *
 * v2.1 Phase 5.5 — when ENABLE_MASTER_ORCHESTRATOR is true, this delegates to
 * the FULL thinking/decomposer.ts implementation (Layer 2.1 Problem Decomposition),
 * which expects an IntentResult + MentalModel from Layer 1 intake. We build
 * minimal versions of both (parseIntent + buildMentalModel), call the full
 * decomposer, and persist the resulting DecompositionPlan into our DevTask store.
 *
 * When the flag is false, the legacy simplified LLM call is preserved so
 * existing callers/orchestrations don't break.
 *
 * Spec: docs/FULLSTACK_CAPABILITY_PLAN_V2.md Phase 5.5 (lines 322-326).
 */
/**
 * FIX 2026-09-14 #4 (ghost system → DB Todo): persist DAG DevTask[] vào DB
 * Todo bền vững — mỗi subtask 1 row:
 *   - content = "<title> — <spec>" ( Thought Process panel + auto-complete
 *     CI-2 theo bằng chứng tool path/lệnh shell khớp content)
 *   - idempotencyKey = "task:T00N" (taskId ổn định — update_task/get_plan
 *     tra cứu lại được sau restart)
 *   - taskMetaJson = {taskId, title, spec, assignee, deps[], notes} (DAG)
 *   - agentRole = assignee (TL/G1/G2-A/G2-B/G3), runId scope theo run cha
 * Fail-open tuyệt đối: DB lỗi → trả note lỗi, DAG in-memory vẫn giữ (hành vi
 * cũ) — decomposition KHÔNG BAO GIỜ fail vì DB.
 */
async function persistDevTasksToDb(
  tasks: DevTask[],
  scope: { sessionId?: string; runId?: string },
): Promise<{ persisted: number; todoIds: string[]; error?: string }> {
  const todoIds: string[] = []
  if (tasks.length === 0) return { persisted: 0, todoIds }
  const sessionId = (typeof scope.sessionId === 'string' && scope.sessionId.trim()) || 'default'
  const runId = (typeof scope.runId === 'string' && scope.runId.trim()) || null
  try {
    const { db } = await import('@/lib/db')
    // Dedup: decompose lại cùng session → taskId đã có thì UPDATE chứ không đẻ row mới
    const existing = await db.todo.findMany({
      where: { sessionId, idempotencyKey: { startsWith: 'task:' } },
      select: { id: true, idempotencyKey: true },
    })
    const existingByTaskId = new Map(existing.map(t => [t.idempotencyKey ?? '', t.id]))
    let position = existing.length
    for (const t of tasks) {
      const key = `task:${t.id}`
      const meta = {
        taskId: t.id,
        title: t.title,
        spec: t.spec,
        assignee: t.assignee,
        deps: t.deps,
        notes: t.notes,
        source: 'decompose_task',
      }
      const content = `${t.title}${t.spec ? ` — ${t.spec}` : ''}`.slice(0, 500)
      const existingId = existingByTaskId.get(key)
      if (existingId) {
        await db.todo.update({
          where: { id: existingId },
          data: {
            content,
            status: t.status,
            priority: t.priority,
            taskMetaJson: JSON.stringify(meta),
            archivedAt: null,
          },
        })
        todoIds.push(existingId)
        continue
      }
      const created = await db.todo.create({
        data: {
          sessionId,
          agentRole: t.assignee,
          content,
          status: t.status,
          priority: t.priority,
          position: position++,
          idempotencyKey: key,
          taskMetaJson: JSON.stringify(meta),
          ...(runId ? { runId } : {}),
        },
      })
      todoIds.push(created.id)
    }
    return { persisted: todoIds.length, todoIds }
  } catch (err) {
    return { persisted: 0, todoIds, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * (2026-10-15) REMOVED tryZaiSdkForDecompose theo user directive — gỡ bỏ toàn
 * bộ fallback z-ai-web-dev-sdk (sdk chỉ có trong sandbox, không tồn tại trên máy
 * local). NVIDIA chain fail → decompose trả lỗi trung thực qua guard bên dưới.
 */

export async function decomposeTask(args: { goal: string; context?: string; sessionId?: string; runId?: string }): Promise<unknown> {
  if (!args.goal) return { error: 'goal is required' }

  // ===== v2.1 Phase 5.5 — full thinking/decomposer.ts path =====
  if (isFlagEnabled('ENABLE_MASTER_ORCHESTRATOR')) {
    try {
      return await decomposeTaskViaThinkingLayer(args.goal, args.context, args)
    } catch (err) {
      // Graceful fallback to the simplified path — never break the caller
      console.warn('[dev-tools:decomposeTask] thinking layer failed, falling back to simplified LLM call:', err instanceof Error ? err.message : String(err))
    }
  }

  // ===== Legacy simplified LLM path (default when flag=false) =====
  const { callLLM } = await import('@/lib/llm')
  const prompt = `Decompose this goal into 3-7 concrete subtasks. Return a JSON array (no markdown fence).
Each task: { "title": short, "spec": 1-2 sentence acceptance criteria, "assignee": "TL"|"G1"|"G2-A"|"G2-B"|"G3", "priority": "low"|"medium"|"high", "deps": [task indices 0-based] }

Goal: ${args.goal}
${args.context ? `Context: ${args.context}` : ''}

JSON:`
  const result = await callLLM(prompt, 'You are a senior tech lead. Be concrete and minimal.', 'task_decomposition')
  const text = result.content || ''
  // (2026-10-15) z-ai-sdk fallback đã GỠ BỎ — content rỗng rơi thẳng vào guard
  // JSON parse lỗi → trả lỗi trung thực kèm result.error để agent biết nguyên nhân.

  let tasksRaw: any[]
  try {
    // Strip markdown fence if present
    const cleaned = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim()
    tasksRaw = JSON.parse(cleaned)
  } catch {
    return { error: 'LLM did not return valid JSON', raw: text.slice(0, 500) }
  }
  // GUARD (E2E 2026-09-14): LLM trả list rỗng / không phải mảng → báo lỗi trung
  // thực thay vì "success + 0 task + durable=true" gây hiểu nhầm đã phân rã xong.
  if (!Array.isArray(tasksRaw) || tasksRaw.length === 0) {
    return {
      error: 'LLM did not return any subtasks (empty list)',
      raw: text.slice(0, 300),
      hint: 'Thử lại decompose_task, hoặc tự chia nhỏ task bằng todo_write.',
    }
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

  // FIX 2026-09-14 #4 — DAG bền vững trong DB Todo (không còn ghost in-memory)
  const persisted = await persistDevTasksToDb(created, args)
  return {
    success: true,
    goal: args.goal,
    tasksCreated: created.length,
    tasks: created,
    durable: persisted.persisted === created.length,
    durableNote: persisted.error
      ? `⚠️ DB persist lỗi (${persisted.error.slice(0, 120)}) — DAG chỉ còn in-memory, mất khi restart`
      : persisted.persisted > 0
        ? `Đã lưu ${persisted.persisted}/${created.length} subtask vào DB Todo (bền vững qua restart — get_plan đọc lại được, update_task cập nhật được)`
        : undefined,
  }
}

/**
 * v2.1 Phase 5.5 — full thinking/decomposer.ts path.
 *
 * Builds a minimal IntentResult (via parseIntent from Layer 1 intake) and a
 * minimal MentalModel (via buildMentalModel, cached per-project), then calls
 * decomposeTask() from src/lib/thinking/decomposer.ts — the full implementation
 * that classifies sub-task types, runs LLM/heuristic generation, performs
 * topological sort, identifies critical path, and resolves circular dependencies.
 *
 * The resulting DecompositionPlan.SubTask[] is converted into DevTask objects
 * and persisted in the global task store, mirroring the legacy simplified path's
 * persistence shape so existing callers (create_task, update_task, get_plan)
 * work unchanged.
 *
 * Dynamic imports avoid a static circular dep: dev-tools.ts is imported by
 * code-team/tool-executor.ts which is imported by orchestration/agent-delegator.ts
 * — statically pulling thinking/decomposer (which imports intake which imports
 * db etc.) risks subtle ordering issues; lazy loading is safer and zero-cost
 * when the flag is off.
 */
async function decomposeTaskViaThinkingLayer(goal: string, context?: string, scope?: { sessionId?: string; runId?: string }): Promise<unknown> {
  const { parseIntent, buildMentalModel } = await import('@/lib/intake')
  const { decomposeTask: thinkingDecomposeTask } = await import('@/lib/thinking/decomposer')

  // 1. Build minimal IntentResult — parseIntent runs the intent parser (LLM if
  //    useLLM=true default; falls back to keyword-based classification on error).
  //    The conversationHistory param is unused for now — parseIntent only uses it
  //    for LLM-based taskType classification context.
  const intent = await parseIntent(goal, undefined, { useLLM: true }).catch(() => ({
    taskType: 'create' as const,
    summary: goal.slice(0, 200),
    constraints: {},
    ambiguities: [],
    implicitRequirements: [],
    confidence: 0.5,
  }))

  // 2. Build minimal MentalModel — buildMentalModel scans the workspace
  //    structure (cached per-project for CACHE_TTL_MS). On failure, return a
  //    minimal stub with empty structure fields so the decomposer can still run
  //    (its heuristic generator only reads mentalModel.structure.X.length).
  const projectRoot = await resolveWorkspaceRoot()
  const mentalModel = await buildMentalModel(projectRoot).catch(() => ({
    structure: { pages: [], components: [], libs: [], apis: [], configs: [] },
    dependencies: { nodes: new Map(), entryPoints: [] },
    patterns: [],
    conventions: {
      componentNaming: 'PascalCase' as const,
      functionNaming: 'camelCase' as const,
      fileNaming: 'kebab-case' as const,
      importOrder: [],
    },
    readAt: new Date(),
  }))

  // 3. Call the full thinking/decomposer.ts implementation
  const plan = await thinkingDecomposeTask(goal, intent, mentalModel, { useLLM: true })

  // 4. Persist the DecompositionPlan.SubTask[] into the global DevTask store,
  //    mirroring the legacy simplified path's shape so downstream callers
  //    (create_task, update_task, get_plan) work unchanged.
  const store = getTaskStore()
  const created: DevTask[] = []

  // Map SubTask.dependencies (UUID-style IDs from the decomposer) → our T### IDs
  const idMap = new Map<string, string>()
  for (let i = 0; i < plan.subTasks.length; i++) {
    idMap.set(plan.subTasks[i].id, nextTaskId())
  }

  const now = new Date().toISOString()
  for (const st of plan.subTasks) {
    const id = idMap.get(st.id)!
    const task: DevTask = {
      id,
      title: st.name,
      spec: st.description || st.goal,
      assignee: st.assignedAgent || (st.type === 'frontend' ? 'G2-B' : 'G2-A'),
      priority: st.estimatedComplexity === 'simple' ? 'low' : st.estimatedComplexity === 'complex' ? 'high' : 'medium',
      deps: (st.dependencies || []).map((depId) => idMap.get(depId) || depId),
      status: 'pending',
      notes: JSON.stringify({
        type: st.type,
        goal: st.goal,
        expectedOutput: st.expectedOutput,
        verificationCriteria: st.verificationCriteria,
        estimatedTokens: st.estimatedTokens,
        filesToRead: st.filesToRead,
        filesToWrite: st.filesToWrite,
        risks: st.risks,
      }),
      createdAt: now,
      updatedAt: now,
    }
    store.set(id, task)
    created.push(task)
  }

  // FIX 2026-09-14 #4 — thinking path cũng persist DAG vào DB Todo (bền vững)
  const persisted = await persistDevTasksToDb(created, scope ?? {})

  return {
    success: true,
    goal,
    tasksCreated: created.length,
    tasks: created,
    durable: persisted.persisted === created.length,
    durableNote: persisted.error
      ? `⚠️ DB persist lỗi (${persisted.error.slice(0, 120)}) — DAG chỉ còn in-memory, mất khi restart`
      : persisted.persisted > 0
        ? `Đã lưu ${persisted.persisted}/${created.length} subtask vào DB Todo (bền vững qua restart — get_plan đọc lại được, update_task cập nhật được)`
        : undefined,
    // Phase 5.5 — pass through the full DecompositionPlan metadata for callers
    // that want it (critical path, dependency graph, total estimated tokens/time).
    plan: {
      totalEstimatedTokens: plan.totalEstimatedTokens,
      totalEstimatedTime: plan.totalEstimatedTime,
      criticalPath: plan.criticalPath,
      risks: plan.risks,
      circularWarnings: plan.circularWarnings,
      topologicalOrder: plan.dependencyGraph.topologicalOrder,
    },
  }
}

export async function createTask(args: {
  title: string
  spec: string
  assignee?: string
  priority?: 'low' | 'medium' | 'high'
  deps?: string[]
  /** FIX 2026-09-14 #4 — persist bền vững vào DB Todo */
  sessionId?: string
  runId?: string
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
  // FIX 2026-09-14 #4 — DB Todo bền vững (fail-open)
  const persisted = await persistDevTasksToDb([task], args)
  return {
    success: true,
    task,
    durable: persisted.persisted === 1,
    durableNote: persisted.error ? `⚠️ DB persist lỗi (${persisted.error.slice(0, 120)})` : persisted.persisted === 1 ? 'Đã lưu DB Todo (bền vững qua restart)' : undefined,
  }
}

export async function updateTask(args: {
  task_id: string
  status?: 'pending' | 'in_progress' | 'blocked' | 'completed' | 'failed'
  notes?: string
  /** FIX 2026-09-14 #4 — có sessionId thì update DB Todo (bền vững); không thì
   * chỉ in-memory như cũ (legacy callers) */
  sessionId?: string
}): Promise<unknown> {
  // ===== DB-FIRST (FIX 2026-09-14 #4): row Todo bền vững theo idempotencyKey
  // "task:T00N" — status/notes cập nhật THẬT, sống sót qua restart. =====
  if (args.sessionId && args.task_id) {
    try {
      const { db } = await import('@/lib/db')
      const row = await db.todo.findFirst({
        where: { sessionId: args.sessionId, idempotencyKey: `task:${args.task_id}` },
      })
      if (row) {
        let meta: Record<string, unknown> = {}
        try {
          meta = row.taskMetaJson ? JSON.parse(row.taskMetaJson) : {}
        } catch { /* ignore */ }
        if (args.notes !== undefined) meta.notes = args.notes
        const updated = await db.todo.update({
          where: { id: row.id },
          data: {
            ...(args.status ? { status: args.status } : {}),
            ...(args.notes !== undefined ? { taskMetaJson: JSON.stringify(meta) } : {}),
          },
        })
        // Giữ in-memory store đồng bộ (cho getPlan không có sessionId)
        const store = getTaskStore()
        const mem = store.get(args.task_id)
        if (mem) {
          if (args.status) mem.status = args.status
          if (args.notes !== undefined) mem.notes = args.notes
          mem.updatedAt = new Date().toISOString()
          store.set(args.task_id, mem)
        }
        return {
          success: true,
          task: {
            id: args.task_id,
            title: String(meta.title ?? row.content.split(' — ')[0] ?? args.task_id),
            spec: String(meta.spec ?? ''),
            assignee: (meta.assignee as string | null) ?? row.agentRole,
            priority: updated.priority as 'low' | 'medium' | 'high',
            deps: (meta.deps as string[]) ?? [],
            status: updated.status as string,
            notes: (meta.notes as string | null) ?? null,
            createdAt: row.createdAt,
            updatedAt: updated.updatedAt,
          },
          durable: true,
        }
      }
      // Row DB không có (task tạo trước fix / khác session) → fallback in-memory
    } catch { /* fail-open → in-memory path */ }
  }

  // ===== In-memory fallback (legacy) =====
  const store = getTaskStore()
  const task = store.get(args.task_id)
  if (!task) return { error: `Task not found: ${args.task_id}` }
  if (args.status) task.status = args.status
  if (args.notes !== undefined) task.notes = args.notes
  task.updatedAt = new Date().toISOString()
  store.set(args.task_id, task)
  return { success: true, task, durable: false }
}

export async function getPlan(sessionId?: string): Promise<unknown> {
  // ===== DB-FIRST (FIX 2026-09-14 #4): có sessionId → đọc DAG bền vững từ DB
  // Todo (idempotencyKey "task:*") — kế hoạch phân rã sống sót qua restart,
  // pipeline/agent sau truy vấn được kế hoạch của run trước. Fail-open →
  // in-memory như cũ. =====
  if (sessionId) {
    try {
      const { db } = await import('@/lib/db')
      const rows = await db.todo.findMany({
        where: { sessionId, idempotencyKey: { startsWith: 'task:' } },
        orderBy: { position: 'asc' },
      })
      if (rows.length > 0) {
        const tasks: DevTask[] = rows.map(r => {
          let meta: Record<string, unknown> = {}
          try {
            meta = r.taskMetaJson ? JSON.parse(r.taskMetaJson) : {}
          } catch { /* ignore */ }
          return {
            id: String(meta.taskId ?? (r.idempotencyKey ?? '').replace('task:', '')),
            title: String(meta.title ?? r.content.split(' — ')[0] ?? r.content),
            spec: String(meta.spec ?? ''),
            assignee: (meta.assignee as string | null) ?? r.agentRole,
            priority: (r.priority as 'low' | 'medium' | 'high') ?? 'medium',
            deps: (Array.isArray(meta.deps) ? meta.deps : []).map((d: unknown) => String(d)),
            status: (r.status as DevTask['status']) ?? 'pending',
            notes: (meta.notes as string | null) ?? null,
            createdAt: r.createdAt.toISOString(),
            updatedAt: r.updatedAt.toISOString(),
          }
        })
        const byStatus = {
          pending: tasks.filter(t => t.status === 'pending').length,
          in_progress: tasks.filter(t => t.status === 'in_progress').length,
          blocked: tasks.filter(t => t.status === 'blocked').length,
          completed: tasks.filter(t => t.status === 'completed').length,
          failed: tasks.filter(t => t.status === 'failed').length,
        }
        return { success: true, total: tasks.length, byStatus, tasks, durable: true }
      }
    } catch { /* fail-open → in-memory */ }
  }

  // ===== In-memory fallback (legacy — mất khi restart) =====
  const store = getTaskStore()
  const tasks = Array.from(store.values())
  const byStatus = {
    pending: tasks.filter(t => t.status === 'pending').length,
    in_progress: tasks.filter(t => t.status === 'in_progress').length,
    blocked: tasks.filter(t => t.status === 'blocked').length,
    completed: tasks.filter(t => t.status === 'completed').length,
    failed: tasks.filter(t => t.status === 'failed').length,
  }
  return { success: true, total: tasks.length, byStatus, tasks, durable: false }
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
  const root = await resolveWorkspaceRoot()
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
  const root = await resolveWorkspaceRoot()
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
  const bridgeUrl = process.env.OPENCLAW_BRIDGE_URL || 'http://127.0.0.1:18791'

  // ROUND-6 (infra-guard lớp 2): bridge tools ghi file/chạy lệnh (exec/write/
  // edit/apply_patch/code_execution/process) phải qua guard NHƯ LỚP 1 — trước
  // đây proxy chuyển tiếp thẳng tới bridge 18791, agent bypass guard hoàn toàn
  // bằng `gateway_tool {name:"write", args:{path:".env"}}` (user directive
  // 2026-10-28: "Ghi đè file bảo vệ qua shell → chặn như lớp 1").
  try {
    const root = await resolveWorkspaceRoot()
    const guard = guardBridgeToolInvocation({ name: args.name, args: args.args || {}, root })
    if (guard.blocked) {
      console.warn(`[INFRA-GUARD] bridge tool blocked: ${guard.reason}`)
      return { success: false, error: guard.message || 'TỪ CHỐI (infra-guard lớp 2)' }
    }
  } catch (guardErr) {
    // Guard lỗi (vd workspace root không resolve được) — ghi log, tool không-
    // mutating vẫn đi tiếp; bridge-side guard (round-6) vẫn chắn ở đích.
    console.warn(`[INFRA-GUARD] bridge guard error: ${guardErr instanceof Error ? guardErr.message : String(guardErr)}`)
  }

  const invoke = (): Promise<Response> => fetch(`${bridgeUrl}/tools/invoke`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: args.name, args: args.args || {} }),
    signal: AbortSignal.timeout(30_000),
  })

  const parseResponse = async (res: Response): Promise<unknown> => {
    if (!res.ok) {
      const text = await res.text().catch(() => 'unknown')
      return { success: false, error: `gateway-bridge ${res.status}: ${text.slice(0, 200)}` }
    }
    const data = await res.json() as { ok?: boolean; result?: unknown; error?: { message: string } }
    if (!data.ok && data.error) {
      return { success: false, error: `Tool error: ${data.error.message}` }
    }
    return { success: true, tool: args.name, result: data.result ?? data }
  }

  try {
    // Fast path — bridge đang chạy (chỉ ~ms)
    const first = await parseResponse(await invoke()) as { success?: boolean; error?: string }
    // Bridge trả 500 "bridge not available" = bridge process sống nhưng mất WS
    // gateway (gateway restart/crash giữa chừng) → thử tự chữa 1 lần (case a
    // của ensureBridgeRunning) thay vì trả lỗi vĩnh viễn cho agent.
    if (first && first.success === false && /bridge not available|gateway-bridge 5\d\d/i.test(String(first.error || ''))) {
      const { ensureBridgeRunning } = await import('@/lib/openclaw-ondemand')
      const g = await ensureBridgeRunning({ timeoutMs: 45_000 })
      if (g.online) return await parseResponse(await invoke())
      return { success: false, error: `${first.error} — tự chữa bridge on-demand thất bại: ${g.error || 'unknown reason'}` }
    }
    return first
  } catch (err) {
    // Task 54 FIX: bridge chưa lên (on-demand idle-shutdown 10' / app restart /
    // bridge crash trong khi gateway vẫn sống) → ensureBridgeRunning() spawn
    // bridge (18791) + gateway (18789) nếu cần rồi retry 1 lần. Trước đây fail
    // ngay "unreachable" dù message lại nói "auto-spawned" — agent không bao
    // giờ dùng được tool này trừ khi gateway tình cờ đang chạy.
    try {
      const { ensureBridgeRunning } = await import('@/lib/openclaw-ondemand')
      const g = await ensureBridgeRunning({ timeoutMs: 45_000 })
      if (!g.online) {
        return {
          success: false,
          error: `gateway-bridge unreachable (port 18791): ${err instanceof Error ? err.message : String(err)} — đã thử auto-spawn bridge on-demand nhưng thất bại: ${g.error || 'unknown reason'}`,
        }
      }
      return await parseResponse(await invoke())
    } catch (ensureErr) {
      return {
        success: false,
        error: `gateway-bridge unreachable (port 18791): ${err instanceof Error ? err.message : String(err)}. Auto-spawn failed: ${ensureErr instanceof Error ? ensureErr.message : String(ensureErr)}`,
      }
    }
  }
}

// ==================== v2.1 Phase 1a: SHELL + TODO + (quality gate is in workflow-engine) ====================

/**
 * shell — Bash with timeout + structured receipt.
 *
 * Replaces 5 of v1's specialized tools (install_package, read_logs, lint,
 * type_check, db_query, env_update) — Claude Code/Z.ai Code pattern.
 *
 * Update 2026-08-29 (user request): KHÔNG chặn sudo/rm -rf /, KHÔNG khóa cwd
 * trong workspace root — user tự chịu trách nhiệm. cwd mặc định vẫn là
 * workspace root (tiện dụng), nhưng absolute cwd ở đâu cũng được.
 *
 * - 5min default timeout, max 10min, SIGTERM then SIGKILL after 5s grace
 * - stdout/stderr truncated to 30KB with `cursor` for next call
 * - Shell metacharacters ALLOWED (|, &&, ;, >) — needed for `npm run build && npm test`
 *
 * Feature flag: ENABLE_SHELL_TOOL
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
  // cwd: mặc định workspace root (tiện cho relative paths); absolute path ở đâu
  // cũng được (user request 2026-08-29 — không khóa cwd trong root).
  const root = await resolveWorkspaceRoot()
  const cwd = args.cwd ? path.resolve(args.cwd) : root

  // INFRA GUARD (Task 24, 2026-10-21; cập nhật chính sách 2026-10-27 phiên 4):
  // chặn lệnh chạm hạ tầng VẪN ĐƯỢC BẢO VỆ khi chạy trong TMO workspace; task ở
  // workspace khác (/tmp/...) không bị ảnh hưởng. Từ 2026-10-27: lệnh cài package
  // (bun add/npm install) + prisma db push/migrate ĐÃ ĐƯỢC PHÉP (audit log qua
  // guardShellCommand). Tắt toàn bộ qua TMO_INFRA_GUARD=off.
  const guard = guardShellCommand(command, cwd, root)
  if (guard.blocked) {
    console.warn(`[INFRA-GUARD] shell blocked: ${guard.reason}`)
    return {
      success: false,
      exit_code: -1,
      stdout: '',
      stderr: guard.message || 'TỪ CHỐI (infra-guard)',
      duration_ms: 0,
      truncated: false,
      cwd,
      blocked: true,
    }
  }
  // Self-destruct guard rewrite (2026-09-29): `pm2 restart theopusflashlite`
  // đơn giản → tự đổi sang detach-safe recipe (nohup) — lệnh đến pm2 phải đi
  // từ NGOÀI process tree app, nếu không pha start của restart chết theo app.
  const effectiveCommand = guard.rewrite ?? command

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
    // (Windows: shell:true tự dùng cmd.exe; windowsHide chặn cửa sổ console
    // bật lên riêng mỗi lần agent chạy lệnh — bug fix 2026-09-06)
    const child = spawn(effectiveCommand, {
      cwd,
      shell: true,
      env: { ...process.env, ...(args.env || {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
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
 * Semantics (Claude Code-compatible + self-heal 2026-09-27):
 *   - If `id` provided và tồn tại → update existing todo by primary key
 *   - SELF-HEAL (fix E2E T29-A): nếu `id` KHÔNG tồn tại (agent tự chế id kiểu
 *     "audit-1" thay vì DB id — lỗi lặp lại từ Task 28, từng làm run kẹt
 *     STAGNANT 3 chu kỳ vì CẢ call fail) → KHÔNG fail call; rơi xuống đường
 *     upsert-theo-nội dung bên dưới (khớp content → update row thật; không
 *     khớp → tạo mới) + trả healNote chứa id thật để agent tự sửa lần sau
 *   - If `idempotencyKey` provided and exists → return existing (no duplicate)
 *   - Otherwise → create new
 *   - Max 200 todos per session (guard against runaway agents)
 *
 * CI-2 (Task 11-a) — PER-TASK TODO ISOLATION: tham số `runId` (tùy chọn) gắn
 * todo vào đúng 1 agent run (goal-loop inject runId hiện tại vào todo_write).
 *   - Create  → lưu runId lên row mới
 *   - Update  → backfill runId khi row đang null (todo tạo giữa chừng bởi path
 *              không có runId, agent update lại trong cùng run)
 *   - Dedup theo content được scope THÊM theo runId → run mới tạo row riêng,
 *              không tự ý update todo của run cũ cùng nội dung.
 *
 * Spec: docs/FULLSTACK_CAPABILITY_PLAN_V2.md Part 4 Phase 1a.2
 * Feature flag: ENABLE_TODO_TOOL (off by default per D11)
 */
export async function todoWrite(args: {
  sessionId?: string
  agentRole?: string
  /** CI-2 — run scope (runId của agent run hiện hành; bỏ trống = legacy/null) */
  runId?: string
  todos: Array<{
    id?: string
    /** BẮT BUỘC khi tạo mới; BỎ ĐƯỢC khi update theo id/idempotencyKey
     * (fix round-4 2026-09-29: trước đây validation đòi content cho TẤT CẢ
     * item → batch {id, status:'completed'} bị từ chối cả call → agent
     * không đóng được todo → 27 in_progress tồn đọng mid-run). */
    content?: string
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
  // CI-2 — run scope hiệu dụng: rỗng/whitespace → null (scope legacy)
  const runId = (typeof args.runId === 'string' && args.runId.trim() !== '') ? args.runId.trim() : null

  // TOMBSTONE GUARD (fix review 2026-09-08): session đã bị user xóa (hard-delete
  // đã purge todos) → agent chạy dở KHÔNG được đẻ todo mới cho session mồ côi.
  if (sessionId !== 'default' && isSessionDeleted(sessionId)) {
    return { success: false, error: 'Phiên chat đã bị xóa — không thể ghi todo cho phiên này.' }
  }

  // Guard against runaway agents trying to create thousands of todos.
  //
  // FIX 2026-10-30 (chu kỳ goal-loop 29): cap cũ đếm `count({ sessionId })` —
  // TẤT CẢ status kể cả completed/failed. Hệ quả: session đã chạy nhiều chu kỳ
  // tích luỹ 200+ todo đã HOÀN TẤT vẫn bị chặn vĩnh viễn, mọi todo_write
  // sau đó fail → agent mất công cụ lập kế hoạch giữa chừng (bằng chứng thực:
  // session 'sess_1790637110029_w1x31q' có 202 todo → "Todo list cap
  // exceeded: 202 existing + 0 new > 200 max per session").
  //
  // Cơ chế mới (2 tầng, TÁCH BIỆT mục đích):
  //  1) NGÂN SÁCH LẬP KẾ HOẠCH = todo CHƯA XONG (pending/in_progress/blocked).
  //     completed/failed/archived là lịch sử, KHÔNG chặn agent viết todo mới.
  //  2) HARD_MAX_TOTAL_ROWS chặn runaway DB thật sự (cao gấp 4×): chỉ archive,
  //     và chỉ purge row đã archive từ >30 ngày.
  const MAX_TODOS_PER_SESSION = 200
  // HARD_MAX_TOTAL_ROWS — trần tổng ROW/session (kể cả todo đã đóng).
  // Đặt CAO HƠN NHIỀU lần ngân sách lập kế hoạch vì mục đích chỉ là chặn
  // runaway thật sự, KHÔNG phải dọn dẹp định kỳ. KHÔNG hạ ngưỡng này xuống
  // bằng MAX_TODOS_PER_SESSION — ngưỡng lập kế hoạch bị chạm trong điều
  // kiện thường trực, dùng làm ngưỡng janitor sẽ xoá lịch sử mỗi lần ghi todo.
  const HARD_MAX_TOTAL_ROWS = MAX_TODOS_PER_SESSION * 4
  const OPEN_STATUSES = ['pending', 'in_progress', 'blocked'] as const
  const openCount = await db.todo.count({
    where: { sessionId, status: { in: [...OPEN_STATUSES] } },
  })
  const newCount = args.todos.filter(t => !t.id && !t.idempotencyKey).length
  if (openCount + newCount > MAX_TODOS_PER_SESSION) {
    return {
      success: false,
      error: `Todo list cap exceeded: ${openCount} open + ${newCount} new > ${MAX_TODOS_PER_SESSION} max per session. Mark some todos as completed or remove stale ones first.`,
    }
  }
  // JANITOR — CHẠY SÂU, chỉ khi tổng row vượt HARD_MAX_TOTAL_ROWS (800):
  // dấu hiệu runaway THẬT, KHÔNG phải dọn dẹp định kỳ.
  // Bước 1 PURGE: xoá row ĐÃ ARCHIVE từ >30 ngày (giữ 30 ngày để phục hồi).
  // Bước 2 ARCHIVE: đánh dấu todo đã đóng cũ nhất để nhường chỗ cho run mới.
  // KHÔNG xoá trực tiếp todo chưa archive — lịch sử phải còn phục hồi được.
  let evicted = 0
  const totalRows = await db.todo.count({ where: { sessionId } })
  if (totalRows + newCount > HARD_MAX_TOTAL_ROWS) {
    const purgeBefore = new Date(Date.now() - 30 * 86_400_000)
    await db.todo
      .deleteMany({ where: { sessionId, archivedAt: { not: null, lt: purgeBefore } } })
      .catch(() => null)
    const overflow = totalRows + newCount - HARD_MAX_TOTAL_ROWS
    const stale = await db.todo.findMany({
      where: { sessionId, status: { notIn: [...OPEN_STATUSES] }, archivedAt: null },
      orderBy: { updatedAt: 'asc' },
      select: { id: true },
      take: Math.min(overflow, 200),
    })
    if (stale.length > 0) {
      const res = await db.todo
        .updateMany({
          where: { id: { in: stale.map(s => s.id) } },
          data: { archivedAt: new Date() },
        })
        .catch(() => null)
      evicted = res?.count ?? 0
    }
  }

  const VALID_STATUS = new Set(['pending', 'in_progress', 'blocked', 'completed', 'failed'])
  const VALID_PRIORITY = new Set(['low', 'medium', 'high'])
  // TASK 21-d — upserted có parentId: snapshot Thought Progress (lastTodos)
  // cần parentId để render CÂY (todo con lồng todo cha) trên đường fallback.
  const upserted: Array<{ id: string; content: string; status: string; priority: string; parentId?: string | null }> = []
  // SELF-HEAL 2026-09-27 — note ánh xạ id-giết → id-thật để trả cho agent
  const healNotes: string[] = []

  for (const t of args.todos) {
    // FIX round-4 (2026-09-29, observes from goal-loop run thật): content chỉ
    // BẮT BUỘC cho todo MỚI (không id, không idempotencyKey). Update-by-id
    // chỉ cần {id, status} để đóng/mở todo — validation cũ từ chối CẢ BATCH
    // khi 1 item thiếu content (bằng chứng: checkpoint job FIX chứa
    // todo_write fail "Each todo needs a `content` string" → todo in_progress
    // không bao giờ được agent tự đóng, dồn 27 row mid-run).
    const hasContent = typeof t.content === 'string' && t.content.trim() !== ''
    if (!hasContent && !t.id && !t.idempotencyKey) {
      return { success: false, error: 'Each NEW todo needs a `content` string (todo update theo id/idempotencyKey được phép bỏ content — chỉ đổi status/priority/parentId)' }
    }
    if (t.content !== undefined && t.content !== null && typeof t.content !== 'string') {
      return { success: false, error: '`content` must be a string (nếu bỏ trống thì được — xem mô tả update-by-id)' }
    }
    if (t.status && !VALID_STATUS.has(t.status)) {
      return { success: false, error: `Invalid status: ${t.status}. Allowed: ${[...VALID_STATUS].join('|')}` }
    }
    if (t.priority && !VALID_PRIORITY.has(t.priority)) {
      return { success: false, error: `Invalid priority: ${t.priority}. Allowed: ${[...VALID_PRIORITY].join('|')}` }
    }

    // Update existing by ID
    if (t.id) {
      // CI-2 — đọc runId hiện tại để backfill: chỉ set runId khi row đang null
      // (không giành todo của run khác về run hiện tại)
      // FIX prisma:error P2025 (user report): trước đây LUÔN gọi update rồi
      // trông chờ P2025 ném "No record was found for an update" khi id không
      // tồn tại (agent hay tự chế id) — .catch(() => null) nuốt được lỗi nhưng
      // Prisma client vẫn in prisma:error ồn ra console. Giờ chỉ update khi
      // findUnique THẤY row; id không tồn tại → healNote thẳng, KHÔNG đụng DB
      // → P2025 không bao giờ xảy ra ở luồng này nữa.
      const existingById = await db.todo.findUnique({
        where: { id: t.id },
        select: { runId: true },
      }).catch(() => null)
      if (existingById) {
        const updated = await db.todo.update({
          where: { id: t.id },
          data: {
            // round-4: content-less update (chỉ {id, status}) → KHÔNG đè
            // nội dung cũ bằng undefined; Prisma bỏ qua field undefined.
            ...(hasContent ? { content: t.content } : {}),
            status: t.status || undefined,
            priority: t.priority || undefined,
            parentId: t.parentId || undefined,
            ...(runId && !existingById.runId ? { runId } : {}),
          },
        }).catch(() => null) // race guard: row bị xóa giữa find & update (hiếm)
        if (updated) {
          upserted.push({
            id: updated.id,
            content: updated.content,
            status: updated.status,
            priority: updated.priority,
            parentId: updated.parentId,
          })
          continue
        }
      }
      // SELF-HEAL 2026-09-27 (fix E2E T29-A): id KHÔNG tồn tại (hoặc update
      // race fail) — trước đây return error làm CẢ call fail → agent không
      // ghi được kế hoạch, STALL 3 chu kỳ liên tiếp, run chết no_progress
      // (bằng chứng: session E2E T29-A todo_write "audit-1" → "Todo not
      // found"). Giờ: đánh dấu heal và rơi xuống đường upsert-theo-nội
      // dung/idempotency bên dưới — khớp content trong (sessionId, runId) →
      // update row thật; không khớp → tạo mới. healNote cho agent biết id
      // thật (chống lặp lại id chế).
      healNotes.push(`id '${t.id}' không tồn tại — đã xử lý như upsert theo nội dung`)
    }

    // Idempotent create by idempotencyKey
    if (t.idempotencyKey) {
      const existing = await db.todo.findFirst({
        where: { sessionId, idempotencyKey: t.idempotencyKey },
      })
      if (existing) {
        // round-4: repeat-call cùng key nhưng KÈM status/priority mới (vd
        // {idempotencyKey, status:'completed'} không content) → ÁP DỤNG luôn
        // thay vì chỉ trả existing (trước đây status update bị bỏ âm thầm).
        let row = existing
        if (t.status || t.priority || t.parentId || (hasContent && t.content !== existing.content)) {
          row = (await db.todo.update({
            where: { id: existing.id },
            data: {
              ...(hasContent ? { content: t.content } : {}),
              status: t.status || undefined,
              priority: t.priority || undefined,
              parentId: t.parentId || undefined,
            },
          }).catch(() => existing)) || existing
        }
        upserted.push({
          id: row.id,
          content: row.content,
          status: row.status,
          priority: row.priority,
          parentId: row.parentId,
        })
        if (healNotes.length > 0 && healNotes[healNotes.length - 1].startsWith(`id '${t.id}'`)) {
          healNotes[healNotes.length - 1] = `id '${t.id}' không tồn tại → khớp idempotencyKey, dùng lại row thật ${existing.id} (dùng id này cho lần sau)`
        }
        continue
      }
    }

    // FIX 2026-08-27 (user bug report): dedup theo (sessionId, content).
    // Agents không biết DB row IDs — khi gọi todo_write lần 2 với cùng nội dung
    // (VD: đánh dấu "Đọc file X" → completed), code cũ tạo ROW MỚI → panel
    // "Agent Tasks" hiển thị 8 rows trùng lặp: 4 pending gốc + 4 completed mới,
    // và badge "4 đang chạy" không bao giờ tắt. Giờ: nếu đã có row cùng content
    // trong session → UPDATE row đó thay vì create.
    // CI-2 (Task 11-a): scope dedup THÊM theo runId — cùng nội dung nhưng khác
    // run (tác vụ khác) thì tạo row riêng cho run mới, không đụng todo run cũ
    // (chống trộn task — bug "todo của task trước dồn vào task mới").
    // round-4: content-less update (id không tồn tại, không idempotencyKey)
    // → KHÔNG vào dedup theo content (không có gì để khớp) — healNote + bỏ qua,
    // không tạo row rỗng.
    if (!hasContent) {
      healNotes.push(`todo id '${t.id || t.idempotencyKey}' không tồn tại và không có content — bỏ qua (không tạo mới; gửi kèm content nếu muốn tạo)`)
      continue
    }
    const existingByContent = await db.todo.findFirst({
      where: { sessionId, content: t.content, runId },
      orderBy: { createdAt: 'asc' },
    })
    if (existingByContent) {
      const updated = await db.todo.update({
        where: { id: existingByContent.id },
        data: {
          status: t.status || existingByContent.status,
          priority: t.priority || existingByContent.priority,
          parentId: t.parentId || existingByContent.parentId,
          ...(runId && !existingByContent.runId ? { runId } : {}),
        },
      }).catch(() => null)
      if (updated) {
        upserted.push({
          id: updated.id,
          content: updated.content,
          status: updated.status,
          priority: updated.priority,
          parentId: updated.parentId,
        })
        if (healNotes.length > 0 && healNotes[healNotes.length - 1].startsWith(`id '${t.id || ''}'`)) {
          healNotes[healNotes.length - 1] = `id '${t.id}' không tồn tại → khớp nội dung, đã update row thật ${updated.id} (dùng id này cho lần sau)`
        }
        continue
      }
    }

    // Create new (hasContent đã được đảm bảo bởi guard round-4 phía trên)
    const created = await db.todo.create({
      data: {
        sessionId,
        agentRole,
        content: t.content as string,
        status: t.status || 'pending',
        priority: t.priority || 'medium',
        parentId: t.parentId || null,
        idempotencyKey: t.idempotencyKey || null,
        runId,
      },
    })
    upserted.push({
      id: created.id,
      content: created.content,
      status: created.status,
      priority: created.priority,
      parentId: created.parentId,
    })
    if (healNotes.length > 0 && healNotes[healNotes.length - 1].startsWith(`id '${t.id || ''}'`)) {
      healNotes[healNotes.length - 1] = `id '${t.id}' không tồn tại → đã TẠO MỚI todo ${created.id} (dùng id này cho lần sau, đừng tự chế id)`
    }
  }

  // ===== TODO-COVERAGE (2026-10-22 hướng 1+2) — kiểm tra phủ kế hoạch =====
  // determinstic NGAY trong todo_write: (1) mỗi [Nghiệm thu n] của directive
  // (RunContext.acceptanceCriteria — stash lúc run start) ≥1 todo · (2) mỗi
  // mục "cần đọc" trong 📐 (RunContext.dataScope) ≥1 todo thu thập. Thiếu →
  // đính ⚠️ block vào RESULT (agent thấy ở lượt LLM kế — bổ sung trong CÙNG
  // chu kỳ). Đủ → dòng ✅ xác nhận. Không có RunContext/nghiệm thu/📐 (task
  // đơn giản, self-direction sd-*, run legacy) → KHÔNG đính (chống nhiễu).
  // Fail-open: lỗi check không được phép làm hỏng todo_write.
  let coverage: unknown = undefined
  if (runId) {
    try {
      const { checkRunTodoCoverage } = await import('@/lib/todo-coverage')
      const report = await checkRunTodoCoverage({ sessionId, runId })
      if (report) {
        coverage = {
          ok: report.ok,
          acceptance: report.acceptanceTotal > 0 ? `${report.acceptanceCovered}/${report.acceptanceTotal}` : null,
          dataScope: report.dataScopeTotal > 0 ? `${report.dataScopeCovered}/${report.dataScopeTotal}` : null,
          warning: report.warning,
        }
        if (!report.ok) {
          console.log(`[TodoCoverage] run ${runId}: CHƯA PHỦ — nghiệm thu ${report.acceptanceCovered}/${report.acceptanceTotal}, 📐 ${report.dataScopeCovered}/${report.dataScopeTotal} → đã cảnh báo agent bổ sung`)
        } else {
          console.log(`[TodoCoverage] run ${runId}: PHỦ ĐỦ — nghiệm thu ${report.acceptanceCovered}/${report.acceptanceTotal}, 📐 ${report.dataScopeCovered}/${report.dataScopeTotal}`)
        }
      }
    } catch { /* fail-open */ }
  }

  // ===== PROBLEM-HANDLING HINT (2026-10-22 — Flaw→Resolver, SDA_ENT_054/055)
  // =====
  // Agent vừa đánh dấu todo failed/blocked → đính nhắc QUY TRÌNH xử lý vấn đề
  // vào result (determinstic — không tin agent tự nhớ protocol GĐ2): chẩn đoán
  // theo phân loại rồi chọn resolver tương ứng, không thử lặp y hệt. Im lặng
  // khi không có todo nào failed/blocked (chống nhiễu).
  const flaggedCount = upserted.filter(t => t.status === 'failed' || t.status === 'blocked').length

  return {
    success: true,
    sessionId,
    runId,
    // coverage + healNotes + problemHint đặt TRƯỚC todos: bridge CLI (callTmoTool)
    // cap kết quả 2000 ký tự và cắt CUỐI — warning phải sống sót kể cả khi danh
    // sách todo dài (agent CLI cần thấy yêu cầu bổ sung ngay).
    ...(coverage !== undefined ? { coverage } : {}),
    ...(healNotes.length > 0 ? { healNotes } : {}),
    ...(flaggedCount > 0 ? {
      problemHint: `🔧 ${flaggedCount} todo failed/blocked — XỬ LÝ THEO QUY TRÌNH (không thử lặp y hệt >2 lần): (1) chẩn đoán nguyên nhân bằng bằng chứng (đọc error, grep, file_read); (2) chọn resolver: thu thập dữ liệu / tách todo con phần hỏng / ĐỔI HƯỚNG nếu hướng hiện tại không thể đạt; (3) tạo todo con kế hoạch xử lý hoặc ghi rõ phương án thay thế trong todo. Todo failed/blocked không có hướng xử lý sẽ bị evaluator chấm thiếu ở cuối chu kỳ.`,
    } : {}),
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

// ==================== CI-2 (Task 11-a) — PER-TASK TODO ISOLATION LIFECYCLE ====================
//
// Bộ 3 helper điều phối vòng đời todo theo runId (được gọi từ chat route +
// goal loop; xem docs/CODE_EXECUTION_IMPROVEMENT_ROADMAP.md CI-2):
//   1. archiveStaleRunTodos      — run MỚI bắt đầu → lưu trữ todo còn mở của các run TRƯỚC
//   2. closeRunTodosAtEnd        — run kết thúc → đóng per-item TRUNG THỰC theo verdict
//   3. autoCompleteRunTodosByEvidence — giữa chừng run → auto-complete theo bằng chứng tool
//
// Nguyên tắc: todo có runId=null (legacy, trước CI-2) KHÔNG BAO GIỜ bị các
// helper này đụng tới — hiển thị theo session như cũ, không bị archive/đóng.

/**
 * CI-2 — Lưu trữ (archive) mọi todo CÒN ĐANG MỞ (pending/in_progress/blocked)
 * của các run TRƯỚC trong session (runId KHÁC null) ngay trước khi run mới bắt
 * đầu → status 'archived' + archivedAt = now.
 *
 * Tại sao archive thay vì xóa: (a) giữ lịch sử trung thực — todo của task cũ
 * vẫn tra cứu được qua /api/todos (không lọc archived), (b) an toàn khi có
 * request cũ của run trước vẫn đang chạy dở và update status — run mới không
 * nhìn thấy chúng (UI 11-b lọc theo runId), status 'archived' tự nói lên
 * "thuộc task cũ, đã bị lưu trữ".
 *
 * Todo runId=null (legacy) được GIỮ NGUYÊN — hành vi cũ không đổi.
 *
 * @returns số todo đã archive (0 nếu không có gì để archive)
 */
export async function archiveStaleRunTodos(sessionId: string): Promise<number> {
  try {
    if (!sessionId) return 0
    // FIX review GĐ2 LOW#2: bỏ qua todo của run VẪN ĐANG CHẠY trong session
    // (goal-loop đồng thời — run mới archive nhầm todo run đang sống thì
    // honest-close của run đó sẽ không còn thấy gì để đóng)
    const activeRunId = getActiveRunId(sessionId)
    const res = await db.todo.updateMany({
      where: {
        sessionId,
        runId: { not: null },
        ...(activeRunId ? { runId: { not: activeRunId } } : {}),
        status: { in: ['pending', 'in_progress', 'blocked'] },
        // 2026-10-27 (user directive — NỢ KỸ THUẬT sống qua archive): Todo
        // follow-up ("🔁 Follow-up...") là NỢ KỸ THUẬT hệ thống ghi ở cuối run
        // cho RUN SAU xử lý — KHÔNG phải todo task của run cũ. Nếu archive chúng
        // ở đầu run mới thì buildPendingDebtBlock (cơ chế xử lý nợ đầu run —
        // user directive 2026-10-27) không bao giờ thấy → nợ ngủ vĩnh viễn.
        // Giữ nguyên pending; agent xử lý xong tự đánh completed qua todo_write.
        NOT: { content: { startsWith: '🔁 Follow-up' } },
      },
      data: { status: 'archived', archivedAt: new Date() },
    })
    if (res.count > 0) {
      console.log(`[Todo CI-2] Archived ${res.count} stale todo(s) của các run trước trong session ${sessionId} (run mới bắt đầu)`)
    }
    return res.count
  } catch (err) {
    // Fail-open — isolation là UI concern, không được làm hỏng chat request
    console.warn('[Todo CI-2] archiveStaleRunTodos failed:', err instanceof Error ? err.message : String(err))
    return 0
  }
}

/**
 * CI-2 — Đóng todo per-item TRUNG THỰC khi run kết thúc (thay cho bulk-close
 * "TẤT CẢ → completed/failed" cũ vốn quá thô — todo chưa từng làm mà bị đánh
 * ✓ là đóng ảo).
 *
 * Chỉ đóng todo của ĐÚNG run này (runId = currentRunId); runId=null fallback
 * về scope legacy của session (todo không gắn run — hành vi tương đương cũ).
 *
 * Luật đóng (theo verdict goal-loop):
 *   - 'in_progress'  → goal đạt: 'completed' | chưa đạt: 'failed' (đã bắt tay
 *                      làm mà dở — failed là trung thực)
 *   - 'pending'      → goal đạt: 'completed' | chưa đạt: GIỮ 'pending' +
 *                      archivedAt=now (chưa từng bắt tay — không đổ lỗi
 *                      'failed'; archivedAt để ẩn khỏi run kế tiếp)
 *   - crash=true (run văng exception) → in_progress → 'failed', pending →
 *                      'archived' ngay (run đã chết, không còn cơ resume)
 *
 * @returns số liệu đóng theo từng loại (để log/verify, không dùng cho flow)
 */
export async function closeRunTodosAtEnd(params: {
  sessionId: string
  /** runId của run vừa kết thúc; null → scope todo legacy (runId null) của session */
  runId: string | null
  /** verdict goal-loop: true = mục tiêu hoàn thành */
  goalComplete: boolean
  /** Run crash (exception bắn ra ngoài goal loop) → đóng cứng pending thành archived */
  crash?: boolean
}): Promise<{ inProgressClosed: number; pendingCompleted: number; pendingArchived: number }> {
  const { sessionId, runId, goalComplete, crash } = params
  const out = { inProgressClosed: 0, pendingCompleted: 0, pendingArchived: 0 }
  try {
    if (!sessionId) return out
    // Scope: đúng run này. runId null (tracker fail) → đóng scope legacy của
    // session — todos do run này tạo cũng runId=null (goal-loop chỉ inject
    // runId khi startAgentRun thành công) nên vẫn được đóng đúng.
    const scope: { sessionId: string; runId: string | null } = { sessionId, runId }

    // 2026-10-27 (rà soát Task 27-a — BUG nợ tự đóng): Todo follow-up
    // ("🔁 Follow-up...") là NỢ KỸ THUẬT hệ thống ghi ở cuối run (nhánh
    // complete + ghi nợ) cho RUN SAU xử lý — nếu bulk-close dưới đây ép chúng
    // thành completed/failed/archived thì buildPendingDebtBlock (chỉ nhặt nợ
    // còn treo) không bao giờ thấy → nợ ngủ vĩnh viễn (bằng chứng DB thật:
    // 2 todo arbiter_side_issue bị completed sau +74ms). Giữ nguyên mọi trạng
    // thái; agent xử lý xong tự đánh completed qua todo_write update-by-id.
    const KEEP_DEBT = { NOT: { content: { startsWith: '🔁 Follow-up' } } } as const

    // 1) in_progress → completed (đạt) | failed (chưa đạt / crash)
    // FIX review GĐ2 LOW#4: 'blocked' đóng cùng nhóm in_progress (đã bắt tay,
    // bị chặn — verdict cuối quyết định completed/failed, không để kẹt mãi)
    const ip = await db.todo.updateMany({
      where: { ...scope, status: 'in_progress', ...KEEP_DEBT },
      data: { status: goalComplete ? 'completed' : 'failed' },
    })
    out.inProgressClosed = ip.count
    const bl = await db.todo.updateMany({
      where: { ...scope, status: 'blocked', ...KEEP_DEBT },
      data: { status: goalComplete ? 'completed' : 'failed' },
    })
    out.inProgressClosed += bl.count

    // 2) pending — tùy verdict
    if (goalComplete) {
      // Mục tiêu đạt → kế hoạch được coi là hoàn thành trọn vẹn
      const pc = await db.todo.updateMany({
        where: { ...scope, status: 'pending', ...KEEP_DEBT },
        data: { status: 'completed' },
      })
      out.pendingCompleted = pc.count
    } else if (crash) {
      // Run chết giữa chừng → archived ngay (không thể resume)
      const pa = await db.todo.updateMany({
        where: { ...scope, status: 'pending', ...KEEP_DEBT },
        data: { status: 'archived', archivedAt: new Date() },
      })
      out.pendingArchived = pa.count
    } else {
      // Chưa đạt nhưng report trung thực: pending giữ nguyên (chưa làm gì sai)
      // + archivedAt để ẩn khỏi run kế tiếp
      const pa = await db.todo.updateMany({
        where: { ...scope, status: 'pending', ...KEEP_DEBT },
        data: { archivedAt: new Date() },
      })
      out.pendingArchived = pa.count
    }
    return out
  } catch (err) {
    // Fail-open — không được phép làm hỏng chat response
    console.warn('[Todo CI-2] closeRunTodosAtEnd failed:', err instanceof Error ? err.message : String(err))
    return out
  }
}

/**
 * USER DIRECTIVE 2026-09-28 ("không bỏ sót đánh dấu hoàn thành") — bộ evidence
 * dùng CHUNG cho 2 đường thu bằng chứng:
 *   - Đường ReAct TMO (agent-goal-loop — sau mỗi batch tool call thành công)
 *   - Đường CLI inner-loop (/api/tools/execute — opencode bridge tmo_* tools)
 * Chỉ tool THAY ĐỔI thật mới sinh evidence (FIX review GĐ2 #1: read-only
 * KHÔNG tính — đọc xong chưa nghĩa là làm xong):
 *   - shell/run_bg → lệnh shell (≥6 ký tự)
 *   - tool sửa file → đường dẫn chính (args.path/file_path, chứa '/' hoặc '.')
 *   - gateway_edit/write/apply_patch → path (bổ sung 2026-09-28 — gateway
 *     tools sửa file qua bridge cũng là bằng chứng hoàn thành hợp lệ)
 */
export const TODO_EVIDENCE_MODIFY_TOOLS = new Set([
  'file_edit', 'file_multi_edit', 'file_write', 'file_delete', 'opencode',
  'gateway_edit', 'gateway_write', 'gateway_apply_patch',
])
/**
 * IMP-2 (F3 — điều tra Task F "todo drift"): bộ evidence YẾU cho tool KIỂM ĐỊNH /
 * PROBE. Todo dạng kiểm thử/tổng hợp ("Test custom tools: list_custom_tools + gọi
 * thử", "chạy lint src/x.ts", "run_tests tests/y.test.ts"...) trước đây KHÔNG BAO
 * GIỜ khớp evidence (bộ cũ chỉ tool THAY ĐỔI sinh evidence) → kẹt in_progress /
 * pending đến tận cuối run mới bị honest-close. Evidence yếu mang tiền tố
 * "weak:" — evidenceMatchesTodo chỉ chấp nhận khi todo TỰ NHẮC tên tool đó
 * (chạy lint file X ≠ đã sửa file X — chống khớp giả todo "sửa file X").
 * (http_probe không tồn tại trong tool registry TMO — web_fetch với args.url là
 * probe HTTP tương đương.)
 */
export const TODO_EVIDENCE_VERIFY_TOOLS = new Set([
  'run_tests', 'lint', 'type_check', 'list_custom_tools', 'web_fetch',
])
export function extractTodoEvidence(toolName: string, args: Record<string, unknown> | undefined): string | null {
  try {
    if (!args || typeof args !== 'object') return null
    if (toolName === 'shell' || toolName === 'run_bg') {
      const cmd = (args as { command?: unknown }).command
      if (typeof cmd === 'string' && cmd.trim().length >= 6) return cmd.trim()
      return null
    }
    // IMP-2 (F3) — tool kiểm định/probe: target arg làm bằng chứng YẾU. Không có
    // target (vd list_custom_tools {}, lint không path) → chính tên tool là
    // evidence (todo phải nhắc tên tool để khớp — xem matcher).
    if (TODO_EVIDENCE_VERIFY_TOOLS.has(toolName)) {
      const target = (args as { target?: unknown }).target
        ?? (args as { path?: unknown }).path
        ?? (args as { file_path?: unknown }).file_path
        ?? (args as { url?: unknown }).url
      if (typeof target === 'string' && target.trim().length >= 3) {
        return `weak:${toolName} ${target.trim()}`
      }
      return `weak:${toolName}`
    }
    if (!TODO_EVIDENCE_MODIFY_TOOLS.has(toolName)) return null
    const p = (args as { path?: unknown }).path ?? (args as { file_path?: unknown }).file_path
    if (typeof p === 'string' && p.length >= 3 && (p.includes('/') || p.includes('.'))) return p
    return null
  } catch {
    return null
  }
}

/**
 * USER DIRECTIVE 2026-09-28 — matcher bằng chứng ↔ nội dung todo mạnh hơn
 * substring chính xác cũ (bỏ sót thực tế: todo ghi path tương đối
 * "src/lib/llm.ts" nhưng evidence là path tuyệt đối "/home/z/tmo-app/src/
 * lib/llm.ts" → includes() 2 chiều đều fail; todo "chạy db:push" vs lệnh
 * "cd /home/z/tmo-app && bun run db:push"). Vẫn bảo thủ chống khớp giả:
 * mọi rule đều khớp chuỗi CỤ THỂ (path/basename/segment lệnh/span code) —
 * văn tự tiếng Việt của todo không thể khớp giả với evidence ASCII.
 *
 * IMP-2 (F3): xuất khẩu để goal-loop reconcile ranh giới chu kỳ dùng chung 1
 * bộ luật khớp (đếm todo in_progress "có bằng chứng chu kỳ này hay không").
 */
const WEAK_EVIDENCE_PREFIX = 'weak:'

export function evidenceMatchesTodo(ev: string, todoContent: string): boolean {
  const e = ev.toLowerCase().replace(/\\/g, '/').trim()
  const t = todoContent.toLowerCase().replace(/\\/g, '/').replace(/\s+/g, ' ').trim()
  if (e.length < 3 || t.length < 3) return false

  // IMP-2 (F3) — evidence YẾU ("weak:<tool> [target]" — tool kiểm định/probe):
  // todo phải TỰ NHẮC TÊN TOOL (chạy lint X ≠ đã sửa X — todo "sửa file X"
  // không nhắc lint → không khớp); target (nếu có) phải khớp bằng rule mạnh
  // phía dưới (đệ quy 1 tầng — target thô không mang tiền tố weak:).
  if (e.startsWith(WEAK_EVIDENCE_PREFIX)) {
    const body = e.slice(WEAK_EVIDENCE_PREFIX.length).trim()
    const sp = body.indexOf(' ')
    const toolName = (sp >= 0 ? body.slice(0, sp) : body).trim()
    const target = sp >= 0 ? body.slice(sp + 1).trim() : ''
    if (!toolName || !t.includes(toolName)) return false
    if (!target) return true
    return evidenceMatchesTodo(target, todoContent)
  }

  // (1) Substring chính xác — hành vi cũ, giữ nguyên
  if (t.includes(e)) return true

  // (2) Evidence là đường dẫn (có '/' hoặc đuôi file): khớp BASENAME trong
  // todo (todo hay ghi tên file ngắn "sửa schema.prisma") hoặc path-full
  const looksLikePath = e.includes('/') || /\.[a-z0-9]{1,8}$/.test(e)
  if (looksLikePath) {
    const base = e.split('/').pop() || ''
    if (base.length >= 5 && t.includes(base)) return true
    // Path token của todo ("prisma/schema.prisma", ".env", "llm.ts") xuất
    // hiện trong evidence (todo tương đối ↔ evidence tuyệt đối và ngược lại)
    const todoPaths = todoContent.match(/[\w.@-]+(?:\/[\w.@-]+)+|\b[\w-]+\.(?:ts|tsx|js|jsx|json|md|prisma|py|yaml|yml|toml|sql|cjs|mjs)\b|\.env(?:\.[\w.]+)?/gi) || []
    if (todoPaths.some(p => p.length >= 5 && e.includes(p.toLowerCase()))) return true
  }

  // (3) Evidence là lệnh shell: tách segment theo && ; | — segment đủ dài
  // xuất hiện trong todo ("bun run db:push" trong "cd /app && bun run db:push")
  const segments = ev.split(/&&|\|\||;|\|/).map(s => s.trim()).filter(s => s.length >= 8)
  if (segments.some(seg => t.includes(seg.toLowerCase()))) return true

  // (4) Todo chứa span code/backtick (`bun run db:push`, `schema.prisma`)
  // hoặc command colon-style (db:push, db:generate) — xuất hiện trong evidence
  const todoSpans = todoContent.match(/`[^`]{6,}`/g) || []
  if (todoSpans.some(sp => e.includes(sp.slice(1, -1).toLowerCase().trim()))) return true
  const todoColonCmds = todoContent.match(/\b[a-z][a-z0-9_-]*(?::[a-z0-9_.-]+){1,}\b/g) || []
  if (todoColonCmds.some(c => c.length >= 6 && e.includes(c.toLowerCase()))) return true

  return false
}

/**
 * CI-2 — Auto-complete todo THEO BẰNG CHỨNG giữa chừng run (sau mỗi batch tool
 * call): todo của run hiện tại, nếu nội dung todo khớp bằng chứng của một
 * tool call THÀNH CÔNG (file sửa thật / lệnh shell chạy thật) → đánh dấu
 * 'completed' ngay (LLM thường quên gọi todo_write lần cuối — đây là lưới
 * an toàn dựa trên bằng chứng thật, không tin lời tuyên bố).
 *
 * USER DIRECTIVE 2026-09-28 ("không bỏ sót"): mở rộng PHẠM VI từ chỉ
 * 'in_progress' → CẢ 'pending' + 'blocked'. LLM agent hay làm việc khi todo
 * vẫn còn pending (quên đánh dấu in_progress trước khi làm) → việc ĐÃ xong
 * nhưng không bao giờ được đánh dấu → bỏ sót. Evidence vẫn bảo thủ (tool THAY
 * ĐỔI thành công + IMP-2 F3: tool kiểm định/probe thành công dưới dạng evidence
 * YẾU "weak:" — xem extractTodoEvidence), matcher mạnh hơn (xem
 * evidenceMatchesTodo) nhưng mọi rule đều khớp chuỗi cụ thể.
 *
 * @returns { completed, todos } — todos = danh sách todo hiện tại của run
 * (orderBy position) để caller snapshot qua recordAgentRunTodos
 */
export async function autoCompleteRunTodosByEvidence(params: {
  sessionId: string
  runId: string | null
  /** Chuỗi bằng chứng: đường dẫn file / lệnh shell từ tool call thành công */
  evidence: string[]
}): Promise<{ completed: number; todos: Array<{ id: string; content: string; status: string; priority: string; position: number; parentId: string | null }> }> {
  const { sessionId, runId, evidence } = params
  try {
    if (!sessionId || !runId || !Array.isArray(evidence) || evidence.length === 0) {
      return { completed: 0, todos: [] }
    }
    // Lọc bằng chứng hợp lệ (không rỗng, đủ dài để tránh khớp giả)
    const evs = evidence
      .map(e => (typeof e === 'string' ? e.trim() : ''))
      .filter(e => e.length >= 3)
    if (evs.length === 0) return { completed: 0, todos: [] }

    const open = await db.todo.findMany({
      where: { sessionId, runId, status: { in: ['in_progress', 'pending', 'blocked'] } },
      orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
    })
    let completed = 0
    for (const t of open) {
      const hit = evs.some(ev => evidenceMatchesTodo(ev, t.content))
      if (!hit) continue
      await db.todo
        .update({ where: { id: t.id }, data: { status: 'completed' } })
        .catch(() => null)
      completed++
    }
    // Trả danh sách todo HIỆN TẠI của run (sau update) để caller snapshot
    // TASK 21-d: kèm parentId — snapshot Thought Progress render cây được.
    const todos = await db.todo.findMany({
      where: { sessionId, runId },
      orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
      select: { id: true, content: true, status: true, priority: true, position: true, parentId: true },
    })
    if (completed > 0) {
      console.log(`[Todo CI-2] Auto-completed ${completed} todo (pending/in_progress/blocked) theo bằng chứng tool trong run ${runId}`)
    }
    return { completed, todos }
  } catch (err) {
    // Fail-open — không được phép làm hỏng goal loop
    console.warn('[Todo CI-2] autoCompleteRunTodosByEvidence failed:', err instanceof Error ? err.message : String(err))
    return { completed: 0, todos: [] }
  }
}

// ==================== DYNAMIC SKILL + MCP ENUMERATION (user request 2026-08-29) ====================
//
// "Agents có khả năng liệt kê skills động chưa, có tự scan được skill registry
// không" + "MCP servers... Agents có tự enumerate được không".
// Trước đây skills chỉ được inject TĨNH vào system prompt (bị truncate 16K
// chars) — agent không tự liệt kê/tra cứu được runtime. 3 tool dưới cho agent
// khả năng scan registry bất cứ lúc nào trong ReAct loop.

/**
 * Parse front-matter (name/description) từ nội dung SKILL.md dạng text —
 * không pull thêm dependency front-matter parser.
 */
function parseSkillFrontMatter(md: string): { name?: string; description?: string } {
  const out: { name?: string; description?: string } = {}
  const fmMatch = md.match(/^---\n([\s\S]*?)\n---/)
  if (fmMatch) {
    const nameM = fmMatch[1].match(/^name:\s*(.+)$/m)
    const descM = fmMatch[1].match(/^description:\s*(.+)$/m)
    if (nameM) out.name = nameM[1].trim()
    if (descM) out.description = descM[1].trim()
  }
  return out
}

/**
 * list_skills — scan skill registry ĐỘNG từ 3 nguồn:
 *   1. DB AgentSkill (enabled) — skill do user tạo/quản lý qua UI
 *   2. Filesystem skills/<slug>/SKILL.md — 60+ clawhub skills cài sẵn
 *   3. 5 dịch vụ API key-pool (tavily/serper/jina/web_search/page_reader)
 * Trả danh sách gọn (tên + mô tả ngắn) để agent quyết định dùng skill nào,
 * sau đó read_skill({slug}) để đọc nội dung đầy đủ.
 */
export async function listSkills(args: { source?: 'db' | 'filesystem' | 'services' | 'all' }): Promise<unknown> {
  const source = args?.source || 'all'
  const result: Record<string, unknown> = { success: true, source }

  // 1. DB skills
  if (source === 'all' || source === 'db') {
    try {
      const skills = await db.agentSkill.findMany({
        where: { enabled: true },
        select: { name: true, slug: true, source: true, content: true },
        orderBy: { name: 'asc' },
      })
      result.dbSkills = skills.map(s => ({
        slug: s.slug,
        name: s.name,
        source: s.source,
        description: (parseSkillFrontMatter(s.content).description || s.content.slice(0, 120)).replace(/\n/g, ' '),
        chars: s.content.length,
      }))
      result.dbSkillCount = skills.length
    } catch (err) {
      result.dbSkills = []
      result.dbSkillError = err instanceof Error ? err.message : String(err)
    }
  }

  // 2. Filesystem skills (clawhub — 60+ skills)
  if (source === 'all' || source === 'filesystem') {
    try {
      const skillsDir = path.join(process.cwd(), 'skills')
      const dirs = await fs.readdir(skillsDir)
      const fsSkills: Array<{ slug: string; name: string; description: string }> = []
      for (const d of dirs.sort()) {
        try {
          const md = await fs.readFile(path.join(skillsDir, d, 'SKILL.md'), 'utf-8')
          const fm = parseSkillFrontMatter(md)
          fsSkills.push({
            slug: d,
            name: fm.name || d,
            description: (fm.description || '').slice(0, 160),
          })
        } catch { /* không phải skill dir */ }
      }
      result.filesystemSkills = fsSkills
      result.filesystemSkillCount = fsSkills.length
    } catch (err) {
      result.filesystemSkills = []
      result.filesystemSkillError = err instanceof Error ? err.message : String(err)
    }
  }

  // 3. API-key services (5 skill nền tảng)
  if (source === 'all' || source === 'services') {
    try {
      const { tavilyKeyPool, serperKeyPool, jinaKeyPool } = await import('@/lib/service-key-pool')
      result.services = [
        { slug: 'tavily', name: 'Tavily', kind: 'web search', keysAvailable: `${tavilyKeyPool.getAvailableCount()}/${tavilyKeyPool.getTotalCount()}`, fallback: 'z-ai-sdk web_search' },
        { slug: 'serper', name: 'Serper', kind: 'google search', keysAvailable: `${serperKeyPool.getAvailableCount()}/${serperKeyPool.getTotalCount()}`, fallback: 'z-ai-sdk web_search' },
        { slug: 'jina', name: 'Jina Reader', kind: 'page reader', keysAvailable: `${jinaKeyPool.getAvailableCount()}/${jinaKeyPool.getTotalCount()}`, fallback: 'z-ai-sdk page_reader' },
        { slug: 'web_search', name: 'Web Search SDK', kind: 'web search', keysAvailable: 'unlimited (sdk)', fallback: null },
        { slug: 'page_reader', name: 'Page Reader SDK', kind: 'page reader', keysAvailable: 'unlimited (sdk)', fallback: null },
      ]
    } catch (err) {
      result.servicesError = err instanceof Error ? err.message : String(err)
    }
  }

  // Guide ngắn cho agent
  result._usage = 'Gọi read_skill({"slug":"<slug>"}) để đọc nội dung đầy đủ 1 skill trước khi dùng nó.'
  return result
}

/**
 * read_skill — đọc nội dung đầy đủ của 1 skill theo slug.
 * Thứ tự tra cứu: DB AgentSkill (enabled) → filesystem skills/<slug>/SKILL.md.
 * Truncate 30K chars để không phá context window.
 */
export async function readSkill(args: { slug: string }): Promise<unknown> {
  if (!args?.slug || typeof args.slug !== 'string') {
    return { success: false, error: 'slug là bắt buộc — gọi list_skills({}) để xem danh sách' }
  }
  const slug = args.slug.trim()
  const MAX_CHARS = 30_000

  // DB trước (skill user tạo có nội dung tùy biến)
  try {
    const dbSkill = await db.agentSkill.findFirst({
      where: { OR: [{ slug }, { name: slug }], enabled: true },
      select: { name: true, slug: true, source: true, content: true },
    })
    if (dbSkill) {
      return {
        success: true,
        source: `db:${dbSkill.source}`,
        slug: dbSkill.slug,
        name: dbSkill.name,
        content: dbSkill.content.slice(0, MAX_CHARS),
        truncated: dbSkill.content.length > MAX_CHARS || undefined,
      }
    }
  } catch { /* fallthrough */ }

  // Filesystem
  try {
    const md = await fs.readFile(path.join(process.cwd(), 'skills', slug, 'SKILL.md'), 'utf-8')
    const fm = parseSkillFrontMatter(md)
    return {
      success: true,
      source: 'filesystem',
      slug,
      name: fm.name || slug,
      content: md.slice(0, MAX_CHARS),
      truncated: md.length > MAX_CHARS || undefined,
    }
  } catch {
    return { success: false, error: `Không tìm thấy skill "${slug}" — gọi list_skills({}) để xem danh sách slug hợp lệ` }
  }
}

/**
 * mcp_list_servers — agents TỰ ENUMERATE MCP servers runtime.
 * Gộp: built-in MCP servers (mcp-bridge) + bridge inbound/outbound tools
 * (OpenClaw↔OpenCode) + trạng thái feature flag mcp_call.
 */
export async function mcpListServers(): Promise<unknown> {
  try {
    const { listAvailableServers } = await import('@/lib/mcp/mcp-bridge')
    const servers = await listAvailableServers()
    const mcpCallEnabled = isFlagEnabled('ENABLE_MCP_CALL')

    // Bridge status (best-effort — server có thể offline)
    let bridge: unknown = null
    try {
      const configs = await db.mCPBridgeConfig.findMany()
      bridge = {
        note: 'MCP Bridge OpenClaw ↔ OpenCode (tool sharing)',
        outbound: configs.filter(c => c.direction === 'outbound' && c.enabled).map(c => c.toolName),
        inbound: configs.filter(c => c.direction === 'inbound' && c.enabled).map(c => c.toolName),
      }
    } catch { /* ignore */ }

    return {
      success: true,
      mcpCallEnabled,
      servers: servers.map(s => ({
        id: s.id,
        displayName: s.displayName,
        description: s.description,
        permissionRequired: s.permissionRequired,
        toolCount: s.tools.length,
        tools: s.tools.map(t => t.name),
      })),
      bridge,
      _usage: mcpCallEnabled
        ? 'Gọi mcp_call({"server":"<id>","tool":"<tên>","args":{...}}) để dùng. Server chưa được duyệt sẽ trả requiresPermission.'
        : 'mcp_call đang TẮT (ENABLE_MCP_CALL=false) — chỉ liệt kê được, chưa gọi được.',
    }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) }
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
  const root = await resolveWorkspaceRoot()
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
  const root = await resolveWorkspaceRoot()
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
  const root = await resolveWorkspaceRoot()
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

// ==================== CI-3 B2+B3 (Task 13-b): KHO CONTEXT — TOOL CONTEXT_RECALL ====================
//
// Roadmap CI-3 tầng 2 "Offload đọc lại khi cần": mỗi lần rolling digest nén
// context, digest đầy đủ được lưu vào TaskContextArchive (Prisma — source of
// truth) + Qdrant task_context (best-effort embed; xem src/lib/context-store.ts).
// Tool context_recall cho agent TRUY HỒI lại các context đó theo từ khóa —
// thay vì đọc lại toàn bộ transcript gốc (đã bị nén/cắt khỏi context active).
//
// Receipt có cấu trúc (giảm phình context agent): content mỗi mục cap 2000
// ký tự; tổng số mục cap limit (default 5, max 20). Fail-open tuyệt đối —
// recall lỗi/embed chết → success=true + items=[] + hint đổi từ khóa (SQL
// fallback trên Prisma chạy được ngay cả khi Prisma client stale — raw SQL
// bridge pattern episodic-db.ts), KHÔNG BAO GIỜ trả 500.

/** Cap ký tự content mỗi mục trong receipt context_recall */
const CONTEXT_RECALL_ITEM_MAX_CHARS = 2000

/**
 * context_recall — truy hồi thông tin context đã nén/lưu trữ của các run
 * trước (digest, đoạn raw bị cắt, task_summary).
 *
 * @returns receipt { success, query, source, items[], totalFound, hint }:
 *   - source: 'qdrant' (semantic) | 'sql' (LIKE fallback) | 'mixed'
 *   - items: [{ runId, agentName, kind, content (cap 2000 chars), createdAt }]
 *   - hint: chỉ dẫn agent dùng kết quả (hoặc đổi từ khóa khi 0 kết quả)
 */
export async function contextRecall(args: {
  query: string
  runId?: string
  limit?: number
}): Promise<unknown> {
  const query = typeof args.query === 'string' ? args.query.trim() : ''
  if (!query) {
    return {
      success: false,
      error: 'query (string, không rỗng) là bắt buộc — từ khóa tìm kiếm như tên file, tên hàm, lệnh đã chạy, quyết định kỹ thuật.',
    }
  }
  const runId = typeof args.runId === 'string' && args.runId.trim() ? args.runId.trim() : undefined
  const limit = typeof args.limit === 'number' && Number.isFinite(args.limit) ? args.limit : undefined

  try {
    const res = await recallContext({ query, runId, limit })
    const items = res.items.map(it => ({
      runId: it.runId,
      agentName: it.agentName,
      kind: it.kind,
      content: it.content.length > CONTEXT_RECALL_ITEM_MAX_CHARS
        ? it.content.slice(0, CONTEXT_RECALL_ITEM_MAX_CHARS) +
          `…[TRUNCATED ${CONTEXT_RECALL_ITEM_MAX_CHARS}/${it.content.length} chars — dùng query cụ thể hơn hoặc truy vấn từng run để lấy phần cần]`
        : it.content,
      createdAt: it.createdAt instanceof Date ? it.createdAt.toISOString() : String(it.createdAt),
    }))

    return {
      success: true,
      query,
      source: res.source,
      items,
      totalFound: items.length,
      limitApplied: Math.min(MAX_RECALL_LIMIT, limit && limit > 0 ? Math.floor(limit) : 5),
      hint: items.length > 0
        ? 'Đây là context đã NÉN (digest/raw/task_summary) từ các run trước — dùng trực tiếp thay vì đọc lại transcript gốc. Nội dung mỗi mục đã cap 2000 ký tự; cần rộng hơn thì gọi lại với query cụ thể hơn hoặc bỏ runId để tìm xuyên run.'
        : 'Không tìm thấy context nào khớp từ khóa — thử từ khóa khác (tên file, tên hàm, lệnh đã chạy, quyết định kỹ thuật), bỏ runId để tìm rộng hơn, hoặc tăng limit.',
    }
  } catch (err) {
    // Fail-open — recall là best-effort, KHÔNG bao giờ lỗi làm gãy workflow
    return {
      success: true,
      query,
      source: 'sql',
      items: [],
      totalFound: 0,
      hint: 'Không tìm thấy context nào khớp từ khóa — thử từ khóa khác (tên file, tên hàm, lệnh đã chạy) hoặc bỏ runId để tìm rộng hơn.',
      note: `recall lỗi (đã bỏ qua an toàn): ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}
