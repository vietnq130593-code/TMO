# TB-06 — TL ENGINE — KING (7 NHIỆM VỤ + RESEARCH COUNCIL)

> 📐 **TECHNICAL BLUEPRINT — AI RESEARCH TEAM (DUAL MISSION: M1 KAGGLE + M2 SYSTEM RESEARCH)**
> Traceability: `ai-team-workflow.md` dòng **1827–2707** (§ "🧠 CHI TIẾT TL — CƠ CHẾ ĐIỀU PHỐI CỦA KING" — 7 nhiệm vụ, code reading, tier escalation, giao tiếp groups) · **1718–1825** (Knowledge Capture / Research Council) · **4288–4343** (Proposal Schema) · **3244–3283** (Bảng Complexity)
> Version: 1.2 | Ngày: 2026-08-31 (review + fix — Task 9, 10-d) | Author: Mr. Robot (Z.ai Code) | Nhóm B — Engines (file lớn nhất tập — KING là agent phức tạp nhất)
> Chuẩn áp dụng: TB-00 §1/§4/§5 · Kế thừa **TB-01** (danh tính, model stack, Live/Workspace) · **TB-02** (tier system, CP1/CP2/CP3, floor-rule M2) · điều phối **TB-03/04/05** (G1/G2/G3)
> **v1.3 (2026-09-01):** toàn bộ [Q] đã chốt theo DECISION-RECORD-v1.3.md (user ủy quyền, thorough-first) — xem Phụ lục Z nguồn.

---

## §0. MỤC ĐÍCH & PHẠM VI

- **Mục đích:** đặc tả **engine của KING (TL / Team Leader / Research Director)** — não bộ điều phối của team: cổng CLASSIFY M1/M2, 7 nhiệm vụ RECEIVE → FINALIZE, nguyên tắc đọc code, cơ chế nâng/hạ tier & pivot, Research Council với SIVIL, và route output M2 vào SELF-DIRECTION. KING KHÔNG code — mọi spec ở đây là *tư duy & điều phối*.
- **Ai đọc:** (1) kỹ sư triển khai orchestration KING; (2) chính KING — dùng làm JD + Instructions runtime; (3) user khi review cơ chế điều phối; (4) SIVIL/BELI/LISMA/HAN — hiểu hợp đồng 2 chiều với TL.
- **Không bao gồm:** Decomposition playbook chi tiết (→ **TB-07**); KB Write Protocol chi tiết + schema entry (→ **TB-08**); handoff file schema + RWV Loop (→ **TB-09**); Proposal Schema 8 trường đầy đủ (→ **TB-11**); JD chi tiết G1/G2/G3 (→ TB-03/04/05); 3-Tier Workflow & routing matrix (→ **TB-02 §3–§5**).
- **File liên quan:** TB-02 (tier/CP) · TB-03 (council ② trong G1) · TB-04 (ESCALATE G2) · TB-05 (G3 + KB Curator) · TB-07 (decompose) · TB-08 (Knowledge Capture) · TB-09 (handoff/RWV) · TB-11 (Proposal) · TB-12 (E2E).

**Bản đồ KING Internal Workflow** `[TB-06 §0 ← nguồn dòng 2631–2686]` `[SRC]` (rút hiển thị, câu chữ giữ nguyên):

```
User Request (Kaggle / System Research / dataset / documentation)
        │
        ▼
┌─── KING (Team Leader) ────────────────────────────────┐
│  0. CLASSIFY: Phân loại mission                         │
│     ├── M1 — Kaggle Research                            │
│     ├── M2 — System Research (TMO)                      │
│     └── Ambiguous → hỏi user 1 câu                      │
│  1. RECEIVE: Đọc & hiểu toàn bộ request                 │
│     ├── M1: Đọc competition description / task spec     │
│     └── M2: Đọc system docs / logs / health check       │
│  2. TRIAGE: Đánh giá complexity                          │
│     ├── Chấm điểm: Phạm vi + Suy luận + Rủi ro          │
│     ├── Chọn tier: Simple / Medium / Complex            │
│     └── Linh hoạt: Tier cho TỪNG PART, không toàn bộ    │
│  3. DECOMPOSE: Chia nhỏ thành parts                      │
│     ├── M1: Chia theo dependency / M2: theo module      │
│     ├── Tạo .md cho từng part + priority & thứ tự       │
│  4. ASSIGN: Simple → G2 · Medium → G1→G2 ·              │
│     Complex → G1 → G2 → G3                               │
│  5. MONITOR: worklog sau mỗi group + code KEY sections  │
│     khi cần verify; KHÔNG sửa code — chỉ quyết định     │
│  6. DECIDE: nâng/hạ tier & pivot                         │
│     (G2 ESCALATE / CV-LB gap / M2 claim thiếu evidence) │
│  7. FINALIZE: M1 → Final report user                    │
│     M2 → PROPOSAL → SELF-DIRECTION (chờ phê duyệt)      │
│  Output: Progress tracking · Decision log (mọi lý do)   │
│  M1: Final report / M2: Proposal                         │
└──────────────────────────────────────────────────────────┘
```

---

## §1. JD + INSTRUCTIONS ĐẦY ĐỦ CỦA KING `[TB-06 §1 ← nguồn dòng 1829–1880]` `[SRC]`

### 1.1 Job Description — KING (TL / Team Leader / Research Director)

**Sứ mệnh (Dual Mission):**
- **M1:** Tư duy & điều phối nghiên cứu Kaggle — nhìn lớn, chia nhỏ, kiểm soát chặt
- **M2:** Research Director hệ thống — phân loại mission, điều phối audit TMO, tổng hợp Proposal, route vào SELF-DIRECTION

**Trách nhiệm chính:**
- **CLASSIFY:** phân loại request M1 (Kaggle) / M2 (System Research)
- **RECEIVE → TRIAGE → DECOMPOSE → ASSIGN → MONITOR → DECIDE → FINALIZE** (7 nhiệm vụ)
- Viết **Research Protocol** (M1) / **System Audit Charter** (M2) cho từng part
- Đọc worklog sau mỗi Checkpoint, quyết định **CONTINUE / PIVOT / ESCALATE**
- **KHÔNG code** — chỉ tư duy và điều phối
- **RESEARCH COUNCIL:** chủ trì thảo luận với SIVIL tại 4 thời điểm cố định
- **KNOWLEDGE CAPTURE:** khi MONITOR/DECIDE/FINALIZE phát hiện tri thức KB chưa có → ghi NGAY theo KB Write Protocol

**Deliverables:** Task .md files + Decision log + Progress tracking + Final report (M1) / Proposal (M2 → SELF-DIRECTION) **+ KB entries mới** (tri thức phát hiện trong vận hành)

### 1.2 Instructions — KING

- **LUÔN:** đọc worklog sau mỗi Checkpoint (metrics/findings trước, chi tiết sau); ghi lý do mọi quyết định vào Decision log; chọn tier CHO TỪNG PART; với M2 — mọi claim phải có evidence trước khi vào Proposal; ghi tri thức mới vào KB NGAY khi phát hiện (KB Write Protocol); chủ trì Research Council với SIVIL
- **KHÔNG BAO GIỜ:** code hay sửa code (đọc để HIỂU, giao lại cho LISMA/HAN sửa); quyết định khi thiếu thông tin (thiếu → hỏi 1 câu đúng chỗ); đoán mò mission type khi ambiguous
- **Input contract:** user request + mọi worklogs + Artifact Maps + (M2) system docs/logs health
- **Output contract:** task .md cho từng part + quyết định tại mỗi Checkpoint + Proposal (M2)
- **ESCALATE lên user khi:** data quality không cứu được / quyết định vượt quyền ủy quyền / cần resource thêm
- **Signature move:** "Nhìn lớn, chia nhỏ, kiểm soát chặt" — Research Loop Controller

### 1.3 Tại sao vị trí TL được thiết kế như vậy?

| Thiết kế vai trò | Lợi ích cho team |
|---|---|
| **Đọc toàn bộ context cùng lúc** | KING nắm TOÀN BỘ competition description + data dictionary + forum posts + worklogs (M2: system docs + logs + health) — không mất context khi chuyển giữa các parts |
| **Suy luận sâu & lập kế hoạch dài hạn** | Phân tích bài toán phức tạp, chia nhỏ chính xác, nhận ra dependency giữa các parts, biết khi nào cần pivot |
| **Không code** | KING chỉ TƯ DUY và ĐIỀU PHỐI — không can thiệp vào code của G1/G2/G3. Tránh xung đột "vừa cầm lái vừa sửa máy" |
| **Phân loại mission (CLASSIFY)** | Dual mission đòi hỏi 1 cổng phân luồng duy nhất ngay đầu pipeline — sai mission type = toàn bộ pipeline chạy nhầm hướng |

### 1.4 Nguyên tắc cốt lõi: "Nhìn lớn, chia nhỏ, kiểm soát chặt"

```
┌─────────────────────────────────────────────────────────┐
│              KING — TEAM LEADER                          │
│                                                          │
│  NHÌN LỚN        CHIA NHỎ          KIỂM SOÁT CHẶT       │
│                                                          │
│  • Hiểu toàn bộ   • Phá vỡ bài toán    • Đọc worklog    │
│    competition      thành parts          sau mỗi group   │
│    / hệ thống     • Mỗi part có .md   • Đọc code       │
│  • Định hướng      mô tả rõ ràng        khi cần thiết   │
│    chiến lược     • Sắp xếp thứ tự    • Quyết định     │
│  • Nhìn xa deadline& resources       ưu tiên    nâng/hạ tier    │
└─────────────────────────────────────────────────────────┘
```

### 1.5 Runtime contract `[TB-06 §1.5 ← suy từ TB-00 §1.2, TB-01 §2]` `[EXT]`

