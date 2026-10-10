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

**Vòng R2 — rà lại toàn bộ scope (kể cả 7 file vừa fix):**
- Chạy lại harness 11 nhóm trên code đã fix (relevance precompute đổi code): **11/11 PASS**.
- Quét tham số đối xứng toàn bộ hàm mới (windowDays 2 tầng route/lib, lookbackDays 2 tầng, clamp kẹp đúng; agentName null → 'unknown'; byAgent phân vùng đầy đủ) — 0 phát hiện mới.
- Nghiệm thu live sau restart: scorecard n=0 + note đúng · KPI no_data đúng ngữ nghĩa (5 KPI n=0 → no_data; eval_ndcg 0.626 n=3 baseline hiện diện; kb_fallback_rate 0.667 n=3 đo thật) · scan trên DB sạch scanned=0.
- Dọn nốt 13 MetricAnomaly ARTIFACT (sinh từ test data đã bị xoá ở R1 — dữ liệu nguồn không còn thì anomaly không còn nghĩa) → scan lại 0/0. Ghi nhận bài học vận hành: xoá dữ liệu nguồn phải kèm xoá anomaly dẫn xuất.
- Kiểm tra import cũ tham chiếu runner/normalize — nhất quán (runner tự import relevance; không chỗ nào khác import hàm đã chuyển).
- Cấu trúc file guard shr (RUN_HTTP_E2E) + cleanup protected-paths chạy qua gate PASS — không vỡ.

**Vòng R3 — xác nhận cuối:**
- Đọc lại full diff đợt 2 (efefb80..ebea23d + biên bản: 22 file, ~2240 dòng thêm) — mọi fix đúng vị trí, không đổi chữ kí công khai, hành vi hợp lệ giữ nguyên.
- Gate cuối: **PASS toàn bộ 51.7s — 671/671 test / 38 file** (đếm độc lập: DATABASE_URL đúng TMO + bun test 671 pass 0 fail; lưu ý `bun test` trực tiếp từ shell với DATABASE_URL scaffold cho 3 fail giả — đúng nguyên tắc 'KHÔNG bun test trực tiếp', gate là nguồn sự thật).
- Checklist C1-C8: C1 khớp spec blueprint P1-M1..M4 từng dòng · C2 toán chấm chéo 11 nhóm độc lập + comparator thứ ba · C3 edge-case (zero-state/clamp/n<20/idempotent/prune/n=0) có test · C4 gate 4 tầng PASS · C5 mỗi module có test r76 riêng + mỗi fix R1 có kiểm chứng (live hoặc test) · C6 Bug_v2 041-043 + biên bản đầy đủ · C7 import/runner/overview không vỡ (671 test + live) · C8 0 CJK, 0 console.log mới, git status sạch.
- **KẾT LUẬN R3: 0 phát hiện mới → đạt cả 3 tiêu chí dừng → ĐỢT FB-P1 KHÉP KẾT sau 3 vòng.**

**Nghiệm thu đợt FB-P1:** 6 phát hiện R1 (2 G·P2/P1 + 1 G·P1 chờ-user + 2 C·P3 + 1 H·P3) — 5 fix ngay + 1 (BUG2-043 model matrix) chuyển điểm dừng quyết định user theo giao thức; 1 false-alarm comparator ghi nhận (lần 5); gate PASS 4 tầng 51.7s (671 test); 3 entry Bug_v2 mới (041, 042, 043); baseline P1-M2 thật được ghi (avgNdcg@5=0.626 / avgMrr=0.667 / avgRecall@5=0.667, n=3) sau khi tháo nghẽn 410; không để lại việc hoãn nào trong scope.

### ĐỢT FB-ĐỢT3 — scope: P1-M5 đợt 3 (commit 7e1e656: community-quality.ts thuần toán + communities.ts gắn flow/persist/lastQuality + route ?sweep=1 + 11 test r76) + kèm DIRECTED FIX kimi-k3 timeout (user directive 2026-12-01, xem biên bản) — 2026-10-10

**Bối cảnh:** user directive 2026-12-01 — (1) kimi-k3 là siêu model, chậm 2-6 phút/call là bình thường, hệ thống chạy liên tục hàng tiếng đồng hồ nên KHÔNG được giết call chậm-hợp-lệ; (2) trước khi sang đợt 4, kích hoạt giao thức Fixbug cho toàn bộ đợt 3 đã triển khai.

