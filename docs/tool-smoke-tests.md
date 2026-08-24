# Phase 2 Tool Smoke Tests

Per **Part 10.1** of `FULLSTACK_CAPABILITY_PLAN_V2.md`: for each new tool, document Input + Expected + Failure case. These are **manual smoke tests** — no automated test files (project rule "do not write any test code"). Re-run after every Phase 2 change.

Last run: post-audit Task 7-b (after P1 symlink + force-flag fixes). All scenarios below PASS unless marked otherwise.

---

## file_read (Phase 2.1)

**Feature flag**: `ENABLE_FILE_OPS=true` + `ENABLE_FILE_READ=true` (default `true`).

### S1 — happy path, small file
- **Input**: `{ path: "package.json", offset: 1, limit: 2000, line_numbers: true }`
- **Expected**: `{ success: true, lines: [{ number: 1, content: "{" }, ...], content: "     1\t{\n     2\t  \"name\": ...", truncated: false, totalLines: <N>, binary: false }`
- **Verified**: line numbers right-justified 6-char + tab (`cat -n` style).

### S2 — offset pagination + truncation cursor
- **Input**: `{ path: "src/lib/code-team/dev-tools.ts", offset: 1, limit: 50, line_numbers: true }`
- **Expected**: `{ success: true, truncated: true, nextOffset: 51, totalLines: ~1510, ... }`
- **Continue**: `{ path: "...same...", offset: 51, limit: 50 }` returns lines 51-100.

### S3 — line_numbers=false (raw text)
- **Input**: `{ path: "package.json", line_numbers: false }`
- **Expected**: `{ success: true, content: "{\n  \"name\": ...", lines: undefined-ish (raw joined), truncated: false }`

### S4 — directory rejection
- **Input**: `{ path: "src" }`
- **Expected**: `{ success: false, error: "Path is a directory — use file_list instead" }`

### S5 — 404
- **Input**: `{ path: "no/such/file.txt" }`
- **Expected**: `{ success: false, error: "File not found: no/such/file.txt" }`

### S6 — binary detection
- **Input**: `{ path: "public/logo.svg" }` (binary or text — depends on file)
- **Expected**: if binary (NULL byte in first 8KB), `{ success: false, error: "Binary file — cannot read as text", binary: true }`. Text SVG returns as S1.

### S7 — path traversal rejection
- **Input**: `{ path: "../etc/passwd" }`
- **Expected**: `{ success: false, error: "Path escapes workspace root" }` (resolveWithinWorkspace guard).

---

## file_edit (Phase 2.2)

**Feature flag**: `ENABLE_FILE_OPS=true` + `ENABLE_FILE_EDIT=true`.

### S1 — single edit happy path
- **Input**: `{ path: "<tmp>", old_str: "AAA", new_str: "BBB", match_count: 1 }`
- **Expected**: `{ success: true, applied: 1, matches: 1, written: true }`. File content: AAA→BBB.

### S2 — match_count guard (success)
- **Input**: file has 2 occurrences of "AAA"; `{ path, old_str: "AAA", new_str: "BBB", match_count: 2, replace_all: true }`
- **Expected**: `{ success: true, applied: 2, matches: 2, written: true }`.

### S3 — match_count guard (mismatch fail)
- **Input**: file has 3 occurrences of "AAA"; `{ path, old_str: "AAA", new_str: "BBB", match_count: 2, replace_all: true }`
- **Expected**: `{ success: false, error: "match_count mismatch: expected 2, found 3 — abort before write", written: false }`. File untouched.

### S4 — dry_run (no write)
- **Input**: `{ path: "<tmp>", old_str: "AAA", new_str: "BBB", dry_run: true }`
- **Expected**: `{ success: true, dryRun: true, wouldApply: 1, matches: 1, written: false }`. File content unchanged.

### S5 — atomic temp+rename (crash-safe)
- **Verify**: when `writeFile` is interrupted, original file remains intact. Implementation uses `.tmp` + `fs.rename` (POSIX atomic). Code path: `dev-tools.ts` `fileEdit` `await fs.writeFile(resolvedPath+'.tmp', newContent)` then `await fs.rename(resolvedPath+'.tmp', resolvedPath)`.

### S6 — backup (optional)
- **Input**: `{ path, old_str, new_str, backup: true }`
- **Expected**: `.bak` copy created alongside the edited file before write.

---

## file_multi_edit (Phase 2.3)

**Feature flag**: `ENABLE_FILE_OPS=true` + `ENABLE_FILE_MULTI_EDIT=true`.

