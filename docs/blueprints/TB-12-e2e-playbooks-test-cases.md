# TB-12 — E2E PLAYBOOKS & TEST CASES (ĐỐI SOÁT TOÀN TẬP 13 BLUEPRINT)

> 🧪 **TECHNICAL BLUEPRINT — AI RESEARCH TEAM (DUAL MISSION: M1 KAGGLE + M2 SYSTEM RESEARCH)**
> Nguồn chính: `upload/ai-team-workflow.md` — 🔁 VÍ DỤ THỰC TẾ: KAGGLE (dòng 4346–4425) · 🔁 VÍ DỤ THỰC TẾ: SYSTEM RESEARCH (4428–4511) · 📊 TỔNG QUAN 3-TIER (4515–4558) · 📎 GHI CHÚ THÊM (4560–4635) · tham chiếu ngang: COMPETITION SUMMARY (2443–2501) · Performance Baselines + KB entry (1538–1543, 1810) · NEO4J_DATABASE (1023, 1534, 3601)
> Version: 1.2 | Ngày: 2026-08-31 (review + fix — Task 9, 10-f) | Author: Mr. Robot (Z.ai Code) — Task 8-i · **nhóm D — Output & E2E** · file 13/13 — CHỐT TẬP
> Quy ước chung: TB-00 §1/§4/§5 · đối soát 12 file trước (TB-01 → TB-11) qua coverage matrix §4 · mọi số liệu playbook giữ nguyên từ nguồn
> **v1.3 (2026-09-01):** toàn bộ [Q] đã chốt theo DECISION-RECORD-v1.3.md (user ủy quyền, thorough-first) — xem Phụ lục Z nguồn.

---

## §0. 🎯 MỤC ĐÍCH & PHẠM VI `[TB-12 §0 ← TB-00 §2 — file 13/13]` `[EXT]`

- **Mục đích:** "chạy thử trên giấy" toàn pipeline research team bằng 2 playbook E2E (M1 — House Prices · M2 — chat TMO chậm) + bộ **18 test case cơ chế** (TC-01 → TC-18, bảng giấy — kiểm thử CƠ CHẾ, không phải code — TC-13/TC-14 thêm đợt v1.3 theo DECISION-RECORD; TC-15→TC-18 thêm đợt v1.5 theo TB-14 Solution Scoring) + **coverage matrix 13 blueprint**. Mọi mâu thuẫn giữa các TB sẽ lộ ra ở file này.
- **Ai dùng:** kỹ sư triển khai (smoke-test khi cài team vào TMO) · user (review tổng thể trước khi khởi động implement) · chính 5 agents (kịch bản vận hành tham chiếu).
- **Không bao gồm:** mã test tự động (test case dạng bảng giấy) · chi tiết JD từng agent (TB-03/04/05/06) · mọi số liệu không có trong nguồn (không bịa bổ sung).
- **Quy tắc:** mọi con số trong 2 playbook giữ nguyên nguồn (121s · 6.2s · 8 điểm · 0.115 RMSE log · 72 features...); mốc "ngày" trong timeline chỉ là mô phỏng minh họa `[EXT]`.

---

## §1. 🔄 PLAYBOOK E2E M1 — HOUSE PRICES (KAGGLE) `[TB-12 §1 ← nguồn dòng 4346–4425 + Competition Summary 2443–2501]` `[SRC]`

### 1.1 Tổng quan 6 phase (mission M1 — output cuối: Submission → User)

| Phase | Nội dung | Tier | Checkpoint verify | Output |
|---|---|---|---|---|
| P1 | Khởi động: CLASSIFY → TRIAGE → DECOMPOSE | COMPLEX | Decision log mission + tier | task_complex.md 4 parts + Research Protocol |
| P2 | Part 1 — EDA & Understanding data | COMPLEX | CP1+CP2+CP3 (T3) | 5 notebooks sạch + strategy recommendations |
| P3 | Part 2 — Feature Engineering (+ 1 bug chen ngang) | COMPLEX / SIMPLE | CP1+CP2+CP3 + quick-check | FE pipeline (chốt 72 features cuối) |
| P4 | Part 3 — Model Building & Tuning | COMPLEX | CP1+CP2+CP3 + CV-LB gap | 2 models nền + stacking meta |
| P5 | Part 4 — Ensemble | COMPLEX (nâng cấp) | CP1+CP2+CP3 | Stacking pipeline (Ridge meta) |
| P6 | Part 5 — Submit + FINALIZE | — | Final verify (CV-LB gap < 0.01) | 12 submissions + Final report + KB |

> Ví dụ chi tiết của nguồn dừng ở Phase 2 (dòng 4411 "... (G2 → G3 → TL như trên)") — P4–P6 dựng lại từ **Competition Summary** (2443–2501) theo đúng luật pipeline T3, đánh dấu `[SRC — suy từ 2443–2501]`.

### 1.2 Diễn biến từng phase

> Luật chạy chung (T3): mỗi part đi đủ **G1 → G2 → G3 → NEMESIS**, NEMESIS đọc worklog sau mỗi group (CP1/CP2/CP3), KHÔNG code — chỉ quyết định CONTINUE/PIVOT/ESCALATE (TB-09 §2–§3). Mọi group ghi worklog + Artifact Map khi xong (TB-09 §4, TB-10 §6).

**P1 — Khởi động (COMPLEX)** `[SRC 4350–4364]`
- NEMESIS đọc competition description → **CLASSIFY: M1 (Kaggle Research)** ✅ → chấm: Phạm vi 3 + Suy luận 3 + Rủi ro 2 = **8 → COMPLEX (T3)**.
- NEMESIS tạo `task_complex.md` — 4 parts: **Part 1** EDA & Understanding data · **Part 2** Feature Engineering · **Part 3** Model Building & Tuning · **Part 4** Ensemble & Submission.
- **Council ①** (sau DECOMPOSE — trước ASSIGN; TB-06 §10.1) challenge hypotheses → ASSIGN G1 cho Part 1. Output: task .md + Decision log + Research Protocol (M1).

