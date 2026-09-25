import { tool } from "@opencode-ai/plugin"
import { callTmoTool } from "./_tmo-common"

export default tool({
  description: "Escalate a problem to Omega orchestrator when stuck, encountering repeated errors, or needing strategic advice. Omega analyzes root cause and recommends best solution. If Omega suggests dispatching an agent, system auto-dispatches.",
  args: {
    problem: tool.schema.string().describe("Specific problem description (1-3 sentences)"),
    context: tool.schema.string().optional().describe("Additional context: files, errors, attempts"),
    attempted: tool.schema.string().optional().describe("What was already tried"),
    severity: tool.schema.string().optional().describe("'low', 'medium', or 'high'"),
  },
  async execute(args) {
    return callTmoTool("escalate_problem", {
      problem: args.problem,
      context: args.context || "",
      attempted: args.attempted || "",
      severity: args.severity || "medium",
    })
  },
})
