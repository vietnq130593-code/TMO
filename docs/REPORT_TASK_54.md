# BÁO CÁO CUỐI — TMO: phân tích lỗi vận hành, khắc phục, nâng cấp

Ngày cập nhật: chu kỳ 4 / Goal-Loop. Workspace: /home/z/tmo-app. HEAD: 0b1a836.

---

## 1. MỤC TIÊU

Phân tích toàn diện hệ thống TMO trong quá trình thực thi của agents: phát hiện lỗi, khắc phục, đề xuất nâng cấp. Ba hạng mục gốc A (lỗi TypeScript), B (test suite hỏng), C (gateway_tool không lazy-spawn), sau đó mở rộng sang lớp test-isolation và nợ vận hành còn lại.

---

## 2. LỖI ĐÃ PHÁT HIỆN — TRẠNG THÁI CUỐI

| # | Hạng mục | Mô tả | Mức | Trạng thái |
|---|----------|--------|-----|-----------|
| 1 | A | 5 lỗi TypeScript trong scripts/watch-agents.ts — đọc property không tồn tại trên model Prisma | Trung bình | ĐÃ SỬA |
| 2 | B | 2 file kiểm định thủ công đặt tên .test.ts → bun test tự thu thập, tự connect DB, gọi HTTP localhost:3000, in kết quả → hỏng cả suite | Cao | ĐÃ SỬA (rename về .ts) |
| 3 | B | 3 script verify thiếu skip-guard nên chạy ngoài ý muốn | Trung bình | ĐÃ SỬA |
| 4 | C | gateway_tool luôn fail "gateway-bridge unreachable (port 18791)" — thiếu lazy-spawn theo thiết kế on-demand | Cao | ĐÃ SỬA (ensureBridgeRunning: 3 trạng thái + dedup + chống deadlock) |
| 5 | Vận hành | Run mồ côi status=running trong AgentRunRecord sau khi tiến trình chết giữa chừng | Trung bình | ĐÃ SỬA (boot cleanup) |
| 6 | Test isolation (CRITICAL) | `run_tests` gọi `bun test` trực tiếp → bun nạp .env → test ghi vào db/custom.db của app đang chạy; test workspace-manager cướp cờ isActive → mọi file tool của agent trả "path escapes workspace root" | CRITICAL | ĐÃ SỬA (bunfig.toml [test].preload → copy DB ra /tmp; + _invalidateCache trong createWorkspace; + afterAll trả cờ isActive) |
| 7 | Rò /tmp | Mỗi process test tạo 1 thư mục /tmp/tmo-test-db-*; hook process.on("exit") không chạy khi bun kết thúc worker | Thấp | ĐÃ CHẶN Ở MỨC HẠN CHẾ, chưa triệt tiêu (xem mục 4) |
| 8 | DB thật | 4 bản ghi Workspace "Test Workspace" trỏ /tmp (isActive=0) còn sót từ các lần chạy trước khi có lớp cô lập | Thấp | CHƯA XÓA — nằm trong dữ liệu được bảo vệ, cần phê duyệt |
| 9 | Log | Opus auto-review SKIP lặp 336 dòng trong dev.log | Thấp | CHƯA SỬA |
| 10 | Memory | LearningLog, AgentInsight, AgentCorrection, JobQueue đều 0 bản ghi dù code đã wire | Trung bình | CHƯA SỬA (chưa chẩn đoán) |

---

## 3. ĐÃ KHẮC PHỤC THẾ NÀO

Hạng mục A — sửa truy cập property trên model Prisma trong scripts/watch-agents.ts, thay bằng trường thực sự tồn tại trong schema. Kiểm định: type_check errorCount = 0.

