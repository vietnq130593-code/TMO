# TB-05 — G3 ENGINE: HAN — OPTIMIZER + SELF-EVOLVING (M1) / ARCHITECTURE PROPOSER (M2) + TEAM KNOWLEDGE BASE

> 🚀 **TECHNICAL BLUEPRINT — AI RESEARCH TEAM (DUAL MISSION: M1 KAGGLE + M2 SYSTEM RESEARCH TMO)**
> Source of Truth: `upload/ai-team-workflow.md` — section "🚀 CHI TIẾT G3 — CƠ CHẾ SELF-EVOLVING CỦA HAN" (dòng 1119–1716) + TEAM KNOWLEDGE BASE bên trong nó + tham chiếu ngang: KNOWLEDGE CAPTURE (dòng 1718–1825), G2 vs G3 chiến lược đọc (dòng 3986–4028), ví dụ M2 chat 121s (dòng 4428–4511), Ghi chú agents (dòng 4560–4615)
> Tập blueprint: 13 file (TB-00 → TB-12) — file này thuộc **nhóm B — Engines** · file duy nhất còn thiếu của nhóm Engines (TB-03/TB-04/TB-06/TB-07 đã hoàn thành)
> Version: 1.2 | Ngày: 2026-08-31 (review + fix — Task 9, 10-c) | Author: Mr. Robot (Z.ai Code) — Task ID 8-d (RETRY — lần chạy trước lỗi hạ tầng 429, viết lại từ đầu)
> **v1.3 (2026-09-01):** toàn bộ [Q] đã chốt theo DECISION-RECORD-v1.3.md (user ủy quyền, thorough-first) — xem Phụ lục Z nguồn.
>
> ⚠️ Quy tắc số 1 (TB-00 §5): nguồn là Single Source of Truth — TB-05 MÔ RỘNG để triển khai được, KHÔNG thay đổi thiết kế nguồn. `[SRC]` = giữ nguyên ý nguồn · `[EXT]` = mở rộng mới, không mâu thuẫn nguồn · `[Q]` = câu hỏi mở (→ từ v1.3: đã chuyển thành [DECIDED v1.3]).

---

## §0. MỤC ĐÍCH & PHẠM VI

`[TB-05 §0 ← template TB-00 §4]` `[EXT]`

- **Mục đích:** biến section G3 của nguồn (~599 dòng) thành blueprint vận hành cho engine HAN trên cả 2 nhiệm vụ — **M1** (Kaggle: Optimizer + Learner, 5 lĩnh vực tối ưu) và **M2** (System Research TMO: Architecture Proposer, 5 lĩnh vực hệ thống, mỗi vòng sinh 1 Proposal Item kèm Verification Plan deferred); đồng thời đặc tả **TEAM KNOWLEDGE BASE (KB)** — tài sản chung của team mà HAN kiêm **Curator** (consolidate/dedup/retire).
- **Đối tượng đọc:** (1) kỹ sư triển khai G3 engine + KB store vào TMO; (2) chính HAN — dùng JD + Instructions + KB Write/Curate protocol làm runtime briefing; (3) NEMESIS — verify Checkpoint CP3 (sau G3), tiêu thụ recommendations; (4) user — review từng phần (1 file = 1 review unit = 1 milestone).

- **Phạm vi (bao gồm):** JD + Instructions đầy đủ HAN · optimization priority Data/System Safety → Performance → Code Quality · vòng 3 phases ANALYZE → OPTIMIZE → EVOLVE · Self-Evolving Engine (APPLY → EXPERIMENT → MEASURE → LEARN → REPEAT) · 5 lĩnh vực tối ưu M1 + 5 lĩnh vực tối ưu M2 · cấu trúc đầy đủ TEAM KNOWLEDGE BASE (9 categories) · Curator duty (consolidate/dedup/retire) · KB Interface (READ/WRITE/schema) · state machine vòng G3 · error & edge cases · acceptance criteria.
- **Phạm vi (KHÔNG bao gồm):** G1 SIVIL/BELI + sub-agents → TB-03 · G2 LISMA review/fix loop → TB-04 · NEMESIS 7 nhiệm vụ + Research Council (4 thời điểm) → TB-06 · Knowledge Capture protocol toàn team (3 lỗ hổng thiết kế cũ, nội dung council, 5 quy tắc vàng) → TB-08 (TB-05 chỉ **tiêu thụ**: bảng quyền ghi KB, KB Write Protocol, KB Entry Schema) · Worklog schema chuẩn + Handoff flow → TB-09 · Artifact Map chi tiết → TB-10 (TB-05 chỉ tiêu thụ chiến lược đọc Metric Impact Chain / Impact Chain) · Proposal Schema 8 trường + vòng đời + SELF-DIRECTION → TB-11 (TB-05 sinh **proposal items** — hạt của Proposal) · mã nguồn TMO, hạ tầng PM2/Qdrant/Neo4j — dừng ở ranh giới "runtime contract".

| File liên quan | Quan hệ với TB-05 |
|---|---|
| TB-00 | Chuẩn toàn tập: ID (KB-YYYYMMDD-NNN), danh tính agent, model stack, traceability |
| TB-03 / TB-04 | Input của G3 = output G2 (LISMA verified code/report + suggestions + concerns); KB Candidates của BELI/LISMA nằm trong worklog G1/G2 |
| TB-06 | NEMESIS verify CP3 sau G3; DECIDE tiêu thụ recommendations; ESCALATE đích của G3 |
| TB-08 | Knowledge Capture protocol — quyền ghi KB, Research Council, 5 quy tắc vàng (TB-05 dùng bảng + protocol của nó) |
| TB-09 / TB-10 | Worklog schema G3 + G3 chiến lược đọc (Metric Impact Chain / Impact Chain) |
| TB-11 | Proposal items của HAN là input cho Proposal Schema tổng hợp bởi NEMESIS |
| TB-12 | E2E playbooks đối soát (G3 = group 3 — chỉ chạy ở pipeline T3/COMPLEX, bước 4; T1/T2 không qua G3 — nguồn 3203–3211, 3229) |

---

## §1. JOB DESCRIPTION & INSTRUCTIONS — HAN (G3)

`[TB-05 §1 ← nguồn dòng 1121–1172]` `[SRC]`

### 1.1 📋 Job Description — HAN (G3 Optimizer / Architecture Proposer)

**Sứ mệnh (Dual Mission):**

| Mode | Vai trò | Mục tiêu cuối |
|---|---|---|
| **M1 — Kaggle** | Optimizer + Learner | Đảm bảo code **TỐT NHẤT** — không chỉ đúng, mà tối ưu metric, tốc độ, đơn giản |
| **M2 — System Research TMO** | Architecture Proposer | Đề xuất nâng cấp kiến trúc (bộ nhớ, quy trình, tư duy) + tối ưu performance qua **PROPOSAL** |

**Trách nhiệm chính `[SRC dòng 1127–1132]`:**

| # | Trách nhiệm | Nội dung |
|---|---|---|
| 1 | **ANALYZE** | Đọc G2 output + Knowledge Base |
| 2 | **OPTIMIZE** | Theo priority: Data/System Safety → Performance → Code Quality |
| 3 | **EVOLVE** | Ghi lessons + anti-patterns vào Knowledge Base qua mỗi vòng |
| 4 | **CURATE** | Consolidate + dedup các KB entries do NEMESIS/SIVIL ghi (chu trình G3 gần nhất) |
| 5 | **(M2) PROPOSE** | Sinh PROPOSAL ITEM kèm Verification Plan |

**Deliverables `[SRC dòng 1134]`:**

```
- Optimized code (M1) / Proposal items (M2)
- Updated Knowledge Base (đã curate — gồm entries từ cả team)
- Recommendations cho TL (NEMESIS)
```

> ✗ M2 **KHÔNG** có deliverable "upgraded system" — HAN sinh proposal items (kèm Verification Plan deferred), NEMESIS tổng hợp thành Proposal, route SELF-DIRECTION. Áp lên Live System chỉ sau **APPROVED**.

### 1.2 📜 Instructions — HAN (đầy đủ, dùng làm runtime briefing)

`[TB-05 §1.2 ← nguồn dòng 1136–1143]` `[SRC]`

> **LUÔN:**
> - Load **Knowledge Base** trước khi optimize.
> - **Ghi lesson mới sau mỗi vòng** (EVOLVE).
> - Đọc theo **Metric Impact Chain** (M1) / **Impact Chain** (M2) — xem §1.4.
> - **Sinh Verification Plan (deferred)** cho mọi proposal M2.
> - **Curate KB entries do NEMESIS/SIVIL ghi** (dedup/merge/retire).

> **KHÔNG BAO GIỜ:**
> - **Tối ưu khi Data/System Safety chưa pass** — Priority #1 luôn được verify trước.
> - **Thay đổi approach mà không báo NEMESIS.**
> - **(M2) Apply thay đổi trực tiếp lên Live System** — POC/thử nghiệm chỉ chạy trong **Workspace**.

> **Input contract:** G2 output (verified code/report + suggestions + concerns) + Knowledge Base.
>
> **Output contract:** Optimized code/Proposal items + updated KB + recommendations → **NEMESIS**.
>
> **ESCALATE lên TL khi:** approach sai fundamental / overfitting không sửa được trong scope G3.
>
> **Signature move:** self-evolving — Knowledge Base tích lũy lessons + anti-patterns qua từng vòng.

### 1.3 Tại sao vị trí G3 được thiết kế như vậy + nguyên tắc cốt lõi

`[TB-05 §1.3 ← nguồn dòng 1145–1172]` `[SRC]`

| Thiết kế vai trò | Lợi ích cho pipeline |
|---|---|
| **Optimizer + Learner 2-trong-1** | Không chỉ tối ưu theo quy tắc — tự học từ feedback các vòng trước qua Knowledge Base, cải thiện strategy liên tục |
| **Phối hợp với G2 đúng lớp** | LISMA đảm bảo ĐÚNG (no bug, no leak) — HAN đảm bảo TỐT NHẤT (metric, tốc độ, đơn giản). Không chồng chéo trách nhiệm |
| **Priority-based optimization** | Data/System Safety > Performance > Code Quality — luôn verify sự an toàn trước khi tối ưu |

**Nguyên tắc cốt lõi: "Không chỉ sửa — mà làm TỐT HƠN"** — G2 (LISMA) đảm bảo code **đúng** (không bug, không leak, logic đúng); G3 (HAN) đảm bảo code **tốt nhất** (tối ưu hiệu năng, giảm phức tạp, tăng score):

```
┌─────────────────────────────────────────────────────────┐
│   G2 Output          →          G3 Output               │
│                                                          │
│   Code ĐÚNG                    Code TỐT NHẤT            │
│   - Không bug                  - Score cao nhất          │
│   - Không leak                 - Chạy nhanh nhất         │
│   - Logic đúng                 - Phức tạp tối thiểu      │
│                                - Tổng quát hóa tốt       │
│                                                          │
│   CV Score: 0.125              CV Score: 0.118           │
│   Runtime:  45 min             Runtime:  28 min          │
│   Features: 180                Features: 95 (top ones)   │
└─────────────────────────────────────────────────────────┘
```

