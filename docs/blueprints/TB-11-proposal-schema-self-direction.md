# TB-11 — PROPOSAL SCHEMA & SELF-DIRECTION ROUTE (CHUẨN ĐẦU RA MISSION M2)

> 📐 **TECHNICAL BLUEPRINT — AI RESEARCH TEAM (DUAL MISSION: M1 KAGGLE + M2 SYSTEM RESEARCH)**
> Nguồn chính: `upload/ai-team-workflow.md` — section 📨 PROPOSAL SCHEMA (dòng 4288–4344) · tham chiếu ngang: ví dụ M2 chat 121s (4428–4511) · bảng Proposal → SELF-DIRECTION (4615–4623) · FINALIZE M2 (2443–2501) · Verification Plan (a)/(b) (1393–1395)
> Version: 1.2 | Ngày: 2026-08-31 (review + fix — Task 9, 10-f) | Author: Mr. Robot (Z.ai Code) — Task 8-i · **nhóm D — Output & E2E** · file 12/13
> Quy ước chung: TB-00 §1 (danh tính agent · model stack · Live/Workspace · ID P-YYYYMMDD-NNN) + §5 ([SRC]/[EXT]/[Q] — từ v1.3: đã chuyển thành [DECIDED v1.3]) · NEMESIS FINALIZE: TB-06 §9.7–9.8 · Proposal items HAN: TB-05 §2.5 · E2E: TB-12 §2
> **v1.3 (2026-09-01):** toàn bộ [Q] đã chốt theo DECISION-RECORD-v1.3.md (user ủy quyền, thorough-first) — xem Phụ lục Z nguồn.

---

## §0. 🎯 MỤC ĐÍCH & PHẠM VI `[TB-11 §0 ← nguồn dòng 4288–4290 + TB-00 §2]` `[EXT]`

- **Mục đích:** chuẩn hóa **PROPOSAL — artifact duy nhất mà toàn bộ pipeline M2 hội tụ về** (dòng 4290): "Toàn bộ pipeline M2 hội tụ về 1 artifact duy nhất: PROPOSAL. Đây là thứ SELF-DIRECTION đọc để quyết định."
- **Ai đọc:** NEMESIS (form khi FINALIZE tổng hợp output G1/G2/G3) · module SELF-DIRECTION + user/agent được ủy quyền (parse & phê duyệt) · HAN (sinh proposal items — hạt của Proposal) · SIVIL/BELI/LISMA (§3: artifact mình nạp vào trường nào) · kỹ sư triển khai.
- **Bao gồm:** schema 8 trường + metadata · vòng đời + route SELF-DIRECTION · mapping trường ← artifact · checklist sẵn sàng SUBMIT · edge cases. **Không bao gồm:** cách NEMESIS điều phối (TB-06 §9) · sinh proposal items tại G3 (TB-05 §2.5) · playbook E2E (TB-12 §2) · hạ tầng lưu Proposal/module SELF-DIRECTION (§7 Q2).

---

## §1. 📨 PROPOSAL SCHEMA — 8 TRƯỜNG + METADATA `[TB-11 §1 ← nguồn dòng 4292–4329]` `[SRC]`

### 1.1 Template chuẩn (giữ nguyên cấu trúc nguồn)

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

### 1.2 Quy tắc runtime từng trường + metadata

| # | Trường | Quy tắc bắt buộc |
|---|---|---|
| 1 | Problem Statement | **Mọi claim kèm evidence** (file:line · log excerpt · measurement) — claim trần trụi bị loại (TB-04 §5.6; gate TB-06 §9.7) |
| 2 | Root Cause / Analysis | **Kết quả chẩn đoán của LISMA** — evidence-based; NEMESIS không suy diễn thay G2 |
| 3 | Options (A/B/C...) | Bảng 5 cột: Option · Mô tả · Effort · Trade-offs · POC (Workspace) — kèm diff nếu có |
| 4 | Recommendation | Option **HAN khuyến nghị + lý do** |
| 5 | Expected Impact | Metric nếu đo được / **qualitative nếu chưa có benchmark** — không bịa số |
| 6 | Risk & Rollback | Rủi ro khi apply + cách quay lại trạng thái cũ (mọi thay đổi đụng dịch vụ đang chạy) |
| 7 | Verification Plan | **Linh hồn của schema** (dòng 4342): (a) kiểm chứng tay NGAY + (b) benchmark spec DEFERRED — proposal KHÔNG bị chờ hệ A/B xây xong |
| 8 | Effort | S / M / L — effort của option được recommend (multi-item T3: phổ các item, không cộng dồn) |
| M | Metadata `[EXT]` | ID `P-YYYYMMDD-NNN` (NNN tăng trong ngày, **không tái sử dụng** ID đã REJECTED/RETIRED) · Ngày = SUBMITTED đầu (không reset khi re-SUBMIT) · Author = group chính, **tổng hợp bởi NEMESIS** · Mission M2 · Status (§2) |

