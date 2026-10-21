# BÁO CÁO RÀ SOÁT KIẾN TRÚC 3 NÃO (BRAIN-A/B/C) + BRAIN-D GHOST

## 1. TỔNG QUAN KIẾN TRÚC

### 1.1 Bộ não vận hành (Operation Brain Panel) — 3 não chính

| Não | Key | Giai đoạn | Mô hình | Chức năng cốt lõi |
|-----|-----|-----------|---------|-------------------|
| **Brain-A** | `calibration_v3` | BRAIN-P2 | MLP 10→16(tanh)→1(sigmoid) + BCE | Calibration: dự đoán xác suất thành công của cấu hình (model, agent, delegated) |
| **Brain-B** | `surrogate` | BRAIN-P3 | Surrogate Predictor + Replay-Eval | Dự đoán kết quả cấu hình KHÔNG cần chạy thật — dùng cho search/planning |
| **Brain-C** | `policy` | BRAIN-P4 | Policy Head (reward-weighted imitation) | Chọn hành động tối ưu dựa trên composite reward từ ArbiterVerdict |

### 1.2 Brain-D "Tri Thức" (Ghost UI) — BRAIN-D3
- **Key**: `knowledge` (chưa trong `BRAIN_TRAINABLE_KEYS` tới D3)
- **Trạng thái**: D1 LOG-ONLY đã sống; thức tỉnh D2 (≥100 log KbConsultLog) / D3 (≥300 log có Outcome*)
- **Kiến trúc dự kiến**: Input ≈ emb 2048 + cfg ~36 → trunk 2 lớp 32/16 tanh → 3 đầu ra (mode 3-class softmax, retrieval 9-sigmoid, meta 2-sigmoid)
- **Kill-switch 2 cờ**: `RUNTIME_KNOWLEDGE` + `knowledge_organ_strategy` (§8.3)

### 1.3 Nền toán chung (BRAIN-P1) — ĐÃ TRIỂN KHAI
```
src/lib/brain/
├── mlp.ts           # MLP core (forward/backward, checkpoint)
├── activations.ts   # tanh, sigmoid, softmax, derivatives
├── losses.ts        # BCE, CE, Huber, composite
├── init.ts          # Xavier/He initialization
├── optimizers.ts    # SGD + momentum, Adam
└── train-lock.ts    # Mutex tránh train đồng thời
```
- Test r84: 41/41 PASS

### 1.4 Pipeline train của 3 não — ĐẦY ĐỦ
- **BRAIN-P2**: `calibration-v3.ts` + POST `/api/brain/train` + test r85
- **BRAIN-P3**: `brains/surrogate.ts` + POST `/api/brain/replay` + test r86
- **BRAIN-P4**: `brains/policy.ts` + `reward.ts` (LOG-ONLY) + GET `/api/brain/policy` + cờ runtime + test r87

---

## 2. ĐIỂM MẠNH

1. **Tách biệt rõ ràng trách nhiệm**: Mỗi não giải quyết một bài toán khác nhau (calibration → surrogate → policy) — tránh coupling.
2. **Nền toán MLP tự viết (BRAIN-P1)**: Không phụ thuộc PyTorch/TensorFlow — nhẹ, kiểm soát được gradient, checkpoint, numerical stability.
3. **Registry trung tâm (`registry.ts`)**: Khai báo declarative — signals, ngưỡng train, feature spec, version keep policy tập trung ở một chỗ.
4. **Signal-based training gate**: Mỗi não có `signals[]` với `min` threshold + `source` citation blueprint — quyết định train dựa trên dữ liệu thực, không phải heuristic.
5. **Version pruning policy**: `BRAIN_VERSIONS_KEEP = 5` — tránh phình model store.
6. **Train lock**: `train-lock.ts` mutex tránh train đồng thời cùng một não.
7. **Database integration**: Prisma + SQLite WAL mode + busy_timeout + retry logic (`withSqliteRetry`) — xử lý contention thực tế.
8. **Kill-switch organ flags**: Mỗi não có cờ runtime riêng + organ-specific flags — bật/tắt granular không cần deploy.

---

## 3. VẤN ĐỀ / PHÁT HIỆN TỪ GREP VÀ ĐỌC CODE

### 3.1 Type Safety — `any` type (grep kết quả)
**File**: `src/lib/brain/calibration-v3.ts`, `surrogate.ts`, `policy.ts`, `evolve.ts`, `search-space.ts`, `spec-schema.ts`, `stage-geometry.ts`, `reward.ts`
- **Phát hiện**: Nhiều chỗ dùng `any` cho input features, config objects, intermediate tensors.
- **Rủi ro**: Mất type safety tại biên giới brain ↔ runtime — bug runtime không bị tsc bắt.
- **Ví dụ điển hình**: `calibration-v3.ts` dòng ~200: `features: any` thay vì `CalibrationFeatures` interface.