**P2 — Part 1: EDA (COMPLEX)** `[SRC 4366–4396]`
- **G1:** SIVIL dispatch **5 sub-agents song song** — SA-01 missing value · SA-02 distribution · SA-03 correlation · SA-04 outlier · SA-05 categorical; BELI code cho mỗi analysis → **5 notebooks EDA + insights**.
- **G2 (LISMA):** review 5 notebooks → fix rendering bugs + fix incorrect statistical tests → suggestion: "Nên thêm interaction features giữa GrLivArea và OverallQual" → **5 notebooks sạch + suggestions**.
- **G3 (HAN):** review insights → "Missing value pattern gợi ý MNAR, không nên dùng simple imputation" → tối ưu visualization → suggestion: "Nên thử target encoding cho categorical thay vì one-hot" → **optimized EDA + strategy recommendations**.
- **NEMESIS:** đọc worklog sau mỗi group → **CP1** (sau G1 — đủ 5 notebook + insights) · **CP2** (sau G2 — sạch + suggestions) · **CP3** (sau G3 — strategy chốt) → chốt approach: "Tốt, chuyển sang Part 2: Feature Engineering" → gọi G1 cho Part 2.

**P3 — Part 2: Feature Engineering (COMPLEX) + bug chen ngang** `[SRC 4398–4424]`
- **G1:** SIVIL dispatch sub-agents parallel feature creation — **Group A** numeric (log transform, polynomial) · **Group B** categorical (target encoding, frequency encoding) · **Group C** interaction features · **Group D** time-based (nếu có); BELI code từng nhóm → **FE pipeline**; G2 → G3 → TL như P2.
- **Chen ngang — bug nhỏ (SIMPLE):** NEMESIS nhận ra "Feature X bị NaN sau transform" → chấm Phạm vi 1 + Suy luận 1 + Rủi ro 1 = **3 → SIMPLE (T1)** → giao thẳng **LISMA** fix NaN handling → LISMA code + self-review: "Thêm fillna(median) trước transform" → NEMESIS quick check → DONE → **quay lại Complex pipeline đang chạy — không gián đoạn** (lợi ích lớn của tier system, dòng 4424). Tri thức NaN-fix vào KB tại MONITOR/FINALIZE (T1 không qua G3 — TB-08 §7).

**P4 — Part 3: Model Building & Tuning** `[SRC — suy từ 2443–2501]`
- Pipeline T3 lặp như P2/P3 (G1 explore → G2 review → G3 tune) — NEMESIS checkpoint đủ 3 sau mỗi group.
- Sự kiện thật từ Summary: **pivot quay lại audit leakage khi CV-LB gap lớn** (DECIDE — Pivot → DECOMPOSED, TB-06 §12.3) → re-run Part 3 sau leakage fix (timeline: 2 ngày + re-run).
- Checkpoint verify (M1 — dòng 4591): metric cải thiện + no leakage + **CV-LB gap < 0.01** + hypothesis checked.
- Output: 2 models nền (XGBoost + LightGBM) cho ensemble.

**P5 — Part 4: Ensemble** `[SRC — suy từ 2443–2501]`
- NEMESIS **nâng cấp Part 4 lên COMPLEX để explore stacking** (DECIDE — Adjust; TB-06 §8) → full pipeline G1 → G2 → G3 (nâng tier = Adjust, ghi Decision log, viết task .md mới — TB-06 §12.3).
- G1 explore ensemble strategies (vd Branch D TB-03 §5.5: simple avg · weighted avg · stacking Linear/XGB meta · blending) → G2 review → G3 chốt meta-model.
- Key decisions: **chọn Stacking (Ridge meta) thay vì Weighted Avg** · chốt **72 features thay vì 180** (TB-06 §9.5).

**P6 — Part 5: Submit + FINALIZE** `[SRC — suy từ 2443–2501]`
- **12 submissions** (iterative improvement) → kết quả: **Best CV 0.115 (RMSE log) · Public LB 0.117 · Private LB 0.118 · CV-LB gap 0.002 ✅** (nhỏ = trustworthy) · tổng **7 ngày** (0.5 setup + 1 EDA + 2 features + 2 models + 1 ensemble + 0.5 submit).
- FINALIZE (TB-06 §9): Competition Summary (timeline + results + key decisions + lessons + artifacts) → **Knowledge Capture NGAY** (TB-08): 4 lessons vào KB — (1) ALWAYS audit leakage sau feature engineering · (2) K-Fold stacking cần K-Fold target encoding bên trong · (3) CatBoost weak trên small dataset → cân nhắc bỏ · (4) StratifiedKFold stable hơn KFold cho regression → **Final report → User** (M1 kết thúc ở user, không có Proposal).
- Artifacts cuối (nguồn 2443–2501): Code — 8 Python files, 1 pipeline · Models — 2 (XGBoost + LightGBM) + Stacking meta · Features — 72 selected · Submissions — 12.

### 1.3 Chuỗi artifact M1 xuyên suốt (dynamic chain)

`raw_data → clean_data → features → models → preds → submit` (dòng 4607) — mỗi phase sinh 1 lớp artifact mới; mọi group **PHẢI ghi Research Artifact Map khi xong + đọc Map khi bắt đầu** (TB-10 §5–§6); NEMESIS chỉ đọc worklog + Map (TB-10 §5).

---

## §2. 🔄 PLAYBOOK E2E M2 — "HỆ THỐNG CHAT TMO CHẬM" `[TB-12 §2 ← nguồn dòng 4428–4511]` `[SRC]`

> User request: **"Hệ thống chat của TMO chậm, nghiên cứu và đề xuất khắc phục."**
> Số liệu thật giữ nguyên: chat **121s** khi LLM key trả 401 → baseline tối ưu **6.2s** · **3 root causes** · options **A/B/C** (khuyến nghị A+B) · **p95 < 10s** · **3 checkpoint NEMESIS** · **4 parts**.

### 2.1 Dòng thời gian tổng quan (CLASSIFY → ... → verify tay (a))

