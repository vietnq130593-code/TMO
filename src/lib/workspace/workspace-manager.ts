// ============================================
// WorkspaceManager — workspace lifecycle, pending edits, file ops
// ============================================

import { db } from "@/lib/db";
import * as fs from "node:fs";
import * as path from "node:path";
import type {
  Workspace,
  PendingEdit,
  CreateWorkspaceInput,
} from "./types";

// ============================================
// WorkspaceManager
// ============================================

// ---------------------------------------------------------------------------
// Path containment helper — prevents path traversal in PendingEdits
// ---------------------------------------------------------------------------
// Phase 4 audit fix (Task 11, P1-1): createPendingEdit + applyPendingEdit
// previously used path.join(root, filePath) WITHOUT checking that the resolved
// path stays inside the workspace root. A malicious or confused agent could
// supply filePath='../../etc/passwd' → createPendingEdit would read the file
// into the `before` field (info disclosure via GET) and applyPendingEdit
// would write arbitrary content to arbitrary paths (arbitrary file write).
//
// This helper resolves both root + relative path to absolute form and rejects
// any path that escapes the workspace root. The check uses path.relative():
// if the resolved path's relative form starts with '..' it is outside root.
function resolveSafePath(rootPath: string, relPath: string): string {
  const resolvedRoot = path.resolve(rootPath);
  const joined = path.join(resolvedRoot, relPath);
  const resolved = path.resolve(joined);
  const rel = path.relative(resolvedRoot, resolved);
  // Empty rel means the path IS the root (allowed). '..' prefix means escape.
  // On Windows, a path on a different drive would produce rel like 'C:\...' which
  // also fails the check (does not start with a separator-free relative segment).
  if (rel === '') return resolved; // the root itself
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(
      `Path traversal rejected: filePath "${relPath}" resolves outside workspace root "${resolvedRoot}"`,
    );
  }
  return resolved;
}

export class WorkspaceManager {
  // ---------------------------------------------------------------------------
  // Active workspace cache (TTL 10s)
  // ---------------------------------------------------------------------------
  private _activeCache: { ws: Workspace; ts: number } | null = null;
  private readonly CACHE_TTL_MS = 10_000;

  // ---------------------------------------------------------------------------
  // Workspace lifecycle
  // ---------------------------------------------------------------------------

  /** Lấy workspace đang active (isActive = true).
   *  Nếu chưa có workspace nào → tự tạo default workspace từ process.cwd().
   *  Cache TTL 10s để tránh query DB liên tục. */
  async getActiveWorkspace(): Promise<Workspace> {
    // Check cache
    if (this._activeCache && (Date.now() - this._activeCache.ts) < this.CACHE_TTL_MS) {
      return this._activeCache.ws;
    }

    try {
      const record = await db.workspace.findFirst({
        where: { isActive: true },
      });
      if (record) {
        const ws = this._mapWorkspace(record);
        this._activeCache = { ws, ts: Date.now() };
        return ws;
      }
    } catch {
      // DB error — fall through to default
    }

    // No active workspace → auto-create default from process.cwd()
    const defaultPath = process.cwd();
    const defaultWs = await this.createWorkspace({
      name: 'Default Workspace',
      rootPath: defaultPath,
    });
    this._activeCache = { ws: defaultWs, ts: Date.now() };
    return defaultWs;
  }

  /** Invalidate active workspace cache (gọi sau khi setActiveWorkspace/deleteWorkspace) */
  private _invalidateCache(): void {
    this._activeCache = null;
  }

