# BLUEPRINT: R17 B-FULL + C — HÀNG ĐỌC GHI ĐƠN WRITER (BATCH WRITE TRANSACTION) + TÁCH WORKER KHỎI PROCESS API

- **Ngày:** 2026-10-20 (16:19–16:4x UTC)
- **Người thực hiện:** Z.ai Code (main session) — theo chỉ thị user: *"Tiến hành viết technical Blueprint cho những gì cần triển khai cho tôi"*.
- **Nguồn vấn đề (chuỗi phê duyệt):** docs/QUAN-SAT-LUOT-7-R16.md §6 (đề xuất 6.2 B/C) → docs/QUAN-SAT-LUOT-7-FIX-R17.md §2.3 ("B-full + C — CHƯA triển khai… cần blueprint riêng") → fixbug.md ĐỢT FB-F1F6 "Ngoài phạm vi" ("R17 B-full + R17 C vẫn là ưu tiên kế tiếp theo duyệt của user") → chỉ thị user phiên này.
- **Trạng thái:** **CHỜ DUYỆT** — bản này là blueprint, chưa đụng code. Sau duyệt: W1 → fixbug → W2 → fixbug → báo cáo + push (đúng khuôn chỉ thị nền của user).

---

## 0. TÓM TẮT ĐIỀU HÀNH

| # | Vấn đề (đã có bằng chứng sống) | Giải pháp (bản này đề xuất) | Rủi ro | Gate an toàn |
|---|---|---|---|---|
| **B-full** | SQLite 1-writer bão hòa dưới cụm ghi run-close: "Socket timeout" tái xuất (51 lỗi đo R11, tái xuất OBS-1), ledger interactive tx 5s bị kéo 15s | **S1 + S2:** `WriteBatcher` — hàng đợi ghi đơn writer trong process; coalesce; flush **1 transaction/tick**; chuyển đường ghi không-critical (đúng danh sách burst Task 33) qua hàng đợi | Trung-cao (chạm vòng đời ghi của run — R17 §2.3 gọi đúng: "rủi ro cao") | Flag `GOAL_LOOP_…`-style: `DB_WRITE_QUEUE` **default OFF**, pilot ON như softmax; nguyên tắc "chỉ batch ĐUÔI ghi, không batch đường TỚI" |
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

### S1. `WriteBatcher` — hàng đợi ghi đơn writer, coalesce, flush 1 transaction/tick (fix P1 + P2 — đây là "B-full")

Module mới `src/lib/db-write-batcher.ts` (flat theo convention `src/lib/tool-metrics-recorder.ts`; KHÔNG đụng `src/lib/db.ts` ngoài import):

**4.1a · Kiểu op (discriminated union — type-safe, đơn nguồn sự thật):**
```
WriteOp =
  | { kind: 'create';   model: PrismaModel; data: unknown }
  | { kind: 'upsert';   model: PrismaModel; where: unknown; create: unknown; update: unknown }
  | { kind: 'update';   model: PrismaModel; where: unknown; data: unknown }
  | { kind: 'raw';      fn: (tx: PrismaTxClient) => Promise<void> }   // cho metrics-db composite
opts?: { idempotencyKey?: string }   // khai báo → 2 op cùng key trong 1 batch giữ CÁI SAU (last-wins); không khai báo → giữ nguyên FIFO
```
- `enqueue(op, opts?) → Promise<void>`: resolve khi op nằm trong batch đã flush THÀNH CÔNG (đường caller muốn chờ); `enqueueFireAndForget` biến thể không chờ (đa số call-site S2). KHÔNG trả kết quả row — ai cần id thì thuộc đường TỚI (nguyên tắc §3.2, không qua batcher).

**4.1b · Flush — 3 trigger OR:**
1. Timer `DB_WRITE_BATCH_FLUSH_MS` (default **1000ms** — ngắn hơn window contention đo thật vài giây của Task 33);
2. Depth ≥ `DB_WRITE_BATCH_MAX_OPS` (default **200**);
3. **Shutdown drain**: hook vào `SelfExitDrain` + SIGTERM/SIGINT sẵn (đường exit sạch 11c đã thắng cuộđua reaper — R17 §2.1) — flush nốt batch đang chờ trước exit(1), đúng hợp đồng "checkpoint flush".

Thân flush: `db.$transaction(async tx => { for (op of batch) apply(tx, op) }, { timeout: DB_WRITE_BATCH_TX_TIMEOUT_MS })` — default **30s** (batch nhiều op cần trần cao hơn đơn-op 5s của Prisma; đây là trần GIAO DỊCH, không phải tăng busy_timeout chịu đựng — khác tầng với db.ts:135, không vi phạm anti-goal §7).