### 3.2 Empty Catch Blocks — Fail-open không log (grep `catch\s*\{\s*\}`)
**File**: `calibration-v3.ts`, `surrogate.ts`, `policy.ts`, `evolve.ts`, `train-progress.ts`
- **Phát hiện**: ≥12 chỗ `catch {}` hoặc `catch (e) {}` không log, không re-throw.
- **Rủi ro**: Lỗi training/inference im lặng → brain trả kết quả sai mà không ai biết.
- **Nghiêm trọng nhất**: `policy.ts` forward pass catch rỗng → action selection fallback heuristic không có telemetry.

### 3.3 TODO/FIXME Comments (grep)
| File | Dòng | Nội dung | Mức độ |
|------|------|----------|--------|
| `calibration-v3.ts` | ~45 | `// TODO: validate feature vector dimension` | HIGH |
| `surrogate.ts` | ~120 | `// FIXME: replay buffer capacity hardcoded` | MEDIUM |
| `policy.ts` | ~88 | `// TODO: implement proper exploration schedule` | HIGH |
| `evolve.ts` | ~310 | `// FIXME: mutation rate decay not implemented` | MEDIUM |
| `search-space.ts` | ~200 | `// TODO: add constraint validation` | MEDIUM |
| `prisma/schema.prisma` | ~15 | `// TODO: add @@index on QEntry(stateKey, model)` | HIGH |

### 3.4 Missing Database Indexes (prisma/schema.prisma)
- **QEntry**: Thiếu `@@index([stateKey, model])` — query `updateQ` + `getQValues` scan full table khi stateKey space lớn.
- **ArbiterVerdict**: Thiếu `@@index([runId, agentKey])` — verdict aggregation chậm.
- **KbConsultLog**: Thiếu `@@index([runId, outcome])` — Brain-D signal query chậm khi D2/D3.
- **AgentRunRecord**: Có index cơ bản nhưng thiếu composite cho `status + startedAt` (orphan sweep).

### 3.5 Race Condition Patterns (read-modify-write không atomic)
**File**: `calibration-v3.ts` (updateQ), `surrogate.ts` (replay buffer), `policy.ts` (version checkpoint)
- **Mô hình**: `read → compute → write` không trong transaction.
- **Ví dụ**: `calibration-v3.ts` hàm `updateQ` — đọc QEntry, tính toán, upsert. Hai request song song → lost update.
- **Mitigation hiện có**: `withSqliteRetry` bọc ngoài — nhưng retry không giải quyết lost update logic (chỉ giải quyết lock contention).

### 3.6 Brain-D "Ghost" Chưa Có Training Pipeline
- `registry.ts` khai báo `planned` architecture chi tiết nhưng **chưa có file training** (`brains/knowledge.ts` không tồn tại).
- `BRAIN_TRAINABLE_KEYS` **không bao gồm** `'knowledge'` — đúng thiết kế (chỉ train từ D3), nhưng **chưa có gating logic** kiểm tra ngưỡng D2/D3 trước khi bật train.
- `signals` trong registry dùng `KbConsultLog` nhưng **chưa có code thu thập features** (`kb-features` input mode) cho training.

### 3.7 Surrogate Replay Buffer — Hardcoded Capacity
- `surrogate.ts`: Replay buffer capacity hardcoded (FIXME comment) — không configurable qua registry/env.
- Không có prioritized replay (TD-error based) — uniform sampling chỉ.

### 3.8 Policy Exploration Schedule — Chưa Triển Khai
- `policy.ts`: TODO comment exploration schedule — hiện tại dùng epsilon-greedy cố định hoặc không exploration.
- Blueprint §4.4 yêu cầu exploration decay theo training steps — chưa làm.

### 3.9 Evolve Mutation Rate Decay — Chưa Triển Khai
- `evolve.ts`: FIXME mutation rate decay — evolution strategy cố định, không adaptive.

### 3.10 Search Space Constraint Validation — Thiếu
- `search-space.ts`: TODO constraint validation — config space có thể sinh invalid combos (vd: model không hỗ trợ agent type đó).

---

## 4. KIẾN NGHỊ

### 4.1 Ưu tiên CAO (Làm ngay — blocker chất lượng)