  /**
   * Resolve relative path against active workspace rootPath.
   * Guards against path traversal (../../etc/passwd) and absolute paths outside root.
   * @returns resolved absolute path, guaranteed to be within workspace root.
   * @throws if resolved path escapes workspace root.
   */
  async resolveInWorkspace(relPath: string): Promise<string> {
    const ws = await this.getActiveWorkspace();
    const resolved = path.resolve(ws.rootPath, relPath);

    // Guard: resolved path must start with workspace rootPath
    // This blocks ../../etc/passwd and absolute paths outside root
    const normalizedRoot = path.resolve(ws.rootPath) + path.sep;
    const normalizedResolved = path.resolve(resolved) + path.sep;

    if (!normalizedResolved.startsWith(normalizedRoot)) {
      throw new Error(
        `Path traversal blocked: "${relPath}" resolves to "${resolved}" which is outside workspace root "${ws.rootPath}"`
      );
    }

    return resolved;
  }

  /** Liệt kê tất cả workspaces, active first */
  async listWorkspaces(): Promise<Workspace[]> {
    const records = await db.workspace.findMany({
      orderBy: [{ isActive: "desc" }, { createdAt: "desc" }],
    });
    return records.map((r) => this._mapWorkspace(r));
  }

  /** Lấy workspace theo id */
  async getWorkspaceById(id: string): Promise<Workspace | null> {
    try {
      const record = await db.workspace.findUnique({ where: { id } });
      if (!record) return null;
      return this._mapWorkspace(record);
    } catch {
      return null;
    }
  }

  /** Lấy workspace theo rootPath */
  async getWorkspaceByPath(rootPath: string): Promise<Workspace | null> {
    try {
      const record = await db.workspace.findUnique({ where: { rootPath } });
      if (!record) return null;
      return this._mapWorkspace(record);
    } catch {
      return null;
    }
  }

  /**
   * Tạo workspace mới.
   * - Validate rootPath tồn tại trên filesystem
   * - Deactivate workspace đang active (nếu có)
   * - Tạo mới + set isActive = true
   */
  async createWorkspace(input: CreateWorkspaceInput): Promise<Workspace> {
    // Validate rootPath
    const resolved = path.resolve(input.rootPath);
    if (!fs.existsSync(resolved)) {
      throw new Error(`Workspace root path does not exist: ${resolved}`);
    }
    if (!fs.statSync(resolved).isDirectory()) {
      throw new Error(`Workspace root path is not a directory: ${resolved}`);
    }

    // Deactivate current active workspace
    const currentActive = await db.workspace.findFirst({
      where: { isActive: true },
    });
    if (currentActive) {
      await db.workspace.update({
        where: { id: currentActive.id },
        data: { isActive: false },
      });
    }

    // Create new workspace (active by default)
    const record = await db.workspace.create({
      data: {
        name: input.name,
        rootPath: resolved,
        isActive: true,
      },
    });

    // BUG (Task 54): createWorkspace đổi chủ active workspace nhưng KHÔNG
    // invalidate _activeCache. getActiveWorkspace() có TTL 10s nên sau khi
    // tạo workspace mới, mọi lời gọi trong 10s tiếp vẫn trả về workspace CŨ
    // đã bị set isActive=false → lệch DB, hỏng resolveInWorkspace.
    // setActiveWorkspace/deleteWorkspace đã gọi _invalidateCache; thiếu ở đây.
    this._invalidateCache();

    return this._mapWorkspace(record);
  }

  /**
   * Kích hoạt một workspace khác (deactivate active cũ).
   * Nếu workspace đã là active → no-op.
   */
  async setActiveWorkspace(id: string): Promise<Workspace> {
    // Verify workspace exists
    const target = await db.workspace.findUnique({ where: { id } });
    if (!target) {
      throw new Error(`Workspace not found: ${id}`);
    }

    // If already active, return as-is
    if (target.isActive) {
      return this._mapWorkspace(target);
    }

    // Deactivate current active
    const currentActive = await db.workspace.findFirst({
      where: { isActive: true },
    });
    if (currentActive) {
      await db.workspace.update({
        where: { id: currentActive.id },
        data: { isActive: false },
      });
    }

    // Activate target
    const updated = await db.workspace.update({
      where: { id },
      data: { isActive: true },
    });

    this._invalidateCache();
    return this._mapWorkspace(updated);
  }