`[EXT]` POC & diff sống trong **Workspace** (TB-01 §3) — Proposal **tham chiếu** (path + tóm tắt diff), đính kèm khi SUBMITTED; áp lên Live System chỉ sau APPROVED (thao tác riêng — §2).

## §2. 🔁 VÒNG ĐỜI PROPOSAL & SELF-DIRECTION `[TB-11 §2 ← nguồn dòng 4331–4340, 4621–4623]` `[SRC]`

```
DRAFT (NEMESIS tổng hợp từ output G1/G2/G3)
  → SUBMITTED (route THẲNG vào SELF-DIRECTION) — chờ user HOẶC agent được ủy quyền phê duyệt
  → APPROVED → áp thay đổi từ Workspace lên Live System (user hoặc agent ủy quyền — thao tác riêng)
  → REJECTED (kèm lý do → quay lại research nếu cần)
  → REVISED (yêu cầu bổ sung evidence/option → NEMESIS giao lại group liên quan)
```

**Bảng transition** (đồng bộ state machine TB-06 §12.2–12.3):

| Từ | Sự kiện | NEMESIS làm gì | Đến |
|---|---|---|---|
| DRAFT | checklist §4 pass | tổng hợp đủ 8 trường → route SELF-DIRECTION | SUBMITTED |
| SUBMITTED | phê duyệt đạt (user/agent ủy quyền) | đóng task M2 + KB lesson nếu có | APPROVED → END |
| SUBMITTED | REJECTED kèm lý do | re-DECOMPOSE phần liên quan hoặc đóng mission (Decision log) | RESEARCHING |
| SUBMITTED | REVISED — cần thêm evidence/option | giao lại group liên quan → update → re-SUBMIT (giữ ID) | DRAFT → SUBMITTED |
> `[EXT]` **Mapping tên state với TB-06 §12.2–12.3** (cùng ngữ nghĩa, khác tên): TB-06 (engine chuẩn) gọi: DRAFT ≙ PROPOSAL_DRAFTING; REVISED → DRAFT ≙ REVISED → ASSIGNED — mapping 1-1 khi implement.

**Quy tắc route:**
- **Route THẲNG vào SELF-DIRECTION — KHÔNG qua user inbox trung gian** (dòng 2498, 4335, 4623; TB-06 §9.7); sau SUBMITTED NEMESIS vẫn theo dõi, cập nhật nếu REVISED (TB-06 §9.8).
- **NEMESIS KHÔNG tự phê duyệt Proposal của chính mình** (TB-06 §9.8 note c) — phê duyệt thuộc user trực tiếp HOẶC agents được ủy quyền.
- Checklist §4 fail → KHÔNG route: trả group bổ sung (DRAFT vòng trong) — không "điền evidence hộ".
- Áp Workspace → Live chỉ sau APPROVED — **thao tác riêng, không phải NEMESIS**; quy tắc vàng: M2 KHÔNG sửa Live System (dòng 4623; TB-01 §3).

## §3. 🔗 MAPPING TRƯỜNG PROPOSAL ← ARTIFACT NÀO CUNG CẤP `[TB-11 §3 ← suy từ Deliverables nguồn dòng 187/210/694/1134/1844 + ví dụ M2 4428–4511]` `[EXT]`

