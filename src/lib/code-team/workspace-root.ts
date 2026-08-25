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

  cachedRoot = root
  cachedAt = now
  return root
}

/** Invalidate the cache — call after the user switches active workspace. */
export function invalidateWorkspaceRootCache(): void {
  cachedRoot = null
  cachedAt = 0
}