### 1.4 Chiến lược đọc — Metric Impact Chain (M1) / Impact Chain (M2)

`[TB-05 §1.4 ← nguồn dòng 3986–4028, 4573, 4611]` `[SRC]`

| Khía cạnh | G2 (LISMA) — để so sánh | **G3 (HAN)** |
|---|---|---|
| **Đọc** | data flow, leakage paths, logic flow, edge cases (M2: stack traces, log warnings, error paths, fail-open, config mismatch) | feature importance, model behavior, CV strategy, pipeline efficiency, ensemble potential (M2: component → dependencies → user-facing effect) |
| **Tìm** | data leakage, logic bugs, incorrect CV, target leakage in features, overfitting signals (M2: root cause, integration issues, config bugs) | unnecessary features, suboptimal hyperparams, improvement opportunities, redundancy, feature interaction opportunities (M2: upgrade opportunities, pattern áp dụng được) |
| **Mục tiêu** | pipeline CHẠY ĐÚNG + AN TOÀN | pipeline CHẠY TỐT NHẤT (metric) |
| **Chiến lược đọc** | THEO LEAKAGE/BUG LOCATIONS (M1) / THEO SUSPECT LOCATIONS (M2) từ Artifact Map | **THEO METRIC IMPACT CHAIN (M1) / THEO IMPACT CHAIN (M2)** |
| **Token** | ~4–8K (selective reading) | **~6–10K** (wider reading, nhưng vẫn selective) |

**Chuỗi đọc M1 — Metric Impact Chain:** đọc `feature_importance.csv` → xác định top features → đọc model training logs → hiểu behavior → đọc CV strategy → verify trustworthiness → đọc artifact chain → tìm optimization opportunities.

**Chuỗi đọc M2 — Impact Chain:** đọc theo chuỗi **component → dependencies → user-facing effect** để tìm **điểm đòn bẩy** (system leverage) — ví dụ: key pool → LLM calls → user latency (§4.3).

**Runtime contract (model stack)** `[EXT theo TB-01 §2]`: HAN chạy model chính Kimi-k3; fallback DeepSeek v4 Pro → DeepSeek v4 Flash → MiniMax-M3; khi fallback, HAN GIỮ NGUYÊN vai trò + JD (role-based — same brain, different briefing), ghi dòng `model switched` vào worklog; cả 4 bậc lỗi → BLOCKED và báo NEMESIS.

---

## §2. OPTIMIZATION PRIORITY & VÒNG 3 PHASES

`[TB-05 §2 ← nguồn dòng 1149–1151, 1383–1395, 1546–1604, 1665–1714]` `[SRC]`

### 2.1 Bảng priority — thứ tự bắt buộc

`[TB-05 §2.1 ← nguồn dòng 1149–1151, 1565–1581]` `[SRC]`

| Priority | Lớp | M1 — Kaggle | M2 — System Research | Guard |
|---|---|---|---|---|
| **P1** | **Data/System Safety** | Double-check data leakage fixes; verify CV strategy | Verify system safety — không làm sập dịch vụ đang chạy | **CHỐN**: P1 chưa pass → KHÔNG tối ưu (Instructions KHÔNG BAO GIỜ) |
| **P2** | **Performance** | Hyperparameter tuning + Feature selection + Ensemble optimization | Proposal items: memory / execution / thinking / tools / UI-perf | Chạy sau khi P1 pass |
| **P3** | **Code/Architecture Quality** | Simplification, remove redundancy, improve readability | Simplification kiến trúc trong proposal | Chạy sau P2; không đánh đổi P1/P2 lấy P3 |

> Quy tắc vàng: **Data/System Safety → Performance → Code Quality** — luôn verify sự an toàn trước khi tối ưu. P3 KHÔNG BAO GIỜ làm hỏng kết quả P1/P2 (code "đẹp" nhưng chậm hơn/sai thì từ chối).

### 2.2 Phase 1 — ANALYZE

`[TB-05 §2.2 ← nguồn dòng 1554–1562]` `[SRC]`

```
Phase 1: ANALYZE
┌────────────────────────────────────────────────┐
│ • Đọc G2 code + worklog                        │
│ • Đọc G2 suggestions                           │
│ • Đọc G2 concerns (TL có xác nhận không?)      │
│ • Load Knowledge Base                          │
│ • Xác định lĩnh vực tối ưu có thể áp dụng      │
│   (M1: 5 lĩnh vực Kaggle / M2: 5 lĩnh vực      │
│    hệ thống)                                   │
└────────────────────────────────────────────────┘
```

Lưu ý runtime `[EXT]`: mục "G2 concerns (TL có xác nhận không?)" — nếu concern chưa được NEMESIS xác nhận, HAN không dùng nó làm căn cứ quyết định cốt lõi (chỉ liệt kê, flag trong report; xem §9 E9).

### 2.3 Phase 2 — OPTIMIZE (theo priority)

`[TB-05 §2.3 ← nguồn dòng 1565–1581]` `[SRC]`

```
Phase 2: OPTIMIZE (theo priority)
┌────────────────────────────────────────────────┐
│ Priority 1: Data/System Safety (verify G2 fixes)│
│   → Double-check data leakage fixes             │
│   → Verify CV strategy / System safety          │
│                                                  │
│ Priority 2: Performance                          │
│   → (M1) Hyperparameter tuning + Feature sel +  │
│      Ensemble optimization                      │
│   → (M2) Proposal items: memory/execution/     │
│      thinking/tools/UI-perf                     │
│                                                  │
│ Priority 3: Code/Architecture Quality           │
│   → Simplification                              │
│   → Remove redundancy                           │
│   → Improve readability                         │
└────────────────────────────────────────────────┘
```

### 2.4 Phase 3 — EVOLVE

`[TB-05 §2.4 ← nguồn dòng 1584–1604]` `[SRC]`

```
Phase 3: EVOLVE
┌────────────────────────────────────────────────┐
│ • So sánh kết quả trước/sau tối ưu             │
│ • Ghi lessons mới vào Knowledge Base           │
│ • Ghi anti-patterns (nếu có)                   │
│ • Update confidence scores                     │
│ • Tạo suggestions cho TL                       │
│ • (M2) Mỗi proposal item kèm Verification Plan │
└────────────────────────────────────────────────┘

Output:
- Optimized code (M1) / Proposal items (M2)
- Worklog: improvements + metrics + lessons
- Knowledge Base updates
- Recommendations cho TL

        │ G3 Output
        ▼
    TL (NEMESIS)
```

### 2.5 Quy tắc M2 — mỗi vòng output = 1 PROPOSAL ITEM + Verification Plan

`[TB-05 §2.5 ← nguồn dòng 1393–1395]` `[SRC]`

> **Quy tắc M2:** Mỗi vòng tối ưu output = **1 PROPOSAL ITEM** (không phải code submit). Vì hệ thống benchmark A/B chưa xây dựng, mỗi proposal item BẮT BUỘC kèm **Verification Plan (deferred)**:
> - **(a) Cách kiểm chứng bằng tay NGAY** (log check, manual test);
> - **(b) Benchmark spec khi hệ A/B được xây** (ghi rõ metric + method).

Mini-template Proposal Item `[EXT — hợp nhất từ quy tắc trên + ví dụ nguồn dòng 4477–4483; schema đầy đủ 8 trường là của TB-11]`:

```markdown
### PROPOSAL ITEM — <tên ngắn> (hạt của Proposal — NEMESIS tổng hợp, schema đầy đủ: TB-11)
- Lĩnh vực: <1 trong 5 lĩnh vực M2 — xem §4>
- Problem/Gap: <hiện trạng + evidence (file:line | log | metric)>
- Proposed change: <cấu trúc mới / policy / config / pipeline>
- Expected impact: <metric kỳ vọng (định lượng nếu được) + lợi ích định tính>
- Trade-offs: <risk + effort S/M/L>
- Verification Plan (deferred):
  (a) Kiểm chứng tay NGAY: <log check / manual test cụ thể — ai làm, câu hỏi nào được trả lời>
  (b) Benchmark spec (khi hệ A/B xây): <metric + method + ngưỡng so sánh>
- Rollback path: <cách revert nếu áp lên Live System sau APPROVED — đối chiếu TB-11>
- Evidence refs: <file:line | log excerpt | KB entry ID>
```

Guard `[EXT]`: proposal item thiếu **(a)** → KHÔNG submit — trả lại vòng OPTIMIZING tự hoàn thiện (xem §9 E4). Thiếu **(b)** → chấp nhận được tạm thời CHỈ khi metric chưa đo được (đối chiếu §9 E3), phải ghi rõ "benchmark pending".

### 2.6 5 Lĩnh vực tối ưu M1 (Mode Kaggle) — tổng quan

`[TB-05 §2.6 ← nguồn dòng 1174–1382]` `[SRC]`

| # | Lĩnh vực | Input G2 điển hình | Hành động G3 | Cơ chế self-evolving (nguyên văn rút) | Kết quả điển hình |
|---|---|---|---|---|---|
| 1 | **Hyperparameter Tuning** | model + CV score | Vòng 1 search space rộng → Vòng 2 zoom vùng tốt → Vòng 3 fine-tune quanh best | "Mỗi vòng, HAN thu hẹp search space dựa trên kết quả vòng trước. Không random search mù quáng — **adaptively refine**" | CV 0.121 → 0.119 → 0.118 (converged) |
| 2 | **Feature Selection** | 180 features | Đánh giá importance → loại features nhiễu → RFE | "HAN học được 'thêm features không phải luôn tốt' từ kết quả RFE, và áp dụng kinh nghiệm này cho các task tối ưu tiếp theo" | 180 → 60 features; CV 0.125 → 0.119; runtime 45 → 22 min |
| 3 | **Ensemble Optimization** | 3 models riêng lẻ | Test ensemble strategies → phân tích trade-off score/std → self-evolving decision | "Ghi kinh nghiệm: 'High std trong stacking = overfit signal'" | 3 models riêng → Stacking (Ridge meta); CV 0.122 → 0.117 |
| 4 | **Cross-Validation Strategy** | KFold(5) | Tạo stratification bins → so sánh CV strategies → chốt | "Lưu insight: 'Dataset nhỏ → Stratified theo target bins'" | StratifiedKFold(5): std 0.005 → 0.003 (đánh giá thực tế hơn, ổn định hơn) |
| 5 | **Code Simplification** | Code sạch nhưng phức tạp | Phân tích redundancy → gộp bước, bỏ encoding trùng, bỏ features tương quan > 0.95 | Pipeline ngắn → dễ maintain, dễ debug; mỗi bước 1 trách nhiệm (Single Responsibility) | 150 → 80 dòng; pipeline 5 → 3 bước |

Ví dụ minh họa lĩnh vực 1 — 3 vòng thu hẹp search space `[SRC dòng 1192–1218, rút gọn]`:

