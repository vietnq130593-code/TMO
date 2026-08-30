# 🏛️ KẾ HOẠCH NÂNG CẤP CHỨC NĂNG CODE — THE MAGNUM OPUS

| Thuộc tính | Giá trị |
|---|---|
| **Phiên bản** | 1.0 |
| **Ngày lập** | 2026-09-11 |
| **Người lập kế hoạch** | Opus (Kiến trúc sư AI / Kỹ sư hệ thống) |
| **Người phê duyệt** | Mr. Architect |
| **Trạng thái** | 🟣 TRIỂN KHAI HOÀN TẤT — GĐ1 + GĐ2 (2026-09-11, golden E2E PASS) + GĐ3 (2026-08-30, B8 4/4 PASS) + GĐ4 (2026-08-30, B8 4/4 PASS + review tổng thể 0 CRITICAL, flag rollout chờ quyết định flip) — 6/6 hạng mục CI-1..CI-6 đã code xong |
| **Phạm vi** | 6 hạng mục cải tiến chức năng code, triển khai liên tục dài hạn |
| **Workspace chuẩn** | `E:\APP\TMO-clone` (máy local Mr. Architect) |
| **Kho lưu trữ chuẩn** | `https://github.com/vietnq130593-code/TMO` (private) |

---

## 0. TÓM TẮT ĐIỀU HÀNH

### 0.1. Bảng tổng quan 6 hạng mục

| Mã | Hạng mục | Mức ưu tiên | Quy mô | Giai đoạn | Rủi ro |
|---|---|---|---|---|---|
| **CI-1** | Bỏ giới hạn token budget cho toàn bộ agents | 🔴 Cao | S–M | GĐ1 | Thấp |
| **CI-2** | Todo theo từng tác vụ + tự đánh dấu hoàn thành | 🔴 Cao | M | GĐ2 | Thấp |
| **CI-3** | Nén context thông minh + lưu trữ truy xuất lại | 🟠 Vừa | M–L | GĐ3 | Vừa |
| **CI-4** | Bổ sung tools/skills cho tác vụ code | 🟠 Vừa | S–M | GĐ1–GĐ2 | Thấp |
| **CI-5** | Kiến trúc thực thi bền vững cho tác vụ nhiều giờ | 🔴 Cao | L | GĐ4 | Cao |
| **CI-6** | Workflow workspace `E:\APP\TMO-clone` → kiểm định → push → pull | 🔴 Cao | M | GĐ1–GĐ2 | Vừa |

### 0.2. Nguyên tắc chung (bắt buộc với mọi hạng mục)

1. **Mọi thay đổi code triển khai tại `E:\APP\TMO-clone` trước** — không sửa trực tiếp trên bản đang chạy production.
2. **Kiểm định đầy đủ trước push**: lint PASS + typecheck PASS + tests PASS + smoke test không lỗi + quét secret trong diff → mới được `git push`.
3. **Sau push bắt buộc `git pull` verify** từ chính kho `vietnq130593-code/TMO` để xác nhận vòng lặp khép kín.
4. **Không hardcode token/API key vào code** — token GitHub lưu tại token store (`db/.github-token.json`) hoặc env `GITHUB_TOKEN`, không bao giờ commit.
5. **Feature flag cho mọi thay đổi lớn** — default off, bật dần theo giai đoạn, có đường rollback.
6. **Tương thích DB** — cột mới phải nullable/có default, không phá dữ liệu hiện có.

### 0.3. ⚡ Trả lời nhanh câu hỏi File Explorer (chi tiết tại CI-6.6)

> *"Thông thường tôi sẽ mở sẵn thư mục này trong workspace nhưng nếu tôi quên thì liệu có cách nào để Omega có thể tự chọn thư mục này bằng File Explorer và khởi chạy không?"*

**CÓ — 3 lớp phòng thủ:**
1. **Tự động lúc app khởi động** — routine `ensureDefaultWorkspace()` tự đăng ký `E:\APP\TMO-clone` là workspace active (kể cả khi anh quên mở).
2. **Tự động trước mỗi tác vụ code** — Omega kiểm tra workspace active trước khi làm việc; nếu chưa có → tự activate, nếu thư mục chưa tồn tại → tự tạo + `git init` + gắn remote.
3. **Mở File Explorer bằng lệnh shell** — tool mới `open_workspace` chạy `explorer.exe "E:\APP\TMO-clone"` (Windows) / `xdg-open` (Linux) — Omega gọi khi cần mở thư mục cho anh xem, kể cả khi anh chưa mở sẵn.

---

## 1. BỐI CẢNH & HIỆN TRẠNG KIẾN TRÚC (điều tra ngày 2026-09-11)

### 1.1. Ba đường thực thi tác vụ của hệ thống

```
ĐƯỜNG 1 — CHAT ĐƠN AGENT (goal loop)          ← NƠI XẢY RA "HẾT TOKEN BUDGET"
POST /api/openclaw/chat → runGoalDrivenLoop (src/lib/agent-goal-loop.ts)
  Chu kỳ 1..N: PLAN → EXECUTE (ReAct ×M) → VERIFY → EVALUATE → REPLAN
  Dừng bởi: complete | max_cycles | time_budget | token_budget | no_progress | error

ĐƯỜNG 2 — CODE TEAM WORKFLOW (tác vụ code team)
POST /api/code-team/workflow (SSE) → runPipeline (src/lib/code-team/workflow-engine.ts)
  TL(APEX) analyze → G1 design → G2-A code → G2-B review → G3 optimize → TL verify
  Không có token budget cứng — giới hạn bằng số vòng lặp (5/15/25) + timeout 4'/LLM call

ĐƯỜNG 3 — SELF-DIRECTION ORCHESTRATION (nền)
Scheduler 60s (instrumentation-node.ts) → promoteDueProposals → runOrchestration
  Omega lập kế hoạch 3-12 bước → executeStep → evaluateStep → writeFinalReport
```

### 1.2. Bảng giới hạn hiện hành (nguồn gây dừng tác vụ)

| Giới hạn | Giá trị mặc định | Vị trí | Ghi chú |
|---|---|---|---|
| Token budget toàn loop | **200.000** | `agent-goal-loop.ts:122` | ⚠️ Nguyên nhân chính "dừng giữa chu kỳ" |
| Report reserve | ~20k (10%) | `agent-goal-loop.ts:129` | Cản trở bắt đầu chu kỳ mới khi cạn |
| Thời gian toàn loop | **30 phút** | `agent-goal-loop.ts:120` | ⚠️ Phản ánh tác vụ nhiều giờ |
| Số chu kỳ × vòng/chu kỳ | **4 × 10 = 40 lượt LLM** | `agent-goal-loop.ts:114,116` | ⚠️ Trần thực sự của tác vụ phức tạp |
| Sub-agent delegate | 40k token / 5 vòng / 8 phút | `subagent-delegate.ts:50-54` (`.env` đang set) | Sub-agent bỏ dở giữa chừng |
| LLM call đơn (workflow) | 4 phút | `workflow-engine.ts:327` | Giết các lượt suy luận chậm |
| Vòng lặp mỗi bước team | 5 / 15 / 25 | `workflow-engine.ts:1105-1107` | G2-B & TL-verify chỉ 5 vòng |
| Output cap mỗi LLM call | 4096 tokens | `AgentProfile.maxTokens` | Cắt cụt file lớn giữa chừng |
| Ngưỡng context overflow | 80k tokens (pause, KHÔNG tự resume) | `workflow-engine.ts:336` | Tác vụ dài treo vĩnh viễn |

### 1.3. Vấn đề đã xác nhận có bằng chứng (từ điều tra codebase)

