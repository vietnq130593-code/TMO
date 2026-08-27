# ĐÁNH GIÁ & SO SÁNH CƠ CHẾ REACT LOOP — TMO vs Claude Code / Z.ai Code / Kimi Code

> Ngày: 2026-09-01 · Phạm vi: ReAct loop của agent độc lập (`/api/openclaw/chat` → `runAgentReActLoop`) và Team Workflow (`workflow-engine.ts` → `runAgentStep` + TL checkpoint verify)

---

## 1. KIẾN TRÚC VÒNG LẶP CỦA TỪNG HỆ THỐNG

### 1.1 TMO (hiện tại)

```
┌─ CHAT ROUTE (agent độc lập, vd Omega) ──────────────────────┐
│ while (iterations < 8) {            ← cắt cứng 8 vòng       │
│   LLM call (1 prompt string)                                  │
│   → regex parse "tool_call: name({...})"  ← text parsing     │
│   → executeTool (40+ tools thật)                              │
│   → nếu KHÔNG còn tool call → BREAK  ← kết thúc khi LLM      │
│     ngừng phát tool call, KHÔNG kiểm chứng mục tiêu          │
│ }                                                             │
│ history: 6 tin nhắn cuối, flatten thành 1 chuỗi              │
└──────────────────────────────────────────────────────────────┘

┌─ TEAM WORKFLOW (TL→G1→G2-A/B→G3) ────────────────────────────┐
│ Mỗi step = 1 ReAct loop (max 25 vòng)                        │
│ TL checkpoint verify sau mỗi group: CONTINUE/PIVOT/ESCALATE  │
│ Mode A: TL self-verify <85% → iterate (max 3)                │
│ Context overflow 80k → pause + resume handoff                │
│ Layer 9: historical feedback → budget adjustment             │
└──────────────────────────────────────────────────────────────┘
```

**Điểm kết thúc của standalone loop**: LLM ngừng phát tool call → coi như xong. KHÔNG có ai hỏi: *"Mục tiêu đã đạt chưa? Bằng chứng đâu?"*

### 1.2 Claude Code (Anthropic)

```
┌─ AGENTIC LOOP (native tool_use blocks) ──────────────────────┐
│ while (true) {                                                │
│   model → [thinking] → tool_use (native FC) → results → …    │
│   model tự quyết: TodoWrite (kế hoạch) / Edit / Bash (verify) │
│   → kết thúc khi model phát text cuối (không tool_use)       │
│   context đầy → AUTO-COMPACTION (tóm tắt giữ todo + gần đây)  │
│ }                                                             │
│ Subagents (Task tool): context riêng, chạy song song          │
│ Kỷ luật verify đến từ: model + CLAUDE.md + hooks của user     │
│ Không có giới hạn vòng nhỏ — chạy đến khi model kết luận      │
└──────────────────────────────────────────────────────────────┘
```

### 1.3 Z.ai Code

```
┌─ AGENTIC LOOP + MANDATE SELF-VERIFICATION ────────────────────┐
│ Core loop giống Claude Code (native FC, parallel tool calls)  │
│ + TodoWrite/TodoRead BẮT BUỘC theo dõi tiến độ                │
│ + Task tool: subagent CHUYÊN BIỆT theo loại (Explore/Plan/    │
│   full-stack/frontend…) với context độc lập                   │
│ + Worklog dùng chung (append-only) để nhiều agent phối hợp    │
│ + Skills system (SKILL.md)                                    │
│ + Sau khi code xong: BẮT BUỘC tự kiểm định bằng browser thật  │
│   ("it compiles" KHÔNG BAO GIỜ đủ — phải verify interactivity)│
│ + Báo cáo trung thực: chưa verify được thì nói thẳng          │
└──────────────────────────────────────────────────────────────┘
```

### 1.4 Kimi Code (Moonshot)

