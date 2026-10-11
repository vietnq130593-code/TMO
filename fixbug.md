# GIAO THỨC FIXBUG — VÒNG LẶP RÀ SOÁT → FIX/BỔ SUNG → RÀ LẠI, ĐẾN KHI SẠCH MỚI DỪNG

> **Phiên bản:** 1.1 — 2026-10-11 (tái cơ cấu vai trò file theo chỉ thị user: chi tiết phát hiện/fix chuyển TOÀN BỘ về `Bug_v2.md`; mục 6 đổi sang biên bản tóm tắt). Khởi tạo 1.0 — 2026-10-10 (task-83: user chỉ thị xây dựng giao thức + khởi động ngay đợt 1 trên P0-1 vừa triển khai)
> **Vị trí:** repo root, ngang hàng `bug.md` / `Bug_v2.md` — 3 file phối hợp: `bug.md` = sổ quan sát tại chỗ; `Bug_v2.md` = sổ bug chính thức (legend A-H · P0-P3 + P4 mở rộng) — **NƠI GHI CHI TIẾT MỌI PHÁT HIỆN + FIX của các đợt fixbug**; `fixbug.md` (file này) = nội dung giao thức vòng lặp rà-fix + biên bản TÓM TẮT các đợt đã chạy (vòng → số phát hiện → xác minh gate → kết luận, trỏ về entry Bug_v2).
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
| C6 | **Tài liệu** | JSDoc khớp hành vi THỰC (không nói một đằng trả một nẻo); **MỌI phát hiện ở mọi mức (P0→P4) có entry `Bug_v2.md` đầy đủ** (format Hiện tượng / Tác động / Fix + kiểm chứng + nguồn vòng rà); biên bản đợt (mục 6) chỉ tóm tắt + trỏ entry. |
| C7 | **Tích hợp** | Import smoke từ ≥ 2 nơi; barrel export đủ; không xung đột tên; thay đổi additive — không phá đường chạy nóng khi chưa có cờ bật. |
| C8 | **Vệ sinh** | Không file rác / scratch trong repo (chỉ /tmp); không console.log; không comment lừa dối; git status sạch trước khi kết luận. |

## 4. QUY TẮC GHI NHẬN

- Mỗi phát hiện gán ID: **FB{phần}-R{vòng}-{số}** (vd `FB-P0-R1-01`), kèm loại A-H + mức P0-P3 theo legend `Bug_v2.md` (P4 = mở rộng dưới P3, dùng từ đợt FB-ĐỢT5 — chú thích tại Bug_v2.md).
- **MỌI phát hiện ở mọi mức (P0→P4) → bắt buộc entry `Bug_v2.md` đầy đủ** (đánh số BUG2-0NN tiếp theo): hiện tượng, tác động consumer, fix (file:line đụng, cách fix), bằng chứng xác minh (giá trị trước/sau + gate), nguồn vòng rà. Biên bản đợt (mục 6 file này) chỉ ghi TÓM TẮT: vòng → số phát hiện (ID) → xác minh gate → kết luận, kèm trỏ entry Bug_v2. *(Quy tắc 1.0 cũ chỉ bắt P0/P1/P2-có-tác-động-consumer lên sổ, P3/P4 nằm trong biên bản chi tiết fixbug.md — bỏ theo chỉ thị user 2026-10-11; 18 phát hiện P3/P4 các đợt cũ đã bổ sung đủ BUG2-044..061.)*
- Mỗi fix ghi: file:line đụng, cách fix, bằng chứng xác minh (giá trị trước/sau + gate).
- **Sai kì vọng phía người rà** (phát hiện hóa ra do mình tính sai) cũng phải ghi nhận ngắn gọn — đó là dữ liệu chống tự tin sai cho các vòng sau (không tính vào "phát hiện mới" khi quyết định dừng).

## 5. RÀNG BUỘC AN TOÀN

