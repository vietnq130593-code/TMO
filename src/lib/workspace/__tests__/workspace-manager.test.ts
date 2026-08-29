/// <reference types="bun-types" />
// ============================================
// WorkspaceManager Tests — Phase 1: CRUD + PendingEdit lifecycle
// ============================================

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { WorkspaceManager, getWorkspaceManager } from "../workspace-manager";

let wm: WorkspaceManager;
let tempDir: string;
let testWorkspaceId: string;

beforeAll(() => {
  wm = getWorkspaceManager();

  // Tạo temp workspace directory
  tempDir = path.join(os.tmpdir(), `theopus-test-workspace-${Date.now()}`);
  fs.mkdirSync(tempDir, { recursive: true });

  // Tạo một file test trong đó
  fs.writeFileSync(path.join(tempDir, "test.ts"), 'export const hello = "world";\n', "utf-8");
});

afterAll(() => {
  // Cleanup: xóa temp directory
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
});

// ============================================
// Workspace CRUD
// ============================================

describe("WorkspaceManager — Workspace CRUD", () => {
  test("createWorkspace → creates and auto-activates", async () => {
    const ws = await wm.createWorkspace({
      name: "Test Workspace",
      rootPath: tempDir,
    });

    expect(ws).not.toBeNull();
    expect(ws.name).toBe("Test Workspace");
    expect(ws.rootPath).toBe(path.resolve(tempDir));
    expect(ws.isActive).toBe(true);
    testWorkspaceId = ws.id;
  });

  test("getActiveWorkspace → returns the active one", async () => {
    const active = await wm.getActiveWorkspace();
    expect(active).not.toBeNull();
    expect(active!.id).toBe(testWorkspaceId);
    expect(active!.isActive).toBe(true);
  });

  test("listWorkspaces → returns all workspaces", async () => {
    const list = await wm.listWorkspaces();
    expect(list.length).toBeGreaterThanOrEqual(1);
    expect(list[0].isActive).toBe(true); // active first
  });

  test("createWorkspace → deactivates previous active", async () => {
    // Tạo workspace thứ 2
    const tempDir2 = path.join(os.tmpdir(), `theopus-test-ws2-${Date.now()}`);
    fs.mkdirSync(tempDir2, { recursive: true });

    const ws2 = await wm.createWorkspace({
      name: "Second Workspace",
      rootPath: tempDir2,
    });

    expect(ws2.isActive).toBe(true);

    // Kiểm tra workspace 1 đã bị deactivate
    const ws1 = await wm.getWorkspaceById(testWorkspaceId);
    expect(ws1).not.toBeNull();
    expect(ws1!.isActive).toBe(false);

    // Cleanup: reactivate ws1 (deactivates ws2), then delete ws2 + temp dir
    await wm.setActiveWorkspace(testWorkspaceId);
    await wm.deleteWorkspace(ws2.id);
    fs.rmSync(tempDir2, { recursive: true, force: true });
  });

  test("setActiveWorkspace → switches active", async () => {
    // Deactivate ws1 trước
    const inactive = await wm.setActiveWorkspace(testWorkspaceId);
    expect(inactive.isActive).toBe(true);

    const active = await wm.getActiveWorkspace();
    expect(active).not.toBeNull();
    expect(active!.id).toBe(testWorkspaceId);
  });

  test("setActiveWorkspace → throws on nonexistent id", async () => {
    await expect(wm.setActiveWorkspace("nonexistent-id")).rejects.toThrow(
      "Workspace not found",
    );
  });

  test("deleteWorkspace → throws on active workspace", async () => {
    await expect(wm.deleteWorkspace(testWorkspaceId)).rejects.toThrow(
      "Cannot delete the active workspace",
    );
  });

  test("deleteWorkspace → succeeds on inactive workspace", async () => {
    // Tạo workspace thứ 3 (inactive)
    const tempDir3 = path.join(os.tmpdir(), `theopus-test-ws3-${Date.now()}`);
    fs.mkdirSync(tempDir3, { recursive: true });

    const ws3 = await wm.createWorkspace({
      name: "Third Workspace",
      rootPath: tempDir3,
    });
    // Reactivate ws1 (deactivates ws3)
    await wm.setActiveWorkspace(testWorkspaceId);

    // Now ws3 is inactive → can delete
    await wm.deleteWorkspace(ws3.id);

    // Verify deleted
    const deleted = await wm.getWorkspaceById(ws3.id);
    expect(deleted).toBeNull();

    fs.rmSync(tempDir3, { recursive: true, force: true });
  });

  test("createWorkspace → throws on nonexistent path", async () => {
    await expect(
      wm.createWorkspace({
        name: "Bad Workspace",
        rootPath: "/nonexistent/path/12345",
      }),
    ).rejects.toThrow("does not exist");
  });

  test("createWorkspace → throws on file path (not directory)", async () => {
    const filePath = path.join(tempDir, "test.ts"); // existing file, not dir
    await expect(
      wm.createWorkspace({
        name: "File As Workspace",
        rootPath: filePath,
      }),
    ).rejects.toThrow("is not a directory");
  });

  test("getWorkspaceById → returns correct workspace", async () => {
    const ws = await wm.getWorkspaceById(testWorkspaceId);
    expect(ws).not.toBeNull();
    expect(ws!.name).toBe("Test Workspace");
  });

  test("getWorkspaceById → returns null for nonexistent", async () => {
    const ws = await wm.getWorkspaceById("nonexistent-id");
    expect(ws).toBeNull();
  });

  test("getWorkspaceByPath → returns correct workspace", async () => {
    const ws = await wm.getWorkspaceByPath(path.resolve(tempDir));
    expect(ws).not.toBeNull();
    expect(ws!.id).toBe(testWorkspaceId);
  });

  test("getWorkspaceByPath → returns null for unknown path", async () => {
    const ws = await wm.getWorkspaceByPath("/unknown/path/xyz");
    expect(ws).toBeNull();
  });
});