| # | Phát hiện | Bằng chứng |
|---|---|---|
| 1 | Todo chỉ scope theo `sessionId`, **không có khóa tác vụ** → todo tác vụ cũ trộn vào tác vụ mới | `prisma/schema.prisma:923-951` (model Todo chỉ có sessionId); `dev-tools.ts:2132` |
| 2 | Không có gì reset/todo-archive khi tác vụ mới bắt đầu; UI truyền **toàn bộ todo của session** cho mọi panel | `page.tsx:11020` (todos={sessionTodos}), `page.tsx:4243` (session list override `run.lastTodos`) |
| 3 | Chỉ có auto-close **hàng loạt** cuối run ("LLM thường quên gọi todo_write" — comment chính trong code); không có hoàn thành theo từng mục dựa trên evidence | `chat/route.ts:958-975` |
| 4 | Goal-loop **đã có** nén rolling digest 50k chars (LLM digest + WorkingMemory HOT) — tốt hơn nhận định ban đầu | `agent-goal-loop.ts:499-615` |
| 5 | Code Team workflow **không có nén** + tool result đẩy vào messages **không giới hạn** | `workflow-engine.ts:1841-1849` |
| 6 | Digest chỉ lưu preview 400 ký tự vào WorkingMemory — **không offload full digest** vào kho truy xuất lại (Qdrant) | `agent-goal-loop.ts:612` |
| 7 | `ENABLE_SESSION_RESUME=false` → pause/resume khi overflow là **code chết**; auto-resume không tồn tại | `feature-flags.ts:97`, `session-resume.ts` |
| 8 | Goal loop chạy **bên trong 1 HTTP POST** → đóng tab/proxy timeout/restart PM2 = mất trắng tiến trình | `chat/route.ts:897` |
| 9 | Vòng lặp edit→test→commit→push→pull đã xây **~90%** nhưng các flag chất lượng đang TẮT | `docs/TOOLS_AUDIT.md` (43 OK / 6 FAIL gateway / 14 SKIP flag-off) |
| 10 | Omega **thiếu quyền** lint/type_check/lsp/test_coverage → phải dùng shell hoặc delegate | `standalone-agents.ts:203-265` |
| 11 | Thiếu tools structured: git_status / git_diff / git_log / git_branch / git_clone | `tool-executor.ts` (chỉ có commit/push/pull) |
| 12 | `/api/git-pull` (tự cập nhật app) đang trỏ repo CŨ `nguyenquocviety2c-code/TMO` | `git-pull/route.ts:32` |
| 13 | Repo mới `vietnq130593-code/TMO`: **tồn tại, private, đang TRỐNG** (chưa có branch nào) | Kiểm tra GitHub API 2026-09-11 |
| 14 | Nếu không set workspace → mọi tool file/shell mặc định thao tác trên **chính thư mục app** (footgun) | `workspace-root.ts:26` (active workspace → OPENCODE_WORKSPACE → cwd) |

---

## CI-1. BỎ GIỚI HẠN TOKEN BUDGET CHO TOÀN BỘ AGENTS

> **Đề xuất SELF-DIRECTION tương ứng: SD-CI-1**

### Vấn đề (lời Mr. Architect)
Chức năng code thường xuyên **dừng lại giữa phần đầu chu kỳ do hết token budget**. Không muốn giới hạn token budget cho bất kỳ agents nào.

### Điều tra hiện trạng
- Budget cứng duy nhất đang ép: goal loop — `TOKEN_BUDGET=200_000` (`agent-goal-loop.ts:122`), kiểm tra tại **6 điểm**: L948 (gate chu kỳ), L973 (mỗi vòng ReAct), L1068 (trước mỗi tool call), L1082 (chặn delegate), L1166 (sau tool batch), L1384 (sau evaluator). Thông báo dừng: `"hết budget token (200000 — có thể tăng qua env GOAL_LOOP_TOKEN_BUDGET)"` (L1439).
- Sub-agent delegate: 40k / 5 vòng / 8 phút — **đang ép qua `.env`** (dòng 162-166).
- Code Team workflow: **không có** token budget cứng (BASE_TOKEN_BUDGET=100000 chỉ vào metrics, `workflow-engine.ts:710`) — nhưng bị trần bằng vòng lặp 5/15/25.
- Các cơ chế khác (DailyToken*, token-monitor) chỉ **theo dõi hiển thị**, không chặn — giữ nguyên.

### Nguyên nhân gốc
1. Hệ số mặc định 200k/30'/4chu kỳ đặt cho tác vụ ngắn — không đủ cho tác vụ code phức tạp.
2. Dù tăng env, checkpoint `tokenLeft() <= REPORT_RESERVE` vẫn dừng khi cạn — không có chế độ "không giới hạn".
3. Trần vòng lặp (40 lượt LLM) là giới hạn ẩn thứ hai — kể cả vô hạn token, tác vụ vẫn chết vì `max_cycles`.

### Thiết kế giải pháp
**Nguyên tắc: `0 = KHÔNG GIỚI HẠN`** — mọi tham số budget hiểu giá trị 0 như "tắt hoàn toàn cơ chế dừng tương ứng", nhưng **giữ nguyên các phanh an toàn khác** (no_progress, cancelled, error — chống vòng lặp vô hạn thật sự).

```
GOAL_LOOP_TOKEN_BUDGET=0            → tokenLeft()=∞, bỏ qua cả REPORT_RESERVE
GOAL_LOOP_TIME_BUDGET_MS=0          → timeLeft()=∞
GOAL_LOOP_MAX_CYCLES=0              → không trần chu kỳ (no_progress vẫn dừng khi kẹt)
GOAL_LOOP_ITERATIONS_PER_CYCLE=0    → không trần vòng/chu kỳ
SUBAGENT_TOKEN_BUDGET=0             → sub-agent không dừng vì token
SUBAGENT_TIMEOUT_MS=0               → sub-agent không dừng vì giờ
```

Giữ nguyên (đây là phanh an toàn, không phải budget):
- `no_progress` detection (kẹt lặp không tiến triển) — **tăng cường** làm phanh chính thay thế budget.
- `cancelled` (nút Dừng của user) và `error`.
- 429 rate-limit cooldown + key rotation (llm.ts) — chống spam API, không giới hạn tổng.
- `KEY_ROTATION_BUDGET_MS` 15 phút/lượt call — chống treo, giữ.

### Các bước triển khai
- [ ] **B1.** Sửa `src/lib/agent-goal-loop.ts`: các hàm `tokenLeft()/timeLeft()` trả về `Infinity` khi env=0; 6 điểm check L948/973/1068/1082/1166/1384 tự động vô hiệu (so sánh với Infinity luôn false — kiểm thử kỹ); `REPORT_RESERVE_TOKENS=0` khi budget=0.
- [ ] **B2.** Bỏ trần `MAX_CYCLES`/`ITER_PER_CYCLE` khi =0 (điều kiện vòng lặp); đảm bảo `stopReason` không còn trả `max_cycles` sai.
- [ ] **B3.** Sửa `src/lib/subagent-delegate.ts` L281-289: bỏ forceWrapUp khi budget=0/timeout=0.
- [ ] **B4.** Tăng cường no_progress: nếu ≥3 chu kỳ liên tiếp evaluator verdict "không tiến triển" (không file đổi, không test mới pass) → dừng với lý do rõ ràng + đề xuất tiếp theo (thay thế hoàn toàn vai trò budget).
- [ ] **B5.** Nâng output cap cho agent code: `AgentProfile.maxTokens` 4096 → 16384 (APEX/BOLT/CATALYST/Omega) — giảm cắt cụt khi sinh file lớn (giảm retry tốn token hơn).
- [ ] **B6.** Cập nhật `.env` + `.env.example`: thêm khối "UNLIMITED MODE" với chú thích; cập nhật thông báo dừng (L1439) phản ánh chế độ mới.
- [ ] **B7.** UI badge stopReason (runtime-metrics-panel.tsx): hiển thị "∞ budget" khi unlimited thay vì con số.
- [ ] **B8.** Kiểm định: tác vụ code mô phỏng tiêu thụ >200k token vẫn chạy trọn; task kẹt vòng lặp vẫn dừng bằng no_progress; nút Dừng vẫn hoạt động.

### Rủi ro & giảm thiểu
| Rủi ro | Mức | Giảm thiểu |
|---|---|---|
| Vòng lặp vô hạn đốt API thật | Cao | no_progress tăng cường (B4) là phanh chính; DailyToken* vẫn theo dõi để quan sát |
| Tác vụ kẹt chiếm slot quản lý | Vừa | CI-5 (durable queue) giới hạn số job đồng thời + giám sát stall |
| Chi phí API tăng | Vừa | Mr. Architect chấp nhận theo yêu cầu; dashboard Token theo dõi minh bạch |

### Tiêu chí nghiệm thu
✅ Tác vụ code chạy qua mốc 200k token không dừng giữa chừng · ✅ stopReason chỉ còn complete/no_progress/cancelled/error · ✅ Sub-agent không bỏ dở vì budget · ✅ Có phanh no_progress hoạt động.

**Quy mô: S–M (0.5–1.5 ngày) — GĐ1**

---

## CI-2. TODO THEO TỪNG TÁC VỤ + TỰ ĐÁNH DẤU HOÀN THÀNH

> **Đề xuất SELF-DIRECTION tương ứng: SD-CI-2**

