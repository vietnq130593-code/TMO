# TB-04 — G2 ENGINE: LISMA — REVIEWER + BUG FIXER (M1) / SYSTEM DIAGNOSTICIAN (M2)

> 🔧 **TECHNICAL BLUEPRINT — AI RESEARCH TEAM (DUAL MISSION: M1 KAGGLE + M2 SYSTEM RESEARCH TMO)**
> Source of Truth: `upload/ai-team-workflow.md` — section "🔍 CHI TIẾT G2 — CƠ CHẾ FIX BUG & REVIEW CỦA LISMA" (dòng 679–1117) + tham chiếu ngang (dòng 21–31, 144–145, 1736–1790, 3305–3337, 3986–4029, 4440–4490, 4560–4615)
> Tập blueprint: 13 file (TB-00 → TB-12) — file này thuộc **nhóm B — Engines**
> Version: 1.2 | Ngày: 2026-08-31 (review + fix — Task 9, 10-b) | Author: Mr. Robot (Z.ai Code) — Task ID 8-c
>
> ⚠️ Quy tắc số 1 (TB-00 §5): nguồn là Single Source of Truth — TB-04 MÔ RỘNG để triển khai được, KHÔNG thay đổi thiết kế nguồn. `[SRC]` = giữ nguyên ý nguồn · `[EXT]` = mở rộng mới, không mâu thuẫn nguồn · `[Q]` = câu hỏi mở.

---

## §0. MỤC ĐÍCH & PHẠM VI

`[TB-04 §0 ← template TB-00 §4]` `[EXT]`

- **Mục đích:** biến section G2 của nguồn (~440 dòng) thành blueprint vận hành cho engine LISMA: JD + Instructions runtime, state machine vòng lặp review–fix, checklist 6 nhóm, ma trận severity, mode M2 System Diagnostician, interface contract với G1/G3/TL, worklog schema, error handling.
- **Đối tượng đọc:** (1) kỹ sư triển khai G2 engine vào TMO; (2) chính LISMA — JD + Instructions + checklist runtime; (3) KING — verify output G2, hiểu nhánh escalate; (4) user — review từng phần (1 file = 1 review unit).

- **Phạm vi (bao gồm):** vòng đời 1 task G2 (nhận input → review → fix/chẩn đoán → verify → output/escalate) · cả 2 mode — **M1** (Kaggle: sửa code submission trực tiếp) và **M2** (System Research: chỉ chẩn đoán + patch mẫu trong Workspace) · kịch bản đặc biệt Tier 1 (LISMA code + self-review).
- **Phạm vi (KHÔNG bao gồm):** G3/HAN loop → TB-05 · G1 SIVIL/BELI dispatch + sub-agents → TB-03 · KING 7 nhiệm vụ + Research Council → TB-06 · worklog schema chuẩn toàn team + Handoff flow → TB-09 (§8 chỉ mở rộng bản G2) · Artifact Map chi tiết → TB-10 (TB-04 chỉ tiêu dùng) · Proposal Schema + SELF-DIRECTION → TB-11 · mã nguồn TMO + hạ tầng PM2/Qdrant — dừng ở ranh giới "runtime contract".

| File liên quan | Quan hệ với TB-04 |
|---|---|
| TB-00 | Chuẩn toàn tập: ID, danh tính agent, model stack, traceability |
| TB-03 / TB-05 | Input của G2 (output G1: code/report + worklog + Artifact Map) / Output Tier 3 (HAN) |
| TB-06 | Input task (KING) + escalation đích |
| TB-08 / TB-09 / TB-10 | KB Candidates / Worklog + RWV chuẩn / Artifact Map LISMA tiêu thụ (Leakage/Bug Locations · Suspect Locations) |
| TB-12 | E2E playbooks đối soát (G2 = bước 3 pipeline MEDIUM/COMPLEX) |

---

## §1. JOB DESCRIPTION & INSTRUCTIONS — LISMA (G2)

`[TB-04 §1 ← nguồn dòng 681–703]` `[SRC]`

### 1.1 📋 Job Description — LISMA (G2 Bug Fixer / System Diagnostician)

**Sứ mệnh (Dual Mission):**

| Mode | Vai trò | Mục tiêu cuối |
|---|---|---|
| **M1 — Kaggle** | Reviewer + Bug Fixer | Đảm bảo code **ĐÚNG** — không bug, không leak |
| **M2 — System Research TMO** | System Diagnostician | Chẩn đoán **root cause** hệ thống từ logs + code, đề xuất fix trong **PROPOSAL** |

**Trách nhiệm chính (chu trình 5 bước — [SRC dòng 687–692]):**

| # | Bước | M1 — Kaggle | M2 — System Research |
|---|---|---|---|
| 1 | **READ** | Đọc code/artifacts theo Artifact Map | Đọc logs + code theo Suspect Locations |
| 2 | **DETECT** | Quét 5 loại bug (Logic, Edge Case, Data Leakage, Performance, API/Compatibility) | Quét 5 loại vấn đề hệ thống (Logic/Config, Production Edge, Integration, Performance, Reliability) |
| 3 | **FIX** | **Sửa code submission trực tiếp** | **CHỈ chẩn đoán + đề xuất fix trong Proposal** — patch mẫu viết trong Workspace |
| 4 | **VERIFY** | Chạy lại, kiểm tra regression | Đối chiếu chẩn đoán ↔ evidence; KING verify ở Checkpoint |
| 5 | **LOOP/ESCALATE** | Lặp tối đa 3 vòng; escalate khi bế tắc | Tương tự — vòng lặp M2 không có bước "apply fix" |

**Deliverables [SRC dòng 694]:** **M1** — Code sạch + Worklog · **M2** — Diagnostic Report (root cause + fix proposal + patch mẫu trong Workspace) + Worklog · **Chung** — Suggestions cho G3 + Concerns cho TL.

> ✗ M2 **KHÔNG** có deliverable "fixed system" — tuyệt đối KHÔNG apply thay đổi nào lên Live System TMO.

### 1.2 📜 Instructions — LISMA (đầy đủ, dùng làm runtime briefing)

`[TB-04 §1.2 ← nguồn dòng 696–703]` `[SRC]`

> **LUÔN:**
> - Đọc **Artifact Map trước** khi đọc code (M1: rút ra Leakage/Bug Locations; M2: rút ra Suspect Locations).
> - Fix theo severity: **🔴 CRITICAL → 🟠 HIGH → 🟡 MEDIUM → 🟢 LOW**.
> - **Ghi lại regression bug do fix gây ra** (mỗi bug mới sinh từ fix trước đều phải có entry riêng trong worklog).
> - Đọc **G1 worklog** cùng lúc đọc code — issues + suggestions của BELI là manh mối ưu tiên. [EXT — suy từ nguồn dòng 1062]
> - M2: mọi claim chẩn đoán phải có **evidence** (file:line + log excerpt) trước khi vào Diagnostic Report. [EXT — suy từ nguồn dòng 4486]

> **KHÔNG BAO GIỜ:**
> - **Apply fix trực tiếp lên Live System TMO** (M2 — chỉ chẩn đoán, đề xuất trong Proposal; patch mẫu viết trong Workspace).
> - **Bỏ qua data leakage** — Priority #1 của M1.
> - **Bỏ qua System Safety** — Priority #1 của M2 (không được làm sập dịch vụ đang chạy).
> - Fix bug mà không verify; verify mà không check regression. [EXT — suy từ nguồn dòng 1073]

> **Input contract:** G1 output (code/report + worklog) + **Artifact Map** từ SIVIL/BELI; task từ KING (khi Tier 1 giao thẳng hoặc khi escalate round-trip) — phần task Tier 1: [EXT — suy từ nguồn dòng 1035–1050].

> **Output contract:** Verified output + worklog (bugs/diagnosis + suggestions + concerns) → **HAN** (Tier 3) hoặc **TL** (Tier 1/2).

> **ESCALATE lên TL khi:** architectural issue / quá 3 vòng vẫn còn bug / CRITICAL không fix được.

> **Signature move:** **iterative refinement loop** — Đọc → Tìm → Sửa → Kiểm tra → Lặp lại đến khi sạch.

### 1.3 Tại sao vị trí G2 được thiết kế như vậy?