```
┌─ AGENTIC CLI trên k-series (kimi-k3) ─────────────────────────┐
│ Native tool calling + interleaved thinking giữa các tool call │
│ Plan mode / Act mode tách bạch                                │
│ Context 256K → giữ được cả codebase lớn trong 1 task dài      │
│ Kết thúc: model quyết — kỷ luật plan→act→verify từ model      │
└──────────────────────────────────────────────────────────────┘
```

---

## 2. TMO ĐÃ LÀM ĐƯỢC GÌ (so với 3 hệ thống trên)

| # | Năng lực | TMO | Ghi chú |
|---|----------|-----|---------|
| 1 | ReAct loop thật + tool execution | ✅ | 40+ tools: shell, file_read/edit/multi_edit, grep, run_tests, lint, type_check, test_coverage, get_diagnostics, git commit/push/pull, KB (Qdrant/Neo4j), web (tavily/serper/jina), cron, preview… |
| 2 | Thought Process hiển thị realtime | ✅ | Panel trong chat: 💭 tư duy từng vòng + tool call KÈM KẾT QUẢ THẬT + Todos + counters — Claude Code có, Z.ai có; TMO đã đạt parity về hiển thị |
| 3 | Todo tracking | ✅ | todo_write/read → DB → UI panel + auto-close stale todos |
| 4 | Team verify loop | ✅ | TL checkpoint CONTINUE/PIVOT/ESCALATE sau mỗi group; Mode A self-verify iterate — đúng tinh thần read-write-verify |
| 5 | Cancel/abort xuyên suốt | ✅ | Idempotent endRun + abortCheck xuyên qua cả chuỗi xoay vòng key LLM — tinh chỉnh tốt hơn nhiều agent CLI |
| 6 | Chạy nền + persist | ✅ | Task sống qua reload/đổi session (server-side loop + DB persist từng bước) — Claude Code CLI không có khái niệm này (process gắn terminal) |
| 7 | Model resilience | ✅ | Kimi k3 policy + 4 key NVIDIA × 3 fail + fallback chain (deepseek → minimax → z-ai-sdk) — Kiến trúc resilient hơn cả 3 hệ thống tham chiếu |
| 8 | Native function calling | ◐ | Có ở team engine (Phase 1c dual mode) nhưng chat route standalone vẫn regex |
| 9 | Context overflow detection | ◐ | Có ở team mode (80k → pause/resume handoff) nhưng KHÔNG có compaction thật |
| 10 | Checkpoint trước thao tác nguy hiểm | ✅ | fs-checkpoint + Neo4j differential trước file_edit/git_commit/run_tests — an toàn hơn Claude Code mặc định |
| 11 | Learning loop | ✅ | Layer 9: historical feedback → budget clamp, failure patterns → adaptation log |
| 12 | Self-authoring tools | ✅ | create_custom_tool — agent tự viết tool thiếu, lưu vĩnh viễn, dùng ngay |
| 13 | Memory hệ thống | ✅ | Recall → inject prompt, extraction, decay theo importance |

**Kết luận phần này**: TMO MẠNH hơn các hệ thống tham chiếu ở tầng hạ tầng (resilience, persist, checkpoint, learning, hiển thị tiến trình). Điểm yếu nằm ở **TẦNG ĐIỀU KHIỂN VÒNG LẶP** — chính là thứ quyết định "agent làm việc dài hạn đến khi xong việc".

---

## 3. TMO CHƯA BẰNG ĐƯỢC GÌ

### 3.1 🔴 NGHIÊM TRỌNG — đúng trọng tâm user yêu cầu