```
Vòng 1: Thử search space rộng
  learning_rate: [0.01 ... 0.1], max_depth: [3...8], n_estimators: [500...3000], ...
  → Best: lr=0.03, depth=4, n=2000, sub=0.7, col=0.7  → CV Score: 0.121

Vòng 2: Zoom vào vùng tốt (self-evolving — thu hẹp search space)
  learning_rate: [0.02, 0.025, 0.03, 0.035, 0.04], max_depth: [3, 4, 5], ...
  → Best: lr=0.025, depth=4, n=2500, sub=0.7, col=0.65  → CV Score: 0.119

Vòng 3: Fine-tune quanh best (self-evolving — tinh chỉnh)
  → CV Score: 0.118 ← Converged
```

### 2.7 Ví dụ M1 đầy đủ — G3 tối ưu House Prices pipeline

`[TB-05 §2.7 ← nguồn dòng 1606–1663]` `[SRC]`

```
G2 Output:
  - 3 models: XGBoost (0.122), LightGBM (0.123), CatBoost (0.125)
  - 180 features
  - 5-Fold CV
  - Runtime: 45 min
  - G2 suggestion: "Nên thử thêm stacking"

HAN G3 — Phase 1: ANALYZE
  → 180 features nhiều khả năng có noise
  → 5-Fold có thể không stable cho 1460 rows
  → 3 models tốt, có thể ensemble
  → CatBoost yếu nhất → loại hoặc giảm weight

HAN G3 — Phase 2: OPTIMIZE
  Bước 1: Feature Selection    → RFE: top-60; CV 0.122 → 0.120 (better!)
  Bước 2: Hyperparameter Tuning→ depth 6→4, lr 0.05→0.025, n 1000→2500
                                → CV: XGB 0.118, LGBM 0.119, CatBoost 0.122
  Bước 3: CV Strategy          → KFold → StratifiedKFold; std 0.005 → 0.003
  Bước 4: Ensemble             → Stacking (Ridge meta); CV: 0.115 ← Best!
  Bước 5: Simplification       → Pipeline 5 → 3 bước; code 350 → 200 dòng

HAN G3 — Phase 3: EVOLVE
  Lessons mới:
  - "House Prices: top-60 features tốt hơn top-180"
  - "XGBoost depth=4, lr=0.025, n=2500 là sweet spot"
  - "StratifiedKFold stable hơn KFold cho dataset nhỏ"
  - "Stacking Ridge meta: 0.115 (best)"
  Anti-patterns mới:
  - "CatBoost depth=6 overfit trên dataset nhỏ"

Kết quả cuối cùng:
  CV Score: 0.125 → 0.115 (giảm 8%)   Runtime: 45 → 28 min (giảm 38%)
  Features: 180 → 60 (giảm 67%)       Code: 350 → 200 dòng (giảm 43%)
```

### 2.8 Schema tổng hợp — G3 Internal Workflow (runtime contract)

`[TB-05 §2.8 ← nguồn dòng 1665–1699]` `[SRC]`

> Nguồn lặp nội dung vòng 3 phases 2 lần (bản chi tiết dòng 1546–1604 = §2.2–2.4; bản schema dòng 1665–1699). TB-05 giữ bản schema làm **hình runtime contract** — nội dung trùng §2.2–2.4:

```
G2 Output (code sạch + suggestions + concerns)
        │
        ▼
┌─── HAN (Optimizer) ──────────────────────────────────┐
│  Phase 1: ANALYZE                                     │
│  ├── Đọc code + worklog + suggestions từ G2           │
│  ├── Load Knowledge Base                              │
│  └── Xác định tối ưu areas (M1: 5 lĩnh vực /          │
│      M2: 5 lĩnh vực)                                  │
│                                                       │
│  Phase 2: OPTIMIZE (priority-based)                   │
│  ├── P1: Data/System Safety (verify leakage/safety fixes)│
│  ├── P2: Performance (M1: tuning+FE+ensemble /        │
│  │       M2: proposals)                               │
│  └── P3: Code/Architecture Quality                    │
│                                                       │
│  Phase 3: EVOLVE (self-evolving)                      │
│  ├── So sánh trước/sau                                │
│  ├── Ghi lessons mới vào Knowledge Base               │
│  ├── Ghi anti-patterns                                │
│  ├── (M2) Mỗi proposal kèm Verification Plan (deferred)│
│  └── Tạo recommendations cho TL                       │
│                                                       │
│  Output:                                              │
│  ├── Optimized code (M1) / Proposal items (M2)        │
│  ├── Updated Knowledge Base                           │
│  └── Worklog + Recommendations cho TL                 │
└──────────────┬────────────────────────────────────────┘
               │ G3 Output
               ▼
          TL (NEMESIS)
```

### 2.9 Bảng tóm tắt cơ chế G3

`[TB-05 §2.9 ← nguồn dòng 1701–1714]` `[SRC]`

| Khía cạnh | Cơ chế |
|---|---|
| **Vai trò chính** | Optimizer + Learner (M1) / Architecture Proposer (M2) — không chỉ tối ưu mà còn học |
| **5 Lĩnh vực M1** | Tuning, Feature Selection, Ensemble, CV Strategy, Simplification |
| **5 Lĩnh vực M2** | Memory Architecture, Execution Pipeline, Thinking Process, Tools/Agents Roster, UI/UX+Performance |
| **Self-evolving** | Knowledge Base tích lũy lessons + anti-patterns (Kaggle + System) qua từng vòng |
| **Priority** | Data/System Safety > Performance > Code Quality |
| **Evolution Cycle** | Apply → Experiment → Measure → Learn → Repeat |
| **Knowledge Base** | Kaggle Lessons + System Patterns + Config Lessons + Performance Baselines + Anti-Patterns |
| **Output M1** | Optimized code + Updated KB + Recommendations cho TL |
| **Output M2** | Proposal items (kèm Verification Plan deferred) + Updated KB |
| **Metric cải thiện điển hình (M1)** | CV score -5~10%, runtime -30~40%, features -50~70% |

---

## §3. SELF-EVOLVING ENGINE — TRÁI TIM CỦA G3

`[TB-05 §3 ← nguồn dòng 1399–1472]` `[SRC]`

Đây là phần quan trọng nhất — HAN không chỉ tối ưu theo quy tắc, mà **tự cải thiện strategy** qua từng vòng:

### 3.1 Diagram Evolution Cycle

`[TB-05 §3.1 ← nguồn dòng 1404–1436]` `[SRC]` (giữ nguyên)

```
┌──────────────────────────────────────────────────────────┐
│           HAN — SELF-EVOLVING ENGINE                       │
│                                                            │
│  ┌────────────────────────────────────────────────┐       │
│  │            KNOWLEDGE BASE                       │       │
│  │                                                 │       │
│  │  Lesson #1: "Dataset nhỏ → Stratified CV"       │       │
│  │  Lesson #2: "High std trong stacking = overfit" │       │
│  │  Lesson #3: "More features ≠ better"            │       │
│  │  Lesson #4: "Target encoding cần K-Fold"        │       │
│  │  Lesson #5: "XGBoost depth=4 thường tốt hơn 6"  │       │
│  │  [M2] "LLM key 401 → retry mù = latency 121s"  │       │
│  │  [M2] "NEO4J_DATABASE phải đúng instance ID"    │       │
│  │  ...                                           │       │
│  │  (Càng nhiều vòng, knowledge base càng phong phú)│      │
│  └────────────────────────────────────────────────┘       │
│                         ▲                                  │
│                         │ Ghi lesson mới                   │
│                         │                                  │
│  ┌────────────────────────────────────────────────┐       │
│  │         EVOLUTION CYCLE                         │       │
│  │                                                 │       │
│  │  1. APPLY: Dùng lessons hiện tại để tối ưu      │       │
│  │  2. EXPERIMENT: Thử approach mới (explore)      │       │
│  │  3. MEASURE: So sánh kết quả trước/sau          │       │
│  │  4. LEARN:                                     │       │
│  │     ├── Cải thiện → Ghi lesson mới              │       │
│  │     └── Xấu đi → Ghi anti-pattern              │       │
│  │  5. REPEAT                                     │       │
│  └────────────────────────────────────────────────┘       │
└──────────────────────────────────────────────────────────┘
```

**Ghi chú `[SRC dòng 1438]`:** theo protocol Knowledge Capture, nguồn ghi KB không chỉ HAN — NEMESIS và SIVIL ghi trực tiếp khi phát hiện trong quá trình vận hành; HAN giữ vai trò **Curator** (consolidate/dedup). Xem §6 và TB-08.

### 3.2 Ví dụ self-evolving qua 3 vòng thực tế

`[TB-05 §3.2 ← nguồn dòng 1440–1472]` `[SRC]` (giữ nguyên)

```
Vòng 1 — Part 1 (EDA):
  HAN tối ưu EDA
  → Học lesson: "Missing value pattern gợi ý MNAR"
  → Áp dụng: "Không dùng simple imputation cho MNAR features"
  → Ghi vào Knowledge Base

Vòng 2 — Part 2 (Feature Engineering):
  HAN áp dụng lesson từ Vòng 1:
  → "MNAR features → Dùng flag features (is_missing) thay vì impute"
  Thử nghiệm mới:
  → is_missing features cho +0.003 CV improvement
  → Học lesson mới: "Missing indicator features hữu ích khi MNAR"
  → Ghi vào Knowledge Base

Vòng 3 — Part 3 (Model Building):
  HAN áp dụng ALL lessons từ Vòng 1 + 2:
  → "MNAR → is_missing features" (từ Vòng 2)
  → "Stratified CV cho dataset nhỏ" (từ kinh nghiệm chung)
  → "XGBoost depth=4 tốt hơn 6" (từ tuning Vòng 3)
  Kết quả: Tối ưu nhanh hơn vì đã có kinh nghiệm
  Không cần search toàn bộ space — zoom thẳng vào vùng tốt dựa trên lessons
```

### 3.3 [EXT] Bảng điều kiện — khi nào ghi lesson mới vs anti-pattern

`[TB-05 §3.3 ← mở rộng từ cơ chế LEARN, nguồn dòng 1429–1431]` `[EXT]`

| Kết quả MEASURE (so với trước tối ưu) | Diễn giải | Hành động ghi KB | Loại entry |
|---|---|---|---|
| **Cải thiện đáng kể** (vượt ngưỡng noise — **✅ chốt v1.3: M1 > 1 std của CV; M2 > 5% hoặc bootstrap 95% CI** — §11 Q2) | Approach hiệu quả | Ghi lesson mới; nếu trùng lesson cũ → không ghi entry mới, chỉ tăng confidence | Lesson / Pattern (S1–S4) |
| **Cải thiện nằm trong noise** (nhỏ hơn std) | Không kết luận được | KHÔNG ghi — tránh ô nhiễm KB bằng lesson yếu | — |
| **Xấu đi rõ rệt** | Approach có hại | Ghi anti-pattern + lý do thất bại | Anti-Pattern (A1–A5 / AS1–AS3) |
| **Xấu đi do vi phạm anti-pattern đã có** | Xác nhận anti-pattern | Tăng confidence anti-pattern cũ (không ghi entry mới) | Cập nhật confidence |
| **Cải thiện khi áp đúng lesson cũ** | Xác nhận lesson | Tăng confidence lesson cũ | Cập nhật confidence |
| **Kết quả mâu thuẫn lesson cũ** (lesson không tái hiện ở context tương tự) | Lesson yếu evidence hoặc điều kiện áp sai | Đánh dấu re-evaluate → retire nếu bị vượt refute (qua §6 Curator) | RETIRED |
| **M2 — không đo được metric** (chưa có benchmark A/B) | Định tính | Ghi lesson MEDIUM/LOW confidence + Verification Plan deferred cho proposal item tương ứng | Lesson + proposal (b) benchmark |