1. **Tối đa 5 vòng/phần.** Vòng 5 vẫn còn phát hiện mới → DỪNG, BÁO USER (nghi ngờ spec mơ hồ hoặc vòng lặp fix-sinh-lỗi — cần phán quyết người, không được tự quay tiếp).
2. **Không tự tuyên bố sạch** nếu bỏ qua bất kỳ mục checklist nào — mỗi vòng phải để lại dấu vết: lệnh đã chạy, file đã đọc, giá trị đã tính (ghi trong worklog phiên tương ứng).
3. Fix vòng N phải qua **XÁC MINH đầy đủ** (gate PASS + test mới) TRƯỚC khi sang vòng N+1 — không tích luỹ nợ xác minh.
4. **NGHIÊM CẤM** fix điểm này gãy điểm khác rồi coi như xong: vòng sau luôn rà lại TOÀN BỘ scope, kể cả phần vừa fix và phần từng "đạt" từ vòng 1.
5. Auditor độc lập (subagent/người khác) khuyến khích ở vòng 1 (mắt không bị ám bởi người viết code), nhưng kết luận của auditor cũng chỉ là **nghi vấn** cho tới khi được chấm chéo (mục C2).
6. Không mở rộng scope giữa chừng (phát hiện ngoài scope → ghi vào "phát hiện ngoài phạm vi" bàn cho đợt sau, không fix trong đợt này).

## 6. BIÊN BẢN TÓM TẮT CÁC ĐỢT ĐÃ CHẠY

> **Tái cơ cấu theo chỉ thị user 2026-10-11:** mục này chỉ ghi TÓM TẮT mỗi đợt (vòng rà → số phát hiện → xác minh gate → kết luận + trỏ entry). CHI TIẾT từng phát hiện (hiện tượng / tác động / fix + kiểm chứng) nằm tại `Bug_v2.md` — 18 phát hiện P3/P4 các đợt cũ vốn chỉ nằm trong biên bản chi tiết (theo quy tắc 1.0) đã được bổ sung đủ BUG2-044..061. Biên bản chi tiết gốc vẫn truy cập được qua git history (commit e462473 về trước).

### ĐỢT FB-P0 — scope P0-1 (7 module `src/lib/stats/` + `tests/r76-stats-core.test.ts` + Bug_v2-035..038 + hạ tầng gate commit 9ae69bb/c74388c) — 2026-10-10 — KHÉP KẾT SAU 3 VÒNG

| Vòng | Phát hiện mới | Xác minh |
|---|---|---|
| R1 | **8** (1 C·P1 + 1 C·P2 + 5 C·P3 + 1 D·P3) — harness độc lập 101 phép (thuật toán thay thế hoàn toàn: erf Maclaurin / logGamma Stirling / CDF Simpson / Fisher BigInt / LCS ma trận đầy) + probe edge chạy thật | Fix toàn bộ + 7 test regression (r76 42→49) → gate PASS; 1 kỳ vọng test orchestrator sai bị gate bắt — sửa kỳ vọng |
| R2 | **1** (C·P3 — quét tính đối xứng tham số toàn bộ 30 hàm export) | Fix + test → gate PASS |
| R3 | **0** → đạt cả 3 tiêu chí dừng | Harness 16/16 + gate **644/644** (2620 expect) |

- Phát hiện: FB-P0-R1-01..08 + FB-P0-R2-01 → **BUG2-039, BUG2-040, BUG2-044..050** (tất cả đã fix + regression).
- Sai kì vọng phía người rà: 11 (lần ghi nhận đầu — nguồn gốc bài học "chấm chéo 3 phía" mục C2).
- Nghiệm thu: 9 phát hiện — 2 entry Bug_v2 tạo mới khi chạy (039, 040) + 7 bổ sung về sổ sau này (044..050); không việc hoãn nào trong scope.

### ĐỢT FB-P1 — scope P1-M1→M4 đợt 2 (commits 78a1e7d + 5ab5555 + 3758b01 + e6f2433) — 2026-10-10 — KHÉP KẾT SAU 3 VÒNG

