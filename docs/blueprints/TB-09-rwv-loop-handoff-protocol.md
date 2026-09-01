# TB-09 — RWV LOOP & HANDOFF PROTOCOL (READ-WRITE-VERIFY — TL LÀ RESEARCH LOOP CONTROLLER)

> 📐 **TECHNICAL BLUEPRINT — AI RESEARCH TEAM (DUAL MISSION: M1 Kaggle + M2 System Research)**
> Nguồn chính: `upload/ai-team-workflow.md` — 📋 HANDOFF PROTOCOL (dòng 3285–3337), 🔄 READ-WRITE-VERIFY LOOP (dòng 3341–3775), worklog mẫu MONITOR (dòng 2294–2337), bảng ghi chú RWV (dòng 4585–4598)
> Version: 1.2 | Ngày: 2026-08-31 (review + fix — Task 9, 10-e) | Biên soạn: Mr. Robot (Z.ai Code) — nhóm C (Protocols ngang)
> **v1.3 (2026-09-01):** toàn bộ [Q] đã chốt theo DECISION-RECORD-v1.3.md (user ủy quyền, thorough-first) — xem Phụ lục Z nguồn.
> Quy ước chung: TB-00 §1 (roster · model stack · mission · Live System vs Workspace) + §5 ([SRC]/[EXT]/[Q] *(→ từ v1.3: [Q] đã chuyển thành [DECIDED v1.3])*)

## §0. 🎯 MỤC ĐÍCH & PHẠM VI `[TB-09 §0 ← suy từ nguồn dòng 3285–3775 + TB-00 §2]` `[EXT]`

- **Mục đích:** chuẩn hóa 2 thứ chạy xuyên suốt pipeline research: **(1) vật liệu giao tiếp** giữa KING ↔ Groups và Group ↔ Group (task .md, worklog); **(2) vòng lặp kiểm soát** READ-WRITE-VERIFY (RWV) giúp TL phát hiện sai hướng **sau mỗi group** thay vì cuối pipeline.
- **Tính chất protocol ngang:** áp cho **mọi tier** (T1: 1 vòng · T2: 2 vòng · T3: 3 vòng ≈ số chu kỳ checkpoint — §2.4; nguồn ghi theo vòng iteration: T1 ~1–2 vòng · T2 ~2–3 vòng — dòng 3199/3220), **cả 2 mission** (M1 verify theo metric · M2 verify theo evidence), mọi luồng của TB-02.
- **Ai đọc:** 5 agents runtime (Instructions của mỗi group) · kỹ sư triển khai (cài worklog + checkpoint hooks) · user (review cơ chế kiểm soát).
- **Không chứa:** Directed Reading + Research Artifact Map chi tiết (→ TB-10); Research Council (→ TB-06 §10); decomposition + template task .md đầy đủ (→ TB-07 §3); quyết định nâng/hạ tier chi tiết (→ TB-06 §8).
- **File liên quan:** TB-02 §3.3 (bảng checkpoint rút gọn — TB-09 §3 là bản đầy đủ) · TB-06 §7 (MONITOR), §13 (Decision log) · TB-07 §3 (task .md chuẩn) · TB-08 (KB capture trong WRITE) · TB-10 (ai đọc artifact nào).
- **Thuật ngữ:** Checkpoint đánh số theo khối — **CP1 = sau G1 · CP2 = sau G2 · CP3 = sau G3** (quy ước Task 8-a, khớp TB-02 §3.3).

## §1. 📋 HANDOFF PROTOCOL GIỮA CÁC GROUP `[TB-09 §1 ← nguồn dòng 3285–3337]` `[SRC]`

### 1.1 Cấu trúc file `.md` cho mỗi task (nguồn — giữ cấu trúc)

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

> Template giữ nguyên `ID: T-001` như ví dụ nguồn; runtime chuẩn hóa theo quy ước toàn tập `T-<MISSION>-<NNN>` (TB-00 §1.4 — VD `T-HP-002` dùng ở §4.4). `[EXT — chú thích mapping]`

Bảng phân vai điền `[EXT]`:

| Trường | Ai điền | Bắt buộc | Ghi chú |
|---|---|---|---|
| Task / ID / Mission / Tier / Part / Status | KING (TRIAGE + DECOMPOSE + ASSIGN) | ✅ | Part chỉ khai với Complex (T3); ID theo TB-00 §1.4 |
| Mô tả | KING | ✅ | CÁI GÀI cần làm — không phải cách làm (TB-07 §3.1) |
| Input | KING | ✅ | Data/artifacts từ parts trước; M2: + Module Map + log range |
| Output kỳ vọng | KING | ✅ | Kết quả đo được — điều kiện hoàn thành của group |
| Constraints | KING | ✅ | MUST / SHOULD / AVOID — mỗi mức ≥ 1 dòng (TB-07 §3.1) |

**Vị trí template:** TB-09 giữ đúng 4 block nguồn trên làm **handoff tối thiểu** (mọi tier dùng được). Template chuẩn hóa đầy đủ (thêm Research Direction, Hypotheses to Test, Experimental Design, Success Criteria, Decision Gate, Evidence Sources M2, KB References) → **TB-07 §3** — T3 NÊN dùng bản đầy đủ.

### 1.2 Hai chiều handoff

```
┌──────────────────────── HANDOFF 2 CHIỀU ────────────────────────┐
│  (1) XUỐNG — task .md:   KING ──▶ Group nhận (ASSIGN, routing   │
│      theo tier — TB-02 §5). M2: task luôn gắn Module Map +      │
│      ràng buộc Live System (chỉ đọc) / Workspace (nghiên cứu).  │
│  (2) LÊN — worklog:      Group xong phase ──▶ KING đọc tại      │
│      Checkpoint (§3); "Đề xuất cho group tiếp" ──▶ group kế     │
│      đọc khi bắt đầu (G1 → G2 → G3 chạy nối tiếp trong tier).   │
└──────────────────────────────────────────────────────────────────┘
```

### 1.3 Handoff flow (nguồn — giữ nguyên)

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

Phân tích từng mũi tên `[EXT]`:

