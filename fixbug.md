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

### ĐỢT FB-P2 (NEURAL-ARCH) — scope P2 review task-98 (4 hạng mục: gate SMIL reduced-motion + TuningChangeLog audit + mobile bottom-sheet inspector + pause poll khi hidden; 7 file sửa + r83 MỚI) — 2026-10-11 — KHÉP KẾT SAU 2 VÒNG

| Vòng | Phát hiện mới | Xác minh |
|---|---|---|
| R1 | **7** (0 P0-P2 · 2 C·P3 + 1 D·P4 + 1 F·P4 + 2 E/D·P4 + 1 C·P4) + 1 nghi vấn N1 chưa tái lập — auditor độc lập subagent (mắt chưa từng xem code P2): throwaway DB script (capture-restart tái lập + prune-verify 12 phép + snapshot-race ×3) + đọc full 8 file + git show HEAD + chạy lại tsc/lint/r81-r83 độc lập | Fix 6/7 + N1 fix phòng thủ có chủ đích + BUG2-133 ghi-nhận-không-fix (trade-off SSR có chủ đích) + 4 regression test → gate 1085 → **1089 PASS** + tsc + lint sạch |
| R2 | **0** (điều phối rà mắt tươi toàn diff fix R1: derive-path vs resolveTuning · prune id-in bound · skip-condition 3 tam ca · sheet↔desktop chuyển viewport · effect cleanup · merge changeLog · C1-C8 quét trọn) → KHÉP KẾT | Live browser E2E + VLM xem biên bản commit |

- Phát hiện: FB-P2-R1-01..07 + N1 → **BUG2-127..134** (8 entry — chi tiết đầy đủ tại Bug_v2.md).
- Sai-kỳ-vọng phía người-rà: **0** (lần đầu sau 17 lần liên tiếp).
- Phát hiện bị bác sau chấm chéo: 0/7 — chuỗi thứ 4 liên tiếp toàn bộ phát hiện auditor đứng vững.
- Gate: **1072 → 1089** (+17: r83 13 gốc + 4 regression R1); tsc + lint + imports PASS mọi vòng.
- Ghi chú hạ tầng: `prisma migrate dev` đòi RESET DB (drift lịch sử migration từ trước P2 — 0_init chưa mark applied + mọi model post-round-32 vào bằng db push) → TỪ CHỐI reset, dùng `db push` thuần bổ sung (đúng thực hành thực tế repo) — vấn đề drift bàn riêng với user.
- Live sau khép: xem biên bản commit (bottom-sheet mobile chạm node + audit card + pause poll verify qua performance entries + reduced-motion gate qua emulateMedia).

### ĐỢT FB-P3 (NEURAL-ARCH) — scope P3 review task-98 (3 hạng mục chỉ thị user: drag-pan đồ thị "bấm giữ chuột di chuyển nội dung theo" + cỡ chữ +1px toàn ô/bảng module Database > Kiến trúc + ARIA role group; kèm HẠ TẦNG: rebaseline migration 0_init theo chỉ thị quay lại luồng migration chuẩn) — 2026-10-11 — KHÉP KẾT SAU 2 VÒNG

| Vòng | Phát hiện mới | Xác minh |
|---|---|---|
| R1 | **3** (0 P0-P2 · 1 C·P3 + 2 P4 — auditor độc lập subagent mắt tươi: đo font PIL/DejaVuSans proxy rộng-hơn-Geist + chạy lại r82 31/31 + tsc độc lập + truy vết thứ tự pointerup→click→setTimeout) — đỉnh: pan mất listener khi cửa sổ blur giữa lúc kéo → đồ thị bám theo chuột không bấm giữ · cursor-grab/legend/hint mời kéo cả khi vùng KHÔNG tràn · cursor grabbing chỉ trên container, sượt node nhảy pointer | Fix toàn bộ 3 (BUG2-135..137); điều phối tự bắt 1 sai-kỳ-vọng của chính mình (effect canPan trên layout TRƯỚC khai báo — TDZ, dời xuống sau useMemo) → gate 1089 giữ PASS + tsc + lint sạch |
| R2 | **0** (điều phối rà lại toàn diff fix R1: guard buttons===0/blur/teardown 3 lớp · deps + thứ tự effect canPan · biến thể className panning · 3 vị trí điều kiện canPan nhất quán) → KHÉP KẾT | Live browser agent-browser: drag pan scrollLeft 0→100 (node KHÔNG chọn nhầm) · click Neo4j node → inspector + live stats · font 1:1 pin (13.5/10/12.5/11px) · zoom 60% overflow 0 → cursor auto + legend ẩn + hint rút gọn · fit/100% có tràn → grab + legend + hint đủ · mobile 390px trang cuộn native (grid đơn cột giãn — hành vi P1/P2 giữ nguyên, pan trong vùng tắt đúng) · 0 lỗi console/page |

- Phát hiện: FB-P3-R1-01..03 → **BUG2-135..137** (chi tiết đầy đủ tại Bug_v2.md).
- Phát hiện bị bác sau chấm chéo: 0/3 — chuỗi thứ 5 liên tiếp phát hiện auditor đứng vững.
- Gate: **1089 → 1089 giữ** (P3 thuần UI/a11y — không logic thuần nào tách được ra module pin; xác minh bằng browser live thay test mới); tsc + lint PASS mọi vòng.
- HẠ TẦNG kèm đợt (ngoài phạm vi FB — chỉ thị user "quay lại luồng migration chuẩn"): 0_init REBASELINE (89 → 98 bảng — regenerate bằng `prisma migrate diff --from-empty --to-schema-datamodel` vì DB thật khớp schema 100% trong khi 0_init cũ stale) + `migrate resolve --applied 0_init` trên DB thật (app stop 10s tránh SQLite lock) → `migrate status`: "Database schema is up to date!" — KHÔNG mất dữ liệu (90 Document / 87 LocalEntity / learning history nguyên vẹn; Neo4J cloud dính gì đâu). `migrate deploy` trên DB trắng: sạch 98/98 — luồng chuẩn trọn vẹn cho máy local (git pull → `bun run db:deploy`). Đóng ghi chú drift từ FB-P2.

### ĐỢT FB-BRAIN-P1 — scope nền toán MLP BRAIN-P1 (commits d4adeaf: 5 file src/lib/brain/{activations,init,losses,optimizers,mlp}.ts + registry.ts chú thích + tests/r84 41 test; d990225: badge tổng nhãn neural-architecture-section.tsx) — 2026-10-12 — KHÉP KẾT SAU 4 VÒNG

| Vòng | Phát hiện mới | Xác minh |
|---|---|---|
| R1 | **13** (0 P0-P2 · 4 C·P3 + 9 P4) — auditor độc lập subagent mắt tươi (10 script /tmp: gradient-check độc lập 5553 phép Richardson + central-diff · closed-form 9 hàm × 10 điểm × 3 phương pháp · Adam/SGD đóng kín bitwise · variance 200k moment · forward tay 3-3-2 bitwise · determinism/early-stop · roundtrip · edge-probe toàn export · import-smoke 2 nơi) + điều phối chấm chéo script độc lập (khớp 12/13 tái lập; 1 phát hiện xác nhận nửa code-đọc + regression pin) → **NHẬN 13/13** | Toán nền ĐÚNG toàn bộ (phát hiện toàn bộ ở lớp hợp đồng API/validate/edge-input) → FIX toàn bộ 13 + **+27 test** (r84 41→68: nhóm 7 regression hợp đồng + nhóm 8 pin giá trị tay) → gate 1130 → **1157 PASS** + tsc + lint sạch |
| R2 | **2** (điều phối rà mắt tươi toàn diff fix — “fix sinh lỗi mới” đúng như protocol lo: R2-01 JSDoc holdOutRatio ghi "tự kẹp" trong khi guard mới NÉM + 2 dòng kẹp thành mã chết BUG2-151; R2-02 header r84 thiếu nhóm 7-8 BUG2-152) — kèm rà C1-C8 trọn: deserialize bỏ count-check thay 4-guard mọi nhánh reachable (tự tái cấu trúc trước R2); 5 guard fit không vô hiệu hoá đường hợp lệ; unicode regex test khớp code; component wiring computeLabelTotal; blueprint 3 chỗ khớp code | Fix cả 2 (hành vi không đổi — throw ngoài phạm vi pin sẵn 7b) → gate **1157 PASS** giữ + tsc + lint sạch |
| R3 | **1** (P4 — bắt trong live-verify R3: subtitle UI còn "BLUEPRINT v0.4" trong khi doc bump v0.5 chính đợt này — BUG2-153; phần rà code R2-diff: 0 — 2 dòng dọn mã chết + JSDoc + header comment hành-vi-trung-thực, biên throw/vẫn-chạy pin sẵn nhóm 7b) | Fix 1 chuỗi hiển thị → gate **1157 PASS** giữ + tsc + lint sạch |
| R4 | **0** (rà lại toàn bộ: fix R3 là 1 chuỗi hiển thị thuần không chạm logic — browser đọc lại đúng "v0.5" + badge "35 nhãn" + 0 lỗi console/page; C1-C8 quét trọn 11 file diff lần cuối) → KHÉP KẾT | LIVE: /api/health healthy (904ms sau restart); /api/brain 200 đủ 3 brain + signals đúng (4/20/1/10 → badge "35 nhãn" render đúng computeLabelTotal); tab Kiến trúc mở + đồ thị + panel 3 thẻ não + 0 lỗi console/page |

- Phát hiện: FB-BRAIN-P1-R1-01..13 + R2-01/02 + R3-01 → **BUG2-138..153** (16 entry — chi tiết đầy đủ tại Bug_v2.md): 4 P3 (predict không kiểm input-dimension rác im lặng · options NaN nuốt ∞ vào weights · deserialize kind-lạ/trùng lặp · activationParams không validate) + 9 P4 (JSDoc FitOptions · ký hiệu N(0,σ²) init header · blueprint step() ngược thứ tự · trần 250K chưa thực thi → BRAIN_MAX_PARAMS tại validateSpec · softmax placeholder σ giả dạng → ném hợp đồng · createOptimizer undefined → default throw · 11 nhóm export trống pin → +27 test · badge "0 nhãn" khi mọi nguồn null → ẩn · chính sách NaN loss → NaN lan) + 3 P4 vòng sau (2 do chính fix R1 sinh ra + 1 subtitle v0.4 stale bắt live).
- Nghi vấn auditor tự bác: **3** (fit(50)≠fit(25)×2 — ngỡ optimizer state rò, hóa ra fit restart toàn bộ là đúng JSDoc; "thiếu barrel vi phạm convention" — kiểm 17/28 module lib đều không barrel, bỏ; logistic XOR 0.5000 vs acc 0.75 "mâu thuẫn" — trần logistic kinh điển, giá trị thật 0.5000xyz).
- Sai-kỳ-vọng phía người-rà thêm (điều phối): **1** — probe l2Penalty truyền number[] thay vì Float64Array[] ra 0 (chính bằng chứng R1-11 API dễ dùng sai; không phải bug code).
- Phát hiện R2 do CHÍNH fix R1 sinh ra: 2 (BUG2-151 JSDoc mâu thuẫn + mã chết — đúng lớp lỗi R1-05 đang fix; BUG2-152 header test stale) — minh chứng vòng hậu-fix bắt buộc.
- Phát hiện bị bác sau chấm chéo: **0/13 — chuỗi thứ 6 liên tiếp toàn bộ phát hiện auditor đứng vững.**
- Hạ tầng hiệu đính: logic badge tách thành hàm thuần `registry.computeLabelTotal` (client/server dùng chung, pin được); deserialize bỏ count-check thay 4-guard (mọi đường sai đều chạm 1 guard — không còn mã chết).
- Blueprint đồng bộ v0.4 → v0.5 (nhật ký hiệu đính 3 mục doc + §9.1-3 điểm thực thi + §9.2 nuance mọi-null).
- Gate: **1130 → 1157** (+27, giữ nguyên qua R2/R3); tsc + lint + imports PASS mọi vòng.
- Ngoài phạm vi bàn đợt sau: /api/brain route + registry.ts phần BrainSpec cũ + panel Não vận hành phần trước badge (đợt 673d305 chưa từng chạy fixbug).

