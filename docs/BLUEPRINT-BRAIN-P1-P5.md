# BLUEPRINT TRIỂN KHAI BRAIN P1 → P5 — "NÃO VẬN HÀNH" MLP-CPU CHO TMO

> **Phiên bản:** 0.4 — **DRAFT, ĐANG THẢO LUẬN.** Nền toán MLP (§4.1) **ĐÃ triển khai (2026-10-12 — src/lib/brain/ + test r84 41/41 PASS)**; Brain-A/B/C (§4.2–4.4) **CHƯA triển khai** (chưa brain nào train thật) — riêng **phần UI của P1 đã áp dụng sớm theo chỉ thị user (P/S, 2026-10-12)**: panel "Não vận hành" trên tab Database > Kiến trúc + model `BrainModel` + `/api/brain` + `src/lib/brain/registry.ts` (chỉ hiển thị trạng thái theo số liệu thật, chưa có train).
> Được tạo theo chỉ thị user (2026-10-11): *"tạo một file .md lộ trình triển khai, cần triển khai những gì và triển khai như thế nào. Tuy nhiên chưa triển khai ngay mà vẫn cần thảo luận thêm."*
>
> **Nhật ký hiệu đính 0.3 → 0.4 (chỉ thị user 2026-10-12 — trước khi triển khai):** §9.2 bổ sung yêu cầu **tổng nhãn vận hành tích lũy** hiển thị cạnh phải dòng tiêu đề panel Não vận hành (luôn hiện, cộng theo nguồn không trùng, fail-open — áp dụng sớm cùng ngày); §4.5 ghi nhận xác nhận user: **P5 để xa về sau, chỉ cần khi tự huấn luyện model riêng** — hiện chưa cần; user duyệt triển khai **BRAIN-P1** (§8 mục 1) — nền toán `mlp.ts` + `activations/losses/init/optimizers` + test `r84` (đã triển khai cùng ngày — 41/41 PASS).
>
> **Nhật ký hiệu đính 0.2 → 0.3 (góp ý UI/UX của user, 2026-10-12):** bổ sung **§9 BRAIN-UX — phase UI/UX cuối cùng** (đặt sau khi hoàn thành P1→P4 theo chỉ thị): UX-1 Brain Studio (nút chọn bộ não + chỉnh sửa kiến trúc: thêm/bớt lớp, số nơ-ron/lớp, menu activation mở rộng đủ 9 hàm sigmoid/linear/tanh/ReLU/Leaky ReLU/ELU/Swish/GELU/softmax) · UX-2 Training Console (chỉnh trọng số loss từng đầu ra + siêu tham số khối train + override composite reward qua tuning-store) · UX-3 "đường dây ánh sáng" bezier động hiển thị hướng lan truyền, click sửa được lớp/nơ-ron/cạnh · UX-4 tái bố cục tab Kiến trúc (giữ nguyên đồ thị hệ thống 6 lớp — phần user đánh giá tốt) · UX-5 theme dark-hi-tech toàn app (viền sáng chuyển động, nút nhô bóng, cờ `UI_HITECH`) · bảng mới `BrainSpecDraft` (additive — model 100) · test r88–r91 · §8 thêm mục chờ duyệt 7–9 · ghi chú chéo menu activation mở rộng vào §4.1.
>
> **Nhật ký hiệu đính 0.1 → 0.2 (audit 2 lượt — vai System & AI Architecture Auditor, 2026-10-12):** lượt 1 xác thực toàn bộ claim file:line / hằng số / đếm bảng — **khớp 100%** (đo lại live cùng ngày: AgentRunRecord=20, ArbiterVerdict=10, EvalResult=4, EvalCase=9, LessonRecord=25, EpisodeRecord=56, QEntry=1, StrategyAdaptationLog=0, KpiSnapshot=11, TuningParam=0; `stats/pca.ts` có sẵn; test kế tiếp đúng r84; đúng 98 model; đúng 9 nguyên tắc doctrine; `src/lib/embeddings.ts:46` đúng từng dòng). Lượt 2 bổ 12 điểm còn thiếu: A1 bất biến "1 bản active mỗi brain", A2 chính sách prune + ước lượng size weights, A3 kỷ luật migration (không db-push trần), A4 index `[brain, active]`, A5 cột `trainedAt`, A6 envelope weights numpy-đọc-được, A7 single-flight train lock, B1 softmax chỉ dùng lớp output, B2 early-stopping hold-out 15%, B3 ổn định số BCE/log-sum-exp, C1 chuẩn hóa thành phần composite reward, C2 công thức mixture policy — đã vá thẳng vào các mục tương ứng.
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
| **BRAIN-P1** | Nền toán MLP (lan truyền tiến/ngược, activation, loss, optimizer) + kho trọng số `BrainModel` + hiển thị **ANN thật** trên tab Kiến trúc | mới `src/lib/brain/{mlp,activations,losses,optimizers,init}.ts` · `prisma/schema.prisma` (+1 model) · `src/components/database/neural-architecture-section.tsx` (panel mới) | M | Không đổi hành vi runtime nào — thuần nền tảng + hiển thị. **HOÀN TẤT (2026-10-12): UI + `BrainModel` + `/api/brain` + `registry.ts` áp dụng sớm + nền toán 9 activation/4 loss/2 optimizer + test r84 41/41 PASS** |
| **BRAIN-P2** | **Brain-A** — Calibration V3: MLP 2 lớp thay logistic V2 khi thắng đối chứng CV | mới `src/lib/brain/brains/calibration-v3.ts` · sửa `src/lib/calibration.ts` (điểm cắm runtime) | M | `CALIBRATION_V3=off` |
| **BRAIN-P3** | **Brain-B** — Surrogate Predictor (dự đoán kết quả cấu hình KHÔNG chạy thật) + chế độ replay-eval | mới `src/lib/brain/brains/surrogate.ts` + `src/app/api/brain/replay/route.ts` | L | `REPLAY_EVAL=off` (chỉ đo/báo cáo) |
| **BRAIN-P4** | **Brain-C** — Policy head theo đặc trưng nhiệm vụ + **composite reward** + chuyển dần cơ quan lái (directives / model routing / tuning) sang nghe brain | mới `src/lib/brain/brains/policy.ts` + reward ledger thống nhất · sửa `adaptation-engine.ts` / `llm.ts` (từng cơ quan một) | L | `RUNTIME_POLICY=off` · từng cơ quan có kill-switch về hành vi cũ |
| **BRAIN-P5** | Biên giao tiếp GPU/Python (Keras/PyTorch sidecar, GCN trên Neo4J — đường lên Level 3) | mini-service python (dài hạn, **chỉ khi có GPU**) | XL | Ngoài phạm vi lộ trình này — chỉ chốt contract |
| **BRAIN-UX** (§9) | **Phase UI/UX cuối cùng** — Brain Studio (nút chọn não + sửa kiến trúc: thêm/bớt lớp, số nơ-ron, menu 9 activation) · Training Console (trọng số loss từng đầu ra + siêu tham số train) · đường dây ánh sáng động có hướng, click sửa được lớp/nơ-ron/cạnh · tái bố cục tab Kiến trúc · theme dark-hi-tech toàn app (viền sáng chuyển động, nút nhô bóng) | `neural-architecture-section.tsx` + mới `src/lib/brain/spec-schema.ts` · `BrainSpecDraft` (+1 model) · `globals.css` tokens | L (UX-1→UX-5) | `UI_BRAIN_EDIT` / `UI_SYNAPSE_FX` / `UI_HITECH` = off · **đặt SAU P1→P4 theo chỉ thị user (2026-10-12)** — UX-3/4/5 thuần trình bày, kéo sớm được theo chỉ thị |