**DIRECTED FIX (ngoài scope P1-M5, theo nguyên văn directive — thực hiện TRƯỚC vòng rà):** kimi-k3 NIM sống nhưng chậm (~120s prompt tối giản, 2-6 phút agent cycle 42k context — live task-85) trong khi base timeout NIM chung 240s (LLM_TIMEOUT_MS) → call chậm-hợp-lệ bị abort giữa chừng → đếm TIMEOUT-STRIKE (2 strike/30') → breaker trip 10' oan → ép fallback space-bunny-free dù model đang sống. Fix: `KIMI_K3_TIMEOUT_MS` (default 600s = 10 phút, env override, floor 60s) áp TẬP TRUNG tại callModelWithKeyRotation — mọi đường kimi-k3 (agent callLLMForAgent + judge callLLM override) đều qua đây; nemotron-550b extraction (~5s live) giữ 240s; budget xoay key 15' giữ nguyên (hang thật vẫn cắt trong 15' rồi fallback Zen). Kèm: prober (default OFF) floor probe-timeout 300s riêng cho kimi-k3 (probeTimeoutFor) — nếu bật sau này thì probe 90s mặc định sẽ trip breaker oan model đang-chậm-không-phải-hang; comment cũ "kimi-k3 hay hang kéo dài ~120s/call" ĐÓNG KHUNG SAI (đó là chậm, không phải hang) — viết lại theo directive.

**Vòng R1 — rà soát (đọc spec §P1-M5 + full diff 61d13aa..7e1e656 4 file/668 dòng + harness độc lập /home/z/fb-scratch/fb-p1m5-r1-verify.ts 332 phép: silhouette viết LẠI từ định nghĩa blueprint (cấu trúc khác hoàn toàn — quét cạnh theo node, Map theo nhãn) + fuzz 300 graph ngẫu nhiên (n 1-35, trọng số 0/âm/1000/thường, nhãn random) + toán tay 3-clique 0.9697 + DBI/CH tay + wrapper≡stats-trực-tiếp + probe Neo4j Integer Number() + degenerate + env gate + no-mutation):**

Phát hiện (đã chấm chéo đủ 3 phía):

| ID | Loại·mức | Phát hiện | Vị trí |
|---|---|---|---|
| FB-P1M5-R1-01 | D·P3 | Test title `3 clique rõ → silhouette ≈ 0.879` + comment `phân hoạch 3 cụm cho silhouette ~0.879` — SÓT LẠI từ lần tính tay SAI đầu tiên của chính đợt triển khai (worklog task-86 ghi rõ "lần đầu tính 0.879 SAI — quên 9 node không cầu"; body test đã sửa sang 0.9697 nhưng title/comment quên) → gây hiểu nhầm người đọc sau. Fix: title + comment đổi đúng 0.9697 kèm phân tích 9×1.0 + 3×0.8788. | tests/r76-leiden-quality.test.ts |
| FB-P1M5-R1-02 | C·P3 | `sweepGamma` JSDoc + `GammaSweepResult.best` hứa tie-break "rồi γ nhỏ hơn cho ổn định" — cơ chế thật là "candidate ĐẦU TIÊN trong thứ tự grid thắng tie tuyệt đối": đúng cho grid mặc định tăng dần, KHÔNG đúng cơ học cho grid custom descending/trùng lặp. Thực tế bậc modularity tự chọn γ nhỏ cho cùng phân hoạch (Q giảm nghiêm ngặt theo γ) nên hành vi quan sát được gần như luôn khớp doc — nhưng doc-code không khớp TUYỆT ĐỐI. Fix: thêm bậc 3 so γ trực tiếp `gamma < best.gamma` (0 đổi hành vi grid mặc định) + JSDoc giải thích cơ chế + regression test grid descending + grid trùng lặp. | community-quality.ts sweepGamma |

Sai kì vọng phía người rà (ghi nhận, lần 6): 1/332 phép harness FAIL — CH tính tay 44700.5 vs code 45000: người rà nhầm grand-centroid (lấy 5.0167 thay vì 30.2/6=5.0333 — grand là mean 6 điểm, KHÔNG phải trung điểm đôi centroid). Sửa kỳ vọng bằng phân số chính xác (SSB=300, SSW=2/75 → CH=45000) → PASS. Code ĐÚNG. Bài học FB-P0/P1 lặp lại: chấm chéo bằng phương pháp thứ ba (phân số chính xác) TRƯỚC khi kết luận.

