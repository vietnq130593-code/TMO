# BIÊN BẢN TRIỂN KHAI FIX — QUAN SÁT LƯỢT 7 (R17)
## Đường ghi nợ thứ 4 "crash-proof" + chặn abort client + thống nhất 2 nguồn sự thật tài liệu

- **Ngày:** 2026-10-20 (05:10 – 05:50 UTC)
- **Người thực hiện:** Z.ai Code (main session) — theo directive user: *"Tiến hành các đề xuất cho tôi"* (duyệt toàn bộ đề xuất R16 §6).
- **Nguồn vấn đề:** docs/QUAN-SAT-LUOT-7-R16.md §5-§6 (P-R16-1/2/3 + đề xuất 6.1/6.2/6.3/6.4).
- **Nguyên tắc gốc (bài học R16 §7-3):** "Ghi tại nơi phát hiện, không ghi tại nơi tổng kết" — mọi ledger phải ghi được sự cố NGAY LÚC sự cố xảy ra.

---

## 1. TRIỂN KHAI 6.1 — ĐƯỜNG GHI NỢ THỨ 4 "CRASH-PROOF" (khép P-R16-1 / V2)

3 đường chèn mới đều `kind: 'infra'` (severity high tự suy — R15), dedupe bằng fingerprint
xuyên run sẵn có (N2), fail-open tuyệt đối — không thay thế 3 đường cũ qua arbiter
(agent-goal-loop 5710/5755/6258 giữ nguyên, có regression chặn r124-A2.4):

### F-R17-1 (6.1a) — salvageCrashedRun ghi nợ (src/lib/observation/alerts.ts)
- Thêm bước (4) trong khối `if (!alreadyAlerted)` của bước (1) UPDATE row: `recordDebtIssue({ issue: 'Run <agent> crashed (salvage) — process chết giữa chừng, không finalize được (mồ côi X phút)', kind:'infra', sessionId, runId, evidence })`.
- 1 chỗ chèn phủ đủ 3 caller (runtime orphan-sweep + boot sweeper instrumentation-node) — salvageCrashedRun là hàm dùng chung.
- Cửa `!alreadyAlerted` (dedup alert 1h theo targetId) đồng thời chặn ghi nợ trùng khi boot sweep + runtime sweep cùng bắt 1 run — 1 run crash = đúng 1 lần ghi.
- Evidence trung thực từ checkpoint: `complete=false · durationMs · cycles · tokensUsed · toolCalls` — không bịa số.

### F-R17-2 (6.1b) — GoalLoopWorker orphan sweep đánh FAIL ghi nợ (src/lib/goal-loop-worker.ts)
- Nhánh STALE (R18 quá trần resume): `recordDebtIssue({ issue: 'Goal-loop job failed vĩnh viễn (orphan sweep stale): mồ côi quá trần resume...', evidence: 'job <id> stale Xh > trần Yh (R18)' })`.
- Nhánh ATTEMPTS cạn (≥ max, không retry vô hạn — đúng case R16 V1.5 job user bị hủy 2/2): `issue: '...attempts cạn sau crash server — công việc dở bị hủy, không finalize được'` + evidence `attempts N/max`.
- 2 nhánh là 2 fingerprint khác nhau (unit B2.1) — 2 sự cố khác nhau đúng thiết kế.

### F-R17-3 (6.1c) — Tool-failure lặp ≥3 cùng session ghi nợ (src/lib/tool-metrics-recorder.ts)
- Sau create row ToolMetric, nhánh `!success` đếm `toolMetric.count({ where: { sessionId, toolName, success: false } })` — `≥3` → `recordDebtIssue` với issue chứa errorTag (`Tool shell thất bại lặp ≥3 lần cùng session — /bin/bash: line 1: sqlite3: command not found`) — bắt đúng case R16 V2.3 (shell ×5 + db_query ×3 hiển thị Tool health panel nhưng DebtLedger 0 dòng).
- Mỗi lần fail mới (4th, 5th...) đếm lại ≥3 → gọi lại → bump recurrence (đúng N2 — tái xuất hiện là tín hiệu hệ thống).
- errorTag nằm trong issue → 2 "họ lỗi" khác nhau của cùng tool = 2 nợ riêng (không false-dedupe — unit B3.2).
- sessionId thiếu ('unknown') → ghi nợ sessionId null (không gộp oan mọi session thiếu id).
- Refactor nhẹ: errorTag/sessionId/agentRole tính 1 lần trước create (hành vi create giữ nguyên — regression A3.4).

---

## 2. TRIỂN KHAI 6.2A + KHẢO SÁT EXIT CODE (P-R16-2 — BƯỚC 1)

### 2.1 · Khảo sát exit code thật (6.2 bước 1-2) — PHÁT HIỆN MỚI làm rõ nghi phạm số 1

