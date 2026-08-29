# SELF-MONITORING — Kiến trúc giám sát runtime của TMO (Task 20-b)

> Báo cáo audit + kiến trúc sau thay đổi + kế hoạch giai đoạn tiếp.
> Ngày: 2026-09-10 · Task: 20-b (self-monitoring) · Trước đó: 20-b-survey (audit Explore).

## 1. Verdict 3 tiêu chí của user

### (a) Hệ thống có biết agents đang làm gì real-time? — **CÓ, với caveat**

- **CÓ**: activity log in-memory (ring buffer 300 entries, `agent-activity-log.ts`) ← `executeTool()`
  ghi MỖI tool call (success + durationMs + resultPreview thật) → Terminal UI poll
  `/api/agent-activity` mỗi **2.5s**. Thought Process + Todos qua run tracker in-memory
  (`agent-run-tracker.ts`) → poll `/api/agent-run?sessionId=` mỗi **1.2s**. Token burn qua
  SSE `/api/token-usage/stream` (push).
- **Caveat (trước 20-b)**: toàn bộ activity + run state là **in-memory** — restart app là mất;
  chỉ ChatMessage.metadata JSON (summary compact, cap 80 events) là sống sót. Tool calls
  KHÔNG có bản ghi DB nào.

### (b) Ba chỉ số trung tâm

| Chỉ số | Trước 20-b | Sau 20-b |
|---|---|---|
| **Token burn** | ✅ đầy đủ: llm.ts capture usage mọi provider → 5 model `DailyToken*` (per agent/provider/model, input/output split) → SSE + Token tab | ✅ giữ nguyên (không đụng) + giờ còn đọc được qua `/api/metrics/overview` |
| **Tool success rate** | ❌ ToolMetric model tồn tại nhưng **chưa bao giờ được ghi** ("phantom"); `/api/tools/analytics` cast `db.toolCallLog` — model không tồn tại → **luôn 500** (dead code) | ✅ mọi tool call (Terminal feed) land vào `ToolMetric` (DB) 1:1; analytics endpoint chạy thật: success rate per tool/agent, avg duration, errorTag, alerts |
| **Stuck loops** | ✅ goal-loop: no-progress fingerprint (hash 6 messages cuối) + auto-escalate Omega; budget guard (max_cycles / time / token) — NHƯNG verdict chỉ nằm trong ChatMessage.metadata | ✅ giữ nguyên + `AgentRunRecord` persist stopReason mỗi run → đếm được no_progress theo giờ/ngày + alert "N vòng lặp kẹt" trong overview |

### (c) Metrics tập trung

- **TRƯỚC**: 3 silo phân mảnh — (1) Token tab (DailyToken*), (2) Terminal/Thought Process
  (in-memory), (3) Layer 9 Learning tab (ExecutionMetrics của workflow-engine). Không có
  chỗ nào nhìn được CẢNG bức tranh (token + tool + run) cùng lúc; tab Analytics chỉ là KB stats.
- **SAU**: `GET /api/metrics/overview?hours=24` — 1 endpoint tập trung 4 section độc lập
  fail-open (`tokens` / `tools` / `runs` / `alerts`), render trong panel **Runtime Metrics**
  (tab Analytics, poll 10s). 2 endpoint phụ: `/api/tools/analytics?days=7` (chi tiết tool
  health) + `/api/tools/analytics/export` (CSV/JSON).

## 2. Kiến trúc / data flow sau Task 20-b

```
tool exec (executeTool — single chat ReAct + Code Team + cron; tool-calls.ts chỉ là parser)
  │
  ├─ recordAgentActivity()  ← CHOKE-POINT DUY NHẤT (executeTool là caller duy nhất)
  │     ├─ ring buffer 300 entries (in-memory) → GET /api/agent-activity → Terminal (poll 2.5s)
  │     └─ recordToolMetric()  [MỚI 20-b — fire-and-forget, fail-open]
  │            └─ INSERT ToolMetric (toolName, sessionId, agentRole, success, exitCode, durationMs, errorTag)
  │                 ├─ GET /api/tools/analytics?days=7      (byTool/byAgent/timeline/alerts)
  │                 └─ GET /api/metrics/overview → tools section (24h) ──┐
  │                                                                      │
  ├─ recordAgentRunTool() → run events (Thought Process, poll 1.2s)      ├─ UI Runtime Metrics Panel
  │                                                                      │ (tab Analytics, poll 10s)
  run kết thúc (endAgentRun / user cancel)                               │
  └─ persistAgentRunRecord()  [MỚI 20-b — fire-and-forget, fail-open]     │
       └─ INSERT AgentRunRecord (sessionId, agentName, status, stopReason,          │
            toolCalls, toolFailures, durationMs, complete, startedAt/completedAt)   │
            └─ GET /api/metrics/overview → runs section + alerts (no_progress) ────┘

token burn (llm.ts — KHÔNG đổi)
  └─ DailyTokenByAgent (hôm nay) ──→ GET /api/metrics/overview → tokens section ──┘
```

