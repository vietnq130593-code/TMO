# KẾ HOẠCH TRIỂN KHAI AGENT ALISTA — KỸ SƯ BẢO TRÌ HỆ THỐNG

> **Người soạn:** Obi — Kỹ sư AI / Kiến trúc sư hệ thống TMO
> **Phiên bản:** v1.3 · **Ngày:** 2026-09-01
> **Trạng thái:** Đã phê duyệt → ĐÃ TRIỂN KHAI + E2E VERIFY ✅
> **Nguồn yêu cầu:** Owner (phiên chat 2026-09-01)
>
> **Lịch sử phiên bản:**
> - v1.0 (2026-09-01) — bản đầu, 6 nhiệm vụ giám sát, pipeline song song.
> - v1.1 (2026-09-01, bổ sung) — owner directive mới: (1) ca trực tối đa **6 tiếng** kể từ 23h30 (deadline 05:30 sáng hôm sau giờ VN), (2) pipeline chạy **TUẦN TỰ** — kiểm tra từng nhiệm vụ một, viết đề xuất từng nhiệm vụ một (không song song), (3) bổ sung **nhiệm vụ ⑦** kiểm tra lỗi/vấn đề/thiếu sót trong hệ thống **Database bao gồm cả Memory + Learning** (nếu chưa có cơ chế tương đương), (4) máy chạy **local** — không lo sandbox reset, (5) triển khai lần lượt theo plan rồi push code.
> - **v1.2 (2026-09-01, hậu triển khai)** — owner directive mới: (1) **LUỒNG PHẢN HỒI KÍN** — mỗi đề xuất ALISTA được phê duyệt + xử lý hoàn tất → thông tin chuyển tới ALISTA **NGAY** → ALISTA xác minh lại vấn đề đã triệt để chưa → còn vấn đề (dù khác) hoặc cần nâng cấp → **gửi đề xuất mới ngay lập tức** (vòng lặp tự duy trì); (2) rà soát hậu triển khai + 10 fix v1.2 (xem mục 7).
> - **v1.3 (2026-09-01, đánh giá năng lực + hoàn thiện)** — owner hỏi: "ALISTA đã đủ công cụ chẩn đoán + nguồn dữ liệu + tiêu chí xác nhận hiệu quả chưa?". Kết quả audit: nền chẩn đoán đủ nhưng 4 khoảng trống → bổ sung (xem mục 8): (1) **SUCCESS CRITERIA có cấu trúc** — mỗi finding kèm metric + current + target + recheck window, đưa vào văn proposal (🎯 TIÊU CHÍ XÁC NHẬN HIỆU QUẢ); (2) **verify hoãn theo recheck window** — metric cần thời gian phản ánh (successRate 7d, backfill...) → HOÃN verify đến dueAt (marker 'alista-verify-deferred' durable, sweep 60s tự kích hoạt khi đến hạn) thay vì verify NGAY gây false-negative "CHƯA triệt để"; (3) **độ phủ nguồn dữ liệu 6/6 services** — ⑤ thêm R2 + Supabase + NVIDIA key count + disk usage; ⑦ thêm sub-check (h) Scheduler health (CronJob trễ lịch >1h, JobQueue stuck/backlog/failures) — "ai canh những người canh"; (4) **recurrence tracking** — đếm số lần đề xuất cùng vấn đề → prefix ⚠ TÁI DIỄN + bump priority deterministic (≥2 lần → medium, ≥4 → high).

---

## 0. TÓM TẮT ĐIỀU HÀNH

Xây dựng **ALISTA** — agent bảo trì hệ thống thứ 8 của TMO, làm việc **23h30 hàng ngày** (giờ Việt Nam, UTC+7) tại khu vực **Database > Analytics**, thực hiện **7 nhiệm vụ giám sát/chẩn đoán** (6 nhiệm vụ gốc + nhiệm vụ ⑦ mới kiểm tra Database/Memory/Learning). Mọi phát hiện có vấn đề đều được viết thành **đề xuất (proposal) gửi tới module SELF-DIRECTION** để owner phê duyệt. Kèm theo **3 thay đổi UI** tại module Database: xóa 2 tab Chat/Explorer, thêm nút **Kiểm tra toàn diện** (chạy tay thay vì chờ 23h30) và **bộ chọn khoảng ngày (từ ngày → đến ngày)** để xem dữ liệu Analytics theo lịch sử — cả 2 nằm cùng dòng, bên phải nút "Chạy decay".

**Ràng buộc thời gian v1.1 (owner directive bổ sung):**
- **Cửa sổ kích hoạt:** 23h30 hàng ngày (giờ VN) — scheduler nền 60s tick, gate 1 lần/ngày.
- **Thời gian làm việc tối đa 6 tiếng** — deadline cứng **05:30 sáng hôm sau (giờ VN)**. Pipeline `runComprehensiveCheck` ghi `startedAt` lúc khởi động; mỗi bước collector/rules/proposal kiểm tra `Date.now() < hardDeadlineMs` trước khi chạy — nếu vượt deadline, pipeline **dừng graceful**, ghi `status:'completed'` với `reason:'budget_exhausted'` + `partialSteps:[...]` (các bước chưa chạy), mọi proposal đã tạo trong ca vẫn giữ. Owner sẽ thấy task history ghi rõ "ca trực bị cắt ngang ở bước N".
- **Tuần tự KHÔNG song song:** 7 collector chạy **lần lượt** theo thứ tự ①→⑦; mỗi collector xong → ngay chạy `rulesFor(check)` → `createProposalsFor(check)` → ghi TaskExecution step → chuyển sang check kế tiếp. Cấu trúc tuần tự giúp: (a) tải đỉnh RAM/LLM thấp (chỉ 1 call LLM đang chạy tại 1 thời điểm), (b) nếu 1 collector lỗi không kéo theo cả mảng, (c) owner đọc task history thấy rõ thứ tự chẩn đoán.
- **Local machine (không sandbox reset):** scheduler + CronJob row + ensureAlistaAgent() idempotent → nếu app restart giữa đêm, tick tiếp tục chạy ở lần boot kế tiếp trong cùng cửa sổ 23:30-23:59; nếu trượt hẳn cửa sổ, đêm đó bỏ qua, đêm sau chạy lại. Dữ liệu giám sát nguồn cloud (Neo4j Aura/Supabase/R2) + SQLite local đều tồn tại qua restart.

**Nguyên tắc thiết kế vàng:** ALISTA là *kỹ sư chẩn đoán và đề xuất*, không phải executor tự ý sửa — quyền hạn đọc/khảo sát rộng (tools health, DB, Neo4j, Qdrant, code), quyền ghi chỉ giới hạn ở: proposal Self-Direction + bản ghi kiểm tra (TaskExecution). Mọi thay đổi hệ thống thật phải qua phê duyệt của owner. Điều này khớp 100% với mô hình phê duyệt sẵn có của Self-Direction (pending → approved → ready → executing → completed).

---

## 1. HIỆN TRẠNG NỀN TẢNG (đã khảo sát 2026-09-01)

| Thành phần | Hiện trạng | Tái sử dụng cho ALISTA |
|---|---|---|
| Agent roster | 7 agents (5 Code Team + Omega + Opus), `AgentProfile` (SQLite) | Thêm ALISTA vào `STANDALONE_AGENTS` — tự seed |
| Proposal engine | `SelfDirectionProposal` + `ProposalStep` (schema:1593-1693), `createSelfDirectionProposal()` (orchestrator.ts:1697), 8 category, 4 phần bắt buộc problem/solution/implementation/scheduleAt | Dùng nguyên vẹn — category `tool_failure/gap/improvement/long_term/automation` |
| Cron infrastructure | `CronJob` model + 2 vòng lặp (mini-service port 3004 + automation-engine poll UI) + scheduler nền kiểu Self-Direction 60s trong `instrumentation-node.ts:296-340` | Mượn mẫu scheduler nền 60s (chạy headless, không phụ thuộc UI mở) |
| Monitoring data | `/api/metrics/overview?hours=24` (ToolMetric + AgentRunRecord + tokens), `/api/tools/analytics?days=7`, `/api/episodic/overview` (escalations), `/api/query?action=stats` (domainDistribution), `/api/health` + `action=embed-status` (3 tầng dữ liệu) | Đủ 100% nguồn dữ liệu cho 6 nhiệm vụ — không cần nguồn mới |
| System scan | `src/lib/self-direction/scan.ts` (528 dòng, POST /api/self-direction/scan) — khung scan tổng hợp + LLM → ≤5 proposals | Làm **tham chiếu kiến trúc** cho pipeline kiểm tra toàn diện |
| Analytics UI | `RuntimeMetricsPanel` (poll 10s) + `EpisodicMemoryPanel` (poll 15s, toolbar "Làm mới" + "Chạy decay" tại dòng 404-440) + `AnalyticsSection` (Domain Coverage, Kiểm tra 3 tầng) | Chèn 2 control mới vào toolbar; mở range-params cho 2 panel |
| Tabs Database | 6 tabs (Chat/Explorer/Tài liệu/Analytics/Token/Auto-Learn), `page.tsx:20405-20487`, default 'chat' (:18948), restore whitelist (:20144) | Xóa Chat + Explorer, default → 'documents' |
| Calendar UI | `src/components/ui/calendar.tsx` (react-day-picker, hỗ trợ `mode="range"`), Popover sẵn có, date-fns sẵn có | Dùng cho bộ chọn khoảng ngày |

**Điểm chú ý múi giờ:** server sandbox chạy giờ **UTC**, user ở **UTC+7 (Etc/GMT-7)**. "23h30 hàng ngày" hiểu là 23:30 **giờ Việt Nam**. Toàn bộ logic giờ của ALISTA dùng `Intl.DateTimeFormat` với `timeZone: 'Asia/Ho_Chi_Minh'` tường minh — không phụ thuộc đồng hồ server.

---

## 2. KIẾN TRÚC TỔNG THỂ

