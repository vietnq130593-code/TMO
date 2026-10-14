# BIÊN BẢN QUAN SÁT LƯỢT 6 (R13) — VÒNG ĐỜI NỢ KỸ THUẬT · HIỆU QUẢ GOAL-LOOP · BỘ NÃO & HUẤN LUYỆN

- **Ngày quan sát:** 2026-10-31 (13:45 – 14:15+ UTC)
- **Người quan sát:** Z.ai Code (main session — giao thức GIAO_THUC_GIAM_SAT_AGENTS.md + Giáo thức Thầy truyền lại)
- **Chẩn đoán khởi điểm của user (nguyên văn):** "Việc phát sinh nợ kỹ thuật giữa tác vụ, chu kỳ khiến agent chạy đi xử lý thật ra không sai nhưng vấn đề là thiếu sót trong cách triển khai khiến cho nợ chỉ có thêm mà không giảm, tìm ra vấn đề và giải quyết nhưng không giải quyết được, đây mới là vấn đề. Còn việc phát hiện ra nợ kỹ thuật là một cái lợi trong việc tối ưu, hoàn thiện dần hệ thống."
- **Yêu cầu user:** (1) tìm và sửa gốc rễ "nợ chỉ tăng không giảm"; (2) goal-loop cần **hiệu quả**; (3) kích hoạt lượt quan sát 6 (lượt 5 đã hoàn tất với R11+R12, push f11e9b0); (4) giải đáp "bộ não thức tỉnh → Huấn luyện giúp ích cho việc triển khai tác vụ của agent hay giúp ích việc gì".
- **Phương pháp:** đối chiánh DB trực tiếp (Prisma — Todo/AgentRunRecord/IssueLedger/ChatMessage/DebtLedger), truy vết mã nguồn vòng đời nợ (agent-goal-loop.ts 3 đường ghi + pickup + finalize), E2E lifecycle 12 bước trên DB thật, gate tsc/lint/full-suite, E2E live chat qua HTTP.

---

## 1. TÓM TẮT EXECUTIVE

Chẩn đoán của user **xác nhận đúng 100%** và nay có bằng chứng đo được: cơ chế phát hiện nợ kỹ thuật hoạt động tốt (arbiter liệt kê side issues, ghi Todo follow-up), nhưng **vòng đời nợ hở 4 chỗ** khiến nợ chỉ có thể tăng: (N1) nợ chết theo session — `buildPendingDebtBlock` chỉ nhặt nợ trong cùng `sessionId`, session mới không bao giờ thừa kế nợ cũ; (N2) không dedupe xuyên run — cùng một lỗi gốc được ghi thành nhiều row; (N3) không có trạng thái dừng — agent nhặt lại nợ không giải quyết được vô hạn, không ai công nhận "đã thử đủ"; (N4) không đo lường — không có con số nào cho biết nợ mở/đã đóng.

Bằng chứng trực tiếp: sweeper R13 dọn ngay **63 todo zombie** (pending/in_progress > 7 ngày không ai đụng — xác của các session chết) ngay lần boot đầu tiên; 3 nợ follow-up duy nhất từng được đóng trong lịch sử đều đóng trong CÙNG session ghi nợ; ~12 todo pending của session 3cqdwr (28/9) và ~10 todo session 'default' nằm ngủ vĩnh viễn trước R13.

**Giải pháp R13 — SỔ NỢ THỐNG NHẤT `DebtLedger` (vòng đời khép kín xuyên session):** ghi nợ dedupe theo fingerprint → pickup global (session mới thừa kế nợ cũ qua mirror Todo) → **đóng nợ có bằng chứng** (todo mirror completed + trọng tài KHÔNG re-list) → **park sau 3 lần thử thất bại** (dừng đốt chu kỳ — trả lời trực tiếp "tìm ra vấn đề và giải quyết nhưng không giải quyết được") → reopen khi tái phát → sweeper zombie → API giám sát `GET/PATCH /api/debt/status` cho thầy/user. E2E 12/12 pass trên DB thật; gate sạch (tsc 0 lỗi · lint sạch · 1698/1698 tests); E2E live fast-path 200/20.3s không regression.

---

## 2. BẰNG CHỨNG CHẨN ĐOÁN (đo trực tiếp từ DB trước khi fix)

