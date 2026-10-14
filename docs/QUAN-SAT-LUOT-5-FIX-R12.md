# BIÊN BẢN TRIỂN KHAI FIX — QUAN SÁT LƯỢT 5 (R12)
## Chữa "cơ chế luẩn quẩn" của goal-loop + các vấn đề còn treo từ R11

- **Ngày:** 2026-10-14 (12:30 – 13:05 UTC)
- **Người thực hiện:** Z.ai Code (main session) — theo chỉ thị user: *"Tiến hành triển khai xử lý các vấn đề mà giao thức quan sát lượt 5 đã ghi nhận được... goal-loop đã được xây dựng với mục tiêu tạo ra những bước làm việc cẩn thận chặt chẽ nhưng thay vì vậy lại tạo ra một cơ chế luẩn quẩn. Sau khi fix và test... hãy báo cáo và push code."*
- **Nguồn vấn đề:** docs/QUAN-SAT-LUOT-5-R11.md (§3.1 P1-2, §8.3 P-NEW-1/2/3) + phát hiện mới trong phiên này.

---

## 1. CHẨN ĐOÁN "CƠ CHẾ LUẨN QUẨN" — vì sao goal-loop xoay vòng thay vì tiến bước

Goal-loop được thiết kế để tạo **bước làm việc cẩn thận chặt chẽ** (PLAN→EXECUTE→VERIFY→EVALUATE + trọng tài độc lập). Quan sát lượt 5 cho thấy nó vận hành như **bộ máy xoay tròn**: cùng một câu hỏi quay qua lại các pha, mỗi vòng đốt lại toàn bộ chi phí (1 câu "Brain" = 1.4M tokens, 3 run chết, 9 lần PM2 restart). Điều tra phiên này xác định **4 tầng nhân bản vòng lặp** chồng lên nhau:

| # | Cơ chế luẩn quẩn | Bằng chứng đo được | Hệ số nhân |
|---|---|---|---|
| C1 | **.env đè mất fix F10**: code hạ default debt 100→10 nhưng `.env` vẫn giữ `GOAL_LOOP_MAX_DEBT_CYCLES=100` → giá trị chạy thật 100 — **fix F10 chưa từng hiệu lực** | .env dòng 266 trước R12; bootsai khác biệt so với code | 100 đợt debt/run |
| C2 | **Renewal 100 cửa sổ**: `MAX_CYCLE_RENEWALS=100` × safe-cap 12 chu kỳ = **tối đa 1212 chu kỳ/run** | Boot log R12 (dev.log 10913): trước R12 renewals=100 | 1212 chu kỳ |
| C3 | **Nợ infra bị tính là việc của agent**: trọng tài phán `debtDecision='continue'` cho mọi side issue — kể cả lỗi hạ tầng (path-escape, provider 410, SQLite contention) mà agent KHÔNG THỂ trả bằng thêm chu kỳ → debt cycle lặp vô ích cho đến khi STAGNANT GUARD (sau 3 đợt đốt) mới ép record | R11 §3.1 P1-2: "DEBT CYCLE đợt 1/100 cho tác vụ trả lời OK" | ×3 đợt đốt thỡ mỗi loại infra error |
| C4 | **Song song ẩn**: SelfDirection escalation 6 bước chạy cùng lúc run chat của user (P-NEW-2) — user chờ lâu nhất lại được ưu tiên thấp nhất | R11 §8.3: MemWatchdog self-exit, 9 restart/2.5h | Áp lực bộ nhớ/tokens chồng |

