import { tool } from "@opencode-ai/plugin"
import { callTmoTool } from "./_tmo-common"

export default tool({
  description: "Request the Code Team (5-agent pipeline: TL→G1→G2-A→G2-B→G3) to handle a complex coding task. Use for: feature implementation, bug fixes requiring multi-step workflow. Code Team runs full pipeline automatically.",
  args: {
    task: tool.schema.string().describe("Complete task description: goal, scope, constraints"),
    context: tool.schema.string().optional().describe("Additional context: related files, requirements"),
    acceptance_criteria: tool.schema.string().optional().describe("Verifiable completion criteria"),
  },
  async execute(args) {
    return callTmoTool("request_code_team", {
      task: args.task,
      context: args.context || "",
      acceptance_criteria: args.acceptance_criteria || "",
    })
  },
})
