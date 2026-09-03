# TB-02 — TEAM ARCHITECTURE & TIER SYSTEM

> 📐 **TECHNICAL BLUEPRINT — AI RESEARCH TEAM (DUAL MISSION: M1 KAGGLE + M2 SYSTEM RESEARCH)**
> Traceability: `ai-team-workflow.md` dòng 108–166 (Kiến trúc team) · 3174–3283 (3-Tier + Complexity) · 3285–3337 (Handoff) · 3465–3521 (Checkpoint Schedule) · 4515–4558 (Tổng quan 3-Tier)
> Version: 1.2 | Ngày: 2026-08-31 (review + fix — Task 9, 10-a) | Author: Mr. Robot (Z.ai Code) | Nhóm A — Nền tảng
> Chuẩn áp dụng: TB-00 §1/§4/§5 · **Kế thừa trực tiếp TB-01** (danh tính agents, model stack, môi trường Live/Workspace)
> **v1.3 (2026-09-01):** toàn bộ [Q] đã chốt theo DECISION-RECORD-v1.3.md (user ủy quyền, thorough-first) — xem Phụ lục Z nguồn.

---

## §0. MỤC ĐÍCH & PHẠM VI

- **Mục đích:** đặc tả **kiến trúc điều phối** của team — pipeline tổng (request → output theo mission), hợp đồng dữ liệu giữa các khối, và 3-Tier Workflow (kèm bảng quyết định complexity + routing mission × tier). Trả lời 4 câu hỏi: request đi đâu · qua ai · dừng ở đâu kiểm tra · ra gì.
- **Ai đọc:** (1) kỹ sư triển khai orchestration; (2) NEMESIS — bản đồ điều phối tổng; (3) user khi review luồng.
- **Không bao gồm:** JD/Instructions chi tiết từng agent (→ TB-03/04/05/06); handoff file schema đầy đủ (→ TB-09); Proposal Schema 8 trường (→ TB-11); E2E playbooks (→ TB-12).
- **File liên quan:** TB-01 (nền tảng danh tính) · TB-06 (NEMESIS engine — DECIDE/nâng-hạ tier) · TB-08 (Knowledge Capture bù cho tier không qua G3) · TB-09 (RWV Loop & Handoff) · TB-11 (Proposal → SELF-DIRECTION).

---

## §1. PIPELINE TỔNG — REQUEST → OUTPUT THEO MISSION `[TB-02 §1 ← nguồn dòng 108–166, 4515–4552]` `[SRC]`

Pipeline đầy đủ (Tier 3); Tier 1/2 cắt bớt khối theo §3:

```
                        ┌──────────────┐
                        │   REQUEST    │
                        └──────┬───────┘
                               ▼
                    ┌────────────────────┐
                    │  NEMESIS — CLASSIFY   │  Bước 0 với MỌI request:
                    │  M1 Kaggle │ M2 Sys│  mission_type + confidence;
                    └─────────┬──────────┘  ambiguous → hỏi user 1 câu
                              ▼
┌─────────────────────────────────────────────────────┐
│  NEMESIS (TL) — 7 NHIỆM VỤ                              │
│  RECEIVE → TRIAGE → DECOMPOSE → ASSIGN → MONITOR →  │
│  DECIDE → FINALIZE                                   │
│  • TRIAGE   : chấm complexity → chọn tier T1/T2/T3   │
│  • ASSIGN   : giao task .md cho group theo tier      │
│             : (DECOMPOSE đã viết .md — TB-07 §2.5)  │
│  • MONITOR  : đọc worklog sau MỖI Checkpoint (+KB)   │
│  • DECIDE   : CONTINUE / PIVOT / ESCALATE; nâng/hạ   │
│               tier giữa chừng                        │
│  (Research Council NEMESIS↔SIVIL — 4 thời điểm, TB-08)  │
└──────────────────────────┬──────────────────────────┘
                           │ task .md (mỗi part)
                           ▼
                ┌────────────────────┐
                │  G1 — EXECUTE      │ SIVIL (Lead): dispatch 5–300
                │   SIVIL │ BELI     │ sub-agents explore song song;
                └──────────┬─────────┘ BELI: code lượt đầu / M2: viết
                           │           report + POC (trong Workspace)
      ⟨CP1⟩ G1 worklog + Artifact Map → NEMESIS VERIFY:
            NO → giao lại G1  ·  YES → ASSIGN G2
                           ▼
                ┌────────────────────┐
                │  G2 — REVIEW       │ LISMA: review code, tìm bug,
                │   LISMA            │ fix bug (≤3 vòng → ESCALATE);
                └──────────┬─────────┘ M2: chẩn đoán root cause
                           │
      ⟨CP2⟩ G2 worklog + concerns → NEMESIS VERIFY:
            NO (còn CRITICAL) → G2 lại · YES → ASSIGN G3
                           ▼
                ┌────────────────────┐
                │  G3 — OPTIMIZE     │ HAN: tuning, ensemble, KB;
                │   HAN              │ M2: proposal items + Verif.
                └──────────┬─────────┘ Plan; curate KB cả team
                           │
      ⟨CP3⟩ G3 worklog + metrics → NEMESIS VERIFY:
            NO → G3 lại / PIVOT G1 · YES → FINAL VERIFY
                           ▼
                ┌────────────────────┐
                │ NEMESIS — FINALIZE    │ Final report (M1) / tổng hợp
                └──────────┬─────────┘ Proposal (M2)
                           ▼
              OUTPUT THEO MISSION:
              ├── M1: Submission / Dataset / Documentation → User
              └── M2: PROPOSAL → SELF-DIRECTION (chờ user hoặc
                       agent được ủy quyền phê duyệt)
                       • Mọi chỉnh sửa M2 làm trong WORKSPACE
                       • Áp lên LIVE SYSTEM chỉ sau APPROVED
```