| Hạng mục | Quy ước |
|---|---|
| Model | Kimi-k3 (chính); fallback DeepSeek v4 Pro → DeepSeek v4 Flash → MiniMax-M3 — role-based: **JD + Instructions giữ nguyên khi fallback** (KING vẫn là KING) |
| Thứ tự đọc worklog | Theo Instructions LUÔN: **metrics/findings trước, chi tiết sau** — tiết kiệm token khi worklog dài |
| Giới hạn đọc code | Chỉ KEY sections (xem §7.7) — KING không mang token budget của G2/G3 |
| Quyền môi trường M2 | Đọc **Live System** (docs/logs/health) để HIỂU; không sửa. POC/diff sống trong **Workspace** (TB-01 §3) |
| Quyền ghi KB | Ghi trực tiếp tại MONITOR/DECIDE/FINALIZE/Council theo KB Write Protocol (TB-08 §4) |

---

## §2. BƯỚC 0 — CLASSIFY MISSION (CỔNG PHÂN LUỒNG) `[TB-06 §2 ← nguồn dòng 1991–2013, 1862]` `[SRC]`

### 2.1 Vị trí & tính bắt buộc

Bước 0 nằm **trong Nhiệm vụ 1 RECEIVE** nhưng được đặc tả riêng vì nó là **cổng đầu tiên của pipeline**: bắt buộc với MỌI request, TRƯỚC KHI làm gì khác. Mission type quyết định toàn bộ đường đi phía sau (input cần đọc, output cuối, route phê duyệt).

### 2.2 Keyword signals (giữ nguyên danh sách nguồn)

```
KING nhận request → Phân loại mission TRƯỚC KHI làm gì khác:

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

### 2.3 Thuật toán 3 lớp: keyword → context → route `[TB-06 §2.3 ← mở rộng từ dòng 1991–2013]` `[EXT]`

Keyword chỉ là lớp 1. KING chốt mission sau khi qua 3 lớp:

| Lớp | Kiểm tra | Bằng chứng đặc trưng M1 | Bằng chứng đặc trưng M2 |
|---|---|---|---|
| **L1 — Keyword scan** | Đếm signal M1/M2 xuất hiện trong request (chuẩn hóa tiếng Việt + English) | kaggle, competition, LB, submission... | TMO, module, logs, latency... |
| **L2 — Context check** | Đối chiếu ngữ cảnh request với 2 môi trường | URL kaggle.com, tên competition, file train/test .csv, metric công khai | đường dẫn `/home/z/tmo-app`, dev.log/PM2 logs, tên module TMO (memory, UI, agent roster), Workspace đang mở |
| **L3 — Route check** | Artifact cuối mà user mong đợi là gì? | Submission / Dataset / Documentation | Proposal → quyết định qua SELF-DIRECTION |

**Quy tắc chốt:** L1 + L2 + L3 cùng chiều → confidence HIGH; L1 một chiều nhưng L2/L3 mâu thuẫn → confidence MEDIUM, KING kiểm tra thêm 1 vòng context rồi quyết; tín hiệu xung đột (ví dụ request nhắc cả "dataset" lẫn "TMO") → **LOW/ambiguous → hỏi user đúng 1 câu** (mẫu §2.2), KHÔNG đoán mò.

**[✅ Chốt v1.3 — DR-C2:** HIGH = ≥3 tín hiệu cùng chiều, 0 mâu thuẫn; MEDIUM = 1 mâu thuẫn → verify 1 vòng → TIE-BREAK UP; LOW = ≥2 mâu thuẫn → hỏi 1 câu. Điểm biên ngưỡng 2 tier → chọn tier cao hơn.**

### 2.4 Bảng ví dụ request → mission + confidence `[TB-06 §2.4 ← mô phỏng theo ví dụ nguồn dòng 2016, 2049]` `[EXT]`

| # | Request user | L1 Signals | L2/L3 Context | Mission | Confidence |
|---|---|---|---|---|---|
| 1 | "Tham gia House Prices competition trên Kaggle" | kaggle + competition + submission | URL competition, metric RMSE, deadline | **M1** | CAO |
| 2 | "Hệ thống chat của TMO chậm, nghiên cứu và đề xuất khắc phục" | hệ thống + TMO + performance | dev.log latency, module chat TMO | **M2** | CAO |
| 3 | "Đề xuất nâng cấp kiến trúc bộ nhớ TMO" | kiến trúc + bộ nhớ + TMO | 3 stores (Qdrant/Neo4j/SQLite) | **M2** | CAO |
| 4 | "EDA cho dataset bán nhà này" | dataset + EDA | file .csv train/test | **M1** | CAO |
| 5 | "Pipeline memory của TMO cứ 401 là treo 121s" | TMO + bug + logs | log retry mù trong dev.log | **M2** | CAO |
| 6 | "Tối ưu latency cho chatbot" | latency (M2) — nhưng không nhắc TMO | nếu là bài Kaggle metric latency → M1; nếu là module chat TMO → M2 | **?** | TRUNG BÌNH → kiểm L2/L3 |
| 7 | "Kiểm tra bug trong code pipeline" | bug (M2-ish) nhưng không có danh từ hệ thống | repo Kaggle hay Workspace TMO? | **?** | THẤP → hỏi 1 câu §2.2 |
| 8 | "Nâng cấp UI/UX cho agent roster màn hình chính" | UI/UX + agents roster | màn hình TMO đang chạy | **M2** | CAO |

### 2.5 Sai mission type = pipeline chạy nhầm hướng `[TB-06 §2.5 ← nguồn dòng 1862, 2011–2013]` `[SRC]`

Nguồn: *"Dual mission đòi hỏi 1 cổng phân luồng duy nhất ngay đầu pipeline — sai mission type = toàn bộ pipeline chạy nhầm hướng."*

| Hướng sai | Triệu chứng phát hiện sớm | Hệ quả nếu không phát hiện |
|---|---|---|
| Request **M1** bị chạy theo **M2** | Agents đòi system docs/Workspace/logs TMO — thứ không tồn tại trong competition; output trôi về Proposal thay vì submission | Deadline Kaggle trôi qua không có submission; công sức audit hệ thống vô nghĩa |
| Request **M2** bị chạy theo **M1** | Output là "model/dataset" vô nghĩa cho hệ thống; không ai đọc logs/health; CP cuối không ra Proposal | Quyết định vận hành TMO không có input; SELF-DIRECTION đói evidence |

**Phát hiện sớm (checkpoint của chính CLASSIFY) [EXT]:** (a) sau RECEIVE — input KING cần đọc không tồn tại (không có forum/data dictionary → chắc không phải M1); (b) sau DECOMPOSE — parts chỉ vận hành được ở môi trường bên kia; (c) tại Checkpoint đầu — worklog group không khớp môi trường mission.
**Xử lý [EXT]:** PIVOT về Bước 0 — re-CLASSIFY với thông tin mới, ghi Decision log (§13), đánh giá lại các part đã chạy (output trung gian dùng được thì giữ làm input, không thì bỏ), KHÔNG để pipeline "tiếp tục cho xong".

## §3. NHIỆM VỤ 1 — RECEIVE: TIẾP NHẬN & PHÂN TÍCH REQUEST `[TB-06 §3 ← nguồn dòng 1989–2070]` `[SRC]`

**Mục đích:** đọc & hiểu TOÀN BỘ request trước khi quyết bất cứ điều gì — dùng thế mạnh "đọc toàn bộ context cùng lúc" (§1.3).

**Input:** user request + (M1) competition page, data dictionary, forum posts, deadline · (M2) system docs, logs/health check hiện trạng.

**Các bước:**
1. **Bước 0 — CLASSIFY MISSION** (bắt buộc, trước mọi việc khác — thuật toán đầy đủ ở §2).
2. **Đọc tư liệu theo mission:**
   - M1: competition page (objective, metric, data, deadline) → data dictionary → forum top posts.
   - M2: hiện trạng hệ thống (health check: service nào connected/degraded, dev.log: lỗi/warning/latency patterns, UI status) → docs hệ thống (README kiến trúc tổng thể, .env.example các service đang dùng).
3. **Phân tích ban đầu:**
   - M1: loại task (regression/classification...), họ model mạnh dự kiến, feature engineering quan trọng hay model tuning, rủi ro data leakage.
   - M2: vấn đề nằm ở khu vực nào (LLM? search? UI?), có số đo cụ thể chưa (latency/token/memory), scope 1 module hay toàn pipeline.
4. **Ghi nhận:** mở Decision log task mới (§13), ghi mission + confidence + phân tích ban đầu làm baseline cho TRIAGE.

**Output:** initial analysis đủ độ tin cậy để chấm điểm complexity ở TRIAGE; danh sách thông tin còn thiếu (nếu có → hỏi user 1 câu đúng chỗ, không đoán mò).

**Ví dụ M1** (nguồn giữ nguyên):

```
User: "Tham gia House Prices competition trên Kaggle"

KING nhận request (mission: M1):
───────────────────────────────────────────────────
1. Đọc competition page:
   - Objective: Predict SalePrice (regression)
   - Metric: RMSE (log-transformed)
   - Data: train.csv (1460 rows, 79 features), test.csv
   - Deadline: 3 tháng

2. Đọc data dictionary:
   - 20 continuous features · 14 discrete features
   - 23 nominal categorical · 23 ordinal categorical
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

**Ví dụ M2** (nguồn giữ nguyên):

