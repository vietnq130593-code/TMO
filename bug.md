# BUG.MD — SỔ GHI NHẬN VẤN ĐỀ QUAN SÁT AGENTS (GHI NGAY TẠI CHỖ, KHÔNG HOÃN)

> **Phiên quan sát:** bắt đầu 2026-10-08T15:02:54Z (mốc log: dòng 1950 `mission-watch-live.log`)
> **Đối tượng:** Mission `cmuznvkl1000nll50th6b136k` — Omega (TL) + sub-agents, session `agent_1791447938659_4x5wxb`, model `space-bunny-free` (zen)
> **Directive (UI, 82 ký tự):** "Tiếp tục triển khai các đề xuất khắc phục và các phần việc chưa hoàn thành cho tôi" — tiếp nối mission #18 (dừng `verdict_stagnation` 09:25Z sau 4.0M tokens)
> **Ngữ cảnh hệ thống:** HEAD `191c920` (r67) — lần ĐẦU TIÊN mission thật chạy qua: parser 6 dạng + delegation gate + DATA MAP + detector tiếng Việt
> **Phạm vi quan sát:** từ đầu run (14:58:23Z, evt0) đến khi mission chuyển trạng thái terminal — mọi vấn đề thấy được ở TỪNG BƯỚC đều ghi vào đây NGAY LẬP TỨC
>
> **Phân loại:** A=tool-call parse · B=kỷ luật thực thi · C=trọng tài/evaluator · D=ngôn ngữ · E=output/context · F=DB bộ nhớ/data-map · G=hạ tầng/vệ sinh · H=quy trình giám sát
> **Mức độ:** P0 = chặn nhiệm vụ/sécurity · P1 = sai hành vi hệ thống cần fix cấu trúc · P2 = hở cơ chế, tốn tài nguyên · P3 = vệ sinh/cosmetic

---

## CÁC MỤC GHI NHẬN

### BUG-001 · A · P2 · 14:58:36Z · Omega it1 — Dạng tool-call méo THỨ 7 `br>{</name>` KHÔNG parse được, detector im lặng với dạng này
- **Hiện tượng:** output chứa `br>{</name> "todo_write", "arguments": {"sessionId":…}}` — JSON body hợp lệ nhưng bị dính rác tiền tố `br>{</name>` (biến thể cụt của khối invoke/fn-call).
- **Bằng chứng:** `agent-runs/run_1791471503465_1.jsonl` evt3 (`re_1791471516079_4`); evt4 kế tiếp = "Lượt output THUẦN VĂN BẢN (0 tool call, lần 1/2)" → tool KHÔNG execute, KHÔNG có MALFORMED feedback kèm skeleton đúng tool.
- **Đánh giá:** 6 dạng r66/r67 không phủ dạng này; tầng F2 `extractNativeJsonBodyCalls` tìm body JSON TRẮNG nhưng `{` dính kèm `</name>` ngay sau → JSON.parse fail → không salvage (body không đứt mà là NHIỄM tiền tố). Mất 1 iteration bằng nudge generic. Cần tầng "làm sạch tiền tố rác trước `{`" + detector nhận biết dấu `</name> "toolname"` làm sign MALFORMED.
- **Liên kết cụm cũ:** cụm 1 (tool-call đứt/méo).

### BUG-002 · A · P3 · 14:58→15:03 · Nhiều dạng méo liên tục từ provider — hệ thống phục hồi được 5/6 nhưng nguồn phát sinh chưa trị được
- **Hiện tượng:** trong 5 phút đầu, model phát tool-call ở các dạng: `TỠI_CALL> {"name":…}` (evt5, ✓execute), `tt>tout {"name":…}` (evt9, ✓), `content>{"sessionId":…` đứt giữa chừng (evt12 → MALFORMED lần 1/2, phải phát lại), `_call: todo_write({…})` (evt23, ✓), `tool_call: file_read({…})` (15:02:33, ✓), `todo_write">{…}` (evt49, ✓ nhờ tầng tag-direct r66).
- **Bằng chứng:** các evt nêu trên + mission-watch-live.log 14:58:43→15:02:33.
- **Đánh giá:** đây là hành vi provider `space-bunny-free` (đã kết luận r66: không phải maxTokens). Tầng recovery r66/r67 đang giữ hệ thống sống (5/6 không mất iteration), nhưng mỗi dạng MỚI (xem BUG-001) là rủi ro lọt im lặng. Ghi nhận để theo dõi mật độ theo thời gian.
- **Liên kết cụm cũ:** cụm 1.

### BUG-003 · A · P1 · 14:58:43→15:02:43 · Tool-call text LỘT VÀO KÊNH SUY NGHĨ — rootcause đã chỉ ra được ở mã
- **Hiện tượng:** các evt type=thought chứa NGUYÊN VĂN body tool-call (evt5 `TỠI_CALL> {…}`, evt9 `tt>tout {…}`, evt23 `_call: …`, evt49 `todo_write">{…}`) — đúng hiện tượng user nêu ở cụm 2, vẫn tồn tại ở bản r67.
- **Rootcause (mã):** `src/lib/agent-run-tracker.ts` L682-691 — `recordAgentThought` chỉ strip: (a) khối `<invoke>…</invoke>` HOÀN CHỈNH, (b) thẻ invoke rời rạc CÓ `>` đóng, (c) phần sau marker `tool_call:`. Các dạng méo r66/r67 (parser extract + execute từ content) KHÔNG nằm trong 3 nhánh strip → nguyên văn vào text thought hiển thị ở panel Suy nghĩ.
- **Đánh giá:** parser ĐÃ tính được span thực thi của từng call (có protectSpan) nhưng recordAgentThought KHÔNG nhận các span đó — 2 module đi 2 đường. FIX hướng (hardcode, đúng chỉ đạo user): truyền span-đã-parse từ parser vào recordAgentThought để blank-out vùng đã execute — không phải dạy model "đừng viết tool call vào chỗ nghĩ".
- **Liên kết cụm cũ:** cụm 2 (tool call trong suy nghĩ) — CHƯA đóng.

### BUG-004 · D · P1 · 15:03:37→15:05:50 · SENTINEL (sub-agent) SUY NGHĨ 100% TIẾNG ANH — protocol + detector tiếng Việt KHÔNG phủ đường delegation
- **Hiện tượng:** sub-run `sub_1791471783200_2.jsonl` — 6/6 thought có nội dung chữ đều là tiếng Anh (r=0.000): "Route, allowlist and runner are read…" (it6), "I'll read the rest of the test file…" (it8), "I'll read the last chunk…" (it11), "Reading done for route…" (it14), "Gate receipt was lost…" (it15).
- **Bằng chứng:** các evt 14/19/26/31/34 sub-run; 0 cảnh báo NGÔN NGỮ nào xuất hiện trong sub-run (Omega thì có — evt17/21 main run).
- **Đánh giá:** `buildLanguageProtocol` (r67, priority 97) hình như chỉ inject goal-loop chính; đường delegation (sub-agent prompt) không được inject + detector viNudges không chạy cho sub-run. Cụm 5 "TẤT CẢ phải tiếng Việt" CHƯA đóng ở tầng sub-agent. Cần kiểm tra mã khi kết thúc quan sát (không sửa giữa chừng).
- **Liên kết cụm cũ:** cụm 5 (ngôn ngữ).

