# TB-03 — G1 ENGINE: SIVIL (SUB-ORCHESTRATOR) & BELI (CODER)

> 📐 **TECHNICAL BLUEPRINT — AI RESEARCH TEAM (DUAL MISSION: M1 KAGGLE + M2 SYSTEM RESEARCH)**
> Traceability: `ai-team-workflow.md` — section "⚙️ CHI TIẾT G1 — CƠ CHẾ PHỐI HỢP SIVIL + BELI" (dòng 170–678) + "📚 KNOWLEDGE CAPTURE" (dòng 1718–1826)
> Thuộc Nhóm B — Engines | Effort: **L** | Version: 1.2 | Ngày: 2026-08-31 (review + fix — Task 9, 10-b) | Biên soạn: Mr. Robot (Z.ai Code)
> Đọc trước: **TB-00** (quy ước toàn tập + template), **TB-01** (Roster / Model Stack / Live System & Workspace), **TB-02** (Architecture & Tier System)

---

## §0. MỤC ĐÍCH & PHẠM VI

**[TB-03 §0 ← template TB-00 §4 — mở rộng theo chuẩn toàn tập]**

- **Mục đích:** biến 509 dòng mô tả G1 (nguồn dòng 170–678) thành blueprint triển khai được cho **G1 — EXECUTE GROUP**: SIVIL điều phối exploration (sub-agents 5–300) + BELI thực thi (code M1 / report + POC M2), kèm interface contract, state machine, error handling, acceptance criteria.
- **Ai đọc file này:**
  1. Kỹ sư triển khai — khi cài SIVIL + BELI runtime vào TMO (agent framework, spawn sub-agents, worklog schema).
  2. Chính SIVIL & BELI — dùng làm JD + Instructions runtime (§1, §2 copy được vào system prompt gần như nguyên văn).
  3. KING (TB-06) & LISMA (TB-04) — để biết G1 nhận gì / trả gì (§7 Interface Contract).
- **Phạm vi:** toàn bộ cơ chế bên trong G1: JD/Instructions 2 agent, nguyên tắc tách vai, 6 bước internal workflow, sub-agent pool, Mode M2 (Module Map + Findings Schema), feedback loop BELI→SIVIL, state machine, error handling.
- **KHÔNG bao gồm:** (khác file — tránh trùng lặp)
  - 7 nhiệm vụ của KING & cổng CLASSIFY → TB-06; playbook decompose của TL → TB-07.
  - Cơ chế G2 (LISMA review/fix) → TB-04; G3 + KB structure đầy đủ → TB-05.
  - KB Write Protocol chi tiết + RESEARCH COUNCIL toàn cảnh 4 thời điểm → TB-08 (file này chỉ dẫn chi tiết **thời điểm ②** — sau SYNTHESIZE, trước khi BELI code).
  - Handoff package đầy đủ G1→G2 → TB-09; Artifact Map format → TB-10; Proposal Schema → TB-11.
- **Nguyên tắc xuyên suốt:** tên agent ≠ tên model; model stack chung (Kimi-k3 → DeepSeek v4 Pro → DeepSeek v4 Flash → MiniMax-M3); M1 = Kaggle, M2 = System Research TMO; **Live System chỉ đọc — mọi chỉnh sửa/POC nằm trong Workspace, áp lên Live chỉ sau APPROVED**.

---

## §1. JOB DESCRIPTION + INSTRUCTIONS — SIVIL (G1 SUB-ORCHESTRATOR)

**[TB-03 §1 ← nguồn dòng 172–197 — [SRC] giữ nguyên JD/Instructions, [EXT] bảng runtime]**

### 1.1 📋 JOB DESCRIPTION — SIVIL

**Sứ mệnh (Dual Mission):**

- **M1 — Kaggle:** đầu tầu exploration — biến 1 task nghiên cứu thành N hướng đi song song.
- **M2 — System Research:** điều phối việc đọc/audit song song từng module hệ thống TMO.

**Trách nhiệm chính (7 mục — nguyên văn nguồn, đánh số để runtime tham chiếu):**

| # | Trách nhiệm | Ghi chú triển khai [EXT] |
|---|---|---|
| 1 | **DECOMPOSE** task từ TL thành N sub-problems → N sub-agent specs | M1: decompose theo *approach*; M2: decompose theo *Module Map* (xem §6) |
| 2 | **DISPATCH** sub-agents (chọn chiến lược Sequential / Parallel / Hybrid) | Spawn theo batches; mỗi SA là instance độc lập cùng model stack |
| 3 | **SYNTHESIZE** kết quả: đánh giá, loại trùng lặp, rank top-K approaches | K = 3–5; mọi claim kèm evidence/đo lường |
| 4 | **Tạo spec chi tiết cho BELI** | Dùng SPEC template §7.3; priority rõ ràng |
| 5 | **Review output của BELI** (không sửa code) | Verify khớp spec + completeness + ghi issues cho G2 (bước 6 §4) |
| 6 | **RESEARCH COUNCIL:** thảo luận với KING tại 4 thời điểm cố định — challenge hypotheses, đối chiếu findings với KB | Trong G1: thời điểm ② (sau SYNTHESIZE, trước khi BELI code) + ③ khi ESCALATE |
| 7 | **KNOWLEDGE CAPTURE:** khi SYNTHESIZE phát hiện insight mà KB chưa có → ghi NGAY theo KB Write Protocol | SIVIL có quyền ghi KB trực tiếp (SEARCH → FORMAT → WRITE; HAN curate sau) |

**Deliverables (dạng pipeline):**

```
Sub-agent plan → Synthesis report → Specs cho BELI (K specs)
              → G1 worklog (kèm Artifact Map)
              → + KB entries mới (insight từ synthesis)          ← [SRC dòng 187]
```

### 1.2 📜 INSTRUCTIONS — SIVIL

- **LUÔN:**
  - Đọc **Artifact Map** trước khi dispatch; ghi Artifact Map khi hoàn thành.
  - **Chọn số sub-agents đúng theo task** (không dùng max cho mọi task) — xem bảng §5.1.
  - Tham gia **Research Council** với KING (nhất là sau SYNTHESIZE).
  - **Insight mới chưa có trong KB → ghi ngay** theo KB Write Protocol.
- **KHÔNG BAO GIỜ:**
  - Tự code.
  - Quyết định "approach nào win" khi thiếu data.
  - Bỏ qua kết quả sub-agent mâu thuẫn nhau mà không điều tra.
- **Input contract:** task.md từ TL + Artifact Map từ Group trước.
- **Output contract:** specs (priority rõ ràng) + worklog + issues cho LISMA.
- **ESCALATE lên TL khi:** hypotheses của TL không thể decompose / sub-agents trả kết quả mâu thuẫn không giải thích được.
- **Signature move:** **parallel exploration** — 5–300 sub-agents tùy độ phức tạp.

### 1.3 [EXT] Bảng quyết định runtime cho SIVIL

| Tình huống | Hành động chuẩn ( suy ra từ Instructions ) |
|---|---|
| Nhận task M1 | N theo bảng §5.1 — task đã đến G1 nên tier ≥ MEDIUM: MEDIUM scope hẹp (vd EDA 1 dataset) → 5–10 (1 branch, parallel); COMPLEX → 30–300 (multi-branch, hybrid §4.2; Grand Competition = loại task M1 COMPLEX quy mô lớn, 100–300 SA) |
| Nhận task M2 | Decompose theo Module Map (§6.1); N = 5–15 SA / module map |
| SA trả kết quả mâu thuẫn | Điều tra bắt buộc (protocol §5.3) — không bỏ qua |
| Insight mới tại SYNTHESIZE | KB Write Protocol ngay trong phiên (SEARCH→FORMAT→WRITE) |
| Spec không implement được (BELI báo) | Feedback loop §8 → điều chỉnh plan → dispatch lại |
| Mâu thuẫn không giải thích được | ESCALATE KING kèm 2 interpretation (§5.3, §10.1) |
| Muốn sửa code BELI | **TỪ CHỐI** — chỉ review + ghi issues, sửa là việc LISMA (G2) |

### 1.4 [EXT] Đặc quyền hệ thống của SIVIL (duy nhất trong team)

- SIVIL là **agent duy nhất trong team được spawn sub-agents** (signature move). BELI/LISMA/HAN không spawn.
- Sub-agents kế thừa model stack chung (Kimi-k3 chính, fallback chain như TB-01 §Model Stack) — SA không có model riêng.
- SIVIL chịu trách nhiệm **vòng đời sub-agent**: spawn → monitor → thu kết quả → hủy SA (xem §5.4 stop conditions).

---

## §2. JOB DESCRIPTION + INSTRUCTIONS — BELI (G1 CODER)

**[TB-03 §2 ← nguồn dòng 198–219 — [SRC] giữ nguyên JD/Instructions, [EXT] bảng runtime]**

### 2.1 📋 JOB DESCRIPTION — BELI

**Sứ mệnh (Dual Mission):**

- **M1 — Kaggle:** code lượt đầu theo spec — nhanh, structure tốt, follow spec chính xác.
- **M2 — System Research:** viết research report + POC code minh họa proposal (**làm trong Workspace** — bản clone của hệ thống).

**Trách nhiệm chính (4 mục — nguyên văn nguồn, đánh số):**