```
┌───────────────────────────── TMO APP (PM2, port 3000) ─────────────────────────────┐
│                                                                                     │
│  [B2] src/lib/alista/                                                               │
│  ├─ collectors.ts     ← 7 bộ thu thập dữ liệu (fail-open từng nguồn)               │
│  │    ① ToolMetric 7d   ② AgentRunRecord 24h/7d   ③ Escalations (Neo4j)            │
│  │    ④ Domain Coverage  ⑤ 3 tầng Qdrant/Neo4j/Embed                              │
│  │    ⑥ Tự-đánh-giá ALISTA  ⑦ Database + Memory + Learning (v1.1 MỚI)            │
│  ├─ rules.ts          ← ngưỡng xác định (deterministic) → findings[]               │
│  ├─ proposals.ts      ← LLM (kimi-k3) viết 4 phần + fallback template              │
│  │                       + dedupe theo key + createSelfDirectionProposal           │
│  ├─ comprehensive-check.ts ← pipeline TUẦN TỰ 7 bước (mỗi bước = collect→rules→     │
│  │                          proposals→TaskExecution step) + deadline 6h cứng       │
│  │                          + state Map (UI poll) + globalThis guard (HMR)         │
│  └─ alista-scheduler.ts ← tick 60s, cửa sổ 23:30-23:59 (tz HN), gate 1-lần/ngày   │
│                            + chuyển deadline 05:30 sang pipeline (deadlineMs)      │
│                                                                                     │
│  [B3] instrumentation-node.ts — đăng ký scheduler nền (mẫu Self-Direction:296)      │
│  [B4] API: POST/GET /api/alista/check · GET /api/alista/checks                     │
│          + /api/metrics/overview & /api/episodic/overview nhận ?from=&to=          │
│                                                                                     │
│  [UI] module Database:  4 tab (bỏ Chat/Explorer)                                    │
│        tab Analytics → EpisodicMemoryPanel toolbar:                                 │
│        [Làm mới] [Chạy decay] [🛡 Kiểm tra toàn diện] [📅 Từ ngày → đến ngày]      │
│                                     │                │                             │
│                                     ▼                ▼                             │
│                          POST /api/alista/check   range state (lift page.tsx)      │
│                          (fire-and-forget + poll)   → 2 panel chuyển chế độ lịch sử │
│                                                                                     │
│  [Đích] SelfDirectionProposal (source:'agent', createdBy:'ALISTA')                  │
│         → hiển thị Self-Direction module (poll 4s sẵn có) → owner duyệt             │
│         → duyệt automationJson → sinh CronJob/StandingOrder thật                    │
└─────────────────────────────────────────────────────────────────────────────────────┘

Luồng đêm (v1.1 — tuần tự + budget 6h):
  instrumentation boot → scheduler 60s tick → 23:30-23:59 (tz HN) + chưa chạy hôm nay
  + CronJob enabled → runComprehensiveCheck({trigger:'cron-nightly'})
  → 7 collector TUẦN TỰ (①→⑦), mỗi collector: collect → rules → LLM proposal
    → createSelfDirectionProposal → TaskExecution step → check deadline (05:30 VN)
  → hoàn tất: TaskExecution(type:'alista-check', result:{perCheck[], proposalsCreated,
    durationMs, deadlineMet:true|false, partialSteps:[]})
  → nếu trượt deadline giữa chừng: dừng graceful, ghi rõ bước còn dang dở
Luồng tay (nút Kiểm tra toàn diện): không áp dụng budget 6h (chạy đầy đủ), áp dụng
  deadline mềm 10 phút (UI poll 300s timeout) — nếu chạy quá 10' vẫn ghi proposal đã có.
```

---

## 3. HẠNG MỤC CÔNG VIỆC CHI TIẾT

### H1 — Agent profile ALISTA (0.5h)

**File 1: `src/lib/standalone-agents.ts`** — append 1 phần tử vào `STANDALONE_AGENTS` (sau Omega, dòng 361 đóng mảng):

```ts
{
  name: 'ALISTA',
  description: 'Kỹ sư bảo trì hệ thống TMO — giám sát real-time tool health & agent runs, '
    + 'chẩn đoán escalations & 3 tầng dữ liệu (Qdrant/Neo4j/Embeddings), đánh giá Domain Coverage, '
    + 'viết đề xuất cải tiến gửi Self-Direction. Ca trực: 23h30 hàng ngày + kiểm tra thủ công theo yêu cầu.',
  instruction: `Bạn là ALISTA — Kỹ sư Bảo trì Hệ thống của The Magnum Opus. ...`,
  domain: 'mixed',
  capable: 'Giám sát tool health, phân tích AgentRunRecord lỗi, nghiên cứu escalations episodic, '
    + 'đánh giá domain coverage KB, health-check 3 tầng dữ liệu, viết proposal bảo trì 4 phần chuẩn Self-Direction',
  provider: 'nvidia',
  model: 'moonshotai/kimi-k3',
  temperature: 0.3,        // chẩn đoán cần chính xác, ít sáng tạo
  maxTokens: 16384,
  team: null,
  position: null,
  avatar: '🛠️',
  tools: [
    'get_app_runtime_status', 'db_query', 'knowledge_search', 'knowledge_graph',
    'file_read', 'file_list', 'grep', 'lint', 'type_check', 'run_tests',
    'shell', 'run_bg', 'read_output', 'kill_process',
    'git_status', 'git_diff', 'git_log', 'get_diagnostics',
    'summarize', 'synthesize',
  ],
}
```

*Nội dung system prompt (instruction) — dàn ý bắt buộc:* (1) IDENTY & PURPOSE: kỹ sư bảo trì, ca 23h30; (2) NGUYÊN TẮC: chỉ chẩn đoán + đề xuất — không tự sửa hệ thống; mọi phát hiện phải có **số liệu chứng cứ** (percent, count, sample) lấy từ dữ liệu được cấp — **cấm bịa số liệu**; (3) 6 NHIỆM VỤ (đúng mô tả owner); (4) CHUẨN ĐỀ XUẤT: 4 phần problem/solution/implementation (+impact), tiếng Việt, ngắn gọn ≤ 2.000 ký tự/phần; (5) FORMAT OUTPUT khi được hỏi: JSON proposal hoặc báo cáo markdown.

*Ghi chú:* danh sách tools là whitelist đề xuất — bước triển khai đối chiếu `getAllBuiltinToolNames()` để chốt tên đăng ký chính xác (tên đã verify trong tool-executor.ts: get_app_runtime_status:1083, db_query:861, lint:816, shell:1119...).

**File 2: `src/lib/agent-constants.ts:153`** — thêm entry `ALISTA` vào `AGENT_COLORS` (màu amber `#f59e0b` — phân biệt 6 màu hiện có).

**Seed:** tự động — `ensureStandaloneAgents()` chạy lazy tại `GET /api/agents` (warm-up instrumentation gọi sau boot 1.5s) → `findUnique({name:'ALISTA'})` → tạo `isSystem:true`. Không cần seed tay. Restart app là đủ.

**Kiểm chứng H1:** `curl /api/agents` → 8 agents, có ALISTA 🛠️; panel Agents hiển thị ALISTA ở nhóm STANDALONE.

---

### H2 — Pipeline "Kiểm tra toàn diện" (3-4h) — trái tim của ALISTA

Thư mục mới **`src/lib/alista/`** (5 file + index):

#### B2.1 `collectors.ts` — **7 bộ thu thập** (mỗi cái fail-open, trả `{ok, data?, error?}`)

