# BÁO CÁO ĐÁNH GIÁ TỔNG THỂ DỰ ÁN TMO

Ngày lập: 27/09/2026 · Phạm vi: chỉ đọc, không sửa mã nguồn, không sửa dữ liệu, không chạy migration.

## 1. Kiến trúc hệ thống qua lớp src/lib

Quy mô đo bằng máy: 237 file .ts/.tsx, 108.987 dòng, 71 file nằm trực tiếp ở src/lib, cộng 23 thư mục con. Phân bố theo lớp chức năng:

- Lõi agent và điều phối: research-team (52 file — lớp lớn nhất, chứa NEMESIS/SIVIL/BELI/LISMA/HAN), code-team (12 file — MEGATRON/SHOCWAVE/RAMPAGE/SENTINEL/CATALYST), orchestration (6), thinking (6), execution (2), self-direction (2).
- Tri thức và ghi nhớ: kb-routing (11), episodic-memory (9), learning (6), ingestion (2), backup (2).
- Vận hành và giám sát: alista (8), workspace (8), error-handling (8), eval (2), redteam (3), security (2), intake (5), smolab (2), riva (1), mcp (1), cron (1), communication (5), state-management (4), opus (6), opus/dossier.

Điểm vào hệ thống là tầng Next.js app router đọc xuống src/lib, còn src/lib đóng vai trò tầng nghiệp vụ dùng chung. Xu hướng đáng chú ý: 64 file tập trung ở hai thư mục team, còn lớp vận hành (alista, error-handling, eval) mỏng hơn nhiều so với lớp điều phối.

Giới hạn của hạng mục này: khảo sát dựa trên cây thư mục và số đếm máy, chưa đọc hết nội dung 108.987 dòng; phần cần lưu ý khi họp là ranh giới trách nhiệm giữa orchestration và từng team.

## 2. Rà soát src/components/smolab/markdown-text.tsx

Chất lượng tổng thể tốt cho một renderer tự viết. Đây là 383 dòng, không phụ thuộc thư viện ngoài, không dùng dangerouslySetInnerHTML nên React tự escape toàn bộ text — an toàn XSS ở mức cấu trúc. Phần bảo mật link làm đúng: chỉ nhận URL bắt đầu bằng http:// hoặc https://, so khớp không phân biệt hoa thường, chặn URL chứa khoảng trắng, và luôn gắn target _blank kèm rel noopener noreferrer.

Lỗi tiềm ẩn và rủi ro cần nêu trong họp:

- Dòng 240-241: tìm đóng ngoặc bằng indexOf(')', ...) nên link chứa ngoặc trong URL (ví dụ dạng wikipedia /a_(b)) bị cắt cụt, sinh URL sai.
- Dòng 41: tách cột bảng bằng split('|') không xử lý dấu | được escape, nên ô bảng chứa ký tự này bị vỡ thành nhiều cột.
- Dòng 250 (vùng render link): khoá React sinh theo dạng keyPrefix + hậu tố a + seq mà không tăng seq, có khả năng trùng khoá giữa các link liên tiếp trong cùng đoạn — cần kiểm chứng thêm bằng test.
- Không có useMemo hay useMemo tương đương (grep không ra kết quả) nên toàn bộ cây render dựng lại mỗi lần component render; với báo cáo agent dài thì đây là điểm nghẽn.
- Bảo trì: 383 dòng regex tự viết thay cho thư viện chuẩn là khoản nợ dài hạn, mỗi edge case markdown mới đều phải vá tay.

Chưa kiểm chứng: hành vi thực tế của các lỗi trên (chưa chạy test), và ảnh hưởng hiệu năng (chưa đo).

## 3. Database: số agent và danh sách team

Truy vấn chỉ-đọc trên db/custom.db (3.903.488 byte) cho kết quả: 13 agent, tất cả 13 đều bật, 0 agent bị tắt. Chia theo ba nhóm:

- code: 5 agent — MEGATRON (TL), SHOCWAVE (G1), RAMPAGE (G2-A), SENTINEL (G2-B), CATALYST (G3)
- research: 5 agent — NEMESIS (TL), SIVIL (G1), BELI (G1), LISMA (G2), HAN (G3)
- standalone: 3 agent — Omega, Opus, ALISTA

Toàn bộ 13 agent dùng provider zen. Cấu trúc nhóm khá cân bằng, không có agent treo hoặc bị tắt.

## 4. Hai cải tiến quan trọng nhất

Cải tiến 1 — thay renderer markdown tự viết bằng thư viện chuẩn có sanitize.
Cơ sở: 383 dòng regex tự viết trong markdown-text.tsx, đã lộ ít nhất 4 điểm yếu (link có ngoặc, dấu | trong bảng, khoá React, không memo). Thay bằng react-markdown kèm rehype-sanitize giữ nguyên tính năng fence/heading/list/table/link nhưng giao phần sanitize và edge case cho thư viện được kiểm thử. Tác động cao, công sức trung bình, rủi ro thấp vì component chỉ có vài nơi dùng.

Cải tiến 2 — siết chất lượng kiểm định bằng test tập trung vào các đường nguy hiểm.
Cơ sở: repo có 6 file test trong khi có 237 file thư viện và 72 component React; trong khi đó lớp nghiệp vụ nguy cập nhất cận dữ liệu người dùng và vận hành agent lại rộng. Ưu tiên test cho: parse markdown (bảng, link, code fence), chặn URL không phải http/https, và truy vấn chỉ-đọc vào database. Tác động cao, công sức thấp nếu bắt đầu từ một bộ ca lõi.

Hai cải tiến này bổ sung cho nhau: giảm diện tích bề mặt lỗi ở frontend và tăng khả năng phát hiện hồi quy ở lớp nghiệp vụ.

## Phần bằng chứng

- Số đếm src/lib: lệnh find + wc -l cho 237 file, 108.987 dòng, 23 thư mục con có nội dung.
- Quy mô file: markdown-text.tsx 383 dòng; grep trực tiếp trên file cho các mẫu then chốt ở dòng 41, 240-241, 250, 326.
- Database: truy vấn chỉ-đọc bằng Python sqlite3 với URI mode=ro trên db/custom.db, kết quả 13/13/0 và ba nhóm 5/5/3.
- Chất lượng test: đếm 6 file test, đếm 72 file .tsx trong src/components.
