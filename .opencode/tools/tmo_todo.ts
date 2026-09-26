import { tool } from "@opencode-ai/plugin"
import { callTmoTool } from "./_tmo-common"

// TASK 21-d (2026-10-21) — nâng cấp: truyền đủ id/parentId/priority/status qua
// bridge để agent CLI tạo TODO CON lồng nhau (parentId = id todo cha — hiển thị
// dạng cây trong Thought Progress panel) + cập nhật theo id (đóng việc cũ trước
// khi mở việc mới). Native todowrite của OpenCode KHÔNG có parentId — dùng tool
// này khi cần phân rã lồng.
export default tool({
  description:
    "Write/update the todo list for the current agent task (DB-backed, visible in TMO UI Thought Process panel). " +
    "Batch upsert: item có id → update item đó; không id → create. " +
    "Nesting: đặt parentId = id của todo cha để tạo TODO CON (hiển thị lồng nhau). " +
    "Kỷ luật: todo xong đánh dấu completed TRƯỚC KHI thêm todo mới.",
  args: {
    todos: tool.schema.string().describe(
      'JSON array: [{"content":"step","status":"pending|in_progress|completed|failed|blocked","priority":"low|medium|high","id":"<todo id khi update>","parentId":"<id todo cha khi tạo todo con>"}] — activeForm tùy chọn (bỏ qua)',
    ),
  },
  async execute(args) {
    try {
      const parsed = JSON.parse(args.todos)
      if (!Array.isArray(parsed)) {
        return `Invalid todos JSON — expected an array. Example: [{"content":"bước 1","status":"pending"}]`
      }
      // Giữ lại field todo_write hiểu (id/parentId/status/priority/content);
      // strip field lạ của native (activeForm...) để không lỗi validation.
      const clean = parsed
        .filter((t: unknown) => t && typeof t === "object")
        .map((t: Record<string, unknown>) => {
          const out: Record<string, unknown> = {}
          if (typeof t.content === "string" && t.content.trim()) out.content = t.content
          if (typeof t.status === "string") out.status = t.status
          if (typeof t.priority === "string") out.priority = t.priority
          if (typeof t.id === "string" && t.id) out.id = t.id
          if (typeof t.parentId === "string" && t.parentId) out.parentId = t.parentId
          return out
        })
        .filter((t: Record<string, unknown>) => typeof t.content === "string")
      if (clean.length === 0) {
        return `Invalid todos JSON — each item needs a "content" string.`
      }
      return callTmoTool("todo_write", { todos: clean })
    } catch {
      return `Invalid todos JSON. Expected: [{"content":"step","status":"pending","id":"...","parentId":"..."}]`
    }
  },
})