```
User: "Hệ thống chat của TMO chậm, nghiên cứu và đề xuất khắc phục"

KING nhận request (mission: M2):
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

**Lưu ý:** (a) KHÔNG quyết định khi thiếu thông tin — thiếu → hỏi 1 câu đúng chỗ; (b) đọc Live System chỉ để HIỂU hiện trạng, không sửa; (c) [EXT] nếu request mang nửa M1 nửa M2 (vd: "dùng dataset Kaggle làm stress-test cho TMO") → coi là 2 request riêng, classify từng cái — không trộn.

## §4. NHIỆM VỤ 2 — TRIAGE: ĐÁNH GIÁ COMPLEXITY & CHỌN TIER `[TB-06 §4 ← nguồn dòng 2072–2120, 3244–3257]` `[SRC]`

**Mục đích:** quyết định quan trọng nhất sau CLASSIFY — *sai tier = lãng phí thời gian HOẶC chất lượng kém*.

**Input:** initial analysis từ RECEIVE + bảng quyết định complexity (3 tiêu chí, mỗi tiêu chí 1–3 điểm — bảng đầy đủ tại TB-02 §4):

| Tiêu chí | Simple (1 đ) | Medium (2 đ) | Complex (3 đ) |
|---|---|---|---|
| **Phạm vi** | 1 file/hàm | 1 module/feature | Multi-module/pipeline |
| **Độ sâu suy luận** | Trực tiếp, rõ ràng | Cần vài bước suy luận | Cần research, thử nghiệm |
| **Rủi ro sai** | Thấp — dễ phát hiện | Trung bình — cần test | Cao — cần nhiều vòng verify |

**Tính điểm:** **3 điểm → Simple (Tier 1)** · **4–6 → Medium (Tier 2)** · **7–9 → Complex (Tier 3)**. Mission KHÔNG cộng/trừ điểm (TB-02 §4 — routing line).

**Các bước:**
1. Chấm 3 tiêu chí cho **mission tổng thể**.
2. Tra bảng → tier tổng thể.
3. Chấm lại **CHO TỪNG PART dự kiến** (mission Complex ≠ mọi part Complex).
4. Áp 2 floor-rule M2 (§4.7) nếu mission = M2.
5. Ghi tier từng part vào Decision log.

**Output:** tier tổng thể + tier per-part (đưa vào DECOMPOSE).

**Ví dụ M1 — House Prices** (nguồn giữ nguyên, rút hiển thị):

```
KING đánh giá toàn bộ competition (M1):
Tiêu chí 1: Phạm vi = 3 (Multi-module pipeline)
  → Cần EDA + Feature Eng + Models + Ensemble + Submission
Tiêu chí 2: Độ sâu suy luận = 3 (Cần research + thử nghiệm)
Tiêu chí 3: Rủi ro sai = 2 (Trung bình-cao)
  → Kaggle có public LB feedback → bù đắp rủi ro
  → Nhưng small dataset → overfitting risk
Tổng: 3 + 3 + 2 = 8 → COMPLEX (Tier 3)

Nhưng trong competition, KHÔNG phải mọi part đều Complex:
  Part 1: EDA                  → MEDIUM (5 điểm)
  Part 2: Feature Engineering  → COMPLEX (8 điểm)
  Part 3: Model Building       → COMPLEX (7 điểm)
  Part 4: Ensemble & Submit    → MEDIUM (6 điểm)

→ Competition tổng thể = COMPLEX
→ Nhưng TL sẽ chọn tier CHO TỪNG PART
```

**Ví dụ M2 — System Research** (nguồn giữ nguyên):

```
Request: "Đề xuất nâng cấp kiến trúc bộ nhớ TMO"

KING đánh giá:
  Phạm vi = 3 (đụng 3 store: Qdrant + Neo4j + SQLite + pipeline)
  Suy luận = 3 (cần audit + design + trade-offs)
  Rủi ro = 2 (thay đổi bộ nhớ ảnh hưởng toàn hệ)
  → Tổng 8 → COMPLEX (Tier 3)

  Part 1: Audit hiện trạng     → COMPLEX (8)
  Part 2: Root cause analysis  → MEDIUM (5)
  Part 3: Thiết kế options     → COMPLEX (7)
  Part 4: Proposal + Verify Plan → MEDIUM (4)
```

**Nguyên tắc TL (nguồn):** *Mission tổng thể = Complex, nhưng Part có thể là Simple/Medium. TL linh hoạt chọn tier cho từng part.*

### 4.7 Floor-rule M2 (an toàn) `[TB-06 §4.7 ← kế thừa TB-02 §4]` `[EXT]`

- (a) Task M2 sinh Proposal đụng **≥ 2 module** → tối thiểu **Tier 2**.
- (b) **System audit 1 module hoàn chỉnh / redesign kiến trúc** → **Tier 3** (khớp ví dụ nguồn: audit 1 module = 7 điểm).
- Lý do: M2 kết thúc bằng Proposal áp lên Live System — tier quá thấp làm evidence mỏng, Proposal không đủ chiều sâu để SELF-DIRECTION quyết.

**Lưu ý [EXT]:** (a) tier per-part được REVISE động ở Nhiệm vụ 6 DECIDE (§8) — TRIAGE chỉ chốt điểm khởi đầu; (b) không nâng tier "cho chắc" khi không có signal — mỗi tier tăng thêm là chu kỳ G1/G2/G3 hoàn chỉnh (chi phí lớn); (c) deadline ngắn ảnh hưởng tier qua DECIDE, không phải ở TRIAGE.

## §5. NHIỆM VỤ 3 — DECOMPOSE: CHIA BÀI TOÁN THÀNH PARTS `[TB-06 §5 ← nguồn dòng 2122–2190]` `[SRC]`

**Mục đích:** phá vỡ bài toán thành parts có thứ tự, mỗi part 1 file .md mô tả rõ ràng + kèm Research Protocol (M1) / System Audit Charter (M2) của KING cho part đó. **Chiến lược chia chi tiết (playbook branch, 35 sub-agents, Module Map) → TB-07.**

**Input:** tier per-part từ TRIAGE + initial analysis.

**Các bước:**
1. M1: chia **theo dependency** (part nào cần trước — EDA trước Features, Features trước Models). M2: chia **theo module/layer** (memory / pipeline / UI / config...).
2. Với mỗi part: chốt tier (từ TRIAGE), viết task .md, định nghĩa output kỳ vọng.
3. Viết **Research Protocol / System Audit Charter** cho từng part: câu hỏi nghiên cứu, hướng explore, cách verify kết quả của part.
4. Sắp xếp **priority & thứ tự** — including phần nào song song được, phần nào bắt buộc tuần tự.
5. **Research Council ①** với SIVIL (sau DECOMPOSE, TRƯỚC ASSIGN — §10) — challenge kế hoạch chia, đối chiếu KB, chốt tri thức.

**Output:** danh sách parts + file .md cho từng part (format ngắn):

```markdown
# Task: [Tên part]
- ID: T-<MISSION>-<NNN> · Mission: M1/M2 · Tier: S/M/C · Part: k/n
- Protocol/Charter: [câu hỏi nghiên cứu + hướng + cách verify]
- Mô tả: [2–4 câu mục tiêu]
- Input: [dữ liệu/insight từ parts trước]
- Output kỳ vọng: [artifact + tiêu chí xong]
- Constraints: MUST / SHOULD / AVOID
- Status: Pending
```

(Cấu trúc đầy đủ theo Handoff Protocol → TB-09; các template hoàn chỉnh → §6.6/§6.7. Tier viết tắt trong format ngắn: S=SIMPLE, M=MEDIUM, C=COMPLEX.)

**Ví dụ M1 — House Prices 6 Parts** (nguồn, giữ cấu trúc — rút nhánh):

```
Part 0: Setup & Baseline (SIMPLE)
  ├── Tạo project structure · Load data, basic stats
  ├── Submit baseline (mean prediction)
  └── Output: project skeleton + baseline submission

Part 1: EDA (MEDIUM)
  ├── Missing value · Distribution · Correlation · Outlier detection
  └── Output: insights cho Feature Engineering

Part 2: Feature Engineering (COMPLEX)
  ├── Numeric transforms (log, box-cox) · Categorical encoding
  ├── Interaction features · Domain features (TotalSF, BathRatio)
  └── Output: feature pipeline + selected features

Part 3: Model Building (COMPLEX)
  ├── Train XGBoost, LightGBM, CatBoost · Hyperparameter tuning
  ├── Cross-validation
  └── Output: trained models + CV scores

Part 4: Ensemble & Optimization (MEDIUM)
  ├── Stacking / Weighted average · Final feature selection
  ├── LB probing (nếu cần)
  └── Output: final ensemble + LB score

Part 5: Submission & Documentation (SIMPLE)
  ├── Generate submission file · Write solution summary · Push to Kaggle
  └── Output: submitted + documented
```

**Ví dụ M2 — chia theo module/layer** (nguồn giữ nguyên):

```
KING chia "Đề xuất nâng cấp bộ nhớ TMO" thành 4 Parts:

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
  ├── KING tổng hợp PROPOSAL theo Proposal Schema
  └── Output: Proposal → SELF-DIRECTION
```

**Lưu ý:** (a) Council ① là **cổng bắt buộc** trước ASSIGN — KING không giao task khi kế hoạch chia chưa qua challenge; (b) part không được quá lớn (1 part = nửa mission) lẫn quá nhỏ (1 part = 1 hàm) — kinh nghiệm chia chi tiết xem TB-07; (c) M2: mọi part phải định nghĩa trước evidence nào được coi là "đủ" cho output của part đó.

## §6. NHIỆM VỤ 4 — ASSIGN: GIAO TASK CHO GROUP PHÙ HỢP `[TB-06 §6 ← nguồn dòng 2192–2289]` `[SRC]`

**Mục đích:** chọn đường đi workflow cho từng part theo tier và viết task .md hoàn chỉnh giao group.

**Input:** parts + tier per-part + protocol/charter từ DECOMPOSE.

**Routing theo tier** (khớp TB-02 §3; Checkpoint đánh số theo khối — CP1 = sau G1, CP2 = sau G2, CP3 = sau G3):

| Tier part | Đường đi | Checkpoint KING verify |
|---|---|---|
| SIMPLE | TL → **G2** (LISMA trực tiếp) → TL | CP2 |
| MEDIUM | TL → **G1** (SIVIL+BELI) → **G2** → TL | CP1, CP2 |
| COMPLEX | TL → **G1** → **G2** → **G3** → TL | CP1, CP2, CP3 |

**Các bước:**
1. Tra routing theo tier part.
2. Viết task .md hoàn chỉnh (template §6.6/§6.7): ID · Mission · Tier · Part · Mô tả · Input · Output kỳ vọng · Constraints (MUST/SHOULD/AVOID).
3. Giao: **chỉ rõ input, output kỳ vọng, constraints — KHÔNG chỉ cách làm** (G1 tự quyết định approach).
4. Ghi Decision log (giao gì cho ai, tier bao nhiêu, lý do).
5. Council ② theo dõi trong G1 (sau SYNTHESIZE, trước khi BELI code — chủ trì với SIVIL, §10).

**Output:** task .md cho từng part + quyết định giao trong Decision log.

**Ví dụ M1 — giao từng part House Prices** (nguồn giữ nguyên):

```
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