| # | Bước | Ai thực hiện | Tham chiếu |
|---|---|---|---|
| 1 | CLASSIFY: "hệ thống, TMO, chậm, đề xuất khắc phục" → M2 (confidence cao — không cần hỏi lại) | NEMESIS | TB-06 §2 |
| 2 | TRIAGE: Phạm vi 3 + Suy luận 3 + Rủi ro 2 = 8 → COMPLEX (T3) | NEMESIS | TB-02 §4 |
| 3 | DECOMPOSE 4 parts: P1 Audit (COMPLEX) · P2 Root cause (MEDIUM) · P3 Options (COMPLEX) · P4 Proposal & Verification Plan (MEDIUM) | NEMESIS | TB-07 §5 |
| 4 | P1 qua G1: SIVIL dispatch 6 SA → BELI tổng hợp Audit Report | SIVIL + BELI | TB-03 §6 |
| 5 | LISMA chẩn đoán theo Suspect Locations → 3 root causes | LISMA | TB-04 §5 |
| 6 | HAN đọc Impact Chain → options A/B/C + recommendation | HAN | TB-05 §4 |
| 7 | 3 checkpoint: CP1 evidence · CP2 root cause ↔ logs · CP3 options | NEMESIS | TB-09 §3 |
| 8 | FINALIZE: PROPOSAL theo schema → route THẲNG SELF-DIRECTION → SUBMITTED | NEMESIS | TB-11 §1–§2 |
| 9 | APPROVED (user/agent ủy quyền) → áp Workspace → Live (thao tác riêng) | user/agent ủy quyền | TB-01 §3 |
| 10 | Verify tay (a): latency log trước/sau + manual test; (b) benchmark DEFERRED | user (NEMESIS theo dõi) | TB-11 §1 |

### 2.2 Phase 0 — Phân loại & Triage (NEMESIS) `[SRC 4432–4450]`

- CLASSIFY: tín hiệu "hệ thống, TMO, chậm, đề xuất khắc phục" → **mission_type: M2** (confidence: cao — không cần hỏi lại).
- TRIAGE: **Phạm vi = 3** (LLM pipeline + key pool + fail-open paths) · **Suy luận = 3** (cần đọc logs + code để tìm root cause) · **Rủi ro = 2** (thay đổi ảnh hưởng trải nghiệm user) → **tổng 8 → COMPLEX (Tier 3)**.
- DECOMPOSE — 4 parts (tier cho TỪNG part): **Part 1** Audit hiện trạng (COMPLEX) · **Part 2** Chẩn đoán root cause (MEDIUM) · **Part 3** Thiết kế options (COMPLEX) · **Part 4** Proposal & Verification Plan (MEDIUM) → council ① → ASSIGN.

### 2.3 Phase 1 — Part 1: Audit hiện trạng (COMPLEX) `[SRC 4452–4489]`

**G1 (SIVIL + BELI):** SIVIL dispatch **6 sub-agents đọc song song**:

| SA | Đối tượng audit | Phát hiện (nguồn) |
|---|---|---|
| SA-01 | dev.log — latency patterns | **phát hiện requests 121s!** |
| SA-02 | API route /api/query — query pipeline | — |
| SA-03 | service-key-pool — LLM key rotation logic | — |
| SA-04 | LLM client — retry + timeout behavior | — |
| SA-05 | neo4j/qdrant clients — connection handling | — |
| SA-06 | health check — service status hiện tại | — |

BELI tổng hợp thành **Audit Report**: "Chat request mất 121s khi LLM key trả 401 → pipeline retry lần lượt qua các key không hợp lệ rồi mới fail-open. Không có fail-fast, không có timeout ngắn, key pool không có health check."

**G2 (LISMA) — System Diagnostician:** đọc theo **Suspect Locations** (log warnings + error paths — TB-04 §5.3) — vòng lặp M2 (tối đa 3 vòng, **KHÔNG có bước apply** — TB-04 §5.4):

```
1. ĐỌC LOG   → theo Suspect Locations từ Artifact Map
2. ĐỊNH VỊ   → tách triệu chứng (121s) khỏi nguyên nhân
3. CHẨN ĐOÁN → root cause list — mỗi cái có evidence + severity
4. ĐỀ XUẤT   → fix proposal + patch mẫu viết trong Workspace
5. NEMESIS VERIFY (CP2: root cause khớp code ↔ logs?)
```

- **Root cause #1:** Retry mù quáng khi 401 (4xx không retry được) · **#2:** Key pool không health check · **#3:** Không timeout cho LLM calls.
- Đề xuất trong report: **fail-fast + timeout + key health check** → **KHÔNG sửa code TMO — chỉ chẩn đoán + đề xuất** ✋ (patch mẫu viết trong Workspace — TB-04 §5.1).

**G3 (HAN) — Architecture Proposer:** đọc theo **Impact Chain** (key pool → LLM calls → user latency — TB-05 §4), load KB Performance Baselines (chat latency no config **121s → 6.2s** sau tối ưu — dòng 1541):

| Option | Mô tả | Effort | Ghi chú (nguồn) |
|---|---|---|---|
| A | Fail-fast + timeout | S | tác động lớn |
| B | Key health check + circuit breaker | M | — |
| C | Response cache | L | cần benchmark |

Recommendation: **A + B ngay; C để khi có benchmark** — mỗi option kèm **Verification Plan (deferred)**.

**NEMESIS — 3 Checkpoints** `[SRC 4485–4488]`:
- **CP1:** Audit đủ evidence? (mỗi finding có file:line + log) ✅
- **CP2:** Root cause khớp code ↔ logs? (LISMA verify) ✅
- **CP3:** Mỗi option có trade-offs + verification plan? ✅

### 2.4 Phase 2 — Proposal → SELF-DIRECTION (NEMESIS FINALIZE) `[SRC 4491–4509]`

NEMESIS tổng hợp **PROPOSAL** theo Proposal Schema (TB-11 §1) — nội dung nguyên nguồn:

```
Problem: Chat latency 121s khi LLM key fail
         (evidence: dev.log + key-pool code path)
Root Cause: retry mù quáng + không health check + không timeout
Options: A (fail-fast) / B (health check) / C (cache)
Recommendation: A+B — Expected impact: 121s → < 10s
Risk & Rollback: config-level change, rollback = revert env
Verification Plan:
  (a) NGAY: so sánh latency log trước/sau + manual test
      "gửi 1 câu hỏi khi 1 key cố tình sai"
  (b) DEFERRED: benchmark A/B latency khi hệ được xây
      (metric: p50/p95 chat latency, acceptance: p95 < 10s)
→ Route thẳng SELF-DIRECTION
→ Status: SUBMITTED — chờ user/agents ủy quyền phê duyệt
```

- **SUBMITTED → APPROVED** → thay đổi áp **từ Workspace lên Live System** (user hoặc agent ủy quyền — **thao tác riêng**):

```
SUBMITTED (SELF-DIRECTION)
  → chờ user HOẶC agent ủy quyền phê duyệt
  → APPROVED → áp thay đổi từ Workspace lên Live System (thao tác riêng)
  → verify tay (a): so sánh latency log trước/sau
     + manual test "gửi 1 câu hỏi khi 1 key cố tình sai"
  → benchmark (b) DEFERRED — khi hệ A/B được xây
```
- **Verify tay (a):** so sánh latency log trước/sau + manual test "gửi 1 câu hỏi khi 1 key cố tình sai"; benchmark A/B (b) **DEFERRED** đến khi hệ được xây (p50/p95, acceptance p95 < 10s).
- Knowledge Capture trong mission: LISMA đề xuất (KB Candidate) → HAN ghi **KB-20250612-002** — System Anti-Patterns: "LLM key 4xx → KHÔNG retry mù — fail-fast ngay" (evidence: log 121s retry mù vs 6.2s fail-fast — dòng 1810).
- **NEMESIS theo dõi sau SUBMITTED** (TB-06 §9.8): APPROVED → đóng task + KB lesson; REJECTED → phân tích lý do, re-DECOMPOSE phần liên quan hoặc đóng mission; REVISED → giao lại group bổ sung → update → re-SUBMIT.
- **Điểm quan trọng (dòng 4511):** toàn bộ mission M2 **KHÔNG sửa bất kỳ file nào của TMO** — output duy nhất là Proposal document; implementation (sau khi APPROVED) và benchmark A/B là thao tác riêng.

### 2.5 Chen ngang tier T1 — "Verify NEO4J_DATABASE" `[SRC 1023, 1534, 3601, 4555]`

```
Request: "NEO4J_DATABASE=neo4j — có đúng DB thật không?"
→ TRIAGE: "Verify 1 config có đúng không" → SIMPLE (NEMESIS → LISMA → NEMESIS)
→ LISMA: đối chiếu config ↔ code ↔ logs (Suspect S5 — config mismatch)
   → phát hiện: NEO4J_DATABASE sai tên DB → connection fail âm thầm
   → KHÔNG tự sửa Live System — đề xuất nằm trong kết luận
→ NEMESIS: chốt kết luận verify + KB Config Lesson
   (C1: NEO4J Aura — user = instance ID 8-hex, dòng 1534)
→ tri thức vào KB tại MONITOR/FINALIZE (T1 không qua G3 — TB-08 §7)
```

Minh họa 2 điều: mapping tier M2 của nguồn ("Verify 1 config có đúng không" → **Simple**, dòng 4555) và edge E2 của TB-11 §5 — verify thuần túy không sinh thay đổi → trả kết luận + KB, không cần Proposal 1-item `[DECIDED v1.3 — DR-C1]`.

*(✅ chốt v1.3: golden-run PB-M2 sẽ dựng từ mission M2 thật đầu — §7 Q2.)*

---

## §3. 🧪 BẢNG TEST CASE TC-01 → TC-18 (CƠ CHẾ — BẢNG GIẤY) `[TB-12 §3 ← đối soát TB-01 → TB-11 + TB-14]` `[EXT]`

> Cách dùng: mỗi TC = 1 kịch bản runtime giả lập; "verify" = đọc lại artifact (worklog/Decision log/KB/Proposal) kiểm kỳ vọng. KHÔNG phải test code — kiểm cơ chế thiết kế.

### 3.1 Vận hành TC khi triển khai (4 bước)

1. **Chọn TC theo khu vực nghi ngờ** — tra coverage matrix §4 (TC → TB → section) trước khi sửa code/Instructions.
2. **Mô phỏng kịch bản** trên 1 task thật hoặc fixture (vd TC-03: cài 2 SA trả kết quả trái ngược).
3. **Thu artifact** đúng schema (worklog TB-09 §4 · Decision log TB-06 §13 · KB entry TB-08 §5 · Proposal TB-11 §1).
4. **Đối chiếu kỳ vọng** — fail → xác định blueprint liên quan (không vá ở runtime trước khi vá thiết kế: TB-00 §5 "thay đổi thiết kế cập nhật nguồn trước, blueprint sau").

### 3.2 Bảng test case

