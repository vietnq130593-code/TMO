# WORKLOG — TMO (khởi lại 2026-10-20 sau xoay vòng)

> worklog.md được khởi lại ở phiên này: phiên trước đã xoay vòng (quyết toán quy về fixbug.md BIÊN BẢN + docs/QUAN-SAT-LUOT-*). Bản này tiếp tục quy ước: mỗi nhiệm vụ 1 section, chỉ append, không ghi đè.

---
Task ID: BLUEPRINT-R17BC-1
Agent: Z.ai Code (main session)
Task: Viết technical Blueprint cho những gì cần triển khai (chỉ thị user 2026-10-20 ~16:19 UTC: "Tiến hành viết technical Blueprint cho những gì cần triển khai cho tôi")

Work Log:
- Đối chiếu trạng thái toàn cục: HEAD `9562880` (FB-F1F6 khép 2 vòng, git sạch, đã push). Chuỗi 1-6 của user: item ①②③⑥ + fixbug F1-F6 ĐÃ xong ở `d7157da` / `bb97bfd` / `aa0c29c` / `9562880` — chỉ còn ④ R17 B-full + ⑤ R17 C.
- Khảo sát 14 nguồn (grep/read trực tiếp, không subagent): docs/QUAN-SAT-LUOT-7-FIX-R17.md (đủ 106 dòng — §2.3 giao B-full + C cho "blueprint riêng"); fixbug.md FB-F1F6 "Ngoài phạm vi" (B-full + C = ưu tiên kế tiếp theo duyệt); Bug_v2 OPUS-VERDICT-1 phụ chứng (Socket timeout toolMetric/workingMemory + ledger tx 5s→15s); db.ts Task 33 (51 lỗi R11, danh sách burst run-close, dự án "write-queue architecture" tại :132); observation-live.md tail (crash loop 15:19–15:20 ↺167→170, RSS 2489/2407/2518MB, SelfExitDrain exit(1) — TÁI XUẤT sau F1-F6); pm2 (↺173, ổn định 59m, RSS 61.9MB; observe-live stopped); grep writeQueue/batchWrite = 0 (greenfield); $transaction = 4 file; boot chain instrumentation-node.ts:1246-1270; singleton goal-loop-worker.ts:1507; 3 import site API (opus/pipeline:52, chat route:73→enqueue:1248, goal-loop-jobs:38); .env worker flags (:314-316); ecosystem.config.cjs (2 app); package.json gate.
- Viết `BLUEPRINT-R17BC-P1-P4.md` (root, house style BLUEPRINT-EXECUTION-EFFICIENCY-P1-P8): §0 tóm tắt điều hành (chờ duyệt) · §1 bằng chứng 3 nguồn (tái hiện được) · §2 P1-P4 · §3 nguyên tắc (chỉ batch ĐUÔI ghi, at-least-once + idempotent, DB là bus, flag default-OFF) · §4 S1-S4 (S1 WriteBatcher + S2 migrate 8 call-site theo đúng danh sách Task 33; S3 tách worker pm2 app 3 + S4 đo tách bạch processRole) · §5 lộ trình W1 (B-full) → W2 (C) kèm lý do thứ tự · §6 KPI 7 chỉ số (baseline→mục tiêu từng wave) · §7 anti-goals 9 điều · §8 phụ lục tái hiện (rg -a, pm2.log) · §9 v0.1.
- Commit + push (origin + mọi remote cấu hình).

Stage Summary:
- Phạm vi "những gì cần triển khai" = R17 B-full (batch write transaction / write-queue) + R17 C (tách worker khỏi process API); P-NEW-1 gộp vào B-full; P-NEW-4 + P-R13-1 ghi ngoài phạm vi (§7) — đúng "ưu tiên kế tiếp theo duyệt của user" (FB-F1F6).
- Bằng chứng mới nhất phiên này: crash loop RSS tái xuất 15:19–15:20 SAU khi 6 fix F1-F6 đã vào (↺167→170 trong ~2 phút) — xác nhận vấn đề cấu trúc còn nguyên, blueprint này nhắm đúng tầng cấu trúc, không phải triệu chứng.
- Kế hoạch sau duyệt user: W1 (S1+S2, flag DB_WRITE_QUEUE default-off) → giao thức fixbug → W2 (S3+S4, GOAL_LOOP_WORKER_MODE inline|split default-inline) → giao thức fixbug → báo cáo + push. KPI chốt: Socket timeout/run = 0; interactive tx p95 <2s; flush p95 <1s drop 0; API restart/run = 0; API p95 <5s (KPI R17 §2.3 còn treo); mất dữ liệu write = 0.