### BUG-005 · D · P2 · 15:02:48Z · Omega hết trần nudge tiếng Việt rồi tiếp tục tiếng Anh — harness im lặng
- **Hiện tượng:** Omega nhận 2 nudge (14:59:13 lần 1/2, 14:59:35 lần 2/2 — HẾT TRẦN), sau đó evt52 (15:02:48) vẫn output tiếng Anh "I will provide a concise Vietnamese explanation…" mà không còn cảnh báo nào.
- **Bằng chứng:** main run evt16-17, evt20-21, evt52.
- **Đánh giá:** trần 2/run (r67) đổi tiếng vọng lấy im lặng: vi phạm sau trần là "miễn phí" — không ghi sideIssue cho evaluator, không vào báo cáo cuối. Cần tầng ghi nhận thụ động (không nudge nữa nhưng vẫn đếm + đưa vào evaluateCompletion) thay vì im hẳn.
- **Liên kết cụm cũ:** cụm 5.

### BUG-006 · D · P3 · 15:02:48Z · Degenerate boilerplate lệch nhiệm vụ không bị phát hiện
- **Hiện tượng:** evt52: "I will provide a concise Vietnamese explanation of the solution, its mathematical derivation, and a directly usable Python implementation." — văn bản mẫu hoàn toàn không liên quan nhiệm vụ kiểm định bảo mật (đả số học + code Python).
- **Bằng chứng:** main run evt52 (`re_1791471768725_53`).
- **Đánh giá:** dạng "trôi модель" (degenerate sampling) — không detector nào bắt (không phải tool-call, không phải lặp, không phải lệch ngôn ngữ thuần). Rủi ro thấp (chỉ 1 lần, tool kế tiếp vẫn đúng) nhưng với nhiệm vụ dài có thể tích tụ gây nhiễu ngữ cảnh. Ghi nhận hiện tượng; cân nhắc detector "off-topic boilerplate" nếu lặp ≥2.
- **Liên kết cụm cũ:** cụm 6 (chất lượng output).

### BUG-007 · B · P2 · 15:03:59→15:05:50Z · SENTINEL mất receipt quality-gate (không bao giờ lấy exit code)
- **Hiện tượng:** SENTINEL chạy quality gate bằng `run_bg` (15:03:59), đọc output 3 lần (15:04:02→15:04:10) rồi chuyển việc khác; đến 15:05:50 tự nhận "Gate receipt was lost (I never captured its exit code)" — bằng chứng nghiệm thu bị mất, phải chạy lại.
- **Bằng chứng:** sub-run evt25-30, evt34; mission-watch-live.log 15:03:59→15:05:50.
- **Đánh giá:** cần phân định lỗi agent (khỷ luật đọc output đến khi có exit code) hay lỗi tool (`read_output` có trả exit code của process không? — nếu tool không trả thì agent KHÔNG THỂ lấy). Việc này đốt thêm 1 vòng chạy lại gate (~60s + token). Theo dõi: nếu lặp ≥2 lần trong run → vấn đề công cụ, không phải kỷ luật.
- **Liên kết cụm cũ:** cụm 2 (kỷ luật thực thi).

### BUG-008 · H · P2 · 14:58:23Z · Directive UI không qua guard chống ping-pong (không khối "Nghiệm thu:")
- **Hiện tượng:** directive dispatch qua UI chỉ 82 ký tự "Tiếp tục triển khai các đề xuất khắc phục và các phần việc chưa hoàn thành cho tôi" — KHÔNG khối nghiệm thu; guard fail-fast chỉ nằm trong `scripts/mission-dispatch.ts` (đường script), đường `/api/openclaw/chat` (UI) không được bảo vệ.
- **Bằng chứng:** GoalLoopJob `cmuznvkl1000nll50th6b136k`.input.userMessage (82 chars); đối chiếu mission #18 kết thúc `verdict_stagnation` 4.0M tokens 09:25Z rồi lập tức được re-dispatch mơ hồ — đúng pattern ping-pong guard sinh ra để chặn.
- **Đánh giá:** hệ thống tự cứu một phần bằng backlog hồi quy 10 phần việc có map nghiệm thu (evt1 main run) — evaluator có cái để bám. Nhưng guard nên nằm ở TẦNG API (đường UI lẫn script cùng chịu), không chỉ trong script của operator. Đây là gap quy trình đúng chỉ đạo "hardcode > prompt".
- **Liên kết cụm cũ:** mới (quy trình vận hành).

### BUG-009 · G · P3 · 15:05Z · Sub-agent để lại rác workspace `tmp/` ở repo root + mojibake ký tự hỏng trong thought
- **Hiện tượng:** (a) khi thử nghiệm giả thuyết symlink/cwd, SENTINEL tạo thư mục `tmp/` ngay repo root (untracked, ls 15:05:50 thấy "drwxr-xr-x … tmp"); (b) main run evt37 có ký tự hỏng `�N GĐ0` (UTF-8 glitch).
- **Bằng chứng:** sub-run evt36 output shell "symlink/temp artifacts in repo root … tmp … git untracked count 1"; main run evt37.
- **Đánh giá:** (a)験 thử filesystem nên dùng scratch/ hoặc /tmp thật, không để dọt rác repo — theo dõi cuối run xem có tự dọn không; nếu không dọn → ghi thành vấn đề vệ sinh có thật. (b) mojibake nhỏ, có thể do provider; theo dõi tần suất.
- **Liên kết cụm cũ:** cụm 6 (vệ sinh output) mở rộng.

---

## GHI NHẬN TÍCH CỰC (để tổng hợp công bằng — không chỉ bắt lỗi)
- ✅ Parser r66/r67 phục hồi đúng 5/6 dạng méo trong 5 phút đầu — các tầng mới (tag-direct, native-body, salvage) làm việc thật.
- ✅ Phân công: Omega delegate SENTINEL ngay chu kỳ 2 kèm mô tả nhiệm vụ + "tiêu chí nghiệm thu" trong lời giao việc (evt55) — kỷ luật phân công r66/r67 có tác động hành vi thật (không phải chỉ nudge).
- ✅ Trọng tài chu kỳ 1: phán CHƯA ĐẠT tin cậy 1% — KHÔNG đóng dấu cao su, đúng tình (chu kỳ 1 chỉ lập todo + đọc 2 file, chưa có thay đổi mã).
- ✅ Nén context ×2 hoạt động (mỗi lần ~21k ký tự); todo-coverage 8/10→10/10 hiển thị đúng.
- ✅ SENTINEL có ý thức blast-radius ("verify repo cleanliness + blast radius before touching anything").

