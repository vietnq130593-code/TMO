# TB-07 — TL RESEARCH DECOMPOSITION PLAYBOOK (KING)

> 🔬 **TECHNICAL BLUEPRINT — AI RESEARCH TEAM (DUAL MISSION: M1 KAGGLE + M2 SYSTEM RESEARCH TMO)**
> Source of Truth: `upload/ai-team-workflow.md` — section "🔬 TL RESEARCH DECOMPOSITION — PHÂN TÍCH SÂU CHO RESEARCH TEAM" (dòng 2709–3172) + "Nhiệm vụ 3: DECOMPOSE" & ASSIGN templates (dòng 2122–2289) + 7-nhiệm-vụ box (dòng 2639–2686) + TRIAGE per-part (dòng 2091–2120) + Module Map (dòng 543–601) + RESEARCH COUNCIL (dòng 1748–1772) + ví dụ M2 (dòng 4428–4511)
> Tập blueprint: 13 file (TB-00 → TB-12) — file này thuộc **nhóm B — Engines**
> Version: 1.2 | Ngày: 2026-08-31 (review + fix — Task 9, 10-d) | Author: Mr. Robot (Z.ai Code) — Task ID 8-f
> **v1.3 (2026-09-01):** toàn bộ [Q] đã chốt theo DECISION-RECORD-v1.3.md (user ủy quyền, thorough-first) — xem Phụ lục Z nguồn.
>
> ⚠️ Quy tắc số 1 (TB-00 §5): nguồn là Single Source of Truth — TB-07 MÔ RỘNG để triển khai được, KHÔNG thay đổi thiết kế nguồn. `[SRC]` = giữ nguyên ý nguồn · `[EXT]` = mở rộng mới, không mâu thuẫn nguồn · `[Q]` = câu hỏi mở *(→ từ v1.3: đã chuyển thành [DECIDED v1.3]).*

---

## §0. MỤC ĐÍCH & PHẠM VI

`[TB-07 §0 ← template TB-00 §4]` `[EXT]`

- **Mục đích:** biến nhiệm vụ **3 DECOMPOSE** của KING (1 trong 7 nhiệm vụ TL, TB-06) thành playbook vận hành chi tiết: khi nào phải decompose, phân tích theo kiểu Research Director thế nào, quy trình 5 bước, template task .md chuẩn hóa, ví dụ đầy đủ M1 + M2, checklist chất lượng, anti-patterns, state machine của artifact decompose.
- **Tách khỏi TB-06 (theo phê duyệt chia 13 file):** TB-06 giữ tổng quan 7 nhiệm vụ + Research Council của KING; TB-07 đi sâu RIÊNG nhiệm vụ 3 để TB-06 gọn. TB-07 = "cẩm nang tay" KING gọi mỗi lần decompose.
- **Đối tượng đọc:** (1) kỹ sư triển khai logic DECOMPOSE vào TMO; (2) chính KING — runtime briefing khi decompose; (3) SIVIL — hiểu part nhận được sinh ra thế nào (input cho council ①); (4) user — review thiết kế (1 file = 1 review unit).
- **Phân biệt 2 tầng decompose (QUAN TRỌNG):**

| Tầng | Ai làm | Input → Output | Blueprint |
|---|---|---|---|
| **Mission → Parts** | **KING (TL)** | request đã TRIAGE → bộ task .md (parts) | **TB-07 (file này)** |
| **Part → sub-agent specs** | **SIVIL (G1)** | task .md từ KING → N specs cho sub-agents (M1: theo approach / M2: theo Module Map) | TB-03 §4–5 |

- **Phạm vi (bao gồm):** tiêu chí đơn giản vs phức tạp · quy trình 5 bước · Research Protocol 5 lớp · template task .md hợp nhất M1+M2 · playbook M2 theo Module Map · checklist + anti-patterns + state machine + error handling.
- **Phạm vi (KHÔNG bao gồm):** TRIAGE chấm điểm → TB-06/TB-02 · ASSIGN chọn workflow per tier → TB-06 · SIVIL decompose nội bộ G1 → TB-03 · worklog schema + Handoff → TB-09 · Artifact Map đọc code → TB-10 · Proposal Schema → TB-11.

| File liên quan | Quan hệ với TB-07 |
|---|---|
| TB-06 | Bố mẹ logic — nhiệm vụ 3 DECOMPOSE nằm trong 7 nhiệm vụ KING; TB-07 chi tiết hóa |
| TB-02 | Tier system + bảng complexity (input tier dự kiến cho từng part) |
| TB-03 | Người tiêu thụ task .md (SIVIL); Module Map + Findings Schema M2 |
| TB-08 | KB references trong task .md + council ① ghi KB |
| TB-09 | Task Status lifecycle chuẩn + worklog |
| TB-11 | Part 4 M2 → PROPOSAL → SELF-DIRECTION |

---

## §1. PHÂN TÍCH BÀI TOÁN PHỨC TẠP vs ĐƠN GIẢN

`[TB-07 §1 ← nguồn dòng 2072–2120, 2653–2657, 2709–2795, 3105–3149]` `[SRC]`

### 1.1 🎚️ Cổng quyết định: có cần decompose không?

`[TB-07 §1.1 ← nguồn dòng 2074, 2091–2100, 2120, 3176–3190]` `[SRC]`

TRIAGE (nhiệm vụ 2) chấm điểm Phạm vi + Suy luận + Rủi ro cho TOÀN MISSION [SRC dòng 3254–3257: 3 điểm = Simple · 4–6 = Medium · 7–9 = Complex]; DECOMPOSE (chia parts) chỉ kích hoạt khi mission **COMPLEX** — 7–9 điểm (nguồn dòng 3234: "Chia thành parts → Mô tả từng part trong .md"); SIMPLE → 1 `task_simple.md` nguyên khối (dòng 3195), MEDIUM → 1 `task_medium.md` nguyên khối, KHÔNG chia parts (dòng 3213–3215):

```
TRIAGE score mission
        │
        ├── SIMPLE (3 điểm) ────────► KHÔNG decompose
        │                              1 task .md NGUYÊN KHỐI
        │                              (Mô tả + Input + Output + Constraints)
        │                              Tier 1: TL → G2 → TL → DONE
        │
        ├── MEDIUM (4–6 điểm) ────► KHÔNG chia parts — 1 task_medium.md
        │                              nguyên khối [SRC dòng 3213–3215]
        │                              Tier 2: TL → G1 (BELI) → G2 → TL → DONE
        │
        └── COMPLEX (7–9 điểm) ──► DECOMPOSE theo 2 nhánh:
                                       M1: chia theo DEPENDENCY
                                           (part nào cần trước)
                                       M2: chia theo MODULE / LAYER
                                           (khu vực hệ thống nào)
                                       → Tạo .md cho TỪNG PART
                                       → Sắp xếp priority & thứ tự
```

**Quy tắc then chốt [SRC dòng 2120]:** *"Mission tổng thể = Complex, nhưng Part có thể là Simple/Medium. TL linh hoạt chọn tier cho từng part."* — decompose 1 mission phức tạp thành nhiều part ĐƠN GIẢN HƠN, mỗi part tự có tier riêng (tham chiếu bảng complexity TB-02 §4).

**Tư duy nền tảng [SRC dòng 2711–2712]:** bài toán phức tạp được phân tích **theo layer / dependency** (từng lớp câu hỏi nghiên cứu, tầng nào phải trả lời trước), KHÔNG phân tích theo cấu trúc file/class của code.

### 1.2 🧭 Research Decomposition vs. Code Decomposition

`[TB-07 §1.2 ← nguồn dòng 2714–2748]` `[SRC]`

```
┌─────────────────────────────────────────────────────────────┐
│   CODE TEAM (SAI — không phải cách chúng ta làm)            │
│   TL: "Module A cần class X, method Y, API Z"               │
│   Spec = bản vẽ kỹ thuật chi tiết                           │
│   → Design sai → toàn bộ sai → phải rebuild                 │
├─────────────────────────────────────────────────────────────┤
│   RESEARCH TEAM (ĐÚNG — cách chúng ta làm)                  │
│   TL: "Bài toán thuộc loại gì? Data đặc điểm gì?            │
│         Winning pattern thường là gì?"                      │
│   (M2: "Hiện trạng hệ thống gì? Điểm yếu ở đâu?            │
│          Pattern nâng cấp phù hợp?")                        │
│   Spec = ĐỀ CƯƠNG NGHIÊN CỨU (research protocol)            │
│   → Hypothesis sai → thử hypothesis khác → linh hoạt        │
└─────────────────────────────────────────────────────────────┘
```

