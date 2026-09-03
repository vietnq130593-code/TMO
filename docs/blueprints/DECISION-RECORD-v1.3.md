# DECISION RECORD — TẬP 13 BLUEPRINT TB-00→TB-12

**Version:** 1.3 (bổ sung quyết định cho Version 1.2 của tập blueprint)
**Ngày chốt:** 2026-09-01
**Người chốt:** User đã **ủy quyền toàn bộ** cho Z.ai Code ("Mr. Robot") với chính sách định hướng dưới đây.
**Phạm vi:** 71 câu hỏi mở `[Q]` (7 cụm chéo file C1–C7 + 64 câu riêng theo từng TB) + các amend nguồn liên quan.
**Hiệu lực theo quy tắc TB-00 §5:** nguồn `ai-team-workflow.md` được cập nhật trước (Phụ lục Z — Decision Record, append-only, 4.635 dòng gốc nguyên vẹn), 13 blueprint cập nhật sau. Mọi `[Q]` chuyển thành `[DECIDED v1.3]`.

---

## §0. CHÍNH SÁCH CHỐT (do user chỉ định)

| # | Nguyên tắc | Áp dụng |
|---|---|---|
| P1 | **Thorough-first:** khi có trade-off giữa "nhanh/gọn" và "cẩn thận/đầy đủ" → luôn chọn phương án cẩn thận, đầy đủ. Không chấp nhận shortcut. | Mọi quyết định |
| P2 | **Không ràng buộc token/chi phí:** hệ thống chạy NVIDIA NIM (4 API keys hiện có, sẽ tăng thêm) → cho phép concurrency cao, council đồng bộ, verify đầy đủ, retry hào phóng. | TB-03 Q1/Q2, TB-06 Q6, C4 |
| P3 | **Audit-trail append-only:** mọi thay đổi thiết kế/điều chỉnh giữa chừng đều giữ vết — không rewrite lịch sử. | C3, KB, task .md |
| P4 | **Evidence bắt buộc:** mọi thao tác đọc Live System phải ghi evidence log; mọi quyết định có Decision Log. | TB-03 Q4, TB-04 Q4, TB-10 Q5 |
| P5 | **Tie-break UP:** khi mơ hồ 50/50 giữa 2 tier/phương án → chọn phương án KỸ HƠN (chi phí dư depth < chi phí thiếu depth). | C2, TB-06 |
| P6 | **An toàn Live System tuyệt đối:** mọi quyền mở rộng chỉ là READ-ONLY trên Live; write chỉ trong Workspace; NEMESIS vẫn là decision-maker duy nhất cho mọi thay đổi. | TB-03 Q4, TB-04 Q4/Q7, C5 |

---

## §1. BẢY CỤM QUYẾT ĐỊNH CHÉO FILE (C1–C7)

### C1 — Mission M2 verify thuần túy có sinh Proposal? (TB-02 Q2 · TB-09 Q7 · TB-11 Q1/E2 · TB-12 Q3)

**✅ QUYẾT ĐỊNH (ba lớp, xét ngưỡng deterministic):**

1. **Định nghĩa "verify thuần túy" (deterministic):** kết luận verify KHÔNG chứa bất kỳ đề nghị thay đổi nào (config/code/metric/process). Chỉ cần 1 đề nghị thay đổi xuất hiện → KHÔNG còn thuần túy → Proposal 1-item **bắt buộc** (quy tắc vàng TB-02 §5 giữ nguyên).
2. Mission verify thuần túy → NEMESIS trả lời trực tiếp NHƯNG **bắt buộc đủ 3 thành phần:** (a) kết luận có **evidence citations** (trỏ artifact/dòng log/query); (b) **KB entry bắt buộc** (loại Pattern/Config — theo TB-08); (c) **Verify-Report mini** lưu workspace (không chỉ chat answer).
3. Verify thuần túy **không cần vòng RWV rút gọn**; có đề xuất thay đổi → mini-RWV (NEMESIS read-back 1 vòng) + Proposal 1-item kèm Verification Plan.

