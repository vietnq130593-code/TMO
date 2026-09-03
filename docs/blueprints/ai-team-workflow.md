# AI Research Team — Workflow Architecture

> ⚠️ **ĐÂY LÀ RESEARCH TEAM VỚI DUAL MISSION:**
> - **M1 — Kaggle Research:** Kaggle competitions, dataset creation & documentation.
> - **M2 — System Research:** Nghiên cứu hệ thống TMO — kiến trúc bộ nhớ, quy trình thực thi, quy trình tư duy, tools, agents roster, UI/UX, performance. Mọi đề xuất nâng cấp được tổng hợp thành **PROPOSAL** và gửi thẳng vào module **SELF-DIRECTION** của TMO.
>
> TL = Research Director (NEMESIS), không phải Software Architect.
> Spec = Research Protocol (hypotheses + experimental design), không phải Implementation Spec (class diagram + API).
> Team được đọc code + docs + logs để NGHIÊN CỨU và ĐỀ XUẤT — **không trực tiếp sửa Live System đang chạy** (mọi chỉnh sửa + POC thực hiện trong **Workspace** — bản clone của hệ thống).
> Team là **lực lượng tri thức**: phát hiện/nghiên cứu hay mà Knowledge Base chưa có → ghi thẳng vào KB NGAY trong quá trình vận hành (xem section KNOWLEDGE CAPTURE).
>
> ⚠️ **MÔI TRƯỜNG LÀM VIỆC M2 — LIVE SYSTEM & WORKSPACE:**
> - **Live System:** TMO đang chạy thật trên local. Agents chỉ được **ĐỌC** (code, docs, logs, health, config) làm evidence — không sửa khi hệ thống đang chạy.
> - **Workspace:** Khi user muốn rà soát / chỉnh sửa / nâng cấp hệ thống, user mở **1 workspace = 1 thư mục clone của hệ thống**. Agents nghiên cứu, chỉnh sửa, viết POC, chạy thử — tất cả trong workspace này.
> - **Áp dụng:** Thay đổi từ Workspace chỉ được áp lên Live System sau khi Proposal được APPROVED trong SELF-DIRECTION (user hoặc agent được ủy quyền thực hiện).

---

## 🔄 ROSTER — 5 AGENTS, 2 MISSIONS

> **QUY TẮC QUAN TRỌNG:** Tên agent ≠ tên model. NEMESIS, SIVIL, BELI, LISMA, HAN là các **vai trò được thiết kế bằng Job Description + Instructions**. Tất cả agents chạy trên cùng một model stack (xem phần dưới). Phân vai theo ROLE, không theo model.

| Agent | Vị trí | Vai trò M1 — Kaggle | Nhiệm vụ M2 — System Research |
|---|---|---|---|
| **NEMESIS** | TL (Team Leader) | **Tư duy & Điều phối** — Research Director: nhận request, phân tích complexity, phá vỡ bài toán thành parts, viết .md mô tả, chọn workflow tier, kiểm tra kết quả | Phân loại mission M1/M2, điều phối audit hệ thống, tổng hợp & route Proposal vào SELF-DIRECTION |
| **SIVIL** | G1 Sub-Orchestrator | **Điều phối sub-agents** — parallel exploration & multi-approach discovery | Dispatch sub-agents đọc song song từng module TMO (memory, execution, thinking, tools, UI, services) |
| **BELI** | G1 Coder | **Code lượt đầu** — sinh code nhanh, chính xác, đúng spec ở lần đầu | Viết research report + POC code minh họa proposal (làm trong Workspace — bản clone, không đụng Live System) |
| **LISMA** | G2 Bug Fixer | **Review code, tìm bug, fix bug** — vòng lặp iteration đến khi sạch bug | **System Diagnostician** — truy vết root cause từ logs + code, review integration giữa các dịch vụ |
| **HAN** | G3 Optimizer | **Tối ưu hóa** — tuning, feature selection, ensemble, self-evolving | **Architecture Proposer** — đề xuất nâng cấp bộ nhớ / quy trình thực thi / quy trình tư duy + tối ưu performance |

> **Knowledge Capture:** NEMESIS, SIVIL, HAN đều ghi trực tiếp vào Knowledge Base khi phát hiện tri thức mới; BELI/LISMA đề xuất qua worklog — xem section KNOWLEDGE CAPTURE.

---

## 🧠 MODEL STACK THỐNG NHẤT — MỘT BỘ NÃO, NĂM ĐỊNH DẠNG

```
Tất cả 5 agents đều chạy trên cùng 1 model stack:

  ┌─────────────────────────────────────────────┐
  │  MODEL STACK (áp dụng cho MỌI agent)         │
  │                                              │
  │  Model chính:   Kimi-k3                      │
  │  Fallback 1:    DeepSeek v4 Pro              │
  │  Fallback 2:    DeepSeek v4 Flash            │
  │  Fallback 3:    MiniMax-M3                   │
  └─────────────────────────────────────────────┘

  NEMESIS ──┐
  SIVIL ─┤
  BELI ──┼──▶ cùng model stack, khác JD + Instructions
  LISMA ─┤
  HAN ───┘
```

**Nguyên tắc thiết kế:**

| Nguyên tắc | Ý nghĩa |
|---|---|
| **Same brain, different briefing** | Khác biệt giữa các agent đến từ **JD + Instructions**, không phải từ model. NEMESIS không "thông minh hơn" LISMA — NEMESIS được BRIEF khác LISMA |
| **Role-based, không model-based** | Không còn cơ chế "model X nghĩ, model Y viết". Tách vai trò SIVIL (điều phối) / BELI (thực thi) là trách nhiệm của vị trí trong pipeline, không phụ thuộc model |
| **Fallback chain** | Model chính lỗi/quá tải → tự chuyển fallback theo thứ tự: DeepSeek v4 Pro → DeepSeek v4 Flash → MiniMax-M3. Agent GIỮ NGUYÊN vai trò và JD khi đổi model |
| **Sub-agents dùng chung stack** | Sub-agents của SIVIL spawn từ cùng model stack — parallel exploration là năng lực của cơ chế orchestration, không phụ thuộc 1 model duy nhất |

**Vì sao thiết kế này hợp lý:**
1. **Không phụ thuộc 1 model duy nhất** — model chính chết vẫn chạy được (fallback tự động)
2. **JD là nguồn thật của chất lượng** — muốn agent làm tốt thì viết Instructions tốt, không phải đổi model
3. **Đồng nhất context behavior** — cả team hiểu prompt format/tool usage giống nhau, handoff mượt hơn

---

## 🖥️ MÔI TRƯỜNG LÀM VIỆC M2 — LIVE SYSTEM & WORKSPACE

Hệ thống TMO **không chạy trong sandbox** — nó chạy thật trên local (PM2 duy trì). Vì vậy mission M2 tách thành 2 vùng làm việc, tách bạch quyền hạn:

```
┌─────────────────────────────────────────────────────────────────┐
│  M2 — HAI VÙNG LÀM VIỆC TÁCH BIỆT                                 │
│                                                                    │
│  ┌───────────────────────────┐    ┌─────────────────────────────┐ │
│  │ LIVE SYSTEM (đang chạy)  │    │ WORKSPACE (bản clone)       │ │
│  │ • TMO chạy local qua PM2 │    │ • Thư mục clone hệ thống    │ │
│  │ • Agents: CHỈ ĐỌC        │    │ • User mở khi cần rà soát / │ │
│  │   code, docs, logs,      │    │   chỉnh sửa / nâng cấp      │ │
│  │   health, config →       │    │ • Agents: NGHIÊN CỨU +      │ │
│  │   nguồn evidence         │    │   CHỈNH SỬA + POC + test    │ │
│  └───────────────────────────┘    └─────────────────────────────┘ │
│                                                                    │
│  LIVE (đọc evidence) ──▶ nghiên cứu & sửa trong WORKSPACE ──▶     │
│  PROPOSAL ──▶ SELF-DIRECTION ──▶ [APPROVED] ──▶ áp từ WORKSPACE   │
│  lên LIVE SYSTEM ──▶ verify theo Verification Plan                │
└─────────────────────────────────────────────────────────────────┘
```

| Vùng | Agents ĐƯỢC | Agents KHÔNG |
|------|-------------|--------------|
| **Live System** | Đọc code/docs/logs/health/config; đo đạc (latency, counts, token) | Sửa file, đổi config, restart service khi chưa được duyệt |
| **Workspace (clone)** | Nghiên cứu, chỉnh sửa code, viết POC, chạy thử, đo thủ công | Coi thay đổi trong workspace là "đã xong" — mọi thay đổi phải đi qua Proposal |
| **Apply (sau APPROVED)** | User hoặc agent ủy quyền áp diff từ Workspace lên Live System, restart nếu cần | Áp khi Proposal chưa được APPROVED |

**Quy ước:**
- Workspace do **user mở** (1 workspace = 1 thư mục clone của hệ thống) — agents không tự clone, không tự áp lên Live System.
- Evidence luôn lấy từ **Live System** (logs thật, health thật, số liệu thật); code có thể đọc từ Workspace (bản đồng bộ) hoặc Live.
- POC/diff/thay đổi trong Workspace là **tài sản của Proposal** — kèm theo khi SUBMITTED vào SELF-DIRECTION.

---

## 🏗️ KIẾN TRÚC TEAM — ÁNH XẠ VÀO TL/G1/G2/G3

```
                        ┌──────────────┐
                        │   REQUEST    │
                        └──────┬───────┘
                               │
                    ┌──────────▼──────────┐
                    │  NEMESIS — CLASSIFY    │
                    │  M1 Kaggle | M2 Sys │
                    └──────────┬──────────┘
                               │
┌──────────────────────────────▼──────────────────────────────┐
│                       NEMESIS (TL)                              │
│  • Nhận request, phân loại mission, phân tích complexity    │
│  • Phá vỡ bài toán thành parts                              │
│  • Viết .md mô tả cho từng part                             │
│  • Chọn workflow tier (Simple/Medium/Complex)               │
│  • Kiểm tra kết quả, đánh dấu tiến độ                       │
└──────────────┬──────────────────────────────────────────────┘
               │
       ┌───────┴───────┐
       ▼               │
┌──────────────┐       │
│  G1 EXECUTE  │       │
│              │       │  SIVIL điều phối sub-agents
│ SIVIL        │       │  (5–300) explore song song
│ (Lead)       │       │
│              │       │  BELI code lượt đầu / viết report
│ BELI         │       │  cho từng approach được chọn
│ (Coder)      │       │
└──────┬───────┘       │
       │               │
       ▼               │
┌──────────────┐       │
│  G2 REVIEW   │       │
│              │       │  LISMA review code, tìm bug, fix bug
│ LISMA        │       │  (M2: chẩn đoán root cause hệ thống)
│ (Bug Fixer)  │       │  Vòng lặp iteration nhanh
└──────┬───────┘       │
       │               │
       ▼               │
┌──────────────┐       │
│  G3 OPTIMIZE │       │
│              │       │  HAN tối ưu model, tuning, ensemble
│ HAN          │       │  (M2: đề xuất kiến trúc + performance)
│ (Optimizer)  │       │  Self-evolving qua Knowledge Base
└──────┬───────┘       │
       │               │
       └───────────────┘
        ← Về NEMESIS kiểm tra (Checkpoints)

  OUTPUT THEO MISSION:
  ├── M1: Submission / Dataset / Documentation → User
  └── M2: PROPOSAL → SELF-DIRECTION (chờ user hoặc
           agent được ủy quyền phê duyệt)
           Mọi chỉnh sửa M2 làm trong WORKSPACE (bản
           clone) — áp lên LIVE SYSTEM sau APPROVED
```

---

## ⚙️ CHI TIẾT G1 — CƠ CHẾ PHỐI HỢP SIVIL + BELI

### 📋 JOB DESCRIPTION — SIVIL (G1 Sub-Orchestrator)

**Sứ mệnh (Dual Mission):**
- M1: Đầu tầu exploration — biến 1 task nghiên cứu thành N hướng đi song song
- M2: Điều phối việc đọc/audit song song từng module hệ thống TMO

**Trách nhiệm chính:**
- DECOMPOSE task từ TL thành N sub-problems → N sub-agent specs
- DISPATCH sub-agents (chọn chiến lược Sequential / Parallel / Hybrid)
- SYNTHESIZE kết quả: đánh giá, loại trùng lặp, rank top-K approaches
- Tạo spec chi tiết cho BELI
- Review output của BELI (không sửa code)
- RESEARCH COUNCIL: thảo luận với NEMESIS tại 4 thời điểm cố định — challenge hypotheses, đối chiếu findings với KB
- KNOWLEDGE CAPTURE: khi SYNTHESIZE phát hiện insight mà KB chưa có → ghi NGAY theo KB Write Protocol

**Deliverables:** Sub-agent plan → Synthesis report → Specs cho BELI → G1 worklog (kèm Artifact Map) + KB entries mới (insight từ synthesis)

### 📜 INSTRUCTIONS — SIVIL

- **LUÔN:** đọc Artifact Map trước khi dispatch; ghi Artifact Map khi hoàn thành; chọn số sub-agents đúng theo task (không dùng max cho mọi task); tham gia Research Council với NEMESIS (nhất là sau SYNTHESIZE); insight mới chưa có trong KB → ghi ngay theo KB Write Protocol
- **KHÔNG BAO GIỜ:** tự code; quyết định "approach nào win" khi thiếu data; bỏ qua kết quả sub-agent mâu thuẫn nhau mà không điều tra
- **Input contract:** task.md từ TL + Artifact Map từ Group trước
- **Output contract:** specs (priority rõ ràng) + worklog + issues cho LISMA
- **ESCALATE lên TL khi:** hypotheses của TL không thể decompose / sub-agents trả kết quả mâu thuẫn không giải thích được
- **Signature move:** parallel exploration — 5–300 sub-agents tùy độ phức tạp

### 📋 JOB DESCRIPTION — BELI (G1 Coder)

**Sứ mệnh (Dual Mission):**
- M1: Code lượt đầu theo spec — nhanh, structure tốt, follow spec chính xác
- M2: Viết research report + POC code minh họa proposal (làm trong Workspace — bản clone của hệ thống)

**Trách nhiệm chính:**
- IMPLEMENT từng spec của SIVIL (code hoặc report/POC)
- Ghi notes về edge cases gặp phải
- Đưa suggestions cho G2 (LISMA)
- KHÔNG tự ý đổi approach — có ý tưởng thì đề xuất ngược lại SIVIL

**Deliverables:** Code files (M1) / Research report + POC (M2) + Notes + Suggestions

### 📜 INSTRUCTIONS — BELI

- **LUÔN:** code đúng spec; ghi chú mọi edge case; submit draft kèm notes + suggestions
- **KHÔNG BAO GIỜ:** sửa code của agent khác; tự ý đổi approach đã được SYNTHESIZE chọn; (M2) đụng tới Live System đang chạy — mọi chỉnh sửa + POC chỉ thực hiện trong Workspace (bản clone của hệ thống)
- **Input contract:** specs từ SIVIL + Artifact Map
- **Output contract:** draft + notes + suggestions → chuyển LISMA
- **ESCALATE (qua SIVIL) khi:** spec mâu thuẫn / không thể implement đúng spec
- **Signature move:** first-pass accuracy — draft tốt ngay lần đầu (LISMA sẽ lo phần sạch bug)

### Nguyên tắc cốt lõi: "SIVIL điều phối, BELI thực thi"

SIVIL **không code** — SIVIL chỉ phân tích, lập kế hoạch, điều phối. BELI **chỉ code/viết report** — nhận spec và implement. Hai vai trò hoàn toàn tách biệt. Sự tách biệt này đến từ **định dạng công việc (JD)**, không phải từ việc hai agent dùng model khác nhau — cả hai đều chạy trên cùng model stack.

```
┌─────────────────────────────────────────────────┐
│              G1 — EXECUTE GROUP                  │
│                                                  │
│  ┌─────────────────┐     ┌─────────────────┐    │
│  │     SIVIL       │     │      BELI       │    │
│  │  (Orchestrator) │────▶│    (Coder)      │    │
│  │                 │     │                 │    │
│  │  • Phân tích    │     │  • Nhận spec    │    │
│  │  • Lập kế hoạch │     │  • Code / viết  │    │
│  │  • Điều phối    │     │    report theo  │    │
│  │  • Tổng hợp     │     │    spec         │    │
│  │  • Chọn lọc     │     │  • Submit draft │    │
│  └────────┬────────┘     └────────┬────────┘    │
│           │                       │              │
│           │   ◀── Feedback ───────┘              │
│           │   "Code X chạy chậm,                 │
│           │    cần approach khác"                 │
│           ▼                                      │
│     Điều chỉnh kế hoạch                          │
│     Dispatch lại sub-agents                      │
└─────────────────────────────────────────────────┘
```

### Quy trình 5 bước trong G1:

#### Bước 1: SIVIL nhận task từ TL

```
TL (NEMESIS) gửi task_complex_part1.md:
  "Part 1: EDA & Feature Understanding cho House Prices dataset"

SIVIL phân tích:
  - Dataset có 79 features (mix numeric + categorical)
  - Có missing values
  - Cần hiểu distribution, correlation, outliers
  → Chia thành 5 sub-tasks song song
```

#### Bước 2: SIVIL dispatch sub-agents (xem chi tiết phần Sub-agents bên dưới)

Kết quả sau khi sub-agents hoàn thành:
```
Sub-agent 1: "Missing value: 19 features có NaN,
             PoolQC 99% missing → nên drop"
Sub-agent 2: "GrLivArea có 2 outliers > 4000 sqft"
Sub-agent 3: "OverallQual correlation với SalePrice = 0.79"
Sub-agent 4: "Neighborhood: 25 categories,
             nên dùng target encoding"
Sub-agent 5: "TotalBsmtSF có right skew → log transform"
...
(từ 5-20 sub-agents có kết quả hữu ích)
```

#### Bước 3: SIVIL tổng hợp & chọn lọc

```
SIVIL tổng hợp từ tất cả sub-agents:
  → Lọc ra top-K approaches (K = 3-5)
  → Sắp xếp theo priority
  → Tạo spec chi tiết cho BELI

SIVIL gửi cho BELI:
┌─────────────────────────────────────────┐
│ SPEC #1: Missing Value Handling         │
│ Priority: HIGH                           │
│ Approach: Drop columns >80% missing,    │
│           median impute numeric,        │
│           mode impute categorical        │
│ Expected output: clean dataframe        │
│ File: src/preprocessing/missing.py      │
│                                         │
│ SPEC #2: Outlier Removal                │
│ Priority: HIGH                          │
│ Approach: Remove GrLivArea > 4000       │
│           + IQR method cho numeric      │
│ Expected output: filtered dataframe     │
│ File: src/preprocessing/outliers.py     │
│                                         │
│ SPEC #3: Feature Transform              │
│ Priority: MEDIUM                        │
│ Approach: Log transform skewed numeric, │
│           target encode categorical     │
│ Expected output: transformed features   │
│ File: src/preprocessing/transform.py    │
└─────────────────────────────────────────┘
```

#### Bước 4: BELI code theo từng spec

```
BELI nhận SPEC #1 → code missing.py
BELI nhận SPEC #2 → code outliers.py
BELI nhận SPEC #3 → code transform.py

Có thể code tuần tự hoặc song song
(tùy khả năng của infrastructure)

BELI gửi lại:
  - Code files
  - Notes: "Transform.py: Log(0) edge case cần xử lý"
  - Suggestions: "Nên thêm Yeo-Johnson thay vì log transform"
```

#### Bước 5: SIVIL review code + tổng hợp output G1

```
SIVIL (không sửa code, chỉ đánh giá):
  ✅ missing.py — đúng spec, pass
  ✅ outliers.py — đúng spec, pass
  ⚠️ transform.py — Log(0) issue, ghi chú
     vào worklog cho G2 fix

SIVIL tổng hợp:
  → G1 Output: 3 code files + worklog + suggestions
  → Giao cho G2 (LISMA)
```

### Cơ chế Sub-agents của SIVIL (5–300 sub-agents)

SIVIL chạy trên model stack (Kimi-k3 chính) với **agent framework** — khả năng spawn sub-agents. Mỗi sub-agent là một instance độc lập có:
- Context riêng (nhận 1 phần task)
- Công cụ riêng (code execution, web search, file read/write)
- Khả năng trả kết quả về cho SIVIL chính

#### Số lượng sub-agents theo loại task:

| Loại task | Số sub-agents | Chiến lược |
|-----------|--------------|------------|
| EDA (1 dataset) | 5-10 | Mỗi SA explore 1 khía cạnh |
| Feature Engineering | 10-20 | Mỗi SA thử 1 loại feature |
| Model Selection | 15-30 | Mỗi SA thử 1 model/config |
| Full Pipeline | 30-50 | Chia theo phase, mỗi phase có SA riêng |
| Research Paper | 50-100 | SA cho mỗi section + SA cho experiments |
| Grand Competition | 100-300 | Multi-phase, multi-approach, multi-experiment |
| System Audit M2 (1 module map) | 5-15 | Mỗi SA đọc 1 module/lớp hệ thống |

#### 3 Giai đoạn hoạt động: DECOMPOSE → DISPATCH → SYNTHESIZE

```
┌──────────────────────────────────────────────────────────┐
│                SIVIL — ORCHESTRATOR                       │
│                                                           │
│  Giai đoạn 1: DECOMPOSE                                  │
│  ┌─────────────────────────────────────────────────┐      │
│  │ Nhận task từ TL                                  │      │
│  │ → Phân tích thành N sub-problems                 │      │
│  │ → Mỗi sub-problem thành 1 sub-agent spec         │      │
│  └─────────────────────────────────────────────────┘      │
│                         │                                  │
│                         ▼                                  │
│  Giai đoạn 2: DISPATCH                                   │
│  ┌─────────────────────────────────────────────────┐      │
│  │                                                   │      │
│  │  ┌─────┐ ┌─────┐ ┌─────┐     ┌─────┐           │      │
│  │  │SA-01│ │SA-02│ │SA-03│ ... │SA-N │           │      │
│  │  │     │ │     │ │     │     │     │           │      │
│  │  │Explore│ │Explore│ │Explore│   │Explore│       │      │
│  │  │App A │ │App B │ │App C │     │App N │       │      │
│  │  └──┬──┘ └──┬──┘ └──┬──┘     └──┬──┘           │      │
│  │     │       │       │           │               │      │
│  │     ▼       ▼       ▼           ▼               │      │
│  │  [Kết quả song song — chạy đồng thời]            │      │
│  │                                                   │      │
│  └─────────────────────────────────────────────────┘      │
│                         │                                  │
│                         ▼                                  │
│  Giai đoạn 3: SYNTHESIZE                                 │
│  ┌─────────────────────────────────────────────────┐      │
│  │ Thu thập kết quả từ tất cả sub-agents            │      │
│  │ → Đánh giá chất lượng từng approach              │      │
│  │ → Loại approaches yếu / trùng lặp                │      │
│  │ → Rank top-K approaches                          │      │
│  │ → Tạo spec cho BELI                              │      │
│  └─────────────────────────────────────────────────┘      │
│                                                           │
└──────────────────────────────────────────────────────────┘
```

#### Ví dụ Decompose cho House Prices Competition:

```
Task: "Xây dựng ML pipeline cho House Prices competition"

SIVIL Decompose:
│
├── Branch A: Data Understanding (5 SAs)
│   ├── SA-01: Missing value patterns
│   ├── SA-02: Distribution analysis
│   ├── SA-03: Correlation analysis
│   ├── SA-04: Outlier detection
│   └── SA-05: Categorical analysis
│
├── Branch B: Feature Engineering (10 SAs)
│   ├── SA-06: Polynomial features
│   ├── SA-07: Log transforms
│   ├── SA-08: Target encoding
│   ├── SA-09: Frequency encoding
│   ├── SA-10: Interaction features (numeric × numeric)
│   ├── SA-11: Interaction features (numeric × categorical)
│   ├── SA-12: Binning strategies
│   ├── SA-13: Aggregation features
│   ├── SA-14: Time-based features
│   └── SA-15: Domain-specific features
│
├── Branch C: Model Exploration (15 SAs)
│   ├── SA-16: Linear Regression baseline
│   ├── SA-17: Ridge Regression
│   ├── SA-18: Lasso Regression
│   ├── SA-19: ElasticNet
│   ├── SA-20: XGBoost (default)
│   ├── SA-21: XGBoost (tuned)
│   ├── SA-22: LightGBM (default)
│   ├── SA-23: LightGBM (tuned)
│   ├── SA-24: CatBoost (default)
│   ├── SA-25: CatBoost (tuned)
│   ├── SA-26: Random Forest
│   ├── SA-27: Extra Trees
│   ├── SA-28: SVR
│   ├── SA-29: KNN Regressor
│   └── SA-30: Neural Net (MLP)
│
└── Branch D: Ensemble Strategies (5 SAs)
    ├── SA-31: Simple averaging
    ├── SA-32: Weighted averaging
    ├── SA-33: Stacking (Linear meta)
    ├── SA-34: Stacking (XGB meta)
    └── SA-35: Blending
```

#### 3 Chiến lược DISPATCH:

**Chiến lược 1: Sequential Batches (an toàn, có phụ thuộc)**
```
Branch A → chờ xong → Branch B → chờ xong → Branch C → chờ xong → Branch D
```
- Ưu: Kết quả Branch trước làm input cho Branch sau → chính xác hơn
- Nhược: Chậm hơn

**Chiến lược 2: Parallel Waves (nhanh, không phụ thuộc)**
```
Wave 1: Tất cả 35 SAs chạy cùng lúc
Wave 2: SIVIL tổng hợp → Điều chỉnh → Wave 2 SAs
```
- Ưu: Nhanh nhất
- Nhược: Branch sau không tận dụng được kết quả Branch trước

**Chiến lược 3: Hybrid (tối ưu — recommended)**
```
Batch 1: Branch A + B chạy song song (độc lập nhau)
          → A: data understanding
          → B: thử NHIỀU loại features (không cần insights từ A)

Batch 2: Branch C (dựa trên B's features + A's insights)
          → Chạy models trên top features

Batch 3: Branch D (dựa trên C's models)
          → Ensemble top models
```

#### Ví dụ Synthesize — Tổng hợp kết quả:

```
SIVIL nhận kết quả từ 35 sub-agents:

┌─────────────────────────────────────────────────────────┐
│  BẢNG KẾT QUẢ SUB-AGENTS                                │
│                                                          │
│  Branch A (Data):                                        │
│    SA-01: ✅ 19 features có missing, top insight         │
│    SA-02: ✅ 6 numeric features bị skew                  │
│    SA-03: ✅ Top 10 correlations found                   │
│    SA-04: ✅ 4 outliers detected                         │
│    SA-05: ✅ 25 categorical, high cardinality issues     │
│                                                          │
│  Branch B (Features):                                    │
│    SA-06: ✅ Polynomial degree 2 - CV 0.128             │
│    SA-07: ✅ Log transform - CV 0.131                   │
│    SA-08: ✅ Target encoding - CV 0.125  ← BEST         │
│    SA-09: ⚠️ Frequency encoding - CV 0.134             │
│    SA-10: ✅ Interaction GrLivArea×Qual - CV 0.126      │
│    SA-11: ❌ cat×num interaction - overfitting            │
│    SA-12: ✅ Binning YearBuilt - CV 0.130               │
│    SA-13: ❌ Aggregation - no improvement                │
│    SA-14: ⚠️ Time features - marginal improvement       │
│    SA-15: ✅ Domain features (TotalSF) - CV 0.127       │
│                                                          │
│  Branch C (Models):                                      │
│    SA-16: ❌ Linear Reg - CV 0.165 (too weak)            │
│    SA-17: ✅ Ridge - CV 0.132                           │
│    SA-18: ✅ Lasso - CV 0.135 + feature selection        │
│    SA-20: ✅ XGBoost default - CV 0.128                 │
│    SA-21: ✅ XGBoost tuned - CV 0.122  ← BEST           │
│    SA-22: ✅ LightGBM default - CV 0.126                │
│    SA-23: ✅ LightGBM tuned - CV 0.123  ← 2nd BEST     │
│    SA-24: ✅ CatBoost default - CV 0.129                │
│    SA-25: ✅ CatBoost tuned - CV 0.125                  │
│    ... (others omitted)                                  │
│                                                          │
│  Branch D (Ensemble):                                    │
│    SA-31: ✅ Simple avg - CV 0.121                      │
│    SA-32: ✅ Weighted avg - CV 0.119                    │
│    SA-33: ✅ Stacking Linear - CV 0.118  ← BEST         │
│    SA-34: ⚠️ Stacking XGB - CV 0.120 (overfit risk)    │
│    SA-35: ✅ Blending - CV 0.119                        │
└─────────────────────────────────────────────────────────┘

SIVIL tổng hợp:
  → Top 3 approaches:
    1. Stacking (LGBM + XGB + CatBoost) + Target Encoding + Domain Features
    2. Weighted Average + All top features
    3. Single XGBoost tuned + Target Encoding

  → Tạo 3 specs cho BELI code chi tiết
  → Ghi worklog với insights + recommendations
  → Giao cho BELI
```

### 🖥️ Mode M2 — System Research: Dispatch theo Module Map

Khi mission là M2 (System Research TMO), SIVIL không decompose theo "approach" mà decompose theo **Module Map** — mỗi sub-agent phụ trách 1 module của hệ thống:

| Sub-agent | Module | Đọc gì |
|---|---|---|
| SA-01 | Memory Architecture | Source memory system — Qdrant / Neo4j / SQLite coordination, embedding pipeline |
| SA-02 | Execution Pipeline | API routes, query pipeline, workflow thực thi |
| SA-03 | Thinking Process | Agent instructions, reasoning strategy, research protocol |
| SA-04 | Tools & Agents Roster | MCP tools, agent configs, model-to-role mapping |
| SA-05 | UI/UX | App pages, components, UX flow |
| SA-06 | Services Integration | R2, Supabase, Neo4j, Qdrant, LLM key pool |
| SA-07 | Performance | dev.log, PM2 logs, latency measurements, token usage |
| SA-08 | Config & Deployment | .env, ecosystem config, health check |

**Nguồn được phép đọc (M2):** source code, README, docs, .env.example, dev.log, PM2 logs, health check API.
**KHÔNG được phép:** sửa bất kỳ file nào của TMO — mọi thay đổi chỉ nằm trong PROPOSAL.

#### Ví dụ Decompose M2 — "Nghiên cứu kiến trúc bộ nhớ TMO":