ĐẠT không phát hiện: fuzz 300/300 khớp độc lập ±1e-12 (trọng số 0/âm/1000/NaN-lan-toả-0 đúng quy ước FB-P0-R1-08) · 3-clique tay 0.969697 khớp tuyệt đối · node rời rạc trong cụm >1 → s=−1 đúng JSDoc phạt gán tệ · labels sai độ dài throw · n=0/1-cụm → 0 (sklearn) · DBI tay 0.0092818 khớp · wrapper DBI/CH === stats trực tiếp (phương pháp thứ ba) · null-guard <2 điểm/1 nhãn/vector rỗng · grid rỗng fallback/1 phần tử · env on/1/true/ON/'  true  '/yes/0 · KHÔNG mutate đầu vào · sweep invariants (best=max candidates, best khớp candidate cùng γ, nodeCommunity độ dài n) · Neo4j Integer có valueOf → Number() an toàn (probe trực tiếp — nghi vấn dismissed) · concurrency guard an toàn cho env-mutation sweep (cửa sổ sync sub-ms) · iterations/communitySizes placeholder không bị tiêu thụ · persist SET null → remove prop → đọc lại null nhất quán (không stale) · extraction nemotron không dính timeout kimi-k3.

**Fix R1 + xác minh:** 2 phát hiện P3 fix (title/comment 0.9697 + bậc 3 tie-break γ + regression test descending/duplicate grid). Harness chạy lại trên code đã fix: **332/332 PASS**. Gate PASS 61.5s — **683/683 test** (682→683, +1 regression).

**Vòng R2 — rà lại toàn bộ scope (kể cả 3 file vừa fix):**
- Rà đối xứng trên fix mới: bậc 3 tie-break chỉ THÊM trường hợp thay thế (double-tie + γ nhỏ hơn) — không mất candidate, invariant best.silhouette=max(candidates) bảo toàn (harness xác nhận); NaN không lan vào tie-break (silhouette luôn hữu hạn — NaN weight đóng góp 0).
- kimi-k3 timeout đối xứng: explicit rotationOpts.timeoutMs vẫn được tôn trọng (??-chain đúng thứ tự); chỉ default đổi cho đúng KIMI_K3_NIM_ID; callModelChainModelFirst (hàm xoay thứ 2) là legacy không-caller (chain zen) — xác nhận không đường kimi-k3 nào bypass.
- Regression test mới tự kiểm: assertion robust cho cả nhánh leiden deterministic (task-86 đã chứng minh hash communityId ổn định) và không.
- 0 phát hiện mới.

**Vòng R3 — xác nhận cuối:**
- Đọc lại full diff working tree bằng mắt tươi (3 file, 82 dòng thêm: community-quality tie-break + llm.ts timeout/prober + test) — mọi thay đổi đúng vị trí, không đổi chữ kí công khai, hành vi grid mặc định giữ nguyên tuyệt đối.
- Gate cuối: **PASS toàn bộ 61.5s — 683/683 test / 39 file** (tsc + lint + imports + tests; 2853 expect).
- Checklist C1-C8: C1 khớp spec §P1-M5 từng mục (silhouette đồ thị chính / DBI-CH phụ informative / grid γ 5 mốc × restarts / env default OFF / detectWithSweep bọc / route quality / log kiểm chứng) · C2 332 phép độc lập + 2 lần chấm chéo · C3 degenerate có probe + test · C4 gate 4 tầng PASS · C5 12 test r76 (11→12) mỗi hàm ≥2 case + fix có regression · C6 JSDoc khớp hành vi tuyệt đối sau R1-02, stale 0.879 đã sửa, 2 phát hiện đều P3 → ghi biên bản là đủ (không cần entry Bug_v2 theo quy tắc P3) · C7 import 2 nơi không xung đột, additive, env OFF giữ hành vi cũ · C8 git status chỉ 3 file chủ đích, scratch ngoài repo (/home/z/fb-scratch), module thuần 0 console.log.
- **KẾT LUẬN R3: 0 phát hiện mới → đạt cả 3 tiêu chí dừng → ĐỢT FB-ĐỢT3 KHÉP KẾT sau 3 vòng.**

**Nghiệm thu đợt FB-ĐỢT3:** 2 phát hiện R1 (2×D·P3 — đều doc-fidelity, không lỗi toán/toán đúng độc lập 332 phép) + 1 directed fix kimi-k3 timeout theo nguyên văn user; 1 sai-kỳ-vọng-người-rà (CH, lần 6); gate PASS 683/683; live: PM2 restart sạch, / 200, /api/health healthy, community-status trả lastQuality đầy đủ qua restart (silhouette 0.8681 / Q 0.8322 / DBI 3.28 / CH 7.79 / 348 stored), E2E kimi-k3 thật (job cmv2inzxf000cnawy4xcimp2o). Không để lại việc hoãn nào trong scope.