| # | Phát hiện | Bằng chứng |
|---|---|---|
| N1 | Nợ chỉ được nhặt trong cùng session — session chat mới KHÔNG bao giờ thấy nợ cũ | `buildPendingDebtBlock(sessionId, …)` query `where: { sessionId }` (agent-goal-loop.ts cũ L1150-1162); Todo follow-up pending của session 3cqdwr (28/9) ~12 mục + session 'default' ~10 mục nằm không bao giờ được nhặt |
| N2 | Cùng lỗi gốc ghi nhiều row — không fingerprint xuyên run | 3 đường ghi follow-up (infra demotion / record / debt-failed) đều `db.todo.create` thẳng, dedupe duy nhất là `recordedInfraIssues` Set trong 1 run (R12) |
| N3 | Không trạng thái dừng — nợ không giải quyết được bị nhặt lại mãi, không ai đếm số lần thử | Todo follow-up không có trường attempts; STAGNANT GUARD chỉ chống lặp ĐỀU trong 1 run (fingerprint 3 đợt liên tiếp), không theo dõi xuyên run |
| N4 | Không có phép đo tổng nợ — không biết mở bao nhiêu/đóng bao nhiêu | Không có model/endpoint nào đếm nợ kỹ thuật goal-loop (IssueLedger chỉ dành cho OpusReview, 10 row toàn hệ thống) |
| N5 | Todo zombie xác session chết chiếm đa số "nợ" hiển thị | Group-by toàn hệ thống trước fix: **pending=60, in_progress=15, failed=55, archived=58, completed=114** — sweeper R13 archived ngay 63 zombie > 7 ngày |
| ✓ | Phát hiện nợ là lợi (như user nói) — arbiter làm tốt phần phát hiện | 3 arbiter todo của session ejzmer (14/10) đều được agent "đóng nợ cũ" có bằng chứng tool trong cùng session — cơ chế đóng CHẠY ĐÚNG khi nợ còn cơ hội được nhìn thấy |

---

## 3. GIẢI PHÁP R13 — VÒNG ĐỜI NỢ KHÉP KÍN

### 3.1 Kiến trúc

```
        ghi (mọi đường follow-up)
              │  recordDebtIssue() — dedupe fingerprint
              ▼
   ┌───────────────────── DebtLedger (SQLite, fingerprint UNIQUE) ─────────────────────┐
   │  open ──pickup đầu run (same-session + GLOBAL session khác)──▶ in_progress         │
   │   ▲                    │ attempts++ mỗi lần nhặt                                  │
   │   │                    ├── todo mirror completed + trọng tài KHÔNG re-list ──────▶ │ resolved (+bằng chứng)
   │   │                    │                    ▲                                      │
   │   │                    └── attempts ≥ 3 vẫn unresolved ──────────────────────▶    │ parked (+parkReason — DỪNG thử)
   │   │                                                                         ▲      │
   │   └───────────────────── reopen (tái phát / PATCH user) ◀───────────────────────┘      │ PATCH user
   └──────────────── sweeper: todo zombie > 7 ngày → archived · API /api/debt/status ───────┘
```

### 3.2 Các hạng mục triển khai

