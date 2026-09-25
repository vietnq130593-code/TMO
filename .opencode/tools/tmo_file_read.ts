import { tool } from "@opencode-ai/plugin"
import { callTmoTool } from "./_tmo-common"

export default tool({
  description: "Read content of a file within TMO workspace. Returns file content as text.",
  args: {
    path: tool.schema.string().describe("File path to read"),
  },
  async execute(args) {
    return callTmoTool("file_read", { path: args.path })
  },
})