→ TC-02 (TB-12) được freeze theo ngưỡng này; E2 (TB-11 §5) chốt chính thức.

### C2 — Ngưỡng confidence CLASSIFY định lượng (TB-02 Q1 · TB-06 Q1)

**✅ QUYẾT ĐỊNH (đếm tín hiệu, deterministic, tie-break UP):**

| Mức | Định lượng | Hành vi |
|---|---|---|
| **HIGH (CAO)** | ≥ 3 tín hiệu độc lập cùng chiều, **0 mâu thuẫn** (mission-type: L1+L2+L3 đủ; tier: điểm complexity vượt ngưỡng phân tầng ≥ 2 điểm) | Classify ngay, KHÔNG hỏi user |
| **MEDIUM** | Đúng 1 mâu thuẫn duy nhất | NEMESIS verify thêm 1 vòng context (giữ nguồn) → vẫn mâu thuẫn → **TIE-BREAK UP** (chọn tier cao hơn) + Decision Log ghi lý do |
| **LOW (THẤP)** | ≥ 2 mâu thuẫn hoặc thiếu tín hiệu (không đủ L1–L3) | **Hỏi user đúng 1 câu** (đếm vào hạn mức TB-06 Q5), KHÔNG đoán mò |

- Luật **tie-break UP (P5):** điểm nằm ngay biên ngưỡng 2 tier (khoảng ±1 điểm) → chọn tier cao hơn. Lý do: hạ tier giữa chừng rẻ (C3 append-only), thiếu depth thì đắt.
- Ngưỡng phân tầng tier giữ nguyên theo bảng TRIAGE nguồn (TB-02 §4) — quyết định này chỉ chuẩn hóa *độ tin cậy*, không đổi điểm chấm.

### C3 — Nâng/hạ tier giữa chừng: rewrite hay append? (TB-02 Q3 · TB-06 Q4 · TB-07 Q4 · TB-09 Q2)

**✅ QUYẾT ĐỊNH: APPEND-ONLY (giữ audit trail đầy đủ).**

- Template task .md bổ sung **trường chính thức `version: N`** + block **`## CHANGELOG`** (đồng bộ TB-07 §3 template + TB-09 §9.4 lifecycle).
- Mọi nâng/hạ tier = 1 amendment entry: `version n → n+1 | ai quyết | tier cũ → mới | lý do | evidence ref | Decision Log ID`. **KHÔNG bao giờ** rewrite/xóa nội dung cũ.
- Diff giữa version do worklog NEMESIS ghi (đối chiếu trước/sau khi DECIDE nâng/hạ).

### C4 — Độ sâu CP1 của T2 (TB-02 Q4 · TB-09 Q1)

**✅ QUYẾT ĐỊNH: verify ĐẦY ĐỦ như T3 (chỉ khác độ phủ checklist).**

- T2 CP1 = formal gate: NEMESIS đối chiếu (a) Success Criteria task .md ↔ worklog G1; (b) specs BELI ↔ part được giao; (c) bắt buộc ≥ 1 câu hỏi VERIFY có câu trả lời ghi worklog.
- T2 dùng checklist ~60% số item của T3 (đủ phủ interface + success criteria, bỏ bớt probe sâu).
- Quick-check chỉ dành cho T1 CP2. Nguồn dòng 3518 ("T2 có CP1+CP2") được thỏa mãn theo nghĩa đầy đủ.

### C5 — Timeout ESCALATED_USER, phê duyệt Proposal, ủy quyền duyệt (TB-06 Q7 · TB-09 Q3 · TB-11 Q3 · TB-12 Q4)

**✅ QUYẾT ĐỊNH (bộ giá trị thống nhất):**

