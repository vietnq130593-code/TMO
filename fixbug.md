# GIAO THỨC FIXBUG — VÒNG LẶP RÀ SOÁT → FIX/BỔ SUNG → RÀ LẠI, ĐẾN KHI SẠCH MỚI DỪNG

> **Phiên bản:** 1.0 — 2026-10-10 (task-83: user chỉ thị xây dựng giao thức + khởi động ngay đợt 1 trên P0-1 vừa triển khai)
> **Vị trí:** repo root, ngang hàng `bug.md` / `Bug_v2.md` — 3 file phối hợp: `bug.md` = sổ quan sát tại chỗ; `Bug_v2.md` = sổ bug chính thức (legend A-H · P0-P3); `fixbug.md` (file này) = giao thức vòng lặp rà-fix + biên bản các đợt đã chạy.
> **Đối tượng áp dụng:** bất kỳ "phần được yêu cầu" (scope) — một đợt triển khai blueprint (P0, P1-M1…), một module, một route, một bản fix, một hạ tầng gate…

---

## 0. ĐỊNH NGHĨA

| Thuật ngữ | Định nghĩa |
|---|---|
| **PHẦN ĐƯỢC YÊU CẦU (scope)** | Tập file/chức năng user chỉ định rà soát (vd: "đợt 1 (P0)" = 7 module `src/lib/stats/` + test r76 + Bug_v2-035..038 + hạ tầng gate đi kèm commit c74388c/9ae69bb). |
| **LỖI** | Hành vi khác spec hoặc sai toán học (giá trị trả về sai, crash, sai kiểu, công thức sai dấu/biên). |
| **VẤN ĐỀ** | Hành vi đúng phần nào nhưng còn hở (edge case, đầu vào degenerate cho kết quả vô nghĩa/âm thầm sai, thiếu phòng thủ mẫu số 0/âm/NaN). |
| **THIẾU SÓT** | Thiếu so với spec (hàm thiếu, test thiếu case, JSDoc không khớp hành vi, quên entry Bug_v2, quên export barrel). |
| **PHÁT HIỆN MỚI** | Phát hiện chưa từng được ghi + fix ở vòng trước của CÙNG đợt. Phát hiện đã biết + đã fix + xác minh không tính là "mới". |

## 1. VÒNG LẶP BẮT BUỘC

```
┌────────────────────────────────────────────────────────────────────┐
│  VÒNG N (Rà soát toàn bộ scope theo checklist mục 3)               │
│                                                                    │
│   TÌM THẤY ≥ 1 phát hiện mới?                                      │
│        │                                                           │
│        ├─ CÓ ──► FIX/BỔ SUNG TOÀN BỘ (không chọn lọc, không hoãn)  │
│        │         ──► XÁC MINH (gate 4 tầng PASS + test case mới)   │
│        │         ──► quay lại RÀ SOÁT TỪ ĐẦU (vòng N+1,            │
│        │             gồm CẢ phần vừa fix — fix có thể sinh lỗi mới)│
│        │                                                           │
│        └─ KHÔNG ──► DỪNG. Ghi biên bản nghiệm thu vào mục 6.       │
│                    (chỉ dừng khi vòng rà TRỌN VẸN — đủ mọi mục     │
│                    checklist — không tìm thấy gì thêm)             │
└────────────────────────────────────────────────────────────────────┘
```

## 2. TIÊU CHÍ DỪNG (bắt buộc đủ cả 3)

1. Vòng rà soát **TRỌN VẸN** (không bỏ mục checklist nào) tìm **0 phát hiện mới** trong scope.
2. Mọi phát hiện của các vòng trước **đã fix + đã xác minh** (gate PASS sau fix cuối cùng).
3. **Không còn việc hoãn sửa nào** trong scope. Muốn hoãn một mục phải khai báo rõ ràng + được user duyệt thành văn — mặc định hoãn là KHÔNG được phép.

## 3. CHECKLIST RÀ SOÁT (mỗi vòng quét đủ, ghi dấu vết đã quét)