| ID | Kịch bản | Kỳ vọng | Verify bằng | Tham chiếu |
|---|---|---|---|---|
| TC-01 | Request ambiguous — không rõ Kaggle hay System Research | NEMESIS KHÔNG đoán mò; hỏi đúng **1 câu** phân luồng; classify được sau câu trả lời | Decision log có 1 câu hỏi + mission_type kế tiếp | TB-06 §2 |
| TC-02 | Mission M2 tier T2 (vd "chẩn đoán chat latency cao") | Pipeline NEMESIS → BELI (report) → LISMA (root cause) → NEMESIS; **output vẫn là Proposal 1-module → SELF-DIRECTION** (không final report user) | Đầu ra mission = Proposal theo schema TB-11 §1; routing CP1+CP2 | TB-02 §5 |
| TC-03 | 2 sub-agents (SA-07 vs SA-09) trả kết quả trái ngược | SIVIL điều tra bắt buộc (đối chiếu context/evidence; SA điều tra nếu cần); không giải thích được → **ESCALATE NEMESIS trình bày CẢ 2 INTERPRETATION** + evidence từng bên | Worklog G1 có mục điều tra + khối escalation | TB-03 §5.3 |
| TC-04 | Vòng verify LISMA phát hiện bug mới do fix trước gây ra | **Ghi entry riêng Type = Regression** trong Bugs Found + worklog; fix trong vòng mới; re-test cả test của bug gốc; lặp 2 lần từ cùng fix → ESCALATE (mùi architectural) | Worklog có Regression row + vòng mới có re-test | TB-04 §9.1 (+ §4, §7) |
| TC-05 | KB trống (cold start — lần chạy đầu) | HAN load KB Phase 1 → thấy trống → **seed bằng starter KB** (các bảng lessons/anti-patterns/baselines chuẩn nguồn); không crash, không skip | KB sau seed có categories cơ bản; vòng G3 tiếp tục ANALYZE bình thường | TB-05 §9 (E1) |
| TC-06 | LISMA chẩn đoán nhưng claim thiếu evidence (không file:line + log excerpt) | Claim bị loại khỏi Diagnostic Report / vòng mới đọc thêm — **EVIDENCE-GAP** nếu lặp; **KHÔNG tự apply fix**; NEMESIS verify CP2 trả về nếu không pass | Diagnostic Report mọi root cause có evidence; 0 thao tác apply lên Live | TB-04 §5 (§5.4, §5.6) + §7 |
| TC-07 | G1 chạy 1 part: sub-agents xong, BELI chuẩn bị code | **Council ② (sau SYNTHESIZE) diễn ra TRƯỚC khi BELI code** — chốt specs; tri thức mới ghi KB NGAY | Thứ tự log: SYNTHESIZE → council ② → SPEC → BELI code | TB-03 §4 (§4.4) |
| TC-08 | Task tier SIMPLE (M1/M2) — không qua G3 | Tri thức vẫn vào KB: **NEMESIS ghi tại MONITOR + FINALIZE** (quy tắc vàng #2); không để tri thức thất lạc | KB có entry sinh từ task T1; worklog FINALIZE có KB capture | TB-08 §7 (+ §2) |
| TC-09 | Giữa mission M2, NEMESIS đọc worklog thấy claim thiếu evidence (trigger 🔴) | **PIVOT** — dừng part hiện tại, quay lại part liên quan / giao group bổ sung; KHÔNG tiếp tục với claim không evidence | Decision log có lý do pivot + part được quay lại | TB-09 §6 (+ TB-06 §8) |
| TC-10 | BELI viết POC cho Option A (fail-fast) trong mission M2 | **POC + diff chỉ trong Workspace** (bản clone); Live System chỉ đọc (evidence); diff kèm Proposal khi SUBMITTED | Mọi file sửa nằm trong Workspace; log Live System không đổi | TB-01 §3 |
| TC-11 | Proposal P-YYYYMMDD-NNN bị REJECTED kèm lý do | NEMESIS phân tích → **quay lại research** (re-DECOMPOSE phần liên quan) hoặc đóng mission — Decision log; không re-submit nguyên trạng | Trạng thái REJECTED → RESEARCHING; Decision log có lý do | TB-11 §2 (+ TB-06 §9.8) |
| TC-12 | Model chính lỗi giữa task → fallback chain | Agent **GIỮ NGUYÊN vai trò + JD**; task KHÔNG reset; worklog ghi dòng "model switched" | Task tiếp tục đúng trạng thái; worklog có dòng model switched | TB-01 §2 (+ TB-09 §10 E7) |
| TC-13 | **"task .md thiếu Success Criteria"** (phủ TB-07 decomposition gate) — mission M2 T2: NEMESIS DECOMPOSE 2 parts, 1 task .md thiếu trường Success Criteria | **Council ①** (bắt buộc mọi mission — TB-07 §11 Q5) phát hiện thiếu → part KHÔNG được ASSIGN cho tới khi NEMESIS bổ đủ Success Criteria (append amendment theo DR-C3, có CHANGELOG entry) | task .md có đủ Success Criteria + entry CHANGELOG amendment TRƯỚC khi ASSIGN; transcript council ① ghi phát hiện thiếu | TB-07 §3 (task template) + DECISION-RECORD v1.3 (TB-12 Q1) |
| TC-14 | **"worklog thiếu Artifact Map → không giao group kế"** (phủ TB-09 §10 E4 / TB-10) — mission M2 T3: G1 xong part 1 nhưng worklog entry thiếu khối Artifact Map | **Gate handoff (TB-09) chặn — KHÔNG giao group kế**; SIVIL phải bổ sung map (1 map G1 duy nhất — TB-10 §13 Q6) trước khi NEMESIS MONITOR pass | worklog part 1 có đủ khối Artifact Map (1 map G1 duy nhất) trước khi part kế ASSIGN; worklog/Decision log ghi lý do chặn | TB-09 §10 E4 + TB-10 §13 Q6 + DECISION-RECORD v1.3 (TB-12 Q1) |

> 2 test case bổ sung đợt v1.3 (✅ chốt §7 Q1): `[TB-12 §3.2 ← TB-07 §3 (task template) + DECISION-RECORD v1.3 (TB-12 Q1)]` `[EXT]` (TC-13) · `[TB-12 §3.2 ← TB-09 §10 E4 + TB-10 §13 Q6 + DECISION-RECORD v1.3 (TB-12 Q1)]` `[EXT]` (TC-14).

**4 test case bổ sung đợt v1.5 (✅ theo TB-14 Solution Scoring & Selection — Phụ lục Z2 nguồn):** `[TB-12 §3.2 ← TB-14 §10 + Phụ lục Z2]` `[EXT]`

| TC | Kịch bản | Hành vi đúng | Verify | Tham chiếu |
|---|---|---|---|---|
| TC-15 | **"Giả thiết không thiết kế được kill-criteria"** — tournament TB-14 §3: 3 giả thiết, 1 cái không thể falsify | Giả thiết đó tối đa PROBABLE, KHÔNG thể CONFIRMED (D2 tối đa 3 — §1.2); vào vòng 4 phải kèm falsification plan | DB `HypothesisRecord.killCriteria` NOT NULL khi status=CONFIRMED | TB-14 §1.2/§3 |
| TC-16 | **"Scorecard kỳ vọng 4.2 — thực đo 2.1"** — experiment TB-14 §2.3 | Delta >1.0 → lesson calibration ghi KB; council ⑤ verdict CONTINUE-ITERATE (KHÔNG CONVERGE) | KB có entry Calibration Lesson + CouncilTranscript kind=5 verdict đúng | TB-14 §2.3/§6.3 |
| TC-17 | **"Reuse pattern KB sai bối cảnh"** — context-fit TB-14 §5: pattern có pre-condition "4 key active" nhưng mission single-key | HAN chặn APPLICABLE → giải pháp vào tournament như ứng viên mới kèm adaptation | worklog có khối `contextfit` verdict TOURNAMENT | TB-14 §5.2 |
| TC-18 | **"CONVERGE winner — DIRECT-APPLY vs Proposal (kịch bản đôi)"** — TB-14 §7: (a) risk LOW + deploy_mode=auto + T2 + rollback 10m + đơn module; (b) risk HIGH, còn lại đủ | (a) DIRECT-APPLY: LISMA apply RWV + verify + KB + **notify user sau khi xong**; (b) KHÔNG direct → Proposal P-* SUBMITTED | Decision Log dòng deploy_route=direct kèm 5 điều kiện; Proposal DB status | TB-14 §7 |

---

## §4. 🗺️ BẢNG ĐỐI SOÁT 14 BLUEPRINT — COVERAGE MATRIX `[TB-12 §4 ← đối soát toàn tập + TB-14 v1.5]` `[EXT]`

| TB | Section then chốt | Phủ bởi | Ghi chú gap |
|---|---|---|---|
| TB-00 | §1 quy ước danh tính/ID/model stack · §5 traceability | mọi TC (chuẩn đối soát) | — |
| TB-01 | §2 model stack fallback · §3 Live System vs Workspace | TC-10, TC-12 | — |
| TB-02 | §3 3-tier + CP · §5 routing matrix 9 ô | TC-02, TC-08, PB §1–§2 | — |
| TB-03 | §4 G1 workflow (council ②) · §5.3 conflict SA · §6 audit M2 | TC-03, TC-07, PB §2.3 | — |
| TB-04 | §4 severity/loại bug · §5 Mode M2 · §7 EVIDENCE-GAP · §9.1 regression | TC-04, TC-06, PB §2.3 | — |
| TB-05 | §2.5 Proposal Item · §4 Mode M2 options · §9 E1 cold start | TC-05, PB §2.3, TC-11 (gián tiếp) | — |
| TB-06 | §2 CLASSIFY · §8 DECIDE/pivot · §9.7 4 gate · §12 state machine | TC-01, TC-09, TC-11, PB §1–§2 | — |
| TB-07 | §2 quy trình 5 bước decompose · §3 task .md · §6 checklist | PB §1 P1 + PB §2.2 (4 parts) + **TC-13 (v1.3)** | **TC-13 đã thêm v1.3 — §7 Q1 [DECIDED]** |
| TB-08 | §2 quyền ghi KB · §7 quy tắc vàng | TC-08, PB §2.4 (KB-20250612-002) | — |
| TB-09 | §3 checkpoint · §6 pivot triggers · §10 E7 model switched | TC-09, TC-12, PB §2.1 | — |
| TB-10 | §3 Artifact Map format · §5 chiến lược đọc theo group | PB §2.3 (SA theo map · LISMA Suspect · HAN Impact Chain) + **TC-14 (v1.3)** | **TC-14 đã thêm v1.3 — §7 Q1 [DECIDED]** |
| TB-11 | §1 schema 8 trường · §2 vòng đời · §4 checklist SUBMIT | TC-11, PB §2.4, TC-02 | — |
| TB-12 | §3 TC · §4 matrix · §1–§2 playbook | tự đối soát (file này) | — |
| TB-14 | §1–§2 rubric A/B · §3 tournament · §5 context-fit · §6 council ⑤ · §7 deploy rule | **TC-15, TC-16, TC-17, TC-18 (v1.5)** | **4 TC thêm v1.5 — phủ đủ rubric + tournament + context-fit + deploy** |

> Cách đọc: "Phủ bởi" = TC (bảng §3) hoặc PB (playbook §1/§2); "—" ở cột gap = không phát hiện khoảng trống. 2 gap (TB-07, TB-10) đã khai báo tại §7 Q1 — ✅ chốt v1.3: đã khép bằng TC-13/TC-14 (bảng §3.2), không còn gap.

---

## §5. 📊 TỔNG QUAN 3-TIER + BẢNG TÓM TẮT CUỐI NGUỒN `[TB-12 §5 ← nguồn dòng 4515–4558 + 4560–4635]` `[SRC]`

### 5.1 Bảng 3-tier (khi nào T1/T2/T3 — nguyên tắc nguồn)

| Tier | Điểm | Đường đi | Thời gian | Output |
|---|---|---|---|---|
| SIMPLE | 3 | TL → G2 → TL → DONE | ~1–2 bước | M1: fix nhỏ + worklog → User · M2: **PROPOSAL → SELF-DIRECTION** |
| MEDIUM | 4–6 | TL → G1 → G2 → TL → DONE | ~2–3 bước | M1: feature/model/EDA hoàn chỉnh → User · M2: **PROPOSAL → SELF-DIRECTION** |
| COMPLEX | 7–9 | TL → G1 → G2 → G3 → TL → **loop mỗi part** | ~4+ bước lặp mỗi part | M1: Submission/Dataset/Docs → User · M2: **PROPOSAL → SELF-DIRECTION** |
> Cột Output per-tier: tổng hợp `[EXT]` theo TB-02 §5 (routing matrix 9 ô) — nguồn 4549–4551 + 160–166 chỉ tách output theo mission (M1 → User · M2: PROPOSAL → SELF-DIRECTION), không tách theo tier.

**Ví dụ mapping tier (M2 — nguyên văn nguồn):** "Verify 1 config có đúng không" → **Simple** (NEMESIS → LISMA → NEMESIS) · "Chẩn đoán chat latency cao" → **Medium** (NEMESIS → G1 → LISMA → NEMESIS) · "Redesign kiến trúc bộ nhớ" → **Complex** (full pipeline + HAN). Chi tiết routing 9 ô + proposal theo tier (1-item / 1-module / multi-item): TB-02 §5. Checkpoint mapping: T1 chỉ CP2 · T2 CP1+CP2 · T3 đủ 3 (dòng 4593).

### 5.2 Bảng tóm tắt cuối nguồn (4560–4635)

| Khối | Quy tắc then chốt (nguồn) |
|---|---|
| **NEMESIS (TL) chiến lược** | Chỉ đọc **Worklog + Artifact Map**, KHÔNG đọc code (trừ ESCALATE / verify claim thiếu evidence); Research Loop Controller; M2: phân loại mission + tổng hợp Proposal + route SELF-DIRECTION; chủ trì Research Council; KB ghi NGAY |
| **SIVIL (G1)** | Sub-agent pool **5–300** parallel exploration; M2: dispatch theo Module Map; SYNTHESIZE → chọn top-K cho BELI; council với NEMESIS; ghi KB trực tiếp |
| **BELI (G1 Coder)** | Code lượt đầu theo spec — nhanh, structure tốt, đúng spec; M2: research report + **POC trong Workspace** (bản clone — không đụng Live System) |
| **LISMA (G2) chiến lược** | Vòng Đọc → Tìm → Sửa → Kiểm tra → Lặp đến sạch (kể cả regression do fix trước); đọc theo **Leakage/Bug Locations (M1) / Suspect Locations (M2)** — selective, safety-first; Priority #1 = Data Leakage (M1) / **System Safety (M2)** |
| **HAN (G3) chiến lược** | Self-evolving qua KB; đọc theo **Metric Impact Chain (M1) / Impact Chain (M2)** — wider, metric-driven; Priority #1 = Metric Improvement (M1) / **System Leverage (M2)**; M2: Architecture Proposer + KB Curator |
| **RWV Loop** | WRITE (worklog + Map + Metrics/Findings + KB) → READ (TL sau mỗi Checkpoint, metrics/findings trước) → VERIFY (M1: metric + no leakage + CV-LB gap < 0.01; M2: evidence + completeness + feasibility) → UPDATE protocol/charter; Checkpoint: T1 chỉ CP2 · T2 CP1+CP2 · T3 đủ 3; Pivot M1 🔴: data leakage / CV-LB gap > 0.02 / metric WORSE · Pivot M1 🟡: model plateau 3x / metric fluctuation / feature eng không hiệu quả; Pivot M2 🔴: claim thiếu evidence / code mâu thuẫn logs / proposal phá compatibility · Pivot M2 🟡: scope creep / nghiên cứu trùng lặp / POC không tái hiện |
| **Quy tắc Artifact Map** | Mỗi G PHẢI **ghi Map khi xong + đọc Map khi bắt đầu**; artifact mới → update Map ngay; format M1 `artifact:type:metric_impact` · M2 `file:type:relevance:status`; dynamic chain M2: source_code → analysis_report → findings → proposal → POC |
| **Model Policy** | Kimi-k3 chính — mọi agent, mọi sub-agent; fallback DeepSeek v4 Pro → DeepSeek v4 Flash → MiniMax-M3; agent giữ vai trò + JD khi fallback; **phân vai theo JD + Instructions (role-based) — KHÔNG theo model**; **tên agent ≠ tên model** |
| **Proposal → SELF-DIRECTION** | Schema 8 trường; Verification Plan (a) tay NGAY + (b) DEFERRED; vòng đời DRAFT → SUBMITTED → APPROVED/REJECTED/REVISED; người duyệt = user HOẶC agents ủy quyền; **quy tắc vàng: M2 KHÔNG sửa Live System** — mọi thay đổi sống trong Workspace + Proposal, áp sau APPROVED |
| **Knowledge Capture** | Phát hiện hay → ghi KB **NGAY trong cùng phiên**; quyền ghi trực tiếp: NEMESIS (MONITOR/DECIDE/FINALIZE), SIVIL (SYNTHESIZE), HAN (G3 + Curator); BELI/LISMA đề xuất qua "KB Candidates"; Research Council 4 thời điểm; KB Write Protocol 4 bước (SEARCH → FORMAT → WRITE → CURATE); tri thức không mất kể cả tier không qua G3 |

---

## §6. ✅ ACCEPTANCE CRITERIA — CHO CHÍNH PLAYBOOK `[TB-12 §6]` `[EXT]`

- [ ] **AC1.** PB-M1 đủ 6 phase, mỗi phase nêu tier/parts/checkpoint/output (bảng §1.1); mission/group được gắn cấp section caption/§1.2 (mission M1 ở caption §1.1, hoạt động từng group ở §1.2 từng phase) — truy vết được về nguồn 4346–4425 (P1–P3) và 2443–2501 (P4–P6, có đánh dấu "suy từ").
- [ ] **AC2.** PB-M1 có case chen ngang tier SIMPLE giữa pipeline COMPLEX, thể hiện nguyên tắc "không gián đoạn" (dòng 4424).
- [ ] **AC3.** PB-M2 giữ nguyên đủ số liệu thật: 121s khi 401 · 6.2s baseline · 3 root causes · options A/B/C (khuyến nghị A+B) · p95 < 10s · 3 checkpoint NEMESIS · 4 parts · 6 SA.
- [ ] **AC4.** PB-M2 thể hiện quy tắc vàng: toàn mission KHÔNG sửa file TMO — output duy nhất là Proposal; áp Workspace → Live là thao tác riêng sau APPROVED (dòng 4511).
- [ ] **AC5.** PB-M2 Verification Plan đủ (a) kiểm chứng tay NGAY + (b) benchmark DEFERRED (p50/p95 · acceptance p95 < 10s).
- [ ] **AC6.** 18 TC đủ 5 cột (ID · kịch bản · kỳ vọng · verify · tham chiếu — gồm TC-13/TC-14 thêm v1.3 + TC-15→TC-18 thêm v1.5 theo TB-14); không TC nào tham chiếu section không tồn tại trong blueprint tương ứng.
- [ ] **AC7.** Coverage matrix phủ đủ 13 file TB; mọi TB ≥ 1 nguồn phủ (TC hoặc playbook); gap được khai báo (§7 Q1).
- [ ] **AC8.** Mọi section chính có traceability `[TB-12 §n ← nguồn dòng a–b]` + [SRC]/[EXT]/[Q].
- [ ] **AC9.** Bảng 3-tier + mapping M2 trùng khớp nguồn 4515–4558 (điểm, đường đi, 3 ví dụ mapping nguyên văn).
- [ ] **AC10.** Không mâu thuẫn quy ước TB-00 §1: 5 agent đúng tên vai trò; model stack chỉ xuất hiện trong context Model Policy; Live System chỉ đọc / Workspace mới được sửa.
- [ ] **AC11.** Test case dạng bảng giấy — không yêu cầu chạy code; đủ chi tiết để chuyển thành kịch bản runtime khi triển khai.
- [ ] **AC12.** Bảng tóm tắt §5.2 phản ánh đủ 10 khối cuối nguồn (NEMESIS/SIVIL/BELI/LISMA/HAN + RWV + Artifact Map + Model + Proposal + KB) không bỏ quy tắc vàng nào.

---

## §7. DECISIONS — [Q] ĐÃ CHỐT (v1.3) `[TB-12 §7]` `[DECIDED v1.3]`

| # | Câu hỏi | Phụ thuộc | ✅ QUYẾT ĐỊNH (v1.3) |
|---|---|---|---|
| Q1 | TB-07 (decompose) + TB-10 (Artifact Map) chưa có TC riêng — chỉ phủ qua playbook. Có nên thêm TC-13+ ("task .md thiếu Success Criteria" / "Map thiếu → không giao group kế" theo TB-09 §10 E4) ở đợt mở rộng? | TB-07 §6, TB-10 §10 | **CÓ — TC-13 + TC-14 đã thêm ngay đợt v1.3** (xem §3.2) |
| Q2 | PB-M2 không có mốc thời gian thật trong nguồn (chỉ M1 có "7 ngày") — khi chạy thật cần log chuẩn TB-09 §4; có cần dựng "golden run" mẫu không? | TB-09 §4 | **CÓ** — dựng golden-run PB-M2 từ log mission M2 thật đầu tiên, chuẩn hóa schema TB-09 §4; lưu làm artifact đối chiếu E2E |
| Q3 | TC-02 phụ thuộc [Q] TB-02 §5 / TB-11 §5 E2 — ngưỡng "mission verify thuần túy" không sinh Proposal cần user chốt trước khi freeze tập | TB-02 §5, TB-11 §7 Q1 | **ĐÃ GIẢI** (✅ DR-C1) — tập test case freeze được |
| Q4 | "Agent được ủy quyền" phê duyệt Proposal là ai (NEMESIS bị cấm tự duyệt — TB-06 §9.8)? Cần user chỉ định khi triển khai SELF-DIRECTION | TB-11 §7 Q2 | ✅ **DR-C5** — deputy = **SIVIL mặc định / HAN cho KB-domain**; không author, NEMESIS cấm tự duyệt, có thời hạn |

---

## PHỤ LỤC A — TRACEABILITY MATRIX

| Nguồn (dòng) | Nội dung nguồn | Section TB-12 |
|---|---|---|
| 4346–4364 | Ví dụ M1 — Phase 1 Khởi động (CLASSIFY + chấm 8 + 4 parts) | §1.1, §1.2 P1 |
| 4366–4396 | Phase 1 Part 1 EDA — 5 SA + G2 + G3 + NEMESIS chốt | §1.2 P2 |
| 4398–4411 | Phase 2 Part 2 FE — 4 group + "G2 → G3 → TL như trên" | §1.2 P3 |
| 4413–4424 | Bug nhỏ chen ngang SIMPLE + "chen ngang không gián đoạn" | §1.2 P3 |
| 2443–2501 | Competition Summary — timeline/results/decisions/lessons | §1.1, §1.2 P4–P6 |
| 4428–4450 | Ví dụ M2 — Phase 0 CLASSIFY + TRIAGE + DECOMPOSE 4 parts | §2.1, §2.2 |
| 4452–4489 | Phase 1 — 6 SA + Audit Report + 3 root causes + options A/B/C + 3 CP | §2.3 |
| 4491–4509 | Phase 2 — Proposal đầy đủ + SUBMITTED + verification (a)/(b) | §2.4 |
| 4510–4511 | "Toàn mission M2 KHÔNG sửa file TMO" | §2.4 |
| 1023, 1534, 3601, 4555 | NEO4J_DATABASE + Config Lesson C1 + mapping tier "verify 1 config" | §2.5 |
| 1538–1543, 1810 | Performance Baselines (121s → 6.2s) + KB-20250612-002 | §2.3, §2.4 |
| 4515–4558 | Tổng quan 3-Tier + 3 ví dụ mapping M2 | §5.1 |
| 4560–4635 | Ghi chú thêm — chiến lược agents + RWV + Map + Proposal + KB | §5.2 |
| TB-01 → TB-11 | Toàn bộ 12 blueprint trước (cơ chế được TC kiểm) | §3, §4 |
| 4585–4598 | Bảng RWV Loop + Checkpoint + Pivot Triggers (nguồn gốc của §5.2) | §5.2 |
| 4600–4613 | Bảng Directed Reading + Artifact Map + chiến lược TL/G2/G3 | §5.2 |