**7 nhiệm vụ của NEMESIS** `[SRC dòng 1837, 2639–2676, 1987–1991]:`

| # | Nhiệm vụ | Làm gì | Output chính |
|---|---|---|---|
| 0 | **CLASSIFY** (Bước 0, thuộc RECEIVE) | Phân loại request M1 (Kaggle) / M2 (System Research); ambiguous → hỏi user đúng 1 câu | `mission_type` + confidence |
| 1 | **RECEIVE** | Tiếp nhận & phân tích request (M1: competition page, data dictionary, forum; M2: health, logs, system docs) | Phân tích ban đầu |
| 2 | **TRIAGE** | Đánh giá complexity 3 tiêu chí → chọn tier CHO TỪNG PART | Quyết định tier + điểm |
| 3 | **DECOMPOSE** | Chia bài toán thành parts; viết Research Protocol (M1) / System Audit Charter (M2) | Parts + file .md từng part |
| 4 | **ASSIGN** | Giao task .md cho group phù hợp theo tier | Task assignments |
| 5 | **MONITOR** | Theo dõi qua worklog + code (chọn lọc); Knowledge Capture tại đây (nhất là tier không qua G3) | Quyết định checkpoint |
| 6 | **DECIDE** | CONTINUE / PIVOT / ESCALATE; nâng/hạ tier khi có info mới | Decision log |
| 7 | **FINALIZE** | Hoàn thành & báo cáo (M1: Final report; M2: tổng hợp Proposal → route SELF-DIRECTION) | Final report / Proposal |

> **Ghi chú:** NEMESIS KHÔNG code — chỉ tư duy và điều phối. G1 hoạt động theo cơ chế **"SIVIL điều phối, BELI thực thi"**. Checkpoints (⟨CP1/CP2/CP3⟩) là lúc worklog chảy về NEMESIS — chi tiết §3.3.
>
> **Research Council (NEMESIS ↔ SIVIL) — 4 thời điểm cố định** `[SRC dòng 1757–1760, 4632]`: ① Sau DECOMPOSE (trước ASSIGN) · ② Sau SYNTHESIZE của G1 · ③ Khi G1 ESCALATE · ④ Tại mỗi Checkpoint. Chi tiết protocol → TB-08.

---

## §2. HỢP ĐỒNG GIỮA CÁC KHỐI `[TB-02 §2 ← suy từ nguồn dòng 3285–3337, 3436 + Deliverables dòng 187/210/694/1134/1844]` `[EXT]`

Mọi handoff đều đi qua **file** (External Memory — không giao tiếp "miệng" không dấu vết). ID theo TB-00 §1.4 (`T-<MISSION>-<NNN>`); worklog schema chi tiết → TB-09.

