# BIÊN BẢN QUAN SÁT LƯỢT 7 (R16) — MẤT ỔN ĐỊNH DƯỚI TẢI RUN · SỔ NỢ TRẮNG · HAI NGUỒN SỰ THẬT TÀI LIỆU

- **Ngày quan sát:** 2026-10-20 (02:24 – 02:40 UTC)
- **Người quan sát:** Z.ai Code (main session — giao thức Giáo thức Thầy truyền lại + nguyên tắc "đo trước khi cắt")
- **Yêu cầu user:** "Kích hoạt giao thức quan sát cho tôi" (lượt 6 khép tại R13; từ đó hệ thống đã qua thêm R14 SubAgentSlot tuần tự + R15 khung quyết định concurrency/đài quan sát slotPool + REQ-AUDIT 4 fix + BLUEPRINT-BACKUP-GATE W1+W2 + gỡ legacy dual-write 3ef2f4c)
- **Phương pháp:** đo live trực tiếp (SQLite/Qdrant/R2 qua API + sqlite3), theo dõi run goal-loop ĐANG CHẠY trong real-time (Omega 02:22–02:35), browser observation (agent-browser: console errors + panel UI), phân tích request log + boot log, đối chiếu code đường ghi nợ (agent-goal-loop.ts 3 call sites).

---

## 1. TÓM TẮT EXECUTIVE

Lượt này bắt được **sự cố đang diễn ra** chứ không phải chỉ dấu vết: trong 15 phút quan sát, máy chủ Next dev **restart 3 lần** (pm2 23→26) đúng lúc run goal-loop Omega hoạt động — mỗi lần restart (a) giết run đang chạy giữa chừng, (b) orphan sweep đánh FAIL job vĩnh viễn khi hết attempts (max 2), (c) R4 salvage gán `crashed` post-mortem. Công việc user yêu cầu ("Tiếp tục công việc bạn làm thiếu") bị hủy 2 lần liên tiếp. Song song đó: **sổ nợ DebtLedger vẫn 0 dòng** sau 24h có 3 run failed/crashed + 8 tool errors — xác nhận live khoảng trống mà lượt 6 §7 dự đoán ("DebtLedger chỉ có thể ghi nợ TỪ trọng tài"): run crash trước vòng arbiter → không finalize → nợ mất tích → hệ thống **không nhớ gì để học** từ chính sự cố của mình. Panel UI nói "Không có nợ đang mở — sạch" trong khi panel Tool health ngay trên nó báo 8 lỗi/24h.

Phát hiện thứ 3 (nhẹ): UI đang hiển thị 2 nguồn sự thật mâu thuẫn về tài liệu — stats card "9 Tài liệu" (Qdrant/Neo4j) vs tab Tài liệu "0/118 · Đang chờ 118" (R2 prefix `pdfs/` — thư viện gốc tháng 8 + 9 TXT D0, Document table SQLite trống sau lần DB mới ~19-10).

**Không có fix nào được triển khai trong lượt này** — 2 phát hiện lớn cần thiết kế (đề xuất R16 ở §6), trình user duyệt theo đúng quy trình blueprint-trước.

---

## 2. BẰNG CHỨNG CHẨN ĐOÁN (đo trực tiếp, 02:24–02:40 UTC 20-10)

### V1 · Mất ổn định server dưới tải goal-loop run (nghiêm trọng — mở rộng P-NEW-1)