| Mũi tên | Artifact kèm | Điều kiện handoff hợp lệ | Điểm kiểm soát |
|---|---|---|---|
| KING → G1 | task .md (4 block + protocol trích) | council ① đã duyệt — task LOCKED (TB-07 §8) | ASSIGN (TB-06 §6) |
| G1 → G2 | worklog G1 + draft code + Artifact Map cập nhật + issues + suggestions | **CP1 = CONTINUE** trước khi G2 bắt đầu (§3.2) | CP1 |
| G2 → G3 | worklog G2 + code sạch + bugs table + suggestions G3 | **CP2 = CONTINUE** (leakage đã fix — M1 P#1) | CP2 |
| G3 → KING | worklog G3 + output cuối (M1: optimized code + metrics · M2: proposal items + verification plan) + recommendations | **CP3 + FINAL VERIFY** | CP3 |
| KING → next | Decision + protocol update | TL: Đọc → Kiểm tra → Quyết định → Next part hoặc DONE | DECIDE (TB-06 §8) |

### 1.4 Format worklog chuẩn `[TB-09 §1.4 ← nguồn dòng 3310–3319]` `[SRC]`

```markdown
## [Timestamp] — [Group] — [Task ID]
- **Mission**: M1 | M2
- **Đã làm**: ...
- **Vấn đề gặp phải**: ...
- **Đề xuất cho group tiếp**: ...
- **Files thay đổi**: ...
```

- **Quy tắc:** 1 entry mỗi lần group hoàn thành phase (hoặc vào BLOCKED cần báo TL); timestamp `YYYY-MM-DD HH:MM`; `[Group]` ∈ {G1, G2, G3}; `[Task ID]` = `T-<MISSION>-<NNN>` (TB-00 §1.4).
- **M2 — Files thay đổi:** chỉ liệt kê file trong **Workspace**, không bao giờ file của Live System (TB-04 §8.2).
- Schema đầy đủ (Research Version — Meta/Metrics/Findings/Hypothesis Status/...): **§4**.

## §2. 🔄 READ-WRITE-VERIFY LOOP — TỔNG QUAN `[TB-09 §2 ← nguồn dòng 3341–3462, 4585–4593]` `[SRC]`

### 2.1 Vấn đề: pipeline 1 chiều

```
┌──────────────────────────────────────────────────────────────┐
│  PIPELINE HIỆN TẠI (Linear, 1 chiều)                         │
│  TL ──tạo .md──▶ G1 ──worklog──▶ G2 ──worklog──▶ G3 ──▶ TL  │
│  TL chỉ kiểm tra Ở CUỐI — không đọc giữa chừng.             │
│                                                               │
│  M1: G1 features sai approach → G2 fix bug, approach vẫn    │
│      sai → G3 optimize approach sai → CV không cải thiện     │
│      → TL phát hiện quá muộn → làm lại từ đầu → mất toàn    │
│      bộ token cho 3 groups = lãng phí nghiêm trọng.          │
│  M2: G1 audit sai module → G2 chẩn đoán root cause sai →    │
│      G3 đề xuất không giải quyết vấn đề thật → Proposal      │
│      gửi SELF-DIRECTION với giả định sai → approve sai.      │
└──────────────────────────────────────────────────────────────┘
```

### 2.2 Pipeline có RWV loop (nguồn — vẽ lại)

```
TL ──WRITE protocol──▶ G1 ──WRITE worklog──▶
TL ──READ worklog──▶ VERIFY ──đúng hướng?──┬─ YES → UPDATE protocol ─▶ G2
│                                          └─ NO  → điều chỉnh hướng ─▶ giao lại G1
(tương tự G2 → CP2; G3 → CP3)
G3 xong → TL ──FINAL VERIFY──▶ DONE ✅
            (M2: FINAL VERIFY → PROPOSAL → SELF-DIRECTION)
```

### 2.3 4 bước của RWV loop (Research Version)

| Bước | Ai | Làm gì | Chi tiết bắt buộc (nguồn) |
|---|---|---|---|
| **1. WRITE** | Mỗi G khi xong | GHI worklog ra file .md → **External Memory** cho team | Đã làm (experiments, features, models) · Mission M1/M2 · **M1: Metrics** (CV/LB, so sánh trước/sau) · **M2: Findings + Evidence** (file:line, log excerpt) · Issues (leakage/overfitting/instability · system issues) · Research Artifact Map · **Hypothesis Status** (CONFIRMED/REJECTED/PENDING) · Next experiments đề xuất · KB entries mới / KB Candidates (TB-08) |
| **2. READ** | TL | Đọc worklog **sau mỗi Group** (Checkpoint) — **Metrics/Findings trước, chi tiết sau** | TL nắm: metric có cải thiện? (M1 North Star) · mọi claim có evidence? (M2 North Star) · hypothesis nào confirmed/rejected? · leakage/system signal? · đi sai hướng? · **Token ~1–2K** cho worklog (nhẹ, hiệu quả) |
| **3. VERIFY** | TL | So sánh worklog với **Research Protocol gốc** | M1: metric cải thiện so baseline? · M2: (1) evidence-based — mỗi claim có citation? (2) completeness — đủ module coverage? (3) feasibility — không phá hệ đang chạy? · Phát hiện sớm → không lan rộng · **Quyết định: CONTINUE / PIVOT / ESCALATE** |
| **4. UPDATE** | TL | Cập nhật Research Protocol (M1) / System Audit Charter (M2) | CONTINUE → cập nhật progress → giao group tiếp · PIVOT → điều chỉnh hypothesis → chạy lại experiment · ESCALATE → dừng → báo user → chờ quyết định |

Ghi chú: Research Protocol / System Audit Charter là **trường trong task .md** (TB-07 §3.2 — 5 lớp: Research Direction → Hypotheses → Experimental Design → Success Criteria → Decision Gate), không phải artifact riêng; UPDATE = viết lại/ghi đè phần thay đổi của các lớp đó vào task .md theo quy tắc versioning §9.4.

### 2.4 Số vòng RWV theo tier `[TB-09 §2.4 ← nguồn dòng 3516–3519, 4593]` `[SRC + EXT: bảng]`

| Tier | Pipeline | Số vòng RWV | Checkpoint |
|---|---|---|---|
| T1 — Simple | TL → G2 → TL | 1 | CP2 |
| T2 — Medium | TL → G1 → G2 → TL | 2 | CP1 + CP2 |
| T3 — Complex | TL → G1 → G2 → G3 → TL | 3 | CP1 + CP2 + CP3 |

Ghi chú `[EXT]`: "vòng" trong bảng = số **chu kỳ checkpoint (CP)** — mỗi CP là 1 vòng READ → VERIFY → UPDATE của TL. Nguồn dùng "vòng" theo nghĩa **iteration khi vận hành** ("Thời gian ước tính: ~1-2 vòng thay vì 4+" — dòng 3199 cho T1; "~2-3 vòng" — dòng 3220 cho T2): T2 ước tính 2–3 vòng vì ngoài 2 CP có thể có thêm lần TL trả lại group sửa. Hai cách đếm không mâu thuẫn — bảng trên là số chốt verify tối thiểu theo tier.

### 2.5 So sánh trước / sau khi có loop (nguồn — rút gọn) `[SRC 3759–3775]`

| Khía cạnh | Không có Loop | Có RWV |
|---|---|---|
| Phát hiện sai hướng | Cuối cùng (TL) | Sau mỗi Group (TL) |
| Phát hiện leakage | Khi LB fail | Ngay sau G2 (CP2) |
| Phát hiện claim sai (M2) | Sau approve | Ngay sau G1/G2 |
| Chi phí sửa sai | Làm lại từ đầu | Chỉ sửa Group đó |
| Token lãng phí | Cao (3Gs đều sai) | Thấp (phát hiện sớm) |
| TL control | Chỉ đầu + cuối | Liên tục qua worklog |
| Hypothesis tracking | Không có | CONFIRMED/REJECTED/PENDING |
| Metric monitoring | Chỉ ở cuối | Sau mỗi Checkpoint |
| Khả năng pivot | Không có cơ chế | Có Pivot Triggers (§6) |
| Worklog | G tự ghi | Chuẩn hóa + TL đọc lại |

## §3. 🏁 CHECKPOINT SYSTEM — KHI NÀO TL PHẢI ĐỌC LẠI `[TB-09 §3 ← nguồn dòng 3465–3521, 4593 — đồng bộ TB-02 §3.3]` `[SRC]`

### 3.1 Nguyên tắc đánh số theo khối

Research Team có **3 Checkpoint** (thay vì 4 như Code Team — vì Research chỉ có G1/G2/G3). Đánh số theo khối: **CP1 = sau G1 (Exploration & First Draft) · CP2 = sau G2 (Review & Bug Fix) · CP3 = sau G3 (Optimization) + FINAL VERIFY**.

### 3.2 CP1 — sau G1

```
┌──────────────────────────────────────────────────────────────┐
│  CHECKPOINT 1 — sau G1 hoàn thành Exploration & First Draft  │
│  TL ĐỌC: G1 worklog + Artifact Map                            │
│  VERIFY:                                                      │
│  ├── Approaches có phù hợp Research Protocol không?          │
│  ├── Hypotheses đang được kiểm tra đúng cách?                │
│  ├── Sub-agents có phát hiện insights quan trọng?            │
│  ├── M2: Findings có đủ evidence cụ thể không?               │
│  └── Direction có đúng hướng không?                          │
│  ├── YES → Cập nhật Protocol → Giao G2                       │
│  └── NO  → TL điều chỉnh → Giao lại G1                       │
│  Rationale: G1 đi sai approach → G2 fix bug vẫn sai →        │
│  G3 optimize sai approach → total waste                      │
└──────────────────────────────────────────────────────────────┘
```

### 3.3 CP2 — sau G2

```
┌──────────────────────────────────────────────────────────────┐
│  CHECKPOINT 2 — sau G2 hoàn thành Review & Bug Fix           │
│  TL ĐỌC: G2 worklog + Updated Artifact Map                   │
│  VERIFY:                                                      │
│  ├── Data leakage đã được fix chưa? (M1 Priority #1)         │
│  ├── M2: Root cause có khớp code + logs không?               │
│  ├── Code chạy đúng không? / M2: Fix proposal hợp lý?        │
│  ├── Có concerns cần TL xác nhận không?                      │
│  └── Bugs còn lại có ảnh hưởng metric không?                 │
│  ├── YES → Cập nhật Protocol → Giao G3                       │
│  ├── NO (còn CRITICAL) → Giao lại G2                         │
│  └── ESCALATE → TL quyết định                                │
│  Rationale: leakage chưa fix → G3 tối ưu vô nghĩa;           │
│  M2: root cause sai → proposal sai                            │
└──────────────────────────────────────────────────────────────┘
```

### 3.4 CP3 + FINAL VERIFY — sau G3

```
┌──────────────────────────────────────────────────────────────┐
│  CHECKPOINT 3 — sau G3 hoàn thành Optimization                │
│  TL ĐỌC: G3 worklog + Final Artifact Map + Metrics           │
│  VERIFY:                                                      │
│  ├── Metric thực sự cải thiện? (CV score so với base)        │
│  ├── CV-LB gap có trong ngưỡng an toàn? (< 0.01)             │
│  ├── M2: Mỗi proposal item có Verification Plan?             │
│  ├── Optimization có gây regression không?                   │
│  ├── Feature selection có justify không?                     │
│  └── Ensemble stable không? (std across folds)               │
│  ├── YES → FINAL VERIFY → DONE ✅                            │
│  │        (M2: → PROPOSAL → SELF-DIRECTION)                  │
│  ├── NO (metric không cải thiện) → Giao lại G3               │
│  └── NO (fundamental issue) → PIVOT về G1                    │
│  Rationale: metric không cải thiện = approach sai →          │
│  cần pivot thay vì optimize thêm                             │
└──────────────────────────────────────────────────────────────┘
```

### 3.5 Mapping tier → checkpoint `[TB-09 §3.5 ← nguồn dòng 3516–3519, 4593]` `[SRC]`

```
LƯU Ý (nguồn):
├── Tier 1: Chỉ có CP2 (TL → G2 → TL)
├── Tier 2: Có CP1, CP2 (TL → G1→G2 → TL)
└── Tier 3: Có đủ 3 Checkpoint (Full pipeline)
```

`[DECIDED v1.3 → DR-C4]` T2 có CP1 — **verify ĐẦY ĐỦ như T3** (checklist ~60% số item; 3 thành phần formal gate). Đã chốt theo DECISION-RECORD v1.3.

### 3.6 Bảng quyết định tại checkpoint `[TB-09 §3.6 ← hợp nhất nguồn dòng 3473–3514 + 3455]` `[SRC + EXT]`

| CP | KING đọc gì | Câu hỏi then chốt | Quyết định | Output bắt buộc |
|---|---|---|---|---|
| CP1 | G1 worklog + Artifact Map (+ council ② summary) | Đúng hướng? Hypotheses đúng cách? | CONTINUE → G2 · PIVOT nhỏ → giao lại G1 · ESCALATE | Protocol update + 1 dòng Decision log (TB-06 §13) |
| CP2 | G2 worklog + Updated Map (+ bugs table) | Leakage fixed? Root cause khớp code+logs? | CONTINUE → G3 · trả lại G2 (còn CRITICAL) · ESCALATE | Protocol update (hypothesis + bug status) |
| CP3 | G3 worklog + Final Map + Metrics / Proposal items + Verification Plans | Metric thật cải thiện? Mỗi item có plan? | DONE · trả lại G3 · PIVOT về G1 (fundamental) | FINAL VERIFY + Competition Summary (M1 — TB-06 §9.5) / Proposal → SELF-DIRECTION (M2) |

Tại mọi checkpoint: **council ④** diễn ra cùng lúc (TB-06 §10) + **Knowledge Capture** chạy song song (TB-08 §3) — TL vừa verify vừa chốt tri thức.

## §4. 📝 WORKLOG SCHEMA M1 & M2 `[TB-09 §4 ← nguồn dòng 3310–3319, 3577–3637, 2294–2337]` `[SRC]`

### 4.1 Template chuẩn hóa (Research Version — nguồn giữ cấu trúc)

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

### 4.2 Bảng trường schema — bắt buộc theo mission `[TB-09 §4.2 ← nguồn dòng 3313–3319 + 3577–3637]` `[SRC + EXT: cột bắt buộc]`

| Trường | M1 | M2 | Ghi chú |
|---|---|---|---|
| Header `[Timestamp] — [Group] — [Task ID]` | ✅ | ✅ | format §1.4 |
| Mission | ✅ | ✅ | quyết định verify theo metric hay evidence |
| Status (IN_PROGRESS / COMPLETED / BLOCKED / ESCALATED) | ✅ | ✅ | BLOCKED = thiếu input / hết model stack (TB-01) |
| Current Phase (G1/G2/G3) + Overall Progress % | ✅ | ✅ | TL nhìn nhanh tiến độ |
| TL Read-Back (✅ / ⚠️ / 🔴) | ✅ | ✅ | **KING ghi khi READ+VERIFY xong** (§5.4) `[EXT]` |
| Đã làm | ✅ | ✅ | items kèm metric impact (M1) / finding ref (M2) |
| Vấn đề gặp phải | ✅ | ✅ | kể cả bottleneck có bằng chứng |
| Đề xuất cho group tiếp | ✅ | ✅ | handoff §1.3 |
| Files thay đổi | ✅ | ✅ | M2: chỉ file trong Workspace |
| **Metrics** (Before/After/Delta/Status) | ✅ **bắt buộc** | qualitative | M2 không có metric số → §10 E3 |
| **Findings & Evidence** (Finding/file:line-log/Severity/Đề xuất) | — | ✅ **bắt buộc** | mọi claim phải có citation (§5.3) |
| Hypothesis Status (CONFIRMED/REJECTED/PENDING + evidence) | ✅ | khi có hypothesis | input trực tiếp của VERIFY |
| Issues Found (4 mức severity) | ✅ | ✅ | khớp severity G2 (TB-04 §4.1) |
| Suggestions cho group sau | ✅ | ✅ | G2→G3, G3→TL (nguồn 694) |
| Concerns cần TL xác nhận | ✅ | ✅ | điều group không tự quyết được |
| Research Artifact Map | ✅ | ✅ | pointer — nội dung map do TB-10 định nghĩa |
| Next Steps / Next experiments | ✅ | ✅ | đầu vào UPDATE protocol |
| KB entries mới / KB Candidates | ✅ | ✅ | TB-08: KING/SIVIL/HAN ghi entry; BELI/LISMA để candidate |
| Model note | optional | optional | dòng `model switched` (§4.3) `[EXT]` |

### 4.3 Dòng model switched `[TB-09 §4.3 ← giải [Q] mở Task 8-a; suy từ TB-00 §1.2]` `[EXT]` — ✅ DUYỆT v1.3 (DR-C7)

Khi agent chuyển model (Kimi-k3 lỗi/quá tải → fallback DeepSeek v4 Pro → DeepSeek v4 Flash → MiniMax-M3), group thêm 1 dòng vào entry worklog đang viết:

```markdown
- **Model note**: model switched Kimi-k3 → DeepSeek V4 Pro —
  lý do: [timeout / quá tải / lỗi API / quality];
  trigger: [2 probe liên tiếp vượt SLA / error-code];
  next check: [cuối task hiện tại / sau 3 probe OK thử về model chính];
  agent giữ nguyên JD + vai trò.
```

- Không reset task, không đổi quyền, mọi protocol (verify/checkpoint/KB) giữ nguyên — role-based.
- Mỗi task mới khởi động lại từ model chính Kimi-k3 (quy ước TB-01).
- Cả stack lỗi → Status = BLOCKED + ESCALATE theo TB-01 §fallback.

### 4.4 Ví dụ worklog 3 group — 2024-01-15 (giữ tinh thần nguồn 2297–2329)

Task `T-HP-002` — House Prices Part 2: Feature Engineering (M1) — 3 entry liên tiếp trong 1 pipeline T3:

```markdown
## 2024-01-15 10:30 — G1 — T-HP-002
- **Mission**: M1
- **Đã làm**: SIVIL dispatch 10 sub-agents explore features.
  BELI code: missing handler, log transform, target encoding,
  interaction features, domain features (TotalSF, BathRatio)
- **Vấn đề**: Log(0) edge case trong transform
- **Đề xuất cho G2**: Xử lý shift trước log transform
- **Files**: src/features/missing.py, transform.py, encode.py

## 2024-01-15 11:15 — G2 — T-HP-002
- **Mission**: M1
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
- **Mission**: M1
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
```

### 4.5 Đối chiếu ví dụ với schema 4.1 `[TB-09 §4.5]` `[EXT]`

| Trường schema 4.1 | Ví dụ trên | Bổ sung khi chạy thật |
|---|---|---|
| Metrics (bắt buộc M1) | G3 có CV 0.134 → 0.121 | G1/G2 thêm bảng Before/After (CP1/CP2 cần — ví dụ đầy đủ: §4.6, nguồn 3639–3757) |
| Hypothesis Status | chưa có | G1 khai H1/H2/H3 + status (nguồn 3603–3608) |
| TL Read-Back | chưa có | KING ghi sau mỗi CP (✅ VERIFIED cho cả 3 entry) |
| KB entries / Candidates | Lessons learned của G3 | chuyển thành KB entry qua TB-08 (VD category Model Training) |
| Artifact Map | Files | mở rộng theo format M1 `artifact:type:metric_impact` (TB-10) |

Ví dụ nguồn là **compact mode** (như MONITOR đọc trong TB-06 §7.5); runtime chuẩn: mọi entry qua template §4.1 — compact mode chỉ chấp nhận cho entry trung gian không phải cuối phase.

### 4.6 Ví dụ RWV loop Part 2 — TL đọc worklog tại 3 checkpoint `[TB-09 §4.6 ← nguồn dòng 3639–3757 — rút gọn; số liệu + lệnh TL UPDATE Protocol nguyên văn]` `[SRC]`

Cùng Part 2 Feature Engineering (M1) như §4.4, nhìn từ phía TL — mỗi checkpoint KING READ worklog → VERIFY → UPDATE Protocol:

| CP | Chuỗi metric (CV) | TL VERIFY (rút) | TL UPDATE Protocol |
|---|---|---|---|
| CP1 — sau G1 | **0.134 → 0.128** (-0.006) · Features 79 → 180 | CV improvement 0.006 ✅ · 180 features QUÁ NHIỀU ⚠️ → G2 cần check leak · H1 ✅ CONF / H2 🔄 TEST / H3 ❌ REJECT — H3 rejected = pivot nhỏ, bỏ domain features | Ghi: H3 REJECTED — bỏ domain features · Ghi: "G2 PHẢI check leakage cho target encoding" · Ghi: "G3 PHẢI làm feature selection (180 quá nhiều)" · Giao G2 |
| CP2 — sau G2 | **0.128 → 0.127** (-0.001 sau fix leakage) — "(CV score tăng nhẹ sau fix leakage — trước đó metric bị optimistic do leakage)" (nguyên văn nguồn) | CRITICAL leakage đã fix ✅ · CV tăng nhẹ sau fix = leakage fix đúng ✅ · 180 features vẫn nhiều → G3 cần feature selection | Ghi: "Leakage đã fix — target encoding an toàn" · Ghi: "G3 PHẢI feature selection + K-Fold encoding" · Giao G3 |
| CP3 + FINAL VERIFY — sau G3 | **0.127 → 0.121** (tổng 0.134 → 0.121, giảm 9.7%) · Std 0.008 → 0.003 · Features 180 → 72 · Runtime 45 → 22 min | CV improvement ✅ · CV Std 0.003 — RẤT stable ✅ · 72 features hợp lý cho 1460 rows ✅ · No leakage concerns ✅ | Part 2 DONE ✅ → Chuyển sang Part 3 |

- Điểm giảng dạy: metric theo CP không tuyến tính — CP2 ghi 0.128 → 0.127 là **honest score** sau khi fix leakage ("metric bị optimistic do leakage" trước đó); KING không hiểu nhầm G2 làm kết quả tệ — leakage đã được fix đúng (§6.6 PIVOT leakage).
- Lệnh UPDATE Protocol cụ thể hóa trách nhiệm group kế ("G2 PHẢI…" / "G3 PHẢI…") — Protocol là trường trong task .md (ghi chú §2.3); bản 3 box CP đầy đủ: nguồn dòng 3639–3757.

## §5. 🔍 VERIFY CHI TIẾT — BẢNG TIÊU CHÍ M1 vs M2 `[TB-09 §5 ← nguồn dòng 3448–3455, 3486–3514, 4591, 4598]` `[SRC + EXT: bảng]`

### 5.1 Tiêu chí VERIFY — M1 (5)

| # | Tiêu chí | Ngưỡng / chuẩn | Phát hiện ở |
|---|---|---|---|
| V1 | Metric cải thiện so baseline | Delta CV < 0 (tốt hơn); **WORSE → pivot 🔴** | mọi CP (CP3 chính) |
| V2 | No data leakage | leakage = Priority #1, phải fixed tại G2 (CP2) | CP2 |
| V3 | CV-LB gap | **< 0.01 an toàn · > 0.02 pivot 🔴 · < 0.005 trustworthy** | CP3 (sau submit feedback) |
| V4 | Hypothesis checked | mỗi H có status + evidence (CONFIRMED/REJECTED/PENDING) — không H nào treo không status | mọi CP |
| V5 | Stability | CV std / ensemble std across folds trong ngưỡng (std > 0.01 = 🟡 fluctuation) | CP3 |

*(✅ chốt v1.3 — §12 Q5: 0.005 = minor (ghi worklog) · 0.01 = notable (đánh giá ổn định hóa) · 0.02 = instability-warning (kiểm tra trước kết luận metric) — bảng chuẩn hóa vào Research Protocol template)*

### 5.2 Tiêu chí VERIFY — M2 (5)

| # | Tiêu chí | Câu hỏi verify | Phát hiện ở |
|---|---|---|---|
| V1 | Evidence-based | mọi claim có citation (file:line / log excerpt / metric / discussion ref)? | CP1, CP2 |
| V2 | Completeness | đủ module coverage theo Module Map / Audit Charter? | CP1 |
| V3 | Feasibility | không phá hệ đang chạy (Live System an toàn · patch chỉ trong Workspace)? | CP2, CP3 |
| V4 | Root cause khớp | root cause khớp **code + logs** (không chỉ code hay chỉ logs)? | CP2 |
| V5 | Verification Plan | mỗi proposal item kèm plan (a) kiểm chứng tay NGAY + (b) benchmark spec DEFERRED? | CP3 |

### 5.3 Evidence-based verify — chuẩn citation `[TB-09 §5.3 ← nguồn dòng 3430, 3451, 4486 + TB-04 §9.3]` `[SRC + EXT]`

- Mọi claim trong Findings / Diagnostic Report / Proposal phải trỏ về 1 trong: `file:line` (Workspace) · log excerpt (kèm timestamp + file log) · metric (bảng before/after) · discussion ref (Council Summary — TB-06 §10.2).
- **Claim thiếu evidence:** TL có 2 lựa chọn `[EXT — tổng hợp; nguồn gốc: dòng 2336 (TL đọc code key sections khi kết quả quan trọng) + dòng 4612 (TL chỉ đọc Worklog + Artifact Map, KHÔNG đọc code trừ ESCALATE / verify claim thiếu evidence) + dòng 1958 (bảng "TL đọc code khi nào?": M2 findings thiếu evidence → đọc file/log liên quan)]`: (1) trả group bổ sung evidence; (2) tự đọc **code key section**. Bảng 8 dòng + 5 nguyên tắc đọc code của TL → TB-06 §7.7.
- Claim không chứng minh được → **không được vào Proposal** (khớp TB-04 §9.3: LISMA không "điền khoảng trống" bằng phỏng đoán).

### 5.4 TL Read-Back — ghi kết quả verify vào worklog `[TB-09 §5.4 ← nguồn dòng 3587]` `[SRC + EXT: ai ghi]`

Sau READ + VERIFY, KING ghi 1 dòng vào Meta của worklog entry vừa đọc:

| Flag | Ý nghĩa | Hành động kế |
|---|---|---|
| ✅ VERIFIED | pass đủ tiêu chí §5.1/§5.2 | CONTINUE — UPDATE protocol — giao group kế |
| ⚠️ NEEDS REVIEW | thiếu thông tin / cần bổ sung nhưng chưa đến mức trả lại | ghi rõ thiếu gì; cho phép group kế chạy với điều kiện kèm |
| 🔴 PIVOT NEEDED | dính trigger §6 | PIVOT / ESCALATE theo §6.6 |

Kèm mỗi flag: 1 dòng Decision log (TB-06 §13). `[DECIDED v1.3]` KING ghi flag khi READ xong (worklog là shared artifact theo §1.2 — đề xuất được duyệt).

## §6. ⚠️ PIVOT TRIGGERS — KHI NÀO TL PHẢI ĐIỀU CHỈNH `[TB-09 §6 ← nguồn dòng 3523–3574, 4594–4597]` `[SRC]`

### 6.1 M1 — 🔴 PHẢI PIVOT ngay (5)

| # | Trigger | Phát hiện qua | Hành động |
|---|---|---|---|
| 1 | DATA LEAKAGE trong pipeline | G2 báo / TL đọc worklog | DỪNG → fix leakage → re-run từ đầu |
| 2 | CV-LB gap > 0.02 | LB feedback | CV optimistic → metric không đáng tin → pivot |
| 3 | G1 báo "Hypothesis fundamental sai" (VD: target encoding không giúp data này) | worklog G1 CP1 | bỏ hướng — pivot hypothesis |
| 4 | TL đọc worklog thấy "Metric WORSE sau optimization" | CP3 | approach sai — không optimize thêm |
| 5 | G3 ESCALATE "Overfitting nghiêm trọng — không fix được trong G3 scope" | escalation G3 | vượt scope — TL quyết |

### 6.2 M2 — 🔴 PHẢI PIVOT ngay (3)

| # | Trigger | Hành động |
|---|---|---|
| 1 | Claim trong findings THIẾU EVIDENCE | re-audit với yêu cầu citation (§5.3) |
| 2 | Code mâu thuẫn logs | root cause sai → chẩn đoán lại (trả G2) |
| 3 | Proposal có thể phá compatibility hệ thống | khóa nộp — yêu cầu System Safety assessment (TB-04 §9.4) |

### 6.3 M1 — 🟡 CÓ THỂ PIVOT (6)

| # | Trigger |
|---|---|
| 1 | Model plateau: 3 lần tuning không cải thiện > 0.001 |
| 2 | G3 suggest: "Approach khác (VD: NN) có thể tốt hơn" |
| 3 | Metric fluctuation: CV score không stable (std > 0.01) |
| 4 | Feature engineering không hiệu quả: improvement < 0.003 |
| 5 | Public LB feedback cho kết quả khác kỳ vọng |
| 6 | G2/G3 suggest thay đổi approach |

### 6.4 M2 — 🟡 CÓ THỂ PIVOT (3)

| # | Trigger |
|---|---|
| 1 | Scope creep — audit lan rộng hơn yêu cầu |
| 2 | Nghiên cứu trùng lặp (đã có proposal tương tự) |
| 3 | POC không tái hiện được |

### 6.5 🟢 KHÔNG CẦN PIVOT (giữ ngưỡng nguồn)

Bugs nhỏ G2 đang fix trong loop · G3 minor tuning (±0.001) · progress đúng kế hoạch, metric cải thiện ổn định · G2 notes edge cases trong tầm kiểm soát · CV-LB gap < 0.005 (trustworthy) · M2: findings minor, không ảnh hưởng proposal chính.

### 6.6 HÀNH ĐỘNG SAU PIVOT (nguồn 3564–3574)

| Loại | Hành động | Ví dụ nguồn |
|---|---|---|
| PIVOT nhỏ | TL điều chỉnh hypothesis → giao lại G đó | "H1 fail → thử H1-alt: frequency encoding" |
| PIVOT lớn | TL viết lại Research Protocol → G1 lại từ đầu | "GBM không hiệu quả → thử Neural Net" · M2: "Audit sai layer → viết lại Audit Charter" |
| PIVOT leakage | G2 deep audit → re-run G1/G2/G3 | "Target encoding leak → fix + re-train tất cả" |
| ESCALATE | TL dừng pipeline → báo user → chờ quyết định | "Data quality quá kém → cần thêm data" |

## §7. 🧭 TL = RESEARCH LOOP CONTROLLER `[TB-09 §7 ← nguồn dòng 3399–3416]` `[SRC]`

### 7.1 Nguyên lý

TL của Research Team = **Research Director** quản lý vòng lặp nghiên cứu — khác Code Team TL quản lý vòng lặp phát triển:

| CODE TEAM TL | ←→ | RESEARCH TEAM TL |
|---|---|---|
| Kiểm tra: code đúng spec? | | Kiểm tra: metric cải thiện? |
| Verify: compile, test pass | | Verify: CV score, no leak |
| Pivot khi: arch sai | | Pivot khi: data leakage |
| Update: .md implementation spec | | Update: Research Protocol |
| Đọc: Code Location Map | | Đọc: Research Artifact Map |
| Trọng tâm: ĐÚNG (correctness) | | Trọng tâm: TỐT (metric) |
| | | (M2: verify evidence-based · pivot khi claim mâu thuẫn logs/code · update System Audit Charter) |

### 7.2 [EXT] State diagram — vòng loop theo checkpoint (T3)

```
        ASSIGN task .md (council ① LOCKED — TB-07 §8)
           │
           ▼
   ┌── G1 WORK ── WRITE worklog+Map ── READ ── CP1 ── VERIFY ──┐
   │            (KING đọc worklog)            │                 │
   │                                          │                 │
   │   CONTINUE ── UPDATE protocol ───────────┤                 │
   │   PIVOT nhỏ ── UPDATE ── giao lại G1 ────┤                 │
   │   PIVOT lớn ── viết lại Protocol ────────┴──▶ về đầu G1    │
   │                                                          │
   │   (T2/T3) G2 WORK ── WRITE ── READ ── CP2 ── VERIFY ──┐   │
   │        CONTINUE ── UPDATE ──▶ G3                       │   │
   │        NO (CRITICAL) ──▶ giao lại G2                   │   │
   │        ESCALATE ──▶ TL quyết                           │   │
   │                                                        │   │
   │   (T3) G3 WORK ── WRITE ── READ ── CP3 + FINAL VERIFY │   │
   │        YES ──▶ DONE ✅ (M2: PROPOSAL → SELF-DIRECTION) │   │
   │        NO (metric) ──▶ giao lại G3                     │   │
   │        NO (fundamental) ──▶ PIVOT về G1                │   │
   │        ESCALATE ──▶ dừng ──▶ báo user                  │   │
   └────────────────────────────────────────────────────────┘
```

### 7.3 Nghĩa vụ của controller `[TB-09 §7.3 ← suy từ nguồn dòng 3399–3462]` `[EXT]`

| # | Nghĩa vụ | Vi phạm = |
|---|---|---|
| C1 | Research Protocol (trong task .md) là North Star — mọi VERIFY so với nó | verify theo "cảm giác" |
| C2 | Mỗi vòng kết thúc bằng 1 dòng Decision log (TB-06 §13) | mất vết audit |
| C3 | Mọi PIVOT phải truy được trigger cụ thể (§6) | pivot tùy hứng |
| C4 | Không để 2 vòng liên tiếp không READ (loop hỏng — mất chức năng phát hiện sớm) | quay về pipeline 1 chiều |
| C5 | ESCALATE = dừng + báo user + chờ — không tự ý chạy tiếp phần khác của task đó | vượt quyền phê duyệt |

## §8. 👁️ AI ĐỌC ARTIFACT NÀO Ở CHECKPOINT NÀO `[TB-09 §8 ← nguồn dòng 4600–4613 + 3780+]` `[EXT]`

| Vai trò | Thời điểm | Đọc gì | KHÔNG đọc gì |
|---|---|---|---|
| **KING** (TL) | mọi CP | worklog + Research Artifact Map (+ Metrics / Findings) | code — trừ ESCALATE hoặc verify claim thiếu evidence (§5.3) |
| **SIVIL** (G1) | trước khi nhận part | task .md + Artifact Map + worklog parts trước; M2: Module Map (TB-03 §6) | code chi tiết của parts trước — qua Map |
| **BELI** | bắt đầu code | SPEC + Artifact Map vùng liên quan | — |
| **LISMA** (G2) | bắt đầu G2 | **Leakage/Bug Locations (M1) / Suspect Locations (M2)** từ Map — selective, safety-first, Priority #1 | happy paths trước error paths (TB-04 §5.3) |
| **HAN** (G3) | bắt đầu G3 | **Metric Impact Chain (M1) / Impact Chain (M2)** — wider, metric-driven | — |

Quy tắc nguồn (dòng 4613): mỗi G **PHẢI ghi Artifact Map khi xong + PHẢI đọc Map khi bắt đầu + artifact mới → Update Map ngay**. Chi tiết chiến lược đọc từng role + format artifact M1/M2 → **TB-10**.

## §9. 🔁 TASK STATUS LIFECYCLE + VERSIONING `[TB-09 §9 ← suy từ nguồn dòng 3295, 3584 + TB-06 §12]` `[EXT]`

### 9.1 Diagram lifecycle

```
NEW ──ASSIGN──▶ ASSIGNED ──group nhận+đọc Map──▶ IN_PROGRESS
   │                                              │
   │                        group xong phase ──WRITE worklog──▶ CHECKPOINT
   │                                              │               │
   │                       ◀──CONTINUE── UPDATE ──┤   CONTINUE ────┤
   │                        (giao group kế)       │               ├─PIVOT──▶ IN_PROGRESS
   │                                              │               │          (giao lại group,
   │                                              │               │           task .md v+1)
   │                                              │               └─ESCALATE─▶ ESCALATED
   │                                              │                              (dừng, chờ user)
   │                          CP3 + FINAL VERIFY pass ──▶ DONE ✅  │
   │                    bất kỳ phase: thiếu input/hết model stack ─┴─BLOCKED
```

### 9.2 Bảng transition

| From | Event | To | Action | Artifact sinh ra |
|---|---|---|---|---|
| NEW | KING viết task .md + council ① LOCKED | ASSIGNED | giao theo routing tier (TB-02 §5) | task .md v1 |
| ASSIGNED | group nhận, đọc Map, bắt đầu | IN_PROGRESS | — | — |
| IN_PROGRESS | group xong phase → WRITE | CHECKPOINT | TL READ + VERIFY | worklog entry + Artifact Map update |
| CHECKPOINT | verify pass, còn group kế | CONTINUE → ASSIGN group kế | UPDATE protocol | protocol update + Decision log |
| CHECKPOINT | verify pass, CP3 + FINAL VERIFY | DONE | FINALIZE (TB-06 §9) | Competition Summary M1 / Proposal M2 |
| CHECKPOINT | verify fail nhỏ / trigger 🟡 | PIVOT → IN_PROGRESS | giao lại group; task .md changelog v+1 (§9.4) | changelog + Decision log |
| CHECKPOINT | trigger 🔴 nghiêm trọng / bế tắc | ESCALATED | dừng + báo user + chờ | Decision log ESCALATE |
| ESCALATED | user quyết định | IN_PROGRESS / DONE / hủy | ghi quyết định user | Decision log |
| (bất kỳ) | thiếu input / cả model stack lỗi | BLOCKED | báo KING; KING gỡ hoặc ESCALATE | worklog entry BLOCKED |

### 9.3 Đối chiếu 3 bộ status (nguồn vs lifecycle)

| Task .md (nguồn 3295) | Lifecycle TB-09 §9.1 | Worklog Status (§4.1) | Ai ghi |
|---|---|---|---|
| Pending | NEW + ASSIGNED | — | KING |
| In-Progress | IN_PROGRESS | IN_PROGRESS | group |
| Review | CHECKPOINT (từng phase) | — (không có trạng thái Review) | KING verify |
| Done | DONE | COMPLETED | KING + group |
| — | ESCALATED | ESCALATED | KING |
| — | BLOCKED | BLOCKED | group |

### 9.4 Versioning task .md khi pivot — append, KHÔNG rewrite

`[TB-09 §9.4 ← liên quan TB-06 §16 Q4 + TB-07 §11 Q4]` `[EXT + DECIDED v1.3]`

- **Quy tắc đề xuất:** KHÔNG rewrite các block gốc (Mô tả/Input/Output kỳ vọng/Constraints). Thêm/append 1 section `## Changelog` ở cuối file; dòng thay thế trong block gốc được đánh dấu `[SUPERSEDED vN]` — không xóa.

```markdown
## Changelog
- [2025-06-12] v2 — PIVOT tại CP2 (trigger §6.1 #1: data leakage target
  encoding). H1 → H1-alt (frequency encoding). Constraints thêm "MUST
  K-Fold encoding". Quyết định: D-014 (Decision log — TB-06 §13).
```

- Version hiện tại = số dòng changelog; task đang chạy luôn tham chiếu "task .md vN".
- `[DECIDED v1.3 → DR-C3]` **append-only** — đã chốt một lần cho cả 3 file (TB-06/TB-07/TB-09); task .md có `version` + `## CHANGELOG`.

## §10. 🧯 ERROR HANDLING & EDGE CASES `[TB-09 §10 ← mở rộng từ nguồn dòng 1746, 3460, 4612, 4613 + quy ước TB-01]` `[EXT]`

| # | Tình huống | Phát hiện | Phản ứng chuẩn |
|---|---|---|---|
| E1 | Worklog M2 có claim thiếu evidence | VERIFY V1 fail (§5.2) | trả group bổ sung evidence; TL không tự điền; 2 lần thiếu → coi claim sai, loại khỏi report |
| E2 | Worklog thiếu trường bắt buộc (Metrics M1 / Findings M2) | TL READ thấy thiếu | trả lại group bổ sung entry — protocol là bất biến, không phải gợi ý |
| E3 | Task M2 không sinh được metric định lượng | tự nhiên (M2 ít số liệu) | dùng qualitative evidence: log excerpt before/after, bảng Performance Baselines (KB — TB-05 §5.1); vẫn phải evidence-based, không "cảm giác nhanh hơn" |
| E4 | Group xong nhưng không cập nhật Artifact Map | CP check | không giao group kế (quy tắc nguồn 4613) — bắt buộc bổ sung Map rồi mới CONTINUE |
| E5 | Checkpoint trễ / group treo (không có worklog mới) | MONITOR thiếu entry | KING nhắc qua DECIDE; treo quá ngưỡng → ESCALATE user `[DECIDED v1.3: nhắc 1 CP / treo 2 CP → ESCALATE — §12 Q3]` |
| E6 | PIVOT lặp ≥ 2 lần lớn trên cùng 1 part | Decision log | ESCALATE user (khớp TB-06 E8) — dấu hiệu decompose sai hoặc bài toán ngoài khả năng |
| E7 | Model fallback giữa phase | dòng model switched (§4.3) | task KHÔNG reset; role giữ nguyên; model reset về Kimi-k3 ở task mới |
| E8 | Task status mâu thuẫn worklog (task .md Done nhưng worklog ESCALATED) | KING đọc | worklog là chuẩn trạng thái chạy; đồng bộ task .md qua changelog (§9.4) |
| E9 | Mission lẫn giữa chừng (task M1 sinh findings hệ thống / M2 sinh output kiểu Kaggle) | CP verify thấy loại output sai mission | quay CLASSIFY (TB-06 §2.5); không trộn output 2 mission trong 1 task |
| E10 | KB Candidates trong worklog không ai duyệt sau 2 checkpoint | KING MONITOR | SLA TB-08 §8 K4 — KING xử lý bắt buộc tại checkpoint kế |
| E11 | ESCALATED chờ user quá lâu | pipeline đứng | pipeline task đó dừng toàn phần; parts khác độc lập vẫn chạy được `[DECIDED v1.3 → DR-C5: 48h/24h + nhắc 12h + deputy approver SIVIL/HAN (TB-06 §16 Q7)]` |
| E12 | M2 cần POC nhưng Workspace chưa mở (user chưa mở bản clone) | part Design/Propose cần chạy POC (VD Part 3 — TB-07 §5) | evidence vẫn chạy (đọc Live System); POC hoãn + Proposal đánh cờ `POC-NEEDS-WORKSPACE` (quy ước TB-02 §6; xử lý chi tiết: TB-06 §14 E7 + TB-07 §9 E7; ghi chú ASSIGN task M2 — TB-06 §6.7) |

## §11. ✅ ACCEPTANCE CRITERIA `[TB-09 §11]`

- [ ] AC1 — Template task .md giữ đúng 4 block nguồn (Mô tả/Input/Output kỳ vọng/Constraints) + bảng phân vai điền; tham chiếu TB-07 §3 hợp lệ (§1).
- [ ] AC2 — Format worklog chuẩn `[Timestamp] — [Group] — [Task ID]` + 5 trường nguồn; M2 Files chỉ Workspace (§1.4).
- [ ] AC3 — Handoff flow 4 mũi tên giữ nguyên + bảng điều kiện handoff (CP pass trước khi group kế chạy) (§1.3).
- [ ] AC4 — RWV 4 bước WRITE/READ/VERIFY/UPDATE đủ nội dung nguồn, kèm bảng chi tiết bắt buộc (§2.3).
- [ ] AC5 — READ: Metrics/Findings trước + token ~1–2K; VERIFY: quyết định CONTINUE/PIVOT/ESCALATE (§2.3).
- [ ] AC6 — 3 checkpoint đúng vị trí + nội dung VERIFY đúng nguồn + Rationale (§3.2–§3.4).
- [ ] AC7 — Mapping tier: T1: CP2 · T2: CP1+CP2 · T3: đủ 3 — khớp TB-02 §3.3 và nguồn dòng 4593 (§3.5).
- [ ] AC8 — Worklog schema M1/M2 đủ trường; cột bắt buộc đúng mission (Metrics M1 · Findings & Evidence M2) (§4.1–§4.2).
- [ ] AC9 — Ví dụ 3 group 2024-01-15 (10:30 G1 / 11:15 G2 / 12:00 G3) giữ tinh thần nguồn + bảng đối chiếu schema + ví dụ RWV loop Part 2 theo checkpoint (§4.4–§4.6).
- [ ] AC10 — Bảng verify M1 (5) + M2 (5); CV-LB gap 3 ngưỡng đúng: < 0.005 trustworthy · < 0.01 an toàn · > 0.02 pivot (§5).
- [ ] AC11 — Pivot triggers đủ: M1 🔴 (5) + M2 🔴 (3) + M1 🟡 (6) + M2 🟡 (3) + 🟢 + 4 hành động sau pivot (§6).
- [ ] AC12 — TL Read-Back 3 mức (✅/⚠️/🔴) + ai ghi + hành động kế (§5.4).
- [ ] AC13 — Bảng CODE TEAM TL vs RESEARCH TEAM TL giữ nguồn + state diagram loop theo checkpoint + 5 nghĩa vụ controller (§7).
- [ ] AC14 — Bảng "ai đọc artifact nào" đủ 5 role + quy tắc Map bắt buộc (§8).
- [ ] AC15 — Lifecycle đủ trạng thái + bảng transition + versioning append-only + quyết định [DECIDED v1.3] đồng bộ TB-06/TB-07 (§9).
- [ ] AC16 — ≥ 10 error & edge cases với phản ứng chuẩn, không mâu thuẫn TB-01/TB-06/TB-08 (§10).

## §12. DECISIONS — [Q] ĐÃ CHỐT (v1.3)

*(mọi [Q] của file đã chốt theo DECISION-RECORD-v1.3.md — cụm chéo C1–C7 + quyết định riêng TB-09; bảng dưới giữ nguyên văn câu hỏi gốc kèm giá trị đã chốt)*

| # | Câu hỏi | ✅ QUYẾT ĐỊNH (chốt v1.3) | Liên quan |
|---|---|---|---|
| Q1 | T2 có CP1 — verify đầy đủ như T3 hay quick-check? (nguồn 3518 liệt kê CP, không nêu độ sâu — flow 3208 không thể hiện CP1) | ✅ DR-C4 — T2 CP1 verify ĐẦY ĐỦ như T3 (checklist ~60% số item). | kế thừa TB-01/TB-02 |
| Q2 | Versioning task .md: append changelog (đề xuất §9.4) hay rewrite? | ✅ DR-C3 — **APPEND-ONLY** (changelog + version; KHÔNG rewrite). | TB-06 §16 Q4 · TB-07 §11 Q4 |
| Q3 | Timeout group treo + timeout ESCALATED chờ user (đề xuất: nhắc 1 CP, treo 2 CP → ESCALATE) | ✅ DR-C5 — nhắc 1 CP / treo 2 CP → ESCALATE; ESCALATED chờ user 48h (M1) / 24h (M2), nhắc 12h. | TB-06 §16 Q7 · §10 E5 |
| Q4 | Số vòng tối đa re-run 1 group trước khi buộc PIVOT lớn / ESCALATE (nguồn không nêu — đề xuất: 2 vòng trả lại → PIVOT; 3 vòng → ESCALATE) | **2 vòng trả lại → PIVOT; 3 vòng → ESCALATE** (giữ đề xuất). | §6.6 |
| Q5 | 3 ngưỡng CV-LB gap (0.005 / 0.01 / 0.02) — có cần bảng chuẩn hóa trong Research Protocol template? | **CÓ — bảng chuẩn hóa 0.005 minor / 0.01 notable / 0.02 instability-warning** vào Research Protocol template. | §5.1 |
| Q6 | Format dòng model switched (§4.3) — user duyệt dạng chuẩn? | ✅ DR-C7 — **duyệt format §4.3** + thêm 2 trường `trigger` + `next check` (giải trọn [Q] Task 8-a). | giải [Q] Task 8-a |
| Q7 | M2-T1 (verify-only, không qua pipeline 3 group) có cần vòng RWV rút gọn + Proposal 1-item? | ✅ DR-C1 — verify thuần túy: Verify-Report mini + KB entry, không Proposal; có đề xuất → mini-RWV + Proposal 1-item. | TB-11 |
| Q8 | Ai ghi TL Read-Back (đề xuất: KING ghi khi READ xong) — worklog là shared artifact? | **KING ghi khi READ xong** (worklog shared artifact §1.2). | §5.4 |

## PHỤ LỤC A — TRACEABILITY MATRIX

| Section nguồn (dòng) | Nội dung nguồn | Section TB-09 | Mức |
|---|---|---|---|
| 3285–3308 | Cấu trúc file .md cho task | §1.1 | [SRC] |
| 3310–3319 | Cấu trúc worklog + format header | §1.4, §4.1 | [SRC] |
| 3321–3337 | Handoff flow G1→G2→G3→TL | §1.3 | [SRC] |
| 3343–3365 | Vấn đề pipeline 1 chiều (M1 + M2) | §2.1 | [SRC] |
| 3367–3396 | Pipeline có RWV loop | §2.2 | [SRC] |
| 3399–3416 | TL = Research Loop Controller + bảng CODE vs RESEARCH | §7.1 | [SRC] |
| 3418–3462 | 4 bước RWV (WRITE/READ/VERIFY/UPDATE) | §2.3 | [SRC] |
| 3465–3521 | 3 Checkpoint Schedule + mapping tier | §3 | [SRC] |
| 3523–3574 | Pivot Triggers 🔴🟡🟢 + hành động sau pivot | §6 | [SRC] |
| 3577–3637 | Worklog chuẩn hóa Research Version | §4.1–§4.2 | [SRC] |
| 3639–3757 | Ví dụ RWV loop Part 2 — TL đọc tại 3 CP (số liệu theo CP + lệnh TL UPDATE Protocol) | §4.6 | [SRC] |
| 3759–3775 | So sánh trước/sau có loop | §2.5 | [SRC] |
| 2294–2337 | Ví dụ worklog 3 group 2024-01-15 (MONITOR) | §4.4 | [SRC] |
| 4585–4598 | Bảng ghi chú RWV/Checkpoint/Pivot/Verify M2 | §2.3, §3.5, §6, §5.2 | [SRC] |
| 4600–4613 | Chiến lược đọc TL/G2/G3 + quy tắc Artifact Map | §8 | [SRC] |
| 1393–1395 | Verification Plan (a)/(b) của proposal item | §5.2 V5 | [SRC] |
| 4426–4515 | Ví dụ M2 "chat TMO chậm" — TL verify claim thiếu evidence (dòng 4486) | §5.3 | [SRC] |
| TB-00 §1.2 / TB-01 | Model stack + fallback role-based | §4.3 | [EXT] |
| TB-02 §3.3 / TB-03 §4.4 / TB-06 §7·§10·§13 / TB-07 §3·§8 / TB-08 / TB-10 / TB-11 | Tham chiếu ngang | §0, §3, §7, §8, §9, §12 | [EXT] |
| 3295, 3584 (suy) | Task Status lifecycle + versioning | §9 | [EXT] |
| suy từ nguồn + kinh nghiệm Task 8 | Error & edge E1–E12 | §10 | [EXT] |