| Tình huống | Giá trị |
|---|---|
| Group treo (không có worklog mới) | Nhắc sau **1 CP**; treo **2 CP** → ESCALATE |
| ESCALATED chờ user (wall-clock) | Timeout **48h** (mission M1 nghiên cứu) / **24h** (M2 hệ thống đang bị đe dọa); nhắc mỗi **12h**, tối đa 3 nhắc; hết hạn → pipeline task đó **dừng toàn phần** (parts khác độc lập vẫn chạy — TB-09 E11) |
| Proposal SUBMITTED chờ duyệt | **48h** + nhắc 12h/lần |
| Trần vòng REVISED | **2 vòng** (mỗi vòng re-verify ĐẦY ĐỦ 8 trường); vòng thứ 3 vẫn REJECTED → ESCALATED_USER |
| **Agent được ủy quyền duyệt Proposal** | **SIVIL** (mặc định — proposal tổng hợp/research) hoặc **HAN** (proposal thuộc KB/G3-domain). Ràng buộc: deputy KHÔNG được là author proposal; **NEMESIS bị cấm tự duyệt** (giữ TB-06 §9.8); ủy quyền có thời hạn, ghi Decision Log + worklog |

### C6 — Nền tảng lưu trữ KB runtime (TB-05 Q3/Q5 · TB-08 Q2)

**✅ QUYẾT ĐỊNH: kiến trúc 3 lớp (đầy đủ nhất, scale tốt):**

1. **Canonical store = SQLite/Prisma nội bộ TMO** — model `KBEntry`: versioned, retire = **soft-delete** (giữ history), mọi write qua KB Write Protocol (duyệt KB Candidates trước — TB-08 §8).
2. **Export snapshot `.md` theo category** (multi-file + `index.md`) — artifact cho Directed Reading của G-agents; regenerate sau mỗi capture/curate. → quyết TB-05 Q3: **multi-file + index** (không còn giới hạn 500 entries đơn file).
3. **Live System đọc KB read-only** qua snapshot; mọi write chỉ qua protocol.

### C7 — Format chuẩn dòng `model switched` (TB-01 Q2 · TB-09 Q6 · giải [Q] Task 8-a)

**✅ QUYẾT ĐỊNH: duyệt format TB-09 §4.3 làm chuẩn toàn tập + bổ sung 2 trường:**

```markdown
- **Model note**: model switched Kimi-k3 → DeepSeek V4 Pro —
  lý do: [timeout / quá tải / lỗi API / quality];
  trigger: [2 probe liên tiếp vượt SLA / error-code];
  next check: [cuối task hiện tại / sau 3 probe OK thử về model chính];
  agent giữ nguyên JD + vai trò.
```

- 1 dòng Decision Log kèm mỗi lần switch (TB-06 §13).
- Mọi agent dùng chung format; mỗi task mới khởi động lại từ model chính Kimi-k3 (giữ nguyên quy ước TB-01).

---

## §2. QUYẾT ĐỊNH THEO TỪNG FILE

### TB-01 — Foundation · Roster · Model · Env (3 câu)

| Q | ✅ QUYẾT ĐỊNH (v1.3) |
|---|---|
| Q1 "Quá tải kéo dài" đo bằng gì? | **Dual-signal (cả hai):** (a) agent self-report — latency/op + token/op trong mỗi worklog entry; (b) orchestrator external probe — queue depth + wall-clock vs SLA loại op. Switch fire khi **MỘT TRONG HAI** vượt (OR — switch sớm vì fallback chain mạnh: kimi-k3 → deepseek-v4-pro → flash → minimax-m3). **Hysteresis:** tự về model chính sau 3 probe liên tiếp OK. |
| Q2 model switched schema | → **C7** (format chuẩn TB-09 §4.3 + trigger/next check) |
| Q3 Workspace versioning | **CÓ — bắt buộc:** 1 Proposal = 1 branch git trong Workspace (tên = `P-YYYYMMDD-NNN`); mọi thay đổi APPLY-able phải commit (author + ts + part ref); diff `base..head` là artifact review tại CP3/FINALIZE; APPLY = merge branch — thao tác riêng của runtime sau APPROVED. |

### TB-02 — Architecture · Tier System (5 câu)