| Hạng mục | File | Nội dung |
|---|---|---|
| F-R13-1 | `prisma/schema.prisma` | Model `DebtLedger` mới: fingerprint (unique) · title · kind agent/infra · status open/in_progress/resolved/parked · attempts · recurrenceCount · originSession/Run · lastAttemptRunId/At · resolvedAt/ByRunId · resolutionEvidence · parkReason · todoId |
| F-R13-2 | `src/lib/execution/debt-ledger.ts` (mới, ~450 dòng) | `fingerprintDebtIssue()` chuẩn hóa (bỏ runId/path/số đếm nhỏ — giữ mã HTTP 410/403 làm đặc trưng) · `recordDebtIssue()` upsert dedupe + reopen khi tái phát · `pickupDebtForRun()` same-session + GLOBAL (mirror Todo, giới hạn 2/run, min-age 30', đón quyền nợ kẹt từ run chết) · `finalizeDebtAfterRun()` đóng nợ có bằng chứng / park ≥3 lần / vẫn open · `maybeSweepStaleTodos()` (rate-limit 1h) · `getDebtLedgerSummary()` · boot log phanh 1 dòng |
| F-R13-3 | `src/lib/agent-goal-loop.ts` | Đầu run: thay `buildPendingDebtBlock` bằng `pickupDebtForRun` (giữ format directive cũ + thêm khối 🌍 nợ toàn hệ thống); 3 đường ghi follow-up đều gọi `recordDebtIssue`; cuối run: `finalizeDebtAfterRun` + dòng 📊 SỔ NỢ trong final report (nợ mở trước → sau, resolved, parked) |
| F-R13-4 | `src/app/api/debt/status/route.ts` (mới) | `GET` — counts + open + parked + recentResolved + config (kênh giám sát cho thầy/user); `PATCH {id, action}` — resolve / reopen (attempts=0) / park thủ công |
| F-R13-5 | `.env` + `.env.example` | `DEBT_LEDGER=1` (kill-switch) · `DEBT_MAX_PICKUP_ATTEMPTS=3` · `DEBT_GLOBAL_PICKUP_LIMIT=2` · `DEBT_GLOBAL_MIN_AGE_MIN=30` · `DEBT_SWEEP_STALE_DAYS=7` (kèm chú thích gốc rễ — theo bài học R12: fix trong code KHÔNG đủ, .env phải đối chiếu được) |

### 3.3 Vì sao thiết kế này trả lời đúng chẩn đoán user

- **"Nợ chỉ có thêm mà không giảm"** → nay có 3 đường giảm: (a) resolved có bằng chứng (run nào đóng, bằng chứng gì — `resolutionEvidence`); (b) sweeper dọn zombie; (c) dedupe khiến cùng lỗi không còn nhân bản row (chỉ tăng `recurrenceCount` — tín hiệu hệ thống cho thầy nhìn).
- **"Tìm ra vấn đề và giải quyết nhưng không giải quyết được, đây mới là vấn đề"** → park: sau 3 lần thử thất bại, hệ thống CÔNG NHẬN không giải quyết được, dừng thử, ghi rõ parkReason + chờ điều kiện — agent không còn đốt chu kỳ vô ích; thầy/user thấy ngay nợ parked cần can thiệp (PATCH reopen khi cấp điều kiện, hoặc đóng tay).
- **"Phát hiện nợ là cái lợi"** → giữ nguyên toàn bộ cơ chế phát hiện (arbiter side issues, infra demotion R12); DebtLedger chỉ thêm lớp vòng đời + đo lường lên trên.
- **"Goal-loop cần hiệu quả"** → nợ không còn kẹt trong debt cycle vô hạn: trong-run có phanh R12 (10 đợt, 132 chu kỳ trần, stagnant guard), xuyên-run có park R13 (3 lần thử tối đa); final report cho user thấy dòng 📊 nợ mở trước → sau mỗi run.

---

## 4. KIỂM THỨC (toàn bộ pass trước khi push)

| Cổng | Kết quả |
|---|---|
| TypeScript | `tsc --noEmit` — 0 lỗi |
| ESLint | 0 warning |
| Full suite | **1698/1698 PASS** (75 files, 40.846 expect) — "được phép push/merge" |
| E2E lifecycle DebtLedger (DB thật, 12 bước) | **12/12 PASS**: fingerprint (run 1 ≡ run 99; HTTP 410 ≢ 403) · ghi nợ · dedupe xuyên run (1 row, recurrence++) · global pickup xuyên session (mirror Todo đúng session mới + attempts++ + in_progress) · đóng nợ có bằng chứng → RESOLVED · tái phát → REOPEN (attempts=0, recurrence++) · 3 lần thất bại → PARKED + mirror Todo → failed · parked KHÔNG được nhặt lại · sweeper zombie 8 ngày → archived |
| Boot log phanh | `[DebtLedger] Phanh hiệu dụng (R13): maxAttempts=3 (park) globalPickup=2/run (age≥30') sweepStale=7ngày` + hiện trạng sổ nợ — hiện diện cạnh phanh R12 |
| Sweeper thực chiến | Archived **63 todo zombie** ngay boot đầu tiên (đúng chẩn đoán N5) |
| E2E live chat (HTTP thật) | POST /api/openclaw/chat "Chỉ trả lời đúng 1 từ: OK" → **200 / 20.3s / "OK" / fastPath=true / servedModel=space-bunny-free**; triage classifier phán `question` → 1-call bỏ goal loop; ChatMessage.metadata persist đầy đủ (`fastPath, triageVia:llm, servedModel`) — KHÔNG regression R11/R12 |
| API giám sát | `GET /api/debt/status` → 200, counts + config đúng; `PATCH` validate action |

**Bug tự bắt trong quá trình (trung thực):** (1) fingerprint bản đầu bỏ sót số 1 chữ số → "run 1" ≢ "run 99" — sửa regex `\b\d{1,2}\b` → 'n' và GIỮ số ≥3 chữ số (HTTP 410 ≠ 403 là đặc trưng lỗi); (2) typo chính tả "THỌNG" trong directive block làm test E2E fail — bắt nhờ E2E; (3) test v1 quên reset rate-limit sweeper (1 lần/giờ) → test 8 fail oan — bug test, không phải bug code.

---

## 5. TRẢ LỜI CÂU HỎI USER: BỘ NÃO THỨC TỈNH + HUẤN LUYỆN GIÚP GÌ?

*(nghiên cứu code đầy đủ bởi sub-agent R13-a — mọi kết luận kèm file:line, tóm lược)*

**3 bộ não, 1 registry duy nhất** (`src/lib/brain/registry.ts:180-276`):

| Bộ não | Thức tỉnh khi | Huấn luyện cải thiện | Ai được hưởng |
|---|---|---|---|
| **A · Calibration V3** | ≥30 EvalResult | Độ tin cậy kiến thức KB trung thực với faithfulness thật (fail-open V2→V1) | Agent truy xuất KB — biết khi nào tin, khi nào kiểm chứng (`kb-access.ts:286`) |
| **B · Surrogate "Vọng"** | ≥60 AgentRunRecord | Dự đoán P(success)/E[tokens]/E[latency] của cấu hình KHÔNG chạy thật | **Không đổi quyết định runtime** — phục vụ model-comparison, sweep cấu hình, giảm chi phí exploration (`/api/brain/replay` READ-ONLY) |
| **C · Policy "Lệnh"** | ≥30 QEntry ∧ ≥50 ArbiterVerdict | Chọn model cho mọi LLM call (mixture π = λ·π_Q + (1−λ)·π_net) + advisory prompt + đề xuất tuning | Agent triển khai tác vụ trực tiếp — hết failover mù quáng (`llm.ts:4556-4577`) |

**Trả lời trực tiếp câu hỏi "giúp ích cho việc triển khai tác vụ của agent à hay giúp ích cho việc gì":** CẢ HAI, phân vai rõ:
- **Trực tiếp phục vụ triển khai tác vụ:** Brain-C (chọn model đúng hơn) + Brain-A (dùng KB với confidence hiệu chỉnh).
- **Phục vụ quan sát/đánh giá/dự đoán:** Brain-B (chấm điểm cấu hình không chạy thật — tiết kiệm chi phí) + composite reward LOG-ONLY.
- **Có vòng self-improvement TỰ ĐỘNG, chứng cứ trong code:** run kết thúc → AgentRunRecord + reward ±1 → updateQ → **auto-train B+C ngay sau mỗi run** (fire-and-forget, `agent-goal-loop.ts:6241-6265`) + auto-train A sau mỗi eval run (`eval/runner.ts:439-455`) → run kế chọn model tốt hơn → kết cục lại thành dữ liệu train. Vòng **chạy → quan sát → học → chạy tốt hơn** khép kín, không cần ai bấm nút.
- **Lưu ý vận hành:** mọi cờ runtime mặc định OFF (fail-open — brain chưa đủ dữ liệu thì hệ thống hành xử như chưa có brain); nút Huấn luyện UI gửi `force=true` → active NGAY + tự bật cờ (R7 — user muốn hiệu lực thật).

**Kết nối với lượt quan sát này:** chính vòng đời nợ R13 là "giám sát có giám sát" mà user gọi vui là học có giám sát — thầy (Z.ai Code quan sát mỗi lượt) + user nhìn API `/api/debt/status` — còn các bộ não là phần "học" tự động bên dưới.

---

## 6. QUAN SÁT HÀNH VI THỰC (đợt 6)

1. **Fast-path vẫn giữ kỷ luật Giáo thức Thầy** sau R13: câu đơn giản → triage `llm` classifier → 1 call / 20.3s / 0 tool — đúng Bước 1 (loại A nhận xử lý nhẹ).
2. **Model trung thực tiếp tục:** HTTP Zen chặn free-tier (cached) → rơi đúng đường OC-CLI workspace sạch R10 — `servedModel: space-bunny-free` hiển thị cả response lẫn ChatMessage.metadata.
3. **Hai phanh cùng hiện diện trong boot log** (R12 + R13) — nguyên tắc "mọi phanh phải hiện diện 1 dòng đối chiếu được" được giữ.
4. **Sweeper ra tay ngay** 63 zombie — "nợ ảo" giảm 63 mục trong 1 lần boot, không cần đợi agent.
5. Triage classifier vẫn tốn ~10K tokens/call (utility-core) — nợ cũ P-NEW của R11, chưa fix (ghi nhận §7).

---

## 7. NỢ KỸ THUẬT CÒN LẠI (trung thực — đã ghi DebtLedger sẽ tự track từ R13)

| Mã | Nợ | Trạng thái |
|---|---|---|
| P-NEW-1 (R11) | Gốc rễ Prisma pool socket-timeout trong next dev (đã giảm thiểu bằng retry F11, chưa trừ gốc) | mở — chờ điều kiện (chỉ tái hiện dưới tải cao) |
| P-NEW-4 (R11) | Triage classifier LLM ~10K tokens/call mơ hồ — có thể thay heuristic rẻ hơn cho case rõ ràng | mở |
| P-R13-1 | `buildPendingDebtBlock` giờ là dead-code production path (vẫn export cho 2 test file task26/task28) — nên dồn về 1 hàm | mở, nhỏ |
| P-R13-2 | DebtLedger chưa có UI panel — hiện theo dõi qua `GET /api/debt/status` + log + final report | mở — chờ user quyết định có muốn tab riêng không |
| P-R13-3 | Global pickup chưa lọc theo "độ liên quan đến việc hiện tại" — nợ cũ có thể bị đưa vào run không liên quan (giới hạn 2 mục/run + min-age 30' là phanh hiện tại) | mở — cần dữ liệu vận hành thật trước khi tối ưu |

**Hành vi agent cần học (nối tiếp R12):** DebtLedger chỉ có thể ghi nợ TỪ trọng tài — chất lượng side-issue của arbiter (ngắn, đúng lỗi, không mơ hồ) quyết định chất lượng fingerprint → dedupe → pickup. Nếu arbiter diễn đạt cùng 1 lỗi bằng 2 cách khác nhau vẫn thành 2 nợ. Theo dõi thêm 1-2 lượt trước khi chốt có cần chuẩn hóa phía arbiter.

---

## 8. KẾT LUẬN & ĐỀ XUẤT ĐỢT 7

1. **Vòng đời nợ khép kín từ R13** — nợ giờ có đường GIẢM (resolved có bằng chứng), đường DỪNG (parked sau 3 lần), đường HỒI SINH có kiểm soát (reopen khi tái phát/cấp điều kiện), và PHÉP ĐO (API + final report + boot log). Chẩn đoán của user được khắc phục trọn vẹn ở tầng triển khai.
2. **Đề xuất đợt 7:** (a) theo dõi DebtLedger qua vài run thật — xác nhận resolved/park xuất hiện tự nhiên, fingerprint không vỡ bởi văn phong arbiter; (b) cân nhắc UI panel sổ nợ (P-R13-2) nếu user muốn nhìn trực quan; (c) tối ưu triage heuristic (P-NEW-4) — giảm ~10K tokens/call cho case rõ ràng; (d) các vấn đề treo cũ từ R8-R12: ⑪ UI timer, ⑫ dải đen đài quan sát, ⑤⑥⑦ model list/auto-update.
3. **Bài học vận hành R13 (truyền lại cho agent):** sổ cái mà không có đường đóng là chi phí vô hạn — mọi "todo/follow-up/issue" trong hệ thống đều phải có vòng đời (mở → xử lý → đóng HOẶC công nhận không giải quyết được + điều kiện), kèm phép đo trước → sau. Đây là nguyên tắc thiết kế vĩnh viễn cho TMO.