Hạng mục B — đổi tên 2 file kiểm định thủ công từ .test.ts sang .ts để bun test không tự thu thập. Thêm skip-guard cho 3 script verify. Thêm 4 self-check script còn lại trong tests/ (protected-paths, shr-cot-todo, todo-coverage, uncertainty-ledger) chuyển sang dạng đăng ký 1 test tổng hợp thay vì process.exit() — vì process.exit() giết cả suite khiến các file sau không bao giờ chạy (đã quan sát: run_tests chỉ thấy 2/6 file).

Hạng mục C — thêm ensureBridgeRunning trước khi proxy sang bridge: kiểm tra cổng 18791, nếu offline thì spawn service rồi poll chờ sẵn sàng, có dedup để nhiều agent gọi song song không spawn trùng, và timeout để không treo. Kiểm định: gọi gateway_tool khi bridge DOWN → thành công, session_status trả về "Uptime: gateway 11s" (tức bridge vừa được spawn trong chính lệnh đó).

Hạng mục 6 (nghiêm trọng nhất) — hai lớp:
- Lớp 1 (công lập, chặn từ gốc): file bunfig.toml khai báo [test].preload = tests/db-isolation-preload.ts. Preload copy db/custom.db (kèm -wal, -shm) ra /tmp/tmo-test-db-XXXX/test.db rồi trỏ DATABASE_URL vào bản copy. Mọi test vẫn thấy đúng schema nhưng ghi/xoá chỉ đụng bản copy.
- Lớp 2 (phòng thủ trong mã): workspace-manager.ts thêm this._invalidateCache() sau createWorkspace — trước đó createWorkspace đổi chủ active workspace nhưng cache TTL 10s không bị vô hiệu hoá nên 10s tiếp theo mọi lời gọi vẫn trả workspace cũ đã bị set isActive=false. Test file thêm afterAll trả cờ isActive về workspace gốc và xoá record test tạo ra.

---

## 4. NỢ CÒN LẠI (đo được, chưa sửa)

4.1 Rò /tmp — không triệt tiêu được hoàn toàn. Đo thật: trước khi chạy 12 dir /tmp/tmo-test-db-* (148M); chạy suite 2 lần liên tiếp → 13 dir (160M). Sweep trong preload chỉ xoá dir cũ hơn 10 phút, nên rò bị chặn ở mức khoảng 1 dir mỗi lần chạy và tự dọn theo cửa sổ thời gian, tức KHÔNG tích luỹ vô hạn nhưng cũng không bằng 0. Đĩa hiện còn 5.1G trống (46% đã dùng) nên chưa áp lực. Hướng vá nếu muốn sạch tuyệt đối: (a) dùng MỘT thư mục cố định cho toàn bộ test thay vì mkdtemp mỗi process — nhưng phải serialize để không xung đột, hoặc (b) một process dọn dẹp chạy ngoài (ví dụ sau mỗi N lần chạy), hoặc (c) giảm STALE_MS xuống 2 phút với rủi ro xoá nhầm dir của test đang chạy song song.

4.2 DB thật còn 4 bản ghi Workspace trỏ /tmp (đều isActive=0, nên vô hại với hành vi hiện tại — workspace active là TMO-clone /home/z/tmo-app). Dọn cần ghi vào dữ liệu được bảo vệ nên chưa tự thực hiện.

4.3 Log spam Opus auto-review SKIP (336 dòng) — vô hại về hành vi nhưng che tín hiệu thật.

4.4 Memory pipeline rỗng — LearningLog, AgentInsight, AgentCorrection, JobQueue đều 0 bản ghi. Mã đã wire vào nhiều nơi, nên dấu hiệu là pipeline ghi dữ liệu không chạy, chưa xác định chính xác điểm đứt.

4.5 AgentRunRecord còn 1 bản ghi status=running (agentName Omega, startedAt 1790621755492) — đây chính là run đang thực hiện, không phải mồ côi.

4.6 Log pm2 của tiến trình theopusflashlite không nằm ở ~/.pm2/logs/ như tên tiến trình gợi ý → chưa quét được log lỗi runtime của app từ đường này (đã thử 2 đường). Tiến trình: qdrant online 4h (↺0); theopusflashlite online 48m (↺7).