| Q | ✅ QUYẾT ĐỊNH (v1.3) |
|---|---|
| Q1 confidence CLASSIFY | → **C2** |
| Q2 M2 T1 verify-only Proposal? | → **C1** |
| Q3 nâng/hạ tier | → **C3** (append-only) |
| Q4 CP1 của T2 | → **C4** (verify đầy đủ, checklist ~60%) |
| Q5 Council ① ở T2 | **CÓ — T2 vẫn họp council ①** sau DECOMPOSE: SIVIL tham vấn **ad-hoc** (consult-only, KHÔNG dispatch SA — giữ nguyên "T2 không route qua SIVIL"); decomposition của mọi mission T2+ được G1 lead review trước khi ASSIGN. |

### TB-03 — G1 Engine · SIVIL & BELI (7 câu)

| Q | ✅ QUYẾT ĐỊNH (v1.3) |
|---|---|
| Q1 SA concurrent tối đa | **20 mặc định** (round-robin 4 NIM keys → 5 SA/key), **burst 25** cho Grand Competition; hard-cap 25 (giữ khoảng §5.4 nguồn 10–25). Thêm key sau này → ceiling tự tính 5 SA/key, vẫn ≤ 25 tới khi user nâng. Mọi điều chỉnh ghi worklog + Decision Log. |
| Q2 Timeout 1 SA | Theo loại task: **EDA 30 phút · Grand/Competition 60 phút · System Audit 30 phút**. Soft-checkpoint 50%/70% (SA bắt buộc báo tiến độ); hard-kill tại timeout → **retry 1 lần với scope thu hẹp 50%**; retry fail → findings rỗng + error entry (per §10). |
| Q3 Council ② NEMESIS xác nhận specs | **NEMESIS CÓ quyền VETO.** Hành vi cụ thể: NEMESIS ghi checklist spec-by-spec trong worklog (mỗi spec 1 dòng `ack` hoặc `veto: lý do`); veto → spec quay lại SIVIL revise; **≥ 2 vòng veto cùng spec → escalate council ③** (khớp §8). (Đồng bộ chốt TB-06 Q2.) |
| Q4 BELI POC trên dữ liệu thật | **READ-ONLY được phép** (query Qdrant/Neo4j, GET API) — evidence phong phú hơn; MỌI query ghi **evidence log** (query + timestamp + số dòng trả về) trong worklog BELI; **WRITE tuyệt đối cấm** — mọi thao tác ghi chỉ trên Workspace clone. |
| Q5 Deadline nội bộ spec | **G1 hết 40% quỹ thời gian task** (theo tier deadline của TL); override qua Decision Log khi mission đặc biệt. |
| Q6 Ngưỡng feedback spec | **2 vòng cho MEDIUM; 3 vòng cho COMPLEX/Grand Competition** (task lớn cần nhiều vòng tự nhiên hơn); vượt ngưỡng → council ③ bắt buộc. |
| Q7 Verify K specs | **Verify TẤT CẢ rồi handoff 1 package** (giữ nguồn 338–340); package kèm spec-verification checklist từng spec. |

### TB-04 — G2 Engine · LISMA (8 câu)