**Thứ tự bắt buộc:** P1 → P2 → P3 → P4 → **BRAIN-UX (§9 — phase cuối cùng theo chỉ thị user 2026-10-12)**. P5 độc lập (chỉ chốt giao tiếp trong P1–P4 để không làm lại). UX-3/UX-4/UX-5 thuần trình bày (không phụ thuộc nền toán) — có thể kéo sớm theo chỉ thị riêng, tiền lệ P1-UI đã áp dụng sớm.

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
| **Lan truyền tiến** | ✅ CÓ — 1 lớp (sigmoid logistic) | `calibration-multifeature.ts` (V2 runtime áp β qua sigmoid) + `softmaxPolicy()` (Boltzmann chọn model — là phép softmax chính tắc, không phải forward của mạng đã train) |
| **Lan truyền ngược** | ⚠️ CÓ — chỉ 1 lớp (đạo hàm log-loss, không phải backprop đa tầng) | `calibration-multifeature.ts` (mini-batch GD lr 0.05 × 1500 epoch) |
| **Hàm mất mát** | ✅ CÓ — 1 (log-loss + L2) | `calibration-multifeature.ts` |
| **Hàm tối ưu hóa** | ⚠️ CÓ — mini-batch GD thuần (không momentum, không Adam) | `calibration-train.ts` (lr 0.01 × 1000) / `calibration-multifeature.ts` (lr 0.05 × 1500) |

**BRAIN-P1 bổ sung đủ bộ chuẩn** (mục §4.1): đa lớp forward/backward (chain rule), menu activation (ReLU/tanh/sigmoid/softmax + đạo hàm), menu loss (BCE/MSE/Huber), **optimizers SGD+momentum (β=0.9) và Adam (β₁=0.9, β₂=0.999)**, khởi tạo He/Xavier có seed tất định, gradient clip, early stopping.