### 1.3 🧠 3 Lý do TL KHÔNG triển khai logic chi tiết như code team

`[TB-07 §1.3 ← nguồn dòng 2750–2795]` `[SRC]`

| # | Lý do | Ý chính | Ví dụ M1 / M2 |
|---|---|---|---|
| 1 | **Bài toán THÍ NGHIỆM, không phải XÂY DỰNG** | Predictable/Deterministic/Design-first ↔ Emergent/Experimental/Data-driven | Xây phần mềm: biết kết quả cần gì. Nghiên cứu: phải khám phá |
| 2 | **DATA/LOGS quyết định approach, KHÔNG PHẢI TL** | TL chỉ đưa HƯỚNG; EXPERIMENT/EVIDENCE mới trả lời | TL biết "GBM mạnh tabular" nhưng không biết "XGB tune 0.115 vs CatBoost 0.125" [SRC 2771–2772] · (M2) "121s do key 401 hay timeout client?" |
| 3 | **Overfit plan = THUA** | TL over-specify → Groups bị gò bó → mất sáng tạo | "lr=0.01, depth=5" nhưng thực tế LGBM + freq encoding tốt hơn 0.003 |

> **Hệ quả vận hành:** TL nói **CÁI GÌ** cần làm, không nói **LÀM THẾ NÀO** → Groups (SIVIL + sub-agents) explore song song để tìm kết quả [SRC dòng 2780].

### 1.4 🔬 Deep Analysis — SÂU nhưng KHÔNG micro

`[TB-07 §1.4 ← nguồn dòng 3105–3135]` `[SRC]`

KING phân tích SÂU ở mức:
- ✅ "Bài toán này cần K-Fold CV vì small data"
- ✅ "Target encoding có risk leakage → phải K-Fold encode"
- ✅ "GBM mạnh nhưng CatBoost có thể yếu trên 1460 samples"
- ✅ "Feature eng priority cao hơn model tuning"
- ✅ "CV-LB gap cần monitor sát vì small data"
- ✅ (M2) "Latency cao → check fail-open paths + key pool"

KING KHÔNG phân tích chi tiết ở mức:
- ❌ "Dùng category_encoders.TargetEncoder(smoothing=0.3)"
- ❌ "XGBoost params: lr=0.01, depth=5, n_estimators=3000"
- ❌ "Pipeline: step1 → step2 → step3 → step4"
- ❌ "File structure: src/features/, src/models/"
- ❌ "Class FeatureEngineer với fit/transform interface"

**4 nguyên tắc vàng [SRC dòng 3126–3130]:**

| Nguyên tắc | TL làm | TL không làm |
|---|---|---|
| 1 | Nói **CÁI GÌ** cần làm | Không nói **LÀM THẾ NÀO** |
| 2 | Chỉ **RỦI RO** | Không chỉ cách tránh cụ thể |
| 3 | Đặt **HYPOTHESIS** | Không đặt IMPLEMENTATION |
| 4 | Chọn **DIRECTION** | Không chọn EXECUTION |

### 1.5 📊 Tóm tắt: TL cung cấp gì, KHÔNG cung cấp gì

`[TB-07 §1.5 ← nguồn dòng 3138–3149]` `[SRC]` (giữ nguyên bảng nguồn)

| Khía cạnh | TL cung cấp (Research) | TL KHÔNG cung cấp (Code) |
|---|---|---|
| **Mục tiêu** | Research Direction + Hypotheses | Class diagram + API spec |
| **Chiến lược** | CV strategy + Metric + Success criteria | File structure + Code architecture |
| **Rủi ro** | Leakage + Overfitting + CV-LB gap risk | Runtime error + Edge case + Compatibility |
| **Quyết định** | Decision Gates (khi nào pivot/continue) | Implementation Gates (khi nào refactor) |
| **Thứ tự** | Hypothesis priority (HIGH→LOW) | Development priority (critical path) |
| **Độ sâu** | Sâu METHODOLOGY, nông IMPLEMENTATION | Sâu IMPLEMENTATION, nông METHODOLOGY |
| **Kết quả kỳ vọng** | Hypothesis confirmed/rejected + Score improvement · M2: Evidence-based findings | Feature complete + Bug-free + Deployed |
| **Linh hoạt** | Hypothesis đổi theo data/logs | Spec phải follow chính xác |

---

## §2. QUY TRÌNH 5 BƯỚC DECOMPOSE

`[TB-07 §2 ← nguồn dòng 2921–3049, 2653–2657, 2127–2190, 2220–2289, 2536–2541]` `[SRC — nội dung từng bước; EXT — đánh số hợp nhất 5 bước]`

> **Ghi chú đánh số [EXT]:** nguồn KHÔNG liệt kê sẵn 1 danh sách "5 bước" đánh số liên tục — các bước rải theo thứ tự trong ví dụ House Prices (Bước 0 CLASSIFY → Bước 1 đọc context → Bước 2 xây Research Protocol) + 4 nhánh con của nhiệm vụ DECOMPOSE trong 7-nhiệm-vụ box (chia theo dependency/module → tạo .md → sắp priority). TB-07 hợp nhất CHÚNG THEO ĐÚNG THỨ TỰ nguồn thành 5 bước để vận hành; không thêm bước mới nào ngoài nguồn. [Q1 → DECIDED v1.3] xem §11 — ✅ CÓ: danh sách 5 bước đã cập nhật lên NGUỒN (amend Phụ lục Z — A1; quy tắc "nguồn trước").

### 2.0 🔀 Pipeline tổng quan

```
TRIAGE xong (mission = COMPLEX — decompose; MEDIUM: 1 task_medium.md nguyên khối, không qua pipeline 5 bước này)
   │
   ▼
┌─ Bước 1 ─ Phân tích toàn bộ context ──┐
└───────────────┬────────────────────────┘
                ▼
┌─ Bước 2 ─ Research Protocol Lớp 1 ────┐   Research Direction
└───────────────┬────────────────────────┘
                ▼
┌─ Bước 3 ─ Research Protocol Lớp 2–5 ─┐   Hypotheses → Design →
└───────────────┬────────────────────────┘   Criteria → Gates
                ▼
┌─ Bước 4 ─ Chia Parts + tier từng part ┐   M1: dependency /
└───────────────┬────────────────────────┘   M2: module/layer
                ▼
┌─ Bước 5 ─ Viết task .md + priority ───┐   → Council ① → ASSIGN
└────────────────────────────────────────┘   (TB-06)
```

### 2.1 📖 Bước 1 — Phân tích toàn bộ context

`[TB-07 §2.1 ← nguồn dòng 2929–2935, 2023–2046, 2056–2069]` `[SRC]`

- **Làm gì:** KING dùng output RECEIVE (đã đọc ở nhiệm vụ 1): M1 — competition page + data dictionary + forum top posts + phân tích ban đầu; M2 — health check + dev.log + system docs (.env.example, README) + scope ước tính (1 module hay toàn pipeline).
- **Câu hỏi then chốt:** "Bài toán thuộc loại gì? Data/logs đặc điểm gì? Có số đo cụ thể chưa?" [SRC 2808–2824, 2066–2068]
- **Output:** context brief (dữ kiện thô: 1460 rows × 79 features, metric RMSE log, outliers Id 524/1299 · M2: service nào degraded, latency patterns).
- **Lưu ý:** Bước 1 KHÔNG lặp lại RECEIVE — chỉ chuẩn hóa lại dữ kiện thành đầu vào cho Lớp 1 [EXT].

### 2.2 🧭 Bước 2 — Research Protocol · Lớp 1: RESEARCH DIRECTION

`[TB-07 §2.2 ← nguồn dòng 2806–2825, 2940–2955]` `[SRC]`

