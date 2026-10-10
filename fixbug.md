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

### TỔNG KẾT LŨY KẾ 5 ĐỢT (FB-P0 → FB-ĐỢT5)

- **23 phát hiện** thu nhận qua giao thức — 22 fix ngay trong đợt + 1 (BUG2-043) chốt bằng user decision; **100% có entry Bug_v2.md** sau tái cơ cấu (BUG2-039..043 tạo/sự-kiện khi chạy + BUG2-044..061 bổ sung đủ).
- Mọi đợt khép đúng nhịp **3 vòng** (R3 luôn 0 phát hiện mới) — chưa đợt nào chạm trần 5 vòng của ràng buộc an toàn.
- **22 phép sai-kỳ-vọng-phía-người-rà** ghi nhận qua 5 đợt (FB-P0: 11 · FB-P1: 1 · Đợt3: 1 · Đợt4: 6 · Đợt5: 3) — chuỗi tái bản dài tới "lần 8" (đợt 5), xác nhận giá trị quy tắc chấm chéo 3 phía (C2).
- Gate kiểm thử tăng đều: **644 → 671 → 683 → 722 → 802** test (mỗi fix kèm regression — không nợ xác minh).
