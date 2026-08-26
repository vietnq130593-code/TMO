// ============================================
// /api/workspace — Workspace CRUD API
// ============================================

import { NextRequest } from "next/server";
import { getWorkspaceManager } from "@/lib/workspace/workspace-manager";
import type { CreateWorkspaceInput } from "@/lib/workspace/types";

const wm = getWorkspaceManager();

// ---------------------------------------------------------------------------
// GET /api/workspace[?id=]
// - Không có id → return { active, list }
// - Có id → return workspace detail
// ---------------------------------------------------------------------------
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get("id");

    if (id) {
      const workspace = await wm.getWorkspaceById(id);
      if (!workspace) {
        return Response.json(
          { ok: false, error: `Workspace not found: ${id}` },
          { status: 404 },
        );
      }
      return Response.json({ ok: true, data: workspace });
    }

    const [active, list] = await Promise.all([
      wm.getActiveWorkspace(),
      wm.listWorkspaces(),
    ]);

    return Response.json({
      ok: true,
      data: { active, workspaces: list },
    });
  } catch (err) {
    return Response.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : "Internal server error",
      },
      { status: 500 },
    );
  }
}

// ---------------------------------------------------------------------------
// POST /api/workspace — tạo workspace mới
// Body: { name: string, rootPath: string }
// ---------------------------------------------------------------------------
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();

    // Validate input
    if (!body.name || typeof body.name !== "string") {
      return Response.json(
        { ok: false, error: "name is required (string)" },
        { status: 400 },
      );
    }
    if (!body.rootPath || typeof body.rootPath !== "string") {
      return Response.json(
        { ok: false, error: "rootPath is required (string)" },
        { status: 400 },
      );
    }

    const input: CreateWorkspaceInput = {
      name: body.name.trim(),
      rootPath: body.rootPath.trim(),
    };

    // Phase 2: pre-check conflict BEFORE create (idempotent folder-picker sync)
    const existing = await wm.getWorkspaceByPath(input.rootPath);
    if (existing) {
      return Response.json(
        { ok: false, conflict: true, data: existing },
        { status: 409 },
      );
    }

    try {
      const workspace = await wm.createWorkspace(input);
      return Response.json({ ok: true, data: workspace }, { status: 201 });
    } catch (createErr) {
      // P2002 = Prisma unique-constraint violation (rootPath race between
      // the pre-check above and INSERT). Fall back to 409 + existing record.
      if ((createErr as { code?: string })?.code === "P2002") {
        const raced = await wm.getWorkspaceByPath(input.rootPath);
        if (raced) {
          return Response.json(
            { ok: false, conflict: true, data: raced },
            { status: 409 },
          );
        }
      }
      throw createErr;
    }
  } catch (err) {
    return Response.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : "Internal server error",
      },
      { status: 500 },
    );
  }
}

// ---------------------------------------------------------------------------
// PATCH /api/workspace — set active workspace
// Body: { id: string }
// ---------------------------------------------------------------------------
export async function PATCH(request: NextRequest) {
  try {
    const body = await request.json();

    if (!body.id || typeof body.id !== "string") {
      return Response.json(
        { ok: false, error: "id is required (string)" },
        { status: 400 },
      );
    }

    const workspace = await wm.setActiveWorkspace(body.id);

    // FIX 2026-08-28: user vừa đổi active workspace → invalidate cache root của
    // code-team tools (file_read/shell/... resolve theo active workspace) để tool
    // calls tiếp theo dùng root MỚI ngay lập tức (không chờ TTL 5s).
    const { invalidateWorkspaceRootCache } = await import("@/lib/code-team/workspace-root");
    invalidateWorkspaceRootCache();

    return Response.json({ ok: true, data: workspace });
  } catch (err) {
    return Response.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : "Internal server error",
      },
      { status: 500 },
    );
  }
}

// ---------------------------------------------------------------------------
// DELETE /api/workspace?id=X — xóa workspace (không được xóa active)
// ---------------------------------------------------------------------------
export async function DELETE(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get("id");

    if (!id) {
      return Response.json(
        { ok: false, error: "id query parameter is required" },
        { status: 400 },
      );
    }

    await wm.deleteWorkspace(id);
    return Response.json({ ok: true, data: null });
  } catch (err) {
    return Response.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : "Internal server error",
      },
      { status: 500 },
    );
  }
}