- **Làm gì:** trả lời 3 cụm câu hỏi:
  1. **Loại bài toán?** — Classification / Regression / Time-series / NLP / CV / Tabular / Multimodal · M2: Memory / Execution / Thinking / Tools / UI.
  2. **Data/hiện trạng đặc điểm gì?** — Size (small/medium/large), Quality (clean/noisy/missing), Distribution, Type · M2: logs có gì, services đang healthy không.
  3. **Winning pattern phổ biến?** — top solutions tương tự, papers/blogs/write-ups, domain knowledge · M2: patterns nâng cấp đã được chứng minh.
- **Câu hỏi then chốt:** "Nếu chỉ được nói 3 câu về hướng nghiên cứu này, nói gì?"
- **Output:** Research Direction (3–8 dòng) — dùng làm ## Research Direction trong mọi task .md (§3).

### 2.3 🧪 Bước 3 — Research Protocol · Lớp 2–5

`[TB-07 §2.3 ← nguồn dòng 2829–2916, 2957–3048]` `[SRC]`

| Lớp | Thành phần bắt buộc | M1 | M2 |
|---|---|---|---|
| **Lớp 2 HYPOTHESES** | Mỗi H có Priority (HIGH/MEDIUM/LOW) + Rationale + Risk | H1: target encoding tốt hơn one-hot... | H: "Fail-fast + key health check giảm 121s → < 10s" |
| **Lớp 3 EXPERIMENTAL DESIGN** | CV Strategy · Metric · Baseline · Ablation · Comparison | 5-Fold Stratified · RMSE log · mean→Ridge · 1 nhóm features/lần · cùng CV khác model | (M2) metric hệ thống: latency/token/uptime · baseline = số đo hiện tại từ logs · thay 1 config → đo trước/sau |
| **Lớp 4 SUCCESS CRITERIA** | Score target + delta tối thiểu · Robustness · Efficiency · Simplicity | CV < 0.120/0.115/0.110 · CV-LB gap < 0.01 · < 10 phút · < 100 features | Latency/coverage target · mọi claim có citation (evidence) · effort S/M/L · rollback path có sẵn |
| **Lớp 5 DECISION GATES** | Gate kèm điều kiện → hành động | Gate 1 sau EDA → chọn approaches; Gate 5 sau LB → pivot/continue | Gate 5 (M2): Proposal feedback → REVISE hay APPROVE |

- **Làm gì:** viết đủ 4 lớp cho MISSION (chưa chia part) — chi tiết đầy đủ ví dụ House Prices: 6 hypotheses H1–H6 có priority/rationale/risk, 5 gates.
- **Câu hỏi then chốt:** "Giả thuyết nào NẾU SAI sẽ làm đổ hướng này? Khi nào phải pivot?"
- **Output:** Research Protocol 5 lớp hoàn chỉnh — nguồn chất liệu để chia part ở Bước 4.

### 2.4 🧩 Bước 4 — Chia Parts + tier từng part

`[TB-07 §2.4 ← nguồn dòng 2653–2655, 2127–2190, 2091–2100]` `[SRC]`

- **Làm gì:**
  1. Chia protocol thành parts: **M1 theo dependency** (part nào cần trước — EDA trước Feature Eng trước Models) · **M2 theo module/layer** (4 Parts chuẩn §5).
  2. Chấm complexity CHO TỪNG PART (Phạm vi + Suy luận + Rủi ro, tham chiếu TB-02 §4) → tier riêng: House Prices: EDA MEDIUM (5) · Features COMPLEX (8) · Models COMPLEX (7) · Ensemble&Submit MEDIUM (6).
- **Câu hỏi then chốt:** "Part nào PHẢI xong trước part kia (dependency)? Part nào chạy song song được? Mỗi part đơn giản/phức tạp thế nào?"
- **Output:** danh sách parts (tên + mục tiêu + tier + dependency DAG — không vòng).

### 2.5 📝 Bước 5 — Viết task .md từng part + sắp priority → Council ①

`[TB-07 §2.5 ← nguồn dòng 2656–2657, 2220–2289, 2536–2541]` `[SRC + EXT]`

- **Làm gì:**
  1. Viết 1 task .md cho TỪNG part theo template §3 (đủ 9 trường nguồn + 5 trường mở rộng).
  2. Sắp xếp **priority & thứ tự** theo dependency DAG (critical path trước).
  3. Gọi **RESEARCH COUNCIL ①** — KING ↔ SIVIL, "sau DECOMPOSE — trước khi ASSIGN" [SRC 2537]: challenge hypotheses (KING hỏi, SIVIL đáp bằng findings/KB), đối chiếu KB "đã có chưa?", chốt tri thức mới → ghi KB NGAY (KB Write Protocol, TB-08). Output: discussion summary (vào worklog) + KB entries mới.
- **Câu hỏi then chốt:** "Hypotheses nào yếu nhất cần bị thách thức trước khi tốn công? Lesson nào trong KB làm thay đổi cách chia part?"
- **Output:** bộ task .md status `DRAFTED` → council review → `LOCKED` → giao ASSIGN (TB-06). State machine: §8.

---

## §3. TASK .md TEMPLATE CHUẨN HÓA (M1 + M2 HỢP NHẤT)

`[TB-07 §3 ← nguồn dòng 2220–2254 (template M1), 2259–2288 (template M2), 3071–3103 (RESEARCH TEAM SPEC)]` `[SRC + EXT hợp nhất]`

### 3.1 📄 Template đầy đủ

```markdown
# Task: <tên part ngắn gọn>
- **ID**: T-<MISSION>-<NNN>          # T-HP-002 / T-M2-001
- **Mission**: M1 | M2                # [SRC 2224, 2264]
- **Part**: <n>/<tổng> — <tên part>   # [SRC 2226, 2266]
- **Tier dự kiến**: SIMPLE | MEDIUM | COMPLEX   # [SRC 2225, 2265] — ASSIGN có thể
                                     # nâng/hạ qua DECIDE (TB-06 §8)
- **Group nhận**: G2 | G1→G2 | G1→G2→G3   # [EXT] — đề xuất workflow theo tier
- **Status**: Pending                 # lifecycle: TB-09
- **Competition/Scope**: <tên competition M1 / khu vực hệ thống M2>  # [SRC 2227]

## Mô tả               # [SRC 2230–2234] — CÁI GÌ cần làm, KHÔNG LÀM THẾ NÀO
## Input               # [SRC 2236–2242] — dữ kiện/artifacts/evidence từ parts trước
## Output kỳ vọng      # [SRC 2244–2247] — artifacts + điều kiện hoàn thành
## Constraints         # [SRC 2249–2253] — MUST / SHOULD / AVOID (mỗi mức ≥ 1 dòng)
## Research Direction  # [SRC 3074–3075] — trích Lớp 1 protocol, 1–3 dòng
## Hypotheses to Test  # [SRC 3077–3081] — H1 [HIGH]: ... (priority bắt buộc)
## Experimental Design # [SRC 3083–3086] — CV/metric/ablation · M2: baseline logs + cách đo
## Success Criteria    # [SRC 3088–3091] — con số đo được + ràng buộc chất lượng
## Decision Gate       # [SRC 3093–3096] — "nếu X fail/thấy Y → làm Z (pivot/adjust)"
## Evidence Sources (M2)   # [EXT] — danh sách file/log/API bắt buộc có evidence
## KB References       # [EXT] — KB-YYYYMMDD-NNN liên quan council ① đã đối chiếu
```

*(✅ chốt v1.3 — §11 Q4: task .md có `version: N` + block `## CHANGELOG` chính thức — DR-C3, đồng bộ TB-09 §9.4.)*

### 3.2 📖 Diễn giải trường mở rộng [EXT]

| Trường | Vì sao thêm | Quy ước |
|---|---|---|
| **Group nhận** | Nguồn tách việc chọn workflow ở ASSIGN (dòng 2195–2214); ghi dạng "đề xuất" trong .md giúp council ① thấy ngay team hình | Chỉ 3 dạng hợp lệ: G2 (SIMPLE) · G1→G2 (MEDIUM) · G1→G2→G3 (COMPLEX) — ASSIGN là nơi chốt cuối [SRC 2195–2214] |
| **Tier dự kiến** | Nguồn đã có "Tier: Complex" trong cả 2 template [2225, 2265] — chuẩn hóa thành "dự kiến" vì DECIDE được nâng/hạ giữa chừng [SRC 2345–2396] | Nhập giá trị TRIAGE per-part (Bước 4) |
| **Evidence Sources (M2)** | Nguồn bắt buộc "Mọi finding kèm evidence" [2284] + Findings Schema [596–601] — chỉ định NGUỒN evidence ngay từ decompose để G1/G2 không đọc dàn trải | Mỗi nguồn: tên file/log/API + mục đích; khớp Module Map [EXT] |
| **KB References** | Council ① "đối chiếu findings với KB" [1765] cần biết entry nào liên quan; lessons cũ tránh lặp nghiên cứu | List KB-ID + 1 dòng ý nghĩa; "none found" nếu KB chưa có |
| **Part ID** | Định danh part khi re-decompose / tham chiếu worklog | Format `T-<MISSION>-<NNN>`; part bị tách v2 → suffix `-b` (§8) [EXT] |

