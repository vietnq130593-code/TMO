import { tool } from "@opencode-ai/plugin"
import { callTmoTool } from "./_tmo-common"

export default tool({
  description: "Search the TMO Knowledge Base (GraphRAG). Returns relevant documents, entities, relationships, and insights. Use for: domain knowledge, past solutions, extracted facts from PDFs.",
  args: {
    query: tool.schema.string().describe("Natural language search query"),
    limit: tool.schema.number().optional().describe("Max results (default 5)"),
  },
  async execute(args) {
    return callTmoTool("knowledge_search", {
      query: args.query,
      limit: args.limit || 5,
    })
  },
})