### Vấn đề (lời Mr. Architect)
1. Kiểm tra lại xem agents có đánh dấu hoàn thành phần việc đã xong không.
2. Todo tác vụ trước **không được cộng gộp** với tác vụ mới — todo của tác vụ nào hiển thị trong tác vụ đó.

### Điều tra hiện trạng
- Model `Todo` (schema.prisma:923-951): chỉ có `sessionId` — **không có khóa tác vụ/run** → todo cả session trộn lẫn.
- `todoWrite` (dev-tools.ts:2116-2262): bucket theo sessionId; không reset khi tác vụ mới bắt đầu.
- UI: `page.tsx:11020` truyền toàn bộ `sessionTodos` cho **mọi** AgentRunPanel; `page.tsx:4243` session list còn **đè lên** snapshot `run.lastTodos` (snapshot per-run đã có sẵn nhưng bị che!).
- Hoàn thành: (a) team mode auto-complete **theo bước** lúc kết thúc bước (workflow-engine.ts:1943-1945) — OK; (b) standalone chỉ có auto-close **hàng loạt** mọi todo còn lại khi run kết thúc (chat/route.ts:958-975) — thô, đóng cả todo chưa từng bắt đầu thành "completed"; (c) **không có** cơ chế đánh dấu hoàn thành từng mục giữa chừng dựa trên evidence tool thật; (d) crash path không đóng todo → stale `in_progress`.

### Thiết kế giải pháp
**Khóa isolate = `runId`** (mỗi lần user gửi yêu cầu → 1 run → 1 todo list riêng).

1. **Schema**: thêm `runId String?` + index `@@index([sessionId, runId])` vào `Todo` (nullable — tương thích dữ liệu cũ; `bun run db:push`).
2. **Gắn runId khi tạo**: goal loop đã giữ runId (`startAgentRun`) → truyền qua context của `todoWrite` (mọi `todo_write` call tự gắn runId run hiện tại — agent không cần làm gì thêm).
3. **Isolate khi run mới bắt đầu**: `startAgentRun` → tự động đánh dấu todo run trước trong session còn `pending/in_progress` → `archived` (không xóa — vẫn xem lại được qua history) → todo list mới trắng hoàn toàn.
4. **Hoàn thành theo từng mục (evidence-based)**:
   - Sau mỗi tool call thành công (file_edit/run_tests/git_commit...) → goal loop đối chiếu nội dung todo `in_progress` → nếu khớp evidence (heuristic: tên file/lệnh xuất hiện trong todo content hoặc do LLM gắn todoId khi gọi tool) → auto chuyển `completed`.
   - Đơn giản & tin cậy: sau EVALUATE mỗi chu kỳ, dùng `ArbiterVerdict.missing[]` (đã có sẵn, schema.prisma:1037) + danh sách todo để LLM utility chốt status từng mục (1 call nhỏ) — tránh heuristic sai.
   - Kết thúc run: đóng per-item — todo chưa từng `in_progress` và nằm trong `missing[]` → `failed`; còn lại → `completed`. Đóng cả trên crash path (hook `endAgentRun` trong agent-run-tracker).
5. **API/UI**:
   - `/api/todos` hỗ trợ `?runId=`; API agent-run trả todos theo run.
   - UI: panel theo `msg.runId` lọc đúng todo của run đó; **đảo logic L4243** — ưu tiên `run.lastTodos`/todo theo runId, chỉ fallback session list cho dữ liệu cũ.
   - Thought Progress hiển thị badge "Hoàn thành ✓ / Đang làm ◐ / Thất bại ✗ / Đã lưu trữ ▸" per-item đúng thời điểm thực.

### Các bước triển khai
- [ ] **B1.** Prisma: cột `runId` + index; `db:push`; hỗ trợ đọc dữ liệu cũ (runId=null → hiển thị theo session như cũ).
- [ ] **B2.** `todoWrite` nhận runId từ context; mọi call path (goal-loop, workflow-engine auto-todo, sub-agent) truyền đúng.
- [ ] **B3.** `startAgentRun` auto-archive todo run cũ trong session.
- [ ] **B4.** Đóng per-item sau EVALUATE (LLM utility chốt status) + cuối run + crash path (endAgentRun hook).
- [ ] **B5.** API `/api/todos` + `/api/agent-run` filter runId; đảo logic ưu tiên hiển thị ở `AgentRunPanel` (page.tsx:4243, 11020).
- [ ] **B6.** Team mode: todo agent tự viết trong bước cũng nhận runId (workflow session id).
- [ ] **B7.** Kiểm định E2E: task A tạo 5 todo → hoàn thành 3 → task B trong cùng session → panel B chỉ thấy todo của B; todo A hiển thị đúng 3✓/2 trạng thái thật; crash giữa chừng không để stale in_progress.

### Rủi ro & giảm thiểu
| Rủi ro | Mức | Giảm thiểu |
|---|---|---|
| LLM chốt status sai mục | Thấp | Kết hợp evidence tool + verdict; hiển thị nguồn ("tự động"/"agent xác nhận") |
| Dữ liệu cũ không có runId | Thấp | Fallback hiển thị session như cũ; không migrate ép |
| Đánh dấu completed ảo (đã có từ trước) | Vừa | Chỉ auto-complete khi có evidence tool thành công tương ứng |

### Tiêu chí nghiệm thu
✅ Mỗi panel Thought Progress chỉ hiển thị todo của đúng tác vụ · ✅ Todo tự chuyển completed ngay khi việc xong (không đợi hết run) · ✅ Không còn stale in_progress sau crash · ✅ Dữ liệu cũ vẫn hiển thị được.

**Quy mô: M (2–3 ngày) — GĐ2**

---

## CI-3. NÉN CONTEXT THÔNG MINH + LƯU TRỮ TRUY XUẤT LẠI

> **Đề xuất SELF-DIRECTION tương ứng: SD-CI-3**

### Vấn đề (lời Mr. Architect)
Cần cơ chế tóm tắt tổng hợp dữ liệu thông minh khi cần thiết — nén context (tiết kiệm bộ nhớ đệm cho Agents); đảm bảo agents **bỏ phần thông tin không cần thiết** hoặc **lưu trữ lại đâu đó để đọc lại khi cần**.

### Điều tra hiện trạng
- **Đã có (tốt hơn nhận định ban đầu)**: goal loop có nén rolling digest chạy mỗi vòng ReAct — ngưỡng 50k chars, giữ 8 message gần nhất, LLM digest (giữ file paths, lệnh pass/fail, quyết định, việc đang dở) + fallback heuristic, digest ghi vào WorkingMemory HOT (`agent-goal-loop.ts:499-615`); tool result bị `smartTruncate` 4k chars.
- **Lỗ hổng 1**: Code Team workflow **không có nén** — tool result đẩy vào messages không giới hạn (`workflow-engine.ts:1841-1849`) → task code dài phình to đến 80k rồi pause.
- **Lỗ hổng 2**: digest chỉ để preview 400 chars vào WorkingMemory — **full digest không được lưu vào kho truy xuất lại** (Qdrant) → agent không thể "đọc lại khi cần".
- **Lỗ hổng 3**: liên tác vụ chỉ truyền 6 message cuối (`agent-goal-loop.ts:899`) — không có summary tác vụ trước handing-off cho tác vụ sau.
- **Lỗ hổng 4**: `ENABLE_SESSION_RESUME=false` → pause/resume overflow là code chết; `context-manager.ts` (Layer 6.2 — đúng mục đích summarize/prune/offload) là **stub chưa nối dây**.

### Thiết kế giải pháp — "Nén 3 tầng + Kho context"
```
TẦNG 1 — TRONG VÒNG LẶP (đã có ở goal-loop → MỞ RỘNG sang workflow)
  Áp dụng cùng pattern rolling digest cho Code Team workflow-engine:
  cap tool-result messages (4k chars) + digest khi vượt ngưỡng 50k.

TẦNG 2 — OFFLOAD "ĐỌC LẠI KHI CẦN" (MỚI — Kho Context)
  Mỗi lần nén: full digest + các đoạn raw bị cắt → lưu:
    • Bảng TaskContextArchive (Prisma): runId, kind (digest|raw|task_summary),
      content, createdAt, tags
    • Qdrant collection "task_context": embedding digest để truy xuất ngữ nghĩa
  Tool mới context_recall(query, runId?) → search Qdrant + trả đoạn gốc
  → agent BỎ thông tin không cần khỏi context active, nhưng KHÔNG MẤT —
    gọi context_recall đọc lại bất cứ lúc nào (đúng yêu cầu Mr. Architect).

TẦNG 3 — LIÊN TÁC VỤ (MỚI)
  Cuối mỗi run: final report đã có → tạo task_summary (~500 chars) lưu
  ChatMessage metadata + AgentMemory WARM. Run mới trong cùng session nạp
  các task_summary trước (thay 6 message thô) → nối mạch công việc dài hạn.
```