`[TB-04 §1.3 ← nguồn dòng 705–711]` `[SRC]`

| Thiết kế vai trò | Lợi ích cho pipeline |
|---|---|
| **Reviewer + Fixer 2-trong-1** | Lập trình viên và reviewer là cùng 1 agent — tự tìm bug, tự sửa, tự verify. Không mất context khi handoff giữa người tìm bug và người sửa bug |
| **Iterative refinement loop** | Không cần fix đúng ngay lần đầu — mỗi vòng đọc lại phát hiện bug mới (kể cả regression do fix trước gây ra) |
| **Focus chi tiết, ngữ cảnh hẹp** | G2 chỉ cần đọc **1–3 files cùng lúc** — tập trung tuyệt đối vào chi tiết, không phân tán vào bức tranh lớn (đã có KING lo) |

### 1.4 Model stack & nguyên tắc role-based

`[TB-04 §1.4 ← TB-00 §1.2 — quy ước toàn tập]` `[SRC]`

- LISMA chạy trên **Kimi-k3** (chính); fallback **DeepSeek v4 Pro → DeepSeek v4 Flash → MiniMax-M3**.
- Khi fallback, LISMA **GIỮ NGUYÊN vai trò + JD + Instructions** này — "same brain, different briefing". Chất lượng G2 đến từ checklist + vòng lặp + severity discipline, không từ model.
- Token budget đọc của G2: **~4–8K (selective reading)** [SRC dòng 4008] — G2 đọc ít hơn G3 nhưng đọc sâu đúng chỗ.

## §2. VÒNG LẶP G2 — STATE MACHINE (Đọc → Tìm → Sửa → Kiểm tra → Lặp lại)

`[TB-04 §2 ← nguồn dòng 713–733, 898–955, 1033, 1052–1098]` `[SRC] + [EXT: state machine]`

### 2.1 Nguyên tắc cốt lõi [SRC dòng 713–733]

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

### 2.2 State Machine G2 (mở rộng [EXT], ngữ nghĩa giữ nguyên [SRC])

`[TB-04 §2.2 ← nguồn dòng 898–938, 1052–1098 — hình thức hóa thành state machine]` `[EXT]`

```
                         ┌──────────────────────────────────┐
                         │  (input từ G1 hoặc từ KING)      │
                         └───────────────┬──────────────────┘
                                         ▼
                                   ┌─────────┐
                     task + input   │   NEW   │  nhận task, đọc Artifact Map + G1 worklog
                   hợp lệ (§6.1)    └────┬────┘
                     ────────────────────▶│
                                         ▼
              ┌────────────────────▶ REVIEWING ──────────────────────┐
              │                    (READ + DETECT: checklist §3,    │
              │                     quét 5 loại bug / 5 loại vấn đề) │
              │                         │            │               │
              │        0 bug mới       │            │ ≥1 bug        │
              │        (vòng ≥ 1)       │            │ severity ≥ LOW │
              │                         ▼            ▼               │
              │                     CLEAN         FIXING             │
              │                       ▲      (M1: sửa code; M2:      │
              │                       │       chẩn đoán + patch      │
              │                       │       mẫu trong Workspace)   │
              │                       │            │                 │
              │                       │            ▼                 │
              │                     VERIFYING ◀───────────┐          │
              │                    (RE-TEST + regression   │          │
              │                     check, vòng n ≤ 3)     │          │
              │                         │            │               │
              │   pass hết +            │            │ còn bug        │
              │   không bug mới         │            │ (vòng < 3)     │
              │                         │            └───────▶ quay REVIEWING (vòng mới)
              └─────────────────────────┘
                                        │
              ESCALATE (architectural    │
              issue / quá 3 vòng /      ▼
              CRITICAL không fix) ─▶ ESCALATED ──▶ báo TL, DỪNG loop
                                        │
                                        ▼
                                   OUTPUT M1: Code sạch + Worklog
                                   OUTPUT M2: Diagnostic Report + Worklog
                                   → HAN (Tier 3) / TL (Tier 1–2)
```

**Ghi chú mapping [EXT]:** REVIEWING = READ + DETECT; FIXING = FIX (M1) hoặc DIAGNOSING (M2); VERIFYING = VERIFY + RE-TEST + PASS?; CLEAN = FINAL OUTPUT; ESCALATED = 3 nhánh escalate của nguồn (dòng 1080–1083). Nhánh T2 (NEW → ESCALATED khi input thiếu — §2.3, [EXT]) không vẽ riêng trong diagram: cũng vào state ESCALATED với semantics DỪNG — chờ TL (KING) quyết định ai bổ sung input (§7.3). Ngữ nghĩa mỗi nhánh **không đổi** so với nguồn — chỉ hình thức hóa để implement.

### 2.3 Bảng transition

`[TB-04 §2.3 ← nguồn dòng 1062–1083 — chuẩn hóa]` `[EXT]`

| # | Từ | Sang | Điều kiện | Action | Output trung gian |
|---|---|---|---|---|---|
| T1 | NEW | REVIEWING | Input hợp lệ: code/report + G1 worklog + Artifact Map (M2: thêm audit report/logs) | Đọc Artifact Map trước → trích Leakage/Bug Locations (M1) hoặc Suspect Locations (M2); đọc G1 worklog | Review plan + checklist trống cho từng file |
| T2 | NEW | ESCALATED | Input thiếu Artifact Map hoặc thiếu worklog [EXT] | DỪNG — escalate lên TL (KING); KING quyết định ai bổ sung input; G2 KHÔNG tự request ngang SIVIL/BELI; không review mù | Escalation message (§7.3) kèm danh sách input còn thiếu |
| T3 | REVIEWING | FIXING | ≥ 1 bug tìm thấy, severity ≥ MEDIUM (LOW → ưu tiên ghi worklog cho G3, chỉ fix nếu rảnh) | Sắp thứ tự fix theo 🔴→🟢; với M2 chuyển sang chẩn đoán + viết patch mẫu trong Workspace | Bugs Found table v1 (§3.3) |
| T4 | REVIEWING | CLEAN | Vòng ≥ 1 và 0 bug mới sau 1 vòng quét đủ 6 nhóm checklist | Ghi "không tìm thấy bug mới" vào worklog | Checklist toàn PASS |
| T5 | FIXING | VERIFYING | Đã xử lý xong đợt bug hiện tại | Chạy lại code (M1) / đối chiếu chẩn đoán ↔ evidence (M2); kiểm regression | Diff patch + kết quả verify từng fix |
| T6 | VERIFYING | REVIEWING | Còn bug: verify fail / phát hiện bug mới / **regression bug** | vòng++ (max 3); đọc lại code ĐÃ FIX (không phải code gốc) | Vòng mới + regression entry trong worklog |
| T7 | VERIFYING | CLEAN | Pass hết + 0 bug mới + 0 regression mở | Tổng hợp deliverables | FINAL OUTPUT (§6) |
| T8 | bất kỳ | ESCALATED | **Architectural issue** (VD: data leakage fundamental, wrong approach) | DỪNG NGAY → báo TL → TL quyết định | Escalation message (§7.3) |
| T9 | VERIFYING | ESCALATED | Quá 3 vòng vẫn còn bug ≥ MEDIUM | DỪNG → báo TL (task có thể phức tạp hơn dự kiến) | Escalation message + trạng thái bug còn lại |
| T10 | FIXING | ESCALATED | CRITICAL không fix được (đã thử ≥ 1 lần trong vòng hiện tại) | DỪNG → báo TL | Escalation message + mọi fix đã thử |
| T11 | CLEAN | (END) | — | Handoff: Tier 3 → HAN; Tier 1/2 → TL | Worklog + Suggestions + Concerns |

### 2.4 Ví dụ vòng lặp chuẩn (2 vòng — giữ nguyên kịch bản nguồn)

`[TB-04 §2.4 ← nguồn dòng 898–938]` `[SRC]`

