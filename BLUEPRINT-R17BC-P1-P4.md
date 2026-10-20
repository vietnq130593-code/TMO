# BLUEPRINT: R17 B-FULL + C — HÀNG ĐỌC GHI ĐƠN WRITER (BATCH WRITE TRANSACTION) + TÁCH WORKER KHỎI PROCESS API

- **Ngày:** 2026-10-20 (16:19–16:4x UTC)
- **Người thực hiện:** Z.ai Code (main session) — theo chỉ thị user: *"Tiến hành viết technical Blueprint cho những gì cần triển khai cho tôi"*.
- **Nguồn vấn đề (chuỗi phê duyệt):** docs/QUAN-SAT-LUOT-7-R16.md §6 (đề xuất 6.2 B/C) → docs/QUAN-SAT-LUOT-7-FIX-R17.md §2.3 ("B-full + C — CHƯA triển khai… cần blueprint riêng") → fixbug.md ĐỢT FB-F1F6 "Ngoài phạm vi" ("R17 B-full + R17 C vẫn là ưu tiên kế tiếp theo duyệt của user") → chỉ thị user phiên này.
- **Trạng thái:** **CHỜ DUYỆT** — bản này là blueprint, chưa đụng code. Sau duyệt: W1 → fixbug → W2 → fixbug → báo cáo + push (đúng khuôn chỉ thị nền của user).

---

## 0. TÓM TẮT ĐIỀU HÀNH

| # | Vấn đề (đã có bằng chứng sống) | Giải pháp (bản này đề xuất) | Rủi ro | Gate an toàn |
|---|---|---|---|---|
| **B-full** | SQLite 1-writer bão hòa dưới cụm ghi run-close: "Socket timeout" tái xuất (51 lỗi đo R11, tái xuất OBS-1), ledger interactive tx 5s bị kéo 15s | **S1 + S2:** `WriteBatcher` — hàng đợi ghi đơn writer trong process; coalesce **chỉ set-semantics**; flush **2 pha** (batch tx → per-op salvage); **4 trigger** (1s / depth 200 / flushNow tại run-close / drain exit ≤3s); bền **trung thực**: at-least-once qua contention + clean self-exit, at-most-once qua SIGKILL (≤1s × ≤200) | Trung-cao (chạm vòng đời ghi của run — R17 §2.3 gọi đúng: "rủi ro cao") | Flag `DB_WRITE_QUEUE` **default OFF**, pilot ON như softmax; nguyên tắc "chỉ batch ĐUÔI ghi" + bảng AUDIT call-site 10 dòng (5 batched / 5 direct có hợp đồng) |
| **C** | Worker goal-loop + organs + 3 mini-services + Next API cùng 1 process → RSS boot ratchet 2.1–2.5GB → self-exit → PM2 restart giết cả API lẫn worker giữa chừng (crash loop 15:19–15:20, ↺167→170, ~30s/chu kỳ) | **S3 + S4:** tách worker thành process riêng (pm2 app `theopus-worker`); DB là bus duy nhất — không IPC mới; đo tách bạch RAM/restart từng process | Cao (thay đổi trục vận hành) | Flag `GOAL_LOOP_WORKER_MODE=inline\|split` **default inline** (fallback tức thì = đổi env + restart); durable checkpoint/RESUME (R18) là nền sẵn có |
| P-NEW-1 (R11) | "Gốc rễ Prisma pool socket-timeout" — mở từ R11 | GỘP vào B-full (đúng ghi chú bảng nợ R17 §6: "giảm write burst thì giảm contention") | — | — |

**Thứ tự bắt buộc W1 (B-full) → W2 (C), lý do ở §5.** Tóm một dòng: B-full giảm tổng tải ghi cho DB — tách worker trước chỉ di chuyển chỗ đứng hàng đợi, không giảm tải; và KPI của C chỉ đo được khi có số liệu hàng đợi của B-full.

---

## 1. BỐI CẢNH + BẰNG CHỨNG

### 1.1 Chuỗi bằng chứng "Socket timeout" — triệu chứng đã bị bắt sống 2 lần

| Nguồn | Bằng chứng | Kết luận |
|---|---|---|
| `src/lib/db.ts:121-134` (Task 33 / R15) | Quan sát gốc R11 §8.3: **51 lỗi** "Socket timeout (the database failed to respond…)" tập trung ĐÚNG lúc run-close ghi bùng nổ. Fix 3 tầng đã làm: (1) `?socket_timeout=15` cho mọi connection pool, (2) tầng R14 giảm nguồn contention, (3) `withSqliteRetry` lưới an toàn. Comment kết: *"REOPEN nếu 'Socket timeout' tái xuất dưới tải thật — bước kế tiếp khi đó: **write-queue architecture**"* | Điều kiện REOPEN **đã xảy ra** (dòng dưới) → write-queue là bước được chỉ định sẵn, không phải ý tưởng mới tự phát |
| `src/lib/db.ts:217-234` (Task 33 §0b lượt 2) | Danh sách burst run-close đo thật: *"metrics + verdict resolve + QEntry + token persist + auto-train + auto-learn + ledger **đồng thời**. SQLite 1 writer: hàng đợi vượt timeout query engine → lỗi"*. Thiệt hại đã đo khi không retry: updateQ mất vĩnh viễn tín hiệu Q-learning (QEntry=0 → Brain-C "Lệnh" đứt nguồn); persistAgentRunRecord fail → row kẹt `'running'` tới orphan-sweep 30' | Đây chính là **danh sách call-site S2 sẽ chuyển qua batcher** — blueprint không tự chế danh sách, dùng đúng danh sách đã đo |
| `Bug_v2.md` (mục OPUS-VERDICT-1, "Bằng chứng phụ thu được miễn phí") | Live 2026-10-20 OBSERVE-PROTOCOL-1: *"DB SQLite bão hòa khi nhiều writer chạy song song (Omega goal-loop + review + observation events): Socket timeout trên toolMetric/workingMemory/create + interactive transaction 5s bị kéo 15s (ledger run.heart) — bằng chứng sống cho R17 B-full còn treo blueprint"* | "Socket timeout" **tái xuất dưới tải thật** — điều kiện REOPEN của db.ts:132 thỏa mãn đúng chữ |
| `src/lib/observation/ledger.ts:272` | Comment: *"$transaction expired 5000ms" dưới cụm ghi run-close* — interactive transaction 5s mặc định của Prisma bị contention kéo vượt | Chỉ 4 file dùng `$transaction` toàn repo (metrics-db, observation/trace, observation/ledger, orchestration/session-resume) — mặt bằng giao dịch rất mỏng, phần còn lại là hàng chục create/update rải rác tự retry |

### 1.2 Chuỗi bằng chứng restart loop — hung thủ đã bị đối chiếu bằng exit code

| Nguồn | Bằng chứng | Kết luận |
|---|---|---|
| docs/QUAN-SAT-LUOT-7-FIX-R17.md §2.1 (khảo sát exit code) | 94 restart nhịp ~55s đều đặn: `exited via signal [SIGINT]` theo nhịp RSS 2.1–2.2GB; pipe-error ×19 chỉ là **triệu chứng** (Next dev tự nuốt, không giết process); hung thủ thật: **RSS boot ratchet**. MemWatchdog 1900×20s sau đó THẮNG CUỘC ĐUA (self-exit sạch + checkpoint flush) | Bài học R17 §7-1: *"nghi phạm số 1 phải được đối chiếu bằng exit code, không bằng suy diễn" — áp dụng y nguyên cho blueprint này: Socket timeout là triệu chứng của burst (→ B-full), RSS ratchet là hung thủ thật của restart (→ C) |
| `observation-live.md` 15:19–15:20 (phiên quan sát live, bản ghi mới NHẤT — sau FB-F1F6) | Crash loop tái xuất **sau khi 6 fix F1-F6 đã vào**: PM2 restart 167→168→169→170 trong ~2 phút; RSS 2489MB → 2407MB → 2518MB ≥ HARD 2100MB → `[SelfExitDrain] exit(1)` mỗi chu kỳ ~20–30s; boot lại RSS nhảy ~73MB → leo ~2.5GB trong vài chục giây | 6 fix F1-F6 (delegation/ladder/verdict/utility/no-progress/attempts) xử lý đúng tầng của chúng, nhưng **vấn đề cấu trúc process còn nguyên** — đây là lý do tồn tại của blueprint này |
| `pm2 list` 16:21 UTC (phiên này) | `theopusflashlite`: online 59m, **↺173**, RSS 61.9MB (ổn định sau khi loop dứt ~15:21); host RAM 39%; `observe-live`: stopped (phiên quan sát đã có biên bản) | Hệ tự hồi phục được (durable RESUME hoạt động) — nhưng mỗi chu kỳ loop giết request người dùng đang bay + giết job giữa chừng. "Tự hồi phục" ≠ "chấp nhận được" |