| # | Phát hiện | Bằng chứng đo được |
|---|---|---|
| V1.1 | pm2 restart 3 lần trong 15 phút quan sát | pm2 list: 02:25 = **23 restart** → 02:36 = **26 restart** (PID 10271 → 9691); uptime "49s" lần cuối |
| V1.2 | API degrade toàn diện lúc run ghi DB | `goal-loop-jobs` GET **89s** + **31.9s→500**; `agent-run` **90s** + 30.1s→500; `todos` 58s + 29.5s/29.8s→500 ×2; `opus/activity` **118s** + 500 ×2 (594ms, 244ms); `agents` 52s; `brain/activity` 45s ×2 |
| V1.3 | Socket timeout SQLite hàng loạt | 99 dòng "Socket timeout" trong dev.log; 60 lần retry (49 lần-1/3, 11 lần-2/3, **0 lần-3/3** — withSqliteRetry 3 tầng cứu hết, nhưng gốc rễ chưa trừ) |
| V1.4 | Lỗi pipe tầng Next dev | 12× `⨯ Error: failed to pipe response — TypeError: Invalid state: The ReadableStream is locked` |
| V1.5 | Job user bị hủy 2 lần | Job `cmvg25p2a001`: attempt-1 crash → boot requeue → attempt-2 RESUME checkpoint (chu kỳ 2, 17 tool calls, 286.273 tokens) → boot nữa → `orphan sweep: mark FAILED — attempts 2 ≥ max 2 (không retry vô hạn)` → **failed vĩnh viễn** |
| V1.6 | Chu kỳ lặp sự cố | `goal-loop active → write burst SQLite → API 45-118s + socket timeout + pipe error → dev server crash → pm2 restart → salvage đánh crashed + job fail → công việc dở hủy + không ghi nợ`. 28 boot server trong window dev.log hiện tại |

### V2 · Sổ nợ DebtLedger trắng — nợ từ crash/tool-failure không bao giờ được ghi (nghiêm trọng)

| # | Phát hiện | Bằng chứng |
|---|---|---|
| V2.1 | 0 dòng DebtLedger sau 24h nhiều sự cố | `SELECT COUNT(*) FROM DebtLedger` = 0 lúc 02:35, SAU khi run Omega vừa failed trước mắt quan sát viên |
| V2.2 | 3 run failed/crashed trong 24h, 0 nợ | ALISTA `cmvesjf8z` crashed (hôm qua 05:06, 11 toolCalls) · Omega `cmvesfl4s` incomplete/no_progress 6 chu kỳ **2.432.847 tokens** · Omega `cmvg25t2z` failed hôm nay (17 tool calls, 286K tokens) |
| V2.3 | 8 tool errors/24h hiển thị ngay UI, 0 nợ | Tool health panel: `shell` 5 lỗi `↳ /bin/bash: line 1: sqlite3: command not found` + `db_query` 3 lỗi `↳ ❌ db_query failed:` — gọi 112 lần, thành công 93% |
| V2.4 | Đường ghi nợ chỉ có 3 cửa, đều qua arbiter/finalize | agent-goal-loop.ts:5710 (infra demotion — chỉ khi ARBITER liệt kê side issue) · :5755 (arbiter debt) · :6258 (run-failed — chỉ chạy trong finalize BÌNH THƯỜNG). Run crash = process chết = không finalize = không nợ; orphan-sweep fail cũng không ghi |
| V2.5 | 'crashed' là nhãn post-mortem, không phải đường ghi | Boot log: `Stale AgentRunRecord cleanup (R4 salvage): 1 run 'running' mồ côi từ process trước → failed/crashed` — gán SAU khi process đã chết |
| V2.6 | UI mâu thuẫn trực quan | Panel "📒 Sổ nợ kỹ thuật": "Không có nợ đang mở — sạch." — ngay dưới panel "Tool health (24h)" báo shell 5 lỗi + db_query 3 lỗi |

### V3 · Hai nguồn sự thật tài liệu (nhẹ — UX)

| # | Phát hiện | Bằng chứng |
|---|---|---|
| V3.1 | Stats card nói 9, tab Tài liệu nói 118 | `/api/query?action=stats` → `totalDocuments: 9, documentsByStatus: {indexed: 9}` (đúng W1 backfill); UI tab Tài liệu → `0/118 Tài liệu · Đang chờ 118` (từ `/api/ingestion/upload` GET = list R2 prefix `pdfs/`) |
| V3.2 | 118 = thư viện gốc + D0, không phải duplicate | R2 `pdfs/` 118 object, mỗi tên 1 lần: 107 PDF (tháng 8: hacking/metacognition/complexity/causal) + 9 TXT knowledge (18-10) + 2 file test P5-M2. Phân bố ngày: 08-21→6 · 08-22→11 · 08-23→33 · 08-26→1 · 09-03→56 · 10-10→2 · 10-17→1 · 10-18→8 |
| V3.3 | Document table SQLite = 0 | DB hiện tại mới bắt đầu ~19-10 05:00 (5 ChatMessage, 5 AgentRunRecord cũ nhất) — bảng Document trống, mọi file R2 hiện status 'uploaded' |