| Vòng | Phát hiện mới | Xác minh |
|---|---|---|
| R1 | **6** (3 G·P2/P1/P1 + 2 C·P3 + 1 H·P3) — full diff 16 file/1680 dòng + 11 nhóm kiểm chứng độc lập + nghiệm thu live 4 endpoint | 5 fix ngay + 1 (BUG2-043 model matrix) chuyển điểm dừng quyết định user → gate PASS; dọn DB 156 row ToolMetric test + 13 MetricAnomaly artifact; baseline P1-M2 thật ghi nhận (avgNdcg@5 0.626 / avgMrr 0.667 / avgRecall@5 0.667, n=3) sau khi tháo nghẽn 410 |
| R2 | **0** (harness 11/11 chạy lại trên code đã fix + quét đối xứng tham số + live nghiệm thu) | — |
| R3 | **0** → KHÉP KẾT | Gate **671/671** (38 file) |

- Phát hiện: FB-P1-R1-01..06 → **BUG2-041, BUG2-042, BUG2-043, BUG2-051..053** (5 fix trong đợt; BUG2-043 đóng sau bằng user decision 2026-11-30 "model matrix mới").
- Sai kì vọng phía người rà: 1 (comparator altAP — lần 5).
- Nghiệm thu: không việc hoãn nào trong scope.

### ĐỢT FB-ĐỢT3 — scope P1-M5 đợt 3 (commit 7e1e656) + DIRECTED FIX kimi-k3 timeout (user directive 2026-12-01) — 2026-10-10 — KHÉP KẾT SAU 3 VÒNG

- **Directed fix trước vòng rà** (ngoài scope P1-M5, theo nguyên văn directive): `KIMI_K3_TIMEOUT_MS` 600s (env override, floor 60s) áp tập trung tại callModelWithKeyRotation + prober floor 300s — không giết call chậm-hợp-lệ của siêu model; comment cũ đóng khung sai "hay hang" viết lại theo directive.

| Vòng | Phát hiện mới | Xác minh |
|---|---|---|
| R1 | **2** (1 D·P3 + 1 C·P3 — đều doc-fidelity, toán đúng độc lập) — harness độc lập 332 phép (silhouette viết lại từ định nghĩa + fuzz 300 graph + toán tay 3-clique + DBI/CH tay + probe Neo4j Integer) | Fix toàn bộ + regression (r76 11→12) → gate PASS |
| R2 | **0** (rà đối xứng tie-break γ + timeout kimi-k3) | — |
| R3 | **0** → KHÉP KẾT | Gate **683/683** (2853 expect) |

- Phát hiện: FB-P1M5-R1-01/02 → **BUG2-054, BUG2-055**.
- Sai kì vọng phía người rà: 1 (CH grand-centroid — lần 6).
- Live sau khép: PM2 restart sạch, /api/health healthy, community-status lastQuality đầy đủ qua restart (silhouette 0.8681 / Q 0.8322 / DBI 3.28 / CH 7.79 / 348 stored), E2E kimi-k3 thật (job cmv2inzxf…).

### ĐỢT FB-ĐỢT4 — scope P2-M1 + P2-M2 đợt 4 (commits eeab02b + 53faf31 + 5e8ca42) — 2026-10-10 — KHÉP KẾT SAU 3 VÒNG

| Vòng | Phát hiện mới | Xác minh |
|---|---|---|
| R1 | **2** (2 C·P3) — harness độc lập 3750 phép (sweep cài đặt thay thế + AUC-ROC pairwise + AUC-PR nhóm-theo-recall + Wilson công thức độc lập + fuzz 300/200 + live route 2 target) | Fix toàn bộ + regression → gate PASS |
| R2 | **1** (C·P3 — aucRoc 0 khi thiếu lớp, bộc lộ trên live evaluator n=2) | Fix + 2 regression → gate PASS |
| R3 | **0** → KHÉP KẾT | Harness 3750/3750 + r77 39/39 + gate **722/722** (683→722, +39 đợt 4) |

- Phát hiện: FB-Đợt4-R1-01/02 + FB-Đợt4-R2-01 → **BUG2-056, BUG2-057, BUG2-058**.
- Sai kì vọng phía người rà: 2 đợt (ULP comparator ×5 bộ + fp miscount ×1 — lần 7).
- Live: route 2 target + invalid-target 400 sạch; báo cáo ngưỡng làm tươi đúng dữ liệu bàn giao (evaluator n=2, KB n=4 — mọi hằng số GIỮ NGUYÊN chờ user duyệt).

