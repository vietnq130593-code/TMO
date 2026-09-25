import { tool } from "@opencode-ai/plugin"
import { callTmoTool } from "./_tmo-common"

export default tool({
  description: "Write/update the todo list for the current agent task. Use for: planning steps, tracking progress, marking items done/in_progress/pending. The todo list is visible in TMO UI (Thought Process panel).",
  args: {
    todos: tool.schema.string().describe("JSON array of todos: [{\"content\":\"step description\",\"status\":\"pending|in_progress|completed\",\"activeForm\":\"describing action\"}]"),
  },
  async execute(args) {
    try {
      const parsed = JSON.parse(args.todos)
      return callTmoTool("todo_write", { todos: parsed })
    } catch {
      return `Invalid todos JSON. Expected: [{content, status, activeForm}]`
    }
  },
})