| Hợp đồng | Tài sản truyền (BẮT BUỘC) | Điều khoản chính |
|---|---|---|
| **NEMESIS → G1** (ASSIGN) | `task.md`: ID · Mission (M1/M2) · Tier · Part (Complex) · Status · Mô tả · Input · Output kỳ vọng · Constraints + Research Protocol (M1) / System Audit Charter (M2) | Status khởi đầu `Pending`; NEMESIS không giao việc ngoài file .md |
| **G1 → NEMESIS** (CP1) | G1 worklog (Mission · Đã làm · Vấn đề · Đề xuất cho group tiếp · Files thay đổi; M1: Metrics — M2: Findings & Evidence) + Research Artifact Map + Synthesis report | Mọi finding BẮT BUỘC có evidence — không có evidence = không được ghi vào report |
| **G1 → G2** | Code draft(s) + issues gặp + suggestions cho G2 (VD: "hàm X có thể chạy chậm") | BELI draft chưa perfect là hợp lệ — LISMA sẽ fix |
| **G2 → NEMESIS** (CP2) | G2 worklog + code sạch (M1) / Diagnostic Report (M2) + suggestions cho G3 + concerns cho TL | Còn bug CRITICAL → KHÔNG giao G3: **giao lại G2** vòng mới; G2 vẫn không xử lý được → ESCALATE, NEMESIS quyết (nguồn 3494–3496) |
| **G2 → G3** | Code sạch + suggestion approach (VD: "approach Y tiềm năng hơn X, G3 thử cả 2") | G2 không tự đổi approach — chỉ đề xuất |
| **G3 → NEMESIS** (CP3) | G3 worklog + optimized code (M1) / proposal items + Verification Plan (M2) + recommendations + Team KB đã curate | M2: mỗi proposal item kèm Verification Plan (benchmark deferred) |
| **NEMESIS → User / SELF-DIRECTION** (FINALIZE) | M1: Final report → user · M2: Proposal (8 trường, schema → TB-11) → route thẳng SELF-DIRECTION | M2 status `SUBMITTED` — chờ user hoặc agent ủy quyền phê duyệt |

**Vi phạm hợp đồng → xử lý:** thiếu evidence trong findings → NEMESIS yêu cầu re-audit (pivot trigger M2); thiếu Verification Plan ở proposal item → CP3 FAIL; worklog không cập nhật → MONITOR không verify được → coi như group chưa xong.

**Vòng đời Status của task (chuẩn mọi tier):** `Pending → In-Progress → Review → Done` `[SRC dòng 3295]` — mỗi lần đổi trạng thái phải đồng bộ cả trong task .md lẫn worklog của group đang giữ.

---

## §3. 3-TIER SYSTEM `[TB-02 §3 ← nguồn dòng 3174–3242, 3465–3521, 4515–4558]` `[SRC]`

**Vấn đề:** dùng full pipeline (TL→G1→G2→G3→TL) cho task đơn giản là lãng phí thời gian. **Giải pháp:** phân loại task thành 3 tier, mỗi tier workflow riêng. `[SRC 3176–3178]`

### 3.1 Bảng tổng quan

| Tier | Tên | Đội hình agents | Checkpoint | Số vòng | Khi nào dùng (M1 / M2) |
|---|---|---|---|---|---|
| **T1** | SIMPLE — "Fast Track" | NEMESIS → LISMA → NEMESIS | **chỉ CP2** | ~1–2 vòng | Sửa 1 bug nhỏ, đổi 1 tham số, viết hàm tiện ích, format code, thêm comment / verify 1 config |
| **T2** | MEDIUM — "Standard Track" | NEMESIS → BELI → LISMA → NEMESIS | **CP1 + CP2** | ~2–3 vòng | Viết 1 feature mới, implement model đơn giản, EDA cơ bản, tạo visualization / chẩn đoán 1 vấn đề performance |
| **T3** | COMPLEX — "Full Pipeline" | NEMESIS → (SIVIL + BELI) → LISMA → HAN → NEMESIS, **lặp mỗi part** | **CP1 + CP2 + CP3** | 4+ vòng/part | Pipeline ML hoàn chỉnh, Kaggle competition, dataset lớn, research paper / redesign kiến trúc bộ nhớ, audit toàn hệ thống |

> **Định danh Checkpoint (theo khối, không theo thứ tự trong tier):** CP1 = NEMESIS verify **sau G1** · CP2 = NEMESIS verify **sau G2** · CP3 = NEMESIS verify **sau G3**. Vì T1 không có G1/G3 nên chỉ tồn tại CP2; T2 không có G3 nên không có CP3. `[SRC dòng 4593: "T1: CP2, T2: CP1+CP2, T3: CP1+CP2+CP3 (3 Checkpoint, không phải 4 như Code Team)"]`

### 3.2 Flow & các bước từng tier

```
T1:  NEMESIS ──task_simple.md──▶ LISMA (code + tự review + tự fix) ──▶ NEMESIS quick check ──▶ DONE
T2:  NEMESIS ──task_medium.md──▶ BELI (code draft) ──▶ LISMA (review + fix) ──▶ NEMESIS check ──▶ DONE
T3:  NEMESIS ──task_complex_partN.md──▶ SIVIL (explore N approaches) + BELI (code top-K)
     ──▶ LISMA (review tất cả) ──▶ HAN (optimize / proposal items) ──▶ NEMESIS ──▶ part tiếp / DONE
```

