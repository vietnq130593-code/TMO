# BÁO CÁO NỢ KỸ THUẬT (DebtLedger R13)

Nguồn dữ liệu: db_query trên bảng DebtLedger (rowCount=9 — số máy) + GoalLoopJob (rowCount=1) + todo_read phiên.

## TỔNG SỐ: 9 NỢ MỞ (theo DebtLedger)

## Chi tiết nợ đã xác minh

| # | ID | Loại | Nội dung | Trạng thái | Mức độ |
|---|-----|------|----------|------------|--------|
| 1 | cmvh05wqp000gsnrhdhdvkqz6 | infra | Tool shell thất bại lặp ≥3 lần — TỪ CHỐI (infra-guard, chạm db/ bảo vệ) | open | high |
| 2 | cmvh05wqe000fsnrhnlhoctmp | infra | Cùng fingerprint với #1 — bản ghi trùng | open | high |
| 3 | cmvgtomjp0000snbbs4o4nu3j | infra | Run Omega crashed (salvage) — mồ côi 83 phút, không finalize | in_progress | high |
| 4 | cmvgsazz8009bsnmbnd941vfo | infra | Shell infra-guard — lần 3 cùng pattern | open | high |
| 5-9 | (5 nợ còn lại) | infra | Chi tiết trong DB — pattern shell-guard/crash | open | high |

Lưu ý: #1 và #2 trùng fingerprint — số nợ THỰC SỰ KHÁC BIỆT khoảng 8.

## Nợ phiên hiện tại (đÃ XỬ LÝ)

- cmvhuhmba004lnh2xsuqjmy43 — shell bị chặn vì chạm db/ được bảo vệ → ĐÃ kiểm chứng thay thế bằng db_query (read-only) chạy được. ĐÃ ĐÓNG.

## 2 nợ hệ thống cũ (PARKED — đã thử 3+ lần không giải quyết được)

1. MEGATRON crash (salvage) — cmvhv8b3800brnh2xt8hlufpk — process chết giữa chừng, không finalize được. Điều kiện cần: không thể revive process đã chết; preventive = checkpoint/finalize logic cho run sau.
2. Goal-loop orphan — cmvhv8b3900bsnh2xy8ff5knv — attempts cạn sau crash server. Bằng chứng DB: GoalLoopJob id=cmvgdo1er000csn10j1bkrfo3, status=failed, attempts=2, error="job mồ côi sau crash — vượt số lần thử tối đa (2)", startedAt=2026-10-20T07:44:38.611Z. Điều kiện cần: cơ chế auto-recovery / dead-letter queue.

## Đánh giá khả năng xử lý

- Shell infra-guard (chạm db/, .env...): KHÔNG tự xử lý được — chạm vùng hạ tầng được bảo vệ. Điều kiện cần: phê duyệt operator cho truy cập hạ tầng. Giải pháp thay thế hiện có: db_query (read-only).
- Crash/mồ côi (Omega, MEGATRON): KHÔNG — sự kiện quá khứ, không revive được.
- Goal-loop orphan: KHÔNG — job failed vĩnh viễn, cần cơ chế recovery mới.

## Đề xuất

1. Dọn bản ghi trùng fingerprint (gộp #1+#2) — giảm noise sổ nợ.
2. Tạo automation cron định kỳ quét GoalLoopJob status=failed → alert/retry.
3. Preventive: bắt buộc todo_write finalize trước khi kết thúc run (tránh mồ côi).
4. Quy tắc vận hành: mọi truy vấn DB dùng db_query (read-only guard), KHÔNG dùng shell trên db/.
