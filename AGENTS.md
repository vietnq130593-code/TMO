# TMO — Project Instructions (áp dụng mọi agent chạy qua OpenCode CLI trong workspace này)

## Định dạng câu trả lời cuối cho người đọc (BẮT BUỘC)

Báo cáo/phản hồi cuối gửi cho người dùng là ngôn ngữ TIẾNG VIỆT, văn xuôi sạch, markdown TỐI THIỂU:

- KHÔNG bọc nhấn mạnh bằng `**` hay `__` — nhấn mạnh bằng CHỮ IN HOA.
- KHÔNG bọc từ ngữ/tên file/tên lệnh bằng dấu `` ` `` hay dấu `'` tràn lan — chỉ trích dẫn khi thật sự cần phân biệt mã.
- KHÔNG dùng heading `##` cho câu trả lời ngắn — chỉ dùng khi báo cáo dài nhiều phần.
- Liệt kê bằng gạch đầu dòng `- `.
- Chỉ dùng khối code fence khi trích dẫn mã/command output thật.

Lý do: giao diện người dùng hiển thị báo cáo dạng văn xuôi — ký tự markdown dày đặc làm nội dung rối mắt.

## Tools & phạm vi thao tác (BẮT BUỘC — infra guard)

Native bash/edit/write của CLI bị TẮT (opencode.json permission). Dùng bridge tools của TMO thay thế:

- Chạy lệnh: tmo_shell (thay bash) — mọi lệnh qua server, có audit.
- Đọc file: tmo_file_read, tmo_grep, tmo_file_list.
- Viết/sửa file: tmo_file_write, tmo_file_edit (thay write/edit native).
- Kế hoạch: tmo_todo. Giả thuyết: tmo_hypothesis. Tìm kiếm: tmo_web_search, tmo_knowledge_search.

HẠ TẦNG RUNTIME bị chặn ghi qua shell/file tools (server sẽ TỪ CHỐI): package.json, lockfiles, prisma/, db/, .env, .opencode/, opencode.json, mini-services/, Caddyfile, và mọi lệnh cài/gỡ package (bun add, npm install...) hoặc prisma migrate/db push khi chạy trong workspace TMO.

- Nếu task THẬT SỰ cần cài/gỡ package: dùng tool manage_packages (đường chính thức, có audit) và chỉ khi task yêu cầu rõ ràng.
- Nếu cần sửa schema/.env/hạ tầng khác: dùng tmo_escalate trình bày lý do + thay đổi cụ thể để operator phê duyệt — KHÔNG tự làm, KHÔNG tìm cách lách.
- Code mới viết vào src/ hoặc thư mục task chỉ định — đọc thoải mái mọi nơi.
- KHÔNG git commit/push/self-modify hệ thống khi task chỉ yêu cầu đọc/kiểm tra/báo cáo.