### 1.3 Mặt bằng code hiện tại (khảo sát phiên này — tất cả có thể tái hiện bằng grep)

- **KHÔNG tồn tại hạ tầng write-queue nào**: grep `writeQueue|WRITE_QUEUE|batchWrite|writeBatch|writeCoalesc` toàn `src/` = **0 kết quả** → B-full là greenfield, không đụng code cũ cùng loại.
- **Boot worker**: `src/instrumentation-node.ts:1246-1270` — `ensureDbReady() → import('@/lib/goal-loop-worker') → recoverPending() + start()`; singleton `goal-loop-worker.ts:1507` (`globalThis` guard).
- **Người dùng worker từ phía API** (3 import site — đây là mặt `EnqueueFace` phải sống ở cả 2 process khi tách): `src/lib/opus/pipeline.ts:52`, `src/app/api/openclaw/chat/route.ts:73` (gọi `goalLoopWorker.enqueue({...})` → `durableJobId`, route.ts:1248), `src/app/api/goal-loop-jobs/route.ts:38`.
- **Cờ vận hành worker sẵn có** (`.env:314-316` + header goal-loop-worker.ts): `GOAL_LOOP_WORKER_TICK_MS=5000`, `GOAL_LOOP_MAX_CONCURRENT=1` (R14), checkpoint/heartbeat/stall-preempt/mutex-starve/adaptive-concurrency/orphan-sweep, `GOAL_LOOP_MAX_ATTEMPTS` 2→5 (F6).
- **Mini-services chạy IN-PROCESS** (instrumentation.ts header): openclaw-gateway :18789 + opencode-server :18790 + gateway-bridge :18791 — cộng Next server + worker + organs cùng 1 process → lý do trực tiếp RSS ratchet.
- **ecosystem.config.cjs**: 2 app (theopusflashlite qua `scripts/pm2-start.sh`, qdrant) → worker tách ra là **app thứ 3**, không đụng 2 app cũ.
- **Gate** (FB-F1F6 R2): `bun scripts/quality-gate.mjs` PASS 2237/0 fail (66.756 expect, 107 file) + typecheck 0 + eslint 0 + check:imports PASS + smoke 5/5 (build SKIP local theo `.quality-gate.local`) — nền để mỗi wave re-gate.
- **R17 §2.3原 văn**: B = *"batch write cuối chu kỳ thành 1 transaction — rủi ro cao (sửa vòng đời run); chỉ mới khảo sát; cần blueprint riêng"*; C = *"tách worker goal-loop khỏi process API — lớn, đúng đề xuất R16 6.2 'cần blueprint riêng'"*; KPI *"1 run goal-loop đầy đủ không restart + API p95 < 5s" — chưa đối chiếu được* (chưa có run nào chạy trong phiên đó).

---

## 2. BỐN VẤN ĐỀ (P1–P4) — hiện tượng → bằng chứng → gốc rễ

### P1. SQLite 1-writer bão hòa dưới cụm ghi đồng thời (run-close burst)
- **Hiện tượng:** "Socket timeout" trên create (toolMetric/workingMemory), interactive transaction 5s bị kéo 15s (ledger run.heart), updateQ mất tín hiệu Q-learning.
- **Bằng chứng:** §1.1 toàn bộ (51 lỗi R11 + tái xuất OBS-1 + db.ts Task 33 thiệt hại đo được).
- **Gốc rễ:** N nguồn ghi đồng thời đập vào 1 writer SQLite **không qua hàng đợi nào** — mỗi site tự retry (`withSqliteRetry`) giảm MẤT DỮ LIỆU nhưng **không giảm ĐỈNH contention** (đỉnh do số writer đồng thời quyết định, retry chỉ lặp lại đỉnh đó). busy_timeout 15s là tầng 1 đúng — nhưng là tầng *chịu đựng*, không phải tầng *cấu trúc*.

### P2. Write path phân tán — không có trung tâm
- **Hiện tượng:** chỉ 4 file có `$transaction`; phần còn lại là create/update rải rác từng chỗ; không ai nhìn thấy TOÀN BỘ luồng ghi của 1 tick (không có chỗ đứng để đo queue depth/flush).
- **Bằng chứng:** §1.3 (grep `$transaction` = 4 file; grep writeQueue = 0).
- **Gốc rễ:** thiếu **đơn vị kiến trúc** cho đường ghi — mọi fix đến giờ đều *per-site* (retry từng nơi, socket_timeout từng pool). P1 là triệu chứng, P2 là chỗ đứng cấu trúc của nó.

### P3. Worker + API + mini-services cùng process — restart giết lẫn nhau
- **Hiện tượng:** RSS boot ratchet 2.1–2.5GB → MemWatchdog self-exit → PM2 restart toàn bộ: request người dùng đang bay bị giết, job giữa chừng phải RESUME, API mù trong ~5s/lần.
- **Bằng chứng:** §1.2 (crash loop 15:19–15:20 sau F1-F6; R17 §2.1 exit-code; instrumentation.ts header mini-services in-process).
- **Gốc rễ:** **rủi ro lỗi chia sẻ cùng không gian bộ nhớ** — bộ nhớ của worker (goal-loop + organs + 3 mini-services) và API dùng chung 1 process, 1预算 RSS. Worker chết kéo API chết theo và ngược lại. Durable checkpoint (R18) làm hậu quả *khả biến* (RESUME được) — nhưng không làm nguyên nhân *biến mất*.

### P4. Không thể đo tách bạch — KPI R17 còn treo
- **Hiện tượng:** KPI "1 run đầy đủ không restart + API p95 < 5s" **chưa đối chiếu được** (R17 §2.3); không trả lời được "worker ăn bao nhiêu RAM? API p95 bao nhiêu nếu không có run?".
- **Bằng chứng:** R17 §2.3 nguyên văn + pm2 chỉ có 1 process app (§1.3) → mọi số đo là hỗn hợp.
- **Gốc rễ:** thiếu ranh giới đo. P4 chỉ giải được bằng C (tách process) — và số liệu flush của B-full (W1) là đầu vào so sánh cho W2.

---

## 3. NGUYÊN TẮC THIẾT KẾ (theo directive user kế thừa — KHÔNG xử lý bằng cap)

1. **Cấu trúc thay vì cap** (kế thừa nguyên tắc EXECUTION-EFFICIENCY §3): không giảm tải bằng cách cắt việc/giảm attempts/hạ ngạch — giảm tải bằng cách sắp hàng.
2. **Chỉ batch ĐUÔI ghi, không batch đường TỚI**: mọi write mà kết quả được tiêu thụ ngay (id trả về caller dùng tiếp, verdict chốt chuỗi phụ thuộc, chat message cần id trả UI) — GIỮ NGUYÊN trực tiếp. Batcher chỉ nhận fire-and-forget.
3. **Đơn writer trong process, DB là bus giữa process**: không thêm middleware ngoài (không Redis/Kafka), không IPC mới giữa API-worker (checkpoint/claim/mutex/heartbeat đã DB-durable từ R18 — dùng lại, không phát minh).
4. **At-least-once + idempotent**: op phải chạy lại an toàn (upsert-first where possible); thất bại flush **không được drop im lặng** — ghi debt (kind:'infra') theo đúng "đường ghi nợ thứ 4" (R17 6.1) + giữ batch để flush kế (bounded).
5. **Giữ thứ tự nhân quả trong 1 flush**: FIFO theo arrival, KHÔNG sort lại trong batch (đỡ phá thứ tự "verdict sau review row") — coalesce same-row chỉ khi op tự khai `idempotencyKey`.
6. **Flag-gated default OFF** (mẫu softmax đã duyệt): mọi thay đổi có cờ, pilot ON từng run, rollback = đổi env + restart. Default giữ hành vi cũ cho máy khác (kế thừa ghi chú vận hành R18).
7. **Đo trước/sau cùng một giao thức quan sát** (5/5 cờ ON sẵn — FB-F1F6 ghi: "bằng chứng hồi quy trên nhiệm vụ thật sẽ tự đến ở mission kế"): KPI chỉ công nhận khi có run thật đầy đủ, không tự kết luận từ unit test.
8. **Fail-open đúng lớp**: batcher fail-open (đường phi-critical), đường critical giữ retry ném lỗi thật như hiện tại — không nuốt chéo lớp.