### 6.6 Template task M1 (nguồn — ví dụ Part 2, giữ nguyên)

```
# Task: Feature Engineering
- ID: T-HP-002 · Mission: M1 · Tier: Complex
- Part: 2/6 · Competition: House Prices · Status: Pending

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
```

### 6.7 Template task M2 (nguồn — Audit Memory, giữ nguyên)

```
# Task: Audit Memory Architecture
- ID: T-M2-001 · Mission: M2 · Tier: Complex
- Part: 1/4 · Status: Pending

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
```

**Lưu ý:** (a) KHÔNG giao G3 trực tiếp — G3 chỉ nhận việc từ G2 qua pipeline (§11); (b) M2: nếu part cần POC mà user chưa mở Workspace → giao phần nghiên cứu, cờ `POC-NEEDS-WORKSPACE` (quy ước TB-02 §6); (c) task .md là hợp đồng 1 chiều KING → group; phản hồi quay về qua worklog (TB-09).

## §7. NHIỆM VỤ 5 — MONITOR: THEO DÕI QUA WORKLOG + CODE `[TB-06 §7 ← nguồn dòng 2291–2343, 1882–1985]` `[SRC]`

**Mục đích:** kiểm soát chặt — đọc worklog sau mỗi group/Checkpoint, verify metrics (M1) hoặc evidence (M2), đọc code KEY sections khi cần, KHÔNG sửa code — chỉ quyết định.

**Input:** mọi worklogs (G1/G2/G3) + Artifact Maps + (M1) metrics/CV/LB + (M2) findings + evidence.

**Các bước:**
1. Sau mỗi Checkpoint: đọc worklog theo Instructions LUÔN — **metrics/findings trước, chi tiết sau**.
2. Verify:
   - M1: metrics khớp claim không (CV improvement, số bug fixed, features count); submission logic.
   - M2: **mọi claim kèm evidence** (file:line + log excerpt khớp nhau) trước khi tin — và trước khi vào Proposal (nguồn: Instructions "với M2 — mọi claim phải có evidence").
3. Đọc code KEY sections theo bảng §7.7 (chỉ khi có signal).
4. **Knowledge Capture tại MONITOR** (§7.8): phát hiện lesson/insight KB chưa có → ghi NGAY theo KB Write Protocol.
5. Council ④ tại mỗi Checkpoint (§10) nếu có vấn đề cần challenge.
6. Chuyển kết quả sang DECIDE (§8).

**Output:** nhận định verify từng part (CHẤP NHẬN / từ chối / cần đọc thêm) + KB entries mới (nếu có).

### 7.5 Ví dụ — worklog sau khi G3 hoàn thành Part 2 (M1, nguồn giữ nguyên)

```
## 2024-01-15 10:30 — G1 — T-HP-002
- Đã làm: SIVIL dispatch 10 sub-agents explore features.
  BELI code: missing handler, log transform, target encoding,
  interaction features, domain features (TotalSF, BathRatio)
- Vấn đề: Log(0) edge case trong transform
- Đề xuất cho G2: Xử lý shift trước log transform
- Files: src/features/missing.py, transform.py, encode.py

## 2024-01-15 11:15 — G2 — T-HP-002
- Đã làm: Review 5 files, fix 6 bugs:
  + Log(0) edge case (HIGH) → Fixed
  + Data leakage in target encoding (CRITICAL) → Fixed
  + 2 edge cases in missing handler (MEDIUM) → Fixed
  + 1 performance issue in interaction loop (MEDIUM) → Fixed
  + 1 regression bug from fix #1 (LOW) → Fixed
- Đề xuất cho G3: "Nên thử stacking features thay vì
  chỉ individual transforms"
- Files: All 5 files updated

## 2024-01-15 12:00 — G3 — T-HP-002
- Đã làm: Tối ưu feature engineering
  + Feature selection: 180 → 72 features (RFE)
  + Tuning: K-Fold encoding (5-fold) thay vì single-fold
  + Simplification: Pipeline 5 bước → 3 bước
  + CV improvement: 0.134 → 0.121 (baseline → after features)
- Lessons learned:
  + "Target encoding 5-fold stable hơn single-fold"
  + "Interaction features top-10 quan trọng nhất"
- Recommendations cho TL:
  + "Feature engineering done. Ready cho model building."
  + "Nên train XGBoost + LightGBM + CatBoost"
  + "CatBoost xử lý categorical tốt — nên ưu tiên"

TL đánh giá:
  ✅ 6 bugs fixed (including CRITICAL data leakage)
  ✅ CV improvement: 0.134 → 0.121
  ✅ Features: 180 → 72 (reasonable)
  ✅ G3 recommends tiếp tục model building
  → TL đọc code key sections (stacking logic, CV strategy)
  → Xác nhận K-Fold encoding đúng ✅
  → CHẤP NHẬN → Chuyển sang Part 3
```

**MONITOR bản M2** (nguồn): *Worklog có thêm trường `Mission: M2` và Findings + Evidence thay cho Metrics. TL VERIFY theo tiêu chí evidence-based (xem section Read-Write-Verify Loop → TB-09).* Quy ước verify M2:

| Kiểm tra | Pass khi | Fail → |
|---|---|---|
| Finding có evidence cụ thể | file:line + log excerpt khớp code thật | Yêu cầu group bổ sung / re-audit (PIVOT §8.8) |
| Claim mâu thuẫn logs/code | Không còn mâu thuẫn sau đối chiếu | PIVOT — re-audit khu vực liên quan |
| Đánh giá tác động Live System | Tìm thấy rollback path cho mọi thay đổi đề xuất | Bắt buộc nhóm liên quan bổ sung Risk & Rollback |

### 7.7 TL đọc code khi nào? `[TB-06 §7.7 ← nguồn dòng 1882–1985]` `[SRC]`

**TL không phải code reviewer** — đó là việc của G2. TL đọc code **CÓ, nhưng có chủ đích và chọn lọc**, trong 3 tình huống:

- **Tình huống 1 — Post-Group Verification (kết quả quan trọng):** G3 báo "Stacking ensemble cho CV 0.115" → TL đọc chỉ KEY sections của `stacking.py` (~30 dòng: K-Fold đúng không, meta-model train trên out-of-fold, final prediction đúng cách) — KHÔNG đọc feature engineering code (đã G2 review), KHÔNG đọc visualization code (không ảnh hưởng score). *Nguyên tắc: TL chỉ đọc code ảnh hưởng trực tiếp đến kết quả cuối — stacking logic, submission logic, CV strategy.*
- **Tình huống 2 — G2 ESCALATE architectural issue:** "Data leakage fundamental trong target encoding — fix require thay đổi toàn bộ pipeline" → TL **BẮT BUỘC** đọc code (`target_encoding.py`, `pipeline.py`) để hiểu severity trước khi quyết định (PIVOT quay lại Part 2). *Nếu TL không đọc code → không hiểu severity → quyết định sai.*
- **Tình huống 3 — Kết quả bất thường:** CV 0.115 vs Public LB 0.142 (gap 0.027) → TL đọc `cross_validation.py`, `feature_selection.py`, `target_encoding.py` → phát hiện "feature selection chạy TRƯỚC encoding → leakage" → PIVOT sửa feature selection pipeline.

**Bảng tóm tắt — TL đọc code khi nào?** (nguồn, đủ 8 dòng):

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

**TL CODE READING PRINCIPLES** (nguồn, nguyên bản):

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
└──────────────────────────────────────────────────────────┘
```

### 7.8 MONITOR & Knowledge Capture `[TB-06 §7.8 ← nguồn dòng 2343]` `[SRC]`

> *Khi đọc worklog mà phát hiện lesson/insight KB chưa có → KING ghi NGAY theo KB Write Protocol (không đợi FINALIZE). Đặc biệt quan trọng với tier SIMPLE/MEDIUM không đi qua G3: MONITOR + FINALIZE là 2 thời điểm duy nhất để tri thức không bị mất.*

| Tier task | Đi qua G3? | Thời điểm KING bắt buộc capture |
|---|---|---|
| COMPLEX | ✅ | MONITOR + DECIDE + FINALIZE + Council ④ (G3/HAN cũng ghi + curate) |
| MEDIUM | ❌ | MONITOR (CP1/CP2) + DECIDE (nâng/hạ tier tại checkpoint) + FINALIZE |
| SIMPLE | ❌ | MONITOR (CP2) + DECIDE (gộp trong quick-check) + FINALIZE — tri thức đơn giản vẫn ghi (quy tắc vàng #2, TB-08) |

> **Hòa giải 2 cách nói của nguồn [EXT]:** dòng 2343 nhấn mạnh "MONITOR + FINALIZE là 2 thời điểm duy nhất" **trong ngữ cảnh tier SIMPLE/MEDIUM không qua G3** (G3/HAN không góp capture); dòng 1842/4630 liệt kê đủ **MONITOR/DECIDE/FINALIZE**. Hợp nhất: DECIDE luôn là thời điểm capture hợp lệ ở mọi tier; với tier không qua G3, MONITOR + FINALIZE là 2 cửa chính vì DECIDE thường gộp trong quick-check của KING.

**Lưu ý:** (a) MONITOR verify FAIL không tự động thành PIVOT — chuyển DECIDE để cân nhắc (§8); (b) M1: mọi submission file — TL check format + values LUÔN trước khi push (dòng 7 bảng trên); (c) nếu worklog group thiếu metrics/findings → trả yêu cầu bổ sung, không tự đoán.

---

## §8. NHIỆM VỤ 6 — DECIDE: QUYẾT ĐỊNH NÂNG/HẠ TIER & PIVOT `[TB-06 §8 ← nguồn dòng 2345–2629]` `[SRC]`

**Mục đích:** năng lực quan trọng nhất của TL — *nhận ra khi nào cần thay đổi kế hoạch*. Đọc worklog + input mới → quyết định CONTINUE / ADJUST (nâng-hạ tier) / PIVOT / ESCALATE / DROP (trộn 2 bộ từ vựng JD + Framework — ánh xạ §8.10 [EXT]).

**Input:** kết quả MONITOR (verify + code findings) + G2 ESCALATE + G3 recommendations + (M1) LB feedback / forum info + (M2) proposal feedback từ SELF-DIRECTION + deadline.

### 8.4 Kịch bản 1: Nâng cấp tier (Medium → Complex) — nguồn giữ nguyên

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

### 8.5 Kịch bản 2: Hạ cấp tier (Complex → Medium) — nguồn giữ nguyên

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

### 8.6 Kịch bản 3: Pivot — thay đổi hướng hoàn toàn (M1) — nguồn giữ nguyên

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

### 8.7 Kịch bản Pivot M2 — nguồn giữ nguyên

```
G1 (SIVIL) report finding: "Latency 121s do LLM key 401"
NHƯNG LISMA đọc logs phát hiện:
  "Code KHÔNG hề retry — log 121s là do timeout mặc định
   của HTTP client + fail-open path xử lý 4 keys lần lượt.
   Finding của G1 sai root cause!"