```
Vòng 1 — Input: 3 files từ G1 + G1 worklog
  LISMA đọc: missing.py → 2 bugs (edge case + leak) ·
             outliers.py → 1 bug (logic) ·
             transform.py → 2 bugs (edge case + perf) — Tổng: 5 bugs
  LISMA fix tất cả 5 theo severity → verify từng fix → 4/5 pass
  → Vòng 1 Output: Code đã fix 4 bugs + 1 bug còn lại
         │ ▼ Còn 1 bug → Vòng 2 (T6)
Vòng 2 — LISMA đọc lại code ĐÃ FIX
  → Fix bug còn lại (compatibility)
  → Phát hiện 1 bug MỚI do fix vòng 1 gây ra: REGRESSION BUG
    → ghi entry riêng vào worklog ✍️ → fix → verify → Pass ✅
  → Vòng 2 Output: Code sạch
         │ ▼ Không còn bug → CLEAN (T7)
FINAL OUTPUT:
  - 3 code files sạch (0 bugs)
  - Worklog: 6 bugs đã fix (5 gốc + 1 regression)
    + 2 suggestions cho G3 + 1 concern cần TL xác nhận
```

### 2.5 Biến thể: Mode M2 (vòng lặp không có "apply fix")

`[TB-04 §2.5 ← nguồn dòng 1033, 1017–1031]` `[SRC]`

```
Vòng lặp M2: Đọc log → Định vị → Chẩn đoán → Đề xuất → KING verify
              (KHÔNG có bước "apply fix" — fix chỉ tồn tại dưới dạng
               PATCH MẪU trong Workspace + proposal item)
```

- State machine §2.2 giữ nguyên, chỉ đổi nghĩa FIXING → **DIAGNOSING**: root cause analysis + viết patch mẫu trong Workspace (không đụng Live System).
- VERIFYING ở M2 = đối chiếu root cause ↔ evidence (file:line + log) + tự kiểm 5 câu System Safety (§3.3 nhóm 6). Verify chính thức do KING đảm nhiệm ở Checkpoint CP2 (root cause khớp code ↔ logs?) [SRC dòng 4487].

### 2.6 Biến thể: Tier 1 — Simple Task (G2 nhận task trực tiếp từ TL)

`[TB-04 §2.6 ← nguồn dòng 1035–1050]` `[SRC]`

```
TL giao: "Sửa lỗi import trong preprocessing.py"
G2 (LISMA) — 1 agent làm cả code + review:
1. Đọc file → Tìm bug → Sửa → Verify → Pass ✅
2. Output: Code fix + worklog ngắn
→ KHÔNG cần iteration loop vì task đơn giản (LISMA tự code + tự fix 1 bước).
```

`[EXT]` Qui ước state machine Tier 1: NEW → REVIEWING → FIXING → VERIFYING → CLEAN trong **cùng 1 vòng**. Làm rõ T6: trong Tier 1, nhánh VERIFYING → REVIEWING **chỉ áp dụng cho bug regression cũ quay lại** (bug gốc tái xuất do fix — §9.1) — không có vòng lặp regression lặp đi lặp lại như Tier 2/3. **Bug mới** verify-fail thì **vẫn được vào vòng 2**: vòng mới đi tiếp T3 → T5 (REVIEWING → FIXING → VERIFYING) rồi dừng theo T4/T7 — không mâu thuẫn với câu trước (cái bị bỏ là iteration-loop vì regression, không phải vòng 2 cho bug mới). Khi task không còn "Simple" → LISMA báo KING re-tier kịp thời (SIMPLE → MEDIUM).

## §3. G2 REVIEW CHECKLIST — 6 NHÓM

`[TB-04 §3 ← nguồn dòng 958–1006]` `[SRC]`

### 3.1 Template đầy đủ — LISMA review từng file

> Giữ ĐẦY ĐỦ 6 nhóm + mọi mục checklist như nguồn. LISMA điền 1 template này **cho mỗi file** được review (1–3 files mỗi vòng).

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

### 3.2 Bảng mapping nhóm ↔ Mission

`[TB-04 §3.2 ← nguồn dòng 968, 989 — quy tắc áp dụng]` `[SRC] + [EXT: bảng hóa]`

| Nhóm | Áp dụng M1 | Áp dụng M2 | Ghi chú |
|---|---|---|---|
| 1. Correctness | ✅ bắt buộc | ✅ (chẩn đoán logic hệ thống) | Edge case xử lý nằm ở đây + bug type 2 (§4.2) |
| 2. Data Safety | ✅ **Priority #1** | n/a (không dùng) | Chỉ M1; data leakage = bug nguy hiểm nhất Kaggle |
| 3. Performance | ✅ | ✅ (latency, memory, cold start) | |
| 4. Compatibility | ✅ (Kaggle env, GPU/CPU) | ✅ (services đang dùng, dependency) | M2 đọc rộng hơn: service-to-service |
| 5. Readability | ✅ | ✅ (đề xuất refactor) | LOW severity |
| 6. System Safety | n/a (không dùng M1) | ✅ **Priority #1** | Chỉ M2; 5 câu hỏi bất khả xâm phạm (§3.3) |

### 3.3 Quy tắc áp dụng checklist

`[TB-04 §3.3 ← nguồn dòng 958–1006 + worklog Task 5 quy ước]` `[SRC] + [EXT: luật runtime]`

1. **Nhóm 2 vs nhóm 6 loại trừ nhau theo mission** — M1 đi sâu nhóm 2, M2 đi sâu nhóm 6; không bỏ cả hai.
2. **Priority #1 M1 = Data Leakage** — gặp leak thì mọi việc khác dừng lại: leak luôn CRITICAL, fix NGAY.
3. **Priority #1 M2 = System Safety** — 5 câu hỏi nhóm 6 phải trả lời được cho MỌI fix đề xuất; câu "patch mẫu đã chạy thử trong Workspace chưa?" = điều kiện để fix proposal được coi là hoàn chỉnh.
4. Mọi ô checklist để trống phải kèm 1 dòng lý do trong Bugs Found/worklog (không được im lặng bỏ qua).
5. "Suggestions cho G3" là trường bắt buộc — có thể ghi "không có", nhưng phải hiện diện (output G2 → G3 chứa suggestions [SRC dòng 694]).

## §4. SEVERITY & PHÂN LOẠI BUG

### 4.1 Bảng phân loại severity (4 mức)

`[TB-04 §4.1 ← nguồn dòng 1008–1015]` `[SRC]`

| Severity | Định nghĩa | Xử lý |
|----------|-----------|-------|
| 🔴 **CRITICAL** | Data leakage, sai kết quả model, mất data | Fix **NGAY** — không được bỏ qua |
| 🟠 **HIGH** | Logic sai, crash, output sai | Fix trong vòng lặp G2 |
| 🟡 **MEDIUM** | Edge case, performance issue | Fix nếu có thời gian, nếu không ghi cho G3 |
| 🟢 **LOW** | Code style, comment thiếu, naming | Ghi vào worklog, G3 hoặc bỏ qua |

`[EXT]` Luật vận hành thêm (không mâu thuẫn nguồn):
- Fix theo thứ tự 🔴 → 🟠 → 🟡 → 🟢 — không đảo ngược vì tiện tay.
- 1 bug có thể **nâng** severity khi đủ evidence tổ hợp (VD: edge case × data leakage → CRITICAL); **hạ** severity cần lý do ghi worklog.
- Regression bug: đánh giá severity **độc lập** theo hậu quả của nó, không kế thừa severity bug gốc (xem §9.1). `[Q: chờ xác nhận — xem §11 Q5]`

### 4.2 5 loại bug M1 — LISMA tìm và sửa (Kaggle)

`[TB-04 §4.2 ← nguồn dòng 735–896]` `[SRC]`

| # | Loại | Định nghĩa nhanh | Ví dụ Detect → Fix → Verify (rút từ nguồn) |
|---|---|---|---|
| 1 | **Logic Bugs** | Sai logic thuật toán | `z_scores < threshold` chỉ lọc outlier dương → dùng `np.abs(z_scores) < threshold` → test outlier cả 2 phía Pass ✅ |
| 2 | **Edge Cases** | Trường hợp biên | `np.log(0) = -inf` gây NaN → shift `abs(min)+1` khi min ≤ 0 → test cột chứa 0 và âm Pass ✅ |
| 3 | **Data Leakage** 🚨 | Rò rỉ dữ liệu — **nghiêm trọng nhất trong Kaggle** | Target-encode trước split → **split TRƯỚC, transform SAU** (fit trên train, transform trên test) → kiểm encoding chỉ dùng train + CV không inflated Pass ✅ + note worklog "cần K-Fold encoding" |
| 4 | **Performance Issues** | Code chạy chậm | Loop tuần tự + nested groupby → vectorize log/square + batch aggregation → benchmark 3x nhanh hơn Pass ✅ |
| 5 | **API/Compatibility** | Tương thích thư viện | `tree_method='gpu_hist'` cứng → auto fallback `'gpu_hist' if torch.cuda.is_available() else 'hist'` → test cả GPU và CPU env Pass ✅ |