### ĐỢT FB-ĐỢT5 — scope P3-M1 + P3-M2 + P3-M4 + P3-M3 đợt 5 (commits fca80fd + 6454a9e + 839d494) — 2026-10-11 — KHÉP KẾT SAU 3 VÒNG

| Vòng | Phát hiện mới | Xác minh |
|---|---|---|
| R1 | **1** (C·P4 — hex git hash rơi khỏi evidence gate) — harness độc lập 137 phép (logistic GD L2 viết lại theo MATH.pdf + fuzz 60 bộ khớp 1e-9 + token battery dự án thật + gate 3-judge 9 kịch bản inject) | Fix + regression → harness 137/137 |
| R2 | **2** (P4 env rỗng tắt gate ngầm + D·P4 try/catch chết) + đối xứng fix R1 + rà nghịch lý luồng → 0 phát hiện khác | Fix → gate PASS |
| R3 | **0** → KHÉP KẾT | Harness 137/137 + r77 80/80 + gate **802/802** (722→802, +80 đợt 5) |

- Phát hiện: FB-Đợt5-R1-01 + FB-Đợt5-R2-01/02 → **BUG2-059, BUG2-060, BUG2-061**.
- Sai kì vọng phía người rà: 1 đợt (3 phép tay — lần 8).
- Live: PM2 restart sạch ×2, /api/health healthy, /api/eval/calibration modelV2 đúng hành vi, KPI 10 mục có digest_gate_fallback_rate, probe 3-judge kimi-k3 thật 767s → scores [0.6, 0.7, 0.6] median 0.6 ≥ 0.5 KHÔNG downgrade (đúng kỳ vọng), browser 0 lỗi.

### ĐỢT FB-ĐỢT6 — scope P4-M2 + P4-M1 đợt 6 (commits b454377 + 0348c8c: AgentRunRecord.model + metrics-db 3 hàm + goal-loop/subagent call-sites + model-comparison.ts + route /api/eval/model-comparison + adaptation-stats.ts + applyAdaptationToSession gate + workflow wiring + 2 test r77 38 test) — 2026-10-11 — KHÉP KẾT SAU 3 VÒNG

| Vòng | Phát hiện mới | Xác minh |
|---|---|---|
| R1 | **1** (D·P4 — comment nhánh defensive-NaN mô tả sai cơ nhân) — harness độc lập 169 phép (Φ A&S 26.2.17 rational / Fisher BigInt tổ hợp chính xác / Welch + F-density Simpson + Lanczos Γ / Wilson viết lại) + fuzz 30 bảng adaptation + 10 fuzz model-table + đối chiếu spec 3 kịch bản | Fix comment (A7 pin sẵn hành vi) → gate PASS |
| R2 | **1** (C·P3 — row SAL bị gate chặn vẫn đóng successful → ô nhiễm evidence các lần gate sau) + rà đối xứng + nghịch lý luồng | Fix statsJson.applied + evidence lọc applied=false + 2 regression test → gate PASS |
| R3 | **0** → KHÉP KẾT | Harness 169/169 + test 40/40 r77 + gate **842/842** (802→842, +40 đợt 6) |