| Trường | Artifact nguồn | Ai sinh |
|---|---|---|
| 1. Problem Statement | Audit Report + Findings (mỗi finding kèm file:line + log) | BELI (tổng hợp SA của SIVIL) |
| 2. Root Cause / Analysis | Diagnostic Report (root cause list + evidence + severity + patch mẫu Workspace) | LISMA |
| 3. Options (A/B/C) | Proposal items G3 + POC/diff trong Workspace | HAN (options) + BELI (POC) |
| 4. Recommendation | Recommendation section output G3 (option + lý do) | HAN |
| 5. Expected Impact | Impact Chain + KB Performance Baselines (chat 121s → 6.2s · Neo4j 39,615 nodes · R2 52 PDFs — dòng 1538–1543) | HAN |
| 6. Risk & Rollback | 5 câu System Safety + rollback path của patch mẫu (TB-04 §6) | LISMA (+ trade-offs HAN) |
| 7. Verification Plan | (a)+(b) cho mỗi proposal item — sinh theo Instructions G3; NEMESIS check tại gate 4 | HAN + NEMESIS |
| 8. Effort | Cột Effort bảng Options (S/M/L) | HAN (NEMESIS chốt) |
| Metadata | Theo TB-00 §1.4 + worklog mission | NEMESIS |

> **Mission M2 tier T1/T2** (không đủ 3 group — TB-02 §5): trường thiếu group lấy từ LISMA (T1) hoặc BELI+LISMA (T2); Recommendation do LISMA đề xuất trong Diagnostic Report — NEMESIS ghi rõ "G3 không chạy (tier)" trong trường 4 để SELF-DIRECTION biết nguồn khuyến nghị.

## §4. ✅ CHECKLIST "PROPOSAL SẴN SÀNG SUBMIT" `[TB-11 §4 ← cụ thể hóa 4 gate TB-06 §9.7 + nguồn dòng 4327–4328]` `[EXT]`

NEMESIS chạy checklist NGAY TRƯỚC khi route — 4 dòng đầu khớp **4 gate của TB-06 §9.7** (tham chiếu bởi state machine TB-06 §12.2):

- [ ] **C1 — Evidence:** mọi claim trong Problem Statement + Root Cause có evidence (file:line / log excerpt / measurement) — gate 1.
- [ ] **C2 — Options:** ≥ 2 options, mỗi option đủ cột Mô tả · Effort · Trade-offs · POC — gate 2.
- [ ] **C3 — Rollback:** mọi thay đổi đụng dịch vụ đang chạy có rollback path — gate 3.
- [ ] **C4 — Verification Plan:** đủ (a) kiểm chứng tay NGAY (log check/manual test cụ thể) + (b) benchmark spec DEFERRED (metric + method + acceptance threshold) — gate 4.
- [ ] **C5 — POC kèm diff nếu có:** diff sống trong Workspace, được tham chiếu/đính kèm khi SUBMITTED.
- [ ] **C6 — Metadata đúng format:** ID `P-YYYYMMDD-NNN` (chưa ai dùng) · Ngày · Author · Mission M2 · Status DRAFT — quy tắc bổ sung `[EXT]`.
- [ ] **C7 — Nguồn gốc trường:** Root Cause = kết quả LISMA; Recommendation = khuyến nghị HAN (hoặc ghi rõ tier không có G3 — §3).
- [ ] **C8 — Effort nhất quán:** trường 8 = Effort của option được recommend; không mâu thuẫn bảng Options — quy tắc bổ sung `[EXT]`.

## §5. ⚠️ ERROR & EDGE CASES `[TB-11 §5 ← suy từ nguồn dòng 4331–4340 + pivot triggers M2 4596–4597]` `[EXT]`

| # | Tình huống | Xử lý |
|---|---|---|
| E1 | Claim thiếu evidence phát hiện khi DRAFT | Không route — trả group sinh claim bổ sung (gate 1 fail); không "điền evidence hộ" |
| E2 | Mission M2 tier T1 thuần verify ("config X có đúng không?") | Trả kết luận verify + KB entry; chỉ đóng Proposal 1-item khi có **thay đổi đề xuất** — giải [Q] TB-02 §5, **✅ ĐÃ CHỐT v1.3 (DR-C1)** |
| E3 | Proposal bị REJECTED | Phân tích lý do → re-DECOMPOSE phần liên quan hoặc đóng mission (Decision log); không re-submit nguyên trạng |
| E4 | Proposal bị REVISED | Giao lại group bổ sung evidence/option → update → re-SUBMIT (giữ ID, ghi ngày update) |
| E5 | Proposal phá compatibility hệ đang chạy | Pivot trigger 🔴 (TB-09 §6) — NEMESIS không SUBMIT, quay part thiết kế |

## §6. ✅ ACCEPTANCE CRITERIA `[TB-11 §6]` `[EXT]`

