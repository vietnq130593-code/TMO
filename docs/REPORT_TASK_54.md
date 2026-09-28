# BÁO CÁO CUỐI — TMO: phân tích lỗi vận hành, khắc phục, nâng cấp

Ngày cập nhật: chu kỳ 6 / Goal-Loop. Workspace: /home/z/tmo-app. Commit phụ lục lần trước: 4760526; bản sửa số liệu log và bổ sung phát hiện cache build nằm ngay sau đó.

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
| 7 | Rò /tmp | Mỗi process test tạo 1 thư mục /tmp/tmo-test-db-*; hook process.on("exit") không chạy khi bun kết thúc worker | Thấp | ĐÃ SỬA (sweepOrphanDirs: dọn theo PID chủ sở hữu + quét dir cũ mỗi lần preload — đo 11 dir → giữ 1 dir, không tăng qua 3 lần chạy) |
| 8 | DB thật | 4 bản ghi Workspace "Test Workspace" trỏ /tmp (isActive=0) còn sót từ các lần chạy trước khi có lớp cô lập | Thấp | CHƯA XÓA — nằm trong dữ liệu được bảo vệ, cần phê duyệt |
| 9 | Log | Opus auto-review SKIP lặp 336 dòng trong log hệ thống | Thấp | CHƯA SỬA |
| 10 | Memory | LearningLog, AgentInsight, AgentCorrection, JobQueue đều 0 bản ghi dù code đã wire | Trung bình | CHƯA SỬA (chưa chẩn đoán) |
| 11 | Utility LLM | callUtilityLLM gọi model trả 403 FreeTier vĩnh viễn 15/15 lần, nhánh failover kế thừa reasoning effort max nuốt hết maxTokens 700 → content rỗng, finish_reason length, HTTP vẫn 200 — đường fail âm thầm không ghi log | Cao | ĐÃ SỬA (thêm reasoningEffort override + đổi mặc định utility path sang space-bunny-free effort low + log EMPTY RESPONSE; maxTokens 700→2000) |
| 12 | DB | DATABASE_URL bị env leak từ project khác, cộng đường dẫn file: tương đối resolve lệch (Prisma CLI theo schema, client runtime theo cwd) → watch-agents.ts lỗi CANTOPEN | Cao | ĐÃ SỬA (guard env leak trong db.ts + chuẩn hóa đường dẫn tuyệt đối theo schema; watch-agents.ts nhân bản logic) |
| 13 | Dung lượng | Thư mục .next của clone chiếm 1,1 GB, riêng cache turbopack là 13 file .sst tổng 599,9 MB; ổ đĩa / còn trống 5,0 GB | Thấp | CHƯA XỬA (đề xuất ưu tiên 7) |

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

4.1 Rò /tmp — ĐÃ XỬ LÝ trong preload bằng sweepOrphanDirs: mỗi lần nạp, quét /tmp/tmo-test-db-*, giữ lại dir của tiến trình đang sống (đọc owner PID trong tên dir và kiểm tra /proc), xoá dir của tiến trình đã chết và dir quá cũ. Đo trước/sau trong chu kỳ này: 11 dir rò → 1 dir, dung lượng nhóm 148M → 12M; chạy suite liên tiếp 3 lần số dir không tăng. Còn 1 dir là của tiến trình test đang chạy, đúng thiết kế. Hệ quả còn lại: test song song 2 tiến trình sẽ dùng 2 dir — chấp nhận được vì mỗi dir là bản DB riêng.

4.2 DB thật còn 4 bản ghi Workspace trỏ /tmp (đều isActive=0, nên vô hại với hành vi hiện tại — workspace active là TMO-clone /home/z/tmo-app). Dọn cần ghi vào dữ liệu được bảo vệ nên chưa tự thực hiện.

4.3 Log spam Opus auto-review SKIP (336 dòng) — vô hại về hành vi nhưng che tín hiệu thật.

4.4 Memory pipeline rỗng — LearningLog, AgentInsight, AgentCorrection, JobQueue đều 0 bản ghi. Mã đã wire vào nhiều nơi, nên dấu hiệu là pipeline ghi dữ liệu không chạy, chưa xác định chính xác điểm đứt.

