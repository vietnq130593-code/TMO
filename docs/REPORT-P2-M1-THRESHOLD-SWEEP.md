# BÁO CÁO P2-M1 · ROC/PR THRESHOLD SWEEP — BẢNG NGƯỠNG NỘP USER DUYỆT

> **Trạng thái: CHỜ PHÊ DUYỆT** — sinh 2026-10-10 bởi `GET /api/eval/threshold-sweep`
> (blueprint `BLUEPRINT-STATS-LEARNING-P0-P6.md` §P2-M1, mục #6 — ML.pdf §Evaluation Curves)
>
> **NGUYÊN TẮC:** KHÔNG hằng số nào bị đổi cho tới khi user duyệt từng dòng.
> Khi duyệt: hằng số được đổi kèm comment `swept 2026-10-10, n=…, precision/recall đạt`
> (tiền lệ option-b của `CONFIDENCE_THRESHOLD`).

---

## 0 · Phương pháp

- `sweepThresholds` (stats P0-1): mỗi score quan sát được = 1 ngưỡng; predicted
  positive ⇔ score ≥ threshold; precision/recall/F1/TPR/FPR tại từng ngưỡng.
- AUC-ROC (hình thang, neo gốc) + AUC-PR (step-wise Davis–Goadrich).
- 3 tiêu chí khuyến nghị: `max_f1` · `precision ≥ 0.9` (ngưỡng nhỏ nhất đạt —
  max recall trong ràng buộc) · `recall ≥ 0.9` (ngưỡng lớn nhất đạt — max
  precision trong ràng buộc).
- Mốc cố định 0.05–0.95 (bước 0.05) để đọc nhanh không cần nội suy.
- Evaluator: score = `ArbiterVerdict.confidence`, actual = `runComplete`
  (resolved) — cùng nguồn P1-M1 verdict-scorecard.
- KB: score = `EvalResult.rawConfidence` (TRƯỚC calibration), actual =
  `faithfulnessMedian > 0.7` (đúng Y calibration hiện tại).
- Đối chiếu độc lập: test `tests/r77-threshold-sweep.test.ts` (14 test, AUC-PR
  khớp computeVerdictScorecard trên cùng seed — kiểm chứng "AUC khớp P1-M1").

---

## 1 · EVALUATOR CONFIDENCE (cửa sổ 60 ngày)

**Dữ liệu thật hiện có: n = 2** (2 ArbiterVerdict resolved: conf=0.90 + conf=0.85, cả hai runComplete=true; làm mới 15:53 UTC sau vòng fixbug R2).

| Ngưỡng | Precision | Recall | F1 | TPR | FPR |
|---|---|---|---|---|---|
| 0.90 | 1.000 | 0.500 | 0.6667 | 0.500 | 0.000 |
| 0.85 | 1.000 | 1.000 | 1.000 | 1.000 | 0.000 |

AUC-PR = 1.0000 · AUC-ROC = *null* (0 negative thật — không có cặp T/F nào để xếp hạng)

Khuyến nghị (kỹ thuật): max_f1 → **0.85** · precision≥0.9 → **0.85** · recall≥0.9 → **0.85**

> **KẾT LUẬN: KHÔNG ĐỦ DỮ LIỆU ĐỀ NGHỊ ĐỔI.** n=2 toàn positive — mọi tiêu chí
> đều "đạt" trên 2 mẫu dương, chưa có một negative (FP) nào để đo độ tin của
> lời tuyên bố complete. Hằng số liên quan giữ nguyên cho tới khi ≥ 30 verdict
> resolved có CẢ hoàn thành lẫn thất bại (ước lượng Wilson: n=30, p=0.8 →
> CI width ≈ 0.28 — đủ hẹp để so ngưỡng).

Hằng số đang chờ dữ liệu (KHÔNG đổi bây giờ):

| Hằng số | Vị trí | Giá trị hiện tại | Quyết định đề xuất |
|---|---|---|---|
| Evaluator confidence clamp (complete=false → tối đa) | `agent-goal-loop.ts` (ROUND-8 AUDIT) | **0.3** | GIỮ NGUYÊN — chờ n ≥ 30 |

---

## 2 · KB CONFIDENCE (toàn bộ EvalResult)

**Dữ liệu thật hiện có: n = 4** (positives = 1):

| raw | faith | actual |
|---|---|---|
| 0.3000 | 0.0 | F |
| 0.3000 | 1.0 | T |
| 0.3696 | 0.0 | F |
| 0.6165 | 0.0 | F |

Đường cong tại score quan sát được:

| Ngưỡng | Precision | Recall | F1 | TPR | FPR |
|---|---|---|---|---|---|
| 0.6165 | 0.000 | 0.000 | 0.000 | 0.000 | 0.333 |
| 0.3696 | 0.000 | 0.000 | 0.000 | 0.000 | 0.667 |
| 0.3000 | 0.250 | 1.000 | 0.400 | 1.000 | 1.000 |

AUC-PR = 0.2500 · AUC-ROC = 0.1667

Mốc cố định (rút gọn):

| Ngưỡng | 0.1 | 0.2 | 0.3 | 0.4 | 0.5 | 0.6 | 0.7 | 0.8 | 0.9 |
|---|---|---|---|---|---|---|---|---|---|
| Precision | 0.25 | 0.25 | 0.25 | 0 | 0 | 0 | 0 | 0 | 0 |
| Recall | 1.00 | 1.00 | 1.00 | 0 | 0 | 0 | 0 | 0 | 0 |

Khuyến nghị (kỹ thuật): max_f1 → **0.30** (P=0.25, R=1.0) · precision≥0.9 →
**không đạt** · recall≥0.9 → **0.30**

> **KẾT LUẬN: KHÔNG ĐỦ DỮ LIỆU ĐỀ NGHỊ ĐỔI.** n=4 với 1 positive — mẫu anticorrelation
> hiển nhiên (positive duy nhất nằm ở raw=0.30, thấp nhất) nhưng vô nghĩa thống kê;
> sweep max_f1 đề xuất 0.30 < 0.5 hiện tại là NGHỊCH lý thuyết (lowering threshold
> tăng fallback Model-Knowledge) trên 4 mẫu — cấm act. Giữ nguyên
> `CONFIDENCE_THRESHOLD = 0.5` cho tới khi ≥ 30 EvalResult (cả 2 lớp đủ đại diện,
> mỗi lớp ≥ 10).

| Hằng số | Vị trí | Giá trị hiện tại | Quyết định đề xuất |
|---|---|---|---|
| `CONFIDENCE_THRESHOLD` | `src/lib/kb-routing/kb-access.ts:44` | **0.5** | GIỮ NGUYÊN — chờ n ≥ 30 (≥10/lớp) |

---

## 3 · SHR PROMOTE/DEMOTE POSTERIOR — CHỜ DỮ LIỆU

Blueprint §P2-M1: SHR cần dữ liệu HypothesisRecord đã đối chứng (status
promoted/demoted sau đối chứng) đủ nhiều — v1 **chưa sweep**.

| Hằng số | Vị trí | Giá trị hiện tại | Quyết định đề xuất |
|---|---|---|---|
| `PROMOTE_POSTERIOR` | `structured-hypothesis.ts` | **0.80** | CHỜ DỮ LIỆU (cần hypothesis đã đối chứng) |
| `DEMOTE_POSTERIOR` | `structured-hypothesis.ts` | **0.35** | CHỜ DỮ LIỆU |

---

## 4 · CƠ CHẾ TÁI SWEEP

- Route read-only chạy lại bất cứ lúc nào:
  `GET /api/eval/threshold-sweep?target=evaluator_confidence&windowDays=60`
  `GET /api/eval/threshold-sweep?target=kb_confidence`
- Đề nghị nhịp: sau mỗi đợt eval run mới hoặc mỗi ~30 verdict resolved,
  tái sinh báo cáo này rồi mới duyệt.
- Khi user duyệt đổi hằng số: kèm regression test chặn giá trị cũ
  (`r77-threshold-updates.test.ts` — bước 5 blueprint §P2-M1).

## 5 · BẢNG PHÊ DUYỆT (user điền)

| # | Hằng số | Giá trị đề xuất mới | Duyệt? (Y/N) | Ghi chú user |
|---|---|---|---|---|
| 1 | Evaluator clamp 0.3 | *(chờ dữ liệu)* | ☐ | |
| 2 | `CONFIDENCE_THRESHOLD` 0.5 | *(chờ dữ liệu)* | ☐ | |
| 3 | `PROMOTE_POSTERIOR` 0.80 | *(chờ dữ liệu)* | ☐ | |
| 4 | `DEMOTE_POSTERIOR` 0.35 | *(chờ dữ liệu)* | ☐ | |
