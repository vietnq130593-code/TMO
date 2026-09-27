# CHUẨN TRÌNH BÀY TRẠNG THÁI AGENT — MÀN HÌNH HỘI THOẠI

Phạm vi: màn hình Hội thoại (module Smolab — `src/components/smolab/smolab-module.tsx`).
Vị trí áp dụng: pill badge trạng thái đặt cạnh tên agent trong header, luôn hiển thị.

## 1. Nghĩa và tiêu chí chuyển trạng thái

Năm trạng thái, mỗi trạng thái trả lời một câu hỏi duy nhất: "người dùng gửi tin nhắn tiếp theo thì có được phản hồi không, và mất bao lâu?"

- ACTIVE (Đang hoạt động) — kết nối sống, không có tác vụ đang chạy, sẵn sàng nhận yêu cầu. Tiêu chí vào: có kết nối WebSocket/SSE mở VÀ không có run nào ở trạng thái running.
- IDLE (Đang rảnh) — chưa từng kết nối, hoặc kết nối đã đóng sạch. Tiêu chí vào: không có kết nối mở VÀ không có run nào. Đây là trạng thái mặc định khi mở màn hình.
- BUSY (Đang bận) — có run đang thực thi (streaming token, gọi tool, chờ kết quả bước trung gian). Tiêu chí vào: tồn tại run có status running. BUSY là trạng thái có tính thời gian, ghi đè ACTIVE/IDLE.
- ERROR (Lỗi) — lần chạy gần nhất thất bại (run status error, tool crash, timeout). Tiêu chí vào: run gần nhất kết thúc với lỗi VÀ chưa có run mới thành công. Hết trạng thái này khi người dùng gửi tin nhắn mới (chuyển BUSY) hoặc kết nối lại thành công (ACTIVE/IDLE).
- OFFLINE (Ngoại tuyến) — mất kết nối ngoài ý muốn (mạng rớt, agent tắt, hết phiên). Tiêu chí vào: đang chờ hoặc từng có kết nối nhưng hiện không nhận được heartbeat.

Thứ tự ưu tiên quyết định: OFFLINE và ERROR là trạng thái chặn, ghi đè BUSY. BUSY ghi đè ACTIVE và IDLE. Còn lại thì ưu tiên kết nối: có kết nối thì ACTIVE, không thì IDLE. Không để xảy ra hai nhãn cùng lúc.

## 2. Bảng màu

Mỗi trạng thái dùng ba màu: màu chữ nhãn, màu nền pill, màu viền. Tất cả tổ hợp đều đạt tương phản WCAG AA đối với chữ 12px trở lên.

| Trạng thái | Chữ | Nền | Viền | Icon |
|---|---|---|---|---|
| ACTIVE | #15803D | #DCFCE7 | #22C55E | Dấu tích tròn đặc |
| IDLE | #475569 | #F1F5F9 | #94A3B8 | Vòng tròn rỗng |
| BUSY | #92400E | #FEF3C7 | #F59E0B | Mũi tên xoay / spinner |
| ERROR | #991B1B | #FEE2E2 | #EF4444 | Dấu chấm thanh trong tam giác |
| OFFLINE | #374151 | #E5E7EB | #6B7280 | Đường kẻ chéo tròn |

Quy ước: màu viền dùng cho chấm trạng thái 8px và đường viền pill 1px; màu nền chỉ dùng cho thân pill.

## 3. Quy tắc pill badge

- Hình dạng: pill bo tròn, chiều cao 22px, nội dung theo thứ tự ICON + CHỮ.
- Vị trí: ngay sau tên agent trong header, cách tên 8px, cùng một dòng, không bao giờ xuống dòng.
- Nhãn chữ tiếng Việt, Title Case dạng "Đang hoạt động", "Đang rảnh", "Đang bận", "Lỗi", "Ngoại tuyến". Khi header quá hẹp, giữ icon và rút nhãn còn trạng thái ngắn ("Hoạt động", "Rảnh", "Bận", "Lỗi", "Ngoại tuyến").
- Luôn hiển thị — kể cả khi rảnh. Ẩn hẳn pill sẽ phá vỡ mục tiêu quét nhanh.
- Cập nhật tức thời theo sự kiện run bắt đầu / run kết thúc / heartbeat mất. Không chờ polling dài hơn 1 giây.
- Màu KHÔNG phải tín hiệu duy nhất: luôn có icon khác nhau theo trạng thái và luôn có chữ. Người mù màu vẫn đọc được.
- Trạng thái chặn (ERROR, OFFLINE) kèm một hành động nhỏ bên phải pill: "Thử lại" cho OFFLINE, "Xem lỗi" cho ERROR.