> **Quy tắc hợp nhất:** trường nào có sẵn trong template nguồn (ID, Mission, Tier, Part, Status, Mô tả, Input, Output kỳ vọng, Constraints) GIỮ NGUYÊN câu chữ làm heading; 5 trường Research Direction → Decision Gate lấy từ RESEARCH TEAM SPEC [3071–3103] gắn vào MỌI part từ MEDIUM trở lên. Part SIMPLE được phép rút gọn: 4 trường đầu + Constraints (như code fence nguồn dòng 2220–2254) [SRC + EXT].
>
> **Đối chiếu thuật ngữ với TB-06 [EXT]:** TB-06 §5 gọi gói định hướng KING viết cho từng part là **Research Protocol (M1) / System Audit Charter (M2)** — trong TB-07, gói đó = 5 trường `## Research Direction` → `## Decision Gate` (+ `## Evidence Sources` M2) nằm ngay trong task .md. Không phải artifact riêng — tránh 1 part 2 file.

### 3.3 🧪 Ví dụ điền đầy đủ — M1 (House Prices · Part 2/6)

`[TB-07 §3.3 ← nguồn dòng 2220–2254 + 3071–3103]` `[SRC — hợp nhất 2 template nguồn]`

```markdown
# Task: Feature Engineering
- **ID**: T-HP-002
- **Mission**: M1
- **Part**: 2/6 — Feature Engineering
- **Tier dự kiến**: COMPLEX (8 điểm: Phạm vi 3 + Suy luận 3 + Rủi ro 2)
- **Group nhận**: G1→G2→G3 (đề xuất — ASSIGN chốt)
- **Status**: Pending
- **Competition**: House Prices

## Mô tả
Xây feature engineering pipeline dựa trên insights từ Part 1 (EDA).
Xử lý missing values, transform numeric, encode categorical, tạo
interaction + domain features.

## Input
- train.csv, test.csv
- EDA insights (Part 1 worklog): 19 features missing; 6 numeric
  skew > 0.75; OverallQual corr = 0.79; outliers Id 524, 1299

## Output kỳ vọng
- Feature pipeline (fit/transform) + clean train/test
- Feature importance ranking (preliminary)

## Constraints
- MUST: Fit trên train only, transform test (no leakage)
- MUST: K-Fold target encoding cho high-cardinality
- SHOULD: Log transform SalePrice trước khi train
- AVOID: One-hot cho features > 10 categories

## Research Direction
Tabular regression, small data (1460×79) → feature quality >
quantity; domain = real estate (Location, Size, Quality).

## Hypotheses to Test
- H1 [HIGH]: Target encoding cho Neighborhood (25 categories)
- H2 [MEDIUM]: Log transform skewed numerics
- H3 [MEDIUM]: Interaction Quality × Area
- H4 [LOW]: Domain features (TotalSF, BathRatio)

## Experimental Design
- CV: 5-Fold Stratified (bins của y)
- Ablation: base → +H1 → +H2 → +H3 → +H4 (measure each)
- Compare: same model, same CV, chỉ khác features

## Success Criteria
- CV improvement > 0.005/hypothesis group; final CV < 0.120
- No leakage (fit train only)

## Decision Gate
- H1 fail → thử frequency encoding thay target encoding
- H3 overfit → giảm interaction degree
- Tổng improvement < 0.01 → feature eng không đáng, focus model

## KB References
- KB review: "Target encoding 5-fold stable hơn single-fold"
  (lesson từ competition tương tự — council ① đối chiếu)
```

### 3.4 🖥️ Ví dụ điền đầy đủ — M2 ("Hệ thống chat TMO chậm 121s" · Part 1/4)

`[TB-07 §3.4 ← nguồn dòng 2259–2288 (template M2) + 4428–4489 (ví dụ thật)]` `[SRC + EXT — điền theo số liệu thật]`

```markdown
# Task: Audit LLM Pipeline & Key Pool — root cause chat latency
- **ID**: T-M2-001
- **Mission**: M2
- **Part**: 1/4 — Audit hiện trạng
- **Tier dự kiến**: COMPLEX (8 điểm: Phạm vi 3 + Suy luận 3 + Rủi ro 2)
- **Group nhận**: G1→G2→G3 (đề xuất — ASSIGN chốt)
- **Status**: Pending
- **Scope**: LLM pipeline + key pool + fail-open paths

## Mô tả
Audit hiện trạng chat pipeline của TMO: luồng request /api/query,
LLM key rotation, retry + timeout behavior, fail-open paths —
tìm mọi điểm gây latency 121s.

## Input
- dev.log + PM2 logs (requests 121s đã xuất hiện)
- Health check hiện trạng (services connected/degraded)
- Source: service-key-pool, LLM client, API route /api/query

## Output kỳ vọng
- Findings schema: mỗi finding kèm evidence (file:line / log excerpt)
- Severity ranking từng finding
- Audit Report tổng hợp (BELI)

## Constraints
- MUST: Mọi finding kèm evidence cụ thể
- MUST: KHÔNG sửa bất kỳ file nào của TMO
- SHOULD: Đánh dấu finding ảnh hưởng user-facing
- AVOID: Đọc toàn bộ codebase — theo Module Map + Artifact Map

## Research Direction
Loại: System performance — latency degradation. Hiện trạng:
services healthy nhưng chat 121s → nghi fail-open + key pool.
Winning pattern: fail-fast + key health check + circuit breaker.

## Hypotheses to Test
- H1 [HIGH]: Latency do retry mù khi key 4xx (401 không retry được)
- H2 [HIGH]: Key pool không health check → cứ thử key hỏng
- H3 [MEDIUM]: Không timeout ngắn cho LLM calls
- H4 [LOW]: Thiếu response cache làm p95 cao thêm

## Experimental Design
- Baseline: số đo hiện tại từ logs (chat 121s khi key fail;
  6.2s khi key healthy)
- Ablation: thay 1 config → đo latency trước/sau (trong Workspace POC)
- Compare: cùng request, chỉ khác config — công bằng

## Success Criteria
- Mọi finding có file:line + log excerpt khớp nhau
- Root cause giải thích được cả 121s LẪN 6.2s
- Rollback path cho mọi thay đổi đề xuất

## Decision Gate
- Root cause không khớp code ↔ logs → PIVOT re-audit (KING)
- Phát hiện > 3 root cause không liên quan → tách mission mới
- Scope mở sang UI module → council ① đánh giá lại parts

## Evidence Sources
- dev.log (latency patterns) · src key-pool + LLM client (retry/timeout)
- health check API (service status) · PM2 logs

## KB References
- KB-20250612-002: "LLM key 4xx → KHÔNG retry mù — fail-fast
  ngay" (log 121s vs 6.2s) — trực tiếp xác nhận H1
- KB-20250612-003: decompose audit theo 4 branch để coverage đủ
```

---

## §4. VÍ DỤ DECOMPOSE M1 — HOUSE PRICES (6 PARTS)

`[TB-07 §4 ← nguồn dòng 2127–2167 (6 parts) + 2091–2100 (tier per part) + 2195–2214 (ASSIGN) + 2454–2460 (timeline)]` `[SRC]`

> Ghi chú [Q2 — DECIDED v1.3]: đề bài tóm tắt "5 parts Setup/EDA/Features/Models/Ensemble&Submit" — nguồn chuẩn là **6 parts (Part 0–5)**; TB-07 GIỮ NGUYÊN cấu trúc nguồn (✅ chốt v1.3: theo nguồn — 6 parts 0–5, giữ nguyên).

### 4.1 🧩 6 Parts (giữ nguyên nguồn)