### ĐỢT FB-ĐỢT4 — scope: P2-M1 + P2-M2 đợt 4 (commits eeab02b + 53faf31 + 5e8ca42: threshold-sweep.ts + route /api/eval/threshold-sweep + REPORT-P2-M1-THRESHOLD-SWEEP + Wilson CI successCI/overallSuccessCI khi aggregate + getSuccessProbabilityWithCI chuỗi fallback có guard + getAdjustedBudget guard CI + rule resource_limit guard CI + runner meanCI log + KPI meta.ci + 2 test r77 35 test + layer9 fixtures) — 2026-10-10

**Vòng R1 — rà soát (đọc spec §P2-M1/§P2-M2 + full diff 12 file/1323 dòng + harness độc lập /home/z/fb-scratch/fb-dot4-r1-verify.ts 3750 phép: sweep cài đặt thay thế insertion-sort + đếm for..of, AUC-ROC PAIRWISE P(T>F)+½P(T=F) — khác hoàn toàn tích phân hình thang, AUC-PR nhóm-theo-mức-recall — khác cấu trúc vòng ngưỡng-giảm-dần, Wilson triển khai ký tự khác, chuỗi fallback viết lại dạng vòng lặp bậc; fuzz 300 bộ sweep + 200 bộ chain/budget + 7 probe edge determinism + probe NaN + Wilson công thức độc lập 9 bộ + live route 2 target):**

Phát hiện (đã chấm chéo đủ 3 phía — code / kì vọng độc lập / phương pháp thứ ba):

| ID | Loại·mức | Phát hiện | Vị trí |
|---|---|---|---|
| FB-Đợt4-R1-01 | C·P3 | `buildSweepReport` không guard score không hữu hạn: NaN đi qua → bảng điểm chứa dòng ngưỡng NaN + mẫu đó không bao giờ được dự đoán dương mà vẫn đếm vào n (probe thật: [0.9, NaN, 0.4] → hasNaNThreshold=true). Cả 2 DB caller đã lọc Number.isFinite nhưng hàm thuần xuất khẩu công khai mời gọi nhầm. Fix: throw tường minh (cùng convention length-mismatch của stats). | threshold-sweep.ts buildSweepReport |
| FB-Đợt4-R1-02 | C·P3 | 3 khuyến nghị chọn/lọc trên giá trị ĐÃ round4 (display) thay vì thô: max_f1 argmax có thể lệch tới 5e-5 so với f1 thật; precision_gte_0.9/recall_gte_0.9 có thể nạp ứng viên có giá trị thô < 0.9 (chênh ≤ 5e-5). AUC đã đúng dùng rawPoints — recommended thì chưa. Fix: chọn/lọc trên raw + tie-break f1 với ε=1e-12 (2 f1 bằng nhau toán học nhưng lệch 1 ULP float phải là TIE để bậc precision quyết — không để noise ULP thắng), chỉ round khi xuất. | threshold-sweep.ts recommended |

Sai kì vọng phía người rà (ghi nhận, lần 7 — tái bản đúng bài học FB-P0/P1/Đợt3): 5/3750 phép harness "FAIL" đầu tiên đều là comparator của harness ULP-cảm ứng — 5 bộ fuzz (65/204/261/283/299) đều có f1 tie toán học đúng 2/3 (…652 vs …663 lệch 1 ULP) mà harness so thô không-ε cho phép "thắng" của noise; code (round→tie→tie-break precision) cho đáp án ĐÚNG toán trong cả 5 bộ (P=0.75>0.5, 0.6>0.5, 0.75>0.571>0.5, 0.5455>0.5, 0.5455>0.5). Thêm 1 lần nữa ở chính đợt này khi soạn regression test biên: người rà đếm nhầm fp (negative 0.4 vào ngưỡng 0.5) — code ĐÚNG, test kỳ vọng sửa theo phân tích lại. Chấm chéo bằng phương pháp thứ ba (tái lập chuỗi fuzz + in từng f1 thô/round) TRƯỚC khi kết luận.