---

## 3. DÒNG THỜI GIAN RUN OMEGA LIVE (quan sát real-time 02:22–02:35)

```
02:22:25  user (trong app): "Tiếp tục công việc bạn làm thiếu" (32 chars)
02:22:30  Job cmvg25p2a001 tạo + Omega run cmvg25t2z bắt đầu (glm-5.3-flash qua NIM)
02:25:10  Omega nhặt todo "Nghiệm thu 2/3/4" từ run hôm qua (same-session pickup — R13 hoạt động)
02:25-02:29  Chu kỳ ghi DB → SÓNG CONTENTION: API 45-118s, 6+ 500s, socket timeout,
          pipe errors ×12 → SERVER CRASH #1 (pm2 23→24)
02:2x     Boot: requeue job (attempt 2) + R4 salvage đánh crashed run cũ
02:28-02:34  RESUME từ checkpoint (chu kỳ 2, 19 messages) — Omega chạy tiếp, 17 tool calls,
          chu kỳ 1 vòng 3→5 (2→4 native tool_calls/vòng), token burn 286.273
02:34:27  Heartbeat tươi — "đang khỏe"
02:34-02:35  SÓNG CONTENTION #2 → SERVER CRASH #2+#3 (pm2 24→26 trong ~90s)
02:35:0x  Boot cuối: orphan sweep → job FAILED vĩnh viễn (attempts 2 ≥ max 2)
          → DebtLedger kiểm tra ngay sau đó: VẪN 0 DÒNG (V2 khép bằng chứng)
```

Điểm đáng chú ý: đúng lúc quan sát viên theo dõi, cả vòng đời "chạy → contention → crash → salvage → fail vĩnh viễn → quên sạch" diễn ra trọn vẹn trước mắt — đây là bằng chứng tự nhiên (không chủ động gây ra) tốt nhất có thể có cho V1+V2.

**Phụ lục V1 (02:37–02:40, sau khi biên bản gần xong):** restart TIẾP TỤC khi KHÔNG còn run nào hoạt động — job đã failed vĩnh viễn 02:35, boot recovery ghi "0 requeue, 0 mark failed", nhưng boot count vẫn nhảy 28 → **30** trong ~3 phút. Điều này loại giả thuyết "chỉ goal-loop gây crash" và làm nổi cơ chế nghi phạm số 1: **vòng tự duy trì UI-abort → pipe-error → crash** — UI poll (4-15s nhịp) với AbortController hủy request đang chậm (page.tsx: `fetchDocsAbortRef.current?.abort()`), response 45-118s bị client bỏ dở giữa dòng → `failed to pipe response` (×12 đã đếm) → next dev gặp unhandled edge → crash → boot mới recompile (○ Compiling /api/brain ...) lại chậm → lại abort. Ứng viên này cần xác minh bằng exit code thật trong R16-6.2 bước (1).

---

## 4. CÁC THÀNH PHẦN KHỎE (xác nhận hoạt động đúng — không phải chỉ bắt lỗi)