```
Part 0: Setup & Baseline (SIMPLE)          Part 3: Model Building (COMPLEX)
  ├── Tạo project structure                  ├── Train XGBoost, LightGBM, CatBoost
  ├── Load data, basic stats                 ├── Hyperparameter tuning
  ├── Submit baseline (mean pred.)           ├── Cross-validation
  └── Output: skeleton + baseline submit     └── Output: models + CV scores

Part 1: EDA (MEDIUM)                       Part 4: Ensemble & Optimization (MEDIUM)
  ├── Missing value analysis                 ├── Stacking / Weighted average
  ├── Distribution analysis                  ├── Final feature selection
  ├── Correlation analysis                   ├── LB probing (nếu cần)
  ├── Outlier detection                      └── Output: ensemble + LB score
  └── Output: insights cho FE

Part 2: Feature Engineering (COMPLEX)       Part 5: Submission & Docs (SIMPLE)
  ├── Numeric transforms (log, box-cox)      ├── Generate submission file
  ├── Categorical encoding (target,          ├── Write solution summary
  │   freq, ordinal)                         ├── Push to Kaggle
  ├── Interaction features                   └── Output: submitted + documented
  ├── Domain features (TotalSF...)
  └── Output: feature pipeline + features
```

### 4.2 🔗 Dependency graph giữa parts

```
Part 0 (Setup)
   │  baseline submission + skeleton
   ▼
Part 1 (EDA) ──insights──► Part 2 (Features) ──features──► Part 3 (Models)
                              ▲                                │
                              └────── re-run khi PIVOT ────────┤ CV scores
                                                               ▼
                                              Part 4 (Ensemble) ──► Part 5 (Submit)
   (Part 4 nâng cấp COMPLEX khi G2 suggestion stacking 0.115 — kịch bản DECIDE, TB-06)
   (Pivot leakage: Part 5 dừng → quay Part 2+3 → audit leakage — SRC 2419–2425)
```

| Part | Tier | Phụ thuộc | Đầu vào từ | Chạy song song được với |
|---|---|---|---|---|
| 0 Setup | SIMPLE | — | — | — |
| 1 EDA | MEDIUM | 0 | skeleton + data | — |
| 2 Features | COMPLEX | 1 | EDA insights | — |
| 3 Models | COMPLEX | 2 | feature pipeline | — |
| 4 Ensemble | MEDIUM | 3 | CV scores + models | — |
| 5 Submit | SIMPLE | 4 | final ensemble | — |

> **Mô tả dependency [SRC 2654]:** M1 chia **theo dependency — part nào cần trước**. Chuỗi 0→1→2→3→4→5 là critical path; không có vòng. Pivot có thể quay ngược (4 → quay 2+3) nhưng KHÔNG tạo vòng vĩnh viễn (mỗi re-run có lý do ghi trong Decision log).

### 4.3 👥 Đội hình group từng part (ASSIGN — nguồn)

`[TB-07 §4.3 ← nguồn dòng 2195–2214]` `[SRC]`

| Part | Tier | Workflow | Lời giao task (nguồn) |
|---|---|---|---|
| 0 | SIMPLE | TL → G2 → TL → DONE | "LISMA setup project structure và baseline submission" |
| 1 | MEDIUM | TL → G1 → G2 → TL → DONE | "BELI code EDA, LISMA review, tôi kiểm tra insights" |
| 2 | COMPLEX | TL → G1 → G2 → G3 → TL → LOOP | "Full pipeline — SIVIL explore, BELI code, LISMA fix, HAN optimize features" |
| 3 | COMPLEX | TL → G1 → G2 → G3 → TL → LOOP | "Full pipeline — Model building & tuning" |
| 4 | MEDIUM | TL → G1 → G2 → TL → DONE | "Ensemble không cần tối ưu sâu" (→ nâng COMPLEX theo kịch bản DECIDE) |
| 5 | SIMPLE | TL → G2 → TL → DONE | "LISMA viết submission và documentation" |

**Timeline thực tế (FINALIZE, nguồn dòng 2454–2460):** P0 0.5ng · P1 1ng · P2 2ng (1 pivot leakage audit) · P3 2ng (re-run sau fix) · P4 1ng · P5 0.5ng — tổng 7 ngày.

---

## §5. PLAYBOOK DECOMPOSE M2 THEO MODULE MAP

`[TB-07 §5 ← nguồn dòng 2169–2190 (4 parts M2), 543–601 (Module Map + Findings Schema), 561–591 (ví dụ 4 branch), 4428–4449 (ví dụ chat 121s)]` `[SRC + EXT]`

### 5.1 🏗️ 4 Parts chuẩn — GIỮ NGUYÊN nguồn

`[TB-07 §5.1 ← nguồn dòng 2169–2190, 4445–4449]` `[SRC]`

```
KING chia "Đề xuất nâng cấp bộ nhớ TMO" thành 4 Parts:

Part 1: Audit hiện trạng (COMPLEX)
  ├── SIVIL dispatch SAs đọc code + 3 stores + logs
  └── Output: Findings schema (hiện trạng + điểm yếu)

Part 2: Phân tích root cause (MEDIUM)
  ├── LISMA truy vết evidence cho từng điểm yếu
  └── Output: root cause list + severity

Part 3: Thiết kế options (COMPLEX)
  ├── HAN đề xuất 2–3 options kèm trade-offs
  ├── BELI viết POC minh họa (nếu cần, trong Workspace)
  └── Output: options comparison

Part 4: Proposal & Verification Plan (MEDIUM)
  ├── KING tổng hợp PROPOSAL theo Proposal Schema
  └── Output: Proposal → SELF-DIRECTION
```

> 2 ví dụ nguồn đều dùng đúng khung này: "nâng cấp bộ nhớ TMO" (dòng 2172) và "chat TMO chậm 121s" (dòng 4445: P1 COMPLEX · P2 MEDIUM · P3 COMPLEX · P4 MEDIUM) → 4 Parts chuẩn là hợp đồng cố định cho M2.

*(✅ chốt v1.3 — §11 Q6: thêm Part 0 "Setup & Baseline" cho mission M2 multi-part (≥ 2 parts hoặc tier ≥ T2) — khởi Workspace + snapshot baseline từ logs + chốt số liệu so sánh; mission 1-part T1 bỏ Part 0 — amend nguồn Phụ lục Z A4.)*

### 5.2 🗺️ Bảng Module TMO → Part audit tương ứng

`[TB-07 §5.2 ← nguồn dòng 543–556 (Module Map)]` `[EXT — mở rộng thành bảng phân công audit]`

| Module (SA) | Part 1 — Audit đọc gì | Part 2 — Root cause thường nằm ở | Part 3 — Options tham khảo |
|---|---|---|---|
| **Memory Architecture** (SA-01) | Qdrant/Neo4j/SQLite coordination, embedding pipeline | Sync giữa store, duplication, coverage thiếu | RAG, graph-RAG, multi-store patterns |
| **Execution Pipeline** (SA-02) | API routes, query pipeline, workflow thực thi | Nước rút khối, retry mù, thiếu timeout | Pipeline parallel, fail-fast, circuit breaker |
| **Thinking Process** (SA-03) | Agent instructions, reasoning strategy, protocol | Prompt mâu thuẫn, thiếu verify bước | Protocol mới, rubric, council bố cục |
| **Tools & Agents Roster** (SA-04) | MCP tools, agent configs, model-to-role mapping | Role chồng lấn, tool fail-open | Roster redesign, role-based mapping |
| **UI/UX** (SA-05) | App pages, components, UX flow | Render nặng, chặn main thread | Lazy load, state management |
| **Services Integration** (SA-06) | R2, Supabase, Neo4j, Qdrant, LLM key pool | Key 401, connection leak, env sai | Health check, connection pool, fail-fast |
| **Performance** (SA-07) | dev.log, PM2 logs, latency, token usage | Latency spike, token waste | Benchmark A/B (deferred), cache |
| **Config & Deployment** (SA-08) | .env, ecosystem config, health check | Env override, config drift | Config schema + validation |

> Quy ước [EXT]: cột "Part 2/3" là GỢI Ý TRỌNG TÂM audit, không phải giới hạn — root cause cuối cùng do LISMA xác định bằng evidence; options do HAN đề xuất. Part 4 luôn do KING tổng hợp.