> Nguyên tắc tổng: mỗi entry phải có **evidence** (metric trước/sau, file:line, log excerpt) — "insight không có evidence/context = không ghi" (quy tắc vàng KB, nguồn dòng 1821).

### 3.4 [EXT] Vai trò Curator tích hợp vào Evolution Cycle

`[TB-05 §3.4 ← mở rộng từ nguồn dòng 1131, 1438, 1787–1788]` `[EXT]`

Cycle của nguồn (APPLY → EXPERIMENT → MEASURE → LEARN → REPEAT) + Bước 4 CURATE của KB Write Protocol (nguồn dòng 1787–1788: "HAN consolidate trong chu trình G3 gần nhất") ghép thành chu trình đầy đủ của G3:

```
  1. APPLY      ── dùng lessons hiện tại (đã curate) để tối ưu
  2. EXPERIMENT ── thử approach mới (explore)
  3. MEASURE    ── so sánh kết quả trước/sau
  4. LEARN      ── cải thiện → lesson mới / xấu đi → anti-pattern
  5. CURATE     ── [EXT tích hợp] HAN consolidate/dedup/retire TOÀN KB:
                   entries NEW do NEMESIS/SIVIL/HAN ghi từ chu trình trước
                   + entries NEW của chính vòng này → status CURATED
  6. REPEAT     ── vòng sau: APPLY trên KB sạch hơn, mạnh hơn
```

Lợi ích thiết kế: (1) KB mà APPLY tiêu thụ ở vòng kế luôn ở trạng thái đã curate — giảm trùng lặp, tăng chất lượng evidence; (2) entries do NEMESIS/SIVIL ghi giữa 2 chu trình G3 (theo protocol Knowledge Capture) không bao giờ tồn đọng quá 1 chu trình G3 ở status NEW; (3) Curator duty (§6) có thời điểm chạy cố định — state CURATING của state machine §8.

---

## §4. MODE M2 — 5 LĨNH VỰC TỐI ƯU HỆ THỐNG (ARCHITECTURE PROPOSER)

`[TB-05 §4 ← nguồn dòng 1383–1397, 4477–4483]` `[SRC]`

### 4.1 Bảng 5 lĩnh vực (giữ nguyên nguồn)

`[TB-05 §4.1 ← nguồn dòng 1385–1391]` `[SRC]`

| # | Lĩnh vực | Phạm vi nghiên cứu | Output |
|---|---|---|---|
| 1 | **Memory Architecture** | Short/long-term memory, vector (Qdrant) + graph (Neo4j) + SQLite coordination | Proposal nâng cấp bộ nhớ |
| 2 | **Execution Pipeline** | 3-Tier system, Read-Write-Verify, handoff flow giữa agents | Proposal nâng cấp quy trình thực thi |
| 3 | **Thinking Process** | Reasoning strategy, research protocol, hypothesis-driven loop | Proposal nâng cấp quy trình tư duy |
| 4 | **Tools & Agents Roster** | MCP tools, phân bổ agent, model-to-role mapping | Proposal tối ưu roster + tools |
| 5 | **UI/UX & Performance** | Giao diện, latency, token cost | Proposal UI/UX + performance |

### 4.2 [EXT] Mở rộng mỗi lĩnh vực — loại proposal item đặc trưng + metric cần baseline

`[TB-05 §4.2 ← mở rộng từ bảng nguồn]` `[EXT]`

| # | Lĩnh vực | Loại proposal item đặc trưng | Metric cần baseline (nguồn: Performance Baselines §5.1 + [EXT] đề xuất) |
|---|---|---|---|
| 1 | Memory Architecture | Schema memory mới · indexing/retrieval ranking · memory pruning & consolidation policy · hybrid recall (vector + graph) · caching kết quả recall | Neo4j nodes (baseline 39,615) · số vector/collection · retrieval latency · hit-rate của memory recall · token dùng mỗi lần recall |
| 2 | Execution Pipeline | Thêm/bỏ tier gate · thay đổi handoff contract giữa khối · retry/timeout policy toàn pipeline · song song hóa sub-agents · thay đổi checkpoint schedule | Task cycle time · số vòng Read-Write-Verify mỗi task · escalate rate · token/task |
| 3 | Thinking Process | Prompt/JD/Instructions template mới · research protocol (5 lớp TB-07) · hypothesis gate chặt hơn · self-evolving policy | Hypothesis pass rate · số vòng experiment/hypothesis · coverage findings/module · (chủ yếu định tính — xem §9 E3) |
| 4 | Tools & Agents Roster | Thay đổi model-to-role mapping · thêm/giữ MCP tools · roster size (5–300 sub-agents) · batch size · fallback policy | Tool call success rate · model fallback frequency (dòng `model switched` trong worklog) · cost/token mỗi mission |
| 5 | UI/UX & Performance | Streaming response · response cache · lazy load UI · token cost budget | **Chat latency (baseline 121s → sau tối ưu 6.2s)** · TTFB · token cost/user · render time |

> Mỗi metric ở cột "cần baseline" phải có số liệu gốc trong category **Performance Baselines** (§5.1) trước khi sinh proposal item so sánh trước/sau — không có baseline → dùng Verification Plan (a) manual test + (b) benchmark spec deferred.

### 4.3 Ví dụ M2 — HAN đọc theo Impact Chain (giữ nguyên nguồn)

`[TB-05 §4.3 ← nguồn dòng 4477–4483]` `[SRC]`

```
G3 (HAN) — Architecture Proposer:
  Đọc theo Impact Chain (key pool → LLM calls → user latency):
  → Option A: Fail-fast + timeout — effort S, tác động lớn
  → Option B: Key health check + circuit breaker — effort M
  → Option C: Response cache — effort L, cần benchmark
  → Recommendation: A + B ngay; C để khi có benchmark
  → Mỗi option kèm Verification Plan (deferred)
```

Nhận xét `[EXT]`: Recommendation của HAN **xếp hạng options theo effort × tác động** — Option C "cần benchmark" bị hoãn đúng theo quy tắc 2.5 (b): benchmark chưa có → Verification Plan deferred. NEMESIS verify CP3: "Mỗi option có trade-offs + verification plan?" (nguồn dòng 4488).

### 4.4 Knowledge Base M2 — categories bổ sung

`[TB-05 §4.4 ← nguồn dòng 1397]` `[SRC]`

> KB M2 thêm categories: **System Patterns** (cái gì hoạt động tốt), **System Anti-Patterns** (KHÔNG LÀM), **Config Lessons**, **Performance Baselines** — HAN tích lũy hiểu biết về chính hệ TMO qua từng mission. Theo protocol Knowledge Capture, NEMESIS và SIVIL cũng ghi trực tiếp khi phát hiện tri thức mới (xem section KNOWLEDGE CAPTURE → TB-08; cấu trúc đầy đủ ở §5).

---

## §5. TEAM KNOWLEDGE BASE — CẤU TRÚC ĐẦY ĐỦ

`[TB-05 §5 ← nguồn dòng 1474–1544, 1813–1815]` `[SRC]`

> **KB là tài sản CHUNG của team** — không phải riêng HAN (HAN chỉ là Curator). Cấu trúc lưu trữ dưới đây giữ **đầy đủ** các bảng nguồn; các bảng này đồng thời là **starter KB (seed)** cho cold-start (§9 E1).

### 5.1 Cấu trúc lưu trữ + starter KB (giữ nguyên các bảng nguồn)

`[TB-05 §5.1 ← nguồn dòng 1478–1544]` `[SRC]`

```markdown
## TEAM KNOWLEDGE BASE

### Category: Data Preprocessing
| # | Lesson | Context | Confidence |
|---|--------|---------|------------|
| 1 | MNAR features → dùng flag + KNN impute | Missing > 40% | HIGH |
| 2 | Target encoding cần K-Fold | Cat features high cardinality | HIGH |
| 3 | Log transform cho right-skewed | Skew > 0.75 | MEDIUM |
| 4 | Standard scaler cho Neural Nets | NN models only | HIGH |
| 5 | RobustScaler cho outlier-heavy | Outlier ratio > 5% | MEDIUM |

### Category: Model Training
| # | Lesson | Context | Confidence |
|---|--------|---------|------------|
| 6 | XGBoost: depth 3-5 tốt hơn 6+ | Tabular data | HIGH |
| 7 | LightGBM: num_leaves 31-63 | Default settings | MEDIUM |
| 8 | Early stopping patience 50-100 | Prevent underfit | HIGH |
| 9 | Learning rate 0.01-0.05 cho boosting | Most datasets | HIGH |
| 10 | CatBoost: cat_features phải chỉ định rõ | Mixed data | HIGH |

### Category: Ensemble
| # | Lesson | Context | Confidence |
|---|--------|---------|------------|
| 11 | 3-5 models ensemble tốt nhất | Quá nhiều → overfit | HIGH |
| 12 | Diversity quan trọng hơn individual score | Correlation < 0.9 | HIGH |
| 13 | Stacking Ridge meta safe nhất | Small-medium datasets | HIGH |
| 14 | Weighted avg tốt khi models ít | 2-3 models | MEDIUM |

### Category: Anti-Patterns (KHÔNG LÀM)
| # | Anti-Pattern | Lý do |
|---|-------------|-------|
| A1 | Không dùng toàn bộ features | Noise + overfitting |
| A2 | Không stacking quá 2 levels | Leakage risk + overfitting |
| A3 | Không target encode trước split | Data leakage |
| A4 | Không ignore CV std | Std cao = overfit signal |
| A5 | Không dùng PCA blind | Có thể mất important features |

### Category: System Patterns (M2 — chỉ dùng cho mission System Research)
| # | Pattern | Áp dụng cho | Confidence |
|---|---------|-------------|------------|
| S1 | LLM key fail-fast + timeout | Mọi service dùng external API | HIGH |
| S2 | Key health check định kỳ | Service pool nhiều keys | HIGH |
| S3 | Config validate trước khi ghi | Mọi dịch vụ có config file | HIGH |
| S4 | Fail-open có fallback rõ ràng | Service có dependency ngoài | MEDIUM |

### Category: System Anti-Patterns (M2 — KHÔNG LÀM)
| # | Anti-Pattern | Lý do |
|---|-------------|-------|
| AS1 | Retry mù quáng khi API lỗi 4xx | 4xx = config/sai key, không retry được |
| AS2 | Đặt tên DB trùng tên instance ID | Dễ nhầm, khó debug |
| AS3 | Disable service mà không có fallback | Sập feature phụ thuộc |

### Category: Config Lessons (M2)
| # | Lesson | Context |
|---|--------|---------|
| C1 | NEO4J Aura: user = instance ID (8-hex) | Neo4j AuraDB |
| C2 | NVIDIA embedding: dùng integrate.api.nvidia.com | Cũ ai.api.nvidia.com EOL |
| C3 | Prisma CLI cần DATABASE_URL tuyệt đối | Khi môi trường chạy có env override |

### Category: Performance Baselines (M2)
| Metric | Baseline | Sau tối ưu |
|--------|----------|------------|
| Chat latency (no config) | 121s | 6.2s |
| Neo4j nodes | 39,615 | (tham chiếu) |
| R2 PDFs | 52 | (chưa ingest) |

### Category: Research Insights (mới — Knowledge Capture)
| # | Insight | Nguồn phát hiện | Confidence |
|---|---------|------------------|------------|
| R1 | Decompose audit hệ thống theo 4 branch (hiện trạng → điểm yếu → pattern → feasibility) cho coverage đủ | Discussion ② Research Council — task audit memory | HIGH |
```