---

## 5. ĐỀ XUẤT NÂNG CẤP (thứ tự ưu tiên)

Ưu tiên 1 — Dọn 4 bản ghi Workspace test trong DB thật. Cần phê duyệt vì chạm dữ liệu được bảo vệ. Nghiệm thu: truy vấn Workspace không còn rootPath bắt đầu bằng /tmp, active vẫn là /home/z/tmo-app.

Ưu tiên 2 — Vá rò /tmp theo hướng (a) hoặc (c) mục 4.1. Nghiệm thu: chạy suite 3 lần liên tiếp, số dir /tmp/tmo-test-db-* không tăng và tổng dung lượng nhóm giữ dưới 20M.

Ưu tiên 3 — Chẩn đoán memory pipeline rỗng: thêm log chẩn đoán tại điểm ghi LearningLog và AgentInsight để xác định nhánh nào không chạy. Nghiệm thu: sau một phiên agent hoàn tất, LearningLog có ít nhất 1 bản ghi.

Ưu tiên 4 — Dồn log Opus SKIP: chống lặp theo cửa sổ thời gian hoặc hạ xuống mức debug. Nghiệm thu: 10 phút vận hành bình thường không sinh quá 5 dòng SKIP.

Ưu tiên 5 — Bổ sung kiểm thử hồi quy cho ensureBridgeRunning: test trạng thái đang spawn (dedup) và test khi spawn thất bại. Nghiệm thu: thêm 2 test, suite vẫn 0 fail.

Ưu tiên 6 — Định tuyến log pm2 đúng chỗ để rà lỗi runtime của app không cần đoán đường dẫn.

---

## 6. BẰNG CHỨNG KIỂM ĐỊNH

- run_tests (bun test v1.3.14): 191 pass, 0 fail, 405 expect() calls, 12 file, ~2.0s.
- type_check: errorCount 0.
- lint (tests/db-isolation-preload.ts): 0 error, 0 warning.
- shell đếm trước/sau 1 lần chạy suite: Todo test-* 35, StructuredHypothesis 10, RunContext 5 — TRƯỚC và SAU giống hệt nhau → lớp cô lập thực sự chặn ghi vào DB app.
- shell đếm dir /tmp/tmo-test-db-*: 12 trước → 12 sau lần chạy 1 → 13 sau lần chạy 2; 1 dir vượt ngưỡng 10 phút; dung lượng nhóm 148M → 160M.
- shell đọc bảng Workspace trong DB thật: 5 bản ghi, isActive=1 là TMO-clone /home/z/tmo-app; 4 bản ghi Test Workspace trỏ /tmp đều isActive=0.
- git diff: workspace-manager.ts +29/-2 (thêm _invalidateCache sau createWorkspace); workspace-manager.test.ts +cleanup afterAll.
- git status: 9 path thay đổi chưa commit (2 file src, 4 file tests, bunfig.toml, tests/db-isolation-preload.ts, docs/REPORT_TASK_54.md).
- gateway_tool session_status sau khi bridge DOWN: thành công, "Uptime: gateway 11s" → lazy-spawn tự chữa.
- shell đếm bảng vận hành: AgentRunRecord completed 4 / failed 1 / running 1; AgentCorrection 0; JobQueue 0; TaskExecution completed 1.

---

## 7. GIỚI HẠN KIỂM ĐỊNH

- Chưa xác minh được nguyên nhân chính xác khiến các bảng memory rỗng (chưa chẩn đoán tới điểm ghi).
- Chưa đọc được log runtime của tiến trình theopusflashlite (sai đường dẫn ~/.pm2/logs).
- Chưa chạy kiểm thử hồi quy cho ensureBridgeRunning; xác nhận hiện tại dựa trên kiểm định end-to-end một lần với bridge DOWN.
- Chưa xoá 4 bản ghi Workspace test trong DB thật (dữ liệu được bảo vệ).