| Q | ✅ QUYẾT ĐỊNH (v1.3) |
|---|---|
| Q1 Tên nhóm checklist 2 | **"Data Safety (Data Leakage)"** — chuẩn hóa toàn tập, giữ cả hai (không mất thông tin). |
| Q2 Loại bug thứ 5 | **Theo nguồn: API/Compatibility** là loại 5. **Regression = bug GỐC**, có type riêng (ghi regression field + tham chiếu bug gốc — không phải danh mục loại 5). Danh mục 5 loại: Logic · Edge Case · Data Leak · Performance · API/Compatibility. |
| Q3 ESCALATED chờ TL | **Dừng TOÀN BỘ task** (đúng chữ "DỪNG" — nguồn 952–955); TL re-assign → state mở lại NEW. Không chạy song song việc khác của cùng task. |
| Q4 LISMA đọc Live System | **Chủ động READ-ONLY được phép** (tail log mới, `/api/health`, Neo4j read-only query) để hoàn thiện evidence; **mọi thao tác ghi evidence log** (query + ts + kết quả); **WRITE cấm tuyệt đối**. |
| Q5 Severity regression | **Đánh giá ĐỘC LẬP** (tác động regression hiện tại có thể khác bug gốc) + **ghi tham chiếu severity bug gốc** làm context (ảnh hưởng bảng quyết định D8). |
| Q6 Đếm vòng lặp | **Theo TASK/đợt fix** (không theo file) — đúng cách đọc ví dụ nguồn 898–938 (3 files trong 1 vòng). |
| Q7 Kênh URGENT M2 | **Dual-channel:** severity CRITICAL đang đe dọa Live → (a) escalate NEMESIS theo format chuẩn §7.3 + tag URGENT, VÀ ĐỒNG THỜI (b) notify **user trực tiếp** qua kênh URGENT song song (không chờ NEMESIS relay). **NEMESIS vẫn là decision-maker duy nhất cho fix** — LISMA không bao giờ tự áp. |
| Q8 M2 simple → Tier 1 LISMA | **CÓ** — đi đường Tier 1 (patch mẫu Workspace 1 bước, không áp Live) + **mini read-back bởi NEMESIS bắt buộc** (1 vòng verify nhỏ). |

### TB-05 — G3 Engine · HAN & KB (8 câu)

| Q | ✅ QUYẾT ĐỊNH (v1.3) |
|---|---|
| Q1 "Mỗi vòng tối ưu" | **1 vòng = 1 task G3** (1 lần vào OPTIMIZING); mỗi task sinh ≥ 1 proposal item. |
| Q2 Ngưỡng "cải thiện đáng kể" | **M1: > 1 std của CV** (định lượng). **M2: > 5% cải thiện metric chuẩn hóa HOẶC vượt bootstrap 95% CI** so baseline; qualitative-only → chỉ ghi lesson với **confidence ≤ MEDIUM** (giữ E3). |
| Q3 KB 1 file hay nhiều file | → **C6**: snapshot **multi-file + index** theo category; canonical là DB — không còn ràng buộc 500 entries. |
| Q4 HAN retire entries NEMESIS/SIVIL ghi | **PRE-APPROVAL (chặt hơn):** HAN liệt kê retire-candidates trong report/proposal G3 → **NEMESIS duyệt tại CP3 TRƯỚC** khi retire có hiệu lực; NEMESIS tự retire được (kèm Decision Log). HAN KHÔNG tự retire entries do NEMESIS/SIVIL ghi khi chưa được duyệt. Đánh đổi tốc độ — chấp nhận theo P1. |
| Q5 KB đặt ở đâu | → **C6** (SQLite canonical + snapshot md + Live read-only) |
| Q6 Confidence trường thứ 8 | **CÓ** — thêm `Confidence: HIGH/MEDIUM/LOW` làm trường 8 KB Entry Schema; **amend nguồn trước** (Phụ lục Z, quy tắc số 1). |
| Q7 Trần vòng G3 | **Trần 3 vòng Evolution Cycle mỗi task G3** (đối xứng G2); vượt → ESCALATE. Amend nguồn. |
| Q8 HAN trong council? | **Giữ thiết kế nguồn: HAN KHÔNG ngồi council** (council = NEMESIS ↔ SIVIL). [EXT bổ sung, không mâu thuẫn:] council transcript/output được **route tự động tới HAN như input** để curate — HAN nhận đủ thông tin mà không phải thành viên. |

### TB-06 — TL Engine · NEMESIS (8 câu)