| # | Trách nhiệm | Ghi chú triển khai [EXT] |
|---|---|---|
| 1 | **IMPLEMENT** từng spec của SIVIL (code hoặc report/POC) | M1: code file; M2: report + POC — chỉ trong Workspace |
| 2 | **Ghi notes** về edge cases gặp phải | Notes đi kèm mỗi draft; là đầu vào issues cho LISMA |
| 3 | **Đưa suggestions cho G2 (LISMA)** | Suggestions = ý tưởng cải tiến (vd: "Nên thêm Yeo-Johnson thay vì log transform") |
| 4 | **KHÔNG tự ý đổi approach** — có ý tưởng thì đề xuất ngược lại SIVIL | Kênh đề xuất = feedback loop §8, không tự thực thi |

**Deliverables:** `Code files (M1) / Research report + POC (M2) + Notes + Suggestions`

### 2.2 📜 INSTRUCTIONS — BELI

- **LUÔN:**
  - Code đúng spec.
  - Ghi chú mọi edge case.
  - Submit draft kèm notes + suggestions.
- **KHÔNG BAO GIỜ:**
  - Sửa code của agent khác.
  - Tự ý đổi approach đã được SYNTHESIZE chọn.
  - **(M2) Đụng tới Live System đang chạy** — mọi chỉnh sửa + POC chỉ thực hiện trong **Workspace** (bản clone của hệ thống).
- **Input contract:** specs từ SIVIL + Artifact Map.
- **Output contract:** draft + notes + suggestions → chuyển LISMA.
- **ESCALATE (qua SIVIL) khi:** spec mâu thuẫn / không thể implement đúng spec.
- **Signature move:** **first-pass accuracy** — draft tốt ngay lần đầu (LISMA sẽ lo phần sạch bug).

### 2.3 [EXT] Phân quyền môi trường của BELI (M2) — ranh giới Live System / Workspace

| Vùng | BELI được gì | BELI KHÔNG được gì |
|---|---|---|
| **Live System** (/home/z/tmo-app đang chạy) | **ĐỌC** code/docs/logs/health làm evidence cho report | Sửa file · restart PM2 · ghi .env · chạy POC · test destructive |
| **Workspace** (thư mục clone user mở) | Viết report · viết POC code · chỉnh sửa file clone · chạy thử POC | Áp bất kỳ thay đổi nào lên Live System (việc của user/agent ủy quyền, sau APPROVED) |
| **Proposal** (tài sản đầu ra M2) | Kèm diff/POC làm Options (TB-11) | Tự route Proposal đi đâu — SIVIL tổng hợp → KING route vào SELF-DIRECTION |

> **Quy tắc vàng M2 (điệp khúc lặp lại từ TB-01):** mọi thay đổi sống trong Workspace + Proposal — chỉ áp lên Live System sau khi Proposal **APPROVED** trong SELF-DIRECTION.

### 2.4 [EXT] Bảng quyết định runtime cho BELI

| Tình huống | Hành động chuẩn |
|---|---|
| Nhận SPEC #n (M1) | Implement đúng approach + file + expected output; kèm notes + suggestions khi submit |
| Nhận SPEC #n (M2) | Viết report section / POC trong Workspace; evidence kèm file:line từ Live System (chỉ đọc) |
| Gặp edge case khi code | Ghi vào Notes — KHÔNG âm thầm fix bằng cách đổi approach |
| Thấy approach dở | Đề xuất ngược lại SIVIL (suggestions) — vẫn code đúng spec đang chờ |
| Spec mâu thuẫn / không implement được | ESCALATE **qua SIVIL** (không nhảy thẳng KING) — kèm mô tả mâu thuẫn |
| Muốn sửa code của SA/agent khác | **TỪ CHỐI** — giữ trace sở hữu rõ (LISMA lo phần fix) |
| Phát hiện pattern/insight khi code | Ghi vào worklog trường **"KB Candidates"** (BELI không ghi KB trực tiếp — TB-08 §quyền ghi) |

---

## §3. NGUYÊN TẮC CỐT LÕI: "SIVIL ĐIỀU PHỐI, BELI THỰC THI"

**[TB-03 §3 ← nguồn dòng 221–247 — [SRC] đoạn + diagram nguyên bản]**

> SIVIL **không code** — SIVIL chỉ phân tích, lập kế hoạch, điều phối. BELI **chỉ code/viết report** — nhận spec và implement. Hai vai trò hoàn toàn tách biệt. Sự tách biệt này đến từ **định dạng công việc (JD)**, không phải từ việc hai agent dùng model khác nhau — cả hai đều chạy trên cùng model stack. [SRC dòng 221–223]

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
*[SRC dòng 225–247 — giữ nguyên diagram nguồn]*

### 3.1 Tách vai theo ROLE, không theo model — nghĩa là gì [SRC + EXT làm rõ]

| Khía cạnh | Giải thích |
|---|---|
| **Cùng "não"** | SIVIL và BELI đều chạy Kimi-k3 (fallback cùng chain DeepSeek v4 Pro → Flash → MiniMax-M3). KHÔNG có "model này nghĩ, model kia viết". |
| **Khác "bản điều khiển"** | Chất lượng phân vai đến từ **JD + Instructions** (§1, §2): cùng một model, nhận briefing khác nhau → hành vi khác nhau ("same brain, different briefing" — TB-01 §Model Stack). |
| **Lợi ích thiết kế [EXT]** | (1) Không lock-in model — đổi stack không phá vai trò; (2) fallback chain áp cho cả 2 agent như nhau, JD giữ nguyên khi fallback; (3) trách nhiệm rõ — mọi hành vi "điều phối" của BELI hoặc "code" của SIVIL là **vi phạm Instructions**, phát hiện được khi review worklog. |
| **Ranh giới cứng [SRC suy ra]** | SIVIL KHÔNG BAO GIỜ tự code; BELI KHÔNG BAO GIỜ tự ý đổi approach. Hai vạch này là định nghĩa của G1, không phải quy tắc mềm. |

---

## §4. G1 INTERNAL WORKFLOW — 6 BƯỚC

**[TB-03 §4 ← nguồn dòng 249–341 (ví dụ 5 bước) + 603–676 (schema 6 bước sau thêm SYNC) — [SRC]; cấu trúc block từng bước [EXT]]**

> Nguồn gốc có "Quy trình 5 bước"; sau khi bổ sung Knowledge Capture (Task 6 nguồn), workflow G1 chính thức là **6 bước**: DECOMPOSE → DISPATCH → SYNTHESIZE → **SYNC (RESEARCH COUNCIL)** → IMPLEMENT → VERIFY. Mỗi bước dưới đây trình bày theo khung thống nhất: **mục đích / input / thao tác / output / điều kiện sang bước kế**.

### 4.0 Schema tổng quan 6 bước (rút gọn từ diagram nguồn)

```
(KING) task.md + Artifact Map
        │
        ▼
 SIVIL ─ 1. DECOMPOSE   : Task → N sub-problems → N SA specs
        │                 (M1: theo approach / M2: theo Module Map)
        ─ 2. DISPATCH    : chọn Sequential/Parallel/Hybrid → spawn SAs
        │                 theo batches → thu thập kết quả song song
        ─ 3. SYNTHESIZE  : đánh giá → loại yếu/trùng/overfit → rank
        │                 top-K → tạo code spec chi tiết từng approach
        ─ 4. SYNC — RESEARCH COUNCIL (với KING): challenge hypotheses
        │                 → đối chiếu findings với KB → ghi KB ngay
        │ K specs (đã được council xác nhận)
        ▼
 BELI ── 5. IMPLEMENT   : nhận từng spec → code (M1) / report + POC
        │                 trong Workspace (M2) — kèm notes + suggestions
        │ Code/Report files + worklog
        ▼
 SIVIL ─ 6. VERIFY (không sửa code): khớp spec? completeness?
        │                 → ghi chú issues cho G2
        ▼
     G1 Output ──▶ G2 (LISMA)
```
*[SRC dòng 605–662 — rút gọn từ diagram box gốc của nguồn; câu chữ từng bước giữ nguyên ý nguồn — 3 khung SIVIL/BELI/SIVIL-review xem nguyên bản tại nguồn]*

---

### 4.1 ⬛ BƯỚC 1 — DECOMPOSE

**[TB-03 §4.1 ← nguồn dòng 251–262 (ví dụ nhận task) + 612–613 — [SRC]; khung block [EXT]]**

- **Mục đích:** biến 1 task phức tạp từ TL thành N sub-problems độc lập, mỗi sub-problem = 1 sub-agent spec, sẵn sàng dispatch.
- **Input:**
  - `task.md` từ KING (kèm mission_type M1/M2, tier, deadline, priority).
  - Artifact Map từ Group trước (đọc trước khi dispatch — Instructions SIVIL).
- **Thao tác:**
  1. Phân tích task: độ phức tạp, số khía cạnh, dữ liệu/module liên quan.
  2. Chọn trục decompose: **M1 → theo approach** (mỗi SA thử 1 approach/1 khía cạnh); **M2 → theo Module Map** (mỗi SA đọc 1 module/lớp hệ thống — §6).
  3. Dựng cây branch → sub-problem → sub-agent spec (SA-NN, id theo TB-00 §1.4).
  4. Chọn N đúng theo bảng §5.1 (KHÔNG dùng max cho mọi task).
- **Ví dụ nguồn (M1):**
  ```
  TL (KING) gửi task_complex_part1.md:
    "Part 1: EDA & Feature Understanding cho House Prices dataset"

  SIVIL phân tích:
    - Dataset có 79 features (mix numeric + categorical)
    - Có missing values
    - Cần hiểu distribution, correlation, outliers
    → Chia thành 5 sub-tasks song song
  ```
  *[SRC dòng 253–262]*