**Về "hàm thưởng" cho kiến trúc brain:** cần tách 2 chế độ học —
- **Supervised brain (A, B):** mục tiêu là *loss* trên nhãn (verdict/eval/kết cục) — không cần reward riêng.
- **RL brain (C):** reward có sẵn W1/W2 nhưng đang nhị phân thô. **BRAIN-P4 định nghĩa composite reward liền mạch:** `R = w₁·Outcome* + w₂·Efficiency* + w₃·Quality*` — **mỗi thành phần PHẢI chuẩn hóa trước khi nhân trọng số** (audit C1: tokens ~10³–10⁵ trong khi faithfulness 0–1 — nhân thẳng thì w vô nghĩa): `Outcome* ∈ {0,1}` (verdict/run-complete), `Efficiency* = (baseline − thực tế)/baseline` kẹp [−1,1] với baseline là trung vị theo model (hạ tầng Wilson/ANOVA P4-M2 đã có), `Quality* = faithfulness ∈ [0,1]`. Trọng số w khởi điểm từ sweep dữ liệu rồi hardcode kèm chú thích nguồn (doctrine #1). Reward mới chỉ ghi song song (log-only) ít nhất 2 đợt quan sát trước khi tham gia quyết định — đúng tiền lệ P6-M3.

**Trạng thái: CHỜ USER CHỐT** — khuyến nghị: duyệt P1 (thuần nền tảng, không đổi hành vi).

### 3.2 — Q2: NIM 2048-dim — đầu vào 512-dim pilot có phù hợp?

**Sự thật kỹ thuật:** model đang chạy là `nvidia/nemotron-3-embed-1b` (NIM, 2048-dim — `src/lib/embeddings.ts:46`). Model này **hỗ trợ Matryoshka Representation Learning** (tham số `dimensions` trong payload — `src/lib/embeddings.ts:48`; `input_type` query/passage — dòng 10–11; pilot đọc runtime qua `getTuningEnum` — dòng 25 & 50). Pilot P5-M1 (stats blueprint) đã dựng sẵn: dual-write bản truncate 512-dim vào collection pilot, **đường đọc vẫn 2048 cho tới khi recall đối chứng đạt** — hiện pilot mặc định OFF (`MATRYOSHKA_PILOT` off, `TuningParam` = 0 dòng).

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
| `activations.ts` | relu, tanh, sigmoid, softmax + đạo hàm từng hàm (cho backward). **Ghi chú (audit B1): softmax chỉ dùng cho lớp output đa lớp — không đặt làm activation lớp ẩn** (không giữ tổng xác suất, gradient dễ lệch). **Mở rộng cho BRAIN-UX §9.2 (chỉ thị user 2026-10-12): thêm linear, Leaky ReLU (α=0.01 chỉnh được), ELU (α=1.0), Swish (β=1.0), GELU (xấp xỉ tanh) — đủ 9 hàm cho menu editor UX-1; spec mặc định các brain KHÔNG đổi** |
| `losses.ts` | BCE (log-loss), MSE, Huber + đạo hàm; tổng hợp `L2 regularizer`. **Ổn định số (audit B3):** sigmoid kẹp ε=1e–7 hai đầu trước log; softmax dùng log-sum-exp |
| `init.ts` | He (cho relu) / Xavier (tanh/sigmoid); seed tất định tái dùng pattern `deterministicSeed` của q-table |
| `optimizers.ts` | SGD+momentum (β=0.9), Adam (β₁=0.9, β₂=0.999, ε=1e-8) — interface thống nhất `step(grads, params)` |
| `mlp.ts` | Lớp `MLP`: spec `{layers:[{units,activation}], loss, optimizer, lr, l2, seed}` · **forward** `aₗ = φ(Wₗ·aₗ₋₁ + bₗ)` · **backward** `δ_L = ∇_a L`, `δₗ = (Wₗ₊₁ᵀ δₗ₊₁) ⊙ φ′(zₗ)` · mini-batch shuffle theo seed (**Fisher–Yates tất định**) · gradient clip (norm 5) · early stopping (patience, **đo trên hold-out 15% tách từ tập train — không đụng fold CV — audit B2**) · `fit() / predict() / predictProba()` · serialize/deserialize weights theo **envelope `{dtype:'float64', shape:number[], data:number[]}` — numpy-đọc-được cho P5 (audit A6)** |

**Prisma (additive, +1 model — KHÔNG đụng 98 model cũ; schema ĐÃ áp dụng 2026-10-12 kèm UI sớm):**
```prisma
model BrainModel {
  id            String   @id @default(cuid())
  brain         String   // 'calibration_v3' | 'surrogate' | 'policy'
  version       Int
  inputMode     String   // 'mrl-512' | 'pca-128' | 'full-2048' | 'features-10'
  specJson      String   // layers/activation/loss/optimizer/lr/l2/seed + pcaMatrix nếu inputMode=pca-128
  weightsJson   String   // envelope {dtype:'float64', shape, data} — numpy-đọc-được (P5)
  trainMetaJson String   // n mẫu, khoảng thời gian dữ liệu, CV score + CI, Brier/MAE, trainedAt, dataLineage (§5.3)
  trainedAt     DateTime @default(now())  // audit A5 — cột hạng nhất cho liệt kê/sắp xếp
  active        Boolean  @default(false)   // chỉ 1 bản active mỗi brain
  createdAt     DateTime @default(now())

  @@unique([brain, version])
  @@index([brain, active])   // audit A4 — đúng pattern truy vấn panel /api/brain
}
```

**Ghi chú DB internals (audit lượt 2):**
- **A1 — bất biến "1 active mỗi brain":** Prisma/SQLite không khai báo được partial unique index → giữ ở tầng ứng dụng: transaction ngắn `updateMany({where:{brain}, data:{active:false}})` → `update({where:{id}, data:{active:true}})`; `@@unique([brain, version])` chặn phiên bản trùng ở tầng schema. Không `$transaction` dài (bài học BUG2-119).
- **A2 — size & prune:** ước lượng weightsJson ~200–400KB/bản (features-10/mrl-512) tới ~1.5MB (full-2048) — SQLite TEXT chịu được nhưng phải có chính sách prune sau mỗi lần train thành công: **giữ bản active + 5 bản mới nhất mỗi brain** (tiền lệ prune 500 của TuningChangeLog).
- **A3 — kỷ luật migration:** repo đã chuẩn hóa chuỗi migration (baseline `0_init`) — thêm model bằng **`prisma migrate dev --name add_brain_model`** tạo thư mục migration mới + apply, KHÔNG `db push` trần (làm lệch `_prisma_migrations`).
- **A7 — single-flight train lock:** nút UI + cron có thể trùng nhịp → giữ in-process mutex (cờ module) + ràng `@@unique([brain, version])` bắt đua ở DB; train luôn chạy NGOÀI request path (cron/nút bấm → job nền).

**UI — tab Kiến trúc thêm panel "Não vận hành" (ĐÃ ÁP DỤNG 2026-10-12 theo chỉ thị P/S user):** đọc `/api/brain` (GET) → 3 thẻ brain (A "V3" · B "Vọng" · C "Lệnh"), mỗi thẻ: đồ thị lớp theo spec (`inputMode → hidden + activation → output + loss`), thanh trạng thái **NGỦ / THỨC TỈNH / ACTIVE** theo ngưỡng mẫu §2 (đếm thật từ DB: EvalResult / AgentRunRecord / QEntry / ArbiterVerdict), inputMode kế hoạch, cờ phase, nút "Huấn luyện lại" (hiện tạm **tắt** kèm lý do — nền toán P1 chưa được duyệt; khi đủ mẫu + đã duyệt thì chạy batch, fail-open). Panel dùng đúng hạ tầng pan/zoom/font P3 đã có (đồ thị brain nhỏ — không cần pan). Registry single-source tại `src/lib/brain/registry.ts` (doctrine #9) — API và UI cùng import.

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
- **Policy head:** `π(a | đặc trưng nhiệm vụ)` — khởi điểm là **mixture an toàn** với công thức tường minh (audit C2): `π(a) = λ·π_Q(a) + (1−λ)·π_net(a)` trong đó `π_Q = softmax(Q/τ)` hiện có, `λ = clamp(n samples/K, 0, 1)` giảm dần khi dữ liệu lớn lên (kèm chặn dưới Wilson CI) — thiếu dữ liệu → λ→1 = nghe Q nguyên vẹn (fail-open). Tận dụng cờ `RUNTIME_POLICY` (off mặc định) song song `RUNTIME_MODEL_POLICY` cũ — không đụng đường chạy nóng khi chưa duyệt.
- **Chuyển cơ quan lái (từng cái một, mỗi cái kill-switch độc lập):** (1) model routing `llm.ts`; (2) adaptation directives `adaptation-engine.ts`; (3) 13 tham số tuning-store — brain chỉ **đề xuất** giá trị vào change-log (P2 đã có audit trail), người duyệt vẫn là user qua UI cho tới khi có dữ liệu đối chứng đủ mạnh để tự động từng tham số.
- **Ghi ngược tri thức:** brain chốt "cấu hình X tốt cho loại nhiệm vụ Y" (đủ CI) → sinh `LessonRecord` kèm provenance đầy đủ (§5.3) — bài học do não sinh ra nằm cùng kho bài học do vận hành sinh ra, cùng cơ chế confidence/decay hiện có.
- **Test:** `tests/r87-brain-policy.test.ts` — mixture fallback, kill-switch từng cơ quan, reward log-only không tác động quyết định khi cờ off.

### 4.5 BRAIN-P5 — BIÊN GIAO TIẾP GPU/PYTHON (DÀI HẠN, NGOÀI PHẠM VI LỘ TRÌNH NÀY)

- **Chỉ chốt contract trong P1** (weights format numpy-đọc-được) để sidecar tương lai (Keras/PyTorch, mini-service Python — platform có runtime build sẵn) cắm vào mà không sửa não TMO.
- Các ứng viên khi có GPU: GCN encoder trên Neo4J (95.587 nodes) → đặc trưng đồ thị dùng chung; hypernetwork sinh trọng số (Level 3 thật); LoRA thật khi có model tự host.
- **Không triển khai, không hẹn thời điểm.**
- **Xác nhận user (2026-10-12):** P5 giữ xa về sau — chỉ cần khi tiến hành huấn luyện tạo **model riêng** cần GPU; giai đoạn hiện tại KHÔNG cần.**

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
   ├─(5) ONLINE NHẸ (tức thì, fail-open — đã có): Q-update · episodes · lessons
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
| weightsJson phình to / rác phiên bản cũ (audit A2) | Prune sau train: giữ active + 5 bản mới nhất mỗi brain; envelope dtype/shape cho sidecar P5 đọc trực tiếp |
| Train trùng nhịp (cron + nút UI cùng lúc — audit A7) | Single-flight in-process mutex + `@@unique([brain, version])` bắt đua; train luôn ngoài request path |
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
| 1 | Duyệt BRAIN-P1 (nền toán + kho + UI — không đổi hành vi) | Triển khai trước, an toàn tuyệt đối | ☑ **HOÀN TẤT (2026-10-12): UI + `BrainModel` + `/api/brain` áp dụng sớm theo chỉ thị P/S · nền toán `mlp/activations/losses/init/optimizers` + test r84 41/41 PASS — không còn phần dở** |
| 2 | Q1 — composite reward (P4) có đúng ý muốn? | log-only 2 đợt trước khi tác động | ☐ |
| 3 | Q2 — inputMode mặc định | `pca-128` tạm, `mrl-512` sau đối chứng pilot; ablation cả 3 bắt buộc | ☐ |
| 4 | Q3 — không tích hợp LangChain/LangGraph/Keras, mở biên P5 | Chấp nhận rủi ro trùng lặp → không tích hợp | ☐ |
| 5 | Q4 — nguyên tắc 2 tốc độ + dataLineage | Duyệt | ☐ |
| 6 | Thứ tự P2→P3→P4 cố định, P5 treo | Đồng ý | ☐ |
| 7 | Duyệt §9 BRAIN-UX — phase UI/UX đặt CUỐI CÙNG (sau P1→P4) theo chỉ thị 2026-10-12 | Đồng ý vị trí; UX-3/4/5 có thể kéo sớm theo chỉ thị riêng | ☐ |
| 8 | Mở rộng menu activation 4 → 9 hàm (bổ sung §4.1 — cần cho UX-1) | Duyệt — thuần thêm hàm + đạo hàm, không đổi spec mặc định | ☐ |
| 9 | Theme dark-hi-tech toàn app (UX-5) — tokens + rollout theo mô-đun + cờ `UI_HITECH` | Duyệt | ☐ |

---

## 9. BRAIN-UX — PHASE UI/UX CUỐI CÙNG: "GIAO DIỆN NÃO" & THEME HI-TECH TOÀN APP

> Bổ sung theo góp ý UI/UX của user (2026-10-12). **Vị trí lộ trình: SAU khi hoàn thành P1→P4** — đúng chỉ thị *"riêng một phần UI/UX cuối cùng sau khi hoàn thành các Phase trước đó"*. UX-3/UX-4/UX-5 thuần trình bày (không đụng nền toán/runtime) nên có thể kéo sớm theo chỉ thị riêng — tiền lệ P1-UI đã áp dụng sớm 2026-10-12. Mục tiêu tổng: đưa panel "Não vận hành" + "Bảng điều khiển tham số" từ **read-only** (chỉ xem trạng thái) lên **interactive studio** (chọn − chỉnh − chạy − nhìn thấy dòng chảy).

### 9.0 Góp ý nguồn (2026-10-12) — 5 điểm, map thẳng vào giải pháp

| # | Góp ý user (nguyên ý) | Giải pháp |
|---|---|---|
| 1 | Não vận hành cần **nút bấm ra danh sách các bộ não để chọn**, chọn não nào hiển thị não đó; từng não phải **tinh chỉnh được**: thêm/bớt lớp, chọn thuật toán activation (sigmoid, linear, tanh, ReLU, Leaky ReLU, ELU, Swish, GELU) — *"hiện tại tôi thậm chí không thể chỉnh sửa số nơ-ron của một lớp"* | UX-1 (§9.2) |
| 2 | Bảng điều khiển tham số: **không chỉnh được trọng số loss từng đầu ra**, **không chỉnh được siêu tham số khối train** | UX-2 (§9.3) |
| 3 | Các lớp nối bằng **"đường dây ánh sáng uyển chuyển, thấy được hướng di chuyển"**; **lớp / nơ-ron / đường kết nối bấm vào chỉnh sửa được**; phong cách **hi-tech, nhiều ánh sáng, chuyển động, sinh động** | UX-3 (§9.4) |
| 4 | Tab Kiến trúc: kích thước / sắp xếp vị trí / bố cục **cần thiết kế lại** — TRỪ đồ thị kiến trúc neural (giữ nguyên, phần đang tốt) | UX-4 (§9.5) |
| 5 | Toàn app: **"màn hình gương công nghệ cao với viền sáng chuyển động"**, nút có **độ nổi độ bóng**, nhìn như **màn hình dark-hacker công nghệ cao cấp sang trọng** | UX-5 (§9.6) |

### 9.1 Nguyên tắc chắn (áp dụng cho toàn §9)

1. **Draft ≠ runtime:** mọi chỉnh sửa kiến trúc / loss / siêu tham số ghi vào **bản nháp** (`BrainSpecDraft`) — bản `active` chỉ đổi qua đường đã có: train → thắng đối chứng CV → thăng cấp (bất biến A1 + §5.2 giữ nguyên). Không có đường tắt "vẽ xong chạy ngay".
2. **Lớp đầu vào / đầu ra khoá theo vai trò:** input khoá theo `inputMode` (features-10=10 · pca-128=128 · mrl-512=512 · full-2048=2048), output khoá theo brain (A=1 · B=3 đầu ra · C=×\|A\|) — tránh chỉnh làm vỡ contract dữ liệu.
3. **Bộ đếm tham số hiển thị trực tiếp khi chỉnh sửa:** `params = Σ (unitsₗ × unitsₗ₋₁ + unitsₗ)` chạy realtime; cảnh báo > 100K (dễ overfit khi chỉ có 20–56 mẫu), **chặn > 250K** (ngân sách CPU).
4. **Không framework mới:** mọi hiệu ứng (kính, viền sáng chạy, ánh sáng, bóng nút) = CSS thuần + Tailwind tokens + keyframes — không thêm dependency nào (doctrine).
5. **Hiệu ứng luôn có chốt giảm tải:** `prefers-reduced-motion` → bản tĩnh (tiền lệ P2 neural-arch) · tab ẩn → dừng (tiền lệ poll 15s) · giới hạn số phần tử vẽ (LOD).

### 9.2 UX-1 — BRAIN STUDIO: chọn bộ não + chỉnh sửa kiến trúc

**Chọn não (thay grid 3 thẻ ngang hiện tại):** nút **"Chọn não"** mở danh sách 3 brain (A "V3" · B "Vọng" · C "Lệnh") — mỗi dòng hiện trạng thái NGỦ / THỨC TỈNH / ACTIVE + số mẫu hiện/tại-ngưỡng + inputMode; **chọn não nào sân khấu giữa hiển thị não đó** (đồ thị lớn UX-3 + editor). Danh sách thu gọn giữ vai trò tổng quan trạng thái (không mất thông tin so với 3 thẻ cũ).

**Dòng tiêu đề panel — tổng nhãn tích lũy (chỉ thị user 2026-10-12, áp dụng sớm):** cạnh phải dòng tiêu đề *"Não vận hành — MLP-CPU (BRAIN)"* **luôn hiển thị badge tổng số nhãn vận hành tích lũy** — cộng theo NGUỒN (khóa signal duy nhất, không đếm trùng khi nhiều brain cùng đọc một bảng) từ các nguồn nhãn: EvalResult + AgentRunRecord + QEntry + ArbiterVerdict — đúng định nghĩa "nguyên liệu dạy não" (§2 + Q&A kiến trúc não). Số liệu đã có sẵn trong `/api/brain` (`signals[].current`) — không thêm API. Fail-open: mất `/api/brain` → ẩn badge, không chặn panel.

**Editor kiến trúc — mỗi lớp 1 hàng:**

| Thành phần | Điều khiển | Ràng buộc |
|---|---|---|
| Số nơ-ron mỗi lớp ẩn | stepper −/N/+ + nhập trực tiếp | 1–256/lớp · bộ đếm tham số chạy realtime (§9.1-3) |
| Activation mỗi lớp | dropdown 9 hàm (bảng dưới) | softmax chỉ hiện với lớp output đa lớp (audit B1) |
| Thêm / bớt lớp ẩn | nút "+ Thêm lớp ẩn" + thùng rác từng hàng | 0–6 lớp ẩn; ≥ 3 lớp → cảnh báo overfit kèm n mẫu hiện có |
| Lớp input / output | hiển thị + khoá (tooltip giải thích lý do) | §9.1-2 |

**Menu activation — mở rộng §4.1 từ 4 lên 9 hàm (đúng danh sách user yêu cầu):**

| Hàm | Công thức | Đạo hàm | Init | Ghi chú dùng |
|---|---|---|---|---|
| sigmoid | σ(x)=1/(1+e⁻ˣ) | σ(1−σ) | Xavier | đầu ra xác suất 0–1 (Brain-A output) |
| linear | f(x)=x | 1 | — | hồi quy giá trị thô (E[tokens], E[latency] của Brain-B) |
| tanh | (eˣ−e⁻ˣ)/(eˣ+e⁻ˣ) | 1−f² | Xavier | mặc định lớp ẩn các spec hiện tại |
| ReLU | max(0, x) | x>0 ? 1 : 0 | He | nhanh, chống bão hoà gradient; có thể chết đơn vị khi lr lớn |
| Leaky ReLU | max(αx, x) · α=0.01 chỉnh được | x>0 ? 1 : α | He | chống "chết đơn vị" của ReLU |
| ELU | x>0 ? x : α(eˣ−1) · α=1.0 chỉnh được | x>0 ? 1 : f+α | He | nhánh âm trơn, trung bình đầu ra ≈ 0 |
| Swish | x·σ(βx) · β=1.0 chỉnh được | σ(βx)·(1+βx·(1−σ(βx))) | He | mượt, mạnh trên mạng sâu |
| GELU | x·Φ(x) (xấp xỉ tanh) | x·φ(x)+Φ(x) | He | chuẩn transformer |
| softmax | eˣⁱ/Σⱼeˣʲ | dùng kèm cross-entropy | — | **CHỈ lớp output đa lớp** (audit B1 — không đặt lớp ẩn) |

**Lưu trữ & đối chiếu:** nháp lưu vào `BrainSpecDraft` (§9.7) — 1 nháp mỗi brain. Nút **"Lưu nháp"** · **"Phục hồi spec chuẩn"** (về mặc định `registry.ts`) · **"So sánh với bản active"** (diff lớp / activation / tham số / n mẫu / CV score từng bên). Rule validation viết **single-source tại `src/lib/brain/spec-schema.ts`**, client và server cùng import (doctrine #9).

**Cờ:** `UI_BRAIN_EDIT=off` mặc định — OFF: chỉ xem như hôm nay; ON: mở toàn bộ editor.

### 9.3 UX-2 — TRAINING CONSOLE: trọng số loss từng đầu ra + siêu tham số khối train

Thay bảng read-only hiện tại bằng bảng **chỉnh trực tiếp** — thêm cột "Giá trị" với editor inline đúng kiểu dữ liệu (số · enum · boolean), giữ nguyên cột nguồn STORE/ENV/DEFAULT, audit trail, nút reset. 3 nhóm:

- **Nhóm A — siêu tham số khối train** (ghi vào draft spec UX-1): optimizer {SGD+momentum, Adam} · lr (thang log 1e-4 → 1) · epochs 50–5000 · batch 8–256 · L2 λ 0–0.1 · patience 10–200 · hold-out 10–30% (mặc định 15 — audit B2) · grad-clip 1–10 (mặc định 5) · seed (mặc định tất định).
- **Nhóm B — trọng số loss TỪNG ĐẦU RA** (Brain-B đa đầu ra): λ_success · λ_tokens · λ_latency ∈ [0,1], chuẩn hoá Σλ=1 tự động (hiển thị %), mỗi đầu ra chọn loại loss {BCE, MSE, Huber}; công thức tổng hiển thị trực tiếp: `L = λ₁·BCE(success) + λ₂·Huber(tokens) + λ₃·Huber(latency)`. Brain đơn đầu ra (A) / softmax (C): chỉ chọn loại loss.
- **Nhóm C — composite reward (P4):** w₁ Outcome* · w₂ Efficiency* · w₃ Quality* — DEFAULT từ sweep kèm chú thích nguồn bắt buộc (doctrine #1); user override → **tuning-store STORE›ENV›DEFAULT + TuningChangeLog audit** (tiền lệ 13 tham số runtime); quy tắc log-only 2 đợt quan sát KHÔNG đổi.

**Nút "Huấn luyện"** (chỉ bật khi `trainingImplemented` + đủ mẫu ngưỡng): chạy batch ngoài request path (A7), hiển thị tiến trình từng epoch (loss train/hold-out) → kết quả CV + CI → thắng/thua đối chứng; mỗi lần chạy sinh `BrainModel` version+1 — thua đối chứng = bỏ, `active` giữ nguyên (fail-open).

### 9.4 UX-3 — ĐƯỜNG DÂY ÁNH SÁNG: kết nối động có hướng, bấm sửa được

- **Hình dáng "uyển chuyển":** cạnh = đường cong bezier (điểm điều khiển lệch vuông góc trung điểm giữa 2 nơ-ron), nét gradient sáng dần theo chiều đi — thay đường thẳng tĩnh hiện tại.
- **Thấy được hướng di chuyển:** animation nét đứt chạy dọc cạnh (`stroke-dasharray` + `stroke-dashoffset`, 2.4s linear infinite, **lệch pha theo từng cạnh** cho cảm giác dòng chảy chứ không nhấp nháy đồng loạt) + đầu mũi tên → chiều **lan truyền tiến** rõ ràng. Chế độ xem thứ hai khi có trainMeta: **lan truyền ngược** (đảo chiều + đổi tông hổ phách, độ dày theo |gradient| trung bình từng lớp — dữ liệu thật từ train, không trang trí suông).
- **Bấm để sửa (đúng góp ý: lớp, nơ-ron, đường kết nối đều bấm được):**
  - Bấm **nhãn cột lớp** → editor lớp đó (units + activation — UX-1).
  - Bấm **nơ-ron** → inspector: bias · |w| trung bình vào/ra (sau train) · activation; kèm stepper nhanh ±1 nơ-ron của lớp.
  - Bấm **cạnh** → inspector: 2 đầu nối · |w| (sau train) · tô sáng riêng đường đó; nút nhanh "Sửa 2 lớp hai đầu". *(Ghi chú trung thực: trọng số W do train sinh ra — không "vẽ tay" từng weight; chỉnh kiến trúc = chỉnh lớp / units / activation.)*
- **Hiệu năng & a11y:** LOD tối đa ~300 cạnh (quá thì sampling đại diện — tiền lệ mini-map); gộp frame bằng rAF; `IntersectionObserver` dừng animation ngoài viewport; `prefers-reduced-motion` → bản tĩnh có mũi tên; touch target ≥ 44px.
- **Sinh động nền (có nghĩa):** não ACTIVE có hào quang "thở" (pulse 4s ease-in-out); NGỦ = ánh sáng rất yếu, tĩnh — trạng thái thật chi phối trực quan, ánh sáng mang thông tin chứ không phải hiệu ứng vô nghĩa.

### 9.5 UX-4 — TÁI BỐ CỤC TAB KIẾN TRÚC (giữ nguyên đồ thị hệ thống 6 lớp)

Bố cục hiện tại xếp dọc toàn bộ card theo chiều rộng → trang dài, tỷ lệ khối chưa hợp lý. Chuyển sang **dashboard 3 vùng** (desktop ≥ 1280px):

```
┌──────────────────────────────────────────────────────────────┐
│ ĐỒ THỊ HỆ THỐNG 6 LỚP — GIỮ NGUYÊN (hero, pan/zoom P3)        │
├───────────┬──────────────────────────────────┬───────────────┤
│ THANH TRÁI │ SÂN KHẤU GIỮA (UX-3)             │ THANH PHẢI    │
│ Chọn não   │ Não đang chọn: đường dây ánh     │ Training      │
│ A / B / C  │ sáng + trạng thái + bộ đếm       │ Console (UX-2)│
│ + ngưỡng   │ tham số + nút Huấn luyện         │ + tab: Tham   │
│ thức tỉnh  │                                  │ số runtime ·  │
│ + phiên    │                                  │ Nhật ký       │
│ bản        │                                  │ (gộp từ dưới) │
└───────────┴──────────────────────────────────┴───────────────┘
<1024px: xếp dọc — đồ thị hệ thống → Não studio → console thành bottom-sheet (tiền lệ P2)
```

- Bảng 13 tham số runtime + nhật ký tinh chỉnh rời khỏi dòng chảy chính → thành 2 tab trong thanh phải (rút ngắn rõ rệt chiều dài trang).
- Kích thước chữ giữ chuẩn P3 (+1px đã duyệt — không quay lại); khoảng cách chuẩn hoá `gap-4` / `p-4`; card cùng độ cao theo hàng; mọi nút chạm ≥ 44px mobile.

### 9.6 UX-5 — THEME DARK HI-TECH TOÀN APP: "màn hình kính viền sáng"

Ngôn ngữ thiết kế: **"màn hình kính công nghệ cao trong phòng tối"** — nền sâu gần đen, bề mặt kính mờ, vành sáng chạy quanh panel, nút nhô có bóng — dark-hacker sang trọng, ánh sáng phục vụ thông tin.

- **Tokens (CSS custom properties + Tailwind — không đổi tông hiện tại, tăng độ "sống"):** nền sâu `#05070D` · bề mặt kính 2 mức (trong suốt 4–8% + blur 8px, tối đa 1 lớp chồng) · điểm nhấn giữ bảng màu sẵn có (cy · hổ phách · ngọc · tím · hồng đá).
- **Viền sáng chuyển động:** vành sáng conic-gradient quay quanh viền panel (`@property --angle`, 6s linear infinite) — trình duyệt không hỗ trợ thì fallback viền tĩnh sáng.
- **Nút độ nổi độ bóng:** gradient dọc sáng→tối + inset highlight 1px mép trên + đổ bóng dưới; hover nhô 1px, active lún 1px, focus ring sáng rõ.
- **Chỉ animate transform / opacity / --angle** (GPU-composited, không reflow); không JS chạy vòng lặp cho trang trí.
- **Cờ `UI_HITECH=off` mặc định (doctrine #8):** bật/tắt bằng 1 nút trong UI (localStorage + tuning-store) — OFF trả về giao diện hiện tại nguyên vẹn (fail-open trình bày).
- **Khả năng tiếp cận:** chữ luôn nằm trên nền chắn đặc (không để glow xuyên qua chữ) · contrast ≥ 4.5:1 (quét tự động r91) · `prefers-reduced-motion` tắt mọi vòng lặp vô hạn · dark là mặc định (không làm theme sáng).
- **Rollout theo mô-đun, mỗi mô-đun 1 commit:** shell (header/nav/footer) → dashboard → Database (4 tab) → các mô-đun còn lại. Sticky-footer + bố cục flex dọc chuẩn giữ nguyên.

```css
/* Minh hoạ tokens — globals.css, KHÔNG thêm thư viện (doctrine #4) */
:root[data-hitech='on'] { --ht-bg: #05070d; --ht-glass: rgb(255 255 255 / .04); --ht-angle: 0deg; }
@property --ht-angle { syntax: '<angle>'; initial-value: 0deg; inherits: false; }
.glass-panel { background: var(--ht-glass); backdrop-filter: blur(8px); }
.glow-border::before { /* vành sáng chạy quanh viền panel */
  content: ''; position: absolute; inset: -1px; padding: 1px; border-radius: inherit; pointer-events: none;
  background: conic-gradient(from var(--ht-angle), transparent 0 72%, var(--ht-accent) 86%, transparent 100%);
  -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
  -webkit-mask-composite: xor; mask-composite: exclude;
  animation: ht-spin 6s linear infinite;
}
@keyframes ht-spin { to { --ht-angle: 360deg; } }
@media (prefers-reduced-motion: reduce) { .glow-border::before { animation: none; } }
```

### 9.7 SCHEMA & MIGRATION (additive — model thứ 100)

```prisma
model BrainSpecDraft {
  id        String   @id @default(cuid())
  brain     String   @unique  // 1 bản nháp mỗi brain ('calibration_v3' | 'surrogate' | 'policy')
  specJson  String   // layers[{units,activation}] · lossPerHead[{type,weight}] · optimizer · hyper{lr,epochs,batch,l2,patience,holdout,clip,seed}
  note      String?  // lý do chỉnh sửa — hiển thị trong diff
  updatedAt DateTime @updatedAt
  createdAt DateTime @default(now())
}
```

- Migration: `bun run db:migrate -- --name add_brain_spec_draft` (kỷ luật A3 — không `db push` trần; 99 → 100 model).
- **KHÔNG bảng mới cho override runtime** — tái dùng `TuningParam` (STORE›ENV›DEFAULT) + `TuningChangeLog` (audit + prune sẵn có).
- Luồng nháp → runtime giữ nguyên bất biến A1: draft → train (ngoài request path) → thắng CV → `BrainModel` version+1 `active` (giao dịch 2 bước hiện hữu).
- API mới: `GET/PUT /api/brain/spec-draft` — validate bằng `spec-schema.ts` (cùng rule client, single-source).

### 9.8 TEST (pattern round, DB-cô-lập)

| Round | Phạm vi |
|---|---|
| `r88` | spec validation (biên units 1–256 · chặn > 250K tham số · menu 9 activation đủ công thức + đạo hàm) · draft lưu / phục hồi / diff · KHÔNG bao giờ ghi đè bản active |
| `r89` | chuẩn hoá Σλ=1 tự động · chuỗi hiệu lực STORE›ENV›DEFAULT · mọi set/reset có audit trail |
| `r90` | reduced-motion → render tĩnh có mũi tên · tab ẩn → dừng rAF · LOD cắt cạnh đúng · hit-target cạnh/nơ-ron (point-to-bezier) chính xác |
| `r91` | quét contrast mọi cặp chữ/nền ≥ 4.5:1 · `UI_HITECH=off` → DOM không còn class hiệu ứng · no-regression snapshot các trang chính |

### 9.9 RỦI RO RIÊNG PHẦN UX & GIẢI PHÁP

| Rủi ro | Giải pháp |
|---|---|
| Hiệu ứng nặng làm tụt máy yếu / mobile | Budget 60fps (đo rAF counter); tụt < 45fps liền 2s → tự hạ cấp (tắt glow/blur); mobile giảm hiệu ứng (`pointer: coarse`) |
| Chỉnh spec tự do làm não xấu đi | Draft không chạm runtime; `active` chỉ qua CV; bộ đếm tham số + cảnh báo overfit (n mẫu vs params) ngay tại editor |
| Glow / kính làm mất khả năng đọc | Chữ luôn trên nền chắn đặc; quét contrast tự động r91 |
| `backdrop-filter` tốn GPU | Tối đa 1 lớp chồng; mobile dùng gradient đậm thay blur |
| Theme toàn app phình phạm vi | Rollout từng mô-đun — mỗi mô-đun 1 commit nhỏ; cờ tắt toàn cục 1 nút |
| Trạng thái chọn não / bảng gây rối | Mọi panel có "Về mặc định"; lựa chọn lưu localStorage |

### 9.10 THỨ TỰ, CỜ, EFFORT

| Giai đoạn | Việc | Phụ thuộc | Effort | Cờ (mặc định OFF) |
|---|---|---|---|---|
| UX-1 | Brain Studio — chọn não + sửa kiến trúc | P1 (nền toán để validate) | M | `UI_BRAIN_EDIT` |
| UX-2 | Training Console — loss từng đầu ra + siêu tham số | P1 + P3 (đa đầu ra Brain-B) | M | `UI_BRAIN_EDIT` |
| UX-3 | Đường dây ánh sáng động + bấm sửa được | P1-UI (đã có) | L | `UI_SYNAPSE_FX` |
| UX-4 | Tái bố cục tab Kiến trúc | — (thuần trình bày) | M | — |
| UX-5 | Theme hi-tech toàn app | — (thuần trình bày) | L | `UI_HITECH` |

**Thứ tự mặc định: sau khi hoàn thành P1→P4** (chỉ thị user 2026-10-12). UX-3 / UX-4 / UX-5 không phụ thuộc nền toán — có thể kéo sớm theo chỉ thị riêng (tiền lệ P1-UI). Mỗi giai đoạn = 1 commit `feat(BRAIN-UX{n})` + quality-gate PASS trước push.

---

> **Ghi chú phiên bản 0.4:** tài liệu này là DRAFT để thảo luận — mọi con số effort/ngưỡng là ước lượng ban đầu, sẽ chốt lại theo từng phase. **Nền toán MLP + test r84 ĐÃ triển khai (2026-10-12, 41/41 PASS — không đổi hành vi runtime)**; Brain-A/B/C (P2–P4) chưa train thật. Đã áp dụng sớm theo chỉ thị user: (2026-10-12, P/S) phần UI hiển thị + kho `BrainModel` + `/api/brain` + `registry.ts`; (2026-10-12, góp ý UI/UX) **§9 BRAIN-UX** + badge tổng nhãn ở tiêu đề panel Não vận hành (§9.2).
