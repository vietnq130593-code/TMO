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

---
Task ID: W1-BFULL-1
Agent: Z.ai Code (main session)
Task: Nâng blueprint v0.2 + triển khai ngay W1 B-full (user: "Nâng lên đi, sau khi hoàn thành nâng cấp blueprint rồi thì tiến hành triển khai blueprint ngay")

Work Log:
- Nâng BLUEPRINT-R17BC v0.2: §4.1 2-làn type + type-guard RMW + delegate-map + BatchDroppedError + 4 trigger (flushNow run-close + drain exit ≤3s TMO_EXIT_WRITE_DRAIN_MS tách 600ms) + flush 2 pha per-op salvage + danh hiệu bền trung thực + metrics 8 số; §4.2 thành bảng AUDIT 10 dòng; §4.3 heart-movement + P2002-seq + inline-fallback minh thị; §6 KPI #4/#5 đổi gate cách ly + thêm #8/#9; §7.10 nợ compile-ratchet. Commit b01252a.
- Triển khai W1: (1) src/lib/db-write-batcher.ts MỚI (~500 dòng: SetOp/RawOp 2 làn, deep-scan TypeError RMW, coalesce set-only last-wins, flush 2 pha + salvage per-op, bound RETAINED_MAX=2 drop-oldest + BatchDroppedError, holdMs autosplit halve/double, stats 8 số, flag ĐỌC ĐỘNG queueEnabled() — đổi mode được trong cùng process test); (2) migrate 4 nhóm site: tool-metrics-recorder #1 (fire-and-forget; debt-count read giữ direct), memory-tiers #3 (await-version), llm.ts TokenTracker #4 (5 upsert idempotencyKey + flushTokenData shutdown gọi flushWriteQueueNow), auto-learn #6′ (3 create; autoLearnRecord + localEntity GIỮ direct cần id); (3) 2 hook: flushWriteQueueNow tại run-close (agent-run-tracker persistAgentRunRecord) + drainWriteQueueForExit trong selfExitWithDrain (instrumentation-node, hard cap max(600ms, 3s), dynamic import không cycle); (4) .env/.env.example docs 6 cờ (default OFF).
- Fixbug W1 2 vòng: R1 1 phát hiện (TS2578 ×3 — bỏ @ts-expect-error, guard runtime mới là điểm thử), R2 0 (4 điểm nghi vấn độc lập ĐẠT; kill-9 đo đúng hợp đồng: pending 0/40, flushed 40/40).
- Test: r137 14/14 + r138 10/10 (burst 500/1s + 50 direct interleave đủ 550 rows; kill-9 2 mode qua tests/helpers/write-batcher-kill9-child.ts Bun.spawn SIGKILL). Full gate PASS 5/6 (2251 test, build SKIP local).
- Điều chỉnh audit khi triển khai (ghi thẳng bảng §4.2 + §9 v0.2-impl + fixbug.md): #8 updateLatestAgentRunRecord → DIRECT (return control-flow agent-run-tracker:471-472 + delegate-bridge); #6 autoLearnRecord → DIRECT (cần record.id :231).
- Commit + push (origin + mirror).

Stage Summary:
- W1 B-full hoàn tất: batcher + 4 nhóm site migrated + 2 hook + env docs + 24 test mới. Bền trung thực: at-least-once qua contention + clean self-exit; at-most-once qua SIGKILL ≤1s×≤200 (đã ĐO bằng kill-9, không lời hứa).
- KPI đạt tầng test: #3 (flushP95<1s, drop 0) + #7 (replay đủ rows) + #9 (định lượng). KPI #1/#2 cần run thật đầy đủ — tự đến ở mission kế (giao thức quan sát 5/5 ON).
- Wave kế: W2 (S3+S4) — bước (0) điều kiện cần: ObservationEvent_seq_key vào transient db.ts.

---
Task ID: W2-SPLIT-1
Agent: Z.ai Code (main session)
Task: Triển khai W2 (S3 tách worker + S4 processRole) theo BLUEPRINT-R17BC v0.2 + giao thức fixbug + pilot live (tiếp chỉ thị "Nâng lên đi... triển khai blueprint ngay")