`[TB-05 §5 (phần Research Insights) ← nguồn dòng 1813–1815, 1811]` — category mới **Research Insights**: tri thức **phương pháp nghiên cứu** (cách decompose hiệu quả, exploration strategy, discussion outcomes, cách verify claim) — lưu chính những gì Research Council đúc kết, tách biệt với tri thức nội dung (Kaggle/System). Entry R1 lấy từ ví dụ nguồn dòng 1811 (KB-20250612-003).

### 5.2 [EXT] Bảng tổng quan 9 categories — ai dùng, mission nào

`[TB-05 §5.2 ← tổng hợp từ nguồn dòng 1478–1544, 1813–1815]` `[EXT]`

| Category | Mission | Người ghi chính | Dùng lúc nào |
|---|---|---|---|
| Data Preprocessing (5) | M1 | HAN (EVOLVE) / NEMESIS, SIVIL (capture) | Phase 1 ANALYZE + Phase 2 (P2) |
| Model Training (5) | M1 | HAN / NEMESIS, SIVIL | Phase 1 + P2 tuning |
| Ensemble (4) | M1 | HAN / NEMESIS, SIVIL | Phase 1 + P2 ensemble |
| Anti-Patterns A1–A5 (5) | M1 | HAN (LEARN — xấu đi) | Phase 1 (tránh) + P1 verify |
| System Patterns S1–S4 (4) | M2 | HAN / NEMESIS, SIVIL | Phase 1 M2 + sinh proposal items |
| System Anti-Patterns AS1–AS3 (3) | M2 | HAN / NEMESIS, SIVIL | Phase 1 M2 (tránh) + P1 system safety |
| Config Lessons C1–C3 (3) | M2 | HAN / NEMESIS, SIVIL / LISMA (đề xuất) | Phase 1 M2 + evidence cho proposal |
| Performance Baselines (3) | M2 | HAN / NEMESIS | Baseline trước/sau khi sinh metric proposal (§4.2) |
| Research Insights (mở) | M1+M2 | SIVIL / NEMESIS (council) / HAN | Phase 1 — strategy nghiên cứu, decompose |

> Quy ước đọc theo mission: category M2 "chỉ dùng cho mission System Research" (nguồn dòng 1516) — guard chống áp nhầm lesson M1 vào M2 (chi tiết §9 E8).

---

## §6. CURATOR DUTY — CHI TIẾT

`[TB-05 §6 ← mở rộng từ nguồn dòng 1131, 1138, 1438, 1742, 1787–1788]` `[EXT]`

### 6.1 Vai trò & phạm vi

- **Curator = HAN** (kiêm, không độc quyền): consolidate + dedup + retire KB entries **do NEMESIS/SIVIL ghi trong chu trình G3 gần nhất** + entries do chính HAN ghi (EVOLVE) + entries từ "KB Candidates" của BELI/LISMA đã được NEMESIS/SIVIL/HAN chấp nhận ghi.
- HAN **không xóa entry** — chỉ đánh dấu RETIRED (giữ toàn bộ audit trail; ID không bao giờ tái sử dụng).
- Curator KHÔNG phải "người biên tập nội dung": khi merge, insight giữ nguyên ý gốc (chọn bản ngắn + actionable nhất), chỉ dồn evidence — không viết lại kết luận.

### 6.2 Quy trình CONSOLIDATE (4 bước)

`[TB-05 §6.2 ← mở rộng từ "dedup (trùng → merge) / retire (lỗi thời → đánh dấu RETIRED)", nguồn dòng 1787–1788]` `[EXT]`

```
B1 — SCAN     Quét mọi entries status NEW từ chu trình trước (mọi writer).
              Với mỗi entry: tạo khóa tìm kiếm = (Category, Mission,
              keywords chính của Insight). Gom nhóm trùng tiềm năng.

B2 — COMPARE  Trong mỗi nhóm: so 3 trục:
              (i)   Insight — cùng kết luận không? (trùng hoàn toàn / bổ
                    trợ / mâu thuẫn)
              (ii)  Evidence — mạnh hay yếu (file:line + log/metric
                    > chỉ mô tả; nhiều nguồn > 1 nguồn)
              (iii) Source + thời điểm phát hiện

B3 — MERGE    Nhóm trùng/bổ trợ → giữ 1 entry gốc (Insight mạnh nhất,
              ID nhỏ nhất), dồn Evidence của các bản còn lại vào, cập
              nhật Source (liệt kê đầy đủ nguồn góp), Confidence = max
              các bản + ghi chú "consolidated từ N bản".
              Các bản bị gộp → status RETIRED, lý do DUPLICATE, ghi
              "superseded by <ID entry gốc>" vào Evidence.

B4 — TAG      Entry đã qua B3 + entry NEW đúng chuẩn → status CURATED.
              Ghi curator note vào worklog G3: mục lục thay đổi
              (merged/retired/curated) — NEMESIS review ở CP3 (§6.5).
```

### 6.3 RETIRE — điều kiện đánh dấu RETIRED

`[TB-05 §6.3 ← mở rộng từ nguồn dòng 1788]` `[EXT]`

| Mã lý do | Điều kiện | Ví dụ |
|---|---|---|
| **DUPLICATE** | Trùng lặp — đã bị gộp vào entry khác (kết quả B3) | 2 entries cùng "target encoding cần K-Fold" |
| **OUTDATED** | Lesson lỗi thời — công nghệ/config đã đổi | NVIDIA embedding endpoint cũ EOL khi có endpoint mới hơn |
| **REFUTED** | Bị vượt refute — evidence mới mâu thuẫn trực tiếp và mạnh hơn | Lesson "KFold đủ tốt cho dataset nhỏ" bị StratifiedKFold + std thấp hơn bác |
| **SUPERSEDED** | Có entry mới hơn cùng chủ đề, evidence mạnh hơn hẳn | Baseline 121s được thay bằng baseline mới sau khi tối ưu |

> Quy tắc: RETIRED entry **vẫn nằm lại trong KB** (không xóa dòng) — các vòng sau bỏ qua khi APPLY nhưng vẫn đọc được khi đối chiếu. Người retire = HAN (Curator), giữ nguyên quyền này với entries của MỌI writer (kể cả NEMESIS/SIVIL) — xem giới hạn ở §6.4.

### 6.4 Tần suất & quyền hạn

`[TB-05 §6.4 ← nguồn dòng 1131, 1787–1788]` `[SRC + EXT]`

| Khía cạnh | Quy tắc |
|---|---|
| **Tần suất** | Mỗi chu trình G3 (state CURATING của state machine §8; Bước 4 của KB Write Protocol: "HAN consolidate trong chu trình G3 gần nhất") |
| **Không xóa** | HAN KHÔNG xóa entry — chỉ đánh dấu RETIRED (4 lý do §6.3) |
| **Retire entry của NEMESIS/SIVIL** | Được phép, nhưng BẮT BUỘC kèm lý do + evidence; mọi thao tác retire được liệt kê trong report G3 để NEMESIS review ở Checkpoint CP3 *(✅ chốt v1.3 — §11 Q4: nâng lên PRE-APPROVAL — NEMESIS duyệt tại CP3 TRƯỚC khi retire có hiệu lực; NEMESIS tự retire được kèm Decision Log)* |
| **Không curate phán đoán** | Entries mâu thuẫn không phân định được bằng evidence → KHÔNG tự retire cả hai — flag CONFLICT vào report cho NEMESIS (§9 E2) |
| **Giữ nguyên schema** | Mọi thao tác curate tôn trọng KB Entry Schema §7.4 — không thêm/xóa trường ngoài chuẩn |

### 6.5 Output của Curator (đưa vào report G3)

`[TB-05 §6.5 ← mở rộng]` `[EXT]`

```markdown
## KB CURATION REPORT (chu trình G3 <task-id>, ngày <date>)
- Entries NEW đầu chu trình: <n> (NEMESIS: <a> · SIVIL: <b> · HAN: <c> · từ KB Candidates: <d>)
- Merged: <n> nhóm → liệt kê: <ID giữ> ← [<ID gộp>, ...] (lý do DUPLICATE)
- Retired: <n> → liệt kê: <ID> (lý do OUTDATED/REFUTED/SUPERSEDED + evidence)
- Curated: <n> entries đạt status CURATED
- Conflict flags: <n> → liệt kê cặp ID mâu thuẫn, chờ NEMESIS quyết
- Tổng KB sau chu trình: <m> active / <k> retired
```

---

## §7. KB INTERFACE — QUY ƯỚC LƯU TRỮ, READ & WRITE

`[TB-05 §7 ← mở rộng từ nguồn dòng 1478–1544, 1736–1811]` `[EXT]`

### 7.1 Quy ước lưu trữ file

`[TB-05 §7.1 ← mở rộng từ cấu trúc markdown nguồn dòng 1478–1544]` `[EXT]`

- **Định dạng:** file Markdown (đúng như cấu trúc nguồn: 1 heading `### Category: <tên>` + 1 bảng mỗi category) — dễ diff, dễ đọc bởi cả agent lẫn người.
- **Đề xuất bố cục — 1 file chính `team-knowledge-base.md`** gồm: phần đầu = **Mục lục** (bảng: Category | Mission | Số entry active | Ghi chú); phần thân = 9 categories theo §5; phần cuối = **Archive RETIRED** (giữ nguyên entries đã retire để audit). Phương án thay thế: tách 1 file/category + 1 file index — đánh đổi độ đơn giản khi load `[Q3 → DECIDED v1.3: chọn multi-file + index theo category; canonical là DB — DR-C6, không còn giới hạn 500 entries]`.
- **Ánh xạ cột bảng category ↔ KB Entry Schema** (hợp nhất 2 dạng nguồn — bảng category cột rút gọn, schema 7 trường đầy đủ):

