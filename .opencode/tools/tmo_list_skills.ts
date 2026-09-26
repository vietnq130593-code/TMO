import { tool } from "@opencode-ai/plugin"
import { callTmoTool } from "./_tmo-common"

/**
 * TMO Bridge — list_skills.
 *
 * Liệt kê ĐỘNG skill registry của TMO app: DB skills (user tạo) + 52+ skills
 * trên đĩa (skills/<slug>/SKILL.md: pdf, docx, pptx, xlsx, charts, web,
 * design, fullstack-dev, resume-builder...) + 5 dịch vụ web. Per-agent
 * SkillAssignment filtering áp dụng theo TMO_AGENT_NAME (env).
 */
export default tool({
  description:
    "List ALL TMO skills (52+ skill packs: pdf, docx, pptx, xlsx, charts, web, design, fullstack-dev, resume-builder, market-research...). " +
    "Each entry has name + description + slug. BEFORE doing document/chart/web/design work, call this to find relevant skills, " +
    "then call tmo_read_skill with the slug to load full instructions.",
  args: {
    source: tool.schema.enum(["all", "db", "filesystem", "services"]).optional().describe("Which source to scan (default: all)"),
  },
  async execute(args) {
    return callTmoTool("list_skills", {
      source: args.source || "all",
    })
  },
})