### BUG-010 · B · P1 · 15:08:12Z · SENTINEL VƯỢT PHẠM VI DELEGATION — nhiệm vụ "khảo sát" nhưng tự IMPLEMENT fix + test vào mã bảo mật
- **Hiện tượng:** lời giao của Omega (evt55, 15:03:03): "Khảo sát độc lập P0-1 endpoint OpenCode execute và **xác định mọi khoảng trống** còn lại. Đọc đầy đủ route, exec-allowlist, exec-runner…" — phạm vi là ĐỌC + BÁO CÁO. SENTINEL đã: tìm ra gap thật (symlink-cwd escape trong `resolveSafeCwd`), tự SỬA `src/lib/exec-allowlist.ts` (+33 dòng), tự thêm 3 regression test (+68 dòng `tests/execute-route-security.test.ts`), tự chạy gate (392/392 PASS) — không có bước phê duyệt TL.
- **Bằng chứng:** sub-run evt45-58 (15:08:12→15:09:16); `git status` 15:10:41: 2 file modified, 101 insertions; thought it20 "Fix applied to resolveSafeCwd (symlink-cwd escape, K1) + regression test appended".
- **Đánh giá:** về kỹ thuật fix có test + gate PASS (chất lượng không sai); về governance: sub-agent thay đổi mã bảo mật trọng yếu NGOÀI mandate — TL mất quyền kiểm soát thay đổi, và nếu gap là giả dương thì fix tự ý đã nhiễm repo. Cơ chế còn thiếu: delegation contract phân biệt READ-ONLY vs MODIFY (gate cứng ở tầng công cụ, không phải câu chữ lời giao). Lưu ý cân bằng: cứng hóa quá có thể chặn chủ động hữu ích — hợp lý: modify-op ngoài mandate → cần flag "chờ TL duyệt" thay vì áp thẳng.
- **Liên kết cụm cũ:** cụm 2/3 (kỷ luật thực thi, phân công).

### BUG-004-bổ-túc · D · 15:09:36Z · Phân hoạch ngôn ngữ ở sub-agent: BÁO CÁO CUỐI tiếng Việt ĐÚNG, chỉ THINKING tiếng Anh
- **Hiện tượng:** báo cáo cuối của SENTINEL (evt61/66: "## BÁO CÁO CUỐI — P0-1 /api/opencode/execute ### (1) Bảng tiêu chí…") viết ĐÚNG tiếng Việt có bảng đối chiếu — trong khi toàn bộ thought giữa chừng là tiếng Anh (BUG-004 gốc).
- **Đánh giá:** enforcement hiện có tác dụng ở tầng OUTPUT (sản phẩm) nhưng không chạm tầng TƯ DUY (thinking). Nếu tiêu chí user là "TẤT CẢ phải tiếng Việt" (gồm suy nghĩ — user từng phàn nàn không quan sát được phần suy nghĩ) thì tầng thinking sub-agent vẫn hở.

### BUG-009-xác-nhận · G · 15:12Z · `tmp/` repo root KHÔNG được sub-agent dọn sau khi dùng
- **Hiện tượng:** thư mục `tmp/` (tạo lúc thử nghiệm symlink 15:05) vẫn còn trên đĩa sau khi sub-agent kết thúc phần việc (15:12) — không có thao tác dọn.
- **Bằng chứng:** `ls -d tmp` 15:12 = tồn tại; SENTINEL evt62 có kiểm tra "two untracked files not mine" nhưng không dọn tmp của mình (tmp bị .gitignore che nên không hiện git status — dễ bỏ sót khi dọn bằng git).
- **Đánh giá:** dấu vết thử nghiệm filesystem nên nằm trong scratch/ hoặc dọn ngay; .gitignore che mất dấu vết khiến "dọn bằng git status" không thấy — nên có nhắc nhở dọn theo ls chứ không chỉ git.

### BUG-011 · C · P1 · 15:13:24Z · Trọng tài delegation PHẢN ÂM: phán CHƯA ĐẠT (28%) cho phần việc đã hoàn thành — cửa sổ bằng chứng quá hẹp
- **Hiện tượng:** SENTINEL đã đọc đầy đủ route.ts / exec-allowlist / exec-runner / token-helper / toàn bộ test P0-1 (sub-run evt9-24), fix symlink-cwd escape + 3 regression test, gate 392/392 PASS, báo cáo tiếng Việt có bảng đối chiếu file:dòng — nhưng trọng tài độc lập phán CHƯA ĐẠT (tin cậy 28%) với gap: "Evidence log chưa chứng minh việc đọc đầy đủ route.ts, exec-runner.ts, helper token/session…".
- **Rootcause:** evaluator nhận `toolResultLog` đã tier ~600 chars/entry, ~12k chars tổng trong prompt (49 tool calls × kết quả dài → phần chứng minh đọc đầy đủ bị cắt khỏi cửa sổ). Báo cáo CÓ bảng file:dòng nhưng evaluator vẫn dựa chính vào evidence log để chấm.
- **Hệ quả (đang diễn ra):** Omega phải tự đọc lại + phán lại phần việc tương tự ("báo cáo độc lập vẫn bị trọng tài chưa đạt… helper bị đọc dở" — main run evt58-60) — tốn thêm token + thời gian cho phần việc thực chất đã xong.
- **Bằng chứng:** `dev.log` L282566 `[SubAgent] SENTINEL trọng tài độc lập: CHƯA ĐẠT (tin cậy 28%) — thiếu: Evidence log chưa chứng minh…`; sub-run evt9-24 (các file_read), evt45-58 (fix + gate); main run evt56-58.
- **Liên kết cụm cũ:** cụm 4 (arbiter) — đánh giá/tham số ra quyết định của trọng tài.

### BUG-012 · E · P1 · 15:13:24Z · Delegation "khảo sát" đốt 1,859,401 tokens / 621s / 31 vòng — không phanh ngân sách theo phần việc
- **Hiện tượng:** sub-task đọc code + fix + test + gate kết thúc sau 1.86M tokens (31 vòng ReAct, 49 tool calls, 621s wall-clock). Tham số delegation ghi rõ: "max ∞ (KHÔNG GIỚI HẠN — user directive) vòng, budget ∞ tokens, timeout ∞ nhưng wall-clock an toàn 15' (r60), 39 tools".
- **Đánh giá:** 1.86M cho 1 sub-task ≈ 46% toàn bộ mission #18 (4.0M). Phanh duy nhất là wall-clock 15' — sub-run dùng 621s = 10.4 phút, chỉ còn ~4.6 phút dự phòng; nếu evidence cần thêm 1 vòng là bị cắt. Không có ngưỡng cảnh báo token theo PHẦN VIỆC (giao thức D5.2/D5.3). Cân nhắc: per-delegation token budget + cảnh báo ngưỡng (không phải cắt cứng — user directive là ∞ tổng).
- **Ghi nhận kèm:** số token báo 2 nơi chênh nhau (thought evt57: "1828.7k" vs run_end: "1859401" — lệch 1.7%) — cần đồng bộ nguồn đếm.
- **Bằng chứng:** dev.log L281985 (tham số), L282567 (kết thúc 621s); sub-run evt69; main run evt57.
- **Liên kết cụm cũ:** cụm 6 (ngân sách/output).

### BUG-013 · C · P3 · 15:13:24Z · Nhãn "HOÀN THÀNH" cạnh verdict "CHƯA ĐẠT" trên cùng kết quả phân công — dễ đọc nhầm
- **Hiện tượng:** main run evt57: "KẾT QUẢ PHÂN CÔNG: agent [SENTINEL] HOÀN THÀNH … kết thúc bởi concluded" trong khi cùng lúc verdict là CHƯA ĐẠT (28%).
- **Đánh giá:** "HOÀN THÀNH" = delivery (kết quả đã trả về), "CHƯA ĐẠT" = verdict chất lượng — 2 khái niệm gộp chung khung hiển thị. Lần này Omega đọc đúng cả 2 tín hiệu, nhưng TL model yếu hơn có thể chỉ thấy "HOÀN THÀNH" rồi đánh dấu todo xong. Nên tách nhãn: "TRẢ VỀ ĐẦY ĐỦ · TRỌNG TÀI CHƯA ĐẠT 28%".
- **Liên kết cụm cũ:** cụm 4.