Kích hoạt cơ sở có sẵn: `ENABLE_SESSION_RESUME=true` + hoàn thiện **auto-resume** khi overflow (hiện pause xong phải POST resume thủ công — wire auto-resume sau digest).

### Các bước triển khai
- [ ] **B1.** workflow-engine: thêm smartTruncate cho tool-result messages (thay push thô L1841-1849) + rolling digest (tái dùng hàm goal-loop, tách thành module dùng chung `src/lib/context-compression.ts`).
- [ ] **B2.** Prisma model `TaskContextArchive` + Qdrant collection `task_context` (init routine); writer gọi sau mỗi lần digest.
- [ ] **B3.** Tool `context_recall` (đăng ký ALL_TOOL_DEFINITIONS + gán cho agents có file ops; query Qdrant → trả top-k đoạn + nguồn runId).
- [ ] **B4.** Task summary cuối run (tái dùng final report LLM call, thêm 500 chars digest) + nạp vào context run mới (thay/song hành 6 message cuối).
- [ ] **B5.** Bật `ENABLE_SESSION_RESUME=true` + auto-resume: khi pause overflow → chạy digest → resume tự động (không cần API thủ công); kiểm thử 30-min stale-lock recovery.
- [ ] **B6.** Hoàn thiện hoặc xóa stub `context-manager.ts` (tránh dead code gây hiểu nhầm — khuyến nghị XÓA, thay bằng module thống nhất B1).
- [ ] **B7.** System prompt tổng có budget ký tự (nhiều block hiện không cap ngoài skills 16k/HOT 2k).
- [ ] **B8.** Kiểm định: task code team >100k chars vẫn chạy trọn không pause treo; context_recall trả đúng đoạn đã nén; tokensUsed/run giảm ≥30% so với trước; task sau "nhớ" task trước qua summary.

### Rủi ro & giảm thiểu
| Rủi ro | Mức | Giảm thiểu |
|---|---|---|
| Digest làm mất chi tiết cần thiết | Vừa | Prompt digest đã giữ file paths + lệnh + trạng thái; context_recall đón thông tin mất; digest lưu full ở archive |
| LLM digest chậm/tốn thêm | Thấp | Utility model 700 maxTokens, 90s timeout, fallback heuristic đã có |
| Qdrant collection phình | Thấp | TTL 90 ngày theo pattern MemoryArchive; gom cụm similarity ≥0.85 |

### Tiêu chí nghiệm thu
✅ Task dài không treo vì context phình · ✅ Agent truy hồi được thông tin đã nén qua context_recall · ✅ Task mới nắm được tóm tắt task trước · ✅ Tiết kiệm token đo được ≥30%.

**Quy mô: M–L (3–5 ngày) — GĐ3**

---

## CI-4. BỔ SUNG TOOLS/SKILLS CHO TÁC VỤ CODE

> **Đề xuất SELF-DIRECTION tương ứng: SD-CI-4**

### Vấn đề (lời Mr. Architect)
Xác định lại tác vụ code có thiếu tools/skills cần thiết không — nếu thiếu thì bổ sung để agents thực hiện tác vụ code tốt hơn.

### Điều tra hiện trạng (audit `docs/TOOLS_AUDIT.md` — 63 tools: 43 OK / 6 FAIL gateway / 14 SKIP flag-off)
- Bộ core code **đã có và hoạt động thật**: `file_read/file_edit/file_multi_edit/file_write/file_delete/file_list/grep/shell/run_tests/git_commit/git_push/git_pull/run_bg/manage_packages/get_diagnostics` + custom tools + 67 skill packs.
- **Đang TẮT mặc định dù đã xây & audit pass**: `ENABLE_LINT=false`, `ENABLE_TYPE_CHECK=false`, `ENABLE_LSP_DIAGNOSTICS=false`, `ENABLE_TEST_COVERAGE=false`, `ENABLE_BROWSER_SCREENSHOT=false` (executors đầy đủ trong dev-tools.ts).
- **Omega thiếu quyền**: không có lint/type_check/lsp/test_coverage/db_query/browser_screenshot trong whitelist (`standalone-agents.ts:203-265`) → chuẩn bị giao code xong phải delegate SENTINEL/APEX để verify, hoặc fallback shell.
- **Thiếu tools structured**: git_status / git_diff / git_log / git_branch / git_clone / git_stash — agents phải dùng `shell` thô (không receipt structured, khó metrics).
- **MCP github là mock** (mcp-bridge.ts: 4 server toàn `mock: true` "Phase 5") → không có PR/issue thật.
- `GITHUB_TOKEN`/`GH_TOKEN` có code đọc (dev-tools.ts:1148/1263) nhưng **không documented** trong `.env.example`.
- `manage_packages` chỉ bun; không có tool build (`next build`) — shell bù được.

### Thiết kế giải pháp
**Nguyên tắc: bật cái đã có trước, xây mới cái thật sự thiếu, mock thì bỏ.**

1. **Quick wins (chỉ flips config + ToolAssignment)**: bật LINT/TYPE_CHECK/LSP_DIAGNOSTICS/TEST_COVERAGE/BROWSER_SCREENSHOT → giai đoạn VERIFY của mọi vòng code có đầy đủ vũ khí.
2. **Cấp quyền Omega đầy đủ bộ verify** (lint/type_check/lsp/coverage/screenshot) qua `ToolAssignment` (Omega có thể tự làm bằng `manage_tools action=set_tool_access`, hoặc sửa whitelist trong standalone-agents.ts) — Omega là orchestrator cần tự kiểm định trước khi push (gắn CI-6).
3. **Tools git structured mới** (pattern `execFileAsync('git', [...])` + receipt như gitCommit):
   - `git_status` — branch, dirty files, ahead/behind (structured)
   - `git_diff` — staged/unstaged/so-với-origin, per-file stats
   - `git_log` — N commit gần nhất: hash, author, message, files
   - `git_branch` — create/switch/list/merge (tách khỏi shell)
   - `git_clone` — clone repo + remote setup (bootstrap workspace — phục vụ CI-6)
   - Mỗi tool ghi ToolMetric như các tool khác.
4. **Skill packs mới** `skills/tmo-code-workflow/SKILL.md`: SOP chuẩn cho agents khi làm code trong TMO — quy trình workspace → edit → lint/typecheck → test → commit → push → pull verify → báo cáo; kèm các quy ước (không `git add -A`, dùng scoped paths...). Review/tái sử dụng các pack có sẵn: `coding-agent`, `fullstack-dev`, `version-management`, `task-review`.
5. **Dọn dẹp**: MCP mock github — hoặc hiện thực hóa (Phase 5, defer) hoặc gỡ khỏi danh sách advertise cho agents (tránh agent gọi nhận data giả). Khuyến nghị: gỡ advertise, giữ module.
6. **Document** `GITHUB_TOKEN`/`GH_TOKEN` trong `.env.example` + hướng dẫn token store.
7. **Defer (ghi nhận quyết định)**: `github_api` tool (octokit) cho PR/issue — chỉ làm nếu chuyển sang flow PR; tool build riêng — shell đủ.

### Các bước triển khai
- [ ] **B1.** Flip flags trong `.env`: ENABLE_LINT=true, ENABLE_TYPE_CHECK=true, ENABLE_LSP_DIAGNOSTICS=true, ENABLE_TEST_COVERAGE=true, ENABLE_BROWSER_SCREENSHOT=true (+ cập nhật `.env.example`).
- [ ] **B2.** Cấp Omega + SENTINEL + CORTEX bộ verify tools (ToolAssignment; SENTINEL cần screenshot để review UI).
- [ ] **B3.** Xây 5 tools git structured (definitions + impls + gán quyền theo vị trí: TL/G2-A/G3/Omega).
- [ ] **B4.** Viết skill `tmo-code-workflow`; review 4 pack liên quan; đăng ký vào registry.
- [ ] **B5.** Gỡ advertise MCP mock github khỏi prompt agents (flag ENABLE_MCP_CALL=false hoặc lọc mock server).
- [ ] **B6.** Update `.env.example` (GITHUB_TOKEN docs) + `docs/TOOLS_AUDIT.md` re-audit sau thay đổi.
- [ ] **B7.** Kiểm định: Omega tự chạy được lint+typecheck+tests trong 1 tác vụ; git_status/diff/log trả receipt structured; ToolMetric ghi nhận đúng; smoke 63→68 tools.