- Phát hiện: FB-Đợt6-R1-01 + FB-Đợt6-R2-01 → **BUG2-062, BUG2-063**.
- Sai kì vọng phía người rà (lần 9): 3 bug chính harness (Φ nhân thừa t; BigInt chia cắt nguyên từng phép; Simpson tính CDF rồi so đuôi p) + 4 kì vọng test ban đầu (đếm rows, F>100 tay ra 90.05, tolerance 1e-15, seed hằng làm welch degenerate) — code đúng cả, chấm chéo bằng giá trị tay + phương pháp thứ ba TRƯỚC khi kết luận.
- Live: PM2 restart sạch; E2E run thật qua durable goal-loop (Omega/space-bunny-free) ghi model='space-bunny-free' ngay từ row running + giữ qua update cuối; route /api/eval/model-comparison 200 (nWithModel=1); probe gate trên production DB 0 tiền sử → insufficient fail-open đúng spec; ADAPTATION_STATS_GATE mặc định OFF (log-only); browser 0 lỗi page/console (Agents tab click OK).
- Điểm chờ user (đúng điểm dừng quyết định #3 blueprint): bật ADAPTATION_STATS_GATE=on sau 2 đợt quan sát log — KHÔNG tự ý bật.

### ĐỢT FB-ĐỢT7 — scope P5-M2 + P5-M4 + P5-M3 + P5-M1 đợt 7 (đợt code chưa tách commit — fix inline trong commit feat đợt) — 2026-10-10 — KHÉP KẾT SAU 3 VÒNG

| Vòng | Phát hiện mới | Xác minh |
|---|---|---|
| R1 | **2 phát hiện triển khai** (D·P3 scroll-pagination benchmark nhân đôi dữ liệu 50× + C·P3 double-cause test-infra P2022 — tách thành BUG2-066 WAL -shm + BUG2-067 env-leak khi điều tra) — harness độc lập 32 phép (sha256 chuẩn + near-dup 5 kịch bản + NB chấm tay ln(101) từng thành phần + Laplace hữu hạn + PCA ellipse moment độc lập + MRL ellipse recall độc lập 3 seed + biên between/lt/gt) | Fix toàn bộ → r78 25/25 → gate PASS |
| R2 | **1 (C·P2)** — rà 30 kịch bản luồng: embedding_success_rate FAIL giả đường skip-embeddings (0/n) → doc kẹt partial vĩnh viễn | Fix (chỉ đo khi bước embeddings chạy) → tsc + gate PASS |
| R3 | **1 (C·P2)** — checklist C1-C8: anh em R2-01 trên đường resume-partial (3/33 tử số sai nghĩa) — hoist realVectorCount + (real+saved)/total | Fix → gate **931/931** → KHÉP KẾT |

- Phát hiện: FB-Đợt7-R1 ×2 (triển khai: BUG2-066, BUG2-067 + BUG2-068 scroll) + R2-01 (BUG2-064) + R3-01 (BUG2-065).
- Sai kì vọng phía người rà (lần 11): 3 phép (bộ synthetic MRL đầu đặt tín hiệu cả 2048 chiều — ngược tính chất Matryoshka, 2 lần chỉnh tỉ lệ SNR; kì vọng spec "MRL thật ≥98%" bại trên dữ liệu thật 0.73-0.89 — ghi nhận là sai-kỳ-vọng PHÍA SPEC, test tách 2 lớp trung thực: cơ chế ≥98% synthetic + sàn 0.7 thật + báo cáo NO-GO chuyển đọc).
- Live: PM2 restart ×2 sạch; /api/health healthy; upload E2E cùng bytes lần 2 → **409 + existingDocumentId** đúng spec; near-dup E2E (PDF tái xuất khác byte cùng nội dung) → **status='duplicate' + duplicateOf trỏ bản gốc + getChunkCount=0 (không sinh chunk)**; reExtract doc thật chạy hết pipeline → **marker P5-M4 ghi processingSteps** (`entity_rate = 14.5 NGOÀI [0.2,6]` — cảnh báo chất lượng dữ liệu THẬT đầu tiên của lớp expectation) + KPI ingestion_expectation_fails live value=1 n=1; graph-explore trả map.xy PCA thật (16/54 node, variance [0.15,0.12]) + cache 1h xác nhận; collections-health hiện pilot entry (exists=false đúng — pilot OFF); ADAPTATION_STATS_GATE=on giữ qua restart; browser THE MAGNUM OPUS 0 lỗi console, doc list hiện badge "duplicate".

### ĐỢT FB-ĐỢT7-R4/R5 — MỞ LẠI theo chỉ thị user ("Kích hoạt giao thức Fixbug cho những gì triển khai trong đợt 7") — 2026-10-10 — KHÉP KẾT SAU 2 VÒNG BỔ SUNG

> R4 = audit độc lập toàn scope bằng 3 subagent song song (P5-M2+M4 / P5-M3+M1 / 5-fix-inline) + chấm chéo người điều phối trước khi nhận từng phát hiện; R5 = audit mắt tươi toàn diff R4 (fix có thể sinh lỗi mới). Nguyên tắc auditor độc lập (§5.5) áp dụng lần đầu ở quy mô đầy đủ. Toàn bộ phát hiện + fix ghi chi tiết tại Bug_v2.md BUG2-069..087.

| Vòng | Phát hiện mới | Xác minh |
|---|---|---|
| R4 | **20 đề xuất → 18 nhận sau chấm chéo** (0 P0-P2; 12 P3 + 6 P4; 2 nghi vấn auditor chuyển thành fix bổ sung có chủ đích: probe sanitize + embedOnly marker) — đỉnh: PCA kẹt trục phụ trên dữ liệu đối xứng hoán-trục (điều phối TỰ tái lập bằng script riêng: component1=trục phụ var 0.056 thay vì trội 0.944, KHÔNG null như comment cũ) + PCA chặn event-loop 4.4s (build C d×d) + zero_vector_rate chết cấu trúc (không bao giờ vi phạm) + chunks_per_page mù lần index đầu (snapshot stale) + 5 fix inline đợt 7 KHÔNG test regression nào pin (C5 5/5) | Fix toàn bộ 12 file + tách helper thuần + **32 test regression mới** (r78-fb7-regression) → gate **963/963** + tsc + lint PASS |
| R5 | **6 P4 hygiene + 1 P3 track-file** (auditor R5: 0 lỗi mới P0-P3 từ chính fix R4) — test rò /tmp 10 dir/lần chạy, comment stale collections-health, PC2-init ngữ nghĩa, embedOnly thiếu zero_vector_rate, overlay không clear stale, variance >1 epsilon (đo live 1.0000000000000027); điều phối phát hiện thêm matryoshka-benchmark.ts chưa từng được git track (/scripts/* ignore, không exception) → fix BUG2-068 không sống sót qua clone | Fix toàn bộ (clamp + dọn rác + .gitignore exception + git add) → gate **963/963** giữ + tsc + lint PASS → KHÉP KẾT (R5 hậu-fix phát hiện 0 mục mới)

- Phát hiện: BUG2-069..087 (19 entry, gộp logic theo tầng A1-A8 · B1-B6 · F2/F4 · embedOnly-marker · benchmark-untracked · lô hygiene R5). Fix đỉnh hiệu năng: PCA implicit products — đo trực tiếp 168×2048 cũ 1512ms vs mới 174ms = **8.7×**; live graph-explore hub 168-node×2048-dim 1.54s cả request.
- Sai kì vọng phía người rà (lần 12-13): 2 (kì vọng biên lt 0.01 viết NGƯỢC — spec là so sánh ngặt: 0.01 VI PHẠM; tính tay implicit-PCA quên số hạng cov khi giả sử trục chính) — cả hai tự bắt bằng test/harness TRƯỚC khi kết luận; auditor R5 tự bắt thêm 2 "FAIL" hóa ra là giới hạn tol dùng chung bản cũ (không phải lỗi mới). **Phát hiện bị bác sau chấm chéo: 0/20 — lần đầu tiên trong 7+ đợt FB toàn bộ phát hiện auditor đều đứng vững.**
- Live sau fix: PM2 restart sạch; health healthy; graph-explore PCA đường implicit sống (Bun 2-node var [1,0] đúng + hub MacKay 168-node pcaAvailable=true xy đủ 168 entry); collections-health pilot exists=false không đỏ đúng; docs list đường fresh phát duplicate_of; browser badge "trùng với …" + nhãn "Bản trùng" hiển thị (mobile 390px không tràn), 0 lỗi console/page.

### ĐỢT FB-P6 — scope P6-đợt8 RL-lite (commit b139706: 11 file +851 — q-table.ts MỚI, llm.ts softmax, goal-loop W2/PLAN-hint, workflow-engine W1, adaptation-engine contract, metrics-db detailed, route advice, 2 UI badge, schema QEntry, r79 27 test) — 2026-10-11 — KHÉP KẾT SAU 4 VÒNG

| Vòng | Phát hiện mới | Xác minh |
|---|---|---|
| R1 | **27** (3 auditor độc lập song song A/B/C: 12+9+6 — đỉnh: maxNextQ floor-0 lệch công thức spec · seed FNV tuần tự cấp-số-cộng phá spread chống-cascade · updateQ lost-update · recorded trên ledger chưa ghi) — chấm chéo điều phối: 26 nhận + C-03 ghi nhận không-fix (bất khả thi qua app) | Fix toàn bộ + 8 regression (r79 H1-H5) → gate 998/998 |
| R2 | **4** (mắt tươi toàn diff fix: **fix B-10 vòng R1 là PREDICATE CHẾT** — statsJson String? khiến typeof==='object' không bao giờ true, tái lập live throwaway DB → fix không tác dụng; C5: 7 fix không pin; JSDoc param 5; chuỗi không timeout) | Fix toàn bộ + 16 test (adaptation 4 + r79 H6 12) → gate 1006/1006 |
| R3 | **3** (kiểm chứng fix R2 + quét C1-C8: C-02 vẫn thiếu pin · timeout path im lặng trái JSDoc · barrel thiếu 2 export) | Fix + r80 (2 lần thiết kế test sai — mutate db-dùng-chung nhiễm lan r76/r77; defineProperty trên PrismaClient-là-Proxy có descriptor giả → cuối cùng DI client riêng + Proxy-wrap test-local) → gate **1007/1007** |
| R4 | **0** → KHÉP KẾT | Kiểm chứng 3 fix R3 đạt + quét trọn vẹn C1-C8 → 0 phát hiện mới |

- Phát hiện: **BUG2-088..121 (34 entry — 0 P0/P1 · 3 P2 · 7 P3 · 24 P4)** — mọi mức có entry đầy đủ.
- Sai-kỳ-vọng phía người rà (lần 14→16): **+20** (điều phối 2 · A 6 · B 2 · C 4 · R2 3 · R3 3 · R4 0) — đỉnh: kỳ vọng test H4 "0.5 > 0.5", kỳ vọng H3 quên chuỗi tuần tự đọc Q vừa ghi (giá trị đúng 0.956179 khớp số đo độc lập của auditor).
- Phát hiện bị bác sau chấm chéo: **0** — 2 chuỗi liên tiếp (đợt 7 R4/R5 + đợt 8/P6) toàn bộ phát hiện auditor đứng vững.
- Gate: **990 → 1007** (+17: r79 H1-H6 12 + adaptation 4 + r80 1); tsc + lint + imports PASS mọi vòng.
- Điểm nóng auditor B giải definitively: `result.model` callLLMForAgent = model THỰC sau softmax/failover trên mọi nhánh thành công (server-echo HTTP / actualModel CLI / failover chain) — credit assignment W2 ghi đúng người.
- Bài học hạ tầng test mới (ghi BUG2-119): bun-test 1 process dùng chung mock.module → không mutate db dùng chung; PrismaClient là Proxy với descriptor own-data GIẢ → pin bằng client riêng + Proxy-wrap; $transaction tương tác SQLite giữ lock nhiễm lan → tuần tự hoá in-process cho deployment 1-process.
- Live sau khép: xem biên bản commit (pm2 restart nạp code mới + gỡ RUNTIME_MODEL_POLICY=softmax về OFF đúng điểm dừng #5 — phát hiện drift trạng thái pm2 env của auditor R3, process cũ chạy code trước-fix với flag ON trái cam kết worklog đợt 8).

### TỔNG KẾT LŨY KẾ 8 ĐỢT + 1 MỞ LẠI (FB-P0 → FB-ĐỢT7 + FB-ĐỢT7-R4/R5 + FB-P6)

- **83 phát hiện** thu nhận qua giao thức (49 các đợt trước + 34 FB-P6: R1 3-auditor 27 → chấm chéo 26 nhận + 1 không-fix · R2 4 · R3 3 · R4 0) — 82 fix ngay + 1 (BUG2-043) chốt bằng user decision + 1 ghi-nhận-không-fix (BUG2-111 bất khả thi qua app); **100% có entry Bug_v2.md** (BUG2-039..121).
- Mọi đợt khép đúng nhịp (vòng hậu-fix luôn 0 phát hiện mới) — FB-P6 khép ở vòng R4 (4 vòng, dưới trần §5.1).
- **Sai-kỳ-vọng-phía-người-rà lũy ≈57** (35+2 các đợt trước · FB-P6 +20: điều phối 2 · auditor A 6 · B 2 · C 4 · R2 3 · R3 3 · R4 0) — chuỗi tái bản tới "lần 16", xác nhận giá trị quy tắc chấm chéo 3 phía (C2).
- Gate kiểm thử tăng đều: **644 → 671 → 683 → 722 → 802 → 842 → 931 → 963 → 1007** test (mỗi fix kèm regression — không nợ xác minh; FB-P6 lấp nốt C5 trên 7 fix vòng R1 từng trống pin nhờ vòng R2 bắt predicate chết sống sót chính vì thế).

### ĐỢT FB-P1 (NEURAL-ARCH) — scope 4 file P1 review task-98 (neural-layout.ts MỚI thuần + neural-architecture-section.tsx sửa [zoom toolbar + cỡ chữ + edge highlight + focus ring] + learning/index.ts barrel + tests/r82 MỚI) — 2026-10-11 — KHÉP KẾT SAU 2 VÒNG

| Vòng | Phát hiện mới | Xác minh |
|---|---|---|
| R1 | **5** (0 P0-P3 · 5 P4 — auditor độc lập subagent: harness 191 phép tự dựng + probe pixel browser + sampler bezier hằng số mới/cũ; 11 nghi vấn tự bác bằng phương pháp thứ ba) — đỉnh: nút "Thu nhỏ" từ fit PHÓNG TO (neo 1 thay vì tỉ lệ render thật) · 5 cạnh bezier đâm xuyên viewBox (pre-existing được P1 khuếch nhẹ) · 3 nhánh phòng thủ + biên clamp không pin | Fix toàn bộ 5 (BUG2-122..126) + 10 test regression r82 (nhóm 6: zoomStepFrom 4 + phòng thủ 4 + sampler bezier độc lập 2) → gate 1062 → **1072 PASS** |
| R2 | **0** (mắt tươi toàn scope kể cả fix R1: C1 spec khớp 100% · C2 sampler/zoom/layout literal 1732×568 · C3 degenerate đã pin đủ · C4-C7 gate PASS · C8 git status 4 file sạch) → KHÉP KẾT | LIVE browser: fit 1180px → Thu nhỏ → **1039px (0.6) thu nhỏ thật** (trước-fix 1558.8px phóng to); 100% = 1732px 1:1 (font nhỏ nhất 8.5px, title 12.5px); edge highlight 4 active/33 dim bám node chọn; focus ring dashed amber; persist localStorage qua reload; mobile lần đầu fit; 0 lỗi console/page |

- Phát hiện: FB-P1-R1-01..05 → **BUG2-122..126** (2 doc/hygiene D·P4+G·P4 · 3 C·P4 chức năng). Chi tiết tại Bug_v2.md.
- Sai-kỳ-vọng phía người-rà (lần 17): +2 (chính người viết test r82 bản đầu — margin HEADER_H tùy ý + kỳ vọng clamp ∞=MAX; code đúng cả 2, ghi rõ trong test).
- Phát hiện bị bác sau chấm chéo: 0/5 (chuỗi thứ 3 liên tiếp toàn bộ phát hiện đứng vững).
- Gate: **1041 → 1072** (+31: r82 21 gốc + 10 regression FB-P1-R1); tsc + lint + imports PASS mọi vòng.
- Ngoài phạm vi bàn đợt sau: svg role="img" mâu thuẫn node tương tác (ARIA) · SMIL reduced-motion (backlog P2/P3 task-98).
