/**
 * TMO Bridge — file_edit (Task 24, 2026-10-21).
 *
 * Native edit của OpenCode CLI bị deny qua opencode.json permission —
 * agent sửa file PHẢI đi qua bridge này để server-side INFRA GUARD
 * (protected-paths.ts) kiểm soát. old_str phải copy NGUYÊN VĂN từ file
 * (server kèm excerpt file thật khi 0 matches để self-correct).
 */
import { tool } from "@opencode-ai/plugin"
import { callTmoTool } from "./_tmo-common"

export default tool({
  description:
    "Edit a file by exact string replacement (old_str → new_str). Routes through TMO server with infra guard — editing runtime infrastructure (package.json, prisma/, db/, .env, .opencode/) is BLOCKED: use tmo_escalate if truly required. Use dry_run:true to preview without writing.",
  args: {
    path: tool.schema.string().describe("File path relative to workspace root (or absolute)"),
    old_str: tool.schema.string().describe("Exact text to replace (copy verbatim from the file)"),
    new_str: tool.schema.string().describe("Replacement text"),
    replace_all: tool.schema.boolean().optional().describe("Replace every occurrence (default false)"),
    dry_run: tool.schema.boolean().optional().describe("Preview diff without writing"),
  },
  async execute(args) {
    return callTmoTool("file_edit", {
      path: args.path,
      old_str: args.old_str,
      new_str: args.new_str,
      replace_all: args.replace_all || false,
      dry_run: args.dry_run || false,
    })
  },
})
