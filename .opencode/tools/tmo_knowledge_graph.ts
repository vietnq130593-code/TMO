import { tool } from "@opencode-ai/plugin"
import { callTmoTool } from "./_tmo-common"

export default tool({
  description: "Query the TMO Knowledge Graph (Neo4j) for entities and relationships. Returns graph nodes/edges. Use for: finding connections between concepts, entity relationships, graph traversal.",
  args: {
    query: tool.schema.string().describe("Cypher query or natural language graph query"),
    limit: tool.schema.number().optional().describe("Max nodes/edges (default 10)"),
  },
  async execute(args) {
    return callTmoTool("knowledge_graph", {
      query: args.query,
      limit: args.limit || 10,
    })
  },
})
