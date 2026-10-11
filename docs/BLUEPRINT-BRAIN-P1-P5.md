# BLUEPRINT TRIỂN KHAI BRAIN P1 → P5 — "NÃO VẬN HÀNH" MLP-CPU CHO TMO

> **Phiên bản:** 0.1 — **DRAFT, ĐANG THẢO LUẬN. CHƯA TRIỂN KHAI DÒNG CODE NÀO.**
> Được tạo theo chỉ thị user (2026-10-11): *"tạo một file .md lộ trình triển khai, cần triển khai những gì và triển khai như thế nào. Tuy nhiên chưa triển khai ngay mà vẫn cần thảo luận thêm."*
>
> **Nguồn gốc chuỗi thảo luận:**
> 1. Thẩm định cấp độ kiến trúc Level 0–3 (kết luận: **Level 1 — RL-Based Tuning**, không có ANN thật) — tab Database > Kiến trúc hiện hiển thị đồ thị hệ thống ẩn dụ, chưa có mạng nơ-ron vận hành.
> 2. Đề xuất "bộ não TMO" của user: *đóng băng LLM, tích lũy dữ liệu & bài học, một bộ não tự xây tự huấn luyện điều khiển hành vi các model khi gọi ra* — triết lý **LoRA-style** (freeze base + học phần điều chỉnh nhỏ), NHƯNG không sửa trọng số LLM (điều đó cần GPU backprop qua model tỷ tham số — ngoài hạ tầng hiện tại).
>
> **Quan hệ với blueprint khác:** KHÔNG thay thế `BLUEPRINT-STATS-LEARNING-P0-P6.md` (đã hoàn tất 100% — P0→P6 đều commit). BRAIN là **tầng kế tiếp**, tái sử dụng nguyên vẹn hạ tầng P0–P6: thư viện `src/lib/stats/`, `QEntry` + q-table, `StrategyAdaptationLog`, Wilson CI, pattern 5-fold CV + fail-open của `CalibrationModelV2`, tuning-store (STORE > ENV > DEFAULT), cron scheduler.
>
> **Doctrine giữ nguyên:** additive-only · fail-open · cờ mặc định OFF · hardcode từ dữ liệu · **không thêm DB/framework mới** (P1–P4 thuần TypeScript, không dependency ngoài) · 1 phase = 1 commit + quality-gate PASS · test theo pattern round (bắt đầu r84).

---

## 0. TÓM TẮT ĐIỀU HÀNH

| Phase | Việc | File chính | Effort | Cờ/Điểm dừng |
|---|---|---|---|---|
| **BRAIN-P1** | Nền toán MLP (lan truyền tiến/ngược, activation, loss, optimizer) + kho trọng số `BrainModel` + hiển thị **ANN thật** trên tab Kiến trúc | mới `src/lib/brain/{mlp,activations,losses,optimizers,init}.ts` · `prisma/schema.prisma` (+1 model) · `src/components/database/neural-architecture-section.tsx` (panel mới) | M | Không đổi hành vi runtime nào — thuần nền tảng + hiển thị |
| **BRAIN-P2** | **Brain-A** — Calibration V3: MLP 2 lớp thay logistic V2 khi thắng đối chứng CV | mới `src/lib/brain/brains/calibration-v3.ts` · sửa `src/lib/calibration.ts` (điểm cắm runtime) | M | `CALIBRATION_V3=off` |
| **BRAIN-P3** | **Brain-B** — Surrogate Predictor (dự đoán kết quả cấu hình KHÔNG chạy thật) + chế độ replay-eval | mới `src/lib/brain/brains/surrogate.ts` + `src/app/api/brain/replay/route.ts` | L | `REPLAY_EVAL=off` (chỉ đo/báo cáo) |
| **BRAIN-P4** | **Brain-C** — Policy head theo đặc trưng nhiệm vụ + **composite reward** + chuyển dần cơ quan lái (directives / model routing / tuning) sang nghe brain | mới `src/lib/brain/brains/policy.ts` + reward ledger thống nhất · sửa `adaptation-engine.ts` / `llm.ts` (từng cơ quan một) | L | `RUNTIME_POLICY=off` · từng cơ quan có kill-switch về hành vi cũ |
| **BRAIN-P5** | Biên giao tiếp GPU/Python (Keras/PyTorch sidecar, GCN trên Neo4J — đường lên Level 3) | mini-service python (dài hạn, **chỉ khi có GPU**) | XL | Ngoài phạm vi lộ trình này — chỉ chốt contract |

**Thứ tự bắt buộc:** P1 → P2 → P3 → P4. P5 độc lập (chỉ chốt giao tiếp trong P1–P4 để không làm lại).

---

## 1. KIẾN TRÚC ĐÍCH — BỘ NÃO TMO VÀ VAI TRÒ 3 KHO