// ============================================
// PendingEdit lifecycle
// ============================================

describe("WorkspaceManager — PendingEdit lifecycle", () => {
  const testSessionId = `test-session-${Date.now()}`;
  let editId: string;

  test("createPendingEdit → creates edit with diff", async () => {
    const edit = await wm.createPendingEdit({
      sessionId: testSessionId,
      filePath: "test.ts",
      newContent: 'export const hello = "universe";\nexport const version = 1;\n',
      agentName: "BOLT",
      workspaceRootPath: tempDir,
    });

    expect(edit).not.toBeNull();
    expect(edit.sessionId).toBe(testSessionId);
    expect(edit.filePath).toBe("test.ts");
    expect(edit.status).toBe("pending");
    expect(edit.agentName).toBe("BOLT");
    expect(edit.diff).toContain("--- a/test.ts");
    expect(edit.diff).toContain("+++ b/test.ts");
    editId = edit.id;
  });

  test("listPendingEdits → returns pending edits", async () => {
    const edits = await wm.listPendingEdits(testSessionId);
    expect(edits.length).toBeGreaterThanOrEqual(1);
    expect(edits[0].status).toBe("pending");
  });

  test("getPendingEdit → returns edit by id", async () => {
    const edit = await wm.getPendingEdit(editId);
    expect(edit).not.toBeNull();
    expect(edit!.id).toBe(editId);
  });

  test("getPendingEdit → returns null for nonexistent", async () => {
    const edit = await wm.getPendingEdit("nonexistent-id");
    expect(edit).toBeNull();
  });

  test("approvePendingEdit → applies to filesystem", async () => {
    const edit = await wm.approvePendingEdit(editId, tempDir);

    expect(edit.status).toBe("applied");
    expect(edit.resolvedAt).not.toBeNull();

    // Verify file was written
    const content = fs.readFileSync(path.join(tempDir, "test.ts"), "utf-8");
    expect(content).toContain('export const hello = "universe"');
    expect(content).toContain("export const version = 1");
  });

  test("approvePendingEdit → throws on non-pending edit", async () => {
    // Edit was already approved above
    await expect(wm.approvePendingEdit(editId, tempDir)).rejects.toThrow(
      "Cannot approve edit with status: applied",
    );
  });

  test("rejectPendingEdit → discards without applying", async () => {
    // Tạo edit mới để reject
    const edit = await wm.createPendingEdit({
      sessionId: testSessionId,
      filePath: "new-file.ts",
      newContent: "// This file should NOT be created\n",
      agentName: "SENTINEL",
      workspaceRootPath: tempDir,
    });

    const rejected = await wm.rejectPendingEdit(edit.id);
    expect(rejected.status).toBe("rejected");
    expect(rejected.resolvedAt).not.toBeNull();

    // Verify file was NOT created
    const exists = fs.existsSync(path.join(tempDir, "new-file.ts"));
    expect(exists).toBe(false);
  });

  test("rejectPendingEdit → throws on non-pending edit", async () => {
    // Edit was already rejected
    await expect(
      wm.rejectPendingEdit(editId), // editId was approved, not rejected
    ).rejects.toThrow("Cannot reject edit with status: applied");
  });

  test("getPendingEditsBySession → returns all edits (any status)", async () => {
    const edits = await wm.getPendingEditsBySession(testSessionId);
    expect(edits.length).toBeGreaterThanOrEqual(2); // approved + rejected
  });

  test("createPendingEdit → handles new file (empty oldContent)", async () => {
    const edit = await wm.createPendingEdit({
      sessionId: testSessionId,
      filePath: "brand-new.ts",
      newContent: "// Brand new file\nconst x = 1;\n",
      agentName: "CATALYST",
      workspaceRootPath: tempDir,
    });

    expect(edit.oldContent).toBe(""); // File didn't exist
    expect(edit.diff).toContain("+// Brand new file");
  });
});