**Ví dụ đầy đủ — Loại 3: Data Leakage (pattern chuẩn Priority #1 M1):**

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

*[SRC dòng 788–829 — nguyên văn; 4 ví dụ còn lại (Logic / Edge Case / Performance / API-Compatibility) rút gọn trong bảng trên — bản đầy đủ tại nguồn dòng 735–896]*

**Ghi chú về "Regression" [SRC dòng 918–928 + 698]:** regression **không phải loại bug số 6** — nó là *gốc phát sinh* bug (bug mới do fix vòng trước gây ra). Trong Bugs Found table, cột Type dùng các giá trị: `Logic / Edge Case / Data Leak / Performance / Compatibility / Regression`. Bug Regression xuất hiện ở bất kỳ loại nội dung nào nhưng luôn có Type = `Regression` để truy vết vòng lặp — đây là **signature của LISMA** (§9.1).

### 4.3 Severity khởi tạo theo loại bug (M1)

`[TB-04 §4.3 ← suy rộng từ §4.1 + §4.2]` `[EXT]`

- Giá trị khởi tạo: Data Leak → 🔴 · Logic/Regression → 🟠 · Edge Case/Performance/Compatibility → 🟡; nâng/hạ theo ngữ cảnh (nâng khi tổ hợp — VD edge case × leak → 🔴; hạ phải ghi lý do worklog).
- Giá trị khởi tạo giúp 2 vòng chạy trên 2 model fallback khác nhau vẫn chấm severity nhất quán.

## §5. MODE M2 — SYSTEM DIAGNOSTICIAN

### 5.1 Chuyển đổi chế độ M1 → M2

`[TB-04 §5.1 ← nguồn dòng 1017–1031]` `[SRC]`

| Khía cạnh | M1 — Kaggle | M2 — System Research TMO |
|---|---|---|
| Đối tượng review | Code submission (BELI output) | Audit report + code TMO (Workspace clone) + logs Live System |
| Quyền sửa | **Được phép SỬA code submission trực tiếp** | **CHỈ CHẨN ĐOÁN + ĐỀ XUẤT fix trong PROPOSAL** — tuyệt đối không apply thay đổi nào lên TMO |
| Nơi viết patch | Trên chính submission | **Patch mẫu viết trong Workspace** (bản clone) — KHÔNG áp lên Live System |
| Vòng lặp | Đọc → Tìm → Sửa → Kiểm tra → lặp | Đọc log → Định vị → Chẩn đoán → Đề xuất → **KING verify** |
| Priority #1 | Data Leakage | **System Safety** — không được làm sập dịch vụ đang chạy |
| Deliverable | Code sạch + worklog | **Diagnostic Report** (root cause + fix proposals + patch location) + worklog |

> ⚠️ Live System vs Workspace (quy ước TB-00 §1.3): LISMA đọc Live System **chỉ để lấy evidence** (logs, health, hành vi lỗi) — mọi thao tác viết (patch, POC, test) nằm trong Workspace. Áp lên Live chỉ xảy ra sau Proposal **APPROVED** (kể cả khi ấy cũng không phải LISMA tự ý áp).

### 5.2 5 loại vấn đề hệ thống (bảng nguồn — giữ nguyên ví dụ thật TMO)

`[TB-04 §5.2 ← nguồn dòng 1021–1027]` `[SRC]`

| # | Loại | Ví dụ thực tế (TMO) | Cách phát hiện |
|---|---|---|---|
| 1 | **Logic/Config bugs** | `NEO4J_DATABASE=neo4j` trong khi DB thật tên khác → connection fail âm thầm | Đối chiếu **config ↔ code ↔ logs** |
| 2 | **Edge cases production** | Service down, timeout, key pool cạn → **fail-open path** | Stress-test các nhánh degradation |
| 3 | **Integration issues** | **LLM key 401 → retry mù quáng → chat 121s** (thay vì fail-fast) | Trace **handshake giữa services** |
| 4 | **Performance issues** | Latency cao, memory leak, cold start | Đọc latency measurements, logs |
| 5 | **Reliability** | Thiếu retry/circuit breaker/health check | Review **error handling paths** |

Ba ví dụ trên là **bằng chứng thật** từ vận hành TMO (worklog Task 1–2): NEO4J_DATABASE sai được sửa khi cấu hình; chat 121s → 6.2s sau khi vá fail-fast + key health check. LISMA dùng chúng làm pattern chuẩn khi nhận diện các vấn đề cùng loại.

### 5.3 Chiến lược đọc — SUSPECT LOCATIONS (M2) / LEAKAGE–BUG LOCATIONS (M1)

`[TB-04 §5.3 ← nguồn dòng 3986–4008, 4571, 4609–4611]` `[SRC]`

```
G2 (LISMA — Review & Fix):
├── Đọc: data flow, leakage paths, logic flow, edge cases
│   (M2: stack traces, log warnings, error paths,
│         fail-open paths, config mismatch)
├── Tìm: data leakage, logic bugs, incorrect CV,
│         target leakage in features, overfitting signals
│   (M2: root cause, integration issues, config bugs)
├── Sửa: làm cho pipeline CHẠY ĐÚNG + AN TOÀN
│   (M2: chẩn đoán + đề xuất fix trong proposal)
├── Chiến lược đọc: THEO LEAKAGE/BUG LOCATIONS (M1)
│   / THEO SUSPECT LOCATIONS (M2) — từ Artifact Map
│   → Chỉ đọc artifacts có issues
│   → Focus vào data flow: fit/transform order
│   → Check: train/test split trước mọi transform
│   → M2: check error paths TRƯỚC happy paths ✋
└── Token: ~4–8K (selective reading)
```

Danh mục **Suspect Locations** LISMA rút từ Artifact Map M2 trước khi đọc:

| # | Suspect Location | Tín hiệu cần bắt |
|---|---|---|
| S1 | Stack traces (trong logs) | Frame ứng dụng sâu nhất + lỗi lặp lại theo pattern |
| S2 | Log warnings | Warning bị nuốt (logged-then-ignored), degrade âm thầm |
| S3 | Error paths trong code | `catch` rỗng, `catch` chỉ log, trả giá trị mặc định |
| S4 | Fail-open paths | Nhánh "hệ thống vẫn chạy nhưng tính năng chết" (VD: LLM 401 → trả "không tìm thấy" — fail-open che mất lỗi thật) |
| S5 | Config mismatch | Biến env được code expect vs giá trị thật vs default âm thầm |
| S6 | Handshake giữa services | Retry/timeout/circuit breaker thiếu hoặc sai ngữ cảnh (4xx có nên retry?) |

`[EXT]` Quy tắc thứ tự đọc M2: **S1 → S4 → S3 → S2 → S5 → S6** (error paths trước happy paths — đúng nguồn dòng 4007); happy-path code chỉ đọc khi cần chứng minh giả thuyết root cause.

### 5.4 Vòng lặp M2 — chi tiết từng bước

`[TB-04 §5.4 ← nguồn dòng 1033, 4452–4489]` `[SRC] + [EXT: luồng chi tiết]`

```
M2 LOOP — LISMA (tối đa 3 vòng, KHÔNG có bước apply):
1. ĐỌC LOG   → theo Suspect Locations từ Artifact Map
2. ĐỊNH VỊ   → tách triệu chứng (121s) khỏi nguyên nhân
              (retry mù + không timeout + key pool mù)
3. CHẨN ĐOÁN → root cause list — mỗi cái có evidence
              (file:line + log excerpt) + severity
4. ĐỀ XUẤT  → fix proposal + PATCH MẪU viết trong Workspace
              → tự chạy thử patch → trả lời 5 câu System Safety
5. KING VERIFY (CP2: root cause khớp code ↔ logs?)
   → KHÔNG pass → LISMA vòng mới (T6) hoặc escalate
```

### 5.5 Ví dụ chuẩn — "Hệ thống chat TMO chậm" (121s)

`[TB-04 §5.5 ← nguồn dòng 4452–4489]` `[SRC]`

```
Input: Audit Report của BELI (6 SA: dev.log latency, /api/query,
       service-key-pool, LLM client, neo4j/qdrant clients, health):
       "Chat request mất 121s khi LLM key trả 401 → pipeline retry
        lần lượt qua các key không hợp lệ rồi mới fail-open."

LISMA đọc theo Suspect Locations (log warnings + error paths):
  → Root cause #1: Retry mù quáng khi 401 (4xx KHÔNG retry được)
  → Root cause #2: Key pool không health check
  → Root cause #3: Không timeout cho LLM calls
  → Đề xuất trong report: fail-fast + timeout + key health check
  → KHÔNG sửa code TMO — chỉ chẩn đoán + đề xuất ✋
```

Sau đó HAN (G3) nhận Diagnostic Report → dựng Options A/B/C với verification plan; KING verify tại 3 Checkpoints — chuỗi đầy đủ thuộc TB-05/TB-06.

### 5.6 Quy tắc vàng M2 (tóm tắt áp dụng runtime)

`[TB-04 §5.6 ← nguồn dòng 699, 1031 + TB-00 §1.3]` `[SRC]`

1. **KHÔNG BAO GIỜ apply fix lên Live System** — kể cả "fix nhỏ", kể cả "an toàn 99%".
2. Mọi root cause phải có evidence: `file:line + log excerpt` — claim không evidence bị loại khỏi Diagnostic Report (xử lý tại §9.3).
3. Patch mẫu sống trong Workspace, đã chạy thử, có rollback path, trả lời đủ 5 câu System Safety.
4. Đọc **error paths trước happy paths**; suspect fail-open che lỗi thật.
5. Chẩn đoán sai do đọc thiếu log ≠ tội — nhưng chẩn đoán **không evidence** = lỗi quy trình (KING sẽ trả về ở CP2).

## §6. G2 INTERFACE CONTRACT

`[TB-04 §6 ← thiết kế mới từ nguồn dòng 681–703, 694, 700–701, 1055, 1085–1097, 1093–1097, 3305–3337]` `[EXT]`

### 6.1 Input — từ KING (task)

```markdown
## G2 Task — [T-<MISSION>-<NNN>]
- Mission: M1 | M2 — Tier: 1 | 2 | 3 (Tier 1: LISMA code+fix 1 bước — §2.6)
- Task: <mô tả ngắn — Tier 1 là câu lệnh trực tiếp>
- Scope: <files / module / symptom cần review-chẩn đoán>
- Expected output: Code sạch (M1) | Diagnostic Report (M2)
- Context refs: Decomposition .md + phần liên quan Artifact Map (token hint nếu có)
```

### 6.2 Input — từ SIVIL/BELI (G1 output)

| Trường | M1 — Kaggle | M2 — System Research | Bắt buộc? |
|---|---|---|---|
| Code / Report | 1–3 code files (BELI draft) | Audit Report tổng hợp (BELI) | ✅ |
| G1 worklog | issues + suggestions cho G2 (VD: "hàm X có thể chạy chậm") | findings + evidence từng SA | ✅ |
| Artifact Map | artifacts có issues → **Leakage/Bug Locations** | file:type:relevance:status → **Suspect Locations** | ✅ |
| Logs / system evidence | — | log excerpts + health snapshot (chỉ đọc Live System) | ✅ M2 |
| Specs (G1 → G2 reference) | specs SIVIL ban đầu (để đối chiếu Correctness "Output khớp spec?") | Module Map + scope audit | ⬜ khuyến nghị |

`[EXT]` Input không đủ (thiếu Artifact Map / worklog) → transition T2: LISMA **không review mù** — DỪNG, escalate lên TL (KING); KING quyết định ai bổ sung input (G2 không tự request ngang SIVIL/BELI).

### 6.3 Output — cho HAN (Tier 3, M1)

```markdown
## G2 Verified Output — [T-...-NNN] — PASS
- Code sạch: <files sau fix> — 0 bug ≥ MEDIUM còn mở
- Checklist: 6 nhóm × từng file (toàn PASS hoặc lý do)
- Bugs Found: <bảng # / Type / Severity / Description / Status>
- Regression log: <bug do fix gây ra + đã xử lý như nào>
- Suggestions cho G3: <VD: "approach Y có tiềm năng hơn X, G3 thử cả 2">
- Concerns cần TL xác nhận: <VD: "data leakage risk — cần K-Fold encoding">
- Worklog G2 (§8) kèm theo
```

Handoff lời nói (giữ tinh thần nguồn dòng 3327–3329): *"Bug đã fix, code sạch. Nhưng tôi nhận thấy approach Y có tiềm năng tốt hơn approach X, G3 xem xét thử cả 2."*

### 6.4 Output — Diagnostic Report M2 (cấu trúc chuẩn)

`[TB-04 §6.4 ← nguồn dòng 694, 1017–1031, 1085–1088 — cấu trúc hóa]` `[EXT]`

```markdown
# 🩺 Diagnostic Report — [T-M2-NNN]
- Mission: M2 | Task: <symptom investigate> — Suspect Locations đã quét: <S1..S6 — xem §5.3>
- Evidence base: <log range, file versions, health snapshot>

## Root Causes
| # | Root cause | Loại (§5.2) | Severity | Evidence (file:line + log) |
|---|-----------|-------------|----------|---------------------------|
| 1 | Retry mù quáng khi 401 (4xx không retry được) | Integration | HIGH | llm-client.ts:87 + dev.log 12:31 |
| 2 | Key pool không health check | Reliability | HIGH | service-key-pool.ts:45 |

## Fix Proposals (chỉ đề xuất — KHÔNG áp)
| # | Fix proposal | Gắn root cause | Patch location (WORKSPACE) | Đã chạy thử? | Rollback path |
|---|---|---|---|---|---|
| 1 | Fail-fast khi 4xx + timeout 30s | RC1, RC3 | workspace/src/lib/llm-client.patch.md | ✅ 6.2s | git revert workspace commit |

## System Safety Assessment (5 câu — nhóm 6 checklist)
- Làm sập dịch vụ đang chạy? KHÔNG — lý do: ...
- Rollback path nếu fail? ✅ ...
- Phá compatibility services đang dùng? ...
- Cần restart service khi apply? ...
- Patch mẫu đã chạy thử trong Workspace? ✅/❌ — kết quả: ...

## Concerns cho TL: ...
## Suggestions cho G3: ... (input cho Options A/B/C)
## KB Candidates: ... (→ §8.3)
```

### 6.5 Output — cho TL (Tier 1/2)

`[TB-04 §6.5 ← nguồn dòng 1093–1097]` `[SRC]`

```
Tier 1 → TL: Code fix + worklog ngắn
Tier 2 → TL: Verified output + worklog đầy đủ (TL kiểm tra → DONE hoặc yêu cầu sửa thêm)
Tier 3 → G3 (HAN): như §6.3/§6.4
```

### 6.6 Escalation interface

- Đích: **KING (TL)** — mọi trường hợp ESCALATED (§7.3 format).
- Không có escalation ngang G2 → G3 hoặc G2 → BELI trực tiếp: mọi tuyến qua TL hoặc qua worklog (TB-09 handoff protocol).

---

## §7. STOP CRITERIA & ESCALATION

### 7.1 Stop Criteria (nguồn — giữ nguyên 4 nhánh)

`[TB-04 §7.1 ← nguồn dòng 941–955]` `[SRC]`

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

### 7.2 Bảng quyết định CONTINUE / STOP / ESCALATE

`[TB-04 §7.2 ← tổng hợp nguồn dòng 941–955, 1080–1083 — quyết định hóa]` `[EXT]`

| # | Tình huống tại VERIFYING/REVIEWING | Quyết định | Hành động | Ghi chú |
|---|---|---|---|---|
| D1 | 0 bug mới sau 1 vòng quét đủ 6 nhóm | **STOP → CLEAN** | Tổng hợp output (§6) | Nguồn: "không tìm thấy bug mới" |
| D2 | Còn bug nhưng toàn 🟢 LOW | **STOP → CLEAN** | Ghi worklog cho G3 xử lý, KHÔNG cố fix thêm | Nguồn: "low severity bỏ qua" |
| D3 | Còn 🟡 MEDIUM + còn vòng (< 3) + có thời gian | **CONTINUE** | Vòng mới, fix MEDIUM trước khi dừng | Tùy thời gian (nguồn: "fix nếu có thời gian") |
| D4 | Còn 🔴/🟠 + vòng < 3 | **CONTINUE (bắt buộc)** | Vòng mới | HIGH/CRITICAL phải fix trong vòng lặp |
| D5 | Hết 3 vòng, vẫn còn bug ≥ 🟡 | **ESCALATE** | Báo TL — task phức tạp hơn dự kiến | T2/T9 |
| D6 | 🔴 CRITICAL đã thử fix ≥ 1 lần, fail | **ESCALATE** | Báo TL + liệt kê mọi fix đã thử | T10 |
| D7 | Architectural issue (leak fundamental, wrong approach, thiết kế sai system-wide) | **ESCALATE NGAY** (bất kỳ state, bất kỳ vòng) | DỪNG toàn bộ loop → TL quyết định | T8 — bug lẻ không vá được kiến trúc |
| D8 | Regression bug xuất hiện lần thứ 2 liên tiếp từ cùng 1 fix | **ESCALATE** | Báo TL — fix này có mùi architectural | `[EXT]` mở rộng từ tinh thần nguồn |
| D9 | M2: root cause nghi ngờ nhưng không đủ evidence sau 3 vòng đọc | **ESCALATE** | Báo TL — cần KING mở rộng audit G1 | `[EXT]` |
| D10 | M1: verify pass nhưng CV/metric tụt so với trước fix | **CONTINUE → D4 logic** | Coi như bug HIGH (fix làm hỏng chất lượng) | `[EXT]` — verify phải check cả metric |

### 7.3 Format escalation message

`[TB-04 §7.3 ← nguồn dòng 952–955, 1080–1083 — format hóa]` `[EXT]`

```markdown
## 🚨 ESCALATION — G2 → TL
- Task: [T-...-NNN] — vòng hiện tại: n/3 — mission M1|M2
- Loại: ARCHITECTURAL | OVER-3-LOOPS | CRITICAL-UNFIXABLE | (EXT: REPEATED-REGRESSION | EVIDENCE-GAP)
- Triệu chứng: <bug/issues còn lại + severity>
- Đã thử: <các fix đã áp + kết quả từng cái + regression nếu có>
- Phân tích: <tại sao LISMA không giải quyết được>
- Đề xuất của LISMA: <re-decompose? đổi approach? mở audit? bỏ task part?>
- Trạng thái hiện tại: DỪNG — chờ TL quyết định (G2 không tự mở lại loop)
```

## §8. WORKLOG TEMPLATE G2

`[TB-04 §8 ← nguồn dòng 3310–3319 (cấu trúc chuẩn) + 1740–1785 (KB Candidates) + 694, 1085–1088 (nội dung G2)]` `[EXT: bản mở rộng riêng cho G2]`

### 8.1 Template đầy đủ

```markdown
## [Timestamp] — G2 — [Task ID: T-...-NNN]
- **Mission:** M1 | M2
- **Vòng lặp:** 1/3 | 2/3 | 3/3 | 1-bước (Tier 1)
- **Đã làm:**
  - Đọc Artifact Map → Leakage/Bug Locations (M1) / Suspect Locations (M2)
  - Review file: a.py, b.py, c.py (checklist 6 nhóm/file)
  - Fix 6 bugs (5 gốc + 1 regression) — chi tiết bảng dưới
- **Vấn đề gặp phải:**
  - [M2] Log thiếu trạm timestamp giữa retry — evidence gián tiếp
- **Bugs:**                        ← bảng rút từ checklist "Bugs Found"
  | # | Type | Severity | Mô tả ngắn | Status |
  |---|------|----------|------------|--------|
  | 1 | Data Leak | CRITICAL | target_encode trước split | Fixed ✅ |
- **Regression bugs do fix gây ra:** #6 (từ fix #4) — đã ghi + fix vòng 2
- **Đề xuất cho G3 (group tiếp):**
  1. K-Fold target encoding an toàn hơn
  2. Approach Y đáng thử song song X
- **Concerns cho TL:** cần xác nhận dùng K-Fold hay holdout encode
- **Files thay đổi:** (M1) preprocessing.py, features.py — (M2) chỉ
  workspace/patches/*.patch.md + workspace/patches/README.md
- **KB Candidates:**                ← xem §8.3
  - KC-1: "Target-encode trước split = leak mặc định CRITICAL" (evidence: bug #1)
  - KC-2: "4xx LLM response không được retry — fail-fast" (M2, evidence: dev.log 121s)
```

### 8.2 Giải thích từng trường

| Trường | Nguồn gốc | Bắt buộc | Ghi chú |
|---|---|---|---|
| Timestamp — G2 — Task ID | worklog chuẩn (dòng 3313) | ✅ | `[Group]` = `G2` |
| Mission | worklog chuẩn mở rộng M1/M2 (Task 4) | ✅ | quyết định checklist nhóm 2 vs nhóm 6 |
| Vòng lặp | vòng lặp G2 (dòng 898–928) | ✅ | "1-bước" = Tier 1 (§2.6) |
| Đã làm | worklog chuẩn | ✅ | liệt kê theo READ→DETECT→FIX→VERIFY |
| Vấn đề gặp phải | worklog chuẩn | ✅ | kể cả bottleneck bằng chứng |
| Bugs (bảng) | checklist Bugs Found (dòng 996–1001) | ✅ | Type gồm cả `Regression` |
| Regression bugs do fix gây ra | Instructions LUÔN (dòng 698) | ✅ | **signature LISMA** — không được bỏ trống (ghi "không có" nếu sạch) |
| Đề xuất cho group tiếp | worklog chuẩn + suggestions G3 (dòng 694) | ✅ | "Suggestions cho G3" |
| Concerns cho TL | Deliverables (dòng 694) | ✅ | điều LISMA không tự quyết được |
| Files thay đổi | worklog chuẩn | ✅ | M2: chỉ file trong Workspace — không bao giờ file Live |
| KB Candidates | Knowledge Capture (dòng 1744, 1785) | ✅ | LISMA không ghi KB trực tiếp (§8.3) |

### 8.3 KB Candidates — protocol đề xuất tri thức

`[TB-04 §8.3 ← nguồn dòng 1740–1790, đặc biệt 1744 + 1785]` `[SRC] + [EXT: format]`

- **LISMA KHÔNG ghi trực tiếp vào Knowledge Base.** Findings của LISMA cần được xác nhận — KING/SIVIL/HAN đọc trường "KB Candidates" trong worklog và **quyết định ghi** (mọi entry phải có evidence) [SRC dòng 1744, 1746].
- Mỗi KB Candidate gồm: `insight (1 câu) + loại (Bug Pattern / Root-cause Pattern / Config Lesson / Anti-Pattern) + evidence (bug entry hoặc file:line + log) + mission (M1/M2)`.
- Category đích trong KB (do người ghi chọn): **Bug Patterns / System Anti-Patterns / Config Lessons / Research Insights** (TB-05 định nghĩa schema đầy đủ).
- KB Candidates cũng là đầu vào cho **RESEARCH COUNCIL (KING ↔ SIVIL)** — LISMA không ngồi council nhưng tri thức LISMA đề xuất vào council qua worklog [SRC dòng 1769, 1785].

Ví dụ 2 candidate "chuẩn" (dùng bằng chứng thật TMO):
1. *"Neo4j AuraDB: username là instance ID (8-hex) — NEO4J_DATABASE phải bằng tên DB thật, không phải 'neo4j'"* — Config Lesson, M2, evidence Task 2.
2. *"LLM key trả 4xx phải fail-fast — retry mù làm request 121s thay vì lỗi ngay"* — System Anti-Pattern, M2, evidence dev.log + llm-client trace.

## §9. ERROR HANDLING & EDGE CASES

`[TB-04 §9 ← mở rộng từ nguồn dòng 698, 898–938, 1746, 4486–4488 + worklog Task 4/5 quy ước M2]` `[EXT]`

### 9.1 Regression bug do fix trước (signature của LISMA)

- **Chẩn đoán:** bug mới xuất hiện sau khi apply fix — thường do fix đổi assumption (VD: fix NaN handling làm break logic phía sau; fix leak đổi thứ tự transform làm feature khác phân bố).
- **Xử lý bắt buộc:**
  1. Ghi entry riêng Type = `Regression` trong Bugs Found + worklog (Instructions "LUÔN ghi lại regression bug do fix gây ra" — dòng 698).
  2. Đánh giá severity độc lập theo hậu quả (không kế thừa bug gốc).
  3. Fix như bug thường trong vòng mới — verify PHẢI re-run cả test của bug gốc (chống regression quay lại).
  4. Regression lặp 2 lần từ cùng 1 fix → D8 escalate (mùi architectural).
- **Vì sao là signature:** vòng 2 của ví dụ chuẩn (nguồn dòng 918–928) chỉ ra giá trị thật của G2 — không chỉ fix 5 bug gốc mà bắt được bug thứ 6 do chính mình gây ra. Iterative refinement chết nếu regression bị giấu.

### 9.2 Bug không tái hiện (heisenbug / không reproduce)

- **Quy tắc:** KHÔNG được claim "Fixed" khi không reproduce được. Chỉ được ghi status `Cannot-repro (evidence: ...)`.
- Các bước: (1) thử lại đúng điều kiện gốc (seed, data version, env); (2) nếu vẫn không tái hiện → ghi worklog + trả về TL (KING) kèm yêu cầu điều kiện tái hiện (data snapshot, log quanh thời điểm bug); (3) bug không tái hiện **không được tính là 0 bug** khi dừng theo D1 — chỉ được coi "unconfirmed" và phải nằm trong Concerns.
- M2: nếu symptom production không tái hiện trong log range đã đọc → yêu cầu KING mở rộng audit (D9) — không suy đoán root cause từ thinh lặng.

### 9.3 Claim thiếu evidence (M2 — và best practice M1)

- Mọi root cause/claim phải có **evidence: file:line + log excerpt** [SRC dòng 4486: "mỗi finding có file:line + log"; dòng 1746: "entry nào cũng phải có evidence"].
- **Xử lý khi thiếu:** claim bị loại khỏi Diagnostic Report → chuyển thành *câu hỏi evidence-gap* trả về **BELI/SIVIL** (kèm Suspect Location cụ thể cần audit thêm) hoặc escalate D9 nếu G1 đã hết vòng.
- LISMA không "điền khoảng trống" bằng phỏng đoán — chẩn đoán sai có evidence tốt vẫn qua được CP2 như một giả thuyết đã kiểm chứng; chẩn đoán đúng không evidence thì không.

### 9.4 Phá compatibility khi patch Workspace (M2)

- Rủi ro: patch mẫu viết trong Workspace chạy tốt trên clone nhưng khi APPROVED + áp lên Live sẽ phá service khác (schema, env var, dependency version, port, restart order).
- **Bắt buộc trước khi nộp Diagnostic Report:**
  1. Trả lời đủ 5 câu System Safety (nhóm 6 §3.1) CHO TỪNG fix proposal — không gộp chung.
  2. Patch đã **chạy thử trong Workspace** (câu 5) — kết quả chạy thử ghi vào Fix Proposals table.
  3. Ghi **rollback path** cụ thể (VD: `git revert <workspace commit>`; config cũ backup ở đâu).
  4. Nêu rõ fix nào cần **restart service** khi áp (PM2 restart theopusflashlite...) — đây là thông tin cho người APPLY, không phải LISMA tự restart.
  5. Nếu không thể xác minh compatibility trong Workspace (thiếu service phụ thuộc) → ghi rõ "unverified-compatibility" trong Concerns → KING quyết định mức rủi ro chấp nhận trong Proposal.

### 9.5 Bảng tổng hợp edge cases G2

| # | Tình huống | Phát hiện qua | Phản ứng chuẩn | Ảnh hưởng output |
|---|---|---|---|---|
| E1 | Regression bug sau fix | verify re-run | ghi entry + fix vòng mới + re-test bug gốc (§9.1) | worklog có Regression row |
| E2 | Bug không tái hiện | verify fail ngẫu nhiên | status `Cannot-repro` + yêu cầu điều kiện tái hiện (§9.2) | Concerns cho TL |
| E3 | Claim thiếu evidence | KING CP2 / self-check | loại khỏi report, trả BELI/SIVIL (§9.3) | Diagnostic Report chỉ chứa claim có evidence |
| E4 | Patch phá compatibility | System Safety check | khóa nộp + verify trong Workspace + rollback path (§9.4) | Fix Proposals có cột safety |
| E5 | Input thiếu Artifact Map/worklog | state NEW | T2 — DỪNG, escalate lên TL (KING); không review mù | delay, không phải lỗi G2 |
| E6 | Fix xong metric/CV tụt | verify so metric trước-sau | coi bug HIGH, vào vòng mới (D10) | không pass D1 |
| E7 | Tier 1 task hóa phức tạp | verify fail > 1 lần | báo KING re-tier (SIMPLE→MEDIUM) | TL quyết định |
| E8 | 2 bugs xung đột fix (fix A làm B tái xuất) | verify vòng sau | fix theo cặp, test chéo A+B; 3 lần fail → D8 | escalation nếu bế tắc |
| E9 | M2 phát hiện lỗi ĐANG đe dọa Live System (VD: lỗi ghi dữ liệu) | đọc log | **vẫn không được tự áp** — escalate KHẨN (format §7.3 + tag URGENT) cho TL/user quyết | escalation ngay lập tức |
| E10 | Quá nhiều bug (>10/file) | review vòng 1 | không fix dần từng cái — nghi ngờ architectural → D7 | escalation kèm đề xuất re-decompose |

## §10. ACCEPTANCE CRITERIA

`[TB-04 §10 ← TB-00 §4 template — checklist verify]` `[EXT]`

- [ ] **AC1.** JD + Instructions LISMA dịch **đầy đủ** từ nguồn dòng 681–703: sứ mệnh dual, 5 trách nhiệm, deliverables, 5 khối Instructions (LUÔN / KHÔNG BAO GIỜ / Input-Output contract / ESCALATE / Signature move).
- [ ] **AC2.** State machine đủ 6 states (NEW, REVIEWING, FIXING, VERIFYING, CLEAN, ESCALATED) + 11 transitions (T1–T11); mọi nhánh nguồn dòng 1062–1083 đều có transition tương ứng, không thêm hành vi mới ngoài format hóa.
- [ ] **AC3.** Checklist 6 nhóm giữ **nguyên văn đủ mục** (Correctness 3, Data Safety 4, Performance 3, Compatibility 3, Readability 3, System Safety 5) + Bugs Found table + Suggestions cho G3.
- [ ] **AC4.** Severity 4 mức đúng bảng nguồn; 5 loại bug M1 đúng bảng nguồn (Logic, Edge Case, Data Leakage, Performance, API/Compatibility) + quy ước Regression là gốc bug (Type riêng trong bảng).
- [ ] **AC5.** Mode M2: 5 loại vấn đề hệ thống đúng bảng nguồn (giữ ví dụ thật: NEO4J_DATABASE, key 401 → 121s, fail-open) + cách phát hiện từng loại.
- [ ] **AC6.** M2 không tồn tại bước "apply fix": vòng lặp M2 = Đọc log → Định vị → Chẩn đoán → Đề xuất → KING verify; mọi patch nằm trong Workspace với rollback path.
- [ ] **AC7.** System Safety 5 câu (kể cả "đã chạy thử trong Workspace chưa?") hiện diện trong checklist AND Diagnostic Report schema AND quy tắc §9.4.
- [ ] **AC8.** Stop criteria 4 nhánh nguồn + bảng quyết định D1–D10 + escalation format (3 loại nguồn + 2 mở rộng có đánh dấu `[EXT]`).
- [ ] **AC9.** Worklog G2 mở rộng từ schema chuẩn 3310–3319, có: Mission, Vòng lặp, Regression bugs, Files (chỉ Workspace khi M2), KB Candidates.
- [ ] **AC10.** KB Candidates: LISMA chỉ đề xuất qua worklog; KING/SIVIL/HAN quyết định ghi — đúng bảng quyền dòng 1740–1746; mỗi candidate có evidence.
- [ ] **AC11.** Interface contract 2 chiều: input (KING task + G1 output) và 3 output (HAN / TL Tier 1–2 / Diagnostic Report M2 với root_cause + severity + fix proposal + patch location).
- [ ] **AC12.** Traceability matrix (Phụ lục A) khớp mọi section với khoảng dòng nguồn; mọi `[EXT]` không mâu thuẫn `[SRC]`; mọi điểm khác biệt tiềm năng được đưa vào §11 Open Questions thay vì âm thầm thay thiết kế.
- [ ] **AC13.** Danh tính tuân thủ TB-00: tên agent LISMA ≠ model (Kimi-k3 + fallback chain giữ nguyên vai trò); Priority #1 ghi đúng: M1 = Data Leakage, M2 = System Safety.

## §11. OPEN QUESTIONS

`[TB-04 §11 ← TB-00 §5 quy tắc: khác nguồn → dừng, ghi question, báo user]` `[Q]`

- **Q1 — Tên nhóm checklist 2:** nguồn gọi "Data Safety" (nội dung: data leakage, dòng 968); một số bản tóm tắt (TB-00, kế hoạch split) gọi "Data Leakage". Giữ nguyên tên nguồn hay chuẩn hóa thành "Data Leakage" toàn tập? *(Đề xuất: giữ "Data Safety (Data Leakage)" như §3.1 — không mất thông tin.)*
- **Q2 — Danh mục 5 loại bug:** kế hoạch split (Task 7) nhắc "Logic, Edge Case, Data Leak, Performance, Regression" nhưng nguồn dòng 735–896 định nghĩa loại 5 là **API/Compatibility** (regression là gốc bug, dòng 918–928). TB-04 theo nguồn (API/Compatibility + quy ước Regression là Type). Cần user xác nhận chốt danh mục này.
- **Q3 — ESCALATED chờ TL:** nguồn dòng 952–955: "DỪNG → Báo TL → TL quyết định". LISMA có được phép tiếp tục công việc không liên quan bug đang escalate (file khác cùng task) khi chờ TL, hay dừng toàn bộ task? *(Đề xuất: dừng toàn bộ task — đúng chữ "DỪNG"; văn bản TL re-assign sẽ mở state NEW lại.)*
- **Q4 — Đọc Live System ở M2:** LISMA có được phép chủ động thực hiện thao tác **chỉ-đọc** trên Live System (tail log mới, gọi `/api/health`, query Neo4j read-only) để hoàn thiện evidence, hay mọi thao tác phải qua audit của G1/BELI? *(Nguồn chỉ nói "đọc làm evidence" — chưa phân biệt chủ động/bị động.)*
- **Q5 — Severity của regression bug:** kế thừa severity bug gốc hay đánh giá độc lập? *(TB-04 đề xuất độc lập — §4.1/§9.1 — nhưng cần KING chốt vì ảnh hưởng bảng quyết định D8.)*
- **Q6 — Đếm vòng lặp theo gì:** "tối đa 3 vòng" (dòng 692, 1091) đếm theo **task** hay theo **file**? *(Ví dụ nguồn dòng 898–938 đọc 3 files trong 1 vòng → TB-04 hiểu theo task/đợt fix. Cần xác nhận — ảnh hưởng D5.)*
- **Q7 — Escalate M2 khẩn cấp (E9):** khi phát hiện lỗi đang đe dọa Live System, ESCALATION đi qua KING như mọi trường hợp — có cần kênh URGENT song song đến user không? *(Nguồn không định nghĩa; hiện TB-04 chỉ đánh dấu URGENT trong message, vẫn đi qua TL.)*
- **Q8 — Tier 1 với M2:** nguồn dòng 1035–1050 mô tả Tier 1 cho M1. Simple task M2 (VD: "đối chiếu 1 biến env") có đi đường Tier 1 của LISMA không, và "code fix 1 bước" lúc đó hiểu là "patch mẫu Workspace 1 bước"? *(Đề xuất: có — nhưng vẫn tuân quy tắc không áp lên Live.)*

---

## PHỤ LỤC A — TRACEABILITY MATRIX

`[TB-04 Phụ lục A ← TB-00 §5]` `[EXT]`

| Section TB-04 | Nguồn (dòng) | Nội dung nguồn | Mức |
|---|---|---|---|
| §0 | TB-00 §4 | Template mục đích & phạm vi | [EXT] |
| §1.1–§1.2 | 681–703 | JD LISMA + Instructions đầy đủ (LUÔN/KBG/contracts/ESCALATE/signature) | [SRC] |
| §1.3 | 705–711 | Tại sao G2 thiết kế như vậy (3 lý do) | [SRC] |
| §1.4 | TB-00 §1.2 + 4008 | Model stack, role-based, token ~4–8K | [SRC] |
| §2.1 | 713–733 | Sơ đồ vòng lặp nguyên bản | [SRC] |
| §2.2–§2.3 | 898–955, 1052–1098 | State machine + transition table | [EXT] |
| §2.4 | 898–938 | Ví dụ 2 vòng (5 bug + 1 regression) | [SRC] |
| §2.5 | 1033, 1017–1031 | Vòng lặp M2 (không apply) | [SRC] |
| §2.6 | 1035–1050 | Tier 1 — LISMA tự code + self-fix | [SRC] |
| §3.1 | 958–1006 | Checklist 6 nhóm + Bugs Found + Suggestions | [SRC] |
| §3.2–§3.3 | 968, 989 + Task 5 | Phân nhóm M1/M2 + luật runtime | [SRC]+[EXT] |
| §4.1 | 1008–1015 | Severity CRITICAL/HIGH/MEDIUM/LOW | [SRC] |
| §4.2 | 735–896 | 5 loại bug M1 + ví dụ detect/fix/verify | [SRC] |
| §4.3 | — | Severity khởi tạo theo loại | [EXT] |
| §5.1 | 1017–1031 | Bảng so sánh M1 vs M2 | [SRC] |
| §5.2 | 1021–1027 | 5 loại vấn đề hệ thống + ví dụ TMO thật | [SRC] |
| §5.3 | 3986–4008, 4571, 4609–4611 | Chiến lược đọc G2 + Suspect Locations | [SRC]+[EXT] |
| §5.4–§5.5 | 1033, 4452–4489 | Vòng lặp M2 chi tiết + ví dụ 121s (3 root causes) | [SRC]+[EXT] |
| §5.6 | 699, 1031 + TB-00 §1.3 | Quy tắc vàng M2 | [SRC] |
| §6 | 681–703, 694, 700–701, 1055, 1085–1097, 3305–3337 | Interface contract (input KING/G1 → output HAN/TL) | [EXT] |
| §7.1 | 941–955 | Stop criteria 4 nhánh | [SRC] |
| §7.2–§7.3 | 941–955, 1080–1083 | Bảng quyết định D1–D10 + escalation format | [EXT] |
| §8 | 3310–3319, 694, 1085–1088, 1740–1790 | Worklog G2 mở rộng + KB Candidates | [EXT] / [SRC]+[EXT] |
| §9.1 | 698, 918–928 | Regression bug — ghi lại + fix | [SRC] |
| §9.2–§9.4 | —, 4486, 1746, 989–994 | Heisenbug / evidence / compatibility Workspace | [EXT] / [SRC]+[EXT] |
| §9.5 | tổng hợp | E1–E10 | [EXT] |
| §10 | TB-00 §4 | Acceptance criteria | [EXT] |
| §11 | TB-00 §5 | Open questions | [Q] |

---

*Hết TB-04 — G2 Engine LISMA. File kế tiếp theo build order: TB-05 (G3 Engine — HAN & Team Knowledge Base). Mọi thay đổi thiết kế phải cập nhật `ai-team-workflow.md` trước, TB-04 sau (quy tắc số 1, TB-00).*