---

## 4. GIẢI PHÁP (S1–S4, map 1-1 với P1–P4)

### S1. `WriteBatcher` — hàng đợi ghi đơn writer, coalesce (chỉ set-semantics), flush 2 pha, 4 trigger (fix P1 + P2 — đây là "B-full"; nâng theo REVIEW-1 P0-1/P0-2/P0-3, P1-1/P1-2/P1-5, P2-1/P2-3)

Module mới `src/lib/db-write-batcher.ts` (flat theo convention `src/lib/tool-metrics-recorder.ts`; KHÔNG đụng `src/lib/db.ts` ngoài import):

**4.1a · Kiểu op — 2 làn tách bạch bằng type (P0-3 + P2-1):**
```
SetOp  = { kind: 'create' | 'upsert' | 'update'
         ; model: BatchableModel          // delegate-map typed — union đóng theo bảng audit §4.2, không mở động
         ; data / where / create / update: unknown
         ; idempotencyKey?: string }      // CHỈ làn này được khai key → coalesce last-wins TRONG 1 batch đang chờ
RawOp  = { kind: 'raw'                    // RMW: đọc-hiện-tại-tính-lại (P0-3)
         ; fn: (tx: PrismaTxClient) => Promise<void> }  // KHÔNG có idempotencyKey — không bao giờ coalesce; FIFO nguyên vẹn trong tx
```
- **Type-guard runtime tại enqueue (P0-3):** `SetOp.data/update` bị deep-scan — phát hiện `increment|decrement|multiply|divide` ở bất kỳ cấp nào → **throw TypeError ngay tại enqueue** ("RMW phải đi làn raw hoặc đường direct"). Coalesce chỉ giữa các SetOp cùng `idempotencyKey` trong cùng batch chờ (last-wins — đúng set-semantics tuyệt đối); RawOp + op không khai key luôn giữ FIFO.
- **Delegate-map typed (P2-1):** `BatchableModel` là union tên delegate được phép (`'toolMetric' | 'workingMemory' | 'dailyTokenByProvider' | …`); map `model → tx delegate` kiểm tra đủ kiểu khi compile — không `any` tràn ranh giới batcher.
- `enqueueWrite(op)` → `Promise<void>` — **reject có type `BatchDroppedError`** khi op rơi vào batch bị drop (P1-1 — không treo vô định); pending xuyên chu kỳ retained-retry nhưng có trần (bound §4.1c). `enqueueWriteFireAndForget(op)` — catch nội bộ → debt-log, không throw (đa số call-site §4.2). **KHÔNG trả kết quả row** — ai cần id thuộc đường direct (nguyên tắc §3.2).

**4.1b · Flush — 4 trigger OR (P0-1):**
1. Timer `DB_WRITE_BATCH_FLUSH_MS` (default **1000ms** — ngắn hơn window contention đo thật vài giây của Task 33);
2. Depth ≥ `DB_WRITE_BATCH_MAX_OPS` (default **200**);
3. **`flushNow()` (mới — P0-1.1):** gọi tại run-close/finalize — đúng nơi burst đo được + crash tập trung; rỗng hóa queue ngay trước cửa sổ nguy hiểm nhất;
4. **Shutdown drain (P0-1.2):** `drainWriteQueueForExit({ boundMs })` hook vào `selfExitWithDrain` (instrumentation-node.ts:105-115) với **bound riêng `TMO_EXIT_WRITE_DRAIN_MS` (default 3000ms), TÁCH khỏi hợp đồng 600ms response-drain hiện có**: exit chờ `max(600ms, drain thật)` nhưng KHÔNG vượt 3s — queue rỗng thì exit đúng 600ms như hôm nay (0 thay đổi khi trống). Exit sớm vẫn thắng kernel (đúng thiết kế vòng 11c).

Thân pha 1: `db.$transaction(async tx => { for (op of batch) apply(tx, op) }, { timeout: DB_WRITE_BATCH_TX_TIMEOUT_MS })` — default **30s** (trần GIAO DỊCH, khác tầng busy_timeout chịu đựng db.ts:135).

**4.1c · Flush 2 pha + danh hiệu bền trung thực (P0-1.3 + P0-2):**
- **Pha 1:** batch tx như trên — cả-batch qua `withSqliteRetry` (chủ sở hữu retry đường batched — P1-2; call-site bỏ retry riêng khi đã chuyển qua batcher; raw fn KHÔNG tự withSqliteRetry).
- **Pha 2 — per-op salvage (P0-2):** pha 1 fail **non-transient** → KHÔNG giữ nguyên batch chờ flush kế; chia nhỏ — **mỗi op một mini-tx riêng** (`withSqliteRetry` từng op); op poison (P2025, constraint…) → `recordDebtIssue({kind:'infra'})` + **loại khỏi batch**; op lành phải commit đủ — một op hỏng không chặn 199 op kia (chấm dứt vòng lặp fail-giữ-fail của v0.1).
- **Hết retry cả 2 pha:** console.error + debt + giữ batch chờ flush kế, **bound 2 batch chờ** (tràn → drop batch CŨ nhất, MỖI op drop có debt issue riêng + reject `BatchDroppedError` cho mọi enqueueWrite đang chờ batch đó).
- **Danh hiệu bền (trung thực — P0-1.3):** "at-least-once qua contention + clean self-exit (drain ≤ 3s); **at-most-once qua SIGKILL/kernel OOM — cửa sổ mất ≤ FLUSH_MS (1s) × ≤ MAX_OPS (200)**". KHÔNG tuyên "crash-proof" — danh hiệu đó sai (REVIEW-1 P0-1).
- At-least-once nội batch: op phải idempotent — bảng audit §4.2 ghi cột này từng site; migrate lên upsert-set nơi schema cho phép.

**4.1d · Đo (P2-3):** observation instrumentation (5/5 cờ ON sẵn) nhận: `queueDepth` · `batchSize` · `flushMs` · `dropCount` · `retryCount` · **`holdMs`** (P1-5 — target < 300ms điển hình; vượt `DB_WRITE_BATCH_HOLD_TARGET_MS` → flush kế tự split batch nhỏ hơn — không giữ write-lock SQLite dài block claim/heartbeat/checkout của worker + ledger interactive tx) · **`salvageSplits`** · **`poisonCount`** (P0-2). DEVLOG 1 dòng/flush khi có số bất thường. Không đo = không ship (nguyên tắc §3.7).

**4.1e · Flag:** `DB_WRITE_QUEUE` (default **off**). OFF = module tồn tại nhưng `enqueue*` thực thi op **trực tiếp với withSqliteRetry** (pass-through — hành vi identical hôm nay; retry do batcher nắm cả 2 mode); 0 thay đổi hành vi, gate phải PASS y hệt cả 2 mode (regression chống hai-mode divergence). Pilot ON từng run như mẫu softmax đã duyệt.

### S2. Bảng AUDIT call-site (cổng migrate — P0-3) — nguồn: danh sách burst Task 33 (db.ts:222-224) + khảo sát dòng code phiên này

Tất cả file:line dưới đây đã đối chiếu trực tiếp (phiên này). Cột "đường" quyết định batched/direct — lý do từng dòng là HỢP ĐỒNG, không phải tùy chọn:

| # | Call-site | File:line | Loại | Coalesce | Idempotent | Đường | Lý do hợp đồng
|---|---|---|---|---|---|---|---|
| 1 | `toolMetric.create` | tool-metrics-recorder.ts:91 | set/append | không (create append-only) | dup-1-row chấp nhận (:84-86) | **BATCHED** | OBS-1 "Socket timeout trên toolMetric/create"; fail-open (:103-105) hợp fire-and-forget |
| 2 | debt-count (đường 6.1c R17) | tool-metrics-recorder.ts:116 | READ | — | — | **DIRECT** | read luôn direct (nguyên tắc §3.2 đảo) |
| 3 | `workingMemory.create` | memory-tiers.ts:213 | set/append | không | dup-1-row chấp nhận (:209-211) | **BATCHED** | "Socket timeout 6 lần/giờ" (:206-208) — đường lỗi NHIỀU NHẤT cụm run-close |
| 4 | TokenTracker persist (4-5 upsert-set: total/provider/slot/model) | llm.ts:995-1054 | SET tuyệt đối (tokens ghi đè) | **CÓ — idempotencyKey = bảng+date+key** (last-wins ĐÚNG cho set: giá trị sau đè giá trị trước) | dirty-state tự lành (db.ts:228) | **BATCHED** | loop per-provider/slot/model = nguồn burst "token persist" (Task 33); retryDbOp dời chủ sở hữu về batcher (P1-2) |
| 5 | `updateQ` (QEntry) | q-table.ts:322-354 | **RMW** | **CẤM (P0-3)** | — | **DIRECT giữ nguyên** | (a) RMW + observation writeOne interleaved (:360-368) — vào batch tạo allocator sự kiện thứ 2 (P0-5); (b) đã có chuỗi in-process tự serialize (:244-251: "1 process duy nhất + QEntry chỉ ghi qua updateQ → tuần tự hoá in-process kín mọi writer") — không góp phần concurrent burst; (c) comment :248 cấm $transaction giữ lock. Thiệt hại Task 33 về QEntry đã được che bằng withSqliteRetry + chuỗi — giữ nguyên là đúng, không phải trốn |
| 6 | auto-learn creates: `localRelationship` :307 · `agentInsight` :333 · `learningLog` :348 (3 create BATCHED) + `autoLearnRecord` :218 (**DIRECT — cần record.id** :231 → observeEvent rowKey :238 + update :370 dùng recordId) | auto-learn.ts | set/append / (record: cần-id) | không | — | **3 BATCHED + 1 DIRECT** (điều chỉnh v0.2-impl: record.id tiêu thụ ngay :231 — thêm họ "cần-id" như #7) | nguồn burst "auto-learn" (Task 33); fire-and-forget fail-open từng create giữ nguyên (:298-300) |
| 7 | `localEntity.create` | auto-learn.ts:284 | set/append | — | — | **DIRECT BẮT BUỘC** | **CẦN created.id** (:296 `entityIdByName.set(..., created.id)` → relationships :314-315 tham chiếu) — P0-3 "cần-id-trả-về" |
| 8 | `updateLatestAgentRunRecord` (metrics run-close) | metrics-db.ts:631 | SET theo id (buildAgentRunSetClauses) | không (update theo id) | idempotent (:640-644) | **DIRECT BẮT BUỘC (đổi khi triển khai W1 — xem §9 v0.2-impl)** | nguồn burst "metrics" (Task 33 — "row kẹt running tới orphan-sweep 30'" :641-643); **return `updated > 0` là control-flow** (agent-run-tracker.ts:471-472: update 0 dòng → fallback `insertAgentRunRecord` :474-497 — caller TIÊU THỤ kết quả write để quyết insert) + delegate-bridge 2 nhánh (:639) — ép batch = vi phạm hợp đồng "không batch đường TỚI" |
| 9 | `recordArbiterVerdict` INSERT | metrics-db.ts:261 | set/append | — | — | **DIRECT giữ nguyên (điều chỉnh so v0.1)** | verdict là ĐƯỜNG TỚI của arbiter (đọc lại quyết định CONTINUE/PIVOT/ESCALATE) — v0.1 dự định batch là SAI, REVIEW-1 §10.4-3 bắt buộc rút theo nguyên tắc §3.2 |
| 10 | observation ledger events (`writeOne` + TX kết cấu run.heart/run.end) | ledger.ts:277 | — | — | — | **DIRECT giữ nguyên (P0-5)** | rút khỏi list v0.1 — RO-4 single-writer seq; giữ nguyên toàn bộ đường writeOne |

**Phủ burst Task 33 (sau điều chỉnh #8):** "token persist" (#4) + "auto-learn" (#6) + "toolMetric" (#1) + "workingMemory" (#3) → BATCHED. "QEntry" (#5) + "verdict" (#9) + "ledger" (#10) + "metrics run-close" (#8 — control-flow return) → DIRECT có lý do hợp đồng từng dòng (không trốn: #5 đã serialize in-process kín; #8/#9/#10 là đường TỚI/control-flow).

**Riêng W2 lưu ý (#5):** chuỗi in-process của updateQ dựa giả thiết "1 process" (q-table:250) — split mode chỉ có WORKER chạy goal-loop nên vẫn kín; ngoại lệ duy nhất: inline-fallback khi DB-degraded (P1-6) chạy trong process API — kịch bản hi hữu đã có guard, KPI W2 theo dõi.

Mỗi call-site BATCHED 1 regression test (mẫu r132-r136) + 1 test integration burst (500 ops/1s — tái hiện mật độ run-close, P2-2) đo: 0 "Socket timeout", flush p95 < 1s, drop 0; **2 phép đo bổ sung (P2-2):** (a) direct-path interleave — chat create latency không hồi quy khi batch ON; (b) **định lượng ops mất/crash** (kill -9 giữa burst) — đầu vào KPI #9.

### S3. Tách worker thành process riêng (fix P3 — đây là "C"; nâng theo REVIEW-1 P0-4/P0-5, P1-3/P1-6)

**4.3a · Flag:** `GOAL_LOOP_WORKER_MODE=inline|split` — default **inline** (= hành vi hôm nay, gate regression phải PASS ở cả 2 mode). `split` = bật topology mới.

**4.3b · Topology split:**
- **API process** (`theopusflashlite`, giữ nguyên): Next server + routes + `EnqueueFace` (enqueue qua DB — singleton goal-loop-worker.ts:1507 dùng được ở cả 2 process vì enqueue bản chất là DB write; thêm cửa ở instrumentation-node.ts:1246: `split` → KHÔNG gọi `start()`/`recoverPending()` — chỉ import type + enqueue path).
- **Worker process** (pm2 app mới `theopus-worker`, app thứ 3 trong ecosystem.config.cjs — không đụng 2 app cũ): entry `scripts/worker.mjs` boot theo đúng chuỗi instrumentation-node.ts:1258-1266 (`ensureDbReady → recoverPending → start()`) + MemWatchdog **riêng ngưỡng** `WORKER_MEM_WATCHDOG_MB` + **KHÔNG HttpWatchdog** (không mở port).
- **Heart-movement watchdog (MỚI — P1-3):** thay cho HttpWatchdog — worker treo (await kẹt, RSS thấp) không thể được phát hiện bằng STALL (STALL chỉ pause job — pause không chữa process treo). Cơ chế: biến đếm "sự kiện sống" (tick hoàn tất / claim / heartbeat-write / checkpoint) cập nhật mỗi activity; interval kiểm tra `WORKER_HEART_MOVEMENT_MS` (default 120s): không có sự kiện sống nào trong 2 lần kiểm tra liên tiếp → `[WorkerHeartMovement] self-exit` → pm2 restart. DB-liveness có sẵn (GOAL_LOOP_STALL_WARN_MS cảnh báo UI — R18) giữ nguyên làm tầng hiển thị.
- **Điều kiện cần cho split (P0-5):** `ObservationEvent_seq_key` unique-collision phải nằm trong họ transient + retry của db.ts (tx mới đọc lại MAX(seq) — an toàn vì tx cũ chưa commit thì chưa chiếm seq). W2 KHÔNG bật split trước khi fix này vào — không phải tùy chọn.
- **DB là bus duy nhất**: claim/mutex/checkpoint/heartbeat/RESUME đã durable (R18) — 0 IPC mới, 0 schema mới bắt buộc.

**4.3c · Trục kế thừa nguyên vẹn:** 3 import site API (opus/pipeline:52, chat route:73, goal-loop-jobs:38) không đổi chữ — chỉ đường xuống của `start()` tách ra. Singleton `globalThis` guard hoạt động đúng ở cả 2 process (mỗi process 1 instance — đúng ý đồ).

**4.3d · Restart policy tách + inline-fallback minh thị (P1-6):** worker restart (own `max_restarts/restart_delay`) KHÔNG chạm API; API restart không giết job đang chạy trong worker. **Inline-fallback giữ nguyên là CHỦ ĐÍCH** (chat route:1235-1246: enqueue lỗi → chạy INLINE, có sẵn guard cấm double-run khi job row đã tạo): job có thể chạy trong process API dưới điều kiện DB-degraded — hành vi cũ có guard, không phải regression; ghi minh thị để fixbug W2 không "phát hiện" nó là bug.

### S4. Đo tách bạch + rollback tức thì (fix P4 — phần 2 của C; KPI điều chỉnh theo P0-4)

- Observation trace thêm `processRole: 'api' | 'worker'` (fingerprint không dedupe oan 2 process — bài học r126 B1.2: phân biệt bằng đặc trưng, không tự chế). Cài đặt tối thiểu: env `TMO_PROCESS_ROLE` (worker.mjs đặt `worker`; mặc định `api` cho mọi process không đặt — inline mode hôm nay đúng là 'api').
- pm2 metrics đo riêng từng process: RSS/restart count/uptime — bảng KPI §6 chỉ công nhận số tách bạch này.
- **KPI #4/#5 điều chỉnh theo P0-4** (đo đúng thứ S3 làm được — cách ly — không đòi S3 diệt cold-compile của Next dev):
  - KPI #4 gate: "job bị giết khi API restart = 0"; API restart count → **báo cáo** (không gate), gắn tên nợ follow-up **"API compile-ratchet boot"** (§7.10).
  - KPI #5 gate: "đóng góp của worker/organs vào RSS API = 0 sau tách (delta trước/sau)"; RSS peak boot API trước/sau → **báo cáo** cho nợ compile-ratchet.
- Rollback: `GOAL_LOOP_WORKER_MODE=inline` + `pm2 restart` — topology cũ trở lại trong 1 chu kỳ restart; KHÔNG cần migrate ngược.

---

## 5. LỘ TRÌNH TRIỂN KHAI

| Wave | Scope | Bước (đúng khuôn chỉ thị nền: sửa xong → fixbug → báo cáo → push) | Gate dừng |
|---|---|---|---|
| **W1 — B-full** | S1 + S2 | (1) Viết `db-write-batcher.ts` + unit (FIFO/coalesce-guard/salvage/drop-bound/drain/typing) + integration burst 500 ops/1s **kèm 2 phép đo P2-2 (direct interleave + kill-9 lost-ops)** → (2) migrate call-site BATCHED theo bảng audit §4.2 (4 site: #1 #3 #4 #6), mỗi site 1 regression → (3) full gate `quality-gate.mjs` (phải PASS cả `DB_WRITE_QUEUE=off` lẫn `=on`) → (4) **giao thức fixbug** (rà soát → fix → rà lại đến sạch) → (5) pilot `DB_WRITE_QUEUE=on` + 1 run thật đầy đủ dưới giao thức quan sát → đối chiếu KPI #1-3 + #7 + #9 → (6) báo cáo + push | KPI #1 (Socket timeout/run = 0) chưa đạt → không sang W2, rà lại S2 |
| **W2 — C** | S3 + S4 | (0) **fix điều kiện cần:** `ObservationEvent_seq_key` vào họ transient db.ts (P0-5) → (1) `scripts/worker.mjs` + cửa mode instrumentation-node:1246 + ecosystem app 3 + heart-movement (P1-3) → (2) regression 2 mode (inline PASS y hệt hôm nay — chống divergence) → (3) full gate → (4) **giao thức fixbug** → (5) pilot `split` + 1 run thật đầy đủ → đối chiếu KPI #4(gate mới)/#5(gate delta)/#6/#8 (đặc biệt KPI R17 treo: API p95 < 5s) → (6) báo cáo + push | KPI #4-mới (job bị giết khi API restart) > 0 → cách ly chưa thật, rà lại S3. **KHÔNG gate API restart count** (P0-4) — đó là nợ "API compile-ratchet boot" |

**Vì sao B-full trước C (chốt thứ tự):**
1. B-full giảm **tổng tải ghi** lên DB — nếu tách worker trước, 2 process vẫn đập cùng DB (SQLite file-level lock) → tách trước chỉ di chuyển chỗ đứng hàng đợi, có thể tệ hơn (thêm writer song song).
2. KPI của C cần số flush/depth của B-full làm baseline so sánh (P4 giải bằng cả hai, W2 đối chiếu được nhờ W1 đã đo).
3. R17 §2.3 xếp B là "rủi ro cao (sửa vòng đời run)" — pilot flag-off của W1 cho phép kiểm chứng không hồi quy trước khi đụng topology (C) lớn hơn.

---

## 6. KPI NGHIỆM THU (chỉ công nhận khi có run thật đầy đủ — nguyên tắc §3.7)

| # | KPI | Baseline (bằng chứng) | Mục tiêu W1 | Mục tiêu W2 |
|---|---|---|---|---|
| 1 | "Socket timeout" trong dev.log / 1 run đầy đủ | 51 lỗi (R11 §8.3) + tái xuất OBS-1 (toolMetric/workingMemory/ledger) | **0** | 0 |
| 2 | Interactive tx p95 (ledger + trace) | 5s expired bị kéo 15s (ledger.ts:272, OBS-1) | **< 2s** | < 2s |
| 3 | Flush p95 / drops / depth | — (chưa tồn tại hàng đợi) | **< 1s** · **0 drop** · depth ≤ 200 (bound không tràn) | giữ |
| 4 | **Cách ly blast radius (P0-4 — gate MỚI):** job bị giết khi API restart | Crash loop hôm nay giết cả API lẫn job (↺167→170, 15:19–15:20) | (thuộc W2) | **0** — job chạy trọn vẹn trong worker qua API restart |
| 4b | *Báo cáo (KHÔNG gate — P0-4):* API restart count / run | ↺167→170 trong ~2 phút (15:19–15:20) | (thuộc W2) | báo cáo số liệu cho nợ "API compile-ratchet boot" (§7.10) |
| 5 | **Đóng góp worker/organs vào RSS API (P0-4 — gate MỚI):** delta trước/sau tách | Hỗn hợp 2.4–2.5GB peak / 61.9MB ổn định (cùng process) | (chưa tách được) | **= 0** (sau tách, RSS API không còn chứa worker); RSS peak boot API → báo cáo (§7.10) |
| 6 | API p95 dưới run đầy đủ (KPI R17 §2.3 treo — "chưa đối chiếu được") | Chưa đo được | — | **< 5s** |
| 7 | Mất dữ liệu write qua contention (at-least-once + idempotent) | updateQ mất tín hiệu Q-learning; row kẹt 'running' 30' (Task 33) | **0** (replay burst: mọi op có mặt trong DB) | 0 |
| 8 | Claim/heartbeat/checkout p95 dưới tải batch (P1-5) | Chưa đo (hôm nay không có hàng đợi) | **< 500ms** | < 500ms |
| 9 | Ops mất/crash SIGKILL — at-most-once window (P0-1.3) | Chưa đo (hôm nay mất trắng theo contention) | **≤ FLUSH_MS × MAX_OPS (1s × 200) — định lượng kill -9 giữa burst** | giữ (đo lại sau split: worker crash không còn kéo API) |

---

## 7. NHỮNG GÌ KHÔNG LÀM (anti-goals)

1. **KHÔNG chuyển SQLite → Postgres/MySQL** — đơn-writer là *đặc tính được thiết kế theo* (WAL + busy_timeout + queue hóa), không phải lỗi cần chạy trốn.
2. **KHÔNG thêm middleware ngoài** (Redis/Kafka/queue service) — hàng đợi trong process; DB là bus giữa process.
3. **KHÔNG multi-writer / sharding SQLite** — nghịch hướng với toàn bộ bằng chứng contention.
4. **KHÔNG xử lý bằng cap** — không giảm attempts/đùi tải/cắt việc để hạ số lỗi (kế thừa directive user EXECUTION-EFFICIENCY §3).
5. **KHÔNG tăng busy_timeout nữa** — 15s là tầng chịu đựng đủ (db.ts:135); tầng cấu trúc (hàng đợi) mới là lời giải; tăng thêm chỉ che triệu chứng.
6. **KHÔNG IPC mới giữa API-worker** (socket/HTTP nội bộ) — checkpoint/claim/heartbeat DB-durable R18 dùng lại nguyên vẹn.
7. **KHÔNG default-ON** — mọi cờ pilot-off trước (mẫu softmax đã duyệt); machine khác giữ hành vi cũ (kế thừa ghi chú vận hành R18).
8. **KHÔNG trộn scope P-NEW-4** (triage classifier ~10K tokens/call — bảng nợ R17 §6) vào bản này — cần đợt đo riêng, trộn scope làm hỏng thuộc tính fixbug "scope khép".
9. **KHÔNG batch đường TỚI** (nguyên tắc §3.2) — kể cả khi trông "tiện": trả id cho caller là hợp đồng, vi phạm một chỗ là cả chuỗi phụ thuộc chết.
10. **KHÔNG scope-creep nợ "API compile-ratchet boot"** (P0-4): cold-compile Next dev RSS 2.1-2.2GB là nguyên nhân restart của process API — KHÔNG thuộc S3 và KHÔNG được sửa trong bản này (khó lường vì đụng build pipeline). S3 chỉ cách ly; gốc ratchet dành blueprint riêng sau khi W2 đo RSS peak boot API (báo cáo KPI #4b/#5).

---

## 8. PHỤ LỤC — TÁI HIỆN ĐIỀU TRA (mọi claim §1 đều lặp lại được)

```
# P1/P2 — write burst & thiếu hàng đợi
rg -n "Socket timeout" /home/z/my-project/dev.log          # đếm dưới 1 run thật
rg -n "writeQueue|batchWrite|writeBatch" src/               # = 0 (greenfield)
rg -ln '\$transaction\(' src/lib/                            # = 4 file
# P3 — restart loop & exit code
pm2 list                                                    # cột ↺ + mem (đo trước/sau)
rg -a "SelfExitDrain|MemWatchdog|PM2 RESTART" /home/z/my-project/dev.log | tail -40
# Boot chain + import site
rg -n "goalLoopWorker" src/instrumentation-node.ts          # :1246-1270
rg -ln "from '@/lib/goal-loop-worker'" src/                 # 3 site
# Gate 2 mode (khi triển khai)
DB_WRITE_QUEUE=off bun scripts/quality-gate.mjs
DB_WRITE_QUEUE=on  bun scripts/quality-gate.mjs
GOAL_LOOP_WORKER_MODE=inline bun scripts/quality-gate.mjs
GOAL_LOOP_WORKER_MODE=split  bun scripts/quality-gate.mjs
# Burst simulation (viết trong W1 test integration — 500 ops/1s)
```

Ghi chú kỹ thuật khảo sát: `rg` trên dev.log phải dùng `-a` (byte \0 — bài học R17 §7-2); exit code đọc `~/.pm2/pm2.log` (dev.log không có — R17 §2.1).

---

## 9. LỊCH SỬ HIỆU ĐỈNH

- **v0.1 — 2026-10-20:** khởi thảo theo chỉ thị user ("Tiến hành viết technical Blueprint cho những gì cần triển khai"). Bằng chứng §1 thu trong phiên này (trực tiếp + trích nguồn đã đối chiếu). Scope = R17 B-full + R17 C (đúng "ưu tiên kế tiếp" FB-F1F6); P-NEW-1 gộp vào B-full; P-NEW-4 + P-R13-1 ghi ngoài phạm vi §7. Chờ duyệt để vào W1.
- **REVIEW-1 — 2026-10-20 (phiên này, user directive "Vào vai kỹ sư AI, kiến trúc sư hệ thống review lại blueprint"):** phê vấn v0.1 bằng đối chiếu code (§10): verdict ⛔ tạm đứng — yêu cầu nâng **v0.2** với **5 P0 + 6 P1 + 3 P2**; thứ tự W1→W2, nguyên tắc §3, anti-goals §7 được duyệt giữ nguyên (§10.4). Chờ duyệt v0.2 để vào W1.
- **v0.2 — 2026-10-20 (cùng phiên, user directive "Nâng lên đi, sau khi hoàn thành nâng cấp blueprint rồi thì tiến hành triển khai blueprint ngay"):** nâng đủ §10.5 — S1 2 làn type + type-guard RMW + delegate-map + BatchDroppedError + 4 trigger (flushNow + drain ≤3s tách 600ms) + flush 2 pha salvage + danh hiệu bền trung thực + metrics 8 số; S2 bảng AUDIT 10 dòng; S3 heart-movement (P1-3) + P2002-seq điều kiện cần (P0-5) + inline-fallback minh thị (P1-6); S4 KPI #4/#5 đổi gate cách ly + nợ "API compile-ratchet boot" (§7.10); §6 thêm #8 claim/heartbeat p95 + #9 ops-mất/crash. User duyệt triển khai ngay.
- **v0.2-impl (W1) — 2026-10-20:** khi triển khai phát hiện 2 hợp đồng mà bảng audit v0.2 đã đánh nhầm — sửa thẳng trong bảng (nguyên tắc "bảng audit là cổng migrate, đối chiếu dòng code thật"):
  (1) **#8 updateLatestAgentRunRecord → DIRECT BẮT BUỘC**: return `updated > 0` là control-flow (agent-run-tracker.ts:471-472: update 0 dòng → fallback insert :474-497) + delegate-bridge 2 nhánh (:639).
  (2) **#6 autoLearnRecord.create → DIRECT**: record.id tiêu thụ ngay (:231 → observeEvent :238 + update :370) — cùng họ "cần-id" với #7 localEntity.
  Sau 2 điều chỉnh: BATCHED = #1 toolMetric · #3 workingMemory · #4 TokenTracker (5 upsert) · #6′ (3 create auto-learn) = 4 nhóm site. Đã triển khai + full gate PASS 5/6 (build SKIP local) + r137 14/14 + r138 10/10 (kể cả KPI #9 kill-9: pending 0/40 — flushed 40/40).

- **v0.2-impl (W2) — 2026-10-20 (cùng phiên, pilot live):** S3+S4 triển khai đúng §4.3 với 3 điều chỉnh theo đối chiếu thật: (a) script là `scripts/worker.ts` (bun chạy TS trực tiếp, không cần .mjs như bản thảo — ecosystem interpreter 'bun'); (b) **FB-W2-R3-01 (phát hiện pilot — P0 vận hành)**: `pm2 restart --update-env` tiêm env của shell hiện hành vào process worker → worker từng nối nhầm DB scaffold (my-project) suốt phiên (sweep 0 job, claim im lặng, "requeue 0" mọi boot) — guard mới tại boot: `.env` TMO là nguồn sự thật DUY NHẤT cho DATABASE_URL, env ngoài khác giá trị → warn + đè lại (regression r139 E8); (c) thêm `WORKER_STATS_LOG_MS` (log stats write-queue chu kỳ 1 dòng JSON — KPI #3/#9 đo được ở process worker mà không mở port, giữ nguyên tắc 0 IPC) + route ops GET /api/observation/write-queue (16 số, READ-ONLY pin r96). **Pilot live** (DB_WRITE_QUEUE=on + split, mission thật Omega dogfood db-write-batcher, job sống qua API restart giữa chừng): **KPI #4 GATE ĐẠT** — restart API 18:04:38Z → job running nguyên vẹn, workerPid không đổi, heartbeat nhích đều QUA restart, worker ↺ không đụng; KPI #1 Socket timeout = 0 toàn cửa sổ; KPI #3 worker: 67 ops / 19 batch, dropCount=0, salvage/poison=0 (flushP95 11039ms outlier trùng đúng lúc API restart đập DB — chunkSize tự halve 200→100 đúng cơ chế P1-5); S4: 145 events processRole='worker'. Nợ ghi nhận (fixbug.md FB-W2): pid-recycling vs isWorkerPidAlive (cần gate phụ heartbeat-staleness — follow-up R18) · scaffold DB bị rải bảng TMO bởi ensureDbReady trỏ nhầm (vô hại, dọn khi user yêu cầu) · API compile-ratchet boot (§7.10 — biện pháp tạm pilot: .env MEM_WATCHDOG_MB=2800 + MEM_WATCHDOG_RSS_HARD_MB=3000 cho boot sống qua ngưỡng cold-compile 2.2-2.6GB). Fixbug FB-W2 khép 4 vòng (R3 = phát hiện pilot); full gate PASS 5/6 (2251+24 test); r139 24/24 + r95 PIN 21/21.

---

## 10. REVIEW-1 (2026-10-20) — phê vấn v0.1 bởi kỹ sư AI / kiến trúc sư hệ thống

- **Đối tượng:** v0.1 @ commit `a7d74f1`.
- **Phương pháp:** đúng giáo trình dự án — verdict-by-evidence: mọi phán quyết đối chiếu tới dòng code (đường dẫn kèm từng phát hiện), không review trên giấy. Điều tra bổ sung thực hiện trong phiên này: q-table.ts:322-354 · schema.prisma:2645-2649 · db.ts:238-255 + 172-179 · ledger.ts:270-297 · chat/route.ts:1235-1246.
- **Verdict: ⛔ TẠM ĐỨNG — chưa duyệt v0.1 vào W1.** Cần v0.2 với 5 sửa P0 (§10.5). Toàn bộ phần đúng thì được duyệt giữ nguyên tường minh (§10.4) — review không "phá cho có".

### 10.1 · Phát hiện P0 — chặn duyệt (5)

**P0-1 · Hàng đợi in-memory không sống sót qua crash — trong đúng hệ thống mà triệu chứng số 1 là crash.**
- Mâu thuẫn nội tại: §4.1c cam kết "at-least-once", nhưng queue nằm trong bộ nhớ process. Chính bằng chứng nền của blueprint (§1.2) là crash loop ~30s/chu kỳ (↺167→170; R17 §2.1: 94 restart/phiên). Kernel OOM/SIGKILL giết process → **toàn bộ queue biến mất và không khôi phục được** — "debt on boot" bất khả thi về mặt thông tin: process mới không biết queue cũ chứa gì.
- Đánh giá trade trung thực: hiện nay mất op khi **contention** (Socket timeout → retry cạn → fail-open). Batcher chữa được điều đó, nhưng **thêm** một chế độ mất mới: mất khi **crash** (cửa sổ flush 1s × depth ≤ 200). Với tần suất crash đã đo, có nguy cơ đổi "mất hiếm nhưng theo contention" lấy "mất mỗi lần process chết" — nghịch với chính động cơ viết blueprint.
- Yêu cầu v0.2 (3 lớp, bắt buộc):
  1. **Trigger flush thứ 4 — `flushNow()` gọi tại run-close/finalize**: burst đo được của Task 33 nằm đúng lúc run-close; rỗng hóa queue ngay trước cửa sổ nguy hiểm nhất (crash cũng tập trung lúc finalize).
  2. **Drain có bound riêng trong SelfExitDrain (≤ 3s, TÁCH khỏi hợp đồng 600ms response-drain hiện có)**: hết bound → debt + exit(1) như cũ — tuyệt đối không kéo dài exit đến mức đua thua kernel (bài học R17 §2.1: watchdog phải thắng cuộc đua bằng cách exit SỚM hơn, không phải chờ lâu hơn).
  3. **Hạ danh hiệu trung thực + KPI định lượng**: "at-least-once qua contention + clean self-exit; **at-most-once qua SIGKILL/kernel OOM (cửa sổ ≤ 1s × ≤ 200 ops)**" — kèm KPI mới "ops mất/crash" đo bằng burst test (kill -9 giữa burst), không phải lời hứa.

**P0-2 · Poison op đầu độc cả hàng đợi.**
- Theo §4.1c hiện tại: cả-batch fail → retry → hết retry → debt + GIỮ batch → flush kế fail y hệt → **một op lỗi cấu trúc (P2025 record-not-found — db.ts:172-179 đã ghi nhận đây là control-flow THƯỜNG GẶP; hoặc constraint violation) chặn vĩnh viễn cả 200 op lành**, và bound "2 batch chờ" làm các batch khỏe phía sau bị drop oan.
- Yêu cầu v0.2: **flush 2 pha** — pha 1: batch tx như thiết kế; nếu fail non-transient → **pha 2: per-op salvage** (mỗi op một mini-tx riêng, `withSqliteRetry` từng op); op poison → debt + loại khỏi batch; op lành phải commit đủ. Metric mới: `salvageSplits`, `poisonCount` (đẩy vào observation instrumentation).

**P0-3 · Coalesce last-wins hủy hoại op RMW (đọc-sửa-ghi) — mất dữ liệu im lặng.**
- Kiểm chứng code: `updateQ` (q-table.ts:322-354) là **RMW thuần** — `findUnique` đọc qValue hiện tại → tính `newQ` theo công thức Q-learning → `upsert { qValue: newQ (set tuyệt đối), visits: { increment: 1 } }`. Nếu caller khai `idempotencyKey` cho 2 updateQ cùng (stateKey, actionKey): coalesce last-wins → **phần đóng góp của op đầu biến mất không dấu vết** — mất đúng tín hiệu Q-learning mà Task 33 đã đo là thiệt hại ("updateQ mất vĩnh viễn → Brain-C đứt nguồn"). `visits: increment` cùng loại rủi ro.
- Yêu cầu v0.2: quy tắc cứng + type-guard tại enqueue: **coalesce CHỈ dành cho set-semantics tuyệt đối** (upsert/update ghi giá trị cuối cùng không phụ thuộc giá trị hiện tại); **RMW — increment, updateQ, mọi công thức đọc-hiện-tại-tính-lại — KHÔNG BAO GIỜ coalesce**, giữ FIFO nguyên vẹn trong tx (tx thấy write của op trước trong cùng batch → ngữ nghĩa chuỗi được bảo toàn). Kèm **bảng audit từng call-site S2** làm cổng migrate từng site, cột: `set|RMW` · `cần-id-trả-về` · `idempotent` · `direct-bắt-buộc`.

**P0-4 · KPI #4 như hiện tại KHÔNG THỂ ĐẠT bởi S3; KPI #5 đo sai thứ cần đo.**
- Blueprint tự dẫn chứng (§1.2, R17 §2.1 verify live): cold-compile route → RSS 2270MB → self-exit. Tách worker đưa organs + mini-services ra khỏi process API, nhưng **boot ratchet của Next dev compile vẫn nằm trong process API** → S3 không diệt được restart của API. S3 làm được đúng một việc: **cách ly blast radius** (job không chết khi API restart). Giữ KPI #4 "API restart/run = 0" nguyên văn → giao thức quan sát sẽ đánh FAIL → thúc ép masking — sai hướng đúng như anti-goal §7.4 chống cap.
- Yêu cầu v0.2:
  - KPI #4 đổi thành kết quả cách ly: **"job bị giết khi API restart = 0 (job chạy trọn vẹn trong worker)"** — con số "API restart count" chuyển thành **báo cáo** (không gate), thuộc nợ follow-up đặt tên: **"API compile-ratchet boot"** (không scope-creep bản này; ghi §7).
  - KPI #5 "steady < 900MB" đã thỏa ngầm ngay hôm nay (pm2: 61.9MB) — đo thứ thực sự gây sự cố: đổi thành **gate phần thuộc W2: "mức đóng góp của worker/organs vào RSS API = 0 sau tách (delta trước/sau)"** + **báo cáo (không gate): RSS peak boot API trước/sau** làm số liệu cho nợ compile-ratchet.

**P0-5 · `ObservationEvent.seq @unique` — S2 mâu thuẫn thiết kế single-writer; W2 phá giả thiết "1 process".**
- Kiểm chứng schema.prisma:2645-2649: `seq Int @unique` cấp bằng `MAX(seq)+1` trong tx ngắn; comment ghi rõ giả thiết **"single-writer queue… SQLite serialise tự nhiên + pm2 fork 1 process"** (RO-4); ledger.ts:270-276 xác nhận drain đơn luồng là điều kiện an toàn của phép cấp seq.
- Hai mâu thuẫn với v0.1:
  (a) §4.2 đề xuất batch "ledger events dòng đơn" → tạo **allocator seq thứ hai trong cùng process** (tx của batcher chạy trên connection khác với drain writeOne) — hai tx đọc cùng MAX → đụng `@unique` → P2002 **không nằm trong TRANSIENT_SQLITE_PATTERNS** (db.ts:238-255) → fail cứng, sự kiện mất.
  (b) W2 split: worker process + API process cùng cấp seq → giả thiết "pm2 fork 1 process" sập đúng như comment đã cảnh báo — hiện tượng này tồn tại bất kể có batch events hay không.
- Yêu cầu v0.2:
  1. **Rút observation events khỏi danh sách batch §4.2** (giữ nguyên toàn bộ đường writeOne — đúng thiết kế RO-4);
  2. **Thêm "P2002 đến từ seq" vào họ transient + retry** (tx mới đọc lại MAX — an toàn: tx cũ chưa commit thì chưa chiếm seq; đây là điều kiện cần cho W2);
  3. Ghi rõ W2 phụ thuộc fix (2) — không phải tùy chọn.

### 10.2 · Phát hiện P1 — nên sửa trong v0.2 (6)

| # | Phát hiện (kiểm chứng) | Yêu cầu v0.2 |
|---|---|---|
| P1-1 | `enqueue` chờ-flush: khi batch bị DROP, promise của caller "treo vô định" (§4.1a chỉ định nghĩa resolve lúc thành công) | **Reject có type** (`BatchDroppedError`) khi drop; pending xuyên retained-retry nhưng có trần; fire-and-forget không đổi |
| P1-2 | 2 lớp retry đè nhau: call-site `withSqliteRetry` + batch retry cả-batch + (sắp có) salvage per-op → nhân hồi lũy thừa | Chủ sở hữu retry dịch về batcher trên batched path; raw fn trong op KHÔNG tự `withSqliteRetry` nữa; direct path giữ nguyên hiện trạng |
| P1-3 | Split worker không có HttpWatchdog; `GOAL_LOOP_STALL_*` chỉ cảnh báo UI — worker **treo** (await kẹt, RSS thấp) sẽ không bao giờ được restart | Thêm **heart-movement watchdog trong worker**: heart không nhúc nhích > ngưỡng → self-exit → pm2 restart (khác STALL-preempt là pause job — pause không chữa process treo) |
| P1-4 | Drain batcher nếu đè lên hợp đồng SelfExitDrain 600ms sẽ phá đúng thiết kế đang thắng cuộc đua kernel | Bound riêng ≤ 3s đã nêu P0-1.2 — tách bạch, exit đúng giờ |
| P1-5 | Batch tx 200 op giữ write-lock SQLite suốt batch → **block heartbeat/claim của worker** (DB-liveness là đường TỚI của điều độ) + ledger interactive tx (ledger.ts:272) | **Target hold-time batch tx** (< 300ms điển hình; vượt → tự split batch nhỏ hơn) + KPI mới: "claim/heartbeat/checkout p95 < 500ms" |
| P1-6 | Split mode vẫn giữ inline-fallback khi enqueue lỗi (chat route:1235-1246: "enqueue lỗi → chạy INLINE"; kèm guard cấm double-run khi job row đã tạo) | Ghi rõ vào §4.3: fallback là **chủ đích giữ nguyên** (availability khi DB xuống) — job có thể chạy trong process API dưới điều kiện DB-degraded; đây là hành vi cũ có guard, không phải regression |

### 10.3 · Phát hiện P2 (3)

1. `PrismaModel` union cần delegate-map typed (tránh `any` tràn qua ranh giới batcher — implement note).
2. Burst test 500 ops/1s bổ sung 2 phép đo: (a) direct-path interleaved — chat create latency không hồi quy khi batch ON; (b) **định lượng ops mất/crash** (kill -9 giữa burst) — đầu vào cho KPI P0-1.3.
3. Observation instrumentation (§4.1d đang có 4 số) thêm: `holdMs` (P1-5), `salvageSplits`, `poisonCount` (P0-2).

### 10.4 · Những gì review DUYỆT GIỮ NGUYÊN (chống review-phá phần đã đúng)

1. **Thứ tự W1 (B-full) → W2 (C)** + đủ 3 lý do §5 — đứng vững qua phê vấn; P0-1 càng củng cố (tách trước không giảm tải, chỉ dời chỗ đứng hàng đợi).
2. **Nguyên tắc §3** — đặc biệt 3.2 "chỉ batch ĐUÔI ghi": P0-3 chính là bằng chứng RMW phải giữ FIFO trên đường TỚI.
3. **Anti-goals §7** — giữ nguyên cả 9; lưu ý P0-1 KHÔNG được giải bằng cách thêm middleware ngoài (vi phạm anti-goal 2) — giải bằng flush-trigger + drain bound + danh hiệu trung thực.
4. **S2 dựa đúng danh sách burst Task 33** — với điều kiện bảng audit P0-3; việc rút observation events khỏi list (P0-5) là điều chỉnh danh sách theo thiết kế RO-4 có sẵn, không phải phá nguồn.
5. **S3 topology + DB-liveness direction** ("DB là bus, 0 IPC mới") — với bổ sung P1-3 (heart-movement) và P1-6 (fallback ghi minh thị).
6. **KPI #1-3, #6-7** nguyên vẹn; #4/#5 điều chỉnh như P0-4 (bản chất là làm cho KPI đo đúng thứ S3 làm được).

### 10.5 · Bảng yêu cầu v0.2 (tổng hợp — map finding → chỗ sửa)

| Finding | Sửa tại |
|---|---|
| P0-1 (crash-loss) | §4.1b (trigger 4 flushNow) · §4.1c (danh hiệu) · §4.1d (KPI ops-mất/crash) · SelfExitDrain bound ≤3s |
| P0-2 (poison op) | §4.1c (flush 2 pha + salvage) · §4.1d (salvageSplits/poisonCount) |
| P0-3 (RMW coalesce) | §4.1a (type-guard cấm coalesce RMW) · §4.2 (bảng audit call-site) |
| P0-4 (KPI #4/#5) | §6 (gate cách ly + báo cáo; nợ "API compile-ratchet boot" ghi §7) |
| P0-5 (seq single-writer) | §4.2 (rút events khỏi batch list) · §4.3b (P2002-seq transient — điều kiện W2) |
| P1-1..P1-6 | §4.1 (promise/retry/holdMs) · §4.3 (heart-movement + fallback minh thị) · §6 (KPI claim/heartbeat p95) |
| P2-1..P2-3 | §4.1a (delegate-map) · §5 W1 (burst test mở rộng) · §4.1d |

### 10.6 · Tái hiện điều tra review

```
rg -n "qValue: newQ|visits: \{ increment" src/lib/learning/q-table.ts    # P0-3 — RMW updateQ
rg -n "seq" prisma/schema.prisma | rg -A2 ObservationEvent                # P0-5 — @unique + comment single-writer
rg -n "TRANSIENT_SQLITE_PATTERNS" -A18 src/lib/db.ts                      # P0-2/P0-5 — họ transient (thiếu P2002-seq)
sed -n '1235,1246p' src/app/api/openclaw/chat/route.ts                     # P1-6 — inline-fallback + double-run guard
sed -n '270,297p' src/lib/observation/ledger.ts                            # P0-5 — writeOne drain đơn luồng
```