```
Task: "Đề xuất nâng cấp kiến trúc bộ nhớ của TMO"

SIVIL Decompose:
│
├── Branch A: Hiện trạng (4 SAs)
│   ├── SA-01: Đọc memory system code — cấu trúc hiện tại
│   ├── SA-02: Đọc Qdrant collections + embedding pipeline
│   ├── SA-03: Đọc Neo4j graph schema + query patterns
│   └── SA-04: Đọc SQLite schema + agent memory
│
├── Branch B: Điểm yếu (4 SAs)
│   ├── SA-05: Log analysis — chỗ nào chậm / fail
│   ├── SA-06: Duplication — dữ liệu trùng lặp giữa các store
│   ├── SA-07: Coverage — cái gì chưa được lưu
│   └── SA-08: Consistency — sync giữa các store
│
├── Branch C: Pattern tham khảo (3 SAs)
│   ├── SA-09: Memory architecture patterns (RAG, graph-RAG...)
│   ├── SA-10: Multi-store coordination patterns
│   └── SA-11: Trade-offs từng pattern
│
└── Branch D: Feasibility (2 SAs)
    ├── SA-12: Ràng buộc hệ thống hiện tại (không phá tính đang chạy)
    └── SA-13: Effort ước tính từng option

→ SIVIL tổng hợp theo Findings Schema
→ BELI viết research report + POC minh họa (trong Workspace)
```

**Findings Schema — kết quả mỗi SA trả về (M2):**

```
| # | Finding | Evidence (file:line / log excerpt) | Severity | Cơ hội cải thiện |
|---|---------|-------------------------------------|----------|------------------|
| 1 | ...     | src/lib/xxx.ts:123                  | 🔴 HIGH  | ...              |
```

Mỗi finding BẮT BUỘC có evidence — không có evidence = không được ghi vào report (đây là cơ sở cho VERIFY của NEMESIS ở Checkpoint).

### Schema tổng hợp — G1 Internal Workflow:

```
TL (NEMESIS) gửi task.md
        │
        ▼
┌─── SIVIL (Orchestrator) ─────────────────────────────┐
│                                                       │
│  1. DECOMPOSE                                         │
│     Task → N sub-problems → N sub-agent specs         │
│     (M1: theo approach / M2: theo Module Map)         │
│                                                       │
│  2. DISPATCH                                          │
│     Chọn chiến lược (Sequential/Parallel/Hybrid)      │
│     → Spawn sub-agents theo batches                   │
│     → Mỗi SA: explore 1 approach/1 module độc lập     │
│     → Thu thập kết quả                                │
│                                                       │
│  3. SYNTHESIZE                                        │
│     → Đánh giá tất cả kết quả                         │
│     → Loại approaches yếu/trùng/overfit               │
│     → Rank top-K approaches                           │
│     → Tạo code spec chi tiết cho từng approach        │
│                                                       │
│  4. SYNC — RESEARCH COUNCIL (với NEMESIS)                │
│     → Challenge hypotheses trước khi code             │
│     → Đối chiếu findings với Knowledge Base           │
│     → Insight mới → ghi KB ngay (KB Write Protocol)   │
│                                                       │
└──────────────┬────────────────────────────────────────┘
               │ K specs
               ▼
┌─── BELI (Coder) ─────────────────────────────────────┐
│                                                       │
│  5. IMPLEMENT                                         │
│     Nhận spec #1 → Code → Submit                      │
│     Nhận spec #2 → Code → Submit                      │
│     Nhận spec #3 → Code → Submit                      │
│     (M2: viết research report + POC thay vì code)     │
│                                                       │
│     Mỗi spec:                                         │
│     - Code/Report đầy đủ theo spec                    │
│     - Notes về edge cases                             │
│     - Suggestions cho G2                              │
│                                                       │
└──────────────┬────────────────────────────────────────┘
               │ Code/Report files + worklog
               ▼
┌─── SIVIL (Review) ───────────────────────────────────┐
│                                                       │
│  6. VERIFY (không sửa code)                           │
│     → Check output có khớp spec không                 │
│     → Đánh giá completeness                           │
│     → Ghi chú issues cho G2                           │
│                                                       │
└──────────────┬────────────────────────────────────────┘
               │ G1 Output
               ▼
          G2 (LISMA)
```

### Tóm tắt cơ chế G1:

| Khía cạnh | Cơ chế |
|-----------|--------|
| **Phân chia vai trò** | SIVIL = Não điều phối (decompose/dispatch/synthesize), BELI = Tay thực thi (code/report theo spec) — tách theo ROLE, cùng model stack |
| **Sub-agents số lượng** | 5-300 tùy task complexity, không dùng max cho mọi task |
| **Chiến lược dispatch** | Hybrid: Batch song song theo branch, sequential giữa branches có phụ thuộc |
| **Tổng hợp** | SIVIL rank tất cả approaches, chọn top-K, tạo spec cho BELI |
| **Feedback loop** | BELI → SIVIL: code issues, suggestions → SIVIL điều chỉnh |
| **Research Council** | SIVIL sync với NEMESIS sau SYNTHESIZE (trước khi BELI code) — challenge hypotheses + chốt tri thức mới vào KB |
| **Mode M2** | Decompose theo Module Map; findings bắt buộc kèm evidence; POC chỉ chạy trong Workspace |
| **Output G1** | Code files / Report + worklog + issues cho G2 |

---

## 🔍 CHI TIẾT G2 — CƠ CHẾ FIX BUG & REVIEW CỦA LISMA

### 📋 JOB DESCRIPTION — LISMA (G2 Bug Fixer / System Diagnostician)

**Sứ mệnh (Dual Mission):**
- M1: Reviewer + Bug Fixer — đảm bảo code ĐÚNG (không bug, không leak)
- M2: System Diagnostician — chẩn đoán root cause hệ thống từ logs + code, đề xuất fix trong PROPOSAL

**Trách nhiệm chính:**
- READ code/artifacts theo Artifact Map
- DETECT bug/issues theo 5 loại (M1) hoặc 5 loại vấn đề hệ thống (M2)
- FIX (M1: sửa code submission / M2: chẩn đoán + đề xuất fix trong proposal)
- VERIFY: chạy lại, kiểm tra regression
- Lặp lại tối đa 3 vòng, ESCALATE khi không giải quyết được

**Deliverables:** Code sạch (M1) / Diagnostic Report (M2) + Worklog + Suggestions cho G3 + Concerns cho TL

### 📜 INSTRUCTIONS — LISMA