Work Log:
- Triển khai S3+S4: (1) scripts/worker.ts MỚI — boot chain mirror instrumentation (ensureDbReady→recoverPending→start), mode inline=SHADOW/split từ .env, TMO_PROCESS_ROLE=worker trước import, MemWatchdog riêng WORKER_MEM_WATCHDOG_MB (avail-aware), heart-movement thread P1-3 (worker-heart-thread.ts ping/pong 15s, im lặng ≥120s → exit(1) cho pm2 kéo dậy), stats write-queue chu kỳ WORKER_STATS_LOG_MS (1 dòng JSON — KPI #3/#9 không cần mở port); (2) ecosystem app 3 theopus-worker (bun, 0 port, backstop 1400M); (3) instrumentation glwMode gate — split → API KHÔNG start worker, else giữ NGUYÊN chuỗi boot gốc (chống divergence inline); (4) db.ts TRANSIENT + 'ObservationEvent_seq_key' hẹp đúng tên constraint (P0-5 điều kiện cần split); (5) ledger writeOne đính processRole (env ?? 'api') — S4 fingerprint 2 process; (6) r139 (24 test: A processRole behavioral · B P2002 hẹp · C seq-collision 10 song song đủ 10 rows · D source-scan topology 8 · E regression FB-W2 9) + r95 PIN UPDATE 2 test.
- Fixbug FB-W2 4 vòng: R1 = 2 (FB-W2-R1-01 readEnvFileKey trả '' làm ?? DEFAULT chết → worker thật chạy ngưỡng 300MB/30s thay 1000MB/120s — phát hiện đối chiếu log boot với code; FB-W2-R1-02 lastPongAt write-only + nhánh 'pong' chết) → fix src/lib/worker-env.ts (nullish + isFinite) + r139 E1-E7; R2 = 0 (scan pattern tương tự toàn repo an toàn theo cấu trúc; gate PASS 5/6); R3 = 1 P0 VẬN HÀNH (FB-W2-R3-01: pm2 --update-env tiêm DATABASE_URL của shell sandbox my-project → worker nối nhầm DB scaffold RỖNG suốt phiên — sweep 0 job, claim im lặng, "requeue 0" mọi boot; chẩn đoán 4 bước: tick-debug → fresh-client trong process → /proc/environ chặn đồng tội → guard + restart minh chứng) → fix guard boot worker.ts (.env TMO nguồn sự thật duy nhất) + r139 E8/E9; R4 = 0 (gate lại PASS 5/6 sau khi dọn 2 probe chẩn đoán tạm khỏi scratch — tsc quét cả scratch).
- Pilot live (DB_WRITE_QUEUE=on + GOAL_LOOP_WORKER_MODE=split, mission thật: Omega phân tích db-write-batcher + viết scratch/pilot-r17bc-report.md): dispatch qua mission-dispatch → job durable → worker claim → 4 chu kỳ → COMPLETED (report 5.6KB chính xác kiến trúc: 4 trigger, salvage 2 pha, bảng call-site). Trong chừng job: **KPI #4 TEST — pm2 restart theopusflashlite 18:04:38Z → job running nguyên vẹn, workerPid 2074 không đổi, heartbeat nhích đều QUA restart (...452214→...494524), worker ↺6 không đụng — GATE ĐẠT "job bị giết khi API restart = 0"**. KPI #1 Socket timeout = 0 toàn cửa sổ pilot (kể cả giai đoạn API crash-loop). KPI #3 worker stats: enabled:true, 67 ops/19 batch, dropCount=0, salvage/poison=0; flushP95 11039ms outlier trùng API-restart đập DB — chunkSize TỰ HALVE 200→100 (P1-5 autosplit hoạt động). KPI #5: API 59MB / worker 154.6MB tách process — delta đóng góp = 0 theo cấu trúc. S4: 145 events processRole='worker' (learn.episode...). Thêm route ops GET /api/observation/write-queue (16 số READ-ONLY).
- Phát hiện phụ pilot (ghi fixbug.md, không sửa trong scope): pid-recycling đánh lừa isWorkerPidAlive (32463/809 tái chế — cần gate phụ heartbeat-staleness, nợ follow-up R18); pm2 stdout block-buffer (log trễ/xả cục lúc process chết — ground truth phải lấy từ DB); scaffold DB my-project bị ensureDbReady của worker trỏ nhầm rải bảng TMO (107 bảng — vô hại với schema scaffold, để nguyên chờ user quyết); API compile-ratchet boot tái xuất (pm2 restart → cold-compile RSS 2.2-2.6GB ≥ HARD-RSS 2100MB → crash-loop 29s/vòng) — biện pháp tạm pilot .env MEM_WATCHDOG_MB=2800 + MEM_WATCHDOG_RSS_HARD_MB=3000 (boot sống qua ngưỡng, xong RSS rơi 59-60MB) — đúng nợ §7.10.
- .gitignore exception !/scripts/worker.ts + worker-heart-thread.ts (bài học matryoshka — script vận hành bị nuốt bởi /scripts/* thì mất khi clone). .env.example docs 5 cờ WORKER_* + pilot note. Commit + push (origin + mirror).

Stage Summary:
- W2 S3+S4 HOÀN TẤT + PILOT LIVE NGHIỆM THU: split topology chạy thật — job goal-loop chạy trọn vẹn trong process worker riêng, sống qua API restart (KPI #4 gate đạt bằng chứng trực tiếp), DB là bus 0 IPC, observation phân biệt 2 process qua processRole. Trạng thái vận hành hiện tại: DB_WRITE_QUEUE=on + GOAL_LOOP_WORKER_MODE=split (pilot giữ nguyên — đây chính là cấu hình đích B-full + C).
- Bug giá trị nhất phiên: FB-W2-R3-01 — bài học "worker im lặng: kiểm tra /proc/<pid>/environ TRƯỚC TIÊN" + guard nguồn-sự-thật-tuyệt-đối cho env DB của process hạ tầng.
- Toàn bộ W1+W2 theo blueprint v0.2 đã triển khai xong; gate PASS 5/6 (2275 test); r137/r138/r139 + r95 PIN xanh. Còn treo theo blueprint: KPI #2 (interactive tx p95 <2s — cần run thật dài hơn để tích lũy mẫu), nợ follow-up: pid-recycling gate, compile-ratchet boot §7.10, dọn bảng TMO trong scaffold DB.

---
Task ID: DEBT-R17BC-1
Agent: Z.ai Code (main session)
Task: Trả nợ follow-up pilot W2 (user directive 2026-10-21: "Tôi không hiểu phần Nợ ghi nhận bạn viết cuối cùng là còn nợ gì không, nếu còn nợ thì triển khai tiếp không thì thôi")

Work Log:
- Tái dựng 3 khoản nợ từ worklog W2-SPLIT-1 + fixbug.md FB-W2 (:551/:553) + commit 9fa355d: (1) pid-recycling gate; (2) compile-ratchet boot §7.10; (3) dọn bảng TMO scaffold DB. Đối chiếu code trước khi sửa: sweep goal-loop-worker.ts:422-531 (isWorkerPidAlive :422 + GATE 1 :470), nhịp heartbeatAt (claim ghi ngay :638; refresh :903 throttle 15s; orchestrator.ts:2821 "ghi mỗi vòng/tool batch") → ngưỡng GOAL_LOOP_STALL_PREEMPT_MS (30' > trần LLM 8') là đúng semantics preempt.
- Nợ 1 — pid-recycling gate: helper thuần `isPidRecycleSuspect(pidAlive, heartbeatAgeMs, threshold=GOAL_LOOP_STALL_PREEMPT_MS)` tại goal-loop-durable-types (module thuần 0 import — test trực tiếp; heartbeat null/NaN/âm → tin pid bảo thủ; threshold ≤0 = tắt theo ngữ nghĩa họ GOAL_LOOP_) + wiring sweep: SKIP chỉ khi pid sống VÀ heartbeat đủ tươi (bảo vệ double-run thật R18 gate 1 giữ nguyên — dòng log skip cũ y nguyên); nghi tái chế → warn throttle + RƠI XUỐNG requeue giữ checkpoint (cùng semantics preempt: updateMany conditional + attempts + RESUME — hết kẹt 'running' tới trần STALE-AGE 12h khi mồ côi không follower). r140 MỚI 14/14 (A1-A9 helper + B1-B5 source-scan wiring). Fixbug FB-DEBT-R17BC R1: 1 chính (đúng chẩn đoán pilot) + rà đồng tội process.kill toàn repo: 5 site còn lại toàn đường KILL (khác lớp trust dài hạn) → chỉ 1 trust-site đã fix; R2: 0. Full gate PASS 5/6 (105.4s — typecheck/lint/imports/tests/smoke; build SKIP local).
- Nợ 3 — dọn scaffold DB my-project: script bun:sqlite (đường dẫn tuyệt đối, không env) — inspect 106 bảng TMO: **0 bảng có dữ liệu** (đúng chẩn đoán R3 — worker chỉ TẠO bảng trên DB rỗng) → backup custom.db.backup-2026-10-20T18-53-14 (2.166.784 bytes) → drop 106 + wal_checkpoint(TRUNCATE) + VACUUM + integrity_check ok → scaffold `bun run db:push` phục hồi đúng schema (Post, User). App preview healthy sau dọn.
- Nợ 2 — §7.10 compile-ratchet boot: GIỮ HOÃN đúng anti-goal v0.2 (cần round riêng; S3 không diệt được cold-compile Next dev). Ghi bền biện pháp tạm: .env chú thích nguồn gốc + điều kiện xoá (2 khối MEM_WATCHDOG — hiệu lực không đổi, 2800/3000 last-wins như pilot) + .env.example khối tái hiện (track trong git).
- Restart theopus-worker (KHÔNG --update-env): boot mode=split pid 8103, guard DATABASE_URL chặn env shell (log minh chứng), recoverPending requeue 0/mark 0 (không job mồ côi — đúng), tick 5s + preempt 1800000ms chạy — worker ĐANG CHẠY CODE MỚI. API theopusflashlite KHÔNG restart (split mode không sweep trong API; tránh chạm compile-ratchet §7.10).
- Blueprint §9 thêm dòng DEBT-R17BC; scratch/pilot-r17bc-report.md + r17bc-pilot-directive.txt đưa vào track (bài học matryoshka — bằng chứng pilot không mất khi clone). Commit + push (origin + mirror).

Stage Summary:
- **2/3 nợ ĐÃ TRẢ**: pid-recycling gate (r140 14/14 + gate PASS 5/6 + worker live code mới) + scaffold DB sạch (backup đầy đủ, schema phục hồi Post/User). **1/3 GIỮ HOÃN đúng phạm vi duyệt**: §7.10 compile-ratchet boot — biện pháp tạm 2800/3000 đã ghi bền (tái hiện được khi clone, có điều kiện xoà rõ ràng).
- KPI #2 (interactive tx p95 <2s) tiếp tục tích lũy mẫu bằng run thật — không việc hoãn trong scope.
- Bài học: "pid sống" qua process.kill(pid,0) là tín hiệu YẾU khi cần tin chủ cũ còn chạy — phải ghép tín hiệu độc lập (heartbeat DB) ở TẦNG QUYẾT ĐỊNH, giữ probe thuần nguyên vẹn để dễ test và không đổi semantics.

---
Task ID: §7.10-RATCHET-1
Agent: Z.ai Code (main session)
Task: Round riêng §7.10 compile-ratchet boot (khoản nợ cuối của DEBT-R17BC — user directive "tiến hành" 2026-10-21)

Work Log:
- Recon: đối chiếu 15 boot trong dev.log — crash-loop cũ luôn chết ở lần check ĐẦU với RSS 2230-2632MB ≥ HARD 2100 (blind tier exit tức thì); 2 boot "may mắn" bắt kịp RSS 2047/2081MB < 2100 thì SỐNG và RSS hồi 487/557MB sau ~40s → spike cold-compile là THOÁNG QUA (pm2-start.sh tự đo: boot-ramp 840→2216MB trong ~36s khi browser poll). Pilot 2800/3000 chỉ là mở khóa, làm yếu OOM steady-state.
- Thiết kế: chỉ tier BLIND HARD-RSS nhận boot-grace (tier duy nhất không phân biệt spike thoáng vs leak thật); tier áp-lực-thật (avail-aware ×2 + global guard MemAvailable<450) giữ nguyên hoạt động CẢ trong grace (bằng chứng spike boot avail còn 1203-1425MB). Ceiling mặc định HARD+700 = 2800 (đúng giá trị pilot đã sống, chừa 168-197MB trên peak quan sát).
- Triển khai: src/lib/mem-watchdog-policy.ts MỚI (module thuần 0 import — resolveHardTierDecision 4 nhánh: ok/exit-hard-rss/exit-grace-ceiling/grace-log; NaN/rác fail về hành vi cũ; ceiling kẹp ≥ HARD) + wiring instrumentation-node.ts HARD tier qua policy (env MEM_WATCHDOG_BOOT_GRACE_MS 180s / MEM_WATCHDOG_BOOT_CEILING_MB; observation event mem.boot_grace throttle 1 lần/cửa sổ, fail-open) + kinds.ts +mem.boot_grace +mem.soft_tier (S6 đã phát từ trước nhưng thiếu dòng khai báo) + .env/.env.example XOÁ pilot 2800/3000 (ngưỡng hiệu dụng trở về 1900/2100).
- Fixbug FB-§7.10 khép 2 vòng: R1 = 2 (BUG2-315 assertion no-op r141-B3 — sửa; 3 PIN kind 25→27 vỡ — PIN UPDATE r95-H6/r99-C1/r122-A1 kèm chuỗi lịch sử); R2 = 0 (6 điểm nghi vấn độc lập ĐẠT: thứ tự khai báo, NaN env, tier không grace hóa, worker đúng không cần grace, uptime mỗi check, throttle event).
- Sự cố phiên: stage `tests` gate FAIL 9 lần liên tiếp (r81/r83/r87-H5H6H7/r95-A1/r96-D1/r102 — ~10 unique, khớp OBS-2 N4). A/B matrix loại trừ toàn diện: stash bf2f2f5 sạch + app STOPPED + worker STOPPED → vẫn FAIL; khôi phục tạm .env pilot → vẫn FAIL. Forensics: bảng TuningChangeLog "biến mất" GIỮA CHỪNG run sau khi các test đã PASS dùng nó + transaction chờ 15022ms → BUG2-316: request-time self-heal ensureDbReady spawn `prisma db push` trên DB test giữa chừng 111-112 file song song → cascade lock. Pre-existing, không liên quan §7.10, ghi nợ round riêng.
- Live verify (mục tiêu chính): (1) 19:23 boot ngưỡng thật 1900/2100 + code mới → spike 2330MB ≥ HARD → grace THA (log "còn 150s, uptime 30s") → avail-aware song song đúng → RSS hồi 470MB → app sống ↺194; (2) 19:38 boot spike 2603MB (PEAK MỚI — kỷ lục crash-loop cũ 2632MB) → grace tha tiếp (dưới ceiling 197MB) → worker+app healthy. 2 event mem.boot_grace ghi DB (seq 1218/1222 — probe xác nhận). Before/after cùng phiên: 4 boot cũ SelfExitDrain 2230/2526/2585/2632MB (tái hiện bug sống do .env đổi trước khi code nạp — "Reload env" không nạp lại instrumentation).
- Gate 5/6 (type_check 8.2s ✓ · lint 51.8s ✓ · imports ✓ · smoke 5/5 ✓ · build SKIP local; tests FAIL = BUG2-316 pre-existing). Commit 150584d (11 file) → push origin + mirror THÀNH CÔNG, verify 3/3 SYNC-OK.

Stage Summary:
- §7.10 HOÀN TẤT đúng nghĩa "fix gốc": crash-loop compile-ratchet bị diệt bằng boot-grace đúng tầng (blind tier), ngưỡng thật 1900/2100 phục hồi (không còn nới ngưỡng làm yếu OOM), 2 lần cứu boot thật + 2 observation event làm bằng chứng. KPI #4b: RSS peak boot API = 2603MB. Phần "giảm bản thân spike" (tầng build pipeline) giữ nguyên nợ — giờ vô hại vận hành.
- Phát hiện giá trị nhất phiên: BUG2-316 (test-infra race self-heal db push) — A/B 9-run matrix + forensics "bảng biến mất giữa chừng"; giải thích luôn gate đỏ/xanh thất thường từ OBS-2 ("20 failures, 10 unique" chính là mặt kia của cùng cơ chế). Cần round riêng: guard BUN_TEST cho ensureDbReady spawn.
- Việc treo kế (chờ user duyệt): (1) BUG2-316 hermetic test suite; (2) giảm spike cold-compile thật (build pipeline §7.10 phần 2); (3) N3 pre-check breaker trước explicit model call; (4) branch protection chờ PAT admin:read. KPI #2 (tx p95) tiếp tục tích lũy bằng run thật.