Xác nhận độc lập bằng kênh audit HTTP của app (ALISTA gọi trực tiếp các route, không đọc .env, không dùng bun eval): /api/openclaw/learning/stats trả totalInsights 0, totalCorrections 0, totalPreferences 0; /api/auto-learn trả totalRecords 0. Ba bảng learning rỗng KHÔNG phải hệ quả của việc bun test ghi nhầm DB (điều đó đã được vá ở hạng mục 6) — đây là trạng thái rỗng có thật của app đang chạy.

4.5 AgentRunRecord còn 1 bản ghi status=running (agentName Omega, startedAt 1790621755492) — đây chính là run đang thực hiện, không phải mồ côi.

4.6 Log pm2 của tiến trình theopusflashlite không nằm ở ~/.pm2/logs/ như tên tiến trình gợi ý → chưa quét được log lỗi runtime của app từ đường này (đã thử 2 đường). Tiến trình: qdrant online 4h (↺0); theopusflashlite online 48m (↺7).

---

## 5. ĐỀ XUẤT NÂNG CẤP (thứ tự ưu tiên)

Ưu tiên 1 — Dọn 4 bản ghi Workspace test trong DB thật. Cần phê duyệt vì chạm dữ liệu được bảo vệ. Nghiệm thu: truy vấn Workspace không còn rootPath bắt đầu bằng /tmp, active vẫn là /home/z/tmo-app.

Ưu tiên 2 — (ĐÃ XONG trong chu kỳ này) rò /tmp đã bị vá bằng sweepOrphanDirs. Nghiệm thu: chạy suite 3 lần liên tiếp, số dir /tmp/tmo-test-db-* không tăng — ĐẠT (1 dir, 12M, ổn định qua nhiều lần chạy). Phần còn lại: thêm test hồi quy cho chính sweepOrphanDirs để bảo vệ hành vi này khỏi hồi quy.

Ưu tiên 3 — Chẩn đoán memory pipeline rỗng: thêm log chẩn đoán tại điểm ghi LearningLog và AgentInsight để xác định nhánh nào không chạy. Nghiệm thu: sau một phiên agent hoàn tất, LearningLog có ít nhất 1 bản ghi.

Ưu tiên 4 — Dồn log Opus SKIP: chống lặp theo cửa sổ thời gian hoặc hạ xuống mức debug. Nghiệm thu: 10 phút vận hành bình thường không sinh quá 5 dòng SKIP. Kèm log rotation: log đang chạy thật hiện là ~/.pm2/logs/qdrant-out.log 1,7 MB (qdrant-error.log 0 byte) và .next/dev/logs/next-development.log 593.003 byte trong clone, cả hai đều chưa có cơ chế cắt — nên gộp thêm bước rotation theo kích thước. Lưu ý đính chính: dev.log 3,6 MB nằm ở /home/z/my-project/dev.log, tức dự án khác, không phải log của hệ thống TMO nên không được tính vào số liệu nâng cấp. Nghiệm thu phần rotation: file log không vượt 10 MB sau một ngày vận hành liên tục.

Ưu tiên 5 — Bổ sung kiểm thử hồi quy cho ensureBridgeRunning: test trạng thái đang spawn (dedup) và test khi spawn thất bại. Nghiệm thu: thêm 2 test, suite vẫn 0 fail.

Ưu tiên 6 — Định tuyến log pm2 đúng chỗ để rà lỗi runtime của app không cần đoán đường dẫn.

Ưu tiên 7 — Dọn cache build: thư mục .next trong clone chiếm 1,1 GB, riêng 13 file .sst của turbopack đã 599,9 MB, trong khi ổ đĩa chỉ còn trống 5,0 GB. Cache này sinh lại mỗi lần chạy dev và không thuộc mã nguồn. Nghiệm thu: sau khi dọn .next/dev/cache, dung lượng .next giảm từ 1,1 GB xuống dưới 600 MB và app vẫn build lại được bình thường. Phạm vi xóa chỉ nằm trong thư mục build sinh tự động, không đụng dữ liệu hay mã nguồn.

---

## 6. BẰNG CHỨNG KIỂM ĐỊNH