**4.1c · Thất bại:** cả-batch qua `withSqliteRetry` (tái dùng, không viết lại) → hết retry: `console.error` + `recordDebtIssue({ kind:'infra', issue:'Write batch flush thất bại N ops (label)', evidence: queueDepth/flushMs/firstErr })` + **giữ batch** chờ flush kế (bound tối đa 2 batch chờ — tràn thì drop batch CŨ nhất, MỖI op drop có debt issue riêng). At-least-once; idempotent bắt buộc ở tầng op (S2 migrate lên upsert nơi schema cho phép).

**4.1d · Đo:** 4 số đẩy vào observation instrumentation (hook sẵn — 5/5 cờ ON): `queueDepth`, `batchSize`, `flushMs`, `dropCount` + `retryCount`. Không đo = không ship (nguyên tắc §3.7).

**4.1e · Flag:** `DB_WRITE_QUEUE` (default **off**). OFF = module tồn tại nhưng mọi `enqueue` fallback thẳng đường cũ (pass-through) — 0 thay đổi hành vi, gate vẫn phải PASS y hệt (regression chống hai-mode divergence).

### S2. Chuyển đúng danh sách burst Task 33 qua batcher (phần 2 của B-full — fix P1 ở tầng call-site)

| Call-site (đúng danh sách db.ts:222-224) | Chuyển qua | Ghi chú |
|---|---|---|
| tool-metrics-recorder (toolMetric create) | `enqueueFireAndForget(create)` | Đúng bằng chứng OBS-1 "Socket timeout trên toolMetric/create" |
| workingMemory create | `enqueueFireAndForget(create)` | Đồng bằng chứng OBS-1 |
| q-table updateQ | `enqueueFireAndForget(raw/upsert)` | Thiệt hại đã đo Task 33: mất tín hiệu Q-learning — batcher + debt-road che |
| token persist (TokenTracker) | `enqueueFireAndForget(upsert)` | |
| auto-train / auto-learn persist | `enqueueFireAndForget` | |
| metrics-db (verdict resolve, cập nhật cuối run) | `enqueueFireAndForget(raw)` — **chỉ phần không cần kết quả trả ngay** | Phần đọc-verdict-để-quyết-định giữ trực tiếp |
| observation ledger events (dòng đơn) | `enqueueFireAndForget` | Ledger TX kết cấu (run.heart/run.end multi-table) **GIỮ interactive tx như hiện tại** — đó là đường TỚI của bảng observation |

**GIỮ NGUYÊN trực tiếp (không qua batcher):** chat-message create (cần id trả UI), opus review verdict write (chuỗi phụ thuộc chốt), claim/checkpoint/heartbeat của worker (đường TỚI của调度 — đúng §3.3 DB-liveness), mọi read.

Mỗi call-site 1 regression test (mẫu r132-r136) + 1 test integration burst giả lập (500 ops/1s — tái hiện mật độ run-close) đo: 0 "Socket timeout", flush p95 < 1s, drop 0.

### S3. Tách worker thành process riêng (fix P3 — đây là "C")

**4.3a · Flag:** `GOAL_LOOP_WORKER_MODE=inline|split` — default **inline** (= hành vi hôm nay, gate regression phải PASS ở cả 2 mode). `split` = bật topology mới.

**4.3b · Topology split:**
- **API process** (`theopusflashlite`, giữ nguyên): Next server + routes + `EnqueueFace` (enqueue qua DB — singleton goal-loop-worker.ts:1507 dùng được ở cả 2 process vì enqueue bản chất là DB write; thêm cửa ở instrumentation-node.ts:1246: `split` → KHÔNG gọi `start()`/`recoverPending()` — chỉ import type + enqueue path).
- **Worker process** (pm2 app mới `theopus-worker`, app thứ 3 trong ecosystem.config.cjs — không đụng 2 app cũ): entry `scripts/worker.mjs` boot theo đúng chuỗi instrumentation-node.ts:1258-1266 (`ensureDbReady → recoverPending → start()`) + MemWatchdog **riêng ngưỡng** `WORKER_MEM_WATCHDOG_MB` + **KHÔNG HttpWatchdog** (không mở port) — thay bằng DB-liveness: heartbeat row + `GOAL_LOOP_STALL_WARN_MS` có sẵn (UI đã đọc được stall — R18).
- **DB là bus duy nhất**: claim/mutex/checkpoint/heartbeat/RESUME đã durable (R18) — 0 IPC mới, 0 schema mới bắt buộc (nếu cần cột `claimedByProcess` cho S4 đo thì migration phụ, không blocking).