### Rủi ro & giảm thiểu
| Rủi ro | Mức | Giảm thiểu |
|---|---|---|
| Bật LSP/tốn tài nguyên máy local | Thấp | LSP fallback tsc đã có; timeout 30s |
| Tools git mới conflict shell flow cũ | Thấp | Tools là wrapper cùng git CLI; không đổi hành vi cũ |
| Mock MCP bị gọi nhầm | Thấp | Gỡ advertise (B5) |

### Tiêu chí nghiệm thu
✅ Đầy đủ vòng verify: edit → lint → typecheck → test → commit không cần shell fallback · ✅ Omega tự kiểm định code trước push · ✅ Git receipts structured vào ToolMetric · ✅ Không agent nào còn thấy MCP github giả.

**Quy mô: S–M (1.5–3 ngày) — GĐ1 (B1-B2) + GĐ2 (B3-B6)**

---

## CI-5. KIẾN TRÚC THỰC THI BỀN VỮNG CHO TÁC VỤ NHIỀU GIỜ

> **Đề xuất SELF-DIRECTION tương ứng: SD-CI-5**

### Vấn đề (lời Mr. Architect)
Xác định lại kiến trúc thực thi của agents có thiếu sót, sơ hở ở đâu dẫn đến vấn đề khi thực hiện các tác vụ phức tạp yêu cầu thời gian dài nhiều tiếng đồng hồ không.

### Điều tra hiện trạng — 7 sơ hở xác nhận
| # | Sơ hở | Hậu quả với tác vụ nhiều giờ |
|---|---|---|
| 1 | Goal loop chạy **trong 1 HTTP POST** (`chat/route.ts:897`) — không SSE/heartbeat/continueOnDisconnect | Đóng tab, proxy timeout, restart → **mất trắng tiến trình**, chỉ còn post-mortem |
| 2 | Tiến trình goal loop chỉ tồn tại trong RAM | Restart PM2 = mất; không resume |
| 3 | Overflow 80k pause nhưng **không tự resume** (ENABLE_SESSION_RESUME=false) | Tác vụ dài treo vĩnh viễn chờ POST resume thủ công |
| 4 | Không retry ở mức bước trong Code Team (bước fail chỉ log + skip; PIVOT/ESCALATE chỉ phát event) | Bước code fail 1 lần = cả pipeline tiếp tục thiếu |
| 5 | Stall-kill self-direction 10 phút có thể giết step LLM chậm hợp lệ | Orchestration dài bị đánh dấu failed oan |
| 6 | `AGENT_STEP_TIMEOUT_MS=4 phút` (workflow) | Lượt suy luận/biến đổi lớn bị cắt giữa chừng |
| 7 | Trạng thái chạy không hiển thị qua restart (in-memory run tracker) | Sau restart không biết tác vụ nào đang/từng chạy |

**Pattern đã có sẵn trong hệ thống để tái sử dụng**: `smolab/background-task-worker.ts` (hàng đợi bền, MAX_CONCURRENT=3, `recoverPending` sau restart) + scheduler nền `instrumentation-node.ts` (self-direction 60s tick) + SSE `continueOnDisconnect` (workflow route) + poller UI 1.2s (agent-run).

### Thiết kế giải pháp — "Durable Goal Loop"
```
POST /api/openclaw/chat  →  ENQUEUE GoalLoopJob (DB)  →  trả jobId ngay
                                    │
                    GoalLoopWorker (instrumentation-node.ts, nền, luôn sống)
                                    │  MAX_CONCURRENT=2-3
        ┌───────────────────────────┴───────────────────────────┐
        │ CHECKPOINT mỗi chu kỳ:                                 │
        │   GoalLoopJob{status, cyclesDone, todoSnapshot,        │
        │   digest (từ CI-3), lastToolReceipts, stopReason?}     │
        │ Worker tick: chạy 1 chu kỳ → checkpoint → chu kỳ tiếp   │
        └────────────────────────────────────────────────────────┘
Khởi động app → recoverPending: job running → load checkpoint →
chạy tiếp TỪ ĐÚNG CHỖ (không lặp lại file đã sửa, test đã pass)

UI: poll /api/agent-run (đã có) + trạng thái job qua restart;
nút Dừng vẫn hoạt động qua cancel flag trong DB (không phụ thuộc RAM).
```

Thành phần bổ sung:
- **Bước fail → retry**: Code Team step fail → TL checkpoint quyết định retry (≤2 lần) trước khi skip; ghi ToolMetric attempt.
- **Stall-kill thích ứng**: ngưỡng 10 phút → động theo loại bước (bước có tool receipt/heartbeat sống thì không kill; chỉ kill khi KHÔNG có tín hiệu sống).
- **Bước LLM dài**: nâng AGENT_STEP_TIMEOUT_MS 4 phút → 8 phút (env), giữ per-call.
- **Giám sát**: runtime-metrics-panel thêm khối "Job đang chạy" (status, cycle, tokens, tuổi) + cảnh báo stall.

### Các bước triển khai
- [ ] **B1.** Prisma model `GoalLoopJob` (id, sessionId, messageId, status queued/running/completed/failed/cancelled, cyclesDone, checkpoint JSON, error, timestamps) + API enqueue.
- [ ] **B2.** `src/lib/goal-loop-worker.ts`: vòng worker nền (instrumentation-node.ts đăng ký; globalThis guard HMR như self-direction scheduler); MAX_CONCURRENT env; lock job trước khi chạy.
- [ ] **B3.** Refactor `runGoalDrivenLoop`: tách "chạy 1 chu kỳ" thành hàm thuần nhận state (messages, todos, counters) → checkpoint sau mỗi chu kỳ; chạy nối tiếp trong worker.
- [ ] **B4.** `recoverPending` lúc khởi động + cancel qua DB flag; SSE/poll event phát như cũ (agent-run tracker giữ).
- [ ] **B5.** Route chat: flag `ENABLE_DURABLE_GOAL_LOOP` — off: hành vi cũ (HTTP inline); on: enqueue + trả jobId. Rollout: off → on sau kiểm định.
- [ ] **B6.** Retry bước fail trong workflow-engine (TL checkpoint); stall-kill thích ứng; AGENT_STEP_TIMEOUT_MS=480000.
- [ ] **B7.** UI job monitor + stopReason hiển thị.
- [ ] **B8.** Kiểm định khắc nghiệt: (a) tác vụ chạy 2h mô phỏng — kill -9 PM2 giữa chừng → restart → tiếp tục từ checkpoint, file đã sửa không lặp; (b) đóng tab ngay sau enqueue → tác vụ vẫn chạy, mở lại thấy kết quả; (c) 2 job song song không cản trở nhau; (d) nút Dừng hủy job đang chạy.

### Rủi ro & giảm thiểu
| Rủi ro | Mức | Giảm thiểu |
|---|---|---|
| Refactor goal loop phá hành vi hiện có | Cao | Feature flag B5 (mặc định off); chạy song song 2 chế độ đối chứng; keep pure-function split |
| Checkpoint phình (messages lớn) | Vừa | Checkpoint lưu digest (CI-3) + todo snapshot, không lưu full messages |
| Double-run sau restart | Vừa | Lock job (updateMany status conditional) — pattern self-direction đã kiểm chứng |
| Phức tạp cao nhất kế hoạch | Cao | Đặt GĐ4 sau khi CI-1/CI-3/CI-6 ổn định; chia PR nhỏ |

### Tiêu chí nghiệm thu
✅ Tác vụ nhiều giờ sống sót qua: đóng tab, restart app, kill -9 · ✅ Resume từ đúng chỗ (không lặp lại công việc) · ✅ UI theo dõi được mọi lúc kể cả sau restart · ✅ Rollback được về chế độ cũ bằng flag.

**Quy mô: L (5–8 ngày) — GĐ4**

---

## CI-6. WORKSPACE `E:\APP\TMO-CLONE` → KIỂM ĐỊNH → PUSH → PULL

> **Đề xuất SELF-DIRECTION tương ứng: SD-CI-6**