**Nguyên tắc sửa (Giáo thức Thầy truyền lại #4):** *"Nợ infra không giao cho agent trả trong phiên chat"* + *"Token là tiền"*. Fix ở tầng **phân loại + phanh**, không thêm lớp phòng thủ (kết luận R11 §9).

---

## 2. DANH SÁCH FIX TRIỂN KHAI

### F-R12-1 — .env: cho fix F10 sống lại + chặn nhân bản 1212 chu kỳ (C1+C2) — 3 lớp
- `.env` (runtime máy này): `GOAL_LOOP_MAX_DEBT_CYCLES` 100 → **10** + `GOAL_LOOP_MAX_CYCLE_RENEWALS` 100 → **10** (kèm ghi chú gốc rễ trong file).
- **Code default** `agent-goal-loop.ts` (bản deploy mới không có .env): default `MAX_CYCLE_RENEWALS` 100 → **10** (default debt=10 đã có từ F10).
- `.env.example` (tài bản mẫu): đồng bộ 10/10 + ghi chú R12.
- Kết quả: tối đa 10 cửa sổ × 12 = **132 chu kỳ/run** (trước: 1212) + phanh chất lượng giữ nguyên (renewal chỉ mở khi chu kỳ có hành động thành công MỚI + evaluator không bế tắc).

### F-R12-2 — INFRA-DEBT DEMOTION (C3) — module mới `src/lib/execution/debt-demote.ts`
- `splitSideIssuesByInfra(issues)` → `{agent, infra}` theo 15+ pattern HIGH-PRECISION đã gặp THẬT (path escapes workspace root, Access denied, resolveCwd not defined, HTTP 410/429/5xx, FreeTierError, ModelDeprecated, rate limit, Socket timeout, SQLITE_BUSY, EACCES, watchdog/MemAvailable, spawn ENOENT, "lỗi hạ tầng"...). Lỗi code thường (lint/test fail, MODULE_NOT_FOUND trong code run...) KHÔNG khớp — vẫn là nợ agent.
- Wire vào `agent-goal-loop.ts` khối quyết định debt:
  - `canDebtCycle` yêu cầu `debtEligibleIssues.length > 0` — **toàn-infra → record ngay** (Todo follow-up), KHÔNG debt cycle.
  - Trường hợp hỗn hợp: infra issue ghi Todo follow-up NGAY trong đợt debt trigger (dedupe bằng `recordedInfraIssues` — mỗi lỗi chỉ 1 follow-up cả run); debt cycle + directive + STAGNANT fingerprint chỉ còn **nợ agent**.
  - `pendingDebtIssues = debtEligibleIssues` → rule-10 DEBT CHECK của trọng tài chỉ thấy nợ agent → chu kỳ debt không bị relist vô hạn lỗi infra.
  - GĐ3 marker + RENEW-FOR-DEBT + DEBT CYCLE DIRECTIVE (chu kỳ kế) hiển thị đúng số nợ agent + số infra đã tách.
- Kill-switch: `GOAL_LOOP_INFRA_DEBT_DEMOTE=0` → hành vi cũ (đã unit-test bằng subprocess env=0).

### F-R12-3 — BOOT LOG PHANH HIỆU DỤNG (chống "fix vô hình" tái diễn)
- 1 dòng lúc module load trong `agent-goal-loop.ts`: toàn bộ phanh hiệu dụng (env + default hòa trộn).
- Bài học: F10 sửa code nhưng .env đè — không ai nhìn thấy trong 1 ngày vận hành. Giờ dev.log cho thấy ngay.
- **Verified live** (dev.log:10913): `[GoalLoop] Phanh hiệu dụng (R12): cycles=12 iter/cycle=8 debtCycles=10 (F10 từng bị .env=100 đè mất — R12 sửa .env) renewals=10 (tối đa ~132 chu kỳ) stallCycles=3 noProgressGrace=2 infraDemote=on — thời gian=720phút tokens=∞`

### F-R12-4 — USER-CHAT PRIORITY GATE (P-NEW-2 / C4) — module mới `src/lib/execution/user-run-priority.ts`
- `markUserChatRunActive/Done` (globalThis counter + TTL `USER_RUN_ACTIVE_TTL_MS` mặc định 45' chống flag rò sau crash; hỗ trợ request chồng nhau).
- Chat route: mark sau directive-guard (1054) — clear trong `finally` của try outermost → phủ **mọi** đường thoát (fast-path return, durable return, inline return, local-rag/mock fallback, throw).
- Durable worker: mark/clear quanh `runGoalDrivenLoop` (job chạy thay user).
- Orchestrator SelfDirection: mỗi bước gọi `waitForUserChatPriority(...)` trước khi bắt đầu — poll 10s, tối đa `SD_USER_RUN_MAX_WAIT_MS` (10'), log `[SD-Priority]` minh bạch. Gate là **ưu tiên không khóa cứng** (hết chờ vẫn chạy — semaphore F7 serialize OC-CLI spawn).

### F-R12-5 — Sửa regression shell tool (gate protected-paths D6 FAIL từ trước R12)
- **Bắt được khi chạy full suite**: `protected-paths.test.ts` D6 "HTTP shell đọc hợp lệ VẪN CHẠY" fail — shell tool trả `success:false, exit_code:-1` với `reason=EMPTY` khi caller KHÔNG truyền cwd, dù resolve-cwd đã có fallback an toàn. Xác nhận **pre-existing** (git stash về HEAD 9ada84d vẫn fail) — regression từ fix resolve-cwd của agent Omega lượt R11 chưa ai nghiệm.
- Gốc rễ: `dev-tools.ts shell()` vi phạm hợp đồng resolve-cwd ("bad cwd is **downgraded to a safe fallback** + structured log") — trả fail thay vì chạy với fallback.
- Fix: hạ cấp cwd xấu/thiếu về fallback + log `[CWD-GUARD]` + vẫn chạy lệnh (call site `runBg` vốn đã đúng — chỉ shell sai).

---

## 3. KIỂM THỨC (test các vấn đề đã khai thác)

| Kiểm tra | Kết quả |
|---|---|
| Unit debt-demote (30 test: 12 infra thật + 5 agent thật + split + kill-switch subprocess env=0) | ✅ 22/22 + 8/8 pass |
| Unit user-run-priority (flag counter, TTL, 3 outcome inactive/clear/timeout) | ✅ 8/8 pass |
| `tsc --noEmit` / `eslint` | ✅ 0 lỗi / 0 warning |
| Full suite `bun run test` | ✅ **1698/1698 PASS — PASS toàn bộ (28.8s) — được phép push/merge** (trước R12: 1697/1698 FAIL vì D6) |
| protected-paths (D-suite 63 check) | ✅ 63/63 (D6 hồi sinh: `shell echo guard-ok` chạy, [CWD-GUARD] log reason=EMPTY + fallback) |
| E2E fast-path regression qua HTTP thật | ✅ 200 trong 20.2s / 1 call / `servedModel` đầy đủ; ChatMessage.metadata persist `{"fastPath":true,"triageVia":"llm","servedModel":"space-bunny-free","configuredModel":"space-bunny-free"}` |
| Boot log phanh R12 trong dev.log | ✅ dòng 10913 — đủ mọi giá trị mới |
| PM2 restart + health | ✅ healthy 1771ms |

---

## 4. ĐÍNH CHÍNH P-NEW-3 (cron-scheduler "2 instance") — FALSE ALARM
R11 ghi nhận "2 instance cron-scheduler chạy song song (bun index.ts ×2)". Điều tra phiên này bằng `/proc/<pid>/cwd`:
- PID 24045 → cwd `/home/z/tmo-app/mini-services/opencode-server` (service opencode-server)
- PID 24047 → cwd `/home/z/tmo-app/mini-services/cron-scheduler` (service cron-scheduler)

Đó là **2 service khác nhau, mỗi service đúng 1 instance** — nhìn nhầm vì cùng cmdline `bun index.ts`. Cũng xác nhận `src/lib/cron/scheduler.ts` chỉ là DB-layer (không tick loop in-app). **Không có duplicate — không cần fix.** (Bài học quan sát: xác minh bằng cwd/process identity, không chỉ cmdline.)

---

## 5. NỢ KỸ THUẬT CÒN LẠI (trung thực — chưa fix phiên này)
1. **P-NEW-1 gốc rễ Prisma socket-timeout** (next dev, burst run-close): đã giảm thiểu bằng withSqliteRetry (F11, có từ R11). Gốc rễ pool Prisma trong next dev cần kiến trúc write-queue riêng — để nghị xử lý phiên sau.
2. **Triage classifier LLM ~10K tokens/call** cho ca mơ hồ (R11 §8.3): chấp nhận — fast-path heuristic 0-chi phí phủ phần lớn; tối ưu sau khi đo lại tỷ lệ.
3. **model.sync re-sync mỗi restart** (R11 §3.2 P2-2, globalThis không sống qua restart): nhỏ — để sau.
4. **Hành vi agent cần học** (theo nhận định user "vẫn còn nhiều vấn đề xoay quanh các agent cần sửa và cần học"): agent tự sửa hạ tầng giữa phiên chat (R11 §8.2), bỏ sót import khi tự sửa infra, viết test theo nhầm framework — đã có Giáo thức Thầy + IMP-2 + arbiter rule 12/13 canh; việc còn lại là tích lũy nhãn Brain-A (11/30) để não đủ dữ liệu dạy lại.

---

## 6. KẾT LUẬN
Goal-loop giờ **hội tụ thay vì xoay tròn**: debt cycle bị chặn ở 10 đợt và CHỈ chạy cho nợ agent tự gây ra; nợ hạ tầng đi thẳng vào Todo follow-up; trần tổng 132 chu kỳ/run (trước 1212); mọi phanh hiệu dụng hiện diện trong 1 dòng boot log; user chat được ưu tiên trước mọi orchestration. Đã test đầy đủ (unit + full suite + E2E live) và push code.