// ============================================
// AgentModelOverride
// ============================================

describe("WorkspaceManager — AgentModelOverride", () => {
  const agentName = `TEST_AGENT_${Date.now()}`;

  test("getAgentModelOverride → returns null when not set", async () => {
    const override = await wm.getAgentModelOverride(agentName);
    expect(override).toBeNull();
  });

  test("setAgentModelOverride + getAgentModelOverride → works", async () => {
    await wm.setAgentModelOverride(agentName, "nvidia", "test-model-v1");
    const override = await wm.getAgentModelOverride(agentName);
    expect(override).not.toBeNull();
    expect(override!.provider).toBe("nvidia");
    expect(override!.model).toBe("test-model-v1");
  });

  test("setAgentModelOverride → upserts (update existing)", async () => {
    await wm.setAgentModelOverride(agentName, "nvidia", "test-model-v2");
    const override = await wm.getAgentModelOverride(agentName);
    expect(override).not.toBeNull();
    expect(override!.model).toBe("test-model-v2"); // Updated
  });
});

// ============================================
// FsCheckpoint management
// ============================================

describe("WorkspaceManager — FsCheckpoint", () => {
  const testSessionId = `checkpoint-session-${Date.now()}`;

  test("createCheckpoint → creates record", async () => {
    const cp = await wm.createCheckpoint({
      sessionId: testSessionId,
      workspaceId: testWorkspaceId,
      commitHash: "abc123def456",
      label: "before BOLT edit",
    });

    expect(cp).not.toBeNull();
    expect(cp.commitHash).toBe("abc123def456");
  });

  test("listCheckpoints → returns checkpoints in order", async () => {
    // Create another checkpoint
    // NOTE (quality-gate fix 2026-09-10): chờ 5ms để createdAt của checkpoint
    // thứ 2 chắc chắn LỚN HƠN checkpoint thứ 1. Không chờ thì 2 insert có thể
    // rơi vào cùng 1 millisecond → orderBy createdAt không xác định thứ tự →
    // test flaky khi cả suite chạy nhanh (từng fail 1/169 trên gate).
    await new Promise((r) => setTimeout(r, 5));
    await wm.createCheckpoint({
      sessionId: testSessionId,
      workspaceId: testWorkspaceId,
      commitHash: "fed654cba321",
      label: "after BOLT edit",
    });

    const list = await wm.listCheckpoints(testSessionId);
    expect(list.length).toBeGreaterThanOrEqual(2);
    // Latest first
    expect(list[0].commitHash).toBe("fed654cba321");
    expect(list[1].commitHash).toBe("abc123def456");
  });

  test("listCheckpoints → returns empty for unknown session", async () => {
    const list = await wm.listCheckpoints("nonexistent-session");
    expect(list.length).toBe(0);
  });
});