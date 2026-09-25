import { tool } from "@opencode-ai/plugin"
import { callTmoTool } from "./_tmo-common"

export default tool({
  description: "Search the web for real-time information. Use for: current docs, latest library versions, recent news, external API specs.",
  args: {
    query: tool.schema.string().describe("Search query"),
    num: tool.schema.number().optional().describe("Max results (default 5)"),
  },
  async execute(args) {
    return callTmoTool("web_search", {
      query: args.query,
      num: args.num || 5,
    })
  },
})