| Cột bảng category (nguồn) | Trường KB Entry Schema (nguồn) | Ghi chú [EXT] |
|---|---|---|
| `#` (1–14, A1–A5, S1–S4, AS1–AS3, C1–C3) | `ID: KB-YYYYMMDD-NNN` | Khi triển khai: ID đầy đủ thay cho `#`; các mã `A/S/AS/C` giữ làm **sub-code** nhận diện trong category |
| `Lesson` / `Pattern` / `Anti-Pattern` | `Insight` | 1 câu — ngắn, actionable |
| `Context` / `Lý do` / `Áp dụng cho` | `Evidence/Context` | file:line · log excerpt · metric · discussion ref |
| `Confidence` (HIGH/MEDIUM/LOW) | — (schema gốc không có → **✅ v1.3: trường 8**) | `[EXT]` giữ cột Confidence trong bảng category; khi entry đứng riêng → `Confidence` là **trường 8** của KB Entry Schema `[Q6 → DECIDED v1.3]` *(✅ chốt v1.3 — §11 Q6 — amend nguồn Phụ lục Z A2; không còn ghi lồng vào Evidence/Context)* |
| — | `Source` (agent + thời điểm) | Bổ sung cột cho bảng triển khai |
| — | `Mission` (M1/M2) | Bổ sung cột — guard chống áp sai mission (§9 E8) |
| — | `Status` (NEW → CURATED → RETIRED) | Bảng triển khai dùng cột Status; bảng seed §5 ngầm = CURATED |

### 7.2 READ — ai load KB lúc nào

`[TB-05 §7.2 ← nguồn dòng 1138, 1740–1744, 1765]` `[SRC + EXT]`

| Agent | Thời điểm load | Mục đích | Bắt buộc? |
|---|---|---|---|
| **HAN** | **Phase 1 ANALYZE** — trước mọi thao tác optimize | Trích lessons/anti-patterns liên quan (lọc theo Mission + category + lĩnh vực) để APPLY | **BẮT BUỘC** (Instructions LUÔN: "load Knowledge Base trước khi optimize") |
| **NEMESIS** | MONITOR / DECIDE / FINALIZE / Research Council | Bước 1 SEARCH của KB Write Protocol — đối chiếu "đã có chưa?" trước khi ghi; quyết định DECIDE có dựa trên lessons | Bắt buộc khi ghi / khuyến nghị khi DECIDE |
| **SIVIL** | SYNTHESIZE / Research Council | Đối chiếu findings của sub-agents với KB: "đã có chưa?" (nguồn dòng 1765) | Bắt buộc khi ghi / khi SYNTHESIZE |
| **BELI / LISMA** | Khi code / review | Tham khảo lessons + anti-patterns (tránh lỗi đã biết) | Tùy chọn `[EXT]` — nguồn không bắt buộc 2 agent này load |
| Mọi agent | Trước khi đề xuất KB Candidate | Bước 1 SEARCH — đề xuất chỉ khi "chưa có" hoặc evidence mạnh hơn | Bắt buộc theo KB Write Protocol |

`[EXT]` Quy tắc đọc hiệu quả: KB có thể lớn theo thời gian → load **theo filter** (Mission + Category + keywords của lĩnh vực đang xử lý) thay vì toàn bộ file; token budget đọc KB tính vào ngân sách ~6–10K của G3 (§1.4).

### 7.3 WRITE — ai ghi lúc nào + KB Write Protocol 4 bước

`[TB-05 §7.3 ← nguồn dòng 1736–1789]` `[SRC]`

**Bảng quyền ghi KB (giữ nguyên nguồn dòng 1738–1744):**

| Agent | Quyền | Thời điểm capture |
|-------|-------|-------------------|
| **NEMESIS** | Ghi trực tiếp | MONITOR (đọc worklog) / DECIDE (pivot lessons) / FINALIZE / Research Council |
| **SIVIL** | Ghi trực tiếp | SYNTHESIZE (insight từ sub-agents) / Research Council |
| **HAN** | Ghi trực tiếp + **CURATOR** | Chu trình G3 (như cũ) + consolidate/dedup entries của cả team |
| **BELI** | Đề xuất qua worklog | Edge cases + patterns gặp khi code → trường "KB Candidates" |
| **LISMA** | Đề xuất qua worklog | Bug patterns + root cause insight khi review → trường "KB Candidates" |

> Nguồn dòng 1746: BELI/LISMA không ghi trực tiếp vì findings của họ cần được xác nhận — NEMESIS/SIVIL/HAN đọc "KB Candidates" trong worklog và quyết định ghi (**entry nào cũng phải có evidence**).

**KB WRITE PROTOCOL — 4 bước (trích nguyên văn TB-08 §4 — bản chuẩn toàn tập; nguồn gốc: dòng 1776–1789; cross-ref nội bộ điều chỉnh theo ngữ cảnh TB-05: Entry Schema → §7.4, duyệt candidate → TB-08 §8; chi tiết Bước 4 curator → §6):**

```
BƯỚC 1 — SEARCH   Tra KB theo category + keywords:
                     → Đã có → bỏ qua (hoặc bổ sung
                       evidence nếu làm entry mạnh hơn)
                     → Chưa có → sang Bước 2
BƯỚC 2 — FORMAT   Viết entry theo KB Entry Schema (§7.4):
                     insight ngắn + actionable;
                     evidence BẮT BUỘC
BƯỚC 3 — WRITE    NEMESIS/SIVIL/HAN: ghi trực tiếp
                     BELI/LISMA: để trong worklog trường
                     "KB Candidates" (duyệt — TB-08 §8)
BƯỚC 4 — CURATE   HAN consolidate trong chu trình G3 gần
                     nhất: dedup (trùng → merge) /
                     retire (lỗi thời → RETIRED)
```

### 7.4 KB Entry Schema + vòng đời status

`[TB-05 §7.4 ← nguồn dòng 1791–1811]` `[SRC]`

```markdown
## KB Entry
- ID: KB-YYYYMMDD-NNN
- Category: [category có sẵn của KB (xem cấu trúc lưu trữ)
             hoặc Research Insights (mới)]
- Insight: [1 câu — ngắn, actionable]
- Evidence/Context: [file:line | log excerpt | metric | discussion ref]
- Source: [NEMESIS/SIVIL/BELI/LISMA/HAN + thời điểm phát hiện]
- Mission: [M1 | M2]
- Status: NEW → CURATED → (RETIRED)
```

**Ví dụ 3 entry ghi từ 3 nguồn khác nhau (giữ nguyên nguồn dòng 1807–1811):**

| ID | Category | Insight | Evidence | Source | Mission |
|---|---|---|---|---|---|
| KB-20250612-001 | Config Lessons | Neo4j Aura: user = instance ID (8-hex), không phải luôn là "neo4j" | AuraDB handshake: user "neo4j" 401 / instance ID 200 | NEMESIS (MONITOR) | M2 |
| KB-20250612-002 | System Anti-Patterns | LLM key 4xx → KHÔNG retry mù — fail-fast ngay | log 121s (retry mù) vs 6.2s (fail-fast) | LISMA → HAN | M2 |
| KB-20250612-003 | Research Insights | Decompose audit hệ thống theo 4 branch (hiện trạng → điểm yếu → pattern → feasibility) cho coverage đủ | Discussion ② Research Council — task audit memory | SIVIL | M2 |

**Vòng đời status `[EXT — hình thức hóa từ chuỗi NEW → CURATED → (RETIRED)]`:**

```
  [NEMESIS/SIVIL/HAN ghi trực tiếp]           [HAN — Bước 3+4, mỗi chu trình G3]
  ┌─────────────── WRITE ───────────────┐   ┌────────── CURATE ────────────────┐
  │                                     │   │                                  │
  ▼                                     │   ▼                                  │
 NEW ──────▶ CURATED ──────▶ (vẫn dùng: APPLY mỗi vòng G3)                     │
  ▲           │                                                               │
  │           ├── DUPLICATE/OUTDATED/REFUTED/SUPERSEDED ──▶ RETIRED (§6.3)    │
  │           │                                                               │
  └── BELI/LISMA "KB Candidates" (worklog) ── NEMESIS/SIVIL/HAN chấp nhận ──────┘
```

> Entry RETIRED không xóa (§6.4); entry NEW quá 1 chu trình G3 mà chưa curate → được ưu tiên xử lý ở CURATING kế tiếp (không để tồn đọng — nguyên tắc §3.4).

---

## §8. STATE MACHINE — VÒNG G3

`[TB-05 §8 ← hình thức hóa từ vòng 3 phases (nguồn dòng 1546–1604) + Evolution Cycle (dòng 1404–1433)]` `[EXT]`

### 8.1 Diagram

```
G2 Output (code sạch + suggestions + concerns) — Tier 3 routing
        │
        ▼
┌─── HAN (G3) — STATE MACHINE ──────────────────────────────┐
│                                                            │
│  IDLE ──nhận task──▶ LOADING_KB                            │
│   ▲   (load KB trước khi optimize — Instructions LUÔN)     │
│   │                        │                               │
│   │                        ├──KB trống──▶ seed starter KB  │
│   │                        │   (§5) ──▶ trở lại load       │
│   │                        ▼                               │
│   │                   ANALYZING                            │
│   │        (G2 code + worklog + suggestions +             │
│   │         concerns + KB → chọn lĩnh vực tối ưu)          │
│   │                        │                               │
│   │                        ▼                               │
│   │                   OPTIMIZING ──┬─ P1 Data/System       │
│   │     (P1 Safety → P2 Perf →     │  Safety FAIL          │
│   │      P3 Quality; M2: sinh      ├─ approach sai         │
│   │      proposal items +          │  fundamental          │
│   │      Verification Plan)        └─ overfitting ngoài    │
│   │                        │          scope G3             │
│   │                        │                │              │
│   │                        ▼                ▼              │
│   │                   LEARNING           ESCALATED          │
│   │     (lessons / anti-patterns /     (chờ NEMESIS xử lý —   │
│   │      confidence → ghi KB)           verify/điều hướng; │
│   │                                     xong → IDLE — T15) │
│   │                        │                               │
│   │                        ▼                               │
│   │                   CURATING                              │
│   │     (Bước 4 KB Write Protocol:                          │
│   │      consolidate / dedup / retire — §6)                │
│   │                        │                               │
│   │                        ▼                               │
│   └──G3 output──▶ REPORTING                               │
│     (optimized code / proposal items + updated KB +        │
│      recommendations → NEMESIS — verify CP3)                  │
└────────────────────────────────────────────────────────────┘
```

### 8.2 Bảng transition