- **LUÔN:** đọc Artifact Map trước khi đọc code; fix theo severity (🔴 → 🟢); ghi lại regression bug do fix gây ra
- **KHÔNG BAO GIỜ:** apply fix trực tiếp lên Live System TMO (M2 — chỉ chẩn đoán, đề xuất trong Proposal; patch mẫu viết trong Workspace); bỏ qua data leakage (Priority #1 M1); bỏ qua System Safety (Priority #1 M2)
- **Input contract:** G1 output (code/report + worklog) + Artifact Map từ SIVIL/BELI
- **Output contract:** Verified output + worklog (bugs/diagnosis + suggestions + concerns) → HAN
- **ESCALATE lên TL khi:** architectural issue / quá 3 vòng vẫn còn bug / CRITICAL không fix được
- **Signature move:** iterative refinement loop — Đọc → Tìm → Sửa → Kiểm tra → Lặp lại đến khi sạch

### Tại sao vị trí G2 được thiết kế như vậy?

| Thiết kế vai trò | Lợi ích cho pipeline |
|---|---|
| **Reviewer + Fixer 2-trong-1** | Lập trình viên và reviewer là cùng 1 agent — tự tìm bug, tự sửa, tự verify. Không mất context khi handoff giữa người tìm bug và người sửa bug |
| **Iterative refinement loop** | Không cần fix đúng ngay lần đầu — mỗi vòng đọc lại phát hiện bug mới (kể cả regression do fix trước gây ra) |
| **Focus chi tiết, ngữ cảnh hẹp** | G2 chỉ cần đọc 1-3 files cùng lúc — tập trung tuyệt đối vào chi tiết, không phân tán vào bức tranh lớn (đã có NEMESIS lo) |

### Nguyên tắc cốt lõi: "Đọc → Tìm → Sửa → Kiểm tra → Lặp lại"

```
┌─────────────────────────────────────────────────────────┐
│                  G2 — REVIEW & FIX LOOP                  │
│                                                          │
│   ┌──────────┐    ┌──────────┐    ┌──────────┐         │
│   │  READ    │───▶│  DETECT  │───▶│   FIX    │         │
│   │ Đọc code │    │ Tìm bug  │    │ Sửa bug  │         │
│   └──────────┘    └──────────┘    └──────────┘         │
│        ▲                               │                │
│        │                               ▼                │
│   ┌──────────┐    ┌──────────┐    ┌──────────┐         │
│   │  PASS?   │◀──│  VERIFY  │◀──│ RE-TEST  │         │
│   │ Còn bug? │    │ Kiểm tra │    │ Chạy lại │         │
│   └──────────┘    └──────────┘    └──────────┘         │
│        │                                                 │
│        ├── YES → Quay lại READ (vòng mới)               │
│        └── NO  → OUTPUT: Code sạch + Worklog            │
└─────────────────────────────────────────────────────────┘
```

### 5 Loại bug LISMA tìm và sửa (Mode M1 — Kaggle):

#### Loại 1: Logic Bugs — Sai logic thuật toán

```
G1 Output (BELI code):
─────────────────────────────────────
def remove_outliers(df, column, threshold=3):
    z_scores = (df[column] - df[column].mean()) / df[column].std()
    return df[z_scores < threshold]  # ❌ Chỉ giữ bên dưới threshold
─────────────────────────────────────

LISMA Detect:
  "z_scores < threshold chỉ lọc outliers dương.
   Outliers âm (z < -3) vẫn còn."

LISMA Fix:
─────────────────────────────────────
def remove_outliers(df, column, threshold=3):
    z_scores = (df[column] - df[column].mean()) / df[column].std()
    return df[np.abs(z_scores) < threshold]  # ✅ Lọc cả 2 phía
─────────────────────────────────────

LISMA Verify: Tạo test case với outliers cả 2 phía → Pass ✅
```

#### Loại 2: Edge Cases — Trường hợp biên

```
G1 Output (BELI code):
─────────────────────────────────────
def log_transform(df, column):
    df[column + '_log'] = np.log(df[column])  # ❌ log(0) = -inf
─────────────────────────────────────

LISMA Detect:
  "np.log(0) trả về -inf, gây NaN khi train model.
   Cần xử lý 0 và giá trị âm."

LISMA Fix:
─────────────────────────────────────
def log_transform(df, column):
    min_val = df[column].min()
    if min_val <= 0:
        shift = abs(min_val) + 1
        df[column + '_log'] = np.log(df[column] + shift)
    else:
        df[column + '_log'] = np.log(df[column])
─────────────────────────────────────

LISMA Verify: Test với column chứa 0 và âm → Pass ✅
```

#### Loại 3: Data Leakage — Rò rỉ dữ liệu (nghiêm trọng nhất trong Kaggle!)

```
G1 Output (BELI code):
─────────────────────────────────────
# Preprocessing trước khi split
df['Neighborhood_enc'] = target_encode(df, 'Neighborhood', 'SalePrice')
df['GrLivArea_log'] = np.log(df['GrLivArea'])

train, test = train_test_split(df, test_size=0.2, random_state=42)
─────────────────────────────────────

LISMA Detect:
  "🚨 DATA LEAKAGE! Target encoding dùng toàn bộ dataset
   (kể cả test) để tính encoding. Test data leak vào train.
   Đây là bug NGHIÊM TRỌNG nhất trong Kaggle — sẽ bị
   overfitting ảo trên CV nhưng fail trên LB."

LISMA Fix:
─────────────────────────────────────
# Split TRƯỚC, transform SAU
train, test = train_test_split(df, test_size=0.2, random_state=42)

# Target encoding chỉ fit trên train, transform trên test
encoder = TargetEncoder()
train['Neighborhood_enc'] = encoder.fit_transform(
    train['Neighborhood'], train['SalePrice']
)
test['Neighborhood_enc'] = encoder.transform(
    test['Neighborhood']
)

# Log transform an toàn (không leak vì không dùng target)
train['GrLivArea_log'] = np.log(train['GrLivArea'])
test['GrLivArea_log'] = np.log(test['GrLivArea'])
─────────────────────────────────────

LISMA Verify:
  - Kiểm tra encoding chỉ dùng train data → Pass ✅
  - Kiểm tra CV score không inflated → Pass ✅
  - Thêm note worklog: "Data leakage risk — cần K-Fold encoding cho an toàn hơn"
```

#### Loại 4: Performance Issues — Code chạy chậm

```
G1 Output (BELI code):
─────────────────────────────────────
def create_all_features(df):
    for col in numeric_cols:
        df[col + '_log'] = np.log(df[col])        # ❌ Loop từng cột
        df[col + '_sq'] = df[col] ** 2             # ❌ Inefficient

    for col in categorical_cols:
        for other_col in numeric_cols:
            df[f'{col}_{other_col}_mean'] = df.groupby(col)[other_col].transform('mean')
    return df
─────────────────────────────────────

LISMA Detect:
  "Loop tuần tự chậm. Có thể vectorize.
   Ngoài ra groupby.transform trong nested loop
   rất chậm với nhiều features."

LISMA Fix:
─────────────────────────────────────
def create_all_features(df):
    # Vectorize log + square
    log_vals = np.log(df[numeric_cols].clip(lower=1e-10))
    df[[c + '_log' for c in numeric_cols]] = log_vals
    df[[c + '_sq' for c in numeric_cols]] = df[numeric_cols] ** 2

    # Batch aggregation thay vì nested loop
    for col in categorical_cols:
        agg = df.groupby(col)[numeric_cols].transform('mean')
        agg.columns = [f'{col}_{c}_mean' for c in numeric_cols]
        df = pd.concat([df, agg], axis=1)
    return df
─────────────────────────────────────

LISMA Verify: Benchmark trước/sau → 3x nhanh hơn → Pass ✅
```

#### Loại 5: API/Compatibility — Tương thích thư viện

```
G1 Output (BELI code):
─────────────────────────────────────
model = XGBRegressor(objective='reg:squarederror', tree_method='gpu_hist')
─────────────────────────────────────

LISMA Detect:
  "tree_method='gpu_hist' yêu cầu GPU.
   Kaggle notebooks thường chỉ có GPU trên GPU quota.
   Cần fallback cho CPU environment."

LISMA Fix:
─────────────────────────────────────
import torch

tree_method = 'gpu_hist' if torch.cuda.is_available() else 'hist'
model = XGBRegressor(
    objective='reg:squarederror',
    tree_method=tree_method
)
─────────────────────────────────────

LISMA Verify: Test trên cả GPU và CPU env → Pass ✅
```

### Vòng lặp Iteration — Cơ chế lặp đến khi sạch bug

```
Vòng 1: LISMA đọc G1 code
┌─────────────────────────────────────────────────────────┐
│ Input: 3 files từ G1 + worklog từ G1                    │
│                                                          │
│ LISMA đọc missing.py:   → Tìm 2 bugs (edge case + leak) │
│ LISMA đọc outliers.py:  → Tìm 1 bug (logic)             │
│ LISMA đọc transform.py: → Tìm 2 bugs (edge case + perf)│
│                                                          │
│ Tổng: 5 bugs tìm thấy                                   │
│ LISMA fix tất cả 5 bugs                                  │
│ LISMA verify từng fix → 4/5 pass, 1 cần sửa thêm        │
│                                                          │
│ Vòng 1 Output: Code đã fix 4 bugs + 1 bug còn lại       │
└─────────────────────────────────────────────────────────┘
         │
         ▼ Còn 1 bug → Vòng 2
┌─────────────────────────────────────────────────────────┐
│ Vòng 2: LISMA đọc lại code đã fix                       │
│                                                          │
│ LISMA đọc lại: → Fix bug còn lại (compatibility)        │
│            → Phát hiện 1 bug mới do fix vòng 1 gây ra   │
│              (regression bug)                            │
│                                                          │
│ LISMA fix regression bug                                 │
│ LISMA verify → Pass ✅                                   │
│                                                          │
│ Vòng 2 Output: Code sạch                                │
└─────────────────────────────────────────────────────────┘
         │
         ▼ Không còn bug → PASS
┌─────────────────────────────────────────────────────────┐
│ FINAL OUTPUT:                                            │
│   - 3 code files sạch (0 bugs)                          │
│   - Worklog với:                                        │
│     + 6 bugs đã fix (5 gốc + 1 regression)              │
│     + 2 suggestions cho G3                               │
│     + 1 concern cần TL xác nhận                          │
└─────────────────────────────────────────────────────────┘
```

### Giới hạn vòng lặp — Khi nào DỪNG iteration?

```
┌─────────────────────────────────────────────────────────┐
│          STOP CRITERIA cho G2 Loop                       │
│                                                          │
│  ✅ PASS: Không tìm thấy bug mới sau 1 vòng             │
│  ✅ PASS: Tối đa 3 vòng — nếu còn bug sau 3 vòng        │
│           → Báo lại TL (task có thể phức tạp hơn dự kiến)│
│  ✅ PASS: Bug còn lại được đánh giá LOW severity         │
│           → Ghi vào worklog cho G3 xử lý                 │
│  ⚠️ ESCALATE: Phát hiện architectural issue              │
│           (VD: data leakage fundamental, wrong approach)  │
│           → DỪNG → Báo TL → TL quyết định               │
└─────────────────────────────────────────────────────────┘
```

### Checklist G2 — LISMA review từng file theo template:

```markdown
## G2 Review Checklist — [File name]

### 1. Correctness
- [ ] Logic thuật toán đúng?
- [ ] Output khớp spec từ G1?
- [ ] Edge cases đã xử lý?

### 2. Data Safety (M1 — Quan trọng nhất cho Kaggle!)
- [ ] Không có data leakage?
- [ ] Fit/transform đúng thứ tự?
- [ ] Cross-validation đúng cách?
- [ ] No target leakage trong features?

### 3. Performance
- [ ] Không có unnecessary loops?
- [ ] Vectorized operations khi có thể?
- [ ] Memory efficient?

### 4. Compatibility
- [ ] Chạy được trên Kaggle env?
- [ ] GPU/CPU fallback?
- [ ] Dependency versions tương thích?

### 5. Readability
- [ ] Code dễ hiểu?
- [ ] Comments đủ?
- [ ] Naming conventions nhất quán?

### 6. System Safety (chỉ dùng cho M2 — quan trọng nhất!)
- [ ] Thay đổi đề xuất có làm sập dịch vụ đang chạy không?
- [ ] Có rollback path nếu fail không?
- [ ] Có phá compatibility với services đang dùng không?
- [ ] Config change có cần restart service không?
- [ ] Fix/patch mẫu đã chạy thử trong Workspace (bản clone) chưa?

### Bugs Found:
| # | Type | Severity | Description | Status |
|---|------|----------|-------------|--------|
| 1 | Logic | HIGH | ... | Fixed ✅ |
| 2 | Edge Case | MEDIUM | ... | Fixed ✅ |
| 3 | Data Leak | CRITICAL | ... | Fixed ✅ |

### Suggestions cho G3:
1. ...
2. ...
```

### Quy tắc phân loại bug severity:

| Severity | Định nghĩa | Xử lý |
|----------|-----------|-------|
| 🔴 **CRITICAL** | Data leakage, sai kết quả model, mất data | Fix NGAY — không được bỏ qua |
| 🟠 **HIGH** | Logic sai, crash, output sai | Fix trong vòng lặp G2 |
| 🟡 **MEDIUM** | Edge case, performance issue | Fix nếu có thời gian, nếu không ghi cho G3 |
| 🟢 **LOW** | Code style, comment thiếu, naming | Ghi vào worklog, G3 hoặc bỏ qua |

### 🖥️ Mode M2 — System Diagnostician: 5 Loại vấn đề hệ thống

Khi mission M2, LISMA không sửa bug trong code submission mà **chẩn đoán và đề xuất fix trong proposal**:

| # | Loại | Ví dụ thực tế (TMO) | Cách phát hiện |
|---|---|---|---|
| 1 | **Logic/Config bugs** | `NEO4J_DATABASE=neo4j` trong khi DB thật tên khác → connection fail âm thầm | Đối chiếu config ↔ code ↔ logs |
| 2 | **Edge cases production** | Service down, timeout, key pool cạn → fail-open path | Stress-test các nhánh degradation |
| 3 | **Integration issues** | LLM key 401 → retry mù quáng → chat 121s (thay vì fail-fast) | Trace handshake giữa services |
| 4 | **Performance issues** | Latency cao, memory leak, cold start | Đọc latency measurements, logs |
| 5 | **Reliability** | Thiếu retry/circuit breaker/health check | Review error handling paths |

**Điểm khác biệt quan trọng so với M1:**
- M1: LISMA được phép **SỬA** code submission trực tiếp
- M2: LISMA **CHỈ CHẨN ĐOÁN + ĐỀ XUẤT fix trong PROPOSAL** — tuyệt đối không apply bất kỳ thay đổi nào lên TMO

**Vòng lặp M2:** Đọc log → Định vị → Chẩn đoán → Đề xuất → NEMESIS verify (không có bước "apply fix")

### Kịch bản đặc biệt: G2 trong Tier 1 (Simple Task)

Khi TL giao Simple task trực tiếp cho G2 (bỏ qua G1):

```
TL giao: "Sửa lỗi import trong preprocessing.py"

G2 (LISMA) — 1 agent làm cả code + review:
─────────────────────────────────────
1. Đọc file → Tìm bug → Sửa → Verify → Pass ✅
2. Output: Code fix + worklog ngắn
─────────────────────────────────────

Không cần iteration loop vì task đơn giản.
LISMA tự code + tự fix trong 1 bước.
```

### Schema tổng hợp — G2 Internal Workflow:

```
G1 Output (code + worklog)
        │
        ▼
┌─── LISMA (Reviewer + Fixer) ─────────────────────────┐
│                                                          │
│  Vòng 1:                                                │
│  ┌────────────────────────────────────────────────┐      │
│  │ 1. READ: Đọc code + G1 worklog                  │      │
│  │ 2. DETECT: Scan theo 5 loại bug                 │      │
│  │    - Logic bugs                                 │      │
│  │    - Edge cases                                 │      │
│  │    - Data leakage ← Priority 1 trong M1!        │      │
│  │    - Performance issues                         │      │
│  │    - Compatibility issues                       │      │
│  │    (M2: 5 loại vấn đề hệ thống, Priority 1 =    │      │
│  │     System Safety)                              │      │
│  │ 3. FIX: Sửa từng bug theo severity              │      │
│  │    (M2: CHỈ chẩn đoán + đề xuất trong proposal)│      │
│  │ 4. VERIFY: Kiểm tra fix + regression            │      │
│  └────────────────────────────────────────────────┘      │
│                         │                                  │
│                    Còn bug?                                │
│                    ├── YES → Vòng 2 (tối đa 3 vòng)       │
│                    └── NO  → PASS                          │
│                                                          │
│  ESCALATE cases:                                         │
│  ├── Architectural issue → Báo TL                        │
│  ├── Quá 3 vòng vẫn còn bug → Báo TL                     │
│  └── CRITICAL không fix được → Báo TL                    │
│                                                          │
│  Output:                                                 │
│  - Code sạch (M1) / Diagnostic Report (M2)              │
│  - Worklog: bugs/diagnosis fixed + suggestions + concerns│
│  - Handoff cho G3 (hoặc TL nếu Simple/Medium)            │
│                                                          │
└──────────────┬───────────────────────────────────────────┘
               │ G2 Output
               ▼
     ┌─────────────────────┐
     │  Tier 1 → TL        │
     │  Tier 2 → TL        │
     │  Tier 3 → G3        │
     └─────────────────────┘
```

### Tóm tắt cơ chế G2:

| Khía cạnh | Cơ chế |
|-----------|--------|
| **Vai trò chính** | Reviewer + Bug Fixer (2 trong 1) — M1 / System Diagnostician — M2 |
| **Loại bug quét M1** | Logic, Edge Case, Data Leakage, Performance, Compatibility |
| **Loại vấn đề M2** | Logic/Config, Edge Cases Production, Integration, Performance, Reliability |
| **Priority #1 M1** | Data Leakage — bug nguy hiểm nhất trong Kaggle |
| **Priority #1 M2** | System Safety — không được làm sập dịch vụ đang chạy |
| **Vòng lặp** | Tối đa 3 vòng, mỗi vòng: Đọc → Tìm → Sửa/Chẩn đoán → Kiểm tra |
| **Stop criteria** | Không còn bug / Quá 3 vòng / Low severity bỏ qua |
| **Escalate** | Architectural issue / CRITICAL không fix được → Báo TL |
| **Severity** | CRITICAL > HIGH > MEDIUM > LOW |
| **Output M1** | Code sạch + Worklog (bugs fixed + suggestions + concerns) |
| **Output M2** | Diagnostic Report (root cause + fix proposals) — KHÔNG apply lên Live System (patch mẫu chỉ viết trong Workspace) |
| **Tier 1 đặc biệt** | LISMA tự code + self-review + self-fix (1 bước) |

---

## 🚀 CHI TIẾT G3 — CƠ CHẾ SELF-EVOLVING CỦA HAN

### 📋 JOB DESCRIPTION — HAN (G3 Optimizer / Architecture Proposer)

**Sứ mệnh (Dual Mission):**
- M1: Optimizer + Learner — đảm bảo code TỐT NHẤT (không chỉ đúng, mà tối ưu metric, tốc độ, đơn giản)
- M2: Architecture Proposer — đề xuất nâng cấp kiến trúc (bộ nhớ, quy trình, tư duy) + tối ưu performance

**Trách nhiệm chính:**
- ANALYZE G2 output + Knowledge Base
- OPTIMIZE theo priority: Data/System Safety → Performance → Code Quality
- EVOLVE: ghi lessons + anti-patterns vào Knowledge Base qua mỗi vòng
- CURATE: consolidate + dedup các KB entries do NEMESIS/SIVIL ghi (chu trình G3 gần nhất)
- (M2) Sinh PROPOSAL ITEM kèm Verification Plan

**Deliverables:** Optimized code (M1) / Proposal items (M2) + Updated Knowledge Base (đã curate — gồm entries từ cả team) + Recommendations cho TL

### 📜 INSTRUCTIONS — HAN

- **LUÔN:** load Knowledge Base trước khi optimize; ghi lesson mới sau mỗi vòng; đọc theo Metric Impact Chain (M1) / Impact Chain (M2); sinh Verification Plan (deferred) cho mọi proposal M2; curate KB entries do NEMESIS/SIVIL ghi (dedup/merge/retire)
- **KHÔNG BAO GIỜ:** tối ưu khi Data/System Safety chưa pass; thay đổi approach mà không báo NEMESIS; (M2) apply thay đổi trực tiếp lên Live System — POC/thử nghiệm chỉ chạy trong Workspace
- **Input contract:** G2 output (verified code/report + suggestions + concerns) + Knowledge Base
- **Output contract:** Optimized code/Proposal items + updated KB + recommendations → NEMESIS
- **ESCALATE lên TL khi:** approach sai fundamental / overfitting không sửa được trong scope G3
- **Signature move:** self-evolving — Knowledge Base tích lũy lessons + anti-patterns qua từng vòng

### Tại sao vị trí G3 được thiết kế như vậy?

| Thiết kế vai trò | Lợi ích cho pipeline |
|---|---|
| **Optimizer + Learner 2-trong-1** | Không chỉ tối ưu theo quy tắc — tự học từ feedback các vòng trước qua Knowledge Base, cải thiện strategy liên tục |
| **Phối hợp với G2 đúng lớp** | LISMA đảm bảo ĐÚNG (no bug, no leak) — HAN đảm bảo TỐT NHẤT (metric, tốc độ, đơn giản). Không chồng chéo trách nhiệm |
| **Priority-based optimization** | Data/System Safety > Performance > Code Quality — luôn verify sự an toàn trước khi tối ưu |

### Nguyên tắc cốt lõi: "Không chỉ sửa — mà làm TỐT HƠN"

G2 (LISMA) đảm bảo code **đúng** — không có bug, không leak.
G3 (HAN) đảm bảo code **tốt nhất** — tối ưu hiệu năng, giảm phức tạp, tăng score.

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

### 5 Lĩnh vực tối ưu của G3 (Mode M1 — Kaggle):

#### Lĩnh vực 1: Hyperparameter Tuning — Tìm siêu tham số tối ưu

```
G2 Output:
─────────────────────────────────────
xgb = XGBRegressor(
    n_estimators=1000,
    learning_rate=0.05,
    max_depth=6,
    subsample=0.8,
    colsample_bytree=0.8,
    random_state=42
)
CV Score: 0.125
─────────────────────────────────────

HAN G3 — Self-evolving tuning:

Vòng 1: Thử search space rộng
  - learning_rate: [0.01, 0.03, 0.05, 0.1]
  - max_depth: [3, 4, 5, 6, 7, 8]
  - n_estimators: [500, 1000, 2000, 3000]
  - subsample: [0.6, 0.7, 0.8, 0.9, 1.0]
  - colsample_bytree: [0.6, 0.7, 0.8, 0.9, 1.0]
  - reg_alpha: [0, 0.01, 0.1, 1]
  - reg_lambda: [0.01, 0.1, 1, 10]

  → Best: lr=0.03, depth=4, n=2000, sub=0.7, col=0.7
  → CV Score: 0.121

Vòng 2: Zoom vào vùng tốt (self-evolving — thu hẹp search space)
  - learning_rate: [0.02, 0.025, 0.03, 0.035, 0.04]
  - max_depth: [3, 4, 5]
  - n_estimators: [1500, 2000, 2500]
  - subsample: [0.65, 0.7, 0.75]
  - colsample_bytree: [0.65, 0.7, 0.75]

  → Best: lr=0.025, depth=4, n=2500, sub=0.7, col=0.65
  → CV Score: 0.119

Vòng 3: Fine-tune quanh best (self-evolving — tinh chỉnh)
  → CV Score: 0.118 ← Converged
```

**Cơ chế self-evolving:** Mỗi vòng, HAN thu hẹp search space dựa trên kết quả vòng trước. Không random search mù quáng — mà **adaptively refine**.

#### Lĩnh vực 2: Feature Selection — Chọn features tối ưu

```
G2 Output: 180 features (tất cả features G1 tạo ra)
CV Score: 0.125

HAN G3 — Phân tích importance:

Bước 1: Đánh giá từng feature
┌─────────────────────────────────────────────────────┐
│  Feature                Importance   Cumulative      │
│  ─────────────────────  ──────────   ──────────     │
│  OverallQual             0.142       14.2%           │
│  GrLivArea_log           0.098       24.0%           │
│  TotalSF                 0.087       32.7%           │
│  Neighborhood_TE         0.072       39.9%           │
│  YearBuilt               0.065       46.4%           │
│  OverallQual²            0.051       51.5%           │
│  GrLivArea×OverallQual   0.048       56.3%           │
│  ...                                                  │
│  PoolArea²               0.001       99.1%           │
│  MiscFeature_TE          0.0005      99.2%           │
│  Street_TE               0.0001      99.3%           │
│  ...                                                  │
│  (bottom 85 features     <0.001 each)                │
└─────────────────────────────────────────────────────┘

Bước 2: Loại features nhiễu
  - Top 40 features: giữ (cumulative importance ~95%)
  - 85 bottom features: loại (noise, overfitting risk)
  - 55 middle features: test từng nhóm

Bước 3: Recursive Feature Elimination (RFE)
  → Train với top-40 → CV 0.120
  → Train với top-60 → CV 0.119
  → Train với top-80 → CV 0.120 (worse! overfitting)
  → Chốt: top-60 features

Kết quả: 180 → 60 features (giảm 67%)
CV Score: 0.125 → 0.119
Runtime: 45 min → 22 min
```

**Cơ chế self-evolving:** HAN học được "thêm features không phải luôn tốt" từ kết quả RFE, và áp dụng kinh nghiệm này cho các task tối ưu tiếp theo.

#### Lĩnh vực 3: Ensemble Optimization — Tối ưu kết hợp models

```
G2 Output: 3 models riêng lẻ
  - XGBoost:    CV 0.122
  - LightGBM:   CV 0.123
  - CatBoost:   CV 0.125

HAN G3 — Tìm cách kết hợp tối ưu:

Bước 1: Test các ensemble strategies
┌──────────────────────────────────────────────────────────┐
│  Strategy                     CV Score   Std    Gap LB?  │
│  ─────────────────────────   ────────   ────   ────────  │
│  Simple average               0.120     0.008   Safe     │
│  Weighted (0.5/0.3/0.2)      0.119     0.007   Safe     │
│  Weighted (0.4/0.4/0.2)      0.118     0.006   Safe     │
│  Weighted (0.6/0.3/0.1)      0.119     0.009   Risky    │
│  Stacking (Ridge meta)        0.117     0.005   Safe     │
│  Stacking (Lasso meta)        0.118     0.005   Safe     │
│  Stacking (XGB meta)          0.115     0.012   Risky!   │
└──────────────────────────────────────────────────────────┘

Bước 2: Phân tích trade-off
  Stacking Ridge meta: Best safe score (0.117) + Low std (0.005)
  Stacking XGB meta:   Best score (0.115) BUT High std (0.012) = RISKY

Bước 3: Self-evolving decision
  → Chọn Stacking Ridge meta
  → Lý do: Score gần tốt nhất + variance thấp nhất
  → Ghi kinh nghiệm: "High std trong stacking = overfit signal"

Kết quả: 3 models riêng → Stacking ensemble
CV Score: 0.122 (best single) → 0.117 (ensemble)
```

#### Lĩnh vực 4: Cross-Validation Strategy — Tối ưu chiến lược đánh giá

```
G2 Output: Sử dụng KFold(n_splits=5)
CV Score: 0.117

HAN G3 — Kiểm tra CV strategy có đáng tin không:

Phân tích:
  "House Prices dataset nhỏ (1460 rows).
   KFold ngẫu nhiên có thể tạo fold không đại diện.
   Nên dùng StratifiedKFold theo bins của target."

Bước 1: Tạo stratification bins
  → Chia SalePrice thành 10 bins
  → Mỗi bin có phân phối target tương tự

Bước 2: So sánh CV strategies
┌───────────────────────────────────────────────┐
│  Strategy           CV Mean   CV Std   Delta  │
│  ───────────────    ───────   ──────   ─────  │
│  KFold(5)           0.117     0.005    —      │
│  KFold(10)          0.118     0.003    +0.001 │
│  StratifiedKFold(5) 0.116     0.003    -0.001 │
│  RepeatedKFold(5×3) 0.1165    0.004    -0.0005│
└───────────────────────────────────────────────┘

Bước 3: Self-evolving insight
  → StratifiedKFold cho score thấp hơn nhưng std thấp hơn
  → Score thấp hơn = đánh giá thực tế hơn (không optimistic bias)
  → Std thấp hơn = kết quả ổn định hơn
  → Chốt: StratifiedKFold(5)
  → Lưu insight: "Dataset nhỏ → Stratified theo target bins"
```

#### Lĩnh vực 5: Code Simplification — Giảm phức tạp

```
G2 Output: Code sạch nhưng phức tạp
─────────────────────────────────────
class FeatureEngineering:
    def __init__(self, config):
        self.config = config
        self.encoders = {}
        self.scalers = {}
        self.feature_names = []
    
    def fit_transform(self, train, test):
        # 150 dòng code cho feature engineering
        # Nhiều bước redundant
        # 3 loại encoding lẫn lộn
        # ...
─────────────────────────────────────

HAN G3 — Đơn giản hóa:

Phân tích redundancy:
  → 3 loại encoding cho cùng feature (waste)
  → 12 features tương quan > 0.95 với nhau (redundant)
  → Pipeline có 5 bước có thể gộp thành 3

Simplified:
─────────────────────────────────────
class FeatureEngineering:
    def __init__(self):
        self.encoders = {}
    
    def fit_transform(self, train, test):
        # 3 bước rõ ràng thay vì 5 lẫn lộn
        train, test = self._encode_categorical(train, test)
        train, test = self._transform_numeric(train, test)
        train, test = self._create_interactions(train, test)
        return train, test
    # 80 dòng code thay vì 150
    # Mỗi bước có 1 trách nhiệm (Single Responsibility)
─────────────────────────────────────

Kết quả: 150 → 80 dòng, dễ maintain, dễ debug
```

### 🖥️ Mode M2 — Architecture Proposer: 5 Lĩnh vực tối ưu hệ thống

| # | Lĩnh vực | Phạm vi nghiên cứu | Output |
|---|---|---|---|
| 1 | **Memory Architecture** | Short/long-term memory, vector (Qdrant) + graph (Neo4j) + SQLite coordination | Proposal nâng cấp bộ nhớ |
| 2 | **Execution Pipeline** | 3-Tier system, Read-Write-Verify, handoff flow giữa agents | Proposal nâng cấp quy trình thực thi |
| 3 | **Thinking Process** | Reasoning strategy, research protocol, hypothesis-driven loop | Proposal nâng cấp quy trình tư duy |
| 4 | **Tools & Agents Roster** | MCP tools, phân bổ agent, model-to-role mapping | Proposal tối ưu roster + tools |
| 5 | **UI/UX & Performance** | Giao diện, latency, token cost | Proposal UI/UX + performance |

**Quy tắc M2:** Mỗi vòng tối ưu output = **1 PROPOSAL ITEM** (không phải code submit). Vì hệ thống benchmark A/B chưa xây dựng, mỗi proposal item BẮT BUỘC kèm **Verification Plan (deferred)**:
- (a) Cách kiểm chứng bằng tay NGAY (log check, manual test)
- (b) Benchmark spec khi hệ A/B được xây (ghi rõ metric + method)

**Knowledge Base M2 thêm categories:** **System Patterns** (cái gì hoạt động tốt), **System Anti-Patterns** (KHÔNG LÀM), **Config Lessons**, **Performance Baselines** — HAN tích lũy hiểu biết về chính hệ TMO qua từng mission. Theo protocol Knowledge Capture, NEMESIS và SIVIL cũng ghi trực tiếp khi phát hiện tri thức mới (xem section KNOWLEDGE CAPTURE).

### Cơ chế Self-Evolving — Trái tim của G3

Đây là phần quan trọng nhất — HAN không chỉ tối ưu theo quy tắc, mà **tự cải thiện strategy** qua từng vòng:

```
┌──────────────────────────────────────────────────────────┐
│           HAN — SELF-EVOLVING ENGINE                       │
│                                                           │
│  ┌────────────────────────────────────────────────┐       │
│  │            KNOWLEDGE BASE                       │       │
│  │                                                 │       │
│  │  Lesson #1: "Dataset nhỏ → Stratified CV"       │       │
│  │  Lesson #2: "High std trong stacking = overfit" │       │
│  │  Lesson #3: "More features ≠ better"            │       │
│  │  Lesson #4: "Target encoding cần K-Fold"        │       │
│  │  Lesson #5: "XGBoost depth=4 thường tốt hơn 6" │       │
│  │  [M2] "LLM key 401 → retry mù = latency 121s"  │       │
│  │  [M2] "NEO4J_DATABASE phải đúng instance ID"     │       │
│  │  ...                                            │       │
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
│                                                           │
└──────────────────────────────────────────────────────────┘
```

**Ghi chú:** Theo protocol Knowledge Capture, nguồn ghi KB không chỉ HAN — NEMESIS và SIVIL ghi trực tiếp khi phát hiện trong quá trình vận hành; HAN giữ vai trò **Curator** (consolidate/dedup). Xem section KNOWLEDGE CAPTURE.

#### Ví dụ self-evolving qua 3 vòng thực tế:

**Vòng 1 — Part 1 (EDA):**
```
HAN tối ưu EDA
→ Học lesson: "Missing value pattern gợi ý MNAR"
→ Áp dụng: "Không dùng simple imputation cho MNAR features"
→ Ghi vào Knowledge Base
```

**Vòng 2 — Part 2 (Feature Engineering):**
```
HAN áp dụng lesson từ Vòng 1:
→ "MNAR features → Dùng flag features (is_missing) thay vì impute"

Thử nghiệm mới:
→ is_missing features cho +0.003 CV improvement
→ Học lesson mới: "Missing indicator features hữu ích khi MNAR"

Ghi vào Knowledge Base
```

**Vòng 3 — Part 3 (Model Building):**
```
HAN áp dụng ALL lessons từ Vòng 1 + 2:
→ "MNAR → is_missing features" (từ Vòng 2)
→ "Stratified CV cho dataset nhỏ" (từ kinh nghiệm chung)
→ "XGBoost depth=4 tốt hơn 6" (từ tuning Vòng 3)

Kết quả: Tối ưu nhanh hơn vì đã có kinh nghiệm
Không cần search toàn bộ space
Zoom thẳng vào vùng tốt dựa trên lessons
```

#### Knowledge Base — Cấu trúc lưu trữ (KB của TEAM):

KB là tài sản CHUNG của team — không phải riêng HAN (HAN chỉ là Curator). Cấu trúc:

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
```

### Vòng lặp tối ưu G3 — 3 Phases:

```
G2 Output (code sạch + suggestions + concerns)
        │
        ▼
┌─── HAN (Optimizer) ──────────────────────────────────┐
│                                                          │
│  Phase 1: ANALYZE                                        │
│  ┌────────────────────────────────────────────────┐      │
│  │ • Đọc G2 code + worklog                        │      │
│  │ • Đọc G2 suggestions                           │      │
│  │ • Đọc G2 concerns (TL có xác nhận không?)       │      │
│  │ • Load Knowledge Base                           │      │
│  │ • Xác định lĩnh vực tối ưu có thể áp dụng      │      │
│  │   (M1: 5 lĩnh vực Kaggle / M2: 5 lĩnh vực hệ thống)│     │
│  └────────────────────────────────────────────────┘      │
│                         │                                  │
│                         ▼                                  │
│  Phase 2: OPTIMIZE (theo priority)                       │
│  ┌────────────────────────────────────────────────┐      │
│  │ Priority 1: Data/System Safety (verify G2 fixes)│     │
│  │   → Double-check data leakage fixes              │      │
│  │   → Verify CV strategy / System safety          │      │
│  │                                                  │      │
│  │ Priority 2: Performance                          │      │
│  │   → (M1) Hyperparameter tuning + Feature sel +  │      │
│  │      Ensemble optimization                       │      │
│  │   → (M2) Proposal items: memory/execution/     │      │
│  │      thinking/tools/UI-perf                      │      │
│  │                                                  │      │
│  │ Priority 3: Code/Architecture Quality           │      │
│  │   → Simplification                               │      │
│  │   → Remove redundancy                           │      │
│  │   → Improve readability                         │      │
│  └────────────────────────────────────────────────┘      │
│                         │                                  │
│                         ▼                                  │
│  Phase 3: EVOLVE                                         │
│  ┌────────────────────────────────────────────────┐      │
│  │ • So sánh kết quả trước/sau tối ưu             │      │
│  │ • Ghi lessons mới vào Knowledge Base            │      │
│  │ • Ghi anti-patterns (nếu có)                   │      │
│  │ • Update confidence scores                      │      │
│  │ • Tạo suggestions cho TL                        │      │
│  │ • (M2) Mỗi proposal item kèm Verification Plan  │      │
│  └────────────────────────────────────────────────┘      │
│                                                          │
│  Output:                                                 │
│  - Optimized code (M1) / Proposal items (M2)            │
│  - Worklog: improvements + metrics + lessons            │
│  - Knowledge Base updates                               │
│  - Recommendations cho TL                               │
│                                                          │
└──────────────┬───────────────────────────────────────────┘
               │ G3 Output
               ▼
          TL (NEMESIS)
```

### Ví dụ thực tế — G3 tối ưu House Prices pipeline (M1):

```
G2 Output:
  - 3 models: XGBoost (0.122), LightGBM (0.123), CatBoost (0.125)
  - 180 features
  - 5-Fold CV
  - Runtime: 45 min
  - G2 suggestion: "Nên thử thêm stacking"

HAN G3 — Phase 1: ANALYZE
─────────────────────────────────
  → 180 features nhiều khả năng có noise
  → 5-Fold có thể không stable cho 1460 rows
  → 3 models tốt, có thể ensemble
  → CatBoost yếu nhất → loại hoặc giảm weight

HAN G3 — Phase 2: OPTIMIZE
─────────────────────────────────
  Bước 1: Feature Selection
    → RFE: top-60 features
    → CV: 0.122 → 0.120 (better!)

  Bước 2: Hyperparameter Tuning
    → XGBoost: depth 6→4, lr 0.05→0.025, n 1000→2500
    → LightGBM: num_leaves 31→63, lr 0.05→0.03
    → CatBoost: depth 6→4, iterations 1000→2000
    → CV: XGB 0.118, LGBM 0.119, CatBoost 0.122

  Bước 3: CV Strategy
    → KFold → StratifiedKFold
    → Std giảm từ 0.005 → 0.003

  Bước 4: Ensemble
    → Stacking (Ridge meta) với XGB + LGBM + CatBoost
    → CV: 0.115 ← Best!

  Bước 5: Simplification
    → Pipeline: 5 bước → 3 bước
    → Code: 350 dòng → 200 dòng

HAN G3 — Phase 3: EVOLVE
─────────────────────────────────
  Lessons mới:
  - "House Prices: top-60 features tốt hơn top-180"
  - "XGBoost depth=4, lr=0.025, n=2500 là sweet spot"
  - "StratifiedKFold stable hơn KFold cho dataset nhỏ"
  - "Stacking Ridge meta: 0.115 (best)"

  Anti-patterns mới:
  - "CatBoost depth=6 overfit trên dataset nhỏ"

Kết quả cuối cùng:
  CV Score: 0.125 → 0.115 (giảm 8%)
  Runtime:  45 min → 28 min (giảm 38%)
  Features: 180 → 60 (giảm 67%)
  Code:     350 → 200 dòng (giảm 43%)
```

### Schema tổng hợp — G3 Internal Workflow:

```
G2 Output (code sạch + suggestions + concerns)
        │
        ▼
┌─── HAN (Optimizer) ──────────────────────────────────┐
│                                                          │
│  Phase 1: ANALYZE                                        │
│  ├── Đọc code + worklog + suggestions từ G2              │
│  ├── Load Knowledge Base                                 │
│  └── Xác định tối ưu areas (M1: 5 lĩnh vực / M2: 5 lĩnh vực)│
│                                                          │
│  Phase 2: OPTIMIZE (priority-based)                      │
│  ├── P1: Data/System Safety (verify leakage/safety fixes)│
│  ├── P2: Performance (M1: tuning+FE+ensemble / M2: proposals)│
│  └── P3: Code/Architecture Quality                       │
│                                                          │
│  Phase 3: EVOLVE (self-evolving)                         │
│  ├── So sánh trước/sau                                   │
│  ├── Ghi lessons mới vào Knowledge Base                  │
│  ├── Ghi anti-patterns                                   │
│  ├── (M2) Mỗi proposal kèm Verification Plan (deferred)  │
│  └── Tạo recommendations cho TL                         │
│                                                          │
│  Output:                                                 │
│  ├── Optimized code (M1) / Proposal items (M2)           │
│  ├── Updated Knowledge Base                              │
│  └── Worklog + Recommendations cho TL                    │
│                                                          │
└──────────────┬───────────────────────────────────────────┘
               │ G3 Output
               ▼
          TL (NEMESIS)
```

### Tóm tắt cơ chế G3:

| Khía cạnh | Cơ chế |
|-----------|--------|
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

## 📚 KNOWLEDGE CAPTURE — GHI TRI THỨC NGAY TRONG VẬN HÀNH

Team research là **lực lượng tri thức** của hệ thống: mọi điều học được từ Kaggle (M1) và từ nghiên cứu chính TMO (M2) đều phải trở thành tài sản chung của team. Nguyên tắc: **phát hiện hay → ghi vào Knowledge Base ngay trong cùng phiên làm việc** — không chờ tới cuối chu trình.

### Thiết kế cũ và 3 lỗ hổng:

```
Thiết kế cũ: chỉ HAN ghi KB ở cuối chu trình G3 (EVOLVE)

Lỗ hổng:
  ① Tri thức phát sinh ở TL/G1/G2 phải CHỜ tới G3 mới được ghi
     → thất lạc nếu task pivot / dừng giữa chừng
  ② Tier SIMPLE / MEDIUM không đi qua G3
     → tri thức của những task này KHÔNG BAO GIỜ vào KB
  ③ Thảo luận NEMESIS ↔ SIVIL không được lưu lại
     → insight từ thảo luận mất ngay khi kết thúc
```

### Ai được ghi KB (thiết kế mới):

| Agent | Quyền | Thời điểm capture |
|-------|-------|-------------------|
| **NEMESIS** | Ghi trực tiếp | MONITOR (đọc worklog) / DECIDE (pivot lessons) / FINALIZE / Research Council |
| **SIVIL** | Ghi trực tiếp | SYNTHESIZE (insight từ sub-agents) / Research Council |
| **HAN** | Ghi trực tiếp + **CURATOR** | Chu trình G3 (như cũ) + consolidate/dedup entries của cả team |
| **BELI** | Đề xuất qua worklog | Edge cases + patterns gặp khi code → trường "KB Candidates" |
| **LISMA** | Đề xuất qua worklog | Bug patterns + root cause insight khi review → trường "KB Candidates" |

BELI/LISMA không ghi trực tiếp vì findings của họ cần được xác nhận — NEMESIS/SIVIL/HAN đọc "KB Candidates" trong worklog và quyết định ghi (entry nào cũng phải có evidence).

### RESEARCH COUNCIL — Thảo luận NEMESIS ↔ SIVIL:

NEMESIS và SIVIL tiến hành **nhiều thảo luận** trong suốt quá trình vận hành — đây là nơi tri thức được phát hiện, thách thức và chốt:

```
┌─────────────────────────────────────────────────────┐
│  RESEARCH COUNCIL — NEMESIS ↔ SIVIL                    │
│                                                      │
│  Thời điểm (4 cố định):                             │
│  ① Sau DECOMPOSE — trước khi ASSIGN                 │
│  ② Sau SYNTHESIZE — trước khi BELI code             │
│  ③ Khi G1 ESCALATE                                   │
│  ④ Tại mỗi Checkpoint                                │
│                                                      │
│  Nội dung:                                           │
│  ├── Challenge hypotheses (NEMESIS hỏi, SIVIL        │
│  │   đáp bằng findings)                              │
│  ├── Đối chiếu findings với KB: "đã có chưa?"      │
│  └── Chốt tri thức mới → ghi KB NGAY                │
│                                                      │
│  Output:                                             │
│  ├── Discussion summary (ghi vào worklog)           │
│  └── KB entries mới (KB Write Protocol)             │
└─────────────────────────────────────────────────────┘
```

### KB WRITE PROTOCOL — 4 bước:

```
Bước 1 — SEARCH   Tra KB theo category + keywords:
                   → Đã có → bỏ qua (hoặc bổ sung evidence nếu làm entry mạnh hơn)
                   → Chưa có → sang Bước 2

Bước 2 — FORMAT   Viết entry theo KB Entry Schema (dưới đây)
                   Insight ngắn + actionable; evidence bắt buộc

Bước 3 — WRITE    NEMESIS/SIVIL/HAN: ghi trực tiếp
                   BELI/LISMA: để trong worklog trường "KB Candidates"

Bước 4 — CURATE   HAN consolidate trong chu trình G3 gần nhất:
                   dedup (trùng → merge) / retire (lỗi thời → đánh dấu RETIRED)
```

### KB Entry Schema:

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

Ví dụ 3 entry ghi từ 3 nguồn khác nhau:

| ID | Category | Insight | Evidence | Source | Mission |
|---|---|---|---|---|---|
| KB-20250612-001 | Config Lessons | Neo4j Aura: user = instance ID (8-hex), không phải luôn là "neo4j" | AuraDB handshake: user "neo4j" 401 / instance ID 200 | NEMESIS (MONITOR) | M2 |
| KB-20250612-002 | System Anti-Patterns | LLM key 4xx → KHÔNG retry mù — fail-fast ngay | log 121s (retry mù) vs 6.2s (fail-fast) | LISMA → HAN | M2 |
| KB-20250612-003 | Research Insights | Decompose audit hệ thống theo 4 branch (hiện trạng → điểm yếu → pattern → feasibility) cho coverage đủ | Discussion ② Research Council — task audit memory | SIVIL | M2 |

### Category mới — Research Insights:

Tri thức **phương pháp nghiên cứu**: cách decompose hiệu quả, exploration strategy, discussion outcomes, cách verify claim. Đây là category lưu chính những gì Research Council đúc kết — tri thức về cách nghiên cứu, tách biệt với tri thức về nội dung (Kaggle/System).

### Quy tắc vàng Knowledge Capture:

1. **Ghi ngay, không hoãn** — tri thức phát hiện hôm nay không đợi tới chu trình sau
2. **Mọi tier đều capture** — SIMPLE/MEDIUM không qua G3 → NEMESIS ghi tại MONITOR + FINALIZE
3. **Evidence trước khi ghi** — insight không có evidence/context = không ghi (giữ KB sạch)
4. **KB là của team** — HAN curate nhưng không độc quyền; NEMESIS/SIVIL ghi trực tiếp, BELI/LISMA đề xuất
5. **Research Council là nguồn tri thức sống** — mọi thảo luận NEMESIS ↔ SIVIL kết thúc bằng câu hỏi: "Có gì KB chưa có?"

---

## 🧠 CHI TIẾT TL — CƠ CHẾ ĐIỀU PHỐI CỦA NEMESIS

### 📋 JOB DESCRIPTION — NEMESIS (TL / Team Leader / Research Director)

**Sứ mệnh (Dual Mission):**
- M1: Tư duy & điều phối nghiên cứu Kaggle — nhìn lớn, chia nhỏ, kiểm soát chặt
- M2: Research Director hệ thống — phân loại mission, điều phối audit TMO, tổng hợp Proposal, route vào SELF-DIRECTION

**Trách nhiệm chính:**
- CLASSIFY: phân loại request M1 (Kaggle) / M2 (System Research)
- RECEIVE → TRIAGE → DECOMPOSE → ASSIGN → MONITOR → DECIDE → FINALIZE (7 nhiệm vụ)
- Viết Research Protocol / System Audit Charter cho từng part
- Đọc worklog sau mỗi Checkpoint, quyết định CONTINUE / PIVOT / ESCALATE
- KHÔNG code — chỉ tư duy và điều phối
- RESEARCH COUNCIL: chủ trì thảo luận với SIVIL tại 4 thời điểm cố định
- KNOWLEDGE CAPTURE: khi MONITOR/DECIDE/FINALIZE phát hiện tri thức KB chưa có → ghi NGAY theo KB Write Protocol

**Deliverables:** Task .md files + Decision log + Progress tracking + Final report (M1) / Proposal (M2 → SELF-DIRECTION) + KB entries mới (tri thức phát hiện trong vận hành)

### 📜 INSTRUCTIONS — NEMESIS

- **LUÔN:** đọc worklog sau mỗi Checkpoint (metrics/findings trước, chi tiết sau); ghi lý do mọi quyết định vào Decision log; chọn tier CHO TỪNG PART; với M2 — mọi claim phải có evidence trước khi vào Proposal; ghi tri thức mới vào KB NGAY khi phát hiện (KB Write Protocol); chủ trì Research Council với SIVIL
- **KHÔNG BAO GIỜ:** code hay sửa code (đọc để HIỂU, giao lại cho LISMA/HAN sửa); quyết định khi thiếu thông tin (thiếu → hỏi 1 câu đúng chỗ); đoán mò mission type khi ambiguous
- **Input contract:** user request + mọi worklogs + Artifact Maps + (M2) system docs/logs health
- **Output contract:** task .md cho từng part + quyết định tại mỗi Checkpoint + Proposal (M2)
- **ESCALATE lên user khi:** data quality không cứu được / quyết định vượt quyền ủy quyền / cần resource thêm
- **Signature move:** "Nhìn lớn, chia nhỏ, kiểm soát chặt" — Research Loop Controller

### Tại sao vị trí TL được thiết kế như vậy?

| Thiết kế vai trò | Lợi ích cho team |
|---|---|
| **Đọc toàn bộ context cùng lúc** | NEMESIS nắm TOÀN BỘ competition description + data dictionary + forum posts + worklogs (M2: system docs + logs + health) — không mất context khi chuyển giữa các parts |
| **Suy luận sâu & lập kế hoạch dài hạn** | Phân tích bài toán phức tạp, chia nhỏ chính xác, nhận ra dependency giữa các parts, biết khi nào cần pivot |
| **Không code** | NEMESIS chỉ TƯ DUY và ĐIỀU PHỐI — không can thiệp vào code của G1/G2/G3. Tránh xung đột "vừa cầm lái vừa sửa máy" |
| **Phân loại mission (CLASSIFY)** | Dual mission đòi hỏi 1 cổng phân luồng duy nhất ngay đầu pipeline — sai mission type = toàn bộ pipeline chạy nhầm hướng |

### Nguyên tắc cốt lõi: "Nhìn lớn, chia nhỏ, kiểm soát chặt"

```
┌─────────────────────────────────────────────────────────┐
│              NEMESIS — TEAM LEADER                          │
│                                                          │
│  NHÌN LỚN        CHIA NHỎ          KIỂM SOÁT CHẶT       │
│                                                          │
│  • Hiểu toàn bộ   • Phá vỡ bài toán    • Đọc worklog    │
│    competition      thành parts          sau mỗi group   │
│    / hệ thống     • Mỗi part có .md   • Đọc code       │
│  • Định hướng      mô tả rõ ràng        khi cần thiết   │
│    chiến lược     • Sắp xếp thứ tự    • Quyết định     │
│  • Nhìn xa deadline& resources       ưu tiên    nâng/hạ tier    │
│                                                          │
└─────────────────────────────────────────────────────────┘
```

### TL có đọc/kiểm tra code không?

**Câu trả lời: CÓ, nhưng có chủ đích và chọn lọc.**

TL không phải là code reviewer — đó là việc của G2. Nhưng TL đọc code trong 3 tình huống cụ thể:

#### Tình huống 1: Đọc code khi kiểm tra kết quả quan trọng (Post-Group Verification)

```
G3 báo cáo: "Stacking ensemble cho CV 0.115"

TL quyết định:
  "0.115 là kết quả quan trọng — cần verify.
   Tôi sẽ đọc KEY sections của code để đảm bảo:
   1. Stacking dùng K-Fold (không leakage)
   2. Meta-model train trên out-of-fold predictions
   3. Final prediction đúng cách"

TL đọc (KHÔNG phải toàn bộ code):
  → Chỉ đọc stacking.py — 30 dòng key logic
  → Xác nhận: K-Fold stacking đúng ✅
  → Không đọc: feature engineering code (đã G2 review)
  → Không đọc: visualization code (không ảnh hưởng score)
```

**Nguyên tắc:** TL chỉ đọc **code ảnh hưởng trực tiếp đến kết quả cuối cùng** — stacking logic, submission logic, CV strategy.

#### Tình huống 2: Đọc code khi G2 ESCALATE

```
G2 ESCALATE: "Phát hiện data leakage fundamental trong 
              target encoding. Fix sẽ require thay đổi 
              toàn bộ pipeline architecture."

TL quyết định đọc code:
  → Đọc target_encoding.py — hiểu cách implement hiện tại
  → Đọc pipeline.py — hiểu data flow
  → Đánh giá: "Fix này ảnh hưởng 3 parts đã hoàn thành"
  → Quyết định: PIVOT — quay lại sửa từ Part 2

Nếu TL không đọc code → Không hiểu severity → Quyết định sai
```

**Nguyên tắc:** Khi G2 ESCALATE architectural issue, TL BẮT BUỘC đọc code để hiểu vấn đề trước khi quyết định.

#### Tình huống 3: Đọc code khi kết quả bất thường

```
CV Score: 0.115
Public LB: 0.142 ← Gap quá lớn!

TL nghi ngờ: "Có thể có leakage khiến CV optimistic"

TL đọc code:
  → Đọc cross_validation.py — check fold strategy
  → Đọc feature_selection.py — check có dùng test data không
  → Đọc target_encoding.py — check K-Fold đúng chưa
  → Phát hiện: "Target encoding dùng K-Fold nhưng 
    feature selection chạy TRƯỚC encoding → leakage!"

TL quyết định: PIVOT — sửa lại feature selection pipeline
```

**Nguyên tắc:** Khi kết quả bất thường (CV-LB gap, score bất ngờ), TL đọc code để tìm nguyên nhân.

#### Bảng tóm tắt — TL đọc code khi nào?

| Tình huống | TL đọc code? | Đọc phần nào | Mục đích |
|-----------|-------------|-------------|----------|
| G2/G3 hoàn thành bình thường | ❌ Không | — | Tin tưởng G2 review |
| Kết quả quan trọng (submission) | ✅ Có | Key logic sections | Verify correctness |
| G2 ESCALATE architectural issue | ✅ BẮT BUỘC | Related files | Hiểu severity |
| Kết quả bất thường (CV-LB gap) | ✅ Có | CV + features pipeline | Tìm nguyên nhân |
| G1 code draft | ❌ Không | — | G2 sẽ review |
| G3 optimization code | ❌ Không | — | Tin tưởng G3 |
| Submission file | ✅ LUÔN | Format + values | Đảm bảo submit đúng |
| M2: Findings thiếu evidence | ✅ Có | File/log liên quan | Verify claim trước khi vào Proposal |

#### Quy tắc đọc code của TL:

```
┌──────────────────────────────────────────────────────────┐
│           TL CODE READING PRINCIPLES                     │
│                                                           │
│  1. TRUST FIRST: Tin tưởng G2 đã review đúng             │
│     → Không cần đọc code nếu không có red flag            │
│                                                           │
│  2. READ BY EXCEPTION: Chỉ đọc khi có signal bất thường   │
│     → ESCALATE / Gap / Important result                   │
│                                                           │
│  3. READ SELECTIVELY: Không đọc toàn bộ codebase          │
│     → Chỉ đọc KEY sections ảnh hưởng kết quả              │
│     → Stack/Ensemble logic, CV strategy, Submission       │
│                                                           │
│  4. READ TO UNDERSTAND, NOT TO FIX:                       │
│     → TL đọc để HIỂU vấn đề → ra quyết định              │
│     → TL KHÔNG sửa code → Giao lại cho G2/G3             │
│                                                           │
│  5. READ OUTPUT FIRST: Ưu tiên đọc kết quả trước code     │
│     → CV scores, metrics, worklog suggestions             │
│     → Chỉ deep-dive vào code nếu kết quả bất thường       │
│                                                           │
└──────────────────────────────────────────────────────────┘
```

### 7 Nhiệm vụ cốt lõi của TL:

#### Nhiệm vụ 1: RECEIVE — Tiếp nhận & Phân tích Request

**Bước 0 — CLASSIFY MISSION (bắt buộc với mọi request, trước mọi việc khác):**

```
NEMESIS nhận request → Phân loại mission TRƯỚC KHI làm gì khác:

Signals M1 (Kaggle Research):
  "kaggle, competition, dataset, leaderboard, submission,
   train model, score, EDA, feature engineering..."

Signals M2 (System Research):
  "hệ thống, TMO, module, kiến trúc, bộ nhớ, quy trình
   thực thi, quy trình tư duy, agents roster, UI/UX,
   performance, latency, bug, logs, config, nâng cấp..."

Output: mission_type (M1 | M2) + confidence
  ├── Confidence cao → tiến hành RECEIVE bình thường
  └── Ambiguous → hỏi user ĐÚNG 1 CÂU, không đoán mò:
      "Đây là nghiên cứu hệ thống TMO (M2)
       hay bài toán Kaggle/dataset (M1)?"

Mission type quyết định output cuối:
  ├── M1: Submission / Dataset / Documentation → User
  └── M2: PROPOSAL → SELF-DIRECTION (chờ phê duyệt)
```

**Sau khi classify — RECEIVE với request M1 (ví dụ):**

```
User: "Tham gia House Prices competition trên Kaggle"

NEMESIS nhận request (mission: M1):
───────────────────────────────────────────────────
1. Đọc competition page:
   - Objective: Predict SalePrice (regression)
   - Metric: RMSE (log-transformed)
   - Data: train.csv (1460 rows, 79 features), test.csv
   - Deadline: 3 tháng
   
2. Đọc data dictionary:
   - 20 continuous features
   - 14 discrete features  
   - 23 nominal categorical
   - 23 ordinal categorical
   - Key features: OverallQual, GrLivArea, Neighborhood

3. Đọc forum top posts:
   - "Log transform SalePrice important"
   - "Outliers: Id 524, 1299"
   - "Target encoding works well"

4. Phân tích ban đầu:
   → Đây là regression task trên tabular data nhỏ
   → Gradient Boosting sẽ mạnh
   → Feature engineering quan trọng hơn model tuning
   → Data leakage risk cao (nhỏ dataset)
───────────────────────────────────────────────────
```

**RECEIVE với request M2 (ví dụ):**

```
User: "Hệ thống chat của TMO chậm, nghiên cứu và đề xuất khắc phục"

NEMESIS nhận request (mission: M2):
───────────────────────────────────────────────────
1. Đọc hiện trạng hệ thống:
   - Health check: service nào connected, đâu degraded?
   - dev.log: lỗi/warning gần nhất, latency patterns
   - UI status: các module đang hiển thị gì?
   
2. Đọc docs hệ thống:
   - README: kiến trúc tổng thể
   - .env.example: các service đang dùng
   
3. Phân tích ban đầu:
   → Vấn đề nằm ở khu vực nào? (LLM? search? UI?)
   → Có số đo cụ thể chưa? (latency, token, memory)
   → Scope: 1 module hay toàn pipeline?
───────────────────────────────────────────────────
```

#### Nhiệm vụ 2: TRIAGE — Đánh giá Complexity & Chọn Tier

Đây là quyết định quan trọng nhất — sai tier = lãng phí thời gian HOẶC chất lượng kém.

```
NEMESIS đánh giá toàn bộ competition (M1):
───────────────────────────────────────────────────
Tiêu chí 1: Phạm vi = 3 (Multi-module pipeline)
  → Cần EDA + Feature Eng + Models + Ensemble + Submission
  
Tiêu chí 2: Độ sâu suy luận = 3 (Cần research + thử nghiệm)
  → Không biết trước features nào tốt, models nào mạnh nhất
  
Tiêu chí 3: Rủi ro sai = 2 (Trung bình-cao)
  → Kaggle có public LB feedback → bù đắp rủi ro
  → Nhưng small dataset → overfitting risk

Tổng: 3 + 3 + 2 = 8 → COMPLEX (Tier 3)

Nhưng trong competition, KHÔNG phải mọi part đều Complex:
───────────────────────────────────────────────────
  Part 1: EDA                  → MEDIUM (5 điểm)
  Part 2: Feature Engineering  → COMPLEX (8 điểm)  
  Part 3: Model Building       → COMPLEX (7 điểm)
  Part 4: Ensemble & Submit    → MEDIUM (6 điểm)

→ Competition tổng thể = COMPLEX
→ Nhưng TL sẽ chọn tier CHO TỪNG PART
───────────────────────────────────────────────────
```

**Ví dụ TRIAGE cho M2 (System Research):**

```
Request: "Đề xuất nâng cấp kiến trúc bộ nhớ TMO"

NEMESIS đánh giá:
  Phạm vi = 3 (đụng 3 store: Qdrant + Neo4j + SQLite + pipeline)
  Suy luận = 3 (cần audit + design + trade-offs)
  Rủi ro = 2 (thay đổi bộ nhớ ảnh hưởng toàn hệ)
  → Tổng 8 → COMPLEX (Tier 3)

  Part 1: Audit hiện trạng     → COMPLEX (8)
  Part 2: Root cause analysis  → MEDIUM (5)
  Part 3: Thiết kế options     → COMPLEX (7)
  Part 4: Proposal + Verify Plan → MEDIUM (4)
```

**Nguyên tắc TL:** Mission tổng thể = Complex, nhưng Part có thể là Simple/Medium. TL linh hoạt chọn tier cho từng part.

#### Nhiệm vụ 3: DECOMPOSE — Chia nhỏ bài toán thành Parts

**Bản M1 — Kaggle:**

```
NEMESIS chia House Prices thành 6 Parts:
───────────────────────────────────────────────────

Part 0: Setup & Baseline (SIMPLE)
  ├── Tạo project structure
  ├── Load data, basic stats
  ├── Submit baseline (mean prediction)
  └── Output: project skeleton + baseline submission

Part 1: EDA (MEDIUM)
  ├── Missing value analysis
  ├── Distribution analysis
  ├── Correlation analysis
  ├── Outlier detection
  └── Output: insights cho Feature Engineering

Part 2: Feature Engineering (COMPLEX)
  ├── Numeric transforms (log, box-cox)
  ├── Categorical encoding (target, freq, ordinal)
  ├── Interaction features
  ├── Domain features (TotalSF, BathRatio)
  └── Output: feature pipeline + selected features

Part 3: Model Building (COMPLEX)
  ├── Train XGBoost, LightGBM, CatBoost
  ├── Hyperparameter tuning
  ├── Cross-validation
  └── Output: trained models + CV scores

Part 4: Ensemble & Optimization (MEDIUM)
  ├── Stacking / Weighted average
  ├── Final feature selection
  ├── LB probing (nếu cần)
  └── Output: final ensemble + LB score

Part 5: Submission & Documentation (SIMPLE)
  ├── Generate submission file
  ├── Write solution summary
  ├── Push to Kaggle
  └── Output: submitted + documented
```

**Bản M2 — System Research (chia theo module/layer):**

```
NEMESIS chia "Đề xuất nâng cấp bộ nhớ TMO" thành 4 Parts:

Part 1: Audit hiện trạng (COMPLEX)
  ├── SIVIL dispatch SAs đọc code + 3 stores + logs
  └── Output: Findings schema (hiện trạng + điểm yếu)

Part 2: Phân tích root cause (MEDIUM)
  ├── LISMA truy vết evidence cho từng điểm yếu
  └── Output: root cause list + severity

Part 3: Thiết kế options (COMPLEX)
  ├── HAN đề xuất 2-3 options kèm trade-offs
  ├── BELI viết POC minh họa (nếu cần, trong Workspace)
  └── Output: options comparison

Part 4: Proposal & Verification Plan (MEDIUM)
  ├── NEMESIS tổng hợp PROPOSAL theo Proposal Schema
  └── Output: Proposal → SELF-DIRECTION
```

#### Nhiệm vụ 4: ASSIGN — Giao task cho Group phù hợp

```
TL quyết định workflow cho từng Part (M1):

Part 0: SIMPLE → TL → G2 → TL → DONE
  "LISMA setup project structure và baseline submission"

Part 1: MEDIUM → TL → G1 → G2 → TL → DONE
  "BELI code EDA, LISMA review, tôi kiểm tra insights"

Part 2: COMPLEX → TL → G1 → G2 → G3 → TL → LOOP
  "Full pipeline — SIVIL explore approaches, BELI code,
   LISMA fix, HAN optimize features"

Part 3: COMPLEX → TL → G1 → G2 → G3 → TL → LOOP
  "Full pipeline — Model building & tuning"

Part 4: MEDIUM → TL → G1 → G2 → TL → DONE
  "Ensemble không cần tối ưu sâu"

Part 5: SIMPLE → TL → G2 → TL → DONE
  "LISMA viết submission và documentation"
```

**Ví dụ giao task cụ thể cho Part 2:**

```
TL tạo task_complex_part2.md:
─────────────────────────────────────
# Task: Feature Engineering
- **ID**: T-HP-002
- **Mission**: M1
- **Tier**: Complex
- **Part**: 2/6
- **Competition**: House Prices
- **Status**: Pending

## Mô tả
Xây dựng feature engineering pipeline dựa trên insights 
từ Part 1 (EDA). Cần xử lý missing values, transform 
numeric features, encode categorical features, tạo 
interaction và domain features.

## Input
- train.csv, test.csv
- EDA insights (từ Part 1 worklog):
  + 19 features có missing values
  + 6 numeric features bị skew > 0.75
  + OverallQual correlation = 0.79
  + 2 outliers: Id 524, 1299

## Output kỳ vọng
- Feature engineering pipeline (fit/transform)
- Clean train + test dataframes
- Feature importance ranking (preliminary)

## Constraints
- MUST: Fit trên train only, transform trên test (no leakage)
- MUST: K-Fold target encoding cho high-cardinality features
- SHOULD: Log transform SalePrice trước khi train
- AVOID: One-hot encoding cho features > 10 categories
─────────────────────────────────────
```

**Template task M2:**

```
TL tạo task_m2_part1.md:
─────────────────────────────────────
# Task: Audit Memory Architecture
- **ID**: T-M2-001
- **Mission**: M2
- **Tier**: Complex
- **Part**: 1/4
- **Status**: Pending

## Mô tả
Audit toàn bộ kiến trúc bộ nhớ của TMO: Qdrant, Neo4j,
SQLite — cấu trúc, luồng dữ liệu, điểm yếu.

## Input
- Source code memory system
- dev.log, PM2 logs
- Health check hiện tại (39,615 nodes Neo4j, 52 PDFs R2,
  Qdrant collections...)

## Output kỳ vọng
- Findings schema: mỗi finding kèm evidence (file:line/log)
- Severity ranking cho từng finding

## Constraints
- MUST: Mọi finding kèm evidence cụ thể
- MUST: KHÔNG sửa bất kỳ file nào của TMO
- SHOULD: Đánh dấu finding nào ảnh hưởng user-facing
- AVOID: Đọc toàn bộ codebase — theo Module Map + Artifact Map
─────────────────────────────────────
```

#### Nhiệm vụ 5: MONITOR — Theo dõi tiến độ qua Worklog + Code

```
TL đọc worklog sau khi G3 hoàn thành Part 2 (M1):
───────────────────────────────────────────────────

## 2024-01-15 10:30 — G1 — T-HP-002
- **Đã làm**: SIVIL dispatch 10 sub-agents explore features.
  BELI code: missing handler, log transform, target encoding,
  interaction features, domain features (TotalSF, BathRatio)
- **Vấn đề**: Log(0) edge case trong transform
- **Đề xuất cho G2**: Xử lý shift trước log transform
- **Files**: src/features/missing.py, transform.py, encode.py

## 2024-01-15 11:15 — G2 — T-HP-002
- **Đã làm**: Review 5 files, fix 6 bugs:
  + Log(0) edge case (HIGH) → Fixed
  + Data leakage in target encoding (CRITICAL) → Fixed
  + 2 edge cases in missing handler (MEDIUM) → Fixed
  + 1 performance issue in interaction loop (MEDIUM) → Fixed
  + 1 regression bug from fix #1 (LOW) → Fixed
- **Đề xuất cho G3**: "Nên thử stacking features thay vì 
  chỉ individual transforms"
- **Files**: All 5 files updated

## 2024-01-15 12:00 — G3 — T-HP-002
- **Đã làm**: Tối ưu feature engineering
  + Feature selection: 180 → 72 features (RFE)
  + Tuning: K-Fold encoding (5-fold) thay vì single-fold
  + Simplification: Pipeline 5 bước → 3 bước
  + CV improvement: 0.134 → 0.121 (baseline → after features)
- **Lessons learned**:
  + "Target encoding 5-fold stable hơn single-fold"
  + "Interaction features top-10 quan trọng nhất"
- **Recommendations cho TL**:
  + "Feature engineering done. Ready cho model building."
  + "Nên train XGBoost + LightGBM + CatBoost"
  + "CatBoost xử lý categorical tốt — nên ưu tiên"
───────────────────────────────────────────────────

TL đánh giá:
  ✅ 6 bugs fixed (including CRITICAL data leakage)
  ✅ CV improvement: 0.134 → 0.121
  ✅ Features: 180 → 72 (reasonable)
  ✅ G3 recommends tiếp tục model building
  → TL đọc code key sections (stacking logic, CV strategy)
  → Xác nhận K-Fold encoding đúng ✅
  → CHẤP NHẬN → Chuyển sang Part 3
```

**MONITOR bản M2:** Worklog có thêm trường `Mission: M2` và Findings + Evidence thay cho Metrics. TL VERIFY theo tiêu chí evidence-based (xem section Read-Write-Verify Loop).

**MONITOR & Knowledge Capture:** Khi đọc worklog mà phát hiện lesson/insight KB chưa có → NEMESIS ghi NGAY theo KB Write Protocol (không đợi FINALIZE). Đặc biệt quan trọng với tier SIMPLE/MEDIUM không đi qua G3: MONITOR + FINALIZE là 2 thời điểm duy nhất để tri thức không bị mất.

#### Nhiệm vụ 6: DECIDE — Quyết định nâng/hạ tier & Pivot

Đây là năng lực quan trọng nhất của TL — nhận ra khi nào cần thay đổi kế hoạch.

**Kịch bản 1: Nâng cấp tier (Medium → Complex)**

```
TL giao Part 4 (Ensemble) là MEDIUM:
  TL → G1 (BELI) → G2 (LISMA) → TL

G1 code weighted average ensemble → CV 0.118
G2 review → sạch, pass

NHƯNG TL đọc G2 worklog:
  "G2 suggestion: Weighted avg cho 0.118 nhưng 
   Stacking có thể cho 0.115. Tuy nhiên Stacking 
   phức tạp hơn — cần K-Fold stacking để tránh leakage."

TL suy nghĩ:
  "0.118 vs 0.115 — chênh 0.003 trên Kaggle là NHIỀU.
   Stacking cần K-Fold → phức tạp hơn dự kiến.
   → NÂNG CẤP Part 4 lên COMPLEX
   → Gọi lại G1 (SIVIL explore stacking strategies) 
   → G2 fix → G3 optimize
   → Worth the extra time cho 0.003 improvement"
```

**Kịch bản 2: Hạ cấp tier (Complex → Medium)**

```
TL giao Part 3 (Model Building) là COMPLEX:
  TL → G1 → G2 → G3 → TL

G1 dispatch 15 sub-agents explore models
→ Best: XGBoost tuned CV 0.118
→ 2nd: LightGBM tuned CV 0.119

G2 review → fix bugs → pass

G3 optimize → tuning, ensemble → CV 0.115

TL đọc worklog:
  "Stacking XGB + LGBM cho 0.115. Good.
   Nhưng CatBoost yếu (0.125) → không đáng thêm vào ensemble.
   Feature selection đã good (72 features)."

TL quyết định:
  "Model building ổn định. Không cần thêm exploration.
   Part 3 hoàn thành.
   → Phần còn lại chỉ là tuning nhỏ + submission
   → HẠ CẤP Part 4 xuống MEDIUM (không cần full pipeline)"
```

**Kịch bản 3: Pivot — Thay đổi hướng hoàn toàn**

```
TL nhận feedback từ Public Leaderboard:
  CV Score: 0.115
  Public LB: 0.142 ← SHOCKING GAP!

TL phân tích:
  "Gap CV-LB quá lớn (0.027). Nguyên nhân có thể:
   1. Data leakage trong CV (CV optimistic)
   2. Train/test distribution shift
   3. Overfitting trên CV"

TL đọc lại ALL worklogs → Tìm thấy:
  "G3 lesson: Target encoding 5-fold.
   Nhưng G2 không check K-Fold stacking leakage!"

TL đọc code liên quan:
  → Đọc cross_validation.py → Phát hiện stacking leakage!
  → Meta-model train trên predictions chứa target info

TL quyết định PIVOT:
  → DỪNG Part 4
  → QUAY LẠI Part 2 + Part 3
  → Tạo task mới: "Audit data leakage toàn pipeline"
  → Giao G2 (LISMA): Deep audit tất cả leakage sources
  → Sau khi fix → Re-run models → Re-submit
  → Chỉ tiếp tục Part 4 khi CV-LB gap < 0.01
```

**Kịch bản Pivot bản M2:**

```
G1 (SIVIL) report finding: "Latency 121s do LLM key 401"
NHƯNG LISMA đọc logs phát hiện:
  "Code KHÔNG hề retry — log 121s là do timeout mặc định
   của HTTP client + fail-open path xử lý 4 keys lần lượt.
   Finding của G1 sai root cause!"

TL (NEMESIS) VERIFY:
  → Claim của G1 mâu thuẫn logs → PHẢI PIVOT
  → Yêu cầu G1 re-audit khu vực key pool với evidence
  → Chỉ nhận finding nào có file:line + log excerpt khớp nhau
```

#### Nhiệm vụ 7: FINALIZE — Hoàn thành & Báo cáo

**Bản M1 — Kaggle:**

```
TL tổng kết toàn bộ competition:
───────────────────────────────────────────────────

## COMPETITION SUMMARY: House Prices

### Timeline
- Part 0 (Setup):         0.5 ngày  ✅
- Part 1 (EDA):           1 ngày    ✅
- Part 2 (Features):      2 ngày    ✅ (1 pivot for leakage audit)
- Part 3 (Models):        2 ngày    ✅ (re-run after leakage fix)
- Part 4 (Ensemble):      1 ngày    ✅
- Part 5 (Submit):        0.5 ngày  ✅
- Total: 7 ngày

### Results
- Best CV Score:  0.115 (RMSE log)
- Public LB:      0.117
- Private LB:     0.118
- CV-LB Gap:      0.002 ✅ (nhỏ = trustworthy)

### Key Decisions
1. Chọn Stacking (Ridge meta) thay vì Weighted Avg
2. Nâng cấp Part 4 lên Complex để explore stacking
3. Pivot quay lại audit leakage khi CV-LB gap lớn
4. Chọn 72 features thay vì 180

### Lessons for Future Competitions
1. ALWAYS audit leakage sau feature engineering
2. K-Fold stacking cần K-Fold target encoding bên trong
3. CatBoost weak trên small dataset → cân nhắc bỏ
4. StratifiedKFold stable hơn KFold cho regression

### Artifacts
- Code: 8 Python files, 1 pipeline
- Models: 2 (XGBoost + LightGBM) + Stacking meta
- Features: 72 selected
- Submissions: 12 (iterative improvement)
───────────────────────────────────────────────────
```

**Knowledge Capture tại FINALIZE (M1):** Toàn bộ "Lessons for Future Competitions" được NEMESIS ghi vào Knowledge Base NGAY theo KB Write Protocol — tri thức không được phép chỉ nằm trong Competition Summary. HAN sẽ curate ở chu trình G3 gần nhất (nếu task có G3).

**Bản M2 — Route vào SELF-DIRECTION:**

```
NEMESIS tổng hợp output G1/G2/G3 thành PROPOSAL DOCUMENT
theo Proposal Schema chuẩn (xem section PROPOSAL SCHEMA):

  → Route THẲNG vào module SELF-DIRECTION của TMO
  → Status: SUBMITTED — chờ user hoặc agent được ủy quyền phê duyệt
  → KHÔNG qua user inbox trung gian — SELF-DIRECTION là nơi quyết định
  → Approval có thể đến từ: user trực tiếp HOẶC agents được ủy quyền
  → Sau SUBMITTED: NEMESIS vẫn theo dõi, cập nhật nếu bị REVISED
```

### Cơ chế giao tiếp TL — Làm việc với từng Group

```
┌──────────────────────────────────────────────────────────┐
│              TL — GIAO TIẾP VỚI CÁC GROUPS                │
│                                                           │
│  TL → G1:                                                │
│  ├── Giao task.md (mô tả chi tiết, kèm mission type)     │
│  ├── Chỉ rõ: input, output kỳ vọng, constraints          │
│  └── KHÔNG chỉ cách làm — G1 tự quyết định approach      │
│                                                           │
│  TL → G2:                                                │
│  ├── Chỉ giao Simple tasks trực tiếp                     │
│  └── Không giao Medium/Complex — đi qua G1 trước         │
│                                                           │
│  TL → G3:                                                │
│  ├── KHÔNG bao giờ giao task trực tiếp                    │
│  └── G3 chỉ nhận việc từ G2 (qua pipeline)               │
│                                                           │
│  G1 → TL:                                                │
│  ├── Chỉ khi G1 gặp blocking issue                       │
│  └── TL quyết định: giúp giải quyết / thay approach      │
│                                                           │
│  G2 → TL:                                                │
│  ├── ESCALATE: Architectural issue                       │
│  ├── ESCALATE: Quá 3 vòng vẫn còn bug                    │
│  └── ESCALATE: CRITICAL bug không fix được               │
│                                                           │
│  G3 → TL:                                                │
│  ├── Recommendations (nên làm gì tiếp)                    │
│  ├── Knowledge Base updates (lessons learned)             │
│  └── Metrics (score trước/sau, improvement)               │
│                                                           │
│  NEMESIS ↔ SIVIL (RESEARCH COUNCIL):                        │
│  ├── ① Sau DECOMPOSE (trước ASSIGN)                      │
│  ├── ② Sau SYNTHESIZE (trước khi BELI code)              │
│  ├── ③ Khi G1 ESCALATE                                   │
│  ├── ④ Tại mỗi Checkpoint                                │
│  └── Output: discussion summary + KB entries mới         │
│                                                           │
└──────────────────────────────────────────────────────────┘
```

### Cơ chế nâng/hạ tier giữa chừng — Chi tiết

```
┌──────────────────────────────────────────────────────────┐
│           TL — TIER ESCALATION MATRIX                     │
│                                                           │
│  Signal nguồn          →   TL action                      │
│  ──────────────────────────────────────────────           │
│                                                           │
│  G2 ESCALATE bug        →  Đánh giá lại complexity        │
│  (architectural)           Có thể nâng tier               │
│                                                           │
│  G3 recommendation      →  Nếu đề xuất đơn giản →         │
│  (thêm approach)           Thêm vào task hiện tại          │
│                            Nếu phức tạp → Nâng tier       │
│                                                           │
│  CV-LB gap > 0.01      →  PIVOT: Quay lại audit          │
│  (kaggle signal)           Có thể hạ tier nếu issue nhỏ   │
│                                                           │
│  G1 finish nhanh hơn   →  Hạ tier nếu phần còn lại        │
│  dự kiến                   đơn giản hơn dự kiến           │
│                                                           │
│  Deadline gần          →  Hạ tier tất cả parts            │
│                            Chỉ giữ CRITICAL parts         │
│                                                           │
│  New info từ forum     →  Có thể nâng/hạ tùy              │
│  (kaggle discussion)       mức độ ảnh hưởng               │
│                                                           │
│  M2: Claim thiếu       →  PIVOT: yêu cầu re-audit        │
│  evidence                  với evidence cụ thể            │
│                                                           │
│  M2: Proposal bị       →  REVISE: giao lại group          │
│  REVISED từ                 liên quan bổ sung             │
│  SELF-DIRECTION                                            │
│                                                           │
└──────────────────────────────────────────────────────────┘
```

### TL Decision Framework — Quy trình ra quyết định

```
TL nhận thông tin mới (từ worklog / G2 escalate / LB feedback / M2: proposal feedback)
        │
        ▼
┌─── Đánh giá mức độ ảnh hưởng ────────────────────────┐
│                                                        │
│  🔴 CRITICAL: Ảnh hưởng kết quả cuối cùng             │
│     → PIVOT ngay, có thể quay lại parts trước         │
│     → ĐỌC CODE liên quan để hiểu vấn đề               │
│                                                        │
│  🟡 MODERATE: Cải thiện tiềm năng nhưng không urgent  │
│     → Nâng tier part hiện tại, thêm bước xử lý        │
│     → Có thể đọc code nếu cần hiểu sâu                │
│                                                        │
│  🟢 MINOR: Nice-to-have, không ảnh hưởng lớn          │
│     → Ghi vào backlog, xử lý sau nếu có thời gian     │
│     → Không cần đọc code                               │
│                                                        │
└────────────────────────────────────────────────────────┘
        │
        ▼
┌─── Đánh giá rủi ro thay đổi ─────────────────────────┐
│                                                        │
│  Thay đổi ảnh hưởng bao nhiêu parts đã hoàn thành?     │
│   → 0 parts: Safe → Proceed                           │
│   → 1 part:  Cần re-run 1 part → Worth it?            │
│   → 2+ parts: Cần re-run nhiều → Chỉ khi CRITICAL     │
│                                                        │
│  Deadline còn bao lâu?                                 │
│   → Nhiều thời gian: Thử thay đổi                     │
│   → Ít thời gian: Chỉ thay đổi CRITICAL               │
│                                                        │
│  (M2) Thay đổi có phá dịch vụ đang chạy không?        │
│   → Có → Bắt buộc rollback path trong Proposal        │
│                                                        │
└────────────────────────────────────────────────────────┘
        │
        ▼
    QUYẾT ĐỊNH:
    ├── Proceed (tiếp tục theo kế hoạch)
    ├── Adjust (thay đổi tier / thêm bước)
    ├── Pivot (quay lại, sửa parts trước)
    └── Drop (bỏ qua, tập trung phần khác)
```

### Schema tổng hợp — TL Internal Workflow:

```
User Request (Kaggle / System Research / dataset / documentation)
        │
        ▼
┌─── NEMESIS (Team Leader) ────────────────────────────────┐
│                                                          │
│  0. CLASSIFY: Phân loại mission                         │
│     ├── M1 — Kaggle Research                            │
│     ├── M2 — System Research (TMO)                      │
│     └── Ambiguous → hỏi user 1 câu                      │
│                                                          │
│  1. RECEIVE: Đọc & hiểu toàn bộ request                 │
│     ├── M1: Đọc competition description / task spec     │
│     └── M2: Đọc system docs / logs / health check       │
│                                                          │
│  2. TRIAGE: Đánh giá complexity                          │
│     ├── Chấm điểm: Phạm vi + Suy luận + Rủi ro          │
│     ├── Chọn tier: Simple / Medium / Complex             │
│     └── Linh hoạt: Tier cho TỪNG PART, không toàn bộ    │
│                                                          │
│  3. DECOMPOSE: Chia nhỏ thành parts                      │
│     ├── M1: Chia theo dependency (part nào cần trước)   │
│     ├── M2: Chia theo module/layer                      │
│     ├── Tạo .md cho từng part                            │
│     └── Sắp xếp priority & thứ tự                        │
│                                                          │
│  4. ASSIGN: Giao task cho groups                         │
│     ├── Simple → G2 trực tiếp                            │
│     ├── Medium → G1 → G2                                 │
│     └── Complex → G1 → G2 → G3                           │
│                                                          │
│  5. MONITOR: Theo dõi qua worklog + code                 │
│     ├── Đọc worklog sau mỗi group hoàn thành             │
│     ├── Đọc code KEY sections khi cần verify             │
│     ├── Đọc code khi ESCALATE hoặc kết quả bất thường    │
│     └── KHÔNG sửa code — chỉ quyết định                  │
│                                                          │
│  6. DECIDE: Quyết định nâng/hạ tier & pivot              │
│     ├── G2 ESCALATE → Nâng tier hoặc pivot               │
│     ├── CV-LB gap lớn / M2 claim thiếu evidence → Pivot  │
│     ├── Hoàn thành nhanh → Hạ tier                       │
│     └── Deadline áp → Hạ tất cả xuống minimum            │
│                                                          │
│  7. FINALIZE: Hoàn thành & báo cáo                       │
│     ├── M1: Tổng kết results + lessons → Báo cáo user    │
│     └── M2: PROPOSAL → SELF-DIRECTION (chờ phê duyệt)   │
│                                                          │
│  Output:                                                 │
│  ├── Progress tracking (parts done/remaining)            │
│  ├── Decision log (mọi quyết định + lý do)              │
│  └── M1: Final report / M2: Proposal                    │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

### Tóm tắt cơ chế TL:

| Khía cạnh | Cơ chế |
|-----------|--------|
| **Vai trò chính** | Tư duy & Điều phối — KHÔNG code |
| **CLASSIFY mission** | Mọi request → M1 (Kaggle) / M2 (System Research); ambiguous → hỏi 1 câu |
| **7 Nhiệm vụ** | Classify+Receive → Triage → Decompose → Assign → Monitor → Decide → Finalize |
| **Tier linh hoạt** | Chọn tier CHO TỪNG PART, không phải toàn bộ mission |
| **Đọc code** | Chọn lọc: Key sections / ESCALATE / Kết quả bất thường / M2 claim thiếu evidence |
| **KHÔNG sửa code** | TL đọc để HIỂU → giao lại cho G2/G3 sửa |
| **Nâng tier khi** | G2 ESCALATE / G3 recommend complex / New info |
| **Hạ tier khi** | Hoàn thành nhanh hơn dự kiến / Deadline áp |
| **Pivot khi M1** | CV-LB gap > 0.01 / CRITICAL issue / Fundamental approach sai |
| **Pivot khi M2** | Claim thiếu evidence / code mâu thuẫn logs / proposal phá compatibility |
| **Giao tiếp** | Giao task qua .md, nhận feedback qua worklog |
| **Decision Framework** | Ảnh hưởng → Rủi ro → Quyết định (Proceed/Adjust/Pivot/Drop) |
| **Output M1** | Decision log + Progress tracking + Final report |
| **Output M2** | Proposal → SELF-DIRECTION |

---

## 🔬 TL RESEARCH DECOMPOSITION — PHÂN TÍCH SÂU CHO RESEARCH TEAM

> **QUAN TRỌNG:** Đây là RESEARCH TEAM (dual mission), KHÔNG PHẢI code team.
> TL phân tích sâu theo cách của Giám đốc Nghiên cứu, KHÔNG phải Kiến trúc sư phần mềm.

### Sự khác biệt cốt lõi: Research Decomposition vs. Code Decomposition

```
┌─────────────────────────────────────────────────────────────┐
│   CODE TEAM (SAI — không phải cách chúng ta làm)            │
│                                                              │
│   TL phân tích: "Module A cần class X, method Y, API Z"    │
│   TL triển khai: "File structure, class diagram, DB schema" │
│   Groups thực thi: "Implement theo design — giống y spec"   │
│                                                              │
│   → TL giống KIẾN TRÚC SƯ phần mềm                         │
│   → Spec = bản vẽ kỹ thuật chi tiết                         │
│   → Groups chỉ việc "theo bản vẽ mà xây"                    │
│                                                              │
│   KẾT QUẢ: Nếu design sai → toàn bộ sai → phải rebuild     │
│                                                              │
├─────────────────────────────────────────────────────────────┤
│   RESEARCH TEAM (ĐÚNG — cách chúng ta làm)                  │
│                                                              │
│   TL phân tích: "Bài toán thuộc loại gì? Data đặc điểm gì? │
│                   Winning pattern thường là gì?"             │
│   (M2: "Hiện trạng hệ thống gì? Điểm yếu ở đâu?            │
│          Pattern nâng cấp phù hợp?")                        │
│   TL triển khai: "Hypotheses, experimental design,          │
│                    success criteria, decision gates"         │
│   Groups thực thi: "Thử nghiệm hypotheses, chạy experiments,│
│                      tối ưu based on results"                │
│                                                              │
│   → TL giống GIÁM ĐỐC NGHIÊN CỨU (Research Director)       │
│   → Spec = đề cương nghiên cứu (research protocol)          │
│   → Groups tự quyết định CÁCH THỰC HIỆN dựa trên data      │
│                                                              │
│   KẾT QUẢ: Hypothesis sai → thử hypothesis khác → linh hoạt│
└─────────────────────────────────────────────────────────────┘
```

### 3 Lý do TL KHÔNG thể triển khai logic chi tiết như code team

**Lý do 1: Kaggle/System Research là bài toán THÍ NGHIỆM, không phải bài toán XÂY DỰNG**

```
Xây dựng phần mềm:              Thí nghiệm nghiên cứu:
─────────────────────            ─────────────────────
BIẾT kết quả cần gì →           KHÔNG BIẾT approach nào tốt nhất →
Thiết kế chi tiết →             Thử nghiệm nhiều approaches →
Implement theo design            Khám phá → Tối ưu dựa trên data

→ Predictable                     → Emergent
→ Deterministic                   → Experimental
→ Design-first                    → Data-driven
```

**Lý do 2: DATA/LOGS quyết định approach, KHÔNG PHẢI TL**

```
TL có thể dự đoán:                              TL KHÔNG THỂ biết:
─────────────────────────                        ──────────────────────────
"Gradient Boosting thường mạnh trên tabular"    "XGBoost tune cho 0.115,
"Target encoding tốt cho high-cardinality"       CatBoost chỉ 0.125"
"Ensemble thường beat single model"              "Feature X giúp 0.003,
"Small dataset → overfitting risk cao"           Feature Y không giúp gì"
(M2) "Fail-fast thường giảm latency"            (M2) "Latency 121s là do key 401
                                                  hay do timeout HTTP client?"

→ TL chỉ đưa HƯỚNG, không đưa KẾT QUẢ
→ Chỉ có EXPERIMENT/EVIDENCE mới trả lời được
→ G1 (SIVIL sub-agents) explore song song để tìm KẾT QUẢ
```

**Lý do 3: Overfit plan = THUA**

```
Nếu TL viết:  "Dùng XGBoost với learning_rate=0.01,
               max_depth=5, target encoding cho tất cả
               categorical features"

Nhưng data thực tế: LGBM + frequency encoding cho 0.003 tốt hơn

→ Làm theo TL = thua competitor dùng LGBM
→ Research team cần LINH HOẠT, không rigid
→ TL chỉ định HƯỚNG, Groups tự TÙY CHỈNH theo data
```

### TL cung cấp GÌ? — Research Protocol 5 lớp

Thay vì triển khai logic chi tiết, TL cung cấp **5 lớp định hướng nghiên cứu**:

```
┌─────────────────────────────────────────────────────────────┐
│         TL RESEARCH PROTOCOL — 5 LỚP ĐỊNH HƯỚNG             │
│                                                              │
│  ┌───────────────────────────────────────────────────────┐   │
│  │ Lớp 1: RESEARCH DIRECTION (Định hướng nghiên cứu)    │   │
│  │                                                       │   │
│  │ Bài toán thuộc loại gì?                               │   │
│  │  → Classification / Regression / Time-series /       │   │
│  │    NLP / CV / Tabular / Multimodal                    │   │
│  │  (M2: Memory / Execution / Thinking / Tools / UI)     │   │
│  │                                                       │   │
│  │ Data đặc điểm gì?                                     │   │
│  │  → Size (small/medium/large)                         │   │
│  │  → Quality (clean/noisy/missing)                     │   │
│  │  → Distribution (balanced/imbalanced/skewed)         │   │
│  │  → Type (tabular/image/text/graph)                   │   │
│  │  (M2: Logs có gì? Services đang healthy không?)      │   │
│  │                                                       │   │
│  │ Winning pattern phổ biến cho loại bài toán này?       │   │
│  │  → Top solutions từ competitions tương tự            │   │
│  │  → Papers / blog posts / kaggle write-ups liên quan  │   │
│  │  → Domain knowledge cần thiết                        │   │
│  │  (M2: Patterns nâng cấp hệ thống đã được chứng minh) │   │
│  └───────────────────────────────────────────────────────┘   │
│                          │                                    │
│                          ▼                                    │
│  ┌───────────────────────────────────────────────────────┐   │
│  │ Lớp 2: HYPOTHESES (Giả thuyết cần kiểm chứng)        │   │
│  │                                                       │   │
│  │ H1: "Target encoding sẽ tốt hơn one-hot cho           │   │
│  │      high-cardinality features"                       │   │
│  │ H2: "Gradient Boosting ensemble sẽ mạnh nhất"         │   │
│  │ H3: "Outlier removal giúp cải thiện score"            │   │
│  │ H4: "Feature engineering quan trọng hơn model tuning"  │   │
│  │ H5: "Stacking sẽ outperform weighted average"          │   │
│  │ (M2) H: "Fail-fast + key health check sẽ giảm          │   │
│  │      chat latency từ 121s xuống < 10s")                │   │
│  │                                                       │   │
│  │ Mỗi hypothesis có:                                    │   │
│  │  → Priority: HIGH / MEDIUM / LOW                     │   │
│  │  → Rationale: Tại sao TL nghĩ giả thuyết này đúng?   │   │
│  │  → Risk: Nếu sai thì ảnh hưởng thế nào?              │   │
│  └───────────────────────────────────────────────────────┘   │
│                          │                                    │
│                          ▼                                    │
│  ┌───────────────────────────────────────────────────────┐   │
│  │ Lớp 3: EXPERIMENTAL DESIGN (Thiết kế thí nghiệm)      │   │
│  │                                                       │   │
│  │ CV Strategy: KFold / Stratified / Group / Time-split? │   │
│  │  → Số folds? Random state?                            │   │
│  │  → Có dùng GroupKFold không? (nếu có group ID)       │   │
│  │                                                       │   │
│  │ Evaluation metric: RMSE / AUC / F1 / mAP / ...?       │   │
│  │  → Metric chính thức của competition?                 │   │
│  │  → (M2) Metric hệ thống: latency, token cost, uptime?│   │
│  │                                                       │   │
│  │ Baseline: Điểm tham chiếu để đánh giá cải thiện?      │   │
│  │  → Baseline = mean/mode prediction cho bao nhiêu?    │   │
│  │  → (M2) Baseline = số đo hiện tại từ logs            │   │
│  │                                                       │   │
│  │ Ablation: Cách kiểm tra từng hypothesis riêng?         │   │
│  │  → Thêm 1 feature/lần → measure delta                │   │
│  │  → Thay 1 model → measure delta                      │   │
│  │  → (M2) Thay 1 config → measure latency trước/sau    │   │
│  │                                                       │   │
│  │ Comparison: So sánh approaches thế nào cho công bằng? │   │
│  │  → Cùng CV strategy, cùng features, chỉ khác model   │   │
│  │  → Cùng model, chỉ khác features                     │   │
│  └───────────────────────────────────────────────────────┘   │
│                          │                                    │
│                          ▼                                    │
│  ┌───────────────────────────────────────────────────────┐   │
│  │ Lớp 4: SUCCESS CRITERIA (Tiêu chí thành công)         │   │
│  │                                                       │   │
│  │ Score target: CV < X.XXX mới coi là improvement?      │   │
│  │  → Delta tối thiểu để ghi nhận improvement?          │   │
│  │  → So sánh với baseline/current best?                │   │
│  │  → (M2) Latency target? Coverage target?             │   │
│  │                                                       │   │
│  │ Robustness: CV-LB gap < 0.01 mới trustworthy?         │   │
│  │  → Overfitting detector: CV-LB gap threshold         │   │
│  │  → (M2) Evidence đủ: mọi claim có citation?          │   │
│  │                                                       │   │
│  │ Efficiency: Training time < Y giờ?                     │   │
│  │  → (M2) Effort ước tính S/M/L cho từng option?       │   │
│  │                                                       │   │
│  │ Simplicity: < Z features mới stable?                   │   │
│  │  → (M2) Rollback path có sẵn cho mọi thay đổi?       │   │
│  └───────────────────────────────────────────────────────┘   │
│                          │                                    │
│                          ▼                                    │
│  ┌───────────────────────────────────────────────────────┐   │
│  │ Lớp 5: DECISION GATES (Cổng quyết định)               │   │
│  │                                                       │   │
│  │ Gate 1: Sau EDA/Audit → Approaches nào đáng thử?      │   │
│  │  → Dựa trên data insights, chọn top approaches       │   │
│  │  → Loại approaches không phù hợp với data            │   │
│  │                                                       │   │
│  │ Gate 2: Sau baseline → Model nào mạnh nhất?           │   │
│  │  → So sánh CV scores giữa models                     │   │
│  │  → Chọn top-2/3 models cho ensemble                  │   │
│  │                                                       │   │
│  │ Gate 3: Sau tuning → Có đáng thêm vào ensemble?       │   │
│  │  → Model thêm có diversity không?                    │   │
│  │  → Ensemble improvement > delta threshold?           │   │
│  │                                                       │   │
│  │ Gate 4: Sau ensemble → Submit hay iterate thêm?       │   │
│  │  → Time budget còn bao nhiêu?                        │   │
│  │  → Diminishing returns?                              │   │
│  │                                                       │   │
│  │ Gate 5: LB feedback → Pivot hay continue?             │   │
│  │  → CV-LB gap kiểm tra                               │   │
│  │  → Shake-up risk assessment                          │   │
│  │  → (M2) Proposal feedback → REVISE hay APPROVE?      │   │
│  └───────────────────────────────────────────────────────┘   │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

### Ví dụ thực tế: TL phân tích House Prices Competition (M1)

```
TL (NEMESIS) nhận task: "Tham gia House Prices competition"
───────────────────────────────────────────────────────────

Bước 0: CLASSIFY → M1 (Kaggle Research) ✅

Bước 1: TL đọc & phân tích toàn bộ context
────────────────────────────────────────────────────────
→ Competition description: Predict house prices (regression)
→ Data: 1460 train samples, 79 features (mix num + cat)
→ Metric: RMSE on log(SalePrice)
→ Forum insights: "GBM strong", "Outliers: Id 524, 1299"
→ Past winners: Stacking + Feature Engineering

Bước 2: TL xây dựng Research Protocol
──────────────────────────────────────

LỚP 1 — RESEARCH DIRECTION:
┌───────────────────────────────────────────────────┐
│ Loại bài toán: Tabular Regression (small data)    │
│ Data: 1460 rows × 79 features                    │
│   → Small data → overfitting risk CAO            │
│   → Mix numeric + categorical → cần encoding     │
│   → Missing values → cần impute strategy         │
│ Winning pattern:                                 │
│   → Top 10 solutions đều dùng GBM ensemble       │
│   → Feature engineering > model tuning           │
│   → Stacking meta-model phổ biến                 │
│ Domain: Real estate                              │
│   → Location (Neighborhood) quan trọng nhất      │
│   → Size (GrLivArea, TotalSF) quan trọng          │
│   → Quality (OverallQual) quan trọng             │
└───────────────────────────────────────────────────┘

LỚP 2 — HYPOTHESES:
┌───────────────────────────────────────────────────┐
│ H1 [HIGH]: Target encoding cho Neighborhood       │
│   → Rationale: 25 categories, high-cardinality   │
│   → Risk: Nếu leak → overfitting ảo              │
│                                                    │
│ H2 [HIGH]: GBM ensemble (XGB + LGBM + Cat)        │
│   → Rationale: Tabular data + small = GBM mạnh   │
│   → Risk: CatBoost có thể yếu nếu data quá nhỏ   │
│                                                    │
│ H3 [MEDIUM]: Outlier removal (Id 524, 1299)       │
│   → Rationale: Forum mention + large GrLivArea   │
│   → Risk: Nếu không phải outlier thật → mất data │
│                                                    │
│ H4 [MEDIUM]: Log transform SalePrice              │
│   → Rationale: Metric là RMSE trên log(SalePrice) │
│   → Risk: Nếu distribution đã normal → không cần │
│                                                    │
│ H5 [LOW]: Stacking sẽ beat weighted average       │
│   → Rationale: Past winners dùng stacking        │
│   → Risk: Nếu models correlated → stacking yếu   │
│                                                    │
│ H6 [LOW]: Feature selection (RFE/Lasso)           │
│   → Rationale: 180 features sau eng → cần giảm  │
│   → Risk: Bỏ features quan trọng → giảm score   │
└───────────────────────────────────────────────────┘

LỚP 3 — EXPERIMENTAL DESIGN:
┌───────────────────────────────────────────────────┐
│ CV Strategy: 5-Fold (Stratified trên binned y)    │
│   → Small data → cần K-Fold để stable            │
│   → Stratified → đảm bảo distribution đều        │
│                                                    │
│ Metric: RMSE (log(SalePrice))                     │
│   → Metric chính thức = không cần metric phụ     │
│                                                    │
│ Baseline: Mean prediction → RMSE ≈ 0.40           │
│   → Simple model: Ridge → RMSE ≈ 0.15            │
│                                                    │
│ Ablation:                                          │
│   → Thêm 1 nhóm features/lần → measure delta     │
│   → So sánh: base features → +target_enc →       │
│     +interaction → +domain → measure mỗi bước     │
│                                                    │
│ Comparison:                                        │
│   → Tất cả models dùng CÙNG features, CÙNG CV   │
│   → Chỉ khác: model type + hyperparams           │
└───────────────────────────────────────────────────┘

LỚP 4 — SUCCESS CRITERIA:
┌───────────────────────────────────────────────────┐
│ Score target:                                      │
│   → CV RMSE < 0.120 = good                        │
│   → CV RMSE < 0.115 = very good                   │
│   → CV RMSE < 0.110 = excellent                   │
│   → Delta improvement < 0.001 = diminishing       │
│                                                    │
│ Robustness:                                        │
│   → CV-LB gap < 0.01 = trustworthy               │
│   → Std across folds < 0.005 = stable             │
│                                                    │
│ Efficiency:                                        │
│   → Training time < 10 phút (GPU)                 │
│   → Feature pipeline < 2 phút                     │
│                                                    │
│ Simplicity:                                        │
│   → < 100 features (sau selection)                │
│   → < 3 models trong ensemble                     │
└───────────────────────────────────────────────────┘

LỚP 5 — DECISION GATES:
┌───────────────────────────────────────────────────┐
│ Gate 1 (sau EDA):                                  │
│   → Nếu > 30% missing → cần advanced impute      │
│   → Nếu chỉ 5-10% missing → simple impute OK     │
│                                                    │
│ Gate 2 (sau baseline models):                      │
│   → Nếu best single model < 0.125 → tiếp tuning  │
│   → Nếu best single model > 0.130 → kiểm tra bug │
│                                                    │
│ Gate 3 (sau tuning):                              │
│   → Nếu improvement > 0.003 → thêm vào ensemble  │
│   → Nếu improvement < 0.001 → không đáng          │
│                                                    │
│ Gate 4 (sau ensemble):                            │
│   → Nếu stacking > weighted avg > 0.002 → stack  │
│   → Nếu không → weighted avg cho đơn giản        │
│                                                    │
│ Gate 5 (sau submit LB):                            │
│   → CV-LB gap < 0.01 → continue                  │
│   → CV-LB gap > 0.02 → PIVOT: audit leakage      │
└───────────────────────────────────────────────────┘
```

### So sánh Spec: Code Team vs. Research Team

```
CODE TEAM SPEC (chi tiết implementation — KHÔNG dùng):
───────────────────────────────────────────────────────
# Task: Feature Engineering
## Implementation:
1. Tạo class FeatureEngineeringPipeline với:
   - fit() method: Compute encoding maps trên train
   - transform() method: Apply encodings trên data
2. Target Encoding:
   - Dùng category_encoders library
   - smoothing = 0.3
   - 5-fold encoding để tránh leakage
3. Log Transform:
   - np.log1p() cho skewed numeric (skew > 0.75)
   - Clip values > 3 sigma trước transform
4. File output: src/features/pipeline.py
→ Groups chỉ việc IMPLEMENT theo spec, không cần suy nghĩ

RESEARCH TEAM SPEC (chi tiết nghiên cứu — CÁCH CHÚNG TA):
─────────────────────────────────────────────────────────
# Task: Feature Engineering
## Research Direction:
Tabular regression, small data → feature quality > quantity

## Hypotheses to Test:
- H1 [HIGH]: Target encoding cho high-cardinality cats
- H2 [MEDIUM]: Log transform cho skewed numerics
- H3 [MEDIUM]: Interaction features (Quality × Area)
- H4 [LOW]: Domain features (TotalSF, BathRatio)

## Experimental Design:
- CV: 5-Fold Stratified
- Ablation: base → +H1 → +H2 → +H3 → +H4 (measure each)
- Compare: same model, same CV, chỉ khác features

## Success Criteria:
- CV improvement > 0.005 per hypothesis group
- Final: CV < 0.120
- No data leakage (fit train only)

## Decision Gate:
- Nếu H1 fail → thử frequency encoding thay thế
- Nếu H3 overfit → giảm interaction degree
- Nếu tổng improvement < 0.01 → feature eng không đáng, focus model

→ Groups TỰ QUYẾT ĐỊNH cách implement
→ SIVIL explore nhiều approaches song song
→ BELI code approach được chọn
→ LISMA đảm bảo no leakage
→ HAN tối ưu feature selection
```

### Cơ chế Deep Analysis — TL phân tích SÂU nhưng KHÔNG chi tiết code

```
┌─────────────────────────────────────────────────────────────┐
│        TL DEEP ANALYSIS — SÂU NHƯNG KHÔNG MICRO             │
│                                                              │
│  TL phân tích SÂU ở mức:                                    │
│  ✅ "Bài toán này cần K-Fold CV vì small data"              │
│  ✅ "Target encoding có risk leakage → phải K-Fold encode"  │
│  ✅ "GBM mạnh nhưng CatBoost có thể yếu trên 1460 samples"  │
│  ✅ "Feature eng priority cao hơn model tuning"              │
│  ✅ "CV-LB gap cần monitor sát vì small data"               │
│  ✅ (M2) "Latency cao → check fail-open paths + key pool"   │
│                                                              │
│  TL KHÔNG phân tích chi tiết ở mức:                         │
│  ❌ "Dùng category_encoders.TargetEncoder(smoothing=0.3)"   │
│  ❌ "XGBoost params: lr=0.01, depth=5, n_estimators=3000"  │
│  ❌ "Pipeline: step1 → step2 → step3 → step4"              │
│  ❌ "File structure: src/features/, src/models/"            │
│  ❌ "Class FeatureEngineer với fit/transform interface"      │
│                                                              │
│  Nguyên tắc:                                                 │
│  TL nói CÁI GÌ cần làm, KHÔNG nói LÀM THẾ NÀO             │
│  TL chỉ RỦI RO, KHÔNG chỉ CÁCH TRÁNH                       │
│  TL đặt HYPOTHESIS, KHÔNG đặt IMPLEMENTATION                │
│  TL chọn DIRECTION, KHÔNG chọn EXECUTION                    │
│                                                              │
│  Vì "LÀM THẾ NÀO" phụ thuộc vào DATA → Groups tự quyết     │
│  Data không bao giờ giống hệt dự đoán → cần linh hoạt       │
│  Nếu TL over-specify → Groups bị gò bó → mất sáng tạo      │
└─────────────────────────────────────────────────────────────┘
```

### Tóm tắt TL Research Decomposition:

| Khía cạnh | TL cung cấp (Research) | TL KHÔNG cung cấp (Code) |
|-----------|----------------------|--------------------------|
| **Mục tiêu** | Research Direction + Hypotheses | Class diagram + API spec |
| **Chiến lược** | CV strategy + Metric + Success criteria | File structure + Code architecture |
| **Rủi ro** | Leakage risk + Overfitting risk + CV-LB gap | Runtime error + Edge case + Compatibility |
| **Quyết định** | Decision Gates (khi nào pivot/continue) | Implementation Gates (khi nào refactor) |
| **Thứ tự** | Hypothesis priority (HIGH→LOW) | Development priority (critical path) |
| **Độ sâu** | Sâu về METHODOLOGY, nông về IMPLEMENTATION | Sâu về IMPLEMENTATION, nông về METHODOLOGY |
| **Kết quả kỳ vọng** | Hypothesis confirmed/rejected + Score improvement / M2: Evidence-based findings | Feature complete + Bug-free + Deployed |
| **Linh hoạt** | Hypothesis có thể thay đổi theo data/logs | Spec phải follow chính xác |

### So sánh kết quả 2 cách tiếp cận:

```
CODE TEAM APPROACH:
────────────────────
TL: "Xây XGBoost với params A, B, C"
G1: Implement y spec
G2: Fix bugs
G3: Tune params A, B, C → improvement nhỏ
→ KẾT QUẢ: XGBoost tốt NHƯNG có thể LGBM tốt hơn → không biết

RESEARCH TEAM APPROACH:
────────────────────────
TL: "H2: GBM ensemble mạnh nhất, thử XGB + LGBM + CatBoost"
G1: SIVIL explore cả 3 models song song
    → XGBoost: 0.122, LGBM: 0.123, CatBoost: 0.125
G2: Fix bugs, ensure fair comparison
G3: Ensemble top-2 (XGB + LGBM) → 0.118
→ KẾT QUẢ: Biết LGBM close to XGB → ensemble cả hai → tốt hơn
```

---

## 🎯 GIẢI QUYẾT VẤN ĐỀ: 3-TIER WORKFLOW

**Vấn đề chưa giải quyết:** Dùng full pipeline (TL→G1→G2→G3→TL) cho task đơn giản thì lãng phí thời gian.

**Giải pháp:** Phân loại task thành 3 tier, mỗi tier có workflow khác nhau.

---

### TIER 1: SIMPLE — "Fast Track"

**Khi nào:** Sửa 1 bug nhỏ, đổi 1 tham số, viết 1 hàm tiện ích, format code, thêm comment, (M2) verify 1 config...

```
TL (NEMESIS) ──→ G2 (LISMA) ──→ TL xác nhận ──→ DONE
```

**Vì sao bỏ G1:** Task đủ đơn giản để LISMA tự làm luôn (code + fix trong 1 bước)
**Vì sao bỏ G3:** Không cần tối ưu cho task nhỏ

| Bước | Ai làm | Làm gì | Output |
|------|--------|--------|--------|
| 1 | TL | Phân tích: "Đây là Simple task" → Giao thẳng cho G2 | `task_simple.md` |
| 2 | G2 (LISMA) | Code + tự review + tự fix | Code hoàn chỉnh |
| 3 | TL | Quick check → DONE | Cập nhật worklog |

**Thời gian ước tính:** ~1-2 vòng thay vì 4+

---

### TIER 2: MEDIUM — "Standard Track"

**Khi nào:** Viết 1 feature mới, implement 1 model đơn giản, EDA cơ bản, tạo 1 visualization, (M2) chẩn đoán 1 vấn đề performance...

```
TL (NEMESIS) ──→ G1 (BELI code) ──→ G2 (LISMA fix) ──→ TL xác nhận ──→ DONE
```

**Vì sao bỏ G3:** Feature hoạt động đúng là đủ, chưa cần tối ưu

| Bước | Ai làm | Làm gì | Output |
|------|--------|--------|--------|
| 1 | TL | Phân tích: "Medium task" → Mô tả trong .md | `task_medium.md` |
| 2 | G1 (BELI) | Code lượt đầu theo spec | Code draft + worklog |
| 3 | G2 (LISMA) | Review, sửa bug, đảm bảo chạy đúng | Code sạch + worklog |
| 4 | TL | Kiểm tra kết quả → DONE hoặc yêu cầu sửa thêm | Cập nhật worklog |

**Thời gian ước tính:** ~2-3 vòng

---

### TIER 3: COMPLEX — "Full Pipeline"

**Khi nào:** Xây dựng pipeline ML hoàn chỉnh, tham gia Kaggle competition, tạo dataset lớn, research paper, (M2) redesign kiến trúc bộ nhớ / audit toàn hệ thống...

```
TL ──→ G1 (SIVIL orchestrate + BELI code) ──→ G2 (LISMA review) ──→ G3 (HAN optimize) ──→ TL ──→ ...
```

| Bước | Ai làm | Làm gì | Output |
|------|--------|--------|--------|
| 1 | TL (NEMESIS) | Phân tích: "Complex task" → Chia thành parts → Mô tả từng part trong .md | `task_complex_part1.md`, `part2.md`... |
| 2 | G1 (SIVIL + BELI) | SIVIL: parallel explore N approaches qua sub-agents → BELI: code top-K approaches | Multiple code drafts + comparison |
| 3 | G2 (LISMA) | Review tất cả approaches, fix bugs, loại approaches lỗi, đề xuất cải thiện | Code sạch + suggestions |
| 4 | G3 (HAN) | Tối ưu best approach: tuning, ensemble, feature engineering / (M2) sinh proposal items | Optimized code / Proposal items |
| 5 | TL | Đọc worklog + .md → Kiểm tra kết quả → Part tiếp theo hoặc DONE | Progress tracking |

**Thời gian ước tính:** 4+ vòng, lặp lại cho mỗi part

---

## 🧠 BẢNG QUYẾT ĐỊNH COMPLEXITY — TL DÙNG ĐỂ PHÂN LOẠI

TL (NEMESIS) đánh giá mỗi task theo 3 tiêu chí:

| Tiêu chí | Simple (1 đ) | Medium (2 đ) | Complex (3 đ) |
|----------|-------------|--------------|---------------|
| **Phạm vi** | 1 file/hàm | 1 module/feature | Multi-module/pipeline |
| **Độ sâu suy luận** | Trực tiếp, rõ ràng | Cần vài bước suy luận | Cần research, thử nghiệm |
| **Rủi ro sai** | Thấp — dễ phát hiện | Trung bình — cần test | Cao — cần nhiều vòng verify |

**Tính điểm:**
- **3 điểm** → Simple (Tier 1)
- **4-6 điểm** → Medium (Tier 2)
- **7-9 điểm** → Complex (Tier 3)

### Ví dụ thực tế trong Kaggle (M1):

| Task | Phạm vi | Suy luận | Rủi ro | Tổng | Tier |
|------|---------|----------|--------|------|------|
| Sửa lỗi import | 1 | 1 | 1 | 3 | Simple |
| Thêm logging | 1 | 1 | 1 | 3 | Simple |
| Viết hàm preprocessing | 2 | 1 | 1 | 4 | Medium |
| EDA + visualization | 2 | 2 | 1 | 5 | Medium |
| Implement XGBoost baseline | 2 | 2 | 2 | 6 | Medium |
| Build full ML pipeline | 3 | 3 | 3 | 9 | Complex |
| Ensemble 5 models | 3 | 3 | 2 | 8 | Complex |
| Feature engineering từ 0 | 3 | 3 | 3 | 9 | Complex |

### Ví dụ thực tế trong System Research (M2):

| Task | Phạm vi | Suy luận | Rủi ro | Tổng | Tier |
|------|---------|----------|--------|------|------|
| Verify 1 config có đúng không | 1 | 1 | 1 | 3 | Simple |
| Sửa 1 env var (đề xuất trong proposal) | 1 | 1 | 1 | 3 | Simple |
| Chẩn đoán chat latency cao | 2 | 2 | 2 | 6 | Medium |
| Audit 1 module (memory system) | 3 | 2 | 2 | 7 | Complex |
| Redesign kiến trúc bộ nhớ | 3 | 3 | 3 | 9 | Complex |
| Đề xuất nâng cấp quy trình tư duy | 3 | 3 | 2 | 8 | Complex |

---

## 📋 CHI TIẾT HANDOFF PROTOCOL GIỮA CÁC GROUP

### Cấu trúc file `.md` cho mỗi task:

```markdown
# Task: [Tên task]
- **ID**: T-001
- **Mission**: M1 | M2
- **Tier**: Simple / Medium / Complex
- **Part**: 1/3 (chỉ cho Complex)
- **Status**: Pending → In-Progress → Review → Done

## Mô tả
[TL mô tả chi tiết]

## Input
[Data, tài nguyên, code sẵn có]

## Output kỳ vọng
[TL chỉ rõ kết quả cần đạt]

## Constraints
[Giới hạn, yêu cầu đặc biệt]
```

### Cấu trúc `worklog.md`:

```markdown
## [Timestamp] — [Group] — [Task ID]
- **Mission**: M1 | M2
- **Đã làm**: ...
- **Vấn đề gặp phải**: ...
- **Đề xuất cho group tiếp**: ...
- **Files thay đổi**: ...
```

### Handoff flow:

```
G1 → G2:  "Code xong, đây là draft + issues tôi gặp + 
           suggestions cho G2 (VD: hàm X có thể chạy chậm)"

G2 → G3:  "Bug đã fix, code sạch. Nhưng tôi nhận thấy 
           approach Y có tiềm năng tốt hơn approach X, 
           G3 xem xét thử cả 2"

G3 → TL:  "Đã tối ưu. Approach Y cho 0.92 LB score, 
           X cho 0.89. Khuyến nghị dùng Y. 
           Có thể thử thêm Z nếu muốn"
           (M2: "Đây là proposal items + verification plan")

TL:       Đọc → Kiểm tra → Quyết định → Next part hoặc DONE
```

---

## 🔄 CƠ CHẾ READ-WRITE-VERIFY LOOP — TL LÀ RESEARCH LOOP CONTROLLER

### Vấn đề: Pipeline hiện tại là 1 chiều — thiếu vòng đọc lại

```
┌─────────────────────────────────────────────────────────────┐
│  PIPELINE HIỆN TẠI (Linear, 1 chiều)                       │
│                                                              │
│  TL ──tạo .md──▶ G1 ──worklog──▶ G2 ──worklog──▶ G3 ──▶ TL │
│                                                              │
│  TL chỉ kiểm tra Ở CUỐI. Không đọc giữa chừng.             │
│  Nếu G1 đi sai hướng → G2 cũng sai → G3 cũng sai → TL      │
│  phát hiện quá muộn → Phải làm lại từ đầu.                  │
│                                                              │
│  Ví dụ Kaggle:                                               │
│  G1 tạo features sai approach → G2 fix bug nhưng approach    │
│  vẫn sai → G3 tối ưu approach sai → CV score không cải thiện│
│  → TL phát hiện khi đọc kết quả cuối → Mất toàn bộ token    │
│  cho 3 groups = lãng phí nghiêm trọng                        │
│                                                              │
│  Ví dụ M2 (System Research):                                 │
│  G1 audit sai module → G2 chẩn đoán root cause sai → G3    │
│  đề xuất nâng cấp không giải quyết vấn đề thật → Proposal  │
│  gửi SELF-DIRECTION với giả định sai → approve sai         │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│  PIPELINE CÓ READ-WRITE-VERIFY LOOP                         │
│                                                              │
│  TL ──WRITE protocol──▶ G1 ──WRITE worklog──▶               │
│  TL ──READ worklog──▶ VERIFY ──đúng hướng?──▶               │
│  │                                            │              │
│  │  ┌──────────── YES ───────────────────────┘              │
│  │  │                                                       │
│  │  ▼                                                       │
│  │  TL ──UPDATE protocol──▶ G2 ──WRITE worklog──▶           │
│  │  TL ──READ worklog──▶ VERIFY ──đúng hướng?──▶           │
│  │  │                                            │          │
│  │  │  ┌──────────── YES ─────────────────────────┘         │
│  │  │  │                                                    │
│  │  │  ▼                                                    │
│  │  │  TL ──UPDATE protocol──▶ G3 ──WRITE worklog──▶        │
│  │  │  TL ──READ worklog──▶ VERIFY ──metric cải thiện?──▶  │
│  │  │  │                                              │     │
│  │  │  │  ┌──────────── YES ──────────────────────────┘     │
│  │  │  │  │                                              │   │
│  │  │  │  ▼                                              │   │
│  │  │  │  TL ──FINAL VERIFY ──▶ DONE ✅                  │   │
│  │  │  │  (M2: FINAL VERIFY → PROPOSAL → SELF-DIRECTION)│   │
│  │  │  │                                                  │   │
│  │  │  └── NO → TL điều chỉnh → Giao lại G3               │   │
│  │  │                                                       │
│  │  └── NO → TL điều chỉnh → Giao lại G2                   │
│  │                                                          │
│  └── NO → TL điều chỉnh hướng → Giao lại G1                 │
└─────────────────────────────────────────────────────────────┘
```

### Nguyên lý: TL = Research Loop Controller

TL trong Research Team đóng vai trò như một **Research Director** quản lý vòng lặp nghiên cứu — khác với Code Team's TL quản lý vòng lặp phát triển:

```
┌──────────────────────────────────────────────────────────────┐
│  CODE TEAM TL               ←→    RESEARCH TEAM TL          │
│  ──────────────                    ──────────────────         │
│  Kiểm tra: code đúng spec?        Kiểm tra: metric cải thiện?│
│  Verify: compile, test pass       Verify: CV score, no leak  │
│  Pivot khi: arch sai              Pivot khi: data leakage    │
│  Update: .md implementation spec  Update: Research Protocol   │
│  Đọc: Code Location Map          Đọc: Research Artifact Map  │
│  Trọng tâm: ĐÚNG (correctness)   Trọng tâm: TỐT (metric)    │
│  (M2: Verify evidence-based,     Pivot khi: claim mâu thuẫn  │
│   Update System Audit Charter)    logs/code                  │
└──────────────────────────────────────────────────────────────┘
```

### 4 Bước của Read-Write-Verify Loop (Research Version):

```
┌─────────────────────────────────────────────────────────────┐
│  READ-WRITE-VERIFY LOOP — RESEARCH VERSION                  │
│                                                              │
│  BƯỚC 1: WRITE — Ghi trạng thái nghiên cứu                  │
│  ├── Mỗi G sau khi xong → GHI worklog                       │
│  ├── Worklog bao gồm:                                        │
│  │   ├── Đã làm gì (experiments, features, models)          │
│  │   ├── Mission: M1 | M2                                    │
│  │   ├── M1: Metrics (CV score, LB score, so sánh trước/sau)│
│  │   ├── M2: Findings + Evidence (file:line, log excerpt)   │
│  │   ├── Issues: data leakage, overfitting, instability /   │
│  │   │         system issues                                 │
│  │   ├── Research Artifact Map (xem phần sau)               │
│  │   ├── Hypothesis status: CONFIRMED / REJECTED / PENDING  │
│  │   └── Next experiments đề xuất                            │
│  └── G ghi ra file .md → External Memory cho team           │
│                                                              │
│  BƯỚC 2: READ — TL đọc lại worklog                          │
│  ├── TL đọc METRICS/FINDINGS trước, chi tiết sau            │
│  ├── TL nắm được:                                           │
│  │   ├── Metric có cải thiện không? (M1 North Star)        │
│  │   ├── Mọi claim có evidence chưa? (M2 North Star)       │
│  │   ├── Hypothesis nào confirmed/rejected?                  │
│  │   ├── Có data leakage / system issue signal không?      │
│  │   └── Có đi sai hướng nghiên cứu không?                  │
│  └── Token: ~1-2K cho worklog (nhẹ, hiệu quả)               │
│                                                              │
│  BƯỚC 3: VERIFY — TL kiểm tra hướng nghiên cứu              │
│  ├── So sánh worklog với Research Protocol gốc               │
│  ├── M1: Metric cải thiện so với baseline?                  │
│  ├── M2: (1) Evidence-based — mỗi claim có citation?        │
│  │         (2) Completeness — đủ module coverage?           │
│  │         (3) Feasibility — không phá hệ đang chạy?        │
│  ├── Phát hiện sớm nếu sai → Không lan rộng                 │
│  └── Quyết định: CONTINUE / PIVOT / ESCALATE                │
│                                                              │
│  BƯỚC 4: UPDATE — Cập nhật Research Protocol                │
│  ├── Nếu CONTINUE → Cập nhật progress → Giao group tiếp     │
│  ├── Nếu PIVOT → Điều chỉnh hypothesis → Chạy lại experiment│
│  ├── Nếu ESCALATE → Dừng → Báo user → Chờ quyết định       │
│  └── Update Research Protocol / System Audit Charter        │
└─────────────────────────────────────────────────────────────┘
```

### 3 Checkpoint Schedule — Khi nào TL PHẢI đọc lại:

Research Team có **3 Checkpoint** (thay vì 4 như Code Team, vì Research chỉ có G1/G2/G3):

```
┌─────────────────────────────────────────────────────────────┐
│  CHECKPOINT SCHEDULE — RESEARCH TEAM                         │
│                                                              │
│  CHECKPOINT 1: Sau G1 hoàn thành Exploration & First Draft   │
│  ├── TL ĐỌC G1 worklog + Artifact Map                       │
│  ├── VERIFY:                                                │
│  │   ├── Approaches có phù hợp Research Protocol không?      │
│  │   ├── Hypotheses đang được kiểm tra đúng cách?            │
│  │   ├── Sub-agents có phát hiện insights quan trọng?        │
│  │   ├── M2: Findings có đủ evidence cụ thể không?           │
│  │   └── Direction có đúng hướng không?                      │
│  │   ├── YES → Cập nhật Protocol → Giao G2                  │
│  │   └── NO  → TL điều chỉnh → Giao lại G1                 │
│  └── Rationale: G1 đi sai approach → G2 fix bug vẫn sai     │
│                → G3 optimize sai approach → total waste      │
│                                                              │
│  CHECKPOINT 2: Sau G2 hoàn thành Review & Bug Fix            │
│  ├── TL ĐỌC G2 worklog + Updated Artifact Map               │
│  ├── VERIFY:                                                │
│  │   ├── Data leakage đã được fix chưa? (M1 Priority #1)   │
│  │   ├── M2: Root cause có khớp code + logs không?          │
│  │   ├── Code chạy đúng không? / M2: Fix proposal hợp lý?  │
│  │   ├── Có concerns cần TL xác nhận không?                  │
│  │   └── Bugs còn lại có ảnh hưởng metric không?            │
│  │   ├── YES → Cập nhật Protocol → Giao G3                  │
│  │   ├── NO (còn CRITICAL) → Giao lại G2                    │
│  │   └── ESCALATE → TL quyết định                           │
│  └── Rationale: Data leakage chưa fix → G3 tối ưu vô nghĩa  │
│                → M2: root cause sai → proposal sai           │
│                                                              │
│  CHECKPOINT 3: Sau G3 hoàn thành Optimization                │
│  ├── TL ĐỌC G3 worklog + Final Artifact Map + Metrics       │
│  ├── VERIFY:                                                │
│  │   ├── Metric thực sự cải thiện? (CV score so với base)   │
│  │   ├── CV-LB gap có trong ngưỡng an toàn? (< 0.01)        │
│  │   ├── M2: Mỗi proposal item có Verification Plan?        │
│  │   ├── Optimization có gây regression không?               │
│  │   ├── Feature selection có justify không?                 │
│  │   └── Ensemble stable không? (std across folds)           │
│  │   ├── YES → FINAL VERIFY → DONE ✅                       │
│  │   │        (M2: → PROPOSAL → SELF-DIRECTION)             │
│  │   ├── NO (metric không cải thiện) → Giao lại G3          │
│  │   └── NO (fundamental issue) → PIVOT về G1               │
│  └── Rationale: Metric không cải thiện = approach sai        │
│                → Cần pivot thay vì optimize thêm             │
│                                                              │
│  LƯU Ý:                                                     │
│  ├── Tier 1: Chỉ có CP2 (TL → G2 → TL)                     │
│  ├── Tier 2: Có CP1, CP2 (TL → G1→G2 → TL)                 │
│  └── Tier 3: Có đủ 3 Checkpoint (Full pipeline)             │
└─────────────────────────────────────────────────────────────┘
```

### Pivot Triggers — Khi nào TL PHẢI điều chỉnh (Research Version):

```
┌──────────────────────────────────────────────────────────────┐
│  TL PIVOT TRIGGERS — RESEARCH TEAM                           │
│                                                               │
│  🔴 PHẢI PIVOT ngay:                                        │
│  ├── G2 phát hiện: DATA LEAKAGE trong pipeline (M1)         │
│  │   → DỪNG → Fix leakage → Re-run từ đầu                  │
│  ├── CV-LB gap > 0.02 (M1)                                  │
│  │   → CV optimistic → Metric không đáng tin                │
│  ├── G1 báo: "Hypothesis fundamental sai"                   │
│  │   → VD: "Target encoding không giúp cho data này"        │
│  ├── TL đọc worklog thấy: "Metric WORSE sau optimization"   │
│  ├── G3 ESCALATE: "Overfitting nghiêm trọng — không fix được│
│  │   trong G3 scope"                                         │
│  ├── M2: Claim trong findings THIẾU EVIDENCE                 │
│  │   → Re-audit với yêu cầu citation                        │
│  ├── M2: Code mâu thuẫn logs                                 │
│  │   → Root cause sai → chẩn đoán lại                       │
│  └── M2: Proposal có thể phá compatibility hệ thống          │
│                                                               │
│  🟡 CÓ THỂ PIVOT:                                           │
│  ├── Model plateau: 3 lần tuning không cải thiện > 0.001    │
│  ├── G3 suggest: "Approach khác (VD: NN) có thể tốt hơn"    │
│  ├── Metric fluctuation: CV score không stable (std > 0.01) │
│  ├── Feature engineering không hiệu quả: improvement < 0.003│
│  ├── Public LB feedback cho kết quả khác kỳ vọng            │
│  ├── G2/G3 suggest thay đổi approach                        │
│  ├── M2: Scope creep — audit lan rộng hơn yêu cầu           │
│  ├── M2: Nghiên cứu trùng lặp (đã có proposal tương tự)     │
│  └── M2: POC không tái hiện được                            │
│                                                               │
│  🟢 KHÔNG CẦN PIVOT:                                        │
│  ├── Bugs nhỏ, G2 đang fix trong loop                       │
│  ├── G3 minor tuning improvements (±0.001)                  │
│  ├── Progress đúng kế hoạch, metric cải thiện ổn định       │
│  ├── G2 notes về edge cases — trong tầm kiểm soát           │
│  ├── CV-LB gap < 0.005 — kết quả trustworthy               │
│  └── M2: Findings minor, không ảnh hưởng proposal chính    │
│                                                               │
│  HÀNH ĐỘNG SAU PIVOT:                                        │
│  ├── PIVOT nhỏ → TL điều chỉnh hypothesis → Giao lại G đó   │
│  │   → VD: "H1 fail → Thử H1-alt: frequency encoding"      │
│  ├── PIVOT lớn → TL viết lại Research Protocol → G1 lại     │
│  │   → VD: "GBM không hiệu quả → Thử Neural Net"           │
│  │   → M2: "Audit sai layer → Viết lại Audit Charter"      │
│  ├── PIVOT leakage → G2 deep audit → Re-run G1/G2/G3       │
│  │   → VD: "Target encoding leak → Fix + Re-train tất cả"  │
│  └── ESCALATE → TL dừng pipeline → Báo user                │
│      → VD: "Data quality quá kém → Cần thêm data"          │
└──────────────────────────────────────────────────────────────┘
```

### Cấu trúc Worklog chuẩn hóa (Research Version):

```markdown
## Worklog — [Task Name] — Part [N]

### Meta
- Mission: M1 | M2
- Status: IN_PROGRESS | COMPLETED | BLOCKED | ESCALATED
- Current Phase: G1 | G2 | G3
- Overall Progress: [N]%
- TL Read-Back: ✅ VERIFIED | ⚠️ NEEDS REVIEW | 🔴 PIVOT NEEDED

### Metrics: (bắt buộc với M1)
| Metric | Before | After | Delta | Status |
|--------|--------|-------|-------|--------|
| CV Score | 0.134 | 0.125 | -0.009 | ✅ Improved |
| CV Std | 0.008 | 0.005 | -0.003 | ✅ More stable |
| Features | 79 | 72 | -7 | ✅ Reduced |
| Runtime | — | 45 min | — | ⚠️ Monitor |

### Findings & Evidence: (bắt buộc với M2)
| # | Finding | Evidence (file:line / log) | Severity | Đề xuất |
|---|---------|---------------------------|----------|---------|
| 1 | Chat latency 121s khi key 401 | dev.log:xx, key-pool.ts:xx | 🔴 HIGH | Fail-fast + timeout |
| 2 | NEO4J_DATABASE sai tên DB | .env + neo4j.ts | 🟠 MEDIUM | Sửa config |

### Hypothesis Status: (M1)
| ID | Hypothesis | Status | Evidence |
|----|-----------|--------|----------|
| H1 | Target encoding tốt hơn one-hot | ✅ CONFIRMED | CV: 0.125 vs 0.131 |
| H2 | GBM ensemble mạnh nhất | 🔄 TESTING | Partial: XGB 0.122 |
| H3 | Outlier removal giúp | ✅ CONFIRMED | CV: 0.125 vs 0.128 |

### Completed:
- [x] [Item 1] — [mô tả ngắn + metric impact]
- [x] [Item 2] — [mô tả ngắn + metric impact]

### In Progress:
- [ ] [Item 3] — [mô tả ngắn]

### Issues Found:
- 🔴 CRITICAL: [mô tả] — [artifact, type]
- 🟠 HIGH: [mô tả] — [artifact, type]
- 🟡 MEDIUM: [mô tả] — [artifact, type]
- 🟢 LOW: [mô tả] — [artifact, type]

### Suggestions cho group sau:
1. [Suggestion 1]
2. [Suggestion 2]

### Concerns cần TL xác nhận:
1. [Concern 1]
2. [Concern 2]

### Research Artifact Map:
(Xem chi tiết phần "CƠ CHẾ DIRECTED READING + RESEARCH ARTIFACT MAP")

### Next Steps:
- [Step 1]
- [Step 2]
```

### Ví dụ Read-Write-Verify Loop — Part 2: Feature Engineering (M1):

```
G1 (SIVIL + BELI) hoàn thành Feature Engineering First Draft
    │
    ▼
TL (NEMESIS) — CHECKPOINT 1:
┌──────────────────────────────────────────────────────┐
│ TL ĐỌC G1 Worklog:                                   │
│                                                       │
│ Status: COMPLETED                                     │
│ Metrics:                                              │
│ | Metric    | Before  | After   | Delta  | Status |  │
│ | CV Score  | 0.134   | 0.128   | -0.006 | ✅     |  │
│ | Features  | 79      | 180     | +101   | ⚠️     |  │
│                                                       │
│ Hypothesis Status:                                    │
│ | ID | Hypothesis         | Status    | Evidence    | │
│ | H1 | Target encoding    | ✅ CONF   | CV 0.125   | │
│ | H2 | Interaction feats  | 🔄 TEST   | Partial    | │
│ | H3 | Domain features    | ❌ REJECT | CV 0.130   | │
│                                                       │
│ Issues:                                               │
│ 🟡 Log(0) edge case trong transform                  │
│                                                       │
│ Concerns:                                             │
│ 1. "180 features nhiều → overfitting risk cao"        │
│ 2. "H3 fail: Domain features không giúp"             │
│                                                       │
│ TL VERIFY:                                            │
│ → CV improvement: 0.006 ✅ đáng ghi nhận             │
│ → 180 features: QUÁ NHIỀU ⚠️ → G2 cần check leak    │
│ → H1 confirmed ✅, H3 rejected → Update Protocol     │
│ → H3 rejected = pivot nhỏ → Bỏ domain features       │
│                                                       │
│ TL UPDATE Protocol:                                   │
│ → Ghi: H3 REJECTED — bỏ domain features              │
│ → Ghi: "G2 PHẢI check leakage cho target encoding"  │
│ → Ghi: "G3 PHẢI làm feature selection (180 quá nhiều)"│
│ → Cập nhật progress: Part 2 — G1 done → Giao G2     │
└──────────────────────────────────────────────────────┘
    │
    ▼
G2 (LISMA) hoàn thành Review & Fix
    │
    ▼
TL (NEMESIS) — CHECKPOINT 2:
┌──────────────────────────────────────────────────────┐
│ TL ĐỌC G2 Worklog:                                   │
│                                                       │
│ Status: COMPLETED                                     │
│ Bugs Fixed:                                           │
│ 🔴 1 CRITICAL: Data leakage target encoding — Fixed ✅│
│ 🟠 2 HIGH: Edge cases log(0) — Fixed ✅               │
│ 🟡 2 MEDIUM: Performance + interaction — Fixed ✅     │
│                                                       │
│ Metrics after fix:                                    │
│ | Metric    | Before Fix | After Fix | Delta  |     │
│ | CV Score  | 0.128      | 0.127     | -0.001 | ✅  │
│ | Features  | 180        | 180       | 0      | —   │
│                                                       │
│ (CV score tăng nhẹ sau fix leakage — trước đó         │
│  metric bị optimistic do leakage)                     │
│                                                       │
│ Suggestions:                                          │
│ 1. "Nên thử stacking features thay vì individual"     │
│ 2. "Nên K-Fold target encoding (5-fold)"             │
│                                                       │
│ TL VERIFY:                                            │
│ → CRITICAL leakage đã fix ✅ — RẤT QUAN TRỌNG        │
│ → CV score tăng nhẹ sau fix = leakage fix đúng ✅     │
│ → 180 features vẫn nhiều → G3 cần feature selection  │
│ → Suggestions hợp lý → Chuyển cho G3 xét duyệt      │
│                                                       │
│ TL UPDATE Protocol:                                   │
│ → Ghi: "Leakage đã fix — target encoding an toàn"    │
│ → Ghi: "G3 PHẢI feature selection + K-Fold encoding" │
│ → Cập nhật progress: Part 2 — G2 done → Giao G3     │
└──────────────────────────────────────────────────────┘
    │
    ▼
G3 (HAN) hoàn thành Optimization
    │
    ▼
TL (NEMESIS) — CHECKPOINT 3 + FINAL VERIFY:
┌──────────────────────────────────────────────────────┐
│ TL ĐỌC G3 Worklog:                                   │
│                                                       │
│ Status: COMPLETED                                     │
│ Optimizations:                                        │
│ ✅ Feature selection: 180 → 72 (RFE, top 95% imp)    │
│ ✅ K-Fold target encoding (5-fold)                   │
│ ✅ Pipeline simplification: 5 bước → 3 bước          │
│                                                       │
│ Final Metrics:                                        │
│ | Metric    | G1 Output | G2 Output | G3 Output |   │
│ | CV Score  | 0.128     | 0.127     | 0.121     |   │
│ | CV Std    | 0.008     | 0.006     | 0.003     |   │
│ | Features  | 180       | 180       | 72        |   │
│ | Runtime   | —         | 45 min    | 22 min    |   │
│                                                       │
│ Lessons Learned:                                      │
│ + "Target encoding 5-fold stable hơn single-fold"    │
│ + "Top-60 features: 95% cumulative importance"       │
│ + "Interaction features top-10 quan trọng nhất"      │
│                                                       │
│ Recommendations cho TL:                               │
│ 1. "Feature engineering done. Ready cho model building"│
│ 2. "Nên train XGBoost + LightGBM + CatBoost"         │
│ 3. "CatBoost xử lý categorical tốt — ưu tiên"        │
│                                                       │
│ TL FINAL VERIFY:                                      │
│ → CV improvement: 0.134 → 0.121 (giảm 9.7%) ✅      │
│ → CV Std: 0.003 — RẤT stable ✅                      │
│ → Features: 72 — hợp lý cho 1460 rows ✅             │
│ → No leakage concerns ✅                              │
│ → Part 2 DONE ✅ → Chuyển sang Part 3                │
└──────────────────────────────────────────────────────┘
```

### So sánh trước và sau có Read-Write-Verify Loop (Research):

```
┌──────────────────────┬──────────────────┬───────────────────────┐
│ Khía cạnh            │ Không có Loop    │ Có Read-Write-Verify  │
├──────────────────────┼──────────────────┼───────────────────────┤
│ Phát hiện sai hướng  │ Cuối cùng (TL)   │ Sau mỗi Group (TL)    │
│ Phát hiện leakage    │ Khi LB fail      │ Ngay sau G2 (CP2)     │
│ Phát hiện claim sai  │ (M2) Sau approve │ (M2) Ngay sau G1/G2   │
│ Chi phí sửa sai      │ Làm lại từ đầu   │ Chỉ sửa Group đó      │
│ Token lãng phí       │ Cao (3Gs đều sai)│ Thấp (phát hiện sớm)  │
│ TL control           │ Chỉ ở đầu + cuối │ Liên tục qua worklog  │
│ Hypothesis tracking  │ Không có         │ CONFIRMED/REJECTED/PEND│
│ Metric monitoring    │ Chỉ ở cuối       │ Sau mỗi Checkpoint    │
│ Khả năng pivot       │ Không có cơ chế  │ Có Pivot Triggers     │
│ Worklog              │ G tự ghi         │ Chuẩn hóa + TL đọc lại│
└──────────────────────┴──────────────────┴───────────────────────┘
```

---

## 🎯 CƠ CHẾ DIRECTED READING + RESEARCH ARTIFACT MAP — ĐỌC NGHIÊN CỨU THÔNG MINH

### Vấn đề: G2/G3 cần đọc ARTIFACT THẬT, không chỉ .md + worklog

```
┌────────────────────────────────────────────────────────┐
│  THÔNG TIN MÀ WORKLOG CUNG CẤP:                       │
│                                                         │
│  ✅ "Đã tạo feature pipeline — xử lý missing + encode" │
│  ✅ "CV score cải thiện 0.006"                          │
│  ✅ (M2) "Đã audit xong module memory"                  │
│                                                         │
│  ❌ KHÔNG CHO BIẾT:                                    │
│  → Feature nào quan trọng nhất? (importance ranking)   │
│  → Code nào có data leakage risk?                      │
│  → Notebook nào cần đọc, cái nào bỏ qua?               │
│  → Artifact nào ảnh hưởng metric nhiều nhất?            │
│  → Dataset nào đã clean, cái nào chưa?                  │
│  → (M2) File/log nào chứa evidence cho finding?        │
└────────────────────────────────────────────────────────┘

Worklog = BẢN ĐỀ XUẤT, Artifact = THỰC TẾ
Review/Fix/Optimize phải làm trên THỰC TẾ, không phải trên ĐỀ XUẤT
```

### Sự khác biệt: Code Location Map vs Research Artifact Map

```
┌──────────────────────────────────────────────────────────────┐
│  CODE TEAM — CODE LOCATION MAP                               │
│  ──────────────────────────────                               │
│  Cấu trúc: STATIC — Code đã viết, bug ở vị trí cố định      │
│  Format: file:line:issue                                     │
│  Ví dụ: service.ts:45:Null check thiếu                       │
│  Đọc: File → Line → Fix                                      │
│  Nature: Xây dựng — biết rõ output cần gì                    │
│                                                               │
├──────────────────────────────────────────────────────────────┤
│  RESEARCH TEAM — RESEARCH ARTIFACT MAP                       │
│  ────────────────────────────────────                         │
│                                                               │
│  Cấu trúc: DYNAMIC — Mỗi bước tạo artifact mới               │
│  Format (M1): artifact:type:metric_impact                    │
│  Ví dụ: target_encoding:feature:CV -0.006                    │
│  Format (M2): file:type:relevance:status                     │
│  Ví dụ: src/lib/memory.ts:source:core-target:audited         │
│  Đọc: Artifact → Impact → Action                             │
│  Nature: Thí nghiệm — không biết trước kết quả               │
│                                                               │
│  Artifact Chain trong Kaggle (M1):                            │
│  raw_data → clean_data → features → models → preds → submit  │
│  Artifact Chain trong System Research (M2):                  │
│  source_code → analysis_report → findings → proposal → POC   │
│  Mỗi bước tạo artifact mới, mỗi artifact có metric impact    │
└──────────────────────────────────────────────────────────────┘
```

### 3 Lớp thông tin G2/G3 cần để làm đúng việc (Research Version):

```
┌─────────────────────────────────────────────────────────────┐
│  3 LỚP THÔNG TIN G2/G3 CẦN — RESEARCH VERSION              │
│                                                              │
│  LỚP 1: RESEARCH PROTOCOL (Từ TL)                           │
│  ├── "Hypotheses cần kiểm tra là gì?"                        │
│  ├── "Success criteria: CV score < bao nhiêu?"               │
│  ├── "CV strategy + Metric chính thức?"                      │
│  ├── "Decision Gates: khi nào pivot?"                        │
│  ├── (M2) "System Audit Charter: phạm vi audit?"            │
│  └── Vai trò: North Star — biết đúng/sai so với hypothesis   │
│                                                              │
│  LỚP 2: WORKLOG + ARTIFACT MAP (Từ G trước)                 │
│  ├── "G trước tạo artifact nào? Metric impact?"             │
│  ├── "Hypothesis nào confirmed/rejected?"                    │
│  ├── "Artifact nào cần đọc, artifact nào bỏ qua?"           │
│  ├── "Có data leakage / system concerns không?"             │
│  └── Vai trò: Context + Bản đồ — biết focus vào đâu         │
│                                                              │
│  LỚP 3: GROUND TRUTH                                        │
│  ├── M1: Code + Notebooks + Data                             │
│  │   ├── "Code thực sự viết như thế nào?"                   │
│  │   ├── "Feature importance ranking?"                      │
│  │   ├── "Data distributions sau transform?"                │
│  │   └── "Model training logs + CV results?"                │
│  ├── M2: Source Code + Docs + Logs + Config + UI            │
│  │   ├── "Code memory/execution/thinking chạy thế nào?"     │
│  │   ├── "Logs nói gì về hành vi thực?"                     │
│  │   ├── "Config đang set gì?"                              │
│  │   └── "UI đang hiển thị gì cho user?"                    │
│  └── Vai trò: GROUND TRUTH — đây mới là thứ cần sửa/tối ưu  │
│                                                              │
│  THIẾU BẤT KỲ LỚP NÀO = LÀM SAI VIỆC:                     │
│  ├── Thiếu Lớp 1 → Không biết hypothesis nào đang test       │
│  ├── Thiếu Lớp 2 → Không biết artifact nào quan trọng       │
│  └── Thiếu Lớp 3 → Chỉ tối ưu trên giấy, không trên thực tế│
└─────────────────────────────────────────────────────────────┘
```

### Chiến lược Directed Reading — 4 Bước (Research Version):

```
┌─────────────────────────────────────────────────────────────┐
│  CHIẾN LƯỢC DIRECTED READING CHO G2/G3 — RESEARCH VERSION  │
│                                                              │
│  BƯỚC 1: ĐỌC ARTIFACT MAP TRƯỚC (Lớp 2)                    │
│  ├── Artifact Map cho biết: artifact nào có vấn đề,          │
│  │   loại issue nào, metric impact bao nhiêu                 │
│  ├── Artifact Map là BẢN ĐỒ                                 │
│  │   → Cho biết CODE/NB/LOG NÀO cần đọc, CÁI NÀO bỏ qua    │
│  └── Token: ~1-2K (nhẹ)                                     │
│                                                              │
│  BƯỚC 2: ĐỌC CODE/NB/LOG THEO CHỈ ĐIỂM (Lớp 3 — selective)│
│  ├── Chỉ đọc artifacts được Artifact Map đánh dấu            │
│  ├── Chỉ đọc functions/classes có metric impact              │
│  ├── M2: Đọc file/log chứa evidence cho findings liên quan  │
│  ├── KHÔNG đọc artifacts hoàn thành tốt (✅ trong Map)      │
│  ├── KHÔNG đọc notebooks EDA nếu chỉ là visualization       │
│  └── Token: ~3-6K (vừa phải)                                │
│                                                              │
│  BƯỚC 3: ĐỌC RESEARCH PROTOCOL ĐỂ VERIFY (Lớp 1)           │
│  ├── So artifact/code với hypothesis gốc                     │
│  ├── Chỉ đọc phần Protocol liên quan đến artifacts đang xét │
│  └── Token: ~1-2K (nhẹ)                                     │
│                                                              │
│  BƯỚC 4: FIX/OPTIMIZE + VERIFY + UPDATE MAP                 │
│  ├── Sửa code / tối ưu pipeline / (M2) hoàn thiện findings   │
│  ├── M1: Chạy CV → So sánh metric trước/sau                 │
│  ├── M2: Xác minh evidence lần cuối → update finding status │
│  ├── Cập nhật worklog + Artifact Map                        │
│  └── Token: ~2-4K                                           │
│                                                              │
│  TỔNG TOKEN: ~7-14K (vừa trong budget của G2/G3)            │
└─────────────────────────────────────────────────────────────┘
```

### Research Artifact Map — Thêm vào Worklog:

Mỗi G khi ghi worklog PHẢI bao gồm Research Artifact Map — bản đồ chỉ đường cho G sau:

```markdown
### Research Artifact Map — G1 Worklog (Feature Engineering)

#### Artifact Chain:
| Artifact | Type | Metric Impact | Status | G2 nên đọc? |
|----------|------|--------------|--------|-------------|
| train_clean.csv | Dataset | — | ✅ Done | ❌ Bỏ qua |
| test_clean.csv | Dataset | — | ✅ Done | ❌ Bỏ qua |
| missing_handler.py | Code | CV: base→0.132 | ✅ Done | ❌ Bỏ qua |
| log_transform.py | Code | CV: 0.132→0.131 | ⚠️ Done | ✅ Đọc Line 18 |
| target_encoding.py | Code | CV: 0.131→0.125 | ⚠️ Done | ✅ Đọc ALL |
| interaction_feats.py | Code | CV: 0.125→0.124 | ✅ Done | ❌ Bỏ qua |
| domain_feats.py | Code | CV: 0.124→0.125 | ❌ Worsen | ✅ Đọc ALL |
| feature_importance.csv | Data | — | ✅ Done | ✅ Đọc ranking |

#### Issues chi tiết:
| # | Artifact | Location | Type | Severity | Mô tả |
|---|----------|----------|------|----------|-------|
| 1 | target_encoding.py | fit() | Data Leak | 🔴 CRITICAL | Encoding dùng toàn bộ dataset |
| 2 | log_transform.py | Line 18 | Edge Case | 🟡 MEDIUM | Log(0) không xử lý |
| 3 | domain_feats.py | ALL | Logic | 🟠 HIGH | Features làm WORSE — cần review |

#### Metric Impact Summary:
| Change | CV Before | CV After | Delta | Verdict |
|--------|-----------|----------|-------|---------|
| Missing handling | 0.134 | 0.132 | -0.002 | ✅ Worth |
| Log transform | 0.132 | 0.131 | -0.001 | ✅ Worth |
| Target encoding | 0.131 | 0.125 | -0.006 | ✅ BEST |
| Interaction feats | 0.125 | 0.124 | -0.001 | ✅ Worth |
| Domain feats | 0.124 | 0.125 | +0.001 | ❌ WORSEN |

#### Reading Strategy cho G2:
1. 🔴 Ưu tiên ĐẦU: target_encoding.py — Data Leakage (CRITICAL!)
2. 🟠 Ưu tiên 2: domain_feats.py — Review logic (HIGH)
3. 🟡 Ưu tiên 3: log_transform.py — Edge case (MEDIUM)
4. ❌ KHÔNG CẦN ĐỌC: missing_handler.py, interaction_feats.py, train/test_clean.csv
5. ✅ NÊN ĐỌC: feature_importance.csv — Understand feature ranking
```

**Ví dụ Artifact Map M2 — Audit Memory Architecture:**

```markdown
### Research Artifact Map — G1 Worklog (Memory Audit — M2)

#### Artifact Chain:
| Artifact | Type | Relevance | Status | G2 nên đọc? |
|----------|------|-----------|--------|-------------|
| memory-system.ts | Source | Core target | ✅ Audited | ✅ Đọc ALL |
| qdrant-client.ts | Source | Core target | ✅ Audited | ✅ Đọc collections |
| neo4j.ts | Source | Core target | ✅ Audited | ✅ Đọc connection |
| dev.log (last 500) | Log | Evidence source | ✅ Scanned | ✅ Đọc warnings |
| health-check output | Log | Baseline | ✅ Captured | ❌ Bỏ qua |
| audit-report.md | Report | G1 output | ✅ Done | ✅ Đọc findings |

#### Issues chi tiết:
| # | Artifact | Location | Type | Severity | Mô tả |
|---|----------|----------|------|----------|-------|
| 1 | neo4j.ts | Line 45 | Config Issue | 🟠 HIGH | DB name hardcoded sai |
| 2 | dev.log | Multiple | Performance | 🔴 CRITICAL | 121s requests khi key fail |

#### Findings & Evidence:
| # | Finding | Evidence | Severity | Đề xuất |
|---|---------|----------|----------|---------|
| 1 | Chat latency 121s | dev.log + key-pool retry path | 🔴 HIGH | Fail-fast |
| 2 | Vector search trống | Qdrant 0/52 docs | 🟠 MEDIUM | Re-ingest pipeline |
```

### G2 vs G3 — Cùng đọc artifacts nhưng FOCUS khác nhau:

```
┌──────────────────────────────────────────────────────────────┐
│  G2 vs G3 — KHÁC NHAU Ở CHIẾN LƯỢC ĐỌC — RESEARCH VERSION  │
│                                                               │
│  G2 (LISMA — Review & Fix):                                  │
│  ├── Đọc: data flow, leakage paths, logic flow, edge cases   │
│  │   (M2: stack traces, log warnings, error paths,           │
│  │        fail-open paths, config mismatch)                   │
│  ├── Tìm: data leakage, logic bugs, incorrect CV,            │
│  │         target leakage in features, overfitting signals    │
│  │   (M2: root cause, integration issues, config bugs)      │
│  ├── Sửa: làm cho pipeline CHẠY ĐÚNG + AN TOÀN              │
│  │   (M2: chẩn đoán + đề xuất fix trong proposal)            │
│  ├── Chiến lược đọc: THEO LEAKAGE/BUG LOCATIONS (M1)         │
│  │   / THEO SUSPECT LOCATIONS (M2)                           │
│  │   từ Artifact Map                                         │
│  │   → Chỉ đọc artifacts có issues                           │
│  │   → Focus vào data flow: fit/transform order              │
│  │   → Check: train/test split trước mọi transform           │
│  │   → M2: check error paths trước happy paths              │
│  └── Token: ~4-8K (selective reading)                        │
│                                                               │
│  G3 (HAN — Optimize):                                        │
│  ├── Đọc: feature importance, model behavior, CV strategy,   │
│  │         pipeline efficiency, ensemble potential            │
│  │   (M2: component → dependencies → user-facing effect)     │
│  ├── Tìm: unnecessary features, suboptimal hyperparams,      │
│  │         improvement opportunities, redundancy,             │
│  │         feature interaction opportunities                  │
│  │   (M2: upgrade opportunities, pattern áp dụng được)       │
│  ├── Tối ưu: làm cho pipeline CHẠY TỐT NHẤT (metric)        │
│  │   (M2: proposal items + verification plan)                │
│  ├── Chiến lược đọc: THEO METRIC IMPACT CHAIN (M1)           │
│  │   / THEO IMPACT CHAIN (M2)                                │
│  │   → Đọc feature_importance.csv → Xác định top features    │
│  │   → Đọc model training logs → Understand behavior         │
│  │   → Đọc CV strategy → Verify trustworthiness             │
│  │   → Đọc artifact chain → Tìm optimization opportunities   │
│  │   → M2: đọc theo chuỗi component → dependencies →         │
│  │     user-facing effect để tìm điểm đòn bẩy               │
│  └── Token: ~6-10K (wider reading, nhưng vẫn selective)      │
│                                                               │
│  VÍ DỤ:                                                      │
│  G2 đọc target_encoding.py: "Fit trên toàn dataset → Leak!"  │
│  G3 đọc target_encoding.py: "5-fold encoding stable hơn"     │
│                                                               │
│  G2 đọc feature_importance.csv: "Có feature nào leak??"      │
│  G3 đọc feature_importance.csv: "Top-60 đủ, 120 bottom xóa"  │
│                                                               │
│  (M2) G2 đọc dev.log: "121s request = retry path lỗi"        │
│  (M2) G3 đọc dev.log: "6.2s sau config = baseline mới"       │
│                                                               │
│  G2: SỬA LỖI AN TOÀN (safety fix) / M2: CHẨN ĐOÁN ĐÚNG      │
│  G3: TỐI ƯU METRIC (metric improvement) / M2: ĐỀ XUẤT TỐT  │
└──────────────────────────────────────────────────────────────┘
```

### Ví dụ Directed Reading — G2 sửa Data Leakage (M1):

```
G2 (LISMA) nhận handoff từ G1:

BƯỚC 1: ĐỌC RESEARCH ARTIFACT MAP
┌──────────────────────────────────────────────────────┐
│ Artifact Map từ G1:                                  │
│                                                       │
│ ❌ BỎ QUA (4 artifacts):                              │
│    train_clean.csv + test_clean.csv +                 │
│    missing_handler.py + interaction_feats.py          │
│                                                       │
│ ✅ CẦN ĐỌC (3 artifacts):                            │
│    target_encoding.py — 🔴 CRITICAL (Data Leak)      │
│    domain_feats.py — 🟠 HIGH (Worsen metric)         │
│    log_transform.py — 🟡 MEDIUM (Edge case)          │
│                                                       │
│ 📊 NÊN ĐỌC (1 artifact):                             │
│    feature_importance.csv — Understand ranking        │
│                                                       │
│ Ưu tiên: 🔴 trước → 🟠 → 🟡                         │
└──────────────────────────────────────────────────────┘

BƯỚC 2: ĐỌC CODE SELECTIVE
┌──────────────────────────────────────────────────────┐
│ Đọc target_encoding.py (45 dòng ≈ 200 tokens):      │
│                                                       │
│ def target_encode(df, col, target):                   │
│     means = df.groupby(col)[target].mean()            │
│     # ❌ Dùng toàn bộ dataset — TRAIN + TEST!        │
│     df[col + '_te'] = df[col].map(means)             │
│ → Tìm bug: CRITICAL — Data Leakage!                  │
│ → Fix: Split trước, fit trên train only              │
│                                                       │
│ Đọc domain_feats.py (60 dòng ≈ 250 tokens):          │
│ def create_domain_features(df):                       │
│     df['TotalSF'] = df['TotalBsmtSF'] + df['1stFlrSF']│
│     # ❌ TotalBsmtSF có NaN → TotalSF có NaN         │
│ → Tìm bug: HIGH — NaN propagation                     │
│ → Fix: fillna trước khi tạo domain features          │
│                                                       │
│ Đọc log_transform.py (30 dòng ≈ 120 tokens):         │
│ def log_transform(df, col):                           │
│     df[col + '_log'] = np.log(df[col])               │
│     # ❌ log(0) = -inf                               │
│ → Tìm bug: MEDIUM — Edge case                        │
│ → Fix: np.log1p() hoặc clip + shift                  │
└──────────────────────────────────────────────────────┘

BƯỚC 3: ĐỌC RESEARCH PROTOCOL (liên quan)
┌──────────────────────────────────────────────────────┐
│ Chỉ đọc phần "Feature Engineering" trong Protocol    │
│ → "MUST: Fit trên train only, transform trên test" ✅│
│    Confirm: target_encoding.py VIOLATES constraint   │
│ → "AVOID: One-hot encoding cho features > 10 cats" ✅│
│ → "SHOULD: Log transform skewed features" ✅         │
│ Token: ~200                                          │
└──────────────────────────────────────────────────────┘

BƯỚC 4: FIX + VERIFY + UPDATE MAP
┌──────────────────────────────────────────────────────┐
│ Fix 3 bugs theo severity: CRITICAL → HIGH → MEDIUM   │
│ Verify từng fix bằng CV score:                       │
│                                                       │
│ Before fix: CV 0.125 (leaked → optimistic)           │
│ After fix:  CV 0.127 (honest score — lower but real) │
│                                                       │
│ Cập nhật Research Artifact Map:                      │
│                                                       │
│ | Artifact | Status | G3 nên đọc? |                   │
│ |----------|--------|-------------|                   │
│ | target_encoding.py | ✅ Fixed | ✅ Đọc (optimize) │
│ | domain_feats.py | ✅ Fixed | ✅ Đọc (review)      │
│ | log_transform.py | ✅ Fixed | ❌ Bỏ qua           │
│ | feature_importance.csv | ⚠️ Stale | ✅ Re-compute │
│                                                       │
│ G3 Reading Strategy:                                  │
│ ✅ Đọc feature_importance.csv → Feature selection    │
│ ✅ Đọc target_encoding.py → K-Fold encoding          │
│ ✅ Đọc domain_feats.py → Review usefulness           │
│ ✅ Đọc interaction_feats.py → Check redundancy       │
│ ❌ Bỏ qua: missing_handler.py, log_transform.py      │
└──────────────────────────────────────────────────────┘

TỔNG TOKEN G2 SỬ DỤNG: ~5-6K
(Thay vì 10-12K nếu đọc toàn bộ artifacts)
```

### Dynamic Artifact Chain — Bản chất đặc biệt của Research Team:

```
┌──────────────────────────────────────────────────────────────┐
│  DYNAMIC ARTIFACT CHAIN — RESEARCH TEAM ĐẶC QUYẾT           │
│                                                               │
│  Code Team: Code đã tồn tại → Location Map tĩnh              │
│  Research Team: Mỗi bước TẠO artifact mới → Map động        │
│                                                               │
│  Part 1 (EDA / M2: Audit):                                    │
│  M1: raw_data ──▶ eda_notebooks ──▶ insights.md              │
│  M2: source_code ──▶ audit_report ──▶ findings.md            │
│                                                               │
│  Part 2 (Feature Engineering / M2: Diagnose):                │
│  M1: raw_data + insights ──▶ features_pipeline ──▶ feat_data │
│  M2: findings ──▶ root_cause_report ──▶ evidence_map         │
│  MỚI (M2): root_cause_report, evidence_map                   │
│                                                               │
│  Part 3 (Model Building / M2: Design):                        │
│  M1: feat_data ──▶ trained_models ──▶ cv_results ──▶ preds   │
│  M2: evidence ──▶ options_design ──▶ POC (Workspace)         │
│                                                               │
│  Part 4 (Ensemble & Submit / M2: Propose):                    │
│  M1: preds + trained_models ──▶ ensemble ──▶ submission.csv  │
│  M2: options + POC ──▶ PROPOSAL ──▶ SELF-DIRECTION           │
│                                                               │
│  NGUYÊN TẮC QUAN TRỌNG:                                      │
│  ├── Mỗi G phải UPDATE Artifact Map khi tạo artifact mới      │
│  ├── Artifacts cũ KHÔNG bị xóa — giữ cho audit/reproduce     │
│  ├── Artifact Map phải tracking FULL chain                   │
│  │   M1: từ raw_data → submission                           │
│  │   M2: từ source_code → PROPOSAL                          │
│  └── Nếu pivot → Artifact Map giúp biết quay lại từ đâu       │
└──────────────────────────────────────────────────────────────┘
```

### Ví dụ Research Artifact Map — Full Chain qua 3 Groups (M1):

```markdown
### Research Artifact Map — Full Pipeline (After G3)

#### Complete Artifact Chain:
| # | Artifact | Created By | Type | Metric Impact | Status |
|---|----------|-----------|------|--------------|--------|
| 1 | train.csv | TL | Raw Data | — | ✅ Source |
| 2 | test.csv | TL | Raw Data | — | ✅ Source |
| 3 | eda_missing.ipynb | G1-SA01 | Notebook | — | ✅ Info only |
| 4 | eda_distribution.ipynb | G1-SA02 | Notebook | — | ✅ Info only |
| 5 | eda_correlation.ipynb | G1-SA03 | Notebook | — | ✅ Info only |
| 6 | insights.md | G1-SIVIL | Document | — | ✅ Input cho G1-BELI |
| 7 | missing_handler.py | G1-BELI | Code | CV: 0.134→0.132 | ✅ Done |
| 8 | log_transform.py | G1-BELI | Code | CV: 0.132→0.131 | ✅ Fixed by G2 |
| 9 | target_encoding.py | G1-BELI | Code | CV: 0.131→0.125 | ✅ Fixed by G2, Optimized by G3 |
| 10 | interaction_feats.py | G1-BELI | Code | CV: 0.125→0.124 | ✅ Done |
| 11 | domain_feats.py | G1-BELI | Code | CV: 0.124→0.125 | ❌ Removed by G3 |
| 12 | feature_importance.csv | G1-BELI | Data | — | ✅ Updated by G3 |
| 13 | train_feat.csv | G1→G2 | Dataset | — | ✅ Clean |
| 14 | test_feat.csv | G1→G2 | Dataset | — | ✅ Clean |
| 15 | selected_features.txt | G3 | Config | CV: 180→72 feats | ✅ G3 output |
| 16 | pipeline_v2.py | G3 | Code | Runtime: 45→22 min | ✅ G3 output |

#### Metric Journey:
| Stage | CV Score | Features | Runtime | Key Event |
|-------|----------|----------|---------|-----------|
| Baseline | 0.134 | 79 | — | Raw features |
| After G1 | 0.124 | 180 | 45 min | +101 features |
| After G2 | 0.127 | 180 | 45 min | Fixed leakage (honest score) |
| After G3 | 0.121 | 72 | 22 min | Feature selection + optimization |

#### Dependencies (cho Part 3 — Model Building):
| Artifact | Depends On | Part 3 cần? |
|----------|-----------|-------------|
| train_feat.csv | missing_handler, log_transform, target_encoding | ✅ Primary input |
| test_feat.csv | Same as above | ✅ Primary input |
| selected_features.txt | feature_importance.csv | ✅ Feature list |
| pipeline_v2.py | All feature code | ✅ Apply transforms |
| feature_importance.csv | Trained model | ✅ Reference |
| domain_feats.py | — | ❌ Removed |
```

### So sánh hiệu quả:

```
┌───────────────────────┬────────────┬────────────┬──────────────┐
│ Phương pháp           │ Token đọc  │ Token sửa  │ Chất lượng   │
├───────────────────────┼────────────┼────────────┼──────────────┤
│ Đọc TOÀN BỘ artifacts │ 8-12K      │ 2-4K       │ Thấp         │
│ + notebooks + data    │            │            │ (overwhelm   │
│                       │            │            │  → miss leak)│
├───────────────────────┼────────────┼────────────┼──────────────┤
│ Đọc CHỈ worklog      │ 1-2K       │ 2-4K       │ Rất thấp     │
│ (không đọc code/data) │            │            │ (không thấy  │
│                       │            │            │  bug thực tế)│
├───────────────────────┼────────────┼────────────┼──────────────┤
│ DIRECTED READING      │ 3-5K       │ 4-6K       │ CAO NHẤT     │
│ (Artifact Map →       │            │            │ (focus đúng  │
│  code → protocol → fix│            │            │  artifact,   │
│  → verify metric)     │            │            │  đủ context) │
└───────────────────────┴────────────┴────────────┴──────────────┘
```

### Quy tắc bắt buộc cho tất cả Agents (Research Version):

```
┌──────────────────────────────────────────────────────────────┐
│  QUY TẮC BẮT BUỘC — ÁP DỤNG CHO TẤT CẢ G AGENTS           │
│  (RESEARCH TEAM)                                             │
│                                                               │
│  1. MỖI G KHI HOÀN THÀNH → PHẢI GHI RESEARCH ARTIFACT MAP  │
│     → Chỉ rõ: artifact nào cần đọc / bỏ qua                  │
│     → Chỉ rõ: metric impact (M1) / relevance + evidence (M2) │
│     → Chỉ rõ: dependencies (artifact dựa trên artifact nào)  │
│     → Chỉ rõ: reading strategy ưu tiên cho G sau             │
│     → Chỉ rõ: hypothesis confirmed/rejected/pending          │
│                                                               │
│  2. MỖI G KHI BẮT ĐẦU → PHẢI ĐỌC ARTIFACT MAP             │
│     → Đọc map TRƯỚC khi đọc code/notebooks/logs              │
│     → Chỉ đọc artifacts được đánh dấu ✅                      │
│     → Bỏ qua artifacts đánh dấu ❌                            │
│     → Theo thứ tự ưu tiên (🔴 → 🟠 → 🟡)                   │
│                                                               │
│  3. G2 ĐỌC THEO LEAKAGE/BUG LOCATIONS (M1)                  │
│     / SUSPECT LOCATIONS (M2: stack traces, warnings,        │
│       error paths, fail-open paths, config mismatch)        │
│     → Focus: artifacts có issues, data flow, fit/transform    │
│     → Chiến lược: selective, safety-first                    │
│     → Priority #1: DATA LEAKAGE (M1) / SYSTEM SAFETY (M2)   │
│                                                               │
│  4. G3 ĐỌC THEO METRIC IMPACT CHAIN (M1)                    │
│     / IMPACT CHAIN (M2: component → dependencies →          │
│       user-facing effect)                                    │
│     → Focus: feature importance, model behavior, CV strategy  │
│     → Chiến lược: wider, metric-driven                        │
│     → Priority #1: METRIC IMPROVEMENT (M1) / ĐỒN BẨY        │
│       HỆ THỐNG (M2)                                          │
│                                                               │
│  5. TL ĐỌC CHỈ WORKLOG + ARTIFACT MAP                       │
│     → TL KHÔNG đọc code trực tiếp (trừ khi ESCALATE /        │
│       claim thiếu evidence cần verify)                       │
│     → TL dựa vào map để hiểu artifact chain                   │
│     → TL dùng metric journey (M1) / evidence map (M2)        │
│       để quyết định PIVOT/CONTINUE                            │
│                                                               │
│  6. MỖI ARTIFACT MỚI → UPDATE MAP NGAY                       │
│     → Dynamic chain: mỗi bước tạo artifact mới                │
│     → Map phải tracking FULL chain                            │
│     │   M1: raw_data → submission                           │
│     │   M2: source_code → PROPOSAL → SELF-DIRECTION         │
│     → Nếu pivot → Map giúp biết quay lại từ đâu               │
└──────────────────────────────────────────────────────────────┘
```

---

## 📨 PROPOSAL SCHEMA — CHUẨN ĐẦU RA CỦA MISSION M2

Toàn bộ pipeline M2 hội tụ về 1 artifact duy nhất: **PROPOSAL**. Đây là thứ SELF-DIRECTION đọc để quyết định.

```markdown
# PROPOSAL: [Tên ngắn gọn]
- **ID**: P-YYYYMMDD-NNN
- **Ngày**: [date]
- **Author**: [SIVIL/BELI/LISMA/HAN — tổng hợp bởi NEMESIS]
- **Mission**: M2

## 1. Problem Statement
[Mỗi claim kèm evidence: file:line, log excerpt, measurement]

## 2. Root Cause / Analysis
[Kết quả chẩn đoán của LISMA — evidence-based]

## 3. Options (A/B/C...)
| Option | Mô tả | Effort | Trade-offs | POC (Workspace) |
|--------|-------|--------|------------|-----------------|
| A | ... | S | ... | (nếu có, kèm diff) |
| B | ... | M | ... | — |

## 4. Recommendation
[Option HAN khuyến nghị + lý do]

## 5. Expected Impact
[Metric nếu đo được / qualitative nếu chưa có benchmark]

## 6. Risk & Rollback
[Rủi ro khi apply + cách quay lại trạng thái cũ]

## 7. Verification Plan
- (a) Kiểm chứng tay NGAY: [log check, manual test steps cụ thể]
- (b) Benchmark spec (DEFERRED — khi hệ A/B được xây):
      [metric + method + acceptance threshold]

## 8. Effort: S / M / L

---
**Status**: DRAFT → SUBMITTED (SELF-DIRECTION) → APPROVED / REJECTED / REVISED
```

**Vòng đời Proposal:**

```
DRAFT (NEMESIS tổng hợp từ output G1/G2/G3)
  → SUBMITTED (route thẳng vào SELF-DIRECTION)
     → Chờ user HOẶC agent được ủy quyền phê duyệt
  → APPROVED → áp thay đổi từ Workspace lên Live System (user hoặc agent ủy quyền — thao tác riêng)
  → REJECTED (kèm lý do → quay lại research nếu cần)
  → REVISED (yêu cầu bổ sung evidence/option → NEMESIS giao lại group liên quan)
```

**Trường 7 — Verification Plan — là linh hồn của schema:** vì hệ thống benchmark A/B chưa xây, proposal KHÔNG bị chờ — gửi đi ngay kèm (a) cách kiểm chứng tay ngay bằng log/manual test + (b) benchmark spec hoãn cho đến khi hệ A/B được xây.

---

## 🔁 VÍ DỤ THỰC TẾ: KAGGLE COMPETITION WORKFLOW (M1)

Giả sử team tham gia competition "House Prices: Advanced Regression Techniques":

### Phase 1: Khởi động (Complex)

```
1. TL (NEMESIS) đọc competition description
   → CLASSIFY: M1 (Kaggle Research) ✅
   → Chấm: Phạm vi 3 + Suy luận 3 + Rủi ro 2 = 8 → COMPLEX
   
2. TL tạo task_complex.md:
   - Part 1: EDA & Understanding data
   - Part 2: Feature Engineering  
   - Part 3: Model Building & Tuning
   - Part 4: Ensemble & Submission

3. TL gọi G1 cho Part 1
```

### Phase 1 — Part 1: EDA (Complex)

```
G1 (SIVIL + BELI):
  SIVIL: dispatch 5 sub-agents song song
    → Agent 1: Missing value analysis
    → Agent 2: Distribution analysis  
    → Agent 3: Correlation analysis
    → Agent 4: Outlier detection
    → Agent 5: Categorical variable analysis
  BELI: code cho mỗi analysis
  → Output: 5 notebooks EDA + insights

G2 (LISMA):
  Review 5 notebooks → Fix rendering bugs → 
  Fix incorrect statistical tests → 
  Suggestion: "Nên thêm interaction features giữa GrLivArea và OverallQual"
  → Output: 5 notebooks sạch + suggestions

G3 (HAN):
  Review insights → "Missing value pattern gợi ý MNAR, 
  không nên dùng simple imputation" →
  Tối ưu visualization → 
  Suggestion: "Nên thử target encoding cho categorical thay vì one-hot"
  → Output: Optimized EDA + strategy recommendations

TL (NEMESIS):
  Đọc worklog → Chốt approach → 
  "Tốt, chuyển sang Part 2: Feature Engineering"
  → Gọi G1 cho Part 2
```

### Phase 2 — Part 2: Feature Engineering (Complex)

```
G1 (SIVIL + BELI):
  SIVIL: dispatch sub-agents cho parallel feature creation
    → Group A: Numeric features (log transform, polynomial)
    → Group B: Categorical features (target encoding, frequency encoding)
    → Group C: Interaction features
    → Group D: Time-based features (nếu có)
  BELI: code từng nhóm
  → Output: Feature engineering pipeline

... (G2 → G3 → TL như trên)
```

### Phase 2 — Sửa 1 bug nhỏ (Simple — chen ngang!)

```
TL nhận ra: "Feature X bị NaN sau transform" 
→ Chấm: Phạm vi 1 + Suy luận 1 + Rủi ro 1 = 3 → SIMPLE
→ Giao thẳng G2 (LISMA): Fix NaN handling
→ LISMA code + self-review → "Thêm fillna(median) trước transform"
→ TL quick check → DONE
→ Quay lại Complex pipeline đang chạy
```

> **Điểm quan trọng:** TL có thể **chen ngang** Simple/Medium tasks vào giữa Complex pipeline mà không làm gián đoạn. Đây là lợi ích lớn của tier system.

---

## 🔁 VÍ DỤ THỰC TẾ: SYSTEM RESEARCH WORKFLOW (M2)

Giả sử user yêu cầu: "Hệ thống chat của TMO chậm, nghiên cứu và đề xuất khắc phục."

### Phase 0: Phân loại & Triage (NEMESIS)

```
NEMESIS nhận request → CLASSIFY:
  "hệ thống, TMO, chậm, đề xuất khắc phục" → signals M2
  → mission_type: M2 (confidence: cao — không cần hỏi lại)

NEMESIS TRIAGE:
  Phạm vi = 3 (LLM pipeline + key pool + fail-open paths)
  Suy luận = 3 (cần đọc logs + code để tìm root cause)
  Rủi ro = 2 (thay đổi ảnh hưởng trải nghiệm user)
  → Tổng 8 → COMPLEX (Tier 3)

NEMESIS DECOMPOSE — 4 Parts:
  Part 1: Audit hiện trạng (COMPLEX)
  Part 2: Chẩn đoán root cause (MEDIUM)
  Part 3: Thiết kế options (COMPLEX)
  Part 4: Proposal & Verification Plan (MEDIUM)
```

### Phase 1: Audit hiện trạng (Complex)

```
G1 (SIVIL + BELI):
  SIVIL dispatch 6 sub-agents đọc song song:
    → SA-01: dev.log — latency patterns (phát hiện requests 121s!)
    → SA-02: API route /api/query — query pipeline
    → SA-03: service-key-pool — LLM key rotation logic
    → SA-04: LLM client — retry + timeout behavior
    → SA-05: neo4j/qdrant clients — connection handling
    → SA-06: health check — service status hiện tại
  BELI tổng hợp thành Audit Report:
    "Chat request mất 121s khi LLM key trả 401 → pipeline
     retry lần lượt qua các key không hợp lệ rồi mới fail-open.
     Không có fail-fast, không có timeout ngắn, key pool
     không có health check."

G2 (LISMA) — System Diagnostician:
  Đọc theo Suspect Locations (log warnings + error paths):
  → Root cause #1: Retry mù quáng khi 401 (4xx không retry được)
  → Root cause #2: Key pool không health check
  → Root cause #3: Không timeout cho LLM calls
  → Đề xuất trong report: fail-fast + timeout + key health check
  → KHÔNG sửa code TMO — chỉ chẩn đoán + đề xuất

G3 (HAN) — Architecture Proposer:
  Đọc theo Impact Chain (key pool → LLM calls → user latency):
  → Option A: Fail-fast + timeout — effort S, tác động lớn
  → Option B: Key health check + circuit breaker — effort M
  → Option C: Response cache — effort L, cần benchmark
  → Recommendation: A + B ngay; C để khi có benchmark
  → Mỗi option kèm Verification Plan (deferred)

NEMESIS — 3 Checkpoints:
  CP1: Audit đủ evidence? (mỗi finding có file:line + log) ✅
  CP2: Root cause khớp code ↔ logs? (LISMA verify) ✅
  CP3: Mỗi option có trade-offs + verification plan? ✅
```

### Phase 2: Proposal → SELF-DIRECTION

```
NEMESIS FINALIZE:
  Tổng hợp thành PROPOSAL theo Proposal Schema:
  - Problem: Chat latency 121s khi LLM key fail
    (evidence: dev.log + key-pool code path)
  - Root Cause: retry mù quáng + không health check + không timeout
  - Options: A (fail-fast) / B (health check) / C (cache)
  - Recommendation: A+B — Expected impact: 121s → < 10s
  - Risk & Rollback: config-level change, rollback = revert env
  - Verification Plan:
    (a) NGAY: so sánh latency log trước/sau + manual test
        "gửi 1 câu hỏi khi 1 key cố tình sai"
    (b) DEFERRED: benchmark A/B latency khi hệ được xây
        (metric: p50/p95 chat latency, acceptance: p95 < 10s)
  → Route thẳng SELF-DIRECTION
  → Status: SUBMITTED — chờ user/agents ủy quyền phê duyệt
```

> **Điểm quan trọng:** Toàn bộ mission M2 KHÔNG sửa bất kỳ file nào của TMO. Output duy nhất là Proposal document. Implementation (sau khi APPROVED) và benchmark A/B là thao tác riêng.

---

## 📊 TỔNG QUAN 3-TIER SYSTEM

```
                    ┌──────────────┐
                    │   REQUEST    │
                    └──────┬───────┘
                           │
                    ┌──────▼───────┐
                    │ NEMESIS: CLASSIFY│
                    │ M1 | M2      │
                    └──────┬───────┘
                           │
                    ┌──────▼───────┐
                    │ NEMESIS: TRIAGE  │
                    │ Đánh giá      │
                    │ complexity    │
                    └──┬───┬───┬───┘
                       │   │   │
          ┌────────────┘   │   └────────────┐
          ▼                ▼                 ▼
    ┌──────────┐    ┌──────────┐     ┌──────────┐
    │  SIMPLE  │    │  MEDIUM  │     │ COMPLEX  │
    │ (3 điểm) │    │ (4-6 điểm)│    │ (7-9 điểm)│
    ├──────────┤    ├──────────┤     ├──────────┤
    │TL → G2 → │    │TL → G1 → │     │TL → G1 → │
    │TL → DONE │    │G2 → TL → │     │G2 → G3 → │
    │          │    │DONE      │     │TL → loop  │
    │          │    │          │     │mỗi part  │
    └──────────┘    └──────────┘     └──────────┘
    
    Thời gian:       Thời gian:       Thời gian:
    ~1-2 bước        ~2-3 bước        ~4+ bước
                                     lặp lại mỗi part

    OUTPUT:
    ├── M1: Submission/Dataset/Docs → User
    └── M2: PROPOSAL → SELF-DIRECTION
```

**Ví dụ mapping tier (M2):**
- "Verify 1 config có đúng không" → **Simple** (NEMESIS → LISMA → NEMESIS)
- "Chẩn đoán chat latency cao" → **Medium** (NEMESIS → G1 → LISMA → NEMESIS)
- "Redesign kiến trúc bộ nhớ" → **Complex** (full pipeline + HAN)

---

## 📎 GHI CHÚ THÊM

### Đặc điểm mỗi agent trong vai trò mới:

- **NEMESIS (TL):** Đọc toàn bộ context (competition description, rules, data dictionary, forum posts, worklogs — M2: system docs + logs + health) cùng lúc. Khả năng reasoning sâu giúp chia task chính xác. Không code — chỉ tư duy và điều phối. Đóng vai trò **Research Loop Controller** trong Read-Write-Verify Loop, đọc worklog sau mỗi Checkpoint để kiểm soát hướng nghiên cứu. Với M2: phân loại mission, tổng hợp Proposal, route vào SELF-DIRECTION. Chủ trì Research Council với SIVIL; phát hiện tri thức mới → ghi KB ngay (KB Write Protocol).

- **SIVIL (G1 Sub-Orchestrator):** Sub-agent pool (5–300) là lợi thế tuyệt đối cho parallel exploration. Thay vì thử 1 approach tuần tự, SIVIL có thể dispatch 5–300 sub-agents song song, mỗi sub-agent độc lập. Sau đó tổng hợp kết quả, chọn top-K approaches cho BELI code chi tiết. M2: dispatch theo Module Map để audit song song từng module TMO. Tham gia Research Council với NEMESIS — SYNTHESIZE phát hiện insight mới → ghi thẳng vào Knowledge Base.

- **BELI (G1 Coder):** Chuyên gia code lượt đầu — sinh code nhanh, structure tốt, follow spec chính xác. Không cần perfect ở bước này vì LISMA sẽ fix bug. M2: viết research report + POC trong Workspace (bản clone của hệ thống — không đụng Live System đang chạy).

- **LISMA (G2 Reviewer):** Vòng lặp iteration nhanh — Đọc → Tìm → Sửa → Kiểm tra → Lặp lại cho đến khi sạch. Đặc biệt tốt ở iterative refinement — kể cả phát hiện regression bug do fix trước gây ra. Đọc artifacts theo **Leakage/Bug Locations** từ Research Artifact Map, focus vào data safety. M2: System Diagnostician — đọc theo **Suspect Locations** (stack traces, warnings, error paths, fail-open paths), chẩn đoán root cause, đề xuất fix trong proposal.

- **HAN (G3 Optimizer):** Self-evolving mechanism giúp cải thiện strategy dựa trên feedback từ các vòng trước — Knowledge Base tích lũy lessons (Kaggle + System + Config + Performance Baselines). Ensemble & tuning là thế mạnh tự nhiên. Đọc artifacts theo **Metric Impact Chain**, focus vào metric improvement. M2: Architecture Proposer — đề xuất nâng cấp memory / execution / thinking / tools / UI-performance, mỗi proposal kèm Verification Plan (deferred). KB Curator — consolidate/dedup các entries do cả team ghi.

### Model Policy (áp dụng cho mọi agent):

| Khía cạnh | Chính sách |
|---|---|
| **Model chính** | Kimi-k3 — mọi agent, mọi sub-agent |
| **Fallback chain** | DeepSeek v4 Pro → DeepSeek v4 Flash → MiniMax-M3 |
| **Chuyển fallback** | Model chính lỗi/quá tải → tự chuyển fallback; agent GIỮ NGUYÊN vai trò + JD |
| **Phân vai** | Theo JD + Instructions (role-based) — KHÔNG theo model |
| **Tên agent ≠ tên model** | NEMESIS/SIVIL/BELI/LISMA/HAN là vai trò, đổi model không đổi vai trò |

### Read-Write-Verify Loop (Research Version):

| Khái niệm | Mô tả |
|-----------|-------|
| **WRITE** | Mỗi G hoàn thành → Ghi worklog + Research Artifact Map + Metrics (M1) / Findings + Evidence (M2) + Hypothesis Status + KB entries mới (Knowledge Capture) |
| **READ** | TL đọc worklog sau mỗi Group (Checkpoint) — Metrics/Findings trước, chi tiết sau |
| **VERIFY** | M1: Metric cải thiện + No leakage + CV-LB gap < 0.01 + Hypothesis checked. M2: Evidence-based (mọi claim có citation) + Completeness + Feasibility (không phá hệ đang chạy) |
| **UPDATE** | TL cập nhật Research Protocol / System Audit Charter → Giao Group tiếp hoặc điều chỉnh |
| **Checkpoint** | T1: CP2, T2: CP1+CP2, T3: CP1+CP2+CP3 (3 Checkpoint, không phải 4 như Code Team) |
| **Pivot Trigger M1** | 🔴 Data leakage / CV-LB gap > 0.02 / Metric WORSE |
| **Pivot Trigger M1** | 🟡 Model plateau 3x / Metric fluctuation / Feature eng không hiệu quả |
| **Pivot Trigger M2** | 🔴 Claim thiếu evidence / Code mâu thuẫn logs / Proposal phá compatibility |
| **Pivot Trigger M2** | 🟡 Scope creep / Nghiên cứu trùng lặp / POC không tái hiện |
| **Verify criteria M2** | Mọi claim có evidence + đủ module coverage + feasibility |

### Directed Reading + Research Artifact Map:

| Khái niệm | Mô tả |
|-----------|-------|
| **Research Artifact Map** | Bản đồ chỉ artifact nào đọc/bỏ qua, metric impact, dynamic artifact chain |
| **Artifact format M1** | artifact:type:metric_impact (khác Code Team: file:line:issue) |
| **Artifact format M2** | file:type:relevance:status |
| **Dynamic Chain M1** | raw_data → clean_data → features → models → preds → submit (mỗi bước tạo artifact mới) |
| **Dynamic Chain M2** | source_code → analysis_report → findings → proposal → POC |
| **3 Lớp thông tin** | L1: Research Protocol (North Star) + L2: Worklog+Artifact Map (Context) + L3: Ground Truth — M1: Code+NB+Data / M2: Code+Docs+Logs+Config+UI |
| **G2 chiến lược** | Đọc theo Leakage/Bug Locations (M1) / Suspect Locations (M2) — selective, safety-first, Priority #1 = Data Leakage (M1) / System Safety (M2) |
| **G3 chiến lược** | Đọc theo Metric Impact Chain (M1) / Impact Chain (M2) — wider, metric-driven, Priority #1 = Metric Improvement (M1) / System Leverage (M2) |
| **TL chiến lược** | Chỉ đọc Worklog + Artifact Map, KHÔNG đọc code (trừ ESCALATE / verify claim thiếu evidence) |
| **Quy tắc** | Mỗi G PHẢI ghi Artifact Map khi xong + PHẢI đọc Map khi bắt đầu + Mỗi artifact mới → Update Map ngay |

### Proposal → SELF-DIRECTION (M2 only):

| Khái niệm | Mô tả |
|-----------|-------|
| **Proposal Schema** | Problem (evidence) → Root Cause → Options → Recommendation → Impact → Risk & Rollback → Verification Plan → Effort |
| **Verification Plan** | (a) Kiểm chứng tay NGAY + (b) Benchmark spec DEFERRED (khi hệ A/B được xây) |
| **Vòng đời** | DRAFT → SUBMITTED → APPROVED / REJECTED / REVISED |
| **Người duyệt** | User trực tiếp HOẶC agents được ủy quyền |
| **Quy tắc vàng** | M2 KHÔNG sửa Live System — mọi thay đổi sống trong Workspace + Proposal, chỉ áp lên Live System sau APPROVED |

### Knowledge Capture (toàn team):

| Khái niệm | Mô tả |
|-----------|-------|
| **Nguyên tắc** | Team research = lực lượng tri thức — phát hiện hay → ghi KB ngay trong cùng phiên, không chờ cuối chu trình |
| **Quyền ghi trực tiếp** | NEMESIS (MONITOR/DECIDE/FINALIZE), SIVIL (SYNTHESIZE), HAN (chu trình G3 + Curator) |
| **Đề xuất qua worklog** | BELI/LISMA — trường "KB Candidates" → NEMESIS/SIVIL/HAN quyết định ghi |
| **Research Council** | NEMESIS ↔ SIVIL tại 4 thời điểm: sau DECOMPOSE, sau SYNTHESIZE, khi ESCALATE, tại Checkpoint |
| **KB Write Protocol** | SEARCH (tra trùng) → FORMAT (KB Entry Schema) → WRITE → CURATE (HAN dedup/merge/retire) |
| **Category mới** | Research Insights — tri thức phương pháp nghiên cứu từ thảo luận & vận hành |
| **Quy tắc vàng** | Tri thức không được phép bị mất — kể cả task tier SIMPLE/MEDIUM không đi qua G3 |

---
---

# 📌 PHỤ LỤC Z — DECISION RECORD v1.3 (CHỐT TOÀN BỘ [Q] MỞ)

**Ngày:** 2026-09-01 · **Bối cảnh:** User ủy quyền Z.ai Code chốt toàn bộ 71 câu hỏi mở `[Q]` của tập 13 blueprint TB-00→TB-12 (Version 1.2) với chính sách: **cẩn thận – chi tiết – đầy đủ nhất, tránh hời hợt; KHÔNG ràng buộc token/chi phí** (NVIDIA NIM — 4 API keys, sẽ tăng thêm).
**Phương thức:** append-only — 4.635 dòng gốc phía trên NGUYÊN VẸN; phụ lục này ghi nhận mọi quyết định như amendment chính thức (quy tắc số 1: thiết kế thay đổi → cập nhật nguồn trước, blueprint sau). Văn bản quyết định đầy đủ: `docs/DECISION-RECORD-v1.3.md`.

## Z.1 — Bảy cụm quyết định chéo file

| Cụm | ✅ QUYẾT ĐỊNH (tóm tắt) |
|---|---|
| **C1** — Verify thuần túy M2 | Deterministic: kết luận KHÔNG chứa đề nghị thay đổi nào → trả lời trực tiếp + Verify-Report mini + KB entry bắt buộc; có ≥ 1 đề nghị thay đổi → Proposal 1-item bắt buộc. KHÔNG có vùng xám. |
| **C2** — Confidence CLASSIFY | HIGH = ≥ 3 tín hiệu cùng chiều, 0 mâu thuẫn; MEDIUM = 1 mâu thuẫn → verify 1 vòng rồi **TIE-BREAK UP** (chọn tier cao hơn); LOW = ≥ 2 mâu thuẫn → hỏi user đúng 1 câu. |
| **C3** — Nâng/hạ tier giữa chừng | **APPEND-ONLY**: task .md thêm `version: N` + `## CHANGELOG`; không bao giờ rewrite. |
| **C4** — CP1 của T2 | Verify **ĐẦY ĐỦ như T3** (checklist ~60% số item; formal gate 3 thành phần). |
| **C5** — Timeout & ủy quyền duyệt | Group treo: nhắc 1 CP / treo 2 CP → ESCALATE. ESCALATED chờ user: 48h (M1) / 24h (M2), nhắc 12h. Proposal SUBMITTED: 48h; trần REVISED = 2 vòng. **Deputy approver = SIVIL (mặc định) / HAN (KB-domain)** — không author, NEMESIS cấm tự duyệt. |
| **C6** — Lưu trữ KB | 3 lớp: SQLite/Prisma canonical (versioned, soft-delete retire) + snapshot .md theo category + index (cho Directed Reading) + Live System read-only. |
| **C7** — Dòng model switched | Duyệt format TB-09 §4.3 làm chuẩn + thêm 2 trường `trigger` + `next check`; kèm 1 dòng Decision Log; mọi agent dùng chung. |

## Z.2 — Quyết định theo file (tóm tắt; bản đầy đủ trong DECISION-RECORD)

- **TB-01:** quá tải = dual-signal (self-report OR external probe, hysteresis 3 probe OK) · Workspace versioning BẮT BUỘC (1 Proposal = 1 branch git, diff base..head là artifact review).
- **TB-02:** T2 vẫn họp council ① — SIVIL tham vấn ad-hoc (consult-only, không dispatch SA).
- **TB-03:** SA concurrent 20 mặc định / burst 25 Grand (round-robin 4 NIM keys, hard-cap 25) · timeout SA: EDA 30m · Grand 60m · System Audit 30m (soft-checkpoint 50/70%, retry 1 lần scope thu hẹp) · NEMESIS CÓ quyền VETO tại council ② (checklist ack/veto từng spec; ≥ 2 vòng veto → council ③) · BELI POC Live System READ-ONLY + evidence log từng query, WRITE cấm · G1 = 40% quỹ thời gian task · feedback spec: 2 vòng MEDIUM / 3 vòng COMPLEX+Grand · verify tất cả specs → handoff 1 package.
- **TB-04:** checklist giữ tên "Data Safety (Data Leakage)" · loại bug 5 = API/Compatibility (Regression là bug gốc có type riêng) · ESCALATED → dừng toàn bộ task · LISMA chủ động read-only Live được (evidence log) · severity regression độc lập + tham chiếu gốc · vòng đếm theo task/đợt fix · URGENT dual-channel (NEMESIS + notify user song song; NEMESIS vẫn decision-maker duy nhất) · M2 simple đi Tier 1 + NEMESIS mini read-back.
- **TB-05:** 1 vòng = 1 task G3 (≥ 1 item) · ngưỡng đáng kể: M1 > 1 std CV; M2 > 5% hoặc bootstrap 95% CI (qualitative-only → confidence ≤ MEDIUM) · retire = PRE-APPROVAL bởi NEMESIS tại CP3 · **Schema KB Entry thêm trường 8 `Confidence: HIGH/MEDIUM/LOW` (A2)** · **trần 3 vòng Evolution Cycle/task G3, vượt → ESCALATE (A3)** · HAN không ngồi council (giữ nguồn) + council transcript route tự động tới HAN làm input curate.
- **TB-06:** Proposal REJECTED → re-TRIAGE đầy đủ (giữ worklog), tối đa 2 vòng → ESCALATED_USER · trần hỏi: 1 câu CLASSIFY + 1 câu user-blocked-info/task · council ĐỒNG BỘ (blocking) · NEMESIS verify Proposal FIELD-BY-FIELD (8 trường, trọng điểm Risk & Rollback) trước SUBMIT.
- **TB-07:** **danh sách 5 bước DECOMPOSE chính thức đánh số (A1)** · House Prices = 6 parts (0–5) theo nguồn · R3 giữ 50% + hiệu chỉnh sau 5 mission (log + Decision Log) · task .md có `version` + CHANGELOG (A10) · council ① MỌI mission (A5) · **M2 multi-part thêm Part 0 "Setup & Baseline": khởi Workspace + snapshot baseline từ logs (A4)** · NEMESIS độc quyền tách/gộp part (SIVIL/LISMA chỉ flag).
- **TB-08:** curate định kỳ KÉP: ~10 entry NEW · cuối mission · 7 ngày nếu còn NEW (HAN chủ trì) · KB theo C6.
- **TB-09:** CV-LB gap chuẩn hóa 0.005 minor / 0.01 notable / 0.02 instability-warning vào Research Protocol template (A11) · 2 vòng trả lại → PIVOT; 3 vòng → ESCALATE · NEMESIS ghi TL Read-Back khi READ xong.
- **TB-10:** stale gộp vào superseded + note "cần re-compute" · map > 60 entries → rank + đọc sâu top · M1 theo cột status nguồn, M2 append + superseded · prefix LIVE:/WS: đặt cột riêng · Module Map verify kép (kỹ sư lúc cài + NEMESIS đầu mỗi mission M2 T3) · SA không ghi map trực tiếp — SIVIL tổng hợp 1 map duy nhất · task mini re-compute stale: CÓ · M1 không thêm cột Relevance.
- **TB-11:** SELF-DIRECTION = module runtime TMO (registry + scheduler + applier); Proposal canonical = file `proposals/P-YYYYMMDD-NNN.md` trong Workspace + mirror DB (model `Proposal`: 8 trường + status + deputy-approver); parser = module; APPLY = thao tác runtime sau APPROVED (merge branch Workspace).
- **TB-12:** thêm TC-13 (task .md thiếu Success Criteria → council ① chặn) + TC-14 (map thiếu → không giao group kế) · dựng golden-run PB-M2 từ mission thật đầu (schema TB-09 §4) · TC-02 freeze theo C1 · deputy = SIVIL/HAN.

## Z.3 — Chính sách xuyên suốt (do user chỉ định)

P1 Thorough-first (luôn chọn cẩn thận/đầy đủ khi trade-off) · P2 Không ràng buộc token (NIM 4 keys, round-robin, sẽ scale) · P3 Append-only audit-trail · P4 Evidence log bắt buộc mọi thao tác đọc Live · P5 Tie-break UP (mơ hồ → chọn phương án kỹ hơn) · P6 An toàn Live System tuyệt đối (read-only; write chỉ trong Workspace; NEMESIS là decision-maker duy nhất).

## Z.4 — Hiệu lực

- Toàn bộ `[Q]` của 13 blueprint → `[DECIDED v1.3]` (truy vết qua số Q gốc).
- Không quyết định nào mâu thuẫn 4.635 dòng gốc; mọi mở rộng là [EXT] được phê chuẩn kèm amendment này.
- Triển khai runtime các quyết định vào TMO app = thao tác riêng, chờ user khởi động.

*Hết Phụ lục Z — nguồn ai-team-workflow.md giờ gồm 4.635 dòng gốc (v1–v1.2) + Phụ lục Z (v1.3).*

# 📌 PHỤ LỤC Z2 — SOLUTION SCORING & SELECTION PROTOCOL (v1.5)

> Người khởi xướng: Owner (phiên chat 2026-09-01, trace 1a05c01e7a9f66f9). Yêu cầu: "tiêu chí chấm điểm xác định thế nào là giải pháp/chẩn đoán chính xác, cách xác minh, cách agents áp dụng đúng tiêu chí + giải pháp phù hợp bối cảnh; cơ chế loop thảo luận → giả thiết tốt nhất → phương án thử nghiệm → triển khai → test → đánh giá → go/no-go → triển khai luôn hoặc gửi đề xuất tùy bối cảnh."
> Trạng thái: ✅ ĐÃ CHỐT (user ủy quyền thorough-first — không mở [Q] mới). Phụ lục này là phần bổ sung v1.5 của Phụ lục Z; toàn bộ 4.682 dòng trước đó (4.635 gốc + Z) nguyên vẹn.

## Z2.1 — RUBRIC A: CHẤM ĐIỂM CHẨN ĐOÁN (Diagnosis Quality)

Mọi root cause / giả thiết chẩn đoán phải được chấm 5 chiều, thang 0–5 mỗi chiều, có evidence anchor:

| Chiều | Trọng số | 0 điểm | 3 điểm | 5 điểm |
|---|---|---|---|---|
| D1 Evidence đầy đủ | 30% | claim không evidence | 1 phần có file:line + log | mọi claim có file:line + log excerpt + đường tái tạo |
| D2 Xác nhận nhân-quả | 25% | chỉ tương quan | có cơ chế giải thích WHY | **kill-test trong workspace**: vá nguyên nhân → triệu chứng biến mất |
| D3 Nhất quán | 15% | mâu thuẫn code/log | còn 1 điểm chưa đối chiếu | khớp code + log + giải thích 100% triệu chứng quan sát |
| D4 Tái lập được | 15% | không ai kiểm lại | 1 SA độc lập khớp phần lớn | **2 SA độc lập (blind)** cùng kết luận |
| D5 Độ sâu | 15% | dừng ở tầng triệu chứng | đến tầng code | đến tầng code + config/data + nguyên nhân gốc hệ thống |

**Xếp loại:** ≥4.0 CONFIRMED · 3.0–3.9 PROBABLE (được vào Options nhưng phải qua thêm 1 falsification test) · <3.0 WEAK (loại, không được vào Options).

## Z2.2 — RUBRIC B: CHẤM ĐIỂM GIẢI PHÁP (Solution Quality)

| Chiều | Trọng số | Đo bằng gì |
|---|---|---|
| S1 Phủ bài toán | 25% | % root cause ≥PROBABLE được xử lý + Success Criteria mission |
| S2 Impact kỳ vọng | 15% | số liệu định lượng + đối chiếu Performance Baselines (KB) |
| S3 Rủi ro & khả năng hoàn tác | 20% | risk matrix + rollback plan + blast radius |
| S4 Effort & độ phức tạp | 10% | LOC chạm, hệ thống chạm, thời gian |
| S5 Context-fit | 20% | ma trận Z2.4 + tiền lệ KB (pattern/lesson) + delta thích ứng |
| S6 Đ verify được | 10% | Verification Plan (a) tay NGAY + (b) benchmark metric + ngưỡng |

**Xếp loại:** ≥4.0 STRONG · 3.0–3.9 RECOMMENDED (cần POC) · 2.0–2.9 CONDITIONAL (chỉ thử nếu không có gì hơn) · <2.0 REJECTED.

## Z2.3 — TOURNAMENT GIẢ THIỆT & LOOP THỬ NGHIỆM (5 vòng, tối đa 3 vòng lặp)

1. **GENERATE:** SIVIL sinh ≥3 giả thiết/1 vấn đề (SA matrix TB-03 §5).
2. **SCORE-A:** chấm Rubric A từng giả thiết → top-2 đi tiếp; gap <0.5 → cả 2 đi tiếp.
3. **FALSIFY:** mỗi giả thiết thiết kế kill-criteria (evidence nào sẽ bác bỏ) → BELI viết spec test tối thiểu → LISMA chạy trong workspace (branch riêng).
4. **EXPERIMENT:** HAN dựng Options (A/B/C) — mỗi option BẮT BUỘC kèm scorecard B kỳ vọng; LISMA triển khai POC top-2 trong workspace → đo → scorecard B thực đo; delta kỳ vọng vs thực đo → lesson calibration ghi KB.
5. **COUNCIL ⑤ (Solution Council — NEMESIS chủ trì + SIVIL + BELI + LISMA + HAN, blocking):** phê scorecards → verdict:
   - **CONTINUE-ITERATE** (điểm đang tăng + còn vòng) → vòng tournament kế
   - **CONVERGE** (solution ≥4.0 VÀ gap ≥0.5 so với á quân VÀ context-fit đạt) → chốt phương án tốt nhất
   - **PIVOT** (2 vòng liên tiếp điểm đi ngang/giảm) → quay theo quy tắc PIVOT TB-06 §8.6/8.7
   - **DROP** (3 vòng không ra giả thiết ≥PROBABLE) → negative result ghi KB anti-pattern + đóng task (nguồn: negative result vẫn là kết quả nghiên cứu hợp lệ)

## Z2.4 — MA TRẬN CONTEXT-FIT (áp dụng giải pháp theo bối cảnh)

Giải pháp/pattern trong KB phải kèm bản ghi áp dụng: {8 chiều bối cảnh: module hệ thống · tier/phiên bản protocol · quy mô dữ liệu · profile tải · dependency · môi trường (prod/sandbox) · ràng buộc thời gian · policy user; pre-conditions; adaptation delta; contraindication}.

**Quy trình HAN kiểm tra:** match ≥70% chiều + 100% pre-conditions + 0 contraindication → áp dụng được (delta thích ứng thành yêu cầu spec cho BELI). Không đạt → phải qua tournament mới, không clone mù giải pháp cũ.

## Z2.5 — QUYẾT ĐỊNH TRIỂN KHAI SAU CONVERGE

- **DIRECT-APPLY** (triển khai luôn, không Proposal) chỉ khi hội ĐỦ 5 điều: (1) mission được user phê trước deploy_mode=auto (mission brief hoặc StandingOrder); (2) risk LOW; (3) reversible — rollback <15 phút; (4) tier ≤ T2; (5) blast radius đơn module. → LISMA apply qua RWV + verify + ghi KB + **thông báo user sau khi xong**.
- **Mọi trường hợp khác → Proposal P-YYYYMMDD-NNN → SELF-DIRECTION** (quy tắc gốc C1/Phụ lục Z không đổi — default an toàn).

## Z2.6 — Hiệu lực

- Bổ sung Council ⑤ (thời điểm ⑤) vào hệ 4 council hiện có; transcript theo schema CouncilTranscript (kind=5).
- Mọi quyết định mới ghi Decision Log NEMESIS; không mở [Q] mới — toàn bộ chốt trong phụ lục này theo ủy quyền thorough-first của user.
- Blueprint chi tiết: TB-14 (mở rộng của tập 13 TB); integration code map: TB-13 §2/§3/§5 cập nhật.

*Hết Phụ lục Z2 — nguồn gồm 4.635 dòng gốc + Phụ lục Z (v1.3) + Phụ lục Z2 (v1.5). Append-only: không dòng nào phía trên bị sửa.*