### Vấn đề (lời Mr. Architect)
1. Thiết lập để **Omega biết**: khi cần sửa đổi/nâng cấp/điều tra code bất kỳ phần nào của The Magnum Opus → làm trong `E:\APP\TMO-clone` TRƯỚC; chạy kiểm thử tất cả thay đổi; không phát hiện lỗi mới **push code** lên `https://github.com/vietnq130593-code/TMO`; sau đó **pull code** từ chính kho đó.
2. Nếu quên mở sẵn thư mục trong workspace → Omega có thể tự chọn thư mục này bằng File Explorer và khởi chạy không?
3. **Mọi đề xuất module SELF-DIRECTION** đều triển khai tại thư mục này, qua cơ chế kiểm định của app mới push → pull.

### Điều tra hiện trạng
- **Hạ tầng đã có ~90%**: `Workspace` model (rootPath, isActive) + resolver (`workspace-root.ts`: active workspace → `OPENCODE_WORKSPACE` → cwd); tools `git_commit/git_push/git_pull` thật với token resolution 3 tầng (URL nhúng > token store `db/.github-token.json` > env `GITHUB_TOKEN/GH_TOKEN`); dialog "Pull Code từ GitHub" đã tự lưu token.
- **Khoảng trống**: (a) chưa có workspace mặc định tự bootstrap; (b) `/api/git-pull` đang trỏ repo cũ `nguyenquocviety2c-code/TMO` (`git-pull/route.ts:32`); (c) repo mới **đang trống** — chưa có mã nguồn gì; (d) không có cơ chế "kiểm định trước push" chuẩn hóa cho Omega; (e) self-direction orchestration hiện thực thi qua các bước LLM — chưa có chế độ bước "thực thi code thật trong workspace"; (f) không có tool mở File Explorer.

### Thiết kế giải pháp — 7 bước

**CI-6.1 — Workspace mặc định tự bootstrap**
`ensureDefaultWorkspace()` chạy lúc khởi động app (instrumentation-node.ts, sau ensureDbReady):
```
1. Query Workspace active → có & rootPath tồn tại → xong
2. Chưa có → kiểm tra E:\APP\TMO-clone:
   - Chưa tồn tại → mkdir -p + git init + remote add origin <repo mới>
   - Tồn tại nhưng chưa phải git repo → git init + remote add
   - Có repo nhưng remote cũ → set-url sang repo mới
3. INSERT Workspace {name: "TMO-clone", rootPath: "E:\\APP\\TMO-clone", isActive: true}
   (deactivate workspace khác)
```
→ Kể từ đó **mọi tool file_*/shell/git mặc định thao tác đúng thư mục này** (loại bỏ footgun "mặc định = thư mục app").

**CI-6.2 — Token & remote**
- PAT do Mr. Architect cung cấp (qua hội thoại) → nhập **một lần** qua dialog "Pull Code từ GitHub" (tự lưu `db/.github-token.json` 0600, nằm trong thư mục được bảo vệ khỏi pull) — git_push/git_pull tái sử dụng tự động. **Không ghi token vào code, .env.example, hay tài liệu này.**
- Khuyến nghị song song: set env `GITHUB_TOKEN` trên máy local làm fallback.

**CI-6.3 — Chuyển kho chuẩn**
- Sửa `DEFAULT_REPO_URL` → `https://github.com/vietnq130593-code/TMO` (`git-pull/route.ts:32`) + hỗ trợ env override `TMO_REPO_URL`.
- Trên bản clone local: `git remote set-url origin https://github.com/vietnq130593-code/TMO.git`.

**CI-6.4 — Push bản nền lần đầu (repo đang trống)**
- Từ `E:\APP\TMO-clone` (đã chứa code TMO mới nhất — commit dd3596b + kế hoạch này): push branch `main` làm bản nền. Qua quality gate của repo (pre-push hook: typecheck + lint + 169 tests) — gate này chính là "cơ chế kiểm định của app".

**CI-6.5 — Pipeline kiểm định trước push (chuẩn hóa cho Omega)**
```
Omega hoàn tất thay đổi trong E:\APP\TMO-clone
  → 1. lint (tool lint)           PASS?
  → 2. type_check                 PASS?
  → 3. run_tests                  PASS? (0 fail)
  → 4. smoke: khởi động app/preview + probe HTTP 200 + không console error
  → 5. quét secret trong diff (token/key/password) — KHÔNG được có
  → 6. git_commit (scoped paths, message chuẩn)
  → 7. git_push (origin main)
  → 8. git_pull verify (ff-only) — xác nhận vòng lặp khép kín
  → 9. Báo cáo Omega (module SELF-DIRECTION tab Lịch sử)
Bất kỳ bước nào FAIL → KHÔNG push → sửa → chạy lại pipeline từ đầu.
```
Triển khai: hàm `runPrePushVerification()` (`src/lib/code-team/pre-push-verify.ts`) + tool `verify_and_push` cho Omega (gộp pipeline thành 1 lệnh, receipts từng bước). Đây chính là "cơ chế kiểm định của app" mà mọi đề xuất SELF-DIRECTION phải qua.

**CI-6.6 — Tự mở File Explorer / workspace khi Mr. Architect quên**
- Tool mới `open_workspace`: chạy `explorer.exe "<rootPath>"` (Windows — qua `spawn(cmd /c start)` an toàn) / `xdg-open` (Linux); tùy chọn `editor: "vscode"` → `code "<rootPath>"`. Trả về xác nhận + workspace active hiện tại.
- Omega trigger: (a) khi bắt đầu tác vụ code mà workspace chưa active → activate + tùy cấu hình auto-open; (b) khi Mr. Architect yêu cầu "mở workspace/xem thư mục"; (c) `ensureDefaultWorkspace` (CI-6.1) đảm bảo dù quên mở, hệ thống vẫn trỏ đúng thư mục.
- Cấu hình `TMO_AUTO_OPEN_WORKSPACE=true|false` (mở Explorer tự động mỗi lần activate hay chỉ khi được yêu cầu).

**CI-6.7 — Gắn SELF-DIRECTION với workspace (chốt yêu cầu 3)**
- Proposal SELF-DIRECTION được duyệt → `triggerOrchestration` nhận biết proposal loại "code-change" (thêm trường `executionMode: "llm" | "code-workflow"` — mặc định llm giữ tương thích).
- Bước có `executionMode=code-workflow` → executeStep **điều vào workflow-engine** với workspace root = `E:\APP\TMO-clone` (agent BOLT/APEX thực thi bằng tools thật) → checkpoint verify như TL step → chỉ khi pipeline CI-6.5 PASS thì bước đó được evaluateStep ĐẠT.
- writeFinalReport ghi kèm commit hash + kết quả từng bước kiểm định (lint/test/smoke) — báo cáo Omega trong tab Lịch sử có bằng chứng cụ thể.
- Scan engine (self-direction/scan.ts) nâng cấp phát hiện đề xuất code-change (thiếu tool, lỗi kiến trúc...) và tự gắn executionMode.

### Các bước triển khai
- [ ] **B1.** `ensureDefaultWorkspace()` (lib mới + gọi trong instrumentation-node.ts) + test bootstrap các trạng thái thư mục (chưa có/chưa git/remote cũ).
- [ ] **B2.** Tool `open_workspace` (cross-platform) + cấu hình TMO_AUTO_OPEN_WORKSPACE.
- [ ] **B3.** `runPrePushVerification()` + tool `verify_and_push` (gọi lint/type_check/run_tests + probe smoke + secret-scan diff).
- [ ] **B4.** Đổi DEFAULT_REPO_URL + env TMO_REPO_URL; update .env.example.
- [ ] **B5.** Schema: `SelfDirectionProposal.executionMode` + ProposalStep tùy chọn workspace execution; orchestrator dispatch code-workflow steps vào workflow-engine.
- [ ] **B6.** Nhập token qua dialog (thủ công Mr. Architect 1 lần) — hướng dẫn trong báo cáo triển khai.
- [ ] **B7.** Push bản nền main lên repo mới (từ workspace local, qua pre-push gate).
- [ ] **B8.** Pull verify từ repo mới qua `/api/git-pull` (đã trỏ đúng repo).
- [ ] **B9.** E2E: tạo proposal code-change trong SELF-DIRECTION → duyệt → Omega sửa file thật trong workspace → pipeline PASS → push → pull → báo cáo đủ commit hash.

