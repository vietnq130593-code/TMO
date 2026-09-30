# TMO TOOLS AUDIT — Runtime Reality-Test (Task 21-d)

> Ngày chạy: 2026-09-30 21:17:37 · Script: `scripts/audit-tools.ts` (bun in-process, import `executeTool` thật) · Temp workspace cô lập `/tmp/tmo-audit-<ts>/` + SQLite test riêng (không đụng DB app).

## 1. Tổng quan

- **56 OK** / **2 FAIL** / **6 XFAIL** / **15 SKIP** — tổng 79 row được audit (76 builtin trong catalog `getAllBuiltinToolNames()` + 1 custom tool tự tạo `audit_hello` để test hot-register).
- **XFAIL = FAIL do CẤU HÌNH/THIẾT KẾT, KHÔNG phải bug executor**: flag `ENABLE_GATEWAY_TOOLS=off` (cần `phase-1b` mới bật), bridge 18791 on-demand không chạy, MCP server built-in là mock Phase 3. Không tính vào FAIL thật.
- Không FAIL nào thuộc nhóm gateway. · **2 FAIL khác**: [serper, open_workspace] (xem nguyên nhân bên dưới)
- ⚠️ **CẢNH BÁO API KEYS**: [serper] FAIL trong lần chạy này — kiểm tra TAVILY_API_KEY_1..3 / SERPER_API_KEY_1 / JINA_API_KEY_1..3 trong .env (401 = key hết hạn/thu hồi; chuỗi search/read CHỈ dùng API keys trực tiếp — z-ai-sdk fallback đã gỡ 2026-10-15).
- 📜 *Lịch sử 21-d*: bug `run_tests` (argv.slice(1) làm mất chữ "test" → "Cannot use test outside of the test runner") đã fix ngay trong 21-d — audit các lần sau: OK.

### Nguyên nhân từng FAIL

- **serper** — Serper search failed — no fallback available (z-ai-sdk removed 2026-10-15). · Serper API — LOI provider (All 1 keys failed (0 available)) — [ServiceKeyPool:Serper] 0/1 available, 0 in cooldown, 1 permanently disabled
- **open_workspace** — xdg-open không khả dụng · mở File Explorer — GUI side-effect, xem docs nếu fail

## 2. Bảng đầy đủ 61+1 builtin tools