- run_tests (bun test v1.3.14): 191 pass, 0 fail, 405 expect() calls, 12 file, ~2.0s.
- type_check: errorCount 0.
- lint (tests/db-isolation-preload.ts): 0 error, 0 warning.
- shell đếm trước/sau 1 lần chạy suite: Todo test-* 35, StructuredHypothesis 10, RunContext 5 — TRƯỚC và SAU giống hệt nhau → lớp cô lập thực sự chặn ghi vào DB app.
- shell đếm dir /tmp/tmo-test-db-* (sau khi vá sweepOrphanDirs): 11 dir rò trước → 1 dir sau; dung lượng nhóm 148M → 12M; chạy suite thêm 1 lần vẫn giữ nguyên 1 dir (không rò thêm).
- shell đọc bảng Workspace trong DB thật: 5 bản ghi, isActive=1 là TMO-clone /home/z/tmo-app; 4 bản ghi Test Workspace trỏ /tmp đều isActive=0.
- git diff: workspace-manager.ts +29/-2 (thêm _invalidateCache sau createWorkspace); workspace-manager.test.ts +cleanup afterAll.
- git status (chốt chu kỳ 4): đã commit 178ae53 gồm 9 path (2 file src, 4 file tests, bunfig.toml, tests/db-isolation-preload.ts, docs/REPORT_TASK_54.md), working tree sạch.
- shell đếm bảng vận hành (chu kỳ 5, chỉ đọc): AgentRunRecord 6 (completed 4, failed 1, running 1 = run Omega hiện tại); LearningLog 0; AgentInsight 0; AgentCorrection 0; JobQueue 0; TaskExecution 1; Workspace 5 (TMO-clone isActive=true, 4 Test Workspace trỏ /tmp đều isActive=false).
- gateway_tool session_status sau khi bridge DOWN: thành công, "Uptime: gateway 11s" → lazy-spawn tự chữa.
- shell đếm bảng vận hành: AgentRunRecord completed 4 / failed 1 / running 1; AgentCorrection 0; JobQueue 0; TaskExecution completed 1.
- Chu kỳ 5 — đối chiếu độc lập bằng kênh audit HTTP của app đang chạy (không đọc .env, không dùng bun eval): /api/health-check trả ok version 2.0.0; /api/openclaw/learning/stats trả totalInsights 0, totalCorrections 0, totalPreferences 0; /api/auto-learn trả totalRecords 0. Ba bảng learning rỗng xác nhận là trạng thái thật của app, không phải hệ quả test ghi nhầm DB.
- Chu kỳ 5 — đo quy mô log bằng du -h: dev.log 3,6 MB (3.720.330 byte), .next/dev/logs/next-development.log 564K. Cơ sở định lượng cho đề xuất log rotation ở mục 5.
- Chu kỳ 6 — đính chính số liệu log trên: quét lại toàn hệ thống cho thấy dev.log 3,6 MB nằm ở /home/z/my-project/dev.log, tức dự án khác, không phải log TMO; trong clone không có file .log nào ở gốc. Log thật của hệ thống đang chạy là ~/.pm2/logs với qdrant-out.log 1.671.035 byte và qdrant-error.log 0 byte, cộng next-development.log 593.829 byte trong .next/dev/logs. Mục 5 và dòng 9 của bảng mục 2 đã sửa theo số liệu này.
- Chu kỳ 6 — đo dung lượng bằng lệnh máy: du -h /home/z/tmo-app cho 3,0 G tổng; .next 1,1 G, .next/dev 1,1 G, .next/dev/cache 609 M; đếm file .sst trên 5 MB cho 13 file tổng 599,9 MB; df -h cho ổ / 9,9 G dung lượng, đã dùng 4,4 G, còn trống 5,0 G. Nguồn số liệu cho dòng 13 và ưu tiên 7.
- Chu kỳ 6 — health-check app đang chạy bằng HTTP chỉ đọc: /api/health-check trả http 200 với ok=true, version 2.0.0; bridge 18791 trả http 000 tại thời điểm đo, đúng trạng thái on-demand nằm ngoài tiến trình chính.

---

## 7. PHỤ LỤC — 2 LỖI ĐÃ KHẮC PHỤC Ở COMMIT 8c6b793 (TASK 55)

Hai lỗi dưới đây đã được sửa và commit trước khi báo cáo này chốt, nhưng mục 2 (lỗi đã phát hiện) chưa ghi nhận nên bổ sung ở đây để báo cáo đầy đủ. Số liệu lấy nguyên văn từ git show 8c6b793.

