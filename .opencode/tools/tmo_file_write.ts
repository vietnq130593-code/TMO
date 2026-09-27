/**
 * TMO Bridge — file_write (Task 24, 2026-10-21).
 *
 * Native write/edit của OpenCode CLI bị deny qua opencode.json permission —
 * agent viết file PHẢI đi qua bridge này để server-side INFRA GUARD
 * (protected-paths.ts) kiểm soát: chặn ghi hạ tầng runtime (package.json,
 * prisma/, db/, .env, .opencode/...), cho phép src/ + workspace task.
 */
import { tool } from "@opencode-ai/plugin"
import { callTmoTool } from "./_tmo-common"

export default tool({
  description:
    "Write a file (create/overwrite/append). Routes through TMO server with infra guard — writing to runtime infrastructure (package.json, prisma/, db/, .env, .opencode/) is BLOCKED: use tmo_escalate instead if the task truly requires it. For large files write in chunks: first call mode=overwrite, then mode=append.",
  args: {
    path: tool.schema.string().describe("File path relative to workspace root (or absolute)"),
    content: tool.schema.string().describe("Content to write"),
    mode: tool.schema.string().optional().describe("'overwrite' (default) or 'append'"),
    create_dirs: tool.schema.boolean().optional().describe("Create parent dirs (default true)"),
  },
  async execute(args) {
    return callTmoTool("file_write", {
      path: args.path,
      content: args.content,
      mode: args.mode || "overwrite",
      create_dirs: args.create_dirs !== false,
    })
  },
})