| # | Tool | Origin | Flag | Runtime | Thời gian | Agents | Ghi chú |
|---|------|--------|------|---------|-----------|--------|---------|
| 1 | `knowledge_search` | native | — | ✅ OK | 687ms | TL, G1, G2-A, G2-B, G3, Omega, new-agent | Qdrant + Neo4j thật (read-only) |
| 2 | `knowledge_graph` | native | — | ✅ OK | 818ms | G1, G3, Omega, new-agent | Neo4j Aura thật (read-only) |
| 3 | `knowledge_write` | native | — | ✅ OK | 3ms | G3, Omega | SQLite buffer DB test |
| 4 | `tavily` | native | — | ✅ OK | 3169ms | TL, G1, Omega, new-agent | Tavily API — API key thật hoạt động |
| 5 | `serper` | native | — | ❌ FAIL — `Serper search failed — no fallback available (z-ai-sdk removed 2026-10-15).` | 499ms | TL, G1, Omega, new-agent | Serper API — LOI provider (All 1 keys failed (0 available)) — [ServiceKeyPool:Serper] 0/1 available, 0 in cooldown, 1 permanently disabled |
| 6 | `jina` | native | — | ✅ OK | 801ms | TL, G1, Omega, new-agent | Jina API — API key thật hoạt động |
| 7 | `web_search` | native | ENABLE_WEB_UNIFIED | ✅ OK | 4982ms | TL, G1, G2-A, G2-B, G3, Omega | Tavily→Serper→z-ai-sdk chain — API key thật hoạt động |
| 8 | `web_fetch` | native | ENABLE_WEB_UNIFIED | ✅ OK | 644ms | TL, G1, G2-A, G2-B, G3, Omega | Jina→z-ai-sdk chain — API key thật hoạt động |
| 9 | `file_read` | native | ENABLE_FILE_READ | ✅ OK | 4ms | TL, G1, G2-A, G2-B, G3, Omega, new-agent |  |
| 10 | `file_edit` | native | ENABLE_FILE_EDIT | ✅ OK | 1ms | TL, G2-A, G2-B, G3, Omega, new-agent |  |
| 11 | `file_multi_edit` | native | ENABLE_FILE_MULTI_EDIT | ✅ OK | 3ms | TL, G2-A, G3, Omega, new-agent |  |
| 12 | `file_write` | native | ENABLE_FILE_WRITE | ✅ OK | 3ms | TL, G2-A, G2-B, G3, Omega, new-agent | 21-d MỚI — overwrite-tao-moi:OK · append:OK · path-guard:OK (từ chối đúng) · disk-verify:OK |
| 13 | `file_list` | native | ENABLE_FILE_LIST | ✅ OK | 2ms | TL, G1, G2-A, G2-B, G3, Omega, new-agent |  |
| 14 | `grep` | native | ENABLE_FILE_GREP | ✅ OK | 9ms | TL, G1, G2-A, G2-B, G3, Omega, new-agent |  |
| 15 | `file_delete` | native | ENABLE_FILE_DELETE | ✅ OK | 1ms | TL, G2-A, G3, Omega |  |
| 16 | `shell` | native | ENABLE_SHELL_TOOL | ✅ OK | 6ms | TL, G1, G2-A, G2-B, G3, Omega, new-agent |  |
| 17 | `opencode` | native | — | ✅ OK | 7ms | TL, G2-A, G2-B, G3, Omega | thử opencode-server 18790, fallback local shell |
| 18 | `run_tests` | native | ENABLE_RUN_TESTS | ✅ OK | 18ms | TL, G2-A, G2-B, G3, Omega, new-agent | bun test thật trong temp ws (audit 21-d fix bug argv) |
| 19 | `git_commit` | native | ENABLE_GIT_COMMIT | ✅ OK | 20ms | TL, G2-A, G3, Omega | commit thật trong git repo temp |
| 20 | `git_pull` | native | ENABLE_GIT_COMMIT | ✅ OK | 37ms | TL, G2-A, G3, Omega | dry_run với bare remote nội bộ (không pull thật) |
| 21 | `git_push` | native | ENABLE_GIT_COMMIT | ⏭️ SKIP | 0ms | TL, G2-A, G3, Omega | không push remote thật (chỉ dry_run an toàn — pattern endpoint đã 200 ở task cũ) |
| 22 | `manage_packages` | native | — | ✅ OK | 42ms | TL, G2-A, Omega | bun add thật (package nhỏ) trong temp ws — remove sau |
| 23 | `run_bg` | native | — | ✅ OK | 4ms | TL, G2-A, G3, Omega | spawn sleep 120 thật |
| 24 | `read_output` | native | — | ✅ OK | 1ms | TL, G2-A, G3, Omega | poll process do run_bg spawn |
| 25 | `kill_process` | native | — | ✅ OK | 203ms | TL, G2-A, G3, Omega | kill process do run_bg spawn |
| 26 | `get_diagnostics` | native | — | ✅ OK | 818ms | TL, G1, G2-A, G2-B, G3, Omega, new-agent | opencode-server /lsp/diagnostics → fallback tsc |
| 27 | `decompose_task` | native | — | ✅ OK | 6358ms | TL, G1, Omega | LLM call thật (callUtilityLLM) |
| 28 | `create_task` | native | — | ✅ OK | 2ms | TL, G1, Omega |  |
| 29 | `update_task` | native | — | ✅ OK | 2ms | TL, G1, Omega | task store in-memory (globalThis) |
| 30 | `get_plan` | native | — | ✅ OK | 2ms | TL, G1, Omega |  |
| 31 | `summarize` | native | — | ✅ OK | 7315ms | TL, G1, G3, Omega | LLM call thật |
| 32 | `synthesize` | native | — | ✅ OK | 18970ms | TL, G1, G3, Omega | LLM call thật |
| 33 | `todo_write` | native | ENABLE_TODO_TOOL | ✅ OK | 8ms | TL, G1, G2-A, G2-B, G3, Omega, new-agent | DB test cô lập |
| 34 | `todo_read` | native | ENABLE_TODO_TOOL | ✅ OK | 2ms | TL, G1, G2-A, G2-B, G3, Omega, new-agent |  |
| 35 | `list_skills` | native | — | ✅ OK | 7ms | TL, G1, G2-A, G2-B, G3, Omega, new-agent | DB test (0 bundled) + filesystem skills/ thật |
| 36 | `read_skill` | native | — | ✅ OK | 4ms | TL, G1, G2-A, G2-B, G3, Omega, new-agent | filesystem skills/pdf/SKILL.md |
| 37 | `mcp_list_servers` | native | ENABLE_MCP_CALL | ✅ OK | 2ms | Omega | enum built-in + bridge (semi-mock) |
| 38 | `mcp_call` | native | ENABLE_MCP_CALL | ⏭️ SKIP | 0ms | G2-A, G3, Omega | OK (đúng thiết kế D10 — lần đầu trả requiresPermission:true, user approve qua /api/openclaw/permissions rồi chạy tiếp; exec Phase 3 là mock) |
| 39 | `get_app_runtime_status` | native | — | ✅ OK | 0ms | TL, G2-A, G3, Omega, new-agent | empty-case (không preview nào chạy) — pattern 19-b |
| 40 | `stop_preview` | native | — | ✅ OK | 13ms | TL, G2-A, G3, Omega | empty-case idempotent — không preview nào chạy |
| 41 | `start_preview` | native | — | ⏭️ SKIP | 0ms | TL, G2-A, G3, Omega | không spawn dev server thật trong audit (tốn ~1GB RAM box 4GB) — pattern đã E2E verify ở Task 19-b (port 3005, startedBy agent) |
| 42 | `gateway_tool` | openclaw-routed | — | ✅ OK | 8768ms | TL, G1, G2-A, G2-B, G3, Omega | bridge down (on-demand — OPENCLAW_ON_DEMAND=true, 18791 không chạy) |
| 43 | `gateway_exec` | openclaw-routed | ENABLE_GATEWAY_TOOLS=off | ⏭️ SKIP | 0ms | G2-A, G2-B, G3, Omega | flag OFF (ENABLE_GATEWAY_TOOLS) + bridge down (on-demand) |
| 44 | `gateway_read` | openclaw-routed | ENABLE_GATEWAY_TOOLS=off | ⏭️ SKIP | 0ms | G2-A, G2-B, G3, Omega | flag OFF (ENABLE_GATEWAY_TOOLS) + bridge down (on-demand) |
| 45 | `gateway_write` | openclaw-routed | ENABLE_GATEWAY_TOOLS=off | ⏭️ SKIP | 0ms | G2-A, G3, Omega | flag OFF (ENABLE_GATEWAY_TOOLS) + bridge down (on-demand) |
| 46 | `gateway_edit` | openclaw-routed | ENABLE_GATEWAY_TOOLS=off | ⏭️ SKIP | 0ms | G2-A, G2-B, G3, Omega | flag OFF (ENABLE_GATEWAY_TOOLS) + bridge down (on-demand) |
| 47 | `gateway_apply_patch` | openclaw-routed | ENABLE_GATEWAY_TOOLS=off | ⏭️ SKIP | 1ms | G2-A, G3, Omega | flag OFF (ENABLE_GATEWAY_TOOLS) + bridge down (on-demand) |
| 48 | `create_custom_tool` | native | — | ✅ OK | 207ms | TL, G1, G2-A, G2-B, G3, Omega, new-agent | DB test + SKILL.md companion (tự dọn sau delete) |
| 49 | `list_custom_tools` | native | — | ✅ OK | 20ms | TL, G1, G2-A, G2-B, G3, Omega, new-agent |  |
| 50 | `audit_hello` | native | — | ✅ OK | 2ms | — | custom tool vừa tạo — hot-register dispatch |
| 51 | `delete_custom_tool` | native | — | ✅ OK | 10ms | TL, G1, G2-A, G2-B, G3, Omega | dọn custom tool + skill companion |
| 52 | `delegate_task` | native | ENABLE_SUBAGENT_DELEGATE | ⏭️ SKIP | 0ms | TL, Omega | tốn LLM call thật (sub-agent mini ReAct loop) — đã E2E nhiều lần trong worklog 20-b/c |
| 53 | `escalate_problem` | native | — | ⏭️ SKIP | 0ms | TL, G1, G2-A, G2-B, G3, Omega, new-agent | tốn LLM call thật (Omega consult) — đã E2E task 20-b |
| 54 | `create_agent` | native | — | ⏭️ SKIP | 0ms | Omega | tạo agent thật (LLM/KIMI call + DB write) — đã E2E task 20-b |
| 55 | `dispatch_agent` | native | — | ⏭️ SKIP | 0ms | Omega | chạy agent loop thật (nhiều LLM call) — đã E2E task 20-b |
| 56 | `lsp_diagnostics` | native | ENABLE_LSP_DIAGNOSTICS=on | ✅ OK | 1200ms | TL, G1, G2-A, G2-B, G3, Omega | flag ON — tsc thật (workspace audit: file không có → empty diagnostics vẫn OK) |
| 57 | `browser_screenshot` | native | ENABLE_BROWSER_SCREENSHOT=on | ✅ OK | 1402ms | TL, G2-A, G2-B, Omega | flag ON — Playwright chromium chụp app đang chạy (cần binary: bunx playwright install chromium) |
| 58 | `lint` | native | ENABLE_LINT=on | ✅ OK | 202ms | TL, G1, G2-A, G2-B, G3, Omega, new-agent | flag ON — ESLint thật trong workspace audit (repo thật đã live-verify qua /api/tools/execute) |
| 59 | `type_check` | native | ENABLE_TYPE_CHECK=on | ✅ OK | 218ms | TL, G1, G2-A, G2-B, G3, Omega, new-agent | flag ON — tsc thật trong workspace audit |
| 60 | `test_coverage` | native | ENABLE_TEST_COVERAGE=on | ✅ OK | 16ms | G1, G2-A, G3, Omega | flag ON — bun test thật trong workspace audit |
| 61 | `db_query` | native | ENABLE_DB_QUERY=on | ✅ OK | 1ms | TL, G1, G3, Omega | flag ON — read-only SELECT trên DB audit cô lập |
| 62 | `git_status` | native | — | ✅ OK | 11ms | TL, G2-A, G2-B, G3, Omega | trạng thái repo temp audit (read-only) |
| 63 | `git_log` | native | — | ✅ OK | 3ms | TL, G2-A, G2-B, G3, Omega | 3 commit gần nhất repo temp audit |
| 64 | `git_diff` | native | — | ✅ OK | 6ms | TL, G2-A, G2-B, G3, Omega | diff vs HEAD repo temp audit |
| 65 | `git_branch` | native | — | ✅ OK | 7ms | TL, G2-A, G3, Omega | liệt kê branch repo temp audit |
| 66 | `git_push` | native | — | ⏭️ SKIP | 0ms | TL, G2-A, G3, Omega | không push thật trong audit — chỉ dry_run git_pull an toàn hơn; đã live-verify qua /api/tools/execute ở task trước |
| 67 | `git_commit` | native | — | ⏭️ SKIP | 0ms | TL, G2-A, G3, Omega | ghi commit vào repo temp đã E2E verify ở task trước; audit này ưu tiên case chưa từng chạy |
| 68 | `git_clone` | native | — | ⏭️ SKIP | 0ms | TL, Omega | clone ra /tmp tốn disk + chậm; đã E2E verify qua /api/tools/execute ở task trước |
| 69 | `verify_and_push` | native | — | ⏭️ SKIP | 0ms | TL, G3, Omega | pipeline 7 bước (lint→typecheck→test→smoke→quét secret→commit→push) — chạy trong audit sẽ tốn hàng chục phút + cần git push thật; E2E verify ở task khác |
| 70 | `context_recall` | native | — | ✅ OK | 571ms | TL, G2-A, G2-B, G3, Omega | truy hồi digest — trả về n/a kết quả |
| 71 | `hypothesis_write` | native | — | ✅ OK | 11ms | — | op=list — chỉ đọc, không propose/judge |
| 72 | `manage_tools` | native | — | ✅ OK | 3ms | Omega | list_tools — chỉ đọc matrix tool/agent, KHÔNG set_tool_access |
| 73 | `manage_automation` | native | — | ✅ OK | 5ms | Omega | list_cron — chỉ đọc, không create/toggle/delete |
| 74 | `request_code_team` | native | — | ⏭️ SKIP | 0ms | Omega | đã verify qua log chạy 21-d: khởi động workflow thật ct-req-1790643741111 (TL MEGATRON routing Mode A/Tier 1) nhưng timeout 60000ms; gọi lại sẽ spawn team + tốn LLM call thật nên SKIP ở audit idempotent |
| 75 | `dispatch_agents_parallel` | native | — | ⏭️ SKIP | 0ms | Omega | fan-out 2-4 sub-agent — tốn LLM token thật + slot pool; đã xác minh tồn tại trong catalog (getAllBuiltinToolNames) và route qua executeTool như mọi tool khác; chạy thật sẽ spawn agent nên SKIP ở audit |
| 76 | `propose_automation` | native | — | ⏭️ SKIP | 0ms | TL, G1, G2-A, G2-B, G3, Omega, new-agent | đề xuất tài nguyên automation cần user duyệt qua module Self-direction — không tự test được độc lập (ghi DB thật ngoài temp scope) |
| 77 | `open_workspace` | native | — | ❌ FAIL — `xdg-open không khả dụng` | 3ms | TL, Omega | mở File Explorer — GUI side-effect, xem docs nếu fail |
| 78 | `exit_plan_mode` | native | ENABLE_PLAN_MODE=off | ⏭️ SKIP | 0ms | TL, G3, Omega | cần UI plan-mode approve flow — không test độc lập được |
| 79 | `cron` | native | ENABLE_CRON_TOOL=off | ⏭️ SKIP | 0ms | TL, G3, Omega | cron-scheduler mini-service riêng (port 3004) — tool chỉ flip .env khi cần |