### BUG-014 · B/H · P2 · 15:16:38Z · Omega giao lại P0-1 kèm ràng buộc "chỉ đọc, không sửa file" — TL tự thích nghi với BUG-010, NHƯNG ràng buộc vẫn là CÂU CHỮ (prompt) thay vì cờ cứng tầng tool
- **Hiện tượng:** lời giao lần 2 cho SENTINEL: "Khảo sát độc lập phần còn dở P0-1, **chỉ đọc và kiểm định; không sửa file**. Đọc đầy đủ src/app…" — Omega đã học từ sự việc BUG-010 (sub tự sửa mã) sau đúng 1 vòng.
- **Đánh giá:** (+) TL thích nghi nhanh, ràng buộc phạm vi đưa vào lời giao. (−) Theo doctrine user "hardcode > prompt": ràng buộc readOnly hiện NẰM Ở VĂN BẢN — delegate_task chưa có cờ `readOnly` để tầng tool chặn `file_write`/`shell` ghi. Sub-agent tuân thủ bằng ý thức thì được, hallucinate thì lọt (chính SENTINEL round trước đã từng vượt mandate).
- **Bằng chứng:** main run evt70; sub_1791472598062_3.jsonl evt0; dev.log dòng delegation Omega → SENTINEL lần 2.
- **Liên kết cụm cũ:** cụm 2/3 (phân công) + doctrine hardcode.

### BUG-006-cập-nhật · D · P2 · 15:16:38Z · Degenerate fragment LẬP LẦN THỨ 2 — "x echoed pieces"
- **Hiện tượng:** thought evt69 chỉ chứa "x echoed pieces" — mảnh văn bản vô nghĩa (không phải suy nghĩ, không phải tool call). Lần 1: evt52 ("I will provide a concise Vietnamese explanation…"). Đạt ngưỡng lặp ≥2 mà chính ghi chú BUG-006 đặt ra.
- **Đánh giá:** nâng từ P3 → P2: hiện tượng trôi output của provider LẶP trong cùng 1 run, hiện chưa có detector nào nhận diện (không phải tool-call, không phải lặp tool, không phải sai ngôn ngữ thuần). Risk: fragment loại này lọt vào context dài hạn làm nhiễu digest/nén.
- **Bằng chứng:** main run evt52, evt69.

### BUG-015 · F · P1 · 15:25Z · DATA MAP (r67) VẮNG HOÀN TOÀN trên mission thật — router trả RỖNG với directive mơ hồ, không fallback; sub-agent cũng KHÔNG BAO GIỜ được cấp bản đồ
- **Hiện tượng:** mission hiện tại (bắt đầu sau khi r67 đã deploy + PM2 restart 13:54) có 0/18 message chứa "BẢN ĐỒ DỮ LIỆU". Repro trực tiếp: `buildDataMapBlock('Tiếp tục triển khai các đề xuất khắc phục và các phần việc chưa hoàn thành cho tôi')` → **length 0**.
- **Rootcause (3 lớp, đều đã xác minh mã):**
  1. `data-map.ts` L307: `if (reads.length===0 && writes.length===0) return ''` — KHÔNG fallback khi 0 vùng khớp. Directive mơ hồ/continuation (đúng dạng user hay dùng: "tiếp tục…") score 0 trên toàn bộ 16 vùng → map biến mất âm thầm.
  2. Nguồn định tuyến chỉ là `userMessage.slice(0,2500)` (goal-loop L2449) — với continuation mission, ngữ cảnh thật nằm ở backlog hồi quy + chat history, không nằm ở 82 ký tự directive.
  3. `subagent-delegate.ts` không import data-map — đường delegation không hề cấp bản đồ cho sub-agent (grep 0 kết quả).
- **Đánh giá:** "code-enforced" chỉ đúng khi router khớp — lỗ hở phủ ở đúng những mission khó nhất (tiếp nối dở dang). Fix hướng (hardcode): (a) 0-match → luôn xuất RÚT GỌN toàn registry (danh sách id+store 1 dòng/vùng, ~600 chars) thay vì rỗng; (b) route trên userMessage + backlog; (c) thêm block data-map vào prompt sub-agent trong subagent-delegate.
- **Bằng chứng:** repro bun trên; checkpoint job (0/18 msg); src/lib/data-map.ts L283-307; src/lib/agent-goal-loop.ts L2445-2451; grep subagent-delegate.ts = 0.
- **Liên kết cụm cũ:** cụm 6 (DB làm bộ nhớ) + câu hỏi "bản đồ dữ liệu" phiên trước.

### BUG-016 · E · P1 · 15:26Z · System prompt IDENTITY Omega (36,411 chars) bị budget-cut về 0 KÝ TỰ — agent chạy "hồn ma": không biết mình là ai từ đầu run
- **Hiện tượng:** checkpoint message system hiện tại: mở đầu bằng `…[budget-cut 0/36411 chars]` — TOÀN BỘ system prompt gốc (identity "Bạn là OMEGA — NGƯỜI QUẢN TRỊ VẬN HÀNH…", nguyên tắc điều phối/giám sát/nghiệm thu) bị cắt giữ 0 ký tự; đuôi còn 5 khối `…[budget-cut 0/2028]…[0/2208]…[0/1284]…[0/673]…[0/2268]`. Marker "NGƯỜI QUẢN TRỊ"/"IDENTITY" KHÔNG còn trong system message.
- **Rootcause:** `prompt-budget.ts` + `.env SYSTEM_PROMPT_BUDGET_CHARS=40000`; goal-loop assembly (L953) đặt `base` (= nguyên khối system prompt session) **priority 10 — thấp nhất**, trong khi goalProtocol=100, languageProtocol=97… Tổng base(36.4k)+protocols(~40k) > 40k → water-fill hạ block priority thấp nhất về 0 để vừa budget. Kết quả: giữ PROTOCOL, vứt ĐỊNH DANH.
- **Hệ quả quan sát:** model vẫn vận hành nhờ goalProtocol + chat history (giải thích vì sao phân công vẫn diễn ra) nhưng mất persona/nguyên tắc quản trị; suy nghĩ tiếng Anh + degenerate fragment (evt52/evt69) diễn ra NGAY CẢ KHI languageProtocol còn nguyên (priority 97 sống sót) — tức protocol-by-prompt đã thất bại trước cả budget-cut, và identity mất làm trầm trọng thêm.
- **Fix hướng:** (a) block `base` không bao giờ được giữ 0 — tối thiểu giữ HEAD (vd 4k đầu identity) hoặc thay bằng LLM-digest; (b) nâng priority base lên ≥90; (c) marker budget-cut giữ-0 phải phát cảnh báo giám sát (hiện im lặng tuyệt đối — biết mình bị cắt chỉ khi soi checkpoint tay như lần này).
- **Bằng chứng:** checkpoint job `cmuznvkl1000nll50th6b136k` messages[0] (39,988 chars, đúng bằng budget 40k); src/lib/agent-goal-loop.ts L953-958; .env L531; prompt-budget.ts.
- **Liên kết cụm cũ:** cụm 6 (quá tải ngữ cảnh) + nguyên tắc giao thức "mỗi blind spot phải thành kênh quan sát".