| # | Khoảng cách | Claude Code | Z.ai Code | Kimi Code | TMO standalone |
|---|-------------|-------------|-----------|-----------|----------------|
| G1 | **Không có vòng lặp MỤC TIÊU** — loop kết thúc khi LLM ngừng phát tool call, không phải khi mục tiêu được kiểm chứng | model tự chạy đến khi xong | model + verify mandate | model + plan/act | ❌ cắt cứng 8 vòng, xong hay chưa do LLM tự nói |
| G2 | **Không có pha VERIFY bắt buộc** — không ai ép agent chạy test/đọc lại file trước khi tuyên bố hoàn thành | kỷ luật model + CLAUDE.md | mandate browser-verify | kỷ luật model | ❌ hoàn toàn dựa vào thiện chí LLM |
| G3 | **Không có EVALUATOR độc lập** — không có trọng tài soi bằng chứng, quyết định "đạt/chưa đạt" | user đóng vai trò | mandate tự verify | user | ❌ (team có TL verify, standalone không) |
| G4 | **Không có DIAGNOSE → REPLAN** — fail xong không ai hỏi "vấn đề nằm ở đâu" rồi lên kế hoạch mới | model tự làm | model tự làm + todo | model tự làm | ❌ fail là fail, trả lỗi thẳng |
| G5 | **Không phát hiện lặp vô ích (no-progress)** — agent lặp lại đúng hành động fail mãi | — | todo đối chiếu | — | ❌ |

### 3.2 🟈 VÀNG — làm được nhưng kém hơn

| # | Khoảng cách | Chi tiết |
|---|-------------|----------|
| G6 | **Context quá hẹp cho task dài** | Chat route: chỉ 6 tin nhắn lịch sử + flatten thành 1 chuỗi prompt; tool result đẩy nguyên văn vào messages (không cap). Claude Code: full conversation + auto-compaction; Kimi: 256K native |
| G7 | **maxIterations = 8** | Task thật (vd: đọc 3 file → sửa 2 file → chạy test → fix → test lại) cần 10-20 vòng. Claude Code/Z.ai/Kimi chạy hàng trăm turn |
| G8 | **Regex parse tool call ở chat route** | `tool_call: name({...})` — JSON hỏng là mất tool call; native FC (team engine đã có) chưa kéo về chat route |
| G9 | **Không có subagent** | 1 agent ôm hết recon + implement + verify → context ô nhiễm. Cả 3 hệ thống tham chiếu đều có Task/subagent |
| G10 | **Thought Process là display-only** | Không phải working memory điều khiển vòng lặp (Claude Code: thinking block là 1 phần thật của chuỗi suy luận) |

### 3.3 🟢 XANH — chấp nhận được ở thời điểm này

- Plan mode / approval gate (Claude Code có) — TMO có routing TL nhưng không có gate chờ user duyệt
- Hooks system (Claude Code có)
- Multi-file parallel edits trong 1 turn (cả 3 có, TMO gọi tuần tự)
- Interleaved thinking native (Kimi/Claude có — TMO dùng thought thay thế)

---

## 4. KẾT LUẬN ĐÁNH GIÁ

> TMO đã đạt **parity về hạ tầng agent** (tools, hiển thị, resilience, persist — thậm chí vượt ở vài điểm: key rotation, checkpoint, chạy nền). Cái TMO thiếu chính là **bộ não điều khiển vòng lặp dài hạn**: cơ chế `Xác định vấn đề → Triển khai → Kiểm định → Đánh giá hoàn thành → (chưa: Chẩn đoán lỗi ở đâu → Lập kế hoạch lại → lặp lại) → Hoàn thành`.
>
> Các hệ thống Claude Code / Z.ai Code / Kimi Code đạt được điều này bằng: context cực lớn + model kỷ luật + (Z.ai) mandate verify. TMO không thể copy nguyên (model qua API rotation, context giới hạn) → cần **harness-enforced goal loop** — vòng lặp mục tiêu do CODE ép buộc, không trông chờ thiện chí model. Đây thực chất là kiến trúc MẠNH HƠN model-discipline vì kiểm chứng được bằng code.

---

## 5. GIẢI PHÁP TRIỂN KHAI — GOAL-DRIVEN LONG-HORIZON LOOP

### 5.1 Thiết kế (đã triển khai trong PR này)