- **Output:** `sub-agent plan` (N specs SA-01..SA-N, gom theo branches) — deliverable đầu tiên của SIVIL.
- **Điều kiện sang bước kế:** N ≥ 1 và mỗi sub-problem có đủ: (a) phạm vi 1 dòng mô tả; (b) công cụ SA cần (code exec / web search / file read); (c) tiêu chí "kết quả hữu ích". Nếu task **không decompose được** (hypotheses của TL mơ hồ) → **ESCALATE KING** (Instructions SIVIL) — không tự bịa branch.

---

### 4.2 ⬛ BƯỚC 2 — DISPATCH

**[TB-03 §4.2 ← nguồn dòng 264–277 + 345–483 (cơ chế sub-agents + 3 chiến lược) + 615–619 — [SRC]; chi tiết batching [EXT] §5]**

- **Mục đích:** chạy N sub-agents theo chiến lược tối ưu (an toàn vs tốc độ), thu thập kết quả exploration độc lập.
- **Input:** sub-agent plan từ bước 1.
- **Thao tác:**
  1. Chọn 1 trong 3 chiến lược (bảng dưới).
  2. **Spawn sub-agents theo batches** — mỗi SA: context riêng (1 phần task) + công cụ riêng (code execution, web search, file read/write) + trả kết quả về SIVIL. [SRC dòng 345–348]
  3. Monitor batch đang chạy; thu kết quả khi SA hoàn thành.
  4. Xử lý SA fail/timeout theo §5.4; kết quả mâu thuẫn → điều tra §5.3.
- **3 chiến lược DISPATCH [SRC dòng 455–483]:**

| Chiến lược | Cách chạy | Ưu | Nhược | Khi nào dùng |
|---|---|---|---|---|
| **1. Sequential Batches** | Branch A → chờ xong → B → C → D | Kết quả Branch trước làm input Branch sau → chính xác hơn | Chậm hơn | Branch có phụ thuộc dữ liệu |
| **2. Parallel Waves** | Wave 1: tất cả N SAs chạy cùng lúc → SIVIL tổng hợp → điều chỉnh → Wave 2 | Nhanh nhất | Branch sau không tận dụng kết quả Branch trước | Branch độc lập hoàn toàn |
| **3. Hybrid (recommended)** | Batch 1: A+B song song → Batch 2: C (dùng features của B + insights của A) → Batch 3: D (ensemble từ C) | Tối ưu tốc độ × chất lượng | Cần vẽ đúng dependency | Mặc định cho task COMPLEX+ |

- **Ví dụ kết quả sau dispatch (M1):**
  ```
  Sub-agent 1: "Missing value: 19 features có NaN, PoolQC 99% → drop"
  Sub-agent 2: "GrLivArea có 2 outliers > 4000 sqft"
  Sub-agent 3: "OverallQual correlation với SalePrice = 0.79"
  ... (SA-04: Neighborhood 25 categories → target encoding; SA-05:
       TotalBsmtSF right skew → log transform; từ 5-20 sub-agents
       có kết quả hữu ích)
  ```
  *[SRC dòng 266–277 — rút gọn]*
- **Output:** bảng kết quả sub-agents (mỗi SA 1 dòng: status ✅/⚠️/❌ + phát hiện chính + metric nếu có).
- **Điều kiện sang bước kế:** tất cả SA trong plan đã trả kết quả **hoặc** kích hoạt stop condition §5.4 (SA chết không hồi phục). Nếu còn mâu thuẫn chưa điều tra xong → KHÔNG sang SYNTHESIZE (vi phạm Instructions "không bỏ qua kết quả mâu thuẫn mà không điều tra").

---

### 4.3 ⬛ BƯỚC 3 — SYNTHESIZE

**[TB-03 §4.3 ← nguồn dòng 279–311 (bước 3 ví dụ) + 485–541 (ví dụ synthesize đầy đủ) + 621–625 — [SRC]]**

- **Mục đích:** biến N kết quả rời rạc thành **top-K approaches có rank** + **K specs cho BELI** — đây là bước "não tổng hợp" của G1.
- **Input:** bảng kết quả tất cả sub-agents (bước 2).
- **Thao tác:**
  1. Đánh giá chất lượng từng approach (dựa data/metric SA trả về — KHÔNG quyết định "ai win" khi thiếu data).
  2. **Loại** approaches yếu / trùng lặp / overfit. [SRC dòng 623]
  3. **Rank top-K** (K = 3–5) theo priority. [SRC dòng 283–284]
  4. **Tạo spec chi tiết cho BELI** — theo SPEC template §7.3 (id, nhiệm vụ, acceptance, files dự kiến, ràng buộc, deadline nội bộ, priority, approach, expected output).
  5. **KNOWLEDGE CAPTURE hook:** insight từ sub-agents mà KB chưa có → đánh dấu ghi KB ngay (hoàn tất ở bước 4 sau khi council đối chiếu). [SRC dòng 185]
- **Ví dụ tổng hợp (nguồn — 35 SAs House Prices):**
  ```
  SIVIL tổng hợp:
    → Top 3 approaches:
      1. Stacking (LGBM + XGB + CatBoost) + Target Encoding + Domain Features
      2. Weighted Average + All top features
      3. Single XGBoost tuned + Target Encoding

    → Tạo 3 specs cho BELI code chi tiết
    → Ghi worklog với insights + recommendations
    → Giao cho BELI
  ```
  *[SRC dòng 532–540; bảng kết quả 35 SA đầy đủ tại dòng 488–530 — xem Phụ lục A]*