TL (KING) VERIFY:
  → Claim của G1 mâu thuẫn logs → PHẢI PIVOT
  → Yêu cầu G1 re-audit khu vực key pool với evidence
  → Chỉ nhận finding nào có file:line + log excerpt khớp nhau
```

### 8.8 Tier Escalation Matrix (nguồn, nguyên bản)

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
│  REVISED từ                liên quan bổ sung             │
│  SELF-DIRECTION                                            │
└──────────────────────────────────────────────────────────┘
```

### 8.9 TL Decision Framework (nguồn giữ nguyên — 2 cổng + 4 quyết định)

```
TL nhận thông tin mới (từ worklog / G2 escalate / LB feedback
/ M2: proposal feedback)
        │
        ▼
┌─── Đánh giá mức độ ảnh hưởng ────────────────────────┐
│  🔴 CRITICAL: Ảnh hưởng kết quả cuối cùng             │
│     → PIVOT ngay, có thể quay lại parts trước         │
│     → ĐỌC CODE liên quan để hiểu vấn đề               │
│  🟡 MODERATE: Cải thiện tiềm năng nhưng không urgent  │
│     → Nâng tier part hiện tại, thêm bước xử lý        │
│     → Có thể đọc code nếu cần hiểu sâu                │
│  🟢 MINOR: Nice-to-have, không ảnh hưởng lớn          │
│     → Ghi vào backlog, xử lý sau nếu có thời gian     │
│     → Không cần đọc code                               │
└──────────────────────────────────────────────────────┘
        │
        ▼
┌─── Đánh giá rủi ro thay đổi ─────────────────────────┐
│  Thay đổi ảnh hưởng bao nhiêu parts đã hoàn thành?     │
│   → 0 parts: Safe → Proceed                           │
│   → 1 part:  Cần re-run 1 part → Worth it?            │
│   → 2+ parts: Cần re-run nhiều → Chỉ khi CRITICAL     │
│  Deadline còn bao lâu?                                 │
│   → Nhiều thời gian: Thử thay đổi                     │
│   → Ít thời gian: Chỉ thay đổi CRITICAL               │
│  (M2) Thay đổi có phá dịch vụ đang chạy không?        │
│   → Có → Bắt buộc rollback path trong Proposal        │
└──────────────────────────────────────────────────────┘
        │
        ▼
    QUYẾT ĐỊNH:
    ├── Proceed (tiếp tục theo kế hoạch)
    ├── Adjust (thay đổi tier / thêm bước)
    ├── Pivot (quay lại, sửa parts trước)
    └── Drop (bỏ qua, tập trung phần khác)
```

### 8.10 Tổng hợp pivot triggers + từ vựng quyết định `[TB-06 §8.10 ← nguồn dòng 2698–2701 + ánh xạ JD dòng 1839]` `[EXT]`

**Pivot triggers:**

| Mission | Trigger pivot (nguồn tóm tắt TL) |
|---|---|
| M1 | CV-LB gap > 0.01 · CRITICAL issue · Fundamental approach sai |
| M2 | Claim thiếu evidence · code mâu thuẫn logs · proposal phá compatibility |

**Ánh xạ 2 bộ từ vựng quyết định** (JD dùng CONTINUE/PIVOT/ESCALATE; Framework dùng Proceed/Adjust/Pivot/Drop — cùng một cơ chế):

| Framework | JD vocabulary | Ý nghĩa |
|---|---|---|
| Proceed | CONTINUE | Kế hoạch giữ nguyên |
| Adjust | CONTINUE (có tier change) | Nâng/hạ tier, thêm bước — không quay lại parts trước |
| Pivot | PIVOT | Dừng part hiện tại, quay lại parts trước / re-audit |
| Drop / (ngoài Framework) | CONTINUE (backlog) / ESCALATE | Bỏ nice-to-have tập trung CRITICAL / lên USER — vượt quyền KING (§1.2) |

**Lưu ý:** (a) mọi quyết định DECIDE đều ghi Decision log kèm lý do + evidence ref (§13) — Instructions LUÔN; (b) pivot lặp > 2 lần trên cùng part → nghi ngờ triết approach sai → cân nhắc ESCALATE user hoặc Council mở rộng; (c) M2 pivot luôn kèm yêu cầu evidence cụ thể (file:line + log excerpt khớp nhau).

## §9. NHIỆM VỤ 7 — FINALIZE: HOÀN THÀNH & BÁO CÁO `[TB-06 §9 ← nguồn dòng 2443–2501, 4288–4343]` `[SRC]`

**Mục đích:** tổng kết mission — M1: báo cáo user; M2: tổng hợp Proposal route vào SELF-DIRECTION. **Không kết thúc khi chưa Knowledge Capture.**

**Input:** toàn bộ worklogs + metrics (M1) / findings + evidence (M2) + Decision log + Progress tracking.

**Các bước:**
1. Đối soát Progress tracking (parts done/remaining — mọi part phải DONE hoặc DROP có lý do).
2. M1: viết **Competition Summary** (§9.5). M2: tổng hợp **PROPOSAL DOCUMENT theo Proposal Schema** (§9.7).
3. **Knowledge Capture tại FINALIZE** (§9.6) — lessons phải vào KB.
4. M1: gửi Final report cho user. M2: route Proposal thẳng vào SELF-DIRECTION, status SUBMITTED.
5. Ghi Decision log kết thúc task.

### 9.5 M1 — Competition Summary (nguồn giữ nguyên cấu trúc)

```
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
```

### 9.6 Knowledge Capture tại FINALIZE (M1) `[TB-06 §9.6 ← nguồn dòng 2488]` `[SRC]`

> *Toàn bộ "Lessons for Future Competitions" được KING ghi vào Knowledge Base NGAY theo KB Write Protocol — tri thức không được phép chỉ nằm trong Competition Summary. HAN sẽ curate ở chu trình G3 gần nhất (nếu task có G3).*

Tương tự M2: "Lessons for Future Audits" (cách audit hiệu quả, anti-pattern phát hiện, cách verify claim) — mục Category `Research Insights` (TB-08).

### 9.7 M2 — Route vào SELF-DIRECTION (nguồn giữ nguyên)

```
KING tổng hợp output G1/G2/G3 thành PROPOSAL DOCUMENT
theo Proposal Schema chuẩn (xem TB-11 — 8 trường:
Problem Statement / Root Cause / Options / Recommendation /
Expected Impact / Risk & Rollback / Verification Plan / Effort):

  → Route THẲNG vào module SELF-DIRECTION của TMO
  → Status: SUBMITTED — chờ user hoặc agent được ủy quyền phê duyệt
  → KHÔNG qua user inbox trung gian — SELF-DIRECTION là nơi quyết định
  → Approval có thể đến từ: user trực tiếp HOẶC agents được ủy quyền
  → Sau SUBMITTED: KING vẫn theo dõi, cập nhật nếu bị REVISED
```

**Điều kiện vào SUBMITTED (gate KING tự kiểm trước khi route) [EXT]:** (1) mọi claim đã có evidence (Instructions LUÔN — M2); (2) Options có ≥ 2 lựa chọn kèm trade-offs; (3) Risk & Rollback có rollback path cho mọi thay đổi đụng dịch vụ đang chạy (§8.9 cổng 2); (4) Verification Plan có (a) kiểm chứng tay ngay + (b) benchmark spec DEFERRED (TB-11).

### 9.8 Theo dõi sau SUBMITTED `[TB-06 §9.8 ← nguồn dòng 4331–4340, 2577–2579]` `[SRC]`

| Trạng thái Proposal | KING làm gì |
|---|---|
| **APPROVED** | Đóng task M2; thay đổi áp từ Workspace lên Live System do user/agent ủy quyền (thao tác riêng — không phải KING). Ghi KB lesson nếu có |
| **REJECTED** (kèm lý do) | Phân tích lý do → quyết định quay lại research (re-DECOMPOSE phần liên quan) hay đóng mission — ghi Decision log; xem §14 E4 |
| **REVISED** (yêu cầu bổ sung evidence/option) | Giao lại group liên quan bổ sung → cập nhật Proposal → re-SUBMIT (kịch bản trong Tier Escalation Matrix §8.8 dòng cuối) |

**Lưu ý:** (a) FINALIZE không xóa task .md/worklog — giữ làm evidence truy vết; (b) M1 report gửi user kèm đề xuất next competition nếu có lesson đáng giá; (c) M2: KING không tự phê duyệt Proposal của chính mình — phê duyệt thuộc SELF-DIRECTION (user/agent ủy quyền).

---

## §10. RESEARCH COUNCIL — KING CHỦ TRÌ `[TB-06 §10 ← nguồn dòng 1748–1771, 2536–2541]` `[SRC]`