### S1 — atomic batch (all succeed)
- **Input**: `{ path: "<tmp>", edits: [{ old_str: "AAA", new_str: "AAA-EDITED" }, { old_str: "CCC", new_str: "CCC-EDITED" }] }`
- **Expected**: `{ success: true, applied: 2, written: true }`. Both edits applied to the same file in one write.

### S2 — atomic rollback on edit N fail
- **Input**: file contains only "AAA"; `{ path, edits: [{ old_str: "AAA", new_str: "AAA-X" }, { old_str: "ZZZ", new_str: "ZZZ-X" }] }`
- **Expected**: `{ success: false, error: "Edit #2 failed: pattern 'ZZZ' not found — abort before write", applied: 0, written: false }`. File content unchanged — batch is atomic.

### S3 — dry_run batch
- **Input**: `{ path, edits: [...], dry_run: true }`
- **Expected**: `{ success: true, dryRun: true, wouldApply: N, written: false }`.

---

## file_delete (Phase 2.4)

**Feature flag**: `ENABLE_FILE_OPS=true` + `ENABLE_FILE_DELETE=true`.

### S1 — file delete happy path
- **Input**: `{ path: "<tmp-file>" }`
- **Expected**: `{ success: true, deleted: "<path>", type: "file" }`.

### S2 — directory without recursive (rejected)
- **Input**: `{ path: "<tmp-dir>" }`
- **Expected**: `{ error: "Path is a directory — pass recursive:true to delete it" }`.

### S3 — directory with recursive
- **Input**: `{ path: "<tmp-dir>", recursive: true }`
- **Expected**: `{ success: true, deleted: "<path>", type: "directory" }`.

### S4 — dry_run preview with fileCount
- **Input**: `{ path: "<tmp-dir-with-5-files>", recursive: true, dry_run: true }`
- **Expected**: `{ success: true, dryRun: true, wouldDelete: "<path>", type: "directory", fileCount: 5 }`.

### S5 — workspace root rejection
- **Input**: `{ path: "." }` (resolved to workspace root)
- **Expected**: `{ error: "Refusing to delete the workspace root" }`.

### S6 — symlink handling (P1 fix)
- **Setup**: create `link.txt` → symlink to `/tmp/outside.txt`.
- **Input**: `{ path: "link.txt" }`
- **Expected**: `{ success: true, deleted: "link.txt", type: "symlink", symlinkTarget: "/tmp/outside.txt" }`. **Target `/tmp/outside.txt` is NOT deleted** (only the link is unlinked). Verified via `fs.lstat` + `fs.unlink` (NOT `fs.rm({recursive:true})` which would follow the link).

### S7 — force flag (P2 fix)
- **Setup**: dir contains a readonly file (chmod 444).
- **Input (default force=false)**: `{ path: "<dir>", recursive: true }`
- **Expected**: `fs.rm` throws `EBADF` or skips the readonly entry — depends on platform; on most systems the dir is partially deleted.
- **Input (force=true)**: `{ path: "<dir>", recursive: true, force: true }`
- **Expected**: `{ success: true, deleted: "<path>", type: "directory" }` — readonly files removed because `fs.rm({force:true})`.

---

## file_list (Phase 2.5a)

**Feature flag**: `ENABLE_FILE_OPS=true` + `ENABLE_FILE_LIST=true`.

### S1 — shallow list
- **Input**: `{ path: "src", depth: 1 }`
- **Expected**: `{ success: true, entries: [{ name: "app", type: "directory", size: 0, mtime: <ts> }, ...] }`.

### S2 — pattern glob filter
- **Input**: `{ path: "src/lib", pattern: "*.ts", depth: 1 }`
- **Expected**: `{ success: true, entries: [<only .ts files>] }`. Non-`.ts` files filtered out.

### S3 — default ignore set
- **Input**: `{ path: ".", depth: 2 }`
- **Expected**: entries exclude `node_modules`, `.next`, `.git`, `dist`, `build`.

### S4 — symlink detection (lstat, not followed)
- **Setup**: create `link.ts` → symlink to `target.ts`.
- **Input**: `{ path: ".", depth: 1, pattern: "*.ts" }`
- **Expected**: `entries` includes `{ name: "link.ts", type: "symlink", symlinkTarget: "target.ts" }`. `fs.lstat` detects the symlink; we do NOT follow into the target directory during recursive walk.

---

## grep (Phase 2.5b)

**Feature flag**: `ENABLE_FILE_OPS=true` + `ENABLE_FILE_GREP=true`.

