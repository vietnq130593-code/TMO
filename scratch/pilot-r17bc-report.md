# BÁO CÁO MIGRATION DB WRITE BATCHER — BLUEPRINT-R17BC v0.2 (W1/S1)

## TÓM TẮT
Module `src/lib/db-write-batcher.ts` (584 dòng) đã hoàn tất triển khai hàng đợi ghi đơn writer thay thế các `withSqliteRetry` lẻ tẻ tại call-site. Batcher cung cấp 4 trigger flush, flush 2 pha (batch tx → per-op salvage), coalesce idempotencyKey last-wins, poison-circuit breaker, và stats đầy đủ để quan sát.

---

## 1. BỐN TRIGGER FLUSH (P0-1)

| Trigger | Vị trí code | Mô tả |
|---------|-------------|-------|
| **Timer chu kỳ** | `scheduleFlush()` (dòng 273) + `FLUSH_MS = 1000ms` | Flush định kỳ mỗi giây khi queue/retained không rỗng |
| **Depth ngưỡng** | `enqueueWrite`/`enqueueWriteFireAndForget` (dòng 488, 520) | Khi `queue.length >= MAX_OPS (200)` → flush sớm không đợi timer |
| **FlushNow run-close** | `flushWriteQueueNow()` (dòng 531) | Gọi tại `agent-run-tracker.ts:509` lúc run-close — burst writes tập trung |
| **Drain exit** | `drainWriteQueueForExit(boundMs)` (dòng 541) | Gọi trong `instrumentation-node.ts:127` tại `selfExitWithDrain`, bound `TMO_EXIT_WRITE_DRAIN_MS ≤ 3s` |

---

## 2. GIAO DIỆN STATS — `WriteQueueStats` (dòng 564-582)

Có **13 trường** trả về bởi `getWriteQueueStats()` — vượt yêu cầu ≥5:

- `enabled` — batcher có bật không (feature flag `TMO_WRITE_BATCHER`)
- `queueDepth` — độ sâu queue chờ flush
- `retainedBatches` — số batch retained đang chờ retry
- `flushing` — đang trong flush hay không
- `lastBatchSize` — kích thước batch vừa flush
- `lastFlushMs` — thời gian flush cuối (ms)
- `lastHoldMs` — hold time cuối (ms)
- `chunkSize` — kích thước chunk hiện tại (tự điều chỉnh P1-5)
- `flushP95Ms` — P95 flush time từ ring buffer 50 mẫu
- `flushedBatches` — tổng batch đã flush thành công
- `flushedOps` — tổng op đã flush thành công
- `coalescedOps` — tổng op bị coalesce (idempotencyKey trùng)
- `dropCount` — op bị drop do vượt `RETAINED_MAX` (P1-1)
- `retryCount` — lượt retry contention
- `salvageSplits` — số lần salvage split batch (P0-2)
- `poisonCount` — op poison circuit-breaker (P1-3)

---

## 3. 6 CALL-SITE ĐÃ MIGRATE SANG BATCHER

| File | Hàm batcher dùng | Dòng | Loại op | Ghi chú |
|------|------------------|------|---------|---------|
| `lib/auto-learn.ts` | `enqueueWriteFireAndForget` | 313, 342, 360 | `create` (AutoLearnRecord, agentInsight, learningLog) | 3 điểm — fire-and-forget, fail-open |
| `lib/llm.ts` | `enqueueWriteFireAndForget` | 1004, 1020, 1039, 1059, 1081 | `upsert` (providerUsage, providerSlot, providerModel, agentUsage) | 5 điểm — idempotencyKey cho phép coalesce last-wins |
| `lib/llm.ts` | `flushWriteQueueNow` | 1152 | — | Ép flush ngay sau batch upsert token |
| `lib/memory-tiers.ts` | `enqueueWrite` (await) | 219 | `create` (workingMemoryEntry) | Có waiter — resolve khi flush thành công |
| `lib/tool-metrics-recorder.ts` | `enqueueWriteFireAndForget` | 99 | `create` (ToolMetric) | Fire-and-forget, fail-open |
| `lib/agent-run-tracker.ts` | `flushWriteQueueNow` | 509 | — | Trigger 3 tại run-close |

**Tổng: 10 điểm enqueue + 2 điểm flushNow = 12 invocation sites.**

---

## 4. 2+ ĐƯỜNG GHI TRỰC TIẾP ĐƯỢC GIỮ (KHÔNG QUA BATCHER)

| Đường ghi | File | Lý do giữ direct |
|-----------|------|------------------|
| **updateQ RMW** | `lib/update-queue.ts` | Read-modify-write atomic trên hàng đợi ưu tiên — cần transaction đơn lẻ, không phù hợp coalesce batch |
| **ArbiterVerdict → observation ledger** | `lib/observation/ledger.ts` | Single-writer ledger, append-only, latency-critical — bypass queue tránh jitter |
| **AgentRunRecord close** | `lib/agent-run-tracker.ts` (dòng ~480) | Ghi metrics run-close cần commit trước cửa sổ nguy hiểm — dùng `flushWriteQueueNow` ngay sau chứ không enqueue |

---

## 5. KIẾN TRÚC FLUSH 2 PHA (REVIEW-1 P0-2)

**Phase 1 — Batch Transaction**: Gom `chunkSize` ops → 1 `db.$transaction` → thành công = commit tất cả; thất bại = chuyển Phase 2.

**Phase 2 — Per-op Salvage**: Mỗi op trong batch fail chạy `withSqliteRetry` riêng (2 lần, exponential backoff). Thành công = salvage; vẫn fail = retained để retry chu kỳ sau; fail liên tục ≥ `RETAINED_MAX (3)` → poison → `BatchDroppedError` + debt log.

**Coalesce**: `idempotencyKey` (model + where unique) → last-wins trong cùng batch. Op bị coalesce không tự reject — theo số phận op đại diện (thành công = resolve waiter; fail = chờ retained chu kỳ sau).

---

## 6. HỢP ĐỒNG BỀN (TRUNG THỰC)

- **At-least-once**: Qua contention retry (withSqliteRetry 2 pha) + clean self-exit (drain bounded).
- **At-most-once**: Cửa sổ mất ≤ `FLUSH_MS (1s)` × `MAX_OPS (200)` — in-memory queue không sống qua SIGKILL/kernel OOM.
- **Không tuyên "crash-proof"** — chỉ đảm bảo bounded loss window.

---

## 7. FEATURE FLAG & KHỞI TẠO

- Bật/tắt qua `TMO_WRITE_BATCHER` (mặc định `true`).
- `queueEnabled()` check flag + `db` đã sẵn sàng.
- Pass-through mode (flag off): `withSqliteRetry` đơn lẻ giữ nguyên hành vi hôm nay (P1-2).

---

## 8. KẾT LUẬN

Migration W1/S1 hoàn tất: batcher hoạt động, 12 invocation sites đã chuyển, 3 đường direct giữ lại có lý do kiến trúc rõ ràng. Stats đầy đủ cho observability. Sẵn sàng cho W1/S2 (bật flag production, theo dõi P95, dropCount, poisonCount).