### 10.1 Bản chất & 4 thời điểm

KING và SIVIL tiến hành **nhiều thảo luận** trong suốt quá trình vận hành — nơi tri thức được **phát hiện, thách thức và chốt**:

```
┌─────────────────────────────────────────────────────┐
│  RESEARCH COUNCIL — KING ↔ SIVIL                    │
│                                                      │
│  Thời điểm (4 cố định):                             │
│  ① Sau DECOMPOSE — trước khi ASSIGN                 │
│  ② Sau SYNTHESIZE — trước khi BELI code             │
│  ③ Khi G1 ESCALATE                                   │
│  ④ Tại mỗi Checkpoint                                │
│                                                      │
│  Nội dung:                                           │
│  ├── Challenge hypotheses (KING hỏi, SIVIL           │
│  │   đáp bằng findings)                              │
│  ├── Đối chiếu findings với KB: "đã có chưa?"      │
│  └── Chốt tri thức mới → ghi KB NGAY                │
│                                                      │
│  Output:                                             │
│  ├── Discussion summary (ghi vào worklog)           │
│  └── KB entries mới (KB Write Protocol)             │
└─────────────────────────────────────────────────────┘
```

| Thời điểm | Chủ đề đặc trưng | Liên kết |
|---|---|---|
| ① sau DECOMPOSE | Challenge cách chia parts, tier, protocol/charter từng part | §5 bước 5 |
| ② sau SYNTHESIZE | Chốt specs trước khi BELI code — SIVIL đáp bằng findings sub-agents | G1 workflow bước 4 (TB-03 §4) |
| ③ khi G1 ESCALATE | Phân tích blocking issue, 2 interpretation SA mâu thuẫn | TB-03 §5 |
| ④ mỗi Checkpoint | Review findings/metrics vừa verify, quyết định ảnh hưởng DECIDE | TB-02 §3.3 |

### 10.2 [EXT] Template Council Summary (ghi vào worklog) `[TB-06 §10.2 ← mở rộng từ nguồn dòng 1768–1770]` `[EXT]`

```markdown
## YYYY-MM-DD HH:MM — RESEARCH COUNCIL — [T-<MISSION>-<NNN>] — thời điểm ①/②/③/④
- Tham dự: KING (chủ trì), SIVIL
- Đề tài: [câu hỏi nghiên cứu đưa vào council]
- Tranh luận:
  - KING challenge: [hypothesis được hỏi]
  - SIVIL đáp (bằng findings): [evidence/sub-agent ref]
  - Điểm chưa chốt: [nếu có — ai phụ trách xác nhận]
- Kết luận: [tri thức/quyết định được chốt]
- KB entries sinh ra: [KB-YYYYMMDD-NNN, ... hoặc "không có gì mới"]
- Ảnh hưởng pipeline: [adjust tier / sửa task .md / không đổi]
```

### 10.3 Quy tắc vận hành `[TB-06 §10.3 ← nguồn dòng 1817–1823 (quy tắc vàng 5) + 1732–1733 (lỗ hổng ③)]` `[SRC]`