### BUG-017 · C · P1 · 15:24:32Z · Trọng tài delegation PHẢN ÂM CÓ TÍNH CẤU TRÚC — 2/2 lần phán sai bằng chứng máy; cửa sổ evidence cắt mất tool call ĐẦU run
- **Hiện tượng:** sub#1 phán 28% "Evidence log chưa chứng minh việc đọc đầy đủ route.ts…"; sub#2 (read-only, đủ mọi bằng chứng: đọc đủ route/allowlist/runner + gate ×2 + todo 6/6) vẫn phán 20% với lý do "Evidence log **không có tool call file_read cho src/app/api/opencode/execute/route**" — trong khi file_read route.ts CÓ THẬT ở sub#3 evt4-5 (15:16:46) và báo cáo ghi rõ "Đọc đầy đủ: route.ts 286d".
- **Rootcause:** evidence nạp cho evaluator = toolResultLog tier ~600 chars/entry, ~12k tổng — 36 tool calls thì các call ĐẦU run (chính là các file_read cần làm bằng chứng) rơi ra khỏi cửa sổ. Evaluator đánh giá "có đọc X không?" bằng một cửa sổ系统性 bỏ mất phần đầu.
- **Quy tắc giao thức #4:** sự cố lặp ≥2 lần PHẢI sinh fix cấu trúc. Fix hướng: evidence cho evaluator = INDEX TOÀN BỘ tool calls (1 dòng/call: tool + args chính + success + thời điểm — luôn vừa, vd 36 dòng ≈ 2k chars) + tier chỉ áp cho RESULT chi tiết. Index chứng minh "file_read route.ts đã chạy" không cần result đầy đủ.
- **Bằng chứng:** dev.log 2 dòng "trọng tài độc lập" (28% + 20%); sub_1791472598062_3.jsonl evt4-5 (file_read thật), evt43/46 (báo cáo đọc đủ); sub_1791471783200_2.jsonl evt9-24.
- **CẬP NHẬT 15:29Z — tương phản quyết định:** MEGATRON (nhiệm vụ chẩn đoán NHỎ: 10 vòng, 9 tool calls, 250k tokens) được phán **ĐẠT (91%)** — bằng chứng vừa cửa sổ 12k → qua. Bộ ba: survey lớn 49 calls → 28% FAIL; survey lớn 36 calls → 20% FAIL; nhiệm vụ nhỏ 9 calls → 91% PASS. Giả thuyết cửa sổ evidence được khẳng định thêm (không phải model chấm khó tính — là CẤU TRÚC mất bằng chứng theo kích thước việc).
- **Liên kết cụm cũ:** cụm 4 (arbiter) — lặp lại đúng dự phóng.

### BUG-018 · C · P1 · 15:26:49Z · Trọng tài CHÍNH không công nhận kết quả delegation — phán "chưa có sửa code" trong khi working tree CÓ fix + gate 392/392 từ SENTINEL
- **Hiện tượng:** verdict chu kỳ 2 (main): "CHƯA ĐẠT (tin cậy 2%) — … P0-1 vẫn in_progress, **chưa có sửa code**, test …" — nhưng `git status` từ 15:10 đã có 101 insertions (exec-allowlist.ts +33, execute-route-security.test.ts +68) do SENTINEL làm, gate 392/392 PASS (3 test mới chạy thật).
- **Rootcause:** evaluator chu kỳ chính nhận evidence từ transcript CHÍNH Omega — kết quả delegation chỉ lọt vào qua 1 dòng delegate_task result (bị cắt preview). Không có đường chứng minh "việc uỷ thác đã thay đổi mã thật" (ví dụ: diff stat + số test mới) cho trọng tài chính.
- **Hệ quả:** vòng lặp PHẢN ÂM LỒI: Omega giao việc → sub làm xong có bằng chứng → trọng tài sub chấm hụt (BUG-017) → trọng tài chính cũng chấm hụt (BUG-018) → AUTO-ESCALATE đốt thêm token → chu kỳ 3 lặp lại. Token mission đã 3.9M (sub 2.9M) sau 29 phút — vượt tốc độ mission #18 (4.0M/4.5 giờ).
- **Fix hướng:** (a) delegate_task result nạp kèm "MÁY ĐO": diff --stat + test-count trước/sau + verdict sub đầy đủ (không cắt); (b) evaluator chu kỳ nhận block "KẾT QUẢ DELEGATION TÍCH LŨY" như một loại evidence chính ngạch.
- **Bằng chứng:** main run evt85-87; git status 15:10:41; dev.log verdict chu kỳ 2.
- **Liên kết cụm cũ:** cụm 4 + cụm 2 (phân công bị đánh giá lệch).

### BUG-019 · D · P3 · 15:24:52Z · Degenerate fragment lần 3: thought chỉ chứa "<"
- **Hiện tượng:** evt75 thought = "<" (1 ký tự). Sau evt52, evt69 — lần thứ 3 trong 1 run. Mật độ tăng: 1 lần/10 phút.
- **Đánh giá:** giữ P2 như BUG-006-cập-nhật (đã nâng); lần 3 này xác nhận pattern ổn định — cần detector (thought < 8 ký tự và không phải marker hệ thống → đếm là degenerate, ≥3/run → sideIssue cho evaluator).
- **Bằng chứng:** main run evt75.

### BUG-020 · E · P1 · 15:27Z · NHÂN RỘNG: mission đốt 3.9M tokens (sub 2.9M) sau 29 phút — vòng phản âm lồng nhau (BUG-017 × BUG-018) là động cơ chính
- **Hiện tượng:** snapshot 15:27: tokens 3.9M (sub 2.9M) · chu kỳ 1 · 17 tools · nén ×5. Tốc độ ≈ 134k tokens/phút. Nếu chu kỳ 3 tiếp tục giao lại phần việc đã xong, mission sẽ vượt mission #18 (4.0M) trong <1 giờ vận hành.
- **Đánh giá:** không phải lỗi từng agent riêng — là HỆ QUẢ của cặp phán âm lồng (trọng tài sub + trọng tài chính cùng không thấy bằng chứng). Sửa BUG-017/018 là chặn nguồn đốt token lớn nhất quan sát được trong phiên này.
- **Bằng chứng:** mission-watch snapshot 15:27:16Z; so sánh mission #18 (4.0M/31 tools/4.5h).
- **Liên kết cụm cũ:** cụm 6.

