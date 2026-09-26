import { tool } from "@opencode-ai/plugin"
import { callTmoTool } from "./_tmo-common"

/**
 * TMO Bridge — read_skill.
 *
 * Đọc nội dung đầy đủ SKILL.md của 1 skill theo slug (DB AgentSkill →
 * filesystem skills/<slug>/SKILL.md). Executor hard-gate SkillAssignment
 * áp dụng theo TMO_AGENT_NAME (env) — skill bị admin chặn sẽ từ chối đọc.
 */
export default tool({
  description:
    "Load the FULL instructions (SKILL.md) of a TMO skill by its slug (slug comes from tmo_list_skills). " +
    "Read this BEFORE executing the skill's task so you follow its exact workflow, templates and tool usage.",
  args: {
    slug: tool.schema.string().describe("Skill slug from tmo_list_skills (e.g. 'pdf', 'charts', 'web')"),
  },
  async execute(args) {
    return callTmoTool("read_skill", {
      slug: args.slug,
    })
  },
})