- [ ] **AC1.** Schema 8 trường + metadata giữ nguyên cấu trúc nguồn 4292–4329 (không thêm/bớt trường bắt buộc).
- [ ] **AC2.** Template render hoàn chỉnh từ output G1/G2/G3 của 1 mission M2 (thử bằng playbook TB-12 §2) — không trường trống ngoài "—" có chủ đích.
- [ ] **AC3.** Mọi claim có evidence theo 3 dạng: file:line · log excerpt · measurement.
- [ ] **AC4.** Bảng Options ≥ 2 options × đủ cột; Effort S/M/L.
- [ ] **AC5.** Mọi thay đổi đụng dịch vụ đang chạy có rollback path.
- [ ] **AC6.** Verification Plan luôn có (a) tay NGAY + (b) benchmark spec DEFERRED với metric + method + acceptance threshold.
- [ ] **AC7.** Vòng đời 5 trạng thái + bảng transition không mâu thuẫn TB-06 §12.2–12.3.
- [ ] **AC8.** Route SUBMITTED đi THẲNG vào SELF-DIRECTION — không qua user inbox trung gian.
- [ ] **AC9.** NEMESIS không tự phê duyệt; áp Workspace → Live chỉ sau APPROVED, là thao tác riêng.
- [ ] **AC10.** Checklist C1–C8 khớp đủ 4 gate TB-06 §9.7; ID `P-YYYYMMDD-NNN` đúng format, không tái sử dụng; bảng mapping §3 phủ đủ 8 trường + metadata (quy tắc T1/T2 nêu rõ).

## §7. DECISIONS — [Q] ĐÃ CHỐT (v1.3) `[TB-11 §7]` `[DECIDED v1.3]`

| # | Câu hỏi | Phụ thuộc | ✅ QUYẾT ĐỊNH (v1.3) |
|---|---|---|---|
| Q1 | E2 — ngưỡng "mission verify thuần túy" không cần Proposal: chốt cùng [Q] TB-02 §5 | TB-02 §5 | ✅ **DR-C1** — ngưỡng deterministic: **không có đề nghị thay đổi** → kết luận (kèm evidence citations) + **Verify-Report mini** + **KB entry**; **có ≥ 1 đề nghị thay đổi** → Proposal 1-item **bắt buộc** (chốt cùng TB-02 §5) |
| Q2 | SELF-DIRECTION là module nào của TMO; Proposal lưu ở đâu (file/store), ai parse? — dừng ở runtime contract | hạ tầng TMO | **Runtime contract chốt:** SELF-DIRECTION = **module runtime của TMO** (registry + scheduler + applier); Proposal canonical = **file `proposals/P-YYYYMMDD-NNN.md` trong Workspace** + **mirror DB** (Prisma model `Proposal`: 8 trường + status lifecycle + deputy-approver); parser = module self-direction (không phải NEMESIS); **NEMESIS cấm tự duyệt** (TB-06 §9.8); **APPLY = thao tác runtime sau APPROVED** (merge branch Workspace — TB-01 Q3) |
| Q3 | Timeout chờ phê duyệt SUBMITTED + trần số vòng REVISED trước khi escalate user? | TB-06 §14 E4 | ✅ **DR-C5** — **48h chờ SUBMITTED + nhắc 12h/lần**; trần REVISED = **2 vòng** (mỗi vòng re-verify đầy đủ); vòng 3 REJECTED → **ESCALATED_USER**; deputy = **SIVIL/HAN** |

## PHỤ LỤC A — TRACEABILITY MATRIX

| Nguồn (dòng) | Nội dung nguồn | Section TB-11 |
|---|---|---|
| 4288–4290 | PROPOSAL SCHEMA — chuẩn đầu ra M2, hội tụ 1 artifact | §0, §1 |
| 4292–4329 | Template 8 trường + metadata + Status + bảng Options | §1.1, §1.2 |
| 4331–4340 + 4342 | Vòng đời Proposal + người duyệt + áp là thao tác riêng + "trường 7 là linh hồn" | §2, §1.2 (trường 7) |
| 187/210/694/1134/1844 + 1538–1543 | Deliverables 5 agents + Performance Baselines (cơ sở mapping §3) | §3 |
| 2443–2501 | FINALIZE M2 — route SELF-DIRECTION (TB-06 §9.7) | §2, §4 |
| 4596–4597 + 4615–4623 | Pivot triggers M2 + bảng Proposal → SELF-DIRECTION (quy tắc vàng) | §5, §0 |