| Q | ✅ QUYẾT ĐỊNH (v1.3) |
|---|---|
| Q1 confidence CLASSIFY | → **C2** |
| Q2 Council ② veto? | **NEMESIS VETO được** (đồng bộ TB-03 Q3: checklist ack/veto từng spec; ≥ 2 vòng veto → council ③) |
| Q3 Proposal REJECTED → tier gì | **Re-TRIAGE đầy đủ từ đầu** (nghi ngờ mis-tier — không giữ tier mặc định), GIỮ toàn bộ worklog/context làm input; **tối đa 2 vòng REJECTED → research**; vòng 3 → ESCALATED_USER. |
| Q4 nâng/hạ tier | → **C3** (append-only) |
| Q5 Trần số câu hỏi user | **1 câu CLASSIFY** (chỉ khi confidence LOW) + tối đa **1 câu user-blocked-info mỗi task**. Tie-break UP (C2) giảm nhu cầu hỏi. Vượt hạn mức → quyết theo tie-break UP + ghi Decision Log, không hỏi thêm. |
| Q6 Council đồng bộ/bất đồng bộ | **ĐỒNG BỘ (blocking)** — mọi council ①②③④ chặn pipeline chờ hoàn tất. Thứ tự chất lượng > latency (P1, P2: token không ràng buộc, không race-condition trên quyết định). |
| Q7 ESCALATED_USER | → **C5** (48h/24h + nhắc 12h + ủy quyền SIVIL/HAN có thời hạn) |
| Q8 Verify Proposal trước SUBMIT | **CÓ — bắt buộc field-by-field:** NEMESIS verify đủ 8 trường (checklist từng trường lưu Decision Log), trọng điểm **Risk & Rollback** (trường 7 — "linh hồn Proposal"); gate §9.7 giữ nguyên + thêm bước verify này thành điều kiện SUBMIT. |

### TB-07 — TL Decomposition Playbook (7 câu)

| Q | ✅ QUYẾT ĐỊNH (v1.3) |
|---|---|
| Q1 5 bước lên nguồn | **CÓ** — cập nhật NGUỒN thành danh sách 5 bước DECOMPOSE chính thức đánh số (amend Phụ lục Z; quy tắc "nguồn trước"). |
| Q2 House Prices parts | **Theo nguồn: 6 parts (0–5)** — giữ nguyên thiết kế nguồn. |
| Q3 Ngưỡng R3 (~50%) | **Giữ 50% làm mặc định** + cơ chế hiệu chỉnh: log usage 5 mission M2 đầu → recalibrate qua Decision Log (không bỏ ngưỡng, không đoán mò). |
| Q4 Version field trong task .md | **CÓ** — `version: N` + `## CHANGELOG` block chính thức (→ C3, đồng bộ TB-09 §9.4). |
| Q5 Council ① mission chỉ SIMPLE/MEDIUM | **BẮT BUỘC cho MỌI mission** (giữ nguyên nguồn — council họp sau DECOMPOSE mọi mission). |
| Q6 Part 0 "Setup & Baseline" cho M2 | **CÓ — thêm Part 0** cho mission M2 multi-part (≥ 2 parts hoặc tier ≥ T2): khởi tạo Workspace, snapshot baseline metrics từ logs, chốt các số liệu so sánh. Mission 1-part T1 bỏ Part 0. [EXT, không mâu thuẫn nguồn 2860 "baseline = số đo từ logs" — chỉ formal hóa việc thu thập.] |
| Q7 Ai đề xuất tách/gộp part | **NEMESIS độc quyền quyết.** SIVIL (council ①) và LISMA (khi verify) được **flag đề xuất** qua worklog như input cho DECIDE — không quyết. |

### TB-08 — Knowledge Capture Protocol (2 câu)

| Q | ✅ QUYẾT ĐỊNH (v1.3) |
|---|---|
| Q1 Chu kỳ curate khi không có T3 | **Định kỳ KÉP (đủ 3 mốc):** (a) mỗi ~10 entry NEW; (b) cuối mỗi mission; (c) định kỳ thời gian **7 ngày** nếu KB còn entry NEW — HAN chủ trì, không cần chờ task T3. |
| Q2 Nền tảng lưu trữ KB | → **C6** (SQLite canonical + snapshot multi-file + index; Live read-only; write qua protocol duyệt Candidates) |

### TB-09 — RWV Loop & Handoff Protocol (8 câu)