| # | Từ | Event | Guard | Action | Đến |
|---|---|---|---|---|---|
| T1 | IDLE | nhận G2 output (routing Tier 3) | task hợp lệ, mission đã biết (M1/M2) | mở task, ghi worklog bắt đầu | LOADING_KB |
| T2 | LOADING_KB | KB load xong | có ≥ 1 category hợp lệ | lọc lessons theo Mission + lĩnh vực | ANALYZING |
| T3 | LOADING_KB | KB trống / lỗi đọc | — | seed bằng starter KB §5 + cảnh báo trong worklog | LOADING_KB (load lại) |
| T4 | ANALYZING | phân tích xong | xác định ≥ 1 lĩnh vực tối ưu áp dụng được | lập danh sách cơ hội + xếp priority | OPTIMIZING |
| T5 | ANALYZING | không tìm được cơ hội | P1 pass, không gì cải thiện được | ghi "no-op" + lý do vào report | CURATING (vẫn curate KB, rồi REPORTING) |
| T6 | OPTIMIZING | P1 Data/System Safety FAIL | G2 fix chưa đạt | DỪNG tối ưu (không đụng P2/P3); chuẩn bị evidence | ESCALATED |
| T7 | OPTIMIZING | cần đổi approach | **đã báo NEMESIS trước** (Instructions: không đổi approach không báo) | ghi lý do đổi + phê duyệt vào worklog | OPTIMIZING (tiếp tục với approach mới) |
| T8 | OPTIMIZING | approach sai fundamental / overfitting ngoài scope G3 | — | chuẩn bị escalation message | ESCALATED |
| T9 | OPTIMIZING | tối ưu xong (M1) | P1 PASS, có metric trước/sau | tổng hợp kết quả + lessons thô | LEARNING |
| T10 | OPTIMIZING | sinh xong proposal items (M2) | **mỗi item có Verification Plan (a) + (b)** | đóng gói items theo §2.5 | LEARNING |
| T11 | OPTIMIZING | proposal item thiếu (a) kiểm chứng tay | — | trả lại — self-fix 1 vòng (§9 E4) | OPTIMIZING |
| T12 | LEARNING | ghi xong entries | mỗi entry có evidence | ghi KB (status NEW) + update confidence | CURATING |
| T13 | CURATING | consolidate/dedup/retire xong | mọi thao tác có lý do + evidence | đánh dấu CURATED/RETIRED + Curation Report §6.5 | REPORTING |
| T14 | REPORTING | output package xong | đủ output contract (§1.2) | gửi G3 output → NEMESIS (verify CP3) | IDLE |
| T15 | ESCALATED | NEMESIS xử lý xong | — | ghi kết luận + điều hướng vào worklog | IDLE (hoặc quay lại trạng thái NEMESIS chỉ định) |

### 8.3 Invariants (bất biến vòng G3)

| # | Invariant | Nguồn gốc |
|---|---|---|
| I1 | LOADING_KB phải hoàn tất **trước** OPTIMIZING | Instructions: "load Knowledge Base trước khi optimize" |
| I2 | OPTIMIZING chỉ chạy khi **P1 Data/System Safety PASS** | Instructions: "KHÔNG BAO GIỜ tối ưu khi safety chưa pass" |
| I3 | M2: không rời OPTIMIZING → LEARNING nếu chưa có ≥ 1 proposal item kèm Verification Plan (a)+(b) | Quy tắc M2 (dòng 1393–1395) |
| I4 | HAN **không ghi/apply bất kỳ thay đổi nào lên Live System** — POC/thử nghiệm chỉ trong Workspace | Instructions: "KHÔNG BAO GIỜ (M2) apply lên Live System" |
| I5 | Rời CURATING khi đã xong Bước 4 KB Write Protocol; HAN **không xóa entry** — chỉ đánh dấu RETIRED | Nguồn dòng 1787–1788 |
| I6 | Đổi approach phải **báo NEMESIS trước** khi tiếp tục tối ưu | Instructions: "KHÔNG BAO GIỜ thay đổi approach mà không báo NEMESIS" |
| I7 | ESCALATED là trạng thái chờ — HAN không tự mở khóa; NEMESIS điều hướng kết quả | ESCALATE contract (dòng 1142) |
| I8 | ESCALATE chỉ dùng 2 điều kiện nguồn: approach sai fundamental / overfitting không sửa được trong scope G3 (+ P1 FAIL — T6 `[EXT]`) | Dòng 1142 + §2.1 guard |

---

## §9. ERROR & EDGE CASES

`[TB-05 §9 ← mở rộng từ các quy tắc nguồn]` `[EXT]`

| # | Tình huống | Hành động chuẩn | Nguồn gốc / liên kết |
|---|---|---|---|
| **E1** | **KB trống (cold start)** — lần chạy G3 đầu tiên, chưa có entries | Seed bằng **starter KB = toàn bộ bảng nguồn §5** (9 categories, đã ở status CURATED). Ghi cảnh báo "cold-start" vào worklog; các vòng sau EVOLVE bổ sung dần | §5; [EXT] |
| **E2** | **Entries mâu thuẫn** — 2 entries cùng category kết luận ngược nhau | So **sức mạnh evidence** (file:line + log/metric > mô tả; nhiều nguồn > 1 nguồn) → retire cái yếu hơn, lý do REFUTED (§6.3). Nếu ngang sức → KHÔNG retire cả hai — flag CONFLICT trong report G3, NEMESIS quyết ở CP3 (hoặc đưa lên Research Council — TB-08) | §6; task spec |
| **E3** | **Metric không đo được** (M2 — hệ benchmark A/B chưa xây) | Dùng đánh giá **định tính** (logic, kinh nghiệm, analogy pattern S1–S4) + proposal item **PHẢI** kèm Verification Plan (b) benchmark spec deferred (metric + method + ngưỡng). Confidence của lesson liên quan ≤ MEDIUM cho tới khi có số liệu | Nguồn dòng 1393–1395 |
| **E4** | **Proposal item thiếu (a) kiểm chứng tay** | Trả lại — HAN self-fix 1 vòng trong OPTIMIZING: tự viết (a) log check / manual test cụ thể. Vẫn thiếu sau 1 vòng → **không submit item**, ghi vào concerns của report G3 (NEMESIS quyết bỏ/hoàn thiện) | [EXT] từ quy tắc 2.5 |
| **E5** | **P1 Data/System Safety FAIL** — G2 output "verified" nhưng HAN tìm thấy lỗ hổng safety | Dừng tối ưu ngay (I2) → ESCALATED kèm evidence (LISMA claimed clean nhưng chưa đạt — có thể là regression hoặc verify G2 sơ hở). KHÔNG tự sửa thay LISMA (đúng lớp trách nhiệm §1.3) | [EXT] từ Instructions + I2 |
| **E6** | **Overfitting không sửa được trong scope G3** (M1) | ESCALATE lên NEMESIS đúng điều kiện nguồn; kèm: metric trước/sau, các hướng đã thử, anti-patterns ghi nhận được | Dòng 1142 |
| **E7** | **Đã đổi approach mà chưa báo NEMESIS** (phát hiện self-audit hoặc NEMESIS hỏi) | Tạm dừng OPTIMIZING; báo NEMESIS NGAY (message + lý do + rủi ro); chỉ tiếp tục khi NEMESIS xác nhận; ghi vi phạm vào worklog | Instructions: KHÔNG BAO GIỜ; I6 |
| **E8** | **Lesson sai mission** — lesson M1 bị APPLY vào mission M2 (hoặc ngược) | Guard khi APPLY: lọc entries theo trường Mission; category "System Patterns (M2 — chỉ dùng cho mission System Research)" không nạp cho M1. Nếu đã áp nhầm → revert, ghi anti-pattern "cross-mission lesson leakage" | Nguồn dòng 1516; [EXT] guard |
| **E9** | **G2 concerns chưa được NEMESIS xác nhận** | Không dùng làm căn cứ quyết định cốt lõi — chỉ liệt kê trong ANALYZE + flag trong report; hỏi NEMESIS qua recommendations | [EXT] từ dòng 1558 |
| **E10** | **Nhiều lĩnh vực cần tối ưu cùng lúc** (workload lớn — ví dụ cả 5 lĩnh vực M1 đều có cơ hội) | Ưu tiên theo P1→P2→P3 rồi theo **expected impact** (metric impact chain); làm trọn vẹn ít lĩnh vực hơn là làm dở nhiều; phần còn lại ghi vào recommendations cho NEMESIS (có thể decompose tiếp — TB-07) | [EXT] |
| **E11** | **Model fallback giữa vòng G3** | HAN giữ nguyên JD + Instructions (role-based); ghi dòng `model switched` vào worklog; KHÔNG restart vòng từ đầu — tiếp tục phase đang chạy nếu context còn; nếu mất context → quay về LOADING_KB | TB-01 §2; [EXT] |
| **E12** | **KB entry có evidence yếu / thiếu** (vi phạm quy tắc "evidence trước khi ghi") | Curator (CURATING): KHÔNG xóa — trả về writer qua report G3 để bổ sung evidence; nếu không bổ sung được trong 1 chu trình kế tiếp → retire lý do REFUTED (evidence không đủ) | Quy tắc vàng KB (dòng 1821); [EXT] |

---

## §10. ACCEPTANCE CRITERIA — CHECKLIST VERIFY

`[TB-05 §10 ← đối soát toàn file]` `[EXT]`

- [ ] **AC1** — JD + Instructions HAN triển khai đủ 6 khối: sứ mệnh dual · 5 trách nhiệm (ANALYZE/OPTIMIZE/EVOLVE/CURATE/PROPOSE) · deliverables · LUÔN · KHÔNG BAO GIỜ · Input/Output contract + ESCALATE + Signature move.
- [ ] **AC2** — Priority đúng thứ tự **Data/System Safety → Performance → Code Quality**; guard P1 chặn tối ưu khi safety chưa pass (I2), có cả trong Instructions lẫn bảng §2.1.
- [ ] **AC3** — Vòng 3 phases ANALYZE → OPTIMIZE → EVOLVE triển khai đúng nội dung nguồn; Phase 1 có bước "Load Knowledge Base" (I1); Phase 2 chạy P1→P2→P3.
- [ ] **AC4** — Đủ 5 lĩnh vực M1 (Tuning, Feature Selection, Ensemble, CV Strategy, Simplification) + 5 lĩnh vực M2 (Memory, Execution, Thinking, Tools/Roster, UI/UX+Performance).
- [ ] **AC5** — Self-Evolving Engine đủ 5 bước APPLY → EXPERIMENT → MEASURE → LEARN → REPEAT; LEARN tách 2 nhánh: cải thiện → lesson mới / xấu đi → anti-pattern; ví dụ 3 vòng EDA/Features/Models giữ nguyên.
- [ ] **AC6** — Bảng điều kiện learn vs anti-pattern (§3.3) có quy tắc không ghi khi kết quả nằm trong noise + yêu cầu evidence.
- [ ] **AC7** — Quy tắc M2 vận hành được: mỗi vòng output = 1 Proposal Item kèm Verification Plan (a) kiểm chứng tay NGAY + (b) benchmark spec deferred; mini-template §2.5 đủ trường.
- [ ] **AC8** — TEAM KNOWLEDGE BASE giữ **đầy đủ** các bảng nguồn: Data Preprocessing (5) · Model Training (5) · Ensemble (4) · Anti-Patterns A1–A5 · System Patterns S1–S4 · System Anti-Patterns AS1–AS3 · Config Lessons C1–C3 · Performance Baselines (121s→6.2s, 39,615 nodes, 52 PDFs) · Research Insights.
- [ ] **AC9** — KB Entry Schema đủ 7 trường (ID/Category/Insight/Evidence/Source/Mission/Status) + vòng đời NEW → CURATED → RETIRED; ID đúng format KB-YYYYMMDD-NNN.
- [ ] **AC10** — Curator duty: 4 bước consolidate (SCAN/COMPARE/MERGE/TAG) + 4 lý do RETIRE + tần suất mỗi chu trình G3 + HAN KHÔNG xóa entry (chỉ đánh dấu) + Curation Report vào report G3.
- [ ] **AC11** — KB Interface: quy ước lưu trữ (markdown + mục lục + archive) · READ matrix (HAN bắt buộc Phase 1) · WRITE = bảng quyền 5 agent + KB Write Protocol 4 bước.
- [ ] **AC12** — State machine đủ 8 trạng thái (IDLE, LOADING_KB, ANALYZING, OPTIMIZING, LEARNING, CURATING, REPORTING, ESCALATED) + bảng transition có guard + 8 invariants không mâu thuẫn Instructions.
- [ ] **AC13** — 12 edge cases §9 bao phủ: cold start, entries mâu thuẫn, metric không đo được, proposal thiếu (a), safety fail, overfit ngoài scope, approach chưa báo, sai mission, concerns chưa xác nhận, workload, model fallback, evidence yếu.
- [ ] **AC14** — Mọi section có marker `[TB-05 §n ← nguồn dòng a–b]` + nhãn [SRC]/[EXT]/[Q]; Phụ lục A phủ toàn bộ nguồn dòng 1119–1716 + tham chiếu ngang.
- [ ] **AC15** — Invariant I4 kiểm chứng được: không có bất kỳ thao tác nào của HAN ghi/apply lên Live System — POC/thử nghiệm chỉ tồn tại trong Workspace hoặc trong Proposal items.

