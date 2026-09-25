import { tool } from "@opencode-ai/plugin"
import { callTmoTool } from "./_tmo-common"

export default tool({
  description: "Execute a shell command in the TMO workspace sandbox. Use for: running tests, installing packages, git operations, build commands.",
  args: {
    command: tool.schema.string().describe("Shell command to execute"),
    cwd: tool.schema.string().optional().describe("Working directory (default: workspace root)"),
  },
  async execute(args) {
    return callTmoTool("shell", {
      command: args.command,
      cwd: args.cwd || ".",
    })
  },
})