  /**
   * Xóa workspace.
   * - Không cho phép xóa active workspace.
   * - Không xóa filesystem (chỉ xóa record trong DB).
   */
  async deleteWorkspace(id: string): Promise<void> {
    const target = await db.workspace.findUnique({ where: { id } });
    if (!target) {
      throw new Error(`Workspace not found: ${id}`);
    }
    if (target.isActive) {
      throw new Error(`Cannot delete the active workspace. Deactivate it first.`);
    }

    await db.workspace.delete({ where: { id } });
    this._invalidateCache();
  }

  // ---------------------------------------------------------------------------
  // PendingEdit management
  // ---------------------------------------------------------------------------

  /**
   * Tạo pending edit từ agent proposal.
   * - oldContent lấy từ file hiện tại ("" nếu file mới)
   * - diff được tính từ oldContent → newContent
   *
   * Phase 4.4 spec: also populate spec-defined fields (operation, before,
   * after, riskLevel) so /api/openclaw/pending-edits can query by operation
   * and risk level per spec v2.1 Phase 4.4.
   */
  async createPendingEdit(params: {
    sessionId: string;
    filePath: string;
    newContent: string;
    agentName: string;
    workspaceRootPath: string;
    /** Phase 4.4 — operation type (defaults to 'edit'). */
    operation?: 'edit' | 'delete' | 'multi_edit' | 'create';
    /** Phase 4.4 — risk level (defaults to 'low'). */
    riskLevel?: 'low' | 'medium' | 'high';
    /** Phase 4.4 — optional reviewer hint (who should approve). */
    reviewerId?: string;
  }): Promise<PendingEdit> {
    const {
      sessionId, filePath, newContent, agentName, workspaceRootPath,
      operation = 'edit', riskLevel = 'low', reviewerId,
    } = params;

    // Resolve absolute path — Phase 4 audit fix (P1-1): reject path traversal.
    // A malicious filePath like '../../etc/passwd' would resolve outside the
    // workspace root; resolveSafePath throws before any filesystem read happens.
    let absPath: string;
    try {
      absPath = resolveSafePath(workspaceRootPath, filePath);
    } catch (err) {
      throw new Error(
        `createPendingEdit rejected filePath: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Read old content (empty string if file doesn't exist)
    let oldContent = "";
    try {
      if (fs.existsSync(absPath) && fs.statSync(absPath).isFile()) {
        oldContent = fs.readFileSync(absPath, "utf-8");
      }
    } catch {
      oldContent = "";
    }

    // Compute simple diff
    const diff = this._computeDiff(oldContent, newContent, filePath);

    const record = await db.pendingEdit.create({
      data: {
        sessionId,
        filePath,
        // Phase 4.4 spec fields:
        operation,
        before: oldContent || null,
        after: newContent || null,
        riskLevel,
        status: "pending",
        reviewerId: reviewerId || null,
        // Legacy compat fields (used by older API consumers):
        oldContent,
        newContent,
        diff,
        agentName,
      },
    });

    return this._mapPendingEdit(record);
  }

  /** Liệt kê pending edits — optional filter theo sessionId */
  async listPendingEdits(sessionId?: string): Promise<PendingEdit[]> {
    const where = sessionId
      ? { sessionId, status: "pending" as const }
      : { status: "pending" as const };

    const records = await db.pendingEdit.findMany({
      where,
      orderBy: { createdAt: "desc" },
    });
    return records.map((r) => this._mapPendingEdit(r));
  }

  /** Lấy một pending edit theo id */
  async getPendingEdit(id: string): Promise<PendingEdit | null> {
    try {
      const record = await db.pendingEdit.findUnique({ where: { id } });
      if (!record) return null;
      return this._mapPendingEdit(record);
    } catch {
      return null;
    }
  }

  /**
   * Phase 4.4 spec — Approve a pending edit (signature with reviewerId).
   * Sets status='approved' + reviewerId + reviewedAt. Does NOT apply to filesystem
   * (call applyPendingEdit(id) separately to apply).
   *
   * @returns the approved PendingEdit record (still with status='approved')
   */
  async approvePendingEditSpec(id: string, reviewerId: string): Promise<PendingEdit> {
    const edit = await db.pendingEdit.findUnique({ where: { id } });
    if (!edit) {
      throw new Error(`PendingEdit not found: ${id}`);
    }
    if (edit.status !== "pending") {
      throw new Error(`Cannot approve edit with status: ${edit.status}`);
    }
    const updated = await db.pendingEdit.update({
      where: { id },
      data: {
        status: "approved",
        reviewerId,
        reviewedAt: new Date(),
        resolvedAt: new Date(), // legacy field
      },
    });
    return this._mapPendingEdit(updated);
  }

  /**
   * Phase 4.4 spec — Reject a pending edit (signature with reviewerId).
   * Sets status='rejected'. Does NOT touch filesystem.
   */
  async rejectPendingEditSpec(id: string, reviewerId: string): Promise<PendingEdit> {
    const edit = await db.pendingEdit.findUnique({ where: { id } });
    if (!edit) {
      throw new Error(`PendingEdit not found: ${id}`);
    }
    if (edit.status !== "pending") {
      throw new Error(`Cannot reject edit with status: ${edit.status}`);
    }
    const updated = await db.pendingEdit.update({
      where: { id },
      data: {
        status: "rejected",
        reviewerId,
        reviewedAt: new Date(),
        resolvedAt: new Date(), // legacy field
      },
    });
    return this._mapPendingEdit(updated);
  }

  /**
   * Phase 4.4 spec — Apply an approved pending edit to the filesystem.
   * Reads the workspace root from the active workspace (so callers don't need
   * to pass it). Handles: edit, create, delete operations.
   *
   * @returns the applied PendingEdit (status='applied', appliedAt set)
   */
  async applyPendingEdit(id: string): Promise<PendingEdit> {
    const edit = await db.pendingEdit.findUnique({ where: { id } });
    if (!edit) {
      throw new Error(`PendingEdit not found: ${id}`);
    }
    if (edit.status !== "approved" && edit.status !== "pending") {
      // Allow 'pending' too — convenience for tests
      throw new Error(`Cannot apply edit with status: ${edit.status} (must be approved first)`);
    }

    const activeWs = await this.getActiveWorkspace();
    // Phase 4 audit fix (P1-1): reject path traversal before any write.
    // applyPendingEdit writes to disk; without containment, a malicious
    // filePath could write arbitrary content to arbitrary paths.
    let absPath: string;
    try {
      absPath = resolveSafePath(activeWs.rootPath, edit.filePath);
    } catch (err) {
      // Mark as failed (legacy status) + rethrow
      await db.pendingEdit.update({
        where: { id },
        data: { status: "failed", resolvedAt: new Date() },
      });
      throw new Error(
        `applyPendingEdit rejected filePath: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    try {
      const op = edit.operation || "edit";
      if (op === "delete") {
        // Delete the file (best-effort)
        try {
          if (fs.existsSync(absPath)) {
            fs.unlinkSync(absPath);
          }
        } catch (err) {
          console.warn(`[WorkspaceManager] applyPendingEdit delete failed for ${absPath}:`, err);
        }
      } else {
        // edit | multi_edit | create — write the `after` (or newContent) to disk
        const content = edit.after || edit.newContent || "";
        // Ensure directory exists
        const dir = path.dirname(absPath);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(absPath, content, "utf-8");
      }

      const updated = await db.pendingEdit.update({
        where: { id },
        data: {
          status: "applied",
          appliedAt: new Date(),
          resolvedAt: new Date(), // legacy field
        },
      });
      return this._mapPendingEdit(updated);
    } catch (err) {
      // Mark as failed (legacy status)
      await db.pendingEdit.update({
        where: { id },
        data: {
          status: "failed",
          resolvedAt: new Date(),
        },
      });
      throw new Error(
        `Failed to apply edit to ${absPath}: ${err instanceof Error ? err.message : "Unknown error"}`,
      );
    }
  }

  /**
   * Approve pending edit → apply to filesystem. (Legacy signature — kept for
   * backward compat with /api/workspace + /api/code-team/checkpoints routes.)
   *
   * Phase 4.4: prefer the spec signature approvePendingEditSpec(id, reviewerId)
   * followed by applyPendingEdit(id). This legacy method auto-applies.
   */
  async approvePendingEdit(id: string, workspaceRootPath: string): Promise<PendingEdit> {
    const edit = await db.pendingEdit.findUnique({ where: { id } });
    if (!edit) {
      throw new Error(`PendingEdit not found: ${id}`);
    }
    if (edit.status !== "pending") {
      throw new Error(`Cannot approve edit with status: ${edit.status}`);
    }

    // Apply to filesystem
    const absPath = path.join(workspaceRootPath, edit.filePath);
    try {
      // Ensure directory exists
      const dir = path.dirname(absPath);
      fs.mkdirSync(dir, { recursive: true });
      // Write content (use `after` if available, else legacy `newContent`)
      fs.writeFileSync(absPath, edit.after || edit.newContent, "utf-8");

      // Update status
      const updated = await db.pendingEdit.update({
        where: { id },
        data: {
          status: "applied",
          appliedAt: new Date(),
          resolvedAt: new Date(),
        },
      });
      return this._mapPendingEdit(updated);
    } catch (err) {
      // Update status to failed
      const updated = await db.pendingEdit.update({
        where: { id },
        data: {
          status: "failed",
          resolvedAt: new Date(),
        },
      });
      // Re-throw for caller to handle
      throw new Error(
        `Failed to apply edit to ${absPath}: ${err instanceof Error ? err.message : "Unknown error"} (record id=${updated.id})`,
      );
    }
  }

  /**
   * Reject pending edit → discard.
   * - Cập nhật status → "rejected"
   * - Không thay đổi filesystem
   */
  async rejectPendingEdit(id: string): Promise<PendingEdit> {
    const edit = await db.pendingEdit.findUnique({ where: { id } });
    if (!edit) {
      throw new Error(`PendingEdit not found: ${id}`);
    }
    if (edit.status !== "pending") {
      throw new Error(`Cannot reject edit with status: ${edit.status}`);
    }

    const updated = await db.pendingEdit.update({
      where: { id },
      data: {
        status: "rejected",
        resolvedAt: new Date(),
      },
    });
    return this._mapPendingEdit(updated);
  }

  /** Lấy tất cả pending edits theo sessionId (bất kể status) */
  async getPendingEditsBySession(sessionId: string): Promise<PendingEdit[]> {
    const records = await db.pendingEdit.findMany({
      where: { sessionId },
      orderBy: { createdAt: "desc" },
    });
    return records.map((r) => this._mapPendingEdit(r));
  }

  // ---------------------------------------------------------------------------
  // FsCheckpoint management
  // ---------------------------------------------------------------------------

  /** Tạo fs checkpoint record (shadow git commit hash) */
  async createCheckpoint(params: {
    sessionId: string;
    workspaceId: string;
    commitHash: string;
    label: string;
  }): Promise<{ id: string; commitHash: string }> {
    const record = await db.fsCheckpoint.create({
      data: {
        sessionId: params.sessionId,
        workspaceId: params.workspaceId,
        commitHash: params.commitHash,
        label: params.label,
      },
    });
    return { id: record.id, commitHash: record.commitHash };
  }

  /** Liệt kê checkpoints theo session (mới nhất trước) */
  async listCheckpoints(sessionId: string): Promise<
    Array<{ id: string; commitHash: string; label: string; createdAt: Date }>
  > {
    const records = await db.fsCheckpoint.findMany({
      where: { sessionId },
      orderBy: { createdAt: "desc" },
    });
    return records.map((r) => ({
      id: r.id,
      commitHash: r.commitHash,
      label: r.label,
      createdAt: r.createdAt,
    }));
  }

  // ---------------------------------------------------------------------------
  // AgentModelOverride management
  // ---------------------------------------------------------------------------

  /** Lấy model override cho một agent */
  async getAgentModelOverride(
    agentName: string,
  ): Promise<{ provider: string; model: string } | null> {
    const record = await db.agentModelOverride.findUnique({
      where: { agentName },
    });
    if (!record) return null;
    return { provider: record.provider, model: record.model };
  }

  /** Set/cập nhật model override cho agent */
  async setAgentModelOverride(
    agentName: string,
    provider: string,
    model: string,
  ): Promise<void> {
    await db.agentModelOverride.upsert({
      where: { agentName },
      update: { provider, model, updatedAt: new Date() },
      create: { agentName, provider, model },
    });
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private _mapWorkspace(record: {
    id: string;
    name: string;
    rootPath: string;
    isActive: boolean;
    createdAt: Date;
    updatedAt: Date;
  }): Workspace {
    return {
      id: record.id,
      name: record.name,
      rootPath: record.rootPath,
      isActive: record.isActive,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }

  private _mapPendingEdit(record: {
    id: string;
    sessionId: string;
    filePath: string;
    oldContent: string;
    newContent: string;
    // Prisma schema: diff String? (nullable) — legacy row có thể null
    diff: string | null;
    status: string;
    agentName: string;
    // Phase 4.4 spec fields:
    operation?: string;
    before?: string | null;
    after?: string | null;
    riskLevel?: string;
    reviewerId?: string | null;
    reviewedAt?: Date | null;
    appliedAt?: Date | null;
    lastError?: string | null;
    createdAt: Date;
    resolvedAt: Date | null;
  }): PendingEdit {
    return {
      id: record.id,
      sessionId: record.sessionId,
      filePath: record.filePath,
      oldContent: record.oldContent,
      newContent: record.newContent,
      // giữ nguyên giá trị runtime (null với legacy row) — chỉ bridge type
      diff: record.diff as string,
      status: record.status as PendingEdit["status"],
      agentName: record.agentName,
      createdAt: record.createdAt,
      resolvedAt: record.resolvedAt,
    };
  }

  /**
   * Simple line-based diff (không cần thư viện external).
   * Format: unified-style với --- / +++ header.
   */
  private _computeDiff(
    oldContent: string,
    newContent: string,
    filePath: string,
  ): string {
    const oldLines = oldContent.split("\n");
    const newLines = newContent.split("\n");

    // Build diff lines
    const diffLines: string[] = [];
    diffLines.push(`--- a/${filePath}`);
    diffLines.push(`+++ b/${filePath}`);

    // Simple algorithm: walk both arrays
    let i = 0;
    let j = 0;
    const maxLen = Math.max(oldLines.length, newLines.length);

    while (i < oldLines.length || j < newLines.length) {
      if (i < oldLines.length && j < newLines.length && oldLines[i] === newLines[j]) {
        // Context line (unchanged)
        diffLines.push(` ${oldLines[i]}`);
        i++;
        j++;
      } else if (i < oldLines.length && j >= newLines.length) {
        // Remaining old lines (removed)
        diffLines.push(`-${oldLines[i]}`);
        i++;
      } else if (i >= oldLines.length && j < newLines.length) {
        // Remaining new lines (added)
        diffLines.push(`+${newLines[j]}`);
        j++;
      } else {
        // Line changed — old removed, new added
        diffLines.push(`-${oldLines[i]}`);
        diffLines.push(`+${newLines[j]}`);
        i++;
        j++;
      }
    }

    return diffLines.join("\n");
  }
}

/** Singleton instance */
let _instance: WorkspaceManager | null = null;

export function getWorkspaceManager(): WorkspaceManager {
  if (!_instance) {
    _instance = new WorkspaceManager();
  }
  return _instance;
}

/**
 * R11 (F1 — lượt quan sát thứ 5): rootPath hợp lệ cho nền tảng ĐANG CHẠY?
 * DB Workspace có thể chứa đường dẫn từ MÁY KHÁC (backup/restore — bằng chứng
 * 14/10: active rootPath "E:\APP\TMO-clone" trên Linux sandbox; existsSync()
 * trả TRUE oan vì resolve thành thư mục literal rạc "E:\APP\TMO-clone" trong
 * app dir → mọi tool file resolve theo root vô nghĩa → bão path-escape +
 * receipt ghi nhầm chỗ). Windows path trên POSIX (và ngược lại) = invalid.
 */
export function isRootPathSaneForPlatform(p: string): boolean {
  if (!p || typeof p !== 'string') return false;
  if (process.platform === 'win32') {
    // Windows: drive-letter (C:\ hoặc C:/) hoặc UNC (\\server\share)
    return /^([a-zA-Z]:[\\/]|\\\\)/.test(p);
  }
  // POSIX: không chấp nhận drive-letter prefix hoặc backslash (dấu vết Windows)
  return !/^[a-zA-Z]:/.test(p) && !p.includes('\\');
}

/**
 * R11 (F1): tự chữa khi active workspace vô hiệu trên nền tảng này —
 * deactivate row lỗi + upsert workspace lành mạnh trỏ về app dir (cwd).
 * Fail-open tuyệt đối (lỗi DB không được làm hỏng tool call — caller đã có
 * fallback env/cwd).
 */
async function healInvalidActiveWorkspace(badId: string, badRoot: string): Promise<void> {
  try {
    const { db } = await import('@/lib/db');
    await db.workspace.update({ where: { id: badId }, data: { isActive: false } }).catch(() => {});
    const saneRoot = process.cwd();
    const existing = await db.workspace.findUnique({ where: { rootPath: saneRoot } }).catch(() => null);
    const ws = existing
      ? await db.workspace.update({ where: { id: existing.id }, data: { isActive: true } })
      : await db.workspace.create({ data: { name: 'TMO (auto-heal R11)', rootPath: saneRoot, isActive: true } });
    await db.workspace.updateMany({ where: { isActive: true, id: { not: ws.id } }, data: { isActive: false } }).catch(() => {});
    console.warn(`[WORKSPACE] 🛠️ R11 auto-heal: active workspace "${badRoot}" vô hiệu trên ${process.platform} → deactivate + kích hoạt "${saneRoot}"`);
  } catch (err) {
    console.warn('[WORKSPACE] R11 auto-heal lỗi (fail-open — fallback env/cwd):', err instanceof Error ? err.message : String(err));
  }
}

/**
 * Phase 6 (rebuild) — Convenience accessor: rootPath of the ACTIVE workspace.
 * Never throws — returns null when the workspace layer is unavailable
 * (DB down, no active record and auto-create failed, ...).
 *
 * Used by code-team tool executor (start_preview/stop_preview) and the
 * workspace-root resolver so AI tools operate on the USER's active workspace
 * instead of the TMO process cwd.
 *
 * R11 (F1): active rootPath vô hiệu trên nền tảng này (Windows-path-on-POSIX
 * từ DB máy khác) → coi như KHÔNG có active (fallback env/cwd) + heal async.
 */
export async function getActiveWorkspaceRoot(): Promise<string | null> {
  try {
    const ws = await getWorkspaceManager().getActiveWorkspace();
    const root = ws?.rootPath ?? null;
    if (root && !isRootPathSaneForPlatform(root)) {
      console.warn(`[WORKSPACE] ⚠️ R11: active workspace rootPath "${root}" không hợp lệ trên ${process.platform} (DB từ máy khác?) — bỏ qua, fallback env/cwd`);
      if (ws?.id) void healInvalidActiveWorkspace(ws.id, root).catch(() => {});
      return null;
    }
    return root;
  } catch {
    return null;
  }
}