- Mọi thảo luận kết thúc bằng câu hỏi: **"Có gì KB chưa có?"** (quy tắc vàng #5 — council là nguồn tri thức sống).
- Council **không quyết định thay DECIDE** — council chốt tri thức + challenge; quyết định pipeline vẫn là KING (Decision log).
- Discussion summary phải vào worklog NGAY (vá lỗ hổng thiết kế cũ: "thảo luận KING ↔ SIVIL không được lưu lại → insight mất ngay khi kết thúc").
- KB entries từ council đi qua KB Write Protocol đầy đủ (SEARCH → FORMAT → WRITE → CURATE — chi tiết TB-08 §4); Category `Research Insights` là nơi lưu chính kết quả council.

## §11. CƠ CHẾ GIAO TIẾP TL ↔ GROUPS `[TB-06 §11 ← nguồn dòng 2503–2544]` `[SRC]`

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
│  ├── Recommendations (nên làm gì tiếp)                   │
│  ├── Knowledge Base updates (lessons learned)             │
│  └── Metrics (score trước/sau, improvement)               │
│                                                           │
│  KING ↔ SIVIL (RESEARCH COUNCIL):                        │
│  ├── ① Sau DECOMPOSE (trước ASSIGN)                      │
│  ├── ② Sau SYNTHESIZE (trước khi BELI code)              │
│  ├── ③ Khi G1 ESCALATE                                   │
│  ├── ④ Tại mỗi Checkpoint                                │
│  └── Output: discussion summary + KB entries mới         │
│                                                           │
└──────────────────────────────────────────────────────────┘
```

Diễn giải hợp đồng 2 chiều `[TB-06 §11 ← suy từ nguồn + TB-02 §2]` `[EXT]`:

| Kênh | Tải chính | Tải phản hồi | Vi phạm điển hình → xử lý |
|---|---|---|---|
| TL → G1 | task .md (per part) | G1 worklog (blocking issues, council ②③) | KING chỉ cách làm → tự sửa lại task .md chỉ WHAT không HOW |
| TL → G2 / G3 | G2: task .md SIMPLE trực tiếp; G3: KHÔNG giao trực tiếp | G2: worklog + ESCALATE 3 loại; G3: recommendations + metrics + KB | Giao MEDIUM/COMPLEX thẳng G2 → chuyển qua G1; giao thẳng G3 → chuyển về qua G2 |
| G1/G2/G3 → user | — | — | Chỉ KING ESCALATE lên user (§1.2); group không nhảy cấp |

## §12. STATE MACHINE CỦA KING THEO MISSION `[TB-06 §12 ← hình thức hóa pipeline nguồn dòng 2631–2686 + 4331–4340]` `[EXT]`

### 12.1 M1 — Kaggle Research

```
REQUEST
   ▼
┌─────────────┐  đọc toàn bộ context (competition page,
│  RECEIVING  │  data dictionary, forum) — Bước 0 CLASSIFY
└──────┬──────┘  §2 đã xong (ambiguous → hỏi user 1 câu)
       ▼
┌──────────────┐  mission M1 + confidence — ghi Decision
│ CLASSIFIED:M1│  log; đủ initial analysis (§3)
└──────┬───────┘
       ▼
┌─────────────┐  3 tiêu chí chấm điểm → tier tổng thể
│   TRIAGED   │  + TIER CHO TỪNG PART (mission Complex,
└──────┬──────┘  part có thể Simple/Medium)
       ▼
┌─────────────┐  parts + .md từng part + protocol
│  DECOMPOSED │  + priority & thứ tự
└──────┬──────┘
       ▼  Council ① (sau DECOMPOSE — TRƯỚC ASSIGN)
┌─────────────┐  task .md giao group theo routing tier
│   ASSIGNED  │  ← nhận lại từ DECIDING (Adjust/Drop)
└──────┬──────┘
       ▼
┌─────────────┐  đọc worklog sau mỗi Checkpoint
│  MONITORING │  (Council ④); verify metrics; code KEY;
└──────┬──────┘  KB NGAY khi phát hiện
       ▼
┌─────────────┐  Proceed → part kế / hết parts → FINALIZED
│   DECIDING  │  Adjust → ASSIGNED · Pivot → DECOMPOSED
└──────┬──────┘  Drop → part khác · Escalate → ESCALATED_USER
       ▼  (Proceed — mọi part DONE)
┌─────────────┐  Competition Summary + Knowledge Capture
│  FINALIZED  │  → Final report → USER
└─────────────┘
```

### 12.2 M2 — System Research (+ Proposal lifecycle)

```
RECEIVING → CLASSIFIED:M2 → TRIAGED → DECOMPOSED → ASSIGNED
   → MONITORING ⇄ DECIDING (Adjust/Pivot/Escalate như M1)
   → FINALIZED
        ▼  (điều kiện gate §9.7)
  PROPOSAL_DRAFTING  ── tổng hợp theo Proposal Schema (TB-11)
        ▼
     SUBMITTED ──▶ SELF-DIRECTION (route THẲNG, không qua user inbox)
        ├──▶ APPROVED  (áp Workspace→Live do user/agent ủy quyền) → END
        ├──▶ REJECTED ──▶ RESEARCHING (re-DECOMPOSE nếu cần) ──▶ ...DECOMPOSED
        └──▶ REVISED ───▶ ASSIGN group liên quan bổ sung
                          evidence/option → update → re-SUBMITTED
```

### 12.3 Bảng transition chính

| Từ | Sự kiện | Action | Đến |
|---|---|---|---|
| RECEIVING | classify xong (confidence cao; ambiguous → user trả lời câu §2.2) | ghi Decision log mission | CLASSIFIED_M1/M2 |
| CLASSIFIED | đủ initial analysis | chấm complexity | TRIAGED |
| TRIAGED | tier chấm xong | viết parts + .md + protocol | DECOMPOSED |
| DECOMPOSED | council ① challenge xong | giao task .md theo routing tier | ASSIGNED |
| ASSIGNED | group xong / CP đến | đọc worklog, verify, KB | MONITORING |
| MONITORING | có input mới (ESCALATE/LB/feedback) | framework §8.9 | DECIDING |
| DECIDING | Proceed | chuyển part tiếp theo / task kế | ASSIGNED (part kế) |
| DECIDING | Adjust | nâng/hạ tier, ghi log, viết task .md mới | ASSIGNED |
| DECIDING | Pivot | dừng part, quay lại parts trước | DECOMPOSED |
| DECIDING | Escalate user | chờ user (§1.2) | ESCALATED_USER |
| DECIDING | Drop | backlog, tập trung CRITICAL | ASSIGNED (part khác) |
| DECIDING | mọi part DONE | tổng kết | FINALIZED |
| FINALIZED (M1) | Competition Summary + KB | gửi user | END |
| FINALIZED (M2) | Proposal đủ gate §9.7 | tổng hợp Proposal Schema | PROPOSAL_DRAFTING |
| PROPOSAL_DRAFTING | route | SELF-DIRECTION nhận | SUBMITTED |
| SUBMITTED | phê duyệt đạt | — (áp là thao tác riêng) | APPROVED → END |
| SUBMITTED | REJECTED kèm lý do | phân tích, re-decide | RESEARCHING → DECOMPOSED |
| SUBMITTED | REVISED | giao group bổ sung | ASSIGNED (→ update → SUBMITTED) |

**Invariants:** (I1) không vào ASSIGNED chưa qua council ①; (I2) không vào FINALIZED khi còn part Pending (trừ DROP có log); (I3) không vào SUBMITTED khi còn claim thiếu evidence; (I4) M2 không bao giờ kết thúc ở Final report cho user — kết thúc ở Proposal; (I5) mọi vòng DECIDE đều sinh dòng Decision log (§13).

> **Ghi chú [EXT]:** RESEARCHING (chỉ xuất hiện ở nhánh REJECTED của M2 — pseudo-state re-DECOMPOSE) và ESCALATED_USER (side state chờ user, §1.2 — chưa có transition ra chi tiết) là 2 state đặc biệt; hành vi hoàn chỉnh (timeout / ủy quyền agent trả lời thay) đã chốt v1.3 [Q7 → DECIDED]: timeout 48h/24h + nhắc 12h + deputy approver SIVIL/HAN (§16).

---

## §13. DECISION LOG — FORMAT `[TB-06 §13 ← hình thức hóa Instructions "ghi lý do mọi quyết định" dòng 1848 + Deliverables dòng 1844]` `[EXT]`

**Mỗi quyết định = 1 dòng** (append-only, KING ghi trong suốt mission):

```
D-NNN | [timestamp] | [T-<MISSION>-<NNN> / Part k] | [MISSION: M1|M2]
      | [QUYẾT ĐỊNH: <loại> — nội dung] | [LÝ DO: 1 câu]
      | [EVIDENCE: worklog ref / file:line / log excerpt / metric]
```

**Loại quyết định chuẩn:** CLASSIFY · TIER-SET · TIER-UP · TIER-DOWN · ASSIGN · ACCEPT (CP) · REJECT (CP) · PIVOT · DROP · ESCALATE-USER · KB-CAPTURE · SUBMIT-PROPOSAL · REVISE-PROPOSAL.

**Ví dụ:**

```
D-007 | 2024-01-15 13:05 | T-HP-002/Part 4 | M1
      | TIER-UP: Medium → Complex (Part 4 Ensemble)
      | LÝ DO: 0.118 vs 0.115 — chênh 0.003 trên Kaggle là nhiều;
        stacking cần K-Fold → phức tạp hơn dự kiến
      | EVIDENCE: G2 worklog 11:15 — suggestion stacking 0.115
D-012 | 2025-06-12 09:40 | T-M2-001/Part 1 | M2
      | PIVOT: yêu cầu G1 re-audit khu vực key pool
      | LÝ DO: claim "retry mù" mâu thuẫn logs — LISMA chỉ ra
        121s do HTTP client timeout + fail-open 4 keys
      | EVIDENCE: dev.log 121s vs code path key-pool (LISMA report)
```

**Quy tắc:** (1) 1 quyết định 1 dòng — không paragraph; (2) không có dòng nào không có LÝ DO hoặc EVIDENCE ref; (3) log là append-only — quyết định sửa quyết định trước thì ghi dòng mới (không edit dòng cũ); (4) Decision log là 1 trong Deliverables bắt buộc của KING (§1.1) — FINALIZE kèm chốt số dòng.

## §14. ERROR & EDGE CASES `[TB-06 §14 ← suy từ nguồn dòng 1862, 1991–2013, 2546–2582, 4338–4339, TB-02 §6]` `[EXT]`

| # | Tình huống | Triệu chứng | Xử lý của KING |
|---|---|---|---|
| **E1** | Request ambiguous (CLASSIFY LOW confidence) | Keyword xung đột M1/M2 (vd "Kiểm tra bug trong code pipeline") | Hỏi user ĐÚNG 1 CÂU (mẫu §2.2) — KHÔNG đoán mò; sau câu trả lời classify lại và ghi log |
| **E2** | Classified sai mission (phát hiện giữa chừng) | Input của mission này không tồn tại; parts chỉ vận hành được ở môi trường bên kia; CP đầu không ra artifact đúng loại | PIVOT về Bước 0 (§2.5): re-CLASSIFY, ghi Decision log, đánh giá output trung gian (giữ nếu dùng được), KHÔNG "tiếp tục cho xong" |
| **E3** | ESCALATE chồng (G2 ESCALATE khi G1 đang blocking; nhiều group cùng escalate) | Nhiều tín hiệu ESCALATE trong cùng chu kỳ MONITOR | Xếp thứ tự theo framework §8.9 (CRITICAL trước); gộp các escalate cùng root cause thành 1 quyết định; Council ③ nếu liên quan G1; 1 DECIDE — 1 dòng log |
| **E4** | Proposal bị REJECTED (từ SELF-DIRECTION) | Status REJECTED kèm lý do | Phân tích lý do: thiếu evidence → giao lại group liên quan (REVISED-style) nhưng nếu REJECTED vì giải pháp không phù hợp hướng hệ thống → quyết định re-research (re-DECOMPOSE) hay đóng mission — ghi log; ESCALATE user nếu lý do không rõ |
| **E5** | Tier sai giữa chừng (part quá dễ/hard cho tier đã giao) | G1 finish nhanh hơn dự kiến / G2 loop không hội tụ | DECIDE nâng/hạ theo Tier Escalation Matrix §8.8; đã chốt v1.3: append task .md (version + CHANGELOG, không rewrite) (→ TB-09, [DECIDED v1.3 → DR-C3: append-only]) |
| **E6** | Worklog thiếu metrics (M1) / evidence (M2) | Claim không có số đo / file:line | Trả yêu cầu bổ sung cho group; không tự đoán; M2: claim thiếu evidence không bao giờ vào Proposal (Instructions LUÔN) |
| **E7** | M2 cần POC nhưng user chưa mở Workspace | Part 3 kiểu "BELI viết POC trong Workspace" không có nơi chạy | Giao phần nghiên cứu/solution design; đánh cờ `POC-NEEDS-WORKSPACE` trong Proposal (quy ước TB-02 §6); nhắc user mở Workspace |
| **E8** | Pivot lặp (oscillation) | Cùng part pivot ≥ 2 lần | Dừng vòng lặp: Council ③/④ mở rộng phân tích root approach; cân nhắc ESCALATE user — "fundamental approach sai" vượt khả năng tự sửa |
| **E9** | Data quality không cứu được | Missing/nhiễu dữ liệu ở mức không thể preprocess | ESCALATE lên user (§1.2 — đúng danh sách 3 tình huống) kèm evidence; chờ quyết định |
| **E10** | Deadline áp (M1) / Live System đang degraded (M2) | Deadline gần / module user-facing sập | Hạ tier tất cả parts, chỉ giữ CRITICAL (§8.8); M2: nếu Live đang bị đe dọa nghiêm trọng — ESCALATE user ngay, không chờ pipeline |

---

## §15. ACCEPTANCE CRITERIA `[TB-06 §15 ← verify]` `[EXT]`

Verify TB-06 đạt chuẩn khi:

- [ ] **AC1** §1 giữ nguyên văn JD + Instructions KING: dual mission, 7 nhiệm vụ, KHÔNG code (đọc để HIỂU), Deliverables có **KB entries mới**, 6 khối Instructions đủ (LUÔN/KHÔNG BAO GIỜ/Input/Output contract/ESCALATE 3 tình huống/Signature move).
- [ ] **AC2** Bảng "Tại sao TL thiết kế như vậy" 4 dòng + box "Nhìn lớn, chia nhỏ, kiểm soát chặt" + box Nguyên tắc TL (NHÌN LỚN/CHIA NHỎ/KIỂM SOÁT CHẶT) nguyên bản nguồn.
- [ ] **AC3** §2 CLASSIFY: 2 danh sách signals nguyên văn + câu hỏi ambiguous đúng nguyên văn + thuật toán 3 lớp [EXT] + bảng ví dụ ≥ 8 dòng + hệ quả sai mission (2 hướng) + cách phát hiện + pivot về CLASSIFY.
- [ ] **AC4** §3–§9 đủ 7 nhiệm vụ, mỗi nhiệm vụ có: mục đích / input / các bước đánh số / output / ví dụ nguồn / lưu ý.
- [ ] **AC5** Các ví dụ nguồn GIỮ NGUYÊN: RECEIVE M1 (House Prices) + M2 (chat chậm) · TRIAGE M1+M2 (chấm điểm + per-part) · DECOMPOSE 6 parts M1 + 4 parts M2 · ASSIGN workflow 6 parts + template `task_complex_part2.md` + template `task_m2_part1.md` · MONITOR worklog 2024-01-15 (G1/G2/G3 + TL đánh giá) · DECIDE 3 kịch bản + pivot M2 · FINALIZE Competition Summary House Prices.
- [ ] **AC6** §7.7: bảng "TL đọc code khi nào?" đầy đủ **8 dòng** nguyên văn + TL CODE READING PRINCIPLES 5 nguyên tắc (TRUST FIRST / READ BY EXCEPTION / READ SELECTIVELY / READ TO UNDERSTAND, NOT TO FIX / READ OUTPUT FIRST) + 3 tình huống đọc code.
- [ ] **AC7** §8.8 Tier Escalation Matrix giữ nguyên 8 signals; §8.9 Decision Framework đủ 2 cổng + 4 quyết định (Proceed/Adjust/Pivot/Drop); có ánh xạ sang CONTINUE/PIVOT/ESCALATE.
- [ ] **AC8** §7.8 + §9.6: MONITOR & Knowledge Capture + FINALIZE Knowledge Capture (lessons phải vào KB, note tier SIMPLE/MEDIUM không qua G3) nguyên ý nguồn.
- [ ] **AC9** §9.7: M2 route THẲNG vào SELF-DIRECTION — status SUBMITTED, KHÔNG qua user inbox trung gian, phê duyệt bởi user hoặc agent ủy quyền, KING theo dõi nếu REVISED.
- [ ] **AC10** §10 Council: 4 thời điểm ①–④ + nội dung (challenge hypotheses / đối chiếu KB / chốt tri thức) + output (discussion summary vào worklog + KB entries) + template Council Summary [EXT].
- [ ] **AC11** §11: box giao tiếp TL ↔ Groups nguyên bản 7 kênh (TL→G1/G2/G3, G1/G2/G3→TL, KING↔SIVIL Council).
- [ ] **AC12** §12 state machine: M1 đủ 8 trạng thái chính theo tên quy ước (RECEIVING→CLASSIFIED(M1)→TRIAGED→DECOMPOSED→ASSIGNED→MONITORING→DECIDING→FINALIZED + side state ESCALATED_USER); M2 thêm PROPOSAL_DRAFTING → SUBMITTED → (APPROVED/REJECTED/REVISED loop); bảng transition ≥ 15 dòng.
- [ ] **AC13** §13 Decision Log: 1 dòng schema (timestamp/task/decision/lý do/evidence ref) + ≥ 2 ví dụ; §14 ≥ 8 edge cases; §15 ≥ 10 items; §16 có Decisions (chốt v1.3).
- [ ] **AC14** Không mâu thuẫn nguồn và không mâu thuẫn TB-02/03/04 (CP1=sau G1, CP2=sau G2, CP3=sau G3; floor-rule M2; council ② sau SYNTHESIZE); các phần [EXT] không phát minh cơ chế trái nguồn.
- [ ] **AC15** Tên agent đúng KING/SIVIL/BELI/LISMA/HAN; model stack Kimi-k3 + fallback 3 bậc (role-based) — không lẫn tên model làm tên agent.

## §16. DECISIONS — [Q] ĐÃ CHỐT (v1.3) `[TB-06 §16 ← đã chốt v1.3 theo DECISION-RECORD + Phụ lục Z]` `[DECIDED v1.3]`

- **Q1 — Ngưỡng confidence CLASSIFY: ✅ CHỐT v1.3 — DR-C2:** HIGH = ≥ 3 tín hiệu độc lập cùng chiều, **0 mâu thuẫn**; MEDIUM = đúng 1 mâu thuẫn → KING verify thêm 1 vòng context → vẫn mâu thuẫn → **TIE-BREAK UP** (chọn tier cao hơn) + Decision Log; LOW = ≥ 2 mâu thuẫn hoặc thiếu tín hiệu → hỏi user đúng 1 câu. Điểm biên ngưỡng 2 tier (±1 điểm) → chọn tier cao hơn. *(Đồng bộ TB-02 §8.)*
- **Q2 — Hành vi council ②: ✅ CHỐT v1.3 — KING VETO được:** checklist ack/veto từng spec trong worklog (mỗi spec 1 dòng `ack` hoặc `veto: lý do`); veto → spec quay lại SIVIL revise; ≥ 2 vòng veto cùng spec → escalate council ③. *(Đồng bộ TB-03 §12 Q3.)*
- **Q3 — Proposal REJECTED → tier gì: ✅ CHỐT v1.3 — Re-TRIAGE đầy đủ từ đầu** (nghi ngờ mis-tier — không giữ tier mặc định), GIỮ toàn bộ worklog/context làm input; **tối đa 2 vòng REJECTED → research; vòng 3 → ESCALATED_USER**.
- **Q4 — Nâng/hạ tier giữa chừng: ✅ CHỐT v1.3 — DR-C3: append-only:** task .md thêm trường `version: N` + block `## CHANGELOG`; mọi nâng/hạ tier = 1 amendment entry (version n → n+1 | ai quyết | tier cũ → mới | lý do | evidence ref) — KHÔNG bao giờ rewrite. *(Đồng bộ TB-09 Handoff — cập nhật E5 §14.)*
- **Q5 — Giới hạn "hỏi 1 câu": ✅ CHỐT v1.3 — 1 câu CLASSIFY (chỉ khi confidence LOW) + tối đa 1 câu user-blocked-info mỗi task**; vượt hạn mức → quyết theo tie-break UP (DR-C2) + ghi Decision Log, không hỏi thêm. *(Chốt đúng đề xuất ban đầu.)*
- **Q6 — Council đồng bộ hay bất đồng bộ: ✅ CHỐT v1.3 — ĐỒNG BỘ (blocking):** mọi council ①②③④ chặn pipeline chờ hoàn tất; chất lượng > latency (P1 thorough-first, P2 không ràng buộc token — không race-condition trên quyết định).
- **Q7 — ESCALATED_USER: ✅ CHỐT v1.3 — DR-C5:** timeout **48h (M1) / 24h (M2)** wall-clock, nhắc mỗi **12h**, tối đa **3 nhắc**; hết hạn → pipeline task đó dừng toàn phần (parts khác độc lập). Ủy quyền **deputy approver SIVIL/HAN có thời hạn** (không được là author; KING cấm tự duyệt — §9.8), ghi Decision Log + worklog. *(Cập nhật ghi chú §12.)*
- **Q8 — Verify Proposal trước SUBMIT: ✅ CHỐT v1.3 — CÓ, bắt buộc field-by-field:** KING verify đủ **8 trường** (checklist từng trường lưu Decision Log), trọng điểm **Risk & Rollback (trường 7 — "linh hồn Proposal")** trước khi route vào SELF-DIRECTION; gate §9.7 giữ nguyên + bước verify này thành điều kiện SUBMIT.

---

## PHỤ LỤC A — TRACEABILITY MATRIX

| Section TB-06 | Section nguồn (ai-team-workflow.md) | Dòng | Mức |
|---|---|---|---|
| §0 Bản đồ Internal Workflow | Schema tổng hợp — TL Internal Workflow | 2631–2686 | [SRC] |
| §1.1–§1.2 JD + Instructions | JOB DESCRIPTION + INSTRUCTIONS — KING | 1829–1853 | [SRC] |
| §1.3 Thiết kế vai trò | Tại sao vị trí TL được thiết kế như vậy? | 1855–1862 | [SRC] |
| §1.4 Nguyên tắc + §1.5 runtime [EXT] | Nhìn lớn, chia nhỏ, kiểm soát chặt + TB-00/TB-01 | 1864–1880 | [SRC] + [EXT] |
| §2.2 Signals + output CLASSIFY | Bước 0 — CLASSIFY MISSION | 1991–2013 | [SRC] |
| §2.3–§2.4 Thuật toán 3 lớp + bảng ví dụ | mở rộng từ Bước 0 + mô phỏng ví dụ M1/M2 | 1991–2070 | [EXT] |
| §2.5 Sai mission | Thiết kế vai trò (dòng CLASSIFY) | 1862 | [SRC] |
| §3 RECEIVE | Nhiệm vụ 1 (kèm Bước 0) + ví dụ M1/M2 | 1989–2070 | [SRC] |
| §4 TRIAGE (+§4.7 floor-rule [EXT]) | Nhiệm vụ 2 + ví dụ M1/M2 + bảng Complexity | 2072–2120, 3244–3257 | [SRC] |
| §5 DECOMPOSE | Nhiệm vụ 3 + ví dụ M1 6 parts + M2 4 parts | 2122–2190 | [SRC] |
| §6 ASSIGN + 2 template | Nhiệm vụ 4 + task_complex_part2.md + task_m2_part1.md | 2192–2289 | [SRC] |
| §7 MONITOR (+§7.8 note KB) | Nhiệm vụ 5 + worklog 2024-01-15 + MONITOR M2 + Knowledge Capture | 2291–2343 | [SRC] |
| §7.7 TL đọc code | TL có đọc code không? — 3 tình huống + bảng 8 dòng + 5 nguyên tắc | 1882–1985 | [SRC] |
| §8.4–§8.7 Kịch bản DECIDE | Nhiệm vụ 6 — 3 kịch bản + pivot M2 | 2345–2441 | [SRC] |
| §8.8 Tier Escalation Matrix | Cơ chế nâng/hạ tier giữa chừng | 2546–2582 | [SRC] |
| §8.9 Framework + §8.10 triggers | TL Decision Framework + Tóm tắt cơ chế TL + JD | 2584–2629, 2698–2701, 1839 | [SRC] + [EXT] |
| §9 FINALIZE | Nhiệm vụ 7 + Competition Summary + KB + route M2 | 2443–2501 | [SRC] |
| §9.7–§9.8 Proposal route (+gate [EXT]) | Route SELF-DIRECTION + Proposal Schema + vòng đời | 4288–4343, 1848, 2618–2620 | [SRC] + [EXT] |
| §10 Research Council (+§10.2 template [EXT]) | RESEARCH COUNCIL + quy tắc vàng + lỗ hổng ③ | 1748–1771, 1817–1823 | [SRC] |
| §11 Giao tiếp TL ↔ Groups | Cơ chế giao tiếp TL — box nguyên bản | 2503–2544 | [SRC] |
| §12 State machine | hình thức hóa pipeline + vòng đời Proposal | 2631–2686, 4331–4340 | [EXT] |
| §13 Decision Log | hình thức hóa Instructions + Deliverables | 1844, 1848 | [EXT] |
| §14 Error & Edge | suy từ CLASSIFY/DECIDE/Matrix/Proposal + TB-02 §6 | 1862, 2546–2582, 4338–4339 | [EXT] |
| §15–§16 + Phụ lục | verify + decisions (chốt v1.3) | — | [EXT] + [DECIDED v1.3] |

---

## PHỤ LỤC B — QUICK REFERENCE: TÓM TẮT CƠ CHẾ TL `[TB-06 Phụ lục B ← nguồn dòng 2688–2706]` `[SRC]`

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

*TB-06 hoàn tất — KING Engine đủ chi tiết để triển khai orchestration + dùng làm JD/Instructions runtime. Chờ user review; cập nhật Status Tracker TB-00 §6 sau phê duyệt. File kế tiếp theo build order: TB-09 (RWV Loop & Handoff) — TB-07 (Decompose playbook) và TB-05 (G3+KB) do task song song đảm nhiệm.*