| Q | ✅ QUYẾT ĐỊNH (v1.3) |
|---|---|
| Q1 T2 CP1 | → **C4** (verify đầy đủ như T3, checklist ~60%) |
| Q2 Versioning task .md | → **C3** (append changelog, KHÔNG rewrite) |
| Q3 Timeout group treo + ESCALATED | → **C5** (nhắc 1 CP / treo 2 CP → ESCALATE; ESCALATED 48h/24h, nhắc 12h) |
| Q4 Trần re-run group | **2 vòng trả lại → PIVOT; 3 vòng → ESCALATE** (giữ đề xuất — bounded loop, không chạy vô hạn). |
| Q5 Ngưỡng CV-LB gap | **CÓ — bảng chuẩn hóa vào Research Protocol template:** 0.005 = minor (ghi worklog) · 0.01 = notable (đánh giá ổn định hóa) · 0.02 = instability-warning (bắt buộc kiểm tra trước kết luận metric). |
| Q6 Format model switched | → **C7** (duyệt §4.3 + trigger/next check; giải trọn [Q] Task 8-a) |
| Q7 M2-T1 verify-only RWV? | → **C1** (verify thuần túy: Verify-Report mini + KB, không Proposal; có đề xuất → mini-RWV + Proposal 1-item) |
| Q8 Ai ghi TL Read-Back | **NEMESIS ghi khi READ xong** (worklog là shared artifact — §1.2). |

### TB-10 — Directed Reading · Artifact Map (8 câu)

| Q | ✅ QUYẾT ĐỊNH (v1.3) |
|---|---|
| Q1 Trạng thái stale | **Gộp vào `superseded`** + note "stale, cần re-compute" (không thêm state mới — giữ state machine gọn). |
| Q2 Ngưỡng map quá lớn (E3) | **> 60 entries → bắt buộc rank + chỉ đọc sâu top**. |
| Q3 M1 cập nhật entry gốc | **M1 theo ví dụ nguồn** (cột status — "Fixed by G2"); **M2 append + superseded** (đồng bộ thiết kế sẵn). |
| Q4 Prefix LIVE:/WS: | **Cột riêng** trong bảng chain — ID dòng giữ ngắn gọn. |
| Q5 Verify Module Map trên TMO thật | **Verify KÉP:** kỹ sư triển khai 1 lần lúc cài + cập nhật khi repo đổi; **NEMESIS verify đường dẫn vs repo thật ở đầu MỌI mission M2 T3** (thao tác đọc — rẻ, sạch) → sai lệch → flag + cập nhật map. |
| Q6 SA ghi map trực tiếp? | **KHÔNG** — SA trả map-fragments trong findings; **SIVIL tổng hợp 1 map G1 duy nhất** (tránh trùng lặp entry). |
| Q7 Task mini re-compute stale | **CÓ** — qua DECIDE + task .md mini (SIMPLE/Tier 1) giao G sở hữu artifact. |
| Q8 Cột Relevance cho M1 | **KHÔNG** — metric impact + severity đủ tín hiệu rank cho M1. |

### TB-11 — Proposal Schema · Self-Direction (3 câu)

| Q | ✅ QUYẾT ĐỊNH (v1.3) |
|---|---|
| Q1 Ngưỡng verify thuần túy | → **C1** |
| Q2 SELF-DIRECTION + Proposal lưu ở đâu | **Runtime contract chốt:** SELF-DIRECTION = **module runtime của TMO** (registry + scheduler + applier). Proposal canonical = **file `proposals/P-YYYYMMDD-NNN.md` trong Workspace** + **mirror DB** (Prisma model `Proposal`: 8 trường + status lifecycle + deputy-approver field). Parser = module self-direction (không phải NEMESIS). NEMESIS bị cấm tự duyệt (TB-06 §9.8); APPLY = thao tác riêng của runtime sau APPROVED (merge branch Workspace theo TB-01 Q3). |
| Q3 Timeout SUBMITTED + trần REVISED | → **C5** (48h chờ + 2 vòng REVISED + deputy SIVIL/HAN) |