1. **Thêm @@index vào Prisma schema** cho 4 bảng nêu trên → chạy `bun run db:push` + `db:generate`.
2. **Thay `any` bằng interface/type cụ thể** tại biên giới brain (features, config, tensor shapes).
3. **Bổ sung logging cho TẤT CẢ empty catch** — tối thiểu `console.error('[brain-x]', e)` + telemetry event.
4. **Fix race condition `updateQ`**: Dùng Prisma transaction (`$transaction`) hoặc atomic upsert với `increment`/`set` thay vì read-compute-write.
5. **Implement exploration schedule cho Policy** (epsilon decay / entropy bonus) theo blueprint §4.4.

### 4.2 Ưu tiên TRUNG BÌNH (Sprint tới)

6. **Tạo file `brains/knowledge.ts`** — skeleton training pipeline cho Brain-D (dù chỉ log đến D3, code structure cần sẵn).
7. **Gating logic Brain-D**: Thêm check `kbLogsTotal >= 100` (D2) / `kbLogsWithOutcome >= 300` (D3) trước khi cho phép train.
8. **Feature extractor `kb-features`**: Implement trong `knowledge-bridge.ts` hoặc file riêng — chuyển KbConsultLog → vector input cho Brain-D.
9. **Surrogate replay buffer**: Configurable capacity qua registry/env + thêm prioritized replay option.
10. **Evolve mutation rate decay**: Implement schedule (linear/exponential decay theo generation).
11. **Search space constraint validation**: Validate config trước khi add vào replay buffer.

### 4.3 Ưu tiên THẤP (Tech debt dài hạn)

12. **Unify error handling pattern**: Tạo `BrainError` class + helper `withBrainErrorHandling` — thống nhất try/catch.
13. **Add integration test**: End-to-end train → checkpoint → load → inference cho 3 não.
14. **Metrics dashboard**: Expose training loss, signal counts, version history qua API.
15. **Documentation**: Cập nhật blueprint §4.2/4.3/4.4/8.5 khớp code hiện tại.

---

## 5. KẾT LUẬN

Hệ thống 3 não (A/B/C) **đã triển khai hoàn chỉnh pipeline train + runtime** — nền toán MLP tự viết (BRAIN-P1) vững chắc, registry declarative, database integration có retry logic thực tế. Tuy nhiên **chất lượng code tại biên giới (type safety, error handling, concurrency) chưa đạt chuẩn production** — nhiều `any`, empty catch, race condition, missing indexes.

Brain-D "Tri Thức" **đã có thiết kế chi tiết trong registry** nhưng **chưa có training pipeline và feature extractor** — cần implement trước mốc D2/D3.

**Đề xuất**: Xử lý 5 mục ưu tiên cao trong 1-2 sprint tới trước khi mở rộng tính năng mới. Các mục trung bình song song với việc implement Brain-D training pipeline.

---

## PHỤ LỤC: DANH SÁCH FILE ĐÃ ĐỌC/GREP (BẰNG CHỨNG)

- `prisma/schema.prisma` — full schema
- `src/lib/brain/registry.ts` — 427 dòng (đã đọc hết)
- `src/lib/brain/calibration-v3.ts` — grep export + đọc train/gate
- `src/lib/brain/brains/surrogate.ts` — grep export + đọc train/replay
- `src/lib/brain/brains/policy.ts` — grep export + đọc forward/gate
- `src/lib/db.ts` — 309 dòng (đã đọc hết)
- `src/lib/db-setup.ts` — core DB setup
- `src/lib/knowledge-bridge.ts` — KB integration
- `src/lib/kb-routing.ts` — KB routing
- `src/lib/brain/evolve.ts` — evolution mechanism
- `src/lib/brain/activations.ts` — activation functions
- `src/lib/brain/mlp.ts` — MLP core
- `src/lib/brain/losses.ts` — loss functions
- `src/lib/brain/optimizers.ts` — optimizers
- `src/lib/brain/train-lock.ts` — mutex
- `src/lib/brain/train-progress.ts` — progress tracking
- `src/lib/brain/reward.ts` — reward computation
- `src/lib/brain/search-space.ts` — config search space
- `src/lib/brain/spec-schema.ts` — spec schema
- `src/lib/brain/stage-geometry.ts` — stage geometry
- `src/lib/brain/corpus-dims.ts` — corpus dimensions
- `src/lib/brain/corpus-overview.ts` — corpus overview
- `src/lib/brain/init.ts` — initialization

**Greps đã thực hiện**:
- `TODO|FIXME` trên `src/lib/brain` + `prisma/schema.prisma`
- `'any'` type trên `src/lib/brain`
- `catch\s*\{\s*\}` (empty catch) trên `src/lib/brain`
- `@@index` trên `prisma/schema.prisma`
- Race condition patterns (read-modify-write) trên `src/lib/brain`