```
┌────────────────────────────────────────────────────────────────────┐
│                         BỘ NÃO TMO (đích)                           │
├────────────────────────────────────────────────────────────────────┤
│ GIÁC QUAN (input)                                                  │
│   Qdrant: vector nemotron-3-embed-1b 2048-dim (chính)              │
│           + pilot 512-dim Matryoshka (P5-M1 stats blueprint)       │
│   SQLite: đặc trưng vận hành (model, strategy, tokens, cycles…)    │
├────────────────────────────────────────────────────────────────────┤
│ NÃO VẬN HÀNH — các MLP nhỏ train CPU (thuần TypeScript)           │
│   Brain-A "V3":  calibration độ tin KB (MLP thay logistic)         │
│   Brain-B "Vọng": surrogate dự đoán success/tokens/latency         │
│   Brain-C "Lệnh": policy chọn model/chiến lược theo nhiệm vụ       │
│   (mỗi brain: thức tỉnh theo ngưỡng mẫu, ngủ khi thiếu dữ liệu)    │
├────────────────────────────────────────────────────────────────────┤
│ NÃO THANH QUẤN (steering — tác động lên LLM ĐÓNG BĂNG)             │
│   = cơ quan ĐÃ CÓ: adaptation directives (8 chiến lược),           │
│     Q-advice badge/PLAN-hint, softmax(τ) model routing,            │
│     13 tham số runtime tuning-store                                │
│   → P4 chuyển dần các cơ quan này sang nghe Brain-B/C              │
├────────────────────────────────────────────────────────────────────┤
│ TRÍ NHỚ DÀI HẠN + HỒI GIAO                                         │
│   Neo4J: knowledge graph (95.587 nodes / 204.251 rels)             │
│   SQLite: Episodic log (nguyên liệu huấn luyện) + bảng BrainModel  │
│           (trọng số + spec + lineage sau train)                    │
└────────────────────────────────────────────────────────────────────┘
```

**Phân định vai trò (trả lời nguyên tắc "dùng 3 kho làm ANN"):** các kho **không tự thành mạng nơ-ron** — Qdrant là *giác quan* (vector đầu vào), Neo4J là *trí nhớ cấu trúc*, SQLite là *hồi giao* (log huấn luyện) và *nơi cất trọng số* (`BrainModel`). Mạng nơ-ron thật = ma trận W₁…Wₗ trong `src/lib/brain/mlp.ts`, train bằng gradient descent từ dữ liệu các kho đổ về SQLite.

**Định vị trung thực so với LoRA:** LoRA kỹ thuật = ΔW = B·A nhét vào lớp attention của LLM, học bằng backprop xuyên qua model — **không khả thi không GPU**. BRAIN = **learned adapter ngoài LLM**: tác động qua bề mặt giao tiếp (prompt/routing/retrieval/ngưỡng). Triết lý giống ("hành vi thích ứng, não gốc đóng băng"), tầng kỹ thuật khác — ghi rõ để không kỳ vọng sai.

---

## 2. BỐI CẢNH DỮ LIỆU (đo ngày 2026-10-11) & NGƯỠNG THỨC TỈNH

| Nguồn nhãn | Bảng | Hiện có | Ngưỡng thức tỉnh đề xuất |
|---|---|---|---|
| Kết cục run thật | `AgentRunRecord` | 20 | Brain-B cần ≥ 60 (đối chứng bootstrap CI) |
| Phán quyết trọng tài | `ArbiterVerdict` | 10 | reward composite cần ≥ 50 verdict |
| Eval KB retrieval | `EvalResult` / `EvalCase` | 4 / 9 | Brain-A cần ≥ 30 (kế thừa `MIN_TRAIN_SAMPLES_V2`) |
| Bài học / tập | `LessonRecord` / `EpisodeRecord` | 25 / 56 | tín hiệu tự giám sát, không chặn |
| Q-learning | `QEntry` | 1 | policy head chỉ thức tỉnh khi Q có ≥ 30 entry |
| Thích ứng chiến lược | `StrategyAdaptationLog` | 0 | (vòng mới bật, chưa phát sinh) |
| KPI | `KpiSnapshot` | 11 | giám sát, không huấn luyện trực tiếp |

**Nguyên tắc "thức tỉnh theo ngưỡng":** mọi brain sinh ra ở trạng thái **ngủ** (chưa đủ mẫu → hành vi y hệt hiện tại). Chỉ khi (a) đủ số mẫu ngưỡng, (b) thắng đối chứng qua CV có CI, (c) user bật cờ → mới tham gia runtime. Đây chính là *"dữ liệu và bài học dần dần tích lũy"* — không ai phải đợi, không restart, không rủi ro hồi quy.