### ĐỢT FB-BRAIN-P2 — scope BRAIN-P2 Brain-A Calibration V3 (commit a97cd3f — 13 file: calibration-v3.ts 525 dòng + chuỗi calibration.ts + cờ tuning + registry + API train + UI nút train + auto-train runner + r85 28 test + r81 pin + blueprint v0.6) — 2026-10-12 — KHÉP KẾT SAU 4 VÒNG

| Vòng | Phát hiện mới | Xác minh |
|---|---|---|
| R1 | **8** (0 P0-P2 · 1 C·P3 + 7 P4) — auditor độc lập subagent mắt tươi (9 script /tmp: indep-cv 5 dataset × 54 phép clone-khớp-bit · hand-brier σ(w·x+b) tính tay \|Δ\|=0 · noise-scan 12 seed · determinism bit-đối-bit · db-probe 24 test DB-cô-lập · lineage-quirk · edge-cases 34 probe · import-smoke 2 nơi · live read-only 3 endpoint) + điều phối chấm chéo script độc lập khác (crosscheck.ts 6/6 + cc-db DB-cô-lập: generator xorshift32 khác auditor) → tái lập **8/8** → NHẬN 8/8 | Toán + orchestration ĐÚNG toàn bộ (CV V3 khớp bit-đối-bit crossValidateMultifeature độc lập; V2 khớp logistic tính tay 1e-9; XOR ≈ base-rate phương pháp 3; A1/A2/cờ/chuỗi fail-open đúng spec) — phát hiện toàn bộ ở lớp hợp đồng edge/validate/test-claim/doc → FIX toàn bộ + **+7 test regression** (r85 28→35 nhóm G) → gate 1185 → **1192 PASS** + tsc + lint sạch |
| R2 | **3** (điều phối rà mắt tươi toàn diff fix — "fix sinh lỗi mới" đúng như protocol lo: R2-01 subtitle UI còn "v0.6" khi doc bump v0.7 — tái phạm lớp BUG2-153; R2-02 r85 C-D FLAKY full-gate — 150 row seed cùng millisecond → orderBy createdAt desc TIE không đảm bảo thứ tự → CV noise lật thắng/thua giữa các lần chạy, chặn gate 3/4 lần; R2-03 G2 regression 2000 mẫu timeout 5s full-gate — test tự viết làm gãy gate) | Fix cả 3 (subtitle 1 chuỗi + createdAt phân tán mỗi row 1s cho tie-break duy nhất + G2 thu 200 mẫu Δ=6e-5 giữ discrimination std≈4.2e-6) → full gate **1192/1192 PASS 2 LẦN LIÊN TIẾP** + tsc + lint sạch |
| R3 | **0** phát hiện code (rà R2-diff lần cuối: node:crypto chỉ server — 5 file import đều server-side, client component không đụng; caseId/runId schema non-null; stds.slice() không alias; throw mới nằm trong try/catch của mọi caller) | LIVE browser (agent-browser): tab Kiến trúc — panel Não vận hành **v0.7** + badge "35 nhãn" + "● sống" + 3 thẻ; nút Huấn luyện đúng trạng thái ngủ 4/30; ĐƯỜNG VÀNG: node Goal Loop → inspector "Tinh chỉnh vận hành (1)" → on → AlertDialog warning đúng → Áp dụng → badge **CALIBRATION_V3=on màu emerald** + DB TuningParam store on → Reset → badge off + DB cờ về 0 — production sạch (BrainModel 0 · EvalResult 4 nguyên vẹn); mobile 390px scrollW=clientW không tràn; 0 lỗi console/page; dev.log sạch (chỉ API 200) |
| R4 | **0** (rà toàn bộ scope lần cuối: fix R3 là 1 chuỗi hiển thị thuần — browser đọc đúng "v0.7"; C1-C8 quét trọn 4 file diff + 11 file scope) → KHÉP KẾT | LIVE: /api/health healthy sau restart; /api/brain 200 đúng 3 brain (calibration_v3 dormant trainable, surrogate/policy chờ P3/P4) + trainingImplementation=true; gate 1192/1192 |

- Phát hiện: FB-BRAIN-P2-R1-01..08 + R2-01/02/03 → **BUG2-154..164** (11 entry — chi tiết đầy đủ tại Bug_v2.md): 1 P3 vòng R1 (stds=0 round5 → NaN runtime — guard 2 tầng full-precision + loadActiveV3) + 7 P4 R1 (noise-claim test · length-mismatch throw · folds nguyên ≥2 · applyV3Model NaN-clamp · dataLineage evalRunIds+EvalCase-đúng · 2 comment sai · POST telemetry số thật) + 3 vòng R2 (subtitle stale tái phạm BUG2-153 · flaky tie-break createdAt C·P3 chặn gate · G2 timeout).
- Nghi vấn auditor tự bác: **5** (noise-bất biến — đo 12 seed hóa ra 42% thắng, chính là gốc R1-02; "stds=0 NaN mọi nhánh" — chỉ NaN khi feature==mean đúng, ±Inf khác mean cho giá trị méo hữu hạn; prune A2 "fail" — lỗi test của chính auditor tạo trùng version bị @@unique chặn, constraint A1 hoạt động đúng; "generator r85 rò nhãn" — answered coin-flip độc lập xác nhận bằng generator khác hẳn; "V3 runtime thiệt thiếu features" — V2 cùng chuỗi chịu cùng giới hạn từ P3-M1, đúng thiết kế).
- Sai-kỳ-vọng phía điều phối trong lúc chấm chéo: 1 (MultiEdit old_str whitespace "·weightsJson" không nguyên văn — sai số công cụ, không phải phát hiện).
- Phát hiện bị bác sau chấm chéo: **0/8 — chuỗi thứ 7 liên tiếp toàn bộ phát hiện auditor đứng vững.**
- Đỉnh phát hiện: R1-01 là lỗi P3 duy nhất chạm doctrine fail-open — KHÔNG sai công thức nào, nằm ở lớp "lưu tròn 5 chữ số làm mất std near-constant + guard finite không chặn 0 (0 là finite)" — minh chứng protocol C2 "chấm chéo 3 phía": auditor đo std=2.83e-6, điều phối độc lập đo lại 2.828e-6 + DB-cô-lập NaN, test pin G1/G2 khép vòng.
- Gate: **1185 → 1192** (+7 regression, giữ PASS 2 lần liên tiếp sau khi dập flaky R2-02); tsc + lint + imports PASS mọi vòng.
- Ngoài phạm vi bàn đợt sau: V2 `parseV2ModelJson` + trainCalibrationModelV2 chia sẻ cùng lỗ hổng storage-round5-stds (đợt P3-M2 chưa từng fixbug — bàn khi rà scope calibration V2) · node goal-loop NEURAL_NODES paramKeys chứa 'q_advice_min_visits' dù spec đó gắn nodeId 'q-advice' (hiển thị aria đếm theo nodeId nên không sai — chỉ dữ liệu tĩnh hơi lệch, tiền BRAIN-P2) · crossValidateMultifeature/stratifiedFoldAssignments V2 cùng lớp folds-degenerate (kế thừa — bàn đợt rà V2).
- DB production sau live-verify: sạch (TuningParam calibration_v3 về mặc định 0 row · BrainModel 0 · EvalResult 4 nguyên vẹn).

### ĐỢT FB-BRAIN-P3 — scope BRAIN-P3 Brain-B surrogate (commit 9a91ebc: src/lib/brain/brains/surrogate.ts + replay route + auto-train hook agent-goal-loop.ts + cờ replay_eval + r86 45 test) + 5 gate-blocker kế thừa (claim "1237/1237 PASS" của P3 không tái lập trên fresh clone) — 2026-10-12 — KHÉP KẾT SAU 3 VÒNG