---
Task ID: BLUEPRINT-REVIEW-1
Agent: Z.ai Code (main session)
Task: User directive "Vào vai kỹ sư AI, kiến trúc sư hệ thống tiến hành review lại blueprint vừa viết" — phê vấn BLUEPRINT-R17BC v0.1 bằng đối chiếu code

Work Log:
- Điều tra bổ sung 5 nguồn (mọi phát hiện kèm dòng code): q-table.ts:322-354 (updateQ là RMW thuần: findUnique đọc qValue → tính newQ → upsert set + visits increment — có sẵn chuỗi promise tuần tự in-process :244-247); prisma/schema.prisma:2645-2649 (ObservationEvent.seq @unique + comment "single-writer queue… pm2 fork 1 process" RO-4); db.ts:238-255 (TRANSIENT_SQLITE_PATTERNS KHÔNG có P2002) + 172-179 (P2025 là control-flow thường gặp, được lọc im lặng); ledger.ts:270-297 (writeOne drain đơn luồng là điều kiện an toàn của phép cấp MAX(seq)+1); chat/route.ts:1235-1246 (inline-fallback khi enqueue lỗi + guard cấm double-run khi job row đã tạo); grep increment: 10 hit messageCount/increment/occurrenceCount (dòng session upsert — RMW phổ biến trong codebase).
- Ghi §10 REVIEW-1 vào BLUEPRINT-R17BC-P1-P4.md + dòng lịch sử §9; sửa 2 lỗi đánh máy pha tạp ("cuộđua"→"cuộc đua", "điều度"→"điều độ").
- Verdict ⛔ tạm đứng: 5 P0 + 6 P1 + 3 P2; §10.4 duyệt giữ nguyên 6 mục (thứ tự W1→W2, nguyên tắc §3, anti-goals §7, nguồn S2, topology S3, KPI #1-3/#6-7); §10.5 map finding → chỗ sửa cho v0.2.
- Commit + push (origin + mirror).

Stage Summary:
- 5 P0: (1) queue in-memory mất trắng khi SIGKILL/kernel OOM — "at-least-once" v0.1 là danh hiệu sai; cần flushNow() tại run-close + drain bound ≤3s tách khỏi hợp đồng SelfExitDrain 600ms + danh hiệu trung thực at-most-once-on-SIGKILL + KPI "ops mất/crash"; (2) poison op chặn cả 200 op lành — cần flush 2 pha + per-op salvage; (3) coalesce last-wins hủy RMW (updateQ/visits increment) — cấm coalesce RMW, chỉ set-semantics, kèm bảng audit call-site; (4) KPI #4 "API restart=0" không đạt được bởi S3 (boot ratchet là cold-compile Next dev — blueprint tự dẫn chứng) → đổi thành gate cách ly "job sống qua API restart" + nợ follow-up "API compile-ratchet boot"; KPI #5 đổi từ steady (đã thỏa ngầm 61.9MB) sang delta đóng góp worker vào RSS API; (5) seq @unique ObservationEvent — batch events tạo allocator thứ 2 trong process + W2 phá giả thiết 1-process → rút events khỏi batch list + thêm P2002-seq vào transient (điều kiện cần W2).
- 6 P1: promise reject khi drop (BatchDroppedError) · 1 chủ sở hữu retry (tránh nhân lũy thừa) · heart-movement watchdog cho worker split (STALL chỉ pause job, không chữa process treo) · drain không đè hợp đồng 600ms · hold-time batch tx <300ms + KPI claim/heartbeat p95 <500ms · inline-fallback split mode ghi minh thị (có guard double-run sẵn).
- Điểm duyệt giữ nguyên: thứ tự W1→W2 + 3 lý do; nguyên tắc "chỉ batch đuôi ghi"; anti-goals 9 (P0-1 cấm giải bằng middleware ngoài); S2 nguồn Task 33; S3 "DB là bus, 0 IPC"; KPI #1-3/#6-7.
- Bước kế: chờ user duyệt — nâng v0.2 theo §10.5 rồi mới vào W1.
