# Tools & Skills Manager — Task 21-c

> Hệ thống quản lý tool-access theo agent + xem/sửa nội dung tools/skills + Omega `manage_tools`.
> User request: "tôi muốn có thể bấm vào từng tools/skills xem và chỉnh sửa nội dung, chọn các agents nào có thể sử dụng được tools nào, thiết lập để Omega cũng có thể sử dụng chức năng này".

## 1. UI — dùng thế nào

Vào module **Skills** (tab graphrag) → panel **Tools Registry** → bấm nút **⚙️ Quản lý Tools & Skills** (cạnh badge đếm tools).

- **Tab Tools**: tìm tool → click 1 tool:
  - **Mô tả**: textarea sửa được → *Lưu mô tả* (ghi `ToolConfig` override — áp vào prompt LLM + UI registry). *Reset về mặc định* nếu đang có override.
  - **Parameters JSON**: read-only (không sửa schema — xem mục 5 Giới hạn).
  - **Badge**: `audit ✅/❌/⏭️` (kết quả runtime-test 21-d, tooltip hiện lý do), `native/openclaw-routed`, flag nếu có.
  - **Ma trận 7 agent** (APEX, CORTEX, BOLT, SENTINEL, CATALYST, Omega, Agent động): mỗi ô 3 trạng thái —
    - xám `✓/✗ mặc định` — whitelist gốc trong code (agents.ts / standalone-agents.ts / DEFAULT_NEW_AGENT_TOOLS)
    - xanh `bật thêm` — override ON (tool ngoài whitelist mặc định được thêm vào)
    - đỏ `đã tắt` — override OFF (tool bị chặn hoàn toàn)
    - nút **reset** (amber) — xóa override, về mặc định.
- **Tab Skills**: 67 filesystem skills + 3 DB skills → click xem nội dung SKILL.md. FS skills sửa được (textarea + confirm — tự backup `.bak` lần đầu sửa mỗi file). DB skills giữ flow cũ (editor trong panel "SKILL.md Guides" bên dưới).

## 2. API endpoints

| Endpoint | Chức năng |
|---|---|
| `GET /api/tools/assignments` | Toàn bộ override + whitelist mặc định theo agent key + ToolConfig |
| `POST /api/tools/assignments` | `{agentKey, toolName, enabled: true\|false\|null, updatedBy?}` — null = reset về mặc định |
| `GET /api/tools/builtin/[name]` | Full def 1 tool: description (mặc định + override) + parameters JSON + ma trận agent |
| `PUT /api/tools/builtin/[name]` | `{description: string\|null}` — lưu/reset mô tả override (≤2000 ký tự) |
| `GET /api/openclaw/skills?action=content&name=X` | Nội dung SKILL.md — DB → **filesystem fallback (mới)** → ClawHub |
| `PUT /api/openclaw/skills/fs` | `{name, content}` — ghi đè `skills/<name>/SKILL.md` (≤512KB, validate slug, backup .bak) |

agentKey hợp lệ: `APEX | CORTEX | BOLT | SENTINEL | CATALYST | OMEGA | NEW_AGENT` (NEW_AGENT = mọi agent động do Omega tạo).

## 3. Kiến trúc enforcement (2 lớp, fail-open)

```
ToolAssignment (SQLite, raw-SQL bridge pattern metrics-db.ts — cache globalThis 30s)
│
├─ LỚP 1 — PROMPT-SIDE (tool không còn trong danh sách cho LLM):
│   • openclaw/chat/route.ts (~:882)  — Omega + agent động (agentTools → getEffectiveToolNames
│     trước khi vào goal-loop → whitelist + protocol injection đều theo effective)
│   • code-team/workflow-engine.ts runAgentStep (~:1366, ~:1493) — Code Team (native FC tool defs
│     build từ effective tools + applyDescriptionOverrides)
│   • subagent-delegate.ts (~:262) — whitelist sub-agent khi delegate_task
│
└─ LỚP 2 — EXECUTOR HARD-GATE (tool-executor.ts executeTool đầu hàm):
    context.agentName → resolveAgentKey → override enabled=false → trả
    "Tool [name] đã bị vô hiệu hóa cho agent [key] bởi quản trị viên" — phủ MỌI đường gọi.
```

- **Fail-open tuyệt đối**: lỗi DB → giữ whitelist mặc định / cho tool chạy. Chat/tool KHÔNG bao giờ fail vì enforcement.
- **Mapping agentKey**: tên agent (APEX/CORTEX/...) + position (TL/G1/G2-A/G2-B/G3) + 'Omega' → 6 key chuẩn; tên động khác → `NEW_AGENT` (chỉ bị chặn khi có override tường minh cho NEW_AGENT).
- **Description override** (`ToolConfig`): thắng mô tả gốc khi build tool defs cho LLM (native FC) + hiển thị `GET /api/tools/registry`.

## 4. Omega `manage_tools` (chỉ Omega — Code Team không có)

Ví dụ prompt cho Omega:
- *"dùng tool manage_tools với action list_tools"* — danh sách tool + agents + override (compact)
- *"hãy tắt tool tavily cho agent CORTEX"* → Omega gọi `manage_tools {action:'set_tool_access', agentKey:'CORTEX', toolName:'tavily', enabled:false}`
- *"xem nội dung skill pdf"* → `{action:'read_skill', name:'pdf'}`
- *"sửa skill web: ..."* → `{action:'write_skill', name:'web', content:'...'}` (backup .bak tự động)

Action: `list_tools` | `set_tool_access` | `read_tool` | `read_skill` | `write_skill`. Ghi `updatedBy='omega'` (phân biệt với 'user' qua UI).

## 5. Chính sách backup & bảo mật

- **Skill FS**: lần đầu sửa mỗi file → copy nội dung hiện tại sang `SKILL.md.bak` (nếu .bak chưa có — giữ snapshot gốc đầu tiên). KHÔNG có API xóa skill. Slug chỉ `[a-z0-9-]` (chống path traversal). Content ≤ 512KB.
- **API auth**: mọi route dùng qua UI đã có `authedFetch` (token header) — các route mới kế thừa middleware auth của app.

## 6. Giới hạn

- KHÔNG sửa được **executor code / parameters schema** của tool builtin — chỉ description (đưa vào prompt) + assignment (bật/tắt). Code executor sửa tại `src/lib/code-team/tool-executor.ts` + deploy lại.
- **Custom tools** (agent tự viết qua `create_custom_tool`): gán được qua POST /api/tools/assignments nhưng UI matrix chỉ hiển thị builtin; quản lý custom qua `/api/tools/custom` (flow cũ).
- Agent "mở" (whitelist rỗng — mọi tool đều phép): prompt-side không enumerate được tập mở → tool bị tắt vẫn chặn được nhờ executor hard-gate.
- ToolAssignment override **không persist vào AgentProfile.tools** trong DB — whitelist gốc trong code vẫn nguyên; override là lớp runtime trên trên (reset = xóa row).
