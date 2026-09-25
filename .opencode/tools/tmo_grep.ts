import { tool } from "@opencode-ai/plugin"
import { callTmoTool } from "./_tmo-common"

export default tool({
  description: "Search file contents within TMO workspace using regex pattern. Returns matching lines with file:line locations.",
  args: {
    pattern: tool.schema.string().describe("Regex pattern to search for"),
    path: tool.schema.string().optional().describe("Directory to search in (default: workspace root)"),
    glob: tool.schema.string().optional().describe("File glob filter (e.g. '*.ts')"),
  },
  async execute(args) {
    return callTmoTool("grep", {
      pattern: args.pattern,
      path: args.path || ".",
      glob: args.glob || "",
    })
  },
})
