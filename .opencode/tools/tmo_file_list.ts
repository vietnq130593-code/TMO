import { tool } from "@opencode-ai/plugin"
import { callTmoTool } from "./_tmo-common"

export default tool({
  description: "List files in a directory within the TMO workspace. Returns file names + sizes.",
  args: {
    path: tool.schema.string().optional().describe("Directory path (default: workspace root)"),
  },
  async execute(args) {
    return callTmoTool("file_list", {
      path: args.path || ".",
    })
  },
})