### 5.3 📏 Quy tắc chọn số part

`[TB-07 §5.3 ← nguồn dòng 545, 558, 2172, 4445]` `[EXT — quy tắc đề xuất]`

| # | Tình huống | Số part | Quy tắc |
|---|---|---|---|
| R1 | **1 module** (vd: "nâng cấp bộ nhớ TMO") | **4 parts chuẩn** | Nguyên văn nguồn [SRC 2172] |
| R2 | **Triệu chứng cross-module** (vd: "chat chậm 121s" — đụng pipeline + key pool + fail-open) | **4 parts chuẩn** — Part 1 mở rộng | Audit gộp: mỗi module dính líu 1 nhóm SA + 1 SA riêng cho tương tác giữa chúng; Part 2–4 vẫn theo triệu chứng chung (1 root-cause list, 1 options set, 1 proposal) [SRC 4454–4462] |
| R3 | **Đa triệu chứng độc lập** (vd: "UI chậm" + "key 401") | **Tách 2 mission M2, mỗi mission 4 parts** | Chia khi evidence ít dùng chung (< ~50%) — gộp sẽ làm Part 2/3 phình; tách mission thì mỗi proposal SELF-DIRECTION quyết riêng |
| R4 | **Trần size audit** | — | Part 1 gộp vượt **15 SA** (trần System Audit M2 5–15, TB-03 §5) → áp R3 tách mission |
| R5 | **Proposal quá lớn** | — | Part 3/4 chạm > 3 module HOẶC > 8 options → chia proposal thành đợt priority (P-YYYYMMDD-NNN nối tiếp, TB-11) |

> **Câu hỏi then chốt chọn R1/R2/R3 [EXT]:** "Nếu xóa 1 module khỏi yêu cầu, các root cause có thay đổi không?" — Không → R2 (triệu chứng chung) · Có → R3 (độc lập).

*(✅ chốt v1.3 — §11 Q3: R3 giữ ngưỡng 50% mặc định; log usage 5 mission M2 đầu → recalibrate qua Decision Log.)*

### 5.4 🌲 Cấu trúc Branch audit cho Part 1 (M2)

`[TB-07 §5.4 ← nguồn dòng 561–591 + KB-20250612-003]` `[SRC]`

Part 1 (COMPLEX) được SIVIL triển khai theo 4 branch (KB lesson: "Decompose audit hệ thống theo 4 branch cho coverage đủ"):

```
Branch A: HIỆN TRẠNG     (đọc code cấu trúc, stores, pipeline)
Branch B: ĐIỂM YẾU       (logs chậm/fail, duplication, coverage, consistency)
Branch C: PATTERN THAM KHẢO (patterns + trade-offs từng pattern)
Branch D: FEASIBILITY    (ràng buộc hệ đang chạy + effort từng option)
→ Tổng hợp theo Findings Schema (mỗi finding: evidence + severity + cơ hội)
→ BELI viết research report + POC minh họa (TRONG WORKSPACE)
```

### 5.5 ⚖️ So sánh decompose M1 vs M2

| Khía cạnh | M1 — Kaggle | M2 — System Research |
|---|---|---|
| Trục chia | **Dependency** (part nào cần trước) | **Module/layer** (khu vực hệ thống) |
| Số part | 4–6 theo competition (House Prices: 6) | **4 parts chuẩn** cố định |
| Part mở đầu | Setup & Baseline (SIMPLE) | Audit hiện trạng (COMPLEX) |
| Part kết thúc | Submission & Docs (SIMPLE) | Proposal & Verification Plan (MEDIUM) |
| Evidence | CV scores, LB feedback | file:line + log excerpt (bắt buộc mọi finding) |
| Đầu ra cuối | Submission/Dataset/Docs → User | PROPOSAL → SELF-DIRECTION |
| Biên an toàn | — | KHÔNG sửa Live System; POC chỉ trong Workspace |

---

## §6. CHECKLIST "DECOMPOSE ĐỦ TỐT"

`[TB-07 §6 ← tổng hợp nguồn dòng 2220–2254, 3071–3103, 596–601, 3126–3134]` `[EXT — 12 tiêu chí]`

KING tự đối chiếu 12 tiêu chí khi viết xong bộ drafts — mọi ✅ mới chuyển `DECOMPOSING → DRAFTED` (gate vị trí §8.1/§8.2; sau đó council ① review nằm ở `DRAFTED → COUNCIL_REVIEWED`):

- [ ] **C1 — Một mục tiêu/part:** mỗi part trả lời ĐÚNG 1 câu hỏi nghiên cứu chính (Mô tả không chứa 2 mục tiêu nối bằng "và").
- [ ] **C2 — Input/Output rõ:** mọi part khai báo Input cụ thể + Output kỳ vọng đo/xem được được.
- [ ] **C3 — Dependency không vòng:** DAG parts là đồ thị hữu hướng không chu trình; re-run do pivot có ghi Decision log.
- [ ] **C4 — Tier hợp lý per part:** mỗi part có điểm complexity riêng (không kế thừa mù mịt tier mission).
- [ ] **C5 — Hypotheses test được:** mỗi H có Priority + Rationale + Risk; tồn tại dữ kiện/logs có thể chứng minh H SAI.
- [ ] **C6 — Success criteria đo được:** con số cụ thể (CV < 0.120 · latency < 10s · evidence 100%) — không "tốt hơn" suông.
- [ ] **C7 — Decision Gate rõ:** mỗi part ≥ 1 gate dạng "nếu X → pivot/adjust/drop"; mission có gate pivot tổng (CV-LB gap · M2: claim thiếu evidence).
- [ ] **C8 — Evidence source (M2):** mọi part khai Evidence Sources trỏ file/log/API thật; AVOID đọc toàn bộ codebase được ghi.
- [ ] **C9 — Coverage đủ:** hợp các Output parts = toàn bộ Deliverable mission (không mảnh mục tiêu nào không thuộc part nào).
- [ ] **C10 — Priority & thứ tự:** có bảng thứ tự thực hiện theo dependency (critical path trước).
- [ ] **C11 — Không micro-manage:** 4 nguyên tắc §1.4 được tôn trọng — task .md không chứa library/params/file structure cụ thể.
- [ ] **C12 — KB đã đối chiếu:** mỗi part có KB References (hoặc "none found"); lessons liên quan đã được nhét vào Research Direction/Hypotheses.

---

## §7. ANTI-PATTERNS DECOMPOSE

`[TB-07 §7 ← suy từ nguồn dòng 2783–2795, 2797–2918, 3119–3134, 2284–2287]` `[EXT]`

| # | Anti-pattern | Dấu hiệu nhận biết | Cách sửa |
|---|---|---|---|
| A1 | **Part quá lớn** | Mô tả chứa 2+ mục tiêu; workflow part kéo dài bất thường; > 3 hypotheses nhóm khác chủ đề | Split theo mục tiêu — tách part v2 (`T-XX-002-b`) hoặc nâng part lên nhóm + chia sub-part cho SIVIL |
| A2 | **Parts trùng lặp** | 2 parts cùng trả lời 1 research question; SAs của 2 parts đọc cùng file | Gộp thành 1 part; giữ hypothesis duy nhất với priority cao hơn |
| A3 | **Dependency vòng** | A cần output B, B cần output A (thường do A1/A2 gây ra) | Tách phần dùng chung thành Part 0' nhỏ chạy trước cả hai, HOẶC gộp A+B thành 1 part |
| A4 | **Decompose theo file/thành phần code** | Mô tả part = "đọc file X, Y, Z" thay "trả lời câu hỏi Q"; Parts map 1:1 vào cấu trúc thư mục | Đặt lại theo CÂU HỎI NGHIÊN CỨU; file chỉ xuất hiện ở Evidence Sources/Module Map |
| A5 | **Thiếu Decision Gate** | Part chạy đến cùng bất kể kết quả; không có đường pivot | Thêm ≥ 1 gate theo mẫu "nếu X fail → làm Y" (mẫu nguồn dòng 3093–3096) |
| A6 | **Over-specification** | Task .md chứa `smoothing=0.3`, `lr=0.01`, file structure, class interface | Xóa chi tiết implementation; thay bằng hypothesis + rủi ro (§1.4) |
| A7 | **Part "misc" / catch-all** | Part cuối gom mọi việc lơ lửng "còn lại" | Phân bổ từng mục vào part đúng chủ đề; việc không thuộc mission nào → backlog DECIDE (🟢 MINOR) |
| A8 | **M2 thiếu evidence source** | Part không chỉ định nguồn evidence; ràng "đọc toàn bộ codebase" | Gán Evidence Sources theo Module Map; giữ constraint AVOID (nguồn dòng 2287) |