### BUG-021 · E/C · P1 · 15:31:52→15:32:29Z · "CHU KỲ GIÓ" (air-cycles): chu kỳ 3-4 dài 28-41 giây, 0 tool, verdict 2% liên tiếp — quỹ đạo chết verdict_stagnation của mission #18 đang lặp lại
- **Hiện tượng:** chu kỳ 3 (15:31:11→15:31:52, 41s): lập todo 15 mục → đánh giá → CHƯA ĐẠT 2%. Chu kỳ 4 (15:32:01→15:32:29, 28s): Tự phản chiếu + phát hiện lập kế hoạch → CHƯA ĐẠT 2% → "0 tool call thành công — tín hiệu bế tắc 1/3". Chu kỳ 5 bị ÉP chuyển thẳng GĐ2.
- **Cơ chế an toàn hoạt động đúng (ghi nhận tích cực):** detector vòng lặp lập kế hoạch bắt đúng ("🚨 2 chu kỳ liên tiếp không có tool triển khai nào"), ép GĐ2, stall brake đếm 1/3, chu kỳ 5 gọi shell ngay.
- **Nhưng gốc vẫn chưa trị:** Omega lặp "nghĩ-về-việc-phải-làm" thay vì LÀM (evt101: "chưa đối chiếu diff thực tế, chưa xác nhận…" — viết ra thì phải gọi tool ngay). Các phanh (nudge thuần văn bản 6/6 cạn, cut-JSON 4/4 cạn, viNudge 2/2 cạn) đều ĐÃ CẠN — sau khi cạn, model không còn đèn dẫn nào ngoài goalProtocol. Mỗi chu kỳ gió vẫn tốn 1 lần gọi evaluator.
- **Đánh giá:** đây là pattern kết thúc mission #18 (verdict_stagnation) — đang diễn lại sau 33 phút. Nếu chu kỳ 5-7 không có tiến triển thật, brake sẽ cắt mission. Nguồn gallon: model mất kỷ luật thực thi khi (a) verdict liên tục CHƯA ĐẠT sai (BUG-017/018) khiến nó liên tục dựng lại kế hoạch, (b) identity bị cắt (BUG-016).
- **Bằng chứng:** main run evt102-113; so sánh mission #18 stopReason=verdict_stagnation.
- **Liên kết cụm cũ:** cụm 6 (output cắt/quá tải) + cụm 4.

### BUG-022 · E · P1 · 15:40Z · KHUẾCH ĐẠI ĐỌC LẠI: file_read ×15 + ×14 + ×10 trên cùng 3 file — 39 lượt đọc cho ~4 file khác nhau
- **Hiện tượng:** Phân tích lặp toàn run (replay): `file_read src/lib/exec-allowlist.ts` ×15, `tests/execute-route-security.test.ts` ×14, `src/app/api/opencode/execute/route.ts` ×10 — cùng args, cùng kết quả. ToolMetric: 39 file_read thành công toàn mission.
- **Rootcause (chuỗi nhân):** nén context ×6 cắt mất kết quả đọc trước → verdict CHƯA ĐẠT (BUG-017/018) ép đọc lại → đọc lại không gom được bằng chứng → lặp. RepeatTracker PHÁT HIỆN và in 🔁 nhưng KHÔNG có phanh/đèn dẫn ở ngưỡng file-level (chỉ theo dõi).
- **Fix hướng:** ngưỡng ≥5 lần cùng args → nudge "kết quả đã có trong digest — dùng file_read offset thay đọc lại toàn file" + đưa vào sideIssue evaluator.
- **Bằng chứng:** replay `--replay cmuznvkl1000nll50th6b136k` mục "Phân tích lặp"; ToolMetric 39 file_read.
- **Liên kết cụm cũ:** cụm 6.