> **Điểm quan trọng về kho tài liệu lớn:** nguồn tài liệu lớn của user sau ingestion trở thành (i) **nguyên liệu học truy hồi** (retrieval — đã chạy mỗi ngày), (ii) **nguyên liệu tự giám sát** cho Brain (P3 tùy chọn — xem §5.4), (iii) **ngữ cảnh đặc trưng** (embedding nhiệm vụ). Kho lớn KHÔNG tự sinh nhãn "thành/bại" — nhãn đó chỉ đến từ vận hành thật (verdict, kết cục run) — nên kho lớn đủ sớm nhưng brain vẫn thức tỉnh dần theo vận hành. Chi tiết vòng học trong tác vụ thật: §5.

---

## 3. BỐN QUYẾT ĐỊNH MỞ (thảo luận với user — CHƯA CHỐT)

### 3.1 — Q1: Hàm thưởng, lan truyền tiến/ngược, hàm tối ưu hóa có chưa?

**Sự thật hôm nay (file:line):**

| Thành phần | Trạng thái | Bằng chứng |
|---|---|---|
| **Hàm thưởng (RL)** | ✅ CÓ — dạng thô {+1, 0, −1} | `q-table.ts` (W1 `markSessionAdaptationOutcome` + W2 `resolveArbiterVerdicts` — reward chốt từ verdict trọng tài & kết cục run thật) |
| **Lan truyền tiến** | ✅ CÓ — 1 lớp (sigmoid logistic) | `calibration-multifeature.ts` (V2 runtime áp β qua sigmoid) + `softmaxPolicy()` |
| **Lan truyền ngược** | ⚠️ CÓ — chỉ 1 lớp (đạo hàm log-loss, không phải backprop đa tầng) | `calibration-multifeature.ts` (mini-batch GD lr 0.05 × 1500 epoch) |
| **Hàm mất mát** | ✅ CÓ — 1 (log-loss + L2) | `calibration-multifeature.ts` |
| **Hàm tối ưu hóa** | ⚠️ CÓ — mini-batch GD thuần (không momentum, không Adam) | `calibration-train.ts` (lr 0.01 × 1000) / `calibration-multifeature.ts` (lr 0.05 × 1500) |

**BRAIN-P1 bổ sung đủ bộ chuẩn** (mục §4.1): đa lớp forward/backward (chain rule), menu activation (ReLU/tanh/sigmoid/softmax + đạo hàm), menu loss (BCE/MSE/Huber), **optimizers SGD+momentum (β=0.9) và Adam (β₁=0.9, β₂=0.999)**, khởi tạo He/Xavier có seed tất định, gradient clip, early stopping.