| Nguồn | Bằng chứng | Kết luận |
|---|---|---|
| `~/.pm2/pm2.log` (pm2 internal — dev.log không có exit code) | 94 lần restart: `exited with code [0]/[1] via signal [SIGINT]`, nhịp ~55s đều đặn 02:33→03:37 rồi DỪNG (stable 105 phút sau) | Process bị giết bởi **SIGINT từ ngoài** — không phải uncaught exception tự nhiên |
| `rg -a dev.log` (byte \0 khiến rg coi binary — phải `-a`) | 19× `⨯ Error: failed to pipe response — TypeError: Invalid state: The ReadableStream is locked (ERR_INVALID_STATE)` NGAY sau GET 45-118s bị client abort 20s; stack `at ignore-listed frames` — **Next dev tự catch + log, KHÔNG giết process** | **Pipe-error là TRIỆU CHỨNG, không phải hung thủ** — đính chính nghi phạm số 1 của R16 phụ lục V1 |
| MemWatchdog code + boot log | "reaper sandbox thực chiến SIGINT ở ~2.1-2.2GB (vòng 11c)" + `.env` đã hạ `MEM_WATCHDOG_MB=1900 × 20s` từ vòng 11c — boot mới nạp đúng (dev.log 59663: "ngưỡng RSS 1900MB × 2 lần kiểm tra (20s/lần)") | **Hung thủ thật: RSS boot ratchet qua ~2.1-2.2GB** → reaper SIGINT; chu kỳ ~55s = 4s restart_delay + ~51s boot+recompile vượt ngưỡng |
| Verify live phiên này (05:30-05:45) | Restart 94→100 khi tôi mở UI + curl sau restart: cold-compile nhiều route → `RSS 2270MB ≥ HARD 2100MB → self-exit sạch TRƯỚC khi bị giết âm thầm` (dev.log 59796-59799) + `[SelfExitDrain] exit(1)` — **MemWatchdog giờ THẮNG CUỘC ĐUA** reaper (exit sạch + checkpoint flush, thay SIGINT âm thầm); sau cache nóng: GET 199ms-2.4s, stable, RSS 43MB | Watchdog .env 1900×20s hoạt động đúng thiết kế vòng 11c — restart giờ là "sạch" (durable RESUME), không còn chuỗi SIGINT |

### 2.2 · Fix A triển khai (src/app/page.tsx)
- `/api/health` client timeout **20s → 60s** + msg "Hết thời gian chờ (60s)" — giảm phần lớn abort giữa chừng trên request 45-59s (chiếm đa số wave); vẫn có trần chống treo vĩnh viễn.
- Tab ẩn bỏ poll health (`!force && document.hidden → return`) — force vẫn chạy (user vừa action).
- `fetchDocuments` giữ nguyên chính sách cũ (chỉ abort khi đổi trang — regression A4.3 chặn hồi sinh abort-ở-giữa).

### 2.3 · B-full + C — CHƯA triển khai, có lý do (theo đúng thứ tự đề xuất)
- **B (batch write cuối chu kỳ thành 1 transaction)**: rủi ro cao (sửa vòng đời run) — chỉ mới khảo sát; cần blueprint riêng.
- **C (tách worker goal-loop khỏi process API)**: lớn — đúng đề xuất R16 6.2 "cần blueprint riêng".
- KPI "1 run goal-loop đầy đủ không restart + API p95 < 5s": **chưa đối chiếu được** — không có run nào chạy trong phiên này (phải chờ run user kế tiếp; khi đó 6.1 giờ đã tự ghi bằng chứng mọi crash — hệ thống tự quan sát mình).

---

## 3. TRIỂN KHAI 6.3 — THỐNG NHẤT 2 NGUỒN SỰ THẬT TÀI LIỆU (khép P-R16-3 / V3)

- Panel "Tài liệu": nhãn "Đang chờ {n}" → **"R2 uploads (chưa qua pipeline) {n}"** + tooltip nguồn (listing R2 prefix `pdfs/` — GET /api/ingestion/upload).
- Thêm dòng đối chiếu: **"Đã indexed (Qdrant) {indexed}/{total}"** (nguồn /api/query?action=stats — W1 backfill 9/9) + tooltip giải thích 2 trạng thái.
- Prop mới `qdrantIndexed` truyền từ `dbStats` (documentsByStatus.indexed / totalDocuments) — KHÔNG đổi logic, chỉ hiển thị.
- **Verified live (agent-browser):** `"R2 uploads (chưa qua pipeline) 118 | Đã indexed (Qdrant) 9/9"` — đúng bằng chứng R16 V3 (stats 9 vs tab 118); 0 console error, 0 page error; log khớp `[R2] Listed 118 objects (prefix=pdfs/)` + `[Stats] docs:9`.

---

## 4. 6.4 — TỪ CHỐI (không triển khai — đúng phán quyết R16)
- Tăng max-attempts job (2→3+): chữa triệu chứng — nguyên nhân crash (RSS boot ratchet) vẫn sống. KHÔNG làm.
- Không mở Bug_v2 mới — đây là hoàn thiện theo đề xuất đã duyệt, có regression r126 + full gate đủ.