```
┌────────────────────────────────────────────────────────────────┐
│  GOAL-DRIVEN LOOP (agent độc lập — mọi agents có provider/model)│
│                                                                │
│  CYCLE 1..maxCycles (mặc định 4):                              │
│   ┌── [1] PLAN — protocol ép: phân tích vấn đề, todo_write     │
│   ├── [2] EXECUTE — ReAct loop (10 vòng/chu kỳ, 40 vòng tổng)  │
│   ├── [3] VERIFY — protocol ép: PHẢI kiểm định bằng tool thật  │
│   │        (file_read đọc lại / run_tests / lint / shell)      │
│   ├── [4] EVALUATE — trọng tài LLM ĐỘC LẬP, chỉ tin BẰNG      │
│   │        CHỨNG tool (không tin lời tuyên bố):                │
│   │        {complete, confidence, verified, missing, rootCause,│
│   │         nextPlan} — JSON có validate                       │
│   └── [5] chưa đạt → DIAGNOSE + REPLAN → inject directive      │
│            "Mục tiêu CHƯA đạt. Vấn đề nằm ở: X. Kế hoạch mới:  │
│             Y. KHÔNG lặp lại đúng hành động đã fail" → chu kỳ  │
│            kế tiếp                                             │
│                                                                │
│  STOP: hoàn thành ✓ | maxCycles | time budget 30' | token      │
│  budget 200k | no-progress (fingerprint trùng 2 chu kỳ) | user │
│  cancel | LLM error                                            │
│                                                                │
│  Luôn kết thúc bằng BÁO CÁO TRUNG THỰC: hoàn thành đến đâu,    │
│  bằng chứng gì, còn thiếu gì (không tuyên bố ảo)               │
└────────────────────────────────────────────────────────────────┘
```

**Khác biệt so với Claude Code/Z.ai/Kimi Code**: 3 hệ thống đó dựa vào model-discipline; TMO ép bằng harness — evaluator độc lập soi bằng chứng, no-progress detector, budgets. Đánh đổi: tốn thêm ~1 LLM call/chu kỳ (rẻ so với chạy sai task dài).

### 5.2 Các thành phần bổ sung

1. **Context hygiene**: tool result cap 4000 ký tự khi đẩy vào messages; trim về 48 messages sau mỗi chu kỳ (giữ system + goal)
2. **Todo phản ánh trạng thái thật**: hoàn thành → auto-close; KHÔNG hoàn thành → đánh dấu `failed` (không còn đóng ảo thành completed)
3. **Thought Process tích hợp**: mỗi chuyển pha (chu kỳ mới/chẩn đoán/đánh giá) ghi thought → panel UI hiện tiến trình dài hạn live
4. **Config bằng env**: `GOAL_LOOP_MAX_CYCLES` (4), `GOAL_LOOP_ITERATIONS_PER_CYCLE` (10), `GOAL_LOOP_TIME_BUDGET_MS` (1800000), `GOAL_LOOP_TOKEN_BUDGET` (200000)
5. **Fail-open**: goal loop crash → trả nội dung tốt nhất đã có; crash hoàn toàn → fallback /api/query như cũ

### 5.3 Lộ trình tiếp theo (chưa làm trong PR này — theo thứ tự ưu tiên)

1. **Native function calling cho chat route** (đã có sẵn dual mode ở team engine — kéo qua) → bỏ regex fragile
2. **Auto-compaction** (tóm tắt giữa chu kỳ khi prompt > 60k tokens — thay vì chỉ trim message count)
3. **Subagent tool** (`spawn_subagent`) — delegate recon/verify cho context con
4. **Plan approval gate** cho tác vụ rủi ro cao (file_delete, git force) — hiện đã có checkpoint nhưng chưa có gate
5. Đo lường: tỷ lệ task hoàn thành thật sau N chu kỳ (Layer 9 đã có ExecutionMetrics — thêm field goalLoop)

---

*Tài liệu này được viết kèm triển khai `src/lib/agent-goal-loop.ts` — xem code để biết chi tiết từng cơ chế.*