1. **UI sạch:** trang chủ load, **0 console errors, 0 page errors** (agent-browser); stats hiển thị 868/868 Real chunks · 103.582 Entities · 216.058 Relationships.
2. **3 phanh hiện diện đủ trong boot log** (nguyên tắc "mọi phanh phải hiện diện 1 dòng đối chiếu được"): R12 (cycles=12, debtCycles=10, ~132 chu kỳ trần) + R13 (maxAttempts=3, globalPickup=2/run, sweep 7 ngày) + R14 (SubAgentSlot maxConcurrent=1 TUẦN TỰ).
3. **Panel Sổ nợ R15 sống:** render đầy đủ counts + phanh tuần tự 0/1 slot + hàng đợi (0 lượt xếp hàng, p50/p95 —) + hướng dẫn kill-switch. Slot tuần tự hoạt động: 0 busy, 0 waiting.
4. **Same-session todo pickup hoạt động** — Omega hôm nay nhặt đúng 3 todo "Nghiệm thu" của run hôm qua (updatedAt 02:25:10).
5. **withSqliteRetry 3 tầng cứu 100% socket timeout** (0/60 chạy hết lần-3) — giảm thiểu P-NEW-1 giữ đúng thiết kế "chưa trừ gốc".
6. **REQ-AUDIT 4 fix giữ vững sau ~1 ngày:** watchdog đã dời sang /api/health (186 lần trong window, không đập goal-loop-jobs); các jobId poll còn lại là UI chính đáng (4s TTL micro-cache); không thấy request lãng phí mới nổi bật.
7. **Backup multi-collection W1 hoạt động:** GET snapshot-full trả byCollection 5 nhóm + point map (chunks 868 · documents 9 · episodes 134); backup 3 lần liên tiếp OK; dual-write đã gỡ đúng (commit 3ef2f4c, lần xác nhận live đầu tiên sau gỡ).
8. **F8 notifications, tab Analytics Runtime Metrics** render đầy đủ (token burn theo agent, tool health, agent runs — số liệu khớp DB).
9. **Qdrant:** health connected 1.13.2, dim 2048/2048 khớp, 868 chunks nguyên vẹn sau 3 lần restart server (dữ liệu vector không bị ảnh hưởng bởi V1).

---

## 5. NỢ KỸ THUẬT CÒN LẠI (cập nhật từ lượt 6 §7)

| Mã | Nợ | Trạng thái lượt 7 |
|---|---|---|
| P-NEW-1 (R11) | Gốc rễ Prisma pool socket-timeout trong next dev | **NÂNG CẤP NGHIÊM TRỌNG**: từ "chỉ thấy qua retry" → mất ổn định server (V1: 3 restart/15 phút, 500s user-facing, job hủy). Lần đầu có bằng chứng chuỗi đầy đủ. |
| P-NEW-4 (R11) | Triage classifier ~10K tokens/call | Chưa đo lại đầy đủ (Opus completed 650ms với tokensUsed rỗng — cần xem cơ chế ghi token của triage path; để lượt sau) |
| P-R13-1 | buildPendingDebtBlock dead-code | Không đổi |
| P-R13-2 | DebtLedger UI panel | **ĐÃ XỬ LÝ ở R15** (panel sống, xác nhận §4-3) — đóng |
| P-R13-3 | Global pickup chưa lọc độ liên quan | Chưa có dữ liệu mới (sổ nợ trắng — không pickup gì để đo) |
| **P-R16-1 (MỚI)** | Nợ từ run crash + tool-failure lặp không được ghi (V2) — 3 cửa ghi đều phụ thuộc arbiter/finalize | MỞ — đề xuất §6.1 |
| **P-R16-2 (MỚI)** | Server crash cascade dưới tải run (V1) — chuỗi contention→pipe error→crash→restart | MỞ — đề xuất §6.2 |
| **P-R16-3 (MỚI)** | UI 2 nguồn sự thật tài liệu (V3) | MỞ — nhỏ |
| ⑪⑫⑤⑥⑦ (R8-R12) | UI timer, dải đen đài quan sát, model list/auto-update | Không quan sát thấy trong phạm vi lượt này (không đụng tới) |

---

## 6. ĐỀ XUẤT ĐỢT R16 (chờ user duyệt — không tự triển khai)

### 6.1 · Đường ghi nợ thứ 4 — "crash-proof debt" (khép V2, ~1.5h)

Nguyên tắc: **sự cố chính là nguồn nợ đáng tin nhất — không cần arbiter kể lại**.
- (a) R4 salvage (đang gán crashed post-mortem) → thêm `recordDebtIssue({kind:'infra', title: 'Run <agent> crashed (salvage): <stopReason>'})` ngay khi salvage 1 run — 1 dòng code tại instrumentation, có sẵn sessionId/runId.
- (b) GoalLoopWorker orphan-sweep đánh FAIL job (đang im lặng) → record nợ infra kèm attempts.
- (c) Tool-failure lặp trong run: cùng tool fail ≥3 lần/run (đếm từ ToolMetric/trace) → record nợ infra không đợi arbiter — bắt đúng case `shell: sqlite3 not found` ×5 hôm nay.
- Giữ phanh: dedupe fingerprint sẵn có chống trùng; kind='infra' không vào debt cycle.
- KPI: replay lại timeline hôm nay → DebtLedger phải có ≥3 dòng (crash salvage ×2 + shell tool-failure ×1).