| Mã | Nội dung | Cách làm |
|---|---|---|
| C1 | **Đối chiếu spec** | Đọc lại spec gốc (blueprint mục tương ứng / yêu cầu user); đối chiếu TỪNG hàm, từng công thức, từng ràng buộc với code thực. |
| C2 | **Toán học độc lập** | Tính lại giá trị kì vọng bằng phương pháp KHÁC code (tay / thuật toán thay thế / bảng chuẩn). KHÔNG tin code, KHÔNG tin test, KHÔNG tin JSDoc — và cũng KHÔNG tin chính kì vọng mình vừa tính (bài học r79 + r76: lỗi nằm ở cả 2 phía; đợt FB-P0: 11/12 "phát hiện" của auditor độc lập hóa ra là sai số học của auditor — mỗi nghi vấn phải chấm chéo bằng phương pháp thứ ba). |
| C3 | **Edge case & degenerate** | Rỗng, 1 phần tử, singleton, mẫu số 0, NaN/Infinity/âm ở tham số, length mismatch, trùng lặp, tie. Với mỗi kết quả: khớp JSDoc/convention → ĐẠT; vô nghĩa/âm thầm sai → PHÁT HIỆN. |
| C4 | **Type & lint** | `bunx tsc --noEmit` sạch; eslint sạch (qua gate); không `any` lộ, không dead code. |
| C5 | **Test** | Mỗi hàm ≥ 2 case đối chứng (spec); kì vọng test được kiểm chứng độc lập; MỖI fix phải kèm ≥ 1 test case mới chứng minh lỗi cũ đã hết (regression). Test chỉ chạy qua gate, không `bun test` trực tiếp. |
| C6 | **Tài liệu** | JSDoc khớp hành vi THỰC (không nói một đằng trả một nẻo); phát hiện mức P0/P1 có entry `Bug_v2.md` đầy đủ; P2/P3 ghi trong biên bản đợt (mục 6). |
| C7 | **Tích hợp** | Import smoke từ ≥ 2 nơi; barrel export đủ; không xung đột tên; thay đổi additive — không phá đường chạy nóng khi chưa có cờ bật. |
| C8 | **Vệ sinh** | Không file rác / scratch trong repo (chỉ /tmp); không console.log; không comment lừa dối; git status sạch trước khi kết luận. |

## 4. QUY TẮC GHI NHẬN

- Mỗi phát hiện gán ID: **FB{phần}-R{vòng}-{số}** (vd `FB-P0-R1-01`), kèm loại A-H + mức P0-P3 theo legend `Bug_v2.md`.
- Phát hiện mức **P0/P1/P2 có tác động consumer** → bắt buộc thêm entry `Bug_v2.md` (đánh số BUG2-0NN tiếp theo); P3 còn lại ghi trong biên bản đợt là đủ.
- Mỗi fix ghi: file:line đụng, cách fix, bằng chứng xác minh (giá trị trước/sau + gate).
- **Sai kì vọng phía người rà** (phát hiện hóa ra do mình tính sai) cũng phải ghi nhận ngắn gọn — đó là dữ liệu chống tự tin sai cho các vòng sau (không tính vào "phát hiện mới" khi quyết định dừng).

## 5. RÀNG BUỘC AN TOÀN

1. **Tối đa 5 vòng/phần.** Vòng 5 vẫn còn phát hiện mới → DỪNG, BÁO USER (nghi ngờ spec mơ hồ hoặc vòng lặp fix-sinh-lỗi — cần phán quyết người, không được tự quay tiếp).
2. **Không tự tuyên bố sạch** nếu bỏ qua bất kỳ mục checklist nào — mỗi vòng phải để lại dấu vết: lệnh đã chạy, file đã đọc, giá trị đã tính (ghi trong worklog phiên tương ứng).
3. Fix vòng N phải qua **XÁC MINH đầy đủ** (gate PASS + test mới) TRƯỚC khi sang vòng N+1 — không tích luỹ nợ xác minh.
4. **NGHIÊM CẤM** fix điểm này gãy điểm khác rồi coi như xong: vòng sau luôn rà lại TOÀN BỘ scope, kể cả phần vừa fix và phần từng "đạt" từ vòng 1.
5. Auditor độc lập (subagent/nghười khác) khuyến khích ở vòng 1 (mắt không bị ám bởi người viết code), nhưng kết luận của auditor cũng chỉ là **nghi vấn** cho tới khi được chấm chéo (mục C2).
6. Không mở rộng scope giữa chừng (phát hiện ngoài scope → ghi vào "phát hiện ngoài phạm vi" bàn cho đợt sau, không fix trong đợt này).