- **Ví dụ specs gửi BELI (nguồn):**
  ```
  ┌─────────────────────────────────────────┐
  │ SPEC #1: Missing Value Handling         │
  │ Priority: HIGH                           │
  │ Approach: Drop columns >80% missing,    │
  │           median impute numeric,        │
  │           mode impute categorical       │
  │ Expected output: clean dataframe        │
  │ File: src/preprocessing/missing.py      │
  └─────────────────────────────────────────┘
  (SPEC #2: Outlier Removal — HIGH; SPEC #3: Feature Transform — MEDIUM:
   cùng cấu trúc — xem nguồn dòng 287–310 & template chuẩn §7.3)
  ```
  *[SRC dòng 287–310 — rút gọn còn SPEC #1 làm mẫu; 3 spec gốc đầy đủ tại nguồn]*
- **Output:** `Synthesis report` (rank + lý do loại) + K specs (M2: tổng hợp theo **Findings Schema** §6.3 thay vì CV metric).
- **Điều kiện sang bước kế:** K ≥ 1 spec hoàn chỉnh. Nếu **K = 0** (kết quả rỗng/yếu toàn bộ) → không sang council thường lệ; quay lại DISPATCH với plan điều chỉnh hoặc ESCALATE nếu hết phương án (§10.3).

---

### 4.4 ⬛ BƯỚC 4 — SYNC: RESEARCH COUNCIL (KING ↔ SIVIL)

**[TB-03 §4.4 ← nguồn dòng 627–630 + 1748–1771 (Research Council) + 184 (JD SIVIL) — [SRC]; thủ tục hội đồng [EXT] chi tiết nằm ở TB-08]**

- **Mục đích:** trước khi BELI tiêu nguồn lực code, KING **challenge hypotheses** của synthesis và **đối chiếu findings với KB** — chốt tri thức mới ngay tại phiên council. Đây là **thời điểm council ②** trong 4 thời điểm cố định (① sau DECOMPOSE-TL, ② sau SYNTHESIZE-G1, ③ khi ESCALATE, ④ tại Checkpoint — TB-08).
- **Input:** Synthesis report + K specs (draft) + KB (để đối chiếu) + danh sách insight ứng viên.
- **Thao tác (SIVIL trong council):**
  1. Trình bày top-K + evidence; KING hỏi — SIVIL **đáp bằng findings** (không đoán). [SRC dòng 1763–1765]
  2. Đối chiếu từng insight với KB: **"đã có chưa?"** — đã có → bỏ qua (hoặc bổ sung evidence làm entry mạnh hơn); chưa có → ứng viên ghi mới. [SRC dòng 1766, 1777–1779]
  3. Chốt tri thức mới → SIVIL ghi KB **NGAY** theo KB Write Protocol (SEARCH → FORMAT → WRITE; HAN curate ở chu kỳ G3 gần nhất). [SRC dòng 1766–1770, 1774–1789]
  4. Ghi **discussion summary vào worklog** (vì lỗ hổng ③ thiết kế cũ: thảo luận KING↔SIVIL không lưu → insight mất ngay khi kết thúc). [SRC dòng 1732–1733, 1769]
- **Output:**
  - KB entries mới (KB-YYYYMMDD-NNN, category có thể là **Research Insights** — tri thức phương pháp nghiên cứu). [SRC dòng 1813–1815]
  - Council summary trong G1 worklog.
  - K specs đã được KING xác nhận (hoặc chỉnh priority/scope).
- **Điều kiện sang bước kế:** council kết thúc = specs được xác nhận + mọi insight đã ghi KB. KHÔNG sang IMPLEMENT khi còn hypothesis chưa được challenge — council ② là **cổng bắt buộc** trước khi BELI code. [SRC dòng 1758]

---

### 4.5 ⬛ BƯỚC 5 — IMPLEMENT (BELI)

**[TB-03 §4.5 ← nguồn dòng 313–327 (ví dụ bước 4 cũ) + 635–647 — [SRC]]**

- **Mục đích:** BELI nhận từng spec → sinh artifact: **code lượt đầu (M1)** hoặc **research report + POC trong Workspace (M2)** — draft tốt ngay lần đầu (signature move).
- **Input:** K specs từ SIVIL (sau council) + Artifact Map.
- **Thao tác:**
  - M1: BELI nhận SPEC #1 → code → submit; SPEC #2 → code → submit; ... tuần tự hoặc song song (tùy infrastructure). [SRC dòng 316–321]
  - M2: BELI viết research report (theo Findings Schema + evidence file:line) + **POC code minh họa chạy thử trong Workspace**. [SRC dòng 641, 590]
  - Mỗi submission kèm: draft đầy đủ theo spec + **notes** (edge cases gặp phải) + **suggestions** cho G2. [SRC dòng 643–646]
  - Feedback song song: issue/khó khăn → feedback loop §8 (SIVIL điều chỉnh, dispatch lại nếu cần).
- **Ví dụ nguồn:**
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
  *[SRC dòng 315–327]*
- **Output:** draft(s) + notes + suggestions (chuyển qua SIVIL review — bước 6, rồi LISMA).
- **Điều kiện sang bước kế:** tất cả K specs đã submit. Nếu 1 spec **không implement được / mâu thuẫn** → BELI ESCALATE **qua SIVIL** (Instructions BELI) → SIVIL xử lý theo §8 hoặc ESCALATE KING (§10.1).

---

### 4.6 ⬛ BƯỚC 6 — VERIFY (SIVIL review)

**[TB-03 §4.6 ← nguồn dòng 329–341 (ví dụ bước 5 cũ) + 651–657 — [SRC]]**

- **Mục đích:** SIVIL kiểm tra output BELI **khớp spec** trước khi giao G2 — review **KHÔNG sửa code** (ranh giới cứng §3).
- **Input:** drafts + notes + suggestions từ BELI; K specs gốc để đối chiếu.
- **Thao tác:**
  1. **Check output có khớp spec không** (approach đúng? expected output đúng? file đúng?). [SRC dòng 654]
  2. **Đánh giá completeness** (đủ các phần spec yêu cầu?). [SRC dòng 655]
  3. **Ghi chú issues cho G2** — mọi phát hiện ⚠️ đi vào worklog để LISMA xử lý. [SRC dòng 656]
  4. Tổng hợp **G1 Output** package (§7.2) → giao LISMA. [SRC dòng 339–340]
- **Ví dụ nguồn:**
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
  *[SRC dòng 331–341]*
- **Output:** G1 Output package: code files / report + worklog (issues, notes, suggestions, KB Candidates, council summary, Artifact Map cập nhật) → handoff LISMA (TB-09).
- **Điều kiện sang bước kế:** mọi spec đã verify (✅ pass hoặc ⚠️ có issue-ghi-chú cho G2 — cả hai đều được handoff; ❌ sai spec → trả BELI làm lại theo feedback loop §8). Sau handoff: state `HANDED_OFF` (§9).

---

## §5. SUB-AGENT POOL — CƠ CHẾ 5–300 SUB-AGENTS CỦA SIVIL

**[TB-03 §5 ← nguồn dòng 343–541 — [SRC] bảng + giai đoạn + chiến lược; §5.3–5.5 [EXT]]**

### 5.1 Sub-agent là gì & số lượng theo loại task

SIVIL chạy trên model stack (Kimi-k3 chính) với **agent framework** — khả năng spawn sub-agents. Mỗi sub-agent là một instance độc lập có: **context riêng** (nhận 1 phần task) · **công cụ riêng** (code execution, web search, file read/write) · **khả năng trả kết quả về SIVIL chính**. [SRC dòng 345–348]

**Bảng số lượng sub-agents theo loại task (giữ nguyên bảng nguồn — kể cả dòng System Audit M2):**

| Loại task | Số sub-agents | Chiến lược |
|-----------|--------------|------------|
| EDA (1 dataset) | 5-10 | Mỗi SA explore 1 khía cạnh |
| Feature Engineering | 10-20 | Mỗi SA thử 1 loại feature |
| Model Selection | 15-30 | Mỗi SA thử 1 model/config |
| Full Pipeline | 30-50 | Chia theo phase, mỗi phase có SA riêng |
| Research Paper | 50-100 | SA cho mỗi section + SA cho experiments |
| Grand Competition | 100-300 | Multi-phase, multi-approach, multi-experiment |
| System Audit M2 (1 module map) | 5-15 | Mỗi SA đọc 1 module/lớp hệ thống |

*[SRC dòng 350–361]*

### 5.2 Khi nào dùng ít / nhiều + chiến lược batch

| N | Dấu hiệu task | Chiến lược batch khuyến nghị [EXT] |
|---|---|---|
| **Ít (5–15)** | Scope hẹp: 1 dataset/1 câu hỏi (tier MEDIUM — tier SIMPLE không qua G1, nguồn dòng 3187–3191) hoặc 1 module map M2 (tier COMPLEX — audit 1 module = 7 điểm, nguồn dòng 3279); deadline gấp | 1 wave parallel — tất cả SA chạy 1 lần, tổng hợp luôn |
| **Trung bình (15–50)** | 2–4 branch còn độc lập nhau; tier COMPLEX | Hybrid: branch độc lập gộp chung batch; branch phụ thuộc đợi |
| **Nhiều (50–300)** | Multi-phase × multi-approach (Grand Competition — loại task M1 COMPLEX quy mô lớn); cần coverage tối đa | Sequential theo phase + parallel trong phase; mỗi phase synthesize giữa lúc rồi điều chỉnh phase sau |

**Quy tắc chọn [EXT — cụ thể hóa Instructions "không dùng max cho mọi task"]:**
1. Bắt đầu từ số lượng thấp nhất của khoảng trong bảng §5.1; chỉ tăng khi coverage còn hở, theo bước **+25–50% mỗi lần điều chỉnh** (vd 12 → 18 → 27) — không nhảy thẳng max.
2. 300 là **trần tuyệt đối** của Grand Competition — KHÔNG vượt (khai niệm ngoài nguồn = vi phạm TB-00 §5 "cấm phát minh cơ chế mâu thuẫn nguồn").
3. Mỗi SA phải có mục đích phân biệt được viết trong spec — cấm spawn "cho đủ số".

### 5.3 [EXT] Sub-agents TRẢ KẾT QUẢ MÂU THUẪN — protocol xử lý

Phát sinh từ Instructions SIVIL: *"bỏ qua kết quả sub-agent mâu thuẫn nhau mà không điều tra"* (cấm) + ESCALATE khi *"sub-agents trả kết quả mâu thuẫn không giải thích được"*.

```
┌─────────────────────────────────────────────────────────────┐
│ CONFLICT RESOLUTION PROTOCOL (SA vs SA)                     │
│                                                             │
│ Bước 1 — PHÁT HIỆN: SYNTHESIZE thấy 2+ SA cùng chủ đề       │
│           trả kết quả trái ngược (vd: SA-07 vs SA-09)       │
│ Bước 2 — ĐIỀU TRA (bắt buộc, không bỏ qua):                 │
│   2a. Đối chiếu context: 2 SA có cùng input/dataslice?      │
│   2b. Đối chiếu evidence: metric/file:line nào thật?        │
│   2c. Spawn SA điều tra (arbitrator) nếu cần — đọc lại      │
│       chứng cứ, chạy lại phép đo với input đồng nhất        │
│ Bước 3A — GIẢI THÍCH ĐƯỢC → ghi nhận:                       │
│   mâu thuẫn do context khác nhau → tách thành 2 claim       │
│   điều kiện ("A đúng khi X, B đúng khi Y") → dùng khi       │
│   rank top-K                                                │
│ Bước 3B — KHÔNG GIẢI THÍCH ĐƯỢC → ESCALATE KING:            │
│   trình bày CẢ 2 INTERPRETATION + evidence từng bên +       │
│   đề xuất thử nghiệm phân biệt (nếu có) → KING quyết        │
└─────────────────────────────────────────────────────────────┘
```

- Council ② (bước 4 §4) là nơi các mâu thuẫn lớn nhất được challenge lần cuối trước khi BELI code.
- Kết quả điều tra (dù 3A hay 3B) được ghi worklog — nếu là insight về "cách verify claim mâu thuẫn" → KB category **Research Insights**. [EXT — theo category nguồn dòng 1813–1815]

### 5.4 [EXT] Stop conditions & giới hạn batch

Nguồn không định nghĩa ngưỡng dừng — phần này là thiết kế bổ sung (không mâu thuẫn nguồn: nguồn chỉ nói "5–300 tùy độ phức tạp"):

| # | Stop condition | Hành động |
|---|---|---|
| S1 | **Batch đầy SA lỗi** — ≥ 50% SA trong batch fail/timeout 2 lần retry | Dừng batch → kiểm tra nguyên nhân hạ tầng (model stack? tool lỗi?) → ESCALATE nếu ngoài tầm SIVIL |
| S2 | **Bão hòa insight** — 2 batch liên tiếp không cho claim mới so với tổng hiện có | Dừng dispatch, sang SYNTHESIZE (đã đủ coverage) |
| S3 | **Trần N chạm** — tổng SA đã spawn = trần theo bảng §5.1 mà coverage còn hở | Dừng → SYNTHESIZE với khiếm khuyết được ghi rõ trong report → council ② quyết định tiếp |
| S4 | **Deadline nội bộ** — hết thời gian budgets của G1 trong tier plan (TB-02) | Dừng → tổng hợp phần có → handoff kèm note "coverage còn hở ở branch X" |
| S5 | **SA đơn lẻ chết** | Retry ≤ 2 lần (context y nguyên); vẫn chết → đánh dấu ❌ trong bảng kết quả, KHÔNG chặn batch |

**Giới hạn batch [EXT]:**
- Kích thước batch mặc định: **10–25 SA chạy đồng thời** (đủ để framework điều phối, không trôi tụt context SIVIL). Wave lớn hơn phải chia batch con.
- Monitor: SIVIL giữ registry SA-NN → {status: PENDING/RUNNING/DONE/FAILED, branch, kết quả, retries}.
- SA không spawn SA khác (chỉ SIVIL spawn — 1 tầng duy nhất).

### 5.5 Ví dụ Decompose M1 — House Prices (35 SAs / 4 branches)

3 giai đoạn hoạt động của SIVIL (DECOMPOSE → DISPATCH → SYNTHESIZE — diagram box tại nguồn dòng 362–402) trùng khớp bước 1–3 của G1 Internal Workflow (§4.0–§4.3). Ví dụ decompose 1 task M1 trọn vẹn:

```
Task: "Xây dựng ML pipeline cho House Prices competition"

SIVIL Decompose — 35 SAs / 4 branches:
│
├── Branch A: Data Understanding (5 SAs — SA-01..05)
│     missing patterns · distribution · correlation · outliers · categorical
├── Branch B: Feature Engineering (10 SAs — SA-06..15)
│     polynomial · log · target/frequency encoding · interactions (num×num,
│     num×cat) · binning · aggregation · time-based · domain-specific
├── Branch C: Model Exploration (15 SAs — SA-16..30)
│     Linear/Ridge/Lasso/ElasticNet · XGBoost/LightGBM/CatBoost (default +
│     tuned mỗi loại) · Random Forest · Extra Trees · SVR · KNN · MLP
└── Branch D: Ensemble Strategies (5 SAs — SA-31..35)
      simple avg · weighted avg · stacking (Linear/XGB meta) · blending
```
*[SRC dòng 404–453 — cấu trúc branch & dải SA nguyên bản, liệt kê từng SA rút gọn; bảng kết quả 35 SA đầy đủ (status ✅/⚠️/❌ + CV, Stacking Linear 0.118 ← BEST) tại nguồn dòng 488–530 — ví dụ chuẩn định dạng input của SYNTHESIZE]*

---

## §6. MODE M2 — SYSTEM RESEARCH: MODULE MAP & AUDIT

**[TB-03 §6 ← nguồn dòng 543–601 — [SRC]]**

> Khi mission là **M2 (System Research TMO)**, SIVIL KHÔNG decompose theo "approach" mà decompose theo **Module Map** — mỗi sub-agent phụ trách 1 module của hệ thống. [SRC dòng 543–545]

### 6.1 Module Map TMO — SA ↔ module ↔ nguồn đọc

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

*[SRC dòng 547–557]*

- **Nguồn được phép đọc (M2):** source code, README, docs, .env.example, dev.log, PM2 logs, health check API. [SRC dòng 558]
- **KHÔNG được phép:** sửa bất kỳ file nào của TMO — mọi thay đổi chỉ nằm trong **PROPOSAL**. [SRC dòng 559]
- **Phân rẽ M1/M2 tại từng bước [EXT]:**

| Step G1 | M1 — Kaggle | M2 — System Research |
|---|---|---|
| DECOMPOSE | Theo approach (feature/model/ensemble...) | Theo Module Map (8 module trên) |
| DISPATCH | SA explore approach + đo CV | SA đọc module + thu findings kèm evidence |
| SYNTHESIZE → COUNCIL | Rank top-K theo metric → challenge hypotheses model | Findings Schema (§6.3) → challenge findings + đối chiếu KB |
| IMPLEMENT | BELI code pipeline | BELI viết report + POC **trong Workspace** |
| VERIFY | Check code khớp spec | Check report có evidence + POC chạy trong Workspace |

### 6.2 Ví dụ Decompose M2 — "Nghiên cứu kiến trúc bộ nhớ TMO" (giữ nguyên cấu trúc nguồn)

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
*[SRC dòng 561–591 — giữ nguyên cấu trúc 13 SAs / 4 branch A–D]*

> Cấu trúc 4 branch (Hiện trạng → Điểm yếu → Pattern tham khảo → Feasibility) là **pattern audit chuẩn của M2** — chính entry KB-20250612-003 (nguồn dòng 1811) đã ghi nhận pattern này làm Research Insight: *"Decompose audit hệ thống theo 4 branch cho coverage đủ."*

### 6.3 Findings Schema — kết quả mỗi SA trả về (M2)

```
| # | Finding | Evidence (file:line / log excerpt) | Severity | Cơ hội cải thiện |
|---|---------|-------------------------------------|----------|------------------|
| 1 | ...     | src/lib/xxx.ts:123                  | 🔴 HIGH  | ...              |
```

*[SRC dòng 593–599 — giữ nguyên schema]*

- **Quy tắc bắt buộc:** mỗi finding BẮT BUỘC có evidence — **không có evidence = không được ghi vào report** (đây là cơ sở cho VERIFY của KING ở Checkpoint). [SRC dòng 601]
- Quy tắc hiệp thông với Knowledge Capture: insight không có evidence = không ghi KB (quy tắc vàng KB #3 — nguồn dòng 1821). Hai quy tắc này cùng một triết lý: **evidence-first toàn tuyến M2**.
- [EXT] Thang Severity chuẩn hóa: 🔴 HIGH (chặn/dừng tính năng hoặc gây lỗi lặp lại) · 🟡 MEDIUM (giảm chất lượng/chậm nhưng không chết) · 🟢 LOW (cơ hội cải thiện, không lỗi). Cột `Cơ hội cải thiện` luôn viết dạng hành động + module đích (để HAN/TB-05 dùng làm input Proposal).
- [EXT] **Mapping severity G1 → G2:** thang 3 mức trên là thang *tiền-chẩn-đoán* của SA (mới phát hiện, chưa xác minh). Khi findings đi tiếp sang LISMA (G2) và được chẩn đoán thành root cause, thang chuẩn **4 mức CRITICAL / HIGH / MEDIUM / LOW** của G2 (TB-04 §4.1) áp dụng cho cùng chuỗi evidence M2 này: HIGH (G1) → HIGH, hoặc CRITICAL nếu hậu quả dữ liệu/dịch vụ đủ nghiêm trọng (theo định nghĩa CRITICAL của TB-04); MEDIUM → MEDIUM; LOW → LOW. LISMA nâng/hạ mức theo evidence — severity G1 chỉ là giá trị khởi tạo.
- [EXT] Mỗi dòng finding nhận id `F-NNN` (TB-00 §1.4) để LISMA/HAN/KING truy vấn chéo trong worklog + Proposal.

---

## §7. [EXT] G1 INTERFACE CONTRACT

**[TB-03 §7 ← thiết kế mới mở rộng từ Input/Output contract trong JD §1.2, §2.2 — [EXT], không mâu thuẫn nguồn]***

### 7.1 Input — G1 nhận gì

| Nguồn | Artifact | Nội dung bắt buộc | Khi nào |
|---|---|---|---|
| **KING (TL)** | `task.md` (T-<MISSION>-<NNN>) | Mô tả part cần làm + mission_type (M1/M2) + tier + priority + deadline + expected output | Sau ASSIGN của TL (council ① đã xong ở cấp TL) |
| **KING (TL)** | `Artifact Map` | Danh mục artifact từ Group trước / task trước: M1 `artifact:type:metric_impact` · M2 `file:type:relevance:status` (TB-10) | Kèm task.md — SIVIL PHẢI đọc trước dispatch |
| **Group trước** | Artifacts vật lý (code/report/POC + worklog) | Files thực tế mà Artifact Map trỏ tới | M1: task phase trước; M2: audit module trước |
| **User (qua TL)** | Workspace path (M2) | Đường dẫn thư mục clone — nơi BELI viết report/POC/chạy thử | Khi task M2 cần POC; nếu thiếu → SIVIL yêu cầu qua KING (§10.6) |
| **KB (đọc)** | KB entries liên quan | Research Insights / System Patterns / Anti-Patterns áp dụng cho task | Trước DECOMPOSE + trong council ② |

### 7.2 Output — G1 trả gì

| Đích | Artifact | Nội dung bắt buộc |
|---|---|---|
| **LISMA (G2)** | G1 Output package | Code files (M1) / Research report + POC (M2) + worklog (issues ✅⚠️, notes edge case, suggestions, **KB Candidates** của BELI) + Artifact Map cập nhật |
| **KING (TL)** | KB entries + council summary | KB-YYYYMMDD-NNN ghi trực tiếp tại SYNTHESIZE/council; council discussion summary (trong worklog, đánh dấu section `council`) |
| **KING (TL)** | Escalation report (nếu có) | 2 interpretation trong SA-conflict (§5.3) / spec-blocked (§10.1) — kèm evidence từng bên |
| **BELI (nội bộ G1)** | K specs | Template §7.3 — priority rõ ràng |
| **HAN (G3, gián tiếp)** | Findings + POC + benchmarks | Input cho Proposal items (kèm Verification Plan — TB-11); HAN curate KB Candidates của BELI sau |

**G1 worklog schema [EXT — cụ thể hóa "G1 worklog (kèm Artifact Map)" dòng 187]:**

```markdown
## G1 Worklog — Task T-<MISSION>-<NNN> — Group G1
- Task ref / mission / tier / SIVIL / BELI / thời gian
- Sub-agent plan: N, branches, chiến lược dispatch (bảng SA registry rút gọn)
- Kết quả SYNTHESIZE: top-K + lý do loại approaches
- Council summary (bước 4): challenge gì, chốt gì, KB ghi những entry nào (id)
- Specs đã giao BELI: SPEC-IDs + verify verdict từng spec (✅/⚠️/❌)
- Notes (BELI): edge cases
- Suggestions (BELI → G2)
- Issues cho LISMA: từng ⚠️/❌ + ngữ cảnh
- KB Candidates (BELI): insight + evidence (chờ KING/SIVIL/HAN xác nhận ghi)
- Artifact Map cập nhật: entries mới + status
```

### 7.3 SPEC template cho BELI

Template hợp nhất: giữ các trường của ví dụ nguồn (Priority / Approach / Expected output / File — dòng 287–310) + bổ sung trường bắt buộc theo yêu cầu runtime [EXT]:

```markdown
## SPEC — <SPEC-ID> (vd: SPEC-HP-001)
- **ID:** <SPEC-ID> — duy nhất trong task
- **Nhiệm vụ:** <1 câu — làm gì, thuộc approach nào của top-K>
- **Priority:** HIGH | MEDIUM | LOW
- **Approach:** <method/bước thực hiện đã được SYNTHESIZE chọn + council xác nhận>
- **Acceptance:** <tiêu chí đậu khi VERIFY: output/expected shape, hành vi, metric tối thiểu>
- **Expected output:** <artifact + hình dạng (vd: clean dataframe, report section) >
- **Files dự kiến:** <danh sách file sẽ tạo/sửa — M1: src/...; M2: workspace path + report path>
- **Ràng buộc:** <giới hạn: KHÔNG đổi approach; M2: chỉ trong Workspace, KHÔNG đụng Live System;
  dependency versions; không sửa file ngoài spec; quy ước style nếu có>
- **Deadline nội bộ:** <mốc trước deadline task — đủ dư cho VERIFY của SIVIL + chu kỳ G2>
- **Notes từ SIVIL:** <edge case đã biết từ SA findings — để BELI chủ động>
```

- M1 → Files dự kiến trỏ vào repo competition (vd `src/preprocessing/missing.py`); [EXT] quy tắc: 1 spec = 1 artifact giao được (không gộp nhiều file không liên quan), spec KHÔNG chứa code sẵn — chỉ mô tả (BELI là người code).
- M2 → Files dự kiến trỏ vào **Workspace** (report: `workspace/reports/...`; POC: `workspace/poc/...`); ràng buộc luôn chứa dòng **"CHỈ Workspace — Live System read-only"**.

---

## §8. FEEDBACK LOOP BELI → SIVIL

**[TB-03 §8 ← nguồn dòng 240–245 (diagram feedback) + 672 (bảng tóm tắt "Feedback loop") — [SRC]]**

> Feedback loop G1: BELI → SIVIL: **code issues, suggestions → SIVIL điều chỉnh** kế hoạch, dispatch lại sub-agents nếu cần. [SRC dòng 672, 241–245]

```
┌──────────────────────────────────────────────────────────────┐
│ FEEDBACK LOOP BELI → SIVIL (chạy trong bước 5 IMPLEMENT)     │
│                                                              │
│ BELI (đang code spec):                                       │
│   "Code X chạy chậm, cần approach khác" / "Spec mâu thuẫn    │
│   Y vs Z" / "Không implement được vì ràng buộc R"            │
│        │ (escalate QUA SIVIL — Instructions BELI)            │
│        ▼                                                     │
│ SIVIL nhận feedback → phân loại 3 nhánh:                     │
│   (a) vấn đề hiệu năng → có data? → đánh giá lại approach    │
│       trong SYNTHESIZE → điều chỉnh spec nếu hợp lệ          │
│   (b) spec lỗi nội bộ → sửa spec, giao lại BELI              │
│   (c) hypothesis gốc sai → DISPATCH LẠI sub-agents cho       │
│       nhánh liên quan (diagram nguồn dòng 244–245)           │
│        ├── đủ nhỏ → không cần KING                           │
│        └── đổi approach đã council-chốt → tái council ③ (TB-08)│
└──────────────────────────────────────────────────────────────┘
```

- **Phạm vi hợp lệ của feedback:** code issues (chậm, bug pattern, edge case cản trở) + suggestions (ý tưởng tốt hơn). **KHÔNG phải** BELI tự đổi approach — mọi thay đổi approach phải qua SIVIL (và council nếu ảnh hưởng hypothesis đã chốt). [SRC dòng 208, 215]
- [EXT] Định dạng 1 feedback entry trong worklog: `{SPEC-ID, loại (a/b/c), mô tả, evidence, action của SIVIL}` — để LISMA/KING truy vết được "vì sao approach đổi giữa chừng".
- [EXT] Giới hạn vòng: nếu cùng 1 spec bị điều chỉnh **≥ 2 lần** do feedback → đó là tín hiệu hypothesis yếu → SIVIL chủ động escalate council ③ thay vì tiếp tục xoay vòng dispatch.

---

## §9. [EXT] LUỒNG & STATE — G1 STATE MACHINE

**[TB-03 §9 ← thiết kế mới suy ra từ 6 bước §4 — [EXT], không mâu thuẫn nguồn]**

### 9.1 Diagram state machine

```
 (KING ASSIGN: task.md + Artifact Map)
                │
                ▼
         ┌─────────────┐   hypotheses không decompose được ──┐
         │  RECEIVED   │                                     │
         └──────┬──────┘                                     │
                │ decompose xong (N sub-problems)            │
                ▼                                            ▼
         ┌─────────────┐  mâu thuẫn SA không giải thích ┌─────────────┐
         │ DECOMPOSED  │───được (§5.3 3B, §10.4; spec   │  ESCALATED  │
         └──────┬──────┘    mâu thuẫn §10.1 cũng vào)  │ (từ state   │
                │                                    └──│ đang chạy — │
                │ spawn batch 1 (strategy đã chọn)      │  §9.3)      │
                ▼                                       └──────┬──────┘
   ┌────▶ ┌─────────────┐                                      │
   │ re-  │ DISPATCHED  │ ◀─ re-dispatch: feedback §8 /         │ council ③:
   │ disp └──────┬──────┘    K=0 yếu (§10.3) → quay lại đây    │ KING ↔ SIVIL
   │             │                                        │ + ghi KB →
   │             ▼ đủ SA trả kết quả                      │ KING quyết:
   │      ┌─────────────┐                                 │ DECOMPOSED /
   │      │ SYNTHESIZED │                                 │ DISPATCHED /
   │      └──────┬──────┘                                 │ SYNTHESIZED /
   │             ▼ council ② xong                         │ hủy task
   │      ┌──────────────┐                                │ (ghi worklog)
   │      │ COUNCIL_DONE │ ← cổng bắt buộc trước khi      │
   │      └──────┬───────┘   BELI code                    │
   │             ▼ K specs → BELI                         │
   │      ┌──────────────┐   BELI feedback (a/b/c) — §8;  │
   │      │ IMPLEMENTING │◀── spec mâu thuẫn / không      │
   │      └──────┬───────┘   implement được (§10.1)       │
   │             ▼ đủ K drafts                            │
   │      ┌──────────────┐                                │
   │      │   VERIFIED   │ (không sửa code; ❌ sai spec → │
   │      └──────┬───────┘  về BELI làm lại theo feedback)│
   │             ▼ G1 Output package                      │
   │      ┌──────────────┐                                │
   └─────▶│  HANDED_OFF  │──▶ G2 (LISMA)                   │
          └──────────────┘                                │
```

### 9.2 Bảng transition

| Từ | Event | Sang | Điều kiện (guard) |
|---|---|---|---|
| — | KING ASSIGN task.md | **RECEIVED** | task.md + Artifact Map đầy đủ |
| RECEIVED | DECOMPOSE xong | **DECOMPOSED** | N ≥ 1 sub-problem; mỗi sub có spec |
| RECEIVED | hypotheses không decompose được | **ESCALATED** | ESCALATE-KING (Instructions SIVIL) |
| DECOMPOSED | chọn strategy + spawn batch 1 | **DISPATCHED** | strategy ∈ {Sequential, Parallel, Hybrid}; batch ≤ giới hạn §5.4 |
| DISPATCHED | đủ kết quả SA (hoặc stop condition) | **SYNTHESIZED** | không còn mâu thuẫn chưa điều tra (§5.3) |
| DISPATCHED | mâu thuẫn SA không giải thích được | **ESCALATED** | sau bước 3B protocol §5.3 — kèm 2 interpretation |
| SYNTHESIZED | council ② xong | **COUNCIL_DONE** | specs được KING xác nhận + insight mới đã ghi KB + council summary vào worklog |
| SYNTHESIZED | K = 0 (kết quả rỗng/yếu) | **DISPATCHED** | re-dispatch plan điều chỉnh (giới hạn vòng §8) |
| COUNCIL_DONE | giao K specs cho BELI | **IMPLEMENTING** | specs theo template §7.3 |
| IMPLEMENTING | BELI submit đủ K drafts | **VERIFIED** | drafts + notes + suggestions đủ |
| IMPLEMENTING | feedback loop (a/b/c) | **DISPATCHED** | SIVIL điều chỉnh plan — xem §8 |
| IMPLEMENTING | spec mâu thuẫn/không implement được | **ESCALATED** | BELI escalate qua SIVIL (§10.1) |
| DISPATCHED | stop condition S1 — ≥ 50% SA fail/timeout do lỗi hạ tầng ngoài tầm SIVIL | **ESCALATED** | kèm báo cáo kỹ thuật (§10.2) |
| SYNTHESIZED | K = 0 sau 2 vòng re-dispatch | **ESCALATED** | trình "negative result có chứng cứ" → council ③ quyết (§10.3) |
| RECEIVED/DECOMPOSED | workload vượt trần loại task (dấu hiệu tier sai) | **ESCALATED** | đề xuất KING nâng tier / DECOMPOSE lại ở cấp TL (§10.4) |
| VERIFIED | mọi spec ✅/⚠️ (⚠️ có issue-ghi-chú) | **HANDED_OFF** | G1 Output package §7.2 hoàn chỉnh → LISMA |
| VERIFIED | spec ❌ sai spec | **IMPLEMENTING** | trả BELI làm lại theo feedback (không tự sửa — SIVIL chỉ ghi) |
| ESCALATED | KING quyết | DECOMPOSED / DISPATCHED / SYNTHESIZED / hủy | tùy phán quyết; mọi quyết định ghi worklog |

### 9.3 Điều kiện ESCALATE (từ các state đang chạy — theo trigger)

> ESCALATE chỉ xuất phát từ các state đang chạy của G1 (RECEIVED / DECOMPOSED / DISPATCHED / SYNTHESIZED / IMPLEMENTING) — không escalate từ COUNCIL_DONE / VERIFIED / HANDED_OFF. Trigger gắn state cụ thể:

1. Hypotheses của TL **không thể decompose** (RECEIVED). [SRC dòng 195]
2. Sub-agents trả kết quả **mâu thuẫn không giải thích được** sau điều tra (DISPATCHED). [SRC dòng 195 + §5.3]
3. Spec **mâu thuẫn / không thể implement đúng spec** — BELI escalate qua SIVIL, SIVIL không tự gỡ được (IMPLEMENTING). [SRC dòng 218]
4. [EXT] Kết quả rỗng sau 2 vòng re-dispatch (SYNTHESIZED — §10.3); workload vượt trần loại task, dấu hiệu tier sai (RECEIVED/DECOMPOSED — §10.4); ≥ 50% SA trong batch fail/timeout do lỗi hạ tầng (DISPATCHED — stop S1 §10.2).

> **mission_change (§10.5) KHÔNG thuộc tập ESCALATE:** đó là LỆNH TỪ KING — KING chủ động đổi mission (M1 ⇄ M2) giữa chừng, không phải G1 tự escalate lên KING. G1 xử lý ngay tại state hiện tại theo §10.5 (hủy plan / hoàn tất batch / đánh dấu `mission-changed`), không chuyển sang ESCALATED.

> **ESCALATED không phải state chết:** council ③ (khi G1 ESCALATE) diễn ra tại đây — KING ↔ SIVIL thảo luận, ghi KB nếu có insight, rồi KING quyết hướng đi. [SRC dòng 1759]

### 9.4 [EXT] Invariant (điều kiện luôn đúng mọi state)

| # | Invariant | Nguồn gốc |
|---|---|---|
| I1 | SIVIL chưa từng commit/fix code | KHÔNG BAO GIỜ tự code (JD) |
| I2 | BELI chưa từng tự đổi approach | KHÔNG BAO GIỜ tự đổi approach (JD) |
| I3 | Không có spec nào đến tay BELI trước khi COUNCIL_DONE | council ② là cổng bắt buộc trước khi BELI code |
| I4 | Mọi finding M2 trong worklog đều có evidence | "không evidence = không ghi report" |
| I5 | Mọi thay đổi M2 nằm trong Workspace — Live System read-only | quy tắc vàng M2 |
| I6 | Tổng SA đã spawn ≤ trần theo loại task (≤ 300) | bảng §5.1 |
| I7 | Mọi KB entry SIVIL ghi đều qua SEARCH → FORMAT → WRITE | KB Write Protocol |

---

## §10. [EXT] ERROR & EDGE CASES

**[TB-03 §10 ← thiết kế mới mở rộng — [EXT], nhất quán với ESCALATE của Instructions]**

### 10.1 Spec mâu thuẫn / không implement được

| Triệu chứng | Xử lý | Ai quyết |
|---|---|---|
| 2 spec trong K đòi cùng 1 output khác nhau | SIVIL rà SYNTHESIZE log → spec nào đúng intent top-K → giữ 1, hủy 1, ghi worklog | SIVIL (nội bộ G1) |
| Spec mâu thuẫn với ràng buộc hệ thống (M2) | BELI escalate QUA SIVIL kèm evidence file:line → SIVIL đổi spec → tái verify | SIVIL; nếu đổi hypothesis → council ③ + KING |
| BELI KHÔNG THỂ implement đúng spec (thiếu tool/quyền) | ESCALATED → KING (phân bổ lại resource/đổi approach) | KING |

### 10.2 SA timeout / fail

- SA đơn lẻ fail → retry ≤ 2 (context y nguyên) → đánh dấu ❌, batch tiếp tục (stop condition S5 §5.4).
- ≥ 50% batch fail → stop condition S1 → kiểm tra hạ tầng → nếu lỗi hạ tầng (model stack down, tool lỗi) → **ESCALATED** với báo cáo kỹ thuật (ngoài tầm sửa của SIVIL).
- [EXT] SA "treo" (không trả kết quả đúng hạn nội bộ) → timeout kills SA, không chờ vô hạn — pipeline G1 không block vì 1 SA.

### 10.3 Kết quả rỗng / SYNTHESIZE cho K = 0

- Vòng 1: re-dispatch với spec điều chỉnh (nới scope, đổi khía cạnh, tăng N trong khoảng cho phép).
- Vòng 2 vẫn rỗng → **ESCALATED**: trình KING bằng "negative result có chứng cứ" (đã thử gì, evidence rỗng ở đâu) — negative result vẫn là kết quả nghiên cứu hợp lệ → council quyết: đổi hypothesis / hạ scope / đóng task.
- [EXT] Nếu negative result có giá trị phương pháp → ghi KB Research Insights (vd: "approach X không work với data đặc trưng Y vì Z").

### 10.4 Workload vượt giới hạn batch

- N cần > trần loại task (vd EDA cần 40 SA — vượt 5–10) → dấu hiệu task bị phân loại tier sai → **ESCALATED** đề xuất KING nâng tier/DECOMPOSE lại ở cấp TL (chứ không tự vượt trần).
- N hợp lệ nhưng > 25 concurrent → chia batch con theo §5.4 (không cần escalate — thao tác nội bộ).

### 10.5 Mission đổi giữa chừng (M1 ⇄ M2)

- KING gửi `mission_change` giữa khi G1 đang ở state bất kỳ:
  - **RECEIVED/DECOMPOSED** → hủy plan, decompose lại theo trục mới (approach ⇄ Module Map).
  - **DISPATCHED/SYNTHESIZED** → cho batch đang chạy hoàn tất (SA độc lập, kết quả vẫn dùng được làm evidence) → SYNTHESIZE theo schema mission MỚI.
  - **COUNCIL_DONE/IMPLEMENTING** → dừng giao spec mới; specs đang code đến cùng; VERIFY theo spec cũ nhưng G1 Output đánh dấu `mission-changed` cho KING re-route.
- [EXT] Bắt buộc: mốc chuyển mission + lý do ghi vào worklog (đối soát RWV loop TB-09); mọi KB entry ghi trước đó vẫn giữ Mission = mission CŨ (giá trị tri thức không đổi).

### 10.6 [EXT] Edge case biên G1

| Case | Hành vi chuẩn |
|---|---|
| SIVIL muốn sửa 1 dòng code "nhẹ" của BELI | **TỪ CHỐI** — ghi issue, LISMA sẽ fix (ranh giới cứng §3) |
| KING không phản hồi council ② trong deadline nội bộ | SIVIL KHÔNG tự code — giữ state COUNCIL_DONE, gửi reminder + escalate timeout (chờ là chọn đúng hơn làm sai) |
| M2: Workspace chưa được user mở | POC tạm "POC sketch" trong report (không chạy thử) + đánh dấu `blocked: no-workspace` (≙ cờ `POC-NEEDS-WORKSPACE` — quy ước toàn tập, TB-02 §6) cho KING xin workspace (§7.1) |

---

## §11. ACCEPTANCE CRITERIA — CHECKLIST VERIFY TB-03

**[TB-03 §11 ← chuẩn TB-00 §4 [EXT] — checklist review file này]**

- [ ] **AC1.** §1 JD + Instructions SIVIL đủ 7 trách nhiệm (gồm RESEARCH COUNCIL + KNOWLEDGE CAPTURE) + deliverables "+ KB entries mới"; Instructions đủ 6 nhóm: LUÔN (4 mục) / KHÔNG BAO GIỜ (3 mục) / Input-Output contract / ESCALATE / Signature move (5–300 sub-agents).
- [ ] **AC2.** §2 JD + Instructions BELI đủ 4 trách nhiệm + 6 nhóm instructions; rule M2 "KHÔNG đụng Live System — POC chỉ trong Workspace" hiện diện ở JD, Instructions, §2.3 và ≥ 1 invariant.
- [ ] **AC3.** §3 trích nguyên văn đoạn "tách biệt đến từ JD, không phải model" + diagram G1 nguồn; giải thích tách vai theo ROLE rõ ≥ 3 khía cạnh.
- [ ] **AC4.** §4 đủ 6 bước đúng thứ tự DECOMPOSE → DISPATCH → SYNTHESIZE → SYNC → IMPLEMENT → VERIFY (nguồn dòng 605–662); mỗi bước đủ 5 phần: mục đích / input / thao tác / output / điều kiện sang bước kế; §4.2 đủ 3 chiến lược dispatch (hybrid recommended) đúng ưu/nhược nguồn.
- [ ] **AC5.** §4.4 council ②: challenge hypotheses + đối chiếu KB + ghi KB ngay (KB Write Protocol) + council summary vào worklog; nêu rõ cổng bắt buộc trước khi BELI code.
- [ ] **AC6.** §5.1 giữ nguyên bảng số sub-agents 5–300 theo loại task, KỂ CẢ dòng "System Audit M2 (1 module map) | 5-15".
- [ ] **AC7.** §5.3 protocol mâu thuẫn SA: điều tra bắt buộc → vẫn mâu thuẫn → ESCALATE KING với 2 interpretation; §5.4 có ≥ 3 stop conditions + giới hạn batch (kích thước batch, retry, trần 300).
- [ ] **AC8.** §6 Module Map đủ 8 dòng module (Memory → Config & Deployment) + quy tắc đọc/không-được-phép M2 + ví dụ decompose 13 SAs / 4 branch cấu trúc nguyên bản.
- [ ] **AC9.** §6.3 Findings Schema đúng 5 cột (# / Finding / Evidence / Severity / Cơ hội cải thiện) + quy tắc "không evidence = không ghi vào report".
- [ ] **AC10.** §7 bảng input (từ KING: task.md + Artifact Map; từ Group trước) / output (cho LISMA: code/report + worklog + issues; cho KING: KB entries + council summary) + SPEC template đủ trường: id, nhiệm vụ, acceptance, files dự kiến, ràng buộc, deadline nội bộ (+ priority/approach/expected output theo ví dụ nguồn).
- [ ] **AC11.** §8 feedback loop 3 nhánh (a/b/c) + quy tắc BELI không tự đổi approach + tái council khi đổi hypothesis đã chốt.
- [ ] **AC12.** §9 state machine đủ 8 state chính + ESCALATED: diagram + bảng transition + guard conditions; ≥ 5 invariant.
- [ ] **AC13.** §10 đủ 5 nhóm error (spec mâu thuẫn, SA timeout/fail, kết quả rỗng, workload vượt batch, mission đổi giữa chừng); mọi section chính có `[TB-03 §n ← nguồn dòng a–b]` + dấu [SRC]/[EXT]/[Q] đúng quy ước TB-00 §5; không [EXT] nào mâu thuẫn nguồn, mọi điểm mơ hồ nằm trong §12.

---

## §12. OPEN QUESTIONS

**[TB-03 §12 ← chuẩn TB-00 §4 [Q]]**

| # | Câu hỏi | Phạm vi ảnh hưởng | Đề xuất mặc định (nếu user không chốt) |
|---|---|---|---|
| Q1 | Số SA tối đa chạy đồng thời (§5.4 đặt 10–25) — hạ tầng agent framework thật giữ được bao nhiêu SA concurrent? | Perf + chi phí | Bắt đầu 10, đo rồi nâng; mỗi lần điều chỉnh ghi worklog |
| Q2 | Timeout chuẩn cho 1 SA là bao lâu (theo loại task EDA vs Grand vs System Audit)? | Stop condition S5 | Default 15 phút/SA hoặc theo tier plan (TB-02 chốt sau) |
| Q3 | Council ②: KING "xác nhận specs" bằng hành vi cụ thể nào (reply message? ack trong worklog? gate tự động trong runtime)? | Cổng COUNCIL_DONE | Ack bằng 1 dòng confirm trong worklog của KING — đơn giản, đối soát được |
| Q4 | Trong IMPLEMENT M2, BELI có được chạy thử POC trên dữ liệu thật của Live System (read-only query vào Qdrant/Neo4j) hay chỉ dữ liệu clone trong Workspace? | Ranh giới Live/Workspace (§2.3) | Read-only query được phép (evidence thu thập); ghi rõ trong ràng buộc spec |
| Q5 | Deadline nội bộ của spec tính bằng giờ hay theo tier deadline của TL (mối quan hệ budget G1 ↔ tier TB-02)? | SPEC template §7.3 | % deadline tier: G1 hết 40% quỹ thời gian task (điều chỉnh khi viết TB-02/TB-06) |
| Q6 | Feedback loop giới hạn "≥ 2 lần điều chỉnh spec → escalate council ③" (§8) — ngưỡng 2 có hợp lý cho Grand Competition (task M1 COMPLEX quy mô lớn — nhiều vòng tự nhiên hơn)? | Vòng feedback | Giữ 2 cho MEDIUM/COMPLEX thông thường; task Grand Competition cho 3 — chốt cùng TB-02 |
| Q7 | K specs cho BELI: VERIFIED yêu cầu verify lần lượt từng spec rồi giao, hay verify tất cả rồi giao 1 package? | Transition IMPLEMENTING → VERIFIED | Verify tất cả rồi handoff 1 package (đúng nguồn dòng 338–340 "SIVIL tổng hợp → giao G2") |

---

## 📎 PHỤ LỤC A — TRACEABILITY MATRIX

**[TB-03 Phụ lục A ← chuẩn TB-00 §5]**

| Section nguồn (ai-team-workflow.md) | Dòng | Section blueprint TB-03 | Mức |
|---|---|---|---|
| ⚙️ CHI TIẾT G1 — JD SIVIL | 172–187 | §1.1 | [SRC] |
| 📜 INSTRUCTIONS — SIVIL | 189–196 | §1.2 | [SRC] |
| (mở rộng runtime SIVIL) | — | §1.3, §1.4 | [EXT] |
| 📋 JD — BELI | 198–210 | §2.1 | [SRC] |
| 📜 INSTRUCTIONS — BELI | 212–219 | §2.2 | [SRC] |
| (phân quyền Live/Workspace + runtime BELI) | — | §2.3, §2.4 | [EXT] |
| Nguyên tắc cốt lõi "SIVIL điều phối, BELI thực thi" + diagram | 221–247 | §3.1 [SRC+EXT] | [SRC]/[EXT] |
| Quy trình 5 bước — Bước 1 nhận task | 249–262 | §4.1 | [SRC] |
| Bước 2 dispatch + kết quả SAs | 264–277 | §4.2 (thao tác + ví dụ) | [SRC] |
| Bước 3 tổng hợp + specs cho BELI | 279–311 | §4.3 | [SRC] |
| Bước 4 BELI code theo spec | 313–327 | §4.5 | [SRC] |
| Bước 5 SIVIL review | 329–341 | §4.6 | [SRC] |
| Cơ chế sub-agents (định nghĩa SA) | 343–348 | §5.1 đầu | [SRC] |
| Bảng số sub-agents theo loại task | 350–361 | §5.1 | [SRC] |
| 3 giai đoạn DECOMPOSE→DISPATCH→SYNTHESIZE (diagram) | 362–402 | §4.0–§4.3 (tham chiếu) | [SRC] |
| Ví dụ Decompose House Prices (35 SAs / 4 branch) | 404–453 | §5.5 (rút gọn) | [SRC] |
| 3 chiến lược DISPATCH | 455–483 | §4.2 (bảng chiến lược) | [SRC] |
| Ví dụ Synthesize (bảng 35 SA + top 3) | 485–541 | §4.3 (tham chiếu) | [SRC] |
| 🖥️ Mode M2 — Module Map + 8 module | 543–559 | §6.1 | [SRC] |
| Ví dụ Decompose M2 — 13 SAs / 4 branch | 561–591 | §6.2 | [SRC] |
| Findings Schema + quy tắc evidence | 593–601 | §6.3 | [SRC] |
| Schema tổng hợp G1 Internal Workflow 6 bước (diagram) | 603–662 | §4.0 (rút gọn) | [SRC] |
| Tóm tắt cơ chế G1 (bảng 8 dòng) | 664–676 | §3.1, §4, §5, §6, §8 (rải theo chủ đề) | [SRC] |
| 📚 KNOWLEDGE CAPTURE — quyền ghi SIVIL/BELI | 1736–1746 | §1.1 (trách nhiệm 6–7), §2.4 | [SRC] |
| RESEARCH COUNCIL (4 thời điểm + nội dung) | 1748–1771 | §4.4 | [SRC] |
| KB Write Protocol 4 bước | 1774–1789 | §4.4 (thao tác 3) | [SRC] |
| KB Entry Schema + Research Insights | 1791–1815 | §4.4, §5.3, §6.3 | [SRC] |
| Quy tắc vàng Knowledge Capture (evidence...) | 1817–1824 | §6.3, §9.4 (I4) | [SRC] |
| (thiết kế mới: interface contract, SPEC template, state machine, stop conditions, error handling, AC) | — | §7, §9, §10, §11 | [EXT] |
| (câu hỏi mở) | — | §12 | [Q] |

**Đối soát rải rác [SRC]:** header nguồn dòng 3–15 (Dual Mission, Live/Workspace, KB ngay) → phản chiếu trong §0, §2.3, §4.4, §9.4; quy ước ID dòng-level TB-00 §1.4 áp toàn file (T-*, SA-*, F-*, KB-*).