---

## §11. DECISIONS — [Q] ĐÃ CHỐT (v1.3)

`[TB-05 §11 ← đã chốt v1.3 theo DECISION-RECORD + Phụ lục Z]` `[DECIDED v1.3]`

| # | Câu hỏi | ✅ QUYẾT ĐỊNH (chốt v1.3) |
|---|---|---|
| Q1 | **"Mỗi vòng tối ưu" của quy tắc M2 (dòng 1393) đếm thế nào** — 1 lần chạy state machine G3, hay 1 lần lặp Evolution Cycle trong 1 chu trình G3? | **1 vòng = 1 task G3** (1 lần vào OPTIMIZING); mỗi task sinh ≥ 1 proposal item. |
| Q2 | **Ngưỡng "cải thiện đáng kể" để ghi lesson** (§3.3) — cụ thể là bao nhiêu (1 std? 0.5 std? % cố định?) | **M1: > 1 std của CV** (định lượng). **M2: > 5% cải thiện metric chuẩn hóa HOẶC vượt bootstrap 95% CI** so baseline; qualitative-only → chỉ ghi lesson với **confidence ≤ MEDIUM** (giữ E3). |
| Q3 | **KB lưu 1 file hay nhiều file** (§7.1)? | ✅ **DR-C6** — snapshot **multi-file + index** theo category; canonical là DB (SQLite/Prisma, versioned, soft-delete retire) — không còn giới hạn 500 entries. |
| Q4 | **HAN retire entries do NEMESIS/SIVIL ghi có cần đồng ý trước của NEMESIS không** (§6.4)? | **PRE-APPROVAL (chặt hơn):** HAN liệt kê retire-candidates trong report/proposal G3 → **NEMESIS duyệt tại CP3 TRƯỚC** khi retire có hiệu lực; NEMESIS tự retire được (kèm Decision Log). HAN KHÔNG tự retire entries do NEMESIS/SIVIL ghi khi chưa được duyệt. Đánh đổi tốc độ — chấp nhận theo P1 (thorough-first). |
| Q5 | **KB đặt ở đâu trong hạ tầng** — file trong Workspace, trong repo TMO, hay store riêng (Qdrant/SQLite)? | ✅ **DR-C6** — kiến trúc 3 lớp: **SQLite/Prisma canonical** (versioned, soft-delete retire) + **snapshot .md theo category** + **Live System read-only**; mọi write qua KB Write Protocol. *(Giải luôn câu hỏi liên file TB-08/TB-09 theo cùng cụm C6.)* |
| Q6 | **Trường Confidence có nằm trong KB Entry Schema chuẩn không** (§7.1)? | **CÓ** — thêm `Confidence: HIGH/MEDIUM/LOW` làm **trường 8** KB Entry Schema; amend nguồn trước (Phụ lục Z — A2, quy tắc số 1). |
| Q7 | **Trần số vòng G3** — G2 có trần 3 vòng review; G3 nguồn không nêu trần | **Trần 3 vòng Evolution Cycle mỗi task G3** (đối xứng G2); vượt → ESCALATE. Amend nguồn (Phụ lục Z — A3). |
| Q8 | **HAN có tham gia Research Council không?** | **Giữ thiết kế nguồn: HAN KHÔNG ngồi council** (council = NEMESIS ↔ SIVIL). [EXT bổ sung, không mâu thuẫn:] council transcript/output được **route tự động tới HAN như input** để curate — HAN nhận đủ thông tin mà không phải thành viên. |

**Phụ thuộc chờ các file khác:** TB-08 (Knowledge Capture chi tiết — 3 lỗ hổng, council output, 5 quy tắc vàng) · TB-09 (worklog schema chuẩn trường "KB Candidates" mà §7.3 tiêu thụ) · TB-11 (Proposal Schema 8 trường — mini-template §2.5 phải khớp khi NEMESIS tổng hợp) · TB-10 (Artifact Map nguồn của chuỗi đọc Metric Impact Chain / Impact Chain).

---

## PHỤ LỤC A — TRACEABILITY MATRIX

`[TB-05 Phụ lục A ← đối soát nguồn → blueprint]` `[EXT]`

| Nguồn (dòng) | Nội dung nguồn | Section TB-05 | Mức |
|---|---|---|---|
| 1119–1125 | Tiêu đề section G3 + JD sứ mệnh dual | §1.1 | SRC |
| 1127–1134 | Trách nhiệm (ANALYZE/OPTIMIZE/EVOLVE/CURATE/PROPOSE) + Deliverables | §1.1 | SRC |
| 1136–1143 | Instructions HAN (LUÔN/KHÔNG BAO GIỜ/contracts/ESCALATE/signature) | §1.2 | SRC |
| 1145–1151 | Tại sao vị trí G3 được thiết kế như vậy | §1.3 | SRC |
| 1153–1172 | Nguyên tắc cốt lõi + box G2 Output → G3 Output | §1.3 | SRC |
| 1174–1220 | Lĩnh vực M1 #1 — Hyperparameter Tuning (3 vòng search space) | §2.6 | SRC |
| 1222–1265 | Lĩnh vực M1 #2 — Feature Selection (importance + RFE) | §2.6 | SRC |
| 1267–1301 | Lĩnh vực M1 #3 — Ensemble Optimization (trade-off std/score) | §2.6 | SRC |
| 1303–1336 | Lĩnh vực M1 #4 — Cross-Validation Strategy | §2.6 | SRC |
| 1338–1381 | Lĩnh vực M1 #5 — Code Simplification | §2.6 | SRC |
| 1383–1391 | Mode M2 — bảng 5 lĩnh vực hệ thống | §4.1 | SRC |
| 1393–1395 | Quy tắc M2: proposal item + Verification Plan (a)/(b) | §2.5, §8 (I3) | SRC |
| 1397 | KB M2 thêm categories (System Patterns/AS/Config/Baselines) | §4.4, §5 | SRC |
| 1399–1436 | Cơ chế Self-Evolving — diagram Evolution Cycle + KB box | §3.1 | SRC |
| 1438 | Ghi chú: nguồn ghi KB không chỉ HAN — HAN là Curator | §3.4, §6.1 | SRC |
| 1440–1472 | Ví dụ self-evolving 3 vòng EDA/Features/Models | §3.2 | SRC |
| 1474–1476 | KB là tài sản chung của team | §5 | SRC |
| 1478–1505 | Bảng KB: Data Preprocessing (5) + Model Training (5) + Ensemble (4) | §5 | SRC |
| 1507–1514 | Bảng KB: Anti-Patterns A1–A5 | §5 | SRC |
| 1516–1522 | Bảng KB: System Patterns S1–S4 (M2) | §5, §9 (E8) | SRC |
| 1524–1529 | Bảng KB: System Anti-Patterns AS1–AS3 (M2) | §5 | SRC |
| 1531–1536 | Bảng KB: Config Lessons C1–C3 (M2) | §5 | SRC |
| 1538–1543 | Bảng KB: Performance Baselines (121s/39,615/52) | §5, §4.2 | SRC |
| 1546–1604 | Vòng lặp tối ưu 3 phases + output | §2.2–2.4 | SRC |
| 1606–1663 | Ví dụ M1 — G3 tối ưu House Prices pipeline | §2.7 | SRC |
| 1665–1699 | Schema tổng hợp G3 Internal Workflow | §2.8 | SRC |
| 1701–1714 | Bảng tóm tắt cơ chế G3 | §2.9 | SRC |
| 1718–1746 (ngang) | Knowledge Capture: quyền ghi KB 5 agent + lý do BELI/LISMA đề xuất | §7.3 | SRC |
| 1748–1772 (ngang) | Research Council 4 thời điểm (tham chiếu) | §7.2, §11 (Q8) | SRC |
| 1774–1789 (ngang) | KB Write Protocol 4 bước (SEARCH/FORMAT/WRITE/CURATE) | §7.3, §6 | SRC |
| 1791–1811 (ngang) | KB Entry Schema + 3 entry ví dụ | §7.4 | SRC |
| 1813–1815 (ngang) | Category mới Research Insights | §5 | SRC |
| 1817–1823 (ngang) | 5 quy tắc vàng Knowledge Capture (evidence bắt buộc) | §3.3, §9 (E12) | SRC |
| 3986–4028 (ngang) | G2 vs G3 — chiến lược đọc + token ~6–10K | §1.4 | SRC |
| 4428–4511 (ngang) | Ví dụ M2 chat 121s — HAN đọc Impact Chain, options A/B/C, CP3 | §4.3 | SRC |
| 4560–4615 (ngang) | Ghi chú agent HAN + bảng chiến lược G3 | §1.3, §1.4 | SRC |
| — (mở rộng) | Bảng điều kiện learn vs anti-pattern | §3.3 | EXT |
| — (mở rộng) | Curator duty: SCAN/COMPARE/MERGE/TAG + 4 lý do RETIRE + Curation Report | §6 | EXT |
| — (mở rộng) | KB Interface: quy ước file + READ/WRITE matrix + ánh xạ cột | §7 | EXT |
| — (mở rộng) | State machine 8 trạng thái + 15 transitions + 8 invariants | §8 | EXT |
| — (mở rộng) | Mini-template Proposal Item + bảng metric baseline từng lĩnh vực M2 | §2.5, §4.2 | EXT |
| — (mở rộng) | 12 edge cases E1–E12 + bảng tổng quan 9 categories | §9, §5.2 | EXT |
| — (mở rộng) | 8 decisions (chốt v1.3) | §11 | DECIDED v1.3 |

---

*TB-05 hoàn thành nhóm B — Engines. Cả 5 file engines (TB-03 G1 · TB-04 G2 · TB-05 G3+KB · TB-06 NEMESIS · TB-07 Decompose) đã đủ. Theo build order TB-00 §3: tiếp theo nhóm C (TB-08 Knowledge Capture, TB-09 RWV/Handoff, TB-10 Directed Reading) → nhóm D (TB-11 Proposal Schema, TB-12 E2E Playbooks). Tracker TB-00 §6: đánh TB-05 ✅ khi user duyệt.*
