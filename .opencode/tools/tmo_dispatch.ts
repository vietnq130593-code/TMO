import { tool } from "@opencode-ai/plugin"
import { callTmoTool } from "./_tmo-common"

export default tool({
  description: "Dispatch any TMO agent (standalone or team) to execute a task autonomously. Agent runs independently and returns compressed report. Use for: dispatch NEMESIS (research TL), Omega (orchestrator), Opus (CTO), ALISTA (maintenance), or any team agent. For long-term team assignment, add duration='long_term' + team + position.",
  args: {
    agent: tool.schema.string().describe("Agent name: Omega, Opus, ALISTA, NEMESIS, SIVIL, BELI, LISMA, HAN, MEGATRON, SHOCWAVE, RAMPAGE, SENTINEL, CATALYST"),
    task: tool.schema.string().describe("Specific task for the agent"),
    context: tool.schema.string().optional().describe("Additional context"),
    duration: tool.schema.string().optional().describe("'long_term' for team assignment, omit for one-off"),
    team: tool.schema.string().optional().describe("Team for long-term: 'code' or 'research'"),
    position: tool.schema.string().optional().describe("Position: G4, G5, etc. for long-term"),
  },
  async execute(args) {
    return callTmoTool("dispatch_agent", {
      agent: args.agent,
      task: args.task,
      context: args.context || "",
      ...(args.duration === 'long_term' ? { duration: 'long_term', team: args.team || 'code', position: args.position || 'G4' } : {}),
    })
  },
})