## 4. Icon và tooltip chuẩn

| Trạng thái | Tooltip |
|---|---|
| ACTIVE | "Agent đang kết nối và sẵn sàng phản hồi." |
| IDLE | "Agent đang kết nối và chờ yêu cầu mới." |
| BUSY | "Agent đang xử lý yêu cầu, phản hồi có thể bị chậm." |
| ERROR | "Lần xử lý gần nhất gặp lỗi. Gửi tin nhắn mới để thử lại." |
| OFFLINE | "Không liên lạc được với agent. Kiểm tra mạng hoặc khởi động lại agent." |

Hỗ trợ bàn phím bắt buộc:
- Pill là phần tử focusable (tabindex 0) với role="status" và aria-label chứa đầy đủ tên trạng thái cộng với nội dung tooltip.
- Di chuột hoặc nhấn Tab vào pill đều mở tooltip sau 300ms (hover 0, focus tức thì); Escape hoặc rời focus thì đóng.
- Tooltip không được là nguồn thông tin duy nhất: mọi nội dung trong tooltip phải suy ra được từ icon + chữ.

## 5. Công bố qua vùng thông báo trình đọc màn hình

- Mỗi pill đặt trong một vùng sống role="status" aria-live="polite" (lỗi dùng aria-live="assertive").
- Mọi lần chuyển trạng thái đều phát thông điệp dạng: "Trạng thái agent SIVIL: Đang bận."
- Thông điệp chỉ phát khi trạng thái thực sự thay đổi, không phát lặp lại mỗi lần render hoặc mỗi token streaming.
- Khi trạng thái chuyển sang chặn, vùng thông báo phải chứa luôn gợi ý hành động: "Đang ngoại tuyến. Dùng nút Thử lại để kết nối lại."

## 6. Ví dụ, lý do chọn Hội thoại, ghi chú mở rộng

Ví dụ mặc định: khi mở màn hình Hội thoại, header hiển thị "SIVIL" kèm pill nền xám, chữ xanh xám, vòng tròn rỗng, nhãn "Đang rảnh". Người dùng gửi tin nhắn, pill đổi sang nền hổ phách, icon xoay, nhãn "Đang bận", thông báo đọc màn hình phát ra. Khi run kết thúc, pill trở lại "Đang hoạt động" màu xanh. Nếu agent tắt, pill chuyển "Ngoại tuyến" kèm nút "Thử lại".

Lý do chọn Hội thoại làm màn hình triển khai trước: đây là nơi người dùng chờ phản hồi theo thời gian thực nên trạng thái quyết định trải nghiệm; đồng thời màn hình này hiện chỉ thể hiện trạng thái bằng chữ, thiếu tín hiệu quét nhanh, và chưa có thông báo cho trình đọc màn hình — ba điểm rủi ro cao nhất trong bốn màn hình.

Ghi chú mở rộng: bộ năm trạng thái, bảng màu và cấu trúc pill này là chuẩn dùng chung. Khi áp dụng cho Danh sách agents, Tự chủ và Công cụ:
- Giữ nguyên tên, màu, icon, tooltip để người dùng học một lần dùng mọi nơi.
- Danh sách agents: mỗi dòng agent mang một pill cùng chuẩn, thay cho huy hiệu màu lẻ hiện tại.
- Tự chủ và Công cụ: nếu một màn hình hiển thị nhiều agent cùng lúc, dùng bảng tóm tắt hoặc sắp xếp theo trạng thái thay vì nhân bản pill ở mọi nơi.
- Chỉ hiển thị trạng thái thật sự dùng để ra quyết định; nếu một màn hình không cần trạng thái theo thời gian thực thì bỏ qua thay vì thêm trạng thái giả.