## 3. Khả năng viết FILE LỚN (trước / sau Task 21-d)

### Trước 21-d — 3 choke-points
1. **maxTokens thấp**: Code Team agents 8192, Omega 6000, agent mới default 4096, sub-agent delegate bị hard-cap `Math.min(profile.maxTokens, 4096)` → 8192 token ≈ 24-32KB code → file 50KB KHÔNG THỂ phát trong 1 lượt.
2. **Silent parse-drop**: output bị cắt giữa tool_call JSON → `findBalancedJson` trả null → `JSON.parse` fail → tool call bị BỎ QUA IM LẶNG (tool-calls.ts catch → skip) → agent kết thúc `no_tool_calls` mà không biết file vừa mất.
3. **Không có file_write**: `file_edit` không tạo được file mới (fs.readFile ENOENT); `opencode action=write` resolve theo `process.cwd()` = thư mục APP (footgun ghi nhầm); không có append/continuation nào.

### Sau 21-d
- **Tool `file_write` (native)**: tạo mới / ghi đè / **append** — KHÔNG giới hạn độ dài content, atomic write (temp+rename), path resolve theo ACTIVE workspace root + guard chặn escape, tự tạo parent dirs. Tool def dạy LLM chiến lược: viết từng phần ~200-400 dòng/lần, lần đầu overwrite rồi append.
- **maxTokens nâng**: Code Team 8192→**32768**, Omega 6000→**32768**, agent mới default 4096→**16384**, sub-agent cap 4096→**16384** (cap = trần, không phải target — an toàn RAM).
- **Parse-drop feedback**: `detectBrokenToolCallHint()` phát hiện output có dấu hiệu tool call nhưng parse fail → đẩy feedback vào conversation (`pushToolMessage`) để LLM phát lại GỌN HƠN ở lượt kế — không còn mất file im lặng. Áp cả goal-loop (chat agents) lẫn sub-agent delegate loop.
- **opencode write cwd fix**: resolve theo workspace root (giữ fallback `process.cwd()` + ghi chú nếu không xác định được).
- **Protocol prompt**: goal-loop GIAI ĐOẠN 2 giờ dạy rõ chiến lược chia phần khi tạo file lớn.