| # | Collector | Nguồn (tái sử dụng) | Dữ liệu thu |
|---|---|---|---|
| ① | Tools health | `ToolMetric` (SQLite) — query như `/api/tools/analytics` (groupBy toolName 7d) | per-tool: calls, errors, successRate, avgDurationMs, topErrorTag + 3 thông điệp lỗi mẫu |
| ② | Agent runs | `AgentRunRecord` — query trực tiếp (mẫu `findAgentRunRecordsSince`, metrics-db.ts) | 24h: failed/noProgress/stuck-running(>30')/byStopReason; 7d: **failure signature** = `agentName+stopReason` groupBy → số ngày xuất hiện (distinct days) — dùng cho logic "vấn đề đã được giải quyết chưa" |
| ③ | Escalations | `getEscalationCandidates(3)` (episodic-neo4j.ts:559) + `errorDashboard` rows | rootCause, occurrences, resolved, recentErrors[≤3] |
| ④ | Domain coverage | query stats như `/api/query?action=stats` (Neo4j `e.domain` groupBy, fallback SQLite localEntity) + **last-updated per domain** (max entity createdAt / document processedAt) | 8 domain chuẩn: count + ngày cập nhật cuối |
| ⑤ | 3 tầng dữ liệu | health checks nội bộ: Qdrant collections+pointCount (như /api/health), Neo4j nodeCount/relCount, embed-status (total/real/realRatio/hasRealEmbeddings — pattern `/api/query?action=embed-status`) | connected/exists/pointCount/nodeCount/realRatio + so sánh với lần check trước (lưu trong TaskExecution cũ) |
| ⑥ | Tự-đánh-giá ALISTA | kết quả ①-⑤ (source lỗi nào fail), TaskExecution 'alista-check' gần đây, tool whitelist của ALISTA | collector nào fail, năng lực nào thiếu để làm tốt hơn |
| ⑦ | **Database + Memory + Learning system** (v1.1 MỚI) | Đọc chéo nhiều nguồn — xem B2.1.7 bên dưới | Đầy đủ фон.health của 3 subsystem: SQLite integrity, Memory (episodic), Learning (auto-learn) |

#### B2.1.7 Collector ⑦ — Database + Memory + Learning system (v1.1 MỚI)

> Owner directive bổ sung: "Bổ sung thêm chức năng kiểm tra lỗi, vấn đề, thiếu sót trong hệ thống database bao gồm cả hệ thống Memory, Learning nếu chưa có". Collector ⑦ là câu trả lời cho yêu cầu này — khảo sát toàn vẹn 3 subsystem.

**7 sub-check bên trong collector ⑦ (chạy tuần tự trong cùng collector, không song song):**

| Sub | Tên | Nguồn dữ liệu | Phát hiện vấn đề |
|---|---|---|---|
| ⑦-a | **SQLite integrity & schema drift** | `ensureDbReady()` từ `db-setup.ts` (đã có sẵn probe drift + tự `prisma db push`); `db.$queryRaw` đếm bảng + kiểm tra OrphanAgentProfile (agent vô danh) | schema drift > 0 cột/bảng sai lệch, có bảng "ma" không có trong Prisma schema, ensureDbReady báo migrated=true nhiều lần trong 24h (lặp lại = schema bất ổn) |
| ⑦-b | **SQLite zombie rows** | `AgentRunRecord WHERE status='running' AND startedAt < now-6h` (zombie — run chết nhưng không ghi end); `TaskExecution WHERE status='running' AND startedAt < now-24h`; `SmolabTask WHERE status='running' AND updatedAt < now-30'`; `GoalLoopJob WHERE status='running' AND lastHeartbeat < now-15'` | bất kỳ zombie nào > 0 → đề xuất dọn dẹp + điều tra nguyên nhân (server crash, worker chết) |
| ⑦-c | **Memory mirror drift** (Episodic) | So sánh counts: `countEpisodeRecords()` (SQLite mirror) vs `getEpisodicGraphCounts()` (Neo4j Episode); `countLessonRecords()` vs `getAllLessonNodes(500)` đếm Lesson từ graph | drift > 20% (mirror thiếu > 20% so với graph) → đề xuất backfill mirror từ graph (pattern ngược với fallback hiện tại) |
| ⑦-d | **Learning system health** (Auto-Learn) | `getAutoLearnStats()` (auto-learn.ts:594) — totalRecords/completedRecords/failedRecords/pendingRecords; `db.pendingWriteback.count({status:'pending'})`; `db.lessonRecord.count({needsReview:true})` | (1) failedRecords > 5 trong 24h → đề xuất điều tra, (2) pendingRecords > 0 quá 24h (worker auto-learn kẹt) → đề xuất, (3) pendingWriteback backlog > 20 → đề xuất review, (4) lessonsNeedReview > 10 → đề xuất review |
| ⑦-e | **KnowledgeGraph sync drift** | `db.localResolvedEntity.count({synced:false})` (chưa sync Neo4j); `db.localEntity.count()` (raw buffer) vs `getNeo4jEntityCount()` (graph) — độ trễ sync | synced=false > 50 entity → đề xuất kick sync; raw buffer > 2× graph (sync đang kẹt) → đề xuất |
| ⑦-f | **Token anomaly** | `db.dailyTokenByAgent.findMany({date: last7Days})` — tính mean+stdDev per agent; so hôm nay với 7d mean | hôm nay > mean + 3×stdDev (spike) hoặc < mean × 0.1 (drop) → đề xuất điều tra (cost leak/loop/budget cạn) |
| ⑦-g | **DB size & storage** | `db.$queryRaw` đếm tổng row các bảng lớn (Document, LocalEntity, LocalRelationship, AgentRunRecord, ToolMetric, ChatMessage) + file size `db/custom.db` | DB > 500MB hoặc 1 bảng > 1M row → đề xuất archival/vacuum |

Mỗi sub trả sub-finding riêng (key `[ALISTA] db:<sub>:<yyyymm>`) → tối đa 2 sub-proposal từ collector ⑦ mỗi ca (tránh spam) → tổng cap vẫn ≤6/ca.

#### B2.2 `rules.ts` — ngưỡng deterministic → findings[] (LLM KHÔNG quyết định priority/category — tránh ảo giác)

| Check | Điều kiện trigger | Category | Priority | Cap/run |
|---|---|---|---|---|
| ① Tools | calls≥10 & successRate<50% | `tool_failure` | high | ≤3 (top offender theo errors) |
| | calls≥20 & 50%≤rate<80% | `tool_failure` | medium | |
| | avgDuration>30s & calls≥5 | `improvement` | low | |
| ② Runs | signature 7d: failed≥3, ≥2 ngày khác nhau, run gần nhất vẫn fail (chưa resolved) | `improvement` | medium; high nếu ≥5 hoặc noProgress≥3 | ≤2 |
| | zombie: status=running >30' | `improvement` | medium (kèm dọn) | |
| ③ Escalations | occurrences≥3 & unresolved≥2 | `improvement` | high nếu unresolved≥10 | ≤2 |
| ④ Domain | tổng entity<500 | `gap` | high | ≤1 (gộp 1 proposal liệt kê tất cả domain yếu) |
| | domain chuẩn nào <20 entity | `gap` | medium | |
| | domain >30 ngày không cập nhật | `gap` (note "lỗi thời") | low | |
| ⑤ 3 tầng | qdrant/neo4j disconnected | `improvement` | **critical** | mỗi tầng 1 proposal |
| | pointCount=0 mà KB có document | `improvement` | high (re-embed) | |
| | realRatio<50% / hasRealEmbeddings=false | `improvement` | high | |
| | nodeCount sụt >20% vs lần trước | `improvement` | high | |
| ⑥ Self | collector fail / thiếu tool/permission phát hiện trong ca | `long_term` | low | ≤1 |
| ⑦ Database/Memory/Learning (v1.1 MỚI) | schema drift >0 | `improvement` | high | ≤2 |
| | zombie rows >0 (AgentRunRecord/TaskExecution/SmolabTask/GoalLoopJob) | `improvement` | medium | |
| | Memory mirror drift >20% (Episode hoặc Lesson) | `improvement` | medium | |
| | Auto-Learn failed >5/24h hoặc pending >24h | `improvement` | high | |
| | pendingWriteback backlog >20 hoặc lessonsNeedReview >10 | `improvement` | medium | |
| | KnowledgeGraph synced=false >50 hoặc buffer >2× graph | `improvement` | medium | |
| | Token anomaly (spike >3σ hoặc drop <10% mean) | `improvement` | medium | |
| | DB size >500MB hoặc bảng >1M row | `long_term` | low | |

Mỗi finding mang: `key` (dedupe), `category`, `priority`, `evidence` (số liệu thô), `direction` (gợi ý giải pháp ngắn cho LLM phát triển thành văn).

#### B2.3 `proposals.ts` — tổng hợp văn bản + tạo proposal

1. **Dedupe key** (chống spam đêm): `[ALISTA] <check>:<target>:<yyyymm>` — ví dụ `[ALISTA] tool:grep:202609`, `[ALISTA] run:RAMPAGE:no_progress:202609`, `[ALISTA] layer:embed:202609`. Trước khi tạo: query `SelfDirectionProposal` `createdBy='ALISTA'` AND `title startsWith key` AND `status IN (pending, approved, ready, planning, executing)` AND `createdAt > 7 ngày` → tồn tại thì **skip** (đề xuất cũ còn sống). Đề xuất bị rejected/expired quá 7 ngày → được phép đề xuất lại (với bài học từ `decisionReason` nếu có).
2. **LLM synthesis**: gói findings → 1 call `callLLMForAgent(prompt, {provider:'nvidia', model kimi-k3}, ALISTA_SYSTEM_PROMPT, {agentId:'alista', agentName:'ALISTA'})` (llm.ts:3565) — yêu cầu xuất **JSON array** `{key, problem, solution, implementation, impact}` tiếng Việt, chỉ dùng số liệu trong findings. Parse + validate từng trường (validateProposalInput chuẩn sẵn orchestrator.ts:1712: title/problem/solution/implementation bắt buộc).
3. **Fail-safe template**: LLM lỗi / parse lỗi / thiếu trường → sinh văn bản từ `evidence` + `direction` bằng template chuỗi — **pipeline không bao giờ chết vì LLM**.
4. **Tạo bản ghi**: `createSelfDirectionProposal()` (orchestrator.ts:1697 — call server-side, không qua HTTP) với `source:'agent'`, `createdBy:'ALISTA'`, `scheduleAt: null` (low/medium) hoặc sáng hôm sau 08:00 (high/critical). Category/priority lấy từ **rules** (ghi đè nếu LLM lệch).
5. **Cap tổng**: ≤ 6 proposals/1 lần chạy.

#### B2.4 `comprehensive-check.ts` — pipeline TUẦN TỰ 7 bước + deadline 6h + state

```ts
runComprehensiveCheck(opts: {
  trigger: 'manual' | 'cron-nightly'
  force?: boolean
  /** Deadline cứng (epoch ms) — cron-nightly truyền 05:30 hôm sau (tz HN),
      manual truyền now + 10' (deadline mềm cho UI poll). */
  deadlineMs?: number
}): Promise<CheckResult>
```

**Pipeline TUẦN TỰ (v1.1 — không song song):**

```
start = Date.now(); hardDeadline = opts.deadlineMs ?? (start + 6*3600_000)
checkId = crypto.randomUUID()
globalState.set(checkId, {status:'running', steps:[], startedAt, deadlineMs:hardDeadline})
TaskExecution.create({type:'alista-check', status:'running', startedAt:now})

for (i = 1; i <= 7; i++):
  // BƯỚC THỨ i (tuần tự — KHÔNG dùng Promise.all):
  if (Date.now() >= hardDeadline):
    partialSteps.push({step:i, status:'skipped', reason:'budget_exhausted'})
    break
  
  stepStart = Date.now()
  stepEntry = {id:i, label:STEP_LABELS[i], status:'running', startedAt:stepStart}
  globalState.get(checkId).steps.push(stepEntry)
  
  try:
    // (a) collect — 1 nguồn tại 1 thời điểm
    const collected = await COLLECTORS[i-1]()           // fail-open: {ok, data?, error?}
    stepEntry.collectMs = Date.now() - stepStart
    stepEntry.collected = collected
    
    if (Date.now() >= hardDeadline) {                    // re-check sau collect
      stepEntry.status = 'partial'
      partialSteps.push({step:i+1..7, reason:'budget_exhausted'})
      break
    }
    
    // (b) rules → findings deterministic (ngay tại bước, không chờ LLM)
    const findings = evaluateRules(i, collected)         // B2.2
    stepEntry.findings = findings
    
    if (findings.length === 0 || Date.now() >= hardDeadline) {
      stepEntry.status = 'completed'; stepEntry.proposalCount = 0
      continue
    }
    
    // (c) proposals — LLM viết 4 phần cho findings của CHỈ bước này (1 call)
    //     + dedupe key + createSelfDirectionProposal (B2.3)
    const proposals = await createProposalsForCheck(i, findings, {deadlineMs: hardDeadline})
    stepEntry.proposalsCreated = proposals.map(p => p.id)
    stepEntry.proposalCount = proposals.length
    stepEntry.status = 'completed'
    
    // (d) ghi TaskExecution step ngay tại bước (lịch sử hiện hình dần)
    //     — đã có row 'running' tổng, sau mỗi bước update result.perCheck
    updateRunningTaskExecution(perCheckSoFar)
    
  except (err):
    stepEntry.status = 'failed'; stepEntry.error = err.message
    // fail-open — tiếp tục bước kế tiếp (không die cả pipeline)
  
  stepEntry.durationMs = Date.now() - stepStart
  globalState.notify()  // UI poll thấy tiến độ từng bước

// finalize:
result = {
  trigger, perCheck: globalState.steps,
  proposalsCreated: flatten(all proposals),
  durationMs: Date.now() - start,
  deadlineMet: Date.now() < hardDeadline,
  partialSteps,
  reason: partialSteps.length > 0 ? 'budget_exhausted' : 'all_checks_done'
}
TaskExecution.update(id, {status:'completed', completedAt:now, result: JSON.stringify(result)})
globalState.set(checkId, {status:'completed', result, ...})
return result
```

**Ý nghĩa các bước (STEP_LABELS):**
1. Tools health (①) 2. Agent runs (②) 3. Escalations (③) 4. Domain coverage (④)
5. 3 tầng dữ liệu (⑤) 6. Tự-đánh-giá ALISTA (⑥) 7. Database + Memory + Learning (⑦ v1.1)

**Deadline 6h (v1.1):**
- Cron-nightly: `deadlineMs = startOfTodayHN + 5.5h` → cụ thể `new Date(dateHN + 'T05:30:00+07:00').getTime()`.
- Manual (nút Kiểm tra toàn diện): `deadlineMs = start + 10*60_000` (10 phút mềm — đủ cho 7 bước + LLM, không để UI poll timeout).
- Re-check deadline SAU mỗi collector (collect có thể chậm — Qdrant/Neo4j latency) và SAU mỗi LLM call.
- Khi trượt: trạng thái bước hiện tại = 'partial' (đã chạy 1 phần), các bước sau = 'skipped' với reason. Owner thấy rõ "ca trực cắt ngang ở bước N".

**State cho UI poll**: `globalThis.__alistaChecks: Map<checkId, {status, steps[], startedAt, deadlineMs, result?}>` — pattern globalThis chống hot-reload khi Next dev HMR. POST trả `{checkId}` ngay (fire-and-forget), pipeline chạy async; GET poll đọc Map. UI poll mỗi 2s tối đa 300s (cron-nightly không có UI poll — chỉ TaskExecution).

**Idempotency đêm**: gate trong scheduler (B3), không trong pipeline — nút tay luôn chạy được (force=true bỏ qua dedupe-tuần nhưng vẫn dedupe-proposal còn sống).

---

### H3 — Lịch trực 23h30 hàng ngày + budget 6h (1h)

#### B3.1 `src/lib/alista/alista-scheduler.ts` — scheduler nền (kiểu Self-Direction)

```
startAlistaScheduler():  globalThis guard → ensureDbReady() → delay 15s → setInterval 60s
tick():
  1. job = db.cronJob.findFirst({where:{executor:'ALISTA'}})
     nếu !job || !job.enabled || job.status !== 'active' → return (owner pause được từ UI)
  2. nowHN = Intl parts với timeZone 'Asia/Ho_Chi_Minh' → {HH, mm, dateStr}
     nếu HH≠23 hoặc mm<30 → return            // cửa sổ 23:30-23:59 (chịu restart, trễ vẫn chạy)
  3. ranToday = taskExecution.findFirst({type:'alista-check', startedAt ≥ startOfTodayHN})
     nếu có → return                           // 1 lần/ngày
  4. TÍNH DEADLINE 6h (v1.1):
     startOfTodayHN = new Date(dateStr + 'T00:00:00+07:00')
     deadlineMs = new Date(dateStr + 'T05:30:00+07:00').getTime()  // 23:30 + 6h = 05:30 hôm sau
     (nếu đã > 23:59:59 hôm nay → vẫn dùng 05:30 hôm sau; scheduled run đêm luôn đúng)
  5. runComprehensiveCheck({trigger:'cron-nightly', deadlineMs})
  6. update cronJob: lastRunAt=now, nextRunAt=23:30 hôm sau (tz HN)
```
Helper múi giờ: `startOfTodayHN = new Date(dateStr + 'T00:00:00+07:00')` — chính xác bất kể server UTC.

**Vì sao 6h max:** owner directive 2026-09-01. Ca trực 23:30-05:30 đảm bảo:
- Không chồng chéo giờ hành sự ban ngày (sáng 8h owner vào dùng app → ALISTA đã xong hoặc đã bị cắt ngang graceful).
- 6h đủ cho 7 collector tuần tự + 7 LLM call (mỗi call ~30s) + buffer cho LLM retry/fallback — nếu hệ thống đầy đủ khỏe, ca trực thường kết thúc trong 5-15 phút; 6h là biên an toàn cho đêm xấu (LLM chậm, Neo4j lag, nhiều findings).

#### B3.2 Đăng ký + CronJob registry

- `src/instrumentation-node.ts` — thêm block clone mẫu Self-Direction (sau dòng ~340, cùng khối ensureDbReady + heartbeat log `[ALISTA][scheduler]` mỗi 15 tick để ops theo dõi scheduler sống).
- `ensureAlistaCronJob()` (chạy trong tick đầu, idempotent): tạo `CronJob` nếu chưa có:
  `{agentId:'alista', kind:'cron', expr:'30 23 * * *', expression:'30 23 * * *', tz:'Asia/Ho_Chi_Minh', taskPrompt:'Kiểm tra toàn diện hệ thống hàng đêm (ALISTA)...', executor:'ALISTA', scheduleJson:{mode:'day',times:['23:30'],repeat:true}, enabled:true, status:'active', nextRunAt}`.
- **Chống chạy kép có chủ đích**: `agentId:'alista'` (≠'default') → automation-engine loop B (chỉ xử lý agentId='default') bỏ qua; không set field `task` → mini-service loop A (cần task) bỏ qua. → Chỉ scheduler nền làm executor duy nhất. CronJob row vẫn hiện trong panel Automation (Smolab) để owner **pause/resume + xem nextRunAt** — điều khiển scheduler nền qua `enabled`.
- Không cần script seed riêng (ensure chạy tại boot) — nhưng vẫn giữ convention: nếu muốn seed tay: `scripts/seed-alistar-cron.ts` (mẫu seed-decay-cron.ts, `bunx tsx`).

**Kiểm chứng H3:** log `[ALISTA][scheduler] heartbeat tick #1` sau restart; `db.cronJob` có row executor='ALISTA'; test cửa sổ: đổi tạm thời điều kiện HH thành giờ hiện tại +1 phút trong môi trường dev → thấy pipeline chạy + TaskExecution sinh ra → trả lại code gốc.

---

### H4 — API routes (2-3h)

#### B4.1 `src/app/api/alista/check/route.ts`
- **POST** (maxDuration 60): body `{force?}` → nếu `force=false` và đã có check hoàn tất hôm nay → trả luôn check cũ; ngược lại spawn `runComprehensiveCheck({trigger:'manual', force})` async → **201 `{checkId, startedAt}`**.
- **GET `?checkId=`**: đọc `globalThis.__alistaChecks` → `{status: 'running'|'completed'|'failed', steps:[{id,label,status,findings,proposalCount}], proposalsCreated, durationMs, error}` — UI poll 2s.

#### B4.2 `src/app/api/alista/checks/route.ts`
- **GET `?limit=20`**: lịch sử TaskExecution type='alista-check' (mới nhất trước) — cho debug + observer.

#### B4.3 Mở rộng range cho 2 API hiện có (bảo toàn tương thích ngược — không có from/to thì hành vi cũ nguyên vẹn)

**`/api/metrics/overview`** thêm `?from=YYYY-MM-DD&to=YYYY-MM-DD` (validate: from≤to, to≤hôm nay, span ≤ 90 ngày):
- `tokens`: DailyTokenByAgent WHERE date ∈ [from..to] — groupBy agentName **sum** + timeline perDay (cho strip mini-chart tương lai).
- `tools`: ToolMetric WHERE createdAt ∈ [fromT00:00+07:00 .. toT23:59+07:00].
- `runs`: AgentRunRecord WHERE startedAt ∈ range (thêm hàm `findAgentRunRecordsBetween(from,to)` vào metrics-db.ts — clone findAgentRunRecordsSince).
- `alerts`: tính trên số liệu range; response `period:{from,to}` thay `{hours}`.

**`/api/episodic/overview`** thêm `?from=&to=`:
- episodes + recentEpisodes: filter theo timestamp (Neo4j WHERE `$from ≤ e.createdAt ≤ $to`; mirror SQLite WHERE createdAt) — bước triển khai đọc `episodic-neo4j.ts` để dùng đúng tên prop timestamp thật của node Episode.
- lessons: filter createdAt tương tự.
- errorDashboard/escalations: nếu prop timestamp tồn tại trên ErrorOccurrence → filter; không có → giữ snapshot hiện trạng + field `rangeNote` cho UI hiển thị "escalations: theo hiện trạng".
- Tất cả section fail-open như cũ.

---

### H5 — UI: xóa tab Chat & Explorer khỏi module Database (1h)

Sửa `src/app/page.tsx` (5 điểm, có số dòng đã khảo sát):

| # | Vị trí | Thay đổi |
|---|---|---|
| 1 | :18948 `useState('chat')` | → `useState('documents')` (tab đầu tiên còn lại) |
| 2 | :19437-19448 `handleTabChange` | xóa dòng :19441 nhánh `explorer` fetchEmbeddingStatus |
| 3 | :20128-20155 hiệu ứng restore tab | whitelist `['documents','analytics','token','autolearn']`, fallback `'documents'`; saved cũ 'chat'/'explorer' tự redirect sang 'documents' + persist lại (cơ chế đã từng dùng cho tab 'entities'/'relationships' bị xóa — comment :20130); xóa nhánh explorer :20148 |
| 4 | :20406-20413 TabsList | xóa 2 TabsTrigger `chat` (:20407) + `explorer` (:20408) |
| 5 | :20415-20437 | xóa 2 TabsContent `chat` + `explorer` |

**Dead code:** `ChatSection` (:1039-1281) + `KnowledgeExplorer` (:1282-2119) ~1.080 dòng → grep xác nhận 0 tham chiếu còn lại → **xóa hẳn** (giữ trang nhẹ, lint sạch). Icon `MessageCircle/Target` vẫn dùng chỗ khác — giữ import. `globals.css:607/609` rule rỗng — để nguyên (an toàn).

**Ghi chú UX:** chức năng chat KHÔNG mất — nó vẫn đầy đủ ở module **Smolab** (Single Agent Chat). Module Database giờ thuần dữ liệu: Tài liệu · Analytics · Token · Auto-Learn.

**Kiểm chứng H5:** reload → 4 tab; localStorage cũ 'chat' → tự về 'documents'; link nội bộ không vỡ; typecheck + lint sạch.

---

### H6 + H7 — UI: nút Kiểm tra toàn diện + bộ chọn khoảng ngày (2-3h)

#### B6.1 Toolbar EpisodicMemoryPanel (`src/components/analytics/episodic-memory-panel.tsx`, chèn sau `</Button>` dòng 426 — kết quả: `[Làm mới][Chạy decay][🛡 Kiểm tra toàn diện][📅 Từ ngày–đến ngày]` cùng hàng, flex-wrap an toàn mobile)

**Nút Kiểm tra toàn diện** — pattern fire-and-forget + poll (như Run Eval):
```tsx
<Button variant="outline" size="sm" className="h-8 text-xs border-teal-700/60 bg-teal-950/40 text-teal-300 hover:bg-teal-900/40 hover:text-teal-200"
        onClick={handleAlistaCheck} disabled={alistaRunning}>
  {alistaRunning ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <ShieldCheck className="h-3.5 w-3.5 mr-1.5" />}
  Kiểm tra toàn diện
</Button>
```
Handler: `POST /api/alista/check` → `{checkId}` → poll `GET ?checkId=` mỗi 2s (tối đa 300s) → hoàn tất: `toast.success('Kiểm tra toàn diện hoàn tất', {description: 'X đề xuất mới đã gửi tới Self-Direction · Y nguồn dữ liệu · Z giây'})` + `fetchData()` mới. Lỗi → `toast.error` (sonner — panel đã dùng). Chạy xong tự động dữ liệu Self-Direction module cập nhật (poll 4s sẵn có).

**Bộ chọn khoảng ngày** — Popover + Calendar `mode="range"` (thư viện sẵn):
```tsx
<Popover>
  <PopoverTrigger asChild>
    <Button variant="outline" size="sm" className="h-8 text-xs border-stone-700 bg-stone-900/60 ...">
      <CalendarIcon className="h-3.5 w-3.5 mr-1.5" />
      {analyticsRange ? `${format(from,'dd/MM')} → ${format(to,'dd/MM')}` : 'Từ ngày – đến ngày'}
    </Button>
  </PopoverTrigger>
  <PopoverContent className="w-auto p-0" align="start">
    <Calendar mode="range" selected={rangeDraft} onSelect={setRangeDraft}
              numberOfMonths={1} disabled={{ after: new Date() }} />
    <div className="p-2 border-t border-stone-800 flex justify-between">
      <Button size="sm" variant="ghost" onClick={clearRange}>Xóa khoảng</Button>
      <Button size="sm" disabled={!rangeDraft?.from || !rangeDraft?.to} onClick={applyRange}>Xem dữ liệu</Button>
    </div>
  </PopoverContent>
</Popover>
```

#### B6.2 State chia sẻ (lift lên page.tsx)

`const [analyticsRange, setAnalyticsRange] = useState<{from:string; to:string} | null>(null)` tại page.tsx — truyền `{analyticsRange, onAnalyticsRangeChange}` xuống EpisodicMemoryPanel (vẽ picker) và `{analyticsRange}` xuống RuntimeMetricsPanel.

#### B7 Range-aware panels (2 panel)

| Panel | Khi `analyticsRange = null` (live — mặc định) | Khi có range (chế độ lịch sử) |
|---|---|---|
| EpisodicMemoryPanel | poll 15s `/api/episodic/overview` (như cũ) | fetch **một lần** `/api/episodic/overview?from=&to=`, **dừng poll**; badge xanh `📜 Đang xem 21/08 → 31/08 (lịch sử) · ✕` cạnh dòng poll-status; bấm ✕ → clear range → poll sống lại |
| RuntimeMetricsPanel | poll 10s `/api/metrics/overview?hours=24` | fetch `/api/metrics/overview?from=&to=`, dừng poll, badge tương tự; tiêu đề "Tool health (24h)" → "Tool health (khoảng đã chọn)" |

Badge dùng nút nhỏ `variant ghost` + icon X — touch target ≥ 32px.

---

### H8 — Kiểm thử, bàn giao, push (1-2h)

1. **Tĩnh:** `bun run lint` + `bun run typecheck` (tsc --noEmit) — 0 lỗi.
2. **PM2 restart** (`pm2 restart theopusflashlite`) → kiểm chứng chuỗi:
   - `/api/agents` → 8 agents có ALISTA 🛠️
   - Log `[ALISTA][scheduler]` heartbeat xuất hiện
   - `db.cronJob` có row executor 'ALISTA', nextRunAt đúng 23:30 hôm sau
   - `POST /api/alista/check` → poll đến completed → `GET /api/self-direction/proposals` thấy proposals `createdBy:'ALISTA'` đủ 4 phần
   - **Chạy lần 2 liên tiếp** → dedupe hoạt động (không proposal trùng key còn sống)
3. **Agent Browser E2E (bắt buộc — chuẩn hoàn thành của sandbox):**
   - Module Database: đúng 4 tab, không Chat/Explorer, tab lưu cũ chuyển hướng an toàn
   - Analytics: 4 control trên cùng hàng toolbar đúng thứ tự
   - Bấm **Kiểm tra toàn diện** → spinner → toast kết quả → mở module Self-Direction thấy đề xuất ALISTA
   - Chọn khoảng 21/08→31/08 → cả 2 panel đổi sang dữ liệu lịch sử + badge; ✕ → live trở lại
   - 0 console error; footer/sticky; responsive (thu hẹp viewport — toolbar wrap đẹp)
4. **Giờ 23:30 thật:** để scheduler tự chạy đêm đầu — sáng hôm sau kiểm TaskExecution 'alista-check' + proposals (acceptance cuối).
5. **Push GitHub** (token sẵn): commit `feat(alista): agent ALISTA + pipeline kiểm tra toàn diện 23h30 + UI Analytics (xóa Chat/Explorer, nút Kiểm tra toàn diện + range picker)`.
6. **Cập nhật worklog** theo quy ước Task ID.

---

## 4. LỘ TRÌNH & ƯỚC LƯỢNG

| Giai đoạn | Nội dung | Thời lượng | Phụ thuộc |
|---|---|---|---|
| G1 | H1 agent profile + màu + seed | 0.5h | — |
| G2 | H2 pipeline backend (collectors→rules→proposals→check) | 3-4h | G1 (persona cho LLM) |
| G3 | H3 scheduler + cron registry + instrumentation | 1h | G2 |
| G4 | H4 API (alista routes + range params 2 API) | 2-3h | G2 (G1-G3 song song được) |
| G5 | H5 xóa tab Chat/Explorer | 1h | độc lập — chạy song song G2 |
| G6 | H6+H7 UI toolbar + range panels | 2-3h | G4 |
| G7 | H8 verify E2E + push | 1-2h | tất cả |
| **Tổng** | | **≈ 10-13h** (~1,5 ngày làm việc tập trung) | |

G2 và G5 có thể giao 2 subagent song song (backend pipeline ∥ UI tab removal); G4 + G6 gộp chạy tiếp.

---

## 5. LUỒNG PHẢN HỒI KÍN — FOLLOW-UP VERIFICATION (v1.2 MỚI)

> Owner directive (2026-09-01): *"Mỗi đề xuất xử lý của ALISTA gửi đến module SELF-DIRECTION nếu được phê duyệt và xử lý hoàn tất thì ngay khi hoàn tất, thông tin đề xuất đó đã hoàn thành phải được chuyển tới ALISTA ngay. ALISTA khi nhận được thông tin cần xác nhận vấn đề đề xuất đã được xử lý hoàn tất chưa, hay vẫn chưa được xử lý triệt để. Nếu xác định được vẫn tồn tại vấn đề (dù là vấn đề khác) hoặc xác định được cần nâng cấp thì sẽ tiếp tục gửi lại đề xuất mới luôn."*

### 5.1. Kiến trúc vòng lặp

```
┌─ ALISTA ──────────┐   đề xuất (pending)    ┌─ SELF-DIRECTION ─────┐
│  ca trực 23h30 /   │ ─────────────────────> │  owner/Opus phê duyệt │
│  Kiểm tra toàn diện│                        │  orchestrator thực thi │
└────────────────────┘                        └──────────┬───────────┘
      ▲                                                 │ status='completed'
      │ (2) notify NGAY                                            │
      │     hook in-process: runOrchestrationInner() ──────────────┘
      │     fast-path: executeAutomationProposal()
      │     lưới an toàn 60s: sweep trong alistaTick
      │                                                 
      │ (3) re-run ĐÚNG collector của đề xuất đó                
      │     (parse key [ALISTA] <slug>:<target>:<yyyymm> từ title)
      ├──────────────────────────────────────────────────────────
      │
      ├─ findings sạch → resolved=true → "ĐÃ XỬ LÝ TRIỆT ĐỂ" ✅ (đóng vòng)
      │
      └─ còn findings (vấn đề gốc HOẶC phát hiện mới trong cùng check)
            → gửi ĐỀ XUẤT MỚI NGAY:
            · key follow-up `<base>:v<N>` (N = số proposal cùng base đã có)
            · prefix problem "⟲ FOLLOW-UP — Đề xuất gốc #<id> ... đã được
              phê duyệt và xử lý hoàn tất (...), nhưng ALISTA xác minh lại
              thấy vấn đề CHƯA được xử lý triệt để" (hoặc "phát hiện VẤN ĐỀ MỚI")
            · dedupe LIVE 7 ngày theo BASE key (gốc + follow-up chặn nhau)
            → quay lại đầu vòng lặp (tự duy trì đến khi triệt để)
```

### 5.2. Cơ chế bảo vệ (an toàn kép + chống spam)

| # | Cơ chế | Chi tiết |
|---|---|---|
| 1 | **Hook in-process (tức thời)** | 2 call-site: `orchestrator.ts runOrchestrationInner` (luồng agent chuẩn) + `automation-proposals.ts executeAutomationProposal` (fast-path automation). Dynamic import chống circular; fail-open tuyệt đối |
| 2 | **Sweep 60s (lưới an toàn)** | Mỗi tick alistaTick quét đề xuất completed trong 48h chưa verify → notify. Bắt mọi trường hợp hook lỡ (restart giữa chừng, import fail...). Delay tối đa 60s |
| 3 | **Dedupe 3 tầng** | In-memory 10' (chống hook-spam) + TaskExecution `alista-verify` completed (durable, theo jobId=proposalId) + in-flight guard 20'+5' |
| 4 | **Budget verify 20 phút** | Re-check 1 check (không phải 7) — ngắn hơn ca trực. Collector timeout 5'. Trượt budget → ca trực 23h30 xử lý lại |
| 5 | **Conservative khi fail** | Collector fail / key không parse được / check ⑥ (gắn ca trực cụ thể) → `resolved=null` — KHÔNG kết luận mù, KHÔNG tạo proposal mù |
| 6 | **Zombie sweep** | Row `alista-verify` kẹt 'running' quá budget+5' (process chết giữa verify) → đánh dấu failed → sweep verify lại |
| 7 | **Follow-up key sequencing** | `<base>:v<N>` — N đếm từ số proposal cùng base prefix (gốc + v1..v(N-1)) → không đè số |
| 8 | **Dedupe follow-up chéo** | Proposal gốc còn sống (pending) chặn finding cùng vấn đề — ví dụ thực tế: verify mirror_lesson_drift tìm thấy MỚI mirror_episode_drift nhưng bị chặn vì proposal gốc mirror_episode_drift còn pending |

### 5.3. Trạng thái lưu trữ (không cần model mới)

`TaskExecution` `type='alista-verify'`, `jobId=<originalProposalId>`, `result` JSON:
`{ resolved: boolean|null, findingsAfter: [{key,target,priority}], stillOriginalIssue: boolean, newProposals: [{id,title}], skippedProposals: [{title,reason}], trigger: 'completion-hook'|'sweep', originalKey, checkId, note, durationMs }`

Hiển thị: UI Analytics → section **"ALISTA — Hoạt động"** (poll 60s) + API `GET /api/alista/checks` (trả cả 2 loại `kind:'check' | 'verify'`).

### 5.4. E2E đã verify (2026-09-01 12:55 VN)

1. Đề xuất `[ALISTA] db:mirror_lesson_drift:202609` đánh dấu completed (mô phỏng phê duyệt + xử lý hoàn tất)
2. Sweep 60s tick bắt trong vòng 1 tick → log `[ALISTA][verify] Nhận thông tin: đề xuất #... đã HOÀN TẤT (sweep)`
3. Verify re-run collector ⑦ → 2 findings còn (mirror_lesson + mirror_episode) → `resolved=false, stillOriginalIssue=true`
4. Gửi NGAY follow-up `[ALISTA] db:mirror_lesson_drift:202609:v2 — Đồng bộ LessonRecord mirror từ Neo4j` (problem có prefix ⟲ FOLLOW-UP đầy đủ ngữ cảnh + thời gian hoàn tất 12:55 01/09/2026 giờ VN)
5. Finding mirror_episode_drift bị dedupe chặn (proposal gốc còn sống) — đúng thiết kế
6. TaskExecution `alista-verify` completed với đầy đủ result JSON; UI + API hiển thị đúng

---

## 5b. RỦI RO & DỰ PHÒNG

| # | Rủi ro | Dự phòng |
|---|---|---|
| 1 | LLM synthesis lỗi/rớt mạng lúc 23h30 | Template fallback từ evidence — pipeline luôn hoàn tất (fail-safe 2 tầng) |
| 2 | Spam đề xuất mỗi đêm | Dedupe key theo tuần + proposal còn sống; cap ≤6/run, ≤3/tool, ≤2/run-check |
| 3 | Scheduler + UI loop chạy kép | agentId:'alista' tách khỏi 2 loop hiện có + gate 1-lần/ngày |
| 4 | Server chạy UTC lệch giờ VN | Toàn bộ logic giờ qua Intl tz 'Asia/Ho_Chi_Minh' tường minh |
| 5 | ~(đã loại trừ)~ Sandbox reset | **v1.1 — owner chạy máy local, không sandbox reset.** ALISTA + CronJob + scheduler vẫn idempotent (tự tái lập khi restart app/PM2) — giữ an toàn cho restart có chủ ý |
| 6 | Xóa 1.080 dòng dead code vỡ tham chiếu ẩn | Grep toàn bộ trước khi xóa + typecheck + lint làm cổng |
| 7 | page.tsx 21k dòng chỉnh sai chỗ | Chỉ sửa theo số dòng đã khảo sát + diff review + E2E |
| 8 | Neo4j Episode không có prop timestamp để filter range | Bước triển khai đọc schema Cypher thật (episodic-memory.cypher) — nếu thiếu thì episodes range-filter bằng mirror SQLite createdAt + note nguồn; không block |
| 9 | Kiểm tra đêm trượt cửa sổ (server down 23:30-23:59) | Cửa sổ 30 phút rộng; nếu trượt hẳn → đêm đó bỏ qua, đêm sau chạy lại (v1.1 — owner local có thể start lại app bất cứ lúc nào trong cửa sổ; nếu app sống cả đêm thì chắc chắn chạy) |
| 10 | owner muốn đổi giờ trực hoặc budget | Sửa 2 chỗ: `expression` + window check trong alista-scheduler.ts (HH/mm) + `deadlineMs` ở bước 4 (05:30 → giờ khác). Hoặc pause CronJob trong UI Automation |
| 11 | **(v1.1 MỚI)** Pipeline chạy quá 6h không kịp | Deadline cứng `deadlineMs` re-check sau mỗi collector + sau mỗi LLM call → cắt ngang graceful, ghi `partialSteps`. Owner đọc TaskHistory thấy rõ. Ca trực bị cắt ngang không phải lỗi — là an toàn chủ động (owner directive rõ ràng) |
| 12 | **(v1.1 MỚI)** LLM call tuần tự 7 lần kéo dài > 6h | Mỗi LLM call có `withTimeout(60_000)` riêng (đã có pattern từ scan.ts); timeout → dùng fallback template từ evidence ngay lập tức → không kẹt |
| 13 | **(v1.2)** Mini-service cron tick bắn nhầm row ALISTA (task rỗng → 400 → retry → row 'failed' → giết ca trực) | ĐÃ FIX: `tickCronScheduler` filter `executor=''` + `executeCronJob` guard executor riêng; ensureAlistaCronJob self-heal status='failed' + nextRunAt |
| 14 | **(v1.2)** Chạy manual ban ngày làm ếch ca trực 23h30 | ĐÃ FIX: gate 1-lần/ca chuyển sang CronJob.lastRunAt (không theo TaskExecution alista-check như v1.1) |
| 15 | **(v1.2)** PM2 restart với env shell nhiễm (DATABASE_URL shell trỏ DB khác) | ĐÃ FIX: guard trong `scripts/pm2-start.sh` luôn ép DATABASE_URL về DB của tmo-app; PHÙ THUỘC: đừng dùng `pm2 restart --update-env` trực tiếp từ shell có env lạ |
| 16 | **(v1.2)** Hook completion fail (dynamic import lỗi, restart giữa chừng) | Sweep 60s bắt lại trong ≤60s — đã verify E2E qua đường sweep; hook in-process vẫn là đường tức thời chính |
| 17 | **(v1.2)** Vòng lặp follow-up tự nhân bản (spam vô hạn) | Dedupe theo BASE key 7 ngày (gốc + mọi follow-up chặn nhau) + chỉ re-run khi nhận notify completed mới + cap sweep 3 proposal/tick |

---

## 6. TIÊU CHÍ NGHIỆM THU (Acceptance Checklist v1.1 + v1.2)

- [ ] Agents panel: **8 agents**, ALISTA 🛠️ standalone, isSystem
- [ ] ALISTA có system prompt **7 nhiệm vụ** + chuẩn đề xuất 4 phần; tool whitelist bảo trì
- [ ] **23h30 (giờ VN) hàng ngày**: scheduler nền tự chạy → TaskExecution 'alista-check' + proposals (chứng nhận qua đêm đầu + log)
- [ ] **Budget 6h**: pipeline có `deadlineMs` re-check sau mỗi collector + sau mỗi LLM call; trượt deadline → graceful partial + ghi rõ `partialSteps`
- [ ] **Tuần tự**: 7 collector chạy ①→⑦ lần lượt, KHÔNG dùng Promise.all trong pipeline (chỉ trong sub-collector ⑦ nếu cần); mỗi bước: collect → rules → LLM proposal → TaskExecution step ngay tại bước
- [ ] **Nhiệm vụ ⑦ (v1.1 MỚI)**: collector ⑦ có 7 sub-check (a-g) kiểm tra Database + Memory + Learning, có rule + đường đề xuất (bảng B2.2 mục ⑦)
- [ ] 7 nhiệm vụ đều có collector + rule + đường đề xuất đúng category/priority (bảng B2.2)
- [ ] Đề xuất ALISTA xuất hiện trong module Self-Direction (source 'agent') đủ 4 phần, tiếng Việt, có số liệu chứng cứ
- [ ] Dedupe: chạy kiểm tra 2 lần/ngày không sinh proposal trùng key còn sống
- [ ] Nút **Kiểm tra toàn diện**: spinner → toast (X đề xuất, Y nguồn, Z giây, deadlineMet/deadlineReached) — không chờ 23h30
- [ ] Module Database còn **4 tab** (Tài liệu/Analytics/Token/Auto-Learn), default Tài liệu, saved-tab cũ redirect an toàn
- [ ] Toolbar Analytics: `[Làm mới][Chạy decay][Kiểm tra toàn diện][Từ ngày–đến ngày]` cùng hàng, bên phải Chạy decay
- [ ] Chọn khoảng ngày → RuntimeMetrics + EpisodicMemory chuyển chế độ lịch sử (badge + nút ✕), API trả đúng period; xóa khoảng → poll live trở lại
- [ ] `bun run lint` + `tsc --noEmit` sạch; Agent Browser E2E 0 console error; responsive
- [ ] Code push GitHub main + worklog cập nhật

### v1.2 — Hậu triển khai + feedback loop

- [x] **Rà soát hậu triển khai:** phát hiện + fix 10 lỗi (mục 7)
- [x] **Hook hoàn tất:** 2 call-site (orchestrator + automation fast-path) notify ALISTA ngay khi proposal completed — dynamic import chống circular, fail-open
- [x] **Sweep 60s:** lưới an toàn bắt đề xuất completed 48h chưa verify (delay tối đa 60s) — E2E verified qua đường này
- [x] **Verify re-run collector:** parse key từ title → re-run ĐÚNG check → rules → so findings (đã verify: check ⑦, 2 findings còn)
- [x] **Đề xuất follow-up NGAY:** key `<base>:v2` + prefix ⟲ FOLLOW-UP + ngữ cảnh đề xuất gốc — E2E verified
- [x] **Dedupe chặn trùng:** finding trùng proposal còn sống bị skip (E2E: mirror_episode_drift bị chặn đúng)
- [x] **Conservative khi không kết luận được:** collector fail / check ⑥ → resolved=null, không tạo proposal mù
- [x] **Zombie sweep:** row verify kẹt 'running' quá budget+5' → failed → sweep verify lại
- [x] **API:** `/api/alista/checks` trả cả check + verify (kind, verify info đầy đủ)
- [x] **UI:** section "ALISTA — Hoạt động" hiển thị cả 2 loại, badge resolved (✅/⟲/—), findings, đề xuất mới — Agent Browser + VLM verified
- [x] **typecheck + lint sạch; E2E browser 0 console error**
- [x] **DB env guard:** pm2-start.sh ép DATABASE_URL đúng (fix lỗi thật gặp phải)

---

## 7. RÀ SOÁT HẬU TRIỂN KHAI — 10 FIX v1.2 (2026-09-01)

| # | Lỗi phát hiện | Fix |
|---|---|---|
| 1 | **Mini-service cron tick giết ca trực 23h30:** `tickCronScheduler` query mọi row active (kể cả executor='ALISTA') → POST task rỗng → 400 → 3 retry → row thành 'failed' → scheduler nền thấy status≠active → ca trực bị giết âm thầm | Filter `executor: ''` trong query + guard `executeCronJob` từ chối row có executor riêng |
| 2 | **Chạy manual ban ngày làm ếch ca 23h30:** gate 1-lần/ngày theo TaskExecution 'alista-check' hôm nay — manual ban ngày cũng tạo row này → đêm đó skip | Gate chuyển sang `CronJob.lastRunAt` so với shiftStart của anchor |
| 3 | **Mất ca nếu server down 23:30-23:59 rồi up lại:** cửa sổ chỉ 30' (23:30-23:59) | Mở rộng cửa sổ catch-up 23:30 → 05:30+1 (anchor = hôm qua khi chạy trong khung 00:00-05:30), cần ≥30' budget còn |
| 4 | **CronJob row 'failed' không tự lành:** mini-service cũ có thể đã đánh fail trước fix #1 | `ensureAlistaCronJob` self-heal cả status='failed' + nextRunAt sai lệch (v1.2b: canh về "23:30 VN kế tiếp") |
| 5 | **nextRunAt hiển thị sai ban ngày:** computeNextRunAt luôn trả "hôm sau 23:30" dù tối nay 23:30 chưa tới | Tính đúng: chưa tới 23:30 hôm nay → tối nay; đã qua → mai |
| 6 | **Collector treo phơ deadline:** không timeout từng collector | `runCollectorFor` bọc `withTimeout(5')` từng collector (cả trong verify) |
| 7 | **RAM phình vô hạn:** globalState Map giữ mọi lần chạy (snapshot dữ liệu lớn) | Eviction giữ 30 entry mới nhất |
| 8 | **Chạy đè (manual + nightly):** không có in-flight guard toàn pipeline | `isAlistaCheckInFlight()` globalThis + API POST trả 202 alreadyRunning + clearInFlight trong finally |
| 9 | **Rule "domain >30 ngày" đo sai:** props Neo4j là snake_case (updated_at) — query camelCase luôn null | Query dùng `e.updated_at, e.created_at` + xử lý DateTime native |
| 10 | **UI poll leak + budget poll sai:** poll chạy 300s sau unmount (setState trên component chết); budget poll 300s < pipeline 600s | mountedRef + budget 660s + abort khi unmount |
| + | **PM2 env nhiễm (gặp khi verify):** `pm2 restart --update-env` hấp thụ DATABASE_URL shell → app trỏ DB khác (schema lệch, scheduler mù) | Guard `scripts/pm2-start.sh` ép DATABASE_URL về DB tmo-app; dọn row rác ở DB nhầm |

---

*Hết kế hoạch v1.2 — đã triển khai + E2E verify toàn bộ (kể cả feedback loop). Obi.*

## 8. ALISTA v1.3 — TIÊU CHÍ XÁC NHẬN HIỆU QUẢ + ĐỦ PHỦ NGUỒN DỮ LIỆU (2026-09-01)

> **Bối cảnh:** owner hỏi ALISTA đã đủ công cụ chẩn đoán/đánh giá với nguồn dữ liệu rõ ràng + tiêu chí xác
> nhận hiệu quả chưa — có cần xây thêm tools/chức năng không. Kết quả audit chi tiết:

### 8.1. Kết quả audit năng lực (trước v1.3)

| Yêu cầu | Hiện trạng v1.2 | Đánh giá |
|---|---|---|
| Chẩn đoán chính xác, chống ảo giác | 7 collectors fail-open + rules deterministic (LLM không quyết priority/category) + evidence structured | ✅ Đủ |
| Nguồn dữ liệu rõ ràng | ⑤ chỉ 4/6 services (thiếu R2 + Supabase); không check disk, LLM key, scheduler health | ⚠️ Khoảng trống |
| Tiêu chí xác nhận hiệu quả rõ ràng | Verify binary (findings=0 → resolved); verify NGAY khi hoàn tất | ⚠️ Khoảng trống nghiêm trọng |
| Vấn đề dai dẳng | Không track tái diễn — mỗi ca trực là island | ⚠️ Khoảng trống |

**Lỗ hổng "verify NGAY" (nghiêm trọng nhất):** tool successRate tính trên cửa sổ 7 ngày — fix deploy xong,
verify NGAY → các lần gọi lỗi CŨ vẫn nằm trong cửa sổ → finding vẫn trigger → follow-up "CHƯA triệt để"
SAI (false-negative) → spam đề xuất. Tương tự: mirror drift cần backfill chạy, backlog cần review thủ công,
domain entity cần nạp tài liệu.

### 8.2. Bổ sung v1.3 (4 hạng mục)

**H1 — SuccessCriteria có cấu trúc (P0):**
- `Finding.successCriteria: { metric, current, target, operator(gte|lte|eq), recheckAfterMs, recheckWhy }`
- Rules điền đầy đủ cho mọi finding; text format vào proposal: `🎯 TIÊU CHÍ XÁC NHẬN HIỆU QUẢ (ALISTA tự
  kiểm định): metric "X" từ mức hiện tại Y phải đạt [≥|≤|=] Z. ALISTA sẽ đo lại sau N (lý do).`
- Nguồn truth duy nhất cho recheck window: `types.ts RECHECK_DEFAULTS_MS / RECHECK_TARGET_OVERRIDES_MS
  / recheckWindowFor(slug, target)` — rules + verify loop đọc cùng map (không lệch nhau).

**H2 — Deferred verification theo recheck window (P0):**
- `notifyAlistaProposalCompleted` vẫn nhận thông tin NGAY (hook + sweep) — nhưng verify loop quyết:
  - recheck=0 (connectivity, zombie, schema drift...) → verify NGAY như v1.2
  - recheck>0 → **HOÃN** đến `dueAt = completedAt + recheckAfterMs`, tạo marker
    `TaskExecution {type:'alista-verify-deferred', status:'pending', result:{dueAt, why, recheckAfterMs}}`
    (durable qua restart — chống false-negative)
- Sweep 60s thêm bước (0b): deferred marker đến hạn → đánh dấu superseded → gọi verify TRỰC TIẾP với
  `skipDefer=true` (bỏ tính lại dueAt — quyết định "đến hạn" đã đưa ra 1 lần, chống vòng lặp
  defer→activate→defer nếu completedAt/map đổi giữa chừng). Bước (1b): bỏ qua proposal đang có marker
  pending (chưa đến hạn) — chống notify vô ích mỗi tick.

**H3 — Độ phủ nguồn dữ liệu 6/6 + "ai canh những người canh" (P0/P1):**
- ⑤ `infra` block mới: R2 health (checkR2Health), Supabase health (checkSupabaseHealth), số
  NVIDIA_API_KEY configured (1-4), disk usage (fs.statfs — volume chứa SQLite + Qdrant storage).
- Rules ⑤ mới: R2 disconnected (đã configure) → high; Supabase disconnected → medium; 0 NVIDIA key →
  critical; disk free <30% → medium, <15% → high.
- ⑦ sub-check (h) mới — Scheduler health: CronJob enabled+active nhưng nextRunAt trễ >1h → high
  (scheduler chết — auto-learn/sync/decay cron ngầm không ai phát hiện); JobQueue stuck running >1h →
  medium; pending >50 & oldest >24h → medium; failed >10/24h → medium. Cap ⑦ nâng 4 → 5.

**H4 — Recurrence tracking (P2):**
- Trước khi tạo proposal: query 1 lần toàn bộ proposal ALISTA (mới nhất trước) → group theo base key
  prefix → `recurrence count + lastProposedAt`.
- Problem prefix: `⚠ TÁI DIỄN (lần đề xuất thứ N cho cùng vấn đề — lần gần nhất DD/MM giờ VN...)`.
- Bump priority deterministic (KHÔNG qua LLM): recurrence ≥2 → tối thiểu medium; ≥4 → tối thiểu high.
  Bump áp cả scheduleAt (high/critical → 08:00 hôm sau).

### 8.3. Sửa bug E2E phát hiện trong quá trình test (2 bug thật)

| # | Bug | Fix |
|---|---|---|
| 1 | Đường kích hoạt deferred đến hạn gọi `notifyAlistaProposalCompleted` → bị in-memory NOTIFIED dedupe 10' chặn (mốc còn fresh từ lúc defer) → verify không bao giờ chạy | Sweep (0b) gọi `runFollowUpVerification(jobId, 'sweep', skipDefer=true)` TRỰC TIẾP — bypass notify (các check durable đã qua marker) |
| 2 | Verify được gọi từ đường kích hoạt vẫn tính lại dueAt từ `completedAt + recheck` — nếu giá trị đổi giữa chừng (re-complete, map mới) → defer lại → vòng lặp defer→activate→defer | Tham số `skipDefer=true` từ đường kích hoạt — quyết định "window đã hết" chỉ đưa ra 1 lần bởi sweep |

### 8.4. E2E verify v1.3 (đã thực hiện)

1. **Manual comprehensive check (force):** 7/7 bước completed, 205.8s — collector ⑤ trả dữ liệu infra THẬT
   (R2 connected 1 object, Supabase connected 24 tables, 4 NVIDIA keys, disk 51% free); ⑦ scheduler sạch
   (0 stuck/0 backlog); mọi finding có 🎯 successCriteria; 0 proposal mới (dedupe chặn đúng — các
   proposal v1.2 còn sống).
2. **Defer flow:** tạo proposal test completed → sweep bắt trong ≤60s → log "HOÃN xác minh đến 15:30 02-09
   giờ VN (số occurrence/resolution cần thời gian...)" + marker pending với dueAt 24h + why ✓
3. **Activation flow (sau 2 fix bug):** đẩy dueAt về quá khứ → sweep kích hoạt → verify thật chạy → row
   completed `resolved=false, stillOriginal=true`, 2 findings, follow-up bị dedupe chặn đúng (đã có
   proposal sống) → trạng thái cuối sạch (0 pending marker — không vòng lặp) ✓
4. **UI:** tab Database > Analytics — section ALISTA render row "⏳ Hoãn xác minh đề xuất #... — badge
   'chờ đến hạn' + 'hẹn đo lại 08:46 03-09' + 'recheck +48h' + 're-check 7/7' + lý do hoãn ✓; console
   0 error; mobile 390px render OK; dữ liệu test đã dọn sạch.
5. **Agent seed:** ALISTA row trong DB cập nhật instruction v1.3 (8.204 chars — thêm mục ⑤ 6/6, ⑦-h,
   🎯 tiêu chí, vòng phản hồi + hoãn xác minh) qua script 1 lần (forceReseed toàn bộ agents sẽ đè
   customizations — không dùng).

### 8.5. Cấu trúc recheck window (tóm tắt)

| Nhóm | Window | Lý do chính |
|---|---|---|
| Connectivity (Qdrant/Neo4j/R2/Supabase/llm_keys), zombie, schema_drift | 0 (verify NGAY) | metric phản ánh tức thời |
| tool successRate | 72h | lỗi cũ cần rơi khỏi cửa sổ 7d |
| run pattern | 24h | cần run kế tiếp xác nhận |
| domain coverage | 7d | nạp tài liệu + extraction |
| mirror drift | 48h | backfill cần chạy |
| backlog review (writeback/lessons) | 48h | review thủ công |
| token anomaly | 72h | pattern cần bình thường hoá |
| cron_stuck / autolearn_pending_stuck | 1h | self-heal nhanh qua tick |

---

## 9. RÀ SOÁT HẬU TRIỂN KHAI v1.3 — ROUND 2 (2026-09-01 16:00 VN)

Owner yêu cầu kiểm tra lại toàn bộ sau khi 4 khoảng trống đã xử lý. Kết quả:
**hạ tầng + logic ĐẦY ĐỦ hoạt động E2E; phát hiện và sửa 2 thiếu sót còn lại (UI + code dư).**

### 9.1. Những gì ĐÃ VERIFY (không có lỗi)

| Hạng mục | Phương pháp | Kết quả |
|---|---|---|
| Git/PM2/log | git status + pm2 + dev.log | working tree sạch, a07b652 pushed, app online, 0 sweep fail từ restart |
| Typecheck + lint | tsc --noEmit + eslint | PASS |
| DB state | script `inspect-alistadb.ts` (read-only) | 6 proposal thật (5 pending + 1 completed), 0 E2E leftover, 0 zombie, CronJob nextRunAt đúng 23:30 tối nay |
| H1 criteria | phân tích rules.ts bằng parser | 39/39 call sites thật đều có successCriteria (2 site check ⑥ cố ý không có — không re-check được, guard sẵn) |
| H3 infra | E2E manual check bước ⑤ | R2 connected 1 object, Supabase 24 tables, 4 NVIDIA keys, disk 50.4% free, Qdrant 3 collections, Neo4j 78300 nodes — 6/6 services |
| H4 recurrence | code review | query 1 lần group base key + prefix ⚠ TÁI DIỄN + bump deterministic (≥2→medium, ≥4→high) |
| Manual check E2E | POST /api/alista/check force=true | 7/7 bước completed, deadlineMet, 218.4s, mọi finding có 🎯 criteria, 0 proposal mới (dedupe chặn đúng vì 5 proposal LIVE) |
| Vòng lặp kín E2E | script tạo proposal test → sweep → defer → force dueAt → activation → verify → dọn | PASS toàn bộ: defer marker 24h đúng why; sweep kích hoạt ≤75s; verify checkId=3 resolved=false stillOriginal=false; dedupe chặn follow-up; marker superseded; **0 leftover sau cleanup** |

### 9.2. Hai thiếu sót phát hiện & đã sửa

1. **BUG UI (thật, thấy bằng mắt owner):** panel "ALISTA — Hoạt động" render per-step badge
   so `s.status !== 'ok'` — nhưng pipeline dùng vocabulary `completed|partial|failed|skipped`
   → MỌI bước chạy tốt đều hiện badge ĐỎ "lỗi" (misleading). FIX: chỉ render badge khi
   bước failed/skipped/partial HOẶC findings > 0; healthy step không badge; badge amber =
   "N findings", stone = "bỏ qua/một phần", rose = "lỗi" thật. Đã verify lại bằng browser:
   giờ chỉ hiện "Escalations: 2 findings / Domain coverage: 1 findings / Database + Memory: 2 findings".
2. **Code dư:** `VerifyOutcome` interface bị khai báo TRÙNG 2 lần trong proposal-verify.ts
   (leftover khi edit — TS merge được nên không crash, nhưng là mảnh vụn). FIX: gộp còn 1
   khai báo duy nhất có field `deferred?`.

### 9.3. Quan sát vận hành (không phải bug — đã có fail-safe)

- **kimi-k3 (NVIDIA) timeout 60s mỗi LLM call trong ca check** (endpoint chậm lúc 15-16h VN):
  fallback chain tự chuyển z-ai-sdk (`nguồn=zai`) — proposal vẫn sinh đúng; mỗi check có
  findings mất thêm ~60s chờ timeout. Đêm qua kimi hoạt động bình thường (check 04:31 dùng
  kimi). Không cần xử lý — budget ca trực 6h dư sức.
- Script ops mới: `scripts/inspect-alistadb.ts` — audit read-only DB state ALISTA
  (proposals/markers/zombie/cron/agent instruction) cho các lần rà soát sau.

---

*Hết kế hoạch v1.3 + rà soát round 2 (2 fix bổ sung). Obi.*