### Quyết định kỹ thuật chính

1. **Choke-point ToolMetric = bên trong `recordAgentActivity()`** (agent-activity-log.ts).
   Lý do: (a) là nơi DUY NHẤT mọi tool execution chảy qua (grep xác nhận executeTool là
   caller duy nhất — đường "chat ReAct tool-calls.ts" thực chất chỉ là *parser*, mọi
   execution đều qua `executeTool`); (b) đủ field cần thiết (tool, sessionId, agentName→agentRole,
   success, durationMs, resultPreview→errorTag khi fail); (c) đảm bảo đúng yêu cầu
   "mọi tool execution hiện lên Terminal feed cũng phải land vào ToolMetric" — 1:1, kể cả
   caller tương lai. errorTag = dòng đầu resultPreview (message lỗi) trim 64 ký tự;
   exitCode: success→0, fail→1.
2. **Điểm ghi AgentRunRecord = `endAgentRun()` + `cancelSessionRuns()`** trong
   agent-run-tracker.ts (KHÔNG đụng agent-goal-loop.ts / chat route — dành cho 20-c).
   Guard `wasRunning`: chỉ persist khi run CHUYỂN từ 'running' → kết thúc (1 row/run, không
   trùng khi endAgentRun bị gọi 2 lần); restart app → map rỗng → không ghi gì (an toàn).
   Status map: done→completed, error→failed, cancelled→cancelled. stopReason v1 là
   heuristic (complete|error|cancelled) — xem "Còn thiếu".
3. **Fail-open tuyệt đối**: mọi DB write là `void db.*.create({...}).catch(() => {})` trong
   try/catch — metrics KHÔNG BAO GIỜ làm fail tool execution / run / API. Mọi route trả
   200 zero-state thay vì 500 khi DB lỗi.

## 3. Kế hoạch giai đoạn tiếp (CHƯA làm)

1. **Per-run token↔tool↔duration join** — cần task 20-c wire goal-loop metadata
   (tokensUsed, evaluatorConfidence, cycles, messageId, stopReason budget thật:
   max_cycles/time_budget/token_budget/no_progress) vào AgentRunRecord lúc endAgentRun
   (agent-goal-loop.ts:813 có sẵn toàn bộ số này trong scope). Hiện các field đó = null.
   Ngoài ra wire ghi row lúc run START (status='running') để `runs.active` ≠ 0.
2. **Retention policy (cron prune)** — ToolMetric > 30 ngày + AgentRunRecord > 90 ngày
   deleteMany định kỳ (qua cron scheduler sẵn có). Hiện chưa có → bảng sẽ phình dần
   (ToolMetric ~ vài trăm row/ngày tùy mức dùng tool).
3. **Metrics cho mini-services** (openclaw-gateway, gateway-bridge, cron-scheduler,
   opencode-server) — hiện chỉ console.log + RAM guard; cần counter/health endpoint riêng.
4. **Đánh thức hoặc xóa code dormant**: `error-handling/loop-detector.ts` (detectLoop chỉ
   dùng trong test), `thinking/token-monitor.ts` (exported, 0 consumer) — wire vào
   overview alerts hoặc dọn bỏ.
5. **Cost/$ estimation** — DailyToken* đã có input/output per model; chỉ thiếu bảng giá →
   cộng cột cost vào overview.
6. **OTel (OpenTelemetry)** — chỉ cần khi đa máy/đa process; sandbox single-process thì
   SQLite + poll là đủ.

## 4. Ghi chú vận hành

- **Agent tự query metrics**: hiện agent có thể tự `curl localhost:3000/api/metrics/overview`
  qua tool `shell` — KHÔNG có tool chuyên dụng (đề xuất roadmap: `get_runtime_metrics`
  wrapper, thêm vào whitelist của agent muốn dùng).
- Endpoint mới: `GET /api/metrics/overview?hours=24` (max 168) · `GET /api/tools/analytics?days=7`
  (max 90) · `GET /api/tools/analytics/export?days=7&format=csv|json`.
- ToolMetric.agentRole chứa **agentName** (Omega/CATALYST/TL...) — schema comment ghi role
  code nhưng tên agent trực quan hơn cho analytics; sessionId='unknown' khi tool exec
  không có session (cron/verify script).