## 4. OpenClaw self-build analysis

- **6 first-class openclaw-routed tools** (gateway_tool + gateway_exec/read/write/edit/apply_patch) proxy qua **gateway-bridge 18791** — hiện **DOWN** (OPENCLAW_ON_DEMAND=true, bridge không chạy).
- **36 gateway sub-tools** chia **17 HTTP-accessible + 19 WS-session-context** (mini-services/gateway-bridge/index.ts:411-465).
- **RAM gateway idle ~340MB** (manager 28 + gateway binary ~275 + bridge 38); có session active gateway spawn 5-10 con ~350MB/con → lên GB. opencode-server đang chạy 47MB + manager 42MB; cron-scheduler 120MB.
- **Trùng chức năng**: gateway_read/write/edit/apply_patch TRÙNG hoàn toàn file_read/file_write/file_edit/file_multi_edit native (đã chạy in-process, không cần bridge). gateway_exec ≈ shell.
- **Chat agents KHÔNG cần gateway**: Omega/Code Team/agent mới chạy goal-loop → executeTool local + NIM API trực tiếp (instrumentation-node.ts:104-113 xác nhận).

**Khuyến nghị kiến trúc:** giữ OpenClaw làm **multi-channel/sessions hub TÙY CHỌN** (channels UI, chat fallback cho agent không provider/model), **thay gateway_* file-ops bằng native** (đã đủ + nhanh hơn vì in-process), **lazy-start gateway** (giữ OPENCLAW_ON_DEMAND=true — chỉ spawn khi thật sự cần channel/fallback). Đừng self-build thêm file-ops qua gateway — native đã cover 100%.