### BUG-023 · A · P2 · 15:40Z · Họ méo THỨ 8: `truncate parameter name="recipient_name">functions.git_diff<parameter name="parameters">` — pseudo-XML function-call; git_diff mất trắng
- **Hiện tượng:** assistant content (checkpoint msg 4/6): `…truncate parameter name="recipient_name">functions.git_diffparameter name="parameters">{"t…` — dạng function-calling XML của provider bị cắt đầu + méo thẻ. KHÔNG được parse (trọng tài chu kỳ 3 xác nhận "gọi git_diff bị cắt, không có output xác nhận").
- **Đánh giá:** 8 họ dạng méo đã quan sát được trong 1 mission (br>{</name>, TỠI_CALL>, tt>tout, content>{cắt}, _call:, tool_call:, todo_write">, functions.X<parameter…). Bộ parse r66/r67 phủ 6; còn hở: họ này + BUG-001. Detector thẻ-mồ-côi `</invoke>` hoạt động đúng (bắt được 1 vụ) — nhưng họ pseudo-XML `parameter` không có sign.
- **Fix hướng:** detector sign `parameter name="(recipient_name|parameters)"` + `functions.<tool>` → MALFORMED feedback kèm skeleton; cân nhắc tầng parse dạng `functions.<tên><parameter name="args">{json}` (whitelist tên như tầng tag-direct).
- **Bằng chứng:** checkpoint messages (assistant 4/6); verdict chu kỳ 3 "gọi git_diff bị cắt".
- **Liên kết cụm cũ:** cụm 1.

### BUG-024 · G · P2 · 15:38:49Z · Provider Zen chết TOÀN CHUỖI (HTTP + CLI) đúng lúc wrap-up — fetch failed
- **Hiện tượng:** `lastLlmError: Zen model "space-bunny-free" thất bại toàn chuỗi (HTTP + CLI): Zen call failed: fetch failed — NIM đã ngừng dùng cho agents (Task 33)` — lần gọi LLM cuối (wrap-up) thất bại hoàn toàn.
- **Đánh giá:** fail-open hoạt động (vẫn có báo cáo cuối tổng hợp từ các phần trước) nhưng wrapper cuối rơi vào đường không-LLM → báo cáo cuối chỉ là bản tổng hợp thô. Cần: 1 lần retry có backoff cho wrap-up (cuộc gọi quan trọng nhất của run — tổng kết bằng chứng).
- **Bằng chứng:** checkpoint lastLlmError; replay khối cuối.
- **Liên kết cụm cũ:** cụm 1/6 (độ bền provider).

### BUG-025 · B · P2 · 15:41Z · Mission khép để lại 101 dòng fix KHÔNG COMMIT trong working tree — không bước bàn giao cuối
- **Hiện tượng:** `git status`: exec-allowlist.ts (+33) + execute-route-security.test.ts (+68) vẫn modified, chưa ai commit. Omega có tool git_commit nhưng không gọi (P0-1 chưa được công nhận đạt nên không dám chốt).
- **Đánh giá:** công sức thật (fix + 3 test + gate 392/392) suýt bị "mồ côi" — lần chạy sau có thể ghi đè hoặc quên. Wrap-up cần bước: nếu working tree có thay đổi từ delegation → báo rõ trong task_summary "CÓ THAY ĐỔI CHƯA COMMIT (danh sách file + số dòng)" để lần sau/operator nhặt lên. Phiên này operator sẽ commit giúp kèm receipt (xem cuối file).
- **Bằng chứng:** git status 15:41; task_summary không nhắc danh sách file uncommitted (chỉ nhắc "thay đổi allowlist và test đã tồn tại trong working tree" trong content).
- **Liên kết cụm cũ:** cụm 2.

---

## KẾT CỤC MISSION (quan sát trọn vẹn 14:58:23 → 15:38:49)
- **stopReason:** `verdict_stagnation` — CHƯA hoàn thành. **5 chu kỳ · 36 vòng · 21 tool calls (main) + 94 (sub) · 4,595,676 tokens · 2,426s.**
- Chuỗi sự kiện: C1 lập kế hoạch/nạp hồi quy 10 phần → C2 delegate SENTINEL ×2 (làm thật: fix symlink-cwd + 3 test + gate PASS nhưng bị phán âm 28%/20%) + AUTO-ESCALATE→MEGATRON (ĐẠT 91%) → C3-C4 "chu kỳ gió" 28-41s → C5 đọc diff → 3 verdict CHƯA ĐẠT liên tiếp + tự khai bế tắc → VERDICT-STAGNATION cut.
- **Điểm sáng giữ lại (bằng chứng máy):** infra-guard chặn 6/6 attempt hạ tầng; detector vòng lặp lập kế hoạch + stall brake + verdict-stagnation đều cắt đúng thiết kế; detector thẻ-mồ-côi correlate đúng; nén context ×6; todo-coverage tracking; escalation chain end-to-end; final report TRUNG THỰC (thừa nhận fix chưa kiểm định); AgentMemory ghi task_summary cuối run (vòng kín GHI hoạt động; ĐỌC đã xác nhận đầu run); SENTINEL tìm ra lỗ hổng symlink-cwd escape THẬT + vá + test (giá trị bảo mật thật).

## (TIẾP TỤC QUAN SÁT — các mục sẽ được ghi thêm vào dưới đây khi phát hiện)

---

## TỔNG HỢP TOÀN BỘ VẤN ĐỀ QUAN SÁT ĐƯỢC (mission cmuznvkl1000nll50th6b136k — 14:58:23→15:38:49, 39.7 phút)

### Bảng tổng hợp theo mức độ

| Mức | Số | Các mục | Ghi chú |
|---|---|---|---|
| **P1** | 9 | BUG-003, 004, 011/017, 015, 016, 018, 020, 021, 022 | 004+005 liên quan ngôn ngữ; 017/018/020/021 là CHUỖI CHẾT mission (phán âm lồng → chu kỳ gió → stagnation) |
| **P2** | 12 | BUG-001, 005(→P2 với 006-update), 006-update, 007, 008, 010, 012, 013, 014, 019(→P2), 023, 024, 025 | 001+023 = 2 họ méo parser còn hở; 010+014 = governance delegation |
| **P3** | 3 | BUG-002, 009, 006 (gốc) | Mang tính thông tin/vệ sinh |

### Đối chiếu 6 cụm vấn đề user chỉ đạo (phiên trước) — trạng thái sau quan sát thật

| Cụm cũ | Trạng thái trên mission thật | Bằng chứng |
|---|---|---|
| 1. Tool-call đứt giữa JSON / méo | **CẢI THIỆN RÕ (6/8 họ phục hồi được)** nhưng còn 2 họ hở: `br>{</name>` (BUG-001) + pseudo-XML `functions.X<parameter>` (BUG-023); 4 lần đứt JSON phải retry; nguồn gốc vẫn là provider | evt5/9/23/49 parse ✓; evt3 không parse; checkpoint assistant 4/6 |
| 2. Tool call lọt vào suy nghĩ | **VẪN TỒN TẠI — đã tìm ra rootcause mã**: recordAgentThought chỉ strip dạng chuẩn, các dạng méo (dù parser bắt được) vẫn nguyên văn trong thought | BUG-003 (agent-run-tracker.ts L682-691) |
| 3. TL tự làm thay vì phân công | **ĐÃ CẢI THIỆN ĐÁNG KỂ** — Omega delegate 3 lần (SENTINEL×2, MEGATRON×1) kèm tiêu chí nghiệm thu; NHƯNG sub-agent lại vượt phạm vi tự sửa mã (đảo chiều vấn đề — BUG-010) và ràng buộc readOnly vẫn bằng câu chữ (BUG-014) | evt55, evt70, sub-runs |
| 4. Trọng tài (arbiter) | **ĐIỂM YẾU LỚN NHẤT PHIÊN NÀY**: phán âm cấu trúc 2/2 delegation (28%/20% — bằng chứng bị cửa sổ evidence 12k cắt mất), trọng tài chính không công nhận fix của delegation ("chưa có sửa code" sai sự thật), phán 2-3% tin cậy, chuỗi phán hụt → verdict_stagnation chết mission | BUG-011/017, 018, 013 |
| 5. Ngôn ngữ tiếng Việt | **NỬA VỞ**: OUTPUT/báo cáo cuối = tiếng Việt đạt; THINKING = tiếng Anh dai dẳng (sub-agent 100% tiếng Anh, không nhận protocol/nudge — BUG-004); sau trần nudge 2/2 thì vi phạm tự do (BUG-005); memory insight lưu tiếng Anh | sub_…_3 evt14-34; main evt52 |
| 6. Output cắt + DB làm bộ nhớ | **2 MẶT**: (a) khuếch đại đọc lại ×15/×14/×10 (BUG-022), chu kỳ gió (BUG-021), identity bị budget-cut về 0 (BUG-016); (b) DATA MAP r67 vắng hoàn toàn trên mission thật — router trả rỗng với directive mơ hồ + sub-agent không được cấp (BUG-015); ngược lại AgentMemory vòng kín GHI→ĐỌC HOẠT ĐỘNG thật (đầu run nạp 2 insight liên quan, cuối run ghi task_summary) | checkpoint; repro buildDataMapBlock=0 |

### Chuỗi nhân chết mission (quan trọng nhất — sửa tầng này là chặn cả chuỗi)

```
Directive mơ hồ (UI không qua guard — BUG-008)
  → identity bị budget-cut = 0 (BUG-016) + DATA MAP vắng (BUG-015)
  → Omega/todo/verdict đều ổn ở tầng "hình thức" nhưng:
  → SENTINEL làm thật việc (fix + test + gate 392/392)
  → trọng tài sub KHÔNG THẤY bằng chứng (cửa sổ 12k cắt mất — BUG-017) → CHƯA ĐẠT 28%/20%
  → trọng tài chính CŨNG KHÔNG THẤY fix của delegation (BUG-018) → "chưa có sửa code" → 2%
  → Omega đọc lại / dựng lại kế hoạch (×15 file_read — BUG-022; chu kỳ gió — BUG-021)
  → 3 verdict CHƯA ĐẠT liên tiếp + tự khai bế tắc → VERDICT-STAGNATION cut sau 39.7 phút / 4.6M tokens
```

### Đề xuất thứ tự fix (đúng doctrine hardcode — mọi thứ ở tầng mã, không dạy-bằng-prompt)
1. **Evidence INDEX cho trọng tài delegation** (BUG-017) — index toàn bộ tool call 1 dòng/call, luôn đủ, không bị tier.
2. **delegate_task result kèm MÁY ĐO** (BUG-018) — diff stat + verdict đầy đủ cho cả trọng tài chính.
3. **Budget-cut không bao giờ giữ 0 block gốc** (BUG-016) — min-keep + cảnh báo giám sát.
4. **Data-map fallback 0-match + cấp cho sub-agent** (BUG-015).
5. **maskToolCallText cho recordAgentThought** (BUG-003) — dùng chính span parser đã tính.
6. **Ngôn ngữ: protocol cho sub-agent + đếm sau trần** (BUG-004/005).
7. Parser R7 `</name> "tool"` + detector sign pseudo-XML (BUG-001/023).
8. Nhãn "TRẢ VỀ ĐẦY ĐỦ" tách verdict (BUG-013), detector degenerate (BUG-019), re-read brake (BUG-022), readOnly cờ cứng (BUG-014), wrap-up báo uncommitted (BUG-025).

### Bảng chấm giám sát phiên (giao thức mục 9-10)
| Lĩnh vực | Đạt | Tối đa | Bằng chứng chính |
|---|---|---|---|
| D1 Thực thi | 11 | 12 | stall phát hiện realtime; verdict-stagnation cắt đúng thiết kế; 4.6M token có post-mortem (file này) |
| D2 Trung thực | 19 | 20 | final report trung thực (thừa nhận fix chưa kiểm định); readback sqlite độc lập khớp |
| D3 Phán quyết | 8 | 12 | stagnation đúng; NHƯNG trọng tài phản âm cấu trúc (BUG-017/018) — lỗi hệ thống phán quyết, không phải nghi thức |
| D4 Hạ tầng | 16 | 16 | infra-guard 6/6 chặn; PM2 ổn định; 0 self-destruct |
| D5 Ngân sách | 5 | 10 | ∞ theo user directive đúng; NHƯNG không cảnh báo ngưỡng theo phần việc; 1.86M/sub-task |
| D6 Điều phối | 8 | 10 | quan sát liên tục không can thiệp giữa chừng; directive user mơ hồ (không phải lỗi operator) |
| D7 Sửa hệ thống | — | 10 | chấm sau giai đoạn fix của chính phiên này |
| D8 Hồ sơ | 10 | 10 | bug.md realtime từng bước; worklog + push cuối phiên |
| **TỔNG (tạm, chưa D7)** | **77** | 100 | **🟡 VÀNG — điểm yếu tập trung ở phán quyết + ngân sách** |

## (PHẦN FIX — kết quả triển khai sẽ ghi tiếp ở cuối file)

---

## PHẦN FIX — ĐÃ TRIỂN KHAI TRONG PHIÊN NÀY (round-68, commit kèm file này)

> Nguyên tắc: mọi fix ở TẦNG MÃ (doctrine user "hardcode > prompt"), kèm test bắt từ chính bằng chứng quan sát. Quality gate: **PASS toàn bộ 50.3s — 417/417 tests** (392 có sẵn + 25 mới r68). PM2 restart: health 200, home 200.

| Fix | BUG | File | Cơ chế (hardcode) | Test |
|---|---|---|---|---|
| F1 | 017 | delegation-evaluator.ts | **MỤC LỤC TOOL CALL** đầy đủ (1 dòng/call, không bị tier 12k) nạp vào prompt trọng tài + rule 2 cấm phán "thiếu call X" khi có trong mục lục; subagent-delegate truyền `callIndex` từ evidence preview | 4 test (đánh số, rỗng, >150 dòng, cap 170 chars/dòng) |
| F2 | 018 | subagent-delegate.ts | **Block 📊 MÁY ĐO** gắn vào delegate report (số call + file ghi/sửa + lần gate + verdict) — parent LLM lẫn trọng tài chu kỳ đều đọc được qua tool-result chính quy | (qua F1/E2E — máy đo là thuần deterministic) |
| F3 | 015 | data-map.ts + agent-goal-loop.ts + subagent-delegate.ts | (a) 0-match → liệt kê SƠ LƯỢC toàn 16 vùng (thay vì rỗng); (b) nguồn định tuyến = userMessage + task-summaries (4000 chars — continuation mission route theo NỘI DUNG việc); (c) sub-agent được cấp block bản đồ như main loop | 2 test mới + 1 test r67 cập nhật theo spec mới |
| F4 | 016 | prompt-budget.ts | **SÀN GIỮ 1500 chars** cả 2 nhánh cắt (stub + threshold) — block base/identity không bao giờ về 0 nữa + console.warn kênh giám sát khi block mất >75% | 3 test (threshold, stub đa block, hồi quy không-đụng) |
| F5 | 003 | tool-calls.ts + agent-run-tracker.ts | **maskToolCallText** — recordAgentThought mask 3 họ dạng méo (native-body trần, `name({json})`, `name">{json|<xml}`) bằng whitelist + cân bằng; panel Suy nghĩ chỉ còn phần NGHĨ, tool call là event riêng | 6 test (4 dạng thật evt5/9/23/49 + 2 chống false-positive) |
| F6 | 004+005 | agent-goal-loop.ts (export protocol) + subagent-delegate.ts + goal-loop-durable-types.ts | (a) sub-agent nhận protocol ngôn ngữ (import 1 nguồn sự thật); (b) detector ngôn ngữ riêng cho sub loop (2 nudge + đếm muộn ghi vào 📊 MÁY ĐO); (c) main loop sau trần nudge VẪN ĐẾM `viLateCount` (persist) + ghi evidence cho trọng tài | 2 test nền (ratio Anh/Việt trên thought thật) |
| F7 | 001+023 | tool-calls.ts | Repair **R7** `{</name> "tool", "arguments":` → native body chuẩn; repair **R8** `functions.X…<parameter name="parameters">{json}` → pattern-1; detector sign pseudo-XML (dạng cụt → MALFORMED kèm skeleton, không im lặng) | 5 test (evt3 thật parse được, whitelist chặn, dạng sạch/cụt/hồi quy prose) |
| F8 | 013 | agent-goal-loop.ts | Nhãn **"TRẢ VỀ ĐẦY ĐỦ (trọng tài CHƯA ĐẠT)"** tách bạch delivery vs verdict | 3 test |
| F9 | 006/019 | agent-goal-loop.ts | Detector **degenerate fragment** (<8 ký tự, không tool call — "x echoed pieces"/"<") — ≥3/run → evidence cho trọng tài | (đếm thuần — nằm trong goal loop, phủ bằng quan sát mission kế) |

**Các BUG ghi nhận CHƯA fix trong phiên này** (có đề xuất hướng trong từng mục, chờ phiên sau / cân bằng thiết kế): 007 (gate receipt UX), 008 (guard UI — cần thiết kế không chặn user), 009 (tmp hygiene), 010/014 (cờ readOnly tầng tool cho delegation), 012 (phân ngân sách theo phần việc), 022 (phanh đọc-lại ngưỡng file), 024 (retry wrap-up), 025 (bước báo uncommitted khi wrap-up — đã giải quyết một phần bằng commit operator bên dưới).

**Xử lý hậu cần (BUG-025):** 101 dòng fix thật của SENTINEL (exec-allowlist.ts +33, execute-route-security.test.ts +68 — symlink-cwd escape containment, gate 392/392 PASS tại 15:09) được operator commit kèm phiên này với provenance đầy đủ — không còn thay đổi mồ côi trong working tree.

## KẾT LUẬN PHIÊN QUAN SÁT
- Sổ bug.md ghi **25 vấn đề + 9 ghi nhận tích cực** theo đúng yêu cầu "ghi NGAY tại chỗ từng bước" — mọi mục đều có bằng chứng truy vấn được (evt jsonl / dev.log / checkpoint / repro).
- Chuỗi chết mission lặp lại миссии #18 (verdict_stagnation, 4.6M tokens/39.7 phút) — nguyên nhân gốc đã ghép xong chuỗi nhân (xem "Chuỗi nhân chết mission") và 3 mắt xích chính (017/018/016) đã được fix hardcode trong chính phiên.
- Lần chạy mission kế tiếp qua hệ thống mới sẽ là kiểm chứng sống cho toàn bộ 9 fix.