### 6.2 · Chặn chuỗi crash cascade (khép V1 — cần khảo sát 30' trước khi chọn phương án)

Thứ tự điều tra: (1) bắt exit code/lý do thật của các lần restart (pm2 log hiện trống — cần bật log hoặc đọc stderr; **phụ lục V1 cho thấy vòng UI-abort→pipe-error là nghi phạm số 1 — crash tiếp diễn cả khi không có run**); (2) đo thời gian-đến-crash từ log 30 boot; (3) phương án ứng viên theo thứ tự xác suất giảm dần:
- A. **Ngăn pipe-error giết process** (nghi phạm số 1): bắt unhandled 'error' trên response stream + loại bỏ điều kiện abort-ở-giữa (UI chỉ abort khi đổi trang — đã có sẵn, nhưng poll timeout client-side vẫn cắt request dài); 12 lần "failed to pipe response" là ứng viên trực tiếp gây crash.
- B. Giảm write burst cuối chu kỳ goal-loop (batch các update AgentRunRecord/ChatMessage/Todo thành 1 transaction) — giảm nguồn gây response chậm 45-118s.
- C. Đề xuất cuối nếu A+B chưa đủ: tách worker goal-loop khỏi process API (mini-service riêng) — lớn, cần blueprint riêng.
- KPI: chạy 1 run goal-loop đầy đủ không restart pm2; API p95 < 5s trong lúc run.

### 6.3 · Thống nhất nguồn sự thật tài liệu (khép V3, ~30')

Tab Tài liệu: thêm nhãn nguồn "R2 uploads (chưa qua pipeline)" cho nhóm status 'uploaded' + dòng đối chiếu "9/9 đã indexed (Qdrant)" — không đổi logic, chỉ hiển thị trung thực 2 trạng thái.

### 6.4 · Không đề xuất (từ chối có lý do)

- Tăng max-attempts job (2→3+): chữa triệu chứng — job sẽ bị hủy lần 3 thay vì lần 2, nguyên nhân crash vẫn sống.
- Tắt watchdog/slot để giảm tải: mất giám sát để đổi ổn định — đi ngược hướng lượt 4-6.

---

## 7. KẾT LUẬN

1. **Chẩn đoán lượt 6 §7 được xác nhận bằng live:** "DebtLedger chỉ có thể ghi nợ TỪ trọng tài" — chất lượng vòng đời nợ phụ thuộc chất lượng việc run đi đến được vòng arbiter. Khi server mất ổn định (V1), vòng arbiter không bao giờ tới → sổ nợ trắng (V2) → V1 và V2 là **MỘT vấn đề chứ không phải hai**: mất ổn định làm câm luôn cơ chế ghi nhớ.
2. **Ưu tiên đúng cho R16: 6.1 trước 6.2** — 6.1 rẻ (1.5h), khép được vòng ghi ngay, và quan trọng hơn: khi 6.2 xảy ra trong lúc sửa, 6.1 sẽ tự ghi lại mọi crash làm bằng chứng (hệ thống tự quan sát mình).
3. **Bài học vận hành R16 (truyền lại):** một cơ chế giám sát chỉ đáng tin khi nó ghi được sự cố NGAY LÚC sự cố xảy ra — mọi đường ghi phụ thuộc "chạy tới được vòng tổng kết" sẽ câm lặng đúng lúc cần nó nhất (crash). Thiết kế mặc định cho mọi ledger: **ghi tại nơi phát hiện, không ghi tại nơi tổng kết.**
4. Hệ thống vẫn xử lý đúng loại nhẹ (fast-path 650ms Opus triage, PRE-ACT 5 lessons, RESUME checkpoint hoạt động) — nền tảng R11-R15 giữ vững; vấn đề tập trung ở tầng ổn định hạ tầng, không phải logic agent.