---

## §8. STATE MACHINE CỦA BỘ DECOMPOSE

`[TB-07 §8 ← nguồn dòng 2536–2541, 2345–2441, 2555–2581]` `[EXT — hình thức hóa]`

### 8.1 🔀 Diagram

```
              (KING bắt đầu nhiệm vụ 3)
                       │
                       ▼
               ┌───────────────┐
        ┌─────►│ DECOMPOSING   │ KING chạy 5 bước §2 (viết parts)
        │      └───────┬───────┘
        │              ▼ mọi task .md đủ 12 tiêu chí §6
        │      ┌───────────────┐
        │      │ DRAFTED       │ bộ task .md hoàn chỉnh, status Pending
        │      └───────┬───────┘
        │              ▼ Council ① (KING ↔ SIVIL, TRƯỚC ASSIGN)
        │      ┌───────────────┐
        │      │COUNCIL_REVIEWED│ hypotheses đã bị challenge; KB đối chiếu
        │      └───────┬───────┘
        │              ▼ mọi challenge được xử lý
        │      ┌───────────────┐
        │      │ LOCKED        │ giao ASSIGN (TB-06); parts KHÔNG sửa tự do
        │      └───────┬───────┘
        │              │
        │              ▼ ASSIGN → MONITOR → DECIDE (TB-06)
        └──────────────┘
   Quay lại DECOMPOSING khi: (xem bảng transition §8.2)
```

### 8.2 📋 Bảng transition

| Từ → Đến | Trigger | Ai kích hoạt | Hành động + ghi chú |
|---|---|---|---|
| → DECOMPOSING | TRIAGE kết luận COMPLEX | KING | Bắt đầu 5 bước §2 (MEDIUM → 1 task .md nguyên khối — không vào state machine này) |
| DECOMPOSING → DRAFTED | Đủ parts + đủ 12 tiêu chí §6 | KING | Không qua ASSIGN khi chưa DRAFTED |
| DRAFTED → COUNCIL_REVIEWED | Council ① họp xong (sau DECOMPOSE, trước ASSIGN) [SRC 2537] | KING + SIVIL | Discussion summary vào worklog + KB entries mới [SRC 1768–1770] |
| COUNCIL_REVIEWED → LOCKED | Mọi challenge được xử lý (sửa H / thêm gate / tách part) | KING | ASSIGN chỉ nhận bộ LOCKED |
| **COUNCIL_REVIEWED → DECOMPOSING** | Council ① bác hypotheses lớn / thiếu coverage / có A1–A8 | SIVIL challenge | KING sửa rồi quay DRAFTED (đi lại vòng) |
| **LOCKED → DECOMPOSING (part cục bộ)** | DECIDE: nâng/hạ tier part · pivot quay lại parts trước [SRC 2366, 2419] · M2 claim thiếu evidence → re-audit [SRC 2574] · G2 ESCALATE architectural [SRC 2555] | KING (qua DECIDE) | Chỉ mở khóa các part ảnh hưởng; các part đã chạy tốt giữ LOCKED; part thay đổi có suffix `-b` [EXT] |
| **LOCKED → DECOMPOSING (toàn bộ)** | Proposal bị REVISED từ SELF-DIRECTION cần nghiên cứu bổ sung [SRC 2577–2579] | SELF-DIRECTION | KING giao lại group liên quan — re-decompose scope phần REVISED |

> **Nguyên tắc khóa [EXT]:** trạng thái LOCKED không có nghĩa "bất biến" — nó có nghĩa "mọi thay đổi phải đi qua DECIDE của KING và để lại dấu vết trong Decision log + task .md v2" (nguồn: "Decision log — mọi quyết định + lý do", dòng 2682). Task Status từng part (Pending→...) là lifecycle runtime khác — xem TB-09.

---

## §9. ERROR & EDGE CASES

`[TB-07 §9 ← nguồn dòng 2007, 2522–2524, 2574–2581, 2584–2629]` `[EXT]`

| # | Tình huống | Xử lý | Theo nguồn |
|---|---|---|---|
| E1 | **Task KHÔNG decompose được** (mọi cách chia đều gãy dependency hoặc parts chỉ 1 mục tiêu duy) | KING thử 2 nhánh chia (theo dependency / theo câu hỏi) → vẫn gãy → **ESCALATE user**: trình 2 phương án — (a) chạy nguyên khối ở tier thấp hơn, (b) user làm rõ scope; KHÔNG tự pha loãng scope | Mở rộng từ "Ambiguous → hỏi user ĐÚNG 1 CÂU" [2007] + G1 blocking → TL quyết [2522–2524] |
| E2 | **2 parts phụ thuộc vòng** | Ưu tiên tách phần dùng chung làm part chạy trước; nếu không tách được → gộp 1 part; ghi nguyên do trong Mô tả | §7-A3 |
| E3 | **Hypotheses không test được** (không có dữ kiện nào chứng minh được sai) | Council ① bắt buộc bắt (C5); nếu lọt qua → LISMA/verify CP phát hiện "claim thiếu evidence" → PIVOT re-audit | Challenge hypotheses [2537, 1763] + M2 claim thiếu evidence → pivot [2574] |
| E4 | **Decompose xong phát hiện sai mission** (M1 hóa ra là M2) | Quay CLASSIFY (Bước 0), re-TRIAGE, re-DECOMPOSE — toàn bộ parts cũ đánh dấu void; ghi Decision log | TB-02 §6 (sai mission → pivot về CLASSIFY) |
| E5 | **Task quá nhỏ** (SIMPLE) | KHÔNG decompose — 1 task .md nguyên khối 4 trường (Mô tả/Input/Output/Constraints) giao G2 (Tier 1) | [3176–3190] |
| E6 | **Part SIMPLE bị "lướt"** (P0/P5 thiếu output cho part sau) | Template vẫn bắt Output kỳ vọng + Constraints; MONITOR kiểm output trước khi part sau chạy | Template bắt buộc mọi part [2220+] |
| E7 | **M2: Workspace chưa mở** | Part 3 POC không thực thi được → đánh cờ `POC-NEEDS-WORKSPACE` trong part (tiêu dùng bởi Proposal, TB-02 §6) | TB-02 quy ước |
| E8 | **Deadline áp giữa decompose** | Hạ số part: gộp parts cùng chủ đề, chỉ giữ CRITICAL; mọi hypothesis dưới MEDIUM cho vào backlog | "Deadline áp → hạ tier, chỉ giữ CRITICAL parts" [2568–2569] |
| E9 | **Decompose M2 nhiều module quá trần** | Áp R3 (§5.3): tách mission, báo user nếu scope ban đầu là 1 yêu cầu | Trần SA 5–15 [TB-03 §5] |
| E10 | **Council ① bất đồng kéo dài** (≥ 2 vòng không chốt) | KING quyết theo Decision Framework (ảnh hưởng → rủi ro → Proceed/Adjust/Pivot/Drop); ghi 2 interpretation vào worklog như TB-03 SA-arbitration | Decision Framework [2584–2629] |

---

## §10. ACCEPTANCE CRITERIA

`[TB-07 §10 ← chuẩn TB-00 §4]` `[EXT — checklist verify]`