ĐẠT không phát hiện: fuzz 300/300 sweep khớp alt (points/precision/recall/f1/tpr/fpr từng điểm + marks 19 mốc từng giá trị + 3 tiêu chí khuyến nghị) · AUC-ROC khớp pairwise định nghĩa chuẩn mọi bộ 2 lớp · AUC-PR khớp recall-levels mọi bộ có positive · Wilson 9 bộ khớp công thức độc lập < 1e-12 (n=5 p=0.8 → [0.375528, 0.963777] width 0.588>0.5 → guard chặn đúng ví dụ blueprint) · fuzz 200/200 chuỗi fallback + budget khớp alt · getSuccessProbability nguyên vẹn (đối chứng 5 caller) · KHÔNG mutate đầu vào · P2-M2 spec từng mục (successCI khi aggregate / WithCI song song / guard n≥5∧width≤0.5 / log CI runner / KPI meta thay cột schema / ví dụ n=5 p=0.8) · live route 2 target + invalid-target 400.

**Fix R1 + xác minh:** throw guard không-hữu-hạn (3 expect throw test) + recommended trên raw với ε-tie (biên ≥ 0.9: bộ thiết kế dòng-biên-là-lựa-chọn phân biệt ≥/> ở cả 2 tiêu chí; ULP: khoá bằng chính dữ liệu fuzz#65 thật). Harness sửa comparator cùng ngữ nghĩa ε → **3750/3750 PASS**. Gate PASS 95.1s (722 test).

**Vòng R2 — rà lại toàn bộ scope (kể cả 2 file vừa fix):**
- Phát hiện **FB-Đợt4-R2-01 · C·P3**: `aucRoc` hiển thị 0 khi một lớp vắng mặt — live evaluator n=2 toàn positive trả AUC-ROC=0, bị đọc nhầm "đường cong tệ nhất" trong khi thiếu cặp T/F nào để xếp hạng (không định nghĩa được). Đối xứng precedent P1-M1 (aucPr null khi hết positive). Fix: null khi positives=0 HOẶC negatives=0 + regression 2 test (toàn dương → null nhưng aucPr vẫn 1; 0 positive → null cả hai). Sự cố quá trình: lần sửa đầu tiên khai báo trùng `totalNeg` (đã có sẵn ở vòng đếm) — tsc sẽ bắt nhưng phát hiện bằng grep trước khi chạy; bỏ dòng trùng.
- Đối xứng trên fix R1: guard throw đứng SAU length-check, TRƯỚC zero-state (mảng rỗng vẫn zero-state không throw) ✓; ε-tie chỉ thêm nhánh thay thế, mọi giá trị phân số chính xác từ test R1 giữ nguyên tuyệt đối (38/38 cũ không đổi) ✓; ε không áp cho precision (tp/fp bằng nhau → float bằng nhau tuyệt đối; khác counts → khác ≥ 1/(n(n+1))) ✓.
- Live sau R2: evaluator n=2 (verdict mới resolve giữa chừng — dữ liệu sống tăng), recommended 0.85; KB n=4 không đổi; invalid-target 400 ✓.
- 0 phát hiện khác.

**Vòng R3 — xác nhận cuối:**
- Đọc lại full diff fix (eea09df + 2b44014 + report làm tươi n=2) bằng mắt tươi — mọi guard đúng vị trí, không đổi chữ kí công khai nào, hành vi dữ liệu 2 lớp giữ nguyên tuyệt đối.
- Harness cuối: **3750/3750 PASS** · test r77 39/39 (35 gốc + 4 regression sau 2 vòng) · Gate cuối **PASS toàn bộ 56.6s — 722/722 test** (683→722, +39 đợt 4).
- Checklist C1-C8: C1 khớp spec §P2-M1+§P2-M2 từng mục (đọc đối chiếu R1; KHÔNG hằng số nào bị đổi — đúng nguyên tắc "chờ user duyệt") · C2 3750 phép độc lập + 2 lần chấm chéo (fuzz ULP ×5, fp miscount ×1) · C3 edge có probe/test (rỗng/1 mẫu/toàn dương/toàn âm/trùng/score 0-1/đối cực/NaN/±∞/missing CI/width đúng biên 0.5/n=5) · C4 gate 4 tầng PASS · C5 mỗi hàm ≥2 case + mỗi fix có regression · C6 JSDoc khớp hành vi sau mọi fix; 3 phát hiện đều P3 không tác động consumer dữ liệu → ghi biên bản là đủ (không cần entry Bug_v2 theo quy tắc) · C7 import route/workflow-engine/strategy-adapter/test không xung đột, additive tuyệt đối (getSuccessProbability nguyên vẹn, schema không đụng) · C8 git status chỉ file chủ đích, scratch ngoài repo (/home/z/fb-scratch), 0 console.log mới, 0 CJK.
- **KẾT LUẬN R3: 0 phát hiện mới → đạt cả 3 tiêu chí dừng → ĐỢT FB-ĐỢT4 KHÉP KẾT sau 3 vòng.**

**Nghiệm thu đợt FB-Đợt4:** 3 phát hiện (R1: 2 C·P3 — NaN guard + recommended-on-rounded; R2: 1 C·P3 — aucRoc=0 khi thiếu lớp) — tất cả đã fix + 4 regression test; 2 đợt sai-kỳ-vọng-người-rà ghi nhận (ULP comparator ×5 bộ + fp miscount ×1 — lần 7); gate PASS 722/722; live route sạch (2 target + 400); báo cáo duyệt ngưỡng làm tươi đúng dữ liệu thời điểm bàn giao (evaluator n=2, KB n=4 — mọi hằng số GIỮ NGUYÊN chờ dữ liệu). Không để lại việc hoãn nào trong scope (r77-threshold-updates.test.ts chỉ sinh SAU khi user duyệt đổi hằng số — đúng trình tự bước 5 §P2-M1, không phải nợ).

### ĐỢT FB-ĐỢT5 — scope: P3-M1 + P3-M2 + P3-M4 + P3-M3 đợt 5 (commits fca80fd + 6454a9e + 839d494: calibration-multifeature.ts + calibration.ts V2-first + runner/route wire + digest-gate-events.ts + context-compression gate + memory-summarization ROUGE gate + KPI thứ 10 + judges.ts runtimeJudgeVerdict + goal-loop 3-judge gate + 3 test r77 79 test + r76 cập nhật 10 KPI) — 2026-10-11

**Vòng R1 — rà soát (đọc spec §P3-M1/§P3-M2/§P3-M4/§P3-M3 + full diff 13 file/~2700 dòng + harness độc lập /home/z/fb-scratch/fb-dot5-r1-verify.ts 137 phép: logistic GD L2 viết lại độc lập theo định nghĩa MATH.pdf (khác cấu trúc vòng lặp) + fuzz 60 bộ ngẫu nhiên khớp 1e-9 + tính tay 2 điểm 1-2 epoch có/không L2 + computeColumnStats tay √(8/3) + stratified từng fold 2-2 + CV nguyên lý (quan hệ thật → V2 < 0.2×V1, noise → improved=false, fold Brier ∈[0,1], mean/CI đúng công thức) + buildFeatureVector/parse/apply từng thành phần tay + battery regex token dự án thật (WilsonCI/parseEvalVerdict/src-lib/722/0.75/Monday-loại) + gate 7/10=0.7 biên ≥ + rougeL tay + fuzz 50 bộ token + bảng thật mode 13 dòng + bảng thật critical 7 dòng + gate 3-judge 9 kịch bản inject + tiêu chí/timeout):**

Phát hiện (đã chấm chéo đủ 3 phía — code / kỳ vọng độc lập / phương pháp thứ ba):

| ID | Loại·mức | Phát hiện | Vị trí |
|---|---|---|---|
| FB-Đợt5-R1-01 | C·P4 | `extractEvidenceTokens` KHÔNG trích chuỗi hex dạng git hash (839d494, 6b0b7e9): "839d494" không match `\b\d{2,}\b` (không có \b giữa 839-d494 — 'd' là ký tự word), không match camel/Pascal/snake → commit hash — bằng chứng đối chiếu TRUNG TÂM của quy trình dự án (worklog/báo cáo/ArbiterVerdict trích dẫn liên tục) — rơi khỏi gate: digest LLM bỏ hết hash vẫn qua gate. Fix: pattern hex thuần `[0-9a-f]{7,40}` (độ dài git short-hash; từ tiếng Anh ≥7 chữ chỉ gồm a-f cực hiếm — worst case "defaced", hi sinh chấp nhận hướng bảo thủ) + regression test (839d494/6b0b7e9 trích, abc123 <7 không trích). | context-compression.ts extractEvidenceTokens |

Sai kì vọng phía người rà (ghi nhận, lần 8 — tái bản đúng bài học FB-P0/P1/Đợt3/Đợt4): 3/137 phép harness "FAIL" đầu đều là TAY người rà sai, KHÔNG phải code: (a) 2 phép tính tay logistic epoch-2 dùng σ(−0.05)=0.48750026 trong khi giá trị đúng 0.48750260 (e^0.05=1.05127110, 1/2.05127110 — nhầm một chữ số 0 ở vị trí thứ 6) → code cho 0.09875026/0.09625026 ĐÚNG, fuzz độc lập 60 bộ khớp 1e-9 xác nhận phương pháp; (b) 1 phép rougeL đếm ref "the cat sat on the mat" = 7 token trong khi là 6 → recall đúng 3/6=0.5, f1 đúng 2/3. Chỉ ra sai số bằng phương pháp thứ ba (fuzz độc lập + nhân chéo đối xứng p2=1−p1) TRƯỚC khi kết luận.

ĐẠT không phát hiện: fuzz 60/60 logistic khớp độc lập 1e-9 (lr/epochs/l2/batch ngẫu nhiên) · determinism khớp tuyệt đối · guard throw 3/3 dữ liệu xấu · chuẩn hóa: cột hằng std→1, cột null mean 0/std 1, null không kéo mean · stratified: mỗi fold 2 pos + 2 neg phân bố đều, lớp < folds → null, folds 1 → null · CV: quan hệ thật (LCG 42) cvBrier < 0.2·brierV1 + mọi fold ∈[0,1] + mean đúng + CI bao · noise (LCG 77) improved=false + cvBrier > 0.1 (không học được noise) · feature builder: log1p(0)=0, one-hot security [0,0,1], difficulty easy→0, thiếu → null đúng vị trí · applyV2Model: từng thành phần z tính tay khớp 1e-12, partial = σ(intercept) đúng impute-mean · parse rác/kích thước lệch → null · MIN_TRAIN_SAMPLES_V2=30 · token: camel/Pascal+acronym/dedupe-case-insensitive/cạo dấu câu 2 đầu/số-1-chữ-số-loại/cap-60 · gate: 7/10=0.7 pass biên ≥, 6/10 fail, found đếm đúng, evidence rỗng tự qua · rougeL precision/recall/f1 tay · mode 13 dòng bảng thật · critical 7 dòng bảng thật (0.8×4=3.2 biên cycle 4 đạt/cycle 3 không, ∞ chỉ trục tool) · gate 3-judge: 2/3 fail hạ + tag median=0.33, median đúng 0.5 KHÔNG hạ (ngặt <), throw → verdict nguyên vẹn + median null, alreadyFired/off/non-critical → 0 call, tag nguyên vẹn ≤400 khi gốc 390, confidence GIỮ 0.9 đúng chủ đích scorecard · 5 tiêu chí lõi · timeout 600s đúng directive kimi-k3.

**Fix R1 + xác minh:** pattern hex ≥7 + regression test (27 test r77-digest-gate). Harness kỳ vọng tay hiệu chỉnh bằng giá trị chính xác (kèm dẫn nguồn sai số): **137/137 PASS**.

**Vòng R2 — rà lại toàn bộ scope (kể cả các file vừa fix):**
- Phát hiện **FB-Đợt5-R2-01 · C·P4**: env gate đặt NHƯNG RỖNG (`DIGEST_EVIDENCE_COVERAGE_MIN=""` — `.env` có dòng `KEY=` không giá trị) → `Number('')=0` → `0>=0 && 0<=1` TRUE → ngưỡng thành 0 = GATE TẮT NGẦM không chủ đích (rollback chủ đích phải là đặt "0" tường minh). Fix: trim + rỗng coi như KHÔNG đặt → default (áp cả 2 gate DIGEST_EVIDENCE_COVERAGE_MIN + SUMMARY_ROUGE_RECALL_MIN; RUNTIME_JUDGES_TIMEOUT_MS vốn an toàn nhờ floor 5000 nhưng cùng quy ước đã có trim ở parseRuntimeJudgesMode).
- Phát hiện **FB-Đợt5-R2-02 · D·P4**: `withTimeout` judges.ts có try/catch CHẾT quanh `Promise.race(...)` (promise rejection không bao giờ vào được catch đồng bộ — cú pháp lừa người đọc rằng có bảo vệ) + trả promise không await. Fix: dọn về đúng pattern context-compression/goal-loop (await + finally clearTimeout) — hành vi không đổi.
- Đối xứng trên fix R1-01: pattern hex chỉ THÊM token (hướng bảo thủ — bắt buộc digest giữ), không đổi tập token cũ (fuzz 50 bộ + 8-token fixture + BIÊN 10-token rep_000 không hex → counts giữ nguyên tuyệt đối, 27/27 test cũ + 1 mới pass) ✓. Kiểm tra lan: regex hex không đụng path (có '/' không match), không đụng snake (có '_'), không trùng key lowercase với số thuần (722 hex? '722' dài 3 < 7 ✓).
- Rà nghịch lý luồng: gate 3-judge chạy SAU verify-guard → verdict hạ cấp lưu insertArbiterVerdict với forcedDowngrade=true + rootCause có tag (không đụng cột mới); heuristic verdict (evaluator LLM chết) cũng được 3-judge chấm khi mode all — chủ đích giám sát thêm, không hại; cancel giữa chừng 3-judge → verdict vẫn áp rồi vòng lặp trên break — chấp nhận (tối đa 1 verdict persist thêm).
- 0 phát hiện khác.

**Vòng R3 — xác nhận cuối:**
- Đọc lại full diff R1+R2 (4 file/39 dòng) bằng mắt tươi — mọi guard đúng vị trí, không đổi chữ kí công khai, hành vi mặc định (env không đặt) giữ nguyên tuyệt đối.
- Harness cuối: **137/137 PASS** · test r77 80/80 (79 + 1 regression R1-01) · Gate cuối **PASS toàn bộ 94.8s — 802/802 test** (722→802, +80 đợt 5) · tsc + lint + imports sạch.
- Checklist C1-C8: C1 khớp spec 4 mục từng dòng (P3-M1 bộ đặc trưng x1-x8 + L2 λ=0.01 + OR; P3-M2 5-fold stratified + cvBrier/ci/brierV1 + improved ngặt + active chỉ khi thắng; P3-M4 coverage 0.7 + ROUGE-L 0.3 + fallback đường sẵn có + log + KPI; P3-M3 3 slot nguyên bản + critical ∧(≥20 ∨ 0.8·max) + median<0.5 hạ + tag + forcedDowngrade tái dùng + ≤1/run + fail-open; timeout 30s→600s override THEO user directive 2026-12-01 — ghi rõ nguồn trong code) · C2 137 phép độc lập + fuzz 60 logistic 1e-9 + 1 lần chấm chéo (3 sai số tay lần 8) · C3 degenerate có probe/test (lệch lớp/thiếu mẫu/parse rác/judge throw/all-fail/median biên 0.5/tag cap 400/evidence rỗng ×2 nhánh/LLM hỏng hành vi cũ) · C4 gate 4 tầng PASS 802/802 · C5 80 test mới (33+26+20+1 regression) mỗi hàm ≥2 case + 2 fix đều có regression (hash hex + env rỗng ngầm định tính qua default giữ) · C6 JSDoc/comment khớp hành vi sau mọi fix (OR chiều faithful, union mẫu đại diện + dẫn số đo 0.27, timeout override nguồn directive, hex false-positive defaced); 3 phát hiện đều P4 → ghi biên bản là đủ (không cần entry Bug_v2) · C7 DB: 2 model mới push đúng DB thật (env -u DATABASE_URL sau 1 lần trượt scaffold vô hại), test chạy bảng cô lập preload, route POST không seed gì, harness 0 ghi DB · C8 import một chiều (calibration→multifeature static, chiều ngược dynamic; goal-loop→judges; compression/summarization→digest-gate-events→db), scratch ngoài repo, 0 console.log mới ngoài log chủ đích, 0 ký tự CJK sót (rà "开头" đã sửa).
- **KẾT LUẬN R3: 0 phát hiện mới → đạt cả 3 tiêu chí dừng → ĐỢT FB-ĐỢT5 KHÉP KẾT sau 3 vòng.**

**Nghiệm thu đợt FB-Đợt5:** 3 phát hiện (R1: 1 C·P4 — hex hash khỏi gate; R2: 2 P4 — env rỗng tắt gate ngầm + try/catch chết) — tất cả đã fix + regression; 1 đợt sai-kỳ-vọng-người-rà (3 phép tay — lần 8); harness 137/137; gate PASS 802/802; live: PM2 restart sạch, /api/health healthy, /api/eval/calibration GET modelV2 + POST v2 payload đúng, KPI 10 mục có digest_gate_fallback_rate, browser 0 lỗi. Không để lại việc hoãn nào trong scope (RUNTIME_JUDGES bật chờ user quyết sau khi xem số liệu — đúng điểm dừng quyết định; V2 active chờ n≥30 dữ liệu thật tự động đánh giá qua CV).