### Rủi ro & giảm thiểu
| Rủi ro | Mức | Giảm thiểu |
|---|---|---|
| Token lộ | Cao | Chỉ lưu token store 0600 + secret-scan trước push (B3 bước 5); không bao giờ ghi vào commit |
| Push nhầm code hỏng lên main | Vừa | Pipeline bắt buộc 5 lớp trước push; push scoped; có staging branch flag nếu muốn thêm lớp |
| Sai đường dẫn Windows (backslash) | Vừa | Chuẩn hóa rootPath qua path.resolve; test trên Windows thật |
| Remote đổi làm hỏng flow cũ | Thấp | Giữ env override; repo cũ giữ nguyên không xóa |

### Tiêu chí nghiệm thu
✅ Omega mọi thao tác code mặc định trong `E:\APP\TMO-clone` · ✅ Push chỉ xảy ra sau pipeline 5 lớp PASS · ✅ Pull verify từ `vietnq130593-code/TMO` hoạt động · ✅ Quên mở workspace → hệ thống tự bootstrap + mở Explorer được · ✅ Proposal SELF-DIRECTION code-change chạy thật trong workspace và báo cáo kèm commit hash.

**Quy mô: M (3–4 ngày) — GĐ1 (B1-B4, B6-B7) + GĐ2 (B5, B8-B9)**

---

## 2. LỘ TRÌNH TRIỂN KHAI

```
GIAI ĐOẠN 1 — NỀN TẢNG (tuần 1, ~2-3 ngày)          ─ quick wins, rủi ro thấp
  CI-1  Bỏ giới hạn token budget (unlimited mode)
  CI-4  B1-B2: bật flags + cấp quyền Omega
  CI-6  B1-B4, B6-B7: workspace bootstrap + repo mới + push bản nền
  ► Kết quả: hết dừng giữa chừng vì budget; Omega đủ đồ verify;
    repo mới có mã nguồn; mọi thao tác code trỏ đúng workspace

GIAI ĐOẠN 2 — TRẢI NGHIỆM & ĐO LƯỜNG (tuần 2, ~3-4 ngày)
  CI-2  Todo theo tác vụ + tự hoàn thành (schema runId)
  CI-4  B3-B6: tools git structured + skill workflow
  CI-6  B5, B8-B9: SELF-DIRECTION ↔ workspace + verify_and_push + E2E
  ► Kết quả: Thought Progress sạch theo tác vụ; Omega code-git trọn chuỗi;
    proposal SELF-DIRECTION triển khai code thật

GIAI ĐOẠN 3 — BỘ NHỚ THÔNG MINH (tuần 3-4, ~3-5 ngày)
  CI-3  Nén context 3 tầng + Kho Context (TaskContextArchive + Qdrant
        task_context + context_recall) + auto-resume overflow
  ► Kết quả: tác vụ dài không phình context; đọc lại được thông tin đã nén

GIAI ĐOẠN 4 — BỀN VỮNG (tuần 5-6, ~5-8 ngày)
  CI-5  Durable Goal Loop (job queue + checkpoint + recover) +
        retry bước fail + stall-kill thích ứng
  ► Kết quả: tác vụ nhiều giờ sống sót mọi sự cố; resume đúng chỗ

Phụ thuộc:  CI-5 dùng digest của CI-3 (checkpoint nhẹ)   → CI-3 TRƯỚC CI-5
            CI-6.7 dùng tools của CI-4 (git structured)   → CI-4.B3 TRƯỚC CI-6.B5
            CI-1, CI-2 độc lập — chạy song song được
```

**Sau mỗi giai đoạn**: push qua pipeline CI-6.5 → pull verify → báo cáo Omega trong SELF-DIRECTION → Mr. Architect nghiệm thu rồi mới sang giai đoạn sau.

---

## 3. QUY TRÌNH PHÊ DUYỆT & TRIỂN KHAI (GOVERNANCE)

### 3.1. Mỗi hạng mục đi qua đúng vòng đời SELF-DIRECTION

```
Kế hoạch này (file .md)
   │  Mr. Architect xem, góp ý, chốt
   ▼
Tạo 6 đề xuất SD-CI-1..SD-CI-6 trong module SELF-DIRECTION
   │  (đủ 4 phần: vấn đề / giải pháp / cách triển khai / thời điểm)
   ▼
Mr. Architect phê duyệt TỪNG hạng mục đúng thời điểm
   │  (hoặc bật "Ủy quyền duyệt cho Omega")
   ▼
Đến hạn → Omega orchestrate → triển khai tại E:\APP\TMO-clone
   │  (các bước code chạy qua workflow-engine trong workspace — CI-6.7)
   ▼
Pipeline kiểm định 5 lớp (CI-6.5): lint → typecheck → tests → smoke → secret-scan
   │  PASS → git push → git pull verify
   │  FAIL → sửa → chạy lại pipeline (không push)
   ▼
Báo cáo Omega (tab Lịch sử): đã làm gì, kết quả từng bước,
kết quả sau cùng kèm commit hash + đề xuất tiếp theo
```

### 3.2. Phân công agents

| Agent | Vai trò trong kế hoạch |
|---|---|
| **Omega** | Orchestrator: quản lý workspace, verify_and_push, phê duyệt ủy quyền, điều phối mọi hạng mục |
| **APEX (TL)** | Kiến trúc & thiết kế các thay đổi lớn (CI-5 refactor goal loop) |
| **BOLT (G2-A)** | Thực thi code chính |
| **SENTINEL (G2-B)** | Review + chạy pipeline kiểm định (lint/typecheck/test/smoke) trước push |
| **CATALYST (G3)** | Tối ưu + đo lường (tokens/save, benchmark trước-sau) |
| **CORTEX (G1)** | Thiết kế dữ liệu (schema Todo.runId, TaskContextArchive, GoalLoopJob) |
| **Mr. Architect** | Phê duyệt từng hạng mục + thời điểm triển khai + nghiệm thu giai đoạn |

---

## 4. PHỤ LỤC

### A. Bảng env keys mới/thay đổi

| Key | Giá trị đề xuất | Hạng mục |
|---|---|---|
| `GOAL_LOOP_TOKEN_BUDGET` | `0` (unlimited) | CI-1 |
| `GOAL_LOOP_TIME_BUDGET_MS` | `0` (unlimited) | CI-1 |
| `GOAL_LOOP_MAX_CYCLES` | `0` (unlimited — no_progress vẫn dừng) | CI-1 |
| `GOAL_LOOP_ITERATIONS_PER_CYCLE` | `0` hoặc `50` | CI-1 |
| `SUBAGENT_TOKEN_BUDGET` | `0` | CI-1 |
| `SUBAGENT_TIMEOUT_MS` | `0` | CI-1 |
| `SUBAGENT_MAX_ITERATIONS` | `12` | CI-1 |
| `AGENT_STEP_TIMEOUT_MS` | `480000` (8 phút) | CI-5 |
| `ENABLE_LINT` / `ENABLE_TYPE_CHECK` / `ENABLE_LSP_DIAGNOSTICS` / `ENABLE_TEST_COVERAGE` / `ENABLE_BROWSER_SCREENSHOT` | `true` | CI-4 |
| `ENABLE_SESSION_RESUME` | `true` | CI-3 |
| `TMO_REPO_URL` | `https://github.com/vietnq130593-code/TMO` | CI-6 |
| `TMO_DEFAULT_WORKSPACE` | `E:\APP\TMO-clone` | CI-6 |
| `TMO_AUTO_OPEN_WORKSPACE` | `true` | CI-6 |
| `GITHUB_TOKEN` | *(PAT — qua token store, không commit)* | CI-6 |
| `ENABLE_DURABLE_GOAL_LOOP` | `false` → `true` sau kiểm định | CI-5 |
| `GOAL_LOOP_MAX_CONCURRENT` | `2` | CI-5 |

### B. Bảng thay đổi schema Prisma

| Model | Thay đổi | Hạng mục |
|---|---|---|
| `Todo` | + `runId String?`, + `@@index([sessionId, runId])` | CI-2 |
| `TaskContextArchive` *(mới)* | runId, kind, content, tags, createdAt + TTL 90 ngày | CI-3 |
| `GoalLoopJob` *(mới)* | sessionId, messageId, status, cyclesDone, checkpoint, error, timestamps | CI-5 |
| `SelfDirectionProposal` | + `executionMode String @default("llm")` | CI-6 |
| `AgentProfile` | maxTokens 4096 → 16384 (agents code) | CI-1 |

### C. Danh sách file sẽ chạm đến (tổng hợp)