| Vòng | Phát hiện mới | Xác minh |
|---|---|---|
| R1 | **8** (điều phối root-cause 3 trước đợt audit: 5 gate-fail — r83 α không reset làm r79 đọc α=0.4 [bun test = 1 process mọi file, thứ tự tùy ý — xác nhận live] + r81 stats-gate phụ thuộc .env máy + r79 asserting công thức mà nguồn α runtime bị nhiễm; auditor 8-a độc lập [glm-5.3]: xác nhận live "1 process" + verdict 3 fix SẠCH nhưng bắt thêm mìn γ r83:208 + per-head fail-open claim SAI [1 đầu NaN throw → mất cả 3 đầu + đường weights không-finite vượt guard] + doc impute sai cơ chế + HM-CI thiếu biên degenerate) — chấm chéo độc lập: toán KHỚP TOÀN BỘ (CV stats ≤1e-9, HM 28/28 ≤1e-12, bootstrap tất định, anti-rò-nhãn tuyệt đối, replay READ-ONLY thật) | Fix toàn bộ 8 + regression: r83 reset α+γ · r79 pin α/γ file-level · r81 stats-gate tự set env + afterAll describe WIRING · applySurrogateHead per-head NaN→null (model-level throw giữ) + guard allWeightsFinite cửa nạp CẢ 2 brain [phát hiện thêm khi tái lập probe: JSON không lưu NaN → null-weight → Float64Array null→0 = weight-0 âm thầm — tệ hơn NaN] + doc impute/HM-CI + comment preload "1 process" → gate PASS |
| R2 | **1** (điều phối quét hệ thống cả LỚP lỗi set-không-reset bằng script trên toàn tests/*.test.ts → r81 WIRING describe leak α/γ sau test cuối — beforeEach không chạy sau test cuối; 6 cảnh báo còn lại thủ công bác: set-rejected không ghi store ×2, r85 calibration_v3 tự dọn bởi D6, ε reset bởi test kế, r83 đã fix R1) | Fix r81 afterAll + script quét sạch → full gate PASS 2 LẦN LIÊN TIẾP (1289/1291 → 1291/1291, 20084 expect) + tsc + lint + imports PASS |
| R3 | **0** phát hiện code (rà diff lần cuối: fix R2 là 1 afterAll thuần; C1-C8 quét trọn scope) | LIVE browser (agent-browser): panel Não vận hành **v0.9** + 3 thẻ não (V3/Vọng/Lệnh) + 3 brain NGỦ đúng thiết kế (0 mẫu fresh DB) + badge "0 nhãn" (đếm được = 0 — đúng ngữ nghĩa, không phải mọi-null) + GET /api/brain 200 đủ 3 brain trainable + GET /api/brain/policy 200 flag off/organ off/reward log-only/sweep infeasible-trung-thực + 0 lỗi console/page + dev.log sạch |

- Phát hiện: FB-BRAIN-P3-R1-05..R1-11 + R2-01 → **BUG2-165, 169, 170, 171, 172, 173, 182, 183, 184** (chi tiết đầy đủ tại Bug_v2.md). Đỉnh: BUG2-173 per-head fail-open — auditor bắt được claim-sai; điều phối tái lập probe phát hiện lớp SAI THẬT TỆ HƠN (null-weight âm thầm thay NaN-throw) — minh chứng "chấm chéo 3 phía".
- Nghi vấn auditor tự bác: **5** (đỉnh: probe đọc γ=0.9 tưởng leftover — hóa ra file probe chạy TRƯỚC r83 vì thứ tự tùy ý; marker có kiểm soát mới chứng minh được).
- Sai-kỳ-vọng phía điều phối: **1** (python script chỉnh comment preload ghi nhầm biến p/p3 — viết nội dung surrogate.ts đè preload.ts; phát hiện ngay qua tsc + git checkout phục hồi + áp lại comment đúng — không lọt gate).
- Ngoài phạm vi bàn đợt sau: BUG2-177 (semantics cột AgentRunRecord.model cấu-hình vs dominantModel — P6-M1 pre-existing, production 0 run).
- Gate: **1289 → 1291** (+2 regression: r86 D-regression 2 phần + r87 D9 thuộc đợt P4 cùng chạy); tsc + lint + imports PASS mọi vòng; **PASS 2 lần liên tiếp**.

### ĐỢT FB-BRAIN-P4 — scope BRAIN-P4 Brain-C policy + composite reward (src/lib/brain/brains/policy.ts + src/lib/brain/reward.ts + GET /api/brain/policy + train branch policy + organ-1 llm.ts + organ-2 workflow-engine.ts + hooks agent-goal-loop.ts + 4 cờ TUNING_SPECS + registry + r87 52 test + blueprint v0.9) — 2026-10-12 — KHÉP KẾT SAU 3 VÒNG

| Vòng | Phát hiện mới | Xác minh |
|---|---|---|
| R1 | **12** (auditor 8-b độc lập [glm-5.3] — 1 A·P3 + 3 C·P3 + 8 P4: đỉnh R1-01 nhãn Outcome* 2 nguồn lệch nhau trong 1 lần train [stratification/p̂ dùng complete thô, reward dùng Outcome*] — DB probe 2 lần ổn định; R1-08 [đánh số của P4-auditor] thư mục rác E:\APP\TMO-clone; R1-02 JSDoc λ sai công thức; R1-03 delegated=false hardcoded 2 wiring; R1-04 report tự mâu thuẫn Outcome*; R1-05 blueprint §4.4 thân chưa hiệu đính; R1-06 header đếm sai 2 lớp stale; R1-07 semantics cột model [ngoài scope — ghi nhận]; R1-09 typo ×2; R1-10 dead computation sweep; R1-11 envFallback thừa; R1-12 JSDoc ±∞) — chấm chéo độc lập: **toán lõi ĐÚNG toàn bộ** (λ 117 combo, composite 67/69 probe — 2 fail là sai kỳ vọng auditor tự bác, CV tự dựng khớp chặn dưới, spearman tay, đại số applyPolicyMixture 8 trường hợp) + gate 1289/1289 ổn định 3 lần | Fix 11/12 (R1-07 ghi nhận BUG2-177 bàn sau) + regression r87 D9 (verdict refuted gắn session run → successRate theo Outcome* derivable) → gate PASS |
| R2 | **0** (điều phối rà toàn diff fix R1 + quét lớp set-không-reset hệ thống — kết quả thuộc đợt P3 [r81 WIRING, BUG2-182]; diff P4 sạch không sinh lỗi mới) | Full gate PASS 2 lần liên tiếp (1291/1291) + tsc + lint + imports |
| R3 | **0** (rà toàn scope lần cuối — fix P3/P4 không giao thoa sai) | LIVE: như đợt P3 (chung session) + GET /api/brain/policy đầu đủ — flag off/organ off/active null (não ngủ đúng Q1+§2)/reward log-only đợt quan sát 1/sweep infeasible trung thực (0 run)/proposals [] (organ off) |

- Phát hiện: FB-BRAIN-P4-R1-01..R1-12 → **BUG2-166, 167, 168, 172, 174, 175, 176, 177, 178, 179, 180, 181** (chi tiết tại Bug_v2.md).
- Nghi vấn auditor tự bác: **4** (λ≥0.99 n≤3 quá ngặt · replicateCount(∞) kỳ vọng kẹp thay vì 0 · duplicate-candidates double-count [tự bác bằng đại số: knownMass double-count bù trừ] · sweep ρ=±1 "yếu" [tie-first rule được doc]).
- Gate: r87 52→53 test (+D9 regression); **1291/1291 PASS 2 lần liên tiếp**; build thử OOM trên box 4GB (dev server + qdrant chiếm RAM — ngay cả khi stop app; đúng tình huống .quality-gate.local skipBuild dự phòng: "máy yếu / đang chạy dev" — CI GitHub Actions chạy build trên runner đủ RAM).
- LIVE verify UI: panel "Não vận hành" subtitle **v0.9** đúng (không tái phạm BUG2-153/162) + 3 thẻ não + badge + flag RUNTIME_POLICY hiển thị + 0 lỗi console/page.

### ĐỢT FB-BRAIN-UX — scope BRAIN-UX UX-1→UX-5 (working tree chưa commit, base 4a90c75: 17 file sửa + 14 file mới — spec-schema.ts + stage-geometry.ts + brain-studio.tsx + brain-stage.tsx + training-console.tsx + hitech-toggle.tsx + 2 route mới spec-draft/weights + migration BrainSpecDraft (model thứ 100) + registry/mlp/reward/surrogate/policy/calibration-v3/brain route/train route/neural-types/globals.css/page.tsx/neural-architecture-section + 4 test mới r88-r91 (79 test) + pin update r87/r86/r81 + blueprint v0.10) — 2026-10-12 — KHÉP KẾT SAU 3 VÒNG (R3 mini)

| Vòng | Phát hiện mới | Xác minh |
|---|---|---|
| R1 | **11** (0 P0-P2 · 1 C·P3 + 10 P4) — auditor độc lập mắt tươi 13-a: probe thuần NGOÀI repo 283 phép (viết lại từ đầu, không import repo — WCAG/lossWeights/downsample/bezier/LOD/edgePhase/strokeWidthForGrad/counter) + edge probe DB cô lập 24 test (tạo-chạy-xóa) + probe inspector (MLP serialize thật) + probe counter policy + C1-C8 trọn + 3 lần full suite ổn định — toán nền 283/283 khớp (sau 16 sai số auditor tự bác) | Fix 11/11 (13-b — 8 file nguồn + pin update r90-H4 ((0,[0,0]) 1.95→1.1 + assert mới flat ≈1.95) + r90-D2 comment radius 7→12) → tsc/eslint/imports sạch + full suite **1370/1370** (test count không đổi — thay nội dung 1 test r90-H4, không thêm/bớt) + live verify UI read-only (panel 3 vùng · mobile 390×844 mọi nút chạm 44px · selector ` · in:` · 0 lỗi console/page) |
| R2 | **2** (2 P4 — đếm phát hiện từ 13-c: R2-01 diff draftParams khi inputDim chưa biết (residual của fix R1-05); R2-02 vỏ rác E:\APP rm 13-b vô hiệu + git tàng hình thư mục rỗng → R1-11 FAIL) + 1 phát hiện ngoài scope từ 13-b (weights route lồng sai shape policy) | VIỆC 1 fix weights route + probe DB cô lập + REVERT-TEST (cũ FAIL / mới 3/3 PASS); verify 11/12 (R1-01 probe độc lập CURRENT==TRUTH 25/25 · R1-02 32167===paramCount TRÙNG TUYỆT ĐỐI · R1-03..R1-10 code/probe/grep · R1-11 FAIL → R2-02); regression 2 LẦN liên tiếp 1370/1370 + tsc + eslint sạch |
| R3 mini | **0** (quét nhanh phạm vi 2 điểm sửa: đọc lại hunk brain-studio.tsx (file untracked — đọc hiện trạng + grep caller `diffDraftAgainst` duy nhất) + filesystem rm — không regress) | Fix 2/2 (R2-01: chỉ truyền params khi `validation.ok && validation.params.includesInput`; R2-02: rm từ đúng cwd + verify find/ls KHÔNG tin git) → tsc sạch + eslint brain-studio sạch + r88 29/29 + check:imports PASS + full suite **1370/1370** (64 file, 20810 expect) + find E:* rỗng → KHÉP KẾT |

- Phát hiện: FB-BRAIN-UX-R1-01..11 + R2-01/02 + 1 ngoài scope (weights route — 13-b phát hiện khi fix R1-02/R1-05, không cấp ID vòng R1; 13-c fix) → **BUG2-185..199** (15 entry — chi tiết đầy đủ tại Bug_v2.md): 1 C·P3 (neuron inspector off-by-one một cột — hiển thị dữ liệu nơ-ron cột kế) + 14 P4 (counter thiếu ×\|A\| policy · train nháp DIRTY dùng bản cũ · dropdown thiếu sigmoid/linear · diff hàng Tham số + inputMode (+residual R2-01) · touch < 44px mobile · strokeWidthForGrad doc-vs-hành-vi · 3 dead exports · 3 doc nhỏ · appliesTo HiTechProvider không tồn tại · vỏ rác E:\APP 2 vòng rm · weights route shape policy · nợ contrast BUG2-199 ghi nhận).
- Nghi vấn auditor tự bác: **16** (13-a — đỉnh: đầu đọc inspector "vào=ra thật" hóa ra toàn bộ triple của nơ-ron cột kế; xem worklog 13-a).
- Gate cuối: tsc + eslint + check:imports PASS + full suite **1370/1370** / 64 file / **20810 expect** lần cuối (dải dao động pre-existing 20805-20821; test count không đổi toàn đợt).
- LIVE verify UI (13-b, read-only — không bật cờ tuning): panel "Não vận hành" đủ 3 vùng (Studio · Sân khấu · Console) + subtitle v0.10 + stage planned 72 cạnh/17 nơ-ron + console dormant đúng + mobile mọi nút 44px + DB app sạch (verify không ghi gì); dropdown 8 hàm + inspector phủ bằng code review + pin r88-A3 (cờ off không live-verifiable được — ghi nhận trung thực).
- Ngoài phạm vi bàn đợt sau: nợ contrast tiền tồn tại stone-600 2.64:1 / stone-500 4.20:1 (BUG2-199 — nâng palette caption khi nền sâu bật) · wallpaper che nền sâu một phần (Task 11 ghi nhận) · r91 thiếu "no-regression snapshot các trang chính" §9.8 — thay bằng live-verify 13-b · các ghi nhận nhỏ không cấp ID của 13-a (surrogate inputDim ước từ agentId exact=false · lossWeights trainMeta chưa có consumer · policy planned fallback hardcode 3 nơ-ron đại diện · §9.8 từ ngữ stale "rAF").
- Ghi chú quy trình: đợt chạy trên working tree CHƯA COMMIT (17 M + 14 ??) — commit sau khi khép; base 4a90c75. R1-11 là finding tái phạm BUG2-172 (lớp "verify bằng git" — giải quyết bằng bài học verify filesystem bằng find/ls: BUG2-197).

### ĐỢT FB-BRAIN-LIVE — scope phase BRAIN-LIVE (working tree chưa commit trên base 52d97f3: tab BRAIN Smolab + não hiển thị thật + activity API READ-ONLY + zoom/pan + TuningParamDialog — 10 file M + 5 file ?? của 15-a→15-f; audit R1 = 16-a mắt tươi độc lập, fix = 16-b, verify R2 = 16-c) — 2026-10-12 — KHÉP KẾT SAU 2 VÒNG (R1 audit+fix · R2 verify khép)

| Vòng | Phát hiện mới | Xác minh |
|---|---|---|
| R1 | **9** (0 P0-P2 · 3 C·P3 + 1 G·P3 + 1 F·P3 + 4 P4) — auditor độc lập 16-a mắt tươi (probe thuần + DB cô lập 18 test/356 expect tạo-chạy-xóa + live agent-browser tái lập zoom/pan/wheel từng chữ số + elementFromPoint tái lập handle che tab): R1-01 trộn tín hiệu 2 head surrogate (poll cố định 'success' ≠ head chọn) · R1-02 pan không clamp biên · R1-03 resize handle Smolab che tâm nút tab BRAIN (pre-existing) · R1-04 dormant vocab findMany take-5000 ×2 mỗi poll 2.5s · R1-05 biến scaleV chết · R1-06 import bezierTangentDeg chết · R1-07 r92 READ-ONLY pin thiếu bảng EvalCase (route có evalCase.findUnique) · R1-08 stripComments không string-aware (tiên lượng) · R1-09 doc số dòng lệch 1 | Fix 9/9 (16-b): BrainStage expose initialHead/onHeadChange → brain-tab activityHead (poll theo head chọn) · clamp pan [base−0.9w, base+w−0.1w] (chấm chéo: biên trên đề bài base.x+base.w cho giao 0% — lấy công thức đối xứng đúng ý "≥10%") · bỏ -bottom-2 hit-area top handle (chấm chéo: mô tả "thu ngang left-3 right-3" không khớp code — hit-area ĐÃ bị chặn ngang bởi handle, xung đột thuần dọc) · vocab dormant TTL cache 60s (quyết định TTL thay DISTINCT — giữ nguyên đường query pipeline-cap-5000, DISTINCT sai parity khi >5000 usable) · xóa scaleV + import chết · pin EvalCase (expect count không đổi — bảng 5 trong cùng assert toEqual) · stripComments string-aware (máy trạng thái nhỏ) · hiệu đính wc -l blueprint → tsc exit 0 · eslint 5 file đụng + toàn repo exit 0 · r92+r89+r90 68/68 (574 expect) · full suite **1400/1400 ×2 liên tiếp** (21082+21098 expect — trong dải pre-existing) · check:imports PASS · live verify (a) Brain-A 27 nơ-ron + zoom/pan/clamp từng giá trị khớp tính tay + ⤢ fit (b) bấm head 'tokens' → GET /api/brain/activity?brain=surrogate&head=tokens trong network (weights mock qua network route — DB app 0 BrainModel, không đụng DB) (c) elementFromPoint tâm nút tab BRAIN trúng nút tab, không trúng handle (d) 0 page error + 0 console error |
| R2 | **2** (0 P0-P3 · 2 P4 — do CHÍNH fix R1 sinh ra, đúng lớp "fix sinh lỗi mới" protocol lo) — điều phối 16-c verify mắt tươi độc lập 9/9 fix: đọc code + TÍNH TAY clamp 4 biên (chứng minh khoảng clamp không bao giờ rỗng/đảo: hi−lo = bw+0.8w > 0 ∀w — kể cả zoom 12× w=28.3 hay 0.5× w=680) · live agent-browser elementFromPoint tâm nút tab BRAIN (1527.6, 76) → SPAN trong nút (closest('button') = tab BRAIN — KHÔNG trúng handle; hit-area đo lại y54-70) · chọn Brain-B trong UI → network GET .../activity?brain=surrogate&head=success từ state activityHead (grep poll: `&head=${activityHead}` — không hardcode) · stale-cache phân tích test-sequence r92 C1→C7 (C3/C4 cache miss dựng builder thật, C7 policy cache HIT cùng dữ liệu → không false-pass; nhánh active đọc specJson không dính cache — r92 C5 đối chứng vocab khác cache) · probe /tmp stripComments 9/9 (trích hàm THẬT từ r92: URL/escape/backtick/chuỗi-chưa-đóng) · wc -l 1125/924 khớp hiệu đính blueprint | Phát hiện mới: R2-01 doc "count 4 bảng" sót 2 chỗ (r92 header + blueprint — 16-b sửa pin R1-07 nhưng sót 2 doc mô tả pin) · R2-02 r92-E thiếu pin wiring head-sync R1-01 (cùng lớp pin-hở BUG2-206) → cả 2 fix mini NGAY tại chỗ (BUG2-209/210: doc hiệu đính + +4 expect → r92 289) → tsc exit 0 · eslint 5 file + toàn repo exit 0 · check:imports PASS · r92 30/30 (289 expect) · FULL **1400/1400 / 65 file ×2 liên tiếp** (21088 + 21104 — dải drift pre-existing 21082-21098 dịch +4 đều) — KHÉP KẾT |

- Phát hiện: FB-BRAIN-LIVE-R1-01..09 → **BUG2-200..208** (9 entry — chi tiết đầy đủ tại Bug_v2.md): 3 C·P3 (trộn head · pan không clamp · [G·P3 pre-existing] handle che tab) + F·P3 (vocab query mỗi poll) + 5 P4 (scaleV chết · import chết · pin thiếu EvalCase · stripComments string-aware · doc lệch 1 dòng).
- Chấm chéo mô tả-đề-bài vs code (tiếp nối precedent 13-c): 2/9 (R1-02 biên trên công thức mâu thuẫn ý định "≥10%" — lấy đối xứng; R1-03 hướng thu hit-area "ngang" không đúng geometry thực — xung đột thuần dọc) — cả hai kiểm chứng live TRƯỚC khi sửa.
- Gate cuối (R1/16-b — gate cuối đợt là vòng R2 ở dòng kết luận dưới): tsc exit 0 · eslint toàn repo exit 0 · check:imports PASS · full suite **1400/1400 / 65 file** ×2 liên tiếp (21082 + 21098 expect — drift ±16 pre-existing đã biết của 15-e, không do đợt này).
- LIVE verify (16-b, read-only — DB app không đụng, bảng brain 0 row + không ChangeLog mới): tab BRAIN Brain-A 27 nơ-ron + zoom "34 33.8 272 270.4" + clamp 4 biên (−244.8/312.8/−243.36) + pan tự do khớp tay + fit; head 'tokens' → &head=tokens ×2 trong network; elementFromPoint tâm tab BRAIN → nút tab (hit-area 54-70 sau fix, trước 54-78); 0 lỗi console/page; localStorage restore về 'calibration_v3' như đầu phiên.
- Ghi chú trung thực: head-tab live-verify cần weights ≠ null nhưng DB app không có bản active nào (dormant đúng thiết kế) → mock response /api/brain/weights qua browser network route (chỉ trong phiên browser, unroute + reload sạch sau verify — không ghi DB, không đổi server); nhánh còn lại phủ bằng r92 C6 (head tokens ≠ success ở tầng route) + code review wiring.
- Ngoài phạm vi bàn đợt sau: (1) TuningParam 1 row (matryoshka_pilot off) + TuningChangeLog id 11/12 xuất hiện ~14:51 TRƯỚC phiên 16-b — không phải do 16-b (bảng brain 0 + không có ChangeLog ui_* mới từ test 16-b — test chạy DB cô lập /tmp) — đề xuất coordinator truy nguồn (nghi UI action ngoài các task đã ghi) — CẬP NHẬT 16-c: client lạ TIẾP TỤC trong cửa sổ 16-c (id 13: ui_hitech set 17:20:57 — KHÔNG phải 16-c, browser 16-c 0 POST; đo lại id 11/12 = 14:11:49 chính xác, 16-b ước ~14:51); (2) drift expect-count full suite (pre-existing 15-e); (3) honest gaps (a)–(f) trong nhật ký hiệu đính 0.10→0.11 blueprint: (a) trộn head · (c) pan chưa clamp · (d) handle che tab ĐÃ FIX đợt này (BUG2-200/201/202) nhưng bản ghi nhật ký KHÔNG sửa (lịch sử đúng tại thời điểm ghi — append-only, tương tự worklog); (b)(e)(f) vẫn by-design đúng như ghi; nâng cấp blueprint version/bổ sung nhật ký 0.11→0.12 thuộc Task 17 nếu coordinator muốn.
- Phát hiện R2 (16-c): FB-BRAIN-LIVE-R2-01/02 → **BUG2-209/210** (2 P4 — doc-stale sót sau fix pin + thiếu pin wiring head-sync; CẢ HAI fix mini ngay trong vòng verify, precedent R3-mini các đợt trước).
- Ghi nhận nhỏ KHÔNG cấp ID (16-c quét R2): (i) zoomAt (wheel/nút) KHÔNG clamp biên — chỉ pan được clamp: zoom-in lặp tại rìa cửa sổ có thể đưa view ra ngoài base (<10% giao) cho tới lần pan/⤢ kế — hành vi chuẩn map-UI, 16-a đã audit công thức zoom và không cờ; pan sau đó tự kẹp lại; (ii) stripComments không tokenize regex literal (sequence `//` trong regex literal có thể bị coi comment — file section hiện 0 regex literal, cùng giới hạn máy trạng thái nhỏ đã ghi).
- **Vòng R2 (16-c): verify 9/9 fix OK · 2 phát hiện mới P4 nhỏ (đã fix mini BUG2-209/210) · regression tsc/eslint/imports sạch + FULL 1400/1400 / 65 file ×2 (21088+21104) — ĐỢT KHÉP.**

### ĐỢT FB-BRAIN-TAB — scope phiên BRAIN-TAB-3PHAN (working tree chưa commit trên base 4a90c75+52d97f3: 3 section dọc tab BRAIN + geometry v3 + α/β/δ draft + brain-reference + studio ngang — 13 file M + 2 file ?? của 18-a/b/c/d/e; điều phối 18-f tự rà theo lớp bug precedent FB-BRAIN-LIVE/FB-BRAIN-UX) — 2026-10-12 — KHÉP KẾT SAU 2 VÒNG (R1 rà+fix · R2 rà lại vùng fix + quét nhanh toàn scope)

| Vòng | Phát hiện mới | Xác minh |
|---|---|---|
| R1 | **4** (0 P0-P3 · 4 P4: 1 H + 1 D + 1 G + 1 C) + 1 NGOÀI PHẠM VI (GHI NHẬN BUG2-215) — tự chấm-chéo 9 lớp brief: (L1) toán geometry v3 tính tay độc lập + script 8 case ([10,16,1]/[256,8]/[300,1]/[1,1,1]/[64]/[5]/[]/[256,300]) KHỚP TUYỆT ĐỐI mọi pin r90-J/r92-D/r93-A (yStart 77/26/153.5 · height 331/586/144/76 · rowStep/radius clamp 2 đầu · width clamp 340/900 · realIndex đơn điệu 0→299) + baseView max(76,96)+14=110 đủ chỗ nhãn; (L2) ResizeObserver cleanup deps [tall] ✓ · fitSize guard chia-0 ✓ · R1/R2 radius cột đúng chiều ✓ · zoom/pan clamp theo base.w động (grep 340 chỉ còn comment) ✓ + LIVE 768/1280px: viewBox 125% "39 34.5 312 276" khớp zoomAt sai số 0, svg fit 330×292/676×598 khớp min(boxW/w, boxH/h); (L3) normalize DROP nhất quán decision 18-d#1 · conditional spread không key undefined · head map 0/1/2 đúng · backward compat draft cũ (r88-G#4/#8); (L4) 0 mồ côi isDesktop (grep) · activeDialogParam/focusLayerSignal wiring nguyên vẹn; (L5) α/β NaN-guard ✓ · Fragment import ✓ · stepper bit-đối-bit HEAD; (L6) optimizers.ts thuần ✓ · prop contract khớp 15 props; (L7) mlp imports thuần · ε=1e-8 live đúng; (L8) full suite 1426/1426 + r93 C.6 pin yếu (BUG2-211); (L9) live mobile 375px: 0 button <44px · 0 overflowX — nhưng Smolab shell éop cột nội dung 0px (BUG2-215 ngoài phạm vi) | Fix 4/4: BUG2-211 r93-C.6 quét stripComments thay RAW (+REVERT-TEST: xóa dòng JSX → pin FAIL / RAW cũ vẫn pass — chứng minh pin yếu thật) · BUG2-212 bce deriv + '(kèm sigmoid)' · BUG2-213 δ min/max dùng DRAFT_LIMITS · BUG2-214 spec-schema lỗi khi activationParams sai shape (mảng/chuỗi/null) + r88-G test #8 mới → tsc exit 0 · eslint src+tests exit 0 · check:imports PASS · targeted r88+r90+r92+r93 109/109 · full suite **1427/1427** (21371 expect) |
| R2 | **0** (rà lại toàn bộ vùng fix: chấm chéo nhánh validation mới 6 nhánh đầu vào — undefined/null/array/string/{}/object hợp lệ — từng hành vi; bce row live "ŷ − y (kèm sigmoid)" render; δ input live min 0.01/max 10 từ hằng; REVERT-TEST restore sạch; grep toàn repo 'ŷ − y' không còn chỗ trần không ngữ cảnh; quét nhanh C1-C8 toàn scope + live 375/768/1280) | tsc exit 0 · eslint exit 0 · check:imports PASS · r93 16/16 (145 expect) · r88 37/37 · FULL SUITE **1427/1427 / 66 file ×2 liên tiếp** (21375 + 21387 expect — drift +12 loop-expect pre-existing) — KHÉP KẾT |

- Phát hiện: FB-BRAIN-TAB-R1-01..04 → **BUG2-211..214** (4 entry — chi tiết đầy đủ tại Bug_v2.md): H·P4 pin yếu r93-C.6 (2/13 chuỗi fallback comment) · D·P4 bce deriv thiếu qualifier cặp gộp · G·P4 δ input hardcode min/max · C·P4 validation bỏ im lặng activationParams sai shape.
- GHI NHẬN KHÔNG CẤP ID (hành vi chủ đích/giới hạn chấp nhận — xem worklog 18-f): (1) input số (units/α/β/δ) xoá trống → NaN-guard giữ draft, controlled value tự snap về sau re-render kế — pattern có từ UX-1, không mất focus, không NaN vào DB; (2) stale α/β ngoài range + đổi activation → lỗi validate vẫn chặn lưu dù input ẩn (hệ quả trực tiếp decision 18-d#1 "validate mọi khóa có mặt" — đã ghi worklog 18-d); (3) giá trị ngoài range không kẹp tại input — single-source validateBrainDraft chặn lưu; (4) bảng không caption — nhất quán precedent tuning/diff, section có aria-label; (5) không có ResizeObserver (trình duyệt cũ) → svg h-auto w-full có thể clip trong box cao cố định — degrade documented 18-a; (6) hit-test neuron lấy nơ-ron ĐẦU TIÊN trong ngưỡng (không gần nhất) — sàn 4 deliberate 18-a; (7) edgesAll dựng đủ tổ hợp (256×256/cặp cột) trước LOD — pre-existing BRAIN-LIVE cap-256, không đổi wave này; (8) head-tab surrogate chỉ render khi có weights (bản active) — chủ đích, wiring pin r92-E.
- NGOÀI PHẠM VI bàn đợt sau: **BUG2-215** — Smolab module shell mobile <640px éop cột nội dung 0px (svg sân khấu 0×0 — tái lập cả trên tab Learning → lỗi shell smolab-module.tsx, KHÔNG phải brain-tab; 768px+ hoạt động chuẩn) — đề xuất coordinator mở đợt rà shell riêng theo giao thức §5.6.
- Gate cuối: tsc + eslint + check:imports PASS + full suite **1427/1427 / 66 file ×2** (1426 gốc + 1 test r88-G#8 mới; expect 21354 → 21375/21387).
- LIVE verify (18-f, read-only — không ghi DB, không restart pm2): 375×812 3 section + 4 tab + 0 nút <44px + 0 overflow (shell éop là BUG2-215 ngoài scope) · 768×1024 tab 'Hàm & công thức' 5 khối (9 activation/4 loss/reward/tiến/ngược) + δ×2 + hằng optimizer "ε=1e-8" + segmented "Vọng" + zoom +125% → viewBox "39 34.5 312 276" khớp công thức + ⤢ Vừa về 100% + poll `?brain=surrogate&head=success` đúng wiring R1-01 · 1280×900 svg 676×598 khớp fit công thức · 0 console error · 0 page error.
- Ghi chú quy trình: đợt chạy trên working tree CHƯA COMMIT (13 M + 2 ?? của wave 18-a..18-e + 5 file đụng của 18-f: spec-schema.ts · training-console.tsx · brain-reference.tsx · r88 · r93) — commit do coordinator; môi trường Bash render sai chuỗi `[h`/`[i` đã xử lý bằng Read tool (không sửa file nguyên vẹn).
- **Vòng R2: rà lại vùng fix + quét nhanh toàn scope — 0 phát hiện mới · gate 4 tầng PASS (tsc · eslint · check:imports · full 1427/1427 ×2) — ĐỢT KHÉP.**

### ĐỢT FB-OBS — scope "giao thức quan sát V2" OBS-P1→P4 đợt Task 23 (commit f94c55c: 29 file +3377/−22 — 6 module mới src/lib/observation/{ledger,trace,kinds,impact}.ts + timeline route + observation-tab 642d · 13 file hook {tuning-store, agent-run-tracker, reward, 3 pipeline, 3 organ, 5 bảng học q-table/metrics-db/episodic-db/auto-learn, instrumentation, smolab-module} · model 103/104 · 4 cờ TUNING_SPECS 26–29 · 4 test r95–r98 (64) + pin r81/r86/r87/r92 · blueprint OBS v0.3) — 2026-10-13 — KHÉP KẾT SAU 3 VÒNG (R1 auditor độc lập 24-a + coordinator chấm chéo · R2 rà lại vùng fix · R3 fix LIVE-01 + rà lại)

| Vòng | Phát hiện mới | Xác minh |
|---|---|---|
| R1 | **13** (2 C·P3 + 2 C·P4 + 4 D/G·P4 + 5 G·P4) — auditor độc lập 24-a mắt tươi (không phải người viết code Task 23) quét đủ C1–C8: đối chiếu spec §C.1–C.7 + §7 chốt + HyperNAS §9 + commit message; toán độc lập 4 probe thuần + 4 probe DB cô lập (CI 2-proportion 4/4 khớp 1e-9 · seq đơn điệu 500 dòng 2-writer 0 gap · queue 87/513 · prune trigger-1000 + cap-50K · SHA-256 · capPayload byte · window 3 kịch bản); edge limit/before/since → 400; tsc + eslint + check:imports bằng chứng; test r95–r98 đọc trọn tìm pin yếu; tích hợp 612 file; vệ sinh git sạch | Fix toàn bộ 13/13 + 13 test regression (r95-C4/E2/I1 · r96-B2/G1/G2/G3 · r97-B10 · r98-A4/C4/C5/C6/G4) → tsc exit 0 · eslint exit 0 · check:imports PASS · full suite **1504/1504** (1491 + 13) |
| R2 | **0** — rà lại TOÀN BỘ vùng fix: window ±3 ngày đối chiếu lại 6 kịch bản (r98-C1..C6 pass behavioral); cap byte kiểm hexdump; prune opts 2 hướng; verdict delegate rowKey behavioral; kindClass 0 mồ côi (grep toàn repo); 1 nghi vấn comment "[minDay" hóa ra do môi trường hiển thị ANSI ăn ký tự `[m` (tiền lệ đã ghi tại đợt FB-BRAIN-TAB dòng ghi chú quy trình) — hexdump bác, không phải lỗi file | tsc · eslint · check:imports PASS · full 1504/1504 |
| R3 | **1** (D·P4 — LIVE-01: lặp từ "đang thử lại — thử lại" do CHÍNH fix R1-12 sinh ra — catch message cũ "…giữ dữ liệu cũ, đang thử lại" + hậu tố spinner "— thử lại"; bắt tại live verify agent-browser bằng network route abort, sau khi R2 đã khép — đúng cảnh báo §1 "fix có thể sinh lỗi mới") | Fix 1 dòng (rút catch → 'Mất kết nối — giữ dữ liệu cũ') → live verify lại hết lặp + r97-B10 pin không đổi → gate 4 tầng PASS lại (tsc · eslint · check:imports · full 1504/1504) — ĐỢT KHÉP |

- Phát hiện: FB-OBS-R1-01..13 + FB-OBS-LIVE-01 → **BUG2-216..229** (14 entry đầy đủ tại Bug_v2.md: hiện tượng / bằng chứng / fix + kiểm chứng từng entry). Phân loại: 2 spec-deviation P3 (window ±3 ngày dead · same-day chặn cả KPI) + 2 P4 sai mô hình/cap (CI binomial cho KPI trung bình · cap đếm ký tự thay byte) + 10 P4 (doc kinds HyperNAS · pin prune · map UI trùng lặp · rowKey delegate · đếm test 65→64 · comment đếm nguồn · đếm giả obs_ledger off · error-state treo spinner · pruning guard trace · lặp từ do fix sinh).
- Sai kì vọng phía người rà: 4 của auditor (CI BigInt chia thỹa scale ×2 · capPayload cắt thô tạo JSON đứt — head là chuỗi stringify escape, parse OK · 2-writer seq race — SQLite interactive transaction serialize, 0 gap/0 dup · probe prune-trigger fail do chính auditor quên queue cap 512) + 1 của coordinator (nghi "comment thiếu [m" — lớp hiển thị ANSI ăn `[m`, hexdump bác; trùng tiền lệ FB-BRAIN-TAB đã ghi).
- Kiến trúc xác nhận NGUYÊN VẸN (auditor R1 — coordinator không rà lại từ đầu): CI 2-proportion · seq MAX+1 · queue 512 drop+đếm · paginate before/nextBefore · validate 400 · READ-ONLY + join trace chỉ khi runId · 16 kinds 3 nguồn khớp (trừ BUG2-220 1 phía doc) · hash-only mặc định/full 2KB · 4 cờ off mặc định + overhead 0 (r95-A1/A2) · poll thích ứng 2,5s/15s + visibilitychange + queueMicrotask · a11y · worker tick 10 phút globalThis guard + unref · hooks 13 call-site đủ 2 nhánh delegate/raw.
- Ghi nhận KHÔNG cấp ID (auditor — hành vi chủ đích/giới hạn chấp nhận): formatImpactDelta âm-zero "-0,0000" · CI không kẹp [0,1] ("CI thô" trung thực) · since=0 → Date.parse('0')=2000-01-01 hợp lệ fail-open · poll fetch mỗi keystroke actor (read-only rẻ) · console.log impact.ts boot-log worker đúng precedent goal-loop · chip flags hiển thị off khi data===null (fetch chặn — fail-open hiển thị, không ra quyết định).
- Gate cuối: tsc exit 0 · eslint exit 0 · check:imports PASS (612 file, 0 chu trình mới) · full suite **1504/1504 / 70 file ×2** (1491 + 13 test mới; 21749 expect).
- LIVE verify (pm2 restart + agent-browser 1440×900): tab Quan sát mở · full UI khi ui_observation on (region + filter 16 kind + "3 sự kiện" + cảnh báo obs_ledger off trung thực + 3 row audit thật flag.flip/tuning.change từ Task 23 + Mở tab BRAIN) · **R1-12 behavioral**: network route abort `**/api/observation/timeline*` → reload → data null → spinner hiển thị LỖI (innerText "Mất kết nối…— thử lại") thay vì treo "Đang tải…" vô hạn như code cũ; R3 xác nhận hết lặp từ sau LIVE-01 fix · 0 page error · 0 console error.
- Không việc hoãn nào trong scope (BUG2-224 commit-message "65 test" là bất biến lịch sử git đã push — ghi nhận hiệu đính tại Bug_v2, không phải hoãn sửa).
- **Vòng R3: 0 phát hiện mới còn lại (LIVE-01 đã fix + xác minh) · đủ 3 tiêu chí dừng §2 — ĐỢT KHÉP.**

### ĐỢT FB-SERIAL — scope R14 tuần tự hóa agent invocation (user directive bản 3 ghi đè 2026-10-29b: subagent-delegate slot pool default 3→1 + boot log + getSubAgentSlotPoolInfo + ALS re-entrancy; omega-orchestrator dispatchAgentsParallel for-await; g1/sub-agents dispatchPlan for-await; king/engine blind scorers tuần tự; tool-executor desc + guard; goal-loop 4 chỗ văn bản + JD strings 5 nguồn + .env.example + TB-03 note R14; tests r101 15 test) — 2026-10-15 — KHÉP KẾT SAU 3 VÒNG (R1 2-auditor + coordinator chấm chéo · R2 16-c mắt tươi · R3 mini coordinator)

| Vòng | Phát hiện mới | Xác minh |
|---|---|---|
| R1 | **9** (1 B·P2 + 2 D·P3 + 1 C·P3 + 5 P4) — auditor 2-a mắt tươi (đọc code path độc lập, không tin comment; probe live dev.log boot R14 + slot 1/1 + "CATALYST xếp hàng" làm bằng chứng bổ sung) | Fix 9/9 + r101 10→14 test → gate tsc/eslint/imports PASS + full 1708/1708 + build exit 137 (OOM môi trường — chứng minh BUILD_EXIT=0 khi pm2 dev-server dừng: BUILD_EXIT=0) |
| R2 | **7** (0 P0-P2 · 1 D·P3 + 6 P4 — do chính fix R1 sinh ra đúng cảnh báo §1 + 1 pre-existing bóc ra: goal-loop:859 protocol dạy "SONG SONG", thoughts 📤/📥, comment stale ×3, prompts.ts:99 tool-calls, r102 pin yếu ×4, sweeper timer trong next build) | Fix 7/7 + r101 +B9 (15) + r102 sửa 4 điểm → gate 4 tầng PASS + full **1726/1726** |
| R3 mini | **0** (rà lại vùng fix R2: quét toàn-file absence "song song sai sự thật" giờ bị pin B9 chặn; fallback debt 4 mục đối chiếu bản gốc :1159 đủ; sweeper guard NEXT_PHASE nghiệm qua build riêng BUILD_EXIT=0) | ĐỢT KHÉP — đủ 3 tiêu chí dừng §2 |

- Phát hiện: FB-SERIAL-R1-01..09 + R2-01..04 → **BUG2-231..243** (13 entry — chi tiết đầy đủ tại Bug_v2.md). Nhóm logic: 1 P2 deadlock tự-chờ (ALS re-entrancy) · 2 P3 prompt sống (OMEGA standalone + SIVIL identity) · 1 P3 test/citation S1 · 9 P4 (doc/comment/test-pin/observability).
- LIVE verify (E2E thật qua POST /api/openclaw/chat): boot `[SubAgentSlot] Phanh hiệu dụng (R14): maxConcurrent=1 — TUẦN TỰ... [nguồn: default=1, zenKeys=3]` đúng 1 lần (dev.log:17192); SENTINEL nhận slot **1/1** (trước đây 1/3); các dispatch thừa của LLM xếp hàng FIFO "+6 đang chờ trước"; **`CATALYST chờ 484s → nhận slot` CHỈ SAU khi SENTINEL hoàn tất (485s, concluded 1 vòng)** — đúng nguyên văn directive "lần lượt agent này xử lý xong mới tới agent khác"; không còn slot 1/3 hay 2/3.
- Gate: **1708 → 1726** (+18: r101 15 + r102 13 − 10 gốc r101@10 nhầm đếm lúc đầu); tsc + eslint + check:imports PASS mọi vòng; build stage exit 137 = OOM tranh chấp RAM với pm2 dev-server (bằng chứng dmesg OOM-kill next-build rss 2.1GB; BUILD_EXIT=0 khi dừng pm2 — environmental, không phải lỗi code).
- Điểm chờ user (không tự quyết): observability pool (getSubAgentSlotPoolInfo) chưa có consumer production — wire panel API/UI bàn đợt sau (BUG2-239 ghi nhận).
- Ngoài phạm vi bàn đợt sau: orchestration/agent-delegator.ts doc legacy (ENABLE_REAL_DELEGATE=false) · đo phân phối waitedMs hàng đợi chéo · TB-03 Hybrid/Waves dead-spec quyết định dài hạn · P-NEW-2 SelfDirection song song + P-NEW-1 Prisma pool (nợ cũ).

### ĐỢT FB-R13DEBT — scope toàn bộ fix R13 DebtLedger ("những fix từ lượt quan sát gần nhất" — 5 hạng mục F-R13-1..5: model DebtLedger + debt-ledger.ts ~450 dòng + wiring agent-goal-loop + /api/debt/status + .env; docs/QUAN-SAT-LUOT-6-R13.md) — 2026-10-15 — KHÉP KẾT SAU 3 VÒNG (R1 2-b auditor tái lập E2E DB cô lập · R2 16-c · R3 mini coordinator)

| Vòng | Phát hiện mới | Xác minh |
|---|---|---|
| R1 | **8** (1 C·P1 + 2 C·P2 + 2 P3 + 3 P4) — auditor 2-b: probe fingerprint thuần 8 case + **tái lập E2E vòng đời trên DB cô lập** (script /home/z/.audit-r1/repro.mjs giữ cho chấm chéo) + grep toàn repo; đỉnh: **P1 finalize không bao giờ resolve nợ same-session** (mirror-lookup trượt Todo gốc — chính chẩn đoán user "nợ chỉ tăng không giảm" còn sống) | Fix 8/8 (r102 13 test mới — lấp C5 cho cả đợt R13) → gate PASS |
| R2 | **3** (0 P0-P2 · 3 C·P4: fallback thiếu mục 3-4 legacy; r102 4 điểm pin yếu/cleanup hở; sweeper timer nổ trong next build ghi DB thật) | Fix 3/3 (fallback đủ 4 mục nguyên văn :1159; A4 pin thật + B5 khớp fp + cleanup SESS_C; guard NEXT_PHASE) → gate **1726/1726** |
| R3 mini | **0** (rà lại vùng fix R2: đối chiếu fallback 4 mục vs bản gốc — đủ; parkReason "vẫn bị re-list" giờ được exercise B5; build riêng BUILD_EXIT=0 chứng minh sweeper guard) | ĐỢT KHÉP |

- Phát hiện: FB-R13DEBT-R1-01..08 + R2-01..03 → **BUG2-244..254** (11 entry — chi tiết đầy đủ tại Bug_v2.md). Nhóm logic: 1 P1 (same-session resolve — lookup OR d.todoId) · 2 P2 (park không dừng same-session; kill-switch giết nhầm pickup legacy) · 1 P3 race claim · 7 P4 (PATCH validate, fingerprint edge, sweeper, test-pin, fallback đủ, evidence label).
- Nghiệm thu behavioral (r102 trên DB gate-cô lập): hoàn thành Todo GỐC → nợ RESOLVED (trước fix: kẹt open vĩnh viễn) · park sau 3 lần → Todo gốc failed + nợ ra khỏi "ƯU TIÊN XỬ LÝ" sang ghi-chú "ĐÃ PARK — KHÔNG thử lại" · PATCH bảng chuyển đủ nhánh 400/200 · global cap ≤2 · fingerprint "lỗi12lần" ≡ "lỗi 12 lần" + 160-collision hết false-dedupe.
- Hiệu đính lịch sử (append-only, không sửa nội dung cũ): worklog/docs R13 ghi "sweeper archived 63 ngay boot" — cơ chế thật là "chạy tại pickup đầu tiên sau boot"; từ R14 sweeper có đồng hồ riêng 5s sau module-load (BUG2-251).
- Ngoài phạm vi bàn đợt sau: PATCH id sai-format cuid → Prisma P2023 500 (pre-existing R13) · migration re-fingerprint cho DB có row pre-R14 (production hiện 0 rows) · UI panel sổ nợ (P-R13-2) · severity cột chết (ghi nhận R13).

### TỔNG KẾT LŨY KẾ (cập nhật sau FB-SERIAL + FB-R13DEBT)

- **Phát hiện lũy kế qua giao thức: 83 + 24 = 107** (FB-SERIAL 13 + FB-R13DEBT 11) — 100% có entry Bug_v2.md (BUG2-231..254); 0 P0 · 1 P1 · 4 P2 · 5 P3 · 14 P4.
- Sai-kỳ-vọng phía người-rà: +8 (R1-A 4 + R2 4 — ghi BUG2-231..254 mục ghi chú); chuỗi tiếp tục xác nhận giá trị chấm chéo 3 phía (C2).
- Gate kiểm thử: **1726/1726** (từ 1698 của R13; +28: r101 15 + r102 13).
- Bài học mới truyền lại: (1) **fix xong phải quét TOÀN FILE, không chỉ vùng fix** — R1 sửa :354/:118 nhưng :547/:112/:859 cùng file/prompts liền kề còn sót (R2 bắt được); pin theo vùng (region slice) phải mở rộng thành quét toàn-file absence; (2) **assert tự-satisfied** (`a || b` luôn true với chuỗi non-empty) là pin giả — R3 bắt trong chính test do người viết fix sinh ra; (3) sweeper/timer đặt tại module-load phải nghĩ đến next build EVAL module (NEXT_PHASE guard); (4) auditor tái lập E2E DB cô lập là công cụ mạnh nhất vòng R1 (P1 same-session không bao giờ hiện trên code-reading thuần — phải chạy vòng đời).

### ĐỢT R15-DEBT — "giải quyết các vấn đề nợ còn lại" (user directive 2026-10-15) — scope: toàn bộ nợ treo từ fixbug.md R14 "Ngoài phạm vi" + R13 §7 — KHÉP KẾT SAU 1 VÒNG AUDITOR + FIX 7/7 + RE-GATE

| Vòng | Phát hiện mới | Xác minh |
|---|---|---|
| R1 (auditor độc lập — 1 subagent tuần tự theo directive R14) | **7** (0 P0-P2 · 3 P3 · 4 P4 — đỉnh: BUG2-253 REOPENING "biên bản ghi đã fix nhưng code chưa fix" + production debt-block 2 nguồn + ALS chưa global cùng pool) | Fix 7/7 + r101 B5 pin mạnh hóa + r102 B0 pin hành vi MỚI → tsc 0 · lint 0 · imports PASS · full **1727/1727** (+1 test B0) · E2E curl PATCH garbage-id → 400 · UI panel browser verify desktop+mobile 0 console error |

- **Nợ ĐÃ ĐÓNG đợt này** (chi tiết Bug_v2.md phần đợt R15-DEBT): PATCH P2023 (cuid validate → 400, belt-and-suspenders catch P2023) · BUG2-239 (getSubAgentSlotPoolInfo có production consumer: /api/debt/status slotPool + queueStats p50/p95/max — kèm đo phân phối waitedMs "đo phân phối waitedMs hàng đợi chéo" cùng đóng) · P-R13-2 (UI panel "Sổ nợ kỹ thuật" Database > Analytics: counts + phanh tuần tự + waitedMs + nút Resolve/Reopen/Park PATCH + severity badge) · P-R13-1 (dồn buildPendingDebtBlock → buildLegacyPendingDebtBlock + formatDebtDirectiveBlock 1 nguồn cho fallback LẪN production path (a)) · BUG2-253 reopening (4 mục nguyên văn — lần này pin BỎI HÀNH VI B0, không phải pin cấu trúc yếu) · P-NEW-4 (triage classifier reasoningEffort 'low' — cắt ~10K tokens/call phần reasoning, mirror tiền lệ Task 55, directive vẫn tôn trọng caller-override) · P-NEW-1 (gốc cơ chế: live-probe Prisma SQLite mặc định busy_timeout=5000ms ĐÚNG "transaction timeout 5000ms" quan sát R11 → nâng 15s qua URL socket_timeout áp MỌI connection pool — PRAGMA raw chỉ áp 1 connection; env SQLITE_BUSY_TIMEOUT_S + .env.example) · P-NEW-2 (đóng MITIGATED 3 lớp có bằng chứng: user-run-priority R12 orchestrator:2481 + OC-CLI semaphore F7 + pool=1 R14) · severity cột chết (deriveDebtSeverity: infra hoặc tái phát ≥2 → high — wired cả 3 nhánh create/reopen/bump sau auditor R1-04) · TB-03 (NOTE R14/R15 ×3 chỗ + khung quyết định docs/QUYET-DINH-TUAN-TU-VS-CONCURRENCY-R15.md — trả lời câu hỏi user "tuần tự vĩnh viễn vs concurrency kill-switch") · agent-delegator doc legacy (docblock LEGACY PATH — production đi subagent-delegate) · migration re-fingerprint (MOOT — production 0 rows).
- **Phát hiện phụ đáng chú ý nhất:** BUG2-253 reopening — biên bản R14 vòng R3 ghi "copy đủ 4 mục nguyên văn; kiểm chứng r102 F1 pin giữ + đọc trực tiếp" nhưng git show HEAD xác nhận code commit thực tế thiếu mục 3-4. Bài học truyền lại: (5) **"đọc trực tiếp" không phải kiểm chứng — chỉ behavioral pin mới chặn được**; biên bản ghi nhận fix PHẢI kèm bằng chứng chạy được (test/path), không phải lời xác nhận của người viết fix; (6) pin cấu trúc (source contains) phải pin NỘI DUNG quyết định (4 mục), không pin sự tồn tại của hàm.
- **Hardening thêm từ auditor (không nằm trong danh sách nợ):** pool slot + ALS đều lên globalThis singleton (next dev đa instance — ALS bỏ lại sẽ là cửa sau stall cross-bundle) · cờ cross-process insideSubAgentRun xuyên cầu nối CLI (LLMCallOptions → spawn env → bridge context → guard escalate lớp 3).
- **Nợ còn mở (trung thực):** P-R13-3 relevance filter (cần dữ liệu vận hành thật — DebtLedger 0 rows production, chờ run có nợ tự nhiên) · UI RAM headroom cho khung kill-switch (waitedMs đã có; MemAvailable theo MemWatchdog log) · docs/arch-spec/ untracked chờ phiên sở hữu (BUG2-261 — không đưa vào commit này) · write-queue architecture (bước kế tiếp NẾU "Socket timeout" tái xuất sau busy_timeout 15s — điều kiện reopen P-NEW-1).

### TỔNG KẾT LŨY KẾ (cập nhật sau R15-DEBT)

- **Phát hiện lũy kế qua giao thức: 107 + 7 = 114** (R15-DEBT 7: 3 P3 + 4 P4) — 100% có entry Bug_v2.md (BUG2-255..261).
- Gate kiểm thử: **1727/1727** (từ 1726; +1 r102 B0 behavioral pin 4 mục đường production).
- Sai-kỳ-vọng phía người-rà R15-R1: 6 (auditor tự bác — ghi report auditor) — chuỗi chấm chéo tiếp tục xác nhận giá trị.

### ĐỢT R18 — 4 bug user report production (nhiều agent cùng lúc + Thought Process biến mất + THAY ĐỔI CHƯA COMMIT thừa + RAM/request ma định kỳ) — KHÉP KẾT SAU ĐIỀU TRA 3 SUBAGENT EXPLORE SONG SONG + FIX 5 BUG + E2E BROWSER

| Vòng | Phát hiện mới | Xác minh |
|---|---|---|
| R18 (điều tra gốc rễ — 3 subagent Explore song song: concurrency-paths · thought-lifecycle · periodic-LLM-sources; fix chính session) | **5** (BUG2-262..266: 1 P1 · 3 P2 · 1 P3) + 1 bug phụ phát hiện khi E2E (BUG2-266 response rỗng) | tsc 0 · lint 9 file 0 · full **1727/1727** · E2E browser: panel tái xuất hiện qua 2 lần restart + trail lazy-fetch 21 events + response không còn block 📁 + mobile/footer OK + 0 console error |

- **Điểm chẩn đoán quan trọng nhất đợt:** "nhiều agent cùng lúc" KHÔNG phải slot pool R14 hỏng (pool vẫn serialize đúng — registerDelegationRun chạy SAU acquireSubAgentSlot) mà là 3 tầng khác: GOAL_LOOP_MAX_CONCURRENT default 2 (máy user không có .env override) · đường inline chat không mutex (2 POST chồng = 2 loop song song) · orphan sweep requeue-đè đa process (không check workerPid sống). Tương tự: "Không còn nhịp" là báo động GIẢ của panel cha khi await delegation hợp lệ 10-16' (chip dựa run.events im lặng ≥5').
- **Kiến trúc mới "Thought Process vĩnh viễn" (BUG2-263):** 3 lớp — registry in-memory (nâng cap + evict an toàn: chỉ đuổi run KHÔNG chạy) → recordRuns (API tái tạo panel từ bảng AgentRunRecord DB khi registry mất) → trail lazy-fetch (panel mở → /api/agent-run?runId= đọc JSONL đĩa agent-runs/<runId>.jsonl — đầy đủ event, sống qua restart, retention 14 ngày). UI merge cả 3 nguồn — panel "GIỮ NGUYÊN tại phản hồi đó" theo yêu cầu user.
- **Chống "tác vụ ma" định kỳ (BUG2-265):** trần tuổi resume job 12h (GOAL_LOOP_RESUME_MAX_AGE_MS — job kẹt từ hôm trước không tự sống lại mỗi boot) · Opus auto-sweep idle-gate 6h (OPUS_AUTO_IDLE_MS — session không ai dùng không review nữa) · policy-block TTL FreeTierError 403: 60s/300s → 1h (ZEN_POLICY_BLOCK_TTL_MS — retry ngắn cho policy-chặn toàn cục chỉ đốt lại 5 spawn CLI × 400-590MB) · kill cây tiến trình khi CLI timeout (Windows taskkill /T /F — chống leak opencode.exe cháu giữ RAM).
- **BUG2-264 "THAY ĐỔI CHƯA COMMIT" thừa:** wrap-up cũ chụp TOÀN BỘ working tree lúc kết thúc (gồm phần bẩn từ TRƯỚC run) → mọi final report kèm block. Giờ: snapshot đầu run + chỉ báo DELTA (file run này tạo ra) — E2E: 2 run chỉ-đọc đều sạch.
- **BUG2-266 (phát hiện E2E):** run kết thúc bằng tool call (không prose) + verdict complete → response "(agent không trả về nội dung)" — thêm ngoại lệ thứ 3 cho generateFinalReport (complete + lastContent rỗng → tổng hợp từ bằng chứng).
- **Bài học truyền lại:** (7) **registry in-memory làm nguồn render UI = bug biến mất chờ ngày nổ** — phải luôn có lớp phục hồi bền vững (DB record + disk trail) và UI phải có đường fallback đọc lớp đó; (8) **chip trạng thái UI phải biết về các trạng thái CHỜ HỢP LỆ của hạ tầng** (await delegation 10-16') — heuristic "im lặng = chết" chỉ đúng khi không có cơ chế chờ dài đang chạy; (9) **TTL cache lỗi phải phân biệt POLICY (chặn vĩnh viễn — TTL dài) vs TRANSIENT (429/5xx — TTL ngắn)** — đồng nhất TTL khiến policy-block được retry vô nghĩa định kỳ; (10) **điều kiện nhánh fix phải kể CHẦN các trạng thái dữ liệu** (lastContent rỗng ≠ lastContent raw-mid-work — 2 ngoại lệ cùng đường complete nhưng chỉ 1 được bắt).

### TỔNG KẾT LŨY KẾ (cập nhật sau R18)

- **Phát hiện lũy kế qua giao thức: 114 + 5 = 119** (R18: BUG2-262..266 — 1 P1 · 3 P2 · 1 P3).
- Gate kiểm thử: **1727/1727** (không test mới — theo directive phiên; pin hành vi qua E2E browser có bằng chứng screenshot + DB + trail).
- Ghi chú: 1 vòng OOM-recompile xuất hiện giữa E2E (kernel OOM-kill next-server RSS 2.47GB lúc recompile sau edit — ràng buộc box 4GB đã ghi R16/R17, app tự hồi phục, run bị gián đoạn được salvage đúng cơ chế).

### ĐỢT R19 — 3 yêu cầu user (mở khóa chọn model + bỏ toàn bộ model fallback + thiết lập lại đăng nhập OpenCode) — KHÉP KẾT SAU 3 SUBAGENT EXPLORE SONG SONG + PHẪU THUẬT llm.ts 4 HÀM ENTRY + 2 BUG PHÁT HIỆN E2E

| Vòng | Phát hiện mới | Xác minh |
|---|---|---|
| R19 (3 subagent Explore song song: fallback-chain-map · model-selector-flow · opencode-oauth; fix chính session) | **2** (BUG2-267: nút chọn model disable toàn bộ — P1 · BUG2-268: probe tự gãy auth.json CLI — P2) + 1 user directive lớn (dỡ toàn bộ model fallback) | tsc 0 · lint 0 · full **1729/1729** (r73-3 + r74 viết lại pin hành vi mới) · E2E browser desktop 1920 + mobile 390: dropdown 2 nhóm + chọn model zen cho agent nvidia + model phục vụ đúng + model lạ lỗi 1.5s + cliOk hiển thị đúng + 0 console error |

- **BUG2-267 (P1 — "không thể chọn model"):** thủ phạm đúng 1 dòng `canPick = ... shown.provider === 'zen'` — mọi agent sau R16/R17 là nvidia → nút disable → màn đăng nhập OpenCode (sống trong dropdown) cũng kẹt theo. Fix: canPick mở cả nvidia + dropdown nhóm "OpenCode free" / "NVIDIA NIM" + provider suy từ MODEL khi gửi (`chosenModelOpt?.provider` — chọn model zen cho agent nvidia vẫn route đúng) + trigger đăng nhập cho MỌI model zen (cũ bỏ sót big-pickle vì chỉ match /free|bunny/).
- **USER DIRECTIVE "bỏ model fallback":** dỡ sạch 5 tầng (ZEN FAILOVER + LAST RESORT + NIM RESCUE + normalize âm thầm SBF + /api/query fallback cấp route) khỏi 4 hàm entry llm.ts; extraction NIM thuần; utility zen thuần; xoay NIM giảm 12 attempts → 1 lượt/key + dừng khi 2 lỗi model-tầng liên tiếp (hết "RAMPAGE giữ request 3-5 phút"). Mọi lỗi model trả NGAY kèm nguyên nhân + "Chọn model khác trong khung chat" (E2E model lạ: 1.5s, 0 call). callModelWithKeyRotation trả error-result thay null mù.
- **BUG2-268 (probe tự gãy CLI):** route probe ghi đè auth.json bằng OAuth session (bị chặn IP datacenter) TRƯỚC khi đo CLI — tự tay phá oc_sk đang chạy free-tier CLI tốt (policy Zen MỞ LẠI lần 4 từ 15/10 — bằng chứng `opencode run` cost 0). Fix: bỏ ghi đè ở nhánh HTTP-fail, CLI probe chạy với auth.json hiện trạng → cliOk phản ánh đúng; UI dropdownBlockedLineR6 nhận cliOk → "🔓 HTTP bị chặn nhưng transport CLI chạy lõi free OK — DÙNG ĐƯỢC ngay" (emerald); khôi phục auth.json oc_sk + verify CLI "OK" 10147 tokens cost 0.
- **Đăng nhập OpenCode "thiết lập lại":** flow device-code hoạt động end-to-end (E2E: POST /login trả userCode VBKN-BDLR + link opencode.ai console thật; status đúng trạng thái; logout khôi phục oc_sk; poll tự probe + tự clear block-cache khi unlock). Trên máy user IP cá nhân VN: sau Approve, probe sẽ unlock (hoặc cliOk) → lõi free dùng được; không cần cấu hình gì thêm.
- **Bài học truyền lại:** (11) **Điều kiện canPick/disable của UI phải theo NĂNG LỰC (provider hỗ trợ) chứ không theo GIÁ TRỊ STATE hiện tại** (provider zen cũ) — ghim theo state khiến nút chết âm thầm khi vận hành đổi state hợp lệ; (12) **Không ghi đè credential đang chạy trước khi biết credential mới có hoạt động không** — probe phải đo với hiện trạng, chỉ bridge credential mới SAU khi nó được chứng minh unlock; (13) **fallback là nợ kỹ thuật vận hành ngược tinh thần debug**: mỗi tầng fallback che nguyên nhân thật thêm 1 lớp (model chết → 4 model khác thử → RAM/request ma) — user directive "báo lỗi để tự chọn" vừa nhanh hơn vừa debug được.

### TỔNG KẾT LŨY KẾ (cập nhật sau R19)

- **Phát hiện lũy kế qua giao thức: 119 + 2 = 121** (R19: BUG2-267 P1 · BUG2-268 P2).
- Gate kiểm thử: **1729/1729** (2 file test r73/r74 viết lại pin hành vi no-fallback — thay 5 pin pool last-resort cũ bằng behavioral pin mới).
- Ghi chú: policy Zen free-tier CLI keyless MỞ LẠI 15/10 (lần 4) — ghi nhận qua probe cost 0; OAuth session datacenter vẫn bị chặn (đúng phân tích IP-based R16/R17).

### ĐỢT FB-BRAIN-D1 — scope BRAIN-D1 LOG-ONLY đợt R20 (commit 4394507: 15 file +781 — prisma KbConsultLog + consult-context.ts/consult-log.ts MỚI + kb-access instrumentation + tool-executor ALS wrap + chat route wrap + runSmartKB wrap + neural-types cờ #32/node #24/edges e38–e42 + r110 14 test + 6 count-pin) + blueprint v0.3 (c75db57) — 2026-10-17 — KHÉP KẾT SAU 2 VÒNG (R1 auditor độc lập + fix 8/8 · R2 verify 0 phát hiện mới)

| Vòng | Phát hiện mới | Xác minh |
|---|---|---|
| R1 (auditor độc lập subagent Explore — mắt chưa từng xem code D1, chạy đủ C1–C8 + harness runtime ALS/serializeCapped + DB cô lập + tsc/eslint độc lập; coordinator chấm chéo từng phát hiện) | **8** (1×G·P2 · 4×C·P3 · 2×E·P3 · 1×C·P4) — đỉnh: THIẾU MIGRATION KbConsultLog (máy user db:deploy không có bảng → corpus D1 chết im lặng — G·P2) + ALS merge undefined-đè-cha ngược JSDoc (mất Outcome* linkage) + cap CHARS thay BYTE (VN text 2×) + retrievalConfig thiếu denseThreshold/sourcesEnabled + blind-spot fallback-dense & graph-query không có row | Fix toàn bộ 8 + **7 regression test** (r110 14→21: A5 migration pin · B3b VN-byte · B6 empty-query · C4 undefined-merge · D4 denseThreshold+sourcesEnabled · E1 graph-wrapper · E2 fallback) → tsc 0 · eslint 7 file 0 · r110 21/21 (105 expect) · full suite **1527 pass — delta=0 so baseline** (22 fail/13 errors đều pre-existing r69/r73-2, pass riêng 28/28 + 30/30) |
| R2 (coordinator mắt tươi toàn diff fix + migration-deploy throwaway DB + E2E app thật + browser) | **0** → KHÉP KẾT | `prisma migrate deploy` trên DB trắng /tmp: 4/4 applied + bảng + đúng 3 index + 16 cột đúng type · E2E POST chat sess-r21-e2e: row mới có `denseThreshold:0.3` + `sourcesEnabled{chunks:T,communities:T,entities:F,memories:F}` (đối chứng trực tiếp row R20 thiếu 2 field) · browser "THE MAGNUM OPUS" 0 lỗi console/page · check:imports PASS |

- Phát hiện: FB-D1-R1-01..08 → **BUG2-269..276** (chi tiết đầy đủ tại Bug_v2.md — mọi mức có entry).
- Sai-kỳ-vọng phía người-rà: **0** (auditor tự loại 9 nghi vấn bằng phương pháp thứ ba trước khi báo — trong đó "getTuningEnum trả undefined cho key lạ → logging OFF" là nghi vấn CRITICAL của đề bài auditor, hóa ra cờ #32 đã đăng ký đúng default 'on' + try/catch fail-open đúng chiều).
- Phát hiện bị bác sau chấm chéo: 0/8 — chuỗi thứ 6 liên tiếp phát hiện auditor đứng vững.
- Ngoài phạm vi (bàn đợt sau — đã ghi Bug_v2-269): drift schema-vs-migrations CÓ SẴN từ trước (BrainSearchRun/BrainSearchCandidate HN-P1 cũng thiếu migration) — cân nhắc migration bù/rebaseline khi triển khai EVO-P4; kết quả chi tiết fallback dense-only nằm ngoài corpus (diagnostics tool); searchModelKnowledge/writeback chưa instrument (chưa có production caller / LAYER 3 — bàn khi D3 cần).
- Bài học truyền lại: (14) **Model/schema thêm bằng db push phải kèm MIGRATION NGAY** — 2 luồng deploy (push sandbox / migrate máy user) phân kỳ âm thầm, fail-open khiến mất dữ liệu không bao giờ kêu la; (15) **ALS context merge phải lọc undefined** — spread copy key undefined là bẫy ngữ nghĩa TypeScript thông dụng (ctx build đủ key + giá trị undefined ≠ "không chỉ định key"); (16) **giới hạn "≤N KB" phải đo đúng đơn vị cam kết** (byte UTF-8 ≠ .length UTF-16 — sai 2-4× với ngôn ngữ không ASCII, chính là ngôn ngữ chính của sản phẩm).

### TỔNG KẾT LŨY KẾ (cập nhật sau FB-BRAIN-D1)

- **Phát hiện lũy kế qua giao thức: 121 + 8 = 129** (FB-BRAIN-D1: BUG2-269 G·P2 · BUG2-270/272/273/274 P3 · BUG2-271 P3 · BUG2-275/276 P4).
- Gate kiểm thử: r110 14→21 (+7 regression); full suite **1527 pass** (baseline sandbox mới 1519 + 7 test mới + 1 flaky-pass; 22 fail/13 errors pre-existing r69/r73-2 pollution — pass riêng).
- Doctrine nhắc lại (R20): mọi mốc commit + dual-push NGAY — đợt này fix xong cũng dual-push ngay sau ghi sổ.

### ĐỢT FB-OBSV3 — scope "giao thức quan sát V3 OBS-P5→P8" đợt R34 (commit 5563fc8: 21 file +1480/−85 — kinds/ledger/alerts/impact + hooks H1-H7 + r122 16 test + pin r95/r96/r99 + GIAO_THUC v1.6 + blueprint 0.2) — 2026-10-18 — KHÉP KẾT SAU 2 VÒNG (R1 auditor độc lập + coordinator chấm chéo + full-suite gate + fix 12/12 · R2 verify 0 phát hiện mới)

| Vòng | Phát hiện mới | Xác minh |
|---|---|---|
| R1 (auditor độc lập subagent Explore — mắt tươi chạy đủ C1-C8 + tính tay 5 rule/throttle/impact-window/queryHash + doctrine fail-open từng hook; coordinator chấm chéo TỪNG phát hiện bằng đọc code + thực nghiệm nhị phân + full-suite gate) | **12** (1×H·P2 · 7×P3 · 1×G·P4 · 1×C5·P3 test-gap · 2×C·P2 coordinator — BUG2-277..288) — đỉnh: H4 phát proposal.apply cho MỌI train active thay vì `active && useDraft` (ô nhiễm neo impact P7) + thiếu searchRunId kim tuyến; r122 E2 fail khi chạy CHUNG full suite (test không tự cô lập — R34 chỉ chạy theo nhóm nên không thấy); r89-E pin stale từ R25 (default ui_brain_edit 'on' — fail riêng mà lọt 9 ngày vì các đợt chạy test theo nhóm) | Fix toàn bộ 12 + **7 regression test** (r122 16→23: B2 hết-cửa-sổ · B3 map hard-cap · E6 exception-path · E7 latestError mới nhất · E8 runner no-cases end · E9 sweep end · H2 pass 2 chỉ neo evo-deploy) → eslint 0 · tsc 0 · check:imports PASS · **full suite 1985/1985 PASS 0 fail** (trước fix: 1975 pass/3 fail — r122 E2 + r89 ×2) ×2 lần chạy liên tiếp |
| R2 (coordinator mắt tươi toàn diff 13 file + quét nhanh C1-C8 toàn scope + E2E live) | **0** → KHÉP KẾT | E2E live sau pm2 restart: boot tick phát THẬT 4 alert thế hệ 2 (train-gate ×3 đếm ĐÚNG chỉ-gate 5/9/8 lần + eval-starvation 2/2+36/36) · POST eval 2 case → eval.run start+end kín cặp + kb.consult ×2 (não A calibrate 0.10/0.30 sống) · timeline API 25 kinds · browser: Smolab→BRAIN→Timeline — dropdown 26 (25 kind + Mọi loại) · filter eval.run server-side đúng (`?kind=eval.run` 200, obs.alert lọc sạch) · 0 console error · 0 page error · mobile 390 scrollW=clientW |

- Phát hiện: FB-OBSV3-R1-01..12 → **BUG2-277..288** (chi tiết đầy đủ tại Bug_v2.md — mọi mức có entry).
- Phát hiện bị bác sau chấm chéo: **2/10** của auditor (09.2 provider-degraded orderBy — code có sẵn desc; 09.4 comment cụt — đọc bị cắt dòng) + 9 sai-kỳ-vọng auditor tự bác trước khi báo; 1 sai-kỳ-vọng coordinator ("r89 fail do pollution r81" — thực ra fail cả khi riêng; lần "riêng" đầu dùng sai tên file).
- Ngoài phạm vi (bàn đợt sau — đã ghi Bug_v2-285/286): pass 2 quét lại payload mỗi tick khi có pending (precedent pass 1, bàn khi corpus lớn); H4/H5/H7 emitter-tier test trực tiếp cần train-thắng-gate/LLM-fail thật — hiện verify qua E2E live + unit tầng pure; H4 dương bản chờ Qdrant re-ingest (pending user từ RESTORE2-CREDS).
- Bài học truyền lại: (17) **Đợt deploy nào cũng phải chạy FULL SUITE qua gate tối thiểu 1 lần** — R34 chạy test theo nhóm nên 2 fail (r122 E2 chạy-chung + r89 pin stale 9 ngày) không ai thấy; "16/16 theo nhóm" ≠ "gate xanh". (18) **Test dùng DB preload-copy chung phải tự cô lập theo trục thời gian** (timestamp tương lai gần) hoặc dọn theo rule — các file khác seed cùng bảng với Date.now() luôn MỚI hơn mốc "quá khứ" của mình. (19) **Đổi default flag phải quét pin test cùng key** (grep key trong tests/) — R25 đổi default ui_brain_edit mà r89-E pin cũ đứng im 9 ngày. (20) **Kết luận "fail do pollution" phải được tái hiện bằng cặp tối thiểu ĐÚNG tên file** — dùng sai tên file cho kết quả "0 test chạy" dễ đọc nhầm thành PASS.

### TỔNG KẾT LŨY KẾ (cập nhật sau FB-OBSV3)

- **Phát hiện lũy kế qua giao thức: 129 + 12 = 141** (FB-OBSV3: BUG2-277 H·P2 · BUG2-278/282/283/284 P3 · BUG2-279/280/281 P3 · BUG2-285 P4 · BUG2-286 P3 test-gap · BUG2-287/288 C·P2 coordinator).
- Gate kiểm thử: full suite **1985 pass / 0 fail** (baseline mới — 1978 + 7 test mới; 3 fail cửa trước đã hết), eslint 0 · tsc 0 · check:imports PASS.
- Doctrine nhắc lại: mốc commit + dual-push NGAY sau ghi sổ (đợt này cũng vậy).

### ĐỢT FB-EE — scope triển khai BLUEPRINT-EXECUTION-EFFICIENCY-P1-P8 W1+W2 (commit 3641f90, 16 file +895/−53 — S1-S8) — 2026-10-19 — KHÉP KẾT SAU 2 VÒNG

| Vòng | Phát hiện mới | Xác minh |
|---|---|---|
| R1 | **11** (1 E·P2 + 5 P3 + 5 P4) — auditor A (S1+S2) + auditor B (S3+S8) chạy song song độc lập, main tự audit S4-S7 (auditor C chết vì max-turns sau outage 429 MCP — môi trường, không phải lỗi hệ TMO); mọi nghi vấn chấm chéo C2 bằng code trực tiếp + live-test DB thật (LIKE wildcard '%' match 6/6 tái hiện trước khi fix) | Fix toàn bộ 11 + regression r103 (14 test mới: matching 2 chiều · verdictBudget guard · subRunId render + source-scan 5 điểm GHI · numbering tuần tự · survivor dedupe theo runId · sanitizeLikeQuery) → gate full-suite **2009/0 fail** (66.217 expect) + tsc 0 + eslint 0 + check:imports PASS; live sau fix: '%' → 0 hits (trước 6/6), query tên đầy đủ vẫn 1 hit (KPI §6 hàng 1 giữ nguyên) |
| R2 | **0** — rà lại TOÀN BỘ scope kể cả phần vừa fix: review full diff (+258/−69), quét stale trace (break_like_empty / merged<topK / z-ai prefix trong REASONING_MODELS = 0 sót), S4.2 batching + evaluator rule 19 verify chi tiết, pm2 restart nạp code mới (cold-compile self-exit 1 lần như PLAYBOOK — bình thường), health healthy, browser smoke 0 page error + 0 console error + UI render đủ module | — |

- Phát hiện: FB-EE-A-R1-01..07 + FB-EE-B-R1-01..07 → **BUG2-289..299** (11 fix) + 1 ghi nhận không-fix (A-R1-06 prefix query 5/6 — hành vi đúng thiết kế take topK) + 1 giải tỏa (B-R1-07 Todo schema priority/status hợp lệ 100% — sai kỳ vọng auditor).
- Đáng chú ý nhất: **BUG2-289 (E·P2)** — tracker `delegationArtifacts` là dead-code vì `subRunId` bị DROP tại 5 điểm GHI tool result → S8 fallback deterministic không bao giờ có artifact refs ("nơi lấy đầy đủ" đúng kịch bản LLM chết). Fix: lộ subRunId đủ 5 đường (delegate_task / dispatch_agent / escalate autoApplied / runDispatchTask / fanout + type DispatchResult).
- **Lỗi fix-of-fix bắt trong chính vòng R1** (dữ liệu chống tự tin): bản đầu sanitizeLikeQuery thay wildcard bằng space — query '%' thành ' ' vẫn match mọi tên có space (6/6 như cũ); vá ngay bằng trim + guard rỗng + unit test chặn.
- Sai kì vọng phía người rà: 3 (auditor A tự bác survivor double-append + spec score 0.4; B-R1-07 giải tỏa qua schema) — lần 18.
- Sự cố môi trường phiên này: 3 subagent audit song song (~370K tokens) → MCP server 429 → tool layer chết 2 lần (~40 phút + ~25 phút) + preview panel hiện ResourceExhausted container concurrency (xác nhận app vô can: pm2 2/2 + HTTP 200 0.07s + health healthy ngay tại thời điểm lỗi). Bài học vận hành cho chính giao thức fixbug: auditor độc lập CHẠY TUẦN TỰ, không song song 3 (đã ghi PLAYBOOK).
- Nghiệm thu: không việc hoãn nào trong scope. W3 (P8 nền: 8a transaction retry · 8b NIM utility backup · 8c Qdrant re-ingest 868 chunk · 8d chính sách model evaluator dài hạn) ngoài scope đợt này theo thiết kế blueprint §5 — chờ user quyết.