### S1 — content mode happy path
- **Input**: `{ path: "src", pattern: "executeTool", mode: "content", context: 0 }`
- **Expected**: `{ success: true, matches: [{ file: "src/lib/code-team/tool-executor.ts", line: 825, content: "  async function executeTool..." }, ...], totalMatches: <N> }`.

### S2 — files_with_matches mode
- **Input**: `{ path: "src", pattern: "executeTool", mode: "files" }`
- **Expected**: `{ success: true, files: ["src/lib/code-team/tool-executor.ts", ...] }`.

### S3 — count mode
- **Input**: `{ path: "src", pattern: "executeTool", mode: "count" }`
- **Expected**: `{ success: true, counts: { "src/lib/code-team/tool-executor.ts": 5, ... }, totalMatches: <N> }`.

### S4 — multiline mode
- **Input**: `{ path: "src", pattern: "function\\s+\\w+\\([^)]*\\)\\s*\\{", mode: "files", multiline: true }`
- **Expected**: matches multi-line function signatures (regex flags `gim`).

### S5 — case_sensitive opt-out
- **Input**: `{ path: "src", pattern: "ExecuteTool", mode: "files", case_sensitive: true }`
- **Expected**: 0 matches (default case-insensitive would have many).

### S6 — binary file skip
- **Input**: `{ path: "public", pattern: ".*", mode: "files" }`
- **Expected**: binary files (NULL byte in first 8KB) skipped silently; only text files returned.

---

## run_tests (Phase 2.6)

**Feature flag**: `ENABLE_RUN_TESTS=true`.

### S1 — bun autodetect
- **Input**: `{ target: "src/lib/code-team" }`
- **Expected**: `{ success: true, framework: "bun", passed: <N>, failed: 0, skipped: 0, durationMs: <N>, failingTests: [] }`.

### S2 — no tests found
- **Input**: `{ target: "src/app" }`
- **Expected**: `{ success: true, framework: "bun", passed: 0, failed: 0, skipped: 0, durationMs: <N>, failingTests: [] }`.

### S3 — durationMs extracted per framework
- **Bun**: `X pass Y fail (Zms)` → `durationMs: Z`.
- **Vitest**: `Test Files N (Mms)` → `durationMs: M`.
- **Jest**: `Time: N.Ns` → `durationMs: N*1000`.
- **Pytest**: `in N.Ns` → `durationMs: N*1000`.

### S4 — field name compliance (Claude Code parity)
- **Verify**: result uses `failingTests: [{ file, line, message }, ...]` (NOT `failures`). Backward compat alias `failures` may also exist.

---

## git_commit (Phase 2.7)

**Feature flag**: `ENABLE_GIT_COMMIT=true`.

### S1 — happy path with paths
- **Input**: `{ paths: ["src/lib/code-team/dev-tools.ts"], message: "test: smoke" }`
- **Expected**: `{ success: true, commitHash: "<12 chars>", branch: "main", filesChanged: ["src/lib/code-team/dev-tools.ts"], message: "test: smoke" }`.

### S2 — all=true with paths (explicit allowed)
- **Input**: `{ all: true, paths: ["src/lib/code-team/dev-tools.ts"], message: "test" }`
- **Expected**: paths takes precedence; `{ success: true, ... }`.

### S3 — all=true with NO paths (spec violation, rejected)
- **Input**: `{ all: true, message: "test" }`
- **Expected**: `{ success: false, error: "all=true requires explicit paths OR git add -A is forbidden by spec — pass paths[] explicitly" }`. NO `git add -A` blanket staging.

### S4 — nothing to commit (pre-flight rejection)
- **Setup**: clean working tree.
- **Input**: `{ paths: ["src/lib/code-team/dev-tools.ts"], message: "test" }`
- **Expected**: `{ success: false, error: "nothing to commit — working tree clean" }`. Pre-flight `git status --porcelain` short-circuits before invoking `git commit`.

### S5 — dry_run (no side-effect)
- **Input**: `{ paths: ["src/lib/code-team/dev-tools.ts"], message: "test", dry_run: true }`
- **Expected**: `{ success: true, dryRun: true, wouldCommitFiles: ["src/lib/code-team/dev-tools.ts"], stagedPreview: "<staged diff stat>" }`. Working tree porcelain UNCHANGED after call.

### S6 — no_verify flag
- **Input**: `{ paths: [...], message: "test", no_verify: true }`
- **Expected**: `git commit --no-verify` runs (skips husky/lefthook pre-commit hooks).

### S7 — structured receipt compliance
- **Verify**: result contains `commitHash` (12-char short SHA), `branch` (via `git rev-parse --abbrev-ref HEAD`), `filesChanged` (via `git show --stat --name-only HEAD`).