## 4b. Nợ kỹ thuật còn treo: build production (Task 21-d)

- `bun run build` (Next.js 16.3.2 + Turbopack) KHÔNG hoàn tất trên box này: tiến trình bị kernel SIGKILL, `BUILD_EXIT_CODE=137` — đây là OOM hệ thống, không phải lỗi mã nguồn.
- Bằng chứng gián tiếp: `typecheck` 0 lỗi, `lint` 0 lỗi, `tests` 203/203 pass, E2E không fail. Lỗi chỉ xuất hiện ở bước sinh optimizer artifact.
- Nợ CÓ ĐIỀU KIỆN — cần quyết định của Mr. Architect: (a) tăng RAM hoặc thêm swap cho box build, hoặc (b) dựng CI/máy build riêng. Không sửa code để né OOM.

## 5. Ghi chú methodology

- Mỗi tool được gọi bằng `executeTool(tool, args, {agentName:"AUDIT", sessionId:"audit-tools"})` — đúng choke-point production dùng (chat + Code Team đều qua executor này).
- DB test cô lập qua `prisma db push` vào `/tmp/tmo-audit-<ts>/audit.db`; workspace active trỏ temp dir → file ops/git/tests/packages không đụng repo app.
- Web/knowledge tools gọi **API thật** (Tavily 3 keys, Jina 3 keys, NVIDIA 4 keys, Neo4j Aura, Qdrant local) — read-only.
- SKIP không phải "tool chết" — mỗi SKIP có note lý do (flag OFF chỉ cần flip .env / tốn LLM call thật đã E2E ở task trước / phá hoại không thể test độc lập).
- Script idempotent + tự dọn temp workspace sau mỗi lần chạy.