**T1 — các bước:** `[SRC 3193–3199]`

| Bước | Ai làm | Làm gì | Output |
|---|---|---|---|
| 1 | TL (NEMESIS) | Phân tích: "Đây là Simple task" → giao thẳng G2 | `task_simple.md` |
| 2 | G2 (LISMA) | Code + tự review + tự fix | Code hoàn chỉnh |
| 3 | TL | Quick check → DONE | Cập nhật worklog |

**T2 — các bước:** `[SRC 3213–3218]`

| Bước | Ai làm | Làm gì | Output |
|---|---|---|---|
| 1 | TL (NEMESIS) | Phân tích: "Medium task" → mô tả trong .md | `task_medium.md` |
| 2 | G1 (BELI) | Code lượt đầu theo spec | Code draft + worklog |
| 3 | G2 (LISMA) | Review, sửa bug, đảm bảo chạy đúng | Code sạch + worklog |
| 4 | TL | Kiểm tra kết quả → DONE hoặc yêu cầu sửa thêm | Cập nhật worklog |

**T3 — các bước:** `[SRC 3232–3238]`

| Bước | Ai làm | Làm gì | Output |
|---|---|---|---|
| 1 | TL (NEMESIS) | Phân tích: "Complex task" → chia parts → mô tả từng part | `task_complex_part1.md`, `part2.md`... |
| 2 | G1 (SIVIL + BELI) | SIVIL parallel explore N approaches qua sub-agents → BELI code top-K | Multiple drafts + comparison |
| 3 | G2 (LISMA) | Review tất cả approaches, fix bugs, loại approaches lỗi, đề xuất cải thiện | Code sạch + suggestions |
| 4 | G3 (HAN) | Tối ưu best approach: tuning, ensemble, feature engineering / M2: sinh proposal items | Optimized code / Proposal items |
| 5 | TL | Đọc worklog + .md → kiểm tra → part tiếp theo hoặc DONE | Progress tracking |

**Vì sao bỏ khối:** `[SRC 3190–3191, 3211]`
- T1 bỏ G1 — task đủ đơn giản để LISMA tự làm luôn (code + fix trong 1 bước); bỏ G3 — không cần tối ưu cho task nhỏ.
- T2 bỏ G3 — feature hoạt động đúng là đủ, chưa cần tối ưu.
- T3 giữ đủ + lặp lại cho mỗi part.

**Ví dụ mapping tier (M2):** `[SRC dòng 4554–4557]`
- "Verify 1 config có đúng không" → **T1** (NEMESIS → LISMA → NEMESIS)
- "Chẩn đoán chat latency cao" → **T2** (NEMESIS → G1 → LISMA → NEMESIS)
- "Redesign kiến trúc bộ nhớ" → **T3** (full pipeline + HAN)

### 3.3 Checkpoint Schedule — NEMESIS verify gì tại mỗi CP `[SRC 3465–3521]`