---

## 5. KIỂM THỨC

| Kiểm tra | Kết quả |
|---|---|
| r126-crash-proof-debt.test.ts (27 test: A source-scan 17 + B unit fingerprint 10) | ✅ **27/27 pass** — vòng R1 tự bắt 4 lỗi test (regex khoảng cách, kỳ vọng sai format issue thật, chuỗi có runId ngắn 9-10 ký tự KHÔNG phải cuid 25 ký tự — ghi chú hành vi vào B1.2) + 1 lỗi syntax JSX thừa `}` (typecheck bắt) — sửa hết trước commit |
| `bun run typecheck` / `bun run lint` / `check:imports` | ✅ 0 lỗi / 0 lỗi / PASS |
| Full gate `bun scripts/quality-gate.mjs` | ✅ **PASS 5/6 stage (92.8s)** — type_check ✓ lint ✓ imports ✓ tests ✓ smoke 5/5 ✓ build SKIP local (CI chạy — verdict đúng S4: "KHÔNG kết luận build-được từ lần chạy này") |
| Live health sau restart | ✅ `"status":"healthy"` — boot sạch: 0 requeue, 0 mark failed, MemWatchdog 1900×20s nạp đúng, 3 phanh R12+R13+R14 trong boot log |
| Live UI (agent-browser) | ✅ 0 console error · 0 page error · panel 6.3 hiển thị đúng 2 nguồn (118 R2 + 9/9 Qdrant) · screenshot desktop + mobile |
| DebtLedger hiện trạng | `open=1` (dòng cũ "Tool shell thất bại lặp" từ session test-infra-guard trước đây) — **chưa có sự cố mới nào sau deploy** (boot sweep 0 run mồ côi, 0 job fail) → KPI replay "≥3 dòng" **chờ sự cố thật kế tiếp** — khi đó đường ghi mới tự hành động, không cần arbiter kể lại |

---

## 6. BẢNG NỢ CẬP NHẬT (từ R16 §5)

| Mã | Nợ | Trạng thái R17 |
|---|---|---|
| **P-R16-1** | Nợ từ run crash + tool-failure lặp không được ghi (V2) | **ĐÓNG** — 3 đường ghi thứ 4 triển khai (6.1a/b/c) + regression r126 |
| **P-R16-2** | Server crash cascade dưới tải run (V1) | **BƯỚC 1 xong** — A triển khai + exit code thật tách được hung thủ (RSS boot ratchet → reaper SIGINT; pipe-error chỉ triệu chứng ×19); MemWatchdog .env 1900×20s xác nhận thắng cuộc đua (exit sạch). B-full (batch write transaction) + C (tách worker) còn mở — blueprint riêng |
| **P-R16-3** | UI 2 nguồn sự thật tài liệu (V3) | **ĐÓNG** — 6.3 verified live |
| P-NEW-1 (R11) | Gốc rễ Prisma pool socket-timeout | Vẫn mở — liên quan B-full (giảm write burst thì giảm contention) |
| P-NEW-4 (R11) | Triage classifier ~10K tokens/call | Không đo lại trong phiên (không đụng tới) |
| P-R13-1 | buildPendingDebtBlock dead-code | Không đổi |

---

## 7. BÀI HỌC R17 (truyền lại)

1. **"Nghi phạm số 1" phải được đối chiếu bằng exit code, không bằng suy diễn**: R16 phụ lục V1 đổ cho pipe-error — exit code thật (SIGINT theo nhịp RSS 2.1-2.2GB) cho thấy pipe-error chỉ là triệu chứng mà Next dev tự nuốt. May mà R16 không vội fix kiểu "bọc try/catch pipe" (sẽ vô dụng).
2. **rg trên dev.log gặp byte \0 coi là binary** — phải `rg -a`; count mode vẫn hoạt động nhưng content mode câm lặng. Đây là lý do grep "failed to pipe" lần đầu trả "No matches" (window tưởng không có) — tra cứu log lớn luôn kiểm tra binary detection.
3. **runId thực tế có 2 dạng**: cuid 25 ký tự (bị fingerprint chuẩn hóa `cid` — đúng N2 xuyên run) và id ngắn 9-10 ký tự như `cmvg25t2z` (KHÔNG khớp regex cuid ≥20 — là đặc trưng phân biệt, 2 run khác nhau = 2 nợ riêng). Bài học vào r126 B1.2 — test phải đối chiếu dạng thật từ DB, không tự chế.
4. **Đo sau khi deploy là bắt sống hành vi**: 5 lần restart 94→100 trong lúc chính tôi verify (mở UI → cold-compile → RSS 2270MB → SelfExitDrain exit(1) sạch) — nếu không theo dõi pm2 restart count + đọc dev.log ngay, chuỗi này vô hình.