`agent-goal-loop.ts` · `subagent-delegate.ts` · `llm.ts` · `code-team/workflow-engine.ts` · `code-team/dev-tools.ts` (todoWrite + 5 git tools + open_workspace) · `code-team/tool-executor.ts` (definitions + dispatch) · `code-team/pre-push-verify.ts` *(mới)* · `standalone-agents.ts` (Omega whitelist) · `workspace-root.ts` + `ensure-default-workspace.ts` *(mới)* · `agent-run-tracker.ts` · `openclaw/chat/route.ts` · `todos/route.ts` · `agent-run/route.ts` · `git-pull/route.ts` · `self-direction/orchestrator.ts` + `scan.ts` · `instrumentation-node.ts` · `goal-loop-worker.ts` *(mới)* · `context-compression.ts` *(mới — tách từ goal-loop)* · `prisma/schema.prisma` · `.env` / `.env.example` · `page.tsx` (AgentRunPanel todos theo run + job monitor) · `skills/tmo-code-workflow/SKILL.md` *(mới)*

### D. Câu hỏi mở cho Mr. Architect — ĐÃ TRẢ LỜI 2026-09-11 ✅

| # | Câu hỏi | Trả lời của Mr. Architect (CHỐT) |
|---|---|---|
| 1 | CI-1: Unlimited áp cho mọi agent & mọi loại tác vụ? | **MỌI AGENT** — không giới hạn token budget cho bất kỳ agents nào |
| 2 | CI-6: Push thẳng main hay qua branch + review? | **THẲNG MAIN** sau pipeline kiểm định |
| 3 | Vai trò 2 kho? | **ĐỘC LẬP** — `vietnq130593-code/TMO` = Omega local (qua kiểm định, push/pull bằng token mới); `nguyenquocviety2c-code/TMO` = sandbox agents push thẳng (token đầu). Không đồng bộ 2 kho |
| 4 | CI-4: Cần PR/issue GitHub thật? | **PUSH/PULL QUA GIT LÀ ĐỦ** — github_api tool vẫn DEFER |
| 5 | CI-5: Số job đồng thời tối đa? | **2** (`GOAL_LOOP_MAX_CONCURRENT=2`) |
| 6 | CI-6.6: Tự mở Explorer mỗi lần activate? | **A — TỰ MỞ** (`TMO_AUTO_OPEN_WORKSPACE=true`) |

> Phụ thêm (2026-09-11): Sau khi hoàn thành triển khai, thêm **1 bước review** mỗi giai đoạn trước khi sang giai đoạn sau.

### E. Tiến độ triển khai

| Giai đoạn | Hạng mục | Trạng thái | Ghi chú |
|---|---|---|---|
| GĐ1 | CI-1 Unlimited budget | ✅ HOÀN THÀNH 2026-09-11 | 0=unlimited semantics + phanh no_progress (3 chu kỳ không tool-call thành công) + getGoalLoopBudgetInfo() + intEnv fix falsy-bug; maxTokens existing 32768 giữ nguyên, schema default mới 16384 |
| GĐ1 | CI-4 B1-B2 Verify tools | ✅ HOÀN THÀNH 2026-09-11 | ENABLE_LINT/TYPE_CHECK/LSP/COVERAGE/SCREENSHOT=true; Omega +7 tools (lint, type_check, lsp_diagnostics, test_coverage, browser_screenshot, open_workspace, verify_and_push); SENTINEL +browser_screenshot; APEX/CATALYST +verify_and_push; APEX +open_workspace |
| GĐ1 | CI-6 B1-B4 Workspace pipeline | ✅ HOÀN THÀNH 2026-09-11 | ensureDefaultWorkspace (bootstrap + git init + remote + activate + auto-open Explorer) | open_workspace tool | pre-push-verify.ts (lint→typecheck→tests→smoke→secret-scan→commit→push→pull) | verify_and_push tool | DEFAULT_REPO_URL=TMO_REPO_URL env |
| GĐ2 | CI-2 Todo theo tác vụ | ✅ HOÀN THÀNH 2026-09-11 | Todo.runId + archivedAt; archive run cũ khi run mới; per-item honest close + crash path; auto-complete theo evidence; API ?runId= + agent-run.todos; UI panel ưu tiên todo đúng run; 20/20 functional tests |
| GĐ2 | CI-4 B3-B6 Git tools + skill | ✅ HOÀN THÀNH 2026-09-11 | 5 tools git_status/diff/log/branch/clone (injection guards, token masked) — 70 builtin; skill tmo-code-workflow SOP 8 bước; MCP mock ẩn + chặn; grants 5 agents |
| GĐ2 | CI-6 B5 SELF-DIRECTION↔workspace | ✅ HOÀN THÀNH 2026-09-11 | executionMode + workspaceReceipt; bước giữa chạy executeTool THẬT (17 tools, không commit/push tay); bước cuối verify_and_push pipeline 9 bước; báo cáo Omega + section kiểm định + commit hash. GOLDEN E2E: proposal thật → 4 agents thực thi 16 tool calls thật → pipeline tự commit 00d337a + push + pull verify → completed |
| GĐ2 | Review findings còn lại | ✅ HOÀN THÀNH 2026-09-11 | #8 git_push redirect verify_and_push (description), #11 bootstrap 3 trạng thái, #12 smokeUrl SSRF guard, #14 per-cap unlimited flags. Defer GĐ3: #13 runner fallback, #16 gitCommit execFile, Neo4j log spam |
| GĐ3 | CI-3 Nén context | ✅ HOÀN THÀNH 2026-08-30 | Module dùng chung context-compression.ts (splice theo Cặp tool_call) + workflow-engine cap 4k/digest 50k; Kho Context TaskContextArchive (Prisma) + Qdrant task_context + tool context_recall (SQL fallback — 71 builtin); task_summary cuối run (distill 500 chars) + nạp run mới; auto-resume overflow (digest-first, cap 3); prompt budget 24k; xóa stub context-manager. KIỂM ĐỊNH B8 4/4 PASS: 15-file run 2 digest 109k chars · context_recall trả đúng đoạn · token giảm 85% (chuẩn ≥30%) · task sau nhớ task trước. Review APPROVE (0 CRITICAL/HIGH). Defer findings đã xử lý: #13 runner fallback win32, #16 gitCommit execFile, Neo4j log throttle. Commits 2db96c6 + 32c1811 |
| GĐ4 | CI-5 Durable goal loop | ✅ HOÀN THÀNH 2026-08-30 | GoalLoopJob DB queue + goal-loop-worker (tick 5s, claim atomic, orphan sweep 1 cơ chế boot+steady-state, cancel DB-flag sống qua restart, checkpoint mỗi vòng throttle 3s + force ranh giới chu kỳ, MAX_CONCURRENT=2 + mutual-exclusion per-session); durable hooks vào runGoalDrivenLoop (resume tái dùng runId, không truyền = inline 100% — 169 tests nguyên vẹn); chat route ENQUEUE + trả jobId TỨC THÌ (POST cũ block 20-70') + try hẹp chống double-run + fallback inline; finalize đầy đủ 6 bước (todo CI-2 + WM + ChatMessage + KB writeback + extractMemories + decay/HOT→WARM); API /api/goal-loop-jobs + agent-run cancel mở rộng; AGENT_STEP_TIMEOUT_MS 8' env + retry LLM transient ≤2; stall-kill thích ứng 3 nguồn heartbeat; UI placeholder ⏳ + poll 3s + panel Tác vụ nền + re-attach. KIỂM ĐỊNH B8 4/4 PASS (kill -9 mid-run → RESUME từ checkpoint không lặp công việc — evidence 3 file_read chỉ chu kỳ 1 · đóng tab vẫn chạy · 2 job song song slot 1/2+2/2 · Dừng qua DB flag). REVIEW TỔNG THỂ 14-g: 0 CRITICAL — H1 (finalize thiếu learning pipeline) + H2 (cancel/fail bỏ finalize) + M1/M2/M4 + L1/L6/L4/N3 đã fix trong cùng commit; follow-up không chặn: M3 abort LLM cũ khi retry, L3 digest dedup, unit tests durable core. Commit 74dbd79. Flag ENABLE_DURABLE_GOAL_LOOP=false (rollout B5 — đã verify E2E, flip khi Mr. Architect quyết định + restart) |

---

*— Kế hoạch đã được Mr. Architect PHÊ DUYỆT TOÀN BỘ (6/6 câu hỏi đã chốt 2026-09-11). Triển khai theo giai đoạn, mỗi giai đoạn xong có 1 bước review bổ sung trước khi sang giai đoạn sau. GĐ1-GĐ4 hoàn thành 2026-09-11 → 2026-08-30.*