## 6. BIÊN BẢN CÁC ĐỢT ĐÃ CHẠY

### ĐỢT FB-P0 — scope: P0-1 (7 module `src/lib/stats/` + `tests/r76-stats-core.test.ts` + Bug_v2-035..038 + hạ tầng gate commit 9ae69bb/c74388c) — 2026-10-10

**Vòng R1 — rà soát (101 phép kiểm chứng độc lập trên harness riêng — thuật toán thay thế hoàn toàn: erf chuỗi Maclaurin, logGamma Stirling-Bernoulli, CDF Simpson tích phân, Fisher BigInt hữu tỉ, LCS ma trận đầy; ~60 dòng probe edge-case chạy thật; tsc; đọc spec/7 module/test/Bug_v2):**

Phát hiện (đã chấm chéo đủ 3 phía — code / kì vọng độc lập / phương pháp thứ ba):

| ID | Loại·mức | Phát hiện | Vị trí |
|---|---|---|---|
| FB-P0-R1-01 | C·P1 | `aucRoc` thiếu điểm neo gốc (0,0): nhóm score cao nhất lẫn 2 lớp (tie đỉnh) → mất diện tích tam giác gốc; toàn-tie → AUC 0 thay vì 0.5. Đối chứng 8 bộ: 4 lệch (0.75→0.5, 0.5→0, 0.5→0, 0.3333→0.25), 4 khớp. Vi phạm định nghĩa chuẩn AUC = P(T>F) + ½P(T=F). → **BUG2-039** | classification.ts `aucRoc` |
| FB-P0-R1-02 | C·P2 | `mannWhitneyU` với dữ liệu chứa NaN: sort nuốt NaN → z/p rác âm thầm (probe [NaN,1] vs [1,2] → z=−1.22, p=0.22) — nguy hiểm cho consumer kiểm định Layer 9 ăn dữ liệu DB bẩn; NaN phải lan toả thành NaN như các hàm khác. → **BUG2-040** | inference.ts `mannWhitneyU` |
| FB-P0-R1-03 | C·P3 | `zScore` σ âm đổi dấu vô nghĩa (−0.5), σ NaN → NaN lệch convention fail-open 0. | descriptive.ts `zScore` |
| FB-P0-R1-04 | C·P3 | `iqrBounds` k âm → low/high ĐẢO CHIỀU (low 3.25 > high 1.75); k NaN → low/high NaN nhưng q1/q3 số (không nhất quán). | descriptive.ts `iqrBounds` |
| FB-P0-R1-05 | C·P3 | `meanCI` z âm → low/high đảo chiều (low 2.48 > high 0.52); z=0 vô nghĩa không chặn. | inference.ts `meanCI` |
| FB-P0-R1-06 | C·P3 | `wilsonCI` p ngoài [0,1] vi phạm nhỏ + n lớn có thể lọt guard sqrt tự nhiên (p=1.05, n=10 → sqrt vẫn dương) cho cặp trông hợp lệ. | inference.ts `wilsonCI` |
| FB-P0-R1-07 | C·P3 | `chiSquare2x2` cell âm: chi2 tính số rác hữu hạn trong khi p=NaN (không nhất quán — bảng không hợp lệ phải NaN cả hai). | inference.ts `chiSquare2x2` |
| FB-P0-R1-08 | D·P3 | `silhouetteFromGraph` JSDoc không ghi hành vi w không hữu hạn (w=∞ → w'=NaN → node đó âm thầm s=0); Leiden thực tế không sinh được w ngoài [−1,1] nhưng phải ghi rõ để consumer khác không tưởng lầm. | cluster-quality.ts JSDoc |

Sai kì vọng phía người rà (ghi nhận, không tính phát hiện): 11/12 "FAIL" của harness auditor độc lập là sai số học của chính auditor (b(i) sai 3 node ở silhouette; S₁ sai ở Davies-Bouldin; dùng variance thay standard-error ở Welch; gõ `9*6` thay `9` ở MW-σ; N+1=5 thay 6 ở cross-tie; chia 7 thay 6 token ở rougeL-F1; quên item thứ 4 ở sweep precision; tol=0 khiến 2 case diff=0 vẫn FAIL; Maclaurin erf hardcode lệch 1.3e-5 so với Simpson+A&S). Code ĐÚNG cả — xác nhận lần 3 cho bài học r79: chấm chéo CẢ HAI phía.

ĐẠT không phát hiện: mutation đầu vào (0/8 hàm mutate) · throw contract 7/7 · barrel đủ, không xung đột tên · mỗi hàm ≥2 test case · 4 adjudication BUG2-035..038 khớp code+test · tsc sạch.

**Fix R1 + xác minh (7 test regression mới trong r76, tổng 42→49 test):**
- FB-P0-R1-01: `aucRoc` chèn neo (0,0) khi điểm fpr nhỏ nhất chưa ở gốc (JSDoc đầy đủ). Kiểm chứng: 12 bộ ngẫu nhiên có tie khớp pairwise AUC < 1e-12; 4 test mới 0.75/0.5/0.5/⅓; giá trị cũ không đổi (2/3, 1.0).
- FB-P0-R1-02: `mannWhitneyU` quét `Number.isFinite` 2 mảng → NaN cả 3. Trước/sau: z=−1.22 rác → NaN.
- FB-P0-R1-03/04/05/06/07: guard tham số (`σ ≤ 0` → 0; `k` không hữu hạn/âm → NaN cả 4; `z ≤ 0` → NaN; `p` ngoài [0,1] → NaN; ô âm → NaN cả hai) — mỗi guard 1 test regression.
- FB-P0-R1-08: JSDoc bổ sung quy ước w không hữu hạn.
- Gate vòng 1 sau fix: **FAIL 1 test** — chính kì vọng test của orchestrator sai (ghi AUC "nhiều tầng tie" = 0.625 do đếm thiếu cặp: 3T×2F = 6 cặp, đúng = 2/6 = ⅓ — vòng lặp r79 lần thứ 4 tái bản, lần này gate bắt được). Sửa kì vọng → gate PASS toàn bộ 49.2s.

**Vòng R2 — rà lại toàn bộ scope (kể cả 5 file vừa fix):**
- Quét tính đối xứng tham số trên toàn bộ 30 hàm export → phát hiện **FB-P0-R2-01 · C·P3**: `wilsonCI` nhận tham số `z` nhưng KHÔNG guard z âm/0 (meanCI đã guard ở R1) — z âm trả CI đảo chiều trông hợp lệ, cùng lớp lỗi FB-P0-R1-05. Fix: thêm `!(z > 0)` vào guard + test regression + JSDoc. Gate PASS 51.6s sau fix.
- Chạy lại probe edge-case toàn bộ: mọi hành vi mới khớp JSDoc đã cập nhật (iqrBounds k âm → NaN cả 4; zScore σ âm → 0; meanCI/wilsonCI z âm → NaN; chiSquare2x2 ô âm → NaN cả hai; MWU NaN → NaN cả 3); hành vi cũ giữ nguyên (iqrBounds([7]) = 7/7/7/7…).
- 0 console.log; git status chỉ 5 file chủ đích + fixbug.md.

**Vòng R3 — rà lại toàn bộ scope (lần cuối):**
- Đọc lại full diff bằng mắt tươi (136 dòng thêm / 18 dòng xoá trên 5 file) — mọi guard đúng vị trí, không đổi chữ kí công khai nào, không phá hành vi hợp lệ.
- Bộ kiểm chứng độc lập chạy lại trên code đã fix: **16/16 PASS** (aucRoc khớp pairwise 12 bộ; 6 guard trước/sau; 6 giá trị chuẩn không đổi; wilsonCI z).
- Gate lần 3: **PASS toàn bộ 51.6s — 644/644 test** (49 test r76: 42 gốc + 7 regression).
- Checklist C1-C8: C1 khớp spec 30/30 hàm · C2 toán học chấm chéo 3 phía đạt · C3 edge case khớp JSDoc · C4 tsc/lint/imports sạch · C5 mỗi hàm ≥2 case + mỗi fix có regression · C6 JSDoc khớp hành vi + BUG2-039/040 đã ghi · C7 barrel/integration không đổi · C8 vệ sinh sạch.
- **KẾT LUẬN R3: 0 phát hiện mới → đạt cả 3 tiêu chí dừng → ĐỢT FB-P0 KHÉP KẾT sau 3 vòng.**

**Nghiệm thu đợt FB-P0:** 9 phát hiện (R1: 1 P1 + 1 P2 + 6 P3; R2: 1 P3) — tất cả đã fix + regression test; 11 sai-kì-vọng-phía-người-rà ghi nhận; gate PASS 4 tầng 51.6s (644 test, 2620 expect); 2 entry Bug_v2 mới (039, 040); không để lại việc hoãn nào trong scope.


### ĐỢT FB-P1 — scope: P1-M1→M4 đợt 2 (commits 78a1e7d + 5ab5555 + 3758b01 + e6f2433: verdict-scorecard + relevance/runner nDCG-MRR + anomaly-detector + KPI layer + 4 test r76 + schema EvalResult/EvalRun/MetricAnomaly/KpiSnapshot + nghiệm thu live) — 2026-10-10

**Vòng R1 — rà soát (đọc full diff 16 file/1680 dòng bằng mắt tươi + 11 nhóm kiểm chứng độc lập trên scratch/fb-p1-verify.ts — thuật toán thay thế: AP chuẩn sklearn threshold-based, brute-force DCG/IDCG, quantile sort-index nội suy, bảng status if-else viết lại, 2000 case random relevance + 200 case random confusion + 300 trial IQR/AUC-PR/nDCG + nghiệm thu live 4 endpoint):**

Phát hiện (đã chấm chéo đủ 3 phía — code / kì vọng độc lập / phương pháp thứ ba):

| ID | Loại·mức | Phát hiện | Vị trí |
|---|---|---|---|
| FB-P1-R1-01 | G·P2 | Quality gate để lại ToolMetric TEST trong DB production: shr-cot-todo mục G + protected-paths gọi HTTP thật vào app sống (/api/tools/execute) — app ghi ToolMetric vào DB thật (156/156 row đều test: 39 test-shr + 117 test-infra-guard, trải 08:22→10:15 đúng các lần gate). DB-cô-lập KHÔNG phủ side-effect HTTP xuyên process. Làm bẩn CHÍNH lớp đo P1-M3 (13 "anomaly" toàn test data) + P1-M4 (tool_success_rate n=156 test rows). → **BUG2-041** | tests/shr-cot-todo.test.ts, tests/protected-paths.test.ts |
| FB-P1-R1-02 | C·P3 | KPI status hiện on_target/off khi sampleSize=0 — kb_fallback_rate n=0 hiện "on_target": đọc nhầm "đạt mục tiêu" cho phép đo CHƯA TỒN TẠI (value=0 chỉ vì chưa có dữ liệu). | kpi/compute.ts statusForKpi |
| FB-P1-R1-03 | C·P3 | anomaly-detector group key + dedupeKey dùng separator space/`\|` — toolName chứa space (`"a b"`+role `"c"` ≡ tool `"a"`+role `"b c"`) gộp nhầm 2 nhóm khác bounds / khoá trùng sai. | anomaly-detector.ts |
| FB-P1-R1-04 | G·P1 | callLLM HTTP 410 Gone (model decommission) rơi 'server_error' → sweep 12 attempts nhanh (~0.1s) không cạn budget thiết kế cho timeout 240s → vòng cooldown 15s LẶP VÔ HẠN — eval run treo 0/3 suốt 18+ phút (bằng chứng live cmv29082p…). Tiền lệ 404 cùng dòng cùng lý do. → **BUG2-042** | llm.ts attemptNvidiaOnce |
| FB-P1-R1-05 | H·P3 | Vận hành: eval run treo trên cần đánh dấu failed + re-run; 156 row test cần dọn khỏi production. | db/custom.db |
| FB-P1-R1-06 | G·P1 | NVIDIA model matrix RÁC TOÀN PHẦN (bộc lộ sau R1-04 fix): deepseek-v4-flash (eval answer) + gpt-oss-120b (judge 1) + minimax-m3 (judge 3 VÀ agent primary) đều 410 EOL; chỉ kimi-k3 sống. Faithfulness eval = rác; agent chat phụ thuộc failover. → **BUG2-043 — CHỜ USER quyết định matrix mới (điểm dừng quyết định), không tự ý đổi trong đợt 2** | llm.ts, eval/judges.ts, eval/runner.ts |

Sai kì vọng phía người rà (ghi nhận): 1/11 nhóm kiểm chứng FAIL là SAI PHÍA COMPARATOR — altAP sort tie "positive trước" (optimistic ordering) thay vì threshold-based chuẩn sklearn; code ĐÚNG. Bài học FB-P0 lặp lại lần 5: chấm chéo bằng phương pháp thứ ba TRƯỚC khi kết luận.

ĐẠT không phát hiện: 11/11 nhóm kiểm chứng độc lập sau khi sửa comparator (AUC-PR 300 trial tie < 1e-12; nDCG brute-force 300 trial; MRR 200 trial; IQR sort-index 300 trial; status 2×6×16 nhánh; relevance 2000 case random — retrievedCount === cách đếm cũ 2000/2000 + first-occurrence 2000/2000; confusion/prf1 200 trial; round4) · verdict-scorecard zero-state + windowDays + byAgent + forcedDowngrade đúng · anomaly n<20 skip + idempotent + prune >30 ngày đúng (test) · KPI 9 giá trị khớp seed tính tay + upsert idempotent · runner rel wiring không đổi semantics recall · 0 ký tự CJK (grep) · smoke import barrel.

**Fix R1 + xác minh (gate PASS 51.6s sau fix, 672 test):**
- FB-P1-R1-01: guard mục G shr-test bằng env `TMO_SHR_HTTP_E2E=1` (gate hermetic; E2E thủ công giữ nguyên đường) + protected-paths TỰ DỌN ToolMetric test-infra-guard bằng BunSqlite (750ms đợi fire-and-forget land, busy_timeout, pattern cleanup sẵn có) + dọn 1 lần 156 row khỏi production. Kiểm chứng: gate chạy lại xong ToolMetric count = 0.
- FB-P1-R1-02: KpiComputed status = 'no_data' khi n===0 (thêm type + ưu tiên trước mọi so target; cả nhánh compute lỗi). Test mới: xoá EvalRun → eval_ndcg/eval_recall n=0 → no_data; KPI còn dữ liệu vẫn tính status bình thường.
- FB-P1-R1-03: group key + dedupeKey chuyển sang NUL separator `\u0000` (không thể xuất hiện trong tên đã trim). Sự cố quá trình: lần perl đầu chèn NUL BYTE THẬT vào file (grep báo binary) — phát hiện qua file(1), thay bằng escape sequence + file trở lại UTF-8 text sạch.
- FB-P1-R1-04: thêm 410 vào isDeterministic4xx (đúng vị trí tiền lệ 404). Kiểm chứng LIVE: re-run baseline eval hoàn tất 3/3 trong ~7 phút (trước fix: ∞) — log "bad_request (HTTP 410) — dừng xoay vòng" ngay sau key đầu.
- FB-P1-R1-05: run treo → status failed + errorMessage ghi nguyên nhân; production DB sạch.
- relevance.ts: precompute normalize entity 1 lần (bỏ O(chunks×entities) phép gọi thỡ) — hygiene kèm, không đổi hành vi (2000 case random xác minh lại sau fix).

**Baseline P1-M2 ghi nhận sau fix (run cmv29vh180001na7dkz82772i, 3 case = 2 security + 1 negative trên KB 1 document đã reconcile + embed lại):** avgRecall@5=0.667 · **avgNdcg@5=0.626** · **avgMrr=0.667** (per-case: 0.877/1.000/0.000 — case negative 0 đúng thiết kế). Faithfulness=0.333 KHÔNG đáng tin (1/3 judge sống — BUG2-043). Thỏa kiểm chứng blueprint: eval run mới có avgNdcg/avgMrr ≠ 0; nDCG ∈ [0,1].

**Vòng R2 — rà lại toàn bộ scope (kể cả 7 file vừa fix):** xem mục dưới (cập nhật sau vòng).
