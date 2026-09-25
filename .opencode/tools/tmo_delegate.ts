import { tool } from "@opencode-ai/plugin"
import { callTmoTool } from "./_tmo-common"

export default tool({
  description: "Delegate a task to a TMO Code Team agent. Available agents: MEGATRON (TL/orchestrator), SHOCWAVE (G1/architecture), RAMPAGE (G2-A/code), SENTINEL (G2-B/review), CATALYST (G3/optimize). The delegated agent runs autonomously and returns a compressed report.",
  args: {
    agent: tool.schema.string().describe("Agent name: MEGATRON, SHOCWAVE, RAMPAGE, SENTINEL, or CATALYST"),
    task: tool.schema.string().describe("Clear task description for the agent"),
    context: tool.schema.string().optional().describe("Additional context (files, constraints, requirements)"),
    acceptance_criteria: tool.schema.string().optional().describe("Verifiable completion criteria"),
  },
  async execute(args) {
    return callTmoTool("delegate_task", {
      agent: args.agent,
      task: args.task,
      context: args.context || "",
      acceptance_criteria: args.acceptance_criteria || "",
    })
  },
})