**Về "hàm thưởng" cho kiến trúc brain:** cần tách 2 chế độ học —
- **Supervised brain (A, B):** mục tiêu là *loss* trên nhãn (verdict/eval/kết cục) — không cần reward riêng.
- **RL brain (C):** reward có sẵn W1/W2 nhưng đang nhị phân thô. **BRAIN-P4 định nghĩa composite reward liền mạch:** `R = w₁·Outcome (verdict/run-complete) + w₂·Efficiency (tokens/latency đối chiếu baseline Wilson) + w₃·Chất lượng KB (faithfulness, coverage)` — trọng số w khởi điểm từ sweep dữ liệu rồi hardcode kèm chú thích nguồn (doctrine #1). Reward mới chỉ ghi song song (log-only) ít nhất 2 đợt quan sát trước khi tham gia quyết định — đúng tiền lệ P6-M3.

**Trạng thái: CHỜ USER CHỐT** — khuyến nghị: duyệt P1 (thuần nền tảng, không đổi hành vi).

### 3.2 — Q2: NIM 2048-dim — đầu vào 512-dim pilot có phù hợp?

**Sự thật kỹ thuật:** model đang chạy là `nvidia/nemotron-3-embed-1b` (NIM, 2048-dim — `embeddings.ts:46`). Model này **hỗ trợ Matryoshka Representation Learning** (tham số `dimensions` trong payload; `input_type` query/passage — `embeddings.ts:10,50`). Pilot P5-M1 (stats blueprint) đã dựng sẵn: dual-write bản truncate 512-dim vào collection pilot, **đường đọc vẫn 2048 cho tới khi recall đối chứng đạt** — hiện pilot mặc định OFF (`MATRYOSHKA_PILOT` off, `TuningParam` = 0 dòng).

**Đánh giá phù hợp cho BRAIN input:**
- ✅ **Phù hợp về kỹ thuật MRL**: 512 chiều đầu của vector MRL giữ phần lớn ngữ nghĩa — NVIDIA thiết kế đúng để truncate.
- ✅ **Bộ não cần ít trung thực hơn retrieval**: để phân loại "nhiệm vụ loại nào / cấu hình nào tốt", tín hiệu 512-dim đủ phân biệt; không cần độ phân giải ngữ nghĩa đầy đủ như tìm kiếm.
- ⚠️ **Rủi ro thật là overfit chứ không phải mất thông tin**: input 512 + hidden 32 ≈ 16–17K tham số trong khi mẫu hiện 20–56 → L2 mạnh + early stopping + CV bắt buộc (đã là pattern của V2).
- ⚠️ **Điều kiện tiên quyết**: pilot phải được bật và đối chứng recall 512 vs 2048 trước khi chọn 512 làm input mặc định (chính mục đích pilot).

**Khuyến nghị của blueprint:** input là **tham số spec của brain** (`inputMode`), 3 chế độ —
| inputMode | Nguồn | Khi nào dùng |
|---|---|---|
| `mrl-512` | truncate từ vector 2048 đang có (không gọi API thêm) | mặc định SAU khi pilot đối chứng đạt |
| `pca-128` | PCA fit trên kho vector chính (tái dùng `stats/pca.ts`), ma trận hệ số lưu trong `BrainModel.specJson` | lựa chọn an toàn khi pilot chưa đạt — nén có kiểm soát, không phụ thuộc MRL |
| `full-2048` | vector gốc | đối chứng ablation (đắt nhất, dễ overfit nhất) |

P2 bắt buộc chạy ablation cả 3 (cùng dữ liệu, cùng seed) — chọn mode bằng số, không bằng cảm tính.

**Trạng thái: CHỜ USER CHỐT** — khuyến nghị: `pca-128` làm mặc định tạm, `mrl-512` bật sau đối chứng pilot.

### 3.3 — Q3: Tích hợp LangChain, LangGraph, Keras được không?

**Đánh giá từng thư viện (nguyên tắc doctrine: "không thêm framework mới"):**

| Thư viện | Tích hợp? | Lý do / Cái đã có tương đương trong TMO |
|---|---|---|
| **LangChain** (JS) | ❌ KHÔNG khuyến nghị | Trùng lặp năng lực: orchestration đã có `agent-goal-loop` + `omega-orchestrator` + `master-orchestrator` + `workflow-engine` + code-team/research-team; retriever đã có `kb-routing/` (hybrid, rerank, MMR, intent-classifier); loader/splitter đã có `ingestion/` + `chunking.ts`; memory đã có memory-tiers + episodic. Thêm vào = 2 hệ song song cùng chức năng, tăng bề mặt phụ thuộc. |
| **LangGraph** (JS) | ❌ KHÔNG khuyến nghị (giữ làm tham chiếu thiết kế) | Graph state machine + checkpointing đã có tương đương: goal-loop checkpoints, `state-management/checkpoint-manager`, `session-resume`. |
| **Keras** (Python) | ⏸ KHÔNG bây giờ — mở cửa P5 | TS không chạy Keras trực tiếp. Con đường hợp lệ: **mini-service Python sidecar** (platform đã có hạ tầng python runtime build + container runner — `tests/python-runtime-build.sh` / `python-runtime-container.sh`). Chỉ có lý do khi có GPU để train mô-đun lớn (GCN Neo4J, LoRA thật). P1–P4 thiết kế ngay **biên giao tiếp tương thích**: `BrainModel` spec/weights serialize theo format numpy-đọc-được (JSON mảng phẳng + shape), để sidecar tương lai đọc/ghi thẳng mà không làm lại kho. |

**Kết luận khuyến nghị:** P1–P4 thuần TypeScript (thuận kiểm thử, tất định, không phụ thuộc); **không tích hợp 3 thư viện trên trong lộ trình này**; P5 chốt contract sidecar (REST: train/predict/export) — khi có GPU thì Keras/PyTorch cắm vào mà không sửa não TMO.

**Trạng thái: CHỜ USER CHỐT** — khuyến nghị: không tích hợp, mở biên giao tiếp P5.

### 3.4 — Q4: Học từ kho tài liệu lớn trong tác vụ thật — học truy hồi + tăng cường + sâu + ghi ngược + truy vết nguồn?

**CÂU TRẢ LỜI NGẮN: CÓ — và hạ tầng đã có ~70%, BRAIN bổ đúng phần khuyết.** Phân tích từng cơ chế trong 1 tác vụ thật:

| Cơ chế user hỏi | Hôm nay | BRAIN bổ sung |
|---|---|---|
| **Học truy hồi** (retrieval-augmented) | ✅ đủ: hybrid search + rerank + MMR + intent-classifier (`kb-routing/`), citation `[Source N]` → `document_id` → metadata (`query/route.ts:55-233`) | P3: đặc trưng retrieval (coverage, nDCG, số chunk) thành **input của brain** thay vì chỉ hiển thị |
| **Học tăng cường** | ✅ vòng W1/W2 → Q-update (fail-open, tức thì — "online nhẹ") | P4: composite reward liền mạch + policy head |
| **Học sâu** | ❌ chưa có | P2–P3: Brain-A/B train từ log thật (offline batch có CV gate) |
| **Ghi ngược tri thức** (writeback) | ✅ đủ: writeback vùng xám + review + reconcile + transactional-writeback + drift-heal (`kb-routing/writeback*.ts`); lessons/episodes tự ghi | P4: khi brain chốt *"cấu hình X tốt cho loại nhiệm vụ Y"* (đủ CI) → ghi `LessonRecord` kèm provenance |
| **Truy vết nguồn tri thức sử dụng** | ✅ một phần: citation trong câu trả lời; evidence-log của research-team | **P3 bổ `dataLineage` đầy đủ** (xem §5.3): chuỗi tác vụ → chunk → document → verdict → reward → mẫu huấn luyện → phiên bản brain — trả lời được *"não này học từ nguồn nào, bao nhiêu mẫu, kết quả CV bao nhiêu"* |

**Điểm thiết kế quan trọng (học trong tác vụ THẬT):**
- **Hai tốc độ, không trộn:** (1) *online nhẹ* trong hot path — Q-update + episodes/lessons (rẻ, tức thì, fail-open — đã chạy); (2) *offline batch* — retrain brain định kỳ qua cron scheduler sẵn có, thăng cấp qua CV gate. **KHÔNG deep-learning online trong đường nóng** (nguy cơ catastrophic forgetting + độ trễ + khó kiểm chứng — trái doctrine fail-open).
- **Kho tài liệu lớn đóng 3 vai:** ngữ cảnh retrieval (mỗi ngày), nguyên liệu tự giám sát cho brain (§5.4), nguồn đặc trưng embedding. Kho lớn cho phép brain "ngủ an toàn" lâu hơn về dữ liệu ngữ cảnh nhưng vẫn chỉ thức tỉnh theo nhãn vận hành thật.
- **Chu kỳ khép:** tác vụ → học truy hồi → LLM đóng băng → đánh giá → reward → online nhẹ + offline batch → brain thăng cấp → steering chu kỳ sau mạnh hơn. Đúng mô tả của user: *"dữ liệu và bài học dần dần tích lũy, các model khi được gọi ra sẽ vận hành qua một bộ não do chúng ta xây dựng và tùy chỉnh"*.

**Trạng thái: CHỜ USER CHỐT** — khuyến nghị: duyệt nguyên tắc 2 tốc độ + dataLineage.

---

## 4. CHI TIẾT TRIỂN KHAI TỪNG PHASE

### 4.1 BRAIN-P1 — NỀN TOÁN MLP + KHO TRỌNG SỐ + HIỂN THỊ ANN THẬT

**Mục tiêu:** từ ngày merge P1, câu *"ANN với các lớp, activation, loss, lan truyền, optimizer"* có câu trả lời bằng đồ vật thật — không còn là ẩn dụ.

**Tạo mới `src/lib/brain/` (thuần toán, KHÔNG import gì ngoài `@/lib/stats` — an toàn client bundle lẫn bun:test, đúng pattern `neural-layout.ts`):**

| File | Nội dung |
|---|---|
| `activations.ts` | relu, tanh, sigmoid, softmax + đạo hàm từng hàm (cho backward) |
| `losses.ts` | BCE (log-loss), MSE, Huber + đạo hàm; tổng hợp `L2 regularizer` |
| `init.ts` | He (cho relu) / Xavier (tanh/sigmoid); seed tất định tái dùng pattern `deterministicSeed` của q-table |
| `optimizers.ts` | SGD+momentum (β=0.9), Adam (β₁=0.9, β₂=0.999, ε=1e-8) — interface thống nhất `step(grads, params)` |
| `mlp.ts` | Lớp `MLP`: spec `{layers:[{units,activation}], loss, optimizer, lr, l2, seed}` · **forward** `aₗ = φ(Wₗ·aₗ₋₁ + bₗ)` · **backward** `δ_L = ∇_a L`, `δₗ = (Wₗ₊₁ᵀ δₗ₊₁) ⊙ φ′(zₗ)` · mini-batch shuffle theo seed · gradient clip (norm 5) · early stopping (patience) · `fit() / predict() / predictProba()` · serialize/deserialize weights (mảng phẳng Float64 + shape — numpy-đọc-được cho P5) |

**Prisma (additive, +1 model — KHÔNG đụng 98 model cũ):**
```prisma
model BrainModel {
  id            String   @id @default(cuid())
  brain         String   // 'calibration_v3' | 'surrogate' | 'policy'
  version       Int
  inputMode     String   // 'mrl-512' | 'pca-128' | 'full-2048' | 'features-10'
  specJson      String   // layers/activation/loss/optimizer/lr/l2/seed + pcaMatrix nếu inputMode=pca-128
  weightsJson   String   // mảng phẳng + shape (JSON)
  trainMetaJson String   // n mẫu, khoảng thời gian dữ liệu, CV score + CI, Brier/MAE, trainedAt, dataLineage (§5.3)
  active        Boolean  @default(false)   // chỉ 1 bản active mỗi brain
  createdAt     DateTime @default(now())
  @@unique([brain, version])
}
```

**UI — tab Kiến trúc thêm panel "Não vận hành":** đọc `/api/brain` (GET liệt kê BrainModel) → vẽ đồ thị lớp THẬT của từng brain: input (số units = dim inputMode) → hidden (units + tên activation) → output (units + loss) + thanh trạng thái **NGỦ / THỨC TỈNH / ACTIVE** (theo ngưỡng mẫu §2) + nút "Huấn luyện lại" (chạy batch, fail-open). Panel dùng đúng hạ tầng pan/zoom/font P3 đã có.

**Test:** `tests/r84-brain-math.test.ts` — thuần, DB-cô-lập theo pattern gate: (1) đạo hàm backward khớp **sai phân hữu hạn** (numerical gradient check, ngẫu nhiên 20 spec); (2) MLP học được bài toán tổng hợp đã biết đáp án (vd: XOR 2-2-1 — bài toán logistic 1 lớp KHÔNG giải được — chứng minh đa lớp có giá trị thật); (3) tất định: cùng seed + cùng dữ liệu → cùng weights bit-đối-bit; (4) optimizer: Adam hội tụ nhanh hơn GD thuần trên cùng bài; (5) serialize → deserialize → predict giống hệt.

**Điểm dừng an toàn:** không một dòng runtime nào đổi hành vi. Merge an toàn bất kỳ lúc nào.

### 4.2 BRAIN-P2 — BRAIN-A: CALIBRATION V3 (MLP thay logistic)

- **Đầu vào:** 2 chế độ đối chứng: (a) `features-10` — đúng 10 đặc trưng của V2 (so sánh sạch cùng input); (b) `pca-128`/`mrl-512` — đầu vào vector (§3.2).
- **Kiến trúc khởi điểm:** `features-10: 10→16(tanh)→1(sigmoid)+BCE`; `pca/mrl: N→32(tanh)→1(sigmoid)+BCE`. Chọn bằng CV, không bằng cảm tính.
- **Quy trình thăng cấp — KẾ THỪA NGUYÊN VẸN pattern V2** (`calibration-multifeature.ts`): 5-fold CV stratified → chỉ thắng khi `cvBrier(V3) < cvBrier(V2)` (ngặt — bằng nhau không tính); V2 đối chứng được train lại trên cùng 4 fold mỗi lượt; dưới 30 mẫu → không train (ngủ); fail-open tuyệt đối — runtime KHÔNG BAO GIỜ tệ hơn tín hiệu thô.
- **Runtime:** `calibration.ts` đọc chuỗi V1 → V2 → V3 theo `active` + cờ `CALIBRATION_V3` (STORE > ENV > DEFAULT=off) — đúng chuỗi hiệu lực đang dùng.
- **Trigger train:** nút UI (P1) + cron định kỳ (scheduler sẵn có) — không tự train trong request path.
- **Test:** `tests/r85-brain-calibration-v3.test.ts` — CV gate, fail-open mọi nhánh, rollback `active=false`.

### 4.3 BRAIN-P3 — BRAIN-B: SURROGATE PREDICTOR + REPLAY-EVAL (BƯỚC LEO LEVEL 2)

- **Tập huấn luyện:** `AgentRunRecord` (model, cycles, tokensUsed, toolCalls, toolFailures, durationMs, complete, status) ⨯ `ArbiterVerdict` ⨯ `EvalResult` ⨯ đặc trưng nhiệm vụ (embedding inputMode + độ phức tạp context).
- **Đầu ra (đa đầu ra hoặc 3 model riêng — quyết định khi triển khai):** `P(success)`, `E[tokens]`, `E[durationMs]`.
- **Chế độ replay-eval:** API `POST /api/brain/replay` — chấm một cấu hình (model, strategy, lớp nhiệm vụ) **trên surrogate thay vì chạy thật**; báo cáo kèm khoảng tin cậy bootstrap. Dùng ngay cho: model-comparison (bổ trợ ANOVA P4-M2), Q-advice bootstrap các action chưa thử (giảm chi phí exploration), sweep cấu hình retrieval.
- **Đây là bước chuyển cấp khung thẩm định:** từ "mỗi ứng viên phải thực thi trực tiếp" (Level 1) sang "đánh giá hàng nghìn cấu hình trên replay" (Level 2) — không cần GPU, không cần framework ngoài.
- **Tùy chọn tự giám sát từ kho lớn (§3.4/Q4):** đặc trưng "tác vụ gần giống nào đã từng chạy" — ANN search trên Qdrant chính kho tìm run quá khứ tương tự → feature `k-NN stats` cho surrogate (không nhãn mới, chỉ tái dùng kho).
- **Test:** `tests/r86-brain-surrogate.test.ts` — CV chất lượng dự đoán (AUC/MAE kèm Wilson CI), replay không bao giờ ghi DB ngoài read-only, cờ OFF mặc định.

### 4.4 BRAIN-P4 — BRAIN-C: POLICY HEAD + COMPOSITE REWARD + STEERING

- **Composite reward (§3.1):** ledger tái dùng `StrategyAdaptationLog` + `ArbiterVerdict` + `AgentRunRecord` (không bảng trừ `RewardWeight` sweep nếu cần); **log-only 2 đợt quan sát** trước khi tham gia quyết định (tiền lệ P6-M3).
- **Policy head:** `π(a | đặc trưng nhiệm vụ)` — khởi điểm là **mixture an toàn**: prior = softmax(Q/τ) hiện có, network học residual; cold-start/thiếu dữ liệu → nghe Q nguyên vẹn (fail-open). Tận dụng cờ `RUNTIME_POLICY` (off mặc định) song song `RUNTIME_MODEL_POLICY` cũ — không đụng đường chạy nóng khi chưa duyệt.
- **Chuyển cơ quan lái (từng cái một, mỗi cái kill-switch độc lập):** (1) model routing `llm.ts`; (2) adaptation directives `adaptation-engine.ts`; (3) 13 tham số tuning-store — brain chỉ **đề xuất** giá trị vào change-log (P2 đã có audit trail), người duyệt vẫn là user qua UI cho tới khi có dữ liệu đối chứng đủ mạnh để tự động từng tham số.
- **Ghi ngược tri thức:** brain chốt "cấu hình X tốt cho loại nhiệm vụ Y" (đủ CI) → sinh `LessonRecord` kèm provenance đầy đủ (§5.3) — bài học do não sinh ra nằm cùng kho bài học do vận hành sinh ra, cùng cơ chế confidence/decay hiện có.
- **Test:** `tests/r87-brain-policy.test.ts` — mixture fallback, kill-switch từng cơ quan, reward log-only không tác động quyết định khi cờ off.

### 4.5 BRAIN-P5 — BIÊN GIAO TIẾP GPU/PYTHON (DÀI HẠN, NGOÀI PHẠM VI LỘ TRÌNH NÀY)

- **Chỉ chốt contract trong P1** (weights format numpy-đọc-được) để sidecar tương lai (Keras/PyTorch, mini-service Python — platform có runtime build sẵn) cắm vào mà không sửa não TMO.
- Các ứng viên khi có GPU: GCN encoder trên Neo4J (95.587 nodes) → đặc trưng đồ thị dùng chung; hypernetwork sinh trọng số (Level 3 thật); LoRA thật khi có model tự host.
- **Không triển khai, không hẹn thời điểm.**

---

## 5. HỌC TRONG VẬN HÀNH THẬT — VÒNG KÉP (trả lời chi tiết Q4)

### 5.1 Sơ đồ vòng học (đích sau P4)

```
TÁC VỤ THẬT
   │
   ├─(1) HỌC TRUY HỒI: hybrid search + rerank + MMR trên Qdrant/Neo4J
   │        └─ citation [Source N] → document_id (truy vết nguồn) ── đã có
   ├─(2) LLM ĐÓNG BĂNG thực thi (model do routing chọn)
   ├─(3) ĐÁNH GIÁ: arbiter verdict + eval (faithfulness, nDCG, coverage) ── đã có
   ├─(4) REWARD: W1/W2 (+ composite sau P4) ── đã có (P4 mở rộng)
   │
   ├─(5) ONLINE NHẹ (tức thì, fail-open — đã có): Q-update · episodes · lessons
   │
   └─(6) OFFLINE BATCH (cron — P2+): retrain Brain-A/B/C từ SQLite log
            └─ CV gate → thăng cấp BrainModel(active) → dataLineage ghi nguồn
                     └─(7) STEERING chu kỳ sau: directives / routing / tuning
                              nghe brain (P4, kill-switch từng cơ quan)
```

### 5.2 Nguyên tắc 2 tốc độ (KHÔNG học sâu online trong đường nóng)

Online chỉ những thứ rẻ + an toàn (Q bảng, episodes — đã chạy). Deep learning luôn offline batch + thăng cấp qua cổng CV. Lý do: catastrophic forgetting, độ trễ hot path, không kiểm chứng được — trái doctrine fail-open của dự án.

### 5.3 Provenance chain (dataLineage) — truy vết "não học từ nguồn nào"

Mỗi `BrainModel.trainMetaJson.dataLineage` lưu: khoảng thời gian dữ liệu · bảng nguồn + số dòng mỗi bảng · danh sách episodeId/evalId/verdictId (hash tổng nếu quá dài) · inputMode + PCA matrix hash · CV score + CI. Kết hợp citation sẵn có ở (1) → **truy vết trọn vòng**: *tài liệu gốc → chunk truy hồi → câu trả lời → phán quyết → reward → mẫu huấn luyện → phiên bản brain → quyết định steering*. Đây là điều kiện để bài học do não sinh ra (P4) được cộng đồng tin cậy — và là bằng chứng audit cho khung Level 0–3.

### 5.4 Vai trò kho tài liệu lớn (nguồn user)

(i) ngữ cảnh học truy hồi mỗi ngày — đã chạy; (ii) **nguyên liệu tự giám sát** cho brain: đặc trưng cấu trúc tài liệu (độ sâu heading, mật độ thực thể, domain) → dự đoán độ khó/độ tin — không cần nhãn; (iii) nguồn embedding đặc trưng nhiệm vụ; (iv) **k-NN lịch sử** cho surrogate (§4.3). Kho lớn cho brain "khởi động sớm" về đặc trưng, nhưng nhãn thành/bại vẫn chỉ đến từ vận hành thật — brain thức tỉnh dần, an toàn.

---

## 6. RỦI RO & GIẢI PHÁP

| Rủi ro | Giải pháp |
|---|---|
| Overfit trên dữ liệu nhỏ (20–56 mẫu) | L2 mặc định, early stopping, CV bắt buộc, ngưỡng thức tỉnh §2, UI luôn hiển thị n mẫu + CI cạnh mọi điểm số (không có điểm số trần trụi) |
| Concept drift (mô hình cũ lạc hậu) | Đối chứng định kỳ (cron), thua đối chứng → `active=false` tự động về bản cũ (fail-open) |
| Brain quyết định sai gây cascade | Kill-switch từng cơ quan (P4), Wilson CI dưới ngưỡng → não ngủ lại, mọi fallback về hành vi hiện tại |
| Chi phí CPU train | Chỉ offline qua cron + nút thủ công; forward mili-giây (16–100K tham số) chèn đường nóng không đáng kể |
| "Ảo giác hiệu năng" trên benchmark nhỏ | Bài toán tổng hợp P1 chỉ dùng test toán; mọi claim hiệu năng runtime phải kèm CI + n mẫu |
| Phụ thuộc Python/GPU lỡ hẹn | P1–P4 thuần TS độc lập hoàn toàn; P5 chỉ là biên mở |

---

## 7. DOCTRINE COMPLIANCE (đối chiếu 9 nguyên tắc BLUEPRINT-STATS-LEARNING)

1. Hardcode từ dữ liệu — composite reward weights chỉ định nghĩa bằng sweep, kèm chú thích nguồn. ✅
2. Đo trước đổi sau — brain nào cũng ngủ tới khi thắng đối chứng CV. ✅
3. Fail-open đo lường / fail-closed an toàn — mọi brain lỗi → fallback bản cũ; kill-switch từng cơ quan. ✅
4. 1 phase = 1 commit `feat(BRAIN-P{n})` + quality-gate PASS trước push. ✅
5. Schema chỉ additive — +1 model `BrainModel`, không đụng 98 model cũ. ✅
6. Test pattern round — r84→r87. ✅
7. Giao thức quan sát — mọi phát hiện vận hành append `Bug_v2.md` (BUG2-1XX). ✅
8. Cờ bật mặc định OFF — `CALIBRATION_V3` / `REPLAY_EVAL` / `RUNTIME_POLICY`. ✅
9. Single-source hằng số — spec brain duy nhất trong `BrainModel.specJson` + import lại. ✅

---

## 8. DANH SÁCH CHỜ USER CHỐT TRƯỚC KHI TRIỂN KHAI

| # | Quyết định | Khuyến nghị blueprint | Trạng thái |
|---|---|---|---|
| 1 | Duyệt BRAIN-P1 (nền toán + kho + UI — không đổi hành vi) | Triển khai trước, an toàn tuyệt đối | ☐ |
| 2 | Q1 — composite reward (P4) có đúng ý muốn? | log-only 2 đợt trước khi tác động | ☐ |
| 3 | Q2 — inputMode mặc định | `pca-128` tạm, `mrl-512` sau đối chứng pilot; ablation cả 3 bắt buộc | ☐ |
| 4 | Q3 — không tích hợp LangChain/LangGraph/Keras, mở biên P5 | Chấp nhận rủi ro trùng lặp → không tích hợp | ☐ |
| 5 | Q4 — nguyên tắc 2 tốc độ + dataLineage | Duyệt | ☐ |
| 6 | Thứ tự P2→P3→P4 cố định, P5 treo | Đồng ý | ☐ |

> **Ghi chú phiên bản 0.1:** tài liệu này là DRAFT để thảo luận — mọi con số effort/ngưỡng là ước lượng ban đầu, sẽ chốt lại theo từng phase. CHƯA có dòng code nào được viết cho BRAIN.