- [ ] **AC1** — §1 giữ nguyên khung nguồn: Research vs Code box, 3 lý do, 4 nguyên tắc "SÂU nhưng KHÔNG micro", bảng tóm tắt 8 dòng.
- [ ] **AC2** — Quy trình 5 bước §2 mỗi bước có: làm gì + câu hỏi then chốt + output + dòng nguồn; thứ tự khớp nguồn (context → Lớp 1 → Lớp 2–5 → chia parts → .md + council ①).
- [ ] **AC3** — Research Protocol 5 lớp đầy đủ: Direction / Hypotheses (priority+rationale+risk) / Experimental Design (CV+metric+baseline+ablation+comparison) / Success Criteria (4 nhóm) / Decision Gates (5 gates).
- [ ] **AC4** — Template §3 đủ 9 trường nguồn (Mô tả, Input, Output kỳ vọng, Constraints, Research Direction, Hypotheses to Test, Experimental Design, Success Criteria, Decision Gate) + Mission [SRC 2224, 2264] + 5 trường [EXT] (Part ID, Tier dự kiến, Group nhận, Evidence Sources, KB References).
- [ ] **AC5** — Constraints theo 3 mức MUST / SHOULD / AVOID.
- [ ] **AC6** — 2 ví dụ điền đầy đủ: M1 (House Prices Part 2 — khớp nguồn) + M2 (chat TMO 121s — dùng số liệu thật 121s/6.2s, key 401, 3 root causes [SRC 4471–4473; ví dụ §3.4 điền 4 hypotheses H1–H4]).
- [ ] **AC7** — Ví dụ M1 giữ 6 parts (0–5) nguyên cấu trúc + tier + dependency + đội hình ASSIGN theo nguồn.
- [ ] **AC8** — Playbook M2: 4 Parts chuẩn nguyên văn; bảng Module Map 8 module; 5 quy tắc chọn số part.
- [ ] **AC9** — Checklist §6 ≥ 8 tiêu chí (đạt 12), mỗi tiêu chí kiểm tra được.
- [ ] **AC10** — Anti-patterns §7 ≥ 5 mẫu kèm dấu hiệu + cách sửa (đạt 8).
- [ ] **AC11** — State machine §8: 4 trạng thái + council ① nằm TRƯỚC ASSIGN + điều kiện quay lại DECOMPOSING ghi rõ.
- [ ] **AC12** — §9 có đủ 3 tình huống bắt buộc: không decompose được (ESCALATE user), dependency vòng, hypotheses không test được.
- [ ] **AC13** — Mọi section chính ghi `[TB-07 §n ← nguồn dòng a–b]` + dấu [SRC]/[EXT]/[Q].
- [ ] **AC14** — Danh tính: KING (TL), SIVIL, BELI, LISMA, HAN — không lẫn tên model làm tên agent; Live System chỉ đọc / Workspace là nơi POC.

---

## §11. DECISIONS — [Q] ĐÃ CHỐT (v1.3)

`[TB-07 §11 ← quy tắc TB-00 §5]` `[DECIDED v1.3]`

- **[Q1] Quy trình 5 bước (§2) có cập nhật lên NGUỒN: ✅ CHỐT v1.3 — CÓ** — cập nhật NGUỒN: danh sách 5 bước DECOMPOSE chính thức đánh số (amend Phụ lục Z — A1; quy tắc "nguồn trước").
- **[Q2] House Prices 5 hay 6 parts: ✅ CHỐT v1.3 — theo nguồn: 6 parts (0–5)** — giữ nguyên.
- **[Q3] Ngưỡng R3 (§5.3 — evidence dùng chung < ~50%): ✅ CHỐT v1.3 — giữ 50% mặc định** + hiệu chỉnh: log usage 5 mission M2 đầu → recalibrate qua Decision Log.
- **[Q4] Version field trong task .md khi re-decompose: ✅ CHỐT v1.3 — CÓ** — task .md có `version: N` + `## CHANGELOG` block chính thức (✅ DR-C3; đồng bộ TB-09 §9.4).
- **[Q5] Council ① với mission chỉ có parts SIMPLE/MEDIUM: ✅ CHỐT v1.3 — BẮT BUỘC council ① cho MỌI mission** (giữ nguyên nguồn).
- **[Q6] M2 cần Part 0 "Setup & Baseline": ✅ CHỐT v1.3 — CÓ — thêm Part 0 "Setup & Baseline"** cho mission M2 multi-part (≥ 2 parts hoặc tier ≥ T2): khởi Workspace + snapshot baseline từ logs + chốt số liệu so sánh; mission 1-part T1 bỏ (amend nguồn — A4).
- **[Q7] Ai được đề xuất tách/gộp part ngoài KING: ✅ CHỐT v1.3 — KING độc quyền quyết tách/gộp**; SIVIL (council ①) và LISMA (verify) chỉ FLAG đề xuất qua worklog.

---

## PHỤ LỤC A — TRACEABILITY MATRIX

| Section nguồn (dòng) | Nội dung nguồn | Section TB-07 | Mức |
|---|---|---|---|
| 2072–2120 (TRIAGE) | điểm complexity + tier per part | §1.1, §2.4 | SRC |
| 2091–2100 | điểm từng part House Prices | §2.4, §4.2 | SRC |
| 2122–2167 (Nhiệm vụ 3) | DECOMPOSE 6 parts House Prices | §4.1 | SRC |
| 2169–2190 | DECOMPOSE M2 — 4 Parts | §5.1 | SRC |
| 2195–2214 (Nhiệm vụ 4) | ASSIGN workflow từng part | §4.3 | SRC |
| 2220–2254 | task_complex_part2.md (M1) | §3.1, §3.3 | SRC |
| 2259–2288 | task_m2_part1.md (M2) | §3.1, §3.4 | SRC |
| 2345–2441 (DECIDE) | nâng/hạ/pivot giữa chừng | §8.2 | SRC-trigger |
| 2536–2541 | Council ① sau DECOMPOSE | §2.5, §8.1 | SRC |
| 2555–2581 | Tier escalation matrix | §8.2, §9 (E8) | SRC-trigger |
| 2639–2686 (7-nhiệm-vụ box) | nhánh DECOMPOSE nhiệm vụ 3 | §1.1, §2.0 | SRC |
| 2682 (Decision log) | mọi quyết định + lý do | §8.2 note | SRC |
| 2709–2748 | Research vs Code decomposition | §1.2 | SRC |
| 2750–2795 | 3 lý do | §1.3 | SRC |
| 2797–2918 | Research Protocol 5 lớp | §2.2, §2.3, §3.1 | SRC |
| 2921–3049 | ví dụ House Prices protocol | §2.1–2.3, §3.3 | SRC |
| 3051–3103 | Code spec vs Research spec | §3.1, §3.3 | SRC |
| 3105–3135 | Deep Analysis ✅/❌ + 4 nguyên tắc | §1.4 | SRC |
| 3138–3149 | bảng tóm tắt TL | §1.5 | SRC |
| 3151–3170 | so sánh kết quả 2 cách tiếp cận (XGB 0.122 / LGBM 0.123 / CatBoost 0.125) | §1.2, §1.3 | SRC |
| 3176–3190 | task đơn giản không decompose (Tier 1) | §1.1, §9 (E5) | SRC |
| 543–556 (Module Map) | 8 module + đọc gì | §5.2 | SRC |
| 558–601 | nguồn được phép đọc + Findings Schema | §3.4, §5.2 | SRC |
| 561–591 | ví dụ Decompose M2 4 branch | §5.4 | SRC |
| 1748–1772 | Research Council ① + output | §2.5, §8.2 | SRC |
| 1809–1811 | KB entries thật (Neo4j/key 401/4 branch) | §3.4 KB refs | SRC |
| 4428–4449 | ví dụ M2 chat 121s — TRIAGE + 4 parts | §3.4, §5.3 (R2) | SRC |
| 4452–4489 | Phase 1 audit M2 (6 SAs + root causes) | §3.4 | SRC |
| 4491–4511 | Phase 2 Proposal → SELF-DIRECTION | §5.1, §5.5 | SRC |
| — (TB-00 §4–5) | template + traceability | toàn file | EXT |
| — (TB-02/TB-03/TB-06) | tier map, trần SA, ASSIGN/DECIDE | §0, §5.3, §8 | EXT |
| — (thiết kế mới) | Group nhận, Evidence Sources, KB refs, checklist 12, anti-patterns 8, state machine 4 trạng thái, quy tắc R1–R5 | §3.2, §5.3, §6, §7, §8 | EXT |

---

> 🔒 **Kết thúc TB-07.** File này là playbook nhiệm vụ 3 DECOMPOSE của KING — được sử dụng kèm TB-06 (7 nhiệm vụ tổng quan) và TB-03 (SIVIL tiêu thụ task .md). Mọi thay đổi thiết kế: cập nhật nguồn `ai-team-workflow.md` TRƯỚC, blueprint SAU (quy tắc số 1).
