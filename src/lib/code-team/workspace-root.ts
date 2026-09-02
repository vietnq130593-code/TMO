/**
 * Workspace Root Resolver — Phase 6/7 (rebuild)
 *
 * CORE INTEGRATION FIX: code-team AI tools (file_read/file_edit/shell/...) and
 * the workflow engine previously resolved their workspace root from
 * `process.env.OPENCODE_WORKSPACE || process.cwd()`. Because OPENCODE_WORKSPACE
 * is rarely set and cwd is the TMO app directory itself, every AI file tool
 * failed with "Access denied: path escapes workspace root" (or silently
 * operated on the wrong project).
 *
 * This resolver makes the root follow the USER's ACTIVE workspace
 * (WorkspaceManager → SQLite `Workspace` table, maintained by the UI's
 * workspace picker — Phase 2), with a 5s cache to avoid hammering the DB on
 * every tool call in a ReAct loop.
 *
 * Fallback chain: active workspace rootPath → OPENCODE_WORKSPACE env → cwd.
 */

import path from 'path'
import { getActiveWorkspaceRoot } from '@/lib/workspace/workspace-manager'

let cachedRoot: string | null = null
let cachedAt = 0
const CACHE_TTL_MS = 5_000

/** Resolve the workspace root AI tools should operate in (async, 5s cached). */
export async function resolveWorkspaceRoot(): Promise<string> {
  const now = Date.now()
  if (cachedRoot && now - cachedAt < CACHE_TTL_MS) return cachedRoot

  let root: string | null = null
  try {
    root = await getActiveWorkspaceRoot()
  } catch {
    root = null
  }
  if (!root || typeof root !== 'string' || root.trim() === '') {
    root = process.env.OPENCODE_WORKSPACE || process.cwd()
  }

  // FIX 2026-09-02 (push blocker — audit Omega E2E): normalize root về ĐƯỜNG
  // DẪN TUYỆT ĐỐI. Env fallback OPENCODE_WORKSPACE có thể là đường dẫn tương
  // đối (mặc định ".") — root tương đối làm mọi check startsWith(root + sep)
  // ở resolveWithinWorkspace (dev-tools) so KHÔNG KHỚP với path.resolve()
  // (absolute) → "Access denied: path escapes workspace root" oan MỌI file →
  // git_commit/verify_and_push bị chặn hoàn toàn. path.resolve(".") = cwd —
  // đúng ngữ nghĩa gốc của fallback.
  const absRoot = path.resolve(root)
  cachedRoot = absRoot
  cachedAt = now
  return absRoot
}

/** Invalidate the cache — call after the user switches active workspace. */
export function invalidateWorkspaceRootCache(): void {
  cachedRoot = null
  cachedAt = 0
}