**4.3c · Trục kế thừa nguyên vẹn:** 3 import site API (opus/pipeline:52, chat route:73, goal-loop-jobs:38) không đổi chữ — chỉ đường xuống của `start()` tách ra. Singleton `globalThis` guard hoạt động đúng ở cả 2 process (mỗi process 1 instance — đúng ý đồ).

**4.3d · Restart policy tách:** worker restart (own `max_restarts/restart_delay`) KHÔNG chạm API; API restart không giết job đang chạy trong worker (worker tiếp tục, chỉ mất request đang bay của API). Đây là hiệu ứng cách ly của P3 — mục tiêu KPI #4-5.

### S4. Đo tách bạch + rollback tức thì (fix P4 — phần 2 của C)

- Observation trace thêm trường `processRole: 'api' | 'worker'` (fingerprint không dedupe oan 2 process — bài học r126 B1.2 về 2 dạng id: phân biệt bằng đặc trưng, không tự chế).
- pm2 metrics đo riêng từng process: RSS/restart count/uptime — bảng KPI §6 chỉ công nhận số tách bạch này.
- Rollback: `GOAL_LOOP_WORKER_MODE=inline` + `pm2 restart` — topology cũ trở lại trong 1 chu kỳ restart; KHÔNG cần migrate ngược.

---

## 5. LỘ TRÌNH TRIỂN KHAI

| Wave | Scope | Bước (đúng khuôn chỉ thị nền: sửa xong → fixbug → báo cáo → push) | Gate dừng |
|---|---|---|---|
| **W1 — B-full** | S1 + S2 | (1) Viết `db-write-batcher.ts` + unit (order/dedupe/retry/drain/bound) + integration burst 500 ops → (2) migrate 8 call-site §4.2 mỗi site 1 regression → (3) full gate `quality-gate.mjs` (phải PASS cả `DB_WRITE_QUEUE=off` lẫn `=on`) → (4) **giao thức fixbug** (rà soát → fix → rà lại đến sạch) → (5) pilot `DB_WRITE_QUEUE=on` + 1 run thật đầy đủ dưới giao thức quan sát → đối chiếu KPI #1-3 + #7 → (6) báo cáo + push | KPI #1 (Socket timeout/run = 0) chưa đạt → không sang W2, rà lại S2 |
| **W2 — C** | S3 + S4 | (1) `scripts/worker.mjs` + cửa mode instrumentation-node:1246 + ecosystem app 3 → (2) regression 2 mode (inline PASS y hệt hôm nay — chống divergence) → (3) full gate → (4) **giao thức fixbug** → (5) pilot `split` + 1 run thật đầy đủ → đối chiếu KPI #4-6 (đặc biệt KPI R17 treo: "1 run đầy đủ không restart + API p95 < 5s") → (6) báo cáo + push | API restart > 0 trong run → tách bạch chưa thật, rà lại S3 |

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
| 4 | API restart count trong 1 run đầy đủ | Crash loop ↺167→170 trong ~2 phút (15:19–15:20) | (giữ hiện trạng — thuộc W2) | **0** |
| 5 | RSS đo tách bạch | Hỗn hợp 2.4–2.5GB peak / 61.9MB ổn định (cùng process) | (chưa tách được) | API steady **< 900MB**; worker có budget riêng |
| 6 | API p95 dưới run đầy đủ (KPI R17 §2.3 treo — "chưa đối chiếu được") | Chưa đo được | — | **< 5s** |
| 7 | Mất dữ liệu write (at-least-once + idempotent) | updateQ mất tín hiệu Q-learning; row kẹt 'running' 30' (Task 33) | **0** (replay burst: mọi op có mặt trong DB) | 0 |

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

- **v0.1 — 2026-10-20:** khởi thảo theo chỉ thị user ("Tiến hành viết technical Blueprint cho những gì cần triển khai"). Bằng chứng §1 thu trong phiên này (trực tiếp + trích nguồn đã đối chiếu). Scope = R17 B-full + R17 C (đúng "ưu tiên kế tiếp" FB-F1F6); P-NEW-1 gộp vào B-full; P-NEW-4 + P-R13-1 ghi ngoài phạm vi §7. **Chờ user duyệt để vào W1.**