7.1 Utility LLM fail-open âm thầm 100% — Mức CAO, ĐÃ SỬA. callUtilityLLM mặc định gọi nemotron-3.5-lightning-free, model này trả 403 FreeTierError vĩnh viễn nên 15/15 lần gọi đều rơi xuống nhánh failover. Tệ hơn, nhánh failover kế thừa reasoning effort mặc định là max trong khi maxTokens của caller chỉ 700, nên reasoning nuốt hết budget, content trả về rỗng, finish_reason là length, HTTP vẫn 200 — đây là đường fail âm thầm duy nhất không ghi log. Kiểm chứng thực nghiệm trong commit: prompt 120 nghìn ký tự với effort max và maxTokens 700 cho reasoning_tokens bằng đúng 700 và content bằng 0; đổi sang effort low thì reasoning còn 88 và digest sinh ra bình thường.

Cách khắc phục: thêm trường reasoningEffort vào LLMCallOptions và cho callZenProvider tôn trọng giá trị override; hai call site của utility path chuyển mặc định sang space-bunny-free với effort low vì đây là tác vụ cơ khí; thêm log EMPTY RESPONSE in đủ finish_reason, max_tokens, reasoning_effort và usage để không còn đường fail không dấu vết; context-compression.ts tăng maxTokens từ 700 lên 2000 vì 700 vẫn bị cắt giữa chừng. Kiểm định end-to-end sau sửa: callUtilityLLM với prompt 35 nghìn ký tự trả về space-bunny dùng 14782 token trong 15,8 giây; compressConversation trên 115 tin nhắn cho method là llm, digest dài 914 ký tự, tiết kiệm 138 nghìn ký tự (trước đó rơi về heuristic).

7.2 DATABASE_URL sai lớp làm watch-agents lỗi CANTOPEN — Mức CAO, ĐÃ SỬA. Có hai nguyên nhân chồng lên nhau. Một là shell sandbox xuất DATABASE_URL của một project khác (my-project, file không tồn tại) và bun không override biến môi trường đã được set trong .env, nên script mở nhầm một DB chết. Hai là Prisma CLI resolve đường dẫn file theo schema.prisma còn client runtime resolve theo thư mục làm việc hiện tại, nên giá trị file:../db/custom.db trỏ tới /home/z/db/... và sinh lỗi CANTOPEN.

Cách khắc phục: db.ts thêm guard chống env leak (nếu biến môi trường kế thừa trỏ tới file không tồn tại thì ưu tiên giá trị trong .env của project, còn env override có chủ đích trỏ DB thật vẫn được giữ nguyên nên /tmp test DB của preload vẫn an toàn) và chuẩn hóa đường dẫn tương đối thành tuyệt đối theo schema; watch-agents.ts nhân bản cùng logic để chạy lại được không cần export biến môi trường thủ công. Kết quả kiểm định trong commit: typecheck 0 lỗi, lint 0 lỗi và 0 warning, bun test 191 pass 0 fail.

Hai lỗi này có điểm chung đáng lưu ý cho nâng cấp: cả hai đều lỗi KHÔNG raise exception, chỉ biểu hiện bằng kết quả rỗng hoặc dữ liệu sai. Loại lỗi này nguy hiểm hơn lỗi throw vì hệ thống vẫn chạy và báo cáo thành công. Đề xuất thêm một nguyên tắc kiểm định bắt buộc: mọi đường ghi dữ liệu và mọi lời gọi LLM phải có phát hiện kết quả rỗng bất thường để log cảnh báo, không coi HTTP 200 là bằng chứng thành công.

---

## 8. GIỚI HẠN KIỂM ĐỊNH

- Chưa xác minh được nguyên nhân chính xác khiến các bảng memory rỗng (chưa chẩn đoán tới điểm ghi).
- Chưa đọc được log runtime của tiến trình theopusflashlite (sai đường dẫn ~/.pm2/logs).
- Chưa chạy kiểm thử hồi quy cho ensureBridgeRunning; xác nhận hiện tại dựa trên kiểm định end-to-end một lần với bridge DOWN.
- Chưa xoá 4 bản ghi Workspace test trong DB thật (dữ liệu được bảo vệ).