### TB-12 — E2E Playbooks · Test Cases (4 câu)

| Q | ✅ QUYẾT ĐỊNH (v1.3) |
|---|---|
| Q1 TC riêng cho TB-07/TB-10 | **CÓ — thêm NGAY đợt này:** **TC-13** (task .md thiếu Success Criteria → bị TB-07 gate chặn tại council ①) + **TC-14** (worklog thiếu map → KHÔNG giao group kế, theo TB-09 §10 E4 / TB-10). |
| Q2 Golden run PB-M2 | **CÓ** — dựng "golden run" mẫu từ log mission M2 thật đầu tiên, chuẩn hóa theo schema TB-09 §4; lưu làm artifact đối chiếu E2E. |
| Q3 TC-02 phụ thuộc C1 | **Đã giải** (→ C1) — tập test case freeze được. |
| Q4 Agent ủy quyền duyệt | → **C5**: **SIVIL mặc định / HAN cho KB-domain**; không author, không NEMESIS, có thời hạn. |

---

## §3. AMEND NGUỒN (ai-team-workflow.md — Phụ lục Z, quy tắc số 1)

Các quyết định sau **thay đổi/thêm schema nguồn**, được ghi thành amendment chính thức trong Phụ lục Z (append-only; 4.635 dòng gốc nguyên vẹn):

| ID | Nội dung amend | Nguồn từ |
|---|---|---|
| A1 | Danh sách 5 bước DECOMPOSE chính thức đánh số | TB-07 Q1 |
| A2 | KB Entry Schema thêm trường 8 `Confidence: HIGH/MEDIUM/LOW` | TB-05 Q6 |
| A3 | Trần 3 vòng Evolution Cycle cho G3 | TB-05 Q7 |
| A4 | Part 0 "Setup & Baseline" cho mission M2 multi-part | TB-07 Q6 |
| A5 | Council đồng bộ (blocking) + council ① mọi mission + T2 ad-hoc | TB-06 Q6, TB-02 Q5, TB-07 Q5 |
| A6 | Model-switched chuẩn format (+ trigger, next check) | C7 |
| A7 | Kiến trúc KB 3 lớp (DB canonical + snapshot + read-only Live) | C6 |
| A8 | SA concurrency 20/25 round-robin NIM keys + timeout theo loại task | TB-03 Q1/Q2 |
| A9 | Bộ timeout + deputy approver (ủy quyền duyệt) | C5 |
| A10 | Task .md `version` + CHANGELOG append-only | C3 |
| A11 | Bảng ngưỡng CV-LB gap 0.005/0.01/0.02 | TB-09 Q5 |
| A12 | Quy tắc verify-only 3 lớp + tie-break UP + confidence counting | C1, C2 |
| A13 | URGENT dual-channel M2 + read-only Live System evidence log | TB-04 Q4/Q7, TB-03 Q4 |
| A14 | Quyết định còn lại (mặc định dùng đề xuất sẵn có, nâng mức chặt hơn) | Toàn bộ |

---

## §4. QUY ƯỚC SAU CHỐT

- Marker `[Q]` trong 13 blueprint → chuyển thành **`[DECIDED v1.3]`** (giữ số Q để truy vết); section "OPEN QUESTIONS" → "DECISIONS — [Q] ĐÃ CHỐT (v1.3)".
- Legend TB-00 §5 bổ sung: `[DECIDED v1.3]` = câu hỏi mở đã được user ủy quyền chốt theo Decision Record này.
- Không quyết định nào mâu thuẫn nguồn; mọi điểm mở rộng là [EXT] đã được phê chuẩn; thay đổi schema nguồn ghi trong Phụ lục Z.
- Triển khai runtime (implement các quyết định vào TMO app) là thao tác riêng — chờ user khởi động.

*Hết DECISION-RECORD v1.3 — nguồn tham chiếu canonical cho việc cập nhật 13 blueprint + nguồn ai-team-workflow.md.*