| CP | NEMESIS đọc | Câu hỏi VERIFY chính (M1 / M2) | Kết quả |
|---|---|---|---|
| **CP1** (sau G1) | G1 worklog + Artifact Map + Synthesis report | Approaches có phù hợp Protocol không? Hypotheses kiểm tra đúng cách? Sub-agents có insight quan trọng? / Findings có đủ evidence cụ thể? Direction có đúng hướng không? `[SRC 3480]` | YES → ASSIGN G2 · NO → điều chỉnh, giao lại G1 |
| **CP2** (sau G2) | G2 worklog + updated Artifact Map + concerns | Data leakage đã fix chưa? (M1 priority #1) / Root cause có khớp code + logs không? Bugs còn ảnh hưởng metric không? | YES → ASSIGN G3 · NO còn CRITICAL → giao lại G2 · ESCALATE → NEMESIS quyết |
| **CP3** (sau G3) | G3 worklog + Final Artifact Map + metrics | Metric thật sự cải thiện? CV-LB gap < 0.01? / Mỗi proposal item có Verification Plan? Có regression không? Feature selection có justify không? Ensemble stable không? (std across folds) `[SRC 3507–3508]` | YES → FINAL VERIFY → DONE (M2: Proposal) · NO metric → giao lại G3 · NO fundamental → PIVOT về G1 |

**Rationale (giữ từ nguồn):** CP1 — G1 đi sai approach thì G2/G3 sai theo → total waste; CP2 — leakage chưa fix thì G3 optimize vô nghĩa / root cause sai → proposal sai; CP3 — metric không cải thiện = approach sai, cần pivot chứ không optimize thêm.

> **Lưu ý Knowledge Capture:** NEMESIS ghi tri thức trực tiếp tại **MONITOR/DECIDE/FINALIZE** (nguồn 1740/1842/4630). Riêng T1/T2 không đi qua G3 (HAN) → theo nguồn 2343, MONITOR + FINALIZE là 2 thời điểm **chính** để tri thức không mất; DECIDE của T1/T2 diễn ra gộp trong quick-check tại CP2 (→ TB-08). Tier T1/T2 không có CP3; CP2 chính là cửa DONE (quick check của NEMESIS).

---

## §4. BẢNG QUYẾT ĐỊNH COMPLEXITY — TL DÙNG ĐỂ PHÂN LOẠI `[TB-02 §4 ← nguồn dòng 3244–3257]` `[SRC + EXT]`

NEMESIS đánh giá mỗi task theo 3 tiêu chí (mỗi tiêu chí 1/2/3 điểm):

| Tiêu chí | Simple (1 đ) | Medium (2 đ) | Complex (3 đ) | Tín hiệu M2 đặc thụ `[EXT]` |
|---|---|---|---|---|
| **Phạm vi** | 1 file/hàm | 1 module/feature | Multi-module/pipeline | 1 config / 1 env var → 1 · chẩn đoán hoặc sửa 1 vấn đề đơn lẻ (1 vị trí trong module) → 2 · **audit TRỌN 1 module / 1 dịch vụ → 3** (nguồn 3279: Audit 1 module = Phạm vi 3) · cross-module, proposal toàn hệ thống → 3 |
| **Độ sâu suy luận** | Trực tiếp, rõ ràng | Cần vài bước suy luận | Cần research, thử nghiệm | Verify trực tiếp → 1 · chẩn đoán từ logs + code → 2 · cần POC/thử nghiệm trong Workspace → 3 |
| **Rủi ro sai** | Thấp — dễ phát hiện | Trung bình — cần test | Cao — cần nhiều vòng verify | Sai → đọc lại là xong → 1 · sai → chẩn đoán nhầm root cause → 2 · sai → Proposal approve nhầm lên Live → 3 |

**Tính điểm:** `[SRC 3254–3257]` — **3 điểm** → Tier 1 (Simple) · **4–6 điểm** → Tier 2 (Medium) · **7–9 điểm** → Tier 3 (Complex).

**Ví dụ TRIAGE (M2):** scope quyết định tier — (i) "Chẩn đoán chat latency cao" (1 vấn đề đơn lẻ) → Phạm vi 2 + Suy luận 2 (chẩn đoán từ logs) + Rủi ro 2 (chẩn đoán nhầm → proposal sai) = **6 → T2** (nguồn 3278); (ii) "Hệ thống chat TMO chậm, nghiên cứu & đề xuất khắc phục" → Phạm vi 3 (LLM pipeline + key pool + fail-open paths) + Suy luận 3 (đọc logs + code tìm root cause) + Rủi ro 2 = **8 → T3** (nguồn 4439–4443). Lưu ý: TRIAGE chọn tier **CHO TỪNG PART** — request Complex (ii) DECOMPOSE thành 4 parts, có part MEDIUM (nguồn 4445–4449) `[SRC dòng 1848]`.

### Ví dụ thực tế trong Kaggle (M1) `[SRC 3259–3270]`

| Task | Phạm vi | Suy luận | Rủi ro | Tổng | Tier |
|---|---|---|---|---|---|
| Sửa lỗi import | 1 | 1 | 1 | 3 | Simple |
| Thêm logging | 1 | 1 | 1 | 3 | Simple |
| Viết hàm preprocessing | 2 | 1 | 1 | 4 | Medium |
| EDA + visualization | 2 | 2 | 1 | 5 | Medium |
| Implement XGBoost baseline | 2 | 2 | 2 | 6 | Medium |
| Build full ML pipeline | 3 | 3 | 3 | 9 | Complex |
| Ensemble 5 models | 3 | 3 | 2 | 8 | Complex |
| Feature engineering từ 0 | 3 | 3 | 3 | 9 | Complex |

### Ví dụ thực tế trong System Research (M2) `[SRC 3272–3281]`

| Task | Phạm vi | Suy luận | Rủi ro | Tổng | Tier |
|---|---|---|---|---|---|
| Verify 1 config có đúng không | 1 | 1 | 1 | 3 | Simple |
| Sửa 1 env var (đề xuất trong proposal) | 1 | 1 | 1 | 3 | Simple |
| Chẩn đoán chat latency cao | 2 | 2 | 2 | 6 | Medium |
| Audit 1 module (memory system) | 3 | 2 | 2 | 7 | Complex |
| Redesign kiến trúc bộ nhớ | 3 | 3 | 3 | 9 | Complex |
| Đề xuất nâng cấp quy trình tư duy | 3 | 3 | 2 | 8 | Complex |

### Dòng routing "mission × tier" `[EXT]`

- **Tier do tổng điểm quyết định — như nhau cho M1 và M2** (mission KHÔNG cộng/trừ điểm complexity).
- **Khác nhau ở OUTPUT:** M1 → deliverable (Submission/Dataset/Docs) cho user; M2 → Proposal → SELF-DIRECTION (mọi tier — xem §5).
- **2 floor-rule M2 (an toàn):** (a) task M2 sinh Proposal đụng ≥ 2 module → tối thiểu T2; (b) system audit 1 module hoàn chỉnh / redesign kiến trúc → T3 (khớp ví dụ nguồn: audit 1 module = 7 điểm).

---

## §5. ROUTING MATRIX — MISSION × TIER (9 Ô) `[TB-02 §5 ← suy từ nguồn dòng 160–166, 4549–4557]` `[EXT]`

| Tier | M1 — Kaggle (đường đi → output) | M2 — System Research (đường đi → output) | Routing & checkpoint (chung) |
|---|---|---|---|
| **T1 Simple** | NEMESIS → LISMA → NEMESIS → DONE; output: fix/patch/answer nhỏ + worklog → **User** | NEMESIS → LISMA (verify/chẩn đoán nhanh) → NEMESIS; output: kết luận verify hoặc **Proposal 1-item** → SELF-DIRECTION | Chỉ CP2 · ~1–2 vòng · không qua G1/G3 → KB capture tại MONITOR + FINALIZE (nguồn 2343) + DECIDE (nguồn 4630); DECIDE gộp trong quick-check CP2 `[EXT]` |
| **T2 Medium** | NEMESIS → BELI → LISMA → NEMESIS → DONE; output: feature/model/EDA hoàn chỉnh → **User** | NEMESIS → BELI (report) → LISMA (root cause) → NEMESIS; output: **Proposal 1-module** (fix + verification plan) → SELF-DIRECTION | CP1 + CP2 · ~2–3 vòng · Council ① sau DECOMPOSE: SIVIL tham vấn ad-hoc (lưu ý: T2 không route qua SIVIL — [DECIDED v1.3: council ① T2 vẫn họp, SIVIL ad-hoc consult-only — §8 Q5) |
| **T3 Complex** | NEMESIS → (SIVIL + BELI) → LISMA → HAN → NEMESIS, lặp mỗi part; output: **Submission / Dataset / Documentation** → User | NEMESIS → audit song song (SIVIL sub-agents) → LISMA → HAN; output: **Proposal multi-item** (kiến trúc + performance, mỗi item kèm Verification Plan) → SELF-DIRECTION | CP1 + CP2 + CP3 · 4+ vòng/part · Council đủ 4 thời điểm |

> **QUY TẮC VÀNG:** mission M2 **luôn** kết thúc bằng PROPOSAL → SELF-DIRECTION **bất kể tier** — kể cả T1. POC/diff sống trong Workspace (TB-01 §3) và chỉ APPLY lên Live System sau APPROVED.

`[DECIDED v1.3 → DR-C1]` Task M2 thuần verify: ngưỡng deterministic (không đề nghị thay đổi → kết luận + Verify-Report mini + KB; có đề nghị → Proposal 1-item) — đã chốt ở TB-11 §7 Q1 + Phụ lục Z nguồn.

---

## §6. ERROR & EDGE CASES `[TB-02 §6 ← nguồn dòng 1991–2013, 1862, 2698, 3460, 692, 702, 3509–3512, 195, 1759, 3552]` `[SRC + EXT]`

| # | Tình huống | Phát hiện ở đâu | Hành xử | Tham chiếu |
|---|---|---|---|---|
| 1 | **Request ambiguous** — không rõ M1/M2 | Tại CLASSIFY (confidence thấp) | NEMESIS hỏi user **ĐÚNG 1 CÂU** ("Đây là nghiên cứu hệ thống TMO (M2) hay bài toán Kaggle/dataset (M1)?") — không đoán mò | [SRC 2005–2009] |
| 2 | **Classified sai mission** (VD: request "nâng cấp X" bị chạy theo M1) | G1/G2 báo context không khớp; output type sai lệch | **Pivot về CLASSIFY**: dừng công việc đang chạy, NEMESIS hỏi lại 1 câu, re-classify; worklog ghi `mission pivot M1→M2`; task .md cập nhật Mission + ID mới | [EXT — suy từ 1862: sai mission type = toàn pipeline chạy nhầm hướng] |
| 3 | **Tier chọn sai — cần NÂNG** | G2 ESCALATE (architectural/CRITICAL) / G3 recommend complex / info mới từ worklog | NEMESIS DECIDE: nâng tier, re-TRIAGE, viết task .md mới; phần đã làm xong được tái sử dụng (không làm lại từ đầu) | [SRC 2698] · TB-06 |
| 4 | **Tier chọn sai — cần HẠ** | Scope thực tế hẹp hơn dự kiến (G1 explore xong thấy chỉ 1 module nhỏ) | NEMESIS hạ tier T3→T2/T1 cho phần còn lại — chỉ khi không phá part đã giao | [EXT] · TB-06 |
| 5 | **CP3 FAIL — metric không cải thiện** | NEMESIS đọc G3 worklog | Giao lại G3 (tối đa thêm 1 vòng `[EXT]` — nguồn 3511 chỉ ghi "Giao lại G3"), vẫn fail → PIVOT về G1 | [SRC 3509–3512] |
| 6 | **CP3 FAIL — fundamental issue** | NEMESIS verify | PIVOT về G1: điều chỉnh hypothesis, chạy lại | [SRC 3512] |
| 7 | **G2 quá 3 vòng vẫn còn bug** | LISMA tự đếm vòng | ESCALATE NEMESIS → DECIDE (nâng tier / pivot / escalate user) | [SRC 692, 702] |
| 8 | **ESCALATE lên user** | — | Dừng → báo user → **chờ quyết định** (không tự tiếp tục) | [SRC 3460] |
| 9 | **M2 nhưng Workspace chưa mở** | Khi ASSIGN / BELI cần POC | EVIDENCE vẫn chạy (đọc Live); POC hoãn — Proposal đánh dấu `POC-NEEDS-WORKSPACE` | [EXT] · TB-01 §5 |
| 10 | **T1 task phình to khi LISMA đang làm** | LISMA nhận ra scope lớn hơn dự kiến | LISMA dừng, ESCALATE NEMESIS → nâng T2, làm lại qua G1 (code đã có được review lại) | [EXT] |
| 11 | **G1 sub-agents trả kết quả mâu thuẫn** không giải thích được | SIVIL tại SYNTHESIZE | SIVIL điều tra cặp conflict → ESCALATE lên NEMESIS → Research Council (thời điểm ③) thảo luận → **NEMESIS DECIDE** hướng | [SRC dòng 195, 1759] |
| 12 | **M2 scope creep** — audit lan rộng hơn yêu cầu | NEMESIS đọc worklog tại Checkpoint | Pivot trigger 🟡: thu hẹp về System Audit Charter gốc; phần mở rộng ghi thành task mới (không tự gộp) | [SRC dòng 3552] |

---

## §7. ACCEPTANCE CRITERIA `[TB-02 §7]`

Verify TB-02 đạt chuẩn khi:

- [ ] 1. Pipeline ASCII vẽ đủ: REQUEST → CLASSIFY → 7 nhiệm vụ NEMESIS → G1 (SIVIL+BELI) → G2 (LISMA) → G3 (HAN) → Checkpoints về NEMESIS → OUTPUT theo mission.
- [ ] 2. 7 nhiệm vụ NEMESIS đúng tên & thứ tự: RECEIVE → TRIAGE → DECOMPOSE → ASSIGN → MONITOR → DECIDE → FINALIZE; CLASSIFY là Bước 0.
- [ ] 3. G1 vẽ đúng cơ chế "SIVIL điều phối, BELI thực thi"; sub-agents 5–300.
- [ ] 4. Output M1 = Submission/Dataset/Documentation → User; output M2 = PROPOSAL → SELF-DIRECTION + note "chỉnh sửa trong WORKSPACE, áp LIVE sau APPROVED".
- [ ] 5. Hợp đồng §2 đủ 7 dòng; mỗi dòng nêu tài sản bắt buộc + điều khoản; có phần xử lý vi phạm.
- [ ] 6. Tier mapping đúng: T1 = CP2 · T2 = CP1+CP2 · T3 = CP1+CP2+CP3; CP định danh theo khối (sau G1/G2/G3).
- [ ] 7. Đội hình đúng: T1 không có G1/G3; T2 chỉ BELI (không SIVIL sub-agents) + không G3; T3 full + lặp mỗi part.
- [ ] 8. Bảng complexity: 3 tiêu chí × 3 mức; quy tắc 3 / 4–6 / 7–9 điểm; 2 bảng ví dụ M1 + M2 giữ nguyên nội dung nguồn.
- [ ] 9. Cột tín hiệu M2 [EXT] không mâu thuẫn bảng ví dụ M2 nguồn (audit 1 module = 7 điểm = Complex...).
- [ ] 10. Routing matrix 9 ô; mọi ô M2 đều kết thúc Proposal → SELF-DIRECTION (quy tắc vàng).
- [ ] 11. Edge cases: ambiguous → 1 câu; sai mission → pivot về CLASSIFY; sai tier → nâng/hạ qua DECIDE (tham chiếu TB-06).
- [ ] 12. Checkpoint Schedule: mỗi CP nêu NEMESIS đọc gì + câu hỏi VERIFY + nhánh YES/NO.
- [ ] 13. Mọi section chính có traceability `[TB-02 §n ← dòng]` + dấu [SRC]/[EXT]/[Q].

---

## §8. DECISIONS — [DECIDED v1.3] ĐÃ CHỐT (v1.3)

| Q | ✅ QUYẾT ĐỊNH (v1.3) |
|---|---|
| Q1 Confidence CLASSIFY | ✅ DR-C2: HIGH = ≥3 tín hiệu cùng chiều, 0 mâu thuẫn; MEDIUM = 1 mâu thuẫn → verify 1 vòng → **TIE-BREAK UP**; LOW = ≥2 mâu thuẫn → hỏi 1 câu. |
| Q2 M2 T1 verify-only | ✅ DR-C1: ngưỡng deterministic — không có đề nghị thay đổi → trả lời + Verify-Report mini + KB entry; có ≥1 đề nghị → Proposal 1-item bắt buộc. |
| Q3 nâng/hạ tier | ✅ DR-C3: **APPEND-ONLY** — task .md có `version: N` + `## CHANGELOG`; không rewrite. |
| Q4 CP1 của T2 | ✅ DR-C4: verify ĐẦY ĐỦ như T3 (checklist ~60% số item; 3 thành phần formal gate). |
| Q5 Council ① ở T2 | **CÓ — T2 vẫn họp council ①** sau DECOMPOSE: SIVIL tham vấn ad-hoc (consult-only, KHÔNG dispatch SA). |

- **Phụ thuộc:** TB-01 (danh tính/model stack/môi trường — bắt buộc đọc trước) · TB-06 (NEMESIS engine: DECIDE, nâng/hạ tier) · TB-08 (Knowledge Capture bù tier không qua G3) · TB-09 (handoff & worklog schema chi tiết) · TB-11 (Proposal Schema + vòng đời SELF-DIRECTION) · TB-12 (E2E đối soát).

---

## PHỤ LỤC A — TRACEABILITY MATRIX

| Section TB-02 | Section nguồn (ai-team-workflow.md) | Dòng | Mức |
|---|---|---|---|
| Header + §0 | — | — | [EXT] |
| §1 Pipeline tổng | Kiến trúc team · Tổng quan 3-Tier · 7 nhiệm vụ TL | 108–166, 4515–4552, 1837, 2639–2676 | [SRC] |
| §2 Hợp đồng các khối | Handoff Protocol (task.md/worklog/handoff flow) + External Memory + Deliverables | 3285–3337, 3436, 187, 210, 694, 1134, 1844 | [EXT] (suy từ nguồn) |
| §3.1–3.2 3-Tier | 3-Tier Workflow + Tổng quan 3-Tier | 3174–3242, 4515–4558 | [SRC] |
| §3.3 Checkpoint Schedule | Checkpoint Schedule (CP1/CP2/CP3) | 3465–3521, 4593 | [SRC] |
| §4 Bảng Complexity | Bảng quyết định complexity + 2 bảng ví dụ | 3244–3283 | [SRC] + [EXT] (cột tín hiệu M2, floor-rule) |
| §5 Routing matrix | Output theo mission + ví dụ mapping tier M2 | 160–166, 4549–4557 | [EXT] |
| §6 Error & Edge | CLASSIFY + thiết kế CLASSIFY + DECIDE + CP3 outcomes + G2 vòng lặp + G1 conflict/council + pivot scope creep | 1991–2013, 1862, 2698, 3460, 692, 702, 3509–3512, 195, 1759, 3552 | [SRC] + [EXT] |
| §7–§8 | verify + Decisions (chốt v1.3) | — | [EXT] · [DECIDED v1.3] |
